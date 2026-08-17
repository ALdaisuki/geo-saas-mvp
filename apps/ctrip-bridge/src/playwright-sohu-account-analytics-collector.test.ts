import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightSohuAccountAnalyticsCollector,
  type PlaywrightSohuAnalyticsPage,
} from "./playwright-sohu-account-analytics-collector.js";
import { SOHU_CONTENT_MANAGER_URL } from "./playwright-sohu-publication.js";

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
    readonly challenge: boolean;
  }[],
): PlaywrightSohuAnalyticsPage & { readonly gotoMock: ReturnType<typeof vi.fn> } {
  let index = 0;
  const gotoMock = vi.fn(async () => undefined);
  return {
    url: () => SOHU_CONTENT_MANAGER_URL,
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

describe("Sohu account analytics collector", () => {
  it("collects published work reads and comments from creator management", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        challenge: false,
        rows: [
          {
            title: "景德镇旅行社怎么选",
            publishedAt: "2026-08-04 06:08",
            status: "已发布",
            href: "https://www.sohu.com/a/1058611029_122943573",
            text: "阅读 28 评论 2",
          },
          {
            title: "草稿不进入流量快照",
            publishedAt: "2026-08-11 03:03",
            status: "草稿",
            href: "/mpfe/v4/contentManagement/news/articlepreview?id=1061350322",
            text: "草稿 发布 编辑",
          },
        ],
      },
    ]);
    const collector = createPlaywrightSohuAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
      now: () => new Date("2026-08-11T04:00:00.000Z"),
    });

    await expect(collector.collect()).resolves.toMatchObject({
      platform: "sohu",
      reportPeriod: "内容管理最近 1 条已发布作品",
      publishCount: 1,
      totalImpressions: null,
      totalReads: 28,
      totalLikes: null,
      totalComments: 2,
      observedAt: "2026-08-11T04:00:00.000Z",
      works: [
        {
          externalId: "1058611029_122943573",
          externalUrl: "https://www.sohu.com/a/1058611029_122943573",
          reads: 28,
          comments: 2,
        },
      ],
    });
    expect(page.gotoMock).toHaveBeenCalledWith(SOHU_CONTENT_MANAGER_URL, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("fails closed when a published row loses a native counter", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        challenge: false,
        rows: [
          {
            title: "字段漂移",
            publishedAt: "2026-08-11 12:00",
            status: "已发布",
            href: "https://www.sohu.com/a/1061350322_122943573",
            text: "阅读 10",
          },
        ],
      },
    ]);
    const collector = createPlaywrightSohuAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow(
      "SOHU_ANALYTICS_ADAPTER_DRIFT: a published work is missing native counters",
    );
  });

  it("fails closed when a published row loses its canonical public link", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        challenge: false,
        rows: [
          {
            title: "正常作品",
            publishedAt: "2026-08-11 12:00",
            status: "已发布",
            href: "https://www.sohu.com/a/1061350322_122943573",
            text: "阅读 10 评论 1",
          },
          {
            title: "链接结构漂移",
            publishedAt: "2026-08-11 11:00",
            status: "已发布",
            href: "/unexpected/published/1061350000",
            text: "阅读 8 评论 0",
          },
        ],
      },
    ]);
    const collector = createPlaywrightSohuAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow(
      "SOHU_ANALYTICS_ADAPTER_DRIFT: a published work has no canonical public link",
    );
  });
});
