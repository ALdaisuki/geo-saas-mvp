import { normalizeCtripPublicContent, renderCtripPublicBodyFromMarkdown } from "@geo/core";

export type BrowserPublicationPlatform = "toutiao" | "sohu" | "baijiahao" | "netease" | "zhihu";

export interface PlaywrightPublicationLocator {
  count(): Promise<number>;
  nth(index: number): PlaywrightPublicationLocator;
  first(): PlaywrightPublicationLocator;
  locator?(selector: string): PlaywrightPublicationLocator;
  isVisible(options?: { readonly timeout?: number }): Promise<boolean>;
  isEnabled?(options?: { readonly timeout?: number }): Promise<boolean>;
  fill(value: string, options?: { readonly timeout?: number }): Promise<void>;
  inputValue?(options?: { readonly timeout?: number }): Promise<string>;
  innerText?(options?: { readonly timeout?: number }): Promise<string>;
  textContent(options?: { readonly timeout?: number }): Promise<string | null>;
  getAttribute?(name: string, options?: { readonly timeout?: number }): Promise<string | null>;
  click(options?: { readonly timeout?: number }): Promise<void>;
  evaluate?<Result, Argument>(
    pageFunction: (node: PublicationDomNode, argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

interface PublicationDomNode {
  cloneNode(deep: boolean): PublicationDomNode;
  getBoundingClientRect?(): {
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
  readonly children: ArrayLike<PublicationDomNode>;
  readonly innerText?: string;
  readonly ownerDocument?: {
    readonly defaultView?: {
      readonly innerWidth: number;
      readonly innerHeight: number;
      getComputedStyle(node: PublicationDomNode): {
        readonly display: string;
        readonly visibility: string;
        readonly opacity: string;
      };
    } | null;
  };
  readonly parentElement?: PublicationDomNode | null;
  readonly textContent: string | null;
}

export interface PlaywrightPublicationFrame {
  url(): string;
  locator(selector: string): PlaywrightPublicationLocator;
}

export interface PlaywrightPublicationPage extends PlaywrightPublicationFrame {
  bringToFront(): Promise<void>;
  frames?(): readonly PlaywrightPublicationFrame[];
  evaluate?<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
  title?(): Promise<string>;
  goto?(
    url: string,
    options?: { readonly timeout?: number; readonly waitUntil?: "domcontentloaded" },
  ): Promise<unknown>;
  waitForLoadState?(
    state?: "domcontentloaded",
    options?: { readonly timeout?: number },
  ): Promise<void>;
  close?(): Promise<void>;
}

export interface PlatformSourceReference {
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly sourcePaths: readonly string[];
  readonly licenseSpdx: "Apache-2.0" | "MIT" | null;
}

export interface PlatformPublicSurfaceDefinition {
  readonly titleSelectors: readonly string[];
  readonly bodySelectors: readonly string[];
  readonly authorSelectors: readonly string[];
  canonicalizeUrl(value: string): { readonly id: string; readonly url: string } | null;
  urlForId(id: string): string | null;
}

export interface PlatformCreatorManagementSurfaceDefinition {
  readonly url: string;
  readonly itemSelector: string;
  readonly titleLinkSelector: string;
  readonly titleSelector?: string;
  readonly itemLinkSelector?: string;
  readonly timestampSelector: string;
  readonly statusSelector: string;
  readonly publicStatusLabels: readonly string[];
  readonly pendingStatusLabels?: readonly string[];
  readonly rejectedStatusLabels?: readonly string[];
  readonly draftStatusLabels?: readonly string[];
  readonly rejectionReasons?: readonly {
    readonly pattern: RegExp;
    readonly code: string;
    readonly signal: string;
  }[];
  /**
   * Some platforms keep the exact moderation reason in an authenticated
   * management response instead of rendering it in the visible row. This
   * hook is read-only and may return only a minimal, already-sanitized reason.
   */
  readonly resolveRejectionReason?: (input: {
    readonly page: PlaywrightPublicationPage;
    readonly expectedTitle: string;
    readonly submittedAt: string;
    readonly itemUrls: readonly string[];
  }) => Promise<string | null>;
  /**
   * Some creator centers render a canonical public link only after moderation
   * succeeds. In that case the link is stronger status evidence than a
   * localized or missing row label.
   */
  readonly canonicalPublicLinkConfirmsPublished?: boolean;
  canonicalizeItemUrl(value: string): { readonly id: string; readonly url: string } | null;
  timestampMatches(value: string, submittedAt: string, observedAt?: Date): boolean;
}

export interface PlatformPublicationDefinition {
  readonly schemaVersion: "geo.browser-publication-surface.v1";
  readonly platform: BrowserPublicationPlatform;
  readonly adapterVersion: string;
  readonly editorUrl: string;
  readonly editorUrlMatcher?: (value: string) => boolean;
  readonly source: PlatformSourceReference;
  readonly resetDraftOnWrite?: boolean;
  readonly editorPayloadWriter?: "baijiahao_ueditor_v2";
  readonly bodyEditorScope?: "page" | "page_or_unique_frame";
  readonly editorTextDecorationsToStrip?: readonly string[];
  readonly bodyTextExcludedSelectors?: readonly string[];
  /**
   * Some public surfaces preserve authored characters but collapse every
   * editor block boundary. `ignore` still requires an exact non-whitespace
   * character stream and must only be enabled from captured platform output.
   */
  readonly publicBodyWhitespaceMode?: "ignore";
  readonly titleSelectors: readonly string[];
  readonly bodySelectors: readonly string[];
  readonly actionSelector: string;
  readonly primaryActionLabels: readonly string[];
  readonly finalActionSelectors?: readonly string[];
  readonly finalActionLabels: readonly string[];
  readonly submissionMode: "preview_then_confirm" | "direct_with_optional_confirm";
  readonly resultSelectors: readonly string[];
  readonly challengeSelectors: readonly string[];
  readonly acceptedSignals: readonly RegExp[];
  readonly rejectedSignals: readonly RegExp[];
  readonly noMediaOption?: {
    readonly actionSelector: string;
    readonly actionLabel: string;
    readonly selectedDescendantSelector: string;
  };
  readonly creatorManagementSurface?: PlatformCreatorManagementSurfaceDefinition;
  /**
   * A separate creator-center view for saved drafts. A matching row here is
   * evidence that the platform retained the editor draft rather than accepted
   * the publish attempt, so it must never be promoted to public readback.
   */
  readonly creatorDraftManagementSurface?: PlatformCreatorManagementSurfaceDefinition;
  readonly publicSurface: PlatformPublicSurfaceDefinition;
  /**
   * Some platforms expose a public creator nickname that is intentionally
   * different from the operator's internal account alias. In that mode the
   * canonical candidate URL plus title/body coverage bind the article; the
   * public author still must be non-empty, but it is not compared literally.
   */
  readonly publicAuthorIdentityMode?: "strict" | "candidate_url_bound";
}

export interface PlatformPreparedSurfaceState {
  readonly status: "ready" | "session_required" | "challenge_required" | "adapter_drift";
  readonly platform: BrowserPublicationPlatform;
  readonly adapterVersion: string;
  readonly targetPageCount: number;
  readonly titleEditorCount: number;
  readonly bodyEditorCount: number;
  readonly primaryActionCount: number;
  readonly expectedMediaCount: number;
  readonly titleText: string;
  readonly bodyText: string;
  readonly challengeSignals: readonly string[];
}

export interface PlatformSubmissionResult {
  readonly outcome: "accepted" | "uncertain" | "rejected" | "not_accepted";
  readonly signal: string;
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
}

export interface PlatformPublicReadbackInput {
  readonly candidateExternalId: string | null;
  readonly candidateExternalUrl: string | null;
  readonly expectedAccountName: string;
  readonly expectedTitle: string;
  readonly expectedBody: string;
  readonly submittedAt?: string | null;
}

export interface PlatformPublicReadbackResult {
  readonly outcome:
    | "publisher_confirmed"
    | "publisher_rejected"
    | "confirmed"
    | "not_found"
    | "mismatch"
    | "unavailable";
  // A creator-management row can supply a platform-approved candidate before
  // the anonymous public surface is independently confirmable.
  readonly candidateExternalId?: string | null;
  readonly candidateExternalUrl?: string | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly observedAccountName: string;
  readonly observedTitle: string;
  readonly observedBody: string;
  readonly signal: string;
  readonly publisherReasonCode?: string | null;
}

export interface PlaywrightPlatformPublicationAdapter {
  readonly definition: PlatformPublicationDefinition;
  writeDraft(input: {
    readonly title: string;
    readonly body: string;
    readonly mediaCount?: number;
  }): Promise<PlatformPreparedSurfaceState>;
  inspectPrepared(input?: { readonly mediaCount?: number }): Promise<PlatformPreparedSurfaceState>;
  submitOnce(expectedPrepared: PlatformPreparedSurfaceState): Promise<PlatformSubmissionResult>;
  readback(input: PlatformPublicReadbackInput): Promise<PlatformPublicReadbackResult>;
}

export type PlatformDraftWriteStage =
  "editor-controls" | "title-fill" | "body-fill" | "payload-readback";

export class PlatformDraftWriteError extends Error {
  constructor(
    readonly platform: BrowserPublicationPlatform,
    readonly stage: PlatformDraftWriteStage,
    readonly originalError?: unknown,
  ) {
    super(`${platform} draft write failed at ${stage}`);
    this.name = "PlatformDraftWriteError";
  }
}

interface BaijiahaoUeditorV2Instance {
  __bjh_news_setTitle(value: string): void;
  setContent(value: string, append?: boolean): void;
  fireEvent?(event: string): void;
  sync?(): void;
}

interface BaijiahaoUeditorV2Globals {
  readonly UE_V2?: {
    readonly instants?: Readonly<Record<string, BaijiahaoUeditorV2Instance>>;
  };
}

function writeBaijiahaoUeditorV2Payload(input: {
  readonly title: string;
  readonly body: string;
  readonly bodyHtml: string;
}): boolean {
  const browser = globalThis as unknown as BaijiahaoUeditorV2Globals;
  const editors = Object.values(browser.UE_V2?.instants ?? {}).filter(
    (editor) =>
      typeof editor.__bjh_news_setTitle === "function" && typeof editor.setContent === "function",
  );
  if (editors.length !== 1) return false;
  const editor = editors[0] as BaijiahaoUeditorV2Instance;
  editor.__bjh_news_setTitle(input.title);
  editor.setContent(input.bodyHtml, false);
  editor.fireEvent?.("contentchange");
  editor.sync?.();
  return true;
}

function plainTextParagraphHtml(value: string): string {
  const escape = (text: string): string =>
    text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `<p>${line.length === 0 ? "<br>" : escape(line)}</p>`)
    .join("");
}

const DEFAULT_READ_TIMEOUT_MS = 1_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_READBACK_ATTEMPTS = 20;
// Platform creator editors hydrate asynchronously. Keep editor readiness
// separate from payload readback so a slow first render is not misclassified
// as an adapter drift.
const DEFAULT_EDITOR_READY_ATTEMPTS = 60;
const MAX_EDITOR_READY_ATTEMPTS = 240;
const DEFAULT_SUBMIT_OBSERVATION_ATTEMPTS = 60;
const DEFAULT_POLL_MS = 250;
const MAX_LOCATOR_COUNT = 100;
const MAX_SIGNAL_LENGTH = 500;

function normalizedText(value: string | null): string {
  return (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

function sameText(left: string, right: string): boolean {
  return normalizedText(left) === normalizedText(right);
}

export type PlatformPayloadTextKind = "title" | "body";

const HTML_ENTITY_VALUES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  middot: "·",
  nbsp: " ",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
  lt: "<",
});

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/giu, (entity, name: string) => {
    const normalizedName = name.toLowerCase();
    if (normalizedName.startsWith("#")) {
      const hex = normalizedName.startsWith("#x");
      const codePoint = Number.parseInt(normalizedName.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return " ";
      }
      return String.fromCodePoint(codePoint);
    }
    return HTML_ENTITY_VALUES[normalizedName] ?? " ";
  });
}

function canonicalPayloadText(value: string): string {
  let canonical = value;
  // Decode before stripping so escaped markup such as &lt;p&gt; is treated as
  // editor markup rather than authored content. Two passes cover nested entity
  // escaping without turning this into an unbounded decoder.
  for (let pass = 0; pass < 2; pass += 1) {
    canonical = decodeHtmlEntities(canonical).replace(/<!--[\s\S]*?-->|<[^>]*>/gu, " ");
  }
  return canonical
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function sameSanitizedPayloadText(left: string, right: string): boolean {
  const leftCanonical = canonicalPayloadText(left);
  return leftCanonical.length > 0 && leftCanonical === canonicalPayloadText(right);
}

function contentAnchors(value: string, width: number): readonly string[] {
  const characters = Array.from(value);
  if (characters.length === 0) return [];
  if (characters.length <= width) return [characters.join("")];
  const anchors = new Set<string>();
  for (let index = 0; index <= characters.length - width; index += 1) {
    anchors.add(characters.slice(index, index + width).join(""));
  }
  return [...anchors];
}

export function matchesExpectedPayloadText(
  observed: string,
  expected: string,
  kind: PlatformPayloadTextKind,
): boolean {
  const observedCanonical = canonicalPayloadText(observed);
  const expectedCanonical = canonicalPayloadText(expected);
  if (observedCanonical.length === 0 || expectedCanonical.length === 0) return false;
  if (observedCanonical === expectedCanonical || observedCanonical.includes(expectedCanonical)) {
    return true;
  }

  const observedLength = Array.from(observedCanonical).length;
  const expectedLength = Array.from(expectedCanonical).length;
  const minimumLengthRatio = kind === "title" ? 0.6 : 0.6;
  if (observedLength / expectedLength < minimumLengthRatio) return false;

  const width = kind === "title" ? 2 : 4;
  const expectedAnchors = contentAnchors(expectedCanonical, width);
  if (expectedAnchors.length === 0) return false;
  const observedAnchors = new Set(contentAnchors(observedCanonical, width));
  const matchedAnchors = expectedAnchors.filter((anchor) => observedAnchors.has(anchor));
  const coverage = matchedAnchors.length / expectedAnchors.length;
  const minimumCoverage = kind === "title" ? 0.7 : 0.7;
  const minimumDistinctAnchors = Math.min(kind === "title" ? 3 : 8, expectedAnchors.length);
  return coverage >= minimumCoverage && matchedAnchors.length >= minimumDistinctAnchors;
}

function samePublicBody(
  definition: PlatformPublicationDefinition,
  observed: string,
  expected: string,
): boolean {
  if (definition.publicBodyWhitespaceMode === "ignore") {
    return matchesExpectedPayloadText(observed.replace(/\s+/gu, ""), expected, "body");
  }
  return matchesExpectedPayloadText(observed, expected, "body");
}

function stripEditorDecorations(value: string, decorations: readonly string[] | undefined): string {
  let stripped = normalizedText(value);
  for (const decoration of decorations ?? []) {
    const normalizedDecoration = normalizedText(decoration);
    if (normalizedDecoration.length === 0) continue;
    const escaped = normalizedDecoration.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expression = escaped.split("").join("\\s*");
    stripped = stripped.replace(new RegExp(expression, "gu"), "");
  }
  return stripped;
}

function exactEditorUrl(definition: PlatformPublicationDefinition, value: string): boolean {
  return (
    exactFixedUrl(definition.editorUrl, value) || definition.editorUrlMatcher?.(value) === true
  );
}

function exactFixedUrl(expectedValue: string, value: string): boolean {
  try {
    const expected = new URL(expectedValue);
    const observed = new URL(value);
    const requiredSearchEntries = [...expected.searchParams.entries()];
    return (
      observed.protocol === "https:" &&
      observed.origin === expected.origin &&
      observed.pathname === expected.pathname &&
      requiredSearchEntries.every(
        ([name, expectedValue]) =>
          observed.searchParams.getAll(name).length === 1 &&
          observed.searchParams.get(name) === expectedValue,
      ) &&
      observed.hash === expected.hash
    );
  } catch {
    return false;
  }
}

async function visibleLocators(
  locator: PlaywrightPublicationLocator,
  readTimeoutMs: number,
): Promise<PlaywrightPublicationLocator[]> {
  const count = Math.min(await locator.count(), MAX_LOCATOR_COUNT);
  const visible: PlaywrightPublicationLocator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible({ timeout: readTimeoutMs }).catch(() => false)) {
      visible.push(candidate);
    }
  }
  return visible;
}

function isTransientEditorFrameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:frame was detached|execution context was destroyed|cannot find context with specified id)/iu.test(
    error.message,
  );
}

async function resolveField(
  page: Pick<PlaywrightPublicationFrame, "locator">,
  selectors: readonly string[],
  readTimeoutMs: number,
): Promise<{ readonly count: number; readonly locator: PlaywrightPublicationLocator | null }> {
  for (const selector of selectors) {
    let visible: PlaywrightPublicationLocator[];
    try {
      visible = await visibleLocators(page.locator(selector), readTimeoutMs);
    } catch (error) {
      if (isTransientEditorFrameError(error)) continue;
      throw error;
    }
    if (visible.length > 0) {
      return { count: visible.length, locator: visible.length === 1 ? (visible[0] ?? null) : null };
    }
  }
  return { count: 0, locator: null };
}

async function resolveBodyField(
  page: PlaywrightPublicationPage,
  definition: PlatformPublicationDefinition,
  readTimeoutMs: number,
): Promise<{ readonly count: number; readonly locator: PlaywrightPublicationLocator | null }> {
  if (definition.bodyEditorScope !== "page_or_unique_frame") {
    return resolveField(page, definition.bodySelectors, readTimeoutMs);
  }
  const pageField = await resolveField(page, definition.bodySelectors, readTimeoutMs);
  if (pageField.count > 0) return pageField;
  const matches: PlaywrightPublicationLocator[] = [];
  for (const scope of page.frames?.() ?? []) {
    const resolved = await resolveField(scope, definition.bodySelectors, readTimeoutMs);
    if (resolved.locator !== null && resolved.count === 1) matches.push(resolved.locator);
    else if (resolved.count > 1) return { count: resolved.count, locator: null };
  }
  return {
    count: matches.length,
    locator: matches.length === 1 ? (matches[0] ?? null) : null,
  };
}

async function locatorText(
  locator: PlaywrightPublicationLocator,
  readTimeoutMs: number,
): Promise<string> {
  if (locator.innerText !== undefined) {
    const value = await locator.innerText({ timeout: readTimeoutMs }).catch(() => null);
    if (value !== null && normalizedText(value).length > 0) return normalizedText(value);
  }
  if (locator.inputValue !== undefined) {
    const value = await locator.inputValue({ timeout: readTimeoutMs }).catch(() => null);
    if (value !== null) return normalizedText(value);
  }
  // Public article metadata is often rendered in <meta> nodes, whose textContent
  // is empty even though the canonical value is available through `content`.
  if (locator.getAttribute !== undefined) {
    for (const attribute of ["content", "aria-label", "title"]) {
      const value = await locator
        .getAttribute(attribute, { timeout: readTimeoutMs })
        .catch(() => null);
      if (value !== null && normalizedText(value).length > 0) return normalizedText(value);
    }
  }
  return normalizedText(await locator.textContent({ timeout: readTimeoutMs }).catch(() => null));
}

async function bodyLocatorText(
  locator: PlaywrightPublicationLocator,
  readTimeoutMs: number,
  excludedSelectors: readonly string[] | undefined,
): Promise<string> {
  if (excludedSelectors === undefined || excludedSelectors.length === 0) {
    return locatorText(locator, readTimeoutMs);
  }
  if (locator.evaluate === undefined) return locatorText(locator, readTimeoutMs);
  const value = await locator
    .evaluate((node, selectors) => {
      const clone = node.cloneNode(true);
      for (const selector of selectors) {
        for (const excluded of Array.from(clone.querySelectorAll(selector))) excluded.remove();
      }
      // Read the cloned editor as one text stream after removing only the
      // verified non-authored widgets. Joining direct children inserts a fake
      // newline when an inline media wrapper splits one prose segment.
      return clone.innerText ?? clone.textContent ?? "";
    }, excludedSelectors)
    .catch(() => null);
  return value === null ? locatorText(locator, readTimeoutMs) : normalizedText(value);
}

function canonicalPublicObservation(
  definition: PlatformPublicationDefinition,
  value: string,
): { readonly id: string; readonly url: string } | null {
  const direct = definition.publicSurface.canonicalizeUrl(value);
  if (direct !== null) return direct;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
      return null;
    // Platforms can append tracking/query parameters after the public article is
    // opened. Validate the origin/path using the strict canonicalizer while
    // keeping the persisted URL query-free.
    return definition.publicSurface.canonicalizeUrl(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return null;
  }
}

async function exactActions(
  page: PlaywrightPublicationPage,
  selector: string,
  labels: readonly string[],
  readTimeoutMs: number,
): Promise<PlaywrightPublicationLocator[]> {
  const acceptedLabels = new Set(labels.map(normalizedText));
  const actions = await visibleLocators(page.locator(selector), readTimeoutMs);
  const matches: PlaywrightPublicationLocator[] = [];
  for (const action of actions) {
    if (acceptedLabels.has(await locatorText(action, readTimeoutMs))) matches.push(action);
  }
  return matches;
}

async function prioritizedExactActions(
  page: PlaywrightPublicationPage,
  selectors: readonly string[],
  labels: readonly string[],
  readTimeoutMs: number,
): Promise<PlaywrightPublicationLocator[]> {
  for (const selector of selectors) {
    const matches = await exactActions(page, selector, labels, readTimeoutMs);
    if (matches.length > 0) return matches;
  }
  return [];
}

async function challengeSignals(
  page: PlaywrightPublicationPage,
  selectors: readonly string[],
  readTimeoutMs: number,
): Promise<string[]> {
  const signals: string[] = [];
  for (const selector of selectors) {
    const candidates = await visibleLocators(page.locator(selector), readTimeoutMs);
    let challengeVisible = false;
    for (const candidate of candidates) {
      if (candidate.evaluate === undefined) {
        challengeVisible = true;
        break;
      }
      const intersectsViewport = await candidate
        .evaluate((node) => {
          const view = node.ownerDocument?.defaultView;
          if (view === undefined || view === null || node.getBoundingClientRect === undefined) {
            return true;
          }
          let current: PublicationDomNode | null | undefined = node;
          while (current !== null && current !== undefined) {
            const style = view.getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              Number(style.opacity) === 0
            ) {
              return false;
            }
            current = current.parentElement;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return (
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < view.innerHeight &&
            rect.left < view.innerWidth
          );
        }, undefined)
        .catch(() => true);
      if (intersectsViewport) {
        challengeVisible = true;
        break;
      }
    }
    if (challengeVisible) {
      signals.push(selector);
    }
  }
  return signals;
}

function samePreparedPayloadSurface(
  left: PlatformPreparedSurfaceState,
  right: PlatformPreparedSurfaceState,
): boolean {
  return (
    left.status === "ready" &&
    right.status === "ready" &&
    left.platform === right.platform &&
    left.adapterVersion === right.adapterVersion &&
    left.targetPageCount === right.targetPageCount &&
    left.titleEditorCount === right.titleEditorCount &&
    left.bodyEditorCount === right.bodyEditorCount &&
    left.primaryActionCount === right.primaryActionCount &&
    left.expectedMediaCount === right.expectedMediaCount &&
    sameSanitizedPayloadText(left.titleText, right.titleText) &&
    sameSanitizedPayloadText(left.bodyText, right.bodyText)
  );
}

async function firstVisibleText(
  page: PlaywrightPublicationPage,
  selectors: readonly string[],
  readTimeoutMs: number,
): Promise<string> {
  for (const selector of selectors) {
    const visible = await visibleLocators(page.locator(selector), readTimeoutMs);
    for (const locator of visible) {
      const value = await locatorText(locator, readTimeoutMs);
      if (value.length > 0) return value.slice(0, MAX_SIGNAL_LENGTH);
    }
  }
  return "";
}

async function publicCandidate(
  page: PlaywrightPublicationPage,
  definition: PlatformPublicationDefinition,
  readTimeoutMs: number,
): Promise<{ readonly id: string; readonly url: string } | null> {
  const candidates = new Map<string, { readonly id: string; readonly url: string }>();
  const current = definition.publicSurface.canonicalizeUrl(page.url());
  if (current !== null) candidates.set(current.url, current);
  const links = await visibleLocators(page.locator("a[href]"), readTimeoutMs);
  for (const link of links) {
    if (link.getAttribute === undefined) continue;
    const href = await link.getAttribute("href", { timeout: readTimeoutMs }).catch(() => null);
    if (href === null) continue;
    const candidate = definition.publicSurface.canonicalizeUrl(href);
    if (candidate !== null) candidates.set(candidate.url, candidate);
  }
  return candidates.size === 1 ? ([...candidates.values()][0] ?? null) : null;
}

function unavailableReadback(signal: string): PlatformPublicReadbackResult {
  return {
    outcome: "unavailable",
    externalId: null,
    externalUrl: null,
    observedAccountName: "",
    observedTitle: "",
    observedBody: "",
    signal,
  };
}

type CreatorManagementState = "published" | "pending" | "rejected" | "draft" | "unknown";

interface CreatorManagementObservation {
  readonly state: CreatorManagementState;
  readonly candidate: { readonly id: string; readonly url: string } | null;
  readonly publisherReasonCode: string | null;
  readonly signal: string;
}

function creatorManagementState(
  surface: PlatformCreatorManagementSurfaceDefinition,
  statusText: string,
): CreatorManagementState {
  const status = normalizedText(statusText);
  const includesLabel = (labels: readonly string[] | undefined): boolean =>
    (labels ?? []).some((label) => status.includes(normalizedText(label)));
  if (includesLabel(surface.rejectedStatusLabels)) return "rejected";
  if (includesLabel(surface.pendingStatusLabels)) return "pending";
  if (includesLabel(surface.draftStatusLabels)) return "draft";
  if (includesLabel(surface.publicStatusLabels)) return "published";
  return "unknown";
}

function creatorManagementRejection(
  surface: PlatformCreatorManagementSurfaceDefinition,
  rowText: string,
): Pick<CreatorManagementObservation, "publisherReasonCode" | "signal"> {
  const normalized = normalizedText(rowText);
  const matched = surface.rejectionReasons?.find(({ pattern }) => pattern.test(normalized));
  if (matched === undefined && /广告软文/u.test(normalized)) {
    return {
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      signal: "creator-management-rejected-soft-advertorial",
    };
  }
  return matched === undefined
    ? {
        publisherReasonCode: "publisher.rejected.other",
        signal: "creator-management-rejected",
      }
    : { publisherReasonCode: matched.code, signal: matched.signal };
}

export function createPlaywrightPlatformPublicationAdapter(options: {
  readonly definition: PlatformPublicationDefinition;
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
  readonly now?: () => Date;
}): PlaywrightPlatformPublicationAdapter {
  const definition = options.definition;
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const editorReadyAttempts = options.editorReadyAttempts ?? DEFAULT_EDITOR_READY_ATTEMPTS;
  if (
    !Number.isSafeInteger(editorReadyAttempts) ||
    editorReadyAttempts < 1 ||
    editorReadyAttempts > MAX_EDITOR_READY_ATTEMPTS
  ) {
    throw new TypeError(
      `${options.definition.platform} editor readiness attempts must be from 1 through ${MAX_EDITOR_READY_ATTEMPTS}`,
    );
  }
  const readbackAttempts = options.readbackAttempts ?? DEFAULT_READBACK_ATTEMPTS;
  const finalActionObservationAttempts = options.finalActionObservationAttempts ?? readbackAttempts;
  const submitObservationAttempts =
    options.submitObservationAttempts ?? DEFAULT_SUBMIT_OBSERVATION_ATTEMPTS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const confirmationMode = options.confirmationMode ?? "public_readback";
  const now = options.now ?? (() => new Date());
  let openedEditorPage: PlaywrightPublicationPage | null = null;

  const assertNoInteractiveEditorChallenge = async (
    page: PlaywrightPublicationPage,
  ): Promise<void> => {
    if ((await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0) {
      throw new Error(`${definition.platform} editor requires an interactive security challenge`);
    }
  };

  const editorPages = (): PlaywrightPublicationPage[] => {
    const pages = [...options.pages()];
    if (openedEditorPage !== null && !pages.includes(openedEditorPage))
      pages.push(openedEditorPage);
    return pages.filter((page) => exactEditorUrl(definition, page.url()));
  };

  /**
   * A browser context can retain a stale copy of the same editor after a
   * navigation, iframe rebuild, or an interrupted handoff. Treating every
   * duplicate as adapter drift made an otherwise usable account fail at the
   * final submit gate. Keep the page we explicitly opened (or the newest
   * context page) and close only exact editor duplicates. Other platform
   * pages, including creator-management and public readback pages, are never
   * candidates here.
   */
  const reconcileEditorPages = async (): Promise<{
    readonly matches: readonly PlaywrightPublicationPage[];
    readonly unresolved: boolean;
  }> => {
    let matches = editorPages();
    if (matches.length <= 1) return { matches, unresolved: false };

    const preferred =
      openedEditorPage !== null && matches.includes(openedEditorPage)
        ? openedEditorPage
        : (matches[matches.length - 1] as PlaywrightPublicationPage);
    let unresolved = false;
    for (const page of matches) {
      if (page === preferred) continue;
      if (page.close === undefined) {
        unresolved = true;
        continue;
      }
      try {
        await page.close();
      } catch {
        unresolved = true;
      }
    }
    matches = editorPages();
    if (matches.length !== 1 || matches[0] !== preferred) unresolved = true;
    return { matches, unresolved };
  };

  const selectedEditorPage = (): PlaywrightPublicationPage => {
    const matches = editorPages();
    if (matches.length !== 1) {
      throw new Error(`${definition.platform} editor page is not unique`);
    }
    return matches[0] as PlaywrightPublicationPage;
  };

  const inspectPage = async (
    page: PlaywrightPublicationPage,
    targetPageCount: number,
    expectedMediaCount: number,
  ): Promise<PlatformPreparedSurfaceState> => {
    const challenges = await challengeSignals(page, definition.challengeSelectors, readTimeoutMs);
    const title = await resolveField(page, definition.titleSelectors, readTimeoutMs);
    const body = await resolveBodyField(page, definition, readTimeoutMs);
    const primaryActions = await exactActions(
      page,
      definition.actionSelector,
      definition.primaryActionLabels,
      readTimeoutMs,
    );
    const noMediaOptionReady = async (): Promise<boolean> => {
      if (expectedMediaCount !== 0 || definition.noMediaOption === undefined) return true;
      const matches = await exactActions(
        page,
        definition.noMediaOption.actionSelector,
        [definition.noMediaOption.actionLabel],
        readTimeoutMs,
      );
      const selected = matches[0]?.locator?.(definition.noMediaOption.selectedDescendantSelector);
      return (
        matches.length === 1 &&
        selected !== undefined &&
        (await visibleLocators(selected, readTimeoutMs)).length === 1
      );
    };
    const controlsReady =
      targetPageCount === 1 &&
      title.count === 1 &&
      body.count === 1 &&
      primaryActions.length === 1 &&
      (await noMediaOptionReady());
    return {
      status:
        challenges.length > 0 ? "challenge_required" : controlsReady ? "ready" : "adapter_drift",
      platform: definition.platform,
      adapterVersion: definition.adapterVersion,
      targetPageCount,
      titleEditorCount: title.count,
      bodyEditorCount: body.count,
      primaryActionCount: primaryActions.length,
      expectedMediaCount,
      titleText: title.locator === null ? "" : await locatorText(title.locator, readTimeoutMs),
      bodyText: stripEditorDecorations(
        body.locator === null
          ? ""
          : await bodyLocatorText(
              body.locator,
              readTimeoutMs,
              definition.bodyTextExcludedSelectors,
            ),
        definition.editorTextDecorationsToStrip,
      ),
      challengeSignals: challenges,
    };
  };

  const inspectFinalConfirmationSurface = async (
    page: PlaywrightPublicationPage,
    finalActionCount: number,
  ): Promise<{
    readonly status: "ready" | "challenge_required" | "adapter_drift";
    readonly titleText: string;
    readonly bodyText: string;
    readonly challengeSignals: readonly string[];
  }> => {
    const challenges = await challengeSignals(page, definition.challengeSelectors, readTimeoutMs);
    const title = await resolveField(page, definition.titleSelectors, readTimeoutMs);
    const body = await resolveBodyField(page, definition, readTimeoutMs);
    const editorTargets = editorPages();
    const controlsReady =
      editorTargets.length === 1 &&
      editorTargets[0] === page &&
      title.count === 1 &&
      body.count === 1 &&
      finalActionCount === 1;
    return {
      status:
        challenges.length > 0 ? "challenge_required" : controlsReady ? "ready" : "adapter_drift",
      titleText: title.locator === null ? "" : await locatorText(title.locator, readTimeoutMs),
      bodyText: stripEditorDecorations(
        body.locator === null
          ? ""
          : await bodyLocatorText(
              body.locator,
              readTimeoutMs,
              definition.bodyTextExcludedSelectors,
            ),
        definition.editorTextDecorationsToStrip,
      ),
      challengeSignals: challenges,
    };
  };

  const inspectPrepared = async (input?: {
    readonly mediaCount?: number;
  }): Promise<PlatformPreparedSurfaceState> => {
    const expectedMediaCount = input?.mediaCount ?? 0;
    if (!Number.isSafeInteger(expectedMediaCount) || expectedMediaCount < 0) {
      throw new TypeError(`${definition.platform} draft media count is invalid`);
    }
    const reconciled = await reconcileEditorPages();
    const matches = reconciled.matches;
    if (matches.length === 0) {
      return {
        status: "session_required",
        platform: definition.platform,
        adapterVersion: definition.adapterVersion,
        targetPageCount: 0,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        primaryActionCount: 0,
        expectedMediaCount,
        titleText: "",
        bodyText: "",
        challengeSignals: [],
      };
    }
    if (reconciled.unresolved || matches.length > 1) {
      return {
        status: "adapter_drift",
        platform: definition.platform,
        adapterVersion: definition.adapterVersion,
        targetPageCount: matches.length,
        titleEditorCount: 0,
        bodyEditorCount: 0,
        primaryActionCount: 0,
        expectedMediaCount,
        titleText: "",
        bodyText: "",
        challengeSignals: ["duplicate-target-page-unresolved"],
      };
    }
    return inspectPage(matches[0] as PlaywrightPublicationPage, 1, expectedMediaCount);
  };

  const openEditor = async (): Promise<PlaywrightPublicationPage> => {
    const reconciled = await reconcileEditorPages();
    const matches = reconciled.matches;
    if (reconciled.unresolved) throw new Error(`${definition.platform} editor page is not unique`);
    if (matches.length === 1) return matches[0] as PlaywrightPublicationPage;
    if (matches.length > 1) throw new Error(`${definition.platform} editor page is not unique`);
    if (options.openCreatorPage === undefined) {
      throw new Error(`${definition.platform} creator page opener is unavailable`);
    }
    const page = await options.openCreatorPage(definition.editorUrl);
    openedEditorPage = page;
    if (!exactEditorUrl(definition, page.url())) {
      throw new Error(`${definition.platform} creator session did not reach the fixed editor URL`);
    }
    return page;
  };

  const recoverCreatorObservation = async (
    input: PlatformPublicReadbackInput,
    surface:
      PlatformCreatorManagementSurfaceDefinition | undefined = definition.creatorManagementSurface,
  ): Promise<CreatorManagementObservation | null> => {
    if (
      surface === undefined ||
      options.openCreatorPage === undefined ||
      input.submittedAt === undefined ||
      input.submittedAt === null
    ) {
      return null;
    }
    const observedAt = now();
    const existing = options.pages().filter((page) => exactFixedUrl(surface.url, page.url()));
    const openedForRecovery = existing.length === 0;
    const recoveryPages =
      existing.length === 0
        ? [await options.openCreatorPage(surface.url)]
        : [...existing].reverse();
    const recovered = new Map<string, { readonly id: string; readonly url: string }>();
    const moderation = new Map<string, CreatorManagementObservation>();
    for (const page of recoveryPages) {
      try {
        if (!exactFixedUrl(surface.url, page.url())) continue;
        if (!openedForRecovery && page.goto !== undefined) {
          await page.goto(surface.url, {
            timeout: actionTimeoutMs,
            waitUntil: "domcontentloaded",
          });
        }
        await page.waitForLoadState?.("domcontentloaded", { timeout: actionTimeoutMs });
        if (
          (await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0
        ) {
          continue;
        }
        let pageCandidates = new Map<string, { readonly id: string; readonly url: string }>();
        let pageModeration = new Map<string, CreatorManagementObservation>();
        for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
          pageCandidates = new Map<string, { readonly id: string; readonly url: string }>();
          pageModeration = new Map<string, CreatorManagementObservation>();
          const rows = await visibleLocators(page.locator(surface.itemSelector), readTimeoutMs);
          for (const row of rows) {
            if (row.locator === undefined) continue;
            const titleNodes = await visibleLocators(
              row.locator(surface.titleSelector ?? surface.titleLinkSelector),
              readTimeoutMs,
            );
            if (
              titleNodes.length !== 1 ||
              !matchesExpectedPayloadText(
                await locatorText(titleNodes[0] as PlaywrightPublicationLocator, readTimeoutMs),
                input.expectedTitle,
                "title",
              )
            ) {
              continue;
            }
            const timestamps = await visibleLocators(
              row.locator(surface.timestampSelector),
              readTimeoutMs,
            );
            if (
              timestamps.length !== 1 ||
              !surface.timestampMatches(
                await locatorText(timestamps[0] as PlaywrightPublicationLocator, readTimeoutMs),
                input.submittedAt,
                observedAt,
              )
            ) {
              continue;
            }
            const statuses = await visibleLocators(
              row.locator(surface.statusSelector),
              readTimeoutMs,
            );
            const statusText = (
              await Promise.all(statuses.map((status) => locatorText(status, readTimeoutMs)))
            ).join(" ");
            const rowText = await locatorText(row, readTimeoutMs);
            const itemLinks = await visibleLocators(
              row.locator(surface.itemLinkSelector ?? surface.titleLinkSelector),
              readTimeoutMs,
            );
            const itemUrls = (
              await Promise.all(
                itemLinks.map((itemLink) =>
                  itemLink.getAttribute?.("href", { timeout: readTimeoutMs }),
                ),
              )
            ).filter((href): href is string => typeof href === "string" && href.length > 0);
            const moderationState = creatorManagementState(surface, statusText);
            if (moderationState === "rejected") {
              let rejectionText = rowText;
              if (surface.resolveRejectionReason !== undefined) {
                try {
                  const resolvedReason = await surface.resolveRejectionReason({
                    page,
                    expectedTitle: input.expectedTitle,
                    submittedAt: input.submittedAt,
                    itemUrls,
                  });
                  if (resolvedReason !== null && resolvedReason.trim().length > 0) {
                    rejectionText = `${rejectionText} ${resolvedReason}`;
                  }
                } catch {
                  // The visible rejected state remains authoritative. If the
                  // optional detail response drifts, retain a generic reason.
                }
              }
              const rejection = creatorManagementRejection(surface, rejectionText);
              pageModeration.set(`rejected:${rejection.publisherReasonCode}`, {
                state: "rejected",
                candidate: null,
                ...rejection,
              });
              continue;
            }
            if (moderationState === "pending" || moderationState === "draft") {
              pageModeration.set(moderationState, {
                state: moderationState,
                candidate: null,
                publisherReasonCode: null,
                signal:
                  moderationState === "pending"
                    ? "creator-management-pending-review"
                    : "creator-management-draft",
              });
              continue;
            }
            const itemCandidates = new Map<string, { readonly id: string; readonly url: string }>();
            for (const itemLink of itemLinks) {
              const href = await itemLink.getAttribute?.("href", { timeout: readTimeoutMs });
              const itemCandidate =
                href === undefined || href === null ? null : surface.canonicalizeItemUrl(href);
              if (itemCandidate !== null) itemCandidates.set(itemCandidate.url, itemCandidate);
            }
            if (itemCandidates.size !== 1) continue;
            if (surface.canonicalPublicLinkConfirmsPublished !== true) {
              if (moderationState !== "published") continue;
            }
            const candidate = [...itemCandidates.values()][0] ?? null;
            if (candidate !== null) pageCandidates.set(candidate.url, candidate);
          }
          if (
            pageCandidates.size > 0 ||
            [...pageModeration.values()].some((item) => item.state === "rejected")
          ) {
            break;
          }
          if (attempt < readbackAttempts - 1) await wait(pollMs);
        }
        if (pageCandidates.size > 1) return null;
        for (const candidate of pageCandidates.values()) recovered.set(candidate.url, candidate);
        for (const [key, observation] of pageModeration) moderation.set(key, observation);
      } catch {
        continue;
      } finally {
        if (openedForRecovery) await page.close?.().catch(() => undefined);
      }
    }
    if (recovered.size > 0 && moderation.size > 0) return null;
    if (recovered.size === 1) {
      return {
        state: "published",
        candidate: [...recovered.values()][0] ?? null,
        publisherReasonCode: null,
        signal: "creator-management-published-title-time-matched",
      };
    }
    if (recovered.size > 1 || moderation.size > 1) return null;
    return [...moderation.values()][0] ?? null;
  };

  const observeSubmission = async (
    page: PlaywrightPublicationPage,
  ): Promise<PlatformSubmissionResult> => {
    let signal = "submit-observation-missing";
    for (let attempt = 0; attempt < submitObservationAttempts; attempt += 1) {
      const observed = await firstVisibleText(page, definition.resultSelectors, readTimeoutMs);
      if (observed.length > 0) signal = observed;
      if (definition.rejectedSignals.some((pattern) => pattern.test(signal))) {
        return {
          outcome: "rejected",
          signal,
          candidateExternalId: null,
          candidateExternalUrl: null,
        };
      }
      if (definition.acceptedSignals.some((pattern) => pattern.test(signal))) {
        const candidate = await publicCandidate(page, definition, readTimeoutMs);
        return {
          outcome: "accepted",
          signal,
          candidateExternalId: candidate?.id ?? null,
          candidateExternalUrl: candidate?.url ?? null,
        };
      }
      if (attempt < submitObservationAttempts - 1) await wait(pollMs);
    }
    return {
      outcome: "uncertain",
      signal,
      candidateExternalId: null,
      candidateExternalUrl: null,
    };
  };

  const uncertainAfterDispatch = (signal: string): PlatformSubmissionResult => ({
    outcome: "uncertain",
    signal,
    candidateExternalId: null,
    candidateExternalUrl: null,
  });

  const recoverMissingSubmissionObservation = async (
    result: PlatformSubmissionResult,
    expectedPrepared: PlatformPreparedSurfaceState,
    submittedAt: string,
  ): Promise<PlatformSubmissionResult> => {
    if (result.outcome !== "uncertain") return result;
    const recoveryInput = {
      candidateExternalId: null,
      candidateExternalUrl: null,
      expectedAccountName: "publisher-status-recovery",
      expectedTitle: expectedPrepared.titleText,
      expectedBody: expectedPrepared.bodyText,
      submittedAt,
    } as const;
    const creatorObservation = await recoverCreatorObservation(recoveryInput);
    const candidate =
      creatorObservation?.state === "published" ? creatorObservation.candidate : null;
    if (candidate !== null) {
      return {
        outcome: "accepted",
        signal: "creator-management-published-title-time-matched",
        candidateExternalId: candidate.id,
        candidateExternalUrl: candidate.url,
      };
    }

    const draftObservation = await recoverCreatorObservation(
      recoveryInput,
      definition.creatorDraftManagementSurface,
    );
    if (draftObservation?.state === "draft") {
      return {
        outcome: "not_accepted",
        signal: "creator-management-draft-retained",
        candidateExternalId: null,
        candidateExternalUrl: null,
      };
    }

    return result;
  };

  return Object.freeze({
    definition,
    inspectPrepared,
    writeDraft: async (input: {
      readonly title: string;
      readonly body: string;
      readonly mediaCount?: number;
    }): Promise<PlatformPreparedSurfaceState> => {
      const expectedTitle = normalizedText(input.title);
      const expectedBody = normalizedText(input.body);
      const mediaCount = input.mediaCount ?? 0;
      if (expectedTitle.length === 0 || expectedBody.length === 0) {
        throw new TypeError(`${definition.platform} draft title and body are required`);
      }
      if (!Number.isSafeInteger(mediaCount) || mediaCount < 0) {
        throw new TypeError(`${definition.platform} draft media count is invalid`);
      }
      const page = await openEditor();
      await page.bringToFront();
      if (definition.resetDraftOnWrite === true && page.goto !== undefined) {
        await page.goto(definition.editorUrl, {
          timeout: actionTimeoutMs,
          waitUntil: "domcontentloaded",
        });
      }
      let title = await resolveField(page, definition.titleSelectors, readTimeoutMs);
      let body = await resolveBodyField(page, definition, readTimeoutMs);
      for (let attempt = 0; attempt < editorReadyAttempts; attempt += 1) {
        await assertNoInteractiveEditorChallenge(page);
        if (
          title.locator !== null &&
          title.count === 1 &&
          body.locator !== null &&
          body.count === 1
        ) {
          break;
        }
        if (attempt >= editorReadyAttempts - 1) {
          throw new PlatformDraftWriteError(definition.platform, "editor-controls");
        }
        await wait(pollMs);
        title = await resolveField(page, definition.titleSelectors, readTimeoutMs);
        body = await resolveBodyField(page, definition, readTimeoutMs);
      }
      if (title.locator === null || body.locator === null) {
        throw new PlatformDraftWriteError(definition.platform, "editor-controls");
      }
      let nativePayloadWritten = false;
      if (
        definition.editorPayloadWriter === "baijiahao_ueditor_v2" &&
        page.evaluate !== undefined
      ) {
        try {
          nativePayloadWritten = await page.evaluate(writeBaijiahaoUeditorV2Payload, {
            title: input.title,
            body: input.body,
            bodyHtml: plainTextParagraphHtml(input.body),
          });
        } catch (error) {
          throw new PlatformDraftWriteError(definition.platform, "body-fill", error);
        }
      }
      if (!nativePayloadWritten) {
        await assertNoInteractiveEditorChallenge(page);
        try {
          await title.locator.fill(input.title, { timeout: actionTimeoutMs });
        } catch (error) {
          await assertNoInteractiveEditorChallenge(page);
          const relocated = await resolveField(page, definition.titleSelectors, readTimeoutMs);
          if (relocated.count !== 1 || relocated.locator === null) {
            throw new PlatformDraftWriteError(definition.platform, "title-fill", error);
          }
          try {
            await relocated.locator.fill(input.title, { timeout: actionTimeoutMs });
            title = relocated;
          } catch (retryError) {
            throw new PlatformDraftWriteError(definition.platform, "title-fill", retryError);
          }
        }
        await assertNoInteractiveEditorChallenge(page);
        try {
          await body.locator.fill(input.body, { timeout: actionTimeoutMs });
        } catch (error) {
          await assertNoInteractiveEditorChallenge(page);
          const relocated = await resolveBodyField(page, definition, readTimeoutMs);
          if (relocated.count !== 1 || relocated.locator === null) {
            throw new PlatformDraftWriteError(definition.platform, "body-fill", error);
          }
          try {
            await relocated.locator.fill(input.body, { timeout: actionTimeoutMs });
            body = relocated;
          } catch (retryError) {
            throw new PlatformDraftWriteError(definition.platform, "body-fill", retryError);
          }
        }
      }

      if (mediaCount === 0 && definition.noMediaOption !== undefined) {
        let matches: PlaywrightPublicationLocator[] = [];
        for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
          matches = await exactActions(
            page,
            definition.noMediaOption.actionSelector,
            [definition.noMediaOption.actionLabel],
            readTimeoutMs,
          );
          if (matches.length === 1) break;
          if (matches.length > 1 || attempt >= readbackAttempts - 1) {
            throw new Error(`${definition.platform} no-media option is not unique`);
          }
          await wait(pollMs);
        }
        if (matches.length !== 1) {
          throw new Error(`${definition.platform} no-media option is not unique`);
        }
        const option = matches[0] as PlaywrightPublicationLocator;
        let selected = option.locator?.(definition.noMediaOption.selectedDescendantSelector);
        if (
          selected === undefined ||
          (await visibleLocators(selected, readTimeoutMs)).length !== 1
        ) {
          await assertNoInteractiveEditorChallenge(page);
          await option.click({ timeout: actionTimeoutMs });
          for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
            selected = option.locator?.(definition.noMediaOption.selectedDescendantSelector);
            if (
              selected !== undefined &&
              (await visibleLocators(selected, readTimeoutMs)).length === 1
            ) {
              break;
            }
            if (attempt < readbackAttempts - 1) await wait(pollMs);
          }
        }
      }

      for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
        const observed = await inspectPage(page, 1, mediaCount);
        if (
          observed.status === "ready" &&
          matchesExpectedPayloadText(observed.titleText, expectedTitle, "title") &&
          matchesExpectedPayloadText(observed.bodyText, expectedBody, "body")
        ) {
          return observed;
        }
        if (attempt < readbackAttempts - 1) await wait(pollMs);
      }
      throw new PlatformDraftWriteError(definition.platform, "payload-readback");
    },
    submitOnce: async (
      expectedPrepared: PlatformPreparedSurfaceState,
    ): Promise<PlatformSubmissionResult> => {
      if (
        expectedPrepared.status !== "ready" ||
        expectedPrepared.platform !== definition.platform ||
        expectedPrepared.adapterVersion !== definition.adapterVersion
      ) {
        throw new Error(`${definition.platform} prepared surface binding is invalid`);
      }
      const observed = await inspectPrepared({ mediaCount: expectedPrepared.expectedMediaCount });
      if (!samePreparedPayloadSurface(observed, expectedPrepared)) {
        throw new Error(`${definition.platform} prepared surface changed before submit`);
      }
      const page = selectedEditorPage();
      const primaryActions = await exactActions(
        page,
        definition.actionSelector,
        definition.primaryActionLabels,
        readTimeoutMs,
      );
      if (primaryActions.length !== 1) {
        throw new Error(`${definition.platform} primary submit action is not unique`);
      }
      const primaryAction = primaryActions[0] as PlaywrightPublicationLocator;
      if (
        primaryAction.isEnabled !== undefined &&
        !(await primaryAction.isEnabled({ timeout: readTimeoutMs }))
      ) {
        throw new Error(`${definition.platform} primary submit action is disabled`);
      }
      const submittedAt = now().toISOString();

      if (definition.submissionMode === "preview_then_confirm") {
        await primaryAction.click({ timeout: actionTimeoutMs });
        let finalActions: PlaywrightPublicationLocator[] = [];
        for (let attempt = 0; attempt < finalActionObservationAttempts; attempt += 1) {
          if (
            (await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0
          ) {
            return uncertainAfterDispatch("security-challenge-before-final-confirm");
          }
          finalActions = await prioritizedExactActions(
            page,
            definition.finalActionSelectors ?? [definition.actionSelector],
            definition.finalActionLabels,
            readTimeoutMs,
          );
          if (finalActions.length === 1) break;
          if (finalActions.length > 1) {
            throw new Error(`${definition.platform} final submit action is ambiguous`);
          }
          if (attempt < finalActionObservationAttempts - 1) await wait(pollMs);
        }
        if (finalActions.length !== 1) {
          if (
            (await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0
          ) {
            return uncertainAfterDispatch("security-challenge-before-final-confirm");
          }
          throw new Error(`${definition.platform} final submit confirmation did not appear`);
        }
        const preparedBeforeFinalClick = await inspectFinalConfirmationSurface(
          page,
          finalActions.length,
        );
        if (preparedBeforeFinalClick.status === "challenge_required") {
          return uncertainAfterDispatch("security-challenge-before-final-confirm");
        }
        if (preparedBeforeFinalClick.status !== "ready") {
          return uncertainAfterDispatch("prepared-surface-not-ready-before-final-confirm");
        }
        if (
          !sameSanitizedPayloadText(
            preparedBeforeFinalClick.titleText,
            expectedPrepared.titleText,
          ) ||
          !sameSanitizedPayloadText(preparedBeforeFinalClick.bodyText, expectedPrepared.bodyText)
        ) {
          return uncertainAfterDispatch("prepared-payload-changed-before-final-confirm");
        }
        const finalAction = finalActions[0] as PlaywrightPublicationLocator;
        if (
          finalAction.isEnabled !== undefined &&
          !(await finalAction.isEnabled({ timeout: readTimeoutMs }))
        ) {
          throw new Error(`${definition.platform} final submit action is disabled`);
        }
        try {
          await finalAction.click({ timeout: actionTimeoutMs });
        } catch {
          return recoverMissingSubmissionObservation(
            uncertainAfterDispatch("final-submit-click-dispatch-uncertain"),
            expectedPrepared,
            submittedAt,
          );
        }
        return recoverMissingSubmissionObservation(
          await observeSubmission(page),
          expectedPrepared,
          submittedAt,
        );
      }

      try {
        await primaryAction.click({ timeout: actionTimeoutMs });
      } catch {
        return recoverMissingSubmissionObservation(
          uncertainAfterDispatch("primary-submit-click-dispatch-uncertain"),
          expectedPrepared,
          submittedAt,
        );
      }
      let finalActions: PlaywrightPublicationLocator[] = [];
      for (let attempt = 0; attempt < finalActionObservationAttempts; attempt += 1) {
        if (
          (await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0
        ) {
          return uncertainAfterDispatch("security-challenge-before-final-confirm");
        }
        finalActions = await prioritizedExactActions(
          page,
          definition.finalActionSelectors ?? [definition.actionSelector],
          definition.finalActionLabels,
          readTimeoutMs,
        );
        if (finalActions.length > 0) break;
        if (attempt < finalActionObservationAttempts - 1) await wait(pollMs);
      }
      if (finalActions.length > 1) {
        return uncertainAfterDispatch("final-submit-action-ambiguous-after-primary-dispatch");
      }
      if (finalActions.length === 1) {
        const preparedBeforeFinalClick = await inspectFinalConfirmationSurface(
          page,
          finalActions.length,
        );
        if (preparedBeforeFinalClick.status === "challenge_required") {
          return uncertainAfterDispatch("security-challenge-before-final-confirm");
        }
        if (preparedBeforeFinalClick.status !== "ready") {
          return uncertainAfterDispatch("prepared-surface-not-ready-before-final-confirm");
        }
        if (
          !sameSanitizedPayloadText(
            preparedBeforeFinalClick.titleText,
            expectedPrepared.titleText,
          ) ||
          !sameSanitizedPayloadText(preparedBeforeFinalClick.bodyText, expectedPrepared.bodyText)
        ) {
          return uncertainAfterDispatch("prepared-payload-changed-before-final-confirm");
        }
        const finalAction = finalActions[0] as PlaywrightPublicationLocator;
        if (
          finalAction.isEnabled !== undefined &&
          !(await finalAction.isEnabled({ timeout: readTimeoutMs }))
        ) {
          return uncertainAfterDispatch("final-submit-action-disabled-after-primary-dispatch");
        }
        try {
          await finalAction.click({ timeout: actionTimeoutMs });
        } catch {
          return recoverMissingSubmissionObservation(
            uncertainAfterDispatch("final-submit-click-dispatch-uncertain"),
            expectedPrepared,
            submittedAt,
          );
        }
      }
      if ((await challengeSignals(page, definition.challengeSelectors, readTimeoutMs)).length > 0) {
        return uncertainAfterDispatch("security-challenge-before-final-confirm");
      }
      return recoverMissingSubmissionObservation(
        await observeSubmission(page),
        expectedPrepared,
        submittedAt,
      );
    },
    readback: async (input: PlatformPublicReadbackInput): Promise<PlatformPublicReadbackResult> => {
      const expectedAccountName = normalizedText(input.expectedAccountName);
      const expectedTitle = normalizedText(input.expectedTitle);
      const expectedBody = normalizeCtripPublicContent(
        renderCtripPublicBodyFromMarkdown(input.expectedBody ?? ""),
      );
      if (
        expectedAccountName.length === 0 ||
        expectedTitle.length === 0 ||
        expectedBody.length === 0
      ) {
        return unavailableReadback("public-readback-binding-incomplete");
      }
      const fromUrl =
        input.candidateExternalUrl === null
          ? null
          : definition.publicSurface.canonicalizeUrl(input.candidateExternalUrl);
      const fromId =
        input.candidateExternalId === null
          ? null
          : definition.publicSurface.urlForId(input.candidateExternalId);
      if (input.candidateExternalUrl !== null && fromUrl === null) {
        return unavailableReadback("public-url-not-allowed");
      }
      if (input.candidateExternalId !== null && fromId === null) {
        return unavailableReadback("public-id-invalid");
      }
      if (
        fromUrl !== null &&
        input.candidateExternalId !== null &&
        fromUrl.id !== input.candidateExternalId
      ) {
        return unavailableReadback("public-id-url-mismatch");
      }
      let candidate =
        fromUrl ??
        (fromId === null ? null : { id: input.candidateExternalId as string, url: fromId });
      if (confirmationMode === "publisher_status") {
        // Submit-time candidates are only hints. Publisher-status completion
        // requires a subsequent exact match in the authenticated management list.
        const creatorObservation = await recoverCreatorObservation(input);
        if (creatorObservation?.state === "rejected") {
          return {
            outcome: "publisher_rejected",
            publisherReasonCode: creatorObservation.publisherReasonCode,
            externalId: null,
            externalUrl: null,
            observedAccountName: expectedAccountName,
            observedTitle: expectedTitle,
            observedBody: "",
            signal: creatorObservation.signal,
          };
        }
        candidate = creatorObservation?.state === "published" ? creatorObservation.candidate : null;
        if (candidate === null) {
          return unavailableReadback(
            creatorObservation?.signal ?? "creator-management-published-not-found",
          );
        }
      } else if (
        candidate === null &&
        input.candidateExternalId === null &&
        input.candidateExternalUrl === null
      ) {
        const creatorObservation = await recoverCreatorObservation(input);
        if (creatorObservation?.state === "rejected") {
          return {
            outcome: "publisher_rejected",
            publisherReasonCode: creatorObservation.publisherReasonCode,
            externalId: null,
            externalUrl: null,
            observedAccountName: expectedAccountName,
            observedTitle: expectedTitle,
            observedBody: "",
            signal: creatorObservation.signal,
          };
        }
        candidate = creatorObservation?.state === "published" ? creatorObservation.candidate : null;
      }
      if (candidate === null) return unavailableReadback("public-candidate-missing");
      const resolvedCandidate = candidate;
      const candidateUrl = resolvedCandidate.url;
      const withCandidate = (
        result: PlatformPublicReadbackResult,
      ): PlatformPublicReadbackResult => ({
        ...result,
        candidateExternalId: resolvedCandidate.id,
        candidateExternalUrl: resolvedCandidate.url,
      });

      // A creator-management row is accepted only after the strict title,
      // timestamp, canonical identity, and platform "published" checks above.
      // This is intentionally distinct from anonymous public availability.
      if (confirmationMode === "publisher_status") {
        return withCandidate({
          outcome: "publisher_confirmed",
          externalId: resolvedCandidate.id,
          externalUrl: resolvedCandidate.url,
          observedAccountName: expectedAccountName,
          observedTitle: expectedTitle,
          observedBody: "",
          signal: "creator-management-published-title-time-matched",
        });
      }

      let page: PlaywrightPublicationPage | null = null;
      try {
        const openedPage = await options.openIndependentPublicPage(candidateUrl);
        const creatorProfilePage =
          openedPage === openedEditorPage || options.pages().includes(openedPage);
        if (creatorProfilePage && options.allowCreatorProfilePublicPage !== true) {
          return withCandidate(unavailableReadback("public-page-reused-creator-profile"));
        }
        page = openedPage;
        await page.waitForLoadState?.("domcontentloaded", { timeout: actionTimeoutMs });
        const pageTitle = (await page.title?.().catch(() => "")) ?? "";
        const pageText = await locatorText(page.locator("body"), readTimeoutMs).catch(() => "");
        const observedCandidate = canonicalPublicObservation(definition, page.url());
        if (observedCandidate === null || observedCandidate.url !== candidateUrl) {
          return withCandidate(unavailableReadback("public-navigation-left-allowed-canonical-url"));
        }
        if (
          /404(?:错误页|页面)?/iu.test(pageTitle) ||
          /(?:内容不存在|内容已删除|页面不存在|抱歉[，,]?你访问的内容不存在)/u.test(
            `${pageTitle} ${pageText}`,
          )
        ) {
          return withCandidate({
            outcome: "not_found",
            externalId: null,
            externalUrl: null,
            observedAccountName: "",
            observedTitle: pageTitle,
            observedBody: pageText,
            signal: "public-content-not-found",
          });
        }
        const account = await resolveField(
          page,
          definition.publicSurface.authorSelectors,
          readTimeoutMs,
        );
        const title = await resolveField(
          page,
          definition.publicSurface.titleSelectors,
          readTimeoutMs,
        );
        const body = await resolveField(
          page,
          definition.publicSurface.bodySelectors,
          readTimeoutMs,
        );
        if (
          account.locator === null ||
          account.count !== 1 ||
          title.locator === null ||
          title.count !== 1 ||
          body.locator === null ||
          body.count !== 1
        ) {
          return withCandidate(unavailableReadback("public-payload-nodes-missing-or-ambiguous"));
        }
        const observedAccountName = await locatorText(account.locator, readTimeoutMs);
        const observedTitle = await locatorText(title.locator, readTimeoutMs);
        const observedBody = await bodyLocatorText(
          body.locator,
          readTimeoutMs,
          definition.bodyTextExcludedSelectors,
        );
        const accountMatches =
          sameText(observedAccountName, expectedAccountName) ||
          (definition.publicAuthorIdentityMode === "candidate_url_bound" &&
            observedAccountName.length > 0);
        if (
          !accountMatches ||
          !matchesExpectedPayloadText(observedTitle, expectedTitle, "title") ||
          !samePublicBody(definition, observedBody, expectedBody)
        ) {
          return withCandidate({
            outcome: "mismatch",
            externalId: null,
            externalUrl: null,
            observedAccountName,
            observedTitle,
            observedBody,
            signal: "public-account-title-or-body-mismatch",
          });
        }
        return withCandidate({
          outcome: "confirmed",
          externalId: observedCandidate.id,
          externalUrl: observedCandidate.url,
          observedAccountName,
          observedTitle,
          observedBody,
          signal: creatorProfilePage
            ? "creator-authenticated-public-payload-matched"
            : "independent-public-payload-matched",
        });
      } catch {
        return withCandidate(unavailableReadback("independent-public-navigation-unavailable"));
      } finally {
        await page?.close?.().catch(() => undefined);
      }
    },
  });
}
