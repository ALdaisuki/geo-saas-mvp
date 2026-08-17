import { BROWSER_PUBLICATION_ADAPTER_VERSIONS } from "@geo/contracts";

import {
  createPlaywrightPlatformPublicationAdapter,
  type PlatformPublicationDefinition,
  type PlaywrightPlatformPublicationAdapter,
  type PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

export const SOHU_ARTICLE_EDITOR_URL =
  "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1";
export const SOHU_CONTENT_MANAGER_URL =
  "https://mp.sohu.com/mpfe/v4/contentManagement/first/page?newsType=1";

const SOHU_ITEM_ID = /^[1-9]\d{0,29}_[1-9]\d{0,29}$/u;
const SOHU_NUMERIC_ID = /^[1-9]\d{0,29}$/u;

function normalizedNumericId(value: unknown): string | null {
  const candidate = typeof value === "number" ? String(value) : value;
  return typeof candidate === "string" && SOHU_NUMERIC_ID.test(candidate) ? candidate : null;
}

export function canonicalizeSohuPublicUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/a\/([1-9]\d{0,29}_[1-9]\d{0,29})\/?$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.sohu.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    id === undefined ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return { id, url: `https://www.sohu.com/a/${id}` };
}

export function sohuPublicUrlForId(id: string): string | null {
  return SOHU_ITEM_ID.test(id) ? `https://www.sohu.com/a/${id}` : null;
}

export function canonicalizeSohuManagementItemUrl(
  value: string,
): { readonly id: string; readonly url: string } | null {
  try {
    return canonicalizeSohuPublicUrl(new URL(value, SOHU_CONTENT_MANAGER_URL).toString());
  } catch {
    return null;
  }
}

export function sohuManagementTimestampMatches(value: string, submittedAt: string): boolean {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime())) return false;
  const expected = new Set<string>();
  for (const timeZone of ["Asia/Shanghai", "UTC"]) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
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
      expected.add(
        `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`,
      );
    }
  }
  return expected.has(value.normalize("NFKC").replace(/\s+/gu, " ").trim());
}

export type SohuModerationState =
  "draft" | "pending" | "published" | "rejected" | "deleted" | "unknown";

export interface SohuModerationObservation {
  readonly state: SohuModerationState;
  readonly platformStatus: number | null;
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
}

export interface SohuRejectedManagementRecord {
  readonly title: string;
  readonly status: number;
  readonly id: string | null;
  readonly userId: string | null;
  readonly rejectReason: string | null;
}

function normalizedSohuValue(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

function normalizedSohuId(value: unknown): string | null {
  const candidate = typeof value === "number" ? String(value) : normalizedSohuValue(value);
  return SOHU_NUMERIC_ID.test(candidate) ? candidate : null;
}

function sohuManagementIdentity(value: string): {
  readonly id: string | null;
  readonly userId: string | null;
} {
  try {
    const parsed = new URL(value, SOHU_CONTENT_MANAGER_URL);
    return {
      id: normalizedSohuId(parsed.searchParams.get("id")),
      userId: normalizedSohuId(
        parsed.searchParams.get("accountId") ?? parsed.searchParams.get("userId"),
      ),
    };
  } catch {
    return { id: null, userId: null };
  }
}

/**
 * Matches a sanitized response from Sohu's authenticated rejected-content
 * list. The DOM row has already matched title and submission time; IDs, when
 * present in the preview link, make the response binding deterministic.
 */
export function selectSohuRejectionReason(input: {
  readonly records: readonly SohuRejectedManagementRecord[];
  readonly expectedTitle: string;
  readonly itemUrls: readonly string[];
}): string | null {
  const expectedTitle = normalizedSohuValue(input.expectedTitle);
  const identities = input.itemUrls.map(sohuManagementIdentity);
  const candidates = input.records.filter((record) => {
    if (record.status !== 3 || normalizedSohuValue(record.title) !== expectedTitle) return false;
    const identityMatches = identities.some(
      (identity) =>
        (identity.id === null || record.id === null || identity.id === record.id) &&
        (identity.userId === null || record.userId === null || identity.userId === record.userId),
    );
    return identities.length === 0 || identityMatches;
  });
  if (candidates.length !== 1) return null;
  const reason = normalizedSohuValue(candidates[0]?.rejectReason);
  return reason.length > 0 ? reason : null;
}

interface SohuRejectionFetchArgument {
  readonly endpointPath: string;
  readonly maximum: number;
}

interface SohuRejectionFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

/**
 * Runs inside the authenticated page. It deliberately returns only the
 * minimum fields needed for moderation classification, never cookies or the
 * original response payload.
 */
async function fetchSohuRejectedManagementRecords(
  argument: SohuRejectionFetchArgument,
): Promise<readonly SohuRejectedManagementRecord[]> {
  const runtime = globalThis as unknown as {
    readonly fetch?: (
      input: string,
      init?: { readonly credentials?: string; readonly headers?: Readonly<Record<string, string>> },
    ) => Promise<SohuRejectionFetchResponse>;
  };
  if (runtime.fetch === undefined) return [];
  const response = await runtime.fetch(argument.endpointPath, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return extractSohuRejectedManagementRecords(payload, argument.maximum);
}

/**
 * Normalizes the rejected-content payload without depending on a particular
 * bundle field name. Sohu has moved the human-readable reason between
 * rejectReason, auditMessage and auditMsg across creator-center revisions.
 */
export function extractSohuRejectedManagementRecords(
  payload: unknown,
  maximum = 100,
): readonly SohuRejectedManagementRecord[] {
  const records: SohuRejectedManagementRecord[] = [];
  const seen = new Set<string>();
  const text = (value: unknown): string =>
    typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
  const numberId = (value: unknown): string | null => {
    const candidate = typeof value === "number" ? String(value) : text(value);
    return /^[1-9]\d{0,29}$/u.test(candidate) ? candidate : null;
  };
  const first = (record: Record<string, unknown>, keys: readonly string[]): unknown => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    return null;
  };
  const visit = (value: unknown, depth: number): void => {
    if (records.length >= maximum || depth > 8 || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const rawStatus = first(record, ["status", "statusType", "newsStatus"]);
    const status = typeof rawStatus === "number" ? rawStatus : Number.parseInt(text(rawStatus), 10);
    const title = text(first(record, ["title", "newsTitle", "contentTitle"]));
    if (status === 3 && title.length > 0) {
      const id = numberId(first(record, ["id", "newsId", "articleId"]));
      const userId = numberId(first(record, ["userId", "accountId", "mediaId"]));
      const rejectReason = text(
        first(record, [
          "rejectReason",
          "reject_reason",
          "auditReason",
          "auditMessage",
          "auditMsg",
          "auditDetail",
          "rejectMsg",
          "rejectMessage",
          "failReason",
          "reasonText",
          "reason",
          "message",
          "description",
        ]),
      );
      const key = `${title}\u0000${id ?? ""}\u0000${userId ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        records.push({ title, status, id, userId, rejectReason: rejectReason || null });
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(payload, 0);
  return records;
}

const SOHU_REJECTED_NEWS_ENDPOINT = "/mpbp/bp/news/v4/users/news?psize=50&newsType=0&statusType=3";

/**
 * Sohu's submit response is only an acceptance signal. A public candidate is
 * created exclusively from a content-management record whose status is 4.
 */
export function classifySohuModerationRecord(input: {
  readonly status: unknown;
  readonly id: unknown;
  readonly userId: unknown;
}): SohuModerationObservation {
  const status =
    typeof input.status === "number" && Number.isInteger(input.status) ? input.status : null;
  const state: SohuModerationState =
    status === 1
      ? "draft"
      : status === 2 || status === 5 || status === 16
        ? "pending"
        : status === 3
          ? "rejected"
          : status === 4
            ? "published"
            : status === 7 || status === 9
              ? "deleted"
              : "unknown";
  if (state !== "published") {
    return {
      state,
      platformStatus: status,
      candidateExternalId: null,
      candidateExternalUrl: null,
    };
  }
  const articleId = normalizedNumericId(input.id);
  const userId = normalizedNumericId(input.userId);
  if (articleId === null || userId === null) {
    return {
      state: "unknown",
      platformStatus: status,
      candidateExternalId: null,
      candidateExternalUrl: null,
    };
  }
  const candidateExternalId = `${articleId}_${userId}`;
  return {
    state,
    platformStatus: status,
    candidateExternalId,
    candidateExternalUrl: sohuPublicUrlForId(candidateExternalId),
  };
}

export const SOHU_PUBLICATION_DEFINITION = Object.freeze({
  schemaVersion: "geo.browser-publication-surface.v1",
  platform: "sohu",
  adapterVersion: BROWSER_PUBLICATION_ADAPTER_VERSIONS.sohu,
  editorUrl: SOHU_ARTICLE_EDITOR_URL,
  source: {
    repositoryUrl: "https://github.com/leaperone/MultiPost-Extension",
    commitSha: "4d9714a1f9132eadc7071b3977e9b4acf76d7c28",
    sourcePaths: ["src/sync/article/sohu.ts"],
    licenseSpdx: "Apache-2.0",
  },
  titleSelectors: [
    ".publish-title input",
    'input[placeholder="请输入标题（5-72字）"]',
    'input[placeholder*="请输入标题"]',
  ],
  bodySelectors: ['.ql-editor[contenteditable="true"]', "div.ql-editor"],
  bodyTextExcludedSelectors: [".ql-image-container"],
  actionSelector: "li.positive-button, button, [role='button']",
  primaryActionLabels: ["发布"],
  finalActionLabels: ["确认发布", "确定发布", "确定"],
  finalActionSelectors: [
    '[role="dialog"] li.positive-button, [role="dialog"] button, [role="dialog"] [role="button"]',
    '.el-dialog li.positive-button, .el-dialog button, .el-dialog [role="button"]',
    "li.positive-button, button, [role='button']",
  ],
  submissionMode: "direct_with_optional_confirm",
  resultSelectors: [".el-message__content", ".mp-message", "[role='alert']"],
  challengeSelectors: ['iframe[src*="captcha" i]', '[class*="tcaptcha" i]', '[id*="tcaptcha" i]'],
  acceptedSignals: [/(?:发布成功|提交成功|已提交审核|审核中)/u],
  rejectedSignals: [/(?:发布失败|提交失败|审核不通过|请完善|标题不符合)/u],
  creatorManagementSurface: {
    url: SOHU_CONTENT_MANAGER_URL,
    itemSelector: ".content-item",
    titleLinkSelector: ".article-content-info h3.title > a[href]",
    timestampSelector: ".article-content-info h3.title > .date-common",
    statusSelector: ".status-view-icon + .status-common, .article-content-info .status",
    publicStatusLabels: ["已发布"],
    pendingStatusLabels: ["审核中", "待审核", "审核中/待发布"],
    rejectedStatusLabels: ["未通过", "审核未通过", "审核不通过"],
    draftStatusLabels: ["草稿"],
    canonicalPublicLinkConfirmsPublished: true,
    canonicalizeItemUrl: canonicalizeSohuManagementItemUrl,
    timestampMatches: sohuManagementTimestampMatches,
    resolveRejectionReason: async ({ page, expectedTitle, itemUrls }) => {
      if (page.evaluate === undefined) return null;
      const records = await page.evaluate(fetchSohuRejectedManagementRecords, {
        endpointPath: SOHU_REJECTED_NEWS_ENDPOINT,
        maximum: 100,
      });
      return selectSohuRejectionReason({ records, expectedTitle, itemUrls });
    },
  },
  publicSurface: {
    titleSelectors: [
      ".text-title > h1",
      "h1.screen-reader-only",
      ".title-info-title",
      "h1.title-info-title",
    ],
    bodySelectors: ["article#mp-editor", "#mp-editor"],
    authorSelectors: ["#user-info h1 a", "#user-info .user-name", ".user-info h1 a"],
    canonicalizeUrl: canonicalizeSohuPublicUrl,
    urlForId: sohuPublicUrlForId,
  },
  publicAuthorIdentityMode: "candidate_url_bound",
} as const satisfies PlatformPublicationDefinition);

export function createPlaywrightSohuPublicationAdapter(options: {
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
}): PlaywrightPlatformPublicationAdapter {
  return createPlaywrightPlatformPublicationAdapter({
    ...options,
    definition: SOHU_PUBLICATION_DEFINITION,
  });
}
