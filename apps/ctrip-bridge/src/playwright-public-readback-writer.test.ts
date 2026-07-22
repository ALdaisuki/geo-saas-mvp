import { describe, expect, it } from "vitest";

import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import { createPlaywrightCtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";

const expectedTitle = "日本亲子行前准备三步";
const expectedBody = "准备护照，确认交通，再安排每日节奏。";
const submittedAt = "2026-07-21T04:30:00.000Z";

function fakePage(url: string, values: Readonly<Record<string, readonly string[]>>): PlaywrightCtripDraftPage {
  let currentUrl = url;
  const locatorFor = (selector: string, index = 0): PlaywrightCtripDraftLocator => {
    const items = values[selector] ?? [];
    return {
      count: async () => items.length,
      nth: (next) => locatorFor(selector, next),
      first: () => locatorFor(selector, 0),
      isVisible: async () => items[index] !== undefined,
      hover: async () => undefined,
      fill: async () => undefined,
      textContent: async () => items[index] ?? "",
      click: async () => undefined,
      setInputFiles: async () => undefined,
    };
  };
  return {
    url: () => currentUrl,
    locator: (selector) => locatorFor(selector),
    bringToFront: async () => undefined,
    goto: async (nextUrl) => {
      currentUrl = nextUrl;
    },
  };
}

function managementRecoveryHarness(
  rows: readonly { readonly text: string; readonly articleId: string }[],
  publicContent: { readonly title: string; readonly body: string } = {
    title: expectedTitle,
    body: expectedBody,
  },
  options: { readonly detailInNewPage?: boolean } = {},
) {
  let managementUrl = "https://we.ctrip.com/publish/contentManagement";
  const detailPages: PlaywrightCtripDraftPage[] = [];
  const managementLocator = (selector: string, index = 0): PlaywrightCtripDraftLocator => ({
    count: async () => (selector === ".c-m-c-container" ? rows.length : 0),
    nth: (next) => managementLocator(selector, next),
    first: () => managementLocator(selector, 0),
    isVisible: async () => selector === ".c-m-c-container" && rows[index] !== undefined,
    hover: async () => undefined,
    fill: async () => undefined,
    textContent: async () => (selector === ".c-m-c-container" ? rows[index]?.text ?? "" : ""),
    click: async () => {
      const row = rows[index];
      if (selector === ".c-m-c-container" && row !== undefined) {
        const detailUrl = `https://we.ctrip.com/publish/detail?articleId=${row.articleId}&articleType=1`;
        if (options.detailInNewPage === true) detailPages.push(fakePage(detailUrl, {}));
        else managementUrl = detailUrl;
      }
    },
    setInputFiles: async () => undefined,
  });
  const managementPage: PlaywrightCtripDraftPage = {
    url: () => managementUrl,
    locator: (selector) => managementLocator(selector),
    bringToFront: async () => undefined,
  };
  const publicPages: PlaywrightCtripDraftPage[] = [];
  const openPage = async (url: string): Promise<PlaywrightCtripDraftPage> => {
    if (url === "https://we.ctrip.com/publish/contentManagement") return managementPage;
    const page = fakePage(url, {
      h1: [publicContent.title],
      "article, main, body": [publicContent.body],
    });
    publicPages.push(page);
    return page;
  };
  return { managementPage, openPage, publicPages, pages: () => detailPages };
}

describe("Ctrip public readback writer", () => {

  it("reads the current Ctrip Taro article nodes without folding navigation and footer into the payload", async () => {
    const page = fakePage(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      {
        "div.right.flex-column > span.user-name-title": [expectedTitle],
        "div.right.flex-column > span.content": [expectedBody],
        body: [`酒店 机票 ${expectedTitle} ${expectedBody} 携程客服电话`],
      },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: "340131520",
        candidateExternalUrl:
          "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      observedTitle: expectedTitle,
      observedBody: expectedBody,
      externalId: "340131520",
    });
  });
  it("recovers one recent non-draft articleId from content management before public readback", async () => {
    const harness = managementRecoveryHarness([
      {
        text: `${expectedTitle} 已发布 2026-07-21 12:30`,
        articleId: "340131520",
      },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      signal: "public-payload-matched",
    });
    expect(harness.publicPages).toHaveLength(1);
  });

  it("prefers the submitted-time management match over an unrelated open draft editor", async () => {
    const unrelatedDraft = fakePage(
      "https://we.ctrip.com/publish/publishPictureText?articleId=340983434&articleStatus=DRAFT",
      {},
    );
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "340131520" },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: () => [unrelatedDraft, ...harness.pages()],
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
    });
  });

  it("recovers an articleId when content management opens the detail in a new tab", async () => {
    const harness = managementRecoveryHarness(
      [{ text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "340131520" }],
      undefined,
      { detailInNewPage: true },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
    });
  });

  it("fails closed when content management has multiple recent non-draft title matches", async () => {
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "340131520" },
      { text: `${expectedTitle} 待审核 2026-07-21 12:31`, articleId: "340131521" },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "management-candidate-not-unique",
    });
    expect(harness.publicPages).toHaveLength(0);
  });

  it.each([
    [`${expectedTitle} 草稿 2026-07-21 12:30`, "draft"],
    [`${expectedTitle} 已发布 2026-07-20 12:30`, "stale"],
  ])("does not recover a %s content-management row", async (rowText) => {
    const harness = managementRecoveryHarness([{ text: rowText, articleId: "340131520" }]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "management-candidate-not-found",
    });
    expect(harness.publicPages).toHaveLength(0);
  });

  it("keeps a pending-review management candidate retryable without public navigation", async () => {
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 待审核 2026-07-21 12:30`, articleId: "340131520" },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "management-candidate-pending-review",
    });
    expect(harness.publicPages).toHaveLength(0);
  });

  it("requires public payload matching after content-management recovery", async () => {
    const harness = managementRecoveryHarness(
      [{ text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "340131520" }],
      { title: expectedTitle, body: "另一篇文章的正文" },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "mismatch",
      externalId: null,
      externalUrl: null,
      signal: "public-payload-mismatch",
    });
  });

  it("ignores an unrelated rejected detail page when reading a known candidate", async () => {
    const rejected = fakePage(
      "https://we.ctrip.com/publish/detail?articleId=111&articleType=1",
      { body: ["旧文章 审核未通过"] },
    );
    const published = fakePage(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      { h1: [expectedTitle], "article, main, body": [expectedBody] },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [rejected, published] });

    await expect(
      writer.readback({
        candidateExternalId: "340131520",
        candidateExternalUrl:
          "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({ outcome: "confirmed", externalId: "340131520" });
  });

  it("uses a currently open public detail page even when submit observed time is present", async () => {
    const page = fakePage(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      {
        "div.right.flex-column > span.user-name-title": [expectedTitle],
        "div.right.flex-column > span.content": [expectedBody],
      },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      signal: "public-payload-matched",
    });
  });

  it("recovers from management when the matching detail tab is already open", async () => {
    const preexistingDetail = fakePage(
      "https://we.ctrip.com/publish/detail?articleId=340131520&articleType=1",
      {},
    );
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "340131520" },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: () => [preexistingDetail, ...harness.pages()],
      openPage: harness.openPage,
    });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      signal: "public-payload-matched",
    });
  });
  it("uses a currently open public detail page when submit candidate evidence is missing", async () => {
    const page = fakePage(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      {
        h1: ["日本亲子行前准备三步"],
        "article, main, body": ["准备护照，确认交通，再安排每日节奏。"],
      },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle: "日本亲子行前准备三步",
        expectedBody: "准备护照，确认交通，再安排每日节奏。",
        submittedAt: null,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
    });
  });

  it("discovers an editor articleId and confirms it only after public content matches", async () => {
    const page = fakePage(
      "https://we.ctrip.com/publish/publishPictureText?articleId=340131520",
      {
        h1: ["日本亲子行前准备三步"],
        "article, main, body": ["准备护照，确认交通，再安排每日节奏。"],
      },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle: "日本亲子行前准备三步",
        expectedBody: "准备护照，确认交通，再安排每日节奏。",
        submittedAt: null,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "340131520",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=340131520",
      signal: "public-payload-matched",
    });
  });

  it("resolves a rejected internal detail page as not found", async () => {
    const page = fakePage(
      "https://we.ctrip.com/publish/detail?articleId=340004323&articleType=1",
      { body: ["带娃去东京咨询准备 审核未通过"] },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedTitle: "带娃去东京咨询准备",
        expectedBody: "正文",
        submittedAt: null,
      }),
    ).resolves.toMatchObject({
      outcome: "not_found",
      signal: "ctrip-detail-rejected",
      externalId: null,
      externalUrl: null,
    });
  });

  it("does not accept a Ctrip management URL as a public publication URL", async () => {
    const page = fakePage("https://we.ctrip.com/publish/contentManagement", {});
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: "340004323",
        candidateExternalUrl:
          "https://we.ctrip.com/publish/detail?articleId=340004323&articleType=1",
        expectedTitle: "带娃去东京咨询准备",
        expectedBody: "正文",
        submittedAt: null,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "candidate-public-url-missing",
    });
  });
});
