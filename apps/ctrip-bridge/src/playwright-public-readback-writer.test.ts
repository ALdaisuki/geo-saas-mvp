import { describe, expect, it, vi } from "vitest";

import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import { createPlaywrightCtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";

const expectedTitle = "日本亲子行前准备三步";
const expectedBody = "准备护照，确认交通，再安排每日节奏。";
const submittedAt = "2026-07-21T04:30:00.000Z";

function fakePage(
  url: string,
  values: Readonly<Record<string, readonly string[]>>,
): PlaywrightCtripDraftPage {
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
  options: { readonly detailInNewPage?: boolean; readonly refreshRequired?: boolean } = {},
) {
  let managementUrl = "https://we.ctrip.com/publish/contentManagement";
  let refreshed = options.refreshRequired !== true;
  const detailPages: PlaywrightCtripDraftPage[] = [];
  const managementLocator = (selector: string, index = 0): PlaywrightCtripDraftLocator => ({
    count: async () => (selector === ".c-m-c-container" && refreshed ? rows.length : 0),
    nth: (next) => managementLocator(selector, next),
    first: () => managementLocator(selector, 0),
    isVisible: async () =>
      selector === ".c-m-c-container" && refreshed && rows[index] !== undefined,
    hover: async () => undefined,
    fill: async () => undefined,
    textContent: async () => (selector === ".c-m-c-container" ? (rows[index]?.text ?? "") : ""),
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
    goto: async (url) => {
      refreshed = true;
      managementUrl = url;
    },
  };
  const publicPages: PlaywrightCtripDraftPage[] = [];
  const openPage = async (url: string): Promise<PlaywrightCtripDraftPage> => {
    if (url === "https://we.ctrip.com/publish/contentManagement") return managementPage;
    const page = fakePage(url, {
      h1: [publicContent.title],
      article: [publicContent.body],
    });
    publicPages.push(page);
    return page;
  };
  return { managementPage, openPage, publicPages, pages: () => detailPages };
}

describe("Ctrip public readback writer", () => {
  it("reads the current Ctrip Taro article nodes without folding navigation and footer into the payload", async () => {
    const page = fakePage("https://m.ctrip.com/webapp/you/community/detail?articleId=123450001", {
      "div.right.flex-column > span.user-name-title": [expectedTitle],
      "div.right.flex-column > span.content": [expectedBody],
      body: [`酒店 机票 ${expectedTitle} ${expectedBody} 携程客服电话`],
    });
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: "123450001",
        candidateExternalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      observedTitle: expectedTitle,
      observedBody: expectedBody,
      externalId: "123450001",
    });
  });
  it("closes the public article tab after a confirmed readback", async () => {
    const close = vi.fn(async () => undefined);
    const page = {
      ...fakePage("https://m.ctrip.com/webapp/you/community/detail?articleId=123450001", {
        h1: [expectedTitle],
        article: [expectedBody],
      }),
      close,
    };
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: "123450001",
        candidateExternalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("still confirms public readback when a challenge overlay is present alongside the article payload", async () => {
    const page = fakePage("https://m.ctrip.com/webapp/you/community/detail?articleId=123450001", {
      '[data-testid="captcha"]': ["captcha overlay"],
      h1: [expectedTitle],
      article: [expectedBody],
    });
    const writer = createPlaywrightCtripPublicReadbackWriter({ pages: () => [page] });

    await expect(
      writer.readback({
        candidateExternalId: "123450001",
        candidateExternalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "123450001",
      signal: "public-payload-matched",
    });
  });
  it("recovers one recent non-draft articleId from content management before public readback", async () => {
    const harness = managementRecoveryHarness([
      {
        text: `${expectedTitle} 已发布 2026-07-21 12:30`,
        articleId: "123450001",
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
      externalId: "123450001",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
      signal: "public-payload-matched",
    });
    expect(harness.publicPages).toHaveLength(1);
    expect(harness.publicPages[0]?.url()).toBe(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
    );
    expect(harness.managementPage.url()).toBe("https://we.ctrip.com/publish/contentManagement");
  });

  it("does not treat an internal published status as public confirmation", async () => {
    const harness = managementRecoveryHarness([
      {
        text: `${expectedTitle} 已发布 2026-07-21 12:30`,
        articleId: "123450001",
      },
    ]);
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: harness.pages,
      openPage: async (url) =>
        url === "https://we.ctrip.com/publish/contentManagement"
          ? harness.openPage(url)
          : fakePage(url, {
              h1: [expectedTitle],
              article: ["公开页面正文仍在审核，尚未出现预期正文"],
            }),
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

  it("refreshes an existing content-management tab before scanning for a submitted article", async () => {
    const harness = managementRecoveryHarness(
      [{ text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" }],
      undefined,
      { refreshRequired: true },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: () => [harness.managementPage],
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
      externalId: "123450001",
    });
    expect(harness.publicPages).toHaveLength(1);
  });

  it("prefers the submitted-time management match over an unrelated open draft editor", async () => {
    const unrelatedDraft = fakePage(
      "https://we.ctrip.com/publish/publishPictureText?articleId=340983434&articleStatus=DRAFT",
      {},
    );
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" },
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
      externalId: "123450001",
    });
  });

  it("recovers an articleId when content management opens the detail in a new tab", async () => {
    const harness = managementRecoveryHarness(
      [{ text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" }],
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
      externalId: "123450001",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
    });
  });

  it("fails closed when content management has multiple recent non-draft title matches", async () => {
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" },
      { text: `${expectedTitle} 待审核 2026-07-21 12:31`, articleId: "123450002" },
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
    const harness = managementRecoveryHarness([{ text: rowText, articleId: "123450001" }]);
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
      { text: `${expectedTitle} 待审核 2026-07-21 12:30`, articleId: "123450001" },
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

  it("stops retrying a management row that was explicitly rejected", async () => {
    const harness = managementRecoveryHarness([
      {
        text: `${expectedTitle} 审核未通过 文章被平台判定为广告软文 2026-07-21 12:30`,
        articleId: "123450001",
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
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      externalId: null,
      externalUrl: null,
      signal: "management-candidate-rejected-soft-advertorial",
    });
    expect(harness.publicPages).toHaveLength(0);
  });

  it.each(["审核未通过", "审核不通过", "未通过"])(
    "recognizes the Ctrip rejected status label %s",
    async (statusLabel) => {
      const harness = managementRecoveryHarness([
        {
          text: `${expectedTitle} ${statusLabel} 2026-07-21 12:30`,
          articleId: "123450001",
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
        outcome: "publisher_rejected",
        publisherReasonCode: "publisher.rejected.other",
        signal: "management-candidate-rejected",
      });
    },
  );

  it("requires public payload matching after content-management recovery", async () => {
    const harness = managementRecoveryHarness(
      [{ text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" }],
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
    const rejected = fakePage("https://we.ctrip.com/publish/detail?articleId=111&articleType=1", {
      body: ["旧文章 审核未通过"],
    });
    const published = fakePage(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
      { h1: [expectedTitle], article: [expectedBody] },
    );
    const writer = createPlaywrightCtripPublicReadbackWriter({
      pages: () => [rejected, published],
    });

    await expect(
      writer.readback({
        candidateExternalId: "123450001",
        candidateExternalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({ outcome: "confirmed", externalId: "123450001" });
  });

  it("does not adopt an unbound public tab when submit observed time is present", async () => {
    const page = fakePage("https://m.ctrip.com/webapp/you/community/detail?articleId=123450001", {
      "div.right.flex-column > span.user-name-title": [expectedTitle],
      "div.right.flex-column > span.content": [expectedBody],
    });
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
      outcome: "unavailable",
      externalId: null,
      externalUrl: null,
      signal: "management-navigation-unavailable",
    });
  });

  it("recovers from management when the matching detail tab is already open", async () => {
    const preexistingDetail = fakePage(
      "https://we.ctrip.com/publish/detail?articleId=123450001&articleType=1",
      {},
    );
    const harness = managementRecoveryHarness([
      { text: `${expectedTitle} 已发布 2026-07-21 12:30`, articleId: "123450001" },
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
      externalId: "123450001",
      signal: "public-payload-matched",
    });
  });
  it("does not adopt a public detail page without candidate or submit-time evidence", async () => {
    const page = fakePage("https://m.ctrip.com/webapp/you/community/detail?articleId=123450001", {
      h1: ["日本亲子行前准备三步"],
      article: ["准备护照，确认交通，再安排每日节奏。"],
    });
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
      outcome: "unavailable",
      externalId: null,
      externalUrl: null,
      signal: "management-submit-time-missing",
    });
  });

  it("does not treat an editor articleId as post-submit candidate evidence", async () => {
    const page = fakePage("https://we.ctrip.com/publish/publishPictureText?articleId=123450001", {
      h1: ["日本亲子行前准备三步"],
      article: ["准备护照，确认交通，再安排每日节奏。"],
    });
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
      outcome: "unavailable",
      externalId: null,
      externalUrl: null,
      signal: "management-submit-time-missing",
    });
  });

  it("does not bind an unrelated rejected detail page without submit evidence", async () => {
    const page = fakePage("https://we.ctrip.com/publish/detail?articleId=340004323&articleType=1", {
      body: ["带娃去东京咨询准备 审核未通过"],
    });
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
      outcome: "unavailable",
      signal: "management-submit-time-missing",
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
