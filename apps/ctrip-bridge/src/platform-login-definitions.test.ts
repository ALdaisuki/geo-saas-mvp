import { describe, expect, it, vi } from "vitest";

import {
  getPlatformLoginDefinition,
  githubSessionProbeReferenceUrl,
  navigateToPlatformLogin,
  PLATFORM_LOGIN_DEFINITIONS,
  PLATFORM_LOGIN_IDS,
  reviewPlatformLoginSession,
  type PlatformLoginNavigator,
  type PlatformSessionProbe,
} from "./platform-login-definitions.js";

const EXPECTED_DEFINITIONS = {
  toutiao: {
    loginUrl: "https://mp.toutiao.com/profile_v4/index",
    hosts: ["mp.toutiao.com"],
    repositoryUrl: "https://github.com/RyanYipeng/SyncCaster",
    commitSha: "ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe",
    sourcePath: "apps/extension/src/background/platform-api.ts",
    symbol: "toutiaoApi.fetchUserInfo",
    lineRange: { start: 5527, end: 5578 },
    licenseSpdx: "MIT",
  },
  sohu: {
    loginUrl: "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1",
    hosts: ["mp.sohu.com"],
    repositoryUrl: "https://github.com/wechatsync/Wechatsync",
    commitSha: "a98e42865387285afcc027c61836488748f3b30f",
    sourcePath: "packages/core/src/adapters/platforms/sohu.ts",
    symbol: "SohuAdapter.checkAuth",
    lineRange: { start: 59, end: 120 },
    licenseSpdx: "GPL-3.0",
  },
  baijiahao: {
    loginUrl: "https://baijiahao.baidu.com/",
    hosts: ["baijiahao.baidu.com"],
    repositoryUrl: "https://github.com/wechatsync/Wechatsync",
    commitSha: "a98e42865387285afcc027c61836488748f3b30f",
    sourcePath: "packages/core/src/adapters/platforms/baijiahao.ts",
    symbol: "BaijiahaoAdapter.checkAuth",
    lineRange: { start: 46, end: 87 },
    licenseSpdx: "GPL-3.0",
  },
  netease: {
    loginUrl: "https://mp.163.com/",
    hosts: ["mp.163.com"],
    repositoryUrl: "https://github.com/doocs/cose",
    commitSha: "e70fa9e92a71cd2f10e0c883981f324a332162d4",
    sourcePath: "packages/detection/src/platforms/wangyihao.js",
    symbol: "detectWangyihaoUser",
    lineRange: { start: 10, end: 50 },
    licenseSpdx: "Apache-2.0",
  },
  zhihu: {
    loginUrl: "https://www.zhihu.com/signin",
    hosts: ["www.zhihu.com", "zhuanlan.zhihu.com"],
    repositoryUrl: "https://github.com/jackwener/OpenCLI",
    commitSha: "a86d64705c526dc710f790e66cfcabf6ecf786b9",
    sourcePath: "clis/zhihu/auth.js",
    symbol: "verifyZhihuIdentity",
    lineRange: { start: 1, end: 61 },
    licenseSpdx: "Apache-2.0",
  },
  ctrip_community: {
    loginUrl: "https://passport.ctrip.com/user/login",
    hosts: ["my.ctrip.com", "we.ctrip.com", "www.ctrip.com"],
    repositoryUrl: "https://github.com/jackwener/OpenCLI",
    commitSha: "399c0de2a76eb979aee3a3836cf2d24fd247780f",
    sourcePath: "clis/ctrip/auth.js",
    symbol: "verifyCtripIdentity",
    lineRange: { start: 10, end: 35 },
    licenseSpdx: "Apache-2.0",
  },
} as const;

function navigatorAt(url: string): PlatformLoginNavigator {
  return {
    goto: async () => undefined,
    url: () => url,
  };
}

function probeReturning(
  observation: Awaited<ReturnType<PlatformSessionProbe["inspect"]>>,
): PlatformSessionProbe {
  return { inspect: async () => observation };
}

describe("platform login definitions", () => {
  it("pins complete login and GitHub identity-probe definitions for all configured platforms", () => {
    expect(PLATFORM_LOGIN_DEFINITIONS).toHaveLength(6);
    expect(PLATFORM_LOGIN_DEFINITIONS.map(({ platform }) => platform)).toEqual(PLATFORM_LOGIN_IDS);

    for (const platform of PLATFORM_LOGIN_IDS) {
      const definition = getPlatformLoginDefinition(platform);
      const expected = EXPECTED_DEFINITIONS[platform];
      expect(definition).toMatchObject({
        schemaVersion: "geo.platform-login-definition.v1",
        platform,
        loginUrl: expected.loginUrl,
        expectedAuthenticatedHosts: expected.hosts,
        sessionProbe: {
          repositoryUrl: expected.repositoryUrl,
          commitSha: expected.commitSha,
          sourcePath: expected.sourcePath,
          symbol: expected.symbol,
          lineRange: expected.lineRange,
          licenseSpdx: expected.licenseSpdx,
        },
      });
      expect(definition.sessionProbe.integrationConstraint.length).toBeGreaterThan(20);
    }
  });

  it("uses bounded HTTPS URLs and immutable GitHub blob references", () => {
    for (const definition of PLATFORM_LOGIN_DEFINITIONS) {
      const loginUrl = new URL(definition.loginUrl);
      expect(loginUrl.protocol).toBe("https:");
      expect(loginUrl.username).toBe("");
      expect(loginUrl.password).toBe("");
      expect(definition.expectedAuthenticatedHosts).not.toHaveLength(0);
      for (const host of definition.expectedAuthenticatedHosts) {
        expect(host).toMatch(/^[a-z0-9.-]+$/u);
        expect(host).not.toContain("*");
      }
      expect(definition.sessionProbe.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(githubSessionProbeReferenceUrl(definition.sessionProbe)).toBe(
        `${definition.sessionProbe.repositoryUrl}/blob/${definition.sessionProbe.commitSha}/${definition.sessionProbe.sourcePath}#L${String(definition.sessionProbe.lineRange.start)}-L${String(definition.sessionProbe.lineRange.end)}`,
      );
    }
  });

  it("documents the Sohu child-account selection defect and excluded cookie behavior", () => {
    expect(getPlatformLoginDefinition("sohu").sessionProbe.integrationConstraint).toContain(
      "first-child default must not be reused",
    );
    expect(getPlatformLoginDefinition("toutiao").sessionProbe.integrationConstraint).toContain(
      "do not reuse the cookie fallback",
    );
    expect(getPlatformLoginDefinition("netease").sessionProbe.integrationConstraint).toContain(
      "do not reuse the upstream cookie collection",
    );
    expect(getPlatformLoginDefinition("zhihu").sessionProbe.integrationConstraint).toContain(
      "cookie presence alone is insufficient",
    );
    expect(
      getPlatformLoginDefinition("ctrip_community").sessionProbe.integrationConstraint,
    ).toContain("browser cookie access is excluded");
  });
});

describe("platform login navigation and identity review", () => {
  it("navigates only to the fixed official entry and does not claim authentication", async () => {
    const goto = vi.fn(async () => undefined);
    const navigator: PlatformLoginNavigator = {
      goto,
      url: () => "https://mp.toutiao.com/profile_v4/index?from=redirect",
    };

    const navigation = await navigateToPlatformLogin("toutiao", navigator);

    expect(goto).toHaveBeenCalledWith("https://mp.toutiao.com/profile_v4/index", {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    expect(navigation).toEqual({
      status: "navigated",
      platform: "toutiao",
      targetUrl: "https://mp.toutiao.com/profile_v4/index",
      currentLocation: {
        origin: "https://mp.toutiao.com",
        hostname: "mp.toutiao.com",
        path: "/profile_v4/index",
      },
    });
    expect(navigation).not.toHaveProperty("authenticated");
  });

  it("does not authenticate from a matching host or redirect alone", async () => {
    await expect(
      reviewPlatformLoginSession(
        "toutiao",
        navigatorAt("https://mp.toutiao.com/profile_v4/index"),
        probeReturning({ status: "unauthenticated" }),
      ),
    ).resolves.toMatchObject({
      status: "unauthenticated",
      reason: "identity_not_confirmed",
    });
  });

  it("accepts only an explicit, non-empty account identity from the probe", async () => {
    await expect(
      reviewPlatformLoginSession(
        "baijiahao",
        navigatorAt("https://baijiahao.baidu.com/builder/rc/home"),
        probeReturning({
          status: "authenticated",
          evidence: {
            kind: "account_identity",
            accountId: "  bjh-123  ",
            displayName: "  云南旅行号  ",
            evidenceRef: " evidence://baijiahao/appinfo/123 ",
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "authenticated",
      evidence: {
        accountId: "bjh-123",
        displayName: "云南旅行号",
        evidenceRef: "evidence://baijiahao/appinfo/123",
      },
      sourceReference:
        "https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/baijiahao.ts#L46-L87",
    });

    await expect(
      reviewPlatformLoginSession(
        "baijiahao",
        navigatorAt("https://baijiahao.baidu.com/"),
        probeReturning({
          status: "authenticated",
          evidence: {
            kind: "account_identity",
            accountId: "   ",
            evidenceRef: "evidence://baijiahao/url-only",
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_identity_evidence",
    });

    await expect(
      reviewPlatformLoginSession(
        "baijiahao",
        navigatorAt("https://baijiahao.baidu.com/"),
        probeReturning({
          status: "authenticated",
          evidence: null,
        } as unknown as Awaited<ReturnType<PlatformSessionProbe["inspect"]>>),
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_identity_evidence",
    });
  });

  it("rejects lookalike, non-HTTPS and login-only hosts without invoking a probe", async () => {
    const inspect = vi.fn(async () => ({
      status: "authenticated" as const,
      evidence: {
        kind: "account_identity" as const,
        accountId: "must-not-be-used",
        evidenceRef: "evidence://unexpected-host",
      },
    }));
    const probe: PlatformSessionProbe = { inspect };

    for (const [platform, url] of [
      ["toutiao", "https://mp.toutiao.com.attacker.example/profile_v4/index"],
      ["toutiao", "http://mp.toutiao.com/profile_v4/index"],
      ["ctrip_community", "https://passport.ctrip.com/user/login"],
    ] as const) {
      await expect(
        reviewPlatformLoginSession(platform, navigatorAt(url), probe),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "unexpected_authenticated_host",
      });
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed for challenge and unavailable probe outcomes", async () => {
    await expect(
      reviewPlatformLoginSession(
        "netease",
        navigatorAt("https://mp.163.com/index.html"),
        probeReturning({ status: "challenge_required" }),
      ),
    ).resolves.toMatchObject({
      status: "challenge_required",
      reason: "challenge_detected",
    });

    await expect(
      reviewPlatformLoginSession("sohu", navigatorAt("https://mp.sohu.com/"), {
        inspect: async () => Promise.reject(new Error("probe failed")),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe_unavailable",
    });
  });
});
