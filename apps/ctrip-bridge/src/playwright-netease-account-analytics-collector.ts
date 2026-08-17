import { sha256Canonical } from "@geo/core";

import type { PlaywrightPublicationPage } from "./playwright-platform-publication.js";
import {
  canonicalizeNeteaseManagementItemUrl,
  NETEASE_CONTENT_MANAGER_URL,
} from "./playwright-netease-publication.js";

const DEFAULT_HYDRATION_ATTEMPTS = 20;
const DEFAULT_POLL_MS = 250;
const MAX_MANAGEMENT_ROWS = 100;

export interface NeteaseAccountAnalyticsWork {
  readonly externalId: string;
  readonly externalUrl: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly status: string;
  readonly impressions: number;
  readonly reads: number;
  readonly likes: number;
  readonly comments: number;
}

export interface NeteaseAccountAnalyticsObservation {
  readonly platform: "netease";
  readonly reportPeriod: string;
  readonly publishCount: number;
  readonly totalImpressions: number;
  readonly totalReads: number;
  readonly totalLikes: number;
  readonly totalComments: number;
  readonly works: readonly NeteaseAccountAnalyticsWork[];
  readonly sourceHash: string;
  readonly observedAt: string;
}

export interface NeteaseAccountAnalyticsCollector {
  collect(): Promise<NeteaseAccountAnalyticsObservation>;
}

interface NeteaseManagementRowSnapshot {
  readonly title: string;
  readonly publishedAt: string;
  readonly status: string;
  readonly href: string;
  readonly text: string;
}

interface NeteaseManagementSnapshot {
  readonly rows: readonly NeteaseManagementRowSnapshot[];
  readonly emptyState: string;
  readonly challenge: boolean;
}

export interface PlaywrightNeteaseAnalyticsPage extends PlaywrightPublicationPage {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

interface NeteaseSnapshotElement {
  readonly innerText?: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  querySelector(selector: string): NeteaseSnapshotElement | null;
  querySelectorAll(selector: string): ArrayLike<NeteaseSnapshotElement>;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function snapshotNeteaseManagementDocument(limit: number): NeteaseManagementSnapshot {
  const document = (
    globalThis as unknown as {
      readonly document?: NeteaseSnapshotElement;
    }
  ).document;
  if (document === undefined) throw new Error("Netease management document is unavailable");
  const visible = (element: NeteaseSnapshotElement): boolean => {
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  };
  const challenge = Array.from(
    document.querySelectorAll('iframe[src*="captcha" i], [class*="yidun" i], [id*="yidun" i]'),
  ).some(visible);
  const rows = Array.from(
    document.querySelectorAll(".src-main-page-ContentManage-Card-index-module-card"),
  )
    .slice(0, limit)
    .map((row) => {
      const title = row.querySelector(
        ".src-main-page-ContentManage-Card-index-module-title a[href]",
      );
      const publishedAt = row.querySelector(".src-main-page-ContentManage-Card-index-module-ptime");
      const status = row.querySelector(".src-main-page-ContentManage-Card-index-module-state");
      return {
        title: title?.innerText ?? title?.textContent ?? "",
        publishedAt: publishedAt?.innerText ?? publishedAt?.textContent ?? "",
        status: status?.innerText ?? status?.textContent ?? "",
        href: title?.getAttribute("href") ?? "",
        text: row.innerText ?? row.textContent ?? "",
      };
    });
  const empty = document.querySelector(".empty, [class*='empty-state'], [class*='empty-wrap']");
  return {
    rows,
    emptyState: empty?.innerText ?? empty?.textContent ?? "",
    challenge,
  };
}

function metric(text: string, suffix: string): number | null {
  const match = new RegExp("([0-9][0-9,.]*(?:\\.[0-9]+)?)\\s*([万亿]?)" + suffix, "u").exec(
    normalizeText(text),
  );
  if (match === null) return null;
  const numeric = Number((match[1] ?? "").replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.round(numeric * multiplier);
}

function workFromSnapshot(row: NeteaseManagementRowSnapshot): NeteaseAccountAnalyticsWork | null {
  const status = normalizeText(row.status);
  if (!status.includes("已发布")) return null;
  const identity = canonicalizeNeteaseManagementItemUrl(row.href);
  if (identity === null) {
    throw new Error(
      "NETEASE_ANALYTICS_ADAPTER_DRIFT: a published work has no canonical public link",
    );
  }
  const title = normalizeText(row.title);
  const publishedAt = normalizeText(row.publishedAt);
  const impressions = metric(row.text, "次展现");
  const reads = metric(row.text, "次观看");
  const likes = metric(row.text, "个顶");
  const comments = metric(row.text, "跟贴互动");
  if (
    title.length === 0 ||
    publishedAt.length === 0 ||
    impressions === null ||
    reads === null ||
    likes === null ||
    comments === null
  ) {
    throw new Error("NETEASE_ANALYTICS_ADAPTER_DRIFT: a published work is missing native counters");
  }
  return Object.freeze({
    externalId: identity.id,
    externalUrl: identity.url,
    title,
    publishedAt,
    status,
    impressions,
    reads,
    likes,
    comments,
  });
}

export function createPlaywrightNeteaseAccountAnalyticsCollector(options: {
  readonly pages: () => readonly PlaywrightNeteaseAnalyticsPage[];
  readonly openPage: (fixedOfficialUrl: string) => Promise<PlaywrightNeteaseAnalyticsPage>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly hydrationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): NeteaseAccountAnalyticsCollector {
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
    throw new TypeError("Netease analytics hydration options are invalid");
  }
  const isManagementPage = (page: PlaywrightNeteaseAnalyticsPage): boolean =>
    page.url() === NETEASE_CONTENT_MANAGER_URL;

  return Object.freeze({
    collect: async (): Promise<NeteaseAccountAnalyticsObservation> => {
      const existing = options.pages().filter(isManagementPage);
      const page = existing[0] ?? (await options.openPage(NETEASE_CONTENT_MANAGER_URL));
      if (page.goto === undefined) {
        throw new Error("NETEASE_ANALYTICS_ADAPTER_DRIFT: management navigation is unavailable");
      }
      await page.goto(NETEASE_CONTENT_MANAGER_URL, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
      if (!isManagementPage(page)) {
        throw new Error("NETEASE_ANALYTICS_ADAPTER_DRIFT: navigation left content management");
      }

      let latest: NeteaseManagementSnapshot = { rows: [], emptyState: "", challenge: false };
      for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
        latest = await page.evaluate(snapshotNeteaseManagementDocument, MAX_MANAGEMENT_ROWS);
        if (latest.challenge) {
          throw new Error(
            "NETEASE_ANALYTICS_CHALLENGE_REQUIRED: 人工完成网易号安全验证后可重新采集",
          );
        }
        if (latest.rows.length > 0) break;
        if (attempt < hydrationAttempts - 1) await wait(pollMs);
      }
      if (latest.rows.length === 0) {
        throw new Error(
          normalizeText(latest.emptyState).length > 0
            ? "NETEASE_ANALYTICS_DATA_PENDING: content management has no measurable works"
            : "NETEASE_ANALYTICS_ADAPTER_DRIFT: content management rows did not hydrate",
        );
      }
      const works = latest.rows
        .map(workFromSnapshot)
        .filter((work): work is NeteaseAccountAnalyticsWork => work !== null);
      if (works.length === 0) {
        throw new Error(
          "NETEASE_ANALYTICS_DATA_PENDING: content management has no published measurable works",
        );
      }
      const observedWorks = Object.freeze(works);
      const base = Object.freeze({
        platform: "netease" as const,
        reportPeriod: "内容管理最近 " + observedWorks.length + " 条已发布作品",
        publishCount: observedWorks.length,
        totalImpressions: observedWorks.reduce((total, work) => total + work.impressions, 0),
        totalReads: observedWorks.reduce((total, work) => total + work.reads, 0),
        totalLikes: observedWorks.reduce((total, work) => total + work.likes, 0),
        totalComments: observedWorks.reduce((total, work) => total + work.comments, 0),
        works: observedWorks,
      });
      return Object.freeze({
        ...base,
        sourceHash: sha256Canonical(base),
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    },
  });
}
