import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import {
  GeoApiError,
  type AutomationSnapshot,
  type ChannelAccount,
  type CtripPlatformAnalyticsDashboard,
  type PriorityPlatformAnalyticsDashboard,
  type PublicationJob,
} from "./api.js";
import { ChannelAccountDirectory } from "./channel-account-directory.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const accounts = [
  {
    id: "account-toutiao",
    platform: "ctrip_community",
    displayName: "中通携程账号一",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["ticket:GEO-1"],
    status: "active",
    lastVerifiedAt: "2026-07-15T00:00:00.000Z",
    dailyPublishQuota: 10,
  },
  {
    id: "account-sohu",
    platform: "ctrip_community",
    displayName: "中通携程账号二",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "preview",
    evidenceRefs: [],
    status: "active",
    lastVerifiedAt: null,
  },
  {
    id: "account-ctrip",
    platform: "ctrip_community",
    displayName: "中通携程社区",
    capability: "browser_assisted",
    supportedExecutionLevels: ["dry_run", "assisted"],
    evidenceType: "api_response",
    evidenceRefs: [],
    status: "active",
    lastVerifiedAt: "2026-07-15T00:00:00.000Z",
  },
] as const satisfies readonly ChannelAccount[];

const ctripAnalytics = {
  platform: "ctrip_community",
  accountCount: 1,
  reportingAccountCount: 1,
  totals: {
    publishCount: 6,
    featuredCount: 2,
    qualityCount: 3,
    contentHeat: 0.81,
    views: 12_213,
    viewers: 9_172,
    likes: 12,
    favorites: 4,
    comments: 0,
    interactions: 40,
    interactors: 30,
  },
  accounts: [
    {
      channelAccountId: "account-ctrip",
      displayName: "中通携程社区",
      dataStatus: "ready",
      reportPeriod: "2026-07-01 至 2026-07-31",
      publishCount: 6,
      featuredCount: 2,
      qualityCount: 3,
      featuredQualityRate: 83.3,
      contentHeat: 0.81,
      totalViews: 12_213,
      totalViewers: 9_172,
      totalLikes: 12,
      totalFavorites: 4,
      totalComments: 0,
      totalInteractions: 40,
      totalInteractors: 30,
      trafficSources: { 推荐: 60, 搜索: 30, 其他: 10 },
      works: [
        {
          title: "青岛亲子七日慢游",
          publishedAt: "2026-07-20 10:00",
          views: 148,
          viewers: 120,
          interactions: 8,
          interactors: 7,
        },
      ],
      observedAt: "2026-07-31T04:35:00.000Z",
      nextRefreshAt: "2026-07-31T05:35:00.000Z",
      lastAttemptedAt: "2026-07-31T04:35:00.000Z",
      lastSucceededAt: "2026-07-31T04:35:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  ],
} as const satisfies CtripPlatformAnalyticsDashboard;

const toutiaoAnalytics = {
  scope: "priority_platforms",
  accountCount: 1,
  reportingAccountCount: 1,
  totals: { publishCount: 1, impressions: 120, reads: 8, likes: 2, comments: 1 },
  accounts: [
    {
      channelAccountId: "account-toutiao-live",
      platform: "toutiao",
      displayName: "示例内容账号",
      dataStatus: "ready",
      reportPeriod: "内容管理最近 1 条",
      publishCount: 1,
      totalImpressions: 120,
      totalReads: 8,
      totalLikes: 2,
      totalComments: 1,
      works: [
        {
          externalId: "1234567890123456788",
          externalUrl: "https://www.toutiao.com/article/1234567890123456788/",
          title: "老人腿脚慢，青岛出境团适合吗",
          publishedAt: "08-05 02:46",
          status: "已发布",
          impressions: 120,
          reads: 8,
          likes: 2,
          comments: 1,
        },
      ],
      observedAt: "2026-08-05T03:00:00.000Z",
      nextRefreshAt: "2026-08-05T04:00:00.000Z",
      lastAttemptedAt: "2026-08-05T03:00:00.000Z",
      lastSucceededAt: "2026-08-05T03:00:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  ],
} as const satisfies PriorityPlatformAnalyticsDashboard;

function renderDirectory(overrides: Partial<ComponentProps<typeof ChannelAccountDirectory>> = {}) {
  return render(
    <ChannelAccountDirectory
      accounts={accounts}
      demo={false}
      canManage
      onCreate={vi.fn(async () => accounts[2])}
      onUpdate={vi.fn(async () => undefined)}
      {...overrides}
    />,
  );
}

function runtimeOf(account: ChannelAccount): NonNullable<ChannelAccount["ctripRuntime"]> {
  if (account.ctripRuntime === undefined) throw new Error("test account runtime is required");
  return account.ctripRuntime;
}

describe("ChannelAccountDirectory", () => {
  it("uses local official platform icons in the platform directory", () => {
    const { container } = renderDirectory();

    for (const platform of ["toutiao", "sohu", "baijiahao", "netease", "ctrip"]) {
      expect(container.querySelector(`img[src="/platforms/${platform}.ico"]`)).not.toBeNull();
    }
  });

  it("shows quick verification when an active publication handoff is challenged after runtime recovery", () => {
    const authenticatedSohuAccount: ChannelAccount = {
      ...accounts[2],
      id: "account-sohu-challenged-handoff",
      platform: "sohu",
      displayName: "搜狐测试账号",
      ctripRuntime: {
        id: "runtime-sohu-challenged-handoff",
        channelAccountId: "account-sohu-challenged-handoff",
        sessionState: "authenticated",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-08-11T12:45:00.000Z",
        lastReadyAt: "2026-08-11T12:45:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-11T12:45:00.000Z",
      },
    };

    renderDirectory({
      accounts: [authenticatedSohuAccount],
      onOpenVerification: vi.fn(),
      publicationVerificationAccountIds: new Set([authenticatedSohuAccount.id]),
    });

    expect(screen.getByRole("button", { name: "快速验证 搜狐测试账号" })).toBeInTheDocument();
    expect(screen.getByText("需人工验证")).toBeInTheDocument();
  });

  it("shows a visible verification action and reuses the protected login handoff", async () => {
    const challengedAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "challenge_required",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-08-07T01:00:00.000Z",
        lastReadyAt: null,
        lastErrorCode: "SECURITY_CHALLENGE_REQUIRED",
        lastErrorMessage: "需要人工安全验证",
        updatedAt: "2026-08-07T01:00:00.000Z",
      },
    };
    const onOpenVerification = vi.fn(async () => ({
      loginUrl:
        "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
    }));
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace },
      closed: false,
      close: vi.fn(),
    } as unknown as Window);

    renderDirectory({ accounts: [challengedAccount], onOpenVerification });

    fireEvent.click(screen.getByRole("button", { name: "快速验证 中通携程社区" }));

    await waitFor(() => expect(onOpenVerification).toHaveBeenCalledWith(challengedAccount.id));
    expect(window.open).toHaveBeenCalledWith("", "geo-account-login-account-ctrip");
    const handoffUrl = new URL(String(replace.mock.calls[0]?.[0]));
    expect(handoffUrl.pathname).toBe("/account-login");
    expect(handoffUrl.searchParams.get("channelAccountId")).toBe(challengedAccount.id);
  });

  it("reports a blocked verification popup instead of claiming that it opened", async () => {
    const challengedAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "challenge_required",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-08-07T01:00:00.000Z",
        lastReadyAt: null,
        lastErrorCode: "SECURITY_CHALLENGE_REQUIRED",
        lastErrorMessage: "需要人工安全验证",
        updatedAt: "2026-08-07T01:00:00.000Z",
      },
    };
    const onOpenVerification = vi.fn(async () => ({
      loginUrl:
        "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
    }));
    vi.spyOn(window, "open").mockReturnValue(null);

    renderDirectory({ accounts: [challengedAccount], onOpenVerification });

    fireEvent.click(screen.getByRole("button", { name: "快速验证 中通携程社区" }));

    await waitFor(() => expect(onOpenVerification).toHaveBeenCalledWith(challengedAccount.id));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "浏览器阻止了账号验证窗口，请允许本站弹出窗口后重试",
    );
    expect(screen.queryByText(/验证窗口已打开/u)).not.toBeInTheDocument();
  });

  it("keeps the compact relogin action for a ready account", () => {
    const readyAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "ready",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-08-07T01:00:00.000Z",
        lastReadyAt: "2026-08-07T01:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-07T01:00:00.000Z",
      },
    };

    renderDirectory({ accounts: [readyAccount], onOpenLogin: vi.fn() });

    expect(screen.getByRole("button", { name: "重新登录 中通携程社区" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "快速验证 中通携程社区" })).not.toBeInTheDocument();
  });

  it("shows native Toutiao work counters and status in the account analytics dialog", async () => {
    const toutiaoAccount = {
      ...accounts[0],
      id: "account-toutiao-live",
      platform: "toutiao" as const,
      displayName: "示例内容账号",
      capability: "browser_assisted" as const,
      supportedExecutionLevels: ["assisted" as const],
      evidenceType: "manual_import" as const,
      ctripRuntime: {
        id: "runtime-toutiao-live",
        channelAccountId: "account-toutiao-live",
        sessionState: "ready" as const,
        bridgePrincipalId: null,
        lastCheckedAt: "2026-08-05T03:00:00.000Z",
        lastReadyAt: "2026-08-05T03:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-05T03:00:00.000Z",
      },
    } satisfies ChannelAccount;
    renderDirectory({
      accounts: [toutiaoAccount],
      priorityAnalytics: toutiaoAnalytics,
      priorityAnalyticsStatus: "ready",
    });

    expect(screen.getAllByText("120 展现").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8 阅读").length).toBeGreaterThan(0);
    const open = screen.getByRole("button", { name: "查看流量分析 示例内容账号" });
    await act(async () => {
      fireEvent.click(open);
    });
    expect(screen.getByText("老人腿脚慢，青岛出境团适合吗")).toBeTruthy();
    expect(screen.getByText("已发布")).toBeTruthy();
    expect(screen.getByText("08-05 02:46")).toBeTruthy();
    expect(screen.getAllByText("120").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("renders a Baijiahao security challenge as manual verification instead of a collector failure", async () => {
    const baijiahaoAccount = {
      ...accounts[0],
      id: "account-baijiahao-live",
      platform: "baijiahao" as const,
      displayName: "百家号运营账号",
      capability: "browser_assisted" as const,
      supportedExecutionLevels: ["assisted" as const],
      evidenceType: "manual_import" as const,
    } satisfies ChannelAccount;
    const challengeAnalytics = {
      scope: "priority_platforms" as const,
      accountCount: 1,
      reportingAccountCount: 0,
      totals: { publishCount: 0, impressions: 0, reads: 0, likes: 0, comments: 0 },
      accounts: [
        {
          channelAccountId: "account-baijiahao-live",
          platform: "baijiahao" as const,
          displayName: "百家号运营账号",
          dataStatus: "pending" as const,
          reportPeriod: null,
          publishCount: null,
          totalImpressions: null,
          totalReads: null,
          totalLikes: null,
          totalComments: null,
          works: [],
          observedAt: null,
          nextRefreshAt: "2026-08-07T04:00:00.000Z",
          lastAttemptedAt: "2026-08-07T03:00:00.000Z",
          lastSucceededAt: null,
          lastErrorCode: "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED",
          lastErrorMessage: "人工完成百家号滑块或扫码验证后可重新采集",
        },
      ],
    } satisfies PriorityPlatformAnalyticsDashboard;
    renderDirectory({
      accounts: [baijiahaoAccount],
      priorityAnalytics: challengeAnalytics,
      priorityAnalyticsStatus: "ready",
    });

    expect(screen.getAllByText("需人工验证")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看流量分析 百家号运营账号" }));
    const dialog = screen.getByRole("dialog", { name: "百家号运营账号" });
    expect(dialog).toHaveTextContent("需人工完成平台验证，验证后可重新采集");
    expect(dialog).toHaveTextContent(
      "已停止自动采集，请在账号登录窗口完成滑块或扫码验证后重新采集。",
    );
  });

  it("does not count provisioned dry-run placeholders as real platform accounts", () => {
    renderDirectory({
      accounts: [
        {
          ...accounts[0],
          displayName: "示例旅服-头条号-Dry Run",
          evidenceType: "preview",
          evidenceRefs: ["seed:dry-run-only"],
          lastVerifiedAt: null,
        },
        {
          ...accounts[1],
          displayName: "示例国际旅行服务 / Sohu / Dry Run",
          evidenceType: "preview",
          evidenceRefs: ["tenant-provisioning:manual-only-dry-run"],
        },
        accounts[2],
      ],
    });

    expect(screen.getByText("跨 1 个平台")).toBeInTheDocument();
    expect(screen.getByText("显示 1 / 1 个账号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接入 头条号 账号" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "接入 搜狐号 账号" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "接入 百家号 账号" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "接入 网易号 账号" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "接入 携程社区 账号" })).toBeEnabled();
    expect(screen.queryByText("示例旅服-头条号-Dry Run")).not.toBeInTheDocument();
    expect(screen.queryByText("示例国际旅行服务 / Sohu / Dry Run")).not.toBeInTheDocument();
  });

  it("summarizes multiple supported accounts and filters the account table", () => {
    renderDirectory();

    expect(screen.getByText("跨 1 个平台")).toBeInTheDocument();
    expect(screen.getByText("显示 3 / 3 个账号")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索平台账号" }), {
      target: { value: "账号二" },
    });
    expect(screen.getByText("显示 1 / 3 个账号")).toBeInTheDocument();
    expect(screen.getByText("中通携程账号二")).toBeInTheDocument();
    expect(screen.queryByText("中通携程账号一")).not.toBeInTheDocument();
  });

  it("shows one all-platform dashboard with comparable basic metrics", () => {
    renderDirectory({
      analytics: ctripAnalytics,
      analyticsStatus: "ready",
      priorityAnalytics: toutiaoAnalytics,
      priorityAnalyticsStatus: "ready",
    });

    const dashboard = screen.getByRole("region", { name: "全平台运营概览" });
    expect(dashboard).toHaveTextContent("2 / 2 个账号已更新");
    expect(dashboard.querySelector(".account-analytics-metrics")).toHaveTextContent(
      "发布7展现120阅读1.2万收藏4点赞14评论1",
    );
    expect(screen.queryByRole("region", { name: "携程运营大屏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "优先平台运营大屏" })).not.toBeInTheDocument();
    expect(dashboard).not.toHaveTextContent("内容热度");
    expect(dashboard).not.toHaveTextContent("精选");
    expect(dashboard).not.toHaveTextContent("优质");
    expect(dashboard).not.toHaveTextContent("流量来源");
    expect(screen.getByText("1.2万")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看流量分析 中通携程社区" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "查看流量分析 中通携程社区" }));
    const dialog = screen.getByRole("dialog", { name: "中通携程社区" });
    expect(dialog).toHaveTextContent("精优率83.3%");
    expect(dialog).toHaveTextContent("内容热度0.81");
    expect(screen.getByRole("tab", { name: "内容概况" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "单条分析" }));
    expect(dialog).toHaveTextContent("青岛亲子七日慢游");
    expect(dialog).toHaveTextContent("148");
  });

  it("shows historical false-zero analytics as platform data pending", () => {
    const pendingAnalytics = {
      ...ctripAnalytics,
      reportingAccountCount: 0,
      totals: {
        publishCount: 0,
        featuredCount: 0,
        qualityCount: 0,
        contentHeat: 0,
        views: 0,
        viewers: 0,
        likes: 0,
        favorites: 0,
        comments: 0,
        interactions: 0,
        interactors: 0,
      },
      accounts: [
        {
          ...ctripAnalytics.accounts[0],
          dataStatus: "pending",
          publishCount: null,
          featuredCount: null,
          qualityCount: null,
          featuredQualityRate: null,
          contentHeat: null,
          totalViews: null,
          totalViewers: null,
          totalLikes: null,
          totalFavorites: null,
          totalComments: null,
          totalInteractions: null,
          totalInteractors: null,
          trafficSources: {},
          works: [
            {
              title: "平台尚未出数的作品",
              publishedAt: "2026-08-01 10:00",
              views: 0,
              viewers: 0,
              interactions: 0,
              interactors: 0,
            },
          ],
        },
      ],
    } as const satisfies CtripPlatformAnalyticsDashboard;

    renderDirectory({ analytics: pendingAnalytics, analyticsStatus: "ready" });

    const dashboard = screen.getByRole("region", { name: "全平台运营概览" });
    expect(dashboard).toHaveTextContent("0 / 1 个账号已更新");
    expect(screen.getAllByText("平台待出数")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "查看流量分析 中通携程社区" }));
    const dialog = screen.getByRole("dialog", { name: "中通携程社区" });
    expect(dialog).toHaveTextContent("平台待出数");
    expect(dialog).not.toHaveTextContent("发布数0");
    fireEvent.click(screen.getByRole("tab", { name: "单条分析" }));
    expect(dialog).toHaveTextContent("平台尚未出数的作品");
    expect(dialog).toHaveTextContent("--");
  });

  it("keeps account management disabled without tenant governance permission", () => {
    renderDirectory({ canManage: false });

    expect(screen.getByRole("button", { name: "新增平台账号" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "管理 中通携程账号一" })).toBeDisabled();
  });

  it("saves an edited daily publishing quota from the account directory", async () => {
    const onUpdate = vi.fn(async () => undefined);
    renderDirectory({ onUpdate });

    fireEvent.click(screen.getByRole("button", { name: "管理 中通携程账号一" }));
    expect(screen.getByLabelText("每日发布配额")).toHaveValue(10);
    fireEvent.change(screen.getByLabelText("每日发布配额"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("平台账号变更原因"), {
      target: { value: "提升该账号每日投放额度" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        accounts[0].id,
        expect.objectContaining({ dailyPublishQuota: 25 }),
      ),
    );
  });

  it("preselects and submits the platform when connecting from its platform card", async () => {
    type CreateInput = Parameters<ComponentProps<typeof ChannelAccountDirectory>["onCreate"]>[0];
    const onCreate = vi.fn(async (input: CreateInput) => ({
      ...accounts[2],
      displayName: input.displayName,
    }));
    renderDirectory({ onCreate });

    fireEvent.click(screen.getByRole("button", { name: "接入 携程社区 账号" }));

    expect(screen.getByRole("dialog", { name: "接入平台账号" })).toBeInTheDocument();
    expect(screen.getByLabelText("平台")).toHaveValue("ctrip_community");
    fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "中通携程运营号" } });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      platform: "ctrip_community",
      displayName: "中通携程运营号",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });
  });

  it("opens the real Ctrip login page immediately after creating an account", async () => {
    const createdAccount: ChannelAccount = {
      ...accounts[2],
      id: "account-ctrip-new",
      displayName: "携程新运营号",
      status: "active",
      lastVerifiedAt: null,
      ctripRuntime: {
        id: "runtime-ctrip-new",
        channelAccountId: "account-ctrip-new",
        sessionState: "session_required",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: null,
        lastReadyAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const onCreate = vi.fn(async () => createdAccount);
    const onOpenLogin = vi.fn(async () => ({
      loginUrl:
        "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip-new&path=websockify%2Faccounts%2Faccount-ctrip-new",
    }));
    const replace = vi.fn();
    const popup = { opener: window, location: { replace } } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    renderDirectory({ onCreate, onOpenLogin });

    fireEvent.click(screen.getByRole("button", { name: "接入 携程社区 账号" }));
    fireEvent.change(screen.getByLabelText("账号名称"), {
      target: { value: createdAccount.displayName },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onOpenLogin).toHaveBeenCalledWith(createdAccount.id));
    expect(open).toHaveBeenCalledWith("", "_blank");
    const handoffUrl = new URL(String(replace.mock.calls[0]?.[0]));
    expect(handoffUrl.pathname).toBe("/account-login");
    expect(handoffUrl.searchParams.get("channelAccountId")).toBe("account-ctrip-new");
    expect(handoffUrl.searchParams.get("loginUrl")).toBe(
      "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip-new&path=websockify%2Faccounts%2Faccount-ctrip-new",
    );
  });

  it("keeps the login window open when status polling detects a ready session", async () => {
    vi.useFakeTimers();
    try {
      const sessionAccount: ChannelAccount = {
        ...accounts[2],
        ctripRuntime: {
          id: "runtime-ctrip",
          channelAccountId: accounts[2].id,
          sessionState: "session_required",
          bridgePrincipalId: "bridge-principal",
          lastCheckedAt: null,
          lastReadyAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
      const readyAccount: ChannelAccount = {
        ...sessionAccount,
        ctripRuntime: {
          ...runtimeOf(sessionAccount),
          sessionState: "ready",
          lastCheckedAt: "2026-07-15T00:00:02.000Z",
          lastReadyAt: "2026-07-15T00:00:02.000Z",
        },
      };
      let loginStarted = false;
      const onOpenLogin = vi.fn(async () => {
        loginStarted = true;
        return {
          loginUrl:
            "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
        };
      });
      const onRefreshStatus = vi.fn(async () => (loginStarted ? readyAccount : sessionAccount));
      const onChanged = vi.fn();
      const replace = vi.fn();
      let closed = false;
      const close = vi.fn(() => {
        closed = true;
      });
      const popup = {
        opener: window,
        location: { replace },
        get closed() {
          return closed;
        },
        close,
      } as unknown as Window;
      vi.spyOn(window, "open").mockReturnValue(popup);
      renderDirectory({ accounts: [sessionAccount], onOpenLogin, onRefreshStatus, onChanged });

      fireEvent.click(screen.getByRole("button", { name: "补登录 中通携程社区" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onOpenLogin).toHaveBeenCalledWith(sessionAccount.id);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(onRefreshStatus).toHaveBeenCalledWith(sessionAccount.id);
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("已检测到登录成功；登录窗口保持打开");
      expect(onChanged).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the login window open when polling confirms an authenticated account before editor readiness", async () => {
    vi.useFakeTimers();
    try {
      const sessionAccount: ChannelAccount = {
        ...accounts[2],
        ctripRuntime: {
          id: "runtime-ctrip",
          channelAccountId: accounts[2].id,
          sessionState: "unavailable",
          bridgePrincipalId: "bridge-principal",
          lastCheckedAt: null,
          lastReadyAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
      const authenticatedAccount: ChannelAccount = {
        ...sessionAccount,
        ctripRuntime: {
          ...runtimeOf(sessionAccount),
          sessionAuthenticated: true,
          lastCheckedAt: "2026-07-15T00:00:02.000Z",
        },
      };
      let loginStarted = false;
      const onOpenLogin = vi.fn(async () => {
        loginStarted = true;
        return {
          loginUrl:
            "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
        };
      });
      const onRefreshStatus = vi.fn(async () =>
        loginStarted ? authenticatedAccount : sessionAccount,
      );
      const replace = vi.fn();
      let closed = false;
      const close = vi.fn(() => {
        closed = true;
      });
      const popup = {
        opener: window,
        location: { replace },
        get closed() {
          return closed;
        },
        close,
      } as unknown as Window;
      vi.spyOn(window, "open").mockReturnValue(popup);
      renderDirectory({ accounts: [sessionAccount], onOpenLogin, onRefreshStatus });

      fireEvent.click(screen.getByRole("button", { name: "补登录 中通携程社区" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(onRefreshStatus).toHaveBeenCalledWith(sessionAccount.id);
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops monitoring and closes the login window when the account no longer exists", async () => {
    vi.useFakeTimers();
    try {
      const sessionAccount: ChannelAccount = {
        ...accounts[2],
        ctripRuntime: {
          id: "runtime-ctrip",
          channelAccountId: accounts[2].id,
          sessionState: "session_required",
          bridgePrincipalId: "bridge-principal",
          lastCheckedAt: null,
          lastReadyAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
      let loginStarted = false;
      const onOpenLogin = vi.fn(async () => {
        loginStarted = true;
        return {
          loginUrl:
            "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
        };
      });
      const onRefreshStatus = vi.fn(async () => {
        if (!loginStarted) return sessionAccount;
        throw new GeoApiError(404, "RESOURCE_NOT_FOUND", "Channel account was not found");
      });
      let closed = false;
      const close = vi.fn(() => {
        closed = true;
      });
      vi.spyOn(window, "open").mockReturnValue({
        opener: window,
        location: { replace: vi.fn() },
        get closed() {
          return closed;
        },
        close,
      } as unknown as Window);
      renderDirectory({ accounts: [sessionAccount], onOpenLogin, onRefreshStatus });

      fireEvent.click(screen.getByRole("button", { name: "补登录 中通携程社区" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(close).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("已不存在，登录窗口已关闭");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the login window open after status confirmation", async () => {
    vi.useFakeTimers();
    try {
      const sessionAccount: ChannelAccount = {
        ...accounts[2],
        ctripRuntime: {
          id: "runtime-ctrip",
          channelAccountId: accounts[2].id,
          sessionState: "unavailable",
          bridgePrincipalId: "bridge-principal",
          lastCheckedAt: null,
          lastReadyAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
      const authenticatedAccount: ChannelAccount = {
        ...sessionAccount,
        ctripRuntime: {
          ...runtimeOf(sessionAccount),
          sessionAuthenticated: true,
        },
      };
      const close = vi.fn();
      vi.spyOn(window, "open").mockReturnValue({
        opener: window,
        location: { replace: vi.fn() },
        closed: false,
        close,
      } as unknown as Window);
      renderDirectory({
        accounts: [sessionAccount],
        onOpenLogin: vi.fn(async () => ({
          loginUrl:
            "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
        })),
        onRefreshStatus: vi.fn(async () => authenticatedAccount),
      });

      fireEvent.click(screen.getByRole("button", { name: "补登录 中通携程社区" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("登录窗口保持打开，请手动关闭");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the login window open while a challenge is still required", async () => {
    vi.useFakeTimers();
    try {
      const sessionAccount: ChannelAccount = {
        ...accounts[2],
        ctripRuntime: {
          id: "runtime-ctrip",
          channelAccountId: accounts[2].id,
          sessionState: "session_required",
          bridgePrincipalId: "bridge-principal",
          lastCheckedAt: null,
          lastReadyAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
      const challengeAccount: ChannelAccount = {
        ...sessionAccount,
        ctripRuntime: { ...runtimeOf(sessionAccount), sessionState: "challenge_required" },
      };
      const replace = vi.fn();
      const close = vi.fn();
      vi.spyOn(window, "open").mockReturnValue({
        opener: window,
        location: { replace },
        closed: false,
        close,
      } as unknown as Window);
      const onRefreshStatus = vi.fn(async () => challengeAccount);
      renderDirectory({
        accounts: [sessionAccount],
        onOpenLogin: vi.fn(async () => ({
          loginUrl:
            "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
        })),
        onRefreshStatus,
      });

      fireEvent.click(screen.getByRole("button", { name: "补登录 中通携程社区" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(onRefreshStatus).toHaveBeenCalledWith(sessionAccount.id);
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a persisted ready session as logged in and offers account actions", async () => {
    const readyAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "ready",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-07-15T00:00:00.000Z",
        lastReadyAt: "2026-07-15T00:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const onOpenLogin = vi.fn(async () => ({
      loginUrl:
        "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
    }));
    const onDelete = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      opener: window,
      location: { replace },
    } as unknown as Window);
    renderDirectory({ accounts: [readyAccount], onOpenLogin, onDelete });

    expect(screen.getByText("已登录 · 可执行")).toHaveClass("account-status-ready");
    fireEvent.click(screen.getByRole("button", { name: "重新登录 中通携程社区" }));
    await waitFor(() => expect(onOpenLogin).toHaveBeenCalledWith(readyAccount.id));
    expect(window.open).toHaveBeenCalledWith("", "geo-account-login-account-ctrip");
    const deleteButton = screen.getByRole("button", { name: "删除 中通携程社区" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(readyAccount.id));
  });

  it("shows a persisted authenticated session as immediately production-ready", () => {
    const authenticatedAccount: ChannelAccount = {
      ...accounts[2],
      status: "active",
      lastVerifiedAt: null,
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "authenticated",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-07-15T00:00:00.000Z",
        lastReadyAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };

    renderDirectory({
      accounts: [authenticatedAccount],
      onOpenLogin: vi.fn(async () => ({ loginUrl: "http://127.0.0.1:10007/vnc.html" })),
    });

    expect(screen.getByText("已登录 · 可执行")).toHaveClass("account-status-ready");
    expect(screen.getByRole("button", { name: "重新登录 中通携程社区" })).toBeInTheDocument();
  });

  it("keeps account actions in a dedicated visible operation column", () => {
    renderDirectory({
      accounts: [
        {
          ...accounts[2],
          ctripRuntime: {
            id: "runtime-ctrip",
            channelAccountId: accounts[2].id,
            sessionState: "session_required",
            bridgePrincipalId: "bridge-principal",
            lastCheckedAt: null,
            lastReadyAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        },
      ],
      onOpenLogin: vi.fn(async () => ({ loginUrl: "http://127.0.0.1:10007/vnc.html" })),
      onDelete: vi.fn(async () => undefined),
    });

    expect(screen.getByRole("columnheader", { name: "操作" })).toHaveClass(
      "account-directory-operation-column",
    );
    expect(screen.getByRole("button", { name: "补登录 中通携程社区" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 中通携程社区" })).toBeInTheDocument();
    expect(document.querySelector("tbody td:last-child")).toHaveClass(
      "account-directory-operation-column",
    );
  });

  it("offers operator force calibration when the runtime probe is unavailable", async () => {
    const unavailableAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "unavailable",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-07-15T00:00:00.000Z",
        lastReadyAt: null,
        lastErrorCode: "ACCOUNT_READINESS_UNAVAILABLE",
        lastErrorMessage: "账号浏览器运行时暂时无法读取",
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const onForceCalibrate = vi.fn(async () => undefined);
    const onChanged = vi.fn();
    renderDirectory({ accounts: [unavailableAccount], onForceCalibrate, onChanged });

    expect(screen.getByText("运行时不可用")).toHaveClass("account-status-stopped");
    fireEvent.click(screen.getByRole("button", { name: "人工强制校准 中通携程社区" }));

    await waitFor(() => expect(onForceCalibrate).toHaveBeenCalledWith(unavailableAccount.id));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("已人工强制校准为可执行状态");
  });

  it("keeps force calibration visible when login is healthy but the account circuit is open", async () => {
    const authenticatedAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip",
        channelAccountId: accounts[2].id,
        sessionState: "authenticated",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-07-15T00:00:00.000Z",
        lastReadyAt: "2026-07-15T00:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const automation: AutomationSnapshot = {
      control: {
        mode: "unattended",
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      controls: [],
      circuits: [
        {
          id: "account-circuit",
          scopeType: "account",
          scopeKey: authenticatedAccount.id,
          state: "open",
          failureCount: 1,
          openedAt: "2026-07-15T00:01:00.000Z",
          retryAt: null,
          reason: "ASSISTED_SESSION_REQUIRED",
          updatedAt: "2026-07-15T00:01:00.000Z",
        },
      ],
      queueDepth: 0,
      queueLimit: 100,
      queueSaturation: 0,
    };
    const onForceCalibrate = vi.fn(async () => undefined);
    renderDirectory({ accounts: [authenticatedAccount], automation, onForceCalibrate });

    expect(screen.getByText("已登录 · 已暂停")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "人工强制校准 中通携程社区" }));
    await waitFor(() => expect(onForceCalibrate).toHaveBeenCalledWith(authenticatedAccount.id));
  });

  it("keeps force calibration visible while an authenticated account circuit is half-open", () => {
    const authenticatedAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip-half-open",
        channelAccountId: accounts[2].id,
        sessionState: "ready",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-07-15T00:00:00.000Z",
        lastReadyAt: "2026-07-15T00:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    };
    const automation: AutomationSnapshot = {
      control: {
        mode: "unattended",
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      controls: [],
      circuits: [
        {
          id: "account-circuit-half-open",
          scopeType: "account",
          scopeKey: authenticatedAccount.id,
          state: "half_open",
          failureCount: 1,
          openedAt: "2026-07-15T00:01:00.000Z",
          retryAt: "2026-07-15T00:11:00.000Z",
          reason: "ASSISTED_SESSION_REQUIRED",
          updatedAt: "2026-07-15T00:01:00.000Z",
        },
      ],
      queueDepth: 0,
      queueLimit: 100,
      queueSaturation: 0,
    };
    renderDirectory({ accounts: [authenticatedAccount], automation });

    expect(screen.getByText("已登录 · 已暂停")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人工强制校准 中通携程社区" })).toBeInTheDocument();
  });

  it("labels an authenticated account as recovery-ready after its circuit cooldown", () => {
    const authenticatedAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: {
        id: "runtime-ctrip-recovery-ready",
        channelAccountId: accounts[2].id,
        sessionState: "authenticated",
        bridgePrincipalId: "bridge-principal",
        lastCheckedAt: "2026-08-13T01:00:00.000Z",
        lastReadyAt: "2026-08-13T01:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-13T01:00:00.000Z",
      },
    };
    const automation: AutomationSnapshot = {
      control: {
        mode: "unattended",
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-08-13T01:00:00.000Z",
      },
      controls: [],
      circuits: [
        {
          id: "account-circuit-recovery-ready",
          scopeType: "account",
          scopeKey: authenticatedAccount.id,
          state: "open",
          failureCount: 1,
          openedAt: "2026-08-13T00:50:31.000Z",
          retryAt: "2026-08-13T01:00:31.000Z",
          reason: "ASSISTED_ADAPTER_DRIFT",
          updatedAt: "2026-08-13T00:50:31.000Z",
        },
      ],
      queueDepth: 0,
      queueLimit: 100,
      queueSaturation: 0,
    };
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T01:00:32.000Z"));

    renderDirectory({ accounts: [authenticatedAccount], automation });

    expect(screen.getByText("已登录 · 可恢复探测")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "人工强制校准 中通携程社区" }),
    ).not.toBeInTheDocument();
  });

  it("uses the unattended browser Toutiao contract from the primary add action", async () => {
    type CreateInput = Parameters<ComponentProps<typeof ChannelAccountDirectory>["onCreate"]>[0];
    const onCreate = vi.fn(async (input: CreateInput) => ({
      ...accounts[2],
      displayName: input.displayName,
    }));
    renderDirectory({ onCreate });

    fireEvent.click(screen.getByRole("button", { name: "新增平台账号" }));
    expect(screen.getByLabelText("平台")).toHaveValue("toutiao");
    expect(screen.getByLabelText("平台")).toBeEnabled();
    expect(screen.queryByLabelText("Connector 能力")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("能力证据")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "头条第二账号" } });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      platform: "toutiao",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });
  });

  it.each([
    ["搜狐号", "sohu"],
    ["百家号", "baijiahao"],
    ["网易号", "netease"],
  ] as const)("uses compact unattended onboarding for %s", async (label, platform) => {
    type CreateInput = Parameters<ComponentProps<typeof ChannelAccountDirectory>["onCreate"]>[0];
    const onCreate = vi.fn(async (input: CreateInput) => ({
      ...accounts[2],
      platform: input.platform,
      displayName: input.displayName,
    }));
    renderDirectory({ onCreate });

    fireEvent.click(screen.getByRole("button", { name: `接入 ${label} 账号` }));
    expect(screen.getByLabelText("平台")).toHaveValue(platform);
    expect(screen.getByLabelText("平台")).toBeDisabled();
    expect(screen.queryByLabelText("Connector 能力")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("账号名称"), {
      target: { value: `${label}运营号` },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      platform,
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });
  });

  it("opens Zhihu onboarding with unattended execution available after verification", async () => {
    type CreateInput = Parameters<ComponentProps<typeof ChannelAccountDirectory>["onCreate"]>[0];
    const onCreate = vi.fn(async (input: CreateInput) => ({
      ...accounts[2],
      platform: input.platform,
      displayName: input.displayName,
    }));
    renderDirectory({ onCreate });

    fireEvent.click(screen.getByRole("button", { name: "接入 知乎 账号" }));
    expect(screen.getByLabelText("平台")).toHaveValue("zhihu");
    expect(screen.getByLabelText("平台")).toBeDisabled();
    expect(screen.getByText(/登录、提交证据和公开回读校验/u)).toBeInTheDocument();
    expect(screen.getByLabelText("人工辅助")).toBeEnabled();
    expect(screen.getByLabelText("无人值守")).toBeEnabled();

    fireEvent.change(screen.getByLabelText("账号名称"), {
      target: { value: "知乎适配账号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      platform: "zhihu",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });
  });

  it("refreshes account state every 30 seconds", () => {
    vi.useFakeTimers();
    try {
      const onChanged = vi.fn();
      renderDirectory({ onChanged });
      vi.advanceTimersByTime(30_000);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("alerts when a ready Ctrip runtime drops during polling", () => {
    const readyRuntime = {
      id: "runtime-ctrip",
      channelAccountId: "account-ctrip",
      sessionState: "ready",
      bridgePrincipalId: "bridge-principal",
      lastCheckedAt: "2026-07-15T00:00:00.000Z",
      lastReadyAt: "2026-07-15T00:00:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: "2026-07-15T00:00:00.000Z",
    } as const satisfies NonNullable<ChannelAccount["ctripRuntime"]>;
    const readyAccount: ChannelAccount = {
      ...accounts[2],
      ctripRuntime: readyRuntime,
    };
    const baseProps = {
      demo: false,
      canManage: true,
      onCreate: vi.fn(async () => accounts[2]),
      onUpdate: vi.fn(async () => undefined),
    } as const;
    const view = render(<ChannelAccountDirectory {...baseProps} accounts={[readyAccount]} />);

    view.rerender(
      <ChannelAccountDirectory
        {...baseProps}
        accounts={[
          {
            ...readyAccount,
            ctripRuntime: {
              ...readyRuntime,
              sessionState: "session_required",
              lastErrorCode: "CTRIP_SESSION_REQUIRED",
            },
          },
        ]}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("已掉线或需要重新登录");
  });

  it("surfaces account-level run protection and active queue occupancy", () => {
    const automation: AutomationSnapshot = {
      control: {
        mode: "shadow",
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      controls: [
        {
          id: "account-pause-control",
          scopeType: "account",
          scopeKey: "account-toutiao",
          mode: "paused",
          killSwitchEnabled: false,
          reason: "等待运营复核",
          quota: {},
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      circuits: [],
      queueDepth: 0,
      queueLimit: 100,
      queueSaturation: 0,
    };
    const publicationJobs: readonly PublicationJob[] = [
      {
        id: "job-1",
        grantId: "grant-1",
        auditArtifactId: "audit-1",
        variantId: "variant-1",
        channelAccountId: "account-toutiao",
        platform: "ctrip_community",
        executionLevel: "dry_run",
        state: "queued",
        payloadHash: "a".repeat(64),
        scheduledFor: "2026-07-15T00:00:00.000Z",
        availableAt: "2026-07-15T00:00:00.000Z",
        attemptCount: 0,
        lastErrorCode: null,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    ];
    renderDirectory({ automation, publicationJobs });

    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.getByText("1 个进行中")).toBeInTheDocument();
    expect(screen.getByText("按账号隔离的投放队列")).toBeInTheDocument();
  });

  it("does not count terminal or review-required publication jobs as in progress", () => {
    const terminalStates = [
      "preview_completed",
      "confirmed",
      "needs_review",
      "permanent_failure",
      "cancelled",
    ];
    const publicationJobs: readonly PublicationJob[] = terminalStates.map((state, index) => ({
      id: `job-terminal-${index}`,
      grantId: `grant-terminal-${index}`,
      auditArtifactId: `audit-terminal-${index}`,
      variantId: `variant-terminal-${index}`,
      channelAccountId: "account-toutiao",
      platform: "ctrip_community",
      executionLevel: "dry_run",
      state,
      payloadHash: "a".repeat(64),
      scheduledFor: "2026-07-15T00:00:00.000Z",
      availableAt: "2026-07-15T00:00:00.000Z",
      attemptCount: 1,
      lastErrorCode: state === "needs_review" ? "ASSISTED_READBACK_NOT_FOUND" : null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }));

    renderDirectory({ publicationJobs });

    expect(screen.getAllByText("暂无任务")).toHaveLength(accounts.length);
    expect(screen.queryByText(/个进行中/u)).not.toBeInTheDocument();
  });

  it("shows submitted asynchronous readback work as pending confirmation instead of active writing", () => {
    const publicationJobs: readonly PublicationJob[] = [
      {
        id: "job-readback-pending",
        grantId: "grant-readback-pending",
        auditArtifactId: "audit-readback-pending",
        variantId: "variant-readback-pending",
        channelAccountId: "account-toutiao",
        platform: "ctrip_community",
        executionLevel: "unattended",
        state: "uncertain",
        payloadHash: "a".repeat(64),
        scheduledFor: "2026-08-13T00:00:00.000Z",
        availableAt: "2026-08-13T00:00:00.000Z",
        attemptCount: 1,
        lastErrorCode: "ASSISTED_READBACK_DEFERRED",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T01:00:00.000Z",
      },
    ];

    renderDirectory({ publicationJobs });

    expect(screen.getByText("1 个待确认")).toBeInTheDocument();
    expect(screen.queryByText("1 个进行中")).not.toBeInTheDocument();
  });

  it("preserves credential and verification references when an edit leaves them blank", async () => {
    type UpdateInput = Parameters<ComponentProps<typeof ChannelAccountDirectory>["onUpdate"]>[1];
    const onUpdate = vi.fn(async (accountId: string, input: UpdateInput) => {
      void accountId;
      void input;
    });
    renderDirectory({ onUpdate });

    fireEvent.click(screen.getByRole("button", { name: "管理 中通携程账号二" }));
    fireEvent.change(screen.getByLabelText("账号名称"), {
      target: { value: "中通携程运营号" },
    });
    fireEvent.change(screen.getByLabelText("平台账号变更原因"), {
      target: { value: "更新运营侧显示名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const update = onUpdate.mock.calls[0]?.[1];
    expect(update).toMatchObject({
      displayName: "中通携程运营号",
      reason: "更新运营侧显示名称",
    });
    expect(update).not.toHaveProperty("credentialRef");
    expect(update).not.toHaveProperty("lastVerifiedAt");
  });
});
