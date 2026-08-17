import { sha256Canonical } from "@geo/core";

import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import type {
  PlaywrightCtripReadLocator,
  PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

export const CTRIP_ANALYTICS_URL = "https://we.ctrip.com/analyse/contentAnalysis";

export interface CtripAccountAnalyticsWork {
  readonly title: string;
  readonly publishedAt: string;
  readonly views: number;
  readonly viewers: number;
  readonly interactions: number;
  readonly interactors: number;
}

export interface CtripAccountAnalyticsObservation {
  readonly reportPeriod: string;
  readonly publishCount: number;
  readonly featuredCount: number;
  readonly qualityCount: number;
  readonly featuredQualityRate: number;
  readonly contentHeat: number;
  readonly totalViews: number;
  readonly totalViewers: number;
  readonly totalLikes: number;
  readonly totalFavorites: number;
  readonly totalComments: number;
  readonly totalInteractions: number;
  readonly totalInteractors: number;
  readonly trafficSources: Readonly<Record<string, number>>;
  readonly works: readonly CtripAccountAnalyticsWork[];
  readonly sourceHash: string;
  readonly observedAt: string;
}

export interface CtripAccountAnalyticsCollector {
  collect(): Promise<CtripAccountAnalyticsObservation>;
}

export type PlaywrightCtripAccountLocator = Omit<PlaywrightCtripReadLocator, "first" | "nth"> &
  Omit<PlaywrightCtripDraftLocator, "first" | "nth"> & {
    first(): PlaywrightCtripAccountLocator;
    nth(index: number): PlaywrightCtripAccountLocator;
  };

export type PlaywrightCtripAccountPage = Omit<PlaywrightCtripReadPage, "locator"> &
  Omit<PlaywrightCtripDraftPage, "locator"> & {
    locator(selector: string): PlaywrightCtripAccountLocator;
  };

interface AnalyticsDomSnapshot {
  readonly bodyText: string;
  readonly rows: readonly (readonly string[])[];
  readonly hasNext: boolean;
}

interface AnalyticsDocumentElement {
  readonly textContent: string | null;
  readonly innerText?: string;
  querySelectorAll(selector: string): ArrayLike<AnalyticsDocumentElement>;
}

function snapshotAnalyticsDocument(): AnalyticsDomSnapshot {
  const document = (
    globalThis as unknown as {
      readonly document?: AnalyticsDocumentElement & {
        readonly body?: AnalyticsDocumentElement;
        querySelector(selector: string): AnalyticsDocumentElement | null;
      };
    }
  ).document;
  if (document === undefined) throw new Error("Ctrip analytics document is unavailable");
  const rowElements = Array.from(document.querySelectorAll("table tbody tr"));
  const rows = rowElements.map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) =>
      (cell.innerText ?? cell.textContent ?? "").replace(/\s+/gu, " ").trim(),
    ),
  );
  const activeNext = document.querySelector(
    ".ant-pagination-next:not(.ant-pagination-disabled), button[aria-label='next']:not([disabled]), button[aria-label='下一页']:not([disabled])",
  );
  return {
    bodyText: (document.body?.innerText ?? document.body?.textContent ?? "").trim(),
    rows,
    hasNext: activeNext !== null,
  };
}

const READ_TIMEOUT_MS = 1_500;
const HYDRATION_ATTEMPTS = 80;
const HYDRATION_POLL_MS = 250;
const DETAIL_EMPTY_SETTLE_ATTEMPTS = 8;
const MAX_DETAIL_PAGES = 100;
const TRANSIENT_NAVIGATION_RETRIES = 2;
const TRAFFIC_SOURCE_LABELS = Object.freeze(["推荐", "搜索", "关注", "个人主页", "分享", "其他"]);
const ANALYTICS_TAB_SELECTORS = Object.freeze({
  内容概况: '[role="tab"]:text-is("内容概况")',
  单条分析: '[role="tab"]:text-is("单条分析")',
  浏览: '[role="tab"]:text-is("浏览")',
  互动: '[role="tab"]:text-is("互动")',
});

class CtripAnalyticsHydrationError extends Error {
  readonly transient: boolean;

  constructor(label: string, transient: boolean) {
    super(`CTRIP_ANALYTICS_ADAPTER_DRIFT: ${label} did not hydrate`);
    this.name = "CtripAnalyticsHydrationError";
    this.transient = transient;
  }
}

class CtripAnalyticsDataPendingError extends Error {
  constructor() {
    super("CTRIP_ANALYTICS_DATA_PENDING: platform metrics are not available yet");
    this.name = "CtripAnalyticsDataPendingError";
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scaledNumber(rawValue: string): number {
  const normalized = rawValue.replace(/,/gu, "").trim();
  if (normalized === "--" || normalized.length === 0) {
    throw new CtripAnalyticsDataPendingError();
  }
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(万|亿)?%?$/u);
  if (match === null) throw new Error(`Unsupported Ctrip analytics number: ${rawValue}`);
  const value = Number(match[1]);
  const scale = match[2] === "万" ? 10_000 : match[2] === "亿" ? 100_000_000 : 1;
  return value * scale;
}

function metricValue(text: string, label: string): number {
  const pattern = new RegExp(
    `${escapePattern(label)}\\s*(?:为|[:：])?\\s*(--|[0-9][0-9,.]*(?:\\.[0-9]+)?(?:万|亿)?%?)`,
    "u",
  );
  const match = normalizeText(text).match(pattern);
  if (match?.[1] === undefined) {
    throw new Error(`CTRIP_ANALYTICS_ADAPTER_DRIFT: missing ${label}`);
  }
  return scaledNumber(match[1]);
}

function reportPeriod(text: string): string {
  const normalized = normalizeText(text);
  const labelled = normalized.match(
    /(?:数据周期|统计周期|报告周期|时间范围)\s*[:：]?\s*([^\n]{1,80})/u,
  )?.[1];
  if (labelled !== undefined) return labelled.trim();
  const dates = normalized.match(
    /\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*(?:至|-|~|—)\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}/u,
  )?.[0];
  return dates ?? "携程当前报告周期";
}

function transientNavigationError(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.includes("系统暂时开小差了") && normalized.includes("请稍后再试");
}

function trafficSources(text: string): Readonly<Record<string, number>> {
  const normalized = normalizeText(text);
  return Object.freeze(
    Object.fromEntries(
      TRAFFIC_SOURCE_LABELS.flatMap((label) => {
        const match = normalized.match(
          new RegExp(`${escapePattern(label)}\\s*([0-9]+(?:\\.[0-9]+)?)%`, "u"),
        );
        return match?.[1] === undefined ? [] : [[label, Number(match[1])]];
      }),
    ),
  );
}

function workFromCells(cells: readonly string[]): CtripAccountAnalyticsWork | null {
  if (cells.length < 6 || cells[0] === undefined || cells[1] === undefined) return null;
  if (cells[0].includes("作品名称") || cells[1].includes("发布时间")) return null;
  try {
    return Object.freeze({
      title: cells[0].trim(),
      publishedAt: cells[1].trim(),
      views: scaledNumber(cells[2] ?? "0"),
      viewers: scaledNumber(cells[3] ?? "0"),
      interactions: scaledNumber(cells[4] ?? "0"),
      interactors: scaledNumber(cells[5] ?? "0"),
    });
  } catch (error) {
    if (error instanceof CtripAnalyticsDataPendingError) throw error;
    return null;
  }
}

function analyticsPage(page: PlaywrightCtripAccountPage): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === "https://we.ctrip.com" && url.pathname === "/analyse/contentAnalysis";
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function visible(locator: PlaywrightCtripAccountLocator): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: READ_TIMEOUT_MS });
  } catch {
    return false;
  }
}

export function createPlaywrightCtripAccountAnalyticsCollector(options: {
  readonly pages: () => readonly PlaywrightCtripAccountPage[];
  readonly openPage: (url: string) => Promise<PlaywrightCtripAccountPage>;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly hydrationAttempts?: number;
}): CtripAccountAnalyticsCollector {
  const wait = options.wait ?? delay;
  const hydrationAttempts = options.hydrationAttempts ?? HYDRATION_ATTEMPTS;

  const navigateTab = async (
    page: PlaywrightCtripAccountPage,
    label: "内容概况" | "单条分析" | "浏览" | "互动",
    marker: string,
    hydrated: (snapshot: AnalyticsDomSnapshot, attempt: number) => boolean = (snapshot) =>
      normalizeText(snapshot.bodyText).includes(marker),
  ): Promise<AnalyticsDomSnapshot> => {
    if (page.goto === undefined) throw new Error("Ctrip analytics navigation is unavailable");
    const navigate = async (): Promise<void> => {
      await page.goto?.(CTRIP_ANALYTICS_URL, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
    };
    await navigate();
    const tab = page.locator(ANALYTICS_TAB_SELECTORS[label]).first();
    let tabSelected = false;
    let navigationRetries = 0;
    let latestSnapshot: AnalyticsDomSnapshot | null = null;
    for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
      if (!tabSelected && (await visible(tab))) {
        await tab.click({ timeout: 10_000 });
        tabSelected = true;
      }
      const snapshot = await page.evaluate(snapshotAnalyticsDocument, undefined);
      latestSnapshot = snapshot;
      if (hydrated(snapshot, attempt)) return snapshot;
      if (
        navigationRetries < TRANSIENT_NAVIGATION_RETRIES &&
        transientNavigationError(snapshot.bodyText)
      ) {
        navigationRetries += 1;
        tabSelected = false;
        await wait(HYDRATION_POLL_MS);
        await navigate();
        continue;
      }
      await wait(HYDRATION_POLL_MS);
    }
    throw new CtripAnalyticsHydrationError(
      label,
      latestSnapshot !== null && transientNavigationError(latestSnapshot.bodyText),
    );
  };

  const navigateFixedTab = async (
    page: PlaywrightCtripAccountPage,
    label: "内容概况" | "单条分析" | "浏览" | "互动",
    marker: string,
    hydrated?: (snapshot: AnalyticsDomSnapshot, attempt: number) => boolean,
  ): Promise<Readonly<{ page: PlaywrightCtripAccountPage; snapshot: AnalyticsDomSnapshot }>> => {
    try {
      return Object.freeze({
        page,
        snapshot: await navigateTab(page, label, marker, hydrated),
      });
    } catch (error) {
      if (!(error instanceof CtripAnalyticsHydrationError) || !error.transient) throw error;
      if (page.close === undefined) throw error;
      await page.close();
      const replacement = await options.openPage(CTRIP_ANALYTICS_URL);
      return Object.freeze({
        page: replacement,
        snapshot: await navigateTab(replacement, label, marker, hydrated),
      });
    }
  };

  const collect = async (): Promise<CtripAccountAnalyticsObservation> => {
    const existing = options.pages().filter(analyticsPage).slice(-2);
    let overviewPage = existing[0] ?? (await options.openPage(CTRIP_ANALYTICS_URL));
    let detailPage = existing[1] ?? (await options.openPage(CTRIP_ANALYTICS_URL));
    if (overviewPage === detailPage) {
      throw new Error("Ctrip analytics requires two independent fixed tabs");
    }

    const overviewResult = await navigateFixedTab(overviewPage, "内容概况", "内容热度");
    overviewPage = overviewResult.page;
    const browseResult = await navigateFixedTab(overviewPage, "浏览", "浏览数");
    overviewPage = browseResult.page;
    const interactionResult = await navigateFixedTab(overviewPage, "互动", "点赞数");
    const detailResult = await navigateFixedTab(
      detailPage,
      "单条分析",
      "浏览次数",
      (snapshot, attempt) =>
        normalizeText(snapshot.bodyText).includes("浏览次数") &&
        (snapshot.rows.length > 0 ||
          attempt >= Math.min(DETAIL_EMPTY_SETTLE_ATTEMPTS, hydrationAttempts - 1)),
    );
    detailPage = detailResult.page;
    const overview = overviewResult.snapshot;
    const browse = browseResult.snapshot;
    const interaction = interactionResult.snapshot;
    let detail = detailResult.snapshot;
    const works = new Map<string, CtripAccountAnalyticsWork>();
    for (let pageNumber = 0; pageNumber < MAX_DETAIL_PAGES; pageNumber += 1) {
      for (const cells of detail.rows) {
        const work = workFromCells(cells);
        if (work !== null && work.title.length > 0) {
          works.set(`${work.title}\u0000${work.publishedAt}`, work);
        }
      }
      if (!detail.hasNext) break;
      const previousFirstRow = detail.rows[0]?.join("\u0000") ?? "";
      const next = detailPage
        .locator(
          ".ant-pagination-next:not(.ant-pagination-disabled), button[aria-label='next']:not([disabled]), button[aria-label='下一页']:not([disabled])",
        )
        .first();
      if (!(await visible(next))) break;
      await next.click({ timeout: 10_000 });
      for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
        const candidate = await detailPage.evaluate(snapshotAnalyticsDocument, undefined);
        if ((candidate.rows[0]?.join("\u0000") ?? "") !== previousFirstRow) {
          detail = candidate;
          break;
        }
        await wait(HYDRATION_POLL_MS);
      }
    }

    const workItems = Object.freeze([...works.values()]);
    const totalLikes = metricValue(interaction.bodyText, "点赞数");
    const totalFavorites = metricValue(interaction.bodyText, "收藏数");
    const totalComments = metricValue(interaction.bodyText, "评论数");
    const totalShares = metricValue(interaction.bodyText, "分享数");
    const base = Object.freeze({
      reportPeriod: reportPeriod(overview.bodyText),
      publishCount: metricValue(overview.bodyText, "发布数"),
      featuredCount: metricValue(overview.bodyText, "精选数"),
      qualityCount: metricValue(overview.bodyText, "优质数"),
      featuredQualityRate: metricValue(overview.bodyText, "精优率"),
      contentHeat: metricValue(overview.bodyText, "内容热度"),
      totalViews: metricValue(browse.bodyText, "浏览数"),
      totalViewers: workItems.reduce((sum, work) => sum + work.viewers, 0),
      totalLikes,
      totalFavorites,
      totalComments,
      totalInteractions: totalLikes + totalFavorites + totalComments + totalShares,
      totalInteractors: workItems.reduce((sum, work) => sum + work.interactors, 0),
      trafficSources: trafficSources(browse.bodyText),
      works: workItems,
    });
    return Object.freeze({
      ...base,
      sourceHash: sha256Canonical(base),
      observedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
  };

  return Object.freeze({ collect });
}
