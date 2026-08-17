import { describe, expect, it, vi } from "vitest";

import {
  BAIJIAHAO_ARTICLE_EDITOR_URL,
  BAIJIAHAO_CONTENT_MANAGER_URL,
  BAIJIAHAO_PUBLICATION_DEFINITION,
  createPlaywrightBaijiahaoPublicationAdapter,
} from "./playwright-baijiahao-publication.js";
import type {
  PlatformPublicationDefinition,
  PlaywrightPublicationLocator,
  PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";
import {
  createPlaywrightPlatformPublicationAdapter,
  matchesExpectedPayloadText,
} from "./playwright-platform-publication.js";
import {
  createPlaywrightToutiaoPublicationAdapter,
  TOUTIAO_ARTICLE_EDITOR_URL,
  TOUTIAO_PUBLICATION_DEFINITION,
} from "./playwright-toutiao-publication.js";
import {
  createPlaywrightSohuPublicationAdapter,
  SOHU_PUBLICATION_DEFINITION,
} from "./playwright-sohu-publication.js";
import {
  createPlaywrightNeteasePublicationAdapter,
  NETEASE_PUBLICATION_DEFINITION,
} from "./playwright-netease-publication.js";

const expectedAccountName = "测试运营账号";
const expectedTitle = "夏季家庭出行的三个准备重点";
const expectedBody = "先确认预算和日期，再安排交通与每日节奏。";

describe("audited payload keyword coverage", () => {
  it("accepts reordered title keywords after deterministic sanitization", () => {
    expect(
      matchesExpectedPayloadText(
        "爸妈青岛选团：景点多未必省心",
        "青岛给爸妈选团，景点多未必省心",
        "title",
      ),
    ).toBe(true);
  });

  it("accepts reordered body paragraphs when their audited keyword coverage is retained", () => {
    expect(
      matchesExpectedPayloadText(
        "最后安排每日节奏。先确认预算和日期。中间再落实往返交通。",
        "先确认预算和日期。中间再落实往返交通。最后安排每日节奏。",
        "body",
      ),
    ).toBe(true);
  });

  it("rejects a substantially truncated body even when one audited phrase remains", () => {
    expect(
      matchesExpectedPayloadText(
        "先确认预算和日期。",
        "先确认预算和日期。中间再落实往返交通。最后安排每日节奏。",
        "body",
      ),
    ).toBe(false);
  });
});

interface CreatorHarness {
  readonly page: PlaywrightPublicationPage;
  readonly primaryClicks: ReturnType<typeof vi.fn>;
  readonly finalClicks: ReturnType<typeof vi.fn>;
  readonly noCoverClicks: ReturnType<typeof vi.fn>;
  readonly titleFill: ReturnType<typeof vi.fn>;
  readonly bodyFill: ReturnType<typeof vi.fn>;
  readonly nativeEditorPayloadWrite: ReturnType<typeof vi.fn>;
  readonly goto: ReturnType<typeof vi.fn>;
  setTitle(value: string): void;
  setBody(value: string): void;
  setControlsReady(value: boolean): void;
  setConfirmationReady(value: boolean): void;
  setNoCoverReady(value: boolean): void;
  setNoCoverSelected(value: boolean): void;
}

interface HarnessDomNode {
  cloneNode(deep: boolean): HarnessDomNode;
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
  readonly children: ArrayLike<HarnessDomNode>;
  readonly innerText?: string;
  readonly textContent: string | null;
}

function creatorHarness(
  definition: PlatformPublicationDefinition,
  options: {
    readonly acceptedSignal: string;
    readonly candidateUrl?: string;
    readonly titleReadbackText?: string;
    readonly bodyReadbackText?: string;
    readonly bodyDecorationText?: string;
    readonly bodyDecorationSelector?: string;
    readonly bodyInlineMediaWrapper?: boolean;
    readonly showOptionalConfirmation?: boolean;
    readonly primaryClickThrows?: boolean;
    readonly finalClickThrows?: boolean;
    readonly finalSelector?: string;
    readonly finalLabel?: string;
    readonly noCoverInputValue?: string;
    readonly bodyInFrame?: boolean;
    readonly bodyFrameDetachReads?: number;
    readonly bodyFillThrowsOnce?: boolean;
    readonly nativeEditorPayloadWrite?: boolean;
    readonly initialChallenge?: boolean;
    readonly challengeAfterTitleFill?: boolean;
    readonly challengeAfterPrimaryClick?: boolean;
    readonly editorDriftAfterPrimaryClick?: boolean;
    readonly hiddenChallengePlaceholder?: boolean;
  },
): CreatorHarness {
  let title = "";
  let body = "";
  let controlsReady = true;
  let confirmationReady = options.finalSelector === undefined;
  let noCoverReady = true;
  let noCoverSelected = false;
  let remainingBodyFrameDetachReads = options.bodyFrameDetachReads ?? 0;
  let stage: "editor" | "confirmation" | "submitted" = "editor";
  let resultSignal = "";
  let challengeVisible = options.initialChallenge === true;
  const goto = vi.fn(async () => undefined);
  const primaryClicks = vi.fn(async () => {
    if (definition.submissionMode === "preview_then_confirm") {
      stage = "confirmation";
    } else if (options.showOptionalConfirmation === true) {
      stage = "confirmation";
    } else {
      stage = "submitted";
      resultSignal = options.acceptedSignal;
    }
    if (options.challengeAfterPrimaryClick === true) challengeVisible = true;
    if (options.editorDriftAfterPrimaryClick === true) controlsReady = false;
    if (options.primaryClickThrows === true) throw new Error("click timed out after dispatch");
  });
  const finalClicks = vi.fn(async () => {
    stage = "submitted";
    resultSignal = options.acceptedSignal;
    if (options.finalClickThrows === true) throw new Error("click timed out after dispatch");
  });
  const noCoverClicks = vi.fn(async () => {
    noCoverSelected = true;
  });
  const titleFill = vi.fn(async (value: string) => {
    title = value;
    if (options.challengeAfterTitleFill === true) challengeVisible = true;
  });
  const bodyFill = vi.fn(async (value: string) => {
    if (options.bodyFillThrowsOnce === true && bodyFill.mock.calls.length === 1) {
      throw new Error("Element was detached from the DOM");
    }
    body = value;
  });
  const nativeEditorPayloadWrite = vi.fn(
    async (input: { readonly title: string; readonly body: string }) => {
      title = input.title;
      body = input.body;
      return true;
    },
  );

  const createBodyDomNode = (): HarnessDomNode => {
    let decorationRemoved = false;
    const readbackBody = options.bodyReadbackText ?? body;
    const beforeMedia = readbackBody.slice(0, Math.ceil(readbackBody.length / 2));
    const afterMedia = readbackBody.slice(Math.ceil(readbackBody.length / 2));
    const contentNode = {
      cloneNode: () => contentNode,
      querySelectorAll: () => [],
      children: [],
      innerText: options.bodyInlineMediaWrapper === true ? beforeMedia : readbackBody,
      textContent: options.bodyInlineMediaWrapper === true ? beforeMedia : readbackBody,
    };
    const afterMediaNode = {
      cloneNode: () => afterMediaNode,
      querySelectorAll: () => [],
      children: [],
      innerText: afterMedia,
      textContent: afterMedia,
    };
    const inlineMediaNode = {
      cloneNode: () => inlineMediaNode,
      querySelectorAll: () => [],
      children: [],
      innerText: "编辑\n搜图",
      textContent: "编辑\n搜图",
    };
    const decorationNode = {
      cloneNode: () => decorationNode,
      querySelectorAll: () => [],
      children: [],
      innerText: options.bodyDecorationText ?? "",
      textContent: options.bodyDecorationText ?? "",
    };
    const root = {
      cloneNode: () => createBodyDomNode(),
      querySelectorAll: (selector: string) =>
        (selector === options.bodyDecorationSelector ||
          (selector === 'div[__syl_tag="true"]' && options.bodyInlineMediaWrapper === true)) &&
        !decorationRemoved
          ? [
              {
                remove: () => {
                  decorationRemoved = true;
                },
              },
            ]
          : [],
      get children() {
        const prose =
          options.bodyInlineMediaWrapper === true ? [contentNode, afterMediaNode] : [contentNode];
        if (decorationRemoved) return prose;
        return options.bodyInlineMediaWrapper === true
          ? [contentNode, inlineMediaNode, afterMediaNode]
          : [contentNode, decorationNode];
      },
      get innerText() {
        if (options.bodyInlineMediaWrapper === true) {
          return decorationRemoved ? readbackBody : `${beforeMedia}\n编辑\n搜图\n${afterMedia}`;
        }
        return decorationRemoved
          ? readbackBody
          : `${readbackBody}${options.bodyDecorationText === undefined ? "" : options.bodyDecorationText}`;
      },
      textContent: body,
    };
    return root;
  };

  const valuesFor = (selector: string): readonly string[] => {
    if (
      (challengeVisible || options.hiddenChallengePlaceholder === true) &&
      definition.challengeSelectors.includes(selector)
    ) {
      return ["security challenge"];
    }
    if (
      !controlsReady &&
      (definition.titleSelectors.includes(selector) ||
        definition.bodySelectors.includes(selector) ||
        (selector === definition.actionSelector && stage === "editor"))
    ) {
      return [];
    }
    if (selector === definition.titleSelectors[0]) {
      return [options.titleReadbackText ?? title];
    }
    if (selector === definition.bodySelectors[0]) {
      return [
        options.bodyDecorationText === undefined
          ? (options.bodyReadbackText ?? body)
          : `${options.bodyReadbackText ?? body}${options.bodyDecorationText}`,
      ];
    }
    if (selector === ".article-cover-radio-group label.byte-radio") {
      return noCoverReady ? ["无封面"] : [];
    }
    if (selector === "__no-cover-selected") return noCoverSelected ? ["selected"] : [];
    if (selector === definition.actionSelector) {
      if (stage === "editor") return [definition.primaryActionLabels[0] ?? ""];
      if (stage === "confirmation" && confirmationReady && options.finalSelector === undefined) {
        return [options.finalLabel ?? definition.finalActionLabels[0] ?? ""];
      }
      return [];
    }
    if (stage === "confirmation" && confirmationReady && selector === options.finalSelector) {
      return [options.finalLabel ?? definition.finalActionLabels[0] ?? ""];
    }
    if (selector === definition.resultSelectors[0] && resultSignal.length > 0) {
      return [resultSignal];
    }
    if (selector === "a[href]" && stage === "submitted" && options.candidateUrl !== undefined) {
      return [options.candidateUrl];
    }
    return [];
  };

  const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
    count: async () => valuesFor(selector).length,
    nth: (next) => locatorFor(selector, next),
    first: () => locatorFor(selector, 0),
    locator: (childSelector) =>
      locatorFor(
        selector === ".article-cover-radio-group label.byte-radio" &&
          childSelector === ".byte-radio-inner.checked"
          ? "__no-cover-selected"
          : childSelector,
      ),
    isVisible: async () => valuesFor(selector)[index] !== undefined,
    isEnabled: async () => true,
    fill: async (value) => {
      if (selector === definition.titleSelectors[0]) await titleFill(value);
      else if (selector === definition.bodySelectors[0]) await bodyFill(value);
    },
    inputValue: async () =>
      selector === ".article-cover-radio-group label.byte-radio"
        ? (options.noCoverInputValue ?? valuesFor(selector)[index] ?? "")
        : (valuesFor(selector)[index] ?? ""),
    innerText: async () => valuesFor(selector)[index] ?? "",
    textContent: async () => valuesFor(selector)[index] ?? "",
    getAttribute: async (name) =>
      selector === "a[href]" && name === "href" ? (valuesFor(selector)[index] ?? null) : null,
    click: async () => {
      const label = valuesFor(selector)[index] ?? "";
      if (definition.primaryActionLabels.includes(label)) await primaryClicks();
      else if (definition.finalActionLabels.includes(label)) await finalClicks();
      else if (selector === ".article-cover-radio-group label.byte-radio" && label === "无封面") {
        await noCoverClicks();
      }
    },
    evaluate: async <Result, Argument>(
      pageFunction: (node: HarnessDomNode, argument: Argument) => Result,
      argument: Argument,
    ): Promise<Result> => {
      if (definition.challengeSelectors.includes(selector)) {
        return (options.hiddenChallengePlaceholder !== true) as Result;
      }
      if (
        definition.bodySelectors.includes(selector) &&
        (options.bodyDecorationSelector !== undefined || options.bodyInlineMediaWrapper === true)
      ) {
        return pageFunction(createBodyDomNode() as never, argument) as Result;
      }
      return (
        definition.bodySelectors.includes(selector)
          ? (options.bodyReadbackText ?? body)
          : (valuesFor(selector)[index] ?? "")
      ) as Result;
    },
  });

  const frameLocatorFor = (selector: string): PlaywrightPublicationLocator => {
    const locator = locatorFor(selector);
    if (!definition.bodySelectors.includes(selector)) return locator;
    return {
      ...locator,
      count: async () => {
        if (remainingBodyFrameDetachReads > 0) {
          remainingBodyFrameDetachReads -= 1;
          throw new Error("Frame was detached");
        }
        return locator.count();
      },
    };
  };

  return {
    page: {
      url: () => definition.editorUrl,
      locator: (selector) =>
        options.bodyInFrame === true && definition.bodySelectors.includes(selector)
          ? locatorFor("__missing")
          : locatorFor(selector),
      bringToFront: vi.fn(async () => undefined),
      goto,
      ...(options.nativeEditorPayloadWrite === true
        ? {
            evaluate: async <Result, Argument>(
              _pageFunction: (argument: Argument) => Result,
              argument: Argument,
            ): Promise<Result> =>
              nativeEditorPayloadWrite(
                argument as unknown as {
                  readonly title: string;
                  readonly body: string;
                },
              ) as Result,
          }
        : {}),
      ...(options.bodyInFrame === true
        ? {
            frames: () => [
              {
                url: () => "https://baijiahao.baidu.com/builder/inner-editor",
                locator: (selector: string) => frameLocatorFor(selector),
              },
            ],
          }
        : {}),
    },
    primaryClicks,
    finalClicks,
    noCoverClicks,
    titleFill,
    bodyFill,
    nativeEditorPayloadWrite,
    goto,
    setTitle: (value) => {
      title = value;
    },
    setBody: (value) => {
      body = value;
    },
    setControlsReady: (value) => {
      controlsReady = value;
    },
    setConfirmationReady: (value) => {
      confirmationReady = value;
    },
    setNoCoverReady: (value) => {
      noCoverReady = value;
    },
    setNoCoverSelected: (value) => {
      noCoverSelected = value;
    },
  };
}

function publicPage(
  definition: PlatformPublicationDefinition,
  url: string,
  values: {
    readonly accountName?: string;
    readonly title?: string;
    readonly body?: string;
    readonly challenge?: boolean;
    readonly payload?: boolean;
  } = {},
): { readonly page: PlaywrightPublicationPage; readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  const valuesFor = (selector: string): readonly string[] => {
    if (values.challenge === true && definition.challengeSelectors.includes(selector)) {
      return ["captcha"];
    }
    if (values.payload === false) return [];
    if (selector === definition.publicSurface.authorSelectors[0]) {
      return [values.accountName ?? expectedAccountName];
    }
    if (selector === definition.publicSurface.titleSelectors[0]) {
      return [values.title ?? expectedTitle];
    }
    if (selector === definition.publicSurface.bodySelectors[0]) {
      return [values.body ?? expectedBody];
    }
    return [];
  };
  const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
    count: async () => valuesFor(selector).length,
    nth: (next) => locatorFor(selector, next),
    first: () => locatorFor(selector, 0),
    isVisible: async () => valuesFor(selector)[index] !== undefined,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => valuesFor(selector)[index] ?? "",
    innerText: async () => valuesFor(selector)[index] ?? "",
    textContent: async () => valuesFor(selector)[index] ?? "",
    getAttribute: async () => null,
    click: async () => undefined,
  });
  return {
    page: {
      url: () => url,
      locator: (selector) => locatorFor(selector),
      bringToFront: async () => undefined,
      waitForLoadState: async () => undefined,
      close,
    },
    close,
  };
}

function toutiaoManagementPage(input: {
  readonly title: string;
  readonly timestamp: string;
  readonly status: string;
  readonly itemUrl: string;
  readonly rowDelayReads?: number;
}): PlaywrightPublicationPage {
  let remainingRowDelayReads = input.rowDelayReads ?? 0;
  const valueLocator = (
    value: string,
    attributes: Readonly<Record<string, string>> = {},
  ): PlaywrightPublicationLocator => ({
    count: async () => 1,
    nth: () => valueLocator(value, attributes),
    first: () => valueLocator(value, attributes),
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => value,
    innerText: async () => value,
    textContent: async () => value,
    getAttribute: async (name) => attributes[name] ?? null,
    click: async () => undefined,
  });
  const emptyLocator = (): PlaywrightPublicationLocator => ({
    count: async () => 0,
    nth: () => emptyLocator(),
    first: () => emptyLocator(),
    isVisible: async () => false,
    isEnabled: async () => false,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => "",
    textContent: async () => "",
    getAttribute: async () => null,
    click: async () => undefined,
  });
  const row = (): PlaywrightPublicationLocator => ({
    count: async () => 1,
    nth: () => row(),
    first: () => row(),
    locator: (selector) => {
      if (selector === "a.title[href]") return valueLocator(input.title, { href: input.itemUrl });
      if (selector === ".create-time") return valueLocator(input.timestamp);
      if (selector === ".byte-tag") return valueLocator(input.status);
      return emptyLocator();
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => `${input.title} ${input.timestamp} ${input.status}`,
    textContent: async () => `${input.title} ${input.timestamp} ${input.status}`,
    getAttribute: async () => null,
    click: async () => undefined,
  });
  return {
    url: () => "https://mp.toutiao.com/profile_v4/manage/content/all",
    locator: (selector) => {
      if (selector !== ".article-card-wrap") return emptyLocator();
      const candidate = row();
      return {
        ...candidate,
        count: async () => {
          if (remainingRowDelayReads <= 0) return 1;
          remainingRowDelayReads -= 1;
          return 0;
        },
      };
    },
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

function baijiahaoManagementPage(input: {
  readonly title: string;
  readonly timestamp: string;
  readonly status: string;
  readonly itemUrl: string;
  readonly separateTitleAndUrl?: boolean;
  readonly itemLinkCount?: number;
  readonly generatedStatusClass?: boolean;
  readonly rejectionReason?: string;
}): PlaywrightPublicationPage {
  const valueLocator = (
    value: string,
    attributes: Readonly<Record<string, string>> = {},
  ): PlaywrightPublicationLocator => ({
    count: async () => 1,
    nth: () => valueLocator(value, attributes),
    first: () => valueLocator(value, attributes),
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => value,
    innerText: async () => value,
    textContent: async () => value,
    getAttribute: async (name) => attributes[name] ?? null,
    click: async () => undefined,
  });
  const emptyLocator = (): PlaywrightPublicationLocator => ({
    count: async () => 0,
    nth: () => emptyLocator(),
    first: () => emptyLocator(),
    isVisible: async () => false,
    isEnabled: async () => false,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => "",
    textContent: async () => "",
    getAttribute: async () => null,
    click: async () => undefined,
  });
  const repeatedValueLocator = (
    value: string,
    attributes: Readonly<Record<string, string>>,
    count: number,
  ): PlaywrightPublicationLocator => ({
    ...valueLocator(value, attributes),
    count: async () => count,
    nth: () => valueLocator(value, attributes),
    first: () => valueLocator(value, attributes),
  });
  const row: PlaywrightPublicationLocator = {
    count: async () => 1,
    nth: () => row,
    first: () => row,
    locator: (selector) => {
      if (selector === ".title a[href*='baijiahao.baidu.com/s?id=']") {
        return repeatedValueLocator(
          input.separateTitleAndUrl === true ? "" : input.title,
          { href: input.itemUrl },
          input.itemLinkCount ?? 1,
        );
      }
      if (selector === ".title .cheetah-public") {
        return valueLocator(input.title);
      }
      if (selector === "time, [class*='time'], [class*='date']") {
        return valueLocator(input.timestamp);
      }
      if (
        selector ===
          "[class*='status'], [class*='state'], [class*='tag'], [class*='articleTags_createTag']" ||
        (input.generatedStatusClass !== true &&
          selector === "[class*='status'], [class*='state'], [class*='tag']")
      ) {
        return valueLocator(input.status);
      }
      return emptyLocator();
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () =>
      `${input.title} ${input.timestamp} ${input.status} ${input.rejectionReason ?? ""}`.trim(),
    textContent: async () =>
      `${input.title} ${input.timestamp} ${input.status} ${input.rejectionReason ?? ""}`.trim(),
    getAttribute: async () => null,
    click: async () => undefined,
  };
  return {
    url: () => BAIJIAHAO_CONTENT_MANAGER_URL,
    locator: (selector) => (selector === "[class*='articleItem']" ? row : emptyLocator()),
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

function neteaseManagementPage(input: {
  readonly title: string;
  readonly timestamp: string;
  readonly status: string;
  readonly itemUrl: string;
  readonly surface?: NonNullable<typeof NETEASE_PUBLICATION_DEFINITION.creatorManagementSurface>;
}): PlaywrightPublicationPage {
  const surface = input.surface ?? NETEASE_PUBLICATION_DEFINITION.creatorDraftManagementSurface;
  if (surface === undefined) throw new TypeError("Netease management surface is required");
  const valueLocator = (
    value: string,
    attributes: Readonly<Record<string, string>> = {},
  ): PlaywrightPublicationLocator => ({
    count: async () => 1,
    nth: () => valueLocator(value, attributes),
    first: () => valueLocator(value, attributes),
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => value,
    innerText: async () => value,
    textContent: async () => value,
    getAttribute: async (name) => attributes[name] ?? null,
    click: async () => undefined,
  });
  const emptyLocator = (): PlaywrightPublicationLocator => ({
    count: async () => 0,
    nth: () => emptyLocator(),
    first: () => emptyLocator(),
    isVisible: async () => false,
    isEnabled: async () => false,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => "",
    textContent: async () => "",
    getAttribute: async () => null,
    click: async () => undefined,
  });
  const row: PlaywrightPublicationLocator = {
    count: async () => 1,
    nth: () => row,
    first: () => row,
    locator: (selector) => {
      if (selector === surface.titleLinkSelector) {
        return valueLocator(input.title, { href: input.itemUrl });
      }
      if (selector === surface.timestampSelector) return valueLocator(input.timestamp);
      if (selector === surface.statusSelector) return valueLocator(input.status);
      return emptyLocator();
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => `${input.title} ${input.timestamp} ${input.status}`,
    textContent: async () => `${input.title} ${input.timestamp} ${input.status}`,
    getAttribute: async () => null,
    click: async () => undefined,
  };
  return {
    url: () => surface.url,
    locator: (selector) => (selector === surface.itemSelector ? row : emptyLocator()),
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

function securityVerificationPublicPage(url: string): {
  readonly page: PlaywrightPublicationPage;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  const emptyLocator = (selector: string): PlaywrightPublicationLocator => ({
    count: async () => 0,
    nth: () => emptyLocator(selector),
    first: () => emptyLocator(selector),
    isVisible: async () => false,
    isEnabled: async () => false,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => "",
    textContent: async () => "",
    getAttribute: async () => null,
    click: async () => undefined,
  });
  return {
    page: {
      url: () => url,
      locator: (selector) => emptyLocator(selector),
      bringToFront: async () => undefined,
      waitForLoadState: async () => undefined,
      title: async () => "百度安全验证",
      close,
    },
    close,
  };
}

const fastOptions = {
  wait: async () => undefined,
  readbackAttempts: 1,
  submitObservationAttempts: 1,
  pollMs: 0,
} as const;

describe("publication editor lifecycle", () => {
  it("closes an exact duplicate editor before inspecting a prepared Baijiahao draft", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      nativeEditorPayloadWrite: true,
    });
    let pages: PlaywrightPublicationPage[] = [];
    const duplicateClose = vi.fn(async () => {
      pages = pages.filter((page) => page !== duplicate);
    });
    const duplicate: PlaywrightPublicationPage = {
      ...harness.page,
      close: duplicateClose,
    };
    pages = [duplicate, harness.page];
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => pages,
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      targetPageCount: 1,
    });
    expect(duplicateClose).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([harness.page]);
  });

  it("keeps the safety gate when an exact duplicate editor cannot be closed", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      nativeEditorPayloadWrite: true,
    });
    const duplicate: PlaywrightPublicationPage = {
      ...harness.page,
      close: vi.fn(async () => {
        throw new Error("page close failed");
      }),
    };
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page, duplicate],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(adapter.inspectPrepared()).resolves.toMatchObject({
      status: "adapter_drift",
      targetPageCount: 2,
      challengeSignals: ["duplicate-target-page-unresolved"],
    });
  });
});

describe("Netease browser publication adapter", () => {
  it("ignores the image-caption prompt when verifying an image-bearing draft", async () => {
    const harness = creatorHarness(NETEASE_PUBLICATION_DEFINITION, {
      acceptedSignal: "提交成功",
      bodyDecorationText: "\n点击输入图片描述（最多30字）\n",
    });
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 1 }),
    ).resolves.toMatchObject({
      status: "ready",
      bodyEditorCount: 1,
      bodyText: expectedBody,
      expectedMediaCount: 1,
    });
  });

  it("marks a post-click Netease draft as not accepted instead of scheduling public readback", async () => {
    const harness = creatorHarness(NETEASE_PUBLICATION_DEFINITION, {
      acceptedSignal: "",
    });
    const creatorDraft = neteaseManagementPage({
      title: expectedTitle,
      timestamp: "创建于16:20",
      status: "图文草稿",
      itemUrl: "#/draft-manage",
    });
    const openCreatorPage = vi.fn(async (url: string) =>
      url === "https://mp.163.com/#/draft-manage" ? creatorDraft : harness.page,
    );
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [harness.page],
      openCreatorPage,
      openIndependentPublicPage: async () => {
        throw new Error("a retained draft must not enter public readback");
      },
      confirmationMode: "public_readback",
      now: () => new Date("2026-08-10T08:20:00.000Z"),
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "not_accepted",
      signal: "creator-management-draft-retained",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(openCreatorPage).toHaveBeenCalledWith("https://mp.163.com/#/draft-manage");
  });

  it("accepts NetEase's live success receipt after the final publish action", async () => {
    const harness = creatorHarness(NETEASE_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功,即将跳转到内容管理页",
    });
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used for a platform acknowledgement");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({
      title: expectedTitle,
      body: expectedBody,
      mediaCount: 4,
    });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "发布成功,即将跳转到内容管理页",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
  });

  it("recovers a NetEase accepted submit from the exact published creator row despite distribution limits", async () => {
    const candidateUrl = "https://www.163.com/dy/article/DEMO000000000004.html";
    const harness = creatorHarness(NETEASE_PUBLICATION_DEFINITION, {
      acceptedSignal: "",
    });
    const management = neteaseManagementPage({
      title: expectedTitle,
      timestamp: "创建于16:20",
      status: "已发布 因内容分发受限，影响内容展现。点此申诉",
      itemUrl: candidateUrl,
      surface: NETEASE_PUBLICATION_DEFINITION.creatorManagementSurface,
    });
    const openCreatorPage = vi.fn(async (url: string) =>
      url === "https://mp.163.com/#/content-manage" ? management : harness.page,
    );
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [harness.page],
      openCreatorPage,
      openIndependentPublicPage: async () => {
        throw new Error("creator recovery should classify acceptance before public readback");
      },
      now: () => new Date("2026-08-10T08:20:00.000Z"),
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "creator-management-published-title-time-matched",
      candidateExternalId: "DEMO000000000004",
      candidateExternalUrl: candidateUrl,
    });
    expect(openCreatorPage).toHaveBeenCalledWith("https://mp.163.com/#/content-manage");
  });
});

describe("Toutiao browser publication adapter", () => {
  it("pins the official editor and reviewed MIT source without accepting lookalike public URLs", () => {
    expect(TOUTIAO_ARTICLE_EDITOR_URL).toBe("https://mp.toutiao.com/profile_v4/graphic/publish");
    expect(TOUTIAO_PUBLICATION_DEFINITION.source).toEqual({
      repositoryUrl: "https://github.com/guanyang/super-publisher",
      commitSha: "ee7466c6a83f1c9af520410849f40bb2c92ba08a",
      sourcePaths: ["skills/toutiao-publisher/scripts/publisher.py"],
      licenseSpdx: "MIT",
    });
    expect(
      TOUTIAO_PUBLICATION_DEFINITION.publicSurface.canonicalizeUrl(
        "https://www.toutiao.com/article/1234567890123456789/?utm_source=test",
      ),
    ).toEqual({
      id: "1234567890123456789",
      url: "https://www.toutiao.com/article/1234567890123456789/",
    });
    expect(
      TOUTIAO_PUBLICATION_DEFINITION.publicSurface.canonicalizeUrl(
        "https://www.toutiao.com.attacker.example/article/1234567890123456789/",
      ),
    ).toBeNull();
    expect(
      TOUTIAO_PUBLICATION_DEFINITION.publicSurface.canonicalizeUrl("/article/1234567890123456789/"),
    ).toBeNull();
  });

  it("fills and reads back the exact editor payload before a two-step submit", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      candidateUrl,
    });
    const openCreatorPage = vi.fn(async () => harness.page);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage: async () =>
        publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl).page,
      ...fastOptions,
    });

    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });
    expect(prepared).toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
      primaryActionCount: 1,
    });
    expect(openCreatorPage).toHaveBeenCalledWith(TOUTIAO_ARTICLE_EDITOR_URL);
    expect(harness.noCoverClicks).toHaveBeenCalledOnce();
    expect(harness.primaryClicks).not.toHaveBeenCalled();

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "发布成功，主页查看",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).toHaveBeenCalledOnce();
  });

  it("waits for Toutiao's sourced final control and accepts its exact confirmation label", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      candidateUrl,
      finalSelector: ".publish-btn-last",
      finalLabel: "确定",
    });
    let waitCount = 0;
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () =>
        publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl).page,
      wait: async () => {
        waitCount += 1;
        if (waitCount === 2) harness.setConfirmationReady(true);
      },
      readbackAttempts: 3,
      submitObservationAttempts: 1,
      pollMs: 0,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({ outcome: "accepted" });
    expect(waitCount).toBe(2);
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).toHaveBeenCalledOnce();
  });

  it("reloads the Toutiao editor before writing a fresh draft", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      candidateUrl,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () =>
        publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl).page,
      ...fastOptions,
    });

    await adapter.writeDraft({ title: expectedTitle, body: expectedBody });
    expect(harness.goto).toHaveBeenCalledWith(TOUTIAO_ARTICLE_EDITOR_URL, {
      timeout: 10_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("ignores Toutiao editor decoration text when reading the prepared body", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      bodyDecorationText: "编辑搜图",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      bodyText: expectedBody,
    });
  });

  it("ignores whitespace variants of Toutiao editor decoration text", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      bodyDecorationText: "编辑\n搜图",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      bodyText: expectedBody,
    });
  });

  it("accepts HTML, entity, zero-width, and widget noise in DOM payload readback", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      titleReadbackText: `<span>${expectedTitle}</span>&nbsp;\u200b`,
      bodyReadbackText: `<p>${expectedBody}</p><div data-editor-widget="true">编辑搜图</div>`,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("rejects an unrelated DOM payload even when the editor is otherwise ready", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      titleReadbackText: "另一篇完全无关的文章",
      bodyReadbackText: "这是一段与审计载荷无关的正文内容。",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).rejects.toMatchObject({
      stage: "payload-readback",
    });
  });

  it("rejects a materially truncated body despite matching the opening sentence", async () => {
    const body =
      "先确认预算和日期，再安排交通与每日节奏。随后核对天气、开放时间和住宿退改规则，最后再确定每日路线。";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      bodyReadbackText: "先确认预算和日期，再安排交通与每日节奏。",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(adapter.writeDraft({ title: expectedTitle, body })).rejects.toMatchObject({
      stage: "payload-readback",
    });
  });

  it("preserves contiguous Toutiao prose around the verified inline media wrapper", async () => {
    const body = "全天从早拉到晚，真正舒服的节奏是给交通和休息留出余量。";
    const definition = {
      ...TOUTIAO_PUBLICATION_DEFINITION,
      bodyTextExcludedSelectors: ['div[__syl_tag="true"]'],
    } as const satisfies PlatformPublicationDefinition;
    const harness = creatorHarness(definition, {
      acceptedSignal: "发布成功",
      bodyInlineMediaWrapper: true,
    });
    const adapter = createPlaywrightPlatformPublicationAdapter({
      definition,
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(adapter.writeDraft({ title: expectedTitle, body })).resolves.toMatchObject({
      status: "ready",
      bodyText: body,
    });
  });

  it("waits for delayed editor controls before writing the draft", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      candidateUrl,
    });
    harness.setControlsReady(false);
    let waitCount = 0;
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => harness.page,
      openIndependentPublicPage: async () =>
        publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl).page,
      wait: async () => {
        waitCount += 1;
        if (waitCount === 2) harness.setControlsReady(true);
      },
      readbackAttempts: 3,
      submitObservationAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
    });
    expect(waitCount).toBe(2);
  });

  it("relocates a rebuilt body editor and retries the write once", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      bodyFillThrowsOnce: true,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({ status: "ready", bodyText: expectedBody });
    expect(harness.bodyFill).toHaveBeenCalledTimes(2);
  });

  it("uses the editor readiness budget independently from payload readback", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
    });
    harness.setControlsReady(false);
    let waitCount = 0;
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => harness.page,
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      wait: async () => {
        waitCount += 1;
        if (waitCount === 21) harness.setControlsReady(true);
      },
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
    });
    expect(waitCount).toBe(21);
  });

  it("does not write a draft when the editor requires an interactive challenge", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      initialChallenge: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 1 }),
    ).rejects.toThrow("sohu editor requires an interactive security challenge");
    expect(harness.titleFill).not.toHaveBeenCalled();
    expect(harness.bodyFill).not.toHaveBeenCalled();
  });

  it("reports an editor security challenge even before the editor controls hydrate", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      initialChallenge: true,
    });
    harness.setControlsReady(false);
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 1 }),
    ).rejects.toThrow("sohu editor requires an interactive security challenge");
    expect(harness.titleFill).not.toHaveBeenCalled();
    expect(harness.bodyFill).not.toHaveBeenCalled();
  });

  it("rejects an invalid editor readiness budget before a challenge can be bypassed", () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      initialChallenge: true,
    });

    expect(() =>
      createPlaywrightSohuPublicationAdapter({
        pages: () => [harness.page],
        openIndependentPublicPage: async () => {
          throw new Error("not used");
        },
        editorReadyAttempts: 0,
        ...fastOptions,
      }),
    ).toThrow("sohu editor readiness attempts must be from 1 through 240");
    expect(harness.titleFill).not.toHaveBeenCalled();
    expect(harness.bodyFill).not.toHaveBeenCalled();
  });

  it("stops before writing the body when a challenge appears after the title write", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      challengeAfterTitleFill: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 1 }),
    ).rejects.toThrow("sohu editor requires an interactive security challenge");
    expect(harness.titleFill).toHaveBeenCalledOnce();
    expect(harness.bodyFill).not.toHaveBeenCalled();
  });

  it("waits for Toutiao's delayed no-cover label and reads its visible text", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      noCoverInputValue: "1",
    });
    harness.setNoCoverReady(false);
    let waitCount = 0;
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      wait: async () => {
        waitCount += 1;
        if (waitCount === 2) harness.setNoCoverReady(true);
      },
      readbackAttempts: 3,
      submitObservationAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 0 }),
    ).resolves.toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
    });
    expect(waitCount).toBe(2);
    expect(harness.noCoverClicks).toHaveBeenCalledOnce();
  });

  it("treats Toutiao's under-review result as accepted for readback polling", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "正在审核",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "正在审核",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
  });

  it("never retries after a final click may have been dispatched", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      finalClickThrows: true,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "uncertain",
      signal: "final-submit-click-dispatch-uncertain",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(harness.finalClicks).toHaveBeenCalledOnce();
  });

  it("does not click Toutiao final confirmation when a challenge appears after preview", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      challengeAfterPrimaryClick: true,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "security-challenge-before-final-confirm",
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("does not click Sohu optional confirmation when a challenge appears after publish", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      showOptionalConfirmation: true,
      challengeAfterPrimaryClick: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({
      title: expectedTitle,
      body: expectedBody,
      mediaCount: 1,
    });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "security-challenge-before-final-confirm",
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("does not click Toutiao final confirmation when the editor surface drifts after preview", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      editorDriftAfterPrimaryClick: true,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "prepared-surface-not-ready-before-final-confirm",
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("does not click Sohu optional confirmation when the editor surface drifts after publish", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      showOptionalConfirmation: true,
      editorDriftAfterPrimaryClick: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({
      title: expectedTitle,
      body: expectedBody,
      mediaCount: 1,
    });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "prepared-surface-not-ready-before-final-confirm",
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("downgrades a Toutiao challenge even when the final confirmation is not yet visible", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功，主页查看",
      challengeAfterPrimaryClick: true,
    });
    harness.setConfirmationReady(false);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "security-challenge-before-final-confirm",
    });
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("downgrades a Sohu challenge before treating an optional confirmation as a publish", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      challengeAfterPrimaryClick: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({
      title: expectedTitle,
      body: expectedBody,
      mediaCount: 1,
    });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "security-challenge-before-final-confirm",
    });
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("ignores Sohu's hidden offscreen captcha placeholder during draft inspection", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
      hiddenChallengePlaceholder: true,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(adapter.inspectPrepared({ mediaCount: 1 })).resolves.toMatchObject({
      status: "ready",
      challengeSignals: [],
    });
  });

  it("ignores Sohu image caption and edit controls when verifying an image-bearing draft", async () => {
    const harness = creatorHarness(SOHU_PUBLICATION_DEFINITION, {
      acceptedSignal: "已提交审核",
      bodyDecorationText: "\n点击添加图片描述（最多60个字）\n编辑",
      bodyDecorationSelector: ".ql-image-container",
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 1 }),
    ).resolves.toMatchObject({
      status: "ready",
      bodyText: expectedBody,
      expectedMediaCount: 1,
    });
  });

  it("reads the current Sohu public title surface after platform DOM drift", async () => {
    const candidateUrl = "https://www.sohu.com/a/1062764699_122943573";
    const close = vi.fn(async () => undefined);
    const valuesFor = (selector: string): readonly string[] => {
      if (selector === ".text-title > h1") return [expectedTitle];
      if (selector === "article#mp-editor") return [expectedBody];
      if (selector === "#user-info h1 a") return ["小谦旅游记"];
      return [];
    };
    const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
      count: async () => valuesFor(selector).length,
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => valuesFor(selector)[index] !== undefined,
      isEnabled: async () => true,
      fill: async () => undefined,
      inputValue: async () => valuesFor(selector)[index] ?? "",
      innerText: async () => valuesFor(selector)[index] ?? "",
      textContent: async () => valuesFor(selector)[index] ?? "",
      getAttribute: async () => null,
      click: async () => undefined,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => ({
        url: () => candidateUrl,
        locator: (selector) => locatorFor(selector),
        bringToFront: async () => undefined,
        waitForLoadState: async () => undefined,
        close,
      }),
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1062764699_122943573",
        candidateExternalUrl: candidateUrl,
        expectedAccountName: "1",
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1062764699_122943573",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("blocks submit when the editor payload changes after preparation", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });
    harness.setTitle("内容已经被其他操作改动");

    await expect(adapter.submitOnce(prepared)).rejects.toThrow(
      "toutiao prepared surface changed before submit",
    );
    expect(harness.primaryClicks).not.toHaveBeenCalled();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("blocks submit when the prepared Toutiao body changes after preparation", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });
    harness.setBody(`${expectedBody} 这段内容在提交前被改动。`);

    await expect(adapter.submitOnce(prepared)).rejects.toThrow(
      "toutiao prepared surface changed before submit",
    );
    expect(harness.primaryClicks).not.toHaveBeenCalled();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("blocks a fresh adapter when the no-cover selection changes after preparation", async () => {
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
    });
    const prepareAdapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await prepareAdapter.writeDraft({
      title: expectedTitle,
      body: expectedBody,
      mediaCount: 0,
    });
    harness.setNoCoverSelected(false);
    const submitAdapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(submitAdapter.submitOnce(prepared)).rejects.toThrow(
      "toutiao prepared surface changed before submit",
    );
    expect(harness.primaryClicks).not.toHaveBeenCalled();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("confirms only through the injected independent public page and exact account binding", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const harness = creatorHarness(TOUTIAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "发布成功",
    });
    const independent = publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl);
    const openIndependentPublicPage = vi.fn(async () => independent.page);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: `${candidateUrl}?from=creator_center`,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
    expect(independent.close).toHaveBeenCalledOnce();
  });

  it("reads Toutiao's current article-content heading on the independent public page", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const close = vi.fn(async () => undefined);
    const values = new Map([
      [".article-meta .name", expectedAccountName],
      [".article-content > h1", expectedTitle],
      [".syl-page-article", expectedBody],
    ]);
    const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
      count: async () => (values.has(selector) ? 1 : 0),
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => index === 0 && values.has(selector),
      isEnabled: async () => true,
      fill: async () => undefined,
      inputValue: async () => values.get(selector) ?? "",
      innerText: async () => values.get(selector) ?? "",
      textContent: async () => values.get(selector) ?? "",
      getAttribute: async () => null,
      click: async () => undefined,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => ({
        url: () => candidateUrl,
        locator: (selector) => locatorFor(selector),
        bringToFront: async () => undefined,
        waitForLoadState: async () => undefined,
        close,
      }),
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      signal: "independent-public-payload-matched",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not confirm a Toutiao URL when the anonymous page is the platform 404 surface", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const close = vi.fn(async () => undefined);
    const values = new Map([
      ["__page-title", "404错误页"],
      ["body", "抱歉，你访问的内容不存在"],
    ]);
    const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
      count: async () => (values.has(selector) ? 1 : 0),
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => index === 0 && values.has(selector),
      isEnabled: async () => true,
      fill: async () => undefined,
      inputValue: async () => values.get(selector) ?? "",
      innerText: async () => values.get(selector) ?? "",
      textContent: async () => values.get(selector) ?? "",
      getAttribute: async () => null,
      click: async () => undefined,
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => ({
        url: () => candidateUrl,
        locator: (selector) => locatorFor(selector),
        bringToFront: async () => undefined,
        waitForLoadState: async () => undefined,
        close,
        title: async () => values.get("__page-title") ?? "",
      }),
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "not_found",
      externalId: null,
      externalUrl: null,
      signal: "public-content-not-found",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers a missing public candidate from one exact published management row", async () => {
    const itemUrl = "/item/1234567890123456789/";
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const management = toutiaoManagementPage({
      title: expectedTitle,
      timestamp: "08-04 21:32",
      status: "已发布",
      itemUrl,
    });
    const independent = publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl);
    const openCreatorPage = vi.fn(async () => management);
    const openIndependentPublicPage = vi.fn(async () => independent.page);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T13:32:14.416Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(openCreatorPage).toHaveBeenCalledWith(
      "https://mp.toutiao.com/profile_v4/manage/content/all",
    );
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
  });

  it("recovers a published row when the Linux browser renders the management time in UTC", async () => {
    const itemUrl = "/item/1234567890123456789/";
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const management = toutiaoManagementPage({
      title: expectedTitle,
      timestamp: "08-04 18:25",
      status: "已发布",
      itemUrl,
    });
    const independent = publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl);
    const openCreatorPage = vi.fn(async () => management);
    const openIndependentPublicPage = vi.fn(async () => independent.page);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(openCreatorPage).toHaveBeenCalledWith(
      "https://mp.toutiao.com/profile_v4/manage/content/all",
    );
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
  });

  it("confirms publisher status from a matched Toutiao management row without opening public readback", async () => {
    const itemUrl = "/item/1234567890123456789/";
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const management = toutiaoManagementPage({
      title: expectedTitle,
      timestamp: "08-04 18:25",
      status: "已发布",
      itemUrl,
    });
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("public readback must not run for publisher-status completion");
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "publisher_status",
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "creator-management-published-title-time-matched",
    });
    expect(openIndependentPublicPage).not.toHaveBeenCalled();
  });

  it("waits for asynchronously hydrated published management rows", async () => {
    const itemUrl = "/item/1234567890123456789/";
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const management = toutiaoManagementPage({
      title: expectedTitle,
      timestamp: "08-04 18:25",
      status: "已发布",
      itemUrl,
      rowDelayReads: 1,
    });
    const independent = publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl);
    const wait = vi.fn(async () => undefined);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => independent.page,
      ...fastOptions,
      readbackAttempts: 2,
      wait,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("refuses a public page that is still owned by the creator profile", async () => {
    const candidateUrl = "https://www.toutiao.com/article/1234567890123456789/";
    const creatorPublicPage = publicPage(TOUTIAO_PUBLICATION_DEFINITION, candidateUrl);
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [creatorPublicPage.page],
      openIndependentPublicPage: async () => creatorPublicPage.page,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "public-page-reused-creator-profile",
    });
    expect(creatorPublicPage.close).not.toHaveBeenCalled();
  });

  it("reports Toutiao creator-management rejection as a platform audit failure", async () => {
    const management = toutiaoManagementPage({
      title: expectedTitle,
      timestamp: "08-04 18:25",
      status: "审核未通过 广告软文",
      itemUrl: "/profile_v4/manage/content/all",
    });
    const adapter = createPlaywrightToutiaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => {
        throw new Error("rejected content must not open public readback");
      },
      confirmationMode: "publisher_status",
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      signal: "creator-management-rejected-soft-advertorial",
    });
  });
});

describe("Baijiahao browser publication adapter", () => {
  it("pins the official editor and canonical public URL format", () => {
    expect(BAIJIAHAO_ARTICLE_EDITOR_URL).toBe(
      "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1",
    );
    expect(BAIJIAHAO_CONTENT_MANAGER_URL).toBe(
      "https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10&search=&type=&collection=&startDate=&endDate=",
    );
    expect(BAIJIAHAO_PUBLICATION_DEFINITION.creatorManagementSurface).toMatchObject({
      url: BAIJIAHAO_CONTENT_MANAGER_URL,
      publicStatusLabels: ["已发布", "发布成功", "已上线"],
    });
    expect(BAIJIAHAO_PUBLICATION_DEFINITION.source).toEqual({
      repositoryUrl: "https://github.com/xiaohao80/baijiahao-auto-publisher",
      commitSha: "e6eea968bb495f2a9156998f6ef4b777f143c4b0",
      sourcePaths: ["baijiahao_publisher.py"],
      licenseSpdx: null,
    });
    expect(
      BAIJIAHAO_PUBLICATION_DEFINITION.publicSurface.canonicalizeUrl(
        "https://baijiahao.baidu.com/s?id=1234567890123456789&wfr=spider&for=pc",
      ),
    ).toEqual({
      id: "1234567890123456789",
      url: "https://baijiahao.baidu.com/s?id=1234567890123456789",
    });
    expect(
      BAIJIAHAO_PUBLICATION_DEFINITION.publicSurface.canonicalizeUrl(
        "http://baijiahao.baidu.com/s?id=1234567890123456789",
      ),
    ).toBeNull();
  });

  it("confirms Baijiahao publisher status from the content manager without public navigation", async () => {
    const itemUrl = "http://baijiahao.baidu.com/s?id=1234567890123456789";
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-04 18:25",
      status: "已发布",
      itemUrl,
    });
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("public readback must not run for publisher-status completion");
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "publisher_status",
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "creator-management-published-title-time-matched",
    });
    expect(openIndependentPublicPage).not.toHaveBeenCalled();
  });

  it("reports Baijiahao creator-management rejection without waiting for a public URL", async () => {
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-04 18:25",
      status: "审核未通过",
      itemUrl: "/builder/rc/content",
      rejectionReason: "文章被平台判定为广告软文",
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => {
        throw new Error("rejected content must not open public readback");
      },
      confirmationMode: "publisher_status",
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      signal: "creator-management-rejected-soft-advertorial",
    });
  });

  it("recovers Baijiahao publisher status when the title node and public URL are separate", async () => {
    const itemUrl = "http://baijiahao.baidu.com/s?id=1234567890123456789";
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-04 18:25",
      status: "已发布",
      itemUrl,
      separateTitleAndUrl: true,
      itemLinkCount: 2,
      generatedStatusClass: true,
    });
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("public readback must not run for publisher-status completion");
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "publisher_status",
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T18:25:18.545Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "creator-management-published-title-time-matched",
    });
    expect(openIndependentPublicPage).not.toHaveBeenCalled();
  });

  it("recovers a missing public candidate from a published management row", async () => {
    const itemUrl = "/s?id=1234567890123456789";
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-04 21:32:14",
      status: "已发布",
      itemUrl,
    });
    const independent = publicPage(BAIJIAHAO_PUBLICATION_DEFINITION, candidateUrl);
    const openCreatorPage = vi.fn(async () => management);
    const openIndependentPublicPage = vi.fn(async () => independent.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T13:32:14.416Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(openCreatorPage).toHaveBeenCalledWith(BAIJIAHAO_CONTENT_MANAGER_URL);
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
  });

  it("verifies the payload, handles one exact confirmation and records accepted as non-final", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      candidateUrl,
      showOptionalConfirmation: true,
      bodyInFrame: true,
    });
    const openCreatorPage = vi.fn(async () => harness.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage: async () =>
        publicPage(BAIJIAHAO_PUBLICATION_DEFINITION, candidateUrl).page,
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });
    expect(openCreatorPage).toHaveBeenCalledWith(BAIJIAHAO_ARTICLE_EDITOR_URL);
    expect(harness.goto).not.toHaveBeenCalled();

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "文章已提交审核",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).toHaveBeenCalledOnce();
  });

  it("writes Baijiahao title and body through the parent UEditor model when it is available", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      bodyInFrame: true,
      nativeEditorPayloadWrite: true,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
    });
    expect(harness.nativeEditorPayloadWrite).toHaveBeenCalledWith({
      title: expectedTitle,
      body: expectedBody,
      bodyHtml: `<p>${expectedBody}</p>`,
    });
    expect(harness.titleFill).not.toHaveBeenCalled();
    expect(harness.bodyFill).not.toHaveBeenCalled();
  });

  it("writes and verifies ten sequential Baijiahao drafts without reloading the editor", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      bodyInFrame: true,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    for (let index = 1; index <= 10; index += 1) {
      await expect(
        adapter.writeDraft({
          title: `${expectedTitle}-${index}`,
          body: `${expectedBody}-${index}`,
        }),
      ).resolves.toMatchObject({ status: "ready", titleText: `${expectedTitle}-${index}` });
    }
    expect(harness.goto).not.toHaveBeenCalled();
  });

  it("excludes Baijiahao image controls from structural body verification", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      bodyInFrame: true,
      bodyDecorationText: "删除 裁剪 搜图",
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody, mediaCount: 4 }),
    ).resolves.toMatchObject({ status: "ready", bodyText: expectedBody });
  });

  it("recovers an accepted submit from the exact published management row when the toast is missing", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "",
      bodyInFrame: true,
    });
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-07 23:59:00",
      status: "已发布",
      itemUrl: "http://baijiahao.baidu.com/s?id=1234567890123456789",
    });
    const openCreatorPage = vi.fn(async (url: string) =>
      url === BAIJIAHAO_CONTENT_MANAGER_URL ? management : harness.page,
    );
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openCreatorPage,
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      confirmationMode: "publisher_status",
      now: () => new Date("2026-08-07T15:59:00.000Z"),
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "creator-management-published-title-time-matched",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
  });

  it("waits for a transient Baijiahao body-frame reload before drafting", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      bodyInFrame: true,
      bodyFrameDetachReads: 5,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
      readbackAttempts: 3,
    });

    await expect(
      adapter.writeDraft({ title: expectedTitle, body: expectedBody }),
    ).resolves.toMatchObject({
      status: "ready",
      titleText: expectedTitle,
      bodyText: expectedBody,
    });
  });

  it("does not click a second time when the direct publish click times out", async () => {
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
      primaryClickThrows: true,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      ...fastOptions,
    });
    const prepared = await adapter.writeDraft({ title: expectedTitle, body: expectedBody });

    await expect(adapter.submitOnce(prepared)).resolves.toMatchObject({
      outcome: "uncertain",
      signal: "primary-submit-click-dispatch-uncertain",
    });
    expect(harness.primaryClicks).toHaveBeenCalledOnce();
    expect(harness.finalClicks).not.toHaveBeenCalled();
  });

  it("keeps a creator-center acceptance separate from exact independent public readback", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const harness = creatorHarness(BAIJIAHAO_PUBLICATION_DEFINITION, {
      acceptedSignal: "文章已提交审核",
    });
    const mismatched = publicPage(BAIJIAHAO_PUBLICATION_DEFINITION, candidateUrl, {
      accountName: "另一个百家号账号",
    });
    const openIndependentPublicPage = vi.fn(async () => mismatched.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [harness.page],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: `${candidateUrl}&wfr=spider`,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "mismatch",
      externalId: null,
      externalUrl: null,
      observedAccountName: "另一个百家号账号",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
    expect(mismatched.close).toHaveBeenCalledOnce();
  });

  it("rejects an untrusted public candidate before opening a browser page", async () => {
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl:
          "https://baijiahao.baidu.com.attacker.example/s?id=1234567890123456789",
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable", signal: "public-url-not-allowed" });
    expect(openIndependentPublicPage).not.toHaveBeenCalled();
  });

  it("keeps a failed independent public navigation unavailable", async () => {
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("public endpoint did not load");
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "independent-public-navigation-unavailable",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(
      "https://baijiahao.baidu.com/s?id=1234567890123456789",
    );
  });

  it("keeps an official public URL retryable while article payload nodes are not rendered", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const pending = publicPage(BAIJIAHAO_PUBLICATION_DEFINITION, candidateUrl, {
      payload: false,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => pending.page,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
      externalId: null,
      externalUrl: null,
      signal: "public-payload-nodes-missing-or-ambiguous",
    });
    expect(pending.close).toHaveBeenCalledOnce();
  });

  it("keeps a Baidu security verification page retryable without account verification", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const challenged = securityVerificationPublicPage(candidateUrl);
    const openIndependentPublicPage = vi.fn(async () => challenged.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      externalId: null,
      externalUrl: null,
      signal: "public-payload-nodes-missing-or-ambiguous",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(candidateUrl);
    expect(challenged.close).toHaveBeenCalledOnce();
  });

  it("confirms public readback when a challenge overlay is present alongside the payload", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const challenged = publicPage(BAIJIAHAO_PUBLICATION_DEFINITION, candidateUrl, {
      challenge: true,
    });
    const openIndependentPublicPage = vi.fn(async () => challenged.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(challenged.close).toHaveBeenCalledOnce();
  });

  it("keeps a wappass redirect unavailable without treating it as an account-verification gate", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const challenged = securityVerificationPublicPage(
      "https://wappass.baidu.com/static/captcha/tuxing.html?backurl=https%3A%2F%2Fbaijiahao.baidu.com%2Fs%3Fid%3D1234567890123456789",
    );
    const openIndependentPublicPage = vi.fn(async () => challenged.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      externalId: null,
      externalUrl: null,
      signal: "public-navigation-left-allowed-canonical-url",
    });
    expect(challenged.close).toHaveBeenCalledOnce();
  });

  it("keeps public readback pending when the anonymous public page is challenged", async () => {
    const itemUrl = "/s?id=1234567890123456789";
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const management = baijiahaoManagementPage({
      title: expectedTitle,
      timestamp: "2026-08-04 21:32:14",
      status: "已发布",
      itemUrl,
    });
    const challenged = securityVerificationPublicPage(candidateUrl);
    const openCreatorPage = vi.fn(async () => management);
    const openIndependentPublicPage = vi.fn(async () => challenged.page);
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openCreatorPage,
      openIndependentPublicPage,
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt: "2026-08-04T13:32:14.416Z",
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: candidateUrl,
      externalId: null,
      externalUrl: null,
      signal: "public-payload-nodes-missing-or-ambiguous",
    });
    expect(openCreatorPage).not.toHaveBeenCalled();
    expect(challenged.close).toHaveBeenCalledOnce();
  });

  it("confirms the current Baijiahao public article surface selectors", async () => {
    const candidateUrl = "https://baijiahao.baidu.com/s?id=1234567890123456789";
    const close = vi.fn(async () => undefined);
    const markdownBody =
      "## 出发前一晚，我爸妈问了一个让我答不上来的问题\n\n**住在市南市北**：离机场近是优势。";
    const plainBody =
      "出发前一晚，我爸妈问了一个让我答不上来的问题 住在市南市北：离机场近是优势。 举报/反馈";
    const values = new Map([
      ["#header > div:first-child", expectedTitle],
      ['#header [data-testid="author-name"]', expectedAccountName],
      ['[data-testid="article"]', plainBody],
    ]);
    const counts = new Map([
      ['#header a[href*="author.baidu.com/home"]', 2],
      ['#header [data-testid="author-name"]', 1],
      ['[data-testid="author-name"]', 1],
    ]);
    const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
      count: async () => counts.get(selector) ?? (values.has(selector) ? 1 : 0),
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => index === 0 && values.has(selector),
      isEnabled: async () => true,
      fill: async () => undefined,
      inputValue: async () => values.get(selector) ?? "",
      innerText: async () => values.get(selector) ?? "",
      textContent: async () => values.get(selector) ?? "",
      evaluate: (async () =>
        (values.get(selector) ?? "")
          .replace(/举报\/反馈/gu, "")
          .replace(/\s+/gu, " ")
          .trim()) as unknown as NonNullable<PlaywrightPublicationLocator["evaluate"]>,
      getAttribute: async () => null,
      click: async () => undefined,
    });
    const adapter = createPlaywrightBaijiahaoPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => ({
        url: () => candidateUrl,
        locator: (selector) => locatorFor(selector),
        bringToFront: async () => undefined,
        waitForLoadState: async () => undefined,
        title: async () => "",
        close,
      }),
      ...fastOptions,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "1234567890123456789",
        candidateExternalUrl: candidateUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody: markdownBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      externalUrl: candidateUrl,
      signal: "independent-public-payload-matched",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
