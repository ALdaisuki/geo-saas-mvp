import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeTrendSourceHttpTransport,
  PUBLIC_TREND_SOURCES,
  PublicTrendCollector,
  parseBaiduTrendPayload,
  parseNeteaseTrendPayload,
  parseSohuTrendPayload,
  parseToutiaoTrendPayload,
  parseWeiboTrendPayload,
  parseZhihuTrendPayload,
  type TrendSourceHttpRequest,
  type TrendSourceHttpResponse,
  type TrendSourceHttpTransport,
} from "./index.js";

const observedAt = "2026-08-04T00:00:00.000Z";
const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/public-trends.json", import.meta.url), "utf8"),
) as Readonly<Record<string, unknown>>;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture(name: string): unknown {
  const value = fixtures[name];
  if (value === undefined) throw new Error(`Missing trend fixture: ${name}`);
  return value;
}

function response(status: number, body: unknown): TrendSourceHttpResponse {
  return { status, body: new TextEncoder().encode(JSON.stringify(body)) };
}

class FixtureTransport implements TrendSourceHttpTransport {
  readonly requests: TrendSourceHttpRequest[] = [];

  constructor(private readonly failedSourceUrl?: string) {}

  async get(request: TrendSourceHttpRequest): Promise<TrendSourceHttpResponse> {
    this.requests.push(request);
    const source = PUBLIC_TREND_SOURCES.find((candidate) => candidate.url === request.url);
    if (source === undefined) throw new Error(`Unexpected trend URL: ${request.url}`);
    if (request.url === this.failedSourceUrl) return response(503, { error: "unavailable" });
    return response(200, fixture(source.sourceKey));
  }
}

describe("public trend fixture parsers", () => {
  it("parses Toutiao ranks, URLs, and numeric heat", () => {
    expect(parseToutiaoTrendPayload(fixture("toutiao"), observedAt, 1)).toEqual([
      {
        sourceKey: "toutiao",
        title: "A股热点观察",
        canonicalUrl: "https://www.toutiao.com/trending/1001/?event_type=hot_board",
        sourceRank: 1,
        heatValue: 9_937_585,
        observedAt,
      },
    ]);
  });

  it("parses the nested Baidu board card", () => {
    expect(parseBaiduTrendPayload(fixture("baidu"), observedAt, 1)[0]).toMatchObject({
      sourceKey: "baidu",
      title: "DeepSeek 产业进展",
      sourceRank: 1,
      canonicalUrl: "https://m.baidu.com/s?word=DeepSeek",
    });
  });

  it("parses Weibo heat, board time, and a stable search URL", () => {
    expect(parseWeiboTrendPayload(fixture("weibo"), observedAt, 1)[0]).toEqual({
      sourceKey: "weibo",
      title: "智慧城市建设",
      summary: "分类：互联网",
      canonicalUrl:
        "https://s.weibo.com/weibo?q=%23%E6%99%BA%E6%85%A7%E5%9F%8E%E5%B8%82%E5%BB%BA%E8%AE%BE%23",
      sourceRank: 1,
      heatValue: 1_252_697,
      observedAt,
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("parses Zhihu excerpts and Chinese heat units", () => {
    const items = parseZhihuTrendPayload(fixture("zhihu"), observedAt, 2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceKey: "zhihu",
      title: "住房公积金条例修订有哪些变化？",
      heatValue: 9_460_000,
      canonicalUrl: "https://www.zhihu.com/question/100001",
    });
    expect(items[1]).toMatchObject({ heatValue: 120_000_000 });
  });

  it("derives Sohu article evidence from article and author IDs", () => {
    expect(parseSohuTrendPayload(fixture("sohu-news"), observedAt, 1)[0]).toEqual({
      sourceKey: "sohu-news",
      title: "区域消费市场持续回暖",
      summary: "来源：搜狐新闻",
      canonicalUrl: "https://www.sohu.com/a/1058220115_100136517",
      sourceRank: 1,
      observedAt,
      sourceUpdatedAt: "2026-08-03T16:02:02.000Z",
    });
  });

  it("interprets NetEase's timezone-less publish time as China Standard Time", () => {
    expect(parseNeteaseTrendPayload(fixture("netease-news"), observedAt, 1)[0]).toEqual({
      sourceKey: "netease-news",
      title: "城市更新项目发布新进展",
      summary: "来源：城市频道",
      canonicalUrl: "https://m.163.com/news/article/TEST0001.html",
      sourceRank: 1,
      observedAt,
      sourceUpdatedAt: "2026-08-03T15:02:58.000Z",
    });
  });

  it("fails closed when an upstream payload has no valid rows", () => {
    expect(() => parseToutiaoTrendPayload({ data: [{ Title: " " }] }, observedAt)).toThrow(
      expect.objectContaining({ code: "TREND_SOURCE_PAYLOAD_INVALID" }),
    );
  });
});

describe("PublicTrendCollector", () => {
  it("uses only the six fixed endpoints and isolates a failed source", async () => {
    const weibo = PUBLIC_TREND_SOURCES.find((source) => source.sourceKey === "weibo");
    if (weibo === undefined) throw new Error("Weibo source is missing");
    const transport = new FixtureTransport(weibo.url);
    const collector = new PublicTrendCollector({
      transport,
      now: () => new Date(observedAt),
      timeoutMs: 1_234,
      maxBytes: 4_321,
      limitPerSource: 1,
      userAgent: "GEOTrendCollector/Test",
    });

    const results = await collector.collectAll();

    expect(results).toHaveLength(6);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.find((result) => result.sourceKey === "weibo")).toMatchObject({
      status: "rejected",
      error: { code: "TREND_SOURCE_HTTP_STATUS" },
    });
    expect(transport.requests.map((request) => request.url)).toEqual(
      PUBLIC_TREND_SOURCES.map((source) => source.url),
    );
    expect(transport.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: weibo.url,
          timeoutMs: 1_234,
          maxBytes: 4_321,
          headers: expect.objectContaining({
            referer: "https://weibo.com/",
            "user-agent": "GEOTrendCollector/Test",
          }),
        }),
      ]),
    );
  });

  it("enforces the response-size cap while streaming", async () => {
    const fetchImplementation = vi.fn(async () => new Response("123456"));
    const transport = new NodeTrendSourceHttpTransport(fetchImplementation);

    await expect(
      transport.get({
        url: "https://fixed.example.test/",
        headers: {},
        timeoutMs: 100,
        maxBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_RESPONSE_TOO_LARGE" });
  });

  it("cancels the response body when Content-Length exceeds the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImplementation = vi.fn(
      async () =>
        new Response(body, {
          headers: { "content-length": "6" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const transport = new NodeTrendSourceHttpTransport(fetchImplementation);

    await expect(
      transport.get({
        url: "https://fixed.example.test/",
        headers: {},
        timeoutMs: 100,
        maxBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts a source request at its configured deadline", async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolvePromise, rejectPromise) => {
          init?.signal?.addEventListener(
            "abort",
            () => rejectPromise(new Error("aborted by test deadline")),
            { once: true },
          );
        }),
    ) as typeof globalThis.fetch;
    const transport = new NodeTrendSourceHttpTransport(fetchImplementation);
    const result = expect(
      transport.get({
        url: "https://fixed.example.test/",
        headers: {},
        timeoutMs: 100,
        maxBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(100);

    await result;
  });

  it("propagates a caller shutdown signal into the active request", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolvePromise, rejectPromise) => {
          init?.signal?.addEventListener(
            "abort",
            () => rejectPromise(new Error("aborted by caller")),
            { once: true },
          );
        }),
    ) as typeof globalThis.fetch;
    const transport = new NodeTrendSourceHttpTransport(fetchImplementation);
    const controller = new AbortController();
    const result = expect(
      transport.get({
        url: "https://fixed.example.test/",
        headers: {},
        timeoutMs: 10_000,
        maxBytes: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_ABORTED" });

    controller.abort();

    await result;
  });

  it("keeps source definitions immutable at runtime", () => {
    expect(Object.isFrozen(PUBLIC_TREND_SOURCES)).toBe(true);
    expect(PUBLIC_TREND_SOURCES.every((source) => Object.isFrozen(source))).toBe(true);
    expect(PUBLIC_TREND_SOURCES.every((source) => Object.isFrozen(source.headers))).toBe(true);
  });

  it("rejects a per-source limit above the hard maximum", () => {
    expect(() => new PublicTrendCollector({ limitPerSource: 21 })).toThrow(
      "Trend source limit must be between 1 and 20",
    );
  });
});
