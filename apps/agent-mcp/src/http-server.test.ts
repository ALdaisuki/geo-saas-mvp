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
    lookupFacts: vi.fn(async () => ({ facts: [] })),
    proposeDraft: vi.fn(async () => ({ contentVersionId: actorId })),
    previewVariant: vi.fn(async () => ({ variantId: actorId })),
    requestAudit: vi.fn(async () => ({ auditRunId: actorId })),
    requestPublication: vi.fn(async () => ({ publicationRequestId: actorId })),
    requestVisibilityRun: vi.fn(async () => ({ visibilityRunId: actorId })),
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
      "geo_fact_lookup",
      "geo_draft_proposal",
      "geo_variant_preview",
      "geo_audit_request",
      "geo_publication_request",
      "geo_visibility_request",
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
});
