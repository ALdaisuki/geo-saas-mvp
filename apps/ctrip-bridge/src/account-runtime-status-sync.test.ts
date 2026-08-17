import { describe, expect, it, vi } from "vitest";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import {
  DefaultCtripAccountRuntimeStatusRefreshService,
  startCtripAccountRuntimeStatusPoller,
  type CtripRuntimeStatusControlPlane,
} from "./account-runtime-status-sync.js";
import type { CtripOperationalReadiness } from "./authenticated-surface-review.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000002";
const accountA = "10000000-0000-4000-8000-000000000004";
const accountB = "10000000-0000-4000-8000-000000000005";

function readiness(
  status: CtripOperationalReadiness["status"],
  authenticated = status === "ready",
): CtripOperationalReadiness {
  return {
    schemaVersion: "geo.ctrip-operational-readiness.v1",
    status,
    observedAt: "2026-08-01T01:00:00.000Z",
    manifestVersion: "ctrip-surface-v1",
    sessionEvidenceHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    authenticated,
  };
}

function controlPlane(accountIds: readonly string[]): CtripRuntimeStatusControlPlane {
  return {
    listRuntimeBindingAccountIds: vi.fn(async () => accountIds),
    recordRuntimeStatus: vi.fn(async () => undefined),
  };
}

describe("Ctrip account runtime status refresh", () => {
  it("repairs stale persisted state without destroying an active publication runtime", async () => {
    const port = controlPlane([accountA]);
    const events: string[] = [];
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (channelAccountId, operation, options) => {
        expect(channelAccountId).toBe(accountA);
        try {
          return await operation({
            readiness: vi.fn(async () => {
              events.push("readiness");
              return readiness("ready");
            }),
          } as unknown as CtripBrowserReviewSession);
        } finally {
          if (options?.destroyAfterOperation === true) events.push("destroy");
        }
      },
    };
    const service = new DefaultCtripAccountRuntimeStatusRefreshService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshAll("runtime-status-request")).resolves.toBe(1);
    expect(port.recordRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "runtime-status-request" }),
      accountA,
      "ready",
      null,
      null,
    );
    expect(events).toEqual(["readiness"]);
  });

  it("keeps an authenticated account schedulable when the editor is not currently open", async () => {
    const port = controlPlane([accountA]);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation) =>
        operation({
          readiness: vi.fn(async () => readiness("unavailable", true)),
        } as unknown as CtripBrowserReviewSession),
    };
    const service = new DefaultCtripAccountRuntimeStatusRefreshService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
    });

    await expect(service.refreshAll("runtime-status-request")).resolves.toBe(1);
    expect(port.recordRuntimeStatus).toHaveBeenCalledWith(
      expect.any(Object),
      accountA,
      "authenticated",
      null,
      null,
    );
  });

  it("continues refreshing later accounts when one browser profile fails", async () => {
    const port = controlPlane([accountA, accountB]);
    const onError = vi.fn();
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (channelAccountId, operation) => {
        if (channelAccountId === accountA) throw new Error("CDP connection unavailable");
        return operation({
          readiness: vi.fn(async () => readiness("ready")),
        } as unknown as CtripBrowserReviewSession);
      },
    };
    const service = new DefaultCtripAccountRuntimeStatusRefreshService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
      onError,
    });

    await expect(service.refreshAll("runtime-status-request")).resolves.toBe(1);
    expect(port.recordRuntimeStatus).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      accountA,
      "unavailable",
      "CTRIP_RUNTIME_STATUS_CHECK_FAILED",
      "CDP connection unavailable",
    );
    expect(port.recordRuntimeStatus).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      accountB,
      "ready",
      null,
      null,
    );
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("Ctrip account runtime status poller", () => {
  it("uses a 30 second default interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const refreshAll = vi.fn(async () => 1);
    const poller = startCtripAccountRuntimeStatusPoller({ services: [{ refreshAll }] });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshAll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(refreshAll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshAll).toHaveBeenCalledTimes(2);

      await poller.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshAll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
