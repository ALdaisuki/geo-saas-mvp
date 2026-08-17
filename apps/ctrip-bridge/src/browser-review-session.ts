import { mkdir } from "node:fs/promises";

import { idSchema } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import { z } from "zod";

import {
  ctripOperationalReadiness,
  reviewCtripAuthenticatedSurface,
  type CtripOperationalReadiness,
  type CtripSurfaceReviewEvidence,
} from "./authenticated-surface-review.js";
import {
  requireDockerDesktopCdpEndpoint,
  requireLinuxServiceCdpEndpoint,
  requireLocalCdpEndpoint,
  requireRuntimeTmpRoot,
  resolveDockerDesktopCdpWebSocketEndpoint,
  resolveLinuxServiceAccountCdpTarget,
  resolveLocalCdpWebSocketEndpoint,
  type CdpConnectionTarget,
  type CtripBrowserTransport,
} from "./config.js";
import type { CtripDraftWriter } from "./browser-draft-adapter.js";
import {
  createPlaywrightCtripDraftWriter,
  type PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import {
  createPlaywrightCtripSupervisedSubmitWriter,
  type CtripSupervisedSubmitWriter,
} from "./playwright-supervised-submit-writer.js";
import {
  createPlaywrightCtripPublicReadbackWriter,
  type CtripPublicReadbackWriter,
} from "./playwright-public-readback-writer.js";
import {
  createPlaywrightCtripAccountAnalyticsCollector,
  CTRIP_ANALYTICS_URL,
  type CtripAccountAnalyticsCollector,
  type PlaywrightCtripAccountPage,
} from "./playwright-account-analytics-collector.js";
import {
  getPlatformLoginDefinition,
  navigateToPlatformLogin,
  reviewPlatformLoginSession,
  type PlatformLoginId,
} from "./platform-login-definitions.js";
import { createPlaywrightPlatformSessionProbe } from "./playwright-platform-session-probe.js";
import {
  createPlaywrightPriorityPlatformMediaWriter,
  type PriorityPlatformMediaWriter,
} from "./playwright-priority-platform-media-writer.js";
import {
  BAIJIAHAO_ARTICLE_EDITOR_URL,
  createPlaywrightBaijiahaoPublicationAdapter,
} from "./playwright-baijiahao-publication.js";
import {
  createPlaywrightNeteasePublicationAdapter,
  NETEASE_ARTICLE_EDITOR_URL,
} from "./playwright-netease-publication.js";
import type {
  PlaywrightPlatformPublicationAdapter,
  PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";
import {
  createPlaywrightSohuPublicationAdapter,
  SOHU_ARTICLE_EDITOR_URL,
} from "./playwright-sohu-publication.js";
import {
  createPlaywrightZhihuPublicationAdapter,
  ZHIHU_ARTICLE_EDITOR_URL,
} from "./playwright-zhihu-publication.js";
import {
  createPlaywrightToutiaoPublicationAdapter,
  TOUTIAO_ARTICLE_EDITOR_URL,
} from "./playwright-toutiao-publication.js";
import {
  createPlaywrightToutiaoAccountAnalyticsCollector,
  type ToutiaoAccountAnalyticsCollector,
} from "./playwright-toutiao-account-analytics-collector.js";
import {
  createPlaywrightBaijiahaoAccountAnalyticsCollector,
  type BaijiahaoAccountAnalyticsCollector,
} from "./playwright-baijiahao-account-analytics-collector.js";
import {
  createPlaywrightNeteaseAccountAnalyticsCollector,
  type NeteaseAccountAnalyticsCollector,
} from "./playwright-netease-account-analytics-collector.js";
import {
  createPlaywrightSohuAccountAnalyticsCollector,
  type SohuAccountAnalyticsCollector,
} from "./playwright-sohu-account-analytics-collector.js";
import { createPlaywrightCtripSurfaceReviewPage } from "./playwright-surface-reader.js";

interface CtripBrowserReviewContext {
  pages(): readonly PlaywrightCtripAccountPage[];
  newPage?(): Promise<PlaywrightCtripAccountPage>;
  close?(): Promise<void>;
}

export interface CtripBrowserReviewConnection {
  contexts(): readonly CtripBrowserReviewContext[];
  newContext?(): Promise<CtripBrowserReviewContext>;
  close(): Promise<void>;
}

export interface CtripBrowserReviewSession {
  inspect(): Promise<CtripSurfaceReviewEvidence>;
  readiness(): Promise<CtripOperationalReadiness>;
  navigateToLogin(channelAccountId: string): Promise<CtripBrowserLoginNavigation>;
  readonly draftWriter: CtripDraftWriter;
  readonly supervisedSubmitWriter: CtripSupervisedSubmitWriter;
  readonly publicReadbackWriter: CtripPublicReadbackWriter;
  readonly analyticsCollector: CtripAccountAnalyticsCollector;
  readonly toutiaoAnalyticsCollector: ToutiaoAccountAnalyticsCollector | null;
  readonly baijiahaoAnalyticsCollector: BaijiahaoAccountAnalyticsCollector | null;
  readonly sohuAnalyticsCollector: SohuAccountAnalyticsCollector | null;
  readonly neteaseAnalyticsCollector: NeteaseAccountAnalyticsCollector | null;
  readonly platform: PlatformLoginId;
  readonly expectedAccountName: string;
  readonly platformPublicationAdapter: PlaywrightPlatformPublicationAdapter | null;
  readonly platformMediaWriter: PriorityPlatformMediaWriter | null;
  close(): Promise<void>;
}

type ConnectOverCdp = (
  endpoint: string,
  options: { readonly timeout: number; readonly headers?: Readonly<Record<string, string>> },
) => Promise<CtripBrowserReviewConnection>;

const CDP_CONNECT_TIMEOUT_MS = 30_000;
const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_ACCOUNT_PAGE_COUNT = 3;
export const CTRIP_BROWSER_LOGIN_URL = "https://we.ctrip.com/publish/contentManagement";

export interface CtripBrowserLoginNavigation {
  readonly channelAccountId: string;
  readonly targetUrl: string;
  readonly currentUrl: string;
}

async function defaultConnectOverCdp(
  endpoint: string,
  options: { readonly timeout: number; readonly headers?: Readonly<Record<string, string>> },
): Promise<CtripBrowserReviewConnection> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(endpoint, options);
}

export async function connectCtripBrowserReviewSession(options: {
  readonly httpEndpoint: string;
  readonly runtimeTmpRoot: string;
  readonly transport?: CtripBrowserTransport;
  readonly channelAccountId?: string;
  readonly profileKey?: string;
  readonly platform?: PlatformLoginId;
  readonly expectedAccountName?: string;
  readonly ensureDirectory?: (path: string) => Promise<unknown>;
  readonly resolveWebSocketEndpoint?: (httpEndpoint: string) => Promise<string>;
  readonly resolveDockerWebSocketEndpoint?: (httpEndpoint: string) => Promise<CdpConnectionTarget>;
  readonly resolveLinuxWebSocketEndpoint?: (
    httpEndpoint: string,
    channelAccountId: string,
    profileKey: string,
    startUrl?: string,
  ) => Promise<CdpConnectionTarget>;
  readonly connectOverCdp?: ConnectOverCdp;
}): Promise<CtripBrowserReviewSession> {
  const transport = options.transport ?? "local";
  const platform = options.platform ?? "ctrip_community";
  const expectedAccountName = options.expectedAccountName?.normalize("NFKC").trim() ?? "";
  const httpEndpoint =
    transport === "local"
      ? requireLocalCdpEndpoint(options.httpEndpoint)
      : transport === "docker_desktop"
        ? requireDockerDesktopCdpEndpoint(options.httpEndpoint)
        : requireLinuxServiceCdpEndpoint(options.httpEndpoint);
  const linuxAccount =
    transport === "linux_service"
      ? {
          channelAccountId: idSchema.parse(options.channelAccountId),
          profileKey: z
            .string()
            .regex(/^ctrip-account-[0-9a-f-]{36}$/u)
            .parse(options.profileKey),
        }
      : null;
  const platformPrimaryUrl =
    platform === "ctrip_community"
      ? undefined
      : platform === "baijiahao"
        ? BAIJIAHAO_ARTICLE_EDITOR_URL
        : getPlatformLoginDefinition(platform).loginUrl;
  const platformEditorUrl =
    platform === "toutiao"
      ? TOUTIAO_ARTICLE_EDITOR_URL
      : platform === "sohu"
        ? SOHU_ARTICLE_EDITOR_URL
        : platform === "netease"
          ? NETEASE_ARTICLE_EDITOR_URL
          : platform === "baijiahao"
            ? BAIJIAHAO_ARTICLE_EDITOR_URL
            : platform === "zhihu"
              ? ZHIHU_ARTICLE_EDITOR_URL
              : undefined;
  const platformStartUrl = transport === "linux_service" ? platformPrimaryUrl : undefined;
  if (
    linuxAccount !== null &&
    linuxAccount.profileKey !== `ctrip-account-${linuxAccount.channelAccountId}`
  ) {
    throw new TypeError("Ctrip browser profile key does not match the channel account");
  }
  const runtimeTmpRoot = requireRuntimeTmpRoot(options.runtimeTmpRoot);
  await (options.ensureDirectory ?? ((path) => mkdir(path, { recursive: true })))(runtimeTmpRoot);
  process.env.TMP = runtimeTmpRoot;
  process.env.TEMP = runtimeTmpRoot;
  process.env.TMPDIR = runtimeTmpRoot;

  const target =
    transport === "local"
      ? {
          webSocketEndpoint: await (
            options.resolveWebSocketEndpoint ?? resolveLocalCdpWebSocketEndpoint
          )(httpEndpoint),
        }
      : transport === "docker_desktop"
        ? await (
            options.resolveDockerWebSocketEndpoint ?? resolveDockerDesktopCdpWebSocketEndpoint
          )(httpEndpoint)
        : await (options.resolveLinuxWebSocketEndpoint ?? resolveLinuxServiceAccountCdpTarget)(
            httpEndpoint,
            linuxAccount?.channelAccountId ?? "",
            linuxAccount?.profileKey ?? "",
            platformStartUrl,
          );
  const connection = await (options.connectOverCdp ?? defaultConnectOverCdp)(
    target.webSocketEndpoint,
    "headers" in target
      ? { timeout: CDP_CONNECT_TIMEOUT_MS, headers: target.headers }
      : { timeout: CDP_CONNECT_TIMEOUT_MS },
  );
  let closed = false;
  const pages = () => connection.contexts().flatMap((context) => context.pages());
  const isAnalyticsPage = (page: PlaywrightCtripAccountPage): boolean => {
    try {
      const url = new URL(page.url());
      const analytics = new URL(CTRIP_ANALYTICS_URL);
      return url.origin === analytics.origin && url.pathname === analytics.pathname;
    } catch {
      return false;
    }
  };
  const isPrimaryPlatformPage = (page: PlaywrightCtripAccountPage): boolean => {
    if (platformPrimaryUrl === undefined) return false;
    try {
      const current = new URL(page.url());
      const primary = new URL(platformPrimaryUrl);
      if (current.origin !== primary.origin || current.pathname !== primary.pathname) return false;
      if (platform !== "netease") return true;
      // NetEase uses the same origin/path for every SPA screen. Keep only the
      // landing routes here; editor and content-management hashes are handled
      // separately and must never be treated as the primary page.
      const route = current.hash.split("?", 1)[0] ?? current.hash;
      return route === "" || route === "#/" || route === "#/index" || route === "#/home";
    } catch {
      return false;
    }
  };
  const isPlatformEditorPage = (page: PlaywrightCtripAccountPage): boolean => {
    if (platformEditorUrl === undefined) return false;
    try {
      const current = new URL(page.url());
      const editor = new URL(platformEditorUrl);
      if (current.origin !== editor.origin || current.pathname !== editor.pathname) return false;
      if (platform !== "netease") return true;
      // NetEase keeps the SPA route in the hash. Matching only origin/path
      // would classify #/content-manage as an editor and could close the real
      // article editor while trimming duplicate tabs.
      return current.hash === editor.hash;
    } catch {
      return false;
    }
  };
  const closeOldestPagesUntil = async (maximum: number): Promise<void> => {
    const currentPages = pages();
    const indexed = currentPages.map((page, index) => ({ page, index }));
    const newest = (
      predicate: (page: PlaywrightCtripAccountPage) => boolean,
    ): PlaywrightCtripAccountPage | null =>
      [...indexed].reverse().find(({ page }) => predicate(page))?.page ?? null;
    const rolePages = new Set(
      currentPages.filter(
        (page) =>
          isPlatformEditorPage(page) || isPrimaryPlatformPage(page) || isAnalyticsPage(page),
      ),
    );
    const preferred = [
      newest(isPlatformEditorPage),
      newest(isPrimaryPlatformPage),
      newest(isAnalyticsPage),
    ].filter((page): page is PlaywrightCtripAccountPage => page !== null);
    const unrelatedNewest = [...indexed]
      .filter(({ page }) => !rolePages.has(page))
      .sort((left, right) => right.index - left.index)
      .map(({ page }) => page);
    // Keep at most one page per operational role. Duplicate editor, primary,
    // and analytics tabs are closed even when the raw count is below the cap,
    // because publication adapters require a unique editor surface.
    const keep = new Set(
      [...new Set([...preferred, ...unrelatedNewest])].slice(0, Math.max(0, maximum)),
    );
    const excess = [...indexed]
      .filter(({ page }) => !keep.has(page))
      .sort((left, right) => left.index - right.index)
      .map(({ page }) => page);
    if (excess.some((page) => page.close === undefined)) {
      throw new Error("Ctrip browser cannot enforce the account tab limit");
    }
    await Promise.all(excess.map((page) => page.close?.()));
  };
  await closeOldestPagesUntil(MAX_ACCOUNT_PAGE_COUNT);
  const resolvePlatformAccountName = async (): Promise<string> => {
    if (platform !== "netease") return expectedAccountName;
    const definition = getPlatformLoginDefinition(platform);
    const page = [...pages()].reverse().find((candidate) => {
      try {
        return definition.expectedAuthenticatedHosts.includes(new URL(candidate.url()).hostname);
      } catch {
        return false;
      }
    });
    if (page === undefined) return expectedAccountName;
    const review = await reviewPlatformLoginSession(
      platform,
      page,
      createPlaywrightPlatformSessionProbe(page, expectedAccountName),
    ).catch(() => null);
    return review?.status === "authenticated" && review.evidence.displayName !== undefined
      ? review.evidence.displayName
      : expectedAccountName;
  };
  const platformAccountName = await resolvePlatformAccountName();
  const navigateToLogin = async (
    channelAccountId: string,
  ): Promise<CtripBrowserLoginNavigation> => {
    const parsedChannelAccountId = idSchema.parse(channelAccountId);
    const currentPages = pages();
    const page =
      currentPages.find((candidate) => !isAnalyticsPage(candidate)) ??
      (await connection.contexts()[0]?.newPage?.()) ??
      null;
    if (page === null) throw new Error("Ctrip browser has no controllable page");
    const goto = page.goto;
    if (goto === undefined) throw new Error("Ctrip browser navigation is unavailable");
    await page.bringToFront();
    const targetUrl =
      platform === "ctrip_community"
        ? CTRIP_BROWSER_LOGIN_URL
        : (
            await navigateToPlatformLogin(platform, {
              goto: (url, navigationOptions) => goto.call(page, url, navigationOptions),
              url: () => page.url(),
            })
          ).targetUrl;
    if (platform === "ctrip_community") {
      await goto.call(page, targetUrl, {
        timeout: LOGIN_NAVIGATION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
    }
    return {
      channelAccountId: parsedChannelAccountId,
      targetUrl,
      currentUrl: page.url(),
    };
  };
  const openPage = async (url: string): Promise<PlaywrightCtripDraftPage> => {
    await closeOldestPagesUntil(MAX_ACCOUNT_PAGE_COUNT - 1);
    const contexts = connection.contexts();
    if (contexts.length !== 1 || contexts[0]?.newPage === undefined) {
      throw new Error("Ctrip browser context is not unique or cannot open a recovery page");
    }
    const page = await contexts[0].newPage();
    if (page.goto === undefined) throw new Error("Ctrip recovery page cannot navigate");
    await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
    return page;
  };
  const openAnalyticsPage = async (url: string): Promise<PlaywrightCtripAccountPage> => {
    const contexts = connection.contexts();
    if (contexts.length !== 1 || contexts[0]?.newPage === undefined) {
      throw new Error("Ctrip browser context is not unique or cannot open an analytics page");
    }
    await closeOldestPagesUntil(MAX_ACCOUNT_PAGE_COUNT - 1);
    const page = await contexts[0].newPage();
    if (page.goto === undefined) throw new Error("Ctrip analytics page cannot navigate");
    await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
    return page;
  };
  const openIndependentPublicPage = async (
    canonicalPublicUrl: string,
  ): Promise<PlaywrightPublicationPage> => {
    if (connection.newContext === undefined) {
      throw new Error("Browser connection cannot create an independent public context");
    }
    const independentContext = await connection.newContext();
    const page = await independentContext.newPage?.();
    if (page === undefined || page.goto === undefined) {
      await independentContext.close?.().catch(() => undefined);
      throw new Error("Independent public context cannot open a page");
    }
    try {
      await page.goto(canonicalPublicUrl, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
    } catch (error) {
      await Promise.allSettled([page.close?.(), independentContext.close?.()]);
      throw error;
    }
    let publicPageClosed = false;
    return {
      url: () => page.url(),
      locator: (selector) => page.locator(selector),
      bringToFront: () => page.bringToFront(),
      goto: async (url, navigationOptions) => {
        const navigate = page.goto;
        if (navigate === undefined) throw new Error("Independent public page cannot navigate");
        return navigate.call(page, url, navigationOptions);
      },
      waitForLoadState: async (state, waitOptions) => {
        await page.waitForLoadState?.(state, waitOptions);
      },
      close: async () => {
        if (publicPageClosed) return;
        publicPageClosed = true;
        await Promise.allSettled([page.close?.(), independentContext.close?.()]);
      },
    };
  };
  const openToutiaoPublicPage = async (
    canonicalPublicUrl: string,
  ): Promise<PlaywrightPublicationPage> => {
    const independentPage = await openIndependentPublicPage(canonicalPublicUrl);
    // Public readback must stay in the anonymous context. Falling back to the
    // authenticated creator session turns a public 404 into a false positive
    // whenever the creator session can render the same URL or retain old DOM.
    return independentPage;
  };
  const platformPublicationAdapter =
    platform === "toutiao"
      ? createPlaywrightToutiaoPublicationAdapter({
          pages,
          openCreatorPage: openPage,
          openIndependentPublicPage: openToutiaoPublicPage,
          confirmationMode: "publisher_status",
        })
      : platform === "baijiahao"
        ? createPlaywrightBaijiahaoPublicationAdapter({
            pages,
            openCreatorPage: openPage,
            openIndependentPublicPage,
            // The management surface discovers the canonical URL, but Baijiahao
            // moderation can delay anonymous availability. Keep the handoff in
            // asynchronous readback until the public payload is independently
            // visible; the database schedules retries every thirty minutes
            // after the initial high-frequency window.
            confirmationMode: "public_readback",
          })
        : platform === "sohu"
          ? createPlaywrightSohuPublicationAdapter({
              pages,
              openCreatorPage: openPage,
              openIndependentPublicPage,
              confirmationMode: "public_readback",
            })
          : platform === "netease"
            ? createPlaywrightNeteasePublicationAdapter({
                pages,
                openCreatorPage: openPage,
                openIndependentPublicPage,
                confirmationMode: "public_readback",
              })
            : platform === "zhihu"
              ? createPlaywrightZhihuPublicationAdapter({
                  pages,
                  openCreatorPage: openPage,
                  openIndependentPublicPage,
                  confirmationMode: "public_readback",
                })
              : null;
  const platformMediaWriter =
    platform === "ctrip_community"
      ? null
      : createPlaywrightPriorityPlatformMediaWriter({ platform, pages });
  const inspect = () =>
    reviewCtripAuthenticatedSurface(pages().map(createPlaywrightCtripSurfaceReviewPage));
  const readiness = async (): Promise<CtripOperationalReadiness> => {
    if (platform === "ctrip_community") return ctripOperationalReadiness(await inspect());
    const definition = getPlatformLoginDefinition(platform);
    const loginOrigin = new URL(definition.loginUrl).origin;
    const authenticatedPages = [...pages()].reverse().filter((candidate) => {
      try {
        return definition.expectedAuthenticatedHosts.includes(new URL(candidate.url()).hostname);
      } catch {
        return false;
      }
    });
    const page =
      authenticatedPages.find((candidate) => {
        try {
          return new URL(candidate.url()).origin === loginOrigin;
        } catch {
          return false;
        }
      }) ?? authenticatedPages[0];
    const observedAt = new Date().toISOString();
    if (page === undefined) {
      const evidenceHash = sha256Canonical({ platform, observedAt, status: "session_required" });
      return {
        schemaVersion: "geo.ctrip-operational-readiness.v1",
        status: "session_required",
        observedAt,
        manifestVersion: definition.schemaVersion,
        sessionEvidenceHash: evidenceHash,
        evidenceHash,
        authenticated: false,
      };
    }
    const review = await reviewPlatformLoginSession(
      platform,
      page,
      createPlaywrightPlatformSessionProbe(page, expectedAccountName),
    );
    const evidenceHash = sha256Canonical({ platform, observedAt, review });
    return {
      schemaVersion: "geo.ctrip-operational-readiness.v1",
      status:
        review.status === "authenticated"
          ? "unavailable"
          : review.status === "unauthenticated"
            ? "session_required"
            : review.status,
      observedAt,
      manifestVersion: definition.schemaVersion,
      sessionEvidenceHash: evidenceHash,
      evidenceHash,
      authenticated: review.status === "authenticated",
    };
  };
  return Object.freeze({
    inspect,
    readiness,
    navigateToLogin,
    draftWriter: createPlaywrightCtripDraftWriter({ pages, openPage }),
    supervisedSubmitWriter: createPlaywrightCtripSupervisedSubmitWriter({ pages }),
    publicReadbackWriter: createPlaywrightCtripPublicReadbackWriter({ pages, openPage }),
    analyticsCollector: createPlaywrightCtripAccountAnalyticsCollector({
      pages,
      openPage: openAnalyticsPage,
    }),
    toutiaoAnalyticsCollector:
      platform === "toutiao"
        ? createPlaywrightToutiaoAccountAnalyticsCollector({
            pages,
            openPage: openAnalyticsPage,
          })
        : null,
    baijiahaoAnalyticsCollector:
      platform === "baijiahao"
        ? createPlaywrightBaijiahaoAccountAnalyticsCollector({
            pages,
            openPage: openAnalyticsPage,
          })
        : null,
    sohuAnalyticsCollector:
      platform === "sohu"
        ? createPlaywrightSohuAccountAnalyticsCollector({
            pages,
            openPage: openAnalyticsPage,
          })
        : null,
    neteaseAnalyticsCollector:
      platform === "netease"
        ? createPlaywrightNeteaseAccountAnalyticsCollector({
            pages,
            openPage: openAnalyticsPage,
          })
        : null,
    platform,
    expectedAccountName: platformAccountName,
    platformPublicationAdapter,
    platformMediaWriter,
    close: async () => {
      if (closed) return;
      closed = true;
      await connection.close();
    },
  });
}
