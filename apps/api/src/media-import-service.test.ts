import { createHash } from "node:crypto";

import type { PublicationVariantPayload } from "@geo/contracts";
import { sha256Canonical, sha256Text } from "@geo/core";
import type { MediaObjectStore, MediaObjectStorePutInput } from "@geo/media";
import { expect, it, vi } from "vitest";

import { MediaImportService, type MediaImportRepository } from "./media-import-service.js";
import type { MediaContentInspector } from "./media-inspection-gateway.js";
import type { MediaAssetView, MediaGenerationJobView, RequestContext } from "./repository.js";

const ids = Array.from(
  { length: 20 },
  (_, index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const [tenant, actor, content, version, factId, factSource, jobId] = ids as string[];
const context: RequestContext = { tenantId: tenant!, actorId: actor!, requestId: "import-test" };
const payload: PublicationVariantPayload = {
  editorialProfile: "guide",
  title: "Travel guide",
  summary: "Verified summary",
  bodyMarkdown: "Verified body",
  media: [],
  claims: [
    {
      id: factId!,
      text: "The consultation scope is confirmed before booking.",
      evidenceSourceIds: [factSource!],
      validUntil: null,
    },
  ],
  contactIds: [],
  tags: ["verified"],
};

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
  contentInspector?: MediaContentInspector,
  sourcePayload: PublicationVariantPayload = payload,
) {
  let completedJob: MediaGenerationJobView | null = null;
  let completedAsset: MediaAssetView | null = null;
  const repository: MediaImportRepository = {
    getContentVersion: vi.fn(async () => ({
      id: version!,
      contentItemId: content!,
      version: 1,
      summary: sourcePayload.summary,
      bodyMarkdown: sourcePayload.bodyMarkdown,
      payload: sourcePayload,
      payloadHash: sha256Canonical(sourcePayload),
      frozenAt: null,
    })),
    listFacts: vi.fn(async () => [
      {
        id: factId!,
        brandId: ids[19]!,
        normalizedKey: "scope",
        claim: payload.claims[0]!.text,
        status: "verified" as const,
        evidenceSourceIds: [factSource!],
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
        contentVersionId: version!,
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
    ...(contentInspector === undefined ? {} : { contentInspector }),
    uuid: () => uuidValues.shift()!,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  return { service, repository, put };
}

it("imports tenant-owned bytes as a live immutable successor asset", async () => {
  const { service, repository, put } = fixture();
  const bytes = png(1200, 900);
  const result = await service.request(context, {
    contentVersionId: version!,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId!],
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
      evaluator: "server-image-structure-inspector",
      evaluatorMode: "live",
      labels: expect.arrayContaining(["byte-integrity:verified", "ocr:not-run"]),
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

it("uses live Pi vision evidence for the immutable media reference", async () => {
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
    contentVersionId: version!,
    platform: "ctrip_community",
    role: "cover",
    claimIds: [factId!],
    idempotencyKey: "vision-upload-cover",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    rights: {
      kind: "licensed_stock",
      basis: "commercial_license",
      sourceUrl: "https://commons.example.test/wiki/travel-photo",
      licenseName: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      attribution: "Example photographer, CC BY-SA 4.0",
      rightsDescription: "Licensed travel photograph with commercial reuse rights.",
    },
    relevanceContext: {
      query: "Mount Fuji lake panorama",
      rationale: "Establish the destination in the cover.",
      articleTitle: "Japan family travel",
      sectionContext: "The guide opens with the Lake Ashi and Mount Fuji route.",
    },
  });

  expect(contentInspector.inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: tenant,
      assetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      relevanceContext: expect.objectContaining({ query: "Mount Fuji lake panorama" }),
    }),
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
      sourceUrl: "https://commons.example.test/wiki/travel-photo",
    },
    rights: { basis: "commercial_license", licenseName: "CC BY-SA 4.0" },
  });
  const evidenceInput = vi.mocked(repository.createEvidenceSource).mock.calls[0]?.[1];
  expect(evidenceInput?.type).toBe("url");
  expect(evidenceInput?.contentHash).toBe(sha256Text(evidenceInput?.content ?? ""));
  expect(evidenceInput?.content).toContain("Search query: Mount Fuji lake panorama");
  expect(evidenceInput?.metadata).toMatchObject({
    mediaSearchQueryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
});

it("fails the import before storing bytes when live content inspection rejects the image", async () => {
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
      labels: ["contact-text:detected"],
    })),
  };
  const { service, repository, put } = fixture(contentInspector);

  await expect(
    service.request(context, {
      contentVersionId: version!,
      platform: "ctrip_community",
      role: "cover",
      claimIds: [factId!],
      idempotencyKey: "rejected-upload-cover",
      bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "The tenant created and owns this travel photograph.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).rejects.toMatchObject({ code: "MEDIA_CONTENT_INSPECTION_FAILED", statusCode: 422 });
  expect(put).not.toHaveBeenCalled();
  expect(repository.createEvidenceSource).not.toHaveBeenCalled();
  expect(repository.completeMediaJob).not.toHaveBeenCalled();
});

it("rejects non-canonical base64 before creating a media job", async () => {
  const { service, repository } = fixture();
  await expect(
    service.request(context, {
      contentVersionId: version!,
      platform: "ctrip_community",
      role: "cover",
      claimIds: [factId!],
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
      contentVersionId: version!,
      platform: "ctrip_community",
      role: "inline",
      claimIds: [factId!],
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

it("rejects a repeated Ctrip scene signature before storing bytes", async () => {
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
      contentVersionId: version!,
      platform: "ctrip_community",
      role: "inline",
      claimIds: [factId!],
      idempotencyKey: "duplicate-scene",
      bytesBase64: Buffer.from(png(1200, 900)).toString("base64"),
      rights: {
        kind: "tenant_owned",
        ownershipAssertion: "Tenant-owned source image.",
        licenseName: "Tenant original photograph",
      },
    }),
  ).rejects.toMatchObject({ code: "MEDIA_SCENE_DUPLICATE", statusCode: 422 });
  expect(repository.createEvidenceSource).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
