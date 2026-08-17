import { describe, expect, it, vi } from "vitest";

import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import { createPlaywrightCtripSupervisedSubmitWriter } from "./playwright-supervised-submit-writer.js";

function fakePage(
  options: {
    readonly result?: string;
    readonly mediaCount?: number;
    readonly location?: string;
    readonly detailStatus?: string;
    readonly editorArticleId?: string;
    readonly managementStatus?: "draft" | "pending" | "published";
    readonly declaration?: "absent" | "no_ai" | "ai" | "stuck_ai";
    readonly actionLabels?: readonly string[];
    readonly imageInputCount?: number;
    readonly publishEnabled?: boolean;
    readonly redirectToManagement?: boolean;
    readonly publishApiResult?: {
      readonly result: boolean;
      readonly resultId?: number;
      readonly resultText?: string;
    };
  } = {},
) {
  const state = {
    url:
      options.editorArticleId === undefined
        ? "https://we.ctrip.com/publish/publishPictureText"
        : `https://we.ctrip.com/publish/publishPictureText?articleId=${options.editorArticleId}`,
    title: "Shanghai family guide",
    body: "A verified Ctrip article body with enough detail for the supervised submission test.",
    result: options.result ?? "\u53d1\u5e03\u6210\u529f",
    clicks: 0,
    declaration: options.declaration ?? "absent",
    closed: false,
  };
  const labels = options.actionLabels ?? [
    "\u4e0a\u4f20\u56fe\u7247",
    "\u5b58\u8349\u7a3f",
    "\u53d1 \u5e03",
  ];
  const noAiDeclaration = "\u4e0d\u6dfb\u52a0\u81ea\u4e3b\u58f0\u660e";
  const aiDeclaration = "\u7b14\u8bb0\u542bAI\u5408\u6210\u5185\u5bb9";

  function locatorFor(selector: string, index = 0): PlaywrightCtripDraftLocator {
    const values = (() => {
      if (selector.includes('role="textbox"')) return [state.title];
      if (selector.includes('role="combobox"')) return [state.body];
      if (selector.includes(".ant-select-selection-item")) {
        return options.location === "" ? [] : [options.location ?? "Shanghai, China"];
      }
      if (selector === ".content-ai-tag-item") {
        return state.declaration === "absent" ? [] : [noAiDeclaration, aiDeclaration];
      }
      if (selector === ".content-ai-tag-item:has(.icon-selected)") {
        if (state.declaration === "no_ai") return [noAiDeclaration];
        if (state.declaration === "ai" || state.declaration === "stuck_ai") {
          return [aiDeclaration];
        }
        return [];
      }
      if (selector === 'input[type="file"][accept="image/*"]') {
        return Array.from({ length: options.imageInputCount ?? 1 }, () => "");
      }
      if (selector === 'button, [role="button"]') return labels;
      if (selector === "body")
        return options.detailStatus === undefined ? [] : [options.detailStatus];
      if (selector === ".c-m-c-container" && options.managementStatus !== undefined) {
        const label =
          options.managementStatus === "draft"
            ? "\u8349\u7a3f"
            : options.managementStatus === "pending"
              ? "\u5f85\u5ba1\u6838"
              : "\u5df2\u53d1\u5e03";
        return [`${state.title}\n${label}\n2026-07-22 18:36:34`];
      }
      if (
        selector.includes('[class~="ant-upload-list-picture-card-container"]') ||
        selector.includes('[class~="r-d-upload-image-container-done"]')
      ) {
        return Array.from({ length: options.mediaCount ?? 1 }, () => "media");
      }
      if (selector === '[role="alert"], .ant-message-notice-content') return [state.result];
      return [];
    })();
    return {
      count: async () => values.length,
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => values[index] !== undefined && values[index] !== "",
      isEnabled: async () => values[index] !== "\u53d1 \u5e03" || options.publishEnabled !== false,
      hover: async () => undefined,
      fill: async () => undefined,
      textContent: async () => values[index] ?? "",
      click: async () => {
        if (selector === ".content-ai-tag-item" && values[index] === noAiDeclaration) {
          if (state.declaration !== "stuck_ai") state.declaration = "no_ai";
          return;
        }
        if (selector === 'button, [role="button"]' && labels[index] === "\u53d1 \u5e03") {
          state.clicks += 1;
          if (options.detailStatus !== undefined) {
            state.url = "https://we.ctrip.com/publish/detail?articleId=340004323&articleType=1";
          } else if (
            options.managementStatus !== undefined &&
            options.redirectToManagement !== false
          ) {
            state.url = "https://we.ctrip.com/publish/contentManagement";
          }
        }
      },
      setInputFiles: async () => undefined,
    };
  }

  const page: PlaywrightCtripDraftPage = {
    url: () => state.url,
    locator: (selector) => locatorFor(selector),
    bringToFront: async () => undefined,
    goto: async (url) => {
      state.url = url;
    },
    ...(options.publishApiResult === undefined
      ? {}
      : {
          waitForResponse: async (predicate) => {
            const response = {
              url: () => "https://m.ctrip.com/restapi/soa2/14045/json/tripShoot",
              json: async () => ({ result: options.publishApiResult }),
            };
            if (!predicate(response)) throw new Error("Unexpected response predicate");
            return response;
          },
        }),
    close: async () => {
      state.closed = true;
    },
  };
  return { page, state };
}

describe("Ctrip supervised Playwright submit writer", () => {
  it("reads the fixed prepared scope and clicks the unique final action once", async () => {
    const fake = fakePage();
    const wait = vi.fn(async () => undefined);
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait,
    });

    await expect(writer.inspectPrepared()).resolves.toMatchObject({
      status: "ready",
      targetPageCount: 1,
      titleEditorCount: 1,
      bodyEditorCount: 1,
      imageInputCount: 1,
      uploadActionCount: 1,
      draftActionCount: 1,
      locationCount: 1,
      mediaCount: 1,
      finalActionCount: 1,
      titleText: fake.state.title,
      bodyText: fake.state.body,
      locationText: "Shanghai, China",
    });
    await expect(writer.submitOnce()).resolves.toMatchObject({
      outcome: "accepted",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.clicks).toBe(1);
    expect(fake.state.closed).toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 100);
    expect(wait).toHaveBeenNthCalledWith(2, 100);
  });

  it.each([
    { actionLabels: ["存草稿", "发 布"], name: "missing upload entry" },
    { actionLabels: ["上传图片", "存草稿", "发 布", "发 布"], name: "duplicate publish action" },
  ])("does not click publish for $name", async ({ actionLabels }) => {
    const fake = fakePage({ actionLabels });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({ pages: () => [fake.page] });

    await expect(writer.inspectPrepared()).resolves.toMatchObject({ status: "adapter_drift" });
    await expect(writer.submitOnce()).rejects.toThrow(/not stable/iu);
    expect(fake.state.clicks).toBe(0);
  });

  it("does not click publish when the hidden upload input is missing", async () => {
    const fake = fakePage({ imageInputCount: 0 });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({ pages: () => [fake.page] });

    await expect(writer.inspectPrepared()).resolves.toMatchObject({
      status: "adapter_drift",
      imageInputCount: 0,
    });
    await expect(writer.submitOnce()).rejects.toThrow(/not stable/iu);
    expect(fake.state.clicks).toBe(0);
  });

  it("binds the final click to the exact prepared content snapshot", async () => {
    const fake = fakePage();
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });
    const prepared = await writer.inspectPrepared();
    fake.state.title = "changed after the publication gate";

    await expect(writer.submitOnce(prepared)).rejects.toThrow(/prepared content.*not stable/iu);
    expect(fake.state.clicks).toBe(0);
  });

  it("does not click a disabled final publish action", async () => {
    const fake = fakePage({ publishEnabled: false });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).rejects.toThrow(/disabled/iu);
    expect(fake.state.clicks).toBe(0);
  });

  it("accepts a unique pending-review row after Ctrip redirects to content management", async () => {
    const fake = fakePage({ result: "", managementStatus: "pending" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toEqual({
      outcome: "accepted",
      signal: "ctrip-management-pending",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.clicks).toBe(1);
    expect(fake.state.closed).toBe(true);
  });

  it("classifies a retained creator-center draft as not accepted instead of uncertain", async () => {
    const fake = fakePage({
      result: "",
      managementStatus: "draft",
      redirectToManagement: false,
      publishApiResult: {
        result: false,
        resultId: 208,
        resultText: "Platform retained the draft",
      },
    });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toEqual({
      outcome: "not_accepted",
      signal: "ctrip-publish-api-rejected-208-draft-retained",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.clicks).toBe(1);
    expect(fake.state.closed).toBe(false);
  });

  it("does not let a pre-existing draft mask an accepted publish API response", async () => {
    const fake = fakePage({
      result: "",
      managementStatus: "draft",
      publishApiResult: {
        result: true,
      },
    });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toMatchObject({
      outcome: "accepted",
      signal: "ctrip-publish-api-accepted",
    });
    expect(fake.state.clicks).toBe(1);
    expect(fake.state.closed).toBe(true);
  });

  it("reports ambiguous post-click evidence as uncertain and known validation as rejected", async () => {
    for (const [result, outcome] of [
      ["", "uncertain"],
      ["\u8bf7\u5b8c\u5584\u4fe1\u606f", "rejected"],
      ["\u8bf7\u6dfb\u52a0\u4e00\u4e2a\u5730\u70b9\uff01", "rejected"],
    ] as const) {
      const fake = fakePage({ result });
      const writer = createPlaywrightCtripSupervisedSubmitWriter({
        pages: () => [fake.page],
        wait: async () => undefined,
      });
      await expect(writer.submitOnce()).resolves.toMatchObject({ outcome });
      expect(fake.state.clicks).toBe(1);
    }
  });

  it("fails closed without changing an active AI declaration", async () => {
    const fake = fakePage({ declaration: "ai" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toEqual({
      outcome: "rejected",
      signal: "ctrip-ai-declaration-unresolved:\u7b14\u8bb0\u542bAI\u5408\u6210\u5185\u5bb9",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.declaration).toBe("ai");
    expect(fake.state.clicks).toBe(0);
  });

  it("does not click publish when an AI declaration is selected", async () => {
    const fake = fakePage({ declaration: "stuck_ai" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toEqual({
      outcome: "rejected",
      signal: "ctrip-ai-declaration-unresolved:\u7b14\u8bb0\u542bAI\u5408\u6210\u5185\u5bb9",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.clicks).toBe(0);
  });

  it("reports a missing selected location in the prepared scope", async () => {
    const fake = fakePage({ location: "" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({ pages: () => [fake.page] });

    await expect(writer.inspectPrepared()).resolves.toMatchObject({
      status: "ready",
      locationCount: 0,
      locationText: "",
    });
  });

  it("maps a post-submit editor articleId to the public URL only with a success signal", async () => {
    const fake = fakePage({ editorArticleId: "123450001" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toMatchObject({
      outcome: "accepted",
      candidateExternalId: "123450001",
      candidateExternalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
    });
    expect(fake.state.clicks).toBe(1);
  });

  it("does not treat an editor articleId alone as publication evidence", async () => {
    const fake = fakePage({ editorArticleId: "123450001", result: "" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toMatchObject({
      outcome: "uncertain",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(fake.state.clicks).toBe(1);
  });

  it("classifies a delayed Ctrip detail rejection without claiming a public URL", async () => {
    const fake = fakePage({ result: "", detailStatus: "审核未通过" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toEqual({
      outcome: "rejected",
      signal: "ctrip-detail-rejected",
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
  });

  it("fails closed for zero or duplicate target pages", async () => {
    const fake = fakePage();
    await expect(
      createPlaywrightCtripSupervisedSubmitWriter({ pages: () => [] }).inspectPrepared(),
    ).resolves.toMatchObject({ status: "session_required", targetPageCount: 0 });
    await expect(
      createPlaywrightCtripSupervisedSubmitWriter({
        pages: () => [fake.page, fake.page],
      }).inspectPrepared(),
    ).resolves.toMatchObject({ status: "adapter_drift", targetPageCount: 2 });
  });
});
