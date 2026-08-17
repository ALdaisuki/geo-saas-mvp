import { sha256Canonical } from "@geo/core";

import type { PlaywrightPublicationPage } from "./playwright-platform-publication.js";

export const BAIJIAHAO_ANALYTICS_URL = "https://baijiahao.baidu.com/builder/rc/analysiscontent";

const DEFAULT_HYDRATION_ATTEMPTS = 20;
const DEFAULT_POLL_MS = 250;
const CHALLENGE_MARKERS = ["百度安全验证", "拖动左侧滑块", "扫码验证"] as const;

export interface BaijiahaoAccountAnalyticsObservation {
  readonly platform: "baijiahao";
  readonly reportPeriod: string;
  readonly publishCount: number;
  readonly totalImpressions: null;
  readonly totalReads: number;
  readonly totalLikes: null;
  readonly totalComments: null;
  readonly works: readonly [];
  readonly sourceHash: string;
  readonly observedAt: string;
}

export interface BaijiahaoAccountAnalyticsCollector {
  collect(): Promise<BaijiahaoAccountAnalyticsObservation>;
}

export interface PlaywrightBaijiahaoAnalyticsPage extends PlaywrightPublicationPage {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

interface BaijiahaoAnalyticsSnapshot {
  readonly text: string;
}

interface BaijiahaoSnapshotDocument {
  readonly body: {
    readonly innerText?: string;
    readonly textContent: string | null;
  } | null;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function snapshotBaijiahaoAnalyticsDocument(): BaijiahaoAnalyticsSnapshot {
  const document = (globalThis as unknown as { readonly document?: BaijiahaoSnapshotDocument })
    .document;
  if (document?.body === null || document?.body === undefined) {
    throw new Error("Baijiahao analytics document is unavailable");
  }
  return { text: document.body.innerText ?? document.body.textContent ?? "" };
}

function metric(text: string, label: string): number | null {
  const match = new RegExp(`${label}\\s*([0-9][0-9,.]*(?:\\.[0-9]+)?)\\s*([万亿]?)`, "u").exec(
    normalizeText(text),
  );
  if (match === null) return null;
  const numeric = Number((match[1] ?? "").replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.round(numeric * multiplier);
}

function reportPeriod(text: string): string | null {
  const match = /(统计近\d+日发布成功的作品数据[^。]*?(?:数据更新至\s*[^。]+)?)/u.exec(
    normalizeText(text),
  );
  return match?.[1] ?? null;
}

export function createPlaywrightBaijiahaoAccountAnalyticsCollector(options: {
  readonly pages: () => readonly PlaywrightBaijiahaoAnalyticsPage[];
  readonly openPage: (fixedOfficialUrl: string) => Promise<PlaywrightBaijiahaoAnalyticsPage>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly hydrationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): BaijiahaoAccountAnalyticsCollector {
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const hydrationAttempts = options.hydrationAttempts ?? DEFAULT_HYDRATION_ATTEMPTS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (
    !Number.isSafeInteger(hydrationAttempts) ||
    hydrationAttempts < 1 ||
    hydrationAttempts > 100 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 0 ||
    pollMs > 10_000
  ) {
    throw new TypeError("Baijiahao analytics hydration options are invalid");
  }

  const isAnalyticsPage = (page: PlaywrightBaijiahaoAnalyticsPage): boolean => {
    try {
      const observed = new URL(page.url());
      const expected = new URL(BAIJIAHAO_ANALYTICS_URL);
      return observed.origin === expected.origin && observed.pathname === expected.pathname;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    collect: async (): Promise<BaijiahaoAccountAnalyticsObservation> => {
      const existing = options.pages().filter(isAnalyticsPage);
      if (existing.length > 1) {
        throw new Error("BAIJIAHAO_ANALYTICS_ADAPTER_DRIFT: analytics page is not unique");
      }
      const existingPage = existing[0];
      const page = existingPage ?? (await options.openPage(BAIJIAHAO_ANALYTICS_URL));
      if (existingPage !== undefined) {
        if (page.goto === undefined) {
          throw new Error("BAIJIAHAO_ANALYTICS_ADAPTER_DRIFT: analytics navigation is unavailable");
        }
        await page.goto(BAIJIAHAO_ANALYTICS_URL, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
      }
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
      if (!isAnalyticsPage(page)) {
        throw new Error("BAIJIAHAO_ANALYTICS_ADAPTER_DRIFT: navigation left official analytics");
      }

      let latest: BaijiahaoAnalyticsSnapshot = { text: "" };
      for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
        latest = await page.evaluate(snapshotBaijiahaoAnalyticsDocument, undefined);
        const normalized = normalizeText(latest.text);
        if (CHALLENGE_MARKERS.some((marker) => normalized.includes(marker))) {
          throw new Error(
            "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED: 人工完成百家号滑块或扫码验证后可重新采集",
          );
        }
        if (metric(normalized, "投稿量") !== null && metric(normalized, "阅读/播放量") !== null) {
          break;
        }
        if (attempt < hydrationAttempts - 1) await wait(pollMs);
      }

      const normalized = normalizeText(latest.text);
      const publishCount = metric(normalized, "投稿量");
      const totalReads = metric(normalized, "阅读/播放量");
      const observedReportPeriod = reportPeriod(normalized);
      if (publishCount === null || totalReads === null || observedReportPeriod === null) {
        throw new Error("BAIJIAHAO_ANALYTICS_DATA_PENDING: official analytics has not hydrated");
      }
      const base = Object.freeze({
        platform: "baijiahao" as const,
        reportPeriod: `${observedReportPeriod}；平台未提供展现、总点赞、总评论`,
        publishCount,
        totalImpressions: null,
        totalReads,
        totalLikes: null,
        totalComments: null,
        works: [] as const,
      });
      return Object.freeze({
        ...base,
        sourceHash: sha256Canonical(base),
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    },
  });
}
