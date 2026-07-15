import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";

import { XMLParser } from "fast-xml-parser";

import { parseResearchHtml } from "./html.js";
import { NodeHttpsResearchTransport } from "./node-transport.js";
import {
  ResearchCollectionError,
  type ResearchHttpResponse,
  type ResearchPageSnapshot,
  type ResearchPolicy,
  type ResearchRobotsEvidence,
  type ResearchTransport,
} from "./types.js";
import { assertPublicAddresses, normalizeResearchUrl } from "./url-policy.js";

interface RobotsPolicy {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
}

const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  content: string,
) => RobotsPolicy;

interface ResearchCollectorOptions {
  readonly transport?: ResearchTransport;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

interface RequestedResponse {
  readonly response: ResearchHttpResponse;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
}

interface LoadedRobots {
  readonly evidence: ResearchRobotsEvidence;
  readonly content: string;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decode(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(value);
}

function contentType(headers: Readonly<Record<string, string>>): string {
  return (headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function entries(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function xmlLocations(value: unknown, parent: "urlset" | "sitemapindex"): readonly string[] {
  const root = record(value);
  const section = record(root?.[parent]);
  const items = entries(section?.[parent === "urlset" ? "url" : "sitemap"]);
  return items.flatMap((item) => {
    const location = record(item)?.loc;
    return typeof location === "string" ? [location] : [];
  });
}

export class ResearchCollector {
  readonly #transport: ResearchTransport;
  readonly #resolveHost: (hostname: string) => Promise<readonly string[]>;
  readonly #now: () => Date;

  constructor(options: ResearchCollectorOptions = {}) {
    this.#transport = options.transport ?? new NodeHttpsResearchTransport();
    this.#resolveHost =
      options.resolveHost ??
      (async (hostname) => {
        const results = await lookup(hostname, { all: true, verbatim: true });
        return results.map((result) => result.address);
      });
    this.#now = options.now ?? (() => new Date());
  }

  async #request(
    initialUrl: URL,
    policy: ResearchPolicy,
    maxBytes: number,
  ): Promise<RequestedResponse> {
    let current = initialUrl;
    const redirectChain: string[] = [];
    for (let redirectCount = 0; ; redirectCount += 1) {
      let addresses: readonly string[];
      try {
        addresses = await this.#resolveHost(current.hostname);
      } catch {
        throw new ResearchCollectionError("RESEARCH_DNS_FAILED", "Research DNS lookup failed");
      }
      assertPublicAddresses(addresses);
      let response: ResearchHttpResponse;
      try {
        response = await this.#transport.get({
          url: current.toString(),
          userAgent: policy.userAgent,
          timeoutMs: policy.timeoutMs,
          maxBytes,
          resolvedAddresses: addresses,
        });
      } catch (error) {
        if (error instanceof ResearchCollectionError) throw error;
        throw new ResearchCollectionError("RESEARCH_TRANSPORT_FAILED", "Research transport failed");
      }
      if (response.body.byteLength > maxBytes) {
        throw new ResearchCollectionError(
          "RESEARCH_RESPONSE_TOO_LARGE",
          "Research response exceeds the configured limit",
        );
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, finalUrl: current.toString(), redirectChain };
      }
      if (redirectCount >= policy.maxRedirects) {
        throw new ResearchCollectionError(
          "RESEARCH_REDIRECT_LIMIT",
          "Research redirect limit was exceeded",
        );
      }
      const location = response.headers.location;
      if (location === undefined || location.trim().length === 0) {
        throw new ResearchCollectionError(
          "RESEARCH_REDIRECT_INVALID",
          "Research redirect has no location",
        );
      }
      current = normalizeResearchUrl(new URL(location, current).toString(), policy);
      redirectChain.push(current.toString());
    }
  }

  async #loadRobots(pageUrl: URL, policy: ResearchPolicy): Promise<LoadedRobots> {
    const robotsUrl = normalizeResearchUrl(
      new URL("/robots.txt", pageUrl.origin).toString(),
      policy,
    );
    const result = await this.#request(robotsUrl, policy, policy.robotsMaxBytes);
    if (![200, 404].includes(result.response.status)) {
      throw new ResearchCollectionError(
        "RESEARCH_ROBOTS_FETCH_FAILED",
        "Research robots policy could not be verified",
      );
    }
    const content = result.response.status === 200 ? decode(result.response.body) : "";
    const parser = robotsParser(result.finalUrl, content);
    const allowed =
      !policy.respectRobots || parser.isAllowed(pageUrl.toString(), policy.userAgent) !== false;
    const sitemapUrls = parser.getSitemaps().flatMap((value) => {
      try {
        return [normalizeResearchUrl(value, policy).toString()];
      } catch {
        return [];
      }
    });
    return {
      content,
      evidence: {
        url: result.finalUrl,
        status: result.response.status,
        contentHash: sha256(result.response.body),
        rawText: content,
        allowed,
        sitemapUrls: [...new Set(sitemapUrls)],
      },
    };
  }

  async collectPage(input: {
    readonly url: string;
    readonly policy: ResearchPolicy;
  }): Promise<ResearchPageSnapshot> {
    const requested = normalizeResearchUrl(input.url, input.policy);
    const robots = await this.#loadRobots(requested, input.policy);
    if (!robots.evidence.allowed) {
      throw new ResearchCollectionError(
        "RESEARCH_ROBOTS_DISALLOWED",
        "Research URL is disallowed by robots.txt",
      );
    }
    const result = await this.#request(requested, input.policy, input.policy.maxBytes);
    if (result.response.status !== 200) {
      throw new ResearchCollectionError(
        "RESEARCH_HTTP_STATUS_INVALID",
        "Research page did not return HTTP 200",
      );
    }
    const mediaType = contentType(result.response.headers);
    if (!["text/html", "application/xhtml+xml"].includes(mediaType)) {
      throw new ResearchCollectionError(
        "RESEARCH_CONTENT_TYPE_UNSUPPORTED",
        "Research page is not HTML",
      );
    }
    const rawHtml = decode(result.response.body);
    const parsed = parseResearchHtml(rawHtml, result.finalUrl, input.policy);
    const metadata = Object.fromEntries(
      Object.entries(result.response.headers).filter(([name]) =>
        ["cache-control", "content-type", "etag", "last-modified"].includes(name),
      ),
    );
    return {
      requestedUrl: requested.toString(),
      finalUrl: result.finalUrl,
      redirectChain: result.redirectChain,
      status: result.response.status,
      fetchedAt: this.#now().toISOString(),
      contentType: mediaType,
      contentHash: sha256(result.response.body),
      title: parsed.title,
      language: parsed.language,
      canonicalUrl: parsed.canonicalUrl,
      metaRobots: parsed.metaRobots,
      indexability: {
        robotsAllowed: true,
        noindex: parsed.metaRobots.includes("noindex") || parsed.metaRobots.includes("none"),
        nofollow: parsed.metaRobots.includes("nofollow") || parsed.metaRobots.includes("none"),
      },
      rawHtml,
      visibleText: parsed.visibleText,
      structuredData: parsed.structuredData,
      discoveredUrls: parsed.discoveredUrls,
      responseMetadata: metadata,
      robots: robots.evidence,
    };
  }

  async discoverSitemapUrls(input: {
    readonly originUrl: string;
    readonly policy: ResearchPolicy;
  }): Promise<readonly string[]> {
    const origin = normalizeResearchUrl(input.originUrl, input.policy);
    const robots = await this.#loadRobots(origin, input.policy);
    const pending = [
      ...(robots.evidence.sitemapUrls.length > 0
        ? robots.evidence.sitemapUrls
        : [
            normalizeResearchUrl(
              new URL("/sitemap.xml", origin.origin).toString(),
              input.policy,
            ).toString(),
          ]),
    ];
    const visitedSitemaps = new Set<string>();
    const discovered = new Set<string>();
    while (
      pending.length > 0 &&
      visitedSitemaps.size < 5 &&
      discovered.size < input.policy.maxDiscoveredUrls
    ) {
      const candidate = pending.shift();
      if (candidate === undefined || visitedSitemaps.has(candidate)) continue;
      visitedSitemaps.add(candidate);
      const sitemapUrl = normalizeResearchUrl(candidate, input.policy);
      const result = await this.#request(sitemapUrl, input.policy, input.policy.maxBytes);
      if (result.response.status !== 200) {
        throw new ResearchCollectionError(
          "RESEARCH_SITEMAP_INVALID",
          "Research sitemap did not return HTTP 200",
        );
      }
      let parsed: unknown;
      try {
        parsed = new XMLParser({ processEntities: false }).parse(
          decode(result.response.body),
        ) as unknown;
      } catch {
        throw new ResearchCollectionError(
          "RESEARCH_SITEMAP_INVALID",
          "Research sitemap XML is invalid",
        );
      }
      for (const nested of xmlLocations(parsed, "sitemapindex")) {
        try {
          pending.push(normalizeResearchUrl(nested, input.policy).toString());
        } catch {
          // An invalid or cross-host sitemap entry is ignored, never fetched.
        }
      }
      for (const page of xmlLocations(parsed, "urlset")) {
        try {
          discovered.add(normalizeResearchUrl(page, input.policy).toString());
        } catch {
          // An invalid or cross-host page entry is ignored, never fetched.
        }
        if (discovered.size >= input.policy.maxDiscoveredUrls) break;
      }
    }
    return [...discovered];
  }
}
