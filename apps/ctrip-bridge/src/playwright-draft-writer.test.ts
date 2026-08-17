import { describe, expect, it, vi } from "vitest";

import {
  createPlaywrightCtripDraftWriter,
  type PlaywrightCtripDraftLocator,
  type PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";

function fakePage(
  options: {
    readonly existingImages?: number;
    readonly uploadDom?: "legacy" | "current";
    readonly revealDeleteOnHover?: boolean;
    readonly confirmDelete?: boolean;
    readonly confirmDeleteDelayChecks?: number;
    readonly deleteClickTimeouts?: number;
    readonly confirmClickTimeoutsAfterAction?: number;
    readonly saveBehavior?: "toast" | "management" | "detail";
    readonly detailStatus?: string;
    readonly detailTitle?: string;
    readonly detailBody?: string;
    readonly detailStatusDelayChecks?: number;
    readonly detailEditDelayChecks?: number;
    readonly detailEditIgnoredClicks?: number;
    readonly saveToastVisible?: boolean;
    readonly saveToastText?: string;
    readonly managementRowDestination?: "detail" | "editor";
    readonly managementDuplicateRows?: number;
    readonly targetHydrationDelayChecks?: number;
    readonly titleReadbackDelayChecks?: number;
    readonly bodyReadbackDelayChecks?: number;
    readonly initialUrl?: string;
    readonly persistedManagementTitle?: string;
    readonly persistedManagementBody?: string;
    readonly location?: string;
    readonly locationOption?: string;
    readonly locationRemovalStuck?: boolean;
    readonly actionLabels?: readonly string[];
    readonly actionTextTimeoutIndexes?: readonly number[];
    readonly imageInputCount?: number;
    readonly draftActionEnabled?: boolean;
  } = {},
) {
  let title = "";
  let body = "";
  const persistedManagementTitle = options.persistedManagementTitle ?? "";
  const persistedManagementBody = options.persistedManagementBody ?? "";
  let location = options.location ?? "";
  let locationQuery = "";
  let uploaded = options.existingImages ?? 0;
  let saved = false;
  let pageUrl = options.initialUrl ?? "https://we.ctrip.com/publish/publishPictureText";
  let deleteVisible = false;
  let deleteConfirmationPending = false;
  let deleteConfirmationVisible = false;
  let confirmationVisibilityChecks = 0;
  let deleteClickAttempts = 0;
  let confirmClickAttempts = 0;
  let detailStatusVisibilityChecks = 0;
  let detailEditVisibilityChecks = 0;
  let detailEditClicks = 0;
  let targetHydrationChecks = 0;
  let titleReadbackChecks = 0;
  let bodyReadbackChecks = 0;
  const directNavigation = vi.fn(async (url: string) => {
    pageUrl = url;
  });
  const titleFill = vi.fn(async (value: string) => {
    title = value;
    titleReadbackChecks = 0;
  });
  const bodyFill = vi.fn(async (value: string) => {
    body = value;
    bodyReadbackChecks = 0;
  });
  const locationInputFill = vi.fn(async (value: string) => {
    locationQuery = value;
  });
  const locationRemoveClick = vi.fn(async () => {
    if (!options.locationRemovalStuck) location = "";
  });
  const locationOptionClick = vi.fn(async () => {
    location = options.locationOption ?? `${locationQuery}, Japan`;
  });
  const uploadItemSelector =
    options.uploadDom === "legacy"
      ? '[class~="ant-upload-list-picture-card-container"]'
      : '[class~="r-d-upload-image-container-done"]';
  const deleteSelector =
    options.uploadDom === "legacy"
      ? '[class~="anticon-delete"]'
      : '[class~="r-d-upload-image-delete"]';
  const upload = vi.fn(async () => {
    uploaded += 1;
  });
  const hover = vi.fn(async () => {
    if (options.revealDeleteOnHover !== false) deleteVisible = true;
  });
  const deleteClick = vi.fn(async () => {
    deleteClickAttempts += 1;
    if (deleteClickAttempts <= (options.deleteClickTimeouts ?? 0)) {
      const error = new Error("Ctrip delete click timed out");
      error.name = "TimeoutError";
      throw error;
    }
    if (options.confirmDelete) {
      deleteConfirmationPending = true;
      confirmationVisibilityChecks = 0;
      if ((options.confirmDeleteDelayChecks ?? 0) === 0) deleteConfirmationVisible = true;
    } else if (uploaded > 0) {
      uploaded -= 1;
    }
    deleteVisible = false;
  });
  const confirmClick = vi.fn(async () => {
    confirmClickAttempts += 1;
    if (uploaded > 0) uploaded -= 1;
    deleteConfirmationPending = false;
    deleteConfirmationVisible = false;
    if (confirmClickAttempts <= (options.confirmClickTimeoutsAfterAction ?? 0)) {
      const error = new Error("Ctrip confirmation click timed out after dispatch");
      error.name = "TimeoutError";
      throw error;
    }
  });
  const bringToFront = vi.fn(async () => undefined);
  const click = vi.fn(async () => {
    saved = true;
    if (options.saveBehavior === "management")
      pageUrl = "https://we.ctrip.com/publish/contentManagement";
    if (options.saveBehavior === "detail") {
      pageUrl = "https://we.ctrip.com/publish/detail?articleId=339527581&articleType=1";
    }
  });

  function locatorFor(
    selector: string,
    index = 0,
    field?: "title" | "body",
  ): PlaywrightCtripDraftLocator {
    if (field !== undefined) {
      return {
        count: async () => {
          if (field === "title") targetHydrationChecks += 1;
          return targetHydrationChecks > (options.targetHydrationDelayChecks ?? 0) ? 1 : 0;
        },
        nth: () => locatorFor(selector, 0, field),
        first: () => locatorFor(selector, 0, field),
        isVisible: async () => targetHydrationChecks > (options.targetHydrationDelayChecks ?? 0),
        hover: async () => undefined,
        fill: field === "title" ? titleFill : bodyFill,
        textContent: async () => {
          if (field === "title") {
            titleReadbackChecks += 1;
            return titleReadbackChecks > (options.titleReadbackDelayChecks ?? 0) ? title : "";
          }
          bodyReadbackChecks += 1;
          return bodyReadbackChecks > (options.bodyReadbackDelayChecks ?? 0) ? body : "";
        },
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === '[contenteditable="true"][role="textbox"].public-DraftEditor-content') {
      return locatorFor(selector, index, "title");
    }
    if (selector === '[contenteditable="true"][role="combobox"].public-DraftEditor-content') {
      return locatorFor(selector, index, "body");
    }
    if (selector === ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search") {
      return {
        count: async () => 1,
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => true,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (
      selector ===
      ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search .ant-select-selection-item-remove"
    ) {
      return {
        count: async () => (location.length > 0 ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => location.length > 0,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "",
        click: locationRemoveClick,
        setInputFiles: async () => undefined,
      };
    }
    if (
      selector ===
      ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search input.ant-select-selection-search-input"
    ) {
      return {
        count: async () => 1,
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => true,
        hover: async () => undefined,
        fill: locationInputFill,
        textContent: async () => "",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (
      selector ===
      ".r-d-container > .ant-select.ant-select-multiple.ant-select-show-search .ant-select-selection-item"
    ) {
      return {
        count: async () => (location.length > 0 ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => location.length > 0,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => location,
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".search-input-detail .item-c") {
      return {
        count: async () => 1,
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => true,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => options.locationOption ?? `${locationQuery}, Japan`,
        click: locationOptionClick,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === 'input[type="file"][accept="image/*"]') {
      return {
        count: async () => options.imageInputCount ?? 1,
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => false,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "",
        click: async () => undefined,
        setInputFiles: upload,
      };
    }
    if (selector === 'button, [role="button"]') {
      const labels = options.actionLabels ?? [
        "\u4e0a\u4f20\u56fe\u7247",
        "\u5b58\u8349\u7a3f",
        "\u53d1 \u5e03",
      ];
      return {
        count: async () => labels.length,
        nth: (next) => locatorFor(selector, next),
        first: () => locatorFor(selector, 0),
        isVisible: async () => true,
        isEnabled: async () =>
          labels[index] !== "\u5b58\u8349\u7a3f" || options.draftActionEnabled !== false,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => {
          if (options.actionTextTimeoutIndexes?.includes(index)) {
            const error = new Error("Ctrip action text read timed out");
            error.name = "TimeoutError";
            throw error;
          }
          return labels[index] ?? "";
        },
        click: async () => {
          if (labels[index] === "\u5b58\u8349\u7a3f") await click();
        },
        setInputFiles: async () => undefined,
      };
    }
    if (selector.includes(uploadItemSelector) && selector.includes(deleteSelector)) {
      return {
        count: async () => (uploaded > 0 ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => uploaded > 0 && deleteVisible,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "",
        click: deleteClick,
        setInputFiles: async () => undefined,
      };
    }
    if (selector.includes(uploadItemSelector)) {
      return {
        count: async () => uploaded,
        nth: (next) => locatorFor(selector, next),
        first: () => locatorFor(selector),
        isVisible: async () => index < uploaded,
        hover,
        fill: async () => undefined,
        textContent: async () => "",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".ant-modal-confirm-confirm") {
      return {
        count: async () => (deleteConfirmationPending ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => {
          if (deleteConfirmationPending && !deleteConfirmationVisible) {
            confirmationVisibilityChecks += 1;
            if (confirmationVisibilityChecks > (options.confirmDeleteDelayChecks ?? 0)) {
              deleteConfirmationVisible = true;
            }
          }
          return deleteConfirmationVisible;
        },
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => (deleteConfirmationPending ? "确定删除该图片吗?" : ""),
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".ant-modal-confirm-confirm button") {
      const labels = ["取 消", "确 定"];
      return {
        count: async () => (deleteConfirmationPending ? labels.length : 0),
        nth: (next) => locatorFor(selector, next),
        first: () => locatorFor(selector, 0),
        isVisible: async () => deleteConfirmationVisible && index < labels.length,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => labels[index] ?? "",
        click: async () => {
          if (labels[index]?.replace(/\s+/gu, "") === "确定") await confirmClick();
        },
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".c-m-c-container") {
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      return {
        count: async () =>
          pageUrl.endsWith("/contentManagement") && (saved || persistedManagementTitle.length > 0)
            ? 1 + (options.managementDuplicateRows ?? 0)
            : 0,
        nth: (next) => locatorFor(selector, next),
        first: () => locatorFor(selector),
        isVisible: async () =>
          pageUrl.endsWith("/contentManagement") && (saved || persistedManagementTitle.length > 0),
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () =>
          index === 0
            ? `${persistedManagementTitle || title}00草稿${formatter.format(new Date())}编辑删除`
            : `${persistedManagementTitle || title}00草稿2026-07-18 08:31:31编辑删除`,
        click: async () => {
          if (persistedManagementTitle.length > 0) {
            title = persistedManagementTitle;
            body = persistedManagementBody;
          }
          if (options.managementRowDestination === "detail") {
            pageUrl = "https://we.ctrip.com/publish/detail?articleId=339527581&articleType=1";
          } else if (options.managementRowDestination === "editor") {
            pageUrl =
              "https://we.ctrip.com/publish/publishPictureText?articleId=339527581&articleStatus=DRAFT";
          }
        },
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".article-bg .article-title") {
      return {
        count: async () => (pageUrl.includes("/publish/detail") ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => pageUrl.includes("/publish/detail"),
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => options.detailTitle ?? title,
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".article-bg .content") {
      return {
        count: async () => (pageUrl.includes("/publish/detail") ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => pageUrl.includes("/publish/detail"),
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => options.detailBody ?? body,
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".article-bg .status") {
      return {
        count: async () => (pageUrl.includes("/publish/detail") ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => {
          if (!pageUrl.includes("/publish/detail")) return false;
          detailStatusVisibilityChecks += 1;
          return detailStatusVisibilityChecks > (options.detailStatusDelayChecks ?? 0);
        },
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => options.detailStatus ?? "\u8349\u7a3f",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (selector === ".head .button-bg.button-blue") {
      return {
        count: async () => (pageUrl.includes("/publish/detail") ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => {
          if (!pageUrl.includes("/publish/detail")) return false;
          detailEditVisibilityChecks += 1;
          return detailEditVisibilityChecks > (options.detailEditDelayChecks ?? 0);
        },
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "\u7f16\u8f91",
        click: vi.fn(async () => {
          detailEditClicks += 1;
          if (detailEditClicks > (options.detailEditIgnoredClicks ?? 0)) {
            pageUrl =
              "https://we.ctrip.com/publish/publishPictureText?articleId=339527581&articleStatus=DRAFT";
          }
        }),
        setInputFiles: async () => undefined,
      };
    }
    if (selector === '[role="alert"], .ant-message-notice-content') {
      return {
        count: async () => (saved && options.saveToastVisible !== false ? 1 : 0),
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => saved && options.saveToastVisible !== false,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () =>
          saved && options.saveToastVisible !== false
            ? (options.saveToastText ?? "\u8349\u7a3f\u4fdd\u5b58\u6210\u529f")
            : "",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    if (
      selector === '[data-testid="captcha"]' ||
      selector === '[class*="captcha"]' ||
      selector === ".nc-container"
    ) {
      return {
        count: async () => 0,
        nth: () => locatorFor(selector),
        first: () => locatorFor(selector),
        isVisible: async () => false,
        hover: async () => undefined,
        fill: async () => undefined,
        textContent: async () => "",
        click: async () => undefined,
        setInputFiles: async () => undefined,
      };
    }
    throw new Error(`unexpected selector ${selector}`);
  }

  const page: PlaywrightCtripDraftPage = {
    url: () => pageUrl,
    locator: (selector) => locatorFor(selector),
    bringToFront,
    goto: directNavigation,
    waitForLoadState: async () => undefined,
  };
  return {
    page,
    upload,
    click,
    hover,
    deleteClick,
    confirmClick,
    bringToFront,
    titleFill,
    bodyFill,
    locationInputFill,
    locationRemoveClick,
    locationOptionClick,
    directNavigation,
  };
}

describe("Ctrip Playwright draft writer", () => {
  it.each(["legacy", "current"] as const)(
    "clears %s upload cards, uses only the compiled draft controls, and never clicks final publish",
    async (uploadDom) => {
      const fake = fakePage({
        existingImages: 1,
        uploadDom,
        confirmDelete: uploadDom === "current",
        confirmDeleteDelayChecks: uploadDom === "current" ? 2 : 0,
      });
      const writer = createPlaywrightCtripDraftWriter({
        pages: () => [fake.page],
        wait: async () => undefined,
      });
      await expect(writer.inspect()).resolves.toMatchObject({
        status: "ready",
        targetPageCount: 1,
        titleEditorCount: 1,
        bodyEditorCount: 1,
        imageInputCount: 1,
        uploadActionCount: 1,
        draftActionCount: 1,
        publishActionCount: 1,
      });
      await expect(writer.clearImages()).resolves.toBe(0);
      await expect(
        writer.fillTitle("\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565"),
      ).resolves.toBe("\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565");
      await expect(
        writer.fillBody(
          "\u8db3\u591f\u957f\u7684\u643a\u7a0b\u793e\u533a\u6b63\u6587\uff0c\u5305\u542b\u53ef\u6838\u9a8c\u7684\u884c\u7a0b\u8bf4\u660e\u3001\u4ea4\u901a\u4fe1\u606f\u3001\u5f00\u653e\u65f6\u95f4\u548c\u9884\u8ba2\u524d\u786e\u8ba4\u4e8b\u9879\u3002",
        ),
      ).resolves.toContain("\u8db3\u591f\u957f");
      await expect(
        writer.uploadImage({
          name: "geo-ctrip-01.png",
          mimeType: "image/png",
          bytes: Uint8Array.from([1]),
        }),
      ).resolves.toBe(1);
      await expect(writer.saveDraft()).resolves.toEqual({
        confirmed: true,
        signal: "\u8349\u7a3f\u4fdd\u5b58\u6210\u529f",
      });
      expect(fake.upload).toHaveBeenCalledOnce();
      expect(fake.hover).toHaveBeenCalledOnce();
      expect(fake.deleteClick).toHaveBeenCalledOnce();
      expect(fake.confirmClick).toHaveBeenCalledTimes(uploadDom === "current" ? 1 : 0);
      expect(fake.click).toHaveBeenCalledOnce();
      expect(fake.titleFill.mock.calls.map(([value]) => value)).toEqual([
        "",
        "\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565",
      ]);
      expect(fake.bodyFill.mock.calls[0]?.[0]).toBe("");
    },
  );

  it("waits for delayed DraftJS title and body readback after fill", async () => {
    const fake = fakePage({ titleReadbackDelayChecks: 2, bodyReadbackDelayChecks: 3 });
    const wait = vi.fn(async (milliseconds: number) => {
      void milliseconds;
    });
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });

    await expect(
      writer.fillTitle("\u9752\u5c9b\u51fa\u884c\u524d\u6838\u9a8c\u6e05\u5355"),
    ).resolves.toBe("\u9752\u5c9b\u51fa\u884c\u524d\u6838\u9a8c\u6e05\u5355");
    await expect(
      writer.fillBody(
        "\u8fd9\u662f\u5df2\u7ecf\u5199\u5165 DraftJS \u7684\u643a\u7a0b\u6b63\u6587\u3002",
      ),
    ).resolves.toBe(
      "\u8fd9\u662f\u5df2\u7ecf\u5199\u5165 DraftJS \u7684\u643a\u7a0b\u6b63\u6587\u3002",
    );
    expect(wait.mock.calls.filter(([milliseconds]) => milliseconds === 100)).toHaveLength(5);
  });

  it.each([
    { actionLabels: ["存草稿", "发 布"], name: "missing upload entry" },
    { actionLabels: ["上传图片", "存草稿", "存草稿", "发 布"], name: "duplicate draft action" },
    { actionLabels: ["上传图片", "存草稿", "发 布", "发 布"], name: "duplicate publish action" },
  ])("fails closed for $name", async ({ actionLabels }) => {
    const fake = fakePage({ actionLabels });
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page] });

    await expect(writer.inspect()).resolves.toMatchObject({ status: "adapter_drift" });
    await expect(writer.fillTitle("must not be written")).rejects.toThrow(/not stable/iu);
    expect(fake.titleFill).not.toHaveBeenCalled();
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("ignores an unreadable unrelated action candidate while preserving exact controls", async () => {
    const actionLabels = [
      "上传图片",
      "存草稿",
      "发 布",
      ...Array.from({ length: 10 }, (_, index) => `无关操作 ${index + 1}`),
    ];
    const fake = fakePage({ actionLabels, actionTextTimeoutIndexes: [12] });
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page] });

    await expect(writer.inspect()).resolves.toMatchObject({
      status: "ready",
      uploadActionCount: 1,
      draftActionCount: 1,
      publishActionCount: 1,
    });
  });

  it("fails closed when the draft action itself is unreadable", async () => {
    const fake = fakePage({ actionTextTimeoutIndexes: [1] });
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page] });

    await expect(writer.inspect()).resolves.toMatchObject({
      status: "adapter_drift",
      uploadActionCount: 1,
      draftActionCount: 0,
      publishActionCount: 1,
    });
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("fails closed when the hidden upload input is missing or duplicated", async () => {
    for (const imageInputCount of [0, 2]) {
      const fake = fakePage({ imageInputCount });
      const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page] });

      await expect(writer.inspect()).resolves.toMatchObject({
        status: "adapter_drift",
        imageInputCount,
      });
      await expect(
        writer.uploadImage({
          name: "must-not-upload.png",
          mimeType: "image/png",
          bytes: Uint8Array.from([1]),
        }),
      ).rejects.toThrow(/not stable/iu);
      expect(fake.upload).not.toHaveBeenCalled();
    }
  });

  it("does not treat failed or ambiguous draft-save notices as durable success", async () => {
    for (const [saveToastText, expectedSignal] of [
      [
        "\u8349\u7a3f\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5",
        "\u8349\u7a3f\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5",
      ],
      ["\u6b63\u5728\u4fdd\u5b58\u8349\u7a3f", "draft-save-confirmation-missing"],
    ] as const) {
      const fake = fakePage({ saveToastText });
      const writer = createPlaywrightCtripDraftWriter({
        pages: () => [fake.page],
        wait: async () => undefined,
      });
      await writer.fillTitle("\u9752\u5c9b\u51fa\u884c\u524d\u6838\u9a8c\u6e05\u5355");

      await expect(writer.saveDraft()).resolves.toEqual({
        confirmed: false,
        signal: expectedSignal,
      });
      expect(fake.click).toHaveBeenCalledOnce();
    }
  });

  it("reports an account mute instead of a missing save confirmation", async () => {
    const fake = fakePage({
      saveToastText: "\u62b1\u6b49,\u60a8\u5f53\u524d\u5904\u4e8e\u7981\u8a00\u671f",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("\u9752\u5c9b\u51fa\u884c\u524d\u6838\u9a8c\u6e05\u5355");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: false,
      signal: "draft-save-account-muted",
    });
    expect(fake.click).toHaveBeenCalledOnce();
  });

  it("does not click a disabled draft-save action", async () => {
    const fake = fakePage({ draftActionEnabled: false });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("\u9752\u5c9b\u51fa\u884c\u524d\u6838\u9a8c\u6e05\u5355");

    await expect(writer.saveDraft()).rejects.toThrow(/disabled/iu);
    expect(fake.click).not.toHaveBeenCalled();
  });

  it("fails closed when an existing image cannot expose one delete control", async () => {
    const fake = fakePage({ existingImages: 1, revealDeleteOnHover: false });
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page] });
    await expect(writer.clearImages()).resolves.toBe(1);
    expect(fake.hover).toHaveBeenCalledOnce();
    expect(fake.deleteClick).not.toHaveBeenCalled();
  });

  it("retries a transient delete action timeout before declaring adapter drift", async () => {
    const fake = fakePage({
      existingImages: 1,
      uploadDom: "current",
      confirmDelete: true,
      deleteClickTimeouts: 1,
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.clearImages()).resolves.toBe(0);
    expect(fake.hover).toHaveBeenCalledTimes(2);
    expect(fake.deleteClick).toHaveBeenCalledTimes(2);
    expect(fake.confirmClick).toHaveBeenCalledOnce();
  });

  it("accepts confirmed image removal when the confirmation click reports a late timeout", async () => {
    const fake = fakePage({
      existingImages: 1,
      uploadDom: "current",
      confirmDelete: true,
      confirmClickTimeoutsAfterAction: 1,
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.clearImages()).resolves.toBe(0);
    expect(fake.deleteClick).toHaveBeenCalledOnce();
    expect(fake.confirmClick).toHaveBeenCalledOnce();
  });

  it("selects a matching Ctrip POI and reads it back", async () => {
    const fake = fakePage({ locationOption: "Tokyo, Japan" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.fillLocation?.("Tokyo")).resolves.toBe("Tokyo, Japan");
    await expect(writer.readLocation?.()).resolves.toBe("Tokyo, Japan");
    expect(fake.locationInputFill).toHaveBeenCalledWith("Tokyo", { timeout: 10_000 });
    expect(fake.locationOptionClick).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it("selects a Ctrip POI when search results omit the full administrative query", async () => {
    const fake = fakePage({ locationOption: "昆明·云南" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.fillLocation?.("云南昆明")).resolves.toBe("昆明·云南");
    expect(fake.locationInputFill).toHaveBeenCalledWith("云南昆明", { timeout: 10_000 });
    expect(fake.locationOptionClick).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it("returns an empty optional location when no Ctrip POI clears the coverage threshold", async () => {
    const fake = fakePage({ locationOption: "东京塔" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.fillLocation?.("云南昆明")).resolves.toBe("");
    expect(fake.locationOptionClick).not.toHaveBeenCalled();
  });

  it("fails closed instead of looping when an existing POI cannot be removed", async () => {
    const fake = fakePage({ location: "Paris, France", locationRemovalStuck: true });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.fillLocation?.("Tokyo")).rejects.toThrow(/could not clear existing POI/iu);
    expect(fake.locationRemoveClick).toHaveBeenCalledTimes(40);
  });

  it("accepts content-management navigation as durable draft-save evidence", async () => {
    const fake = fakePage({ saveBehavior: "management" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("上海亲子周末攻略");
    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-management-confirmed",
    });
  });

  it("selects the newly saved row when older drafts reuse the same title", async () => {
    const fake = fakePage({
      saveBehavior: "management",
      managementRowDestination: "editor",
      managementDuplicateRows: 2,
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("日本亲子行前准备三步");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-management-confirmed",
    });
    await expect(writer.resumeDraft?.("日本亲子行前准备三步")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
  });

  it("follows Ctrip's content-management to detail to editor recovery path", async () => {
    const fake = fakePage({
      saveBehavior: "management",
      managementRowDestination: "detail",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("日本亲子游首次咨询准备单");
    await writer.fillBody("这是从内容管理页经过详情页恢复的携程草稿正文。");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-management-confirmed",
    });
    await expect(writer.resumeDraft?.("日本亲子游首次咨询准备单")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
  });

  it("selects the management tab containing the newly saved draft when another tab is open", async () => {
    const draftPage = fakePage({
      saveBehavior: "management",
      managementRowDestination: "editor",
    });
    const existingManagementPage = fakePage({
      initialUrl: "https://we.ctrip.com/publish/contentManagement",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [draftPage.page, existingManagementPage.page],
      wait: async () => undefined,
    });

    await writer.fillTitle("日本亲子游首次咨询准备单");
    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-management-confirmed",
    });
    await expect(writer.resumeDraft?.("日本亲子游首次咨询准备单")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
  });

  it("prefers the newly saved management row over unrelated stale detail tabs", async () => {
    const draftPage = fakePage({
      saveBehavior: "management",
      managementRowDestination: "editor",
    });
    const staleDetail = fakePage({
      initialUrl: "https://we.ctrip.com/publish/detail?articleId=338000001&articleType=1",
      detailTitle: "过往已经发布的其他文章",
      detailStatus: "已发布",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [draftPage.page, staleDetail.page],
      wait: async () => undefined,
    });

    await writer.fillTitle("日本亲子游首次咨询准备单");
    await writer.fillBody("这是保存后落到内容管理页并等待恢复的携程草稿正文。");
    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-management-confirmed",
    });
    await expect(writer.resumeDraft?.("日本亲子游首次咨询准备单")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(draftPage.page.url()).toContain("/publish/publishPictureText?articleId=339527581");
    expect(staleDetail.page.url()).toContain("articleId=338000001");
  });

  it("reuses a fixed content-management tab to reopen the editor when no target tab remains", async () => {
    const management = fakePage({
      initialUrl: "https://we.ctrip.com/publish/contentManagement",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [management.page],
      wait: async () => undefined,
    });

    await expect(writer.ensureTargetPage?.()).resolves.toBe(true);
    expect(management.page.url()).toBe("https://we.ctrip.com/publish/publishPictureText");
  });

  it("leaves a blank new editor and resumes the unique persisted management draft", async () => {
    const blankEditor = fakePage({
      persistedManagementTitle: "上海亲子周末攻略",
      persistedManagementBody: "这是已经持久化并等待提交的携程草稿正文。",
      managementRowDestination: "editor",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [blankEditor.page],
      wait: async () => undefined,
    });

    await expect(writer.resumeDraft?.("上海亲子周末攻略")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(blankEditor.directNavigation).toHaveBeenCalledWith(
      "https://we.ctrip.com/publish/contentManagement",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("does not leave or overwrite a non-empty editor with the wrong title", async () => {
    const editor = fakePage({
      persistedManagementTitle: "上海亲子周末攻略",
      managementRowDestination: "editor",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [editor.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("另一个任务留下的非空标题");

    await expect(writer.resumeDraft?.("上海亲子周末攻略")).resolves.toEqual({
      confirmed: false,
      signal: "draft-editor-title-mismatch",
    });
    expect(editor.directNavigation).not.toHaveBeenCalled();
  });

  it("rejects duplicate persisted management rows instead of choosing one", async () => {
    const blankEditor = fakePage({
      persistedManagementTitle: "上海亲子周末攻略",
      persistedManagementBody: "这是已经持久化并等待提交的携程草稿正文。",
      managementRowDestination: "editor",
      managementDuplicateRows: 1,
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [blankEditor.page],
      wait: async () => undefined,
    });

    await expect(writer.resumeDraft?.("上海亲子周末攻略")).resolves.toEqual({
      confirmed: false,
      signal: "draft-management-row-not-unique",
    });
  });

  it("waits for a content-management navigation to hydrate the target editor", async () => {
    const management = fakePage({
      initialUrl: "https://we.ctrip.com/publish/contentManagement",
      targetHydrationDelayChecks: 2,
    });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [management.page], wait });

    await expect(writer.ensureTargetPage?.()).resolves.toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("waits for an existing target editor to hydrate after Chromium starts", async () => {
    const target = fakePage({ targetHydrationDelayChecks: 2 });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [target.page], wait });

    await expect(writer.ensureTargetPage?.()).resolves.toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("accepts an exact draft detail page and reopens its editor", async () => {
    const fake = fakePage({ saveBehavior: "detail" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565");
    await writer.fillBody(
      "\u8fd9\u662f\u4e00\u6bb5\u5df2\u5ba1\u8ba1\u7684\u643a\u7a0b\u8349\u7a3f\u6b63\u6587\u3002",
    );
    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-detail-confirmed",
    });
    await expect(
      writer.resumeDraft?.("\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565"),
    ).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(fake.page.url()).toContain("/publish/publishPictureText?articleId=339527581");
  });

  it("reopens the only matching draft when unrelated detail tabs remain open", async () => {
    const current = fakePage({ saveBehavior: "detail" });
    const stale = fakePage({
      initialUrl: "https://we.ctrip.com/publish/detail?articleId=338000001&articleType=1",
      detailTitle: "过往已经保存的其他文章",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [current.page, stale.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("上海亲子周末攻略");
    await writer.fillBody("这是当前批次已经保存并等待恢复的携程草稿正文。");

    await expect(writer.saveDraft()).resolves.toMatchObject({ confirmed: true });
    await expect(writer.resumeDraft?.("上海亲子周末攻略")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(current.page.url()).toContain("/publish/publishPictureText?articleId=339527581");
    expect(stale.page.url()).toContain("articleId=338000001");
  });

  it("still rejects duplicate detail tabs for the same expected draft", async () => {
    const current = fakePage({ saveBehavior: "detail" });
    const duplicate = fakePage({
      initialUrl: "https://we.ctrip.com/publish/detail?articleId=338000001&articleType=1",
      detailTitle: "上海亲子周末攻略",
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [current.page, duplicate.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("上海亲子周末攻略");
    await writer.fillBody("这是当前批次已经保存并等待恢复的携程草稿正文。");

    await expect(writer.saveDraft()).resolves.toMatchObject({ confirmed: true });
    await expect(writer.resumeDraft?.("上海亲子周末攻略")).resolves.toEqual({
      confirmed: false,
      signal: "draft-detail-page-not-unique",
    });
  });

  it("waits for partially loaded draft-detail evidence instead of declaring drift", async () => {
    const fake = fakePage({
      saveBehavior: "detail",
      detailStatusDelayChecks: 1,
      saveToastVisible: false,
    });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });
    await writer.fillTitle("出行前核验咨询渠道");
    await writer.fillBody("这是携程详情页稍后完整加载的正文。");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-detail-confirmed",
    });
    expect(wait).toHaveBeenCalled();
  });

  it("waits beyond the initial detail window before reopening after a save toast", async () => {
    const fake = fakePage({
      saveBehavior: "detail",
      detailEditDelayChecks: 180,
    });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });
    await writer.fillTitle("出行前核验咨询渠道");
    await writer.fillBody("这是携程详情页稍后显示编辑控件的正文。");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "草稿保存成功",
    });
    await expect(writer.resumeDraft?.("出行前核验咨询渠道")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(fake.bringToFront).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.length).toBeGreaterThan(120);
  });

  it("retries a hydrated draft-detail edit action when Ctrip drops the first click", async () => {
    const fake = fakePage({
      saveBehavior: "detail",
      detailEditIgnoredClicks: 1,
    });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });
    await writer.fillTitle("日本亲子游首次咨询准备单");
    await writer.fillBody("这是一段已经保存并等待恢复编辑器的携程草稿正文。");

    await expect(writer.saveDraft()).resolves.toMatchObject({ confirmed: true });
    await expect(writer.resumeDraft?.("日本亲子游首次咨询准备单")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(wait.mock.calls.length).toBeGreaterThanOrEqual(41);
    expect(fake.directNavigation).not.toHaveBeenCalled();
  });

  it("uses the validated article ID to recover when Ctrip drops every edit click", async () => {
    const fake = fakePage({
      saveBehavior: "detail",
      detailEditIgnoredClicks: 3,
    });
    const wait = vi.fn(async () => undefined);
    const openPage = vi.fn(async (url: string) => {
      await fake.directNavigation(url);
      return fake.page;
    });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      openPage,
      wait,
    });
    await writer.fillTitle("日本亲子游首次咨询准备单");
    await writer.fillBody("这是一段已经保存并等待显式导航恢复的携程草稿正文。");

    await expect(writer.saveDraft()).resolves.toMatchObject({ confirmed: true });
    await expect(writer.resumeDraft?.("日本亲子游首次咨询准备单")).resolves.toEqual({
      confirmed: true,
      signal: "draft-editor-reopened",
    });
    expect(openPage).toHaveBeenCalledOnce();
    expect(openPage).toHaveBeenCalledWith(
      "https://we.ctrip.com/publish/publishPictureText?articleId=339527581&articleStatus=DRAFT",
    );
  });

  it("keeps waiting when Ctrip hydrates the saved-draft detail after the old 90-second window", async () => {
    const fake = fakePage({
      saveBehavior: "detail",
      detailEditDelayChecks: 500,
    });
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });
    await writer.fillTitle("\u51fa\u884c\u524d\u6838\u9a8c\u54a8\u8be2\u6e20\u9053");
    await writer.fillBody(
      "\u8fd9\u662f\u643a\u7a0b\u8be6\u60c5\u9875\u6162\u52a0\u8f7d\u540e\u663e\u793a\u7f16\u8f91\u63a7\u4ef6\u7684\u6b63\u6587\u3002",
    );

    await expect(writer.saveDraft()).resolves.toMatchObject({ confirmed: true });
    await expect(
      writer.resumeDraft?.("\u51fa\u884c\u524d\u6838\u9a8c\u54a8\u8be2\u6e20\u9053"),
    ).resolves.toEqual({ confirmed: true, signal: "draft-editor-reopened" });
    expect(wait.mock.calls.length).toBeGreaterThan(360);
  });

  it("accepts block-boundary whitespace omitted by detail-page textContent", async () => {
    const fake = fakePage({ saveBehavior: "detail", detailBody: "第一段第二段" });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("出行前核验咨询渠道");
    await writer.fillBody("第一段\n\n第二段");

    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: true,
      signal: "draft-detail-confirmed",
    });
  });

  it.each([
    { detailStatus: "\u5df2\u53d1\u5e03" },
    { detailTitle: "\u5176\u4ed6\u6807\u9898" },
    { detailBody: "\u5176\u4ed6\u6b63\u6587" },
  ])("fails closed when draft detail evidence differs: %o", async (detail) => {
    const fake = fakePage({ saveBehavior: "detail", ...detail });
    const writer = createPlaywrightCtripDraftWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    await writer.fillTitle("\u4e0a\u6d77\u4eb2\u5b50\u5468\u672b\u653b\u7565");
    await writer.fillBody(
      "\u8fd9\u662f\u4e00\u6bb5\u5df2\u5ba1\u8ba1\u7684\u643a\u7a0b\u8349\u7a3f\u6b63\u6587\u3002",
    );
    await expect(writer.saveDraft()).resolves.toEqual({
      confirmed: false,
      signal: "draft-detail-mismatch",
    });
  });

  it("waits for the uploaded media state to remain stable before returning", async () => {
    const fake = fakePage();
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripDraftWriter({ pages: () => [fake.page], wait });
    await expect(
      writer.uploadImage({
        name: "geo-ctrip-01.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([1]),
      }),
    ).resolves.toBe(1);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledWith(5_000);
  });

  it("fails closed for zero or duplicate target pages", async () => {
    const fake = fakePage();
    await expect(
      createPlaywrightCtripDraftWriter({ pages: () => [] }).inspect(),
    ).resolves.toMatchObject({ status: "session_required", targetPageCount: 0 });
    await expect(
      createPlaywrightCtripDraftWriter({ pages: () => [fake.page, fake.page] }).inspect(),
    ).resolves.toMatchObject({ status: "adapter_drift", targetPageCount: 2 });
  });
});
