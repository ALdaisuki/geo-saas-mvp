import { z } from "zod";

import type {
  PlatformIdentityEvidence,
  PlatformLoginId,
  PlatformSessionProbe,
  PlatformSessionProbeObservation,
} from "./platform-login-definitions.js";

export interface PlaywrightPlatformSessionPage {
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result | Promise<Result>>;
}

const observationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("authenticated"),
    evidence: z.union([
      z.strictObject({
        kind: z.literal("account_identity"),
        accountId: z.string().trim().min(1).max(256),
        evidenceRef: z.string().trim().min(1).max(1_000),
      }),
      z.strictObject({
        kind: z.literal("account_identity"),
        accountId: z.string().trim().min(1).max(256),
        displayName: z.string().trim().min(1).max(256),
        evidenceRef: z.string().trim().min(1).max(1_000),
      }),
    ]),
  }),
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({ status: z.literal("challenge_required") }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

interface BrowserProbeElement {
  readonly textContent: string | null;
  readonly parentElement?: BrowserProbeElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    readonly width: number;
    readonly height: number;
    readonly top?: number;
    readonly right?: number;
    readonly bottom?: number;
    readonly left?: number;
  };
}

interface BrowserProbeDocument {
  readonly defaultView: {
    readonly innerHeight?: number;
    readonly innerWidth?: number;
    getComputedStyle(element: BrowserProbeElement): {
      readonly display: string;
      readonly visibility: string;
      readonly opacity: string;
    };
  } | null;
  querySelectorAll(selector: string): ArrayLike<BrowserProbeElement>;
}

interface BrowserFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

interface BrowserProbeInput {
  readonly platform: PlatformLoginId;
  readonly expectedAccountName: string;
}

async function inspectPlatformSessionInPage(
  input: BrowserProbeInput,
): Promise<PlatformSessionProbeObservation> {
  const browser = globalThis as unknown as {
    readonly document?: BrowserProbeDocument;
    readonly fetch?: (
      url: string,
      options: {
        readonly credentials: "include";
        readonly headers: Readonly<Record<string, string>>;
      },
    ) => Promise<BrowserFetchResponse>;
  };
  const document = browser.document;
  if (document === undefined) return { status: "unavailable" };

  const isVisible = (element: BrowserProbeElement): boolean => {
    let current: BrowserProbeElement | null | undefined = element;
    while (current !== null && current !== undefined) {
      const style = document.defaultView?.getComputedStyle(current);
      if (
        style === undefined ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportWidth = document.defaultView?.innerWidth;
    const viewportHeight = document.defaultView?.innerHeight;
    if (
      viewportWidth !== undefined &&
      viewportHeight !== undefined &&
      rect.top !== undefined &&
      rect.right !== undefined &&
      rect.bottom !== undefined &&
      rect.left !== undefined
    ) {
      return (
        rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth
      );
    }
    return true;
  };
  const challengeSelector = [
    'iframe[src*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="geetest" i]',
    '[id*="verify" i]',
    '[class*="verify" i]',
  ].join(",");
  const challengeDetected = Array.from(document.querySelectorAll(challengeSelector))
    .slice(0, 20)
    .some(isVisible);
  const preferChallenge = (
    observation: PlatformSessionProbeObservation,
  ): PlatformSessionProbeObservation =>
    challengeDetected ? { status: "challenge_required" } : observation;

  const normalize = (value: unknown): string =>
    typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
  const normalizeIdentityId = (value: unknown): string => {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
    }
    return normalize(value);
  };
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const identity = (
    accountIdValue: unknown,
    displayNameValue: unknown,
    evidenceRef: string,
  ): PlatformSessionProbeObservation => {
    const accountId = normalizeIdentityId(accountIdValue);
    const displayName = normalize(displayNameValue);
    const canonicalAccountId = accountId.length > 0 ? accountId : displayName;
    if (canonicalAccountId.length === 0) {
      return { status: "unavailable" };
    }
    const evidence: PlatformIdentityEvidence =
      displayName.length === 0
        ? {
            kind: "account_identity",
            accountId: canonicalAccountId,
            evidenceRef,
          }
        : {
            kind: "account_identity",
            accountId: canonicalAccountId,
            displayName,
            evidenceRef,
          };
    return {
      status: "authenticated",
      evidence,
    };
  };
  const fetchJson = async (url: string): Promise<unknown> => {
    if (browser.fetch === undefined) throw new Error("fetch unavailable");
    const response = await browser.fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("identity endpoint unavailable");
    return response.json();
  };

  try {
    if (input.platform === "toutiao") {
      const response = record(await fetchJson("/mp/agw/media/get_media_info"));
      const data = record(response.data);
      const media = record(data.media);
      if (response.err_no !== 0) return preferChallenge({ status: "unauthenticated" });
      return preferChallenge(
        identity(
          media.media_id ?? media.id,
          media.display_name ?? media.name,
          "github:SyncCaster/platform-api.ts#toutiaoApi.fetchUserInfo",
        ),
      );
    }
    if (input.platform === "baijiahao") {
      const response = record(await fetchJson(`/builder/app/appinfo?_=${String(Date.now())}`));
      const data = record(response.data);
      const user = record(data.user);
      const errorNumber = response.errno;
      const errorMessage = normalize(response.errmsg);
      if (
        (typeof errorNumber === "number" && errorNumber !== 0) ||
        (errorMessage.length > 0 && errorMessage !== "success")
      ) {
        return preferChallenge({ status: "unauthenticated" });
      }
      return preferChallenge(
        identity(
          user.userid ?? user.id ?? user.app_id ?? user.author_id,
          user.name ?? user.username,
          "github:wechatsync/Wechatsync@a98e428:baijiahao.ts#checkAuth",
        ),
      );
    }
    if (input.platform === "netease") {
      const response = record(await fetchJson(`/wemedia/navinfo.do?_=${String(Date.now())}`));
      const data = record(response.data);
      if (response.code !== 1) return preferChallenge({ status: "unauthenticated" });
      return preferChallenge(
        identity(
          data.wemediaId ?? data.tid ?? data.id ?? data.uid,
          data.tname,
          "github:doocs/cose@e70fa9e:wangyihao.js#detectWangyihaoUser",
        ),
      );
    }
    if (input.platform === "zhihu") {
      const data = record(await fetchJson("https://www.zhihu.com/api/v4/me?include=url_token"));
      return preferChallenge(
        identity(
          data.url_token ?? data.uid ?? data.id,
          data.name,
          "github:OpenCLI@a86d647:auth.js#verifyZhihuIdentity",
        ),
      );
    }
    if (input.platform === "sohu") {
      const response = record(await fetchJson("/mpbp/bp/account/list"));
      if (response.code !== 2_000_000) {
        return preferChallenge({ status: "unauthenticated" });
      }
      const data = record(response.data);
      const groups = Array.isArray(data.data) ? data.data : [];
      const directAccounts = Array.isArray(data.accounts) ? data.accounts : [];
      const nestedAccounts = groups.flatMap((group) => {
        const accounts = record(group).accounts;
        return Array.isArray(accounts) ? accounts : [];
      });
      const match = [...directAccounts, ...nestedAccounts]
        .map(record)
        .map((account) => ({
          accountId: normalizeIdentityId(account.id ?? account.accountId ?? account.mpId),
          displayName: normalize(account.nickName ?? account.nickname ?? account.name),
        }))
        .find((account) => account.accountId.length > 0 || account.displayName.length > 0);
      if (match === undefined) return preferChallenge({ status: "unavailable" });
      return preferChallenge(
        identity(
          match.accountId,
          match.displayName,
          "github:wechatsync/Wechatsync@a98e428:sohu.ts#checkAuth",
        ),
      );
    }
  } catch {
    // A failed identity endpoint may be transient. The bounded DOM probe below can still
    // confirm an explicit account control, but never treats a host or cookie as identity.
  }

  const identitySelector = [
    '[data-testid*="account" i]',
    '[data-testid*="user" i]',
    '[class*="account-name" i]',
    '[class*="accountName" i]',
    '[class*="user-name" i]',
    '[class*="userName" i]',
    '[class*="nickname" i]',
    '[class*="nick-name" i]',
    '[aria-label*="账号"]',
  ].join(",");
  for (const element of Array.from(document.querySelectorAll(identitySelector)).slice(0, 40)) {
    if (!isVisible(element)) continue;
    const values = [
      element.textContent,
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.getAttribute("alt"),
    ].map(normalize);
    const displayName = values.find((value) => value.length > 0) ?? "";
    if (displayName.length === 0) continue;
    const stableId = normalize(
      element.getAttribute("data-account-id") ??
        element.getAttribute("data-user-id") ??
        element.getAttribute("data-id") ??
        element.getAttribute("href"),
    );
    if (stableId.length === 0) continue;
    return preferChallenge(
      identity(stableId, displayName, `browser:${input.platform}:visible-account-control`),
    );
  }
  return preferChallenge({ status: "unauthenticated" });
}

export function createPlaywrightPlatformSessionProbe(
  page: PlaywrightPlatformSessionPage,
  expectedAccountName: string,
): PlatformSessionProbe {
  return Object.freeze({
    inspect: async ({ definition }: Parameters<PlatformSessionProbe["inspect"]>[0]) =>
      observationSchema.parse(
        await page.evaluate(inspectPlatformSessionInPage, {
          platform: definition.platform,
          expectedAccountName,
        }),
      ),
  });
}
