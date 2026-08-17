import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightCtripAccountAnalyticsCollector,
  CTRIP_ANALYTICS_URL,
  type PlaywrightCtripAccountLocator,
  type PlaywrightCtripAccountPage,
} from "./playwright-account-analytics-collector.js";

function pageFixture(
  initialKind: "overview" | "browse" | "interaction" | "detail",
  options: {
    readonly detailTabVisibleAfterChecks?: number;
    readonly detailRowsVisibleAfterSnapshots?: number;
    readonly transientNavigationFailures?: number;
    readonly selectedSelectors?: string[];
    readonly onClose?: () => void;
    readonly pendingMetrics?: boolean;
  } = {},
): PlaywrightCtripAccountPage {
  let kind: "overview" | "browse" | "interaction" | "detail" | "error" = initialKind;
  let detailPage = 0;
  let detailSnapshots = 0;
  let detailTabVisibilityChecks = 0;
  let navigationAttempts = 0;
  const locator = (selector: string): PlaywrightCtripAccountLocator => {
    const target: PlaywrightCtripAccountLocator = {
      count: async () => 1,
      nth: () => target,
      first: () => target,
      isVisible: async () => {
        if (kind === "error") return false;
        if (selector.includes("单条分析") && options.detailTabVisibleAfterChecks !== undefined) {
          detailTabVisibilityChecks += 1;
          return detailTabVisibilityChecks > options.detailTabVisibleAfterChecks;
        }
        return true;
      },
      getAttribute: async () => null,
      hover: async () => undefined,
      fill: async () => undefined,
      textContent: async () => null,
      click: async () => {
        options.selectedSelectors?.push(selector);
        if (selector.includes("内容概况")) kind = "overview";
        if (selector.includes(':text-is("浏览")')) kind = "browse";
        if (selector.includes(':text-is("互动")')) kind = "interaction";
        if (selector.includes("单条分析")) kind = "detail";
        if (selector.includes("pagination-next")) detailPage += 1;
      },
      setInputFiles: async () => undefined,
    };
    return target;
  };
  return {
    url: () => CTRIP_ANALYTICS_URL,
    locator,
    bringToFront: async () => undefined,
    goto: async () => {
      navigationAttempts += 1;
      if (navigationAttempts <= (options.transientNavigationFailures ?? 0)) {
        kind = "error";
        return;
      }
      kind = "overview";
      detailPage = 0;
      detailSnapshots = 0;
    },
    waitForLoadState: async () => undefined,
    close: async () => options.onClose?.(),
    evaluate: async <Result>() => {
      if (kind === "error") {
        return {
          bodyText: "很抱歉，系统暂时开小差了，请稍后再试！",
          rows: [],
          hasNext: false,
        } as Result;
      }
      if (kind === "overview") {
        return {
          bodyText: options.pendingMetrics
            ? "数据周期：2026-07-01 至 2026-07-31\n发布数 --\n精选数 --\n优质数 --\n精优率 --\n内容热度为--"
            : "数据周期：2026-07-01 至 2026-07-31\n发布数 6\n精选数 2\n优质数 3\n精优率 83.3%\n内容热度为260\n推荐 60%\n搜索 30%\n其他 10%",
          rows: [],
          hasNext: false,
        } as Result;
      }
      if (kind === "browse") {
        return {
          bodyText: options.pendingMetrics
            ? "数据周期：2026-07-01 至 2026-07-31\n浏览数 --\n主页访客 --\n人均观看时长 --\n完播率 --"
            : "数据周期：2026-07-01 至 2026-07-31\n浏览数 460\n主页访客 0\n人均观看时长 0\n完播率 0\n推荐 60%\n搜索 30%\n其他 10%",
          rows: [],
          hasNext: false,
        } as Result;
      }
      if (kind === "interaction") {
        return {
          bodyText: options.pendingMetrics
            ? "点赞数 --\n收藏数 --\n评论数 --\n分享数 --\n涨粉数 --"
            : "点赞数 12\n收藏数 4\n评论数 0\n分享数 0\n涨粉数 0",
          rows: [],
          hasNext: false,
        } as Result;
      }
      detailSnapshots += 1;
      const rowsPending = detailSnapshots <= (options.detailRowsVisibleAfterSnapshots ?? 0);
      return (
        detailPage === 0
          ? {
              bodyText: "单条分析 作品名称 发布时间 浏览次数 浏览人数 互动次数 互动人数",
              rows: rowsPending
                ? []
                : [
                    [
                      "青岛亲子七日慢游",
                      "2026-07-20 10:00",
                      ...(options.pendingMetrics
                        ? (["--", "--", "--", "--"] as const)
                        : (["148", "120", "8", "7"] as const)),
                    ],
                    ["青岛出发跟团怎么选", "2026-07-21 10:00", "65", "52", "3", "2"],
                  ],
              hasNext: !rowsPending,
            }
          : {
              bodyText: "单条分析 作品名称 发布时间 浏览次数 浏览人数 互动次数 互动人数",
              rows: [["签约出境跟团别只看总价", "2026-07-22 10:00", "1.2万", "9000", "29", "21"]],
              hasNext: false,
            }
      ) as Result;
    },
  };
}

describe("Playwright Ctrip account analytics collector", () => {
  it("rejects platform placeholders instead of recording a false zero snapshot", async () => {
    const overview = pageFixture("overview", { pendingMetrics: true });
    const detail = pageFixture("detail", { pendingMetrics: true });
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview, detail],
      openPage: vi.fn(),
      wait: async () => undefined,
      hydrationAttempts: 2,
    });

    await expect(collector.collect()).rejects.toThrow(
      "CTRIP_ANALYTICS_DATA_PENDING: platform metrics are not available yet",
    );
  });

  it("keeps overview and work analysis in two tabs and aggregates every work page", async () => {
    const selectedSelectors: string[] = [];
    const overview = pageFixture("overview", { selectedSelectors });
    const detail = pageFixture("detail");
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview, detail],
      openPage: vi.fn(),
      now: () => new Date("2026-07-31T04:35:00.000Z"),
      wait: async () => undefined,
      hydrationAttempts: 2,
    });

    await expect(collector.collect()).resolves.toMatchObject({
      reportPeriod: "2026-07-01 至 2026-07-31",
      publishCount: 6,
      featuredCount: 2,
      qualityCount: 3,
      featuredQualityRate: 83.3,
      contentHeat: 260,
      totalViews: 460,
      totalViewers: 9_172,
      totalLikes: 12,
      totalFavorites: 4,
      totalComments: 0,
      totalInteractions: 16,
      totalInteractors: 30,
      trafficSources: { 推荐: 60, 搜索: 30, 其他: 10 },
      observedAt: "2026-07-31T04:35:00.000Z",
      works: [
        expect.objectContaining({ title: "青岛亲子七日慢游", views: 148 }),
        expect.objectContaining({ title: "青岛出发跟团怎么选", views: 65 }),
        expect.objectContaining({ title: "签约出境跟团别只看总价", views: 12_000 }),
      ],
    });
    const result = await collector.collect();
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(selectedSelectors).toContain('[role="tab"]:text-is("浏览")');
    expect(selectedSelectors).toContain('[role="tab"]:text-is("互动")');
    expect(selectedSelectors).not.toContain("text=浏览");
  });

  it("opens the missing fixed analysis tab without reusing the overview page", async () => {
    const overview = pageFixture("overview");
    const detail = pageFixture("detail");
    const openPage = vi.fn(async () => detail);
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview],
      openPage,
      wait: async () => undefined,
      hydrationAttempts: 2,
    });

    await collector.collect();

    expect(openPage).toHaveBeenCalledOnce();
    expect(openPage).toHaveBeenCalledWith(CTRIP_ANALYTICS_URL);
  });

  it("waits for the single-work tab to hydrate before selecting it", async () => {
    const overview = pageFixture("overview");
    const delayedDetail = pageFixture("detail", { detailTabVisibleAfterChecks: 1 });
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview, delayedDetail],
      openPage: vi.fn(),
      wait: async () => undefined,
      hydrationAttempts: 3,
    });

    const observation = await collector.collect();
    expect(observation.works).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "青岛亲子七日慢游" })]),
    );
  });

  it("does not accept the single-work table header before its rows hydrate", async () => {
    const overview = pageFixture("overview");
    const delayedRows = pageFixture("detail", { detailRowsVisibleAfterSnapshots: 1 });
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview, delayedRows],
      openPage: vi.fn(),
      wait: async () => undefined,
      hydrationAttempts: 3,
    });

    const observation = await collector.collect();
    expect(observation.works).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "青岛亲子七日慢游" })]),
    );
  });

  it("reloads a fixed analysis tab after Ctrip returns its transient error page", async () => {
    const overview = pageFixture("overview");
    const transientDetail = pageFixture("detail", { transientNavigationFailures: 1 });
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [overview, transientDetail],
      openPage: vi.fn(),
      wait: async () => undefined,
      hydrationAttempts: 3,
    });

    const observation = await collector.collect();
    expect(observation.works).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "青岛亲子七日慢游" })]),
    );
  });

  it("replaces a fixed analysis tab when Ctrip's transient error page remains stuck", async () => {
    const onClose = vi.fn();
    const stuckOverview = pageFixture("overview", {
      transientNavigationFailures: 20,
      onClose,
    });
    const detail = pageFixture("detail");
    const replacement = pageFixture("overview");
    const openPage = vi.fn(async () => replacement);
    const collector = createPlaywrightCtripAccountAnalyticsCollector({
      pages: () => [stuckOverview, detail],
      openPage,
      wait: async () => undefined,
      hydrationAttempts: 2,
    });

    await expect(collector.collect()).resolves.toMatchObject({
      totalViews: 460,
      totalLikes: 12,
      totalFavorites: 4,
      totalComments: 0,
      totalInteractions: 16,
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(openPage).toHaveBeenCalledWith(CTRIP_ANALYTICS_URL);
  });
});
