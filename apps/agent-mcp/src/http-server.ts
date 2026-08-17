import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ActorContext } from "@geo/contracts";
import { PI_GEO_SKILLS, PI_GEO_SKILL_BUNDLE_VERSION } from "@geo/agent";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { InternalGeoApiClient } from "./api-client.js";
import type { AutomationProducerHealth } from "./automation-producer.js";
import { GeoApiRequestError } from "./http-api-client.js";
import {
  MediaInspectionRunnerError,
  PI_VISION_EVALUATOR,
  PI_VISION_EVALUATOR_VERSION,
  type MediaInspectionService,
} from "./media-inspection-runner.js";
import { PiAgentRunError, type PiAgentRunService } from "./pi-runner.js";
import { createGeoAgentMcpServer } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MAX_MEDIA_INSPECTION_REQUEST_BYTES = 14 * 1024 * 1024;
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 120_000;
const MIN_AGENT_RUN_TIMEOUT_MS = 1_000;
const MAX_AGENT_RUN_TIMEOUT_MS = 15 * 60_000;

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
  readonly agentRunner?: PiAgentRunService;
  readonly mediaInspector?: MediaInspectionService;
  readonly agentRunTimeoutMs?: number;
  readonly automationProducer?: { health(): AutomationProducerHealth };
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

function correlationRequestId(value: string | string[] | undefined): string | undefined {
  const normalized = normalizedHeader(value);
  return normalized !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)
    ? normalized
    : undefined;
}

async function readJsonBody(
  request: IncomingMessage,
  contentLength: number,
  maxBytes = MAX_MCP_REQUEST_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > contentLength || received > maxBytes) {
      throw new Error("Request body length mismatch");
    }
    chunks.push(buffer);
  }
  if (received !== contentLength) throw new Error("Request body length mismatch");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createGeoMcpHttpServer(options: GeoMcpHttpServerOptions): Server {
  const allowedHosts = new Set(options.allowedHosts.map((value) => value.toLowerCase()));
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (allowedHosts.size === 0) throw new TypeError("At least one MCP Host header must be allowed");
  const agentRunTimeoutMs = options.agentRunTimeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(agentRunTimeoutMs) ||
    agentRunTimeoutMs < MIN_AGENT_RUN_TIMEOUT_MS ||
    agentRunTimeoutMs > MAX_AGENT_RUN_TIMEOUT_MS
  ) {
    throw new TypeError("Agent run timeout must be between 1 second and 15 minutes");
  }
  const activeAgentRuns = new Set<string>();
  const activeMediaInspections = new Set<string>();

  const server = createServer(async (request: AuthenticatedRequest, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://mcp.invalid");
      if (requestUrl.pathname === "/health/live" && request.method === "GET") {
        writeJson(response, 200, {
          status: "ok",
          service: "geo-agent-mcp",
          agent: options.agentRunner?.capability ?? { mode: "disabled" },
          skills: {
            bundleVersion: PI_GEO_SKILL_BUNDLE_VERSION,
            ids: PI_GEO_SKILLS.map((skill) => skill.id),
          },
          agentRuns: { active: activeAgentRuns.size },
          mediaInspection:
            options.mediaInspector === undefined
              ? { mode: "disabled" }
              : {
                  ...options.mediaInspector.capability,
                  evaluator: PI_VISION_EVALUATOR,
                  evaluatorVersion: PI_VISION_EVALUATOR_VERSION,
                },
          automation: options.automationProducer?.health() ?? {
            enabled: false,
            running: false,
            lastTick: null,
            activeRuns: 0,
            lastError: null,
          },
        });
        return;
      }
      if (requestUrl.pathname === "/media/inspections") {
        if (options.mediaInspector === undefined) {
          writeJson(response, 404, {
            error: { code: "MEDIA_INSPECTION_DISABLED", message: "Not found" },
          });
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, {
            error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
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
          writeJson(response, 403, {
            error: { code: "ORIGIN_DENIED", message: "Request denied" },
          });
          return;
        }
        const lengthHeader = normalizedHeader(request.headers["content-length"]);
        const contentLength = lengthHeader === undefined ? Number.NaN : Number(lengthHeader);
        if (
          request.headers["transfer-encoding"] !== undefined ||
          !Number.isFinite(contentLength) ||
          contentLength < 1 ||
          contentLength > MAX_MEDIA_INSPECTION_REQUEST_BYTES
        ) {
          writeJson(response, lengthHeader === undefined ? 411 : 413, {
            error: { code: "REQUEST_SIZE_INVALID", message: "Request body rejected" },
          });
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
          writeJson(response, 401, {
            error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          });
          return;
        }
        const runKey = `${authenticated.principal.tenantId}:${authenticated.principal.actorId}`;
        if (activeMediaInspections.has(runKey)) {
          writeJson(response, 409, {
            error: {
              code: "MEDIA_INSPECTION_ACTIVE",
              message: "A media inspection is already active",
            },
          });
          return;
        }
        activeMediaInspections.add(runKey);
        const controller = new AbortController();
        let timeout: NodeJS.Timeout | undefined;
        try {
          const input = await readJsonBody(
            request,
            contentLength,
            MAX_MEDIA_INSPECTION_REQUEST_BYTES,
          );
          timeout = setTimeout(() => controller.abort(), agentRunTimeoutMs);
          timeout.unref();
          const inspection = await options.mediaInspector.inspect(
            authenticated.principal,
            input,
            controller.signal,
          );
          response.setHeader("x-request-id", requestId);
          writeJson(response, 200, { inspection });
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "agent_mcp.media_inspection_rejected",
              requestId,
              tenantId: authenticated.principal.tenantId,
              errorType: error instanceof Error ? error.name : "UnknownError",
            }),
          );
          const timedOut = controller.signal.aborted;
          const runnerFailure = error instanceof MediaInspectionRunnerError;
          writeJson(response, timedOut ? 504 : runnerFailure ? error.statusCode : 400, {
            error: {
              code: timedOut
                ? "MEDIA_INSPECTION_TIMEOUT"
                : runnerFailure
                  ? error.code
                  : "MEDIA_INSPECTION_REJECTED",
              message: timedOut
                ? "Media inspection timed out"
                : runnerFailure
                  ? "Vision provider failed"
                  : "Media inspection was rejected",
            },
          });
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          activeMediaInspections.delete(runKey);
        }
        return;
      }
      if (requestUrl.pathname === "/agent/runs") {
        if (options.agentRunner === undefined) {
          writeJson(response, 404, { error: { code: "AGENT_DISABLED", message: "Not found" } });
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, {
            error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
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
        const lengthHeader = normalizedHeader(request.headers["content-length"]);
        const contentLength = lengthHeader === undefined ? Number.NaN : Number(lengthHeader);
        if (
          request.headers["transfer-encoding"] !== undefined ||
          !Number.isFinite(contentLength) ||
          contentLength < 1 ||
          contentLength > MAX_MCP_REQUEST_BYTES
        ) {
          writeJson(response, lengthHeader === undefined ? 411 : 413, {
            error: { code: "REQUEST_SIZE_INVALID", message: "Request body rejected" },
          });
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
          writeJson(response, 401, {
            error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
          });
          return;
        }
        const runKey = `${authenticated.principal.tenantId}:${authenticated.principal.actorId}`;
        if (activeAgentRuns.has(runKey)) {
          writeJson(response, 409, {
            error: { code: "AGENT_RUN_ACTIVE", message: "An agent run is already active" },
          });
          return;
        }
        activeAgentRuns.add(runKey);
        const gatewayRequestId = correlationRequestId(request.headers["x-geo-request-id"]);
        let releaseActiveRun = true;
        let timeout: NodeJS.Timeout | undefined;
        let controller: AbortController | undefined;
        let clientDisconnected = false;
        let timedOut = false;
        const abortDisconnectedRun = () => {
          clientDisconnected = true;
          controller?.abort();
        };
        const abortOnResponseClose = () => {
          if (!response.writableEnded) abortDisconnectedRun();
        };
        request.once("aborted", abortDisconnectedRun);
        response.once("close", abortOnResponseClose);
        try {
          const input = await readJsonBody(request, contentLength);
          const runController = new AbortController();
          controller = runController;
          console.info(
            JSON.stringify({
              level: "info",
              event: "agent_mcp.agent_run_started",
              requestId,
              gatewayRequestId,
              tenantId: authenticated.principal.tenantId,
            }),
          );
          const runOutcome = options.agentRunner
            .run(authenticated.principal, input, runController.signal)
            .then(
              (result) => ({ kind: "result" as const, result }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );
          const timeoutOutcome = new Promise<{ readonly kind: "timeout" }>((resolvePromise) => {
            timeout = setTimeout(() => {
              timedOut = true;
              runController.abort();
              resolvePromise({ kind: "timeout" });
            }, agentRunTimeoutMs);
            timeout.unref();
          });
          const outcome = await Promise.race([runOutcome, timeoutOutcome]);
          if (outcome.kind === "timeout" || timedOut) {
            releaseActiveRun = false;
            console.error(
              JSON.stringify({
                level: "error",
                event: "agent_mcp.agent_run_timeout",
                requestId,
                gatewayRequestId,
                tenantId: authenticated.principal.tenantId,
              }),
            );
            void runOutcome.then((settled) => {
              activeAgentRuns.delete(runKey);
              console.info(
                JSON.stringify({
                  level: "info",
                  event: "agent_mcp.agent_run_settled_after_timeout",
                  requestId,
                  gatewayRequestId,
                  tenantId: authenticated.principal.tenantId,
                  outcome: settled.kind,
                }),
              );
            });
            if (!response.destroyed) {
              writeJson(response, 504, {
                error: { code: "AGENT_RUN_TIMEOUT", message: "Agent run timed out" },
              });
            }
            return;
          }
          if (outcome.kind === "error") throw outcome.error;
          response.setHeader("x-request-id", requestId);
          writeJson(response, 200, {
            capability: options.agentRunner.capability,
            result: outcome.result,
          });
        } catch (error) {
          if (clientDisconnected) {
            console.info(
              JSON.stringify({
                level: "info",
                event: "agent_mcp.agent_run_cancelled",
                requestId,
                gatewayRequestId,
                tenantId: authenticated.principal.tenantId,
              }),
            );
            return;
          }
          console.error(
            JSON.stringify({
              level: "error",
              event: "agent_mcp.agent_run_rejected",
              requestId,
              tenantId: authenticated.principal.tenantId,
              errorType: error instanceof Error ? error.name : "UnknownError",
              ...(error instanceof PiAgentRunError
                ? {
                    diagnosticReason: error.diagnosticReason,
                    failureCode: error.failureCode,
                    providerFailureClass: error.providerFailureClass,
                    toolCallCount: error.toolCallCount,
                    lastToolName: error.lastToolName,
                  }
                : {}),
              ...(error instanceof GeoApiRequestError
                ? { errorCode: error.code, statusCode: error.status }
                : {}),
            }),
          );
          if (error instanceof PiAgentRunError) {
            const errorCode =
              error.diagnosticReason === "tool_guard"
                ? "AGENT_TOOL_GUARD_FAILED"
                : error.diagnosticReason === "draft_input"
                  ? "AGENT_DRAFT_INPUT_FAILED"
                  : error.code;
            writeJson(response, error.statusCode, {
              error: {
                code: errorCode,
                message:
                  error.diagnosticReason === "tool_guard"
                    ? "Agent tool workflow failed"
                    : error.diagnosticReason === "draft_input"
                      ? "Agent draft input failed validation"
                      : "Agent provider failed",
              },
            });
          } else {
            writeJson(response, 400, {
              error: { code: "AGENT_RUN_REJECTED", message: "Agent run was rejected" },
            });
          }
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          request.removeListener("aborted", abortDisconnectedRun);
          response.removeListener("close", abortOnResponseClose);
          if (releaseActiveRun) activeAgentRuns.delete(runKey);
        }
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
