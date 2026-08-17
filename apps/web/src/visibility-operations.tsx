import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  FileInput,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
  Zap,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  GeoApiError,
  type GeoApi,
  type QuerySet,
  type VisibilityMetric,
  type VisibilityProvider,
  type VisibilityRun,
  type VisibilityRunDetail,
} from "./api.js";
import {
  evidenceTypeLabel,
  findingSeverityLabel,
  observationMethodLabel,
  searchModeLabel,
  sentimentLabel,
} from "./operation-labels.js";
import "./execution-console.css";

interface QueryPrompt {
  readonly key: string;
  readonly prompt: string;
}

interface ManualSampleDraft {
  readonly id: string;
  readonly queryKey: string;
  readonly rawAnswer: string;
  readonly citedUrls: string;
  readonly requestStartedAt: string;
  readonly responseReceivedAt: string;
}

interface OperationFeedback {
  readonly tone: "success" | "error";
  readonly text: string;
}

function apiError(error: unknown): string {
  if (error instanceof GeoApiError) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    return `${error.code}: ${error.message}${request}`;
  }
  return error instanceof Error ? error.message : "未知错误";
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
    hour12: false,
  }).format(timestamp);
}

function localDateTime(value = new Date()): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function requestKey(kind: "fixture" | "manual", tenantId: string): string {
  const nonce =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-visibility:${kind}:${tenantId}:${nonce}`;
}

function providerLabel(provider: VisibilityProvider): string {
  return provider === "doubao" ? "豆包" : "千问";
}

function runEvidenceLabel(run: VisibilityRun): string {
  return observationMethodLabel(run.observationMethod);
}

function runStatusLabel(status: VisibilityRun["status"]): string {
  return (
    {
      queued: "等待运行",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
    }[status] ?? status
  );
}

function runStatusTone(status: VisibilityRun["status"]): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function extractPrompts(querySet: QuerySet | undefined): readonly QueryPrompt[] {
  if (!Array.isArray(querySet?.prompts)) return [];
  return querySet.prompts.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    return typeof item.key === "string" && typeof item.prompt === "string"
      ? [{ key: item.key, prompt: item.prompt }]
      : [];
  });
}

function newManualSample(queryKey = ""): ManualSampleDraft {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sample-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const timestamp = localDateTime();
  return {
    id,
    queryKey,
    rawAnswer: "",
    citedUrls: "",
    requestStartedAt: timestamp,
    responseReceivedAt: timestamp,
  };
}

function safeCitationUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseCitedUrls(value: string): readonly string[] {
  const urls = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const value of urls) {
    if (safeCitationUrl(value) === null) {
      throw new TypeError(`引用 URL 仅支持 http/https: ${value}`);
    }
  }
  return urls;
}

function formatMetric(metric: VisibilityMetric): string {
  if (/rate|accuracy|share/i.test(metric.name) && metric.value >= 0 && metric.value <= 1) {
    return `${(metric.value * 100).toFixed(1)}%`;
  }
  return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(3);
}

function Feedback({ value }: { readonly value: OperationFeedback | null }) {
  if (value === null) return null;
  return (
    <div
      className={`visibility-feedback ${value.tone === "error" ? "visibility-feedback-error" : ""}`}
      role={value.tone === "error" ? "alert" : "status"}
    >
      {value.tone === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      <span>{value.text}</span>
    </div>
  );
}

export function VisibilityOperations({
  api,
  tenantId,
  querySets,
  capabilities,
  onChanged,
}: {
  readonly api: GeoApi;
  readonly tenantId: string;
  readonly querySets: readonly QuerySet[];
  readonly capabilities: readonly string[];
  readonly onChanged?: () => void;
}) {
  const scopeRef = useRef(tenantId);
  const detailRequestRef = useRef(0);
  const activeQuerySets = useMemo(
    () => querySets.filter((item) => item.status === "active" && item.currentVersionId !== null),
    [querySets],
  );
  const [commandMode, setCommandMode] = useState<"fixture" | "manual">("fixture");
  const [provider, setProvider] = useState<VisibilityProvider>("doubao");
  const [querySetVersionId, setQuerySetVersionId] = useState("");
  const [sampleCount, setSampleCount] = useState(2);
  const [productSurface, setProductSurface] = useState("doubao-web-search");
  const [model, setModel] = useState("manual-observed-unknown");
  const [searchMode, setSearchMode] = useState<"on" | "off" | "unknown">("on");
  const [locale, setLocale] = useState("zh-CN");
  const [geo, setGeo] = useState("CN");
  const [manualSamples, setManualSamples] = useState<readonly ManualSampleDraft[]>([
    newManualSample(),
  ]);
  const [runs, setRuns] = useState<readonly VisibilityRun[]>([]);
  const [runQuery, setRunQuery] = useState("");
  const [runStatusFilter, setRunStatusFilter] = useState<"all" | "active" | "completed" | "failed">(
    "all",
  );
  const [runProviderFilter, setRunProviderFilter] = useState<"all" | VisibilityProvider>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VisibilityRunDetail | null>(null);
  const [runsLoading, setRunsLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [feedback, setFeedback] = useState<OperationFeedback | null>(null);
  const selectedQuerySet = activeQuerySets.find(
    (item) => item.currentVersionId === querySetVersionId,
  );
  const prompts = useMemo(() => extractPrompts(selectedQuerySet), [selectedQuerySet]);
  const canRun = capabilities.includes("visibility:run");
  const visibleRuns = useMemo(() => {
    const query = runQuery.trim().toLocaleLowerCase("zh-CN");
    const priority: Readonly<Record<VisibilityRun["status"], number>> = {
      failed: 0,
      running: 1,
      queued: 2,
      completed: 3,
    };
    return [...runs]
      .filter((run) => {
        const matchesStatus =
          runStatusFilter === "all" ||
          (runStatusFilter === "active"
            ? run.status === "queued" || run.status === "running"
            : run.status === runStatusFilter);
        const matchesProvider = runProviderFilter === "all" || run.provider === runProviderFilter;
        const matchesQuery =
          query === "" ||
          [run.productSurface, run.model, run.id, run.status].some((value) =>
            value.toLocaleLowerCase("zh-CN").includes(query),
          );
        return matchesStatus && matchesProvider && matchesQuery;
      })
      .sort(
        (left, right) =>
          priority[left.status] - priority[right.status] ||
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
  }, [runProviderFilter, runQuery, runs, runStatusFilter]);
  const prioritizedObservations = useMemo(
    () =>
      detail === null
        ? []
        : [...detail.observations].sort(
            (left, right) =>
              Number(right.harmfulError) - Number(left.harmfulError) ||
              right.hallucinationFindings.filter((finding) => finding.severity === "high").length -
                left.hallucinationFindings.filter((finding) => finding.severity === "high").length,
          ),
    [detail],
  );

  useEffect(() => {
    const firstVersion = activeQuerySets[0]?.currentVersionId ?? "";
    if (!activeQuerySets.some((item) => item.currentVersionId === querySetVersionId)) {
      setQuerySetVersionId(firstVersion);
    }
  }, [activeQuerySets, querySetVersionId]);

  useEffect(() => {
    const firstQueryKey = prompts[0]?.key ?? "";
    setManualSamples((current) =>
      current.map((sample) =>
        prompts.some((prompt) => prompt.key === sample.queryKey)
          ? sample
          : { ...sample, queryKey: firstQueryKey },
      ),
    );
  }, [prompts]);

  useEffect(() => {
    scopeRef.current = tenantId;
    detailRequestRef.current += 1;
    setCommandMode("fixture");
    setProvider("doubao");
    setSampleCount(2);
    setProductSurface("doubao-web-search");
    setModel("manual-observed-unknown");
    setSearchMode("on");
    setLocale("zh-CN");
    setGeo("CN");
    setManualSamples([newManualSample()]);
    setRuns([]);
    setRunQuery("");
    setRunStatusFilter("all");
    setRunProviderFilter("all");
    setSelectedRunId(null);
    setDetail(null);
    setFeedback(null);
    setRunsLoading(true);
    let active = true;
    void api
      .getVisibilityRuns()
      .then(async (items) => {
        if (!active || scopeRef.current !== tenantId) return;
        setRuns(items);
        const first = items.find((run) => run.status === "failed") ?? items[0];
        if (first === undefined) return;
        setSelectedRunId(first.id);
        setDetailLoading(true);
        const request = ++detailRequestRef.current;
        const nextDetail = await api.getVisibilityRun(first.id);
        if (!active || scopeRef.current !== tenantId || detailRequestRef.current !== request)
          return;
        if (nextDetail.run.id !== first.id) {
          throw new TypeError("可见性详情回读的 run ID 与列表不一致");
        }
        setDetail(nextDetail);
      })
      .catch((error: unknown) => {
        if (active && scopeRef.current === tenantId) {
          setFeedback({ tone: "error", text: apiError(error) });
        }
      })
      .finally(() => {
        if (active && scopeRef.current === tenantId) {
          setRunsLoading(false);
          setDetailLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, tenantId]);

  async function loadDetail(runId: string): Promise<void> {
    const scope = tenantId;
    const request = ++detailRequestRef.current;
    setSelectedRunId(runId);
    setDetail(null);
    setDetailLoading(true);
    setFeedback(null);
    try {
      const next = await api.getVisibilityRun(runId);
      if (scopeRef.current !== scope || detailRequestRef.current !== request) return;
      if (next.run.id !== runId) {
        throw new TypeError("可见性详情回读的 run ID 与请求不一致");
      }
      setDetail(next);
    } catch (error) {
      if (scopeRef.current === scope && detailRequestRef.current === request) {
        setFeedback({ tone: "error", text: apiError(error) });
      }
    } finally {
      if (scopeRef.current === scope && detailRequestRef.current === request) {
        setDetailLoading(false);
      }
    }
  }

  async function refreshRuns(preferredRunId?: string): Promise<void> {
    const scope = tenantId;
    const nextRuns = await api.getVisibilityRuns();
    if (scopeRef.current !== scope) return;
    setRuns(nextRuns);
    if (preferredRunId !== undefined && !nextRuns.some((run) => run.id === preferredRunId)) {
      throw new TypeError("新建的可见性运行未出现在列表回读中");
    }
    const nextRunId =
      preferredRunId !== undefined && nextRuns.some((run) => run.id === preferredRunId)
        ? preferredRunId
        : (nextRuns.find((run) => run.status === "failed")?.id ?? nextRuns[0]?.id ?? null);
    if (nextRunId === null) {
      setSelectedRunId(null);
      setDetail(null);
      return;
    }
    await loadDetail(nextRunId);
  }

  async function reloadRuns(): Promise<void> {
    const scope = tenantId;
    setRunsLoading(true);
    setFeedback(null);
    try {
      await refreshRuns(selectedRunId ?? undefined);
    } catch (error) {
      if (scopeRef.current === scope) setFeedback({ tone: "error", text: apiError(error) });
    } finally {
      if (scopeRef.current === scope) setRunsLoading(false);
    }
  }

  async function submitFixture(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRun || querySetVersionId === "") return;
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 20) {
      setFeedback({ tone: "error", text: "重复采样次数必须是 1-20 的整数" });
      return;
    }
    const scope = tenantId;
    setOperationPending(true);
    setFeedback(null);
    try {
      const result = await api.runFixtureVisibility({
        querySetVersionId,
        provider,
        sampleCount,
        idempotencyKey: requestKey("fixture", tenantId),
      });
      if (result.providerMode !== "fixture" || result.evidenceType !== "fixture") {
        throw new TypeError("固定样本评测返回了不一致的证据类型");
      }
      if (scopeRef.current !== scope) return;
      await refreshRuns(result.visibilityRunId);
      if (scopeRef.current === scope) {
        setFeedback({
          tone: "success",
          text: `${providerLabel(provider)} 固定样本评测已持久化并回读；未调用外部模型。`,
        });
        onChanged?.();
      }
    } catch (error) {
      if (scopeRef.current === scope) setFeedback({ tone: "error", text: apiError(error) });
    } finally {
      if (scopeRef.current === scope) setOperationPending(false);
    }
  }

  async function submitManual(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRun || querySetVersionId === "" || prompts.length === 0) return;
    const scope = tenantId;
    setOperationPending(true);
    setFeedback(null);
    try {
      const samples = manualSamples.map((sample, index) => {
        if (sample.queryKey === "" || sample.rawAnswer.trim() === "") {
          throw new TypeError(`第 ${index + 1} 条观察缺少问题或原始回答`);
        }
        const requestStartedAt = new Date(sample.requestStartedAt);
        const responseReceivedAt = new Date(sample.responseReceivedAt);
        if (
          !Number.isFinite(requestStartedAt.getTime()) ||
          !Number.isFinite(responseReceivedAt.getTime())
        ) {
          throw new TypeError(`第 ${index + 1} 条请求或响应时间无效`);
        }
        if (responseReceivedAt.getTime() < requestStartedAt.getTime()) {
          throw new TypeError(`第 ${index + 1} 条响应时间不能早于请求时间`);
        }
        return {
          queryKey: sample.queryKey,
          rawAnswer: sample.rawAnswer.trim(),
          citedUrls: parseCitedUrls(sample.citedUrls),
          requestStartedAt: requestStartedAt.toISOString(),
          responseReceivedAt: responseReceivedAt.toISOString(),
          observedAt: responseReceivedAt.toISOString(),
        };
      });
      const result = await api.importVisibility({
        querySetVersionId,
        provider,
        productSurface: productSurface.trim(),
        model: model.trim(),
        searchMode,
        locale: locale.trim(),
        geo: geo.trim() === "" ? null : geo.trim(),
        idempotencyKey: requestKey("manual", tenantId),
        samples,
      });
      if (result.providerMode !== "manual" || result.evidenceType !== "manual_import") {
        throw new TypeError("人工导入返回了不一致的证据类型");
      }
      if (scopeRef.current !== scope) return;
      await refreshRuns(result.visibilityRunId);
      if (scopeRef.current === scope) {
        setFeedback({
          tone: "success",
          text: `${samples.length} 条 ${providerLabel(provider)} 人工观察已持久化并回读。`,
        });
        onChanged?.();
      }
    } catch (error) {
      if (scopeRef.current === scope) setFeedback({ tone: "error", text: apiError(error) });
    } finally {
      if (scopeRef.current === scope) setOperationPending(false);
    }
  }

  function updateSample(id: string, patch: Partial<ManualSampleDraft>): void {
    setManualSamples((current) =>
      current.map((sample) => (sample.id === id ? { ...sample, ...patch } : sample)),
    );
  }

  return (
    <div className="visibility-console">
      <header className="visibility-console-header">
        <div>
          <span>
            <Activity size={14} /> GEO 观测
          </span>
          <h2>模型可见性运行</h2>
        </div>
        <dl className="visibility-console-metrics" aria-label="可见性运行摘要">
          <div>
            <dt>全部运行</dt>
            <dd>{runs.length}</dd>
          </div>
          <div data-tone="warning">
            <dt>执行中</dt>
            <dd>
              {runs.filter((run) => run.status === "queued" || run.status === "running").length}
            </dd>
          </div>
          <div data-tone={runs.some((run) => run.status === "failed") ? "danger" : "neutral"}>
            <dt>失败</dt>
            <dd>{runs.filter((run) => run.status === "failed").length}</dd>
          </div>
          <div data-tone="success">
            <dt>观察样本</dt>
            <dd>{runs.reduce((total, run) => total + run.observationCount, 0)}</dd>
          </div>
        </dl>
      </header>
      <Feedback value={feedback} />
      <section className="panel visibility-command-panel">
        <div className="visibility-section-heading">
          <div>
            <span>评测操作</span>
            <h2>豆包 / 千问独立运行</h2>
          </div>
          <div className="segmented-control" aria-label="评测证据类型">
            <button
              type="button"
              className={commandMode === "fixture" ? "active" : ""}
              onClick={() => setCommandMode("fixture")}
            >
              固定样本
            </button>
            <button
              type="button"
              className={commandMode === "manual" ? "active" : ""}
              onClick={() => setCommandMode("manual")}
            >
              人工导入
            </button>
          </div>
        </div>
        <div className="visibility-boundary">
          <ShieldAlert size={17} />
          <strong>{commandMode === "fixture" ? "固定样本" : "人工导入"}</strong>
          <span>
            {commandMode === "fixture"
              ? "固定样本评测，不调用豆包或千问外部服务"
              : "操作员录入已观察回答，不标记为官方 API 或自动浏览器证据"}
          </span>
        </div>
        {activeQuerySets.length === 0 ? (
          <div className="visibility-empty" role="status">
            <Database size={17} />
            <span>当前租户没有可运行的已启用问题集</span>
          </div>
        ) : commandMode === "fixture" ? (
          <form className="visibility-command-form" onSubmit={(event) => void submitFixture(event)}>
            <div className="visibility-form-grid">
              <label>
                问题集
                <select
                  aria-label="固定样本问题集"
                  value={querySetVersionId}
                  onChange={(event) => setQuerySetVersionId(event.target.value)}
                >
                  {activeQuerySets.map((querySet) => (
                    <option key={querySet.id} value={querySet.currentVersionId ?? ""}>
                      {querySet.name} · v{querySet.currentVersion}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标系统
                <select
                  aria-label="固定样本目标系统"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as VisibilityProvider)}
                >
                  <option value="doubao">豆包</option>
                  <option value="qwen">千问</option>
                </select>
              </label>
              <label>
                重复采样次数
                <input
                  aria-label="固定样本重复采样次数"
                  type="number"
                  min="1"
                  max="20"
                  value={sampleCount}
                  onChange={(event) => setSampleCount(Number(event.target.value))}
                  required
                />
              </label>
            </div>
            <div className="visibility-form-actions">
              <button
                className="button-primary"
                type="submit"
                disabled={!canRun || operationPending || querySetVersionId === ""}
                title={!canRun ? "需要可见性运行权限" : undefined}
              >
                {operationPending ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}
                运行固定样本评测
              </button>
            </div>
          </form>
        ) : (
          <form className="visibility-command-form" onSubmit={(event) => void submitManual(event)}>
            <div className="visibility-form-grid">
              <label>
                问题集
                <select
                  aria-label="人工导入问题集"
                  value={querySetVersionId}
                  onChange={(event) => setQuerySetVersionId(event.target.value)}
                >
                  {activeQuerySets.map((querySet) => (
                    <option key={querySet.id} value={querySet.currentVersionId ?? ""}>
                      {querySet.name} · v{querySet.currentVersion}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标系统
                <select
                  aria-label="人工导入目标系统"
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value as VisibilityProvider;
                    setProvider(next);
                    setProductSurface(`${next}-web-search`);
                  }}
                >
                  <option value="doubao">豆包</option>
                  <option value="qwen">千问</option>
                </select>
              </label>
              <label>
                产品渠道
                <input
                  aria-label="产品渠道"
                  value={productSurface}
                  onChange={(event) => setProductSurface(event.target.value)}
                  required
                />
              </label>
              <label>
                模型
                <input
                  aria-label="观察模型"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  required
                />
              </label>
              <label>
                搜索模式
                <select
                  aria-label="搜索模式"
                  value={searchMode}
                  onChange={(event) =>
                    setSearchMode(event.target.value as "on" | "off" | "unknown")
                  }
                >
                  <option value="on">已开启</option>
                  <option value="off">已关闭</option>
                  <option value="unknown">未知</option>
                </select>
              </label>
              <label>
                语言区域
                <input
                  value={locale}
                  onChange={(event) => setLocale(event.target.value)}
                  required
                />
              </label>
              <label>
                地理区域
                <input value={geo} onChange={(event) => setGeo(event.target.value)} />
              </label>
            </div>
            <div className="visibility-sample-heading">
              <div>
                <strong>人工观察</strong>
                <span>{manualSamples.length} 条</span>
              </div>
              <button
                className="button-secondary"
                type="button"
                onClick={() =>
                  setManualSamples((current) => [
                    ...current,
                    newManualSample(prompts[0]?.key ?? ""),
                  ])
                }
                disabled={prompts.length === 0 || operationPending}
              >
                <Plus size={15} /> 添加观察
              </button>
            </div>
            {prompts.length === 0 ? (
              <div className="visibility-empty" role="status">
                <AlertTriangle size={17} />
                <span>当前问题集没有可导入的查询项标识</span>
              </div>
            ) : (
              <div className="visibility-sample-list">
                {manualSamples.map((sample, index) => (
                  <fieldset key={sample.id}>
                    <legend>观察 #{index + 1}</legend>
                    <button
                      className="icon-button visibility-remove-sample"
                      type="button"
                      aria-label={`删除观察 ${index + 1}`}
                      title="删除观察"
                      onClick={() =>
                        setManualSamples((current) =>
                          current.filter((item) => item.id !== sample.id),
                        )
                      }
                      disabled={manualSamples.length === 1 || operationPending}
                    >
                      <X size={15} />
                    </button>
                    <div className="visibility-form-grid">
                      <label>
                        问题
                        <select
                          aria-label={`观察 ${index + 1} 问题`}
                          value={sample.queryKey}
                          onChange={(event) =>
                            updateSample(sample.id, { queryKey: event.target.value })
                          }
                        >
                          {prompts.map((prompt) => (
                            <option key={prompt.key} value={prompt.key}>
                              {prompt.prompt}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        请求时间
                        <input
                          aria-label={`观察 ${index + 1} 请求时间`}
                          type="datetime-local"
                          value={sample.requestStartedAt}
                          onChange={(event) =>
                            updateSample(sample.id, { requestStartedAt: event.target.value })
                          }
                          required
                        />
                      </label>
                      <label>
                        响应时间
                        <input
                          aria-label={`观察 ${index + 1} 响应时间`}
                          type="datetime-local"
                          value={sample.responseReceivedAt}
                          onChange={(event) =>
                            updateSample(sample.id, { responseReceivedAt: event.target.value })
                          }
                          required
                        />
                      </label>
                      <label className="visibility-form-wide">
                        原始回答
                        <textarea
                          aria-label={`观察 ${index + 1} 原始回答`}
                          rows={4}
                          value={sample.rawAnswer}
                          onChange={(event) =>
                            updateSample(sample.id, { rawAnswer: event.target.value })
                          }
                          required
                        />
                      </label>
                      <label className="visibility-form-wide">
                        引用 URL（每行一个）
                        <textarea
                          aria-label={`观察 ${index + 1} 引用 URL`}
                          rows={2}
                          value={sample.citedUrls}
                          onChange={(event) =>
                            updateSample(sample.id, { citedUrls: event.target.value })
                          }
                        />
                      </label>
                    </div>
                  </fieldset>
                ))}
              </div>
            )}
            <div className="visibility-form-actions">
              <button
                className="button-primary"
                type="submit"
                disabled={
                  !canRun ||
                  operationPending ||
                  querySetVersionId === "" ||
                  prompts.length === 0 ||
                  manualSamples.length === 0
                }
                title={!canRun ? "需要可见性运行权限" : undefined}
              >
                {operationPending ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <FileInput size={15} />
                )}
                导入人工观察
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="panel visibility-run-panel">
        <div className="visibility-section-heading">
          <div>
            <span>持久化回读</span>
            <h2>运行、指标与原始证据</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="刷新可见性运行"
            title="刷新可见性运行"
            onClick={() => void reloadRuns()}
            disabled={runsLoading || operationPending}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="visibility-run-toolbar">
          <label className="visibility-search-control">
            <Search size={15} />
            <input
              type="search"
              aria-label="搜索可见性运行"
              placeholder="搜索渠道、模型或运行 ID"
              value={runQuery}
              onChange={(event) => setRunQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="可见性运行平台筛选"
            value={runProviderFilter}
            onChange={(event) =>
              setRunProviderFilter(event.target.value as "all" | VisibilityProvider)
            }
          >
            <option value="all">全部系统</option>
            <option value="doubao">豆包</option>
            <option value="qwen">千问</option>
          </select>
          <div className="segmented-control" aria-label="可见性运行状态筛选">
            <button
              type="button"
              className={runStatusFilter === "all" ? "active" : ""}
              onClick={() => setRunStatusFilter("all")}
            >
              全部
            </button>
            <button
              type="button"
              className={runStatusFilter === "active" ? "active" : ""}
              onClick={() => setRunStatusFilter("active")}
            >
              进行中
            </button>
            <button
              type="button"
              className={runStatusFilter === "failed" ? "active" : ""}
              onClick={() => setRunStatusFilter("failed")}
            >
              失败
            </button>
            <button
              type="button"
              className={runStatusFilter === "completed" ? "active" : ""}
              onClick={() => setRunStatusFilter("completed")}
            >
              已完成
            </button>
          </div>
        </div>
        {runsLoading ? (
          <div className="visibility-empty" role="status">
            <LoaderCircle className="spin" size={17} />
            <span>正在读取当前租户运行</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="visibility-empty" role="status">
            <Database size={17} />
            <span>当前租户尚无可见性运行</span>
          </div>
        ) : (
          <div className="visibility-run-browser">
            <div className="visibility-run-index" aria-label="可见性运行列表">
              <div className="visibility-run-list-head" aria-hidden="true">
                <span>系统 / 渠道</span>
                <span>状态</span>
                <span>证据</span>
                <span>时间</span>
              </div>
              {visibleRuns.length === 0 ? (
                <div className="visibility-empty visibility-filter-empty" role="status">
                  <Search size={16} />
                  <span>没有匹配当前筛选条件的运行</span>
                </div>
              ) : (
                visibleRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`${selectedRunId === run.id ? "selected" : ""} ${run.status === "failed" ? "failed" : ""}`.trim()}
                    onClick={() => void loadDetail(run.id)}
                  >
                    <div>
                      <strong>{providerLabel(run.provider)}</strong>
                      <span>{run.productSurface}</span>
                    </div>
                    <span className={`visibility-run-status ${runStatusTone(run.status)}`}>
                      {runStatusLabel(run.status)}
                    </span>
                    <span
                      className={`visibility-evidence visibility-evidence-${run.observationMethod}`}
                    >
                      {runEvidenceLabel(run)}
                    </span>
                    <small>
                      {run.observationCount} 条 · {formatDateTime(run.completedAt ?? run.createdAt)}
                    </small>
                    <ChevronRight size={15} />
                  </button>
                ))
              )}
            </div>
            <div className="visibility-run-detail">
              {detailLoading ? (
                <div className="visibility-empty" role="status">
                  <LoaderCircle className="spin" size={17} />
                  <span>正在读取原始证据</span>
                </div>
              ) : detail === null ? (
                <div className="visibility-empty" role="status">
                  <Database size={17} />
                  <span>选择运行查看证据</span>
                </div>
              ) : (
                <>
                  <div className="visibility-detail-head">
                    <div>
                      <span>{providerLabel(detail.run.provider)}</span>
                      <h3>{detail.run.productSurface}</h3>
                    </div>
                    <div className="visibility-detail-badges">
                      <span className={`visibility-run-status ${runStatusTone(detail.run.status)}`}>
                        {runStatusLabel(detail.run.status)}
                      </span>
                      <span
                        className={`visibility-evidence visibility-evidence-${detail.run.observationMethod}`}
                      >
                        {runEvidenceLabel(detail.run)}
                      </span>
                    </div>
                  </div>
                  {detail.run.errorMessage === null ? null : (
                    <div className="visibility-run-error" role="alert">
                      <AlertTriangle size={16} />
                      <div>
                        <strong>运行失败</strong>
                        <span>{detail.run.errorMessage}</span>
                      </div>
                    </div>
                  )}
                  <dl className="visibility-run-meta">
                    <div>
                      <dt>模型</dt>
                      <dd>{detail.run.model}</dd>
                    </div>
                    <div>
                      <dt>搜索</dt>
                      <dd>{searchModeLabel(detail.run.searchMode)}</dd>
                    </div>
                    <div>
                      <dt>语言 / 地区</dt>
                      <dd>
                        {detail.run.locale} / {detail.run.geo ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>运行 ID</dt>
                      <dd className="mono">{detail.run.id}</dd>
                    </div>
                  </dl>
                  <div className="visibility-metric-list">
                    {detail.metrics.map((metric) => (
                      <div key={metric.name}>
                        <span>{metric.name}</span>
                        <strong>{formatMetric(metric)}</strong>
                        <small>n={metric.sampleCount}</small>
                      </div>
                    ))}
                  </div>
                  <div className="visibility-observation-list">
                    {prioritizedObservations.map((observation, index) => (
                      <article
                        key={observation.id}
                        data-risk={
                          observation.harmfulError ||
                          observation.hallucinationFindings.some(
                            (finding) => finding.severity === "high",
                          )
                            ? "high"
                            : "normal"
                        }
                      >
                        <header>
                          <div>
                            <span>观察 #{index + 1}</span>
                            <h4>{observation.prompt}</h4>
                          </div>
                          <span
                            className={`visibility-evidence visibility-evidence-${observation.observationMethod}`}
                          >
                            {evidenceTypeLabel(observation.evidenceType)}
                          </span>
                        </header>
                        <pre>{observation.rawAnswer}</pre>
                        <dl>
                          <div>
                            <dt>联系方式准确率</dt>
                            <dd>{(observation.contactAccuracy * 100).toFixed(1)}%</dd>
                          </div>
                          <div>
                            <dt>品牌命中</dt>
                            <dd>{observation.brandMentioned ? "是" : "否"}</dd>
                          </div>
                          <div>
                            <dt>答案位置</dt>
                            <dd>{observation.answerPosition ?? "—"}</dd>
                          </div>
                          <div>
                            <dt>情感</dt>
                            <dd>{sentimentLabel(observation.sentiment)}</dd>
                          </div>
                          <div>
                            <dt>竞争者</dt>
                            <dd>
                              {observation.competitorMentions.length === 0
                                ? "无"
                                : observation.competitorMentions.join(" / ")}
                            </dd>
                          </div>
                          <div>
                            <dt>有害错误</dt>
                            <dd className={observation.harmfulError ? "danger-text" : ""}>
                              {observation.harmfulError ? "是" : "否"}
                            </dd>
                          </div>
                        </dl>
                        <div className="visibility-citations">
                          <strong>结构化幻觉发现</strong>
                          {observation.hallucinationFindings.length === 0 ? (
                            <span>无</span>
                          ) : (
                            <ul>
                              {observation.hallucinationFindings.map((finding, findingIndex) => (
                                <li key={`${finding.code}:${findingIndex}`}>
                                  <span
                                    className={finding.severity === "high" ? "danger-text" : ""}
                                  >
                                    {findingSeverityLabel(finding.severity)} · {finding.code} ·{" "}
                                    {finding.statement}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="visibility-citations">
                          <strong>引用来源</strong>
                          {observation.citedUrls.length === 0 ? (
                            <span>无引用链接</span>
                          ) : (
                            <ul>
                              {observation.citedUrls.map((url) => {
                                const href = safeCitationUrl(url);
                                return (
                                  <li key={url}>
                                    {href === null ? (
                                      <span>{url}</span>
                                    ) : (
                                      <a href={href} target="_blank" rel="noreferrer">
                                        {url}
                                      </a>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                        <footer>
                          <span>
                            {formatDateTime(observation.requestStartedAt)} →{" "}
                            {formatDateTime(observation.responseReceivedAt)}
                          </span>
                          <span>{observation.evaluatorVersion}</span>
                          <span className="mono">{observation.evidenceHash}</span>
                        </footer>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        <div className="source-caption">
          <Database size={14} />
          <span>GET /api/visibility-runs + GET /api/visibility-runs/:runId</span>
        </div>
      </section>
    </div>
  );
}
