import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CtripAccountBrowserUnresponsiveError,
  DefaultCtripAccountBrowserSessionProvider,
} from "./account-browser-session-provider.js";
import type { requestBoundedCdpDiscoveryViaHttp, requestBoundedCdpStopViaHttp } from "./config.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";

const accountA = "10000000-0000-4000-8000-000000000004";
const accountB = "10000000-0000-4000-8000-000000000005";

const stoppedDiscovery: typeof requestBoundedCdpDiscoveryViaHttp = async () => ({
  statusCode: 404,
  contentType: "application/json",
  body: JSON.stringify({ error: "account browser session is not active" }),
});

function fakeSession(close: () => Promise<void>): CtripBrowserReviewSession {
  return {
    inspect: vi.fn(),
    readiness: vi.fn(),
    navigateToLogin: vi.fn(),
    draftWriter: {} as CtripBrowserReviewSession["draftWriter"],
    supervisedSubmitWriter: {} as CtripBrowserReviewSession["supervisedSubmitWriter"],
    publicReadbackWriter: {} as CtripBrowserReviewSession["publicReadbackWriter"],
    analyticsCollector: {} as CtripBrowserReviewSession["analyticsCollector"],
    toutiaoAnalyticsCollector: null,
    baijiahaoAnalyticsCollector: null,
    sohuAnalyticsCollector: null,
    neteaseAnalyticsCollector: null,
    platform: "ctrip_community",
    expectedAccountName: "携程运营号",
    platformPublicationAdapter: null,
    platformMediaWriter: null,
    close,
  };
}

describe("Ctrip account browser session provider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and releases each account with its own persistent profile binding", async () => {
    const closes: string[] = [];
    const connectSession = vi.fn(async (options) =>
      fakeSession(async () => {
        closes.push(options.channelAccountId ?? "missing");
      }),
    );
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "authenticated",
      }),
      connectSession,
    });

    await provider.withSession(accountA, async () => undefined);
    await provider.withSession(accountB, async () => undefined);

    expect(connectSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channelAccountId: accountA,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${accountA}`,
      }),
    );
    expect(connectSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channelAccountId: accountB,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${accountB}`,
      }),
    );
    expect(closes).toEqual([accountA, accountB]);
  });

  it("keeps operations for one account serial while different accounts use global capacity", async () => {
    let release!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const connectSession = vi.fn(async () => fakeSession(async () => undefined));
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      maxConcurrentSessions: 2,
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "authenticated",
      }),
      connectSession,
    });
    const operation = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await operationGate;
      active -= 1;
    };

    const firstAccountOperation = provider.withSession(accountA, operation);
    const queuedSameAccountOperation = provider.withSession(accountA, operation);
    const differentAccountOperation = provider.withSession(accountB, operation);
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);

    release();
    await Promise.all([
      firstAccountOperation,
      queuedSameAccountOperation,
      differentAccountOperation,
    ]);
    expect(connectSession).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
  });

  it("rejects a disabled account before opening a browser connection", async () => {
    const connectSession = vi.fn();
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "disabled",
      }),
      connectSession,
    });

    await expect(provider.withSession(accountA, async () => undefined)).rejects.toThrow(
      /unavailable/iu,
    );
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("stops and retries a hung Linux CDP connection once", async () => {
    const connectSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("Timeout exceeded while waiting for browser.connectOverCDP"))
      .mockResolvedValueOnce(fakeSession(async () => undefined));
    const stopSession = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", accountId: accountA }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "authenticated",
      }),
      connectSession,
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await provider.withSession(accountA, async () => undefined);

    expect(connectSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledTimes(1);
    const stopUrl = vi.mocked(stopSession).mock.calls[0]?.[0] as URL;
    expect(stopUrl.pathname).toBe(`/accounts/${accountA}/stop`);
    expect(stopUrl.host).toBe("browser-host:10005");
  });

  it("destroys an account session through the Linux browser-host stop route", async () => {
    const stopSession = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", accountId: accountA }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(),
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await provider.destroySession(accountA);

    expect(stopSession).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${accountA}/stop`),
      "127.0.0.1:10005",
    );
  });

  it("retries a transient connected-session rejection after the CDP connection closes", async () => {
    vi.useFakeTimers();
    try {
      const stopSession = vi
        .fn()
        .mockResolvedValueOnce({
          statusCode: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "account browser session could not be terminated" }),
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok", accountId: accountA }),
        }) as typeof requestBoundedCdpStopViaHttp;
      const provider = new DefaultCtripAccountBrowserSessionProvider({
        httpEndpoint: "http://browser-host:10005",
        runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
        transport: "linux_service",
        loadBinding: async (channelAccountId) => ({
          channelAccountId,
          platform: "toutiao",
          expectedAccountName: "头条运营号",
          profileKey: `ctrip-account-${channelAccountId}`,
          sessionState: "ready",
        }),
        connectSession: vi.fn(),
        stopSession,
        discoverSession: stoppedDiscovery,
      });

      const destroy = provider.destroySession(accountA);
      await vi.runAllTimersAsync();
      await expect(destroy).resolves.toBe(true);
      expect(stopSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an already-stopped browser-host session as successfully destroyed", async () => {
    const stopSession = vi.fn(async () => ({
      statusCode: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "account browser session is not active" }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(),
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await expect(provider.destroySession(accountA)).resolves.toBe(true);
  });

  it.each([200, 500])(
    "rejects a 404 stop response when discovery still returns %s",
    async (discoveryStatusCode) => {
      const provider = new DefaultCtripAccountBrowserSessionProvider({
        httpEndpoint: "http://browser-host:10005",
        runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
        transport: "linux_service",
        loadBinding: async (channelAccountId) => ({
          channelAccountId,
          platform: "toutiao",
          expectedAccountName: "头条运营号",
          profileKey: `ctrip-account-${channelAccountId}`,
          sessionState: "ready",
        }),
        connectSession: vi.fn(),
        stopSession: vi.fn(async () => ({
          statusCode: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "account browser session is not active" }),
        })) as typeof requestBoundedCdpStopViaHttp,
        discoverSession: async () => ({
          statusCode: discoveryStatusCode,
          contentType: "application/json",
          body: JSON.stringify({}),
        }),
      });

      await expect(provider.destroySession(accountA)).rejects.toThrow(
        "Ctrip account browser stop was rejected",
      );
    },
  );

  it("opens a fresh account connection when asynchronous readback follows teardown", async () => {
    const events: string[] = [];
    const connectSession = vi.fn(async () => {
      events.push("connect");
      return fakeSession(async () => {
        events.push("close-cdp");
      });
    });
    const stopSession = vi.fn(async () => {
      events.push("stop-runtime");
      return {
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", accountId: accountA }),
      };
    }) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "ctrip_community",
        expectedAccountName: "携程运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "authenticated",
      }),
      connectSession,
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await provider.destroySession(accountA);
    await provider.withSession(accountA, async () => {
      events.push("readback");
    });

    expect(events).toEqual(["stop-runtime", "connect", "readback", "close-cdp"]);
    expect(connectSession).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight account operation before destroying its browser session", async () => {
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const stopSession = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", accountId: accountA }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () => fakeSession(async () => undefined)),
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    const operation = provider.withSession(accountA, async () => {
      operationStarted();
      await operationGate;
    });
    await started;
    const destroy = provider.destroySession(accountA);
    await Promise.resolve();
    expect(stopSession).not.toHaveBeenCalled();

    releaseOperation();
    await Promise.all([operation, destroy]);
    expect(stopSession).toHaveBeenCalledOnce();
  });

  it("destroys a disposable runtime before the next queued operation for the same account", async () => {
    const events: string[] = [];
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () => {
        events.push("connect");
        return fakeSession(async () => {
          events.push("close-cdp");
        });
      }),
      stopSession: vi.fn(async () => {
        events.push("stop-runtime");
        return {
          statusCode: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok", accountId: accountA }),
        };
      }) as typeof requestBoundedCdpStopViaHttp,
      discoverSession: stoppedDiscovery,
    });

    const first = provider.withSession(
      accountA,
      async () => {
        events.push("first-operation");
        operationStarted();
        await operationGate;
      },
      { destroyAfterOperation: true },
    );
    await started;
    const second = provider.withSession(accountA, async () => {
      events.push("second-operation");
    });
    releaseOperation();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "connect",
      "first-operation",
      "close-cdp",
      "stop-runtime",
      "connect",
      "second-operation",
      "close-cdp",
    ]);
  });

  it("reports disposable runtime cleanup failure without replacing the operation result", async () => {
    const cleanupError = vi.fn();
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () => fakeSession(async () => undefined)),
      stopSession: vi.fn(async () => ({
        statusCode: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "stop failed" }),
      })) as typeof requestBoundedCdpStopViaHttp,
      discoverSession: stoppedDiscovery,
    });

    await expect(
      provider.withSession(accountA, async () => "collected", {
        destroyAfterOperation: true,
        onDestroyError: cleanupError,
      }),
    ).resolves.toBe("collected");
    expect(cleanupError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("preserves an operation failure when disposable runtime cleanup also fails", async () => {
    const cleanupError = vi.fn();
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () => fakeSession(async () => undefined)),
      stopSession: vi.fn(async () => ({
        statusCode: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "stop failed" }),
      })) as typeof requestBoundedCdpStopViaHttp,
      discoverSession: stoppedDiscovery,
    });

    await expect(
      provider.withSession(
        accountA,
        async () => {
          throw new Error("analytics adapter drift");
        },
        {
          destroyAfterOperation: true,
          onDestroyError: cleanupError,
        },
      ),
    ).rejects.toThrow("analytics adapter drift");
    expect(cleanupError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys a hung Linux CDP operation after the bounded operation timeout", async () => {
    vi.useFakeTimers();
    const connectSession = vi.fn(async () => fakeSession(async () => undefined));
    const stopSession = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", accountId: accountA }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      operationTimeoutMs: 30_000,
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession,
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    const pending = provider.withSession(accountA, () => new Promise<never>(() => undefined));
    const assertion = expect(pending).rejects.toBeInstanceOf(CtripAccountBrowserUnresponsiveError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(stopSession).toHaveBeenCalledOnce();
    const stopUrl = vi.mocked(stopSession).mock.calls[0]?.[0] as URL;
    expect(stopUrl.pathname).toBe(`/accounts/${accountA}/stop`);
  });

  it("closes the CDP connection before stopping a runtime after an operation failure", async () => {
    const events: string[] = [];
    const stopSession = vi.fn(async () => {
      events.push("stop-runtime");
      return {
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", accountId: accountA }),
      };
    }) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () =>
        fakeSession(async () => {
          events.push("close-cdp");
        }),
      ),
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await expect(
      provider.withSession(accountA, async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    ).rejects.toThrow("Target page");

    expect(events).toEqual(["close-cdp", "stop-runtime"]);
  });

  it("does not stop a runtime when CDP close cannot be confirmed after an operation failure", async () => {
    const stopSession = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", accountId: accountA }),
    })) as typeof requestBoundedCdpStopViaHttp;
    const provider = new DefaultCtripAccountBrowserSessionProvider({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      loadBinding: async (channelAccountId) => ({
        channelAccountId,
        platform: "toutiao",
        expectedAccountName: "头条运营号",
        profileKey: `ctrip-account-${channelAccountId}`,
        sessionState: "ready",
      }),
      connectSession: vi.fn(async () =>
        fakeSession(async () => {
          throw new Error("CDP socket close failed");
        }),
      ),
      stopSession,
      discoverSession: stoppedDiscovery,
    });

    await expect(
      provider.withSession(accountA, async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    ).rejects.toThrow("Target page");

    expect(stopSession).not.toHaveBeenCalled();
  });
});
