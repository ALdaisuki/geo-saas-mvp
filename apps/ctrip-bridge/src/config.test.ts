import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  parseCtripBridgeTenantConfigs,
  requireBridgeHost,
  requireBrowserPreflightTenant,
  requireCtripBridgeMode,
  requireDockerDesktopCdpEndpoint,
  requireLocalCdpEndpoint,
  requireLocalCdpWebSocketEndpoint,
  requireRuntimeTmpRoot,
  requireSimulatorHost,
  requestBoundedCdpDiscoveryViaHttp,
  resolveDockerDesktopCdpWebSocketEndpoint,
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
    expect(requireBridgeHost("0.0.0.0")).toBe("0.0.0.0");
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
      resolveDockerDesktopCdpWebSocketEndpoint(
        "http://host.docker.internal:9333/",
        requester,
      ),
    ).resolves.toEqual({
      webSocketEndpoint:
        "ws://host.docker.internal:9333/devtools/browser/draft-session",
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
