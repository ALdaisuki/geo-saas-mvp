import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AutomationBatch,
  type AutomationRun,
  type Campaign,
  type ChannelAccount,
  type GeoApi,
} from "./api.js";
import { AutomationOperations } from "./automation-operations.js";

afterEach(cleanup);

const campaign: Campaign = {
  id: "10000000-0000-4000-8000-000000001001",
  brandId: "10000000-0000-4000-8000-000000000301",
  name: "日本线路问答",
  objective: "生成并审计旅行服务问答",
  industry: "travel",
  status: "active",
  topicKey: "japan-travel",
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
): AutomationBatch {
  return {
    id,
    campaignId: campaign.id,
    name,
    state,
    executionLevel: "dry_run",
    scheduledFor: "2026-07-15T08:00:00.000Z",
    runCount: 1,
    completedRunCount: state === "completed" ? 1 : 0,
    failedRunCount: 0,
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
    slotKey: "slot-001",
    topicKey: campaign.topicKey,
    brief: "面向计划赴日游客的签证材料与服务范围问答",
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

function automationApi(overrides: Partial<GeoApi>): GeoApi {
  return overrides as GeoApi;
}

function renderOperations(
  api: GeoApi,
  options: { readonly capabilities?: readonly string[]; readonly tenantId?: string } = {},
) {
  return render(
    <AutomationOperations
      api={api}
      tenantId={options.tenantId ?? "tenant-a"}
      campaigns={[campaign]}
      accounts={accounts}
      capabilities={options.capabilities ?? ["automation:manage"]}
    />,
  );
}

describe("AutomationOperations", () => {
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
    fireEvent.click(screen.getByRole("button", { name: `激活 Campaign ${draftCampaign.name}` }));
    expect(screen.getByRole("dialog", { name: "确认激活 Campaign" })).toBeInTheDocument();
    expect(screen.getByText(/激活后，该 Campaign 才能创建/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认激活" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campaign 状态变更原因"), {
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
    fireEvent.change(screen.getByLabelText("自动化批次名称"), {
      target: { value: "暑期日本线路预演" },
    });
    fireEvent.change(screen.getByLabelText("槽位 1 文章 brief"), {
      target: { value: "面向亲子家庭说明日本暑期线路的已核验服务范围" },
    });
    const firstAccountPicker = screen.getByLabelText("槽位 1 添加 Dry-run 账号");
    fireEvent.change(firstAccountPicker, { target: { value: accounts[0]?.id } });
    fireEvent.change(screen.getByLabelText("槽位 1 添加 Dry-run 账号"), {
      target: { value: accounts[1]?.id },
    });
    fireEvent.change(screen.getByLabelText("槽位 1 添加 Dry-run 账号"), {
      target: { value: accounts[2]?.id },
    });
    expect(screen.getByLabelText("槽位 1 添加 Dry-run 账号")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "添加槽位" }));
    fireEvent.change(screen.getByLabelText("槽位 2 文章 brief"), {
      target: { value: "回答首次赴日游客常见准备问题并只引用相关核验事实" },
    });
    fireEvent.change(screen.getByLabelText("槽位 2 添加 Dry-run 账号"), {
      target: { value: accounts[0]?.id },
    });
    const submitButton = screen.getByRole("button", { name: "创建 Dry-run 批次" });
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
          channelAccountIds: [accounts[0]?.id, accounts[1]?.id, accounts[2]?.id],
        },
        {
          slotKey: "slot-002",
          topicKey: campaign.topicKey,
          channelAccountIds: [accounts[0]?.id],
        },
      ],
    });
    expect(input).not.toHaveProperty("tenantId");
    expect(input).toHaveProperty("executionLevel", "dry_run");
    expect(input?.idempotencyKey).toMatch(/^web-automation:tenant-a:/u);
    expect(input?.items.every((item) => !Number.isNaN(Date.parse(item.scheduledFor)))).toBe(true);
    expect(await screen.findByText("Dry-run 预演完成")).toBeInTheDocument();
    expect(screen.getByText(/2 个槽位已持久化为 dry_run 批次/)).toBeInTheDocument();
    expect(screen.queryByText(/已真实发布/u)).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole("button", { name: "添加槽位" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建 Dry-run 批次" })).toBeDisabled();
    expect(screen.getByLabelText("自动化批次取消原因")).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消批次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: `暂停 Campaign ${campaign.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `完成 Campaign ${campaign.name}` })).toBeDisabled();
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
});
