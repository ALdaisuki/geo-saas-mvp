import {
  Activity,
  AlertTriangle,
  Ban,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Download,
  Eye,
  ExternalLink,
  FilePlus2,
  FileSearch,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  ThumbsUp,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

import {
  GeoApiError,
  type AuditArtifact,
  type AgentRunCapability,
  type AgentRunResponse,
  type AuditResult,
  type Brand,
  type CanonicalBodyBlock,
  type Campaign,
  type ChannelAccount,
  type ClaimFact,
  type ContentItem,
  type ContentVersion,
  type CreateContentInput,
  type EvidenceSource,
  type GeoApi,
  type ManualMediaReviewHistory,
  type ManualPublicationPackage,
  type ManualMediaReworkAction,
  type MediaImportRights,
  type MediaSearchImportResult,
  type PendingManualMediaReview,
  type PublicationAttempt,
  type PublicationJob,
  type PublicationPayload,
  type PublicationReadback,
  type PublicationReceipt,
  type PublicationRequestInput,
  type PublicationRequestResult,
  type PublicationVariant,
  type PolicyBundle,
  type TenantContact,
} from "./api.js";
import { ArticleTemplateCatalog } from "./article-template-catalog.js";
import {
  auditRuleLabel,
  auditRuleMessage,
  auditSeverityLabel,
  connectorCapabilityLabel,
  contentTypeLabel,
  editorialProfileLabel,
  evidenceSourceTypeLabel,
  evidenceTypeLabel,
  executionLevelLabel,
  factStatusLabel,
  operationStatusLabel,
} from "./operation-labels.js";
import { useModalDialog } from "./use-modal-dialog.js";
import "./execution-console.css";
import {
  CTRIP_COMMUNITY_PUBLICATION_LIMITS,
  DEFAULT_ARTICLE_TEMPLATE_ID,
  type ArticleTemplate,
  type GovernedEditorialProfile,
  type Platform,
} from "@geo/contracts";

type WriteState = "idle" | "working" | "done" | "error";

export function planCtripMediaImportRoles(
  existingRoles: readonly ("cover" | "inline")[],
  incomingCount: number,
): readonly ("cover" | "inline")[] {
  const coverCount = existingRoles.filter((role) => role === "cover").length;
  if (coverCount > 1) throw new Error("Ctrip media plan already has more than one cover");
  if (!Number.isSafeInteger(incomingCount) || incomingCount < 1) {
    throw new Error("Ctrip five-image plan requires at least one incoming image");
  }
  if (existingRoles.length + incomingCount > CTRIP_COMMUNITY_PUBLICATION_LIMITS.targetImages) {
    throw new Error("Ctrip five-image plan cannot exceed five images");
  }
  return Object.freeze(
    Array.from({ length: incomingCount }, (_, index) =>
      coverCount === 0 && index === 0 ? "cover" : "inline",
    ),
  );
}

interface OperationResources {
  readonly brands: "loading" | "ready" | "error";
  readonly evidence: "loading" | "ready" | "error";
  readonly facts: "loading" | "ready" | "error";
  readonly campaigns: "loading" | "ready" | "error";
  readonly content: "loading" | "ready" | "error";
  readonly accounts: "loading" | "ready" | "error";
  readonly policies: "loading" | "ready" | "error";
  readonly templates: "loading" | "ready" | "error";
}

export interface OperationsWorkspaceProps {
  readonly api: GeoApi;
  readonly tenantId: string;
  readonly capabilities: readonly string[];
  readonly brands: readonly Brand[];
  readonly evidenceSources: readonly EvidenceSource[];
  readonly facts: readonly ClaimFact[];
  readonly campaigns: readonly Campaign[];
  readonly contentItems: readonly ContentItem[];
  readonly accounts: readonly ChannelAccount[];
  readonly contacts: readonly TenantContact[];
  readonly policies: readonly PolicyBundle[];
  readonly templates: readonly ArticleTemplate[];
  readonly catalogVersion: string;
  readonly resources: OperationResources;
}

const CANONICAL_DRAFT_TEMPLATES = {
  title: "generic.title.verified-service",
  summary: "generic.summary.verified-sources",
  verifiedHeading: "generic.body.heading.verified",
  verifiedGuidance: "generic.body.guidance.verified",
  contactHeading: "generic.body.heading.contact",
  contactGuidance: "generic.body.guidance.contact",
  tag: "generic.tag.verified",
} as const;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function policyTemplate(
  policy: PolicyBundle,
  category: "title" | "summary" | "body" | "tag",
  templateId: string,
): string | null {
  const templates = record(record(policy.document.contentTemplates)?.[category]);
  const value = templates?.[templateId];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function selectActivePolicy(policies: readonly PolicyBundle[]): PolicyBundle | null {
  const now = Date.now();
  return (
    policies
      .filter((policy) => policy.status === "active" && Date.parse(policy.effectiveAt) <= now)
      .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))[0] ??
    null
  );
}

function canonicalDraftPayload(
  policy: PolicyBundle,
  fact: ClaimFact,
  contacts: readonly TenantContact[],
  editorialProfile: GovernedEditorialProfile,
  articleTemplateId: string,
): PublicationPayload | null {
  const profile = record(record(policy.document.editorialProfiles)?.[editorialProfile]);
  const source = record(profile?.source);
  if (source !== null) {
    const titleTemplateId = source.titleTemplateId;
    const summaryTemplateId = source.summaryTemplateId;
    const bodyTemplateIds = record(source.bodyTemplateIds);
    const bodyOrder = source.bodyOrder;
    const claimPresentation = source.claimPresentation;
    const contactPresentation = source.contactPresentation;
    const tagTemplateIds = source.tagTemplateIds;
    const validBodySlots = new Set([
      "profile_opening",
      "claims",
      "profile_details",
      "profile_action",
      "contacts",
      "profile_closing",
    ]);
    if (
      typeof titleTemplateId !== "string" ||
      typeof summaryTemplateId !== "string" ||
      bodyTemplateIds === null ||
      typeof bodyTemplateIds.opening !== "string" ||
      typeof bodyTemplateIds.details !== "string" ||
      typeof bodyTemplateIds.action !== "string" ||
      typeof bodyTemplateIds.closing !== "string" ||
      !Array.isArray(bodyOrder) ||
      bodyOrder.length !== validBodySlots.size ||
      !bodyOrder.every((slot) => typeof slot === "string" && validBodySlots.has(slot)) ||
      new Set(bodyOrder).size !== validBodySlots.size ||
      (claimPresentation !== "paragraph" && claimPresentation !== "bullet") ||
      (contactPresentation !== "paragraph" && contactPresentation !== "bullet") ||
      !Array.isArray(tagTemplateIds) ||
      tagTemplateIds.length === 0 ||
      !tagTemplateIds.every((templateId) => typeof templateId === "string")
    ) {
      return null;
    }
    const title = policyTemplate(policy, "title", titleTemplateId);
    const summary = policyTemplate(policy, "summary", summaryTemplateId);
    const tags = tagTemplateIds.map((templateId) => policyTemplate(policy, "tag", templateId));
    const slots: Readonly<Record<string, readonly CanonicalBodyBlock[]>> = {
      profile_opening: [{ type: "template", templateId: bodyTemplateIds.opening }],
      claims: [{ type: "claim", claimId: fact.id, presentation: claimPresentation }],
      profile_details: [{ type: "template", templateId: bodyTemplateIds.details }],
      profile_action: [{ type: "template", templateId: bodyTemplateIds.action }],
      contacts: contacts.map((contact) => ({
        type: "contact" as const,
        contactId: contact.id,
        presentation: contactPresentation,
      })),
      profile_closing: [{ type: "template", templateId: bodyTemplateIds.closing }],
    };
    const bodyBlocks = bodyOrder.flatMap((slot) => slots[String(slot)] ?? []);
    const renderedBody = bodyBlocks.map((block) => {
      if (block.type === "template") return policyTemplate(policy, "body", block.templateId);
      if (block.type === "claim") {
        return block.presentation === "bullet"
          ? `- ${fact.claim.replaceAll("\n", "\n  ")}`
          : fact.claim;
      }
      if (block.type === "authored") return block.text;
      const contact = contacts.find((item) => item.id === block.contactId);
      if (contact === undefined) return null;
      const value = `${contact.label}: ${contact.value}`;
      return block.presentation === "bullet" ? `- ${value}` : value;
    });
    if (title === null || summary === null || tags.some((tag) => tag === null)) return null;
    if (renderedBody.some((block) => block === null)) return null;
    return {
      editorialProfile,
      articleTemplateId,
      title,
      summary,
      bodyMarkdown: renderedBody.join("\n\n"),
      titleBlocks: [{ type: "template", templateId: titleTemplateId }],
      summaryBlocks: [{ type: "template", templateId: summaryTemplateId }],
      bodyBlocks,
      tagTemplateIds,
      media: [],
      claims: [
        {
          id: fact.id,
          text: fact.claim,
          evidenceSourceIds: fact.evidenceSourceIds,
          validUntil: fact.validUntil,
        },
      ],
      contactIds: contacts.map((contact) => contact.id),
      tags: tags as readonly string[],
    };
  }
  if (editorialProfile !== "guide") return null;
  const title = policyTemplate(policy, "title", CANONICAL_DRAFT_TEMPLATES.title);
  const summary = policyTemplate(policy, "summary", CANONICAL_DRAFT_TEMPLATES.summary);
  const verifiedHeading = policyTemplate(policy, "body", CANONICAL_DRAFT_TEMPLATES.verifiedHeading);
  const verifiedGuidance = policyTemplate(
    policy,
    "body",
    CANONICAL_DRAFT_TEMPLATES.verifiedGuidance,
  );
  const contactHeading = policyTemplate(policy, "body", CANONICAL_DRAFT_TEMPLATES.contactHeading);
  const contactGuidance = policyTemplate(policy, "body", CANONICAL_DRAFT_TEMPLATES.contactGuidance);
  const tag = policyTemplate(policy, "tag", CANONICAL_DRAFT_TEMPLATES.tag);
  if (
    title === null ||
    summary === null ||
    verifiedHeading === null ||
    verifiedGuidance === null ||
    contactHeading === null ||
    contactGuidance === null ||
    tag === null
  ) {
    return null;
  }

  const bodyMarkdown = [
    verifiedHeading,
    verifiedGuidance,
    `- ${fact.claim.replaceAll("\n", "\n  ")}`,
    contactHeading,
    ...contacts.map((contact) => `${contact.label}: ${contact.value}`),
    contactGuidance,
  ].join("\n\n");
  return {
    editorialProfile,
    articleTemplateId,
    title,
    summary,
    bodyMarkdown,
    titleBlocks: [{ type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.title }],
    summaryBlocks: [{ type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.summary }],
    bodyBlocks: [
      { type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.verifiedHeading },
      { type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.verifiedGuidance },
      { type: "claim", claimId: fact.id, presentation: "bullet" },
      { type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.contactHeading },
      ...contacts.map(
        (contact) =>
          ({ type: "contact", contactId: contact.id, presentation: "paragraph" }) as const,
      ),
      { type: "template", templateId: CANONICAL_DRAFT_TEMPLATES.contactGuidance },
    ],
    tagTemplateIds: [CANONICAL_DRAFT_TEMPLATES.tag],
    media: [],
    claims: [
      {
        id: fact.id,
        text: fact.claim,
        evidenceSourceIds: fact.evidenceSourceIds,
        validUntil: fact.validUntil,
      },
    ],
    contactIds: contacts.map((contact) => contact.id),
    tags: [tag],
  };
}

function apiError(error: unknown): string {
  if (error instanceof GeoApiError) {
    const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
    return `${error.code}: ${error.message}${request}`;
  }
  return error instanceof Error ? error.message : "未知操作错误";
}

function formatDate(value: string): string {
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

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function localDateTime(minutesFromNow = 15): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeFromIso(value: string, offsetMinutes = 0): string {
  const date = new Date(Date.parse(value) + offsetMinutes * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function mergeById<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, item);
  return [...values.values()];
}

function platformName(platform: string): string {
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

function publicationStateLabel(state: string): string {
  return (
    {
      queued: "等待执行",
      dispatching: "正在投放",
      retry_wait: "等待重试",
      uncertain: "结果待确认",
      reconciling: "正在回读",
      succeeded: "已完成",
      confirmed: "已确认",
      cancelled: "已取消",
      failed: "执行失败",
      delivery_failed: "投放失败",
    }[state] ?? state
  );
}

function stateTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (["succeeded", "confirmed", "completed", "passed"].includes(state)) return "success";
  if (["failed", "delivery_failed", "cancelled", "open"].includes(state)) return "danger";
  if (["queued", "dispatching", "retry_wait", "uncertain", "reconciling"].includes(state)) {
    return "warning";
  }
  return "neutral";
}

function isTerminalPublicationJobState(state: string): boolean {
  return [
    "preview_completed",
    "confirmed",
    "needs_review",
    "permanent_failure",
    "cancelled",
  ].includes(state);
}

function newAuditIdempotencyKey(variant: PublicationVariant): string {
  const requestId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-audit:${variant.id}:${variant.payloadHash.slice(0, 16)}:${requestId}`;
}

function isConfirmedReceipt(receipt: PublicationReceipt): boolean {
  return receipt.evidenceType !== "preview" && receipt.confirmed;
}

function downloadManualPublicationPackage(value: ManualPublicationPackage): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `geo-manual-package-${value.auditArtifactId}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function OperationNotice({ children, tone = "info" }: { children: string; tone?: string }) {
  return (
    <div className={`ops-notice ops-notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {tone === "danger" ? <AlertTriangle size={16} /> : <ShieldAlert size={16} />}
      <span>{children}</span>
    </div>
  );
}

function InlineError({ value }: { value: string | null }) {
  return value === null ? null : (
    <div className="ops-inline-error" role="alert">
      <AlertTriangle size={15} />
      <span>{value}</span>
    </div>
  );
}

const MANUAL_MEDIA_REWORK_OPTIONS: readonly {
  readonly action: ManualMediaReworkAction;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    action: "regenerate_media",
    label: "自动重新生成配图",
    hint: "按同一视觉简报重新生成图片",
  },
  {
    action: "replace_media",
    label: "换图",
    hint: "从可授权图库或素材源替换当前图片",
  },
  {
    action: "revise_article",
    label: "改稿",
    hint: "调整文章内容后再次进入配图流程",
  },
];

const MANUAL_MEDIA_REWORK_LABELS: Readonly<Record<ManualMediaReworkAction, string>> = {
  regenerate_media: "自动重新生成配图",
  replace_media: "换图",
  revise_article: "改稿",
};

function mediaReferenceId(reference: Readonly<Record<string, unknown>>): string | null {
  const value = reference.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mediaReferenceText(
  reference: Readonly<Record<string, unknown>>,
  field: "mimeType" | "altText" | "caption",
): string {
  const value = reference[field];
  return typeof value === "string" ? value : "";
}

function mediaReferenceDimension(
  reference: Readonly<Record<string, unknown>>,
  field: "width" | "height",
): number | null {
  const value = reference[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ReworkMediaDialog({
  review,
  canWrite,
  onClose,
  onSubmit,
}: {
  readonly review: PendingManualMediaReview;
  readonly canWrite: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (actions: readonly ManualMediaReworkAction[], reason: string) => Promise<void>;
}) {
  const [actions, setActions] = useState<readonly ManualMediaReworkAction[]>([]);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<WriteState>("idle");
  const [error, setError] = useState<string | null>(null);
  const submitting = state === "working";
  const dialogRef = useModalDialog<HTMLDivElement>(submitting ? null : onClose);

  function toggle(action: ManualMediaReworkAction) {
    setActions((current) =>
      current.includes(action)
        ? current.filter((candidate) => candidate !== action)
        : [...current, action],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions.length === 0) {
      setError("请至少选择一项重做方式");
      return;
    }
    if (reason.trim().length === 0) {
      setError("请填写打回理由，便于留痕追踪");
      return;
    }
    setState("working");
    setError(null);
    try {
      await onSubmit(actions, reason.trim());
      onClose();
    } catch (requestError) {
      setState("error");
      setError(apiError(requestError));
    }
  }

  return (
    <div
      className="modal-backdrop ops-review-modal-backdrop"
      role="presentation"
      onMouseDown={submitting ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        className="modal ops-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-rework-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">人工配图复核</p>
            <h2 id="ops-rework-dialog-title">打回重做 · {review.title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭打回重做"
            disabled={submitting}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <form className="ops-review-dialog-form" onSubmit={(event) => void submit(event)}>
          <div className="ops-review-version-note">
            <strong>v{review.version}</strong>
            <span>
              {contentTypeLabel(review.contentType)} · {review.topicKey} · 共 {review.media.length}{" "}
              张配图
            </span>
          </div>
          <div className="ops-rework-options" role="group" aria-label="重做方式">
            {MANUAL_MEDIA_REWORK_OPTIONS.map((option) => {
              const selected = actions.includes(option.action);
              const icon =
                option.action === "regenerate_media" ? (
                  <RefreshCw size={17} />
                ) : option.action === "replace_media" ? (
                  <ImageIcon size={17} />
                ) : (
                  <FilePlus2 size={17} />
                );
              return (
                <label
                  key={option.action}
                  className={`ops-rework-option ${selected ? "selected" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={submitting}
                    onChange={() => toggle(option.action)}
                  />
                  <span className="ops-rework-option-icon">{icon}</span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                </label>
              );
            })}
          </div>
          <label className="ops-review-reason">
            <span>打回理由</span>
            <textarea
              value={reason}
              disabled={submitting}
              maxLength={1_000}
              rows={4}
              placeholder="说明需要修改的内容，系统会写入操作留痕"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <InlineError value={error} />
          <div className="modal-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={submitting}
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="button-danger" disabled={submitting || !canWrite}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <Undo2 size={16} />}
              提交打回
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ManualMediaReviewQueue({
  api,
  canWrite,
  refreshKey,
}: {
  readonly api: GeoApi;
  readonly canWrite: boolean;
  readonly refreshKey: string;
}) {
  const [items, setItems] = useState<readonly PendingManualMediaReview[]>([]);
  const [history, setHistory] = useState<readonly ManualMediaReviewHistory[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reworkTarget, setReworkTarget] = useState<PendingManualMediaReview | null>(null);

  const load = useCallback(async () => {
    setState((current) => (current === "error" ? "loading" : current));
    setError(null);
    try {
      const pending = await api.listManualMediaReviews();
      const recent = await api.listRecentManualMediaReviews().catch(() => []);
      setItems(pending);
      setHistory(recent);
      setState("ready");
    } catch (requestError) {
      setError(apiError(requestError));
      setState("error");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function removeVersion(contentVersionId: string) {
    setItems((current) => current.filter((item) => item.contentVersionId !== contentVersionId));
  }

  function recordDecision(
    item: PendingManualMediaReview,
    decision: Awaited<ReturnType<GeoApi["recordManualMediaReviewDecision"]>>,
  ) {
    const record: ManualMediaReviewHistory = {
      contentItemId: item.contentItemId,
      contentVersionId: item.contentVersionId,
      title: item.title,
      contentType: item.contentType,
      topicKey: item.topicKey,
      version: item.version,
      reviewStatus: decision.status,
      decidedAt: decision.decidedAt,
      reworkActions: decision.actions,
      reason: decision.reason,
    };
    setHistory((current) =>
      [
        record,
        ...current.filter((entry) => entry.contentVersionId !== record.contentVersionId),
      ].slice(0, 12),
    );
  }

  async function confirmReview(item: PendingManualMediaReview) {
    if (!canWrite || busyId !== null) return;
    setBusyId(item.contentVersionId);
    setError(null);
    try {
      const decision = await api.recordManualMediaReviewDecision(item.contentVersionId, {
        status: "confirmed",
      });
      removeVersion(item.contentVersionId);
      recordDecision(item, decision);
      setNotice(`已确认放行：${item.title} v${item.version}`);
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function submitRework(
    actions: readonly ManualMediaReworkAction[],
    reason: string,
  ): Promise<void> {
    const target = reworkTarget;
    if (target === null) return;
    setBusyId(target.contentVersionId);
    try {
      const decision = await api.recordManualMediaReviewDecision(target.contentVersionId, {
        status: "rejected",
        actions,
        reason,
      });
      removeVersion(target.contentVersionId);
      recordDecision(target, decision);
      setNotice(
        `已打回：${target.title} v${target.version} · ${actions
          .map((action) => MANUAL_MEDIA_REWORK_LABELS[action])
          .join("、")}`,
      );
      setReworkTarget(null);
    } finally {
      setBusyId(null);
    }
  }

  if (state === "error") {
    return (
      <section className="ops-manual-review-band" aria-label="人工配图复核">
        <OperationNotice tone="danger">
          人工配图复核队列读取失败；刷新后重试，不会自动放行。
        </OperationNotice>
        <div className="ops-manual-review-toolbar">
          <button type="button" className="button-secondary" onClick={() => void load()}>
            <RefreshCw size={15} />
            重新读取
          </button>
        </div>
      </section>
    );
  }

  if (state === "loading" && items.length === 0) {
    return (
      <section className="ops-manual-review-band ops-manual-review-empty" aria-label="人工配图复核">
        <span>
          <LoaderCircle className="spin" size={15} /> 正在读取人工配图复核队列
        </span>
      </section>
    );
  }

  return (
    <section className="ops-manual-review-band" aria-label="人工配图复核">
      <div className="ops-section-heading ops-manual-review-heading">
        <div>
          <span>
            <ImageIcon size={13} /> 人工配图复核
          </span>
          <h2>内容版本确认</h2>
        </div>
        <button
          type="button"
          className="button-secondary"
          disabled={state === "loading"}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {notice === null ? null : <OperationNotice>{notice}</OperationNotice>}
      {error === null ? null : <OperationNotice tone="danger">{error}</OperationNotice>}
      {items.length === 0 ? (
        <div className="ops-manual-review-empty">
          <span>当前没有待人工确认的配图版本</span>
        </div>
      ) : (
        <div className="ops-manual-review-list">
          {items.map((item) => (
            <article className="ops-manual-review-card" key={item.contentVersionId}>
              <div className="ops-manual-review-head">
                <div className="ops-review-pending-badge">
                  <ClipboardCheck size={15} />
                  待人工确认
                </div>
                <div className="ops-manual-review-title">
                  <h3>{item.title}</h3>
                  <span>
                    v{item.version} · {contentTypeLabel(item.contentType)} · {item.topicKey} ·{" "}
                    {item.media.length} 张配图
                  </span>
                </div>
              </div>
              <p className="ops-manual-review-summary">{item.summary}</p>
              <div className="ops-manual-review-media">
                {item.media.map((reference, index) => {
                  const assetId = mediaReferenceId(reference);
                  const alt =
                    mediaReferenceText(reference, "altText") ||
                    mediaReferenceText(reference, "caption") ||
                    `文章配图 ${index + 1}`;
                  const width = mediaReferenceDimension(reference, "width");
                  const height = mediaReferenceDimension(reference, "height");
                  const dimension = width === null || height === null ? null : `${width}×${height}`;
                  return (
                    <figure key={assetId ?? `${item.contentVersionId}:${index}`}>
                      {assetId === null ? (
                        <div className="ops-review-image-placeholder">
                          <ImageIcon size={22} />
                        </div>
                      ) : (
                        <img src={api.mediaAssetFileUrl(assetId)} alt={alt} loading="lazy" />
                      )}
                      <figcaption>
                        <strong>{alt}</strong>
                        <span>
                          {mediaReferenceText(reference, "mimeType")}
                          {dimension === null ? "" : ` · ${dimension}`}
                        </span>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              <div className="ops-manual-review-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={!canWrite || busyId !== null}
                  onClick={() => void confirmReview(item)}
                >
                  {busyId === item.contentVersionId ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ThumbsUp size={16} />
                  )}
                  确认放行
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={!canWrite || busyId !== null}
                  onClick={() => setReworkTarget(item)}
                >
                  <Undo2 size={16} />
                  打回重做
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {history.length === 0 ? null : (
        <section className="ops-manual-review-history" aria-label="最近人工配图复核记录">
          <div className="ops-manual-review-history-heading">
            <span>最近处理</span>
            <span>审查后内容会从待办移除，留痕保存在这里</span>
          </div>
          <div className="ops-manual-review-history-list">
            {history.map((entry) => (
              <div className="ops-manual-review-history-row" key={entry.contentVersionId}>
                <span
                  className={
                    entry.reviewStatus === "confirmed"
                      ? "ops-review-history-confirmed"
                      : "ops-review-history-rejected"
                  }
                >
                  {entry.reviewStatus === "confirmed" ? "已放行" : "已打回"}
                </span>
                <strong>{entry.title}</strong>
                <span>
                  v{entry.version} · {contentTypeLabel(entry.contentType)} · {entry.topicKey}
                </span>
                <time dateTime={entry.decidedAt}>
                  {new Date(entry.decidedAt).toLocaleString("zh-CN", { hour12: false })}
                </time>
              </div>
            ))}
          </div>
        </section>
      )}
      {reworkTarget === null ? null : (
        <ReworkMediaDialog
          review={reworkTarget}
          canWrite={canWrite}
          onClose={() => setReworkTarget(null)}
          onSubmit={submitRework}
        />
      )}
    </section>
  );
}

function EvidenceComposer({
  brandsAvailable,
  canWrite,
  onCreated,
  api,
}: {
  brandsAvailable: boolean;
  canWrite: boolean;
  onCreated: (source: EvidenceSource) => void;
  api: GeoApi;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WriteState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const form = new FormData(event.currentTarget);
    setState("working");
    setError(null);
    try {
      const type = String(form.get("type"));
      if (type !== "url" && type !== "document" && type !== "manual") {
        throw new Error("普通文本证据不能登记为平台回读；平台回读需要专用证据契约");
      }
      const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
      const created = await api.createEvidenceSource({
        type,
        title: String(form.get("title") ?? "").trim(),
        ...(sourceUrl === "" ? {} : { sourceUrl }),
        content: String(form.get("content") ?? "").trim(),
        capturedAt: new Date(String(form.get("capturedAt"))).toISOString(),
        metadata: { enteredFrom: "geo-console" },
      });
      onCreated(created);
      setState("done");
      setOpen(false);
    } catch (requestError) {
      setState("error");
      setError(apiError(requestError));
    }
  }

  if (!open) {
    const enabled = canWrite && brandsAvailable;
    return (
      <button
        className="button-secondary"
        type="button"
        onClick={() => setOpen(true)}
        disabled={!enabled}
        title={
          !canWrite
            ? "当前会话缺少内容写入权限"
            : brandsAvailable
              ? undefined
              : "品牌目录为空，无法建立可归属的内容证据"
        }
      >
        <FilePlus2 size={16} /> 录入证据
      </button>
    );
  }

  return (
    <form className="ops-compose-form" onSubmit={(event) => void submit(event)}>
      <div className="ops-form-heading">
        <div>
          <strong>新增证据源</strong>
          <span>保存正文哈希与采集时间，不把摘要当原始证据</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭证据表单"
        >
          <X size={16} />
        </button>
      </div>
      <div className="ops-form-grid">
        <label>
          证据类型
          <select name="type" defaultValue="url">
            <option value="url">网页 URL</option>
            <option value="document">文档</option>
            <option value="manual">人工核验</option>
          </select>
        </label>
        <label>
          证据标题
          <input name="title" required maxLength={300} placeholder="例如：品牌官网联系方式页" />
        </label>
        <label>
          采集时间
          <input
            name="capturedAt"
            type="datetime-local"
            defaultValue={localDateTime(-1)}
            required
          />
        </label>
        <label>
          来源链接
          <input name="sourceUrl" type="url" placeholder="https://…（无链接可留空）" />
        </label>
        <label className="ops-form-wide">
          证据正文
          <textarea
            name="content"
            required
            rows={5}
            placeholder="保留可核验的原始文本、日期和联系方式"
          />
        </label>
      </div>
      <InlineError value={error} />
      <div className="ops-form-actions">
        <button className="button-secondary" type="button" onClick={() => setOpen(false)}>
          取消
        </button>
        <button
          className="button-primary"
          type="submit"
          disabled={!canWrite || state === "working"}
        >
          {state === "working" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          保存证据
        </button>
      </div>
    </form>
  );
}

function FactComposer({
  api,
  brands,
  evidenceSources,
  canWrite,
  canVerify,
  onCreated,
}: {
  api: GeoApi;
  brands: readonly Brand[];
  evidenceSources: readonly EvidenceSource[];
  canWrite: boolean;
  canVerify: boolean;
  onCreated: (fact: ClaimFact) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WriteState>("idle");
  const [error, setError] = useState<string | null>(null);
  const enabled = canWrite && brands.length > 0 && evidenceSources.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const form = new FormData(event.currentTarget);
    setState("working");
    setError(null);
    try {
      const created = await api.createFact({
        brandId: String(form.get("brandId")),
        normalizedKey: String(form.get("normalizedKey") ?? "").trim(),
        claim: String(form.get("claim") ?? "").trim(),
        status: String(form.get("status")) as "draft" | "verified",
        evidenceSourceIds: [String(form.get("evidenceSourceId"))],
      });
      onCreated(created);
      setState("done");
      setOpen(false);
    } catch (requestError) {
      setState("error");
      setError(apiError(requestError));
    }
  }

  if (!open) {
    return (
      <button
        className="button-secondary"
        type="button"
        onClick={() => setOpen(true)}
        disabled={!enabled}
        title={
          !canWrite
            ? "当前会话缺少内容写入权限"
            : enabled
              ? undefined
              : "先加载品牌并录入至少一条证据"
        }
      >
        <ClipboardCheck size={16} /> 登记事实
      </button>
    );
  }

  return (
    <form className="ops-compose-form" onSubmit={(event) => void submit(event)}>
      <div className="ops-form-heading">
        <div>
          <strong>登记可引用事实</strong>
          <span>事实必须绑定证据源；标记为已核验需要租户管理权限</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭事实表单"
        >
          <X size={16} />
        </button>
      </div>
      <div className="ops-form-grid">
        <label>
          品牌
          <select name="brandId" required defaultValue={brands[0]?.id}>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          事实键
          <input
            name="normalizedKey"
            required
            pattern="[A-Za-z0-9._:-]+"
            placeholder="contact.hotline"
          />
        </label>
        <label>
          关联证据
          <select name="evidenceSourceId" required defaultValue={evidenceSources.at(-1)?.id}>
            {evidenceSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select name="status" defaultValue="draft">
            <option value="draft">草稿</option>
            <option value="verified" disabled={!canVerify}>
              已核验
            </option>
          </select>
        </label>
        <label className="ops-form-wide">
          事实陈述
          <textarea name="claim" required rows={3} placeholder="例如：客服电话以官网最新公示为准" />
        </label>
      </div>
      <InlineError value={error} />
      <div className="ops-form-actions">
        <button className="button-secondary" type="button" onClick={() => setOpen(false)}>
          取消
        </button>
        <button
          className="button-primary"
          type="submit"
          disabled={!canWrite || state === "working"}
        >
          {state === "working" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          保存事实
        </button>
      </div>
    </form>
  );
}

function ArticleComposer({
  api,
  campaigns,
  facts,
  contacts,
  policies,
  templates,
  catalogVersion,
  canWrite,
  onCreated,
}: {
  api: GeoApi;
  campaigns: readonly Campaign[];
  facts: readonly ClaimFact[];
  contacts: readonly TenantContact[];
  policies: readonly PolicyBundle[];
  templates: readonly ArticleTemplate[];
  catalogVersion: string;
  canWrite: boolean;
  onCreated: (content: ContentItem, payload: PublicationPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_ARTICLE_TEMPLATE_ID);
  const [state, setState] = useState<WriteState>("idle");
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "active");
  const verifiedFacts = facts.filter(
    (fact) =>
      fact.status === "verified" &&
      fact.evidenceSourceIds.length > 0 &&
      Date.parse(fact.validFrom) <= now &&
      (fact.validUntil === null || Date.parse(fact.validUntil) > now),
  );
  const currentContacts = contacts.filter(
    (contact) =>
      Date.parse(contact.validFrom) <= now &&
      (contact.validUntil === null || Date.parse(contact.validUntil) > now),
  );
  const activePolicy = selectActivePolicy(policies);
  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const enabled =
    canWrite &&
    templates.length > 0 &&
    activePolicy !== null &&
    activeCampaigns.some((campaign) =>
      verifiedFacts.some((fact) => fact.brandId === campaign.brandId),
    ) &&
    currentContacts.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const form = new FormData(event.currentTarget);
    const campaign = activeCampaigns.find((item) => item.id === String(form.get("campaignId")));
    const fact = verifiedFacts.find((item) => item.id === String(form.get("factId")));
    if (
      campaign === undefined ||
      fact === undefined ||
      fact.brandId !== campaign.brandId ||
      activePolicy === null
    ) {
      setError("推广计划、已验证事实或生效规则不在当前工作空间内");
      return;
    }
    const topicKey = String(form.get("topicKey") ?? "").trim();
    if (selectedTemplate === undefined) {
      setError("文章模板目录为空");
      return;
    }
    const payload = canonicalDraftPayload(
      activePolicy,
      fact,
      currentContacts,
      selectedTemplate.editorialProfile,
      selectedTemplate.id,
    );
    if (payload === null) {
      setError("当前策略缺少所选模板对应的规范内容结构");
      return;
    }
    const input: CreateContentInput = {
      campaignId: campaign.id,
      brandId: campaign.brandId,
      title: payload.title,
      contentType: selectedTemplate.editorialProfile,
      topicKey,
      idempotencyKey: crypto.randomUUID(),
      payload,
    };
    setState("working");
    setError(null);
    try {
      const created = await api.createContent(input);
      onCreated(created, payload);
      setState("done");
      setOpen(false);
    } catch (requestError) {
      setState("error");
      setError(apiError(requestError));
    }
  }

  if (!open) {
    return (
      <button
        className="button-primary"
        type="button"
        onClick={() => setOpen(true)}
        disabled={!enabled}
        title={
          !canWrite
            ? "当前会话缺少内容写入权限"
            : templates.length === 0
              ? "文章模板目录尚未就绪"
              : enabled
                ? undefined
                : "先创建推广计划，并至少登记一条可引用事实"
        }
      >
        <Plus size={16} /> 新建文章 + v1
      </button>
    );
  }

  return (
    <form className="ops-compose-form" onSubmit={(event) => void submit(event)}>
      <div className="ops-form-heading">
        <div>
          <strong>新建文章与首个版本</strong>
          <span>事实、证据和联系方式会固化进发布载荷，后续改动创建新版本</span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭文章表单"
        >
          <X size={16} />
        </button>
      </div>
      <ArticleTemplateCatalog
        templates={templates}
        catalogVersion={catalogVersion}
        selectedTemplateId={selectedTemplateId}
        onSelect={(template) => setSelectedTemplateId(template.id)}
      />
      <div className="ops-form-grid">
        <label>
          推广计划
          <select name="campaignId" required defaultValue={activeCampaigns[0]?.id}>
            {activeCampaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          引用事实
          <select
            name="factId"
            required
            defaultValue={
              verifiedFacts.find((fact) => fact.brandId === activeCampaigns[0]?.brandId)?.id
            }
          >
            {verifiedFacts.map((fact) => (
              <option key={fact.id} value={fact.id}>
                {fact.normalizedKey} · {factStatusLabel(fact.status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          治理画像
          <output>
            {selectedTemplate === undefined
              ? "—"
              : editorialProfileLabel(selectedTemplate.editorialProfile)}
          </output>
        </label>
        <label>
          主题键
          <input name="topicKey" required placeholder="japan-senior" />
        </label>
      </div>
      <InlineError value={error} />
      <div className="ops-form-actions">
        <button className="button-secondary" type="button" onClick={() => setOpen(false)}>
          取消
        </button>
        <button
          className="button-primary"
          type="submit"
          disabled={!canWrite || state === "working"}
        >
          {state === "working" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          生成规范文章 v1
        </button>
      </div>
    </form>
  );
}

function AgentArticleComposer({
  api,
  tenantId,
  brands,
  campaigns,
  accounts,
  templates,
  canWrite,
  onCompleted,
}: {
  api: GeoApi;
  tenantId: string;
  brands: readonly Brand[];
  campaigns: readonly Campaign[];
  accounts: readonly ChannelAccount[];
  templates: readonly ArticleTemplate[];
  canWrite: boolean;
  onCompleted: (content: readonly ContentItem[], result: AgentRunResponse) => void;
}) {
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "active");
  const availableAccounts = accounts.filter(
    (account) =>
      account.status === "active" &&
      account.supportedExecutionLevels.includes("dry_run") &&
      ["toutiao", "sohu", "baijiahao", "netease", "ctrip_community", "zhihu"].includes(
        account.platform,
      ),
  );
  const initialBrandId =
    brands.find((brand) => activeCampaigns.some((campaign) => campaign.brandId === brand.id))?.id ??
    "";
  const [brandId, setBrandId] = useState(initialBrandId);
  const [campaignId, setCampaignId] = useState(
    activeCampaigns.find((campaign) => campaign.brandId === initialBrandId)?.id ?? "",
  );
  const [accountId, setAccountId] = useState(availableAccounts[0]?.id ?? "");
  const [templateId, setTemplateId] = useState(
    templates.find((template) => template.id === DEFAULT_ARTICLE_TEMPLATE_ID)?.id ??
      templates[0]?.id ??
      "",
  );
  const [topic, setTopic] = useState("");
  const [capability, setCapability] = useState<AgentRunCapability | null>(null);
  const [capabilityState, setCapabilityState] = useState<"loading" | "ready" | "error">("loading");
  const [state, setState] = useState<WriteState>("idle");
  const [result, setResult] = useState<AgentRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCampaigns = activeCampaigns.filter((campaign) => campaign.brandId === brandId);
  const selectedAccount = availableAccounts.find((account) => account.id === accountId);
  const selectedTemplate = templates.find((template) => template.id === templateId);

  useEffect(() => {
    const nextBrandId =
      brands.find((brand) => activeCampaigns.some((campaign) => campaign.brandId === brand.id))
        ?.id ?? "";
    setBrandId(nextBrandId);
    setCampaignId(activeCampaigns.find((campaign) => campaign.brandId === nextBrandId)?.id ?? "");
    setAccountId(availableAccounts[0]?.id ?? "");
    setTemplateId(
      templates.find((template) => template.id === DEFAULT_ARTICLE_TEMPLATE_ID)?.id ??
        templates[0]?.id ??
        "",
    );
    setTopic("");
    setResult(null);
    setError(null);
    setState("idle");
  }, [tenantId]);

  useEffect(() => {
    if (
      brandId === "" ||
      !brands.some(
        (brand) =>
          brand.id === brandId && activeCampaigns.some((campaign) => campaign.brandId === brand.id),
      )
    ) {
      setBrandId(
        brands.find((brand) => activeCampaigns.some((campaign) => campaign.brandId === brand.id))
          ?.id ?? "",
      );
    }
  }, [activeCampaigns, brandId, brands]);

  useEffect(() => {
    if (!selectedCampaigns.some((campaign) => campaign.id === campaignId)) {
      setCampaignId(selectedCampaigns[0]?.id ?? "");
    }
  }, [campaignId, selectedCampaigns]);

  useEffect(() => {
    if (!availableAccounts.some((account) => account.id === accountId)) {
      setAccountId(availableAccounts[0]?.id ?? "");
    }
  }, [accountId, availableAccounts]);

  useEffect(() => {
    if (!templates.some((template) => template.id === templateId)) {
      setTemplateId(
        templates.find((template) => template.id === DEFAULT_ARTICLE_TEMPLATE_ID)?.id ??
          templates[0]?.id ??
          "",
      );
    }
  }, [templateId, templates]);

  async function loadCapability() {
    setCapabilityState("loading");
    setError(null);
    try {
      setCapability(await api.getAgentCapability());
      setCapabilityState("ready");
    } catch (requestError) {
      setCapability(null);
      setCapabilityState("error");
      setError(apiError(requestError));
    }
  }

  useEffect(() => {
    void loadCapability();
  }, [api, tenantId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canWrite ||
      capability?.available !== true ||
      selectedAccount === undefined ||
      selectedTemplate === undefined ||
      campaignId === ""
    ) {
      return;
    }
    setState("working");
    setResult(null);
    setError(null);
    try {
      const completed = await api.runAgent({
        brandId,
        campaignId,
        channelAccountId: selectedAccount.id,
        platform: selectedAccount.platform as Platform,
        topic: topic.trim(),
        articleTemplateId: selectedTemplate.id,
        idempotencyKey: `web-agent:${crypto.randomUUID()}`,
      });
      const refreshedContent = await api.getContent();
      setResult(completed);
      setState("done");
      onCompleted(refreshedContent, completed);
    } catch (requestError) {
      setState("error");
      setError(apiError(requestError));
    }
  }

  const enabled =
    canWrite &&
    capability?.available === true &&
    brandId !== "" &&
    campaignId !== "" &&
    selectedAccount !== undefined &&
    selectedTemplate !== undefined &&
    topic.trim().length > 0;
  const capabilityLabel =
    capabilityState === "loading"
      ? "正在检查"
      : capability?.available === true
        ? `${capability.provider} · ${capability.model}`
        : capability?.reason === "tenant_not_configured"
          ? "当前客户未配置"
          : capability?.reason === "runner_disabled"
            ? "Agent Runner 已停用"
            : "服务暂不可用";

  return (
    <section className="ops-agent-band" aria-labelledby="agent-composer-title">
      <div className="ops-agent-heading">
        <div>
          <span>PI AGENT · 实时生产</span>
          <h2 id="agent-composer-title">受治理文章生成</h2>
        </div>
        <div className="ops-agent-capability" data-state={capability?.available ? "ready" : "idle"}>
          <Bot size={16} />
          <span>{capabilityLabel}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="刷新 Agent 能力"
            title="刷新 Agent 能力"
            onClick={() => void loadCapability()}
            disabled={capabilityState === "loading" || state === "working"}
          >
            <RefreshCw className={capabilityState === "loading" ? "spin" : ""} size={14} />
          </button>
        </div>
      </div>
      <form className="ops-agent-form" onSubmit={(event) => void submit(event)}>
        <div className="ops-form-grid">
          <label>
            品牌
            <select
              aria-label="Agent 品牌"
              value={brandId}
              onChange={(event) => {
                const nextBrandId = event.target.value;
                setBrandId(nextBrandId);
                setCampaignId(
                  activeCampaigns.find((campaign) => campaign.brandId === nextBrandId)?.id ?? "",
                );
              }}
            >
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            推广计划
            <select
              aria-label="AI 推广计划"
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
            >
              {selectedCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            平台账号
            <select
              aria-label="Agent 平台账号"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {availableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {platformName(account.platform)} · {account.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            文章模板
            <select
              aria-label="Agent 文章模板"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ops-form-wide">
            主题与内容目标
            <textarea
              aria-label="Agent 主题与内容目标"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              rows={4}
              maxLength={10_000}
              placeholder="例如：面向上海家庭客群，核验日本暑期线路服务边界、联系方式与常见决策问题"
            />
          </label>
        </div>
        {selectedTemplate === undefined ? null : (
          <div className="ops-agent-template-note">
            <strong>{selectedTemplate.benefit}</strong>
            <span>{selectedTemplate.geoMechanisms.slice(0, 3).join(" · ")}</span>
          </div>
        )}
        <InlineError value={error} />
        <div className="ops-agent-actions">
          <span>固定输出：平台最终变体 · 确定性审计 · 演练</span>
          <button
            className="button-primary"
            type="submit"
            disabled={!enabled || state === "working"}
          >
            {state === "working" ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            {state === "working" ? "Pi Agent 执行中" : "实时生成文章"}
          </button>
        </div>
      </form>
      {state === "working" ? (
        <div className="ops-agent-progress" role="status">
          <LoaderCircle className="spin" size={18} />
          <div>
            <strong>运行请求已提交</strong>
            <span>等待 Agent 返回实际工具链结果</span>
          </div>
        </div>
      ) : null}
      {result === null ? null : (
        <div className="ops-agent-result" role="status">
          <CheckCircle2 size={18} />
          <div>
            <strong>
              {result.result.providerMode === "fixture"
                ? "文章与演练作业已生成"
                : "Pi Agent 已完成"}
            </strong>
            {result.result.providerMode === "fixture" ? (
              <>
                <span>{result.result.steps.join(" → ")}</span>
                <code>content {result.result.contentItemId}</code>
              </>
            ) : (
              <span>{result.result.response || `模型消息 ${result.result.messageCount} 条`}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface VariantAuditState {
  readonly result: AuditResult;
  readonly scheduledFor: string;
  readonly publication: PublicationRequestResult | null;
  readonly executionLevel: PublicationRequestInput["executionLevel"] | null;
  readonly revoked: boolean;
  readonly grantUnavailable: boolean;
}

function demoExecutionLevel(
  account: ChannelAccount,
): PublicationRequestInput["executionLevel"] | null {
  if (
    account.capability === "manual_only" &&
    account.supportedExecutionLevels.includes("dry_run")
  ) {
    return "dry_run";
  }
  if (
    account.platform === "ctrip_community" &&
    account.capability === "browser_assisted" &&
    account.supportedExecutionLevels.includes("unattended")
  ) {
    return "unattended";
  }
  if (
    account.capability === "browser_assisted" &&
    account.supportedExecutionLevels.includes("assisted")
  ) {
    return "assisted";
  }
  return null;
}

export function ArticleOperations({
  api,
  content,
  accounts,
  capabilities,
}: {
  api: GeoApi;
  content: ContentItem;
  accounts: readonly ChannelAccount[];
  capabilities: readonly string[];
}) {
  const [version, setVersion] = useState<ContentVersion | null>(null);
  const [variants, setVariants] = useState<readonly PublicationVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writingVersion, setWritingVersion] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [variantAccountId, setVariantAccountId] = useState("");
  const [supersedeIntent, setSupersedeIntent] = useState<PublicationVariant | null>(null);
  const [supersedeReason, setSupersedeReason] = useState("");
  const [superseding, setSuperseding] = useState<string | null>(null);
  const [importingMedia, setImportingMedia] = useState(false);
  const [searchingMedia, setSearchingMedia] = useState(false);
  const [mediaSearchResult, setMediaSearchResult] = useState<MediaSearchImportResult | null>(null);
  const [mediaImportProgress, setMediaImportProgress] = useState<{
    readonly completed: number;
    readonly total: number;
  } | null>(null);
  const [mediaPlatform, setMediaPlatform] = useState<Platform>("ctrip_community");
  const [mediaRightsKind, setMediaRightsKind] = useState<"tenant_owned" | "licensed_stock">(
    "tenant_owned",
  );
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const [auditing, setAuditing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [auditState, setAuditState] = useState<Record<string, VariantAuditState>>({});
  const [auditRequestKeys, setAuditRequestKeys] = useState<Record<string, string>>({});
  const eligibleAccounts = accounts.filter((account) => demoExecutionLevel(account) !== null);
  const canWrite = capabilities.includes("content:write");
  const canAudit = capabilities.includes("audit:run");
  const canPublish = capabilities.includes("publish:request");
  const canRevoke = capabilities.includes("grant:revoke");
  const isCanonicalVersion =
    version?.payload.titleBlocks !== undefined &&
    version.payload.summaryBlocks !== undefined &&
    version.payload.bodyBlocks !== undefined &&
    version.payload.tagTemplateIds !== undefined;
  const currentVariants = useMemo(
    () =>
      version === null ? [] : variants.filter((variant) => variant.contentVersionId === version.id),
    [variants, version],
  );
  const activeCurrentVariants = useMemo(
    () => currentVariants.filter((variant) => variant.state !== "superseded"),
    [currentVariants],
  );
  const selectedVariantAccount = eligibleAccounts.find(
    (account) => account.id === variantAccountId,
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setVersion(null);
    setVariants([]);
    setAuditState({});
    setAuditRequestKeys({});
    setVariantAccountId("");
    setSupersedeIntent(null);
    setSupersedeReason("");
    setSuperseding(null);
    setMediaRightsKind("tenant_owned");
    setMediaPlatform("ctrip_community");
    setMediaImportProgress(null);
    setSearchingMedia(false);
    setMediaSearchResult(null);
    setMediaNotice(null);
    if (content.latestVersionId === null) {
      setVersion(null);
      setVariants([]);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    Promise.all([
      api.getContentVersion(content.latestVersionId),
      api.getContentVariants(content.id),
    ])
      .then(([nextVersion, nextVariants]) => {
        if (!active) return;
        setVersion(nextVersion);
        setVariants(nextVariants.filter((variant) => variant.contentVersionId === nextVersion.id));
      })
      .catch((requestError: unknown) => {
        if (active) setError(apiError(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, content.id, content.latestVersionId]);

  useEffect(() => {
    if (
      variantAccountId !== "" &&
      !eligibleAccounts.some((account) => account.id === variantAccountId)
    ) {
      setVariantAccountId("");
    }
  }, [eligibleAccounts, variantAccountId]);

  async function saveVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || version === null || isCanonicalVersion) return;
    const form = new FormData(event.currentTarget);
    const payload: PublicationPayload = {
      ...version.payload,
      summary: String(form.get("summary") ?? "").trim(),
      bodyMarkdown: String(form.get("bodyMarkdown") ?? "").trim(),
    };
    setWritingVersion(true);
    setError(null);
    try {
      const updated = await api.createContentVersion(content.id, payload);
      if (updated.latestVersionId !== null) {
        const next = await api.getContentVersion(updated.latestVersionId);
        setVersion(next);
        setVariants([]);
        setAuditState({});
      }
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setWritingVersion(false);
    }
  }

  async function generateVariant() {
    if (
      !canWrite ||
      version === null ||
      !isCanonicalVersion ||
      selectedVariantAccount === undefined ||
      activeCurrentVariants.some(
        (variant) => variant.channelAccountId === selectedVariantAccount.id,
      )
    ) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const created = await api.createContentVariant(content.id, {
        contentVersionId: version.id,
        channelAccountId: selectedVariantAccount.id,
      });
      setVariants((current) => mergeById(current, [created]));
      setVariantAccountId("");
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setGenerating(false);
    }
  }

  async function supersedeVariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const variant = supersedeIntent;
    const reason = supersedeReason.trim();
    if (!canWrite || variant === null || variant.state !== "draft" || reason.length < 3) return;
    setSuperseding(variant.id);
    setError(null);
    try {
      const changed = await api.supersedeContentVariant(variant.id, reason);
      setVariants((current) => current.map((item) => (item.id === changed.id ? changed : item)));
      setAuditState((current) => {
        const next = { ...current };
        delete next[variant.id];
        return next;
      });
      setAuditRequestKeys((current) => {
        const next = { ...current };
        delete next[variant.id];
        return next;
      });
      setVariantAccountId(variant.channelAccountId);
      setSupersedeIntent(null);
      setSupersedeReason("");
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setSuperseding(null);
    }
  }

  async function importMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || version === null) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const mediaFilesInput = formElement.elements.namedItem("mediaFiles");
    const files =
      mediaFilesInput instanceof HTMLInputElement
        ? [...(mediaFilesInput.files ?? [])].filter((file) => file.size > 0)
        : [];
    if (files.length === 0 || files.length > CTRIP_COMMUNITY_PUBLICATION_LIMITS.targetImages) {
      setError("请选择 1 至 5 张 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("每张图片不能超过 10 MiB");
      return;
    }
    const claimIds = form
      .getAll("claimId")
      .map(String)
      .filter((value) => value.length > 0);
    if (claimIds.length > 3) {
      setError("图片最多关联 3 条事实");
      return;
    }
    const rights: MediaImportRights =
      mediaRightsKind === "tenant_owned"
        ? {
            kind: "tenant_owned",
            ownershipAssertion: String(form.get("ownershipAssertion") ?? "").trim(),
            licenseName: String(form.get("licenseName") ?? "").trim(),
          }
        : {
            kind: "licensed_stock",
            basis: String(form.get("licenseBasis")) as "commercial_license" | "editorial_license",
            sourceUrl: String(form.get("sourceUrl") ?? "").trim(),
            licenseName: String(form.get("licenseName") ?? "").trim(),
            licenseUrl: String(form.get("licenseUrl") ?? "").trim(),
            ...(String(form.get("attribution") ?? "").trim().length === 0
              ? {}
              : { attribution: String(form.get("attribution")).trim() }),
            rightsDescription: String(form.get("rightsDescription") ?? "").trim(),
          };
    const selectedPlatform = String(form.get("platform")) as typeof mediaPlatform;
    let roles: readonly ("cover" | "inline")[];
    try {
      roles =
        selectedPlatform === "ctrip_community"
          ? planCtripMediaImportRoles(
              version.payload.media
                .filter((media) => media.platform === selectedPlatform)
                .map((media) => media.role)
                .filter(
                  (role): role is "cover" | "inline" => role === "cover" || role === "inline",
                ),
              files.length,
            )
          : files.map(() => String(form.get("role") ?? "cover") as "cover" | "inline");
    } catch {
      setError("携程图文默认 5 张且只能有 1 张封面；请减少本次图片数量");
      return;
    }
    setImportingMedia(true);
    setMediaImportProgress({ completed: 0, total: files.length });
    setError(null);
    setMediaNotice(null);
    let nextVersion = version;
    try {
      for (const [index, file] of files.entries()) {
        const role = roles[index];
        if (role === undefined) throw new Error("媒体位置规划不完整");
        const bytesBase64 = await fileAsBase64(file);
        const result = await api.importMedia(nextVersion.id, {
          platform: selectedPlatform,
          role,
          claimIds,
          idempotencyKey: `web-media-import:${nextVersion.id}:${index}:${Date.now().toString(36)}`,
          bytesBase64,
          rights,
        });
        if (result.asset === null) throw new Error("媒体导入未返回不可变资产");
        nextVersion = await api.getContentVersion(result.asset.contentVersionId);
        setVersion(nextVersion);
        setVariants([]);
        setAuditState({});
        setAuditRequestKeys({});
        setMediaImportProgress({ completed: index + 1, total: files.length });
      }
      setMediaNotice(
        `${files.length} 张真实图片已绑定到 v${nextVersion.version}；字节、权利、OCR、旅行相关性和场景差异均已检查。`,
      );
      formElement.reset();
      setMediaRightsKind("tenant_owned");
      setMediaPlatform("ctrip_community");
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setImportingMedia(false);
      setMediaImportProgress(null);
    }
  }

  async function searchAndImportMedia() {
    const plan = version?.payload.mediaSearchPlan;
    if (
      !canWrite ||
      version === null ||
      plan === undefined ||
      plan.length < 4 ||
      plan.length > 5 ||
      version.payload.media.some((media) => media.platform === mediaPlatform)
    ) {
      return;
    }
    setSearchingMedia(true);
    setMediaSearchResult(null);
    setMediaNotice(null);
    setError(null);
    try {
      const result = await api.searchAndImportMedia(version.id, {
        idempotencyKey: `web-media-search:${version.id}:${Date.now().toString(36)}`,
        platform: mediaPlatform,
      });
      const nextVersion = await api.getContentVersion(result.finalContentVersionId);
      setVersion(nextVersion);
      setVariants([]);
      setAuditState({});
      setAuditRequestKeys({});
      setMediaSearchResult(result);
      setMediaNotice(
        `已按 ${result.plannedCount} 组文章关键词绑定 ${result.imported.length} 张不同图片到 v${nextVersion.version}；另有 ${result.rejectedCandidateCount} 个候选未通过审计。`,
      );
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setSearchingMedia(false);
    }
  }

  async function runAudit(variant: PublicationVariant) {
    if (!canWrite || !canAudit) return;
    const existingRequestKey = auditRequestKeys[variant.id];
    const requestKey = existingRequestKey ?? newAuditIdempotencyKey(variant);
    if (existingRequestKey === undefined) {
      setAuditRequestKeys((current) => ({ ...current, [variant.id]: requestKey }));
    }
    setAuditing(variant.id);
    setError(null);
    try {
      const result = await api.auditVariant(variant.id, requestKey);
      setVariants((current) =>
        current.map((item) =>
          item.id === variant.id
            ? { ...item, state: "frozen", frozenAt: result.artifact.createdAt }
            : item,
        ),
      );
      setAuditState((current) => ({
        ...current,
        [variant.id]: {
          result,
          scheduledFor: localDateTime(5),
          publication: null,
          executionLevel: null,
          revoked: false,
          grantUnavailable: false,
        },
      }));
      setAuditRequestKeys((current) => {
        const next = { ...current };
        delete next[variant.id];
        return next;
      });
    } catch (requestError) {
      setError(
        `${apiError(requestError)}。响应未确认时可重试同一审计；成功后再次审计会使用新的请求键。`,
      );
    } finally {
      setAuditing(null);
    }
  }

  async function requestDemoPublication(
    variant: PublicationVariant,
    executionLevel: PublicationRequestInput["executionLevel"],
  ) {
    if (!canWrite || !canPublish) return;
    const state = auditState[variant.id];
    const authorization = state?.result.publicationAuthorization;
    if (state === undefined || authorization === undefined || authorization === null) return;
    const scheduledAt = Date.parse(state.scheduledFor);
    const latestAllowed = Date.parse(authorization.expiresAt) - 60_000;
    if (!Number.isFinite(scheduledAt) || scheduledAt < Date.now() || scheduledAt > latestAllowed) {
      setError("计划执行时间必须早于授权到期时间，并至少保留 1 分钟执行窗口");
      return;
    }
    setPublishing(variant.id);
    setError(null);
    try {
      const scheduledFor = new Date(state.scheduledFor).toISOString();
      const publication = await api.requestPublication({
        grantId: authorization.grantId,
        token: authorization.token,
        idempotencyKey: `web-publish:${executionLevel}:${authorization.grantId}:${scheduledFor}`,
        executionLevel,
        scheduledFor,
      });
      setAuditState((current) => ({
        ...current,
        [variant.id]: { ...state, publication, executionLevel },
      }));
    } catch (requestError) {
      const grantUnavailable =
        requestError instanceof GeoApiError &&
        ["PUBLICATION_POLICY_DENIED", "RESOURCE_CONFLICT"].includes(requestError.code);
      if (grantUnavailable) {
        setAuditState((current) => ({
          ...current,
          [variant.id]: { ...state, grantUnavailable: true },
        }));
      }
      setError(
        grantUnavailable
          ? `${apiError(requestError)}。当前授权已失效、已撤销或已使用，请重新审计获取新授权。`
          : apiError(requestError),
      );
    } finally {
      setPublishing(null);
    }
  }

  async function revokeGrant(variant: PublicationVariant) {
    if (!canWrite || !canRevoke) return;
    const state = auditState[variant.id];
    const authorization = state?.result.publicationAuthorization;
    if (state === undefined || authorization === undefined || authorization === null) return;
    setPublishing(variant.id);
    setError(null);
    try {
      await api.revokePublicationGrant(
        authorization.grantId,
        "operator revoked authorization before external publication",
      );
      setAuditState((current) => ({
        ...current,
        [variant.id]: { ...state, revoked: true },
      }));
    } catch (requestError) {
      const grantUnavailable =
        requestError instanceof GeoApiError && requestError.code === "RESOURCE_CONFLICT";
      if (grantUnavailable) {
        setAuditState((current) => ({
          ...current,
          [variant.id]: { ...state, grantUnavailable: true },
        }));
      }
      setError(
        grantUnavailable
          ? `${apiError(requestError)}。授权已不再可撤销，请刷新作业状态或重新审计。`
          : apiError(requestError),
      );
    } finally {
      setPublishing(null);
    }
  }

  if (loading) {
    return (
      <div className="ops-loading" role="status">
        <LoaderCircle className="spin" size={17} /> 正在读取文章版本与平台变体
      </div>
    );
  }

  return (
    <div className="ops-article-detail">
      <div className="ops-detail-heading">
        <div>
          <span>当前文章</span>
          <h3>{content.title}</h3>
          <small>
            {content.topicKey} · {contentTypeLabel(content.contentType)}
          </small>
        </div>
        <span className="ops-state-chip">{operationStatusLabel(content.state)}</span>
      </div>
      <InlineError value={error} />
      {version === null ? (
        <OperationNotice tone="danger">
          文章没有可读取的版本，平台变体与审计保持禁用。
        </OperationNotice>
      ) : (
        <>
          <form className="ops-version-editor" onSubmit={(event) => void saveVersion(event)}>
            <div className="ops-version-meta">
              <div>
                <span>版本</span>
                <strong>v{version.version}</strong>
              </div>
              <div>
                <span>载荷哈希</span>
                <strong className="mono">{shortHash(version.payloadHash)}</strong>
              </div>
              <div>
                <span>冻结</span>
                <strong>
                  {version.frozenAt === null ? "未冻结" : formatDate(version.frozenAt)}
                </strong>
              </div>
            </div>
            <label>
              版本摘要
              <textarea
                name="summary"
                rows={2}
                defaultValue={version.summary}
                readOnly={isCanonicalVersion}
                required
              />
            </label>
            <label>
              版本正文
              <textarea
                name="bodyMarkdown"
                rows={7}
                defaultValue={version.bodyMarkdown}
                readOnly={isCanonicalVersion}
                required
              />
            </label>
            <div className="ops-form-actions">
              <button
                className="button-secondary"
                type="submit"
                disabled={!canWrite || writingVersion || isCanonicalVersion}
              >
                {writingVersion ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <RefreshCw size={16} />
                )}
                保存为新版本
              </button>
              <label className="ops-variant-account-picker">
                <span>目标平台账号</span>
                <select
                  aria-label="目标平台账号"
                  value={variantAccountId}
                  disabled={!canWrite || generating || eligibleAccounts.length === 0}
                  onChange={(event) => setVariantAccountId(event.target.value)}
                >
                  <option value="">选择一个账号</option>
                  {eligibleAccounts.map((account) => {
                    const hasVariant = activeCurrentVariants.some(
                      (variant) => variant.channelAccountId === account.id,
                    );
                    return (
                      <option key={account.id} value={account.id} disabled={hasVariant}>
                        {platformName(account.platform)} · {account.displayName}
                        {hasVariant ? " · 已有变体" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <button
                className="button-primary"
                type="button"
                onClick={() => void generateVariant()}
                disabled={
                  !canWrite ||
                  generating ||
                  !isCanonicalVersion ||
                  selectedVariantAccount === undefined ||
                  activeCurrentVariants.some(
                    (variant) => variant.channelAccountId === selectedVariantAccount.id,
                  )
                }
                title={
                  isCanonicalVersion
                    ? undefined
                    : "当前历史版本没有规范引用，不能生成可审计平台变体"
                }
              >
                {generating ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                {generating ? "正在生成" : "生成该账号变体"}
              </button>
            </div>
          </form>

          <section className="ops-media-search" aria-labelledby={`media-search-${version.id}`}>
            <div className="ops-subheading">
              <div>
                <strong id={`media-search-${version.id}`}>文章关键词自动配图</strong>
                <span>
                  {version.payload.mediaSearchPlan === undefined
                    ? "当前版本没有搜图计划"
                    : `${version.payload.mediaSearchPlan.length} 组独立画面意图`}
                </span>
              </div>
              <span className="ops-state-chip">Wikimedia Commons</span>
            </div>
            {version.payload.mediaSearchPlan === undefined ? (
              <OperationNotice>请先让 Pi Agent 生成带图片搜索计划的新文章。</OperationNotice>
            ) : (
              <ol className="ops-media-search-list">
                {version.payload.mediaSearchPlan.map((intent, index) => {
                  const imported = mediaSearchResult?.imported.find(
                    (item) => item.query === intent.query && item.role === intent.role,
                  );
                  return (
                    <li key={`${intent.role}:${intent.query}`}>
                      <span className="ops-media-search-index">{index + 1}</span>
                      <div>
                        <strong>{intent.query}</strong>
                        <span>{intent.rationale}</span>
                      </div>
                      <span className={`ops-state-chip${imported === undefined ? "" : " success"}`}>
                        {searchingMedia
                          ? "检索与审核中"
                          : imported === undefined
                            ? intent.role === "cover"
                              ? "封面待检索"
                              : "正文图待检索"
                            : "已通过"}
                      </span>
                      {imported === undefined ? null : (
                        <a href={imported.sourceUrl} target="_blank" rel="noreferrer">
                          授权来源
                        </a>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="ops-form-actions">
              <button
                className="button-primary"
                type="button"
                onClick={() => void searchAndImportMedia()}
                disabled={
                  !canWrite ||
                  searchingMedia ||
                  importingMedia ||
                  version.payload.mediaSearchPlan === undefined ||
                  version.payload.media.some((media) => media.platform === mediaPlatform)
                }
                title={
                  version.payload.media.some((media) => media.platform === mediaPlatform)
                    ? `当前版本已有 ${platformName(mediaPlatform)} 图片；自动搜图将从现有媒体前缀继续`
                    : undefined
                }
              >
                {searchingMedia ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <FileSearch size={16} />
                )}
                {searchingMedia ? "正在匹配 4 至 5 张图片" : "按文章关键词自动配图"}
              </button>
            </div>
          </section>

          <form className="ops-media-import" onSubmit={(event) => void importMedia(event)}>
            <div className="ops-subheading">
              <div>
                <strong>真实图片资产</strong>
                <span>
                  携程{" "}
                  {
                    version.payload.media.filter((media) => media.platform === "ctrip_community")
                      .length
                  }
                  /{CTRIP_COMMUNITY_PUBLICATION_LIMITS.targetImages}
                </span>
              </div>
              <span className="ops-state-chip">服务端验真</span>
            </div>
            {mediaNotice === null ? null : <OperationNotice>{mediaNotice}</OperationNotice>}
            <div className="ops-media-import-grid">
              <label>
                图片文件
                <input
                  name="mediaFiles"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  disabled={!canWrite || importingMedia}
                  required
                />
              </label>
              <label>
                平台
                <select
                  name="platform"
                  value={mediaPlatform}
                  disabled={importingMedia}
                  onChange={(event) => setMediaPlatform(event.target.value as typeof mediaPlatform)}
                >
                  {[...new Set(eligibleAccounts.map((account) => account.platform))].map(
                    (platform) => (
                      <option key={platform} value={platform}>
                        {platformName(platform)}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {mediaPlatform === "ctrip_community" ? (
                <label>
                  图片编排
                  <input value="自动：1 张封面，其余正文图" readOnly />
                </label>
              ) : (
                <label>
                  图片位置
                  <select name="role" defaultValue="cover" disabled={importingMedia}>
                    <option value="cover">封面</option>
                    <option value="inline">正文配图</option>
                  </select>
                </label>
              )}
              <label>
                权利来源
                <select
                  name="rightsKind"
                  value={mediaRightsKind}
                  disabled={importingMedia}
                  onChange={(event) =>
                    setMediaRightsKind(event.target.value as typeof mediaRightsKind)
                  }
                >
                  <option value="tenant_owned">客户自有图片</option>
                  <option value="licensed_stock">已授权图库图片</option>
                </select>
              </label>
            </div>
            <fieldset className="ops-media-claims">
              <legend>图片依据事实（可选，最多 3 条）</legend>
              {version.payload.claims.slice(0, 3).map((claim) => (
                <label key={claim.id}>
                  <input
                    type="checkbox"
                    name="claimId"
                    value={claim.id}
                    disabled={importingMedia}
                  />
                  <span>{claim.text}</span>
                </label>
              ))}
            </fieldset>
            <div className="ops-media-rights">
              <label>
                权利名称
                <input
                  key={mediaRightsKind}
                  name="licenseName"
                  defaultValue={
                    mediaRightsKind === "tenant_owned" ? "客户原创图片" : "商业图片授权"
                  }
                  disabled={importingMedia}
                  required
                />
              </label>
              {mediaRightsKind === "tenant_owned" ? (
                <label>
                  所有权声明
                  <textarea
                    name="ownershipAssertion"
                    rows={2}
                    placeholder="说明图片由本机构或已授权摄影师创作，并拥有当前投放用途的权利。"
                    disabled={importingMedia}
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    授权类型
                    <select name="licenseBasis" defaultValue="commercial_license">
                      <option value="commercial_license">商业授权</option>
                      <option value="editorial_license">编辑用途授权</option>
                    </select>
                  </label>
                  <label>
                    图片来源 URL
                    <input name="sourceUrl" type="url" placeholder="https://" required />
                  </label>
                  <label>
                    授权条款 URL
                    <input name="licenseUrl" type="url" placeholder="https://" required />
                  </label>
                  <label>
                    署名（可选）
                    <input name="attribution" />
                  </label>
                  <label>
                    授权说明
                    <textarea name="rightsDescription" rows={2} required />
                  </label>
                </>
              )}
            </div>
            <div className="ops-form-actions">
              <button
                className="button-primary"
                type="submit"
                disabled={!canWrite || importingMedia || eligibleAccounts.length === 0}
              >
                {importingMedia ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Upload size={16} />
                )}
                {mediaImportProgress === null
                  ? "批量导入并生成新版本"
                  : `正在导入 ${mediaImportProgress.completed}/${mediaImportProgress.total}`}
              </button>
            </div>
          </form>

          <div className="ops-platform-boundary">
            <ShieldAlert size={17} />
            <span>
              五个平台统一使用浏览器自动化连接；账号登录态就绪后可按配置进入人工辅助或无人值守。所有平台仍需账号会话、审计、平台连接与公开回读证据。
            </span>
          </div>
          <div className="ops-variant-list">
            {eligibleAccounts.map((account) => {
              const executionLevel = demoExecutionLevel(account);
              if (executionLevel === null) return null;
              const variant = activeCurrentVariants.find(
                (item) => item.channelAccountId === account.id,
              );
              const supersededCount = currentVariants.filter(
                (item) => item.channelAccountId === account.id && item.state === "superseded",
              ).length;
              const state = variant === undefined ? undefined : auditState[variant.id];
              const authorization = state?.result.publicationAuthorization;
              const authorizationExpired =
                authorization !== null &&
                authorization !== undefined &&
                Date.parse(authorization.expiresAt) <= Date.now() + 60_000;
              const auditAction =
                variant !== undefined && auditRequestKeys[variant.id] !== undefined
                  ? "重试同一审计"
                  : state === undefined
                    ? "审计"
                    : "重新审计";
              return (
                <section className="ops-variant-row" key={account.id}>
                  <div className="ops-variant-primary">
                    <span className="platform-initial">
                      {platformName(account.platform).slice(0, 1)}
                    </span>
                    <div>
                      <strong>{platformName(account.platform)}</strong>
                      <span>{account.displayName}</span>
                    </div>
                  </div>
                  <div className="ops-boundary-labels">
                    <span>{connectorCapabilityLabel(account.capability)}</span>
                    <span>{executionLevelLabel(executionLevel)}</span>
                    <span>未发生真实外部发布</span>
                  </div>
                  {variant === undefined ? (
                    <span className="muted">
                      待生成变体{supersededCount > 0 ? ` · 已停用 ${supersededCount}` : ""}
                    </span>
                  ) : (
                    <>
                      <div className="ops-hash-cell">
                        <span>variant v{variant.variantVersion}</span>
                        <strong className="mono">{shortHash(variant.payloadHash)}</strong>
                      </div>
                      <button
                        className="button-secondary"
                        type="button"
                        onClick={() => void runAudit(variant)}
                        disabled={!canWrite || !canAudit || auditing === variant.id}
                      >
                        {auditing === variant.id ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <FileSearch size={15} />
                        )}
                        {auditAction} {platformName(account.platform)}
                      </button>
                      {variant.state === "draft" && state === undefined ? (
                        <button
                          className="button-secondary danger-text"
                          type="button"
                          disabled={!canWrite || superseding !== null}
                          onClick={() => {
                            setSupersedeIntent(variant);
                            setSupersedeReason("");
                          }}
                        >
                          <Ban size={15} /> 停用草稿
                        </button>
                      ) : null}
                    </>
                  )}
                  {variant !== undefined && supersedeIntent?.id === variant.id ? (
                    <form
                      className="ops-variant-supersede"
                      onSubmit={(event) => void supersedeVariant(event)}
                    >
                      <label>
                        停用原因
                        <input
                          aria-label={`停用 ${account.displayName} 草稿的原因`}
                          value={supersedeReason}
                          minLength={3}
                          maxLength={500}
                          required
                          autoFocus
                          onChange={(event) => setSupersedeReason(event.target.value)}
                        />
                      </label>
                      <button
                        className="button-secondary"
                        type="button"
                        disabled={superseding === variant.id}
                        onClick={() => {
                          setSupersedeIntent(null);
                          setSupersedeReason("");
                        }}
                      >
                        <X size={15} /> 取消
                      </button>
                      <button
                        className="button-secondary danger-text"
                        type="submit"
                        disabled={superseding === variant.id || supersedeReason.trim().length < 3}
                      >
                        {superseding === variant.id ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Ban size={15} />
                        )}
                        确认停用
                      </button>
                    </form>
                  ) : null}
                  {variant !== undefined && state !== undefined ? (
                    <div className="ops-audit-result">
                      <div>
                        {state.result.artifact.status === "passed" ? (
                          <CheckCircle2 size={17} />
                        ) : (
                          <AlertTriangle size={17} />
                        )}
                        <strong>
                          审计{state.result.artifact.status === "passed" ? "通过" : "未通过"}
                        </strong>
                        <span>
                          {state.result.artifact.findings.length} 项发现 · 策略版本{" "}
                          {state.result.artifact.policyVersion}
                        </span>
                      </div>
                      {authorization === null || authorization === undefined ? (
                        <OperationNotice tone="warning">
                          未签发投放授权；请修正阻断项或权限条件，再使用上方按钮重新审计。
                        </OperationNotice>
                      ) : state.revoked ? (
                        <OperationNotice tone="warning">
                          发布许可已撤销；请使用上方按钮重新审计获取新授权。
                        </OperationNotice>
                      ) : state.grantUnavailable ? (
                        <OperationNotice tone="warning">
                          发布许可已失效、撤销或使用；请重新审计后再排期。
                        </OperationNotice>
                      ) : authorizationExpired ? (
                        <OperationNotice tone="warning">
                          发布许可已过期或执行窗口不足；请重新审计获取新授权。
                        </OperationNotice>
                      ) : state.publication === null ? (
                        <div className="ops-publish-controls">
                          <label>
                            计划执行时间
                            <input
                              type="datetime-local"
                              value={state.scheduledFor}
                              min={localDateTime(1)}
                              max={localDateTimeFromIso(authorization.expiresAt, -1)}
                              disabled={!canWrite}
                              onChange={(event) =>
                                setAuditState((current) => ({
                                  ...current,
                                  [variant.id]: { ...state, scheduledFor: event.target.value },
                                }))
                              }
                              required
                            />
                          </label>
                          <button
                            className="button-primary"
                            type="button"
                            onClick={() => void requestDemoPublication(variant, executionLevel)}
                            disabled={!canWrite || !canPublish || publishing === variant.id}
                          >
                            {publishing === variant.id ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <CalendarClock size={15} />
                            )}
                            {executionLevel === "assisted"
                              ? `提交${platformName(account.platform)}辅助发布`
                              : executionLevel === "unattended"
                                ? `启动${platformName(account.platform)}无人值守流程`
                                : "提交排期演练"}
                          </button>
                          <button
                            className="button-secondary danger-text"
                            type="button"
                            onClick={() => void revokeGrant(variant)}
                            disabled={!canWrite || !canRevoke || publishing === variant.id}
                          >
                            <Ban size={15} /> 撤销授权
                          </button>
                        </div>
                      ) : (
                        <div className="ops-publication-created" role="status">
                          <CheckCircle2 size={17} />
                          <div>
                            <strong>
                              {state.executionLevel === "assisted"
                                ? `${platformName(account.platform)}辅助作业已创建`
                                : state.executionLevel === "unattended"
                                  ? `${platformName(account.platform)}无人值守作业已创建`
                                  : "演练作业已创建"}
                            </strong>
                            <span className="mono">{state.publication.publicationJobId}</span>
                          </div>
                          <NavLink className="text-link" to="/publishing">
                            查看作业 <ChevronRight size={15} />
                          </NavLink>
                        </div>
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function OperationsWorkspace({
  api,
  tenantId,
  capabilities,
  brands: incomingBrands,
  evidenceSources: incomingEvidence,
  facts: incomingFacts,
  campaigns: incomingCampaigns,
  contentItems: incomingContent,
  accounts,
  contacts,
  policies,
  templates,
  catalogVersion,
  resources,
}: OperationsWorkspaceProps) {
  const [brands, setBrands] = useState<readonly Brand[]>(incomingBrands);
  const [evidence, setEvidence] = useState<readonly EvidenceSource[]>(incomingEvidence);
  const [facts, setFacts] = useState<readonly ClaimFact[]>(incomingFacts);
  const [campaigns, setCampaigns] = useState<readonly Campaign[]>(incomingCampaigns);
  const [content, setContent] = useState<readonly ContentItem[]>(incomingContent);
  const [selectedContentId, setSelectedContentId] = useState<string | null>(
    incomingContent[0]?.id ?? null,
  );
  const [contentQuery, setContentQuery] = useState("");
  const [contentFilter, setContentFilter] = useState<"all" | "draft" | "other">("all");
  const canWrite = capabilities.includes("content:write");
  const canVerify = capabilities.includes("tenant:manage");

  useEffect(() => {
    setBrands(incomingBrands);
    setEvidence(incomingEvidence);
    setFacts(incomingFacts);
    setCampaigns(incomingCampaigns);
    setContent(incomingContent);
    setSelectedContentId(incomingContent[0]?.id ?? null);
    setContentQuery("");
    setContentFilter("all");
  }, [tenantId]);

  useEffect(() => setBrands((current) => mergeById(current, incomingBrands)), [incomingBrands]);
  useEffect(
    () => setEvidence((current) => mergeById(current, incomingEvidence)),
    [incomingEvidence],
  );
  useEffect(() => setFacts((current) => mergeById(current, incomingFacts)), [incomingFacts]);
  useEffect(
    () => setCampaigns((current) => mergeById(current, incomingCampaigns)),
    [incomingCampaigns],
  );
  useEffect(() => {
    setContent((current) => mergeById(current, incomingContent));
    setSelectedContentId((current) => current ?? incomingContent[0]?.id ?? null);
  }, [incomingContent]);

  const visibleContent = useMemo(() => {
    const query = contentQuery.trim().toLocaleLowerCase("zh-CN");
    return content.filter((item) => {
      const matchesState =
        contentFilter === "all" ||
        (contentFilter === "draft" ? item.state === "draft" : item.state !== "draft");
      const matchesQuery =
        query === "" ||
        [item.title, item.topicKey, item.contentType, item.state].some((value) =>
          value.toLocaleLowerCase("zh-CN").includes(query),
        );
      return matchesState && matchesQuery;
    });
  }, [content, contentFilter, contentQuery]);
  const selectedContent = content.find((item) => item.id === selectedContentId) ?? null;
  const readyStages = [
    evidence.length > 0,
    facts.length > 0,
    campaigns.length > 0 && content.length > 0,
    selectedContent !== null,
  ];
  const resourceFailure = Object.values(resources).some((status) => status === "error");
  const verifiedFactCount = facts.filter((fact) => fact.status === "verified").length;
  const activeAccountCount = accounts.filter((account) => account.status === "active").length;
  const manualReviewRefreshKey = content.map((item) => item.latestVersionId ?? "").join(":");

  return (
    <div className="ops-workspace execution-console">
      <header className="ops-console-header">
        <div className="ops-console-title">
          <span>
            <Activity size={14} /> 执行控制台
          </span>
          <h2>内容生产与多平台投放</h2>
        </div>
        <dl className="ops-console-metrics" aria-label="运营资源摘要">
          <div>
            <dt>证据</dt>
            <dd>{evidence.length}</dd>
          </div>
          <div>
            <dt>已核验事实</dt>
            <dd>{verifiedFactCount}</dd>
          </div>
          <div>
            <dt>文章</dt>
            <dd>{content.length}</dd>
          </div>
          <div data-tone={activeAccountCount === 0 ? "warning" : "success"}>
            <dt>在线账号</dt>
            <dd>{activeAccountCount}</dd>
          </div>
        </dl>
      </header>

      {resourceFailure ? (
        <OperationNotice tone="danger">
          部分运营接口读取失败；依赖该数据的步骤保持禁用，不会以演示数据补位。
        </OperationNotice>
      ) : null}
      {!canWrite ? (
        <OperationNotice tone="warning">
          当前会话缺少内容写入权限；工作台保留只读状态，所有写入按钮已禁用。
        </OperationNotice>
      ) : null}

      <ManualMediaReviewQueue api={api} canWrite={canWrite} refreshKey={manualReviewRefreshKey} />

      <section className="ops-flow-band" aria-label="GEO 运营链">
        <div>
          <span>受治理运营链</span>
          <strong>证据 → 事实 → 文章版本 → 五平台变体 → 审计 → 异步发布</strong>
        </div>
        <ol>
          {["证据", "事实", "文章", "变体", "审计与演练"].map((label, index) => (
            <li
              key={label}
              className={index < readyStages.length && readyStages[index] ? "complete" : ""}
            >
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </section>

      <OperationNotice>
        五个平台统一使用浏览器自动化连接；账号登录态就绪后可按配置进入人工辅助或无人值守。所有路径均先审计，失败或证据不完整时自动停止。
      </OperationNotice>

      <AgentArticleComposer
        api={api}
        tenantId={tenantId}
        brands={brands}
        campaigns={campaigns}
        accounts={accounts}
        templates={templates}
        canWrite={canWrite}
        onCompleted={(refreshed, completed) => {
          setContent(refreshed);
          const selectedId =
            completed.result.providerMode === "fixture"
              ? completed.result.contentItemId
              : (refreshed[0]?.id ?? null);
          setSelectedContentId(selectedId);
        }}
      />

      <section className="ops-evidence-band">
        <div className="ops-section-heading">
          <div>
            <span>01 · 证据与事实</span>
            <h2>先建立可核验真值</h2>
          </div>
          <div className="ops-heading-actions">
            <EvidenceComposer
              api={api}
              brandsAvailable={brands.length > 0}
              canWrite={canWrite}
              onCreated={(source) => setEvidence((items) => [...items, source])}
            />
            <FactComposer
              api={api}
              brands={brands}
              evidenceSources={evidence}
              canWrite={canWrite}
              canVerify={canVerify}
              onCreated={(fact) => setFacts((items) => [...items, fact])}
            />
          </div>
        </div>
        <div className="ops-source-grid">
          <div>
            <div className="ops-subheading">
              <strong>证据源</strong>
              <span>{evidence.length}</span>
            </div>
            {resources.evidence === "loading" && evidence.length === 0 ? (
              <span className="ops-empty">
                <LoaderCircle className="spin" size={15} /> 正在读取证据
              </span>
            ) : evidence.length === 0 ? (
              <span className="ops-empty">尚无证据源，事实登记保持禁用</span>
            ) : (
              <ul className="ops-compact-list">
                {evidence
                  .slice(-5)
                  .reverse()
                  .map((source) => (
                    <li key={source.id}>
                      <div>
                        <strong>{source.title}</strong>
                        <span>
                          {evidenceSourceTypeLabel(source.type)} · {formatDate(source.capturedAt)}
                        </span>
                      </div>
                      <code>{shortHash(source.contentHash)}</code>
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div>
            <div className="ops-subheading">
              <strong>可引用事实</strong>
              <span>{facts.length}</span>
            </div>
            {resources.facts === "loading" && facts.length === 0 ? (
              <span className="ops-empty">
                <LoaderCircle className="spin" size={15} /> 正在读取事实
              </span>
            ) : facts.length === 0 ? (
              <span className="ops-empty">尚无事实；文章创建要求至少一条证据绑定事实</span>
            ) : (
              <ul className="ops-compact-list">
                {facts
                  .slice(-5)
                  .reverse()
                  .map((fact) => (
                    <li key={fact.id}>
                      <div>
                        <strong>{fact.normalizedKey}</strong>
                        <span>{fact.claim}</span>
                      </div>
                      <span
                        className={`ops-state-chip ${fact.status === "verified" ? "success" : ""}`}
                      >
                        {factStatusLabel(fact.status)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="ops-content-band">
        <div className="ops-section-heading">
          <div>
            <span>02 · 推广计划与文章</span>
            <h2>版本化内容工作区</h2>
          </div>
          <ArticleComposer
            api={api}
            campaigns={campaigns}
            facts={facts}
            contacts={contacts}
            policies={policies}
            templates={templates}
            catalogVersion={catalogVersion}
            canWrite={canWrite}
            onCreated={(item) => {
              setContent((items) => [item, ...items]);
              setSelectedContentId(item.id);
            }}
          />
        </div>
        {campaigns.length === 0 ? (
          <OperationNotice tone="warning">
            没有可用推广计划。请先用页面右上角“新建推广计划”建立计划。
          </OperationNotice>
        ) : null}
        <div className="ops-content-toolbar">
          <label className="ops-search-control">
            <Search size={15} />
            <input
              type="search"
              aria-label="搜索文章"
              placeholder="搜索标题、主题键或类型"
              value={contentQuery}
              onChange={(event) => setContentQuery(event.target.value)}
            />
          </label>
          <div className="segmented-control" aria-label="文章状态筛选">
            <button
              type="button"
              className={contentFilter === "all" ? "active" : ""}
              onClick={() => setContentFilter("all")}
            >
              全部 {content.length}
            </button>
            <button
              type="button"
              className={contentFilter === "draft" ? "active" : ""}
              onClick={() => setContentFilter("draft")}
            >
              草稿 {content.filter((item) => item.state === "draft").length}
            </button>
            <button
              type="button"
              className={contentFilter === "other" ? "active" : ""}
              onClick={() => setContentFilter("other")}
            >
              其他 {content.filter((item) => item.state !== "draft").length}
            </button>
          </div>
        </div>
        <div className="ops-content-layout">
          <div className="ops-content-index" aria-label="文章列表">
            <div className="ops-list-head" aria-hidden="true">
              <span>文章</span>
              <span>版本</span>
            </div>
            {content.length === 0 ? (
              <span className="ops-empty">尚无文章；创建操作会同时生成 v1</span>
            ) : visibleContent.length === 0 ? (
              <span className="ops-empty">没有匹配当前筛选条件的文章</span>
            ) : (
              visibleContent.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedContentId ? "selected" : ""}
                  onClick={() => setSelectedContentId(item.id)}
                  aria-label={`打开运营链：${item.title}`}
                >
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {contentTypeLabel(item.contentType)} · {item.topicKey}
                    </span>
                  </div>
                  <span>v{item.latestVersion ?? "—"}</span>
                  <ChevronRight size={16} />
                </button>
              ))
            )}
          </div>
          <div className="ops-content-detail">
            {selectedContent === null ? (
              <div className="ops-placeholder">
                <Eye size={21} />
                <strong>选择文章继续</strong>
                <span>版本、平台变体和审计会在这里展开</span>
              </div>
            ) : (
              <ArticleOperations
                key={`${selectedContent.id}:${selectedContent.latestVersionId ?? "none"}`}
                api={api}
                content={selectedContent}
                accounts={accounts}
                capabilities={capabilities}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export interface PublicationJobDetailProps {
  readonly api: GeoApi;
  readonly tenantId: string;
  readonly jobId: string | null;
  readonly canCancel: boolean;
  readonly onCancelled: (job: PublicationJob) => void;
}

export function PublicationJobDetail({
  api,
  tenantId,
  jobId,
  canCancel,
  onCancelled,
}: PublicationJobDetailProps) {
  const scopeKey = `${tenantId}:${jobId ?? "none"}`;
  const activeScope = useRef(scopeKey);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loadedJob, setLoadedJob] = useState<PublicationJob | null>(null);
  const [attempts, setAttempts] = useState<readonly PublicationAttempt[]>([]);
  const [receipts, setReceipts] = useState<readonly PublicationReceipt[]>([]);
  const [readbacks, setReadbacks] = useState<readonly PublicationReadback[]>([]);
  const [receiptDetail, setReceiptDetail] = useState<PublicationReceipt | null>(null);
  const [tab, setTab] = useState<"attempts" | "receipts" | "readbacks">("attempts");
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("运营人员取消了排队中的演练作业");
  const [error, setError] = useState<string | null>(null);
  const job = loadedScope === scopeKey ? loadedJob : null;

  useEffect(() => {
    activeScope.current = scopeKey;
    setLoadedScope(null);
    setLoadedJob(null);
    setAttempts([]);
    setReceipts([]);
    setReadbacks([]);
    setReceiptDetail(null);
    setError(null);
    setCancelling(false);
    if (jobId === null) {
      setLoading(false);
      return;
    }
    let active = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let requestInFlight = false;
    setLoading(true);
    const load = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        try {
          const nextJob = await api.getPublicationJob(jobId);
          if (!active || activeScope.current !== scopeKey) return;
          setLoadedJob(nextJob);
          setLoadedScope(scopeKey);
          setLoading(false);
          if (isTerminalPublicationJobState(nextJob.state) && pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch (requestError) {
          if (!active || activeScope.current !== scopeKey) return;
          setError(apiError(requestError));
          setLoadedScope(scopeKey);
          setLoading(false);
          return;
        }

        const [attemptResult, receiptResult, readbackResult] = await Promise.allSettled([
          api.getPublicationAttempts(jobId),
          api.getPublicationReceipts(jobId),
          api.getPublicationReadbacks(jobId),
        ]);
        if (!active || activeScope.current !== scopeKey) return;
        if (attemptResult.status === "fulfilled") setAttempts(attemptResult.value);
        if (receiptResult.status === "fulfilled") setReceipts(receiptResult.value);
        if (readbackResult.status === "fulfilled") setReadbacks(readbackResult.value);
        const auxiliaryResults: ReadonlyArray<readonly [string, PromiseSettledResult<unknown>]> = [
          ["尝试", attemptResult],
          ["回执", receiptResult],
          ["回读", readbackResult],
        ];
        const failures = auxiliaryResults.flatMap(([label, result]) =>
          result.status === "rejected" ? [`${label}: ${apiError(result.reason)}`] : [],
        );
        if (failures.length > 0) {
          setError(`附属作业证据读取失败（主作业仍可操作）：${failures.join("；")}`);
        }
      } finally {
        requestInFlight = false;
      }
    };
    void load();
    pollTimer = setInterval(() => {
      if (active && activeScope.current === scopeKey) void load();
    }, 15_000);
    return () => {
      active = false;
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }, [api, jobId, scopeKey, tenantId]);

  async function cancelJob() {
    if (job === null) return;
    const requestScope = scopeKey;
    setCancelling(true);
    setError(null);
    try {
      const result = await api.cancelPublicationJob(job.id, reason.trim());
      if (activeScope.current !== requestScope) return;
      setLoadedJob(result.job);
      onCancelled(result.job);
    } catch (requestError) {
      if (activeScope.current === requestScope) setError(apiError(requestError));
    } finally {
      if (activeScope.current === requestScope) setCancelling(false);
    }
  }

  async function openReceipt(receipt: PublicationReceipt) {
    const requestScope = scopeKey;
    setError(null);
    try {
      const detail = await api.getReceipt(receipt.id);
      if (activeScope.current === requestScope) setReceiptDetail(detail);
    } catch (requestError) {
      if (activeScope.current === requestScope) setError(apiError(requestError));
    }
  }

  if (jobId === null) {
    return (
      <section className="panel ops-job-detail ops-placeholder">
        <Eye size={21} />
        <strong>选择作业查看运行证据</strong>
        <span>投放尝试、平台回执与公开回读分别保留，不会折叠成单一“成功”状态</span>
      </section>
    );
  }

  if (loading || loadedScope !== scopeKey) {
    return (
      <section className="panel ops-job-detail ops-loading" role="status">
        <LoaderCircle className="spin" size={18} /> 正在读取作业明细
      </section>
    );
  }

  if (job === null) {
    return (
      <section className="panel ops-job-detail">
        <InlineError value={error ?? "作业详情不可用"} />
      </section>
    );
  }

  const cancellable = ["queued", "retry_wait"].includes(job.state);
  const latestAttempt = attempts.at(-1);
  const latestReceipt = receipts.at(-1);
  const latestReadback = readbacks.at(-1);
  const confirmedExternalUrl =
    [...receipts]
      .reverse()
      .find((receipt) => isConfirmedReceipt(receipt) && receipt.externalUrl !== null)
      ?.externalUrl ?? null;
  const readbackExternalUrl =
    readbacks
      .map(
        (readback) =>
          receipts.find((receipt) => receipt.id === readback.receiptId)?.externalUrl ?? null,
      )
      .find((externalUrl) => externalUrl !== null) ?? null;
  const externalUrl = confirmedExternalUrl ?? readbackExternalUrl;
  const executionFailed =
    job.lastErrorCode !== null ||
    stateTone(job.state) === "danger" ||
    (latestAttempt?.errorCode ?? null) !== null;
  const timeline = [
    {
      label: "已进入队列",
      detail: formatDate(job.createdAt),
      state: "complete",
    },
    {
      label: "平台执行",
      detail:
        latestAttempt === undefined
          ? publicationStateLabel(job.state)
          : `尝试 #${latestAttempt.attemptNo} · ${publicationStateLabel(latestAttempt.state)}`,
      state: executionFailed
        ? "failed"
        : latestAttempt === undefined
          ? "active"
          : latestAttempt.finishedAt === null
            ? "active"
            : "complete",
    },
    {
      label: "投放回执",
      detail:
        latestReceipt === undefined
          ? "等待回执"
          : `${evidenceTypeLabel(latestReceipt.evidenceType)} · ${isConfirmedReceipt(latestReceipt) ? "已确认" : "未确认"}`,
      state:
        latestReceipt === undefined
          ? "waiting"
          : isConfirmedReceipt(latestReceipt)
            ? "complete"
            : "active",
    },
    {
      label: "公开回读",
      detail:
        latestReadback === undefined
          ? "等待回读"
          : `${publicationStateLabel(latestReadback.status)} · ${latestReadback.required ? "必须" : "可选"}`,
      state:
        latestReadback === undefined
          ? "waiting"
          : latestReadback.status === "succeeded"
            ? "complete"
            : latestReadback.lastError !== null || latestReadback.status === "failed"
              ? "failed"
              : "active",
    },
  ] as const;
  return (
    <section className="panel ops-job-detail execution-console-job" data-state={job.state}>
      <div className="ops-section-heading">
        <div>
          <span>作业详情 · {platformName(job.platform)}</span>
          <h2 className="mono">{job.id}</h2>
        </div>
        <span className={`ops-state-chip ${stateTone(job.state)}`}>
          {publicationStateLabel(job.state)}
        </span>
      </div>
      <InlineError value={error} />
      <div className="ops-job-boundary">
        <ShieldAlert size={17} />
        <strong>{executionLevelLabel(job.executionLevel)}</strong>
        <span>
          {job.executionLevel === "dry_run"
            ? "演练 · 未发生外部发布"
            : job.executionLevel === "assisted"
              ? `${platformName(job.platform)} · 人工辅助提交 · 等待公开回读确认`
              : `${platformName(job.platform)} · 无人值守提交 · 等待公开回读确认`}
        </span>
      </div>
      <ol className="ops-run-timeline" aria-label="作业执行时间线">
        {timeline.map((step) => (
          <li key={step.label} data-state={step.state}>
            <CircleDot size={15} />
            <div>
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </div>
          </li>
        ))}
      </ol>
      <dl className="ops-job-meta">
        <div>
          <dt>排期</dt>
          <dd>{formatDate(job.scheduledFor)}</dd>
        </div>
        <div>
          <dt>可执行</dt>
          <dd>{formatDate(job.availableAt)}</dd>
        </div>
        <div>
          <dt>尝试次数</dt>
          <dd>{job.attemptCount}</dd>
        </div>
        <div>
          <dt>载荷哈希</dt>
          <dd className="mono">{shortHash(job.payloadHash)}</dd>
        </div>
        <div>
          <dt>发布许可</dt>
          <dd className="mono">{shortHash(job.grantId)}</dd>
        </div>
        <div>
          <dt>最近错误</dt>
          <dd>{job.lastErrorCode ?? "无"}</dd>
        </div>
        {externalUrl === null ? null : (
          <div className="ops-job-external-url">
            <dt>原始公开 URL</dt>
            <dd>
              <a href={externalUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                <span>{externalUrl}</span>
              </a>
            </dd>
          </div>
        )}
      </dl>
      {cancellable ? (
        <div className="ops-cancel-row">
          <label>
            取消原因
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={5}
            />
          </label>
          <button
            className="button-secondary danger-text"
            type="button"
            onClick={() => void cancelJob()}
            disabled={!canCancel || cancelling || reason.trim().length < 5}
          >
            {cancelling ? <LoaderCircle className="spin" size={15} /> : <Square size={15} />}
            取消作业
          </button>
        </div>
      ) : null}
      <div className="segmented-control ops-detail-tabs" aria-label="作业证据视图">
        <button className={tab === "attempts" ? "active" : ""} onClick={() => setTab("attempts")}>
          尝试 {attempts.length}
        </button>
        <button className={tab === "receipts" ? "active" : ""} onClick={() => setTab("receipts")}>
          回执 {receipts.length}
        </button>
        <button className={tab === "readbacks" ? "active" : ""} onClick={() => setTab("readbacks")}>
          回读 {readbacks.length}
        </button>
      </div>
      <div className="ops-detail-list">
        {tab === "attempts" &&
          attempts.map((attempt) => (
            <div key={attempt.id}>
              <div>
                <strong>尝试 #{attempt.attemptNo}</strong>
                <span>{publicationStateLabel(attempt.state)}</span>
              </div>
              <code>{shortHash(attempt.requestHash)}</code>
              <span>{formatDate(attempt.startedAt)}</span>
              <small>{attempt.errorCode ?? "无错误"}</small>
            </div>
          ))}
        {tab === "receipts" &&
          receipts.map((receipt) => (
            <button key={receipt.id} type="button" onClick={() => void openReceipt(receipt)}>
              <div>
                <strong>{evidenceTypeLabel(receipt.evidenceType)}</strong>
                <span>{isConfirmedReceipt(receipt) ? "已确认" : "未确认"}</span>
              </div>
              <code>{shortHash(receipt.responseHash)}</code>
              <span>{formatDate(receipt.recordedAt)}</span>
              <Eye size={15} />
            </button>
          ))}
        {tab === "readbacks" &&
          readbacks.map((readback) => {
            const readbackExternalUrl =
              receipts.find((receipt) => receipt.id === readback.receiptId)?.externalUrl ?? null;
            return (
              <div key={readback.id}>
                <div>
                  <strong>{publicationStateLabel(readback.status)}</strong>
                  <span>{readback.required ? "必须回读" : "不要求外部回读"}</span>
                </div>
                {readbackExternalUrl === null ? null : (
                  <a href={readbackExternalUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} />
                    <span>{readbackExternalUrl}</span>
                  </a>
                )}
                <span>{readback.reason ?? "未记录原因"}</span>
                <span>{formatDate(readback.scheduledFor)}</span>
                <small>{readback.lastError ?? "无错误"}</small>
              </div>
            );
          })}
        {(tab === "attempts" && attempts.length === 0) ||
        (tab === "receipts" && receipts.length === 0) ||
        (tab === "readbacks" && readbacks.length === 0) ? (
          <span className="ops-empty">当前视图没有持久记录</span>
        ) : null}
      </div>
      {receiptDetail === null ? null : (
        <div className="ops-receipt-detail">
          <div>
            <strong>回执详情</strong>
            <button
              className="icon-button"
              onClick={() => setReceiptDetail(null)}
              aria-label="关闭回执详情"
            >
              <X size={15} />
            </button>
          </div>
          <dl>
            <div>
              <dt>证据类型</dt>
              <dd>{evidenceTypeLabel(receiptDetail.evidenceType)}</dd>
            </div>
            <div>
              <dt>确认状态</dt>
              <dd>{isConfirmedReceipt(receiptDetail) ? "已确认" : "未确认（演练预览）"}</dd>
            </div>
            <div>
              <dt>外部链接</dt>
              <dd>{receiptDetail.externalUrl ?? "无（演练）"}</dd>
            </div>
            <div>
              <dt>请求哈希</dt>
              <dd className="mono">{shortHash(receiptDetail.requestHash)}</dd>
            </div>
            <div>
              <dt>响应哈希</dt>
              <dd className="mono">{shortHash(receiptDetail.responseHash)}</dd>
            </div>
          </dl>
          <pre>{JSON.stringify(receiptDetail.payload, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}

export interface AuditOperationsListProps {
  readonly audits: readonly AuditArtifact[];
  readonly api?: GeoApi;
  readonly canExport?: boolean;
}

export function AuditOperationsList({ audits, api, canExport = false }: AuditOperationsListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    audits.find((audit) => audit.status === "failed")?.id ?? audits[0]?.id ?? null,
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "failed" | "passed">("all");
  const [exportState, setExportState] = useState<WriteState>("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const orderedAudits = useMemo(
    () =>
      [...audits].sort(
        (left, right) =>
          Number(right.status === "failed") - Number(left.status === "failed") ||
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      ),
    [audits],
  );
  const visibleAudits = useMemo(
    () =>
      statusFilter === "all"
        ? orderedAudits
        : orderedAudits.filter((audit) => audit.status === statusFilter),
    [orderedAudits, statusFilter],
  );
  useEffect(() => {
    if (!visibleAudits.some((audit) => audit.id === selectedId)) {
      setSelectedId(visibleAudits[0]?.id ?? null);
    }
  }, [selectedId, visibleAudits]);
  useEffect(() => {
    setExportState("idle");
    setExportError(null);
  }, [selectedId]);
  const selected = useMemo(
    () => audits.find((audit) => audit.id === selectedId) ?? null,
    [audits, selectedId],
  );
  const selectedAuditIsCurrent =
    selected !== null &&
    selected.status === "passed" &&
    Number.isFinite(Date.parse(selected.expiresAt)) &&
    Date.parse(selected.expiresAt) > Date.now();

  async function exportSelectedAudit(): Promise<void> {
    if (api === undefined || selected === null || !selectedAuditIsCurrent) return;
    setExportState("working");
    setExportError(null);
    try {
      const publicationPackage = await api.exportManualPublicationPackage(selected.id);
      if (publicationPackage.auditArtifactId !== selected.id) {
        throw new Error("导出包与所选审计不匹配");
      }
      downloadManualPublicationPackage(publicationPackage);
      setExportState("done");
    } catch (requestError) {
      setExportState("error");
      setExportError(apiError(requestError));
    }
  }
  if (audits.length === 0) {
    return (
      <div className="ops-placeholder execution-console-audit">
        <FileSearch size={21} />
        <strong>尚无审计运行</strong>
        <span>从内容工作台对平台变体发起确定性审计</span>
      </div>
    );
  }
  return (
    <div className="execution-console-audit">
      <div className="ops-audit-toolbar">
        <div>
          <strong>审计运行</strong>
          <span>{audits.length} 条不可变记录</span>
        </div>
        <div className="segmented-control" aria-label="审计状态筛选">
          <button
            type="button"
            className={statusFilter === "all" ? "active" : ""}
            onClick={() => setStatusFilter("all")}
          >
            全部 {audits.length}
          </button>
          <button
            type="button"
            className={statusFilter === "failed" ? "active" : ""}
            onClick={() => setStatusFilter("failed")}
          >
            未通过 {audits.filter((audit) => audit.status === "failed").length}
          </button>
          <button
            type="button"
            className={statusFilter === "passed" ? "active" : ""}
            onClick={() => setStatusFilter("passed")}
          >
            已通过 {audits.filter((audit) => audit.status === "passed").length}
          </button>
        </div>
      </div>
      <div className="ops-audit-browser">
        <div className="ops-audit-index">
          <div className="ops-list-head" aria-hidden="true">
            <span>状态 / 平台</span>
            <span>时间</span>
          </div>
          {visibleAudits.length === 0 ? (
            <span className="ops-empty">当前筛选没有审计记录</span>
          ) : (
            visibleAudits.map((audit) => (
              <button
                key={audit.id}
                className={selectedId === audit.id ? "selected" : ""}
                onClick={() => setSelectedId(audit.id)}
              >
                <span
                  className={`ops-state-chip ${audit.status === "passed" ? "success" : "danger"}`}
                >
                  {operationStatusLabel(audit.status)}
                </span>
                <div>
                  <strong>{platformName(audit.platform)}</strong>
                  <span>{formatDate(audit.createdAt)}</span>
                </div>
                <ChevronRight size={15} />
              </button>
            ))
          )}
        </div>
        {selected === null ? null : (
          <div className="ops-audit-detail">
            <div className="ops-version-meta">
              <div>
                <span>审计产物</span>
                <strong className="mono">{shortHash(selected.id)}</strong>
              </div>
              <div>
                <span>载荷哈希</span>
                <strong className="mono">{shortHash(selected.payloadHash)}</strong>
              </div>
              <div>
                <span>审计哈希</span>
                <strong className="mono">{shortHash(selected.auditHash)}</strong>
              </div>
              <div>
                <span>规则版本</span>
                <strong>{selected.policyVersion}</strong>
              </div>
            </div>
            {canExport && selected.status === "passed" ? (
              <div className="ops-audit-export">
                {selectedAuditIsCurrent && api !== undefined ? (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void exportSelectedAudit()}
                    disabled={exportState === "working"}
                    title="导出人工发布包"
                  >
                    {exportState === "working" ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Download size={15} />
                    )}
                    导出人工发布包
                  </button>
                ) : (
                  <OperationNotice tone="warning">审计已过期，不能导出人工发布包。</OperationNotice>
                )}
                {exportState === "done" ? (
                  <OperationNotice>人工发布包已导出 · 仍需人工操作 · 未发布</OperationNotice>
                ) : null}
                <InlineError value={exportError} />
              </div>
            ) : null}
            <div className="ops-finding-list">
              {selected.findings.length === 0 ? (
                <OperationNotice>审计通过，没有阻断或警告。</OperationNotice>
              ) : (
                selected.findings.map((finding) => (
                  <div key={`${finding.ruleId}:${finding.path ?? "root"}`}>
                    <AlertTriangle size={16} />
                    <div>
                      <strong>{auditRuleLabel(finding.ruleId)}</strong>
                      <span>{auditRuleMessage(finding.ruleId, finding.message)}</span>
                      <small>原始详情：{finding.message}</small>
                      <small className="mono">
                        {finding.ruleId} · {finding.path ?? "载荷"}
                      </small>
                    </div>
                    <span
                      className={`ops-state-chip ${
                        finding.severity === "blocking"
                          ? "danger"
                          : finding.severity === "warning"
                            ? "warning"
                            : finding.severity === "info"
                              ? "info"
                              : ""
                      }`}
                    >
                      {auditSeverityLabel(finding.severity)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
