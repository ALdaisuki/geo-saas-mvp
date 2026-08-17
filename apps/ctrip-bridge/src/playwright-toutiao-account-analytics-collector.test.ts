import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightToutiaoAccountAnalyticsCollector,
  type PlaywrightToutiaoAnalyticsPage,
} from "./playwright-toutiao-account-analytics-collector.js";
import { TOUTIAO_CONTENT_MANAGER_URL } from "./playwright-toutiao-publication.js";

function pageWithSnapshots(
  snapshots: readonly {
    readonly rows: readonly {
      readonly title: string;
      readonly publishedAt: string;
      readonly status: string;
      readonly href: string;
      readonly text: string;
    }[];
    readonly emptyState: string;
  }[],
): PlaywrightToutiaoAnalyticsPage & { readonly gotoMock: ReturnType<typeof vi.fn> } {
  let index = 0;
  const gotoMock = vi.fn(async () => undefined);
  return {
    url: () => TOUTIAO_CONTENT_MANAGER_URL,
    locator: () => {
      throw new Error("not used");
    },
    bringToFront: async () => undefined,
    goto: gotoMock,
    waitForLoadState: async () => undefined,
    evaluate: async <Result>() => {
      const snapshot = snapshots[Math.min(index++, snapshots.length - 1)];
      if (snapshot === undefined) throw new Error("analytics snapshot is missing");
      return snapshot as Result;
    },
    gotoMock,
  };
}

describe("Toutiao account analytics collector", () => {
  it("collects native counters from hydrated content-management rows", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        rows: [
          {
            title: "老人腿脚慢，青岛出境团适合吗",
            publishedAt: "08-05 02:46",
            status: "已发布",
            href: "/item/1234567890123456788/",
            text: "展现 1.2万 阅读 36 点赞 4 评论 2",
          },
          {
            title: "第二篇内容",
            publishedAt: "08-04 21:32",
            status: "审核中",
            href: "https://www.toutiao.com/item/1234567890123456787/",
            text: "展现 80 阅读 7 点赞 1 评论 0",
          },
        ],
      },
    ]);
    const collector = createPlaywrightToutiaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
      now: () => new Date("2026-08-05T03:00:00.000Z"),
    });

    await expect(collector.collect()).resolves.toMatchObject({
      platform: "toutiao",
      reportPeriod: "内容管理最近 2 条",
      publishCount: 1,
      totalImpressions: 12_080,
      totalReads: 43,
      totalLikes: 5,
      totalComments: 2,
      observedAt: "2026-08-05T03:00:00.000Z",
      works: [
        {
          externalId: "1234567890123456788",
          externalUrl: "https://www.toutiao.com/article/1234567890123456788/",
          impressions: 12_000,
        },
        {
          externalId: "1234567890123456787",
          externalUrl: "https://www.toutiao.com/article/1234567890123456787/",
          impressions: 80,
        },
      ],
    });
    expect(page.gotoMock).toHaveBeenCalledWith(TOUTIAO_CONTENT_MANAGER_URL, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("waits for asynchronously hydrated management rows", async () => {
    const page = pageWithSnapshots([
      { rows: [], emptyState: "" },
      {
        emptyState: "",
        rows: [
          {
            title: "延迟出现的内容",
            publishedAt: "08-05 03:01",
            status: "已发布",
            href: "/item/7670242235895562808/",
            text: "展现 0 阅读 0 点赞 0 评论 0",
          },
        ],
      },
    ]);
    const wait = vi.fn(async () => undefined);
    const collector = createPlaywrightToutiaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      wait,
      hydrationAttempts: 2,
      pollMs: 0,
    });

    await expect(collector.collect()).resolves.toMatchObject({ publishCount: 1 });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("fails closed when a work card is missing one native metric", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        rows: [
          {
            title: "字段漂移",
            publishedAt: "08-05 03:02",
            status: "已发布",
            href: "/item/7670242235895562809/",
            text: "展现 10 阅读 3 点赞 1",
          },
        ],
      },
    ]);
    const collector = createPlaywrightToutiaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow(
      "TOUTIAO_ANALYTICS_ADAPTER_DRIFT: a management work is missing identity or metrics",
    );
  });
});
