import { describe, expect, it, vi } from "vitest";

import {
  getPlatformLoginDefinition,
  type PlatformBrowserLocation,
  type PlatformLoginId,
} from "./platform-login-definitions.js";
import {
  createPlaywrightPlatformSessionProbe,
  type PlaywrightPlatformSessionPage,
} from "./playwright-platform-session-probe.js";

interface TestElement {
  readonly textContent: string | null;
  readonly parentElement?: TestElement | null;
  readonly style: {
    readonly display: string;
    readonly visibility: string;
    readonly opacity: string;
  };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

function element(
  textContent: string | null,
  attributes: Readonly<Record<string, string>> = {},
  options: {
    readonly parentElement?: TestElement | null;
    readonly rect?: {
      readonly width: number;
      readonly height: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly left: number;
    };
    readonly style?: {
      readonly display: string;
      readonly visibility: string;
      readonly opacity: string;
    };
  } = {},
): TestElement {
  return {
    textContent,
    parentElement: options.parentElement ?? null,
    style: options.style ?? { display: "block", visibility: "visible", opacity: "1" },
    getAttribute: (name) => attributes[name] ?? null,
    getBoundingClientRect: () =>
      options.rect ?? {
        width: 120,
        height: 24,
        top: 100,
        right: 220,
        bottom: 124,
        left: 100,
      },
  };
}

function locationFor(platform: PlatformLoginId): PlatformBrowserLocation {
  const definition = getPlatformLoginDefinition(platform);
  const url = new URL(definition.loginUrl);
  return { origin: url.origin, hostname: url.hostname, path: url.pathname };
}

async function inspect(options: {
  readonly platform: PlatformLoginId;
  readonly expectedAccountName: string;
  readonly fetchJson?: (() => unknown | Promise<unknown>) | undefined;
  readonly challengeElements?: readonly TestElement[] | undefined;
  readonly identityElements?: readonly TestElement[] | undefined;
}) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const fetch = vi.fn(async (url: string) => {
    void url;
    return {
      ok: true,
      json: async () => options.fetchJson?.(),
    };
  });
  const page: PlaywrightPlatformSessionPage = {
    evaluate: async <Result, Argument>(
      pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument: Argument,
    ) => {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          defaultView: {
            innerHeight: 720,
            innerWidth: 1_280,
            getComputedStyle: (target: TestElement) => target.style,
          },
          querySelectorAll: (selector: string) =>
            selector.includes("captcha")
              ? (options.challengeElements ?? [])
              : (options.identityElements ?? []),
        },
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value:
          options.fetchJson === undefined
            ? vi.fn(async () => {
                throw new Error("identity endpoint unavailable");
              })
            : fetch,
      });
      try {
        return await pageFunction(argument);
      } finally {
        if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else Object.defineProperty(globalThis, "document", originalDocument);
        if (originalFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
        else Object.defineProperty(globalThis, "fetch", originalFetch);
      }
    },
  };
  const definition = getPlatformLoginDefinition(options.platform);
  const observation = await createPlaywrightPlatformSessionProbe(
    page,
    options.expectedAccountName,
  ).inspect({ definition, location: locationFor(options.platform) });
  return { observation, fetch };
}

describe("Playwright platform session probe", () => {
  it.each([
    [
      "toutiao",
      "示例旅服头条号",
      { err_no: 0, data: { media: { media_id: "tt-42", display_name: "示例旅服头条号" } } },
      "/mp/agw/media/get_media_info",
      "tt-42",
    ],
    [
      "baijiahao",
      "示例旅服百家号",
      {
        errno: 0,
        errmsg: "success",
        data: { user: { userid: "bjh-42", name: "示例旅服百家号" } },
      },
      "/builder/app/appinfo",
      "bjh-42",
    ],
    [
      "netease",
      "示例旅服网易号",
      { code: 1, data: { wemediaId: "wy-42", tname: "示例旅服网易号" } },
      "/wemedia/navinfo.do",
      "wy-42",
    ],
  ] as const)(
    "confirms %s from a non-empty API-bound account identity",
    async (platform, expectedAccountName, response, endpoint, accountId) => {
      const { observation, fetch } = await inspect({
        platform,
        expectedAccountName,
        fetchJson: () => response,
      });

      expect(observation).toMatchObject({
        status: "authenticated",
        evidence: { accountId, displayName: expectedAccountName },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toContain(endpoint);
    },
  );

  it("normalizes Toutiao's numeric media id response", async () => {
    const { observation } = await inspect({
      platform: "toutiao",
      expectedAccountName: "头条企业认证 1",
      fetchJson: () => ({
        err_no: 0,
        data: { media: { id: 1_234_567_890_123_456, display_name: "示例内容账号" } },
      }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: {
        accountId: "1234567890123456",
        displayName: "示例内容账号",
      },
    });
  });

  it("rejects an empty platform identity response even when the endpoint succeeds", async () => {
    const { observation } = await inspect({
      platform: "toutiao",
      expectedAccountName: "头条企业认证 1",
      fetchJson: () => ({
        err_no: 0,
        data: { media: { media_id: "", display_name: "" } },
      }),
    });

    expect(observation).toEqual({ status: "unavailable" });
  });

  it("accepts a platform identity when only the account id is non-empty", async () => {
    const { observation } = await inspect({
      platform: "toutiao",
      expectedAccountName: "本地显示名",
      fetchJson: () => ({
        err_no: 0,
        data: { media: { media_id: "tt-id-only", display_name: "" } },
      }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "tt-id-only" },
    });
    expect(observation).not.toHaveProperty("evidence.displayName");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "falls back to a non-empty display name when the numeric platform identity id is invalid (%s)",
    async (accountId) => {
      const { observation } = await inspect({
        platform: "toutiao",
        expectedAccountName: "示例内容账号",
        fetchJson: () => ({
          err_no: 0,
          data: { media: { id: accountId, display_name: "示例内容账号" } },
        }),
      });

      expect(observation).toMatchObject({
        status: "authenticated",
        evidence: {
          accountId: "示例内容账号",
          displayName: "示例内容账号",
        },
      });
    },
  );

  it("accepts a non-empty platform identity when the local display label differs", async () => {
    const { observation } = await inspect({
      platform: "toutiao",
      expectedAccountName: "目标头条号",
      fetchJson: () => ({
        err_no: 0,
        data: { media: { media_id: "tt-other", display_name: "其他头条号" } },
      }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "tt-other", displayName: "其他头条号" },
    });
  });

  it("confirms Zhihu identity through the canonical current-user endpoint", async () => {
    const { observation, fetch } = await inspect({
      platform: "zhihu",
      expectedAccountName: "test",
      fetchJson: () => ({ url_token: "zhihu-test", name: "test" }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "zhihu-test", displayName: "test" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://www.zhihu.com/api/v4/me?include=url_token",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("accepts a non-empty Baijiahao identity when the successful envelope omits errno", async () => {
    const { observation, fetch } = await inspect({
      platform: "baijiahao",
      expectedAccountName: "本地百家号标签",
      fetchJson: () => ({
        errmsg: "success",
        data: { user: { userid: "bjh-envelope-free", name: "百家号真实名称" } },
      }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "bjh-envelope-free", displayName: "百家号真实名称" },
    });
    expect(fetch.mock.calls[0]?.[0]).toMatch(/^\/builder\/app\/appinfo\?_=\d+$/u);
  });

  it("reports a visible challenge when the identity endpoint cannot authenticate", async () => {
    const { observation, fetch } = await inspect({
      platform: "baijiahao",
      expectedAccountName: "示例旅服百家号",
      fetchJson: () => ({ errno: 0 }),
      challengeElements: [element("请完成验证")],
    });

    expect(observation).toEqual({ status: "challenge_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an authenticated Sohu identity when a stale captcha node is present", async () => {
    const { observation, fetch } = await inspect({
      platform: "sohu",
      expectedAccountName: "小谦旅游记",
      fetchJson: () => ({
        code: 2_000_000,
        data: { accounts: [{ id: "122943573", nickName: "小谦旅游记" }] },
      }),
      challengeElements: [
        element(
          "残留验证码",
          {},
          {
            rect: {
              width: 320,
              height: 180,
              top: -1_000_000,
              right: 320,
              bottom: -999_820,
              left: 0,
            },
          },
        ),
      ],
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "122943573", displayName: "小谦旅游记" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports an actionable Sohu challenge even when the identity endpoint is still cached", async () => {
    const { observation, fetch } = await inspect({
      platform: "sohu",
      expectedAccountName: "小谦旅游记",
      fetchJson: () => ({
        code: 2_000_000,
        data: { accounts: [{ id: "122943573", nickName: "小谦旅游记" }] },
      }),
      challengeElements: [element("请完成验证")],
    });

    expect(observation).toEqual({ status: "challenge_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer authentication when the identity endpoint and DOM evidence are absent", async () => {
    const { observation } = await inspect({
      platform: "netease",
      expectedAccountName: "示例旅服网易号",
    });

    expect(observation).toEqual({ status: "unauthenticated" });
  });

  it("uses the first non-empty visible account control as the bounded Sohu identity fallback", async () => {
    const { observation } = await inspect({
      platform: "sohu",
      expectedAccountName: "本地显示名",
      identityElements: [element("示例旅服搜狐号", { "data-account-id": "sohu-child-account-42" })],
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: {
        accountId: "sohu-child-account-42",
        displayName: "示例旅服搜狐号",
      },
    });
  });

  it("accepts the first non-empty Sohu child-account identity from the platform list", async () => {
    const { observation, fetch } = await inspect({
      platform: "sohu",
      expectedAccountName: "本地显示名",
      fetchJson: () => ({
        code: 2_000_000,
        data: {
          data: [
            {
              accounts: [
                { id: "", nickName: "" },
                { id: "sohu-42", nickName: "示例旅服搜狐号" },
              ],
            },
          ],
        },
      }),
    });

    expect(observation).toMatchObject({
      status: "authenticated",
      evidence: { accountId: "sohu-42", displayName: "示例旅服搜狐号" },
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("/mpbp/bp/account/list");
  });

  it("rejects a Sohu identity list when every account is empty", async () => {
    const { observation } = await inspect({
      platform: "sohu",
      expectedAccountName: "重复昵称",
      fetchJson: () => ({
        code: 2_000_000,
        data: {
          data: [
            {
              accounts: [
                { id: "", nickName: "" },
                { id: null, nickName: "" },
              ],
            },
          ],
        },
      }),
    });

    expect(observation).toEqual({ status: "unavailable" });
  });
});
