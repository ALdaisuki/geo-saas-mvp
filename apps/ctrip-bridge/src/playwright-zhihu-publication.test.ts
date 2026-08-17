import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeZhihuPublicUrl,
  createPlaywrightZhihuPublicationAdapter,
  isZhihuArticleEditorUrl,
  ZHIHU_ARTICLE_EDITOR_URL,
  ZHIHU_CONTENT_MANAGER_URL,
  ZHIHU_PUBLICATION_DEFINITION,
  zhihuManagementTimestampMatches,
  zhihuPublicUrlForId,
} from "./playwright-zhihu-publication.js";
import type {
  PlaywrightPublicationLocator,
  PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";

function emptyLocator() {
  return {
    count: async () => 0,
    nth() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => false,
    fill: async () => undefined,
    click: async () => undefined,
    textContent: async () => null,
  };
}

function pageWithUrl(url: string, close?: () => Promise<void>) {
  const page = {
    url: () => url,
    locator: () => emptyLocator(),
    bringToFront: async () => undefined,
  };
  return close === undefined ? page : { ...page, close };
}

function valueLocator(
  value: string,
  attributes: Readonly<Record<string, string>> = {},
): PlaywrightPublicationLocator {
  return {
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
  };
}

function typedEmptyLocator(): PlaywrightPublicationLocator {
  const locator: PlaywrightPublicationLocator = {
    count: async () => 0,
    nth: () => locator,
    first: () => locator,
    isVisible: async () => false,
    isEnabled: async () => false,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => "",
    textContent: async () => "",
    getAttribute: async () => null,
    click: async () => undefined,
  };
  return locator;
}

function zhihuManagementPage(input: {
  readonly title: string;
  readonly timestamp: string;
  readonly publicUrl: string;
  readonly editUrl?: string;
  readonly rowDelayReads?: number;
}): PlaywrightPublicationPage {
  const surface = ZHIHU_PUBLICATION_DEFINITION.creatorManagementSurface;
  let remainingRowDelayReads = input.rowDelayReads ?? 0;
  const row: PlaywrightPublicationLocator = {
    count: async () => 1,
    nth: () => row,
    first: () => row,
    locator: (selector) => {
      if (selector === surface.titleSelector) return valueLocator(input.title);
      if (selector === surface.timestampSelector) return valueLocator(input.timestamp);
      if (selector === surface.statusSelector) return typedEmptyLocator();
      if (selector === surface.itemLinkSelector) {
        return valueLocator("查看文章", { href: input.publicUrl });
      }
      if (selector === surface.titleLinkSelector) {
        return valueLocator(input.title, { href: input.publicUrl });
      }
      if (input.editUrl !== undefined && selector === "a[href]") {
        return valueLocator("编辑", { href: input.editUrl });
      }
      return typedEmptyLocator();
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async () => undefined,
    inputValue: async () => "",
    innerText: async () => `${input.title} ${input.timestamp}`,
    textContent: async () => `${input.title} ${input.timestamp}`,
    getAttribute: async () => null,
    click: async () => undefined,
  };
  return {
    url: () => ZHIHU_CONTENT_MANAGER_URL,
    locator: (selector) => {
      if (selector !== surface.itemSelector) return typedEmptyLocator();
      return {
        ...row,
        count: async () => {
          if (remainingRowDelayReads > 0) {
            remainingRowDelayReads -= 1;
            return 0;
          }
          return 1;
        },
      };
    },
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

function zhihuPublicPage(input: {
  readonly url: string;
  readonly accountName: string;
  readonly title: string;
  readonly body: string;
}): PlaywrightPublicationPage {
  const values = new Map<string, string>([
    [ZHIHU_PUBLICATION_DEFINITION.publicSurface.authorSelectors[0], input.accountName],
    [ZHIHU_PUBLICATION_DEFINITION.publicSurface.titleSelectors[0], input.title],
    [ZHIHU_PUBLICATION_DEFINITION.publicSurface.bodySelectors[0], input.body],
  ]);
  return {
    url: () => input.url,
    locator: (selector) => {
      const value = values.get(selector);
      return value === undefined ? typedEmptyLocator() : valueLocator(value);
    },
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

function zhihuEditorPage(): {
  readonly page: PlaywrightPublicationPage;
  readonly primaryClicks: ReturnType<typeof vi.fn>;
} {
  let title = "";
  let body = "";
  let submitted = false;
  const primaryClicks = vi.fn(async () => {
    submitted = true;
  });
  const valuesFor = (selector: string): readonly string[] => {
    if (selector === ZHIHU_PUBLICATION_DEFINITION.titleSelectors[0]) return [title];
    if (selector === ZHIHU_PUBLICATION_DEFINITION.bodySelectors[0]) return [body];
    if (selector === ZHIHU_PUBLICATION_DEFINITION.actionSelector && !submitted) {
      return ["发布"];
    }
    return [];
  };
  const locatorFor = (selector: string, index = 0): PlaywrightPublicationLocator => ({
    count: async () => valuesFor(selector).length,
    nth: (next) => locatorFor(selector, next),
    first: () => locatorFor(selector),
    isVisible: async () => valuesFor(selector)[index] !== undefined,
    isEnabled: async () => true,
    fill: async (value) => {
      if (selector === ZHIHU_PUBLICATION_DEFINITION.titleSelectors[0]) title = value;
      if (selector === ZHIHU_PUBLICATION_DEFINITION.bodySelectors[0]) body = value;
    },
    inputValue: async () => valuesFor(selector)[index] ?? "",
    innerText: async () => valuesFor(selector)[index] ?? "",
    textContent: async () => valuesFor(selector)[index] ?? "",
    getAttribute: async () => null,
    click: async () => {
      if (selector === ZHIHU_PUBLICATION_DEFINITION.actionSelector && !submitted) {
        await primaryClicks();
      }
    },
  });
  return {
    page: {
      url: () => "https://zhuanlan.zhihu.com/p/1234567890123456789/edit",
      locator: (selector) => locatorFor(selector),
      bringToFront: async () => undefined,
    },
    primaryClicks,
  };
}

describe("Zhihu browser publication surface", () => {
  it("canonicalizes only Zhihu column article URLs", () => {
    expect(canonicalizeZhihuPublicUrl("https://zhuanlan.zhihu.com/p/123456")).toEqual({
      id: "123456",
      url: "https://zhuanlan.zhihu.com/p/123456",
    });
    expect(canonicalizeZhihuPublicUrl("https://zhuanlan.zhihu.com/p/123456?utm_source=test")).toBe(
      null,
    );
    expect(canonicalizeZhihuPublicUrl("https://www.zhihu.com/question/123456")).toBe(null);
    expect(canonicalizeZhihuPublicUrl("https://zhuanlan.zhihu.com/p/not-an-id")).toBe(null);
    expect(canonicalizeZhihuPublicUrl("https://zhuanlan.zhihu.com/p/123456789012345678901")).toBe(
      null,
    );
    expect(zhihuPublicUrlForId("123456789012345678901")).toBe(null);
  });

  it("exposes the column editor and authenticated creator-management contract", () => {
    expect(ZHIHU_ARTICLE_EDITOR_URL).toBe("https://zhuanlan.zhihu.com/write");
    expect(ZHIHU_PUBLICATION_DEFINITION.platform).toBe("zhihu");
    expect(ZHIHU_PUBLICATION_DEFINITION.creatorManagementSurface).toMatchObject({
      url: ZHIHU_CONTENT_MANAGER_URL,
      canonicalPublicLinkConfirmsPublished: true,
      titleSelector: ".CreationCardTitle-wrapper span",
    });
    expect(ZHIHU_PUBLICATION_DEFINITION.submissionMode).toBe("direct_with_optional_confirm");
    expect(ZHIHU_PUBLICATION_DEFINITION.primaryActionLabels).toContain("发布");
    expect(ZHIHU_PUBLICATION_DEFINITION.source.sourcePaths).toEqual(["src/sync/article/zhihu.ts"]);
    expect(ZHIHU_PUBLICATION_DEFINITION.publicSurface.urlForId("123456")).toBe(
      zhihuPublicUrlForId("123456"),
    );
    expect(isZhihuArticleEditorUrl("https://zhuanlan.zhihu.com/p/1234567890123456788/edit")).toBe(
      true,
    );
    expect(isZhihuArticleEditorUrl("https://zhuanlan.zhihu.com/p/123456")).toBe(false);
    expect(isZhihuArticleEditorUrl("https://www.zhihu.com/p/1234567890123456788/edit")).toBe(false);
  });

  it("binds relative creator timestamps to the observed submission window", () => {
    const submittedAt = "2026-08-16T05:40:00.000Z";
    const observedAt = new Date("2026-08-16T05:51:00.000Z");

    expect(zhihuManagementTimestampMatches("编辑于 10 分钟前", submittedAt, observedAt)).toBe(true);
    expect(zhihuManagementTimestampMatches("编辑于 2 小时前", submittedAt, observedAt)).toBe(false);
    expect(
      zhihuManagementTimestampMatches("编辑于 10 分钟前", "2026-08-15T05:40:00.000Z", observedAt),
    ).toBe(false);
    expect(
      zhihuManagementTimestampMatches(
        "编辑于 1 小时前",
        "2026-08-16T05:40:00.000Z",
        new Date("2026-08-16T07:23:00.000Z"),
      ),
    ).toBe(true);
    expect(
      zhihuManagementTimestampMatches(
        "编辑于 2 小时前",
        "2026-08-16T05:40:00.000Z",
        new Date("2026-08-16T07:23:00.000Z"),
      ),
    ).toBe(false);
  });

  it("recovers an accepted submit from the authenticated creator card when the toast is missing", async () => {
    const title = "一个人去云南，跟团未必更省心";
    const body = "先核对路线强度，再判断自由行还是跟团更适合。";
    const publicUrl = "https://zhuanlan.zhihu.com/p/1234567890123456789";
    const editor = zhihuEditorPage();
    const management = zhihuManagementPage({
      title,
      timestamp: "编辑于 1 分钟前",
      publicUrl,
      editUrl: `${publicUrl}/edit`,
    });
    let nowCall = 0;
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [editor.page],
      openCreatorPage: async (url) =>
        url === ZHIHU_CONTENT_MANAGER_URL ? management : editor.page,
      openIndependentPublicPage: async () => {
        throw new Error("submit recovery must not require anonymous public readback");
      },
      now: () =>
        new Date(nowCall++ === 0 ? "2026-08-16T05:40:00.000Z" : "2026-08-16T05:41:00.000Z"),
      wait: async () => undefined,
      readbackAttempts: 1,
      submitObservationAttempts: 1,
      pollMs: 0,
    });
    const prepared = await adapter.writeDraft({ title, body });

    await expect(adapter.submitOnce(prepared)).resolves.toEqual({
      outcome: "accepted",
      signal: "creator-management-published-title-time-matched",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: publicUrl,
    });
    expect(editor.primaryClicks).toHaveBeenCalledOnce();
  });

  it("recovers a missing public candidate from the creator card before independent readback", async () => {
    const accountName = "测试知乎账号";
    const title = "一个人去云南，跟团未必更省心";
    const body = "先核对路线强度，再判断自由行还是跟团更适合。";
    const publicUrl = "https://zhuanlan.zhihu.com/p/1234567890123456789";
    const management = zhihuManagementPage({
      title,
      timestamp: "编辑于 10 分钟前",
      publicUrl,
    });
    const openIndependentPublicPage = vi.fn(async () =>
      zhihuPublicPage({ url: publicUrl, accountName, title, body }),
    );
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "public_readback",
      now: () => new Date("2026-08-16T05:51:00.000Z"),
      wait: async () => undefined,
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName: accountName,
        expectedTitle: title,
        expectedBody: body,
        submittedAt: "2026-08-16T05:40:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: publicUrl,
      externalId: "1234567890123456789",
      externalUrl: publicUrl,
      signal: "independent-public-payload-matched",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(publicUrl);
  });

  it("waits for Zhihu creator cards that arrive after the initial management DOM", async () => {
    const accountName = "测试知乎账号";
    const title = "一个人去云南，跟团未必更省心";
    const body = "先核对路线强度，再判断自由行还是跟团更适合。";
    const publicUrl = "https://zhuanlan.zhihu.com/p/1234567890123456789";
    const management = zhihuManagementPage({
      title,
      timestamp: "编辑于 1 分钟前",
      publicUrl,
      rowDelayReads: 4,
    });
    const openIndependentPublicPage = vi.fn(async () =>
      zhihuPublicPage({ url: publicUrl, accountName, title, body }),
    );
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "public_readback",
      now: () => new Date("2026-08-16T05:41:00.000Z"),
      wait: async () => undefined,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName: accountName,
        expectedTitle: title,
        expectedBody: body,
        submittedAt: "2026-08-16T05:40:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: publicUrl,
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith(publicUrl);
  });

  it("confirms the default Zhihu outcome from an exact published creator card", async () => {
    const title = "一个人去云南，跟团未必更省心";
    const body = "先核对路线强度，再判断自由行还是跟团更适合。";
    const publicUrl = "https://zhuanlan.zhihu.com/p/1234567890123456789";
    const management = zhihuManagementPage({
      title,
      timestamp: "编辑于 43 分钟前",
      publicUrl,
      rowDelayReads: 4,
    });
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("publisher status must not depend on anonymous Zhihu navigation");
    });
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      now: () => new Date("2026-08-16T06:23:00.000Z"),
      wait: async () => undefined,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName: "测试知乎账号",
        expectedTitle: title,
        expectedBody: body,
        submittedAt: "2026-08-16T05:40:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_confirmed",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: publicUrl,
      externalId: "1234567890123456789",
      externalUrl: publicUrl,
      signal: "creator-management-published-title-time-matched",
    });
    expect(openIndependentPublicPage).not.toHaveBeenCalled();
  });

  it("confirms only after an independent public page can be read", async () => {
    const openIndependentPublicPage = vi.fn(async () => {
      throw new Error("anonymous public readback must not be opened");
    });
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [],
      openIndependentPublicPage,
      confirmationMode: "public_readback",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "123456",
        candidateExternalUrl: "https://zhuanlan.zhihu.com/p/123456",
        expectedAccountName: "测试账号",
        expectedTitle: "测试标题",
        expectedBody: "测试正文内容",
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      signal: "independent-public-navigation-unavailable",
    });
    expect(openIndependentPublicPage).toHaveBeenCalledWith("https://zhuanlan.zhihu.com/p/123456");
  });

  it("fails closed when duplicate editor pages cannot be reconciled", async () => {
    const editorUrl = ZHIHU_ARTICLE_EDITOR_URL;
    const first = pageWithUrl(editorUrl);
    const second = pageWithUrl(editorUrl, async () => {
      throw new Error("page close failed");
    });
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [first, second],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      wait: async () => undefined,
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(adapter.inspectPrepared()).resolves.toMatchObject({
      status: "adapter_drift",
      targetPageCount: 2,
      challengeSignals: ["duplicate-target-page-unresolved"],
    });
  });

  it("keeps an auto-saved Zhihu draft edit URL bound to the prepared editor", async () => {
    const adapter = createPlaywrightZhihuPublicationAdapter({
      pages: () => [pageWithUrl("https://zhuanlan.zhihu.com/p/1234567890123456788/edit")],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
      wait: async () => undefined,
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(adapter.inspectPrepared()).resolves.toMatchObject({
      status: "adapter_drift",
      targetPageCount: 1,
    });
  });
});
