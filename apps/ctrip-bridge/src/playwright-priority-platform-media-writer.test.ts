import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { MediaReference } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import {
  createPlaywrightPriorityPlatformMediaWriter,
  PriorityPlatformMediaWriteError,
  type PlaywrightPriorityPlatformMediaFile,
  type PlaywrightPriorityPlatformMediaFrame,
  type PlaywrightPriorityPlatformMediaLocator,
  type PlaywrightPriorityPlatformMediaPage,
} from "./playwright-priority-platform-media-writer.js";
import type { CtripTrustedMediaAttachment } from "./types.js";

const mediaWriterSource = await readFile(
  new URL("./playwright-priority-platform-media-writer.ts", import.meta.url),
  "utf8",
);

function mediaAttachment(
  platform: "toutiao" | "baijiahao" | "sohu" | "netease" | "zhihu",
  role: "cover" | "inline" = "cover",
  position = role === "cover" ? 0 : 1,
): CtripTrustedMediaAttachment {
  const bytes =
    role === "cover" ? Uint8Array.from([137, 80, 78, 71]) : Uint8Array.from([255, 216, 255, 224]);
  return {
    position,
    bytes,
    reference: {
      id:
        role === "cover"
          ? "10000000-0000-4000-8000-000000000007"
          : "10000000-0000-4000-8000-000000000008",
      platform,
      role,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mimeType: role === "cover" ? "image/png" : "image/jpeg",
      altText: role === "cover" ? "云南旅行封面" : "云南旅行正文图",
      caption: role === "cover" ? "云南旅行封面" : "云南旅行正文图",
    } as unknown as MediaReference,
  };
}

function zhihuPage() {
  let coverImageCount = 0;
  let inlineImageCount = 0;
  let inlineInputMounted = false;
  const operations: string[] = [];
  const locator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const coverInput =
      selector ===
      'label.UploadPicture-wrapper input.UploadPicture-input[type="file"][accept*=".png"]';
    const coverPreview = selector === "label.UploadPicture-wrapper img";
    const editor =
      selector === 'div.public-DraftEditor-content[contenteditable="true"][role="textbox"]';
    const inlinePreview =
      selector === 'div.public-DraftEditor-content[contenteditable="true"][role="textbox"] img';
    const inlineTrigger = selector === 'button[aria-label="图片"]';
    const inlineInput =
      selector === 'input[type="file"][accept*="image"]:not(.UploadPicture-input)';
    const control = coverInput || editor || inlineTrigger || inlineInput;
    return {
      count: async () =>
        coverPreview ? coverImageCount : inlinePreview ? inlineImageCount : control ? 1 : 0,
      nth: () => locator(selector),
      first: () => locator(selector),
      isVisible: async () =>
        coverPreview ? coverImageCount > 0 : inlinePreview ? inlineImageCount > 0 : control,
      click: async () => {
        operations.push(`click:${selector}`);
        if (inlineTrigger) inlineInputMounted = true;
      },
      setInputFiles: async (file) => {
        operations.push(`upload:${selector}:${mediaFileNames(file)}:${mediaFileHex(file)}`);
        if (coverInput) coverImageCount = 1;
        else if (inlineInput && inlineInputMounted) inlineImageCount += 1;
        else throw new Error("Zhihu received files outside the expected input");
      },
    };
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () => "https://zhuanlan.zhihu.com/write",
    locator,
    bringToFront: async () => undefined,
    evaluate: async <Result>() => false as Result,
  };
  return { page, operations };
}

function mediaFiles(
  input: PlaywrightPriorityPlatformMediaFile | readonly PlaywrightPriorityPlatformMediaFile[],
): readonly PlaywrightPriorityPlatformMediaFile[] {
  return (Array.isArray(input) ? input : [input]) as readonly PlaywrightPriorityPlatformMediaFile[];
}

function mediaFileHex(
  input: PlaywrightPriorityPlatformMediaFile | readonly PlaywrightPriorityPlatformMediaFile[],
): string {
  return mediaFiles(input)
    .map((file) => file.buffer.toString("hex"))
    .join(",");
}

function mediaFileNames(
  input: PlaywrightPriorityPlatformMediaFile | readonly PlaywrightPriorityPlatformMediaFile[],
): string {
  return mediaFiles(input)
    .map((file) => file.name)
    .join(",");
}

interface ChallengeTestElement {
  readonly parentElement: ChallengeTestElement | null;
  readonly style: {
    readonly display: string;
    readonly visibility: string;
    readonly opacity: string;
    readonly pointerEvents: string;
  };
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

async function evaluateChallengeProbe<Result, Argument>(
  pageFunction: (argument: Argument) => Result | Promise<Result>,
  argument: Argument,
  options: {
    readonly platform?: "sohu" | "netease";
    readonly hidden?: boolean;
  } = {},
): Promise<Result> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const parent: ChallengeTestElement | null =
    options.hidden === true
      ? {
          parentElement: null,
          style: {
            display: "block",
            visibility: "visible",
            opacity: "0",
            pointerEvents: "auto",
          },
          getAttribute: () => null,
          getBoundingClientRect: () => ({
            width: 320,
            height: 180,
            top: -1_000_000,
            right: 320,
            bottom: -999_820,
            left: 0,
          }),
        }
      : null;
  const challenge: ChallengeTestElement = {
    parentElement: parent,
    style: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    },
    getAttribute: (name) =>
      name === "src"
        ? options.platform === "sohu"
          ? "https://turing.captcha.gtimg.com/1/template/drag_ele.html"
          : "https://cstaticdun.126.net/load.min.html"
        : null,
    getBoundingClientRect: () =>
      options.hidden === true
        ? {
            width: 320,
            height: 180,
            top: -1_000_000,
            right: 320,
            bottom: -999_820,
            left: 0,
          }
        : { width: 320, height: 180, top: 120, right: 520, bottom: 300, left: 200 },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      defaultView: {
        innerHeight: 720,
        innerWidth: 1_280,
        getComputedStyle: (element: ChallengeTestElement) => element.style,
      },
      querySelectorAll: (selector: string) => {
        if (options.platform === undefined) return [];
        if (selector === "iframe") return [challenge];
        if (options.platform === "sohu") {
          return /captcha|tcaptcha/iu.test(selector) ? [challenge] : [];
        }
        return /captcha|yidun/iu.test(selector) ? [challenge] : [];
      },
    },
  });
  try {
    return await pageFunction(argument);
  } finally {
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", originalDocument);
  }
}

function neteasePage(
  options: {
    readonly existingImageCount?: number;
    readonly watermarkEnabled?: boolean;
    readonly confirmEnabled?: boolean;
    readonly challengeAfterImageTrigger?: boolean;
    readonly modalStaysOpen?: boolean;
    readonly watermarkOptionDelayed?: boolean;
    readonly modalLocatorRequiresBoundThis?: boolean;
    readonly uploadInputHidden?: boolean;
  } = {},
) {
  const editorSelector = ".public-DraftEditor-content[contenteditable='true']";
  const modalSelector = ".ne-modal.picture-adder";
  let editorImageCount = options.existingImageCount ?? 0;
  let stagedPreviewCount = 0;
  let modalOpen = false;
  let autoCoverSelected = false;
  let watermarkEnabled = options.watermarkEnabled ?? true;
  let watermarkOptionMounted = options.watermarkOptionDelayed !== true;
  let challengeVisible = options.challengeAfterImageTrigger === true;
  let filesUploaded = false;
  const operations: string[] = [];

  const locator = (
    selector: string,
    scope:
      "page" | "modal" | "watermark-option" | "library-option" | "watermark" | "library" = "page",
  ): PlaywrightPriorityPlatformMediaLocator => {
    const pageEditor = scope === "page" && selector === editorSelector;
    const editorPreview = scope === "page" && selector === `${editorSelector} img`;
    const autoCoverLabel =
      scope === "page" &&
      selector === "label.cover-pic__radio:has(input[type='radio'][value='auto'])";
    const autoCoverInput = scope === "page" && selector === "input[type='radio'][value='auto']";
    const imageTrigger =
      scope === "page" && selector === "button.rich-editor-panel-item:has(img[src*='icon_image'])";
    const modal = scope === "page" && selector === modalSelector;
    const modalPreview = scope === "page" && selector === `${modalSelector} img`;
    const modalOptions = scope === "modal" && selector === ".picture-adder-opts-item";
    const watermarkOption = scope === "watermark-option" && selector === ".picture-adder-opts-item";
    const libraryOption = scope === "library-option" && selector === ".picture-adder-opts-item";
    const uploadInput = scope === "modal" && selector === "input[type='file'][name='pic']";
    const uploadConfirm = scope === "modal" && selector === "button.s-confirm-btn";
    const watermarkInput = scope === "watermark" && selector === "input[type='checkbox']";
    const watermarkToggle = scope === "watermark" && selector === "span[role='button']";
    const libraryInput = scope === "library" && selector === "input[type='checkbox']";
    const libraryToggle = scope === "library" && selector === "span[role='button']";
    const control =
      pageEditor ||
      autoCoverLabel ||
      autoCoverInput ||
      imageTrigger ||
      modal ||
      modalOptions ||
      watermarkOption ||
      libraryOption ||
      uploadInput ||
      uploadConfirm ||
      watermarkInput ||
      watermarkToggle ||
      libraryInput ||
      libraryToggle;
    const visible = editorPreview
      ? editorImageCount > 0
      : modalPreview
        ? modalOpen && stagedPreviewCount > 0
        : modal
          ? modalOpen
          : watermarkOption
            ? modalOpen && watermarkOptionMounted
            : libraryOption
              ? modalOpen
              : uploadInput
                ? modalOpen && options.uploadInputHidden !== true
                : modalOptions || uploadConfirm
                  ? modalOpen
                  : watermarkInput || watermarkToggle || libraryInput || libraryToggle
                    ? modalOpen
                    : control;
    const result: PlaywrightPriorityPlatformMediaLocator = {
      count: async () =>
        editorPreview
          ? editorImageCount
          : modalPreview
            ? modalOpen
              ? stagedPreviewCount
              : 0
            : modalOptions
              ? 2
              : control
                ? 1
                : 0,
      nth: (index) =>
        modalOptions
          ? locator(selector, index === 0 ? "watermark-option" : "library-option")
          : locator(selector, scope),
      first: () =>
        modalOptions ? locator(selector, "watermark-option") : locator(selector, scope),
      locator(childSelector) {
        if (options.modalLocatorRequiresBoundThis === true && modal && this !== result) {
          throw new Error("NetEase modal locator lost its receiver");
        }
        if (modal && childSelector === ".picture-adder-opts-item") {
          return locator(childSelector, "modal");
        }
        if (modal && childSelector === "input[type='file'][name='pic']") {
          return locator(childSelector, "modal");
        }
        if (modal && childSelector === "button.s-confirm-btn") {
          return locator(childSelector, "modal");
        }
        if (watermarkOption && childSelector === "input[type='checkbox']") {
          return locator(childSelector, "watermark");
        }
        if (watermarkOption && childSelector === "span[role='button']") {
          return locator(childSelector, "watermark");
        }
        if (libraryOption && childSelector === "input[type='checkbox']") {
          return locator(childSelector, "library");
        }
        if (libraryOption && childSelector === "span[role='button']") {
          return locator(childSelector, "library");
        }
        return locator(childSelector, "page");
      },
      isVisible: async () => visible,
      isEnabled: async () =>
        uploadConfirm ? modalOpen && filesUploaded && options.confirmEnabled !== false : visible,
      isChecked: async () =>
        autoCoverInput ? autoCoverSelected : watermarkInput ? watermarkEnabled : false,
      textContent: async () =>
        watermarkOption ? "上传时添加水印" : libraryOption ? "确认后添加至素材库" : null,
      click: async () => {
        operations.push(`click:${scope}:${selector}`);
        if (autoCoverLabel) autoCoverSelected = true;
        if (imageTrigger) modalOpen = true;
        if (watermarkToggle) watermarkEnabled = false;
        if (uploadConfirm && modalOpen && filesUploaded && options.confirmEnabled !== false) {
          editorImageCount = stagedPreviewCount;
          if (options.modalStaysOpen !== true) modalOpen = false;
        }
      },
      setInputFiles: async (file) => {
        if (!uploadInput) throw new Error("NetEase received files outside the native image input");
        const files = mediaFiles(file);
        operations.push(
          `upload:${scope}:${selector}:${mediaFileNames(files)}:${mediaFileHex(files)}`,
        );
        filesUploaded = true;
        stagedPreviewCount = files.length;
      },
    };
    return result;
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () => "https://mp.163.com/#/article-publish",
    locator,
    bringToFront: async () => undefined,
    evaluate: async <Result, Argument>(
      pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument: Argument,
    ) => {
      if ((argument as { readonly challengeProbe?: boolean }).challengeProbe === true) {
        return evaluateChallengeProbe(
          pageFunction,
          argument,
          challengeVisible && modalOpen ? { platform: "netease" } : {},
        );
      }
      throw new Error("NetEase native upload path must not dispatch synthetic editor image events");
    },
  };
  return {
    page,
    operations,
    markWatermarkOptionMounted: () => {
      watermarkOptionMounted = true;
    },
    activateChallenge: () => {
      challengeVisible = true;
    },
  };
}

function sohuPage(
  options: {
    readonly coverPreviewHasUrl?: boolean;
    readonly delayedCoverConfirm?: boolean;
    readonly delayedCoverSettle?: boolean;
    readonly delayedInlineInsert?: boolean;
    readonly dispatchReturnsFalse?: boolean;
    readonly hiddenChallenge?: boolean;
  } = {},
) {
  let coverImageCount = 0;
  let inlineImageCount = 0;
  let pendingInlineImageCount = 0;
  let uploaded = false;
  let coverConfirmReady = options.delayedCoverConfirm !== true;
  let coverModalOpen = false;
  const operations: string[] = [];
  const locator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const trigger = selector === "span.upload-tip";
    const tab = selector === "h3";
    const input = selector === "input[type='file']";
    const confirm = selector === "p.button.positive-button";
    const coverModal = selector === ".el-dialog__wrapper.select-dialog";
    const editor = selector === "div.ql-editor[contenteditable='true']";
    const coverPreview =
      selector === "div.pic-cover[style*='url(']" && options.coverPreviewHasUrl !== false;
    const inlinePreview = selector === "div.ql-editor[contenteditable='true'] img";
    const challenge =
      options.hiddenChallenge === true &&
      ['iframe[src*="captcha" i]', '[class*="tcaptcha" i]', '[id*="tcaptcha" i]'].includes(
        selector,
      );
    const control = trigger || tab || input || confirm || editor;
    return {
      count: async () =>
        coverPreview
          ? coverImageCount
          : inlinePreview
            ? inlineImageCount
            : coverModal
              ? coverModalOpen
                ? 1
                : 0
              : control || challenge
                ? 1
                : 0,
      nth: () => locator(selector),
      first: () => locator(selector),
      isVisible: async () =>
        coverPreview
          ? coverImageCount > 0
          : inlinePreview
            ? inlineImageCount > 0
            : coverModal
              ? coverModalOpen
              : confirm
                ? uploaded && coverConfirmReady
                : control || challenge,
      isEnabled: async () => (confirm ? uploaded && coverConfirmReady : control),
      textContent: async () => (tab ? "本地上传" : confirm ? "确定" : null),
      click: async () => {
        operations.push(`click:${selector}`);
        if (trigger) coverModalOpen = true;
        if (confirm && uploaded && coverConfirmReady) {
          coverImageCount = 1;
          if (options.delayedCoverSettle !== true) coverModalOpen = false;
        }
      },
      setInputFiles: async (file) => {
        operations.push(`cover-upload:${selector}:${mediaFileHex(file)}`);
        uploaded = true;
      },
    };
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () => "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1",
    locator,
    frames: () =>
      options.hiddenChallenge === true
        ? [
            {
              url: () => "https://turing.captcha.gtimg.com/1/template/drag_ele.html",
              locator: () => locator("unmatched"),
              evaluate: async <Result>() => false as Result,
            },
          ]
        : [],
    bringToFront: async () => undefined,
    evaluate: async <Result, Argument>(
      pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument: Argument,
    ) => {
      if ((argument as { readonly challengeProbe?: boolean }).challengeProbe === true) {
        return evaluateChallengeProbe(
          pageFunction,
          argument,
          options.hiddenChallenge === true ? { platform: "sohu", hidden: true } : {},
        );
      }
      const event = argument as {
        readonly bytes: readonly number[];
        readonly eventType: string;
        readonly targetSelector: string;
      };
      operations.push(
        `dispatch:${event.eventType}:${event.targetSelector}:${Buffer.from(event.bytes).toString("hex")}`,
      );
      if (options.delayedInlineInsert === true) pendingInlineImageCount += 1;
      else inlineImageCount += 1;
      return (options.dispatchReturnsFalse !== true) as Result;
    },
  };
  return {
    page,
    operations,
    markCoverConfirmReady: () => {
      coverConfirmReady = true;
    },
    markCoverSettled: () => {
      coverModalOpen = false;
    },
    markInlineInsertReady: () => {
      inlineImageCount += pendingInlineImageCount;
      pendingInlineImageCount = 0;
    },
  };
}

function challengePage(platform: "sohu" | "netease") {
  const challengeSelector = platform === "sohu" ? 'iframe[src*="captcha" i]' : '[class*="yidun" i]';
  const challengeFrameUrl =
    platform === "sohu"
      ? "https://turing.captcha.gtimg.com/1/template/drag_ele.html"
      : "https://cstaticdun.126.net/load.min.html";
  const locator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const challenge = selector === challengeSelector;
    return {
      count: async () => (challenge ? 1 : 0),
      nth: () => locator(selector),
      first: () => locator(selector),
      isVisible: async () => challenge,
      isEnabled: async () => false,
      click: async () => {
        throw new Error("challenge page must not receive media clicks");
      },
      setInputFiles: async () => {
        throw new Error("challenge page must not receive media files");
      },
    };
  };
  const frame: PlaywrightPriorityPlatformMediaFrame = {
    url: () => challengeFrameUrl,
    locator: () => locator("unmatched"),
    evaluate: async <Result>() => false as Result,
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () =>
      platform === "sohu"
        ? "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1"
        : "https://mp.163.com/#/article-publish",
    locator,
    frames: () => [frame],
    bringToFront: async () => undefined,
    evaluate: async <Result, Argument>(
      pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument: Argument,
    ) => {
      if ((argument as { readonly challengeProbe?: boolean }).challengeProbe === true) {
        return evaluateChallengeProbe(pageFunction, argument, { platform });
      }
      throw new Error("challenge page must not receive media events");
    },
  };
  return page;
}

function baijiahaoPage(
  options: {
    readonly confirmAcceptedAfterClicks?: number;
    readonly confirmEnabledAfter?: number;
    readonly frameReady?: boolean;
    readonly controlsReady?: boolean;
    readonly confirmText?: string;
    readonly tabText?: string;
    readonly existingCover?: boolean;
    readonly directChildCoverPreview?: boolean;
    readonly delayedInlineModalClose?: boolean;
    readonly persistentInlineModalWrapper?: boolean;
    readonly inlineTriggerTimesOutAfterOpening?: boolean;
  } = {},
) {
  let coverImageCount = options.existingCover === true ? 1 : 0;
  let inlineImageCount = 0;
  let frameReady = options.frameReady ?? true;
  let controlsReady = options.controlsReady ?? true;
  let confirmChecks = 0;
  let confirmClicks = 0;
  let modalOpen = false;
  let inlineEditorFocused = false;
  let inlineModalOpen = false;
  let inlineUploaded = false;
  let inlineConfirmVisible = true;
  let inlineModalClosePending = false;
  const operations: string[] = [];
  const frameLocator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const editor = selector === "body[contenteditable='true']";
    const preview = selector === "body[contenteditable='true'] img";
    const inlineTrigger = selector === ".edui-for-insertimage .edui-button-body";
    const inlineInput =
      selector ===
      ".cheetah-modal input[type='file'][accept='image/*'], .cheetah-modal-wrap input[type='file'][accept='image/*']";
    const inlineConfirm = selector === ".cheetah-modal button, .cheetah-modal-wrap button";
    const inlineModal = selector === ".cheetah-modal, .cheetah-modal-wrap";
    const control = editor || inlineTrigger || inlineInput || inlineConfirm;
    return {
      count: async () =>
        preview ? inlineImageCount : inlineModal ? (inlineModalOpen ? 1 : 0) : control ? 1 : 0,
      nth: () => frameLocator(selector),
      first: () => frameLocator(selector),
      isVisible: async () =>
        preview
          ? inlineImageCount > 0
          : inlineInput || inlineConfirm
            ? inlineModalOpen
            : inlineModal
              ? inlineModalOpen
              : control,
      isEnabled: async () =>
        inlineTrigger
          ? inlineEditorFocused
          : inlineConfirm
            ? inlineModalOpen && inlineUploaded
            : control,
      textContent: async () => (inlineConfirm ? "确认" : null),
      click: async () => {
        operations.push(`frame-click:${selector}`);
        if (editor) inlineEditorFocused = true;
        if (inlineTrigger && inlineEditorFocused) inlineModalOpen = true;
        if (inlineConfirm && inlineModalOpen && inlineUploaded) {
          inlineImageCount += 1;
          inlineModalOpen = false;
          inlineUploaded = false;
        }
      },
      setInputFiles: async (file) => {
        operations.push(`inline-upload:${selector}:${mediaFileHex(file)}`);
        if (inlineInput && inlineModalOpen) inlineUploaded = true;
      },
    };
  };
  const frame: PlaywrightPriorityPlatformMediaFrame = {
    url: () => "https://baijiahao.baidu.com/builder/inner-editor",
    locator: frameLocator,
    evaluate: async <Result, Argument>(_pageFunction: unknown, argument: Argument) => {
      if (typeof argument === "string") {
        operations.push(`frame-restore-caret:${argument}`);
        inlineEditorFocused = true;
        return true as Result;
      }
      const event = argument as {
        readonly bytes: readonly number[];
        readonly eventType: string;
        readonly targetSelector: string;
      };
      operations.push(
        `frame-dispatch:${event.eventType}:${event.targetSelector}:${Buffer.from(event.bytes).toString("hex")}`,
      );
      return true as Result;
    },
  };
  const pageLocator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const coverAction =
      selector ===
      "#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']";
    const tab = selector === ".cheetah-modal [role='tab'], .cheetah-modal-wrap [role='tab']";
    const input =
      selector ===
      ".cheetah-modal .cheetah-upload input[name='media'][type='file'][accept*='image'], .cheetah-modal-wrap .cheetah-upload input[name='media'][type='file'][accept*='image']";
    const confirm = selector === ".cheetah-modal button, .cheetah-modal-wrap button";
    const modal = selector === ".cheetah-modal, .cheetah-modal-wrap";
    const narrowCoverPreview = selector === "div[class*='-coverWrapper'] img[class*='-coverImg']";
    const broadCoverPreview =
      selector ===
      "div[class*='-coverWrapper'] > img, div[class*='-coverWrapper'] img[class*='-coverImg']";
    const preview = options.directChildCoverPreview
      ? broadCoverPreview
      : narrowCoverPreview || broadCoverPreview;
    const inlineTrigger = selector === ".edui-for-insertimage .edui-button-body";
    const inlineInput =
      selector ===
      ".cheetah-modal input[type='file'][accept='image/*'], .cheetah-modal-wrap input[type='file'][accept='image/*']";
    const control = coverAction || tab || input || confirm || inlineTrigger || inlineInput;
    return {
      count: async () =>
        preview
          ? coverImageCount
          : modal
            ? modalOpen || inlineModalOpen
              ? 2
              : 0
            : control && controlsReady
              ? 1
              : 0,
      nth: () => pageLocator(selector),
      first: () => pageLocator(selector),
      isVisible: async () =>
        preview
          ? coverImageCount > 0
          : modal
            ? modalOpen || inlineModalOpen
            : inlineInput || confirm
              ? (modalOpen || inlineModalOpen) &&
                controlsReady &&
                (!confirm || !inlineModalOpen || inlineConfirmVisible)
              : control && controlsReady,
      isEnabled: async () => {
        if (confirm && modalOpen && options.confirmEnabledAfter !== undefined) {
          confirmChecks += 1;
          return confirmChecks > options.confirmEnabledAfter;
        }
        if (inlineTrigger) return inlineEditorFocused && controlsReady;
        if (inlineInput) return inlineModalOpen && controlsReady;
        if (confirm && inlineModalOpen) return inlineUploaded && controlsReady;
        return control && controlsReady;
      },
      textContent: async () =>
        coverAction
          ? options.existingCover === true
            ? "更换"
            : "选择封面"
          : tab
            ? (options.tabText ?? "正文/本地上传")
            : confirm
              ? (options.confirmText ?? "确定")
              : null,
      click: async () => {
        operations.push(
          `${inlineTrigger || inlineModalOpen ? "page-inline-click" : "cover-click"}:${selector}`,
        );
        if (coverAction && controlsReady) modalOpen = true;
        if (inlineTrigger && inlineEditorFocused) {
          inlineModalOpen = true;
          if (options.inlineTriggerTimesOutAfterOpening === true) {
            throw new Error("synthetic click timeout after inline modal opened");
          }
        }
        if (confirm) {
          if (inlineModalOpen && inlineUploaded) {
            inlineImageCount += 1;
            inlineUploaded = false;
            inlineEditorFocused = false;
            if (
              options.delayedInlineModalClose === true ||
              options.persistentInlineModalWrapper === true
            ) {
              inlineConfirmVisible = false;
              inlineModalClosePending = options.delayedInlineModalClose === true;
            } else {
              inlineModalOpen = false;
            }
            return;
          }
          confirmClicks += 1;
          if (
            (options.confirmEnabledAfter === undefined ||
              confirmChecks > options.confirmEnabledAfter) &&
            confirmClicks > (options.confirmAcceptedAfterClicks ?? 0)
          ) {
            modalOpen = false;
          }
        }
      },
      setInputFiles: async (file) => {
        if (inlineInput) {
          operations.push(`inline-upload:${selector}:${mediaFileHex(file)}`);
          if (inlineModalOpen) inlineUploaded = true;
        } else {
          operations.push(`cover-upload:${selector}:${mediaFileHex(file)}`);
          coverImageCount = 1;
        }
      },
    };
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () => "https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1",
    locator: pageLocator,
    bringToFront: async () => undefined,
    evaluate: async <Result>() => true as Result,
    frames: () => (frameReady ? [frame] : []),
  };
  return {
    page,
    operations,
    markFrameReady: () => {
      frameReady = true;
    },
    markControlsReady: () => {
      controlsReady = true;
    },
    settleInlineModal: () => {
      if (!inlineModalClosePending) return;
      inlineModalOpen = false;
      inlineConfirmVisible = true;
      inlineModalClosePending = false;
    },
  };
}

function toutiaoPage(
  options: {
    readonly observeInlinePreview?: boolean;
    readonly confirmEnabledAfter?: number;
    readonly staleCoverImageCount?: number;
    readonly staleInlineImageCount?: number;
    readonly resetClearsStaleMedia?: boolean;
  } = {},
) {
  let coverImageCount = options.staleCoverImageCount ?? 0;
  let inlineImageCount = options.staleInlineImageCount ?? 0;
  let pendingInline = 0;
  let confirmChecks = 0;
  let uploaded = false;
  const operations: string[] = [];
  const locator = (selector: string): PlaywrightPriorityPlatformMediaLocator => {
    const control = [
      "div.article-cover-add",
      "div.btn-upload-handle.upload-handler",
      "input[type='file']",
      "button[data-e2e='imageUploadConfirm-btn']",
    ].includes(selector);
    const coverPreview = selector.includes("article-cover") && selector.includes("img");
    const inlinePreview = selector === ".ProseMirror img";
    const editor = selector === ".ProseMirror";
    return {
      count: async () =>
        coverPreview
          ? coverImageCount
          : inlinePreview
            ? inlineImageCount
            : control || editor
              ? 1
              : 0,
      nth: () => locator(selector),
      first: () => locator(selector),
      isVisible: async () =>
        coverPreview
          ? coverImageCount > 0
          : inlinePreview
            ? inlineImageCount > 0
            : control || editor,
      isEnabled: async () => {
        if (
          selector === "button[data-e2e='imageUploadConfirm-btn']" &&
          options.confirmEnabledAfter !== undefined
        ) {
          confirmChecks += 1;
          return confirmChecks > options.confirmEnabledAfter;
        }
        return control || editor;
      },
      click: async () => {
        operations.push(`click:${selector}`);
        if (selector === "button[data-e2e='imageUploadConfirm-btn']" && uploaded) {
          coverImageCount = 1;
        }
      },
      setInputFiles: async (file) => {
        operations.push(`upload:${selector}:${mediaFileNames(file)}:${mediaFileHex(file)}`);
        uploaded = true;
      },
    };
  };
  const page: PlaywrightPriorityPlatformMediaPage = {
    url: () => "https://mp.toutiao.com/profile_v4/graphic/publish",
    locator,
    bringToFront: async () => undefined,
    evaluate: async <Result, Argument>(_pageFunction: unknown, argument: Argument) => {
      const marker = argument as { readonly resetToutiaoMedia?: boolean };
      if (marker.resetToutiaoMedia === true) {
        operations.push("reset:toutiao-media");
        if (options.resetClearsStaleMedia !== false) {
          coverImageCount = 0;
          inlineImageCount = 0;
          pendingInline = 0;
        }
        return 0 as Result;
      }
      const event = argument as {
        readonly bytes: readonly number[];
        readonly eventType: string;
        readonly fileName: string;
        readonly targetSelector: string;
      };
      operations.push(
        `dispatch:${event.eventType}:${event.targetSelector}:${event.fileName}:${Buffer.from(event.bytes).toString("hex")}`,
      );
      if (event.eventType === "paste" && event.targetSelector === ".ProseMirror") {
        pendingInline += 1;
      }
      if (options.observeInlinePreview !== false) inlineImageCount += 1;
      return true as Result;
    },
  };
  const settleInline = () => {
    inlineImageCount += pendingInline;
    pendingInline = 0;
  };
  return { page, operations, settleInline };
}

describe("GitHub-sourced priority platform media writer", () => {
  it("targets the live Baijiahao cover action control inside the semantic cover section", () => {
    expect(mediaWriterSource).toContain(
      `"#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']"`,
    );
  });

  it("uses Toutiao's native cover input and waits for one DOM preview", async () => {
    const fake = toutiaoPage();
    const attachment = mediaAttachment("toutiao");
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([attachment])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 0,
    });
    await expect(writer.inspect([attachment.reference])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });

    expect(fake.operations).toEqual([
      "reset:toutiao-media",
      "click:div.article-cover-add",
      "click:div.btn-upload-handle.upload-handler",
      "upload:input[type='file']:geo-cover-01.png:89504e47",
      "click:button[data-e2e='imageUploadConfirm-btn']",
    ]);
  });

  it("uploads Zhihu cover and inline images through distinct live inputs", async () => {
    const fake = zhihuPage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "zhihu",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("zhihu"), mediaAttachment("zhihu", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      platform: "zhihu",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(fake.operations).toEqual([
      'upload:label.UploadPicture-wrapper input.UploadPicture-input[type="file"][accept*=".png"]:geo-cover-01.png:89504e47',
      'click:button[aria-label="图片"]',
      'upload:input[type="file"][accept*="image"]:not(.UploadPicture-input):geo-inline-02.jpg:ffd8ffe0',
    ]);
  });

  it("clears stale Toutiao cover and inline images before writing media", async () => {
    const fake = toutiaoPage({ staleCoverImageCount: 1, staleInlineImageCount: 3 });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([
        mediaAttachment("toutiao"),
        mediaAttachment("toutiao", "inline"),
        mediaAttachment("toutiao", "inline"),
        mediaAttachment("toutiao", "inline"),
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(fake.operations[0]).toBe("reset:toutiao-media");
    expect(fake.operations).toContain("dispatch:paste:.ProseMirror:geo-inline-02.jpg:ffd8ffe0");
  });

  it("fails fast when stale Toutiao media cannot be cleared", async () => {
    const fake = toutiaoPage({
      staleCoverImageCount: 1,
      staleInlineImageCount: 3,
      resetClearsStaleMedia: false,
    });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("toutiao"), mediaAttachment("toutiao", "inline")]),
    ).resolves.toMatchObject({
      status: "adapter_drift",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(fake.operations.filter((operation) => operation.startsWith("dispatch:")).length).toBe(0);
  });

  it("waits for Toutiao's cover confirmation to become enabled", async () => {
    const fake = toutiaoPage({ confirmEnabledAfter: 1 });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
      pollMs: 1,
    });

    await expect(writer.write([mediaAttachment("toutiao")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
    expect(fake.operations).toContain("click:button[data-e2e='imageUploadConfirm-btn']");
  });

  it("pastes Toutiao inline bytes and requires the ProseMirror image count to grow", async () => {
    const fake = toutiaoPage();
    const cover = mediaAttachment("toutiao");
    const inline = mediaAttachment("toutiao", "inline");
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([cover, inline])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(fake.operations).toContain("dispatch:paste:.ProseMirror:geo-inline-02.jpg:ffd8ffe0");
  });

  it("paces repeated Toutiao inline pastes with a two-second settle", async () => {
    const fake = toutiaoPage({ observeInlinePreview: false });
    const waits: number[] = [];
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        fake.settleInline();
      },
    });

    await expect(
      writer.write([
        mediaAttachment("toutiao"),
        mediaAttachment("toutiao", "inline"),
        mediaAttachment("toutiao", "inline"),
        mediaAttachment("toutiao", "inline"),
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(waits.filter((milliseconds) => milliseconds === 2_000).length).toBeGreaterThanOrEqual(3);
  });

  it("does not treat a dispatched Toutiao paste as success without a DOM image", async () => {
    const fake = toutiaoPage({ observeInlinePreview: false });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "toutiao",
      pages: () => [fake.page],
      wait: async () => undefined,
      uploadAttempts: 1,
    });

    await expect(
      writer.write([mediaAttachment("toutiao"), mediaAttachment("toutiao", "inline")]),
    ).resolves.toMatchObject({ status: "adapter_drift", inlineImageCount: 0 });
  });

  it("uses Baijiahao's native UEditor upload for inline images", async () => {
    const fake = baijiahaoPage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(fake.operations).toEqual(
      expect.arrayContaining([
        "cover-click:#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']",
        "cover-click:.cheetah-modal [role='tab'], .cheetah-modal-wrap [role='tab']",
        "cover-upload:.cheetah-modal .cheetah-upload input[name='media'][type='file'][accept*='image'], .cheetah-modal-wrap .cheetah-upload input[name='media'][type='file'][accept*='image']:89504e47",
        "cover-click:.cheetah-modal button, .cheetah-modal-wrap button",
        "frame-restore-caret:body[contenteditable='true']",
        "page-inline-click:.edui-for-insertimage .edui-button-body",
        "inline-upload:.cheetah-modal input[type='file'][accept='image/*'], .cheetah-modal-wrap input[type='file'][accept='image/*']:ffd8ffe0",
        "page-inline-click:.cheetah-modal button, .cheetah-modal-wrap button",
      ]),
    );
    expect(fake.operations).not.toContain(
      "frame-dispatch:drop:body[contenteditable='true']:ffd8ffe0",
    );
  });

  it("uploads a Baijiahao cover through the live cheetah upload input", async () => {
    const fake = baijiahaoPage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        throw new Error("live cover input was not selected");
      },
    });

    await expect(writer.write([mediaAttachment("baijiahao")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 0,
    });
    expect(fake.operations).toContain(
      "cover-upload:.cheetah-modal .cheetah-upload input[name='media'][type='file'][accept*='image'], .cheetah-modal-wrap .cheetah-upload input[name='media'][type='file'][accept*='image']:89504e47",
    );
  });

  it("classifies the exact Baijiahao media stage when a browser action fails", async () => {
    const fake = baijiahaoPage();
    const originalLocator = fake.page.locator.bind(fake.page);
    fake.page.locator = (selector) => {
      const locator = originalLocator(selector);
      if (
        selector !==
        "#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']"
      )
        return locator;
      return {
        ...locator,
        nth: () => fake.page.locator(selector),
        first: () => fake.page.locator(selector),
        click: async () => {
          throw new Error("synthetic browser click timeout");
        },
      };
    };
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("baijiahao")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "cover-trigger-click",
    });
  });

  it("continues when Baijiahao opens the inline modal before the trigger click times out", async () => {
    const fake = baijiahaoPage({ inlineTriggerTimesOutAfterOpening: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
  });

  it("preserves browser runtime loss while classifying the Baijiahao media stage", () => {
    const error = new PriorityPlatformMediaWriteError(
      "baijiahao",
      "cover-trigger-click",
      new Error("page.click: Target page, context or browser has been closed"),
    );

    expect(error).toMatchObject({
      stage: "cover-trigger-click",
      runtimeUnavailable: true,
    });
  });

  it("confirms each Baijiahao inline image before uploading the next one", async () => {
    const fake = baijiahaoPage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([
        mediaAttachment("baijiahao"),
        mediaAttachment("baijiahao", "inline"),
        mediaAttachment("baijiahao", "inline"),
        mediaAttachment("baijiahao", "inline"),
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(
      fake.operations.filter(
        (operation) =>
          operation === "page-inline-click:.cheetah-modal button, .cheetah-modal-wrap button",
      ),
    ).toHaveLength(3);
    expect(
      fake.operations.filter(
        (operation) => operation === "frame-restore-caret:body[contenteditable='true']",
      ),
    ).toHaveLength(3);
  });

  it("waits through Baijiahao's post-confirm modal teardown without requiring the button again", async () => {
    const fake = baijiahaoPage({ delayedInlineModalClose: true });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        waits += 1;
        if (waits > 1) throw new Error("Baijiahao confirmation was unnecessarily reacquired");
        fake.settleInlineModal();
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({ status: "ready", coverImageCount: 1, inlineImageCount: 1 });
  });

  it("accepts a persisted Baijiahao inline image after the confirmation control disappears even when the modal wrapper remains", async () => {
    const fake = baijiahaoPage({ persistentInlineModalWrapper: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        throw new Error("Baijiahao's decorative modal wrapper should not block a persisted image");
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({ status: "ready", coverImageCount: 1, inlineImageCount: 1 });
  });

  it("replaces an existing Baijiahao cover through the real change action", async () => {
    const fake = baijiahaoPage({ existingCover: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({ status: "ready", coverImageCount: 1, inlineImageCount: 1 });
    expect(fake.operations).toContain(
      "cover-click:#bjhNewsCover button[class*='FeEditorApp'], #bjhNewsCover div[class*='FeEditorApp'][class*='-text']",
    );
  });

  it("recognizes Baijiahao cover previews rendered as direct wrapper children", async () => {
    const fake = baijiahaoPage({ existingCover: true, directChildCoverPreview: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
    });

    await expect(writer.inspect([mediaAttachment("baijiahao").reference])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 0,
    });
  });

  it("accepts Baijiahao's selected-cover count on the confirmation button", async () => {
    const fake = baijiahaoPage({ confirmText: "确定 (1)" });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        throw new Error("dynamic Baijiahao confirmation text was rejected");
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
  });

  it("waits for Baijiahao's cover confirmation to become enabled", async () => {
    const fake = baijiahaoPage({ confirmEnabledAfter: 1, confirmText: "确定 (1)" });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        waits += 1;
      },
      pollMs: 1,
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(waits).toBeGreaterThan(0);
  });

  it("retries Baijiahao's cover confirmation until the modal closes", async () => {
    const fake = baijiahaoPage({ confirmAcceptedAfterClicks: 1, confirmText: "确定 (1)" });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => undefined,
      pollMs: 1,
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(
      fake.operations.filter(
        (operation) =>
          operation === "cover-click:.cheetah-modal button, .cheetah-modal-wrap button",
      ),
    ).toHaveLength(2);
  });

  it("accepts Baijiahao's no-space selected-image count on the local-upload tab", async () => {
    const fake = baijiahaoPage({ tabText: "正文/本地上传(1)" });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      wait: async () => {
        throw new Error("dynamic Baijiahao local-upload tab text was rejected");
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
  });

  it("waits for Baijiahao's editor iframe to return after confirming the cover", async () => {
    const fake = baijiahaoPage({ frameReady: false });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      pollMs: 1,
      wait: async () => {
        waits += 1;
        fake.markFrameReady();
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(waits).toBeGreaterThan(0);
  });

  it("waits for Baijiahao's asynchronously mounted media controls before clicking them", async () => {
    const fake = baijiahaoPage({ controlsReady: false });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "baijiahao",
      pages: () => [fake.page],
      pollMs: 1,
      wait: async () => {
        waits += 1;
        fake.markControlsReady();
      },
    });

    await expect(
      writer.write([mediaAttachment("baijiahao"), mediaAttachment("baijiahao", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(waits).toBeGreaterThan(0);
  });

  it("uses Sohu uploadCover controls and verifies cover plus Quill inline previews", async () => {
    const fake = sohuPage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([mediaAttachment("sohu"), mediaAttachment("sohu", "inline")]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 1,
    });
    expect(fake.operations).toEqual(
      expect.arrayContaining([
        "click:span.upload-tip",
        "click:h3",
        "cover-upload:input[type='file']:89504e47",
        "click:p.button.positive-button",
        "dispatch:paste:div.ql-editor[contenteditable='true']:ffd8ffe0",
      ]),
    );
  });

  it("waits for Sohu's asynchronous cover confirmation to become actionable", async () => {
    const fake = sohuPage({ delayedCoverConfirm: true });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      actionTimeoutMs: 100,
      pollMs: 1,
      wait: async () => {
        waits += 1;
        fake.markCoverConfirmReady();
      },
    });

    await expect(writer.write([mediaAttachment("sohu")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
    expect(waits).toBeGreaterThan(0);
  });

  it("waits for Sohu's cover preview and modal to settle before continuing", async () => {
    const fake = sohuPage({ delayedCoverSettle: true });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      actionTimeoutMs: 100,
      pollMs: 1,
      wait: async () => {
        waits += 1;
        fake.markCoverSettled();
      },
    });

    await expect(writer.write([mediaAttachment("sohu")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
    expect(waits).toBeGreaterThan(0);
  });

  it("waits for each Sohu inline image DOM readback even when paste returns false", async () => {
    const fake = sohuPage({ delayedInlineInsert: true, dispatchReturnsFalse: true });
    let waits = 0;
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      actionTimeoutMs: 100,
      pollMs: 1,
      wait: async () => {
        waits += 1;
        fake.markInlineInsertReady();
      },
    });

    await expect(
      writer.write([
        mediaAttachment("sohu"),
        mediaAttachment("sohu", "inline"),
        mediaAttachment("sohu", "inline"),
        mediaAttachment("sohu", "inline"),
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(waits).toBeGreaterThanOrEqual(3);
  });

  it("classifies the exact Sohu media stage when a browser action fails", async () => {
    const fake = sohuPage();
    const originalLocator = fake.page.locator.bind(fake.page);
    fake.page.locator = (selector) => {
      const locator = originalLocator(selector);
      if (selector !== "p.button.positive-button") return locator;
      return {
        ...locator,
        nth: () => fake.page.locator(selector),
        first: () => fake.page.locator(selector),
        click: async () => {
          throw new Error("synthetic Sohu confirmation timeout");
        },
      };
    };
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("sohu")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "cover-confirm-click",
    });
  });

  it("classifies Sohu's Tencent slider as a challenge before media interaction", async () => {
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [challengePage("sohu")],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("sohu")])).resolves.toMatchObject({
      status: "challenge_required",
      challengeSignals: expect.arrayContaining(["iframe[src*=captcha]", "frame:tencent-captcha"]),
    });
  });

  it("ignores an offscreen Sohu captcha remnant while writing media", async () => {
    const fake = sohuPage({ hiddenChallenge: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("sohu")])).resolves.toMatchObject({
      status: "ready",
      challengeSignals: [],
      coverImageCount: 1,
    });
  });

  it("does not count an empty Sohu cover container as an uploaded cover", async () => {
    const fake = sohuPage({ coverPreviewHasUrl: false });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "sohu",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.inspect([mediaAttachment("sohu").reference])).resolves.toMatchObject({
      status: "adapter_drift",
      coverImageCount: 0,
    });
  });

  it("uploads the approved NetEase media set through its native modal, with auto cover and no watermark", async () => {
    const fake = neteasePage();
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(
      writer.write([
        mediaAttachment("netease"),
        mediaAttachment("netease", "inline", 1),
        mediaAttachment("netease", "inline", 2),
        mediaAttachment("netease", "inline", 3),
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
      inlineImageCount: 3,
    });
    expect(fake.operations).toEqual([
      "click:page:label.cover-pic__radio:has(input[type='radio'][value='auto'])",
      "click:page:button.rich-editor-panel-item:has(img[src*='icon_image'])",
      "click:watermark:span[role='button']",
      "upload:modal:input[type='file'][name='pic']:geo-cover-01.png,geo-inline-02.jpg,geo-inline-03.jpg,geo-inline-04.jpg:89504e47,ffd8ffe0,ffd8ffe0,ffd8ffe0",
      "click:modal:button.s-confirm-btn",
    ]);
    expect(fake.operations.some((operation) => operation.startsWith("dispatch:"))).toBe(false);
  });

  it("waits for NetEase to mount the uniquely-scoped watermark option after the image modal opens", async () => {
    const fake = neteasePage({ watermarkOptionDelayed: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      readTimeoutMs: 1,
      actionTimeoutMs: 10,
      pollMs: 0,
      wait: async () => {
        fake.markWatermarkOptionMounted();
      },
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
    expect(fake.operations).toEqual([
      "click:page:label.cover-pic__radio:has(input[type='radio'][value='auto'])",
      "click:page:button.rich-editor-panel-item:has(img[src*='icon_image'])",
      "click:watermark:span[role='button']",
      "upload:modal:input[type='file'][name='pic']:geo-cover-01.png:89504e47",
      "click:modal:button.s-confirm-btn",
    ]);
    expect(fake.operations).not.toContain("click:library:span[role='button']");
  });

  it("keeps the NetEase modal locator bound while resolving the watermark option", async () => {
    const fake = neteasePage({ modalLocatorRequiresBoundThis: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      readTimeoutMs: 1,
      actionTimeoutMs: 1,
      pollMs: 0,
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
  });

  it("uploads through the attached native NetEase file input when the input is visually hidden", async () => {
    const fake = neteasePage({ uploadInputHidden: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      readTimeoutMs: 1,
      actionTimeoutMs: 1,
      pollMs: 0,
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "ready",
      coverImageCount: 1,
    });
    expect(fake.operations).toContain(
      "upload:modal:input[type='file'][name='pic']:geo-cover-01.png:89504e47",
    );
  });

  it("fails closed before upload when the exact NetEase watermark option never mounts", async () => {
    const fake = neteasePage({ watermarkOptionDelayed: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      readTimeoutMs: 1,
      actionTimeoutMs: 1,
      pollMs: 0,
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "image-watermark-option",
    });
    expect(fake.operations).toEqual([
      "click:page:label.cover-pic__radio:has(input[type='radio'][value='auto'])",
      "click:page:button.rich-editor-panel-item:has(img[src*='icon_image'])",
    ]);
  });

  it("stops for a NetEase YiDun challenge that mounts while waiting for the watermark option", async () => {
    const fake = neteasePage({ watermarkOptionDelayed: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      readTimeoutMs: 1,
      actionTimeoutMs: 10,
      pollMs: 0,
      wait: async () => {
        fake.activateChallenge();
      },
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "challenge_required",
      challengeSignals: expect.arrayContaining(["[class*=yidun]", "frame:netease-yidun"]),
    });
    expect(fake.operations).toEqual([
      "click:page:label.cover-pic__radio:has(input[type='radio'][value='auto'])",
      "click:page:button.rich-editor-panel-item:has(img[src*='icon_image'])",
    ]);
  });

  it("fails closed when the NetEase image confirmation never becomes enabled", async () => {
    const fake = neteasePage({ confirmEnabled: false });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      actionTimeoutMs: 1,
      pollMs: 0,
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "image-confirm-enable",
    });
    expect(fake.operations).not.toContain("click:modal:button.s-confirm-btn");
  });

  it("fails closed when NetEase leaves the image confirmation modal open after upload", async () => {
    const fake = neteasePage({ modalStaysOpen: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      actionTimeoutMs: 1,
      pollMs: 0,
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "editor-image-readback",
    });
    expect(fake.operations).toContain("click:modal:button.s-confirm-btn");
  });

  it("fails before writing NetEase media when the editor retains stale images", async () => {
    const fake = neteasePage({ existingImageCount: 1 });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).rejects.toMatchObject({
      name: PriorityPlatformMediaWriteError.name,
      stage: "editor-image-count-inspection",
    });
    expect(fake.operations).toEqual([]);
  });

  it("stops the NetEase upload flow when a YiDun challenge appears in the image modal", async () => {
    const fake = neteasePage({ challengeAfterImageTrigger: true });
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "challenge_required",
      challengeSignals: expect.arrayContaining(["[class*=yidun]", "frame:netease-yidun"]),
    });
    expect(fake.operations).toEqual([
      "click:page:label.cover-pic__radio:has(input[type='radio'][value='auto'])",
      "click:page:button.rich-editor-panel-item:has(img[src*='icon_image'])",
    ]);
  });

  it("does not use a page-level generic confirmation when NetEase confirms media", async () => {
    expect(mediaWriterSource).toContain(".ne-modal.picture-adder");
    expect(mediaWriterSource).toContain("button.s-confirm-btn");
    expect(mediaWriterSource).not.toContain("NETEASE_IMAGE_PREVIEW_SELECTOR), readTimeoutMs) >");
  });

  it("classifies NetEase YiDun as a challenge before media interaction", async () => {
    const writer = createPlaywrightPriorityPlatformMediaWriter({
      platform: "netease",
      pages: () => [challengePage("netease")],
      wait: async () => undefined,
    });

    await expect(writer.write([mediaAttachment("netease")])).resolves.toMatchObject({
      status: "challenge_required",
      challengeSignals: expect.arrayContaining(["[class*=yidun]", "frame:netease-yidun"]),
    });
  });
});
