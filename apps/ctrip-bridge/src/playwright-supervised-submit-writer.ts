import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
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

export interface CtripSupervisedSubmitSurfaceState {
  readonly status: "ready" | "session_required" | "challenge_required" | "adapter_drift";
  readonly targetPageCount: number;
  readonly titleEditorCount: number;
  readonly bodyEditorCount: number;
  readonly imageInputCount: number;
  readonly uploadActionCount: number;
  readonly draftActionCount: number;
  readonly locationCount: number;
  readonly mediaCount: number;
  readonly finalActionCount: number;
  readonly titleText: string;
  readonly bodyText: string;
  readonly locationText: string;
  readonly challengeSignals: readonly string[];
}

export interface CtripSupervisedSubmitResult {
  readonly outcome: "accepted" | "uncertain" | "rejected" | "not_accepted";
  readonly signal: string;
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
}

export interface CtripSupervisedSubmitWriter {
  inspectPrepared(): Promise<CtripSupervisedSubmitSurfaceState>;
  submitOnce(
    expectedPrepared?: CtripSupervisedSubmitSurfaceState,
  ): Promise<CtripSupervisedSubmitResult>;
}

const READ_TIMEOUT_MS = 1_000;
const PRE_CLICK_STABILITY_ATTEMPTS = 8;
const PRE_CLICK_STABILITY_POLL_MS = 100;
const PRE_CLICK_STABILITY_REQUIRED_POLLS = 2;
const POST_CLICK_OBSERVATION_ATTEMPTS = 300;
const POST_CLICK_OBSERVATION_POLL_MS = 100;
const POST_CLICK_MANAGEMENT_ATTEMPTS = 20;
const POST_CLICK_MANAGEMENT_POLL_MS = 250;
const DETAIL_PATH = "/publish/detail";
const MANAGEMENT_PATH = "/publish/contentManagement";
const MANAGEMENT_URL = `${CTRIP_EDITOR_ORIGIN}${MANAGEMENT_PATH}`;
const PUBLISH_RESPONSE_PATH = "/restapi/soa2/14045/json/tripShoot";
const MANAGEMENT_ROW_SELECTOR = ".c-m-c-container";
const LOCATION_SELECTED_SELECTOR =
  ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search .ant-select-selection-item";
const MEDIA_ITEM_SELECTOR = [
  '[class~="ant-upload-list-picture-card-container"]',
  '[class~="r-d-upload-image-container-done"]',
].join(", ");
const RESULT_SELECTOR = '[role="alert"], .ant-message-notice-content';
const PAGE_BODY_SELECTOR = "body";
const DECLARATION_ITEM_SELECTOR = ".content-ai-tag-item";
const SELECTED_DECLARATION_ITEM_SELECTOR = `${DECLARATION_ITEM_SELECTOR}:has(.icon-selected)`;
const NO_AI_DECLARATION_LABEL = "\u4e0d\u6dfb\u52a0\u81ea\u4e3b\u58f0\u660e";
const CHALLENGE_SELECTORS = Object.freeze([
  '[data-testid="captcha"]',
  '[class*="captcha"]',
  ".nc-container",
]);

function normalizedText(value: string | null): string {
  return (value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}

function normalizedLabel(value: string | null): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function isTargetPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === CTRIP_EDITOR_ORIGIN && url.pathname === CTRIP_EDITOR_PATH;
  } catch {
    return false;
  }
}

function isDetailPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    return (
      url.origin === CTRIP_EDITOR_ORIGIN &&
      url.pathname === DETAIL_PATH &&
      /^\d{1,20}$/u.test(url.searchParams.get("articleId") ?? "")
    );
  } catch {
    return false;
  }
}

async function detailStatus(
  page: PlaywrightCtripDraftPage,
): Promise<"published" | "pending" | "rejected" | null> {
  if (!isDetailPage(page)) return null;
  const text = normalizedLabel(
    await page.locator(PAGE_BODY_SELECTOR).first().textContent({ timeout: READ_TIMEOUT_MS }),
  );
  if (/(?:审核未通过|不通过)/u.test(text)) return "rejected";
  if (/已发布/u.test(text)) return "published";
  if (/待审核/u.test(text)) return "pending";
  return null;
}

function isManagementPage(page: PlaywrightCtripDraftPage): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === CTRIP_EDITOR_ORIGIN && url.pathname === MANAGEMENT_PATH;
  } catch {
    return false;
  }
}

async function managementSubmissionStatus(
  page: PlaywrightCtripDraftPage,
  expectedTitle: string,
): Promise<"published" | "pending" | "draft" | "rejected" | null> {
  if (expectedTitle.length === 0 || !isManagementPage(page)) return null;
  const rows = page.locator(MANAGEMENT_ROW_SELECTOR);
  const count = Math.min(await rows.count(), 100);
  const matches: Array<"published" | "pending" | "draft" | "rejected"> = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    const text = normalizedLabel(await row.textContent({ timeout: READ_TIMEOUT_MS }));
    if (!text.startsWith(expectedTitle)) continue;
    if (text.includes("\u5df2\u53d1\u5e03")) matches.push("published");
    else if (/(?:\u5f85\u5ba1\u6838|\u5ba1\u6838\u4e2d)/u.test(text)) matches.push("pending");
    else if (text.includes("\u8349\u7a3f")) matches.push("draft");
    else if (/(?:\u5ba1\u6838\u672a\u901a\u8fc7|\u5ba1\u6838\u4e0d\u901a\u8fc7|\u672a\u901a\u8fc7)/u.test(text)) matches.push("rejected");
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function isPublishResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === PUBLISH_RESPONSE_PATH;
  } catch {
    return false;
  }
}

function publishApiSignal(payload: unknown):
  | { readonly outcome: "accepted"; readonly signal: "ctrip-publish-api-accepted" }
  | { readonly outcome: "rejected"; readonly signal: string }
  | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = Reflect.get(payload, "result");
  if (typeof result !== "object" || result === null) return null;
  const accepted = Reflect.get(result, "result");
  if (accepted === true) {
    return { outcome: "accepted", signal: "ctrip-publish-api-accepted" };
  }
  if (accepted !== false) return null;
  const resultId = Reflect.get(result, "resultId");
  const suffix = Number.isSafeInteger(resultId) && resultId >= 0 ? `-${resultId}` : "";
  return {
    outcome: "rejected",
    signal: resultId === 103 ? "ctrip-publish-external-link-review-required" : `ctrip-publish-api-rejected${suffix}`,
  };
}

async function recoverManagementSubmissionStatus(
  page: PlaywrightCtripDraftPage,
  expectedTitle: string,
  wait: (milliseconds: number) => Promise<void>,
): Promise<"published" | "pending" | "draft" | "rejected" | null> {
  if (page.goto === undefined) return null;
  try {
    if (!isManagementPage(page)) {
      await page.goto(MANAGEMENT_URL, {
        timeout: 10_000,
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState?.("domcontentloaded", { timeout: 10_000 });
    }
    for (let attempt = 0; attempt < POST_CLICK_MANAGEMENT_ATTEMPTS; attempt += 1) {
      const status = await managementSubmissionStatus(page, expectedTitle);
      if (status !== null) return status;
      if (attempt < POST_CLICK_MANAGEMENT_ATTEMPTS - 1) {
        await wait(POST_CLICK_MANAGEMENT_POLL_MS);
      }
    }
  } catch {
    return null;
  }
  return null;
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

async function inspectAiDeclaration(
  page: PlaywrightCtripDraftPage,
): Promise<
  | { readonly status: "confirmed"; readonly selectedLabel: string }
  | { readonly status: "not_present"; readonly selectedLabel: "" }
  | { readonly status: "blocked"; readonly selectedLabel: string }
> {
  const items = page.locator(DECLARATION_ITEM_SELECTOR);
  const itemCount = Math.min(await items.count(), 10);
  if (itemCount === 0) return { status: "not_present", selectedLabel: "" };

  let noAiItem: PlaywrightCtripDraftLocator | null = null;
  for (let index = 0; index < itemCount; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    const label = normalizedLabel(await item.textContent({ timeout: READ_TIMEOUT_MS }));
    if (label.startsWith(NO_AI_DECLARATION_LABEL)) {
      if (noAiItem !== null) {
        return { status: "blocked", selectedLabel: "duplicate-no-ai-declarations" };
      }
      noAiItem = item;
    }
  }
  if (noAiItem === null) return { status: "blocked", selectedLabel: "no-ai-option-missing" };

  const selectedItems = page.locator(SELECTED_DECLARATION_ITEM_SELECTOR);
  let selectedCount = 0;
  let selectedLabel = "";
  const selectedItemCount = Math.min(await selectedItems.count(), 10);
  for (let index = 0; index < selectedItemCount; index += 1) {
    const item = selectedItems.nth(index);
    if (!(await item.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
    selectedCount += 1;
    selectedLabel = normalizedLabel(await item.textContent({ timeout: READ_TIMEOUT_MS }));
  }
  if (selectedCount === 1 && selectedLabel.startsWith(NO_AI_DECLARATION_LABEL)) {
    return { status: "confirmed", selectedLabel };
  }
  if (selectedCount > 1)
    return { status: "blocked", selectedLabel: "multiple-declarations-selected" };
  if (selectedCount === 0) return { status: "not_present", selectedLabel: "" };
  return { status: "blocked", selectedLabel };
}

async function exactFinalActions(
  page: PlaywrightCtripDraftPage,
): Promise<PlaywrightCtripDraftLocator[]> {
  const buttons = page.locator(CTRIP_ACTION_SELECTOR);
  const count = Math.min(await buttons.count(), 50);
  const matches: PlaywrightCtripDraftLocator[] = [];
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (
      (await button.isVisible({ timeout: READ_TIMEOUT_MS })) &&
      normalizedLabel(await button.textContent({ timeout: READ_TIMEOUT_MS })) ===
        CTRIP_PUBLISH_ACTION_LABEL
    ) {
      matches.push(button);
    }
  }
  return matches;
}

async function exactActionCount(page: PlaywrightCtripDraftPage, label: string): Promise<number> {
  const actions = page.locator(CTRIP_ACTION_SELECTOR);
  const count = Math.min(await actions.count(), 50);
  let matches = 0;
  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index);
    if (
      (await action.isVisible({ timeout: READ_TIMEOUT_MS })) &&
      normalizedLabel(await action.textContent({ timeout: READ_TIMEOUT_MS })) === label
    ) {
      matches += 1;
    }
  }
  return matches;
}

function selectedTargetPage(pages: readonly PlaywrightCtripDraftPage[]): PlaywrightCtripDraftPage {
  const matches = pages.filter(isTargetPage);
  if (matches.length !== 1) throw new Error("Ctrip supervised target page is not unique");
  return matches[0] as PlaywrightCtripDraftPage;
}

async function closeConfirmedPage(page: PlaywrightCtripDraftPage): Promise<void> {
  await page.close?.().catch(() => undefined);
}

function samePreparedSurface(
  left: CtripSupervisedSubmitSurfaceState,
  right: CtripSupervisedSubmitSurfaceState,
): boolean {
  const degraded = (status: CtripSupervisedSubmitSurfaceState["status"]): boolean =>
    status === "ready" || status === "challenge_required";
  return (
    degraded(left.status) &&
    degraded(right.status) &&
    left.targetPageCount === right.targetPageCount &&
    left.titleEditorCount === right.titleEditorCount &&
    left.bodyEditorCount === right.bodyEditorCount &&
    left.imageInputCount === right.imageInputCount &&
    left.uploadActionCount === right.uploadActionCount &&
    left.draftActionCount === right.draftActionCount &&
    left.locationCount === right.locationCount &&
    left.mediaCount === right.mediaCount &&
    left.finalActionCount === right.finalActionCount &&
    left.titleText === right.titleText &&
    left.bodyText === right.bodyText &&
    left.locationText === right.locationText
  );
}

function candidateTarget(value: string): {
  readonly id: string;
  readonly url: string;
} | null {
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
    const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
    if (lastSegment === undefined) return null;
    return { id: lastSegment.replace(/\.html$/iu, ""), url: url.toString() };
  } catch {
    return null;
  }
}

/**
 * Ctrip keeps the browser on the editor after submit and only adds the
 * articleId query parameter. That ID is evidence for a later public readback,
 * not proof of publication by itself.
 */
function editorCandidateTarget(value: string): {
  readonly id: string;
  readonly url: string;
} | null {
  try {
    const url = new URL(value);
    if (url.origin !== CTRIP_EDITOR_ORIGIN || url.pathname !== CTRIP_EDITOR_PATH) return null;
    const articleIds = url.searchParams.getAll("articleId");
    if (articleIds.length !== 1 || !/^\d{1,20}$/u.test(articleIds[0] ?? "")) return null;
    const id = articleIds[0] as string;
    const publicUrl = new URL("https://m.ctrip.com/webapp/you/community/detail");
    publicUrl.searchParams.set("articleId", id);
    return { id, url: publicUrl.toString() };
  } catch {
    return null;
  }
}

export function createPlaywrightCtripSupervisedSubmitWriter(options: {
  readonly pages: () => readonly PlaywrightCtripDraftPage[];
  readonly wait?: (milliseconds: number) => Promise<void>;
}): CtripSupervisedSubmitWriter {
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const inspectPrepared = async (): Promise<CtripSupervisedSubmitSurfaceState> => {
    const targets = options.pages().filter(isTargetPage);
    if (targets.length === 0) {
      return {
        status: "session_required",
        targetPageCount: 0,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        imageInputCount: 0,
        uploadActionCount: 0,
        draftActionCount: 0,
        locationCount: 0,
        mediaCount: 0,
        finalActionCount: 0,
        titleText: "",
        bodyText: "",
        locationText: "",
        challengeSignals: [],
      };
    }
    if (targets.length !== 1) {
      return {
        status: "adapter_drift",
        targetPageCount: targets.length,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        imageInputCount: 0,
        uploadActionCount: 0,
        draftActionCount: 0,
        locationCount: 0,
        mediaCount: 0,
        finalActionCount: 0,
        titleText: "",
        bodyText: "",
        locationText: "",
        challengeSignals: ["duplicate-target-page"],
      };
    }
    const page = targets[0] as PlaywrightCtripDraftPage;
    await page.bringToFront();
    const challengeSignals: string[] = [];
    for (const [index, selector] of CHALLENGE_SELECTORS.entries()) {
      if ((await visibleCount(page.locator(selector))) > 0)
        challengeSignals.push(`challenge-${index}`);
    }
    const title = page.locator(CTRIP_TITLE_EDITOR_SELECTOR);
    const body = page.locator(CTRIP_BODY_EDITOR_SELECTOR);
    const location = page.locator(LOCATION_SELECTED_SELECTOR);
    const titleEditorCount = await visibleCount(title);
    const bodyEditorCount = await visibleCount(body);
    const imageInputCount = Math.min(await page.locator(CTRIP_IMAGE_INPUT_SELECTOR).count(), 10);
    const uploadActionCount = await exactActionCount(page, CTRIP_UPLOAD_ACTION_LABEL);
    const draftActionCount = await exactActionCount(page, CTRIP_DRAFT_ACTION_LABEL);
    const finalActionCount = (await exactFinalActions(page)).length;
    const controlsStable =
      titleEditorCount === 1 &&
      bodyEditorCount === 1 &&
      imageInputCount === 1 &&
      uploadActionCount === 1 &&
      draftActionCount === 1 &&
      finalActionCount === 1;
    return {
      status:
        challengeSignals.length > 0
          ? "challenge_required"
          : controlsStable
            ? "ready"
            : "adapter_drift",
      targetPageCount: 1,
      titleEditorCount,
      bodyEditorCount,
      imageInputCount,
      uploadActionCount,
      draftActionCount,
      locationCount: await visibleCount(location),
      mediaCount: Math.min(await page.locator(MEDIA_ITEM_SELECTOR).count(), 50),
      finalActionCount,
      titleText: titleEditorCount === 1 ? normalizedText(await editorText(title.first())) : "",
      bodyText: bodyEditorCount === 1 ? normalizedText(await editorText(body.first())) : "",
      locationText:
        (await visibleCount(location)) === 1
          ? normalizedText(await location.first().textContent({ timeout: READ_TIMEOUT_MS }))
          : "",
      challengeSignals,
    };
  };

  const writer: CtripSupervisedSubmitWriter = {
    inspectPrepared,
    submitOnce: async (
      expectedPrepared?: CtripSupervisedSubmitSurfaceState,
    ): Promise<CtripSupervisedSubmitResult> => {
      let stablePolls = 0;
      let stableSurface: CtripSupervisedSubmitSurfaceState | null = null;
      for (let attempt = 0; attempt < PRE_CLICK_STABILITY_ATTEMPTS; attempt += 1) {
        const observed = await inspectPrepared();
        const controlsReady =
          (observed.status === "ready" || observed.status === "challenge_required") &&
          observed.targetPageCount === 1 &&
          observed.titleEditorCount === 1 &&
          observed.bodyEditorCount === 1 &&
          observed.imageInputCount === 1 &&
          observed.uploadActionCount === 1 &&
          observed.draftActionCount === 1 &&
          observed.finalActionCount === 1;
        const matchesBoundScope =
          expectedPrepared === undefined || samePreparedSurface(observed, expectedPrepared);
        const matchesPriorPoll =
          stableSurface === null || samePreparedSurface(observed, stableSurface);
        if (controlsReady && matchesBoundScope && matchesPriorPoll) {
          stableSurface = observed;
          stablePolls += 1;
          if (stablePolls >= PRE_CLICK_STABILITY_REQUIRED_POLLS) break;
        } else {
          stableSurface = null;
          stablePolls = 0;
        }
        if (attempt < PRE_CLICK_STABILITY_ATTEMPTS - 1) {
          await wait(PRE_CLICK_STABILITY_POLL_MS);
        }
      }
      if (stableSurface === null || stablePolls < PRE_CLICK_STABILITY_REQUIRED_POLLS) {
        throw new Error("Ctrip supervised editor controls or prepared content are not stable");
      }
      const page = selectedTargetPage(options.pages());
      const expectedTitle = stableSurface.titleText;
      const declaration = await inspectAiDeclaration(page);
      if (declaration.status === "blocked") {
        return {
          outcome: "rejected",
          signal: `ctrip-ai-declaration-unresolved:${declaration.selectedLabel}`,
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      const finalSurface = await inspectPrepared();
      if (!samePreparedSurface(finalSurface, stableSurface)) {
        throw new Error(
          "Ctrip supervised editor controls or prepared content changed before click",
        );
      }
      const finalActions = await exactFinalActions(page);
      if (finalActions.length !== 1) throw new Error("Ctrip final action is not unique");
      const finalAction = finalActions[0] as PlaywrightCtripDraftLocator;
      if (
        finalAction.isEnabled !== undefined &&
        !(await finalAction.isEnabled({ timeout: READ_TIMEOUT_MS }))
      ) {
        throw new Error("Ctrip final action is disabled");
      }
      let publishResponseSettled = page.waitForResponse === undefined;
      const publishResponse =
        page.waitForResponse === undefined
          ? null
          : page
              .waitForResponse((response) => isPublishResponseUrl(response.url()), {
                timeout:
                  POST_CLICK_OBSERVATION_ATTEMPTS * POST_CLICK_OBSERVATION_POLL_MS + 5_000,
              })
              .then(async (response) => publishApiSignal(await response.json()))
              .catch(() => null)
              .then((result) => {
                publishResponseSettled = true;
                return result;
              });
      await finalAction.click({ timeout: READ_TIMEOUT_MS });
      let candidate: ReturnType<typeof candidateTarget> = null;
      let editorCandidate: ReturnType<typeof editorCandidateTarget> = null;
      let signal = "submit-observation-missing";
      for (let attempt = 0; attempt < POST_CLICK_OBSERVATION_ATTEMPTS; attempt += 1) {
        await wait(POST_CLICK_OBSERVATION_POLL_MS);
        const status = await detailStatus(page);
        const managementStatus = await managementSubmissionStatus(page, expectedTitle);
        if (managementStatus === "published" || managementStatus === "pending") {
          await closeConfirmedPage(page);
          return {
            outcome: "accepted",
            signal: `ctrip-management-${managementStatus}`,
            candidateExternalId: null,
            candidateExternalUrl: null,
          };
        }
        if (status === "rejected") {
          return {
            outcome: "rejected",
            signal: "ctrip-detail-rejected",
            candidateExternalId: null,
            candidateExternalUrl: null,
          };
        }
        if (status === "published" || status === "pending") {
          signal = `ctrip-detail-${status}`;
        }
        candidate = candidateTarget(page.url());
        editorCandidate = editorCandidateTarget(page.url());
        const result = page.locator(RESULT_SELECTOR).first();
        if (await result.isVisible({ timeout: READ_TIMEOUT_MS })) {
          signal = normalizedLabel(await result.textContent({ timeout: READ_TIMEOUT_MS }));
        }
        if (
          candidate !== null ||
          editorCandidate !== null ||
          (signal !== "submit-observation-missing" && !signal.startsWith("ctrip-detail-"))
        ) {
          break;
        }
        if (publishResponseSettled) break;
      }
      if (
        candidate !== null ||
        (editorCandidate !== null &&
          /(?:\u53d1\u5e03\u6210\u529f|\u53d1\u8868\u6210\u529f|\u5df2\u53d1\u5e03)/u.test(
            signal,
          )) ||
        /(?:\u53d1\u5e03\u6210\u529f|\u53d1\u8868\u6210\u529f|\u5df2\u53d1\u5e03)/u.test(signal)
      ) {
        const resolvedCandidate = candidate ?? editorCandidate;
        await closeConfirmedPage(page);
        return {
          outcome: "accepted",
          signal,
          candidateExternalId: resolvedCandidate?.id ?? null,
          candidateExternalUrl: resolvedCandidate?.url ?? null,
        };
      }
      const apiSignal = publishResponse === null ? null : await publishResponse;
      if (apiSignal?.outcome === "accepted") {
        const resolvedCandidate = candidate ?? editorCandidate;
        await closeConfirmedPage(page);
        return {
          outcome: "accepted",
          signal: apiSignal.signal,
          candidateExternalId: resolvedCandidate?.id ?? null,
          candidateExternalUrl: resolvedCandidate?.url ?? null,
        };
      }
      const recoveredStatus = await recoverManagementSubmissionStatus(page, expectedTitle, wait);
      if (recoveredStatus === "published" || recoveredStatus === "pending") {
        await closeConfirmedPage(page);
        return {
          outcome: "accepted",
          signal: `ctrip-management-${recoveredStatus}`,
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      if (recoveredStatus === "draft") {
        return {
          outcome: "not_accepted",
          signal:
            apiSignal?.outcome === "rejected"
              ? `${apiSignal.signal}-draft-retained`
              : "ctrip-management-draft-retained",
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      if (recoveredStatus === "rejected") {
        return {
          outcome: "rejected",
          signal: "ctrip-management-rejected",
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      if (apiSignal?.outcome === "rejected") {
        return {
          outcome: "rejected",
          signal: apiSignal.signal,
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      if (
        /(?:\u53d1\u5e03\u5931\u8d25|\u53d1\u8868\u5931\u8d25|\u8bf7\u5b8c\u5584|\u8bf7\u586b\u5199|\u8bf7\u9009\u62e9\u65f6\u95f4|\u8bf7\u6dfb\u52a0\u4e00\u4e2a\u5730\u70b9|\u8bf7\u4e0a\u4f20\u56fe\u7247|\u6807\u9898\u5fc5\u987b)/u.test(
          signal,
        )
      ) {
        return {
          outcome: "rejected",
          signal,
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      return {
        outcome: "uncertain",
        signal,
        candidateExternalId: null,
        candidateExternalUrl: null,
      };
    },
  };
  return Object.freeze(writer);
}
