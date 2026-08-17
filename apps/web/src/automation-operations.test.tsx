import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AutomationBatch,
  type AutomationRun,
  type AutomationSnapshot,
  type CampaignAutomationPlan,
  type Campaign,
  type ChannelAccount,
  GeoApiError,
  type GeoApi,
} from "./api.js";
import { AutomationOperations } from "./automation-operations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const campaign: Campaign = {
  id: "10000000-0000-4000-8000-000000001001",
  brandId: "10000000-0000-4000-8000-000000000301",
  name: "日本线路问答",
  objective: "生成并审计旅行服务问答",
  industry: "travel",
  status: "active",
  topicKey: "japan-travel",
  automationRemediationEnabled: true,
};

const accounts: readonly ChannelAccount[] = [
  {
    id: "10000000-0000-4000-8000-000000000701",
    platform: "toutiao",
    displayName: "中通头条号",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["operator-verification"],
    status: "active",
    lastVerifiedAt: "2026-07-15T01:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000702",
    platform: "sohu",
    displayName: "中通搜狐号",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["operator-verification"],
    status: "active",
    lastVerifiedAt: "2026-07-15T01:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000703",
    platform: "ctrip_community",
    displayName: "中通携程社区",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["operator-verification"],
    status: "active",
    lastVerifiedAt: "2026-07-15T01:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000704",
    platform: "ctrip_community",
    displayName: "中通携程无人值守账号",
    capability: "browser_assisted",
    supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    evidenceType: "platform_readback",
    evidenceRefs: ["adapter:ctrip-community-browser-unattended-v1"],
    status: "active",
    lastVerifiedAt: "2026-07-15T01:00:00.000Z",
    ctripRuntime: {
      id: "10000000-0000-4000-8000-000000000706",
      channelAccountId: "10000000-0000-4000-8000-000000000704",
      sessionState: "ready",
      bridgePrincipalId: null,
      lastCheckedAt: "2026-07-15T01:00:00.000Z",
      lastReadyAt: "2026-07-15T01:00:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: "2026-07-15T01:00:00.000Z",
    },
  },
  {
    id: "10000000-0000-4000-8000-000000000705",
    platform: "toutiao",
    displayName: "不可用账号",
    capability: "disabled",
    supportedExecutionLevels: [],
    evidenceType: "manual_import",
    evidenceRefs: [],
    status: "disabled",
    lastVerifiedAt: null,
  },
];

function batch(
  id = "10000000-0000-4000-8000-000000002001",
  state: AutomationBatch["state"] = "scheduled",
  name = "日本线路预演批次",
  executionLevel: AutomationBatch["executionLevel"] = "dry_run",
): AutomationBatch {
  return {
    id,
    campaignId: campaign.id,
    name,
    state,
    executionLevel,
    automationRemediationEnabled: true,
    scheduledFor: "2026-07-15T08:00:00.000Z",
    runCount: 1,
    completedRunCount: state === "completed" ? 1 : 0,
    failedRunCount: 0,
    deliveryFailedRunCount: 0,
    cancelledRunCount: 0,
    terminalRunCount: state === "scheduled" ? 0 : 1,
    createdAt: "2026-07-15T07:00:00.000Z",
    updatedAt: "2026-07-15T07:00:00.000Z",
  };
}

function run(
  automationBatch: AutomationBatch,
  overrides: Partial<AutomationRun> = {},
): AutomationRun {
  const id = overrides.id ?? "10000000-0000-4000-8000-000000003001";
  return {
    id,
    batchId: automationBatch.id,
    campaignId: campaign.id,
    brandId: campaign.brandId,
    executionLevel: automationBatch.executionLevel,
    automationRemediationEnabled: automationBatch.automationRemediationEnabled ?? true,
    slotKey: "slot-001",
    topicKey: campaign.topicKey,
    brief: "面向计划赴日游客的签证材料与服务范围问答",
    diversityRotationIndex: 0,
    state: "scheduled",
    stage: "planning",
    availableAt: "2026-07-15T08:00:00.000Z",
    attemptCount: 0,
    maxAttempts: 5,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    checkpoint: {},
    contentItemId: null,
    contentVersionId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    completedAt: null,
    createdAt: "2026-07-15T07:00:00.000Z",
    updatedAt: "2026-07-15T07:00:00.000Z",
    targets: [
      {
        id: "10000000-0000-4000-8000-000000004001",
        runId: id,
        channelAccountId: accounts[0]?.id ?? "",
        platform: "toutiao",
        state: "pending",
        variantId: null,
        auditRunId: null,
        auditArtifactId: null,
        publicationJobId: null,
        externalUrl: null,
        remediation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: null,
        createdAt: "2026-07-15T07:00:00.000Z",
        updatedAt: "2026-07-15T07:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function automationPlan(): CampaignAutomationPlan {
  return {
    id: "10000000-0000-4000-8000-000000000901",
    campaignId: campaign.id,
    actorId: "10000000-0000-4000-8000-000000000101",
    enabled: true,
    executionLevel: "unattended",
    platforms: ["toutiao", "baijiahao", "ctrip_community"],
    slotCount: 5,
    intervalMinutes: 15,
    dailyTimes: ["09:00", "20:00"],
    timezone: "Asia/Shanghai",
    nextRunAt: "2026-08-08T01:00:00.000Z",
    lastRunAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    runCount: 0,
    campaignName: campaign.name,
    campaignTopicKey: campaign.topicKey,
    campaignObjective: campaign.objective,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function tenantControl(
  mode: AutomationSnapshot["control"]["mode"] = "shadow",
): AutomationSnapshot["control"] {
  return {
    mode,
    killSwitchEnabled: false,
    reason: null,
    quota: {},
    updatedAt: "2026-07-15T01:00:00.000Z",
  };
}

function accountControl(
  accountId: string,
  mode: AutomationSnapshot["control"]["mode"],
): AutomationSnapshot["controls"][number] {
  return {
    id: `control-${accountId}`,
    scopeType: "account",
    scopeKey: accountId,
    mode,
    killSwitchEnabled: false,
    reason: null,
    quota: {},
    updatedAt: "2026-07-15T01:00:00.000Z",
  };
}

function circuitFor(
  accountId: string,
  state: AutomationSnapshot["circuits"][number]["state"],
): AutomationSnapshot["circuits"][number] {
  return {
    id: `circuit-${accountId}`,
    scopeType: "account",
    scopeKey: accountId,
    state,
    failureCount: 3,
    openedAt: "2026-07-15T01:00:00.000Z",
    retryAt: null,
    reason: "account circuit",
    updatedAt: "2026-07-15T01:00:00.000Z",
  };
}

function automationForAccounts(
  sourceAccounts: readonly ChannelAccount[],
  overrides: Partial<AutomationSnapshot> = {},
): AutomationSnapshot {
  return {
    control: tenantControl(),
    controls: sourceAccounts.map((account) =>
      accountControl(
        account.id,
        account.supportedExecutionLevels.includes("unattended") ? "unattended" : "shadow",
      ),
    ),
    circuits: [],
    queueDepth: 0,
    queueLimit: 100,
    queueSaturation: 0,
    ...overrides,
  };
}

function automationApi(overrides: Partial<GeoApi>): GeoApi {
  return {
    getCampaignAutomationPlan: async () => null,
    saveCampaignAutomationPlan: async () => {
      throw new Error("saveCampaignAutomationPlan is not stubbed in this test");
    },
    runCampaignAutomationPlan: async () => {
      throw new Error("runCampaignAutomationPlan is not stubbed in this test");
    },
    ...overrides,
  } as GeoApi;
}

function renderOperations(
  api: GeoApi,
  options: {
    readonly accounts?: readonly ChannelAccount[];
    readonly automation?: AutomationSnapshot | null;
    readonly capabilities?: readonly string[];
    readonly campaigns?: readonly Campaign[];
    readonly tenantId?: string;
  } = {},
) {
  return render(
    <AutomationOperations
      api={api}
      tenantId={options.tenantId ?? "tenant-a"}
      campaigns={options.campaigns ?? [campaign]}
      accounts={options.accounts ?? accounts}
      automation={options.automation ?? null}
      capabilities={options.capabilities ?? ["automation:manage"]}
    />,
  );
}

const AUTOMATION_PLATFORM_LABELS = ["头条号", "搜狐号", "百家号", "网易号", "携程社区"];

function platformCheckbox(platform: string): HTMLInputElement {
  return screen.getByLabelText(`自动化目标平台：${platform}`) as HTMLInputElement;
}

function selectAutomationPlatforms(...platforms: readonly string[]) {
  for (const platform of platforms) {
    const checkbox = platformCheckbox(platform);
    if (!checkbox.checked) fireEvent.click(checkbox);
  }
  for (const platform of AUTOMATION_PLATFORM_LABELS) {
    if (platforms.includes(platform)) continue;
    const checkbox = screen.queryByLabelText(
      `自动化目标平台：${platform}`,
    ) as HTMLInputElement | null;
    if (checkbox?.checked) fireEvent.click(checkbox);
  }
}

describe("AutomationOperations", () => {
  it("refreshes visible batch and run state without a manual reload", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const scheduledBatch = batch(
      "10000000-0000-4000-8000-000000002099",
      "scheduled",
      "自动刷新批次",
    );
    const completedBatch = batch(scheduledBatch.id, "completed", "自动刷新批次");
    let currentBatch = scheduledBatch;
    const getAutomationBatches = vi.fn(async () => [currentBatch]);
    const getAutomationRuns = vi.fn(async () => [run(currentBatch)]);
    const getAutomationRun = vi.fn(async () => run(currentBatch));
    const api = automationApi({
      getAutomationBatches,
      getAutomationRuns,
      getAutomationRun,
    });

    try {
      renderOperations(api);

      expect((await screen.findAllByText("自动刷新批次")).length).toBeGreaterThan(0);
      expect(screen.getByText("0/1 已终态", { exact: false })).toBeInTheDocument();
      currentBatch = completedBatch;

      await waitFor(
        () => {
          expect(getAutomationBatches.mock.calls.length).toBeGreaterThanOrEqual(2);
          expect(screen.getByText("1/1 已终态", { exact: false })).toBeInTheDocument();
        },
        { timeout: 3_500 },
      );
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("sets a valid first-slot time from the quick schedule actions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-06T15:58:30.000Z"));
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    const timeInput = screen.getByLabelText("自动生成首篇计划时间") as HTMLInputElement;
    expect(timeInput.value).toBe("2026-08-07T00:04");

    fireEvent.click(screen.getByRole("button", { name: "最快可用" }));
    expect(timeInput.value).toBe("2026-08-07T00:01");

    fireEvent.click(screen.getByRole("button", { name: "5 分钟后" }));
    expect(timeInput.value).toBe("2026-08-07T00:04");
  });

  it("keeps the schedule input valid when an unrelated refresh re-renders the batch form", async () => {
    let currentTime = Date.parse("2026-08-06T15:58:30.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    const timeInput = screen.getByLabelText("自动生成首篇计划时间") as HTMLInputElement;
    const initialMinimum = timeInput.min;
    const initialValue = timeInput.value;
    expect(initialValue >= initialMinimum).toBe(true);
    expect(timeInput.checkValidity()).toBe(true);

    currentTime += 6 * 60_000;
    fireEvent.change(screen.getByLabelText("自动化批次名称"), {
      target: { value: "无关字段更新" },
    });

    expect(timeInput.min).toBe(initialMinimum);
    expect(timeInput.value).toBe(initialValue);
    expect(timeInput.checkValidity()).toBe(true);
  });

  it("keeps batch scheduling and timestamps in Shanghai time across the date boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-06T12:00:00.000Z"));
    const createdBatch = batch(undefined, "scheduled", "上海时区日期批次");
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(async () => ({
      batch: createdBatch,
      wasCreated: true,
    }));
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    fireEvent.change(screen.getByLabelText("自动生成首篇计划时间"), {
      target: { value: "2026-08-06T23:59" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建演练批次" }));

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    expect(createAutomationBatch.mock.calls[0]?.[1].items[0]?.scheduledFor).toBe(
      "2026-08-06T15:59:00.000Z",
    );
  });

  it("reads runs for the selected batch instead of relying on the global run page", async () => {
    const storedBatch = { ...batch(), runCount: 20 };
    const storedRun = run(storedBatch);
    const getAutomationRuns = vi.fn(async (batchId?: string) =>
      batchId === storedBatch.id ? [storedRun] : [],
    );
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns,
      getAutomationRun: async () => storedRun,
    });

    renderOperations(api);

    expect((await screen.findAllByText(storedRun.slotKey)).length).toBeGreaterThan(0);
    expect(getAutomationRuns).toHaveBeenCalledWith(storedBatch.id);
    expect(screen.queryByText("当前批次暂无可回读的运行槽位")).not.toBeInTheDocument();
  });

  it("activates a draft Campaign through the server state machine and list readback", async () => {
    const draftCampaign = { ...campaign, status: "draft" as const };
    let persistedCampaign: Campaign = draftCampaign;
    const transitionCampaignState = vi.fn<GeoApi["transitionCampaignState"]>(
      async (campaignId, input) => {
        persistedCampaign = { ...draftCampaign, status: input.status };
        return {
          campaign: persistedCampaign,
          previousStatus: "draft",
          wasChanged: true,
        };
      },
    );
    const onCampaignsRead = vi.fn();
    const api = automationApi({
      transitionCampaignState,
      getCampaigns: async () => [persistedCampaign],
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    render(
      <AutomationOperations
        api={api}
        tenantId="tenant-a"
        campaigns={[draftCampaign]}
        accounts={accounts}
        capabilities={["automation:manage", "content:write"]}
        onCampaignsRead={onCampaignsRead}
      />,
    );

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: `激活推广计划 ${draftCampaign.name}` }));
    expect(screen.getByRole("dialog", { name: "确认激活推广计划" })).toBeInTheDocument();
    expect(screen.getByText(/激活后，该推广计划才能创建/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认激活" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("推广计划状态变更原因"), {
      target: { value: "核验事实与平台账号已就绪" },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(transitionCampaignState).toHaveBeenCalledWith(draftCampaign.id, {
        status: "active",
        reason: "核验事实与平台账号已就绪",
      }),
    );
    await waitFor(() => expect(onCampaignsRead).toHaveBeenCalledWith([persistedCampaign]));
    expect(await screen.findByText(/已由草稿变更为已激活，并完成列表回读/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("writes the campaign-level automatic remediation toggle and confirms the readback", async () => {
    let persistedCampaign: Campaign = campaign;
    const setCampaignAutomationRemediation = vi.fn<GeoApi["setCampaignAutomationRemediation"]>(
      async (campaignId, enabled) => {
        persistedCampaign = { ...campaign, id: campaignId, automationRemediationEnabled: enabled };
        return persistedCampaign;
      },
    );
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
      getCampaigns: async () => [persistedCampaign],
      setCampaignAutomationRemediation,
    });

    renderOperations(api, { capabilities: ["automation:manage", "content:write"] });

    const toggle = await screen.findByRole("checkbox", { name: `${campaign.name} 自动整改` });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setCampaignAutomationRemediation).toHaveBeenCalledWith(campaign.id, false),
    );
    expect(
      await screen.findByText(/已关闭自动整改；新建批次遇到审计问题将转入人工处理/),
    ).toBeInTheDocument();
  });

  it("generates and saves a customer prompt template for an existing campaign", async () => {
    const setCampaignPromptTemplate = vi.fn<GeoApi["setCampaignPromptTemplate"]>(
      async (campaignId, promptTemplate) => ({
        ...campaign,
        id: campaignId,
        promptTemplate,
      }),
    );
    const generateCampaignPromptTemplate = vi.fn<GeoApi["generateCampaignPromptTemplate"]>(
      async () => ({
        promptTemplate: "AI 生成模版",
        provider: "fixture",
        model: "fixture-v1",
        generatedAt: "2026-08-10T00:00:00.000Z",
      }),
    );
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
      getCampaigns: async () => [campaign],
      setCampaignPromptTemplate,
      generateCampaignPromptTemplate,
    });

    renderOperations(api, { capabilities: ["automation:manage", "content:write"] });

    const edit = await screen.findByRole("button", {
      name: `编辑 ${campaign.name} 提示词模版`,
    });
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: /提示词模版/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("客户内容需求"), {
      target: { value: "突出真纯玩与国企地接" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI 生成提示词模版" }));

    await waitFor(() =>
      expect(generateCampaignPromptTemplate).toHaveBeenCalledWith({
        needs: "突出真纯玩与国企地接",
        campaignName: campaign.name,
        topicKey: campaign.topicKey,
        objective: campaign.objective,
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("提示词模版")).toHaveValue("AI 生成模版"));
    fireEvent.click(screen.getByRole("button", { name: "保存模版" }));

    await waitFor(() =>
      expect(setCampaignPromptTemplate).toHaveBeenCalledWith(campaign.id, "AI 生成模版"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a tenant-scoped multi-slot Dry-run batch and reads preview targets back", async () => {
    let storedBatches: readonly AutomationBatch[] = [];
    let storedRuns: readonly AutomationRun[] = [];
    const createdBatch = { ...batch(undefined, "completed", "暑期日本线路预演"), runCount: 2 };
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(
      async (_campaignId, input) => {
        const firstTarget = {
          ...(run(createdBatch).targets[0] as NonNullable<AutomationRun["targets"][number]>),
          state: "preview_completed" as const,
          variantId: "10000000-0000-4000-8000-000000005001",
          auditRunId: "10000000-0000-4000-8000-000000005002",
          auditArtifactId: "10000000-0000-4000-8000-000000005003",
          publicationJobId: "10000000-0000-4000-8000-000000005004",
          completedAt: "2026-07-15T08:01:00.000Z",
        };
        storedBatches = [createdBatch];
        storedRuns = [
          run(createdBatch, {
            state: "completed",
            stage: "delivery",
            contentItemId: "10000000-0000-4000-8000-000000005005",
            contentVersionId: "10000000-0000-4000-8000-000000005006",
            completedAt: "2026-07-15T08:01:00.000Z",
            targets: [firstTarget],
          }),
          run(createdBatch, {
            id: "10000000-0000-4000-8000-000000003002",
            slotKey: input.items[1]?.slotKey ?? "slot-002",
            targets: [],
          }),
        ];
        return { batch: createdBatch, wasCreated: true };
      },
    );
    const onChanged = vi.fn();
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => storedRuns,
      getAutomationRun: async (runId) => {
        const item = storedRuns.find((candidate) => candidate.id === runId);
        if (item === undefined) throw new Error("run missing");
        return item;
      },
      cancelAutomationBatch: async () => {
        throw new Error("not used");
      },
    });
    render(
      <AutomationOperations
        api={api}
        tenantId="tenant-a"
        campaigns={[campaign]}
        accounts={accounts}
        capabilities={["automation:manage"]}
        onChanged={onChanged}
      />,
    );

    expect(await screen.findByText("当前租户尚无自动化批次")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    fireEvent.change(screen.getByLabelText("自动化批次名称"), {
      target: { value: "暑期日本线路预演" },
    });
    fireEvent.change(screen.getByLabelText("自动生成文章数量"), {
      target: { value: "2" },
    });
    selectAutomationPlatforms("头条号");
    expect(screen.queryByLabelText("自动生成槽位预览")).not.toBeInTheDocument();
    const submitButton = screen.getByRole("button", { name: "创建演练批次" });
    const form = submitButton.closest("form");
    expect(form).not.toBeNull();
    expect(
      [...(form?.elements ?? [])].flatMap((element) => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return [];
        }
        return element.checkValidity()
          ? []
          : [{ label: element.getAttribute("aria-label"), value: element.value }];
      }),
    ).toEqual([]);
    fireEvent.click(submitButton);

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    const [campaignId, input] = createAutomationBatch.mock.calls[0] ?? [];
    expect(campaignId).toBe(campaign.id);
    expect(input).toMatchObject({
      name: "暑期日本线路预演",
      items: [
        {
          slotKey: "slot-001",
          topicKey: campaign.topicKey,
          channelAccountIds: [],
        },
        {
          slotKey: "slot-002",
          topicKey: campaign.topicKey,
          channelAccountIds: [],
        },
      ],
    });
    expect(input).not.toHaveProperty("tenantId");
    expect(input?.executionLevel).toBe("dry_run");
    expect(input?.distribution).toEqual({ mode: "platform_round_robin", platform: "toutiao" });
    const submittedBriefs = input?.items.map((item) => item.brief) ?? [];
    expect(
      submittedBriefs.every((brief) => !brief.includes(`围绕${campaign.topicKey}生成第`)),
    ).toBe(true);
    expect(new Set(submittedBriefs)).toEqual(
      new Set([
        `依据推广计划主题“${campaign.topicKey}”与目标“${campaign.objective}”创作原创文章；保持受众、事实和推广目标一致，文章模板、读者切入、正文结构和行动引导由服务端按槽位绑定。`,
      ]),
    );
    expect(input?.idempotencyKey).toMatch(/^web-automation:tenant-a:/u);
    expect(input?.items.every((item) => !Number.isNaN(Date.parse(item.scheduledFor)))).toBe(true);
    expect(await screen.findByText("演练预演完成")).toBeInTheDocument();
    expect(screen.getByText(/2 个槽位已持久化为\s*演练\s*批次/)).toBeInTheDocument();
    expect(screen.queryByText(/已真实发布/u)).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("moves an expired first-slot time at least two full minutes into the future", async () => {
    const currentTime = Date.parse("2026-08-05T12:34:30.000Z");
    vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const createdBatch = batch(undefined, "scheduled", "过期时间修正批次");
    let storedBatches: readonly AutomationBatch[] = [];
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(async () => {
      storedBatches = [createdBatch];
      return { batch: createdBatch, wasCreated: true };
    });
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    fireEvent.change(screen.getByLabelText("自动生成首篇计划时间"), {
      target: { value: "2026-08-05T10:00" },
    });
    const form = screen.getByRole("button", { name: "创建演练批次" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    const scheduledFor = createAutomationBatch.mock.calls[0]?.[1].items[0]?.scheduledFor;
    expect(scheduledFor).toBeDefined();
    const correctedTimestamp = Date.parse(scheduledFor ?? "");
    expect(correctedTimestamp).toBeGreaterThanOrEqual(currentTime + 2 * 60_000);
    expect(correctedTimestamp).toBeLessThan(currentTime + 3 * 60_000);
  });

  it("shows policy diagnostics returned by the API when batch creation is rejected", async () => {
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(async () => {
      throw new GeoApiError(
        403,
        "PUBLICATION_POLICY_DENIED",
        "Publication request was denied by database policy",
        "req-policy-1",
        {
          reason: "account circuit blocks unattended publication",
          rejectionCodes: ["ACCOUNT_CIRCUIT_OPEN", "SESSION_NOT_READY"],
        },
      );
    });
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    fireEvent.click(screen.getByRole("button", { name: "创建演练批次" }));

    expect(
      await screen.findByText(
        "PUBLICATION_POLICY_DENIED: Publication request was denied by database policy · account circuit blocks unattended publication · request req-policy-1",
      ),
    ).toBeInTheDocument();
  });

  it("shows rejection codes when an API error has no policy reason", async () => {
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(async () => {
      throw new GeoApiError(422, "MEDIA_SEARCH_REJECTED", "No usable media candidate", null, {
        rejectionCodes: ["MEDIA_QUERY_RELEVANCE_FAILED", "MEDIA_LICENSE_REJECTED"],
      });
    });
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    fireEvent.click(screen.getByRole("button", { name: "创建演练批次" }));

    expect(
      await screen.findByText(
        "MEDIA_SEARCH_REJECTED: No usable media candidate · rejections=MEDIA_QUERY_RELEVANCE_FAILED,MEDIA_LICENSE_REJECTED",
      ),
    ).toBeInTheDocument();
  });

  it("selects platforms rather than accounts for multi-platform distribution", async () => {
    let storedBatches: readonly AutomationBatch[] = [];
    const createdBatch = batch(
      "10000000-0000-4000-8000-000000002901",
      "scheduled",
      "多平台并行批次",
    );
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(async () => {
      storedBatches = [createdBatch];
      return { batch: createdBatch, wasCreated: true };
    });
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    selectAutomationPlatforms("头条号", "搜狐号");
    expect(screen.queryByText("中通头条号")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("自动生成文章数量"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建演练批次" }));

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    expect(createAutomationBatch.mock.calls[0]?.[1]).toMatchObject({
      distribution: {
        mode: "platforms_round_robin",
        platforms: expect.arrayContaining(["toutiao", "sohu"]),
      },
      items: [{ channelAccountIds: [] }, { channelAccountIds: [] }],
    });
    const distribution = createAutomationBatch.mock.calls[0]?.[1].distribution;
    if (distribution?.mode !== "platforms_round_robin") {
      throw new Error("expected a multi-platform distribution");
    }
    expect(distribution.platforms).toHaveLength(2);
    expect(await screen.findByText(/2 个内容槽位 × 2 个平台目标/u)).toBeInTheDocument();
  });

  it("shows only templates allowed by the selected platform set", async () => {
    const baijiaAccount: ChannelAccount = {
      ...(accounts[1] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000002902",
      platform: "baijiahao",
      displayName: "中通百家号",
    };
    const sourceAccounts = [...accounts, baijiaAccount];
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api, {
      accounts: sourceAccounts,
      automation: automationForAccounts(sourceAccounts),
    });

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    selectAutomationPlatforms("携程社区");

    const photoRecap = "照片复盘笔记 · 带父母看慢节奏";
    const costContract = "费用与行程核对 · 价格变化的有效期";
    expect(screen.getByText(photoRecap)).toBeInTheDocument();
    expect(screen.queryByText(costContract)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("自动化目标平台：百家号"));
    expect(screen.queryByText(photoRecap)).not.toBeInTheDocument();
    expect(screen.queryByText(costContract)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("自动化目标平台：携程社区"));
    expect(screen.queryByText(photoRecap)).not.toBeInTheDocument();
    expect(screen.getByText(costContract)).toBeInTheDocument();
  });

  it("keeps an operator's multi-platform choices during a transient account refresh", async () => {
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    const props = (sourceAccounts: readonly ChannelAccount[]) => ({
      api,
      tenantId: "tenant-a",
      campaigns: [campaign],
      accounts: sourceAccounts,
      automation: automationForAccounts(sourceAccounts),
      capabilities: ["automation:manage"],
    });
    const view = render(<AutomationOperations {...props(accounts)} />);

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    selectAutomationPlatforms("头条号", "搜狐号");

    expect(screen.getByLabelText("自动化目标平台：头条号")).toBeChecked();
    expect(screen.getByLabelText("自动化目标平台：搜狐号")).toBeChecked();

    view.rerender(<AutomationOperations {...props(accounts)} api={{ ...api }} />);
    expect(screen.getByLabelText("自动化目标平台：头条号")).toBeChecked();
    expect(screen.getByLabelText("自动化目标平台：搜狐号")).toBeChecked();
    expect(screen.getByLabelText("自动化目标平台：携程社区")).not.toBeChecked();

    const ctripOnly = accounts.filter((account) => account.platform === "ctrip_community");
    view.rerender(<AutomationOperations {...props(ctripOnly)} />);
    expect(
      screen.getAllByRole("status").some((notice) => {
        const text = notice.textContent ?? "";
        return (
          text.includes("已选") &&
          text.includes("头条号") &&
          text.includes("搜狐号") &&
          text.includes("暂不可用")
        );
      }),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "创建演练批次" })).toBeDisabled();

    view.rerender(<AutomationOperations {...props(accounts)} />);
    await waitFor(() => expect(screen.getByLabelText("自动化目标平台：头条号")).toBeChecked());
    expect(screen.getByLabelText("自动化目标平台：搜狐号")).toBeChecked();
    expect(screen.getByLabelText("自动化目标平台：携程社区")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "创建演练批次" })).toBeEnabled();
  });

  it("creates an unattended batch with an eligible priority-platform account", async () => {
    let storedBatches: readonly AutomationBatch[] = [];
    let storedRuns: readonly AutomationRun[] = [];
    const createdBatch = batch(
      "10000000-0000-4000-8000-000000002101",
      "scheduled",
      "头条无人值守批次",
      "unattended",
    );
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(
      async (_campaignId, input) => {
        storedBatches = [createdBatch];
        storedRuns = [
          run(createdBatch, {
            id: "10000000-0000-4000-8000-000000003101",
            targets: [],
          }),
        ];
        expect(input.executionLevel).toBe("unattended");
        return { batch: createdBatch, wasCreated: true };
      },
    );
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => storedRuns,
      getAutomationRun: async () => storedRuns[0] as AutomationRun,
    });
    const ctripRuntime = accounts[3]?.ctripRuntime;
    if (ctripRuntime === undefined) throw new Error("browser runtime fixture is missing");
    const toutiaoAccount: ChannelAccount = {
      ...(accounts[0] as ChannelAccount),
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
      ctripRuntime: {
        ...ctripRuntime,
        id: "10000000-0000-4000-8000-000000000707",
        channelAccountId: accounts[0]?.id ?? "",
      },
    };
    renderOperations(api, {
      accounts: [...accounts.slice(1), toutiaoAccount],
      automation: automationForAccounts([...accounts.slice(1), toutiaoAccount]),
    });

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "无人值守" }));
    fireEvent.change(screen.getByLabelText("自动生成文章数量"), {
      target: { value: "1" },
    });
    expect(platformCheckbox("头条号")).toBeInTheDocument();
    expect(platformCheckbox("携程社区")).toBeInTheDocument();
    expect(screen.getAllByText(/1 个 无人值守 可用账号 · \d+ 套允许模板/u)).toHaveLength(2);
    selectAutomationPlatforms("头条号");
    fireEvent.click(screen.getByRole("button", { name: "创建并批量发送 1 个变体" }));

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    expect(createAutomationBatch.mock.calls[0]?.[1]).toMatchObject({
      executionLevel: "unattended",
      distribution: { mode: "platform_round_robin", platform: "toutiao" },
      items: [{ channelAccountIds: [] }],
    });
    expect(await screen.findByText(/已持久化为 无人值守 批次/u)).toBeInTheDocument();
  });

  it("creates an assisted batch as a real publication handoff instead of a dry run", async () => {
    let storedBatches: readonly AutomationBatch[] = [];
    let storedRuns: readonly AutomationRun[] = [];
    const createdBatch = batch(
      "10000000-0000-4000-8000-000000002102",
      "scheduled",
      "知乎人工协作批次",
      "assisted",
    );
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>(
      async (_campaignId, input) => {
        storedBatches = [createdBatch];
        storedRuns = [run(createdBatch, { targets: [] })];
        expect(input.executionLevel).toBe("assisted");
        return { batch: createdBatch, wasCreated: true };
      },
    );
    const zhihuAccount: ChannelAccount = {
      ...(accounts[0] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000000708",
      platform: "zhihu",
      displayName: "知乎测试账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted"],
    };
    renderOperations(
      automationApi({
        createAutomationBatch,
        getAutomationBatches: async () => storedBatches,
        getAutomationRuns: async () => storedRuns,
        getAutomationRun: async () => storedRuns[0] as AutomationRun,
      }),
      {
        accounts: [zhihuAccount],
        automation: automationForAccounts([zhihuAccount]),
      },
    );

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "人工协作" }));
    fireEvent.change(screen.getByLabelText("自动生成文章数量"), {
      target: { value: "1" },
    });

    expect(screen.getByText(/草稿准备完成后由人工确认最终发布/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建人工协作批次" }));

    await waitFor(() => expect(createAutomationBatch).toHaveBeenCalledTimes(1));
    expect(createAutomationBatch.mock.calls[0]?.[1]).toMatchObject({
      executionLevel: "assisted",
      distribution: { mode: "platform_round_robin", platform: "zhihu" },
      items: [{ channelAccountIds: [] }],
    });
  });

  it("allows an authenticated Ctrip account in the unattended rotation pool", async () => {
    const authenticatedAccounts = accounts.map((account) =>
      account.ctripRuntime === undefined
        ? account
        : {
            ...account,
            ctripRuntime: { ...account.ctripRuntime, sessionState: "authenticated" as const },
          },
    );
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    render(
      <AutomationOperations
        api={api}
        tenantId="tenant-a"
        campaigns={[campaign]}
        accounts={authenticatedAccounts}
        automation={automationForAccounts(authenticatedAccounts)}
        capabilities={["automation:manage"]}
      />,
    );

    await screen.findByText("当前租户尚无自动化批次");
    fireEvent.click(screen.getByRole("button", { name: "无人值守" }));

    selectAutomationPlatforms("携程社区");
    expect(screen.getByText(/1 个 无人值守 可用账号 · \d+ 套允许模板/u)).toBeInTheDocument();
  });

  it("filters unattended availability by controls, sessions, and circuits", async () => {
    const ctripRuntime = accounts[3]?.ctripRuntime;
    if (ctripRuntime === undefined) throw new Error("browser runtime fixture is missing");
    const sohuAccount: ChannelAccount = {
      ...(accounts[1] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000001011",
      displayName: "中通搜狐挑战账号",
      supportedExecutionLevels: ["dry_run"],
      ctripRuntime: {
        ...ctripRuntime,
        id: "10000000-0000-4000-8000-000000001061",
        channelAccountId: "10000000-0000-4000-8000-000000001011",
        sessionState: "challenge_required",
      },
    };
    const shadowToutiao: ChannelAccount = {
      ...(accounts[0] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000001012",
      displayName: "中通头条演练账号",
      supportedExecutionLevels: ["dry_run"],
      ctripRuntime: {
        ...ctripRuntime,
        id: "10000000-0000-4000-8000-000000001062",
        channelAccountId: "10000000-0000-4000-8000-000000001012",
        sessionState: "session_required",
      },
    };
    const unattendedToutiao: ChannelAccount = {
      ...(accounts[0] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000001013",
      displayName: "中通头条无人值守账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
      ctripRuntime: {
        ...ctripRuntime,
        id: "10000000-0000-4000-8000-000000001063",
        channelAccountId: "10000000-0000-4000-8000-000000001013",
        sessionState: "authenticated",
      },
    };
    const automation = automationForAccounts([sohuAccount, shadowToutiao, unattendedToutiao], {
      circuits: [circuitFor(shadowToutiao.id, "half_open")],
    });
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api, {
      accounts: [sohuAccount, shadowToutiao, unattendedToutiao],
      automation,
    });

    await screen.findByText("当前租户尚无自动化批次");
    expect(screen.getByLabelText("自动化目标平台：头条号")).toBeInTheDocument();
    expect(screen.queryByLabelText("自动化目标平台：搜狐号")).not.toBeInTheDocument();
    expect(screen.getByText(/1 个 无人值守 可用账号 · \d+ 套允许模板/u)).toBeInTheDocument();
    expect(screen.queryByText(/2 个 无人值守 可用账号/u)).not.toBeInTheDocument();
  });

  it("admits one account for a server-controlled recovery probe after its circuit cooldown", async () => {
    const ctripRuntime = accounts[3]?.ctripRuntime;
    if (ctripRuntime === undefined) throw new Error("browser runtime fixture is missing");
    const recoveringNetease: ChannelAccount = {
      ...(accounts[0] as ChannelAccount),
      id: "10000000-0000-4000-8000-000000001014",
      platform: "netease",
      displayName: "网易恢复探测账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
      ctripRuntime: {
        ...ctripRuntime,
        id: "10000000-0000-4000-8000-000000001064",
        channelAccountId: "10000000-0000-4000-8000-000000001014",
        sessionState: "authenticated",
      },
    };
    const automation = automationForAccounts([recoveringNetease], {
      circuits: [
        {
          ...circuitFor(recoveringNetease.id, "open"),
          retryAt: "2026-08-13T01:00:31.000Z",
          reason: "ASSISTED_ADAPTER_DRIFT",
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-13T01:00:32.000Z"));

    renderOperations(api, {
      accounts: [recoveringNetease],
      automation,
      capabilities: ["automation:manage", "content:write"],
    });

    await screen.findByText("当前租户尚无自动化批次");
    expect(screen.getByLabelText("自动化目标平台：网易号")).toBeInTheDocument();
    expect(screen.getByText(/1 个 无人值守 可用账号/u)).toBeInTheDocument();
  });

  it("shows persisted slot assignments and changes them only while pending", async () => {
    const firstToutiao = accounts[0];
    if (firstToutiao === undefined) throw new Error("Toutiao test account is required");
    const secondToutiao: ChannelAccount = {
      ...firstToutiao,
      id: "10000000-0000-4000-8000-000000000707",
      displayName: "中通头条二号",
    };
    const storedBatch = batch();
    let storedRun = run(storedBatch);
    const reassignAutomationTarget = vi.fn<GeoApi["reassignAutomationTarget"]>(
      async (_runId, targetId, channelAccountId) => {
        storedRun = {
          ...storedRun,
          targets: storedRun.targets.map((target) =>
            target.id === targetId ? { ...target, channelAccountId } : target,
          ),
        };
        return storedRun;
      },
    );
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
      reassignAutomationTarget,
    });
    render(
      <AutomationOperations
        api={api}
        tenantId="tenant-a"
        campaigns={[campaign]}
        accounts={[...accounts, secondToutiao]}
        capabilities={["automation:manage"]}
      />,
    );

    expect(await screen.findByText("账号：中通头条号")).toBeInTheDocument();
    const targetId = storedRun.targets[0]?.id ?? "";
    fireEvent.change(screen.getByLabelText(`修改 ${targetId} 分配账号`), {
      target: { value: secondToutiao.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));

    await waitFor(() =>
      expect(reassignAutomationTarget).toHaveBeenCalledWith(
        storedRun.id,
        targetId,
        secondToutiao.id,
      ),
    );
    expect(await screen.findByText("账号：中通头条二号")).toBeInTheDocument();
  });

  it("shows the target failure behind an aggregate automation run error", async () => {
    const storedBatch = {
      ...batch(
        "10000000-0000-4000-8000-000000002201",
        "partially_failed",
        "携程真实外发失败批次",
        "unattended",
      ),
      failedRunCount: 1,
    };
    const storedRun = run(storedBatch, {
      id: "10000000-0000-4000-8000-000000003201",
      state: "failed",
      stage: "delivery",
      lastErrorCode: "AUTOMATION_TARGETS_FAILED",
      lastErrorMessage: "AUTOMATION_TARGETS_FAILED",
      targets: [
        {
          ...(run(storedBatch).targets[0] as AutomationRun["targets"][number]),
          id: "10000000-0000-4000-8000-000000004201",
          channelAccountId: accounts[3]?.id ?? "",
          platform: "ctrip_community",
          state: "failed",
          lastErrorCode: "PUBLICATION_POLICY_DENIED",
          lastErrorMessage: "a circuit breaker blocks Ctrip browser handoff",
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
    });
    renderOperations(api);

    expect(
      await screen.findByText("AUTOMATION_TARGETS_FAILED: AUTOMATION_TARGETS_FAILED"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PUBLICATION_POLICY_DENIED: a circuit breaker blocks Ctrip browser handoff"),
    ).toBeInTheDocument();
  });

  it("distinguishes a submitted target awaiting platform review from a delivery failure", async () => {
    const storedBatch = batch(
      "10000000-0000-4000-8000-000000002202",
      "completed",
      "平台异步审核批次",
      "unattended",
    );
    const storedRun = run(storedBatch, {
      id: "10000000-0000-4000-8000-000000003202",
      state: "completed",
      stage: "delivery",
      completedAt: "2026-08-07T08:10:00.000Z",
      targets: [
        {
          ...(run(storedBatch).targets[0] as AutomationRun["targets"][number]),
          id: "10000000-0000-4000-8000-000000004202",
          state: "submitted_pending_review",
          variantId: "10000000-0000-4000-8000-000000005201",
          auditRunId: "10000000-0000-4000-8000-000000005202",
          auditArtifactId: "10000000-0000-4000-8000-000000005203",
          publicationJobId: "10000000-0000-4000-8000-000000005204",
          completedAt: "2026-08-07T08:10:00.000Z",
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
    });
    renderOperations(api);

    expect(await screen.findByText("已提交，待平台审核")).toBeInTheDocument();
    expect(screen.queryByText("投放失败")).not.toBeInTheDocument();
  });

  it("shows a platform rejection as a first-class target state", async () => {
    const storedBatch = batch(
      "10000000-0000-4000-8000-000000002203",
      "partially_failed",
      "平台驳回整改批次",
      "unattended",
    );
    const baseTarget = run(storedBatch).targets[0] as AutomationRun["targets"][number];
    const storedRun = run(storedBatch, {
      id: "10000000-0000-4000-8000-000000003203",
      state: "partially_failed",
      stage: "delivery",
      completedAt: "2026-08-11T08:10:00.000Z",
      targets: [
        {
          ...baseTarget,
          id: "10000000-0000-4000-8000-000000004203",
          state: "publisher_rejected",
          variantId: "10000000-0000-4000-8000-000000005205",
          auditRunId: "10000000-0000-4000-8000-000000005206",
          auditArtifactId: "10000000-0000-4000-8000-000000005207",
          publicationJobId: "10000000-0000-4000-8000-000000005208",
          completedAt: "2026-08-11T08:10:00.000Z",
          lastErrorCode: "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL",
          lastErrorMessage: "平台审核未通过：文章被判定为广告软文",
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
    });
    renderOperations(api);

    expect(await screen.findByText("平台审核未通过")).toBeInTheDocument();
    expect(screen.getByText(/ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL/)).toBeInTheDocument();
    expect(screen.queryByText(/自动整改 1\/2/)).not.toBeInTheDocument();
    expect(screen.queryByText("已提交，待平台审核")).not.toBeInTheDocument();
  });

  it("shows the replacement attempt after a rejected target is requeued", async () => {
    const storedBatch = batch(
      "10000000-0000-4000-8000-000000002204",
      "running",
      "平台驳回替代稿批次",
      "unattended",
    );
    const baseTarget = run(storedBatch).targets[0] as AutomationRun["targets"][number];
    const storedRun = run(storedBatch, {
      id: "10000000-0000-4000-8000-000000003204",
      state: "scheduled",
      stage: "targets",
      targets: [
        {
          ...baseTarget,
          id: "10000000-0000-4000-8000-000000004204",
          runId: "10000000-0000-4000-8000-000000003204",
          remediation: {
            taskId: "publisher-remediation-1",
            mode: "automatic",
            attempt: 1,
            maxAttempts: 2,
            reasonCodes: ["publisher.rejected.soft_advertorial"],
            actions: ["rebuild_article", "soften_promotion", "replace_media"],
          },
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
    });
    renderOperations(api);

    expect(await screen.findByText("待处理")).toBeInTheDocument();
    expect(screen.getByText(/自动整改 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/publisher\.rejected\.soft_advertorial/)).toBeInTheDocument();
    expect(screen.queryByText("平台审核未通过")).not.toBeInTheDocument();
  });

  it("keeps batch creation and cancellation read-only without automation:manage", async () => {
    const storedBatch = batch();
    const storedRun = run(storedBatch);
    const createAutomationBatch = vi.fn<GeoApi["createAutomationBatch"]>();
    const cancelAutomationBatch = vi.fn<GeoApi["cancelAutomationBatch"]>();
    const api = automationApi({
      createAutomationBatch,
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
      cancelAutomationBatch,
    });
    renderOperations(api, { capabilities: ["content:read"] });

    expect(await screen.findByText(/本页保持只读/)).toBeInTheDocument();
    expect(screen.getByLabelText("自动化批次名称")).toBeDisabled();
    expect(screen.getByLabelText("自动生成文章数量")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建并批量发送 30 个变体" })).toBeDisabled();
    expect(await screen.findByLabelText("自动化批次取消原因")).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消批次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `暂停推广计划 ${campaign.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `完成推广计划 ${campaign.name}` })).toBeDisabled();
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(createAutomationBatch).not.toHaveBeenCalled();
    expect(cancelAutomationBatch).not.toHaveBeenCalled();
  });

  it("cancels an active batch and reads the persisted cancellation counts back", async () => {
    let storedBatch = batch();
    let storedRun = run(storedBatch);
    const cancelAutomationBatch = vi.fn<GeoApi["cancelAutomationBatch"]>(
      async (batchId, reason) => {
        void reason;
        storedBatch = { ...storedBatch, state: "cancelled" };
        storedRun = {
          ...storedRun,
          state: "cancelled",
          targets: storedRun.targets.map((target) => ({ ...target, state: "cancelled" })),
        };
        return {
          batchId,
          state: "cancelled",
          cancelledRuns: 1,
          cancelledTargets: 1,
          wasChanged: true,
        };
      },
    );
    const onChanged = vi.fn();
    const api = automationApi({
      createAutomationBatch: async () => {
        throw new Error("not used");
      },
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
      cancelAutomationBatch,
    });
    render(
      <AutomationOperations
        api={api}
        tenantId="tenant-a"
        campaigns={[campaign]}
        accounts={accounts}
        capabilities={["automation:manage"]}
        onChanged={onChanged}
      />,
    );

    expect((await screen.findAllByText("日本线路预演批次")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("自动化批次取消原因"), {
      target: { value: "运营计划已调整" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消批次" }));

    await waitFor(() =>
      expect(cancelAutomationBatch).toHaveBeenCalledWith(storedBatch.id, "运营计划已调整"),
    );
    expect(await screen.findByText(/1 个运行、1 个目标停止继续处理/)).toBeInTheDocument();
    expect(screen.getAllByText("已取消").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("自动化批次取消原因")).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("separates successful, failed, cancelled, and active runs in batch statistics", async () => {
    const storedBatch: AutomationBatch = {
      ...batch(undefined, "cancelled", "双平台二十篇诊断批次", "unattended"),
      runCount: 20,
      completedRunCount: 0,
      failedRunCount: 7,
      deliveryFailedRunCount: 0,
      cancelledRunCount: 13,
      terminalRunCount: 20,
    };
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    expect(await screen.findByText("20/20 已终态", { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText("0 成功 · 7 运行失败 · 0 投放失败 · 13 已取消 · 0 处理中"),
    ).toBeInTheDocument();
  });

  it("drops a completed previous-tenant request before rendering the new tenant", async () => {
    const tenantABatch = batch(
      "10000000-0000-4000-8000-000000002101",
      "scheduled",
      "tenant-a-secret",
    );
    const tenantBBatch = batch(
      "20000000-0000-4000-8000-000000002101",
      "scheduled",
      "tenant-b-batch",
    );
    const tenantARun = run(tenantABatch, {
      id: "10000000-0000-4000-8000-000000003101",
    });
    const tenantBRun = run(tenantBBatch, {
      id: "20000000-0000-4000-8000-000000003101",
    });
    let resolveTenantA: (value: readonly AutomationBatch[]) => void = () => undefined;
    const tenantABatches = new Promise<readonly AutomationBatch[]>((resolve) => {
      resolveTenantA = resolve;
    });
    const getAutomationBatches = vi
      .fn<GeoApi["getAutomationBatches"]>()
      .mockImplementationOnce(async () => tenantABatches)
      .mockResolvedValueOnce([tenantBBatch]);
    const getAutomationRuns = vi
      .fn<GeoApi["getAutomationRuns"]>()
      .mockResolvedValueOnce([tenantARun])
      .mockResolvedValueOnce([tenantBRun]);
    const api = automationApi({
      createAutomationBatch: async () => {
        throw new Error("not used");
      },
      getAutomationBatches,
      getAutomationRuns,
      getAutomationRun: async (runId) => (runId === tenantBRun.id ? tenantBRun : tenantARun),
      cancelAutomationBatch: async () => {
        throw new Error("not used");
      },
    });
    const view = renderOperations(api, { tenantId: "tenant-a" });

    view.rerender(
      <AutomationOperations
        api={api}
        tenantId="tenant-b"
        campaigns={[campaign]}
        accounts={accounts}
        capabilities={["automation:manage"]}
      />,
    );
    expect((await screen.findAllByText("tenant-b-batch")).length).toBeGreaterThan(0);
    await act(async () => resolveTenantA([tenantABatch]));

    await waitFor(() => expect(screen.queryByText("tenant-a-secret")).not.toBeInTheDocument());
    expect(screen.getAllByText("tenant-b-batch").length).toBeGreaterThan(0);
  });

  it("shows only the first five batches until the list is expanded", async () => {
    const storedBatches = Array.from({ length: 7 }, (_, index) =>
      batch(
        `10000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
        "scheduled",
        `批次 ${index + 1}`,
      ),
    );
    const api = automationApi({
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    expect((await screen.findAllByText("批次 1")).length).toBeGreaterThan(0);
    expect(screen.getByText("批次 5")).toBeInTheDocument();
    expect(screen.queryByText("批次 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部 7 个批次" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 7 个批次" }));
    expect(screen.getByText("批次 6")).toBeInTheDocument();
    expect(screen.getByText("批次 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起批次列表" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起批次列表" }));
    expect(screen.queryByText("批次 6")).not.toBeInTheDocument();
    expect(screen.queryByText("批次 7")).not.toBeInTheDocument();
  });

  it("expands batches progressively and keeps the collapse control", async () => {
    const storedBatches = Array.from({ length: 10 }, (_, index) =>
      batch(
        `10000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
        "scheduled",
        `批次 ${index + 1}`,
      ),
    );
    const api = automationApi({
      getAutomationBatches: async () => storedBatches,
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("not used");
      },
    });
    renderOperations(api);

    expect((await screen.findAllByText("批次 1")).length).toBeGreaterThan(0);
    expect(screen.getByText("批次 5")).toBeInTheDocument();
    expect(screen.queryByText("批次 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" }));
    expect(screen.getByText("批次 9")).toBeInTheDocument();
    expect(screen.queryByText("批次 10")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部 10 个批次" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起批次列表" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 10 个批次" }));
    expect(screen.getByText("批次 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起批次列表" }));
    expect(screen.queryByText("批次 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();
  });

  it("expands run slots progressively and keeps the collapse control", async () => {
    const storedBatch = { ...batch(), runCount: 10 };
    const storedRuns = Array.from({ length: 10 }, (_, index) =>
      run(storedBatch, {
        id: `10000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
        slotKey: `slot-${String(index + 1).padStart(3, "0")}`,
      }),
    );
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => storedRuns,
      getAutomationRun: async (runId) =>
        storedRuns.find((candidate) => candidate.id === runId) as AutomationRun,
    });
    renderOperations(api);

    expect(await screen.findByText("slot-005")).toBeInTheDocument();
    expect(screen.queryByText("slot-006")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "展开更多 4 个运行槽位 · 剩余 5 个" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开更多 4 个运行槽位 · 剩余 5 个" }));
    expect(screen.getByText("slot-009")).toBeInTheDocument();
    expect(screen.queryByText("slot-010")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部 10 个运行槽位" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起运行槽位" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 10 个运行槽位" }));
    expect(screen.getByText("slot-010")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起运行槽位" }));
    expect(screen.queryByText("slot-006")).not.toBeInTheDocument();
  });

  it("shows a registered target remediation before a target is blocked", async () => {
    const storedBatch = batch();
    const storedRun = run(storedBatch, {
      state: "failed",
      stage: "targets",
      checkpoint: {},
      targets: [
        {
          id: "10000000-0000-4000-8000-000000004001",
          runId: "10000000-0000-4000-8000-000000003001",
          channelAccountId: accounts[0]?.id ?? "",
          platform: "toutiao",
          state: "blocked",
          variantId: "10000000-0000-4000-8000-000000004101",
          auditRunId: "10000000-0000-4000-8000-000000004102",
          auditArtifactId: "10000000-0000-4000-8000-000000004103",
          publicationJobId: null,
          externalUrl: "https://baijiahao.baidu.com/s?id=1234567890",
          remediation: {
            taskId: "automation-run:target-toutiao:remediation:2",
            scope: "target",
            attempt: 2,
            maxAttempts: 2,
            reasonCodes: ["duplicate.near"],
            actions: ["change_diversity_blueprint", "rebuild_article"],
          },
          lastErrorCode: "AUTOMATION_REMEDIATION_BLOCKED",
          lastErrorMessage: "审核未通过：media.inspection.evaluator_unapproved",
          completedAt: "2026-07-15T08:02:00.000Z",
          createdAt: "2026-07-15T08:00:00.000Z",
          updatedAt: "2026-07-15T08:02:00.000Z",
        },
      ],
    });
    const api = automationApi({
      getAutomationBatches: async () => [storedBatch],
      getAutomationRuns: async () => [storedRun],
      getAutomationRun: async () => storedRun,
    });

    renderOperations(api);

    expect(
      await screen.findByText(
        "自动整改 2/2 · 原因：duplicate.near · 动作：change_diversity_blueprint、rebuild_article",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("AUTOMATION_REMEDIATION_BLOCKED:", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 头条号 的原始公开 URL" })).toHaveAttribute(
      "href",
      "https://baijiahao.baidu.com/s?id=1234567890",
    );
  });

  it("saves and immediately runs a campaign automation plan", async () => {
    const plan = automationPlan();
    const savePlan = vi.fn<GeoApi["saveCampaignAutomationPlan"]>(async (_campaignId, input) => ({
      ...plan,
      ...input,
    }));
    const runPlan = vi.fn<GeoApi["runCampaignAutomationPlan"]>(async () => ({
      batch: batch("10000000-0000-4000-8000-000000002500", "scheduled", "计划自动批次"),
      wasCreated: true,
      plan,
    }));
    const api = automationApi({
      getCampaignAutomationPlan: async () => plan,
      saveCampaignAutomationPlan: savePlan,
      runCampaignAutomationPlan: runPlan,
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("no run selected");
      },
    });

    renderOperations(api);

    expect(await screen.findByText("推广计划自动配置")).toBeInTheDocument();
    expect(await screen.findByText(/已运行 0 次/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并启用计划" }));
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "立即按计划创建" }));
    await waitFor(() => expect(runPlan).toHaveBeenCalledTimes(1));
  });

  it("distinguishes unsaved automatic-plan changes from the persisted enabled state", async () => {
    const api = automationApi({
      getCampaignAutomationPlan: async () => automationPlan(),
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("no run selected");
      },
    });

    renderOperations(api);

    expect(await screen.findByLabelText("自动投放计划保存状态")).toHaveTextContent("已启用");
    fireEvent.click(screen.getByRole("switch", { name: "自动投放计划启用开关" }));
    expect(screen.getByLabelText("自动投放计划保存状态")).toHaveTextContent("未保存更改");
  });

  it("resets the automatic-plan draft when switching to an unconfigured campaign", async () => {
    const secondCampaign: Campaign = {
      ...campaign,
      id: "10000000-0000-4000-8000-000000001002",
      name: "新疆线路问答",
      topicKey: "xinjiang-travel",
    };
    const getPlan = vi.fn<GeoApi["getCampaignAutomationPlan"]>(async (campaignId) =>
      campaignId === campaign.id ? automationPlan() : null,
    );
    const api = automationApi({
      getCampaignAutomationPlan: getPlan,
      getAutomationBatches: async () => [],
      getAutomationRuns: async () => [],
      getAutomationRun: async () => {
        throw new Error("no run selected");
      },
    });

    renderOperations(api, { campaigns: [campaign, secondCampaign] });

    expect(await screen.findByLabelText("自动投放每批槽位")).toHaveValue(5);
    fireEvent.change(screen.getByLabelText("自动配置推广计划"), {
      target: { value: secondCampaign.id },
    });

    await waitFor(() => expect(getPlan).toHaveBeenCalledWith(secondCampaign.id));
    expect(screen.getByLabelText("自动投放每批槽位")).toHaveValue(30);
    expect(screen.getByLabelText("自动投放计划保存状态")).toHaveTextContent("未配置");
  });
});
