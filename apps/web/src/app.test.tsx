import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { type GeoApi, GeoApiError, type SessionSnapshot } from "./api.js";
import { App } from "./app.js";

afterEach(cleanup);

const session: SessionSnapshot = {
  actor: {
    id: "10000000-0000-4000-8000-000000000101",
    displayName: "测试运营员",
    role: "owner",
    capabilities: [
      "tenant:read",
      "content:read",
      "receipt:read",
      "visibility:read",
      "automation:manage",
    ],
  },
  tenant: {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "zhongtong-international-travel",
    displayName: "中通国际旅行社",
  },
  expiresAt: "2026-07-14T16:00:00.000Z",
};

function liveApi(): GeoApi {
  let automation = {
    control: {
      mode: "shadow",
      killSwitchEnabled: false,
      reason: "MVP starts in shadow mode",
      quota: { dailyPublications: 0, dryRunOnly: true },
      updatedAt: "2026-07-14T08:00:00.000Z",
    },
    circuits: [],
  };
  return {
    getSession: async () => session,
    login: async () => session,
    logout: async () => undefined,
    getTenants: async () => [
      {
        id: session.tenant.id,
        slug: session.tenant.slug,
        displayName: session.tenant.displayName,
        role: "owner",
        status: "active",
      },
    ],
    switchTenant: async () => session,
    getTenant: async () => ({
      id: session.tenant.id,
      slug: session.tenant.slug,
      displayName: session.tenant.displayName,
      legalName: session.tenant.displayName,
      industry: "travel",
      status: "active",
      defaultLocale: "zh-CN",
    }),
    getContacts: async () => [
      {
        id: "10000000-0000-4000-8000-000000000401",
        tenantId: session.tenant.id,
        type: "phone",
        label: "24小时热线",
        value: "4001133986",
        isPrimary: true,
        validFrom: "2026-07-13T00:00:00.000Z",
        validUntil: null,
      },
    ],
    getChannelAccounts: async () => [
      {
        id: "10000000-0000-4000-8000-000000000701",
        platform: "toutiao",
        displayName: "中通国旅-头条号-Dry Run",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        evidenceType: "preview",
        evidenceRefs: ["seed:dry-run-only"],
        status: "active",
        lastVerifiedAt: null,
      },
    ],
    getCampaigns: async () => [
      {
        id: "10000000-0000-4000-8000-000000001001",
        brandId: "10000000-0000-4000-8000-000000000301",
        name: "实时日本银发问答集",
        objective: "提高有证据的品牌命中",
        industry: "travel",
        status: "draft",
        topicKey: "japan-senior",
      },
    ],
    createCampaign: async (input) => ({
      id: "10000000-0000-4000-8000-000000001002",
      ...input,
      status: "draft",
    }),
    getContent: async () => [],
    getContentVariants: async () => [],
    getPublicationJobs: async () => [
      {
        id: "10000000-0000-4000-8000-000000001101",
        variantId: "10000000-0000-4000-8000-000000001102",
        platform: "toutiao",
        executionLevel: "dry_run",
        state: "confirmed",
        payloadHash: "a".repeat(64),
        createdAt: "2026-07-14T08:00:00.000Z",
        updatedAt: "2026-07-14T08:01:00.000Z",
      },
    ],
    getReceipts: async () => [
      {
        id: "10000000-0000-4000-8000-000000001201",
        jobId: "10000000-0000-4000-8000-000000001101",
        platform: "toutiao",
        executionLevel: "dry_run",
        evidenceType: "preview",
        externalUrl: null,
        confirmed: true,
        recordedAt: "2026-07-14T08:01:00.000Z",
      },
    ],
    getVisibilitySummary: async () => [
      {
        provider: "doubao",
        productSurface: "web-search",
        model: "doubao-search-v1",
        searchMode: "on",
        observationMethod: "manual",
        evidenceType: "manual_import",
        observations: 12,
        brandMentionRate: 0.5,
        contactAccuracy: 1,
        harmfulErrors: 0,
      },
    ],
    getAutomation: async () => automation,
    setKillSwitch: async (input) => {
      automation = {
        ...automation,
        control: {
          ...automation.control,
          killSwitchEnabled: input.enabled,
          reason: input.reason,
          updatedAt: "2026-07-14T08:05:00.000Z",
        },
      };
      return automation.control;
    },
  };
}

function renderApp(options: { path?: string; api?: GeoApi; demo?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? "/overview"]}>
      <App
        {...(options.api === undefined ? {} : { api: options.api })}
        initialMode={options.demo === true ? "demo" : "live"}
      />
    </MemoryRouter>,
  );
}

describe("GEO operator console", () => {
  it("keeps dry-run capability and fixture evidence visibly marked in explicit demo mode", () => {
    renderApp({ demo: true });

    expect(screen.getByText("三家平台当前均为 Dry-run / Manual only")).toBeInTheDocument();
    expect(screen.getByText("演示数据")).toBeInTheDocument();
    expect(screen.getAllByText(/Fixture/).length).toBeGreaterThan(0);
  });

  it("switches demo tenant context without leaking the previous tenant identity", () => {
    renderApp({ demo: true });

    fireEvent.change(screen.getByLabelText("当前客户"), { target: { value: "isolation" } });

    const contextBar = screen.getByText("隔离测试旅行社").closest(".context-bar");
    expect(contextBar).not.toBeNull();
    expect(within(contextBar as HTMLElement).getByText("测试隔离")).toBeInTheDocument();
  });

  it("creates only a clearly marked demo campaign from the operator dialog", async () => {
    renderApp({ demo: true });

    fireEvent.click(screen.getByRole("button", { name: "新建 Campaign" }));
    fireEvent.change(screen.getByLabelText("Campaign 名称"), {
      target: { value: "东南亚亲子证据计划" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "泰国 / 亲子 / 暑期" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 Campaign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("东南亚亲子证据计划")).toBeInTheDocument();
    expect(screen.getByText("泰国 / 亲子 / 暑期")).toBeInTheDocument();
  });

  it("makes the demo kill switch state explicit", () => {
    renderApp({ demo: true });

    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));

    expect(screen.getByText("演示：全租户投放已停止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复 Shadow" })).toBeInTheDocument();
  });

  it("renders live API records and preserves visibility evidence dimensions", async () => {
    renderApp({ path: "/visibility", api: liveApi() });

    await screen.findByText("web-search");
    expect(screen.getByText("实时 API")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
    expect(screen.getByText("doubao-search-v1")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("Manual import")).toBeInTheDocument();
  });

  it("does not silently replace an unavailable API with demo success", async () => {
    const api = liveApi();
    api.getSession = async () => {
      throw new GeoApiError(0, "NETWORK_ERROR", "API unavailable");
    };
    renderApp({ api });

    await screen.findByRole("heading", { name: "登录运营台" });
    expect(screen.getByText(/NETWORK_ERROR: API unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("日本银发跟团游问答集")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "进入演示模式" }));
    expect(screen.getByText("演示数据")).toBeInTheDocument();
  });

  it("keeps a partial endpoint failure visible with its request id", async () => {
    const api = liveApi();
    api.getCampaigns = async () => {
      throw new GeoApiError(
        503,
        "DATABASE_UNAVAILABLE",
        "Campaign storage is unavailable",
        "req-campaigns-503",
      );
    };
    renderApp({ api });

    await screen.findByText("GET /api/campaigns 读取失败");
    expect(screen.getByText(/DATABASE_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.getByText(/req-campaigns-503/)).toBeInTheDocument();
    expect(screen.getByText("实时 API")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
  });

  it("shows a truthful empty state for a successful zero-row response", async () => {
    renderApp({ path: "/content", api: liveApi() });

    await screen.findByText("暂无内容资产");
    expect(screen.getByText("GET /api/content 返回 0 条记录")).toBeInTheDocument();
  });

  it("shows live Kill Switch state only after write and readback agree", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("当前租户 Kill Switch 关闭");
    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));
    fireEvent.change(screen.getByLabelText("操作原因"), {
      target: { value: "联系方式异常，暂停当前租户投放" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));

    await screen.findByText("当前租户投放已暂停");
    expect(screen.getByRole("button", { name: "恢复 Shadow" })).toBeInTheDocument();
  });
});
