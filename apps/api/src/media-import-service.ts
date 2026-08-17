import { createHash, randomUUID } from "node:crypto";

import {
  CTRIP_COMMUNITY_PUBLICATION_LIMITS,
  idSchema,
  mediaReferenceSchema,
  mediaRightsBasisSchema,
  mediaRoleSchema,
  platformSchema,
  visualBriefSchema,
  type MediaReference,
} from "@geo/contracts";
import {
  buildVisualBrief,
  DEGRADED_MEDIA_INSPECTION_LABEL,
  mediaInspectionCanProceed,
  mediaSceneSignature,
  sha256Canonical,
  sha256Text,
} from "@geo/core";
import {
  inspectImportedImage,
  MAX_IMPORTED_IMAGE_BYTES,
  MediaProductionError,
  type MediaObjectStore,
} from "@geo/media";
import { z } from "zod";

import { MediaProductionServiceError } from "./media-production-service.js";
import type {
  MediaContentInspectionResult,
  MediaContentInspector,
} from "./media-inspection-gateway.js";
import type {
  ApiRepository,
  MediaAssetView,
  MediaGenerationJobView,
  RequestContext,
} from "./repository.js";

const CUSTOMER_UPLOAD_PROVIDER = "customer-upload";
const CUSTOMER_UPLOAD_MODEL = "direct-file-upload-v1";
const WIKIMEDIA_SEARCH_PROVIDER = "wikimedia-commons-search";
const WIKIMEDIA_SEARCH_MODEL = "mediawiki-api-v1";
const PEXELS_SEARCH_PROVIDER = "pexels-search";
const PEXELS_SEARCH_MODEL = "pexels-api-v1";
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMPORTED_IMAGE_BYTES / 3) * 4;
const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DEGRADED_INSPECTION_CODES = new Set([
  "MEDIA_INSPECTION_FAILED",
  "MEDIA_INSPECTION_PROVIDER_FAILED",
  "MEDIA_INSPECTION_TIMEOUT",
  "MEDIA_INSPECTION_UNAVAILABLE",
  "MEDIA_INSPECTION_RESPONSE_INVALID",
  "MEDIA_INSPECTION_RESPONSE_TOO_LARGE",
]);

const textSchema = (max: number) => z.string().trim().min(1).max(max);

const tenantOwnedRightsSchema = z.strictObject({
  kind: z.literal("tenant_owned"),
  ownershipAssertion: textSchema(2_000),
  licenseName: textSchema(500).default("Tenant-owned media"),
});

const licensedStockRightsSchema = z.strictObject({
  kind: z.literal("licensed_stock"),
  basis: mediaRightsBasisSchema.refine(
    (value) => value === "commercial_license" || value === "editorial_license",
    "Licensed stock requires a commercial or editorial license",
  ),
  sourceUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//iu)
    .max(2_048),
  licenseName: textSchema(500),
  licenseUrl: z
    .string()
    .trim()
    .url()
    .regex(/^https:\/\//iu)
    .max(2_048),
  attribution: textSchema(2_000).optional(),
  rightsDescription: textSchema(2_000),
});

const mediaRelevanceContextSchema = z.strictObject({
  query: textSchema(160),
  rationale: textSchema(500),
  articleTitle: textSchema(2_000),
  sectionContext: textSchema(8_000),
});

const mediaDiscoverySchema = z.strictObject({
  kind: z.literal("licensed_search"),
  provider: z.enum(["wikimedia_commons", "pexels"]),
  providerAssetId: textSchema(200),
  query: textSchema(160),
});

export const mediaImportRequestSchema = z.strictObject({
  contentVersionId: idSchema,
  platform: platformSchema,
  role: mediaRoleSchema,
  claimIds: z
    .array(idSchema)
    .max(3)
    .refine((values) => new Set(values).size === values.length, "Claim IDs must be unique"),
  idempotencyKey: textSchema(200),
  bytesBase64: z.string().min(4).max(MAX_BASE64_LENGTH),
  rights: z.discriminatedUnion("kind", [tenantOwnedRightsSchema, licensedStockRightsSchema]),
  relevanceContext: mediaRelevanceContextSchema.optional(),
  discovery: mediaDiscoverySchema.optional(),
});

export type MediaImportRequest = z.infer<typeof mediaImportRequestSchema>;

export interface MediaImportResult {
  readonly job: MediaGenerationJobView;
  readonly asset: MediaAssetView | null;
  readonly wasCreated: boolean;
  readonly contentInspectionRequired: true;
}

export interface MediaImportController {
  request(
    context: RequestContext,
    input: MediaImportRequest,
    options?: Readonly<{
      signal?: AbortSignal;
      trustedInspection?: MediaReference["inspection"];
    }>,
  ): Promise<MediaImportResult>;
}

export type MediaImportRepository = Pick<
  ApiRepository,
  | "getContentVersion"
  | "listFacts"
  | "listEvidenceSources"
  | "createEvidenceSource"
  | "createMediaJob"
  | "getMediaJob"
  | "recordMediaAttempt"
  | "completeMediaJob"
  | "failMediaJob"
  | "getMediaAsset"
>;

export interface MediaImportServiceOptions {
  readonly repository: MediaImportRepository;
  readonly objectStore: MediaObjectStore;
  readonly contentInspector?: MediaContentInspector;
  readonly reportFailure?: (failure: {
    readonly stage: string;
    readonly errorType: string;
    readonly errorCode: string | null;
  }) => void;
  readonly uuid?: () => string;
  readonly now?: () => Date;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function decodeBase64(value: string): Uint8Array {
  if (!STRICT_BASE64_PATTERN.test(value)) {
    throw new MediaProductionServiceError(
      "MEDIA_BASE64_INVALID",
      400,
      "Image bytes must use canonical base64 without a data URL or whitespace",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAX_IMPORTED_IMAGE_BYTES) {
    throw new MediaProductionServiceError(
      "MEDIA_BYTES_TOO_LARGE",
      413,
      "Image exceeds the 10 MiB import limit",
    );
  }
  return Uint8Array.from(bytes);
}

function mediaError(error: MediaProductionError): MediaProductionServiceError {
  const statusCode = error.code === "MEDIA_BYTES_TOO_LARGE" ? 413 : 422;
  return new MediaProductionServiceError(error.code, statusCode, error.message, error.details);
}

function inspectionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && DEGRADED_INSPECTION_CODES.has(code) ? code : null;
}

function degradedInspection(
  assetSha256: string,
  errorCode: string,
): Readonly<MediaContentInspectionResult> {
  return {
    assetSha256,
    status: "failed",
    evaluator: "pi-vision-inspector",
    evaluatorMode: "live",
    evaluatorVersion: "1.0.0",
    model: "vision-provider-unavailable",
    responseSha256: sha256Canonical({
      schemaVersion: "geo.degraded-media-inspection.v1",
      assetSha256,
      errorCode,
    }),
    providerRequestId: null,
    ocrText: "",
    labels: [
      DEGRADED_MEDIA_INSPECTION_LABEL,
      `vision-error:${errorCode.replace(/^MEDIA_INSPECTION_/u, "").toLocaleLowerCase("en-US")}`,
      "ocr:unavailable",
      "travel-relevance:unverified",
      "contact-text:unverified",
      "vision-confidence:unavailable",
      "safety:unverified",
      "scene-signature:unverified:unknown:unknown",
    ],
  };
}

export class MediaImportService implements MediaImportController {
  readonly #repository: MediaImportRepository;
  readonly #objectStore: MediaObjectStore;
  readonly #contentInspector: MediaContentInspector | undefined;
  readonly #reportFailure:
    | ((failure: {
        readonly stage: string;
        readonly errorType: string;
        readonly errorCode: string | null;
      }) => void)
    | undefined;
  readonly #uuid: () => string;
  readonly #now: () => Date;

  constructor(options: MediaImportServiceOptions) {
    this.#repository = options.repository;
    this.#objectStore = options.objectStore;
    this.#contentInspector = options.contentInspector;
    this.#reportFailure = options.reportFailure;
    this.#uuid = options.uuid ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async request(
    context: RequestContext,
    rawInput: MediaImportRequest,
    options?: Readonly<{
      signal?: AbortSignal;
      trustedInspection?: MediaReference["inspection"];
    }>,
  ): Promise<MediaImportResult> {
    const parsed = mediaImportRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new MediaProductionServiceError(
        "MEDIA_IMPORT_INVALID",
        400,
        "Media import is invalid",
        {
          issues: parsed.error.issues,
        },
      );
    }
    const input = parsed.data;
    const contentInspector = this.#contentInspector;
    if (contentInspector === undefined && options?.trustedInspection === undefined) {
      throw new MediaProductionServiceError(
        "MEDIA_CONTENT_INSPECTION_UNAVAILABLE",
        503,
        "Live image content inspection is unavailable",
      );
    }
    const sourceProvider =
      input.discovery === undefined
        ? CUSTOMER_UPLOAD_PROVIDER
        : input.discovery.provider === "wikimedia_commons"
          ? WIKIMEDIA_SEARCH_PROVIDER
          : PEXELS_SEARCH_PROVIDER;
    const sourceModel =
      input.discovery === undefined
        ? CUSTOMER_UPLOAD_MODEL
        : input.discovery.provider === "wikimedia_commons"
          ? WIKIMEDIA_SEARCH_MODEL
          : PEXELS_SEARCH_MODEL;
    const bytes = decodeBase64(input.bytesBase64);
    let image;
    try {
      image = inspectImportedImage(bytes);
    } catch (error) {
      if (error instanceof MediaProductionError) throw mediaError(error);
      throw error;
    }
    const outputSha256 = sha256Bytes(bytes);
    const capturedAt = this.#now();
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
        "Source content requires an editorial profile for media import",
      );
    }
    if (source.payload.media.some((media) => media.sha256 === outputSha256)) {
      throw new MediaProductionServiceError(
        "MEDIA_ASSET_DUPLICATE",
        422,
        "The same image bytes are already bound to this content version",
      );
    }
    const platformMedia = source.payload.media.filter((media) => media.platform === input.platform);
    if (
      input.platform === "ctrip_community" &&
      platformMedia.length >= CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxImages
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_COUNT_LIMIT",
        422,
        "Ctrip media already reached the five-image automation limit",
      );
    }
    if (
      input.platform === "ctrip_community" &&
      input.role === "cover" &&
      platformMedia.some((media) => media.role === "cover")
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_COVER_DUPLICATE",
        422,
        "Ctrip content can bind exactly one cover image",
      );
    }

    const availableFacts = await this.#repository.listFacts(context, { limit: 200 });
    const factsById = new Map(availableFacts.map((fact) => [fact.id, fact]));
    const claimsById = new Map(source.payload.claims.map((claim) => [claim.id, claim]));
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
          "Media import requires exact, current, verified source claims",
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

    const visualBrief = visualBriefSchema.parse(
      buildVisualBrief({
        editorialProfile: source.payload.editorialProfile,
        platform: input.platform,
        role: input.role,
        facts,
      }),
    );
    const visualBriefHash = sha256Canonical(visualBrief);
    const rightsRequestHash = sha256Canonical(input.rights);
    const requestHash = sha256Canonical({
      schemaVersion: "geo.media-import-request.v1",
      contentVersionId: input.contentVersionId,
      platform: input.platform,
      role: input.role,
      claimIds: input.claimIds,
      outputSha256,
      visualBriefHash,
      rightsRequestHash,
      relevanceContext: input.relevanceContext ?? null,
      discovery: input.discovery ?? null,
      providerId: sourceProvider,
      providerMode: "live",
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
      providerId: sourceProvider,
      providerMode: "live",
    });
    if (job.id !== proposedJobId && ["succeeded", "failed", "cancelled"].includes(job.state)) {
      const asset =
        job.state === "succeeded" && job.assetId !== null
          ? await this.#repository.getMediaAsset(context, job.assetId)
          : null;
      if (job.state === "succeeded" && asset === null) {
        throw new MediaProductionServiceError(
          "MEDIA_REPLAY_INCONSISTENT",
          409,
          "Succeeded media import has no immutable asset",
        );
      }
      return { job, asset, wasCreated: false, contentInspectionRequired: true };
    }

    const attemptId = this.#uuid();
    const attemptNo = job.attemptCount + 1;
    const startedAt = capturedAt.toISOString();
    let successfulAttemptRecorded = false;
    let failureStage = "content_inspection";
    try {
      const trustedInspection = options?.trustedInspection;
      if (
        trustedInspection !== undefined &&
        (trustedInspection.assetSha256 !== outputSha256 ||
          !mediaInspectionCanProceed(trustedInspection) ||
          trustedInspection.evaluatorMode !== "live")
      ) {
        throw new MediaProductionServiceError(
          "MEDIA_TRUSTED_INSPECTION_INVALID",
          422,
          "Reusable inspection evidence does not match the imported bytes",
        );
      }
      let contentInspection:
        Readonly<MediaContentInspectionResult> | MediaReference["inspection"] | undefined =
        trustedInspection;
      if (contentInspection === undefined) {
        if (contentInspector === undefined) {
          throw new MediaProductionServiceError(
            "MEDIA_CONTENT_INSPECTION_UNAVAILABLE",
            503,
            "Live image content inspection is unavailable",
          );
        }
        try {
          contentInspection = await contentInspector.inspect(
            {
              tenantId: context.tenantId,
              assetSha256: outputSha256,
              mimeType: image.mimeType,
              bytesBase64: input.bytesBase64,
              platform: input.platform,
              role: input.role,
              ...(input.relevanceContext === undefined
                ? {}
                : { relevanceContext: input.relevanceContext }),
            },
            options?.signal,
          );
        } catch (error) {
          const code = inspectionErrorCode(error);
          if (code === null || options?.signal?.aborted) throw error;
          contentInspection = degradedInspection(outputSha256, code);
        }
      }
      if (contentInspection.assetSha256 !== outputSha256) {
        throw new MediaProductionServiceError(
          "MEDIA_CONTENT_INSPECTION_EVIDENCE_INVALID",
          422,
          "Image content inspection evidence belongs to different media bytes",
          { labels: contentInspection.labels },
        );
      }
      const inspectionLabels = [...new Set(contentInspection.labels)];
      if (contentInspection.status !== "passed") {
        inspectionLabels.push(DEGRADED_MEDIA_INSPECTION_LABEL);
      }
      if (input.platform === "ctrip_community") {
        const sceneSignature = mediaSceneSignature(inspectionLabels);
        if (sceneSignature === null) {
          if (contentInspection.status === "passed") {
            throw new MediaProductionServiceError(
              "MEDIA_SCENE_SIGNATURE_REQUIRED",
              422,
              "Ctrip image inspection did not return a usable scene signature",
            );
          }
          inspectionLabels.push("scene-signature:unverified:unknown:unknown");
        }
      }
      failureStage = "rights_evidence";
      const existingEvidence = (await this.#repository.listEvidenceSources(context)).find(
        (evidence) =>
          evidence.metadata.mediaSha256 === outputSha256 &&
          evidence.metadata.purpose === "media-rights" &&
          evidence.metadata.rightsRequestHash === rightsRequestHash,
      );
      let evidenceSourceId: string;
      if (existingEvidence === undefined) {
        const proposedEvidenceSourceId = this.#uuid();
        const rightsContent =
          input.rights.kind === "tenant_owned"
            ? [
                `Media SHA-256: ${outputSha256}`,
                `Ownership assertion: ${input.rights.ownershipAssertion}`,
                `License name: ${input.rights.licenseName}`,
              ].join("\n")
            : [
                `Media SHA-256: ${outputSha256}`,
                `Source URL: ${input.rights.sourceUrl}`,
                `License name: ${input.rights.licenseName}`,
                `License URL: ${input.rights.licenseUrl}`,
                ...(input.rights.attribution === undefined
                  ? []
                  : [`Attribution: ${input.rights.attribution}`]),
                `Rights description: ${input.rights.rightsDescription}`,
                ...(input.relevanceContext === undefined
                  ? []
                  : [
                      `Search query: ${input.relevanceContext.query}`,
                      `Image intent: ${input.relevanceContext.rationale}`,
                    ]),
              ].join("\n");
        const createdEvidence = await this.#repository.createEvidenceSource(context, {
          id: proposedEvidenceSourceId,
          type: input.rights.kind === "tenant_owned" ? "manual" : "url",
          title:
            input.rights.kind === "tenant_owned"
              ? `Media ownership assertion ${outputSha256.slice(0, 12)}`
              : `Media license evidence ${outputSha256.slice(0, 12)}`,
          sourceUrl: input.rights.kind === "licensed_stock" ? input.rights.sourceUrl : null,
          contentHash: sha256Text(rightsContent),
          content: rightsContent,
          capturedAt: startedAt,
          validUntil: null,
          metadata: {
            purpose: "media-rights",
            mediaSha256: outputSha256,
            rightsKind: input.rights.kind,
            rightsRequestHash,
            ...(input.relevanceContext === undefined
              ? {}
              : {
                  mediaSearchQueryHash: sha256Text(input.relevanceContext.query),
                  mediaSearchIntentHash: sha256Canonical(input.relevanceContext),
                }),
            ...(input.discovery === undefined
              ? {}
              : {
                  mediaDiscoveryProvider: input.discovery.provider,
                  mediaDiscoveryAssetId: input.discovery.providerAssetId,
                }),
          },
        });
        evidenceSourceId = createdEvidence.id;
      } else {
        evidenceSourceId = existingEvidence.id;
      }

      failureStage = "object_storage";
      const stored = await this.#objectStore.put({
        tenantId: context.tenantId,
        sha256: outputSha256,
        mimeType: image.mimeType,
        bytes,
      });
      if (stored.byteLength !== bytes.byteLength) {
        throw new MediaProductionServiceError(
          "MEDIA_STORAGE_LENGTH_MISMATCH",
          502,
          "Stored media length does not match imported bytes",
        );
      }
      const finishedAt = this.#now().toISOString();
      const responseHash = sha256Canonical({
        providerId: sourceProvider,
        providerMode: "live",
        model: sourceModel,
        outputSha256,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        storageKey: stored.storageKey,
      });
      failureStage = "attempt_record";
      await this.#repository.recordMediaAttempt(context, {
        attemptId,
        jobId: job.id,
        attemptNo,
        status: "succeeded",
        providerId: sourceProvider,
        providerMode: "live",
        model: sourceModel,
        inputHash: outputSha256,
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

      const structuralLabels = [
        `format:${image.mimeType}`,
        "byte-integrity:verified",
        "dimensions:verified",
        ...(trustedInspection === undefined ? [] : ["inspection-reuse:preverified"]),
      ];
      const finalInspectionLabels = [...new Set([...structuralLabels, ...inspectionLabels])];
      const inspection = Object.freeze({
        assetSha256: outputSha256,
        status: contentInspection.status,
        evaluator: contentInspection.evaluator,
        evaluatorMode: contentInspection.evaluatorMode,
        evaluatorVersion: contentInspection.evaluatorVersion,
        responseSha256: contentInspection.responseSha256,
        inspectedAt: trustedInspection?.inspectedAt ?? finishedAt,
        ocrText: contentInspection.ocrText,
        labels: finalInspectionLabels,
      });
      const provenance =
        input.rights.kind === "tenant_owned"
          ? ({
              kind: "tenant_owned" as const,
              evidenceSourceId,
              ownershipAssertion: input.rights.ownershipAssertion,
            } as const)
          : ({
              kind: "licensed_stock" as const,
              evidenceSourceId,
              sourceUrl: input.rights.sourceUrl,
            } as const);
      const rights =
        input.rights.kind === "tenant_owned"
          ? ({
              basis: "tenant_owned" as const,
              licenseName: input.rights.licenseName,
              verifiedAt: finishedAt,
            } as const)
          : ({
              basis: input.rights.basis,
              licenseName: input.rights.licenseName,
              licenseUrl: input.rights.licenseUrl,
              ...(input.rights.attribution === undefined
                ? {}
                : { attribution: input.rights.attribution }),
              verifiedAt: finishedAt,
            } as const);
      const assetId = this.#uuid();
      failureStage = "reference_validation";
      const reference = mediaReferenceSchema.parse({
        id: assetId,
        sha256: outputSha256,
        mimeType: image.mimeType,
        byteLength: stored.byteLength,
        width: image.width,
        height: image.height,
        platform: input.platform,
        role: input.role,
        altText: visualBrief.altText,
        caption: visualBrief.caption,
        factIds: input.claimIds,
        visualBrief,
        visualBriefHash,
        rights,
        provenance,
        inspection,
      } satisfies MediaReference);
      const successorPayload = { ...source.payload, media: [...source.payload.media, reference] };
      failureStage = "completion";
      const asset = await this.#repository.completeMediaJob(context, {
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
      failureStage = "readback";
      const completedJob = await this.#repository.getMediaJob(context, job.id);
      if (completedJob === null || completedJob.state !== "succeeded") {
        throw new MediaProductionServiceError(
          "MEDIA_COMPLETION_INCONSISTENT",
          500,
          "Completed media import could not be read back",
        );
      }
      return { job: completedJob, asset, wasCreated: true, contentInspectionRequired: true };
    } catch (error) {
      this.#reportFailure?.({
        stage: failureStage,
        errorType: error instanceof Error ? error.name : "UnknownError",
        errorCode:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null,
      });
      const completedAt = this.#now().toISOString();
      if (!successfulAttemptRecorded) {
        await this.#repository
          .recordMediaAttempt(context, {
            attemptId,
            jobId: job.id,
            attemptNo,
            status: "failed",
            providerId: sourceProvider,
            providerMode: "live",
            model: sourceModel,
            inputHash: outputSha256,
            requestHash,
            responseHash: null,
            outputSha256: null,
            providerRequestId: null,
            errorCode: "MEDIA_IMPORT_FAILED",
            errorMessage: "Customer media import failed",
            startedAt,
            finishedAt: completedAt,
          })
          .catch(() => undefined);
      }
      await this.#repository
        .failMediaJob(context, {
          jobId: job.id,
          errorCode: "MEDIA_IMPORT_FAILED",
          errorMessage: "Customer media import failed",
          completedAt,
        })
        .catch(() => undefined);
      if (error instanceof MediaProductionServiceError) throw error;
      throw new MediaProductionServiceError(
        "MEDIA_IMPORT_FAILED",
        502,
        "Customer media import failed",
      );
    }
  }
}
