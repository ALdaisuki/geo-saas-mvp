import { BROWSER_PUBLICATION_ADAPTER_VERSIONS } from "@geo/contracts";

import {
  createPlaywrightPlatformPublicationAdapter,
  type PlatformPublicationDefinition,
  type PlaywrightPlatformPublicationAdapter,
  type PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

export const TOUTIAO_ARTICLE_EDITOR_URL = "https://mp.toutiao.com/profile_v4/graphic/publish";
export const TOUTIAO_CONTENT_MANAGER_URL = "https://mp.toutiao.com/profile_v4/manage/content/all";

const TOUTIAO_PUBLIC_ID = /^\d{10,30}$/u;
const TOUTIAO_FINAL_ACTION_OBSERVATION_ATTEMPTS = 41;

function canonicalizeToutiaoPublicUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/article\/(\d{10,30})\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.toutiao.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    id === undefined ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return { id, url: `https://www.toutiao.com/article/${id}/` };
}

function toutiaoPublicUrlForId(id: string): string | null {
  return TOUTIAO_PUBLIC_ID.test(id) ? `https://www.toutiao.com/article/${id}/` : null;
}

function canonicalizeToutiaoManagementItemUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value, "https://www.toutiao.com");
  } catch {
    return null;
  }
  const match = /^\/item\/(\d{10,30})\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.toutiao.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    id === undefined
  ) {
    return null;
  }
  return { id, url: `https://www.toutiao.com/article/${id}/` };
}

function toutiaoManagementTimestampMatches(value: string, submittedAt: string): boolean {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime())) return false;
  const expected = new Set<string>();
  for (const timeZone of ["Asia/Shanghai", "UTC"]) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (let offset = -10; offset <= 10; offset += 1) {
      const parts = formatter.formatToParts(new Date(submitted.getTime() + offset * 60_000));
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? "";
      expected.add(`${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`);
    }
  }
  return expected.has(value.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

export const TOUTIAO_PUBLICATION_DEFINITION = Object.freeze({
  schemaVersion: "geo.browser-publication-surface.v1",
  platform: "toutiao",
  adapterVersion: BROWSER_PUBLICATION_ADAPTER_VERSIONS.toutiao,
  editorUrl: TOUTIAO_ARTICLE_EDITOR_URL,
  resetDraftOnWrite: true,
  editorTextDecorationsToStrip: ["编辑搜图"],
  source: {
    repositoryUrl: "https://github.com/guanyang/super-publisher",
    commitSha: "ee7466c6a83f1c9af520410849f40bb2c92ba08a",
    sourcePaths: ["skills/toutiao-publisher/scripts/publisher.py"],
    licenseSpdx: "MIT",
  },
  titleSelectors: [
    'textarea[placeholder*="请输入文章标题"]',
    'input[placeholder*="请输入文章标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
  ],
  bodySelectors: ['.ProseMirror[contenteditable="true"]', ".ProseMirror"],
  bodyTextExcludedSelectors: ['div[__syl_tag="true"][contenteditable="false"]'],
  actionSelector: "button, [role='button']",
  primaryActionLabels: ["预览并发布"],
  finalActionSelectors: [
    ".publish-btn-last",
    ".byte-modal .byte-btn-primary",
    "button, [role='button']",
  ],
  finalActionLabels: ["确认发布", "发布", "确定"],
  submissionMode: "preview_then_confirm",
  resultSelectors: [".byte-message-success", ".byte-notification-success", "[role='alert']"],
  challengeSelectors: [
    '[data-testid="captcha"]',
    '[class*="captcha"]',
    ".secsdk-captcha-drag-icon",
  ],
  // Toutiao can keep the creator page in a moderation state after dispatch. Treat
  // those signals as a non-final acceptance so the control plane continues its
  // durable public-readback polling instead of classifying the handoff as failed.
  acceptedSignals: [/(?:发布成功|提交成功|已提交审核|正在审核|审核中|待审核|主页查看)/u],
  rejectedSignals: [/(?:发布失败|提交失败|审核不通过|请完善|标题不符合)/u],
  noMediaOption: {
    actionSelector: ".article-cover-radio-group label.byte-radio",
    actionLabel: "无封面",
    selectedDescendantSelector: ".byte-radio-inner.checked",
  },
  creatorManagementSurface: {
    url: TOUTIAO_CONTENT_MANAGER_URL,
    itemSelector: ".article-card-wrap",
    titleLinkSelector: "a.title[href]",
    timestampSelector: ".create-time",
    statusSelector: ".byte-tag",
    publicStatusLabels: ["已发布"],
    pendingStatusLabels: ["审核中", "待审核"],
    rejectedStatusLabels: ["未通过", "审核未通过", "审核不通过"],
    draftStatusLabels: ["草稿"],
    canonicalizeItemUrl: canonicalizeToutiaoManagementItemUrl,
    timestampMatches: toutiaoManagementTimestampMatches,
  },
  publicSurface: {
    titleSelectors: [
      '[data-testid="article-title"]',
      ".article-content > h1",
      "h1.article-content-title",
      "h1.article-content__title",
      "article h1",
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ],
    bodySelectors: [
      ".syl-page-article",
      '[data-testid="article-content"]',
      ".article-content-text",
      ".article-content .article-content-text",
      ".article-content",
      "article .article-content",
    ],
    authorSelectors: [
      ".article-meta .name",
      '[data-testid="author-name"]',
      ".article-author-name",
      ".author-name",
      'meta[name="author"]',
    ],
    canonicalizeUrl: canonicalizeToutiaoPublicUrl,
    urlForId: toutiaoPublicUrlForId,
  },
} as const satisfies PlatformPublicationDefinition);

export function createPlaywrightToutiaoPublicationAdapter(options: {
  readonly pages: () => readonly PlaywrightPublicationPage[];
  readonly openCreatorPage?: (fixedOfficialUrl: string) => Promise<PlaywrightPublicationPage>;
  readonly openIndependentPublicPage: (
    canonicalPublicUrl: string,
  ) => Promise<PlaywrightPublicationPage>;
  readonly confirmationMode?: "publisher_status" | "public_readback";
  readonly allowCreatorProfilePublicPage?: boolean;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly readTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly editorReadyAttempts?: number;
  readonly readbackAttempts?: number;
  readonly finalActionObservationAttempts?: number;
  readonly submitObservationAttempts?: number;
  readonly pollMs?: number;
}): PlaywrightPlatformPublicationAdapter {
  return createPlaywrightPlatformPublicationAdapter({
    ...options,
    finalActionObservationAttempts:
      options.finalActionObservationAttempts ?? TOUTIAO_FINAL_ACTION_OBSERVATION_ATTEMPTS,
    definition: TOUTIAO_PUBLICATION_DEFINITION,
  });
}
