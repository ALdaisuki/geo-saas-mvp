import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ACCOUNT_BROWSER_IDLE_TTL_MS,
  ACCOUNT_BROWSER_CDP_ALLOWED_ORIGINS,
  DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS,
  DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT,
  DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
  MAX_ACCOUNT_BROWSER_SESSIONS,
  ACCOUNT_BROWSER_MAX_TABS,
  AccountBrowserSessionManager,
  CgroupCpuSampler,
  accountCdpPath,
  accountProfileDescriptor,
  accountVncWebSocketPath,
  browserCompatibilityArgsForStartUrl,
  chromiumLaunchArguments,
  ensureProfileDirectory,
  parseAccountCdpPath,
  parseOwnedBrowserProcess,
  requireAccountStartUrl,
  selectExcessPageTargetIds,
  terminateChild,
} from "./browser-host-account-manager.mjs";

const firstAccountId = "10000000-0000-4000-8000-000000000001";
const secondAccountId = "10000000-0000-4000-8000-000000000002";
const thirdAccountId = "10000000-0000-4000-8000-000000000003";

test("samples aggregate browser cgroup CPU usage as Docker-style core percentage", async () => {
  const usage = [1_000_000, 1_500_000];
  const observedAt = [10_000, 11_000];
  const sampler = new CgroupCpuSampler({
    readUsageMicros: async () => usage.shift(),
    readCoreCount: async () => 4,
    readHostLoadAverage: async () => 1.5,
    readHostCoreCount: async () => 4,
    now: () => observedAt.shift(),
  });

  assert.equal(await sampler.refresh(), 0);
  assert.equal(await sampler.refresh(), 50);
  assert.equal(sampler.utilizationPercent, 50);
  assert.equal(sampler.cpuCoreCount, 4);
  assert.equal(sampler.hostCpuUtilizationPercent, 37.5);
  assert.equal(sampler.hostLoadAverage1m, 1.5);
  assert.equal(sampler.lastObservedAtMs, 11_000);
});

function runningChild() {
  let exitListener = null;
  return {
    exitCode: null,
    signalCode: null,
    once(event, listener) {
      if (event === "exit") exitListener = listener;
    },
    kill(signal) {
      queueMicrotask(() => {
        this.signalCode = signal;
        exitListener?.();
      });
      return true;
    },
  };
}

function controlledExitChild() {
  let exitListener = null;
  let pendingSignal = null;
  let observeKill;
  const killStarted = new Promise((resolve) => {
    observeKill = resolve;
  });
  const child = {
    exitCode: null,
    signalCode: null,
    once(event, listener) {
      if (event === "exit") exitListener = listener;
    },
    kill(signal) {
      pendingSignal = signal;
      observeKill();
      return true;
    },
  };
  return {
    child,
    killStarted,
    release() {
      child.signalCode = pendingSignal;
      exitListener?.();
    },
  };
}

test("maps every account profile key to a distinct directory below the tenant root", () => {
  const first = accountProfileDescriptor(
    "/var/lib/geo/browser-profile",
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
  );
  const second = accountProfileDescriptor(
    "/var/lib/geo/browser-profile",
    secondAccountId,
    `ctrip-account-${secondAccountId}`,
  );

  assert.equal(first.directory, `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`);
  assert.equal(first.markerPath, `${first.directory}/.geo-account-id`);
  assert.notEqual(first.directory, second.directory);
});

test("rejects profile keys that do not belong to the requested account", () => {
  assert.throws(
    () =>
      accountProfileDescriptor(
        "/var/lib/geo/browser-profile",
        firstAccountId,
        `ctrip-account-${secondAccountId}`,
      ),
    /profile key does not match/u,
  );
});

test("initializes an existing persistent account profile without replacing its contents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "geo-browser-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = accountProfileDescriptor(
    root,
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
  );
  await mkdir(descriptor.directory, { mode: 0o700 });
  const existingState = join(descriptor.directory, "Local State");
  await writeFile(existingState, "persistent-browser-state", { mode: 0o600 });

  await ensureProfileDirectory(descriptor);

  assert.equal(await readFile(existingState, "utf8"), "persistent-browser-state");
  assert.equal(await readFile(descriptor.markerPath, "utf8"), `${firstAccountId}\n`);
});

test("routes CDP discovery and websocket traffic through an account-scoped prefix", () => {
  assert.equal(
    accountCdpPath(firstAccountId, "json/version"),
    `/accounts/${firstAccountId}/json/version`,
  );
  assert.deepEqual(parseAccountCdpPath(`/accounts/${firstAccountId}/json/version`), {
    accountId: firstAccountId,
    upstreamPath: "/json/version",
  });
  assert.deepEqual(
    parseAccountCdpPath(`/accounts/${firstAccountId}/devtools/browser/browser-token`),
    {
      accountId: firstAccountId,
      upstreamPath: "/devtools/browser/browser-token",
    },
  );
  assert.equal(parseAccountCdpPath("/json/version"), null);
  assert.equal(parseAccountCdpPath("/accounts/not-a-uuid/json/version"), null);
});

test("limits Chrome CDP WebSocket origins to the internal browser proxy", () => {
  assert.deepEqual(ACCOUNT_BROWSER_CDP_ALLOWED_ORIGINS, [
    "http://browser-host:10005",
    "http://127.0.0.1:10005",
  ]);
  assert.equal(ACCOUNT_BROWSER_CDP_ALLOWED_ORIGINS.includes("*"), false);
});

test("binds the noVNC websocket path to the selected account", () => {
  assert.equal(accountVncWebSocketPath(firstAccountId), `websockify/accounts/${firstAccountId}`);
});

test("accepts only platform login pages as account browser start URLs", () => {
  assert.equal(
    requireAccountStartUrl("https://mp.toutiao.com/profile_v4/index"),
    "https://mp.toutiao.com/profile_v4/index",
  );
  assert.equal(requireAccountStartUrl("about:blank"), "about:blank");
  assert.equal(
    requireAccountStartUrl("https://mp.163.com/#/article-publish"),
    "https://mp.163.com/#/article-publish",
  );
  assert.equal(requireAccountStartUrl("https://mp.163.com/"), "https://mp.163.com/");
  assert.equal(
    requireAccountStartUrl("https://www.zhihu.com/signin"),
    "https://www.zhihu.com/signin",
  );
  assert.throws(() => requireAccountStartUrl("https://example.com/"), /allowlist/u);
  assert.throws(() => requireAccountStartUrl("http://mp.toutiao.com/"), /allowlist/u);
  assert.throws(
    () => requireAccountStartUrl("https://mp.163.com/#/unexpected-route"),
    /allowlist/u,
  );
  assert.throws(
    () => requireAccountStartUrl("https://mp.163.com/unexpected#/article-publish"),
    /allowlist/u,
  );
  assert.throws(
    () => requireAccountStartUrl("https://mp.163.com/?from=unexpected#/article-publish"),
    /allowlist/u,
  );
  assert.throws(
    () => requireAccountStartUrl("https://mp.163.com/unexpected?from=anything"),
    /allowlist/u,
  );
});

test("uses a Sohu-compatible Chromium user agent without changing other platforms", () => {
  assert.deepEqual(
    browserCompatibilityArgsForStartUrl("https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1"),
    [
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    ],
  );
  assert.deepEqual(
    browserCompatibilityArgsForStartUrl("https://mp.toutiao.com/profile_v4/index"),
    [],
  );
});

test("passes the Sohu compatibility user agent through the Chromium launch arguments", () => {
  const sohuArgs = chromiumLaunchArguments({
    cdpPort: 11_000,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    startUrl: "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1",
  });
  const toutiaoArgs = chromiumLaunchArguments({
    cdpPort: 11_001,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${secondAccountId}`,
    startUrl: "https://mp.toutiao.com/profile_v4/index",
  });

  assert.equal(
    sohuArgs.includes(
      "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    ),
    true,
  );
  assert.equal(
    toutiaoArgs.some((value) => value.startsWith("--user-agent=")),
    false,
  );
});

test("rejects a start URL outside the platform allowlist before opening a browser", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    maxSessions: 1,
  });

  await assert.rejects(
    manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`, "https://example.com/"),
    /allowlist/u,
  );
});

test("keeps at most three browser tabs and ignores non-page CDP targets", () => {
  assert.equal(ACCOUNT_BROWSER_MAX_TABS, 3);
  assert.deepEqual(
    selectExcessPageTargetIds([
      { id: "page-current", type: "page" },
      { id: "service-worker", type: "service_worker" },
      { id: "page-second", type: "page" },
      { id: "page-third", type: "page" },
      { id: "page-old-fourth", type: "page" },
      { id: "page-old-fifth", type: "page" },
    ]),
    ["page-old-fourth", "page-old-fifth"],
  );
});

test("does not count child page targets such as embedded captcha frames as account tabs", () => {
  assert.deepEqual(
    selectExcessPageTargetIds(
      [
        { id: "page-editor", type: "page", url: "https://mp.sohu.com/editor" },
        { id: "page-manager", type: "page", url: "https://mp.sohu.com/manager" },
        { id: "page-login", type: "page", url: "https://mp.sohu.com/login" },
        { id: "page-old", type: "page", url: "https://example.test/old" },
        { id: "captcha-frame", type: "page", parentId: "page-editor", url: "https://captcha.test" },
      ],
      3,
    ),
    ["page-old"],
  );
});

test("retains the account start surface when trimming browser tabs", () => {
  assert.deepEqual(
    selectExcessPageTargetIds(
      [
        { id: "page-unrelated-current", type: "page", url: "https://example.test/current" },
        {
          id: "page-editor",
          type: "page",
          url: "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1",
        },
        { id: "page-unrelated-second", type: "page", url: "https://example.test/second" },
        { id: "page-unrelated-third", type: "page", url: "https://example.test/third" },
      ],
      3,
      ["https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1"],
    ),
    ["page-unrelated-third"],
  );
});

test("uses a bounded ten minute idle cleanup window", () => {
  assert.equal(ACCOUNT_BROWSER_IDLE_TTL_MS, 10 * 60 * 1_000);
  assert.equal(DEFAULT_ACCOUNT_BROWSER_IDLE_TTL_MS, 10 * 60 * 1_000);
  assert.equal(MAX_ACCOUNT_BROWSER_SESSIONS, 16);
});

test("keeps browser maintenance callable after manager construction", () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });

  assert.equal(typeof manager.maintain, "function");
});

test("parses ordinary and GEO-owned browser process rows without throwing", () => {
  assert.deepEqual(parseOwnedBrowserProcess("      7       1 /usr/bin/node manager.mjs"), {
    pid: 7,
    parentPid: 1,
    args: "/usr/bin/node manager.mjs",
    accountId: null,
    displayNumber: null,
    vncPort: null,
    websockifyPort: null,
  });
  assert.deepEqual(
    parseOwnedBrowserProcess(
      ` 101 7 chrome --user-data-dir=/var/lib/geo/browser-profile/ctrip-account-${firstAccountId} https://example.test`,
    ),
    {
      pid: 101,
      parentPid: 7,
      args: `chrome --user-data-dir=/var/lib/geo/browser-profile/ctrip-account-${firstAccountId} https://example.test`,
      accountId: firstAccountId,
      displayNumber: null,
      vncPort: null,
      websockifyPort: null,
    },
  );
  assert.equal(
    parseOwnedBrowserProcess(" 102 7 Xvfb :103 -screen 0 1440x900x24")?.displayNumber,
    103,
  );
  assert.equal(
    parseOwnedBrowserProcess(
      ` 103 1 chrome_crashpad_handler --database=/tmp/geo-browser/accounts/${secondAccountId}/home/.config/chrome`,
    )?.accountId,
    secondAccountId,
  );
});

test("reaps only orphaned account browser processes and preserves active slots", async () => {
  const terminated = [];
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 2,
    listProcesses: async () => [
      {
        pid: 101,
        parentPid: 0,
        args: "",
        accountId: firstAccountId,
        displayNumber: null,
        vncPort: null,
        websockifyPort: null,
      },
      {
        pid: 102,
        parentPid: 0,
        args: "",
        accountId: secondAccountId,
        displayNumber: null,
        vncPort: null,
        websockifyPort: null,
      },
      {
        pid: 103,
        parentPid: 0,
        args: "",
        accountId: null,
        displayNumber: 102,
        vncPort: null,
        websockifyPort: null,
      },
    ],
    terminateProcess: async (processInfo) => {
      terminated.push(processInfo.pid);
      return true;
    },
  });
  manager.sessions.set(firstAccountId, {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: "about:blank",
    browserCompatibilityArgs: [],
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  });

  await manager.reapOrphanedProcesses();
  assert.deepEqual(terminated, [102, 103]);
});

test("preserves processes for an activation that has not registered its session yet", async () => {
  const activationAccountId = secondAccountId;
  const terminated = [];
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    listProcesses: async () => [
      {
        pid: 202,
        parentPid: 0,
        args: "--user-data-dir=/var/lib/geo/browser-profile/ctrip-account-" + activationAccountId,
        accountId: activationAccountId,
        displayNumber: 100,
        vncPort: 12000,
        websockifyPort: 13000,
      },
    ],
    terminateProcess: async (processInfo) => {
      terminated.push(processInfo.pid);
      return true;
    },
  });
  manager.activations.set(activationAccountId, Promise.resolve());

  await manager.reapOrphanedProcesses();

  assert.deepEqual(terminated, []);
});

test("blocks new admission when process inventory cannot be read", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 2,
    readTaskCount: async () => 0,
    listProcesses: async () => {
      throw new Error("ps unavailable");
    },
  });

  assert.deepEqual(await manager.admissionSnapshot(), {
    activeSessions: 0,
    maxActiveSessions: 2,
    processCount: DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT,
    maxProcessCount: DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT,
    processInventoryHealthy: false,
    processInventoryError: "ps unavailable",
    taskCount: 0,
    maxTaskCount: DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
    taskInventoryHealthy: true,
    taskInventoryError: null,
    canClaim: false,
  });
});

test("blocks new admission when the browser cgroup task count cannot be read", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 2,
    listProcesses: async () => [],
    readTaskCount: async () => {
      throw new Error("cgroup task inventory unavailable");
    },
  });

  assert.deepEqual(await manager.admissionSnapshot(), {
    activeSessions: 0,
    maxActiveSessions: 2,
    processCount: 0,
    maxProcessCount: DEFAULT_ACCOUNT_BROWSER_PROCESS_LIMIT,
    processInventoryHealthy: true,
    processInventoryError: null,
    taskCount: DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
    maxTaskCount: DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
    taskInventoryHealthy: false,
    taskInventoryError: "cgroup task inventory unavailable",
    canClaim: false,
  });
});

test("blocks a new browser runtime start when the cgroup task watermark is reached", async () => {
  let starts = 0;
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 2,
    enforceStartAdmission: true,
    listProcesses: async () => [],
    readTaskCount: async () => DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
    startSession: async () => {
      starts += 1;
      throw new Error("browser start must remain blocked");
    },
  });

  await assert.rejects(
    manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`),
    /browser host admission is paused/u,
  );
  assert.equal(starts, 0);
  assert.deepEqual(manager.availableSlots, [0, 1]);
});

test("serializes new runtime admission so concurrent accounts cannot cross the task watermark", async () => {
  const taskCounts = [100, DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT];
  const startedAt = Date.now();
  let releaseFirstStart;
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });
  let firstStartEntered;
  const firstStartEnteredGate = new Promise((resolve) => {
    firstStartEntered = resolve;
  });
  let starts = 0;
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 2,
    enforceStartAdmission: true,
    listProcesses: async () => [],
    readTaskCount: async () => taskCounts.shift() ?? DEFAULT_ACCOUNT_BROWSER_TASK_LIMIT,
    startSession: async (descriptor, slot) => {
      starts += 1;
      firstStartEntered();
      await firstStartGate;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11_000 + slot,
        vncPort: 12_000 + slot,
        websockifyPort: 13_000 + slot,
        children: [runningChild()],
        connections: 0,
        startedAt,
        lastUsedAt: startedAt,
      };
    },
  });

  const first = manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`);
  await firstStartEnteredGate;
  const second = manager.activate(secondAccountId, `ctrip-account-${secondAccountId}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  releaseFirstStart();
  await first;
  await assert.rejects(second, /browser host admission is paused/u);
  assert.equal(starts, 1);
  assert.equal(manager.sessions.has(firstAccountId), true);
  assert.equal(manager.sessions.has(secondAccountId), false);
});

test("reclaims oldest disconnected sessions until cgroup task pressure clears", async (context) => {
  context.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("/json/list")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  const taskCounts = [1_700, 1_600, 1_400];
  const stopped = [];
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 4,
    taskLimit: 1_536,
    listProcesses: async () => [],
    readTaskCount: async () => taskCounts.shift() ?? 1_400,
  });
  manager.stopSessionProcesses = async (session) => {
    stopped.push(session.accountId);
    manager.sessions.delete(session.accountId);
    if (!manager.availableSlots.includes(session.slot)) {
      manager.availableSlots.push(session.slot);
      manager.availableSlots.sort((left, right) => left - right);
    }
    return true;
  };
  const sessions = [
    { accountId: firstAccountId, slot: 0, connections: 0, lastUsedAt: 100 },
    { accountId: secondAccountId, slot: 1, connections: 0, lastUsedAt: 200 },
    { accountId: thirdAccountId, slot: 2, connections: 1, lastUsedAt: 0 },
  ].map((session) => ({
    ...session,
    profileKey: `ctrip-account-${session.accountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${session.accountId}`,
    cdpPort: 11_000 + session.slot,
    vncPort: 12_000 + session.slot,
    websockifyPort: 13_000 + session.slot,
    startUrl: "about:blank",
    browserCompatibilityArgs: [],
    children: [runningChild()],
    startedAt: 0,
  }));
  for (const session of sessions) manager.sessions.set(session.accountId, session);
  manager.availableSlots = [3];

  await manager.maintain(1_000);

  assert.deepEqual(stopped, [firstAccountId, secondAccountId]);
  assert.equal(manager.sessions.has(thirdAccountId), true);
});

test("stops an account session idempotently without one being active", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });

  await manager.stopAccount(firstAccountId);
  await manager.stopAccount(firstAccountId);

  assert.equal(manager.sessions.size, 0);
});

test("refuses an explicit account stop while a browser client is connected", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });
  manager.sessions.set(firstAccountId, {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: "/var/lib/geo/browser-profile/ctrip-account-test",
    slot: 0,
    cdpPort: 11000,
    vncPort: 12000,
    websockifyPort: 13000,
    children: [runningChild()],
    connections: 1,
    startedAt: 0,
    lastUsedAt: 0,
  });

  await assert.doesNotReject(async () => {
    assert.equal(await manager.stopAccount(firstAccountId), false);
  });
  assert.equal(manager.sessions.size, 1);
  assert.equal(manager.sessions.get(firstAccountId)?.connections, 1);
});

test("does not trim tabs while an account browser session is actively connected", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });
  manager.sessions.set(firstAccountId, {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: "/var/lib/geo/browser-profile/ctrip-account-test",
    slot: 0,
    cdpPort: 11000,
    vncPort: 12000,
    websockifyPort: 13000,
    children: [runningChild()],
    connections: 1,
    startedAt: 0,
    lastUsedAt: 0,
  });

  await manager.maintain(Date.now());
  assert.equal(manager.sessions.size, 1);

  const active = manager.sessions.get(firstAccountId);
  active.connections = 0;
  active.lastUsedAt = Date.now() - ACCOUNT_BROWSER_IDLE_TTL_MS - 1_000;
  await manager.maintain(Date.now());
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(manager.availableSlots, [0]);
});

test("keeps the browser slot occupied until every child process has exited", async () => {
  const stubborn = runningChild();
  stubborn.kill = () => false;
  const child = runningChild();
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    terminateOptions: { termGraceMs: 5, killGraceMs: 5 },
  });
  manager.sessions.set(firstAccountId, {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: "/var/lib/geo/browser-profile/ctrip-account-test",
    slot: 0,
    cdpPort: 11000,
    vncPort: 12000,
    websockifyPort: 13000,
    children: [stubborn, child],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  });
  manager.availableSlots = [];

  const stopped = await manager.stop(manager.sessions.get(firstAccountId));
  assert.equal(stopped, false);
  assert.equal(manager.sessions.size, 1);
  assert.deepEqual(manager.availableSlots, []);

  stubborn.signalCode = "SIGKILL";
  assert.equal(await terminateChild(stubborn, { termGraceMs: 5, killGraceMs: 5 }), true);
  assert.equal(await manager.stop(manager.sessions.get(firstAccountId)), true);
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(manager.availableSlots, [0]);
});

test("does not let a stale session stop delete its replacement or release its slot", async () => {
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });
  const stale = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  const replacement = {
    ...stale,
    children: [runningChild()],
    startedAt: 1,
    lastUsedAt: 1,
  };
  manager.sessions.set(firstAccountId, replacement);
  manager.availableSlots = [];

  assert.equal(await manager.stop(stale), true);
  assert.equal(manager.sessions.get(firstAccountId), replacement);
  assert.deepEqual(manager.availableSlots, []);
});

test("coalesces concurrent activation requests for one account into one browser session", async () => {
  let starts = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot) => {
      starts += 1;
      await startGate;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11000,
        vncPort: 12000,
        websockifyPort: 13000,
        children: [runningChild()],
        connections: 0,
        startedAt: 0,
        lastUsedAt: 0,
      };
    },
  });

  const first = manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`);
  const second = manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  releaseStart();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(manager.sessions.size, 1);
  assert.deepEqual(manager.availableSlots, []);
});

test("restarts an existing Sohu session that lacks the current compatibility profile", async () => {
  const sohuStartUrl = "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1";
  let starts = 0;
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot, startUrl) => {
      starts += 1;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11_000,
        vncPort: 12_000,
        websockifyPort: 13_000,
        startUrl,
        browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(startUrl),
        children: [runningChild()],
        connections: 0,
        startedAt: 0,
        lastUsedAt: 0,
      };
    },
  });
  const staleSession = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: sohuStartUrl,
    browserCompatibilityArgs: [],
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, staleSession);
  manager.availableSlots = [];

  const active = await manager.activate(
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
    sohuStartUrl,
  );

  assert.equal(starts, 1);
  assert.notEqual(active, staleSession);
  assert.deepEqual(
    active.browserCompatibilityArgs,
    browserCompatibilityArgsForStartUrl(sohuStartUrl),
  );
});

test("blocks account connections while restarting an incompatible browser profile", async () => {
  const sohuStartUrl = "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1";
  const controlled = controlledExitChild();
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot, startUrl) => ({
      accountId: descriptor.accountId,
      profileKey: descriptor.profileKey,
      profileDirectory: descriptor.directory,
      slot,
      cdpPort: 11_000,
      vncPort: 12_000,
      websockifyPort: 13_000,
      startUrl,
      browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(startUrl),
      children: [runningChild()],
      connections: 0,
      startedAt: 1,
      lastUsedAt: 1,
    }),
  });
  const stale = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: sohuStartUrl,
    browserCompatibilityArgs: [],
    children: [controlled.child],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, stale);
  manager.availableSlots = [];

  const activation = manager.activate(
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
    sohuStartUrl,
  );
  await controlled.killStarted;

  assert.equal(manager.get(firstAccountId), null);
  controlled.release();
  const active = await activation;
  assert.notEqual(active, stale);
  assert.equal(manager.sessions.get(firstAccountId), active);
});

test("blocks victim connections while capacity eviction is in progress", async () => {
  const controlled = controlledExitChild();
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot) => ({
      accountId: descriptor.accountId,
      profileKey: descriptor.profileKey,
      profileDirectory: descriptor.directory,
      slot,
      cdpPort: 11_000,
      vncPort: 12_000,
      websockifyPort: 13_000,
      children: [runningChild()],
      connections: 0,
      startedAt: 1,
      lastUsedAt: 1,
    }),
  });
  const evictable = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    children: [controlled.child],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, evictable);
  manager.availableSlots = [];

  const activation = manager.activate(secondAccountId, `ctrip-account-${secondAccountId}`);
  await controlled.killStarted;

  assert.equal(manager.get(firstAccountId), null);
  controlled.release();
  const active = await activation;
  assert.equal(active.accountId, secondAccountId);
  assert.equal(manager.sessions.has(firstAccountId), false);
  assert.equal(manager.sessions.get(secondAccountId), active);
  assert.deepEqual(manager.availableSlots, []);
});

test("reuses a connected account session when another workflow requests a different page", async () => {
  const managementUrl = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page?newsType=1";
  const loginUrl = "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1";
  let starts = 0;
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async () => {
      starts += 1;
      throw new Error("a connected account session must not be restarted");
    },
  });
  const existing = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: managementUrl,
    browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(managementUrl),
    children: [runningChild()],
    connections: 1,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, existing);
  manager.availableSlots = [];

  const active = await manager.activate(
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
    loginUrl,
  );

  assert.equal(active, existing);
  assert.equal(starts, 0);
  assert.equal(manager.sessions.get(firstAccountId), existing);
  assert.equal(existing.connections, 1);
});

test("blocks account connections while activation trims tabs on a reusable session", async (context) => {
  const managementUrl = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page?newsType=1";
  let releaseTargetRead;
  const targetReadGate = new Promise((resolve) => {
    releaseTargetRead = resolve;
  });
  let targetReadEntered;
  const targetReadEnteredGate = new Promise((resolve) => {
    targetReadEntered = resolve;
  });
  context.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.endsWith("/json/version")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/json/list")) {
      targetReadEntered();
      await targetReadGate;
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });
  const existing = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: managementUrl,
    browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(managementUrl),
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, existing);
  manager.availableSlots = [];

  const activation = manager.activate(
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
    managementUrl,
  );
  await targetReadEnteredGate;

  assert.equal(manager.get(firstAccountId), null);
  releaseTargetRead();
  assert.equal(await activation, existing);
  assert.equal(manager.sessions.get(firstAccountId), existing);
});

test("does not admit an activation into an idle account session being retired", async (context) => {
  const managementUrl = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page?newsType=1";
  let releaseTargetRead;
  const targetReadGate = new Promise((resolve) => {
    releaseTargetRead = resolve;
  });
  let maintenanceEntered;
  const maintenanceEnteredGate = new Promise((resolve) => {
    maintenanceEntered = resolve;
  });
  let targetReads = 0;
  context.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.endsWith("/json/list")) {
      targetReads += 1;
      if (targetReads === 1) {
        maintenanceEntered();
        await targetReadGate;
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/json/version")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  let starts = 0;
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot, startUrl) => {
      starts += 1;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11_000,
        vncPort: 12_000,
        websockifyPort: 13_000,
        startUrl,
        browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(startUrl),
        children: [runningChild()],
        connections: 0,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
    },
  });
  const retiring = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: managementUrl,
    browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(managementUrl),
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, retiring);
  manager.availableSlots = [];

  const maintenance = manager.maintain(ACCOUNT_BROWSER_IDLE_TTL_MS + 1);
  await maintenanceEnteredGate;

  let activationSettled = false;
  const activation = manager
    .activate(firstAccountId, `ctrip-account-${firstAccountId}`, managementUrl)
    .then((session) => {
      activationSettled = true;
      return session;
    });
  await new Promise((resolve) => setImmediate(resolve));
  const admittedDuringMaintenance = manager.get(firstAccountId);
  const settledBeforeRetirement = activationSettled;

  releaseTargetRead();
  await maintenance;
  const active = await activation;

  assert.equal(settledBeforeRetirement, false);
  assert.equal(admittedDuringMaintenance, null);
  assert.notEqual(active, retiring);
  assert.equal(starts, 1);
  assert.equal(manager.sessions.get(firstAccountId), active);
  assert.deepEqual(manager.availableSlots, []);
});

test("skips account maintenance while activation is already in flight", async (context) => {
  const managementUrl = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page?newsType=1";
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  let discoveryEntered;
  const discoveryEnteredGate = new Promise((resolve) => {
    discoveryEntered = resolve;
  });
  context.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.endsWith("/json/version")) {
      discoveryEntered();
      await discoveryGate;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/json/list")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
  });
  const existing = {
    accountId: firstAccountId,
    profileKey: `ctrip-account-${firstAccountId}`,
    profileDirectory: `/var/lib/geo/browser-profile/ctrip-account-${firstAccountId}`,
    slot: 0,
    cdpPort: 11_000,
    vncPort: 12_000,
    websockifyPort: 13_000,
    startUrl: managementUrl,
    browserCompatibilityArgs: browserCompatibilityArgsForStartUrl(managementUrl),
    children: [runningChild()],
    connections: 0,
    startedAt: 0,
    lastUsedAt: 0,
  };
  manager.sessions.set(firstAccountId, existing);
  manager.availableSlots = [];

  const activation = manager.activate(
    firstAccountId,
    `ctrip-account-${firstAccountId}`,
    managementUrl,
  );
  await discoveryEnteredGate;
  await manager.maintain(ACCOUNT_BROWSER_IDLE_TTL_MS + 1);

  assert.equal(manager.sessions.get(firstAccountId), existing);
  releaseDiscovery();
  assert.equal(await activation, existing);
  assert.equal(manager.sessions.get(firstAccountId), existing);
});

test("waits for an in-flight activation before stopping the account session", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot) => {
      await startGate;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11000,
        vncPort: 12000,
        websockifyPort: 13000,
        children: [runningChild()],
        connections: 0,
        startedAt: 0,
        lastUsedAt: 0,
      };
    },
  });

  const activation = manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`);
  const stop = manager.stopAccount(firstAccountId);
  releaseStart();
  await Promise.all([activation, stop]);

  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(manager.availableSlots, [0]);
});

test("waits for in-flight activation and prevents new admission while closing", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let startEntered;
  const startEnteredGate = new Promise((resolve) => {
    startEntered = resolve;
  });
  const manager = new AccountBrowserSessionManager({
    profileRoot: "/var/lib/geo/browser-profile",
    downloadRoot: "/var/lib/geo/browser-downloads",
    artifactRoot: "/var/lib/geo/browser-artifacts",
    passwordFile: "/run/secrets/ctrip-vnc.passwd",
    chromiumExecutable: "/ms-playwright/chromium/chrome",
    maxSessions: 1,
    startSession: async (descriptor, slot) => {
      startEntered();
      await startGate;
      return {
        accountId: descriptor.accountId,
        profileKey: descriptor.profileKey,
        profileDirectory: descriptor.directory,
        slot,
        cdpPort: 11_000,
        vncPort: 12_000,
        websockifyPort: 13_000,
        children: [runningChild()],
        connections: 0,
        startedAt: 0,
        lastUsedAt: 0,
      };
    },
  });

  const activation = manager.activate(firstAccountId, `ctrip-account-${firstAccountId}`);
  await startEnteredGate;
  let closeSettled = false;
  const closing = manager.close().then((closed) => {
    closeSettled = true;
    return closed;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeSettled, false);
  await assert.rejects(
    manager.activate(secondAccountId, `ctrip-account-${secondAccountId}`),
    /closing/u,
  );
  assert.equal(manager.get(firstAccountId), null);

  releaseStart();
  await activation;
  assert.equal(await closing, true);
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(manager.availableSlots, [0]);
});
