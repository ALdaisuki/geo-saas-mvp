import {
  AlertTriangle,
  Ban,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  ExternalLink,
  FileText,
  Flag,
  LoaderCircle,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";

import {
  ARTICLE_TEMPLATES,
  AUTOMATION_BATCH_DRY_RUN_MAX_SLOTS,
  AUTOMATION_BATCH_UNATTENDED_MAX_FINAL_TARGETS,
  articleTemplatesForPlatforms,
  type ArticleTemplate,
  type ArticleTemplatePlatform,
} from "@geo/contracts";

import {
  type AutomationBatch,
  type AutomationBatchState,
  type AutomationManualRemediationAction,
  type AutomationPlatform,
  type AutomationRun,
  type AutomationRunState,
  type AutomationRunTargetState,
  type AutomationSnapshot,
  type CampaignAutomationPlan,
  type Campaign,
  type CampaignStatus,
  type CampaignTransitionInput,
  type ChannelAccount,
  GeoApiError,
  type GeoApi,
} from "./api.js";
import {
  formatAutomationDateTime,
  localAutomationDateTime,
  parseAutomationDateTime,
} from "./automation-clock.js";
import { operationStatusLabel } from "./operation-labels.js";
import { useModalDialog } from "./use-modal-dialog.js";
import { circuitBlocksAccount } from "./automation-circuit.js";

interface SlotDraft {
  readonly slotKey: string;
  readonly scheduledFor: string;
  readonly topicKey: string;
  readonly brief: string;
  readonly channelAccountIds: readonly string[];
}

interface FeedbackState {
  readonly tone: "success" | "error";
  readonly text: string;
}

interface CampaignTransitionIntent {
  readonly campaign: Campaign;
  readonly targetStatus: CampaignTransitionInput["status"];
}

interface CampaignPromptTemplateIntent {
  readonly campaign: Campaign;
}

type SchedulableExecutionLevel = "dry_run" | "assisted" | "unattended";
type AutomationPlanExecutionLevel = Exclude<SchedulableExecutionLevel, "assisted">;

interface AutomationRemediationSummary {
  readonly taskId: string;
  readonly mode: "automatic" | "manual";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reasonCodes: readonly string[];
  readonly actions: readonly string[];
}

export interface AutomationOperationsProps {
  readonly api: GeoApi;
  readonly tenantId: string;
  readonly campaigns: readonly Campaign[];
  readonly accounts: readonly ChannelAccount[];
  readonly templates?: readonly ArticleTemplate[];
  readonly automation?: AutomationSnapshot | null;
  readonly capabilities: readonly string[];
  readonly onChanged?: () => void;
  readonly onCampaignsRead?: (campaigns: readonly Campaign[]) => void;
}

const AUTOMATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CANCELLABLE_BATCH_STATES: readonly AutomationBatchState[] = ["scheduled", "running"];
const BATCH_PREVIEW_LIMIT = 5;
const RUN_PREVIEW_LIMIT = 5;
const DEFAULT_BATCH_SLOT_COUNT = 30;
const DEFAULT_PLAN_INTERVAL_MINUTES = 15;
const DEFAULT_PLAN_DAILY_TIMES = "09:00,14:00,20:00";
const DEFAULT_PLAN_TIMEZONE = "Asia/Shanghai";
const SCHEDULE_MINIMUM_LEAD_MINUTES = 2;
const SCHEDULE_MAXIMUM_DAYS = 90;
const AUTOMATION_REFRESH_VISIBLE_MS = 2_000;
const AUTOMATION_REFRESH_HIDDEN_MS = 15_000;
const ALL_AUTOMATION_PLATFORMS: readonly AutomationPlatform[] = [
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
  "zhihu",
];

function nonce(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function localDateTime(minutesFromNow = 5): string {
  return localAutomationDateTime(minutesFromNow);
}

function generatedBrief(campaign: Campaign): string {
  return `依据推广计划主题“${campaign.topicKey}”与目标“${campaign.objective}”创作原创文章；保持受众、事实和推广目标一致，文章模板、读者切入、正文结构和行动引导由服务端按槽位绑定。`;
}

function generatedTopicKey(campaign: Campaign): string {
  const normalized = campaign.topicKey
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized === "" ? `campaign-${campaign.id}` : normalized;
}

function generatedSlots(
  campaign: Campaign | undefined,
  count: number,
  startAt: string,
  intervalMinutes: number,
  maxSlots: number,
): readonly SlotDraft[] {
  if (campaign === undefined || count < 1 || count > maxSlots) return [];
  const startTimestamp = parseAutomationDateTime(startAt);
  if (!Number.isFinite(startTimestamp)) return [];
  return Array.from({ length: count }, (_, offset) => ({
    slotKey: `slot-${String(offset + 1).padStart(3, "0")}`,
    scheduledFor: new Date(startTimestamp + offset * intervalMinutes * 60_000).toISOString(),
    topicKey: generatedTopicKey(campaign),
    brief: generatedBrief(campaign),
    channelAccountIds: [],
  }));
}

function newBatchKey(tenantId: string): string {
  return `web-automation:${tenantId}:${nonce()}`;
}

function formatDateTime(value: string | null): string {
  return formatAutomationDateTime(value);
}

function shortId(value: string | null): string {
  if (value === null) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function apiError(error: unknown): string {
  if (error instanceof GeoApiError) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    const details = error.details ?? {};
    const reason = typeof details.reason === "string" ? details.reason : null;
    const rejectionCodes = Array.isArray(details.rejectionCodes)
      ? details.rejectionCodes
          .filter((value): value is string => typeof value === "string")
          .slice(0, 6)
      : [];
    const diagnostic =
      reason === null && rejectionCodes.length === 0
        ? ""
        : ` · ${reason ?? `rejections=${rejectionCodes.join(",")}`}`;
    return `${error.code}: ${error.message}${diagnostic}${request}`;
  }
  return error instanceof Error ? error.message : "未知自动化操作错误";
}

function platformLabel(platform: string): string {
  return (
    {
      toutiao: "头条号",
      sohu: "搜狐号",
      baijiahao: "百家号",
      netease: "网易号",
      ctrip_community: "携程社区",
      zhihu: "知乎",
    }[platform] ?? platform
  );
}

function isAccountEligibleForExecutionLevel(
  account: ChannelAccount,
  level: SchedulableExecutionLevel,
  automation: AutomationSnapshot | null,
): boolean {
  if (account.status !== "active" || !account.supportedExecutionLevels.includes(level)) {
    return false;
  }
  if (
    (level === "assisted" || level === "unattended") &&
    account.capability !== "browser_assisted"
  ) {
    return false;
  }
  if (automation === null) return true;

  const control = automation.controls.find(
    (candidate) => candidate.scopeType === "account" && candidate.scopeKey === account.id,
  );
  if (control === undefined) return false;
  if (control.killSwitchEnabled || control.mode === "paused" || control.mode === "stopped") {
    return false;
  }

  const circuit = automation.circuits.find(
    (candidate) => candidate.scopeType === "account" && candidate.scopeKey === account.id,
  );
  if (circuitBlocksAccount(circuit)) {
    return false;
  }

  if (level === "unattended") {
    const sessionState = account.ctripRuntime?.sessionState;
    return (
      control.mode === "unattended" &&
      (sessionState === "authenticated" ||
        sessionState === "ready" ||
        sessionState === "challenge_required")
    );
  }
  return true;
}

function eligibleAccountCountLabel(count: number, level: SchedulableExecutionLevel): string {
  const modeLabel = level === "dry_run" ? "Dry-run" : "无人值守";
  return `${count} 个 ${modeLabel} 可用账号`;
}

function executionLevelLabel(level: SchedulableExecutionLevel | "assisted"): string {
  return {
    dry_run: "演练",
    assisted: "人工协作",
    unattended: "无人值守",
  }[level];
}

function batchStateLabel(
  state: AutomationBatchState,
  executionLevel: AutomationBatch["executionLevel"] = "dry_run",
  failedRunCount = 0,
  deliveryFailedRunCount = 0,
): string {
  if (state === "partially_failed" && failedRunCount === 0 && deliveryFailedRunCount > 0) {
    return "投放失败";
  }
  return {
    scheduled: "待执行",
    running: "运行中",
    completed: executionLevel === "dry_run" ? "预演完成" : "已完成",
    partially_failed: "部分失败",
    delivery_failed: "投放失败",
    cancelled: "已取消",
  }[state];
}

function runStateLabel(
  state: AutomationRunState,
  executionLevel: AutomationRun["executionLevel"] = "dry_run",
): string {
  return {
    scheduled: "待执行",
    running: "运行中",
    retry_wait: "等待重试",
    awaiting_manual_review: "等待人工配图确认",
    awaiting_delivery: executionLevel === "dry_run" ? "等待演练预演" : "等待平台处理",
    completed: executionLevel === "dry_run" ? "预演完成" : "已完成",
    partially_failed: "部分失败",
    delivery_failed: "投放失败",
    blocked: "治理阻断",
    failed: "运行失败",
    cancelled: "已取消",
  }[state];
}

function targetStateLabel(
  state: AutomationRunTargetState,
  executionLevel: AutomationRun["executionLevel"] = "dry_run",
): string {
  return {
    pending: "待处理",
    variant_ready: "平台变体就绪",
    audit_failed: "发布前审计未通过",
    awaiting_manual_review: "等待内容版本确认",
    awaiting_delivery: executionLevel === "dry_run" ? "等待演练预演" : "等待发布",
    submitted_pending_review: "已提交，待平台审核",
    publisher_rejected: "平台审核未通过",
    preview_completed: "演练预演完成",
    confirmed: "平台已发布",
    delivery_failed: "投放失败",
    blocked: "治理阻断",
    failed: "运行失败",
    cancelled: "已取消",
  }[state];
}

function remediationForTarget(
  raw: Readonly<Record<string, unknown>> | null,
): AutomationRemediationSummary | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Readonly<Record<string, unknown>>;
  const taskId = typeof value.taskId === "string" ? value.taskId : "";
  const mode = value.mode === "manual" ? "manual" : "automatic";
  const attempt = typeof value.attempt === "number" ? value.attempt : 0;
  const maxAttempts = typeof value.maxAttempts === "number" ? value.maxAttempts : 0;
  const reasonCodes = Array.isArray(value.reasonCodes)
    ? value.reasonCodes.filter((item): item is string => typeof item === "string")
    : [];
  const actions = Array.isArray(value.actions)
    ? value.actions.filter((item): item is string => typeof item === "string")
    : [];
  if (taskId.length === 0 || attempt < 1 || maxAttempts < attempt || reasonCodes.length === 0) {
    return null;
  }
  return { taskId, mode, attempt, maxAttempts, reasonCodes, actions };
}

function stateTone(state: AutomationBatchState | AutomationRunState | AutomationRunTargetState) {
  if (["completed", "preview_completed", "variant_ready", "confirmed"].includes(state)) {
    return "success";
  }
  if (
    [
      "partially_failed",
      "retry_wait",
      "awaiting_manual_review",
      "awaiting_delivery",
      "submitted_pending_review",
      "audit_failed",
    ].includes(state)
  ) {
    return "warning";
  }
  if (["failed", "delivery_failed", "publisher_rejected", "blocked", "cancelled"].includes(state)) {
    return "danger";
  }
  return "neutral";
}

function stageLabel(
  stage: AutomationRun["stage"],
  executionLevel: AutomationRun["executionLevel"] = "dry_run",
): string {
  return {
    planning: "计划",
    draft: "草稿",
    targets: "平台变体 / 审计",
    delivery: executionLevel === "dry_run" ? "演练预演" : "平台交付",
  }[stage];
}

function campaignStatusLabel(status: CampaignStatus): string {
  return {
    draft: "草稿",
    active: "已激活",
    paused: "已暂停",
    completed: "已完成（终态）",
  }[status];
}

function campaignStatusTone(status: CampaignStatus): string {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

function campaignTargets(status: CampaignStatus): readonly CampaignTransitionInput["status"][] {
  if (status === "draft") return ["active"];
  if (status === "active") return ["paused", "completed"];
  if (status === "paused") return ["active", "completed"];
  return [];
}

function transitionLabel(status: CampaignTransitionInput["status"]): string {
  return { active: "激活", paused: "暂停", completed: "完成" }[status];
}

function transitionDescription(status: CampaignTransitionInput["status"]): string {
  return {
    active: "激活后，该推广计划才能创建和执行自动化批次。",
    paused: "暂停后，新运行不会被后台生产器认领；已有审计和预演记录继续保留。",
    completed: "完成是不可逆终态；该推广计划之后不能重新激活或创建新批次。",
  }[status];
}

function Feedback({ value }: { readonly value: FeedbackState | null }) {
  if (value === null) return null;
  return (
    <div
      className={`ops-notice ${value.tone === "error" ? "ops-notice-danger" : "ops-notice-info"}`}
      role={value.tone === "error" ? "alert" : "status"}
    >
      {value.tone === "error" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
      <span>{value.text}</span>
    </div>
  );
}

export function AutomationOperations({
  api,
  tenantId,
  campaigns,
  accounts,
  templates = ARTICLE_TEMPLATES,
  automation = null,
  capabilities,
  onChanged,
  onCampaignsRead,
}: AutomationOperationsProps) {
  const scopeRef = useRef(tenantId);
  const apiRef = useRef(api);
  const detailRequestRef = useRef(0);
  const selectedBatchIdRef = useRef<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const autoRefreshInFlightRef = useRef(false);
  const operationBusyRef = useRef(true);
  const activeCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.status === "active"),
    [campaigns],
  );
  const [executionLevel, setExecutionLevel] = useState<SchedulableExecutionLevel>("unattended");
  const eligibleAccounts = useMemo(
    () =>
      accounts.filter((account) =>
        isAccountEligibleForExecutionLevel(account, executionLevel, automation),
      ),
    [accounts, automation, executionLevel],
  );
  const eligiblePlatforms = useMemo(
    () =>
      Array.from(new Set(eligibleAccounts.map((account) => account.platform))).sort((left, right) =>
        platformLabel(left).localeCompare(platformLabel(right), "zh-CN"),
      ),
    [eligibleAccounts],
  );
  const canManage = capabilities.includes("automation:manage");
  const canWriteCampaign = capabilities.includes("content:write");
  const [campaignId, setCampaignId] = useState("");
  const [batchName, setBatchName] = useState("");
  const [slotCount, setSlotCount] = useState(DEFAULT_BATCH_SLOT_COUNT);
  const [startAt, setStartAt] = useState(() => localDateTime());
  const [scheduleMinimumAt, setScheduleMinimumAt] = useState(() =>
    localDateTime(SCHEDULE_MINIMUM_LEAD_MINUTES),
  );
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [selectedPlatforms, setSelectedPlatforms] = useState<readonly AutomationPlatform[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newBatchKey(tenantId));
  const [batches, setBatches] = useState<readonly AutomationBatch[]>([]);
  const [runs, setRuns] = useState<readonly AutomationRun[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [batchListLimit, setBatchListLimit] = useState(BATCH_PREVIEW_LIMIT);
  const [runListLimit, setRunListLimit] = useState(RUN_PREVIEW_LIMIT);
  const [runDetail, setRunDetail] = useState<AutomationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [automationPlan, setAutomationPlan] = useState<CampaignAutomationPlan | null>(null);
  const [planEnabled, setPlanEnabled] = useState(false);
  const [planExecutionLevel, setPlanExecutionLevel] =
    useState<AutomationPlanExecutionLevel>("unattended");
  const [planPlatforms, setPlanPlatforms] = useState<readonly AutomationPlatform[]>([]);
  const [planSlotCount, setPlanSlotCount] = useState(DEFAULT_BATCH_SLOT_COUNT);
  const [planIntervalMinutes, setPlanIntervalMinutes] = useState(DEFAULT_PLAN_INTERVAL_MINUTES);
  const [planDailyTimes, setPlanDailyTimes] = useState(DEFAULT_PLAN_DAILY_TIMES);
  const [planTimezone, setPlanTimezone] = useState(DEFAULT_PLAN_TIMEZONE);
  const [planLoading, setPlanLoading] = useState(false);
  const [planDraftTouched, setPlanDraftTouched] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planRunning, setPlanRunning] = useState(false);
  const [planFeedback, setPlanFeedback] = useState<FeedbackState | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [campaignFeedback, setCampaignFeedback] = useState<FeedbackState | null>(null);
  const [transitionIntent, setTransitionIntent] = useState<CampaignTransitionIntent | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [transitionPending, setTransitionPending] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [remediationCampaignId, setRemediationCampaignId] = useState<string | null>(null);
  const [promptTemplateIntent, setPromptTemplateIntent] =
    useState<CampaignPromptTemplateIntent | null>(null);
  const promptTemplateDialogRef = useModalDialog<HTMLDivElement>(
    promptTemplateIntent === null ? null : () => setPromptTemplateIntent(null),
    promptTemplateIntent !== null,
  );
  const transitionDialogRef = useModalDialog<HTMLDivElement>(
    transitionIntent === null || transitionPending ? null : () => setTransitionIntent(null),
    transitionIntent !== null,
  );
  const [assignmentSelections, setAssignmentSelections] = useState<Record<string, string>>({});
  const [reassigningTargetId, setReassigningTargetId] = useState<string | null>(null);
  const [manualRemediationSelections, setManualRemediationSelections] = useState<
    Record<string, readonly AutomationManualRemediationAction[]>
  >({});
  const [manualRemediatingTargetId, setManualRemediatingTargetId] = useState<string | null>(null);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  useEffect(() => {
    selectedBatchIdRef.current = selectedBatchId;
    selectedRunIdRef.current = selectedRunId;
    operationBusyRef.current =
      loading ||
      detailLoading ||
      creating ||
      cancelling ||
      planLoading ||
      planSaving ||
      planRunning ||
      transitionPending ||
      remediationCampaignId !== null ||
      reassigningTargetId !== null ||
      manualRemediatingTargetId !== null;
  }, [
    cancelling,
    creating,
    detailLoading,
    loading,
    manualRemediatingTargetId,
    planLoading,
    planRunning,
    planSaving,
    reassigningTargetId,
    remediationCampaignId,
    selectedBatchId,
    selectedRunId,
    transitionPending,
  ]);

  const selectedCampaign = activeCampaigns.find((campaign) => campaign.id === campaignId);
  const planEligibleAccounts = useMemo(
    () =>
      accounts.filter((account) =>
        isAccountEligibleForExecutionLevel(account, planExecutionLevel, automation),
      ),
    [accounts, automation, planExecutionLevel],
  );
  const planAccountsByPlatform = useMemo(
    () =>
      new Map(
        ALL_AUTOMATION_PLATFORMS.map((platform) => [
          platform,
          planEligibleAccounts.filter((account) => account.platform === platform),
        ]),
      ),
    [planEligibleAccounts],
  );
  const planStatus =
    campaignId === ""
      ? { label: "无可用计划", tone: "neutral" }
      : planLoading
        ? { label: "读取中", tone: "info" }
        : planDraftTouched
          ? { label: "未保存更改", tone: "warning" }
          : automationPlan === null
            ? { label: "未配置", tone: "neutral" }
            : automationPlan.enabled
              ? { label: "已启用", tone: "success" }
              : { label: "已停用", tone: "neutral" };
  const unavailableSelectedPlatforms = useMemo(
    () => selectedPlatforms.filter((platform) => !eligiblePlatforms.includes(platform)),
    [eligiblePlatforms, selectedPlatforms],
  );
  const compatibleTemplates = useMemo(
    () => articleTemplatesForPlatforms(selectedPlatforms, templates),
    [selectedPlatforms, templates],
  );
  const finalTargetsPerSlot = Math.max(selectedPlatforms.length, 1);
  const maxSlotCount =
    executionLevel === "dry_run"
      ? AUTOMATION_BATCH_DRY_RUN_MAX_SLOTS
      : Math.floor(AUTOMATION_BATCH_UNATTENDED_MAX_FINAL_TARGETS / finalTargetsPerSlot);
  const finalTargetCount = slotCount * finalTargetsPerSlot;
  const slots = useMemo(
    () => generatedSlots(selectedCampaign, slotCount, startAt, intervalMinutes, maxSlotCount),
    [selectedCampaign, slotCount, startAt, intervalMinutes, maxSlotCount],
  );
  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const selectedBatchRuns = runs.filter((run) => run.batchId === selectedBatchId);
  const selectedRunIndex = selectedBatchRuns.findIndex((run) => run.id === selectedRunId);
  const visibleRuns =
    runListLimit >= selectedBatchRuns.length
      ? selectedBatchRuns
      : selectedRunIndex >= runListLimit
        ? [
            ...selectedBatchRuns.slice(0, runListLimit),
            selectedBatchRuns[selectedRunIndex] as AutomationRun,
          ]
        : selectedBatchRuns.slice(0, runListLimit);
  const hiddenRunCount = selectedBatchRuns.length - visibleRuns.length;
  const runExpandStep = Math.min(4, hiddenRunCount);
  const selectedBatchIndex = batches.findIndex((batch) => batch.id === selectedBatchId);
  const visibleBatches =
    batchListLimit >= batches.length
      ? batches
      : selectedBatchIndex >= batchListLimit
        ? [...batches.slice(0, batchListLimit), batches[selectedBatchIndex] as AutomationBatch]
        : batches.slice(0, batchListLimit);
  const hiddenBatchCount = batches.length - visibleBatches.length;
  const expandStep = Math.min(4, hiddenBatchCount);

  useEffect(() => {
    if (activeCampaigns.some((campaign) => campaign.id === campaignId)) return;
    const first = activeCampaigns[0];
    setCampaignId(first?.id ?? "");
  }, [activeCampaigns, campaignId]);

  useEffect(() => {
    let active = true;
    setAutomationPlan(null);
    setPlanFeedback(null);
    setPlanEnabled(false);
    setPlanExecutionLevel("unattended");
    setPlanPlatforms([]);
    setPlanSlotCount(DEFAULT_BATCH_SLOT_COUNT);
    setPlanIntervalMinutes(DEFAULT_PLAN_INTERVAL_MINUTES);
    setPlanDailyTimes(DEFAULT_PLAN_DAILY_TIMES);
    setPlanTimezone(DEFAULT_PLAN_TIMEZONE);
    setPlanDraftTouched(false);
    setPlanLoading(false);
    if (!canManage || campaignId === "") {
      return;
    }
    setPlanLoading(true);
    const scopedApi = apiRef.current;
    void scopedApi
      .getCampaignAutomationPlan(campaignId)
      .then((plan) => {
        if (!active) return;
        setAutomationPlan(plan);
        if (plan !== null) {
          setPlanEnabled(plan.enabled);
          setPlanExecutionLevel(plan.executionLevel);
          setPlanPlatforms(plan.platforms);
          setPlanSlotCount(plan.slotCount);
          setPlanIntervalMinutes(plan.intervalMinutes);
          setPlanDailyTimes(plan.dailyTimes.join(","));
          setPlanTimezone(plan.timezone);
        }
      })
      .catch((error: unknown) => {
        if (active) setPlanFeedback({ tone: "error", text: apiError(error) });
      })
      .finally(() => {
        if (active) setPlanLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaignId, canManage, tenantId]);

  useEffect(() => {
    setSelectedPlatforms((current) => {
      const fallback = eligiblePlatforms[0] as AutomationPlatform | undefined;
      // Polling may briefly return an incomplete account snapshot. Preserve an
      // operator's intended platform set and block submission until it recovers.
      return current.length > 0 ? current : fallback === undefined ? [] : [fallback];
    });
  }, [eligiblePlatforms, selectedPlatforms.length]);

  useEffect(() => {
    setSlotCount((current) => Math.min(current, maxSlotCount));
  }, [maxSlotCount]);

  useEffect(() => {
    scopeRef.current = tenantId;
    detailRequestRef.current += 1;
    const scopedApi = apiRef.current;
    const firstCampaign = activeCampaigns[0];
    setExecutionLevel("unattended");
    setCampaignId(firstCampaign?.id ?? "");
    setBatchName("");
    setSlotCount(DEFAULT_BATCH_SLOT_COUNT);
    setStartAt(localDateTime());
    setScheduleMinimumAt(localDateTime(SCHEDULE_MINIMUM_LEAD_MINUTES));
    setIntervalMinutes(15);
    setSelectedPlatforms([]);
    setIdempotencyKey(newBatchKey(tenantId));
    setBatches([]);
    setRuns([]);
    setSelectedBatchId(null);
    setSelectedRunId(null);
    setBatchListLimit(BATCH_PREVIEW_LIMIT);
    setRunDetail(null);
    setCancelReason("");
    setFeedback(null);
    setCampaignFeedback(null);
    setTransitionIntent(null);
    setTransitionReason("");
    setTransitionError(null);
    setAssignmentSelections({});
    setReassigningTargetId(null);
    setManualRemediationSelections({});
    setManualRemediatingTargetId(null);
    setLoading(true);
    let active = true;
    void scopedApi
      .getAutomationBatches()
      .then(async (nextBatches) => {
        if (!active || scopeRef.current !== tenantId) return;
        setBatches(nextBatches);
        const firstBatch = nextBatches[0];
        if (firstBatch === undefined) {
          setRuns([]);
          return;
        }
        const nextRuns = await scopedApi.getAutomationRuns(firstBatch.id);
        if (!active || scopeRef.current !== tenantId) return;
        setRuns(nextRuns);
        setSelectedBatchId(firstBatch.id);
        const firstRun = nextRuns.find((run) => run.batchId === firstBatch.id);
        if (firstRun === undefined) return;
        const request = ++detailRequestRef.current;
        setSelectedRunId(firstRun.id);
        setDetailLoading(true);
        const detail = await scopedApi.getAutomationRun(firstRun.id);
        if (!active || scopeRef.current !== tenantId || request !== detailRequestRef.current) {
          return;
        }
        if (detail.id !== firstRun.id || detail.batchId !== firstBatch.id) {
          throw new TypeError("自动化运行详情与列表范围不一致");
        }
        setRunDetail(detail);
      })
      .catch((error: unknown) => {
        if (active && scopeRef.current === tenantId) {
          setFeedback({ tone: "error", text: apiError(error) });
        }
      })
      .finally(() => {
        if (active && scopeRef.current === tenantId) {
          setLoading(false);
          setDetailLoading(false);
        }
      });
    return () => {
      active = false;
      if (scopeRef.current === tenantId) scopeRef.current = "";
    };
  }, [tenantId]);

  function rotateDraftKey(): void {
    setIdempotencyKey(newBatchKey(tenantId));
  }

  async function loadRun(
    runId: string,
    expectedBatchId: string,
    options: { readonly background?: boolean } = {},
  ): Promise<void> {
    const scope = tenantId;
    const request = ++detailRequestRef.current;
    setSelectedRunId(runId);
    if (options.background !== true) {
      setRunDetail(null);
      setDetailLoading(true);
      setFeedback(null);
    }
    try {
      const detail = await apiRef.current.getAutomationRun(runId);
      if (scopeRef.current !== scope || request !== detailRequestRef.current) return;
      if (detail.id !== runId || detail.batchId !== expectedBatchId) {
        throw new TypeError("自动化运行详情与请求范围不一致");
      }
      setRunDetail(detail);
    } catch (error) {
      if (
        options.background !== true &&
        scopeRef.current === scope &&
        request === detailRequestRef.current
      ) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (
        options.background !== true &&
        scopeRef.current === scope &&
        request === detailRequestRef.current
      ) {
        setDetailLoading(false);
      }
    }
  }

  async function refresh(
    preferredBatchId: string | null = selectedBatchId,
    preferredRunId: string | null = selectedRunId,
    options: { readonly background?: boolean } = {},
  ): Promise<void> {
    const scope = tenantId;
    const scopedApi = apiRef.current;
    const nextBatches = await scopedApi.getAutomationBatches();
    if (scopeRef.current !== scope) return;
    if (preferredBatchId !== null && !nextBatches.some((batch) => batch.id === preferredBatchId)) {
      throw new TypeError("请求的自动化批次未出现在持久化回读中");
    }
    const nextBatchId =
      preferredBatchId !== null && nextBatches.some((batch) => batch.id === preferredBatchId)
        ? preferredBatchId
        : (nextBatches[0]?.id ?? null);
    setSelectedBatchId(nextBatchId);
    if (options.background !== true) setCancelReason("");
    if (nextBatchId === null) {
      setBatches(nextBatches);
      setRuns([]);
      setSelectedRunId(null);
      setRunDetail(null);
      return;
    }
    const nextRuns = await scopedApi.getAutomationRuns(nextBatchId);
    if (scopeRef.current !== scope) return;
    setBatches(nextBatches);
    setRuns(nextRuns);
    const nextRun =
      (preferredRunId === null
        ? undefined
        : nextRuns.find((run) => run.id === preferredRunId && run.batchId === nextBatchId)) ??
      nextRuns.find((run) => run.batchId === nextBatchId);
    if (nextRun === undefined) {
      setSelectedRunId(null);
      setRunDetail(null);
      return;
    }
    await loadRun(nextRun.id, nextBatchId, options);
  }

  async function reload(): Promise<void> {
    setLoading(true);
    setFeedback(null);
    try {
      await refresh();
    } catch (error) {
      if (scopeRef.current === tenantId) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === tenantId) setLoading(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const visibilityState = () => globalThis.document?.visibilityState ?? "visible";
    const schedule = () => {
      if (disposed) return;
      timeoutId = setTimeout(
        () => void tick(),
        visibilityState() === "hidden"
          ? AUTOMATION_REFRESH_HIDDEN_MS
          : AUTOMATION_REFRESH_VISIBLE_MS,
      );
    };
    const tick = async () => {
      if (disposed) return;
      if (operationBusyRef.current || autoRefreshInFlightRef.current) {
        schedule();
        return;
      }
      autoRefreshInFlightRef.current = true;
      try {
        await refresh(selectedBatchIdRef.current, selectedRunIdRef.current, { background: true });
      } catch {
        // Manual refresh remains the visible recovery path for transient polling failures.
      } finally {
        autoRefreshInFlightRef.current = false;
        schedule();
      }
    };
    const handleVisibilityChange = () => {
      if (visibilityState() !== "visible" || disposed) return;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
      void tick();
    };

    globalThis.document?.addEventListener("visibilitychange", handleVisibilityChange);
    schedule();
    return () => {
      disposed = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      globalThis.document?.removeEventListener("visibilitychange", handleVisibilityChange);
      autoRefreshInFlightRef.current = false;
    };
  }, [tenantId]);

  async function selectBatch(batchId: string): Promise<void> {
    detailRequestRef.current += 1;
    setSelectedBatchId(batchId);
    setRunListLimit(RUN_PREVIEW_LIMIT);
    setCancelReason("");
    setRunDetail(null);
    const nextRuns = await api.getAutomationRuns(batchId);
    if (scopeRef.current !== tenantId) return;
    setRuns(nextRuns);
    const firstRun = nextRuns.find((run) => run.batchId === batchId);
    if (firstRun === undefined) {
      setSelectedRunId(null);
      return;
    }
    await loadRun(firstRun.id, batchId);
  }

  function validatedItems(effectiveStartAt = startAt) {
    const effectiveSlots = generatedSlots(
      selectedCampaign,
      slotCount,
      effectiveStartAt,
      intervalMinutes,
      maxSlotCount,
    );
    if (
      !Number.isInteger(slotCount) ||
      slotCount < 1 ||
      slotCount > maxSlotCount ||
      effectiveSlots.length !== slotCount
    ) {
      throw new TypeError(`批次必须包含 1–${maxSlotCount} 个内容槽位`);
    }
    if (
      !Number.isFinite(intervalMinutes) ||
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 1_440
    ) {
      throw new TypeError("间隔必须为 1–1440 分钟");
    }
    const startTimestamp = parseAutomationDateTime(effectiveStartAt);
    if (!Number.isFinite(startTimestamp)) {
      throw new TypeError("首篇计划时间无效");
    }
    const minimumStart = Date.now() + SCHEDULE_MINIMUM_LEAD_MINUTES * 60_000;
    const maximumEnd = Date.now() + SCHEDULE_MAXIMUM_DAYS * 24 * 60 * 60_000;
    const finalTimestamp = startTimestamp + Math.max(slotCount - 1, 0) * intervalMinutes * 60_000;
    if (startTimestamp < minimumStart - 1_000) {
      throw new TypeError(`首篇计划时间至少需要提前 ${SCHEDULE_MINIMUM_LEAD_MINUTES} 分钟`);
    }
    if (finalTimestamp > maximumEnd) {
      throw new TypeError(`最后一个槽位必须安排在未来 ${SCHEDULE_MAXIMUM_DAYS} 天内`);
    }
    if (selectedPlatforms.length === 0) {
      throw new TypeError(`请至少选择一个支持 ${executionLevelLabel(executionLevel)} 的平台`);
    }
    if (unavailableSelectedPlatforms.length > 0) {
      throw new TypeError(
        `选定平台暂不可用：${unavailableSelectedPlatforms.map(platformLabel).join("、")}`,
      );
    }
    if (compatibleTemplates.length === 0) {
      throw new TypeError("选定平台没有共同允许的文章模板");
    }
    const slotKeys = new Set<string>();
    return effectiveSlots.map((slot, index) => {
      const slotKey = slot.slotKey.trim();
      const topicKey = slot.topicKey.trim();
      const brief = slot.brief.trim();
      if (!AUTOMATION_KEY.test(slotKey) || slotKey.length > 200) {
        throw new TypeError(`槽位 ${index + 1} 的槽位标识格式无效`);
      }
      if (slotKeys.has(slotKey)) throw new TypeError(`槽位标识重复：${slotKey}`);
      slotKeys.add(slotKey);
      if (!AUTOMATION_KEY.test(topicKey) || topicKey.length > 200) {
        throw new TypeError(`槽位 ${index + 1} 的主题标识格式无效`);
      }
      if (brief.length < 3 || brief.length > 10_000) {
        throw new TypeError(`槽位 ${index + 1} 的创作要求必须为 3–10000 个字符`);
      }
      const scheduledFor = new Date(slot.scheduledFor);
      if (!Number.isFinite(scheduledFor.getTime())) {
        throw new TypeError(`槽位 ${index + 1} 的计划时间无效`);
      }
      return {
        slotKey,
        scheduledFor: scheduledFor.toISOString(),
        topicKey,
        brief,
        channelAccountIds: slot.channelAccountIds,
      };
    });
  }

  async function transitionCampaign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canWriteCampaign || transitionIntent === null) return;
    const reason = transitionReason.trim();
    if (reason.length < 3) {
      setTransitionError("变更原因至少需要 3 个字符");
      return;
    }
    const scope = tenantId;
    const { campaign, targetStatus } = transitionIntent;
    setTransitionPending(true);
    setTransitionError(null);
    setCampaignFeedback(null);
    try {
      const result = await api.transitionCampaignState(campaign.id, {
        status: targetStatus,
        reason,
      });
      if (result.campaign.id !== campaign.id || result.campaign.status !== targetStatus) {
        throw new TypeError("推广计划状态变更响应与请求不一致");
      }
      const nextCampaigns = await api.getCampaigns();
      if (scopeRef.current !== scope) return;
      const persisted = nextCampaigns.find((item) => item.id === campaign.id);
      if (persisted?.status !== targetStatus) {
        throw new TypeError("推广计划状态写入后的列表回读不一致");
      }
      onCampaignsRead?.(nextCampaigns);
      setCampaignFeedback({
        tone: "success",
        text: result.wasChanged
          ? `${campaign.name} 已由${campaignStatusLabel(result.previousStatus)}变更为${campaignStatusLabel(targetStatus)}，并完成列表回读。`
          : `${campaign.name} 已是${campaignStatusLabel(targetStatus)}，服务端确认无需重复变更。`,
      });
      setTransitionIntent(null);
      setTransitionReason("");
    } catch (error) {
      if (scopeRef.current === scope) setTransitionError(apiError(error));
    } finally {
      if (scopeRef.current === scope) setTransitionPending(false);
    }
  }

  async function setCampaignRemediation(campaign: Campaign, enabled: boolean): Promise<void> {
    if (!canWriteCampaign) return;
    const scope = tenantId;
    setRemediationCampaignId(campaign.id);
    setCampaignFeedback(null);
    try {
      const updated = await api.setCampaignAutomationRemediation(campaign.id, enabled);
      if (updated.id !== campaign.id || updated.automationRemediationEnabled !== enabled) {
        throw new TypeError("推广计划整改设置响应与请求不一致");
      }
      const nextCampaigns = await api.getCampaigns();
      if (scopeRef.current !== scope) return;
      const persisted = nextCampaigns.find((item) => item.id === campaign.id);
      if (persisted?.automationRemediationEnabled !== enabled) {
        throw new TypeError("推广计划整改设置回读不一致");
      }
      onCampaignsRead?.(nextCampaigns);
      setCampaignFeedback({
        tone: "success",
        text: enabled
          ? `${campaign.name} 已开启自动整改；新建批次会最多尝试 2 次可自动修复的审计问题。`
          : `${campaign.name} 已关闭自动整改；新建批次遇到审计问题将转入人工处理。`,
      });
    } catch (error) {
      if (scopeRef.current === scope) {
        setCampaignFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope) setRemediationCampaignId(null);
    }
  }

  function planDailyTimeList(): readonly string[] {
    return planDailyTimes
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  async function saveAutomationPlan(): Promise<void> {
    if (!canManage || campaignId === "") return;
    const dailyTimes = planDailyTimeList();
    if (planPlatforms.length === 0) {
      setPlanFeedback({ tone: "error", text: "自动投放至少选择一个平台" });
      return;
    }
    if (
      dailyTimes.length === 0 ||
      dailyTimes.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value))
    ) {
      setPlanFeedback({ tone: "error", text: "每天投放时间需为 HH:mm，多个时间用英文逗号分隔" });
      return;
    }
    if (new Set(dailyTimes).size !== dailyTimes.length) {
      setPlanFeedback({ tone: "error", text: "每天投放时间不能重复" });
      return;
    }
    const scope = tenantId;
    setPlanSaving(true);
    setPlanFeedback(null);
    try {
      const nextPlan = await apiRef.current.saveCampaignAutomationPlan(campaignId, {
        enabled: planEnabled,
        executionLevel: planExecutionLevel,
        platforms: planPlatforms,
        slotCount: planSlotCount,
        intervalMinutes: planIntervalMinutes,
        dailyTimes,
        timezone: planTimezone.trim(),
      });
      if (scopeRef.current !== scope) return;
      setAutomationPlan(nextPlan);
      setPlanEnabled(nextPlan.enabled);
      setPlanPlatforms(nextPlan.platforms);
      setPlanSlotCount(nextPlan.slotCount);
      setPlanIntervalMinutes(nextPlan.intervalMinutes);
      setPlanDailyTimes(nextPlan.dailyTimes.join(","));
      setPlanTimezone(nextPlan.timezone);
      setPlanDraftTouched(false);
      setPlanFeedback({
        tone: "success",
        text: nextPlan.enabled
          ? "自动投放计划已保存并启用，调度器将按每天时间和间隔自动创建批次。"
          : "自动投放计划已保存，当前处于停用状态。",
      });
      onChanged?.();
    } catch (error) {
      if (scopeRef.current === scope) {
        setPlanFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope) setPlanSaving(false);
    }
  }

  async function runAutomationPlan(): Promise<void> {
    if (!canManage || campaignId === "") return;
    const scope = tenantId;
    setPlanRunning(true);
    setPlanFeedback(null);
    try {
      const result = await apiRef.current.runCampaignAutomationPlan(campaignId);
      if (scopeRef.current !== scope) return;
      setAutomationPlan(result.plan);
      await refresh(result.batch.id, null);
      if (scopeRef.current !== scope) return;
      setPlanFeedback({
        tone: "success",
        text: `已按计划默认值创建批次：${result.batch.runCount} 个槽位 × ${result.plan.platforms.length} 个平台。`,
      });
      onChanged?.();
    } catch (error) {
      if (scopeRef.current === scope) {
        setPlanFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope) setPlanRunning(false);
    }
  }

  async function createBatch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage || campaignId === "") return;
    if (selectedPlatforms.length === 0) {
      setFeedback({ tone: "error", text: "请至少选择一个分发平台" });
      return;
    }
    if (unavailableSelectedPlatforms.length > 0) {
      setFeedback({
        tone: "error",
        text: `已选 ${unavailableSelectedPlatforms.map(platformLabel).join("、")} 暂不可用`,
      });
      return;
    }
    if (compatibleTemplates.length === 0) {
      setFeedback({ tone: "error", text: "所选平台没有共同允许的文章模板，无法创建批次" });
      return;
    }
    const scope = tenantId;
    setCreating(true);
    setFeedback(null);
    try {
      const parsedStart = parseAutomationDateTime(startAt);
      const minimumStart = Date.now() + SCHEDULE_MINIMUM_LEAD_MINUTES * 60_000;
      const effectiveStartAt =
        Number.isFinite(parsedStart) && parsedStart >= minimumStart
          ? startAt
          : localDateTime(SCHEDULE_MINIMUM_LEAD_MINUTES);
      if (effectiveStartAt !== startAt) setStartAt(effectiveStartAt);
      const items = validatedItems(effectiveStartAt);
      const trimmedName = batchName.trim();
      const result = await api.createAutomationBatch(campaignId, {
        idempotencyKey,
        ...(trimmedName === "" ? {} : { name: trimmedName }),
        executionLevel,
        distribution:
          selectedPlatforms.length === 1
            ? {
                mode: "platform_round_robin" as const,
                platform: selectedPlatforms[0] as AutomationPlatform,
              }
            : {
                mode: "platforms_round_robin" as const,
                platforms: selectedPlatforms,
              },
        items,
      });
      if (
        result.batch.campaignId !== campaignId ||
        result.batch.executionLevel !== executionLevel
      ) {
        throw new TypeError("新建批次回读与请求的 campaign 或执行级别不一致");
      }
      if (scopeRef.current !== scope) return;
      await refresh(result.batch.id, null);
      if (scopeRef.current !== scope) return;
      setBatchName("");
      setSlotCount(DEFAULT_BATCH_SLOT_COUNT);
      setStartAt(localDateTime());
      setIntervalMinutes(15);
      setIdempotencyKey(newBatchKey(tenantId));
      setFeedback({
        tone: "success",
        text:
          selectedPlatforms.length > 1
            ? `${items.length} 个内容槽位 × ${selectedPlatforms.length} 个平台目标已持久化，平台变体将并行异步生成与分发。`
            : `${items.length} 个槽位已持久化为 ${executionLevelLabel(executionLevel)} 批次并完成回读。`,
      });
      onChanged?.();
    } catch (error) {
      if (scopeRef.current === scope) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope) setCreating(false);
    }
  }

  async function cancelBatch(): Promise<void> {
    if (
      !canManage ||
      selectedBatch === null ||
      !CANCELLABLE_BATCH_STATES.includes(selectedBatch.state)
    ) {
      return;
    }
    const reason = cancelReason.trim();
    if (reason.length < 3) {
      setFeedback({ tone: "error", text: "取消原因至少需要 3 个字符" });
      return;
    }
    const scope = tenantId;
    setCancelling(true);
    setFeedback(null);
    try {
      const result = await api.cancelAutomationBatch(selectedBatch.id, reason);
      if (result.batchId !== selectedBatch.id || result.state !== "cancelled") {
        throw new TypeError("批次取消回读与请求不一致");
      }
      if (scopeRef.current !== scope) return;
      await refresh(selectedBatch.id, selectedRunId);
      if (scopeRef.current !== scope) return;
      setFeedback({
        tone: "success",
        text: `批次已取消；${result.cancelledRuns} 个运行、${result.cancelledTargets} 个目标停止继续处理。`,
      });
      onChanged?.();
    } catch (error) {
      if (scopeRef.current === scope) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope) setCancelling(false);
    }
  }

  function targetCanReassign(
    run: AutomationRun,
    target: AutomationRun["targets"][number],
  ): boolean {
    return (
      canManage &&
      run.state === "scheduled" &&
      run.attemptCount === 0 &&
      run.leaseOwner === null &&
      run.contentItemId === null &&
      run.contentVersionId === null &&
      target.state === "pending" &&
      target.variantId === null &&
      target.auditRunId === null &&
      target.auditArtifactId === null &&
      target.publicationJobId === null
    );
  }

  async function reassignTarget(target: AutomationRun["targets"][number]): Promise<void> {
    if (runDetail === null || !targetCanReassign(runDetail, target)) return;
    const nextAccountId = assignmentSelections[target.id] ?? target.channelAccountId;
    if (nextAccountId === target.channelAccountId) return;
    const scope = tenantId;
    setReassigningTargetId(target.id);
    setFeedback(null);
    try {
      const nextRun = await api.reassignAutomationTarget(runDetail.id, target.id, nextAccountId);
      if (scopeRef.current !== scope) return;
      setRunDetail(nextRun);
      setRuns((current) => current.map((run) => (run.id === nextRun.id ? nextRun : run)));
      setAssignmentSelections((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      setFeedback({ tone: "success", text: `${target.id} 已更新分配账号并完成回读。` });
    } catch (error) {
      if (scopeRef.current === scope) setFeedback({ tone: "error", text: apiError(error) });
    } finally {
      if (scopeRef.current === scope) setReassigningTargetId(null);
    }
  }

  function targetCanManualRemediate(
    run: AutomationRun,
    target: AutomationRun["targets"][number],
  ): boolean {
    return (
      canManage &&
      run.leaseOwner === null &&
      target.state === "awaiting_manual_review" &&
      target.auditArtifactId !== null &&
      target.publicationJobId === null
    );
  }

  function defaultManualRemediationActions(
    remediation: AutomationRemediationSummary | null,
  ): readonly AutomationManualRemediationAction[] {
    const actions: AutomationManualRemediationAction[] = [];
    if (
      remediation === null ||
      remediation.actions.some((action) =>
        [
          "rebuild_article",
          "restructure_article",
          "soften_promotion",
          "reformat_for_platform",
          "remove_off_platform_contact",
        ].includes(action),
      )
    ) {
      actions.push("rebuild_article");
    }
    if (remediation?.actions.includes("replace_media") === true) actions.push("replace_media");
    return actions.length > 0 ? actions : ["rebuild_article"];
  }

  function manualRemediationActions(
    target: AutomationRun["targets"][number],
  ): readonly AutomationManualRemediationAction[] {
    return (
      manualRemediationSelections[target.id] ??
      defaultManualRemediationActions(remediationForTarget(target.remediation))
    );
  }

  function toggleManualRemediationAction(
    target: AutomationRun["targets"][number],
    action: AutomationManualRemediationAction,
  ): void {
    setManualRemediationSelections((current) => {
      const existing =
        current[target.id] ??
        defaultManualRemediationActions(remediationForTarget(target.remediation));
      const next = existing.includes(action)
        ? existing.filter((candidate) => candidate !== action)
        : [...existing, action];
      return { ...current, [target.id]: next };
    });
  }

  async function restartManualRemediation(target: AutomationRun["targets"][number]): Promise<void> {
    if (runDetail === null || !targetCanManualRemediate(runDetail, target)) return;
    const actions = manualRemediationActions(target);
    if (actions.length === 0) return;
    const scope = tenantId;
    setManualRemediatingTargetId(target.id);
    setFeedback(null);
    try {
      const nextRun = await api.restartAutomationTargetRemediation(
        runDetail.id,
        target.id,
        actions,
      );
      if (scopeRef.current !== scope) return;
      setRunDetail(nextRun);
      setRuns((current) => current.map((run) => (run.id === nextRun.id ? nextRun : run)));
      setManualRemediationSelections((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      setFeedback({
        tone: "success",
        text: `${platformLabel(target.platform)} 已按审计原因重新排队，原始版本已保留。`,
      });
    } catch (error) {
      if (scopeRef.current === scope) setFeedback({ tone: "error", text: apiError(error) });
    } finally {
      if (scopeRef.current === scope) setManualRemediatingTargetId(null);
    }
  }

  return (
    <div className="ops-workspace automation-operations">
      <div className="ops-notice ops-notice-warning" role="status">
        <ShieldAlert size={16} />
        <span>
          {executionLevel === "dry_run" ? (
            <>
              <strong>演练模式</strong> · 仅执行内容生成、发布前审计与平台预演，不执行外部发送。
            </>
          ) : (
            <>
              <strong>无人值守</strong> ·
              五个平台均按服务端账号轮换进入批次；登录会话、配额、熔断和平台发布状态仍逐次校验。
            </>
          )}
        </span>
      </div>

      {!canManage ? (
        <div className="ops-notice ops-notice-warning" role="status">
          <Ban size={16} />
          <span>当前账号没有自动化管理权限。本页保持只读，可查看批次、运行与目标证据。</span>
        </div>
      ) : null}

      {!canWriteCampaign ? (
        <div className="ops-notice ops-notice-warning" role="status">
          <Ban size={16} />
          <span>
            当前账号没有内容写入权限。推广计划生命周期控制保持只读，服务端状态不会被客户端改写。
          </span>
        </div>
      ) : null}

      <section className="ops-evidence-band automation-campaign-band">
        <div className="ops-section-heading">
          <div>
            <span>计划生命周期</span>
            <h2>推广计划上线门</h2>
          </div>
          <span className="status-badge status-info">服务端状态机</span>
        </div>
        <Feedback value={campaignFeedback} />
        {campaigns.length === 0 ? (
          <div className="ops-empty automation-campaign-empty" role="status">
            <Flag size={15} /> 当前租户没有推广计划
          </div>
        ) : (
          <div className="automation-campaign-list" aria-label="推广计划状态列表">
            {campaigns.map((campaign) => {
              const targets = campaignTargets(campaign.status);
              return (
                <div className="automation-campaign-row" key={campaign.id}>
                  <div>
                    <strong>{campaign.name}</strong>
                    <span>
                      {campaign.topicKey} · {campaign.objective}
                    </span>
                  </div>
                  <span className={`status-badge status-${campaignStatusTone(campaign.status)}`}>
                    {campaignStatusLabel(campaign.status)}
                  </span>
                  <label className="automation-campaign-remediation-toggle">
                    <span>自动整改</span>
                    <input
                      type="checkbox"
                      checked={campaign.automationRemediationEnabled}
                      onChange={(event) =>
                        void setCampaignRemediation(campaign, event.target.checked)
                      }
                      disabled={!canWriteCampaign || remediationCampaignId === campaign.id}
                      aria-label={`${campaign.name} 自动整改`}
                    />
                  </label>
                  <div className="automation-campaign-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={`编辑 ${campaign.name} 提示词模版`}
                      onClick={() => setPromptTemplateIntent({ campaign })}
                      disabled={!canWriteCampaign}
                      title={!canWriteCampaign ? "需要内容写入权限" : undefined}
                    >
                      <FileText size={14} />
                      提示词模版
                    </button>
                    {targets.length === 0 ? (
                      <span>终态，无后续操作</span>
                    ) : (
                      targets.map((targetStatus) => (
                        <button
                          key={targetStatus}
                          type="button"
                          className={
                            targetStatus === "active"
                              ? "button-primary"
                              : targetStatus === "completed"
                                ? "button-danger"
                                : "button-secondary"
                          }
                          aria-label={`${transitionLabel(targetStatus)}推广计划 ${campaign.name}`}
                          onClick={() => {
                            setTransitionIntent({ campaign, targetStatus });
                            setTransitionReason("");
                            setTransitionError(null);
                          }}
                          disabled={!canWriteCampaign || transitionPending}
                          title={!canWriteCampaign ? "需要内容写入权限" : undefined}
                        >
                          {targetStatus === "active" ? (
                            <Play size={14} />
                          ) : targetStatus === "paused" ? (
                            <PauseCircle size={14} />
                          ) : (
                            <CheckCircle2 size={14} />
                          )}
                          {transitionLabel(targetStatus)}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="ops-evidence-band automation-plan-band">
        <div className="ops-section-heading">
          <div>
            <span>自动化投放</span>
            <h2>推广计划自动配置</h2>
          </div>
          <span
            aria-label="自动投放计划保存状态"
            className={`status-badge status-${planStatus.tone}`}
          >
            {planStatus.label}
          </span>
        </div>
        <Feedback value={planFeedback} />
        <div className="ops-article-detail automation-plan-detail">
          <div className="automation-plan-form">
            <div className="automation-plan-context">
              <label>
                正在配置
                <select
                  aria-label="自动配置推广计划"
                  value={campaignId}
                  onChange={(event) => {
                    setCampaignId(event.target.value);
                    rotateDraftKey();
                  }}
                  disabled={
                    !canManage ||
                    planLoading ||
                    planSaving ||
                    planRunning ||
                    activeCampaigns.length === 0
                  }
                >
                  {activeCampaigns.length === 0 ? (
                    <option value="">没有已激活的推广计划</option>
                  ) : (
                    activeCampaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <div className="automation-plan-campaign-summary">
                <strong>{selectedCampaign?.topicKey ?? "等待选择推广计划"}</strong>
                <span>{selectedCampaign?.objective ?? "—"}</span>
              </div>
            </div>

            <div className="automation-plan-primary-controls">
              <div className="automation-plan-toggle-row">
                <div>
                  <strong>定时调度</strong>
                  <span>{planEnabled ? "按计划时间自动创建批次" : "保留配置，不自动创建批次"}</span>
                </div>
                <label className="automation-plan-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={planEnabled}
                    onChange={(event) => {
                      setPlanEnabled(event.target.checked);
                      setPlanDraftTouched(true);
                    }}
                    disabled={!canManage || planLoading || planSaving || planRunning}
                    aria-label="自动投放计划启用开关"
                  />
                  <span className="automation-plan-switch-track" aria-hidden="true">
                    <span />
                  </span>
                  <span>{planEnabled ? "开启" : "关闭"}</span>
                </label>
              </div>
              <div className="ops-execution-level automation-plan-execution-level">
                <span>执行级别</span>
                <div className="segmented-control" aria-label="自动投放执行级别">
                  {(["unattended", "dry_run"] as const).map((level) => (
                    <button
                      key={level}
                      className={planExecutionLevel === level ? "active" : ""}
                      type="button"
                      aria-label={`自动投放计划执行级别：${executionLevelLabel(level)}`}
                      aria-pressed={planExecutionLevel === level}
                      onClick={() => {
                        setPlanExecutionLevel(level);
                        setPlanDraftTouched(true);
                      }}
                      disabled={!canManage || planLoading || planSaving || planRunning}
                    >
                      {executionLevelLabel(level)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="automation-plan-subheading">
              <strong>批次与时段</strong>
              <span>
                每批 {planSlotCount} 篇 · 槽位间隔 {planIntervalMinutes} 分钟
              </span>
            </div>
            <div className="ops-form-grid automation-plan-schedule-grid">
              <label>
                每批槽位
                <input
                  type="number"
                  min={1}
                  max={AUTOMATION_BATCH_DRY_RUN_MAX_SLOTS}
                  value={planSlotCount}
                  onChange={(event) => {
                    setPlanSlotCount(Number(event.target.value));
                    setPlanDraftTouched(true);
                  }}
                  disabled={!canManage || planLoading || planSaving || planRunning}
                  aria-label="自动投放每批槽位"
                />
              </label>
              <label>
                槽位间隔（分钟）
                <input
                  type="number"
                  min={1}
                  max={1_440}
                  value={planIntervalMinutes}
                  onChange={(event) => {
                    setPlanIntervalMinutes(Number(event.target.value));
                    setPlanDraftTouched(true);
                  }}
                  disabled={!canManage || planLoading || planSaving || planRunning}
                  aria-label="自动投放槽位间隔"
                />
              </label>
              <label>
                每天投放时间（HH:mm）
                <input
                  type="text"
                  value={planDailyTimes}
                  onChange={(event) => {
                    setPlanDailyTimes(event.target.value);
                    setPlanDraftTouched(true);
                  }}
                  disabled={!canManage || planLoading || planSaving || planRunning}
                  aria-label="自动投放每天时间"
                  placeholder="09:00,14:00,20:00"
                />
              </label>
              <label>
                时区
                <input
                  type="text"
                  value={planTimezone}
                  onChange={(event) => {
                    setPlanTimezone(event.target.value);
                    setPlanDraftTouched(true);
                  }}
                  disabled={!canManage || planLoading || planSaving || planRunning}
                  aria-label="自动投放时区"
                  placeholder="Asia/Shanghai"
                />
              </label>
            </div>

            <div className="automation-plan-subheading">
              <strong>平台与账号轮换</strong>
              <span>{planEligibleAccounts.length} 个账号符合当前执行级别</span>
            </div>
            <fieldset className="automation-plan-platform-grid" aria-label="自动投放目标平台">
              {ALL_AUTOMATION_PLATFORMS.map((platform) => {
                const platformAccounts = planAccountsByPlatform.get(platform) ?? [];
                const selected = planPlatforms.includes(platform);
                const unavailable = platformAccounts.length === 0;
                return (
                  <label
                    key={platform}
                    className={`automation-plan-platform ${selected ? "selected" : ""} ${unavailable ? "unavailable" : ""}`}
                    title={platformAccounts.map((account) => account.displayName).join("、")}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        setPlanPlatforms((current) =>
                          event.target.checked
                            ? [...current, platform]
                            : current.filter((item) => item !== platform),
                        );
                        setPlanDraftTouched(true);
                      }}
                      disabled={
                        !canManage ||
                        planLoading ||
                        planSaving ||
                        planRunning ||
                        (unavailable && !selected)
                      }
                      aria-label={`自动投放平台：${platformLabel(platform)}`}
                    />
                    <span>
                      <strong>{platformLabel(platform)}</strong>
                      <small>
                        {unavailable ? "当前无可用账号" : `${platformAccounts.length} 个账号轮换`}
                      </small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {automationPlan !== null ? (
              <dl className="automation-plan-runtime" aria-label="自动投放计划状态">
                <div>
                  <dt>运行次数</dt>
                  <dd>已运行 {automationPlan.runCount} 次</dd>
                </div>
                <div>
                  <dt>下次调度</dt>
                  <dd>
                    {automationPlan.nextRunAt === null
                      ? "等待首次调度"
                      : formatDateTime(automationPlan.nextRunAt)}
                  </dd>
                </div>
                <div>
                  <dt>最近状态</dt>
                  <dd>{automationPlan.lastErrorCode ?? "正常"}</dd>
                </div>
              </dl>
            ) : null}
            <div className="ops-form-actions automation-plan-actions">
              <button
                className="button-primary"
                type="button"
                onClick={() => void saveAutomationPlan()}
                disabled={
                  !canManage || planLoading || planSaving || planRunning || campaignId === ""
                }
              >
                {planSaving ? <LoaderCircle className="spin" size={15} /> : null}
                {planEnabled ? "保存并启用计划" : "保存计划"}
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={() => void runAutomationPlan()}
                disabled={
                  !canManage ||
                  planLoading ||
                  planSaving ||
                  planRunning ||
                  planDraftTouched ||
                  automationPlan === null ||
                  campaignId === ""
                }
                title={
                  automationPlan === null
                    ? "先保存计划配置"
                    : planDraftTouched
                      ? "先保存当前更改"
                      : undefined
                }
              >
                {planRunning ? <LoaderCircle className="spin" size={15} /> : null}
                立即按计划创建
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="ops-evidence-band">
        <div className="ops-section-heading">
          <div>
            <span>自动化投放</span>
            <h2>创建批次</h2>
          </div>
          <span
            className={`status-badge ${executionLevel === "dry_run" ? "status-warning" : "status-danger"}`}
          >
            {executionLevel === "dry_run" ? "演练模式" : "无人值守模式"}
          </span>
        </div>
        <div className="ops-article-detail">
          <form className="ops-compose-form" onSubmit={(event) => void createBatch(event)}>
            <div className="ops-form-grid">
              <div className="automation-batch-campaign-context" aria-label="自动化推广计划">
                <span>推广计划</span>
                <strong>{selectedCampaign?.name ?? "没有已激活的推广计划"}</strong>
              </div>
              <div className="ops-execution-level">
                <span>执行级别</span>
                <div className="segmented-control" aria-label="自动化执行级别">
                  {(["dry_run", "assisted", "unattended"] as const).map((level) => (
                    <button
                      key={level}
                      className={executionLevel === level ? "active" : ""}
                      type="button"
                      aria-pressed={executionLevel === level}
                      onClick={() => {
                        setExecutionLevel(level);
                        rotateDraftKey();
                      }}
                      disabled={!canManage || creating}
                    >
                      {executionLevelLabel(level)}
                    </button>
                  ))}
                </div>
              </div>
              <label>
                批次名称（可选）
                <input
                  aria-label="自动化批次名称"
                  maxLength={200}
                  value={batchName}
                  onChange={(event) => {
                    setBatchName(event.target.value);
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating}
                  placeholder="例如：日本线路问答预演 · 第 1 批"
                />
              </label>
            </div>

            <div className="visibility-sample-heading">
              <div>
                <strong>自动生成运行槽位</strong>
                <span>
                  {slots.length} 个内容槽位 · {finalTargetCount.toLocaleString("zh-CN")} 个最终变体
                </span>
              </div>
            </div>

            <div className="automation-distribution-mode">
              <div>
                <strong>目标平台与模板</strong>
                <span>
                  选择一个平台时按该平台轮换；选择多个平台时，同一篇内容会生成多个平台变体并行投放。
                </span>
              </div>
              <span className="status-badge status-neutral">
                {selectedPlatforms.length > 1 ? "多平台并行" : "单平台轮换"}
              </span>
            </div>

            <div className="ops-form-grid">
              <label>
                文章数量
                <input
                  aria-label="自动生成文章数量"
                  type="number"
                  min={1}
                  max={maxSlotCount}
                  step={1}
                  value={slotCount}
                  onChange={(event) => {
                    setSlotCount(Number(event.target.value));
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating}
                  required
                />
              </label>
              <label>
                <span className="ops-field-label-row">
                  <span>首篇计划时间</span>
                  <span className="ops-field-quick-actions" aria-label="首篇计划时间快捷设置">
                    <button
                      type="button"
                      className="ops-quick-action"
                      aria-label="最快可用"
                      onClick={() => {
                        const nextMinimum = localDateTime(SCHEDULE_MINIMUM_LEAD_MINUTES);
                        setScheduleMinimumAt(nextMinimum);
                        setStartAt(nextMinimum);
                        rotateDraftKey();
                      }}
                      disabled={!canManage || creating}
                    >
                      <CalendarClock size={13} />
                      最快可用
                    </button>
                    <button
                      type="button"
                      className="ops-quick-action"
                      aria-label="5 分钟后"
                      onClick={() => {
                        setStartAt(localDateTime(5));
                        rotateDraftKey();
                      }}
                      disabled={!canManage || creating}
                    >
                      5 分钟后
                    </button>
                  </span>
                </span>
                <input
                  aria-label="自动生成首篇计划时间"
                  type="datetime-local"
                  min={scheduleMinimumAt}
                  max={localDateTime(SCHEDULE_MAXIMUM_DAYS * 24 * 60)}
                  value={startAt}
                  onChange={(event) => {
                    setStartAt(event.target.value);
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating}
                  required
                />
              </label>
              <label>
                间隔分钟
                <input
                  aria-label="自动生成间隔分钟"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  value={intervalMinutes}
                  onChange={(event) => {
                    setIntervalMinutes(Number(event.target.value));
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating}
                  required
                />
              </label>
            </div>

            <fieldset className="automation-platform-picker">
              <legend>目标平台</legend>
              <div>
                {eligiblePlatforms.map((platform) => {
                  const platformTemplateCount = articleTemplatesForPlatforms(
                    [platform as ArticleTemplatePlatform],
                    templates,
                  ).length;
                  const isSelected = selectedPlatforms.includes(platform as AutomationPlatform);
                  return (
                    <label key={platform}>
                      <input
                        type="checkbox"
                        aria-label={`自动化目标平台：${platformLabel(platform)}`}
                        checked={isSelected}
                        onChange={(event) => {
                          setSelectedPlatforms((current) => {
                            if (event.target.checked) {
                              return current.includes(platform as AutomationPlatform)
                                ? current
                                : [...current, platform as AutomationPlatform];
                            }
                            return current.length === 1
                              ? current
                              : current.filter((selected) => selected !== platform);
                          });
                          rotateDraftKey();
                        }}
                        disabled={
                          !canManage || creating || (isSelected && selectedPlatforms.length === 1)
                        }
                      />
                      <span>
                        <strong>{platformLabel(platform)}</strong>
                        <small>
                          {eligibleAccountCountLabel(
                            eligibleAccounts.filter((account) => account.platform === platform)
                              .length,
                            executionLevel,
                          )}{" "}
                          · {platformTemplateCount} 套允许模板
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="automation-template-availability" aria-label="本批次可用文章模板">
              <div>
                <strong>统一模板池</strong>
                <span>
                  {selectedPlatforms.length > 0
                    ? `${compatibleTemplates.length} 套同时适配${selectedPlatforms.map(platformLabel).join("、")}，服务端自动抽样`
                    : "请先选择目标平台"}
                </span>
              </div>
              <p>
                无需逐篇选择模板。创建批次后，系统会从共同兼容池中按稳定种子抽样并避开相邻重复，结果可在审计和重试时复现。
              </p>
              <details>
                <summary>查看兼容模板池</summary>
                <ul>
                  {compatibleTemplates.map((template) => (
                    <li key={template.id}>{template.name}</li>
                  ))}
                </ul>
              </details>
            </div>

            {eligibleAccounts.length === 0 ||
            selectedPlatforms.length === 0 ||
            unavailableSelectedPlatforms.length > 0 ||
            compatibleTemplates.length === 0 ? (
              <div className="ops-notice ops-notice-warning" role="status">
                <AlertTriangle size={15} />
                <span>
                  {unavailableSelectedPlatforms.length > 0
                    ? `已选 ${unavailableSelectedPlatforms.map(platformLabel).join("、")} 暂不可用；等待实时账号状态恢复后再创建批次。`
                    : compatibleTemplates.length === 0
                      ? "已选平台没有共同允许的模板；调整平台组合后再创建批次。"
                      : `当前租户没有${operationStatusLabel("active")}且支持${executionLevelLabel(executionLevel)}的目标账号池，无法创建批次。`}
                </span>
              </div>
            ) : null}

            <div className="ops-boundary-labels" aria-label="本批次发送规模">
              <span>
                {executionLevel === "unattended"
                  ? `确认后将启动批量发送：${slotCount.toLocaleString("zh-CN")} 篇内容，共 ${finalTargetCount.toLocaleString("zh-CN")} 个平台最终变体；创作者后台确认已发布即计为成功。`
                  : executionLevel === "assisted"
                    ? `本次将生成 ${slotCount.toLocaleString("zh-CN")} 篇审计内容和 ${finalTargetCount.toLocaleString("zh-CN")} 个平台交接目标；草稿准备完成后由人工确认最终发布。`
                    : `本次仅生成 ${slotCount.toLocaleString("zh-CN")} 篇演练内容和 ${finalTargetCount.toLocaleString("zh-CN")} 个平台预演目标，不会向平台外发。`}
              </span>
            </div>

            <div className="ops-form-actions">
              <button
                className="button-primary"
                type="submit"
                disabled={
                  !canManage ||
                  creating ||
                  campaignId === "" ||
                  eligibleAccounts.length === 0 ||
                  selectedPlatforms.length === 0 ||
                  unavailableSelectedPlatforms.length > 0 ||
                  compatibleTemplates.length === 0
                }
                title={!canManage ? "需要自动化管理权限" : undefined}
              >
                {creating ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CalendarClock size={15} />
                )}
                {executionLevel === "unattended"
                  ? `创建并批量发送 ${finalTargetCount.toLocaleString("zh-CN")} 个变体`
                  : executionLevel === "assisted"
                    ? "创建人工协作批次"
                    : "创建演练批次"}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="ops-content-band">
        <div className="ops-section-heading">
          <div>
            <span>持久化运行</span>
            <h2>批次、运行与目标回读</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="刷新自动化批次"
            title="刷新自动化批次"
            onClick={() => void reload()}
            disabled={loading || creating || cancelling}
          >
            <RefreshCw className={loading ? "spin" : ""} size={16} />
          </button>
        </div>
        <Feedback value={feedback} />
        {loading ? (
          <div className="ops-loading ops-article-detail" role="status">
            <LoaderCircle className="spin" size={16} /> 正在读取当前租户自动化批次
          </div>
        ) : batches.length === 0 ? (
          <div className="ops-placeholder" role="status">
            <ClipboardList size={20} />
            <strong>当前租户尚无自动化批次</strong>
            <span>创建批次后，运行槽位和每个平台目标会在这里按持久化状态回读。</span>
          </div>
        ) : (
          <div className="ops-content-layout">
            <div className="ops-content-index" aria-label="自动化批次列表">
              {visibleBatches.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  className={selectedBatchId === batch.id ? "selected" : ""}
                  onClick={() => void selectBatch(batch.id)}
                >
                  <div>
                    <strong>{batch.name ?? `批次 ${shortId(batch.id)}`}</strong>
                    <span>
                      {batch.terminalRunCount}/{batch.runCount} 已终态 ·{" "}
                      {formatDateTime(batch.scheduledFor)}
                    </span>
                  </div>
                  <span className={`ops-state-chip ${stateTone(batch.state)}`}>
                    {batchStateLabel(
                      batch.state,
                      batch.executionLevel,
                      batch.failedRunCount,
                      batch.deliveryFailedRunCount,
                    )}
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
              {(hiddenBatchCount > 0 || batchListLimit > BATCH_PREVIEW_LIMIT) && (
                <div className="ops-index-expand-row">
                  {hiddenBatchCount > 0 && (
                    <button
                      type="button"
                      className="ops-index-expand"
                      onClick={() =>
                        setBatchListLimit((current) =>
                          Math.min(batches.length, current + expandStep),
                        )
                      }
                    >
                      <ChevronDown size={14} />
                      <span>
                        {hiddenBatchCount <= 4
                          ? `展开全部 ${batches.length} 个批次`
                          : `展开更多 ${expandStep} 个 · 剩余 ${hiddenBatchCount} 个`}
                      </span>
                    </button>
                  )}
                  {batchListLimit > BATCH_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      className="ops-index-expand"
                      onClick={() => setBatchListLimit(BATCH_PREVIEW_LIMIT)}
                    >
                      <ChevronUp size={14} />
                      <span>收起批次列表</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="ops-content-detail">
              {selectedBatch === null ? (
                <div className="ops-placeholder" role="status">
                  <ClipboardList size={20} />
                  <strong>选择批次</strong>
                  <span>查看运行槽位、审计状态与平台目标结果。</span>
                </div>
              ) : (
                <div className="ops-article-detail">
                  <div className="ops-detail-heading">
                    <div>
                      <span>自动化批次</span>
                      <h3>{selectedBatch.name ?? `批次 ${shortId(selectedBatch.id)}`}</h3>
                      <small>{selectedBatch.id}</small>
                    </div>
                    <span className={`ops-state-chip ${stateTone(selectedBatch.state)}`}>
                      {batchStateLabel(
                        selectedBatch.state,
                        selectedBatch.executionLevel,
                        selectedBatch.failedRunCount,
                        selectedBatch.deliveryFailedRunCount,
                      )}
                    </span>
                  </div>

                  <div className="ops-version-meta">
                    <div>
                      <span>执行级别</span>
                      <strong>{executionLevelLabel(selectedBatch.executionLevel)}</strong>
                    </div>
                    <div>
                      <span>计划时间</span>
                      <strong>{formatDateTime(selectedBatch.scheduledFor)}</strong>
                    </div>
                    <div>
                      <span>运行统计</span>
                      <strong>
                        {selectedBatch.completedRunCount} 成功 · {selectedBatch.failedRunCount}{" "}
                        运行失败 · {selectedBatch.deliveryFailedRunCount} 投放失败 ·{" "}
                        {selectedBatch.cancelledRunCount} 已取消 ·{" "}
                        {selectedBatch.runCount - selectedBatch.terminalRunCount} 处理中
                      </strong>
                    </div>
                  </div>

                  {CANCELLABLE_BATCH_STATES.includes(selectedBatch.state) ? (
                    <div className="ops-cancel-row">
                      <label>
                        取消原因
                        <input
                          aria-label="自动化批次取消原因"
                          value={cancelReason}
                          minLength={3}
                          maxLength={500}
                          onChange={(event) => setCancelReason(event.target.value)}
                          disabled={!canManage || cancelling}
                          placeholder="说明停止该批次的原因"
                        />
                      </label>
                      <button
                        className="button-secondary"
                        type="button"
                        onClick={() => void cancelBatch()}
                        disabled={!canManage || cancelling || cancelReason.trim().length < 3}
                        title={!canManage ? "需要自动化管理权限" : undefined}
                      >
                        {cancelling ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Ban size={15} />
                        )}
                        取消批次
                      </button>
                    </div>
                  ) : null}

                  <div className="ops-platform-boundary">
                    <ShieldAlert size={15} />
                    <span>
                      {selectedBatch.executionLevel === "dry_run"
                        ? "该批次仅执行平台预演，不代表外部平台发送。"
                        : "该批次仍受发布前审计、平台会话/风控和公开读回门禁约束；不会绕过登录或验证码。"}
                    </span>
                  </div>

                  <div className="ops-subheading">
                    运行槽位 <span>{selectedBatchRuns.length}</span>
                  </div>
                  {selectedBatchRuns.length === 0 ? (
                    <div className="ops-empty" role="status">
                      <AlertTriangle size={15} /> 当前批次暂无可回读的运行槽位
                    </div>
                  ) : (
                    <div
                      className="ops-detail-list automation-run-list"
                      aria-label="自动化运行列表"
                    >
                      {visibleRuns.map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={selectedRunId === run.id ? "selected" : ""}
                          onClick={() => void loadRun(run.id, selectedBatch.id)}
                        >
                          <div>
                            <strong>{run.slotKey}</strong>
                            <span>
                              {run.topicKey} · {stageLabel(run.stage, run.executionLevel)}
                            </span>
                            <span>
                              账号：
                              {run.targets
                                .map((target) => {
                                  const account = accounts.find(
                                    (candidate) => candidate.id === target.channelAccountId,
                                  );
                                  return account?.displayName ?? shortId(target.channelAccountId);
                                })
                                .join("、") || "服务端待分配"}
                            </span>
                          </div>
                          <span className={`ops-state-chip ${stateTone(run.state)}`}>
                            {runStateLabel(run.state, run.executionLevel)}
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                      {(hiddenRunCount > 0 || runListLimit > RUN_PREVIEW_LIMIT) && (
                        <div className="ops-index-expand-row automation-run-expand-row">
                          {hiddenRunCount > 0 && (
                            <button
                              type="button"
                              className="ops-index-expand"
                              onClick={() =>
                                setRunListLimit((current) =>
                                  Math.min(selectedBatchRuns.length, current + runExpandStep),
                                )
                              }
                            >
                              <ChevronDown size={14} />
                              <span>
                                {hiddenRunCount <= 4
                                  ? `展开全部 ${selectedBatchRuns.length} 个运行槽位`
                                  : `展开更多 ${runExpandStep} 个运行槽位 · 剩余 ${hiddenRunCount} 个`}
                              </span>
                            </button>
                          )}
                          {runListLimit > RUN_PREVIEW_LIMIT && (
                            <button
                              type="button"
                              className="ops-index-expand"
                              onClick={() => setRunListLimit(RUN_PREVIEW_LIMIT)}
                            >
                              <ChevronUp size={14} />
                              <span>收起运行槽位</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {detailLoading ? (
                    <div className="ops-loading" role="status">
                      <LoaderCircle className="spin" size={15} /> 正在读取运行详情
                    </div>
                  ) : runDetail === null ? null : (
                    <div className="ops-job-detail">
                      <div className="ops-detail-heading">
                        <div>
                          <span>运行详情</span>
                          <h3>{runDetail.slotKey}</h3>
                          <small>{runDetail.id}</small>
                        </div>
                        <span className={`ops-state-chip ${stateTone(runDetail.state)}`}>
                          {runStateLabel(runDetail.state, runDetail.executionLevel)}
                        </span>
                      </div>
                      <dl className="ops-job-meta">
                        <div>
                          <dt>阶段</dt>
                          <dd>{stageLabel(runDetail.stage, runDetail.executionLevel)}</dd>
                        </div>
                        <div>
                          <dt>尝试</dt>
                          <dd>
                            {runDetail.attemptCount}/{runDetail.maxAttempts}
                          </dd>
                        </div>
                        <div>
                          <dt>可执行时间</dt>
                          <dd>{formatDateTime(runDetail.availableAt)}</dd>
                        </div>
                        <div>
                          <dt>心跳</dt>
                          <dd>{formatDateTime(runDetail.heartbeatAt)}</dd>
                        </div>
                        <div>
                          <dt>内容项</dt>
                          <dd title={runDetail.contentItemId ?? undefined}>
                            {shortId(runDetail.contentItemId)}
                          </dd>
                        </div>
                        <div>
                          <dt>内容版本</dt>
                          <dd title={runDetail.contentVersionId ?? undefined}>
                            {shortId(runDetail.contentVersionId)}
                          </dd>
                        </div>
                      </dl>
                      <div className="ops-notice ops-notice-info" role="status">
                        <ClipboardList size={15} />
                        <span>
                          <strong>{runDetail.topicKey}</strong> · {runDetail.brief}
                        </span>
                      </div>
                      {runDetail.lastErrorCode === null ? null : (
                        <div className="ops-inline-error" role="alert">
                          <AlertTriangle size={15} />
                          <span>
                            {runDetail.lastErrorCode}:{" "}
                            {runDetail.lastErrorMessage ?? "未提供错误详情"}
                          </span>
                        </div>
                      )}
                      <div className="ops-subheading">
                        平台目标 <span>{runDetail.targets.length}</span>
                      </div>
                      {runDetail.targets.length === 0 ? (
                        <div className="ops-empty" role="status">
                          <AlertTriangle size={15} /> 当前运行没有平台目标
                        </div>
                      ) : (
                        <div
                          className="ops-detail-list automation-target-list"
                          aria-label="自动化目标列表"
                        >
                          {runDetail.targets.map((target) => {
                            const account = accounts.find(
                              (candidate) => candidate.id === target.channelAccountId,
                            );
                            const assignmentAccounts = accounts.filter(
                              (candidate) =>
                                candidate.status === "active" &&
                                candidate.platform === target.platform &&
                                candidate.supportedExecutionLevels.includes(
                                  runDetail.executionLevel,
                                ),
                            );
                            const selectedAssignment =
                              assignmentSelections[target.id] ?? target.channelAccountId;
                            const remediation = remediationForTarget(target.remediation);
                            return (
                              <div key={target.id}>
                                <div>
                                  <strong>{platformLabel(target.platform)}</strong>
                                  <span>
                                    账号：{account?.displayName ?? shortId(target.channelAccountId)}{" "}
                                    · job {shortId(target.publicationJobId)}
                                  </span>
                                </div>
                                <span className={`ops-state-chip ${stateTone(target.state)}`}>
                                  {targetStateLabel(target.state, runDetail.executionLevel)}
                                </span>
                                <small>
                                  {formatDateTime(target.completedAt ?? target.updatedAt)}
                                </small>
                                {target.lastErrorCode === null ? null : (
                                  <div className="automation-target-error" role="alert">
                                    <AlertTriangle size={14} />
                                    <span>
                                      {target.lastErrorCode}:{" "}
                                      {target.lastErrorMessage ?? "未提供错误详情"}
                                    </span>
                                  </div>
                                )}
                                {target.externalUrl === null ? null : (
                                  <a
                                    className="automation-target-url"
                                    href={target.externalUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label={`打开 ${platformLabel(target.platform)} 的原始公开 URL`}
                                  >
                                    <ExternalLink size={14} />
                                    <span>原始公开 URL</span>
                                    <code>{target.externalUrl}</code>
                                  </a>
                                )}
                                {remediation === null ? null : (
                                  <div className="automation-target-remediation" role="status">
                                    <RefreshCw size={14} />
                                    <span>
                                      {remediation.mode === "automatic" ? "自动整改" : "人工整改"}{" "}
                                      {remediation.attempt}/{remediation.maxAttempts} · 原因：
                                      {remediation.reasonCodes.join("、")}
                                      {remediation.actions.length === 0
                                        ? ""
                                        : ` · 动作：${remediation.actions.join("、")}`}
                                    </span>
                                  </div>
                                )}
                                {targetCanManualRemediate(runDetail, target) ? (
                                  <div className="automation-target-manual-remediation">
                                    <span>按审计原因重做</span>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={manualRemediationActions(target).includes(
                                          "rebuild_article",
                                        )}
                                        onChange={() =>
                                          toggleManualRemediationAction(target, "rebuild_article")
                                        }
                                        disabled={manualRemediatingTargetId === target.id}
                                      />
                                      改稿
                                    </label>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={manualRemediationActions(target).includes(
                                          "replace_media",
                                        )}
                                        onChange={() =>
                                          toggleManualRemediationAction(target, "replace_media")
                                        }
                                        disabled={manualRemediatingTargetId === target.id}
                                      />
                                      换图
                                    </label>
                                    <button
                                      className="button-secondary"
                                      type="button"
                                      onClick={() => void restartManualRemediation(target)}
                                      disabled={
                                        manualRemediatingTargetId === target.id ||
                                        manualRemediationActions(target).length === 0
                                      }
                                    >
                                      {manualRemediatingTargetId === target.id ? (
                                        <LoaderCircle className="spin" size={14} />
                                      ) : (
                                        <RefreshCw size={14} />
                                      )}
                                      重新审计
                                    </button>
                                  </div>
                                ) : null}
                                {targetCanReassign(runDetail, target) ? (
                                  <div className="automation-target-assignment">
                                    <label>
                                      更改账号
                                      <select
                                        aria-label={`修改 ${target.id} 分配账号`}
                                        value={selectedAssignment}
                                        onChange={(event) =>
                                          setAssignmentSelections((current) => ({
                                            ...current,
                                            [target.id]: event.target.value,
                                          }))
                                        }
                                        disabled={reassigningTargetId === target.id}
                                      >
                                        {assignmentAccounts.map((candidate) => (
                                          <option key={candidate.id} value={candidate.id}>
                                            {candidate.displayName}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <button
                                      className="button-secondary"
                                      type="button"
                                      onClick={() => void reassignTarget(target)}
                                      disabled={
                                        reassigningTargetId === target.id ||
                                        selectedAssignment === target.channelAccountId
                                      }
                                    >
                                      {reassigningTargetId === target.id ? (
                                        <LoaderCircle className="spin" size={14} />
                                      ) : null}
                                      保存账号
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {transitionIntent === null ? null : (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={transitionPending ? undefined : () => setTransitionIntent(null)}
        >
          <div
            ref={transitionDialogRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-transition-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 id="campaign-transition-title">
                  确认{transitionLabel(transitionIntent.targetStatus)}推广计划
                </h2>
                <p>状态仅在服务端写入并完成列表回读后更新</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭推广计划状态确认"
                title="关闭"
                onClick={() => setTransitionIntent(null)}
                disabled={transitionPending}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(event) => void transitionCampaign(event)}>
              {transitionError === null ? null : (
                <div className="auth-error" role="alert">
                  <AlertTriangle size={16} />
                  <span>{transitionError}</span>
                </div>
              )}
              <div className="ops-notice ops-notice-warning" role="status">
                {transitionIntent.targetStatus === "active" ? (
                  <Play size={15} />
                ) : transitionIntent.targetStatus === "paused" ? (
                  <PauseCircle size={15} />
                ) : (
                  <CheckCircle2 size={15} />
                )}
                <span>
                  <strong>{transitionIntent.campaign.name}</strong> · 当前
                  {campaignStatusLabel(transitionIntent.campaign.status)} →
                  {campaignStatusLabel(transitionIntent.targetStatus)}。
                  {transitionDescription(transitionIntent.targetStatus)}
                </span>
              </div>
              <label>
                变更原因
                <input
                  aria-label="推广计划状态变更原因"
                  value={transitionReason}
                  onChange={(event) => setTransitionReason(event.target.value)}
                  minLength={3}
                  maxLength={1_000}
                  autoFocus
                  required
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setTransitionIntent(null)}
                  disabled={transitionPending}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={
                    transitionIntent.targetStatus === "completed"
                      ? "button-danger"
                      : "button-primary"
                  }
                  disabled={transitionPending || transitionReason.trim().length < 3}
                >
                  {transitionPending ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : transitionIntent.targetStatus === "active" ? (
                    <Play size={15} />
                  ) : transitionIntent.targetStatus === "paused" ? (
                    <PauseCircle size={15} />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  {transitionPending
                    ? "等待服务端回读"
                    : `确认${transitionLabel(transitionIntent.targetStatus)}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {promptTemplateIntent === null ? null : (
        <CampaignPromptTemplateDialog
          key={promptTemplateIntent.campaign.id}
          campaign={promptTemplateIntent.campaign}
          api={api}
          dialogRef={promptTemplateDialogRef}
          onClose={() => setPromptTemplateIntent(null)}
          onSaved={() => {
            setPromptTemplateIntent(null);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function CampaignPromptTemplateDialog({
  campaign,
  api,
  dialogRef,
  onClose,
  onSaved,
}: {
  campaign: Campaign;
  api: GeoApi;
  dialogRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [needs, setNeeds] = useState("");
  const [promptTemplate, setPromptTemplate] = useState(campaign.promptTemplate ?? "");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedFrom, setGeneratedFrom] = useState<string | null>(null);

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
        campaignName: campaign.name,
        topicKey: campaign.topicKey,
        objective: campaign.objective,
      });
      setPromptTemplate(generated.promptTemplate);
      setGeneratedFrom(`${generated.provider} · ${generated.model}`);
    } catch (generateError) {
      setError(apiError(generateError));
    } finally {
      setGenerating(false);
    }
  }

  async function saveTemplate() {
    setSaving(true);
    setError(null);
    try {
      await api.setCampaignPromptTemplate(campaign.id, promptTemplate.trim() || null);
      onSaved();
    } catch (saveError) {
      setError(apiError(saveError));
      setSaving(false);
    }
  }

  async function clearTemplate() {
    setSaving(true);
    setError(null);
    try {
      await api.setCampaignPromptTemplate(campaign.id, null);
      onSaved();
    } catch (clearError) {
      setError(apiError(clearError));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={saving ? undefined : onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-prompt-template-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="campaign-prompt-template-title">提示词模版 · {campaign.name}</h2>
            <p>描述需求后用 AI 生成，保存前可继续编辑</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭提示词模版"
            title="关闭"
            onClick={onClose}
            disabled={saving}
          >
            <X size={18} />
          </button>
        </div>
        <div className="ops-compose-form">
          {error === null ? null : (
            <div className="auth-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          <label>
            客户内容需求
            <textarea
              value={needs}
              onChange={(event) => setNeeds(event.target.value)}
              placeholder="例如：突出国企地接与真纯玩，弱化营销感，覆盖目的地核心景区"
              rows={3}
            />
          </label>
          <div className="ops-form-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => void generateTemplate()}
              disabled={generating || saving}
            >
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "正在生成" : "AI 生成提示词模版"}
            </button>
          </div>
          {generatedFrom === null ? null : (
            <div className="ops-boundary-labels" role="status">
              <span>已由 {generatedFrom} 生成，可在保存前编辑</span>
            </div>
          )}
          <label>
            提示词模版
            <textarea
              value={promptTemplate}
              onChange={(event) => setPromptTemplate(event.target.value)}
              placeholder="AI 生成后可继续编辑，内容会作为文章生成的内容要求"
              rows={10}
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => void clearTemplate()}
              disabled={saving || promptTemplate.trim().length === 0}
            >
              清除
            </button>
            <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="button-primary"
              onClick={() => void saveTemplate()}
              disabled={saving}
            >
              {saving ? <LoaderCircle className="spin" size={15} /> : null}
              保存模版
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
