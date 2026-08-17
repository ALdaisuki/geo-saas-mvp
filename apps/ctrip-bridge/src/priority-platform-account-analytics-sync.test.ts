import { describe, expect, it, vi } from "vitest";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";
import {
  DefaultPriorityPlatformAccountAnalyticsRefreshService,
  type PriorityPlatformAnalyticsControlPlane,
} from "./priority-platform-account-analytics-sync.js";

const accountId = "10000000-0000-4000-8000-000000000004";
const lease = {
  channelAccountId: accountId,
  leaseExpiresAt: "2026-08-11T05:10:00.000Z",
};
const authenticatedReadiness = {
  schemaVersion: "geo.ctrip-operational-readiness.v1" as const,
  status: "unavailable" as const,
  observedAt: "2026-08-11T05:00:00.000Z",
  manifestVersion: "test",
  sessionEvidenceHash: "e".repeat(64),
  evidenceHash: "f".repeat(64),
  authenticated: true,
};
const observation = {
  platform: "toutiao" as const,
  reportPeriod: "内容管理最近 1 条",
  publishCount: 1,
  totalImpressions: 10,
  totalReads: 3,
  totalLikes: 1,
  totalComments: 0,
  works: [],
  sourceHash: "a".repeat(64),
  observedAt: "2026-08-05T03:00:00.000Z",
};

const baijiahaoObservation = {
  platform: "baijiahao" as const,
  reportPeriod: "统计近30日发布成功的作品数据；平台未提供展现、总点赞、总评论",
  publishCount: 1,
  totalImpressions: null,
  totalReads: 63,
  totalLikes: null,
  totalComments: null,
  works: [] as const,
  sourceHash: "b".repeat(64),
  observedAt: "2026-08-07T03:00:00.000Z",
};

const sohuObservation = {
  platform: "sohu" as const,
  reportPeriod: "内容管理最近 1 条已发布作品",
  publishCount: 1,
  totalImpressions: null,
  totalReads: 28,
  totalLikes: null,
  totalComments: 2,
  works: [],
  sourceHash: "c".repeat(64),
  observedAt: "2026-08-11T04:00:00.000Z",
};

const neteaseObservation = {
  platform: "netease" as const,
  reportPeriod: "内容管理最近 1 条已发布作品",
  publishCount: 1,
  totalImpressions: 10,
  totalReads: 3,
  totalLikes: 1,
  totalComments: 0,
  works: [],
  sourceHash: "d".repeat(64),
  observedAt: "2026-08-11T04:00:00.000Z",
};

function controlPlane(): PriorityPlatformAnalyticsControlPlane {
  return {
    claimNextPriorityPlatformAnalyticsRefresh: vi.fn(async () => lease),
    completePriorityPlatformAnalyticsRefresh: vi.fn(async () => undefined),
    failPriorityPlatformAnalyticsRefresh: vi.fn(async () => undefined),
  };
}

describe("priority-platform account analytics refresh service", () => {
  it("does not claim analytics work while browser delivery is pending", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = { withSession: vi.fn() };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
      deliveryPending: vi.fn(async () => true),
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(false);
    expect(port.claimNextPriorityPlatformAnalyticsRefresh).not.toHaveBeenCalled();
    expect(sessions.withSession).not.toHaveBeenCalled();
  });

  it("does not claim an analytics lease while browser-host admission is paused", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(),
    };
    const admissionGate = { canClaim: vi.fn(async () => false) };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
      admissionGate,
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(false);
    expect(admissionGate.canClaim).toHaveBeenCalledTimes(1);
    expect(port.claimNextPriorityPlatformAnalyticsRefresh).not.toHaveBeenCalled();
    expect(sessions.withSession).not.toHaveBeenCalled();
  });

  it("releases a leased analytics refresh when the browser operation times out", async () => {
    vi.useFakeTimers();
    try {
      const port = controlPlane();
      const events: string[] = [];
      vi.mocked(port.failPriorityPlatformAnalyticsRefresh).mockImplementationOnce(async () => {
        events.push("fail");
      });
      const sessions: CtripAccountBrowserSessionProvider = {
        withSession: async (_channelAccountId, operation, options) => {
          try {
            return await operation({
              platform: "sohu",
              readiness: vi.fn(() => new Promise(() => undefined)),
              toutiaoAnalyticsCollector: null,
              baijiahaoAnalyticsCollector: null,
              sohuAnalyticsCollector: { collect: vi.fn(async () => sohuObservation) },
              neteaseAnalyticsCollector: null,
            } as unknown as CtripBrowserReviewSession);
          } finally {
            if (options?.destroyAfterOperation === true) events.push("destroy");
          }
        },
      };
      const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
        tenantId: "10000000-0000-4000-8000-000000000001",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
        controlPlane: port,
        sessions,
        operationTimeoutMs: 1_000,
      });

      const refresh = service.refreshNext("analytics-request");
      const rejection = expect(refresh).rejects.toThrow("PRIORITY_PLATFORM_ANALYTICS_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(port.failPriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
        expect.any(Object),
        accountId,
        lease.leaseExpiresAt,
        "PRIORITY_PLATFORM_ANALYTICS_TIMEOUT",
        expect.stringContaining("timed out"),
      );
      expect(events).toEqual(["destroy", "fail"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collects one leased Toutiao account and destroys its runtime before lease release", async () => {
    const port = controlPlane();
    const events: string[] = [];
    vi.mocked(port.completePriorityPlatformAnalyticsRefresh).mockImplementationOnce(async () => {
      events.push("complete");
    });
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation, options) => {
        try {
          return await operation({
            platform: "toutiao",
            readiness: vi.fn(async () => authenticatedReadiness),
            toutiaoAnalyticsCollector: {
              collect: vi.fn(async () => {
                events.push("collect");
                return observation;
              }),
            },
            baijiahaoAnalyticsCollector: null,
          } as unknown as CtripBrowserReviewSession);
        } finally {
          if (options?.destroyAfterOperation === true) events.push("destroy");
        }
      },
    };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(true);
    expect(port.completePriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "analytics-request" }),
      accountId,
      lease.leaseExpiresAt,
      observation,
    );
    expect(events).toEqual(["collect", "destroy", "complete"]);
  });

  it("persists an adapter-drift retry without writing a snapshot", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async () => {
        throw new Error("TOUTIAO_ANALYTICS_ADAPTER_DRIFT: metric nodes changed");
      },
    };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).rejects.toThrow(/metric nodes/u);
    expect(port.failPriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      lease.leaseExpiresAt,
      "TOUTIAO_ANALYTICS_ADAPTER_DRIFT",
      "TOUTIAO_ANALYTICS_ADAPTER_DRIFT: metric nodes changed",
    );
    expect(port.completePriorityPlatformAnalyticsRefresh).not.toHaveBeenCalled();
  });

  it("routes Baijiahao to its account collector and preserves absent native metrics", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation) =>
        operation({
          platform: "baijiahao",
          readiness: vi.fn(async () => authenticatedReadiness),
          toutiaoAnalyticsCollector: null,
          baijiahaoAnalyticsCollector: { collect: vi.fn(async () => baijiahaoObservation) },
        } as unknown as CtripBrowserReviewSession),
    };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).resolves.toBe(true);
    expect(port.completePriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      lease.leaseExpiresAt,
      baijiahaoObservation,
    );
  });

  it("records a Baijiahao challenge as a manual-verification downgrade", async () => {
    const port = controlPlane();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async () => {
        throw new Error(
          "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED: 人工完成百家号滑块或扫码验证后可重新采集",
        );
      },
    };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).rejects.toThrow(
      "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED",
    );
    expect(port.failPriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      lease.leaseExpiresAt,
      "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED",
      expect.stringContaining("人工完成百家号滑块"),
    );
  });

  it.each([
    ["sohu", "sohuAnalyticsCollector", sohuObservation],
    ["netease", "neteaseAnalyticsCollector", neteaseObservation],
  ] as const)(
    "routes %s to its native account collector",
    async (platform, collectorName, result) => {
      const port = controlPlane();
      const sessions: CtripAccountBrowserSessionProvider = {
        withSession: async (_channelAccountId, operation) =>
          operation({
            platform,
            readiness: vi.fn(async () => authenticatedReadiness),
            toutiaoAnalyticsCollector: null,
            baijiahaoAnalyticsCollector: null,
            sohuAnalyticsCollector:
              collectorName === "sohuAnalyticsCollector"
                ? { collect: vi.fn(async () => result) }
                : null,
            neteaseAnalyticsCollector:
              collectorName === "neteaseAnalyticsCollector"
                ? { collect: vi.fn(async () => result) }
                : null,
          } as unknown as CtripBrowserReviewSession),
      };
      const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
        tenantId: "10000000-0000-4000-8000-000000000001",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
        controlPlane: port,
        sessions,
      });

      await expect(service.refreshNext("analytics-request")).resolves.toBe(true);
      expect(port.completePriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
        expect.any(Object),
        accountId,
        lease.leaseExpiresAt,
        result,
      );
    },
  );

  it("fails closed before collection when the browser identity is not authenticated", async () => {
    const port = controlPlane();
    const collect = vi.fn(async () => sohuObservation);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation) =>
        operation({
          platform: "sohu",
          readiness: vi.fn(async () => ({
            ...authenticatedReadiness,
            status: "session_required",
            authenticated: false,
          })),
          toutiaoAnalyticsCollector: null,
          baijiahaoAnalyticsCollector: null,
          sohuAnalyticsCollector: { collect },
          neteaseAnalyticsCollector: null,
        } as unknown as CtripBrowserReviewSession),
    };
    const service = new DefaultPriorityPlatformAccountAnalyticsRefreshService({
      tenantId: "10000000-0000-4000-8000-000000000001",
      bridgePrincipalId: "10000000-0000-4000-8000-000000000002",
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshNext("analytics-request")).rejects.toThrow(
      "PRIORITY_PLATFORM_ANALYTICS_ACCOUNT_IDENTITY_MISMATCH",
    );
    expect(collect).not.toHaveBeenCalled();
    expect(port.failPriorityPlatformAnalyticsRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      accountId,
      lease.leaseExpiresAt,
      "PRIORITY_PLATFORM_ANALYTICS_ACCOUNT_IDENTITY_MISMATCH",
      expect.stringContaining("authenticated account identity"),
    );
  });
});
