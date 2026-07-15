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
    value: "4001133986",
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
    prohibitedGuarantees: ["100%保证"],
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
    platform: "toutiao",
    displayName: "中通头条号",
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    evidenceType: "manual_import",
    evidenceRefs: ["ticket:GEO-1"],
    status: "active",
    lastVerifiedAt: "2026-07-15T00:00:00.000Z",
  },
];

const principals: readonly GovernanceServicePrincipal[] = [
  {
    id: "10000000-0000-4000-8000-000000000801",
    tenantId: "10000000-0000-4000-8000-000000000001",
    name: "producer-zhongtong",
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
];

function props(overrides: Partial<TenantGovernanceProps> = {}): TenantGovernanceProps {
  return {
    contacts,
    members,
    policies,
    accounts,
    principals,
    capabilities: ["tenant:manage", "member:manage", "principal:manage"],
    onCreateContact: vi.fn(async () => undefined),
    onExpireContact: vi.fn(async () => undefined),
    onCreateMember: vi.fn(async () => undefined),
    onUpdateMember: vi.fn(async () => undefined),
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
  it("creates an append-only contact and expires it only with a reason", async () => {
    const onCreateContact = vi.fn(async () => undefined);
    const onExpireContact = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateContact, onExpireContact })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增联系方式" }));
    fireEvent.change(screen.getByLabelText("联系方式类型"), { target: { value: "wechat" } });
    fireEvent.change(screen.getByLabelText("联系方式标签"), { target: { value: "微信咨询" } });
    fireEvent.change(screen.getByLabelText("联系方式值"), { target: { value: "ZTGL6431" } });
    fireEvent.click(screen.getByLabelText("设为主要联系方式"));
    fireEvent.click(screen.getByRole("button", { name: "保存联系方式" }));

    await waitFor(() =>
      expect(onCreateContact).toHaveBeenCalledWith({
        type: "wechat",
        label: "微信咨询",
        value: "ZTGL6431",
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

  it("creates a controlled member and submits an audited role change", async () => {
    const onCreateMember = vi.fn(async () => undefined);
    const onUpdateMember = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateMember, onUpdateMember })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增成员" }));
    fireEvent.change(screen.getByLabelText("成员邮箱"), {
      target: { value: "editor@example.com" },
    });
    fireEvent.change(screen.getByLabelText("成员姓名"), { target: { value: "内容编辑" } });
    fireEvent.change(screen.getByLabelText("成员角色"), { target: { value: "editor" } });
    fireEvent.change(screen.getByLabelText("初始密码"), {
      target: { value: "replace-this-password-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建成员" }));

    await waitFor(() =>
      expect(onCreateMember).toHaveBeenCalledWith({
        email: "editor@example.com",
        displayName: "内容编辑",
        role: "editor",
        initialPassword: "replace-this-password-2026",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "管理 租户负责人" }));
    fireEvent.change(screen.getByLabelText("变更后角色"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("成员变更原因"), {
      target: { value: "职责调整并保留管理权限" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存成员变更" }));

    await waitFor(() =>
      expect(onUpdateMember).toHaveBeenCalledWith(members[0]?.id, {
        role: "admin",
        status: "active",
        reason: "职责调整并保留管理权限",
      }),
    );
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

  it("creates manual-only accounts with dry-run as the only execution level", async () => {
    const onCreateChannelAccount = vi.fn(async () => undefined);
    render(<TenantGovernance {...props({ onCreateChannelAccount })} />);

    fireEvent.click(screen.getByRole("button", { name: "新增平台账号" }));
    fireEvent.change(screen.getByLabelText("平台"), { target: { value: "sohu" } });
    fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "中通搜狐号" } });
    fireEvent.change(screen.getByLabelText("能力证据"), {
      target: { value: "ticket:GEO-88" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存平台账号" }));

    await waitFor(() =>
      expect(onCreateChannelAccount).toHaveBeenCalledWith({
        platform: "sohu",
        displayName: "中通搜狐号",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        credentialRef: null,
        evidenceType: "manual_import",
        evidenceRefs: ["ticket:GEO-88"],
        status: "needs_verification",
        lastVerifiedAt: null,
      }),
    );
  });

  it("keeps all governance controls read-only without their capabilities", () => {
    render(<TenantGovernance {...props({ capabilities: [] })} />);

    expect(screen.getByRole("button", { name: "新增联系方式" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新增成员" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建策略版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建自动化身份" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新增平台账号" })).toBeDisabled();
  });
});
