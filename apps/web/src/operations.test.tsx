import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATES,
  DEFAULT_ARTICLE_TEMPLATE_ID,
} from "@geo/contracts";

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
  type ManualMediaReview,
  type PendingManualMediaReview,
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
  planCtripMediaImportRoles,
  PublicationJobDetail,
} from "./operations.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Ctrip media import planning", () => {
  it("automatically assigns one cover and fills the remaining batch with inline images", () => {
    expect(planCtripMediaImportRoles([], 5)).toEqual([
      "cover",
      "inline",
      "inline",
      "inline",
      "inline",
    ]);
    expect(planCtripMediaImportRoles(["cover", "inline"], 3)).toEqual([
      "inline",
      "inline",
      "inline",
    ]);
  });

  it("rejects batches outside the five-image automation boundary", () => {
    expect(() => planCtripMediaImportRoles([], 6)).toThrow(/five-image/iu);
    expect(() => planCtripMediaImportRoles(["cover", "inline", "inline", "inline"], 2)).toThrow(
      /five-image/iu,
    );
    expect(() => planCtripMediaImportRoles(["cover", "cover"], 1)).toThrow(/cover/iu);
  });
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
  displayName: "示例旅服头条号",
  capability: "manual_only",
  supportedExecutionLevels: ["dry_run"],
  evidenceType: "manual_verification",
  evidenceRefs: [],
  status: "active",
  lastVerifiedAt: null,
};

const ctripAssistedAccount: ChannelAccount = {
  ...account,
  id: "10000000-0000-4000-8000-000000000703",
  platform: "ctrip_community",
  displayName: "示例旅服-携程社区-本地演示",
  capability: "browser_assisted",
  supportedExecutionLevels: ["dry_run", "assisted"],
  evidenceType: "preview",
  evidenceRefs: ["customer-demo:ctrip-simulator-v1"],
};

const sohuAccount: ChannelAccount = {
  ...account,
  id: "10000000-0000-4000-8000-000000000702",
  platform: "sohu",
  displayName: "示例旅服搜狐运营号",
};

const sohuAssistedAccount: ChannelAccount = {
  ...sohuAccount,
  capability: "browser_assisted",
  supportedExecutionLevels: ["dry_run", "assisted"],
  evidenceType: "browser_screenshot",
  evidenceRefs: ["adapter:sohu-browser-publication-v1"],
};

const zhihuAssistedAccount: ChannelAccount = {
  ...account,
  id: "10000000-0000-4000-8000-000000000704",
  platform: "zhihu",
  displayName: "示例旅服知乎专栏",
  capability: "browser_assisted",
  supportedExecutionLevels: ["dry_run", "assisted"],
  evidenceType: "browser_screenshot",
  evidenceRefs: ["adapter:zhihu-browser-publication-v1"],
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
  latestActivityAt: null,
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

const ctripAssistedVariant: PublicationVariant = {
  ...currentVariant,
  id: "10000000-0000-4000-8000-000000000623",
  channelAccountId: ctripAssistedAccount.id,
};

const sohuAssistedVariant: PublicationVariant = {
  ...currentVariant,
  id: "10000000-0000-4000-8000-000000000624",
  channelAccountId: sohuAssistedAccount.id,
  platform: "sohu",
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
    getAgentCapability: async () => ({
      available: false,
      mode: "disabled",
      provider: null,
      model: null,
      reason: "tenant_not_configured",
    }),
    runAgent: async () => {
      throw new Error("agent run is not configured in this test");
    },
    getContent: async () => [content],
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
    listManualMediaReviews: async () => [],
    listRecentManualMediaReviews: async () => [],
    mediaAssetFileUrl: (assetId: string) => `/api/media-assets/${encodeURIComponent(assetId)}/file`,
    recordManualMediaReviewDecision: async (
      contentVersionId: string,
      input: Parameters<GeoApi["recordManualMediaReviewDecision"]>[1],
    ): Promise<ManualMediaReview> => ({
      id: `${contentVersionId}-review`,
      contentVersionId,
      status: input.status,
      mediaSnapshotHash: "a".repeat(64),
      actions: input.status === "confirmed" ? [] : [...(input.actions ?? [])],
      reason: input.reason ?? null,
      decidedByActorId: "10000000-0000-4000-8000-000000000001",
      decidedAt: new Date().toISOString(),
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
  canonicalName: "sample-travel",
  displayName: "示例国际旅行服务",
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
  title: "示例旅服联系方式",
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
  claim: "24 小时热线为 4000000001",
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
  value: "4000000001",
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
  automationRemediationEnabled: true,
};

const readyResources = {
  brands: "ready",
  evidence: "ready",
  facts: "ready",
  campaigns: "ready",
  content: "ready",
  accounts: "ready",
  policies: "ready",
  templates: "ready",
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
    expect(screen.getByRole("list", { name: "作业执行时间线" })).toBeInTheDocument();
    expect(screen.getByText("平台执行")).toBeInTheDocument();
    fireEvent.click(cancel);

    expect(cancelPublicationJob).toHaveBeenCalledWith(
      queuedJob.id,
      "运营人员取消了排队中的演练作业",
    );
    expect(await screen.findByText("已取消", { selector: ".ops-state-chip" })).toBeInTheDocument();
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
    expect(await screen.findByText("尝试 #1")).toBeInTheDocument();

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
    expect(screen.queryByText("尝试 #1")).not.toBeInTheDocument();
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
    expect(await screen.findByText("已取消", { selector: ".ops-state-chip" })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "回执 1" }));
    expect(screen.getByText("未确认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /预览未确认/ }));
    expect(await screen.findByText("未确认（演练预览）")).toBeInTheDocument();
    expect(screen.queryByText("已确认")).not.toBeInTheDocument();
  });

  it("shows the original public URL only after a confirmed platform receipt", async () => {
    const publicUrl = "https://baijiahao.baidu.com/s?id=1234567890";
    const confirmedReceipt: PublicationReceipt = {
      id: "10000000-0000-4000-8000-000000001302",
      jobId: queuedJob.id,
      attemptId: "10000000-0000-4000-8000-000000001202",
      platform: "baijiahao",
      executionLevel: "unattended",
      evidenceType: "platform_readback",
      requestHash: "9".repeat(64),
      responseHash: "a".repeat(64),
      externalId: "1234567890",
      externalUrl: publicUrl,
      publishedAt: "2026-07-14T08:00:01.000Z",
      confirmed: true,
      payload: { mode: "browser" },
      recordedAt: "2026-07-14T08:00:02.000Z",
    };
    const api = {
      getPublicationJob: async () => ({ ...queuedJob, state: "confirmed" as const }),
      getPublicationAttempts: async () => [],
      getPublicationReceipts: async () => [confirmedReceipt],
      getPublicationReadbacks: async () => [],
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

    expect(await screen.findByText("原始公开 URL")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: publicUrl })).toHaveAttribute("href", publicUrl);
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

  it("creates one current-version variant for the explicitly selected account", async () => {
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
        accounts={[account, sohuAccount]}
        capabilities={["content:write", "audit:run"]}
      />,
    );

    const createButton = await screen.findByRole("button", { name: "生成该账号变体" });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("目标平台账号"), {
      target: { value: account.id },
    });
    fireEvent.click(createButton);
    await waitFor(() => expect(createContentVariant).toHaveBeenCalledTimes(1));
    expect(createContentVariant.mock.calls[0]?.[1]).toMatchObject({
      contentVersionId: currentVersion.id,
      channelAccountId: account.id,
    });
  });

  it("supersedes an unused draft only after collecting an operator reason", async () => {
    const supersedeContentVariant = vi.fn<GeoApi["supersedeContentVariant"]>(async (variantId) => ({
      ...currentVariant,
      id: variantId,
      state: "superseded",
      frozenAt: "2026-07-25T08:00:00.000Z",
    }));
    const api = articleApi({ supersedeContentVariant });

    render(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["content:write", "audit:run"]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "停用草稿" }));
    const confirm = screen.getByRole("button", { name: "确认停用" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`停用 ${account.displayName} 草稿的原因`), {
      target: { value: "当前账号不再使用这版内容" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(supersedeContentVariant).toHaveBeenCalledTimes(1));
    expect(supersedeContentVariant).toHaveBeenCalledWith(
      currentVariant.id,
      "当前账号不再使用这版内容",
    );
    expect(await screen.findByText("待生成变体 · 已停用 1")).toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "提交排期演练" })).toBeEnabled();

    view.rerender(
      <ArticleOperations
        api={api}
        content={content}
        accounts={[account]}
        capabilities={["audit:run", "publish:request", "grant:revoke"]}
      />,
    );

    expect(screen.getByRole("button", { name: "保存为新版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成该账号变体" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /审计 头条号/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交排期演练" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销授权" })).toBeDisabled();
  });

  it("submits the Ctrip account through the assisted publication path", async () => {
    const requestPublication = vi.fn<GeoApi["requestPublication"]>(async () => ({
      publicationJobId: queuedJob.id,
      publicationOutboxEventId: "10000000-0000-4000-8000-000000001105",
      wasCreated: true,
    }));
    const api = articleApi({
      getContentVariants: async () => [ctripAssistedVariant],
      requestPublication,
    });

    render(
      <MemoryRouter>
        <ArticleOperations
          api={api}
          content={content}
          accounts={[ctripAssistedAccount]}
          capabilities={["content:write", "audit:run", "publish:request"]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审计 携程社区" }));
    fireEvent.click(await screen.findByRole("button", { name: "提交携程社区辅助发布" }));

    await waitFor(() => expect(requestPublication).toHaveBeenCalledTimes(1));
    expect(requestPublication.mock.calls[0]?.[0]).toMatchObject({
      executionLevel: "assisted",
    });
    expect(await screen.findByText("携程社区辅助作业已创建")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unattended|无人值守/i })).not.toBeInTheDocument();
  });

  it("submits a priority-platform browser account as assisted without unattended", async () => {
    const requestPublication = vi.fn<GeoApi["requestPublication"]>(async () => ({
      publicationJobId: queuedJob.id,
      publicationOutboxEventId: "10000000-0000-4000-8000-000000001106",
      wasCreated: true,
    }));
    const api = articleApi({
      getContentVariants: async () => [sohuAssistedVariant],
      requestPublication,
    });

    render(
      <MemoryRouter>
        <ArticleOperations
          api={api}
          content={content}
          accounts={[sohuAssistedAccount]}
          capabilities={["content:write", "audit:run", "publish:request"]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "审计 搜狐号" }));
    fireEvent.click(await screen.findByRole("button", { name: "提交搜狐号辅助发布" }));

    await waitFor(() => expect(requestPublication).toHaveBeenCalledTimes(1));
    expect(requestPublication.mock.calls[0]?.[0]).toMatchObject({
      executionLevel: "assisted",
    });
    expect(await screen.findByText("搜狐号辅助作业已创建")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unattended|无人值守/i })).not.toBeInTheDocument();
  });

  it("shows Pi-authored search intents and imports audited licensed images with one action", async () => {
    const mediaSearchPlan = [
      {
        query: "京都 金阁寺 Kinkakuji",
        role: "cover" as const,
        rationale: "封面对应京都主题",
        claimIds: [fact.id],
      },
      {
        query: "京都 伏见稻荷 Fushimi Inari",
        role: "inline" as const,
        rationale: "正文景点段落",
        claimIds: [fact.id],
      },
      {
        query: "京都 岚山 Arashiyama",
        role: "inline" as const,
        rationale: "正文路线段落",
        claimIds: [fact.id],
      },
      {
        query: "京都 锦市场 Nishiki Market",
        role: "inline" as const,
        rationale: "正文餐饮段落",
        claimIds: [fact.id],
      },
      {
        query: "京都 鸭川 Kamo River",
        role: "inline" as const,
        rationale: "正文漫步段落",
        claimIds: [fact.id],
      },
    ];
    const searchVersion: ContentVersion = {
      ...currentVersion,
      payload: {
        ...currentVersion.payload,
        mediaSearchPlan,
        media: [{ id: "toutiao-cover", platform: "toutiao", role: "cover" }],
      },
    };
    const finalVersion: ContentVersion = {
      ...searchVersion,
      id: "10000000-0000-4000-8000-000000000699",
      version: 7,
      payload: {
        ...searchVersion.payload,
        media: mediaSearchPlan.map((intent, index) => ({
          id: `media-${index}`,
          platform: "ctrip_community",
          role: intent.role,
        })),
      },
    };
    const getContentVersion = vi
      .fn<GeoApi["getContentVersion"]>()
      .mockResolvedValueOnce(searchVersion)
      .mockResolvedValueOnce(finalVersion);
    const searchAndImportMedia = vi.fn<GeoApi["searchAndImportMedia"]>(async () => ({
      provider: "wikimedia_commons",
      sourceContentVersionId: searchVersion.id,
      finalContentVersionId: finalVersion.id,
      plannedCount: 5,
      initialMediaCount: 0,
      totalMediaCount: 5,
      complete: true,
      manualReviewRequired: false,
      imported: mediaSearchPlan.map((intent, intentIndex) => ({
        intentIndex,
        query: intent.query,
        role: intent.role,
        providerAssetId: `commons-${intentIndex}`,
        sourceUrl: `https://commons.wikimedia.org/wiki/File:${intentIndex}.jpg`,
        assetId: `asset-${intentIndex}`,
        contentVersionId: finalVersion.id,
      })),
      rejectedCandidateCount: 3,
      rejectionCodes: ["MEDIA_QUERY_RELEVANCE_FAILED"],
    }));

    render(
      <MemoryRouter>
        <ArticleOperations
          api={articleApi({ getContentVersion, searchAndImportMedia })}
          content={content}
          accounts={[ctripAssistedAccount]}
          capabilities={["content:write"]}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("京都 金阁寺 Kinkakuji")).toBeInTheDocument();
    expect(screen.getByText("封面对应京都主题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "按文章关键词自动配图" }));

    await waitFor(() => expect(searchAndImportMedia).toHaveBeenCalledTimes(1));
    expect(searchAndImportMedia.mock.calls[0]?.[0]).toBe(searchVersion.id);
    expect(searchAndImportMedia.mock.calls[0]?.[1]).toMatchObject({
      platform: "ctrip_community",
    });
    expect(
      await screen.findByText(/已按 5 组文章关键词绑定 5 张不同图片到 v7/u),
    ).toBeInTheDocument();
    expect(screen.getAllByText("已通过")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "按文章关键词自动配图" })).toBeDisabled();
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
        accounts={[account, zhihuAssistedAccount]}
        contacts={[contact]}
        policies={[policy]}
        templates={ARTICLE_TEMPLATES}
        catalogVersion={ARTICLE_TEMPLATE_CATALOG_VERSION}
        resources={readyResources}
      />,
    );
  }

  const pendingReview: PendingManualMediaReview = {
    contentItemId: content.id,
    contentVersionId: currentVersion.id,
    title: payload.title,
    summary: payload.summary,
    contentType: content.contentType,
    topicKey: content.topicKey,
    version: currentVersion.version,
    payloadHash: currentVersion.payloadHash,
    media: [
      {
        id: "10000000-0000-4000-8000-000000000700",
        mimeType: "image/jpeg",
        width: 1200,
        height: 800,
        altText: "日本长者旅行主图",
        caption: "日本长者旅行服务配图",
      },
    ],
    reviewStatus: "pending",
  };

  it("shows pending manual media reviews with real images and confirms one version", async () => {
    const mediaAssetId = String(pendingReview.media[0]?.id ?? "");
    const recordDecision = vi.fn<GeoApi["recordManualMediaReviewDecision"]>(async () => ({
      id: `${pendingReview.contentVersionId}-review`,
      contentVersionId: pendingReview.contentVersionId,
      status: "confirmed",
      mediaSnapshotHash: "a".repeat(64),
      actions: [],
      reason: null,
      decidedByActorId: "10000000-0000-4000-8000-000000000001",
      decidedAt: new Date().toISOString(),
    }));
    renderWorkspace(
      ["content:write"],
      articleApi({
        listManualMediaReviews: async () => [pendingReview],
        recordManualMediaReviewDecision: recordDecision,
      }),
    );

    expect(await screen.findByText("待人工确认")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "日本长者旅行主图" })).toHaveAttribute(
      "src",
      `/api/media-assets/${encodeURIComponent(mediaAssetId)}/file`,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认放行" }));

    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(pendingReview.contentVersionId, {
        status: "confirmed",
      }),
    );
    await waitFor(() => expect(screen.queryByText("待人工确认")).not.toBeInTheDocument());
    expect(screen.getByText(/已确认放行：/)).toBeInTheDocument();
  });

  it("supports single or multi-select rework actions and writes the reason trail", async () => {
    const recordDecision = vi.fn<GeoApi["recordManualMediaReviewDecision"]>(async () => ({
      id: `${pendingReview.contentVersionId}-review`,
      contentVersionId: pendingReview.contentVersionId,
      status: "rejected",
      mediaSnapshotHash: "a".repeat(64),
      actions: ["regenerate_media", "revise_article"],
      reason: "封面表达不准确，需要重新生成",
      decidedByActorId: "10000000-0000-4000-8000-000000000001",
      decidedAt: new Date().toISOString(),
    }));
    renderWorkspace(
      ["content:write"],
      articleApi({
        listManualMediaReviews: async () => [pendingReview],
        recordManualMediaReviewDecision: recordDecision,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "打回重做" }));
    const dialog = await screen.findByRole("dialog", { name: /打回重做/ });
    fireEvent.click(screen.getByRole("checkbox", { name: /自动重新生成配图/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /改稿/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回理由" }), {
      target: { value: "封面表达不准确，需要重新生成" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));

    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(pendingReview.contentVersionId, {
        status: "rejected",
        actions: ["regenerate_media", "revise_article"],
        reason: "封面表达不准确，需要重新生成",
      }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("待人工确认")).not.toBeInTheDocument());
    expect(await screen.findByText(/已打回：/)).toBeInTheDocument();
  });

  it("keeps recent manual review history visible after the pending queue is empty", async () => {
    renderWorkspace(
      ["content:write"],
      articleApi({
        listRecentManualMediaReviews: async () => [
          {
            contentItemId: content.id,
            contentVersionId: currentVersion.id,
            title: payload.title,
            contentType: content.contentType,
            topicKey: content.topicKey,
            version: currentVersion.version,
            reviewStatus: "confirmed",
            decidedAt: "2026-08-05T08:00:00.000Z",
            reworkActions: [],
            reason: null,
          },
        ],
      }),
    );

    expect(await screen.findByText("当前没有待人工确认的配图版本")).toBeInTheDocument();
    expect(screen.getByText("最近处理")).toBeInTheDocument();
    expect(screen.getByText("已放行")).toBeInTheDocument();
  });

  it("selects the first article when live content arrives after the initial render", async () => {
    const props = {
      api: articleApi(),
      tenantId: "tenant-a",
      capabilities: ["content:write"],
      brands: [brand],
      evidenceSources: [evidence],
      facts: [fact],
      campaigns: [campaign],
      accounts: [account],
      contacts: [contact],
      policies: [policy],
      templates: ARTICLE_TEMPLATES,
      catalogVersion: ARTICLE_TEMPLATE_CATALOG_VERSION,
      resources: readyResources,
    } as const;
    const view = render(<OperationsWorkspace {...props} contentItems={[]} />);
    expect(view.container.querySelector(".ops-media-import")).toBeNull();

    view.rerender(<OperationsWorkspace {...props} contentItems={[content]} />);

    await waitFor(() => expect(view.container.querySelector(".ops-media-import")).not.toBeNull());
  });

  it("filters the dense article index without changing the selected article detail", async () => {
    const publishedContent: ContentItem = {
      ...content,
      id: "10000000-0000-4000-8000-000000000602",
      title: "北海道亲子线路复盘",
      topicKey: "hokkaido-family-review",
      state: "published",
    };
    render(
      <OperationsWorkspace
        api={articleApi()}
        tenantId="tenant-a"
        capabilities={["content:write"]}
        brands={[brand]}
        evidenceSources={[evidence]}
        facts={[fact]}
        campaigns={[campaign]}
        contentItems={[content, publishedContent]}
        accounts={[account]}
        contacts={[contact]}
        policies={[policy]}
        templates={ARTICLE_TEMPLATES}
        catalogVersion={ARTICLE_TEMPLATE_CATALOG_VERSION}
        resources={readyResources}
      />,
    );

    expect(
      screen.getByRole("button", { name: `打开运营链：${content.title}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `打开运营链：${publishedContent.title}` }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文章" }), {
      target: { value: "北海道" },
    });
    expect(
      screen.queryByRole("button", { name: `打开运营链：${content.title}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `打开运营链：${publishedContent.title}` }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: content.title })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文章" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "草稿 1" }));
    expect(
      screen.queryByRole("button", { name: `打开运营链：${publishedContent.title}` }),
    ).not.toBeInTheDocument();
  });

  it("imports governed media without selecting a supporting fact", async () => {
    const sourceVersion: ContentVersion = {
      ...currentVersion,
      payload: {
        ...currentVersion.payload,
        claims: [
          {
            id: fact.id,
            text: fact.claim,
            evidenceSourceIds: fact.evidenceSourceIds,
            validUntil: fact.validUntil,
          },
        ],
      },
    };
    const importedVersion: ContentVersion = {
      ...sourceVersion,
      id: "10000000-0000-4000-8000-000000000613",
      version: 3,
    };
    const importMedia = vi.fn<GeoApi["importMedia"]>(async () => ({
      job: {
        id: "10000000-0000-4000-8000-000000000614",
        state: "succeeded",
        providerId: "tenant-upload",
        providerMode: "live",
      },
      asset: {
        id: "10000000-0000-4000-8000-000000000615",
        contentVersionId: importedVersion.id,
        storageKey: "tenant/media/image.png",
        reference: {},
      },
      wasCreated: true,
      contentInspectionRequired: true,
    }));
    const getContentVersion = vi.fn<GeoApi["getContentVersion"]>(async (versionId) =>
      versionId === importedVersion.id ? importedVersion : sourceVersion,
    );
    renderWorkspace(["content:write"], articleApi({ importMedia, getContentVersion }));

    const fileInput = await screen.findByLabelText("图片文件");
    expect(screen.getByRole("checkbox", { name: fact.claim })).not.toBeChecked();
    const image = new File([new Uint8Array([137, 80, 78, 71])], "image.png", {
      type: "image/png",
    });
    Object.defineProperty(image, "arrayBuffer", {
      value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    });
    fireEvent.change(fileInput, { target: { files: [image] } });
    fireEvent.change(screen.getByLabelText("所有权声明"), {
      target: { value: "本机构原创图片" },
    });
    fireEvent.submit(fileInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      const alert = screen.queryByRole("alert");
      if (alert !== null) throw new Error(alert.textContent ?? "media import failed");
      expect(importMedia).toHaveBeenCalledTimes(1);
    });
    expect(importMedia.mock.calls[0]?.[1].claimIds).toEqual([]);
  });

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
    expect(input?.payload.bodyMarkdown).toContain("24小时热线: 4000000001");
  });

  it("runs the tenant-scoped Pi workflow and refreshes the generated content", async () => {
    const runAgent = vi.fn<GeoApi["runAgent"]>(async () => ({
      capability: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
      result: {
        providerMode: "fixture",
        contentItemId: content.id,
        contentVersionId: currentVersion.id,
        variantId: currentVariant.id,
        auditRunId: "10000000-0000-4000-8000-000000000801",
        auditArtifactId: "10000000-0000-4000-8000-000000000802",
        publicationRequestId: "10000000-0000-4000-8000-000000000803",
        publicationJobId: queuedJob.id,
        outboxEventId: "10000000-0000-4000-8000-000000000804",
        steps: [
          "geo_tenant_context",
          "geo_template_catalog",
          "geo_brand_profile",
          "geo_fact_lookup",
          "geo_draft_proposal",
          "geo_variant_preview",
          "geo_audit_request",
          "geo_publication_request",
        ],
      },
    }));
    const getContent = vi.fn<GeoApi["getContent"]>(async () => [content]);
    renderWorkspace(
      ["content:write"],
      articleApi({
        getAgentCapability: async () => ({
          available: true,
          mode: "fixture",
          provider: "fixture",
          model: "fixture-geo-writer-v1",
        }),
        runAgent,
        getContent,
      }),
    );

    expect(await screen.findByText("fixture · fixture-geo-writer-v1")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Agent 主题与内容目标" }), {
      target: { value: "面向上海家庭客群核验日本线路服务边界" },
    });
    fireEvent.click(screen.getByRole("button", { name: "实时生成文章" }));

    await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      brandId: brand.id,
      campaignId: campaign.id,
      channelAccountId: account.id,
      platform: "toutiao",
      topic: "面向上海家庭客群核验日本线路服务边界",
      articleTemplateId: DEFAULT_ARTICLE_TEMPLATE_ID,
      idempotencyKey: expect.stringMatching(/^web-agent:/u),
    });
    expect(await screen.findByText("文章与演练作业已生成")).toBeInTheDocument();
    expect(screen.getByText(/geo_template_catalog.*geo_audit_request/u)).toBeInTheDocument();
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("keeps an active assisted Zhihu account selectable for governed generation", async () => {
    renderWorkspace(["content:write"]);

    await screen.findByRole("combobox", { name: "Agent 平台账号" });
    expect(screen.getAllByRole("option", { name: "知乎 · 示例旅服知乎专栏" })).not.toHaveLength(0);
  });

  it("submits the exact customer-selected template and governed profile", async () => {
    const createContent = vi.fn<GeoApi["createContent"]>(async () => content);
    renderWorkspace(["content:write"], articleApi({ createContent }));

    fireEvent.click(screen.getByRole("button", { name: "新建文章 + v1" }));
    fireEvent.click(screen.getByRole("button", { name: "行程决策" }));
    const comparisonTemplate = screen
      .getAllByRole("option", { name: /方案对比矩阵/u })
      .find((element) => element.tagName === "BUTTON");
    if (comparisonTemplate === undefined) throw new Error("comparison template button missing");
    fireEvent.click(comparisonTemplate);
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

    expect(screen.getByText("阻断")).toHaveClass("danger");
    expect(screen.queryByRole("button", { name: "导出人工发布包" })).not.toBeInTheDocument();
  });

  it("prioritizes failed audits and keeps status filtering explicit", () => {
    const passed = createAuditResult().artifact;
    const failed: AuditArtifact = {
      ...passed,
      id: "10000000-0000-4000-8000-000000000902",
      platform: "sohu",
      status: "failed",
      createdAt: new Date(Date.parse(passed.createdAt) - 60_000).toISOString(),
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
    const view = render(<AuditOperationsList audits={[passed, failed]} api={articleApi()} />);
    const auditRows = view.container.querySelectorAll(".ops-audit-index > button");

    expect(auditRows[0]).toHaveTextContent("未通过");
    expect(screen.getByText("缺少可核验事实")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已通过 1" }));
    expect(view.container.querySelectorAll(".ops-audit-index > button")).toHaveLength(1);
    expect(view.container.querySelector(".ops-audit-index > button")).toHaveTextContent("通过");
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
