export const PUBLIC_TREND_SOURCE_KEYS = [
  "toutiao",
  "baidu",
  "weibo",
  "zhihu",
  "sohu-news",
  "netease-news",
] as const;

export type PublicTrendSourceKey = (typeof PUBLIC_TREND_SOURCE_KEYS)[number];

export interface PublicTrendSourceDefinition {
  readonly sourceKey: PublicTrendSourceKey;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export const PUBLIC_TREND_SOURCES: readonly PublicTrendSourceDefinition[] = [
  {
    sourceKey: "toutiao",
    url: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    headers: {},
  },
  {
    sourceKey: "baidu",
    url: "https://top.baidu.com/api/board?platform=wise&tab=realtime",
    headers: {},
  },
  {
    sourceKey: "weibo",
    url: "https://weibo.com/ajax/statuses/hot_band",
    headers: { referer: "https://weibo.com/" },
  },
  {
    sourceKey: "zhihu",
    url: "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=50",
    headers: {},
  },
  {
    sourceKey: "sohu-news",
    url: "https://v2.sohu.com/public-api/feed?scene=CHANNEL&sceneId=12&page=1&size=20",
    headers: {},
  },
  {
    sourceKey: "netease-news",
    url: "https://m.163.com/fe/api/hot/news/flow",
    headers: {},
  },
] as const;
for (const source of PUBLIC_TREND_SOURCES) {
  Object.freeze(source.headers);
  Object.freeze(source);
}
Object.freeze(PUBLIC_TREND_SOURCES);

export interface CollectedTrendObservation {
  readonly sourceKey: PublicTrendSourceKey;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly sourceRank: number;
  readonly heatValue?: number | undefined;
  readonly observedAt: string;
  readonly sourceUpdatedAt?: string | undefined;
}

export interface TrendSourceHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface TrendSourceHttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export interface TrendSourceHttpTransport {
  get(request: TrendSourceHttpRequest): Promise<TrendSourceHttpResponse>;
}

export type TrendSourceCollectionErrorCode =
  | "TREND_SOURCE_HTTP_STATUS"
  | "TREND_SOURCE_INVALID_JSON"
  | "TREND_SOURCE_PAYLOAD_INVALID"
  | "TREND_SOURCE_ABORTED"
  | "TREND_SOURCE_RESPONSE_TOO_LARGE"
  | "TREND_SOURCE_TIMEOUT"
  | "TREND_SOURCE_TRANSPORT_FAILED";

export class TrendSourceCollectionError extends Error {
  constructor(
    readonly code: TrendSourceCollectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrendSourceCollectionError";
  }
}

export type TrendSourceCollectionResult =
  | {
      readonly sourceKey: PublicTrendSourceKey;
      readonly status: "fulfilled";
      readonly observations: readonly CollectedTrendObservation[];
    }
  | {
      readonly sourceKey: PublicTrendSourceKey;
      readonly status: "rejected";
      readonly error: TrendSourceCollectionError;
    };

interface JsonRecord {
  readonly [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_ITEMS_PER_SOURCE = 20;
const DEFAULT_USER_AGENT = "GEOTrendCollector/1.0";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function arrayAt(value: unknown, key: string): readonly unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return Array.isArray(nested) ? nested : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "string" ? nested : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  return isRecord(value) ? finiteNumber(value[key]) : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateUnicode(value: string, maximum: number): string {
  return Array.from(normalizeText(value)).slice(0, maximum).join("");
}

function validTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const title = truncateUnicode(value, 300);
  return Array.from(title).length >= 2 ? title : undefined;
}

function validHttpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function validTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function unixTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return validTimestamp(new Date(value * 1_000).toISOString());
}

function chinaLocalTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return undefined;
  return validTimestamp(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`,
  );
}

function chineseHeatValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[,，\s]/gu, "");
  const match = /(\d+(?:\.\d+)?)(万|亿)?/u.exec(normalized);
  if (match === null) return undefined;
  const base = Number(match[1]);
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  const result = base * multiplier;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS_PER_SOURCE) {
    throw new TypeError(`Trend source limit must be between 1 and ${String(MAX_ITEMS_PER_SOURCE)}`);
  }
  return limit;
}

function requireItems(
  sourceKey: PublicTrendSourceKey,
  items: readonly CollectedTrendObservation[],
): readonly CollectedTrendObservation[] {
  if (items.length === 0) {
    throw new TrendSourceCollectionError(
      "TREND_SOURCE_PAYLOAD_INVALID",
      `${sourceKey} response contained no valid trend items`,
    );
  }
  return items;
}

function uniqueItems(
  items: readonly CollectedTrendObservation[],
  limit: number,
): readonly CollectedTrendObservation[] {
  const seen = new Set<string>();
  const unique: CollectedTrendObservation[] = [];
  for (const item of items) {
    const key = `${item.title}\u0000${item.canonicalUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}

function observation(
  sourceKey: PublicTrendSourceKey,
  title: string,
  sourceRank: number,
  observedAt: string,
  optional: {
    readonly summary?: string | undefined;
    readonly canonicalUrl?: string | undefined;
    readonly heatValue?: number | undefined;
    readonly sourceUpdatedAt?: string | undefined;
  } = {},
): CollectedTrendObservation {
  return {
    sourceKey,
    title,
    sourceRank,
    observedAt,
    ...(optional.summary === undefined
      ? {}
      : { summary: truncateUnicode(optional.summary, 2_000) }),
    ...(optional.canonicalUrl === undefined ? {} : { canonicalUrl: optional.canonicalUrl }),
    ...(optional.heatValue === undefined ? {} : { heatValue: optional.heatValue }),
    ...(optional.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: optional.sourceUpdatedAt }),
  };
}

export function parseToutiaoTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  const rows = arrayAt(payload, "data");
  if (rows === undefined) return requireItems("toutiao", []);
  const items = rows.flatMap((row, index) => {
    const title = validTitle(stringAt(row, "Title") ?? stringAt(row, "QueryWord"));
    if (title === undefined) return [];
    return [
      observation("toutiao", title, index + 1, observedAt, {
        canonicalUrl: validHttpsUrl(stringAt(row, "Url")),
        heatValue: numberAt(row, "HotValue"),
      }),
    ];
  });
  return requireItems("toutiao", uniqueItems(items, boundedLimit(limit)));
}

function baiduRows(payload: unknown): readonly unknown[] | undefined {
  const data = recordAt(payload, "data");
  const cards = arrayAt(data, "cards");
  if (cards === undefined) return undefined;
  for (const card of cards) {
    const contentGroups = arrayAt(card, "content");
    if (contentGroups === undefined) continue;
    for (const group of contentGroups) {
      const rows = arrayAt(group, "content");
      if (rows !== undefined) return rows;
    }
  }
  return undefined;
}

export function parseBaiduTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  const rows = baiduRows(payload);
  if (rows === undefined) return requireItems("baidu", []);
  const items = rows.flatMap((row, index) => {
    const title = validTitle(stringAt(row, "word"));
    if (title === undefined) return [];
    return [
      observation("baidu", title, index + 1, observedAt, {
        canonicalUrl: validHttpsUrl(stringAt(row, "url")),
      }),
    ];
  });
  return requireItems("baidu", uniqueItems(items, boundedLimit(limit)));
}

export function parseWeiboTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  const rows = arrayAt(recordAt(payload, "data"), "band_list");
  if (rows === undefined) return requireItems("weibo", []);
  const items = rows.flatMap((row, index) => {
    const title = validTitle(stringAt(row, "note") ?? stringAt(row, "word"));
    if (title === undefined) return [];
    const wordScheme = stringAt(row, "word_scheme") ?? title;
    const category = validTitle(stringAt(row, "category"));
    const realPosition = numberAt(row, "realpos");
    return [
      observation(
        "weibo",
        title,
        realPosition !== undefined && realPosition >= 1 ? Math.trunc(realPosition) : index + 1,
        observedAt,
        {
          ...(category === undefined ? {} : { summary: `分类：${category}` }),
          canonicalUrl: validHttpsUrl(
            `https://s.weibo.com/weibo?q=${encodeURIComponent(wordScheme)}`,
          ),
          heatValue: numberAt(row, "num"),
          sourceUpdatedAt: unixTimestamp(numberAt(row, "onboard_time")),
        },
      ),
    ];
  });
  return requireItems("weibo", uniqueItems(items, boundedLimit(limit)));
}

export function parseZhihuTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  const rows = arrayAt(payload, "data");
  if (rows === undefined) return requireItems("zhihu", []);
  const items = rows.flatMap((row, index) => {
    const target = recordAt(row, "target");
    const title = validTitle(stringAt(recordAt(target, "title_area"), "text"));
    if (title === undefined) return [];
    const excerpt = stringAt(recordAt(target, "excerpt_area"), "text");
    const heatText = stringAt(recordAt(target, "metrics_area"), "text");
    return [
      observation("zhihu", title, index + 1, observedAt, {
        ...(excerpt === undefined ? {} : { summary: truncateUnicode(excerpt, 800) }),
        canonicalUrl: validHttpsUrl(stringAt(recordAt(target, "link"), "url")),
        heatValue: chineseHeatValue(heatText),
      }),
    ];
  });
  return requireItems("zhihu", uniqueItems(items, boundedLimit(limit)));
}

export function parseSohuTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  if (!Array.isArray(payload)) return requireItems("sohu-news", []);
  const items = payload.flatMap((row, index) => {
    const title = validTitle(stringAt(row, "title") ?? stringAt(row, "mobileTitle"));
    if (title === undefined) return [];
    const id = numberAt(row, "id");
    const authorId = numberAt(row, "authorId");
    const author = validTitle(stringAt(row, "authorName"));
    const articleUrl =
      id !== undefined && authorId !== undefined
        ? validHttpsUrl(
            `https://www.sohu.com/a/${String(Math.trunc(id))}_${String(Math.trunc(authorId))}`,
          )
        : undefined;
    return [
      observation("sohu-news", title, index + 1, observedAt, {
        ...(author === undefined ? {} : { summary: `来源：${author}` }),
        canonicalUrl: articleUrl,
        sourceUpdatedAt: validTimestamp(stringAt(row, "publicTime")),
      }),
    ];
  });
  return requireItems("sohu-news", uniqueItems(items, boundedLimit(limit)));
}

export function parseNeteaseTrendPayload(
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  const rows = arrayAt(recordAt(payload, "data"), "list");
  if (rows === undefined) return requireItems("netease-news", []);
  const items = rows.flatMap((row, index) => {
    const title = validTitle(stringAt(row, "title"));
    if (title === undefined) return [];
    const publisher = validTitle(stringAt(row, "source"));
    return [
      observation("netease-news", title, index + 1, observedAt, {
        ...(publisher === undefined ? {} : { summary: `来源：${publisher}` }),
        canonicalUrl: validHttpsUrl(stringAt(row, "url")),
        sourceUpdatedAt: chinaLocalTimestamp(
          stringAt(row, "publishTime") ?? stringAt(row, "ptime"),
        ),
      }),
    ];
  });
  return requireItems("netease-news", uniqueItems(items, boundedLimit(limit)));
}

export function parsePublicTrendPayload(
  sourceKey: PublicTrendSourceKey,
  payload: unknown,
  observedAt: string,
  limit = MAX_ITEMS_PER_SOURCE,
): readonly CollectedTrendObservation[] {
  switch (sourceKey) {
    case "toutiao":
      return parseToutiaoTrendPayload(payload, observedAt, limit);
    case "baidu":
      return parseBaiduTrendPayload(payload, observedAt, limit);
    case "weibo":
      return parseWeiboTrendPayload(payload, observedAt, limit);
    case "zhihu":
      return parseZhihuTrendPayload(payload, observedAt, limit);
    case "sohu-news":
      return parseSohuTrendPayload(payload, observedAt, limit);
    case "netease-news":
      return parseNeteaseTrendPayload(payload, observedAt, limit);
  }
}

export class NodeTrendSourceHttpTransport implements TrendSourceHttpTransport {
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetch = fetchImplementation;
  }

  async get(request: TrendSourceHttpRequest): Promise<TrendSourceHttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timeout.unref();
    const signal =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, request.signal]);
    try {
      const response = await this.#fetch(request.url, {
        method: "GET",
        headers: request.headers,
        redirect: "error",
        signal,
      });
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > request.maxBytes) {
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        throw new TrendSourceCollectionError(
          "TREND_SOURCE_RESPONSE_TOO_LARGE",
          "Trend source response exceeds the configured byte limit",
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > request.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new TrendSourceCollectionError(
              "TREND_SOURCE_RESPONSE_TOO_LARGE",
              "Trend source response exceeds the configured byte limit",
            );
          }
          chunks.push(chunk.value);
        }
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof TrendSourceCollectionError) throw error;
      const aborted = request.signal?.aborted === true;
      throw new TrendSourceCollectionError(
        aborted
          ? "TREND_SOURCE_ABORTED"
          : timedOut
            ? "TREND_SOURCE_TIMEOUT"
            : "TREND_SOURCE_TRANSPORT_FAILED",
        aborted
          ? "Trend source request was aborted"
          : timedOut
            ? "Trend source request timed out"
            : "Trend source request failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface PublicTrendCollectorOptions {
  readonly transport?: TrendSourceHttpTransport;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly limitPerSource?: number;
  readonly userAgent?: string;
}

export class PublicTrendCollector {
  readonly #transport: TrendSourceHttpTransport;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #limitPerSource: number;
  readonly #userAgent: string;

  constructor(options: PublicTrendCollectorOptions = {}) {
    this.#transport = options.transport ?? new NodeTrendSourceHttpTransport();
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#limitPerSource = boundedLimit(options.limitPerSource ?? MAX_ITEMS_PER_SOURCE);
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("Trend source timeout must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new TypeError("Trend source byte limit must be a positive safe integer");
    }
    if (this.#userAgent.trim().length === 0) {
      throw new TypeError("Trend source user agent must not be empty");
    }
  }

  async collectSource(
    sourceKey: PublicTrendSourceKey,
    observedAt = this.#now().toISOString(),
    signal?: AbortSignal,
  ): Promise<readonly CollectedTrendObservation[]> {
    const source = PUBLIC_TREND_SOURCES.find((candidate) => candidate.sourceKey === sourceKey);
    if (source === undefined) {
      throw new TypeError(`Unknown public trend source: ${String(sourceKey)}`);
    }
    const response = await this.#transport.get({
      url: source.url,
      timeoutMs: this.#timeoutMs,
      maxBytes: this.#maxBytes,
      ...(signal === undefined ? {} : { signal }),
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": this.#userAgent,
        ...source.headers,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TrendSourceCollectionError(
        "TREND_SOURCE_HTTP_STATUS",
        `${source.sourceKey} returned HTTP ${String(response.status)}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.body),
      ) as unknown;
    } catch {
      throw new TrendSourceCollectionError(
        "TREND_SOURCE_INVALID_JSON",
        `${source.sourceKey} returned invalid JSON`,
      );
    }
    return parsePublicTrendPayload(source.sourceKey, payload, observedAt, this.#limitPerSource);
  }

  async collectAll(signal?: AbortSignal): Promise<readonly TrendSourceCollectionResult[]> {
    const observedAt = this.#now().toISOString();
    return Promise.all(
      PUBLIC_TREND_SOURCES.map(async (source): Promise<TrendSourceCollectionResult> => {
        try {
          return {
            sourceKey: source.sourceKey,
            status: "fulfilled",
            observations: await this.collectSource(source.sourceKey, observedAt, signal),
          };
        } catch (error) {
          return {
            sourceKey: source.sourceKey,
            status: "rejected",
            error:
              error instanceof TrendSourceCollectionError
                ? error
                : new TrendSourceCollectionError(
                    "TREND_SOURCE_TRANSPORT_FAILED",
                    `${source.sourceKey} collection failed`,
                  ),
          };
        }
      }),
    );
  }
}
