import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ActorContext } from "@geo/contracts";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { InternalGeoApiClient } from "./api-client.js";
import { createGeoAgentMcpServer } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

export interface McpRequestAuthenticator {
  authenticateBearer(
    authorizationHeader: string | undefined,
    requestId: string,
  ): Promise<{ authInfo: AuthInfo; principal: Readonly<ActorContext> }>;
  resolvePrincipal(authInfo: Readonly<AuthInfo>, requestId: string): Readonly<ActorContext>;
}

export interface GeoMcpHttpServerOptions {
  readonly api: InternalGeoApiClient;
  readonly authenticator: McpRequestAuthenticator;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins?: readonly string[];
}

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function rpcError(response: ServerResponse, status: number, message: string): void {
  writeJson(response, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32600, message },
    id: null,
  });
}

function normalizedHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createGeoMcpHttpServer(options: GeoMcpHttpServerOptions): Server {
  const allowedHosts = new Set(options.allowedHosts.map((value) => value.toLowerCase()));
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (allowedHosts.size === 0) throw new TypeError("At least one MCP Host header must be allowed");

  const server = createServer(async (request: AuthenticatedRequest, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://mcp.invalid");
      if (requestUrl.pathname === "/health/live" && request.method === "GET") {
        writeJson(response, 200, { status: "ok", service: "geo-agent-mcp" });
        return;
      }
      if (requestUrl.pathname !== "/mcp") {
        rpcError(response, 404, "Not found");
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        rpcError(response, 405, "Method not allowed");
        return;
      }
      const host = normalizedHeader(request.headers.host)?.toLowerCase();
      if (host === undefined || !allowedHosts.has(host)) {
        rpcError(response, 403, "Host denied");
        return;
      }
      const origin = normalizedHeader(request.headers.origin);
      if (origin !== undefined && (allowedOrigins.size === 0 || !allowedOrigins.has(origin))) {
        rpcError(response, 403, "Origin denied");
        return;
      }
      const contentLengthHeader = normalizedHeader(request.headers["content-length"]);
      if (contentLengthHeader === undefined || request.headers["transfer-encoding"] !== undefined) {
        rpcError(response, 411, "Content-Length required");
        return;
      }
      const contentLength = Number(contentLengthHeader);
      if (
        !Number.isFinite(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_MCP_REQUEST_BYTES
      ) {
        rpcError(response, 413, "Request too large");
        return;
      }

      const requestId = randomUUID();
      let authenticated: Awaited<ReturnType<McpRequestAuthenticator["authenticateBearer"]>>;
      try {
        authenticated = await options.authenticator.authenticateBearer(
          normalizedHeader(request.headers.authorization),
          requestId,
        );
      } catch {
        response.setHeader("www-authenticate", 'Bearer realm="geo-agent-mcp"');
        rpcError(response, 401, "Authentication required");
        return;
      }
      request.auth = authenticated.authInfo;
      const mcp = createGeoAgentMcpServer({
        api: options.api,
        resolvePrincipal: async (authInfo, mcpRequestId) =>
          options.authenticator.resolvePrincipal(authInfo, mcpRequestId),
        authorizeScope: (principal, toolName, args) =>
          options.api.authorizeResourceScope(principal, toolName, args),
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        allowedHosts: [...allowedHosts],
        allowedOrigins: [...allowedOrigins],
        enableDnsRebindingProtection: true,
      });
      // SDK 1.29.0's exact-optional Transport declaration is narrower than its class accessors.
      await mcp.connect(transport as Transport);
      response.once("close", () => {
        void transport.close();
        void mcp.close();
      });
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) rpcError(response, 500, "Internal server error");
      else response.end();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function listenGeoMcpHttpServer(
  server: Server,
  options: { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}
