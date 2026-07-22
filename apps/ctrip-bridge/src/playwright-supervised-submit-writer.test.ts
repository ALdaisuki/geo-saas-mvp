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
    readonly managementStatus?: "pending" | "published";
    readonly declaration?: "absent" | "no_ai" | "ai" | "stuck_ai";
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
  };
  const labels = ["\u5b58\u8349\u7a3f", "\u53d1 \u5e03"];
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
      if (selector === "button") return labels;
      if (selector === "body") return options.detailStatus === undefined ? [] : [options.detailStatus];
      if (selector === ".c-m-c-container" && options.managementStatus !== undefined) {
        const label = options.managementStatus === "pending" ? "\u5f85\u5ba1\u6838" : "\u5df2\u53d1\u5e03";
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
      hover: async () => undefined,
      fill: async () => undefined,
      textContent: async () => values[index] ?? "",
      click: async () => {
        if (selector === ".content-ai-tag-item" && values[index] === noAiDeclaration) {
          if (state.declaration !== "stuck_ai") state.declaration = "no_ai";
          return;
        }
        if (selector === "button" && labels[index] === "\u53d1 \u5e03") {
          state.clicks += 1;
          if (options.detailStatus !== undefined) {
            state.url = "https://we.ctrip.com/publish/detail?articleId=340004323&articleType=1";
          } else if (options.managementStatus !== undefined) {
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
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(100);
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

  it("switches an active AI declaration off before clicking publish", async () => {
    const fake = fakePage({ declaration: "ai" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toMatchObject({ outcome: "accepted" });
    expect(fake.state.declaration).toBe("no_ai");
    expect(fake.state.clicks).toBe(1);
  });

  it("does not click publish when the AI declaration cannot be cleared", async () => {
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
    const fake = fakePage({ editorArticleId: "340131520" });
    const writer = createPlaywrightCtripSupervisedSubmitWriter({
      pages: () => [fake.page],
      wait: async () => undefined,
    });

    await expect(writer.submitOnce()).resolves.toMatchObject({
      outcome: "accepted",
      candidateExternalId: "340131520",
      candidateExternalUrl:
        "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
    });
    expect(fake.state.clicks).toBe(1);
  });

  it("does not treat an editor articleId alone as publication evidence", async () => {
    const fake = fakePage({ editorArticleId: "340131520", result: "" });
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
