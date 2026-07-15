import {
  AlertTriangle,
  Bell,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Eye,
  FileCheck2,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PauseCircle,
  Phone,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import {
  GeoApiError,
  createGeoApi,
  isAuthenticationError,
  type AuditArtifact,
  type AutomationControl,
  type AutomationMode,
  type AutomationQuota,
  type AutomationScopeType,
  type AutomationSnapshot,
  type Brand,
  type BrandAgentProfile,
  type Campaign,
  type ChannelAccount,
  type ContentItem,
  type GeoApi,
  type PublicationJob,
  type PolicyBundle,
  type PublicationReceipt,
  type QuerySet,
  type ServicePrincipal,
  type SessionSnapshot,
  type ScopedAutomationControl,
  type TenantContact,
  type TenantOption,
  type TenantMember,
  type TenantView,
  type VisibilityProviderSummary,
} from "./api.js";
import { ArticleTemplateCatalog } from "./article-template-catalog.js";
import { BrandAgentProfileEditor } from "./brand-agent-profile-editor.js";
import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATES,
  DEFAULT_ARTICLE_TEMPLATE_ID,
} from "@geo/contracts";
import { AutomationOperations } from "./automation-operations.js";
import {
  createLoadingDashboard,
  dashboardHasAuthenticationError,
  loadLiveDashboard,
  resourceErrorText,
  type ApiResource,
  type LiveDashboard,
} from "./dashboard.js";
import { AuditOperationsList, OperationsWorkspace, PublicationJobDetail } from "./operations.js";
import { VisibilityOperations } from "./visibility-operations.js";
import { QuerySetManager } from "./query-set-manager.js";
import { TenantGovernance } from "./tenant-governance.js";
import {
  auditFindings,
  contentItems as demoContentItems,
  initialCampaigns,
  platformAccountsForTenant,
  providerMetrics as demoProviderMetrics,
  publicationRows as demoPublicationRows,
  queryRunsForTenant,
  tenants as demoTenants,
  type CampaignDemo,
  type StatusTone,
  type TenantDemo,
} from "./data.js";

interface NavigationItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

interface CampaignRow {
  id: string;
  name: string;
  topic: string;
  mode: string;
  articles: number | null;
  passRate: number | null;
  updatedAt: string | null;
  brandId: string | null;
  objective: string;
  industry: string;
}

interface ContentRow {
  id: string;
  title: string;
  type: string;
  platform: string | null;
  status: string;
  statusTone: StatusTone;
  updatedAt: string | null;
  image: string;
  imageAlt: string;
  campaignId: string | null;
}

interface PublicationRow {
  id: string;
  title: string;
  platform: string;
  level: string;
  state: string;
  evidence: string;
  time: string;
  confirmed: boolean | null;
  externalUrl: string | null;
}

interface ProviderRow {
  id: string;
  provider: string;
  providerKey: "doubao" | "qwen";
  surface: string;
  model: string;
  searchMode: string;
  observationMethod: string;
  mentionRate: number;
  contactAccuracy: number;
  harmfulErrors: number;
  samples: number;
  bars: number[];
  evidence: string;
}

interface AccountRow {
  id: string;
  platformKey: ChannelAccount["platform"] | null;
  platform: string;
  account: string;
  capability: string;
  execution: string;
  evidence: string;
  health: string;
  lastCheck: string;
}

interface CustomerRow {
  id: string;
  name: string;
  shortName: string;
  industry: string;
  hotline: string;
  wechat: string[];
  status: string;
  slug: string;
}

type ConsoleMode = "demo" | "live";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated"; error: string | null; tenantSlug: string | undefined }
  | { status: "authenticated"; session: SessionSnapshot }
  | { status: "demo" };

export interface AppProps {
  readonly api?: GeoApi;
  readonly initialMode?: ConsoleMode;
}

const navigation: NavigationItem[] = [
  { path: "/overview", label: "运营概览", icon: LayoutDashboard },
  { path: "/customers", label: "客户与品牌", icon: Building2 },
  { path: "/content", label: "内容资产", icon: FileText },
  { path: "/publishing", label: "投放中心", icon: Send },
  { path: "/automation", label: "自动化批次", icon: CalendarClock },
  { path: "/visibility", label: "AI 可见性", icon: Sparkles },
  { path: "/audit", label: "审计与证据", icon: FileCheck2 },
  { path: "/settings", label: "系统设置", icon: Settings },
];

const routeTitles: Record<string, { title: string; subtitle: string }> = {
  "/overview": { title: "运营概览", subtitle: "内容质量、投放队列与国内 AI 可见性" },
  "/customers": { title: "客户与品牌", subtitle: "租户隔离、品牌事实和联系方式版本" },
  "/content": { title: "内容资产", subtitle: "Campaign、文章版本与平台最终变体" },
  "/publishing": { title: "投放中心", subtitle: "许可、outbox、回执、配额与熔断" },
  "/automation": {
    title: "自动化批次",
    subtitle: "无人值守内容生成、发布前审计与 Dry-run 预演",
  },
  "/visibility": { title: "AI 可见性", subtitle: "豆包与千问独立证据和重复样本" },
  "/audit": { title: "审计与证据", subtitle: "阻断项、payload hash 与规则版本" },
  "/settings": { title: "系统设置", subtitle: "平台账号、能力证据和自动化策略" },
};

const travelContentImages = [
  "/demo/travel-tokyo.jpg",
  "/demo/travel-paris.jpg",
  "/demo/travel-planning.jpg",
];

const neutralContentImages = [
  "/demo/general-office.jpg",
  "/demo/general-library.jpg",
  "/demo/general-team.jpg",
];

function isTravelIndustry(industry: string): boolean {
  const normalized = industry.trim().toLocaleLowerCase();
  return (
    normalized.includes("travel") || normalized.includes("旅游") || normalized.includes("旅行")
  );
}

function contentImagesForIndustry(industry: string): readonly string[] {
  return isTravelIndustry(industry) ? travelContentImages : neutralContentImages;
}

function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`status-badge status-${tone}`}>{children}</span>;
}

function PanelHeading({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-heading">
      <div>
        <h2>{title}</h2>
        {meta === undefined ? null : <p>{meta}</p>}
      </div>
      {action}
    </div>
  );
}

function MiniBars({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="mini-bars" aria-label="样本量示意">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          style={{ height: `${Math.max(14, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function SourceCaption({ endpoint, loadedAt }: { endpoint: string; loadedAt?: string | null }) {
  return (
    <div className="source-caption">
      <Database size={14} aria-hidden="true" />
      <span>{endpoint}</span>
      {loadedAt === undefined || loadedAt === null ? null : (
        <small>{formatDateTime(loadedAt)}</small>
      )}
    </div>
  );
}

function ResourceState({
  resource,
  empty,
  emptyLabel,
}: {
  resource: ApiResource<unknown>;
  empty: boolean;
  emptyLabel: string;
}) {
  if (resource.status === "loading") {
    return (
      <div className="resource-state" role="status">
        <LoaderCircle className="spin" size={17} aria-hidden="true" />
        <div>
          <strong>正在读取实时数据</strong>
          <span>{resource.endpoint}</span>
        </div>
      </div>
    );
  }
  if (resource.status === "error" && resource.error !== null) {
    return (
      <div className="resource-state resource-error" role="alert">
        <AlertTriangle size={17} aria-hidden="true" />
        <div>
          <strong>{resource.endpoint} 读取失败</strong>
          <span>{resourceErrorText(resource.error)}</span>
        </div>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="resource-state resource-empty" role="status">
        <Database size={17} aria-hidden="true" />
        <div>
          <strong>{emptyLabel}</strong>
          <span>{resource.endpoint} 返回 0 条记录</span>
        </div>
      </div>
    );
  }
  return null;
}

function UnsupportedState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="resource-state resource-unavailable" role="status">
      <WifiOff size={17} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    toutiao: "头条号",
    sohu: "搜狐号",
    ctrip_community: "携程社区",
  };
  return labels[platform] ?? platform;
}

function executionLabel(level: string): string {
  const labels: Record<string, string> = {
    dry_run: "Dry-run",
    assisted: "人工辅助",
    unattended: "无人值守",
  };
  return labels[level] ?? level;
}

function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    manual_only: "Manual only",
    browser_assisted: "Browser assisted",
    public_api: "Public API",
    partner_api: "Partner API",
    disabled: "Disabled",
  };
  return labels[capability] ?? capability;
}

function evidenceLabel(evidence: string): string {
  const labels: Record<string, string> = {
    fixture: "Fixture",
    preview: "Preview",
    manual_import: "Manual import",
    browser_screenshot: "Browser screenshot",
    api_response: "API response",
    platform_readback: "Platform readback",
  };
  return labels[evidence] ?? evidence;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    draft: "草稿",
    ready_for_audit: "待审计",
    audited: "已审计",
    approved: "已批准",
    queued: "队列中",
    dispatching: "分发中",
    publishing: "投放中",
    published: "已发布",
    retry_wait: "等待重试",
    uncertain: "结果不确定",
    reconciling: "核对中",
    confirmed: "已确认",
    needs_review: "需复核",
    permanent_failure: "永久失败",
    failed: "失败",
    blocked: "已阻断",
    cancelled: "已取消",
    withdrawn: "已撤回",
    active: "运行中",
    unavailable: "不可用",
  };
  return labels[state] ?? state;
}

function contentTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    question_answer: "问答型",
    guide: "攻略型",
    evidence: "证据型",
    local_service: "本地服务型",
    comparison: "比较型",
    risk_avoidance: "避险型",
  };
  return labels[type] ?? type;
}

function stateTone(state: string): StatusTone {
  if (["approved", "confirmed", "published", "active"].includes(state)) return "success";
  if (["blocked", "permanent_failure", "failed"].includes(state)) return "danger";
  if (["needs_review", "uncertain", "retry_wait"].includes(state)) return "warning";
  if (["queued", "dispatching", "publishing", "reconciling", "audited"].includes(state))
    return "info";
  return "neutral";
}

function mergeTenantOptions(
  existing: readonly TenantOption[],
  incoming: readonly TenantOption[],
): readonly TenantOption[] {
  const bySlug = new Map(existing.map((tenant) => [tenant.slug, tenant]));
  for (const tenant of incoming) {
    bySlug.set(tenant.slug, { ...bySlug.get(tenant.slug), ...tenant });
  }
  return [...bySlug.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "zh-CN"),
  );
}

function apiErrorText(error: unknown): string {
  if (error instanceof GeoApiError) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    return `${error.code}: ${error.message}${request}`;
  }
  return error instanceof Error ? error.message : "未知错误";
}

function sessionBootstrapErrorText(error: unknown): string {
  if (error instanceof GeoApiError && (error.status === 0 || error.status >= 500)) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    return `运营 API 暂时不可用；可稍后重试或进入离线演示（${error.code}${request}）`;
  }
  return apiErrorText(error);
}

function LoginView({
  api,
  initialError,
  initialTenantSlug,
  knownTenants,
  onAuthenticated,
  onDemo,
  onTenantsDiscovered,
}: {
  api: GeoApi;
  initialError: string | null;
  initialTenantSlug: string | undefined;
  knownTenants: readonly TenantOption[];
  onAuthenticated: (session: SessionSnapshot) => void;
  onDemo: () => void;
  onTenantsDiscovered: (tenants: readonly TenantOption[]) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantSlug, setTenantSlug] = useState(initialTenantSlug ?? "");
  const [tenantOptions, setTenantOptions] = useState<readonly TenantOption[]>(knownTenants);
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.login({
        email: email.trim(),
        password,
        ...(tenantSlug === "" ? {} : { tenantSlug }),
      });
      onAuthenticated(session);
    } catch (requestError) {
      if (
        requestError instanceof GeoApiError &&
        requestError.code === "TENANT_SELECTION_REQUIRED" &&
        requestError.details?.tenants !== undefined
      ) {
        const options = requestError.details.tenants;
        setTenantOptions(options);
        onTenantsDiscovered(options);
        setError("该账号属于多个租户，请选择客户后再次登录");
      } else {
        setError(apiErrorText(requestError));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-brand">
          <span>G</span>
          <div>
            <strong>GEO Console</strong>
            <small>实时运营入口</small>
          </div>
        </div>
        <div className="auth-heading">
          <h1 id="login-title">登录运营台</h1>
          <p>会话和租户范围由 GEO API 校验</p>
        </div>
        {error === null ? null : (
          <div className="auth-error" role="alert">
            <AlertTriangle size={17} />
            <span>{error}</span>
          </div>
        )}
        <form onSubmit={(event) => void submit(event)}>
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              minLength={8}
              required
            />
          </label>
          {tenantOptions.length === 0 && tenantSlug === "" ? null : (
            <label>
              客户租户
              <select
                aria-label="客户租户"
                value={tenantSlug}
                onChange={(event) => setTenantSlug(event.target.value)}
                required
              >
                <option value="" disabled>
                  请选择客户
                </option>
                {tenantOptions.map((tenant) => (
                  <option
                    key={tenant.slug}
                    value={tenant.slug}
                    disabled={tenant.status === "unavailable"}
                  >
                    {tenant.displayName}
                    {tenant.status === "unavailable" ? "（不可用）" : ""}
                  </option>
                ))}
                {tenantOptions.every((tenant) => tenant.slug !== tenantSlug) &&
                tenantSlug !== "" ? (
                  <option value={tenantSlug}>{tenantSlug}</option>
                ) : null}
              </select>
            </label>
          )}
          <button className="button-primary auth-submit" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}
            {submitting ? "正在登录" : "登录"}
          </button>
        </form>
        <div className="demo-entry">
          <div>
            <strong>离线演示</strong>
            <span>仅显示内置示例，不代表 API 或平台真实状态</span>
          </div>
          <button className="button-secondary" type="button" onClick={onDemo}>
            进入演示模式
          </button>
        </div>
      </section>
      <aside className="auth-status" aria-label="数据边界">
        <div>
          <Database size={18} />
          <strong>真实模式</strong>
          <span>Cookie 会话 · tenant scope · 独立接口错误</span>
        </div>
        <div>
          <ShieldAlert size={18} />
          <strong>投放边界</strong>
          <span>头条号、搜狐号、携程社区保持 Dry-run / Manual only</span>
        </div>
        <div>
          <Sparkles size={18} />
          <strong>可见性边界</strong>
          <span>豆包与千问独立评测，不使用 Google 排名代理</span>
        </div>
      </aside>
    </main>
  );
}

function OverviewView({
  mode,
  campaigns,
  content,
  publicationRows,
  providers,
  accounts,
  dashboard,
  killSwitch,
  killSwitchWritable,
  killSwitchPending,
  onToggleKillSwitch,
}: {
  mode: ConsoleMode;
  campaigns: CampaignRow[];
  content: ContentRow[];
  publicationRows: PublicationRow[];
  providers: ProviderRow[];
  accounts: AccountRow[];
  dashboard: LiveDashboard;
  killSwitch: boolean | null;
  killSwitchWritable: boolean;
  killSwitchPending: boolean;
  onToggleKillSwitch: () => void;
}) {
  const totalObservations = providers.reduce((sum, provider) => sum + provider.samples, 0);
  const weightedAccuracy =
    totalObservations === 0
      ? null
      : providers.reduce((sum, provider) => sum + provider.contactAccuracy * provider.samples, 0) /
        totalObservations;
  const confirmedReceipts = publicationRows.filter((row) => row.confirmed === true).length;
  const allManualOnly =
    accounts.length > 0 &&
    accounts.every(
      (account) => account.capability === "Manual only" && account.execution.includes("Dry-run"),
    );

  return (
    <div className="view-stack">
      <div className="capability-notice" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>
            {mode === "demo"
              ? "三家平台当前均为 Dry-run / Manual only"
              : allManualOnly
                ? `${accounts.length} 个已配置平台账号均为 Dry-run / Manual only`
                : "平台能力以实时账号记录为准"}
          </strong>
          <span>
            {mode === "demo"
              ? "演示数据未声明任何真实发布能力"
              : "未验证公开或合作方文章发布 API 前，不开放无人值守实发"}
          </span>
        </div>
        <NavLink to="/settings" className="text-link">
          查看能力证据 <ChevronRight size={15} />
        </NavLink>
      </div>

      {mode === "live" ? (
        <ResourceState
          resource={dashboard.channelAccounts}
          empty={accounts.length === 0}
          emptyLabel="尚未配置平台账号"
        />
      ) : null}

      <section className="metric-band" aria-label="关键指标">
        <div className="metric-cell">
          <span>Campaign</span>
          <strong>
            {mode === "live" && dashboard.campaigns.status !== "ready" ? "—" : campaigns.length}
          </strong>
          <small>{mode === "demo" ? "演示计划" : "GET /api/campaigns"}</small>
        </div>
        <div className="metric-cell">
          <span>已加载投放作业</span>
          <strong>
            {mode === "live" && dashboard.publicationJobs.status !== "ready"
              ? "—"
              : publicationRows.length}
          </strong>
          <small>{mode === "demo" ? "演示作业" : "最多由 API 返回 200 条"}</small>
        </div>
        <div className="metric-cell">
          <span>联系方式准确率</span>
          <strong>
            {mode === "demo"
              ? "98.6%"
              : weightedAccuracy === null
                ? "—"
                : percent(weightedAccuracy)}
          </strong>
          <small>{mode === "demo" ? "演示指标" : `${totalObservations} 个聚合样本`}</small>
        </div>
        <div className="metric-cell">
          <span>已确认回执</span>
          <strong>
            {mode === "live" && dashboard.receipts.status !== "ready" ? "—" : confirmedReceipts}
          </strong>
          <small>{mode === "demo" ? "演示回执" : "GET /api/receipts"}</small>
        </div>
      </section>

      <div className="overview-grid">
        <section className="panel queue-panel">
          <PanelHeading
            title="发布作业"
            meta={mode === "demo" ? "演示 outbox 与回执" : "实时作业与回执关联"}
            action={
              <NavLink className="text-button" to="/publishing">
                全部作业 <ChevronRight size={15} />
              </NavLink>
            }
          />
          {mode === "live" ? (
            <ResourceState
              resource={dashboard.publicationJobs}
              empty={publicationRows.length === 0}
              emptyLabel="暂无投放作业"
            />
          ) : null}
          {publicationRows.length === 0 ? null : (
            <div className="table-scroll">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>作业</th>
                    <th>平台</th>
                    <th>执行等级</th>
                    <th>状态</th>
                    <th>证据</th>
                  </tr>
                </thead>
                <tbody>
                  {publicationRows.slice(0, 6).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="primary-cell">
                          <strong>{row.title}</strong>
                          <span>
                            {shortId(row.id)} · {row.time}
                          </span>
                        </div>
                      </td>
                      <td>{row.platform}</td>
                      <td>
                        <StatusBadge tone="info">{row.level}</StatusBadge>
                      </td>
                      <td>{row.state}</td>
                      <td>{row.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {mode === "live" ? (
            <SourceCaption
              endpoint="GET /api/publication-jobs + GET /api/receipts"
              loadedAt={dashboard.loadedAt}
            />
          ) : null}
        </section>

        <section className="panel visibility-panel">
          <PanelHeading
            title="国内 AI 可见性"
            meta={mode === "demo" ? "演示重复样本" : "Provider 聚合结果"}
            action={
              <NavLink
                className="icon-button"
                to="/visibility"
                aria-label="查看 AI 可见性"
                title="查看 AI 可见性"
              >
                <ChevronRight size={17} />
              </NavLink>
            }
          />
          {mode === "live" ? (
            <ResourceState
              resource={dashboard.visibility}
              empty={providers.length === 0}
              emptyLabel="暂无豆包或千问观测"
            />
          ) : null}
          <div className="provider-list">
            {providers.map((provider) => (
              <div className="provider-row" key={provider.id}>
                <div className="provider-name">
                  <span className="provider-mark">{provider.provider.slice(0, 1)}</span>
                  <div>
                    <strong>{provider.provider}</strong>
                    <small>
                      {provider.surface} · {provider.evidence}
                    </small>
                  </div>
                </div>
                <MiniBars values={provider.bars} />
                <div className="provider-value">
                  <strong>{provider.mentionRate.toFixed(1)}%</strong>
                  <small>{provider.samples} 样本</small>
                </div>
              </div>
            ))}
          </div>
          <div className="evidence-footnote">
            <Database size={15} /> 当前数据源：
            {mode === "demo"
              ? "Fixture 演示"
              : "API 按 surface / model / search / method / evidence 分组"}
          </div>
        </section>

        <section className="panel content-panel">
          <PanelHeading
            title="最近内容资产"
            meta={mode === "demo" ? "演示平台最终变体" : "实时内容条目"}
            action={
              <NavLink className="text-button" to="/content">
                内容工作台 <ChevronRight size={15} />
              </NavLink>
            }
          />
          {mode === "live" ? (
            <ResourceState
              resource={dashboard.content}
              empty={content.length === 0}
              emptyLabel="暂无内容资产"
            />
          ) : null}
          <div className="content-list">
            {content.slice(0, 4).map((item) => (
              <article className="content-row" key={item.id}>
                <img src={item.image} alt={item.imageAlt} />
                <div className="content-copy">
                  <strong>{item.title}</strong>
                  <span>
                    {item.type} · {item.platform ?? "平台变体未加载"} ·{" "}
                    {item.updatedAt ?? "API 未返回更新时间"}
                  </span>
                </div>
                <StatusBadge tone={item.statusTone}>{item.status}</StatusBadge>
                <button
                  className="icon-button"
                  aria-label={`打开 ${item.title}`}
                  title="打开内容"
                  disabled
                >
                  <ChevronRight size={17} />
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel audit-panel">
          <PanelHeading
            title="审计阻断"
            meta={mode === "demo" ? "演示规则命中" : "审计列表状态"}
            action={
              mode === "demo" ? (
                <StatusBadge tone="danger">2 阻断</StatusBadge>
              ) : (
                <NavLink className="text-button" to="/audit">
                  全部审计 <ChevronRight size={15} />
                </NavLink>
              )
            }
          />
          {mode === "live" ? (
            <>
              <ResourceState
                resource={dashboard.audits}
                empty={dashboard.audits.data.length === 0}
                emptyLabel="暂无审计运行"
              />
              {dashboard.audits.data.length === 0 ? null : (
                <AuditOperationsList audits={dashboard.audits.data.slice(0, 3)} />
              )}
            </>
          ) : (
            <div className="finding-list">
              {auditFindings.map((finding) => (
                <div className="finding-row" key={finding.id}>
                  <span
                    className={`finding-dot ${finding.severity === "阻断" ? "dot-danger" : "dot-warning"}`}
                  />
                  <div>
                    <strong>{finding.rule}</strong>
                    <p>{finding.message}</p>
                    <small>{finding.time}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel campaign-panel">
        <PanelHeading
          title="Campaign"
          meta={mode === "demo" ? "演示健康度" : "实时计划；API 未提供文章数和通过率"}
        />
        {mode === "live" ? (
          <ResourceState
            resource={dashboard.campaigns}
            empty={campaigns.length === 0}
            emptyLabel="暂无 Campaign"
          />
        ) : null}
        <div className="campaign-grid">
          {campaigns.map((campaign) => (
            <div className="campaign-row" key={campaign.id}>
              <div className="campaign-name">
                <strong>{campaign.name}</strong>
                <span>{campaign.topic}</span>
              </div>
              <StatusBadge tone={campaign.mode === "监督投放" ? "info" : "neutral"}>
                {campaign.mode}
              </StatusBadge>
              {campaign.passRate === null ? (
                <div className="progress-column">
                  <div>
                    <span>目标</span>
                    <strong className="campaign-objective">{campaign.objective}</strong>
                  </div>
                </div>
              ) : (
                <div className="progress-column">
                  <div>
                    <span>审计通过率</span>
                    <strong>{campaign.passRate}%</strong>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${campaign.passRate}%` }} />
                  </div>
                </div>
              )}
              <span className="campaign-count">
                {campaign.articles === null ? campaign.industry : `${campaign.articles} 篇`}
              </span>
              <span className="campaign-time">{campaign.updatedAt ?? "未返回时间"}</span>
            </div>
          ))}
        </div>
      </section>

      {mode === "live" ? (
        <ResourceState
          resource={dashboard.automation}
          empty={dashboard.automation.data === null}
          emptyLabel="未配置自动化控制"
        />
      ) : null}
      <div className={`kill-switch-bar ${killSwitch === true ? "kill-switch-active" : ""}`}>
        <div>
          <Power size={18} />
          <span>
            {mode === "demo"
              ? killSwitch
                ? "演示：全租户投放已停止"
                : "演示：Kill Switch 未触发"
              : killSwitch === null
                ? "Kill Switch 状态不可用"
                : killSwitch
                  ? "当前租户投放已暂停"
                  : "当前租户 Kill Switch 关闭"}
          </span>
        </div>
        <button
          className={killSwitch === true ? "button-secondary" : "button-danger"}
          onClick={onToggleKillSwitch}
          disabled={killSwitchPending || (mode === "live" && !killSwitchWritable)}
          title={
            mode === "live" && !killSwitchWritable
              ? "需要 automation:manage 权限且自动化接口可用"
              : undefined
          }
        >
          {killSwitchPending ? (
            <LoaderCircle className="spin" size={16} />
          ) : killSwitch === true ? (
            <RefreshCw size={16} />
          ) : (
            <PauseCircle size={16} />
          )}
          {killSwitchPending ? "等待回读" : killSwitch === true ? "恢复 Shadow" : "立即停止"}
        </button>
      </div>
    </div>
  );
}

function CustomersView({
  mode,
  customers,
  currentTenantId,
  directoryResource,
  tenantResource,
  contactsResource,
  contactsEmpty,
  discoveredTenants,
  brands,
  brandAgentProfiles,
  members,
  policies,
  contacts,
  accounts,
  principals,
  querySets,
  brandResource,
  brandAgentProfileResource,
  memberResource,
  policyResource,
  querySetResource,
  capabilities,
  api,
  onChanged,
}: {
  mode: ConsoleMode;
  customers: CustomerRow[];
  currentTenantId: string;
  directoryResource: ApiResource<readonly TenantOption[]>;
  tenantResource: ApiResource<TenantView | null>;
  contactsResource: ApiResource<unknown>;
  contactsEmpty: boolean;
  discoveredTenants: readonly TenantOption[];
  brands: readonly Brand[];
  brandAgentProfiles: readonly BrandAgentProfile[];
  members: readonly TenantMember[];
  policies: readonly PolicyBundle[];
  contacts: readonly TenantContact[];
  accounts: readonly ChannelAccount[];
  principals: readonly ServicePrincipal[];
  querySets: readonly QuerySet[];
  brandResource: ApiResource<readonly Brand[]>;
  brandAgentProfileResource: ApiResource<readonly BrandAgentProfile[]>;
  memberResource: ApiResource<readonly TenantMember[]>;
  policyResource: ApiResource<readonly PolicyBundle[]>;
  querySetResource: ApiResource<readonly QuerySet[]>;
  capabilities: readonly string[];
  api: GeoApi;
  onChanged: () => void;
}) {
  return (
    <div className="view-stack">
      {mode === "live" ? (
        <div className="scope-notice">
          <LockKeyhole size={17} />
          <div>
            <strong>租户切换会重新签发 tenant-bound session</strong>
            <span>
              GET /api/auth/tenants 返回 {discoveredTenants.length} 个成员租户；不可用租户不能切换
            </span>
          </div>
        </div>
      ) : null}
      <section className="panel">
        <PanelHeading
          title="租户目录"
          meta="tenant_id 是所有数据与工具调用的隔离边界"
          action={
            <button className="button-primary" disabled title="后端尚未提供租户创建接口">
              <Plus size={16} /> 新建客户
            </button>
          }
        />
        {mode === "live" ? (
          <ResourceState
            resource={directoryResource}
            empty={discoveredTenants.length === 0}
            emptyLabel="当前账号没有可访问租户"
          />
        ) : null}
        {mode === "live" && tenantResource.status === "error" ? (
          <ResourceState resource={tenantResource} empty={false} emptyLabel="当前租户资料为空" />
        ) : null}
        {mode === "live" && (contactsResource.status !== "ready" || contactsEmpty) ? (
          <ResourceState
            resource={contactsResource}
            empty={contactsEmpty}
            emptyLabel="暂无有效联系方式"
          />
        ) : null}
        {customers.length === 0 ? null : (
          <div className="table-scroll">
            <table className="tenant-table">
              <thead>
                <tr>
                  <th>客户</th>
                  <th>行业</th>
                  <th>24 小时热线</th>
                  <th>微信咨询</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className={tenant.id === currentTenantId ? "selected-row" : ""}
                  >
                    <td>
                      <div className="brand-cell">
                        <span>{tenant.shortName.slice(0, 1)}</span>
                        <div>
                          <strong>{tenant.name}</strong>
                          <small>{tenant.slug}</small>
                        </div>
                      </div>
                    </td>
                    <td>{tenant.industry}</td>
                    <td>
                      {tenant.hotline === "" ? (
                        <span className="muted">
                          {mode === "live" && tenant.id !== currentTenantId
                            ? "切换后读取"
                            : "未配置"}
                        </span>
                      ) : (
                        <span className="contact-value">
                          <Phone size={14} /> {tenant.hotline}
                        </span>
                      )}
                    </td>
                    <td>
                      {tenant.wechat.length === 0 ? (
                        <span className="muted">
                          {mode === "live" && tenant.id !== currentTenantId
                            ? "切换后读取"
                            : "未配置"}
                        </span>
                      ) : (
                        <span className="contact-value">
                          <MessageCircle size={14} /> {tenant.wechat.join(" / ")}
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          tenant.status === "运行中" || tenant.status === "active"
                            ? "success"
                            : tenant.status === "unavailable"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {stateLabel(tenant.status)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === "live" ? (
          <SourceCaption endpoint="GET /api/auth/tenants + GET /api/tenant + GET /api/contacts" />
        ) : null}
      </section>
      <section className="panel">
        <PanelHeading title="Brand Agent Profile" meta="品牌级 Pi Agent 写作约定 · 不可变版本" />
        {mode === "live" ? (
          <ResourceState resource={brandAgentProfileResource} empty={false} emptyLabel="" />
        ) : null}
        <BrandAgentProfileEditor
          mode={mode}
          brands={brands}
          profiles={brandAgentProfiles}
          capabilities={capabilities}
          demoBrandName={
            customers.find((customer) => customer.id === currentTenantId)?.name ?? "演示品牌"
          }
          onSave={async (brandId, input) => {
            await api.createBrandAgentProfile(brandId, input);
          }}
          onChanged={onChanged}
        />
        {mode === "live" ? (
          <SourceCaption endpoint="GET /api/brand-agent-profiles + POST /api/brands/:brandId/agent-profile" />
        ) : null}
      </section>
      {mode === "live" ? (
        <section className="panel">
          <PanelHeading title="当前租户治理目录" meta="品牌、成员、策略与国内 AI 问题集" />
          <div className="customer-governance-grid">
            <div>
              <h3>品牌</h3>
              <ResourceState
                resource={brandResource}
                empty={brands.length === 0}
                emptyLabel="暂无品牌"
              />
              <ul className="dense-list">
                {brands.map((brand) => (
                  <li key={brand.id}>
                    <div>
                      <strong>{brand.displayName}</strong>
                      <span>{brand.canonicalName}</span>
                    </div>
                    <StatusBadge tone={brand.isPrimary ? "success" : "neutral"}>
                      {brand.isPrimary ? "主品牌" : brand.industry}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>成员</h3>
              <ResourceState
                resource={memberResource}
                empty={members.length === 0}
                emptyLabel="暂无成员"
              />
              <ul className="dense-list">
                {members.map((member) => (
                  <li key={member.id}>
                    <div>
                      <strong>{member.displayName}</strong>
                      <span>{member.email}</span>
                    </div>
                    <StatusBadge tone={member.status === "active" ? "success" : "warning"}>
                      {member.role}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>策略</h3>
              <ResourceState
                resource={policyResource}
                empty={policies.length === 0}
                emptyLabel="暂无策略"
              />
              <ul className="dense-list">
                {policies.map((policy) => (
                  <li key={policy.id}>
                    <div>
                      <strong>{policy.version}</strong>
                      <span>{formatDateTime(policy.effectiveAt)}</span>
                    </div>
                    <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>
                      {policy.status}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>问题集</h3>
              <ResourceState
                resource={querySetResource}
                empty={querySets.length === 0}
                emptyLabel="暂无问题集"
              />
              <ul className="dense-list">
                {querySets.map((querySet) => (
                  <li key={querySet.id}>
                    <div>
                      <strong>{querySet.name}</strong>
                      <span>
                        {querySet.industry} · v{querySet.currentVersion}
                      </span>
                    </div>
                    <StatusBadge tone={querySet.status === "active" ? "success" : "neutral"}>
                      {querySet.status}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
      {mode === "live" ? (
        <section className="panel">
          <PanelHeading title="租户治理操作" meta="所有变更均由服务端按租户范围审计" />
          <TenantGovernance
            contacts={contacts}
            members={members}
            policies={policies}
            accounts={accounts}
            principals={principals}
            capabilities={capabilities}
            onCreateContact={async (input) => {
              await api.createContact(input);
            }}
            onExpireContact={async (contactId, input) => {
              await api.expireContact(contactId, input);
            }}
            onCreateMember={async (input) => {
              await api.createMember(input);
            }}
            onUpdateMember={async (memberId, input) => {
              await api.updateMember(memberId, input);
            }}
            onCreatePolicy={async (input) => {
              await api.createPolicy(input);
            }}
            onTransitionPolicy={async (policyId, input) => {
              await api.transitionPolicy(policyId, input);
            }}
            onCreateChannelAccount={async (input) => {
              await api.createChannelAccount(input);
            }}
            onUpdateChannelAccount={async (accountId, input) => {
              await api.updateChannelAccount(accountId, input);
            }}
            onCreateAutomationPrincipal={async (input) => {
              await api.createAutomationServicePrincipal(input);
            }}
            onSetPrincipalStatus={async (principalId, input) => {
              await api.setServicePrincipalStatus(principalId, input);
            }}
            onChanged={onChanged}
          />
          <SourceCaption endpoint="POST/PATCH tenant governance APIs + GET /api/service-principals" />
        </section>
      ) : null}
      {mode === "demo" ? (
        <section className="split-band">
          <div>
            <h2>租户隔离验证</h2>
            <p>演示中的 PostgreSQL RLS 测试结果</p>
          </div>
          <div className="verification-item">
            <CheckCircle2 size={18} />
            <span>跨租户读取</span>
            <strong>已拒绝</strong>
          </div>
          <div className="verification-item">
            <CheckCircle2 size={18} />
            <span>跨租户写入</span>
            <strong>已拒绝</strong>
          </div>
          <div className="verification-item">
            <Clock3 size={18} />
            <span>数据来源</span>
            <strong>演示数据</strong>
          </div>
        </section>
      ) : (
        <UnsupportedState
          title="RLS 验证结果未由 API 返回"
          detail="运营台不会把历史测试结论伪装成当前运行状态"
        />
      )}
    </div>
  );
}

function ContentView({
  mode,
  items,
  api,
  tenantId,
  capabilities,
  dashboard,
}: {
  mode: ConsoleMode;
  items: ContentRow[];
  api: GeoApi;
  tenantId: string;
  capabilities: readonly string[];
  dashboard: LiveDashboard;
}) {
  const [view, setView] = useState<"all" | "blocked" | "ready">("all");
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_ARTICLE_TEMPLATE_ID);
  if (mode === "live") {
    const resources = [
      dashboard.brands,
      dashboard.evidenceSources,
      dashboard.facts,
      dashboard.campaigns,
      dashboard.content,
      dashboard.channelAccounts,
      dashboard.policies,
      dashboard.articleTemplates,
    ];
    return (
      <div className="view-stack">
        {resources.map((item) =>
          item.status === "error" ? (
            <ResourceState key={item.endpoint} resource={item} empty={false} emptyLabel="" />
          ) : null,
        )}
        <OperationsWorkspace
          api={api}
          tenantId={tenantId}
          capabilities={capabilities}
          brands={dashboard.brands.data}
          evidenceSources={dashboard.evidenceSources.data}
          facts={dashboard.facts.data}
          campaigns={dashboard.campaigns.data}
          contentItems={dashboard.content.data}
          accounts={dashboard.channelAccounts.data}
          contacts={dashboard.contacts.data}
          policies={dashboard.policies.data}
          templates={dashboard.articleTemplates.data?.items ?? []}
          catalogVersion={dashboard.articleTemplates.data?.version ?? ""}
          resources={{
            brands: dashboard.brands.status,
            evidence: dashboard.evidenceSources.status,
            facts: dashboard.facts.status,
            campaigns: dashboard.campaigns.status,
            content: dashboard.content.status,
            accounts: dashboard.channelAccounts.status,
            policies: dashboard.policies.status,
            templates: dashboard.articleTemplates.status,
          }}
        />
      </div>
    );
  }
  const visibleItems = items.filter((item) => {
    if (view === "blocked") return item.statusTone === "warning" || item.statusTone === "danger";
    if (view === "ready") return item.statusTone === "success" || item.statusTone === "info";
    return true;
  });
  return (
    <div className="view-stack">
      <ArticleTemplateCatalog
        templates={ARTICLE_TEMPLATES}
        catalogVersion={ARTICLE_TEMPLATE_CATALOG_VERSION}
        selectedTemplateId={selectedTemplateId}
        actionLabel="选为默认模板"
        onSelect={(template) => setSelectedTemplateId(template.id)}
      />
      <div className="toolbar-row">
        <div className="segmented-control" aria-label="内容筛选">
          <button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
            全部
          </button>
          <button className={view === "blocked" ? "active" : ""} onClick={() => setView("blocked")}>
            阻断
          </button>
          <button className={view === "ready" ? "active" : ""} onClick={() => setView("ready")}>
            可投放
          </button>
        </div>
        <button className="button-secondary" disabled>
          <SlidersHorizontal size={16} /> 高级筛选
        </button>
        <button
          className="button-primary"
          disabled
          title="当前 MVP 仅接入内容读取；创建需要完整 payload 编辑器"
        >
          <Plus size={16} /> 新建文章
        </button>
      </div>
      <section className="panel content-workspace">
        <PanelHeading
          title={mode === "demo" ? "平台最终变体" : "内容条目"}
          meta={`${visibleItems.length} 个当前结果`}
        />
        <div className="asset-grid">
          {visibleItems.map((item) => (
            <article className="asset-card" key={item.id}>
              <img src={item.image} alt={item.imageAlt} />
              <div className="asset-body">
                <div className="asset-meta">
                  <span>{item.type}</span>
                  <StatusBadge tone={item.statusTone}>{item.status}</StatusBadge>
                </div>
                <h3>{item.title}</h3>
                <p>
                  {item.platform ?? "平台变体需逐项读取"} · {item.updatedAt ?? "API 未返回更新时间"}
                </p>
                <div className="asset-actions">
                  <button className="button-secondary" disabled>
                    <Eye size={15} /> 预览
                  </button>
                  <button className="icon-button" aria-label="更多操作" title="更多操作" disabled>
                    <MoreHorizontal size={17} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function PublishingView({
  mode,
  api,
  tenantId,
  capabilities,
  accounts,
  rows,
  dashboard,
  killSwitch,
  killSwitchWritable,
  killSwitchPending,
  onToggleKillSwitch,
}: {
  mode: ConsoleMode;
  api: GeoApi;
  tenantId: string;
  capabilities: readonly string[];
  accounts: AccountRow[];
  rows: PublicationRow[];
  dashboard: LiveDashboard;
  killSwitch: boolean | null;
  killSwitchWritable: boolean;
  killSwitchPending: boolean;
  onToggleKillSwitch: () => void;
}) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [cancelledJobs, setCancelledJobs] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setSelectedJobId(null);
    setCancelledJobs(new Set());
  }, [tenantId]);
  return (
    <div className="view-stack">
      {mode === "live" ? (
        <ResourceState
          resource={dashboard.automation}
          empty={dashboard.automation.data === null}
          emptyLabel="未配置自动化控制"
        />
      ) : null}
      {mode === "live" ? (
        <ResourceState
          resource={dashboard.channelAccounts}
          empty={accounts.length === 0}
          emptyLabel="暂无平台账号"
        />
      ) : null}
      <div className="platform-health-band">
        {accounts.map((account) => (
          <div key={account.id}>
            <span className="platform-initial">{account.platform.slice(0, 1)}</span>
            <div>
              <strong>{account.platform}</strong>
              <small>
                {account.capability} · {account.execution}
              </small>
            </div>
            <StatusBadge
              tone={
                account.health === "正常" || account.health === "active" ? "success" : "warning"
              }
            >
              {stateLabel(account.health)}
            </StatusBadge>
          </div>
        ))}
      </div>
      <section className="panel">
        <PanelHeading
          title="投放队列"
          meta={
            mode === "demo" ? "演示 grant / outbox / receipt" : "实时 publication jobs 与 receipts"
          }
          action={
            <button
              className={killSwitch === true ? "button-secondary" : "button-danger"}
              onClick={onToggleKillSwitch}
              disabled={killSwitchPending || (mode === "live" && !killSwitchWritable)}
              title={
                mode === "live" && !killSwitchWritable
                  ? "需要 automation:manage 权限且自动化接口可用"
                  : undefined
              }
            >
              {killSwitchPending ? (
                <LoaderCircle className="spin" size={16} />
              ) : killSwitch === true ? (
                <RefreshCw size={16} />
              ) : (
                <PauseCircle size={16} />
              )}
              {killSwitchPending ? "等待回读" : killSwitch === true ? "恢复" : "停止全部"}
            </button>
          }
        />
        {mode === "live" ? (
          <ResourceState
            resource={dashboard.publicationJobs}
            empty={rows.length === 0}
            emptyLabel="暂无投放作业"
          />
        ) : null}
        {mode === "live" ? (
          <ResourceState
            resource={dashboard.receipts}
            empty={dashboard.receipts.data.length === 0}
            emptyLabel="暂无投放回执"
          />
        ) : null}
        {rows.length === 0 ? null : (
          <div className="table-scroll">
            <table className="publishing-table">
              <thead>
                <tr>
                  <th>作业 / 变体</th>
                  <th>平台</th>
                  <th>执行等级</th>
                  <th>状态</th>
                  <th>证据类型</th>
                  <th>时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="primary-cell">
                        <strong>{row.title}</strong>
                        <span>{shortId(row.id)}</span>
                      </div>
                    </td>
                    <td>{row.platform}</td>
                    <td>
                      <StatusBadge tone="info">{row.level}</StatusBadge>
                    </td>
                    <td>{cancelledJobs.has(row.id) ? "已取消" : row.state}</td>
                    <td>{row.evidence}</td>
                    <td>{row.time}</td>
                    <td>
                      <button
                        className="icon-button"
                        title="查看作业证据"
                        aria-label={`查看作业 ${row.id} 详情`}
                        onClick={() => setSelectedJobId(row.id)}
                        disabled={mode === "demo"}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === "live" ? (
          <SourceCaption
            endpoint="GET /api/publication-jobs + GET /api/receipts"
            loadedAt={dashboard.loadedAt}
          />
        ) : null}
      </section>
      {mode === "live" ? (
        <PublicationJobDetail
          api={api}
          tenantId={tenantId}
          jobId={selectedJobId}
          canCancel={capabilities.includes("publish:cancel")}
          onCancelled={(job) => {
            setCancelledJobs((current) => new Set([...current, job.id]));
          }}
        />
      ) : null}
      <section className="policy-strip">
        <div>
          <LockKeyhole size={18} />
          <span>一次性 PublicationGrant</span>
          <strong>API 强制</strong>
        </div>
        <div>
          <RefreshCw size={18} />
          <span>不确定结果 reconcile</span>
          <strong>Worker 契约</strong>
        </div>
        <div>
          <ShieldAlert size={18} />
          <span>非 API 无人值守门</span>
          <strong>保持阻断</strong>
        </div>
      </section>
    </div>
  );
}

function AutomationView({
  mode,
  api,
  tenantId,
  capabilities,
  dashboard,
  onChanged,
  onCampaignsRead,
}: {
  mode: ConsoleMode;
  api: GeoApi;
  tenantId: string;
  capabilities: readonly string[];
  dashboard: LiveDashboard;
  onChanged: () => void;
  onCampaignsRead: (campaigns: readonly Campaign[]) => void;
}) {
  if (mode === "demo") {
    return (
      <div className="view-stack">
        <UnsupportedState
          title="离线演示不创建自动化批次"
          detail="批次、运行和 target 必须来自租户会话范围内的实时 API；演示数据不会伪装成无人值守执行结果"
        />
      </div>
    );
  }

  return (
    <div className="view-stack">
      <ResourceState
        resource={dashboard.campaigns}
        empty={dashboard.campaigns.data.length === 0}
        emptyLabel="当前租户没有 Campaign"
      />
      <ResourceState
        resource={dashboard.channelAccounts}
        empty={dashboard.channelAccounts.data.length === 0}
        emptyLabel="当前租户没有平台账号"
      />
      <ResourceState
        resource={dashboard.automation}
        empty={dashboard.automation.data === null}
        emptyLabel="当前租户没有自动化控制"
      />
      <AutomationOperations
        api={api}
        tenantId={tenantId}
        campaigns={dashboard.campaigns.data}
        accounts={dashboard.channelAccounts.data}
        capabilities={capabilities}
        onChanged={onChanged}
        onCampaignsRead={onCampaignsRead}
      />
    </div>
  );
}

function VisibilityView({
  mode,
  api,
  tenantId,
  querySets,
  capabilities,
  onVisibilityChanged,
  providers,
  resource,
  demoTenant,
}: {
  mode: ConsoleMode;
  api: GeoApi;
  tenantId: string;
  querySets: readonly QuerySet[];
  capabilities: readonly string[];
  onVisibilityChanged: () => void;
  providers: ProviderRow[];
  resource: ApiResource<unknown>;
  demoTenant: TenantDemo | undefined;
}) {
  const [provider, setProvider] = useState<"all" | "doubao" | "qwen">("all");
  const demoQueryRuns = demoTenant === undefined ? [] : queryRunsForTenant(demoTenant);
  const visible =
    provider === "all" ? providers : providers.filter((item) => item.providerKey === provider);
  const observations = visible.reduce((sum, item) => sum + item.samples, 0);
  const mentionRate =
    observations === 0
      ? null
      : visible.reduce((sum, item) => sum + item.samples * item.mentionRate, 0) / observations;
  const accuracy =
    observations === 0
      ? null
      : visible.reduce((sum, item) => sum + item.samples * item.contactAccuracy, 0) / observations;
  const harmfulErrors = visible.reduce((sum, item) => sum + item.harmfulErrors, 0);
  return (
    <div className="view-stack">
      <div className="toolbar-row">
        <div className="segmented-control" aria-label="模型筛选">
          <button className={provider === "all" ? "active" : ""} onClick={() => setProvider("all")}>
            全部
          </button>
          <button
            className={provider === "doubao" ? "active" : ""}
            onClick={() => setProvider("doubao")}
          >
            豆包
          </button>
          <button
            className={provider === "qwen" ? "active" : ""}
            onClick={() => setProvider("qwen")}
          >
            千问
          </button>
        </div>
        <StatusBadge tone="warning">
          {mode === "demo" ? "演示证据：Fixture" : "实时 KPI：默认排除 Fixture"}
        </StatusBadge>
      </div>
      {mode === "live" ? (
        <>
          <ResourceState resource={resource} empty={false} emptyLabel="暂无可见性观测" />
          <QuerySetManager
            api={api}
            querySets={querySets}
            canManage={capabilities.includes("visibility:run")}
            onChanged={onVisibilityChanged}
          />
          <VisibilityOperations
            api={api}
            tenantId={tenantId}
            querySets={querySets}
            capabilities={capabilities}
            onChanged={onVisibilityChanged}
          />
        </>
      ) : null}
      <section className="metric-band visibility-metrics">
        <div className="metric-cell">
          <span>品牌命中率</span>
          <strong>
            {mode === "demo" ? "34.5%" : mentionRate === null ? "—" : `${mentionRate.toFixed(1)}%`}
          </strong>
          <small>{observations} 个样本</small>
        </div>
        <div className="metric-cell">
          <span>联系方式准确率</span>
          <strong>
            {mode === "demo" ? "96.0%" : accuracy === null ? "—" : `${accuracy.toFixed(1)}%`}
          </strong>
          <small>当前筛选加权聚合</small>
        </div>
        <div className="metric-cell">
          <span>有害错误</span>
          <strong>{mode === "demo" ? "1" : harmfulErrors}</strong>
          <small>绝对样本数</small>
        </div>
        <div className="metric-cell">
          <span>证据维度</span>
          <strong>{mode === "demo" ? "Fixture" : visible.length}</strong>
          <small>逐行保留来源边界</small>
        </div>
      </section>
      {mode === "demo" ? (
        <section className="panel">
          <PanelHeading
            title="查询样本"
            meta="同一 query 按 surface 重复采样，不与 Google 排名合并"
          />
          <div className="table-scroll">
            <table className="visibility-query-table">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>意图</th>
                  {provider !== "qwen" && <th>豆包</th>}
                  {provider !== "doubao" && <th>千问</th>}
                  <th>证据</th>
                </tr>
              </thead>
              <tbody>
                {demoQueryRuns.map((run) => (
                  <tr key={run.prompt}>
                    <td>
                      <strong>{run.prompt}</strong>
                    </td>
                    <td>{run.intent}</td>
                    {provider !== "qwen" && <td>{run.doubao}</td>}
                    {provider !== "doubao" && <td>{run.qwen}</td>}
                    <td>
                      <StatusBadge tone="warning">{run.evidence} · 演示</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="panel">
          <PanelHeading
            title="证据维度汇总"
            meta="每行保持 provider / surface / model / search / method / evidence，不与 Google 排名合并"
          />
          <div className="table-scroll">
            <table className="visibility-summary-table">
              <thead>
                <tr>
                  <th>Provider / Surface</th>
                  <th>Model / Search</th>
                  <th>观测方法 / 证据</th>
                  <th>样本数</th>
                  <th>品牌命中率</th>
                  <th>联系方式准确率</th>
                  <th>有害错误</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="primary-cell">
                        <strong>{item.provider}</strong>
                        <span>{item.surface}</span>
                      </div>
                    </td>
                    <td>
                      <div className="primary-cell">
                        <strong>{item.model}</strong>
                        <span>search: {item.searchMode}</span>
                      </div>
                    </td>
                    <td>
                      <div className="primary-cell">
                        <strong>{item.observationMethod}</strong>
                        <span>{item.evidence}</span>
                      </div>
                    </td>
                    <td>{item.samples}</td>
                    <td>{item.mentionRate.toFixed(1)}%</td>
                    <td>{item.contactAccuracy.toFixed(1)}%</td>
                    <td>{item.harmfulErrors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SourceCaption endpoint="GET /api/visibility/summary · 默认排除 fixture" />
        </section>
      )}
    </div>
  );
}

function AuditView({
  mode,
  audits,
  demoTenant,
  api,
  canExport,
}: {
  mode: ConsoleMode;
  audits: ApiResource<readonly AuditArtifact[]>;
  demoTenant: TenantDemo | undefined;
  api: GeoApi;
  canExport: boolean;
}) {
  const registeredPhone = demoTenant?.hotline.trim() || "当前租户未登记";
  const finalDigit = registeredPhone.at(-1);
  const detectedPhone =
    finalDigit !== undefined && /^[0-9]$/.test(finalDigit)
      ? `${registeredPhone.slice(0, -1)}${(Number(finalDigit) + 1) % 10}`
      : "未登记号码";
  if (mode === "live") {
    return (
      <section className="panel">
        <PanelHeading title="审计运行" meta="不可变 artifact、payload hash 与规则发现" />
        <ResourceState
          resource={audits}
          empty={audits.data.length === 0}
          emptyLabel="暂无审计运行"
        />
        {audits.data.length === 0 ? null : (
          <AuditOperationsList audits={audits.data} api={api} canExport={canExport} />
        )}
        <SourceCaption endpoint="GET /api/audits" />
      </section>
    );
  }
  return (
    <div className="audit-layout">
      <section className="panel">
        <PanelHeading title="审计运行" meta="演示不可变报告" />
        <div className="finding-list expanded-findings">
          {auditFindings.map((finding, index) => (
            <button
              className={`audit-select-row ${index === 0 ? "selected" : ""}`}
              key={finding.id}
            >
              <span
                className={`finding-dot ${finding.severity === "阻断" ? "dot-danger" : "dot-warning"}`}
              />
              <div>
                <strong>{finding.asset}</strong>
                <span>
                  {finding.rule} · {finding.time}
                </span>
              </div>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      </section>
      <section className="panel audit-detail">
        <PanelHeading
          title="contact.phone.unapproved"
          meta={`演示规则 · ${demoTenant?.industry ?? "通用行业"}`}
          action={<StatusBadge tone="danger">阻断</StatusBadge>}
        />
        <dl className="detail-grid">
          <div>
            <dt>变体</dt>
            <dd>北京出发欧洲跟团游 · 搜狐号</dd>
          </div>
          <div>
            <dt>检测值</dt>
            <dd className="mono danger-text">{detectedPhone}</dd>
          </div>
          <div>
            <dt>登记值</dt>
            <dd className="mono">{registeredPhone}</dd>
          </div>
          <div>
            <dt>Payload hash</dt>
            <dd className="mono hash-value">a4d9…18cf</dd>
          </div>
          <div>
            <dt>Policy hash</dt>
            <dd className="mono hash-value">73be…9a21</dd>
          </div>
          <div>
            <dt>Grant</dt>
            <dd>未签发</dd>
          </div>
        </dl>
        <div className="code-evidence">
          <span>payload.bodyMarkdown</span>
          <pre>
            24小时咨询：<mark>{detectedPhone}</mark>
          </pre>
        </div>
        <div className="detail-actions">
          <button className="button-secondary" disabled>
            <Eye size={16} /> 查看完整变体
          </button>
          <button className="button-primary" disabled>
            <RefreshCw size={16} /> 修复后重新审计
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsView({
  mode,
  accounts,
  campaigns,
  resource,
  automation,
  canManageAutomation,
  onSaveAutomationControl,
  onSaveScopedAutomationControl,
  onSetCircuitBreaker,
}: {
  mode: ConsoleMode;
  accounts: AccountRow[];
  campaigns: CampaignRow[];
  resource: ApiResource<unknown>;
  automation: ApiResource<AutomationSnapshot | null>;
  canManageAutomation: boolean;
  onSaveAutomationControl: (input: {
    readonly mode: AutomationMode;
    readonly quota: AutomationQuota;
    readonly reason: string;
  }) => Promise<void>;
  onSaveScopedAutomationControl: (
    scopeType: Exclude<AutomationScopeType, "tenant">,
    scopeKey: string,
    input: {
      readonly mode: AutomationMode;
      readonly quota: AutomationQuota;
      readonly killSwitchEnabled: boolean;
      readonly reason: string;
    },
  ) => Promise<void>;
  onSetCircuitBreaker: (
    scopeType: AutomationScopeType,
    scopeKey: string,
    input: { readonly targetState: "open" | "closed"; readonly reason: string },
  ) => Promise<void>;
}) {
  const [scopedControlIntent, setScopedControlIntent] = useState<
    ScopedAutomationControl | "new" | null
  >(null);
  const [circuitIntent, setCircuitIntent] = useState<{
    readonly scopeType: AutomationScopeType;
    readonly scopeKey: string;
    readonly targetState: "open" | "closed";
  } | null>(null);
  return (
    <div className="view-stack">
      <section className="panel policy-settings">
        <PanelHeading title="第一版能力边界" meta="以当前代码与运行证据为准" />
        {[
          ["多租户客户治理", "已接入", "租户、品牌、成员、联系方式与资源范围"],
          ["GEO 模板与规范草稿", "已接入", "21 套 V1 模板、事实引用、平台变体与确定性审计"],
          ["自动化批次", "Dry-run", "后台 Producer 可无人值守推进，但固定为 dry_run"],
          ["头条 / 搜狐 / 携程外部发布", "未接入", "仅 manual_only、预览回执与人工发布包"],
          ["豆包 / 千问在线评测", "未接入", "仅 Fixture 或人工导入证据，不代表在线搜索结果"],
          ["生产级图片生成", "未接入", "确定性 Fixture 只验证管线，不作为生产图片"],
          ["品牌记忆正负反馈闭环", "未接入", "第一版不根据投放结果自动改写长期品牌记忆"],
        ].map(([name, status, detail]) => (
          <div className="setting-control" key={name}>
            <div>
              <strong>{name}</strong>
              <span>{detail}</span>
            </div>
            <StatusBadge
              tone={status === "已接入" ? "success" : status === "Dry-run" ? "warning" : "info"}
            >
              {status}
            </StatusBadge>
          </div>
        ))}
      </section>
      <section className="panel">
        <PanelHeading title="平台账号与能力" meta="能力升级必须绑定发布和 reconciliation 证据" />
        {mode === "live" ? (
          <ResourceState
            resource={resource}
            empty={accounts.length === 0}
            emptyLabel="暂无平台账号"
          />
        ) : null}
        <div className="settings-list">
          {accounts.map((account) => (
            <div className="settings-row" key={account.id}>
              <span className="platform-initial">{account.platform.slice(0, 1)}</span>
              <div className="settings-primary">
                <strong>{account.account}</strong>
                <span>检查于 {account.lastCheck}</span>
              </div>
              <div>
                <small>Capability</small>
                <strong>{account.capability}</strong>
              </div>
              <div>
                <small>Execution</small>
                <StatusBadge tone="info">{account.execution}</StatusBadge>
              </div>
              <div>
                <small>证据</small>
                <span>{account.evidence}</span>
              </div>
              <button
                className="icon-button"
                aria-label={`设置 ${account.platform}`}
                title="账号设置"
                disabled
              >
                <Settings size={17} />
              </button>
            </div>
          ))}
        </div>
        {mode === "live" ? <SourceCaption endpoint="GET /api/channel-accounts" /> : null}
      </section>
      <section className="panel policy-settings">
        <PanelHeading title="自动化策略" meta={mode === "demo" ? "演示租户" : "实时治理控制"} />
        {mode === "live" ? (
          <>
            <ResourceState
              resource={automation}
              empty={automation.data === null}
              emptyLabel="未配置自动化控制"
            />
            {automation.data === null ? null : (
              <>
                <AutomationControlEditor
                  control={automation.data.control}
                  canManage={canManageAutomation}
                  onSave={onSaveAutomationControl}
                />
                <div className="setting-control">
                  <div>
                    <strong>Kill Switch</strong>
                    <span>{automation.data.control.reason ?? "未记录原因"}</span>
                  </div>
                  <StatusBadge
                    tone={automation.data.control.killSwitchEnabled ? "danger" : "success"}
                  >
                    {automation.data.control.killSwitchEnabled ? "已开启" : "已关闭"}
                  </StatusBadge>
                </div>
                <div className="setting-control">
                  <div>
                    <strong>更新时间</strong>
                    <span>服务端记录</span>
                  </div>
                  <output className="setting-value">
                    {formatDateTime(automation.data.control.updatedAt)}
                  </output>
                </div>
                <div className="automation-subsection-heading">
                  <div>
                    <strong>细分范围控制</strong>
                    <span>平台、账号、Campaign 或主题；Worker 会叠加所有匹配范围</span>
                  </div>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!canManageAutomation}
                    onClick={() => setScopedControlIntent("new")}
                  >
                    <Plus size={16} /> 添加范围控制
                  </button>
                </div>
                <div className="scope-control-list">
                  {automation.data.controls.filter((control) => control.scopeType !== "tenant")
                    .length === 0 ? (
                    <span className="muted">没有细分范围控制</span>
                  ) : (
                    automation.data.controls
                      .filter((control) => control.scopeType !== "tenant")
                      .map((control) => (
                        <div key={control.id}>
                          <div>
                            <strong>
                              {control.scopeType}:{control.scopeKey}
                            </strong>
                            <span>{control.reason ?? "未记录原因"}</span>
                          </div>
                          <StatusBadge tone={control.killSwitchEnabled ? "danger" : "info"}>
                            {control.killSwitchEnabled ? "已急停" : control.mode}
                          </StatusBadge>
                          <small>{JSON.stringify(control.quota)}</small>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`编辑范围控制 ${control.scopeType}:${control.scopeKey}`}
                            title="编辑范围控制"
                            disabled={!canManageAutomation}
                            onClick={() => setScopedControlIntent(control)}
                          >
                            <Settings size={16} />
                          </button>
                        </div>
                      ))
                  )}
                </div>
                <div className="automation-subsection-heading">
                  <div>
                    <strong>熔断器</strong>
                    <span>自动信号或人工处置都必须保留范围、原因和状态</span>
                  </div>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!canManageAutomation}
                    onClick={() =>
                      setCircuitIntent({ scopeType: "tenant", scopeKey: "*", targetState: "open" })
                    }
                  >
                    <ShieldAlert size={16} /> 手动熔断
                  </button>
                </div>
                <div className="circuit-list">
                  {automation.data.circuits.length === 0 ? (
                    <span className="muted">没有熔断记录</span>
                  ) : (
                    automation.data.circuits.map((circuit) => (
                      <div key={circuit.id}>
                        <div>
                          <strong>
                            {circuit.scopeType}:{circuit.scopeKey}
                          </strong>
                          <span>{circuit.reason ?? "未记录原因"}</span>
                        </div>
                        <StatusBadge
                          tone={
                            circuit.state === "open"
                              ? "danger"
                              : circuit.state === "half_open"
                                ? "warning"
                                : "success"
                          }
                        >
                          {circuit.state}
                        </StatusBadge>
                        <small>
                          {circuit.failureCount} 次 · {formatDateTime(circuit.updatedAt)}
                        </small>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`${circuit.state === "closed" ? "打开" : "关闭"}熔断 ${circuit.scopeType}:${circuit.scopeKey}`}
                          title={circuit.state === "closed" ? "打开熔断" : "关闭熔断"}
                          disabled={!canManageAutomation}
                          onClick={() =>
                            setCircuitIntent({
                              scopeType: circuit.scopeType as AutomationScopeType,
                              scopeKey: circuit.scopeKey,
                              targetState: circuit.state === "closed" ? "open" : "closed",
                            })
                          }
                        >
                          {circuit.state === "closed" ? (
                            <ShieldAlert size={16} />
                          ) : (
                            <RefreshCw size={16} />
                          )}
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <SourceCaption endpoint="GET /api/automation" />
              </>
            )}
          </>
        ) : (
          <>
            <div className="setting-control">
              <div>
                <strong>默认运行模式</strong>
                <span>新 Campaign 从 Shadow 开始</span>
              </div>
              <select defaultValue="shadow">
                <option value="shadow">Shadow</option>
                <option value="supervised">监督投放</option>
                <option value="unattended" disabled>
                  无人值守（无 API 证据）
                </option>
              </select>
            </div>
            <div className="setting-control">
              <div>
                <strong>每日 Dry-run 配额</strong>
                <span>演示值</span>
              </div>
              <input type="number" defaultValue="120" min="1" />
            </div>
            <div className="setting-control">
              <div>
                <strong>联系方式准确率熔断</strong>
                <span>演示值</span>
              </div>
              <input type="number" defaultValue="95" min="0" max="100" />
            </div>
          </>
        )}
      </section>
      {scopedControlIntent === null || automation.data === null ? null : (
        <ScopedAutomationControlDialog
          key={scopedControlIntent === "new" ? "new" : scopedControlIntent.id}
          initial={scopedControlIntent === "new" ? null : scopedControlIntent}
          tenantControl={automation.data.control}
          accounts={accounts}
          campaigns={campaigns}
          onClose={() => setScopedControlIntent(null)}
          onConfirm={onSaveScopedAutomationControl}
        />
      )}
      {circuitIntent === null ? null : (
        <CircuitBreakerDialog
          key={`${circuitIntent.scopeType}:${circuitIntent.scopeKey}:${circuitIntent.targetState}`}
          initial={circuitIntent}
          accounts={accounts}
          campaigns={campaigns}
          onClose={() => setCircuitIntent(null)}
          onConfirm={onSetCircuitBreaker}
        />
      )}
    </div>
  );
}

const AUTOMATION_MODE_OPTIONS: readonly {
  readonly value: AutomationMode;
  readonly label: string;
}[] = [
  { value: "shadow", label: "Shadow · 仅 Dry-run" },
  { value: "supervised", label: "监督调度" },
  { value: "unattended", label: "无人值守调度" },
  { value: "paused", label: "暂停" },
  { value: "stopped", label: "停止" },
];

const AUTOMATION_QUOTA_FIELDS: readonly {
  readonly key: keyof AutomationQuota;
  readonly label: string;
  readonly detail: string;
  readonly min: number;
  readonly max: number;
}[] = [
  { key: "maxConcurrent", label: "最大并发", detail: "同时执行的投放任务", min: 1, max: 100 },
  { key: "perMinute", label: "每分钟上限", detail: "一分钟内的新尝试", min: 1, max: 10_000 },
  { key: "perDay", label: "每日上限", detail: "24 小时内的新尝试", min: 1, max: 1_000_000 },
  { key: "cooldownSeconds", label: "冷却秒数", detail: "同范围尝试间隔", min: 0, max: 86_400 },
  { key: "errorBudget", label: "错误预算", detail: "24 小时失败阈值", min: 1, max: 100_000 },
];

function quotaNumber(
  quota: Readonly<Record<string, unknown>>,
  key: keyof AutomationQuota,
  fallback: number,
): number {
  const value = quota[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function quotaFromControl(control: AutomationControl): AutomationQuota {
  return {
    maxConcurrent: quotaNumber(control.quota, "maxConcurrent", 1),
    perMinute: quotaNumber(control.quota, "perMinute", 10),
    perDay: quotaNumber(control.quota, "perDay", 100),
    cooldownSeconds: quotaNumber(control.quota, "cooldownSeconds", 0),
    errorBudget: quotaNumber(control.quota, "errorBudget", 5),
  };
}

function AutomationControlEditor({
  control,
  canManage,
  onSave,
}: {
  control: AutomationControl;
  canManage: boolean;
  onSave: (input: {
    readonly mode: AutomationMode;
    readonly quota: AutomationQuota;
    readonly reason: string;
  }) => Promise<void>;
}) {
  const [selectedMode, setSelectedMode] = useState<AutomationMode>(control.mode);
  const [quota, setQuota] = useState<AutomationQuota>(() => quotaFromControl(control));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedMode(control.mode);
    setQuota(quotaFromControl(control));
    setReason("");
  }, [control.mode, control.quota, control.updatedAt]);

  const quotaIsValid =
    quota.maxConcurrent >= 1 &&
    quota.maxConcurrent <= quota.perMinute &&
    quota.perMinute <= quota.perDay &&
    quota.cooldownSeconds >= 0 &&
    quota.errorBudget >= 1;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !quotaIsValid || reason.trim().length < 3) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ mode: selectedMode, quota, reason: reason.trim() });
    } catch (submitError) {
      setError(apiErrorText(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="automation-control-form" onSubmit={(event) => void submit(event)}>
      {error === null ? null : (
        <div className="auth-error" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="setting-control">
        <div>
          <strong>租户运行模式</strong>
          <span>无人值守只调度已审计 Dry-run，不提升平台发布能力</span>
        </div>
        <select
          aria-label="运行模式"
          value={selectedMode}
          disabled={!canManage || pending}
          onChange={(event) => setSelectedMode(event.target.value as AutomationMode)}
        >
          {AUTOMATION_MODE_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="automation-quota-grid">
        {AUTOMATION_QUOTA_FIELDS.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <small>{field.detail}</small>
            <input
              aria-label={field.label}
              type="number"
              value={quota[field.key]}
              min={field.min}
              max={field.max}
              disabled={!canManage || pending}
              onChange={(event) =>
                setQuota((current) => ({
                  ...current,
                  [field.key]: Number(event.target.value),
                }))
              }
            />
          </label>
        ))}
      </div>
      <label className="automation-control-reason">
        <span>变更原因</span>
        <textarea
          aria-label="自动化变更原因"
          value={reason}
          minLength={3}
          maxLength={500}
          rows={3}
          required
          disabled={!canManage || pending}
          placeholder="例如：审计规则与 Dry-run 样本已复核，启用无人值守调度"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="automation-control-actions">
        {!canManage ? <span>需要 automation:manage 权限</span> : null}
        {!quotaIsValid ? <span>并发 ≤ 每分钟 ≤ 每日，且错误预算至少为 1</span> : null}
        <button
          type="submit"
          className="button-primary"
          disabled={!canManage || pending || !quotaIsValid || reason.trim().length < 3}
        >
          {pending ? <LoaderCircle className="spin" size={16} /> : <SlidersHorizontal size={16} />}
          {pending ? "等待回读" : "保存自动化策略"}
        </button>
      </div>
    </form>
  );
}

type EditableAutomationScopeType = Exclude<AutomationScopeType, "tenant">;

function automationScopeOptions(
  scopeType: AutomationScopeType,
  accounts: readonly AccountRow[],
  campaigns: readonly CampaignRow[],
): readonly { readonly value: string; readonly label: string }[] {
  switch (scopeType) {
    case "tenant":
      return [{ value: "*", label: "当前租户" }];
    case "platform":
      return [
        { value: "toutiao", label: "头条号" },
        { value: "sohu", label: "搜狐号" },
        { value: "ctrip_community", label: "携程社区" },
      ];
    case "account":
      return accounts.map((account) => ({
        value: account.id,
        label: `${account.platform} · ${account.account}`,
      }));
    case "campaign":
      return campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }));
    case "topic":
      return [
        ...new Map(
          campaigns.map((campaign) => [
            campaign.topic,
            { value: campaign.topic, label: `${campaign.topic} · ${campaign.name}` },
          ]),
        ).values(),
      ];
  }
}

function ScopedAutomationControlDialog({
  initial,
  tenantControl,
  accounts,
  campaigns,
  onClose,
  onConfirm,
}: {
  initial: ScopedAutomationControl | null;
  tenantControl: AutomationControl;
  accounts: readonly AccountRow[];
  campaigns: readonly CampaignRow[];
  onClose: () => void;
  onConfirm: (
    scopeType: EditableAutomationScopeType,
    scopeKey: string,
    input: {
      readonly mode: AutomationMode;
      readonly quota: AutomationQuota;
      readonly killSwitchEnabled: boolean;
      readonly reason: string;
    },
  ) => Promise<void>;
}) {
  const initialScopeType: EditableAutomationScopeType =
    initial !== null && initial.scopeType !== "tenant" ? initial.scopeType : "platform";
  const [scopeType, setScopeType] = useState(initialScopeType);
  const [scopeKey, setScopeKey] = useState(
    initial?.scopeKey ??
      automationScopeOptions(initialScopeType, accounts, campaigns)[0]?.value ??
      "",
  );
  const [selectedMode, setSelectedMode] = useState<AutomationMode>(
    initial?.mode ?? tenantControl.mode,
  );
  const [quota, setQuota] = useState<AutomationQuota>(() =>
    quotaFromControl(initial ?? tenantControl),
  );
  const [killSwitchEnabled, setKillSwitchEnabled] = useState(initial?.killSwitchEnabled ?? false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = automationScopeOptions(scopeType, accounts, campaigns);

  useEffect(() => {
    if (!options.some((option) => option.value === scopeKey)) {
      setScopeKey(options[0]?.value ?? "");
    }
  }, [options, scopeKey]);

  const valid =
    scopeKey.length > 0 &&
    quota.maxConcurrent >= 1 &&
    quota.maxConcurrent <= quota.perMinute &&
    quota.perMinute <= quota.perDay &&
    quota.cooldownSeconds >= 0 &&
    quota.errorBudget >= 1 &&
    reason.trim().length >= 3;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(scopeType, scopeKey, {
        mode: selectedMode,
        quota,
        killSwitchEnabled,
        reason: reason.trim(),
      });
      onClose();
    } catch (submitError) {
      setError(apiErrorText(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={pending ? undefined : onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scoped-control-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="scoped-control-title">{initial === null ? "添加范围控制" : "编辑范围控制"}</h2>
            <p>细分范围与租户控制叠加执行，任一范围关闭都会阻断任务</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              <AlertTriangle size={16} /> <span>{error}</span>
            </div>
          )}
          <div className="automation-dialog-grid">
            <label>
              范围类型
              <select
                aria-label="范围类型"
                value={scopeType}
                disabled={pending || initial !== null}
                onChange={(event) =>
                  setScopeType(event.target.value as EditableAutomationScopeType)
                }
              >
                <option value="platform">平台</option>
                <option value="account">账号</option>
                <option value="campaign">Campaign</option>
                <option value="topic">主题</option>
              </select>
            </label>
            <label>
              范围对象
              <select
                aria-label="范围对象"
                value={scopeKey}
                disabled={pending || initial !== null || options.length === 0}
                onChange={(event) => setScopeKey(event.target.value)}
              >
                {options.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              运行模式
              <select
                aria-label="范围运行模式"
                value={selectedMode}
                disabled={pending}
                onChange={(event) => setSelectedMode(event.target.value as AutomationMode)}
              >
                {AUTOMATION_MODE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="automation-checkbox">
              <input
                aria-label="范围 Kill Switch"
                type="checkbox"
                checked={killSwitchEnabled}
                disabled={pending}
                onChange={(event) => setKillSwitchEnabled(event.target.checked)}
              />
              启用该范围 Kill Switch
            </label>
          </div>
          <div className="automation-quota-grid dialog-quota-grid">
            {AUTOMATION_QUOTA_FIELDS.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <small>{field.detail}</small>
                <input
                  aria-label={`范围${field.label}`}
                  type="number"
                  value={quota[field.key]}
                  min={field.min}
                  max={field.max}
                  disabled={pending}
                  onChange={(event) =>
                    setQuota((current) => ({
                      ...current,
                      [field.key]: Number(event.target.value),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <label>
            变更原因
            <textarea
              aria-label="范围控制变更原因"
              value={reason}
              minLength={3}
              maxLength={500}
              rows={3}
              required
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button type="submit" className="button-primary" disabled={pending || !valid}>
              {pending ? <LoaderCircle className="spin" size={16} /> : <Settings size={16} />}
              {pending ? "等待回读" : "保存范围控制"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CircuitBreakerDialog({
  initial,
  accounts,
  campaigns,
  onClose,
  onConfirm,
}: {
  initial: {
    readonly scopeType: AutomationScopeType;
    readonly scopeKey: string;
    readonly targetState: "open" | "closed";
  };
  accounts: readonly AccountRow[];
  campaigns: readonly CampaignRow[];
  onClose: () => void;
  onConfirm: (
    scopeType: AutomationScopeType,
    scopeKey: string,
    input: { readonly targetState: "open" | "closed"; readonly reason: string },
  ) => Promise<void>;
}) {
  const [scopeType, setScopeType] = useState<AutomationScopeType>(initial.scopeType);
  const [scopeKey, setScopeKey] = useState(initial.scopeKey);
  const [targetState, setTargetState] = useState(initial.targetState);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = automationScopeOptions(scopeType, accounts, campaigns);

  useEffect(() => {
    if (!options.some((option) => option.value === scopeKey)) {
      setScopeKey(options[0]?.value ?? "");
    }
  }, [options, scopeKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scopeKey.length === 0 || reason.trim().length < 3) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(scopeType, scopeKey, { targetState, reason: reason.trim() });
      onClose();
    } catch (submitError) {
      setError(apiErrorText(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={pending ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="circuit-control-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="circuit-control-title">人工熔断处置</h2>
            <p>打开会阻断匹配任务；关闭会清零失败计数和半开探针</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              <AlertTriangle size={16} /> <span>{error}</span>
            </div>
          )}
          <label>
            范围类型
            <select
              aria-label="熔断范围类型"
              value={scopeType}
              disabled={pending}
              onChange={(event) => setScopeType(event.target.value as AutomationScopeType)}
            >
              <option value="tenant">租户</option>
              <option value="platform">平台</option>
              <option value="account">账号</option>
              <option value="campaign">Campaign</option>
              <option value="topic">主题</option>
            </select>
          </label>
          <label>
            范围对象
            <select
              aria-label="熔断范围对象"
              value={scopeKey}
              disabled={pending || options.length === 0}
              onChange={(event) => setScopeKey(event.target.value)}
            >
              {options.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            目标状态
            <select
              aria-label="熔断目标状态"
              value={targetState}
              disabled={pending}
              onChange={(event) => setTargetState(event.target.value as "open" | "closed")}
            >
              <option value="open">打开熔断</option>
              <option value="closed">关闭并清零</option>
            </select>
          </label>
          <label>
            处置原因
            <textarea
              aria-label="熔断处置原因"
              value={reason}
              minLength={3}
              maxLength={500}
              rows={4}
              required
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button
              type="submit"
              className={targetState === "open" ? "button-danger" : "button-primary"}
              disabled={pending || scopeKey.length === 0 || reason.trim().length < 3}
            >
              {pending ? (
                <LoaderCircle className="spin" size={16} />
              ) : targetState === "open" ? (
                <ShieldAlert size={16} />
              ) : (
                <RefreshCw size={16} />
              )}
              {pending ? "等待回读" : targetState === "open" ? "确认熔断" : "确认关闭"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CampaignFormValue {
  readonly name: string;
  readonly topic: string;
  readonly objective: string;
  readonly industry: string;
  readonly brandId: string;
}

interface CampaignBrandOption {
  readonly brandId: string;
  readonly industry: string;
  readonly label: string;
}

function NewCampaignDialog({
  mode,
  brandOptions,
  canCreate,
  defaultIndustry,
  onClose,
  onCreate,
}: {
  mode: ConsoleMode;
  brandOptions: readonly CampaignBrandOption[];
  canCreate: boolean;
  defaultIndustry: string;
  onClose: () => void;
  onCreate: (value: CampaignFormValue) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [objective, setObjective] = useState("");
  const [industry, setIndustry] = useState(defaultIndustry);
  const [brandId, setBrandId] = useState(brandOptions[0]?.brandId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveBlocked = mode === "live" && (!canCreate || brandOptions.length === 0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      name.trim().length === 0 ||
      topic.trim().length === 0 ||
      industry.trim().length === 0 ||
      liveBlocked
    )
      return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        topic: topic.trim(),
        objective: objective.trim() || topic.trim(),
        industry: industry.trim(),
        brandId,
      });
      onClose();
    } catch (createError) {
      setError(apiErrorText(createError));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-campaign-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="new-campaign-title">新建 Campaign</h2>
            <p>{mode === "demo" ? "演示数据 · 默认 Shadow" : "写入 POST /api/campaigns"}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          {liveBlocked ? (
            <UnsupportedState
              title="当前租户不可创建 Campaign"
              detail="需要 content:write 权限、可用的品牌目录和已就绪的 Campaign 资源"
            />
          ) : null}
          <label>
            Campaign 名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="例如：东南亚亲子线路问答集"
              required
            />
          </label>
          <label>
            主题范围
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="地区 / 客群 / 意图"
              required
            />
          </label>
          {mode === "live" ? (
            <>
              <label>
                目标
                <input
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder="本次 Campaign 的可验证目标"
                />
              </label>
              <label>
                品牌
                <select
                  value={brandId}
                  onChange={(event) => {
                    const nextBrandId = event.target.value;
                    setBrandId(nextBrandId);
                    const nextBrand = brandOptions.find((brand) => brand.brandId === nextBrandId);
                    if (nextBrand !== undefined) setIndustry(nextBrand.industry);
                  }}
                  required
                >
                  {brandOptions.map((brand) => (
                    <option key={brand.brandId} value={brand.brandId}>
                      {brand.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <label>
            行业
            <input
              list="campaign-industry-options"
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              placeholder="例如 travel、education、retail"
              required
            />
            <datalist id="campaign-industry-options">
              <option value="general" />
              <option value="travel" />
              <option value="hospitality" />
              <option value="education" />
              <option value="professional_services" />
              <option value="retail" />
              <option value="technology" />
            </datalist>
          </label>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={submitting || liveBlocked || industry.trim().length === 0}
            >
              {submitting ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {submitting ? "正在创建" : "创建 Campaign"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function KillSwitchDialog({
  enabled,
  onClose,
  onConfirm,
}: {
  enabled: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length === 0) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (submitError) {
      setError(apiErrorText(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={pending ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kill-switch-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="kill-switch-title">{enabled ? "开启 Kill Switch" : "关闭 Kill Switch"}</h2>
            <p>状态仅在 API 写入并回读一致后更新</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          <label>
            操作原因
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={1}
              maxLength={500}
              rows={4}
              required
              autoFocus
              placeholder={
                enabled
                  ? "例如：发现联系方式准确率异常，暂停当前租户投放"
                  : "例如：异常已复核并完成修正，恢复 Shadow"
              }
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button
              type="submit"
              className={enabled ? "button-danger" : "button-primary"}
              disabled={pending || reason.trim().length === 0}
            >
              {pending ? (
                <LoaderCircle className="spin" size={16} />
              ) : enabled ? (
                <PauseCircle size={16} />
              ) : (
                <RefreshCw size={16} />
              )}
              {pending ? "等待回读" : enabled ? "确认暂停" : "确认恢复"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function liveCampaignRows(items: readonly Campaign[]): CampaignRow[] {
  return items.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    topic: campaign.topicKey,
    mode: stateLabel(campaign.status),
    articles: null,
    passRate: null,
    updatedAt: null,
    brandId: campaign.brandId,
    objective: campaign.objective,
    industry: campaign.industry,
  }));
}

function demoCampaignRows(items: readonly CampaignDemo[]): CampaignRow[] {
  return items.map((campaign) => ({
    ...campaign,
    brandId: null,
    objective: campaign.topic,
  }));
}

function liveContentRows(items: readonly ContentItem[], brands: readonly Brand[]): ContentRow[] {
  const industryByBrand = new Map(brands.map((brand) => [brand.id, brand.industry]));
  return items.map((item, index) => {
    const images = contentImagesForIndustry(industryByBrand.get(item.brandId) ?? "general");
    return {
      id: item.id,
      title: item.title,
      type: contentTypeLabel(item.contentType),
      platform: null,
      status: stateLabel(item.state),
      statusTone: stateTone(item.state),
      updatedAt: item.latestVersion === null ? null : `版本 ${item.latestVersion}`,
      image: images[index % images.length] ?? images[0] ?? "",
      imageAlt: isTravelIndustry(industryByBrand.get(item.brandId) ?? "general")
        ? "旅行内容素材缩略图"
        : "内容素材缩略图",
      campaignId: item.campaignId,
    };
  });
}

function livePublicationRows(
  jobs: readonly PublicationJob[],
  receipts: readonly PublicationReceipt[],
): PublicationRow[] {
  const byJob = new Map<string, PublicationReceipt>();
  for (const receipt of receipts) if (!byJob.has(receipt.jobId)) byJob.set(receipt.jobId, receipt);
  return jobs.map((job) => {
    const receipt = byJob.get(job.id);
    return {
      id: job.id,
      title: `变体 ${shortId(job.variantId)}`,
      platform: platformLabel(job.platform),
      level: executionLabel(job.executionLevel),
      state: stateLabel(job.state),
      evidence: receipt === undefined ? "尚无回执" : evidenceLabel(receipt.evidenceType),
      time: formatDateTime(job.updatedAt),
      confirmed: receipt?.evidenceType === "preview" ? false : (receipt?.confirmed ?? null),
      externalUrl: receipt?.evidenceType === "preview" ? null : (receipt?.externalUrl ?? null),
    };
  });
}

function liveProviderRows(items: readonly VisibilityProviderSummary[]): ProviderRow[] {
  return items.map((item) => ({
    id: [
      item.provider,
      item.productSurface,
      item.model,
      item.searchMode,
      item.observationMethod,
      item.evidenceType,
    ].join("|"),
    provider: item.provider === "doubao" ? "豆包" : "千问",
    providerKey: item.provider,
    surface: item.productSurface,
    model: item.model,
    searchMode: item.searchMode,
    observationMethod: item.observationMethod,
    mentionRate: item.brandMentionRate * 100,
    contactAccuracy: item.contactAccuracy * 100,
    harmfulErrors: item.harmfulErrors,
    samples: item.observations,
    bars: [Math.max(item.observations, 1)],
    evidence: evidenceLabel(item.evidenceType),
  }));
}

function liveAccountRows(items: readonly ChannelAccount[]): AccountRow[] {
  return items.map((item) => ({
    id: item.id,
    platformKey: item.platform,
    platform: platformLabel(item.platform),
    account: item.displayName,
    capability: capabilityLabel(item.capability),
    execution: item.supportedExecutionLevels.map(executionLabel).join(" / "),
    evidence: `${evidenceLabel(item.evidenceType)} · ${item.evidenceRefs.length} refs`,
    health: item.status,
    lastCheck: item.lastVerifiedAt === null ? "未返回" : formatDateTime(item.lastVerifiedAt),
  }));
}

export function App({ api: suppliedApi, initialMode = "live" }: AppProps = {}) {
  const location = useLocation();
  const api = useMemo(() => suppliedApi ?? createGeoApi(), [suppliedApi]);
  const [auth, setAuth] = useState<AuthState>(
    initialMode === "demo" ? { status: "demo" } : { status: "loading" },
  );
  const [knownTenants, setKnownTenants] = useState<readonly TenantOption[]>([]);
  const [dashboard, setDashboard] = useState<LiveDashboard>(createLoadingDashboard);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [demoTenantId, setDemoTenantId] = useState(demoTenants[0]?.id ?? "");
  const [demoCampaigns, setDemoCampaigns] = useState(initialCampaigns);
  const [demoKillSwitch, setDemoKillSwitch] = useState(false);
  const [killSwitchIntent, setKillSwitchIntent] = useState<boolean | null>(null);
  const [killSwitchPending, setKillSwitchPending] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [newCampaignOpen, setNewCampaignOpen] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [sessionActionPending, setSessionActionPending] = useState(false);

  useEffect(() => {
    if (auth.status !== "loading") return;
    let active = true;
    api
      .getSession()
      .then((session) => {
        if (!active) return;
        setKnownTenants((items) =>
          mergeTenantOptions(items, [
            { slug: session.tenant.slug, displayName: session.tenant.displayName },
          ]),
        );
        setAuth({ status: "authenticated", session });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuth({
          status: "unauthenticated",
          error: isAuthenticationError(error) ? null : sessionBootstrapErrorText(error),
          tenantSlug: undefined,
        });
      });
    return () => {
      active = false;
    };
  }, [api, auth.status]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let active = true;
    setDashboard(createLoadingDashboard());
    loadLiveDashboard(api).then((next) => {
      if (!active) return;
      if (dashboardHasAuthenticationError(next)) {
        setAuth({
          status: "unauthenticated",
          error: "会话已失效，请重新登录",
          tenantSlug: auth.session.tenant.slug,
        });
        return;
      }
      setKnownTenants((items) => mergeTenantOptions(items, next.tenants.data));
      setDashboard(next);
    });
    return () => {
      active = false;
    };
  }, [api, auth.status === "authenticated" ? auth.session.tenant.id : "", refreshVersion]);

  if (auth.status === "loading") {
    return (
      <main className="boot-screen" role="status">
        <LoaderCircle className="spin" size={24} />
        <strong>正在检查 GEO API 会话</strong>
        <span>GET /api/auth/session</span>
      </main>
    );
  }

  if (auth.status === "unauthenticated") {
    return (
      <LoginView
        api={api}
        initialError={auth.error}
        initialTenantSlug={auth.tenantSlug}
        knownTenants={knownTenants}
        onAuthenticated={(session) => {
          setKnownTenants((items) =>
            mergeTenantOptions(items, [
              { slug: session.tenant.slug, displayName: session.tenant.displayName },
            ]),
          );
          setAuth({ status: "authenticated", session });
        }}
        onDemo={() => setAuth({ status: "demo" })}
        onTenantsDiscovered={(tenants) =>
          setKnownTenants((items) => mergeTenantOptions(items, tenants))
        }
      />
    );
  }

  const mode: ConsoleMode = auth.status === "demo" ? "demo" : "live";
  const session = auth.status === "authenticated" ? auth.session : null;
  const demoTenant = demoTenants.find((tenant) => tenant.id === demoTenantId) ?? demoTenants[0];
  const tenant = dashboard.tenant.data;
  const campaignRows =
    mode === "demo" ? demoCampaignRows(demoCampaigns) : liveCampaignRows(dashboard.campaigns.data);
  const contentRows: ContentRow[] =
    mode === "demo"
      ? demoContentItems.map((item) => ({
          ...item,
          imageAlt: "旅行内容素材缩略图",
          campaignId: null,
        }))
      : liveContentRows(dashboard.content.data, dashboard.brands.data);
  const publicationRows: PublicationRow[] =
    mode === "demo"
      ? demoPublicationRows.map((row) => ({
          ...row,
          confirmed: false,
          externalUrl: null,
        }))
      : livePublicationRows(dashboard.publicationJobs.data, dashboard.receipts.data);
  const providerRows: ProviderRow[] =
    mode === "demo"
      ? demoProviderMetrics.map((item) => ({
          id: `demo-${item.provider}`,
          provider: item.provider,
          providerKey: item.provider === "豆包" ? "doubao" : "qwen",
          surface: item.surface,
          model: "演示模型",
          searchMode: "unknown",
          observationMethod: "fixture",
          mentionRate: item.mentionRate,
          contactAccuracy: item.contactAccuracy,
          harmfulErrors: item.contactAccuracy < 100 ? 1 : 0,
          samples: item.samples,
          bars: item.bars,
          evidence: "Fixture",
        }))
      : liveProviderRows(dashboard.visibility.data);
  const accountRows: AccountRow[] =
    mode === "demo"
      ? (demoTenant === undefined ? [] : platformAccountsForTenant(demoTenant)).map((item) => ({
          id: item.platform,
          platformKey: null,
          platform: item.platform,
          account: item.account,
          capability: item.capability,
          execution: item.execution,
          evidence: "演示 Preview",
          health: item.health,
          lastCheck: item.lastCheck,
        }))
      : liveAccountRows(dashboard.channelAccounts.data);
  const liveContacts = dashboard.contacts.data;
  const liveTenantOptions =
    dashboard.tenants.status === "ready" ? dashboard.tenants.data : knownTenants;
  const customerRows: CustomerRow[] =
    mode === "demo"
      ? demoTenants.map((item) => ({ ...item, slug: item.id }))
      : liveTenantOptions.map((option) => {
          const current = option.slug === session?.tenant.slug;
          return {
            id: option.slug,
            name: option.displayName,
            shortName: option.displayName,
            industry: current && tenant !== null ? tenant.industry : "切换后读取",
            hotline: current
              ? (liveContacts.find((contact) => contact.type === "phone" && contact.isPrimary)
                  ?.value ??
                liveContacts.find((contact) => contact.type === "phone")?.value ??
                "")
              : "",
            wechat: current
              ? liveContacts
                  .filter((contact) => contact.type === "wechat")
                  .map((contact) => contact.value)
              : [],
            status: option.status ?? (current && tenant !== null ? tenant.status : "可切换"),
            slug: option.slug,
          };
        });
  const currentTenantId = mode === "demo" ? demoTenantId : (session?.tenant.slug ?? "");
  const killSwitch =
    mode === "demo"
      ? demoKillSwitch
      : (dashboard.automation.data?.control.killSwitchEnabled ?? null);
  const killSwitchWritable =
    mode === "demo" ||
    (dashboard.automation.status === "ready" &&
      dashboard.automation.data !== null &&
      session?.actor.capabilities.includes("automation:manage") === true);
  const title = routeTitles[location.pathname] ?? routeTitles["/overview"];
  const brandOptions: CampaignBrandOption[] =
    mode === "demo"
      ? []
      : [...dashboard.brands.data]
          .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
          .map((brand) => ({
            brandId: brand.id,
            industry: brand.industry,
            label: `${brand.displayName}${brand.isPrimary ? " · 主品牌" : ""}`,
          }));
  const campaignCreateBlockReason =
    mode === "demo"
      ? null
      : session?.actor.capabilities.includes("content:write") !== true
        ? "需要 content:write 权限"
        : dashboard.brands.status !== "ready"
          ? "品牌目录尚未就绪"
          : brandOptions.length === 0
            ? "请先为当前租户创建品牌"
            : dashboard.campaigns.status !== "ready"
              ? "Campaign 资源尚未就绪"
              : null;
  const canCreateCampaign = campaignCreateBlockReason === null;
  const defaultCampaignIndustry =
    mode === "demo"
      ? (demoTenant?.industry ?? "general")
      : (brandOptions[0]?.industry ?? tenant?.industry ?? "general");
  const dashboardErrors =
    mode === "live"
      ? Object.values(dashboard).filter(
          (value): value is ApiResource<unknown> =>
            typeof value === "object" &&
            value !== null &&
            "status" in value &&
            value.status === "error",
        ).length
      : 0;

  async function logout() {
    if (mode === "demo") {
      setAuth({ status: "unauthenticated", error: null, tenantSlug: undefined });
      return;
    }
    setSessionActionPending(true);
    setSessionActionError(null);
    try {
      await api.logout();
      setDashboard(createLoadingDashboard());
      setAuth({ status: "unauthenticated", error: null, tenantSlug: undefined });
    } catch (error) {
      setSessionActionError(apiErrorText(error));
    } finally {
      setSessionActionPending(false);
    }
  }

  async function switchTenant(tenantSlug: string) {
    if (mode !== "live" || tenantSlug === session?.tenant.slug) return;
    const option = knownTenants.find((item) => item.slug === tenantSlug);
    if (option?.status === "unavailable") {
      setSessionActionError("TENANT_UNAVAILABLE: 该租户当前不可切换");
      return;
    }
    setSessionActionPending(true);
    setSessionActionError(null);
    try {
      const switched = await api.switchTenant(tenantSlug);
      if (switched.tenant.slug !== tenantSlug) {
        throw new GeoApiError(
          409,
          "TENANT_SWITCH_READBACK_MISMATCH",
          "切换响应中的租户与请求不一致",
        );
      }
      setKnownTenants((items) =>
        mergeTenantOptions(items, [
          { slug: switched.tenant.slug, displayName: switched.tenant.displayName },
        ]),
      );
      setDashboard(createLoadingDashboard());
      setAuth({ status: "authenticated", session: switched });
    } catch (error) {
      setSessionActionError(apiErrorText(error));
    } finally {
      setSessionActionPending(false);
    }
  }

  async function confirmKillSwitch(reason: string) {
    if (killSwitchIntent === null) return;
    if (mode === "demo") {
      setDemoKillSwitch(killSwitchIntent);
      return;
    }
    setKillSwitchPending(true);
    try {
      await api.setKillSwitch({ enabled: killSwitchIntent, reason });
      const readback = await api.getAutomation();
      if (readback.control.killSwitchEnabled !== killSwitchIntent) {
        throw new GeoApiError(
          409,
          "KILL_SWITCH_READBACK_MISMATCH",
          "Kill Switch 写入后的 API 回读状态不一致",
        );
      }
      setDashboard((current) => ({
        ...current,
        automation: {
          endpoint: "GET /api/automation",
          data: readback,
          error: null,
          status: "ready",
        },
        loadedAt: new Date().toISOString(),
      }));
    } finally {
      setKillSwitchPending(false);
    }
  }

  async function saveAutomationControl(input: {
    readonly mode: AutomationMode;
    readonly quota: AutomationQuota;
    readonly reason: string;
  }) {
    if (mode !== "live") return;
    await api.setAutomationControl(input);
    const readback = await api.getAutomation();
    const quotaMatches = Object.entries(input.quota).every(
      ([key, value]) => readback.control.quota[key] === value,
    );
    if (readback.control.mode !== input.mode || !quotaMatches) {
      throw new GeoApiError(
        409,
        "AUTOMATION_CONTROL_READBACK_MISMATCH",
        "自动化策略写入后的 API 回读状态不一致",
      );
    }
    setDashboard((current) => ({
      ...current,
      automation: {
        endpoint: "GET /api/automation",
        data: readback,
        error: null,
        status: "ready",
      },
      loadedAt: new Date().toISOString(),
    }));
  }

  async function saveScopedAutomationControl(
    scopeType: Exclude<AutomationScopeType, "tenant">,
    scopeKey: string,
    input: {
      readonly mode: AutomationMode;
      readonly quota: AutomationQuota;
      readonly killSwitchEnabled: boolean;
      readonly reason: string;
    },
  ) {
    if (mode !== "live") return;
    await api.setScopedAutomationControl(scopeType, scopeKey, input);
    const readback = await api.getAutomation();
    const stored = readback.controls.find(
      (control) => control.scopeType === scopeType && control.scopeKey === scopeKey,
    );
    const quotaMatches =
      stored !== undefined &&
      Object.entries(input.quota).every(([key, value]) => stored.quota[key] === value);
    if (
      stored === undefined ||
      stored.mode !== input.mode ||
      stored.killSwitchEnabled !== input.killSwitchEnabled ||
      !quotaMatches
    ) {
      throw new GeoApiError(
        409,
        "SCOPED_AUTOMATION_READBACK_MISMATCH",
        "范围控制写入后的 API 回读状态不一致",
      );
    }
    setDashboard((current) => ({
      ...current,
      automation: {
        endpoint: "GET /api/automation",
        data: readback,
        error: null,
        status: "ready",
      },
      loadedAt: new Date().toISOString(),
    }));
  }

  async function setCircuitBreaker(
    scopeType: AutomationScopeType,
    scopeKey: string,
    input: { readonly targetState: "open" | "closed"; readonly reason: string },
  ) {
    if (mode !== "live") return;
    await api.setCircuitBreakerState(scopeType, scopeKey, input);
    const readback = await api.getAutomation();
    const stored = readback.circuits.find(
      (circuit) => circuit.scopeType === scopeType && circuit.scopeKey === scopeKey,
    );
    if (stored?.state !== input.targetState) {
      throw new GeoApiError(
        409,
        "CIRCUIT_STATE_READBACK_MISMATCH",
        "熔断状态写入后的 API 回读状态不一致",
      );
    }
    setDashboard((current) => ({
      ...current,
      automation: {
        endpoint: "GET /api/automation",
        data: readback,
        error: null,
        status: "ready",
      },
      loadedAt: new Date().toISOString(),
    }));
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <span>G</span>
          <div>
            <strong>GEO Console</strong>
            <small>Evidence operations</small>
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <div className="tenant-switcher">
          <label htmlFor="tenant-select">{mode === "demo" ? "当前客户" : "当前会话租户"}</label>
          <div>
            <Building2 size={16} />
            <select
              id="tenant-select"
              value={mode === "demo" ? demoTenantId : (session?.tenant.slug ?? "")}
              disabled={
                sessionActionPending ||
                (mode === "live" &&
                  (dashboard.tenants.status !== "ready" ||
                    knownTenants.filter((item) => item.status !== "unavailable").length <= 1))
              }
              onChange={(event) => {
                if (mode === "demo") setDemoTenantId(event.target.value);
                else void switchTenant(event.target.value);
              }}
            >
              {mode === "demo"
                ? demoTenants.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.shortName}
                    </option>
                  ))
                : knownTenants.map((item) => (
                    <option
                      value={item.slug}
                      key={item.slug}
                      disabled={item.status === "unavailable"}
                    >
                      {item.displayName}
                      {item.status === "unavailable" ? "（不可用）" : ""}
                    </option>
                  ))}
            </select>
          </div>
          {mode === "live" && dashboard.tenants.status !== "ready" ? (
            <small className="tenant-limit">租户目录当前不可用</small>
          ) : mode === "live" &&
            knownTenants.filter((item) => item.status !== "unavailable").length <= 1 ? (
            <small className="tenant-limit">没有其他可用租户</small>
          ) : null}
        </div>
        <nav className="main-nav" aria-label="主导航">
          {navigation.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={() => setMobileNavOpen(false)}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="system-health">
            <span
              className={`health-pulse ${mode === "live" && dashboardErrors > 0 ? "health-error" : ""}`}
            />
            <div>
              <strong>
                {mode === "demo"
                  ? "离线演示模式"
                  : dashboardErrors > 0
                    ? `${dashboardErrors} 个接口异常`
                    : dashboard.loadedAt === null
                      ? "正在读取服务"
                      : "实时 API 已连接"}
              </strong>
              <small>{mode === "demo" ? "不代表真实状态" : "API · tenant scope"}</small>
            </div>
          </div>
          <button
            className="nav-utility"
            onClick={() => void logout()}
            disabled={sessionActionPending}
          >
            <LogOut size={17} />
            <span>{mode === "demo" ? "退出演示" : "退出登录"}</span>
          </button>
        </div>
      </aside>
      {mobileNavOpen ? (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-label="关闭导航遮罩"
        />
      ) : null}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="打开导航"
          >
            <Menu size={20} />
          </button>
          <div className="page-title">
            <h1>{title?.title}</h1>
            <p>{title?.subtitle}</p>
          </div>
          <div className="topbar-actions">
            <div className="search-control">
              <Search size={16} />
              <input aria-label="全局搜索" placeholder="搜索文章、作业或证据" disabled />
            </div>
            <button
              className="icon-button notification-button"
              aria-label="通知"
              title="通知"
              disabled
            >
              <Bell size={18} />
            </button>
            <button
              className="avatar-button"
              title={session?.actor.displayName ?? session?.actor.role ?? "演示操作员"}
            >
              <span>
                {mode === "demo"
                  ? "演示"
                  : (session?.actor.displayName ?? session?.actor.role ?? "API").slice(0, 2)}
              </span>
            </button>
          </div>
        </header>
        <div className="context-bar">
          <div>
            <span className="tenant-avatar">
              {(mode === "demo"
                ? (demoTenant?.shortName ?? "演")
                : (tenant?.displayName ?? session?.tenant.displayName ?? "租")
              ).slice(0, 1)}
            </span>
            <strong>
              {mode === "demo"
                ? demoTenant?.name
                : (tenant?.displayName ?? session?.tenant.displayName)}
            </strong>
            <StatusBadge
              tone={mode === "demo" ? "warning" : dashboardErrors > 0 ? "danger" : "success"}
            >
              {mode === "demo"
                ? demoTenant?.status
                : dashboardErrors > 0
                  ? "部分 API 异常"
                  : "实时会话"}
            </StatusBadge>
          </div>
          <div className="context-actions">
            <StatusBadge tone={mode === "demo" ? "warning" : "info"}>
              {mode === "demo" ? "演示数据" : "实时 API"}
            </StatusBadge>
            {mode === "live" ? (
              <button
                className="icon-button"
                aria-label="刷新实时数据"
                title="刷新实时数据"
                onClick={() => setRefreshVersion((value) => value + 1)}
              >
                <RefreshCw size={16} />
              </button>
            ) : null}
            <button
              className="button-primary"
              onClick={() => setNewCampaignOpen(true)}
              disabled={!canCreateCampaign}
              title={campaignCreateBlockReason ?? undefined}
            >
              <Plus size={16} /> 新建 Campaign
            </button>
          </div>
        </div>
        {sessionActionError === null ? null : (
          <div className="global-error" role="alert">
            <AlertTriangle size={16} />
            <span>{sessionActionError}</span>
            <button
              className="icon-button"
              onClick={() => setSessionActionError(null)}
              aria-label="关闭错误"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <main className="main-content">
          <Routes>
            <Route
              path="/overview"
              element={
                <OverviewView
                  mode={mode}
                  campaigns={campaignRows}
                  content={contentRows}
                  publicationRows={publicationRows}
                  providers={providerRows}
                  accounts={accountRows}
                  dashboard={dashboard}
                  killSwitch={killSwitch}
                  killSwitchWritable={killSwitchWritable}
                  killSwitchPending={killSwitchPending}
                  onToggleKillSwitch={() => {
                    if (mode === "demo") setDemoKillSwitch((value) => !value);
                    else if (killSwitch !== null) setKillSwitchIntent(!killSwitch);
                  }}
                />
              }
            />
            <Route
              path="/customers"
              element={
                <CustomersView
                  mode={mode}
                  customers={customerRows}
                  currentTenantId={currentTenantId}
                  directoryResource={dashboard.tenants}
                  tenantResource={dashboard.tenant}
                  contactsResource={dashboard.contacts}
                  contactsEmpty={liveContacts.length === 0}
                  discoveredTenants={knownTenants}
                  brands={dashboard.brands.data}
                  brandAgentProfiles={dashboard.brandAgentProfiles.data}
                  members={dashboard.members.data}
                  policies={dashboard.policies.data}
                  contacts={dashboard.contacts.data}
                  accounts={dashboard.channelAccounts.data}
                  principals={dashboard.servicePrincipals.data}
                  querySets={dashboard.querySets.data}
                  brandResource={dashboard.brands}
                  brandAgentProfileResource={dashboard.brandAgentProfiles}
                  memberResource={dashboard.members}
                  policyResource={dashboard.policies}
                  querySetResource={dashboard.querySets}
                  capabilities={session?.actor.capabilities ?? []}
                  api={api}
                  onChanged={() => setRefreshVersion((version) => version + 1)}
                />
              }
            />
            <Route
              path="/content"
              element={
                <ContentView
                  mode={mode}
                  items={contentRows}
                  api={api}
                  tenantId={currentTenantId}
                  capabilities={session?.actor.capabilities ?? []}
                  dashboard={dashboard}
                />
              }
            />
            <Route
              path="/publishing"
              element={
                <PublishingView
                  mode={mode}
                  api={api}
                  tenantId={currentTenantId}
                  capabilities={session?.actor.capabilities ?? []}
                  accounts={accountRows}
                  rows={publicationRows}
                  dashboard={dashboard}
                  killSwitch={killSwitch}
                  killSwitchWritable={killSwitchWritable}
                  killSwitchPending={killSwitchPending}
                  onToggleKillSwitch={() => {
                    if (mode === "demo") setDemoKillSwitch((value) => !value);
                    else if (killSwitch !== null) setKillSwitchIntent(!killSwitch);
                  }}
                />
              }
            />
            <Route
              path="/automation"
              element={
                <AutomationView
                  key={currentTenantId}
                  mode={mode}
                  api={api}
                  tenantId={currentTenantId}
                  capabilities={session?.actor.capabilities ?? []}
                  dashboard={dashboard}
                  onChanged={() => setRefreshVersion((value) => value + 1)}
                  onCampaignsRead={(campaigns) =>
                    setDashboard((current) => ({
                      ...current,
                      campaigns: {
                        endpoint: "GET /api/campaigns",
                        data: campaigns,
                        error: null,
                        status: "ready",
                      },
                      loadedAt: new Date().toISOString(),
                    }))
                  }
                />
              }
            />
            <Route
              path="/visibility"
              element={
                <VisibilityView
                  key={currentTenantId}
                  mode={mode}
                  api={api}
                  tenantId={currentTenantId}
                  querySets={dashboard.querySets.data}
                  capabilities={session?.actor.capabilities ?? []}
                  onVisibilityChanged={() => setRefreshVersion((value) => value + 1)}
                  providers={providerRows}
                  resource={dashboard.visibility}
                  demoTenant={demoTenant}
                />
              }
            />
            <Route
              path="/audit"
              element={
                <AuditView
                  mode={mode}
                  audits={dashboard.audits}
                  demoTenant={demoTenant}
                  api={api}
                  canExport={session?.actor.capabilities.includes("publish:request") ?? false}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsView
                  mode={mode}
                  accounts={accountRows}
                  campaigns={campaignRows}
                  resource={dashboard.channelAccounts}
                  automation={dashboard.automation}
                  canManageAutomation={
                    mode === "demo" ||
                    (session?.actor.capabilities.includes("automation:manage") ?? false)
                  }
                  onSaveAutomationControl={saveAutomationControl}
                  onSaveScopedAutomationControl={saveScopedAutomationControl}
                  onSetCircuitBreaker={setCircuitBreaker}
                />
              }
            />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
      {newCampaignOpen ? (
        <NewCampaignDialog
          key={currentTenantId}
          mode={mode}
          brandOptions={brandOptions}
          canCreate={canCreateCampaign}
          defaultIndustry={defaultCampaignIndustry}
          onClose={() => setNewCampaignOpen(false)}
          onCreate={async (value) => {
            if (mode === "demo") {
              setDemoCampaigns((items) => [
                {
                  id: `cmp-${Date.now()}`,
                  name: value.name,
                  topic: value.topic,
                  industry: value.industry,
                  mode: "Shadow",
                  articles: 0,
                  passRate: 0,
                  updatedAt: "刚刚",
                },
                ...items,
              ]);
              return;
            }
            await api.createCampaign({
              brandId: value.brandId,
              name: value.name,
              objective: value.objective,
              industry: value.industry,
              topicKey: value.topic,
            });
            setRefreshVersion((version) => version + 1);
          }}
        />
      ) : null}
      {killSwitchIntent === null ? null : (
        <KillSwitchDialog
          enabled={killSwitchIntent}
          onClose={() => setKillSwitchIntent(null)}
          onConfirm={confirmKillSwitch}
        />
      )}
    </div>
  );
}
