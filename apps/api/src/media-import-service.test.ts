import { createHash } from "node:crypto";

import type { PublicationVariantPayload } from "@geo/contracts";
import { sha256Canonical, sha256Text } from "@geo/core";
import type { MediaObjectStore, MediaObjectStorePutInput } from "@geo/media";
import { expect, it, vi } from "vitest";

import { AgentRunGatewayError } from "./agent-run-gateway.js";
import { MediaImportService, type MediaImportRepository } from "./media-import-service.js";
import type { MediaContentInspector } from "./media-inspection-gateway.js";
import type { MediaAssetView, MediaGenerationJobView, RequestContext } from "./repository.js";

function fixtureValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${name} fixture value`);
  }
  return value;
}

const ids = Array.from(
  { length: 20 },
  (_, index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const tenant = fixtureValue(ids[0], "tenant ID");
const actor = fixtureValue(ids[1], "actor ID");
const content = fixtureValue(ids[2], "content ID");
const version = fixtureValue(ids[3], "content version ID");
const factId = fixtureValue(ids[4], "fact ID");
const factSource = fixtureValue(ids[5], "fact source ID");
const context: RequestContext = { tenantId: tenant, actorId: actor, requestId: "import-test" };
const payload: PublicationVariantPayload = {
  editorialProfile: "guide",
  title: "Travel guide",
  summary: "Verified summary",
  bodyMarkdown: "Verified body",
  media: [],
  claims: [
    {
      id: factId,
      text: "The consultation scope is confirmed before booking.",
      evidenceSourceIds: [factSource],
      validUntil: null,
    },
  ],
  contactIds: [],
  tags: ["verified"],
};

function passingInspector(): MediaContentInspector {
  return {
    inspect: vi.fn(async (input) => ({
      assetSha256: input.assetSha256,
      status: "passed" as const,
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live" as const,
      evaluatorVersion: "1.0.0",
      model: "vision-model",
      responseSha256: "b".repeat(64),
      providerRequestId: "vision-request-default",
      ocrText: "",
      labels: [
        "ocr:completed",
        "travel-relevance:passed",
        "contact-text:none",
        "vision-confidence:confident",
        "safety:passed",
        "scene-signature:mountain_lake:outdoor:wide",
      ],
    })),
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function fixture(
  contentInspector: MediaContentInspector | null = passingInspector(),
  sourcePayload: PublicationVariantPayload = payload,
) {
  let completedJob: MediaGenerationJobView | null = null;
  let completedAsset: MediaAssetView | null = null;
  const repository: MediaImportRepository = {
    getContentVersion: vi.fn(async () => ({
      id: version,
      contentItemId: content,
      version: 1,
      summary: sourcePayload.summary,
      bodyMarkdown: sourcePayload.bodyMarkdown,
      payload: sourcePayload,
      payloadHash: sha256Canonical(sourcePayload),
      frozenAt: null,
    })),
    listFacts: vi.fn(async () => [
      {
        id: factId,
        brandId: fixtureValue(ids[19], "brand ID"),
        normalizedKey: "scope",
        claim: fixtureValue(payload.claims[0], "claim").text,
        status: "verified" as const,
        evidenceSourceIds: [factSource],
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: null,
      },
    ]),
    listEvidenceSources: vi.fn(async () => []),
    createEvidenceSource: vi.fn(async (_context, input) => ({ ...input })),
    createMediaJob: vi.fn(async (_context, input) => ({
      id: input.jobId,
      contentVersionId: input.contentVersionId,
      platform: input.platform,
      role: input.role,
      factIds: input.factIds,
      visualBrief: input.visualBrief,
      visualBriefHash: input.visualBriefHash,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      providerId: input.providerId,
      providerMode: input.providerMode,
      state: "pending" as const,
      attemptCount: 0,
      assetId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      completedAt: null,
    })),
    getMediaJob: vi.fn(async () => completedJob),
    recordMediaAttempt: vi.fn(async () => undefined),
    completeMediaJob: vi.fn(async (_context, input) => {
      completedAsset = {
        id: input.assetId,
        contentVersionId: input.successorContentVersionId,
        storageKey: input.storageKey,
        reference: input.reference,
        createdAt: input.completedAt,
      };
      completedJob = {
        id: input.jobId,
        contentVersionId: version,
        platform: input.reference.platform,
        role: input.reference.role,
        factIds: input.reference.factIds,
        visualBrief: input.reference.visualBrief,
        visualBriefHash: input.reference.visualBriefHash,
        requestHash: "a".repeat(64),
        idempotencyKey: "upload-cover",
        providerId: "customer-upload",
        providerMode: "live",
        state: "succeeded",
        attemptCount: 1,
        assetId: input.assetId,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: input.completedAt,
        updatedAt: input.completedAt,
        completedAt: input.completedAt,
      };
      return completedAsset;
    }),
    failMediaJob: vi.fn(async () => {
      throw new Error("unexpected failure");
    }),
    getMediaAsset: vi.fn(async () => completedAsset),
  };
  const put = vi.fn(async (input: MediaObjectStorePutInput) => ({
    storageKey: `${input.tenantId}/${input.sha256.slice(0, 2)}/${input.sha256}.png`,
    byteLength: input.bytes.byteLength,
  }));
  const objectStore: MediaObjectStore = {
    put,
    get: vi.fn(async () => new Uint8Array()),
  };
  const uuidValues = ids.slice(6, 13);
  const service = new MediaImportService({
    repository,
    objectStore,
    ...(contentInspector === null ? {} : { contentInspector }),
    uuid: () => fixtureValue(uuidValues.shift(), "UUID"),
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  return { service, repository, put };
}

it("imports tenant-owned bytes as a live immutable successor asset", async () => {
  const { service, repository, put } = fixture();
  const bytes = png(1200, 900);
  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "upload-cover",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights: {
      kind: "tenant_owned",
      ownershipAssertion: "The tenant created and owns this travel photograph.",
      licenseName: "Tenant original photograph",
    },
  });

  expect(result.wasCreated).toBe(true);
  expect(result.contentInspectionRequired).toBe(true);
  expect(result.asset?.reference).toMatchObject({
    mimeType: "image/png",
    width: 1200,
    height: 900,
    platform: "ctrip_community",
    role: "cover",
    rights: { basis: "tenant_owned" },
    provenance: { kind: "tenant_owned" },
    inspection: {
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live",
      labels: expect.arrayContaining(["byte-integrity:verified", "ocr:completed"]),
    },
  });
  expect(result.asset?.reference.provenance.kind).not.toBe("generated");
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: tenant, mimeType: "image/png", bytes }),
  );
  expect(repository.createEvidenceSource).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      type: "manual",
      metadata: expect.objectContaining({
        purpose: "media-rights",
        rightsRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    }),
  );
  const evidenceInput = vi.mocked(repository.createEvidenceSource).mock.calls[0]?.[1];
  expect(evidenceInput?.contentHash).toBe(sha256Text(evidenceInput?.content ?? ""));
  expect(evidenceInput?.content).toContain(`Media SHA-256: ${result.asset?.reference.sha256}`);
  expect(repository.completeMediaJob).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ attemptId: ids[7], successorContentVersionId: ids[12] }),
  );
});

it("imports a licensed search result without requiring a verified content claim", async () => {
  const { service, repository } = fixture();
  const bytes = png(1200, 900);

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [],
    idempotencyKey: "claim-free-licensed-cover",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights: {
      kind: "licensed_stock",
      basis: "commercial_license",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Qingdao_airport.jpg",
      licenseName: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      attribution: "Example photographer",
      rightsDescription: "Licensed travel photograph with commercial reuse rights.",
    },
    relevanceContext: {
      query: "Qingdao airport family departure",
      rationale: "Show a family departure scene for the article cover.",
      articleTitle: "Family travel from Qingdao",
      sectionContext: "The article opens with a family preparing to depart from Qingdao.",
    },
    discovery: {
      kind: "licensed_search",
      provider: "wikimedia_commons",
      providerAssetId: "110803033",
      query: "Qingdao airport family departure",
    },
  });

  expect(result.asset?.reference).toMatchObject({
    factIds: [],
    visualBrief: { factIds: [] },
    rights: { basis: "commercial_license" },
    provenance: { kind: "licensed_stock" },
    inspection: {
      status: "passed",
      labels: expect.arrayContaining(["travel-relevance:passed"]),
    },
  });
  expect(repository.createEvidenceSource).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      type: "url",
      metadata: expect.objectContaining({
        purpose: "media-rights",
        mediaDiscoveryProvider: "wikimedia_commons",
      }),
    }),
  );
});

it("reuses rights evidence only when its media and rights request hashes match", async () => {
  const { service, repository } = fixture();
  const bytes = png(1200, 900);
  const mediaSha256 = createHash("sha256").update(bytes).digest("hex");
  const rights = {
    kind: "tenant_owned" as const,
    ownershipAssertion: "The tenant created and owns this travel photograph.",
    licenseName: "Tenant original photograph",
  };
  const existingEvidenceId = fixtureValue(ids[13], "existing evidence ID");
  vi.mocked(repository.listEvidenceSources).mockResolvedValue([
    {
      id: existingEvidenceId,
      type: "manual",
      title: "Existing media ownership assertion",
      sourceUrl: null,
      contentHash: "c".repeat(64),
      capturedAt: "2026-07-18T00:00:00.000Z",
      validUntil: null,
      metadata: {
        purpose: "media-rights",
        mediaSha256,
        rightsRequestHash: sha256Canonical(rights),
      },
    },
  ]);

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "reuse-rights-evidence",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights,
  });

  expect(repository.createEvidenceSource).not.toHaveBeenCalled();
  expect(result.asset?.reference.provenance).toMatchObject({
    kind: "tenant_owned",
    evidenceSourceId: existingEvidenceId,
  });
});

it("creates new rights evidence for a changed assertion and uses the persisted ID", async () => {
  const { service, repository } = fixture();
  const bytes = png(1200, 900);
  const mediaSha256 = createHash("sha256").update(bytes).digest("hex");
  const rights = {
    kind: "tenant_owned" as const,
    ownershipAssertion: "The tenant created and owns this updated travel photograph.",
    licenseName: "Tenant original photograph",
  };
  const staleEvidenceId = fixtureValue(ids[13], "stale evidence ID");
  const persistedEvidenceId = fixtureValue(ids[14], "persisted evidence ID");
  vi.mocked(repository.listEvidenceSources).mockResolvedValue([
    {
      id: staleEvidenceId,
      type: "manual",
      title: "Stale media ownership assertion",
      sourceUrl: null,
      contentHash: "d".repeat(64),
      capturedAt: "2026-07-18T00:00:00.000Z",
      validUntil: null,
      metadata: {
        purpose: "media-rights",
        mediaSha256,
        rightsRequestHash: sha256Canonical({
          ...rights,
          ownershipAssertion: "The superseded ownership assertion.",
        }),
      },
    },
  ]);
  vi.mocked(repository.createEvidenceSource).mockImplementation(async (_context, input) => ({
    id: persistedEvidenceId,
    type: input.type,
    title: input.title,
    sourceUrl: input.sourceUrl,
    contentHash: input.contentHash,
    capturedAt: input.capturedAt,
    validUntil: input.validUntil,
    metadata: input.metadata,
  }));

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "replace-rights-evidence",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights,
  });

  expect(repository.createEvidenceSource).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      id: ids[8],
      metadata: expect.objectContaining({
        mediaSha256,
        rightsRequestHash: sha256Canonical(rights),
      }),
    }),
  );
  expect(result.asset?.reference.provenance).toMatchObject({
    kind: "tenant_owned",
    evidenceSourceId: persistedEvidenceId,
  });
  expect(result.asset?.reference.provenance).not.toMatchObject({
    evidenceSourceId: staleEvidenceId,
  });
});

it("fails closed before repository or object-store access when live inspection is unavailable", async () => {
  const { service, repository, put } = fixture(null);

  await expect(
    service.request(context, {
      contentVersionId: version,
      platform: "ctrip_community",
      role: "cover",
      claimIds: [factId],
      idempotencyKey: "missing-inspector",
      bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "The tenant created and owns this travel photograph.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).rejects.toMatchObject({
    code: "MEDIA_CONTENT_INSPECTION_UNAVAILABLE",
    statusCode: 503,
  });
  expect(repository.getContentVersion).not.toHaveBeenCalled();
  expect(repository.createMediaJob).not.toHaveBeenCalled();
  expect(repository.createEvidenceSource).not.toHaveBeenCalled();
  expect(repository.completeMediaJob).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("records Pexels discovery and live Pi vision evidence for the immutable media reference", async () => {
  const contentInspector: MediaContentInspector = {
    inspect: vi.fn(async (input) => ({
      assetSha256: input.assetSha256,
      status: "passed" as const,
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live" as const,
      evaluatorVersion: "1.0.0",
      model: "vision-model",
      responseSha256: "b".repeat(64),
      providerRequestId: "vision-request-1",
      ocrText: "Mount Fuji",
      labels: [
        "ocr:completed",
        "travel-relevance:passed",
        "contact-text:none",
        "vision-confidence:confident",
        "safety:passed",
        "scene-signature:mountain_lake:outdoor:wide",
      ],
    })),
  };
  const { service, repository } = fixture(contentInspector);
  const bytes = png(1200, 900);

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "vision-upload-cover",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights: {
      kind: "licensed_stock",
      basis: "commercial_license",
      sourceUrl: "https://www.pexels.com/photo/mount-fuji-42/",
      licenseName: "Pexels License",
      licenseUrl: "https://www.pexels.com/license/",
      attribution: "Example photographer / Pexels",
      rightsDescription: "Licensed travel photograph with commercial reuse rights.",
    },
    relevanceContext: {
      query: "Mount Fuji lake panorama",
      rationale: "Establish the destination in the cover.",
      articleTitle: "Japan family travel",
      sectionContext: "The guide opens with the Lake Ashi and Mount Fuji route.",
    },
    discovery: {
      kind: "licensed_search",
      provider: "pexels",
      providerAssetId: "42",
      query: "Mount Fuji lake panorama",
    },
  });

  expect(contentInspector.inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: tenant,
      assetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      relevanceContext: expect.objectContaining({ query: "Mount Fuji lake panorama" }),
    }),
    undefined,
  );
  expect(result.asset?.reference.inspection).toMatchObject({
    evaluator: "pi-vision-inspector",
    evaluatorMode: "live",
    evaluatorVersion: "1.0.0",
    responseSha256: "b".repeat(64),
    ocrText: "Mount Fuji",
    labels: expect.arrayContaining([
      "byte-integrity:verified",
      "dimensions:verified",
      "ocr:completed",
    ]),
  });
  expect(result.asset?.reference).toMatchObject({
    provenance: {
      kind: "licensed_stock",
      sourceUrl: "https://www.pexels.com/photo/mount-fuji-42/",
    },
    rights: { basis: "commercial_license", licenseName: "Pexels License" },
  });
  expect(repository.createMediaJob).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ providerId: "pexels-search", providerMode: "live" }),
  );
  expect(repository.recordMediaAttempt).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ providerId: "pexels-search", model: "pexels-api-v1" }),
  );
  const evidenceInput = vi.mocked(repository.createEvidenceSource).mock.calls[0]?.[1];
  expect(evidenceInput?.type).toBe("url");
  expect(evidenceInput?.contentHash).toBe(sha256Text(evidenceInput?.content ?? ""));
  expect(evidenceInput?.content).toContain("Search query: Mount Fuji lake panorama");
  expect(evidenceInput?.metadata).toMatchObject({
    mediaSearchQueryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    mediaDiscoveryProvider: "pexels",
    mediaDiscoveryAssetId: "42",
  });
});

it("stores a degraded image when live content inspection does not pass", async () => {
  const contentInspector: MediaContentInspector = {
    inspect: vi.fn(async (input) => ({
      assetSha256: input.assetSha256,
      status: "failed" as const,
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live" as const,
      evaluatorVersion: "1.0.0",
      model: "vision-model",
      responseSha256: "c".repeat(64),
      providerRequestId: null,
      ocrText: "WeChat TEST1234",
      labels: ["contact-text:detected", "scene-signature:travel_scene:outdoor:wide"],
    })),
  };
  const { service, repository, put } = fixture(contentInspector);

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "rejected-upload-cover",
    bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
    rights: {
      kind: "tenant_owned",
      ownershipAssertion: "The tenant created and owns this travel photograph.",
      licenseName: "Tenant original photograph",
    },
  });

  expect(result.asset?.reference.inspection).toMatchObject({
    status: "failed",
    labels: expect.arrayContaining([
      "contact-text:detected",
      "vision-audit:degraded",
      "scene-signature:travel_scene:outdoor:wide",
    ]),
  });
  expect(put).toHaveBeenCalledOnce();
  expect(repository.createEvidenceSource).toHaveBeenCalledOnce();
  expect(repository.completeMediaJob).toHaveBeenCalledOnce();
});

it("stores explicit degraded evidence when the live vision provider fails", async () => {
  const contentInspector: MediaContentInspector = {
    inspect: vi.fn(async () => {
      throw new AgentRunGatewayError(
        502,
        "MEDIA_INSPECTION_PROVIDER_FAILED",
        "Vision provider failed",
      );
    }),
  };
  const { service, repository, put } = fixture(contentInspector);

  const result = await service.request(context, {
    contentVersionId: version,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId],
    idempotencyKey: "provider-failed-upload-cover",
    bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
    rights: {
      kind: "tenant_owned",
      ownershipAssertion: "The tenant created and owns this travel photograph.",
      licenseName: "Tenant original photograph",
    },
  });

  expect(result.asset?.reference.inspection).toMatchObject({
    status: "failed",
    evaluator: "pi-vision-inspector",
    evaluatorMode: "live",
    labels: expect.arrayContaining([
      "vision-audit:degraded",
      "vision-error:provider_failed",
      "scene-signature:unverified:unknown:unknown",
    ]),
  });
  expect(put).toHaveBeenCalledOnce();
  expect(repository.createEvidenceSource).toHaveBeenCalledOnce();
  expect(repository.completeMediaJob).toHaveBeenCalledOnce();
});

it("rejects non-canonical base64 before creating a media job", async () => {
  const { service, repository } = fixture();
  await expect(
    service.request(context, {
      contentVersionId: version,
      platform: "ctrip_community",
      role: "cover",
      claimIds: [factId],
      idempotencyKey: "bad-base64",
      bytesBase64: "data:image/png;base64,AAAA",
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "Tenant-owned source image.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).rejects.toMatchObject({ code: "MEDIA_BASE64_INVALID", statusCode: 400 });
  expect(repository.createMediaJob).not.toHaveBeenCalled();
});

it("rejects exact duplicate image bytes before creating a media job", async () => {
  const bytes = png(1200, 900);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = {
    sha256,
    inspection: { labels: ["scene-signature:mountain_lake:outdoor:wide"] },
  } as unknown as PublicationVariantPayload["media"][number];
  const { service, repository, put } = fixture(undefined, { ...payload, media: [existing] });

  await expect(
    service.request(context, {
      contentVersionId: version,
      platform: "ctrip_community",
      role: "inline",
      claimIds: [factId],
      idempotencyKey: "duplicate-bytes",
      bytesBase64: Buffer.from(bytes).toString("base64"),
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "Tenant-owned source image.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).rejects.toMatchObject({ code: "MEDIA_ASSET_DUPLICATE", statusCode: 422 });
  expect(repository.createMediaJob).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("accepts different Ctrip image bytes that share a scene signature", async () => {
  const signature = "scene-signature:mountain_lake:outdoor:wide";
  const existing = {
    sha256: "f".repeat(64),
    platform: "ctrip_community",
    role: "cover",
    inspection: { labels: [signature] },
  } as unknown as PublicationVariantPayload["media"][number];
  const contentInspector: MediaContentInspector = {
    inspect: vi.fn(async (input) => ({
      assetSha256: input.assetSha256,
      status: "passed" as const,
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live" as const,
      evaluatorVersion: "1.0.0",
      model: "vision-model",
      responseSha256: "d".repeat(64),
      providerRequestId: null,
      ocrText: "",
      labels: [
        "ocr:completed",
        "travel-relevance:passed",
        "contact-text:none",
        "vision-confidence:confident",
        "safety:passed",
        signature,
      ],
    })),
  };
  const { service, repository, put } = fixture(contentInspector, {
    ...payload,
    media: [existing],
  });

  await expect(
    service.request(context, {
      contentVersionId: version,
      platform: "ctrip_community",
      role: "inline",
      claimIds: [factId],
      idempotencyKey: "duplicate-scene",
      bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "Tenant-owned source image.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).resolves.toMatchObject({ wasCreated: true });
  expect(repository.createEvidenceSource).toHaveBeenCalledOnce();
  expect(put).toHaveBeenCalledOnce();
});

it("reuses inspection evidence for exact preverified fallback bytes", async () => {
  const contentInspector: MediaContentInspector = {
    inspect: vi.fn(async () => {
      throw new Error("live inspection must not run for a preverified fallback");
    }),
  };
  const { service, repository } = fixture(contentInspector);
  const bytes = png(1200, 900);
  const assetSha256 = createHash("sha256").update(bytes).digest("hex");
  const inspectedAt = "2026-07-18T10:00:00.000Z";

  const result = await service.request(
    context,
    {
      contentVersionId: version,
      platform: "ctrip_community",
      role: "cover",
      claimIds: [factId],
      idempotencyKey: "preverified-fallback",
      bytesBase64: Buffer.from(bytes).toString("base64"),
      rights: {
        kind: "licensed_stock",
        basis: "editorial_license",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Fallback.jpg",
        licenseName: "Public source attribution",
        licenseUrl: "https://commons.wikimedia.org/wiki/File:Fallback.jpg",
        rightsDescription: "Public-source fallback retained with attribution.",
      },
    },
    {
      trustedInspection: {
        assetSha256,
        status: "passed",
        evaluator: "pi-vision-inspector",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
        responseSha256: "d".repeat(64),
        inspectedAt,
        ocrText: "",
        labels: [
          "format:image/jpeg",
          "byte-integrity:verified",
          "dimensions:verified",
          "travel-relevance:passed",
          "contact-text:none",
          "safety:passed",
          "scene-signature:urban_street:outdoor:wide",
        ],
      },
    },
  );

  expect(contentInspector.inspect).not.toHaveBeenCalled();
  expect(result.asset?.reference.inspection).toMatchObject({
    assetSha256,
    inspectedAt,
    labels: expect.arrayContaining(["inspection-reuse:preverified"]),
  });
  expect(new Set(result.asset?.reference.inspection.labels).size).toBe(
    result.asset?.reference.inspection.labels.length,
  );
  expect(repository.completeMediaJob).toHaveBeenCalledOnce();
});
