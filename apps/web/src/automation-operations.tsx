import {
  AlertTriangle,
  Ban,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Flag,
  LoaderCircle,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  type AutomationBatch,
  type AutomationBatchState,
  type AutomationRun,
  type AutomationRunState,
  type AutomationRunTargetState,
  type Campaign,
  type CampaignStatus,
  type CampaignTransitionInput,
  type ChannelAccount,
  GeoApiError,
  type GeoApi,
} from "./api.js";

interface SlotDraft {
  readonly id: string;
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

export interface AutomationOperationsProps {
  readonly api: GeoApi;
  readonly tenantId: string;
  readonly campaigns: readonly Campaign[];
  readonly accounts: readonly ChannelAccount[];
  readonly capabilities: readonly string[];
  readonly onChanged?: () => void;
  readonly onCampaignsRead?: (campaigns: readonly Campaign[]) => void;
}

const AUTOMATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CANCELLABLE_BATCH_STATES: readonly AutomationBatchState[] = ["scheduled", "running"];

function nonce(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function localDateTime(minutesFromNow = 15): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function newSlot(topicKey: string, index: number): SlotDraft {
  return {
    id: nonce(),
    slotKey: `slot-${String(index).padStart(3, "0")}`,
    scheduledFor: localDateTime(15 * index),
    topicKey,
    brief: "",
    channelAccountIds: [],
  };
}

function newBatchKey(tenantId: string): string {
  return `web-automation:${tenantId}:${nonce()}`;
}

function formatDateTime(value: string | null): string {
  if (value === null) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function shortId(value: string | null): string {
  if (value === null) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function apiError(error: unknown): string {
  if (error instanceof GeoApiError) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    return `${error.code}: ${error.message}${request}`;
  }
  return error instanceof Error ? error.message : "未知自动化操作错误";
}

function platformLabel(platform: string): string {
  return (
    {
      toutiao: "头条号",
      sohu: "搜狐号",
      ctrip_community: "携程社区",
    }[platform] ?? platform
  );
}

function executionLevelLabel(level: AutomationBatch["executionLevel"]): string {
  return { dry_run: "Dry-run", assisted: "辅助发布", unattended: "无人值守" }[level];
}

function batchStateLabel(state: AutomationBatchState): string {
  return {
    scheduled: "待执行",
    running: "运行中",
    completed: "预演完成",
    partially_failed: "部分失败",
    cancelled: "已取消",
  }[state];
}

function runStateLabel(state: AutomationRunState): string {
  return {
    scheduled: "待执行",
    running: "运行中",
    retry_wait: "等待重试",
    awaiting_delivery: "等待 Dry-run 预演",
    completed: "预演完成",
    partially_failed: "部分失败",
    blocked: "治理阻断",
    failed: "运行失败",
    cancelled: "已取消",
  }[state];
}

function targetStateLabel(state: AutomationRunTargetState): string {
  return {
    pending: "待处理",
    variant_ready: "平台变体就绪",
    audit_failed: "发布前审计未通过",
    awaiting_delivery: "等待 Dry-run 预演",
    preview_completed: "Dry-run 预演完成",
    confirmed: "状态异常：confirmed",
    blocked: "治理阻断",
    failed: "目标失败",
    cancelled: "已取消",
  }[state];
}

function stateTone(state: AutomationBatchState | AutomationRunState | AutomationRunTargetState) {
  if (["completed", "preview_completed", "variant_ready"].includes(state)) return "success";
  if (["partially_failed", "retry_wait", "awaiting_delivery", "audit_failed"].includes(state)) {
    return "warning";
  }
  if (["failed", "blocked", "cancelled", "confirmed"].includes(state)) return "danger";
  return "neutral";
}

function stageLabel(stage: AutomationRun["stage"]): string {
  return {
    planning: "计划",
    draft: "草稿",
    targets: "平台变体 / 审计",
    delivery: "Dry-run 预演",
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
    active: "激活后，该 Campaign 才能创建和执行无人值守 Dry-run 批次。",
    paused: "暂停后，新运行不会被 producer 认领；已有审计和预演记录继续保留。",
    completed: "完成是不可逆终态；该 Campaign 之后不能重新激活或创建新批次。",
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
  capabilities,
  onChanged,
  onCampaignsRead,
}: AutomationOperationsProps) {
  const scopeRef = useRef(tenantId);
  const detailRequestRef = useRef(0);
  const activeCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.status === "active"),
    [campaigns],
  );
  const [executionLevel, setExecutionLevel] =
    useState<AutomationBatch["executionLevel"]>("dry_run");
  const eligibleAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.status === "active" && account.supportedExecutionLevels.includes(executionLevel),
      ),
    [accounts, executionLevel],
  );
  const canManage = capabilities.includes("automation:manage");
  const canWriteCampaign = capabilities.includes("content:write");
  const [campaignId, setCampaignId] = useState("");
  const [batchName, setBatchName] = useState("");
  const [slots, setSlots] = useState<readonly SlotDraft[]>(() => [newSlot("", 1)]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newBatchKey(tenantId));
  const [batches, setBatches] = useState<readonly AutomationBatch[]>([]);
  const [runs, setRuns] = useState<readonly AutomationRun[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<AutomationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [campaignFeedback, setCampaignFeedback] = useState<FeedbackState | null>(null);
  const [transitionIntent, setTransitionIntent] = useState<CampaignTransitionIntent | null>(null);
  const [transitionReason, setTransitionReason] = useState("");
  const [transitionPending, setTransitionPending] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const selectedCampaign = activeCampaigns.find((campaign) => campaign.id === campaignId);
  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const selectedBatchRuns = runs.filter((run) => run.batchId === selectedBatchId);

  useEffect(() => {
    if (activeCampaigns.some((campaign) => campaign.id === campaignId)) return;
    const first = activeCampaigns[0];
    setCampaignId(first?.id ?? "");
    if (first !== undefined) {
      setSlots((current) =>
        current.map((slot) =>
          slot.topicKey.trim() === "" ? { ...slot, topicKey: first.topicKey } : slot,
        ),
      );
    }
  }, [activeCampaigns, campaignId]);

  useEffect(() => {
    scopeRef.current = tenantId;
    detailRequestRef.current += 1;
    const firstCampaign = activeCampaigns[0];
    setCampaignId(firstCampaign?.id ?? "");
    setBatchName("");
    setSlots([newSlot(firstCampaign?.topicKey ?? "", 1)]);
    setIdempotencyKey(newBatchKey(tenantId));
    setBatches([]);
    setRuns([]);
    setSelectedBatchId(null);
    setSelectedRunId(null);
    setRunDetail(null);
    setCancelReason("");
    setFeedback(null);
    setCampaignFeedback(null);
    setTransitionIntent(null);
    setTransitionReason("");
    setTransitionError(null);
    setLoading(true);
    let active = true;
    void Promise.all([api.getAutomationBatches(), api.getAutomationRuns()])
      .then(async ([nextBatches, nextRuns]) => {
        if (!active || scopeRef.current !== tenantId) return;
        setBatches(nextBatches);
        setRuns(nextRuns);
        const firstBatch = nextBatches[0];
        if (firstBatch === undefined) return;
        setSelectedBatchId(firstBatch.id);
        const firstRun = nextRuns.find((run) => run.batchId === firstBatch.id);
        if (firstRun === undefined) return;
        const request = ++detailRequestRef.current;
        setSelectedRunId(firstRun.id);
        setDetailLoading(true);
        const detail = await api.getAutomationRun(firstRun.id);
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
  }, [api, tenantId]);

  function rotateDraftKey(): void {
    setIdempotencyKey(newBatchKey(tenantId));
  }

  function updateSlot(id: string, patch: Partial<SlotDraft>): void {
    setSlots((current) => current.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)));
    rotateDraftKey();
  }

  async function loadRun(runId: string, expectedBatchId: string): Promise<void> {
    const scope = tenantId;
    const request = ++detailRequestRef.current;
    setSelectedRunId(runId);
    setRunDetail(null);
    setDetailLoading(true);
    setFeedback(null);
    try {
      const detail = await api.getAutomationRun(runId);
      if (scopeRef.current !== scope || request !== detailRequestRef.current) return;
      if (detail.id !== runId || detail.batchId !== expectedBatchId) {
        throw new TypeError("自动化运行详情与请求范围不一致");
      }
      setRunDetail(detail);
    } catch (error) {
      if (scopeRef.current === scope && request === detailRequestRef.current) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope && request === detailRequestRef.current) {
        setDetailLoading(false);
      }
    }
  }

  async function refresh(
    preferredBatchId: string | null = selectedBatchId,
    preferredRunId: string | null = selectedRunId,
  ): Promise<void> {
    const scope = tenantId;
    const [nextBatches, nextRuns] = await Promise.all([
      api.getAutomationBatches(),
      api.getAutomationRuns(),
    ]);
    if (scopeRef.current !== scope) return;
    setBatches(nextBatches);
    setRuns(nextRuns);
    if (preferredBatchId !== null && !nextBatches.some((batch) => batch.id === preferredBatchId)) {
      throw new TypeError("请求的自动化批次未出现在持久化回读中");
    }
    const nextBatchId =
      preferredBatchId !== null && nextBatches.some((batch) => batch.id === preferredBatchId)
        ? preferredBatchId
        : (nextBatches[0]?.id ?? null);
    setSelectedBatchId(nextBatchId);
    setCancelReason("");
    if (nextBatchId === null) {
      setSelectedRunId(null);
      setRunDetail(null);
      return;
    }
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
    await loadRun(nextRun.id, nextBatchId);
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

  async function selectBatch(batchId: string): Promise<void> {
    detailRequestRef.current += 1;
    setSelectedBatchId(batchId);
    setCancelReason("");
    setRunDetail(null);
    const firstRun = runs.find((run) => run.batchId === batchId);
    if (firstRun === undefined) {
      setSelectedRunId(null);
      return;
    }
    await loadRun(firstRun.id, batchId);
  }

  function validatedItems() {
    if (slots.length < 1 || slots.length > 50) {
      throw new TypeError("批次必须包含 1–50 个槽位");
    }
    const slotKeys = new Set<string>();
    return slots.map((slot, index) => {
      const slotKey = slot.slotKey.trim();
      const topicKey = slot.topicKey.trim();
      const brief = slot.brief.trim();
      if (!AUTOMATION_KEY.test(slotKey) || slotKey.length > 200) {
        throw new TypeError(`槽位 ${index + 1} 的 slotKey 格式无效`);
      }
      if (slotKeys.has(slotKey)) throw new TypeError(`slotKey 重复：${slotKey}`);
      slotKeys.add(slotKey);
      if (!AUTOMATION_KEY.test(topicKey) || topicKey.length > 200) {
        throw new TypeError(`槽位 ${index + 1} 的 topicKey 格式无效`);
      }
      if (brief.length < 3 || brief.length > 10_000) {
        throw new TypeError(`槽位 ${index + 1} 的 brief 必须为 3–10000 个字符`);
      }
      if (slot.channelAccountIds.length < 1 || slot.channelAccountIds.length > 3) {
        throw new TypeError(`槽位 ${index + 1} 必须选择 1–3 个 ${executionLevel} 账号`);
      }
      if (
        new Set(slot.channelAccountIds).size !== slot.channelAccountIds.length ||
        slot.channelAccountIds.some((id) => !eligibleAccounts.some((account) => account.id === id))
      ) {
        throw new TypeError(`槽位 ${index + 1} 包含重复、失效或不支持 ${executionLevel} 的账号`);
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
        throw new TypeError("Campaign 状态变更响应与请求不一致");
      }
      const nextCampaigns = await api.getCampaigns();
      if (scopeRef.current !== scope) return;
      const persisted = nextCampaigns.find((item) => item.id === campaign.id);
      if (persisted?.status !== targetStatus) {
        throw new TypeError("Campaign 状态写入后的列表回读不一致");
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

  async function createBatch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage || campaignId === "") return;
    const scope = tenantId;
    setCreating(true);
    setFeedback(null);
    try {
      const items = validatedItems();
      const trimmedName = batchName.trim();
      const result = await api.createAutomationBatch(campaignId, {
        idempotencyKey,
        executionLevel,
        ...(trimmedName === "" ? {} : { name: trimmedName }),
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
      setSlots([newSlot(selectedCampaign?.topicKey ?? "", 1)]);
      setIdempotencyKey(newBatchKey(tenantId));
      setFeedback({
        tone: "success",
        text: `${items.length} 个槽位已持久化为 ${executionLevel} 批次并完成回读。`,
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

  return (
    <div className="ops-workspace automation-operations">
      <div className="ops-notice ops-notice-warning" role="status">
        <ShieldAlert size={16} />
        <span>
          <strong>{executionLevel}</strong> ·
          {executionLevel === "dry_run"
            ? "仅执行内容生成、发布前审计与平台预演，不会对外发送。"
            : "发布仍受审计、账号能力、平台会话/风控与公开读回门禁约束；不绕过登录或验证码。"}
        </span>
      </div>

      {!canManage ? (
        <div className="ops-notice ops-notice-warning" role="status">
          <Ban size={16} />
          <span>
            当前账号没有 automation:manage 权限。本页保持只读，可查看批次、运行与目标证据。
          </span>
        </div>
      ) : null}

      {!canWriteCampaign ? (
        <div className="ops-notice ops-notice-warning" role="status">
          <Ban size={16} />
          <span>
            当前账号没有 content:write 权限。Campaign
            生命周期控制保持只读，服务端状态不会被客户端改写。
          </span>
        </div>
      ) : null}

      <section className="ops-evidence-band automation-campaign-band">
        <div className="ops-section-heading">
          <div>
            <span>CAMPAIGN LIFECYCLE</span>
            <h2>Campaign 上线门</h2>
          </div>
          <span className="status-badge status-info">服务端状态机</span>
        </div>
        <Feedback value={campaignFeedback} />
        {campaigns.length === 0 ? (
          <div className="ops-empty automation-campaign-empty" role="status">
            <Flag size={15} /> 当前租户没有 Campaign
          </div>
        ) : (
          <div className="automation-campaign-list" aria-label="Campaign 状态列表">
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
                  <div className="automation-campaign-actions">
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
                          aria-label={`${transitionLabel(targetStatus)} Campaign ${campaign.name}`}
                          onClick={() => {
                            setTransitionIntent({ campaign, targetStatus });
                            setTransitionReason("");
                            setTransitionError(null);
                          }}
                          disabled={!canWriteCampaign || transitionPending}
                          title={!canWriteCampaign ? "需要 content:write 权限" : undefined}
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

      <section className="ops-evidence-band">
        <div className="ops-section-heading">
          <div>
            <span>AUTOMATION DELIVERY</span>
            <h2>创建批次</h2>
          </div>
          <span className="status-badge status-warning">{executionLevel} · 最多 50 槽位</span>
        </div>
        <div className="ops-article-detail">
          <form className="ops-compose-form" onSubmit={(event) => void createBatch(event)}>
            <div className="ops-form-grid">
              <label>
                Campaign
                <select
                  aria-label="自动化 Campaign"
                  value={campaignId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextCampaign = activeCampaigns.find((item) => item.id === nextId);
                    setCampaignId(nextId);
                    setSlots((current) =>
                      current.map((slot) => ({
                        ...slot,
                        topicKey: nextCampaign?.topicKey ?? slot.topicKey,
                      })),
                    );
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating || activeCampaigns.length === 0}
                  required
                >
                  {activeCampaigns.length === 0 ? (
                    <option value="">没有 active campaign</option>
                  ) : (
                    activeCampaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label>
                执行级别
                <select
                  aria-label="自动化执行级别"
                  value={executionLevel}
                  onChange={(event) => {
                    const nextLevel = event.target.value as AutomationBatch["executionLevel"];
                    setExecutionLevel(nextLevel);
                    setSlots((current) =>
                      current.map((slot) => ({ ...slot, channelAccountIds: [] })),
                    );
                    rotateDraftKey();
                  }}
                  disabled={!canManage || creating}
                >
                  <option value="dry_run">Dry-run（仅预演）</option>
                  <option value="assisted">辅助发布（人工最终确认）</option>
                  <option value="unattended">无人值守（审计与公开读回门禁）</option>
                </select>
              </label>
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
                <strong>运行槽位</strong>
                <span>{slots.length} / 50</span>
              </div>
              <button
                className="button-secondary"
                type="button"
                onClick={() => {
                  setSlots((current) => [
                    ...current,
                    newSlot(selectedCampaign?.topicKey ?? "", current.length + 1),
                  ]);
                  rotateDraftKey();
                }}
                disabled={!canManage || creating || slots.length >= 50}
              >
                <Plus size={15} /> 添加槽位
              </button>
            </div>

            <div className="visibility-sample-list">
              {slots.map((slot, index) => {
                const availableAccounts = eligibleAccounts.filter(
                  (account) => !slot.channelAccountIds.includes(account.id),
                );
                return (
                  <fieldset key={slot.id} disabled={!canManage || creating}>
                    <legend>槽位 #{index + 1}</legend>
                    <button
                      className="icon-button visibility-remove-sample"
                      type="button"
                      aria-label={`删除槽位 ${index + 1}`}
                      title="删除槽位"
                      onClick={() => {
                        setSlots((current) => current.filter((item) => item.id !== slot.id));
                        rotateDraftKey();
                      }}
                      disabled={!canManage || creating || slots.length === 1}
                    >
                      <Trash2 size={14} />
                    </button>
                    <div className="ops-form-grid">
                      <label>
                        Slot key
                        <input
                          aria-label={`槽位 ${index + 1} Slot key`}
                          maxLength={200}
                          pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
                          value={slot.slotKey}
                          onChange={(event) => updateSlot(slot.id, { slotKey: event.target.value })}
                          required
                        />
                      </label>
                      <label>
                        计划时间
                        <input
                          aria-label={`槽位 ${index + 1} 计划时间`}
                          type="datetime-local"
                          value={slot.scheduledFor}
                          onChange={(event) =>
                            updateSlot(slot.id, { scheduledFor: event.target.value })
                          }
                          required
                        />
                      </label>
                      <label>
                        Topic key
                        <input
                          aria-label={`槽位 ${index + 1} Topic key`}
                          maxLength={200}
                          pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
                          value={slot.topicKey}
                          onChange={(event) =>
                            updateSlot(slot.id, { topicKey: event.target.value })
                          }
                          required
                        />
                      </label>
                      <label>
                        Dry-run 账号（最多 3 个）
                        <select
                          aria-label={`槽位 ${index + 1} 添加 ${executionLevelLabel(executionLevel)} 账号`}
                          value=""
                          onChange={(event) => {
                            const accountId = event.target.value;
                            if (accountId === "" || slot.channelAccountIds.length >= 3) return;
                            updateSlot(slot.id, {
                              channelAccountIds: [...slot.channelAccountIds, accountId],
                            });
                          }}
                          disabled={
                            !canManage ||
                            creating ||
                            slot.channelAccountIds.length >= 3 ||
                            availableAccounts.length === 0
                          }
                        >
                          <option value="">选择账号</option>
                          {availableAccounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {platformLabel(account.platform)} · {account.displayName} ·{" "}
                              {account.capability}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="ops-form-wide">
                        文章 brief
                        <textarea
                          aria-label={`槽位 ${index + 1} 文章 brief`}
                          rows={4}
                          minLength={3}
                          maxLength={10_000}
                          value={slot.brief}
                          onChange={(event) => updateSlot(slot.id, { brief: event.target.value })}
                          placeholder="明确目标读者、问题、线路或服务范围；系统只引用相关且已核验的事实。"
                          required
                        />
                      </label>
                    </div>
                    <div className="ops-boundary-labels" aria-label={`槽位 ${index + 1} 已选账号`}>
                      {slot.channelAccountIds.length === 0 ? (
                        <span>尚未选择账号</span>
                      ) : (
                        slot.channelAccountIds.map((accountId) => {
                          const account = eligibleAccounts.find((item) => item.id === accountId);
                          return (
                            <span key={accountId}>
                              {account === undefined
                                ? shortId(accountId)
                                : `${platformLabel(account.platform)} · ${account.displayName}`}
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={`从槽位 ${index + 1} 移除 ${account?.displayName ?? accountId}`}
                                title="移除账号"
                                onClick={() =>
                                  updateSlot(slot.id, {
                                    channelAccountIds: slot.channelAccountIds.filter(
                                      (id) => id !== accountId,
                                    ),
                                  })
                                }
                              >
                                <X size={12} />
                              </button>
                            </span>
                          );
                        })
                      )}
                    </div>
                  </fieldset>
                );
              })}
            </div>

            {eligibleAccounts.length === 0 ? (
              <div className="ops-notice ops-notice-warning" role="status">
                <AlertTriangle size={15} />
                <span>当前租户没有 active 且支持 {executionLevel} 的平台账号，无法创建批次。</span>
              </div>
            ) : null}

            <div className="ops-form-actions">
              <button
                className="button-primary"
                type="submit"
                disabled={
                  !canManage || creating || campaignId === "" || eligibleAccounts.length === 0
                }
                title={!canManage ? "需要 automation:manage 权限" : undefined}
              >
                {creating ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CalendarClock size={15} />
                )}
                创建 {executionLevelLabel(executionLevel)} 批次
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="ops-content-band">
        <div className="ops-section-heading">
          <div>
            <span>PERSISTED OPERATIONS</span>
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
            <span>创建批次后，运行槽位和每个平台 target 会在这里按持久化状态回读。</span>
          </div>
        ) : (
          <div className="ops-content-layout">
            <div className="ops-content-index" aria-label="自动化批次列表">
              {batches.map((batch) => (
                <button
                  key={batch.id}
                  type="button"
                  className={selectedBatchId === batch.id ? "selected" : ""}
                  onClick={() => void selectBatch(batch.id)}
                >
                  <div>
                    <strong>{batch.name ?? `批次 ${shortId(batch.id)}`}</strong>
                    <span>
                      {batch.completedRunCount}/{batch.runCount} 槽位 ·{" "}
                      {formatDateTime(batch.scheduledFor)}
                    </span>
                  </div>
                  <span className={`ops-state-chip ${stateTone(batch.state)}`}>
                    {batchStateLabel(batch.state)}
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>

            <div className="ops-content-detail">
              {selectedBatch === null ? (
                <div className="ops-placeholder" role="status">
                  <ClipboardList size={20} />
                  <strong>选择批次</strong>
                  <span>查看运行槽位、审计状态与平台 target 结果。</span>
                </div>
              ) : (
                <div className="ops-article-detail">
                  <div className="ops-detail-heading">
                    <div>
                      <span>AUTOMATION BATCH</span>
                      <h3>{selectedBatch.name ?? `批次 ${shortId(selectedBatch.id)}`}</h3>
                      <small>{selectedBatch.id}</small>
                    </div>
                    <span className={`ops-state-chip ${stateTone(selectedBatch.state)}`}>
                      {batchStateLabel(selectedBatch.state)}
                    </span>
                  </div>

                  <div className="ops-version-meta">
                    <div>
                      <span>执行级别</span>
                      <strong>{selectedBatch.executionLevel}</strong>
                    </div>
                    <div>
                      <span>计划时间</span>
                      <strong>{formatDateTime(selectedBatch.scheduledFor)}</strong>
                    </div>
                    <div>
                      <span>运行统计</span>
                      <strong>
                        {selectedBatch.completedRunCount}/{selectedBatch.runCount} 完成 ·{" "}
                        {selectedBatch.failedRunCount} 失败
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
                        title={!canManage ? "需要 automation:manage 权限" : undefined}
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
                      {selectedBatchRuns.map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={selectedRunId === run.id ? "selected" : ""}
                          onClick={() => void loadRun(run.id, selectedBatch.id)}
                        >
                          <div>
                            <strong>{run.slotKey}</strong>
                            <span>
                              {run.topicKey} · {stageLabel(run.stage)}
                            </span>
                          </div>
                          <span className={`ops-state-chip ${stateTone(run.state)}`}>
                            {runStateLabel(run.state)}
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      ))}
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
                          <span>RUN DETAIL</span>
                          <h3>{runDetail.slotKey}</h3>
                          <small>{runDetail.id}</small>
                        </div>
                        <span className={`ops-state-chip ${stateTone(runDetail.state)}`}>
                          {runStateLabel(runDetail.state)}
                        </span>
                      </div>
                      <dl className="ops-job-meta">
                        <div>
                          <dt>阶段</dt>
                          <dd>{stageLabel(runDetail.stage)}</dd>
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
                          <dt>Content item</dt>
                          <dd title={runDetail.contentItemId ?? undefined}>
                            {shortId(runDetail.contentItemId)}
                          </dd>
                        </div>
                        <div>
                          <dt>Content version</dt>
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
                        平台 targets <span>{runDetail.targets.length}</span>
                      </div>
                      {runDetail.targets.length === 0 ? (
                        <div className="ops-empty" role="status">
                          <AlertTriangle size={15} /> 当前运行没有 target
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
                            return (
                              <div key={target.id}>
                                <div>
                                  <strong>{platformLabel(target.platform)}</strong>
                                  <span>
                                    {account?.displayName ?? shortId(target.channelAccountId)} · job{" "}
                                    {shortId(target.publicationJobId)}
                                  </span>
                                </div>
                                <span className={`ops-state-chip ${stateTone(target.state)}`}>
                                  {targetStateLabel(target.state)}
                                </span>
                                <small>
                                  {formatDateTime(target.completedAt ?? target.updatedAt)}
                                </small>
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
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-transition-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 id="campaign-transition-title">
                  确认{transitionLabel(transitionIntent.targetStatus)} Campaign
                </h2>
                <p>状态仅在服务端写入并完成列表回读后更新</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭 Campaign 状态确认"
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
                  aria-label="Campaign 状态变更原因"
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
    </div>
  );
}
