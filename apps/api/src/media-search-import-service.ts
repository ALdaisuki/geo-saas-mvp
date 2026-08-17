import { createHash } from "node:crypto";

import {
  CTRIP_COMMUNITY_PUBLICATION_LIMITS,
  idSchema,
  mediaSearchPlanSchema,
  platformSchema,
  type MediaReference,
  type MediaRole,
  type MediaSearchIntent,
  type Platform,
} from "@geo/contracts";
import {
  MANUAL_MEDIA_REVIEW_LABEL,
  markdownHeadingSections,
  mediaInspectionCanProceed,
  platformMediaAspectRatio,
  sha256Canonical,
} from "@geo/core";
import {
  MediaProductionError,
  licensedImageRenditionDimensions,
  type LicensedImageCandidate,
  type LicensedImageSearchProvider,
  type LicensedImageSearchProviderId,
  type MediaObjectStore,
  type NormalizedLicensedImage,
} from "@geo/media";
import { z } from "zod";

import type { MediaImportController } from "./media-import-service.js";
import { MediaProductionServiceError } from "./media-production-service.js";
import { mediaRequiresManualReview } from "./manual-media-review.js";
import type { ApiRepository, RequestContext } from "./repository.js";

const SEARCH_CANDIDATES_PER_INTENT = 8;
const MEDIA_SEARCH_IMPORT_TIMEOUT_MS = 170_000;
const MEDIA_SEARCH_PROVIDER_TIMEOUT_MS = 10_000;

function canReuseCachedInspection(inspection: Readonly<MediaReference["inspection"]>): boolean {
  return (
    inspection.status === "passed" &&
    inspection.evaluatorMode === "live" &&
    (inspection.evaluator === "pi-vision-inspector" ||
      inspection.evaluator === "no-vision-pass-through") &&
    !inspection.labels.includes(MANUAL_MEDIA_REVIEW_LABEL)
  );
}

export const mediaSearchImportRequestSchema = z.strictObject({
  contentVersionId: idSchema,
  platform: platformSchema,
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
  readonly provider: LicensedImageSearchProviderId;
  readonly sourceContentVersionId: string;
  readonly finalContentVersionId: string;
  readonly plannedCount: number;
  readonly initialMediaCount: number;
  readonly totalMediaCount: number;
  readonly complete: boolean;
  /** True when the final immutable content version needs an operator decision before publishing. */
  readonly manualReviewRequired: boolean;
  readonly imported: readonly MediaSearchImportItem[];
  readonly rejectedCandidateCount: number;
  readonly rejectionCodes: readonly string[];
}

export interface MediaSearchImportController {
  readonly provider: LicensedImageSearchProviderId;
  request(
    context: RequestContext,
    input: MediaSearchImportRequest,
  ): Promise<MediaSearchImportResult>;
}

export type MediaSearchImportRepository = Pick<
  ApiRepository,
  "getContentVersion" | "listSubmittedMediaHistory"
> &
  Partial<Pick<ApiRepository, "getMediaAsset" | "listContent">>;

interface CachedLicensedImageCandidate {
  readonly candidate: LicensedImageCandidate;
  readonly sha256: string;
  readonly storageKey: string;
  readonly inspection: MediaReference["inspection"];
  readonly rightsBasis: "commercial_license" | "editorial_license";
  readonly width: number;
  readonly height: number;
}

const CACHE_CONTENT_LIMIT = 100;
const CACHE_QUERY_STOP_WORDS = new Set([
  "city",
  "exterior",
  "image",
  "japan",
  "japanese",
  "landscape",
  "panorama",
  "photo",
  "scene",
  "travel",
  "view",
]);

function errorCode(error: unknown): string {
  if (error instanceof MediaProductionError || error instanceof MediaProductionServiceError) {
    return error.code;
  }
  return "MEDIA_SEARCH_CANDIDATE_FAILED";
}

function retryAfterMsForError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, 5_000);
}

function waitBeforeRetry(
  attempt: number,
  signal: AbortSignal,
  retryAfterMs?: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(5_000, retryAfterMs ?? 250 * 2 ** attempt),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryableCandidateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly details?: { readonly status?: unknown; readonly statusCode?: unknown };
  };
  if (candidate.retryable === true) return true;
  const status =
    candidate.statusCode ??
    candidate.status ??
    candidate.details?.statusCode ??
    candidate.details?.status;
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
      sha256Canonical({
        schemaVersion: "geo.media-search-import-key.v1",
        base,
        intentIndex,
        providerAssetId,
      }),
    )
    .digest("hex")}`;
}

function orderedPlan(plan: readonly MediaSearchIntent[]): readonly MediaSearchIntent[] {
  return Object.freeze([
    ...plan.filter((intent) => intent.role === "cover"),
    ...plan.filter((intent) => intent.role === "inline"),
  ]);
}

function isResumableLicensedMedia(
  media: Readonly<{
    platform: string;
    role: MediaRole;
    provenance: Readonly<{ kind: string; sourceUrl?: string }>;
    inspection: Readonly<{ status: string; evaluatorMode: string; labels: readonly string[] }>;
  }>,
  intent: MediaSearchIntent,
  provider: LicensedImageSearchProviderId,
  platform: Platform,
): boolean {
  if (
    media.platform !== platform ||
    media.role !== intent.role ||
    media.provenance.kind !== "licensed_stock" ||
    !mediaInspectionCanProceed(media.inspection) ||
    media.inspection.evaluatorMode !== "live"
  ) {
    return false;
  }
  try {
    const hostname = new URL(media.provenance.sourceUrl ?? "").hostname;
    return provider === "wikimedia_commons"
      ? hostname === "commons.wikimedia.org"
      : hostname === "www.pexels.com";
  } catch {
    return false;
  }
}

function providerSourceHost(provider: LicensedImageSearchProviderId): string {
  return provider === "wikimedia_commons" ? "commons.wikimedia.org" : "www.pexels.com";
}

function canonicalSourceUrl(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function sourceTitle(sourceUrl: string): string {
  try {
    const path = decodeURIComponent(new URL(sourceUrl).pathname);
    return (path.split("/").at(-1) ?? path)
      .replace(/^File:/iu, "")
      .replace(/[-_]+/gu, " ")
      .trim();
  } catch {
    return "";
  }
}

function queryTokens(query: string): readonly string[] {
  return [
    ...new Set(
      query
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .match(/[a-z0-9]+/gu)
        ?.filter((token) => token.length >= 3 && !CACHE_QUERY_STOP_WORDS.has(token)) ?? [],
    ),
  ];
}

function cachedCandidateScore(candidate: LicensedImageCandidate, query: string): number {
  const haystack = [candidate.title, candidate.description]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const matches = queryTokens(query).filter((token) => haystack.includes(token));
  if (matches.length === 0) return 0;
  return matches.reduce((score, token) => score + Math.min(token.length, 12), 0);
}

function normalizedSectionLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/^(?:[一二三四五六七八九十]+|[0-9]+)[、.．:：)）-]*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function mediaIntentSectionContext(bodyMarkdown: string, intent: MediaSearchIntent): string {
  const fallback = bodyMarkdown.slice(0, 8_000);
  if (intent.role === "cover") return fallback;

  const sectionRef =
    intent.sectionRef === undefined ? "" : normalizedSectionLabel(intent.sectionRef);
  const intentText = normalizedSectionLabel(`${intent.rationale} ${intent.query}`);
  const matchingSection = markdownHeadingSections(bodyMarkdown).find((section) => {
    if (section.heading === null) return false;
    const heading = normalizedSectionLabel(section.heading);
    if (heading.length < 2) return false;
    if (sectionRef.length >= 2) {
      return heading.includes(sectionRef) || sectionRef.includes(heading);
    }
    return intentText.includes(heading);
  });
  return (matchingSection?.markdown ?? fallback).slice(0, 8_000);
}

function mediaSearchQueries(
  locationQuery: string | undefined,
  intent: MediaSearchIntent,
): readonly string[] {
  const values = [
    intent.query.trim(),
    ...(intent.fallbackQueries ?? []).map((query) => query.trim()),
  ];
  const location = locationQuery?.trim() ?? "";
  if (location.length > 0 && !intent.query.includes(location)) {
    values.push(`${location} ${intent.query}`.trim());
  }
  const englishTokens =
    intent.query
      .match(/[A-Za-z][A-Za-z0-9 ._-]{2,}/gu)
      ?.join(" ")
      .trim() ?? "";
  if (englishTokens.length > 0 && englishTokens !== intent.query.trim()) values.push(englishTokens);
  return Object.freeze([...new Set(values.filter((value) => value.length > 0))]);
}

export class MediaSearchImportService implements MediaSearchImportController {
  readonly #repository: MediaSearchImportRepository;
  readonly #provider: LicensedImageSearchProvider;
  readonly #mediaImport: MediaImportController;
  readonly #objectStore: Pick<MediaObjectStore, "get"> | undefined;

  get provider(): LicensedImageSearchProviderId {
    return this.#provider.provider;
  }

  constructor(options: {
    readonly repository: MediaSearchImportRepository;
    readonly provider: LicensedImageSearchProvider;
    readonly mediaImport: MediaImportController;
    readonly objectStore?: Pick<MediaObjectStore, "get">;
  }) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#mediaImport = options.mediaImport;
    this.#objectStore = options.objectStore;
  }

  async #cachedCandidates(
    context: RequestContext,
    query: string,
    excludedSha256: ReadonlySet<string>,
    excludedSourceUrls: ReadonlySet<string>,
    limit: number,
    includeGeneric: boolean,
    targetWidth: number,
    targetHeight: number,
  ): Promise<readonly CachedLicensedImageCandidate[]> {
    const listContent = this.#repository.listContent;
    const getMediaAsset = this.#repository.getMediaAsset;
    if (
      this.#objectStore === undefined ||
      listContent === undefined ||
      getMediaAsset === undefined
    ) {
      return [];
    }

    const content = await listContent.call(this.#repository, context);
    const versions = await Promise.all(
      content
        .slice(0, CACHE_CONTENT_LIMIT)
        .map(async (item) =>
          item.latestVersionId === null
            ? null
            : this.#repository.getContentVersion(context, item.latestVersionId),
        ),
    );
    const references = versions.flatMap((version) => version?.payload.media ?? []);
    const seenSha256 = new Set(excludedSha256);
    const scored = references.flatMap((reference) => {
      const rights = reference.rights;
      const canonicalUrl =
        reference.provenance.kind === "licensed_stock"
          ? canonicalSourceUrl(reference.provenance.sourceUrl)
          : null;
      if (
        seenSha256.has(reference.sha256) ||
        (canonicalUrl !== null && excludedSourceUrls.has(canonicalUrl)) ||
        reference.mimeType !== "image/jpeg" ||
        reference.width !== targetWidth ||
        reference.height !== targetHeight ||
        reference.provenance.kind !== "licensed_stock" ||
        !mediaInspectionCanProceed(reference.inspection) ||
        reference.inspection.evaluatorMode !== "live" ||
        (rights.basis !== "commercial_license" && rights.basis !== "editorial_license") ||
        !("licenseUrl" in rights) ||
        rights.licenseUrl === undefined
      ) {
        return [];
      }
      let sourceUrl: URL;
      try {
        sourceUrl = new URL(reference.provenance.sourceUrl);
      } catch {
        return [];
      }
      if (
        sourceUrl.protocol !== "https:" ||
        sourceUrl.hostname !== providerSourceHost(this.#provider.provider)
      ) {
        return [];
      }
      const candidate: LicensedImageCandidate = {
        provider: this.#provider.provider,
        providerAssetId: `cache-${reference.sha256}`,
        searchQuery: query,
        title: sourceTitle(reference.provenance.sourceUrl),
        description: [reference.altText, reference.caption, ...reference.inspection.labels].join(
          " ",
        ),
        creator: rights.attribution ?? rights.licenseName,
        sourceUrl: reference.provenance.sourceUrl,
        downloadUrl: reference.provenance.sourceUrl,
        licenseName: rights.licenseName,
        licenseUrl: rights.licenseUrl,
        attribution: rights.attribution ?? rights.licenseName,
        sourceWidth: reference.width,
        sourceHeight: reference.height,
        mimeType: reference.mimeType,
      };
      const score = cachedCandidateScore(candidate, query);
      if (score === 0 && !includeGeneric) return [];
      seenSha256.add(reference.sha256);
      return [{ assetId: reference.id, candidate, score, sha256: reference.sha256 }];
    });
    scored.sort(
      (left, right) => right.score - left.score || left.sha256.localeCompare(right.sha256),
    );

    const selected = await Promise.all(
      scored.slice(0, limit).map(async (entry) => {
        const asset = await getMediaAsset.call(this.#repository, context, entry.assetId);
        if (
          asset === null ||
          asset.reference.sha256 !== entry.sha256 ||
          asset.reference.provenance.kind !== "licensed_stock"
        ) {
          return null;
        }
        return {
          candidate: entry.candidate,
          sha256: entry.sha256,
          storageKey: asset.storageKey,
          inspection: asset.reference.inspection,
          rightsBasis: asset.reference.rights.basis as "commercial_license" | "editorial_license",
          width: asset.reference.width,
          height: asset.reference.height,
        } satisfies CachedLicensedImageCandidate;
      }),
    );
    return selected.filter((candidate) => candidate !== null);
  }

  async #loadCachedCandidate(
    context: RequestContext,
    cached: CachedLicensedImageCandidate,
  ): Promise<NormalizedLicensedImage> {
    const objectStore = this.#objectStore;
    if (objectStore === undefined) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_CACHE_UNAVAILABLE",
        "Licensed media cache is unavailable",
      );
    }
    const bytes = await objectStore.get({
      tenantId: context.tenantId,
      storageKey: cached.storageKey,
    });
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== cached.sha256) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_CACHE_CORRUPT",
        "Cached media does not match its immutable SHA-256",
      );
    }
    return {
      bytes,
      mimeType: "image/jpeg",
      width: cached.width,
      height: cached.height,
      modificationDescription: `Reused an immutable licensed ${cached.width}x${cached.height} tenant media object after a fresh relevance inspection.`,
    };
  }

  async request(
    context: RequestContext,
    rawInput: MediaSearchImportRequest,
  ): Promise<MediaSearchImportResult> {
    const parsed = mediaSearchImportRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_IMPORT_INVALID",
        400,
        "Image search request is invalid",
        {
          issues: parsed.error.issues,
        },
      );
    }
    const input = parsed.data;
    const aspectRatio = platformMediaAspectRatio(input.platform);
    const targetDimensions = licensedImageRenditionDimensions(aspectRatio);
    const budgetSignal = AbortSignal.timeout(MEDIA_SEARCH_IMPORT_TIMEOUT_MS);
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
    if (source.payload.media.some((media) => !platformSchema.safeParse(media.platform).success)) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_RESUME_INVALID",
        409,
        "Automated image search can resume only from valid platform media",
      );
    }
    const platformMedia = source.payload.media.filter((media) => media.platform === input.platform);
    const initialMediaCount = platformMedia.length;
    if (
      initialMediaCount > plan.length ||
      platformMedia.some((media, index) => {
        const intent = plan[index];
        return (
          intent === undefined ||
          !isResumableLicensedMedia(media, intent, this.#provider.provider, input.platform)
        );
      })
    ) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_RESUME_INVALID",
        409,
        "Automated image search can resume only from a valid configured-provider media prefix",
      );
    }

    const submittedMediaHistory = await this.#repository.listSubmittedMediaHistory(context);
    const submittedSha256 = new Set(submittedMediaHistory.map((item) => item.sha256));
    const submittedSourceUrls = new Set(
      submittedMediaHistory.flatMap((item) => {
        const sourceUrl = item.sourceUrl === null ? null : canonicalSourceUrl(item.sourceUrl);
        return sourceUrl === null ? [] : [sourceUrl];
      }),
    );

    let nextContentVersionId = source.id;
    const imported: MediaSearchImportItem[] = [];
    const rejectionCodes: string[] = [];
    const selectedSha256 = new Set([
      ...submittedSha256,
      ...source.payload.media.map((media) => media.sha256),
    ]);
    const importLimit = Math.min(input.maxImports ?? plan.length, plan.length - initialMediaCount);
    for (const [offset, intent] of plan.slice(initialMediaCount).entries()) {
      if (imported.length >= importLimit) break;
      const intentIndex = initialMediaCount + offset;
      let accepted = false;
      let retryableFailureSeen = false;
      let providerSearchError: unknown;
      const tryCandidates = async (
        candidateSet: readonly LicensedImageCandidate[],
        cachedByAssetId: ReadonlyMap<string, CachedLicensedImageCandidate>,
      ): Promise<void> => {
        for (const candidate of candidateSet) {
          if (budgetSignal.aborted && !candidate.providerAssetId.startsWith("cache-")) break;
          const sourceUrl = canonicalSourceUrl(candidate.sourceUrl);
          if (sourceUrl !== null && submittedSourceUrls.has(sourceUrl)) {
            rejectionCodes.push("MEDIA_SEARCH_HISTORY_SOURCE_REUSED");
            continue;
          }
          try {
            const cached = cachedByAssetId.get(candidate.providerAssetId);
            const normalized =
              cached === undefined
                ? await this.#provider.downloadAndNormalize({
                    candidate,
                    aspectRatio,
                    signal: AbortSignal.any([
                      budgetSignal,
                      AbortSignal.timeout(MEDIA_SEARCH_PROVIDER_TIMEOUT_MS),
                    ]),
                  })
                : await this.#loadCachedCandidate(context, cached);
            const normalizedSha256 = createHash("sha256").update(normalized.bytes).digest("hex");
            if (selectedSha256.has(normalizedSha256)) {
              rejectionCodes.push(
                submittedSha256.has(normalizedSha256)
                  ? "MEDIA_SEARCH_HISTORY_SHA256_REUSED"
                  : "MEDIA_SEARCH_SHA256_DUPLICATE",
              );
              continue;
            }
            const trustedInspection =
              cached !== undefined && canReuseCachedInspection(cached.inspection)
                ? cached.inspection
                : undefined;
            const result = await this.#mediaImport.request(
              context,
              {
                contentVersionId: nextContentVersionId,
                platform: input.platform,
                role: intent.role,
                claimIds: intent.claimIds,
                idempotencyKey: importKey(
                  input.idempotencyKey,
                  intentIndex,
                  candidate.providerAssetId,
                ),
                bytesBase64: Buffer.from(normalized.bytes).toString("base64"),
                rights: {
                  kind: "licensed_stock",
                  basis: cached?.rightsBasis ?? "commercial_license",
                  sourceUrl: candidate.sourceUrl,
                  licenseName: candidate.licenseName,
                  licenseUrl: candidate.licenseUrl,
                  attribution: candidate.attribution,
                  rightsDescription: [
                    candidate.provider === "wikimedia_commons"
                      ? "Wikimedia Commons licensed image selected by article keyword search."
                      : "Pexels licensed image selected by article keyword search.",
                    normalized.modificationDescription,
                  ].join(" "),
                },
                relevanceContext: {
                  query: intent.query,
                  rationale: intent.rationale,
                  articleTitle: source.payload.title,
                  sectionContext: mediaIntentSectionContext(source.payload.bodyMarkdown, intent),
                },
                discovery: {
                  kind: "licensed_search",
                  provider: candidate.provider,
                  providerAssetId: candidate.providerAssetId,
                  query: intent.query,
                },
              },
              trustedInspection === undefined ? { signal: budgetSignal } : { trustedInspection },
            );
            if (result.asset === null) {
              throw new MediaProductionServiceError(
                "MEDIA_SEARCH_IMPORT_ASSET_MISSING",
                502,
                "Image import completed without an immutable asset",
              );
            }
            nextContentVersionId = result.asset.contentVersionId;
            selectedSha256.add(result.asset.reference.sha256);
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
            return;
          } catch (error) {
            rejectionCodes.push(errorCode(error));
            retryableFailureSeen ||= retryableCandidateError(error);
          }
        }
      };

      const retryBudget = intent.retryBudget ?? 1;
      for (const searchQuery of mediaSearchQueries(source.payload.locationQuery, intent)) {
        let candidates: readonly LicensedImageCandidate[] = [];
        let searchError: unknown;
        for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
          if (budgetSignal.aborted) break;
          try {
            candidates = await this.#provider.search({
              query: searchQuery,
              limit: SEARCH_CANDIDATES_PER_INTENT,
              signal: AbortSignal.any([
                budgetSignal,
                AbortSignal.timeout(MEDIA_SEARCH_PROVIDER_TIMEOUT_MS),
              ]),
            });
            break;
          } catch (error) {
            searchError = error;
            retryableFailureSeen ||= retryableCandidateError(error);
            if (attempt < retryBudget && retryableCandidateError(error) && !budgetSignal.aborted) {
              await waitBeforeRetry(attempt, budgetSignal, retryAfterMsForError(error));
            }
          }
        }
        providerSearchError = searchError;
        if (candidates.some((candidate) => candidate.provider !== this.#provider.provider)) {
          throw new MediaProductionServiceError(
            "MEDIA_SEARCH_PROVIDER_MISMATCH",
            502,
            "Licensed image search returned a candidate from a different provider",
            {
              intentIndex,
              query: searchQuery,
              ...(intent.sectionRef === undefined ? {} : { sectionRef: intent.sectionRef }),
            },
          );
        }
        await tryCandidates(candidates, new Map());
        if (accepted) break;
        const cached = await this.#cachedCandidates(
          context,
          searchQuery,
          selectedSha256,
          submittedSourceUrls,
          SEARCH_CANDIDATES_PER_INTENT,
          true,
          targetDimensions.width,
          targetDimensions.height,
        );
        const cachedByAssetId = new Map(
          cached.map((item) => [item.candidate.providerAssetId, item] as const),
        );
        await tryCandidates(
          cached.map((item) => item.candidate),
          cachedByAssetId,
        );
        if (accepted) break;
        if (!budgetSignal.aborted && providerSearchError !== undefined && cached.length === 0) {
          rejectionCodes.push(`MEDIA_SEARCH_PROVIDER_FAILED:${errorCode(providerSearchError)}`);
        }
      }
      if (!accepted) {
        const totalMediaCount = initialMediaCount + imported.length;
        if (totalMediaCount >= CTRIP_COMMUNITY_PUBLICATION_LIMITS.minImages) break;
        if (budgetSignal.aborted) {
          throw new MediaProductionServiceError(
            "MEDIA_SEARCH_FALLBACK_UNAVAILABLE",
            503,
            "Image search exceeded its budget and no preverified fallback image was available",
            { partialContentVersionId: nextContentVersionId, importedCount: imported.length },
          );
        }
        throw new MediaProductionServiceError(
          "MEDIA_SEARCH_INTENT_UNFILLED",
          retryableFailureSeen ? 503 : 422,
          "No licensed image passed relevance and media audit for one search intent",
          {
            intentIndex,
            query: intent.query,
            ...(intent.sectionRef === undefined ? {} : { sectionRef: intent.sectionRef }),
            importedCount: imported.length,
            partialContentVersionId: nextContentVersionId,
            rejectionCodes: [...new Set(rejectionCodes)],
          },
        );
      }
    }

    const finalVersion = await this.#repository.getContentVersion(context, nextContentVersionId);
    if (finalVersion === null) {
      throw new MediaProductionServiceError(
        "MEDIA_SEARCH_FINAL_VERSION_NOT_FOUND",
        409,
        "The final content version was not available after media import",
      );
    }

    return Object.freeze({
      provider: this.#provider.provider,
      sourceContentVersionId: source.id,
      finalContentVersionId: nextContentVersionId,
      plannedCount: plan.length,
      initialMediaCount,
      totalMediaCount: initialMediaCount + imported.length,
      complete: initialMediaCount + imported.length === plan.length,
      manualReviewRequired: mediaRequiresManualReview(finalVersion.payload),
      imported: Object.freeze(imported),
      rejectedCandidateCount: rejectionCodes.length,
      rejectionCodes: Object.freeze([...new Set(rejectionCodes)]),
    });
  }
}
