import { request as requestHttp } from "node:http";
import { z } from "zod";
import { posix, win32 } from "node:path";

const tenantConfigSchema = z.strictObject({
  tenantId: z.string().uuid(),
  bridgePrincipalId: z.string().uuid(),
  accessToken: z.string().min(32).max(4_096),
});

export type CtripBridgeTenantConfig = z.infer<typeof tenantConfigSchema>;

const ctripBridgeModeSchema = z.enum([
  "simulator",
  "browser_preflight",
  "browser_draft",
  "browser_supervised",
  "browser_unattended",
]);
export type CtripBridgeMode = z.infer<typeof ctripBridgeModeSchema>;

export function requireCtripBridgeMode(value: string): CtripBridgeMode {
  return ctripBridgeModeSchema.parse(value);
}

export function requireBrowserPreflightTenant(
  tenants: readonly CtripBridgeTenantConfig[],
): CtripBridgeTenantConfig {
  if (tenants.length !== 1) {
    throw new TypeError("Ctrip browser preflight mode requires exactly one tenant");
  }
  return tenants[0] as CtripBridgeTenantConfig;
}

export function parseCtripBridgeTenantConfigs(value: string): readonly CtripBridgeTenantConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("CTRIP_BRIDGE_TENANTS_JSON must be valid JSON");
  }
  const tenants = z.array(tenantConfigSchema).min(1).max(1_000).parse(parsed);
  const tenantIds = new Set<string>();
  const principalIds = new Set<string>();
  const tokens = new Set<string>();
  for (const tenant of tenants) {
    if (
      tenantIds.has(tenant.tenantId) ||
      principalIds.has(tenant.bridgePrincipalId) ||
      tokens.has(tenant.accessToken)
    ) {
      throw new TypeError("Ctrip bridge tenant, principal and token values must be unique");
    }
    tenantIds.add(tenant.tenantId);
    principalIds.add(tenant.bridgePrincipalId);
    tokens.add(tenant.accessToken);
  }
  return tenants;
}

export function requireBridgeHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(normalized)) {
    throw new TypeError("Ctrip bridge must bind to a local or container-scoped host");
  }
  return normalized;
}

export function requireSimulatorHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(normalized)) {
    throw new TypeError("Ctrip simulator must bind to a loopback host");
  }
  return normalized;
}

export function requireLocalCdpEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Ctrip review CDP endpoint must be a valid URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname) ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Ctrip review CDP endpoint must be credential-free local HTTP");
  }
  return parsed.toString();
}

export function requireDockerDesktopCdpEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Ctrip Docker Desktop CDP endpoint must be a valid URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname.toLowerCase() !== "host.docker.internal" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "Ctrip Docker Desktop CDP endpoint must be credential-free host.docker.internal HTTP",
    );
  }
  return parsed.toString();
}

export function requireLocalCdpWebSocketEndpoint(value: string, httpEndpoint: string): string {
  const expected = new URL(requireLocalCdpEndpoint(httpEndpoint));
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Ctrip review CDP WebSocket endpoint must be a valid URL");
  }
  if (
    parsed.protocol !== "ws:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/devtools\/browser\/[A-Za-z0-9._-]{1,200}$/u.test(parsed.pathname)
  ) {
    throw new TypeError("Ctrip review CDP WebSocket endpoint is invalid");
  }
  if (
    parsed.hostname.toLowerCase() !== expected.hostname.toLowerCase() ||
    parsed.port !== expected.port
  ) {
    throw new TypeError("Ctrip review CDP WebSocket must use the same local endpoint");
  }
  return parsed.toString();
}

const MAX_CDP_DISCOVERY_BYTES = 16 * 1024;
const cdpDiscoverySchema = z.object({ webSocketDebuggerUrl: z.string() });

type CdpDiscoveryFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface BoundedCdpDiscoveryHttpResponse {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

type CdpDiscoveryHttpRequest = (
  url: URL,
  hostHeader: string,
) => Promise<BoundedCdpDiscoveryHttpResponse>;

export function requestBoundedCdpDiscoveryViaHttp(
  url: URL,
  hostHeader: string,
): Promise<BoundedCdpDiscoveryHttpResponse> {
  if (url.protocol !== "http:") {
    return Promise.reject(new TypeError("Ctrip CDP discovery requires HTTP"));
  }
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", Host: hostHeader },
      },
      (response) => {
        const contentTypeHeader = response.headers["content-type"];
        const contentType = Array.isArray(contentTypeHeader)
          ? contentTypeHeader[0]
          : contentTypeHeader;
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_CDP_DISCOVERY_BYTES) {
          response.resume();
          reject(new TypeError("Ctrip review CDP discovery response is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.byteLength;
          if (received > MAX_CDP_DISCOVERY_BYTES) {
            response.destroy(
              new TypeError("Ctrip review CDP discovery response is too large"),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(5_000, () => {
      request.destroy(new TypeError("Ctrip review CDP discovery timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function readBoundedCdpDiscovery(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CDP_DISCOVERY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TypeError("Ctrip review CDP discovery response is too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError("Ctrip review CDP discovery response is empty");
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_CDP_DISCOVERY_BYTES) {
        throw new TypeError("Ctrip review CDP discovery response is too large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function resolveLocalCdpWebSocketEndpoint(
  httpEndpoint: string,
  fetcher: CdpDiscoveryFetch = fetch,
): Promise<string> {
  const endpoint = requireLocalCdpEndpoint(httpEndpoint);
  const discoveryUrl = new URL("json/version", endpoint).toString();
  const response = await fetcher(discoveryUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new TypeError("Ctrip review CDP discovery failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedCdpDiscovery(response)) as unknown;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Ctrip review CDP discovery response is invalid", { cause: error });
  }
  const discovery = cdpDiscoverySchema.parse(parsed);
  return requireLocalCdpWebSocketEndpoint(discovery.webSocketDebuggerUrl, endpoint);
}

export interface DockerDesktopCdpConnectionTarget {
  readonly webSocketEndpoint: string;
  readonly headers: Readonly<{ Host: string }>;
}

export async function resolveDockerDesktopCdpWebSocketEndpoint(
  httpEndpoint: string,
  requester: CdpDiscoveryHttpRequest = requestBoundedCdpDiscoveryViaHttp,
): Promise<DockerDesktopCdpConnectionTarget> {
  const endpoint = new URL(requireDockerDesktopCdpEndpoint(httpEndpoint));
  const hostHeader = `127.0.0.1:${endpoint.port}`;
  const response = await requester(new URL("json/version", endpoint), hostHeader);
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !response.contentType?.includes("application/json")
  ) {
    throw new TypeError("Ctrip Docker Desktop CDP discovery failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Ctrip Docker Desktop CDP discovery response is invalid", {
      cause: error,
    });
  }
  const discovery = cdpDiscoverySchema.parse(parsed);
  const sourceWebSocket = new URL(discovery.webSocketDebuggerUrl);
  if (
    sourceWebSocket.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      sourceWebSocket.hostname.toLowerCase(),
    ) ||
    sourceWebSocket.port !== endpoint.port ||
    sourceWebSocket.username !== "" ||
    sourceWebSocket.password !== "" ||
    sourceWebSocket.search !== "" ||
    sourceWebSocket.hash !== "" ||
    !/^\/devtools\/browser\/[A-Za-z0-9._-]{1,200}$/u.test(sourceWebSocket.pathname)
  ) {
    throw new TypeError("Ctrip Docker Desktop CDP WebSocket endpoint is invalid");
  }
  sourceWebSocket.hostname = "host.docker.internal";
  return Object.freeze({
    webSocketEndpoint: sourceWebSocket.toString(),
    headers: Object.freeze({ Host: hostHeader }),
  });
}

export function requireRuntimeTmpRoot(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    const normalized = win32.normalize(trimmed);
    if (win32.parse(normalized).root.toLowerCase() === "c:\\") {
      throw new TypeError("Runtime temp root must not use the system drive");
    }
    return normalized;
  }
  if (!posix.isAbsolute(trimmed)) {
    throw new TypeError("Runtime temp root must be absolute");
  }
  const normalized = posix.normalize(trimmed);
  if (normalized === "/") throw new TypeError("Runtime temp root must not be the filesystem root");
  return normalized;
}
