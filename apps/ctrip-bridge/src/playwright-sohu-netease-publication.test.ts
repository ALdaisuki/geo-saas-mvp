import { describe, expect, it } from "vitest";

import {
  canonicalizeNeteaseManagementItemUrl,
  canonicalizeNeteasePublicUrl,
  classifyNeteaseModerationRecord,
  createPlaywrightNeteasePublicationAdapter,
  NETEASE_ARTICLE_EDITOR_URL,
  NETEASE_CONTENT_MANAGER_URL,
  NETEASE_PUBLICATION_DEFINITION,
  neteaseManagementTimestampMatches,
} from "./playwright-netease-publication.js";
import type {
  PlatformPublicationDefinition,
  PlaywrightPublicationLocator,
  PlaywrightPublicationPage,
} from "./playwright-platform-publication.js";
import {
  canonicalizeSohuManagementItemUrl,
  canonicalizeSohuPublicUrl,
  classifySohuModerationRecord,
  createPlaywrightSohuPublicationAdapter,
  extractSohuRejectedManagementRecords,
  SOHU_ARTICLE_EDITOR_URL,
  SOHU_CONTENT_MANAGER_URL,
  SOHU_PUBLICATION_DEFINITION,
  type SohuRejectedManagementRecord,
  selectSohuRejectionReason,
  sohuManagementTimestampMatches,
} from "./playwright-sohu-publication.js";

function emptyLocator(): PlaywrightPublicationLocator {
  const locator: PlaywrightPublicationLocator = {
    count: async () => 0,
    nth: () => locator,
    first: () => locator,
    isVisible: async () => false,
    fill: async () => undefined,
    textContent: async () => null,
    click: async () => undefined,
  };
  return locator;
}

function pageAt(url: string): PlaywrightPublicationPage {
  return {
    url: () => url,
    locator: () => emptyLocator(),
    bringToFront: async () => undefined,
  };
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
    fill: async () => undefined,
    inputValue: async () => value,
    innerText: async () => value,
    textContent: async () => value,
    getAttribute: async (name) => attributes[name] ?? null,
    click: async () => undefined,
  };
}

function managementPage(input: {
  readonly definition: PlatformPublicationDefinition;
  readonly url: string;
  readonly title: string;
  readonly timestamp: string;
  readonly itemUrl: string;
  readonly status?: string;
  readonly rejectionReason?: string;
  readonly evaluateResult?: readonly SohuRejectedManagementRecord[];
}): PlaywrightPublicationPage {
  const surface = input.definition.creatorManagementSurface;
  if (surface === undefined) throw new TypeError("management surface required");
  const row: PlaywrightPublicationLocator = {
    count: async () => 1,
    nth: () => row,
    first: () => row,
    locator: (selector) => {
      if (selector === surface.titleLinkSelector) {
        return valueLocator(input.title, { href: input.itemUrl });
      }
      if (selector === surface.timestampSelector) return valueLocator(input.timestamp);
      if (selector === surface.statusSelector) return valueLocator(input.status ?? "");
      return emptyLocator();
    },
    isVisible: async () => true,
    fill: async () => undefined,
    textContent: async () =>
      [input.title, input.timestamp, input.status, input.rejectionReason]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" "),
    click: async () => undefined,
  };
  const page: PlaywrightPublicationPage = {
    url: () => input.url,
    locator: (selector) => (selector === surface.itemSelector ? row : emptyLocator()),
    bringToFront: async () => undefined,
    goto: async () => null,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
  if (input.evaluateResult !== undefined) {
    page.evaluate = async <Result, Argument>(
      pageFunction: (argument: Argument) => Result,
      argument: Argument,
    ) => {
      void pageFunction;
      void argument;
      return input.evaluateResult as Result;
    };
  }
  return page;
}

function publicPage(input: {
  readonly definition: PlatformPublicationDefinition;
  readonly url: string;
  readonly accountName: string;
  readonly title: string;
  readonly body: string;
}): PlaywrightPublicationPage {
  const valuesFor = (selector: string): string | null => {
    if (selector === input.definition.publicSurface.authorSelectors[0]) return input.accountName;
    if (selector === input.definition.publicSurface.titleSelectors[0]) return input.title;
    if (selector === input.definition.publicSurface.bodySelectors[0]) return input.body;
    return null;
  };
  const locatorFor = (selector: string): PlaywrightPublicationLocator => {
    const value = valuesFor(selector);
    return value === null ? emptyLocator() : valueLocator(value);
  };
  return {
    url: () => input.url,
    locator: locatorFor,
    bringToFront: async () => undefined,
    waitForLoadState: async () => undefined,
    close: async () => undefined,
  };
}

const expectedAccountName = "测试旅行账号";
const expectedTitle = "暑期家庭出行的三个准备重点";
const expectedBody = "先确认预算和日期，再安排交通与每日节奏。";
const submittedAt = "2026-08-10T08:20:00.000Z";

describe("Sohu browser publication contract", () => {
  it("pins the current fixed editor and reviewed upstream source", () => {
    expect(SOHU_ARTICLE_EDITOR_URL).toBe(
      "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1",
    );
    expect(SOHU_PUBLICATION_DEFINITION).toMatchObject({
      platform: "sohu",
      adapterVersion: "sohu-browser-publication-v2",
      submissionMode: "direct_with_optional_confirm",
      source: {
        repositoryUrl: "https://github.com/leaperone/MultiPost-Extension",
        commitSha: "4d9714a1f9132eadc7071b3977e9b4acf76d7c28",
        licenseSpdx: "Apache-2.0",
      },
    });
    expect(SOHU_PUBLICATION_DEFINITION.titleSelectors).toContain(".publish-title input");
    expect(SOHU_PUBLICATION_DEFINITION.bodySelectors).toContain(
      '.ql-editor[contenteditable="true"]',
    );
    expect(SOHU_PUBLICATION_DEFINITION.creatorManagementSurface).toMatchObject({
      url: SOHU_CONTENT_MANAGER_URL,
      canonicalPublicLinkConfirmsPublished: true,
    });
  });

  it("recovers a unique published candidate from the creator list before anonymous readback", async () => {
    const publicUrl = "https://www.sohu.com/a/1058220115_100136517";
    const management = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "2026-08-10 16:20",
      itemUrl: `${publicUrl}?sec=wd`,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async (url) => (url === SOHU_CONTENT_MANAGER_URL ? management : pageAt(url)),
      openIndependentPublicPage: async () =>
        publicPage({
          definition: SOHU_PUBLICATION_DEFINITION,
          url: publicUrl,
          accountName: expectedAccountName,
          title: expectedTitle,
          body: expectedBody,
        }),
      confirmationMode: "public_readback",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1058220115_100136517",
      externalUrl: publicUrl,
    });
    expect(canonicalizeSohuManagementItemUrl(`${publicUrl}?sec=wd`)).toEqual({
      id: "1058220115_100136517",
      url: publicUrl,
    });
    expect(sohuManagementTimestampMatches("2026-08-10 16:20", submittedAt)).toBe(true);
  });

  it("tries every matching management tab when a stale duplicate remains open", async () => {
    const publicUrl = "https://www.sohu.com/a/1058220115_100136517";
    const stale = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: "旧页面没有本次标题",
      timestamp: "2026-08-10 15:00",
      itemUrl: "https://www.sohu.com/a/1058000000_100136517",
    });
    const current = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "2026-08-10 16:20",
      itemUrl: publicUrl,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [current, stale],
      openCreatorPage: async () => {
        throw new Error("an existing management tab should be reused");
      },
      openIndependentPublicPage: async () =>
        publicPage({
          definition: SOHU_PUBLICATION_DEFINITION,
          url: publicUrl,
          accountName: expectedAccountName,
          title: expectedTitle,
          body: expectedBody,
        }),
      confirmationMode: "public_readback",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalUrl: publicUrl,
    });
  });

  it("returns a stable publisher rejection when Sohu marks the exact submitted article as advertorial", async () => {
    const management = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "2026-08-10 16:20",
      itemUrl:
        "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlepreview?id=1061663893&accountId=122943573",
      status: "未通过",
      rejectionReason: "文章被平台判定为广告软文，具体原因请查看系统消息",
    });
    const openIndependentPublicPage = async (): Promise<PlaywrightPublicationPage> => {
      throw new Error("a rejected creator-management row must not open public readback");
    };
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage,
      confirmationMode: "publisher_status",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      externalId: null,
      externalUrl: null,
      observedTitle: expectedTitle,
      signal: "creator-management-rejected-soft-advertorial",
    });
  });

  it("uses the authenticated Sohu rejection response when the row hides the reason", async () => {
    const management = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "2026-08-10 16:20",
      itemUrl:
        "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlepreview?id=1061663893&accountId=122943573",
      status: "未通过",
      evaluateResult: [
        {
          title: expectedTitle,
          status: 3,
          id: "1061663893",
          userId: "122943573",
          rejectReason: "文章被平台判定为广告软文，具体原因请查看系统消息",
        },
      ],
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => {
        throw new Error("a rejected creator-management row must not open public readback");
      },
      confirmationMode: "publisher_status",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
    });
  });

  it("classifies an auditMessage returned by the rejected-content endpoint", async () => {
    const records = extractSohuRejectedManagementRecords({
      data: {
        news: [
          {
            title: expectedTitle,
            status: 3,
            id: "1061663893",
            userId: "122943573",
            auditMessage: "文章被平台判定为广告软文，请修改后重新提交",
          },
        ],
      },
    });
    expect(
      selectSohuRejectionReason({
        expectedTitle,
        itemUrls: [
          "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlepreview?id=1061663893&accountId=122943573",
        ],
        records,
      }),
    ).toContain("广告软文");
    const management = managementPage({
      definition: SOHU_PUBLICATION_DEFINITION,
      url: SOHU_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "2026-08-10 16:20",
      itemUrl:
        "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlepreview?id=1061663893&accountId=122943573",
      status: "未通过",
      evaluateResult: records,
    });
    const adapter = createPlaywrightSohuPublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => {
        throw new Error("a rejected creator-management row must not open public readback");
      },
      confirmationMode: "publisher_status",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
    });
  });

  it("does not bind an ambiguous duplicate-title rejection to the handoff", () => {
    expect(
      selectSohuRejectionReason({
        expectedTitle,
        itemUrls: [],
        records: [
          {
            title: expectedTitle,
            status: 3,
            id: "1061663893",
            userId: "122943573",
            rejectReason: "广告软文",
          },
          {
            title: expectedTitle,
            status: 3,
            id: "1061663894",
            userId: "122943573",
            rejectReason: "标题不符合规范",
          },
        ],
      }),
    ).toBeNull();
  });

  it("canonicalizes only the official public article host and composite identity", () => {
    expect(
      canonicalizeSohuPublicUrl(
        "https://www.sohu.com/a/1058220115_100136517?sec=wd&utm_source=canary",
      ),
    ).toEqual({
      id: "1058220115_100136517",
      url: "https://www.sohu.com/a/1058220115_100136517",
    });
    expect(
      canonicalizeSohuPublicUrl("https://www.sohu.com.attacker.example/a/1058220115_100136517"),
    ).toBeNull();
    expect(canonicalizeSohuPublicUrl("http://www.sohu.com/a/1058220115_100136517")).toBeNull();
    expect(canonicalizeSohuPublicUrl("https://www.sohu.com/a/1058220115")).toBeNull();
  });

  it("creates a public candidate only after status 4 supplies article and account ids", () => {
    expect(classifySohuModerationRecord({ status: 2, id: 1058220115, userId: 100136517 })).toEqual({
      state: "pending",
      platformStatus: 2,
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(classifySohuModerationRecord({ status: 4, id: 1058220115, userId: 100136517 })).toEqual({
      state: "published",
      platformStatus: 4,
      candidateExternalId: "1058220115_100136517",
      candidateExternalUrl: "https://www.sohu.com/a/1058220115_100136517",
    });
    expect(classifySohuModerationRecord({ status: 4, id: "bad", userId: 100136517 })).toEqual({
      state: "unknown",
      platformStatus: 4,
      candidateExternalId: null,
      candidateExternalUrl: null,
    });
    expect(
      classifySohuModerationRecord({ status: 3, id: 1058220115, userId: 100136517 }),
    ).toMatchObject({ state: "rejected", candidateExternalUrl: null });
  });
});

describe("Netease browser publication contract", () => {
  it("pins the hash-routed editor and Draft.js source", () => {
    expect(NETEASE_ARTICLE_EDITOR_URL).toBe("https://mp.163.com/#/article-publish");
    expect(NETEASE_PUBLICATION_DEFINITION).toMatchObject({
      platform: "netease",
      adapterVersion: "netease-browser-publication-v2",
      submissionMode: "direct_with_optional_confirm",
      source: {
        repositoryUrl: "https://github.com/RyanYipeng/SyncCaster",
        commitSha: "ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe",
        licenseSpdx: "MIT",
      },
    });
    expect(NETEASE_PUBLICATION_DEFINITION.bodySelectors).toContain(
      '.public-DraftEditor-content[contenteditable="true"]',
    );
    expect(NETEASE_PUBLICATION_DEFINITION.creatorManagementSurface).toMatchObject({
      url: NETEASE_CONTENT_MANAGER_URL,
      canonicalPublicLinkConfirmsPublished: true,
    });
    expect(NETEASE_PUBLICATION_DEFINITION.finalActionSelectors?.[0]).toContain('[role="dialog"]');
  });

  it("recovers the published creator-card link and verifies the anonymous article", async () => {
    const publicUrl = "https://www.163.com/dy/article/DEMO000000000001.html";
    const management = managementPage({
      definition: NETEASE_PUBLICATION_DEFINITION,
      url: NETEASE_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "创建于16:20",
      itemUrl: "//www.163.com/dy/article/DEMO000000000001.html",
    });
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [],
      openCreatorPage: async (url) =>
        url === NETEASE_CONTENT_MANAGER_URL ? management : pageAt(url),
      openIndependentPublicPage: async () =>
        publicPage({
          definition: NETEASE_PUBLICATION_DEFINITION,
          url: publicUrl,
          accountName: expectedAccountName,
          title: expectedTitle,
          body: expectedBody,
        }),
      confirmationMode: "public_readback",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "DEMO000000000001",
      externalUrl: publicUrl,
    });
    expect(
      canonicalizeNeteaseManagementItemUrl("//www.163.com/dy/article/DEMO000000000001.html"),
    ).toEqual({ id: "DEMO000000000001", url: publicUrl });
    expect(
      neteaseManagementTimestampMatches(
        "创建于16:20",
        submittedAt,
        new Date("2026-08-10T08:21:00.000Z"),
      ),
    ).toBe(true);
  });

  it("reports a Netease creator-management rejection before public readback", async () => {
    const management = managementPage({
      definition: NETEASE_PUBLICATION_DEFINITION,
      url: NETEASE_CONTENT_MANAGER_URL,
      title: expectedTitle,
      timestamp: "创建于16:20",
      itemUrl: "#/content-manage",
      status: "审核未通过",
      rejectionReason: "文章被平台判定为广告软文",
    });
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [],
      openCreatorPage: async () => management,
      openIndependentPublicPage: async () => {
        throw new Error("rejected content must not open public readback");
      },
      confirmationMode: "publisher_status",
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: null,
        candidateExternalUrl: null,
        expectedAccountName,
        expectedTitle,
        expectedBody,
        submittedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      signal: "creator-management-rejected-soft-advertorial",
    });
  });

  it("matches the current public article author link and article-only body", async () => {
    const publicUrl = "https://www.163.com/dy/article/DEMO000000000001.html";
    const values = new Map<string, string>([
      ["h1.post_title", expectedTitle],
      [".post_body", expectedBody],
      ['.post_info > a[href*="/dy/media/"]', expectedAccountName],
    ]);
    const page: PlaywrightPublicationPage = {
      url: () => publicUrl,
      locator: (selector) => {
        const value = values.get(selector);
        return value === undefined ? emptyLocator() : valueLocator(value);
      },
      bringToFront: async () => undefined,
      waitForLoadState: async () => undefined,
      close: async () => undefined,
    };
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => page,
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "DEMO000000000001",
        candidateExternalUrl: publicUrl,
        expectedAccountName,
        expectedTitle,
        expectedBody,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "DEMO000000000001",
      externalUrl: publicUrl,
    });
  });

  it("matches the captured NetEase public renderer after it removes editor block whitespace", async () => {
    const publicUrl = "https://www.163.com/dy/article/DEMO000000000005.html";
    const expectedMarkdown = [
      "## 先想清楚一个问题：爸妈最怕的是折腾还是花钱",
      "",
      "带父母出门，先看体力，再看预算。",
      "",
      "## 直飞到底省在哪儿",
      "",
      "直飞最大的好处是少折腾。",
    ].join("\n");
    const page = publicPage({
      definition: NETEASE_PUBLICATION_DEFINITION,
      url: publicUrl,
      accountName: "人间饭香",
      title: "青岛带爸妈去台湾，直飞还是转机划算",
      body: "先想清楚一个问题：爸妈最怕的是折腾还是花钱带父母出门，先看体力，再看预算。直飞到底省在哪儿直飞最大的好处是少折腾。",
    });
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [],
      openIndependentPublicPage: async () => page,
      readbackAttempts: 1,
      pollMs: 0,
    });

    await expect(
      adapter.readback({
        candidateExternalId: "DEMO000000000005",
        candidateExternalUrl: publicUrl,
        expectedAccountName: "人间饭香",
        expectedTitle: "青岛带爸妈去台湾，直飞还是转机划算",
        expectedBody: expectedMarkdown,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "DEMO000000000005",
      externalUrl: publicUrl,
    });
  });

  it("recognizes the fixed hash route as an editor page", async () => {
    const editorPage = pageAt(NETEASE_ARTICLE_EDITOR_URL);
    const adapter = createPlaywrightNeteasePublicationAdapter({
      pages: () => [editorPage],
      openIndependentPublicPage: async () => {
        throw new Error("not used");
      },
    });

    await expect(adapter.inspectPrepared()).resolves.toMatchObject({
      status: "adapter_drift",
      platform: "netease",
      targetPageCount: 1,
    });
  });

  it("canonicalizes the current official public article URL", () => {
    expect(
      canonicalizeNeteasePublicUrl(
        "https://www.163.com/dy/article/DEMO000000000001.html?clickfrom=canary",
      ),
    ).toEqual({
      id: "DEMO000000000001",
      url: "https://www.163.com/dy/article/DEMO000000000001.html",
    });
    expect(
      canonicalizeNeteasePublicUrl(
        "https://www.163.com.attacker.example/dy/article/DEMO000000000001.html",
      ),
    ).toBeNull();
    expect(
      canonicalizeNeteasePublicUrl("https://dy.163.com/v2/article/detail/DEMO000000000001.html"),
    ).toBeNull();
  });

  it("creates a public candidate only for a published article record", () => {
    expect(
      classifyNeteaseModerationRecord({
        contentState: 3,
        contentType: 1,
        articleId: "DEMO000000000001",
      }),
    ).toEqual({
      state: "published",
      platformStatus: 3,
      candidateExternalId: "DEMO000000000001",
      candidateExternalUrl: "https://www.163.com/dy/article/DEMO000000000001.html",
    });
    expect(
      classifyNeteaseModerationRecord({
        contentState: 2,
        contentType: 1,
        articleId: "DEMO000000000001",
      }),
    ).toMatchObject({ state: "pending_or_unpublished", candidateExternalUrl: null });
    expect(
      classifyNeteaseModerationRecord({
        contentState: 3,
        contentType: 2,
        articleId: "DEMO000000000001",
      }),
    ).toMatchObject({ state: "pending_or_unpublished", candidateExternalUrl: null });
  });
});
