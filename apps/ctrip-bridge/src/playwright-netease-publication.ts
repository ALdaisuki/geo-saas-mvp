import { BROWSER_PUBLICATION_ADAPTER_VERSIONS } from "@geo/contracts";

import {
  createPlaywrightPlatformPublicationAdapter,
  type PlatformPublicationDefinition,
  type PlaywrightPlatformPublicationAdapter,
  type PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

export const NETEASE_ARTICLE_EDITOR_URL = "https://mp.163.com/#/article-publish";
export const NETEASE_CONTENT_MANAGER_URL = "https://mp.163.com/#/content-manage";
export const NETEASE_DRAFT_MANAGER_URL = "https://mp.163.com/#/draft-manage";

const NETEASE_ARTICLE_ID = /^[A-Z0-9]{8,32}$/u;

export function canonicalizeNeteasePublicUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/dy\/article\/([A-Z0-9]{8,32})\.html$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.163.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    id === undefined ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return { id, url: `https://www.163.com/dy/article/${id}.html` };
}

export function neteasePublicUrlForId(id: string): string | null {
  return NETEASE_ARTICLE_ID.test(id) ? `https://www.163.com/dy/article/${id}.html` : null;
}

export function canonicalizeNeteaseManagementItemUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  try {
    return canonicalizeNeteasePublicUrl(new URL(value, NETEASE_CONTENT_MANAGER_URL).toString());
  } catch {
    return null;
  }
}

export function neteaseManagementTimestampMatches(
  value: string,
  submittedAt: string,
  now: Date = new Date(),
): boolean {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime()) || !Number.isFinite(now.getTime())) return false;
  const expected = new Set<string>();
  for (const timeZone of ["Asia/Shanghai", "UTC"]) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const partsFor = (date: Date) => {
      const parts = formatter.formatToParts(date);
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? "";
      return {
        year: part("year"),
        month: part("month"),
        day: part("day"),
        hour: part("hour"),
        minute: part("minute"),
      };
    };
    const current = partsFor(now);
    const currentDay = Date.UTC(
      Number(current.year),
      Number(current.month) - 1,
      Number(current.day),
    );
    for (let offset = -10; offset <= 10; offset += 1) {
      const candidateDate = new Date(submitted.getTime() + offset * 60_000);
      const candidate = partsFor(candidateDate);
      const time = `${candidate.hour}:${candidate.minute}`;
      expected.add(time);
      expected.add(`${Number(candidate.month)}-${Number(candidate.day)} ${time}`);
      expected.add(`${candidate.year}-${Number(candidate.month)}-${Number(candidate.day)} ${time}`);
      const candidateDay = Date.UTC(
        Number(candidate.year),
        Number(candidate.month) - 1,
        Number(candidate.day),
      );
      const dayDifference = Math.round((currentDay - candidateDay) / 86_400_000);
      if (dayDifference === 1) expected.add(`昨天${time}`);
      if (dayDifference === 2) expected.add(`前天${time}`);
      if (
        now.getTime() - candidateDate.getTime() >= 0 &&
        now.getTime() - candidateDate.getTime() < 60_000
      ) {
        expected.add("刚刚");
      }
    }
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/^创建于\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return expected.has(normalized);
}

export type NeteaseModerationState = "draft" | "pending_or_unpublished" | "published" | "unknown";

export interface NeteaseModerationObservation {
  readonly state: NeteaseModerationState;
  readonly platformStatus: number | null;
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
}

/**
 * The current creator bundle opens an external article only for contentState 3.
 * Other numeric states remain deliberately coarse until a signed-in canary
 * freezes their complete server-side meaning.
 */
export function classifyNeteaseModerationRecord(input: {
  readonly contentState: unknown;
  readonly contentType: unknown;
  readonly articleId: unknown;
}): NeteaseModerationObservation {
  const contentState =
    typeof input.contentState === "number" && Number.isInteger(input.contentState)
      ? input.contentState
      : null;
  const contentType =
    typeof input.contentType === "number" && Number.isInteger(input.contentType)
      ? input.contentType
      : null;
  const state: NeteaseModerationState =
    contentState === 0
      ? "draft"
      : contentState === 3 && contentType === 1
        ? "published"
        : contentState === null
          ? "unknown"
          : "pending_or_unpublished";
  if (state !== "published") {
    return {
      state,
      platformStatus: contentState,
      candidateExternalId: null,
      candidateExternalUrl: null,
    };
  }
  const articleId = typeof input.articleId === "string" ? input.articleId : null;
  const candidateExternalUrl = articleId === null ? null : neteasePublicUrlForId(articleId);
  if (articleId === null || candidateExternalUrl === null) {
    return {
      state: "unknown",
      platformStatus: contentState,
      candidateExternalId: null,
      candidateExternalUrl: null,
    };
  }
  return {
    state,
    platformStatus: contentState,
    candidateExternalId: articleId,
    candidateExternalUrl,
  };
}

export const NETEASE_PUBLICATION_DEFINITION = Object.freeze({
  schemaVersion: "geo.browser-publication-surface.v1",
  platform: "netease",
  adapterVersion: BROWSER_PUBLICATION_ADAPTER_VERSIONS.netease,
  editorUrl: NETEASE_ARTICLE_EDITOR_URL,
  source: {
    repositoryUrl: "https://github.com/RyanYipeng/SyncCaster",
    commitSha: "ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe",
    sourcePaths: ["packages/adapters/src/wangyihao.ts"],
    licenseSpdx: "MIT",
  },
  titleSelectors: [
    'textarea[placeholder="请输入标题 (5~64个字)"]',
    'textarea[placeholder="请输入标题 (5~30个字)"]',
    'textarea[placeholder*="请输入标题"]',
  ],
  bodySelectors: [
    '.public-DraftEditor-content[contenteditable="true"]',
    '.DraftEditor-editorContainer [contenteditable="true"]',
    'div[data-contents="true"]',
  ],
  bodyTextExcludedSelectors: [".rich-editor-image-container"],
  // The public renderer serializes DraftJS block boundaries as adjacent <br>
  // nodes. Preserve strict authored-character matching while tolerating that
  // captured NetEase whitespace transformation.
  publicBodyWhitespaceMode: "ignore",
  actionSelector: "button, [role='button']",
  primaryActionLabels: ["发布"],
  finalActionLabels: ["确认发布", "确定发布", "发布文章", "立即发布", "确定"],
  finalActionSelectors: [
    '[role="dialog"] button, [role="dialog"] [role="button"]',
    '.ne-modal button, .ne-modal [role="button"]',
    '.modal button, .modal [role="button"]',
    "button, [role='button']",
  ],
  submissionMode: "direct_with_optional_confirm",
  resultSelectors: [".ne-message", ".ne-toast", "[role='alert']"],
  challengeSelectors: ['iframe[src*="captcha" i]', '[class*="yidun" i]', '[id*="yidun" i]'],
  acceptedSignals: [/(?:发布成功[，,]?即将跳转到内容管理页|发布成功|提交成功|已提交审核|审核中)/u],
  rejectedSignals: [/(?:发布失败|提交失败|审核不通过|请完善|标题不符合)/u],
  creatorManagementSurface: {
    url: NETEASE_CONTENT_MANAGER_URL,
    itemSelector: ".src-main-page-ContentManage-Card-index-module-card",
    titleLinkSelector: ".src-main-page-ContentManage-Card-index-module-title a[href]",
    timestampSelector: ".src-main-page-ContentManage-Card-index-module-ptime",
    statusSelector: ".src-main-page-ContentManage-Card-index-module-state",
    publicStatusLabels: ["已发布"],
    pendingStatusLabels: ["审核中", "待审核"],
    rejectedStatusLabels: ["未通过", "审核未通过", "审核不通过"],
    draftStatusLabels: ["草稿"],
    canonicalPublicLinkConfirmsPublished: true,
    canonicalizeItemUrl: canonicalizeNeteaseManagementItemUrl,
    timestampMatches: neteaseManagementTimestampMatches,
  },
  creatorDraftManagementSurface: {
    url: NETEASE_DRAFT_MANAGER_URL,
    itemSelector: ".src-main-page-ContentManage-Card-index-module-card",
    titleLinkSelector: ".src-main-page-ContentManage-Card-index-module-title a[href]",
    timestampSelector: ".src-main-page-ContentManage-Card-index-module-ptime",
    statusSelector: ".src-main-page-ContentManage-Card-index-module-state",
    publicStatusLabels: ["已发布"],
    pendingStatusLabels: ["审核中", "待审核"],
    rejectedStatusLabels: ["未通过", "审核未通过", "审核不通过"],
    draftStatusLabels: ["草稿", "图文草稿"],
    canonicalizeItemUrl: canonicalizeNeteaseManagementItemUrl,
    timestampMatches: neteaseManagementTimestampMatches,
  },
  publicSurface: {
    titleSelectors: ["h1.post_title", ".post_title", "article h1"],
    bodySelectors: [".post_body", "#content", "article .post_body"],
    authorSelectors: [
      '.post_info > a[href*="/dy/media/"]',
      ".post_info .source",
      ".post_author .name",
      ".source",
    ],
    canonicalizeUrl: canonicalizeNeteasePublicUrl,
    urlForId: neteasePublicUrlForId,
  },
} as const satisfies PlatformPublicationDefinition);

export function createPlaywrightNeteasePublicationAdapter(options: {
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
  readonly finalActionObservationAttempts?: number;
  readonly submitObservationAttempts?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}): PlaywrightPlatformPublicationAdapter {
  return createPlaywrightPlatformPublicationAdapter({
    ...options,
    definition: NETEASE_PUBLICATION_DEFINITION,
  });
}
