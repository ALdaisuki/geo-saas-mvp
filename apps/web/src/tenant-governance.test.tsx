import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAccount, PolicyBundle, TenantContact, TenantMember } from "./api.js";
import {
  TenantGovernance,
  type GovernanceServicePrincipal,
  type TenantGovernanceProps,
} from "./tenant-governance.js";

afterEach(cleanup);

const contacts: readonly TenantContact[] = [
  {
    id: "10000000-0000-4000-8000-000000000401",
    tenantId: "10000000-0000-4000-8000-000000000001",
    type: "phone",
    label: "24小时热线",
    value: "4000000001",
    isPrimary: true,
    validFrom: "2026-07-13T00:00:00.000Z",
    validUntil: null,
  },
];

const members: readonly TenantMember[] = [
  {
    id: "10000000-0000-4000-8000-000000000201",
    userId: "10000000-0000-4000-8000-000000000101",
    email: "owner@example.test",
    displayName: "租户负责人",
    role: "owner",
    capabilities: ["tenant:manage", "member:manage", "principal:manage"],
    enabledModules: ["ai_content"],
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
  },
];

const policyDocument = {
  schemaVersion: "geo.audit-policy.v2",
  rulesVersion: "travel-v2",
  industry: "travel",
  contentTemplates: { title: {}, summary: {}, body: {}, tag: {} },
  editorialProfiles: {},
  platformEditorialStyles: {},
  audit: {
    artifactTtlMs: 3_600_000,
    maxEvidenceAgeMs: 30 * 86_400_000,
    minClaims: 1,
    duplicateThreshold: 0.88,
    minDuplicateCharacters: 120,
    media: {},
    platformLimits: {},
  },
} as const;

const policies: readonly PolicyBundle[] = [
  {
    id: "10000000-0000-4000-8000-000000000501",
    version: "travel-v2",
    status: "draft",
    policyHash: "a".repeat(64),
    document: policyDocument,
    effectiveAt: "2026-07-15T00:00:00.000Z",
    retiredAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
  },
];

const accounts: readonly ChannelAccount[] = [
  {
    id: "10000000-0000-4000-8000-000000000701",
    platform: "ctrip_community",
    displayName: "中通携程社区",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["ticket:GEO-1"],
    status: "active",
    lastVerifiedAt: "2026-07-15T00:00:00.000Z",
    dailyPublishQuota: 10,
  },
];

const principals: readonly GovernanceServicePrincipal[] = [
  {
    id: "10000000-0000-4000-8000-000000000801",
    tenantId: "10000000-0000-4000-8000-000000000001",
    name: "producer-sample-travel",
    kind: "agent",
    profile: "automation_producer",
    capabilities: [
      "tenant:read",
      "content:read",
      "content:write",
      "audit:read",
      "audit:run",
      "publish:request",
      "receipt:read",
      "automation:execute",
    ],
    status: "active",
    credentialStatus: "not_issued",
    lastUsedAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000802",
    tenantId: "10000000-0000-4000-8000-000000000001",
    name: "browser-bridge-sample-travel",
    kind: "integration",
    profile: "ctrip_bridge",
    capabilities: ["tenant:read"],
    status: "active",
    credentialStatus: "not_issued",
    lastUsedAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000803",
    tenantId: "10000000-0000-4000-8000-000000000001",
    name: "custom-worker-sample-travel",
    kind: "agent",
    profile: "custom",
    capabilities: ["tenant:read"],
    status: "active",
    credentialStatus: "not_issued",
    lastUsedAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
];

function props(overrides: Partial<TenantGovernanceProps> = {}): TenantGovernanceProps {
  return {
    contacts,
    members,
    policies,
    accounts,
    principals,
    actorRole: "owner",
    capabilities: ["tenant:manage", "member:manage", "principal:manage"],
    showPriorityDistribution: true,
    showAgentAutomation: true,
    onCreateContact: vi.fn(async () => undefined),
    onExpireContact: vi.fn(async () => undefined),
    onCreateMember: vi.fn(async () => undefined),
    onUpdateMember: vi.fn(async () => undefined),
    onUpdateMemberModules: vi.fn(async () => undefined),
    onCreatePolicy: vi.fn(async () => undefined),
    onTransitionPolicy: vi.fn(async () => undefined),
    onCreateChannelAccount: vi.fn(async () => undefined),
    onUpdateChannelAccount: vi.fn(async () => undefined),
    onCreateAutomationPrincipal: vi.fn(async () => undefined),
    onSetPrincipalStatus: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TenantGovernance", () => {
  it("renders governance directory metadata in Chinese with named icon actions", () => {
    render(<TenantGovernance {...props()} />);

    expect(screen.getByText("电话")).toHaveAttribute("title", "联系方式类型");
    expect(screen.getByText("所有者")).toHaveAttribute("title", "成员角色");
    expect(screen.getByText("人工操作")).toHaveAttribute("title", "连接方式");
    expect(screen.getByText("演练")).toHaveAttribute("title", "执行级别");
    expect(screen.getByText("自动化内容生产")).toBeInTheDocument();
    expect(screen.getByText("平台浏览器桥接")).toBeInTheDocument();
    expect(screen.getByText("自定义机器身份")).toBeInTheDocument();
    expect(screen.queryByText("phone")).not.toBeInTheDocument();
    expect(screen.queryByText("owner")).not.toBeInTheDocument();
    expect(screen.queryByText("manual_only")).not.toBeInTheDocument();
    expect(screen.queryByText("ctrip_bridge")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "失效 24小时热线" })).toHaveAttribute(
      "title",
      "标记联系方式失效",
    );
    expect(screen.getByRole("button", { name: "管理 租户负责人" })).toHaveAttribute(
      "title",
      "编辑成员角色与模块",
    );
  });

  it("creates an append-only contact and expires it only with a reason", async () => {
    const onCreateContact = vi.fn(async () => undefined);
    const onExpireContact = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateContact, onExpireContact })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增联系方式" }));
    fireEvent.change(screen.getByLabelText("联系方式类型"), { target: { value: "wechat" } });
    fireEvent.change(screen.getByLabelText("联系方式标签"), { target: { value: "微信咨询" } });
    fireEvent.change(screen.getByLabelText("联系方式值"), { target: { value: "TRAVEL_DEMO_02" } });
    fireEvent.click(screen.getByLabelText("设为主要联系方式"));
    fireEvent.click(screen.getByRole("button", { name: "保存联系方式" }));

    await waitFor(() =>
      expect(onCreateContact).toHaveBeenCalledWith({
        type: "wechat",
        label: "微信咨询",
        value: "TRAVEL_DEMO_02",
        isPrimary: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "失效 24小时热线" }));
    fireEvent.change(screen.getByLabelText("失效原因"), { target: { value: "热线已正式更换" } });
    fireEvent.click(screen.getByRole("button", { name: "确认失效" }));

    await waitFor(() =>
      expect(onExpireContact).toHaveBeenCalledWith(contacts[0]?.id, {
        reason: "热线已正式更换",
      }),
    );
  });

  it("keeps keyboard focus inside a dialog while its submit request is pending", async () => {
    let resolveCreate: (() => void) | undefined;
    const onCreateContact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    render(<TenantGovernance {...props({ onCreateContact })} />);

    const backgroundAction = screen.getByRole("button", { name: "新增成员" });
    fireEvent.click(screen.getByRole("button", { name: "新增联系方式" }));
    fireEvent.change(screen.getByLabelText("联系方式标签"), { target: { value: "客服热线" } });
    fireEvent.change(screen.getByLabelText("联系方式值"), { target: { value: "4000000000" } });

    const submit = screen.getByRole("button", { name: "保存联系方式" });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());

    backgroundAction.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByLabelText("联系方式类型")).toHaveFocus();

    backgroundAction.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByLabelText("设为主要联系方式")).toHaveFocus();

    resolveCreate?.();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("creates a controlled member and submits an audited role change", async () => {
    const onCreateMember = vi.fn(async () => undefined);
    const onUpdateMember = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateMember, onUpdateMember })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增成员" }));
    expect(screen.getByRole("option", { name: "自动化运营" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Automation Operator" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("成员邮箱"), {
      target: { value: "automation@example.com" },
    });
    fireEvent.change(screen.getByLabelText("成员姓名"), { target: { value: "自动化执行员" } });
    fireEvent.change(screen.getByLabelText("成员角色"), {
      target: { value: "automation_operator" },
    });
    fireEvent.change(screen.getByLabelText("初始密码"), {
      target: { value: "replace-this-password-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建成员" }));

    await waitFor(() =>
      expect(onCreateMember).toHaveBeenCalledWith({
        email: "automation@example.com",
        displayName: "自动化执行员",
        role: "automation_operator",
        initialPassword: "replace-this-password-2026",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "管理 租户负责人" }));
    fireEvent.change(screen.getByLabelText("变更后角色"), {
      target: { value: "automation_operator" },
    });
    fireEvent.change(screen.getByLabelText("成员变更原因"), {
      target: { value: "职责调整为自动化执行岗位" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存成员变更" }));

    await waitFor(() =>
      expect(onUpdateMember).toHaveBeenCalledWith(members[0]?.id, {
        role: "automation_operator",
        status: "active",
        reason: "职责调整为自动化执行岗位",
      }),
    );
  });

  it("revokes and grants member modules through the dedicated audited update", async () => {
    const onUpdateMemberModules = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onUpdateMemberModules })} />);

    fireEvent.click(screen.getByRole("button", { name: "管理 租户负责人" }));
    fireEvent.click(screen.getByLabelText("AI 内容创作"));
    fireEvent.click(screen.getByLabelText("多平台分发"));
    fireEvent.click(screen.getByLabelText("Agent 自动化"));
    fireEvent.change(screen.getByLabelText("模块授权变更原因"), {
      target: { value: "灰度开放发布与自动化并撤回内容模块" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模块授权" }));

    await waitFor(() =>
      expect(onUpdateMemberModules).toHaveBeenCalledWith(members[0]?.id, {
        enabledModules: ["priority_distribution", "agent_automation"],
        reason: "灰度开放发布与自动化并撤回内容模块",
      }),
    );
  });

  it("does not show an owner's module grant form to an admin", () => {
    render(<TenantGovernance {...props({ actorRole: "admin" })} />);

    fireEvent.click(screen.getByRole("button", { name: "管理 租户负责人" }));

    expect(screen.getByLabelText("变更后角色")).toBeInTheDocument();
    expect(screen.queryByText("灰度模块授权")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("模块授权变更原因")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存模块授权" })).not.toBeInTheDocument();
  });

  it("activates policies and provisions a server-scoped automation identity", async () => {
    const onTransitionPolicy = vi.fn(async () => undefined);
    const onCreateAutomationPrincipal = vi.fn(async () => undefined);
    render(
      <TenantGovernance
        {...props({ onTransitionPolicy, onCreateAutomationPrincipal, principals: [] })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "激活 travel-v2" }));
    fireEvent.change(screen.getByLabelText("策略变更原因"), {
      target: { value: "审核通过并投入使用" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认策略变更" }));
    await waitFor(() =>
      expect(onTransitionPolicy).toHaveBeenCalledWith(policies[0]?.id, {
        targetStatus: "active",
        reason: "审核通过并投入使用",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "创建自动化身份" }));
    fireEvent.change(screen.getByLabelText("机器身份名称"), {
      target: { value: "producer-second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认创建机器身份" }));
    await waitFor(() =>
      expect(onCreateAutomationPrincipal).toHaveBeenCalledWith({ name: "producer-second" }),
    );
  });

  it("clones the current policy into a constrained audited draft", async () => {
    const onCreatePolicy = vi.fn<TenantGovernanceProps["onCreatePolicy"]>(async () => undefined);
    render(<TenantGovernance {...props({ onCreatePolicy })} />);

    fireEvent.click(screen.getByRole("button", { name: "新建策略版本" }));
    fireEvent.change(screen.getByLabelText("新策略版本"), {
      target: { value: "travel-v3" },
    });
    fireEvent.change(screen.getByLabelText("证据最长有效天数"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("最少事实声明数"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("近重复阻断阈值"), {
      target: { value: "0.82" },
    });
    fireEvent.change(screen.getByLabelText("策略创建原因"), {
      target: { value: "调整证据时效并提高事实覆盖要求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存策略草案" }));

    await waitFor(() => expect(onCreatePolicy).toHaveBeenCalledTimes(1));
    const created = onCreatePolicy.mock.calls[0]?.[0];
    expect(created).toMatchObject({
      version: "travel-v3",
      reason: "调整证据时效并提高事实覆盖要求",
      document: {
        schemaVersion: "geo.audit-policy.v2",
        rulesVersion: "travel-v3",
        industry: "travel",
        contentTemplates: policyDocument.contentTemplates,
        audit: {
          maxEvidenceAgeMs: 45 * 86_400_000,
          minClaims: 2,
          duplicateThreshold: 0.82,
          minDuplicateCharacters: 120,
        },
      },
    });
  });

  it("creates every platform through the compact unattended onboarding form", async () => {
    const onCreateChannelAccount = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateChannelAccount })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增平台账号" }));
    fireEvent.change(screen.getByLabelText("平台"), { target: { value: "sohu" } });
    fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "中通搜狐测试号" } });
    expect(screen.queryByLabelText("Connector 能力")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("能力证据")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() =>
      expect(onCreateChannelAccount).toHaveBeenCalledWith({
        platform: "sohu",
        displayName: "中通搜狐测试号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
        credentialRef: null,
        evidenceType: "manual_import",
        evidenceRefs: [],
        status: "active",
        lastVerifiedAt: null,
      }),
    );
  });

  it("lets operators choose platform execution permissions during onboarding", async () => {
    const onCreateChannelAccount = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateChannelAccount })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增平台账号" }));
    fireEvent.change(screen.getByLabelText("平台"), { target: { value: "toutiao" } });
    fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "头条协助号" } });
    fireEvent.click(screen.getByLabelText("无人值守"));
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() =>
      expect(onCreateChannelAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "toutiao",
          supportedExecutionLevels: ["dry_run", "assisted"],
        }),
      ),
    );
  });

  it("updates the daily publishing quota from account management", async () => {
    const onUpdateChannelAccount = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onUpdateChannelAccount })} />);

    fireEvent.click(
      screen.getByRole("button", { name: `管理平台账号 ${accounts[0]?.displayName}` }),
    );
    expect(screen.getByLabelText("每日发布配额")).toHaveValue(10);
    fireEvent.change(screen.getByLabelText("每日发布配额"), { target: { value: "18" } });
    fireEvent.change(screen.getByLabelText("平台账号变更原因"), {
      target: { value: "调整账号每日发布容量" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() =>
      expect(onUpdateChannelAccount).toHaveBeenCalledWith(
        accounts[0]?.id,
        expect.objectContaining({ dailyPublishQuota: 18 }),
      ),
    );
  });

  it("allows unattended capability for every browser-assisted platform account", () => {
    const ctripAccount: ChannelAccount = {
      id: "10000000-0000-4000-8000-000000000702",
      platform: "ctrip_community",
      displayName: "中通携程社区",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted"],
      evidenceType: "platform_readback",
      evidenceRefs: ["adapter:ctrip-community-browser-unattended-v1"],
      status: "active",
      lastVerifiedAt: "2026-07-25T00:00:00.000Z",
    };
    const { unmount } = render(<TenantGovernance {...props({ accounts: [ctripAccount] })} />);

    fireEvent.click(
      screen.getByRole("button", { name: `管理平台账号 ${ctripAccount.displayName}` }),
    );
    expect(screen.getByLabelText("无人值守")).not.toBeDisabled();

    unmount();
    const sohuAccount: ChannelAccount = {
      ...ctripAccount,
      id: "10000000-0000-4000-8000-000000000703",
      platform: "sohu",
      displayName: "中通搜狐号",
    };
    render(<TenantGovernance {...props({ accounts: [sohuAccount] })} />);
    fireEvent.click(
      screen.getByRole("button", { name: `管理平台账号 ${sohuAccount.displayName}` }),
    );
    expect(screen.getByLabelText("人工辅助")).toBeChecked();
    expect(screen.getByLabelText("无人值守")).not.toBeChecked();
    expect(screen.getByLabelText("无人值守")).not.toBeDisabled();
  });

  it("keeps all governance controls read-only without their capabilities", () => {
    render(
      <TenantGovernance
        {...props({
          capabilities: [
            "tenant:read",
            "content:read",
            "content:write",
            "audit:read",
            "audit:run",
            "publish:request",
            "receipt:read",
            "automation:execute",
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "新增联系方式" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新增成员" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建策略版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建自动化身份" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新增平台账号" })).toBeDisabled();
  });
});
