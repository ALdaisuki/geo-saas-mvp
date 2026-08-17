import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import { normalizeCtripPublicContent } from "./public-content-binding.js";

export interface CtripPublicReadbackInput {
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
  readonly expectedTitle: string;
  readonly expectedBody: string;
  readonly submittedAt: string | null;
}

export interface CtripPublicReadbackResult {
  readonly outcome: "publisher_rejected" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly observedTitle: string;
  readonly observedBody: string;
  readonly signal: string;
  readonly publisherReasonCode?: string | null;
}

export interface CtripPublicReadbackWriter {
  readback(input: CtripPublicReadbackInput): Promise<CtripPublicReadbackResult>;
}

type NavigableCtripPage = PlaywrightCtripDraftPage & {
  goto?(
    url: string,
    options?: { readonly timeout?: number; readonly waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  waitForLoadState?(
    state?: "domcontentloaded",
    options?: { readonly timeout?: number },
  ): Promise<void>;
};

const READ_TIMEOUT_MS = 2_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const INTERNAL_ORIGIN = "https://we.ctrip.com";
const INTERNAL_DETAIL_PATH = "/publish/detail";
const INTERNAL_MANAGEMENT_PATH = "/publish/contentManagement";
const INTERNAL_MANAGEMENT_URL = `${INTERNAL_ORIGIN}${INTERNAL_MANAGEMENT_PATH}`;
const MANAGEMENT_ROW_SELECTOR = ".c-m-c-container";
const MANAGEMENT_RECENCY_MINUTES = 5;
const MANAGEMENT_RENDER_ATTEMPTS = 20;
const MANAGEMENT_NAVIGATION_ATTEMPTS = 40;
const MANAGEMENT_NAVIGATION_POLL_MS = 250;
const TITLE_SELECTORS = Object.freeze(["div.right.flex-column > span.user-name-title", "h1"]);
const BODY_SELECTORS = Object.freeze([
  "div.right.flex-column > span.content",
  '[data-testid="article-content"]',
  ".article-content",
  "article",
  "main",
]);
const PAGE_BODY_SELECTOR = "body";
const CHALLENGE_SELECTORS = Object.freeze([
  '[data-testid="captcha"]',
  '[class*="captcha"]',
  ".nc-container",
]);

function normalizedText(value: string | null): string {
  return normalizeCtripPublicContent(value ?? "");
}

async function readFirstNonEmptyText(
  page: NavigableCtripPage,
  selectors: readonly string[],
): Promise<string> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 10);
    for (let index = 0; index < count; index += 1) {
      if (!(await locator.nth(index).isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
      const value = normalizedText(
        await locator.nth(index).textContent({ timeout: READ_TIMEOUT_MS }),
      );
      if (value.length > 0) return value;
    }
  }
  return "";
}

function ctripTimestamp(value: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

function containsRecentCtripTimestamp(text: string, submittedAt: Date): boolean {
  const minute = 60_000;
  for (
    let offset = -MANAGEMENT_RECENCY_MINUTES;
    offset <= MANAGEMENT_RECENCY_MINUTES;
    offset += 1
  ) {
    const timestamp = ctripTimestamp(new Date(submittedAt.getTime() + offset * minute)).slice(
      0,
      16,
    );
    if (text.includes(timestamp)) return true;
  }
  return false;
}

function publicCandidateFromId(id: string): { readonly id: string; readonly url: string } {
  const publicUrl = new URL("https://m.ctrip.com/webapp/you/community/detail");
  publicUrl.searchParams.set("articleId", id);
  return { id, url: publicUrl.toString() };
}

function internalDetailCandidate(
  value: string,
): { readonly id: string; readonly url: string } | null {
  try {
    const url = new URL(value);
    if (url.origin !== INTERNAL_ORIGIN || url.pathname !== INTERNAL_DETAIL_PATH) return null;
    const articleIds = url.searchParams.getAll("articleId");
    if (articleIds.length !== 1 || !/^\d{1,20}$/u.test(articleIds[0] ?? "")) return null;
    return publicCandidateFromId(articleIds[0] as string);
  } catch {
    return null;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function publicCtripUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (host !== "ctrip.com" && !host.endsWith(".ctrip.com")) ||
      host === "we.ctrip.com"
    ) {
      return null;
    }
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function isInternalDetailPage(page: NavigableCtripPage): boolean {
  try {
    const url = new URL(page.url());
    return (
      url.origin === INTERNAL_ORIGIN &&
      url.pathname === INTERNAL_DETAIL_PATH &&
      /^\d{1,20}$/u.test(url.searchParams.get("articleId") ?? "")
    );
  } catch {
    return false;
  }
}

function unavailable(signal: string): CtripPublicReadbackResult {
  return {
    outcome: "unavailable",
    externalId: null,
    externalUrl: null,
    observedTitle: "",
    observedBody: "",
    signal,
  };
}

function publisherRejectionReason(text: string): string {
  return /广告软文/u.test(normalizedText(text))
    ? "publisher.rejected.soft_advertorial"
    : "publisher.rejected.other";
}

function collectDetailCandidates(
  pages: readonly NavigableCtripPage[],
): Array<{ readonly id: string; readonly url: string }> {
  return pages
    .map((candidatePage) => internalDetailCandidate(candidatePage.url()))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
}

function uniqueCandidate(
  candidates: ReadonlyArray<{ readonly id: string; readonly url: string }>,
): { readonly id: string; readonly url: string } | null {
  const ids = [...new Set(candidates.map((candidate) => candidate.id))];
  if (ids.length !== 1) return null;
  return candidates.find((value) => value.id === ids[0]) ?? null;
}

type ManagementCandidateRecovery =
  | { readonly candidate: { readonly id: string; readonly url: string }; readonly signal: null }
  | {
      readonly candidate: null;
      readonly signal: string;
      readonly publisherReasonCode?: string;
    };

async function recoverFromManagementPage(options: {
  readonly page: NavigableCtripPage;
  readonly input: CtripPublicReadbackInput;
  readonly pages: () => readonly NavigableCtripPage[];
  readonly submittedAt: Date;
}): Promise<ManagementCandidateRecovery> {
  const page = options.page;
  if (page.goto !== undefined) {
    try {
      await page.goto(INTERNAL_MANAGEMENT_URL, {
        timeout: NAVIGATION_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      return { candidate: null, signal: "management-navigation-failed" };
    }
  }
  const detailIdsBeforeClick = new Set(
    collectDetailCandidates(options.pages()).map((candidate) => candidate.id),
  );
  if (await hasChallenge(page)) {
    return { candidate: null, signal: "management-challenge-detected" };
  }
  const rows = page.locator(MANAGEMENT_ROW_SELECTOR);
  let count = 0;
  for (let attempt = 0; attempt < MANAGEMENT_RENDER_ATTEMPTS; attempt += 1) {
    count = Math.min(await rows.count(), 100);
    if (count > 0) break;
    await wait(MANAGEMENT_NAVIGATION_POLL_MS);
  }
  const expectedTitle = normalizedText(options.input.expectedTitle);
  const matches: Array<{
    readonly row: PlaywrightCtripDraftLocator;
    readonly status: "published" | "pending" | "rejected";
    readonly text: string;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    const text = normalizedText(await row.textContent({ timeout: READ_TIMEOUT_MS }));
    const status = text.includes("已发布")
      ? "published"
      : /(?:待审核|审核中)/u.test(text)
        ? "pending"
        : /(?:审核未通过|审核不通过|未通过)/u.test(text)
          ? "rejected"
          : null;
    if (
      text.startsWith(expectedTitle) &&
      !text.includes("草稿") &&
      status !== null &&
      containsRecentCtripTimestamp(text, options.submittedAt)
    ) {
      matches.push({ row, status, text });
    }
  }
  if (matches.length === 0) return { candidate: null, signal: "management-candidate-not-found" };
  if (matches.length !== 1) return { candidate: null, signal: "management-candidate-not-unique" };
  const match = matches[0];
  if (match === undefined) return { candidate: null, signal: "management-candidate-not-found" };
  if (match.status === "rejected") {
    const publisherReasonCode = publisherRejectionReason(match.text);
    return {
      candidate: null,
      signal:
        publisherReasonCode === "publisher.rejected.soft_advertorial"
          ? "management-candidate-rejected-soft-advertorial"
          : "management-candidate-rejected",
      publisherReasonCode,
    };
  }
  if (match.status === "pending") {
    return { candidate: null, signal: "management-candidate-pending-review" };
  }

  await match.row.click({ timeout: NAVIGATION_TIMEOUT_MS });
  for (let attempt = 0; attempt < MANAGEMENT_NAVIGATION_ATTEMPTS; attempt += 1) {
    const livePages = [page, ...options.pages()];
    const allCandidates = collectDetailCandidates(livePages);
    const freshCandidates = allCandidates.filter(
      (candidate) => !detailIdsBeforeClick.has(candidate.id),
    );
    const fresh = uniqueCandidate(freshCandidates);
    if (fresh !== null) {
      const restoreSignal = await restoreManagementPage(page);
      return restoreSignal === null
        ? { candidate: fresh, signal: null }
        : { candidate: null, signal: restoreSignal };
    }
    if (freshCandidates.length > 1) {
      return { candidate: null, signal: "management-detail-not-unique" };
    }

    // Fallback: management navigated in-place, or detail was already open for this article.
    const managementDetail = internalDetailCandidate(page.url());
    if (managementDetail !== null) {
      const restoreSignal = await restoreManagementPage(page);
      return restoreSignal === null
        ? { candidate: managementDetail, signal: null }
        : { candidate: null, signal: restoreSignal };
    }
    await wait(MANAGEMENT_NAVIGATION_POLL_MS);
  }
  return { candidate: null, signal: "management-detail-navigation-timeout" };
}

async function recoverManagementCandidate(options: {
  readonly input: CtripPublicReadbackInput;
  readonly pages: () => readonly NavigableCtripPage[];
  readonly openPage?: (url: string) => Promise<NavigableCtripPage>;
}): Promise<ManagementCandidateRecovery> {
  if (options.input.submittedAt === null) {
    return { candidate: null, signal: "management-submit-time-missing" };
  }
  const submittedAt = new Date(options.input.submittedAt);
  if (Number.isNaN(submittedAt.getTime())) {
    return { candidate: null, signal: "management-submit-time-invalid" };
  }
  let managementPages = options.pages().filter((page) => {
    try {
      const url = new URL(page.url());
      return url.origin === INTERNAL_ORIGIN && url.pathname === INTERNAL_MANAGEMENT_PATH;
    } catch {
      return false;
    }
  });
  if (managementPages.length === 0) {
    if (options.openPage === undefined) {
      return { candidate: null, signal: "management-navigation-unavailable" };
    }
    try {
      managementPages = [await options.openPage(INTERNAL_MANAGEMENT_URL)];
    } catch {
      return { candidate: null, signal: "management-navigation-failed" };
    }
  }

  let lastSignal = "management-candidate-not-found";
  let lastPublisherReasonCode: string | undefined;
  const recovered: Array<{ readonly id: string; readonly url: string }> = [];
  for (const page of managementPages) {
    const result = await recoverFromManagementPage({
      page,
      input: options.input,
      pages: options.pages,
      submittedAt,
    });
    if (result.candidate !== null) {
      recovered.push(result.candidate);
      continue;
    }
    lastSignal = result.signal;
    lastPublisherReasonCode = result.publisherReasonCode;
    // Soft-skip empty management tabs; hard-fail only after all pages are tried.
    if (
      result.signal === "management-challenge-detected" ||
      result.signal === "management-candidate-pending-review" ||
      result.signal === "management-candidate-not-unique" ||
      result.signal === "management-detail-not-unique"
    ) {
      // Keep searching other management tabs unless this is the only page.
      if (managementPages.length === 1) return result;
    }
  }
  const unique = uniqueCandidate(recovered);
  if (unique !== null) return { candidate: unique, signal: null };
  if (recovered.length > 1) {
    return { candidate: null, signal: "management-detail-not-unique" };
  }
  return {
    candidate: null,
    signal: lastSignal,
    ...(lastPublisherReasonCode === undefined
      ? {}
      : { publisherReasonCode: lastPublisherReasonCode }),
  };
}

function publicArticleCandidate(
  value: string,
): { readonly id: string; readonly url: string } | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (host !== "ctrip.com" && !host.endsWith(".ctrip.com")) ||
      host === "we.ctrip.com" ||
      url.pathname !== "/webapp/you/community/detail"
    ) {
      return null;
    }
    const articleIds = url.searchParams.getAll("articleId");
    if (articleIds.length !== 1 || !/^\d{1,20}$/u.test(articleIds[0] ?? "")) return null;
    return { id: articleIds[0] as string, url: publicCtripUrl(value)?.toString() ?? value };
  } catch {
    return null;
  }
}

async function internalDetailStatus(
  page: NavigableCtripPage,
): Promise<"published" | "pending" | "rejected" | null> {
  if (!isInternalDetailPage(page)) return null;
  const text = normalizedText(
    await page.locator(PAGE_BODY_SELECTOR).first().textContent({ timeout: READ_TIMEOUT_MS }),
  );
  if (/(?:审核未通过|审核不通过|未通过)/u.test(text)) return "rejected";
  if (/已发布/u.test(text)) return "published";
  if (/待审核/u.test(text)) return "pending";
  return null;
}

async function hasChallenge(page: NavigableCtripPage): Promise<boolean> {
  for (const selector of CHALLENGE_SELECTORS) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 10);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: READ_TIMEOUT_MS })) return true;
    }
  }
  return false;
}

async function restoreManagementPage(page: NavigableCtripPage): Promise<string | null> {
  if (!isInternalDetailPage(page)) return null;
  if (page.goto === undefined) return "management-restore-unavailable";
  try {
    await page.goto(INTERNAL_MANAGEMENT_URL, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState?.("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS });
  } catch {
    return "management-restore-failed";
  }
  try {
    const restored = new URL(page.url());
    return restored.origin === INTERNAL_ORIGIN && restored.pathname === INTERNAL_MANAGEMENT_PATH
      ? null
      : "management-restore-mismatch";
  } catch {
    return "management-restore-mismatch";
  }
}

export function createPlaywrightCtripPublicReadbackWriter(options: {
  readonly pages: () => readonly NavigableCtripPage[];
  readonly openPage?: (url: string) => Promise<NavigableCtripPage>;
}): CtripPublicReadbackWriter {
  return Object.freeze({
    readback: async (input: CtripPublicReadbackInput): Promise<CtripPublicReadbackResult> => {
      const pages = options.pages();
      let candidate =
        input.candidateExternalUrl === null ? null : publicCtripUrl(input.candidateExternalUrl);
      let candidateId = input.candidateExternalId;
      if (candidateId !== null && !/^\d{1,20}$/u.test(candidateId)) {
        return unavailable("candidate-external-id-invalid");
      }
      const suppliedUrlCandidate =
        input.candidateExternalUrl === null
          ? null
          : publicArticleCandidate(input.candidateExternalUrl);
      if (input.candidateExternalUrl !== null && suppliedUrlCandidate === null) {
        return unavailable("candidate-public-url-missing");
      }
      if (
        candidateId !== null &&
        suppliedUrlCandidate !== null &&
        suppliedUrlCandidate.id !== candidateId
      ) {
        return unavailable("candidate-identity-mismatch");
      }
      candidateId ??= suppliedUrlCandidate?.id ?? null;
      if (candidate === null && candidateId !== null) {
        candidate = publicCtripUrl(publicCandidateFromId(candidateId).url);
      }
      if (candidate === null || candidateId === null) {
        const recovery = await recoverManagementCandidate({
          input,
          pages: options.pages,
          ...(options.openPage === undefined ? {} : { openPage: options.openPage }),
        });
        if (recovery.candidate === null) {
          if (recovery.signal.startsWith("management-candidate-rejected")) {
            return {
              outcome: "publisher_rejected",
              publisherReasonCode: recovery.publisherReasonCode ?? "publisher.rejected.other",
              externalId: null,
              externalUrl: null,
              observedTitle: "",
              observedBody: "",
              signal: recovery.signal,
            };
          }
          return unavailable(recovery.signal);
        }
        candidate = publicCtripUrl(recovery.candidate.url);
        candidateId = recovery.candidate.id;
      }
      if (candidate === null || candidateId === null) {
        return unavailable("candidate-public-url-missing");
      }
      for (const detailPage of pages) {
        if (internalDetailCandidate(detailPage.url())?.id !== candidateId) continue;
        if ((await internalDetailStatus(detailPage)) === "rejected") {
          return {
            outcome: "publisher_rejected",
            publisherReasonCode: "publisher.rejected.other",
            externalId: null,
            externalUrl: null,
            observedTitle: "",
            observedBody: "",
            signal: "ctrip-detail-rejected",
          };
        }
      }
      let page = pages.find(
        (candidatePage) => publicCtripUrl(candidatePage.url())?.toString() === candidate.toString(),
      );
      if (page === undefined && options.openPage !== undefined) {
        try {
          page = await options.openPage(candidate.toString());
        } catch {
          return unavailable("public-navigation-failed");
        }
      }
      page ??= pages[0];
      if (page === undefined) {
        return {
          outcome: "unavailable",
          externalId: null,
          externalUrl: null,
          observedTitle: "",
          observedBody: "",
          signal: "browser-page-missing",
        };
      }
      if (publicCtripUrl(page.url())?.toString() !== candidate.toString()) {
        if (page.goto === undefined) {
          return {
            outcome: "unavailable",
            externalId: null,
            externalUrl: null,
            observedTitle: "",
            observedBody: "",
            signal: "public-navigation-unavailable",
          };
        }
        try {
          await page.goto(candidate.toString(), {
            timeout: NAVIGATION_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
          });
          await page.waitForLoadState?.("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS });
        } catch {
          return {
            outcome: "unavailable",
            externalId: null,
            externalUrl: null,
            observedTitle: "",
            observedBody: "",
            signal: "public-navigation-failed",
          };
        }
      }

      const finalCandidate = publicArticleCandidate(page.url());
      const finalUrl = finalCandidate === null ? null : publicCtripUrl(finalCandidate.url);
      if (finalUrl === null || finalCandidate?.id !== candidateId) {
        return {
          outcome: "unavailable",
          externalId: null,
          externalUrl: null,
          observedTitle: "",
          observedBody: "",
          signal: finalUrl === null ? "public-url-invalid" : "public-candidate-identity-mismatch",
        };
      }

      const observedTitle = await readFirstNonEmptyText(page, TITLE_SELECTORS);
      const observedBody = await readFirstNonEmptyText(page, BODY_SELECTORS);
      if (/(?:内容不存在|内容已删除|页面不存在|404)/u.test(`${observedTitle} ${observedBody}`)) {
        return {
          outcome: "not_found",
          externalId: null,
          externalUrl: null,
          observedTitle,
          observedBody,
          signal: "public-content-not-found",
        };
      }
      const expectedTitle = normalizedText(input.expectedTitle);
      const expectedBody = normalizedText(input.expectedBody);
      const matches =
        observedTitle === expectedTitle && expectedBody.length > 0 && observedBody === expectedBody;
      if (matches) await page.close?.().catch(() => undefined);
      return {
        outcome: matches ? "confirmed" : "mismatch",
        externalId: matches ? candidateId : null,
        externalUrl: matches ? finalUrl.toString() : null,
        observedTitle,
        observedBody,
        signal: matches ? "public-payload-matched" : "public-payload-mismatch",
      };
    },
  });
}
