import { createHash } from "node:crypto";

import type { MediaReference, PublicationVariantPayload } from "@geo/contracts";
import type {
  LicensedImageCandidate,
  LicensedImageSearchProvider,
  NormalizedLicensedImage,
} from "@geo/media";
import type { LicensedImageSearchProviderId } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import type { MediaImportController } from "./media-import-service.js";
import { MediaProductionServiceError } from "./media-production-service.js";
import {
  MediaSearchImportService,
  type MediaSearchImportRepository,
} from "./media-search-import-service.js";
import type { RequestContext } from "./repository.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const contentVersionId = "10000000-0000-4000-8000-000000000003";
const contentItemId = "10000000-0000-4000-8000-000000000004";
const factId = "10000000-0000-4000-8000-000000000005";
const cachedContentVersionId = "10000000-0000-4000-8000-000000000006";
const cachedContentItemId = "10000000-0000-4000-8000-000000000007";
const context: RequestContext = { tenantId, actorId, requestId: "media-search-test" };

const queries = [
  "Kyoto Kinkakuji lake panorama",
  "Kyoto Fushimi Inari torii gates",
  "Kyoto traditional food",
  "Kyoto bamboo forest path",
  "Kyoto railway station",
];

function payload(): PublicationVariantPayload {
  return {
    editorialProfile: "guide",
    title: "Kyoto family itinerary",
    summary: "A verified Kyoto route.",
    bodyMarkdown: "## Route\nVisit verified destinations in a practical order.",
    mediaSearchPlan: queries.map((query, index) => ({
      query,
      role: index === 0 ? "cover" : "inline",
      rationale: `Illustrate ${query}`,
      claimIds: [factId],
    })),
    media: [],
    claims: [
      {
        id: factId,
        text: "Verified itinerary fact",
        evidenceSourceIds: [factId],
        validUntil: null,
      },
    ],
    contactIds: [],
    tags: [],
  };
}

function candidate(
  query: string,
  suffix = "1",
  provider: LicensedImageSearchProviderId = "wikimedia_commons",
): LicensedImageCandidate {
  return {
    provider,
    providerAssetId: `${queries.indexOf(query) + 1}${suffix}`,
    searchQuery: query,
    title: query,
    description: query,
    creator: "Example Author",
    sourceUrl:
      provider === "wikimedia_commons"
        ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(query)}-${suffix}`
        : `https://www.pexels.com/photo/${encodeURIComponent(query)}-${suffix}/`,
    downloadUrl:
      provider === "wikimedia_commons"
        ? `https://upload.wikimedia.org/${encodeURIComponent(query)}-${suffix}.jpg`
        : `https://images.pexels.com/photos/${encodeURIComponent(query)}-${suffix}.jpg`,
    licenseName: provider === "wikimedia_commons" ? "CC BY-SA 4.0" : "Pexels License",
    licenseUrl:
      provider === "wikimedia_commons"
        ? "https://creativecommons.org/licenses/by-sa/4.0/"
        : "https://www.pexels.com/license/",
    attribution: provider === "wikimedia_commons" ? "Example Author" : "Example Author / Pexels",
    sourceWidth: 1600,
    sourceHeight: 1200,
    mimeType: "image/jpeg",
  };
}

function normalized(query: string): NormalizedLicensedImage {
  return {
    bytes: Uint8Array.from(Buffer.from(`normalized:${query}`)),
    mimeType: "image/jpeg",
    width: 1200,
    height: 900,
    modificationDescription: "Normalized to 1200x900.",
  };
}

function normalizedCandidate(item: LicensedImageCandidate): NormalizedLicensedImage {
  return normalized(`${item.searchQuery}:${item.providerAssetId}`);
}

function cachedMedia(
  query: string,
  manualReview = false,
): {
  readonly bytes: Uint8Array;
  readonly reference: MediaReference;
} {
  const bytes = normalized(query).bytes;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    reference: {
      id: "10000000-0000-4000-8000-000000000008",
      sha256,
      mimeType: "image/jpeg",
      byteLength: bytes.byteLength,
      width: 1200,
      height: 900,
      platform: "ctrip_community",
      role: "cover",
      altText: "Previously inspected destination image",
      caption: "Licensed destination image",
      factIds: [factId],
      visualBrief: {} as never,
      visualBriefHash: "b".repeat(64),
      rights: {
        basis: "commercial_license",
        licenseName: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "Example Author",
        verifiedAt: "2026-07-20T00:00:00.000Z",
      },
      provenance: {
        kind: "licensed_stock",
        evidenceSourceId: "10000000-0000-4000-8000-000000000009",
        sourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(query)}.jpg`,
      },
      inspection: {
        assetSha256: sha256,
        status: "passed",
        evaluator: "pi-vision",
        evaluatorMode: "live",
        evaluatorVersion: "gpt-5.6-luna",
        responseSha256: "c".repeat(64),
        inspectedAt: "2026-07-20T00:00:00.000Z",
        ocrText: "",
        labels: [
          "travel-relevance:passed",
          "scene-signature:temple_shrine:outdoor:wide",
          ...(manualReview ? ["manual-review:required"] : []),
        ],
      },
    },
  };
}

function resumableMedia(
  index: number,
  provider: LicensedImageSearchProviderId,
): PublicationVariantPayload["media"][number] {
  return {
    platform: "ctrip_community",
    role: index === 0 ? "cover" : "inline",
    provenance: {
      kind: "licensed_stock",
      evidenceSourceId: factId,
      sourceUrl:
        provider === "wikimedia_commons"
          ? `https://commons.wikimedia.org/wiki/File:resume-${index}.jpg`
          : `https://www.pexels.com/photo/resume-${index}/`,
    },
    inspection: { status: "passed", evaluatorMode: "live" },
  } as PublicationVariantPayload["media"][number];
}

function fixture(
  options: {
    failFirstCandidate?: boolean;
    failAllCandidatesWith?: { readonly code: string; readonly statusCode: number };
    existingMediaCount?: number;
    existingMediaProvider?: LicensedImageSearchProviderId;
    provider?: LicensedImageSearchProviderId;
    candidateProvider?: LicensedImageSearchProviderId;
    cachedQuery?: string;
    cachedAvailable?: boolean;
    cachedManualReview?: boolean;
    invalidExistingMedia?: boolean;
    providerReturnsEmpty?: boolean;
    providerSearchFails?: boolean;
    locationQuery?: string;
    emptySearchQueries?: readonly string[];
    intentFallbackQueries?: readonly string[];
    failFirstSearchWith?: { readonly code: string; readonly statusCode: number };
    failFirstSearchWithNestedStatus?: { readonly code: string; readonly status: number };
    sectionRefs?: Readonly<Record<number, string>>;
    sectionedArticle?: boolean;
    candidateSuffixes?: readonly string[];
    submittedMediaHistory?: readonly {
      readonly sha256: string;
      readonly sourceUrl: string | null;
    }[];
  } = {},
) {
  const providerId = options.provider ?? "wikimedia_commons";
  const sourcePayload = payload();
  if (options.intentFallbackQueries !== undefined) {
    const plan = sourcePayload.mediaSearchPlan;
    if (plan?.[0] !== undefined) {
      plan[0] = {
        ...plan[0],
        fallbackQueries: [...options.intentFallbackQueries],
        retryBudget: 2,
      };
    }
  }
  if (options.locationQuery !== undefined) {
    sourcePayload.locationQuery = options.locationQuery;
  }
  if (options.sectionedArticle === true) {
    const mediaSearchPlan = sourcePayload.mediaSearchPlan;
    if (mediaSearchPlan === undefined) throw new Error("Media search plan fixture is missing");
    const headings = ["Shrine walk", "Traditional food", "Bamboo path", "Rail transfer"];
    sourcePayload.bodyMarkdown = [
      "A general Kyoto introduction.",
      ...headings.flatMap((heading) => ["", `## ${heading}`, "", `${heading} details.`]),
    ].join("\n");
    sourcePayload.mediaSearchPlan = mediaSearchPlan.map((intent, index) => ({
      ...intent,
      rationale:
        index === 0 ? "Establish the general destination." : `Illustrate ${headings[index - 1]}.`,
      ...(options.sectionRefs?.[index] === undefined
        ? {}
        : { sectionRef: options.sectionRefs[index] }),
    }));
  }
  for (let index = 0; index < (options.existingMediaCount ?? 0); index += 1) {
    sourcePayload.media.push(resumableMedia(index, options.existingMediaProvider ?? providerId));
  }
  if (options.invalidExistingMedia === true) {
    sourcePayload.media.push({} as PublicationVariantPayload["media"][number]);
  }
  const cached =
    options.providerSearchFails === true || options.cachedAvailable === true
      ? cachedMedia(
          options.cachedQuery ?? (queries[0] as string),
          options.cachedManualReview === true,
        )
      : null;
  const repository: MediaSearchImportRepository = {
    listSubmittedMediaHistory: vi.fn(async () => options.submittedMediaHistory ?? []),
    getContentVersion: vi.fn(async (_context, requestedVersionId) => {
      const selectedPayload =
        requestedVersionId === cachedContentVersionId && cached !== null
          ? { ...payload(), media: [cached.reference] }
          : sourcePayload;
      return {
        id: requestedVersionId,
        contentItemId:
          requestedVersionId === cachedContentVersionId ? cachedContentItemId : contentItemId,
        version: 1,
        summary: selectedPayload.summary,
        bodyMarkdown: selectedPayload.bodyMarkdown,
        payload: selectedPayload,
        payloadHash: "a".repeat(64),
        frozenAt: null,
      };
    }),
    ...(cached === null
      ? {}
      : {
          listContent: vi.fn(async () => [
            {
              id: cachedContentItemId,
              campaignId: contentItemId,
              brandId: contentItemId,
              title: "Cached Kyoto article",
              contentType: "guide",
              state: "audited",
              topicKey: "travel:kyoto",
              latestVersion: 1,
              latestVersionId: cachedContentVersionId,
              latestActivityAt: null,
            },
          ]),
          getMediaAsset: vi.fn(async () => ({
            id: cached.reference.id,
            contentVersionId: cachedContentVersionId,
            storageKey: `${tenantId}/${cached.reference.sha256.slice(0, 2)}/${cached.reference.sha256}.jpg`,
            reference: cached.reference,
            createdAt: "2026-07-20T00:00:00.000Z",
          })),
        }),
  };
  let searchAttempts = 0;
  const search = vi.fn(async ({ query }: { query: string }) => {
    searchAttempts += 1;
    if (options.providerSearchFails === true) throw new TypeError("fetch failed");
    if (options.failFirstSearchWith !== undefined && searchAttempts === 1) {
      throw Object.assign(new Error(options.failFirstSearchWith.code), {
        code: options.failFirstSearchWith.code,
        statusCode: options.failFirstSearchWith.statusCode,
      });
    }
    if (options.failFirstSearchWithNestedStatus !== undefined && searchAttempts === 1) {
      const error = new Error("provider 429") as Error & {
        code?: string;
        details?: { status?: number };
      };
      error.code = options.failFirstSearchWithNestedStatus.code;
      error.details = { status: options.failFirstSearchWithNestedStatus.status };
      throw error;
    }
    if (options.providerReturnsEmpty === true || options.emptySearchQueries?.includes(query)) {
      return [];
    }
    return options.failFirstCandidate === true
      ? [
          candidate(query, "bad", options.candidateProvider ?? providerId),
          candidate(query, "good", options.candidateProvider ?? providerId),
        ]
      : (options.candidateSuffixes ?? ["1"]).map((suffix) =>
          candidate(query, suffix, options.candidateProvider ?? providerId),
        );
  });
  const provider: LicensedImageSearchProvider = {
    provider: providerId,
    search,
    downloadAndNormalize: vi.fn(async ({ candidate: item }) => normalizedCandidate(item)),
  };
  let imported = 0;
  const mediaImport: MediaImportController = {
    request: vi.fn(async (_context, input) => {
      if (options.failAllCandidatesWith !== undefined) {
        throw new MediaProductionServiceError(
          options.failAllCandidatesWith.code,
          options.failAllCandidatesWith.statusCode,
          "candidate unavailable",
        );
      }
      if (options.failFirstCandidate === true && input.discovery?.providerAssetId.endsWith("bad")) {
        throw Object.assign(new Error("irrelevant"), { code: "MEDIA_CONTENT_INSPECTION_FAILED" });
      }
      imported += 1;
      return {
        job: {
          id: `20000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
          contentVersionId: input.contentVersionId,
          platform: input.platform,
          role: input.role,
          factIds: input.claimIds,
          visualBrief: {} as never,
          visualBriefHash: "b".repeat(64),
          requestHash: "c".repeat(64),
          idempotencyKey: input.idempotencyKey,
          providerId:
            providerId === "wikimedia_commons" ? "wikimedia-commons-search" : "pexels-search",
          providerMode: "live" as const,
          state: "succeeded" as const,
          attemptCount: 1,
          assetId: `30000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-20T00:00:00.000Z",
          completedAt: "2026-07-20T00:00:00.000Z",
        },
        asset: {
          id: `30000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
          contentVersionId: `40000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
          storageKey: `media/${imported}.jpg`,
          reference: {} as never,
          createdAt: "2026-07-20T00:00:00.000Z",
        },
        wasCreated: true,
        contentInspectionRequired: true as const,
      };
    }),
  };
  const objectStore =
    cached === null
      ? undefined
      : {
          get: vi.fn(async () => cached.bytes),
        };
  return {
    service: new MediaSearchImportService({
      repository,
      provider,
      mediaImport,
      ...(objectStore === undefined ? {} : { objectStore }),
    }),
    mediaImport,
    objectStore,
    provider,
  };
}

describe("MediaSearchImportService", () => {
  it("imports one relevant licensed image for every article search intent", async () => {
    const { service, mediaImport } = fixture();
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-keyword-images",
    });

    expect(result).toMatchObject({
      plannedCount: 5,
      initialMediaCount: 0,
      totalMediaCount: 5,
      complete: true,
      rejectedCandidateCount: 0,
    });
    expect(result.imported).toHaveLength(5);
    expect(result.imported.map((item) => item.role)).toEqual([
      "cover",
      "inline",
      "inline",
      "inline",
      "inline",
    ]);
    expect(mediaImport.request).toHaveBeenCalledTimes(5);
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1]).toMatchObject({
      relevanceContext: { query: queries[0], articleTitle: "Kyoto family itinerary" },
      discovery: { kind: "licensed_search", provider: "wikimedia_commons" },
    });
  });

  it("preserves the requested platform when importing media for a Toutiao article", async () => {
    const { service, mediaImport } = fixture();
    const request = {
      contentVersionId,
      idempotencyKey: "toutiao-article-keyword-images",
      platform: "toutiao",
      maxImports: 1,
    } as Parameters<typeof service.request>[1];

    await service.request(context, request);

    expect(mediaImport.request).toHaveBeenCalledOnce();
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1]).toMatchObject({
      platform: "toutiao",
    });
  });

  it("retries an empty intent search with the article location and an eight-candidate limit", async () => {
    const originalQuery = queries[0] as string;
    const locationQuery = "Japan";
    const fallbackQuery = `${locationQuery} ${originalQuery}`;
    const { service, mediaImport, provider } = fixture({
      locationQuery,
      emptySearchQueries: [originalQuery],
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "location-query-fallback",
      maxImports: 1,
    });

    expect(provider.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: originalQuery, limit: 8 }),
    );
    expect(provider.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: fallbackQuery, limit: 8 }),
    );
    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ totalMediaCount: 1, complete: false });
    expect(result.imported).toHaveLength(1);
    expect(mediaImport.request).toHaveBeenCalledOnce();
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1]).toMatchObject({
      relevanceContext: { query: originalQuery },
      discovery: { query: originalQuery },
    });
  });

  it("binds each inline inspection to its explicitly named Markdown section", async () => {
    const { service, mediaImport } = fixture({ sectionedArticle: true });

    await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-section-context",
    });

    const contexts = vi
      .mocked(mediaImport.request)
      .mock.calls.map((call) => call[1].relevanceContext?.sectionContext);
    expect(contexts[0]).toContain("A general Kyoto introduction.");
    expect(contexts[1]).toBe("## Shrine walk\n\nShrine walk details.");
    expect(contexts[2]).toBe("## Traditional food\n\nTraditional food details.");
    expect(contexts[3]).toBe("## Bamboo path\n\nBamboo path details.");
    expect(contexts[4]).toBe("## Rail transfer\n\nRail transfer details.");
  });

  it("falls back to an immutable tenant-licensed asset when live search is unavailable", async () => {
    const { service, mediaImport, objectStore, provider } = fixture({
      providerSearchFails: true,
    });
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-keyword-images-cache",
      maxImports: 1,
    });

    expect(result).toMatchObject({ totalMediaCount: 1, complete: false });
    expect(result.imported[0]?.providerAssetId).toMatch(/^cache-[a-f0-9]{64}$/u);
    expect(provider.downloadAndNormalize).not.toHaveBeenCalled();
    expect(objectStore?.get).toHaveBeenCalledWith({
      tenantId,
      storageKey: expect.stringMatching(
        new RegExp(`^${tenantId}/[a-f0-9]{2}/[a-f0-9]{64}\\.jpg$`, "u"),
      ),
    });
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1]).toMatchObject({
      relevanceContext: { query: queries[0] },
      discovery: {
        kind: "licensed_search",
        provider: "wikimedia_commons",
        providerAssetId: expect.stringMatching(/^cache-[a-f0-9]{64}$/u),
      },
      rights: {
        sourceUrl: expect.stringContaining("commons.wikimedia.org/wiki/File:"),
        licenseName: "CC BY-SA 4.0",
      },
    });
  });

  it("uses structured fallback queries when the primary search misses", async () => {
    const originalQuery = queries[0] as string;
    const { service, mediaImport, provider } = fixture({
      intentFallbackQueries: ["Kinkakuji", "Kyoto temple"],
      emptySearchQueries: [originalQuery, "Kinkakuji"],
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "structured-fallback-queries",
      maxImports: 1,
    });

    expect(provider.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: originalQuery, limit: 8 }),
    );
    expect(provider.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: "Kinkakuji", limit: 8 }),
    );
    expect(provider.search).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ query: "Kyoto temple", limit: 8 }),
    );
    expect(provider.search).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ totalMediaCount: 1 });
    expect(mediaImport.request).toHaveBeenCalledOnce();
  });

  it("retries a transient provider 429 before reporting an unfilled intent", async () => {
    const { service, mediaImport, provider } = fixture({
      failFirstSearchWith: { code: "MEDIA_SEARCH_PROVIDER_FAILED", statusCode: 429 },
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "provider-429-retry",
      maxImports: 1,
    });

    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(provider.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query: queries[0], limit: 8 }),
    );
    expect(result).toMatchObject({ totalMediaCount: 1, imported: [{ query: queries[0] }] });
    expect(mediaImport.request).toHaveBeenCalledOnce();
  });

  it("retries a provider 429 carried in MediaProductionError details", async () => {
    const { service, mediaImport, provider } = fixture({
      failFirstSearchWithNestedStatus: {
        code: "MEDIA_SEARCH_PROVIDER_FAILED",
        status: 429,
      },
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "provider-429-details-retry",
      maxImports: 1,
    });

    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ totalMediaCount: 1, imported: [{ query: queries[0] }] });
    expect(mediaImport.request).toHaveBeenCalledOnce();
  });

  it("prefers the explicit sectionRef when it differs from the rationale", async () => {
    const { service, mediaImport } = fixture({
      sectionedArticle: true,
      sectionRefs: { 2: "Bamboo path" },
    });

    await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "section-ref-overrides-rationale",
    });

    const contexts = vi
      .mocked(mediaImport.request)
      .mock.calls.map((call) => call[1].relevanceContext?.sectionContext);
    expect(contexts[2]).toBe("## Bamboo path\n\nBamboo path details.");
  });

  it("falls back to an immutable tenant-licensed asset when live search returns no candidates", async () => {
    const { service, mediaImport, objectStore, provider } = fixture({
      cachedAvailable: true,
      providerReturnsEmpty: true,
    });
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-keyword-images-empty-cache",
      maxImports: 1,
    });

    expect(result).toMatchObject({ totalMediaCount: 1, complete: false });
    expect(result.imported[0]?.providerAssetId).toMatch(/^cache-[a-f0-9]{64}$/u);
    expect(provider.downloadAndNormalize).not.toHaveBeenCalled();
    expect(objectStore?.get).toHaveBeenCalledTimes(1);
    expect(mediaImport.request).toHaveBeenCalledTimes(1);
  });

  it("re-inspects cached media that carries an old manual-review label", async () => {
    const { service, mediaImport } = fixture({
      cachedAvailable: true,
      providerReturnsEmpty: true,
      cachedManualReview: true,
    });

    await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-keyword-images-refresh-manual-cache",
      maxImports: 1,
    });

    expect(mediaImport.request).toHaveBeenCalledWith(
      context,
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mediaImport.request).not.toHaveBeenCalledWith(
      context,
      expect.any(Object),
      expect.objectContaining({ trustedInspection: expect.anything() }),
    );
  });

  it("uses a preverified generic fallback when live search fails after the budget", async () => {
    const { service, mediaImport, objectStore } = fixture({
      providerSearchFails: true,
      cachedQuery: "Osaka Dotonbori canal night",
    });

    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "article-keyword-images-unmatched-cache",
        maxImports: 1,
      }),
    ).resolves.toMatchObject({ totalMediaCount: 1, complete: false });
    expect(objectStore?.get).toHaveBeenCalledOnce();
    expect(mediaImport.request).toHaveBeenCalledWith(
      context,
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("skips rejected candidates and tries the next licensed search result", async () => {
    const { service, mediaImport } = fixture({ failFirstCandidate: true });
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "article-keyword-images-retry",
    });

    expect(result.imported).toHaveLength(5);
    expect(result.rejectedCandidateCount).toBe(5);
    expect(result.rejectionCodes).toContain("MEDIA_SEARCH_CANDIDATE_FAILED");
    expect(mediaImport.request).toHaveBeenCalledTimes(10);
  });

  it("skips a live candidate whose source URL was already submitted by the tenant", async () => {
    const submitted = candidate(queries[0] as string, "submitted");
    const { service, mediaImport, provider } = fixture({
      candidateSuffixes: ["submitted", "fresh"],
      submittedMediaHistory: [{ sha256: "d".repeat(64), sourceUrl: submitted.sourceUrl }],
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "skip-submitted-source",
      maxImports: 1,
    });

    expect(result.imported[0]?.providerAssetId).toMatch(/fresh$/u);
    expect(provider.downloadAndNormalize).toHaveBeenCalledTimes(1);
    expect(mediaImport.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1].discovery?.providerAssetId).toMatch(
      /fresh$/u,
    );
  });

  it("skips normalized bytes that match previously submitted tenant media", async () => {
    const reused = candidate(queries[0] as string, "same-bytes");
    const reusedSha256 = createHash("sha256")
      .update(normalizedCandidate(reused).bytes)
      .digest("hex");
    const { service, mediaImport, provider } = fixture({
      candidateSuffixes: ["same-bytes", "fresh-bytes"],
      submittedMediaHistory: [
        { sha256: reusedSha256, sourceUrl: "https://commons.wikimedia.org/wiki/File:alias.jpg" },
      ],
    });

    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "skip-submitted-sha256",
      maxImports: 1,
    });

    expect(result.imported[0]?.providerAssetId).toMatch(/fresh-bytes$/u);
    expect(provider.downloadAndNormalize).toHaveBeenCalledTimes(2);
    expect(mediaImport.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1].discovery?.providerAssetId).toMatch(
      /fresh-bytes$/u,
    );
  });

  it("marks an unfilled intent retryable when live inspection is temporarily unavailable", async () => {
    const { service } = fixture({
      failAllCandidatesWith: { code: "MEDIA_INSPECTION_PROVIDER_FAILED", statusCode: 502 },
    });

    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "retry-live-inspection",
        maxImports: 1,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_SEARCH_INTENT_UNFILLED",
      statusCode: 503,
      details: { rejectionCodes: ["MEDIA_INSPECTION_PROVIDER_FAILED"] },
    });
  });

  it("keeps a policy-only unfilled intent non-retryable", async () => {
    const { service } = fixture({
      failAllCandidatesWith: { code: "MEDIA_CONTENT_INSPECTION_FAILED", statusCode: 422 },
    });

    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "reject-policy-only-intent",
        maxImports: 1,
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_SEARCH_INTENT_UNFILLED",
      statusCode: 422,
      details: { rejectionCodes: ["MEDIA_CONTENT_INSPECTION_FAILED"] },
    });
  });

  it("imports one item and resumes from a valid Wikimedia media prefix", async () => {
    const { service, mediaImport } = fixture({ existingMediaCount: 2 });
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "resume-media",
      maxImports: 1,
    });

    expect(result).toMatchObject({
      plannedCount: 5,
      initialMediaCount: 2,
      totalMediaCount: 3,
      complete: false,
    });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ intentIndex: 2, query: queries[2] });
    expect(mediaImport.request).toHaveBeenCalledTimes(1);
  });

  it("imports and resumes only from a valid Pexels media prefix", async () => {
    const { service, mediaImport } = fixture({ provider: "pexels", existingMediaCount: 2 });
    const result = await service.request(context, {
      contentVersionId,
      platform: "ctrip_community",
      idempotencyKey: "resume-pexels-media",
      maxImports: 1,
    });

    expect(result).toMatchObject({
      provider: "pexels",
      initialMediaCount: 2,
      totalMediaCount: 3,
      complete: false,
    });
    expect(vi.mocked(mediaImport.request).mock.calls[0]?.[1]).toMatchObject({
      rights: {
        sourceUrl: expect.stringContaining("https://www.pexels.com/photo/"),
        licenseName: "Pexels License",
      },
      discovery: { kind: "licensed_search", provider: "pexels" },
    });
  });

  it("rejects a Wikimedia prefix when the configured provider is Pexels", async () => {
    const { service } = fixture({
      provider: "pexels",
      existingMediaCount: 1,
      existingMediaProvider: "wikimedia_commons",
    });
    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "mixed-provider-prefix",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SEARCH_RESUME_INVALID", statusCode: 409 });
  });

  it("fails closed when a provider returns a candidate owned by another provider", async () => {
    const { service, mediaImport } = fixture({
      provider: "pexels",
      candidateProvider: "wikimedia_commons",
    });
    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "provider-mismatch",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SEARCH_PROVIDER_MISMATCH", statusCode: 502 });
    expect(mediaImport.request).not.toHaveBeenCalled();
  });

  it("rejects versions without a governed Wikimedia media prefix", async () => {
    const { service } = fixture({ invalidExistingMedia: true });
    await expect(
      service.request(context, {
        contentVersionId,
        platform: "ctrip_community",
        idempotencyKey: "mixed-media",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SEARCH_RESUME_INVALID", statusCode: 409 });
  });
});
