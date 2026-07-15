import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";

import type { ActorContext } from "@geo/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InternalGeoApiClient } from "./api-client.js";
import {
  createGeoMcpHttpServer,
  listenGeoMcpHttpServer,
  type McpRequestAuthenticator,
} from "./http-server.js";
import { PiAgentRunError, type PiAgentRunService } from "./pi-runner.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const accessToken = "streamable-http-test-access-token-with-safe-length";

const principal: ActorContext = {
  tenantId,
  actorId,
  role: "owner",
  capabilities: [
    "tenant:read",
    "content:read",
    "content:write",
    "audit:run",
    "publish:request",
    "visibility:run",
  ],
  requestId: "test",
};

function mockApi(): InternalGeoApiClient {
  return {
    getTenantContext: vi.fn(async () => ({ tenant: { id: tenantId, name: "Tenant" } })),
    getArticleTemplateCatalog: vi.fn(async () => ({
      version: "geo.article-templates.v1" as const,
      items: [],
    })),
    getBrandAgentProfile: vi.fn(async () => null),
    lookupFacts: vi.fn(async () => ({ facts: [] })),
    proposeDraft: vi.fn(async () => ({ contentVersionId: actorId })),
    previewVariant: vi.fn(async () => ({ variantId: actorId })),
    requestAudit: vi.fn(async () => ({ auditRunId: actorId })),
    requestPublication: vi.fn(async () => ({ publicationRequestId: actorId })),
    requestVisibilityRun: vi.fn(async () => ({ visibilityRunId: actorId })),
    requestMediaProduction: vi.fn(async () => ({ mediaJobId: actorId })),
    getMediaJobStatus: vi.fn(async () => ({ mediaJobId: actorId, state: "succeeded" })),
    authorizeResourceScope: vi.fn(async () => true),
  };
}

const authenticator: McpRequestAuthenticator = {
  authenticateBearer: async (header, requestId) => {
    if (header !== `Bearer ${accessToken}`) throw new Error("unauthorized");
    const resolved = { ...principal, requestId };
    return {
      principal: resolved,
      authInfo: {
        token: accessToken,
        clientId: "test-client",
        scopes: [...principal.capabilities],
        extra: { principal: resolved },
      },
    };
  },
  resolvePrincipal: (authInfo, requestId) =>
    ({ ...(authInfo.extra?.principal as ActorContext), requestId }) as ActorContext,
};

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("authenticated Streamable HTTP MCP server", () => {
  it("reports non-sensitive automation producer health", async () => {
    const port = await availablePort();
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      allowedHosts: [`127.0.0.1:${port}`],
      automationProducer: {
        health: () => ({
          enabled: true,
          running: true,
          lastTick: "2026-07-15T00:00:00.000Z",
          activeRuns: 2,
          lastError: {
            operation: "claim",
            kind: "retryable",
            code: "AUTOMATION_PRINCIPAL_CLAIM_FAILED",
            at: "2026-07-15T00:00:01.000Z",
          },
        }),
      },
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );

    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(await response.json()).toMatchObject({
      status: "ok",
      automation: {
        enabled: true,
        running: true,
        activeRuns: 2,
        lastError: { code: "AUTOMATION_PRINCIPAL_CLAIM_FAILED" },
      },
    });
  });

  it("lists and invokes only the bounded GEO tools", async () => {
    const port = await availablePort();
    const api = mockApi();
    const server = createGeoMcpHttpServer({
      api,
      authenticator,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    const client = new Client({ name: "geo-mcp-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport as Transport);
    closeCallbacks.push(async () => {
      await client.close();
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "geo_tenant_context",
      "geo_template_catalog",
      "geo_brand_profile",
      "geo_fact_lookup",
      "geo_draft_proposal",
      "geo_variant_preview",
      "geo_audit_request",
      "geo_publication_request",
      "geo_visibility_request",
      "geo_media_production_request",
      "geo_media_job_status",
    ]);
    const result = await client.callTool({
      name: "geo_tenant_context",
      arguments: { tenantId },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(tenantId);
    expect(api.getTenantContext).toHaveBeenCalledOnce();
  });

  it("rejects requests without a configured bearer token", async () => {
    const port = await availablePort();
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects chunked MCP bodies before the SDK can read them", async () => {
    const port = await availablePort();
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );

    const response = await new Promise<{ status: number; body: string }>(
      (resolvePromise, rejectPromise) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () =>
              resolvePromise({
                status: incoming.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", rejectPromise);
        request.end('{"jsonrpc":"2.0"}');
      },
    );

    expect(response.status).toBe(411);
    expect(response.body).toContain("Content-Length required");
  });

  it("runs an authenticated agent request with the resolved tenant principal", async () => {
    const port = await availablePort();
    const agentRunner: PiAgentRunService = {
      capability: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
      run: vi.fn(async (runPrincipal, input) => ({
        tenantId: runPrincipal.tenantId,
        actorId: runPrincipal.actorId,
        input,
      })),
    };
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      agentRunner,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );
    const input = {
      workflow: "draft_to_publication",
      tenantId,
      topic: "Audited travel article",
    };

    const response = await fetch(`http://127.0.0.1:${port}/agent/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.json()).resolves.toMatchObject({
      capability: agentRunner.capability,
      result: { tenantId, actorId, input },
    });
    expect(agentRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorId }),
      input,
      expect.any(AbortSignal),
    );
  });

  it("allows only one active agent run per tenant actor", async () => {
    const port = await availablePort();
    let releaseRun: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolvePromise) => {
      signalStarted = resolvePromise;
    });
    const pending = new Promise<void>((resolvePromise) => {
      releaseRun = resolvePromise;
    });
    const agentRunner: PiAgentRunService = {
      capability: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
      run: vi.fn(async () => {
        signalStarted();
        await pending;
        return { ok: true };
      }),
    };
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      agentRunner,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );
    const request = () =>
      fetch(`http://127.0.0.1:${port}/agent/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workflow: "prompt", prompt: "Review evidence" }),
      });

    const firstResponse = request();
    await started;
    const concurrentResponse = await request();
    expect(concurrentResponse.status).toBe(409);
    await expect(concurrentResponse.json()).resolves.toMatchObject({
      error: { code: "AGENT_RUN_ACTIVE" },
    });

    releaseRun();
    expect((await firstResponse).status).toBe(200);
    expect(agentRunner.run).toHaveBeenCalledOnce();
  });

  it("times out an agent run but keeps its concurrency lock until the runner settles", async () => {
    const port = await availablePort();
    let releaseRun: () => void = () => undefined;
    const pending = new Promise<void>((resolvePromise) => {
      releaseRun = resolvePromise;
    });
    let observedSignal: AbortSignal | undefined;
    const agentRunner: PiAgentRunService = {
      capability: { mode: "pi", provider: "test", model: "test-model" },
      run: vi.fn(async (_principal, _input, signal) => {
        observedSignal = signal;
        await pending;
        return { ok: true };
      }),
    };
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      agentRunner,
      agentRunTimeoutMs: 1_000,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );
    const request = () =>
      fetch(`http://127.0.0.1:${port}/agent/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workflow: "prompt", prompt: "Review evidence" }),
      });

    const timedOut = await request();
    expect(timedOut.status).toBe(504);
    await expect(timedOut.json()).resolves.toEqual({
      error: { code: "AGENT_RUN_TIMEOUT", message: "Agent run timed out" },
    });
    expect(observedSignal?.aborted).toBe(true);

    const stillLocked = await request();
    expect(stillLocked.status).toBe(409);
    expect(agentRunner.run).toHaveBeenCalledOnce();

    releaseRun();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect((await request()).status).toBe(200);
  });

  it("does not expose runner errors or credentials", async () => {
    const port = await availablePort();
    const agentRunner: PiAgentRunService = {
      capability: { mode: "pi", provider: "test", model: "test-model" },
      run: vi.fn(async () => {
        throw new Error("Authorization: Bearer provider-secret");
      }),
    };
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      agentRunner,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );

    const response = await fetch(`http://127.0.0.1:${port}/agent/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workflow: "prompt", prompt: "Review evidence" }),
    });
    const responseBody = await response.text();

    expect(response.status).toBe(400);
    expect(responseBody).toContain("AGENT_RUN_REJECTED");
    expect(responseBody).not.toContain("provider-secret");
  });

  it("maps a Pi provider failure to a sanitized upstream error", async () => {
    const port = await availablePort();
    const agentRunner: PiAgentRunService = {
      capability: { mode: "pi", provider: "test", model: "test-model" },
      run: vi.fn(async () => {
        throw new PiAgentRunError();
      }),
    };
    const server = createGeoMcpHttpServer({
      api: mockApi(),
      authenticator,
      agentRunner,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await listenGeoMcpHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );

    const response = await fetch(`http://127.0.0.1:${port}/agent/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workflow: "prompt", prompt: "Review evidence" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "AGENT_PROVIDER_FAILED", message: "Agent provider failed" },
    });
  });
});
