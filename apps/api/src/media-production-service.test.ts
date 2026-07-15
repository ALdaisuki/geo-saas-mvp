import type { PublicationVariantPayload } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import {
  FixtureImageGenerationProvider,
  type MediaObjectStore,
  type MediaObjectStorePutInput,
} from "@geo/media";
import { describe, expect, it, vi } from "vitest";

import {
  MediaProductionService,
  type MediaProductionRepository,
} from "./media-production-service.js";
import type { MediaAssetView, MediaGenerationJobView, RequestContext } from "./repository.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  content: "10000000-0000-4000-8000-000000000003",
  version: "10000000-0000-4000-8000-000000000004",
  fact: "10000000-0000-4000-8000-000000000005",
  source: "10000000-0000-4000-8000-000000000006",
  job: "10000000-0000-4000-8000-000000000007",
  attempt: "10000000-0000-4000-8000-000000000008",
  asset: "10000000-0000-4000-8000-000000000009",
  inspection: "10000000-0000-4000-8000-000000000010",
  binding: "10000000-0000-4000-8000-000000000011",
  successor: "10000000-0000-4000-8000-000000000012",
  replayJob: "10000000-0000-4000-8000-000000000013",
} as const;

const context: RequestContext = {
  tenantId: ids.tenant,
  actorId: ids.actor,
  requestId: "media-service-test",
};

const sourcePayload: PublicationVariantPayload = {
  editorialProfile: "guide",
  title: "Verified travel guide",
  summary: "Verified source summary",
  bodyMarkdown: "## Verified source\n\nOnly verified facts are used.",
  media: [],
  claims: [
    {
      id: ids.fact,
      text: "Service scope is confirmed before signing.",
      evidenceSourceIds: [ids.source],
      validUntil: null,
    },
  ],
  contactIds: [],
  tags: ["verified"],
};

const fact = {
  id: ids.fact,
  brandId: "10000000-0000-4000-8000-000000000014",
  normalizedKey: "service.scope",
  claim: "Service scope is confirmed before signing.",
  status: "verified" as const,
  evidenceSourceIds: [ids.source],
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
};

function pendingJob(id: string = ids.job): MediaGenerationJobView {
  return {
    id,
    contentVersionId: ids.version,
    platform: "toutiao",
    role: "cover",
    factIds: [ids.fact],
    visualBrief: {
      schemaVersion: "geo.visual-brief.v1",
      editorialProfile: "guide",
      platform: "toutiao",
      role: "cover",
      aspectRatio: "16:9",
      factIds: [ids.fact],
      prompt: "placeholder",
      negativePrompt: "placeholder",
      altText: "placeholder",
      caption: "placeholder",
    },
    visualBriefHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    idempotencyKey: "fixture-cover",
    providerId: "fixture",
    providerMode: "fixture",
    state: "pending",
    attemptCount: 0,
    assetId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-07-15T05:00:00.000Z",
    updatedAt: "2026-07-15T05:00:00.000Z",
    completedAt: null,
  };
}

function repositoryFixture(overrides: Partial<MediaProductionRepository> = {}) {
  let completedAsset: MediaAssetView | null = null;
  let completedJob: MediaGenerationJobView | null = null;
  const repository: MediaProductionRepository = {
    getAutomationStatus: vi.fn(async () => ({
      control: {
        id: "10000000-0000-4000-8000-000000000015",
        mode: "shadow" as const,
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-07-15T05:00:00.000Z",
      },
      circuits: [],
    })),
    getContentVersion: vi.fn(async () => ({
      id: ids.version,
      contentItemId: ids.content,
      version: 1,
      summary: sourcePayload.summary,
      bodyMarkdown: sourcePayload.bodyMarkdown,
      payload: sourcePayload,
      payloadHash: sha256Canonical(sourcePayload),
      frozenAt: null,
    })),
    listFacts: vi.fn(async () => [fact]),
    createMediaJob: vi.fn(async (_context, input) => ({
      ...pendingJob(input.jobId),
      platform: input.platform,
      role: input.role,
      factIds: input.factIds,
      visualBrief: input.visualBrief,
      visualBriefHash: input.visualBriefHash,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      providerId: input.providerId,
      providerMode: input.providerMode,
    })),
    getMediaJob: vi.fn(async (_context, jobId) =>
      completedJob?.id === jobId ? completedJob : pendingJob(jobId),
    ),
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
        ...pendingJob(input.jobId),
        state: "succeeded",
        attemptCount: 1,
        assetId: input.assetId,
        updatedAt: input.completedAt,
        completedAt: input.completedAt,
      };
      return completedAsset;
    }),
    failMediaJob: vi.fn(async (_context, input) => ({
      ...pendingJob(input.jobId),
      state: "failed" as const,
      lastErrorCode: input.errorCode,
      lastErrorMessage: input.errorMessage,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    })),
    getMediaAsset: vi.fn(async (_context, assetId) =>
      completedAsset?.id === assetId ? completedAsset : null,
    ),
    listMediaAssets: vi.fn(async () => (completedAsset === null ? [] : [completedAsset])),
    ...overrides,
  };
  return repository;
}

function memoryStore() {
  const put = vi.fn(async (input: MediaObjectStorePutInput) => ({
    storageKey: `${input.tenantId}/${input.sha256.slice(0, 2)}/${input.sha256}.png`,
    byteLength: input.bytes.byteLength,
  }));
  const store: MediaObjectStore = { put, get: vi.fn(async () => new Uint8Array()) };
  return { store, put };
}

function serviceFixture(input: {
  repository?: MediaProductionRepository;
  store?: MediaObjectStore;
  provider?: FixtureImageGenerationProvider;
}) {
  const values = [ids.job, ids.attempt, ids.asset, ids.inspection, ids.binding, ids.successor];
  return new MediaProductionService({
    repository: input.repository ?? repositoryFixture(),
    provider: input.provider ?? new FixtureImageGenerationProvider(),
    objectStore: input.store ?? memoryStore().store,
    uuid: () => {
      const value = values.shift();
      if (value === undefined) throw new Error("UUID fixture exhausted");
      return value;
    },
    now: () => new Date("2026-07-15T05:00:00.000Z"),
  });
}

describe("MediaProductionService", () => {
  it("creates a fact-bound fixture asset and immutable successor payload", async () => {
    const repository = repositoryFixture();
    const { store, put } = memoryStore();
    const result = await serviceFixture({ repository, store }).request(context, {
      contentVersionId: ids.version,
      platform: "toutiao",
      role: "cover",
      claimIds: [ids.fact],
      idempotencyKey: "fixture-cover",
    });

    expect(result).toMatchObject({
      wasCreated: true,
      capability: {
        enabled: true,
        providerId: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        networkUsed: false,
      },
      job: { id: ids.job, state: "succeeded", assetId: ids.asset },
      asset: {
        id: ids.asset,
        contentVersionId: ids.successor,
        reference: {
          provenance: {
            kind: "generated",
            provider: "fixture",
            providerMode: "fixture",
            model: "fixture-png-v1",
          },
          inspection: { status: "passed", ocrText: "", evaluatorMode: "fixture" },
        },
      },
    });
    expect(put).toHaveBeenCalledOnce();
    expect(repository.recordMediaAttempt).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        attemptId: ids.attempt,
        jobId: ids.job,
        status: "succeeded",
        providerMode: "fixture",
        model: "fixture-png-v1",
      }),
    );
    expect(repository.completeMediaJob).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        jobId: ids.job,
        assetId: ids.asset,
        inspectionId: ids.inspection,
        bindingId: ids.binding,
        successorContentVersionId: ids.successor,
        successorPayload: expect.objectContaining({
          media: [expect.objectContaining({ id: ids.asset, factIds: [ids.fact] })],
        }),
      }),
    );
    expect(JSON.stringify(result.asset)).not.toContain("4001133986");
    expect(JSON.stringify(result.asset)).not.toContain("ZTGL3411");
    expect(JSON.stringify(result.asset)).not.toContain("ZTGL6431");
  });

  it("fails before job creation when automation is stopped", async () => {
    const repository = repositoryFixture({
      getAutomationStatus: vi.fn(async () => ({
        control: {
          id: "10000000-0000-4000-8000-000000000015",
          mode: "stopped" as const,
          killSwitchEnabled: true,
          reason: "operator stop",
          quota: {},
          updatedAt: "2026-07-15T05:00:00.000Z",
        },
        circuits: [],
      })),
    });

    await expect(
      serviceFixture({ repository }).request(context, {
        contentVersionId: ids.version,
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "blocked",
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_PRODUCTION_BLOCKED",
      statusCode: 409,
    });
    expect(repository.createMediaJob).not.toHaveBeenCalled();
  });

  it("rejects claims that are unverified or absent from the source payload", async () => {
    const repository = repositoryFixture({
      listFacts: vi.fn(async () => [{ ...fact, status: "draft" as const }]),
    });
    await expect(
      serviceFixture({ repository }).request(context, {
        contentVersionId: ids.version,
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "unverified",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_CLAIMS_INVALID", statusCode: 422 });
  });

  it("returns an exact succeeded replay without invoking provider or storage", async () => {
    const replayAsset: MediaAssetView = {
      id: ids.asset,
      contentVersionId: ids.successor,
      storageKey: `${ids.tenant}/aa/${"a".repeat(64)}.png`,
      reference: {
        id: ids.asset,
        sha256: "a".repeat(64),
        mimeType: "image/png",
        byteLength: 128,
        width: 1280,
        height: 720,
        platform: "toutiao",
        role: "cover",
        altText: "Verified fixture",
        caption: "Verified fixture",
        factIds: [ids.fact],
        visualBrief: {
          schemaVersion: "geo.visual-brief.v1",
          editorialProfile: "guide",
          platform: "toutiao",
          role: "cover",
          aspectRatio: "16:9",
          factIds: [ids.fact],
          prompt: "Verified fixture",
          negativePrompt: "text",
          altText: "Verified fixture",
          caption: "Verified fixture",
        },
        visualBriefHash: "b".repeat(64),
        rights: {
          basis: "generated_terms",
          licenseName: "Fixture terms",
          verifiedAt: "2026-07-15T05:00:00.000Z",
        },
        provenance: {
          kind: "generated",
          jobId: ids.replayJob,
          attemptId: ids.attempt,
          provider: "fixture",
          providerMode: "fixture",
          model: "fixture-png-v1",
          promptHash: "c".repeat(64),
          parametersHash: "d".repeat(64),
          generatedAt: "2026-07-15T05:00:00.000Z",
        },
        inspection: {
          assetSha256: "a".repeat(64),
          status: "passed",
          evaluator: "fixture-inspector",
          evaluatorMode: "fixture",
          evaluatorVersion: "1.0.0",
          responseSha256: "e".repeat(64),
          inspectedAt: "2026-07-15T05:00:00.000Z",
          ocrText: "",
          labels: ["fixture"],
        },
      },
      createdAt: "2026-07-15T05:00:00.000Z",
    };
    const replayJob: MediaGenerationJobView = {
      ...pendingJob(ids.replayJob),
      state: "succeeded",
      attemptCount: 1,
      assetId: ids.asset,
      completedAt: "2026-07-15T05:00:00.000Z",
    };
    const repository = repositoryFixture({
      createMediaJob: vi.fn(async () => replayJob),
      getMediaAsset: vi.fn(async () => replayAsset),
    });
    const provider = new FixtureImageGenerationProvider();
    const generate = vi.spyOn(provider, "generate");
    const { store, put } = memoryStore();

    await expect(
      serviceFixture({ repository, provider, store }).request(context, {
        contentVersionId: ids.version,
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "fixture-cover",
      }),
    ).resolves.toMatchObject({ wasCreated: false, job: replayJob, asset: replayAsset });
    expect(generate).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("records a failed attempt and terminal job when object storage fails", async () => {
    const repository = repositoryFixture();
    const store: MediaObjectStore = {
      put: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      get: vi.fn(async () => new Uint8Array()),
    };

    await expect(
      serviceFixture({ repository, store }).request(context, {
        contentVersionId: ids.version,
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "storage-failure",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_PRODUCTION_FAILED", statusCode: 502 });
    expect(repository.recordMediaAttempt).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ status: "failed", outputSha256: null }),
    );
    expect(repository.failMediaJob).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ jobId: ids.job, errorCode: "MEDIA_PRODUCTION_FAILED" }),
    );
    expect(repository.completeMediaJob).not.toHaveBeenCalled();
  });
});
