import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GeoApiError,
  type AuditArtifact,
  type AuditResult,
  type Brand,
  type Campaign,
  type ChannelAccount,
  type ClaimFact,
  type ContentItem,
  type ContentVersion,
  type CreateVariantInput,
  type EvidenceSource,
  type GeoApi,
  type PublicationAttempt,
  type PublicationJob,
  type PublicationPayload,
  type PublicationReceipt,
  type PublicationVariant,
  type PolicyBundle,
  type TenantContact,
} from "./api.js";
import {
  ArticleOperations,
  AuditOperationsList,
  OperationsWorkspace,
  PublicationJobDetail,
} from "./operations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const queuedJob: PublicationJob = {
  id: "10000000-0000-4000-8000-000000001101",
  grantId: "10000000-0000-4000-8000-000000001103",
  auditArtifactId: "10000000-0000-4000-8000-000000001104",
  variantId: "10000000-0000-4000-8000-000000001102",
  channelAccountId: "10000000-0000-4000-8000-000000000701",
  platform: "toutiao",
  executionLevel: "dry_run",
  state: "queued",
  payloadHash: "a".repeat(64),
  scheduledFor: "2026-07-14T08:00:00.000Z",
  availableAt: "2026-07-14T08:00:00.000Z",
  attemptCount: 0,
  lastErrorCode: null,
  createdAt: "2026-07-14T07:59:00.000Z",
  updatedAt: "2026-07-14T07:59:00.000Z",
};

const payload: PublicationPayload = {
  title: "日本长者旅行指南",
  summary: "当前版本摘要",
  bodyMarkdown: "当前版本正文",
  titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
  summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
  bodyBlocks: [{ type: "template", templateId: "generic.body.guidance.verified" }],
  tagTemplateIds: ["generic.tag.verified"],
  media: [],
  claims: [],
  contactIds: [],
  tags: ["japan-senior"],
};

const account: ChannelAccount = {
  id: "10000000-0000-4000-8000-000000000701",
  platform: "toutiao",
  displayName: "中通国旅头条号",
  capability: "manual_only",
  supportedExecutionLevels: ["dry_run"],
  evidenceType: "manual_verification",
  evidenceRefs: [],
  status: "active",
  lastVerifiedAt: null,
};

const currentVersionId = "10000000-0000-4000-8000-000000000612";

const content: ContentItem = {
  id: "10000000-0000-4000-8000-000000000601",
  campaignId: "10000000-0000-4000-8000-000000000501",
  brandId: "10000000-0000-4000-8000-000000000201",
  title: payload.title,
  contentType: "guide",
  state: "draft",
  topicKey: "japan-senior",
  latestVersion: 2,
  latestVersionId: currentVersionId,
};

const currentVersion: ContentVersion = {
  id: currentVersionId,
  contentItemId: content.id,
  version: 2,
  summary: payload.summary,
  bodyMarkdown: payload.bodyMarkdown,
  payload,
  payloadHash: "b".repeat(64),
  frozenAt: null,
};

const historicalVariant: PublicationVariant = {
  id: "10000000-0000-4000-8000-000000000621",
  contentVersionId: "10000000-0000-4000-8000-000000000611",
  channelAccountId: account.id,
  platform: account.platform,
  variantVersion: 1,
  payload: { ...payload, summary: "历史版本摘要" },
  payloadHash: "1".repeat(64),
  state: "frozen",
  frozenAt: "2026-07-13T08:00:00.000Z",
};

const currentVariant: PublicationVariant = {
  ...historicalVariant,
  id: "10000000-0000-4000-8000-000000000622",
  contentVersionId: currentVersion.id,
  variantVersion: 2,
  payload,
  payloadHash: "2".repeat(64),
  state: "draft",
  frozenAt: null,
};

function createAuditResult(grantId = "10000000-0000-4000-8000-000000000801"): AuditResult {
  return {
    artifact: {
      id: "10000000-0000-4000-8000-000000000901",
      tenantId: "10000000-0000-4000-8000-000000000001",
      variantId: currentVariant.id,
      channelAccountId: account.id,
      platform: account.platform,
      payloadHash: currentVariant.payloadHash,
      factSnapshotHash: "3".repeat(64),
      policyHash: "4".repeat(64),
      policyVersion: "v1",
      auditHash: "5".repeat(64),
      status: "passed",
      findings: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
    publicationAuthorization: {
      grantId,
      token: "publication-token-that-is-long-enough",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    wasCreated: true,
  };
}

function articleApi(overrides: Partial<GeoApi> = {}): GeoApi {
  return {
    getContentVersion: async () => currentVersion,
    getContentVariants: async () => [currentVariant],
    createContentVariant: async () => currentVariant,
    createContentVersion: async () => content,
    auditVariant: async () => createAuditResult(),
    requestPublication: async () => ({
      publicationJobId: queuedJob.id,
      publicationOutboxEventId: "10000000-0000-4000-8000-000000001105",
      wasCreated: true,
    }),
    revokePublicationGrant: async (grantId: string) => ({
      grantId,
      status: "revoked",
      revokedAt: new Date().toISOString(),
      wasChanged: true,
    }),
    ...overrides,
  } as unknown as GeoApi;
}

const brand: Brand = {
  id: content.brandId,
  canonicalName: "zhongtong-international-travel",
  displayName: "中通国际旅行社",
  aliases: [],
  description: null,
  industry: "travel",
  websiteUrl: null,
  isPrimary: true,
  createdAt: "2026-07-14T07:00:00.000Z",
  updatedAt: "2026-07-14T07:00:00.000Z",
};

const evidence: EvidenceSource = {
  id: "10000000-0000-4000-8000-000000000301",
  type: "manual",
  title: "中通国旅联系方式",
  sourceUrl: null,
  contentHash: "6".repeat(64),
  capturedAt: "2026-07-14T07:00:00.000Z",
  validUntil: null,
  metadata: {},
};

const fact: ClaimFact = {
  id: "10000000-0000-4000-8000-000000000401",
  brandId: brand.id,
  normalizedKey: "contact.hotline",
  claim: "24 小时热线为 4001133986",
  status: "verified",
  evidenceSourceIds: [evidence.id],
  validFrom: "2026-07-14T07:00:00.000Z",
  validUntil: null,
};

const contact: TenantContact = {
  id: "10000000-0000-4000-8000-000000000402",
  tenantId: "10000000-0000-4000-8000-000000000001",
  type: "phone",
  label: "24小时热线",
  value: "4001133986",
  isPrimary: true,
  validFrom: "2026-07-14T07:00:00.000Z",
  validUntil: null,
};

const governedSourceProfile = {
  titleTemplateId: "generic.title.verified-service",
  summaryTemplateId: "generic.summary.verified-sources",
  bodyTemplateIds: {
    opening: "generic.body.heading.verified",
    details: "generic.body.guidance.verified",
    action: "generic.body.heading.contact",
    closing: "generic.body.guidance.contact",
  },
  bodyOrder: [
    "profile_opening",
    "profile_details",
    "claims",
    "profile_action",
    "contacts",
    "profile_closing",
  ],
  claimPresentation: "bullet",
  contactPresentation: "paragraph",
  tagTemplateIds: ["generic.tag.verified"],
} as const;

const policy: PolicyBundle = {
  id: "10000000-0000-4000-8000-000000000501",
  version: "travel-v1",
  status: "active",
  policyHash: "f".repeat(64),
  document: {
    contentTemplates: {
      title: { "generic.title.verified-service": "当前服务信息核验指南" },
      summary: {
        "generic.summary.verified-sources": "以下内容只使用已验证事实和当前联系方式。",
      },
      body: {
        "generic.body.heading.verified": "## 当前可核验信息",
        "generic.body.guidance.verified": "以下事实来自当前有效证据。",
        "generic.body.heading.contact": "## 联系与下一步",
        "generic.body.guidance.contact": "咨询时请以最新书面材料为准。",
      },
      tag: { "generic.tag.verified": "服务核验" },
    },
    editorialProfiles: {
      guide: { source: governedSourceProfile },
      comparison: { source: governedSourceProfile },
    },
  },
  effectiveAt: "2026-07-13T00:00:00.000Z",
  retiredAt: null,
  createdAt: "2026-07-13T00:00:00.000Z",
};

const campaign: Campaign = {
  id: content.campaignId,
  brandId: brand.id,
  name: "日本长者旅行",
  objective: "提升可核验回答",
  industry: "travel",
  status: "active",
  topicKey: content.topicKey,
};

const readyResources = {
  brands: "ready",
  evidence: "ready",
  facts: "ready",
  campaigns: "ready",
  content: "ready",
  accounts: "ready",
  policies: "ready",
} as const;

describe("publication job detail", () => {
  it("allows an authorized operator to cancel a queued dry-run job", async () => {
    const cancelPublicationJob = vi.fn(async () => ({
      job: { ...queuedJob, state: "cancelled" },
      wasChanged: true,
    }));
    const api = {
      getPublicationJob: async () => queuedJob,
      getPublicationAttempts: async () => [],
      getPublicationReceipts: async () => [],
      getPublicationReadbacks: async () => [],
      cancelPublicationJob,
    } as unknown as GeoApi;

    render(
      <PublicationJobDetail
        api={api}
        tenantId="10000000-0000-4000-8000-000000000001"
        jobId={queuedJob.id}
        canCancel
        onCancelled={() => undefined}
      />,
    );

    const cancel = await screen.findByRole("button", { name: "取消作业" });
    fireEvent.click(cancel);

    expect(cancelPublicationJob).toHaveBeenCalledWith(
      queuedJob.id,
      "operator cancelled queued Dry-run",
    );
    expect(await screen.findByText("cancelled")).toBeInTheDocument();
  });

  it("clears the previous tenant snapshot and reloads even when the job id is unchanged", async () => {
    const attempt: PublicationAttempt = {
      id: "10000000-0000-4000-8000-000000001201",
      jobId: queuedJob.id,
      attemptNo: 1,
      state: "succeeded",
      requestHash: "7".repeat(64),
      responseHash: "8".repeat(64),
      errorCode: null,
      errorMessage: null,
      startedAt: "2026-07-14T08:00:00.000Z",
      finishedAt: "2026-07-14T08:00:01.000Z",
    };
    const getPublicationJob = vi
      .fn<GeoApi["getPublicationJob"]>()
      .mockResolvedValueOnce(queuedJob)
      .mockRejectedValueOnce(new GeoApiError(404, "RESOURCE_NOT_FOUND", "tenant B has no job"));
    const api = {
      getPublicationJob,
      getPublicationAttempts: async () => [attempt],
      getPublicationReceipts: async () => [],
      getPublicationReadbacks: async () => [],
    } as unknown as GeoApi;

    const view = render(
      <PublicationJobDetail
        api={api}
        tenantId="tenant-a"
        jobId={queuedJob.id}
        canCancel
        onCancelled={() => undefined}
      />,
    );
    expect(await screen.findByText("Attempt #1")).toBeInTheDocument();

    view.rerender(
      <PublicationJobDetail
        api={api}
        tenantId="tenant-b"
        jobId={queuedJob.id}
        canCancel
        onCancelled={() => undefined}
      />,
    );

    expect(await screen.findByText(/tenant B has no job/)).toBeInTheDocument();
    expect(screen.queryByText(queuedJob.id)).not.toBeInTheDocument();
    expect(screen.queryByText("Attempt #1")).not.toBeInTheDocument();
    expect(getPublicationJob).toHaveBeenCalledTimes(2);
  });

  it("keeps the main job and cancellation available when an auxiliary evidence request fails", async () => {
    const cancelPublicationJob = vi.fn(async () => ({
      job: { ...queuedJob, state: "cancelled" },
      wasChanged: true,
    }));
    const api = {
      getPublicationJob: async () => queuedJob,
      getPublicationAttempts: async () => {
        throw new GeoApiError(503, "ATTEMPTS_UNAVAILABLE", "attempt store unavailable");
      },
      getPublicationReceipts: async () => [],
      getPublicationReadbacks: async () => [],
      cancelPublicationJob,
    } as unknown as GeoApi;

    render(
      <PublicationJobDetail
        api={api}
        tenantId="tenant-a"
        jobId={queuedJob.id}
        canCancel
        onCancelled={() => undefined}
      />,
    );

    expect(await screen.findByText(/附属作业证据读取失败/)).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "取消作业" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(await screen.findByText("cancelled")).toBeInTheDocument();
  });

  it("never presents a dry-run preview receipt as confirmed", async () => {
    const previewReceipt: PublicationReceipt = {
      id: "10000000-0000-4000-8000-000000001301",
      jobId: queuedJob.id,
      attemptId: "10000000-0000-4000-8000-000000001201",
      platform: "toutiao",
      executionLevel: "dry_run",
      evidenceType: "preview",
      requestHash: "9".repeat(64),
      responseHash: "a".repeat(64),
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      confirmed: true,
      payload: { mode: "preview" },
      recordedAt: "2026-07-14T08:00:01.000Z",
    };
    const api = {
      getPublicationJob: async () => queuedJob,
      getPublicationAttempts: async () => [],
      getPublicationReceipts: async () => [previewReceipt],
      getPublicationReadbacks: async () => [],
      getReceipt: async () => previewReceipt,
    } as unknown as GeoApi;

    render(
      <PublicationJobDetail
        api={api}
        tenantId="tenant-a"
        jobId={queuedJob.id}
        canCancel={false}
        onCancelled={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Receipts 1" }));
    expect(screen.getByText("未确认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /preview未确认/ }));
    expect(await screen.findByText("未确认（Dry-run preview）")).toBeInTheDocument();
    expect(screen.queryByText("已确认")).not.toBeInTheDocument();
  });
});

describe("article operations", () => {
  it("selects only the current article version variant for audit", async () => {
    const auditVariant = vi.fn(async (...args: [string, string]) => {
      void args;
      return createAuditResult();
    });
    const api = articleApi({
      getContentVariants: async () => [historicalVariant, currentVariant],
      auditVariant,
    });

    render(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["content:write", "audit:run", "publish:request"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审计 头条号" }));
    await waitFor(() => expect(auditVariant).toHaveBeenCalledTimes(1));
    expect(auditVariant.mock.calls[0]?.[0]).toBe(currentVariant.id);
  });

  it("creates a current-version variant when only a historical variant exists", async () => {
    const createContentVariant = vi.fn(async (...args: [string, CreateVariantInput]) => {
      void args;
      return currentVariant;
    });
    const api = articleApi({
      getContentVariants: async () => [historicalVariant],
      createContentVariant,
    });

    render(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["content:write", "audit:run"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "生成缺失平台变体" }));
    await waitFor(() => expect(createContentVariant).toHaveBeenCalledTimes(1));
    expect(createContentVariant.mock.calls[0]?.[1]).toMatchObject({
      contentVersionId: currentVersion.id,
      channelAccountId: account.id,
    });
  });

  it("reuses an audit key after an unconfirmed failure and rotates it after success", async () => {
    const auditVariant = vi
      .fn<GeoApi["auditVariant"]>()
      .mockRejectedValueOnce(new GeoApiError(0, "NETWORK_ERROR", "response was not confirmed"))
      .mockResolvedValueOnce(createAuditResult())
      .mockResolvedValueOnce(createAuditResult("10000000-0000-4000-8000-000000000802"));
    const api = articleApi({ auditVariant });

    render(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["content:write", "audit:run", "publish:request"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审计 头条号" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试同一审计 头条号" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新审计 头条号" }));

    await waitFor(() => expect(auditVariant).toHaveBeenCalledTimes(3));
    const keys = auditVariant.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("requires content:write for version, variant, audit and scheduling controls", async () => {
    const api = articleApi();
    const view = render(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["content:write", "audit:run", "publish:request", "grant:revoke"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审计 头条号" }));
    expect(await screen.findByRole("button", { name: "提交排期 Dry-run" })).toBeEnabled();

    view.rerender(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["audit:run", "publish:request", "grant:revoke"]}
      />,
    );

    expect(screen.getByRole("button", { name: "保存为新版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成缺失平台变体" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /审计 头条号/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交排期 Dry-run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销授权" })).toBeDisabled();
  });
});

describe("operations workspace governance", () => {
  function renderWorkspace(capabilities: readonly string[], api = articleApi()) {
    return render(
      <OperationsWorkspace
        api={api}
        tenantId="tenant-a"
        capabilities={capabilities}
        brands={[brand]}
        evidenceSources={[evidence]}
        facts={[fact]}
        campaigns={[campaign]}
        contentItems={[content]}
        accounts={[account]}
        contacts={[contact]}
        policies={[policy]}
        resources={readyResources}
      />,
    );
  }

  it("disables evidence, fact and article creation without content:write", async () => {
    renderWorkspace(["audit:run", "publish:request"]);

    expect(screen.getByRole("button", { name: "录入证据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "登记事实" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建文章 + v1" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "审计 头条号" })).toBeDisabled();
  });

  it("creates article v1 only from active policy templates and verified references", async () => {
    const createContent = vi.fn<GeoApi["createContent"]>(async () => content);
    renderWorkspace(["content:write"], articleApi({ createContent }));

    fireEvent.click(screen.getByRole("button", { name: "新建文章 + v1" }));
    expect(screen.queryByRole("textbox", { name: "文章标题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Markdown 正文" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "主题键" }), {
      target: { value: "japan-verified-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成规范文章 v1" }));

    await waitFor(() => expect(createContent).toHaveBeenCalledTimes(1));
    const input = createContent.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      campaignId: campaign.id,
      brandId: brand.id,
      title: "当前服务信息核验指南",
      topicKey: "japan-verified-service",
      idempotencyKey: expect.any(String),
      payload: {
        editorialProfile: "guide",
        articleTemplateId: "step-by-step-guide",
        titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
        summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
        claims: [
          {
            id: fact.id,
            evidenceSourceIds: fact.evidenceSourceIds,
          },
        ],
        contactIds: [contact.id],
        tagTemplateIds: ["generic.tag.verified"],
        tags: ["服务核验"],
      },
    });
    expect(input?.payload.bodyBlocks).toEqual([
      { type: "template", templateId: "generic.body.heading.verified" },
      { type: "template", templateId: "generic.body.guidance.verified" },
      { type: "claim", claimId: fact.id, presentation: "bullet" },
      { type: "template", templateId: "generic.body.heading.contact" },
      { type: "contact", contactId: contact.id, presentation: "paragraph" },
      { type: "template", templateId: "generic.body.guidance.contact" },
    ]);
    expect(input?.payload.bodyMarkdown).toContain("24小时热线: 4001133986");
  });

  it("submits the exact customer-selected template and governed profile", async () => {
    const createContent = vi.fn<GeoApi["createContent"]>(async () => content);
    renderWorkspace(["content:write"], articleApi({ createContent }));

    fireEvent.click(screen.getByRole("button", { name: "新建文章 + v1" }));
    fireEvent.click(screen.getByRole("button", { name: "辅助决策" }));
    fireEvent.click(screen.getByRole("option", { name: /方案对比矩阵/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "主题键" }), {
      target: { value: "japan-plan-comparison" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成规范文章 v1" }));

    await waitFor(() => expect(createContent).toHaveBeenCalledTimes(1));
    expect(createContent.mock.calls[0]?.[0]).toMatchObject({
      contentType: "comparison",
      topicKey: "japan-plan-comparison",
      payload: {
        editorialProfile: "comparison",
        articleTemplateId: "comparison-matrix",
      },
    });
  });

  it("does not offer or accept ordinary free text as platform readback evidence", async () => {
    const createEvidenceSource = vi.fn(async () => evidence);
    renderWorkspace(["content:write"], articleApi({ createEvidenceSource }));

    fireEvent.click(screen.getByRole("button", { name: "录入证据" }));
    expect(screen.getByRole("option", { name: "网页 URL" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "平台回读" })).not.toBeInTheDocument();

    const type = screen.getByRole("combobox", { name: "证据类型" });
    const injectedOption = document.createElement("option");
    injectedOption.value = "platform_readback";
    injectedOption.textContent = "平台回读";
    type.append(injectedOption);
    fireEvent.change(type, { target: { value: "platform_readback" } });
    const form = type.closest("form");
    if (form === null) throw new Error("evidence form was not rendered");
    fireEvent.submit(form);

    expect(await screen.findByText(/普通文本证据不能登记为平台回读/)).toBeInTheDocument();
    expect(createEvidenceSource).not.toHaveBeenCalled();
  });

  it("renders blocking audit findings with the danger severity treatment", () => {
    const audit: AuditArtifact = {
      ...createAuditResult().artifact,
      status: "failed",
      findings: [
        {
          ruleId: "fact-evidence",
          ruleVersion: "1",
          severity: "blocking",
          message: "缺少可核验事实",
          path: "claims[0]",
          evidence: [],
        },
      ],
    };

    render(<AuditOperationsList audits={[audit]} canExport api={articleApi()} />);

    expect(screen.getByText("blocking")).toHaveClass("danger");
    expect(screen.queryByRole("button", { name: "导出人工发布包" })).not.toBeInTheDocument();
  });

  it("downloads a passed audit package while keeping the UI explicitly non-published", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const audit = createAuditResult().artifact;
    const exportManualPublicationPackage = vi.fn(async () => ({
      schemaVersion: "geo.manual-publication-package.v1" as const,
      evidenceType: "preview" as const,
      platform: audit.platform,
      tenantId: audit.tenantId,
      channelAccountId: audit.channelAccountId,
      variantId: audit.variantId,
      executionLevel: "dry_run" as const,
      auditArtifactId: audit.id,
      payloadHash: audit.payloadHash,
      auditHash: audit.auditHash,
      previewHash: "6".repeat(64),
      requiresManualAction: true as const,
      publicationStatus: "not_published" as const,
      confirmed: false as const,
      exportedAt: new Date().toISOString(),
      files: { "NOT_PUBLISHED.txt": "NOT PUBLISHED", "article.md": "Audited article" },
      packageHash: "7".repeat(64),
    }));

    render(
      <AuditOperationsList
        audits={[audit]}
        canExport
        api={articleApi({ exportManualPublicationPackage })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "导出人工发布包" }));

    await waitFor(() => expect(exportManualPublicationPackage).toHaveBeenCalledWith(audit.id));
    expect(await screen.findByText(/人工发布包已导出.*未发布/)).toBeInTheDocument();
  });
});
