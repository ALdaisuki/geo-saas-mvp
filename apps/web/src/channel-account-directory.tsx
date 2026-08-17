import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LogIn,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Platform } from "@geo/contracts";

import {
  GeoApiError,
  type AutomationSnapshot,
  type ChannelAccount,
  type CtripAccountAnalytics,
  type CtripPlatformAnalyticsDashboard,
  type PriorityPlatformAccountAnalytics,
  type PriorityPlatformAnalyticsDashboard,
  type PublicationJob,
} from "./api.js";
import { createAccountLoginHandoffUrl } from "./ctrip-login-handoff.js";
import { circuitBlocksAccount, circuitRecoveryProbeReady } from "./automation-circuit.js";
import {
  accountDisplayNameLabel,
  connectorCapabilityLabel as capabilityLabel,
  evidenceTypeLabel as evidenceLabel,
  executionLevelLabel as executionLabel,
  operationStatusLabel as statusLabel,
} from "./operation-labels.js";
import { useModalDialog } from "./use-modal-dialog.js";
import {
  ChannelAccountDialog,
  type AccountDialogInput,
  type CreateChannelAccountInput,
  type UpdateChannelAccountInput,
  createChannelAccountInput,
  updateChannelAccountInput,
} from "./tenant-governance.js";

type PlatformKey = Platform;
type StatusFilter = "all" | "active" | "disabled";
type AccountDialogIntent =
  | { readonly type: "create"; readonly platform?: PlatformKey }
  | { readonly type: "edit"; readonly account: ChannelAccount };
type AccountFeedback = Readonly<{ message: string; tone: "success" | "warning" }>;

interface PlatformMeta {
  readonly key: PlatformKey;
  readonly label: string;
  readonly description: string;
  readonly logoPath: string;
}

const PLATFORMS: readonly PlatformMeta[] = [
  {
    key: "toutiao",
    label: "头条号",
    description: "资讯推荐",
    logoPath: "/platforms/toutiao.ico",
  },
  {
    key: "sohu",
    label: "搜狐号",
    description: "门户资讯",
    logoPath: "/platforms/sohu.ico",
  },
  {
    key: "baijiahao",
    label: "百家号",
    description: "百度内容生态",
    logoPath: "/platforms/baijiahao.ico",
  },
  {
    key: "netease",
    label: "网易号",
    description: "门户资讯",
    logoPath: "/platforms/netease.ico",
  },
  {
    key: "ctrip_community",
    label: "携程社区",
    description: "旅行社区",
    logoPath: "/platforms/ctrip.ico",
  },
  {
    key: "zhihu",
    label: "知乎",
    description: "专栏文章 · 登录取证",
    logoPath: "/platforms/zhihu.ico",
  },
];

const PROVISIONED_PLACEHOLDER_EVIDENCE_REFS = new Set([
  "seed:dry-run-only",
  "tenant-provisioning:manual-only-dry-run",
]);

const LOGIN_STATUS_POLL_INTERVAL_MS = 2_000;
const LOGIN_STATUS_POLL_TIMEOUT_MS = 10 * 60_000;
const EMPTY_ACCOUNT_ID_SET: ReadonlySet<string> = new Set();

function loginWindowName(accountId: string): string {
  return `geo-account-login-${accountId}`;
}

export function isRealChannelAccount(account: ChannelAccount): boolean {
  return !(
    account.capability === "manual_only" &&
    account.supportedExecutionLevels.length === 1 &&
    account.supportedExecutionLevels[0] === "dry_run" &&
    account.evidenceRefs.some((reference) => PROVISIONED_PLACEHOLDER_EVIDENCE_REFS.has(reference))
  );
}

function platformMeta(platform: string): PlatformMeta {
  return (
    PLATFORMS.find((item) => item.key === platform) ?? {
      key: "ctrip_community",
      label: platform,
      description: "未分类平台",
      logoPath: "/favicon.svg",
    }
  );
}

function PlatformLogo({ platform }: { readonly platform: string }) {
  const meta = platformMeta(platform);
  return (
    <span className={`account-platform-mark account-platform-${meta.key}`} aria-hidden="true">
      <img src={meta.logoPath} alt="" />
    </span>
  );
}

function checkedLabel(value: string | null): string {
  if (value === null) return "尚未检查";
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

function activeJobCount(accountId: string, jobs: readonly PublicationJob[]): number {
  const activeStates = new Set(["queued", "dispatching", "retry_wait", "uncertain", "reconciling"]);
  return jobs.filter(
    (job) =>
      job.channelAccountId === accountId &&
      activeStates.has(job.state) &&
      job.lastErrorCode !== "ASSISTED_READBACK_DEFERRED",
  ).length;
}

function pendingConfirmationCount(accountId: string, jobs: readonly PublicationJob[]): number {
  return jobs.filter(
    (job) =>
      job.channelAccountId === accountId &&
      job.state === "uncertain" &&
      job.lastErrorCode === "ASSISTED_READBACK_DEFERRED",
  ).length;
}

function accountRunState(
  account: ChannelAccount,
  automation: AutomationSnapshot | null,
  publicationVerificationRequired = false,
): {
  readonly label: string;
  readonly tone: "ready" | "paused" | "stopped" | "verification" | "muted";
} {
  if (
    account.ctripRuntime?.lastErrorCode === "ACCOUNT_PLATFORM_MUTED" ||
    (account.platformMutedAt !== null && account.platformMutedAt !== undefined)
  ) {
    const until = account.platformMutedUntil;
    const suffix =
      until === null || until === undefined
        ? ""
        : `至 ${new Intl.DateTimeFormat("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(until))}`;
    return { label: `平台禁言 · 已停用${suffix === "" ? "" : ` ${suffix}`}`, tone: "muted" };
  }
  if (account.status === "disabled") return { label: "已停用", tone: "stopped" };
  if (publicationVerificationRequired) {
    return { label: "需人工验证", tone: "verification" };
  }
  const runtimeState = account.ctripRuntime?.sessionState;
  const circuit = automation?.circuits.find(
    (candidate) => candidate.scopeType === "account" && candidate.scopeKey === account.id,
  );
  const circuitRequiresCalibration = circuitBlocksAccount(circuit);
  const recoveryProbeReady = circuitRecoveryProbeReady(circuit);
  if (
    circuitRequiresCalibration &&
    (runtimeState === "authenticated" || runtimeState === "ready")
  ) {
    return { label: "已登录 · 已暂停", tone: "paused" };
  }
  if (runtimeState === "session_required") {
    return { label: "需登录", tone: "verification" };
  }
  if (runtimeState === "authenticated" || runtimeState === "ready") {
    return {
      label: recoveryProbeReady ? "已登录 · 可恢复探测" : "已登录 · 可执行",
      tone: "ready",
    };
  }
  if (runtimeState === "challenge_required") {
    return { label: "需处理挑战", tone: "verification" };
  }
  if (runtimeState === "unavailable" || runtimeState === "unbound") {
    return { label: "运行时不可用", tone: "stopped" };
  }
  if (automation?.control.killSwitchEnabled || automation?.control.mode === "stopped") {
    return { label: "全局已停止", tone: "stopped" };
  }
  if (automation?.control.mode === "paused") {
    return { label: "全局已暂停", tone: "paused" };
  }

  const control = automation?.controls.find(
    (candidate) => candidate.scopeType === "account" && candidate.scopeKey === account.id,
  );
  if (control?.killSwitchEnabled || control?.mode === "stopped") {
    return { label: "已停止", tone: "stopped" };
  }
  if (control?.mode === "paused" || circuitRequiresCalibration) {
    return { label: "已暂停", tone: "paused" };
  }
  return { label: "可执行", tone: "ready" };
}

export interface ChannelAccountDirectoryProps {
  readonly accounts: readonly ChannelAccount[];
  readonly automation?: AutomationSnapshot | null;
  readonly publicationJobs?: readonly PublicationJob[];
  readonly publicationVerificationAccountIds?: ReadonlySet<string>;
  readonly analytics?: CtripPlatformAnalyticsDashboard | null;
  readonly analyticsStatus?: "loading" | "ready" | "error";
  readonly priorityAnalytics?: PriorityPlatformAnalyticsDashboard | null;
  readonly priorityAnalyticsStatus?: "loading" | "ready" | "error";
  readonly canManage: boolean;
  readonly demo: boolean;
  readonly onCreate: (input: CreateChannelAccountInput) => Promise<ChannelAccount>;
  readonly onUpdate: (accountId: string, input: UpdateChannelAccountInput) => Promise<void>;
  readonly onOpenLogin?: (accountId: string) => Promise<{ readonly loginUrl: string }>;
  readonly onOpenVerification?: (accountId: string) => Promise<{ readonly loginUrl: string }>;
  readonly onRefreshStatus?: (accountId: string) => Promise<ChannelAccount | void>;
  readonly onForceCalibrate?: (accountId: string) => Promise<void>;
  readonly onDelete?: (accountId: string) => Promise<void>;
  readonly onChanged?: () => void;
}

export function ChannelAccountDirectory(props: ChannelAccountDirectoryProps) {
  const [platformFilter, setPlatformFilter] = useState<PlatformKey | "all">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<AccountDialogIntent | null>(null);
  const [feedback, setFeedback] = useState<AccountFeedback | null>(null);
  const [pending, setPending] = useState(false);
  const [calibratingAccountId, setCalibratingAccountId] = useState<string | null>(null);
  const [analyticsAccountId, setAnalyticsAccountId] = useState<string | null>(null);
  const [priorityAnalyticsAccountId, setPriorityAnalyticsAccountId] = useState<string | null>(null);
  const [analyticsTab, setAnalyticsTab] = useState<"overview" | "works">("overview");
  const previousRuntimeStates = useRef(new Map<string, string>());
  const refreshingRuntime = useRef(false);
  const loginMonitors = useRef(new Map<string, () => void>());
  const mountedRef = useRef(true);
  const realAccounts = useMemo(
    () =>
      props.accounts.filter(
        (account) =>
          PLATFORMS.some((platform) => platform.key === account.platform) &&
          isRealChannelAccount(account),
      ),
    [props.accounts],
  );
  const realAccountsRef = useRef(realAccounts);
  const onChangedRef = useRef(props.onChanged);
  const onRefreshStatusRef = useRef(props.onRefreshStatus);

  useEffect(() => {
    realAccountsRef.current = realAccounts;
    onChangedRef.current = props.onChanged;
    onRefreshStatusRef.current = props.onRefreshStatus;
  }, [props.onChanged, props.onRefreshStatus, realAccounts]);

  useEffect(() => {
    if (props.demo || onChangedRef.current === undefined) return;
    if (onRefreshStatusRef.current === undefined) {
      const timer = window.setInterval(() => onChangedRef.current?.(), 30_000);
      return () => window.clearInterval(timer);
    }
    const refreshRuntimeStatuses = async () => {
      if (refreshingRuntime.current) {
        onChangedRef.current?.();
        return;
      }
      refreshingRuntime.current = true;
      try {
        await Promise.allSettled(
          realAccountsRef.current
            .filter(
              (account) => account.ctripRuntime !== undefined && account.status !== "disabled",
            )
            .map((account) => onRefreshStatusRef.current?.(account.id)),
        );
      } finally {
        refreshingRuntime.current = false;
        onChangedRef.current?.();
      }
    };
    void refreshRuntimeStatuses();
    const timer = window.setInterval(() => void refreshRuntimeStatuses(), 30_000);
    return () => window.clearInterval(timer);
  }, [props.demo]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      for (const stop of loginMonitors.current.values()) stop();
      loginMonitors.current.clear();
    };
  }, []);

  useEffect(() => {
    const nextStates = new Map<string, string>();
    for (const account of realAccounts) {
      const nextState = account.ctripRuntime?.sessionState ?? "unbound";
      const previousState = previousRuntimeStates.current.get(account.id);
      nextStates.set(account.id, nextState);
      if (previousState === "ready" && nextState !== "ready" && nextState !== "disabled") {
        setFeedback({
          tone: "warning",
          message: `${accountDisplayNameLabel(account.displayName)} 已掉线或需要重新登录，相关自动投放已停止分配。`,
        });
      }
    }
    previousRuntimeStates.current = nextStates;
  }, [realAccounts]);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return realAccounts.filter((account) => {
      const matchesPlatform = platformFilter === "all" || account.platform === platformFilter;
      const matchesStatus = statusFilter === "all" || account.status === statusFilter;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        `${account.displayName} ${accountDisplayNameLabel(account.displayName)} ${account.platform} ${account.capability}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      return matchesPlatform && matchesStatus && matchesQuery;
    });
  }, [platformFilter, query, realAccounts, statusFilter]);
  const analyticsByAccount = useMemo(
    () =>
      new Map(
        (props.analytics?.accounts ?? []).map((account) => [account.channelAccountId, account]),
      ),
    [props.analytics],
  );
  const priorityAnalyticsByAccount = useMemo(
    () =>
      new Map(
        (props.priorityAnalytics?.accounts ?? []).map((account) => [
          account.channelAccountId,
          account,
        ]),
      ),
    [props.priorityAnalytics],
  );
  const selectedAnalytics =
    analyticsAccountId === null ? null : (analyticsByAccount.get(analyticsAccountId) ?? null);
  const selectedPriorityAnalytics =
    priorityAnalyticsAccountId === null
      ? null
      : (priorityAnalyticsByAccount.get(priorityAnalyticsAccountId) ?? null);
  const publicationVerificationAccountIds =
    props.publicationVerificationAccountIds ?? EMPTY_ACCOUNT_ID_SET;

  const readyCount = realAccounts.filter(
    (account) =>
      accountRunState(
        account,
        props.automation ?? null,
        publicationVerificationAccountIds.has(account.id),
      ).tone === "ready",
  ).length;
  const attentionCount = realAccounts.filter((account) => {
    const state = account.ctripRuntime?.sessionState;
    return (
      account.status !== "disabled" &&
      (publicationVerificationAccountIds.has(account.id) ||
        state === "session_required" ||
        state === "challenge_required" ||
        state === "unavailable")
    );
  }).length;
  const activeJobs = realAccounts.reduce(
    (total, account) => total + activeJobCount(account.id, props.publicationJobs ?? []),
    0,
  );
  const platformCount = new Set(realAccounts.map((account) => account.platform)).size;

  function reserveLoginWindow(accountId?: string): Window | null {
    if (typeof window === "undefined") return null;
    const loginWindow =
      window.open("", accountId === undefined ? "_blank" : loginWindowName(accountId)) ?? null;
    if (loginWindow !== null) loginWindow.opener = null;
    return loginWindow;
  }

  function isClosed(loginWindow: Window | null): boolean {
    if (loginWindow === null) return false;
    try {
      return loginWindow.closed;
    } catch {
      return false;
    }
  }

  function closeLoginWindow(loginWindow: Window | null): boolean {
    if (loginWindow === null) return false;
    if (isClosed(loginWindow)) return true;
    try {
      loginWindow.close();
    } catch {
      return false;
    }
    return isClosed(loginWindow);
  }

  function watchLoginStatus(account: ChannelAccount, loginWindow: Window | null): void {
    if (props.demo || onRefreshStatusRef.current === undefined) return;
    loginMonitors.current.get(account.id)?.();

    let stopped = false;
    let inFlight = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      if (loginMonitors.current.get(account.id) === stop) {
        loginMonitors.current.delete(account.id);
      }
    };
    loginMonitors.current.set(account.id, stop);

    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(() => void poll(), LOGIN_STATUS_POLL_INTERVAL_MS);
    };
    const poll = async () => {
      if (stopped) return;
      if (isClosed(loginWindow)) {
        stop();
        return;
      }
      if (Date.now() - startedAt >= LOGIN_STATUS_POLL_TIMEOUT_MS) {
        stop();
        if (mountedRef.current) {
          setFeedback({
            tone: "warning",
            message: `${accountDisplayNameLabel(account.displayName)} 登录状态检测超时，登录窗口仍保持打开。`,
          });
        }
        return;
      }
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const refreshed = await onRefreshStatusRef.current?.(account.id);
        if (
          refreshed?.ctripRuntime?.channelAccountId === account.id &&
          (refreshed.ctripRuntime.sessionAuthenticated === true ||
            refreshed.ctripRuntime.sessionState === "authenticated" ||
            refreshed.ctripRuntime.sessionState === "ready")
        ) {
          stop();
          if (mountedRef.current) {
            setFeedback({
              tone: "success",
              message: `${accountDisplayNameLabel(account.displayName)} 已检测到登录成功；登录窗口保持打开，请手动关闭。`,
            });
            onChangedRef.current?.();
          }
          return;
        }
      } catch (error) {
        if (error instanceof GeoApiError && error.status === 404) {
          stop();
          closeLoginWindow(loginWindow);
          if (mountedRef.current) {
            setFeedback({
              tone: "warning",
              message: `${accountDisplayNameLabel(account.displayName)} 已不存在，登录窗口已关闭。`,
            });
            onChangedRef.current?.();
          }
          return;
        }
        // The regular account-status poll will surface transient API errors; keep retrying.
      } finally {
        inFlight = false;
      }
      schedule();
    };

    schedule();
  }

  async function saveAccount(input: AccountDialogInput) {
    const loginWindow =
      dialog?.type === "create" && props.onOpenLogin !== undefined ? reserveLoginWindow() : null;
    setPending(true);
    setFeedback(null);
    try {
      if (dialog?.type === "create") {
        const account = await props.onCreate(createChannelAccountInput(input));
        if (props.onOpenLogin === undefined) {
          setFeedback({ tone: "success", message: "平台账号已接入" });
        } else {
          if (loginWindow !== null) loginWindow.name = loginWindowName(account.id);
          await openLogin(account, loginWindow);
        }
      } else if (dialog?.type === "edit") {
        await props.onUpdate(dialog.account.id, updateChannelAccountInput(input));
        setFeedback({ tone: "success", message: "平台账号已更新" });
      }
      props.onChanged?.();
      setDialog(null);
    } catch (error) {
      loginWindow?.close();
      setFeedback({
        tone: "warning",
        message: error instanceof Error ? error.message : "平台账号操作失败",
      });
    } finally {
      setPending(false);
    }
  }

  async function openBrowserHandoff(
    account: ChannelAccount,
    openHandoff: (accountId: string) => Promise<{ readonly loginUrl: string }>,
    successMessage: string,
    reservedWindow: Window | null = null,
  ): Promise<void> {
    setPending(true);
    setFeedback(null);
    try {
      const result = await openHandoff(account.id);
      const handoffUrl = createAccountLoginHandoffUrl(result.loginUrl, account.id);
      let loginWindow = reservedWindow;
      if (typeof window !== "undefined") {
        if (reservedWindow === null) {
          loginWindow = window.open(handoffUrl, loginWindowName(account.id)) ?? null;
          if (loginWindow !== null) loginWindow.opener = null;
        } else {
          reservedWindow.name = loginWindowName(account.id);
          reservedWindow.location.replace(handoffUrl);
        }
      }
      if (typeof window !== "undefined" && loginWindow === null) {
        throw new Error("浏览器阻止了账号验证窗口，请允许本站弹出窗口后重试");
      }
      watchLoginStatus(account, loginWindow);
      setFeedback({
        tone: "success",
        message: `${accountDisplayNameLabel(account.displayName)} ${successMessage}`,
      });
    } catch (error) {
      reservedWindow?.close();
      setFeedback({
        tone: "warning",
        message: error instanceof Error ? error.message : "账号登录入口暂不可用",
      });
    } finally {
      setPending(false);
    }
  }

  async function openLogin(
    account: ChannelAccount,
    reservedWindow: Window | null = null,
  ): Promise<void> {
    if (props.onOpenLogin === undefined) return;
    await openBrowserHandoff(
      account,
      props.onOpenLogin,
      "登录窗口已打开；检测到登录成功后会保持打开，请手动关闭。",
      reservedWindow,
    );
  }

  async function openVerification(
    account: ChannelAccount,
    reservedWindow: Window | null = null,
  ): Promise<void> {
    if (props.onOpenVerification === undefined) return;
    await openBrowserHandoff(
      account,
      props.onOpenVerification,
      "验证窗口已打开；完成滑块、扫码或平台安全验证后，系统会自动恢复采集与投放。",
      reservedWindow,
    );
  }

  async function forceCalibrate(account: ChannelAccount): Promise<void> {
    if (props.onForceCalibrate === undefined) return;
    setPending(true);
    setCalibratingAccountId(account.id);
    setFeedback(null);
    try {
      await props.onForceCalibrate(account.id);
      setFeedback({
        tone: "success",
        message: `${accountDisplayNameLabel(account.displayName)} 已人工强制校准为可执行状态。`,
      });
      props.onChanged?.();
    } catch (error) {
      setFeedback({
        tone: "warning",
        message: error instanceof Error ? error.message : "人工强制校准失败",
      });
    } finally {
      setPending(false);
      setCalibratingAccountId(null);
    }
  }

  async function deleteAccount(account: ChannelAccount): Promise<void> {
    if (props.onDelete === undefined || !props.canManage || pending) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `确认移除平台账号“${accountDisplayNameLabel(account.displayName)}”？有历史投放的账号将自动归档并保留记录。`,
      )
    ) {
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await props.onDelete(account.id);
      setFeedback({
        tone: "success",
        message: `${accountDisplayNameLabel(account.displayName)} 已移出账号列表；历史投放记录已保留。`,
      });
      props.onChanged?.();
    } catch (error) {
      setFeedback({
        tone: "warning",
        message: error instanceof Error ? error.message : "平台账号删除失败",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="account-directory">
      {feedback === null ? null : (
        <div
          className={`account-feedback account-feedback-${feedback.tone}`}
          role={feedback.tone === "warning" ? "alert" : "status"}
        >
          {feedback.tone === "warning" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{feedback.message}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={() => setFeedback(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="account-directory-heading">
        <div>
          <p className="eyebrow">运营资源 · 多账号</p>
          <h2>平台账号</h2>
          <p>把多个平台身份放在同一个工作台里，逐账号管理授权、证据和执行边界。</p>
        </div>
        <button
          className="button-primary"
          type="button"
          disabled={!props.canManage}
          title={props.canManage ? undefined : "需要租户管理权限"}
          onClick={() => setDialog({ type: "create" })}
        >
          <Plus size={16} /> 新增平台账号
        </button>
      </div>

      {props.demo ? (
        <div className="account-demo-notice" role="status">
          <ShieldCheck size={16} />
          <span>当前为离线演示数据；真实租户的新增和编辑会写入服务端并留下审计记录。</span>
        </div>
      ) : null}

      <div className="account-summary-grid">
        <div>
          <span>账号总数</span>
          <strong>{realAccounts.length}</strong>
          <small>跨 {platformCount} 个平台</small>
        </div>
        <div>
          <span>可执行</span>
          <strong>{readyCount}</strong>
          <small>登录态与账号级保护均正常</small>
        </div>
        <div className={attentionCount > 0 ? "account-summary-warning" : ""}>
          <span>需处理</span>
          <strong>{attentionCount}</strong>
          <small>{attentionCount > 0 ? "需登录或处理平台挑战" : "当前没有账号异常"}</small>
        </div>
        <div className={activeJobs > 0 ? "account-summary-live" : ""}>
          <span>进行中任务</span>
          <strong>{activeJobs}</strong>
          <small>{activeJobs > 0 ? "按账号隔离的投放队列" : "当前没有账号任务占用"}</small>
        </div>
      </div>

      <div className="account-platform-grid" aria-label="平台筛选">
        <div className={`account-platform-card ${platformFilter === "all" ? "active" : ""}`}>
          <button
            className="account-platform-select"
            type="button"
            aria-pressed={platformFilter === "all"}
            onClick={() => setPlatformFilter("all")}
          >
            <span className="account-platform-mark account-platform-mark-all">全</span>
            <span>
              <strong>全部平台</strong>
              <small>{realAccounts.length} 个账号</small>
            </span>
          </button>
        </div>
        {PLATFORMS.map((platform) => {
          const count = realAccounts.filter((account) => account.platform === platform.key).length;
          return (
            <div
              className={`account-platform-card ${platformFilter === platform.key ? "active" : ""}`}
              key={platform.key}
            >
              <button
                className="account-platform-select"
                type="button"
                aria-pressed={platformFilter === platform.key}
                onClick={() => setPlatformFilter(platform.key)}
              >
                <PlatformLogo platform={platform.key} />
                <span>
                  <strong>{platform.label}</strong>
                  <small>
                    {count} 个账号 · {platform.description}
                  </small>
                </span>
              </button>
              <button
                className="account-platform-add"
                type="button"
                aria-label={`接入 ${platform.label} 账号`}
                title={props.canManage ? `接入 ${platform.label} 账号` : "需要租户管理权限"}
                disabled={!props.canManage}
                onClick={() => setDialog({ type: "create", platform: platform.key })}
              >
                <Plus size={16} />
              </button>
            </div>
          );
        })}
      </div>

      <AllPlatformOperationsDashboard
        platformFilter={platformFilter}
        ctripAnalytics={props.analytics ?? null}
        ctripStatus={props.analyticsStatus ?? "ready"}
        priorityAnalytics={props.priorityAnalytics ?? null}
        priorityStatus={props.priorityAnalyticsStatus ?? "ready"}
        onOpenAccount={(account) => {
          if (account.platform === "ctrip_community") {
            setAnalyticsAccountId(account.channelAccountId);
            setAnalyticsTab("overview");
          } else {
            setPriorityAnalyticsAccountId(account.channelAccountId);
          }
        }}
      />

      <section className="account-table-panel">
        <div className="account-toolbar">
          <label className="account-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">搜索平台账号</span>
            <input
              value={query}
              placeholder="搜索账号名称、平台或能力"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="account-filter-group" aria-label="账号状态筛选">
            {(["all", "active", "disabled"] as const).map((status) => (
              <button
                className={statusFilter === status ? "active" : ""}
                type="button"
                key={status}
                onClick={() => setStatusFilter(status)}
              >
                {status === "all" ? "全部" : statusLabel(status)}
              </button>
            ))}
          </div>
        </div>

        {filteredAccounts.length === 0 ? (
          <div className="account-empty" role="status">
            <AlertTriangle size={18} />
            <strong>没有符合条件的平台账号</strong>
            <span>调整平台、状态或搜索词后再试。</span>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="account-directory-table">
              <thead>
                <tr>
                  <th>平台账号</th>
                  <th>授权能力</th>
                  <th>执行级别</th>
                  <th>投放容量</th>
                  <th>流量</th>
                  <th>能力证据</th>
                  <th>运行状态</th>
                  <th>状态更新时间</th>
                  <th>任务</th>
                  <th className="account-directory-operation-column" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((account) => {
                  const platform = platformMeta(account.platform);
                  const publicationVerificationRequired = publicationVerificationAccountIds.has(
                    account.id,
                  );
                  const runState = accountRunState(
                    account,
                    props.automation ?? null,
                    publicationVerificationRequired,
                  );
                  const jobs = activeJobCount(account.id, props.publicationJobs ?? []);
                  const pendingConfirmations = pendingConfirmationCount(
                    account.id,
                    props.publicationJobs ?? [],
                  );
                  const hasAuthenticatedSession =
                    account.ctripRuntime?.sessionState === "ready" ||
                    account.ctripRuntime?.sessionState === "authenticated";
                  const accountCircuitRequiresCalibration = circuitBlocksAccount(
                    props.automation?.circuits.find(
                      (candidate) =>
                        candidate.scopeType === "account" && candidate.scopeKey === account.id,
                    ),
                  );
                  const accountAnalytics = analyticsByAccount.get(account.id);
                  const priorityAccountAnalytics = priorityAnalyticsByAccount.get(account.id);
                  const verificationRequired =
                    publicationVerificationRequired ||
                    account.ctripRuntime?.sessionState === "challenge_required" ||
                    analyticsRequiresManualVerification(accountAnalytics?.lastErrorCode) ||
                    analyticsRequiresManualVerification(priorityAccountAnalytics?.lastErrorCode);
                  return (
                    <tr key={account.id}>
                      <td>
                        <div className="account-name-cell">
                          <PlatformLogo platform={platform.key} />
                          <span>
                            <strong>{accountDisplayNameLabel(account.displayName)}</strong>
                            <small>{platform.label}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="account-capability">
                          {capabilityLabel(account.capability)}
                        </span>
                      </td>
                      <td>
                        <div className="account-levels">
                          {account.supportedExecutionLevels.map((level) => (
                            <span key={level}>{executionLabel(level)}</span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="account-capacity">
                          <strong>{account.dailyPublishQuota ?? 30} 篇/日</strong>
                          <small>并发 {account.maxConcurrentPublications ?? 1}</small>
                        </div>
                      </td>
                      <td>
                        {account.platform !== "ctrip_community" ? (
                          priorityAccountAnalytics === undefined ? (
                            <span className="muted">待采集</span>
                          ) : priorityAnalyticsRequiresManualVerification(
                              priorityAccountAnalytics,
                            ) ? (
                            <span className="muted">需人工验证</span>
                          ) : priorityAccountAnalytics.observedAt === null ? (
                            <span className="muted">待采集</span>
                          ) : priorityAccountAnalytics.dataStatus === "pending" ? (
                            <span className="muted">平台待出数</span>
                          ) : (
                            <div className="account-traffic-cell">
                              <strong>
                                {formatMetric(priorityAccountAnalytics.totalImpressions)} 展现
                              </strong>
                              <small>
                                {formatMetric(priorityAccountAnalytics.totalReads)} 阅读
                              </small>
                            </div>
                          )
                        ) : accountAnalytics === undefined ||
                          accountAnalytics.observedAt === null ? (
                          <span className="muted">待采集</span>
                        ) : accountAnalytics.dataStatus === "pending" ? (
                          <span className="muted">平台待出数</span>
                        ) : (
                          <div className="account-traffic-cell">
                            <strong>热度 {formatMetric(accountAnalytics.contentHeat)}</strong>
                            <small>{formatMetric(accountAnalytics.totalViews)} 浏览</small>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="account-evidence">
                          {evidenceLabel(account.evidenceType)}
                        </span>
                      </td>
                      <td>
                        <span className={`account-status account-status-${runState.tone}`}>
                          {runState.label}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            (account.ctripRuntime?.lastCheckedAt ?? account.lastVerifiedAt) === null
                              ? "muted"
                              : ""
                          }
                          title={
                            account.ctripRuntime?.lastCheckedAt === null ||
                            account.ctripRuntime?.lastCheckedAt === undefined
                              ? undefined
                              : `运行时回读：${account.ctripRuntime.lastCheckedAt}`
                          }
                        >
                          {checkedLabel(
                            account.ctripRuntime?.lastCheckedAt ?? account.lastVerifiedAt,
                          )}
                        </span>
                      </td>
                      <td>
                        {jobs > 0 ? (
                          <span className="account-job-count account-job-active">
                            <Clock3 size={13} /> {jobs} 个进行中
                          </span>
                        ) : pendingConfirmations > 0 ? (
                          <span className="account-job-count account-job-pending">
                            <Clock3 size={13} /> {pendingConfirmations} 个待确认
                          </span>
                        ) : (
                          <span className="account-job-count">暂无任务</span>
                        )}
                      </td>
                      <td className="account-directory-operation-column">
                        {account.platform === "ctrip_community" ? (
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`查看流量分析 ${accountDisplayNameLabel(account.displayName)}`}
                            title="查看流量分析"
                            disabled={accountAnalytics === undefined}
                            onClick={() => {
                              setAnalyticsAccountId(account.id);
                              setAnalyticsTab("overview");
                            }}
                          >
                            <BarChart3 size={16} />
                          </button>
                        ) : priorityAccountAnalytics !== undefined ? (
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`查看流量分析 ${accountDisplayNameLabel(account.displayName)}`}
                            title="查看流量分析"
                            onClick={() => setPriorityAnalyticsAccountId(account.id)}
                          >
                            <BarChart3 size={16} />
                          </button>
                        ) : null}
                        {account.ctripRuntime !== undefined &&
                        account.ctripRuntime.sessionState !== "disabled" &&
                        ((account.ctripRuntime.sessionState !== "ready" &&
                          account.ctripRuntime.sessionState !== "authenticated") ||
                          accountCircuitRequiresCalibration) ? (
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`人工强制校准 ${accountDisplayNameLabel(account.displayName)}`}
                            title="人工强制校准运行时并解除账号熔断"
                            disabled={
                              !props.canManage ||
                              props.onForceCalibrate === undefined ||
                              pending ||
                              calibratingAccountId !== null
                            }
                            onClick={() => void forceCalibrate(account)}
                          >
                            <Settings2 size={16} />
                          </button>
                        ) : null}
                        {verificationRequired ? (
                          <button
                            className="account-verify-button"
                            type="button"
                            aria-label={`快速验证 ${accountDisplayNameLabel(account.displayName)}`}
                            title="打开当前账号浏览器并保留挑战现场"
                            disabled={
                              !props.canManage || props.onOpenVerification === undefined || pending
                            }
                            onClick={() =>
                              void openVerification(account, reserveLoginWindow(account.id))
                            }
                          >
                            <ShieldCheck size={15} />
                            <span>快速验证</span>
                          </button>
                        ) : account.ctripRuntime !== undefined &&
                          account.ctripRuntime.sessionState !== "disabled" ? (
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`${hasAuthenticatedSession ? "重新登录" : "补登录"} ${accountDisplayNameLabel(account.displayName)}`}
                            title={
                              hasAuthenticatedSession ? "重新打开平台登录页" : "补登录平台账号"
                            }
                            disabled={
                              !props.canManage || props.onOpenLogin === undefined || pending
                            }
                            onClick={() => void openLogin(account, reserveLoginWindow(account.id))}
                          >
                            {hasAuthenticatedSession ? (
                              <ExternalLink size={16} />
                            ) : (
                              <LogIn size={16} />
                            )}
                          </button>
                        ) : null}
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`管理 ${accountDisplayNameLabel(account.displayName)}`}
                          title={props.canManage ? "管理平台账号" : "需要租户管理权限"}
                          disabled={!props.canManage}
                          onClick={() => setDialog({ type: "edit", account })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button icon-button-danger"
                          type="button"
                          aria-label={`删除 ${accountDisplayNameLabel(account.displayName)}`}
                          title={props.canManage ? "删除平台账号" : "需要租户管理权限"}
                          disabled={!props.canManage || props.onDelete === undefined || pending}
                          onClick={() => void deleteAccount(account)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="account-table-footer">
          <Users size={14} />
          <span>
            显示 {filteredAccounts.length} / {realAccounts.length} 个账号
          </span>
          <span className="account-table-footer-spacer" />
          <span>账号身份、队列和自动化保护均按租户与账号隔离。</span>
        </div>
      </section>

      {dialog !== null ? (
        <ChannelAccountDialog
          title={
            dialog.type === "create"
              ? "接入平台账号"
              : `管理 ${accountDisplayNameLabel(dialog.account.displayName)}`
          }
          {...(dialog.type === "create"
            ? {
                initialPlatform: dialog.platform ?? "toutiao",
                ...(dialog.platform === undefined ? {} : { onboardingPlatform: dialog.platform }),
              }
            : { account: dialog.account })}
          pending={pending}
          onClose={() => setDialog(null)}
          onSubmit={saveAccount}
        />
      ) : null}
      {selectedAnalytics === null ? null : (
        <AccountAnalyticsDialog
          analytics={selectedAnalytics}
          tab={analyticsTab}
          onTabChange={setAnalyticsTab}
          onClose={() => setAnalyticsAccountId(null)}
        />
      )}
      {selectedPriorityAnalytics === null ? null : (
        <PriorityPlatformAnalyticsDialog
          analytics={selectedPriorityAnalytics}
          onClose={() => setPriorityAnalyticsAccountId(null)}
        />
      )}
    </div>
  );
}

function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) return "--";
  const compact = value >= 10_000;
  return new Intl.NumberFormat("zh-CN", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function priorityAnalyticsRequiresManualVerification(
  analytics: PriorityPlatformAccountAnalytics,
): boolean {
  return analyticsRequiresManualVerification(analytics.lastErrorCode);
}

function analyticsRequiresManualVerification(errorCode: string | null | undefined): boolean {
  return errorCode?.endsWith("CHALLENGE_REQUIRED") ?? false;
}

function priorityAnalyticsStatusLabel(analytics: PriorityPlatformAccountAnalytics): string {
  if (priorityAnalyticsRequiresManualVerification(analytics)) {
    return "需人工完成平台验证，验证后可重新采集";
  }
  if (analytics.dataStatus === "pending") return "平台待出数，系统会自动重试";
  if (analytics.observedAt === null) return "等待首轮采集";
  return `更新于 ${checkedLabel(analytics.observedAt)}`;
}

interface UnifiedPlatformAnalyticsAccount {
  readonly channelAccountId: string;
  readonly platform: PlatformKey;
  readonly displayName: string;
  readonly dataStatus: "pending" | "ready";
  readonly publishCount: number | null;
  readonly impressions: number | null;
  readonly reads: number | null;
  readonly favorites: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly requiresManualVerification: boolean;
}

function availableMetricTotal(
  accounts: readonly UnifiedPlatformAnalyticsAccount[],
  select: (account: UnifiedPlatformAnalyticsAccount) => number | null,
): number | null {
  const values = accounts.flatMap((account) => {
    const value = select(account);
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

function AllPlatformOperationsDashboard({
  platformFilter,
  ctripAnalytics,
  ctripStatus,
  priorityAnalytics,
  priorityStatus,
  onOpenAccount,
}: {
  readonly platformFilter: PlatformKey | "all";
  readonly ctripAnalytics: CtripPlatformAnalyticsDashboard | null;
  readonly ctripStatus: "loading" | "ready" | "error";
  readonly priorityAnalytics: PriorityPlatformAnalyticsDashboard | null;
  readonly priorityStatus: "loading" | "ready" | "error";
  readonly onOpenAccount: (account: UnifiedPlatformAnalyticsAccount) => void;
}) {
  const accounts = [
    ...(ctripAnalytics?.accounts.map((account): UnifiedPlatformAnalyticsAccount => ({
      channelAccountId: account.channelAccountId,
      platform: "ctrip_community",
      displayName: account.displayName,
      dataStatus: account.dataStatus,
      publishCount: account.publishCount,
      impressions: null,
      reads: account.totalViews,
      favorites: account.totalFavorites,
      likes: account.totalLikes,
      comments: account.totalComments,
      requiresManualVerification: analyticsRequiresManualVerification(account.lastErrorCode),
    })) ?? []),
    ...(priorityAnalytics?.accounts.map((account): UnifiedPlatformAnalyticsAccount => ({
      channelAccountId: account.channelAccountId,
      platform: account.platform,
      displayName: account.displayName,
      dataStatus: account.dataStatus,
      publishCount: account.publishCount,
      impressions: account.totalImpressions,
      reads: account.totalReads,
      favorites: null,
      likes: account.totalLikes,
      comments: account.totalComments,
      requiresManualVerification: priorityAnalyticsRequiresManualVerification(account),
    })) ?? []),
  ].filter((account) => platformFilter === "all" || account.platform === platformFilter);
  const sourceStatuses =
    platformFilter === "ctrip_community"
      ? [ctripStatus]
      : platformFilter === "all"
        ? [ctripStatus, priorityStatus]
        : [priorityStatus];
  const status = sourceStatuses.includes("error")
    ? "error"
    : sourceStatuses.includes("loading")
      ? "loading"
      : "ready";
  const reportingAccountCount = accounts.filter((account) => account.dataStatus === "ready").length;
  const metrics = [
    ["发布", availableMetricTotal(accounts, (account) => account.publishCount)],
    ["展现", availableMetricTotal(accounts, (account) => account.impressions)],
    ["阅读", availableMetricTotal(accounts, (account) => account.reads)],
    ["收藏", availableMetricTotal(accounts, (account) => account.favorites)],
    ["点赞", availableMetricTotal(accounts, (account) => account.likes)],
    ["评论", availableMetricTotal(accounts, (account) => account.comments)],
  ] as const;
  return (
    <section className="account-analytics-board" aria-label="全平台运营概览">
      <header className="account-analytics-heading">
        <div>
          <span className="account-platform-mark account-platform-mark-all">
            <BarChart3 size={17} aria-hidden="true" />
          </span>
          <span>
            <strong>全平台运营概览</strong>
            <small>
              {status === "error" && accounts.length === 0
                ? "分析数据读取失败"
                : `${reportingAccountCount} / ${accounts.length} 个账号已更新`}
            </small>
          </span>
        </div>
        <span className={`account-analytics-sync account-analytics-sync-${status}`}>
          <Clock3 size={13} /> 每小时更新
        </span>
      </header>
      <div className="account-analytics-metrics account-analytics-metrics-unified">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{formatMetric(value)}</strong>
          </div>
        ))}
      </div>
      <div className="account-heat-ranking">
        <div className="account-heat-ranking-title">
          <BarChart3 size={15} />
          <strong>账号基础数据</strong>
        </div>
        {accounts.length === 0 ? (
          <span className="muted">暂无平台分析快照</span>
        ) : (
          <ol>
            {accounts.map((account, index) => (
              <li key={account.channelAccountId}>
                <button type="button" onClick={() => onOpenAccount(account)}>
                  <span className="account-heat-rank">{index + 1}</span>
                  <span className="account-heat-name">
                    {accountDisplayNameLabel(account.displayName)}
                  </span>
                  <span className="account-analytics-platform-label">
                    {platformMeta(account.platform).label}
                  </span>
                  <strong>
                    {account.requiresManualVerification
                      ? "需人工验证"
                      : account.dataStatus === "pending"
                        ? "平台待出数"
                        : `${formatMetric(account.reads)} 阅读`}
                  </strong>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function PriorityPlatformAnalyticsDialog({
  analytics,
  onClose,
}: {
  readonly analytics: PriorityPlatformAccountAnalytics;
  readonly onClose: () => void;
}) {
  const dialogRef = useModalDialog<HTMLElement>(onClose);
  return (
    <div className="account-analytics-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="account-analytics-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="priority-account-analytics-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">{platformMeta(analytics.platform).label}账号流量</p>
            <h2 id="priority-account-analytics-dialog-title">
              {accountDisplayNameLabel(analytics.displayName)}
            </h2>
            <span>{priorityAnalyticsStatusLabel(analytics)}</span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭流量分析" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="account-analytics-metrics">
          <div>
            <span>发布数</span>
            <strong>{formatMetric(analytics.publishCount)}</strong>
          </div>
          <div>
            <span>展现</span>
            <strong>{formatMetric(analytics.totalImpressions)}</strong>
          </div>
          <div>
            <span>阅读</span>
            <strong>{formatMetric(analytics.totalReads)}</strong>
          </div>
          <div>
            <span>点赞</span>
            <strong>{formatMetric(analytics.totalLikes)}</strong>
          </div>
          <div>
            <span>评论</span>
            <strong>{formatMetric(analytics.totalComments)}</strong>
          </div>
        </div>
        <div
          className="table-scroll account-analytics-works"
          role="region"
          aria-label="作品流量明细"
        >
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>时间</th>
                <th>展现</th>
                <th>阅读</th>
                <th>点赞</th>
                <th>评论</th>
              </tr>
            </thead>
            <tbody>
              {analytics.works.map((work) => (
                <tr key={`${work.externalId}-${work.publishedAt}`}>
                  <td>
                    <a href={work.externalUrl} target="_blank" rel="noreferrer">
                      {work.title}
                    </a>
                  </td>
                  <td>{work.status}</td>
                  <td>{work.publishedAt}</td>
                  <td>{formatMetric(work.impressions)}</td>
                  <td>{formatMetric(work.reads)}</td>
                  <td>{formatMetric(work.likes)}</td>
                  <td>{formatMetric(work.comments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {analytics.works.length === 0 ? (
            <div className="account-empty">
              <span>暂无单条数据</span>
            </div>
          ) : null}
        </div>
        {priorityAnalyticsRequiresManualVerification(analytics) ? (
          <div className="account-analytics-error" role="status">
            <AlertTriangle size={14} />{" "}
            已停止自动采集，请在账号登录窗口完成滑块或扫码验证后重新采集。
          </div>
        ) : analytics.lastErrorMessage === null ? null : (
          <div className="account-analytics-error" role="status">
            <AlertTriangle size={14} /> 最近一次更新失败：{analytics.lastErrorMessage}
          </div>
        )}
      </section>
    </div>
  );
}

function AccountAnalyticsDialog({
  analytics,
  tab,
  onTabChange,
  onClose,
}: {
  readonly analytics: CtripAccountAnalytics;
  readonly tab: "overview" | "works";
  readonly onTabChange: (tab: "overview" | "works") => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useModalDialog<HTMLElement>(onClose);
  return (
    <div className="account-analytics-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="account-analytics-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-analytics-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">携程账号流量</p>
            <h2 id="account-analytics-dialog-title">
              {accountDisplayNameLabel(analytics.displayName)}
            </h2>
            <span>
              {analytics.dataStatus === "pending"
                ? "平台待出数，系统会自动重试"
                : analytics.observedAt === null
                  ? "等待首轮采集"
                  : `更新于 ${checkedLabel(analytics.observedAt)}`}
            </span>
          </div>
          <button className="icon-button" type="button" aria-label="关闭流量分析" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="account-analytics-tabs" role="tablist" aria-label="账号流量视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            className={tab === "overview" ? "active" : ""}
            onClick={() => onTabChange("overview")}
          >
            内容概况
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "works"}
            className={tab === "works" ? "active" : ""}
            onClick={() => onTabChange("works")}
          >
            单条分析
          </button>
        </div>
        {tab === "overview" ? (
          <div className="account-analytics-overview" role="tabpanel">
            <div className="account-analytics-detail-metrics">
              <div>
                <span>发布数</span>
                <strong>
                  {formatMetric(analytics.dataStatus === "ready" ? analytics.publishCount : null)}
                </strong>
              </div>
              <div>
                <span>精选数</span>
                <strong>
                  {formatMetric(analytics.dataStatus === "ready" ? analytics.featuredCount : null)}
                </strong>
              </div>
              <div>
                <span>优质数</span>
                <strong>
                  {formatMetric(analytics.dataStatus === "ready" ? analytics.qualityCount : null)}
                </strong>
              </div>
              <div>
                <span>精优率</span>
                <strong>
                  {analytics.dataStatus === "pending" || analytics.featuredQualityRate === null
                    ? "--"
                    : `${analytics.featuredQualityRate}%`}
                </strong>
              </div>
              <div>
                <span>内容热度</span>
                <strong>
                  {formatMetric(analytics.dataStatus === "ready" ? analytics.contentHeat : null)}
                </strong>
              </div>
              <div>
                <span>浏览次数</span>
                <strong>
                  {formatMetric(analytics.dataStatus === "ready" ? analytics.totalViews : null)}
                </strong>
              </div>
            </div>
            <div className="account-traffic-sources">
              <strong>流量来源</strong>
              {analytics.dataStatus === "pending" ? (
                <span className="muted">平台待出数</span>
              ) : Object.entries(analytics.trafficSources).length === 0 ? (
                <span className="muted">暂无来源数据</span>
              ) : (
                Object.entries(analytics.trafficSources)
                  .sort((left, right) => right[1] - left[1])
                  .map(([source, percent]) => (
                    <div key={source}>
                      <span>{source}</span>
                      <span className="account-source-track">
                        <span style={{ width: `${Math.min(100, percent)}%` }} />
                      </span>
                      <strong>{percent}%</strong>
                    </div>
                  ))
              )}
            </div>
            {analytics.lastErrorMessage === null ? null : (
              <div className="account-analytics-error" role="status">
                <AlertTriangle size={14} /> 最近一次更新失败：{analytics.lastErrorMessage}
              </div>
            )}
          </div>
        ) : (
          <div className="table-scroll account-analytics-works" role="tabpanel">
            <table>
              <thead>
                <tr>
                  <th>作品名称</th>
                  <th>发布时间</th>
                  <th>浏览次数</th>
                  <th>浏览人数</th>
                  <th>互动次数</th>
                  <th>互动人数</th>
                </tr>
              </thead>
              <tbody>
                {analytics.works.map((work) => (
                  <tr key={`${work.title}-${work.publishedAt}`}>
                    <td>{work.title}</td>
                    <td>{work.publishedAt}</td>
                    <td>{formatMetric(analytics.dataStatus === "ready" ? work.views : null)}</td>
                    <td>{formatMetric(analytics.dataStatus === "ready" ? work.viewers : null)}</td>
                    <td>
                      {formatMetric(analytics.dataStatus === "ready" ? work.interactions : null)}
                    </td>
                    <td>
                      {formatMetric(analytics.dataStatus === "ready" ? work.interactors : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {analytics.works.length === 0 ? (
              <div className="account-empty">
                <span>暂无单条数据</span>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
