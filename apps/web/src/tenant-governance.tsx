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

import type {
  ChannelAccount,
  PolicyBundle,
  ServicePrincipal,
  TenantContact,
  TenantMember,
} from "./api.js";

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

export interface PolicyTransitionInput {
  readonly targetStatus: "active" | "retired";
  readonly reason: string;
}

export interface CreateChannelAccountInput {
  readonly platform: "toutiao" | "sohu" | "ctrip_community";
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly credentialRef: string | null;
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt: string | null;
}

export interface UpdateChannelAccountInput {
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly credentialRef: string | null;
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt: string | null;
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
  readonly capabilities: readonly string[];
  readonly onCreateContact: (input: CreateContactInput) => Promise<void>;
  readonly onExpireContact: (contactId: string, input: ExpireContactInput) => Promise<void>;
  readonly onCreateMember: (input: CreateMemberInput) => Promise<void>;
  readonly onUpdateMember: (memberId: string, input: UpdateMemberInput) => Promise<void>;
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

type CreateForm = "contact" | "member" | "account" | "principal" | null;
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

function platformLabel(platform: string): string {
  if (platform === "toutiao") return "头条号";
  if (platform === "sohu") return "搜狐号";
  if (platform === "ctrip_community") return "携程社区";
  return platform;
}

function statusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    active: "启用",
    disabled: "停用",
    needs_verification: "待核验",
    suspended: "暂停",
    draft: "草稿",
    retired: "已退休",
    not_issued: "未签发凭据",
    expired: "凭据已过期",
    revoked: "凭据已撤销",
  };
  return labels[status] ?? status;
}

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
  return (
    <div className="governance-dialog-backdrop" role="presentation">
      <section className="governance-dialog" role="dialog" aria-modal="true" aria-label={title}>
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
              <div>
                <strong>{contact.label}</strong>
                <span>{contact.value}</span>
              </div>
              <div className="governance-row-meta">
                <span>{contact.type}</span>
                <span>{contact.validUntil === null ? "有效" : "已失效"}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`失效 ${contact.label}`}
                title="标记失效"
                disabled={!canManageTenant || contact.validUntil !== null}
                onClick={() => setIntent({ type: "expire-contact", contact })}
              >
                <Ban size={16} />
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
              <div>
                <strong>{member.displayName}</strong>
                <span>{member.email}</span>
              </div>
              <div className="governance-row-meta">
                <span>{member.role}</span>
                <span>{statusLabel(member.status)}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`管理 ${member.displayName}`}
                title="管理成员"
                disabled={!canManageMembers}
                onClick={() => setIntent({ type: "member", member })}
              >
                <Pencil size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="governance-section">
        <GovernanceHeader title="审计策略" />
        <div className="governance-rows">
          {props.policies.map((policy) => (
            <div className="governance-row" key={policy.id}>
              <div>
                <strong>{policy.version}</strong>
                <span>{policy.policyHash.slice(0, 12)}</span>
              </div>
              <div className="governance-row-meta">
                <span>{statusLabel(policy.status)}</span>
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
              <div>
                <strong>{account.displayName}</strong>
                <span>{platformLabel(account.platform)}</span>
              </div>
              <div className="governance-row-meta">
                <span>{account.capability}</span>
                <span>{account.supportedExecutionLevels.join(" / ")}</span>
                <span>{statusLabel(account.status)}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`管理平台账号 ${account.displayName}`}
                title="管理平台账号"
                disabled={!canManageTenant}
                onClick={() => setIntent({ type: "account", account })}
              >
                <Pencil size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

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
              <div>
                <strong>{principal.name}</strong>
                <span>{principal.profile}</span>
              </div>
              <div className="governance-row-meta">
                <span>{principal.capabilities.length} 项最小权限</span>
                <span>{statusLabel(principal.credentialStatus)}</span>
                <span>{statusLabel(principal.status)}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`${principal.status === "active" ? "停用" : "启用"} ${principal.name}`}
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
                <CirclePower size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

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
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="auditor">Auditor</option>
                <option value="publisher">Publisher</option>
                <option value="viewer">Viewer</option>
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

      {createForm === "account" ? (
        <ChannelAccountDialog
          title="新增平台账号"
          pending={pending}
          onClose={() => setCreateForm(null)}
          onSubmit={(input) =>
            perform(() => props.onCreateChannelAccount(input), "平台账号已创建").then((ok) => {
              if (ok) setCreateForm(null);
            })
          }
        />
      ) : null}

      {createForm === "principal" ? (
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
                <strong>Automation Producer</strong>
                <span>内容生成、审计、Dry-run 发布请求和自动化执行</span>
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

      {intent?.type === "principal" ? (
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
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(input) =>
            perform(() => props.onUpdateMember(intent.member.id, input), "成员权限已更新").then(
              (ok) => {
                if (ok) setIntent(null);
              },
            )
          }
        />
      ) : null}

      {intent?.type === "account" ? (
        <ChannelAccountDialog
          title={`管理 ${intent.account.displayName}`}
          account={intent.account}
          pending={pending}
          onClose={() => setIntent(null)}
          onSubmit={(input) =>
            perform(() => {
              return props.onUpdateChannelAccount(intent.account.id, {
                displayName: input.displayName,
                capability: input.capability,
                supportedExecutionLevels: input.supportedExecutionLevels,
                credentialRef: input.credentialRef,
                evidenceType: input.evidenceType,
                evidenceRefs: input.evidenceRefs,
                status: input.status,
                lastVerifiedAt: input.lastVerifiedAt,
                reason: input.reason ?? "平台账号元数据更新",
              });
            }, "平台账号已更新").then((ok) => {
              if (ok) setIntent(null);
            })
          }
        />
      ) : null}
    </div>
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
  pending,
  onClose,
  onSubmit,
}: {
  readonly member: TenantMember;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: UpdateMemberInput) => Promise<void>;
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
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="auditor">Auditor</option>
            <option value="publisher">Publisher</option>
            <option value="viewer">Viewer</option>
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
    </Dialog>
  );
}

type AccountDialogInput = CreateChannelAccountInput & { readonly reason?: string };

function ChannelAccountDialog({
  title,
  account,
  pending,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly account?: ChannelAccount;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: AccountDialogInput) => Promise<void>;
}) {
  const [capability, setCapability] = useState(account?.capability ?? "manual_only");
  const editing = account !== undefined;
  return (
    <Dialog title={title} pending={pending} onClose={onClose}>
      <form
        className="governance-form governance-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const supportedExecutionLevels = ["dry_run"];
          if (data.get("assisted") === "on") supportedExecutionLevels.push("assisted");
          if (data.get("unattended") === "on") supportedExecutionLevels.push("unattended");
          void onSubmit({
            platform: String(data.get("platform")) as CreateChannelAccountInput["platform"],
            displayName: String(data.get("displayName")),
            capability,
            supportedExecutionLevels,
            credentialRef: String(data.get("credentialRef")).trim() || null,
            evidenceType: String(data.get("evidenceType")),
            evidenceRefs: splitEvidence(String(data.get("evidenceRefs"))),
            status: String(data.get("status")) as CreateChannelAccountInput["status"],
            lastVerifiedAt: String(data.get("lastVerifiedAt")).trim()
              ? new Date(String(data.get("lastVerifiedAt"))).toISOString()
              : null,
            ...(editing ? { reason: String(data.get("reason")) } : {}),
          });
        }}
      >
        <label>
          平台
          <select name="platform" defaultValue={account?.platform ?? "toutiao"} disabled={editing}>
            <option value="toutiao">头条号</option>
            <option value="sohu">搜狐号</option>
            <option value="ctrip_community">携程社区</option>
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
          Connector 能力
          <select
            name="capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
          >
            <option value="manual_only">Manual only</option>
            <option value="disabled">Disabled</option>
            <option value="browser_assisted">Browser assisted</option>
            <option value="partner_api">Partner API</option>
            <option value="public_api">Public API</option>
          </select>
        </label>
        <fieldset className="governance-execution-levels">
          <legend>执行级别</legend>
          <label className="governance-checkbox">
            <input type="checkbox" checked readOnly /> Dry-run
          </label>
          <label className="governance-checkbox">
            <input
              name="assisted"
              type="checkbox"
              defaultChecked={account?.supportedExecutionLevels.includes("assisted") ?? false}
              disabled={capability === "manual_only" || capability === "disabled"}
            />
            Assisted
          </label>
          <label className="governance-checkbox">
            <input
              name="unattended"
              type="checkbox"
              defaultChecked={account?.supportedExecutionLevels.includes("unattended") ?? false}
              disabled={
                capability === "manual_only" ||
                capability === "disabled" ||
                capability === "browser_assisted"
              }
            />
            Unattended
          </label>
        </fieldset>
        <label>
          凭据引用
          <input name="credentialRef" defaultValue="" maxLength={1000} />
        </label>
        <label>
          证据类型
          <select name="evidenceType" defaultValue={account?.evidenceType ?? "manual_import"}>
            <option value="manual_import">Manual import</option>
            <option value="api_response">API response</option>
            <option value="browser_screenshot">Browser screenshot</option>
            <option value="platform_readback">Platform readback</option>
            <option value="preview">Preview</option>
            <option value="fixture">Fixture</option>
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
          <select name="status" defaultValue={account?.status ?? "needs_verification"}>
            <option value="needs_verification">待核验</option>
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label>
          最近核验时间
          <input name="lastVerifiedAt" type="datetime-local" />
        </label>
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
