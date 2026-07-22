import sharp from "sharp";
import { z } from "zod";

import { MAX_IMPORTED_IMAGE_BYTES } from "./image-inspector.js";
import { MediaProductionError } from "./types.js";

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const WIKIMEDIA_DOWNLOAD_HOST = "upload.wikimedia.org";
const OUTPUT_WIDTH = 1_200;
const OUTPUT_HEIGHT = 900;

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
    query: z
      .object({ pages: z.record(z.string(), pageSchema) })
      .optional(),
  })
  .passthrough();

export interface LicensedImageCandidate {
  readonly provider: "wikimedia_commons";
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
  readonly width: 1_200;
  readonly height: 900;
  readonly modificationDescription: string;
}

export interface LicensedImageSearchProvider {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]>;
  downloadAndNormalize(input: {
    readonly candidate: LicensedImageCandidate;
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
    throw new MediaProductionError(code, message, { status: response.status });
  }
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
  readonly #fetch: FetchLike;
  readonly #userAgent: string;

  constructor(options: { readonly fetchImpl?: FetchLike; readonly userAgent?: string } = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#userAgent = options.userAgent ?? "GEO-SaaS/0.1 (licensed-media-search)";
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]> {
    const query = input.query.normalize("NFKC").trim();
    if (query.length < 2 || query.length > 160) {
      throw new MediaProductionError("MEDIA_SEARCH_QUERY_INVALID", "Image search query is invalid");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 30) {
      throw new MediaProductionError("MEDIA_SEARCH_LIMIT_INVALID", "Image search limit is invalid");
    }
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
        (left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER),
      );
      const candidates = pages.flatMap((page): LicensedImageCandidate[] => {
        const image = page.imageinfo[0];
        if (image === undefined || !["image/jpeg", "image/png", "image/webp"].includes(image.mime)) {
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
    readonly signal?: AbortSignal;
  }): Promise<NormalizedLicensedImage> {
    const url = new URL(input.candidate.downloadUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== WIKIMEDIA_DOWNLOAD_HOST ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new MediaProductionError(
        "MEDIA_SEARCH_DOWNLOAD_URL_INVALID",
        "Image download URL is outside the fixed Wikimedia host",
      );
    }
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await this.#fetch(url, {
        headers: { accept: "image/jpeg,image/png,image/webp", "user-agent": this.#userAgent },
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
      throw new MediaProductionError("MEDIA_SEARCH_DOWNLOAD_FAILED", "Wikimedia image download failed");
    }
    assertSuccessful(response, "MEDIA_SEARCH_DOWNLOAD_FAILED", "Wikimedia image download failed");
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
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(
        await sharp(source, { failOn: "warning", limitInputPixels: 100_000_000 })
          .rotate()
          .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: "cover", position: "attention" })
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
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      modificationDescription:
        "Automated orientation correction, attention crop, resize to 1200x900, and JPEG encoding; no semantic edits.",
    });
  }
}
