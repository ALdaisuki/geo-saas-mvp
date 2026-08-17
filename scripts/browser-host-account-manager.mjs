import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { availableParallelism, cpus } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_KEY_PATTERN = /^[A-Za-z0-9._-]{16,200}$/u;
const CDP_SUFFIX_PATTERN =
  /^(?:json\/(?:version|list)|devtools\/(?:browser|page)\/[A-Za-z0-9._-]{1,200})$/u;
const MAX_BODY_BYTES = 4 * 1024;
const DEFAULT_START_URL = "https://we.ctrip.com/publish/publishPictureText";
const ACCOUNT_START_URL_HOSTS = new Set([
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
const CDP_HOST_PORT = 10005;
const NOVNC_HOST_PORT = 10007;
// Chrome validates the Origin supplied by Playwright's CDP WebSocket. The
// browser itself remains loopback-only; this is the narrow proxy origin set.
export const ACCOUNT_BROWSER_CDP_ALLOWED_ORIGINS = Object.freeze([
  `http://browser-host:${CDP_HOST_PORT}`,
  `http://127.0.0.1:${CDP_HOST_PORT}`,
]);
const DEFAULT_MAX_SESSIONS = 8;
const DISPLAY_BASE = 100;
const CDP_PORT_BASE = 11_000;
const VNC_PORT_BASE = 12_000;
const WEBSOCKIFY_PORT_BASE = 13_000;
const NOVNC_WEB_ROOT = "/usr/share/novnc";
// Sohu's CDN currently rejects Chrome/149 requests with a 403 HTML response,
// which Chromium reports as ERR_BLOCKED_BY_ORB for the page's JS and CSS.
const SOHU_COMPATIBLE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
export const ACCOUNT_BROWSER_MAX_TABS = 3;
export const DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS = 10 * 60 * 1_000;
export const ACCOUNT_BROWSER_IDLE_TTL_MS = DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS;
const ACCOUNT_BROWSER_START_GRACE_MS = 30_000;
export const MAX_ACCOUNT_BROWSER_SESSIONS = 16;
export const DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT = 256;
export const MAX_ACCOUNT_BROWSER_PROCESS_LIMIT = 4_096;
export const DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT = 1_536;
export const MAX_ACCOUNT_BROWSER_TASK_LIMIT = 65_536;
const CGROUP_CPU_STAT_PATH = "/sys/fs/cgroup/cpu.stat";
const CGROUP_PIDS_CURRENT_PATH = "/sys/fs/cgroup/pids.current";
const HOST_LOADAVG_PATH = "/proc/loadavg";
const HOST_CPU_ONLINE_PATH = "/sys/devices/system/cpu/online";

export class BrowserHostAdmissionPausedError extends Error {
  constructor(reason) {
    super(`browser host admission is paused: ${reason}`);
    this.name = "BrowserHostAdmissionPausedError";
    this.code = "BROWSER_HOST_ADMISSION_PAUSED";
  }
}

export function browserCompatibilityArgsForStartUrl(startUrl) {
  if (startUrl === undefined || startUrl === "about:blank") return [];
  const hostname = new URL(startUrl).hostname.toLowerCase();
  return hostname === "mp.sohu.com" ? [`--user-agent=${SOHU_COMPATIBLE_USER_AGENT}`] : [];
}

export function chromiumLaunchArguments({ cdpPort, profileDirectory, startUrl }) {
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--remote-allow-origins=${ACCOUNT_BROWSER_CDP_ALLOWED_ORIGINS.join(",")}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--window-position=0,0",
    "--window-size=1440,900",
    ...browserCompatibilityArgsForStartUrl(startUrl),
    startUrl ?? DEFAULT_START_URL,
  ];
}

function stringArraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sessionIsAwaitingInitialConnection(session, now = Date.now()) {
  return (
    session.connections === 0 &&
    Number.isSafeInteger(session.startedAt) &&
    session.startedAt > 0 &&
    now >= session.startedAt &&
    now - session.startedAt < ACCOUNT_BROWSER_START_GRACE_MS
  );
}

async function readCgroupCpuUsageMicros() {
  const stat = await readFile(CGROUP_CPU_STAT_PATH, "utf8");
  const usage = /^usage_usec\s+(\d+)$/mu.exec(stat)?.[1];
  if (usage === undefined) throw new TypeError("browser host cgroup CPU usage is unavailable");
  const parsed = Number(usage);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("browser host cgroup CPU usage is invalid");
  }
  return parsed;
}

async function readCgroupCpuCoreCount() {
  try {
    const cpuMax = await readFile("/sys/fs/cgroup/cpu.max", "utf8");
    const match = /^([0-9]+|max)\s+([0-9]+)$/u.exec(cpuMax.trim());
    if (match !== null && match[1] !== "max") {
      const quota = Number(match[1]);
      const period = Number(match[2]);
      if (Number.isSafeInteger(quota) && Number.isSafeInteger(period) && quota > 0 && period > 0) {
        return Math.max(1, Math.round(quota / period));
      }
    }
  } catch {
    // Fall back to host parallelism outside cgroup v2.
  }
  return Math.max(1, availableParallelism());
}

async function readHostLoadAverage() {
  const raw = await readFile(HOST_LOADAVG_PATH, "utf8");
  const loadAverage = Number(raw.trim().split(/\s+/u)[0]);
  if (!Number.isFinite(loadAverage) || loadAverage < 0) {
    throw new TypeError("host load average is invalid");
  }
  return loadAverage;
}

async function readHostCpuCoreCount() {
  try {
    const raw = await readFile(HOST_CPU_ONLINE_PATH, "utf8");
    const ranges = raw.trim().split(",");
    let count = 0;
    for (const range of ranges) {
      const bounds = range.split("-").map((value) => Number(value));
      const start = bounds[0];
      const end = bounds.length === 2 ? bounds[1] : start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        throw new TypeError("host CPU online ranges are invalid");
      }
      count += end - start + 1;
    }
    if (count >= 1) return count;
  } catch {
    // Fall back to the host CPU inventory exposed through /proc/cpuinfo.
  }
  return Math.max(1, cpus().length);
}

export class CgroupCpuSampler {
  constructor(options = {}) {
    this.readUsageMicros = options.readUsageMicros ?? readCgroupCpuUsageMicros;
    this.readCoreCount = options.readCoreCount ?? readCgroupCpuCoreCount;
    this.readHostLoadAverage = options.readHostLoadAverage ?? readHostLoadAverage;
    this.readHostCoreCount = options.readHostCoreCount ?? readHostCpuCoreCount;
    this.now = options.now ?? Date.now;
    this.previous = null;
    this.utilizationPercent = 0;
    this.cpuCoreCount = options.cpuCoreCount ?? 1;
    this.hostLoadAverage1m = 0;
    this.hostCpuCoreCount = options.hostCpuCoreCount ?? 1;
    this.hostCpuUtilizationPercent = 0;
    this.lastObservedAtMs = 0;
  }

  async refresh() {
    const [usageMicros, cpuCoreCount, hostLoadAverage, hostCpuCoreCount] = await Promise.all([
      this.readUsageMicros(),
      this.readCoreCount(),
      this.readHostLoadAverage(),
      this.readHostCoreCount(),
    ]);
    const current = {
      usageMicros,
      hostLoadAverage,
      observedAtMs: this.now(),
    };
    if (Number.isSafeInteger(cpuCoreCount) && cpuCoreCount >= 1) {
      this.cpuCoreCount = cpuCoreCount;
    }
    if (Number.isSafeInteger(hostCpuCoreCount) && hostCpuCoreCount >= 1) {
      this.hostCpuCoreCount = hostCpuCoreCount;
    }
    if (Number.isFinite(hostLoadAverage) && hostLoadAverage >= 0) {
      this.hostLoadAverage1m = hostLoadAverage;
      this.hostCpuUtilizationPercent =
        Math.round((hostLoadAverage / this.hostCpuCoreCount) * 10_000) / 100;
    }
    if (this.previous !== null) {
      const elapsedMicros = (current.observedAtMs - this.previous.observedAtMs) * 1_000;
      const usedMicros = current.usageMicros - this.previous.usageMicros;
      if (elapsedMicros > 0 && usedMicros >= 0) {
        this.utilizationPercent = Math.round((usedMicros / elapsedMicros) * 10_000) / 100;
      }
    }
    this.previous = current;
    this.lastObservedAtMs = current.observedAtMs;
    return this.utilizationPercent;
  }
}

export async function readCgroupTaskCount(path = CGROUP_PIDS_CURRENT_PATH) {
  const raw = (await readFile(path, "utf8")).trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new TypeError("browser cgroup task count is invalid");
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    throw new TypeError("browser cgroup task count is invalid");
  }
  return count;
}

function browserPageSurface(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export async function terminateChild(child, options = {}) {
  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 1_000;
  if (!childIsRunning(child)) return true;
  killChildGroup(child, "SIGTERM");
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  const timeout = new Promise((resolvePromise) => setTimeout(resolvePromise, termGraceMs));
  await Promise.race([exited, timeout]);
  if (childIsRunning(child)) {
    killChildGroup(child, "SIGKILL");
    const killed = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    const killTimeout = new Promise((resolvePromise) => setTimeout(resolvePromise, killGraceMs));
    await Promise.race([killed, killTimeout]);
  }
  return !childIsRunning(child);
}

export function selectExcessPageTargetIds(
  targets,
  maximum = ACCOUNT_BROWSER_MAX_TABS,
  preservedUrls = [],
) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("maximum browser tabs must be a positive safe integer");
  }
  const preservedSurfaces = new Set(
    preservedUrls.map(browserPageSurface).filter((surface) => surface !== null),
  );
  const pages = targets.filter(
    (target) =>
      target !== null &&
      typeof target === "object" &&
      target.type === "page" &&
      target.parentId === undefined &&
      typeof target.id === "string" &&
      /^[A-Za-z0-9._-]{1,200}$/u.test(target.id),
  );
  const retained = new Set(
    [...pages]
      .sort((left, right) => {
        const leftPreserved = preservedSurfaces.has(browserPageSurface(left.url));
        const rightPreserved = preservedSurfaces.has(browserPageSurface(right.url));
        return Number(rightPreserved) - Number(leftPreserved);
      })
      .slice(0, maximum)
      .map((target) => target.id),
  );
  return pages.filter((target) => !retained.has(target.id)).map((target) => target.id);
}

function validPageTargetIds(targets) {
  return targets
    .filter(
      (target) =>
        target !== null &&
        typeof target === "object" &&
        target.type === "page" &&
        target.parentId === undefined &&
        typeof target.id === "string" &&
        /^[A-Za-z0-9._-]{1,200}$/u.test(target.id),
    )
    .map((target) => target.id);
}

async function readPageTargets(session) {
  const response = await fetch(`http://127.0.0.1:${session.cdpPort}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("account Chromium target discovery failed");
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("account Chromium target list is invalid");
  return targets;
}

async function cdpDiscoveryIsResponsive(session) {
  try {
    const response = await fetch(`http://127.0.0.1:${session.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function closePageTargets(session, targetIds) {
  for (const targetId of targetIds) {
    const response = await fetch(
      `http://127.0.0.1:${session.cdpPort}/json/close/${encodeURIComponent(targetId)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error("account Chromium tab cleanup failed");
  }
}

async function enforceSessionTabLimit(session) {
  const targets = await readPageTargets(session);
  await closePageTargets(
    session,
    selectExcessPageTargetIds(targets, undefined, [session.startUrl]),
  );
}

async function closeAllSessionTabs(session) {
  const targets = await readPageTargets(session);
  await closePageTargets(session, validPageTargetIds(targets));
}

function requireAccountId(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) throw new TypeError("channel account id is invalid");
  return normalized;
}

function requireProfileKey(value) {
  const normalized = String(value).trim();
  if (!PROFILE_KEY_PATTERN.test(normalized)) throw new TypeError("browser profile key is invalid");
  return normalized;
}

export function requireAccountStartUrl(value) {
  const normalized = String(value).trim();
  if (normalized === "about:blank") return normalized;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError("account browser start URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  const hashAllowed =
    hostname === "mp.163.com"
      ? parsed.pathname === "/" &&
        parsed.search === "" &&
        (parsed.hash === "" || ["#/article-publish", "#/content-manage"].includes(parsed.hash))
      : parsed.hash === "";
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !hashAllowed ||
    !ACCOUNT_START_URL_HOSTS.has(hostname)
  ) {
    throw new TypeError("account browser start URL is outside the platform allowlist");
  }
  return parsed.toString();
}

export function accountProfileDescriptor(root, accountId, profileKey) {
  const normalizedAccountId = requireAccountId(accountId);
  const normalizedProfileKey = requireProfileKey(profileKey);
  if (normalizedProfileKey !== `ctrip-account-${normalizedAccountId}`) {
    throw new TypeError("browser profile key does not match the channel account");
  }
  const normalizedRoot = resolve(root);
  const directory = resolve(normalizedRoot, normalizedProfileKey);
  if (!directory.startsWith(`${normalizedRoot}${sep}`)) {
    throw new TypeError("browser profile directory escapes the tenant root");
  }
  return Object.freeze({
    accountId: normalizedAccountId,
    profileKey: normalizedProfileKey,
    directory,
    markerPath: join(directory, ".geo-account-id"),
  });
}

export function accountCdpPath(accountId, suffix) {
  const normalizedAccountId = requireAccountId(accountId);
  const normalizedSuffix = String(suffix).replace(/^\/+|\/+$/gu, "");
  if (!CDP_SUFFIX_PATTERN.test(normalizedSuffix))
    throw new TypeError("account CDP path is invalid");
  return `/accounts/${normalizedAccountId}/${normalizedSuffix}`;
}

export function parseAccountCdpPath(pathname) {
  const match = /^\/accounts\/([^/]+)\/(.+)$/u.exec(String(pathname));
  if (match === null) return null;
  try {
    const accountId = requireAccountId(match[1]);
    const suffix = match[2];
    if (!CDP_SUFFIX_PATTERN.test(suffix)) return null;
    return Object.freeze({ accountId, upstreamPath: `/${suffix}` });
  } catch {
    return null;
  }
}

export function accountVncWebSocketPath(accountId) {
  return `websockify/accounts/${requireAccountId(accountId)}`;
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`value must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

async function requireDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`required directory is unsafe: ${path}`);
  }
}

async function requireFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`required file is unsafe: ${path}`);
  }
  return metadata;
}

export async function ensureProfileDirectory(descriptor) {
  await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
  await requireDirectory(descriptor.directory);
  try {
    await writeFile(descriptor.markerPath, `${descriptor.accountId}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await requireFile(descriptor.markerPath);
  const marker = (await readFile(descriptor.markerPath, "utf8")).trim();
  if (marker !== descriptor.accountId) {
    throw new TypeError("browser profile belongs to a different channel account");
  }
  await chmod(descriptor.markerPath, 0o600);
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    const path = join(descriptor.directory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isSymbolicLink()) {
        throw new TypeError("browser profile contains an unsafe singleton entry");
      }
      await unlink(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function findChromiumExecutable() {
  const roots = (await readdir("/ms-playwright", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^chromium-[0-9]+$/u.test(entry.name))
    .map((entry) => join("/ms-playwright", entry.name));
  const candidates = roots.flatMap((root) => [
    join(root, "chrome-linux", "chrome"),
    join(root, "chrome-linux64", "chrome"),
  ]);
  const available = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      available.push(candidate);
    } catch {
      // Keep probing the pinned Playwright installation.
    }
  }
  if (available.length !== 1) {
    throw new Error("the pinned Playwright Chromium executable is missing or ambiguous");
  }
  return available[0];
}

function spawnChild(command, args, environment) {
  return spawn(command, args, {
    env: environment,
    stdio: "ignore",
    detached: true,
  });
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parseOwnedBrowserProcess(line, profileRoot = "/var/lib/geo/browser-profile") {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
  if (match === null) return null;
  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const args = match[3] ?? "";
  if (!Number.isSafeInteger(pid) || pid < 2 || !Number.isSafeInteger(parentPid) || parentPid < 0) {
    return null;
  }
  const profilePrefix = `${profileRoot.replace(/\/$/u, "")}/ctrip-account-`;
  const profileMatch = new RegExp(
    `--user-data-dir=${escapeRegExp(profilePrefix)}([0-9a-f-]{36})(?:\\s|$)`,
    "u",
  ).exec(args);
  const runtimeAccountMatch = /\/tmp\/geo-browser\/accounts\/([0-9a-f-]{36})(?:\/|\s|$)/u.exec(
    args,
  );
  const displayMatch = /(?:^|\s)(?:-?display|Xvfb)\s+:([0-9]+)(?:\s|$)/u.exec(args);
  const vncMatch = /(?:^|\s)-rfbport\s+([0-9]+)(?:\s|$)/u.exec(args);
  const websockifyMatch = /127\.0\.0\.1:(13[0-9]{3})(?:\s|$)/u.exec(args);
  return Object.freeze({
    pid,
    parentPid,
    args,
    accountId: profileMatch?.[1] ?? runtimeAccountMatch?.[1] ?? null,
    displayNumber: displayMatch === null ? null : Number(displayMatch[1]),
    vncPort: vncMatch === null ? null : Number(vncMatch[1]),
    websockifyPort: websockifyMatch === null ? null : Number(websockifyMatch[1]),
  });
}

async function listOwnedBrowserProcesses(profileRoot = "/var/lib/geo/browser-profile") {
  const { stdout } = await execFile("ps", ["-eo", "pid=,ppid=,args="], { maxBuffer: 2_000_000 });
  return stdout
    .split("\n")
    .map((line) => parseOwnedBrowserProcess(line, profileRoot))
    .filter((process) => process !== null);
}

async function terminateOwnedProcess(processInfo) {
  try {
    process.kill(-processInfo.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        process.kill(processInfo.pid, "SIGTERM");
      } catch (fallbackError) {
        if (fallbackError?.code !== "ESRCH") return false;
      }
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  try {
    process.kill(-processInfo.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        process.kill(processInfo.pid, "SIGKILL");
      } catch (fallbackError) {
        if (fallbackError?.code !== "ESRCH") return false;
      }
    }
  }
  return true;
}

function killChildGroup(child, signal) {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `${label} did not become ready`,
    lastError === null ? undefined : { cause: lastError },
  );
}

function portIsOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function contentType(path) {
  const types = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
  ]);
  return types.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function writeJson(response, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

async function readJsonBody(request) {
  const declared = Number(request.headers["content-length"]);
  if (!Number.isInteger(declared) || declared < 2 || declared > MAX_BODY_BYTES) {
    throw new TypeError("request body size is invalid");
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > MAX_BODY_BYTES) throw new TypeError("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function rewrittenCdpPayload(value, accountId) {
  if (Array.isArray(value)) return value.map((entry) => rewrittenCdpPayload(entry, accountId));
  if (typeof value !== "object" || value === null) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "webSocketDebuggerUrl" && typeof entry === "string") {
      const parsed = new URL(entry);
      const suffix = parsed.pathname.replace(/^\/+/, "");
      result[key] = `ws://127.0.0.1:${CDP_HOST_PORT}${accountCdpPath(accountId, suffix)}`;
    } else {
      result[key] = rewrittenCdpPayload(entry, accountId);
    }
  }
  return result;
}

function proxyUpgrade(request, downstream, head, port, upstreamPath) {
  const upstream = createConnection({ host: "127.0.0.1", port });
  const close = () => {
    downstream.destroy();
    upstream.destroy();
  };
  downstream.on("error", close);
  downstream.on("close", () => upstream.destroy());
  upstream.on("error", close);
  upstream.on("connect", () => {
    const lines = [`${request.method ?? "GET"} ${upstreamPath} HTTP/${request.httpVersion}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name?.toLowerCase() === "host") continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push(`Host: 127.0.0.1:${port}`, "", "");
    upstream.write(lines.join("\r\n"));
    if (head.byteLength > 0) upstream.write(head);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
}

export class AccountBrowserSessionManager {
  constructor(options) {
    this.profileRoot = options.profileRoot;
    this.downloadRoot = options.downloadRoot;
    this.artifactRoot = options.artifactRoot;
    this.passwordFile = options.passwordFile;
    this.chromiumExecutable = options.chromiumExecutable;
    this.maxSessions = options.maxSessions;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS;
    this.processLimit = options.processLimit ?? DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT;
    this.taskLimit = options.taskLimit ?? DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT;
    this.enforceStartAdmission = options.enforceStartAdmission ?? false;
    this.listProcesses =
      options.listProcesses ?? (() => listOwnedBrowserProcesses(this.profileRoot));
    this.readTaskCount = options.readTaskCount ?? (() => readCgroupTaskCount());
    this.terminateProcess = options.terminateProcess ?? terminateOwnedProcess;
    this.terminateOptions = options.terminateOptions ?? {};
    this.startSession =
      options.startSession ??
      ((descriptor, slot, startUrl) => this.start(descriptor, slot, startUrl));
    if (!Number.isSafeInteger(this.idleTtlMs) || this.idleTtlMs < 60_000) {
      throw new TypeError("browser idle TTL must be at least one minute");
    }
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      this.maxSessions > MAX_ACCOUNT_BROWSER_SESSIONS
    ) {
      throw new TypeError(
        `browser session capacity must be from 1 through ${MAX_ACCOUNT_BROWSER_SESSIONS}`,
      );
    }
    if (!Number.isSafeInteger(this.processLimit) || this.processLimit < 1) {
      throw new TypeError("browser process limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.taskLimit) || this.taskLimit < 1) {
      throw new TypeError("browser task limit must be a positive safe integer");
    }
    this.sessions = new Map();
    this.activations = new Map();
    this.sessionMaintenance = new Map();
    this.availableSlots = Array.from({ length: this.maxSessions }, (_, index) => index);
    this.maintenanceRun = null;
    this.closeRun = null;
    this.startAdmissionTail = Promise.resolve();
    this.closing = false;
    this.processInventory = [];
    this.processInventoryAt = 0;
    this.processInventoryHealthy = true;
    this.processInventoryError = null;
    this.taskInventoryCount = 0;
    this.taskInventoryAt = 0;
    this.taskInventoryHealthy = true;
    this.taskInventoryError = null;
  }

  async activate(accountId, profileKey, startUrl) {
    if (this.closing) throw new Error("account browser session manager is closing");
    const descriptor = accountProfileDescriptor(this.profileRoot, accountId, profileKey);
    const normalizedStartUrl =
      startUrl === undefined ? undefined : requireAccountStartUrl(startUrl);
    const pending = this.activations.get(descriptor.accountId);
    if (pending !== undefined) return pending;

    const activation = this.activateOne(descriptor, normalizedStartUrl);
    this.activations.set(descriptor.accountId, activation);
    try {
      return await activation;
    } finally {
      if (this.activations.get(descriptor.accountId) === activation) {
        this.activations.delete(descriptor.accountId);
      }
    }
  }

  async activateOne(descriptor, normalizedStartUrl) {
    while (true) {
      while (this.sessionMaintenance.has(descriptor.accountId)) {
        await this.sessionMaintenance.get(descriptor.accountId).completed;
      }
      const existing = this.sessions.get(descriptor.accountId);
      if (existing === undefined) break;
      const desiredCompatibilityArgs = browserCompatibilityArgsForStartUrl(
        normalizedStartUrl ?? existing.startUrl,
      );
      const existingMatchesLaunchProfile = stringArraysEqual(
        existing.browserCompatibilityArgs ?? [],
        desiredCompatibilityArgs,
      );
      if (
        existingMatchesLaunchProfile &&
        existing.children.every(childIsRunning) &&
        existing.connections > 0
      ) {
        existing.lastUsedAt = Date.now();
        return existing;
      }

      const maintenance = this.beginSessionMaintenance(existing);
      try {
        if (this.sessions.get(descriptor.accountId) !== existing) continue;
        if (existingMatchesLaunchProfile && existing.children.every(childIsRunning)) {
          if (existing.connections > 0) {
            existing.lastUsedAt = Date.now();
            return existing;
          }
          if (await cdpDiscoveryIsResponsive(existing)) {
            existing.lastUsedAt = Date.now();
            await enforceSessionTabLimit(existing);
            return existing;
          }
        }
        if (existing.connections > 0) {
          throw new Error("account browser launch profile cannot change while connected");
        }
        if (!(await this.stopSessionProcesses(existing))) {
          throw new Error("account browser session could not be terminated");
        }
      } finally {
        this.finishSessionMaintenance(existing.accountId, maintenance);
      }
      break;
    }
    return this.withStartAdmission(async () => {
      const admissionStartedAt = Date.now();
      if (this.enforceStartAdmission) await this.maintain(admissionStartedAt);
      let evicted = false;
      if (this.availableSlots.length === 0) {
        const evictable = [...this.sessions.values()]
          .filter(
            (session) =>
              session.connections === 0 &&
              !sessionIsAwaitingInitialConnection(session, admissionStartedAt) &&
              !this.activations.has(session.accountId) &&
              !this.sessionMaintenance.has(session.accountId),
          )
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (evictable === undefined) throw new Error("all account browser sessions are busy");
        if (!(await this.stop(evictable))) {
          throw new Error("account browser session could not be evicted");
        }
        evicted = true;
      }
      if (this.enforceStartAdmission) {
        if (evicted) {
          await Promise.all([this.refreshProcessInventory(), this.refreshTaskInventory()]);
        }
        const admission = await this.admissionSnapshot();
        if (!admission.canClaim) {
          const reason = !admission.processInventoryHealthy
            ? `process inventory unavailable: ${admission.processInventoryError ?? "unknown"}`
            : !admission.taskInventoryHealthy
              ? `task inventory unavailable: ${admission.taskInventoryError ?? "unknown"}`
              : admission.processCount >= admission.maxProcessCount
                ? `process watermark reached (${admission.processCount}/${admission.maxProcessCount})`
                : admission.taskCount >= admission.maxTaskCount
                  ? `cgroup task watermark reached (${admission.taskCount}/${admission.maxTaskCount})`
                  : `session capacity reached (${admission.activeSessions}/${admission.maxActiveSessions})`;
          throw new BrowserHostAdmissionPausedError(reason);
        }
      }
      const slot = this.availableSlots.shift();
      if (slot === undefined) throw new Error("account browser session capacity is unavailable");
      try {
        const session = await this.startSession(descriptor, slot, normalizedStartUrl);
        this.sessions.set(descriptor.accountId, session);
        return session;
      } catch (error) {
        this.availableSlots.push(slot);
        this.availableSlots.sort((left, right) => left - right);
        throw error;
      }
    });
  }

  async withStartAdmission(operation) {
    const previous = this.startAdmissionTail;
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.startAdmissionTail = tail;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.startAdmissionTail === tail) this.startAdmissionTail = Promise.resolve();
    }
  }

  get(accountId) {
    const normalized = requireAccountId(accountId);
    if (this.closing || this.sessionMaintenance.has(normalized)) return null;
    const session = this.sessions.get(normalized);
    if (session === undefined || !session.children.every(childIsRunning)) return null;
    session.lastUsedAt = Date.now();
    return session;
  }

  async stopAccount(accountId) {
    const normalized = requireAccountId(accountId);
    while (true) {
      const maintenance = this.sessionMaintenance.get(normalized);
      if (maintenance !== undefined) {
        await maintenance.completed;
        continue;
      }
      const activation = this.activations.get(normalized);
      if (activation !== undefined) {
        await activation.catch(() => undefined);
        continue;
      }
      const session = this.sessions.get(normalized);
      if (session === undefined) return true;
      if (session.connections > 0) return false;
      return this.stop(session);
    }
  }

  beginSessionMaintenance(session) {
    let resolveCompleted;
    const completed = new Promise((resolvePromise) => {
      resolveCompleted = resolvePromise;
    });
    const maintenance = { session, completed, resolveCompleted };
    this.sessionMaintenance.set(session.accountId, maintenance);
    return maintenance;
  }

  finishSessionMaintenance(accountId, maintenance) {
    if (this.sessionMaintenance.get(accountId) === maintenance) {
      this.sessionMaintenance.delete(accountId);
    }
    maintenance.resolveCompleted();
  }

  async start(descriptor, slot, startUrl) {
    await ensureProfileDirectory(descriptor);
    const displayNumber = DISPLAY_BASE + slot;
    const cdpPort = CDP_PORT_BASE + slot;
    const vncPort = VNC_PORT_BASE + slot;
    const websockifyPort = WEBSOCKIFY_PORT_BASE + slot;
    const runtimeRoot = `/tmp/geo-browser/accounts/${descriptor.accountId}`;
    const runtimeHome = join(runtimeRoot, "home");
    const runtimeXdg = join(runtimeRoot, "xdg");
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
    await mkdir(runtimeXdg, { recursive: true, mode: 0o700 });
    const environment = {
      ...process.env,
      DISPLAY: `:${displayNumber}`,
      HOME: runtimeHome,
      XDG_RUNTIME_DIR: runtimeXdg,
    };
    const children = [];
    try {
      const xvfb = spawnChild(
        "Xvfb",
        [`:${displayNumber}`, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-noreset"],
        environment,
      );
      children.push(xvfb);
      await waitFor(async () => {
        if (!childIsRunning(xvfb)) throw new Error("Xvfb exited");
        try {
          await access(`/tmp/.X11-unix/X${displayNumber}`);
          return true;
        } catch {
          return false;
        }
      }, "account Xvfb");

      const browserCompatibilityArgs = browserCompatibilityArgsForStartUrl(startUrl);
      const chromiumArgs = chromiumLaunchArguments({
        cdpPort,
        profileDirectory: descriptor.directory,
        startUrl,
      });
      const chromium = spawnChild(this.chromiumExecutable, chromiumArgs, environment);
      children.push(chromium);
      await waitFor(async () => {
        if (!childIsRunning(chromium)) throw new Error("Chromium exited");
        try {
          const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
            signal: AbortSignal.timeout(500),
          });
          return response.ok;
        } catch {
          return false;
        }
      }, "account Chromium");

      const x11vnc = spawnChild(
        "x11vnc",
        [
          "-display",
          `:${displayNumber}`,
          "-forever",
          "-shared",
          "-rfbauth",
          this.passwordFile,
          "-rfbport",
          String(vncPort),
          "-listen",
          "127.0.0.1",
          "-noxdamage",
          "-quiet",
        ],
        environment,
      );
      children.push(x11vnc);
      await waitFor(
        async () => childIsRunning(x11vnc) && (await portIsOpen(vncPort)),
        "account VNC",
      );

      const websockify = spawnChild(
        "/usr/bin/websockify",
        [`127.0.0.1:${websockifyPort}`, `127.0.0.1:${vncPort}`],
        environment,
      );
      children.push(websockify);
      await waitFor(
        async () => childIsRunning(websockify) && (await portIsOpen(websockifyPort)),
        "account websockify",
      );

      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        displayNumber,
        cdpPort,
        vncPort,
        websockifyPort,
        startUrl: startUrl ?? DEFAULT_START_URL,
        browserCompatibilityArgs,
        children,
        connections: 0,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
    } catch (error) {
      await Promise.allSettled(children.reverse().map(terminateChild));
      throw error;
    }
  }

  async stopSessionProcesses(session) {
    const results = await Promise.all(
      [...session.children].reverse().map((child) => terminateChild(child, this.terminateOptions)),
    );
    const allStopped = results.every(Boolean);
    if (allStopped && this.sessions.get(session.accountId) === session) {
      this.sessions.delete(session.accountId);
      const slotStillInUse = [...this.sessions.values()].some(
        (candidate) => candidate.slot === session.slot,
      );
      if (!slotStillInUse && !this.availableSlots.includes(session.slot)) {
        this.availableSlots.push(session.slot);
        this.availableSlots.sort((left, right) => left - right);
      }
    }
    return allStopped;
  }

  async refreshProcessInventory() {
    try {
      this.processInventory = await this.listProcesses();
      this.processInventoryAt = Date.now();
      this.processInventoryHealthy = true;
      this.processInventoryError = null;
    } catch (error) {
      this.processInventory = [];
      this.processInventoryAt = Date.now();
      this.processInventoryHealthy = false;
      this.processInventoryError = error instanceof Error ? error.message : String(error);
    }
    return this.processInventory;
  }

  async reapOrphanedProcesses() {
    const processes = await this.refreshProcessInventory();
    // Activation starts the OS processes before the session is inserted into
    // `sessions`. Keep those processes protected from the orphan reaper until
    // activation settles; otherwise the maintenance loop can kill a healthy
    // login window during its startup grace period.
    const activeAccounts = new Set([...this.sessions.keys(), ...this.activations.keys()]);
    const activeSlots = new Set([...this.sessions.values()].map((session) => session.slot));
    const orphaned = processes.filter((processInfo) => {
      if (processInfo.accountId !== null) return !activeAccounts.has(processInfo.accountId);
      const displaySlot =
        processInfo.displayNumber === null ? null : processInfo.displayNumber - DISPLAY_BASE;
      const vncSlot = processInfo.vncPort === null ? null : processInfo.vncPort - VNC_PORT_BASE;
      const websockifySlot =
        processInfo.websockifyPort === null
          ? null
          : processInfo.websockifyPort - WEBSOCKIFY_PORT_BASE;
      const slot = [displaySlot, vncSlot, websockifySlot].find((value) => value !== null);
      return (
        slot !== undefined &&
        slot >= 0 &&
        slot < MAX_ACCOUNT_BROWSER_SESSIONS &&
        !activeSlots.has(slot)
      );
    });
    await Promise.allSettled(orphaned.map((processInfo) => this.terminateProcess(processInfo)));
    if (orphaned.length > 0) await this.refreshProcessInventory();
    return orphaned.length;
  }

  async processCount() {
    const now = Date.now();
    if (now - this.processInventoryAt > 1_000) await this.refreshProcessInventory();
    return this.processInventory.length;
  }

  async refreshTaskInventory() {
    try {
      const taskCount = await this.readTaskCount();
      if (!Number.isSafeInteger(taskCount) || taskCount < 0) {
        throw new TypeError("browser cgroup task count is invalid");
      }
      this.taskInventoryCount = taskCount;
      this.taskInventoryAt = Date.now();
      this.taskInventoryHealthy = true;
      this.taskInventoryError = null;
    } catch (error) {
      this.taskInventoryCount = this.taskLimit;
      this.taskInventoryAt = Date.now();
      this.taskInventoryHealthy = false;
      this.taskInventoryError = error instanceof Error ? error.message : String(error);
    }
    return this.taskInventoryCount;
  }

  async taskCount() {
    const now = Date.now();
    if (now - this.taskInventoryAt > 1_000) await this.refreshTaskInventory();
    return this.taskInventoryCount;
  }

  async admissionSnapshot() {
    const [processCount, taskCount] = await Promise.all([this.processCount(), this.taskCount()]);
    return Object.freeze({
      activeSessions: this.sessions.size,
      maxActiveSessions: this.maxSessions,
      processCount: this.processInventoryHealthy ? processCount : this.processLimit,
      maxProcessCount: this.processLimit,
      processInventoryHealthy: this.processInventoryHealthy,
      processInventoryError: this.processInventoryError,
      taskCount: this.taskInventoryHealthy ? taskCount : this.taskLimit,
      maxTaskCount: this.taskLimit,
      taskInventoryHealthy: this.taskInventoryHealthy,
      taskInventoryError: this.taskInventoryError,
      canClaim:
        this.processInventoryHealthy &&
        this.taskInventoryHealthy &&
        this.sessions.size < this.maxSessions &&
        processCount < this.processLimit &&
        taskCount < this.taskLimit,
    });
  }

  async stop(session, options = {}) {
    while (true) {
      const existingMaintenance = this.sessionMaintenance.get(session.accountId);
      if (existingMaintenance !== undefined) {
        await existingMaintenance.completed;
        if (this.sessions.get(session.accountId) !== session) return true;
        continue;
      }
      const maintenance = this.beginSessionMaintenance(session);
      try {
        if (this.sessions.get(session.accountId) !== session) {
          return await this.stopSessionProcesses(session);
        }
        if (options.allowConnected !== true && session.connections > 0) return false;
        if (options.closeTabs === true) {
          await closeAllSessionTabs(session).catch(() => undefined);
        }
        return await this.stopSessionProcesses(session);
      } finally {
        this.finishSessionMaintenance(session.accountId, maintenance);
      }
    }
  }

  async close() {
    if (this.closeRun !== null) return this.closeRun;
    this.closing = true;
    const current = (async () => {
      await this.maintenanceRun?.catch(() => undefined);
      while (this.activations.size > 0 || this.sessionMaintenance.size > 0) {
        await Promise.allSettled([
          ...this.activations.values(),
          ...[...this.sessionMaintenance.values()].map((maintenance) => maintenance.completed),
        ]);
      }
      const results = await Promise.allSettled(
        [...this.sessions.values()].map((session) => this.stop(session, { allowConnected: true })),
      );
      return (
        this.sessions.size === 0 &&
        results.every((result) => result.status === "fulfilled" && result.value === true)
      );
    })();
    this.closeRun = current;
    return current;
  }

  async maintain(now = Date.now()) {
    if (this.closing) return;
    if (this.maintenanceRun !== null) return this.maintenanceRun;
    const current = (async () => {
      await this.reapOrphanedProcesses();
      let taskCount = await this.refreshTaskInventory();
      if (this.taskInventoryHealthy && taskCount >= this.taskLimit) {
        const pressureCandidates = [...this.sessions.values()]
          .filter(
            (session) =>
              session.connections === 0 &&
              !sessionIsAwaitingInitialConnection(session, now) &&
              !this.activations.has(session.accountId) &&
              !this.sessionMaintenance.has(session.accountId),
          )
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
        for (const session of pressureCandidates) {
          if (taskCount < this.taskLimit) break;
          if (this.sessions.get(session.accountId) !== session || session.connections > 0) continue;
          if (await this.stop(session, { closeTabs: true })) {
            taskCount = await this.refreshTaskInventory();
            if (!this.taskInventoryHealthy) break;
          }
        }
      }
      for (const session of [...this.sessions.values()]) {
        if (this.sessions.get(session.accountId) !== session) continue;
        if (this.activations.has(session.accountId)) continue;
        if (this.sessionMaintenance.has(session.accountId)) continue;
        if (sessionIsAwaitingInitialConnection(session, now)) continue;
        if (session.children.every(childIsRunning) && session.connections > 0) continue;

        const maintenance = this.beginSessionMaintenance(session);
        try {
          if (this.sessions.get(session.accountId) !== session) continue;
          if (!session.children.every(childIsRunning)) {
            await this.stopSessionProcesses(session);
            continue;
          }
          if (session.connections === 0 && now - session.lastUsedAt >= this.idleTtlMs) {
            await closeAllSessionTabs(session).catch(() => undefined);
            await this.stopSessionProcesses(session);
            continue;
          }
          if (session.connections === 0) await enforceSessionTabLimit(session);
        } finally {
          this.finishSessionMaintenance(session.accountId, maintenance);
        }
      }
    })();
    this.maintenanceRun = current;
    try {
      await current;
    } finally {
      if (this.maintenanceRun === current) this.maintenanceRun = null;
    }
  }
}

function createCdpServer(manager, cpuSampler) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${CDP_HOST_PORT}`);
      if (request.method === "GET" && url.pathname === "/health/live") {
        const admission = await manager.admissionSnapshot();
        writeJson(response, 200, {
          status: "ok",
          activeSessions: admission.activeSessions,
          maxActiveSessions: admission.maxActiveSessions,
          processCount: admission.processCount,
          maxProcessCount: admission.maxProcessCount,
          processInventoryHealthy: admission.processInventoryHealthy,
          processInventoryError: admission.processInventoryError,
          taskCount: admission.taskCount,
          maxTaskCount: admission.maxTaskCount,
          taskInventoryHealthy: admission.taskInventoryHealthy,
          taskInventoryError: admission.taskInventoryError,
          canClaim: admission.canClaim,
          cpuUtilizationPercent: cpuSampler.utilizationPercent,
          cpuCoreCount: cpuSampler.cpuCoreCount,
          hostCpuUtilizationPercent: cpuSampler.hostCpuUtilizationPercent,
          hostLoadAverage1m: cpuSampler.hostLoadAverage1m,
          hostCpuCoreCount: cpuSampler.hostCpuCoreCount,
          cpuSampleAgeMs: Math.max(0, Date.now() - cpuSampler.lastObservedAtMs),
        });
        return;
      }
      const activation = /^\/accounts\/([^/]+)\/activate$/u.exec(url.pathname);
      if (request.method === "POST" && activation !== null) {
        const accountId = requireAccountId(activation[1]);
        const body = await readJsonBody(request);
        const session = await manager.activate(
          accountId,
          body?.profileKey,
          body?.startUrl === undefined ? undefined : String(body.startUrl),
        );
        writeJson(response, 200, {
          accountId: session.accountId,
          profileKey: session.profileKey,
          cdpBasePath: `/accounts/${session.accountId}/`,
          vncWebSocketPath: accountVncWebSocketPath(session.accountId),
        });
        return;
      }
      const stopRoute = /^\/accounts\/([^/]+)\/stop$/u.exec(url.pathname);
      if (request.method === "POST" && stopRoute !== null) {
        const accountId = requireAccountId(stopRoute[1]);
        const stopped = await manager.stopAccount(accountId);
        if (!stopped) {
          writeJson(response, 409, {
            status: "failed",
            accountId,
            error: "account browser session could not be terminated",
          });
          return;
        }
        writeJson(response, 200, { status: "ok", accountId });
        return;
      }
      const route = parseAccountCdpPath(url.pathname);
      if (
        request.method === "GET" &&
        route !== null &&
        ["/json/version", "/json/list"].includes(route.upstreamPath)
      ) {
        const session = manager.get(route.accountId);
        if (session === null) {
          writeJson(response, 404, { error: "account browser session is not active" });
          return;
        }
        const upstream = await fetch(`http://127.0.0.1:${session.cdpPort}${route.upstreamPath}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!upstream.ok) {
          writeJson(response, 502, { error: "account Chromium discovery failed" });
          return;
        }
        writeJson(response, 200, rewrittenCdpPayload(await upstream.json(), route.accountId));
        return;
      }
      writeJson(response, 404, { error: "not found" });
    } catch (error) {
      const admissionPaused = error instanceof BrowserHostAdmissionPausedError;
      writeJson(response, admissionPaused ? 503 : 400, {
        ...(admissionPaused ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : "request failed",
      });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${CDP_HOST_PORT}`);
      const route = parseAccountCdpPath(url.pathname);
      if (route === null || !route.upstreamPath.startsWith("/devtools/")) {
        socket.destroy();
        return;
      }
      const session = manager.get(route.accountId);
      if (session === null) {
        socket.destroy();
        return;
      }
      session.connections += 1;
      socket.once("close", () => {
        session.connections = Math.max(0, session.connections - 1);
        session.lastUsedAt = Date.now();
      });
      proxyUpgrade(request, socket, head, session.cdpPort, route.upstreamPath);
    } catch {
      socket.destroy();
    }
  });
  return server;
}

async function staticFileFor(pathname) {
  const requested = pathname === "/" ? "/vnc.html" : pathname;
  const candidate = resolve(NOVNC_WEB_ROOT, `.${requested}`);
  if (!candidate.startsWith(`${resolve(NOVNC_WEB_ROOT)}${sep}`)) return null;
  try {
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(`${resolve(NOVNC_WEB_ROOT)}${sep}`)) return null;
    const metadata = await stat(resolved);
    return metadata.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function createVncServer(manager) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${NOVNC_HOST_PORT}`);
      const path = await staticFileFor(url.pathname);
      if (request.method !== "GET" || path === null) {
        response.writeHead(404, { "content-length": "0" });
        response.end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        "cache-control": basename(path) === "vnc.html" ? "no-store" : "public, max-age=3600",
        "content-length": bytes.byteLength,
        "content-type": contentType(path),
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
    } catch {
      response.writeHead(500, { "content-length": "0" });
      response.end();
    }
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${NOVNC_HOST_PORT}`);
      const match = /^\/websockify\/accounts\/([^/]+)$/u.exec(url.pathname);
      if (match === null) {
        socket.destroy();
        return;
      }
      const session = manager.get(match[1]);
      if (session === null) {
        socket.destroy();
        return;
      }
      session.connections += 1;
      socket.once("close", () => {
        session.connections = Math.max(0, session.connections - 1);
        session.lastUsedAt = Date.now();
      });
      proxyUpgrade(request, socket, head, session.websockifyPort, "/websockify");
    } catch {
      socket.destroy();
    }
  });
  return server;
}

async function main() {
  const tenantId = requireAccountId(process.env.CTRIP_BROWSER_TENANT_ID ?? "");
  const profileRoot = process.env.GEO_BROWSER_PROFILE_ROOT ?? "/var/lib/geo/browser-profile";
  const downloadRoot = process.env.GEO_BROWSER_DOWNLOAD_ROOT ?? "/var/lib/geo/browser-downloads";
  const artifactRoot = process.env.GEO_BROWSER_ARTIFACT_ROOT ?? "/var/lib/geo/browser-artifacts";
  const passwordFile = "/run/secrets/ctrip-vnc.passwd";
  await Promise.all([
    requireDirectory(profileRoot),
    requireDirectory(downloadRoot),
    requireDirectory(artifactRoot),
  ]);
  const passwordMetadata = await requireFile(passwordFile);
  if (passwordMetadata.size !== 8) throw new TypeError("noVNC password file must contain 8 bytes");
  const tenantMarker = join(profileRoot, ".geo-tenant-id");
  try {
    await writeFile(tenantMarker, `${tenantId}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await requireFile(tenantMarker);
  if ((await readFile(tenantMarker, "utf8")).trim().toLowerCase() !== tenantId) {
    throw new TypeError("browser profile root belongs to a different tenant");
  }
  await chmod(tenantMarker, 0o600);

  const idleTtlMs = parsePositiveInteger(
    process.env.CTRIP_BROWSER_IDLE_TTL_MS,
    DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS,
    2 * 60 * 60 * 1_000,
  );
  const manager = new AccountBrowserSessionManager({
    profileRoot,
    downloadRoot,
    artifactRoot,
    passwordFile,
    chromiumExecutable: await findChromiumExecutable(),
    maxSessions: parsePositiveInteger(
      process.env.CTRIP_BROWSER_MAX_ACTIVE_SESSIONS,
      DEFAULT_MAX_SESSIONS,
      MAX_ACCOUNT_BROWSER_SESSIONS,
    ),
    idleTtlMs,
    processLimit: parsePositiveInteger(
      process.env.CTRIP_BROWSER_PROCESS_LIMIT,
      DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT,
      MAX_ACCOUNT_BROWSER_PROCESS_LIMIT,
    ),
    taskLimit: parsePositiveInteger(
      process.env.CTRIP_BROWSER_TASK_LIMIT,
      DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
      MAX_ACCOUNT_BROWSER_TASK_LIMIT,
    ),
    enforceStartAdmission: true,
  });
  const cpuSampler = new CgroupCpuSampler();
  await cpuSampler.refresh();
  const cpuTimer = setInterval(() => void cpuSampler.refresh().catch(() => undefined), 1_000);
  cpuTimer.unref();
  const cdpServer = createCdpServer(manager, cpuSampler);
  const vncServer = createVncServer(manager);
  await Promise.all([
    new Promise((resolvePromise, reject) => {
      cdpServer.once("error", reject);
      cdpServer.listen(CDP_HOST_PORT, "0.0.0.0", resolvePromise);
    }),
    new Promise((resolvePromise, reject) => {
      vncServer.once("error", reject);
      vncServer.listen(NOVNC_HOST_PORT, "0.0.0.0", resolvePromise);
    }),
  ]);
  const maintenanceTimer = setInterval(
    () => void manager.maintain().catch(() => undefined),
    60_000,
  );
  maintenanceTimer.unref();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(maintenanceTimer);
    clearInterval(cpuTimer);
    const allStopped = await manager.close();
    await Promise.allSettled([
      new Promise((resolvePromise) => cdpServer.close(resolvePromise)),
      new Promise((resolvePromise) => vncServer.close(resolvePromise)),
    ]);
    process.exit(allStopped ? 0 : 1);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(
      "Browser host account manager failed",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
