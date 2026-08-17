import { createHash, randomUUID } from "node:crypto";

import { requireCapability } from "@geo/authz";
import type { ActorContext } from "@geo/contracts";
import {
  normalizeResearchUrl,
  ResearchCollectionError,
  ResearchCollector,
  validateResearchPolicy,
  type ResearchPageSnapshot,
  type ResearchPolicy,
} from "@geo/research";

import {
  researchPageCaptureRequestSchema,
  researchSourceCreateRequestSchema,
  researchSourceRetireRequestSchema,
  type ResearchPageCaptureRequest,
  type ResearchSourceCreateRequest,
  type ResearchSourceRetireRequest,
} from "./research-contracts.js";
import {
  ResearchRepositoryConflictError,
  ResearchRepositoryNotFoundError,
  type ResearchCaptureView,
  type ResearchRepository,
  type ResearchSourcePolicyView,
} from "./research-repository.js";

interface ResearchCollectorPort {
  collectPage(input: {
    readonly url: string;
    readonly policy: ResearchPolicy;
  }): Promise<ResearchPageSnapshot>;
  discoverSitemapUrls(input: {
    readonly originUrl: string;
    readonly policy: ResearchPolicy;
  }): Promise<readonly string[]>;
}

export interface ResearchServiceOptions {
  readonly repository: ResearchRepository;
  readonly collector?: ResearchCollectorPort;
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export interface ResearchCaptureResult {
  readonly capture: ResearchCaptureView;
  readonly succeeded: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedHosts(hosts: readonly string[]): string[] {
  return hosts.map((host) => host.trim().toLocaleLowerCase("en-US").replace(/\.$/u, ""));
}

function policyFor(source: ResearchSourcePolicyView): ResearchPolicy {
  return {
    allowedHosts: source.allowedHosts,
    userAgent: source.userAgent,
    maxBytes: source.maxBytes,
    robotsMaxBytes: source.robotsMaxBytes,
    timeoutMs: source.timeoutMs,
    maxRedirects: source.maxRedirects,
    maxDiscoveredUrls: source.maxDiscoveredUrls,
    respectRobots: source.respectRobots,
  };
}

type NormalizedSourceRequest = ResearchPolicy & {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly origin: string;
};

function normalizeSourceRequest(input: ResearchSourceCreateRequest): NormalizedSourceRequest {
  const allowedHosts = normalizedHosts(input.allowedHosts);
  const policy: ResearchPolicy = {
    allowedHosts,
    userAgent: input.userAgent,
    ...input.bounds,
    respectRobots: true,
  };
  validateResearchPolicy(policy);
  for (const host of allowedHosts) {
    normalizeResearchUrl(`https://${host}/`, policy);
  }
  const origin = normalizeResearchUrl(input.origin, policy);
  if (
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.toString() !== `${origin.origin}/`
  ) {
    throw new ResearchCollectionError(
      "RESEARCH_POLICY_INVALID",
      "Research origin must be a normalized HTTPS origin",
    );
  }
  return {
    sourceKey: input.sourceKey,
    displayName: input.displayName,
    origin: origin.toString(),
    ...policy,
  };
}

function captureUrl(source: ResearchSourcePolicyView, input: ResearchPageCaptureRequest): string {
  const parsed = researchPageCaptureRequestSchema.parse(input);
  const url = new URL(parsed.path, source.origin);
  if (url.origin !== new URL(source.origin).origin) {
    throw new ResearchCollectionError(
      "RESEARCH_HOST_NOT_ALLOWED",
      "Capture path must stay on the configured origin",
    );
  }
  return url.toString();
}

function safeCaptureError(error: unknown): string {
  if (error instanceof ResearchCollectionError) return error.code;
  if (error instanceof ResearchRepositoryConflictError) return error.code;
  return "RESEARCH_TRANSPORT_FAILED";
}

export class ResearchService {
  readonly #repository: ResearchRepository;
  readonly #collector: ResearchCollectorPort;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  constructor(options: ResearchServiceOptions) {
    this.#repository = options.repository;
    this.#collector = options.collector ?? new ResearchCollector();
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
  }

  async listSources(actor: Readonly<ActorContext>): Promise<readonly ResearchSourcePolicyView[]> {
    requireCapability(actor, "tenant:read");
    return this.#repository.listSources(actor);
  }

  async createSource(
    actor: Readonly<ActorContext>,
    request: ResearchSourceCreateRequest,
  ): Promise<ResearchSourcePolicyView> {
    requireCapability(actor, "tenant:manage");
    const parsed = researchSourceCreateRequestSchema.parse(request);
    const source = normalizeSourceRequest(parsed);
    return this.#repository.createSource(actor, {
      id: this.#uuid(),
      ...source,
      createdAt: this.#now().toISOString(),
    });
  }

  async retireSource(
    actor: Readonly<ActorContext>,
    sourcePolicyId: string,
    request: ResearchSourceRetireRequest,
  ): Promise<{ readonly source: ResearchSourcePolicyView; readonly wasChanged: boolean }> {
    requireCapability(actor, "tenant:manage");
    const parsed = researchSourceRetireRequestSchema.parse(request);
    return this.#repository.retireSource(actor, {
      sourcePolicyId,
      reason: parsed.reason,
      retiredAt: this.#now().toISOString(),
    });
  }

  async listCaptures(
    actor: Readonly<ActorContext>,
    input: { readonly sourcePolicyId?: string; readonly limit: number },
  ): Promise<readonly ResearchCaptureView[]> {
    requireCapability(actor, "content:read");
    return this.#repository.listCaptures(actor, input);
  }

  async #activeSource(
    actor: Readonly<ActorContext>,
    sourcePolicyId: string,
  ): Promise<ResearchSourcePolicyView> {
    const source = await this.#repository.getActiveSource(actor, sourcePolicyId);
    if (source === null) throw new ResearchRepositoryNotFoundError();
    return source;
  }

  async #recordFailure(
    actor: Readonly<ActorContext>,
    input: {
      readonly captureId: string;
      readonly sourcePolicyId: string;
      readonly operation: ResearchCaptureView["operation"];
      readonly requestUrlHash: string;
      readonly startedAt: string;
      readonly error: unknown;
    },
  ): Promise<ResearchCaptureResult> {
    const capture = await this.#repository.persistCaptureFailure(actor, {
      captureId: input.captureId,
      sourcePolicyId: input.sourcePolicyId,
      operation: input.operation,
      requestUrlHash: input.requestUrlHash,
      startedAt: input.startedAt,
      completedAt: this.#now().toISOString(),
      errorCode: safeCaptureError(input.error),
    });
    return { capture, succeeded: false };
  }

  async capturePage(
    actor: Readonly<ActorContext>,
    sourcePolicyId: string,
    request: ResearchPageCaptureRequest,
  ): Promise<ResearchCaptureResult> {
    requireCapability(actor, "content:write");
    const source = await this.#activeSource(actor, sourcePolicyId);
    const url = captureUrl(source, request);
    const captureId = this.#uuid();
    const startedAt = this.#now().toISOString();
    try {
      const snapshot = await this.#collector.collectPage({ url, policy: policyFor(source) });
      const capture = await this.#repository.persistPageCapture(actor, {
        captureId,
        sourcePolicyId,
        evidenceSourceId: this.#uuid(),
        requestUrlHash: sha256(url),
        snapshot,
        startedAt,
        completedAt: this.#now().toISOString(),
      });
      return { capture, succeeded: true };
    } catch (error) {
      return this.#recordFailure(actor, {
        captureId,
        sourcePolicyId,
        operation: "page_capture",
        requestUrlHash: sha256(url),
        startedAt,
        error,
      });
    }
  }

  async discoverSitemap(
    actor: Readonly<ActorContext>,
    sourcePolicyId: string,
  ): Promise<ResearchCaptureResult> {
    requireCapability(actor, "content:write");
    const source = await this.#activeSource(actor, sourcePolicyId);
    const captureId = this.#uuid();
    const startedAt = this.#now().toISOString();
    try {
      const discoveredUrls = await this.#collector.discoverSitemapUrls({
        originUrl: source.origin,
        policy: policyFor(source),
      });
      const capture = await this.#repository.persistSitemapDiscovery(actor, {
        captureId,
        sourcePolicyId,
        requestUrlHash: sha256(source.origin),
        discoveredUrls,
        startedAt,
        completedAt: this.#now().toISOString(),
      });
      return { capture, succeeded: true };
    } catch (error) {
      return this.#recordFailure(actor, {
        captureId,
        sourcePolicyId,
        operation: "sitemap_discovery",
        requestUrlHash: sha256(source.origin),
        startedAt,
        error,
      });
    }
  }
}
