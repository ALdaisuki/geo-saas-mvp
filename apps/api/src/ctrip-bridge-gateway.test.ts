import { describe, expect, it, vi } from "vitest";

import {
  CTRIP_BRIDGE_COMMAND_TIMEOUT_MS,
  CtripBridgeGatewayError,
  HttpCtripBridgeGateway,
  parseCtripBridgeCredentials,
  validateCtripBridgeUrl,
} from "./ctrip-bridge-gateway.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000003";
const channelAccountId = "10000000-0000-4000-8000-000000000004";
const token = "ctrip-bridge-test-token-with-more-than-32-bytes";
const command = {
  schemaVersion: "geo.ctrip-bridge.command.v1" as const,
  tenantId,
  handoffId,
  requestId: "request-1",
  command: "prepare" as const,
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function preparedResult() {
  return {
    schemaVersion: "geo.ctrip-bridge.result.v1",
    tenantId,
    handoffId,
    bridgePrincipalId,
    adapterVersion: "ctrip-community-simulator-v1",
    observedAt: "2026-07-16T12:00:00.000Z",
    evidenceHash: "a".repeat(64),
    evidenceKind: "simulation",
    command: "prepare",
    outcome: "prepared",
    state: "draft_prepared",
  };
}

describe("HttpCtripBridgeGateway", () => {
  it("requests authenticated browser navigation without accepting a caller URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({
        schemaVersion: "geo.ctrip-browser-login-navigation.result.v1",
        tenantId,
        channelAccountId,
        targetUrl: "https://we.ctrip.com/publish/contentManagement",
        currentUrl: "https://we.ctrip.com/publish/contentManagement",
      });
    });
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl,
    });

    await expect(
      gateway.navigateToLogin?.({
        schemaVersion: "geo.ctrip-browser-login-navigation.request.v1",
        tenantId,
        channelAccountId,
        requestId: "request-login",
      }),
    ).resolves.toMatchObject({
      targetUrl: "https://we.ctrip.com/publish/contentManagement",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:9030/browser/login");
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: "geo.ctrip-browser-login-navigation.request.v1",
      tenantId,
      channelAccountId,
      requestId: "request-login",
    });
  });

  it("allows the reviewed browser preparation window without weakening health checks", () => {
    expect(CTRIP_BRIDGE_COMMAND_TIMEOUT_MS).toBe(300_000);
  });

  it("rejects unsafe destinations and duplicate credentials", () => {
    expect(() => validateCtripBridgeUrl("http://bridge.example.test:9030")).toThrow(/HTTPS/iu);
    expect(validateCtripBridgeUrl("http://ctrip-bridge:9030").href).toBe(
      "http://ctrip-bridge:9030/",
    );
    expect(() => validateCtripBridgeUrl("http://ctrip-bridge:9031")).toThrow(/HTTPS/iu);
    expect(() => validateCtripBridgeUrl("http://ctrip-bridge:9030/admin")).toThrow(/HTTPS/iu);
    expect(() => validateCtripBridgeUrl(`https://${token}@bridge.example.test`)).toThrow(
      /credentials/iu,
    );
    expect(() =>
      parseCtripBridgeCredentials(
        JSON.stringify([
          { tenantId, accessToken: token },
          { tenantId, accessToken: `${token}-other` },
        ]),
      ),
    ).toThrow(/unique/iu);
  });

  it("uses only the authenticated tenant bearer and strict command route", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse(preparedResult());
    });
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl,
    });

    await expect(gateway.execute(command)).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
      evidenceKind: "simulation",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:9030/commands/prepare");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(init?.body))).toEqual(command);
  });

  it("rejects cross-command and cross-tenant responses", async () => {
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async () => jsonResponse({ ...preparedResult(), tenantId: bridgePrincipalId }),
    });

    await expect(gateway.execute(command)).rejects.toMatchObject({
      code: "CTRIP_BRIDGE_RESPONSE_INVALID",
    });
  });

  it("does not contact the bridge for an unconfigured tenant", async () => {
    const fetchImpl = vi.fn();
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [],
      fetchImpl,
    });

    await expect(gateway.execute(command)).rejects.toMatchObject({
      code: "CTRIP_BRIDGE_TENANT_NOT_CONFIGURED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the live browser-supervised health contract", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      void _input;
      void _init;
      return jsonResponse({
        status: "ok",
        service: "geo-ctrip-bridge",
        mode: "browser_supervised",
        adapterVersion: "ctrip-community-browser-supervised-v1",
        commandCapabilities: { prepare: true, submit: true, readback: true },
      });
    });
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl,
    });

    await expect(gateway.health?.()).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:9030/health/live");
  });

  it("reads tenant-authenticated operational readiness without exposing evidence", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      void _input;
      void _init;
      return jsonResponse(
        {
          schemaVersion: "geo.ctrip-operational-readiness.v1",
          status: "session_required",
          authenticated: true,
          observedAt: "2026-07-21T19:00:00.000Z",
          sessionEvidenceHash: "must-not-escape",
          mode: "browser_unattended",
        },
        503,
      );
    });
    const gateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl,
    });

    const channelAccountId = "20000000-0000-4000-8000-000000000010";
    await expect(gateway.readiness?.(tenantId, channelAccountId)).resolves.toEqual({
      status: "session_required",
      observedAt: "2026-07-21T19:00:00.000Z",
      authenticated: true,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:9030/health/ready?channelAccountId=${channelAccountId}`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
    });
  });

  it("sanitizes upstream errors and enforces its deadline", async () => {
    const authGateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async () => jsonResponse({ error: `leaked ${token}` }, 401),
    });
    const authError = await authGateway.execute(command).catch((error: unknown) => error);
    expect(authError).toBeInstanceOf(CtripBridgeGatewayError);
    expect(authError).toMatchObject({ code: "CTRIP_BRIDGE_AUTH_FAILED", statusCode: 503 });
    expect(String(authError)).not.toContain(token);

    const timeoutGateway = new HttpCtripBridgeGateway({
      baseUrl: "http://127.0.0.1:9030",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    await expect(timeoutGateway.execute(command)).rejects.toMatchObject({
      code: "CTRIP_BRIDGE_TIMEOUT",
      statusCode: 504,
    });
  });
});
