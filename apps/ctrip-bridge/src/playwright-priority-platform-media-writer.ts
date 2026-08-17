import type { MediaReference } from "@geo/contracts";

import { BAIJIAHAO_ARTICLE_EDITOR_URL } from "./playwright-baijiahao-publication.js";
import { NETEASE_ARTICLE_EDITOR_URL } from "./playwright-netease-publication.js";
import type { BrowserPublicationPlatform } from "./playwright-platform-publication.js";
import { SOHU_ARTICLE_EDITOR_URL } from "./playwright-sohu-publication.js";
import { TOUTIAO_ARTICLE_EDITOR_URL } from "./playwright-toutiao-publication.js";
import { ZHIHU_ARTICLE_EDITOR_URL } from "./playwright-zhihu-publication.js";
import type { CtripTrustedMediaAttachment } from "./types.js";
import { isBrowserRuntimeUnavailableError } from "./browser-runtime-error.js";

export interface PlaywrightPriorityPlatformMediaFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

export interface PlaywrightPriorityPlatformMediaLocator {
  count(): Promise<number>;
  nth(index: number): PlaywrightPriorityPlatformMediaLocator;
  first(): PlaywrightPriorityPlatformMediaLocator;
  locator?(selector: string): PlaywrightPriorityPlatformMediaLocator;
  isVisible(options?: { readonly timeout?: number }): Promise<boolean>;
  isEnabled?(options?: { readonly timeout?: number }): Promise<boolean>;
  isChecked?(options?: { readonly timeout?: number }): Promise<boolean>;
  textContent?(options?: { readonly timeout?: number }): Promise<string | null>;
  click(options?: { readonly timeout?: number }): Promise<void>;
  setInputFiles(
    file: PlaywrightPriorityPlatformMediaFile | readonly PlaywrightPriorityPlatformMediaFile[],
    options?: { readonly timeout?: number },
  ): Promise<void>;
}

export interface PlaywrightPriorityPlatformMediaFrame {
  url(): string;
  locator(selector: string): PlaywrightPriorityPlatformMediaLocator;
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

export interface PlaywrightPriorityPlatformMediaPage extends PlaywrightPriorityPlatformMediaFrame {
  bringToFront(): Promise<void>;
  frames?(): readonly PlaywrightPriorityPlatformMediaFrame[];
}

export interface PriorityPlatformMediaSurfaceState {
  readonly status: "ready" | "session_required" | "challenge_required" | "adapter_drift";
  readonly platform: BrowserPublicationPlatform;
  readonly coverImageCount: number;
  readonly inlineImageCount: number;
  readonly challengeSignals: readonly string[];
}

export interface PriorityPlatformMediaWriter {
  readonly platform: BrowserPublicationPlatform;
  write(
    attachments: readonly CtripTrustedMediaAttachment[],
  ): Promise<PriorityPlatformMediaSurfaceState>;
  inspect(expectedMedia: readonly MediaReference[]): Promise<PriorityPlatformMediaSurfaceState>;
}

export class PriorityPlatformMediaWriteError extends Error {
  readonly platform: BrowserPublicationPlatform;
  readonly stage: string;
  readonly runtimeUnavailable: boolean;

  constructor(platform: BrowserPublicationPlatform, stage: string, cause?: unknown) {
    super(`Priority platform media write failed at ${stage}`);
    this.name = "PriorityPlatformMediaWriteError";
    this.platform = platform;
    this.stage = stage;
    this.runtimeUnavailable = isBrowserRuntimeUnavailableError(cause);
  }
}

const READ_TIMEOUT_MS = 1_000;
const ACTION_TIMEOUT_MS = 10_000;
const TOUTIAO_WRITE_SETTLE_MS = 2_000;
const TOUTIAO_RESET_SETTLE_MS = 500;
const UPLOAD_ATTEMPTS = 40;
const UPLOAD_POLL_MS = 250;
const MAX_LOCATOR_COUNT = 100;
const BAIJIAHAO_MEDIA_RECOVERY_TIMEOUT_MS = 30_000;

const TOUTIAO_COVER_ENTRY_SELECTOR = "div.article-cover-add";
const TOUTIAO_LOCAL_UPLOAD_SELECTOR = "div.btn-upload-handle.upload-handler";
const TOUTIAO_FILE_INPUT_SELECTOR = "input[type='file']";
const TOUTIAO_UPLOAD_CONFIRM_SELECTOR = "button[data-e2e='imageUploadConfirm-btn']";
const TOUTIAO_COVER_PREVIEW_SELECTOR =
  "div.article-cover-add img, div.article-cover img, [class*='article-cover'] img";
const TOUTIAO_INLINE_PREVIEW_SELECTOR = ".ProseMirror img";
const TOUTIAO_INLINE_EDITOR_SELECTOR = ".ProseMirror";
// The live cover tile changes shape between states: no cover renders a
// hash-suffixed -text div, while a persisted cover renders a button. Match
// both inside the semantic cover section and let exact text disambiguate.
const BAIJIAHAO_COVER_ACTION_SELECTOR =
  "#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']";
const BAIJIAHAO_COVER_ACTION_TEXTS = ["选择封面", "更换"] as const;
const BAIJIAHAO_LOCAL_UPLOAD_TAB_SELECTOR =
  ".cheetah-modal [role='tab'], .cheetah-modal-wrap [role='tab']";
const BAIJIAHAO_COVER_INPUT_SELECTOR =
  ".cheetah-modal .cheetah-upload input[name='media'][type='file'][accept*='image'], .cheetah-modal-wrap .cheetah-upload input[name='media'][type='file'][accept*='image']";
const BAIJIAHAO_COVER_MODAL_SELECTOR = ".cheetah-modal, .cheetah-modal-wrap";
const BAIJIAHAO_COVER_CONFIRM_SELECTOR = ".cheetah-modal button, .cheetah-modal-wrap button";
const BAIJIAHAO_COVER_CONFIRM_TEXTS = ["确认", "确定", "完成"] as const;
const BAIJIAHAO_COVER_PREVIEW_SELECTOR =
  "div[class*='-coverWrapper'] > img, div[class*='-coverWrapper'] img[class*='-coverImg']";
const BAIJIAHAO_LOCAL_UPLOAD_TAB_TEXTS = ["正文/本地上传", "本地上传"] as const;
const BAIJIAHAO_INLINE_EDITOR_SELECTOR = "body[contenteditable='true']";
const BAIJIAHAO_INLINE_PREVIEW_SELECTOR = "body[contenteditable='true'] img";
const BAIJIAHAO_INLINE_TRIGGER_SELECTOR = ".edui-for-insertimage .edui-button-body";
const BAIJIAHAO_INLINE_INPUT_SELECTOR =
  ".cheetah-modal input[type='file'][accept='image/*'], .cheetah-modal-wrap input[type='file'][accept='image/*']";
const BAIJIAHAO_INLINE_MODAL_SELECTOR = ".cheetah-modal, .cheetah-modal-wrap";
const BAIJIAHAO_INLINE_CONFIRM_SELECTOR = ".cheetah-modal button, .cheetah-modal-wrap button";
const BAIJIAHAO_INLINE_CONFIRM_TEXTS = ["确认", "确定", "完成"] as const;
const SOHU_COVER_TRIGGER_SELECTOR = "span.upload-tip";
const SOHU_LOCAL_UPLOAD_TAB_SELECTOR = "h3";
const SOHU_COVER_INPUT_SELECTOR = "input[type='file']";
const SOHU_COVER_CONFIRM_SELECTOR = "p.button.positive-button";
const SOHU_COVER_MODAL_SELECTOR = ".el-dialog__wrapper.select-dialog";
const SOHU_COVER_PREVIEW_SELECTORS = [
  "div.pic-cover[style*='url(']",
  "span.upload-tip img",
  "[class*='cover'] img",
] as const;
const SOHU_INLINE_EDITOR_SELECTOR = "div.ql-editor[contenteditable='true']";
const SOHU_INLINE_PREVIEW_SELECTOR = `${SOHU_INLINE_EDITOR_SELECTOR} img`;
const SOHU_MEDIA_CHALLENGE_SELECTORS = [
  ['iframe[src*="captcha" i]', "iframe[src*=captcha]"],
  ['[class*="tcaptcha" i]', "[class*=tcaptcha]"],
  ['[id*="tcaptcha" i]', "[id*=tcaptcha]"],
] as const;
const NETEASE_INLINE_EDITOR_SELECTOR = ".public-DraftEditor-content[contenteditable='true']";
const NETEASE_IMAGE_PREVIEW_SELECTOR = `${NETEASE_INLINE_EDITOR_SELECTOR} img`;
const NETEASE_AUTO_COVER_SELECTOR = "label.cover-pic__radio:has(input[type='radio'][value='auto'])";
const NETEASE_AUTO_COVER_INPUT_SELECTOR = "input[type='radio'][value='auto']";
const NETEASE_IMAGE_TRIGGER_SELECTOR = "button.rich-editor-panel-item:has(img[src*='icon_image'])";
const NETEASE_IMAGE_MODAL_SELECTOR = ".ne-modal.picture-adder";
const NETEASE_IMAGE_INPUT_WITHIN_MODAL_SELECTOR = "input[type='file'][name='pic']";
const NETEASE_UPLOAD_PREVIEW_SELECTOR = `${NETEASE_IMAGE_MODAL_SELECTOR} img`;
const NETEASE_UPLOAD_CONFIRM_WITHIN_MODAL_SELECTOR = "button.s-confirm-btn";
const NETEASE_WATERMARK_OPTION_WITHIN_MODAL_SELECTOR = ".picture-adder-opts-item";
const NETEASE_WATERMARK_TEXT = "上传时添加水印";
const NETEASE_WATERMARK_INPUT_SELECTOR = "input[type='checkbox']";
const NETEASE_WATERMARK_TOGGLE_SELECTOR = "span[role='button']";
const NETEASE_MEDIA_CHALLENGE_SELECTORS = [
  ['iframe[src*="captcha" i]', "iframe[src*=captcha]"],
  ['[class*="yidun" i]', "[class*=yidun]"],
  ['[id*="yidun" i]', "[id*=yidun]"],
] as const;
const ZHIHU_COVER_INPUT_SELECTOR =
  'label.UploadPicture-wrapper input.UploadPicture-input[type="file"][accept*=".png"]';
const ZHIHU_COVER_PREVIEW_SELECTOR = "label.UploadPicture-wrapper img";
const ZHIHU_INLINE_EDITOR_SELECTOR =
  'div.public-DraftEditor-content[contenteditable="true"][role="textbox"]';
const ZHIHU_INLINE_PREVIEW_SELECTOR = `${ZHIHU_INLINE_EDITOR_SELECTOR} img`;
const ZHIHU_INLINE_TRIGGER_SELECTOR = 'button[aria-label="图片"]';
const ZHIHU_INLINE_INPUT_SELECTOR = 'input[type="file"][accept*="image"]:not(.UploadPicture-input)';

interface TrustedImageDomElement {
  dispatchEvent(event: unknown): boolean;
  focus?(): void;
  remove?(): void;
  ownerDocument?: {
    getSelection?(): TrustedImageSelection | null;
  };
}

interface TrustedImageRange {
  selectNodeContents(node: TrustedImageDomElement): void;
  collapse(toStart: boolean): void;
}

interface TrustedImageSelection {
  removeAllRanges(): void;
  addRange(range: TrustedImageRange): void;
}

interface TrustedImageDataTransfer {
  readonly items: { add(file: unknown): void };
}

interface TrustedImageDomGlobals {
  readonly document?: {
    querySelector(selector: string): TrustedImageDomElement | null;
    createRange?(): TrustedImageRange;
  };
  getSelection?(): TrustedImageSelection | null;
  readonly Blob?: new (parts: readonly Uint8Array[], options: { readonly type: string }) => unknown;
  readonly File?: new (
    parts: readonly unknown[],
    name: string,
    options: { readonly type: string },
  ) => unknown;
  readonly DataTransfer?: new () => TrustedImageDataTransfer;
  readonly ClipboardEvent?: new (
    type: string,
    options: {
      readonly bubbles: boolean;
      readonly cancelable: boolean;
      readonly clipboardData: TrustedImageDataTransfer;
    },
  ) => unknown;
  readonly DragEvent?: new (
    type: string,
    options: {
      readonly bubbles: boolean;
      readonly cancelable: boolean;
      readonly dataTransfer: TrustedImageDataTransfer;
    },
  ) => unknown;
}

interface TrustedImageResetGlobals {
  readonly document?: {
    querySelectorAll(selectors: string): readonly TrustedImageDomElement[];
  };
}

interface TrustedImageEventInput {
  readonly targetSelector: string;
  readonly eventType: "paste" | "drop";
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: readonly number[];
}

interface ActionableChallengeProbeInput {
  readonly challengeProbe: true;
  readonly platform: "sohu" | "netease";
  readonly selectors: readonly Readonly<{ selector: string; signal: string }>[];
}

interface TrustedChallengeDomElement {
  readonly parentElement: TrustedChallengeDomElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

interface TrustedChallengeStyle {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly pointerEvents: string;
}

function inspectActionableMediaChallenges(input: ActionableChallengeProbeInput): readonly string[] {
  const browser = globalThis as unknown as {
    readonly document?: {
      readonly defaultView?: {
        readonly innerHeight: number;
        readonly innerWidth: number;
        getComputedStyle(element: TrustedChallengeDomElement): TrustedChallengeStyle;
      } | null;
      querySelectorAll(selector: string): ArrayLike<TrustedChallengeDomElement>;
    };
  };
  const document = browser.document;
  const view = document?.defaultView;
  if (document === undefined || view === undefined || view === null) {
    return ["challenge-inspection-unavailable"];
  }
  const actionable = (element: TrustedChallengeDomElement): boolean => {
    let current: TrustedChallengeDomElement | null = element;
    while (current !== null) {
      const style = view.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0 ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < view.innerHeight &&
      rect.left < view.innerWidth
    );
  };
  const signals = new Set<string>();
  for (const { selector, signal } of input.selectors) {
    if (Array.from(document.querySelectorAll(selector)).slice(0, 20).some(actionable)) {
      signals.add(signal);
    }
  }
  for (const frame of Array.from(document.querySelectorAll("iframe")).slice(0, 20)) {
    if (!actionable(frame)) continue;
    const url = (frame.getAttribute("src") ?? "").toLowerCase();
    if (input.platform === "sohu" && /(?:captcha\.gtimg\.com|turing\.captcha)/u.test(url)) {
      signals.add("frame:tencent-captcha");
    }
    if (input.platform === "netease" && /(?:yidun|cstaticdun\.126\.net|captcha)/u.test(url)) {
      signals.add("frame:netease-yidun");
    }
  }
  return [...signals];
}

function dispatchTrustedImageEvent(input: TrustedImageEventInput): boolean {
  const browser = globalThis as unknown as TrustedImageDomGlobals;
  const target = browser.document?.querySelector(input.targetSelector);
  if (
    target === null ||
    target === undefined ||
    browser.Blob === undefined ||
    browser.File === undefined ||
    browser.DataTransfer === undefined
  ) {
    return false;
  }
  const blob = new browser.Blob([Uint8Array.from(input.bytes)], { type: input.mimeType });
  const file = new browser.File([blob], input.fileName, { type: input.mimeType });
  const transfer = new browser.DataTransfer();
  transfer.items.add(file);
  target.focus?.();
  const selection = browser.getSelection?.();
  const range = browser.document?.createRange?.();
  if (selection !== null && selection !== undefined && range !== undefined) {
    selection.removeAllRanges();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.addRange(range);
  }
  if (input.eventType === "paste") {
    const ClipboardEvent = browser.ClipboardEvent;
    if (ClipboardEvent === undefined) return false;
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  } else {
    const DragEvent = browser.DragEvent;
    if (DragEvent === undefined) return false;
    for (const eventType of ["dragenter", "dragover", "drop"] as const) {
      target.dispatchEvent(
        new DragEvent(eventType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    }
  }
  return true;
}

function removeToutiaoStaleMedia(): number {
  const browser = globalThis as unknown as TrustedImageResetGlobals;
  const images =
    browser.document?.querySelectorAll(
      ".article-cover-add img, .article-cover img, [class*='article-cover'] img, .ProseMirror img",
    ) ?? [];
  let removed = 0;
  for (const image of images) {
    image.remove?.();
    removed += 1;
  }
  return removed;
}

function exactEditorUrl(value: string, expected: string): boolean {
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return (
      actual.protocol === "https:" &&
      actual.origin === target.origin &&
      actual.pathname === target.pathname &&
      [...target.searchParams.entries()].every(
        ([name, expectedValue]) =>
          actual.searchParams.getAll(name).length === 1 &&
          actual.searchParams.get(name) === expectedValue,
      ) &&
      actual.hash === target.hash
    );
  } catch {
    return false;
  }
}

async function visibleCount(
  locator: PlaywrightPriorityPlatformMediaLocator,
  readTimeoutMs: number,
): Promise<number> {
  const count = Math.min(await locator.count(), MAX_LOCATOR_COUNT);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (
      await locator
        .nth(index)
        .isVisible({ timeout: readTimeoutMs })
        .catch(() => false)
    ) {
      visible += 1;
    }
  }
  return visible;
}

async function firstObservedVisibleCount(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selectors: readonly string[],
  readTimeoutMs: number,
): Promise<number> {
  for (const selector of selectors) {
    const count = await visibleCount(scope.locator(selector), readTimeoutMs);
    if (count > 0) return count;
  }
  return 0;
}

async function exactVisibleLocator(
  page: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  readTimeoutMs: number,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const locator = page.locator(selector);
  if ((await visibleCount(locator, readTimeoutMs)) !== 1) {
    throw new Error(`Priority platform media control drifted: ${selector}`);
  }
  return locator.first();
}

async function exactAttachedLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const locator = scope.locator(selector);
  if ((await locator.count()) !== 1) {
    throw new Error(`Priority platform media control drifted: ${selector}`);
  }
  return locator.first();
}

async function exactVisibleTextLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  expectedText: string | readonly string[],
  readTimeoutMs: number,
  allowNumericSuffix = false,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const expectedTexts = typeof expectedText === "string" ? [expectedText] : expectedText;
  const locator = scope.locator(selector);
  const count = Math.min(await locator.count(), MAX_LOCATOR_COUNT);
  const matches: PlaywrightPriorityPlatformMediaLocator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible({ timeout: readTimeoutMs }).catch(() => false))) continue;
    const text =
      candidate.textContent === undefined
        ? null
        : await candidate.textContent({ timeout: readTimeoutMs }).catch(() => null);
    const normalized = (text ?? "").normalize("NFC").trim();
    const matchesExpected = expectedTexts.includes(normalized);
    const matchesNumericSuffix =
      allowNumericSuffix &&
      expectedTexts.some((expected) =>
        new RegExp(`^${escapeRegularExpression(expected)}\\s*\\([0-9]+\\)$`, "u").test(normalized),
      );
    if (matchesExpected || matchesNumericSuffix) matches.push(candidate);
  }
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`Priority platform media text control drifted: ${expectedTexts.join("|")}`);
  }
  return match;
}

async function waitForExactEnabledVisibleLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  readTimeoutMs: number,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const locator = await exactVisibleLocator(scope, selector, readTimeoutMs);
      if (
        locator.isEnabled === undefined ||
        (await locator.isEnabled({ timeout: readTimeoutMs }).catch(() => false))
      ) {
        return locator;
      }
      lastError = new Error(`Priority platform media control is disabled: ${selector}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError ?? new Error(`Priority platform media control is disabled: ${selector}`);
}

async function waitForExactAttachedLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return await exactAttachedLocator(scope, selector);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError;
}

async function waitForFirstAttachedLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const locator = scope.locator(selector);
      if ((await locator.count()) >= 1) return locator.first();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError;
}

async function waitForExactVisibleTextLocator(
  scope: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  selector: string,
  expectedText: string | readonly string[],
  readTimeoutMs: number,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
  allowNumericSuffix = false,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return await exactVisibleTextLocator(
        scope,
        selector,
        expectedText,
        readTimeoutMs,
        allowNumericSuffix,
      );
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError;
}

async function exactVisibleModalDescendant(
  page: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  modalSelector: string,
  descendantSelector: string,
  readTimeoutMs: number,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const modal = await exactVisibleLocator(page, modalSelector, readTimeoutMs);
  if (modal.locator !== undefined) {
    const descendant = modal.locator(descendantSelector);
    if ((await visibleCount(descendant, readTimeoutMs)) !== 1) {
      throw new Error(`Priority platform media modal control drifted: ${descendantSelector}`);
    }
    return descendant.first();
  }
  return exactVisibleLocator(page, `${modalSelector} ${descendantSelector}`, readTimeoutMs);
}

async function exactAttachedModalDescendant(
  page: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  modalSelector: string,
  descendantSelector: string,
  readTimeoutMs: number,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const modal = await exactVisibleLocator(page, modalSelector, readTimeoutMs);
  if (modal.locator === undefined) {
    throw new Error(`Priority platform media modal scope drifted: ${modalSelector}`);
  }
  return exactAttachedLocator({ locator: modal.locator.bind(modal) }, descendantSelector);
}

async function exactVisibleModalTextLocator(
  page: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  modalSelector: string,
  selector: string,
  expectedText: string,
  readTimeoutMs: number,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const modal = await exactVisibleLocator(page, modalSelector, readTimeoutMs);
  if (modal.locator === undefined) {
    throw new Error(`Priority platform media modal scope drifted: ${modalSelector}`);
  }
  return exactVisibleTextLocator(
    { locator: modal.locator.bind(modal) },
    selector,
    expectedText,
    readTimeoutMs,
  );
}

async function waitForNeteaseWatermarkOption(
  page: PlaywrightPriorityPlatformMediaPage,
  readTimeoutMs: number,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<
  | {
      readonly status: "ready";
      readonly watermarkOption: PlaywrightPriorityPlatformMediaLocator;
    }
  | {
      readonly status: "challenge_required";
      readonly challengeSignals: readonly string[];
    }
> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    const challengeSignals = await mediaChallengeSignals(page, "netease", readTimeoutMs);
    if (challengeSignals.length > 0) {
      return { status: "challenge_required", challengeSignals };
    }
    try {
      return {
        status: "ready",
        watermarkOption: await exactVisibleModalTextLocator(
          page,
          NETEASE_IMAGE_MODAL_SELECTOR,
          NETEASE_WATERMARK_OPTION_WITHIN_MODAL_SELECTOR,
          NETEASE_WATERMARK_TEXT,
          readTimeoutMs,
        ),
      };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw lastError;
}

async function waitForExactEnabledVisibleModalDescendant(
  page: Pick<PlaywrightPriorityPlatformMediaFrame, "locator">,
  modalSelector: string,
  descendantSelector: string,
  readTimeoutMs: number,
  timeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<PlaywrightPriorityPlatformMediaLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const locator = await exactVisibleModalDescendant(
        page,
        modalSelector,
        descendantSelector,
        readTimeoutMs,
      );
      if (
        locator.isEnabled === undefined ||
        (await locator.isEnabled({ timeout: readTimeoutMs }).catch(() => false))
      ) {
        return locator;
      }
      lastError = new Error(
        `Priority platform media modal control is disabled: ${descendantSelector}`,
      );
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw (
    lastError ??
    new Error(`Priority platform media modal control is disabled: ${descendantSelector}`)
  );
}

function neteaseMediaFiles(
  attachments: readonly CtripTrustedMediaAttachment[],
): readonly PlaywrightPriorityPlatformMediaFile[] {
  return attachments.map((attachment) => ({
    name: `geo-${attachment.reference.role}-${String(attachment.position + 1).padStart(2, "0")}.${imageExtension(
      attachment.reference.mimeType,
    )}`,
    mimeType: attachment.reference.mimeType,
    buffer: Buffer.from(attachment.bytes),
  }));
}

async function baijiahaoEditorFrame(
  page: PlaywrightPriorityPlatformMediaPage,
  readTimeoutMs: number,
): Promise<PlaywrightPriorityPlatformMediaFrame | null> {
  const candidates: PlaywrightPriorityPlatformMediaFrame[] = [];
  for (const frame of page.frames?.() ?? []) {
    if (
      (await visibleCount(frame.locator(BAIJIAHAO_INLINE_EDITOR_SELECTOR), readTimeoutMs)) === 1
    ) {
      candidates.push(frame);
    }
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

async function waitForBaijiahaoEditorFrame(
  page: PlaywrightPriorityPlatformMediaPage,
  readTimeoutMs: number,
  actionTimeoutMs: number,
  pollMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<PlaywrightPriorityPlatformMediaFrame | null> {
  const deadline = Date.now() + actionTimeoutMs;
  do {
    const frame = await baijiahaoEditorFrame(page, readTimeoutMs);
    if (frame !== null) return frame;
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return null;
}

function expectedCounts(expectedMedia: readonly MediaReference[]): {
  readonly cover: number;
  readonly inline: number;
} {
  return {
    cover: expectedMedia.filter(({ role }) => role === "cover").length,
    inline: expectedMedia.filter(({ role }) => role === "inline").length,
  };
}

function imageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "img";
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function restoreEditorCaretAtEnd(selector: string): boolean {
  const browser = globalThis as unknown as TrustedImageDomGlobals;
  const target = browser.document?.querySelector(selector);
  const range = browser.document?.createRange?.();
  const selection = browser.getSelection?.() ?? target?.ownerDocument?.getSelection?.();
  if (target === null || target === undefined || range === undefined || selection == null) {
    return false;
  }
  target.focus?.();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

async function mediaChallengeSignals(
  page: PlaywrightPriorityPlatformMediaPage,
  platform: "sohu" | "netease",
  readTimeoutMs: number,
): Promise<readonly string[]> {
  const selectors =
    platform === "sohu" ? SOHU_MEDIA_CHALLENGE_SELECTORS : NETEASE_MEDIA_CHALLENGE_SELECTORS;
  void readTimeoutMs;
  return page
    .evaluate(inspectActionableMediaChallenges, {
      challengeProbe: true,
      platform,
      selectors: selectors.map(([selector, signal]) => ({ selector, signal })),
    })
    .catch(() => ["challenge-inspection-unavailable"]);
}

async function inspectToutiao(
  page: PlaywrightPriorityPlatformMediaPage | null,
  expectedMedia: readonly MediaReference[],
  readTimeoutMs: number,
): Promise<PriorityPlatformMediaSurfaceState> {
  if (page === null) {
    return {
      status: "session_required",
      platform: "toutiao",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    };
  }
  const coverImageCount = await visibleCount(
    page.locator(TOUTIAO_COVER_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const inlineImageCount = await visibleCount(
    page.locator(TOUTIAO_INLINE_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const expected = expectedCounts(expectedMedia);
  return {
    status:
      coverImageCount === expected.cover && inlineImageCount === expected.inline
        ? "ready"
        : "adapter_drift",
    platform: "toutiao",
    coverImageCount,
    inlineImageCount,
    challengeSignals: [],
  };
}

async function inspectBaijiahao(
  page: PlaywrightPriorityPlatformMediaPage | null,
  expectedMedia: readonly MediaReference[],
  readTimeoutMs: number,
): Promise<PriorityPlatformMediaSurfaceState> {
  if (page === null) {
    return {
      status: "session_required",
      platform: "baijiahao",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    };
  }
  const frame = await baijiahaoEditorFrame(page, readTimeoutMs);
  const coverImageCount = await visibleCount(
    page.locator(BAIJIAHAO_COVER_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const inlineImageCount =
    frame === null
      ? 0
      : await visibleCount(frame.locator(BAIJIAHAO_INLINE_PREVIEW_SELECTOR), readTimeoutMs);
  const expected = expectedCounts(expectedMedia);
  return {
    status:
      frame !== null && coverImageCount === expected.cover && inlineImageCount === expected.inline
        ? "ready"
        : "adapter_drift",
    platform: "baijiahao",
    coverImageCount,
    inlineImageCount,
    challengeSignals: [],
  };
}

async function inspectSohu(
  page: PlaywrightPriorityPlatformMediaPage | null,
  expectedMedia: readonly MediaReference[],
  readTimeoutMs: number,
): Promise<PriorityPlatformMediaSurfaceState> {
  if (page === null) {
    return {
      status: "session_required",
      platform: "sohu",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    };
  }
  const challenges = await mediaChallengeSignals(page, "sohu", readTimeoutMs);
  const coverImageCount = await firstObservedVisibleCount(
    page,
    SOHU_COVER_PREVIEW_SELECTORS,
    readTimeoutMs,
  );
  const inlineImageCount = await visibleCount(
    page.locator(SOHU_INLINE_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const expected = expectedCounts(expectedMedia);
  return {
    status:
      challenges.length > 0
        ? "challenge_required"
        : coverImageCount === expected.cover && inlineImageCount === expected.inline
          ? "ready"
          : "adapter_drift",
    platform: "sohu",
    coverImageCount,
    inlineImageCount,
    challengeSignals: challenges,
  };
}

async function inspectNetease(
  page: PlaywrightPriorityPlatformMediaPage | null,
  expectedMedia: readonly MediaReference[],
  readTimeoutMs: number,
): Promise<PriorityPlatformMediaSurfaceState> {
  if (page === null) {
    return {
      status: "session_required",
      platform: "netease",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    };
  }
  const challenges = await mediaChallengeSignals(page, "netease", readTimeoutMs);
  const imageCount = await visibleCount(
    page.locator(NETEASE_IMAGE_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const expected = expectedCounts(expectedMedia);
  const coverImageCount = Math.min(imageCount, expected.cover);
  const inlineImageCount = Math.max(0, imageCount - coverImageCount);
  return {
    status:
      challenges.length > 0
        ? "challenge_required"
        : coverImageCount === expected.cover && inlineImageCount === expected.inline
          ? "ready"
          : "adapter_drift",
    platform: "netease",
    coverImageCount,
    inlineImageCount,
    challengeSignals: challenges,
  };
}

async function inspectZhihu(
  page: PlaywrightPriorityPlatformMediaPage | null,
  expectedMedia: readonly MediaReference[],
  readTimeoutMs: number,
): Promise<PriorityPlatformMediaSurfaceState> {
  if (page === null) {
    return {
      status: "session_required",
      platform: "zhihu",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    };
  }
  const coverImageCount = await visibleCount(
    page.locator(ZHIHU_COVER_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const inlineImageCount = await visibleCount(
    page.locator(ZHIHU_INLINE_PREVIEW_SELECTOR),
    readTimeoutMs,
  );
  const expected = expectedCounts(expectedMedia);
  return {
    status:
      coverImageCount === expected.cover && inlineImageCount === expected.inline
        ? "ready"
        : "adapter_drift",
    platform: "zhihu",
    coverImageCount,
    inlineImageCount,
    challengeSignals: [],
  };
}

export function createPlaywrightPriorityPlatformMediaWriter(options: {
  readonly platform: BrowserPublicationPlatform;
  readonly pages: () => readonly PlaywrightPriorityPlatformMediaPage[];
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly readTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly uploadAttempts?: number;
  readonly pollMs?: number;
}): PriorityPlatformMediaWriter {
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  const uploadAttempts = options.uploadAttempts ?? UPLOAD_ATTEMPTS;
  const pollMs = options.pollMs ?? UPLOAD_POLL_MS;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const editorUrl =
    options.platform === "toutiao"
      ? TOUTIAO_ARTICLE_EDITOR_URL
      : options.platform === "baijiahao"
        ? BAIJIAHAO_ARTICLE_EDITOR_URL
        : options.platform === "sohu"
          ? SOHU_ARTICLE_EDITOR_URL
          : options.platform === "netease"
            ? NETEASE_ARTICLE_EDITOR_URL
            : options.platform === "zhihu"
              ? ZHIHU_ARTICLE_EDITOR_URL
              : null;

  const editorPage = (): PlaywrightPriorityPlatformMediaPage | null => {
    if (editorUrl === null) return null;
    const candidates = options.pages().filter((page) => exactEditorUrl(page.url(), editorUrl));
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  };

  const inspect = (expectedMedia: readonly MediaReference[]) => {
    if (options.platform === "toutiao") {
      return inspectToutiao(editorPage(), expectedMedia, readTimeoutMs);
    }
    if (options.platform === "baijiahao") {
      return inspectBaijiahao(editorPage(), expectedMedia, readTimeoutMs);
    }
    if (options.platform === "sohu") {
      return inspectSohu(editorPage(), expectedMedia, readTimeoutMs);
    }
    if (options.platform === "netease") {
      return inspectNetease(editorPage(), expectedMedia, readTimeoutMs);
    }
    if (options.platform === "zhihu") {
      return inspectZhihu(editorPage(), expectedMedia, readTimeoutMs);
    }
    {
      return Promise.resolve<PriorityPlatformMediaSurfaceState>({
        status: "adapter_drift",
        platform: options.platform,
        coverImageCount: 0,
        inlineImageCount: 0,
        challengeSignals: [],
      });
    }
  };

  return {
    platform: options.platform,
    inspect,
    write: async (attachments) => {
      if (attachments.some(({ reference }) => reference.platform !== options.platform)) {
        throw new TypeError("Priority platform media attachment belongs to another platform");
      }
      const page = editorPage();
      if (page === null) return inspect(attachments.map(({ reference }) => reference));
      await page.bringToFront();
      const covers = attachments.filter(({ reference }) => reference.role === "cover");
      const inline = attachments.filter(({ reference }) => reference.role === "inline");
      if (covers.length > 1 || (attachments.length > 0 && covers.length !== 1)) {
        return {
          status: "adapter_drift",
          platform: options.platform,
          coverImageCount: 0,
          inlineImageCount: 0,
          challengeSignals: [],
        };
      }
      if (options.platform === "sohu" || options.platform === "netease") {
        const initialState = await inspect(attachments.map(({ reference }) => reference));
        if (initialState.status === "challenge_required") return initialState;
      }
      if (options.platform === "baijiahao") {
        let mediaWriteStage = "cover-requirement";
        try {
          const cover = covers[0];
          if (cover === undefined) throw new Error("Baijiahao media requires one cover");
          const mediaRecoveryTimeoutMs = Math.max(
            actionTimeoutMs,
            BAIJIAHAO_MEDIA_RECOVERY_TIMEOUT_MS,
          );
          mediaWriteStage = "cover-count-inspection";
          const existingCoverCount = await visibleCount(
            page.locator(BAIJIAHAO_COVER_PREVIEW_SELECTOR),
            readTimeoutMs,
          );
          if (existingCoverCount > 1) {
            throw new Error(
              `Baijiahao cover image count drifted before upload: received ${existingCoverCount}`,
            );
          }
          mediaWriteStage = "cover-trigger-click";
          await (
            await waitForExactVisibleTextLocator(
              page,
              BAIJIAHAO_COVER_ACTION_SELECTOR,
              BAIJIAHAO_COVER_ACTION_TEXTS,
              readTimeoutMs,
              mediaRecoveryTimeoutMs,
              pollMs,
              wait,
            )
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "cover-local-tab-click";
          await (
            await waitForExactVisibleTextLocator(
              page,
              BAIJIAHAO_LOCAL_UPLOAD_TAB_SELECTOR,
              BAIJIAHAO_LOCAL_UPLOAD_TAB_TEXTS,
              readTimeoutMs,
              mediaRecoveryTimeoutMs,
              pollMs,
              wait,
              true,
            )
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "cover-file-upload";
          await (
            await waitForFirstAttachedLocator(
              page,
              BAIJIAHAO_COVER_INPUT_SELECTOR,
              mediaRecoveryTimeoutMs,
              pollMs,
              wait,
            )
          ).setInputFiles(
            {
              name: `geo-cover-01.${imageExtension(cover.reference.mimeType)}`,
              mimeType: cover.reference.mimeType,
              buffer: Buffer.from(cover.bytes),
            },
            { timeout: actionTimeoutMs },
          );
          mediaWriteStage = "cover-confirm-locate";
          let confirm = await waitForExactVisibleTextLocator(
            page,
            BAIJIAHAO_COVER_CONFIRM_SELECTOR,
            BAIJIAHAO_COVER_CONFIRM_TEXTS,
            readTimeoutMs,
            mediaRecoveryTimeoutMs,
            pollMs,
            wait,
            true,
          );
          const confirmationDeadline = Date.now() + mediaRecoveryTimeoutMs;
          const waitForEnabledConfirmation = async () => {
            if (confirm.isEnabled === undefined) return;
            let enabled = false;
            while (!enabled && Date.now() < confirmationDeadline) {
              enabled = await confirm.isEnabled({ timeout: readTimeoutMs }).catch(() => false);
              if (!enabled && Date.now() < confirmationDeadline) {
                await wait(Math.min(pollMs, Math.max(0, confirmationDeadline - Date.now())));
              }
            }
            if (!enabled) throw new Error("Baijiahao cover confirmation is disabled");
          };
          let coverModalClosed = false;
          do {
            mediaWriteStage = "cover-confirm-enable";
            await waitForEnabledConfirmation();
            mediaWriteStage = "cover-confirm-click";
            await confirm.click({ timeout: actionTimeoutMs });
            mediaWriteStage = "cover-confirm-settle";
            if (
              (await visibleCount(page.locator(BAIJIAHAO_COVER_MODAL_SELECTOR), readTimeoutMs)) ===
              0
            ) {
              coverModalClosed = true;
              break;
            }
            if (Date.now() >= confirmationDeadline) break;
            await wait(Math.min(pollMs, Math.max(0, confirmationDeadline - Date.now())));
            if (
              (await visibleCount(page.locator(BAIJIAHAO_COVER_MODAL_SELECTOR), readTimeoutMs)) ===
              0
            ) {
              coverModalClosed = true;
              break;
            }
            if (Date.now() >= confirmationDeadline) break;
            confirm = await waitForExactVisibleTextLocator(
              page,
              BAIJIAHAO_COVER_CONFIRM_SELECTOR,
              BAIJIAHAO_COVER_CONFIRM_TEXTS,
              readTimeoutMs,
              Math.max(readTimeoutMs, confirmationDeadline - Date.now()),
              pollMs,
              wait,
              true,
            );
          } while (Date.now() < confirmationDeadline);
          if (!coverModalClosed) {
            throw new Error("Baijiahao cover confirmation modal did not close");
          }
          mediaWriteStage = "inline-editor-frame";
          const frame = await waitForBaijiahaoEditorFrame(
            page,
            readTimeoutMs,
            mediaRecoveryTimeoutMs,
            pollMs,
            wait,
          );
          if (frame === null) return inspect(attachments.map(({ reference }) => reference));
          for (const [index, attachment] of inline.entries()) {
            const inlineStage = `inline-${index + 1}`;
            mediaWriteStage = `${inlineStage}-precheck`;
            const beforeCount = await visibleCount(
              frame.locator(BAIJIAHAO_INLINE_PREVIEW_SELECTOR),
              readTimeoutMs,
            );
            if (beforeCount !== index) {
              throw new Error(
                `Baijiahao inline image count drifted before upload: expected ${index}, received ${beforeCount}`,
              );
            }
            const inlineModalDeadline = Date.now() + mediaRecoveryTimeoutMs;
            let inlineModalOpened: boolean;
            do {
              mediaWriteStage = `${inlineStage}-caret`;
              const caretRestored = await frame
                .evaluate(restoreEditorCaretAtEnd, BAIJIAHAO_INLINE_EDITOR_SELECTOR)
                .catch(() => false);
              if (!caretRestored) {
                throw new Error("Baijiahao inline editor caret could not be restored");
              }
              mediaWriteStage = `${inlineStage}-trigger-click`;
              let triggerClickError: unknown;
              try {
                await (
                  await waitForExactEnabledVisibleLocator(
                    page,
                    BAIJIAHAO_INLINE_TRIGGER_SELECTOR,
                    readTimeoutMs,
                    Math.max(readTimeoutMs, inlineModalDeadline - Date.now()),
                    pollMs,
                    wait,
                  )
                ).click({ timeout: actionTimeoutMs });
              } catch (error) {
                triggerClickError = error;
              }
              mediaWriteStage = `${inlineStage}-modal-open`;
              const visibleInlineModalCount = await visibleCount(
                page.locator(BAIJIAHAO_INLINE_MODAL_SELECTOR),
                readTimeoutMs,
              );
              const inlineInputCount = await page.locator(BAIJIAHAO_INLINE_INPUT_SELECTOR).count();
              inlineModalOpened = visibleInlineModalCount > 0 && inlineInputCount === 1;
              if (triggerClickError !== undefined && !inlineModalOpened) throw triggerClickError;
              if (inlineModalOpened || Date.now() >= inlineModalDeadline) break;
              await wait(Math.min(pollMs, Math.max(0, inlineModalDeadline - Date.now())));
            } while (Date.now() < inlineModalDeadline);
            if (!inlineModalOpened) {
              throw new Error("Baijiahao inline image modal did not open");
            }
            mediaWriteStage = `${inlineStage}-file-upload`;
            await (
              await waitForExactAttachedLocator(
                page,
                BAIJIAHAO_INLINE_INPUT_SELECTOR,
                mediaRecoveryTimeoutMs,
                pollMs,
                wait,
              )
            ).setInputFiles(
              {
                name: `geo-inline-${String(index + 2).padStart(2, "0")}.${imageExtension(
                  attachment.reference.mimeType,
                )}`,
                mimeType: attachment.reference.mimeType,
                buffer: Buffer.from(attachment.bytes),
              },
              { timeout: actionTimeoutMs },
            );
            mediaWriteStage = `${inlineStage}-confirm-locate`;
            let inlineConfirm = await waitForExactVisibleTextLocator(
              page,
              BAIJIAHAO_INLINE_CONFIRM_SELECTOR,
              BAIJIAHAO_INLINE_CONFIRM_TEXTS,
              readTimeoutMs,
              mediaRecoveryTimeoutMs,
              pollMs,
              wait,
              true,
            );
            const inlineConfirmationDeadline = Date.now() + mediaRecoveryTimeoutMs;
            let inlineConfirmed = false;
            let inlineConfirmationClicked = false;
            do {
              const inlineConfirmationEnabled =
                inlineConfirm.isEnabled === undefined ||
                (await inlineConfirm.isEnabled({ timeout: readTimeoutMs }).catch(() => false));
              if (!inlineConfirmationClicked && inlineConfirmationEnabled) {
                mediaWriteStage = `${inlineStage}-confirm-click`;
                await inlineConfirm.click({ timeout: actionTimeoutMs });
                inlineConfirmationClicked = true;
              }
              mediaWriteStage = `${inlineStage}-confirm-settle`;
              const modalCount = await visibleCount(
                page.locator(BAIJIAHAO_INLINE_MODAL_SELECTOR),
                readTimeoutMs,
              );
              const confirmationCount = await visibleCount(
                page.locator(BAIJIAHAO_INLINE_CONFIRM_SELECTOR),
                readTimeoutMs,
              );
              const afterCount = await visibleCount(
                frame.locator(BAIJIAHAO_INLINE_PREVIEW_SELECTOR),
                readTimeoutMs,
              );
              if (afterCount > beforeCount + 1) {
                throw new Error(
                  `Baijiahao inline image count drifted after upload: expected ${beforeCount + 1}, received ${afterCount}`,
                );
              }
              if (afterCount === beforeCount + 1 && (modalCount === 0 || confirmationCount === 0)) {
                inlineConfirmed = true;
                break;
              }
              if (Date.now() >= inlineConfirmationDeadline) break;
              await wait(Math.min(pollMs, Math.max(0, inlineConfirmationDeadline - Date.now())));
              if (Date.now() >= inlineConfirmationDeadline) break;
              if (!inlineConfirmationClicked) {
                inlineConfirm = await waitForExactVisibleTextLocator(
                  page,
                  BAIJIAHAO_INLINE_CONFIRM_SELECTOR,
                  BAIJIAHAO_INLINE_CONFIRM_TEXTS,
                  readTimeoutMs,
                  Math.max(readTimeoutMs, inlineConfirmationDeadline - Date.now()),
                  pollMs,
                  wait,
                  true,
                );
              }
            } while (Date.now() < inlineConfirmationDeadline);
            if (!inlineConfirmed) {
              throw new Error("Baijiahao inline image confirmation did not complete");
            }
          }
          const references = attachments.map(({ reference }) => reference);
          mediaWriteStage = "final-media-inspection";
          let state = await inspect(references);
          for (
            let attempt = 0;
            attempt < uploadAttempts && state.status !== "ready";
            attempt += 1
          ) {
            await wait(pollMs);
            state = await inspect(references);
          }
          return state;
        } catch (error) {
          if (error instanceof PriorityPlatformMediaWriteError) throw error;
          throw new PriorityPlatformMediaWriteError("baijiahao", mediaWriteStage, error);
        }
      }
      if (options.platform === "sohu") {
        let mediaWriteStage = "cover-requirement";
        try {
          const cover = covers[0];
          if (cover === undefined) throw new Error("Sohu media requires one cover");
          mediaWriteStage = "cover-trigger-click";
          await (
            await exactVisibleLocator(page, SOHU_COVER_TRIGGER_SELECTOR, readTimeoutMs)
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "cover-local-tab-click";
          await (
            await exactVisibleTextLocator(
              page,
              SOHU_LOCAL_UPLOAD_TAB_SELECTOR,
              "本地上传",
              readTimeoutMs,
            )
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "cover-file-upload";
          await (
            await exactAttachedLocator(page, SOHU_COVER_INPUT_SELECTOR)
          ).setInputFiles(
            {
              name: `geo-cover-01.${imageExtension(cover.reference.mimeType)}`,
              mimeType: cover.reference.mimeType,
              buffer: Buffer.from(cover.bytes),
            },
            { timeout: actionTimeoutMs },
          );
          mediaWriteStage = "cover-confirm-locate";
          const confirm = await waitForExactVisibleTextLocator(
            page,
            SOHU_COVER_CONFIRM_SELECTOR,
            "确定",
            readTimeoutMs,
            actionTimeoutMs,
            pollMs,
            wait,
          );
          mediaWriteStage = "cover-confirm-click";
          await confirm.click({ timeout: actionTimeoutMs });
          mediaWriteStage = "cover-confirm-settle";
          const coverSettleDeadline = Date.now() + actionTimeoutMs;
          let coverSettled = false;
          do {
            const coverImageCount = await firstObservedVisibleCount(
              page,
              SOHU_COVER_PREVIEW_SELECTORS,
              readTimeoutMs,
            );
            const coverModalCount = await visibleCount(
              page.locator(SOHU_COVER_MODAL_SELECTOR),
              readTimeoutMs,
            );
            if (coverImageCount > 1 || coverModalCount > 1) {
              throw new Error(
                `Sohu cover confirmation drifted: cover=${coverImageCount}, modal=${coverModalCount}`,
              );
            }
            if (coverImageCount === 1 && coverModalCount === 0) {
              coverSettled = true;
              break;
            }
            if (Date.now() >= coverSettleDeadline) break;
            await wait(Math.min(pollMs, Math.max(0, coverSettleDeadline - Date.now())));
          } while (Date.now() < coverSettleDeadline);
          if (!coverSettled) {
            throw new Error("Sohu cover confirmation did not settle");
          }
          for (const [index, attachment] of inline.entries()) {
            const inlineStage = `inline-${index + 1}`;
            mediaWriteStage = `${inlineStage}-editor`;
            const beforeCount = await visibleCount(
              page.locator(SOHU_INLINE_PREVIEW_SELECTOR),
              readTimeoutMs,
            );
            await (
              await exactVisibleLocator(page, SOHU_INLINE_EDITOR_SELECTOR, readTimeoutMs)
            ).click({ timeout: actionTimeoutMs });
            mediaWriteStage = `${inlineStage}-dispatch`;
            await page.evaluate(dispatchTrustedImageEvent, {
              targetSelector: SOHU_INLINE_EDITOR_SELECTOR,
              eventType: "paste",
              fileName: `geo-inline-${String(index + 2).padStart(2, "0")}.${imageExtension(
                attachment.reference.mimeType,
              )}`,
              mimeType: attachment.reference.mimeType,
              bytes: Array.from(attachment.bytes),
            });
            mediaWriteStage = `${inlineStage}-settle`;
            const inlineSettleDeadline = Date.now() + actionTimeoutMs;
            let inlineSettled = false;
            do {
              const afterCount = await visibleCount(
                page.locator(SOHU_INLINE_PREVIEW_SELECTOR),
                readTimeoutMs,
              );
              if (afterCount > beforeCount + 1) {
                throw new Error(
                  `Sohu inline image count drifted after upload: expected ${beforeCount + 1}, received ${afterCount}`,
                );
              }
              if (afterCount === beforeCount + 1) {
                inlineSettled = true;
                break;
              }
              if (Date.now() >= inlineSettleDeadline) break;
              await wait(Math.min(pollMs, Math.max(0, inlineSettleDeadline - Date.now())));
            } while (Date.now() < inlineSettleDeadline);
            if (!inlineSettled) {
              throw new Error(`Sohu inline image did not settle: expected ${beforeCount + 1}`);
            }
          }
          const references = attachments.map(({ reference }) => reference);
          mediaWriteStage = "final-media-inspection";
          let state = await inspect(references);
          for (
            let attempt = 0;
            attempt < uploadAttempts && state.status !== "ready";
            attempt += 1
          ) {
            await wait(pollMs);
            state = await inspect(references);
          }
          return state;
        } catch (error) {
          if (error instanceof PriorityPlatformMediaWriteError) throw error;
          throw new PriorityPlatformMediaWriteError("sohu", mediaWriteStage, error);
        }
      }
      if (options.platform === "netease") {
        let mediaWriteStage = "cover-requirement";
        try {
          const orderedAttachments = [...covers, ...inline];
          const expectedImageCount = orderedAttachments.length;
          if (expectedImageCount === 0) {
            throw new Error("Netease media requires one cover and at least one image");
          }
          mediaWriteStage = "editor-image-count-inspection";
          const existingImageCount = await visibleCount(
            page.locator(NETEASE_IMAGE_PREVIEW_SELECTOR),
            readTimeoutMs,
          );
          if (existingImageCount !== 0) {
            throw new Error(
              `Netease editor contains stale images before upload: received ${existingImageCount}`,
            );
          }
          mediaWriteStage = "auto-cover-select";
          await (
            await exactVisibleLocator(page, NETEASE_AUTO_COVER_SELECTOR, readTimeoutMs)
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "auto-cover-readback";
          const autoCover = await exactVisibleLocator(
            page,
            NETEASE_AUTO_COVER_INPUT_SELECTOR,
            readTimeoutMs,
          );
          if (
            autoCover.isChecked === undefined ||
            !(await autoCover.isChecked({ timeout: readTimeoutMs }).catch(() => false))
          ) {
            throw new Error("Netease automatic cover selection did not persist");
          }
          mediaWriteStage = "image-trigger-click";
          await (
            await exactVisibleLocator(page, NETEASE_IMAGE_TRIGGER_SELECTOR, readTimeoutMs)
          ).click({ timeout: actionTimeoutMs });
          mediaWriteStage = "image-modal-open";
          await exactVisibleLocator(page, NETEASE_IMAGE_MODAL_SELECTOR, readTimeoutMs);
          const modalChallenges = await mediaChallengeSignals(page, "netease", readTimeoutMs);
          if (modalChallenges.length > 0) {
            return {
              status: "challenge_required",
              platform: "netease",
              coverImageCount: 0,
              inlineImageCount: 0,
              challengeSignals: modalChallenges,
            };
          }
          mediaWriteStage = "image-watermark-option";
          const watermarkWait = await waitForNeteaseWatermarkOption(
            page,
            readTimeoutMs,
            actionTimeoutMs,
            pollMs,
            wait,
          );
          if (watermarkWait.status === "challenge_required") {
            return {
              status: "challenge_required",
              platform: "netease",
              coverImageCount: 0,
              inlineImageCount: 0,
              challengeSignals: watermarkWait.challengeSignals,
            };
          }
          const { watermarkOption } = watermarkWait;
          if (watermarkOption.locator === undefined) {
            throw new Error("Netease watermark control cannot be scoped to its option");
          }
          const watermarkInput = watermarkOption.locator(NETEASE_WATERMARK_INPUT_SELECTOR);
          if ((await watermarkInput.count()) !== 1) {
            throw new Error("Netease watermark checkbox is not unique");
          }
          if (watermarkInput.isChecked === undefined || watermarkOption.locator === undefined) {
            throw new Error("Netease watermark control cannot be inspected");
          }
          if (await watermarkInput.isChecked({ timeout: readTimeoutMs }).catch(() => true)) {
            mediaWriteStage = "image-watermark-disable";
            const watermarkToggle = watermarkOption.locator(NETEASE_WATERMARK_TOGGLE_SELECTOR);
            if ((await visibleCount(watermarkToggle, readTimeoutMs)) !== 1) {
              throw new Error("Netease watermark toggle is not unique");
            }
            await watermarkToggle.click({ timeout: actionTimeoutMs });
          }
          mediaWriteStage = "image-watermark-readback";
          if (await watermarkInput.isChecked({ timeout: readTimeoutMs }).catch(() => true)) {
            throw new Error("Netease upload watermark remains enabled");
          }
          mediaWriteStage = "image-file-upload";
          await (
            await exactAttachedModalDescendant(
              page,
              NETEASE_IMAGE_MODAL_SELECTOR,
              NETEASE_IMAGE_INPUT_WITHIN_MODAL_SELECTOR,
              readTimeoutMs,
            )
          ).setInputFiles(neteaseMediaFiles(orderedAttachments), { timeout: actionTimeoutMs });
          mediaWriteStage = "image-preview-readback";
          const previewDeadline = Date.now() + actionTimeoutMs;
          let stagedPreviewCount = 0;
          do {
            stagedPreviewCount = await visibleCount(
              page.locator(NETEASE_UPLOAD_PREVIEW_SELECTOR),
              readTimeoutMs,
            );
            if (stagedPreviewCount === expectedImageCount) break;
            if (stagedPreviewCount > expectedImageCount || Date.now() >= previewDeadline) break;
            await wait(Math.min(pollMs, Math.max(0, previewDeadline - Date.now())));
          } while (Date.now() < previewDeadline);
          if (stagedPreviewCount !== expectedImageCount) {
            throw new Error(
              `Netease upload preview count drifted: expected ${expectedImageCount}, received ${stagedPreviewCount}`,
            );
          }
          mediaWriteStage = "image-confirm-enable";
          const confirm = await waitForExactEnabledVisibleModalDescendant(
            page,
            NETEASE_IMAGE_MODAL_SELECTOR,
            NETEASE_UPLOAD_CONFIRM_WITHIN_MODAL_SELECTOR,
            readTimeoutMs,
            actionTimeoutMs,
            pollMs,
            wait,
          );
          mediaWriteStage = "image-confirm-click";
          await confirm.click({ timeout: actionTimeoutMs });
          mediaWriteStage = "editor-image-readback";
          const editorDeadline = Date.now() + actionTimeoutMs;
          let editorImageCount = 0;
          let imageModalClosed = false;
          do {
            const modalCount = await visibleCount(
              page.locator(NETEASE_IMAGE_MODAL_SELECTOR),
              readTimeoutMs,
            );
            editorImageCount = await visibleCount(
              page.locator(NETEASE_IMAGE_PREVIEW_SELECTOR),
              readTimeoutMs,
            );
            if (modalCount === 0 && editorImageCount === expectedImageCount) {
              imageModalClosed = true;
              break;
            }
            if (editorImageCount > expectedImageCount || Date.now() >= editorDeadline) break;
            await wait(Math.min(pollMs, Math.max(0, editorDeadline - Date.now())));
          } while (Date.now() < editorDeadline);
          if (!imageModalClosed || editorImageCount !== expectedImageCount) {
            throw new Error(
              `Netease image confirmation did not settle: expected ${expectedImageCount}, received ${editorImageCount}`,
            );
          }
          return inspect(attachments.map(({ reference }) => reference));
        } catch (error) {
          if (error instanceof PriorityPlatformMediaWriteError) throw error;
          throw new PriorityPlatformMediaWriteError("netease", mediaWriteStage, error);
        }
      }
      if (options.platform === "zhihu") {
        let mediaWriteStage = "cover-requirement";
        try {
          const cover = covers[0];
          if (cover === undefined) throw new Error("Zhihu media requires one cover");
          mediaWriteStage = "cover-file-upload";
          await (
            await exactAttachedLocator(page, ZHIHU_COVER_INPUT_SELECTOR)
          ).setInputFiles(
            {
              name: `geo-cover-01.${imageExtension(cover.reference.mimeType)}`,
              mimeType: cover.reference.mimeType,
              buffer: Buffer.from(cover.bytes),
            },
            { timeout: actionTimeoutMs },
          );
          mediaWriteStage = "cover-readback";
          const coverDeadline = Date.now() + actionTimeoutMs;
          while (Date.now() < coverDeadline) {
            if (
              (await visibleCount(page.locator(ZHIHU_COVER_PREVIEW_SELECTOR), readTimeoutMs)) === 1
            )
              break;
            await wait(Math.min(pollMs, Math.max(0, coverDeadline - Date.now())));
          }
          if (
            (await visibleCount(page.locator(ZHIHU_COVER_PREVIEW_SELECTOR), readTimeoutMs)) !== 1
          ) {
            throw new Error("Zhihu cover upload did not produce one preview");
          }
          for (const [index, attachment] of inline.entries()) {
            const inlineStage = `inline-${index + 1}`;
            mediaWriteStage = `${inlineStage}-trigger-click`;
            await (
              await exactVisibleLocator(page, ZHIHU_INLINE_TRIGGER_SELECTOR, readTimeoutMs)
            ).click({ timeout: actionTimeoutMs });
            mediaWriteStage = `${inlineStage}-file-upload`;
            await (
              await waitForFirstAttachedLocator(
                page,
                ZHIHU_INLINE_INPUT_SELECTOR,
                actionTimeoutMs,
                pollMs,
                wait,
              )
            ).setInputFiles(
              {
                name: `geo-inline-${String(index + 2).padStart(2, "0")}.${imageExtension(
                  attachment.reference.mimeType,
                )}`,
                mimeType: attachment.reference.mimeType,
                buffer: Buffer.from(attachment.bytes),
              },
              { timeout: actionTimeoutMs },
            );
            mediaWriteStage = `${inlineStage}-readback`;
            const expectedCount = index + 1;
            const inlineDeadline = Date.now() + actionTimeoutMs;
            while (Date.now() < inlineDeadline) {
              if (
                (await visibleCount(page.locator(ZHIHU_INLINE_PREVIEW_SELECTOR), readTimeoutMs)) ===
                expectedCount
              )
                break;
              await wait(Math.min(pollMs, Math.max(0, inlineDeadline - Date.now())));
            }
            if (
              (await visibleCount(page.locator(ZHIHU_INLINE_PREVIEW_SELECTOR), readTimeoutMs)) !==
              expectedCount
            ) {
              throw new Error(`Zhihu inline image count drifted: expected ${expectedCount}`);
            }
          }
          mediaWriteStage = "final-media-inspection";
          let state = await inspect(attachments.map(({ reference }) => reference));
          for (
            let attempt = 0;
            attempt < uploadAttempts && state.status !== "ready";
            attempt += 1
          ) {
            await wait(pollMs);
            state = await inspect(attachments.map(({ reference }) => reference));
          }
          return state;
        } catch (error) {
          if (error instanceof PriorityPlatformMediaWriteError) throw error;
          throw new PriorityPlatformMediaWriteError("zhihu", mediaWriteStage, error);
        }
      }
      await page.evaluate(removeToutiaoStaleMedia, { resetToutiaoMedia: true });
      await wait(TOUTIAO_RESET_SETTLE_MS);
      const staleCoverCount = await visibleCount(
        page.locator(TOUTIAO_COVER_PREVIEW_SELECTOR),
        readTimeoutMs,
      );
      const staleInlineCount = await visibleCount(
        page.locator(TOUTIAO_INLINE_PREVIEW_SELECTOR),
        readTimeoutMs,
      );
      if (staleCoverCount !== 0 || staleInlineCount !== 0) {
        return {
          status: "adapter_drift",
          platform: "toutiao",
          coverImageCount: staleCoverCount,
          inlineImageCount: staleInlineCount,
          challengeSignals: [],
        };
      }
      const cover = covers[0];
      if (cover !== undefined) {
        await (
          await exactVisibleLocator(page, TOUTIAO_COVER_ENTRY_SELECTOR, readTimeoutMs)
        ).click({ timeout: actionTimeoutMs });
        await (
          await exactVisibleLocator(page, TOUTIAO_LOCAL_UPLOAD_SELECTOR, readTimeoutMs)
        ).click({ timeout: actionTimeoutMs });
        await (
          await exactVisibleLocator(page, TOUTIAO_FILE_INPUT_SELECTOR, readTimeoutMs)
        ).setInputFiles(
          {
            name: `geo-cover-01.${imageExtension(cover.reference.mimeType)}`,
            mimeType: cover.reference.mimeType,
            buffer: Buffer.from(cover.bytes),
          },
          { timeout: actionTimeoutMs },
        );
        const confirm = await exactVisibleLocator(
          page,
          TOUTIAO_UPLOAD_CONFIRM_SELECTOR,
          readTimeoutMs,
        );
        await wait(TOUTIAO_WRITE_SETTLE_MS);
        if (confirm.isEnabled !== undefined) {
          let enabled = false;
          const deadline = Date.now() + actionTimeoutMs;
          while (!enabled && Date.now() < deadline) {
            enabled = await confirm.isEnabled({ timeout: readTimeoutMs }).catch(() => false);
            if (!enabled) {
              await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
            }
          }
          if (!enabled) throw new Error("Toutiao cover confirmation is disabled");
        }
        await confirm.click({ timeout: actionTimeoutMs });
      }

      for (const [index, attachment] of inline.entries()) {
        const before = await visibleCount(
          page.locator(TOUTIAO_INLINE_PREVIEW_SELECTOR),
          readTimeoutMs,
        );
        await (
          await exactVisibleLocator(page, TOUTIAO_INLINE_EDITOR_SELECTOR, readTimeoutMs)
        ).click({ timeout: actionTimeoutMs });
        await page.evaluate(dispatchTrustedImageEvent, {
          targetSelector: TOUTIAO_INLINE_EDITOR_SELECTOR,
          eventType: "paste",
          fileName: `geo-inline-${String(index + 2).padStart(2, "0")}.${imageExtension(
            attachment.reference.mimeType,
          )}`,
          mimeType: attachment.reference.mimeType,
          bytes: Array.from(attachment.bytes),
        });
        await wait(TOUTIAO_WRITE_SETTLE_MS);
        let inserted =
          (await visibleCount(page.locator(TOUTIAO_INLINE_PREVIEW_SELECTOR), readTimeoutMs)) >
          before;
        for (let attempt = 0; attempt < uploadAttempts && !inserted; attempt += 1) {
          await wait(pollMs);
          inserted =
            (await visibleCount(page.locator(TOUTIAO_INLINE_PREVIEW_SELECTOR), readTimeoutMs)) >
            before;
        }
        if (!inserted) {
          return inspect(attachments.map(({ reference }) => reference));
        }
      }

      const references = attachments.map(({ reference }) => reference);
      let state = await inspect(references);
      for (let attempt = 0; attempt < uploadAttempts && state.status !== "ready"; attempt += 1) {
        await wait(pollMs);
        state = await inspect(references);
      }
      return state;
    },
  };
}
