import { z } from "zod";
import { posix, win32 } from "node:path";

const tenantConfigSchema = z.strictObject({
  tenantId: z.string().uuid(),
  bridgePrincipalId: z.string().uuid(),
  accessToken: z.string().min(32).max(4_096),
});

export type CtripBridgeTenantConfig = z.infer<typeof tenantConfigSchema>;

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

export function requireSimulatorHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(normalized)) {
    throw new TypeError("Ctrip simulator bridge must bind to a loopback host");
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
