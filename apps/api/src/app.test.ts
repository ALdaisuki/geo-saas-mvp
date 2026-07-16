import { capabilitiesForRole } from "@geo/authz";
import type {
  AuditArtifact,
  PublicationVariantPayload,
  TenantContact,
  TenantRole,
} from "@geo/contracts";
import {
  buildBaselineAuditPolicyDocument,
  compileAuditPolicy,
  renderEditorialSourcePayload,
  sha256Canonical,
  sha256Text,
  type FactSnapshot,
} from "@geo/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildApp,
  GEO_API_VERSION,
  type PasswordService,
  type PublicationGovernanceGate,
} from "./app.js";
import type { AgentRunGateway, AgentRunRequest } from "./agent-run-gateway.js";
import type { CtripBridgeGateway } from "./ctrip-bridge-gateway.js";
import type {
  AutomationBatchView,
  AutomationRunView,
  CreateAutomationBatchInput,
} from "./automation-repository.js";
import type {
  ManualPublicationPackageSource,
  RecordManualPublicationPackageExportInput,
} from "./manual-publication-package.js";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApiRepository,
  type AutomationControlView,
  type AutomationStatusView,
  type AuditContextRecord,
  type CreateSessionInput,
  type LoginIdentity,
  type PersistAuditInput,
  type PublicationGovernanceAuditInput,
  type PublicationGovernanceContext,
  type PublicationAssistedHandoffView,
  type PublicationJobView,
  type PublicationRequestInput,
  type RequestContext,
  type ResolveSessionInput,
  type ResolvedSession,
} from "./repository.js";
import type {
  MediaProductionController,
  MediaProductionRequest,
} from "./media-production-service.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "20000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000101",
  phone: "10000000-0000-4000-8000-000000000401",
  wechatOne: "10000000-0000-4000-8000-000000000402",
  wechatTwo: "10000000-0000-4000-8000-000000000403",
  source: "10000000-0000-4000-8000-000000000501",
  fact: "10000000-0000-4000-8000-000000000502",
  content: "10000000-0000-4000-8000-000000000601",
  version: "10000000-0000-4000-8000-000000000602",
  variant: "10000000-0000-4000-8000-000000000603",
  account: "10000000-0000-4000-8000-000000000701",
  automationBatch: "10000000-0000-4000-8000-000000000711",
  automationRun: "10000000-0000-4000-8000-000000000712",
  automationTarget: "10000000-0000-4000-8000-000000000713",
  assistedHandoff: "10000000-0000-4000-8000-000000000714",
  policy: "10000000-0000-4000-8000-000000000801",
  brand: "10000000-0000-4000-8000-000000000901",
};

const fixedNow = new Date("2026-07-14T01:00:00.000Z");
const tokenValue = "test-token-value-that-is-longer-than-thirty-two-bytes";
const travelPolicyDocument = buildBaselineAuditPolicyDocument({
  rulesVersion: "travel-v1",
  industry: "travel",
});
const travelPolicyHash = sha256Canonical(travelPolicyDocument);
const travelPolicy = compileAuditPolicy({
  version: travelPolicyDocument.rulesVersion,
  policyHash: travelPolicyHash,
  document: travelPolicyDocument,
});

const contacts: readonly TenantContact[] = [
  {
    id: ids.phone,
    tenantId: ids.tenant,
    type: "phone",
    label: "24-hour hotline",
    value: "4001133986",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: ids.wechatOne,
    tenantId: ids.tenant,
    type: "wechat",
    label: "WeChat one",
    value: "ZTGL3411",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: ids.wechatTwo,
    tenantId: ids.tenant,
    type: "wechat",
    label: "WeChat two",
    value: "ZTGL6431",
    isPrimary: false,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
];

const articleFactSnapshot: FactSnapshot = {
  tenantId: ids.tenant,
  capturedAt: fixedNow.toISOString(),
  facts: [
    {
      id: ids.fact,
      brandId: ids.brand,
      text: "The signed itinerary is the final service boundary",
      evidenceSourceIds: [ids.source],
      validFrom: "2026-07-13T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
  sources: [
    {
      id: ids.source,
      locator: "https://example.test/current-itinerary",
      contentHash: "c".repeat(64),
      observedAt: "2026-07-13T01:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const articlePayload: PublicationVariantPayload = renderEditorialSourcePayload({
  editorialProfile: "guide",
  policy: travelPolicy,
  factSnapshot: articleFactSnapshot,
  contacts,
});

function identity(role: TenantRole): LoginIdentity {
  return {
    userId: ids.actor,
    email: "owner@example.test",
    passwordHash: "correct-hash",
    displayName: "Test Owner",
    status: "active",
    memberships: [
      {
        tenantId: ids.tenant,
        tenantSlug: "zhongtong",
        tenantDisplayName: "Zhongtong International Travel",
        tenantStatus: "active",
        role,
        capabilities: capabilitiesForRole(role),
        membershipStatus: "active",
      },
    ],
  };
}

class FakeRepository implements ApiRepository {
  readonly sessions = new Map<string, CreateSessionInput>();
  readonly persistedAudits: PersistAuditInput[] = [];
  readonly auditIdempotency = new Map<
    string,
    { readonly requestHash: string; readonly input: PersistAuditInput }
  >();
  readonly publicationRequests: PublicationRequestInput[] = [];
  readonly publicationReplayRequests: Parameters<ApiRepository["resolvePublicationReplay"]>[1][] =
    [];
  readonly publicationRevocations: Parameters<ApiRepository["revokePublicationGrant"]>[1][] = [];
  readonly publicationCancellations: Parameters<ApiRepository["cancelPublicationJob"]>[1][] = [];
  readonly assistedHandoffClaims: Parameters<
    ApiRepository["claimPublicationAssistedHandoff"]
  >[1][] = [];
  readonly assistedHandoffHeartbeats: Parameters<
    ApiRepository["heartbeatPublicationAssistedHandoff"]
  >[1][] = [];
  readonly assistedHandoffCancellations: Parameters<
    ApiRepository["cancelPublicationAssistedHandoff"]
  >[1][] = [];
  readonly assistedHandoffPermitIssues: string[] = [];
  readonly governanceDecisions: PublicationGovernanceAuditInput[] = [];
  readonly manualPublicationPackageExports: RecordManualPublicationPackageExportInput[] = [];
  readonly evidenceSourceInputs: Parameters<ApiRepository["createEvidenceSource"]>[1][] = [];
  readonly factInputs: Parameters<ApiRepository["createFact"]>[1][] = [];
  readonly contentInputs: Parameters<ApiRepository["createContent"]>[1][] = [];
  readonly contentIdempotency = new Map<
    string,
    {
      readonly requestHash: string;
      readonly content: Awaited<ReturnType<ApiRepository["createContent"]>>;
    }
  >();
  readonly contentVersionInputs: Parameters<ApiRepository["createContentVersion"]>[1][] = [];
  readonly variantInputs: Parameters<ApiRepository["createVariant"]>[1][] = [];
  readonly mediaJobs = new Map<string, Awaited<ReturnType<ApiRepository["createMediaJob"]>>>();
  readonly mediaJobIdempotency = new Map<string, string>();
  readonly mediaAttempts: Parameters<ApiRepository["recordMediaAttempt"]>[1][] = [];
  readonly mediaAssets = new Map<string, Awaited<ReturnType<ApiRepository["completeMediaJob"]>>>();
  readonly visibilityRuns: Parameters<ApiRepository["persistVisibilityRun"]>[1][] = [];
  readonly brandInputs: Parameters<ApiRepository["createBrand"]>[1][] = [];
  readonly brandAgentProfileInputs: Parameters<ApiRepository["createBrandAgentProfile"]>[1][] = [];
  readonly policyInputs: Parameters<ApiRepository["createPolicyBundle"]>[1][] = [];
  readonly memberCreateInputs: Parameters<ApiRepository["createMember"]>[1][] = [];
  readonly memberUpdateInputs: Parameters<ApiRepository["updateMember"]>[1][] = [];
  readonly policyTransitionInputs: Parameters<ApiRepository["transitionPolicyBundle"]>[1][] = [];
  readonly contactCreateInputs: Parameters<ApiRepository["createContact"]>[1][] = [];
  readonly contactExpireInputs: Parameters<ApiRepository["expireContact"]>[1][] = [];
  readonly channelAccountCreateInputs: Parameters<ApiRepository["createChannelAccount"]>[1][] = [];
  readonly channelAccountUpdateInputs: Parameters<ApiRepository["updateChannelAccount"]>[1][] = [];
  readonly servicePrincipalCreateInputs: Parameters<
    ApiRepository["createAutomationServicePrincipal"]
  >[1][] = [];
  readonly ctripBridgePrincipalCreateInputs: Parameters<
    ApiRepository["createCtripBridgeServicePrincipal"]
  >[1][] = [];
  readonly servicePrincipalStatusInputs: Parameters<
    ApiRepository["setServicePrincipalStatus"]
  >[1][] = [];
  readonly querySetInputs: Parameters<ApiRepository["createQuerySet"]>[1][] = [];
  readonly querySetVersionInputs: Parameters<ApiRepository["createQuerySetVersion"]>[1][] = [];
  readonly querySetActivationInputs: Parameters<ApiRepository["activateQuerySetVersion"]>[1][] = [];
  readonly querySetTransitionInputs: Parameters<ApiRepository["transitionQuerySet"]>[1][] = [];
  readonly automationControlInputs: Parameters<ApiRepository["setTenantAutomationControl"]>[1][] =
    [];
  readonly scopedAutomationControlInputs: Parameters<
    ApiRepository["setScopedAutomationControl"]
  >[1][] = [];
  readonly circuitStateInputs: Parameters<ApiRepository["setCircuitBreakerState"]>[1][] = [];
  readonly automationBatchInputs: CreateAutomationBatchInput[] = [];
  readonly automationClaimInputs: Parameters<ApiRepository["claimAutomationRuns"]>[1][] = [];
  readonly automationHeartbeatInputs: Parameters<ApiRepository["heartbeatAutomationRun"]>[1][] = [];
  readonly automationDraftCheckpoints: Parameters<ApiRepository["checkpointAutomationDraft"]>[1][] =
    [];
  readonly automationTargetCheckpoints: Parameters<
    ApiRepository["checkpointAutomationTarget"]
  >[1][] = [];
  readonly campaignTransitionInputs: Parameters<ApiRepository["transitionCampaign"]>[1][] = [];
  automationControl: AutomationControlView = {
    id: "10000000-0000-4000-8000-000000000951",
    scopeType: "tenant",
    scopeKey: "*",
    mode: "shadow",
    killSwitchEnabled: false,
    reason: null as string | null,
    quota: { dailyPublications: 0, dryRunOnly: true },
    updatedAt: fixedNow.toISOString(),
  };
  automationCircuits: AutomationStatusView["circuits"] = [];
  lastContext: RequestContext | null = null;
  loginIdentity: LoginIdentity | null;
  auditPayload: PublicationVariantPayload = articlePayload;
  auditPolicyHash = travelPolicyHash;
  auditPolicyDocument: unknown = travelPolicyDocument;
  publicationJobState: PublicationJobView["state"] = "queued";
  assistedHandoffState: PublicationAssistedHandoffView["state"] = "handoff_pending";
  assistedHandoffLeaseOwner: string | null = null;
  assistedSubmitPermitConsumedAt: string | null = null;
  publicationRequestError: (Error & { code?: string }) | null = null;
  publicationGovernancePlatform: AuditArtifact["platform"] = "toutiao";
  publicationReplayResult: Awaited<ReturnType<ApiRepository["resolvePublicationReplay"]>> = null;
  automationBatchState: AutomationBatchView["state"] = "scheduled";
  campaign: Awaited<ReturnType<ApiRepository["createCampaign"]>> | null = null;

  constructor(role: TenantRole = "owner") {
    this.loginIdentity = identity(role);
  }

  async isReady() {
    return true;
  }

  async findLoginIdentity() {
    return this.loginIdentity;
  }

  async findLoginIdentityByUserId() {
    return this.loginIdentity;
  }

  async createSession(input: CreateSessionInput) {
    this.sessions.set(input.sessionId, input);
  }

  async resolveSession(input: ResolveSessionInput): Promise<ResolvedSession | null> {
    this.lastContext = input;
    const stored = this.sessions.get(input.sessionId);
    if (
      stored === undefined ||
      stored.actorId !== input.actorId ||
      stored.tenantId !== input.tenantId ||
      stored.tokenHash !== input.tokenHash
    ) {
      return null;
    }
    return {
      sessionId: stored.sessionId,
      userId: stored.actorId,
      userDisplayName: "Test Owner",
      tenantId: stored.tenantId,
      tenantSlug: "zhongtong",
      tenantDisplayName: "Zhongtong International Travel",
      role: this.loginIdentity?.memberships[0]?.role ?? "viewer",
      capabilities: this.loginIdentity?.memberships[0]?.capabilities ?? [],
      csrfHash: stored.csrfHash,
      expiresAt: stored.expiresAt,
    };
  }

  async revokeSession(_context: RequestContext, sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async getTenant(context: RequestContext) {
    this.lastContext = context;
    return {
      id: context.tenantId,
      slug: "zhongtong",
      displayName: "Zhongtong International Travel",
      legalName: "Zhongtong International Travel",
      industry: "travel",
      status: "active",
      defaultLocale: "zh-CN",
    };
  }

  async listBrands() {
    return [
      {
        id: ids.brand,
        canonicalName: "Zhongtong International Travel Agency",
        displayName: "中通国际旅行社",
        aliases: ["中通国旅"],
        description: "首个旅行行业 GEO 租户",
        industry: "travel",
        websiteUrl: null,
        isPrimary: true,
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
    ];
  }

  async createBrand(_context: RequestContext, input: Parameters<ApiRepository["createBrand"]>[1]) {
    this.brandInputs.push(input);
    return {
      ...input,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  async listBrandAgentProfiles() {
    return [];
  }

  async getBrandAgentProfile() {
    return null;
  }

  async createBrandAgentProfile(
    _context: RequestContext,
    input: Parameters<ApiRepository["createBrandAgentProfile"]>[1],
  ) {
    this.brandAgentProfileInputs.push(input);
    return {
      id: input.id,
      brandId: input.brandId,
      version: this.brandAgentProfileInputs.length,
      status: "active" as const,
      document: input.document,
      documentHash: input.documentHash,
      effectiveAt: input.effectiveAt,
      retiredAt: null,
      createdAt: input.effectiveAt,
    };
  }

  async listMembers() {
    return [
      {
        id: "10000000-0000-4000-8000-000000000102",
        userId: ids.actor,
        email: "owner@example.test",
        displayName: "Test Owner",
        role: "owner" as const,
        capabilities: capabilitiesForRole("owner"),
        status: "active" as const,
        createdAt: fixedNow.toISOString(),
      },
    ];
  }

  async createMember(
    _context: RequestContext,
    input: Parameters<ApiRepository["createMember"]>[1],
  ) {
    this.memberCreateInputs.push(input);
    return {
      id: input.membershipId,
      userId: input.userId,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      capabilities: capabilitiesForRole(input.role),
      status: "active" as const,
      createdAt: fixedNow.toISOString(),
    };
  }

  async updateMember(
    _context: RequestContext,
    input: Parameters<ApiRepository["updateMember"]>[1],
  ) {
    this.memberUpdateInputs.push(input);
    return {
      id: input.membershipId,
      userId: ids.actor,
      email: "owner@example.test",
      displayName: "Test Owner",
      role: input.role ?? "owner",
      capabilities: capabilitiesForRole(input.role ?? "owner"),
      status: input.status ?? ("active" as const),
      createdAt: fixedNow.toISOString(),
    };
  }

  async listPolicyBundles() {
    return [
      {
        id: ids.policy,
        version: "travel-v1",
        status: "active" as const,
        policyHash: travelPolicyHash,
        document: travelPolicyDocument,
        effectiveAt: fixedNow.toISOString(),
        retiredAt: null,
        createdAt: fixedNow.toISOString(),
      },
    ];
  }

  async createPolicyBundle(
    _context: RequestContext,
    input: Parameters<ApiRepository["createPolicyBundle"]>[1],
  ) {
    this.policyInputs.push(input);
    return {
      id: input.id,
      version: input.version,
      status: "draft" as const,
      policyHash: input.policyHash,
      document: input.document,
      effectiveAt: input.effectiveAt,
      retiredAt: null,
      createdAt: fixedNow.toISOString(),
    };
  }

  async transitionPolicyBundle(
    _context: RequestContext,
    input: Parameters<ApiRepository["transitionPolicyBundle"]>[1],
  ) {
    this.policyTransitionInputs.push(input);
    return {
      policy: {
        id: input.policyBundleId,
        version: "travel-v2",
        status: input.targetStatus,
        policyHash: travelPolicyHash,
        document: travelPolicyDocument,
        effectiveAt: input.changedAt,
        retiredAt: input.targetStatus === "retired" ? input.changedAt : null,
        createdAt: fixedNow.toISOString(),
      },
      previousStatus: input.targetStatus === "active" ? ("draft" as const) : ("active" as const),
      wasChanged: true,
    };
  }

  async listQuerySets() {
    return [
      {
        id: "10000000-0000-4000-8000-000000000910",
        name: "Domestic AI discovery",
        industry: "travel",
        status: "active" as const,
        currentVersion: 1,
        description: "Separate Doubao and Qwen evidence prompts",
        currentVersionId: ids.version,
        prompts: [{ key: "contact", category: "contact", prompt: "中通联系方式" }],
        promptHash: "d".repeat(64),
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
    ];
  }

  async createQuerySet(
    _context: RequestContext,
    input: Parameters<ApiRepository["createQuerySet"]>[1],
  ) {
    this.querySetInputs.push(input);
    return {
      id: input.querySetId,
      name: input.name,
      industry: input.industry,
      status: "draft" as const,
      currentVersion: 1,
      description: input.description,
      currentVersionId: input.versionId,
      prompts: input.prompts,
      promptHash: input.promptHash,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  async listQuerySetVersions(_context: RequestContext, querySetId: string) {
    return [
      {
        id: ids.version,
        querySetId,
        version: 1,
        prompts: [{ key: "contact", category: "contact", prompt: "中通联系方式" }],
        promptHash: "d".repeat(64),
        createdByActorId: ids.actor,
        createdAt: fixedNow.toISOString(),
      },
    ];
  }

  async createQuerySetVersion(
    _context: RequestContext,
    input: Parameters<ApiRepository["createQuerySetVersion"]>[1],
  ) {
    this.querySetVersionInputs.push(input);
    return {
      id: input.versionId,
      querySetId: input.querySetId,
      version: 2,
      prompts: input.prompts,
      promptHash: input.promptHash,
      createdByActorId: ids.actor,
      createdAt: fixedNow.toISOString(),
    };
  }

  async activateQuerySetVersion(
    _context: RequestContext,
    input: Parameters<ApiRepository["activateQuerySetVersion"]>[1],
  ) {
    this.querySetActivationInputs.push(input);
    const [querySet] = await this.listQuerySets();
    if (querySet === undefined) throw new Error("Fake query set fixture is missing");
    return {
      querySet: {
        ...querySet,
        status: "active" as const,
        currentVersion: 2,
        currentVersionId: input.versionId,
      },
      previousVersion: 1,
      previousStatus: "active" as const,
      wasChanged: true,
    };
  }

  async transitionQuerySet(
    _context: RequestContext,
    input: Parameters<ApiRepository["transitionQuerySet"]>[1],
  ) {
    this.querySetTransitionInputs.push(input);
    const [querySet] = await this.listQuerySets();
    if (querySet === undefined) throw new Error("Fake query set fixture is missing");
    return {
      querySet: {
        ...querySet,
        status: input.targetStatus,
      },
      previousStatus: "active" as const,
      wasChanged: true,
    };
  }

  async getAutomationStatus() {
    return {
      control: this.automationControl,
      controls: [this.automationControl],
      circuits: this.automationCircuits,
    };
  }

  async setTenantAutomationControl(
    _context: RequestContext,
    input: Parameters<ApiRepository["setTenantAutomationControl"]>[1],
  ) {
    this.automationControlInputs.push(input);
    this.automationControl = {
      ...this.automationControl,
      mode: input.mode,
      quota: { ...input.quota },
      reason: input.reason,
    };
    return this.automationControl;
  }

  async setTenantKillSwitch(
    _context: RequestContext,
    input: Parameters<ApiRepository["setTenantKillSwitch"]>[1],
  ) {
    this.automationControl = {
      ...this.automationControl,
      killSwitchEnabled: input.enabled,
      reason: input.reason,
    };
    return this.automationControl;
  }

  async setScopedAutomationControl(
    _context: RequestContext,
    input: Parameters<ApiRepository["setScopedAutomationControl"]>[1],
  ) {
    this.scopedAutomationControlInputs.push(input);
    return {
      id: input.controlId,
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      mode: input.mode,
      killSwitchEnabled: input.killSwitchEnabled,
      reason: input.reason,
      quota: { ...input.quota },
      updatedAt: fixedNow.toISOString(),
    };
  }

  async setCircuitBreakerState(
    _context: RequestContext,
    input: Parameters<ApiRepository["setCircuitBreakerState"]>[1],
  ) {
    this.circuitStateInputs.push(input);
    const circuit = {
      id: input.circuitId,
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      state: input.targetState,
      failureCount: input.targetState === "open" ? 1 : 0,
      openedAt: input.targetState === "open" ? fixedNow.toISOString() : null,
      retryAt: input.targetState === "open" ? input.retryAt : null,
      reason: input.reason,
      updatedAt: fixedNow.toISOString(),
    };
    this.automationCircuits = [circuit];
    return circuit;
  }

  async createAutomationBatch(
    _context: RequestContext,
    input: Parameters<ApiRepository["createAutomationBatch"]>[1],
  ) {
    this.automationBatchInputs.push(input);
    return { batch: this.automationBatch(input), wasCreated: true };
  }

  async listAutomationBatches() {
    const input = this.automationBatchInputs[0];
    return input === undefined ? [] : [this.automationBatch(input)];
  }

  async getAutomationRun(_context: RequestContext, runId: string) {
    const input = this.automationBatchInputs[0];
    if (input === undefined || input.runs[0]?.runId !== runId) return null;
    return this.automationRun(input);
  }

  async listAutomationRuns() {
    const input = this.automationBatchInputs[0];
    return input === undefined ? [] : [this.automationRun(input)];
  }

  async claimAutomationRuns(
    _context: RequestContext,
    claimInput: Parameters<ApiRepository["claimAutomationRuns"]>[1],
  ) {
    this.automationClaimInputs.push(claimInput);
    const input = this.automationBatchInputs[0];
    if (input === undefined) return [];
    return [
      {
        ...this.automationRun(input),
        state: "running" as const,
        attemptCount: 1,
        leaseOwner: `${ids.actor}:producer-1`,
        leaseExpiresAt: "2026-07-14T01:01:00.000Z",
        tenantGate: { allowed: true as const, evaluatedAt: fixedNow.toISOString() },
      },
    ];
  }

  async heartbeatAutomationRun(
    _context: RequestContext,
    input: Parameters<ApiRepository["heartbeatAutomationRun"]>[1],
  ) {
    this.automationHeartbeatInputs.push(input);
    return {
      accepted: true,
      reason: "accepted",
      leaseExpiresAt: "2026-07-14T01:01:00.000Z",
    };
  }

  async checkpointAutomationDraft(
    _context: RequestContext,
    input: Parameters<ApiRepository["checkpointAutomationDraft"]>[1],
  ) {
    this.automationDraftCheckpoints.push(input);
    return {
      accepted: true,
      reason: "accepted",
      leaseExpiresAt: "2026-07-14T01:01:00.000Z",
    };
  }

  async checkpointAutomationTarget(
    _context: RequestContext,
    input: Parameters<ApiRepository["checkpointAutomationTarget"]>[1],
  ) {
    this.automationTargetCheckpoints.push(input);
    return {
      accepted: true,
      reason: "accepted",
      leaseExpiresAt: "2026-07-14T01:01:00.000Z",
    };
  }

  async reconcileAutomationRun() {
    const input = this.automationBatchInputs[0];
    if (input === undefined) throw new RepositoryConflictError("Automation run was not found");
    return { ...this.automationRun(input), state: "completed" as const };
  }

  async cancelAutomationBatch(_context: RequestContext, batchId: string) {
    this.automationBatchState = "cancelled";
    return {
      batchId,
      state: "cancelled" as const,
      cancelledRuns: 1,
      cancelledTargets: 1,
      wasChanged: true,
    };
  }

  private automationBatch(input: CreateAutomationBatchInput): AutomationBatchView {
    return {
      id: input.batchId,
      campaignId: input.campaignId,
      name: input.name,
      state: this.automationBatchState,
      executionLevel: "dry_run",
      scheduledFor: input.runs[0]?.availableAt ?? fixedNow.toISOString(),
      runCount: input.runs.length,
      completedRunCount: 0,
      failedRunCount: 0,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  private automationRun(input: CreateAutomationBatchInput): AutomationRunView {
    const run = input.runs[0];
    const target = run?.targets[0];
    if (run === undefined || target === undefined) {
      throw new RepositoryConflictError("Automation fixture requires one run and target");
    }
    return {
      id: run.runId,
      batchId: input.batchId,
      campaignId: input.campaignId,
      brandId: ids.brand,
      slotKey: run.slotKey,
      topicKey: run.topicKey,
      brief: run.brief,
      state: "scheduled",
      stage: "planning",
      availableAt: run.availableAt,
      attemptCount: 0,
      maxAttempts: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      checkpoint: {},
      contentItemId: null,
      contentVersionId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      targets: [
        {
          id: target.targetId,
          runId: run.runId,
          channelAccountId: target.channelAccountId,
          platform: "toutiao",
          state: "pending",
          variantId: null,
          auditRunId: null,
          auditArtifactId: null,
          publicationJobId: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          completedAt: null,
          createdAt: fixedNow.toISOString(),
          updatedAt: fixedNow.toISOString(),
        },
      ],
    };
  }

  async listContacts(context: RequestContext) {
    this.lastContext = context;
    return contacts;
  }

  async createContact(
    _context: RequestContext,
    input: Parameters<ApiRepository["createContact"]>[1],
  ) {
    this.contactCreateInputs.push(input);
    return {
      id: input.id,
      tenantId: ids.tenant,
      type: input.type,
      label: input.label,
      value: input.value,
      isPrimary: input.isPrimary,
      validFrom: input.validFrom,
      validUntil: null,
    };
  }

  async expireContact(
    _context: RequestContext,
    input: Parameters<ApiRepository["expireContact"]>[1],
  ) {
    this.contactExpireInputs.push(input);
    const existing = contacts.find((contact) => contact.id === input.contactId) ?? contacts[0];
    if (existing === undefined) throw new RepositoryNotFoundError("Contact was not found");
    return { ...existing, validUntil: input.validUntil };
  }

  async listChannelAccounts(context: RequestContext) {
    this.lastContext = context;
    return [
      {
        id: ids.account,
        platform: "toutiao" as const,
        displayName: "Toutiao dry run",
        capability: "manual_only" as const,
        supportedExecutionLevels: ["dry_run" as const],
        evidenceType: "preview" as const,
        evidenceRefs: ["fixture:dry-run-only"],
        status: "active",
        lastVerifiedAt: null,
      },
    ];
  }

  async createChannelAccount(
    _context: RequestContext,
    input: Parameters<ApiRepository["createChannelAccount"]>[1],
  ) {
    this.channelAccountCreateInputs.push(input);
    return {
      id: input.id,
      platform: input.platform,
      displayName: input.displayName,
      capability: input.capability,
      supportedExecutionLevels: input.supportedExecutionLevels,
      evidenceType: input.evidenceType,
      evidenceRefs: input.evidenceRefs,
      status: input.status,
      lastVerifiedAt: input.lastVerifiedAt,
    };
  }

  async updateChannelAccount(
    _context: RequestContext,
    input: Parameters<ApiRepository["updateChannelAccount"]>[1],
  ) {
    this.channelAccountUpdateInputs.push(input);
    return {
      id: input.channelAccountId,
      platform: "toutiao" as const,
      displayName: input.displayName ?? "Toutiao dry run",
      capability: input.capability ?? ("manual_only" as const),
      supportedExecutionLevels: input.supportedExecutionLevels ?? (["dry_run"] as const),
      evidenceType: input.evidenceType ?? ("preview" as const),
      evidenceRefs: input.evidenceRefs ?? ["fixture:dry-run-only"],
      status: input.status ?? "active",
      lastVerifiedAt: input.lastVerifiedAt === undefined ? null : input.lastVerifiedAt,
    };
  }

  async listServicePrincipals(context: RequestContext) {
    return [
      {
        id: "10000000-0000-4000-8000-000000000801",
        tenantId: context.tenantId,
        name: "producer-zhongtong",
        kind: "agent" as const,
        profile: "automation_producer" as const,
        capabilities: ["automation:execute" as const],
        status: "active" as const,
        credentialStatus: "not_issued" as const,
        lastUsedAt: null,
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
    ];
  }

  async createAutomationServicePrincipal(
    context: RequestContext,
    input: Parameters<ApiRepository["createAutomationServicePrincipal"]>[1],
  ) {
    this.servicePrincipalCreateInputs.push(input);
    return {
      id: input.id,
      tenantId: context.tenantId,
      name: input.name,
      kind: "agent" as const,
      profile: "automation_producer" as const,
      capabilities: [
        "tenant:read" as const,
        "content:read" as const,
        "content:write" as const,
        "audit:read" as const,
        "audit:run" as const,
        "publish:request" as const,
        "receipt:read" as const,
        "automation:execute" as const,
      ],
      status: "active" as const,
      credentialStatus: "not_issued" as const,
      lastUsedAt: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  async createCtripBridgeServicePrincipal(
    context: RequestContext,
    input: Parameters<ApiRepository["createCtripBridgeServicePrincipal"]>[1],
  ) {
    this.ctripBridgePrincipalCreateInputs.push(input);
    return {
      id: input.id,
      tenantId: context.tenantId,
      name: input.name,
      kind: "integration" as const,
      profile: "ctrip_bridge" as const,
      capabilities: ["tenant:read" as const, "content:read" as const, "publish:bridge" as const],
      status: "active" as const,
      credentialStatus: "not_issued" as const,
      lastUsedAt: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  async setServicePrincipalStatus(
    context: RequestContext,
    input: Parameters<ApiRepository["setServicePrincipalStatus"]>[1],
  ) {
    this.servicePrincipalStatusInputs.push(input);
    return {
      principal: {
        id: input.servicePrincipalId,
        tenantId: context.tenantId,
        name: "producer-zhongtong",
        kind: "agent" as const,
        profile: "automation_producer" as const,
        capabilities: ["automation:execute" as const],
        status: input.status,
        credentialStatus: "not_issued" as const,
        lastUsedAt: null,
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
      wasChanged: true,
    };
  }

  async listEvidenceSources() {
    return [];
  }

  async createEvidenceSource(
    _context: RequestContext,
    input: Parameters<ApiRepository["createEvidenceSource"]>[1],
  ) {
    this.evidenceSourceInputs.push(input);
    return {
      id: input.id,
      type: input.type,
      title: input.title,
      sourceUrl: input.sourceUrl,
      contentHash: input.contentHash,
      capturedAt: input.capturedAt,
      validUntil: input.validUntil,
      metadata: input.metadata,
    };
  }

  async listFacts() {
    return articleFactSnapshot.facts.map((fact) => ({
      id: fact.id,
      brandId: fact.brandId,
      normalizedKey: "service.boundary",
      claim: fact.text,
      status: "verified" as const,
      evidenceSourceIds: fact.evidenceSourceIds,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
    }));
  }

  async createFact(_context: RequestContext, input: Parameters<ApiRepository["createFact"]>[1]) {
    this.factInputs.push(input);
    return input;
  }

  async checkResourceScope(
    _context: RequestContext,
    resources: Parameters<ApiRepository["checkResourceScope"]>[1],
  ) {
    return { allowed: true, denied: resources.slice(0, 0) };
  }

  async listCampaigns() {
    return [];
  }

  async createCampaign(
    _context: RequestContext,
    input: Parameters<ApiRepository["createCampaign"]>[1],
  ) {
    this.campaign = { ...input, status: "draft" };
    return this.campaign;
  }

  async transitionCampaign(
    _context: RequestContext,
    input: Parameters<ApiRepository["transitionCampaign"]>[1],
  ): ReturnType<ApiRepository["transitionCampaign"]> {
    this.campaignTransitionInputs.push(input);
    const current = this.campaign;
    if (current === null || current.id !== input.campaignId) {
      throw new RepositoryNotFoundError("Campaign was not found");
    }
    if (current.status === input.targetStatus) {
      return Promise.resolve({
        campaign: current,
        previousStatus: current.status,
        wasChanged: false,
      });
    }
    const allowed =
      (input.targetStatus === "active" &&
        (current.status === "draft" || current.status === "paused")) ||
      (input.targetStatus === "paused" && current.status === "active") ||
      (input.targetStatus === "completed" &&
        (current.status === "active" || current.status === "paused"));
    if (!allowed) {
      throw new RepositoryConflictError(
        `Campaign cannot transition from ${current.status} to ${input.targetStatus}`,
      );
    }
    const updated = { ...current, status: input.targetStatus };
    this.campaign = updated;
    return Promise.resolve({ campaign: updated, previousStatus: current.status, wasChanged: true });
  }

  async listContent() {
    return [];
  }

  async createContent(
    _context: RequestContext,
    input: Parameters<ApiRepository["createContent"]>[1],
  ) {
    this.contentInputs.push(input);
    const existing = this.contentIdempotency.get(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) {
        throw new RepositoryConflictError("Content idempotency key conflicts with another request");
      }
      return existing.content;
    }
    const content = {
      id: input.contentId,
      campaignId: input.campaignId,
      brandId: input.brandId,
      title: input.title,
      contentType: input.contentType,
      state: "draft",
      topicKey: input.topicKey,
      latestVersion: 1,
      latestVersionId: input.versionId,
    };
    this.contentIdempotency.set(input.idempotencyKey, {
      requestHash: input.requestHash,
      content,
    });
    return content;
  }

  async createContentVersion(
    _context: RequestContext,
    input: Parameters<ApiRepository["createContentVersion"]>[1],
  ) {
    this.contentVersionInputs.push(input);
    return {
      id: input.contentItemId,
      campaignId: ids.content,
      brandId: ids.brand,
      title: "Versioned content",
      contentType: "evidence",
      state: "draft",
      topicKey: "versioned",
      latestVersion: 2,
      latestVersionId: input.versionId,
    };
  }

  async getContentVersion(_context: RequestContext, contentVersionId: string) {
    return {
      id: contentVersionId,
      contentItemId: ids.content,
      version: 1,
      summary: articlePayload.summary,
      bodyMarkdown: articlePayload.bodyMarkdown,
      payload: articlePayload,
      payloadHash: sha256Canonical(articlePayload),
      frozenAt: null,
    };
  }

  async listVariants() {
    return [];
  }

  async createVariant(
    _context: RequestContext,
    input: Parameters<ApiRepository["createVariant"]>[1],
  ) {
    this.variantInputs.push(input);
    if (sha256Canonical(input.payload) !== input.payloadHash) {
      throw new RepositoryConflictError("Publication variant payload hash does not match");
    }
    for (const reference of input.payload.media) {
      const asset = this.mediaAssets.get(`${_context.tenantId}:${reference.id}`);
      if (asset === undefined || sha256Canonical(asset.reference) !== sha256Canonical(reference)) {
        throw new RepositoryConflictError(
          "Publication payload references unknown or changed media evidence",
        );
      }
    }
    return {
      id: input.variantId,
      contentVersionId: input.contentVersionId,
      channelAccountId: input.channelAccountId,
      platform: "toutiao" as const,
      variantVersion: 1,
      payload: input.payload,
      payloadHash: input.payloadHash,
      state: "draft",
      frozenAt: null,
    };
  }

  async createMediaJob(
    context: RequestContext,
    input: Parameters<ApiRepository["createMediaJob"]>[1],
  ): ReturnType<ApiRepository["createMediaJob"]> {
    const idempotencyKey = `${context.tenantId}:${input.idempotencyKey}`;
    const existingJobId = this.mediaJobIdempotency.get(idempotencyKey);
    if (existingJobId !== undefined) {
      const existing = this.mediaJobs.get(`${context.tenantId}:${existingJobId}`);
      if (existing === undefined) {
        throw new RepositoryConflictError("Media job idempotency state is inconsistent");
      }
      if (existing.requestHash !== input.requestHash) {
        throw new RepositoryConflictError(
          "Media job idempotency key conflicts with another request",
        );
      }
      return Promise.resolve(existing);
    }

    const job: Awaited<ReturnType<ApiRepository["createMediaJob"]>> = {
      id: input.jobId,
      contentVersionId: input.contentVersionId,
      platform: input.platform,
      role: input.role,
      factIds: input.factIds,
      visualBrief: input.visualBrief,
      visualBriefHash: input.visualBriefHash,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      providerId: input.providerId,
      providerMode: input.providerMode,
      state: "pending",
      attemptCount: 0,
      assetId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      completedAt: null,
    };
    if (
      input.platform !== input.visualBrief.platform ||
      input.role !== input.visualBrief.role ||
      input.visualBriefHash !== sha256Canonical(input.visualBrief) ||
      input.factIds.length !== input.visualBrief.factIds.length ||
      input.factIds.some((factId, index) => factId !== input.visualBrief.factIds[index])
    ) {
      throw new RepositoryConflictError("Media job does not match its visual brief");
    }
    this.mediaJobs.set(`${context.tenantId}:${input.jobId}`, job);
    this.mediaJobIdempotency.set(idempotencyKey, input.jobId);
    return Promise.resolve(job);
  }

  async getMediaJob(context: RequestContext, jobId: string) {
    return this.mediaJobs.get(`${context.tenantId}:${jobId}`) ?? null;
  }

  async recordMediaAttempt(
    context: RequestContext,
    input: Parameters<ApiRepository["recordMediaAttempt"]>[1],
  ) {
    const key = `${context.tenantId}:${input.jobId}`;
    const job = this.mediaJobs.get(key);
    if (job === undefined) throw new RepositoryNotFoundError("Media job was not found");
    if (["succeeded", "failed", "cancelled"].includes(job.state)) {
      throw new RepositoryConflictError("Media job is already terminal");
    }
    if (
      input.requestHash !== job.requestHash ||
      input.providerId !== job.providerId ||
      input.providerMode !== job.providerMode
    ) {
      throw new RepositoryConflictError("Media attempt does not match its generation job");
    }
    const succeeded = input.status === "succeeded";
    if (
      (succeeded &&
        (input.responseHash === null || input.outputSha256 === null || input.errorCode !== null)) ||
      (!succeeded && (input.outputSha256 !== null || input.errorCode === null))
    ) {
      throw new RepositoryConflictError("Media attempt outcome fields are inconsistent");
    }
    this.mediaAttempts.push(input);
    this.mediaJobs.set(key, {
      ...job,
      state: succeeded ? "running" : "pending",
      attemptCount: Math.max(job.attemptCount, input.attemptNo),
      updatedAt: input.finishedAt,
    });
  }

  async completeMediaJob(
    context: RequestContext,
    input: Parameters<ApiRepository["completeMediaJob"]>[1],
  ): ReturnType<ApiRepository["completeMediaJob"]> {
    const jobKey = `${context.tenantId}:${input.jobId}`;
    const job = this.mediaJobs.get(jobKey);
    if (job === undefined) throw new RepositoryNotFoundError("Media job was not found");
    if (job.state !== "running") {
      throw new RepositoryConflictError("Media job is not ready for completion");
    }
    const provenance = input.reference.provenance;
    if (
      input.reference.platform !== job.platform ||
      input.reference.role !== job.role ||
      input.reference.visualBriefHash !== job.visualBriefHash ||
      provenance.kind !== "generated" ||
      provenance.jobId !== input.jobId ||
      provenance.provider !== job.providerId ||
      provenance.providerMode !== job.providerMode ||
      input.reference.inspection.status !== "passed"
    ) {
      throw new RepositoryConflictError("Media asset does not match its generation job");
    }
    const successfulAttempt = this.mediaAttempts.some(
      (attempt) =>
        attempt.jobId === input.jobId &&
        attempt.attemptId === provenance.attemptId &&
        attempt.status === "succeeded" &&
        attempt.outputSha256 === input.reference.sha256 &&
        attempt.providerId === provenance.provider &&
        attempt.providerMode === provenance.providerMode &&
        attempt.model === provenance.model,
    );
    if (!successfulAttempt) {
      throw new RepositoryConflictError("Media job has no matching successful attempt");
    }
    if (sha256Canonical(input.successorPayload) !== input.successorPayloadHash) {
      throw new RepositoryConflictError("Successor media payload hash does not match");
    }
    const payloadReference = input.successorPayload.media.find(
      (media) => media.id === input.reference.id,
    );
    if (
      payloadReference === undefined ||
      sha256Canonical(payloadReference) !== sha256Canonical(input.reference)
    ) {
      throw new RepositoryConflictError(
        "Successor payload does not contain the exact media reference",
      );
    }
    const extensions: Readonly<Record<string, string>> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    };
    const extension = extensions[input.reference.mimeType];
    const expectedStorageKey =
      extension === undefined
        ? null
        : `${context.tenantId}/${input.reference.sha256.slice(0, 2)}/${input.reference.sha256}.${extension}`;
    if (input.storageKey !== expectedStorageKey) {
      throw new RepositoryConflictError("Media storage key is not content addressed");
    }
    for (const reference of input.successorPayload.media) {
      if (reference.id === input.reference.id) continue;
      const asset = this.mediaAssets.get(`${context.tenantId}:${reference.id}`);
      if (asset === undefined || sha256Canonical(asset.reference) !== sha256Canonical(reference)) {
        throw new RepositoryConflictError(
          "Publication payload references unknown or changed media evidence",
        );
      }
    }

    const asset: Awaited<ReturnType<ApiRepository["completeMediaJob"]>> = {
      id: input.assetId,
      contentVersionId: input.successorContentVersionId,
      storageKey: input.storageKey,
      reference: input.reference,
      createdAt: input.completedAt,
    };
    this.mediaAssets.set(`${context.tenantId}:${input.assetId}`, asset);
    this.mediaJobs.set(jobKey, {
      ...job,
      state: "succeeded",
      assetId: input.assetId,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    });
    return Promise.resolve(asset);
  }

  async failMediaJob(
    context: RequestContext,
    input: Parameters<ApiRepository["failMediaJob"]>[1],
  ): ReturnType<ApiRepository["failMediaJob"]> {
    const key = `${context.tenantId}:${input.jobId}`;
    const job = this.mediaJobs.get(key);
    if (job === undefined) throw new RepositoryNotFoundError("Media job was not found");
    if (job.state !== "pending" && job.state !== "running") {
      throw new RepositoryConflictError("Media job cannot be failed");
    }
    const failed: Awaited<ReturnType<ApiRepository["failMediaJob"]>> = {
      ...job,
      state: "failed",
      lastErrorCode: input.errorCode,
      lastErrorMessage: input.errorMessage,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    };
    this.mediaJobs.set(key, failed);
    return Promise.resolve(failed);
  }

  async listMediaAssets(context: RequestContext, contentVersionId: string) {
    return [...this.mediaAssets.entries()]
      .filter(
        ([key, asset]) =>
          key.startsWith(`${context.tenantId}:`) && asset.contentVersionId === contentVersionId,
      )
      .map(([, asset]) => asset);
  }

  async getMediaAsset(context: RequestContext, assetId: string) {
    return this.mediaAssets.get(`${context.tenantId}:${assetId}`) ?? null;
  }

  async loadAuditContext(): Promise<AuditContextRecord> {
    return {
      brandSnapshot: {
        id: ids.brand,
        canonicalName: "zhongtong-international-travel",
        displayName: "Zhongtong International Travel Agency",
        aliases: ["Zhongtong Travel"],
      },
      variant: {
        id: ids.variant,
        contentVersionId: ids.version,
        channelAccountId: ids.account,
        platform: "toutiao",
        variantVersion: 1,
        payload: this.auditPayload,
        payloadHash: "a".repeat(64),
        state: "draft",
        frozenAt: null,
      },
      contacts,
      factSnapshot: articleFactSnapshot,
      priorVariants: [],
      policyBundle: {
        id: ids.policy,
        version: "travel-v1",
        policyHash: this.auditPolicyHash,
        document: this.auditPolicyDocument,
      },
    };
  }

  async findAuditByIdempotency(
    context: RequestContext,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const existing = this.auditIdempotency.get(`${context.tenantId}:${idempotencyKey}`);
    if (existing === undefined) return null;
    if (existing.requestHash !== requestHash) {
      throw new RepositoryConflictError("Audit idempotency key conflicts with another request");
    }
    return {
      auditRunId: existing.input.auditRunId,
      artifact: existing.input.artifact,
      grant: existing.input.grant,
      wasCreated: false,
    };
  }

  async persistAudit(context: RequestContext, input: PersistAuditInput) {
    const key = `${context.tenantId}:${input.idempotencyKey}`;
    const existing = this.auditIdempotency.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) {
        throw new RepositoryConflictError("Audit idempotency key conflicts with another request");
      }
      return {
        auditRunId: existing.input.auditRunId,
        artifact: existing.input.artifact,
        grant: existing.input.grant,
        wasCreated: false,
      };
    }
    this.persistedAudits.push(input);
    this.auditIdempotency.set(key, { requestHash: input.requestHash, input });
    return {
      auditRunId: input.auditRunId,
      artifact: input.artifact,
      grant: input.grant,
      wasCreated: true,
    };
  }

  async getAudit(
    _context: RequestContext,
    artifactId: string,
  ): Promise<Readonly<AuditArtifact> | null> {
    return this.persistedAudits.find((entry) => entry.artifact.id === artifactId)?.artifact ?? null;
  }

  async loadManualPublicationPackageSource(
    context: RequestContext,
    artifactId: string,
  ): Promise<ManualPublicationPackageSource | null> {
    const artifact = await this.getAudit(context, artifactId);
    if (artifact === null || artifact.tenantId !== context.tenantId) return null;
    const account = (await this.listChannelAccounts(context)).find(
      (candidate) => candidate.id === artifact.channelAccountId,
    );
    if (account === undefined) return null;
    return {
      artifact,
      payload: this.auditPayload,
      account: {
        id: account.id,
        platform: account.platform,
        capability: account.capability,
        supportedExecutionLevels: account.supportedExecutionLevels,
        status: account.status,
      },
      mediaAssets: [],
    };
  }

  async recordManualPublicationPackageExport(
    _context: RequestContext,
    input: RecordManualPublicationPackageExportInput,
  ): Promise<void> {
    this.manualPublicationPackageExports.push(input);
  }

  async listAudits(_context: RequestContext, input: Parameters<ApiRepository["listAudits"]>[1]) {
    return this.persistedAudits
      .map((entry) => entry.artifact)
      .filter((artifact) => input.status === undefined || artifact.status === input.status)
      .slice(0, input.limit);
  }

  async listAuditLog(
    _context: RequestContext,
    input: Parameters<ApiRepository["listAuditLog"]>[1],
  ) {
    return [
      {
        id: "10000000-0000-4000-8000-000000000996",
        actorId: ids.actor,
        action: input.action ?? "publication_job.cancelled",
        resourceType: input.resourceType ?? "publication_job",
        resourceId: "10000000-0000-4000-8000-000000000991",
        requestId: "request:test",
        beforeHash: null,
        afterHash: "e".repeat(64),
        details: { reason: "test" },
        createdAt: fixedNow.toISOString(),
      },
    ].slice(0, input.limit);
  }

  async consumePublicationGrant(_context: RequestContext, input: PublicationRequestInput) {
    this.publicationRequests.push(input);
    if (this.publicationRequestError !== null) throw this.publicationRequestError;
    return {
      publicationJobId: "10000000-0000-4000-8000-000000000991",
      publicationOutboxEventId: "10000000-0000-4000-8000-000000000992",
      wasCreated: true,
    };
  }

  async resolvePublicationReplay(
    _context: RequestContext,
    input: Parameters<ApiRepository["resolvePublicationReplay"]>[1],
  ) {
    this.publicationReplayRequests.push(input);
    return this.publicationReplayResult;
  }

  async revokePublicationGrant(
    _context: RequestContext,
    input: Parameters<ApiRepository["revokePublicationGrant"]>[1],
  ) {
    this.publicationRevocations.push(input);
    return {
      grantId: input.grantId,
      status: "revoked" as const,
      revokedAt: fixedNow.toISOString(),
      wasChanged: true,
    };
  }

  async recordPublicationGovernanceDecision(
    _context: RequestContext,
    input: PublicationGovernanceAuditInput,
  ) {
    this.governanceDecisions.push(input);
  }

  async getPublicationGovernanceContext(
    context: RequestContext,
    grantId: string,
  ): Promise<PublicationGovernanceContext> {
    const persisted = this.persistedAudits.find((entry) => entry.grant?.id === grantId);
    if (persisted?.grant !== undefined && persisted.grant !== null) {
      return {
        grant: {
          id: persisted.grant.id,
          status: persisted.grant.status,
          issuedAt: persisted.grant.issuedAt,
          expiresAt: persisted.grant.expiresAt,
        },
        artifact: persisted.artifact,
      };
    }
    return {
      grant: {
        id: grantId,
        status: "issued",
        issuedAt: fixedNow.toISOString(),
        expiresAt: "2026-07-14T01:10:00.000Z",
      },
      artifact: {
        id: "10000000-0000-4000-8000-000000000989",
        tenantId: context.tenantId,
        variantId: ids.variant,
        channelAccountId: ids.account,
        platform: this.publicationGovernancePlatform,
        payloadHash: "a".repeat(64),
        factSnapshotHash: "b".repeat(64),
        brandSnapshotHash: "e".repeat(64),
        mediaSnapshotHash: "f".repeat(64),
        policyHash: "c".repeat(64),
        policyVersion: "travel-v1",
        auditHash: "d".repeat(64),
        status: "passed",
        findings: [],
        createdAt: fixedNow.toISOString(),
        expiresAt: "2026-07-14T01:10:00.000Z",
      },
    };
  }

  async listPublicationJobs() {
    return [this.publicationJob()];
  }

  async getPublicationJob(_context: RequestContext, jobId: string) {
    return jobId === this.publicationJob().id ? this.publicationJob() : null;
  }

  async cancelPublicationJob(
    _context: RequestContext,
    input: Parameters<ApiRepository["cancelPublicationJob"]>[1],
  ) {
    this.publicationCancellations.push(input);
    this.publicationJobState = "cancelled";
    return { job: this.publicationJob(), wasChanged: true };
  }

  async listPublicationAttempts(_context: RequestContext, jobId: string) {
    return [
      {
        id: "10000000-0000-4000-8000-000000000993",
        jobId,
        attemptNo: 1,
        state: "succeeded" as const,
        requestHash: "a".repeat(64),
        responseHash: "b".repeat(64),
        errorCode: null,
        errorMessage: null,
        startedAt: fixedNow.toISOString(),
        finishedAt: fixedNow.toISOString(),
      },
    ];
  }

  async listPublicationReceipts(_context: RequestContext, jobId?: string) {
    const receipt = this.publicationReceipt();
    return jobId === undefined || jobId === receipt.jobId ? [receipt] : [];
  }

  async getPublicationReceipt(_context: RequestContext, receiptId: string) {
    const receipt = this.publicationReceipt();
    return receipt.id === receiptId ? receipt : null;
  }

  async listPublicationReadbacks(_context: RequestContext, jobId?: string) {
    const readback = {
      id: "10000000-0000-4000-8000-000000000995",
      jobId: this.publicationJob().id,
      receiptId: this.publicationReceipt().id,
      status: "not_required" as const,
      required: false,
      reason: "dry_run_preview_only",
      scheduledFor: fixedNow.toISOString(),
      completedAt: fixedNow.toISOString(),
      lastError: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
    return jobId === undefined || jobId === readback.jobId ? [readback] : [];
  }

  async listPublicationAssistedHandoffs() {
    return [this.publicationAssistedHandoff()];
  }

  async getPublicationAssistedHandoff(_context: RequestContext, handoffId: string) {
    return handoffId === ids.assistedHandoff ? this.publicationAssistedHandoff() : null;
  }

  async claimPublicationAssistedHandoff(
    context: RequestContext,
    input: Parameters<ApiRepository["claimPublicationAssistedHandoff"]>[1],
  ) {
    this.assistedHandoffClaims.push(input);
    this.assistedHandoffLeaseOwner = context.actorId;
    return this.publicationAssistedHandoff();
  }

  async heartbeatPublicationAssistedHandoff(
    _context: RequestContext,
    input: Parameters<ApiRepository["heartbeatPublicationAssistedHandoff"]>[1],
  ) {
    this.assistedHandoffHeartbeats.push(input);
    return this.publicationAssistedHandoff();
  }

  async cancelPublicationAssistedHandoff(
    _context: RequestContext,
    input: Parameters<ApiRepository["cancelPublicationAssistedHandoff"]>[1],
  ) {
    this.assistedHandoffCancellations.push(input);
    this.assistedHandoffState = "cancelled";
    this.assistedHandoffLeaseOwner = null;
    return { handoff: this.publicationAssistedHandoff(), wasChanged: true };
  }

  async issuePublicationAssistedSubmitPermit(_context: RequestContext, handoffId: string) {
    this.assistedHandoffPermitIssues.push(handoffId);
    return {
      submitPermit: "f".repeat(64),
      expiresAt: "2026-07-14T01:05:00.000Z",
    };
  }

  private publicationJob(): PublicationJobView {
    return {
      id: "10000000-0000-4000-8000-000000000991",
      grantId: "10000000-0000-4000-8000-000000000990",
      auditArtifactId: "10000000-0000-4000-8000-000000000989",
      variantId: ids.variant,
      channelAccountId: ids.account,
      platform: "toutiao",
      executionLevel: "dry_run",
      state: this.publicationJobState,
      payloadHash: "a".repeat(64),
      scheduledFor: fixedNow.toISOString(),
      availableAt: fixedNow.toISOString(),
      attemptCount: 1,
      lastErrorCode: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  private publicationReceipt() {
    return {
      id: "10000000-0000-4000-8000-000000000994",
      jobId: this.publicationJob().id,
      attemptId: "10000000-0000-4000-8000-000000000993",
      platform: "toutiao" as const,
      executionLevel: "dry_run" as const,
      evidenceType: "preview" as const,
      requestHash: "a".repeat(64),
      responseHash: "b".repeat(64),
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      confirmed: false,
      payload: { readback: { required: false, reason: "dry_run_preview_only" } },
      recordedAt: fixedNow.toISOString(),
    };
  }

  private publicationAssistedHandoff(): PublicationAssistedHandoffView {
    return {
      id: ids.assistedHandoff,
      jobId: this.publicationJob().id,
      attemptId: "10000000-0000-4000-8000-000000000993",
      channelAccountId: ids.account,
      variantId: ids.variant,
      platform: "ctrip_community",
      state: this.assistedHandoffState,
      payloadHash: "a".repeat(64),
      auditHash: "d".repeat(64),
      previewHash: "e".repeat(64),
      adapterVersion: "ctrip-community-web-v1",
      bridgeServicePrincipalId: "10000000-0000-4000-8000-000000000802",
      leaseOwnerActorId: this.assistedHandoffLeaseOwner,
      leaseExpiresAt: this.assistedHandoffLeaseOwner === null ? null : "2026-07-14T01:02:00.000Z",
      heartbeatAt: this.assistedHandoffLeaseOwner === null ? null : fixedNow.toISOString(),
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
      submitPermitConsumedAt: this.assistedSubmitPermitConsumedAt,
      submitPermitIssuedByActorId: null,
      submitPermitConsumedByPrincipalId: null,
      submitOutcome:
        this.assistedHandoffState === "readback_pending" ||
        this.assistedHandoffState === "needs_review"
          ? "accepted"
          : null,
      submitEvidenceKind:
        this.assistedHandoffState === "readback_pending" ||
        this.assistedHandoffState === "needs_review"
          ? "simulation"
          : null,
      submitObservedAt:
        this.assistedHandoffState === "readback_pending" ||
        this.assistedHandoffState === "needs_review"
          ? fixedNow.toISOString()
          : null,
      publicationReceiptId:
        this.assistedHandoffState === "readback_pending" ||
        this.assistedHandoffState === "needs_review"
          ? "10000000-0000-4000-8000-000000000715"
          : null,
      publicationReadbackId:
        this.assistedHandoffState === "readback_pending" ||
        this.assistedHandoffState === "needs_review"
          ? "10000000-0000-4000-8000-000000000716"
          : null,
      readbackOutcome: this.assistedHandoffState === "needs_review" ? "simulation_only" : null,
      readbackEvidenceKind: this.assistedHandoffState === "needs_review" ? "simulation" : null,
      readbackEvidenceHash: this.assistedHandoffState === "needs_review" ? "1".repeat(64) : null,
      readbackObservedAt:
        this.assistedHandoffState === "needs_review" ? fixedNow.toISOString() : null,
      observedPayloadHash: this.assistedHandoffState === "needs_review" ? "a".repeat(64) : null,
      externalDraftId: null,
      externalId: null,
      externalUrl: null,
      expiresAt: "2026-07-14T01:30:00.000Z",
      cancellationReason:
        this.assistedHandoffState === "cancelled" ? "operator cancelled handoff" : null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    };
  }

  async findVisibilityRunByIdempotency() {
    return null;
  }

  async loadVisibilityRunContext() {
    return {
      querySetVersionId: ids.version,
      querySetVersion: "1.0.0",
      prompts: [
        {
          key: "brand-contact",
          category: "contact",
          prompt: "中通联系方式",
          packVersion: "1.0.0",
        },
        {
          key: "brand-comparison",
          category: "comparison",
          prompt: "中通与同业比较",
          packVersion: "1.0.0",
        },
      ],
      brandId: ids.brand,
      brandNames: ["中通国际旅行社"],
      expectedContacts: ["4001133986", "ZTGL3411", "ZTGL6431"],
      competitors: [
        {
          canonicalName: "中青旅",
          aliases: ["CYTS"],
          sourceType: "tenant_configured" as const,
          sourceRef: "test:competitor:v1",
        },
      ],
      evidenceUrls: [],
    };
  }

  async persistVisibilityRun(
    _context: RequestContext,
    input: Parameters<ApiRepository["persistVisibilityRun"]>[1],
  ) {
    this.visibilityRuns.push(input);
  }

  async listVisibilityRuns() {
    return [
      {
        id: "10000000-0000-4000-8000-000000000971",
        querySetVersionId: ids.version,
        provider: "doubao" as const,
        productSurface: "doubao-app",
        model: "doubao-observed-model",
        searchMode: "on" as const,
        observationMethod: "manual" as const,
        status: "completed" as const,
        locale: "zh-CN",
        geo: "CN",
        startedAt: fixedNow.toISOString(),
        completedAt: fixedNow.toISOString(),
        errorMessage: null,
        observationCount: 1,
        createdAt: fixedNow.toISOString(),
      },
    ];
  }

  async getVisibilityRun(_context: RequestContext, runId: string) {
    const run = (await this.listVisibilityRuns())[0];
    if (run === undefined || run.id !== runId) return null;
    return {
      run,
      observations: [
        {
          id: "10000000-0000-4000-8000-000000000972",
          tenantId: ids.tenant,
          runId,
          provider: "doubao" as const,
          productSurface: run.productSurface,
          model: run.model,
          searchMode: run.searchMode,
          observationMethod: run.observationMethod,
          prompt: "中通国际旅行社联系方式是什么？",
          promptVersion: "1",
          locale: "zh-CN",
          geo: "CN",
          rawAnswer: "24小时热线 4001133986，微信 ZTGL3411 或 ZTGL6431。",
          citedUrls: ["https://example.test/contact"],
          evidenceHash: "c".repeat(64),
          evidenceType: "manual_import" as const,
          requestStartedAt: "2026-07-13T11:59:59.000Z",
          responseReceivedAt: fixedNow.toISOString(),
          observedAt: fixedNow.toISOString(),
          brandMentioned: true,
          answerPosition: 1,
          contactAccuracy: 1,
          competitorMentions: [],
          sentiment: "neutral" as const,
          hallucinationFindings: [],
          harmfulError: false,
          extractorVersion: "geo-visibility-v1",
          evaluatorVersion: "geo-visibility-evaluator-v1",
          metadata: { evidenceMode: "manual" },
          createdAt: fixedNow.toISOString(),
        },
      ],
      metrics: [
        {
          name: "contactAccuracy",
          value: 1,
          sampleCount: 1,
          confidenceLow: null,
          confidenceHigh: null,
          dimensions: { provider: "doubao", evidenceMode: "manual" },
          createdAt: fixedNow.toISOString(),
        },
      ],
    };
  }

  async getVisibilitySummary() {
    return [];
  }
}

const passwordService: PasswordService = {
  hash: async () => "dummy-hash",
  verify: async (passwordHash, password) =>
    passwordHash === "correct-hash" && password === "correct-password",
};

let sequence = 1;
function nextUuid(): string {
  const suffix = String(sequence).padStart(12, "0");
  sequence += 1;
  return `90000000-0000-4000-8000-${suffix}`;
}

function cookieHeader(headers: Record<string, unknown>): string {
  const value = headers["set-cookie"];
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, tenantSlug?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "owner@example.test",
      password: "correct-password",
      ...(tenantSlug === undefined ? {} : { tenantSlug }),
    },
  });
  return {
    response,
    body: response.json<{ csrfToken: string }>(),
    cookie: cookieHeader(response.headers),
  };
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

async function testApp(
  repository: ApiRepository,
  governanceGate: PublicationGovernanceGate = {
    evaluate: async () => ({ allowed: true, reason: "test_allow", evidence: { test: true } }),
  },
  mediaProduction?: MediaProductionController,
  agentRunGateway?: AgentRunGateway,
  ctripBridgeGateway?: CtripBridgeGateway,
) {
  const app = await buildApp({
    repository,
    sessionSecret: "test-session-secret-with-at-least-32-bytes",
    cookieSecure: true,
    passwordService,
    dummyPasswordHash: "dummy-hash",
    now: () => new Date(fixedNow),
    uuid: nextUuid,
    randomToken: () => tokenValue,
    publicationTokenFactory: () => tokenValue,
    allowedOrigins: ["https://console.example.test"],
    publicationGovernanceGate: governanceGate,
    ...(agentRunGateway === undefined ? {} : { agentRunGateway }),
    ...(ctripBridgeGateway === undefined ? {} : { ctripBridgeGateway }),
    ...(mediaProduction === undefined ? {} : { mediaProduction }),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  sequence = 1;
});

describe("Fastify API security and vertical publication flow", () => {
  it("proxies tenant-scoped agent runs only through a content writer session and CSRF", async () => {
    const repository = new FakeRepository();
    const runInputs: AgentRunRequest[] = [];
    const gateway: AgentRunGateway = {
      getCapability: async (tenantId) => ({
        available: true,
        mode: "fixture",
        provider: "fixture",
        model: tenantId === ids.tenant ? "fixture-geo-writer-v1" : "unexpected",
      }),
      run: async (input) => {
        runInputs.push(input);
        return {
          capability: {
            mode: "fixture",
            provider: "fixture",
            model: "fixture-geo-writer-v1",
          },
          result: {
            providerMode: "fixture",
            contentItemId: ids.content,
            steps: ["geo_tenant_context", "geo_draft_proposal", "geo_audit_request"],
          },
        };
      },
    };
    const app = await testApp(repository, undefined, undefined, gateway);

    const anonymous = await app.inject({ method: "GET", url: "/api/agent/capability" });
    expect(anonymous.statusCode).toBe(401);

    const authenticated = await login(app);
    const headers = { cookie: authenticated.cookie };
    const capability = await app.inject({
      method: "GET",
      url: "/api/agent/capability",
      headers,
    });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toMatchObject({
      available: true,
      mode: "fixture",
      model: "fixture-geo-writer-v1",
    });

    const payload = {
      brandId: ids.brand,
      campaignId: ids.brand,
      channelAccountId: ids.account,
      platform: "toutiao",
      topic: "中通国际旅行社日本线路证据核验",
      articleTemplateId: "step-by-step-guide",
      idempotencyKey: "web-agent-run-1",
    };
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      headers,
      payload,
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(runInputs).toHaveLength(0);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      headers: {
        ...headers,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      capability: { mode: "fixture" },
      result: { contentItemId: ids.content },
    });
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).toMatchObject({
      tenantId: ids.tenant,
      actorId: ids.actor,
      brandId: ids.brand,
      articleTemplateId: "step-by-step-guide",
    });
    expect(runInputs[0]?.requestId).toEqual(expect.any(String));
  });

  it("fails closed when an agent runner is not configured", async () => {
    const app = await testApp(new FakeRepository());
    const authenticated = await login(app);
    const headers = { cookie: authenticated.cookie };
    const capability = await app.inject({
      method: "GET",
      url: "/api/agent/capability",
      headers,
    });
    expect(capability.json()).toMatchObject({
      available: false,
      mode: "disabled",
      reason: "tenant_not_configured",
    });
    const run = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      headers: { ...headers, "x-csrf-token": authenticated.body.csrfToken },
      payload: {
        brandId: ids.brand,
        campaignId: ids.brand,
        channelAccountId: ids.account,
        platform: "toutiao",
        topic: "topic",
        articleTemplateId: "step-by-step-guide",
        idempotencyKey: "web-agent-run-disabled",
      },
    });
    expect(run.statusCode).toBe(503);
    expect(run.json()).toMatchObject({ error: { code: "AGENT_TENANT_NOT_CONFIGURED" } });
  });

  it("publishes the route registry as OpenAPI and negotiates the API version", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const documentResponse = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = documentResponse.json<{
      openapi: string;
      info: { version: string };
      paths: Record<
        string,
        Record<
          string,
          {
            parameters: Array<{ name: string; in: string; required: boolean }>;
            security: Array<Record<string, unknown>>;
          }
        >
      >;
    }>();

    expect(documentResponse.statusCode).toBe(200);
    expect(documentResponse.headers["x-geo-api-version"]).toBe(GEO_API_VERSION);
    expect(document).toMatchObject({
      openapi: "3.1.0",
      info: { version: GEO_API_VERSION },
    });
    expect(document.paths["/openapi.json"]?.get?.security).toEqual([]);
    expect(document.paths["/api/automation/controls/{scopeType}/{scopeKey}"]?.put).toMatchObject({
      security: [{ cookieAuth: [] }],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "scopeType", in: "path", required: true }),
        expect.objectContaining({ name: "scopeKey", in: "path", required: true }),
        expect.objectContaining({ name: "x-csrf-token", in: "header", required: true }),
      ]),
    });
    expect(
      document.paths["/api/automation/circuits/{scopeType}/{scopeKey}/state"]?.post,
    ).toBeDefined();
    expect(document.paths["/api/query-sets/{querySetId}/versions"]).toMatchObject({
      get: { security: [{ cookieAuth: [] }] },
      post: { security: [{ cookieAuth: [] }] },
    });
    expect(document.paths["/api/agent/capability"]?.get).toMatchObject({
      security: [{ cookieAuth: [] }],
    });
    expect(document.paths["/api/agent/runs"]?.post).toMatchObject({
      security: [{ cookieAuth: [] }],
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "x-csrf-token", in: "header", required: true }),
      ]),
    });
    expect(
      document.paths["/api/query-sets/{querySetId}/versions/{versionId}/activate"]?.post,
    ).toBeDefined();

    const supported = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-geo-api-version": GEO_API_VERSION },
      payload: { email: "owner@example.test", password: "correct-password" },
    });
    const defaultVersion = await app.inject({ method: "GET", url: "/api/auth/session" });
    const unsupported = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { "x-geo-api-version": "2025-01-01" },
    });

    expect(supported.statusCode).toBe(200);
    expect(supported.headers["x-geo-api-version"]).toBe(GEO_API_VERSION);
    expect(defaultVersion.statusCode).toBe(401);
    expect(defaultVersion.headers["x-geo-api-version"]).toBe(GEO_API_VERSION);
    expect(unsupported.statusCode).toBe(406);
    expect(unsupported.headers["x-geo-api-version"]).toBe(GEO_API_VERSION);
    expect(unsupported.json()).toMatchObject({
      error: {
        code: "API_VERSION_UNSUPPORTED",
        details: {
          requestedVersion: "2025-01-01",
          supportedVersions: [GEO_API_VERSION],
        },
      },
    });
  });

  it("serves the governed V1 article template catalog only to authenticated content readers", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const unauthenticated = await app.inject({ method: "GET", url: "/api/article-templates" });
    const authenticated = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/article-templates",
      headers: { cookie: authenticated.cookie },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    const catalog = response.json<{ version: string; items: Array<{ id: string }> }>();
    expect(catalog.version).toBe("geo.article-templates.v1");
    expect(catalog.items.length).toBeGreaterThanOrEqual(20);
    expect(new Set(catalog.items.map((template) => template.id)).size).toBe(catalog.items.length);
    expect(catalog.items).toContainEqual(expect.objectContaining({ id: "comparison-matrix" }));
  });

  it("rejects untrusted browser origins before authentication", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const untrusted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: { email: "owner@example.test", password: "correct-password" },
    });
    const trusted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://console.example.test", "sec-fetch-site": "same-origin" },
      payload: { email: "owner@example.test", password: "correct-password" },
    });

    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.json()).toMatchObject({ error: { code: "ORIGIN_DENIED" } });
    expect(trusted.statusCode).toBe(200);
  });

  it("uses a secure JWT cookie and derives tenant scope from the membership session", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app, "zhongtong");

    expect(authenticated.response.statusCode).toBe(200);
    const setCookie = authenticated.response.headers["set-cookie"];
    expect(JSON.stringify(setCookie)).toContain("HttpOnly");
    expect(JSON.stringify(setCookie)).toContain("Secure");
    expect(JSON.stringify(setCookie)).toContain("SameSite=Strict");

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: authenticated.cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.body).not.toContain("csrfHash");
    expect(sessionResponse.body).not.toContain("tokenHash");

    const contactsResponse = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: {
        cookie: authenticated.cookie,
        "x-tenant-id": ids.otherTenant,
      },
    });

    expect(contactsResponse.statusCode).toBe(200);
    expect(repository.lastContext?.tenantId).toBe(ids.tenant);
    expect(
      contactsResponse
        .json<{ items: TenantContact[] }>()
        .items.map((item: TenantContact) => item.value),
    ).toEqual(["4001133986", "ZTGL3411", "ZTGL6431"]);
  });

  it("switches tenant by revoking and reissuing a tenant-bound session", async () => {
    const repository = new FakeRepository();
    const currentIdentity = repository.loginIdentity;
    if (currentIdentity === null) throw new Error("test identity is required");
    repository.loginIdentity = {
      ...currentIdentity,
      memberships: [
        ...currentIdentity.memberships,
        {
          tenantId: ids.otherTenant,
          tenantSlug: "isolation",
          tenantDisplayName: "Isolation Tenant",
          tenantStatus: "active",
          role: "viewer",
          capabilities: capabilitiesForRole("viewer"),
          membershipStatus: "active",
        },
      ],
    };
    const app = await testApp(repository);
    const authenticated = await login(app, "zhongtong");
    const tenants = await app.inject({
      method: "GET",
      url: "/api/auth/tenants",
      headers: { cookie: authenticated.cookie },
    });
    const switched = await app.inject({
      method: "POST",
      url: "/api/auth/switch-tenant",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { tenantSlug: "isolation" },
    });

    expect(tenants.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      tenant: { id: ids.otherTenant, slug: "isolation" },
      actor: { role: "viewer" },
    });
    expect([...repository.sessions.values()]).toHaveLength(1);
    expect([...repository.sessions.values()][0]?.tenantId).toBe(ids.otherTenant);
  });

  it("returns a generic login failure and does not create a session", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.test", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
    expect(repository.sessions.size).toBe(0);
  });

  it("requires both role capability and CSRF for writes", async () => {
    const repository = new FakeRepository("viewer");
    const app = await testApp(repository);
    const authenticated = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        brandId: ids.brand,
        name: "Campaign",
        objective: "Objective",
        industry: "travel",
        topicKey: "topic",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });
  });

  it("transitions campaigns through the protected lifecycle without reopening completion", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers,
      payload: {
        brandId: ids.brand,
        name: "Lifecycle campaign",
        objective: "Exercise campaign transitions",
        industry: "travel",
        topicKey: "campaign-lifecycle",
      },
    });
    const campaign = created.json<{ id: string; status: string }>();
    expect(campaign.status).toBe("draft");

    const transition = (status: "active" | "paused" | "completed", reason: string) =>
      app.inject({
        method: "POST",
        url: `/api/campaigns/${campaign.id}/state`,
        headers,
        payload: { status, reason },
      });

    const invalidPause = await transition("paused", "Drafts cannot be paused");
    expect(invalidPause.statusCode).toBe(409);
    const activated = await transition("active", "Ready for governed generation");
    const replayed = await transition("active", "Idempotent operator retry");
    const paused = await transition("paused", "Operator review");
    const resumed = await transition("active", "Review completed");
    const completed = await transition("completed", "Campaign objective reached");
    const reopened = await transition("active", "Must remain terminal");

    expect(activated.json()).toMatchObject({
      campaign: { status: "active" },
      previousStatus: "draft",
      wasChanged: true,
    });
    expect(replayed.json()).toMatchObject({
      campaign: { status: "active" },
      previousStatus: "active",
      wasChanged: false,
    });
    expect(paused.json()).toMatchObject({ campaign: { status: "paused" }, wasChanged: true });
    expect(resumed.json()).toMatchObject({ campaign: { status: "active" }, wasChanged: true });
    expect(completed.json()).toMatchObject({
      campaign: { status: "completed" },
      wasChanged: true,
    });
    expect(reopened.statusCode).toBe(409);
    expect(repository.campaignTransitionInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: campaign.id,
          targetStatus: "active",
          reason: "Ready for governed generation",
          auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]),
    );
  });

  it("persists and confirms the tenant kill switch through the protected API", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const before = await app.inject({
      method: "GET",
      url: "/api/automation",
      headers: { cookie: authenticated.cookie },
    });
    const changed = await app.inject({
      method: "POST",
      url: "/api/automation/kill-switch",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { enabled: true, reason: "Operator emergency pause" },
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/automation",
      headers: { cookie: authenticated.cookie },
    });

    expect(before.json()).toMatchObject({ control: { killSwitchEnabled: false } });
    expect(changed.json()).toMatchObject({ control: { killSwitchEnabled: true } });
    expect(after.json()).toMatchObject({
      control: {
        mode: "shadow",
        killSwitchEnabled: true,
        reason: "Operator emergency pause",
      },
      circuits: [],
    });
  });

  it("updates the tenant automation mode and bounded worker quota through the protected API", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const changed = await app.inject({
      method: "PUT",
      url: "/api/automation/control",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        mode: "unattended",
        quota: {
          maxConcurrent: 2,
          perMinute: 8,
          perDay: 80,
          cooldownSeconds: 15,
          errorBudget: 4,
        },
        reason: "Enable unattended Dry-run after operator review",
      },
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      control: {
        mode: "unattended",
        killSwitchEnabled: false,
        quota: {
          maxConcurrent: 2,
          perMinute: 8,
          perDay: 80,
          cooldownSeconds: 15,
          errorBudget: 4,
        },
      },
    });
    expect(repository.automationControlInputs).toEqual([
      expect.objectContaining({
        mode: "unattended",
        reason: "Enable unattended Dry-run after operator review",
        auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
  });

  it("rejects unknown or internally inconsistent automation quota fields", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/automation/control",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        mode: "unattended",
        quota: {
          maxConcurrent: 10,
          perMinute: 5,
          perDay: 4,
          cooldownSeconds: 0,
          errorBudget: 5,
          dryRunOnly: false,
        },
        reason: "Invalid attempt must fail closed",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.automationControlInputs).toEqual([]);
  });

  it("writes resource-scoped controls and manual circuit state through audited routes", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const control = await app.inject({
      method: "PUT",
      url: `/api/automation/controls/account/${ids.account}`,
      headers,
      payload: {
        mode: "paused",
        quota: {
          maxConcurrent: 1,
          perMinute: 2,
          perDay: 20,
          cooldownSeconds: 30,
          errorBudget: 2,
        },
        killSwitchEnabled: true,
        reason: "Pause one account while capability evidence is reviewed",
      },
    });
    const circuit = await app.inject({
      method: "POST",
      url: "/api/automation/circuits/platform/toutiao/state",
      headers,
      payload: {
        targetState: "open",
        retryAt: "2026-07-20T01:00:00.000Z",
        reason: "Manual platform circuit during incident review",
      },
    });

    expect(control.statusCode).toBe(200);
    expect(control.json()).toMatchObject({
      control: {
        scopeType: "account",
        scopeKey: ids.account,
        mode: "paused",
        killSwitchEnabled: true,
      },
    });
    expect(circuit.statusCode).toBe(200);
    expect(circuit.json()).toMatchObject({
      circuit: { scopeType: "platform", scopeKey: "toutiao", state: "open" },
    });
    expect(repository.scopedAutomationControlInputs[0]).toMatchObject({
      scopeType: "account",
      scopeKey: ids.account,
      auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.circuitStateInputs[0]).toMatchObject({
      scopeType: "platform",
      scopeKey: "toutiao",
      targetState: "open",
      auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects malformed scope keys and expired manual circuit retry times", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const malformed = await app.inject({
      method: "PUT",
      url: "/api/automation/controls/account/not-a-uuid",
      headers,
      payload: {
        mode: "paused",
        quota: {
          maxConcurrent: 1,
          perMinute: 2,
          perDay: 20,
          cooldownSeconds: 0,
          errorBudget: 2,
        },
        killSwitchEnabled: true,
        reason: "Invalid account scope",
      },
    });
    const expiredRetry = await app.inject({
      method: "POST",
      url: "/api/automation/circuits/platform/toutiao/state",
      headers,
      payload: {
        targetState: "open",
        retryAt: "2026-07-13T00:00:00.000Z",
        reason: "Past retry must fail",
      },
    });

    expect(malformed.statusCode).toBe(400);
    expect(expiredRetry.statusCode).toBe(400);
    expect(repository.scopedAutomationControlInputs).toEqual([]);
    expect(repository.circuitStateInputs).toEqual([]);
  });

  it("creates, lists, claims, checkpoints, and cancels a tenant-scoped dry-run batch", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: `/api/campaigns/${ids.brand}/automation-batches`,
      headers,
      payload: {
        idempotencyKey: "campaign:summer:batch:1",
        name: "七月第一批",
        items: [
          {
            slotKey: "slot-001",
            scheduledFor: "2026-07-14T01:05:00.000Z",
            topicKey: "travel:senior-friendly",
            brief: "适合老年人的出境跟团游注意事项",
            channelAccountIds: [ids.account],
          },
        ],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      batch: {
        state: "scheduled",
        executionLevel: "dry_run",
        runCount: 1,
      },
      wasCreated: true,
    });
    expect(repository.automationBatchInputs[0]).toMatchObject({
      campaignId: ids.brand,
      name: "七月第一批",
      runs: [
        {
          slotKey: "slot-001",
          targets: [{ channelAccountId: ids.account }],
        },
      ],
    });
    expect(JSON.stringify(repository.automationBatchInputs[0])).not.toContain("unattended");

    const batches = await app.inject({
      method: "GET",
      url: "/api/automation-batches",
      headers: { cookie: authenticated.cookie },
    });
    const runs = await app.inject({
      method: "GET",
      url: "/api/automation-runs",
      headers: { cookie: authenticated.cookie },
    });
    expect(batches.json()).toMatchObject({ items: [{ executionLevel: "dry_run" }] });
    const run = runs.json<{ items: Array<{ id: string; targets: Array<{ id: string }> }> }>()
      .items[0];
    if (run === undefined || run.targets[0] === undefined) throw new Error("Run fixture missing");

    const claimed = await app.inject({
      method: "POST",
      url: "/api/automation-runs/claim",
      headers,
      payload: { producerId: "producer-1", limit: 1, leaseSeconds: 60 },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      items: [{ id: run.id, tenantGate: { allowed: true } }],
    });
    expect(repository.automationClaimInputs[0]?.workerId).toBe(`${ids.actor}:producer-1`);

    const targetCheckpoint = await app.inject({
      method: "POST",
      url: `/api/automation-runs/${run.id}/targets/${run.targets[0].id}/checkpoint`,
      headers,
      payload: {
        producerId: "producer-1",
        attempt: 1,
        state: "awaiting_delivery",
        variantId: ids.variant,
        auditRunId: ids.policy,
        auditArtifactId: ids.policy,
        publicationJobId: ids.content,
        checkpoint: { stage: "delivery" },
        leaseSeconds: 60,
      },
    });
    expect(targetCheckpoint.statusCode).toBe(200);
    expect(repository.automationTargetCheckpoints[0]).toMatchObject({
      workerId: `${ids.actor}:producer-1`,
      state: "awaiting_delivery",
    });

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/automation-batches/${created.json<{ batch: { id: string } }>().batch.id}/cancel`,
      headers,
      payload: { reason: "运营员停止本批次" },
    });
    expect(cancelled.json()).toMatchObject({ state: "cancelled", wasChanged: true });
  });

  it("rejects client-selected unattended automation and principals without execute authority", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const create = await app.inject({
      method: "POST",
      url: `/api/campaigns/${ids.brand}/automation-batches`,
      headers,
      payload: {
        idempotencyKey: "campaign:summer:batch:2",
        executionLevel: "unattended",
        items: [
          {
            slotKey: "slot-001",
            scheduledFor: "2026-07-14T01:05:00.000Z",
            topicKey: "travel:safe",
            brief: "出境游注意事项",
            channelAccountIds: [ids.account],
          },
        ],
      },
    });
    expect(create.statusCode).toBe(400);
    expect(repository.automationBatchInputs).toHaveLength(0);

    const restrictedRepository = new FakeRepository("editor");
    const restrictedApp = await testApp(restrictedRepository);
    const restricted = await login(restrictedApp);
    const claim = await restrictedApp.inject({
      method: "POST",
      url: "/api/automation-runs/claim",
      headers: {
        cookie: restricted.cookie,
        "x-csrf-token": restricted.body.csrfToken,
      },
      payload: { producerId: "producer-1", limit: 1, leaseSeconds: 60 },
    });

    expect(claim.statusCode).toBe(403);
    expect(restrictedRepository.automationClaimInputs).toHaveLength(0);
  });

  it("manages tenant brands, draft policies, members, and provider-neutral query sets", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const [brands, members, policies, querySets] = await Promise.all([
      app.inject({ method: "GET", url: "/api/brands", headers: writeHeaders }),
      app.inject({ method: "GET", url: "/api/members", headers: writeHeaders }),
      app.inject({ method: "GET", url: "/api/policies", headers: writeHeaders }),
      app.inject({ method: "GET", url: "/api/query-sets", headers: writeHeaders }),
    ]);
    const createdBrand = await app.inject({
      method: "POST",
      url: "/api/brands",
      headers: writeHeaders,
      payload: {
        canonicalName: "Northwind Health",
        displayName: "Northwind Health",
        aliases: [],
        industry: "healthcare",
        isPrimary: false,
      },
    });
    const healthcarePolicyDocument = buildBaselineAuditPolicyDocument({
      rulesVersion: "healthcare-draft-v1",
      industry: "healthcare",
    });
    const createdPolicy = await app.inject({
      method: "POST",
      url: "/api/policies",
      headers: writeHeaders,
      payload: {
        version: "healthcare-draft-v1",
        document: healthcarePolicyDocument,
        reason: "Create the first reviewed healthcare policy draft",
      },
    });
    const createdQuerySet = await app.inject({
      method: "POST",
      url: "/api/query-sets",
      headers: writeHeaders,
      payload: {
        name: "Healthcare domestic AI discovery",
        industry: "healthcare",
        description: "Provider-neutral prompts evaluated independently per product",
        prompts: [
          { key: "service", category: "discovery", prompt: "Which service fits this need?" },
        ],
      },
    });

    expect(brands.json()).toMatchObject({ items: [{ industry: "travel", isPrimary: true }] });
    expect(members.json()).toMatchObject({
      items: [{ email: "owner@example.test", role: "owner" }],
    });
    expect(policies.json()).toMatchObject({ items: [{ status: "active", version: "travel-v1" }] });
    expect(querySets.json()).toMatchObject({
      items: [{ currentVersionId: ids.version, status: "active" }],
    });
    expect(createdBrand.statusCode).toBe(201);
    expect(createdBrand.json()).toMatchObject({ industry: "healthcare", isPrimary: false });
    expect(createdPolicy.statusCode).toBe(201);
    expect(createdPolicy.json()).toMatchObject({ status: "draft", version: "healthcare-draft-v1" });
    expect(repository.policyInputs[0]).toMatchObject({
      policyHash: sha256Canonical(healthcarePolicyDocument),
      document: healthcarePolicyDocument,
      reason: "Create the first reviewed healthcare policy draft",
    });
    expect(createdQuerySet.statusCode).toBe(201);
    expect(createdQuerySet.json()).toMatchObject({
      status: "draft",
      industry: "healthcare",
      currentVersion: 1,
    });
    expect(repository.querySetInputs[0]?.promptHash).toBe(
      sha256Canonical([
        { key: "service", category: "discovery", prompt: "Which service fits this need?" },
      ]),
    );
  });

  it("creates, activates, lists, and retires immutable query-set versions", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const querySetId = "10000000-0000-4000-8000-000000000910";
    const versions = await app.inject({
      method: "GET",
      url: `/api/query-sets/${querySetId}/versions`,
      headers,
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/query-sets/${querySetId}/versions`,
      headers,
      payload: {
        prompts: [
          {
            key: "service-v2",
            category: "discovery",
            prompt: "哪些已核验服务适合第一次出境的客户？",
          },
        ],
        reason: "Add first-travel discovery coverage",
      },
    });
    const version = created.json<{ id: string }>();
    const activated = await app.inject({
      method: "POST",
      url: `/api/query-sets/${querySetId}/versions/${version.id}/activate`,
      headers,
      payload: { reason: "Review completed for query-set version 2" },
    });
    const retired = await app.inject({
      method: "POST",
      url: `/api/query-sets/${querySetId}/state`,
      headers,
      payload: { targetStatus: "retired", reason: "Replace this query set with a new pack" },
    });
    const invalidStateActivation = await app.inject({
      method: "POST",
      url: `/api/query-sets/${querySetId}/state`,
      headers,
      payload: { targetStatus: "active", reason: "Must use explicit version activation" },
    });

    expect(versions.json()).toMatchObject({ items: [{ version: 1 }] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ version: 2, querySetId });
    expect(activated.json()).toMatchObject({
      querySet: { currentVersion: 2, status: "active" },
      previousVersion: 1,
      wasChanged: true,
    });
    expect(retired.json()).toMatchObject({
      querySet: { status: "retired" },
      previousStatus: "active",
      wasChanged: true,
    });
    expect(invalidStateActivation.statusCode).toBe(400);
    expect(repository.querySetVersionInputs[0]).toMatchObject({
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.querySetActivationInputs[0]).toMatchObject({
      versionId: version.id,
      auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.querySetTransitionInputs[0]).toMatchObject({
      targetStatus: "retired",
      auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.querySetTransitionInputs).toHaveLength(1);
  });

  it("creates a versioned Brand Agent Profile with a canonical document hash", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const document = {
      schemaVersion: "geo.brand-agent-profile.v1" as const,
      voice: "克制、清晰、先回答再解释",
      audiences: ["首次出境游客"],
      objectives: ["帮助客户核验服务边界"],
      requiredPoints: ["说明信息有效期"],
      forbiddenClaims: ["保证签证通过"],
      callToAction: "通过官方热线核验当前行程。",
      agentInstructions: "优先选择有完整事实和证据支持的文章策略。",
    };

    const [listed, missing, created] = await Promise.all([
      app.inject({ method: "GET", url: "/api/brand-agent-profiles", headers }),
      app.inject({
        method: "GET",
        url: `/api/brands/${ids.brand}/agent-profile`,
        headers,
      }),
      app.inject({
        method: "POST",
        url: `/api/brands/${ids.brand}/agent-profile`,
        headers,
        payload: { document, reason: "建立第一版品牌编排约定" },
      }),
    ]);

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ items: [] });
    expect(missing.statusCode).toBe(404);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ brandId: ids.brand, version: 1, document });
    expect(repository.brandAgentProfileInputs[0]).toMatchObject({
      brandId: ids.brand,
      document,
      documentHash: sha256Canonical(document),
      reason: "建立第一版品牌编排约定",
    });
  });

  it("rejects policy documents with unknown fields or a mismatched rules version", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const document = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-v2",
      industry: "travel",
    });

    const [unknownField, mismatchedVersion, missingReason] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/policies",
        headers,
        payload: {
          version: "travel-v2",
          document: { ...document, bypassAudit: true },
          reason: "Attempt an invalid policy draft",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/policies",
        headers,
        payload: {
          version: "travel-v3",
          document,
          reason: "Attempt a mismatched policy version",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/policies",
        headers,
        payload: { version: "travel-v2", document },
      }),
    ]);

    expect(unknownField.statusCode).toBe(400);
    expect(mismatchedVersion.statusCode).toBe(400);
    expect(missingReason.statusCode).toBe(400);
    expect(repository.policyInputs).toHaveLength(0);
  });

  it("requires tenant management authority to mark a fact verified", async () => {
    const repository = new FakeRepository("editor");
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const baseFact = {
      brandId: ids.brand,
      normalizedKey: "service.boundary",
      claim: "The signed itinerary is the final service boundary",
      evidenceSourceIds: [ids.source],
    };

    const verified = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers,
      payload: { ...baseFact, status: "verified" },
    });
    const draft = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers,
      payload: baseFact,
    });

    expect(verified.statusCode).toBe(403);
    expect(verified.json()).toMatchObject({ error: { code: "FACT_VERIFICATION_DENIED" } });
    expect(draft.statusCode).toBe(201);
    expect(repository.factInputs[0]?.status).toBe("draft");
  });

  it("binds initial content creation to an idempotency key and canonical request hash", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const request = {
      campaignId: ids.content,
      brandId: ids.brand,
      title: articlePayload.title,
      contentType: "guide",
      topicKey: "japan-service-boundary",
      idempotencyKey: "content-create-once",
      payload: articlePayload,
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: request,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: request,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: { ...request, topicKey: "different-topic" },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(repository.contentInputs[0]).toMatchObject({
      idempotencyKey: "content-create-once",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.contentInputs[1]?.requestHash).toBe(repository.contentInputs[0]?.requestHash);
    expect(repository.contentInputs[2]?.requestHash).not.toBe(
      repository.contentInputs[0]?.requestHash,
    );
  });

  it("requires content type and declared editorial profile to agree", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const baseRequest = {
      campaignId: ids.content,
      brandId: ids.brand,
      title: articlePayload.title,
      topicKey: "profile-consistency",
      payload: articlePayload,
    };

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: {
        ...baseRequest,
        contentType: "comparison",
        idempotencyKey: "profile-mismatch",
      },
    });
    const conflictingEvidence = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: {
        ...baseRequest,
        contentType: "evidence",
        idempotencyKey: "profile-evidence-conflict",
      },
    });
    const legacyGuide = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: {
        ...baseRequest,
        contentType: "guide",
        idempotencyKey: "profile-missing",
        payload: { ...articlePayload, editorialProfile: undefined },
      },
    });
    const explicitEvidence = await app.inject({
      method: "POST",
      url: "/api/content",
      headers,
      payload: {
        ...baseRequest,
        contentType: "evidence",
        idempotencyKey: "explicit-evidence",
        payload: {
          title: "Evidence record",
          summary: "Explicit legacy evidence content",
          bodyMarkdown: "Evidence content retained without an editorial profile.",
          media: [],
          claims: [],
          contactIds: [],
          tags: [],
        },
      },
    });

    expect(mismatch.statusCode).toBe(400);
    expect(conflictingEvidence.statusCode).toBe(400);
    expect(legacyGuide.statusCode).toBe(400);
    expect(explicitEvidence.statusCode).toBe(201);
    expect(repository.contentInputs).toHaveLength(1);
    expect(repository.contentInputs[0]?.contentType).toBe("evidence");
  });

  it("renders the final platform variant on the server and rejects client payload injection", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const created = await app.inject({
      method: "POST",
      url: `/api/content/${ids.content}/variants`,
      headers,
      payload: { contentVersionId: ids.version, channelAccountId: ids.account },
    });
    const injected = await app.inject({
      method: "POST",
      url: `/api/content/${ids.content}/variants`,
      headers,
      payload: {
        contentVersionId: ids.version,
        channelAccountId: ids.account,
        payload: { ...articlePayload, bodyMarkdown: "client supplied" },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(repository.variantInputs).toHaveLength(1);
    expect(repository.variantInputs[0]?.payload).toMatchObject({
      editorialProfile: "guide",
      titleBlocks: [{ type: "template", templateId: "toutiao.guide.title" }],
      claims: articlePayload.claims,
      contactIds: articlePayload.contactIds,
      media: [],
    });
    expect(repository.variantInputs[0]?.payload.bodyMarkdown).not.toBe(articlePayload.bodyMarkdown);
    expect(repository.variantInputs[0]?.payloadHash).toBe(
      sha256Canonical(repository.variantInputs[0]?.payload),
    );
    expect(injected.statusCode).toBe(400);
    expect(repository.variantInputs).toHaveLength(1);
  });

  it("persists an immutable passing audit and service-issued one-time grant", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      auditRunId: string;
      artifact: AuditArtifact;
      publicationAuthorization: { grantId: string; token: string; expiresAt: string } | null;
      wasCreated: boolean;
    }>();
    expect(body.artifact.status).toBe("passed");
    expect(body.auditRunId).toBe(repository.persistedAudits[0]?.auditRunId);
    expect(body.auditRunId).not.toBe(body.artifact.id);
    expect(body.artifact.policyHash).toBe(travelPolicyHash);
    expect(body.artifact.policyVersion).toBe("travel-v1");
    expect(body.publicationAuthorization?.token).toBe(tokenValue);
    expect(body.wasCreated).toBe(true);
    expect(repository.persistedAudits).toHaveLength(1);
    expect(repository.persistedAudits[0]?.grant?.status).toBe("issued");
    expect(Object.isFrozen(repository.persistedAudits[0]?.artifact)).toBe(true);

    const replay = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      auditRunId: body.auditRunId,
      artifact: { id: body.artifact.id },
      publicationAuthorization: body.publicationAuthorization,
      wasCreated: false,
    });
    expect(repository.persistedAudits).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/variants/10000000-0000-4000-8000-000000000604/audits",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "RESOURCE_CONFLICT" } });

    const forbiddenGrantEndpoint = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { cookie: authenticated.cookie },
    });
    expect(forbiddenGrantEndpoint.statusCode).toBe(404);

    const auditList = await app.inject({
      method: "GET",
      url: "/api/audits?status=passed&limit=20",
      headers: { cookie: authenticated.cookie },
    });
    const auditLog = await app.inject({
      method: "GET",
      url: "/api/audit-log?action=publication_job.cancelled&limit=20",
      headers: { cookie: authenticated.cookie },
    });
    expect(auditList.json()).toMatchObject({ items: [{ id: body.artifact.id }], nextBefore: null });
    expect(auditLog.json()).toMatchObject({
      items: [{ action: "publication_job.cancelled", resourceType: "publication_job" }],
      nextBefore: null,
    });
  });

  it("exports a tenant-scoped manual package from a passed audit without publication side effects", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const auditResponse = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers,
      payload: { idempotencyKey: "audit-for-manual-package" },
    });
    const artifactId = auditResponse.json<{ artifact: AuditArtifact }>().artifact.id;

    const missingCsrf = await app.inject({
      method: "POST",
      url: `/api/audits/${artifactId}/manual-publication-package`,
      headers: { cookie: authenticated.cookie },
    });
    const exported = await app.inject({
      method: "POST",
      url: `/api/audits/${artifactId}/manual-publication-package`,
      headers,
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      auditArtifactId: artifactId,
      tenantId: ids.tenant,
      variantId: ids.variant,
      channelAccountId: ids.account,
      platform: "toutiao",
      executionLevel: "dry_run",
      evidenceType: "preview",
      requiresManualAction: true,
      publicationStatus: "not_published",
      confirmed: false,
      files: { "NOT_PUBLISHED.txt": expect.stringContaining("NOT PUBLISHED") },
    });
    expect(repository.manualPublicationPackageExports).toHaveLength(1);
    expect(repository.manualPublicationPackageExports[0]).toMatchObject({
      auditArtifactId: artifactId,
      packageHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      previewHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions).toHaveLength(0);

    const auditorRepository = new FakeRepository("auditor");
    const auditorApp = await testApp(auditorRepository);
    const auditor = await login(auditorApp);
    const auditorAudit = await auditorApp.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: auditor.cookie,
        "x-csrf-token": auditor.body.csrfToken,
      },
      payload: { idempotencyKey: "auditor-package-source" },
    });
    const auditorArtifactId = auditorAudit.json<{ artifact: AuditArtifact }>().artifact.id;
    const forbidden = await auditorApp.inject({
      method: "POST",
      url: `/api/audits/${auditorArtifactId}/manual-publication-package`,
      headers: {
        cookie: auditor.cookie,
        "x-csrf-token": auditor.body.csrfToken,
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(auditorRepository.manualPublicationPackageExports).toHaveLength(0);
  });

  it("persists a failed audit without issuing a publication authorization", async () => {
    const repository = new FakeRepository();
    repository.auditPayload = {
      ...articlePayload,
      bodyMarkdown: `${articlePayload.bodyMarkdown}\n\nThis offer is 100%保证 and uses hotline 4001133987.`,
    };
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-failing" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      artifact: { status: "failed" },
      publicationAuthorization: null,
    });
    const artifactId = response.json<{ artifact: AuditArtifact }>().artifact.id;
    const exportResponse = await app.inject({
      method: "POST",
      url: `/api/audits/${artifactId}/manual-publication-package`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
    });
    expect(exportResponse.statusCode).toBe(422);
    expect(exportResponse.json()).toMatchObject({
      error: { code: "MANUAL_PACKAGE_AUDIT_NOT_PASSED" },
    });
    expect(repository.persistedAudits[0]?.grant).toBeNull();
    expect(repository.manualPublicationPackageExports).toHaveLength(0);
  });

  it("fails closed when the active policy hash does not bind its stored document", async () => {
    const repository = new FakeRepository();
    repository.auditPolicyHash = "0".repeat(64);
    const app = await testApp(repository);
    const authenticated = await login(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-policy-hash-mismatch" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "AUDIT_POLICY_HASH_MISMATCH" } });
    expect(repository.persistedAudits).toHaveLength(0);
  });

  it("passes only a token hash to the repository grant-consumption boundary", async () => {
    const repository = new FakeRepository();
    let governanceInput: Parameters<PublicationGovernanceGate["evaluate"]>[0] | null = null;
    const app = await testApp(repository, {
      evaluate: async (input) => {
        governanceInput = input;
        return { allowed: true, reason: "test_allow", evidence: { test: true } };
      },
    });
    const authenticated = await login(app);
    const auditResponse = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-for-publication" },
    });
    const authorization = auditResponse.json<{
      publicationAuthorization: { grantId: string; token: string };
    }>().publicationAuthorization;

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: { cookie: authenticated.cookie },
      payload: {
        grantId: authorization.grantId,
        token: authorization.token,
        idempotencyKey: "publish-once",
        executionLevel: "dry_run",
        scheduledFor: "2026-07-14T02:00:00.000Z",
      },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: authorization.grantId,
        token: authorization.token,
        idempotencyKey: "publish-once",
        executionLevel: "dry_run",
        scheduledFor: "2026-07-14T02:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(repository.publicationRequests).toHaveLength(1);
    expect(repository.publicationRequests[0]).toMatchObject({
      grantId: authorization.grantId,
      tokenHash: sha256Text(authorization.token),
      idempotencyKey: "publish-once",
      executionLevel: "dry_run",
      scheduledFor: "2026-07-14T02:00:00.000Z",
    });
    expect(repository.publicationRequests[0]).not.toHaveProperty("token");
    expect(governanceInput).toMatchObject({
      phase: "grant_consumption",
      tenantId: ids.tenant,
      resourceId: authorization.grantId,
      publicationContext: {
        grant: { id: authorization.grantId, status: "issued" },
        artifact: {
          tenantId: ids.tenant,
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          policyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          auditHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          findings: [],
        },
      },
    });
    expect(JSON.stringify(governanceInput)).not.toContain(authorization.token);
    expect(JSON.stringify(governanceInput)).not.toContain(sha256Text(authorization.token));
    expect(repository.governanceDecisions[0]).toMatchObject({
      allowed: true,
      grantId: authorization.grantId,
      executionLevel: "dry_run",
    });
  });

  it("admits Ctrip assisted handoff requests through governance and grant consumption", async () => {
    const repository = new FakeRepository();
    repository.publicationGovernancePlatform = "ctrip_community";
    const governanceInputs: Parameters<PublicationGovernanceGate["evaluate"]>[0][] = [];
    const app = await testApp(repository, {
      evaluate: async (input) => {
        governanceInputs.push(input);
        return { allowed: true, reason: "ctrip_assisted_allowed", evidence: { test: true } };
      },
    });
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "ctrip-assisted-handoff",
        executionLevel: "assisted",
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(governanceInputs).toHaveLength(1);
    expect(governanceInputs[0]).toMatchObject({
      phase: "grant_consumption",
      executionLevel: "assisted",
      publicationContext: { artifact: { platform: "ctrip_community" } },
    });
    expect(repository.governanceDecisions).toMatchObject([
      { allowed: true, executionLevel: "assisted" },
    ]);
    expect(repository.publicationRequests).toMatchObject([
      { executionLevel: "assisted", idempotencyKey: "ctrip-assisted-handoff" },
    ]);
  });

  it("rejects non-Ctrip assisted requests before governance or grant consumption", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "toutiao-assisted-unsupported",
        executionLevel: "assisted",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "PUBLICATION_CAPABILITY_UNSUPPORTED" },
    });
    expect(repository.governanceDecisions).toHaveLength(0);
    expect(repository.publicationRequests).toHaveLength(0);
  });

  it("rejects unattended before governance evaluation, grant consumption, or queueing", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "unsupported-unattended",
        executionLevel: "unattended",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "PUBLICATION_CAPABILITY_UNSUPPORTED" },
    });
    expect(repository.governanceDecisions).toHaveLength(0);
    expect(repository.publicationRequests).toHaveLength(0);
  });

  it("resolves an existing publication checkpoint without grant access or side effects", async () => {
    const repository = new FakeRepository();
    repository.publicationReplayResult = {
      publicationJobId: "10000000-0000-4000-8000-000000000991",
      publicationOutboxEventId: "10000000-0000-4000-8000-000000000992",
      wasCreated: false,
    };
    const app = await testApp(repository);
    const authenticated = await login(app);
    const payload = {
      idempotencyKey: "agent-run:publication",
      variantId: ids.variant,
      auditArtifactId: "10000000-0000-4000-8000-000000000989",
      channelAccountId: ids.account,
      executionLevel: "dry_run",
    };

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/publication-replays/resolve",
      headers: { cookie: authenticated.cookie },
      payload,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/api/publication-replays/resolve",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publication: repository.publicationReplayResult });
    expect(repository.publicationReplayRequests).toEqual([payload]);
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions).toHaveLength(0);
    expect(JSON.stringify(response.json())).not.toMatch(/grant|token/iu);
  });

  it("maps an unsupported publication capability to a stable 422 response", async () => {
    const repository = new FakeRepository();
    repository.publicationRequestError = Object.assign(
      new Error("live publication is unsupported for the current platform adapters"),
      { code: "0A000" },
    );
    const app = await testApp(repository);
    const authenticated = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "unsupported-publication-capability",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "PUBLICATION_CAPABILITY_UNSUPPORTED",
        message: "Current platform adapters support dry-run and Ctrip assisted handoffs only",
      },
    });
  });

  it("does not mislabel unrelated database feature errors as publication capability errors", async () => {
    const repository = new FakeRepository();
    repository.publicationRequestError = Object.assign(
      new Error("an unrelated database feature is unsupported"),
      { code: "0A000" },
    );
    const app = await testApp(repository);
    const authenticated = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "unrelated-database-feature-error",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("exposes governed revoke, cancellation, attempt, receipt, and dry-run readback state", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const jobId = "10000000-0000-4000-8000-000000000991";
    const receiptId = "10000000-0000-4000-8000-000000000994";

    const revoked = await app.inject({
      method: "POST",
      url: "/api/publication-grants/10000000-0000-4000-8000-000000000990/revoke",
      headers: writeHeaders,
      payload: { reason: "Operator withdrew this authorization" },
    });
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/publication-jobs/${jobId}/cancel`,
      headers: writeHeaders,
      payload: { reason: "Campaign was paused before dispatch" },
    });
    const [job, attempts, receipts, receipt, readbacks] = await Promise.all([
      app.inject({ method: "GET", url: `/api/publication-jobs/${jobId}`, headers: writeHeaders }),
      app.inject({
        method: "GET",
        url: `/api/publication-jobs/${jobId}/attempts`,
        headers: writeHeaders,
      }),
      app.inject({
        method: "GET",
        url: `/api/publication-jobs/${jobId}/receipts`,
        headers: writeHeaders,
      }),
      app.inject({ method: "GET", url: `/api/receipts/${receiptId}`, headers: writeHeaders }),
      app.inject({
        method: "GET",
        url: `/api/publication-jobs/${jobId}/readbacks`,
        headers: writeHeaders,
      }),
    ]);

    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "revoked", wasChanged: true });
    expect(repository.publicationRevocations[0]).toMatchObject({
      reason: "Operator withdrew this authorization",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ job: { state: "cancelled" }, wasChanged: true });
    expect(job.json()).toMatchObject({ id: jobId, state: "cancelled", attemptCount: 1 });
    expect(attempts.json()).toMatchObject({ items: [{ attemptNo: 1, state: "succeeded" }] });
    expect(receipts.json()).toMatchObject({
      items: [{ id: receiptId, confirmed: false, evidenceType: "preview" }],
    });
    expect(receipt.json()).toMatchObject({
      id: receiptId,
      externalId: null,
      publishedAt: null,
      payload: { readback: { required: false } },
    });
    expect(readbacks.json()).toMatchObject({
      items: [
        {
          jobId,
          status: "not_required",
          required: false,
          reason: "dry_run_preview_only",
        },
      ],
    });
  });

  it("exposes tenant assisted handoffs without permit material and audits operator leases", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const readHeaders = { cookie: authenticated.cookie };
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const list = await app.inject({
      method: "GET",
      url: "/api/publication-assisted-handoffs",
      headers: readHeaders,
    });
    const missingCsrf = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/claim`,
      headers: readHeaders,
      payload: { leaseSeconds: 120 },
    });
    const claimed = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/claim`,
      headers: writeHeaders,
      payload: { leaseSeconds: 120 },
    });
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/heartbeat`,
      headers: writeHeaders,
      payload: { leaseSeconds: 180 },
    });
    const permitEndpoint = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/submit-permit`,
      headers: writeHeaders,
    });
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/cancel`,
      headers: writeHeaders,
      payload: { reason: "Operator cancelled before any submit permit was consumed" },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}`,
      headers: readHeaders,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [
        {
          id: ids.assistedHandoff,
          platform: "ctrip_community",
          state: "handoff_pending",
          submitPermitIssued: false,
          externalId: null,
          externalUrl: null,
        },
      ],
    });
    expect(JSON.stringify(list.json())).not.toContain("submitPermitHash");
    expect(JSON.stringify(list.json())).not.toContain("submit_permit");
    expect(missingCsrf.statusCode).toBe(403);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      handoff: { leaseOwnerActorId: ids.actor, state: "handoff_pending" },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(permitEndpoint.statusCode).toBe(404);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      handoff: { state: "cancelled", leaseOwnerActorId: null },
      wasChanged: true,
    });
    expect(detail.json()).toMatchObject({
      id: ids.assistedHandoff,
      state: "cancelled",
      cancellationReason: "operator cancelled handoff",
    });
    expect(repository.assistedHandoffClaims).toEqual([
      { handoffId: ids.assistedHandoff, leaseSeconds: 120 },
    ]);
    expect(repository.assistedHandoffHeartbeats).toEqual([
      { handoffId: ids.assistedHandoff, leaseSeconds: 180 },
    ]);
    expect(repository.assistedHandoffPermitIssues).toEqual([]);
    expect(repository.assistedHandoffCancellations).toEqual([
      {
        handoffId: ids.assistedHandoff,
        reason: "Operator cancelled before any submit permit was consumed",
      },
    ]);
  });

  it("runs the integrated Ctrip simulator flow without exposing the submit permit", async () => {
    const repository = new FakeRepository();
    const commands: Parameters<CtripBridgeGateway["execute"]>[0][] = [];
    const gateway: CtripBridgeGateway = {
      execute: async (command) => {
        commands.push(command);
        const common = {
          schemaVersion: "geo.ctrip-bridge.result.v1" as const,
          tenantId: ids.tenant,
          handoffId: ids.assistedHandoff,
          bridgePrincipalId: "10000000-0000-4000-8000-000000000802",
          adapterVersion: "ctrip-community-web-v1",
          observedAt: fixedNow.toISOString(),
          evidenceHash: "1".repeat(64),
          evidenceKind: "simulation" as const,
        };
        switch (command.command) {
          case "prepare":
            repository.assistedHandoffState = "draft_prepared";
            return {
              ...common,
              command: "prepare",
              outcome: "prepared",
              state: "draft_prepared",
            };
          case "submit":
            repository.assistedHandoffState = "readback_pending";
            return {
              ...common,
              command: "submit",
              outcome: "accepted",
              state: "readback_pending",
              receiptId: "10000000-0000-4000-8000-000000000715",
              readbackId: "10000000-0000-4000-8000-000000000716",
            };
          case "readback":
            repository.assistedHandoffState = "needs_review";
            return {
              ...common,
              command: "readback",
              outcome: "simulation_only",
              state: "needs_review",
              externalId: null,
              externalUrl: null,
            };
        }
      },
    };
    const app = await testApp(repository, undefined, undefined, undefined, gateway);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/claim`,
      headers,
      payload: { leaseSeconds: 120 },
    });
    const prepared = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/prepare`,
      headers,
      payload: {},
    });
    const submitted = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/submit`,
      headers,
      payload: {},
    });
    const readback = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/readback`,
      headers,
      payload: {},
    });

    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({
      handoff: { state: "draft_prepared" },
      bridge: { command: "prepare", evidenceKind: "simulation" },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      handoff: {
        state: "readback_pending",
        submitOutcome: "accepted",
        submitEvidenceKind: "simulation",
      },
      bridge: { command: "submit", outcome: "accepted" },
    });
    expect(JSON.stringify(submitted.json())).not.toContain('"submitPermit":');
    expect(JSON.stringify(submitted.json())).not.toContain("f".repeat(64));
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toMatchObject({
      handoff: {
        state: "needs_review",
        readbackOutcome: "simulation_only",
        externalId: null,
        externalUrl: null,
      },
      bridge: { command: "readback", outcome: "simulation_only" },
    });
    expect(commands.map((command) => command.command)).toEqual(["prepare", "submit", "readback"]);
    expect(commands[1]).toMatchObject({ submitPermit: "f".repeat(64) });
    expect(repository.assistedHandoffPermitIssues).toEqual([ids.assistedHandoff]);
  });

  it("allows readback recovery only after the Ctrip submit permit was consumed", async () => {
    const repository = new FakeRepository();
    repository.assistedHandoffState = "awaiting_operator_submit";
    const commands: Parameters<CtripBridgeGateway["execute"]>[0][] = [];
    const gateway: CtripBridgeGateway = {
      execute: async (command) => {
        commands.push(command);
        repository.assistedHandoffState = "needs_review";
        return {
          schemaVersion: "geo.ctrip-bridge.result.v1" as const,
          tenantId: ids.tenant,
          handoffId: ids.assistedHandoff,
          bridgePrincipalId: "10000000-0000-4000-8000-000000000802",
          adapterVersion: "ctrip-community-web-v1",
          observedAt: fixedNow.toISOString(),
          evidenceHash: "1".repeat(64),
          evidenceKind: "simulation" as const,
          command: "readback" as const,
          outcome: "simulation_only" as const,
          state: "needs_review" as const,
          externalId: null,
          externalUrl: null,
        };
      },
    };
    const app = await testApp(repository, undefined, undefined, undefined, gateway);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const beforeConsumption = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/readback`,
      headers,
      payload: {},
    });
    expect(beforeConsumption.statusCode).toBe(409);
    expect(commands).toEqual([]);

    repository.assistedSubmitPermitConsumedAt = fixedNow.toISOString();
    const afterConsumption = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/readback`,
      headers,
      payload: {},
    });
    expect(afterConsumption.statusCode).toBe(200);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "readback", handoffId: ids.assistedHandoff });
  });

  it("marks every post-permit submit failure as potentially state-changing", async () => {
    const repository = new FakeRepository();
    const gateway: CtripBridgeGateway = {
      execute: async () => ({
        schemaVersion: "geo.ctrip-bridge.result.v1" as const,
        tenantId: ids.tenant,
        handoffId: ids.assistedHandoff,
        bridgePrincipalId: "10000000-0000-4000-8000-000000000899",
        adapterVersion: "ctrip-community-web-v1",
        observedAt: fixedNow.toISOString(),
        evidenceHash: "1".repeat(64),
        evidenceKind: "simulation" as const,
        command: "submit" as const,
        outcome: "accepted" as const,
        state: "readback_pending" as const,
        receiptId: "10000000-0000-4000-8000-000000000715",
        readbackId: "10000000-0000-4000-8000-000000000716",
      }),
    };
    const app = await testApp(repository, undefined, undefined, undefined, gateway);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/claim`,
      headers,
      payload: { leaseSeconds: 120 },
    });
    repository.assistedHandoffState = "draft_prepared";

    const response = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/submit`,
      headers,
      payload: {},
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "CTRIP_BRIDGE_RESPONSE_INVALID",
        details: { stateMayHaveChanged: true, handoffId: ids.assistedHandoff },
      },
    });
    expect(repository.assistedHandoffPermitIssues).toEqual([ids.assistedHandoff]);
  });

  it("keeps Ctrip bridge commands disabled when no bridge gateway is configured", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/claim`,
      headers,
      payload: { leaseSeconds: 120 },
    });

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/prepare`,
      headers,
      payload: {},
    });
    repository.assistedHandoffState = "draft_prepared";
    const submitResponse = await app.inject({
      method: "POST",
      url: `/api/publication-assisted-handoffs/${ids.assistedHandoff}/submit`,
      headers,
      payload: {},
    });

    expect(prepareResponse.statusCode).toBe(503);
    expect(prepareResponse.json()).toMatchObject({ error: { code: "CTRIP_BRIDGE_DISABLED" } });
    expect(submitResponse.statusCode).toBe(503);
    expect(submitResponse.json()).toMatchObject({ error: { code: "CTRIP_BRIDGE_DISABLED" } });
    expect(repository.assistedHandoffPermitIssues).toEqual([]);
  });

  it("rejects publication schedules outside the bounded window before governance evaluation", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "10000000-0000-4000-8000-000000000990",
        token: tokenValue,
        idempotencyKey: "schedule-too-far",
        executionLevel: "dry_run",
        scheduledFor: "2026-09-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "PUBLICATION_SCHEDULE_INVALID" } });
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions).toHaveLength(0);
  });

  it("fails closed when publication governance denies a direct request", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository, {
      evaluate: async () => ({
        allowed: false,
        reason: "policy_denied",
        evidence: { passed: false },
      }),
    });
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "90000000-0000-4000-8000-000000000501",
        token: tokenValue,
        idempotencyKey: "governance-denied",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "PUBLICATION_GOVERNANCE_DENIED" } });
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions[0]).toMatchObject({
      allowed: false,
      reason: "policy_denied",
    });
  });

  it("returns 503 without consuming a grant when publication governance is unavailable", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository, {
      evaluate: async () => {
        throw new Error("Plastic Promise transport failed");
      },
    });
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "90000000-0000-4000-8000-000000000502",
        token: tokenValue,
        idempotencyKey: "governance-unavailable",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "PUBLICATION_GOVERNANCE_UNAVAILABLE" },
    });
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions).toEqual([
      expect.objectContaining({
        grantId: "90000000-0000-4000-8000-000000000502",
        allowed: false,
        reason: "governance_unavailable",
      }),
    ]);
  });

  it("hashes evidence, binds facts to it, and appends corrected content versions", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const evidenceResponse = await app.inject({
      method: "POST",
      url: "/api/evidence-sources",
      headers: writeHeaders,
      payload: {
        type: "manual",
        title: "Partner-confirmed hotline",
        content: "中通国际旅行社 24小时热线：4001133986",
        capturedAt: "2026-07-13T01:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(evidenceResponse.statusCode).toBe(201);
    const evidence = evidenceResponse.json<{ id: string; contentHash: string }>();
    expect(evidence.contentHash).toBe(sha256Text("中通国际旅行社 24小时热线：4001133986"));
    expect(repository.evidenceSourceInputs[0]?.content).toContain("4001133986");
    expect(evidenceResponse.json()).not.toHaveProperty("content");

    const factResponse = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers: writeHeaders,
      payload: {
        brandId: ids.brand,
        normalizedKey: "contact.hotline",
        claim: "24小时热线为 4001133986",
        evidenceSourceIds: [evidence.id],
      },
    });
    expect(factResponse.statusCode).toBe(201);
    expect(repository.factInputs[0]?.evidenceSourceIds).toEqual([evidence.id]);

    const versionResponse = await app.inject({
      method: "POST",
      url: `/api/content/${ids.content}/versions`,
      headers: writeHeaders,
      payload: { payload: articlePayload },
    });
    expect(versionResponse.statusCode).toBe(201);
    expect(repository.contentVersionInputs[0]).toMatchObject({
      contentItemId: ids.content,
      payloadHash: sha256Canonical(articlePayload),
    });
  });

  it("reports connector capability as dry-run evidence instead of claiming live API support", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mediaProduction: {
        enabled: false,
        providerId: "disabled",
        providerMode: null,
        model: null,
        networkUsed: false,
      },
      items: [
        {
          platform: "toutiao",
          capability: "manual_only",
          supportedExecutionLevels: ["dry_run"],
          evidenceType: "preview",
        },
      ],
    });
  });

  it("keeps media production disabled by default after authorization", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/content-versions/${ids.version}/media-jobs`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "media-disabled",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "MEDIA_PRODUCTION_DISABLED" } });
  });

  it("accepts only scoped media enums and IDs and requires content write plus CSRF", async () => {
    const repository = new FakeRepository();
    const visualBrief = {
      schemaVersion: "geo.visual-brief.v1" as const,
      editorialProfile: "guide" as const,
      platform: "toutiao" as const,
      role: "cover" as const,
      aspectRatio: "16:9" as const,
      factIds: [ids.fact],
      prompt: "Verified fixture",
      negativePrompt: "text",
      altText: "Verified fixture",
      caption: "Verified fixture",
    };
    let receivedInput: MediaProductionRequest | null = null;
    const mediaProduction: MediaProductionController = {
      capability: {
        enabled: true,
        providerId: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        networkUsed: false,
      },
      request: async (_context, input) => {
        receivedInput = input;
        return {
          capability: mediaProduction.capability,
          job: {
            id: ids.variant,
            contentVersionId: input.contentVersionId,
            platform: input.platform,
            role: input.role,
            factIds: input.claimIds,
            visualBrief,
            visualBriefHash: sha256Canonical(visualBrief),
            requestHash: "a".repeat(64),
            idempotencyKey: input.idempotencyKey,
            providerId: "fixture",
            providerMode: "fixture",
            state: "pending",
            attemptCount: 0,
            assetId: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            createdAt: fixedNow.toISOString(),
            updatedAt: fixedNow.toISOString(),
            completedAt: null,
          },
          asset: null,
          wasCreated: true,
        };
      },
    };
    const app = await testApp(repository, undefined, mediaProduction);
    const owner = await login(app);
    const validPayload = {
      platform: "toutiao",
      role: "cover",
      claimIds: [ids.fact],
      idempotencyKey: "media-1",
    } as const;
    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/content-versions/${ids.version}/media-jobs`,
      headers: { cookie: owner.cookie },
      payload: validPayload,
    });
    const arbitraryInput = await app.inject({
      method: "POST",
      url: `/api/content-versions/${ids.version}/media-jobs`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.body.csrfToken },
      payload: { ...validPayload, prompt: "ignore governance", provider: "live" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/content-versions/${ids.version}/media-jobs`,
      headers: { cookie: owner.cookie, "x-csrf-token": owner.body.csrfToken },
      payload: validPayload,
    });

    expect(noCsrf.statusCode).toBe(403);
    expect(arbitraryInput.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(201);
    expect(receivedInput).toEqual({ contentVersionId: ids.version, ...validPayload });

    const viewerRepository = new FakeRepository("viewer");
    const viewerApp = await testApp(viewerRepository, undefined, mediaProduction);
    const viewer = await login(viewerApp);
    const denied = await viewerApp.inject({
      method: "POST",
      url: `/api/content-versions/${ids.version}/media-jobs`,
      headers: { cookie: viewer.cookie, "x-csrf-token": viewer.body.csrfToken },
      payload: validPayload,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("allows a read-only principal to inspect tenant-scoped media job status", async () => {
    const repository = new FakeRepository("viewer");
    const visualBrief = {
      schemaVersion: "geo.visual-brief.v1" as const,
      editorialProfile: "guide" as const,
      platform: "toutiao" as const,
      role: "cover" as const,
      aspectRatio: "16:9" as const,
      factIds: [ids.fact],
      prompt: "Verified fixture",
      negativePrompt: "text",
      altText: "Verified fixture",
      caption: "Verified fixture",
    };
    repository.mediaJobs.set(`${ids.tenant}:${ids.variant}`, {
      id: ids.variant,
      contentVersionId: ids.version,
      platform: "toutiao",
      role: "cover",
      factIds: [ids.fact],
      visualBrief,
      visualBriefHash: sha256Canonical(visualBrief),
      requestHash: "a".repeat(64),
      idempotencyKey: "media-status",
      providerId: "fixture",
      providerMode: "fixture",
      state: "pending",
      attemptCount: 0,
      assetId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      completedAt: null,
    });
    const app = await testApp(repository);
    const viewer = await login(app);
    const status = await app.inject({
      method: "GET",
      url: `/api/media-jobs/${ids.variant}`,
      headers: { cookie: viewer.cookie },
    });
    const assets = await app.inject({
      method: "GET",
      url: `/api/media-assets?contentVersionId=${ids.version}`,
      headers: { cookie: viewer.cookie },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      capability: { enabled: false, providerId: "disabled" },
      job: { id: ids.variant, state: "pending" },
      asset: null,
    });
    expect(assets.statusCode).toBe(200);
    expect(assets.json()).toMatchObject({ items: [] });
  });

  it("persists repeated Doubao/Qwen samples as explicitly fixture evidence", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/visibility-runs",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        querySetVersionId: ids.version,
        provider: "qwen",
        sampleCount: 2,
        idempotencyKey: "qwen-fixture-two-samples",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "completed",
      provider: "qwen",
      providerMode: "fixture",
      evidenceType: "fixture",
      observationCount: 4,
      circuitOpened: false,
      wasCreated: true,
    });
    expect(repository.visibilityRuns).toHaveLength(1);
    expect(repository.visibilityRuns[0]?.observations).toHaveLength(4);
    expect(
      repository.visibilityRuns[0]?.observations.every((item) => item.evidenceType === "fixture"),
    ).toBe(true);
    expect(
      repository.visibilityRuns[0]?.observations.some(
        (item) => item.competitorMentions[0] === "中青旅",
      ),
    ).toBe(true);
    expect(
      repository.visibilityRuns[0]?.observations.every(
        (item) => item.evaluatorVersion === "geo-visibility-evaluator-v1",
      ),
    ).toBe(true);
  });

  it("records explicit manual request/response timing and structured hallucination findings", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/visibility-runs/import",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        querySetVersionId: ids.version,
        provider: "doubao",
        productSurface: "doubao-web-search",
        model: "manual-observed-unknown",
        searchMode: "unknown",
        locale: "zh-CN",
        geo: "CN",
        idempotencyKey: "doubao-manual-bad-contact",
        samples: [
          {
            queryKey: "brand-contact",
            rawAnswer: "中通国际旅行社热线是 4009999999。",
            citedUrls: [],
            requestStartedAt: "2026-07-13T11:59:58.000Z",
            responseReceivedAt: "2026-07-13T11:59:59.000Z",
            observedAt: "2026-07-13T12:00:00.000Z",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(repository.visibilityRuns[0]?.observations[0]).toMatchObject({
      requestStartedAt: "2026-07-13T11:59:58.000Z",
      responseReceivedAt: "2026-07-13T11:59:59.000Z",
      sentiment: "neutral",
      harmfulError: true,
      evaluatorVersion: "geo-visibility-evaluator-v1",
      hallucinationFindings: [
        {
          code: "unexpected_contact",
          observedValue: "4009999999",
        },
      ],
    });
  });

  it("lists visibility runs and returns tenant-scoped raw evidence without collapsing dimensions", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = { cookie: authenticated.cookie };

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/visibility-runs?provider=doubao&observationMethod=manual",
      headers,
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json<{ items: Array<{ id: string }> }>().items[0];
    expect(listed).toMatchObject({
      provider: "doubao",
      productSurface: "doubao-app",
      searchMode: "on",
      observationMethod: "manual",
      observationCount: 1,
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/visibility-runs/${listed?.id}`,
      headers,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      observations: [
        {
          evidenceType: "manual_import",
          rawAnswer: expect.stringContaining("4001133986") as string,
          citedUrls: ["https://example.test/contact"],
          contactAccuracy: 1,
          harmfulError: false,
        },
      ],
      metrics: [{ name: "contactAccuracy", value: 1, sampleCount: 1 }],
    });
  });

  it("appends and expires tenant contacts behind tenant:manage and CSRF", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/contacts",
      headers: { cookie: authenticated.cookie },
      payload: { type: "wechat", label: "微信咨询", value: "ZTGL8888" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(repository.contactCreateInputs).toHaveLength(0);

    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/contacts",
      headers,
      payload: {
        type: "wechat",
        label: "微信咨询",
        value: " ZTGL8888 ",
        isPrimary: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(repository.contactCreateInputs[0]).toMatchObject({
      type: "wechat",
      value: "ZTGL8888",
      normalizedValue: "ztgl8888",
      validFrom: fixedNow.toISOString(),
    });

    const expired = await app.inject({
      method: "POST",
      url: `/api/contacts/${ids.phone}/expire`,
      headers,
      payload: { reason: "热线已经完成正式切换" },
    });
    expect(expired.statusCode).toBe(200);
    expect(repository.contactExpireInputs[0]).toEqual({
      contactId: ids.phone,
      reason: "热线已经完成正式切换",
      validUntil: fixedNow.toISOString(),
    });
  });

  it("creates controlled tenant members and protects owner creation", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/members",
      headers,
      payload: {
        email: "editor@example.com",
        displayName: "内容编辑",
        role: "editor",
        initialPassword: "replace-this-password-2026",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("password");
    expect(repository.memberCreateInputs[0]).toMatchObject({
      email: "editor@example.com",
      displayName: "内容编辑",
      role: "editor",
      passwordHash: "dummy-hash",
    });

    const membershipId = created.json<{ id: string }>().id;
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/members/${membershipId}`,
      headers,
      payload: { role: "publisher", status: "active", reason: "调整为发布岗位" },
    });
    expect(updated.statusCode).toBe(200);
    expect(repository.memberUpdateInputs[0]).toEqual({
      membershipId,
      role: "publisher",
      status: "active",
      reason: "调整为发布岗位",
    });

    const adminRepository = new FakeRepository("admin");
    const adminApp = await testApp(adminRepository);
    const admin = await login(adminApp);
    const denied = await adminApp.inject({
      method: "POST",
      url: "/api/members",
      headers: {
        cookie: admin.cookie,
        "x-csrf-token": admin.body.csrfToken,
      },
      payload: {
        email: "second-owner@example.com",
        displayName: "第二负责人",
        role: "owner",
        initialPassword: "replace-this-password-2026",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(adminRepository.memberCreateInputs).toHaveLength(0);
  });

  it("transitions policy state and rejects untruthful manual account execution", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const policy = await app.inject({
      method: "POST",
      url: `/api/policies/${ids.policy}/state`,
      headers,
      payload: { targetStatus: "active", reason: "完成审核并正式启用" },
    });
    expect(policy.statusCode).toBe(200);
    expect(repository.policyTransitionInputs[0]).toEqual({
      policyBundleId: ids.policy,
      targetStatus: "active",
      reason: "完成审核并正式启用",
      changedAt: fixedNow.toISOString(),
    });

    const invalidAccount = await app.inject({
      method: "POST",
      url: "/api/channel-accounts",
      headers,
      payload: {
        platform: "sohu",
        displayName: "不真实执行级别",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run", "assisted"],
        evidenceType: "manual_import",
        evidenceRefs: ["ticket:GEO-1"],
        status: "needs_verification",
      },
    });
    expect(invalidAccount.statusCode).toBe(400);
    expect(repository.channelAccountCreateInputs).toHaveLength(0);

    const createdAccount = await app.inject({
      method: "POST",
      url: "/api/channel-accounts",
      headers,
      payload: {
        platform: "sohu",
        displayName: "中通搜狐号",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        evidenceType: "manual_import",
        evidenceRefs: ["ticket:GEO-2"],
        status: "needs_verification",
      },
    });
    expect(createdAccount.statusCode).toBe(201);
    expect(repository.channelAccountCreateInputs[0]).toMatchObject({
      credentialRef: null,
      supportedExecutionLevels: ["dry_run"],
      lastVerifiedAt: null,
    });

    const updatedAccount = await app.inject({
      method: "PATCH",
      url: `/api/channel-accounts/${ids.account}`,
      headers,
      payload: {
        status: "active",
        lastVerifiedAt: fixedNow.toISOString(),
        evidenceRefs: ["ticket:GEO-3"],
        reason: "账号能力完成复核",
      },
    });
    expect(updatedAccount.statusCode).toBe(200);
    expect(repository.channelAccountUpdateInputs[0]).toMatchObject({
      channelAccountId: ids.account,
      status: "active",
      reason: "账号能力完成复核",
    });
  });

  it("provisions only a fixed least-privilege automation identity without issuing credentials", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const listed = await app.inject({
      method: "GET",
      url: "/api/service-principals",
      headers: { cookie: authenticated.cookie },
    });
    expect(listed.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/service-principals/automation-producers",
      headers,
      payload: { name: "producer-second" },
    });
    expect(created.statusCode).toBe(201);
    const principal = created.json<{
      id: string;
      capabilities: string[];
      credentialStatus: string;
    }>();
    expect(principal.capabilities).toContain("automation:execute");
    expect(principal.capabilities).toContain("audit:run");
    expect(principal.capabilities).not.toContain("tenant:manage");
    expect(principal.capabilities).not.toContain("principal:manage");
    expect(principal.credentialStatus).toBe("not_issued");
    expect(repository.servicePrincipalCreateInputs[0]).toEqual({
      id: principal.id,
      name: "producer-second",
    });

    const bridgeCreated = await app.inject({
      method: "POST",
      url: "/api/service-principals/ctrip-bridges",
      headers,
      payload: { name: "ctrip-bridge-zhongtong" },
    });
    expect(bridgeCreated.statusCode).toBe(201);
    const bridge = bridgeCreated.json<{
      id: string;
      kind: string;
      profile: string;
      capabilities: string[];
      credentialStatus: string;
    }>();
    expect(bridge).toMatchObject({
      kind: "integration",
      profile: "ctrip_bridge",
      capabilities: ["tenant:read", "content:read", "publish:bridge"],
      credentialStatus: "not_issued",
    });
    expect(bridge.capabilities).not.toContain("publish:request");
    expect(repository.ctripBridgePrincipalCreateInputs[0]).toEqual({
      id: bridge.id,
      name: "ctrip-bridge-zhongtong",
    });

    const disabled = await app.inject({
      method: "POST",
      url: `/api/service-principals/${principal.id}/status`,
      headers,
      payload: { status: "disabled", reason: "轮换自动化机器身份" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(repository.servicePrincipalStatusInputs[0]).toEqual({
      servicePrincipalId: principal.id,
      status: "disabled",
      reason: "轮换自动化机器身份",
    });

    const editorRepository = new FakeRepository("editor");
    const editorApp = await testApp(editorRepository);
    const editor = await login(editorApp);
    const denied = await editorApp.inject({
      method: "GET",
      url: "/api/service-principals",
      headers: { cookie: editor.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});
