import {
  AlertTriangle,
  Ban,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
  Eye,
  FilePlus2,
  FileSearch,
  LoaderCircle,
  Plus,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  type ManualPublicationPackage,
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
  DEFAULT_ARTICLE_TEMPLATE_ID,
  type ArticleTemplate,
  type GovernedEditorialProfile,
} from "@geo/contracts";

type WriteState = "idle" | "working" | "done" | "error";

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
      ctrip_community: "携程社区",
    }[platform] ?? platform
  );
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
            ? "当前会话缺少 content:write"
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
            ? "当前会话缺少 content:write"
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
          <span>事实必须绑定证据源；verified 需要租户管理权限</span>
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
      setError("Campaign, verified fact, or active policy is outside the current scope");
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
            ? "当前会话缺少 content:write"
            : templates.length === 0
              ? "文章模板目录尚未就绪"
              : enabled
                ? undefined
                : "先创建 Campaign，并至少登记一条可引用事实"
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
          <span>事实、证据和联系方式会固化进 payload，后续改动创建新版本</span>
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
          Campaign
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
                {fact.normalizedKey} · {fact.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          治理画像
          <output>{selectedTemplate?.editorialProfile.replaceAll("_", " ") ?? "—"}</output>
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
      ["toutiao", "sohu", "ctrip_community"].includes(account.platform),
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
        platform: selectedAccount.platform as "toutiao" | "sohu" | "ctrip_community",
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
            Campaign
            <select
              aria-label="Agent Campaign"
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
          <span>固定输出：平台最终变体 · 确定性审计 · Dry-run</span>
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
                ? "文章与 Dry-run 已生成"
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setVersion(null);
    setVariants([]);
    setAuditState({});
    setAuditRequestKeys({});
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

  async function generateVariants() {
    if (!canWrite || version === null || !isCanonicalVersion) return;
    const existingAccounts = new Set(currentVariants.map((variant) => variant.channelAccountId));
    const missing = eligibleAccounts.filter((account) => !existingAccounts.has(account.id));
    setGenerating(true);
    setError(null);
    try {
      const created = await Promise.all(
        missing.map((account) =>
          api.createContentVariant(content.id, {
            contentVersionId: version.id,
            channelAccountId: account.id,
          }),
        ),
      );
      setVariants((current) => mergeById(current, created));
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setGenerating(false);
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
            {content.topicKey} · {content.contentType}
          </small>
        </div>
        <span className="ops-state-chip">{content.state}</span>
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
                <span>Payload hash</span>
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
              <button
                className="button-primary"
                type="button"
                onClick={() => void generateVariants()}
                disabled={
                  !canWrite ||
                  generating ||
                  !isCanonicalVersion ||
                  eligibleAccounts.length === 0 ||
                  eligibleAccounts.every((account) =>
                    currentVariants.some((variant) => variant.channelAccountId === account.id),
                  )
                }
                title={
                  isCanonicalVersion
                    ? undefined
                    : "当前历史版本没有规范引用，不能生成可审计平台变体"
                }
              >
                {generating ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                生成缺失平台变体
              </button>
            </div>
          </form>

          <div className="ops-platform-boundary">
            <ShieldAlert size={17} />
            <span>
              仅列出 manual_only + dry_run，或携程 browser_assisted + assisted 的账号；不提供
              unattended，客户演示不会写入真实外部平台。
            </span>
          </div>
          <div className="ops-variant-list">
            {eligibleAccounts.map((account) => {
              const executionLevel = demoExecutionLevel(account);
              if (executionLevel === null) return null;
              const variant = currentVariants.find((item) => item.channelAccountId === account.id);
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
                    <span>{account.capability}</span>
                    <span>{executionLevel}</span>
                    <span>未发生真实外部发布</span>
                  </div>
                  {variant === undefined ? (
                    <span className="muted">待生成变体</span>
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
                    </>
                  )}
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
                          {state.result.artifact.findings.length} 项发现 · policy{" "}
                          {state.result.artifact.policyVersion}
                        </span>
                      </div>
                      {authorization === null || authorization === undefined ? (
                        <OperationNotice tone="warning">
                          未签发投放授权；请修正 blocking 项或权限条件，再使用上方按钮重新审计。
                        </OperationNotice>
                      ) : state.revoked ? (
                        <OperationNotice tone="warning">
                          PublicationGrant 已撤销；请使用上方按钮重新审计获取新授权。
                        </OperationNotice>
                      ) : state.grantUnavailable ? (
                        <OperationNotice tone="warning">
                          PublicationGrant 已失效、撤销或使用；请重新审计后再排期。
                        </OperationNotice>
                      ) : authorizationExpired ? (
                        <OperationNotice tone="warning">
                          PublicationGrant 已过期或执行窗口不足；请重新审计获取新授权。
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
                            {executionLevel === "assisted" ? "提交携程模拟" : "提交排期 Dry-run"}
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
                                ? "携程模拟作业已创建"
                                : "Dry-run 作业已创建"}
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
  const canWrite = capabilities.includes("content:write");
  const canVerify = capabilities.includes("tenant:manage");

  useEffect(() => {
    setBrands(incomingBrands);
    setEvidence(incomingEvidence);
    setFacts(incomingFacts);
    setCampaigns(incomingCampaigns);
    setContent(incomingContent);
    setSelectedContentId(incomingContent[0]?.id ?? null);
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
  useEffect(() => setContent((current) => mergeById(current, incomingContent)), [incomingContent]);

  const selectedContent = content.find((item) => item.id === selectedContentId) ?? null;
  const readyStages = [
    evidence.length > 0,
    facts.length > 0,
    campaigns.length > 0 && content.length > 0,
    selectedContent !== null,
  ];
  const resourceFailure = Object.values(resources).some((status) => status === "error");

  return (
    <div className="ops-workspace">
      <section className="ops-flow-band" aria-label="GEO 运营链">
        <div>
          <span>受治理运营链</span>
          <strong>证据 → 事实 → 文章版本 → 三平台变体 → 审计 → 排期 Dry-run</strong>
        </div>
        <ol>
          {["证据", "事实", "文章", "变体", "审计与 Dry-run"].map((label, index) => (
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
        头条号、搜狐号使用 manual_only + dry_run；客户演示中的携程社区使用 browser_assisted +
        assisted 内部模拟。所有路径均先审计，不提供 unattended。
      </OperationNotice>

      {!canWrite ? (
        <OperationNotice tone="warning">
          当前会话缺少 content:write；工作台保留只读状态，所有写入按钮已禁用。
        </OperationNotice>
      ) : null}
      {resourceFailure ? (
        <OperationNotice tone="danger">
          部分运营接口读取失败；依赖该数据的步骤保持禁用，不会以演示数据补位。
        </OperationNotice>
      ) : null}

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
                          {source.type} · {formatDate(source.capturedAt)}
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
                        {fact.status}
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
            <span>02 · Campaign 与文章</span>
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
            没有可用 Campaign。请先用页面右上角“新建 Campaign”建立计划。
          </OperationNotice>
        ) : null}
        <div className="ops-content-layout">
          <div className="ops-content-index" aria-label="文章列表">
            {content.length === 0 ? (
              <span className="ops-empty">尚无文章；创建操作会同时生成 v1</span>
            ) : (
              content.map((item) => (
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
                      {item.contentType} · {item.topicKey}
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
  const [reason, setReason] = useState("operator cancelled queued Dry-run");
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
    setLoading(true);
    void (async () => {
      try {
        const nextJob = await api.getPublicationJob(jobId);
        if (!active || activeScope.current !== scopeKey) return;
        setLoadedJob(nextJob);
        setLoadedScope(scopeKey);
        setLoading(false);
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
        ["Attempts", attemptResult],
        ["Receipts", receiptResult],
        ["Readbacks", readbackResult],
      ];
      const failures = auxiliaryResults.flatMap(([label, result]) =>
        result.status === "rejected" ? [`${label}: ${apiError(result.reason)}`] : [],
      );
      if (failures.length > 0) {
        setError(`附属作业证据读取失败（主作业仍可操作）：${failures.join("；")}`);
      }
    })();
    return () => {
      active = false;
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
        <span>attempt、receipt 与 readback 不会在列表中被折叠成一个“成功”状态</span>
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
  return (
    <section className="panel ops-job-detail">
      <div className="ops-section-heading">
        <div>
          <span>作业详情 · {platformName(job.platform)}</span>
          <h2 className="mono">{job.id}</h2>
        </div>
        <span className={`ops-state-chip ${job.state === "cancelled" ? "danger" : ""}`}>
          {job.state}
        </span>
      </div>
      <div className="ops-job-boundary">
        <ShieldAlert size={17} />
        <strong>dry_run</strong>
        <span>manual_only · 未发生外部发布</span>
      </div>
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
          <dt>Payload hash</dt>
          <dd className="mono">{shortHash(job.payloadHash)}</dd>
        </div>
        <div>
          <dt>Grant</dt>
          <dd className="mono">{shortHash(job.grantId)}</dd>
        </div>
        <div>
          <dt>最近错误</dt>
          <dd>{job.lastErrorCode ?? "无"}</dd>
        </div>
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
      <InlineError value={error} />
      <div className="segmented-control ops-detail-tabs" aria-label="作业证据视图">
        <button className={tab === "attempts" ? "active" : ""} onClick={() => setTab("attempts")}>
          Attempts {attempts.length}
        </button>
        <button className={tab === "receipts" ? "active" : ""} onClick={() => setTab("receipts")}>
          Receipts {receipts.length}
        </button>
        <button className={tab === "readbacks" ? "active" : ""} onClick={() => setTab("readbacks")}>
          Readbacks {readbacks.length}
        </button>
      </div>
      <div className="ops-detail-list">
        {tab === "attempts" &&
          attempts.map((attempt) => (
            <div key={attempt.id}>
              <div>
                <strong>Attempt #{attempt.attemptNo}</strong>
                <span>{attempt.state}</span>
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
                <strong>{receipt.evidenceType}</strong>
                <span>{isConfirmedReceipt(receipt) ? "已确认" : "未确认"}</span>
              </div>
              <code>{shortHash(receipt.responseHash)}</code>
              <span>{formatDate(receipt.recordedAt)}</span>
              <Eye size={15} />
            </button>
          ))}
        {tab === "readbacks" &&
          readbacks.map((readback) => (
            <div key={readback.id}>
              <div>
                <strong>{readback.status}</strong>
                <span>{readback.required ? "必须回读" : "不要求外部回读"}</span>
              </div>
              <span>{readback.reason ?? "未记录原因"}</span>
              <span>{formatDate(readback.scheduledFor)}</span>
              <small>{readback.lastError ?? "无错误"}</small>
            </div>
          ))}
        {(tab === "attempts" && attempts.length === 0) ||
        (tab === "receipts" && receipts.length === 0) ||
        (tab === "readbacks" && readbacks.length === 0) ? (
          <span className="ops-empty">当前视图没有持久记录</span>
        ) : null}
      </div>
      {receiptDetail === null ? null : (
        <div className="ops-receipt-detail">
          <div>
            <strong>Receipt detail</strong>
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
              <dt>Evidence</dt>
              <dd>{receiptDetail.evidenceType}</dd>
            </div>
            <div>
              <dt>确认状态</dt>
              <dd>{isConfirmedReceipt(receiptDetail) ? "已确认" : "未确认（Dry-run preview）"}</dd>
            </div>
            <div>
              <dt>External URL</dt>
              <dd>{receiptDetail.externalUrl ?? "无（Dry-run）"}</dd>
            </div>
            <div>
              <dt>Request hash</dt>
              <dd className="mono">{shortHash(receiptDetail.requestHash)}</dd>
            </div>
            <div>
              <dt>Response hash</dt>
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
  const [selectedId, setSelectedId] = useState<string | null>(audits[0]?.id ?? null);
  const [exportState, setExportState] = useState<WriteState>("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId === null && audits[0] !== undefined) setSelectedId(audits[0].id);
  }, [audits, selectedId]);
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
      <div className="ops-placeholder">
        <FileSearch size={21} />
        <strong>尚无审计运行</strong>
        <span>从内容工作台对平台变体发起确定性审计</span>
      </div>
    );
  }
  return (
    <div className="ops-audit-browser">
      <div className="ops-audit-index">
        {audits.map((audit) => (
          <button
            key={audit.id}
            className={selectedId === audit.id ? "selected" : ""}
            onClick={() => setSelectedId(audit.id)}
          >
            <span className={`ops-state-chip ${audit.status === "passed" ? "success" : "danger"}`}>
              {audit.status}
            </span>
            <div>
              <strong>{platformName(audit.platform)}</strong>
              <span>{formatDate(audit.createdAt)}</span>
            </div>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
      {selected === null ? null : (
        <div className="ops-audit-detail">
          <div className="ops-version-meta">
            <div>
              <span>Artifact</span>
              <strong className="mono">{shortHash(selected.id)}</strong>
            </div>
            <div>
              <span>Payload</span>
              <strong className="mono">{shortHash(selected.payloadHash)}</strong>
            </div>
            <div>
              <span>Audit hash</span>
              <strong className="mono">{shortHash(selected.auditHash)}</strong>
            </div>
            <div>
              <span>Policy</span>
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
                    <strong>{finding.ruleId}</strong>
                    <span>{finding.message}</span>
                    <small>{finding.path ?? "payload"}</small>
                  </div>
                  <span
                    className={`ops-state-chip ${finding.severity === "blocking" ? "danger" : ""}`}
                  >
                    {finding.severity}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
