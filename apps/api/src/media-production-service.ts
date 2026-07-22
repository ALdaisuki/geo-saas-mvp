import { createHash, randomUUID } from "node:crypto";

import {
  idSchema,
  mediaReferenceSchema,
  mediaRoleSchema,
  platformSchema,
  type MediaReference,
} from "@geo/contracts";
import { buildVisualBrief, sha256Canonical, sha256Text } from "@geo/core";
import {
  fixtureImageInputHash,
  type ImageGenerationProvider,
  type ImageGenerationResult,
  type MediaObjectStore,
} from "@geo/media";
import { z } from "zod";

import type {
  ApiRepository,
  MediaAssetView,
  MediaGenerationJobView,
  RequestContext,
} from "./repository.js";

const FIXTURE_PROVIDER = Object.freeze({
  enabled: true,
  providerId: "fixture",
  providerMode: "fixture",
  model: "fixture-png-v1",
  networkUsed: false,
} as const);

export const DISABLED_MEDIA_PRODUCTION_CAPABILITY = Object.freeze({
  enabled: false,
  providerId: "disabled",
  providerMode: null,
  model: null,
  networkUsed: false,
} as const);

export type MediaProductionCapability =
  typeof FIXTURE_PROVIDER | typeof DISABLED_MEDIA_PRODUCTION_CAPABILITY;

export const mediaProductionRequestSchema = z.strictObject({
  contentVersionId: idSchema,
  platform: platformSchema,
  role: mediaRoleSchema,
  claimIds: z
    .array(idSchema)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, "Claim IDs must be unique"),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export type MediaProductionRequest = z.infer<typeof mediaProductionRequestSchema>;

export interface MediaProductionResult {
  readonly capability: MediaProductionCapability;
  readonly job: MediaGenerationJobView;
  readonly asset: MediaAssetView | null;
  readonly wasCreated: boolean;
}

export interface MediaProductionStatus {
  readonly capability: MediaProductionCapability;
  readonly job: MediaGenerationJobView;
  readonly asset: MediaAssetView | null;
}

export interface MediaProductionController {
  readonly capability: MediaProductionCapability;
  request(context: RequestContext, input: MediaProductionRequest): Promise<MediaProductionResult>;
}

export type MediaProductionRepository = Pick<
  ApiRepository,
  | "getAutomationStatus"
  | "getContentVersion"
  | "listFacts"
  | "createMediaJob"
  | "getMediaJob"
  | "recordMediaAttempt"
  | "completeMediaJob"
  | "failMediaJob"
  | "getMediaAsset"
  | "listMediaAssets"
>;

export class MediaProductionServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "MediaProductionServiceError";
  }
}

export interface MediaProductionServiceOptions {
  readonly repository: MediaProductionRepository;
  readonly provider: ImageGenerationProvider;
  readonly objectStore: MediaObjectStore;
  readonly uuid?: () => string;
  readonly now?: () => Date;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFixtureResult(result: ImageGenerationResult, expectedInputHash: string): void {
  if (
    result.providerId !== FIXTURE_PROVIDER.providerId ||
    result.providerMode !== FIXTURE_PROVIDER.providerMode ||
    result.model !== FIXTURE_PROVIDER.model ||
    result.inputHash !== expectedInputHash ||
    result.mimeType !== "image/png" ||
    result.bytes.byteLength === 0 ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.metadata.fixture !== true ||
    result.metadata.deterministic !== true ||
    result.metadata.networkUsed !== false
  ) {
    throw new MediaProductionServiceError(
      "MEDIA_FIXTURE_TRUTH_INVALID",
      502,
      "Fixture provider returned an invalid or misleading result",
    );
  }
}

function failureMessage(): string {
  return "Deterministic fixture media production failed";
}

export class MediaProductionService implements MediaProductionController {
  readonly capability: MediaProductionCapability = FIXTURE_PROVIDER;
  readonly #repository: MediaProductionRepository;
  readonly #provider: ImageGenerationProvider;
  readonly #objectStore: MediaObjectStore;
  readonly #uuid: () => string;
  readonly #now: () => Date;

  constructor(options: MediaProductionServiceOptions) {
    const descriptor = options.provider.descriptor;
    if (
      descriptor.id !== FIXTURE_PROVIDER.providerId ||
      descriptor.mode !== FIXTURE_PROVIDER.providerMode ||
      descriptor.model !== FIXTURE_PROVIDER.model
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_PROVIDER_UNSUPPORTED",
        500,
        "Only the deterministic fixture media provider is supported",
      );
    }
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#objectStore = options.objectStore;
    this.#uuid = options.uuid ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async request(
    context: RequestContext,
    rawInput: MediaProductionRequest,
  ): Promise<MediaProductionResult> {
    const parsed = mediaProductionRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new MediaProductionServiceError(
        "MEDIA_REQUEST_INVALID",
        400,
        "Media production request is invalid",
        { issues: parsed.error.issues },
      );
    }
    const input = parsed.data;
    const automation = await this.#repository.getAutomationStatus(context);
    if (
      automation.control.killSwitchEnabled ||
      automation.control.mode === "paused" ||
      automation.control.mode === "stopped"
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_PRODUCTION_BLOCKED",
        409,
        "Media production is blocked by tenant automation controls",
      );
    }

    const source = await this.#repository.getContentVersion(context, input.contentVersionId);
    if (source === null) {
      throw new MediaProductionServiceError(
        "MEDIA_CONTENT_VERSION_NOT_FOUND",
        404,
        "Source content version was not found",
      );
    }
    if (source.payload.editorialProfile === undefined) {
      throw new MediaProductionServiceError(
        "MEDIA_EDITORIAL_PROFILE_REQUIRED",
        422,
        "Source content requires an editorial profile for media production",
      );
    }

    const availableFacts = await this.#repository.listFacts(context, { limit: 200 });
    const factsById = new Map(availableFacts.map((fact) => [fact.id, fact]));
    const claimsById = new Map(source.payload.claims.map((claim) => [claim.id, claim]));
    const capturedAt = this.#now();
    const facts = input.claimIds.map((claimId) => {
      const fact = factsById.get(claimId);
      const claim = claimsById.get(claimId);
      const validAtCapture =
        fact !== undefined &&
        Date.parse(fact.validFrom) <= capturedAt.getTime() &&
        (fact.validUntil === null || Date.parse(fact.validUntil) > capturedAt.getTime());
      const exactSnapshot =
        fact !== undefined &&
        claim !== undefined &&
        fact.claim === claim.text &&
        sameOrderedValues(fact.evidenceSourceIds, claim.evidenceSourceIds) &&
        fact.validUntil === claim.validUntil;
      if (
        fact === undefined ||
        claim === undefined ||
        fact.status !== "verified" ||
        !validAtCapture ||
        !exactSnapshot
      ) {
        throw new MediaProductionServiceError(
          "MEDIA_CLAIMS_INVALID",
          422,
          "Media production requires exact, current, verified source claims",
          { claimIds: input.claimIds },
        );
      }
      return {
        id: fact.id,
        brandId: fact.brandId,
        text: fact.claim,
        evidenceSourceIds: fact.evidenceSourceIds,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
      };
    });

    const visualBrief = buildVisualBrief({
      editorialProfile: source.payload.editorialProfile,
      platform: input.platform,
      role: input.role,
      facts,
    });
    const visualBriefHash = sha256Canonical(visualBrief);
    const expectedInputHash = fixtureImageInputHash(visualBrief);
    const requestHash = sha256Canonical({
      schemaVersion: "geo.media-production-request.v1",
      contentVersionId: input.contentVersionId,
      platform: input.platform,
      role: input.role,
      claimIds: input.claimIds,
      visualBriefHash,
      provider: this.#provider.descriptor,
    });
    const proposedJobId = this.#uuid();
    const job = await this.#repository.createMediaJob(context, {
      jobId: proposedJobId,
      contentVersionId: input.contentVersionId,
      platform: input.platform,
      role: input.role,
      factIds: input.claimIds,
      visualBrief,
      visualBriefHash,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      providerId: FIXTURE_PROVIDER.providerId,
      providerMode: FIXTURE_PROVIDER.providerMode,
    });

    if (job.id !== proposedJobId) {
      const asset =
        job.state === "succeeded" && job.assetId !== null
          ? await this.#repository.getMediaAsset(context, job.assetId)
          : null;
      if (job.state === "succeeded" && asset === null) {
        throw new MediaProductionServiceError(
          "MEDIA_REPLAY_INCONSISTENT",
          409,
          "Succeeded media job has no immutable asset",
        );
      }
      return { capability: this.capability, job, asset, wasCreated: false };
    }

    const attemptId = this.#uuid();
    const attemptNo = job.attemptCount + 1;
    const startedAt = capturedAt.toISOString();
    let successfulAttemptRecorded = false;
    let failureStage:
      | "provider.generate"
      | "object_store.put"
      | "attempt.record"
      | "job.complete" = "provider.generate";
    let asset: MediaAssetView;
    try {
      const generated = await this.#provider.generate({ visualBrief, expectedInputHash });
      assertFixtureResult(generated, expectedInputHash);
      const outputSha256 = sha256Bytes(generated.bytes);
      failureStage = "object_store.put";
      const stored = await this.#objectStore.put({
        tenantId: context.tenantId,
        sha256: outputSha256,
        mimeType: generated.mimeType,
        bytes: generated.bytes,
      });
      if (stored.byteLength !== generated.bytes.byteLength) {
        throw new MediaProductionServiceError(
          "MEDIA_STORAGE_LENGTH_MISMATCH",
          502,
          "Stored media length does not match generated bytes",
        );
      }
      const finishedAt = this.#now().toISOString();
      const responseHash = sha256Canonical({
        providerId: generated.providerId,
        providerMode: generated.providerMode,
        model: generated.model,
        inputHash: generated.inputHash,
        outputSha256,
        mimeType: generated.mimeType,
        width: generated.width,
        height: generated.height,
        metadata: generated.metadata,
      });
      failureStage = "attempt.record";
      await this.#repository.recordMediaAttempt(context, {
        attemptId,
        jobId: job.id,
        attemptNo,
        status: "succeeded",
        providerId: generated.providerId,
        providerMode: generated.providerMode,
        model: generated.model,
        inputHash: generated.inputHash,
        requestHash,
        responseHash,
        outputSha256,
        providerRequestId: null,
        errorCode: null,
        errorMessage: null,
        startedAt,
        finishedAt,
      });
      successfulAttemptRecorded = true;

      const inspection = Object.freeze({
        assetSha256: outputSha256,
        status: "passed" as const,
        evaluator: "fixture-inspector",
        evaluatorMode: "fixture" as const,
        evaluatorVersion: "1.0.0",
        responseSha256: sha256Canonical({
          schemaVersion: "geo.fixture-inspection.v1",
          assetSha256: outputSha256,
          ocrText: "",
          labels: ["fixture", "deterministic", "network:false"],
        }),
        inspectedAt: finishedAt,
        ocrText: "",
        labels: ["fixture", "deterministic", "network:false"],
      });
      const assetId = this.#uuid();
      const reference = mediaReferenceSchema.parse({
        id: assetId,
        sha256: outputSha256,
        mimeType: generated.mimeType,
        byteLength: stored.byteLength,
        width: generated.width,
        height: generated.height,
        platform: input.platform,
        role: input.role,
        altText: visualBrief.altText,
        caption: visualBrief.caption,
        factIds: input.claimIds,
        visualBrief,
        visualBriefHash,
        rights: {
          basis: "generated_terms",
          licenseName: "Deterministic fixture generation terms",
          verifiedAt: finishedAt,
        },
        provenance: {
          kind: "generated",
          jobId: job.id,
          attemptId,
          provider: generated.providerId,
          providerMode: generated.providerMode,
          model: generated.model,
          promptHash: sha256Text(visualBrief.prompt),
          parametersHash: sha256Canonical({
            schemaVersion: "geo.fixture-image-parameters.v1",
            visualBriefHash,
            inputHash: generated.inputHash,
          }),
          generatedAt: finishedAt,
        },
        inspection,
      } satisfies MediaReference);
      const successorPayload = {
        ...source.payload,
        media: [...source.payload.media, reference],
      };
      failureStage = "job.complete";
      asset = await this.#repository.completeMediaJob(context, {
        jobId: job.id,
        attemptId,
        assetId,
        inspectionId: this.#uuid(),
        bindingId: this.#uuid(),
        successorContentVersionId: this.#uuid(),
        storageKey: stored.storageKey,
        reference,
        successorPayload,
        successorPayloadHash: sha256Canonical(successorPayload),
        completedAt: finishedAt,
      });
    } catch (error) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      console.error(
        JSON.stringify({
          level: "error",
          event: "geo_api.media_production_failed",
          tenantId: context.tenantId,
          jobId: job.id,
          contentVersionId: input.contentVersionId,
          stage: failureStage,
          errorType: error instanceof Error ? error.name : "UnknownError",
          ...(errorCode === undefined ? {} : { errorCode }),
        }),
      );
      const completedAt = this.#now().toISOString();
      if (!successfulAttemptRecorded) {
        await this.#repository
          .recordMediaAttempt(context, {
            attemptId,
            jobId: job.id,
            attemptNo,
            status: "failed",
            providerId: FIXTURE_PROVIDER.providerId,
            providerMode: FIXTURE_PROVIDER.providerMode,
            model: FIXTURE_PROVIDER.model,
            inputHash: expectedInputHash,
            requestHash,
            responseHash: null,
            outputSha256: null,
            providerRequestId: null,
            errorCode: "MEDIA_PRODUCTION_FAILED",
            errorMessage: failureMessage(),
            startedAt,
            finishedAt: completedAt,
          })
          .catch(() => undefined);
      }
      await this.#repository
        .failMediaJob(context, {
          jobId: job.id,
          errorCode: "MEDIA_PRODUCTION_FAILED",
          errorMessage: failureMessage(),
          completedAt,
        })
        .catch(() => undefined);
      throw new MediaProductionServiceError("MEDIA_PRODUCTION_FAILED", 502, failureMessage());
    }

    const completedJob = await this.#repository.getMediaJob(context, job.id);
    if (completedJob === null || completedJob.state !== "succeeded") {
      throw new MediaProductionServiceError(
        "MEDIA_COMPLETION_INCONSISTENT",
        500,
        "Completed media job could not be read back",
      );
    }
    return { capability: this.capability, job: completedJob, asset, wasCreated: true };
  }

  async status(context: RequestContext, jobId: string): Promise<MediaProductionStatus> {
    const job = await this.#repository.getMediaJob(context, jobId);
    if (job === null) {
      throw new MediaProductionServiceError("MEDIA_JOB_NOT_FOUND", 404, "Media job was not found");
    }
    const asset =
      job.state === "succeeded" && job.assetId !== null
        ? await this.#repository.getMediaAsset(context, job.assetId)
        : null;
    return { capability: this.capability, job, asset };
  }

  listAssets(
    context: RequestContext,
    contentVersionId: string,
  ): Promise<readonly MediaAssetView[]> {
    return this.#repository.listMediaAssets(context, contentVersionId);
  }
}
