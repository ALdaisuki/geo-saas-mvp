import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTICLE_TEMPLATE_CATALOG_VERSION, ARTICLE_TEMPLATES } from "@geo/contracts";

import {
  type AutomationSnapshot,
  type BrandAgentProfile,
  type ChannelAccount,
  type GeoApi,
  GeoApiError,
  type PublicationAssistedHandoff,
  type PublicationAssistedBridgeActionResult,
  type SessionSnapshot,
  type TenantView,
} from "./api.js";
import { App } from "./app.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const session: SessionSnapshot = {
  actor: {
    id: "10000000-0000-4000-8000-000000000101",
    displayName: "测试运营员",
    role: "owner",
    capabilities: [
      "tenant:read",
      "tenant:manage",
      "member:manage",
      "principal:manage",
      "content:read",
      "receipt:read",
      "visibility:read",
      "visibility:run",
      "automation:manage",
    ],
    enabledModules: ["trend_discovery", "ai_content", "priority_distribution", "agent_automation"],
  },
  tenant: {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "sample-travel",
    displayName: "示例国际旅行服务",
  },
  expiresAt: "2026-07-14T16:00:00.000Z",
};

function liveApi(): GeoApi {
  const brandId = "10000000-0000-4000-8000-000000000301";
  let brandAgentProfiles: BrandAgentProfile[] = [
    {
      id: "10000000-0000-4000-8000-000000000302",
      brandId,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、清晰、证据优先；先回答问题，再解释依据与边界",
        audiences: ["正在评估出境旅行服务并需要核验信息的潜在客户"],
        objectives: ["帮助读者理解已验证服务事实、适用范围与咨询下一步"],
        requiredPoints: ["区分已验证事实、适用条件和仍需确认的信息"],
        forbiddenClaims: ["无证据的保证、排名、独家资质、实时优惠或结果承诺"],
        callToAction: "请通过 4000000001 或官方微信核验具体服务范围与条件。",
        agentInstructions: "只使用当前租户的事实与证据；闭合正文后再审计，不得绕过发布边界。",
      },
      documentHash: "6".repeat(64),
      effectiveAt: "2026-07-14T08:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-14T08:00:00.000Z",
    },
  ];
  let automation: AutomationSnapshot = {
    control: {
      mode: "shadow",
      killSwitchEnabled: false,
      reason: "MVP starts in shadow mode",
      quota: { dailyPublications: 0, dryRunOnly: true },
      updatedAt: "2026-07-14T08:00:00.000Z",
    },
    controls: [
      {
        id: "10000000-0000-4000-8000-000000000801",
        scopeType: "account",
        scopeKey: "10000000-0000-4000-8000-000000000701",
        mode: "shadow",
        killSwitchEnabled: false,
        reason: null,
        quota: {},
        updatedAt: "2026-07-14T08:00:00.000Z",
      },
    ],
    circuits: [],
    queueDepth: 0,
    queueLimit: 100,
    queueSaturation: 0,
  };
  const publicationJob = {
    id: "10000000-0000-4000-8000-000000001101",
    grantId: "10000000-0000-4000-8000-000000001103",
    auditArtifactId: "10000000-0000-4000-8000-000000001104",
    variantId: "10000000-0000-4000-8000-000000001102",
    channelAccountId: "10000000-0000-4000-8000-000000000701",
    platform: "toutiao",
    executionLevel: "dry_run",
    state: "preview_completed",
    payloadHash: "a".repeat(64),
    scheduledFor: "2026-07-14T08:00:00.000Z",
    availableAt: "2026-07-14T08:00:00.000Z",
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:01:00.000Z",
  };
  const publicationReceipt = {
    id: "10000000-0000-4000-8000-000000001201",
    jobId: publicationJob.id,
    attemptId: "10000000-0000-4000-8000-000000001202",
    platform: "toutiao",
    executionLevel: "dry_run",
    evidenceType: "preview",
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    confirmed: false,
    payload: { readback: { required: false, reason: "dry_run_preview_only" } },
    recordedAt: "2026-07-14T08:01:00.000Z",
  };
  let assistedHandoff: PublicationAssistedHandoff = {
    id: "10000000-0000-4000-8000-000000001301",
    jobId: publicationJob.id,
    attemptId: publicationReceipt.attemptId,
    channelAccountId: publicationJob.channelAccountId,
    variantId: publicationJob.variantId,
    articleTitle: "青岛赴日跟团先比什么",
    platform: "ctrip_community",
    state: "handoff_pending",
    payloadHash: publicationJob.payloadHash,
    auditHash: "c".repeat(64),
    previewHash: "d".repeat(64),
    adapterVersion: "ctrip-community-web-v1",
    bridgeServicePrincipalId: "10000000-0000-4000-8000-000000001302",
    leaseOwnerActorId: session.actor.id,
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "1999-12-31T23:59:00.000Z",
    sessionEvidenceHash: null,
    draftEvidenceHash: null,
    prepareOutcome: null,
    prepareEvidenceKind: null,
    prepareEvidenceHash: null,
    prepareObservedAt: null,
    mediaManifestHash: null,
    submitEvidenceHash: null,
    submitPermitIssued: false,
    submitPermitExpiresAt: null,
    submitPermitConsumedAt: null,
    submitPermitIssuedByActorId: null,
    submitPermitConsumedByPrincipalId: null,
    submitOutcome: null,
    submitEvidenceKind: null,
    submitObservedAt: null,
    submitCandidateExternalId: null,
    submitCandidateExternalUrl: null,
    publicationReceiptId: null,
    publicationReadbackId: null,
    readbackOutcome: null,
    readbackEvidenceKind: null,
    readbackEvidenceHash: null,
    readbackObservedAt: null,
    observedPayloadHash: null,
    externalDraftId: null,
    externalId: null,
    externalUrl: null,
    expiresAt: "2026-07-14T08:30:00.000Z",
    cancellationReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
  };
  const visibilityRun = {
    id: "10000000-0000-4000-8000-000000001501",
    querySetVersionId: "10000000-0000-4000-8000-000000000902",
    provider: "doubao" as const,
    productSurface: "web-search",
    model: "doubao-search-v1",
    searchMode: "on" as const,
    observationMethod: "manual" as const,
    status: "completed" as const,
    locale: "zh-CN",
    geo: "CN",
    startedAt: "2026-07-14T08:00:00.000Z",
    completedAt: "2026-07-14T08:00:01.000Z",
    errorMessage: null,
    observationCount: 1,
    createdAt: "2026-07-14T08:00:00.000Z",
  };
  const visibilityDetail = {
    run: visibilityRun,
    observations: [
      {
        id: "10000000-0000-4000-8000-000000001502",
        tenantId: session.tenant.id,
        runId: visibilityRun.id,
        provider: "doubao" as const,
        productSurface: visibilityRun.productSurface,
        model: visibilityRun.model,
        searchMode: "on" as const,
        observationMethod: "manual" as const,
        prompt: "示例国际旅行服务电话是多少",
        promptVersion: "1",
        locale: "zh-CN",
        geo: "CN",
        rawAnswer: "示例国际旅行服务 24 小时热线为 4000000001。",
        citedUrls: ["https://example.test/sample-contact"],
        evidenceHash: "f".repeat(64),
        evidenceType: "manual_import",
        requestStartedAt: "2026-07-14T07:59:59.000Z",
        responseReceivedAt: "2026-07-14T08:00:00.000Z",
        observedAt: "2026-07-14T08:00:00.000Z",
        brandMentioned: true,
        answerPosition: 1,
        contactAccuracy: 1,
        competitorMentions: ["示例旅行社"],
        sentiment: "neutral" as const,
        hallucinationFindings: [],
        harmfulError: false,
        extractorVersion: "visibility-v1",
        evaluatorVersion: "geo-visibility-evaluator-v1",
        metadata: {},
        createdAt: "2026-07-14T08:00:01.000Z",
      },
    ],
    metrics: [
      {
        name: "contact_accuracy",
        value: 1,
        sampleCount: 1,
        confidenceLow: null,
        confidenceHigh: null,
        dimensions: { provider: "doubao" },
        createdAt: "2026-07-14T08:00:01.000Z",
      },
    ],
  };
  return {
    getSession: async () => session,
    login: async () => session,
    logout: async () => undefined,
    getRuntimeProviderConfiguration: async () => ({
      schemaVersion: "geo.runtime-provider-config.v1",
      sections: [],
      updatedAt: "2026-07-14T08:00:00.000Z",
    }),
    updateRuntimeProviderConfiguration: async (input: {
      readonly sections: readonly {
        readonly configKey: "agent_drafting" | "agent_media_inspection" | "media_search";
        readonly provider: string;
        readonly model: string;
        readonly baseUrl?: string | null;
        readonly api?: "openai-responses" | "openai-completions" | null;
        readonly completionsMode: "stream" | "json";
        readonly enabled: boolean;
        readonly apiKey?: string;
        readonly version: number;
        readonly settings?: Readonly<Record<string, unknown>>;
      }[];
      readonly reason?: string;
    }) => ({
      schemaVersion: "geo.runtime-provider-config.v1",
      sections: input.sections.map((section) => ({
        configKey: section.configKey,
        provider: section.provider,
        model: section.model,
        baseUrl: section.baseUrl ?? null,
        api: section.api ?? null,
        completionsMode: section.completionsMode,
        enabled: section.enabled,
        apiKeyMasked: null,
        apiKeySet: section.apiKey !== undefined,
        version: section.version,
        updatedBy: session.actor.id,
        updatedAt: "2026-07-14T08:00:00.000Z",
        settings: section.settings ?? {},
      })),
      updatedAt: "2026-07-14T08:00:00.000Z",
    }),
    fetchRuntimeProviderModelCatalog: async () => ["deepseek-v4-pro", "gpt-5.6-sol"],
    listManualMediaReviews: async () => [],
    listRecentManualMediaReviews: async () => [],
    recordManualMediaReviewDecision: async (
      contentVersionId: string,
      input: {
        readonly status: "confirmed" | "rejected";
        readonly reason?: string;
        readonly actions?: readonly ("regenerate_media" | "replace_media" | "revise_article")[];
      },
    ) => ({
      id: `${contentVersionId}-review`,
      contentVersionId,
      status: input.status,
      mediaSnapshotHash: "a".repeat(64),
      actions:
        input.status === "confirmed"
          ? []
          : ([...(input.actions ?? [])] as (
              "regenerate_media" | "replace_media" | "revise_article"
            )[]),
      reason: input.reason ?? null,
      decidedByActorId: session.actor.id,
      decidedAt: "2026-07-14T08:00:01.000Z",
    }),
    mediaAssetFileUrl: (assetId: string) => `/api/media-assets/${encodeURIComponent(assetId)}/file`,
    getTenants: async () => [
      {
        id: session.tenant.id,
        slug: session.tenant.slug,
        displayName: session.tenant.displayName,
        role: "owner",
        status: "active",
      },
    ],
    switchTenant: async () => session,
    getTenant: async () => ({
      id: session.tenant.id,
      slug: session.tenant.slug,
      displayName: session.tenant.displayName,
      legalName: session.tenant.displayName,
      industry: "travel",
      status: "active",
      defaultLocale: "zh-CN",
    }),
    getContacts: async () => [
      {
        id: "10000000-0000-4000-8000-000000000401",
        tenantId: session.tenant.id,
        type: "phone",
        label: "24小时热线",
        value: "4000000001",
        isPrimary: true,
        validFrom: "2026-07-13T00:00:00.000Z",
        validUntil: null,
      },
    ],
    createContact: async () => {
      throw new Error("not used by this App fixture");
    },
    expireContact: async () => {
      throw new Error("not used by this App fixture");
    },
    getChannelAccounts: async () => [
      {
        id: "10000000-0000-4000-8000-000000000701",
        platform: "toutiao",
        displayName: "示例旅服-头条号-Dry Run",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        evidenceType: "preview",
        evidenceRefs: ["seed:dry-run-only"],
        status: "active",
        lastVerifiedAt: null,
      },
    ],
    createChannelAccount: async () => {
      throw new Error("not used by this App fixture");
    },
    updateChannelAccount: async () => {
      throw new Error("not used by this App fixture");
    },
    getBrands: async () => [
      {
        id: brandId,
        canonicalName: "Example Travel Services",
        displayName: "示例国际旅行服务",
        aliases: [],
        description: null,
        industry: "travel",
        websiteUrl: null,
        isPrimary: true,
        createdAt: "2026-07-14T08:00:00.000Z",
        updatedAt: "2026-07-14T08:00:00.000Z",
      },
    ],
    getBrandAgentProfiles: async () => brandAgentProfiles,
    createBrandAgentProfile: async (requestedBrandId, input) => {
      if (requestedBrandId !== brandId) throw new Error("brand is outside the fixture tenant");
      const currentVersion = brandAgentProfiles[0]?.version ?? 0;
      const nextVersion = currentVersion + 1;
      const nextProfile: BrandAgentProfile = {
        id: `10000000-0000-4000-8000-${String(302 + nextVersion - 1).padStart(12, "0")}`,
        brandId,
        version: nextVersion,
        status: "active",
        document: input.document,
        documentHash: (nextVersion % 16).toString(16).repeat(64),
        effectiveAt: `2026-07-14T08:0${nextVersion}:00.000Z`,
        retiredAt: null,
        createdAt: `2026-07-14T08:0${nextVersion}:00.000Z`,
      };
      brandAgentProfiles = [nextProfile];
      return nextProfile;
    },
    getMembers: async () => [
      {
        id: "10000000-0000-4000-8000-000000000102",
        userId: session.actor.id,
        email: "owner@example.test",
        displayName: "Test Owner",
        role: "owner",
        capabilities: session.actor.capabilities,
        enabledModules: session.actor.enabledModules,
        status: "active",
        createdAt: "2026-07-14T08:00:00.000Z",
      },
    ],
    createMember: async () => {
      throw new Error("not used by this App fixture");
    },
    updateMember: async () => {
      throw new Error("not used by this App fixture");
    },
    updateMemberModules: async () => {
      throw new Error("not used by this App fixture");
    },
    getPolicies: async () => [
      {
        id: "10000000-0000-4000-8000-000000000801",
        version: "travel-v1",
        status: "active",
        policyHash: "c".repeat(64),
        document: { vertical: "travel" },
        effectiveAt: "2026-07-14T08:00:00.000Z",
        retiredAt: null,
        createdAt: "2026-07-14T08:00:00.000Z",
      },
    ],
    createPolicy: async () => {
      throw new Error("not used by this App fixture");
    },
    transitionPolicy: async () => {
      throw new Error("not used by this App fixture");
    },
    getServicePrincipals: async () => [],
    createAutomationServicePrincipal: async () => {
      throw new Error("not used by this App fixture");
    },
    createCtripBridgeServicePrincipal: async () => {
      throw new Error("not used by this App fixture");
    },
    setServicePrincipalStatus: async () => {
      throw new Error("not used by this App fixture");
    },
    getQuerySets: async () => [
      {
        id: "10000000-0000-4000-8000-000000000901",
        name: "Domestic AI discovery",
        industry: "travel",
        status: "active",
        currentVersion: 1,
        description: "Independent Doubao and Qwen prompts",
        currentVersionId: "10000000-0000-4000-8000-000000000902",
        prompts: [
          {
            key: "brand-phone",
            category: "contact",
            prompt: "示例国际旅行服务电话是多少",
          },
          {
            key: "generic-japan",
            category: "generic",
            prompt: "日本跟团游哪家靠谱",
          },
        ],
        promptHash: "d".repeat(64),
        createdAt: "2026-07-14T08:00:00.000Z",
        updatedAt: "2026-07-14T08:00:00.000Z",
      },
    ],
    createQuerySet: async () => {
      throw new Error("not used by this App fixture");
    },
    getQuerySetVersions: async () => [],
    createQuerySetVersion: async () => {
      throw new Error("not used by this App fixture");
    },
    activateQuerySetVersion: async () => {
      throw new Error("not used by this App fixture");
    },
    transitionQuerySet: async () => {
      throw new Error("not used by this App fixture");
    },
    getArticleTemplates: async () => ({
      version: ARTICLE_TEMPLATE_CATALOG_VERSION,
      items: ARTICLE_TEMPLATES,
    }),
    getSetupReadiness: async () => ({
      schemaVersion: "geo.customer-setup-readiness.v1",
      deploymentProfile: "customer_demo",
      governanceMode: "demo_fixture",
      articleGenerationReady: true,
      ctripSimulationReady: true,
      externalPublishingEnabled: false,
      checks: {
        agent: true,
        ctripAccount: true,
        assistedEvidence: true,
        bridgeIdentity: true,
        bridgeRuntime: true,
        prePublicationAudit: true,
      },
    }),
    getCtripBridgeStatus: async () => ({
      configured: false,
      reachable: false,
      mode: null,
      adapterVersion: null,
      commandCapabilities: null,
      operationalStatus: "unavailable",
      operationalCheckedAt: null,
    }),
    getAgentCapability: async () => ({
      available: false,
      mode: "disabled",
      provider: null,
      model: null,
      reason: "tenant_not_configured",
    }),
    runAgent: async () => {
      throw new Error("not used by this App fixture");
    },
    getEvidenceSources: async () => [],
    createEvidenceSource: async () => {
      throw new Error("not used by this App fixture");
    },
    getFacts: async () => [],
    createFact: async () => {
      throw new Error("not used by this App fixture");
    },
    getCampaigns: async () => [
      {
        id: "10000000-0000-4000-8000-000000001001",
        brandId: "10000000-0000-4000-8000-000000000301",
        name: "实时日本银发问答集",
        objective: "提高有证据的品牌命中",
        industry: "travel",
        status: "draft",
        topicKey: "japan-senior",
        automationRemediationEnabled: true,
      },
    ],
    createCampaign: async (input) => ({
      id: "10000000-0000-4000-8000-000000001002",
      ...input,
      status: "draft",
      automationRemediationEnabled: true,
    }),
    transitionCampaignState: async () => {
      throw new Error("not used by this App fixture");
    },
    setCampaignAutomationRemediation: async () => {
      throw new Error("not used by this App fixture");
    },
    setCampaignPromptTemplate: async () => {
      throw new Error("not used by this App fixture");
    },
    generateCampaignPromptTemplate: async () => {
      throw new Error("not used by this App fixture");
    },
    getContent: async () => [],
    createContent: async () => {
      throw new Error("not used by this App fixture");
    },
    createContentVersion: async () => {
      throw new Error("not used by this App fixture");
    },
    getContentVersion: async () => {
      throw new Error("not used by this App fixture");
    },
    importMedia: async () => {
      throw new Error("not used by this App fixture");
    },
    searchAndImportMedia: async () => {
      throw new Error("not used by this App fixture");
    },
    getContentVariants: async () => [],
    createContentVariant: async () => {
      throw new Error("not used by this App fixture");
    },
    supersedeContentVariant: async () => {
      throw new Error("not used by this App fixture");
    },
    auditVariant: async () => {
      throw new Error("not used by this App fixture");
    },
    getAudits: async () => [
      {
        id: "10000000-0000-4000-8000-000000001301",
        tenantId: session.tenant.id,
        variantId: publicationJob.variantId,
        channelAccountId: publicationJob.channelAccountId,
        platform: "toutiao",
        payloadHash: publicationJob.payloadHash,
        factSnapshotHash: "f".repeat(64),
        policyHash: "c".repeat(64),
        policyVersion: "travel-v1",
        auditHash: "e".repeat(64),
        status: "passed",
        findings: [],
        createdAt: "2026-07-14T07:59:00.000Z",
        expiresAt: "2026-07-14T08:14:00.000Z",
      },
    ],
    exportManualPublicationPackage: async () => {
      throw new Error("not used by this App fixture");
    },
    getPublicationJobs: async () => [publicationJob],
    getPublicationJob: async () => publicationJob,
    requestPublication: async () => ({
      publicationJobId: publicationJob.id,
      publicationOutboxEventId: "10000000-0000-4000-8000-000000001105",
      wasCreated: true,
    }),
    revokePublicationGrant: async (grantId) => ({
      grantId,
      status: "revoked",
      revokedAt: "2026-07-14T08:02:00.000Z",
      wasChanged: true,
    }),
    cancelPublicationJob: async () => ({
      job: { ...publicationJob, state: "cancelled" },
      wasChanged: true,
    }),
    getPublicationAttempts: async () => [],
    getPublicationReceipts: async () => [publicationReceipt],
    getPublicationReadbacks: async () => [],
    getPublicationAssistedHandoffs: async () => [assistedHandoff],
    getPublicationAssistedHandoff: async () => assistedHandoff,
    claimPublicationAssistedHandoff: async () => {
      assistedHandoff = {
        ...assistedHandoff,
        leaseOwnerActorId: session.actor.id,
        leaseExpiresAt: "2099-07-14T08:02:00.000Z",
        heartbeatAt: "2026-07-14T08:00:00.000Z",
      };
      return assistedHandoff;
    },
    heartbeatPublicationAssistedHandoff: async () => assistedHandoff,
    cancelPublicationAssistedHandoff: async (_handoffId, reason) => {
      assistedHandoff = {
        ...assistedHandoff,
        state: "cancelled",
        leaseOwnerActorId: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        cancellationReason: reason,
      };
      return { handoff: assistedHandoff, wasChanged: true };
    },
    preparePublicationAssistedHandoff: async () => {
      assistedHandoff = {
        ...assistedHandoff,
        state: "draft_prepared",
        draftEvidenceHash: "7".repeat(64),
        prepareOutcome: "prepared",
        prepareEvidenceKind: "simulation",
        prepareEvidenceHash: "8".repeat(64),
        prepareObservedAt: "2026-07-14T08:01:00.000Z",
        mediaManifestHash: "9".repeat(64),
        adapterVersion: "ctrip-community-simulator-v1",
      };
      return {
        handoff: assistedHandoff,
        bridge: {
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: session.tenant.id,
          handoffId: assistedHandoff.id,
          bridgePrincipalId: "10000000-0000-4000-8000-000000001302",
          command: "prepare",
          outcome: "prepared",
          evidenceKind: "simulation",
          state: "draft_prepared",
          adapterVersion: assistedHandoff.adapterVersion,
          observedAt: "2026-07-14T08:01:00.000Z",
          evidenceHash: "7".repeat(64),
        },
      };
    },
    submitPublicationAssistedHandoff: async () => {
      assistedHandoff = {
        ...assistedHandoff,
        state: "readback_pending",
        submitPermitIssued: true,
        submitPermitConsumedAt: "2026-07-14T08:02:00.000Z",
        submitOutcome: "accepted",
        submitEvidenceKind: "simulation",
        submitObservedAt: "2026-07-14T08:02:00.000Z",
        publicationReceiptId: "10000000-0000-4000-8000-000000001303",
        publicationReadbackId: "10000000-0000-4000-8000-000000001304",
      };
      return {
        handoff: assistedHandoff,
        bridge: {
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: session.tenant.id,
          handoffId: assistedHandoff.id,
          bridgePrincipalId: "10000000-0000-4000-8000-000000001302",
          command: "submit",
          outcome: "accepted",
          evidenceKind: "simulation",
          state: "readback_pending",
          receiptId: "10000000-0000-4000-8000-000000001303",
          readbackId: "10000000-0000-4000-8000-000000001304",
          adapterVersion: assistedHandoff.adapterVersion,
          observedAt: "2026-07-14T08:02:00.000Z",
          evidenceHash: "8".repeat(64),
        },
      };
    },
    readbackPublicationAssistedHandoff: async () => {
      assistedHandoff = {
        ...assistedHandoff,
        state: "needs_review",
        readbackOutcome: "simulation_only",
        readbackEvidenceKind: "simulation",
        readbackEvidenceHash: "9".repeat(64),
        readbackObservedAt: "2026-07-14T08:03:00.000Z",
        observedPayloadHash: assistedHandoff.payloadHash,
      };
      return {
        handoff: assistedHandoff,
        bridge: {
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: session.tenant.id,
          handoffId: assistedHandoff.id,
          bridgePrincipalId: "10000000-0000-4000-8000-000000001302",
          command: "readback",
          outcome: "simulation_only",
          evidenceKind: "simulation",
          state: "needs_review",
          externalId: null,
          externalUrl: null,
          adapterVersion: assistedHandoff.adapterVersion,
          observedAt: "2026-07-14T08:03:00.000Z",
          evidenceHash: "9".repeat(64),
        },
      };
    },
    reopenPublicationAssistedReadback: async () => {
      assistedHandoff = {
        ...assistedHandoff,
        state: "needs_review",
        readbackOutcome: "simulation_only",
        readbackEvidenceKind: "simulation",
        readbackEvidenceHash: "9".repeat(64),
        readbackObservedAt: "2026-07-14T08:03:00.000Z",
        observedPayloadHash: assistedHandoff.payloadHash,
      };
      return {
        handoff: assistedHandoff,
        bridge: {
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: session.tenant.id,
          handoffId: assistedHandoff.id,
          bridgePrincipalId: "10000000-0000-4000-8000-000000001302",
          command: "readback",
          outcome: "simulation_only",
          evidenceKind: "simulation",
          state: "needs_review",
          externalId: null,
          externalUrl: null,
          adapterVersion: assistedHandoff.adapterVersion,
          observedAt: "2026-07-14T08:03:00.000Z",
          evidenceHash: "9".repeat(64),
        },
      };
    },
    getReceipts: async () => [publicationReceipt],
    getReceipt: async () => publicationReceipt,
    getVisibilitySummary: async () => [
      {
        provider: "doubao",
        productSurface: "web-search",
        model: "doubao-search-v1",
        searchMode: "on",
        observationMethod: "manual",
        evidenceType: "manual_import",
        observations: 12,
        brandMentionRate: 0.5,
        contactAccuracy: 1,
        averageAnswerPosition: 1,
        competitorMentionRate: 0.5,
        negativeSentimentRate: 0,
        hallucinationFindings: 0,
        harmfulErrors: 0,
      },
    ],
    getVisibilityRuns: async () => [visibilityRun],
    getVisibilityRun: async () => visibilityDetail,
    runFixtureVisibility: async () => ({
      visibilityRunId: visibilityRun.id,
      status: "completed",
      providerMode: "fixture",
      evidenceType: "fixture",
      wasCreated: true,
    }),
    importVisibility: async () => ({
      visibilityRunId: visibilityRun.id,
      status: "completed",
      providerMode: "manual",
      evidenceType: "manual_import",
      wasCreated: true,
    }),
    createAutomationBatch: async () => {
      throw new Error("not used by this App fixture");
    },
    getCampaignAutomationPlan: async () => null,
    saveCampaignAutomationPlan: async () => {
      throw new Error("not used by this App fixture");
    },
    runCampaignAutomationPlan: async () => {
      throw new Error("not used by this App fixture");
    },
    getAutomationBatches: async () => [],
    getAutomationRuns: async () => [],
    getAutomationRun: async () => {
      throw new Error("not used by this App fixture");
    },
    reassignAutomationTarget: async () => {
      throw new Error("not used by this App fixture");
    },
    restartAutomationTargetRemediation: async () => {
      throw new Error("not used by this App fixture");
    },
    cancelAutomationBatch: async () => {
      throw new Error("not used by this App fixture");
    },
    getAutomation: async () => automation,
    setAutomationControl: async (input) => {
      automation = {
        ...automation,
        control: {
          ...automation.control,
          mode: input.mode,
          quota: input.quota,
          reason: input.reason,
          updatedAt: "2026-07-14T08:04:00.000Z",
        },
      };
      return automation.control;
    },
    setScopedAutomationControl: async (scopeType, scopeKey, input) => {
      const control = {
        id: "10000000-0000-4000-8000-000000000953",
        scopeType,
        scopeKey,
        mode: input.mode,
        quota: input.quota,
        killSwitchEnabled: input.killSwitchEnabled,
        reason: input.reason,
        updatedAt: "2026-07-14T08:04:00.000Z",
      };
      automation = {
        ...automation,
        controls: [
          ...automation.controls.filter(
            (item) => item.scopeType !== scopeType || item.scopeKey !== scopeKey,
          ),
          control,
        ],
      };
      return control;
    },
    setCircuitBreakerState: async (scopeType, scopeKey, input) => {
      const circuit = {
        id: "10000000-0000-4000-8000-000000000954",
        scopeType,
        scopeKey,
        state: input.targetState,
        failureCount: input.targetState === "open" ? 1 : 0,
        openedAt: input.targetState === "open" ? "2026-07-14T08:04:00.000Z" : null,
        retryAt: input.retryAt ?? null,
        reason: input.reason,
        updatedAt: "2026-07-14T08:04:00.000Z",
      };
      automation = { ...automation, circuits: [circuit] };
      return circuit;
    },
    setKillSwitch: async (input) => {
      automation = {
        ...automation,
        control: {
          ...automation.control,
          killSwitchEnabled: input.enabled,
          reason: input.reason,
          updatedAt: "2026-07-14T08:05:00.000Z",
        },
      };
      return automation.control;
    },
  };
}

function renderApp(
  options: {
    path?: string;
    api?: GeoApi;
    demo?: boolean;
    operationsPollIntervalMs?: number;
  } = {},
) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? "/overview"]}>
      <App
        {...(options.api === undefined ? {} : { api: options.api })}
        initialMode={options.demo === true ? "demo" : "live"}
        {...(options.operationsPollIntervalMs === undefined
          ? {}
          : { operationsPollIntervalMs: options.operationsPollIntervalMs })}
      />
    </MemoryRouter>,
  );
}

function liveApiWithModules(enabledModules: readonly string[]): GeoApi {
  const api = liveApi();
  api.getSession = async () => ({
    ...session,
    actor: { ...session.actor, enabledModules },
  });
  return api;
}

function runtimeProviderCard(name: string): HTMLElement {
  const card = screen.getByText(name).closest(".runtime-provider-config-card");
  if (card === null) throw new Error(`runtime provider card not found for ${name}`);
  return card as HTMLElement;
}

describe("GEO operator console", () => {
  it("routes a challenged publication handoff to the global banner and account quick verification", async () => {
    const api = liveApi();
    const accountId = "10000000-0000-4000-8000-000000000710";
    const authenticatedSohuAccount = {
      id: accountId,
      platform: "sohu",
      displayName: "搜狐测试账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["assisted", "unattended"],
      evidenceType: "platform_readback",
      evidenceRefs: ["sohu-browser-runtime"],
      status: "active",
      lastVerifiedAt: "2026-08-11T12:45:00.000Z",
      ctripRuntime: {
        id: "10000000-0000-4000-8000-000000000711",
        channelAccountId: accountId,
        sessionState: "authenticated",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000704",
        lastCheckedAt: "2026-08-11T12:45:00.000Z",
        lastReadyAt: "2026-08-11T12:45:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-11T12:45:00.000Z",
      },
    } as const satisfies ChannelAccount;
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("handoff fixture is required");
    const challengedHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      id: "10000000-0000-4000-8000-000000001311",
      channelAccountId: accountId,
      platform: "sohu",
      articleTitle: "搜狐发布验证金丝雀",
      state: "challenge_required",
      prepareOutcome: "challenge_required",
      lastErrorCode: "ASSISTED_CHALLENGE_REQUIRED",
      lastErrorMessage: "平台要求人工完成安全验证",
      expiresAt: "2026-08-12T12:45:00.000Z",
      updatedAt: "2026-08-11T12:45:00.000Z",
    };
    api.getChannelAccounts = async () => [authenticatedSohuAccount];
    api.getPublicationAssistedHandoffs = async () => [challengedHandoff];

    renderApp({ path: "/automation", api });

    const banner = await screen.findByRole("alert", { name: "平台账号需要人工验证" });
    expect(banner).toHaveTextContent("搜狐号");
    expect(banner).toHaveTextContent("搜狐测试账号");
    expect(banner).toHaveTextContent("投放暂缓");

    fireEvent.click(within(banner).getByRole("link", { name: "前往账号验证" }));
    expect(await screen.findByRole("heading", { name: "平台账号", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "快速验证 搜狐测试账号" })).toBeInTheDocument();
  });

  it("notifies operators about a platform challenge without pausing publication", async () => {
    const api = liveApi();
    const challengedAccount = {
      id: "10000000-0000-4000-8000-000000000702",
      platform: "baijiahao",
      displayName: "示例科技账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["assisted", "unattended"],
      evidenceType: "platform_readback",
      evidenceRefs: ["baijiahao-browser-runtime"],
      status: "active",
      lastVerifiedAt: "2026-08-07T01:00:00.000Z",
      ctripRuntime: {
        id: "10000000-0000-4000-8000-000000000703",
        channelAccountId: "10000000-0000-4000-8000-000000000702",
        sessionState: "challenge_required",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000704",
        lastCheckedAt: "2026-08-07T01:01:00.000Z",
        lastReadyAt: null,
        lastErrorCode: "BAIJIAHAO_SECURITY_CHALLENGE_REQUIRED",
        lastErrorMessage: "平台需要人工完成安全验证",
        updatedAt: "2026-08-07T01:01:00.000Z",
      },
    } as const satisfies ChannelAccount;
    api.getChannelAccounts = async () => [challengedAccount];

    renderApp({ path: "/automation", api });

    const banner = await screen.findByRole("status", { name: "平台账号出现安全验证" });
    expect(banner).toHaveTextContent("百家号");
    expect(banner).toHaveTextContent("示例科技账号");
    expect(banner).toHaveTextContent("系统会带挑战继续推进");
    expect(banner).toHaveTextContent("内容生产和发布不受影响");
    expect(banner).not.toHaveTextContent("投放暂缓");

    fireEvent.click(within(banner).getByRole("link", { name: "前往账号验证" }));
    expect(await screen.findByRole("heading", { name: "平台账号", level: 1 })).toBeInTheDocument();
  });

  it("does not show the operator verification banner for ready or placeholder accounts", async () => {
    const api = liveApi();
    const readyAccount = {
      id: "10000000-0000-4000-8000-000000000705",
      platform: "baijiahao",
      displayName: "示例科技账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["assisted", "unattended"],
      evidenceType: "platform_readback",
      evidenceRefs: ["baijiahao-browser-runtime"],
      status: "active",
      lastVerifiedAt: "2026-08-07T01:00:00.000Z",
      ctripRuntime: {
        id: "10000000-0000-4000-8000-000000000706",
        channelAccountId: "10000000-0000-4000-8000-000000000705",
        sessionState: "ready",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000704",
        lastCheckedAt: "2026-08-07T01:01:00.000Z",
        lastReadyAt: "2026-08-07T01:01:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-08-07T01:01:00.000Z",
      },
    } as const satisfies ChannelAccount;
    api.getChannelAccounts = async () => [
      readyAccount,
      {
        id: "10000000-0000-4000-8000-000000000707",
        platform: "toutiao",
        displayName: "占位头条号",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        evidenceType: "preview",
        evidenceRefs: ["seed:dry-run-only"],
        status: "active",
        lastVerifiedAt: null,
      },
    ];

    renderApp({ path: "/automation", api });

    await screen.findByRole("heading", { name: "自动化批次", level: 1 });
    expect(screen.queryByRole("alert", { name: "平台账号需要人工验证" })).not.toBeInTheDocument();
  });

  it("shows the operator banner when only analytics collection requires verification", async () => {
    const api = liveApi();
    const accountId = "10000000-0000-4000-8000-000000000708";
    api.getChannelAccounts = async () => [
      {
        id: accountId,
        platform: "baijiahao",
        displayName: "示例科技账号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["assisted", "unattended"],
        evidenceType: "platform_readback",
        evidenceRefs: ["baijiahao-browser-runtime"],
        status: "active",
        lastVerifiedAt: "2026-08-07T01:00:00.000Z",
        ctripRuntime: {
          id: "10000000-0000-4000-8000-000000000709",
          channelAccountId: accountId,
          sessionState: "ready",
          bridgePrincipalId: "10000000-0000-4000-8000-000000000704",
          lastCheckedAt: "2026-08-07T01:01:00.000Z",
          lastReadyAt: "2026-08-07T01:01:00.000Z",
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: "2026-08-07T01:01:00.000Z",
        },
      },
    ];
    api.getPriorityPlatformAccountAnalytics = async () => ({
      scope: "priority_platforms",
      accountCount: 1,
      reportingAccountCount: 0,
      totals: { publishCount: 0, impressions: 0, reads: 0, likes: 0, comments: 0 },
      accounts: [
        {
          channelAccountId: accountId,
          platform: "baijiahao",
          displayName: "示例科技账号",
          dataStatus: "pending",
          reportPeriod: null,
          publishCount: null,
          totalImpressions: null,
          totalReads: null,
          totalLikes: null,
          totalComments: null,
          works: [],
          observedAt: null,
          nextRefreshAt: "2026-08-07T02:01:00.000Z",
          lastAttemptedAt: "2026-08-07T01:01:00.000Z",
          lastSucceededAt: null,
          lastErrorCode: "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED",
          lastErrorMessage: "平台采集页需要人工验证",
        },
      ],
    });

    renderApp({ path: "/content", api });

    const banner = await screen.findByRole("alert", { name: "平台账号需要人工验证" });
    expect(banner).toHaveTextContent("营销数据采集待验证");
    expect(banner).toHaveTextContent("内容生产和发布不受影响");
    expect(banner).not.toHaveTextContent("投放待验证");
  });

  it("hides ungranted live modules from every operator entry point", async () => {
    renderApp({ api: liveApiWithModules(["ai_content"]) });

    await screen.findByRole("heading", { name: "运营概览", level: 1 });
    expect(screen.getByRole("link", { name: "内容资产" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "平台账号" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "投放中心" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "自动化批次" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "热点雷达" })).not.toBeInTheDocument();
    for (const baseline of ["运营概览", "客户与品牌", "AI 可见性", "审计与证据", "系统设置"]) {
      expect(screen.getByRole("link", { name: baseline })).toBeInTheDocument();
    }
  });

  it("does not fetch or subscribe to live module resources without a module grant", async () => {
    const api = liveApiWithModules([]);
    const getTrendCandidates = vi.fn(async () => []);
    const getContent = vi.fn(async () => []);
    const getChannelAccounts = vi.fn(async () => []);
    const getPublicationJobs = vi.fn(async () => []);
    const getReceipts = vi.fn(async () => []);
    const getAutomation = vi.fn(async () => ({
      control: {
        mode: "shadow" as const,
        killSwitchEnabled: false,
        reason: "not called",
        quota: {},
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
      controls: [],
      circuits: [],
      queueDepth: 0,
      queueLimit: 100,
      queueSaturation: 0,
    }));
    const subscribeOperationsEvents = vi.fn(() => ({ close: vi.fn() }));
    api.getTrendCandidates = getTrendCandidates;
    api.getContent = getContent;
    api.getChannelAccounts = getChannelAccounts;
    api.getPublicationJobs = getPublicationJobs;
    api.getReceipts = getReceipts;
    api.getAutomation = getAutomation;
    api.subscribeOperationsEvents = subscribeOperationsEvents;

    renderApp({ api });

    await screen.findByRole("heading", { name: "运营概览", level: 1 });
    expect(getTrendCandidates).not.toHaveBeenCalled();
    expect(getContent).not.toHaveBeenCalled();
    expect(getChannelAccounts).not.toHaveBeenCalled();
    expect(getPublicationJobs).not.toHaveBeenCalled();
    expect(getReceipts).not.toHaveBeenCalled();
    expect(getAutomation).not.toHaveBeenCalled();
    expect(subscribeOperationsEvents).not.toHaveBeenCalled();
  });

  it("subscribes to operation events when agent automation is the only granted module", async () => {
    const api = liveApiWithModules(["agent_automation"]);
    const subscribeOperationsEvents = vi.fn(() => ({ close: vi.fn() }));
    api.subscribeOperationsEvents = subscribeOperationsEvents;

    renderApp({ api });

    await screen.findByRole("heading", { name: "运营概览", level: 1 });
    await waitFor(() => expect(subscribeOperationsEvents).toHaveBeenCalledOnce());
  });

  it("hides module-owned controls from baseline settings without grants", async () => {
    const api = liveApiWithModules([]);
    const getSetupReadiness = vi.fn(api.getSetupReadiness);
    api.getSetupReadiness = getSetupReadiness;
    renderApp({ path: "/settings", api });

    await screen.findByRole("heading", { name: "系统设置", level: 1 });
    expect(screen.queryByRole("button", { name: "新建推广计划" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "平台账号与能力" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "自动化策略" })).not.toBeInTheDocument();
    expect(getSetupReadiness).not.toHaveBeenCalled();
    expect(screen.queryByText("账号授权证据")).not.toBeInTheDocument();
    expect(screen.queryByText("携程桥接服务")).not.toBeInTheDocument();
    expect(screen.queryByText(/外部发布尚未满足/)).not.toBeInTheDocument();
  });

  it("prefills the runtime provider panel with the persisted DeepSeek config", async () => {
    const api = liveApi();
    api.getRuntimeProviderConfiguration = async () => ({
      schemaVersion: "geo.runtime-provider-config.v1",
      sections: [
        {
          configKey: "agent_drafting",
          provider: "openai-compatible",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
          api: "openai-completions",
          completionsMode: "json",
          enabled: true,
          apiKeyMasked: "sk-***",
          apiKeySet: true,
          version: 3,
          updatedBy: session.actor.id,
          updatedAt: "2026-08-04T12:00:00.000Z",
          settings: { thinkingLevel: "low" },
        },
      ],
      updatedAt: "2026-08-04T12:00:00.000Z",
    });
    renderApp({ path: "/settings", api });

    await screen.findByRole("heading", { name: "系统设置", level: 1 });
    await screen.findByText("写文章 Agent");
    const card = runtimeProviderCard("写文章 Agent");
    expect(within(card).getByLabelText("Provider")).toHaveValue("openai-compatible");
    expect(within(card).getByLabelText("Model")).toHaveValue("deepseek-v4-pro");
    expect(within(card).getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com");
    expect(within(card).getByLabelText("API 模式")).toHaveValue("openai-completions");
    expect(within(card).getByLabelText("返回模式")).toHaveValue("json");
    expect(within(card).getByLabelText("推理级别")).toHaveValue("low");
    expect(within(card).getByLabelText("API Key")).toHaveValue("");
    expect(within(card).getByLabelText("API Key")).toHaveAttribute("placeholder", "保留当前密钥");
  });

  it("applies the current GPT drafting template to the runtime provider draft", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    await screen.findByRole("heading", { name: "系统设置", level: 1 });
    await screen.findByText("写文章 Agent");
    const card = runtimeProviderCard("写文章 Agent");
    fireEvent.change(within(card).getByLabelText("配置模板"), {
      target: { value: "builtin:current-gpt-drafting" },
    });

    expect(within(card).getByLabelText("Model")).toHaveValue("gpt-5.6-sol");
    expect(within(card).getByLabelText("Base URL")).toHaveValue("https://aiapi.syuan.org/v1");
    expect(within(card).getByLabelText("API 模式")).toHaveValue("openai-responses");
    expect(within(card).getByLabelText("返回模式")).toHaveValue("stream");
    expect(within(card).getByLabelText("推理级别")).toHaveValue("low");
  });

  it("persists manual media review with an inert provider identity", async () => {
    const api = liveApi();
    const update = vi.fn(api.updateRuntimeProviderConfiguration);
    api.updateRuntimeProviderConfiguration = update;
    renderApp({ path: "/settings", api });

    await screen.findByRole("heading", { name: "系统设置", level: 1 });
    await screen.findByText("图片审查 Vision");
    const card = runtimeProviderCard("图片审查 Vision");
    expect(within(card).getByLabelText("审查方式")).toHaveValue("manual");
    fireEvent.click(within(card).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      sections: [
        expect.objectContaining({
          configKey: "agent_media_inspection",
          provider: "manual-review-operator",
          model: "manual-review-queue-v1",
          api: null,
          baseUrl: null,
          settings: { reviewMode: "manual" },
        }),
      ],
    });
  });

  it("persists no Vision review as a default-pass inert provider", async () => {
    const api = liveApi();
    const update = vi.fn(api.updateRuntimeProviderConfiguration);
    api.updateRuntimeProviderConfiguration = update;
    renderApp({ path: "/settings", api });

    await screen.findByRole("heading", { name: "系统设置", level: 1 });
    await screen.findByText("图片审查 Vision");
    const card = runtimeProviderCard("图片审查 Vision");
    fireEvent.change(within(card).getByLabelText("审查方式"), {
      target: { value: "none" },
    });
    expect(within(card).queryByLabelText("Provider")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      sections: [
        expect.objectContaining({
          configKey: "agent_media_inspection",
          provider: "no-vision-pass-through",
          model: "no-vision-v1",
          api: null,
          baseUrl: null,
          settings: { reviewMode: "none" },
        }),
      ],
    });
  });

  it("applies newly granted modules after a session refresh without re-login", async () => {
    const api = liveApi();
    let currentSession = {
      ...session,
      actor: { ...session.actor, enabledModules: [] as readonly string[] },
    };
    api.getSession = vi.fn(async () => currentSession);
    renderApp({ api });

    await screen.findByRole("heading", { name: "运营概览", level: 1 });
    expect(screen.queryByRole("link", { name: "内容资产" })).not.toBeInTheDocument();

    currentSession = {
      ...currentSession,
      actor: { ...currentSession.actor, enabledModules: ["ai_content"] },
    };
    fireEvent.click(screen.getByRole("button", { name: "刷新实时数据" }));

    expect(await screen.findByRole("link", { name: "内容资产" })).toBeInTheDocument();
  });

  it("refreshes the authenticated session after a successful member module update", async () => {
    const api = liveApi();
    let currentSession = session;
    const getSession = vi.fn(async () => currentSession);
    const updateMemberModules = vi.fn<GeoApi["updateMemberModules"]>(async (memberId, input) => {
      currentSession = {
        ...currentSession,
        actor: { ...currentSession.actor, enabledModules: input.enabledModules },
      };
      return {
        id: memberId,
        userId: currentSession.actor.id,
        email: "owner@example.test",
        displayName: "Test Owner",
        role: "owner",
        capabilities: currentSession.actor.capabilities,
        enabledModules: input.enabledModules,
        status: "active",
        createdAt: "2026-07-14T08:00:00.000Z",
      };
    });
    api.getSession = getSession;
    api.updateMemberModules = updateMemberModules;
    renderApp({ path: "/customers", api });

    await screen.findByText("租户治理操作");
    fireEvent.click(await screen.findByRole("button", { name: "管理 Test Owner" }));
    fireEvent.click(screen.getByLabelText("AI 内容创作"));
    fireEvent.change(screen.getByLabelText("模块授权变更原因"), {
      target: { value: "Revoke AI content module after gray test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模块授权" }));

    await waitFor(() => expect(updateMemberModules).toHaveBeenCalledOnce());
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("link", { name: "内容资产" })).not.toBeInTheDocument();
  });

  it("refreshes the authenticated session after a successful member role update", async () => {
    const api = liveApi();
    let currentSession = session;
    const getSession = vi.fn(async () => currentSession);
    const updateMember = vi.fn<GeoApi["updateMember"]>(async (memberId, input) => {
      const nextRole = input.role ?? currentSession.actor.role;
      currentSession = {
        ...currentSession,
        actor: {
          ...currentSession.actor,
          role: nextRole,
          capabilities: ["tenant:read"],
        },
      };
      return {
        id: memberId,
        userId: currentSession.actor.id,
        email: "owner@example.test",
        displayName: "Test Owner",
        role: nextRole,
        capabilities: currentSession.actor.capabilities,
        enabledModules: currentSession.actor.enabledModules,
        status: input.status ?? "active",
        createdAt: "2026-07-14T08:00:00.000Z",
      };
    });
    api.getSession = getSession;
    api.updateMember = updateMember;
    renderApp({ path: "/customers", api });

    await screen.findByText("租户治理操作");
    fireEvent.click(await screen.findByRole("button", { name: "管理 Test Owner" }));
    fireEvent.change(screen.getByLabelText("变更后角色"), { target: { value: "viewer" } });
    fireEvent.change(screen.getByLabelText("成员变更原因"), {
      target: { value: "Demote current operator after access review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存成员变更" }));

    await waitFor(() => expect(updateMember).toHaveBeenCalledOnce());
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "新增联系方式" })).toBeDisabled();
  });

  it("hides manual package export without the priority distribution module", async () => {
    const api = liveApiWithModules([]);
    const getSession = api.getSession;
    const audits = await api.getAudits();
    api.getSession = async () => {
      const current = await getSession();
      return {
        ...current,
        actor: {
          ...current.actor,
          capabilities: [...current.actor.capabilities, "publish:request"],
        },
      };
    };
    api.getAudits = async () =>
      audits.map((audit) => ({ ...audit, expiresAt: "2099-07-14T08:14:00.000Z" }));

    renderApp({ path: "/audit", api });

    await screen.findByText("审计通过，没有阻断或警告。");
    expect(screen.queryByRole("button", { name: "导出人工发布包" })).not.toBeInTheDocument();
  });

  it("refreshes revoked module state and stops the protected route after MODULE_NOT_ENABLED", async () => {
    const api = liveApi();
    const revokedSession: SessionSnapshot = {
      ...session,
      actor: {
        ...session.actor,
        enabledModules: session.actor.enabledModules.filter(
          (module) => module !== "priority_distribution",
        ),
      },
    };
    let sessionRead = 0;
    const getSession = vi.fn(async () => (sessionRead++ === 0 ? session : revokedSession));
    const getChannelAccounts = vi.fn(async () => {
      throw new GeoApiError(403, "MODULE_NOT_ENABLED", "Module grant was revoked");
    });
    api.getSession = getSession;
    api.getChannelAccounts = getChannelAccounts;
    renderApp({ path: "/accounts", api });

    await screen.findByRole("heading", { name: "运营概览", level: 1 });
    expect(screen.queryByRole("link", { name: "平台账号" })).not.toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getChannelAccounts).toHaveBeenCalledOnce();
  });

  it("keeps baseline tenant governance while hiding module-owned customer controls", async () => {
    renderApp({ path: "/customers", api: liveApiWithModules([]) });

    await screen.findByText("租户治理操作");
    expect(screen.getByRole("button", { name: "新增联系方式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增成员" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增平台账号" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建自动化身份" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "品牌写作档案" })).not.toBeInTheDocument();
  });

  it.each(["/content", "/accounts", "/publishing", "/automation"])(
    "redirects an ungranted live module route %s to the baseline overview",
    async (path) => {
      renderApp({ path, api: liveApiWithModules([]) });

      await screen.findByRole("heading", { name: "运营概览", level: 1 });
      expect(screen.getByRole("link", { name: "运营概览" })).toHaveClass("active");
    },
  );

  it("keeps all module navigation visible in explicit demo mode", () => {
    renderApp({ demo: true });

    for (const label of ["内容资产", "平台账号", "投放中心", "自动化批次"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "热点雷达" })).toBeInTheDocument();
  });

  it("renders the self-monitoring Ctrip login handoff without the console shell", async () => {
    const api = liveApi();
    const accountId = "10000000-0000-4000-8000-000000000703";
    const refreshCtripAccountStatus = vi.fn(async () => ({
      id: accountId,
      platform: "ctrip_community" as const,
      displayName: "中通携程社区",
      capability: "browser_assisted" as const,
      supportedExecutionLevels: ["dry_run", "assisted"] as const,
      evidenceType: "platform_readback" as const,
      evidenceRefs: ["platform_readback"],
      status: "disabled" as const,
      lastVerifiedAt: null,
      ctripRuntime: {
        id: "10000000-0000-4000-8000-000000000704",
        channelAccountId: accountId,
        sessionState: "session_required" as const,
        bridgePrincipalId: "10000000-0000-4000-8000-000000000705",
        lastCheckedAt: "2026-07-29T13:30:00.000Z",
        lastReadyAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-07-29T13:30:00.000Z",
      },
    }));
    api.refreshCtripAccountStatus = refreshCtripAccountStatus;
    const loginUrl = new URL("http://127.0.0.1:10007/vnc.html");
    loginUrl.searchParams.set("autoconnect", "true");
    loginUrl.searchParams.set("channelAccountId", accountId);
    loginUrl.searchParams.set("path", `websockify/accounts/${accountId}`);
    const handoff = new URL("http://127.0.0.1:10003/ctrip-login");
    handoff.searchParams.set("channelAccountId", accountId);
    handoff.searchParams.set("loginUrl", loginUrl.toString());

    renderApp({ path: `${handoff.pathname}${handoff.search}`, api });

    expect(await screen.findByTitle("平台账号登录")).toHaveAttribute("src", loginUrl.toString());
    await waitFor(() => expect(refreshCtripAccountStatus).toHaveBeenCalledWith(accountId));
    expect(screen.queryByText("GEO Console")).not.toBeInTheDocument();
  });

  it("keeps dry-run capability and fixture evidence visibly marked in explicit demo mode", () => {
    renderApp({ demo: true });

    expect(screen.getByText("五家平台当前均为演练 / 人工操作")).toBeInTheDocument();
    const pipeline = screen.getByRole("region", { name: "内容生产与分发流水线" });
    for (const stage of [
      "热点雷达",
      "智能选题",
      "AI 图文创作",
      "平台变体",
      "机器审核",
      "异步发布",
      "发布确认",
    ]) {
      expect(within(pipeline).getByText(stage)).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "热点雷达" })).toHaveTextContent(
      "云南旅行社推荐与避坑清单",
    );
    expect(screen.getByText("演示数据")).toBeInTheDocument();
    expect(screen.getAllByText(/固定样本/).length).toBeGreaterThan(0);
    const confirmedMetric = screen.getByText("已确认回执").closest(".metric-cell");
    expect(confirmedMetric).not.toBeNull();
    expect(within(confirmedMetric as HTMLElement).getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("人工辅助")).not.toBeInTheDocument();
  });

  it("switches demo tenant context without leaking the previous tenant identity", () => {
    renderApp({ demo: true });

    fireEvent.change(screen.getByLabelText("当前客户"), { target: { value: "isolation" } });

    const contextBar = screen.getByText("隔离测试旅行社").closest(".context-bar");
    expect(contextBar).not.toBeNull();
    expect(within(contextBar as HTMLElement).getByText("测试隔离")).toBeInTheDocument();
  });

  it("creates only a clearly marked demo campaign from the operator dialog", async () => {
    renderApp({ demo: true });

    fireEvent.click(screen.getByRole("button", { name: "新建推广计划" }));
    fireEvent.change(screen.getByLabelText("推广计划名称"), {
      target: { value: "东南亚亲子证据计划" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "泰国 / 亲子 / 暑期" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建推广计划" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("东南亚亲子证据计划")).toBeInTheDocument();
    expect(screen.getByText("泰国 / 亲子 / 暑期")).toBeInTheDocument();
  });

  it("keeps global Campaign creation read-only without content:write", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("实时日本银发问答集");
    const createButton = await screen.findByRole("button", { name: "新建推广计划" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", "需要内容写入权限");
  });

  it("creates a first Campaign from the brand directory with a neutral industry value", async () => {
    const api = liveApi();
    const writerSession: SessionSnapshot = {
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "content:write"],
      },
    };
    let created: Parameters<GeoApi["createCampaign"]>[0] | null = null;
    api.getSession = async () => writerSession;
    api.getCampaigns = async () => [];
    api.createCampaign = async (input) => {
      created = input;
      return {
        id: "10000000-0000-4000-8000-000000001002",
        ...input,
        status: "draft",
        automationRemediationEnabled: true,
      };
    };
    renderApp({ api });

    const createButton = await screen.findByRole("button", { name: "新建推广计划" });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    expect(screen.getByRole("option", { name: /示例国际旅行服务 · 主品牌/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("推广计划名称"), {
      target: { value: "企业知识库可见性" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "采购 / 决策 / 对比" },
    });
    fireEvent.change(screen.getByLabelText("行业"), {
      target: { value: "professional_services" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建推广计划" }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({
      brandId: "10000000-0000-4000-8000-000000000301",
      industry: "professional_services",
      name: "企业知识库可见性",
      topicKey: "采购 / 决策 / 对比",
    });
  });

  it("generates an editable customer prompt template before creating a campaign", async () => {
    const api = liveApi();
    const writerSession: SessionSnapshot = {
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "content:write"],
      },
    };
    let created: Parameters<GeoApi["createCampaign"]>[0] | null = null;
    api.getSession = async () => writerSession;
    api.getCampaigns = async () => [];
    api.generateCampaignPromptTemplate = async (input) => ({
      promptTemplate: `围绕 ${input.campaignName ?? "推广计划"} 撰写 ${input.topicKey ?? ""} 体验笔记`,
      provider: "fixture",
      model: "fixture-v1",
      generatedAt: "2026-08-10T00:00:00.000Z",
    });
    api.createCampaign = async (input) => {
      created = input;
      return {
        id: "10000000-0000-4000-8000-000000001002",
        ...input,
        status: "draft",
        automationRemediationEnabled: true,
      };
    };
    renderApp({ api });

    const createButton = await screen.findByRole("button", { name: "新建推广计划" });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    fireEvent.change(screen.getByLabelText("推广计划名称"), {
      target: { value: "新疆暑期线路" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "xinjiang-summer" },
    });
    fireEvent.change(screen.getByLabelText("客户内容需求"), {
      target: { value: "突出真纯玩与国企地接" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI 生成提示词模版" }));

    await waitFor(() =>
      expect(screen.getByLabelText("提示词模版")).toHaveValue(
        "围绕 新疆暑期线路 撰写 xinjiang-summer 体验笔记",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建推广计划" }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({
      name: "新疆暑期线路",
      topicKey: "xinjiang-summer",
      promptTemplate: "围绕 新疆暑期线路 撰写 xinjiang-summer 体验笔记",
    });
  });

  it("makes the demo kill switch state explicit", () => {
    renderApp({ demo: true });

    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));

    expect(screen.getByText("演示：全租户投放已停止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复影子模式" })).toBeInTheDocument();
  });

  it("renders live API records and preserves visibility evidence dimensions", async () => {
    renderApp({ path: "/visibility", api: liveApi() });

    expect((await screen.findAllByText("web-search")).length).toBeGreaterThan(0);
    expect(screen.getByText("实时 API")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
    expect(screen.getAllByText("doubao-search-v1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("人工导入").length).toBeGreaterThan(0);
    expect(screen.queryByText("manual", { exact: true })).not.toBeInTheDocument();
  });

  it("never counts Preview evidence as a confirmed external receipt", async () => {
    const api = liveApi();
    const receipts = await api.getReceipts();
    api.getReceipts = async () =>
      receipts.map((receipt) => ({
        ...receipt,
        confirmed: true,
        externalUrl: "https://invalid.example/preview-is-not-published",
      }));
    renderApp({ api });

    await screen.findByText("实时日本银发问答集");
    const confirmedMetric = screen.getByText("已确认回执").closest(".metric-cell");
    expect(confirmedMetric).not.toBeNull();
    expect(within(confirmedMetric as HTMLElement).getByText("0")).toBeInTheDocument();
  });

  it("uses the selected demo tenant contact in generic visibility samples", () => {
    renderApp({ path: "/visibility", demo: true });

    fireEvent.change(screen.getByLabelText("当前客户"), { target: { value: "isolation" } });

    expect(screen.getByText("隔离测试旅行社电话")).toBeInTheDocument();
    expect(screen.getAllByText("命中 / 4000000000")).toHaveLength(2);
    expect(screen.queryByText(/4000000001/)).not.toBeInTheDocument();
  });

  it("renders the current tenant governance directory from tenant-scoped APIs", async () => {
    renderApp({ path: "/customers", api: liveApi() });

    await screen.findByText("当前租户治理目录");
    expect((await screen.findAllByText("owner@example.test")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("示例国际旅行服务").length).toBeGreaterThan(0);
    expect(screen.getAllByText("travel-v1").length).toBeGreaterThan(0);
    expect(screen.getByText("Domestic AI discovery")).toBeInTheDocument();
    expect(screen.getAllByText("所有者").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已启用").length).toBeGreaterThan(0);
    expect(screen.queryByText("owner", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("active", { exact: true })).not.toBeInTheDocument();
  });

  it("loads and saves a versioned Brand Agent Profile through the live API", async () => {
    const api = liveApi();
    let submitted: Parameters<GeoApi["createBrandAgentProfile"]> | null = null;
    const save = api.createBrandAgentProfile.bind(api);
    api.createBrandAgentProfile = async (...parameters) => {
      submitted = parameters;
      return save(...parameters);
    };

    renderApp({ path: "/customers", api });

    const voice = await screen.findByLabelText("品牌语气");
    await waitFor(() =>
      expect(within(screen.getByLabelText("档案当前版本")).getByText("v1")).toBeInTheDocument(),
    );
    expect(voice).toHaveValue("克制、清晰、证据优先；先回答问题，再解释依据与边界");

    fireEvent.change(voice, { target: { value: "直接回答，证据优先，明确适用边界" } });
    fireEvent.change(screen.getByLabelText("档案版本变更原因"), {
      target: { value: "收紧品牌表达边界" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() =>
      expect(within(screen.getByLabelText("档案当前版本")).getByText("v2")).toBeInTheDocument(),
    );
    expect(submitted).not.toBeNull();
    expect(submitted?.[0]).toBe("10000000-0000-4000-8000-000000000301");
    expect(submitted?.[1]).toMatchObject({
      reason: "收紧品牌表达边界",
      document: { voice: "直接回答，证据优先，明确适用边界" },
    });
  });

  it("keeps Brand Agent Profile read-only without tenant:manage", async () => {
    const api = liveApi();
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: session.actor.capabilities.filter((item) => item !== "tenant:manage"),
      },
    });

    renderApp({ path: "/customers", api });

    expect(await screen.findByLabelText("品牌语气")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "保存新版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存新版本" })).toHaveAttribute(
      "title",
      "需要租户管理权限",
    );
  });

  it("marks the demo Brand Agent Profile as non-persistent", () => {
    renderApp({ path: "/customers", demo: true });

    expect(screen.getByText("演示样例 · 未写入 API")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存新版本" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存新版本" })).toHaveAttribute(
      "title",
      "演示样例不写入 API",
    );
  });

  it("wires tenant governance actions to the live API and refreshes server readback", async () => {
    const api = liveApi();
    let submitted: Parameters<GeoApi["createContact"]>[0] | null = null;
    api.createContact = async (input) => {
      submitted = input;
      return {
        id: "10000000-0000-4000-8000-000000000404",
        tenantId: session.tenant.id,
        ...input,
        validFrom: "2026-07-15T00:00:00.000Z",
        validUntil: null,
      };
    };
    renderApp({ path: "/customers", api });

    await screen.findByText("租户治理操作");
    fireEvent.click(screen.getByRole("button", { name: "新增联系方式" }));
    fireEvent.change(screen.getByLabelText("联系方式类型"), { target: { value: "wechat" } });
    fireEvent.change(screen.getByLabelText("联系方式标签"), { target: { value: "微信咨询" } });
    fireEvent.change(screen.getByLabelText("联系方式值"), { target: { value: "TRAVEL_DEMO_02" } });
    fireEvent.click(screen.getByRole("button", { name: "保存联系方式" }));

    await waitFor(() =>
      expect(submitted).toEqual({
        type: "wechat",
        label: "微信咨询",
        value: "TRAVEL_DEMO_02",
        isPrimary: false,
      }),
    );
  });

  it("shows live audit artifacts on the overview instead of an obsolete unsupported state", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("审计通过，没有阻断或警告。");
    expect(screen.queryByText("实时审计列表不可用")).not.toBeInTheDocument();
  });

  it("keeps the article workflow bounded to audited customer-demo actions", async () => {
    renderApp({ path: "/content", api: liveApi() });

    await screen.findByText("受治理运营链");
    expect(screen.getByText(/五个平台统一使用浏览器自动化连接/)).toBeInTheDocument();
    expect(screen.getByText(/人工辅助或无人值守/)).toBeInTheDocument();
    expect(screen.getByText("尚无文章；创建操作会同时生成 v1")).toBeInTheDocument();
  });

  it("fails closed when the live article template catalog is unavailable", async () => {
    const api = liveApi();
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "content:write"],
      },
    });
    api.getArticleTemplates = async () => {
      throw new GeoApiError(
        503,
        "TEMPLATE_CATALOG_UNAVAILABLE",
        "Article template catalog is unavailable",
        "req-template-503",
      );
    };
    renderApp({ path: "/content", api });

    await screen.findByText("GET /api/article-templates 读取失败");
    expect(screen.getByText(/TEMPLATE_CATALOG_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.queryByText(`${ARTICLE_TEMPLATES.length} 套可审计结构`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建文章 + v1" })).toHaveAttribute(
      "title",
      "文章模板目录尚未就绪",
    );
  });

  it("routes to live automation batches with dashboard campaigns and Dry-run accounts", async () => {
    const api = liveApi();
    const campaigns = await api.getCampaigns();
    let batchReads = 0;
    let runReads = 0;
    api.getCampaigns = async () => campaigns.map((campaign) => ({ ...campaign, status: "active" }));
    api.getAutomationBatches = async () => {
      batchReads += 1;
      return [];
    };
    api.getAutomationRuns = async () => {
      runReads += 1;
      return [];
    };
    renderApp({ path: "/automation", api });

    expect(
      await screen.findByRole("heading", { level: 1, name: "自动化批次" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "自动化批次" })).toHaveClass("active");
    expect(await screen.findByText("当前租户尚无自动化批次")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "实时日本银发问答集" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    expect(await screen.findByLabelText("自动化目标平台：头条号")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "创建演练批次" })).toBeEnabled());
    expect(screen.getByText(/不执行外部发送/)).toBeInTheDocument();
    expect(screen.queryByText(/已真实发布/)).not.toBeInTheDocument();
    expect(batchReads).toBe(1);
    expect(runReads).toBe(0);
  });

  it("refreshes dashboard Campaign data after a governed activation readback", async () => {
    const api = liveApi();
    const [initialCampaign] = await api.getCampaigns();
    if (initialCampaign === undefined) throw new Error("fixture campaign is missing");
    let currentCampaign = initialCampaign;
    let campaignReads = 0;
    const transitionCalls: {
      readonly campaignId: string;
      readonly status: string;
      readonly reason: string | undefined;
    }[] = [];
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "content:write"],
      },
    });
    api.getCampaigns = async () => {
      campaignReads += 1;
      return [currentCampaign];
    };
    api.transitionCampaignState = async (campaignId, input) => {
      transitionCalls.push({ campaignId, status: input.status, reason: input.reason });
      const previousStatus = currentCampaign.status;
      currentCampaign = { ...currentCampaign, status: input.status };
      return { campaign: currentCampaign, previousStatus, wasChanged: true };
    };
    renderApp({ path: "/automation", api });

    fireEvent.click(
      await screen.findByRole("button", {
        name: `激活推广计划 ${initialCampaign.name}`,
      }),
    );
    fireEvent.change(screen.getByLabelText("推广计划状态变更原因"), {
      target: { value: "核验事实与平台账号已就绪" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认激活" }));

    expect(await screen.findByRole("option", { name: initialCampaign.name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "演练" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建演练批次" })).toBeEnabled());
    expect(transitionCalls).toEqual([
      {
        campaignId: initialCampaign.id,
        status: "active",
        reason: "核验事实与平台账号已就绪",
      },
    ]);
    expect(campaignReads).toBeGreaterThanOrEqual(2);
  });

  it("keeps the integrated automation route read-only without automation:manage", async () => {
    const api = liveApi();
    const campaigns = await api.getCampaigns();
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: session.actor.capabilities.filter(
          (capability) => capability !== "automation:manage",
        ),
      },
    });
    api.getCampaigns = async () => campaigns.map((campaign) => ({ ...campaign, status: "active" }));
    renderApp({ path: "/automation", api });

    expect(await screen.findByText(/本页保持只读/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并批量发送 30 个变体" })).toBeDisabled();
    expect(screen.getByLabelText("自动生成文章数量")).toBeDisabled();
  });

  it("does not turn demo data into an automation run", () => {
    renderApp({ path: "/automation", demo: true });

    expect(screen.getByRole("heading", { level: 1, name: "自动化批次" })).toBeInTheDocument();
    expect(screen.getByText("没有可读取的自动化运行")).toBeInTheDocument();
    expect(screen.getByText("未连接实时会话")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建并批量发送 30 个变体" }),
    ).not.toBeInTheDocument();
  });

  it("does not silently replace an unavailable API with demo success", async () => {
    const api = liveApi();
    api.getSession = async () => {
      throw new GeoApiError(0, "NETWORK_ERROR", "API unavailable");
    };
    renderApp({ api });

    await screen.findByRole("heading", { name: "登录运营台" });
    expect(screen.getByText(/运营 API 暂时不可用/)).toBeInTheDocument();
    expect(screen.getByText(/NETWORK_ERROR/)).toBeInTheDocument();
    expect(screen.queryByText("日本银发跟团游问答集")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入演示模式" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("数据边界")).not.toBeInTheDocument();
    expect(screen.queryByText("实时运营入口")).not.toBeInTheDocument();
  });

  it("keeps a partial endpoint failure visible with its request id", async () => {
    const api = liveApi();
    api.getCampaigns = async () => {
      throw new GeoApiError(
        503,
        "DATABASE_UNAVAILABLE",
        "Campaign storage is unavailable",
        "req-campaigns-503",
      );
    };
    renderApp({ api });

    await screen.findByText("GET /api/campaigns 读取失败");
    expect(screen.getByText(/DATABASE_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.getByText(/req-campaigns-503/)).toBeInTheDocument();
    expect(screen.getByText("实时 API")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
  });

  it("automatically recovers the account resource after a transient network failure", async () => {
    const api = liveApi();
    const accounts = await api.getChannelAccounts();
    let recovered = false;
    const getChannelAccounts = vi.fn<GeoApi["getChannelAccounts"]>(async () => {
      if (!recovered) throw new GeoApiError(0, "NETWORK_ERROR", "Failed to fetch");
      return accounts;
    });
    api.getChannelAccounts = getChannelAccounts;

    renderApp({ path: "/accounts", api });

    await screen.findByText("GET /api/channel-accounts 读取失败");
    const failedReads = getChannelAccounts.mock.calls.length;
    recovered = true;
    await waitFor(
      () => {
        expect(screen.queryByText("GET /api/channel-accounts 读取失败")).not.toBeInTheDocument();
      },
      { timeout: 4_000 },
    );
    expect(getChannelAccounts.mock.calls.length).toBeGreaterThan(failedReads);
  });

  it("removes an archived account from every live account surface despite a stale read", async () => {
    const api = liveApi();
    const account: ChannelAccount = {
      id: "10000000-0000-4000-8000-000000000799",
      platform: "toutiao",
      displayName: "待归档头条账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["assisted", "unattended"],
      evidenceType: "authenticated_session",
      evidenceRefs: ["runtime:test-account"],
      status: "active",
      lastVerifiedAt: "2026-08-11T02:00:00.000Z",
    };
    api.getChannelAccounts = vi.fn(async () => [account]);
    api.getPriorityPlatformAccountAnalytics = vi.fn(async () => ({
      scope: "priority_platforms" as const,
      accountCount: 1,
      reportingAccountCount: 1,
      totals: {
        publishCount: 7,
        impressions: 101,
        reads: 51,
        likes: 11,
        comments: 3,
      },
      accounts: [
        {
          channelAccountId: account.id,
          platform: "toutiao" as const,
          displayName: account.displayName,
          dataStatus: "ready" as const,
          reportPeriod: "近7天",
          publishCount: 7,
          totalImpressions: 101,
          totalReads: 51,
          totalLikes: 11,
          totalComments: 3,
          works: [],
          observedAt: "2026-08-11T02:00:00.000Z",
          nextRefreshAt: "2026-08-11T03:00:00.000Z",
          lastAttemptedAt: "2026-08-11T02:00:00.000Z",
          lastSucceededAt: "2026-08-11T02:00:00.000Z",
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      ],
    }));
    api.deleteChannelAccount = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp({ path: "/accounts", api });

    expect(await screen.findAllByText(account.displayName)).not.toHaveLength(0);
    const analyticsBefore = screen.getByLabelText("全平台运营概览");
    expect(within(analyticsBefore).getByText("1 / 1 个账号已更新")).toBeInTheDocument();
    expect(analyticsBefore.querySelector(".account-analytics-metrics")).toHaveTextContent(
      "发布7展现101阅读51收藏--点赞11评论3",
    );
    fireEvent.click(screen.getByRole("button", { name: `删除 ${account.displayName}` }));
    await waitFor(() => expect(api.deleteChannelAccount).toHaveBeenCalledWith(account.id));
    await waitFor(() => expect(screen.queryAllByText(account.displayName)).toHaveLength(0));
    const analyticsAfter = screen.getByLabelText("全平台运营概览");
    expect(within(analyticsAfter).getByText("0 / 0 个账号已更新")).toBeInTheDocument();
    expect(analyticsAfter.querySelector(".account-analytics-metrics")).toHaveTextContent(
      "发布--展现--阅读--收藏--点赞--评论--",
    );

    fireEvent.click(screen.getByRole("link", { name: "自动化批次" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "自动化批次" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "投放中心" }));
    expect(await screen.findByRole("heading", { level: 1, name: "投放中心" })).toBeInTheDocument();
    expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "运营概览" }));
    expect(await screen.findByRole("heading", { level: 1, name: "运营概览" })).toBeInTheDocument();
    expect(screen.queryByText(account.displayName)).not.toBeInTheDocument();
  });

  it("keeps archive tombstones scoped to the tenant that initiated deletion", async () => {
    const api = liveApi();
    const sharedAccountId = "10000000-0000-4000-8000-000000000798";
    const firstAccount: ChannelAccount = {
      id: sharedAccountId,
      platform: "toutiao",
      displayName: "待归档租户甲账号",
      capability: "browser_assisted",
      supportedExecutionLevels: ["assisted", "unattended"],
      evidenceType: "authenticated_session",
      evidenceRefs: ["runtime:tenant-a"],
      status: "active",
      lastVerifiedAt: "2026-08-11T02:00:00.000Z",
    };
    const secondAccount: ChannelAccount = {
      ...firstAccount,
      displayName: "租户乙同标识账号",
      evidenceRefs: ["runtime:tenant-b"],
    };
    const otherSession: SessionSnapshot = {
      ...session,
      tenant: {
        id: "20000000-0000-4000-8000-000000000001",
        slug: "archive-scope-customer",
        displayName: "归档作用域客户",
      },
    };
    let currentSession = session;
    let finishDeletion: (() => void) | undefined;
    api.getSession = async () => currentSession;
    api.getTenants = async () => [
      {
        id: session.tenant.id,
        slug: session.tenant.slug,
        displayName: session.tenant.displayName,
        role: "owner",
        status: "active",
      },
      {
        id: otherSession.tenant.id,
        slug: otherSession.tenant.slug,
        displayName: otherSession.tenant.displayName,
        role: "owner",
        status: "active",
      },
    ];
    api.switchTenant = async () => {
      currentSession = otherSession;
      return otherSession;
    };
    api.getChannelAccounts = async () =>
      currentSession.tenant.id === session.tenant.id ? [firstAccount] : [secondAccount];
    api.deleteChannelAccount = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeletion = resolve;
        }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp({ path: "/accounts", api });
    expect(await screen.findAllByText(firstAccount.displayName)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: `删除 ${firstAccount.displayName}` }));
    await waitFor(() => expect(api.deleteChannelAccount).toHaveBeenCalledWith(sharedAccountId));

    const tenantSelect = screen.getByLabelText("工作空间");
    await waitFor(() => expect(tenantSelect).toBeEnabled());
    fireEvent.change(tenantSelect, { target: { value: otherSession.tenant.slug } });
    expect(await screen.findAllByText(secondAccount.displayName)).not.toHaveLength(0);

    await act(async () => finishDeletion?.());
    expect(screen.queryAllByText(secondAccount.displayName)).not.toHaveLength(0);
  });

  it("uses tenant-matched SSE snapshots and keeps a bounded consistency poll", async () => {
    const api = liveApi();
    type OperationsHandlers = Parameters<NonNullable<GeoApi["subscribeOperationsEvents"]>>[0];
    let handlers: OperationsHandlers | null = null;
    const close = vi.fn();
    const subscribeOperationsEvents = vi.fn((next: OperationsHandlers) => {
      handlers = next;
      return { close };
    });
    const getTrendCandidates = vi.fn(async () => []);
    const getContent = vi.fn(api.getContent);
    const getPublicationJobs = vi.fn(api.getPublicationJobs);
    const getReceipts = vi.fn(api.getReceipts);
    const getBrands = vi.fn(api.getBrands);
    api.subscribeOperationsEvents = subscribeOperationsEvents;
    api.getTrendCandidates = getTrendCandidates;
    api.getContent = getContent;
    api.getPublicationJobs = getPublicationJobs;
    api.getReceipts = getReceipts;
    api.getBrands = getBrands;
    const currentHandlers = (): OperationsHandlers => {
      if (handlers === null) throw new Error("operations event subscription was not established");
      return handlers;
    };

    const rendered = renderApp({ api, operationsPollIntervalMs: 250 });
    await waitFor(() => {
      expect(subscribeOperationsEvents).toHaveBeenCalledOnce();
      expect(getContent).toHaveBeenCalled();
      expect(getBrands).toHaveBeenCalled();
    });
    getTrendCandidates.mockClear();
    getContent.mockClear();
    getPublicationJobs.mockClear();
    getReceipts.mockClear();
    getBrands.mockClear();

    act(() => {
      currentHandlers().onSnapshot({
        type: "snapshot_required",
        tenantId: "20000000-0000-4000-8000-000000000001",
        emittedAt: "2026-08-03T12:00:00.000Z",
      });
    });
    await act(async () => undefined);
    expect(getTrendCandidates).not.toHaveBeenCalled();
    expect(getContent).not.toHaveBeenCalled();

    act(() => {
      currentHandlers().onSnapshot({
        type: "snapshot_required",
        tenantId: session.tenant.id,
        emittedAt: "2026-08-03T12:00:00.000Z",
      });
    });
    await waitFor(() => {
      expect(getTrendCandidates).toHaveBeenCalledOnce();
      expect(getContent).toHaveBeenCalledOnce();
      expect(getPublicationJobs).toHaveBeenCalledOnce();
      expect(getReceipts).toHaveBeenCalledOnce();
    });
    expect(getBrands).toHaveBeenCalledOnce();

    getTrendCandidates.mockClear();
    getContent.mockClear();
    getPublicationJobs.mockClear();
    getReceipts.mockClear();
    await waitFor(
      () => {
        expect(getTrendCandidates).toHaveBeenCalledOnce();
        expect(getContent).toHaveBeenCalledOnce();
        expect(getPublicationJobs).toHaveBeenCalledOnce();
        expect(getReceipts).toHaveBeenCalledOnce();
      },
      { timeout: 1_000 },
    );
    expect(close).not.toHaveBeenCalled();

    getTrendCandidates.mockClear();
    getContent.mockClear();
    getPublicationJobs.mockClear();
    getReceipts.mockClear();
    act(() => {
      currentHandlers().onError(
        new GeoApiError(0, "OPERATIONS_EVENT_CONNECTION_FAILED", "stream closed"),
      );
    });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(
      () => {
        expect(getContent).toHaveBeenCalled();
      },
      { timeout: 1_000 },
    );

    rendered.unmount();
  });

  it("keeps publishing data mounted while a same-tenant refresh is pending", async () => {
    const api = liveApi();
    renderApp({ path: "/publishing", api });

    const existingJob = await screen.findByRole("button", {
      name: "查看作业 10000000-0000-4000-8000-000000001101 详情",
    });
    let resolveTenantRefresh: (value: TenantView) => void = () => undefined;
    api.getTenant = vi.fn<GeoApi["getTenant"]>(
      () =>
        new Promise<TenantView>((resolve) => {
          resolveTenantRefresh = resolve;
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新实时数据" }));
    await waitFor(() => expect(api.getTenant).toHaveBeenCalledOnce());

    expect(existingJob).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "查看作业 10000000-0000-4000-8000-000000001101 详情",
      }),
    ).toBeInTheDocument();

    resolveTenantRefresh({
      id: session.tenant.id,
      slug: session.tenant.slug,
      displayName: session.tenant.displayName,
      legalName: session.tenant.displayName,
      industry: "travel",
      status: "active",
      defaultLocale: "zh-CN",
    });
  });

  it("keeps live health indicators static instead of continuously pulsing", async () => {
    renderApp({ path: "/publishing", api: liveApi() });

    await screen.findByText("服务在线");

    expect(document.querySelectorAll(".health-indicator")).toHaveLength(2);
    expect(document.querySelector(".health-pulse")).not.toBeInTheDocument();
  });

  it("shows the first-release capability boundary without implying live providers", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    expect(await screen.findByText("第一版能力边界")).toBeInTheDocument();
    expect(screen.getByText("GEO 模板与规范草稿")).toBeInTheDocument();
    expect(screen.getByText("多平台无人值守发布")).toBeInTheDocument();
    expect(screen.getByText("豆包 / 千问在线评测")).toBeInTheDocument();
    expect(screen.getByText("生产级图片生成")).toBeInTheDocument();
    expect(screen.getByText("品牌记忆正负反馈闭环")).toBeInTheDocument();
  });

  it("shows a customer-facing ready path without exposing deployment identifiers", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    expect(await screen.findByText(/真实账号预检/)).toBeInTheDocument();
    expect(await screen.findByText("正式治理服务")).toBeInTheDocument();
    expect(await screen.findByText("携程桥接服务")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "开始生成文章" })).toHaveAttribute(
      "href",
      "/content",
    );
    expect(screen.queryByText(/10000000-0000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/CTRIP_/)).not.toBeInTheDocument();
  });

  it("shows an actionable Ctrip challenge state without claiming automatic bypass", async () => {
    const api = liveApi();
    api.getCtripBridgeStatus = async () => ({
      configured: true,
      reachable: true,
      mode: "browser_unattended",
      adapterVersion: "ctrip-community-browser-unattended-v1",
      commandCapabilities: { prepare: true, submit: true, readback: true },
      operationalStatus: "challenge_required",
      operationalCheckedAt: "2026-07-21T19:00:00.000Z",
    });
    renderApp({ path: "/publishing", api });

    expect(
      await screen.findByText("携程要求完成验证码或安全验证，请在专用 Edge 中人工完成"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/自动绕过/)).not.toBeInTheDocument();
  });

  it("edits and confirms the live tenant automation mode and worker quota", async () => {
    const api = liveApi();
    const original = api.setAutomationControl.bind(api);
    let submitted: Parameters<GeoApi["setAutomationControl"]>[0] | null = null;
    api.setAutomationControl = async (input) => {
      submitted = input;
      return original(input);
    };
    renderApp({ path: "/settings", api });

    const mode = await screen.findByLabelText("运行模式");
    fireEvent.change(mode, { target: { value: "unattended" } });
    fireEvent.change(screen.getByLabelText("最大并发"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("每分钟上限"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("每日上限"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("冷却秒数"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("错误预算"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("自动化变更原因"), {
      target: { value: "审计和 Dry-run 样本已完成复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存自动化策略" }));

    await waitFor(() =>
      expect(submitted).toEqual({
        mode: "unattended",
        quota: {
          maxConcurrent: 2,
          perMinute: 8,
          perDay: 80,
          cooldownSeconds: 15,
          errorBudget: 4,
          errorBudgetExhaustedPolicy: "review",
        },
        reason: "审计和 Dry-run 样本已完成复核",
      }),
    );
    await waitFor(() => expect(mode).toHaveValue("unattended"));
    expect(screen.getByText(/无人值守只调度已审计且登录态就绪/)).toBeInTheDocument();
  });

  it("adds a scoped control and manually opens a circuit with API readback", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    const addControl = await screen.findByRole("button", { name: "添加范围控制" });
    fireEvent.click(addControl);
    expect(screen.getByRole("option", { name: "百家号" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "网易号" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("范围运行模式"), {
      target: { value: "paused" },
    });
    fireEvent.click(screen.getByLabelText("范围急停开关"));
    fireEvent.change(screen.getByLabelText("范围控制变更原因"), {
      target: { value: "头条账号能力证据正在复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存范围控制" }));

    expect(await screen.findByText("平台 · toutiao")).toBeInTheDocument();
    expect(screen.getByText("已急停")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "手动熔断" }));
    fireEvent.change(screen.getByLabelText("熔断处置原因"), {
      target: { value: "租户级风险信号等待人工复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认熔断" }));

    expect(await screen.findByText("租户 · *")).toBeInTheDocument();
    expect(screen.getByText("熔断中")).toBeInTheDocument();
  });

  it("shows a truthful empty state for a successful zero-row response", async () => {
    renderApp({ path: "/content", api: liveApi() });

    await screen.findByText("尚无文章；创建操作会同时生成 v1");
  });

  it("shows live Kill Switch state only after write and readback agree", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("当前租户急停开关已关闭");
    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));
    fireEvent.change(screen.getByLabelText("操作原因"), {
      target: { value: "联系方式异常，暂停当前租户投放" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));

    await screen.findByText("当前租户投放已暂停");
    expect(screen.getByRole("button", { name: "恢复影子模式" })).toBeInTheDocument();
  });

  it("shows assisted handoffs without exposing submit permit material", async () => {
    renderApp({ path: "/publishing", api: liveApi() });

    expect(await screen.findByText("多平台人工交接")).toBeInTheDocument();
    expect(await screen.findByText("青岛赴日跟团先比什么")).toBeInTheDocument();
    expect(await screen.findByText("未提交")).toBeInTheDocument();
    expect(await screen.findByText("待交接")).toBeInTheDocument();
    expect(screen.getByText("租约已过期")).toBeInTheDocument();
    expect(screen.getByText("ctrip-community-web-v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /认领交接单/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取消交接单/ })).toBeDisabled();
    expect(document.body.textContent).not.toContain("submitPermitHash");
    expect(document.body.textContent).not.toContain("submit_permit");
  });

  it("uses each handoff platform in assisted prepare, approval, and readback controls", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("assisted handoff fixture is missing");
    const sohuHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      platform: "sohu",
      adapterVersion: "sohu-browser-publication-v1",
      leaseOwnerActorId: session.actor.id,
      leaseExpiresAt: "2099-07-14T08:02:00.000Z",
    };
    const neteaseHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      id: "10000000-0000-4000-8000-000000001391",
      jobId: "10000000-0000-4000-8000-000000001392",
      channelAccountId: "10000000-0000-4000-8000-000000000702",
      platform: "netease",
      state: "draft_prepared",
      adapterVersion: "netease-browser-publication-v1",
    };
    const baijiahaoHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      id: "10000000-0000-4000-8000-000000001393",
      jobId: "10000000-0000-4000-8000-000000001394",
      channelAccountId: "10000000-0000-4000-8000-000000000703",
      platform: "baijiahao",
      state: "readback_pending",
      adapterVersion: "baijiahao-browser-publication-v1",
      submitPermitConsumedAt: "2026-07-14T08:02:00.000Z",
    };
    const zhihuHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      id: "10000000-0000-4000-8000-000000001395",
      jobId: "10000000-0000-4000-8000-000000001396",
      channelAccountId: "10000000-0000-4000-8000-000000000704",
      platform: "zhihu",
      articleTitle: "知乎交接单平台标签",
      state: "draft_prepared",
      adapterVersion: "zhihu-browser-publication-v1",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request"],
      },
    });
    api.getChannelAccounts = async () => [
      {
        id: sohuHandoff.channelAccountId,
        platform: "sohu",
        displayName: "搜狐运营号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted"],
        evidenceType: "browser_screenshot",
        evidenceRefs: [],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
      },
      {
        id: neteaseHandoff.channelAccountId,
        platform: "netease",
        displayName: "网易运营号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted"],
        evidenceType: "browser_screenshot",
        evidenceRefs: [],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
      },
      {
        id: baijiahaoHandoff.channelAccountId,
        platform: "baijiahao",
        displayName: "百家运营号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted"],
        evidenceType: "browser_screenshot",
        evidenceRefs: [],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
      },
      {
        id: zhihuHandoff.channelAccountId,
        platform: "zhihu",
        displayName: "知乎运营号",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted"],
        evidenceType: "browser_screenshot",
        evidenceRefs: [],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
      },
    ];
    api.getPublicationAssistedHandoffs = async () => [
      sohuHandoff,
      neteaseHandoff,
      baijiahaoHandoff,
      zhihuHandoff,
    ];

    renderApp({ path: "/publishing", api });

    expect(await screen.findByRole("button", { name: /准备搜狐号草稿/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行百家号回读/ })).toBeInTheDocument();
    expect(screen.getByText("知乎交接单平台标签")).toBeInTheDocument();
    expect(screen.getByText("知乎", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `批准提交 ${neteaseHandoff.id}` }));
    expect(await screen.findByRole("dialog", { name: "批准网易号提交" })).toBeInTheDocument();
  });

  it("shows pending and published Ctrip articles with the confirmed public link", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const pendingHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "readback_pending",
      articleTitle: "青岛赴日跟团先比什么",
      submitOutcome: "uncertain",
      submitEvidenceKind: "browser",
      submitObservedAt: "2026-07-27T06:48:37.000+08:00",
      readbackOutcome: "unavailable",
      readbackEvidenceKind: "platform_readback",
    };
    const publishedUrl = "https://m.ctrip.com/webapp/you/community/detail?articleId=123456789";
    const publishedHandoff: PublicationAssistedHandoff = {
      ...pendingHandoff,
      id: "10000000-0000-4000-8000-000000001399",
      jobId: "10000000-0000-4000-8000-000000001398",
      state: "confirmed",
      articleTitle: "赴日跟团合同费用怎么看",
      submitOutcome: "accepted",
      readbackOutcome: "confirmed",
      externalId: "123456789",
      externalUrl: publishedUrl,
    };
    api.getPublicationAssistedHandoffs = async () => [pendingHandoff, publishedHandoff];

    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("正在确认平台状态")).toBeInTheDocument();
    expect(screen.getByText("公开已确认")).toBeInTheDocument();
    expect(screen.getByText("赴日跟团合同费用怎么看")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /原始 URL.*ctrip\.com/u })).toHaveAttribute(
      "href",
      publishedUrl,
    );
  });

  it("labels read-only Ctrip browser preflight without presenting it as live", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const preflightHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "session_required",
      adapterVersion: "ctrip-community-browser-preflight-v1",
      prepareOutcome: "session_required",
      prepareEvidenceKind: "browser",
      prepareEvidenceHash: "a".repeat(64),
      prepareObservedAt: "2026-07-16T12:00:00.000Z",
    };
    api.getPublicationAssistedHandoffs = async () => [preflightHandoff];
    api.getPublicationAssistedHandoff = async () => preflightHandoff;

    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("浏览器预检")).toBeInTheDocument();
    expect(screen.getByText("session_required · browser · aaaaaaaa…aaaa")).toBeInTheDocument();
    expect(screen.queryByText("实时桥接")).not.toBeInTheDocument();
  });

  it("runs the governed Ctrip simulator commands through explicit approval and readback", async () => {
    const api = liveApi();
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request", "publish:cancel"],
      },
    });
    renderApp({ path: "/publishing", api });

    fireEvent.click(await screen.findByRole("button", { name: /认领交接单/ }));
    fireEvent.click(await screen.findByRole("button", { name: /准备携程社区草稿/ }));

    expect(await screen.findByText("草稿已准备")).toBeInTheDocument();
    expect(screen.getByText("仿真环境")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /批准提交/ }));
    const approval = await screen.findByRole("dialog", { name: "批准携程社区提交" });
    expect(within(approval).getByText(/当前为仿真环境/)).toBeInTheDocument();
    fireEvent.click(within(approval).getByRole("checkbox", { name: /确认已核对审计/ }));
    fireEvent.click(within(approval).getByRole("button", { name: "确认提交" }));

    expect(await screen.findByText("等待发布确认")).toBeInTheDocument();
    expect(screen.getByText("模拟接受 · 未确认")).toBeInTheDocument();
    const manualReadback = screen.getByRole("button", { name: /执行携程社区回读/ });
    expect(manualReadback).toHaveTextContent("人工查询");
    fireEvent.click(manualReadback);

    expect((await screen.findAllByText("需复核")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("仅仿真证据 · 未产生真实发布")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("f".repeat(64));
    expect(document.body.textContent).not.toContain("submitPermit");
    expect(document.body.textContent).not.toContain("submit_permit");
  });

  it("reopens a needs_review handoff through the manual readback action", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const needsReview: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "needs_review",
      readbackOutcome: "not_found",
      readbackEvidenceKind: "browser",
      readbackEvidenceHash: "3".repeat(64),
      readbackObservedAt: "2026-07-14T08:03:00.000Z",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request", "publish:cancel"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [needsReview];
    api.getPublicationAssistedHandoff = async () => needsReview;
    const reopen = vi.fn(async (): Promise<PublicationAssistedBridgeActionResult> => ({
      handoff: { ...needsReview, state: "readback_pending" as const, readbackOutcome: null },
      bridge: {
        schemaVersion: "geo.ctrip-bridge.result.v1",
        tenantId: session.tenant.id,
        handoffId: needsReview.id,
        bridgePrincipalId: "10000000-0000-4000-8000-000000001302",
        command: "readback",
        outcome: "unavailable",
        evidenceKind: "browser",
        state: "readback_pending",
        externalId: null,
        externalUrl: null,
        adapterVersion: needsReview.adapterVersion,
        observedAt: "2026-07-14T08:04:00.000Z",
        evidenceHash: "4".repeat(64),
      },
    }));
    api.reopenPublicationAssistedReadback = reopen;

    renderApp({ path: "/publishing", api });

    const action = await screen.findByRole("button", { name: /人工确认并重新回读/ });
    fireEvent.click(action);
    await waitFor(() => expect(reopen).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("已按人工复核重新打开回读窗口并执行公开回读。"),
    ).toBeInTheDocument();
  });

  it("shows a readback timeout as uncertain and keeps the manual reopen action", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const timedOut: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "needs_review",
      readbackOutcome: "not_found",
      readbackEvidenceKind: "browser",
      readbackEvidenceHash: "3".repeat(64),
      readbackObservedAt: "2026-07-14T08:03:00.000Z",
      lastErrorCode: "ASSISTED_READBACK_UNCERTAIN",
      lastErrorMessage: "10 分钟公开回读超时，结果不明确，请人工确认",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request", "publish:cancel"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [timedOut];

    renderApp({ path: "/publishing", api });

    expect((await screen.findAllByText("结果不明确")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("10 分钟超时 · 结果不明确")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /人工确认并重新回读/ })).toBeInTheDocument();
  });

  it("shows an accepted submit as asynchronous review and keeps immediate readback available", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const deferred: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "readback_pending",
      submitOutcome: "accepted",
      readbackOutcome: "not_found",
      readbackEvidenceKind: "browser",
      readbackEvidenceHash: "3".repeat(64),
      readbackObservedAt: "2026-08-07T08:03:00.000Z",
      readbackAttemptCount: 3,
      readbackDeadlineAt: "2026-08-08T08:03:00.000Z",
      lastErrorCode: "ASSISTED_READBACK_DEFERRED",
      lastErrorMessage: "已提交平台审核，系统将在后台继续异步回读",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [deferred];

    renderApp({ path: "/publishing", api });

    expect((await screen.findAllByText("异步回读中")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("已提交，待平台审核")).toBeInTheDocument();
    expect(screen.getByText("平台审核中 · 后台低频回读")).toBeInTheDocument();
    expect(screen.getByText(/已回读 3 次/)).toBeInTheDocument();
    expect(screen.getByText(/已回读 3 次 · 截止/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行携程社区回读/ })).toHaveTextContent("人工查询");
  });

  it("does not render a deferred candidate URL as a failed or retryable submit", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const deferredCandidate: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "readback_pending",
      submitOutcome: "uncertain",
      submitCandidateExternalId: "DEMO000000000006",
      submitCandidateExternalUrl: "https://www.163.com/dy/article/DEMO000000000006.html",
      readbackOutcome: "not_found",
      readbackEvidenceKind: "browser",
      readbackAttemptCount: 6,
      readbackDeadlineAt: "2026-08-16T04:15:00.000Z",
      lastErrorCode: "ASSISTED_READBACK_DEFERRED",
      lastErrorMessage: "已提交平台审核，系统将在后台继续异步回读",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [deferredCandidate];

    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("已提交，等待平台审核 · 禁止重复提交")).toBeInTheDocument();
    expect(screen.getByText("平台审核中 · 后台低频回读")).toBeInTheDocument();
    expect(screen.getByText("候选 URL · 未确认")).toBeInTheDocument();
    expect(screen.queryByText("结果不确定 · 禁止自动重试")).not.toBeInTheDocument();
  });

  it("shows a publisher rejection as a terminal platform review result", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Handoff fixture is missing");
    const rejected: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "needs_review",
      submitOutcome: "accepted",
      readbackOutcome: "publisher_rejected",
      readbackEvidenceKind: "creator_management",
      readbackEvidenceHash: "4".repeat(64),
      readbackObservedAt: "2026-08-11T08:03:00.000Z",
      lastErrorCode: "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL",
      lastErrorMessage: "平台审核未通过：文章被判定为广告软文",
    };
    api.getPublicationAssistedHandoffs = async () => [rejected];

    renderApp({ path: "/publishing", api });

    expect((await screen.findAllByText("平台审核未通过 · 广告软文")).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.queryByText("异步回读中")).not.toBeInTheDocument();
    expect(screen.queryByText("平台审核中 · 后台低频回读")).not.toBeInTheDocument();
    expect(screen.queryByText("平台回读不可用 · 需复核")).not.toBeInTheDocument();
  });

  it("submits a prepared Ctrip draft with one approval and no separate lease claim", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    if (baseHandoff.bridgeServicePrincipalId === null) {
      throw new Error("Ctrip bridge principal fixture is missing");
    }
    let preparedHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "draft_prepared",
      leaseOwnerActorId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      draftEvidenceHash: "7".repeat(64),
      prepareOutcome: "prepared",
      prepareEvidenceKind: "simulation",
      prepareEvidenceHash: "8".repeat(64),
      prepareObservedAt: "2026-07-14T08:01:00.000Z",
      adapterVersion: "ctrip-community-simulator-v1",
    };
    const bridgePrincipalId = baseHandoff.bridgeServicePrincipalId;
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [preparedHandoff];
    api.getPublicationAssistedHandoff = async () => preparedHandoff;
    api.claimPublicationAssistedHandoff = vi.fn(api.claimPublicationAssistedHandoff);
    api.submitPublicationAssistedHandoff = vi.fn(
      async (): Promise<PublicationAssistedBridgeActionResult> => {
        preparedHandoff = {
          ...preparedHandoff,
          state: "readback_pending",
          submitPermitIssued: true,
          submitPermitConsumedAt: "2026-07-14T08:02:00.000Z",
          submitOutcome: "accepted",
          submitEvidenceKind: "simulation",
          submitObservedAt: "2026-07-14T08:02:00.000Z",
          publicationReceiptId: "10000000-0000-4000-8000-000000001303",
          publicationReadbackId: "10000000-0000-4000-8000-000000001304",
        };
        return {
          handoff: preparedHandoff,
          bridge: {
            schemaVersion: "geo.ctrip-bridge.result.v1",
            tenantId: session.tenant.id,
            handoffId: preparedHandoff.id,
            bridgePrincipalId,
            command: "submit",
            outcome: "accepted",
            evidenceKind: "simulation",
            state: "readback_pending",
            receiptId: "10000000-0000-4000-8000-000000001303",
            readbackId: "10000000-0000-4000-8000-000000001304",
            adapterVersion: preparedHandoff.adapterVersion,
            observedAt: "2026-07-14T08:02:00.000Z",
            evidenceHash: "8".repeat(64),
          },
        };
      },
    );
    renderApp({ path: "/publishing", api });

    fireEvent.click(await screen.findByRole("button", { name: /批准提交/ }));
    const approval = await screen.findByRole("dialog", { name: "批准携程社区提交" });
    fireEvent.click(within(approval).getByRole("checkbox", { name: /确认已核对审计/ }));
    fireEvent.click(within(approval).getByRole("button", { name: "确认提交" }));

    await waitFor(() => expect(api.submitPublicationAssistedHandoff).toHaveBeenCalledOnce());
    expect(api.claimPublicationAssistedHandoff).not.toHaveBeenCalled();
  });

  it("submits one prepared handoff per account in a parallel publishing wave", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined || baseHandoff.bridgeServicePrincipalId === null) {
      throw new Error("Ctrip handoff fixture is incomplete");
    }
    const bridgePrincipalId = baseHandoff.bridgeServicePrincipalId;
    const first: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "draft_prepared",
      articleTitle: "首个账号草稿",
      draftEvidenceHash: "7".repeat(64),
      prepareOutcome: "prepared",
      prepareEvidenceKind: "browser",
      prepareEvidenceHash: "8".repeat(64),
      prepareObservedAt: "2026-07-14T08:01:00.000Z",
    };
    const second: PublicationAssistedHandoff = {
      ...first,
      id: "10000000-0000-4000-8000-000000001399",
      jobId: "10000000-0000-4000-8000-000000001398",
      channelAccountId: "10000000-0000-4000-8000-000000000702",
      articleTitle: "第二个账号草稿",
    };
    const sameAccountAlternate: PublicationAssistedHandoff = {
      ...first,
      id: "10000000-0000-4000-8000-000000001395",
      jobId: "10000000-0000-4000-8000-000000001394",
      articleTitle: "首个账号的另一篇草稿",
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request"],
      },
    });
    api.getChannelAccounts = async () => [
      {
        id: first.channelAccountId,
        platform: "ctrip_community",
        displayName: "携程账号 A",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
        evidenceType: "platform_readback",
        evidenceRefs: ["adapter:ctrip-community-browser-unattended-v1"],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
        dailyPublishQuota: 10,
        maxConcurrentPublications: 1,
        quotaTimezone: "Asia/Shanghai",
      },
      {
        id: second.channelAccountId,
        platform: "ctrip_community",
        displayName: "携程账号 B",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
        evidenceType: "platform_readback",
        evidenceRefs: ["adapter:ctrip-community-browser-unattended-v1"],
        status: "active",
        lastVerifiedAt: "2026-07-14T08:00:00.000Z",
        dailyPublishQuota: 10,
        maxConcurrentPublications: 1,
        quotaTimezone: "Asia/Shanghai",
      },
    ];
    api.getPublicationAssistedHandoffs = async () => [first, sameAccountAlternate, second];
    type SubmitResult = Awaited<ReturnType<typeof api.submitPublicationAssistedHandoff>>;
    const submissionResult = (
      handoff: PublicationAssistedHandoff,
      handoffId: string,
    ): SubmitResult => ({
      handoff: { ...handoff, state: "readback_pending" as const },
      bridge: {
        schemaVersion: "geo.ctrip-bridge.result.v1" as const,
        tenantId: session.tenant.id,
        handoffId,
        bridgePrincipalId,
        command: "submit" as const,
        outcome: "accepted" as const,
        evidenceKind: "browser" as const,
        state: "readback_pending" as const,
        receiptId: "10000000-0000-4000-8000-000000001396",
        readbackId: "10000000-0000-4000-8000-000000001397",
        adapterVersion: handoff.adapterVersion,
        observedAt: "2026-07-14T08:02:00.000Z",
        evidenceHash: "9".repeat(64),
      },
    });
    let resolveFirstSubmit: (value: SubmitResult) => void = () => undefined;
    let rejectSecondSubmit: (reason: Error) => void = () => undefined;
    const firstSubmit = new Promise<SubmitResult>((resolve) => {
      resolveFirstSubmit = resolve;
    });
    const secondSubmit = new Promise<SubmitResult>((_resolve, reject) => {
      rejectSecondSubmit = reject;
    });
    api.submitPublicationAssistedHandoff = vi.fn((handoffId) => {
      if (handoffId === first.id) return firstSubmit;
      if (handoffId === second.id) return secondSubmit;
      throw new Error(`Unexpected handoff ${handoffId}`);
    });

    renderApp({ path: "/publishing", api });

    fireEvent.click(await screen.findByLabelText(`选择交接单 ${first.id}`));
    fireEvent.click(screen.getByLabelText(`选择交接单 ${sameAccountAlternate.id}`));
    fireEvent.click(screen.getByLabelText(`选择交接单 ${second.id}`));
    fireEvent.click(screen.getByRole("button", { name: "多账号提交" }));
    const approval = await screen.findByRole("dialog", { name: "批准多账号提交" });
    expect(within(approval).getAllByText("2 个")).toHaveLength(2);
    fireEvent.click(within(approval).getByRole("checkbox", { name: /确认已核对全部账号/ }));
    fireEvent.click(within(approval).getByRole("button", { name: "并行提交" }));

    await waitFor(() => expect(api.submitPublicationAssistedHandoff).toHaveBeenCalledTimes(2));
    expect(api.submitPublicationAssistedHandoff).toHaveBeenCalledWith(first.id);
    expect(api.submitPublicationAssistedHandoff).toHaveBeenCalledWith(second.id);
    expect(api.submitPublicationAssistedHandoff).not.toHaveBeenCalledWith(sameAccountAlternate.id);

    resolveFirstSubmit(submissionResult(first, first.id));
    rejectSecondSubmit(new Error("second account unavailable"));
    expect(await screen.findByText("多账号提交已完成 1 / 2")).toBeInTheDocument();
    expect(
      screen.getByText("1 个账号操作未确认，已保留独立状态且不会自动重试。"),
    ).toBeInTheDocument();
    expect(api.submitPublicationAssistedHandoff).toHaveBeenCalledTimes(2);
  });

  it("offers reconciliation without retry after a Ctrip submit permit was consumed", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    if (baseHandoff.bridgeServicePrincipalId === null) {
      throw new Error("Ctrip bridge principal fixture is missing");
    }
    const bridgePrincipalId = baseHandoff.bridgeServicePrincipalId;
    const consumedHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "awaiting_operator_submit",
      submitPermitIssued: true,
      submitPermitConsumedAt: "2026-07-14T08:02:00.000Z",
      submitPermitIssuedByActorId: session.actor.id,
      submitPermitConsumedByPrincipalId: baseHandoff.bridgeServicePrincipalId,
    };
    api.getSession = async () => ({
      ...session,
      actor: {
        ...session.actor,
        capabilities: [...session.actor.capabilities, "publish:request", "publish:cancel"],
      },
    });
    api.getPublicationAssistedHandoffs = async () => [consumedHandoff];
    api.getPublicationAssistedHandoff = async () => consumedHandoff;
    api.readbackPublicationAssistedHandoff = vi.fn(
      async (): Promise<PublicationAssistedBridgeActionResult> => ({
        handoff: { ...consumedHandoff, state: "needs_review" as const },
        bridge: {
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: session.tenant.id,
          handoffId: consumedHandoff.id,
          bridgePrincipalId,
          command: "readback",
          outcome: "simulation_only",
          evidenceKind: "simulation",
          state: "needs_review",
          externalId: null,
          externalUrl: null,
          adapterVersion: consumedHandoff.adapterVersion,
          observedAt: "2026-07-14T08:03:00.000Z",
          evidenceHash: "9".repeat(64),
        },
      }),
    );
    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("许可已消费 · 禁止重试 · 等待对账")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准提交/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /取消交接单/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /执行携程社区回读/ }));
    await waitFor(() => expect(api.readbackPublicationAssistedHandoff).toHaveBeenCalledOnce());
  });

  it("labels a persisted Ctrip candidate target as unconfirmed", async () => {
    const api = liveApi();
    const [baseHandoff] = await api.getPublicationAssistedHandoffs();
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const candidateHandoff: PublicationAssistedHandoff = {
      ...baseHandoff,
      state: "readback_pending",
      submitOutcome: "accepted",
      submitEvidenceKind: "browser",
      submitObservedAt: "2026-07-14T08:02:00.000Z",
      submitCandidateExternalId: "ctrip-candidate-001",
      submitCandidateExternalUrl: "https://you.ctrip.com/travels/candidate-001.html",
    };
    api.getPublicationAssistedHandoffs = async () => [candidateHandoff];
    api.getPublicationAssistedHandoff = async () => candidateHandoff;

    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("候选 URL · 未确认")).toBeInTheDocument();
  });

  it("progressively expands the publishing queue and keeps the collapse control", async () => {
    const api = liveApi();
    const baseJob = (await api.getPublicationJobs())[0];
    if (baseJob === undefined) throw new Error("publication job fixture is missing");
    const jobs = Array.from({ length: 10 }, (_, index) => ({
      ...baseJob,
      id: `10000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      grantId: `20000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      auditArtifactId: `30000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      variantId: `40000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      createdAt: `2026-07-14T08:0${index % 10}:00.000Z`,
      updatedAt: `2026-07-14T08:0${index % 10}:01.000Z`,
    }));
    api.getPublicationJobs = async () => jobs;

    renderApp({ path: "/publishing", api });

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /查看作业 .* 详情/ })).toHaveLength(5),
    );
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" }));
    expect(screen.getAllByRole("button", { name: /查看作业 .* 详情/ })).toHaveLength(9);
    expect(screen.getByRole("button", { name: "展开全部 10 个投放作业" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起作业列表" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 10 个投放作业" }));
    expect(screen.getAllByRole("button", { name: /查看作业 .* 详情/ })).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "收起作业列表" }));
    expect(screen.getAllByRole("button", { name: /查看作业 .* 详情/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();
  });

  it("progressively expands the assisted handoff queue and keeps the collapse control", async () => {
    const api = liveApi();
    const baseHandoff = (await api.getPublicationAssistedHandoffs())[0];
    if (baseHandoff === undefined) throw new Error("Ctrip handoff fixture is missing");
    const handoffs = Array.from({ length: 10 }, (_, index) => ({
      ...baseHandoff,
      id: `10000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      jobId: `20000000-0000-4000-8000-00000000${String(index + 1).padStart(4, "0")}`,
      articleTitle: `交接单 ${index + 1}`,
      createdAt: `2026-07-14T08:0${index % 10}:00.000Z`,
      updatedAt: `2026-07-14T08:0${index % 10}:01.000Z`,
    }));
    api.getPublicationAssistedHandoffs = async () => handoffs;

    renderApp({ path: "/publishing", api });

    expect(await screen.findByText("交接单 5")).toBeInTheDocument();
    expect(screen.queryByText("交接单 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" }));
    expect(screen.getByText("交接单 9")).toBeInTheDocument();
    expect(screen.queryByText("交接单 10")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开全部 10 个交接单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起交接单列表" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 10 个交接单" }));
    expect(screen.getByText("交接单 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起交接单列表" }));
    expect(screen.queryByText("交接单 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开更多 4 个 · 剩余 5 个" })).toBeInTheDocument();
  });

  it("clears the selected publication job when the tenant changes", async () => {
    const api = liveApi();
    const otherSession: SessionSnapshot = {
      ...session,
      tenant: {
        id: "20000000-0000-4000-8000-000000000001",
        slug: "other-customer",
        displayName: "其他客户",
      },
    };
    api.getTenants = async () => [
      {
        id: session.tenant.id,
        slug: session.tenant.slug,
        displayName: session.tenant.displayName,
        role: "owner",
        status: "active",
      },
      {
        id: otherSession.tenant.id,
        slug: otherSession.tenant.slug,
        displayName: otherSession.tenant.displayName,
        role: "owner",
        status: "active",
      },
    ];
    api.switchTenant = async () => otherSession;
    renderApp({ path: "/publishing", api });

    fireEvent.click(await screen.findByRole("button", { name: /查看作业 .* 详情/ }));
    await screen.findByText(/作业详情 · 头条号/);
    const tenantSelect = screen.getByLabelText("工作空间");
    await waitFor(() => expect(tenantSelect).toBeEnabled());
    fireEvent.change(tenantSelect, { target: { value: otherSession.tenant.slug } });

    await screen.findByText("选择作业查看运行证据");
  });
});
