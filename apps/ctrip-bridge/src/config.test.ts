import { describe, expect, it } from "vitest";

import {
  parseCtripBridgeTenantConfigs,
  requireBrowserPreflightTenant,
  requireCtripBridgeMode,
  requireLocalCdpEndpoint,
  requireLocalCdpWebSocketEndpoint,
  requireRuntimeTmpRoot,
  requireSimulatorHost,
  resolveLocalCdpWebSocketEndpoint,
} from "./config.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000002";
const accessToken = "ctrip-bridge-config-token-with-safe-length";

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
  });

  it("requires an explicit mode and one isolated browser-preflight tenant", () => {
    const tenant = { tenantId, bridgePrincipalId, accessToken };
    expect(requireCtripBridgeMode("simulator")).toBe("simulator");
    expect(requireCtripBridgeMode("browser_preflight")).toBe("browser_preflight");
    expect(() => requireCtripBridgeMode("live")).toThrow();
    expect(requireBrowserPreflightTenant([tenant])).toEqual(tenant);
    expect(() =>
      requireBrowserPreflightTenant([tenant, { ...tenant, tenantId: bridgePrincipalId }]),
    ).toThrow(/one tenant/iu);
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
