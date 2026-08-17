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

const ctripBrowserTransportSchema = z.enum(["local", "docker_desktop", "linux_service"]);
export type CtripBrowserTransport = z.infer<typeof ctripBrowserTransportSchema>;

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

export function resolveCtripBrowserTransport(
  mode: CtripBridgeMode,
  value: string | undefined,
): CtripBrowserTransport {
  if (mode === "simulator") {
    throw new TypeError("Ctrip simulator mode does not use a browser transport");
  }
  if (value === undefined) {
    return mode === "browser_preflight" ? "local" : "docker_desktop";
  }
  return ctripBrowserTransportSchema.parse(value);
}

export function requireCtripBrowserTenantId(
  value: string,
  tenants: readonly CtripBridgeTenantConfig[],
): string {
  const tenantId = z.string().uuid().parse(value);
  const tenant = requireBrowserPreflightTenant(tenants);
  if (tenant.tenantId !== tenantId) {
    throw new TypeError("Ctrip browser tenant must match the configured bridge tenant");
  }
  return tenantId;
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

export function ctripBridgeAllowedHosts(bindHost: string, port: number): readonly string[] {
  const normalizedHost = requireBridgeHost(bindHost);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Ctrip bridge port must be valid");
  }
  const bindAuthority =
    normalizedHost === "::1" ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`;
  return Object.freeze([
    ...new Set([bindAuthority, `127.0.0.1:${port}`, `localhost:${port}`, `ctrip-bridge:${port}`]),
  ]);
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

export function requireLinuxServiceCdpEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Ctrip Linux service CDP endpoint must be a valid URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    parsed.port !== "10005" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname) ||
    hostname === "localhost" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(
      "Ctrip Linux service CDP endpoint must be credential-free HTTP on a private service name at port 10005",
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

type CdpActivationHttpRequest = (
  url: URL,
  hostHeader: string,
  body: Readonly<{ profileKey: string; startUrl?: string }>,
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
            response.destroy(new TypeError("Ctrip review CDP discovery response is too large"));
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

export function requestBoundedCdpActivationViaHttp(
  url: URL,
  hostHeader: string,
  body: Readonly<{ profileKey: string; startUrl?: string }>,
): Promise<BoundedCdpDiscoveryHttpResponse> {
  if (url.protocol !== "http:") {
    return Promise.reject(new TypeError("Ctrip account activation requires HTTP"));
  }
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          Host: hostHeader,
        },
      },
      (response) => {
        const contentTypeHeader = response.headers["content-type"];
        const contentType = Array.isArray(contentTypeHeader)
          ? contentTypeHeader[0]
          : contentTypeHeader;
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_CDP_DISCOVERY_BYTES) {
          response.resume();
          reject(new TypeError("Ctrip account activation response is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.byteLength;
          if (received > MAX_CDP_DISCOVERY_BYTES) {
            response.destroy(new TypeError("Ctrip account activation response is too large"));
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
    request.setTimeout(30_000, () => {
      request.destroy(new TypeError("Ctrip account activation timed out"));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

export function requestBoundedCdpStopViaHttp(
  url: URL,
  hostHeader: string,
): Promise<BoundedCdpDiscoveryHttpResponse> {
  if (url.protocol !== "http:") {
    return Promise.reject(new TypeError("Ctrip account browser stop requires HTTP"));
  }
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-length": "0",
          Host: hostHeader,
        },
      },
      (response) => {
        const contentTypeHeader = response.headers["content-type"];
        const contentType = Array.isArray(contentTypeHeader)
          ? contentTypeHeader[0]
          : contentTypeHeader;
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_CDP_DISCOVERY_BYTES) {
          response.resume();
          reject(new TypeError("Ctrip account browser stop response is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.byteLength;
          if (received > MAX_CDP_DISCOVERY_BYTES) {
            response.destroy(new TypeError("Ctrip account browser stop response is too large"));
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
    request.setTimeout(10_000, () => {
      request.destroy(new TypeError("Ctrip account browser stop timed out"));
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

export interface CdpConnectionTarget {
  readonly webSocketEndpoint: string;
  readonly headers: Readonly<{ Host: string }>;
}

export type DockerDesktopCdpConnectionTarget = CdpConnectionTarget;

async function resolveNetworkCdpWebSocketEndpoint(
  endpoint: URL,
  destinationHost: string,
  failureLabel: string,
  requester: CdpDiscoveryHttpRequest,
): Promise<CdpConnectionTarget> {
  const hostHeader = `127.0.0.1:${endpoint.port}`;
  const response = await requester(new URL("json/version", endpoint), hostHeader);
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !response.contentType?.includes("application/json")
  ) {
    throw new TypeError(`Ctrip ${failureLabel} CDP discovery failed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new TypeError(`Ctrip ${failureLabel} CDP discovery response is invalid`, {
      cause: error,
    });
  }
  const discovery = cdpDiscoverySchema.parse(parsed);
  let sourceWebSocket: URL;
  try {
    sourceWebSocket = new URL(discovery.webSocketDebuggerUrl);
  } catch (error) {
    throw new TypeError(`Ctrip ${failureLabel} CDP WebSocket endpoint is invalid`, {
      cause: error,
    });
  }
  if (
    sourceWebSocket.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(sourceWebSocket.hostname.toLowerCase()) ||
    sourceWebSocket.port !== endpoint.port ||
    sourceWebSocket.username !== "" ||
    sourceWebSocket.password !== "" ||
    sourceWebSocket.search !== "" ||
    sourceWebSocket.hash !== "" ||
    !/^\/devtools\/browser\/[A-Za-z0-9._-]{1,200}$/u.test(sourceWebSocket.pathname)
  ) {
    throw new TypeError(`Ctrip ${failureLabel} CDP WebSocket endpoint is invalid`);
  }
  sourceWebSocket.hostname = destinationHost;
  return Object.freeze({
    webSocketEndpoint: sourceWebSocket.toString(),
    headers: Object.freeze({ Host: hostHeader }),
  });
}

export async function resolveDockerDesktopCdpWebSocketEndpoint(
  httpEndpoint: string,
  requester: CdpDiscoveryHttpRequest = requestBoundedCdpDiscoveryViaHttp,
): Promise<DockerDesktopCdpConnectionTarget> {
  const endpoint = new URL(requireDockerDesktopCdpEndpoint(httpEndpoint));
  return resolveNetworkCdpWebSocketEndpoint(
    endpoint,
    "host.docker.internal",
    "Docker Desktop",
    requester,
  );
}

export async function resolveLinuxServiceCdpWebSocketEndpoint(
  httpEndpoint: string,
  requester: CdpDiscoveryHttpRequest = requestBoundedCdpDiscoveryViaHttp,
): Promise<CdpConnectionTarget> {
  const endpoint = new URL(requireLinuxServiceCdpEndpoint(httpEndpoint));
  return resolveNetworkCdpWebSocketEndpoint(
    endpoint,
    endpoint.hostname,
    "Linux service",
    requester,
  );
}

const channelAccountIdSchema = z.string().uuid();
const accountProfileKeySchema = z.string().regex(/^ctrip-account-[0-9a-f-]{36}$/u);
const accountStartUrlSchema = z.string().url().max(2_048);
const ACCOUNT_BROWSER_START_URL_HOSTS = new Set([
  "mp.toutiao.com",
  "mp.sohu.com",
  "baijiahao.baidu.com",
  "mp.163.com",
  "www.zhihu.com",
  "my.ctrip.com",
  "we.ctrip.com",
  "www.ctrip.com",
  "passport.ctrip.com",
]);
const ACCOUNT_BROWSER_START_URL_HASHES = new Map([
  ["mp.163.com", new Set(["#/article-publish", "#/content-manage"])],
]);
const accountActivationSchema = z.strictObject({
  accountId: channelAccountIdSchema,
  profileKey: accountProfileKeySchema,
  cdpBasePath: z.string(),
  vncWebSocketPath: z.string(),
});

export function requireAccountBrowserStartUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = accountStartUrlSchema.parse(value);
  const parsed = new URL(normalized);
  const hostname = parsed.hostname.toLowerCase();
  const allowedHashes = ACCOUNT_BROWSER_START_URL_HASHES.get(hostname);
  const hashAllowed =
    hostname === "mp.163.com"
      ? parsed.pathname === "/" &&
        parsed.search === "" &&
        (parsed.hash === "" || allowedHashes?.has(parsed.hash) === true)
      : parsed.hash === "";
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !hashAllowed ||
    !ACCOUNT_BROWSER_START_URL_HOSTS.has(hostname)
  ) {
    throw new TypeError("Account browser start URL is outside the platform allowlist");
  }
  return parsed.toString();
}

export async function resolveLinuxServiceAccountCdpTarget(
  httpEndpoint: string,
  channelAccountId: string,
  profileKey: string,
  startUrl: string | undefined,
  activator: CdpActivationHttpRequest = requestBoundedCdpActivationViaHttp,
  requester: CdpDiscoveryHttpRequest = requestBoundedCdpDiscoveryViaHttp,
): Promise<CdpConnectionTarget> {
  const endpoint = new URL(requireLinuxServiceCdpEndpoint(httpEndpoint));
  const accountId = channelAccountIdSchema.parse(channelAccountId);
  const normalizedProfileKey = accountProfileKeySchema.parse(profileKey);
  const normalizedStartUrl = requireAccountBrowserStartUrl(startUrl);
  if (normalizedProfileKey !== `ctrip-account-${accountId}`) {
    throw new TypeError("Ctrip browser profile key does not match the channel account");
  }
  const hostHeader = `127.0.0.1:${endpoint.port}`;
  const accountBasePath = `/accounts/${accountId}/`;
  const activation = await activator(new URL(`${accountBasePath}activate`, endpoint), hostHeader, {
    profileKey: normalizedProfileKey,
    ...(normalizedStartUrl === undefined ? {} : { startUrl: normalizedStartUrl }),
  });
  if (activation.statusCode === 503 && activation.contentType?.includes("application/json")) {
    try {
      const unavailable = z
        .object({
          code: z.literal("BROWSER_HOST_ADMISSION_PAUSED"),
          error: z.string().min(1).max(500),
        })
        .strict()
        .parse(JSON.parse(activation.body));
      throw new Error(`Ctrip browser runtime unavailable: ${unavailable.error}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Ctrip browser runtime unavailable")) {
        throw error;
      }
      throw new TypeError("Ctrip Linux account activation response is invalid", { cause: error });
    }
  }
  if (
    activation.statusCode < 200 ||
    activation.statusCode >= 300 ||
    !activation.contentType?.includes("application/json")
  ) {
    throw new TypeError("Ctrip Linux account activation failed");
  }
  let activated: z.infer<typeof accountActivationSchema>;
  try {
    activated = accountActivationSchema.parse(JSON.parse(activation.body));
  } catch (error) {
    throw new TypeError("Ctrip Linux account activation response is invalid", { cause: error });
  }
  if (
    activated.accountId !== accountId ||
    activated.profileKey !== normalizedProfileKey ||
    activated.cdpBasePath !== accountBasePath ||
    activated.vncWebSocketPath !== `websockify/accounts/${accountId}`
  ) {
    throw new TypeError("Ctrip Linux account activation scope is invalid");
  }

  const discovery = await requester(
    new URL(`${accountBasePath}json/version`, endpoint),
    hostHeader,
  );
  if (
    discovery.statusCode < 200 ||
    discovery.statusCode >= 300 ||
    !discovery.contentType?.includes("application/json")
  ) {
    throw new TypeError("Ctrip Linux account CDP discovery failed");
  }
  let sourceWebSocket: URL;
  try {
    const parsed = cdpDiscoverySchema.parse(JSON.parse(discovery.body));
    sourceWebSocket = new URL(parsed.webSocketDebuggerUrl);
  } catch (error) {
    throw new TypeError("Ctrip Linux account CDP discovery response is invalid", { cause: error });
  }
  const expectedPathPrefix = `${accountBasePath}devtools/browser/`;
  if (
    sourceWebSocket.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(sourceWebSocket.hostname.toLowerCase()) ||
    sourceWebSocket.port !== endpoint.port ||
    sourceWebSocket.username !== "" ||
    sourceWebSocket.password !== "" ||
    sourceWebSocket.search !== "" ||
    sourceWebSocket.hash !== "" ||
    !sourceWebSocket.pathname.startsWith(expectedPathPrefix) ||
    !/^[A-Za-z0-9._-]{1,200}$/u.test(sourceWebSocket.pathname.slice(expectedPathPrefix.length))
  ) {
    throw new TypeError("Ctrip Linux account CDP WebSocket endpoint is invalid");
  }
  sourceWebSocket.hostname = endpoint.hostname;
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
