import { createHash } from "node:crypto";

import {
  idSchema,
  mediaSearchPlanSchema,
  type MediaRole,
  type MediaSearchIntent,
} from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import {
  MediaProductionError,
  type LicensedImageCandidate,
  type LicensedImageSearchProvider,
} from "@geo/media";
import { z } from "zod";

import type { MediaImportController } from "./media-import-service.js";
import { MediaProductionServiceError } from "./media-production-service.js";
import type { ApiRepository, RequestContext } from "./repository.js";

const SEARCH_CANDIDATES_PER_INTENT = 12;

export const mediaSearchImportRequestSchema = z.strictObject({
  contentVersionId: idSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  maxImports: z.number().int().min(1).max(5).optional(),
});
export type MediaSearchImportRequest = z.infer<typeof mediaSearchImportRequestSchema>;

export interface MediaSearchImportItem {
  readonly intentIndex: number;
  readonly query: string;
  readonly role: MediaRole;
  readonly providerAssetId: string;
  readonly sourceUrl: string;
  readonly assetId: string;
  readonly contentVersionId: string;
}

export interface MediaSearchImportResult {
  readonly provider: "wikimedia_commons";
  readonly sourceContentVersionId: string;
  readonly finalContentVersionId: string;
  readonly plannedCount: number;
  readonly initialMediaCount: number;
  readonly totalMediaCount: number;
  readonly complete: boolean;
  readonly imported: readonly MediaSearchImportItem[];
  readonly rejectedCandidateCount: number;
  readonly rejectionCodes: readonly string[];
}

export interface MediaSearchImportController {
  request(
    context: RequestContext,
    input: MediaSearchImportRequest,
  ): Promise<MediaSearchImportResult>;
}

export type MediaSearchImportRepository = Pick<ApiRepository, "getContentVersion">;

function errorCode(error: unknown): string {
  if (error instanceof MediaProductionError || error instanceof MediaProductionServiceError) {
    return error.code;
  }
  return "MEDIA_SEARCH_CANDIDATE_FAILED";
}

function retryableCandidateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  if (candidate.retryable === true) return true;
  const status = candidate.statusCode ?? candidate.status;
  if (typeof status === "number" && (status >= 500 || [408, 409, 425, 429].includes(status))) {
    return true;
  }
  return (
    candidate.code === "MEDIA_INSPECTION_PROVIDER_FAILED" ||
    candidate.code === "MEDIA_INSPECTION_TIMEOUT" ||
    candidate.code === "MEDIA_SEARCH_DOWNLOAD_FAILED"
  );
}

function importKey(base: string, intentIndex: number, providerAssetId: string): string {
  return `media-search:${createHash("sha256")
    .update(
      sha256Canonical({ schemaVersion: "geo.media-search-import-key.v1", base, intentIndex, providerAssetId }),
    )
    .digest("hex")}`;
}

function orderedPlan(plan: readonly MediaSearchIntent[]): readonly MediaSearchIntent[] {
  return Object.freeze([
    ...plan.filter((intent) => intent.role === "cover"),
    ...plan.filter((intent) => intent.role === "inline"),
  ]);
}

function isResumableWikimediaMedia(
  media: Readonly<{
    platform: string;
    role: MediaRole;
    provenance: Readonly<{ kind: string; sourceUrl?: string }>;
    inspection: Readonly<{ status: string; evaluatorMode: string }>;
  }>,
  intent: MediaSearchIntent,
): boolean {
  if (
    media.platform !== "ctrip_community" ||
    media.role !== intent.role ||
    media.provenance.kind !== "licensed_stock" ||
    media.inspection.status !== "passed" ||
    media.inspection.evaluatorMode !== "live"
  ) {
    return false;
  }
  try {
    return new URL(media.provenance.sourceUrl ?? "").hostname === "commons.wikimedia.org";
  } catch {
    return false;
  }
}

export class MediaSearchImportService implements MediaSearchImportController {
  readonly #repository: MediaSearchImportRepository;
  readonly #provider: LicensedImageSearchProvider;
  readonly #mediaImport: MediaImportController;

  constructor(options: {
    readonly repository: MediaSearchImportRepository;
    readonly provider: LicensedImageSearchProvider;
    readonly mediaImport: MediaImportController;
  }) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#mediaImport = options.mediaImport;
  }

  async request(
    context: RequestContext,
    rawInput: MediaSearchImportRequest,
  ): Promise<MediaSearchImportResult> {
    const parsed = mediaSearchImportRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new MediaProductionServiceError("MEDIA_SEARCH_IMPORT_INVALID", 400, "Image search request is invalid", {
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;
    const source = await this.#repository.getContentVersion(context, input.contentVersionId);
    if (source === null) {
      throw new MediaProductionServiceError(
        "MEDIA_CONTENT_VERSION_NOT_FOUND",
        404,
        "Source content version was not found",
      );
    }
    const parsedPlan = mediaSearchPlanSchema.safeParse(source.payload.mediaSearchPlan);
    if (!parsedPlan.success) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_PLAN_REQUIRED",
        422,
        "Content version does not contain a valid four-to-five image search plan",
      );
    }
    const plan = orderedPlan(parsedPlan.data);
    const initialMediaCount = source.payload.media.length;
    if (
      initialMediaCount > plan.length ||
      source.payload.media.some((media, index) => {
        const intent = plan[index];
        return intent === undefined || !isResumableWikimediaMedia(media, intent);
      })
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_RESUME_INVALID",
        409,
        "Automated image search can resume only from a valid Wikimedia media prefix",
      );
    }

    let nextContentVersionId = source.id;
    const imported: MediaSearchImportItem[] = [];
    const rejectionCodes: string[] = [];
    const sectionContext = source.payload.bodyMarkdown.slice(0, 8_000);

    const importLimit = Math.min(input.maxImports ?? plan.length, plan.length - initialMediaCount);
    for (const [offset, intent] of plan.slice(initialMediaCount).entries()) {
      if (imported.length >= importLimit) break;
      const intentIndex = initialMediaCount + offset;
      let candidates: readonly LicensedImageCandidate[];
      try {
        candidates = await this.#provider.search({
          query: intent.query,
          limit: SEARCH_CANDIDATES_PER_INTENT,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw new MediaProductionServiceError(
          "MEDIA_SEARCH_PROVIDER_FAILED",
          502,
          "Licensed image search provider failed",
          { intentIndex, query: intent.query, upstreamCode: errorCode(error) },
        );
      }

      let accepted = false;
      let retryableFailureSeen = false;
      for (const candidate of candidates) {
        try {
          const normalized = await this.#provider.downloadAndNormalize({
            candidate,
            signal: AbortSignal.timeout(30_000),
          });
          const result = await this.#mediaImport.request(context, {
            contentVersionId: nextContentVersionId,
            platform: "ctrip_community",
            role: intent.role,
            claimIds: intent.claimIds,
            idempotencyKey: importKey(input.idempotencyKey, intentIndex, candidate.providerAssetId),
            bytesBase64: Buffer.from(normalized.bytes).toString("base64"),
            rights: {
              kind: "licensed_stock",
              basis: "commercial_license",
              sourceUrl: candidate.sourceUrl,
              licenseName: candidate.licenseName,
              licenseUrl: candidate.licenseUrl,
              attribution: candidate.attribution,
              rightsDescription: [
                "Wikimedia Commons licensed image selected by article keyword search.",
                normalized.modificationDescription,
              ].join(" "),
            },
            relevanceContext: {
              query: intent.query,
              rationale: intent.rationale,
              articleTitle: source.payload.title,
              sectionContext,
            },
            discovery: {
              kind: "licensed_search",
              provider: "wikimedia_commons",
              providerAssetId: candidate.providerAssetId,
              query: intent.query,
            },
          });
          if (result.asset === null) {
            throw new MediaProductionServiceError(
              "MEDIA_SEARCH_IMPORT_ASSET_MISSING",
              502,
              "Image import completed without an immutable asset",
            );
          }
          nextContentVersionId = result.asset.contentVersionId;
          imported.push(
            Object.freeze({
              intentIndex,
              query: intent.query,
              role: intent.role,
              providerAssetId: candidate.providerAssetId,
              sourceUrl: candidate.sourceUrl,
              assetId: result.asset.id,
              contentVersionId: nextContentVersionId,
            }),
          );
          accepted = true;
          break;
        } catch (error) {
          rejectionCodes.push(errorCode(error));
          retryableFailureSeen ||= retryableCandidateError(error);
        }
      }
      if (!accepted) {
        throw new MediaProductionServiceError(
          "MEDIA_SEARCH_INTENT_UNFILLED",
          retryableFailureSeen ? 503 : 422,
          "No licensed image passed relevance and media audit for one search intent",
          {
            intentIndex,
            query: intent.query,
            importedCount: imported.length,
            partialContentVersionId: nextContentVersionId,
            rejectionCodes: [...new Set(rejectionCodes)],
          },
        );
      }
    }

    return Object.freeze({
      provider: "wikimedia_commons" as const,
      sourceContentVersionId: source.id,
      finalContentVersionId: nextContentVersionId,
      plannedCount: plan.length,
      initialMediaCount,
      totalMediaCount: initialMediaCount + imported.length,
      complete: initialMediaCount + imported.length === plan.length,
      imported: Object.freeze(imported),
      rejectedCandidateCount: rejectionCodes.length,
      rejectionCodes: Object.freeze([...new Set(rejectionCodes)]),
    });
  }
}
