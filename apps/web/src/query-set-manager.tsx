import { Archive, CheckCircle2, History, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import {
  type GeoApi,
  GeoApiError,
  type QuerySet,
  type QuerySetPrompt,
  type QuerySetVersion,
} from "./api.js";

interface QuerySetManagerProps {
  readonly api: GeoApi;
  readonly querySets: readonly QuerySet[];
  readonly canManage: boolean;
  readonly onChanged: () => void;
}

type DialogIntent =
  | { readonly kind: "create" }
  | { readonly kind: "version"; readonly querySet: QuerySet }
  | { readonly kind: "activate"; readonly querySet: QuerySet; readonly version: QuerySetVersion }
  | { readonly kind: "retire"; readonly querySet: QuerySet };

function errorText(error: unknown): string {
  if (error instanceof GeoApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "请求失败";
}

function promptRows(value: unknown): QuerySetPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const row = item as Readonly<Record<string, unknown>>;
    return typeof row.key === "string" &&
      typeof row.category === "string" &&
      typeof row.prompt === "string"
      ? [{ key: row.key, category: row.category, prompt: row.prompt }]
      : [];
  });
}

export function QuerySetManager({ api, querySets, canManage, onChanged }: QuerySetManagerProps) {
  const availableSets = useMemo(
    () => [...querySets].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    [querySets],
  );
  const [selectedId, setSelectedId] = useState(availableSets[0]?.id ?? "");
  const [versions, setVersions] = useState<readonly QuerySetVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogIntent | null>(null);

  useEffect(() => {
    if (!availableSets.some((item) => item.id === selectedId)) {
      setSelectedId(availableSets[0]?.id ?? "");
    }
  }, [availableSets, selectedId]);

  useEffect(() => {
    if (selectedId === "") {
      setVersions([]);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    api
      .getQuerySetVersions(selectedId)
      .then((items) => {
        if (active) setVersions(items);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, selectedId]);

  const selected = availableSets.find((item) => item.id === selectedId) ?? null;

  return (
    <section className="panel query-set-manager">
      <div className="panel-heading">
        <div>
          <h2>问题集治理</h2>
          <p>不可变版本 · 显式激活 · 豆包与千问分别留存证据</p>
        </div>
        <button
          type="button"
          className="button-primary"
          disabled={!canManage}
          onClick={() => setDialog({ kind: "create" })}
        >
          <Plus size={16} /> 新建问题集
        </button>
      </div>
      <div className="query-set-layout">
        <div className="query-set-directory" aria-label="问题集目录">
          {availableSets.length === 0 ? (
            <span className="muted">暂无问题集</span>
          ) : (
            availableSets.map((querySet) => (
              <button
                type="button"
                className={querySet.id === selectedId ? "active" : ""}
                key={querySet.id}
                onClick={() => setSelectedId(querySet.id)}
              >
                <span>
                  <strong>{querySet.name}</strong>
                  <small>
                    {querySet.industry} · v{querySet.currentVersion}
                  </small>
                </span>
                <em data-status={querySet.status}>{querySet.status}</em>
              </button>
            ))
          )}
        </div>
        <div className="query-set-versions">
          {selected === null ? (
            <span className="muted">选择问题集后查看版本</span>
          ) : (
            <>
              <div className="query-set-version-heading">
                <div>
                  <strong>{selected.name}</strong>
                  <span>{selected.description}</span>
                </div>
                <div>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!canManage || selected.status === "retired"}
                    onClick={() => setDialog({ kind: "version", querySet: selected })}
                  >
                    <Plus size={15} /> 新版本
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`退役问题集 ${selected.name}`}
                    title="退役问题集"
                    disabled={!canManage || selected.status === "retired"}
                    onClick={() => setDialog({ kind: "retire", querySet: selected })}
                  >
                    <Archive size={16} />
                  </button>
                </div>
              </div>
              {loadError === null ? null : (
                <div className="auth-error" role="alert">
                  {loadError}
                </div>
              )}
              {loading ? (
                <div className="query-set-loading">
                  <LoaderCircle className="spin" size={17} /> 读取版本
                </div>
              ) : (
                <div className="query-version-list">
                  {versions.map((version) => {
                    const current = version.id === selected.currentVersionId;
                    return (
                      <div key={version.id}>
                        <History size={16} />
                        <div>
                          <strong>v{version.version}</strong>
                          <span>
                            {version.prompts.length} 个问题 · {version.promptHash.slice(0, 12)}…
                          </span>
                        </div>
                        {current ? (
                          <span className="query-version-current">
                            <CheckCircle2 size={14} /> 当前
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="button-secondary"
                            disabled={!canManage || selected.status === "retired"}
                            onClick={() =>
                              setDialog({ kind: "activate", querySet: selected, version })
                            }
                          >
                            激活
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {dialog?.kind === "create" || dialog?.kind === "version" ? (
        <QuerySetEditorDialog
          intent={dialog}
          api={api}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChanged();
            if (selectedId !== "") {
              void api.getQuerySetVersions(selectedId).then(setVersions);
            }
          }}
        />
      ) : null}
      {dialog?.kind === "activate" || dialog?.kind === "retire" ? (
        <QuerySetCommandDialog
          intent={dialog}
          api={api}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function QuerySetEditorDialog({
  intent,
  api,
  onClose,
  onSaved,
}: {
  intent: Extract<DialogIntent, { kind: "create" | "version" }>;
  api: GeoApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = intent.kind === "version" ? promptRows(intent.querySet.prompts) : [];
  const [name, setName] = useState(intent.kind === "version" ? intent.querySet.name : "");
  const [industry, setIndustry] = useState(
    intent.kind === "version" ? intent.querySet.industry : "travel",
  );
  const [description, setDescription] = useState(
    intent.kind === "version" ? intent.querySet.description : "",
  );
  const [prompts, setPrompts] = useState<QuerySetPrompt[]>(
    existing.length > 0 ? existing : [{ key: "", category: "", prompt: "" }],
  );
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptsValid =
    prompts.length > 0 &&
    prompts.every(
      (item) =>
        item.key.trim().length > 0 &&
        item.category.trim().length > 0 &&
        item.prompt.trim().length > 0,
    ) &&
    new Set(prompts.map((item) => item.key.trim())).size === prompts.length;
  const valid =
    promptsValid &&
    (intent.kind === "version"
      ? reason.trim().length >= 3
      : name.trim().length > 0 && industry.trim().length > 0 && description.trim().length > 0);

  function updatePrompt(index: number, key: keyof QuerySetPrompt, value: string) {
    setPrompts((items) =>
      items.map((item, itemIndex) => (itemIndex === index ? { ...item, [key]: value } : item)),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setPending(true);
    setError(null);
    const normalized = prompts.map((item) => ({
      key: item.key.trim(),
      category: item.category.trim(),
      prompt: item.prompt.trim(),
    }));
    try {
      if (intent.kind === "create") {
        await api.createQuerySet({
          name: name.trim(),
          industry: industry.trim(),
          description: description.trim(),
          prompts: normalized,
        });
      } else {
        await api.createQuerySetVersion(intent.querySet.id, {
          prompts: normalized,
          reason: reason.trim(),
        });
      }
      onSaved();
    } catch (submitError) {
      setError(errorText(submitError));
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
        aria-labelledby="query-set-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="query-set-editor-title">
              {intent.kind === "create" ? "新建问题集" : `创建 ${intent.querySet.name} 新版本`}
            </h2>
            <p>保存新版不会切换当前评测版本</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          {intent.kind === "create" ? (
            <div className="query-set-meta-grid">
              <label>
                名称
                <input
                  aria-label="问题集名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                行业
                <input
                  aria-label="问题集行业"
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                />
              </label>
              <label className="query-set-wide-field">
                说明
                <textarea
                  aria-label="问题集说明"
                  value={description}
                  rows={2}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>
          ) : null}
          <div className="query-prompt-editor">
            {prompts.map((item, index) => (
              <div key={`${String(index)}:${item.key}`}>
                <input
                  aria-label={`问题键 ${String(index + 1)}`}
                  value={item.key}
                  placeholder="key"
                  onChange={(event) => updatePrompt(index, "key", event.target.value)}
                />
                <input
                  aria-label={`问题类别 ${String(index + 1)}`}
                  value={item.category}
                  placeholder="category"
                  onChange={(event) => updatePrompt(index, "category", event.target.value)}
                />
                <textarea
                  aria-label={`问题内容 ${String(index + 1)}`}
                  value={item.prompt}
                  rows={2}
                  placeholder="问题"
                  onChange={(event) => updatePrompt(index, "prompt", event.target.value)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除问题 ${String(index + 1)}`}
                  disabled={prompts.length === 1 || pending}
                  onClick={() =>
                    setPrompts((items) => items.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button-secondary query-prompt-add"
              disabled={prompts.length >= 200 || pending}
              onClick={() =>
                setPrompts((items) => [...items, { key: "", category: "", prompt: "" }])
              }
            >
              <Plus size={15} /> 添加问题
            </button>
          </div>
          {intent.kind === "version" ? (
            <label>
              创建原因
              <textarea
                aria-label="问题集版本原因"
                value={reason}
                rows={3}
                minLength={3}
                maxLength={1_000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button type="submit" className="button-primary" disabled={!valid || pending}>
              {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {pending ? "正在保存" : intent.kind === "create" ? "创建问题集" : "保存新版本"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function QuerySetCommandDialog({
  intent,
  api,
  onClose,
  onSaved,
}: {
  intent: Extract<DialogIntent, { kind: "activate" | "retire" }>;
  api: GeoApi;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length < 3) return;
    setPending(true);
    setError(null);
    try {
      if (intent.kind === "activate") {
        await api.activateQuerySetVersion(intent.querySet.id, intent.version.id, reason.trim());
      } else {
        await api.transitionQuerySet(intent.querySet.id, "retired", reason.trim());
      }
      onSaved();
    } catch (submitError) {
      setError(errorText(submitError));
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
        aria-labelledby="query-set-command-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="query-set-command-title">
              {intent.kind === "activate" ? `激活 v${intent.version.version}` : "退役问题集"}
            </h2>
            <p>{intent.querySet.name}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" disabled={pending}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === null ? null : (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <label>
            操作原因
            <textarea
              aria-label="问题集操作原因"
              value={reason}
              rows={4}
              minLength={3}
              maxLength={1_000}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button
              type="submit"
              className={intent.kind === "retire" ? "button-danger" : "button-primary"}
              disabled={pending || reason.trim().length < 3}
            >
              {pending ? (
                <LoaderCircle className="spin" size={16} />
              ) : intent.kind === "activate" ? (
                <CheckCircle2 size={16} />
              ) : (
                <Archive size={16} />
              )}
              {pending ? "等待回读" : intent.kind === "activate" ? "确认激活" : "确认退役"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
