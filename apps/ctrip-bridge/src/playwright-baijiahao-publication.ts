import {
  createPlaywrightPlatformPublicationAdapter,
  type PlatformPublicationDefinition,
  type PlaywrightPlatformPublicationAdapter,
  type PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

export const BAIJIAHAO_ARTICLE_EDITOR_URL =
  "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1";
export const BAIJIAHAO_CONTENT_MANAGER_URL =
  "https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10&search=&type=&collection=&startDate=&endDate=";

const BAIJIAHAO_PUBLIC_ID = /^\d{10,30}$/u;

function canonicalizeBaijiahaoPublicUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const ids = parsed.searchParams.getAll("id");
  const id = ids.length === 1 ? (ids[0] ?? null) : null;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "baijiahao.baidu.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/s" ||
    id === null ||
    !BAIJIAHAO_PUBLIC_ID.test(id) ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return { id, url: `https://baijiahao.baidu.com/s?id=${id}` };
}

function baijiahaoPublicUrlForId(id: string): string | null {
  return BAIJIAHAO_PUBLIC_ID.test(id) ? `https://baijiahao.baidu.com/s?id=${id}` : null;
}

function canonicalizeBaijiahaoManagementItemUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value, "https://baijiahao.baidu.com");
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname !== "baijiahao.baidu.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/s" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const ids = parsed.searchParams.getAll("id");
  const id = ids.length === 1 ? (ids[0] ?? null) : null;
  return id !== null && BAIJIAHAO_PUBLIC_ID.test(id)
    ? { id, url: `https://baijiahao.baidu.com/s?id=${id}` }
    : null;
}

function baijiahaoManagementTimestampMatches(value: string, submittedAt: string): boolean {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime())) return false;
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
    for (let offset = -10; offset <= 10; offset += 1) {
      const parts = formatter.formatToParts(new Date(submitted.getTime() + offset * 60_000));
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? "";
      const year = part("year");
      const month = part("month");
      const day = part("day");
      const hour = part("hour");
      const minute = part("minute");
      expected.add(`${year}-${month}-${day} ${hour}:${minute}`);
      expected.add(`${year}/${month}/${day} ${hour}:${minute}`);
      expected.add(`${month}-${day} ${hour}:${minute}`);
      expected.add(`${Number(month)}-${Number(day)} ${hour}:${minute}`);
      expected.add(`${month}月${day}日 ${hour}:${minute}`);
      expected.add(`${Number(month)}月${Number(day)}日 ${hour}:${minute}`);
      expected.add(`${hour}:${minute}`);
    }
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (expected.has(normalized)) return true;
  const timestamp = normalized.match(
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):(\d{2})/u,
  );
  if (timestamp !== null) {
    const [, year, month, day, hour, minute] = timestamp;
    return expected.has(
      `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")} ${hour?.padStart(2, "0")}:${minute}`,
    );
  }
  return false;
}

export const BAIJIAHAO_PUBLICATION_DEFINITION = Object.freeze({
  schemaVersion: "geo.browser-publication-surface.v1",
  platform: "baijiahao",
  adapterVersion: "baijiahao-browser-publication-v1",
  editorUrl: BAIJIAHAO_ARTICLE_EDITOR_URL,
  editorPayloadWriter: "baijiahao_ueditor_v2",
  bodyEditorScope: "page_or_unique_frame",
  bodyTextExcludedSelectors: [
    ".bjh-image-container",
    ".bjh-image-caption",
    '[data-testid="report-btn"]',
  ],
  source: {
    repositoryUrl: "https://github.com/xiaohao80/baijiahao-auto-publisher",
    commitSha: "e6eea968bb495f2a9156998f6ef4b777f143c4b0",
    sourcePaths: ["baijiahao_publisher.py"],
    licenseSpdx: null,
  },
  titleSelectors: [
    '[contenteditable="true"][data-lexical-editor="true"]',
    'div.contenteditable[placeholder*="标题"]',
    'div[contenteditable="true"][placeholder*="标题"]',
    'input[placeholder*="请输入标题"]',
    'textarea[placeholder*="请输入标题"]',
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
  ],
  bodySelectors: [
    'body[contenteditable="true"][class*="news-editor-pc"]',
    'body[contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="正文"]',
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"]:not([data-lexical-editor="true"])',
  ],
  actionSelector: "button, [role='button']",
  primaryActionLabels: ["发布"],
  finalActionLabels: ["确认发布", "确定", "确认"],
  submissionMode: "direct_with_optional_confirm",
  resultSelectors: ['[class*="cheetah-message"]', '[class*="cheetah-toast"]', "[role='alert']"],
  challengeSelectors: ['[data-testid="captcha"]', '[class*="captcha"]', ".vcode-spin"],
  acceptedSignals: [/(?:发布成功|提交成功|已提交审核|正在审核|审核中)/u],
  rejectedSignals: [/(?:发布失败|提交失败|审核不通过|请完善|标题不符合)/u],
  creatorManagementSurface: {
    url: BAIJIAHAO_CONTENT_MANAGER_URL,
    itemSelector: "[class*='articleItem']",
    titleLinkSelector: ".title a[href*='baijiahao.baidu.com/s?id=']",
    titleSelector: ".title .cheetah-public",
    itemLinkSelector: ".title a[href*='baijiahao.baidu.com/s?id=']",
    timestampSelector: "time, [class*='time'], [class*='date']",
    statusSelector:
      "[class*='status'], [class*='state'], [class*='tag'], [class*='articleTags_createTag']",
    publicStatusLabels: ["已发布", "发布成功", "已上线"],
    pendingStatusLabels: ["审核中", "待审核", "待发布"],
    rejectedStatusLabels: ["未通过", "审核未通过", "审核不通过"],
    draftStatusLabels: ["草稿"],
    canonicalizeItemUrl: canonicalizeBaijiahaoManagementItemUrl,
    timestampMatches: baijiahaoManagementTimestampMatches,
  },
  publicSurface: {
    titleSelectors: [
      "#header > div:first-child",
      "#header > div:nth-child(1)",
      "h1.article-title",
      ".article-title",
      "article h1",
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ],
    bodySelectors: ['[data-testid="article"]', "#article-content", ".article-content", "article"],
    authorSelectors: [
      '#header [data-testid="author-name"]',
      '[data-testid="author-name"]',
      '#header a[href*="author.baidu.com/home"] p[data-testid="author-name"]',
      '#header a[href*="author.baidu.com/home"]',
      ".author-name",
      ".account-name",
      ".author-info .name",
      'meta[name="author"]',
    ],
    canonicalizeUrl: canonicalizeBaijiahaoPublicUrl,
    urlForId: baijiahaoPublicUrlForId,
  },
} as const satisfies PlatformPublicationDefinition);

export function createPlaywrightBaijiahaoPublicationAdapter(options: {
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
  return createPlaywrightPlatformPublicationAdapter({
    ...options,
    definition: BAIJIAHAO_PUBLICATION_DEFINITION,
  });
}
