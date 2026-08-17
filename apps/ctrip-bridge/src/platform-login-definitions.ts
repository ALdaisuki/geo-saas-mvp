export const PLATFORM_LOGIN_IDS = Object.freeze([
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "zhihu",
  "ctrip_community",
] as const);

export type PlatformLoginId = (typeof PLATFORM_LOGIN_IDS)[number];

export interface GitHubSessionProbeReference {
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly sourcePath: string;
  readonly symbol: string;
  readonly lineRange: {
    readonly start: number;
    readonly end: number;
  };
  readonly licenseSpdx: "Apache-2.0" | "GPL-3.0" | "MIT";
  readonly integrationConstraint: string;
}

export interface PlatformLoginDefinition {
  readonly schemaVersion: "geo.platform-login-definition.v1";
  readonly platform: PlatformLoginId;
  readonly loginUrl: string;
  readonly expectedAuthenticatedHosts: readonly string[];
  readonly sessionProbe: GitHubSessionProbeReference;
}

function sessionProbeReference(
  input: Omit<GitHubSessionProbeReference, "lineRange"> & {
    readonly lineRange: readonly [start: number, end: number];
  },
): GitHubSessionProbeReference {
  return Object.freeze({
    ...input,
    lineRange: Object.freeze({ start: input.lineRange[0], end: input.lineRange[1] }),
  });
}

function loginDefinition(
  input: Omit<PlatformLoginDefinition, "schemaVersion" | "expectedAuthenticatedHosts"> & {
    readonly expectedAuthenticatedHosts: readonly string[];
  },
): PlatformLoginDefinition {
  return Object.freeze({
    schemaVersion: "geo.platform-login-definition.v1" as const,
    ...input,
    expectedAuthenticatedHosts: Object.freeze([...input.expectedAuthenticatedHosts]),
  });
}

export const PLATFORM_LOGIN_DEFINITIONS = Object.freeze([
  loginDefinition({
    platform: "toutiao",
    loginUrl: "https://mp.toutiao.com/profile_v4/index",
    expectedAuthenticatedHosts: ["mp.toutiao.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/RyanYipeng/SyncCaster",
      commitSha: "ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe",
      sourcePath: "apps/extension/src/background/platform-api.ts",
      symbol: "toutiaoApi.fetchUserInfo",
      lineRange: [5527, 5578],
      licenseSpdx: "MIT",
      integrationConstraint:
        "Require err_no=0 and a stable media identity; do not reuse the cookie fallback.",
    }),
  }),
  loginDefinition({
    platform: "sohu",
    loginUrl: "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1",
    expectedAuthenticatedHosts: ["mp.sohu.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/wechatsync/Wechatsync",
      commitSha: "a98e42865387285afcc027c61836488748f3b30f",
      sourcePath: "packages/core/src/adapters/platforms/sohu.ts",
      symbol: "SohuAdapter.checkAuth",
      lineRange: [59, 120],
      licenseSpdx: "GPL-3.0",
      integrationConstraint:
        "Bind the explicit child-account id; the upstream first-child default must not be reused.",
    }),
  }),
  loginDefinition({
    platform: "baijiahao",
    loginUrl: "https://baijiahao.baidu.com/",
    expectedAuthenticatedHosts: ["baijiahao.baidu.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/wechatsync/Wechatsync",
      commitSha: "a98e42865387285afcc027c61836488748f3b30f",
      sourcePath: "packages/core/src/adapters/platforms/baijiahao.ts",
      symbol: "BaijiahaoAdapter.checkAuth",
      lineRange: [46, 87],
      licenseSpdx: "GPL-3.0",
      integrationConstraint:
        "Require the successful appinfo response and its user id; URL state alone is insufficient.",
    }),
  }),
  loginDefinition({
    platform: "netease",
    loginUrl: "https://mp.163.com/",
    expectedAuthenticatedHosts: ["mp.163.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/doocs/cose",
      commitSha: "e70fa9e92a71cd2f10e0c883981f324a332162d4",
      sourcePath: "packages/detection/src/platforms/wangyihao.js",
      symbol: "detectWangyihaoUser",
      lineRange: [10, 50],
      licenseSpdx: "Apache-2.0",
      integrationConstraint:
        "Require navinfo.do code=1 and wemediaId; do not reuse the upstream cookie collection.",
    }),
  }),
  loginDefinition({
    platform: "zhihu",
    loginUrl: "https://www.zhihu.com/signin",
    expectedAuthenticatedHosts: ["www.zhihu.com", "zhuanlan.zhihu.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/jackwener/OpenCLI",
      commitSha: "a86d64705c526dc710f790e66cfcabf6ecf786b9",
      sourcePath: "clis/zhihu/auth.js",
      symbol: "verifyZhihuIdentity",
      lineRange: [1, 61],
      licenseSpdx: "Apache-2.0",
      integrationConstraint:
        "Require the z_c0 cookie and /api/v4/me url_token identity; cookie presence alone is insufficient.",
    }),
  }),
  loginDefinition({
    platform: "ctrip_community",
    loginUrl: "https://passport.ctrip.com/user/login",
    expectedAuthenticatedHosts: ["my.ctrip.com", "we.ctrip.com", "www.ctrip.com"],
    sessionProbe: sessionProbeReference({
      repositoryUrl: "https://github.com/jackwener/OpenCLI",
      commitSha: "399c0de2a76eb979aee3a3836cf2d24fd247780f",
      sourcePath: "clis/ctrip/auth.js",
      symbol: "verifyCtripIdentity",
      lineRange: [10, 35],
      licenseSpdx: "Apache-2.0",
      integrationConstraint:
        "Reuse only the explicit identity-verification contract; browser cookie access is excluded.",
    }),
  }),
]);

export function getPlatformLoginDefinition(platform: PlatformLoginId): PlatformLoginDefinition {
  const definition = PLATFORM_LOGIN_DEFINITIONS.find(
    (candidate) => candidate.platform === platform,
  );
  if (definition === undefined) throw new TypeError(`No login definition for ${platform}`);
  return definition;
}

export function githubSessionProbeReferenceUrl(reference: GitHubSessionProbeReference): string {
  return `${reference.repositoryUrl}/blob/${reference.commitSha}/${reference.sourcePath}#L${String(reference.lineRange.start)}-L${String(reference.lineRange.end)}`;
}

export interface PlatformLoginNavigator {
  goto(
    url: string,
    options: { readonly timeout: number; readonly waitUntil: "domcontentloaded" },
  ): Promise<unknown>;
  url(): string;
}

export interface PlatformBrowserLocation {
  readonly origin: string;
  readonly hostname: string;
  readonly path: string;
}

export interface PlatformLoginNavigation {
  readonly status: "navigated";
  readonly platform: PlatformLoginId;
  readonly targetUrl: string;
  readonly currentLocation: PlatformBrowserLocation | null;
}

export interface PlatformIdentityEvidence {
  readonly kind: "account_identity";
  readonly accountId: string;
  readonly displayName?: string;
  readonly evidenceRef: string;
}

export type PlatformSessionProbeObservation =
  | {
      readonly status: "authenticated";
      readonly evidence: PlatformIdentityEvidence;
    }
  | { readonly status: "unauthenticated" }
  | { readonly status: "challenge_required" }
  | { readonly status: "unavailable" };

export interface PlatformSessionProbe {
  inspect(input: {
    readonly definition: PlatformLoginDefinition;
    readonly location: PlatformBrowserLocation;
  }): Promise<PlatformSessionProbeObservation>;
}

interface PlatformSessionReviewBase {
  readonly platform: PlatformLoginId;
  readonly location: PlatformBrowserLocation | null;
}

export type PlatformSessionReview =
  | (PlatformSessionReviewBase & {
      readonly status: "authenticated";
      readonly evidence: PlatformIdentityEvidence;
      readonly sourceReference: string;
    })
  | (PlatformSessionReviewBase & {
      readonly status: "unauthenticated";
      readonly reason: "identity_not_confirmed";
    })
  | (PlatformSessionReviewBase & {
      readonly status: "challenge_required";
      readonly reason: "challenge_detected";
    })
  | (PlatformSessionReviewBase & {
      readonly status: "unavailable";
      readonly reason:
        "invalid_identity_evidence" | "probe_unavailable" | "unexpected_authenticated_host";
    });

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_EVIDENCE_REFERENCE_LENGTH = 1_000;

export function canonicalPlatformBrowserLocation(value: string): PlatformBrowserLocation | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return null;
  }
  return Object.freeze({
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    path: parsed.pathname,
  });
}

export async function navigateToPlatformLogin(
  platform: PlatformLoginId,
  navigator: PlatformLoginNavigator,
): Promise<PlatformLoginNavigation> {
  const definition = getPlatformLoginDefinition(platform);
  await navigator.goto(definition.loginUrl, {
    timeout: LOGIN_NAVIGATION_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
  return Object.freeze({
    status: "navigated" as const,
    platform,
    targetUrl: definition.loginUrl,
    currentLocation: canonicalPlatformBrowserLocation(navigator.url()),
  });
}

function normalizedIdentityEvidence(evidence: unknown): PlatformIdentityEvidence | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const candidate = evidence as Partial<PlatformIdentityEvidence>;
  if (
    candidate.kind !== "account_identity" ||
    typeof candidate.accountId !== "string" ||
    (candidate.displayName !== undefined && typeof candidate.displayName !== "string") ||
    typeof candidate.evidenceRef !== "string"
  ) {
    return null;
  }
  const accountId = candidate.accountId.normalize("NFKC").trim();
  const displayName = candidate.displayName?.normalize("NFKC").trim();
  const evidenceRef = candidate.evidenceRef.trim();
  if (
    accountId.length === 0 ||
    accountId.length > MAX_ACCOUNT_ID_LENGTH ||
    (displayName !== undefined && displayName.length > MAX_DISPLAY_NAME_LENGTH) ||
    evidenceRef.length === 0 ||
    evidenceRef.length > MAX_EVIDENCE_REFERENCE_LENGTH
  ) {
    return null;
  }
  return Object.freeze({
    kind: "account_identity" as const,
    accountId,
    ...(displayName === undefined || displayName.length === 0 ? {} : { displayName }),
    evidenceRef,
  });
}

export async function reviewPlatformLoginSession(
  platform: PlatformLoginId,
  navigator: Pick<PlatformLoginNavigator, "url">,
  probe: PlatformSessionProbe,
): Promise<PlatformSessionReview> {
  const definition = getPlatformLoginDefinition(platform);
  const location = canonicalPlatformBrowserLocation(navigator.url());
  if (location === null || !definition.expectedAuthenticatedHosts.includes(location.hostname)) {
    return Object.freeze({
      status: "unavailable" as const,
      platform,
      location,
      reason: "unexpected_authenticated_host" as const,
    });
  }

  let observation: PlatformSessionProbeObservation;
  try {
    observation = await probe.inspect({ definition, location });
  } catch {
    return Object.freeze({
      status: "unavailable" as const,
      platform,
      location,
      reason: "probe_unavailable" as const,
    });
  }

  if (typeof observation !== "object" || observation === null || !("status" in observation)) {
    return Object.freeze({
      status: "unavailable" as const,
      platform,
      location,
      reason: "probe_unavailable" as const,
    });
  }

  if (observation.status === "challenge_required") {
    return Object.freeze({
      status: "challenge_required" as const,
      platform,
      location,
      reason: "challenge_detected" as const,
    });
  }
  if (observation.status === "unauthenticated") {
    return Object.freeze({
      status: "unauthenticated" as const,
      platform,
      location,
      reason: "identity_not_confirmed" as const,
    });
  }
  if (observation.status === "unavailable") {
    return Object.freeze({
      status: "unavailable" as const,
      platform,
      location,
      reason: "probe_unavailable" as const,
    });
  }

  const evidence = normalizedIdentityEvidence(
    "evidence" in observation ? observation.evidence : null,
  );
  if (evidence === null) {
    return Object.freeze({
      status: "unavailable" as const,
      platform,
      location,
      reason: "invalid_identity_evidence" as const,
    });
  }
  return Object.freeze({
    status: "authenticated" as const,
    platform,
    location,
    evidence,
    sourceReference: githubSessionProbeReferenceUrl(definition.sessionProbe),
  });
}
