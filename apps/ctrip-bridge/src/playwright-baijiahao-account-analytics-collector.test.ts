import { describe, expect, it, vi } from "vitest";

import {
  BAIJIAHAO_ANALYTICS_URL,
  createPlaywrightBaijiahaoAccountAnalyticsCollector,
  type PlaywrightBaijiahaoAnalyticsPage,
} from "./playwright-baijiahao-account-analytics-collector.js";

function pageWithSnapshots(
  snapshots: readonly string[],
): PlaywrightBaijiahaoAnalyticsPage & { readonly gotoMock: ReturnType<typeof vi.fn> } {
  let index = 0;
  const gotoMock = vi.fn(async () => undefined);
  return {
    url: () => BAIJIAHAO_ANALYTICS_URL,
    locator: () => {
      throw new Error("not used");
    },
    bringToFront: async () => undefined,
    goto: gotoMock,
    waitForLoadState: async () => undefined,
    evaluate: async <Result>() =>
      ({ text: snapshots[Math.min(index++, snapshots.length - 1)] }) as Result,
    gotoMock,
  };
}

describe("Baijiahao account analytics collector", () => {
  it("collects only native account-level counters from the official analytics page", async () => {
    const page = pageWithSnapshots([
      "整体数据 统计近30日发布成功的作品数据，每日更新前一天数据，数据更新至2026年8月5日 投稿量 1 阅读/播放量 63 点击率 0% 互动指数 0 条均点赞数 --",
    ]);
    const collector = createPlaywrightBaijiahaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
      now: () => new Date("2026-08-07T03:00:00.000Z"),
    });

    await expect(collector.collect()).resolves.toMatchObject({
      platform: "baijiahao",
      publishCount: 1,
      totalImpressions: null,
      totalReads: 63,
      totalLikes: null,
      totalComments: null,
      works: [],
      observedAt: "2026-08-07T03:00:00.000Z",
    });
    expect(page.gotoMock).toHaveBeenCalledWith(BAIJIAHAO_ANALYTICS_URL, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("explicitly degrades on a slider or scan challenge without interacting with it", async () => {
    const page = pageWithSnapshots([
      "百度安全验证 请完成下方验证后继续操作 拖动左侧滑块使图片为正 扫码验证",
    ]);
    const collector = createPlaywrightBaijiahaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      hydrationAttempts: 1,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow("BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED");
    expect(page.gotoMock).toHaveBeenCalledOnce();
  });

  it("waits only for bounded hydration before reporting pending data", async () => {
    const page = pageWithSnapshots(["整体数据 加载中", "整体数据 加载中"]);
    const wait = vi.fn(async () => undefined);
    const collector = createPlaywrightBaijiahaoAccountAnalyticsCollector({
      pages: () => [page],
      openPage: async () => page,
      wait,
      hydrationAttempts: 2,
      pollMs: 0,
    });

    await expect(collector.collect()).rejects.toThrow("BAIJIAHAO_ANALYTICS_DATA_PENDING");
    expect(wait).toHaveBeenCalledOnce();
  });
});
