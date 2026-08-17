import sharp from "sharp";
import { ProxyAgent } from "undici";
import { z } from "zod";

import type { LicensedImageSearchProviderId, MediaAspectRatio } from "@geo/contracts";

import { MAX_IMPORTED_IMAGE_BYTES } from "./image-inspector.js";
import { MediaProductionError } from "./types.js";

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const WIKIMEDIA_DOWNLOAD_HOST = "upload.wikimedia.org";
const PEXELS_API = "https://api.pexels.com/v1/search";
const PEXELS_SOURCE_HOST = "www.pexels.com";
const PEXELS_DOWNLOAD_HOST = "images.pexels.com";
const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";
const OUTPUT_DIMENSIONS: Readonly<
  Record<MediaAspectRatio, { readonly width: number; readonly height: number }>
> = {
  "1:1": { width: 1_200, height: 1_200 },
  "4:3": { width: 1_200, height: 900 },
  "16:9": { width: 1_200, height: 675 },
};

const metadataValueSchema = z
  .object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
  .passthrough();
const imageInfoSchema = z
  .object({
    url: z.string().url(),
    descriptionurl: z.string().url(),
    thumburl: z.string().url().optional(),
    mime: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    thumbwidth: z.number().int().positive().optional(),
    thumbheight: z.number().int().positive().optional(),
    extmetadata: z.record(z.string(), metadataValueSchema).default({}),
  })
  .passthrough();
const pageSchema = z
  .object({
    pageid: z.number().int().positive(),
    title: z.string().min(1),
    index: z.number().int().optional(),
    imageinfo: z.array(imageInfoSchema).min(1),
  })
  .passthrough();
const searchResponseSchema = z
  .object({
    query: z.object({ pages: z.record(z.string(), pageSchema) }).optional(),
  })
  .passthrough();

const pexelsPhotoSchema = z
  .object({
    id: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    url: z.string().url(),
    photographer: z.string().trim().min(1),
    alt: z.string().default(""),
    src: z.object({
      large2x: z.string().url(),
    }),
  })
  .passthrough();
const pexelsSearchResponseSchema = z
  .object({
    photos: z.array(pexelsPhotoSchema),
  })
  .passthrough();

export type { LicensedImageSearchProviderId };

export interface LicensedImageCandidate {
  readonly provider: LicensedImageSearchProviderId;
  readonly providerAssetId: string;
  readonly searchQuery: string;
  readonly title: string;
  readonly description: string;
  readonly creator: string;
  readonly sourceUrl: string;
  readonly downloadUrl: string;
  readonly licenseName: string;
  readonly licenseUrl: string;
  readonly attribution: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly mimeType: string;
}

export interface NormalizedLicensedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly modificationDescription: string;
}

export function licensedImageRenditionDimensions(
  aspectRatio: MediaAspectRatio,
): Readonly<{ width: number; height: number }> {
  return OUTPUT_DIMENSIONS[aspectRatio];
}

export interface LicensedImageSearchProvider {
  readonly provider: LicensedImageSearchProviderId;
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]>;
  downloadAndNormalize(input: {
    readonly candidate: LicensedImageCandidate;
    readonly aspectRatio?: MediaAspectRatio;
    readonly signal?: AbortSignal;
  }): Promise<NormalizedLicensedImage>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const RETRYABLE_DOWNLOAD_STATUSES = new Set([429, 503, 504]);

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function plainMetadata(value: string | undefined): string {
  if (value === undefined) return "";
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function metadata(
  values: Readonly<Record<string, { readonly value: string | number | boolean | null }>>,
  key: string,
): string | undefined {
  const raw = values[key]?.value;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

function normalizedLicenseUrl(shortName: string, raw: string | undefined): string | null {
  if (/^(?:public domain|pdm)/iu.test(shortName)) {
    return "https://creativecommons.org/publicdomain/mark/1.0/";
  }
  if (/^cc0/iu.test(shortName)) {
    return "https://creativecommons.org/publicdomain/zero/1.0/";
  }
  if (!/^cc by(?:-sa)?\b/iu.test(shortName) || raw === undefined) return null;
  try {
    const url = new URL(raw.replace(/^http:/iu, "https:"));
    if (url.protocol !== "https:" || url.hostname !== "creativecommons.org") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function assertSuccessful(response: Response, code: string, message: string): void {
  if (!response.ok) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    throw new MediaProductionError(code, message, {
      status: response.status,
      ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? { retryAfterMs: retryAfterSeconds * 1_000 }
        : {}),
    });
  }
}

function normalizeSearchInput(input: { readonly query: string; readonly limit: number }): string {
  const query = input.query.normalize("NFKC").trim();
  if (query.length < 2 || query.length > 160) {
    throw new MediaProductionError("MEDIA_SEARCH_QUERY_INVALID", "Image search query is invalid");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 30) {
    throw new MediaProductionError("MEDIA_SEARCH_LIMIT_INVALID", "Image search limit is invalid");
  }
  return query;
}

async function downloadAndNormalizeFixedImage(input: {
  readonly fetchImpl: FetchLike;
  readonly downloadUrl: string;
  readonly downloadHost: string;
  readonly providerName: string;
  readonly userAgent: string;
  readonly aspectRatio?: MediaAspectRatio;
  readonly signal?: AbortSignal;
}): Promise<NormalizedLicensedImage> {
  const url = new URL(input.downloadUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== input.downloadHost ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new MediaProductionError(
      "MEDIA_SEARCH_DOWNLOAD_URL_INVALID",
      `Image download URL is outside the fixed ${input.providerName} host`,
    );
  }
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await input.fetchImpl(url, {
      headers: { accept: "image/jpeg,image/png,image/webp", "user-agent": input.userAgent },
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!RETRYABLE_DOWNLOAD_STATUSES.has(response.status) || attempt === 2) break;
    await response.body?.cancel();
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(Math.max(retryAfterSeconds * 1_000, 500), 5_000)
      : 1_000 * (attempt + 1);
    await waitForRetry(delayMs, input.signal);
  }
  if (response === undefined) {
    throw new MediaProductionError(
      "MEDIA_SEARCH_DOWNLOAD_FAILED",
      `${input.providerName} image download failed`,
    );
  }
  assertSuccessful(
    response,
    "MEDIA_SEARCH_DOWNLOAD_FAILED",
    `${input.providerName} image download failed`,
  );
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new MediaProductionError(
      "MEDIA_SEARCH_DOWNLOAD_TYPE_INVALID",
      "Downloaded response is not a supported image",
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORTED_IMAGE_BYTES) {
    throw new MediaProductionError("MEDIA_BYTES_TOO_LARGE", "Downloaded image exceeds 10 MiB");
  }
  const source = new Uint8Array(await response.arrayBuffer());
  if (source.byteLength === 0 || source.byteLength > MAX_IMPORTED_IMAGE_BYTES) {
    throw new MediaProductionError(
      source.byteLength === 0 ? "MEDIA_SEARCH_DOWNLOAD_EMPTY" : "MEDIA_BYTES_TOO_LARGE",
      source.byteLength === 0 ? "Downloaded image is empty" : "Downloaded image exceeds 10 MiB",
    );
  }
  const dimensions = licensedImageRenditionDimensions(input.aspectRatio ?? "4:3");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      await sharp(source, { failOn: "warning", limitInputPixels: 100_000_000 })
        .rotate()
        .resize(dimensions.width, dimensions.height, { fit: "cover", position: "attention" })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer(),
    );
  } catch {
    throw new MediaProductionError(
      "MEDIA_SEARCH_IMAGE_INVALID",
      "Downloaded bytes could not be normalized as an image",
    );
  }
  return Object.freeze({
    bytes,
    mimeType: "image/jpeg" as const,
    width: dimensions.width,
    height: dimensions.height,
    modificationDescription: `Automated orientation correction, attention crop, resize to ${dimensions.width}x${dimensions.height}, and JPEG encoding; no semantic edits.`,
  });
}

function discoveryQueries(query: string): readonly string[] {
  const candidates = [query];
  const properPhrase = query.match(/\b[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*){0,2}\b/u)?.[0];
  if (properPhrase !== undefined && properPhrase !== query) {
    candidates.push(properPhrase);
    const firstProperWord = properPhrase.split(/\s+/u)[0];
    if (firstProperWord !== undefined && firstProperWord !== properPhrase) {
      candidates.push(firstProperWord);
    }
  }
  return Object.freeze([...new Set(candidates)]);
}

export class WikimediaCommonsImageSearchProvider implements LicensedImageSearchProvider {
  readonly provider = "wikimedia_commons" as const;
  readonly #fetch: FetchLike;
  readonly #proxyAgent: ProxyAgent | undefined;
  readonly #userAgent: string;

  constructor(
    options: {
      readonly fetchImpl?: FetchLike;
      readonly proxyUrl?: string;
      readonly userAgent?: string;
    } = {},
  ) {
    if (options.fetchImpl !== undefined && options.proxyUrl !== undefined) {
      throw new TypeError(
        "Wikimedia proxy URL cannot be combined with a custom fetch implementation",
      );
    }
    this.#proxyAgent =
      options.proxyUrl === undefined ? undefined : new ProxyAgent(options.proxyUrl);
    this.#fetch =
      options.fetchImpl ??
      (this.#proxyAgent === undefined
        ? fetch
        : (input, init) =>
            fetch(input, {
              ...init,
              dispatcher: this.#proxyAgent,
            } as RequestInit & { dispatcher: ProxyAgent }));
    this.#userAgent = options.userAgent ?? "GEO-SaaS/0.1 (licensed-media-search)";
  }

  async close(): Promise<void> {
    await this.#proxyAgent?.close();
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]> {
    const query = normalizeSearchInput(input);
    const aggregated: LicensedImageCandidate[] = [];
    const seenProviderAssetIds = new Set<string>();
    for (const discoveryQuery of discoveryQueries(query)) {
      const url = new URL(WIKIMEDIA_API);
      url.search = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: `${discoveryQuery} filetype:bitmap`,
        gsrnamespace: "6",
        gsrlimit: String(input.limit),
        prop: "imageinfo",
        iiprop: "url|extmetadata|mime|size",
        iiurlwidth: "1600",
        format: "json",
        origin: "*",
      }).toString();
      const response = await this.#fetch(url, {
        headers: { accept: "application/json", "user-agent": this.#userAgent },
        redirect: "error",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      assertSuccessful(response, "MEDIA_SEARCH_PROVIDER_FAILED", "Wikimedia search failed");
      const parsed = searchResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new MediaProductionError(
          "MEDIA_SEARCH_RESPONSE_INVALID",
          "Wikimedia search returned an invalid response",
        );
      }
      const pages = Object.values(parsed.data.query?.pages ?? {}).sort(
        (left, right) =>
          (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER),
      );
      const candidates = pages.flatMap((page): LicensedImageCandidate[] => {
        const image = page.imageinfo[0];
        if (
          image === undefined ||
          !["image/jpeg", "image/png", "image/webp"].includes(image.mime)
        ) {
          return [];
        }
        const licenseName = plainMetadata(metadata(image.extmetadata, "LicenseShortName"));
        const licenseUrl = normalizedLicenseUrl(
          licenseName,
          metadata(image.extmetadata, "LicenseUrl"),
        );
        if (licenseName.length === 0 || licenseUrl === null) return [];
        const sourceUrl = new URL(image.descriptionurl);
        const downloadUrl = new URL(image.thumburl ?? image.url);
        if (
          sourceUrl.protocol !== "https:" ||
          sourceUrl.hostname !== "commons.wikimedia.org" ||
          downloadUrl.protocol !== "https:" ||
          downloadUrl.hostname !== WIKIMEDIA_DOWNLOAD_HOST
        ) {
          return [];
        }
        const creator = plainMetadata(metadata(image.extmetadata, "Artist")) || "Unknown creator";
        const credit = plainMetadata(metadata(image.extmetadata, "Credit"));
        return [
          Object.freeze({
            provider: "wikimedia_commons" as const,
            providerAssetId: String(page.pageid),
            searchQuery: query,
            title: page.title.replace(/^File:/u, "").trim(),
            description: plainMetadata(metadata(image.extmetadata, "ImageDescription")),
            creator,
            sourceUrl: sourceUrl.toString(),
            downloadUrl: downloadUrl.toString(),
            licenseName,
            licenseUrl,
            attribution: [creator, credit].filter((value) => value.length > 0).join("; "),
            sourceWidth: image.thumbwidth ?? image.width,
            sourceHeight: image.thumbheight ?? image.height,
            mimeType: image.mime,
          }),
        ];
      });
      for (const candidate of candidates) {
        if (seenProviderAssetIds.has(candidate.providerAssetId)) continue;
        seenProviderAssetIds.add(candidate.providerAssetId);
        aggregated.push(candidate);
        if (aggregated.length >= input.limit) return Object.freeze(aggregated);
      }
    }
    return Object.freeze(aggregated);
  }

  async downloadAndNormalize(input: {
    readonly candidate: LicensedImageCandidate;
    readonly aspectRatio?: MediaAspectRatio;
    readonly signal?: AbortSignal;
  }): Promise<NormalizedLicensedImage> {
    if (input.candidate.provider !== this.provider) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_DOWNLOAD_URL_INVALID",
        "Image candidate does not belong to the configured Wikimedia provider",
      );
    }
    return downloadAndNormalizeFixedImage({
      fetchImpl: this.#fetch,
      downloadUrl: input.candidate.downloadUrl,
      downloadHost: WIKIMEDIA_DOWNLOAD_HOST,
      providerName: "Wikimedia",
      userAgent: this.#userAgent,
      ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

export class PexelsImageSearchProvider implements LicensedImageSearchProvider {
  readonly provider = "pexels" as const;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;

  constructor(options: {
    readonly apiKey: string;
    readonly fetchImpl?: FetchLike;
    readonly userAgent?: string;
  }) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length < 16 || apiKey.length > 512 || /\s/u.test(apiKey)) {
      throw new TypeError("Pexels API key must be 16-512 non-space characters");
    }
    this.#apiKey = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#userAgent = options.userAgent ?? "GEO-SaaS/0.1 (licensed-media-search)";
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]> {
    const query = normalizeSearchInput(input);
    const url = new URL(PEXELS_API);
    url.search = new URLSearchParams({
      query,
      per_page: String(input.limit),
      orientation: "landscape",
      locale: "en-US",
    }).toString();
    const response = await this.#fetch(url, {
      headers: {
        accept: "application/json",
        authorization: this.#apiKey,
        "user-agent": this.#userAgent,
      },
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    assertSuccessful(response, "MEDIA_SEARCH_PROVIDER_FAILED", "Pexels search failed");
    const parsed = pexelsSearchResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_RESPONSE_INVALID",
        "Pexels search returned an invalid response",
      );
    }
    const candidates = parsed.data.photos.flatMap((photo): LicensedImageCandidate[] => {
      const sourceUrl = new URL(photo.url);
      const downloadUrl = new URL(photo.src.large2x);
      if (
        sourceUrl.protocol !== "https:" ||
        sourceUrl.hostname !== PEXELS_SOURCE_HOST ||
        sourceUrl.port.length > 0 ||
        sourceUrl.username.length > 0 ||
        sourceUrl.password.length > 0 ||
        downloadUrl.protocol !== "https:" ||
        downloadUrl.hostname !== PEXELS_DOWNLOAD_HOST ||
        downloadUrl.port.length > 0 ||
        downloadUrl.username.length > 0 ||
        downloadUrl.password.length > 0
      ) {
        return [];
      }
      const description = photo.alt.normalize("NFKC").trim();
      return [
        Object.freeze({
          provider: "pexels" as const,
          providerAssetId: String(photo.id),
          searchQuery: query,
          title: description || `Pexels photo ${String(photo.id)}`,
          description,
          creator: photo.photographer,
          sourceUrl: sourceUrl.toString(),
          downloadUrl: downloadUrl.toString(),
          licenseName: "Pexels License",
          licenseUrl: PEXELS_LICENSE_URL,
          attribution: `${photo.photographer} / Pexels`,
          sourceWidth: photo.width,
          sourceHeight: photo.height,
          mimeType: "image/jpeg",
        }),
      ];
    });
    return Object.freeze(candidates.slice(0, input.limit));
  }

  downloadAndNormalize(input: {
    readonly candidate: LicensedImageCandidate;
    readonly aspectRatio?: MediaAspectRatio;
    readonly signal?: AbortSignal;
  }): Promise<NormalizedLicensedImage> {
    if (input.candidate.provider !== this.provider) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_DOWNLOAD_URL_INVALID",
        "Image candidate does not belong to the configured Pexels provider",
      );
    }
    return downloadAndNormalizeFixedImage({
      fetchImpl: this.#fetch,
      downloadUrl: input.candidate.downloadUrl,
      downloadHost: PEXELS_DOWNLOAD_HOST,
      providerName: "Pexels",
      userAgent: this.#userAgent,
      ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}
