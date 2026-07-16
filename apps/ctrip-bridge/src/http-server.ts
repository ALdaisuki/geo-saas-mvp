import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ZodError } from "zod";

import { CtripBridgeServiceError } from "./service.js";
import type { CtripBridgeCommandService } from "./service.js";
import type { CtripCommunitySimulator } from "./simulator.js";

const MAX_COMMAND_BYTES = 128 * 1024;

export interface CtripBridgeTenantRuntime {
  readonly tenantId: string;
  readonly bridgePrincipalId: string;
  readonly accessToken: string;
  readonly service: CtripBridgeCommandService;
  readonly simulator: CtripCommunitySimulator;
}

export interface CtripBridgeHttpServerOptions {
  readonly tenants: readonly CtripBridgeTenantRuntime[];
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins?: readonly string[];
}

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

function normalizedHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function parseBearer(value: string | undefined): string | null {
  if (value === undefined || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  return token.length === 0 ? null : token;
}

async function readJsonBody(request: IncomingMessage, contentLength: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > contentLength || received > MAX_COMMAND_BYTES) {
      throw new Error("Request body length mismatch");
    }
    chunks.push(buffer);
  }
  if (received !== contentLength) throw new Error("Request body length mismatch");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createCtripBridgeHttpServer(options: CtripBridgeHttpServerOptions): Server {
  const allowedHosts = new Set(options.allowedHosts.map((value) => value.toLowerCase()));
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (allowedHosts.size === 0)
    throw new TypeError("At least one Ctrip bridge Host must be allowed");
  const runtimes = options.tenants.map((runtime) => ({
    runtime,
    tokenHash: tokenHash(runtime.accessToken),
  }));
  if (runtimes.length === 0) throw new TypeError("At least one Ctrip bridge tenant is required");
  if (new Set(runtimes.map(({ runtime }) => runtime.tenantId)).size !== runtimes.length) {
    throw new TypeError("Ctrip bridge tenant IDs must be unique");
  }
  if (new Set(runtimes.map(({ runtime }) => runtime.bridgePrincipalId)).size !== runtimes.length) {
    throw new TypeError("Ctrip bridge principal IDs must be unique");
  }
  if (
    new Set(runtimes.map(({ tokenHash: hash }) => hash.toString("hex"))).size !== runtimes.length
  ) {
    throw new TypeError("Ctrip bridge access tokens must be unique");
  }

  function authenticate(request: IncomingMessage): CtripBridgeTenantRuntime | null {
    const bearer = parseBearer(normalizedHeader(request.headers.authorization));
    if (bearer === null) return null;
    const hash = tokenHash(bearer);
    return (
      runtimes.find(
        (candidate) =>
          candidate.tokenHash.length === hash.length && timingSafeEqual(candidate.tokenHash, hash),
      )?.runtime ?? null
    );
  }

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://ctrip-bridge.invalid");
      if (requestUrl.pathname === "/health/live" && request.method === "GET") {
        writeJson(response, 200, {
          status: "ok",
          service: "geo-ctrip-bridge",
          mode: "simulator",
          adapterVersion: "ctrip-community-simulator-v1",
        });
        return;
      }
      const host = normalizedHeader(request.headers.host)?.toLowerCase();
      const origin = normalizedHeader(request.headers.origin);
      if (host === undefined || !allowedHosts.has(host)) {
        writeJson(response, 403, { error: { code: "HOST_DENIED", message: "Request denied" } });
        return;
      }
      if (origin !== undefined && (allowedOrigins.size === 0 || !allowedOrigins.has(origin))) {
        writeJson(response, 403, { error: { code: "ORIGIN_DENIED", message: "Request denied" } });
        return;
      }
      const runtime = authenticate(request);
      if (runtime === null) {
        response.setHeader("www-authenticate", 'Bearer realm="geo-ctrip-bridge"');
        writeJson(response, 401, {
          error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
        });
        return;
      }

      if (requestUrl.pathname === "/simulator" && request.method === "GET") {
        const html = runtime.simulator.renderHtml(runtime.tenantId);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(html);
        return;
      }

      const routeMatch = /^\/commands\/(prepare|submit|readback)$/u.exec(requestUrl.pathname);
      if (routeMatch === null) {
        writeJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        writeJson(response, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        });
        return;
      }
      const lengthHeader = normalizedHeader(request.headers["content-length"]);
      const contentLength = lengthHeader === undefined ? Number.NaN : Number(lengthHeader);
      if (
        request.headers["transfer-encoding"] !== undefined ||
        !Number.isFinite(contentLength) ||
        contentLength < 1 ||
        contentLength > MAX_COMMAND_BYTES
      ) {
        writeJson(response, lengthHeader === undefined ? 411 : 413, {
          error: { code: "REQUEST_SIZE_INVALID", message: "Request body rejected" },
        });
        return;
      }
      const input = await readJsonBody(request, contentLength);
      const result = await runtime.service.execute(input);
      if (
        result.tenantId !== runtime.tenantId ||
        result.bridgePrincipalId !== runtime.bridgePrincipalId
      ) {
        throw new CtripBridgeServiceError(403, "CTRIP_BRIDGE_SCOPE_MISMATCH", "Scope mismatch");
      }
      if (result.command !== routeMatch[1]) {
        writeJson(response, 400, {
          error: { code: "COMMAND_ROUTE_MISMATCH", message: "Command route mismatch" },
        });
        return;
      }
      writeJson(response, 200, result);
    } catch (error) {
      if (error instanceof CtripBridgeServiceError) {
        writeJson(response, error.statusCode, {
          error: { code: error.code, message: error.message },
        });
      } else if (error instanceof ZodError || error instanceof SyntaxError) {
        writeJson(response, 400, {
          error: { code: "COMMAND_INVALID", message: "Command is invalid" },
        });
      } else {
        writeJson(response, 409, {
          error: { code: "CTRIP_BRIDGE_STATE_CONFLICT", message: "Bridge command failed" },
        });
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function listenCtripBridgeHttpServer(
  server: Server,
  options: { readonly host: string; readonly port: number },
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}
