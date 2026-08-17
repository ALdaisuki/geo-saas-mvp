import { describe, expect, it, vi } from "vitest";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import {
  DefaultCtripAccountAnalyticsRefreshService,
  type CtripAnalyticsControlPlane,
} from "./account-analytics-sync.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";

const accountId = "10000000-0000-4000-8000-000000000004";
const observation = {
  reportPeriod: "2026-07-01 至 2026-07-31",
  publishCount: 6,
  featuredCount: 2,
  qualityCount: 3,
  featuredQualityRate: 83.3,
  contentHeat: 260,
  totalViews: 213,
  totalViewers: 172,
  totalLikes: 5,
  totalFavorites: 3,
  totalComments: 2,
  totalInteractions: 11,
  totalInteractors: 9,
  trafficSources: { 推荐: 60, 搜索: 40 },
  works: [],
  sourceHash: "a".repeat(64),
  observedAt: "2026-07-31T04:35:00.000Z",
} as const;

function controlPlane(): CtripAnalyticsControlPlane {
  return {
    claimNextAnalyticsRefresh: vi.fn(async () => accountId),
    completeAnalyticsRefresh: vi.fn(async () => undefined),
    failAnalyticsRefresh: vi.fn(async () => undefined),
  };
}

describe("Ctrip account analytics refresh service", () => {
  it("does not claim analytics work while browser delivery is pending", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = { withSession: vi.fn() };
    const service = new DefaultCtripAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
      deliveryPending: vi.fn(async () => true),
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(false);
    expect(port.claimNextAnalyticsRefresh).not.toHaveBeenCalled();
    expect(sessions.withSession).not.toHaveBeenCalled();
  });

  it("collects one leased account and destroys its runtime before releasing the lease", async () => {
    const port = controlPlane();
    const events: string[] = [];
    vi.mocked(port.completeAnalyticsRefresh).mockImplementationOnce(async () => {
      events.push("complete");
    });
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation, options) => {
        try {
          return await operation({
            analyticsCollector: {
              collect: vi.fn(async () => {
                events.push("collect");
                return observation;
              }),
            },
          } as unknown as CtripBrowserReviewSession);
        } finally {
          if (options?.destroyAfterOperation === true) events.push("destroy");
        }
      },
    };
    const service = new DefaultCtripAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(true);
    expect(port.completeAnalyticsRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "analytics-request" }),
      accountId,
      observation,
    );
    expect(port.failAnalyticsRefresh).not.toHaveBeenCalled();
    expect(events).toEqual(["collect", "destroy", "complete"]);
  });

  it("destroys the account runtime before persisting a failed refresh", async () => {
    const port = controlPlane();
    const events: string[] = [];
    vi.mocked(port.failAnalyticsRefresh).mockImplementationOnce(async () => {
      events.push("fail");
    });
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, _operation, options) => {
        try {
          throw new Error("CTRIP_ANALYTICS_ADAPTER_DRIFT: missing 内容热度");
        } finally {
          if (options?.destroyAfterOperation === true) events.push("destroy");
        }
      },
    };
    const service = new DefaultCtripAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).rejects.toThrow(/missing 内容热度/u);
    expect(port.failAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      "CTRIP_ANALYTICS_ADAPTER_DRIFT",
      "CTRIP_ANALYTICS_ADAPTER_DRIFT: missing 内容热度",
    );
    expect(port.completeAnalyticsRefresh).not.toHaveBeenCalled();
    expect(events).toEqual(["destroy", "fail"]);
  });

  it("records platform metrics that are not ready as data pending", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async () => {
        throw new Error("CTRIP_ANALYTICS_DATA_PENDING: platform metrics are not available yet");
      },
    };
    const service = new DefaultCtripAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).rejects.toThrow(
      /platform metrics are not available yet/u,
    );
    expect(port.failAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      "CTRIP_ANALYTICS_DATA_PENDING",
      "CTRIP_ANALYTICS_DATA_PENDING: platform metrics are not available yet",
    );
    expect(port.completeAnalyticsRefresh).not.toHaveBeenCalled();
  });

  it("does not open a browser session when no account is due", async () => {
    const port = controlPlane();
    vi.mocked(port.claimNextAnalyticsRefresh).mockResolvedValueOnce(null);
    const sessions: CtripAccountBrowserSessionProvider = { withSession: vi.fn() };
    const service = new DefaultCtripAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(false);
    expect(sessions.withSession).not.toHaveBeenCalled();
  });
});
