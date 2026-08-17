import { BROWSER_PUBLICATION_ADAPTER_VERSIONS } from "@geo/contracts";

import {
  createPlaywrightPlatformPublicationAdapter,
  type PlatformPublicationDefinition,
  type PlaywrightPlatformPublicationAdapter,
  type PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

/**
 * Zhihu column article editor. The selectors below were captured from the
 * authenticated editor DOM and are intentionally specific enough to separate
 * the cover file input from the inline-image input.
 */
export const ZHIHU_ARTICLE_EDITOR_URL = "https://zhuanlan.zhihu.com/write";
export const ZHIHU_CONTENT_MANAGER_URL = "https://www.zhihu.com/creator/manage/creation/article";

// Zhihu column ids are accepted only in the six-to-twenty digit range. Keep
// this bound identical to the pathname parser below so generated candidates
// can always be canonicalized by the public readback path.
const ZHIHU_COLUMN_ARTICLE_ID = /^[1-9]\d{5,19}$/u;

export function isZhihuArticleEditorUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const match = /^\/p\/(\d{6,20})\/edit\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "zhuanlan.zhihu.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === "" &&
    id !== undefined &&
    ZHIHU_COLUMN_ARTICLE_ID.test(id)
  );
}

export function canonicalizeZhihuPublicUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/p\/(\d{6,20})\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "zhuanlan.zhihu.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    id === undefined ||
    !ZHIHU_COLUMN_ARTICLE_ID.test(id)
  ) {
    return null;
  }
  return { id, url: `https://zhuanlan.zhihu.com/p/${id}` };
}

export function zhihuPublicUrlForId(id: string): string | null {
  return ZHIHU_COLUMN_ARTICLE_ID.test(id) ? `https://zhuanlan.zhihu.com/p/${id}` : null;
}

export function canonicalizeZhihuManagementItemUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  try {
    return canonicalizeZhihuPublicUrl(new URL(value, ZHIHU_CONTENT_MANAGER_URL).toString());
  } catch {
    return null;
  }
}

export function zhihuManagementTimestampMatches(
  value: string,
  submittedAt: string,
  observedAt: Date = new Date(),
): boolean {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime()) || !Number.isFinite(observedAt.getTime())) return false;

  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const relative = /^(?:编辑|发布)于\s*(\d+)\s*(分钟|小时|天)前$/u.exec(normalized);
  const justNow = /^(?:编辑|发布)于\s*刚刚$/u.test(normalized);
  if (relative === null && !justNow) return false;

  const amount = justNow ? 0 : Number(relative?.[1]);
  const unit = justNow ? "分钟" : relative?.[2];
  if (!Number.isSafeInteger(amount) || amount < 0) return false;
  const unitMilliseconds = unit === "天" ? 86_400_000 : unit === "小时" ? 3_600_000 : 60_000;
  const submissionToleranceMs = 10 * 60_000;
  const submittedWindowStart = submitted.getTime() - submissionToleranceMs;
  const submittedWindowEnd = submitted.getTime() + submissionToleranceMs;
  const labelWindowEnd = observedAt.getTime() - amount * unitMilliseconds;
  const labelWindowStart = justNow
    ? observedAt.getTime() - submissionToleranceMs
    : observedAt.getTime() - (amount + 1) * unitMilliseconds;

  // Zhihu changes from minute precision to coarse hour/day labels as an
  // article ages. Treat each relative label as the interval it represents and
  // require that interval to overlap the narrow submit-time window. Comparing
  // "1 小时前" as one exact timestamp makes a valid article fail for most of
  // that hour.
  return (
    Math.max(submittedWindowStart, labelWindowStart) <= Math.min(submittedWindowEnd, labelWindowEnd)
  );
}

export const ZHIHU_PUBLICATION_DEFINITION = Object.freeze({
  schemaVersion: "geo.browser-publication-surface.v1",
  platform: "zhihu",
  adapterVersion: BROWSER_PUBLICATION_ADAPTER_VERSIONS.zhihu,
  editorUrl: ZHIHU_ARTICLE_EDITOR_URL,
  editorUrlMatcher: isZhihuArticleEditorUrl,
  source: {
    repositoryUrl: "https://github.com/leaperone/MultiPost-Extension",
    commitSha: "4d9714a1f9132eadc7071b3977e9b4acf76d7c28",
    sourcePaths: ["src/sync/article/zhihu.ts"],
    licenseSpdx: "Apache-2.0",
  },
  titleSelectors: [
    'textarea[placeholder="请输入标题（最多 100 个字）"]',
    'textarea[placeholder*="请输入标题"]',
    'input[placeholder*="请输入标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
  ],
  bodySelectors: [
    'div.public-DraftEditor-content[contenteditable="true"][role="textbox"]',
    'div[data-contents="true"]',
    '[contenteditable="true"]',
  ],
  actionSelector: "button, [role='button']",
  primaryActionLabels: ["发布"],
  finalActionLabels: ["确认发布", "发布", "确定"],
  submissionMode: "direct_with_optional_confirm",
  resultSelectors: ["[role='alert']", ".Notifications", '[class*="notification"]'],
  challengeSelectors: [
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[data-testid*="captcha"]',
    '[aria-label*="验证"]',
  ],
  acceptedSignals: [/(?:发布成功|提交成功|已发布|审核中|待审核|等待审核)/u],
  rejectedSignals: [/(?:发布失败|提交失败|审核不通过|审核未通过|草稿保存失败)/u],
  creatorManagementSurface: {
    url: ZHIHU_CONTENT_MANAGER_URL,
    itemSelector: ".CreationManage-CreationCard",
    titleLinkSelector: 'a[href^="https://zhuanlan.zhihu.com/p/"]:has(.CreationCardTitle-wrapper)',
    // Zhihu currently wraps the title span in an extra layout div.
    // Keep the selector descendant-based so a CSS-module/layout wrapper does
    // not turn an actually published card into a readback timeout.
    titleSelector: ".CreationCardTitle-wrapper span",
    itemLinkSelector: 'a[href^="https://zhuanlan.zhihu.com/p/"]:not([href$="/edit"])',
    timestampSelector: ".CreationCardTitle-wrapper + div",
    statusSelector: "[data-geo-publication-status]",
    publicStatusLabels: [],
    canonicalPublicLinkConfirmsPublished: true,
    canonicalizeItemUrl: canonicalizeZhihuManagementItemUrl,
    timestampMatches: zhihuManagementTimestampMatches,
  },
  publicSurface: {
    titleSelectors: ['meta[property="og:title"]', "h1.Post-Title", ".Post-Title", "article h1"],
    bodySelectors: ["div.RichText.ztext.Post-RichText", ".Post-RichText", "article .RichText"],
    authorSelectors: [
      ".AuthorInfo-name",
      '[data-za-detail-view-element_name="User"]',
      'meta[name="author"]',
    ],
    canonicalizeUrl: canonicalizeZhihuPublicUrl,
    urlForId: zhihuPublicUrlForId,
  },
  publicAuthorIdentityMode: "candidate_url_bound",
} as const satisfies PlatformPublicationDefinition);

export function createPlaywrightZhihuPublicationAdapter(options: {
  readonly pages: () => readonly PlaywrightPublicationPage[];
  readonly openCreatorPage?: (fixedOfficialUrl: string) => Promise<PlaywrightPublicationPage>;
  readonly openIndependentPublicPage: (
    canonicalPublicUrl: string,
  ) => Promise<PlaywrightPublicationPage>;
  readonly confirmationMode?: "publisher_status" | "public_readback";
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly readTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly editorReadyAttempts?: number;
  readonly readbackAttempts?: number;
  readonly submitObservationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): PlaywrightPlatformPublicationAdapter {
  const readbackAttempts = options.readbackAttempts ?? 12;
  const pollMs = options.pollMs ?? 1_000;
  return createPlaywrightPlatformPublicationAdapter({
    ...options,
    definition: ZHIHU_PUBLICATION_DEFINITION,
    confirmationMode: options.confirmationMode ?? "publisher_status",
    readbackAttempts,
    pollMs,
  });
}
