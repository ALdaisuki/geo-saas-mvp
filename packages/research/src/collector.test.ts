import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ResearchCollector } from "./index.js";
import type {
  ResearchCollectionError,
  ResearchHttpRequest,
  ResearchHttpResponse,
  ResearchPolicy,
  ResearchTransport,
} from "./index.js";

const policy: ResearchPolicy = {
  allowedHosts: ["example.com", "www.example.com"],
  userAgent: "GEOResearchBot/1.0 (+https://example.test/research-policy)",
  maxBytes: 100_000,
  robotsMaxBytes: 10_000,
  timeoutMs: 5_000,
  maxRedirects: 2,
  maxDiscoveredUrls: 20,
  respectRobots: true,
};

function response(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = { "content-type": "text/html; charset=utf-8" },
): ResearchHttpResponse {
  return {
    status,
    headers,
    body: new TextEncoder().encode(body),
  };
}

class FakeTransport implements ResearchTransport {
  readonly requests: ResearchHttpRequest[] = [];

  constructor(private readonly responses: Readonly<Record<string, ResearchHttpResponse>>) {}

  async get(request: ResearchHttpRequest): Promise<ResearchHttpResponse> {
    this.requests.push(request);
    const result = this.responses[request.url];
    if (result === undefined) throw new Error(`Unexpected request ${request.url}`);
    return result;
  }
}

const publicResolver = vi.fn(async () => ["93.184.216.34"] as const);

describe("ResearchCollector", () => {
  it("rejects unsafe URL shapes, non-allowlisted hosts, and private DNS before transport", async () => {
    const transport = new FakeTransport({});
    const privateCollector = new ResearchCollector({
      transport,
      resolveHost: async () => ["127.0.0.1"],
    });

    await expect(
      privateCollector.collectPage({ url: "https://example.com/", policy }),
    ).rejects.toMatchObject({
      code: "RESEARCH_ADDRESS_FORBIDDEN",
    });
    await expect(
      privateCollector.collectPage({ url: "http://example.com/", policy }),
    ).rejects.toMatchObject({ code: "RESEARCH_HTTPS_REQUIRED" });
    await expect(
      privateCollector.collectPage({ url: "https://user:secret@example.com/", policy }),
    ).rejects.toMatchObject({ code: "RESEARCH_URL_CREDENTIALS_FORBIDDEN" });
    await expect(
      privateCollector.collectPage({ url: "https://outside.example/", policy }),
    ).rejects.toMatchObject({ code: "RESEARCH_HOST_NOT_ALLOWED" });
    expect(transport.requests).toHaveLength(0);
  });

  it("honors robots.txt before requesting a disallowed page", async () => {
    const transport = new FakeTransport({
      "https://example.com/robots.txt": response(200, "User-agent: *\nDisallow: /private\n", {
        "content-type": "text/plain",
      }),
    });
    const collector = new ResearchCollector({ transport, resolveHost: publicResolver });

    await expect(
      collector.collectPage({ url: "https://example.com/private/report", policy }),
    ).rejects.toMatchObject({ code: "RESEARCH_ROBOTS_DISALLOWED" });
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.com/robots.txt",
    ]);
  });

  it("revalidates every redirect and rejects a redirect outside the tenant allowlist", async () => {
    const transport = new FakeTransport({
      "https://example.com/robots.txt": response(404, "", { "content-type": "text/plain" }),
      "https://example.com/start": response(302, "", { location: "https://outside.example/page" }),
    });
    const collector = new ResearchCollector({ transport, resolveHost: publicResolver });

    await expect(
      collector.collectPage({ url: "https://example.com/start", policy }),
    ).rejects.toMatchObject({ code: "RESEARCH_HOST_NOT_ALLOWED" });
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/start",
    ]);
  });

  it("captures inspectable page evidence without turning collection into a GEO score", async () => {
    const html = `<!doctype html>
      <html lang="zh-CN"><head>
        <title>Verified travel guidance</title>
        <meta name="robots" content="index,follow">
        <link rel="canonical" href="https://www.example.com/guide">
        <script type="application/ld+json">{"@type":"Article","headline":"Verified travel guidance"}</script>
      </head><body>
        <main><h1>Verified travel guidance</h1><p>Call only the verified hotline.</p>
        <a href="/next">Next guide</a><a href="https://outside.example/skip">Skip</a></main>
        <script>window.secret = "not visible";</script>
      </body></html>`;
    const transport = new FakeTransport({
      "https://example.com/robots.txt": response(
        200,
        "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n",
        { "content-type": "text/plain" },
      ),
      "https://example.com/guide": response(200, html),
    });
    const collector = new ResearchCollector({
      transport,
      resolveHost: publicResolver,
      now: () => new Date("2026-07-15T08:00:00.000Z"),
    });

    const snapshot = await collector.collectPage({
      url: "https://example.com/guide#section",
      policy,
    });

    expect(snapshot).toMatchObject({
      requestedUrl: "https://example.com/guide",
      finalUrl: "https://example.com/guide",
      status: 200,
      fetchedAt: "2026-07-15T08:00:00.000Z",
      title: "Verified travel guidance",
      language: "zh-CN",
      canonicalUrl: "https://www.example.com/guide",
      metaRobots: ["index", "follow"],
      indexability: { robotsAllowed: true, noindex: false, nofollow: false },
      discoveredUrls: ["https://example.com/next"],
      robots: {
        url: "https://example.com/robots.txt",
        status: 200,
        rawText: expect.stringContaining("Sitemap:"),
        allowed: true,
        sitemapUrls: ["https://example.com/sitemap.xml"],
      },
    });
    expect(snapshot.visibleText).toContain("Call only the verified hotline.");
    expect(snapshot.rawHtml).toBe(html);
    expect(snapshot.visibleText).not.toContain("window.secret");
    expect(snapshot.structuredData).toEqual([
      { "@type": "Article", headline: "Verified travel guidance" },
    ]);
    expect(snapshot.contentHash).toBe(createHash("sha256").update(html).digest("hex"));
    expect(snapshot).not.toHaveProperty("score");
  });

  it("discovers only validated allowlisted sitemap URLs and respects the page limit", async () => {
    const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://outside.example/b</loc></url>
      <url><loc>http://example.com/insecure</loc></url>
      <url><loc>https://example.com/c#fragment</loc></url>
    </urlset>`;
    const transport = new FakeTransport({
      "https://example.com/robots.txt": response(
        200,
        "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n",
        { "content-type": "text/plain" },
      ),
      "https://example.com/sitemap.xml": response(200, sitemap, {
        "content-type": "application/xml",
      }),
    });
    const collector = new ResearchCollector({ transport, resolveHost: publicResolver });

    await expect(
      collector.discoverSitemapUrls({
        originUrl: "https://example.com/",
        policy: { ...policy, maxDiscoveredUrls: 1 },
      }),
    ).resolves.toEqual(["https://example.com/a"]);
  });

  it("fails closed on oversized or non-HTML page responses", async () => {
    const transport = new FakeTransport({
      "https://example.com/robots.txt": response(404, "", { "content-type": "text/plain" }),
      "https://example.com/file": response(200, "too large", {
        "content-type": "application/octet-stream",
      }),
      "https://example.com/large": response(200, `<html>${"x".repeat(1_100)}</html>`),
    });
    const collector = new ResearchCollector({ transport, resolveHost: publicResolver });

    await expect(
      collector.collectPage({ url: "https://example.com/file", policy }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchCollectionError>>({
        code: "RESEARCH_CONTENT_TYPE_UNSUPPORTED",
      }),
    );
    await expect(
      collector.collectPage({
        url: "https://example.com/large",
        policy: { ...policy, maxBytes: 1_024 },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchCollectionError>>({
        code: "RESEARCH_RESPONSE_TOO_LARGE",
      }),
    );
  });
});
