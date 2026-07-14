import type {
  AuditArtifact,
  Capability,
  ConnectorCapability,
  EvidenceType,
  ExecutionLevel,
  ObservationMethod,
  Platform,
  PublicationGrant,
  PublicationJobState,
  PublicationVariantPayload,
  TenantContact,
  TenantRole,
  VisibilityObservation,
  VisibilityProvider,
} from "@geo/contracts";
import type { FactSnapshot, PriorPublicationVariant } from "@geo/core";
import type { VisibilityMetrics } from "@geo/visibility";

export interface RequestContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly requestId: string;
}

export interface LoginMembership {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantDisplayName: string;
  readonly tenantStatus: "active" | "suspended" | "closed";
  readonly role: TenantRole;
  readonly capabilities: readonly Capability[];
  readonly membershipStatus: "active" | "suspended";
}

export interface LoginIdentity {
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly memberships: readonly LoginMembership[];
}

export interface CreateSessionInput extends RequestContext {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
}

export interface ResolveSessionInput extends RequestContext {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly now: string;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly userDisplayName: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantDisplayName: string;
  readonly role: TenantRole;
  readonly capabilities: readonly Capability[];
  readonly csrfHash: string;
  readonly expiresAt: string;
}

export interface TenantView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly industry: string;
  readonly status: string;
  readonly defaultLocale: string;
}

export interface AutomationControlView {
  readonly id: string;
  readonly mode: "shadow" | "supervised" | "unattended" | "paused" | "stopped";
  readonly killSwitchEnabled: boolean;
  readonly reason: string | null;
  readonly quota: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface CircuitBreakerView {
  readonly scopeType: "tenant" | "platform" | "account" | "campaign" | "topic";
  readonly scopeKey: string;
  readonly state: "closed" | "open" | "half_open";
  readonly failureCount: number;
  readonly openedAt: string | null;
  readonly retryAt: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface AutomationStatusView {
  readonly control: AutomationControlView;
  readonly circuits: readonly CircuitBreakerView[];
}

export interface SetTenantKillSwitchInput {
  readonly controlId: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly auditHash: string;
}

export interface ChannelAccountView {
  readonly id: string;
  readonly platform: Platform;
  readonly displayName: string;
  readonly capability: ConnectorCapability;
  readonly supportedExecutionLevels: readonly ExecutionLevel[];
  readonly evidenceType: EvidenceType;
  readonly evidenceRefs: readonly string[];
  readonly status: string;
  readonly lastVerifiedAt: string | null;
}

export interface CampaignView {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly status: string;
  readonly topicKey: string;
}

export interface CreateCampaignInput {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly topicKey: string;
}

export interface ContentView {
  readonly id: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly title: string;
  readonly contentType: string;
  readonly state: string;
  readonly topicKey: string;
  readonly latestVersion: number | null;
  readonly latestVersionId: string | null;
}

export interface ContentVersionView {
  readonly id: string;
  readonly contentItemId: string;
  readonly version: number;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly payload: PublicationVariantPayload;
  readonly payloadHash: string;
  readonly frozenAt: string | null;
}

export interface EvidenceSourceView {
  readonly id: string;
  readonly type: "url" | "document" | "manual" | "platform_readback";
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CreateEvidenceSourceInput {
  readonly id: string;
  readonly type: EvidenceSourceView["type"];
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly contentHash: string;
  readonly content: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ClaimFactView {
  readonly id: string;
  readonly brandId: string;
  readonly normalizedKey: string;
  readonly claim: string;
  readonly status: "draft" | "verified" | "rejected" | "expired";
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface CreateClaimFactInput {
  readonly id: string;
  readonly brandId: string;
  readonly normalizedKey: string;
  readonly claim: string;
  readonly status: "draft" | "verified";
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface FactListInput {
  readonly brandId?: string;
  readonly query?: string;
  readonly limit: number;
}

export type ResourceScopeKind =
  "brand" | "campaign" | "content_version" | "variant" | "channel_account" | "query_set_version";

export interface ResourceScopeRef {
  readonly kind: ResourceScopeKind;
  readonly id: string;
}

export interface ResourceScopeResult {
  readonly allowed: boolean;
  readonly denied: readonly ResourceScopeRef[];
}

export interface CreateContentInput {
  readonly contentId: string;
  readonly versionId: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly title: string;
  readonly contentType:
    "question_answer" | "guide" | "evidence" | "local_service" | "comparison" | "risk_avoidance";
  readonly topicKey: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly payload: PublicationVariantPayload;
  readonly payloadHash: string;
}

export interface CreateContentVersionInput {
  readonly versionId: string;
  readonly contentItemId: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly payload: PublicationVariantPayload;
  readonly payloadHash: string;
}

export interface VariantView {
  readonly id: string;
  readonly contentVersionId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly variantVersion: number;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly state: string;
  readonly frozenAt: string | null;
}

export interface CreateVariantInput {
  readonly variantId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly channelAccountId: string;
  readonly payload: PublicationVariantPayload;
  readonly payloadHash: string;
}

export interface AuditContextRecord {
  readonly brandId: string;
  readonly variant: VariantView;
  readonly contacts: readonly TenantContact[];
  readonly factSnapshot: FactSnapshot;
  readonly priorVariants: readonly PriorPublicationVariant[];
  readonly policyBundle: {
    readonly id: string;
    readonly version: string;
  };
}

export interface PersistAuditInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly auditRunId: string;
  readonly policyBundleId: string;
  readonly artifact: Readonly<AuditArtifact>;
  readonly grant: Readonly<PublicationGrant> | null;
}

export interface PersistAuditResult {
  readonly artifact: Readonly<AuditArtifact>;
  readonly grant: Readonly<PublicationGrant> | null;
  readonly wasCreated: boolean;
}

export interface PublicationRequestInput {
  readonly grantId: string;
  readonly tokenHash: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly executionLevel: ExecutionLevel;
}

export interface PublicationGovernanceAuditInput {
  readonly decisionId: string;
  readonly grantId: string;
  readonly executionLevel: ExecutionLevel;
  readonly requestHash: string;
  readonly evidenceHash: string;
  readonly allowed: boolean;
  readonly reason: string;
}

export interface PublicationRequestResult {
  readonly publicationJobId: string;
  readonly publicationOutboxEventId: string;
  readonly wasCreated: boolean;
}

export interface PublicationJobView {
  readonly id: string;
  readonly variantId: string;
  readonly platform: Platform;
  readonly executionLevel: ExecutionLevel;
  readonly state: PublicationJobState;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationReceiptView {
  readonly id: string;
  readonly jobId: string;
  readonly platform: Platform;
  readonly executionLevel: ExecutionLevel;
  readonly evidenceType: EvidenceType;
  readonly externalUrl: string | null;
  readonly confirmed: boolean;
  readonly recordedAt: string;
}

export interface VisibilityProviderSummary {
  readonly provider: "doubao" | "qwen";
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly observationMethod: ObservationMethod;
  readonly evidenceType: EvidenceType;
  readonly observations: number;
  readonly brandMentionRate: number;
  readonly contactAccuracy: number;
  readonly harmfulErrors: number;
}

export interface VisibilityRunContextRecord {
  readonly querySetVersionId: string;
  readonly querySetVersion: number;
  readonly prompts: unknown;
  readonly brandNames: readonly string[];
  readonly expectedContacts: readonly string[];
  readonly evidenceUrls: readonly string[];
}

export interface PersistVisibilityRunInput {
  readonly runId: string;
  readonly querySetVersionId: string;
  readonly provider: VisibilityProvider;
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly observationMethod: "fixture" | "manual" | "official_api" | "browser";
  readonly locale: string;
  readonly geo: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly observations: readonly VisibilityObservation[];
  readonly metrics: Readonly<VisibilityMetrics>;
  readonly openCircuit: boolean;
  readonly completedAt: string;
}

export class RepositoryNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryConflictError extends Error {
  readonly code = "RESOURCE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface ApiRepository {
  isReady(): Promise<boolean>;
  findLoginIdentity(email: string): Promise<LoginIdentity | null>;
  findLoginIdentityByUserId(userId: string): Promise<LoginIdentity | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  resolveSession(input: ResolveSessionInput): Promise<ResolvedSession | null>;
  revokeSession(context: RequestContext, sessionId: string): Promise<void>;

  getTenant(context: RequestContext): Promise<TenantView>;
  getAutomationStatus(context: RequestContext): Promise<AutomationStatusView>;
  setTenantKillSwitch(
    context: RequestContext,
    input: SetTenantKillSwitchInput,
  ): Promise<AutomationControlView>;
  listContacts(context: RequestContext): Promise<readonly TenantContact[]>;
  listChannelAccounts(context: RequestContext): Promise<readonly ChannelAccountView[]>;
  listEvidenceSources(context: RequestContext): Promise<readonly EvidenceSourceView[]>;
  createEvidenceSource(
    context: RequestContext,
    input: CreateEvidenceSourceInput,
  ): Promise<EvidenceSourceView>;
  listFacts(context: RequestContext, input: FactListInput): Promise<readonly ClaimFactView[]>;
  createFact(context: RequestContext, input: CreateClaimFactInput): Promise<ClaimFactView>;
  checkResourceScope(
    context: RequestContext,
    resources: readonly ResourceScopeRef[],
  ): Promise<ResourceScopeResult>;
  listCampaigns(context: RequestContext): Promise<readonly CampaignView[]>;
  createCampaign(context: RequestContext, input: CreateCampaignInput): Promise<CampaignView>;
  listContent(context: RequestContext): Promise<readonly ContentView[]>;
  createContent(context: RequestContext, input: CreateContentInput): Promise<ContentView>;
  createContentVersion(
    context: RequestContext,
    input: CreateContentVersionInput,
  ): Promise<ContentView>;
  getContentVersion(
    context: RequestContext,
    contentVersionId: string,
  ): Promise<ContentVersionView | null>;
  listVariants(context: RequestContext, contentItemId: string): Promise<readonly VariantView[]>;
  createVariant(context: RequestContext, input: CreateVariantInput): Promise<VariantView>;

  loadAuditContext(
    context: RequestContext,
    variantId: string,
    capturedAt: string,
  ): Promise<AuditContextRecord | null>;
  findAuditByIdempotency(
    context: RequestContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PersistAuditResult | null>;
  persistAudit(context: RequestContext, input: PersistAuditInput): Promise<PersistAuditResult>;
  getAudit(context: RequestContext, artifactId: string): Promise<Readonly<AuditArtifact> | null>;

  consumePublicationGrant(
    context: RequestContext,
    input: PublicationRequestInput,
  ): Promise<PublicationRequestResult>;
  recordPublicationGovernanceDecision(
    context: RequestContext,
    input: PublicationGovernanceAuditInput,
  ): Promise<void>;
  listPublicationJobs(context: RequestContext): Promise<readonly PublicationJobView[]>;
  listPublicationReceipts(context: RequestContext): Promise<readonly PublicationReceiptView[]>;
  findVisibilityRunByIdempotency(
    context: RequestContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<string | null>;
  loadVisibilityRunContext(
    context: RequestContext,
    querySetVersionId: string,
  ): Promise<VisibilityRunContextRecord | null>;
  persistVisibilityRun(context: RequestContext, input: PersistVisibilityRunInput): Promise<void>;
  getVisibilitySummary(
    context: RequestContext,
    options: { readonly includeFixture: boolean },
  ): Promise<readonly VisibilityProviderSummary[]>;
}
