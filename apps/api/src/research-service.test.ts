import type { ActorContext } from "@geo/contracts";
import {
  ResearchCollectionError,
  type ResearchPageSnapshot,
  type ResearchPolicy,
} from "@geo/research";
import { describe, expect, it, vi } from "vitest";

import type {
  CreateResearchSourcePolicyInput,
  PersistPageCaptureInput,
  PersistResearchCaptureFailureInput,
  PersistSitemapDiscoveryInput,
  ResearchCaptureView,
  ResearchRepository,
  ResearchSourcePolicyView,
  RetireResearchSourcePolicyInput,
} from "./research-repository.js";
import { ResearchService } from "./research-service.js";

const actor: ActorContext = {
  actorId: "10000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000002",
  role: "admin",
  capabilities: ["tenant:read", "tenant:manage", "content:read", "content:write"],
  requestId: "research-service-test",
};

const policy: ResearchSourcePolicyView = {
  id: "20000000-0000-4000-8000-000000000001",
  sourceKey: "official-site",
  version: 1,
  displayName: "Official site",
  origin: "https://travel.example/",
  allowedHosts: ["travel.example"],
  userAgent: "GeoResearchBot/0.1",
  maxBytes: 100_000,
  robotsMaxBytes: 10_000,
  timeoutMs: 2_000,
  maxRedirects: 2,
  maxDiscoveredUrls: 100,
  respectRobots: true,
  status: "active",
  createdByActorId: actor.actorId,
  retiredByActorId: null,
  retirementReason: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  retiredAt: null,
};

const snapshot: ResearchPageSnapshot = {
  requestedUrl: "https://travel.example/destinations/shanghai?month=7",
  finalUrl: "https://travel.example/destinations/shanghai?month=7",
  redirectChain: [],
  status: 200,
  fetchedAt: "2026-07-15T00:00:01.000Z",
  contentType: "text/html",
  contentHash: "a".repeat(64),
  title: "Shanghai guide",
  language: "zh-CN",
  canonicalUrl: "https://travel.example/destinations/shanghai",
  metaRobots: ["index", "follow"],
  indexability: { robotsAllowed: true, noindex: false, nofollow: false },
  rawHtml: "<html><body>Shanghai guide</body></html>",
  visibleText: "Shanghai guide",
  structuredData: [],
  discoveredUrls: ["https://travel.example/destinations/suzhou"],
  responseMetadata: { etag: '"v1"' },
  robots: {
    url: "https://travel.example/robots.txt",
    status: 200,
    contentHash: "b".repeat(64),
    rawText: "User-agent: *\nAllow: /",
    allowed: true,
    sitemapUrls: ["https://travel.example/sitemap.xml"],
  },
};

function captureView(input: {
  id: string;
  sourcePolicyId: string;
  operation: ResearchCaptureView["operation"];
  status: ResearchCaptureView["status"];
  requestUrlHash: string;
  evidenceSourceId: string | null;
  errorCode: string | null;
  resultMetadata?: Readonly<Record<string, unknown>>;
  startedAt: string;
  completedAt: string;
}): ResearchCaptureView {
  return {
    ...input,
    resultMetadata: input.resultMetadata ?? {},
    capturedByActorId: actor.actorId,
    createdAt: input.completedAt,
  };
}

class FakeResearchRepository implements ResearchRepository {
  source: ResearchSourcePolicyView | null = policy;
  readonly createInputs: CreateResearchSourcePolicyInput[] = [];
  readonly failureInputs: PersistResearchCaptureFailureInput[] = [];
  readonly pageInputs: PersistPageCaptureInput[] = [];
  readonly sitemapInputs: PersistSitemapDiscoveryInput[] = [];

  async listSources(): Promise<readonly ResearchSourcePolicyView[]> {
    return this.source === null ? [] : [this.source];
  }

  async createSource(
    _context: Readonly<ActorContext>,
    input: Readonly<CreateResearchSourcePolicyInput>,
  ): Promise<ResearchSourcePolicyView> {
    this.createInputs.push(input);
    this.source = { ...policy, ...input, version: 1, status: "active" };
    return this.source;
  }

  async retireSource(
    _context: Readonly<ActorContext>,
    input: Readonly<RetireResearchSourcePolicyInput>,
  ): Promise<{ source: ResearchSourcePolicyView; wasChanged: boolean }> {
    if (this.source === null) throw new Error("missing source");
    this.source = {
      ...this.source,
      status: "retired",
      retiredAt: input.retiredAt,
      retiredByActorId: actor.actorId,
      retirementReason: input.reason,
    };
    return { source: this.source, wasChanged: true };
  }

  async getActiveSource(): Promise<ResearchSourcePolicyView | null> {
    return this.source?.status === "active" ? this.source : null;
  }

  async listCaptures(): Promise<readonly ResearchCaptureView[]> {
    return [];
  }

  async persistPageCapture(
    _context: Readonly<ActorContext>,
    input: Readonly<PersistPageCaptureInput>,
  ): Promise<ResearchCaptureView> {
    this.pageInputs.push(input);
    return captureView({
      ...input,
      id: input.captureId,
      operation: "page_capture",
      status: "succeeded",
      evidenceSourceId: input.evidenceSourceId,
      errorCode: null,
    });
  }

  async persistSitemapDiscovery(
    _context: Readonly<ActorContext>,
    input: Readonly<PersistSitemapDiscoveryInput>,
  ): Promise<ResearchCaptureView> {
    this.sitemapInputs.push(input);
    return captureView({
      ...input,
      id: input.captureId,
      operation: "sitemap_discovery",
      status: "succeeded",
      evidenceSourceId: null,
      errorCode: null,
      resultMetadata: { discoveredUrls: input.discoveredUrls },
    });
  }

  async persistCaptureFailure(
    _context: Readonly<ActorContext>,
    input: Readonly<PersistResearchCaptureFailureInput>,
  ): Promise<ResearchCaptureView> {
    this.failureInputs.push(input);
    return captureView({
      ...input,
      id: input.captureId,
      status: "failed",
      evidenceSourceId: null,
      errorCode: input.errorCode,
    });
  }
}

function service(
  options: {
    repository?: FakeResearchRepository;
    collectPage?: (input: { url: string; policy: ResearchPolicy }) => Promise<ResearchPageSnapshot>;
    discoverSitemapUrls?: (input: {
      originUrl: string;
      policy: ResearchPolicy;
    }) => Promise<readonly string[]>;
  } = {},
) {
  const repository = options.repository ?? new FakeResearchRepository();
  const collectPage = vi.fn(options.collectPage ?? (async () => snapshot));
  const discoverSitemapUrls = vi.fn(
    options.discoverSitemapUrls ?? (async () => ["https://travel.example/destinations/shanghai"]),
  );
  let uuidCounter = 0;
  return {
    repository,
    collectPage,
    discoverSitemapUrls,
    value: new ResearchService({
      repository,
      collector: { collectPage, discoverSitemapUrls },
      now: () => new Date("2026-07-15T00:00:02.000Z"),
      uuid: () => `30000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    }),
  };
}

describe("ResearchService", () => {
  it("normalizes and persists explicit source policy bounds under tenant management authority", async () => {
    const fixture = service();
    const created = await fixture.value.createSource(actor, {
      sourceKey: "official-site",
      displayName: "Official site",
      origin: "https://TRAVEL.example",
      allowedHosts: ["TRAVEL.example."],
      userAgent: "GeoResearchBot/0.1",
      bounds: {
        maxBytes: 100_000,
        robotsMaxBytes: 10_000,
        timeoutMs: 2_000,
        maxRedirects: 2,
        maxDiscoveredUrls: 100,
      },
      respectRobots: true,
    });

    expect(created).toMatchObject({
      origin: "https://travel.example/",
      allowedHosts: ["travel.example"],
      respectRobots: true,
    });
    expect(fixture.repository.createInputs[0]).toMatchObject({
      maxBytes: 100_000,
      timeoutMs: 2_000,
    });
  });

  it("rejects a pathful origin and callers without governance authority", async () => {
    const fixture = service();
    await expect(
      fixture.value.createSource(actor, {
        sourceKey: "unsafe",
        displayName: "Unsafe",
        origin: "https://travel.example/arbitrary-path",
        allowedHosts: ["travel.example"],
        userAgent: "GeoResearchBot/0.1",
        bounds: {
          maxBytes: 100_000,
          robotsMaxBytes: 10_000,
          timeoutMs: 2_000,
          maxRedirects: 2,
          maxDiscoveredUrls: 100,
        },
        respectRobots: true,
      }),
    ).rejects.toMatchObject({ code: "RESEARCH_POLICY_INVALID" });

    await expect(
      fixture.value.createSource(
        { ...actor, capabilities: ["tenant:read"] },
        {
          sourceKey: "denied",
          displayName: "Denied",
          origin: "https://travel.example/",
          allowedHosts: ["travel.example"],
          userAgent: "GeoResearchBot/0.1",
          bounds: {
            maxBytes: 100_000,
            robotsMaxBytes: 10_000,
            timeoutMs: 2_000,
            maxRedirects: 2,
            maxDiscoveredUrls: 100,
          },
          respectRobots: true,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it("captures only an origin-relative page with the persisted policy", async () => {
    const fixture = service();
    const result = await fixture.value.capturePage(actor, policy.id, {
      path: "/destinations/shanghai?month=7",
    });

    expect(result.succeeded).toBe(true);
    expect(fixture.collectPage).toHaveBeenCalledWith({
      url: "https://travel.example/destinations/shanghai?month=7",
      policy: {
        allowedHosts: ["travel.example"],
        userAgent: "GeoResearchBot/0.1",
        maxBytes: 100_000,
        robotsMaxBytes: 10_000,
        timeoutMs: 2_000,
        maxRedirects: 2,
        maxDiscoveredUrls: 100,
        respectRobots: true,
      },
    });
    expect(fixture.repository.pageInputs[0]?.snapshot.rawHtml).toContain("Shanghai guide");
    await expect(
      fixture.value.capturePage(actor, policy.id, { path: "https://attacker.example/" }),
    ).rejects.toBeDefined();
  });

  it("stores only a safe failure code and no evidence when collection fails", async () => {
    const fixture = service({
      collectPage: async () => {
        throw new ResearchCollectionError(
          "RESEARCH_ROBOTS_DISALLOWED",
          "secret URL and transport details must not persist",
        );
      },
    });
    const result = await fixture.value.capturePage(actor, policy.id, { path: "/private" });

    expect(result).toMatchObject({
      succeeded: false,
      capture: {
        status: "failed",
        evidenceSourceId: null,
        errorCode: "RESEARCH_ROBOTS_DISALLOWED",
        resultMetadata: {},
      },
    });
    expect(fixture.repository.pageInputs).toHaveLength(0);
    expect(fixture.repository.failureInputs[0]).not.toHaveProperty("url");
    expect(JSON.stringify(fixture.repository.failureInputs[0])).not.toContain("secret URL");
  });

  it("discovers a sitemap from the stored origin and never accepts a caller URL", async () => {
    const fixture = service();
    const result = await fixture.value.discoverSitemap(actor, policy.id);

    expect(result.succeeded).toBe(true);
    expect(fixture.discoverSitemapUrls).toHaveBeenCalledWith({
      originUrl: policy.origin,
      policy: expect.objectContaining({ allowedHosts: ["travel.example"] }),
    });
    expect(fixture.repository.sitemapInputs[0]?.discoveredUrls).toEqual([
      "https://travel.example/destinations/shanghai",
    ]);
  });
});
