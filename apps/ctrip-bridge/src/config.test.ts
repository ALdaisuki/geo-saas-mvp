import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  ctripBridgeAllowedHosts,
  parseCtripBridgeTenantConfigs,
  requireBridgeHost,
  requireCtripBrowserTenantId,
  requireBrowserPreflightTenant,
  requireCtripBridgeMode,
  requireDockerDesktopCdpEndpoint,
  requireLinuxServiceCdpEndpoint,
  requireLocalCdpEndpoint,
  requireLocalCdpWebSocketEndpoint,
  requireRuntimeTmpRoot,
  requireSimulatorHost,
  requestBoundedCdpStopViaHttp,
  requestBoundedCdpDiscoveryViaHttp,
  resolveCtripBrowserTransport,
  resolveDockerDesktopCdpWebSocketEndpoint,
  resolveLinuxServiceAccountCdpTarget,
  resolveLinuxServiceCdpWebSocketEndpoint,
  resolveLocalCdpWebSocketEndpoint,
} from "./config.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000002";
const accessToken = "ctrip-bridge-config-token-with-safe-length";
const channelAccountId = "10000000-0000-4000-8000-000000000004";
const profileKey = `ctrip-account-${channelAccountId}`;

describe("Ctrip bridge startup configuration", () => {
  it("accepts only exact server-owned tenant bindings", () => {
    expect(
      parseCtripBridgeTenantConfigs(JSON.stringify([{ tenantId, bridgePrincipalId, accessToken }])),
    ).toEqual([{ tenantId, bridgePrincipalId, accessToken }]);
    expect(() =>
      parseCtripBridgeTenantConfigs(
        JSON.stringify([{ tenantId, bridgePrincipalId, accessToken, selector: "#publish" }]),
      ),
    ).toThrow();
  });

  it("rejects duplicate identity or credential material", () => {
    expect(() =>
      parseCtripBridgeTenantConfigs(
        JSON.stringify([
          { tenantId, bridgePrincipalId, accessToken },
          {
            tenantId,
            bridgePrincipalId: "20000000-0000-4000-8000-000000000002",
            accessToken: `${accessToken}-other`,
          },
        ]),
      ),
    ).toThrow(/unique/iu);
  });

  it("binds simulator mode to loopback only", () => {
    expect(requireSimulatorHost("127.0.0.1")).toBe("127.0.0.1");
    expect(() => requireSimulatorHost("0.0.0.0")).toThrow(/loopback/iu);
    expect(requireBridgeHost("0.0.0.0")).toBe("0.0.0.0");
  });

  it("allows the fixed Docker service authority without weakening the bind host", () => {
    expect(ctripBridgeAllowedHosts("0.0.0.0", 9030)).toEqual([
      "0.0.0.0:9030",
      "127.0.0.1:9030",
      "localhost:9030",
      "ctrip-bridge:9030",
    ]);
    expect(ctripBridgeAllowedHosts("127.0.0.1", 9030)).toEqual([
      "127.0.0.1:9030",
      "localhost:9030",
      "ctrip-bridge:9030",
    ]);
    expect(ctripBridgeAllowedHosts("::1", 9030)).toContain("[::1]:9030");
    expect(() => ctripBridgeAllowedHosts("example.com", 9030)).toThrow();
    expect(() => ctripBridgeAllowedHosts("127.0.0.1", 0)).toThrow(/port/iu);
  });

  it("requires an explicit mode and one isolated browser-preflight tenant", () => {
    const tenant = { tenantId, bridgePrincipalId, accessToken };
    expect(requireCtripBridgeMode("simulator")).toBe("simulator");
    expect(requireCtripBridgeMode("browser_preflight")).toBe("browser_preflight");
    expect(requireCtripBridgeMode("browser_draft")).toBe("browser_draft");
    expect(requireCtripBridgeMode("browser_supervised")).toBe("browser_supervised");
    expect(requireCtripBridgeMode("browser_unattended")).toBe("browser_unattended");
    expect(() => requireCtripBridgeMode("live")).toThrow();
    expect(requireBrowserPreflightTenant([tenant])).toEqual(tenant);
    expect(() =>
      requireBrowserPreflightTenant([tenant, { ...tenant, tenantId: bridgePrincipalId }]),
    ).toThrow(/one tenant/iu);
  });

  it("selects browser transport by mode and validates the bound tenant", () => {
    const tenant = { tenantId, bridgePrincipalId, accessToken };
    expect(resolveCtripBrowserTransport("browser_preflight", undefined)).toBe("local");
    for (const mode of ["browser_draft", "browser_supervised", "browser_unattended"] as const) {
      expect(resolveCtripBrowserTransport(mode, undefined)).toBe("docker_desktop");
      expect(resolveCtripBrowserTransport(mode, "linux_service")).toBe("linux_service");
    }
    expect(() => resolveCtripBrowserTransport("simulator", undefined)).toThrow(/simulator/iu);
    expect(() => resolveCtripBrowserTransport("browser_preflight", "")).toThrow();
    expect(() => resolveCtripBrowserTransport("browser_draft", "remote")).toThrow();
    expect(requireCtripBrowserTenantId(tenantId, [tenant])).toBe(tenantId);
    expect(() => requireCtripBrowserTenantId("not-a-uuid", [tenant])).toThrow();
    expect(() => requireCtripBrowserTenantId(bridgePrincipalId, [tenant])).toThrow(/match/iu);
    expect(() => requireCtripBrowserTenantId(tenantId, [tenant, tenant])).toThrow(/one tenant/iu);
  });

  it("uses only the fixed Docker Desktop transport for a containerized browser writer", async () => {
    expect(requireDockerDesktopCdpEndpoint("http://host.docker.internal:9333")).toBe(
      "http://host.docker.internal:9333/",
    );
    for (const endpoint of [
      "http://docker.for.win.localhost:9333",
      "http://example.com:9333",
      "https://host.docker.internal:9333",
      "http://user:secret@host.docker.internal:9333",
      "http://host.docker.internal:9333/json/version",
      "http://host.docker.internal:9333/?header=custom",
    ]) {
      expect(() => requireDockerDesktopCdpEndpoint(endpoint)).toThrow();
    }

    const requests: { readonly url: string; readonly hostHeader: string }[] = [];
    const requester = async (url: URL, hostHeader: string) => {
      requests.push({ url: url.toString(), hostHeader });
      return {
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/draft-session",
        }),
      };
    };
    await expect(
      resolveDockerDesktopCdpWebSocketEndpoint("http://host.docker.internal:9333/", requester),
    ).resolves.toEqual({
      webSocketEndpoint: "ws://host.docker.internal:9333/devtools/browser/draft-session",
      headers: { Host: "127.0.0.1:9333" },
    });
    expect(requests[0]).toEqual({
      url: "http://host.docker.internal:9333/json/version",
      hostHeader: "127.0.0.1:9333",
    });
  });

  it("preserves the loopback Host header over the real HTTP transport", async () => {
    let receivedHost = "";
    const server = createServer((request, response) => {
      receivedHost = request.headers.host ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/real-http",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server unavailable");

    try {
      await expect(
        requestBoundedCdpDiscoveryViaHttp(
          new URL(`http://127.0.0.1:${address.port}/json/version`),
          "127.0.0.1:9333",
        ),
      ).resolves.toMatchObject({
        statusCode: 200,
        contentType: "application/json",
      });
      expect(receivedHost).toBe("127.0.0.1:9333");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("uses only a fixed private Linux service endpoint and rewrites loopback discovery", async () => {
    expect(requireLinuxServiceCdpEndpoint("http://browser-host:10005")).toBe(
      "http://browser-host:10005/",
    );
    for (const endpoint of [
      "http://localhost:10005",
      "http://127.0.0.1:10005",
      "http://host.docker.internal:10005",
      "http://browser_host:10005",
      "http://-browser:10005",
      "http://browser-:10005",
      `http://${"a".repeat(64)}:10005`,
      "http://browser-host:10006",
      "https://browser-host:10005",
      "http://user:secret@browser-host:10005",
      "http://browser-host:10005/json/version",
      "http://browser-host:10005/?token=value",
      "http://browser-host:10005/#fragment",
    ]) {
      expect(() => requireLinuxServiceCdpEndpoint(endpoint)).toThrow();
    }

    const requests: { readonly url: string; readonly hostHeader: string }[] = [];
    const requester = async (url: URL, hostHeader: string) => {
      requests.push({ url: url.toString(), hostHeader });
      return {
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:10005/devtools/browser/linux-session",
        }),
      };
    };
    await expect(
      resolveLinuxServiceCdpWebSocketEndpoint("http://browser-host:10005/", requester),
    ).resolves.toEqual({
      webSocketEndpoint: "ws://browser-host:10005/devtools/browser/linux-session",
      headers: { Host: "127.0.0.1:10005" },
    });
    expect(requests).toEqual([
      {
        url: "http://browser-host:10005/json/version",
        hostHeader: "127.0.0.1:10005",
      },
    ]);

    for (const webSocketDebuggerUrl of [
      "ws://remote.example:10005/devtools/browser/id",
      "ws://127.0.0.1:10006/devtools/browser/id",
      "wss://127.0.0.1:10005/devtools/browser/id",
      "ws://127.0.0.1:10005/devtools/page/id",
      "ws://127.0.0.1:10005/devtools/browser/id?token=value",
      "not-a-url",
    ]) {
      await expect(
        resolveLinuxServiceCdpWebSocketEndpoint("http://browser-host:10005/", async () => ({
          statusCode: 200,
          contentType: "application/json",
          body: JSON.stringify({ webSocketDebuggerUrl }),
        })),
      ).rejects.toThrow();
    }
    await expect(
      resolveLinuxServiceCdpWebSocketEndpoint("http://browser-host:10005/", async () => ({
        statusCode: 503,
        contentType: "application/json",
        body: "{}",
      })),
    ).rejects.toThrow(/discovery failed/iu);
    await expect(
      resolveLinuxServiceCdpWebSocketEndpoint("http://browser-host:10005/", async () => ({
        statusCode: 200,
        contentType: "application/json",
        body: "not-json",
      })),
    ).rejects.toThrow(/invalid/iu);
  });

  it("posts an account-scoped browser stop without a request body", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.headers.host).toBe("127.0.0.1:10005");
      expect(request.headers["content-length"]).toBe("0");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", accountId: channelAccountId }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address");
    try {
      await expect(
        requestBoundedCdpStopViaHttp(
          new URL(`http://127.0.0.1:${address.port}/accounts/${channelAccountId}/stop`),
          "127.0.0.1:10005",
        ),
      ).resolves.toMatchObject({
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", accountId: channelAccountId }),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("activates and discovers the selected Linux account without crossing account paths", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        undefined,
        activation,
        discovery,
      ),
    ).resolves.toEqual({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      headers: { Host: "127.0.0.1:10005" },
    });
    expect(activation).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${channelAccountId}/activate`),
      "127.0.0.1:10005",
      { profileKey },
    );
    expect(discovery).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${channelAccountId}/json/version`),
      "127.0.0.1:10005",
    );
  });

  it("forwards the platform start URL through Linux account activation", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.toutiao.com/profile_v4/index",
        activation,
        discovery,
      ),
    ).resolves.toMatchObject({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
    });
    expect(activation).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${channelAccountId}/activate`),
      "127.0.0.1:10005",
      { profileKey, startUrl: "https://mp.toutiao.com/profile_v4/index" },
    );
  });

  it("forwards the Zhihu login URL through Linux account activation", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://www.zhihu.com/signin",
        activation,
        discovery,
      ),
    ).resolves.toMatchObject({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
    });
    expect(activation).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${channelAccountId}/activate`),
      "127.0.0.1:10005",
      { profileKey, startUrl: "https://www.zhihu.com/signin" },
    );
  });

  it("surfaces Browser Host admission pressure as runtime unavailable", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "BROWSER_HOST_ADMISSION_PAUSED",
        error: "browser host admission is paused: cgroup task watermark reached",
      }),
    }));
    const discovery = vi.fn();

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.toutiao.com/profile_v4/index",
        activation,
        discovery,
      ),
    ).rejects.toThrow("Ctrip browser runtime unavailable");
    expect(discovery).not.toHaveBeenCalled();
  });

  it("forwards the fixed NetEase article editor hash route", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/#/article-publish",
        activation,
        discovery,
      ),
    ).resolves.toMatchObject({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
    });
    expect(activation).toHaveBeenCalledWith(
      new URL(`http://browser-host:10005/accounts/${channelAccountId}/activate`),
      "127.0.0.1:10005",
      { profileKey, startUrl: "https://mp.163.com/#/article-publish" },
    );
  });

  it("forwards only the fixed NetEase login root without a hash", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/",
        activation,
        discovery,
      ),
    ).resolves.toMatchObject({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
    });
  });

  it("rejects account browser start URLs outside the platform allowlist", async () => {
    const activation = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: channelAccountId,
        profileKey,
        cdpBasePath: `/accounts/${channelAccountId}/`,
        vncWebSocketPath: `websockify/accounts/${channelAccountId}`,
      }),
    }));
    const discovery = vi.fn(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:10005/accounts/${channelAccountId}/devtools/browser/linux-account-session`,
      }),
    }));

    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://example.com/",
        activation,
        discovery,
      ),
    ).rejects.toThrow(/allowlist/iu);
    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/#/unexpected-route",
        activation,
        discovery,
      ),
    ).rejects.toThrow(/allowlist/iu);
    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/unexpected#/article-publish",
        activation,
        discovery,
      ),
    ).rejects.toThrow(/allowlist/iu);
    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/?from=unexpected#/article-publish",
        activation,
        discovery,
      ),
    ).rejects.toThrow(/allowlist/iu);
    await expect(
      resolveLinuxServiceAccountCdpTarget(
        "http://browser-host:10005/",
        channelAccountId,
        profileKey,
        "https://mp.163.com/unexpected?from=anything",
        activation,
        discovery,
      ),
    ).rejects.toThrow(/allowlist/iu);
  });

  it("accepts only a credential-free local HTTP CDP endpoint", () => {
    expect(requireLocalCdpEndpoint("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222/");
    expect(requireLocalCdpEndpoint("http://localhost:9222/")).toBe("http://localhost:9222/");
    expect(() => requireLocalCdpEndpoint("https://127.0.0.1:9222")).toThrow();
    expect(() => requireLocalCdpEndpoint("http://example.com:9222")).toThrow();
    expect(() => requireLocalCdpEndpoint("http://user:secret@127.0.0.1:9222")).toThrow();
    expect(() => requireLocalCdpEndpoint("http://127.0.0.1:9222/devtools/browser/id")).toThrow();
    expect(() => requireLocalCdpEndpoint("http://127.0.0.1:9222/?token=secret")).toThrow();
  });

  it("keeps the discovered CDP WebSocket on the same local endpoint", async () => {
    expect(
      requireLocalCdpWebSocketEndpoint(
        "ws://127.0.0.1:9222/devtools/browser/review-session",
        "http://127.0.0.1:9222/",
      ),
    ).toBe("ws://127.0.0.1:9222/devtools/browser/review-session");
    expect(() =>
      requireLocalCdpWebSocketEndpoint(
        "wss://remote.example/devtools/browser/review-session",
        "http://127.0.0.1:9222/",
      ),
    ).toThrow();
    expect(() =>
      requireLocalCdpWebSocketEndpoint(
        "ws://127.0.0.1:9333/devtools/browser/review-session",
        "http://127.0.0.1:9222/",
      ),
    ).toThrow(/same local/iu);

    const requests: unknown[][] = [];
    const fetcher = async (...args: unknown[]) => {
      requests.push(args);
      return new Response(
        JSON.stringify({
          Browser: "Chrome",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/review-session",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await expect(resolveLocalCdpWebSocketEndpoint("http://127.0.0.1:9222/", fetcher)).resolves.toBe(
      "ws://127.0.0.1:9222/devtools/browser/review-session",
    );
    expect(requests[0]?.[0]).toBe("http://127.0.0.1:9222/json/version");
    expect(requests[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("requires an explicit non-system-drive runtime temp root", () => {
    expect(requireRuntimeTmpRoot("D:\\GEO\\.runtime\\tmp")).toBe("D:\\GEO\\.runtime\\tmp");
    expect(() => requireRuntimeTmpRoot("C:\\Users\\operator\\AppData\\Local\\Temp")).toThrow(
      /system drive/iu,
    );
    expect(() => requireRuntimeTmpRoot("relative/tmp")).toThrow(/absolute/iu);
  });
});
