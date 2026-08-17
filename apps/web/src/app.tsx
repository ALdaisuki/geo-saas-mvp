import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Database,
  Eye,
  ExternalLink,
  FileCheck2,
  FileText,
  LayoutDashboard,
  Layers3,
  LoaderCircle,
  Hourglass,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PauseCircle,
  Phone,
  Plus,
  Power,
  KeyRound,
  RefreshCw,
  Radar,
  Save,
  Search,
  Send,
  ServerCog,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  Users,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
  type CtripPlatformAnalyticsDashboard,
  type CtripBridgeStatus,
  type CustomerSetupReadiness,
  type GeoApi,
  type PriorityPlatformAnalyticsDashboard,
  type PublicationJob,
  type PolicyBundle,
  type PublicationAssistedHandoff,
  type PublicationReceipt,
  type QuerySet,
  type RuntimeProviderConfigDocument,
  type RuntimeProviderConfigKey,
  type RuntimeProviderConfigSection,
  type ServicePrincipal,
  type SessionSnapshot,
  type ScopedAutomationControl,
  type TenantContact,
  type TenantOption,
  type TenantMember,
  type TenantView,
  type TrendTopicCandidate,
  type VisibilityProviderSummary,
} from "./api.js";
import {
  RUNTIME_PROVIDER_BUILTIN_TEMPLATES,
  RUNTIME_PROVIDER_CONFIG_KEYS,
  type RuntimeProviderTemplate,
} from "./runtime-provider-presets.js";
import { ArticleTemplateCatalog } from "./article-template-catalog.js";
import { BrandAgentProfileEditor } from "./brand-agent-profile-editor.js";
import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATES,
  DEFAULT_ARTICLE_TEMPLATE_ID,
} from "@geo/contracts";
import { AutomationOperations } from "./automation-operations.js";
import { ChannelAccountDirectory, isRealChannelAccount } from "./channel-account-directory.js";
import { AccountLoginHandoffRoute } from "./ctrip-login-handoff.js";
import {
  createLoadingDashboard,
  dashboardHasAuthenticationError,
  loadChannelAccountsResource,
  loadCtripAccountAnalyticsResource,
  loadPriorityPlatformAnalyticsResource,
  loadLiveDashboard,
  loadLiveOperationsResources,
  resourceErrorText,
  type ApiResource,
  type LiveDashboard,
} from "./dashboard.js";
import { AuditOperationsList, OperationsWorkspace, PublicationJobDetail } from "./operations.js";
import { VisibilityOperations } from "./visibility-operations.js";
import { QuerySetManager } from "./query-set-manager.js";
import { TenantGovernance } from "./tenant-governance.js";
import {
  accountDisplayNameLabel,
  auditRuleLabel,
  auditSeverityLabel,
  connectorCapabilityLabel,
  contentTypeLabel,
  evidenceTypeLabel,
  executionLevelLabel,
  industryLabel,
  memberRoleLabel,
  observationMethodLabel,
  operationStatusLabel,
  searchModeLabel,
} from "./operation-labels.js";
import { useModalDialog } from "./use-modal-dialog.js";
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
  requiredModule?: ModuleKey;
}

interface NavigationGroup {
  label: string;
  items: NavigationItem[];
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

type ModuleKey = "trend_discovery" | "ai_content" | "priority_distribution" | "agent_automation";

const OPERATIONS_POLL_FALLBACK_MS = 5_000;

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated"; error: string | null; tenantSlug: string | undefined }
  | { status: "authenticated"; session: SessionSnapshot }
  | { status: "demo" };

export interface AppProps {
  readonly api?: GeoApi;
  readonly initialMode?: ConsoleMode;
  readonly operationsPollIntervalMs?: number;
}

const navigationGroups: NavigationGroup[] = [
  {
    label: "规划与内容",
    items: [
      { path: "/overview", label: "运营概览", icon: LayoutDashboard },
      { path: "/customers", label: "客户与品牌", icon: Building2 },
      { path: "/content", label: "内容资产", icon: FileText, requiredModule: "ai_content" },
    ],
  },
  {
    label: "执行与观测",
    items: [
      {
        path: "/accounts",
        label: "平台账号",
        icon: Users,
        requiredModule: "priority_distribution",
      },
      {
        path: "/publishing",
        label: "投放中心",
        icon: Send,
        requiredModule: "priority_distribution",
      },
      {
        path: "/automation",
        label: "自动化批次",
        icon: CalendarClock,
        requiredModule: "agent_automation",
      },
      { path: "/visibility", label: "AI 可见性", icon: Sparkles },
    ],
  },
  {
    label: "治理",
    items: [
      { path: "/audit", label: "审计与证据", icon: FileCheck2 },
      { path: "/settings", label: "系统设置", icon: Settings },
    ],
  },
];

const routeTitles: Record<string, { title: string; subtitle: string; section: string }> = {
  "/overview": {
    title: "运营概览",
    subtitle: "内容质量、投放队列与国内 AI 可见性",
    section: "运行总览",
  },
  "/customers": {
    title: "客户与品牌",
    subtitle: "租户隔离、品牌事实和联系方式版本",
    section: "工作空间",
  },
  "/content": {
    title: "内容资产",
    subtitle: "推广计划、文章版本与平台最终变体",
    section: "内容生产",
  },
  "/accounts": {
    title: "平台账号",
    subtitle: "多平台、多账号运营身份与授权状态",
    section: "渠道资源",
  },
  "/publishing": {
    title: "投放中心",
    subtitle: "发布许可、任务队列、回执、配额与熔断",
    section: "分发执行",
  },
  "/automation": {
    title: "自动化批次",
    subtitle: "多平台内容生成、账号轮换与发布确认",
    section: "任务编排",
  },
  "/visibility": {
    title: "AI 可见性",
    subtitle: "豆包与千问独立证据和重复样本",
    section: "效果观测",
  },
  "/audit": {
    title: "审计与证据",
    subtitle: "阻断项、载荷哈希与规则版本",
    section: "风险治理",
  },
  "/settings": {
    title: "系统设置",
    subtitle: "平台账号、能力证据和自动化策略",
    section: "控制中心",
  },
};

function hasModuleAccess(
  mode: ConsoleMode,
  enabledModules: readonly string[],
  requiredModule: ModuleKey,
): boolean {
  return mode === "demo" || enabledModules.includes(requiredModule);
}

function ModuleAccessBoundary({
  allowed,
  fallbackPath,
  children,
}: {
  allowed: boolean;
  fallbackPath: string;
  children: ReactNode;
}) {
  return allowed ? children : <Navigate to={fallbackPath} replace />;
}

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

function ContentPipeline({
  mode,
  campaigns,
  content,
  publicationRows,
  sourceCount,
  enabledModules,
}: {
  mode: ConsoleMode;
  campaigns: readonly CampaignRow[];
  content: readonly ContentRow[];
  publicationRows: readonly PublicationRow[];
  sourceCount: number;
  enabledModules: readonly string[];
}) {
  const masterDraftCount = content.filter((item) => item.platform === null).length;
  const variantCount = content.filter((item) => item.platform !== null).length;
  const reviewedCount = content.filter((item) =>
    ["已审计", "已批准", "已发布", "已确认"].includes(item.status),
  ).length;
  const activeJobs = publicationRows.filter((item) =>
    ["queued", "dispatching", "running", "等待", "投放中"].some((state) =>
      item.state.toLocaleLowerCase().includes(state),
    ),
  ).length;
  const confirmedCount = publicationRows.filter((item) => item.confirmed === true).length;
  const stages: readonly {
    readonly label: string;
    readonly detail: string;
    readonly icon: LucideIcon;
    readonly path: string;
    readonly tone: string;
    readonly requiredModules?: readonly ModuleKey[];
  }[] = [
    {
      label: "热点雷达",
      detail: mode === "demo" ? "6 条趋势信号" : `${sourceCount} 个治理来源`,
      icon: Radar,
      path: "/content",
      tone: "radar",
      requiredModules: ["trend_discovery", "ai_content"],
    },
    {
      label: "智能选题",
      detail: `${campaigns.length} 个推广主题`,
      icon: Search,
      path: "/content",
      tone: "topic",
      requiredModules: ["ai_content"],
    },
    {
      label: "AI 图文创作",
      detail: `${masterDraftCount} 篇主稿`,
      icon: WandSparkles,
      path: "/content",
      tone: "create",
      requiredModules: ["ai_content"],
    },
    {
      label: "平台变体",
      detail: `${variantCount} 个最终变体`,
      icon: Layers3,
      path: "/content",
      tone: "variant",
      requiredModules: ["ai_content"],
    },
    {
      label: "机器审核",
      detail: `${reviewedCount} 个变体通过`,
      icon: FileCheck2,
      path: "/audit",
      tone: "review",
    },
    {
      label: "异步发布",
      detail: `${publicationRows.length} 个作业 · ${activeJobs} 运行`,
      icon: Send,
      path: "/automation",
      tone: "delivery",
      requiredModules: ["agent_automation"],
    },
    {
      label: "发布确认",
      detail: `${confirmedCount} 篇已确认`,
      icon: Eye,
      path: "/publishing",
      tone: "readback",
      requiredModules: ["priority_distribution"],
    },
  ];
  const visibleStages = stages.filter(
    (stage) =>
      stage.requiredModules === undefined ||
      stage.requiredModules.every((module) => hasModuleAccess(mode, enabledModules, module)),
  );

  return (
    <section className="pipeline-band" aria-label="内容生产与分发流水线">
      <header>
        <div>
          <span>内容运营流水线</span>
          <strong>热点到平台发布</strong>
        </div>
        {hasModuleAccess(mode, enabledModules, "agent_automation") ? (
          <NavLink to="/automation" className="text-button">
            打开异步任务中心 <ChevronRight size={15} />
          </NavLink>
        ) : null}
      </header>
      <ol>
        {visibleStages.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <li key={stage.label} className={`pipeline-stage pipeline-${stage.tone}`}>
              <NavLink to={stage.path} aria-label={`打开${stage.label}`}>
                <span className="pipeline-stage-index">0{index + 1}</span>
                <span className="pipeline-stage-icon">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <span className="pipeline-stage-copy">
                  <strong>{stage.label}</strong>
                  <small>{stage.detail}</small>
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </NavLink>
              {index === visibleStages.length - 1 ? null : (
                <ArrowRight className="pipeline-arrow" size={17} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </section>
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

const demoTrendCandidates: readonly TrendTopicCandidate[] = [
  {
    id: "demo-trend-yunnan-agency",
    fingerprint: "demo-trend-yunnan-agency",
    title: "云南旅行社推荐与避坑清单",
    normalizedTitle: "云南旅行社推荐与避坑清单",
    observationIds: ["demo-observation-1", "demo-observation-2", "demo-observation-3"],
    observationCount: 3,
    sourceCount: 3,
    sourceKeys: ["toutiao", "baidu", "weibo"],
    heatScore: 96,
    freshnessScore: 0.97,
    freshnessBand: "emerging",
    firstObservedAt: "2026-08-03T13:36:00.000+08:00",
    latestObservedAt: "2026-08-03T13:48:00.000+08:00",
  },
  {
    id: "demo-trend-summer-travel",
    fingerprint: "demo-trend-summer-travel",
    title: "暑期出境游签证与行程准备",
    normalizedTitle: "暑期出境游签证与行程准备",
    observationIds: ["demo-observation-4", "demo-observation-5"],
    observationCount: 2,
    sourceCount: 2,
    sourceKeys: ["sohu", "netease"],
    heatScore: 88,
    freshnessScore: 0.89,
    freshnessBand: "rising",
    firstObservedAt: "2026-08-03T13:18:00.000+08:00",
    latestObservedAt: "2026-08-03T13:42:00.000+08:00",
  },
  {
    id: "demo-trend-senior-japan",
    fingerprint: "demo-trend-senior-japan",
    title: "银发客群日本跟团行程强度",
    normalizedTitle: "银发客群日本跟团行程强度",
    observationIds: ["demo-observation-6", "demo-observation-7"],
    observationCount: 2,
    sourceCount: 2,
    sourceKeys: ["zhihu", "toutiao"],
    heatScore: 76,
    freshnessScore: 0.72,
    freshnessBand: "rising",
    firstObservedAt: "2026-08-03T12:55:00.000+08:00",
    latestObservedAt: "2026-08-03T13:31:00.000+08:00",
  },
  {
    id: "demo-trend-family-tour",
    fingerprint: "demo-trend-family-tour",
    title: "东南亚亲子游酒店与交通选择",
    normalizedTitle: "东南亚亲子游酒店与交通选择",
    observationIds: ["demo-observation-8"],
    observationCount: 1,
    sourceCount: 1,
    sourceKeys: ["weibo"],
    heatScore: 68,
    freshnessScore: 0.58,
    freshnessBand: "cooling",
    firstObservedAt: "2026-08-03T12:20:00.000+08:00",
    latestObservedAt: "2026-08-03T12:58:00.000+08:00",
  },
];

function trendSourceLabel(sourceKey: string): string {
  return (
    {
      toutiao: "头条",
      baidu: "百度",
      weibo: "微博",
      zhihu: "知乎",
      sohu: "搜狐",
      netease: "网易",
    }[sourceKey] ?? sourceKey
  );
}

function trendFreshnessLabel(band: TrendTopicCandidate["freshnessBand"]): string {
  return {
    emerging: "刚出现",
    rising: "上升中",
    cooling: "降温中",
    stale: "较陈旧",
    expired: "已过期",
  }[band];
}

function HotspotRadar({
  mode,
  dashboard,
  canUseAiContent,
}: {
  mode: ConsoleMode;
  dashboard: LiveDashboard;
  canUseAiContent: boolean;
}) {
  const candidates = mode === "demo" ? demoTrendCandidates : dashboard.trendCandidates.data;
  return (
    <section className="panel hotspot-radar-panel" aria-label="热点雷达">
      <PanelHeading
        title="热点雷达"
        meta={mode === "demo" ? "六源趋势演示" : "最近 24 小时租户候选"}
        action={
          canUseAiContent ? (
            <NavLink className="text-button" to="/content">
              进入选题 <ChevronRight size={15} />
            </NavLink>
          ) : undefined
        }
      />
      {mode === "live" ? (
        <ResourceState
          resource={dashboard.trendCandidates}
          empty={candidates.length === 0}
          emptyLabel="暂无新鲜热点候选"
        />
      ) : null}
      {candidates.length === 0 ? null : (
        <div className="hotspot-list">
          {candidates.slice(0, 6).map((candidate, index) => (
            <article className="hotspot-row" key={candidate.id}>
              <span className="hotspot-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="hotspot-copy">
                <strong>{candidate.title}</strong>
                <small>
                  {candidate.observationCount} 条观察 · {formatDateTime(candidate.latestObservedAt)}
                </small>
              </div>
              <div className="hotspot-sources" aria-label="热点来源">
                {candidate.sourceKeys.slice(0, 3).map((source) => (
                  <span key={source}>{trendSourceLabel(source)}</span>
                ))}
              </div>
              <span className={`hotspot-freshness freshness-${candidate.freshnessBand}`}>
                {trendFreshnessLabel(candidate.freshnessBand)}
              </span>
              <div className="hotspot-heat" aria-label={`热度 ${Math.round(candidate.heatScore)}`}>
                <span>
                  <i style={{ width: `${Math.min(100, Math.max(0, candidate.heatScore))}%` }} />
                </span>
                <strong>{Math.round(candidate.heatScore)}</strong>
              </div>
            </article>
          ))}
        </div>
      )}
      {mode === "live" && candidates.length > 0 ? (
        <SourceCaption endpoint="GET /api/trends/topic-candidates" loadedAt={dashboard.loadedAt} />
      ) : null}
    </section>
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
    baijiahao: "百家号",
    netease: "网易号",
    ctrip_community: "携程社区",
    zhihu: "知乎",
  };
  return labels[platform] ?? platform;
}

function demoChannelAccountsForTenant(tenant: TenantDemo): readonly ChannelAccount[] {
  return platformAccountsForTenant(tenant).map((item) => {
    const platform = {
      头条号: "toutiao",
      搜狐号: "sohu",
      百家号: "baijiahao",
      网易号: "netease",
      携程社区: "ctrip_community",
    }[item.platform] satisfies ChannelAccount["platform"];
    return {
      id: `${tenant.id}-${platform}`,
      platform,
      displayName: item.account,
      capability: item.capability === "人工操作" ? "manual_only" : item.capability,
      supportedExecutionLevels: ["dry_run"],
      evidenceType: "preview",
      evidenceRefs: [],
      status: item.health === "正常" ? "active" : "disabled",
      lastVerifiedAt: null,
    };
  });
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
    handoff_pending: "待交接",
    session_required: "需登录",
    challenge_required: "需人工验证",
    draft_prepared: "草稿已准备",
    awaiting_operator_submit: "等待最终提交",
    submitted_unconfirmed: "已提交待确认",
    readback_pending: "等待发布确认",
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
  return labels[state] ?? operationStatusLabel(state);
}

function assistedReadbackUncertain(handoff: PublicationAssistedHandoff): boolean {
  return [
    "ASSISTED_READBACK_UNCERTAIN",
    "ASSISTED_READBACK_DEADLINE_EXCEEDED",
    "ASSISTED_READBACK_ATTEMPTS_EXHAUSTED",
  ].includes(handoff.lastErrorCode ?? "");
}

function assistedReadbackDeferred(handoff: PublicationAssistedHandoff): boolean {
  return (
    handoff.state === "readback_pending" && handoff.lastErrorCode === "ASSISTED_READBACK_DEFERRED"
  );
}

function assistedHandoffStateLabel(handoff: PublicationAssistedHandoff): string {
  if (assistedReadbackDeferred(handoff)) return "异步回读中";
  return assistedReadbackUncertain(handoff) ? "结果不明确" : stateLabel(handoff.state);
}

function assistedEnvironmentLabel(
  handoff: PublicationAssistedHandoff,
): "仿真环境" | "浏览器预检" | "实时桥接" {
  const adapterVersion = handoff.adapterVersion.toLowerCase();
  if (
    adapterVersion.includes("simulator") ||
    handoff.submitEvidenceKind === "simulation" ||
    handoff.readbackEvidenceKind === "simulation"
  ) {
    return "仿真环境";
  }
  if (adapterVersion.includes("browser-preflight")) return "浏览器预检";
  return "实时桥接";
}

function ctripOperationalMessage(status: CtripBridgeStatus["operationalStatus"]): string {
  const messages = {
    ready: "携程已登录，自动化发布准备就绪",
    session_required: "需要在专用 Edge 中登录携程，登录后系统会自动恢复",
    challenge_required: "携程要求完成验证码或安全验证，请在专用 Edge 中人工完成",
    unavailable: "携程自动化暂不可用，请检查宿主监督器和 Bridge 状态",
  } as const;
  return messages[status];
}

function assistedSubmitObservation(handoff: PublicationAssistedHandoff): string {
  if (assistedReadbackDeferred(handoff)) {
    return "已提交，等待平台审核 · 禁止重复提交";
  }
  if (handoff.submitOutcome === null && handoff.submitPermitConsumedAt !== null) {
    return "许可已消费 · 禁止重试 · 等待对账";
  }
  if (handoff.submitOutcome === null) return "尚未提交";
  if (handoff.submitOutcome === "accepted") {
    return handoff.submitEvidenceKind === "simulation"
      ? "模拟接受 · 未确认"
      : "已观察接受 · 未确认";
  }
  if (handoff.submitOutcome === "uncertain") return "结果不确定 · 禁止自动重试";
  if (handoff.submitOutcome === "not_accepted") {
    return "平台未受理发布 · 创作者后台仍为草稿";
  }
  return "提交被拒绝 · 需复核";
}

function assistedReadbackObservation(handoff: PublicationAssistedHandoff): string {
  if (assistedReadbackUncertain(handoff)) return "10 分钟超时 · 结果不明确";
  if (assistedReadbackDeferred(handoff)) return "平台审核中 · 后台低频回读";
  if (handoff.readbackOutcome === null) return "尚未回读";
  if (
    handoff.readbackOutcome === "simulation_only" ||
    handoff.readbackEvidenceKind === "simulation"
  ) {
    return "仅仿真证据 · 未产生真实发布";
  }
  if (handoff.readbackOutcome === "publisher_confirmed") {
    return "创作者后台已发布 · 未做公开可见性验证";
  }
  if (handoff.readbackOutcome === "publisher_rejected") {
    return handoff.lastErrorCode === "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL"
      ? "平台审核未通过 · 广告软文"
      : "平台审核未通过";
  }
  if (handoff.readbackOutcome === "confirmed") return "平台回读已确认";
  if (handoff.readbackOutcome === "not_found") {
    return handoff.state === "readback_pending" ? "查询中 · 暂未公开" : "平台未找到 · 需复核";
  }
  if (handoff.readbackOutcome === "mismatch") return "内容哈希不匹配 · 已阻断";
  return "平台回读不可用 · 需复核";
}

function assistedReadbackSchedule(handoff: PublicationAssistedHandoff): string | null {
  const details: string[] = [];
  if (handoff.readbackAttemptCount !== undefined) {
    details.push(`已回读 ${handoff.readbackAttemptCount} 次`);
  }
  if (handoff.readbackDeadlineAt !== undefined && handoff.readbackDeadlineAt !== null) {
    details.push(`截止 ${formatDateTime(handoff.readbackDeadlineAt)}`);
  }
  return details.length === 0 ? null : details.join(" · ");
}

function assistedArticleStatus(handoff: PublicationAssistedHandoff): {
  readonly label: string;
  readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
} {
  if (assistedReadbackUncertain(handoff)) {
    return { label: "结果不明确", tone: "warning" };
  }
  if (assistedReadbackDeferred(handoff)) {
    return { label: "已提交，待平台审核", tone: "warning" };
  }
  if (
    (handoff.readbackOutcome === "publisher_confirmed" ||
      handoff.readbackOutcome === "confirmed") &&
    handoff.state === "confirmed"
  ) {
    return {
      label: handoff.readbackOutcome === "publisher_confirmed" ? "平台已发布" : "公开已确认",
      tone: "success",
    };
  }
  if (handoff.readbackOutcome === "publisher_rejected") {
    return {
      label:
        handoff.lastErrorCode === "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL"
          ? "平台审核未通过 · 广告软文"
          : "平台审核未通过",
      tone: "danger",
    };
  }
  if (handoff.readbackOutcome === "not_found") {
    return handoff.state === "readback_pending"
      ? { label: "查询中 · 暂未公开", tone: "warning" }
      : { label: "平台未找到", tone: "danger" };
  }
  if (handoff.readbackOutcome === "mismatch" || handoff.state === "needs_review") {
    if (handoff.submitOutcome === "not_accepted") {
      return { label: "平台未受理发布", tone: "danger" };
    }
    return { label: "需复核", tone: "danger" };
  }
  if (handoff.state === "readback_pending" || handoff.state === "submitted_unconfirmed") {
    return { label: "正在确认平台状态", tone: "warning" };
  }
  if (handoff.state === "failed" || handoff.submitOutcome === "rejected") {
    return { label: "发布失败", tone: "danger" };
  }
  if (handoff.state === "cancelled" || handoff.state === "expired") {
    return { label: stateLabel(handoff.state), tone: "neutral" };
  }
  return { label: "未提交", tone: "info" };
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
    return `运营 API 暂时不可用，请稍后重试（${error.code}${request}）`;
  }
  return apiErrorText(error);
}

function hasModuleNotEnabledError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as ApiResource<unknown>).error?.code === "MODULE_NOT_ENABLED"
  );
}

function LoginView({
  api,
  initialError,
  initialTenantSlug,
  knownTenants,
  onAuthenticated,
  onTenantsDiscovered,
}: {
  api: GeoApi;
  initialError: string | null;
  initialTenantSlug: string | undefined;
  knownTenants: readonly TenantOption[];
  onAuthenticated: (session: SessionSnapshot) => void;
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
          <strong>GEO Console</strong>
        </div>
        <div className="auth-heading">
          <h1 id="login-title">登录运营台</h1>
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
      </section>
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
  enabledModules,
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
  enabledModules: readonly string[];
  onToggleKillSwitch: () => void;
}) {
  const canUseAiContent = hasModuleAccess(mode, enabledModules, "ai_content");
  const canViewTrends = hasModuleAccess(mode, enabledModules, "trend_discovery");
  const canUsePriorityDistribution = hasModuleAccess(mode, enabledModules, "priority_distribution");
  const canUseAgentAutomation = hasModuleAccess(mode, enabledModules, "agent_automation");
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
      (account) =>
        account.capability === connectorCapabilityLabel("manual_only") &&
        account.execution.includes(executionLevelLabel("dry_run")),
    );

  return (
    <div className="view-stack">
      {canUsePriorityDistribution ? (
        <div className="capability-notice" role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <strong>
              {mode === "demo"
                ? "五家平台当前均为演练 / 人工操作"
                : allManualOnly
                  ? `${accounts.length} 个已配置平台账号均为演练 / 人工操作`
                  : "平台能力以实时账号记录为准"}
            </strong>
            <span>
              {mode === "demo"
                ? "演示数据未声明任何真实发布能力"
                : "无人值守仅使用登录态就绪的受管账号，并逐次校验审计、配额、熔断和公开回读"}
            </span>
          </div>
          <NavLink to="/settings" className="text-link">
            查看能力证据 <ChevronRight size={15} />
          </NavLink>
        </div>
      ) : null}

      {canUsePriorityDistribution && mode === "live" ? (
        <ResourceState
          resource={dashboard.channelAccounts}
          empty={accounts.length === 0}
          emptyLabel="尚未配置平台账号"
        />
      ) : null}

      <ContentPipeline
        mode={mode}
        campaigns={campaigns}
        content={content}
        publicationRows={publicationRows}
        sourceCount={dashboard.trendCandidates.data.length}
        enabledModules={enabledModules}
      />

      <section className="metric-band" aria-label="关键指标">
        {canUseAiContent ? (
          <div className="metric-cell">
            <span>推广计划</span>
            <strong>
              {mode === "live" && dashboard.campaigns.status !== "ready" ? "—" : campaigns.length}
            </strong>
            <small>{mode === "demo" ? "演示计划" : "GET /api/campaigns"}</small>
          </div>
        ) : null}
        {canUsePriorityDistribution ? (
          <div className="metric-cell">
            <span>已加载投放作业</span>
            <strong>
              {mode === "live" && dashboard.publicationJobs.status !== "ready"
                ? "—"
                : publicationRows.length}
            </strong>
            <small>{mode === "demo" ? "演示作业" : "最多由 API 返回 200 条"}</small>
          </div>
        ) : null}
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
        {canUsePriorityDistribution ? (
          <div className="metric-cell">
            <span>已确认回执</span>
            <strong>
              {mode === "live" && dashboard.receipts.status !== "ready" ? "—" : confirmedReceipts}
            </strong>
            <small>{mode === "demo" ? "演示回执" : "GET /api/receipts"}</small>
          </div>
        ) : null}
      </section>

      {canViewTrends ? (
        <HotspotRadar mode={mode} dashboard={dashboard} canUseAiContent={canUseAiContent} />
      ) : null}

      <div className="overview-grid">
        {canUsePriorityDistribution ? (
          <section className="panel queue-panel">
            <PanelHeading
              title="发布作业"
              meta={mode === "demo" ? "演示任务队列与回执" : "实时作业与回执关联"}
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
        ) : null}

        <section className="panel visibility-panel">
          <PanelHeading
            title="国内 AI 可见性"
            meta={mode === "demo" ? "演示重复样本" : "模型渠道聚合结果"}
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
            {mode === "demo" ? "固定样本演示" : "API 按渠道、模型、搜索、方法和证据分组"}
          </div>
        </section>

        {canUseAiContent ? (
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
        ) : null}

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
                    <strong>{auditRuleLabel(finding.rule)}</strong>
                    <p>{finding.message}</p>
                    <small>
                      {auditSeverityLabel(finding.severity)} · {finding.rule} · {finding.time}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {canUseAiContent ? (
        <section className="panel campaign-panel">
          <PanelHeading
            title="推广计划"
            meta={mode === "demo" ? "演示健康度" : "实时计划；API 未提供文章数和通过率"}
          />
          {mode === "live" ? (
            <ResourceState
              resource={dashboard.campaigns}
              empty={campaigns.length === 0}
              emptyLabel="暂无推广计划"
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
      ) : null}

      {canUseAgentAutomation ? (
        <>
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
                    : "演示：急停开关未触发"
                  : killSwitch === null
                    ? "急停开关状态不可用"
                    : killSwitch
                      ? "当前租户投放已暂停"
                      : "当前租户急停开关已关闭"}
              </span>
            </div>
            <button
              className={killSwitch === true ? "button-secondary" : "button-danger"}
              onClick={onToggleKillSwitch}
              disabled={killSwitchPending || (mode === "live" && !killSwitchWritable)}
              title={
                mode === "live" && !killSwitchWritable
                  ? "需要自动化管理权限且自动化接口可用"
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
              {killSwitchPending ? "等待回读" : killSwitch === true ? "恢复影子模式" : "立即停止"}
            </button>
          </div>
        </>
      ) : null}
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
  actorRole,
  capabilities,
  showAiContent,
  showPriorityDistribution,
  showAgentAutomation,
  api,
  onChanged,
  onSessionChanged,
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
  actorRole: string;
  capabilities: readonly string[];
  showAiContent: boolean;
  showPriorityDistribution: boolean;
  showAgentAutomation: boolean;
  api: GeoApi;
  onChanged: () => void;
  onSessionChanged: (session: SessionSnapshot) => void;
}) {
  return (
    <div className="view-stack">
      {mode === "live" ? (
        <div className="scope-notice">
          <LockKeyhole size={17} />
          <div>
            <strong>租户切换会重新签发隔离会话</strong>
            <span>
              GET /api/auth/tenants 返回 {discoveredTenants.length} 个成员租户；不可用租户不能切换
            </span>
          </div>
        </div>
      ) : null}
      <section className="panel">
        <PanelHeading
          title="租户目录"
          meta="租户标识是所有数据与工具调用的隔离边界"
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
      {showAiContent ? (
        <section className="panel">
          <PanelHeading title="品牌写作档案" meta="品牌级 AI 写作约定 · 不可变版本" />
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
      ) : null}
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
                      {brand.isPrimary ? "主品牌" : industryLabel(brand.industry)}
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
                      {memberRoleLabel(member.role)}
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
                      {operationStatusLabel(policy.status)}
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
                        {industryLabel(querySet.industry)} · v{querySet.currentVersion}
                      </span>
                    </div>
                    <StatusBadge tone={querySet.status === "active" ? "success" : "neutral"}>
                      {operationStatusLabel(querySet.status)}
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
            actorRole={actorRole}
            capabilities={capabilities}
            showPriorityDistribution={showPriorityDistribution}
            showAgentAutomation={showAgentAutomation}
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
              onSessionChanged(await api.getSession());
            }}
            onUpdateMemberModules={async (memberId, input) => {
              await api.updateMemberModules(memberId, input);
              onSessionChanged(await api.getSession());
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
          title="当前版本仅接入内容读取；创建需要完整发布载荷编辑器"
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

function AssistedSubmitApprovalDialog({
  handoff,
  pending,
  onClose,
  onConfirm,
}: {
  handoff: PublicationAssistedHandoff;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [approved, setApproved] = useState(false);
  const dialogRef = useModalDialog<HTMLDivElement>(pending ? null : onClose);
  const simulator = assistedEnvironmentLabel(handoff) === "仿真环境";
  const platform = platformLabel(handoff.platform);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={pending ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal ctrip-submit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-submit-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="assisted-submit-title">批准{platform}提交</h2>
            <p>
              {simulator
                ? `当前为仿真环境；只记录仿真提交观察，不会产生${platform}真实帖子。`
                : "提交可能改变外部平台状态；超时或结果不确定时禁止自动重试。"}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <div className="ctrip-submit-summary">
          <div>
            <span>交接单</span>
            <strong>{shortId(handoff.id)}</strong>
          </div>
          <div>
            <span>审计状态</span>
            <strong>已绑定 {shortId(handoff.auditHash)}</strong>
          </div>
          <div>
            <span>环境</span>
            <strong>{assistedEnvironmentLabel(handoff)}</strong>
          </div>
        </div>
        <label className="ctrip-submit-check">
          <input
            type="checkbox"
            checked={approved}
            disabled={pending}
            onChange={(event) => setApproved(event.target.checked)}
          />
          <span>确认已核对审计、草稿和发布账号</span>
        </label>
        <div className="modal-actions">
          <button className="button-secondary" onClick={onClose} disabled={pending}>
            返回
          </button>
          <button className="button-danger" onClick={onConfirm} disabled={pending || !approved}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            确认提交
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistedBulkSubmitApprovalDialog({
  handoffs,
  pending,
  onClose,
  onConfirm,
}: {
  handoffs: readonly PublicationAssistedHandoff[];
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [approved, setApproved] = useState(false);
  const dialogRef = useModalDialog<HTMLDivElement>(pending ? null : onClose);
  const accountCount = new Set(handoffs.map((handoff) => handoff.channelAccountId)).size;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={pending ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal ctrip-submit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assisted-bulk-submit-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="assisted-bulk-submit-title">批准多账号提交</h2>
            <p>每个账号独立提交并保留各自回执；不确定结果不会自动重试。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <div className="ctrip-submit-summary">
          <div>
            <span>投放账号</span>
            <strong>{accountCount} 个</strong>
          </div>
          <div>
            <span>交接单</span>
            <strong>{handoffs.length} 个</strong>
          </div>
          <div>
            <span>账号内并发</span>
            <strong>1</strong>
          </div>
        </div>
        <label className="ctrip-submit-check">
          <input
            type="checkbox"
            checked={approved}
            disabled={pending}
            onChange={(event) => setApproved(event.target.checked)}
          />
          <span>确认已核对全部账号、审计与草稿</span>
        </label>
        <div className="modal-actions">
          <button className="button-secondary" onClick={onClose} disabled={pending}>
            返回
          </button>
          <button className="button-danger" onClick={onConfirm} disabled={pending || !approved}>
            {pending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
            并行提交
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishingView({
  mode,
  api,
  tenantId,
  actorId,
  capabilities,
  accounts,
  rows,
  dashboard,
  killSwitch,
  killSwitchWritable,
  killSwitchPending,
  onToggleKillSwitch,
  onChanged,
}: {
  mode: ConsoleMode;
  api: GeoApi;
  tenantId: string;
  actorId: string | null;
  capabilities: readonly string[];
  accounts: AccountRow[];
  rows: PublicationRow[];
  dashboard: LiveDashboard;
  killSwitch: boolean | null;
  killSwitchWritable: boolean;
  killSwitchPending: boolean;
  onToggleKillSwitch: () => void;
  onChanged: () => void;
}) {
  const PUBLISHING_PREVIEW_LIMIT = 5;
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [cancelledJobs, setCancelledJobs] = useState<ReadonlySet<string>>(new Set());
  const [handoffBusyId, setHandoffBusyId] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [approveHandoffId, setApproveHandoffId] = useState<string | null>(null);
  const [cancelHandoffId, setCancelHandoffId] = useState<string | null>(null);
  const [cancelHandoffReason, setCancelHandoffReason] = useState("");
  const [selectedHandoffIds, setSelectedHandoffIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkHandoffAction, setBulkHandoffAction] = useState<"submit" | "readback" | null>(null);
  const [bulkSubmitOpen, setBulkSubmitOpen] = useState(false);
  const [jobListLimit, setJobListLimit] = useState(PUBLISHING_PREVIEW_LIMIT);
  const [handoffListLimit, setHandoffListLimit] = useState(PUBLISHING_PREVIEW_LIMIT);
  useEffect(() => {
    setSelectedJobId(null);
    setCancelledJobs(new Set());
    setHandoffBusyId(null);
    setHandoffError(null);
    setHandoffNotice(null);
    setApproveHandoffId(null);
    setCancelHandoffId(null);
    setCancelHandoffReason("");
    setSelectedHandoffIds(new Set());
    setBulkHandoffAction(null);
    setBulkSubmitOpen(false);
    setJobListLimit(PUBLISHING_PREVIEW_LIMIT);
    setHandoffListLimit(PUBLISHING_PREVIEW_LIMIT);
  }, [tenantId]);
  async function runHandoffAction(
    handoffId: string,
    action:
      "claim" | "heartbeat" | "prepare" | "submit" | "readback" | "reopen-readback" | "cancel",
  ) {
    setHandoffBusyId(handoffId);
    setHandoffError(null);
    setHandoffNotice(null);
    try {
      if (action === "claim") {
        await api.claimPublicationAssistedHandoff(handoffId);
      } else if (action === "heartbeat") {
        await api.heartbeatPublicationAssistedHandoff(handoffId);
      } else if (action === "prepare") {
        const result = await api.preparePublicationAssistedHandoff(handoffId);
        setHandoffNotice(
          result.bridge.evidenceKind === "simulation"
            ? `仿真环境已准备草稿证据；未访问真实${platformLabel(result.handoff.platform)}。`
            : "草稿准备证据已记录。",
        );
      } else if (action === "submit") {
        const result = await api.submitPublicationAssistedHandoff(handoffId);
        setApproveHandoffId(null);
        setHandoffNotice(
          result.bridge.outcome === "uncertain"
            ? "提交结果不确定，已停止自动重试；请执行独立回读。"
            : result.bridge.evidenceKind === "simulation"
              ? "仿真环境已记录提交观察；该结果不是平台发布确认。"
              : "提交已受理；系统将核对创作者后台的已发布状态，公开可见性不阻塞本次任务。",
        );
      } else if (action === "readback" || action === "reopen-readback") {
        const result =
          action === "reopen-readback"
            ? await api.reopenPublicationAssistedReadback(handoffId)
            : await api.readbackPublicationAssistedHandoff(handoffId);
        setHandoffNotice(
          result.bridge.outcome === "simulation_only"
            ? "回读仅包含仿真证据，交接单已进入人工复核。"
            : result.bridge.outcome === "publisher_rejected"
              ? result.bridge.publisherReasonCode === "publisher.rejected.soft_advertorial"
                ? "平台审核未通过：文章被判定为广告软文；系统将按补发预算生成全新替代稿。"
                : "平台审核未通过；已记录平台驳回结果。"
              : action === "reopen-readback"
                ? "已按人工复核重新打开回读窗口并执行公开回读。"
                : result.bridge.outcome === "publisher_confirmed"
                  ? "已确认创作者后台发布状态；公开可见性未验证。"
                  : "独立回读证据已记录。",
        );
      } else {
        await api.cancelPublicationAssistedHandoff(handoffId, cancelHandoffReason);
        setCancelHandoffId(null);
        setCancelHandoffReason("");
      }
      onChanged();
    } catch (error) {
      const stateMayHaveChanged =
        action === "submit" &&
        error instanceof GeoApiError &&
        error.details?.stateMayHaveChanged === true;
      if (stateMayHaveChanged) {
        setApproveHandoffId(null);
        setHandoffNotice(
          "提交响应异常且平台状态可能已改变；已停止重试。刷新后若进入等待回读再执行回读，否则转人工复核。",
        );
        onChanged();
      }
      setHandoffError(
        stateMayHaveChanged
          ? null
          : error instanceof GeoApiError
            ? `${error.code}: ${error.message}`
            : "平台交接操作失败",
      );
    } finally {
      setHandoffBusyId(null);
    }
  }
  const selectedHandoffs = dashboard.publicationAssistedHandoffs.data.filter((handoff) =>
    selectedHandoffIds.has(handoff.id),
  );
  const selectedAccountIds = new Set(selectedHandoffs.map((handoff) => handoff.channelAccountId));
  const selectedCanSubmit =
    selectedHandoffs.length > 0 &&
    selectedHandoffs.every((handoff) => handoff.state === "draft_prepared") &&
    capabilities.includes("publish:request");
  const selectedCanReadback =
    selectedHandoffs.length > 0 &&
    selectedHandoffs.every(
      (handoff) =>
        handoff.state === "readback_pending" ||
        (handoff.state === "awaiting_operator_submit" && handoff.submitPermitConsumedAt !== null),
    ) &&
    capabilities.includes("publish:request");
  const platformGroups = useMemo(() => {
    const groups = new Map<string, { label: string; accounts: AccountRow[] }>();
    for (const account of accounts) {
      const key = account.platformKey ?? account.platform;
      const group = groups.get(key) ?? { label: account.platform, accounts: [] };
      group.accounts.push(account);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, value]) => ({ key, ...value }));
  }, [accounts]);

  function toggleHandoffSelection(handoff: PublicationAssistedHandoff): void {
    setSelectedHandoffIds((current) => {
      const next = new Set(current);
      if (next.has(handoff.id)) {
        next.delete(handoff.id);
        return next;
      }
      const accountAlreadySelected = dashboard.publicationAssistedHandoffs.data.some(
        (candidate) =>
          current.has(candidate.id) && candidate.channelAccountId === handoff.channelAccountId,
      );
      if (!accountAlreadySelected) next.add(handoff.id);
      return next;
    });
  }

  async function runBulkHandoff(action: "submit" | "readback"): Promise<void> {
    const candidates = selectedHandoffs;
    if (candidates.length === 0) return;
    setBulkHandoffAction(action);
    setHandoffError(null);
    setHandoffNotice(null);
    try {
      const outcomes = await Promise.allSettled(
        candidates.map((handoff) =>
          action === "submit"
            ? api.submitPublicationAssistedHandoff(handoff.id)
            : api.readbackPublicationAssistedHandoff(handoff.id),
        ),
      );
      const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
      const failed = outcomes.length - succeeded;
      setHandoffNotice(
        `${action === "submit" ? "多账号提交" : "多账号回读"}已完成 ${succeeded} / ${outcomes.length}`,
      );
      if (failed > 0) {
        setHandoffError(`${failed} 个账号操作未确认，已保留独立状态且不会自动重试。`);
      }
      setSelectedHandoffIds(new Set());
      setBulkSubmitOpen(false);
      onChanged();
    } finally {
      setBulkHandoffAction(null);
    }
  }
  const approvalHandoff =
    approveHandoffId === null
      ? null
      : (dashboard.publicationAssistedHandoffs.data.find(
          (handoff) => handoff.id === approveHandoffId,
        ) ?? null);
  const visibleRows =
    jobListLimit >= rows.length
      ? rows
      : selectedJobId !== null && rows.findIndex((row) => row.id === selectedJobId) >= jobListLimit
        ? [
            ...rows.slice(0, jobListLimit),
            rows[rows.findIndex((row) => row.id === selectedJobId)] as PublicationRow,
          ]
        : rows.slice(0, jobListLimit);
  const hiddenJobCount = rows.length - visibleRows.length;
  const jobExpandStep = Math.min(4, hiddenJobCount);
  const handoffs = dashboard.publicationAssistedHandoffs.data;
  const selectedBeyondHandoffs =
    handoffListLimit >= handoffs.length
      ? []
      : handoffs.filter(
          (handoff, index) => index >= handoffListLimit && selectedHandoffIds.has(handoff.id),
        );
  const visibleHandoffs =
    handoffListLimit >= handoffs.length
      ? handoffs
      : [...handoffs.slice(0, handoffListLimit), ...selectedBeyondHandoffs];
  const hiddenHandoffCount = handoffs.length - visibleHandoffs.length;
  const handoffExpandStep = Math.min(4, hiddenHandoffCount);
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
      <div className="platform-health-band" aria-label="平台与子账号状态">
        {platformGroups.map((group) => (
          <section className="platform-account-group" key={group.key}>
            <header>
              <span className="platform-initial">{group.label.slice(0, 1)}</span>
              <div>
                <strong>{group.label}</strong>
                <small>{group.accounts.length} 个子账号</small>
              </div>
              <StatusBadge
                tone={
                  group.accounts.every((account) => ["正常", "active"].includes(account.health))
                    ? "success"
                    : "warning"
                }
              >
                {group.accounts.filter((account) => account.health === "active").length}/
                {group.accounts.length} 可用
              </StatusBadge>
            </header>
            <div className="platform-account-list">
              {group.accounts.map((account) => (
                <div className="platform-account-row" key={account.id}>
                  <div>
                    <strong>{account.account}</strong>
                    <small>
                      {connectorCapabilityLabel(account.capability)} ·{" "}
                      {executionLevelLabel(account.execution)}
                    </small>
                  </div>
                  <StatusBadge
                    tone={
                      account.health === "正常" || account.health === "active"
                        ? "success"
                        : "warning"
                    }
                  >
                    {stateLabel(account.health)}
                  </StatusBadge>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {mode === "live" ? (
        <section className="panel">
          <PanelHeading title="携程连接状态" meta={dashboard.ctripBridge.endpoint} />
          {dashboard.ctripBridge.error !== null ? (
            <div className="ops-notice ops-notice-warning" role="status">
              <WifiOff size={16} />
              <span>{resourceErrorText(dashboard.ctripBridge.error)}</span>
            </div>
          ) : dashboard.ctripBridge.data === null ? (
            <ResourceState
              resource={dashboard.ctripBridge}
              empty={true}
              emptyLabel="正在读取连接状态"
            />
          ) : (
            <div className="ops-notice ops-notice-info" role="status">
              {dashboard.ctripBridge.data.reachable ? (
                <CheckCircle2 size={16} />
              ) : (
                <WifiOff size={16} />
              )}
              <span>
                {!dashboard.ctripBridge.data.configured
                  ? "携程 Bridge 未配置"
                  : !dashboard.ctripBridge.data.reachable
                    ? "携程 Bridge 不可达，请检查宿主监督器"
                    : ctripOperationalMessage(dashboard.ctripBridge.data.operationalStatus)}
              </span>
            </div>
          )}
          <SourceCaption endpoint="GET /api/ctrip-bridge/status" />
        </section>
      ) : null}
      <section className="panel">
        <PanelHeading
          title="投放队列"
          meta={mode === "demo" ? "演示发布许可、任务队列与回执" : "实时投放作业与回执"}
          action={
            <button
              className={killSwitch === true ? "button-secondary" : "button-danger"}
              onClick={onToggleKillSwitch}
              disabled={killSwitchPending || (mode === "live" && !killSwitchWritable)}
              title={
                mode === "live" && !killSwitchWritable
                  ? "需要自动化管理权限且自动化接口可用"
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
          <>
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
                  {visibleRows.map((row) => (
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
            {(hiddenJobCount > 0 || jobListLimit > PUBLISHING_PREVIEW_LIMIT) && (
              <div className="ops-index-expand-row">
                {hiddenJobCount > 0 && (
                  <button
                    type="button"
                    className="ops-index-expand"
                    onClick={() =>
                      setJobListLimit((current) => Math.min(rows.length, current + jobExpandStep))
                    }
                  >
                    <ChevronDown size={14} />
                    <span>
                      {hiddenJobCount <= 4
                        ? `展开全部 ${rows.length} 个投放作业`
                        : `展开更多 ${jobExpandStep} 个 · 剩余 ${hiddenJobCount} 个`}
                    </span>
                  </button>
                )}
                {jobListLimit > PUBLISHING_PREVIEW_LIMIT && (
                  <button
                    type="button"
                    className="ops-index-expand"
                    onClick={() => setJobListLimit(PUBLISHING_PREVIEW_LIMIT)}
                  >
                    <ChevronUp size={14} />
                    <span>收起作业列表</span>
                  </button>
                )}
              </div>
            )}
          </>
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
      {mode === "live" ? (
        <section className="panel">
          <PanelHeading title="多平台人工交接" meta="实时人工协作交接单" />
          <ResourceState
            resource={dashboard.publicationAssistedHandoffs}
            empty={dashboard.publicationAssistedHandoffs.data.length === 0}
            emptyLabel="暂无平台交接单"
          />
          {dashboard.publicationAssistedHandoffs.data.some(
            (handoff) => assistedEnvironmentLabel(handoff) === "仿真环境",
          ) ? (
            <div className="ops-notice ops-notice-warning ctrip-environment-notice" role="status">
              <ShieldAlert size={16} />
              <span>当前包含仿真交接单；对应提交与回读证据不得视为平台真实发布。</span>
            </div>
          ) : null}
          {handoffNotice === null ? null : (
            <div className="ops-notice ops-notice-info" role="status">
              <CheckCircle2 size={16} />
              <span>{handoffNotice}</span>
            </div>
          )}
          {handoffError === null ? null : (
            <div className="ops-inline-error" role="alert">
              <AlertTriangle size={16} />
              <span>{handoffError}</span>
            </div>
          )}
          {dashboard.publicationAssistedHandoffs.data.length === 0 ? null : (
            <>
              <div className="handoff-bulk-toolbar" aria-label="多账号投放操作">
                <div>
                  <strong>{selectedHandoffs.length} 个交接单</strong>
                  <span>{selectedAccountIds.size} 个账号 · 同账号并发 1</span>
                </div>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={selectedHandoffs.length === 0 || bulkHandoffAction !== null}
                  onClick={() => setSelectedHandoffIds(new Set())}
                >
                  清除选择
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={!selectedCanReadback || bulkHandoffAction !== null}
                  onClick={() => void runBulkHandoff("readback")}
                >
                  {bulkHandoffAction === "readback" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Search size={16} />
                  )}
                  批量回读
                </button>
                <button
                  className="button-danger"
                  type="button"
                  disabled={!selectedCanSubmit || bulkHandoffAction !== null}
                  onClick={() => setBulkSubmitOpen(true)}
                >
                  <Send size={16} /> 多账号提交
                </button>
              </div>
              <div className="table-scroll">
                <table className="publishing-table">
                  <thead>
                    <tr>
                      <th aria-label="选择" />
                      <th>文章 / 平台状态</th>
                      <th>投放账号</th>
                      <th>交接单 / 作业</th>
                      <th>状态</th>
                      <th>环境 / 适配器</th>
                      <th>提交观察</th>
                      <th>回读证据</th>
                      <th>租约</th>
                      <th>截止时间</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHandoffs.map((handoff) => {
                      const articleStatus = assistedArticleStatus(handoff);
                      const handoffPlatform = platformLabel(handoff.platform);
                      const leaseExpiry =
                        handoff.leaseExpiresAt === null
                          ? Number.NaN
                          : Date.parse(handoff.leaseExpiresAt);
                      const leaseActive = Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
                      const owned =
                        leaseActive && actorId !== null && handoff.leaseOwnerActorId === actorId;
                      const submitBoundaryCrossed = handoff.submitPermitConsumedAt !== null;
                      const terminal =
                        submitBoundaryCrossed ||
                        [
                          "submitted_unconfirmed",
                          "readback_pending",
                          "confirmed",
                          "needs_review",
                          "cancelled",
                          "expired",
                          "failed",
                        ].includes(handoff.state);
                      const leaseStatus = terminal
                        ? "无需租约"
                        : owned
                          ? "当前操作员"
                          : handoff.leaseOwnerActorId === null
                            ? "待认领"
                            : !leaseActive
                              ? "租约已过期"
                              : "其他操作员";
                      const canPrepare =
                        owned &&
                        ["handoff_pending", "session_required", "challenge_required"].includes(
                          handoff.state,
                        );
                      const canSubmit =
                        handoff.state === "draft_prepared" &&
                        capabilities.includes("publish:request");
                      const canReadback =
                        (handoff.state === "readback_pending" ||
                          (handoff.state === "awaiting_operator_submit" &&
                            submitBoundaryCrossed)) &&
                        capabilities.includes("publish:request");
                      const canReopenReadback =
                        handoff.state === "needs_review" &&
                        handoff.readbackOutcome !== "confirmed" &&
                        handoff.externalId === null &&
                        handoff.externalUrl === null &&
                        capabilities.includes("publish:request");
                      const selected = selectedHandoffIds.has(handoff.id);
                      const selectable = canSubmit || canReadback || canReopenReadback;
                      const accountConflict =
                        !selected && selectedAccountIds.has(handoff.channelAccountId);
                      const account = accounts.find(
                        (candidate) => candidate.id === handoff.channelAccountId,
                      );
                      return (
                        <tr key={handoff.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择交接单 ${handoff.id}`}
                              checked={selected}
                              disabled={
                                !selectable || accountConflict || bulkHandoffAction !== null
                              }
                              title={
                                accountConflict ? "同一波次每个账号只能选择一个交接单" : undefined
                              }
                              onChange={() => toggleHandoffSelection(handoff)}
                            />
                          </td>
                          <td>
                            <div className="handoff-article-cell">
                              <strong title={handoff.articleTitle}>{handoff.articleTitle}</strong>
                              <div className="handoff-article-meta">
                                <StatusBadge tone="info">{handoffPlatform}</StatusBadge>
                                <StatusBadge tone={articleStatus.tone}>
                                  {articleStatus.label}
                                </StatusBadge>
                                {handoff.externalUrl === null ? null : (
                                  <a
                                    className="handoff-article-link"
                                    href={handoff.externalUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    <ExternalLink size={12} />
                                    <span>
                                      {handoff.readbackOutcome === "publisher_confirmed"
                                        ? "平台原始 URL · 未验证公开可见性"
                                        : "原始 URL"}
                                    </span>
                                    <span className="handoff-article-url">
                                      {handoff.externalUrl}
                                    </span>
                                  </a>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="primary-cell">
                              <strong>
                                {account?.account ?? shortId(handoff.channelAccountId)}
                              </strong>
                              <span>{shortId(handoff.channelAccountId)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="primary-cell">
                              <strong>{shortId(handoff.id)}</strong>
                              <span>{shortId(handoff.jobId)}</span>
                            </div>
                          </td>
                          <td>
                            <StatusBadge
                              tone={
                                handoff.state === "cancelled" || handoff.state === "failed"
                                  ? "danger"
                                  : handoff.state === "draft_prepared"
                                    ? "success"
                                    : "warning"
                              }
                            >
                              {assistedHandoffStateLabel(handoff)}
                            </StatusBadge>
                          </td>
                          <td>
                            <div className="handoff-environment">
                              <StatusBadge
                                tone={
                                  assistedEnvironmentLabel(handoff) === "仿真环境"
                                    ? "warning"
                                    : "info"
                                }
                              >
                                {assistedEnvironmentLabel(handoff)}
                              </StatusBadge>
                              <span className="mono">{handoff.adapterVersion}</span>
                              {handoff.prepareEvidenceHash === null ? null : (
                                <span className="mono">
                                  {handoff.prepareOutcome} · {handoff.prepareEvidenceKind} ·{" "}
                                  {shortId(handoff.prepareEvidenceHash)}
                                </span>
                              )}
                              {handoff.lastErrorCode === null &&
                              handoff.lastErrorMessage === null ? null : (
                                <span
                                  className={
                                    assistedReadbackDeferred(handoff)
                                      ? "handoff-info"
                                      : "handoff-error"
                                  }
                                  role={assistedReadbackDeferred(handoff) ? "status" : "alert"}
                                >
                                  {handoff.lastErrorCode === null
                                    ? null
                                    : `${handoff.lastErrorCode}: `}
                                  {handoff.lastErrorMessage ?? "未提供错误详情"}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="handoff-observation">
                              <span>{assistedSubmitObservation(handoff)}</span>
                              {handoff.submitCandidateExternalId ===
                              null ? null : handoff.submitCandidateExternalUrl === null ? (
                                <span className="mono">
                                  候选目标 · 尚未确认 · {handoff.submitCandidateExternalId}
                                </span>
                              ) : (
                                <a
                                  className="handoff-article-link"
                                  href={handoff.submitCandidateExternalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <ExternalLink size={12} />
                                  <span>候选 URL · 未确认</span>
                                </a>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="handoff-observation">
                              <span>{assistedReadbackObservation(handoff)}</span>
                              {assistedReadbackSchedule(handoff) === null ? null : (
                                <span className="handoff-readback-schedule">
                                  {assistedReadbackSchedule(handoff)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>{leaseStatus}</td>
                          <td>{formatDateTime(handoff.expiresAt)}</td>
                          <td>
                            <div className="handoff-actions">
                              {canPrepare ? (
                                <button
                                  className="button-secondary handoff-command"
                                  aria-label={`准备${handoffPlatform}草稿 ${handoff.id}`}
                                  disabled={handoffBusyId !== null}
                                  onClick={() => void runHandoffAction(handoff.id, "prepare")}
                                >
                                  {handoffBusyId === handoff.id ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <FileCheck2 size={16} />
                                  )}
                                  准备草稿
                                </button>
                              ) : null}
                              {canSubmit ? (
                                <button
                                  className="button-danger handoff-command"
                                  aria-label={`批准提交 ${handoff.id}`}
                                  disabled={handoffBusyId !== null}
                                  onClick={() => setApproveHandoffId(handoff.id)}
                                >
                                  <Send size={16} />
                                  批准提交
                                </button>
                              ) : null}
                              {canReadback ? (
                                <button
                                  className="button-secondary handoff-command"
                                  aria-label={`执行${handoffPlatform}回读 ${handoff.id}`}
                                  disabled={handoffBusyId !== null}
                                  onClick={() => void runHandoffAction(handoff.id, "readback")}
                                >
                                  {handoffBusyId === handoff.id ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <Search size={16} />
                                  )}
                                  人工查询
                                </button>
                              ) : null}
                              {canReopenReadback ? (
                                <button
                                  className="button-secondary handoff-command"
                                  aria-label={`人工确认并重新回读 ${handoff.id}`}
                                  disabled={handoffBusyId !== null}
                                  onClick={() =>
                                    void runHandoffAction(handoff.id, "reopen-readback")
                                  }
                                >
                                  {handoffBusyId === handoff.id ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <RefreshCw size={16} />
                                  )}
                                  重新回读
                                </button>
                              ) : null}
                              {owned ? (
                                <button
                                  className="icon-button"
                                  title="续期交接租约"
                                  aria-label={`续期交接单 ${handoff.id}`}
                                  disabled={handoffBusyId !== null || terminal}
                                  onClick={() => void runHandoffAction(handoff.id, "heartbeat")}
                                >
                                  {handoffBusyId === handoff.id ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <RefreshCw size={16} />
                                  )}
                                </button>
                              ) : (
                                <button
                                  className="icon-button"
                                  title="认领交接单"
                                  aria-label={`认领交接单 ${handoff.id}`}
                                  disabled={
                                    handoffBusyId !== null ||
                                    terminal ||
                                    !capabilities.includes("publish:request")
                                  }
                                  onClick={() => void runHandoffAction(handoff.id, "claim")}
                                >
                                  {handoffBusyId === handoff.id ? (
                                    <LoaderCircle className="spin" size={16} />
                                  ) : (
                                    <CheckCircle2 size={16} />
                                  )}
                                </button>
                              )}
                              <button
                                className="icon-button"
                                title="取消交接单"
                                aria-label={`取消交接单 ${handoff.id}`}
                                disabled={
                                  handoffBusyId !== null ||
                                  terminal ||
                                  !capabilities.includes("publish:cancel")
                                }
                                onClick={() => {
                                  setCancelHandoffId(handoff.id);
                                  setCancelHandoffReason("");
                                }}
                              >
                                <X size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(hiddenHandoffCount > 0 || handoffListLimit > PUBLISHING_PREVIEW_LIMIT) && (
                <div className="ops-index-expand-row">
                  {hiddenHandoffCount > 0 && (
                    <button
                      type="button"
                      className="ops-index-expand"
                      onClick={() =>
                        setHandoffListLimit((current) =>
                          Math.min(handoffs.length, current + handoffExpandStep),
                        )
                      }
                    >
                      <ChevronDown size={14} />
                      <span>
                        {hiddenHandoffCount <= 4
                          ? `展开全部 ${handoffs.length} 个交接单`
                          : `展开更多 ${handoffExpandStep} 个 · 剩余 ${hiddenHandoffCount} 个`}
                      </span>
                    </button>
                  )}
                  {handoffListLimit > PUBLISHING_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      className="ops-index-expand"
                      onClick={() => setHandoffListLimit(PUBLISHING_PREVIEW_LIMIT)}
                    >
                      <ChevronUp size={14} />
                      <span>收起交接单列表</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {cancelHandoffId === null ? null : (
            <form
              className="handoff-cancel-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (cancelHandoffReason.trim().length >= 5) {
                  void runHandoffAction(cancelHandoffId, "cancel");
                }
              }}
            >
              <label>
                取消原因
                <input
                  value={cancelHandoffReason}
                  minLength={5}
                  maxLength={1000}
                  required
                  autoFocus
                  onChange={(event) => setCancelHandoffReason(event.target.value)}
                />
              </label>
              <div className="ops-form-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    setCancelHandoffId(null);
                    setCancelHandoffReason("");
                  }}
                >
                  返回
                </button>
                <button
                  type="submit"
                  className="button-danger"
                  disabled={handoffBusyId !== null || cancelHandoffReason.trim().length < 5}
                >
                  {handoffBusyId === cancelHandoffId ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <X size={16} />
                  )}
                  确认取消
                </button>
              </div>
            </form>
          )}
          {approvalHandoff === null ? null : (
            <AssistedSubmitApprovalDialog
              handoff={approvalHandoff}
              pending={handoffBusyId === approvalHandoff.id}
              onClose={() => setApproveHandoffId(null)}
              onConfirm={() => void runHandoffAction(approvalHandoff.id, "submit")}
            />
          )}
          {!bulkSubmitOpen || selectedHandoffs.length === 0 ? null : (
            <AssistedBulkSubmitApprovalDialog
              handoffs={selectedHandoffs}
              pending={bulkHandoffAction === "submit"}
              onClose={() => setBulkSubmitOpen(false)}
              onConfirm={() => void runBulkHandoff("submit")}
            />
          )}
          <SourceCaption
            endpoint="GET /api/publication-assisted-handoffs"
            loadedAt={dashboard.loadedAt}
          />
        </section>
      ) : null}
      <section className="policy-strip">
        <div>
          <LockKeyhole size={18} />
          <span>一次性发布许可</span>
          <strong>API 强制</strong>
        </div>
        <div>
          <RefreshCw size={18} />
          <span>不确定结果自动核对</span>
          <strong>执行器契约</strong>
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
        <section className="panel automation-demo-shell">
          <PanelHeading
            title="批次与运行"
            meta="自动化批次、平台目标与公开回读"
            action={<StatusBadge tone="neutral">未连接实时会话</StatusBadge>}
          />
          <div className="automation-demo-empty" role="status">
            <span className="automation-demo-icon" aria-hidden="true">
              <CalendarClock size={24} />
            </span>
            <strong>没有可读取的自动化运行</strong>
            <p>离线演示不会创建批次，也不会生成无人值守执行结果。</p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="view-stack">
      <ResourceState
        resource={dashboard.campaigns}
        empty={dashboard.campaigns.data.length === 0}
        emptyLabel="当前租户没有推广计划"
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
        templates={dashboard.articleTemplates.data?.items ?? []}
        automation={dashboard.automation.data}
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
          {mode === "demo" ? "演示证据：固定样本" : "实时指标：默认排除固定样本"}
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
          <strong>{mode === "demo" ? "固定样本" : visible.length}</strong>
          <small>逐行保留来源边界</small>
        </div>
      </section>
      {mode === "demo" ? (
        <section className="panel">
          <PanelHeading
            title="查询样本"
            meta="同一查询词按搜索渠道重复采样，不与 Google 排名合并"
          />
          <div className="table-scroll">
            <table className="visibility-query-table">
              <thead>
                <tr>
                  <th>查询词</th>
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
            meta="每行保留提供方、渠道、模型、搜索模式、观测方法和证据，不与 Google 排名合并"
          />
          <div className="table-scroll">
            <table className="visibility-summary-table">
              <thead>
                <tr>
                  <th>提供方 / 渠道</th>
                  <th>模型 / 搜索</th>
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
                        <span>搜索：{searchModeLabel(item.searchMode)}</span>
                      </div>
                    </td>
                    <td>
                      <div className="primary-cell">
                        <strong>{observationMethodLabel(item.observationMethod)}</strong>
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
      <div className="view-stack">
        <section className="panel">
          <PanelHeading title="审计运行" meta="不可变审计产物、载荷哈希与规则发现" />
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
      </div>
    );
  }
  return (
    <div className="view-stack">
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
                    {auditSeverityLabel(finding.severity)} · {auditRuleLabel(finding.rule)} ·{" "}
                    {finding.time}
                  </span>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="panel audit-detail">
          <PanelHeading
            title={auditRuleLabel("contact.phone.unapproved")}
            meta={`contact.phone.unapproved · 演示规则 · ${industryLabel(demoTenant?.industry ?? "general")}`}
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
              <dt>载荷哈希</dt>
              <dd className="mono hash-value">a4d9…18cf</dd>
            </div>
            <div>
              <dt>策略哈希</dt>
              <dd className="mono hash-value">73be…9a21</dd>
            </div>
            <div>
              <dt>发布许可</dt>
              <dd>未签发</dd>
            </div>
          </dl>
          <div className="code-evidence">
            <span>正文载荷 · bodyMarkdown</span>
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
    </div>
  );
}

function SettingsView({
  mode,
  api,
  channelAccounts,
  accounts,
  campaigns,
  resource,
  automation,
  canManageAutomation,
  canManageTenant,
  showPriorityDistribution,
  showAgentAutomation,
  onSaveAutomationControl,
  onSaveScopedAutomationControl,
  onSetCircuitBreaker,
}: {
  mode: ConsoleMode;
  api: GeoApi;
  channelAccounts: readonly ChannelAccount[];
  accounts: AccountRow[];
  campaigns: CampaignRow[];
  resource: ApiResource<unknown>;
  automation: ApiResource<AutomationSnapshot | null>;
  canManageAutomation: boolean;
  canManageTenant: boolean;
  showPriorityDistribution: boolean;
  showAgentAutomation: boolean;
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
  const showOperationalReadiness = showPriorityDistribution || showAgentAutomation;
  const [setupTarget, setSetupTarget] = useState<"demo" | "real">(
    mode === "live" ? "real" : "demo",
  );
  const [setup, setSetup] = useState<ApiResource<CustomerSetupReadiness | null>>({
    endpoint: "GET /api/setup/readiness",
    data: null,
    error: null,
    status: mode === "demo" ? "ready" : "loading",
  });
  const [scopedControlIntent, setScopedControlIntent] = useState<
    ScopedAutomationControl | "new" | null
  >(null);
  const [circuitIntent, setCircuitIntent] = useState<{
    readonly scopeType: AutomationScopeType;
    readonly scopeKey: string;
    readonly targetState: "open" | "closed";
  } | null>(null);

  async function refreshSetup(): Promise<void> {
    if (mode !== "live" || !showOperationalReadiness) return;
    setSetup((current) => ({ ...current, error: null, status: "loading" }));
    try {
      const readiness = await api.getSetupReadiness();
      setSetup({
        endpoint: "GET /api/setup/readiness",
        data: readiness,
        error: null,
        status: "ready",
      });
    } catch (error) {
      setSetup({
        endpoint: "GET /api/setup/readiness",
        data: null,
        error:
          error instanceof GeoApiError
            ? {
                code: error.code,
                message: error.message,
                requestId: error.requestId,
                status: error.status,
              }
            : {
                code: "NETWORK_ERROR",
                message: error instanceof Error ? error.message : "无法读取首次使用状态",
                requestId: null,
                status: 0,
              },
        status: "error",
      });
    }
  }

  useEffect(() => {
    void refreshSetup();
  }, [api, mode, showOperationalReadiness]);

  const readiness = setup.data;
  const checks =
    setupTarget === "demo"
      ? [
          {
            label: "文章生成",
            detail: "Pi Agent 与租户事实已连接",
            ready: readiness?.checks.agent === true && readiness.checks.ctripAccount,
          },
          {
            label: "发布前审计",
            detail: "每个最终平台版本先经过确定性审计",
            ready: readiness?.checks.prePublicationAudit === true,
          },
          {
            label: "携程流程演示",
            detail: "只生成模拟证据，不连接携程外部页面",
            ready: readiness?.ctripSimulationReady === true,
          },
          {
            label: "外部发布",
            detail: "多平台无人值守、审计与公开回读均已就绪",
            ready: readiness?.externalPublishingEnabled === true,
            locked: false,
          },
        ]
      : [
          {
            label: "正式治理服务",
            detail: "生产环境使用独立 Plastic Promise",
            ready: readiness?.governanceMode === "external",
          },
          {
            label: "账号授权证据",
            detail: "账号能力与最近状态记录",
            ready: readiness?.checks.assistedEvidence === true,
          },
          {
            label: "携程桥接服务",
            detail: "租户身份和运行连接均已验证",
            ready:
              readiness?.checks.bridgeIdentity === true && readiness.checks.bridgeRuntime === true,
          },
          {
            label: "外部发布",
            detail: "多平台无人值守写入仅在账号、平台连接、审计和回读证据全部通过时开放",
            ready: readiness?.externalPublishingEnabled === true,
            locked: false,
          },
        ];

  return (
    <div className="view-stack">
      {showOperationalReadiness ? (
        <>
          <section className="panel customer-setup-panel">
            <div className="customer-setup-header">
              <div>
                <span className="setup-kicker">首次使用</span>
                <h2>{setupTarget === "demo" ? "客户演示环境" : "真实账号预检"}</h2>
                <p>
                  {setupTarget === "demo"
                    ? "本地生成、审计和携程模拟已打包为同一套启动流程。"
                    : "正式账号只做就绪核验，不会自动打开外部发布权限。"}
                </p>
              </div>
              <div className="segmented-control" aria-label="配置目标">
                <button
                  type="button"
                  className={setupTarget === "demo" ? "active" : ""}
                  onClick={() => setSetupTarget("demo")}
                >
                  本地演示
                </button>
                <button
                  type="button"
                  className={setupTarget === "real" ? "active" : ""}
                  onClick={() => setSetupTarget("real")}
                >
                  真实账号
                </button>
              </div>
            </div>
            {mode === "demo" ? (
              <UnsupportedState
                title="当前是离线界面演示"
                detail="登录客户版后可读取真实就绪状态"
              />
            ) : (
              <ResourceState resource={setup} empty={false} emptyLabel="" />
            )}
            {setup.status === "ready" && mode === "live" ? (
              <>
                <div className="customer-setup-checks">
                  {checks.map((check) => (
                    <div className="customer-setup-check" key={check.label}>
                      <span
                        className={`setup-check-icon ${check.ready ? "ready" : check.locked ? "locked" : "pending"}`}
                      >
                        {check.ready ? (
                          <CheckCircle2 size={18} aria-hidden="true" />
                        ) : check.locked ? (
                          <LockKeyhole size={18} aria-hidden="true" />
                        ) : (
                          <Clock3 size={18} aria-hidden="true" />
                        )}
                      </span>
                      <div>
                        <strong>{check.label}</strong>
                        <span>{check.detail}</span>
                      </div>
                      <StatusBadge
                        tone={check.ready ? "success" : check.locked ? "neutral" : "warning"}
                      >
                        {check.ready ? "已就绪" : check.locked ? "已锁定" : "待配置"}
                      </StatusBadge>
                    </div>
                  ))}
                </div>
                <div className="customer-setup-actions">
                  <span>
                    {readiness?.externalPublishingEnabled === true
                      ? "携程无人值守发布 · 以实时账号和公开回读证据为准"
                      : "外部发布尚未满足全部准入条件"}
                  </span>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void refreshSetup()}
                  >
                    <RefreshCw size={16} /> 重新检测
                  </button>
                  {readiness?.articleGenerationReady === true ? (
                    <NavLink className="button-primary" to="/content">
                      <Sparkles size={16} /> 开始生成文章
                    </NavLink>
                  ) : (
                    <button className="button-primary" type="button" disabled>
                      <LockKeyhole size={16} />
                      等待配置完成
                    </button>
                  )}
                </div>
                <SourceCaption endpoint="GET /api/setup/readiness" />
              </>
            ) : null}
          </section>
          <section className="panel policy-settings">
            <PanelHeading title="第一版能力边界" meta="以当前代码与运行证据为准" />
            {[
              ["多租户客户治理", "已接入", "租户、品牌、成员、联系方式与资源范围"],
              ["GEO 模板与规范草稿", "已接入", "21 套 V1 模板、事实引用、平台变体与确定性审计"],
              ["自动化批次", "已接入", "后台生产器支持多平台并行编排与账号轮换"],
              [
                "多平台无人值守发布",
                readiness?.externalPublishingEnabled === true ? "已接入" : "待准入",
                "浏览器无人值守 + 一次性提交许可 + 公开页面独立回读；按账号运行态动态准入",
              ],
              ["豆包 / 千问在线评测", "未接入", "仅固定样本或人工导入证据，不代表在线搜索结果"],
              ["生产级图片生成", "未接入", "确定性固定样本只验证管线，不作为生产图片"],
              ["品牌记忆正负反馈闭环", "未接入", "第一版不根据投放结果自动改写长期品牌记忆"],
            ].map(([name, status, detail]) => (
              <div className="setting-control" key={name}>
                <div>
                  <strong>{name}</strong>
                  <span>{detail}</span>
                </div>
                <StatusBadge tone={status === "已接入" ? "success" : "info"}>{status}</StatusBadge>
              </div>
            ))}
          </section>
        </>
      ) : null}
      <RuntimeProviderConfigPanel api={api} canManage={canManageTenant} />
      {showPriorityDistribution ? (
        <section className="panel">
          <PanelHeading title="平台账号与能力" meta="能力升级必须绑定发布和核对证据" />
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
                  <small>连接能力</small>
                  <strong>{connectorCapabilityLabel(account.capability)}</strong>
                </div>
                <div>
                  <small>执行级别</small>
                  <StatusBadge tone="info">{executionLevelLabel(account.execution)}</StatusBadge>
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
      ) : null}
      {showAgentAutomation ? (
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
                      <strong>租户急停开关</strong>
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
                      <span>平台、账号、推广计划或主题；后台任务会叠加所有匹配范围</span>
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
                                {automationScopeLabel(control.scopeType)} ·{" "}
                                {automationScopeKeyLabel(
                                  control.scopeType,
                                  control.scopeKey,
                                  channelAccounts,
                                  campaigns,
                                )}
                              </strong>
                              <span>{control.reason ?? "未记录原因"}</span>
                            </div>
                            <StatusBadge tone={control.killSwitchEnabled ? "danger" : "info"}>
                              {control.killSwitchEnabled
                                ? "已急停"
                                : operationStatusLabel(control.mode)}
                            </StatusBadge>
                            <small>{JSON.stringify(control.quota)}</small>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`编辑范围控制 ${automationScopeLabel(control.scopeType)} ${automationScopeKeyLabel(control.scopeType, control.scopeKey, channelAccounts, campaigns)}`}
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
                        setCircuitIntent({
                          scopeType: "tenant",
                          scopeKey: "*",
                          targetState: "open",
                        })
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
                              {automationScopeLabel(circuit.scopeType)} ·{" "}
                              {automationScopeKeyLabel(
                                circuit.scopeType,
                                circuit.scopeKey,
                                channelAccounts,
                                campaigns,
                              )}
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
                            {operationStatusLabel(circuit.state)}
                          </StatusBadge>
                          <small>
                            {circuit.failureCount} 次 · {formatDateTime(circuit.updatedAt)}
                          </small>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`${circuit.state === "closed" ? "打开" : "关闭"}熔断 ${automationScopeLabel(circuit.scopeType)} ${automationScopeKeyLabel(circuit.scopeType, circuit.scopeKey, channelAccounts, campaigns)}`}
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
                  <span>新推广计划从影子模式开始</span>
                </div>
                <select defaultValue="shadow">
                  <option value="shadow">影子模式</option>
                  <option value="supervised">监督投放</option>
                  <option value="unattended" disabled>
                    无人值守（无 API 证据）
                  </option>
                </select>
              </div>
              <div className="setting-control">
                <div>
                  <strong>每日演练配额</strong>
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
      ) : null}
      {!showAgentAutomation || scopedControlIntent === null || automation.data === null ? null : (
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
      {!showAgentAutomation || circuitIntent === null ? null : (
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

interface RuntimeProviderModelCatalogState {
  readonly status: "loading" | "ready" | "error";
  readonly models?: readonly string[];
  readonly error?: string;
}

const RUNTIME_PROVIDER_TEMPLATE_STORAGE_KEY = "geo.runtime-provider-templates.v1";

function readRuntimeProviderTemplates(): readonly RuntimeProviderTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(RUNTIME_PROVIDER_TEMPLATE_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RuntimeProviderTemplate =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as RuntimeProviderTemplate).id === "string" &&
        typeof (item as RuntimeProviderTemplate).name === "string" &&
        typeof (item as RuntimeProviderTemplate).key === "string" &&
        typeof (item as RuntimeProviderTemplate).provider === "string" &&
        typeof (item as RuntimeProviderTemplate).model === "string" &&
        typeof (item as RuntimeProviderTemplate).baseUrl === "string" &&
        typeof (item as RuntimeProviderTemplate).api === "string" &&
        typeof (item as RuntimeProviderTemplate).completionsMode === "string" &&
        typeof (item as RuntimeProviderTemplate).apiKey === "string",
    );
  } catch {
    return [];
  }
}

function writeRuntimeProviderTemplates(templates: readonly RuntimeProviderTemplate[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(RUNTIME_PROVIDER_TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

interface RuntimeProviderConfigDraft {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly api: "openai-responses" | "openai-completions" | "";
  readonly completionsMode: "stream" | "json";
  readonly enabled: boolean;
  readonly apiKey: string;
  readonly version: number;
  readonly thinkingLevel: string;
  readonly reviewMode: "ai" | "manual" | "none";
}

function runtimeProviderConfigLabel(key: RuntimeProviderConfigKey): string {
  if (key === "agent_drafting") return "写文章 Agent";
  if (key === "agent_media_inspection") return "图片审查 Vision";
  return "配图搜索";
}

function runtimeProviderConfigDetail(key: RuntimeProviderConfigKey): string {
  if (key === "agent_drafting") return "草稿生成与自动化写作";
  if (key === "agent_media_inspection") return "配图安全与相关性检查";
  return "Wikimedia / Pexels 授权图源";
}

function defaultRuntimeProviderConfigDraft(
  key: RuntimeProviderConfigKey,
  section: RuntimeProviderConfigSection | undefined,
): RuntimeProviderConfigDraft {
  const isMediaSearch = key === "media_search";
  return {
    provider: section?.provider ?? (isMediaSearch ? "wikimedia_commons" : "openai-compatible"),
    model: section?.model ?? (isMediaSearch ? "wikimedia-commons-v1" : ""),
    baseUrl: section?.baseUrl ?? "",
    api: isMediaSearch ? "" : (section?.api ?? "openai-responses"),
    completionsMode: section?.completionsMode ?? "stream",
    enabled: section?.enabled ?? true,
    apiKey: "",
    version: section?.version ?? 1,
    thinkingLevel:
      typeof section?.settings?.thinkingLevel === "string" ? section.settings.thinkingLevel : "low",
    reviewMode:
      key === "agent_media_inspection"
        ? section?.settings?.reviewMode === "none"
          ? "none"
          : section?.settings?.reviewMode === "manual"
            ? "manual"
            : section?.settings?.reviewMode === "ai"
              ? "ai"
              : section === undefined || section.apiKeySet !== true
                ? "manual"
                : "ai"
        : "ai",
  };
}

function RuntimeProviderConfigPanel({ api, canManage }: { api: GeoApi; canManage: boolean }) {
  const [resource, setResource] = useState<ApiResource<RuntimeProviderConfigDocument | null>>({
    endpoint: "GET /api/runtime-provider-config",
    data: null,
    error: null,
    status: "loading",
  });
  const [drafts, setDrafts] = useState<
    Partial<Record<RuntimeProviderConfigKey, RuntimeProviderConfigDraft>>
  >({});
  const [saving, setSaving] = useState<RuntimeProviderConfigKey | null>(null);
  const [templates, setTemplates] = useState<readonly RuntimeProviderTemplate[]>(() =>
    readRuntimeProviderTemplates(),
  );
  const [templateNames, setTemplateNames] = useState<
    Partial<Record<RuntimeProviderConfigKey, string>>
  >({});
  const [templateSelections, setTemplateSelections] = useState<
    Partial<Record<RuntimeProviderConfigKey, string>>
  >({});
  const [modelCatalogs, setModelCatalogs] = useState<
    Partial<Record<RuntimeProviderConfigKey, RuntimeProviderModelCatalogState>>
  >({});

  async function refresh(): Promise<void> {
    setResource((current) => ({ ...current, error: null, status: "loading" }));
    try {
      const document = await api.getRuntimeProviderConfiguration();
      setResource({
        endpoint: "GET /api/runtime-provider-config",
        data: document,
        error: null,
        status: "ready",
      });
      setDrafts((current) => {
        const next = { ...current };
        for (const key of RUNTIME_PROVIDER_CONFIG_KEYS) {
          next[key] = defaultRuntimeProviderConfigDraft(
            key,
            document.sections.find((section) => section.configKey === key),
          );
        }
        return next;
      });
    } catch (error) {
      setResource({
        endpoint: "GET /api/runtime-provider-config",
        data: null,
        error:
          error instanceof GeoApiError
            ? {
                code: error.code,
                message: error.message,
                requestId: error.requestId,
                status: error.status,
              }
            : {
                code: "NETWORK_ERROR",
                message: error instanceof Error ? error.message : "无法读取模型与 API 配置",
                requestId: null,
                status: 0,
              },
        status: "error",
      });
    }
  }

  useEffect(() => {
    void refresh();
  }, [api]);

  function updateDraft(key: RuntimeProviderConfigKey, patch: Partial<RuntimeProviderConfigDraft>) {
    if ("baseUrl" in patch || "apiKey" in patch) {
      setModelCatalogs((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? defaultRuntimeProviderConfigDraft(key, undefined)), ...patch },
    }));
  }

  function applyTemplate(key: RuntimeProviderConfigKey, template: RuntimeProviderTemplate) {
    updateDraft(key, {
      provider: template.provider,
      model: template.model,
      baseUrl: template.baseUrl,
      api: template.api,
      completionsMode: template.completionsMode,
      ...(key === "agent_drafting" ? { thinkingLevel: template.thinkingLevel } : {}),
      ...(key === "agent_media_inspection" ? { reviewMode: template.reviewMode } : {}),
      ...(template.apiKey === "" ? {} : { apiKey: template.apiKey }),
    });
    setTemplateSelections((current) => ({ ...current, [key]: template.id }));
  }

  function saveCurrentTemplate(key: RuntimeProviderConfigKey) {
    const draft = drafts[key] ?? defaultRuntimeProviderConfigDraft(key, undefined);
    const name = templateNames[key]?.trim();
    if (name === undefined || name === "") return;
    const template: RuntimeProviderTemplate = {
      id: `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      key,
      provider: draft.provider.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      api: draft.api,
      completionsMode: draft.completionsMode,
      thinkingLevel: draft.thinkingLevel,
      reviewMode: draft.reviewMode,
      apiKey: draft.apiKey.trim(),
      createdAt: new Date().toISOString(),
    };
    const next = [...templates, template];
    setTemplates(next);
    writeRuntimeProviderTemplates(next);
    setTemplateNames((current) => ({ ...current, [key]: "" }));
    setTemplateSelections((current) => ({ ...current, [key]: template.id }));
  }

  async function fetchModelCatalog(key: RuntimeProviderConfigKey) {
    const draft = drafts[key] ?? defaultRuntimeProviderConfigDraft(key, undefined);
    if (draft.baseUrl.trim() === "") return;
    setModelCatalogs((current) => ({ ...current, [key]: { status: "loading" } }));
    try {
      const models = await api.fetchRuntimeProviderModelCatalog({
        configKey: key,
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey.trim() }),
      });
      setModelCatalogs((current) => ({ ...current, [key]: { status: "ready", models } }));
    } catch (error) {
      setModelCatalogs((current) => ({
        ...current,
        [key]: {
          status: "error",
          error:
            error instanceof GeoApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : "无法获取模型目录",
        },
      }));
    }
  }

  async function saveSection(key: RuntimeProviderConfigKey): Promise<void> {
    const draft = drafts[key] ?? defaultRuntimeProviderConfigDraft(key, undefined);
    if (saving !== null || !canManage) return;
    setSaving(key);
    try {
      const isMediaSearch = key === "media_search";
      const manualMediaReview = key === "agent_media_inspection" && draft.reviewMode === "manual";
      const noVisionReview = key === "agent_media_inspection" && draft.reviewMode === "none";
      const inertMediaReview = manualMediaReview || noVisionReview;
      const document = await api.updateRuntimeProviderConfiguration({
        sections: [
          {
            configKey: key,
            // Non-AI review modes hide provider fields, but the API contract still
            // requires non-empty provider/model values. Persist an explicit inert
            // identity so the runtime does not inherit the drafting provider.
            provider: manualMediaReview
              ? "manual-review-operator"
              : noVisionReview
                ? "no-vision-pass-through"
                : draft.provider.trim(),
            model: manualMediaReview
              ? "manual-review-queue-v1"
              : noVisionReview
                ? "no-vision-v1"
                : draft.model.trim(),
            baseUrl:
              isMediaSearch || inertMediaReview
                ? null
                : draft.baseUrl.trim() === ""
                  ? null
                  : draft.baseUrl.trim(),
            api: isMediaSearch || inertMediaReview || draft.api === "" ? null : draft.api,
            completionsMode: draft.completionsMode,
            enabled: draft.enabled,
            version: draft.version,
            ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey.trim() }),
            ...(key === "agent_drafting"
              ? { settings: { thinkingLevel: draft.thinkingLevel } }
              : key === "agent_media_inspection"
                ? { settings: { reviewMode: draft.reviewMode } }
                : isMediaSearch
                  ? {
                      settings: {
                        proxyUrl: draft.baseUrl.trim() === "" ? null : draft.baseUrl.trim(),
                      },
                    }
                  : {}),
          },
        ],
        reason: "前端热更新",
      });
      setResource({
        endpoint: "PUT /api/runtime-provider-config",
        data: document,
        error: null,
        status: "ready",
      });
      setDrafts((current) => {
        const next = { ...current };
        for (const section of document.sections) {
          next[section.configKey] = defaultRuntimeProviderConfigDraft(section.configKey, section);
        }
        return next;
      });
    } catch (error) {
      setResource((current) => ({
        ...current,
        error:
          error instanceof GeoApiError
            ? {
                code: error.code,
                message: error.message,
                requestId: error.requestId,
                status: error.status,
              }
            : {
                code: "NETWORK_ERROR",
                message: error instanceof Error ? error.message : "模型与 API 配置保存失败",
                requestId: null,
                status: 0,
              },
        status: "error",
      }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="panel policy-settings">
      <PanelHeading title="模型与 API" meta="运行时可热更新" />
      <ResourceState resource={resource} empty={false} emptyLabel="" />
      {resource.status === "ready" && resource.data !== null ? (
        <div className="runtime-provider-config-grid">
          {RUNTIME_PROVIDER_CONFIG_KEYS.map((key) => {
            const section = resource.data?.sections.find(
              (candidate) => candidate.configKey === key,
            );
            const draft = drafts[key] ?? defaultRuntimeProviderConfigDraft(key, section);
            const isMediaSearch = key === "media_search";
            const isMediaInspection = key === "agent_media_inspection";
            const openAiCompatible = !isMediaSearch && draft.provider === "openai-compatible";
            const aiFieldsHidden =
              isMediaInspection && (draft.reviewMode === "manual" || draft.reviewMode === "none");
            return (
              <div className="runtime-provider-config-card" key={key}>
                <div className="runtime-provider-config-head">
                  <div>
                    <ServerCog size={18} />
                    <div>
                      <strong>{runtimeProviderConfigLabel(key)}</strong>
                      <span>{runtimeProviderConfigDetail(key)}</span>
                    </div>
                  </div>
                  <StatusBadge tone={draft.enabled ? "success" : "neutral"}>
                    {draft.enabled ? "已启用" : "已停用"}
                  </StatusBadge>
                </div>
                {!isMediaSearch ? (
                  <div className="runtime-provider-config-toolbar">
                    <label>
                      <span>配置模板</span>
                      <select
                        value={templateSelections[key] ?? ""}
                        disabled={!canManage}
                        onChange={(event) => {
                          const id = event.target.value;
                          if (id === "") {
                            setTemplateSelections((current) => ({ ...current, [key]: "" }));
                            return;
                          }
                          const template = [
                            ...RUNTIME_PROVIDER_BUILTIN_TEMPLATES,
                            ...templates,
                          ].find((candidate) => candidate.id === id && candidate.key === key);
                          if (template !== undefined) applyTemplate(key, template);
                        }}
                      >
                        <option value="">自定义</option>
                        <optgroup label="内置预设">
                          {RUNTIME_PROVIDER_BUILTIN_TEMPLATES.filter(
                            (candidate) => candidate.key === key,
                          ).map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.name}
                            </option>
                          ))}
                        </optgroup>
                        {templates.some((candidate) => candidate.key === key) ? (
                          <optgroup label="已保存模板">
                            {templates
                              .filter((candidate) => candidate.key === key)
                              .map((template) => (
                                <option key={template.id} value={template.id}>
                                  {template.name}
                                </option>
                              ))}
                          </optgroup>
                        ) : null}
                      </select>
                    </label>
                    <div className="runtime-provider-template-save">
                      <input
                        value={templateNames[key] ?? ""}
                        disabled={!canManage}
                        placeholder="模板名称"
                        onChange={(event) =>
                          setTemplateNames((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={
                          !canManage || (templateNames[key] ?? "").trim() === "" || saving !== null
                        }
                        onClick={() => saveCurrentTemplate(key)}
                      >
                        <Save size={14} />
                        保存模板
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="runtime-provider-config-fields">
                  {isMediaInspection ? (
                    <label>
                      <span>审查方式</span>
                      <select
                        value={draft.reviewMode}
                        disabled={!canManage}
                        onChange={(event) =>
                          updateDraft(key, {
                            reviewMode: event.target.value as "ai" | "manual" | "none",
                          })
                        }
                      >
                        <option value="ai">AI 审查</option>
                        <option value="manual">人工审查</option>
                        <option value="none">无（默认通过）</option>
                      </select>
                    </label>
                  ) : null}
                  {aiFieldsHidden ? null : (
                    <>
                      <label>
                        <span>Provider</span>
                        {isMediaSearch ? (
                          <select
                            value={draft.provider}
                            disabled={!canManage}
                            onChange={(event) => {
                              const provider = event.target.value;
                              updateDraft(key, {
                                provider,
                                model:
                                  provider === "pexels" ? "pexels-api-v1" : "wikimedia-commons-v1",
                                apiKey: "",
                              });
                            }}
                          >
                            <option value="wikimedia_commons">Wikimedia Commons</option>
                            <option value="pexels">Pexels</option>
                          </select>
                        ) : (
                          <input
                            value={draft.provider}
                            disabled={!canManage}
                            onChange={(event) => updateDraft(key, { provider: event.target.value })}
                          />
                        )}
                      </label>
                      <label>
                        <span>Model</span>
                        <div className="runtime-provider-model-row">
                          <input
                            value={draft.model}
                            disabled={!canManage}
                            onChange={(event) => updateDraft(key, { model: event.target.value })}
                          />
                          {!isMediaSearch ? (
                            <button
                              type="button"
                              className="runtime-provider-model-fetch"
                              title="获取模型"
                              disabled={
                                !canManage ||
                                draft.baseUrl.trim() === "" ||
                                modelCatalogs[key]?.status === "loading"
                              }
                              onClick={() => void fetchModelCatalog(key)}
                            >
                              <RefreshCw
                                className={modelCatalogs[key]?.status === "loading" ? "spin" : ""}
                                size={15}
                              />
                            </button>
                          ) : null}
                        </div>
                      </label>
                      <label>
                        <span>{isMediaSearch ? "HTTPS 代理" : "Base URL"}</span>
                        <input
                          value={draft.baseUrl}
                          disabled={!canManage}
                          placeholder={
                            isMediaSearch ? "http://127.0.0.1:7890" : "https://api.example.com/v1"
                          }
                          onChange={(event) => updateDraft(key, { baseUrl: event.target.value })}
                        />
                      </label>
                      {openAiCompatible ? (
                        <>
                          <label>
                            <span>API 模式</span>
                            <select
                              value={draft.api}
                              disabled={!canManage}
                              onChange={(event) =>
                                updateDraft(key, {
                                  api: event.target.value as
                                    "openai-responses" | "openai-completions",
                                })
                              }
                            >
                              <option value="openai-responses">Responses</option>
                              <option value="openai-completions">Completions</option>
                            </select>
                          </label>
                          <label>
                            <span>返回模式</span>
                            <select
                              value={draft.completionsMode}
                              disabled={!canManage}
                              onChange={(event) =>
                                updateDraft(key, {
                                  completionsMode: event.target.value as "stream" | "json",
                                })
                              }
                            >
                              <option value="stream">Stream</option>
                              <option value="json">JSON</option>
                            </select>
                          </label>
                        </>
                      ) : null}
                      {key === "agent_drafting" ? (
                        <label>
                          <span>推理级别</span>
                          <select
                            value={draft.thinkingLevel}
                            disabled={!canManage}
                            onChange={(event) =>
                              updateDraft(key, { thinkingLevel: event.target.value })
                            }
                          >
                            <option value="off">Off</option>
                            <option value="minimal">Minimal</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="xhigh">X-High</option>
                          </select>
                        </label>
                      ) : null}
                      <label>
                        <span>API Key</span>
                        <div className="runtime-provider-key">
                          <KeyRound size={15} />
                          <input
                            type="password"
                            value={draft.apiKey}
                            disabled={!canManage}
                            placeholder={section?.apiKeySet ? "保留当前密钥" : "输入 API Key"}
                            onChange={(event) => updateDraft(key, { apiKey: event.target.value })}
                          />
                        </div>
                      </label>
                      {modelCatalogs[key]?.status === "ready" &&
                      (modelCatalogs[key]?.models?.length ?? 0) > 0 ? (
                        <label>
                          <span>模型目录</span>
                          <select
                            value={draft.model}
                            disabled={!canManage}
                            onChange={(event) => updateDraft(key, { model: event.target.value })}
                          >
                            <option value="">选择模型</option>
                            {modelCatalogs[key]?.models?.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {modelCatalogs[key]?.status === "error" ? (
                        <p className="runtime-provider-model-error">{modelCatalogs[key]?.error}</p>
                      ) : null}
                    </>
                  )}
                  <label className="runtime-provider-toggle">
                    <span>启用</span>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={!canManage}
                      onChange={(event) => updateDraft(key, { enabled: event.target.checked })}
                    />
                  </label>
                </div>
                <div className="runtime-provider-config-foot">
                  <div>
                    <small>
                      {section === undefined
                        ? "尚未配置"
                        : `v${section.version} · ${formatDateTime(section.updatedAt)}`}
                    </small>
                    <small>{section?.apiKeySet ? "密钥已配置" : "未配置密钥"}</small>
                  </div>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!canManage || saving === key}
                    onClick={() => void saveSection(key)}
                  >
                    {saving === key ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Save size={16} />
                    )}
                    保存
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {resource.status === "ready" && resource.data !== null ? (
        <SourceCaption endpoint={resource.endpoint} loadedAt={resource.data.updatedAt} />
      ) : null}
    </section>
  );
}

const AUTOMATION_MODE_OPTIONS: readonly {
  readonly value: AutomationMode;
  readonly label: string;
}[] = [
  { value: "shadow", label: "影子模式 · 仅演练" },
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

function quotaPolicy(
  quota: Readonly<Record<string, unknown>>,
  fallback: "review" | "requeue",
): "review" | "requeue" {
  const value = quota.errorBudgetExhaustedPolicy;
  return value === "requeue" ? "requeue" : value === "review" ? "review" : fallback;
}

function quotaFromControl(control: AutomationControl): AutomationQuota {
  return {
    maxConcurrent: quotaNumber(control.quota, "maxConcurrent", 1),
    perMinute: quotaNumber(control.quota, "perMinute", 10),
    perDay: quotaNumber(control.quota, "perDay", 100),
    cooldownSeconds: quotaNumber(control.quota, "cooldownSeconds", 0),
    errorBudget: quotaNumber(control.quota, "errorBudget", 5),
    errorBudgetExhaustedPolicy: quotaPolicy(control.quota, "review"),
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
          <span>无人值守只调度已审计且登录态就绪的平台最终变体</span>
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
      <div className="setting-control">
        <div>
          <strong>错误预算耗尽策略</strong>
          <span>review 移交人工审查，requeue 继续排队等待预算恢复</span>
        </div>
        <select
          aria-label="错误预算耗尽策略"
          value={quota.errorBudgetExhaustedPolicy}
          disabled={!canManage || pending}
          onChange={(event) =>
            setQuota((current) => ({
              ...current,
              errorBudgetExhaustedPolicy: event.target.value as "review" | "requeue",
            }))
          }
        >
          <option value="review">review（人工审查）</option>
          <option value="requeue">requeue（继续排队）</option>
        </select>
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
          placeholder="例如：审计规则与演练样本已复核，启用无人值守调度"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="automation-control-actions">
        {!canManage ? <span>需要自动化管理权限</span> : null}
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

function automationScopeLabel(scopeType: AutomationScopeType): string {
  return {
    tenant: "租户",
    platform: "平台",
    account: "账号",
    campaign: "推广计划",
    topic: "主题",
  }[scopeType];
}

function automationScopeKeyLabel(
  scopeType: AutomationScopeType,
  scopeKey: string,
  channelAccounts: readonly ChannelAccount[],
  campaigns: readonly CampaignRow[],
): string {
  if (scopeType === "account") {
    const account = channelAccounts.find((candidate) => candidate.id === scopeKey);
    return account === undefined
      ? scopeKey
      : `${platformLabel(account.platform)} · ${accountDisplayNameLabel(account.displayName)}`;
  }
  if (scopeType === "campaign") {
    const campaign = campaigns.find((candidate) => candidate.id === scopeKey);
    return campaign === undefined ? scopeKey : campaign.name;
  }
  return scopeKey;
}

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
        { value: "baijiahao", label: "百家号" },
        { value: "netease", label: "网易号" },
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
  const dialogRef = useModalDialog<HTMLDivElement>(pending ? null : onClose);
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
        ref={dialogRef}
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
                <option value="campaign">推广计划</option>
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
                aria-label="范围急停开关"
                type="checkbox"
                checked={killSwitchEnabled}
                disabled={pending}
                onChange={(event) => setKillSwitchEnabled(event.target.checked)}
              />
              启用该范围急停开关
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
          <div className="setting-control">
            <div>
              <strong>错误预算耗尽策略</strong>
              <span>review 移交人工审查，requeue 继续排队等待预算恢复</span>
            </div>
            <select
              aria-label="范围错误预算耗尽策略"
              value={quota.errorBudgetExhaustedPolicy}
              disabled={pending}
              onChange={(event) =>
                setQuota((current) => ({
                  ...current,
                  errorBudgetExhaustedPolicy: event.target.value as "review" | "requeue",
                }))
              }
            >
              <option value="review">review（人工审查）</option>
              <option value="requeue">requeue（继续排队）</option>
            </select>
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
  const dialogRef = useModalDialog<HTMLDivElement>(pending ? null : onClose);
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
        ref={dialogRef}
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
              <option value="campaign">推广计划</option>
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
  readonly promptTemplate: string | null;
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
  api,
  onClose,
  onCreate,
}: {
  mode: ConsoleMode;
  brandOptions: readonly CampaignBrandOption[];
  canCreate: boolean;
  defaultIndustry: string;
  api: GeoApi;
  onClose: () => void;
  onCreate: (value: CampaignFormValue) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [objective, setObjective] = useState("");
  const [industry, setIndustry] = useState(defaultIndustry);
  const [brandId, setBrandId] = useState(brandOptions[0]?.brandId ?? "");
  const [needs, setNeeds] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalDialog<HTMLDivElement>(submitting ? null : onClose);
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
        promptTemplate: promptTemplate.trim() || null,
      });
      onClose();
    } catch (createError) {
      setError(apiErrorText(createError));
    } finally {
      setSubmitting(false);
    }
  }
  async function generateTemplate() {
    if (needs.trim().length === 0) {
      setError("请先填写客户内容需求");
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const generated = await api.generateCampaignPromptTemplate({
        needs: needs.trim(),
        ...(name.trim().length > 0 ? { campaignName: name.trim() } : {}),
        ...(topic.trim().length > 0 ? { topicKey: topic.trim() } : {}),
        ...(objective.trim().length > 0 ? { objective: objective.trim() } : {}),
      });
      setPromptTemplate(generated.promptTemplate);
    } catch (generateError) {
      setError(apiErrorText(generateError));
    } finally {
      setGenerating(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-campaign-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="new-campaign-title">新建推广计划</h2>
            <p>{mode === "demo" ? "演示数据 · 默认影子模式" : "写入 POST /api/campaigns"}</p>
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
              title="当前租户不可创建推广计划"
              detail="需要内容写入权限、可用的品牌目录和已就绪的推广计划资源"
            />
          ) : null}
          <label>
            推广计划名称
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
          <label>
            客户内容需求
            <textarea
              value={needs}
              onChange={(event) => setNeeds(event.target.value)}
              placeholder="例如：突出国企地接、真纯玩无购物，弱化营销感，覆盖新疆喀纳斯、那拉提、赛里木湖"
              rows={3}
            />
          </label>
          <div className="ops-form-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => void generateTemplate()}
              disabled={generating || liveBlocked}
            >
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "正在生成" : "AI 生成提示词模版"}
            </button>
          </div>
          <label>
            提示词模版
            <textarea
              value={promptTemplate}
              onChange={(event) => setPromptTemplate(event.target.value)}
              placeholder="AI 生成后可继续编辑，内容会作为文章生成的内容要求"
              rows={8}
            />
          </label>
          {mode === "live" ? (
            <>
              <label>
                目标
                <input
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder="本次推广计划的可验证目标"
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
              {submitting ? "正在创建" : "创建推广计划"}
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
  const dialogRef = useModalDialog<HTMLDivElement>(pending ? null : onClose);

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
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kill-switch-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="kill-switch-title">{enabled ? "开启急停开关" : "关闭急停开关"}</h2>
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
                  : "例如：异常已复核并完成修正，恢复影子模式"
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
    industry: industryLabel(campaign.industry),
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
      updatedAt:
        item.latestActivityAt === null
          ? item.latestVersion === null
            ? null
            : `版本 ${item.latestVersion}`
          : formatDateTime(item.latestActivityAt),
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
      level: executionLevelLabel(job.executionLevel),
      state: stateLabel(job.state),
      evidence: receipt === undefined ? "尚无回执" : evidenceTypeLabel(receipt.evidenceType),
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
    evidence: evidenceTypeLabel(item.evidenceType),
  }));
}

function liveAccountRows(items: readonly ChannelAccount[]): AccountRow[] {
  return items.map((item) => ({
    id: item.id,
    platformKey: item.platform,
    platform: platformLabel(item.platform),
    account: accountDisplayNameLabel(item.displayName),
    capability: connectorCapabilityLabel(item.capability),
    execution: item.supportedExecutionLevels.map(executionLevelLabel).join(" / "),
    evidence: `${evidenceTypeLabel(item.evidenceType)} · ${item.evidenceRefs.length} 项引用`,
    health: item.status,
    lastCheck:
      item.lastVerifiedAt === null
        ? `${item.dailyPublishQuota ?? 30} 篇/日 · 并发 ${item.maxConcurrentPublications ?? 1}`
        : formatDateTime(item.lastVerifiedAt),
  }));
}

function filterCtripAnalyticsAccounts(
  dashboard: CtripPlatformAnalyticsDashboard | null,
  archivedAccountIds: ReadonlySet<string>,
): CtripPlatformAnalyticsDashboard | null {
  if (dashboard === null || archivedAccountIds.size === 0) return dashboard;
  const accounts = dashboard.accounts.filter(
    (account) => !archivedAccountIds.has(account.channelAccountId),
  );
  const measured = accounts.filter((account) => account.dataStatus === "ready");
  const sum = (select: (account: (typeof accounts)[number]) => number | null): number =>
    measured.reduce((total, account) => total + (select(account) ?? 0), 0);
  return {
    ...dashboard,
    accountCount: accounts.length,
    reportingAccountCount: measured.length,
    totals: {
      publishCount: sum((account) => account.publishCount),
      featuredCount: sum((account) => account.featuredCount),
      qualityCount: sum((account) => account.qualityCount),
      contentHeat: sum((account) => account.contentHeat),
      views: sum((account) => account.totalViews),
      viewers: sum((account) => account.totalViewers),
      likes: sum((account) => account.totalLikes),
      favorites: sum((account) => account.totalFavorites),
      comments: sum((account) => account.totalComments),
      interactions: sum((account) => account.totalInteractions),
      interactors: sum((account) => account.totalInteractors),
    },
    accounts,
  };
}

function filterPriorityAnalyticsAccounts(
  dashboard: PriorityPlatformAnalyticsDashboard | null,
  archivedAccountIds: ReadonlySet<string>,
): PriorityPlatformAnalyticsDashboard | null {
  if (dashboard === null || archivedAccountIds.size === 0) return dashboard;
  const accounts = dashboard.accounts.filter(
    (account) => !archivedAccountIds.has(account.channelAccountId),
  );
  const measured = accounts.filter((account) => account.dataStatus === "ready");
  const sum = (select: (account: (typeof accounts)[number]) => number | null): number =>
    measured.reduce((total, account) => total + (select(account) ?? 0), 0);
  return {
    ...dashboard,
    accountCount: accounts.length,
    reportingAccountCount: measured.length,
    totals: {
      publishCount: sum((account) => account.publishCount),
      impressions: sum((account) => account.totalImpressions),
      reads: sum((account) => account.totalReads),
      likes: sum((account) => account.totalLikes),
      comments: sum((account) => account.totalComments),
    },
    accounts,
  };
}

function filterArchivedAccounts(
  dashboard: LiveDashboard,
  archivedAccountIds: ReadonlySet<string>,
): LiveDashboard {
  if (archivedAccountIds.size === 0) return dashboard;
  return {
    ...dashboard,
    channelAccounts: {
      ...dashboard.channelAccounts,
      data: dashboard.channelAccounts.data.filter((account) => !archivedAccountIds.has(account.id)),
    },
    ctripAccountAnalytics: {
      ...dashboard.ctripAccountAnalytics,
      data: filterCtripAnalyticsAccounts(dashboard.ctripAccountAnalytics.data, archivedAccountIds),
    },
    priorityPlatformAnalytics: {
      ...dashboard.priorityPlatformAnalytics,
      data: filterPriorityAnalyticsAccounts(
        dashboard.priorityPlatformAnalytics.data,
        archivedAccountIds,
      ),
    },
  };
}

export function App({
  api: suppliedApi,
  initialMode = "live",
  operationsPollIntervalMs = OPERATIONS_POLL_FALLBACK_MS,
}: AppProps = {}) {
  const location = useLocation();
  const api = useMemo(() => suppliedApi ?? createGeoApi(), [suppliedApi]);
  const [auth, setAuth] = useState<AuthState>(
    initialMode === "demo" ? { status: "demo" } : { status: "loading" },
  );
  const [knownTenants, setKnownTenants] = useState<readonly TenantOption[]>([]);
  const [dashboard, setDashboard] = useState<LiveDashboard>(createLoadingDashboard);
  const dashboardScopeRef = useRef<string | null>(null);
  const dashboardTenantIdRef = useRef<string | null>(null);
  const archivedChannelAccountIdsByTenantRef = useRef<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [demoTenantId, setDemoTenantId] = useState(demoTenants[0]?.id ?? "");
  const [demoCampaigns, setDemoCampaigns] = useState(initialCampaigns);
  const [demoKillSwitch, setDemoKillSwitch] = useState(false);
  const [killSwitchIntent, setKillSwitchIntent] = useState<boolean | null>(null);
  const [killSwitchPending, setKillSwitchPending] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavDialogRef = useModalDialog<HTMLElement>(
    () => setMobileNavOpen(false),
    mobileNavOpen,
  );
  const [newCampaignOpen, setNewCampaignOpen] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [sessionActionPending, setSessionActionPending] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 961px)");
    const closeAtDesktop = () => {
      if (desktop.matches) setMobileNavOpen(false);
    };
    closeAtDesktop();
    desktop.addEventListener("change", closeAtDesktop);
    return () => desktop.removeEventListener("change", closeAtDesktop);
  }, []);

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
    if (
      auth.status !== "authenticated" ||
      location.pathname === "/account-login" ||
      location.pathname === "/ctrip-login"
    )
      return;
    const authenticatedSession = auth.session;
    const dashboardScope = [
      authenticatedSession.tenant.id,
      `capabilities:${authenticatedSession.actor.capabilities.join("\0")}`,
      `modules:${authenticatedSession.actor.enabledModules.join("\0")}`,
    ].join("\0");
    let active = true;
    if (dashboardScopeRef.current !== dashboardScope) {
      dashboardScopeRef.current = dashboardScope;
      dashboardTenantIdRef.current = authenticatedSession.tenant.id;
      setDashboard(createLoadingDashboard());
    }
    loadLiveDashboard(
      api,
      authenticatedSession.actor.capabilities,
      authenticatedSession.actor.enabledModules,
    ).then(async (next) => {
      if (!active) return;
      if (Object.values(next).some(hasModuleNotEnabledError)) {
        const refreshedSession = await api.getSession();
        if (active) setAuth({ status: "authenticated", session: refreshedSession });
        return;
      }
      if (dashboardHasAuthenticationError(next)) {
        setAuth({
          status: "unauthenticated",
          error: "会话已失效，请重新登录",
          tenantSlug: authenticatedSession.tenant.slug,
        });
        return;
      }
      setKnownTenants((items) => mergeTenantOptions(items, next.tenants.data));
      setDashboard(
        filterArchivedAccounts(
          next,
          archivedChannelAccountIdsByTenantRef.current.get(authenticatedSession.tenant.id) ??
            new Set(),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [
    api,
    auth.status === "authenticated" ? auth.session.tenant.id : "",
    auth.status === "authenticated" ? auth.session.actor.capabilities.join("\0") : "",
    auth.status === "authenticated" ? auth.session.actor.enabledModules.join("\0") : "",
    location.pathname,
    refreshVersion,
  ]);

  useEffect(() => {
    if (
      auth.status !== "authenticated" ||
      !auth.session.actor.enabledModules.includes("priority_distribution") ||
      location.pathname === "/account-login" ||
      location.pathname === "/ctrip-login"
    )
      return;
    const authenticatedSession = auth.session;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function pollChannelAccounts(): Promise<void> {
      const [resource, analyticsResource, priorityAnalyticsResource] = await Promise.all([
        loadChannelAccountsResource(api),
        loadCtripAccountAnalyticsResource(api),
        loadPriorityPlatformAnalyticsResource(api),
      ]);
      if (!active) return;
      if (resource.error?.status === 401) {
        setAuth({
          status: "unauthenticated",
          error: "会话已失效，请重新登录",
          tenantSlug: authenticatedSession.tenant.slug,
        });
        return;
      }
      if (resource.error?.code === "MODULE_NOT_ENABLED") {
        const refreshedSession = await api.getSession();
        if (active) setAuth({ status: "authenticated", session: refreshedSession });
        return;
      }
      setDashboard((current) =>
        filterArchivedAccounts(
          {
            ...current,
            channelAccounts: resource,
            ctripAccountAnalytics: analyticsResource,
            priorityPlatformAnalytics: priorityAnalyticsResource,
          },
          archivedChannelAccountIdsByTenantRef.current.get(authenticatedSession.tenant.id) ??
            new Set(),
        ),
      );
      timer = setTimeout(pollChannelAccounts, resource.status === "error" ? 3_000 : 30_000);
    }

    // Retry quickly after a transient tunnel/API failure, then settle into the
    // account-status polling cadence required by the operator console.
    timer = setTimeout(pollChannelAccounts, 3_000);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    api,
    auth.status === "authenticated" ? auth.session.tenant.id : "",
    auth.status === "authenticated" ? auth.session.actor.enabledModules.join("\0") : "",
    location.pathname,
  ]);

  useEffect(() => {
    if (
      auth.status !== "authenticated" ||
      !auth.session.actor.enabledModules.some((module) =>
        ["trend_discovery", "ai_content", "priority_distribution", "agent_automation"].includes(
          module,
        ),
      ) ||
      location.pathname === "/account-login" ||
      location.pathname === "/ctrip-login"
    )
      return;
    const authenticatedSession = auth.session;
    let active = true;
    let refreshRunning = false;
    let refreshQueued = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let subscription: ReturnType<NonNullable<GeoApi["subscribeOperationsEvents"]>> | undefined;

    async function refreshOperations(): Promise<void> {
      if (!active) return;
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }
      refreshRunning = true;
      try {
        do {
          refreshQueued = false;
          const next = await loadLiveOperationsResources(
            api,
            authenticatedSession.actor.enabledModules,
          );
          if (!active) return;
          const authenticationFailed = [
            next.trendCandidates,
            next.content,
            next.publicationJobs,
            next.receipts,
          ].some((resource) => resource.error?.status === 401);
          if (authenticationFailed) {
            setAuth({
              status: "unauthenticated",
              error: "会话已失效，请重新登录",
              tenantSlug: authenticatedSession.tenant.slug,
            });
            return;
          }
          if (
            [next.trendCandidates, next.content, next.publicationJobs, next.receipts].some(
              hasModuleNotEnabledError,
            )
          ) {
            const refreshedSession = await api.getSession();
            if (active) setAuth({ status: "authenticated", session: refreshedSession });
            return;
          }
          setDashboard((current) => ({
            ...current,
            trendCandidates:
              next.trendCandidates.status === "error"
                ? { ...next.trendCandidates, data: current.trendCandidates.data }
                : next.trendCandidates,
            content:
              next.content.status === "error"
                ? { ...next.content, data: current.content.data }
                : next.content,
            publicationJobs:
              next.publicationJobs.status === "error"
                ? { ...next.publicationJobs, data: current.publicationJobs.data }
                : next.publicationJobs,
            receipts:
              next.receipts.status === "error"
                ? { ...next.receipts, data: current.receipts.data }
                : next.receipts,
            loadedAt: next.loadedAt,
          }));
        } while (active && refreshQueued);
      } finally {
        refreshRunning = false;
      }
    }

    const scheduleFallbackPoll = () => {
      if (!active || fallbackTimer !== undefined) return;
      fallbackTimer = setTimeout(async () => {
        fallbackTimer = undefined;
        await refreshOperations();
        scheduleFallbackPoll();
      }, operationsPollIntervalMs);
    };
    const startFallbackPolling = () => {
      subscription?.close();
      subscription = undefined;
      scheduleFallbackPoll();
    };

    if (api.subscribeOperationsEvents === undefined) {
      startFallbackPolling();
    } else {
      try {
        subscription = api.subscribeOperationsEvents({
          onSnapshot: (event) => {
            if (event.tenantId !== authenticatedSession.tenant.id) return;
            void api
              .getSession()
              .then((refreshedSession) => {
                if (!active) return;
                const modulesChanged =
                  refreshedSession.actor.enabledModules.join("\0") !==
                  authenticatedSession.actor.enabledModules.join("\0");
                setAuth({ status: "authenticated", session: refreshedSession });
                if (!modulesChanged) setRefreshVersion((value) => value + 1);
              })
              .catch(startFallbackPolling);
          },
          onError: startFallbackPolling,
        });
      } catch {
        startFallbackPolling();
      }
    }
    scheduleFallbackPoll();

    return () => {
      active = false;
      subscription?.close();
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    };
  }, [
    api,
    auth.status === "authenticated" ? auth.session.tenant.id : "",
    auth.status === "authenticated" ? auth.session.actor.enabledModules.join("\0") : "",
    location.pathname,
    operationsPollIntervalMs,
  ]);

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
          dashboardScopeRef.current = null;
          setDashboard(createLoadingDashboard());
          setAuth({ status: "authenticated", session });
        }}
        onTenantsDiscovered={(tenants) =>
          setKnownTenants((items) => mergeTenantOptions(items, tenants))
        }
      />
    );
  }

  if (
    auth.status === "authenticated" &&
    (location.pathname === "/account-login" || location.pathname === "/ctrip-login")
  ) {
    return auth.session.actor.enabledModules.includes("priority_distribution") ? (
      <AccountLoginHandoffRoute api={api} search={location.search} />
    ) : (
      <Navigate to="/overview" replace />
    );
  }

  const mode: ConsoleMode = auth.status === "demo" ? "demo" : "live";
  const session = auth.status === "authenticated" ? auth.session : null;
  const enabledModules = session?.actor.enabledModules ?? [];
  const visibleNavigationGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.requiredModule === undefined ||
          hasModuleAccess(mode, enabledModules, item.requiredModule),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const firstAvailablePath =
    visibleNavigationGroups.flatMap((group) => group.items)[0]?.path ?? "/overview";
  const canUseAiContent = hasModuleAccess(mode, enabledModules, "ai_content");
  const canUsePriorityDistribution = hasModuleAccess(mode, enabledModules, "priority_distribution");
  const canUseAgentAutomation = hasModuleAccess(mode, enabledModules, "agent_automation");
  const demoTenant = demoTenants.find((tenant) => tenant.id === demoTenantId) ?? demoTenants[0];
  const tenant = dashboard.tenant.data;
  const channelAccountRecords: readonly ChannelAccount[] =
    mode === "demo"
      ? demoTenant === undefined
        ? []
        : demoChannelAccountsForTenant(demoTenant)
      : dashboard.channelAccounts.data.filter(isRealChannelAccount);
  const analyticsVerificationAccountIds = new Set(
    [
      ...(dashboard.ctripAccountAnalytics.data?.accounts ?? []),
      ...(dashboard.priorityPlatformAnalytics.data?.accounts ?? []),
    ]
      .filter((account) => account.lastErrorCode?.endsWith("CHALLENGE_REQUIRED") ?? false)
      .map((account) => account.channelAccountId),
  );
  const assistedPublicationVerificationAccountIds = new Set(
    (mode === "live" ? dashboard.publicationAssistedHandoffs.data : [])
      .filter(
        (handoff) => handoff.state === "session_required" || handoff.state === "challenge_required",
      )
      .map((handoff) => handoff.channelAccountId),
  );
  const operatorPublicationVerificationAccounts =
    mode === "live"
      ? channelAccountRecords.filter((account) => {
          if (account.status !== "active") return false;
          const state = account.ctripRuntime?.sessionState;
          return (
            state === "session_required" ||
            assistedPublicationVerificationAccountIds.has(account.id)
          );
        })
      : [];
  const publicationVerificationAccountIds = new Set(
    operatorPublicationVerificationAccounts.map((account) => account.id),
  );
  const operatorChallengeDegradedAccounts =
    mode === "live"
      ? channelAccountRecords.filter((account) => {
          if (account.status !== "active") return false;
          return (
            account.ctripRuntime?.sessionState === "challenge_required" &&
            !publicationVerificationAccountIds.has(account.id)
          );
        })
      : [];
  const operatorAnalyticsVerificationAccounts =
    mode === "live"
      ? channelAccountRecords.filter(
          (account) =>
            account.status === "active" &&
            analyticsVerificationAccountIds.has(account.id) &&
            !publicationVerificationAccountIds.has(account.id),
        )
      : [];
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
          evidence: "固定样本",
        }))
      : liveProviderRows(dashboard.visibility.data);
  const accountRows: AccountRow[] =
    mode === "demo"
      ? (demoTenant === undefined ? [] : platformAccountsForTenant(demoTenant)).map((item) => ({
          id: item.platform,
          platformKey: null,
          platform: item.platform,
          account: item.account,
          capability:
            item.capability === "人工操作"
              ? connectorCapabilityLabel("manual_only")
              : item.capability,
          execution: item.execution,
          evidence: "演示预览",
          health: item.health,
          lastCheck: item.lastCheck,
        }))
      : liveAccountRows(dashboard.channelAccounts.data.filter(isRealChannelAccount));
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
            industry: current && tenant !== null ? industryLabel(tenant.industry) : "切换后读取",
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
        ? "需要内容写入权限"
        : dashboard.brands.status !== "ready"
          ? "品牌目录尚未就绪"
          : brandOptions.length === 0
            ? "请先为当前租户创建品牌"
            : dashboard.campaigns.status !== "ready"
              ? "推广计划资源尚未就绪"
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
          "急停开关写入后的 API 回读状态不一致",
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
      <aside
        ref={mobileNavDialogRef}
        className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}
        role={mobileNavOpen ? "dialog" : undefined}
        aria-modal={mobileNavOpen ? true : undefined}
        aria-label={mobileNavOpen ? "移动导航" : undefined}
      >
        <div className="brand-lockup">
          <span>G</span>
          <div>
            <strong>GEO Console</strong>
            <small>内容增长与证据治理</small>
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
          <label htmlFor="tenant-select">{mode === "demo" ? "当前客户" : "工作空间"}</label>
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
          {visibleNavigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
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
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="system-health">
            <span
              className={`health-indicator ${mode === "live" && dashboardErrors > 0 ? "health-error" : ""}`}
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
              <small>{mode === "demo" ? "不代表真实状态" : "API · 租户隔离"}</small>
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
      <div className="main-shell" inert={mobileNavOpen}>
        <header className="topbar">
          <button
            ref={mobileMenuButtonRef}
            className="icon-button menu-button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="打开导航"
          >
            <Menu size={20} />
          </button>
          <div className="page-title">
            <span className="page-kicker">{title?.section}</span>
            <h1>{title?.title}</h1>
            <p>{title?.subtitle}</p>
          </div>
          <div className="topbar-actions">
            <div className="topbar-system-state" role="status">
              <span
                className={`health-indicator ${mode === "live" && dashboardErrors > 0 ? "health-error" : ""}`}
              />
              <div>
                <strong>
                  {mode === "demo" ? "演示环境" : dashboardErrors > 0 ? "服务异常" : "服务在线"}
                </strong>
                <small>{mode === "demo" ? "固定样本" : "租户 API"}</small>
              </div>
            </div>
            <div
              className="avatar-button"
              aria-label={session?.actor.displayName ?? session?.actor.role ?? "演示操作员"}
              title={session?.actor.displayName ?? session?.actor.role ?? "演示操作员"}
            >
              <span>
                {mode === "demo"
                  ? "演示"
                  : (session?.actor.displayName ?? session?.actor.role ?? "API").slice(0, 2)}
              </span>
            </div>
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
            <div className="context-identity-copy">
              <small>{mode === "demo" ? "当前客户" : "当前工作空间"}</small>
              <strong>
                {mode === "demo"
                  ? demoTenant?.name
                  : (tenant?.displayName ?? session?.tenant.displayName)}
              </strong>
            </div>
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
                onClick={() => {
                  void api
                    .getSession()
                    .then((refreshedSession) => {
                      setAuth({ status: "authenticated", session: refreshedSession });
                      setRefreshVersion((value) => value + 1);
                    })
                    .catch((error: unknown) => setSessionActionError(apiErrorText(error)));
                }}
              >
                <RefreshCw size={16} />
              </button>
            ) : null}
            {canUseAiContent ? (
              <button
                className="button-primary"
                onClick={() => setNewCampaignOpen(true)}
                disabled={!canCreateCampaign}
                title={campaignCreateBlockReason ?? undefined}
              >
                <Plus size={16} /> 新建推广计划
              </button>
            ) : null}
          </div>
        </div>
        {operatorPublicationVerificationAccounts[0] === undefined ? null : (
          <div
            className="runtime-verification-banner"
            role="alert"
            aria-label="平台账号需要人工验证"
          >
            <ShieldAlert size={20} />
            <div className="runtime-verification-copy">
              <strong>
                {operatorPublicationVerificationAccounts.length === 1
                  ? `${platformLabel(operatorPublicationVerificationAccounts[0].platform)} · ${accountDisplayNameLabel(operatorPublicationVerificationAccounts[0].displayName)} 需要人工验证`
                  : `${operatorPublicationVerificationAccounts.length} 个平台账号需要人工验证`}
              </strong>
              <span>发布会话待验证；内容生产可继续，投放暂缓。</span>
              <small>请由运维完成滑块、扫码、重新登录或平台安全验证。</small>
            </div>
            <NavLink className="button-secondary runtime-verification-action" to="/accounts">
              前往账号验证 <ArrowRight size={15} />
            </NavLink>
          </div>
        )}
        {operatorChallengeDegradedAccounts[0] === undefined ? null : (
          <div
            className="runtime-verification-banner"
            role="status"
            aria-label="平台账号出现安全验证"
          >
            <ShieldAlert size={20} />
            <div className="runtime-verification-copy">
              <strong>
                {operatorChallengeDegradedAccounts.length === 1
                  ? `${platformLabel(operatorChallengeDegradedAccounts[0].platform)} · ${accountDisplayNameLabel(operatorChallengeDegradedAccounts[0].displayName)} 出现平台安全验证`
                  : `${operatorChallengeDegradedAccounts.length} 个平台账号出现平台安全验证`}
              </strong>
              <span>系统会带挑战继续推进，内容生产和发布不受影响。</span>
              <small>如需人工处理滑块或扫码，可前往账号验证。</small>
            </div>
            <NavLink className="button-secondary runtime-verification-action" to="/accounts">
              前往账号验证 <ArrowRight size={15} />
            </NavLink>
          </div>
        )}
        {operatorAnalyticsVerificationAccounts[0] === undefined ? null : (
          <div
            className="runtime-verification-banner"
            role="alert"
            aria-label="平台账号需要人工验证"
          >
            <ShieldAlert size={20} />
            <div className="runtime-verification-copy">
              <strong>
                {operatorAnalyticsVerificationAccounts.length === 1
                  ? `${platformLabel(operatorAnalyticsVerificationAccounts[0].platform)} · ${accountDisplayNameLabel(operatorAnalyticsVerificationAccounts[0].displayName)} 营销数据采集待验证`
                  : `${operatorAnalyticsVerificationAccounts.length} 个平台账号营销数据采集待验证`}
              </strong>
              <span>内容生产和发布不受影响。</span>
              <small>需要刷新营销数据时，再由运维完成采集页的滑块或扫码验证。</small>
            </div>
            <NavLink className="button-secondary runtime-verification-action" to="/accounts">
              前往账号验证 <ArrowRight size={15} />
            </NavLink>
          </div>
        )}
        {mode === "live" &&
        dashboard.automation.status === "ready" &&
        dashboard.automation.data !== null &&
        dashboard.automation.data.queueSaturation >= 1 ? (
          <div className="runtime-verification-banner" role="alert" aria-label="投放执行槽位满载">
            <Hourglass size={20} />
            <div className="runtime-verification-copy">
              <strong>
                投放执行槽位满载（{dashboard.automation.data.queueDepth}/
                {dashboard.automation.data.queueLimit}）
              </strong>
              <span>等待执行槽位释放后自动继续，无需手工操作。</span>
              <small>异步审核与公开回读不占用投放执行槽位。</small>
            </div>
          </div>
        ) : null}
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
                  enabledModules={enabledModules}
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
                  actorRole={session?.actor.role ?? ""}
                  capabilities={session?.actor.capabilities ?? []}
                  showAiContent={canUseAiContent}
                  showPriorityDistribution={canUsePriorityDistribution}
                  showAgentAutomation={canUseAgentAutomation}
                  api={api}
                  onChanged={() => setRefreshVersion((version) => version + 1)}
                  onSessionChanged={(refreshedSession) =>
                    setAuth({ status: "authenticated", session: refreshedSession })
                  }
                />
              }
            />
            <Route
              path="/content"
              element={
                <ModuleAccessBoundary allowed={canUseAiContent} fallbackPath={firstAvailablePath}>
                  <ContentView
                    mode={mode}
                    items={contentRows}
                    api={api}
                    tenantId={currentTenantId}
                    capabilities={session?.actor.capabilities ?? []}
                    dashboard={dashboard}
                  />
                </ModuleAccessBoundary>
              }
            />
            <Route
              path="/accounts"
              element={
                <ModuleAccessBoundary
                  allowed={canUsePriorityDistribution}
                  fallbackPath={firstAvailablePath}
                >
                  <div className="view-stack">
                    {mode === "live" && dashboard.channelAccounts.status !== "ready" ? (
                      <ResourceState
                        resource={dashboard.channelAccounts}
                        empty={channelAccountRecords.length === 0}
                        emptyLabel="暂无平台账号"
                      />
                    ) : null}
                    <ChannelAccountDirectory
                      accounts={channelAccountRecords}
                      automation={mode === "live" ? dashboard.automation.data : null}
                      publicationJobs={mode === "live" ? dashboard.publicationJobs.data : []}
                      publicationVerificationAccountIds={publicationVerificationAccountIds}
                      analytics={mode === "live" ? dashboard.ctripAccountAnalytics.data : null}
                      analyticsStatus={
                        mode === "live" ? dashboard.ctripAccountAnalytics.status : "ready"
                      }
                      priorityAnalytics={
                        mode === "live" ? dashboard.priorityPlatformAnalytics.data : null
                      }
                      priorityAnalyticsStatus={
                        mode === "live" ? dashboard.priorityPlatformAnalytics.status : "ready"
                      }
                      demo={mode === "demo"}
                      canManage={
                        mode === "live" &&
                        (session?.actor.capabilities.includes("tenant:manage") ?? false)
                      }
                      onCreate={async (input) => {
                        if (mode === "live") {
                          const account = await api.createChannelAccount(input);
                          setRefreshVersion((value) => value + 1);
                          return account;
                        }
                        throw new Error("当前模式不支持真实账号接入");
                      }}
                      onUpdate={async (accountId, input) => {
                        if (mode === "live") {
                          await api.updateChannelAccount(accountId, input);
                          setRefreshVersion((value) => value + 1);
                        }
                      }}
                      onOpenLogin={async (accountId) => {
                        if (mode !== "live" || api.openChannelAccountLogin === undefined) {
                          throw new Error("当前模式不支持平台账号登录入口");
                        }
                        return api.openChannelAccountLogin(accountId);
                      }}
                      onOpenVerification={async (accountId) => {
                        if (mode !== "live" || api.openChannelAccountVerification === undefined) {
                          throw new Error("当前模式不支持平台账号安全验证入口");
                        }
                        return api.openChannelAccountVerification(accountId);
                      }}
                      onRefreshStatus={async (accountId) => {
                        if (mode !== "live" || api.refreshChannelAccountStatus === undefined)
                          return;
                        return api.refreshChannelAccountStatus(accountId);
                      }}
                      onForceCalibrate={async (accountId) => {
                        if (mode !== "live" || api.forceCalibrateCtripAccountStatus === undefined) {
                          throw new Error("当前模式不支持人工强制校准");
                        }
                        await api.forceCalibrateCtripAccountStatus(accountId);
                        setRefreshVersion((value) => value + 1);
                      }}
                      onDelete={async (accountId) => {
                        if (mode !== "live" || api.deleteChannelAccount === undefined) {
                          throw new Error("当前模式不支持删除真实账号");
                        }
                        const deletionTenantId = session?.tenant.id;
                        if (deletionTenantId === undefined) {
                          throw new Error("当前会话没有可归档账号的租户作用域");
                        }
                        await api.deleteChannelAccount(accountId);
                        const archivedForTenant = new Set([
                          ...(archivedChannelAccountIdsByTenantRef.current.get(deletionTenantId) ??
                            []),
                          accountId,
                        ]);
                        const archivedByTenant = new Map(
                          archivedChannelAccountIdsByTenantRef.current,
                        );
                        archivedByTenant.set(deletionTenantId, archivedForTenant);
                        archivedChannelAccountIdsByTenantRef.current = archivedByTenant;
                        if (dashboardTenantIdRef.current === deletionTenantId) {
                          setDashboard((current) =>
                            filterArchivedAccounts(current, archivedForTenant),
                          );
                        }
                      }}
                      onChanged={() => setRefreshVersion((value) => value + 1)}
                    />
                    {mode === "live" ? (
                      <SourceCaption endpoint="GET/POST/DELETE/PATCH /api/channel-accounts" />
                    ) : null}
                  </div>
                </ModuleAccessBoundary>
              }
            />
            <Route
              path="/publishing"
              element={
                <ModuleAccessBoundary
                  allowed={canUsePriorityDistribution}
                  fallbackPath={firstAvailablePath}
                >
                  <PublishingView
                    mode={mode}
                    api={api}
                    tenantId={currentTenantId}
                    actorId={session?.actor.id ?? null}
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
                    onChanged={() => setRefreshVersion((version) => version + 1)}
                  />
                </ModuleAccessBoundary>
              }
            />
            <Route
              path="/automation"
              element={
                <ModuleAccessBoundary
                  allowed={canUseAgentAutomation}
                  fallbackPath={firstAvailablePath}
                >
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
                </ModuleAccessBoundary>
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
                  canExport={
                    canUsePriorityDistribution &&
                    (session?.actor.capabilities.includes("publish:request") ?? false)
                  }
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsView
                  mode={mode}
                  api={api}
                  channelAccounts={
                    mode === "demo"
                      ? demoTenant === undefined
                        ? []
                        : demoChannelAccountsForTenant(demoTenant)
                      : dashboard.channelAccounts.data
                  }
                  accounts={accountRows}
                  campaigns={campaignRows}
                  resource={dashboard.channelAccounts}
                  automation={dashboard.automation}
                  canManageAutomation={
                    mode === "demo" ||
                    (session?.actor.capabilities.includes("automation:manage") ?? false)
                  }
                  canManageTenant={
                    mode === "demo" ||
                    (session?.actor.capabilities.includes("tenant:manage") ?? false)
                  }
                  showPriorityDistribution={canUsePriorityDistribution}
                  showAgentAutomation={canUseAgentAutomation}
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
      {newCampaignOpen && canUseAiContent ? (
        <NewCampaignDialog
          key={currentTenantId}
          mode={mode}
          brandOptions={brandOptions}
          canCreate={canCreateCampaign}
          defaultIndustry={defaultCampaignIndustry}
          api={api}
          onClose={() => setNewCampaignOpen(false)}
          onCreate={async (value) => {
            if (mode === "demo") {
              setDemoCampaigns((items) => [
                {
                  id: `cmp-${Date.now()}`,
                  name: value.name,
                  topic: value.topic,
                  industry: value.industry,
                  mode: "影子模式",
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
              promptTemplate: value.promptTemplate,
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
