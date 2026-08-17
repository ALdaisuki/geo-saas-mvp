import { sha256Canonical } from "@geo/core";

import type { PlaywrightPublicationPage } from "./playwright-platform-publication.js";
import { TOUTIAO_CONTENT_MANAGER_URL } from "./playwright-toutiao-publication.js";

const TOUTIAO_PUBLIC_ID = /^\d{10,30}$/u;
const MAX_MANAGEMENT_ROWS = 100;
const DEFAULT_HYDRATION_ATTEMPTS = 20;
const DEFAULT_POLL_MS = 250;

export interface ToutiaoAccountAnalyticsWork {
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

export interface ToutiaoAccountAnalyticsObservation {
  readonly platform: "toutiao";
  readonly reportPeriod: string;
  readonly publishCount: number;
  readonly totalImpressions: number;
  readonly totalReads: number;
  readonly totalLikes: number;
  readonly totalComments: number;
  readonly works: readonly ToutiaoAccountAnalyticsWork[];
  readonly sourceHash: string;
  readonly observedAt: string;
}

export interface ToutiaoAccountAnalyticsCollector {
  collect(): Promise<ToutiaoAccountAnalyticsObservation>;
}

interface ToutiaoManagementRowSnapshot {
  readonly title: string;
  readonly publishedAt: string;
  readonly status: string;
  readonly href: string;
  readonly text: string;
}

interface ToutiaoManagementSnapshot {
  readonly rows: readonly ToutiaoManagementRowSnapshot[];
  readonly emptyState: string;
}

export interface PlaywrightToutiaoAnalyticsPage extends PlaywrightPublicationPage {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

interface ToutiaoSnapshotElement {
  readonly innerText?: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ToutiaoSnapshotElement | null;
  querySelectorAll(selector: string): ArrayLike<ToutiaoSnapshotElement>;
}

function snapshotToutiaoManagementDocument(limit: number): ToutiaoManagementSnapshot {
  const document = (
    globalThis as unknown as {
      readonly document?: ToutiaoSnapshotElement;
    }
  ).document;
  if (document === undefined) throw new Error("Toutiao management document is unavailable");
  const rows = Array.from(document.querySelectorAll(".article-card-wrap"))
    .slice(0, limit)
    .map((row) => {
      const title = row.querySelector("a.title[href]");
      const timestamps = row.querySelectorAll(".create-time");
      const statuses = Array.from(row.querySelectorAll(".byte-tag"))
        .map((item) => item.innerText ?? item.textContent ?? "")
        .filter((item) => item.trim().length > 0);
      return {
        title: title?.innerText ?? title?.textContent ?? "",
        publishedAt:
          timestamps.length === 1
            ? (timestamps[0]?.innerText ?? timestamps[0]?.textContent ?? "")
            : "",
        status: statuses.join(" "),
        href: title?.getAttribute("href") ?? "",
        text: row.innerText ?? row.textContent ?? "",
      };
    });
  const empty = document.querySelector(
    ".byte-empty, [class*='empty-state'], [class*='empty-wrap']",
  );
  return { rows, emptyState: empty?.innerText ?? empty?.textContent ?? "" };
}

function publicIdentity(href: string): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(href, "https://www.toutiao.com");
  } catch {
    return null;
  }
  const match = /^\/item\/(\d{10,30})\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.toutiao.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    id === undefined ||
    !TOUTIAO_PUBLIC_ID.test(id)
  ) {
    return null;
  }
  return { id, url: `https://www.toutiao.com/article/${id}/` };
}

function metric(text: string, label: "展现" | "阅读" | "点赞" | "评论"): number | null {
  const match = new RegExp(`${label}\\s*([0-9][0-9,.]*(?:\\.[0-9]+)?)\\s*([万亿]?)`, "u").exec(
    normalizeText(text),
  );
  if (match === null) return null;
  const numeric = Number((match[1] ?? "").replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.round(numeric * multiplier);
}

function workFromSnapshot(row: ToutiaoManagementRowSnapshot): ToutiaoAccountAnalyticsWork | null {
  const identity = publicIdentity(row.href);
  const title = normalizeText(row.title);
  const publishedAt = normalizeText(row.publishedAt);
  const status = normalizeText(row.status);
  const impressions = metric(row.text, "展现");
  const reads = metric(row.text, "阅读");
  const likes = metric(row.text, "点赞");
  const comments = metric(row.text, "评论");
  if (
    identity === null ||
    title.length === 0 ||
    publishedAt.length === 0 ||
    status.length === 0 ||
    impressions === null ||
    reads === null ||
    likes === null ||
    comments === null
  ) {
    return null;
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

export function createPlaywrightToutiaoAccountAnalyticsCollector(options: {
  readonly pages: () => readonly PlaywrightToutiaoAnalyticsPage[];
  readonly openPage: (fixedOfficialUrl: string) => Promise<PlaywrightToutiaoAnalyticsPage>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly hydrationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): ToutiaoAccountAnalyticsCollector {
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
    throw new TypeError("Toutiao analytics hydration options are invalid");
  }

  const isManagementPage = (page: PlaywrightToutiaoAnalyticsPage): boolean => {
    try {
      const observed = new URL(page.url());
      const expected = new URL(TOUTIAO_CONTENT_MANAGER_URL);
      return observed.origin === expected.origin && observed.pathname === expected.pathname;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    collect: async (): Promise<ToutiaoAccountAnalyticsObservation> => {
      const existing = options.pages().filter(isManagementPage);
      if (existing.length > 1) {
        throw new Error("TOUTIAO_ANALYTICS_ADAPTER_DRIFT: management page is not unique");
      }
      const page = existing[0] ?? (await options.openPage(TOUTIAO_CONTENT_MANAGER_URL));
      if (page.goto === undefined) {
        throw new Error("TOUTIAO_ANALYTICS_ADAPTER_DRIFT: management navigation is unavailable");
      }
      await page.goto(TOUTIAO_CONTENT_MANAGER_URL, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
      if (!isManagementPage(page)) {
        throw new Error("TOUTIAO_ANALYTICS_ADAPTER_DRIFT: navigation left content management");
      }

      let latest: ToutiaoManagementSnapshot = { rows: [], emptyState: "" };
      for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
        latest = await page.evaluate(snapshotToutiaoManagementDocument, MAX_MANAGEMENT_ROWS);
        if (latest.rows.length > 0) break;
        if (attempt < hydrationAttempts - 1) await wait(pollMs);
      }
      if (latest.rows.length === 0) {
        throw new Error(
          normalizeText(latest.emptyState).length > 0
            ? "TOUTIAO_ANALYTICS_DATA_PENDING: content management has no measurable works"
            : "TOUTIAO_ANALYTICS_ADAPTER_DRIFT: content management rows did not hydrate",
        );
      }

      const works = latest.rows.map(workFromSnapshot);
      if (works.some((work) => work === null)) {
        throw new Error(
          "TOUTIAO_ANALYTICS_ADAPTER_DRIFT: a management work is missing identity or metrics",
        );
      }
      const observedWorks = Object.freeze(works as readonly ToutiaoAccountAnalyticsWork[]);
      const base = Object.freeze({
        platform: "toutiao" as const,
        reportPeriod: `内容管理最近 ${observedWorks.length} 条`,
        publishCount: observedWorks.filter((work) => work.status.includes("已发布")).length,
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
