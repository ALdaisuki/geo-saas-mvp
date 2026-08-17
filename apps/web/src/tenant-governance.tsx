import {
  Ban,
  Bot,
  Check,
  CirclePower,
  LoaderCircle,
  Pencil,
  Plus,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Platform } from "@geo/contracts";

import type {
  ChannelAccount,
  PolicyBundle,
  ServicePrincipal,
  TenantContact,
  TenantMember,
} from "./api.js";
import {
  accountDisplayNameLabel,
  CONNECTOR_CAPABILITY_OPTIONS,
  EVIDENCE_TYPE_OPTIONS,
  MEMBER_ROLE_OPTIONS,
  connectorCapabilityLabel,
  executionLevelLabel,
  memberRoleLabel,
  operationStatusLabel,
} from "./operation-labels.js";
import { useModalDialog } from "./use-modal-dialog.js";

export type GovernanceServicePrincipal = ServicePrincipal;

export interface CreateContactInput {
  readonly type: "phone" | "wechat" | "email" | "website" | "address";
  readonly label: string;
  readonly value: string;
  readonly isPrimary: boolean;
}

export interface ExpireContactInput {
  readonly reason: string;
}

export interface CreateMemberInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly initialPassword: string;
}

export interface UpdateMemberInput {
  readonly role: string;
  readonly status: "active" | "suspended";
  readonly reason: string;
}

export interface UpdateMemberModulesInput {
  readonly enabledModules: readonly string[];
  readonly reason: string;
}

export interface PolicyTransitionInput {
  readonly targetStatus: "active" | "retired";
  readonly reason: string;
}

export interface CreatePolicyInput {
  readonly version: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface CreateChannelAccountInput {
  readonly platform: Platform;
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly credentialRef: string | null;
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled";
  readonly lastVerifiedAt: string | null;
}

export interface UpdateChannelAccountInput {
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly credentialRef?: string | null;
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled";
  readonly lastVerifiedAt?: string | null;
  readonly reason: string;
}

export interface PrincipalStatusInput {
  readonly status: "active" | "disabled";
  readonly reason: string;
}

export interface TenantGovernanceProps {
  readonly contacts: readonly TenantContact[];
  readonly members: readonly TenantMember[];
  readonly policies: readonly PolicyBundle[];
  readonly accounts: readonly ChannelAccount[];
  readonly principals: readonly GovernanceServicePrincipal[];
  readonly actorRole: string;
  readonly capabilities: readonly string[];
  readonly showPriorityDistribution: boolean;
  readonly showAgentAutomation: boolean;
  readonly onCreateContact: (input: CreateContactInput) => Promise<void>;
  readonly onExpireContact: (contactId: string, input: ExpireContactInput) => Promise<void>;
  readonly onCreateMember: (input: CreateMemberInput) => Promise<void>;
  readonly onUpdateMember: (memberId: string, input: UpdateMemberInput) => Promise<void>;
  readonly onUpdateMemberModules: (
    memberId: string,
    input: UpdateMemberModulesInput,
  ) => Promise<void>;
  readonly onCreatePolicy: (input: CreatePolicyInput) => Promise<void>;
  readonly onTransitionPolicy: (policyId: string, input: PolicyTransitionInput) => Promise<void>;
  readonly onCreateChannelAccount: (input: CreateChannelAccountInput) => Promise<void>;
  readonly onUpdateChannelAccount: (
    accountId: string,
    input: UpdateChannelAccountInput,
  ) => Promise<void>;
  readonly onCreateAutomationPrincipal: (input: { readonly name: string }) => Promise<void>;
  readonly onSetPrincipalStatus: (
    principalId: string,
    input: PrincipalStatusInput,
  ) => Promise<void>;
  readonly onChanged?: () => void;
}

type CreateForm = "contact" | "member" | "policy" | "account" | "principal" | null;
type ActionIntent =
  | { readonly type: "expire-contact"; readonly contact: TenantContact }
  | { readonly type: "member"; readonly member: TenantMember }
  | {
      readonly type: "policy";
      readonly policy: PolicyBundle;
      readonly targetStatus: "active" | "retired";
    }
  | {
      readonly type: "principal";
      readonly principal: GovernanceServicePrincipal;
      readonly status: "active" | "disabled";
    }
  | { readonly type: "account"; readonly account: ChannelAccount };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "治理操作失败";
}

function splitEvidence(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function finiteFormNumber(data: FormData, name: string): number {
  const value = Number(data.get(name));
  if (!Number.isFinite(value)) throw new TypeError(`${name} 必须是有效数字`);
  return value;
}

function platformLabel(platform: string): string {
  if (platform === "toutiao") return "头条号";
  if (platform === "sohu") return "搜狐号";
  if (platform === "baijiahao") return "百家号";
  if (platform === "netease") return "网易号";
  if (platform === "ctrip_community") return "携程社区";
  if (platform === "zhihu") return "知乎";
  return platform;
}

function contactTypeLabel(type: TenantContact["type"]): string {
  const labels: Readonly<Record<TenantContact["type"], string>> = {
    phone: "电话",
    wechat: "微信",
    email: "邮箱",
    website: "官网",
    address: "地址",
  };
  return labels[type] ?? type;
}

function principalProfileLabel(profile: string): string {
  const labels: Readonly<Record<string, string>> = {
    custom: "自定义机器身份",
    automation_producer: "自动化内容生产",
    ctrip_bridge: "平台浏览器桥接",
  };
  return labels[profile] ?? profile;
}

function statusTone(status: string): "positive" | "warning" | "neutral" | "danger" {
  if (status === "active") return "positive";
  if (status === "draft" || status === "not_issued" || status === "suspended") return "warning";
  if (status === "expired" || status === "revoked") return "danger";
  return "neutral";
}

function GovernanceBadge({
  children,
  tone = "neutral",
  title,
}: {
  readonly children: ReactNode;
  readonly tone?: "positive" | "warning" | "neutral" | "danger";
  readonly title?: string;
}) {
  return (
    <span className={`governance-badge governance-badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const MEMBER_MODULE_OPTIONS = [
  { key: "trend_discovery", label: "热点发现" },
  { key: "ai_content", label: "AI 内容创作" },
  { key: "priority_distribution", label: "多平台分发" },
  { key: "agent_automation", label: "Agent 自动化" },
] as const;

function GovernanceHeader({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="governance-section-heading">
      <h3>{title}</h3>
      {action}
    </div>
  );
}

function Dialog({
  title,
  pending,
  onClose,
  children,
}: {
  readonly title: string;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const dialogRef = useModalDialog<HTMLElement>(pending ? null : onClose);
  return (
    <div className="governance-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="governance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h3>{title}</h3>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            title="关闭"
            disabled={pending}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function SubmitButton({ label, pending }: { readonly label: string; readonly pending: boolean }) {
  return (
    <button className="button-primary" type="submit" disabled={pending}>
      {pending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
      {label}
    </button>
  );
}

export function TenantGovernance(props: TenantGovernanceProps) {
  const [createForm, setCreateForm] = useState<CreateForm>(null);
  const [intent, setIntent] = useState<ActionIntent | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const canManageTenant = props.capabilities.includes("tenant:manage");
  const canManageMembers = props.capabilities.includes("member:manage");
  const canManagePrincipals = props.capabilities.includes("principal:manage");
  const basePolicy =
    props.policies.find((policy) => policy.status === "active") ?? props.policies[0];

  async function perform(operation: () => Promise<void>, success: string): Promise<boolean> {
    setPending(true);
    setFeedback(null);
    try {
      await operation();
      setFeedback({ tone: "success", text: success });
      props.onChanged?.();
      return true;
    } catch (error) {
      setFeedback({ tone: "error", text: errorText(error) });
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="tenant-governance">
      {feedback === null ? null : (
        <div
          className={`governance-feedback governance-feedback-${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </div>
      )}

      <section className="governance-section">
        <GovernanceHeader
          title="联系方式"
          action={
            <button
              className="button-secondary"
              type="button"
              disabled={!canManageTenant}
              onClick={() => setCreateForm("contact")}
            >
              <Plus size={16} /> 新增联系方式
            </button>
          }
        />
        <div className="governance-rows">
          {props.contacts.map((contact) => (
            <div className="governance-row" key={contact.id}>
              <div className="governance-row-primary">
                <strong>{contact.label}</strong>
                <span>{contact.value}</span>
              </div>
              <div className="governance-row-meta">
                <GovernanceBadge title="联系方式类型">
                  {contactTypeLabel(contact.type)}
                </GovernanceBadge>
                <GovernanceBadge
                  tone={contact.validUntil === null ? "positive" : "neutral"}
                  title="联系方式状态"
                >
                  {contact.validUntil === null ? "有效" : "已失效"}
                </GovernanceBadge>
              </div>
              <button
                className="icon-button governance-row-action governance-row-action-danger"
                type="button"
                aria-label={`失效 ${contact.label}`}
                title="标记联系方式失效"
                disabled={!canManageTenant || contact.validUntil !== null}
                onClick={() => setIntent({ type: "expire-contact", contact })}
              >
                <Ban aria-hidden="true" size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="governance-section">
        <GovernanceHeader
          title="成员与角色"
          action={
            <button
              className="button-secondary"
              type="button"
              disabled={!canManageMembers}
              onClick={() => setCreateForm("member")}
            >
              <UserPlus size={16} /> 新增成员
            </button>
          }
        />
        <div className="governance-rows">
          {props.members.map((member) => (
            <div className="governance-row" key={member.id}>
              <div className="governance-row-primary">
                <strong>{accountDisplayNameLabel(member.displayName)}</strong>
                <span>{member.email}</span>
              </div>
              <div className="governance-row-meta">
                <GovernanceBadge title="成员角色">{memberRoleLabel(member.role)}</GovernanceBadge>
                <GovernanceBadge tone={statusTone(member.status)} title="成员状态">
                  {operationStatusLabel(member.status)}
                </GovernanceBadge>
              </div>
              <button
                className="icon-button governance-row-action"
                type="button"
                aria-label={`管理 ${accountDisplayNameLabel(member.displayName)}`}
                title="编辑成员角色与模块"
                disabled={!canManageMembers}
                onClick={() => setIntent({ type: "member", member })}
              >
                <Pencil aria-hidden="true" size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="governance-section">
        <GovernanceHeader
          title="审计策略"
          action={
            <button
              className="button-secondary"
              type="button"
              disabled={!canManageTenant || basePolicy === undefined}
              onClick={() => setCreateForm("policy")}
            >
              <Plus size={16} /> 新建策略版本
            </button>
          }
        />
        <div className="governance-rows">
          {props.policies.map((policy) => (
            <div className="governance-row" key={policy.id}>
              <div className="governance-row-primary">
                <strong>{policy.version}</strong>
                <span>{policy.policyHash.slice(0, 12)}</span>
              </div>
              <div className="governance-row-meta">
                <GovernanceBadge tone={statusTone(policy.status)} title="策略状态">
                  {operationStatusLabel(policy.status)}
                </GovernanceBadge>
              </div>
              <div className="governance-actions">
                {policy.status === "draft" ? (
                  <button
                    className="button-secondary"
                    type="button"
                    aria-label={`激活 ${policy.version}`}
                    disabled={!canManageTenant}
                    onClick={() => setIntent({ type: "policy", policy, targetStatus: "active" })}
                  >
                    <ShieldCheck size={16} /> 激活
                  </button>
                ) : null}
                {policy.status === "active" ? (
                  <button
                    className="button-secondary"
                    type="button"
                    aria-label={`退休 ${policy.version}`}
                    disabled={!canManageTenant}
                    onClick={() => setIntent({ type: "policy", policy, targetStatus: "retired" })}
                  >
                    <Ban size={16} /> 退休
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {props.showPriorityDistribution ? (
        <section className="governance-section">
          <GovernanceHeader
            title="平台账号"
            action={
              <button
                className="button-secondary"
                type="button"
                disabled={!canManageTenant}
                onClick={() => setCreateForm("account")}
              >
                <Plus size={16} /> 新增平台账号
              </button>
            }
          />
          <div className="governance-rows">
            {props.accounts.map((account) => (
              <div className="governance-row" key={account.id}>
                <div className="governance-row-primary">
                  <strong>{accountDisplayNameLabel(account.displayName)}</strong>
                  <span>{platformLabel(account.platform)}</span>
                </div>
                <div className="governance-row-meta">
                  <GovernanceBadge title="连接方式">
                    {connectorCapabilityLabel(account.capability)}
                  </GovernanceBadge>
                  <GovernanceBadge title="执行级别">
                    {account.supportedExecutionLevels.map(executionLevelLabel).join(" / ")}
                  </GovernanceBadge>
                  <GovernanceBadge tone={statusTone(account.status)} title="账号状态">
                    {operationStatusLabel(account.status)}
                  </GovernanceBadge>
                </div>
                <button
                  className="icon-button governance-row-action"
                  type="button"
                  aria-label={`管理平台账号 ${accountDisplayNameLabel(account.displayName)}`}
                  title="编辑平台账号"
                  disabled={!canManageTenant}
                  onClick={() => setIntent({ type: "account", account })}
                >
                  <Pencil aria-hidden="true" size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {props.showAgentAutomation ? (
        <section className="governance-section">
          <GovernanceHeader
            title="自动化机器身份"
            action={
              <button
                className="button-secondary"
                type="button"
                disabled={!canManagePrincipals}
                onClick={() => setCreateForm("principal")}
              >
                <Bot size={16} /> 创建自动化身份
              </button>
            }
          />
          <div className="governance-rows">
            {props.principals.map((principal) => (
              <div className="governance-row" key={principal.id}>
                <div className="governance-row-primary">
                  <strong>{accountDisplayNameLabel(principal.name)}</strong>
                  <span>{principalProfileLabel(principal.profile)}</span>
                </div>
                <div className="governance-row-meta">
                  <GovernanceBadge title="权限范围">
                    {principal.capabilities.length} 项最小权限
                  </GovernanceBadge>
                  <GovernanceBadge tone={statusTone(principal.credentialStatus)} title="凭据状态">
                    {operationStatusLabel(principal.credentialStatus)}
                  </GovernanceBadge>
                  <GovernanceBadge tone={statusTone(principal.status)} title="机器身份状态">
                    {operationStatusLabel(principal.status)}
                  </GovernanceBadge>
                </div>
                <button
                  className={`icon-button governance-row-action ${
                    principal.status === "active"
                      ? "governance-row-action-danger"
                      : "governance-row-action-enable"
                  }`}
                  type="button"
                  aria-label={`${principal.status === "active" ? "停用" : "启用"} ${accountDisplayNameLabel(principal.name)}`}
                  title={principal.status === "active" ? "停用机器身份" : "启用机器身份"}
                  disabled={!canManagePrincipals}
                  onClick={() =>
                    setIntent({
                      type: "principal",
                      principal,
                      status: principal.status === "active" ? "disabled" : "active",
                    })
                  }
                >
                  <CirclePower aria-hidden="true" size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {createForm === "contact" ? (
        <Dialog title="新增联系方式" pending={pending} onClose={() => setCreateForm(null)}>
          <form
            className="governance-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void perform(
                () =>
                  props.onCreateContact({
                    type: String(data.get("type")) as CreateContactInput["type"],
                    label: String(data.get("label")),
                    value: String(data.get("value")),
                    isPrimary: data.get("isPrimary") === "on",
                  }),
                "联系方式已追加",
              ).then((ok) => {
                if (ok) setCreateForm(null);
              });
            }}
          >
            <label>
              联系方式类型
              <select name="type" defaultValue="phone">
                <option value="phone">电话</option>
                <option value="wechat">微信</option>
                <option value="email">邮箱</option>
                <option value="website">网站</option>
                <option value="address">地址</option>
              </select>
            </label>
            <label>
              联系方式标签
              <input name="label" required maxLength={100} />
            </label>
            <label>
              联系方式值
              <input name="value" required maxLength={500} />
            </label>
            <label className="governance-checkbox">
              <input name="isPrimary" type="checkbox" />
              设为主要联系方式
            </label>
            <div className="governance-dialog-actions">
              <SubmitButton label="保存联系方式" pending={pending} />
            </div>
          </form>
        </Dialog>
      ) : null}

      {createForm === "member" ? (
        <Dialog title="新增成员" pending={pending} onClose={() => setCreateForm(null)}>
          <form
            className="governance-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void perform(
                () =>
                  props.onCreateMember({
                    email: String(data.get("email")),
                    displayName: String(data.get("displayName")),
                    role: String(data.get("role")),
                    initialPassword: String(data.get("initialPassword")),
                  }),
                "成员已创建",
              ).then((ok) => {
                if (ok) setCreateForm(null);
              });
            }}
          >
            <label>
              成员邮箱
              <input name="email" type="email" required maxLength={320} />
            </label>
            <label>
              成员姓名
              <input name="displayName" required maxLength={200} />
            </label>
            <label>
              成员角色
              <select name="role" defaultValue="editor">
                {MEMBER_ROLE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              初始密码
              <input
                name="initialPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
              />
            </label>
            <div className="governance-dialog-actions">
              <SubmitButton label="创建成员" pending={pending} />
            </div>
          </form>
        </Dialog>
      ) : null}

      {createForm === "policy" && basePolicy !== undefined ? (
        <PolicyDraftDialog
          basePolicy={basePolicy}
          pending={pending}
          onClose={() => setCreateForm(null)}
          onSubmit={(input) =>
            perform(() => props.onCreatePolicy(input), "策略草案已创建").then((ok) => {
              if (ok) setCreateForm(null);
            })
          }
        />
      ) : null}

      {props.showPriorityDistribution && createForm === "account" ? (
        <ChannelAccountDialog
          title="新增平台账号"
          pending={pending}
          onClose={() => setCreateForm(null)}
          onSubmit={(input) =>
            perform(
              () => props.onCreateChannelAccount(createChannelAccountInput(input)),
              "平台账号已创建",
            ).then((ok) => {
              if (ok) setCreateForm(null);
            })
          }
        />
      ) : null}

      {props.showAgentAutomation && createForm === "principal" ? (
        <Dialog title="创建自动化身份" pending={pending} onClose={() => setCreateForm(null)}>
          <form
            className="governance-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void perform(
                () => props.onCreateAutomationPrincipal({ name: String(data.get("name")) }),
                "自动化身份已创建",
              ).then((ok) => {
                if (ok) setCreateForm(null);
              });
            }}
          >
            <label>
              机器身份名称
              <input name="name" required maxLength={200} />
            </label>
            <div className="governance-principal-profile">
              <Bot size={18} />
              <div>
                <strong>自动化内容生产</strong>
                <span>内容生成、审计、演练发布请求和自动化执行</span>
              </div>
            </div>
            <div className="governance-dialog-actions">
              <SubmitButton label="确认创建机器身份" pending={pending} />
            </div>
          </form>
        </Dialog>
      ) : null}

      {intent?.type === "expire-contact" ? (
        <ReasonDialog
          title={`失效 ${intent.contact.label}`}
          reasonLabel="失效原因"
          submitLabel="确认失效"
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(reason) =>
            perform(
              () => props.onExpireContact(intent.contact.id, { reason }),
              "联系方式已失效",
            ).then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}

      {intent?.type === "policy" ? (
        <ReasonDialog
          title={`${intent.targetStatus === "active" ? "激活" : "退休"} ${intent.policy.version}`}
          reasonLabel="策略变更原因"
          submitLabel="确认策略变更"
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(reason) =>
            perform(
              () =>
                props.onTransitionPolicy(intent.policy.id, {
                  targetStatus: intent.targetStatus,
                  reason,
                }),
              "策略状态已更新",
            ).then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}

      {props.showAgentAutomation && intent?.type === "principal" ? (
        <ReasonDialog
          title={`${intent.status === "active" ? "启用" : "停用"} ${intent.principal.name}`}
          reasonLabel="机器身份变更原因"
          submitLabel="确认机器身份变更"
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(reason) =>
            perform(
              () =>
                props.onSetPrincipalStatus(intent.principal.id, { status: intent.status, reason }),
              "机器身份状态已更新",
            ).then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}

      {intent?.type === "member" ? (
        <MemberDialog
          member={intent.member}
          showModuleForm={props.actorRole === "owner" || intent.member.role !== "owner"}
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(input) =>
            perform(() => props.onUpdateMember(intent.member.id, input), "成员权限已更新").then(
              (ok) => {
                if (ok) setIntent(null);
              },
            )
          }
          onSubmitModules={(input) =>
            perform(
              () => props.onUpdateMemberModules(intent.member.id, input),
              "成员模块授权已更新",
            ).then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}

      {props.showPriorityDistribution && intent?.type === "account" ? (
        <ChannelAccountDialog
          title={`管理 ${intent.account.displayName}`}
          account={intent.account}
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(input) =>
            perform(
              () =>
                props.onUpdateChannelAccount(intent.account.id, updateChannelAccountInput(input)),
              "平台账号已更新",
            ).then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}
    </div>
  );
}

function PolicyDraftDialog({
  basePolicy,
  pending,
  onClose,
  onSubmit,
}: {
  readonly basePolicy: PolicyBundle;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreatePolicyInput) => Promise<void>;
}) {
  const audit = objectValue(basePolicy.document.audit);
  const artifactTtlHours = Number(audit.artifactTtlMs ?? 3_600_000) / 3_600_000;
  const evidenceAgeDays = Number(audit.maxEvidenceAgeMs ?? 30 * 86_400_000) / 86_400_000;
  const minClaims = Number(audit.minClaims ?? 0);
  const duplicateThreshold = Number(audit.duplicateThreshold ?? 0.88);
  const minDuplicateCharacters = Number(audit.minDuplicateCharacters ?? 0);

  return (
    <Dialog title="新建审计策略版本" pending={pending} onClose={onClose}>
      <form
        className="governance-form governance-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const version = String(data.get("version")).trim();
          void onSubmit({
            version,
            reason: String(data.get("reason")).trim(),
            document: {
              ...basePolicy.document,
              rulesVersion: version,
              audit: {
                ...audit,
                artifactTtlMs: Math.round(finiteFormNumber(data, "artifactTtlHours") * 3_600_000),
                maxEvidenceAgeMs: Math.round(
                  finiteFormNumber(data, "maxEvidenceAgeDays") * 86_400_000,
                ),
                minClaims: Math.round(finiteFormNumber(data, "minClaims")),
                duplicateThreshold: finiteFormNumber(data, "duplicateThreshold"),
                minDuplicateCharacters: Math.round(
                  finiteFormNumber(data, "minDuplicateCharacters"),
                ),
              },
            },
          });
        }}
      >
        <label>
          基于策略版本
          <input value={basePolicy.version} readOnly />
        </label>
        <label>
          新策略版本
          <input name="version" required minLength={1} maxLength={100} />
        </label>
        <label>
          审计结果有效小时数
          <input
            name="artifactTtlHours"
            type="number"
            required
            min={0.25}
            max={720}
            step={0.25}
            defaultValue={artifactTtlHours}
          />
        </label>
        <label>
          证据最长有效天数
          <input
            name="maxEvidenceAgeDays"
            type="number"
            required
            min={1}
            max={3650}
            step={1}
            defaultValue={evidenceAgeDays}
          />
        </label>
        <label>
          最少事实声明数
          <input
            name="minClaims"
            type="number"
            required
            min={0}
            max={100}
            defaultValue={minClaims}
          />
        </label>
        <label>
          近重复阻断阈值
          <input
            name="duplicateThreshold"
            type="number"
            required
            min={0.01}
            max={1}
            step={0.01}
            defaultValue={duplicateThreshold}
          />
        </label>
        <label>
          近重复最少字符数
          <input
            name="minDuplicateCharacters"
            type="number"
            required
            min={0}
            max={100000}
            step={1}
            defaultValue={minDuplicateCharacters}
          />
        </label>
        <label className="governance-form-wide">
          策略创建原因
          <textarea name="reason" required minLength={3} maxLength={1_000} rows={3} />
        </label>
        <div className="governance-dialog-actions governance-form-wide">
          <SubmitButton label="保存策略草案" pending={pending} />
        </div>
      </form>
    </Dialog>
  );
}

function ReasonDialog({
  title,
  reasonLabel,
  submitLabel,
  pending,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly reasonLabel: string;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => Promise<void>;
}) {
  return (
    <Dialog title={title} pending={pending} onClose={onClose}>
      <form
        className="governance-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void onSubmit(String(data.get("reason")));
        }}
      >
        <label>
          {reasonLabel}
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
        </label>
        <div className="governance-dialog-actions">
          <SubmitButton label={submitLabel} pending={pending} />
        </div>
      </form>
    </Dialog>
  );
}

function MemberDialog({
  member,
  showModuleForm,
  pending,
  onClose,
  onSubmit,
  onSubmitModules,
}: {
  readonly member: TenantMember;
  readonly showModuleForm: boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: UpdateMemberInput) => Promise<void>;
  readonly onSubmitModules: (input: UpdateMemberModulesInput) => Promise<void>;
}) {
  return (
    <Dialog title={`管理 ${member.displayName}`} pending={pending} onClose={onClose}>
      <form
        className="governance-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void onSubmit({
            role: String(data.get("role")),
            status: String(data.get("status")) as UpdateMemberInput["status"],
            reason: String(data.get("reason")),
          });
        }}
      >
        <label>
          变更后角色
          <select name="role" defaultValue={member.role}>
            {MEMBER_ROLE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          成员状态
          <select name="status" defaultValue={member.status}>
            <option value="active">启用</option>
            <option value="suspended">暂停</option>
          </select>
        </label>
        <label>
          成员变更原因
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
        </label>
        <div className="governance-dialog-actions">
          <SubmitButton label="保存成员变更" pending={pending} />
        </div>
      </form>
      {showModuleForm ? (
        <form
          className="governance-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void onSubmitModules({
              enabledModules: data.getAll("enabledModules").map(String),
              reason: String(data.get("moduleReason")),
            });
          }}
        >
          <fieldset>
            <legend>灰度模块授权</legend>
            {MEMBER_MODULE_OPTIONS.map((module) => (
              <label key={module.key}>
                <input
                  type="checkbox"
                  name="enabledModules"
                  value={module.key}
                  defaultChecked={member.enabledModules.includes(module.key)}
                />
                {module.label}
              </label>
            ))}
          </fieldset>
          <label>
            模块授权变更原因
            <textarea name="moduleReason" required minLength={3} maxLength={500} rows={3} />
          </label>
          <div className="governance-dialog-actions">
            <SubmitButton label="保存模块授权" pending={pending} />
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

export type AccountDialogInput = Omit<
  CreateChannelAccountInput,
  "credentialRef" | "lastVerifiedAt"
> & {
  readonly credentialRef?: string | null;
  readonly lastVerifiedAt?: string | null;
  readonly dailyPublishQuota?: number;
  readonly reason?: string;
};

function selectedExecutionLevels(assisted: boolean, unattended: boolean): string[] {
  const levels = ["dry_run"];
  if (assisted) levels.push("assisted");
  if (unattended) levels.push("unattended");
  return levels;
}

export function createChannelAccountInput(input: AccountDialogInput): CreateChannelAccountInput {
  return {
    platform: input.platform,
    displayName: input.displayName,
    capability: input.capability,
    supportedExecutionLevels: input.supportedExecutionLevels,
    credentialRef: input.credentialRef ?? null,
    evidenceType: input.evidenceType,
    evidenceRefs: input.evidenceRefs,
    status: input.status,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
  };
}

export function updateChannelAccountInput(input: AccountDialogInput): UpdateChannelAccountInput {
  return {
    displayName: input.displayName,
    capability: input.capability,
    supportedExecutionLevels: input.supportedExecutionLevels,
    ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
    evidenceType: input.evidenceType,
    evidenceRefs: input.evidenceRefs,
    status: input.status,
    ...(input.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: input.lastVerifiedAt }),
    ...(input.dailyPublishQuota === undefined
      ? {}
      : { dailyPublishQuota: input.dailyPublishQuota }),
    reason: input.reason ?? "平台账号元数据更新",
  };
}

export function ChannelAccountDialog({
  title,
  account,
  initialPlatform,
  onboardingPlatform,
  pending,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly account?: ChannelAccount;
  readonly initialPlatform?: CreateChannelAccountInput["platform"];
  readonly onboardingPlatform?: CreateChannelAccountInput["platform"];
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: AccountDialogInput) => Promise<void>;
}) {
  const [platform, setPlatform] = useState<CreateChannelAccountInput["platform"]>(
    (account?.platform ??
      initialPlatform ??
      "ctrip_community") as CreateChannelAccountInput["platform"],
  );
  const initialPlatformValue = account?.platform ?? initialPlatform ?? "ctrip_community";
  const [capability, setCapability] = useState(account?.capability ?? "browser_assisted");
  const [assisted, setAssisted] = useState(
    account?.supportedExecutionLevels.includes("assisted") ?? true,
  );
  const [unattended, setUnattended] = useState(
    account?.supportedExecutionLevels.includes("unattended") ?? true,
  );
  const editing = account !== undefined;
  if (!editing) {
    return (
      <Dialog title={title} pending={pending} onClose={onClose}>
        <form
          className="governance-form governance-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void onSubmit({
              platform,
              displayName: String(data.get("displayName")),
              capability: "browser_assisted",
              supportedExecutionLevels: selectedExecutionLevels(assisted, unattended),
              credentialRef: null,
              evidenceType: "manual_import",
              evidenceRefs: [],
              status: "active",
              lastVerifiedAt: null,
            });
          }}
        >
          <label>
            平台
            <select
              name="platform"
              value={platform}
              onChange={(event) =>
                setPlatform(event.target.value as CreateChannelAccountInput["platform"])
              }
              disabled={onboardingPlatform !== undefined}
            >
              <option value="toutiao">{platformLabel("toutiao")}</option>
              <option value="sohu">{platformLabel("sohu")}</option>
              <option value="baijiahao">{platformLabel("baijiahao")}</option>
              <option value="netease">{platformLabel("netease")}</option>
              <option value="ctrip_community">{platformLabel("ctrip_community")}</option>
              <option value="zhihu">{platformLabel("zhihu")}</option>
            </select>
          </label>
          <label>
            账号名称
            <input name="displayName" required maxLength={200} />
          </label>
          <fieldset className="governance-execution-levels governance-form-wide">
            <legend>平台权限</legend>
            <p className="governance-field-help">
              {platformLabel(platform)}
              "账号可按需开放演练、人工协助或无人值守；无人值守仍需完成登录、提交证据和公开回读校验。"
            </p>
            <label className="governance-checkbox">
              <input type="checkbox" checked readOnly /> {executionLevelLabel("dry_run")}
            </label>
            <label className="governance-checkbox">
              <input
                type="checkbox"
                checked={assisted}
                onChange={(event) => setAssisted(event.target.checked)}
              />
              {executionLevelLabel("assisted")}
            </label>
            <label className="governance-checkbox">
              <input
                type="checkbox"
                checked={unattended}
                onChange={(event) => setUnattended(event.target.checked)}
              />
              {executionLevelLabel("unattended")}
            </label>
          </fieldset>
          <div className="governance-dialog-actions governance-form-wide">
            <SubmitButton label="保存平台账号" pending={pending} />
          </div>
        </form>
      </Dialog>
    );
  }
  return (
    <Dialog title={title} pending={pending} onClose={onClose}>
      <form
        className="governance-form governance-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const supportedExecutionLevels =
            capability === "manual_only" || capability === "disabled"
              ? selectedExecutionLevels(assisted, false)
              : selectedExecutionLevels(assisted, unattended);
          const credentialRef = String(data.get("credentialRef")).trim();
          const dailyPublishQuota = data.get("dailyPublishQuota");
          void onSubmit({
            platform,
            displayName: String(data.get("displayName")),
            capability,
            supportedExecutionLevels,
            ...(credentialRef === ""
              ? editing
                ? {}
                : { credentialRef: null }
              : { credentialRef }),
            evidenceType: String(data.get("evidenceType")),
            evidenceRefs: splitEvidence(String(data.get("evidenceRefs"))),
            status: String(data.get("status")) as CreateChannelAccountInput["status"],
            ...(editing ? {} : { lastVerifiedAt: null }),
            ...(editing && dailyPublishQuota !== null
              ? { dailyPublishQuota: Number(dailyPublishQuota) }
              : {}),
            ...(editing ? { reason: String(data.get("reason")) } : {}),
          });
        }}
      >
        <label>
          平台
          <select
            name="platform"
            value={platform}
            onChange={(event) => {
              const nextPlatform = event.target.value as CreateChannelAccountInput["platform"];
              setPlatform(nextPlatform);
              setCapability("browser_assisted");
              setAssisted(nextPlatform !== "zhihu");
              setUnattended(nextPlatform !== "zhihu");
            }}
            disabled={editing}
          >
            <option value="toutiao">头条号</option>
            <option value="sohu">搜狐号</option>
            <option value="baijiahao">百家号</option>
            <option value="netease">网易号</option>
            <option value="ctrip_community">携程社区</option>
            <option value="zhihu">知乎</option>
          </select>
        </label>
        <label>
          账号名称
          <input
            name="displayName"
            defaultValue={account?.displayName ?? ""}
            required
            maxLength={200}
          />
        </label>
        <label>
          连接能力
          <select
            name="capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
          >
            {CONNECTOR_CAPABILITY_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="governance-execution-levels">
          <legend>执行级别</legend>
          <label className="governance-checkbox">
            <input type="checkbox" checked readOnly /> {executionLevelLabel("dry_run")}
          </label>
          <label className="governance-checkbox">
            <input
              name="assisted"
              type="checkbox"
              checked={assisted}
              onChange={(event) => setAssisted(event.target.checked)}
              disabled={capability === "manual_only" || capability === "disabled"}
            />
            {executionLevelLabel("assisted")}
          </label>
          <label className="governance-checkbox">
            <input
              name="unattended"
              type="checkbox"
              checked={unattended}
              onChange={(event) => setUnattended(event.target.checked)}
              disabled={
                capability === "manual_only" || capability === "disabled"
              }
            />
            {executionLevelLabel("unattended")}
          </label>
        </fieldset>
        <label>
          凭据引用
          <input
            name="credentialRef"
            defaultValue=""
            maxLength={1000}
            placeholder={editing ? "未修改" : undefined}
          />
        </label>
        <label>
          证据类型
          <select name="evidenceType" defaultValue={account?.evidenceType ?? "manual_import"}>
            {EVIDENCE_TYPE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="governance-form-wide">
          能力证据
          <textarea
            name="evidenceRefs"
            defaultValue={account?.evidenceRefs.join("\n") ?? ""}
            maxLength={20_000}
            rows={3}
          />
        </label>
        <label>
          账号状态
          <select name="status" defaultValue={account?.status ?? "active"}>
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        {editing ? (
          <label>
            每日发布配额
            <input
              name="dailyPublishQuota"
              type="number"
              min={1}
              max={100}
              step={1}
              defaultValue={account.dailyPublishQuota ?? 30}
              required
            />
          </label>
        ) : null}
        {editing ? (
          <label className="governance-form-wide">
            平台账号变更原因
            <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
          </label>
        ) : null}
        <div className="governance-dialog-actions governance-form-wide">
          <SubmitButton label="保存平台账号" pending={pending} />
        </div>
      </form>
    </Dialog>
  );
}
