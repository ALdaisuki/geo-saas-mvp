import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  DefaultCtripAccountBrowserReclaimService,
  startCtripAccountBrowserReclaimPoller,
  type CtripAccountBrowserLifecycleControlPlane,
} from "./account-browser-lifecycle.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000002";
const accountA = "10000000-0000-4000-8000-000000000004";
const accountB = "10000000-0000-4000-8000-000000000005";
const cliSource = await readFile(new URL("./cli.ts", import.meta.url), "utf8");

function controlPlane(accountIds: readonly string[]): CtripAccountBrowserLifecycleControlPlane {
  return {
    listBrowserReclaimAccountIds: vi.fn(async () => accountIds),
  };
}

describe("Ctrip account browser lifecycle reclaim", () => {
  it("routes reclaimable handoffs through conditional account reclaim", () => {
    const settledHook = cliSource.slice(
      cliSource.indexOf("onHandoffReclaimable:"),
      cliSource.indexOf("analyticsService:"),
    );

    expect(settledHook).toContain("browserReclaimService?.reclaimAccount(");
    expect(settledHook).not.toContain("sessions.destroySession");
  });

  it("keeps an account browser when the control plane reports queued follow-up work", async () => {
    const port = controlPlane([]);
    const destroySession = vi.fn(async () => true);
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions: { withSession: vi.fn(), destroySession },
    });

    await expect(service.reclaimAccount(accountA, "browser-reclaim-settled-request")).resolves.toBe(
      false,
    );
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("destroys a settled account browser when no follow-up work remains", async () => {
    const port = controlPlane([accountA]);
    const destroySession = vi.fn(async () => true);
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions: { withSession: vi.fn(), destroySession },
    });

    await expect(service.reclaimAccount(accountA, "browser-reclaim-settled-request")).resolves.toBe(
      true,
    );
    expect(destroySession).toHaveBeenCalledWith(accountA, expect.any(Object));
  });

  it("keeps a settled readback successful when reclaim eligibility cannot be loaded", async () => {
    const reclaimError = new Error("reclaim query unavailable");
    const onError = vi.fn();
    const destroySession = vi.fn(async () => true);
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: {
        listBrowserReclaimAccountIds: vi.fn(async () => Promise.reject(reclaimError)),
      },
      sessions: { withSession: vi.fn(), destroySession },
      onError,
    });

    await expect(service.reclaimAccount(accountA, "browser-reclaim-settled-request")).resolves.toBe(
      false,
    );
    expect(destroySession).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(reclaimError);
  });

  it("destroys every account browser whose handoff reached a reclaimable state", async () => {
    const port = controlPlane([accountA, accountB]);
    const destroyed: string[] = [];
    const sessions = {
      withSession: vi.fn(),
      destroySession: async (channelAccountId: string) => {
        destroyed.push(channelAccountId);
        return true;
      },
    };
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
    });

    await expect(service.reclaimAll("browser-reclaim-request")).resolves.toBe(2);
    expect(port.listBrowserReclaimAccountIds).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "browser-reclaim-request" }),
    );
    expect(destroyed).toEqual([accountA, accountB]);
  });

  it("keeps reclaiming later accounts when one stop fails", async () => {
    const port = controlPlane([accountA, accountB]);
    const onError = vi.fn();
    const destroyed: string[] = [];
    const sessions = {
      withSession: vi.fn(),
      destroySession: async (channelAccountId: string) => {
        if (channelAccountId === accountA) throw new Error("browser-host stop unavailable");
        destroyed.push(channelAccountId);
        return true;
      },
    };
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
      onError,
    });

    await expect(service.reclaimAll("browser-reclaim-request")).resolves.toBe(1);
    expect(destroyed).toEqual([accountB]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("skips an account that became busy again before the browser stop", async () => {
    let calls = 0;
    const port: CtripAccountBrowserLifecycleControlPlane = {
      listBrowserReclaimAccountIds: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? [accountA] : [];
      }),
    };
    const destroySession = vi.fn(async (_channelAccountId: string, options) => {
      if (options?.shouldDestroy !== undefined && !(await options.shouldDestroy())) {
        return false;
      }
      return true;
    });
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions: { withSession: vi.fn(), destroySession },
    });
    await expect(service.reclaimAll("browser-reclaim-request")).resolves.toBe(0);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("reclaims independent accounts in parallel while one browser stop is slow", async () => {
    const port = controlPlane([accountA, accountB]);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const order: string[] = [];
    const sessions = {
      withSession: vi.fn(),
      destroySession: async (channelAccountId: string) => {
        if (channelAccountId === accountA) {
          await gateA;
          order.push(accountA);
        } else {
          order.push(accountB);
        }
        return true;
      },
    };
    const service = new DefaultCtripAccountBrowserReclaimService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      sessions,
    });

    const reclaim = service.reclaimAll("browser-reclaim-request");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([accountB]);
    releaseA();
    await expect(reclaim).resolves.toBe(2);
    expect(order).toEqual([accountB, accountA]);
  });
});

describe("Ctrip account browser reclaim poller", () => {
  it("stops cleanly after starting", async () => {
    const services = [
      {
        reclaimAll: vi.fn(async () => 0),
      },
    ];
    const poller = startCtripAccountBrowserReclaimPoller({
      services,
      pollIntervalMs: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await poller.stop();

    expect(services[0]?.reclaimAll).toHaveBeenCalled();
  });
});
