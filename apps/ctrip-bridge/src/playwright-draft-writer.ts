import type {
  CtripDraftSaveResult,
  CtripDraftSurfaceState,
  CtripDraftWriter,
  CtripDraftWriterFile,
} from "./browser-draft-adapter.js";
import {
  CTRIP_ACTION_SELECTOR,
  CTRIP_BODY_EDITOR_SELECTOR,
  CTRIP_DRAFT_ACTION_LABEL,
  CTRIP_EDITOR_ORIGIN,
  CTRIP_EDITOR_PATH,
  CTRIP_IMAGE_INPUT_SELECTOR,
  CTRIP_PUBLISH_ACTION_LABEL,
  CTRIP_TITLE_EDITOR_SELECTOR,
  CTRIP_UPLOAD_ACTION_LABEL,
} from "./editor-surface-contract.js";
import {
  CTRIP_LOCATION_KEYWORD_COVERAGE_THRESHOLD,
  ctripLocationKeywordCoverage,
} from "./ctrip-location-match.js";

export interface PlaywrightCtripDraftLocator {
  count(): Promise<number>;
  nth(index: number): PlaywrightCtripDraftLocator;
  first(): PlaywrightCtripDraftLocator;
  isVisible(options?: { readonly timeout?: number }): Promise<boolean>;
  isEnabled?(options?: { readonly timeout?: number }): Promise<boolean>;
  innerText?(options?: { readonly timeout?: number }): Promise<string>;
  hover(options?: { readonly timeout?: number }): Promise<void>;
  fill(value: string, options?: { readonly timeout?: number }): Promise<void>;
  textContent(options?: { readonly timeout?: number }): Promise<string | null>;
  click(options?: { readonly timeout?: number }): Promise<void>;
  setInputFiles(
    file: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer },
    options?: { readonly timeout?: number },
  ): Promise<void>;
}

export interface PlaywrightCtripDraftResponse {
  url(): string;
  json(): Promise<unknown>;
}

export interface PlaywrightCtripDraftPage {
  url(): string;
  locator(selector: string): PlaywrightCtripDraftLocator;
  bringToFront(): Promise<void>;
  goto?(
    url: string,
    options?: { readonly timeout?: number; readonly waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  waitForLoadState?(
    state?: "domcontentloaded",
    options?: { readonly timeout?: number },
  ): Promise<void>;
  waitForResponse?(
    predicate: (response: PlaywrightCtripDraftResponse) => boolean,
    options?: { readonly timeout?: number },
  ): Promise<PlaywrightCtripDraftResponse>;
  close?(): Promise<void>;
}

const READ_TIMEOUT_MS = 1_000;
const ACTION_TIMEOUT_MS = 10_000;
const CONTROL_STABILITY_ATTEMPTS = 8;
const CONTROL_STABILITY_POLL_MS = 250;
const CONTROL_STABILITY_REQUIRED_POLLS = 2;
const EDITOR_READBACK_ATTEMPTS = 20;
const EDITOR_READBACK_POLL_MS = 100;
const SAVE_CONFIRMATION_ATTEMPTS = 80;
const SAVE_CONFIRMATION_POLL_MS = 250;
// Ctrip's saved-draft detail route can take more than 90 seconds to hydrate.
// Keep the recovery window below the five-minute preparation lease.
const RESUME_CONFIRMATION_ATTEMPTS = 900;
const RESUME_CONFIRMATION_POLL_MS = 250;
const RESUME_EDIT_RETRY_INTERVAL_ATTEMPTS = 40;
const RESUME_EDIT_MAX_RETRIES = 2;
const RESUME_DIRECT_NAVIGATION_ATTEMPT = 120;
const RESUME_NAVIGATION_TIMEOUT_MS = 30_000;
const MANAGEMENT_HYDRATION_ATTEMPTS = 120;
const TARGET_HYDRATION_ATTEMPTS = 120;
const UPLOAD_STABILITY_ATTEMPTS = 40;
const UPLOAD_STABILITY_POLL_MS = 250;
const UPLOAD_STABILITY_REQUIRED_POLLS = 2;
const UPLOAD_PERSISTENCE_SETTLE_MS = 5_000;
const IMAGE_CLEAR_ATTEMPTS = 20;
const IMAGE_CLEAR_POLL_MS = 100;
const IMAGE_CLEAR_ACTION_ATTEMPTS = 2;
const LOCATION_SEARCH_ATTEMPTS = 40;
const LOCATION_SEARCH_POLL_MS = 250;
const LOCATION_CLEAR_ATTEMPTS = 40;
const DRAFT_SAVE_RECENCY_MINUTES = 2;
const DRAFT_MANAGEMENT_PATH = "/publish/contentManagement";
const DRAFT_DETAIL_PATH = "/publish/detail";
const LOCATION_CONTROL_SELECTOR =
  ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search";
// Ctrip's Ant Design control renders the search input as readonly while the
// dropdown is closed. Once opened, the actual editable input can be portaled
// under the document body, so scope the first lookup to the control and fall
// back to the active combobox portal.
const LOCATION_INPUT_SELECTOR = `${LOCATION_CONTROL_SELECTOR} input.ant-select-selection-search-input`;
const LOCATION_PORTAL_INPUT_SELECTOR =
  'input.ant-select-selection-search-input[role="combobox"]:not([disabled]):not([readonly])';
const LOCATION_SELECTED_SELECTOR = `${LOCATION_CONTROL_SELECTOR} .ant-select-selection-item`;
const LOCATION_REMOVE_SELECTOR = `${LOCATION_CONTROL_SELECTOR} .ant-select-selection-item-remove`;
const LOCATION_OPTION_SELECTOR = ".search-input-detail .item-c";
const DRAFT_DETAIL_TITLE_SELECTOR = ".article-bg .article-title";
const DRAFT_DETAIL_BODY_SELECTOR = ".article-bg .content";
const DRAFT_DETAIL_STATUS_SELECTOR = ".article-bg .status";
const DRAFT_DETAIL_EDIT_SELECTOR = ".head .button-bg.button-blue";
const UPLOAD_ITEM_SELECTORS = Object.freeze([
  '[class~="ant-upload-list-picture-card-container"]',
  '[class~="r-d-upload-image-container-done"]',
]);
const UPLOAD_ITEM_SELECTOR = UPLOAD_ITEM_SELECTORS.join(", ");
const UPLOAD_DELETE_SELECTORS = Object.freeze([
  '[class~="r-d-upload-image-delete"]',
  '[class~="anticon-delete"]',
  '[aria-label="删除"]',
  '[title="删除"]',
]);
const UPLOAD_DELETE_SELECTOR = UPLOAD_ITEM_SELECTORS.flatMap((itemSelector) =>
  UPLOAD_DELETE_SELECTORS.map((deleteSelector) => `${itemSelector} ${deleteSelector}`),
).join(", ");
const SAVE_RESULT_SELECTOR = '[role="alert"], .ant-message-notice-content';
const DRAFT_MANAGEMENT_ROW_SELECTOR = ".c-m-c-container";
const IMAGE_DELETE_CONFIRM_SELECTOR = ".ant-modal-confirm-confirm";
const IMAGE_DELETE_CONFIRM_BUTTON_SELECTOR = ".ant-modal-confirm-confirm button";
const CHALLENGE_SELECTORS = Object.freeze([
  '[data-testid="captcha"]',
  '[class*="captcha"]',
  ".nc-container",
]);

function normalizedText(value: string | null): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function readableVisibleText(locator: PlaywrightCtripDraftLocator): Promise<string | null> {
  try {
    if (!(await locator.isVisible({ timeout: READ_TIMEOUT_MS }))) return null;
    return normalizedText(await locator.textContent({ timeout: READ_TIMEOUT_MS }));
  } catch (error) {
    if (isTimeoutError(error)) return null;
    throw error;
  }
}

function whitespaceInsensitiveText(value: string | null): string {
  return normalizedText(value).replace(/\s+/gu, "");
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

function containsRecentCtripTimestamp(text: string, savedAt: Date): boolean {
  const minute = 60_000;
  for (
    let offset = -DRAFT_SAVE_RECENCY_MINUTES;
    offset <= DRAFT_SAVE_RECENCY_MINUTES;
    offset += 1
  ) {
    if (text.includes(ctripTimestamp(new Date(savedAt.getTime() + offset * minute)).slice(0, 16))) {
      return true;
    }
  }
  return false;
}

function isTargetPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === CTRIP_EDITOR_ORIGIN && url.pathname === CTRIP_EDITOR_PATH;
  } catch {
    return false;
  }
}

function isDraftManagementPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === CTRIP_EDITOR_ORIGIN && url.pathname === DRAFT_MANAGEMENT_PATH;
  } catch {
    return false;
  }
}

function isDraftDetailPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    const keys = [...url.searchParams.keys()];
    return (
      url.origin === CTRIP_EDITOR_ORIGIN &&
      url.pathname === DRAFT_DETAIL_PATH &&
      url.searchParams.getAll("articleId").length === 1 &&
      /^\d{1,20}$/u.test(url.searchParams.get("articleId") ?? "") &&
      url.searchParams.getAll("articleType").length === 1 &&
      url.searchParams.get("articleType") === "1" &&
      keys.length === 2 &&
      keys.every((key) => key === "articleId" || key === "articleType")
    );
  } catch {
    return false;
  }
}

function draftEditorUrlFromDetail(page: PlaywrightCtripDraftPage): string | null {
  if (!isDraftDetailPage(page)) return null;
  const detail = new URL(page.url());
  const articleId = detail.searchParams.get("articleId");
  if (articleId === null) return null;
  const editor = new URL(CTRIP_EDITOR_PATH, CTRIP_EDITOR_ORIGIN);
  editor.searchParams.set("articleId", articleId);
  editor.searchParams.set("articleStatus", "DRAFT");
  return editor.toString();
}

async function matchingDraftRows(
  page: PlaywrightCtripDraftPage,
  expectedTitle: string,
  savedAt?: Date,
): Promise<number> {
  const rows = page.locator(DRAFT_MANAGEMENT_ROW_SELECTOR);
  const count = Math.min(await rows.count(), 100);
  let matches = 0;
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    const text = normalizedText(await row.textContent({ timeout: READ_TIMEOUT_MS }));
    if (
      text.startsWith(expectedTitle) &&
      text.includes("草稿") &&
      (savedAt === undefined || containsRecentCtripTimestamp(text, savedAt))
    ) {
      matches += 1;
    }
  }
  return matches;
}

async function uniqueMatchingDraftRow(
  page: PlaywrightCtripDraftPage,
  expectedTitle: string,
  savedAt?: Date,
): Promise<PlaywrightCtripDraftLocator | null> {
  const rows = page.locator(DRAFT_MANAGEMENT_ROW_SELECTOR);
  const count = Math.min(await rows.count(), 100);
  let match: PlaywrightCtripDraftLocator | undefined;
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    const text = normalizedText(await row.textContent({ timeout: READ_TIMEOUT_MS }));
    if (
      !text.startsWith(expectedTitle) ||
      !text.includes("草稿") ||
      (savedAt !== undefined && !containsRecentCtripTimestamp(text, savedAt))
    ) {
      continue;
    }
    if (match !== undefined) return null;
    match = row;
  }
  return match ?? null;
}

async function visibleCount(locator: PlaywrightCtripDraftLocator): Promise<number> {
  const count = Math.min(await locator.count(), 50);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible({ timeout: READ_TIMEOUT_MS })) visible += 1;
  }
  return visible;
}

async function editorText(locator: PlaywrightCtripDraftLocator): Promise<string> {
  return locator.innerText !== undefined
    ? locator.innerText({ timeout: READ_TIMEOUT_MS })
    : ((await locator.textContent({ timeout: READ_TIMEOUT_MS })) ?? "");
}

async function uniqueVisibleText(
  page: PlaywrightCtripDraftPage,
  selector: string,
): Promise<{ readonly count: number; readonly text: string }> {
  const locator = page.locator(selector);
  const count = Math.min(await locator.count(), 20);
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible({ timeout: READ_TIMEOUT_MS })) {
      values.push(normalizedText(await item.textContent({ timeout: READ_TIMEOUT_MS })));
    }
  }
  return { count: values.length, text: values.length === 1 ? (values[0] ?? "") : "" };
}

async function uniqueDraftDetailEdit(
  page: PlaywrightCtripDraftPage,
): Promise<PlaywrightCtripDraftLocator | null> {
  const locator = page.locator(DRAFT_DETAIL_EDIT_SELECTOR);
  const count = Math.min(await locator.count(), 20);
  let match: PlaywrightCtripDraftLocator | null = null;
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (
      (await item.isVisible({ timeout: READ_TIMEOUT_MS })) &&
      normalizedText(await item.textContent({ timeout: READ_TIMEOUT_MS })) === "编辑"
    ) {
      if (match !== null) return null;
      match = item;
    }
  }
  return match;
}

async function draftDetailEvidence(
  page: PlaywrightCtripDraftPage,
  expectedTitle: string,
  expectedBody?: string,
): Promise<"confirmed" | "pending" | "mismatch"> {
  if (!isDraftDetailPage(page)) return "mismatch";
  const [title, body, status, edit] = await Promise.all([
    uniqueVisibleText(page, DRAFT_DETAIL_TITLE_SELECTOR),
    expectedBody === undefined
      ? Promise.resolve({ count: 1, text: "" })
      : uniqueVisibleText(page, DRAFT_DETAIL_BODY_SELECTOR),
    uniqueVisibleText(page, DRAFT_DETAIL_STATUS_SELECTOR),
    uniqueDraftDetailEdit(page),
  ]);
  if (
    title.count === 0 ||
    status.count === 0 ||
    edit === null ||
    (expectedBody !== undefined && body.count === 0) ||
    title.text.length === 0 ||
    status.text.length === 0 ||
    (expectedBody !== undefined && body.text.length === 0)
  ) {
    return "pending";
  }
  if (
    title.count !== 1 ||
    body.count !== 1 ||
    status.count !== 1 ||
    edit === null ||
    title.text !== normalizedText(expectedTitle) ||
    status.text !== "草稿" ||
    (expectedBody !== undefined &&
      whitespaceInsensitiveText(body.text) !== whitespaceInsensitiveText(expectedBody))
  ) {
    return "mismatch";
  }
  return "confirmed";
}

async function exactButtonCount(page: PlaywrightCtripDraftPage, label: string): Promise<number> {
  const locator = page.locator(CTRIP_ACTION_SELECTOR);
  const count = Math.min(await locator.count(), 50);
  let matches = 0;
  for (let index = 0; index < count; index += 1) {
    const button = locator.nth(index);
    if ((await readableVisibleText(button)) === label) matches += 1;
  }
  return matches;
}

async function exactButton(
  page: PlaywrightCtripDraftPage,
  label: string,
): Promise<PlaywrightCtripDraftLocator> {
  const locator = page.locator(CTRIP_ACTION_SELECTOR);
  const count = Math.min(await locator.count(), 50);
  let match: PlaywrightCtripDraftLocator | undefined;
  for (let index = 0; index < count; index += 1) {
    const button = locator.nth(index);
    if ((await readableVisibleText(button)) === label) {
      if (match !== undefined) throw new Error(`Ctrip draft action ${label} is duplicated`);
      match = button;
    }
  }
  if (match === undefined) throw new Error(`Ctrip draft action ${label} is missing`);
  if (match.isEnabled !== undefined && !(await match.isEnabled({ timeout: READ_TIMEOUT_MS }))) {
    throw new Error(`Ctrip draft action ${label} is disabled`);
  }
  return match;
}

function selectedPage(pages: readonly PlaywrightCtripDraftPage[]): PlaywrightCtripDraftPage {
  const matches = pages.filter(isTargetPage);
  if (matches.length !== 1) throw new Error("Ctrip picture-text target page is not unique");
  return matches[0] as PlaywrightCtripDraftPage;
}

async function editorSurfaceState(
  page: PlaywrightCtripDraftPage,
): Promise<Omit<CtripDraftSurfaceState, "status" | "targetPageCount" | "challengeSignals">> {
  return {
    titleEditorCount: await visibleCount(page.locator(CTRIP_TITLE_EDITOR_SELECTOR)),
    bodyEditorCount: await visibleCount(page.locator(CTRIP_BODY_EDITOR_SELECTOR)),
    imageInputCount: Math.min(await page.locator(CTRIP_IMAGE_INPUT_SELECTOR).count(), 10),
    uploadActionCount: await exactButtonCount(page, CTRIP_UPLOAD_ACTION_LABEL),
    draftActionCount: await exactButtonCount(page, CTRIP_DRAFT_ACTION_LABEL),
    publishActionCount: await exactButtonCount(page, CTRIP_PUBLISH_ACTION_LABEL),
  };
}

function editorSurfaceIsStable(
  state: Omit<CtripDraftSurfaceState, "status" | "targetPageCount" | "challengeSignals">,
): boolean {
  return Object.values(state).every((count) => count === 1);
}

async function requireStableEditorSurface(
  page: PlaywrightCtripDraftPage,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let stablePolls = 0;
  for (let attempt = 0; attempt < CONTROL_STABILITY_ATTEMPTS; attempt += 1) {
    const stable = isTargetPage(page) && editorSurfaceIsStable(await editorSurfaceState(page));
    stablePolls = stable ? stablePolls + 1 : 0;
    if (stablePolls >= CONTROL_STABILITY_REQUIRED_POLLS) return;
    if (attempt < CONTROL_STABILITY_ATTEMPTS - 1) await wait(CONTROL_STABILITY_POLL_MS);
  }
  throw new Error("Ctrip picture-text editor controls are not stable");
}

async function readEditorTextAfterFill(
  page: PlaywrightCtripDraftPage,
  selector: string,
  expected: string,
  wait: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const normalizedExpected = normalizedText(expected);
  let observed = "";
  for (let attempt = 0; attempt < EDITOR_READBACK_ATTEMPTS; attempt += 1) {
    const locator = page.locator(selector);
    if ((await visibleCount(locator)) === 1) {
      observed = await editorText(locator.first());
      if (normalizedText(observed) === normalizedExpected) return observed;
    }
    if (attempt < EDITOR_READBACK_ATTEMPTS - 1) await wait(EDITOR_READBACK_POLL_MS);
  }
  return observed;
}

function draftSaveToastOutcome(signal: string): "confirmed" | "rejected" | "pending" {
  const compact = normalizedText(signal).replace(/\s+/gu, "");
  if (/(?:草稿保存成功|保存草稿成功|草稿已保存|已保存(?:至|到)?草稿|保存成功)/u.test(compact)) {
    return "confirmed";
  }
  if (
    /(?:禁言|封禁|禁止发言|违规|受限|失败|未保存|保存异常|系统错误|网络异常|请重试|操作频繁|未成功|不通过)/u.test(
      compact,
    )
  ) {
    return "rejected";
  }
  return "pending";
}

function draftSaveRejectionSignal(signal: string): string {
  const compact = normalizedText(signal).replace(/\s+/gu, "");
  if (/禁言|封禁|禁止发言/u.test(compact)) return "draft-save-account-muted";
  return compact;
}

export function createPlaywrightCtripDraftWriter(options: {
  readonly pages: () => readonly PlaywrightCtripDraftPage[];
  readonly openPage?: (url: string) => Promise<PlaywrightCtripDraftPage>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}): CtripDraftWriter {
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  let lastSaveAttempt: { readonly title: string; readonly startedAt: Date } | null = null;
  const inspect = async (): Promise<CtripDraftSurfaceState> => {
    const pages = options.pages();
    const targetPages = pages.filter(isTargetPage);
    if (targetPages.length === 0) {
      return {
        status: "session_required",
        targetPageCount: 0,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        imageInputCount: 0,
        uploadActionCount: 0,
        draftActionCount: 0,
        publishActionCount: 0,
        challengeSignals: [],
      };
    }
    if (targetPages.length !== 1) {
      return {
        status: "adapter_drift",
        targetPageCount: targetPages.length,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        imageInputCount: 0,
        uploadActionCount: 0,
        draftActionCount: 0,
        publishActionCount: 0,
        challengeSignals: ["duplicate-target-page"],
      };
    }
    const page = targetPages[0] as PlaywrightCtripDraftPage;
    await page.bringToFront();
    const challengeSignals: string[] = [];
    for (const [index, selector] of CHALLENGE_SELECTORS.entries()) {
      if ((await visibleCount(page.locator(selector))) > 0)
        challengeSignals.push(`challenge-${index}`);
    }
    const controls = await editorSurfaceState(page);
    const state: CtripDraftSurfaceState = {
      status:
        challengeSignals.length > 0
          ? "challenge_required"
          : editorSurfaceIsStable(controls)
            ? "ready"
            : "adapter_drift",
      targetPageCount: 1,
      ...controls,
      challengeSignals,
    };
    return state;
  };

  const waitForStableTargetPage = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < TARGET_HYDRATION_ATTEMPTS; attempt += 1) {
      const targets = options.pages().filter(isTargetPage);
      if (targets.length !== 1) return false;
      const target = targets[0] as PlaywrightCtripDraftPage;
      await target.bringToFront();
      if (editorSurfaceIsStable(await editorSurfaceState(target))) return true;
      if (attempt < TARGET_HYDRATION_ATTEMPTS - 1) {
        await wait(RESUME_CONFIRMATION_POLL_MS);
      }
    }
    return false;
  };

  const writer: CtripDraftWriter = {
    inspect,
    ensureTargetPage: async (): Promise<boolean> => {
      const currentTargets = options.pages().filter(isTargetPage);
      if (currentTargets.length > 1) return false;

      if (currentTargets.length === 0) {
        const management = options.pages().find(isDraftManagementPage);
        const page =
          management ??
          (options.openPage === undefined
            ? undefined
            : await options.openPage(new URL(CTRIP_EDITOR_PATH, CTRIP_EDITOR_ORIGIN).toString()));
        if (page === undefined) return false;
        await page.bringToFront();
        if (!isTargetPage(page)) {
          if (page.goto === undefined) return false;
          await page.goto(new URL(CTRIP_EDITOR_PATH, CTRIP_EDITOR_ORIGIN).toString(), {
            timeout: RESUME_NAVIGATION_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
          });
          await page.waitForLoadState?.("domcontentloaded", {
            timeout: RESUME_NAVIGATION_TIMEOUT_MS,
          });
        }
      }
      return waitForStableTargetPage();
    },
    fillTitle: async (value) => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      await requireStableEditorSurface(page, wait);
      const locator = page.locator(CTRIP_TITLE_EDITOR_SELECTOR).first();
      await locator.fill("", { timeout: ACTION_TIMEOUT_MS });
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
      return normalizedText(
        await readEditorTextAfterFill(page, CTRIP_TITLE_EDITOR_SELECTOR, value, wait),
      );
    },
    fillBody: async (value) => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      await requireStableEditorSurface(page, wait);
      const locator = page.locator(CTRIP_BODY_EDITOR_SELECTOR).first();
      await locator.fill("", { timeout: ACTION_TIMEOUT_MS });
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
      return readEditorTextAfterFill(page, CTRIP_BODY_EDITOR_SELECTOR, value, wait);
    },
    fillLocation: async (query) => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      const control = page.locator(LOCATION_CONTROL_SELECTOR);
      if ((await visibleCount(control)) !== 1) {
        throw new Error("Ctrip location control is not unique");
      }
      const removals = page.locator(LOCATION_REMOVE_SELECTOR);
      let removeCount = Math.min(await removals.count(), 10);
      for (let attempt = 0; attempt < LOCATION_CLEAR_ATTEMPTS && removeCount > 0; attempt += 1) {
        const previousCount = removeCount;
        await removals.first().click({ timeout: ACTION_TIMEOUT_MS });
        removeCount = Math.min(await removals.count(), 10);
        if (removeCount >= previousCount && attempt < LOCATION_CLEAR_ATTEMPTS - 1) {
          await wait(LOCATION_SEARCH_POLL_MS);
          removeCount = Math.min(await removals.count(), 10);
        }
      }
      if (removeCount > 0) {
        throw new Error("Ctrip location control could not clear existing POI");
      }
      await control.first().click({ timeout: ACTION_TIMEOUT_MS });
      // Prefer the active portal input. The control-local input remains
      // visible but readonly after opening, which made the previous writer
      // report a false location-readback drift.
      let input: PlaywrightCtripDraftLocator;
      try {
        input = page.locator(LOCATION_PORTAL_INPUT_SELECTOR);
        if ((await visibleCount(input)) !== 1) {
          input = page.locator(LOCATION_INPUT_SELECTOR);
        }
      } catch {
        // Keep compatibility with older page bindings that only expose the
        // control-local selector.
        input = page.locator(LOCATION_INPUT_SELECTOR);
      }
      if ((await visibleCount(input)) !== 1) {
        throw new Error("Ctrip location search input is not unique");
      }
      try {
        await input.first().fill(query, { timeout: ACTION_TIMEOUT_MS });
      } catch (error) {
        // Some builds keep the input readonly until the control receives a
        // keyboard event. A direct value fill is still safe after the dropdown
        // has been opened and avoids treating a transient portal state as
        // adapter drift.
        if (input.first().click !== undefined) {
          await input
            .first()
            .click({ timeout: ACTION_TIMEOUT_MS })
            .catch(() => undefined);
        }
        await input
          .first()
          .fill(query, { timeout: ACTION_TIMEOUT_MS })
          .catch(() => {
            throw error;
          });
      }
      let option: PlaywrightCtripDraftLocator | null = null;
      let bestScore = 0;
      for (let attempt = 0; attempt < LOCATION_SEARCH_ATTEMPTS; attempt += 1) {
        await wait(LOCATION_SEARCH_POLL_MS);
        const options = page.locator(LOCATION_OPTION_SELECTOR);
        const count = Math.min(await options.count(), 50);
        for (let index = 0; index < count; index += 1) {
          const candidate = options.nth(index);
          if (!(await candidate.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
          const label = normalizedText(await candidate.textContent({ timeout: READ_TIMEOUT_MS }));
          const score = ctripLocationKeywordCoverage(label, query);
          if (score > bestScore) {
            bestScore = score;
            option = candidate;
          }
          if (score >= 1) break;
        }
        if (option !== null && bestScore >= 1) {
          break;
        }
      }
      if (option === null || bestScore < CTRIP_LOCATION_KEYWORD_COVERAGE_THRESHOLD) {
        return "";
      }
      await option.click({ timeout: ACTION_TIMEOUT_MS });
      for (let attempt = 0; attempt < LOCATION_SEARCH_ATTEMPTS; attempt += 1) {
        await wait(LOCATION_SEARCH_POLL_MS);
        const selected = page.locator(LOCATION_SELECTED_SELECTOR);
        if ((await visibleCount(selected)) === 1) {
          return normalizedText(await selected.first().textContent({ timeout: READ_TIMEOUT_MS }));
        }
      }
      return "";
    },
    readLocation: async () => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      const selected = page.locator(LOCATION_SELECTED_SELECTOR);
      for (let attempt = 0; attempt < LOCATION_SEARCH_ATTEMPTS; attempt += 1) {
        if ((await visibleCount(selected)) === 1) {
          return normalizedText(await selected.first().textContent({ timeout: READ_TIMEOUT_MS }));
        }
        if (attempt < LOCATION_SEARCH_ATTEMPTS - 1) await wait(LOCATION_SEARCH_POLL_MS);
      }
      return "";
    },
    uploadImage: async (file: CtripDraftWriterFile) => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      await requireStableEditorSurface(page, wait);
      const items = page.locator(UPLOAD_ITEM_SELECTOR);
      const before = Math.min(await items.count(), 50);
      await page
        .locator(CTRIP_IMAGE_INPUT_SELECTOR)
        .first()
        .setInputFiles(
          { name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.bytes) },
          { timeout: ACTION_TIMEOUT_MS },
        );
      let stablePolls = 0;
      let uploaded = before;
      for (let attempt = 0; attempt < UPLOAD_STABILITY_ATTEMPTS; attempt += 1) {
        await wait(UPLOAD_STABILITY_POLL_MS);
        uploaded = Math.min(await items.count(), 50);
        stablePolls = uploaded === before + 1 ? stablePolls + 1 : 0;
        if (stablePolls >= UPLOAD_STABILITY_REQUIRED_POLLS) {
          await wait(UPLOAD_PERSISTENCE_SETTLE_MS);
          const settled = Math.min(await items.count(), 50);
          if (settled !== before + 1) return settled;
          await requireStableEditorSurface(page, wait);
          return Math.min(await items.count(), 50);
        }
      }
      return uploaded;
    },
    countImages: async () => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      return Math.min(await page.locator(UPLOAD_ITEM_SELECTOR).count(), 50);
    },
    clearImages: async () => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      let remaining = Math.min(await page.locator(UPLOAD_ITEM_SELECTOR).count(), 50);
      while (remaining > 0) {
        let lastActionError: unknown;
        let progressed = false;
        for (
          let actionAttempt = 0;
          actionAttempt < IMAGE_CLEAR_ACTION_ATTEMPTS && !progressed;
          actionAttempt += 1
        ) {
          try {
            await page.locator(UPLOAD_ITEM_SELECTOR).first().hover({ timeout: ACTION_TIMEOUT_MS });
          } catch (error) {
            lastActionError = error;
            if (actionAttempt < IMAGE_CLEAR_ACTION_ATTEMPTS - 1) {
              await wait(IMAGE_CLEAR_POLL_MS);
              continue;
            }
            throw error;
          }

          const deleteControls = page.locator(UPLOAD_DELETE_SELECTOR);
          const visibleIndexes: number[] = [];
          const deleteCount = Math.min(await deleteControls.count(), 50);
          for (let index = 0; index < deleteCount; index += 1) {
            if (await deleteControls.nth(index).isVisible({ timeout: READ_TIMEOUT_MS })) {
              visibleIndexes.push(index);
            }
          }
          if (visibleIndexes.length !== 1) return remaining;
          try {
            await deleteControls
              .nth(visibleIndexes[0] as number)
              .click({ timeout: ACTION_TIMEOUT_MS });
          } catch (error) {
            lastActionError = error;
          }

          const confirmations = page.locator(IMAGE_DELETE_CONFIRM_SELECTOR);
          let visibleConfirmations: number[] = [];
          for (let attempt = 0; attempt < IMAGE_CLEAR_ATTEMPTS; attempt += 1) {
            const next = Math.min(await page.locator(UPLOAD_ITEM_SELECTOR).count(), 50);
            if (next < remaining) {
              remaining = next;
              progressed = true;
              break;
            }
            visibleConfirmations = [];
            const confirmationCount = Math.min(await confirmations.count(), 10);
            for (let index = 0; index < confirmationCount; index += 1) {
              if (await confirmations.nth(index).isVisible({ timeout: READ_TIMEOUT_MS })) {
                visibleConfirmations.push(index);
              }
            }
            if (visibleConfirmations.length > 0) break;
            if (attempt < IMAGE_CLEAR_ATTEMPTS - 1) await wait(IMAGE_CLEAR_POLL_MS);
          }
          if (progressed) break;
          if (visibleConfirmations.length > 1) return remaining;
          if (visibleConfirmations.length === 0) {
            if (actionAttempt < IMAGE_CLEAR_ACTION_ATTEMPTS - 1) {
              await wait(IMAGE_CLEAR_POLL_MS);
              continue;
            }
            if (lastActionError !== undefined) throw lastActionError;
            return remaining;
          }

          const confirmation = confirmations.nth(visibleConfirmations[0] as number);
          const confirmationText = normalizedText(
            await confirmation.textContent({ timeout: READ_TIMEOUT_MS }),
          ).replace(/\s+/gu, "");
          if (!/确定删除.*图片/u.test(confirmationText)) return remaining;
          const confirmationButtons = page.locator(IMAGE_DELETE_CONFIRM_BUTTON_SELECTOR);
          const visibleConfirmButtons: number[] = [];
          const confirmationButtonCount = Math.min(await confirmationButtons.count(), 10);
          for (let index = 0; index < confirmationButtonCount; index += 1) {
            const button = confirmationButtons.nth(index);
            if (
              (await button.isVisible({ timeout: READ_TIMEOUT_MS })) &&
              normalizedText(await button.textContent({ timeout: READ_TIMEOUT_MS })).replace(
                /\s+/gu,
                "",
              ) === "确定"
            ) {
              visibleConfirmButtons.push(index);
            }
          }
          if (visibleConfirmButtons.length !== 1) return remaining;

          for (
            let confirmAttempt = 0;
            confirmAttempt < IMAGE_CLEAR_ACTION_ATTEMPTS && !progressed;
            confirmAttempt += 1
          ) {
            try {
              await confirmationButtons
                .nth(visibleConfirmButtons[0] as number)
                .click({ timeout: ACTION_TIMEOUT_MS });
            } catch (error) {
              lastActionError = error;
            }
            for (let attempt = 0; attempt < IMAGE_CLEAR_ATTEMPTS; attempt += 1) {
              await wait(IMAGE_CLEAR_POLL_MS);
              const next = Math.min(await page.locator(UPLOAD_ITEM_SELECTOR).count(), 50);
              if (next < remaining) {
                remaining = next;
                progressed = true;
                break;
              }
            }
            if (!progressed && confirmAttempt < IMAGE_CLEAR_ACTION_ATTEMPTS - 1) {
              await wait(IMAGE_CLEAR_POLL_MS);
            }
          }
        }
        if (!progressed) {
          if (lastActionError !== undefined) throw lastActionError;
          return remaining;
        }
      }
      return 0;
    },
    saveDraft: async (): Promise<CtripDraftSaveResult> => {
      const page = selectedPage(options.pages());
      await page.bringToFront();
      await requireStableEditorSurface(page, wait);
      const expectedTitle = normalizedText(
        await editorText(page.locator(CTRIP_TITLE_EDITOR_SELECTOR).first()),
      );
      const expectedBody = normalizedText(
        await editorText(page.locator(CTRIP_BODY_EDITOR_SELECTOR).first()),
      );
      const saveStartedAt = now();
      lastSaveAttempt = { title: expectedTitle, startedAt: saveStartedAt };
      await (
        await exactButton(page, CTRIP_DRAFT_ACTION_LABEL)
      ).click({
        timeout: ACTION_TIMEOUT_MS,
      });
      for (let attempt = 0; attempt < SAVE_CONFIRMATION_ATTEMPTS; attempt += 1) {
        if (isDraftDetailPage(page)) {
          const evidence = await draftDetailEvidence(page, expectedTitle, expectedBody);
          if (evidence === "confirmed") {
            return { confirmed: true, signal: "draft-detail-confirmed" };
          }
          if (evidence === "mismatch") {
            return { confirmed: false, signal: "draft-detail-mismatch" };
          }
        } else if (isDraftManagementPage(page)) {
          const matches = await matchingDraftRows(page, expectedTitle, saveStartedAt);
          if (matches === 1) {
            return { confirmed: true, signal: "draft-management-confirmed" };
          }
          if (matches > 1) {
            return { confirmed: false, signal: "draft-management-duplicate" };
          }
        } else if (!isTargetPage(page)) {
          return { confirmed: false, signal: "draft-save-unexpected-navigation" };
        }
        const result = page.locator(SAVE_RESULT_SELECTOR).first();
        if (await result.isVisible({ timeout: READ_TIMEOUT_MS })) {
          const signal = normalizedText(await result.textContent({ timeout: READ_TIMEOUT_MS }));
          const outcome = draftSaveToastOutcome(signal);
          if (outcome === "confirmed") {
            return { confirmed: true, signal };
          }
          if (outcome === "rejected") {
            return { confirmed: false, signal: draftSaveRejectionSignal(signal) };
          }
        }
        await wait(SAVE_CONFIRMATION_POLL_MS);
      }
      return {
        confirmed: false,
        signal: isDraftDetailPage(page)
          ? "draft-detail-mismatch"
          : "draft-save-confirmation-missing",
      };
    },
    resumeDraft: async (expectedTitle): Promise<CtripDraftSaveResult> => {
      const pages = options.pages();
      const targets = pages.filter(isTargetPage);
      if (targets.length > 1) {
        return { confirmed: false, signal: "draft-editor-page-not-unique" };
      }
      const target = targets[0];
      if (target !== undefined) {
        await target.bringToFront();
        const currentTitle = normalizedText(
          await editorText(target.locator(CTRIP_TITLE_EDITOR_SELECTOR).first()),
        );
        if (currentTitle === normalizedText(expectedTitle)) {
          return { confirmed: true, signal: "draft-editor-retained" };
        }
        const currentBody = normalizedText(
          await editorText(target.locator(CTRIP_BODY_EDITOR_SELECTOR).first()),
        );
        const currentLocationCount = await visibleCount(target.locator(LOCATION_SELECTED_SELECTOR));
        const currentMediaCount = Math.min(await target.locator(UPLOAD_ITEM_SELECTOR).count(), 50);
        const blankNewEditor =
          currentTitle.length === 0 &&
          currentBody.length === 0 &&
          currentLocationCount === 0 &&
          currentMediaCount === 0;
        if (!blankNewEditor || target.goto === undefined) {
          return { confirmed: false, signal: "draft-editor-title-mismatch" };
        }
        await target.goto(new URL(DRAFT_MANAGEMENT_PATH, CTRIP_EDITOR_ORIGIN).toString(), {
          timeout: RESUME_NAVIGATION_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        await target.waitForLoadState?.("domcontentloaded", {
          timeout: RESUME_NAVIGATION_TIMEOUT_MS,
        });
      }
      const normalizedExpectedTitle = normalizedText(expectedTitle);
      const savedAt =
        lastSaveAttempt?.title === normalizedExpectedTitle ? lastSaveAttempt.startedAt : undefined;
      let matchingManagementPages: PlaywrightCtripDraftPage[] = [];
      for (let attempt = 0; attempt < MANAGEMENT_HYDRATION_ATTEMPTS; attempt += 1) {
        matchingManagementPages = [];
        for (const candidate of pages.filter(isDraftManagementPage)) {
          const matches = await matchingDraftRows(candidate, normalizedExpectedTitle, savedAt);
          if (matches > 1) {
            return { confirmed: false, signal: "draft-management-row-not-unique" };
          }
          if (matches === 1) matchingManagementPages.push(candidate as PlaywrightCtripDraftPage);
        }
        if (matchingManagementPages.length > 0) break;
        if (attempt < MANAGEMENT_HYDRATION_ATTEMPTS - 1) {
          await wait(RESUME_CONFIRMATION_POLL_MS);
        }
      }
      if (matchingManagementPages.length > 1) {
        return { confirmed: false, signal: "draft-management-page-not-unique" };
      }
      const managementPage = matchingManagementPages[0];
      if (managementPage !== undefined) {
        const row = await uniqueMatchingDraftRow(managementPage, normalizedExpectedTitle, savedAt);
        if (row === null) {
          return { confirmed: false, signal: "draft-management-row-not-unique" };
        }
        await row.click({ timeout: ACTION_TIMEOUT_MS });
        for (let attempt = 0; attempt < RESUME_CONFIRMATION_ATTEMPTS; attempt += 1) {
          // Clicking a management row may navigate the current tab or open a
          // fresh editor tab. Re-scan the live page set on every poll instead
          // of only inspecting the page that owned the row.
          const candidatePages = options.pages();
          const reopened = candidatePages.find(isTargetPage);
          if (reopened !== undefined) {
            await reopened.bringToFront();
            const currentTitle = normalizedText(
              await editorText(reopened.locator(CTRIP_TITLE_EDITOR_SELECTOR).first()),
            );
            if (currentTitle === normalizedExpectedTitle) {
              return { confirmed: true, signal: "draft-editor-reopened" };
            }
          }
          const detail = candidatePages.find(isDraftDetailPage);
          if (detail !== undefined && reopened === undefined) {
            return (
              (await writer.resumeDraft?.(expectedTitle)) ?? {
                confirmed: false,
                signal: "draft-detail-resume-unavailable",
              }
            );
          }
          await wait(RESUME_CONFIRMATION_POLL_MS);
        }
        return { confirmed: false, signal: "draft-editor-reopen-timeout" };
      }

      const detailPages = pages.filter(isDraftDetailPage);
      if (detailPages.length > 0) {
        let page: PlaywrightCtripDraftPage | undefined;
        for (let attempt = 0; attempt < RESUME_CONFIRMATION_ATTEMPTS; attempt += 1) {
          const evidence = await Promise.all(
            detailPages.map(async (candidate) => ({
              candidate,
              evidence: await draftDetailEvidence(candidate, expectedTitle),
            })),
          );
          const confirmed = evidence.filter((item) => item.evidence === "confirmed");
          if (confirmed.length > 1) {
            return { confirmed: false, signal: "draft-detail-page-not-unique" };
          }
          const pending = evidence.some((item) => item.evidence === "pending");
          if (confirmed.length === 1 && !pending) {
            page = confirmed[0]?.candidate;
            break;
          }
          if (!pending) {
            return { confirmed: false, signal: "draft-detail-mismatch" };
          }
          if (attempt < RESUME_CONFIRMATION_ATTEMPTS - 1) {
            await wait(RESUME_CONFIRMATION_POLL_MS);
          }
        }
        if (page === undefined) {
          return { confirmed: false, signal: "draft-detail-page-not-unique" };
        }
        await page.bringToFront();
        const edit = await uniqueDraftDetailEdit(page);
        if (edit === null) return { confirmed: false, signal: "draft-detail-edit-not-unique" };
        await edit.click({ timeout: ACTION_TIMEOUT_MS });
        let editRetries = 0;
        for (let attempt = 0; attempt < RESUME_CONFIRMATION_ATTEMPTS; attempt += 1) {
          const reopenedPages = options.pages().filter(isTargetPage);
          if (reopenedPages.length === 1) {
            const reopened = reopenedPages[0] as PlaywrightCtripDraftPage;
            const titleEditors = reopened.locator(CTRIP_TITLE_EDITOR_SELECTOR);
            if (
              (await titleEditors.count()) === 1 &&
              (await titleEditors.first().isVisible({ timeout: READ_TIMEOUT_MS }))
            ) {
              const currentTitle = normalizedText(await editorText(titleEditors.first()));
              if (currentTitle === normalizedText(expectedTitle)) {
                if (reopened !== page && page.close !== undefined) await page.close();
                return { confirmed: true, signal: "draft-editor-reopened" };
              }
            }
          }
          if (
            attempt > 0 &&
            attempt % RESUME_EDIT_RETRY_INTERVAL_ATTEMPTS === 0 &&
            editRetries < RESUME_EDIT_MAX_RETRIES &&
            isDraftDetailPage(page)
          ) {
            const retryEdit = await uniqueDraftDetailEdit(page);
            if (retryEdit !== null) {
              await retryEdit.click({ timeout: ACTION_TIMEOUT_MS });
              editRetries += 1;
            }
          }
          if (
            attempt === RESUME_DIRECT_NAVIGATION_ATTEMPT &&
            page.goto !== undefined &&
            isDraftDetailPage(page)
          ) {
            const editorUrl = draftEditorUrlFromDetail(page);
            if (editorUrl !== null) {
              try {
                if (options.openPage !== undefined) {
                  await options.openPage(editorUrl);
                } else {
                  await page.goto(editorUrl, {
                    timeout: RESUME_NAVIGATION_TIMEOUT_MS,
                    waitUntil: "domcontentloaded",
                  });
                  await page.waitForLoadState?.("domcontentloaded", {
                    timeout: RESUME_NAVIGATION_TIMEOUT_MS,
                  });
                }
              } catch {
                // The confirmation loop remains authoritative after an ambiguous navigation.
              }
            }
          }
          await wait(RESUME_CONFIRMATION_POLL_MS);
        }
        return { confirmed: false, signal: "draft-editor-reopen-timeout" };
      }
      return { confirmed: false, signal: "draft-management-page-not-unique" };
    },
  };
  return Object.freeze(writer);
}
