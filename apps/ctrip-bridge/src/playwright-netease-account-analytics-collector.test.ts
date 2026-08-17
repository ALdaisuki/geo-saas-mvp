import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightNeteaseAccountAnalyticsCollector,
  type PlaywrightNeteaseAnalyticsPage,
} from "./playwright-netease-account-analytics-collector.js";
import { NETEASE_CONTENT_MANAGER_URL } from "./playwright-netease-publication.js";

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
): PlaywrightNeteaseAnalyticsPage & { readonly gotoMock: ReturnType<typeof vi.fn> } {
  let index = 0;
  const gotoMock = vi.fn(async () => undefined);
  return {
    url: () => NETEASE_CONTENT_MANAGER_URL,
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

describe("Netease account analytics collector", () => {
  it("collects native counters from published content-management cards", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        challenge: false,
        rows: [
          {
            title: "江西路线与风景体验",
            publishedAt: "创建于8-8 15:41",
            status: "已发布",
            href: "//www.163.com/dy/article/DEMO000000000003.html",
            text: "0次展现 6次观看 2个顶 1跟贴互动 平均阅读进度：11%",
          },
          {
            title: "贵州路线与风景体验",
            publishedAt: "创建于8-8 15:35",
            status: "已发布",
            href: "//www.163.com/dy/article/DEMO000000000002.html",
            text: "1.2万次展现 30次观看 0个顶 0跟贴互动 平均阅读进度：0%",
          },
        ],
      },
    ]);
    const collector = createPlaywrightNeteaseAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
      now: () => new Date("2026-08-11T04:00:00.000Z"),
    });

    await expect(collector.collect()).resolves.toMatchObject({
      platform: "netease",
      reportPeriod: "内容管理最近 2 条已发布作品",
      publishCount: 2,
      totalImpressions: 12_000,
      totalReads: 36,
      totalLikes: 2,
      totalComments: 1,
      observedAt: "2026-08-11T04:00:00.000Z",
      works: [
        {
          externalId: "DEMO000000000003",
          externalUrl: "https://www.163.com/dy/article/DEMO000000000003.html",
          reads: 6,
        },
        {
          externalId: "DEMO000000000002",
          externalUrl: "https://www.163.com/dy/article/DEMO000000000002.html",
          impressions: 12_000,
        },
      ],
    });
    expect(page.gotoMock).toHaveBeenCalledWith(NETEASE_CONTENT_MANAGER_URL, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("reports a real verification challenge instead of adapter drift", async () => {
    const page = pageWithSnapshots([{ rows: [], emptyState: "", challenge: true }]);
    const collector = createPlaywrightNeteaseAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow("NETEASE_ANALYTICS_CHALLENGE_REQUIRED");
  });

  it("fails closed when a published card loses its canonical public link", async () => {
    const page = pageWithSnapshots([
      {
        emptyState: "",
        challenge: false,
        rows: [
          {
            title: "正常作品",
            publishedAt: "创建于8-8 15:41",
            status: "已发布",
            href: "//www.163.com/dy/article/DEMO000000000003.html",
            text: "0次展现 6次观看 2个顶 1跟贴互动",
          },
          {
            title: "链接结构漂移",
            publishedAt: "创建于8-8 15:35",
            status: "已发布",
            href: "/unexpected/published/DEMO000000000002",
            text: "2次展现 1次观看 0个顶 0跟贴互动",
          },
        ],
      },
    ]);
    const collector = createPlaywrightNeteaseAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow(
      "NETEASE_ANALYTICS_ADAPTER_DRIFT: a published work has no canonical public link",
    );
  });
});
