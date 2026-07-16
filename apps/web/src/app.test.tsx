import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTICLE_TEMPLATE_CATALOG_VERSION, ARTICLE_TEMPLATES } from "@geo/contracts";

import {
  type AutomationSnapshot,
  type BrandAgentProfile,
  type GeoApi,
  GeoApiError,
  type PublicationAssistedHandoff,
  type PublicationAssistedBridgeActionResult,
  type SessionSnapshot,
} from "./api.js";
import { App } from "./app.js";

afterEach(cleanup);

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
  },
  tenant: {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "zhongtong-international-travel",
    displayName: "中通国际旅行社",
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
        callToAction: "请通过 4001133986 或官方微信核验具体服务范围与条件。",
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
    controls: [],
    circuits: [],
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
    submitEvidenceHash: null,
    submitPermitIssued: false,
    submitPermitExpiresAt: null,
    submitPermitConsumedAt: null,
    submitPermitIssuedByActorId: null,
    submitPermitConsumedByPrincipalId: null,
    submitOutcome: null,
    submitEvidenceKind: null,
    submitObservedAt: null,
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
        prompt: "中通国际旅行社电话是多少",
        promptVersion: "1",
        locale: "zh-CN",
        geo: "CN",
        rawAnswer: "中通国际旅行社 24 小时热线为 4001133986。",
        citedUrls: ["https://example.test/zhongtong-contact"],
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
        value: "4001133986",
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
        displayName: "中通国旅-头条号-Dry Run",
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
        canonicalName: "Zhongtong International Travel Agency",
        displayName: "中通国际旅行社",
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
            prompt: "中通国际旅行社电话是多少",
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
      },
    ],
    createCampaign: async (input) => ({
      id: "10000000-0000-4000-8000-000000001002",
      ...input,
      status: "draft",
    }),
    transitionCampaignState: async () => {
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
    getContentVariants: async () => [],
    createContentVariant: async () => {
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
    getAutomationBatches: async () => [],
    getAutomationRuns: async () => [],
    getAutomationRun: async () => {
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

function renderApp(options: { path?: string; api?: GeoApi; demo?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? "/overview"]}>
      <App
        {...(options.api === undefined ? {} : { api: options.api })}
        initialMode={options.demo === true ? "demo" : "live"}
      />
    </MemoryRouter>,
  );
}

describe("GEO operator console", () => {
  it("keeps dry-run capability and fixture evidence visibly marked in explicit demo mode", () => {
    renderApp({ demo: true });

    expect(screen.getByText("三家平台当前均为 Dry-run / Manual only")).toBeInTheDocument();
    expect(screen.getByText("演示数据")).toBeInTheDocument();
    expect(screen.getAllByText(/Fixture/).length).toBeGreaterThan(0);
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

    fireEvent.click(screen.getByRole("button", { name: "新建 Campaign" }));
    fireEvent.change(screen.getByLabelText("Campaign 名称"), {
      target: { value: "东南亚亲子证据计划" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "泰国 / 亲子 / 暑期" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 Campaign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("东南亚亲子证据计划")).toBeInTheDocument();
    expect(screen.getByText("泰国 / 亲子 / 暑期")).toBeInTheDocument();
  });

  it("keeps global Campaign creation read-only without content:write", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("实时日本银发问答集");
    const createButton = await screen.findByRole("button", { name: "新建 Campaign" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", "需要 content:write 权限");
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
      };
    };
    renderApp({ api });

    const createButton = await screen.findByRole("button", { name: "新建 Campaign" });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    expect(screen.getByRole("option", { name: /中通国际旅行社 · 主品牌/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Campaign 名称"), {
      target: { value: "企业知识库可见性" },
    });
    fireEvent.change(screen.getByLabelText("主题范围"), {
      target: { value: "采购 / 决策 / 对比" },
    });
    fireEvent.change(screen.getByLabelText("行业"), {
      target: { value: "professional_services" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 Campaign" }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({
      brandId: "10000000-0000-4000-8000-000000000301",
      industry: "professional_services",
      name: "企业知识库可见性",
      topicKey: "采购 / 决策 / 对比",
    });
  });

  it("makes the demo kill switch state explicit", () => {
    renderApp({ demo: true });

    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));

    expect(screen.getByText("演示：全租户投放已停止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复 Shadow" })).toBeInTheDocument();
  });

  it("renders live API records and preserves visibility evidence dimensions", async () => {
    renderApp({ path: "/visibility", api: liveApi() });

    expect((await screen.findAllByText("web-search")).length).toBeGreaterThan(0);
    expect(screen.getByText("实时 API")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
    expect(screen.getAllByText("doubao-search-v1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("manual").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Manual import").length).toBeGreaterThan(0);
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
    expect(screen.queryByText(/4001133986/)).not.toBeInTheDocument();
  });

  it("renders the current tenant governance directory from tenant-scoped APIs", async () => {
    renderApp({ path: "/customers", api: liveApi() });

    await screen.findByText("当前租户治理目录");
    expect((await screen.findAllByText("owner@example.test")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("中通国际旅行社").length).toBeGreaterThan(0);
    expect(screen.getAllByText("travel-v1").length).toBeGreaterThan(0);
    expect(screen.getByText("Domestic AI discovery")).toBeInTheDocument();
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
      expect(within(screen.getByLabelText("Profile 当前版本")).getByText("v1")).toBeInTheDocument(),
    );
    expect(voice).toHaveValue("克制、清晰、证据优先；先回答问题，再解释依据与边界");

    fireEvent.change(voice, { target: { value: "直接回答，证据优先，明确适用边界" } });
    fireEvent.change(screen.getByLabelText("Profile 版本变更原因"), {
      target: { value: "收紧品牌表达边界" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() =>
      expect(within(screen.getByLabelText("Profile 当前版本")).getByText("v2")).toBeInTheDocument(),
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
      "需要 tenant:manage 权限",
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
    fireEvent.change(screen.getByLabelText("联系方式值"), { target: { value: "ZTGL6431" } });
    fireEvent.click(screen.getByRole("button", { name: "保存联系方式" }));

    await waitFor(() =>
      expect(submitted).toEqual({
        type: "wechat",
        label: "微信咨询",
        value: "ZTGL6431",
        isPrimary: false,
      }),
    );
  });

  it("shows live audit artifacts on the overview instead of an obsolete unsupported state", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("审计通过，没有阻断或警告。");
    expect(screen.queryByText("实时审计列表不可用")).not.toBeInTheDocument();
  });

  it("keeps the article workflow explicitly bounded to manual-only dry-runs", async () => {
    renderApp({ path: "/content", api: liveApi() });

    await screen.findByText("受治理运营链");
    expect(
      screen.getByText(/头条号、搜狐号、携程社区当前仅 manual_only \+ dry_run/),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("option", {
        name: /头条号 · 中通国旅-头条号-Dry Run · manual_only/,
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "创建 Dry-run 批次" })).toBeEnabled(),
    );
    expect(screen.getByText(/不执行外部发送/)).toBeInTheDocument();
    expect(screen.queryByText(/已真实发布/)).not.toBeInTheDocument();
    expect(batchReads).toBe(1);
    expect(runReads).toBe(1);
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
        name: `激活 Campaign ${initialCampaign.name}`,
      }),
    );
    fireEvent.change(screen.getByLabelText("Campaign 状态变更原因"), {
      target: { value: "核验事实与平台账号已就绪" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认激活" }));

    expect(await screen.findByRole("option", { name: initialCampaign.name })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "创建 Dry-run 批次" })).toBeEnabled(),
    );
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
    expect(screen.getByRole("button", { name: "创建 Dry-run 批次" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加槽位" })).toBeDisabled();
  });

  it("does not turn demo data into an automation run", () => {
    renderApp({ path: "/automation", demo: true });

    expect(screen.getByRole("heading", { level: 1, name: "自动化批次" })).toBeInTheDocument();
    expect(screen.getByText("离线演示不创建自动化批次")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建 Dry-run 批次" })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "进入演示模式" }));
    expect(screen.getByText("演示数据")).toBeInTheDocument();
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

  it("shows the first-release capability boundary without implying live providers", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    expect(await screen.findByText("第一版能力边界")).toBeInTheDocument();
    expect(screen.getByText("GEO 模板与规范草稿")).toBeInTheDocument();
    expect(screen.getByText("头条 / 搜狐 / 携程外部发布")).toBeInTheDocument();
    expect(screen.getByText("豆包 / 千问在线评测")).toBeInTheDocument();
    expect(screen.getByText("生产级图片生成")).toBeInTheDocument();
    expect(screen.getByText("品牌记忆正负反馈闭环")).toBeInTheDocument();
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
        },
        reason: "审计和 Dry-run 样本已完成复核",
      }),
    );
    await waitFor(() => expect(mode).toHaveValue("unattended"));
    expect(screen.getByText(/无人值守只调度已审计 Dry-run/)).toBeInTheDocument();
  });

  it("adds a scoped control and manually opens a circuit with API readback", async () => {
    renderApp({ path: "/settings", api: liveApi() });

    const addControl = await screen.findByRole("button", { name: "添加范围控制" });
    fireEvent.click(addControl);
    fireEvent.change(screen.getByLabelText("范围运行模式"), {
      target: { value: "paused" },
    });
    fireEvent.click(screen.getByLabelText("范围 Kill Switch"));
    fireEvent.change(screen.getByLabelText("范围控制变更原因"), {
      target: { value: "头条账号能力证据正在复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存范围控制" }));

    expect(await screen.findByText("platform:toutiao")).toBeInTheDocument();
    expect(screen.getByText("已急停")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "手动熔断" }));
    fireEvent.change(screen.getByLabelText("熔断处置原因"), {
      target: { value: "租户级风险信号等待人工复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认熔断" }));

    expect(await screen.findByText("tenant:*")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("shows a truthful empty state for a successful zero-row response", async () => {
    renderApp({ path: "/content", api: liveApi() });

    await screen.findByText("尚无文章；创建操作会同时生成 v1");
  });

  it("shows live Kill Switch state only after write and readback agree", async () => {
    renderApp({ api: liveApi() });

    await screen.findByText("当前租户 Kill Switch 关闭");
    fireEvent.click(screen.getByRole("button", { name: "立即停止" }));
    fireEvent.change(screen.getByLabelText("操作原因"), {
      target: { value: "联系方式异常，暂停当前租户投放" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));

    await screen.findByText("当前租户投放已暂停");
    expect(screen.getByRole("button", { name: "恢复 Shadow" })).toBeInTheDocument();
  });

  it("shows Ctrip assisted handoffs without exposing submit permit material", async () => {
    renderApp({ path: "/publishing", api: liveApi() });

    expect(await screen.findByText("携程人工交接")).toBeInTheDocument();
    expect(await screen.findByText("待交接")).toBeInTheDocument();
    expect(screen.getByText("未认领")).toBeInTheDocument();
    expect(screen.getByText("ctrip-community-web-v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /认领交接单/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取消交接单/ })).toBeDisabled();
    expect(document.body.textContent).not.toContain("submitPermitHash");
    expect(document.body.textContent).not.toContain("submit_permit");
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
    fireEvent.click(await screen.findByRole("button", { name: /准备携程草稿/ }));

    expect(await screen.findByText("草稿已准备")).toBeInTheDocument();
    expect(screen.getByText("Simulator")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /批准提交/ }));
    const approval = await screen.findByRole("dialog", { name: "批准携程提交" });
    expect(within(approval).getByText(/当前为 Simulator/)).toBeInTheDocument();
    fireEvent.click(within(approval).getByRole("checkbox", { name: /确认已核对审计/ }));
    fireEvent.click(within(approval).getByRole("button", { name: "确认提交" }));

    expect(await screen.findByText("等待公开回读")).toBeInTheDocument();
    expect(screen.getByText("模拟接受 · 未确认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /执行携程回读/ }));

    expect(await screen.findByText("需复核")).toBeInTheDocument();
    expect(screen.getByText("仅仿真证据 · 未产生真实发布")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("f".repeat(64));
    expect(document.body.textContent).not.toContain("submitPermit");
    expect(document.body.textContent).not.toContain("submit_permit");
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
    fireEvent.click(screen.getByRole("button", { name: /执行携程回读/ }));
    await waitFor(() => expect(api.readbackPublicationAssistedHandoff).toHaveBeenCalledOnce());
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
    const tenantSelect = screen.getByLabelText("当前会话租户");
    await waitFor(() => expect(tenantSelect).toBeEnabled());
    fireEvent.change(tenantSelect, { target: { value: otherSession.tenant.slug } });

    await screen.findByText("选择作业查看运行证据");
  });
});
