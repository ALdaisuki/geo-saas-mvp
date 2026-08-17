import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectCtripBrowserReviewSession,
  CTRIP_BROWSER_LOGIN_URL,
  type CtripBrowserReviewConnection,
} from "./browser-review-session.js";
import { SOHU_ARTICLE_EDITOR_URL } from "./playwright-sohu-publication.js";
import { NETEASE_ARTICLE_EDITOR_URL } from "./playwright-netease-publication.js";
import { ZHIHU_ARTICLE_EDITOR_URL } from "./playwright-zhihu-publication.js";
import type { PlaywrightCtripReadPage } from "./playwright-surface-reader.js";
import type { PlaywrightCtripDraftPage } from "./playwright-draft-writer.js";
import { CTRIP_ANALYTICS_URL } from "./playwright-account-analytics-collector.js";
import type {
  PlaywrightCtripAccountLocator,
  PlaywrightCtripAccountPage,
} from "./playwright-account-analytics-collector.js";

const previousTemp = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
};

afterEach(() => {
  for (const [name, value] of Object.entries(previousTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function emptyLocator(): PlaywrightCtripAccountLocator {
  const locator: PlaywrightCtripAccountLocator = {
    count: async () => 0,
    nth: () => locator,
    first: () => locator,
    isVisible: async () => false,
    hover: async () => undefined,
    getAttribute: async () => null,
    textContent: async () => null,
    fill: async () => undefined,
    click: async () => undefined,
    setInputFiles: async () => undefined,
  };
  return locator;
}

function textLocator(text: string, visible = true): PlaywrightCtripAccountLocator {
  const locator: PlaywrightCtripAccountLocator = {
    count: async () => (visible ? 1 : 0),
    nth: () => locator,
    first: () => locator,
    isVisible: async () => visible,
    hover: async () => undefined,
    getAttribute: async () => null,
    innerText: async () => text,
    textContent: async () => text,
    fill: async () => undefined,
    click: async () => undefined,
    setInputFiles: async () => undefined,
  };
  return locator;
}

describe("Ctrip browser review session", () => {
  it("uses the authenticated NetEase public name instead of the local account label", async () => {
    const editorPage = {
      url: () => NETEASE_ARTICLE_EDITOR_URL,
      locator: emptyLocator,
      evaluate: async <Result, Argument>(
        pageFunction: (argument: Argument) => Result,
        argument: Argument,
      ) => {
        void pageFunction;
        void argument;
        return {
          status: "authenticated",
          evidence: {
            kind: "account_identity",
            accountId: "T1782125192020",
            displayName: "人间饭香",
            evidenceRef: "netease-navinfo",
          },
        } as Result;
      },
      bringToFront: async () => undefined,
    } satisfies PlaywrightCtripAccountPage;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [editorPage] }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "netease",
      expectedAccountName: "test2",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/netease",
      connectOverCdp: async () => connection,
    });

    expect(session.expectedAccountName).toBe("人间饭香");
    await session.close();
  });

  it("closes the oldest excess pages before exposing an account session", async () => {
    const close = Array.from({ length: 5 }, () => vi.fn(async () => undefined));
    const pages = close.map((closePage, index) => ({
      url: () => `https://www.ctrip.com/page-${String(index)}`,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close: closePage,
    })) satisfies Array<PlaywrightCtripReadPage & PlaywrightCtripDraftPage>;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => pages }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    expect(close[0]).toHaveBeenCalledOnce();
    expect(close[1]).toHaveBeenCalledOnce();
    expect(close[2]).not.toHaveBeenCalled();
    expect(close[3]).not.toHaveBeenCalled();
    expect(close[4]).not.toHaveBeenCalled();
    await session.close();
  });

  it("retains the Baijiahao editor while trimming unrelated account tabs", async () => {
    const editorClose = vi.fn(async () => undefined);
    const unrelatedCloses = Array.from({ length: 3 }, () => vi.fn(async () => undefined));
    const editor = {
      url: () => "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1",
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close: editorClose,
    } satisfies PlaywrightCtripReadPage & PlaywrightCtripDraftPage;
    const unrelated = unrelatedCloses.map((close, index) => ({
      url: () => `https://example.test/unrelated-${String(index)}`,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close,
    })) satisfies Array<PlaywrightCtripReadPage & PlaywrightCtripDraftPage>;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [editor, ...unrelated] }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "baijiahao",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    expect(editorClose).not.toHaveBeenCalled();
    expect(unrelatedCloses[0]).toHaveBeenCalledOnce();
    expect(unrelatedCloses[1]).not.toHaveBeenCalled();
    expect(unrelatedCloses[2]).not.toHaveBeenCalled();
    await session.close();
  });

  it("retains the Sohu editor while trimming unrelated account tabs", async () => {
    const editorClose = vi.fn(async () => undefined);
    const unrelatedCloses = Array.from({ length: 3 }, () => vi.fn(async () => undefined));
    const editor = {
      url: () => `${SOHU_ARTICLE_EDITOR_URL}&id=1061629527`,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close: editorClose,
    } satisfies PlaywrightCtripReadPage & PlaywrightCtripDraftPage;
    const unrelated = unrelatedCloses.map((close, index) => ({
      url: () => `https://example.test/unrelated-${String(index)}`,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close,
    })) satisfies Array<PlaywrightCtripReadPage & PlaywrightCtripDraftPage>;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [editor, ...unrelated] }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "sohu",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    expect(editorClose).not.toHaveBeenCalled();
    expect(unrelatedCloses[0]).toHaveBeenCalledOnce();
    expect(unrelatedCloses[1]).not.toHaveBeenCalled();
    expect(unrelatedCloses[2]).not.toHaveBeenCalled();
    await session.close();
  });

  it("closes duplicate Sohu editors even when the account is below the raw tab cap", async () => {
    const oldEditorClose = vi.fn(async () => undefined);
    const newestEditorClose = vi.fn(async () => undefined);
    const unrelatedClose = vi.fn(async () => undefined);
    const page = (url: string, close: () => Promise<void>): PlaywrightCtripAccountPage => ({
      url: () => url,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close,
    });
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [
        {
          pages: () => [
            page(`${SOHU_ARTICLE_EDITOR_URL}&id=old`, oldEditorClose),
            page(`${SOHU_ARTICLE_EDITOR_URL}&id=new`, newestEditorClose),
            page("https://example.test/unrelated", unrelatedClose),
          ],
        },
      ],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "sohu",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    expect(oldEditorClose).toHaveBeenCalledOnce();
    expect(newestEditorClose).not.toHaveBeenCalled();
    expect(unrelatedClose).not.toHaveBeenCalled();
    await session.close();
  });

  it("keeps NetEase article-publish hash tabs and closes content-manage duplicates", async () => {
    const editorClose = vi.fn(async () => undefined);
    const driftedEditorClose = vi.fn(async () => undefined);
    const managerClose = vi.fn(async () => undefined);
    const analyticsClose = vi.fn(async () => undefined);
    const unrelatedClose = vi.fn(async () => undefined);
    const page = (url: string, close: () => Promise<void>): PlaywrightCtripAccountPage => ({
      url: () => url,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      close,
    });
    const editor = page(NETEASE_ARTICLE_EDITOR_URL, editorClose);
    const manager = page("https://mp.163.com/#/content-manage", managerClose);
    const driftedEditor = page(`${NETEASE_ARTICLE_EDITOR_URL}?draft=1`, driftedEditorClose);
    const analytics = page(CTRIP_ANALYTICS_URL, analyticsClose);
    const unrelated = page("https://example.test/unrelated", unrelatedClose);
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [editor, manager, driftedEditor, analytics, unrelated] }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "netease",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    expect(editorClose).not.toHaveBeenCalled();
    expect(managerClose).toHaveBeenCalledOnce();
    expect(driftedEditorClose).toHaveBeenCalledOnce();
    expect(analyticsClose).not.toHaveBeenCalled();
    expect(unrelatedClose).not.toHaveBeenCalled();
    await session.close();
  });

  it("navigates the persisted browser page to Ctrip creator content management", async () => {
    const goto = vi.fn(async () => undefined);
    const page = {
      url: () => CTRIP_BROWSER_LOGIN_URL,
      locator: emptyLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: vi.fn(async () => undefined),
      goto,
    } satisfies PlaywrightCtripReadPage & PlaywrightCtripDraftPage;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [page] }],
      close: async () => undefined,
    };
    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
      connectOverCdp: async () => connection,
    });

    await expect(session.navigateToLogin("10000000-0000-4000-8000-000000000004")).resolves.toEqual({
      channelAccountId: "10000000-0000-4000-8000-000000000004",
      targetUrl: CTRIP_BROWSER_LOGIN_URL,
      currentUrl: CTRIP_BROWSER_LOGIN_URL,
    });
    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledWith(CTRIP_BROWSER_LOGIN_URL, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    expect(CTRIP_BROWSER_LOGIN_URL).toBe("https://we.ctrip.com/publish/contentManagement");
    await session.close();
  });

  it("sets the reviewed temp root before connecting and re-reads current pages", async () => {
    const pages: PlaywrightCtripAccountPage[] = [
      {
        url: () => "https://you.ctrip.com/community/write",
        locator: emptyLocator,
        evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
        bringToFront: async () => undefined,
      },
    ];
    const close = vi.fn(async () => undefined);
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => pages }],
      close,
    };
    const ensureDirectory = vi.fn(async () => undefined);
    const resolveWebSocketEndpoint = vi.fn(
      async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
    );
    const connectOverCdp = vi.fn(async () => {
      expect(process.env.TEMP).toBe("D:\\GEO\\.runtime\\tmp");
      return connection;
    });

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      ensureDirectory,
      resolveWebSocketEndpoint,
      connectOverCdp,
    });
    await expect(session.inspect()).resolves.toMatchObject({ outcome: "adapter_drift" });
    pages.splice(0, 1);
    await expect(session.inspect()).resolves.toMatchObject({ outcome: "session_required" });
    await session.close();

    expect(ensureDirectory).toHaveBeenCalledWith("D:\\GEO\\.runtime\\tmp");
    expect(resolveWebSocketEndpoint).toHaveBeenCalledWith("http://127.0.0.1:9222/");
    expect(connectOverCdp).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222/devtools/browser/review-session",
      { timeout: 30_000 },
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("connects through the fixed Docker Desktop target and preserves its Host header", async () => {
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveDockerWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: "ws://host.docker.internal:9333/devtools/browser/draft-session",
      headers: { Host: "127.0.0.1:9333" as const },
    }));
    const connectOverCdp = vi.fn(async () => connection);

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://host.docker.internal:9333/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      transport: "docker_desktop",
      ensureDirectory: async () => undefined,
      resolveDockerWebSocketEndpoint,
      connectOverCdp,
    });

    expect(resolveDockerWebSocketEndpoint).toHaveBeenCalledWith(
      "http://host.docker.internal:9333/",
    );
    expect(connectOverCdp).toHaveBeenCalledWith(
      "ws://host.docker.internal:9333/devtools/browser/draft-session",
      { timeout: 30_000, headers: { Host: "127.0.0.1:9333" } },
    );
    await expect(session.draftWriter.inspect()).resolves.toMatchObject({
      status: "session_required",
    });
    await session.close();
  });

  it("connects through the private Linux browser service and preserves its Host header", async () => {
    const channelAccountId = "10000000-0000-4000-8000-000000000004";
    const profileKey = `ctrip-account-${channelAccountId}`;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveLinuxWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-session`,
      headers: { Host: "127.0.0.1:10005" as const },
    }));
    const connectOverCdp = vi.fn(async () => connection);

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      channelAccountId,
      profileKey,
      ensureDirectory: async () => undefined,
      resolveLinuxWebSocketEndpoint,
      connectOverCdp,
    });

    expect(resolveLinuxWebSocketEndpoint).toHaveBeenCalledWith(
      "http://browser-host:10005/",
      channelAccountId,
      profileKey,
      undefined,
    );
    expect(connectOverCdp).toHaveBeenCalledWith(
      `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-session`,
      { timeout: 30_000, headers: { Host: "127.0.0.1:10005" } },
    );
    await session.close();
  });

  it("starts non-Ctrip Linux sessions on the platform login page", async () => {
    const channelAccountId = "10000000-0000-4000-8000-000000000004";
    const profileKey = `ctrip-account-${channelAccountId}`;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveLinuxWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-session`,
      headers: { Host: "127.0.0.1:10005" as const },
    }));
    const connectOverCdp = vi.fn(async () => connection);

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      channelAccountId,
      profileKey,
      platform: "toutiao",
      ensureDirectory: async () => undefined,
      resolveLinuxWebSocketEndpoint,
      connectOverCdp,
    });

    expect(resolveLinuxWebSocketEndpoint).toHaveBeenCalledWith(
      "http://browser-host:10005/",
      channelAccountId,
      profileKey,
      "https://mp.toutiao.com/profile_v4/index",
    );
    await session.close();
  });

  it("starts Baijiahao Linux sessions directly on the official article editor", async () => {
    const channelAccountId = "10000000-0000-4000-8000-000000000004";
    const profileKey = `ctrip-account-${channelAccountId}`;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveLinuxWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-session`,
      headers: { Host: "127.0.0.1:10005" as const },
    }));

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      channelAccountId,
      profileKey,
      platform: "baijiahao",
      ensureDirectory: async () => undefined,
      resolveLinuxWebSocketEndpoint,
      connectOverCdp: async () => connection,
    });

    expect(resolveLinuxWebSocketEndpoint).toHaveBeenCalledWith(
      "http://browser-host:10005/",
      channelAccountId,
      profileKey,
      "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1",
    );
    await session.close();
  });

  it("activates Zhihu accounts at sign-in and exposes the publication adapter", async () => {
    const channelAccountId = "10000000-0000-4000-8000-000000000004";
    const profileKey = `ctrip-account-${channelAccountId}`;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveLinuxWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: `ws://browser-host:10005/accounts/${channelAccountId}/devtools/browser/linux-session`,
      headers: { Host: "127.0.0.1:10005" as const },
    }));

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://browser-host:10005",
      runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
      transport: "linux_service",
      channelAccountId,
      profileKey,
      platform: "zhihu",
      expectedAccountName: "test",
      ensureDirectory: async () => undefined,
      resolveLinuxWebSocketEndpoint,
      connectOverCdp: async () => connection,
    });

    expect(resolveLinuxWebSocketEndpoint).toHaveBeenCalledWith(
      "http://browser-host:10005/",
      channelAccountId,
      profileKey,
      "https://www.zhihu.com/signin",
    );
    expect(session.platformPublicationAdapter).not.toBeNull();
    await session.close();
  });

  it("prefers the Zhihu login origin for identity readiness when the editor is also open", async () => {
    const loginPageEvaluate = vi.fn();
    const editorPageEvaluate = vi.fn();
    const loginPage = {
      url: () => "https://www.zhihu.com/signin",
      locator: emptyLocator,
      evaluate: async <Result, Argument>(
        pageFunction: (argument: Argument) => Result,
        argument: Argument,
      ) => {
        void pageFunction;
        void argument;
        loginPageEvaluate();
        return {
          status: "authenticated",
          evidence: {
            kind: "account_identity",
            accountId: "zhihu-test",
            displayName: "test",
            evidenceRef: "zhihu-me",
          },
        } as Result;
      },
      bringToFront: async () => undefined,
    } satisfies PlaywrightCtripAccountPage;
    const editorPage = {
      url: () => ZHIHU_ARTICLE_EDITOR_URL,
      locator: emptyLocator,
      evaluate: async <Result, Argument>(
        pageFunction: (argument: Argument) => Result,
        argument: Argument,
      ) => {
        void pageFunction;
        void argument;
        editorPageEvaluate();
        return { status: "unauthenticated" } as Result;
      },
      bringToFront: async () => undefined,
    } satisfies PlaywrightCtripAccountPage;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [loginPage, editorPage] }],
      close: async () => undefined,
    };

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "zhihu",
      expectedAccountName: "test",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/zhihu",
      connectOverCdp: async () => connection,
    });

    await expect(session.readiness()).resolves.toMatchObject({
      status: "unavailable",
      authenticated: true,
    });
    expect(loginPageEvaluate).toHaveBeenCalledOnce();
    expect(editorPageEvaluate).not.toHaveBeenCalled();
    await session.close();
  });

  it("uses an anonymous context to confirm a Baijiahao public URL", async () => {
    const publicUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const pageClose = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const goto = vi.fn(async () => undefined);
    const publicPage = {
      url: () => publicUrl,
      locator: (selector: string) => {
        if (selector === "body") return textLocator("云南旅行怎么选 先核对行程，再选择服务。");
        if (selector === ".author-name") return textLocator("云南旅行运营号");
        if (selector === "h1.article-title") return textLocator("云南旅行怎么选");
        if (selector === "#article-content") return textLocator("先核对行程，再选择服务。");
        return emptyLocator();
      },
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      goto,
      waitForLoadState: vi.fn(async () => undefined),
      close: pageClose,
    } satisfies PlaywrightCtripAccountPage;
    const newContext = vi.fn(async () => ({
      pages: () => [],
      newPage: async () => publicPage,
      close: contextClose,
    }));
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [] }],
      newContext,
      close: async () => undefined,
    };
    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "baijiahao",
      expectedAccountName: "云南旅行运营号",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/baijiahao",
      connectOverCdp: async () => connection,
    });

    await expect(
      session.platformPublicationAdapter?.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: publicUrl,
        expectedAccountName: "云南旅行运营号",
        expectedTitle: "云南旅行怎么选",
        expectedBody: "先核对行程，再选择服务。",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: publicUrl,
      signal: "independent-public-payload-matched",
    });
    expect(newContext).toHaveBeenCalledOnce();
    expect(goto).toHaveBeenCalledWith(publicUrl, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
    expect(pageClose).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    await session.close();
  });

  it("does not open an anonymous context without a creator-management publication match", async () => {
    const publicUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const pageClose = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    const publicPage = {
      url: () => publicUrl,
      locator: (selector: string) => {
        if (selector === ".article-meta .name") return textLocator("云南旅行运营号");
        if (selector === "h1.article-content-title") return textLocator("云南旅行怎么选");
        if (selector === ".syl-page-article") return textLocator("先核对行程，再选择服务。");
        return emptyLocator();
      },
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
      bringToFront: async () => undefined,
      goto: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      close: pageClose,
    } satisfies PlaywrightCtripAccountPage;
    const newContext = vi.fn(async () => ({
      pages: () => [publicPage],
      newPage: async () => publicPage,
      close: contextClose,
    }));
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [] }],
      newContext,
      close: async () => undefined,
    };
    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "toutiao",
      expectedAccountName: "云南旅行运营号",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/toutiao",
      connectOverCdp: async () => connection,
    });

    await expect(
      session.platformPublicationAdapter?.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: publicUrl,
        expectedAccountName: "云南旅行运营号",
        expectedTitle: "云南旅行怎么选",
        expectedBody: "先核对行程，再选择服务。",
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "creator-management-published-not-found",
    });
    expect(newContext).not.toHaveBeenCalled();
    expect(pageClose).not.toHaveBeenCalled();
    expect(contextClose).not.toHaveBeenCalled();
    await session.close();
  });

  it("does not open an anonymous context when publisher-status confirmation has no management match", async () => {
    const publicUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const anonymousPageClose = vi.fn(async () => undefined);
    const anonymousContextClose = vi.fn(async () => undefined);
    const anonymousPage = {
      url: () => `${publicUrl}?wid=123`,
      locator: emptyLocator,
      evaluate: async <Result>() => undefined as Result,
      bringToFront: async () => undefined,
      goto: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      close: anonymousPageClose,
    } satisfies PlaywrightCtripAccountPage;
    const authenticatedPage = {
      url: () => publicUrl,
      locator: (selector: string) => {
        if (selector === ".article-meta .name") return textLocator("云南旅行运营号");
        if (selector === '[data-testid="article-title"]') return textLocator("云南旅行怎么选");
        if (selector === ".syl-page-article") return textLocator("先核对行程，再选择服务。");
        return emptyLocator();
      },
      evaluate: async <Result>() => undefined as Result,
      bringToFront: async () => undefined,
      goto: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies PlaywrightCtripAccountPage;
    let authenticatedOpened = false;
    const creatorContext = {
      pages: () => (authenticatedOpened ? [authenticatedPage] : []),
      newPage: async () => {
        authenticatedOpened = true;
        return authenticatedPage;
      },
    };
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [creatorContext],
      newContext: async () => ({
        pages: () => [anonymousPage],
        newPage: async () => anonymousPage,
        close: anonymousContextClose,
      }),
      close: async () => undefined,
    };
    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "toutiao",
      expectedAccountName: "云南旅行运营号",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/toutiao",
      connectOverCdp: async () => connection,
    });

    await expect(
      session.platformPublicationAdapter?.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: publicUrl,
        expectedAccountName: "云南旅行运营号",
        expectedTitle: "云南旅行怎么选",
        expectedBody: "先核对行程，再选择服务。",
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "creator-management-published-not-found",
    });
    expect(anonymousPageClose).not.toHaveBeenCalled();
    expect(anonymousContextClose).not.toHaveBeenCalled();
    expect(authenticatedPage.goto).not.toHaveBeenCalled();
    await session.close();
  });

  it("exposes a priority-platform media writer bound to the connected editor pages", async () => {
    const editorPage = {
      url: () => "https://mp.toutiao.com/profile_v4/graphic/publish",
      locator: emptyLocator,
      evaluate: async <Result>() => true as Result,
      bringToFront: async () => undefined,
    } satisfies PlaywrightCtripAccountPage;
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => [editorPage] }],
      close: async () => undefined,
    };
    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      platform: "toutiao",
      expectedAccountName: "云南旅行运营号",
      ensureDirectory: async () => undefined,
      resolveWebSocketEndpoint: async () => "ws://127.0.0.1:9222/devtools/browser/toutiao-media",
      connectOverCdp: async () => connection,
    });

    expect(session.platformMediaWriter).toMatchObject({ platform: "toutiao" });
    await expect(session.platformMediaWriter?.inspect([])).resolves.toMatchObject({
      status: "ready",
      platform: "toutiao",
      coverImageCount: 0,
      inlineImageCount: 0,
    });
    await session.close();
  });

  it("rejects an invalid Linux endpoint before touching the runtime directory", async () => {
    const ensureDirectory = vi.fn(async () => undefined);
    const resolveLinuxWebSocketEndpoint = vi.fn();
    await expect(
      connectCtripBrowserReviewSession({
        httpEndpoint: "http://127.0.0.1:10005",
        runtimeTmpRoot: "/var/lib/geo/runtime/tmp",
        transport: "linux_service",
        channelAccountId: "10000000-0000-4000-8000-000000000004",
        profileKey: "ctrip-account-10000000-0000-4000-8000-000000000004",
        ensureDirectory,
        resolveLinuxWebSocketEndpoint,
      }),
    ).rejects.toThrow(/Linux service/iu);
    expect(ensureDirectory).not.toHaveBeenCalled();
    expect(resolveLinuxWebSocketEndpoint).not.toHaveBeenCalled();
  });
});
