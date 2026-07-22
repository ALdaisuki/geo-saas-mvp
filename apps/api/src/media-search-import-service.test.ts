import type { PublicationVariantPayload } from "@geo/contracts";
import type {
  LicensedImageCandidate,
  LicensedImageSearchProvider,
  NormalizedLicensedImage,
} from "@geo/media";
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
      { id: factId, text: "Verified itinerary fact", evidenceSourceIds: [factId], validUntil: null },
    ],
    contactIds: [],
    tags: [],
  };
}

function candidate(query: string, suffix = "1"): LicensedImageCandidate {
  return {
    provider: "wikimedia_commons",
    providerAssetId: `${queries.indexOf(query) + 1}${suffix}`,
    searchQuery: query,
    title: query,
    description: query,
    creator: "Example Author",
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(query)}-${suffix}`,
    downloadUrl: `https://upload.wikimedia.org/${encodeURIComponent(query)}-${suffix}.jpg`,
    licenseName: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Example Author",
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

function resumableMedia(index: number): PublicationVariantPayload["media"][number] {
  return {
    platform: "ctrip_community",
    role: index === 0 ? "cover" : "inline",
    provenance: {
      kind: "licensed_stock",
      evidenceSourceId: factId,
      sourceUrl: `https://commons.wikimedia.org/wiki/File:resume-${index}.jpg`,
    },
    inspection: { status: "passed", evaluatorMode: "live" },
  } as PublicationVariantPayload["media"][number];
}

function fixture(
  options: {
    failFirstCandidate?: boolean;
    failAllCandidatesWith?: { readonly code: string; readonly statusCode: number };
    existingMediaCount?: number;
    invalidExistingMedia?: boolean;
  } = {},
) {
  const sourcePayload = payload();
  for (let index = 0; index < (options.existingMediaCount ?? 0); index += 1) {
    sourcePayload.media.push(resumableMedia(index));
  }
  if (options.invalidExistingMedia === true) {
    sourcePayload.media.push({} as PublicationVariantPayload["media"][number]);
  }
  const repository: MediaSearchImportRepository = {
    getContentVersion: vi.fn(async () => ({
      id: contentVersionId,
      contentItemId,
      version: 1,
      summary: sourcePayload.summary,
      bodyMarkdown: sourcePayload.bodyMarkdown,
      payload: sourcePayload,
      payloadHash: "a".repeat(64),
      frozenAt: null,
    })),
  };
  const search = vi.fn(async ({ query }: { query: string }) =>
    options.failFirstCandidate === true
      ? [candidate(query, "bad"), candidate(query, "good")]
      : [candidate(query)],
  );
  const provider: LicensedImageSearchProvider = {
    search,
    downloadAndNormalize: vi.fn(async ({ candidate: item }) => normalized(item.searchQuery)),
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
          providerId: "wikimedia-commons-search",
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
  return { service: new MediaSearchImportService({ repository, provider, mediaImport }), mediaImport };
}

describe("MediaSearchImportService", () => {
  it("imports one relevant licensed image for every article search intent", async () => {
    const { service, mediaImport } = fixture();
    const result = await service.request(context, {
      contentVersionId,
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

  it("skips rejected candidates and tries the next licensed search result", async () => {
    const { service, mediaImport } = fixture({ failFirstCandidate: true });
    const result = await service.request(context, {
      contentVersionId,
      idempotencyKey: "article-keyword-images-retry",
    });

    expect(result.imported).toHaveLength(5);
    expect(result.rejectedCandidateCount).toBe(5);
    expect(result.rejectionCodes).toContain("MEDIA_SEARCH_CANDIDATE_FAILED");
    expect(mediaImport.request).toHaveBeenCalledTimes(10);
  });

  it("marks an unfilled intent retryable when live inspection is temporarily unavailable", async () => {
    const { service } = fixture({
      failAllCandidatesWith: { code: "MEDIA_INSPECTION_PROVIDER_FAILED", statusCode: 502 },
    });

    await expect(
      service.request(context, {
        contentVersionId,
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

  it("rejects versions without a governed Wikimedia media prefix", async () => {
    const { service } = fixture({ invalidExistingMedia: true });
    await expect(
      service.request(context, { contentVersionId, idempotencyKey: "mixed-media" }),
    ).rejects.toMatchObject({ code: "MEDIA_SEARCH_RESUME_INVALID", statusCode: 409 });
  });
});
