import { sha256Canonical } from "@geo/core";

import type { PlaywrightPublicationPage } from "./playwright-platform-publication.js";
import {
  canonicalizeSohuManagementItemUrl,
  SOHU_CONTENT_MANAGER_URL,
} from "./playwright-sohu-publication.js";

const DEFAULT_HYDRATION_ATTEMPTS = 20;
const DEFAULT_POLL_MS = 250;
const MAX_MANAGEMENT_ROWS = 100;

export interface SohuAccountAnalyticsWork {
  readonly externalId: string;
  readonly externalUrl: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly status: "已发布";
  readonly impressions: null;
  readonly reads: number;
  readonly likes: null;
  readonly comments: number;
}

export interface SohuAccountAnalyticsObservation {
  readonly platform: "sohu";
  readonly reportPeriod: string;
  readonly publishCount: number;
  readonly totalImpressions: null;
  readonly totalReads: number;
  readonly totalLikes: null;
  readonly totalComments: number;
  readonly works: readonly SohuAccountAnalyticsWork[];
  readonly sourceHash: string;
  readonly observedAt: string;
}

export interface SohuAccountAnalyticsCollector {
  collect(): Promise<SohuAccountAnalyticsObservation>;
}

interface SohuManagementRowSnapshot {
  readonly title: string;
  readonly publishedAt: string;
  readonly status: string;
  readonly href: string;
  readonly text: string;
}

interface SohuManagementSnapshot {
  readonly rows: readonly SohuManagementRowSnapshot[];
  readonly emptyState: string;
  readonly challenge: boolean;
}

export interface PlaywrightSohuAnalyticsPage extends PlaywrightPublicationPage {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

interface SohuSnapshotElement {
  readonly innerText?: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  querySelector(selector: string): SohuSnapshotElement | null;
  querySelectorAll(selector: string): ArrayLike<SohuSnapshotElement>;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function snapshotSohuManagementDocument(limit: number): SohuManagementSnapshot {
  const document = (
    globalThis as unknown as {
      readonly document?: SohuSnapshotElement;
    }
  ).document;
  if (document === undefined) throw new Error("Sohu management document is unavailable");
  const visible = (element: SohuSnapshotElement): boolean => {
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  };
  const challenge = Array.from(
    document.querySelectorAll(
      'iframe[src*="captcha" i], [class*="tcaptcha" i], [id*="tcaptcha" i]',
    ),
  ).some(visible);
  const rows = Array.from(document.querySelectorAll(".content-item"))
    .slice(0, limit)
    .map((row) => {
      const title = row.querySelector(".article-content-info h3.title > a[href]");
      const publishedAt = row.querySelector(".article-content-info h3.title > .date-common");
      const status = row.querySelector(".status-view-icon + .status-common");
      return {
        title: title?.innerText ?? title?.textContent ?? "",
        publishedAt: publishedAt?.innerText ?? publishedAt?.textContent ?? "",
        status: status?.innerText ?? status?.textContent ?? "",
        href: title?.getAttribute("href") ?? "",
        text: row.innerText ?? row.textContent ?? "",
      };
    });
  const empty = document.querySelector(".mt-empty, [class*='empty-state'], [class*='empty-wrap']");
  return {
    rows,
    emptyState: empty?.innerText ?? empty?.textContent ?? "",
    challenge,
  };
}

function metric(text: string, label: "阅读" | "评论"): number | null {
  const match = new RegExp(label + "\\s*([0-9][0-9,.]*(?:\\.[0-9]+)?)\\s*([万亿]?)", "u").exec(
    normalizeText(text),
  );
  if (match === null) return null;
  const numeric = Number((match[1] ?? "").replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.round(numeric * multiplier);
}

function workFromSnapshot(row: SohuManagementRowSnapshot): SohuAccountAnalyticsWork | null {
  const status = normalizeText(row.status);
  if (!status.includes("已发布")) return null;
  const identity = canonicalizeSohuManagementItemUrl(row.href);
  if (identity === null) {
    throw new Error("SOHU_ANALYTICS_ADAPTER_DRIFT: a published work has no canonical public link");
  }
  const title = normalizeText(row.title);
  const publishedAt = normalizeText(row.publishedAt);
  const reads = metric(row.text, "阅读");
  const comments = metric(row.text, "评论");
  if (title.length === 0 || publishedAt.length === 0 || reads === null || comments === null) {
    throw new Error("SOHU_ANALYTICS_ADAPTER_DRIFT: a published work is missing native counters");
  }
  return Object.freeze({
    externalId: identity.id,
    externalUrl: identity.url,
    title,
    publishedAt,
    status: "已发布" as const,
    impressions: null,
    reads,
    likes: null,
    comments,
  });
}

export function createPlaywrightSohuAccountAnalyticsCollector(options: {
  readonly pages: () => readonly PlaywrightSohuAnalyticsPage[];
  readonly openPage: (fixedOfficialUrl: string) => Promise<PlaywrightSohuAnalyticsPage>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly hydrationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): SohuAccountAnalyticsCollector {
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
    throw new TypeError("Sohu analytics hydration options are invalid");
  }
  const isManagementPage = (page: PlaywrightSohuAnalyticsPage): boolean =>
    page.url() === SOHU_CONTENT_MANAGER_URL;

  return Object.freeze({
    collect: async (): Promise<SohuAccountAnalyticsObservation> => {
      const existing = options.pages().filter(isManagementPage);
      const page = existing[0] ?? (await options.openPage(SOHU_CONTENT_MANAGER_URL));
      if (page.goto === undefined) {
        throw new Error("SOHU_ANALYTICS_ADAPTER_DRIFT: management navigation is unavailable");
      }
      await page.goto(SOHU_CONTENT_MANAGER_URL, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
      if (!isManagementPage(page)) {
        throw new Error("SOHU_ANALYTICS_ADAPTER_DRIFT: navigation left content management");
      }

      let latest: SohuManagementSnapshot = { rows: [], emptyState: "", challenge: false };
      for (let attempt = 0; attempt < hydrationAttempts; attempt += 1) {
        latest = await page.evaluate(snapshotSohuManagementDocument, MAX_MANAGEMENT_ROWS);
        if (latest.challenge) {
          throw new Error("SOHU_ANALYTICS_CHALLENGE_REQUIRED: 人工完成搜狐号安全验证后可重新采集");
        }
        if (latest.rows.length > 0) break;
        if (attempt < hydrationAttempts - 1) await wait(pollMs);
      }
      if (latest.rows.length === 0) {
        throw new Error(
          normalizeText(latest.emptyState).length > 0
            ? "SOHU_ANALYTICS_DATA_PENDING: content management has no measurable works"
            : "SOHU_ANALYTICS_ADAPTER_DRIFT: content management rows did not hydrate",
        );
      }
      const works = latest.rows
        .map(workFromSnapshot)
        .filter((work): work is SohuAccountAnalyticsWork => work !== null);
      if (works.length === 0) {
        throw new Error(
          "SOHU_ANALYTICS_DATA_PENDING: content management has no published measurable works",
        );
      }
      const observedWorks = Object.freeze(works);
      const base = Object.freeze({
        platform: "sohu" as const,
        reportPeriod: "内容管理最近 " + observedWorks.length + " 条已发布作品",
        publishCount: observedWorks.length,
        totalImpressions: null,
        totalReads: observedWorks.reduce((total, work) => total + work.reads, 0),
        totalLikes: null,
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
