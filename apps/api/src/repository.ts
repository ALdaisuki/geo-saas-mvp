import type {
  AuditArtifact,
  AutomationMode,
  BrandAgentProfileDocument,
  Capability,
  ConnectorCapability,
  EvidenceType,
  ExecutionLevel,
  MediaProviderMode,
  MediaReference,
  MediaRole,
  ObservationMethod,
  Platform,
  PublicationGrant,
  PublicationJobState,
  PublicationVariantPayload,
  TenantContact,
  TenantRole,
  VisualBrief,
  VisibilityObservation,
  VisibilityProvider,
} from "@geo/contracts";
import type { BrandSnapshot, FactSnapshot, PriorPublicationVariant } from "@geo/core";
import type { CompetitorTruth, VisibilityMetrics } from "@geo/visibility";

import type { AutomationRepository } from "./automation-repository.js";
import type { ManualPublicationPackageRepository } from "./manual-publication-package.js";

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

export interface BrandView {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
  readonly industry: string;
  readonly websiteUrl: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBrandInput {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
  readonly industry: string;
  readonly websiteUrl: string | null;
  readonly isPrimary: boolean;
}

export interface BrandAgentProfileView {
  readonly id: string;
  readonly brandId: string;
  readonly version: number;
  readonly status: "active" | "retired";
  readonly document: BrandAgentProfileDocument;
  readonly documentHash: string;
  readonly effectiveAt: string;
  readonly retiredAt: string | null;
  readonly createdAt: string;
}

export interface CreateBrandAgentProfileInput {
  readonly id: string;
  readonly brandId: string;
  readonly document: BrandAgentProfileDocument;
  readonly documentHash: string;
  readonly effectiveAt: string;
  readonly reason: string;
}

export interface TenantMemberView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: TenantRole;
  readonly capabilities: readonly Capability[];
  readonly status: "active" | "suspended";
  readonly createdAt: string;
}

export interface CreateTenantMemberInput {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: TenantRole;
}

export interface UpdateTenantMemberInput {
  readonly membershipId: string;
  readonly role?: TenantRole;
  readonly status?: "active" | "suspended";
  readonly reason: string;
}

export interface PolicyBundleView {
  readonly id: string;
  readonly version: string;
  readonly status: "draft" | "active" | "retired";
  readonly policyHash: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly effectiveAt: string;
  readonly retiredAt: string | null;
  readonly createdAt: string;
}

export interface CreatePolicyBundleInput {
  readonly id: string;
  readonly version: string;
  readonly policyHash: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly effectiveAt: string;
  readonly reason: string;
}

export interface TransitionPolicyBundleInput {
  readonly policyBundleId: string;
  readonly targetStatus: "active" | "retired";
  readonly reason: string;
  readonly changedAt: string;
}

export interface TransitionPolicyBundleResult {
  readonly policy: PolicyBundleView;
  readonly previousStatus: PolicyBundleView["status"];
  readonly wasChanged: boolean;
}

export interface QuerySetView {
  readonly id: string;
  readonly name: string;
  readonly industry: string;
  readonly status: "draft" | "active" | "retired";
  readonly currentVersion: number;
  readonly description: string;
  readonly currentVersionId: string | null;
  readonly prompts: unknown;
  readonly promptHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateQuerySetInput {
  readonly querySetId: string;
  readonly versionId: string;
  readonly name: string;
  readonly industry: string;
  readonly description: string;
  readonly prompts: readonly Readonly<Record<string, unknown>>[];
  readonly promptHash: string;
}

export interface QuerySetVersionView {
  readonly id: string;
  readonly querySetId: string;
  readonly version: number;
  readonly prompts: readonly Readonly<Record<string, unknown>>[];
  readonly promptHash: string;
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface CreateQuerySetVersionInput {
  readonly querySetId: string;
  readonly versionId: string;
  readonly prompts: readonly Readonly<Record<string, unknown>>[];
  readonly promptHash: string;
  readonly reason: string;
  readonly auditHash: string;
}

export interface ActivateQuerySetVersionInput {
  readonly querySetId: string;
  readonly versionId: string;
  readonly reason: string;
  readonly auditHash: string;
}

export interface ActivateQuerySetVersionResult {
  readonly querySet: QuerySetView;
  readonly previousVersion: number;
  readonly previousStatus: QuerySetView["status"];
  readonly wasChanged: boolean;
}

export interface TransitionQuerySetInput {
  readonly querySetId: string;
  readonly targetStatus: "retired";
  readonly reason: string;
  readonly auditHash: string;
}

export interface TransitionQuerySetResult {
  readonly querySet: QuerySetView;
  readonly previousStatus: QuerySetView["status"];
  readonly wasChanged: boolean;
}

export type AutomationScopeType = "tenant" | "platform" | "account" | "campaign" | "topic";

export interface AutomationControlView {
  readonly id: string;
  readonly scopeType: AutomationScopeType;
  readonly scopeKey: string;
  readonly mode: AutomationMode;
  readonly killSwitchEnabled: boolean;
  readonly reason: string | null;
  readonly quota: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface AutomationQuota {
  readonly maxConcurrent: number;
  readonly perMinute: number;
  readonly perDay: number;
  readonly cooldownSeconds: number;
  readonly errorBudget: number;
}

export interface SetTenantAutomationControlInput {
  readonly controlId: string;
  readonly mode: AutomationMode;
  readonly quota: AutomationQuota;
  readonly reason: string;
  readonly auditHash: string;
}

export interface SetScopedAutomationControlInput extends SetTenantAutomationControlInput {
  readonly scopeType: Exclude<AutomationScopeType, "tenant">;
  readonly scopeKey: string;
  readonly killSwitchEnabled: boolean;
}

export interface CircuitBreakerView {
  readonly id: string;
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
  readonly controls: readonly AutomationControlView[];
  readonly circuits: readonly CircuitBreakerView[];
}

export interface SetCircuitBreakerStateInput {
  readonly circuitId: string;
  readonly scopeType: AutomationScopeType;
  readonly scopeKey: string;
  readonly targetState: "open" | "closed";
  readonly retryAt: string | null;
  readonly reason: string;
  readonly auditHash: string;
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

export interface CreateTenantContactInput {
  readonly id: string;
  readonly type: TenantContact["type"];
  readonly label: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly isPrimary: boolean;
  readonly validFrom: string;
}

export interface ExpireTenantContactInput {
  readonly contactId: string;
  readonly reason: string;
  readonly validUntil: string;
}

export interface CreateChannelAccountInput {
  readonly id: string;
  readonly platform: Platform;
  readonly displayName: string;
  readonly capability: ConnectorCapability;
  readonly supportedExecutionLevels: readonly ExecutionLevel[];
  readonly credentialRef: string | null;
  readonly evidenceType: EvidenceType;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt: string | null;
}

export interface UpdateChannelAccountInput {
  readonly channelAccountId: string;
  readonly displayName?: string;
  readonly capability?: ConnectorCapability;
  readonly supportedExecutionLevels?: readonly ExecutionLevel[];
  readonly credentialRef?: string | null;
  readonly evidenceType?: EvidenceType;
  readonly evidenceRefs?: readonly string[];
  readonly status?: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt?: string | null;
  readonly reason: string;
}

export interface ServicePrincipalView {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: "api" | "worker" | "agent" | "integration";
  readonly profile: "custom" | "automation_producer" | "ctrip_bridge";
  readonly capabilities: readonly Capability[];
  readonly status: "active" | "disabled";
  readonly credentialStatus: "not_issued" | "active" | "expired" | "revoked";
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAutomationServicePrincipalInput {
  readonly id: string;
  readonly name: string;
}

export interface CreateCtripBridgeServicePrincipalInput {
  readonly id: string;
  readonly name: string;
}

export interface SetServicePrincipalStatusInput {
  readonly servicePrincipalId: string;
  readonly status: "active" | "disabled";
  readonly reason: string;
}

export interface SetServicePrincipalStatusResult {
  readonly principal: ServicePrincipalView;
  readonly wasChanged: boolean;
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export interface CampaignView {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly status: CampaignStatus;
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

export interface TransitionCampaignInput {
  readonly campaignId: string;
  readonly targetStatus: Exclude<CampaignStatus, "draft">;
  readonly reason: string | null;
  readonly auditHash: string;
}

export interface TransitionCampaignResult {
  readonly campaign: CampaignView;
  readonly previousStatus: CampaignStatus;
  readonly wasChanged: boolean;
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
  | "brand"
  | "campaign"
  | "content_version"
  | "variant"
  | "channel_account"
  | "query_set_version"
  | "media_job";

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
  readonly idempotencyKey: string;
  readonly requestHash: string;
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

export interface MediaGenerationJobView {
  readonly id: string;
  readonly contentVersionId: string;
  readonly platform: Platform;
  readonly role: MediaRole;
  readonly factIds: readonly string[];
  readonly visualBrief: VisualBrief;
  readonly visualBriefHash: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly providerMode: MediaProviderMode;
  readonly state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly attemptCount: number;
  readonly assetId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreateMediaJobInput {
  readonly jobId: string;
  readonly contentVersionId: string;
  readonly platform: Platform;
  readonly role: MediaRole;
  readonly factIds: readonly string[];
  readonly visualBrief: VisualBrief;
  readonly visualBriefHash: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly providerMode: MediaProviderMode;
}

export interface RecordMediaAttemptInput {
  readonly attemptId: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly status: "succeeded" | "failed" | "timed_out";
  readonly providerId: string;
  readonly providerMode: MediaProviderMode;
  readonly model: string;
  readonly inputHash: string;
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly outputSha256: string | null;
  readonly providerRequestId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface CompleteMediaJobInput {
  readonly jobId: string;
  readonly assetId: string;
  readonly inspectionId: string;
  readonly bindingId: string;
  readonly successorContentVersionId: string;
  readonly storageKey: string;
  readonly reference: MediaReference;
  readonly successorPayload: PublicationVariantPayload;
  readonly successorPayloadHash: string;
  readonly completedAt: string;
}

export interface FailMediaJobInput {
  readonly jobId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly completedAt: string;
}

export interface MediaAssetView {
  readonly id: string;
  readonly contentVersionId: string;
  readonly storageKey: string;
  readonly reference: MediaReference;
  readonly createdAt: string;
}

export interface AuditContextRecord {
  readonly brandSnapshot: BrandSnapshot;
  readonly variant: VariantView;
  readonly contacts: readonly TenantContact[];
  readonly factSnapshot: FactSnapshot;
  readonly priorVariants: readonly PriorPublicationVariant[];
  readonly policyBundle: {
    readonly id: string;
    readonly version: string;
    readonly policyHash: string;
    readonly document: unknown;
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
  readonly auditRunId: string;
  readonly artifact: Readonly<AuditArtifact>;
  readonly grant: Readonly<PublicationGrant> | null;
  readonly wasCreated: boolean;
}

export interface AuditListInput {
  readonly limit: number;
  readonly before?: string;
  readonly status?: "passed" | "failed" | "errored";
  readonly platform?: Platform;
}

export interface AuditLogInput {
  readonly limit: number;
  readonly before?: string;
  readonly action?: string;
  readonly resourceType?: string;
}

export interface AuditLogView {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly requestId: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface PublicationRequestInput {
  readonly grantId: string;
  readonly tokenHash: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly executionLevel: ExecutionLevel;
  readonly scheduledFor: string | null;
}

export interface PublicationReplayInput {
  readonly idempotencyKey: string;
  readonly variantId: string;
  readonly auditArtifactId: string;
  readonly channelAccountId: string;
  readonly executionLevel: ExecutionLevel;
}

export interface RevokePublicationGrantInput {
  readonly grantId: string;
  readonly reason: string;
  readonly auditHash: string;
}

export interface RevokePublicationGrantResult {
  readonly grantId: string;
  readonly status: "revoked";
  readonly revokedAt: string;
  readonly wasChanged: boolean;
}

export interface CancelPublicationJobInput {
  readonly jobId: string;
  readonly reason: string;
  readonly auditHash: string;
}

export interface CancelPublicationJobResult {
  readonly job: PublicationJobView;
  readonly wasChanged: boolean;
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

export interface PublicationGovernanceContext {
  readonly grant: {
    readonly id: string;
    readonly status: "issued" | "consumed" | "expired" | "revoked";
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  readonly artifact: Readonly<AuditArtifact>;
}

export interface PublicationRequestResult {
  readonly publicationJobId: string;
  readonly publicationOutboxEventId: string;
  readonly wasCreated: boolean;
}

export interface PublicationJobView {
  readonly id: string;
  readonly grantId: string;
  readonly auditArtifactId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly executionLevel: ExecutionLevel;
  readonly state: PublicationJobState;
  readonly payloadHash: string;
  readonly scheduledFor: string;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationAttemptView {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly state: "started" | "succeeded" | "failed" | "uncertain" | "reconciled";
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface PublicationReceiptView {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly platform: Platform;
  readonly executionLevel: ExecutionLevel;
  readonly evidenceType: EvidenceType;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly publishedAt: string | null;
  readonly confirmed: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface PublicationReadbackView {
  readonly id: string;
  readonly jobId: string;
  readonly receiptId: string;
  readonly status: "not_required" | "pending" | "processing" | "succeeded" | "failed" | "cancelled";
  readonly required: boolean;
  readonly reason: string | null;
  readonly scheduledFor: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PublicationAssistedHandoffState =
  | "handoff_pending"
  | "session_required"
  | "challenge_required"
  | "draft_prepared"
  | "awaiting_operator_submit"
  | "submitted_unconfirmed"
  | "readback_pending"
  | "confirmed"
  | "needs_review"
  | "cancelled"
  | "expired"
  | "failed";

export interface PublicationAssistedHandoffView {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly channelAccountId: string;
  readonly variantId: string;
  readonly platform: "ctrip_community";
  readonly state: PublicationAssistedHandoffState;
  readonly payloadHash: string;
  readonly auditHash: string;
  readonly previewHash: string;
  readonly adapterVersion: string;
  readonly bridgeServicePrincipalId: string | null;
  readonly leaseOwnerActorId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly sessionEvidenceHash: string | null;
  readonly draftEvidenceHash: string | null;
  readonly prepareOutcome:
    "prepared" | "session_required" | "challenge_required" | "adapter_drift" | null;
  readonly prepareEvidenceKind: "simulation" | "browser" | null;
  readonly prepareEvidenceHash: string | null;
  readonly prepareObservedAt: string | null;
  readonly mediaManifestHash: string | null;
  readonly submitEvidenceHash: string | null;
  readonly submitPermitIssued: boolean;
  readonly submitPermitExpiresAt: string | null;
  readonly submitPermitConsumedAt: string | null;
  readonly submitPermitIssuedByActorId: string | null;
  readonly submitPermitConsumedByPrincipalId: string | null;
  readonly submitOutcome: "accepted" | "uncertain" | "rejected" | null;
  readonly submitEvidenceKind: "simulation" | "browser" | null;
  readonly submitObservedAt: string | null;
  readonly publicationReceiptId: string | null;
  readonly publicationReadbackId: string | null;
  readonly readbackOutcome:
    "confirmed" | "not_found" | "mismatch" | "unavailable" | "simulation_only" | null;
  readonly readbackEvidenceKind: "simulation" | "browser" | "platform_readback" | null;
  readonly readbackEvidenceHash: string | null;
  readonly readbackObservedAt: string | null;
  readonly observedPayloadHash: string | null;
  readonly externalDraftId: string | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly expiresAt: string;
  readonly cancellationReason: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationAssistedHandoffLeaseInput {
  readonly handoffId: string;
  readonly leaseSeconds: number;
}

export interface CancelPublicationAssistedHandoffInput {
  readonly handoffId: string;
  readonly reason: string;
}

export interface PublicationAssistedSubmitPermitResult {
  readonly submitPermit: string;
  readonly expiresAt: string;
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
  readonly averageAnswerPosition: number;
  readonly competitorMentionRate: number;
  readonly negativeSentimentRate: number;
  readonly hallucinationFindings: number;
  readonly harmfulErrors: number;
}

export interface VisibilityRunListInput {
  readonly limit: number;
  readonly provider?: VisibilityProvider;
  readonly observationMethod?: ObservationMethod;
}

export interface VisibilityRunView {
  readonly id: string;
  readonly querySetVersionId: string;
  readonly provider: VisibilityProvider;
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly observationMethod: ObservationMethod;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly locale: string;
  readonly geo: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorMessage: string | null;
  readonly observationCount: number;
  readonly createdAt: string;
}

export interface VisibilityObservationView extends VisibilityObservation {
  readonly extractorVersion: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface VisibilityMetricView {
  readonly name: string;
  readonly value: number;
  readonly sampleCount: number;
  readonly confidenceLow: number | null;
  readonly confidenceHigh: number | null;
  readonly dimensions: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface VisibilityRunDetailView {
  readonly run: VisibilityRunView;
  readonly observations: readonly VisibilityObservationView[];
  readonly metrics: readonly VisibilityMetricView[];
}

export interface VisibilityRunContextRecord {
  readonly querySetVersionId: string;
  readonly querySetVersion: string;
  readonly prompts: unknown;
  readonly brandId: string;
  readonly brandNames: readonly string[];
  readonly expectedContacts: readonly string[];
  readonly competitors: readonly CompetitorTruth[];
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

export interface ApiRepository extends AutomationRepository, ManualPublicationPackageRepository {
  isReady(): Promise<boolean>;
  findLoginIdentity(email: string): Promise<LoginIdentity | null>;
  findLoginIdentityByUserId(userId: string): Promise<LoginIdentity | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  resolveSession(input: ResolveSessionInput): Promise<ResolvedSession | null>;
  revokeSession(context: RequestContext, sessionId: string): Promise<void>;

  getTenant(context: RequestContext): Promise<TenantView>;
  listBrands(context: RequestContext): Promise<readonly BrandView[]>;
  createBrand(context: RequestContext, input: CreateBrandInput): Promise<BrandView>;
  listBrandAgentProfiles(context: RequestContext): Promise<readonly BrandAgentProfileView[]>;
  getBrandAgentProfile(
    context: RequestContext,
    brandId: string,
  ): Promise<BrandAgentProfileView | null>;
  createBrandAgentProfile(
    context: RequestContext,
    input: CreateBrandAgentProfileInput,
  ): Promise<BrandAgentProfileView>;
  listMembers(context: RequestContext): Promise<readonly TenantMemberView[]>;
  createMember(context: RequestContext, input: CreateTenantMemberInput): Promise<TenantMemberView>;
  updateMember(context: RequestContext, input: UpdateTenantMemberInput): Promise<TenantMemberView>;
  listPolicyBundles(context: RequestContext): Promise<readonly PolicyBundleView[]>;
  createPolicyBundle(
    context: RequestContext,
    input: CreatePolicyBundleInput,
  ): Promise<PolicyBundleView>;
  transitionPolicyBundle(
    context: RequestContext,
    input: TransitionPolicyBundleInput,
  ): Promise<TransitionPolicyBundleResult>;
  listQuerySets(context: RequestContext): Promise<readonly QuerySetView[]>;
  createQuerySet(context: RequestContext, input: CreateQuerySetInput): Promise<QuerySetView>;
  listQuerySetVersions(
    context: RequestContext,
    querySetId: string,
  ): Promise<readonly QuerySetVersionView[]>;
  createQuerySetVersion(
    context: RequestContext,
    input: CreateQuerySetVersionInput,
  ): Promise<QuerySetVersionView>;
  activateQuerySetVersion(
    context: RequestContext,
    input: ActivateQuerySetVersionInput,
  ): Promise<ActivateQuerySetVersionResult>;
  transitionQuerySet(
    context: RequestContext,
    input: TransitionQuerySetInput,
  ): Promise<TransitionQuerySetResult>;
  getAutomationStatus(context: RequestContext): Promise<AutomationStatusView>;
  setTenantAutomationControl(
    context: RequestContext,
    input: SetTenantAutomationControlInput,
  ): Promise<AutomationControlView>;
  setScopedAutomationControl(
    context: RequestContext,
    input: SetScopedAutomationControlInput,
  ): Promise<AutomationControlView>;
  setCircuitBreakerState(
    context: RequestContext,
    input: SetCircuitBreakerStateInput,
  ): Promise<CircuitBreakerView>;
  setTenantKillSwitch(
    context: RequestContext,
    input: SetTenantKillSwitchInput,
  ): Promise<AutomationControlView>;
  listContacts(context: RequestContext): Promise<readonly TenantContact[]>;
  createContact(context: RequestContext, input: CreateTenantContactInput): Promise<TenantContact>;
  expireContact(context: RequestContext, input: ExpireTenantContactInput): Promise<TenantContact>;
  listChannelAccounts(context: RequestContext): Promise<readonly ChannelAccountView[]>;
  createChannelAccount(
    context: RequestContext,
    input: CreateChannelAccountInput,
  ): Promise<ChannelAccountView>;
  updateChannelAccount(
    context: RequestContext,
    input: UpdateChannelAccountInput,
  ): Promise<ChannelAccountView>;
  listServicePrincipals(context: RequestContext): Promise<readonly ServicePrincipalView[]>;
  createAutomationServicePrincipal(
    context: RequestContext,
    input: CreateAutomationServicePrincipalInput,
  ): Promise<ServicePrincipalView>;
  createCtripBridgeServicePrincipal(
    context: RequestContext,
    input: CreateCtripBridgeServicePrincipalInput,
  ): Promise<ServicePrincipalView>;
  setServicePrincipalStatus(
    context: RequestContext,
    input: SetServicePrincipalStatusInput,
  ): Promise<SetServicePrincipalStatusResult>;
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
  transitionCampaign(
    context: RequestContext,
    input: TransitionCampaignInput,
  ): Promise<TransitionCampaignResult>;
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
  createMediaJob(
    context: RequestContext,
    input: CreateMediaJobInput,
  ): Promise<MediaGenerationJobView>;
  getMediaJob(context: RequestContext, jobId: string): Promise<MediaGenerationJobView | null>;
  recordMediaAttempt(context: RequestContext, input: RecordMediaAttemptInput): Promise<void>;
  completeMediaJob(context: RequestContext, input: CompleteMediaJobInput): Promise<MediaAssetView>;
  failMediaJob(context: RequestContext, input: FailMediaJobInput): Promise<MediaGenerationJobView>;
  listMediaAssets(
    context: RequestContext,
    contentVersionId: string,
  ): Promise<readonly MediaAssetView[]>;
  getMediaAsset(context: RequestContext, assetId: string): Promise<MediaAssetView | null>;

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
  listAudits(
    context: RequestContext,
    input: AuditListInput,
  ): Promise<readonly Readonly<AuditArtifact>[]>;
  listAuditLog(context: RequestContext, input: AuditLogInput): Promise<readonly AuditLogView[]>;

  consumePublicationGrant(
    context: RequestContext,
    input: PublicationRequestInput,
  ): Promise<PublicationRequestResult>;
  resolvePublicationReplay(
    context: RequestContext,
    input: PublicationReplayInput,
  ): Promise<PublicationRequestResult | null>;
  revokePublicationGrant(
    context: RequestContext,
    input: RevokePublicationGrantInput,
  ): Promise<RevokePublicationGrantResult>;
  recordPublicationGovernanceDecision(
    context: RequestContext,
    input: PublicationGovernanceAuditInput,
  ): Promise<void>;
  getPublicationGovernanceContext(
    context: RequestContext,
    grantId: string,
  ): Promise<PublicationGovernanceContext | null>;
  listPublicationJobs(context: RequestContext): Promise<readonly PublicationJobView[]>;
  getPublicationJob(context: RequestContext, jobId: string): Promise<PublicationJobView | null>;
  cancelPublicationJob(
    context: RequestContext,
    input: CancelPublicationJobInput,
  ): Promise<CancelPublicationJobResult>;
  listPublicationAttempts(
    context: RequestContext,
    jobId: string,
  ): Promise<readonly PublicationAttemptView[]>;
  listPublicationReceipts(
    context: RequestContext,
    jobId?: string,
  ): Promise<readonly PublicationReceiptView[]>;
  getPublicationReceipt(
    context: RequestContext,
    receiptId: string,
  ): Promise<PublicationReceiptView | null>;
  listPublicationReadbacks(
    context: RequestContext,
    jobId?: string,
  ): Promise<readonly PublicationReadbackView[]>;
  listPublicationAssistedHandoffs(
    context: RequestContext,
  ): Promise<readonly PublicationAssistedHandoffView[]>;
  getPublicationAssistedHandoff(
    context: RequestContext,
    handoffId: string,
  ): Promise<PublicationAssistedHandoffView | null>;
  claimPublicationAssistedHandoff(
    context: RequestContext,
    input: PublicationAssistedHandoffLeaseInput,
  ): Promise<PublicationAssistedHandoffView>;
  heartbeatPublicationAssistedHandoff(
    context: RequestContext,
    input: PublicationAssistedHandoffLeaseInput,
  ): Promise<PublicationAssistedHandoffView>;
  cancelPublicationAssistedHandoff(
    context: RequestContext,
    input: CancelPublicationAssistedHandoffInput,
  ): Promise<{ readonly handoff: PublicationAssistedHandoffView; readonly wasChanged: boolean }>;
  issuePublicationAssistedSubmitPermit(
    context: RequestContext,
    handoffId: string,
  ): Promise<PublicationAssistedSubmitPermitResult>;
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
  listVisibilityRuns(
    context: RequestContext,
    input: VisibilityRunListInput,
  ): Promise<readonly VisibilityRunView[]>;
  getVisibilityRun(context: RequestContext, runId: string): Promise<VisibilityRunDetailView | null>;
  getVisibilitySummary(
    context: RequestContext,
    options: { readonly includeFixture: boolean },
  ): Promise<readonly VisibilityProviderSummary[]>;
}
