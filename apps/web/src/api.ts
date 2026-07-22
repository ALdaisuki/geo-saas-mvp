import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ctripBridgeResultSchema,
  type ArticleTemplate,
  type ArticleTemplateCategory,
  type CtripBridgeResult,
  type GovernedEditorialProfile,
} from "@geo/contracts";

export interface TenantOption {
  readonly id?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly role?: string;
  readonly status?: "active" | "unavailable";
}

export interface SessionActor {
  readonly id: string;
  readonly displayName: string | null;
  readonly role: string;
  readonly capabilities: readonly string[];
}

export interface SessionTenant {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

export interface SessionSnapshot {
  readonly actor: SessionActor;
  readonly tenant: SessionTenant;
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

export interface TenantContact {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly label: string;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface CreateContactInput {
  readonly type: "phone" | "wechat" | "email" | "website" | "address";
  readonly label: string;
  readonly value: string;
  readonly isPrimary: boolean;
}

export interface ExpireContactInput {
  readonly reason: string;
}

export interface ChannelAccount {
  readonly id: string;
  readonly platform: string;
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: string;
  readonly lastVerifiedAt: string | null;
}

export interface CreateChannelAccountInput {
  readonly platform: "toutiao" | "sohu" | "ctrip_community";
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly credentialRef: string | null;
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt: string | null;
}

export interface UpdateChannelAccountInput {
  readonly displayName?: string;
  readonly capability?: string;
  readonly supportedExecutionLevels?: readonly string[];
  readonly credentialRef?: string | null;
  readonly evidenceType?: string;
  readonly evidenceRefs?: readonly string[];
  readonly status?: "active" | "disabled" | "needs_verification";
  readonly lastVerifiedAt?: string | null;
  readonly reason: string;
}

export interface Brand {
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

export interface BrandAgentProfileDocument {
  readonly schemaVersion: "geo.brand-agent-profile.v1";
  readonly voice: string;
  readonly audiences: readonly string[];
  readonly objectives: readonly string[];
  readonly requiredPoints: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly callToAction: string;
  readonly agentInstructions: string;
}

export interface BrandAgentProfile {
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
  readonly document: BrandAgentProfileDocument;
  readonly reason: string;
}

export interface TenantMember {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly status: "active" | "suspended";
  readonly createdAt: string;
}

export interface CreateMemberInput {
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly initialPassword: string;
}

export interface UpdateMemberInput {
  readonly role?: string;
  readonly status?: "active" | "suspended";
  readonly reason: string;
}

export interface PolicyBundle {
  readonly id: string;
  readonly version: string;
  readonly status: "draft" | "active" | "retired";
  readonly policyHash: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly effectiveAt: string;
  readonly retiredAt: string | null;
  readonly createdAt: string;
}

export interface CreatePolicyInput {
  readonly version: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly effectiveAt?: string;
  readonly reason: string;
}

export interface PolicyTransitionInput {
  readonly targetStatus: "active" | "retired";
  readonly reason: string;
}

export interface PolicyTransitionResult {
  readonly policy: PolicyBundle;
  readonly previousStatus: PolicyBundle["status"];
  readonly wasChanged: boolean;
}

export interface ServicePrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: "api" | "worker" | "agent" | "integration";
  readonly profile: "custom" | "automation_producer" | "ctrip_bridge";
  readonly capabilities: readonly string[];
  readonly status: "active" | "disabled";
  readonly credentialStatus: "not_issued" | "active" | "expired" | "revoked";
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuerySet {
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

export interface QuerySetPrompt {
  readonly key: string;
  readonly category: string;
  readonly prompt: string;
}

export interface QuerySetVersion {
  readonly id: string;
  readonly querySetId: string;
  readonly version: number;
  readonly prompts: readonly QuerySetPrompt[];
  readonly promptHash: string;
  readonly createdByActorId: string;
  readonly createdAt: string;
}

export interface CreateQuerySetInput {
  readonly name: string;
  readonly industry: string;
  readonly description: string;
  readonly prompts: readonly QuerySetPrompt[];
}

export interface EvidenceSource {
  readonly id: string;
  readonly type: "url" | "document" | "manual" | "platform_readback";
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly validUntil: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ClaimFact {
  readonly id: string;
  readonly brandId: string;
  readonly normalizedKey: string;
  readonly claim: string;
  readonly status: "draft" | "verified" | "rejected" | "expired";
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface ContentClaim {
  readonly id: string;
  readonly text: string;
  readonly evidenceSourceIds: readonly string[];
  readonly validUntil: string | null;
}

export type CanonicalInlineBlock =
  | { readonly type: "template"; readonly templateId: string }
  | { readonly type: "claim"; readonly claimId: string }
  | { readonly type: "contact"; readonly contactId: string }
  | { readonly type: "authored"; readonly text: string; readonly claimIds: readonly string[] };

export type CanonicalBodyBlock =
  | { readonly type: "template"; readonly templateId: string }
  | {
      readonly type: "claim";
      readonly claimId: string;
      readonly presentation: "paragraph" | "bullet";
      readonly contactIds?: readonly string[];
    }
  | {
      readonly type: "contact";
      readonly contactId: string;
      readonly presentation: "paragraph" | "bullet";
    }
  | { readonly type: "authored"; readonly text: string; readonly claimIds: readonly string[] };

export interface MediaSearchIntent {
  readonly query: string;
  readonly role: "cover" | "inline";
  readonly rationale: string;
  readonly claimIds: readonly string[];
}

export interface PublicationPayload {
  readonly editorialProfile?:
    "guide" | "question_answer" | "comparison" | "risk_avoidance" | "local_service";
  readonly articleTemplateId?: string;
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly titleBlocks?: readonly CanonicalInlineBlock[];
  readonly summaryBlocks?: readonly CanonicalInlineBlock[];
  readonly bodyBlocks?: readonly CanonicalBodyBlock[];
  readonly tagTemplateIds?: readonly string[];
  readonly canonicalUrl?: string;
  readonly mediaSearchPlan?: readonly MediaSearchIntent[];
  readonly media: readonly Readonly<Record<string, unknown>>[];
  readonly claims: readonly ContentClaim[];
  readonly contactIds: readonly string[];
  readonly tags: readonly string[];
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export interface Campaign {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly status: CampaignStatus;
  readonly topicKey: string;
}

export interface CreateCampaignInput {
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly topicKey: string;
}

export interface CampaignTransitionInput {
  readonly status: Exclude<CampaignStatus, "draft">;
  readonly reason?: string;
}

export interface CampaignTransitionResult {
  readonly campaign: Campaign;
  readonly previousStatus: CampaignStatus;
  readonly wasChanged: boolean;
}

export interface ContentItem {
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

export interface PublicationVariant {
  readonly id: string;
  readonly contentVersionId: string;
  readonly channelAccountId: string;
  readonly platform: string;
  readonly variantVersion: number;
  readonly payload: PublicationPayload;
  readonly payloadHash: string;
  readonly state: string;
  readonly frozenAt: string | null;
}

export interface ContentVersion {
  readonly id: string;
  readonly contentItemId: string;
  readonly version: number;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly payload: PublicationPayload;
  readonly payloadHash: string;
  readonly frozenAt: string | null;
}

export type MediaImportRights =
  | {
      readonly kind: "tenant_owned";
      readonly ownershipAssertion: string;
      readonly licenseName: string;
    }
  | {
      readonly kind: "licensed_stock";
      readonly basis: "commercial_license" | "editorial_license";
      readonly sourceUrl: string;
      readonly licenseName: string;
      readonly licenseUrl: string;
      readonly attribution?: string;
      readonly rightsDescription: string;
    };

export interface MediaImportInput {
  readonly platform: "toutiao" | "sohu" | "ctrip_community";
  readonly role: "cover" | "inline";
  readonly claimIds: readonly string[];
  readonly idempotencyKey: string;
  readonly bytesBase64: string;
  readonly rights: MediaImportRights;
}

export interface MediaImportResult {
  readonly job: {
    readonly id: string;
    readonly state: string;
    readonly providerId: string;
    readonly providerMode: string;
  };
  readonly asset: {
    readonly id: string;
    readonly contentVersionId: string;
    readonly storageKey: string;
    readonly reference: Readonly<Record<string, unknown>>;
  } | null;
  readonly wasCreated: boolean;
  readonly contentInspectionRequired: boolean;
}

export interface MediaSearchImportResult {
  readonly provider: "wikimedia_commons";
  readonly sourceContentVersionId: string;
  readonly finalContentVersionId: string;
  readonly plannedCount: number;
  readonly imported: readonly {
    readonly intentIndex: number;
    readonly query: string;
    readonly role: "cover" | "inline";
    readonly providerAssetId: string;
    readonly sourceUrl: string;
    readonly assetId: string;
    readonly contentVersionId: string;
  }[];
  readonly rejectedCandidateCount: number;
  readonly rejectionCodes: readonly string[];
}

export interface PublicationJob {
  readonly id: string;
  readonly grantId: string;
  readonly auditArtifactId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: string;
  readonly executionLevel: string;
  readonly state: string;
  readonly payloadHash: string;
  readonly scheduledFor: string;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationAttempt {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNo: number;
  readonly state: string;
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface PublicationReceipt {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly platform: string;
  readonly executionLevel: string;
  readonly evidenceType: string;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly publishedAt: string | null;
  readonly confirmed: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface PublicationReadback {
  readonly id: string;
  readonly jobId: string;
  readonly receiptId: string;
  readonly status: string;
  readonly required: boolean;
  readonly reason: string | null;
  readonly scheduledFor: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationAssistedHandoff {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly channelAccountId: string;
  readonly variantId: string;
  readonly platform: "ctrip_community";
  readonly state:
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
  readonly submitCandidateExternalId: string | null;
  readonly submitCandidateExternalUrl: string | null;
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

export interface PublicationAssistedBridgeActionResult {
  readonly handoff: PublicationAssistedHandoff;
  readonly bridge: CtripBridgeResult;
}

export interface AuditFinding {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: string;
  readonly message: string;
  readonly path: string | null;
  readonly evidence: readonly string[];
}

export interface AuditArtifact {
  readonly id: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: string;
  readonly payloadHash: string;
  readonly factSnapshotHash: string;
  readonly policyHash: string;
  readonly policyVersion: string;
  readonly auditHash: string;
  readonly status: string;
  readonly findings: readonly AuditFinding[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ManualPublicationPackage {
  readonly schemaVersion: "geo.manual-publication-package.v1";
  readonly evidenceType: "preview";
  readonly platform: string;
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly variantId: string;
  readonly executionLevel: "dry_run";
  readonly auditArtifactId: string;
  readonly payloadHash: string;
  readonly auditHash: string;
  readonly previewHash: string;
  readonly requiresManualAction: true;
  readonly publicationStatus: "not_published";
  readonly confirmed: false;
  readonly exportedAt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly packageHash: string;
}

export interface PublicationAuthorization {
  readonly grantId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface AuditResult {
  readonly artifact: AuditArtifact;
  readonly publicationAuthorization: PublicationAuthorization | null;
  readonly wasCreated: boolean;
}

export interface PublicationRequestResult {
  readonly publicationJobId: string;
  readonly publicationOutboxEventId: string;
  readonly wasCreated: boolean;
}

export interface CreateEvidenceSourceInput {
  readonly type: EvidenceSource["type"];
  readonly title: string;
  readonly sourceUrl?: string | null;
  readonly content: string;
  readonly capturedAt: string;
  readonly validUntil?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateFactInput {
  readonly brandId: string;
  readonly normalizedKey: string;
  readonly claim: string;
  readonly status: "draft" | "verified";
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom?: string;
  readonly validUntil?: string | null;
}

export interface CreateContentInput {
  readonly campaignId: string;
  readonly brandId: string;
  readonly title: string;
  readonly contentType: string;
  readonly topicKey: string;
  readonly idempotencyKey: string;
  readonly payload: PublicationPayload;
}

export interface CreateVariantInput {
  readonly contentVersionId: string;
  readonly channelAccountId: string;
}

export interface PublicationRequestInput {
  readonly grantId: string;
  readonly token: string;
  readonly idempotencyKey: string;
  readonly executionLevel: "dry_run" | "assisted" | "unattended";
  readonly scheduledFor?: string;
}

export interface VisibilityProviderSummary {
  readonly provider: "doubao" | "qwen";
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: string;
  readonly observationMethod: string;
  readonly evidenceType: string;
  readonly observations: number;
  readonly brandMentionRate: number;
  readonly contactAccuracy: number;
  readonly averageAnswerPosition: number;
  readonly competitorMentionRate: number;
  readonly negativeSentimentRate: number;
  readonly hallucinationFindings: number;
  readonly harmfulErrors: number;
}

export type VisibilityProvider = "doubao" | "qwen";
export type VisibilityObservationMethod = "fixture" | "manual" | "official_api" | "browser";
export type VisibilitySentiment = "positive" | "neutral" | "negative" | "mixed";

export interface VisibilityHallucinationFinding {
  readonly code: string;
  readonly category: "contact" | "brand" | "qualification" | "control" | "other";
  readonly severity: "low" | "medium" | "high";
  readonly statement: string;
  readonly observedValue: string | null;
  readonly expectedValues: readonly string[];
}

export interface VisibilityRun {
  readonly id: string;
  readonly querySetVersionId: string;
  readonly provider: VisibilityProvider;
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly observationMethod: VisibilityObservationMethod;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly locale: string;
  readonly geo: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorMessage: string | null;
  readonly observationCount: number;
  readonly createdAt: string;
}

export interface VisibilityObservation {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly provider: VisibilityProvider;
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly observationMethod: VisibilityObservationMethod;
  readonly prompt: string;
  readonly promptVersion: string;
  readonly locale: string;
  readonly geo: string | null;
  readonly rawAnswer: string;
  readonly citedUrls: readonly string[];
  readonly evidenceHash: string;
  readonly evidenceType: string;
  readonly requestStartedAt: string;
  readonly responseReceivedAt: string;
  readonly observedAt: string;
  readonly brandMentioned: boolean;
  readonly answerPosition: number | null;
  readonly contactAccuracy: number;
  readonly competitorMentions: readonly string[];
  readonly sentiment: VisibilitySentiment;
  readonly hallucinationFindings: readonly VisibilityHallucinationFinding[];
  readonly harmfulError: boolean;
  readonly extractorVersion: string;
  readonly evaluatorVersion: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface VisibilityMetric {
  readonly name: string;
  readonly value: number;
  readonly sampleCount: number;
  readonly confidenceLow: number | null;
  readonly confidenceHigh: number | null;
  readonly dimensions: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface VisibilityRunDetail {
  readonly run: VisibilityRun;
  readonly observations: readonly VisibilityObservation[];
  readonly metrics: readonly VisibilityMetric[];
}

export interface RunFixtureVisibilityInput {
  readonly querySetVersionId: string;
  readonly provider: VisibilityProvider;
  readonly sampleCount: number;
  readonly idempotencyKey: string;
}

export interface ImportVisibilityInput {
  readonly querySetVersionId: string;
  readonly provider: VisibilityProvider;
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: "on" | "off" | "unknown";
  readonly locale: string;
  readonly geo: string | null;
  readonly idempotencyKey: string;
  readonly samples: readonly {
    readonly queryKey: string;
    readonly rawAnswer: string;
    readonly citedUrls: readonly string[];
    readonly requestStartedAt: string;
    readonly responseReceivedAt: string;
    readonly observedAt: string;
  }[];
}

export interface VisibilityRunResult {
  readonly visibilityRunId: string;
  readonly status: "completed";
  readonly providerMode: "fixture" | "manual";
  readonly evidenceType: "fixture" | "manual_import";
  readonly wasCreated: boolean;
}

export type AutomationMode = "shadow" | "supervised" | "unattended" | "paused" | "stopped";

export interface AutomationQuota {
  readonly [key: string]: number;
  readonly maxConcurrent: number;
  readonly perMinute: number;
  readonly perDay: number;
  readonly cooldownSeconds: number;
  readonly errorBudget: number;
}

export interface AutomationControl {
  readonly mode: AutomationMode;
  readonly killSwitchEnabled: boolean;
  readonly reason: string | null;
  readonly quota: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export type AutomationScopeType = "tenant" | "platform" | "account" | "campaign" | "topic";

export interface ScopedAutomationControl extends AutomationControl {
  readonly id: string;
  readonly scopeType: AutomationScopeType;
  readonly scopeKey: string;
}

export interface AutomationCircuit {
  readonly id: string;
  readonly scopeType: AutomationScopeType;
  readonly scopeKey: string;
  readonly state: "closed" | "open" | "half_open";
  readonly failureCount: number;
  readonly openedAt: string | null;
  readonly retryAt: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface AutomationSnapshot {
  readonly control: AutomationControl;
  readonly controls: readonly ScopedAutomationControl[];
  readonly circuits: readonly AutomationCircuit[];
}

export type AutomationBatchState =
  "scheduled" | "running" | "completed" | "partially_failed" | "cancelled";

export type AutomationRunState =
  | "scheduled"
  | "running"
  | "retry_wait"
  | "awaiting_delivery"
  | "completed"
  | "partially_failed"
  | "blocked"
  | "failed"
  | "cancelled";

export type AutomationRunStage = "planning" | "draft" | "targets" | "delivery";

export type AutomationRunTargetState =
  | "pending"
  | "variant_ready"
  | "audit_failed"
  | "awaiting_delivery"
  | "preview_completed"
  | "confirmed"
  | "blocked"
  | "failed"
  | "cancelled";

export type AutomationPlatform = "toutiao" | "sohu" | "ctrip_community";

export interface CreateAutomationBatchItemInput {
  readonly slotKey: string;
  readonly scheduledFor: string;
  readonly topicKey: string;
  readonly brief: string;
  readonly channelAccountIds: readonly string[];
}

export interface CreateAutomationBatchInput {
  readonly idempotencyKey: string;
  readonly name?: string;
  readonly executionLevel?: "dry_run" | "assisted" | "unattended";
  readonly items: readonly CreateAutomationBatchItemInput[];
}

export interface AutomationBatch {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string | null;
  readonly state: AutomationBatchState;
  readonly executionLevel: "dry_run" | "assisted" | "unattended";
  readonly scheduledFor: string;
  readonly runCount: number;
  readonly completedRunCount: number;
  readonly failedRunCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunTarget {
  readonly id: string;
  readonly runId: string;
  readonly channelAccountId: string;
  readonly platform: AutomationPlatform;
  readonly state: AutomationRunTargetState;
  readonly variantId: string | null;
  readonly auditRunId: string | null;
  readonly auditArtifactId: string | null;
  readonly publicationJobId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRun {
  readonly id: string;
  readonly batchId: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly executionLevel: "dry_run" | "assisted" | "unattended";
  readonly slotKey: string;
  readonly topicKey: string;
  readonly brief: string;
  readonly state: AutomationRunState;
  readonly stage: AutomationRunStage;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targets: readonly AutomationRunTarget[];
}

export interface AutomationBatchCreateResult {
  readonly batch: AutomationBatch;
  readonly wasCreated: boolean;
}

export interface AutomationBatchCancellationResult {
  readonly batchId: string;
  readonly state: AutomationBatchState;
  readonly cancelledRuns: number;
  readonly cancelledTargets: number;
  readonly wasChanged: boolean;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly tenantSlug?: string;
}

export interface ApiErrorDetails {
  readonly tenants?: readonly TenantOption[];
  readonly [key: string]: unknown;
}

export interface ArticleTemplateCatalogView {
  readonly version: typeof ARTICLE_TEMPLATE_CATALOG_VERSION;
  readonly items: readonly ArticleTemplate[];
}

export type AgentRunCapability =
  | {
      readonly available: true;
      readonly mode: "fixture" | "pi";
      readonly provider: string;
      readonly model: string;
    }
  | {
      readonly available: false;
      readonly mode: "disabled" | "unavailable";
      readonly provider: null;
      readonly model: null;
      readonly reason: "tenant_not_configured" | "runner_disabled" | "service_unavailable";
    };

export interface CustomerSetupReadiness {
  readonly schemaVersion: "geo.customer-setup-readiness.v1";
  readonly deploymentProfile: "standard" | "customer_demo";
  readonly governanceMode: "external" | "demo_fixture";
  readonly articleGenerationReady: boolean;
  readonly ctripSimulationReady: boolean;
  readonly externalPublishingEnabled: boolean;
  readonly checks: {
    readonly agent: boolean;
    readonly ctripAccount: boolean;
    readonly assistedEvidence: boolean;
    readonly bridgeIdentity: boolean;
    readonly bridgeRuntime: boolean;
    readonly prePublicationAudit: boolean;
  };
}

export interface CtripBridgeStatus {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly mode:
    | "simulator"
    | "browser_preflight"
    | "browser_draft"
    | "browser_supervised"
    | "browser_unattended"
    | null;
  readonly adapterVersion: string | null;
  readonly commandCapabilities: {
    readonly prepare: boolean;
    readonly submit: boolean;
    readonly readback: boolean;
  } | null;
  readonly operationalStatus: "ready" | "session_required" | "challenge_required" | "unavailable";
  readonly operationalCheckedAt: string | null;
}

export interface RunAgentInput {
  readonly brandId: string;
  readonly campaignId: string;
  readonly channelAccountId: string;
  readonly platform: "toutiao" | "sohu" | "ctrip_community";
  readonly topic: string;
  readonly articleTemplateId: string;
  readonly idempotencyKey: string;
}

export type AgentRunResult =
  | {
      readonly providerMode: "fixture";
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly variantId: string;
      readonly auditRunId: string;
      readonly auditArtifactId: string;
      readonly publicationRequestId: string;
      readonly publicationJobId: string;
      readonly outboxEventId: string;
      readonly steps: readonly string[];
    }
  | {
      readonly providerMode: "pi";
      readonly provider: string;
      readonly model: string;
      readonly response: string;
      readonly messageCount: number;
    };

export interface AgentRunResponse {
  readonly capability: {
    readonly mode: "fixture" | "pi";
    readonly provider: string;
    readonly model: string;
  };
  readonly result: AgentRunResult;
}

export class GeoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details: ApiErrorDetails | null = null,
  ) {
    super(message);
    this.name = "GeoApiError";
  }
}

export interface GeoApi {
  getSession(): Promise<SessionSnapshot>;
  login(input: LoginInput): Promise<SessionSnapshot>;
  logout(): Promise<void>;
  getTenants(): Promise<readonly TenantOption[]>;
  switchTenant(tenantSlug: string): Promise<SessionSnapshot>;
  getTenant(): Promise<TenantView>;
  getContacts(): Promise<readonly TenantContact[]>;
  createContact(input: CreateContactInput): Promise<TenantContact>;
  expireContact(contactId: string, input: ExpireContactInput): Promise<TenantContact>;
  getChannelAccounts(): Promise<readonly ChannelAccount[]>;
  createChannelAccount(input: CreateChannelAccountInput): Promise<ChannelAccount>;
  updateChannelAccount(
    channelAccountId: string,
    input: UpdateChannelAccountInput,
  ): Promise<ChannelAccount>;
  getBrands(): Promise<readonly Brand[]>;
  getBrandAgentProfiles(): Promise<readonly BrandAgentProfile[]>;
  createBrandAgentProfile(
    brandId: string,
    input: CreateBrandAgentProfileInput,
  ): Promise<BrandAgentProfile>;
  getMembers(): Promise<readonly TenantMember[]>;
  createMember(input: CreateMemberInput): Promise<TenantMember>;
  updateMember(memberId: string, input: UpdateMemberInput): Promise<TenantMember>;
  getPolicies(): Promise<readonly PolicyBundle[]>;
  createPolicy(input: CreatePolicyInput): Promise<PolicyBundle>;
  transitionPolicy(policyId: string, input: PolicyTransitionInput): Promise<PolicyTransitionResult>;
  getServicePrincipals(): Promise<readonly ServicePrincipal[]>;
  createAutomationServicePrincipal(input: { readonly name: string }): Promise<ServicePrincipal>;
  createCtripBridgeServicePrincipal(input: { readonly name: string }): Promise<ServicePrincipal>;
  setServicePrincipalStatus(
    principalId: string,
    input: { readonly status: "active" | "disabled"; readonly reason: string },
  ): Promise<{ readonly principal: ServicePrincipal; readonly wasChanged: boolean }>;
  getQuerySets(): Promise<readonly QuerySet[]>;
  createQuerySet(input: CreateQuerySetInput): Promise<QuerySet>;
  getQuerySetVersions(querySetId: string): Promise<readonly QuerySetVersion[]>;
  createQuerySetVersion(
    querySetId: string,
    input: { readonly prompts: readonly QuerySetPrompt[]; readonly reason: string },
  ): Promise<QuerySetVersion>;
  activateQuerySetVersion(
    querySetId: string,
    versionId: string,
    reason: string,
  ): Promise<{
    readonly querySet: QuerySet;
    readonly previousVersion: number;
    readonly previousStatus: QuerySet["status"];
    readonly wasChanged: boolean;
  }>;
  transitionQuerySet(
    querySetId: string,
    targetStatus: "retired",
    reason: string,
  ): Promise<{
    readonly querySet: QuerySet;
    readonly previousStatus: QuerySet["status"];
    readonly wasChanged: boolean;
  }>;
  getArticleTemplates(): Promise<ArticleTemplateCatalogView>;
  getSetupReadiness(): Promise<CustomerSetupReadiness>;
  getCtripBridgeStatus(): Promise<CtripBridgeStatus>;
  getAgentCapability(): Promise<AgentRunCapability>;
  runAgent(input: RunAgentInput): Promise<AgentRunResponse>;
  getEvidenceSources(): Promise<readonly EvidenceSource[]>;
  createEvidenceSource(input: CreateEvidenceSourceInput): Promise<EvidenceSource>;
  getFacts(): Promise<readonly ClaimFact[]>;
  createFact(input: CreateFactInput): Promise<ClaimFact>;
  getCampaigns(): Promise<readonly Campaign[]>;
  createCampaign(input: CreateCampaignInput): Promise<Campaign>;
  transitionCampaignState(
    campaignId: string,
    input: CampaignTransitionInput,
  ): Promise<CampaignTransitionResult>;
  getContent(): Promise<readonly ContentItem[]>;
  createContent(input: CreateContentInput): Promise<ContentItem>;
  createContentVersion(contentId: string, payload: PublicationPayload): Promise<ContentItem>;
  getContentVersion(contentVersionId: string): Promise<ContentVersion>;
  importMedia(contentVersionId: string, input: MediaImportInput): Promise<MediaImportResult>;
  searchAndImportMedia(
    contentVersionId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<MediaSearchImportResult>;
  getContentVariants(contentId: string): Promise<readonly PublicationVariant[]>;
  createContentVariant(contentId: string, input: CreateVariantInput): Promise<PublicationVariant>;
  auditVariant(variantId: string, idempotencyKey: string): Promise<AuditResult>;
  getAudits(): Promise<readonly AuditArtifact[]>;
  exportManualPublicationPackage(artifactId: string): Promise<ManualPublicationPackage>;
  getPublicationJobs(): Promise<readonly PublicationJob[]>;
  getPublicationJob(jobId: string): Promise<PublicationJob>;
  requestPublication(input: PublicationRequestInput): Promise<PublicationRequestResult>;
  revokePublicationGrant(
    grantId: string,
    reason: string,
  ): Promise<{
    readonly grantId: string;
    readonly status: "revoked";
    readonly revokedAt: string;
    readonly wasChanged: boolean;
  }>;
  cancelPublicationJob(
    jobId: string,
    reason: string,
  ): Promise<{
    readonly job: PublicationJob;
    readonly wasChanged: boolean;
  }>;
  getPublicationAttempts(jobId: string): Promise<readonly PublicationAttempt[]>;
  getPublicationReceipts(jobId: string): Promise<readonly PublicationReceipt[]>;
  getPublicationReadbacks(jobId: string): Promise<readonly PublicationReadback[]>;
  getPublicationAssistedHandoffs(): Promise<readonly PublicationAssistedHandoff[]>;
  getPublicationAssistedHandoff(handoffId: string): Promise<PublicationAssistedHandoff>;
  claimPublicationAssistedHandoff(
    handoffId: string,
    leaseSeconds?: number,
  ): Promise<PublicationAssistedHandoff>;
  heartbeatPublicationAssistedHandoff(
    handoffId: string,
    leaseSeconds?: number,
  ): Promise<PublicationAssistedHandoff>;
  cancelPublicationAssistedHandoff(
    handoffId: string,
    reason: string,
  ): Promise<{
    readonly handoff: PublicationAssistedHandoff;
    readonly wasChanged: boolean;
  }>;
  preparePublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult>;
  submitPublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult>;
  readbackPublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult>;
  getReceipts(): Promise<readonly PublicationReceipt[]>;
  getReceipt(receiptId: string): Promise<PublicationReceipt>;
  getVisibilitySummary(): Promise<readonly VisibilityProviderSummary[]>;
  getVisibilityRuns(): Promise<readonly VisibilityRun[]>;
  getVisibilityRun(runId: string): Promise<VisibilityRunDetail>;
  runFixtureVisibility(input: RunFixtureVisibilityInput): Promise<VisibilityRunResult>;
  importVisibility(input: ImportVisibilityInput): Promise<VisibilityRunResult>;
  createAutomationBatch(
    campaignId: string,
    input: CreateAutomationBatchInput,
  ): Promise<AutomationBatchCreateResult>;
  getAutomationBatches(): Promise<readonly AutomationBatch[]>;
  getAutomationRuns(): Promise<readonly AutomationRun[]>;
  getAutomationRun(runId: string): Promise<AutomationRun>;
  cancelAutomationBatch(
    batchId: string,
    reason: string,
  ): Promise<AutomationBatchCancellationResult>;
  getAutomation(): Promise<AutomationSnapshot>;
  setAutomationControl(input: {
    readonly mode: AutomationMode;
    readonly quota: AutomationQuota;
    readonly reason: string;
  }): Promise<AutomationControl>;
  setScopedAutomationControl(
    scopeType: Exclude<AutomationScopeType, "tenant">,
    scopeKey: string,
    input: {
      readonly mode: AutomationMode;
      readonly quota: AutomationQuota;
      readonly killSwitchEnabled: boolean;
      readonly reason: string;
    },
  ): Promise<ScopedAutomationControl>;
  setCircuitBreakerState(
    scopeType: AutomationScopeType,
    scopeKey: string,
    input: {
      readonly targetState: "open" | "closed";
      readonly retryAt?: string | null;
      readonly reason: string;
    },
  ): Promise<AutomationCircuit>;
  setKillSwitch(input: {
    readonly enabled: boolean;
    readonly reason: string;
  }): Promise<AutomationControl>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  return value;
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw protocolError(`${key} must be a string`);
  return value;
}

function nullableStringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw protocolError(`${key} must be a string or null`);
  return value;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> {
  return recordValue(record[key], key);
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(`${key} must be a finite number`);
  }
  return value;
}

function nullableNumberValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(`${key} must be a finite number or null`);
  }
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw protocolError(`${key} must be a boolean`);
  return value;
}

function stringArrayValue(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw protocolError(`${key} must be a string array`);
  }
  return value;
}

function stringEnumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  supported: readonly T[],
): T {
  const value = stringValue(record, key);
  if (!supported.includes(value as T)) {
    throw protocolError(`unsupported ${key}: ${value}`);
  }
  return value as T;
}

function nullableEnumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  supported: readonly T[],
): T | null {
  if (record[key] === null) return null;
  return stringEnumValue(record, key, supported);
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function protocolError(message: string): GeoApiError {
  return new GeoApiError(0, "INVALID_API_RESPONSE", `API response mismatch: ${message}`);
}

function itemsValue<T>(payload: unknown, parser: (item: unknown) => T): readonly T[] {
  const body = recordValue(payload, "response");
  const items = body.items;
  if (!Array.isArray(items)) throw protocolError("items must be an array");
  return items.map(parser);
}

function parseTenantOption(value: unknown): TenantOption {
  const item = recordValue(value, "tenant option");
  const status = optionalString(item, "status");
  if (status !== null && status !== "active" && status !== "unavailable") {
    throw protocolError(`unsupported tenant membership status: ${status}`);
  }
  return {
    slug: stringValue(item, "slug"),
    displayName: stringValue(item, "displayName"),
    ...(optionalString(item, "id") === null ? {} : { id: optionalString(item, "id") as string }),
    ...(optionalString(item, "role") === null
      ? {}
      : { role: optionalString(item, "role") as string }),
    ...(status === null ? {} : { status }),
  };
}

const ARTICLE_TEMPLATE_FIELDS = new Set([
  "id",
  "name",
  "category",
  "editorialProfile",
  "scenario",
  "travelExample",
  "benefit",
  "geoMechanisms",
  "outline",
  "evidenceRequirements",
  "riskBoundaries",
]);

function parseArticleTemplate(value: unknown): ArticleTemplate {
  const item = recordValue(value, "article template");
  const unexpected = Object.keys(item).find((key) => !ARTICLE_TEMPLATE_FIELDS.has(key));
  if (unexpected !== undefined) {
    throw protocolError(`article template contains unsupported field: ${unexpected}`);
  }
  const id = stringValue(item, "id");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw protocolError(`invalid article template id: ${id}`);
  }
  const requiredText = (key: string) => {
    const text = stringValue(item, key);
    if (text.trim().length === 0) throw protocolError(`${key} must not be empty`);
    return text;
  };
  const requiredList = (key: string) => {
    const values = stringArrayValue(item, key);
    if (values.length === 0 || values.some((entry) => entry.trim().length === 0)) {
      throw protocolError(`${key} must contain non-empty strings`);
    }
    return values;
  };
  return {
    id,
    name: requiredText("name"),
    category: stringEnumValue<ArticleTemplateCategory>(item, "category", [
      "answer",
      "decision",
      "service",
      "trust",
      "freshness",
    ]),
    editorialProfile: stringEnumValue<GovernedEditorialProfile>(item, "editorialProfile", [
      "guide",
      "question_answer",
      "comparison",
      "risk_avoidance",
      "local_service",
    ]),
    scenario: requiredText("scenario"),
    travelExample: requiredText("travelExample"),
    benefit: requiredText("benefit"),
    geoMechanisms: requiredList("geoMechanisms"),
    outline: requiredList("outline"),
    evidenceRequirements: requiredList("evidenceRequirements"),
    riskBoundaries: requiredList("riskBoundaries"),
  };
}

function parseArticleTemplateCatalog(value: unknown): ArticleTemplateCatalogView {
  const body = recordValue(value, "article template catalog");
  const version = stringValue(body, "version");
  if (version !== ARTICLE_TEMPLATE_CATALOG_VERSION) {
    throw protocolError(`unsupported article template catalog version: ${version}`);
  }
  if (!Array.isArray(body.items) || body.items.length < 20) {
    throw protocolError("article template catalog must contain at least 20 items");
  }
  const items = body.items.map(parseArticleTemplate);
  if (new Set(items.map((template) => template.id)).size !== items.length) {
    throw protocolError("article template IDs must be unique");
  }
  return { version: ARTICLE_TEMPLATE_CATALOG_VERSION, items };
}

function parseAgentCapability(value: unknown): AgentRunCapability {
  const item = recordValue(value, "agent capability");
  const available = booleanValue(item, "available");
  if (available) {
    return {
      available: true,
      mode: stringEnumValue(item, "mode", ["fixture", "pi"] as const),
      provider: stringValue(item, "provider"),
      model: stringValue(item, "model"),
    };
  }
  if (item.provider !== null || item.model !== null) {
    throw protocolError("disabled agent capability must not expose provider details");
  }
  return {
    available: false,
    mode: stringEnumValue(item, "mode", ["disabled", "unavailable"] as const),
    provider: null,
    model: null,
    reason: stringEnumValue(item, "reason", [
      "tenant_not_configured",
      "runner_disabled",
      "service_unavailable",
    ] as const),
  };
}

function parseCustomerSetupReadiness(value: unknown): CustomerSetupReadiness {
  const item = recordValue(value, "customer setup readiness");
  const checks = recordValue(item.checks, "customer setup checks");
  const schemaVersion = stringValue(item, "schemaVersion");
  if (schemaVersion !== "geo.customer-setup-readiness.v1") {
    throw protocolError(`unsupported customer setup schema: ${schemaVersion}`);
  }
  const externalPublishingEnabled = booleanValue(item, "externalPublishingEnabled");
  return {
    schemaVersion,
    deploymentProfile: stringEnumValue(item, "deploymentProfile", [
      "standard",
      "customer_demo",
    ] as const),
    governanceMode: stringEnumValue(item, "governanceMode", ["external", "demo_fixture"] as const),
    articleGenerationReady: booleanValue(item, "articleGenerationReady"),
    ctripSimulationReady: booleanValue(item, "ctripSimulationReady"),
    externalPublishingEnabled,
    checks: {
      agent: booleanValue(checks, "agent"),
      ctripAccount: booleanValue(checks, "ctripAccount"),
      assistedEvidence: booleanValue(checks, "assistedEvidence"),
      bridgeIdentity: booleanValue(checks, "bridgeIdentity"),
      bridgeRuntime: booleanValue(checks, "bridgeRuntime"),
      prePublicationAudit: booleanValue(checks, "prePublicationAudit"),
    },
  };
}

function parseCtripBridgeStatus(value: unknown): CtripBridgeStatus {
  const item = recordValue(value, "Ctrip bridge status");
  const commandCapabilities =
    item.commandCapabilities === null
      ? null
      : (() => {
          const capabilities = recordField(item, "commandCapabilities");
          return {
            prepare: booleanValue(capabilities, "prepare"),
            submit: booleanValue(capabilities, "submit"),
            readback: booleanValue(capabilities, "readback"),
          };
        })();
  return {
    configured: booleanValue(item, "configured"),
    reachable: booleanValue(item, "reachable"),
    mode: nullableEnumValue(item, "mode", [
      "simulator",
      "browser_preflight",
      "browser_draft",
      "browser_supervised",
      "browser_unattended",
    ] as const),
    adapterVersion: nullableStringValue(item, "adapterVersion"),
    commandCapabilities,
    operationalStatus: stringEnumValue(item, "operationalStatus", [
      "ready",
      "session_required",
      "challenge_required",
      "unavailable",
    ] as const),
    operationalCheckedAt: nullableStringValue(item, "operationalCheckedAt"),
  };
}

function parseAgentRunResponse(value: unknown): AgentRunResponse {
  const item = recordValue(value, "agent run response");
  const capability = recordValue(item.capability, "agent run capability");
  const mode = stringEnumValue(capability, "mode", ["fixture", "pi"] as const);
  const result = recordValue(item.result, "agent run result");
  const providerMode = stringEnumValue(result, "providerMode", ["fixture", "pi"] as const);
  if (providerMode !== mode) throw protocolError("agent run mode does not match capability");
  return {
    capability: {
      mode,
      provider: stringValue(capability, "provider"),
      model: stringValue(capability, "model"),
    },
    result:
      providerMode === "fixture"
        ? {
            providerMode,
            contentItemId: stringValue(result, "contentItemId"),
            contentVersionId: stringValue(result, "contentVersionId"),
            variantId: stringValue(result, "variantId"),
            auditRunId: stringValue(result, "auditRunId"),
            auditArtifactId: stringValue(result, "auditArtifactId"),
            publicationRequestId: stringValue(result, "publicationRequestId"),
            publicationJobId: stringValue(result, "publicationJobId"),
            outboxEventId: stringValue(result, "outboxEventId"),
            steps: stringArrayValue(result, "steps"),
          }
        : {
            providerMode,
            provider: stringValue(result, "provider"),
            model: stringValue(result, "model"),
            response: stringValue(result, "response"),
            messageCount: numberValue(result, "messageCount"),
          },
  };
}

function parseSession(value: unknown): SessionSnapshot {
  const body = recordValue(value, "session response");
  const actor = recordValue(body.actor, "actor");
  const tenant = recordValue(body.tenant, "tenant");
  const session = isRecord(body.session) ? body.session : body;
  const actorId = optionalString(actor, "id") ?? optionalString(actor, "actorId");
  if (actorId === null) throw protocolError("actor id is missing");
  return {
    actor: {
      id: actorId,
      displayName: optionalString(actor, "displayName"),
      role: stringValue(actor, "role"),
      capabilities: stringArrayValue(actor, "capabilities"),
    },
    tenant: {
      id: stringValue(tenant, "id"),
      slug: stringValue(tenant, "slug"),
      displayName: stringValue(tenant, "displayName"),
    },
    expiresAt: stringValue(session, "expiresAt"),
  };
}

function parseTenant(value: unknown): TenantView {
  const item = recordValue(value, "tenant");
  return {
    id: stringValue(item, "id"),
    slug: stringValue(item, "slug"),
    displayName: stringValue(item, "displayName"),
    legalName: stringValue(item, "legalName"),
    industry: stringValue(item, "industry"),
    status: stringValue(item, "status"),
    defaultLocale: stringValue(item, "defaultLocale"),
  };
}

function parseContact(value: unknown): TenantContact {
  const item = recordValue(value, "contact");
  return {
    id: stringValue(item, "id"),
    tenantId: stringValue(item, "tenantId"),
    type: stringValue(item, "type"),
    label: stringValue(item, "label"),
    value: stringValue(item, "value"),
    isPrimary: booleanValue(item, "isPrimary"),
    validFrom: stringValue(item, "validFrom"),
    validUntil: nullableStringValue(item, "validUntil"),
  };
}

function parseChannelAccount(value: unknown): ChannelAccount {
  const item = recordValue(value, "channel account");
  return {
    id: stringValue(item, "id"),
    platform: stringValue(item, "platform"),
    displayName: stringValue(item, "displayName"),
    capability: stringValue(item, "capability"),
    supportedExecutionLevels: stringArrayValue(item, "supportedExecutionLevels"),
    evidenceType: stringValue(item, "evidenceType"),
    evidenceRefs: stringArrayValue(item, "evidenceRefs"),
    status: stringValue(item, "status"),
    lastVerifiedAt: nullableStringValue(item, "lastVerifiedAt"),
  };
}

function parseServicePrincipal(value: unknown): ServicePrincipal {
  const item = recordValue(value, "service principal");
  const kind = stringValue(item, "kind");
  const profile = stringValue(item, "profile");
  const status = stringValue(item, "status");
  const credentialStatus = stringValue(item, "credentialStatus");
  if (!["api", "worker", "agent", "integration"].includes(kind)) {
    throw protocolError(`unsupported service principal kind: ${kind}`);
  }
  if (!["custom", "automation_producer", "ctrip_bridge"].includes(profile)) {
    throw protocolError(`unsupported service principal profile: ${profile}`);
  }
  if (status !== "active" && status !== "disabled") {
    throw protocolError(`unsupported service principal status: ${status}`);
  }
  if (!["not_issued", "active", "expired", "revoked"].includes(credentialStatus)) {
    throw protocolError(`unsupported service principal credential status: ${credentialStatus}`);
  }
  return {
    id: stringValue(item, "id"),
    tenantId: stringValue(item, "tenantId"),
    name: stringValue(item, "name"),
    kind: kind as ServicePrincipal["kind"],
    profile: profile as ServicePrincipal["profile"],
    capabilities: stringArrayValue(item, "capabilities"),
    status: status as ServicePrincipal["status"],
    credentialStatus: credentialStatus as ServicePrincipal["credentialStatus"],
    lastUsedAt: nullableStringValue(item, "lastUsedAt"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseBrand(value: unknown): Brand {
  const item = recordValue(value, "brand");
  return {
    id: stringValue(item, "id"),
    canonicalName: stringValue(item, "canonicalName"),
    displayName: stringValue(item, "displayName"),
    aliases: stringArrayValue(item, "aliases"),
    description: nullableStringValue(item, "description"),
    industry: stringValue(item, "industry"),
    websiteUrl: nullableStringValue(item, "websiteUrl"),
    isPrimary: booleanValue(item, "isPrimary"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseBrandAgentProfileDocument(value: unknown): BrandAgentProfileDocument {
  const document = recordValue(value, "Brand Agent Profile document");
  const schemaVersion = stringValue(document, "schemaVersion");
  if (schemaVersion !== "geo.brand-agent-profile.v1") {
    throw protocolError(`unsupported Brand Agent Profile schema: ${schemaVersion}`);
  }
  return {
    schemaVersion,
    voice: stringValue(document, "voice"),
    audiences: stringArrayValue(document, "audiences"),
    objectives: stringArrayValue(document, "objectives"),
    requiredPoints: stringArrayValue(document, "requiredPoints"),
    forbiddenClaims: stringArrayValue(document, "forbiddenClaims"),
    callToAction: stringValue(document, "callToAction"),
    agentInstructions: stringValue(document, "agentInstructions"),
  };
}

function parseBrandAgentProfile(value: unknown): BrandAgentProfile {
  const item = recordValue(value, "Brand Agent Profile");
  const status = stringValue(item, "status");
  const version = numberValue(item, "version");
  const documentHash = stringValue(item, "documentHash");
  if (status !== "active" && status !== "retired") {
    throw protocolError(`unsupported Brand Agent Profile status: ${status}`);
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw protocolError("Brand Agent Profile version must be a positive safe integer");
  }
  if (!/^[a-f0-9]{64}$/u.test(documentHash)) {
    throw protocolError("Brand Agent Profile documentHash must be SHA-256");
  }
  return {
    id: stringValue(item, "id"),
    brandId: stringValue(item, "brandId"),
    version,
    status,
    document: parseBrandAgentProfileDocument(item.document),
    documentHash,
    effectiveAt: stringValue(item, "effectiveAt"),
    retiredAt: nullableStringValue(item, "retiredAt"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseTenantMember(value: unknown): TenantMember {
  const item = recordValue(value, "tenant member");
  const status = stringValue(item, "status");
  if (status !== "active" && status !== "suspended") {
    throw protocolError(`unsupported tenant member status: ${status}`);
  }
  return {
    id: stringValue(item, "id"),
    userId: stringValue(item, "userId"),
    email: stringValue(item, "email"),
    displayName: stringValue(item, "displayName"),
    role: stringValue(item, "role"),
    capabilities: stringArrayValue(item, "capabilities"),
    status,
    createdAt: stringValue(item, "createdAt"),
  };
}

function parsePolicyBundle(value: unknown): PolicyBundle {
  const item = recordValue(value, "policy bundle");
  const status = stringValue(item, "status");
  if (status !== "draft" && status !== "active" && status !== "retired") {
    throw protocolError(`unsupported policy status: ${status}`);
  }
  return {
    id: stringValue(item, "id"),
    version: stringValue(item, "version"),
    status,
    policyHash: stringValue(item, "policyHash"),
    document: recordField(item, "document"),
    effectiveAt: stringValue(item, "effectiveAt"),
    retiredAt: nullableStringValue(item, "retiredAt"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseQuerySet(value: unknown): QuerySet {
  const item = recordValue(value, "query set");
  const status = stringValue(item, "status");
  if (status !== "draft" && status !== "active" && status !== "retired") {
    throw protocolError(`unsupported query set status: ${status}`);
  }
  return {
    id: stringValue(item, "id"),
    name: stringValue(item, "name"),
    industry: stringValue(item, "industry"),
    status,
    currentVersion: numberValue(item, "currentVersion"),
    description: stringValue(item, "description"),
    currentVersionId: nullableStringValue(item, "currentVersionId"),
    prompts: item.prompts,
    promptHash: nullableStringValue(item, "promptHash"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseQuerySetPrompt(value: unknown): QuerySetPrompt {
  const item = recordValue(value, "query-set prompt");
  return {
    key: stringValue(item, "key"),
    category: stringValue(item, "category"),
    prompt: stringValue(item, "prompt"),
  };
}

function parseQuerySetVersion(value: unknown): QuerySetVersion {
  const item = recordValue(value, "query-set version");
  if (!Array.isArray(item.prompts)) throw protocolError("prompts must be an array");
  return {
    id: stringValue(item, "id"),
    querySetId: stringValue(item, "querySetId"),
    version: numberValue(item, "version"),
    prompts: item.prompts.map(parseQuerySetPrompt),
    promptHash: stringValue(item, "promptHash"),
    createdByActorId: stringValue(item, "createdByActorId"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseEvidenceSource(value: unknown): EvidenceSource {
  const item = recordValue(value, "evidence source");
  const type = stringValue(item, "type");
  if (!["url", "document", "manual", "platform_readback"].includes(type)) {
    throw protocolError(`unsupported evidence source type: ${type}`);
  }
  return {
    id: stringValue(item, "id"),
    type: type as EvidenceSource["type"],
    title: stringValue(item, "title"),
    sourceUrl: nullableStringValue(item, "sourceUrl"),
    contentHash: stringValue(item, "contentHash"),
    capturedAt: stringValue(item, "capturedAt"),
    validUntil: nullableStringValue(item, "validUntil"),
    metadata: recordField(item, "metadata"),
  };
}

function parseFact(value: unknown): ClaimFact {
  const item = recordValue(value, "claim fact");
  const status = stringValue(item, "status");
  if (!["draft", "verified", "rejected", "expired"].includes(status)) {
    throw protocolError(`unsupported fact status: ${status}`);
  }
  return {
    id: stringValue(item, "id"),
    brandId: stringValue(item, "brandId"),
    normalizedKey: stringValue(item, "normalizedKey"),
    claim: stringValue(item, "claim"),
    status: status as ClaimFact["status"],
    evidenceSourceIds: stringArrayValue(item, "evidenceSourceIds"),
    validFrom: stringValue(item, "validFrom"),
    validUntil: nullableStringValue(item, "validUntil"),
  };
}

function parseContentClaim(value: unknown): ContentClaim {
  const item = recordValue(value, "content claim");
  return {
    id: stringValue(item, "id"),
    text: stringValue(item, "text"),
    evidenceSourceIds: stringArrayValue(item, "evidenceSourceIds"),
    validUntil: nullableStringValue(item, "validUntil"),
  };
}

function parseCanonicalInlineBlock(value: unknown): CanonicalInlineBlock {
  const item = recordValue(value, "canonical inline block");
  const type = stringValue(item, "type");
  if (type === "template") return { type, templateId: stringValue(item, "templateId") };
  if (type === "claim") return { type, claimId: stringValue(item, "claimId") };
  if (type === "contact") return { type, contactId: stringValue(item, "contactId") };
  if (type === "authored") {
    return {
      type,
      text: stringValue(item, "text"),
      claimIds: stringArrayValue(item, "claimIds"),
    };
  }
  throw protocolError(`unsupported canonical inline block type: ${type}`);
}

function parseCanonicalBodyBlock(value: unknown): CanonicalBodyBlock {
  const item = recordValue(value, "canonical body block");
  const type = stringValue(item, "type");
  if (type === "template") return { type, templateId: stringValue(item, "templateId") };
  if (type === "authored") {
    return {
      type,
      text: stringValue(item, "text"),
      claimIds: stringArrayValue(item, "claimIds"),
    };
  }
  const presentation = stringValue(item, "presentation");
  if (presentation !== "paragraph" && presentation !== "bullet") {
    throw protocolError(`unsupported canonical block presentation: ${presentation}`);
  }
  if (type === "claim") {
    return {
      type,
      claimId: stringValue(item, "claimId"),
      presentation,
      ...(item.contactIds === undefined
        ? {}
        : { contactIds: stringArrayValue(item, "contactIds") }),
    };
  }
  if (type === "contact") {
    return { type, contactId: stringValue(item, "contactId"), presentation };
  }
  throw protocolError(`unsupported canonical body block type: ${type}`);
}

function parsePublicationPayload(value: unknown): PublicationPayload {
  const item = recordValue(value, "publication payload");
  if (!Array.isArray(item.media)) throw protocolError("media must be an array");
  if (!Array.isArray(item.claims)) throw protocolError("claims must be an array");
  const canonicalUrl = optionalString(item, "canonicalUrl");
  const editorialProfile = optionalString(item, "editorialProfile");
  const articleTemplateId = optionalString(item, "articleTemplateId");
  const titleBlocks = item.titleBlocks;
  const summaryBlocks = item.summaryBlocks;
  const bodyBlocks = item.bodyBlocks;
  const tagTemplateIds = item.tagTemplateIds;
  const mediaSearchPlan = item.mediaSearchPlan;
  if (titleBlocks !== undefined && !Array.isArray(titleBlocks)) {
    throw protocolError("titleBlocks must be an array when present");
  }
  if (summaryBlocks !== undefined && !Array.isArray(summaryBlocks)) {
    throw protocolError("summaryBlocks must be an array when present");
  }
  if (bodyBlocks !== undefined && !Array.isArray(bodyBlocks)) {
    throw protocolError("bodyBlocks must be an array when present");
  }
  if (
    tagTemplateIds !== undefined &&
    (!Array.isArray(tagTemplateIds) || !tagTemplateIds.every((entry) => typeof entry === "string"))
  ) {
    throw protocolError("tagTemplateIds must be a string array when present");
  }
  if (mediaSearchPlan !== undefined && !Array.isArray(mediaSearchPlan)) {
    throw protocolError("mediaSearchPlan must be an array when present");
  }
  return {
    ...(editorialProfile === null
      ? {}
      : {
          editorialProfile: stringEnumValue(item, "editorialProfile", [
            "guide",
            "question_answer",
            "comparison",
            "risk_avoidance",
            "local_service",
          ] as const),
        }),
    ...(articleTemplateId === null ? {} : { articleTemplateId }),
    title: stringValue(item, "title"),
    summary: stringValue(item, "summary"),
    bodyMarkdown: stringValue(item, "bodyMarkdown"),
    ...(titleBlocks === undefined
      ? {}
      : { titleBlocks: titleBlocks.map(parseCanonicalInlineBlock) }),
    ...(summaryBlocks === undefined
      ? {}
      : { summaryBlocks: summaryBlocks.map(parseCanonicalInlineBlock) }),
    ...(bodyBlocks === undefined ? {} : { bodyBlocks: bodyBlocks.map(parseCanonicalBodyBlock) }),
    ...(tagTemplateIds === undefined ? {} : { tagTemplateIds: [...tagTemplateIds] }),
    ...(canonicalUrl === null ? {} : { canonicalUrl }),
    ...(mediaSearchPlan === undefined
      ? {}
      : {
          mediaSearchPlan: mediaSearchPlan.map((entry) => {
            const intent = recordValue(entry, "media search intent");
            return {
              query: stringValue(intent, "query"),
              role: stringEnumValue(intent, "role", ["cover", "inline"] as const),
              rationale: stringValue(intent, "rationale"),
              claimIds: stringArrayValue(intent, "claimIds"),
            };
          }),
        }),
    media: item.media.map((entry) => recordValue(entry, "media reference")),
    claims: item.claims.map(parseContentClaim),
    contactIds: stringArrayValue(item, "contactIds"),
    tags: stringArrayValue(item, "tags"),
  };
}

const CAMPAIGN_STATES = ["draft", "active", "paused", "completed"] as const;

function parseCampaign(value: unknown): Campaign {
  const item = recordValue(value, "campaign");
  return {
    id: stringValue(item, "id"),
    brandId: stringValue(item, "brandId"),
    name: stringValue(item, "name"),
    objective: stringValue(item, "objective"),
    industry: stringValue(item, "industry"),
    status: stringEnumValue(item, "status", CAMPAIGN_STATES),
    topicKey: stringValue(item, "topicKey"),
  };
}

function parseCampaignTransitionResult(value: unknown): CampaignTransitionResult {
  const item = recordValue(value, "campaign transition result");
  return {
    campaign: parseCampaign(item.campaign),
    previousStatus: stringEnumValue(item, "previousStatus", CAMPAIGN_STATES),
    wasChanged: booleanValue(item, "wasChanged"),
  };
}

function parseContent(value: unknown): ContentItem {
  const item = recordValue(value, "content item");
  return {
    id: stringValue(item, "id"),
    campaignId: stringValue(item, "campaignId"),
    brandId: stringValue(item, "brandId"),
    title: stringValue(item, "title"),
    contentType: stringValue(item, "contentType"),
    state: stringValue(item, "state"),
    topicKey: stringValue(item, "topicKey"),
    latestVersion: nullableNumberValue(item, "latestVersion"),
    latestVersionId: nullableStringValue(item, "latestVersionId"),
  };
}

function parseVariant(value: unknown): PublicationVariant {
  const item = recordValue(value, "publication variant");
  return {
    id: stringValue(item, "id"),
    contentVersionId: stringValue(item, "contentVersionId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    platform: stringValue(item, "platform"),
    variantVersion: numberValue(item, "variantVersion"),
    payload: parsePublicationPayload(item.payload),
    payloadHash: stringValue(item, "payloadHash"),
    state: stringValue(item, "state"),
    frozenAt: nullableStringValue(item, "frozenAt"),
  };
}

function parseContentVersion(value: unknown): ContentVersion {
  const item = recordValue(value, "content version");
  return {
    id: stringValue(item, "id"),
    contentItemId: stringValue(item, "contentItemId"),
    version: numberValue(item, "version"),
    summary: stringValue(item, "summary"),
    bodyMarkdown: stringValue(item, "bodyMarkdown"),
    payload: parsePublicationPayload(item.payload),
    payloadHash: stringValue(item, "payloadHash"),
    frozenAt: nullableStringValue(item, "frozenAt"),
  };
}

function parseMediaImportResult(value: unknown): MediaImportResult {
  const item = recordValue(value, "media import result");
  const job = recordValue(item.job, "media import job");
  const rawAsset = item.asset;
  const asset = rawAsset === null ? null : recordValue(rawAsset, "media import asset");
  return {
    job: {
      id: stringValue(job, "id"),
      state: stringValue(job, "state"),
      providerId: stringValue(job, "providerId"),
      providerMode: stringValue(job, "providerMode"),
    },
    asset:
      asset === null
        ? null
        : {
            id: stringValue(asset, "id"),
            contentVersionId: stringValue(asset, "contentVersionId"),
            storageKey: stringValue(asset, "storageKey"),
            reference: recordValue(asset.reference, "media reference"),
          },
    wasCreated: booleanValue(item, "wasCreated"),
    contentInspectionRequired: booleanValue(item, "contentInspectionRequired"),
  };
}

function parseMediaSearchImportResult(value: unknown): MediaSearchImportResult {
  const item = recordValue(value, "media search import result");
  if (!Array.isArray(item.imported)) throw protocolError("imported must be an array");
  const provider = stringValue(item, "provider");
  if (provider !== "wikimedia_commons") {
    throw protocolError(`unsupported media search provider: ${provider}`);
  }
  return {
    provider,
    sourceContentVersionId: stringValue(item, "sourceContentVersionId"),
    finalContentVersionId: stringValue(item, "finalContentVersionId"),
    plannedCount: numberValue(item, "plannedCount"),
    imported: item.imported.map((entry) => {
      const imported = recordValue(entry, "media search import item");
      return {
        intentIndex: numberValue(imported, "intentIndex"),
        query: stringValue(imported, "query"),
        role: stringEnumValue(imported, "role", ["cover", "inline"] as const),
        providerAssetId: stringValue(imported, "providerAssetId"),
        sourceUrl: stringValue(imported, "sourceUrl"),
        assetId: stringValue(imported, "assetId"),
        contentVersionId: stringValue(imported, "contentVersionId"),
      };
    }),
    rejectedCandidateCount: numberValue(item, "rejectedCandidateCount"),
    rejectionCodes: stringArrayValue(item, "rejectionCodes"),
  };
}

function parsePublicationJob(value: unknown): PublicationJob {
  const item = recordValue(value, "publication job");
  return {
    id: stringValue(item, "id"),
    grantId: stringValue(item, "grantId"),
    auditArtifactId: stringValue(item, "auditArtifactId"),
    variantId: stringValue(item, "variantId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    platform: stringValue(item, "platform"),
    executionLevel: stringValue(item, "executionLevel"),
    state: stringValue(item, "state"),
    payloadHash: stringValue(item, "payloadHash"),
    scheduledFor: stringValue(item, "scheduledFor"),
    availableAt: stringValue(item, "availableAt"),
    attemptCount: numberValue(item, "attemptCount"),
    lastErrorCode: nullableStringValue(item, "lastErrorCode"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parsePublicationAttempt(value: unknown): PublicationAttempt {
  const item = recordValue(value, "publication attempt");
  return {
    id: stringValue(item, "id"),
    jobId: stringValue(item, "jobId"),
    attemptNo: numberValue(item, "attemptNo"),
    state: stringValue(item, "state"),
    requestHash: stringValue(item, "requestHash"),
    responseHash: nullableStringValue(item, "responseHash"),
    errorCode: nullableStringValue(item, "errorCode"),
    errorMessage: nullableStringValue(item, "errorMessage"),
    startedAt: stringValue(item, "startedAt"),
    finishedAt: nullableStringValue(item, "finishedAt"),
  };
}

function parseReceipt(value: unknown): PublicationReceipt {
  const item = recordValue(value, "publication receipt");
  return {
    id: stringValue(item, "id"),
    jobId: stringValue(item, "jobId"),
    attemptId: stringValue(item, "attemptId"),
    platform: stringValue(item, "platform"),
    executionLevel: stringValue(item, "executionLevel"),
    evidenceType: stringValue(item, "evidenceType"),
    requestHash: stringValue(item, "requestHash"),
    responseHash: stringValue(item, "responseHash"),
    externalId: nullableStringValue(item, "externalId"),
    externalUrl: nullableStringValue(item, "externalUrl"),
    publishedAt: nullableStringValue(item, "publishedAt"),
    confirmed: booleanValue(item, "confirmed"),
    payload: recordField(item, "payload"),
    recordedAt: stringValue(item, "recordedAt"),
  };
}

function parsePublicationReadback(value: unknown): PublicationReadback {
  const item = recordValue(value, "publication readback");
  return {
    id: stringValue(item, "id"),
    jobId: stringValue(item, "jobId"),
    receiptId: stringValue(item, "receiptId"),
    status: stringValue(item, "status"),
    required: booleanValue(item, "required"),
    reason: nullableStringValue(item, "reason"),
    scheduledFor: stringValue(item, "scheduledFor"),
    completedAt: nullableStringValue(item, "completedAt"),
    lastError: nullableStringValue(item, "lastError"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parsePublicationAssistedHandoff(value: unknown): PublicationAssistedHandoff {
  const item = recordValue(value, "publication assisted handoff");
  const platform = stringValue(item, "platform");
  if (platform !== "ctrip_community") {
    throw protocolError(`unsupported assisted handoff platform: ${platform}`);
  }
  return {
    id: stringValue(item, "id"),
    jobId: stringValue(item, "jobId"),
    attemptId: stringValue(item, "attemptId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    variantId: stringValue(item, "variantId"),
    platform,
    state: stringEnumValue(item, "state", [
      "handoff_pending",
      "session_required",
      "challenge_required",
      "draft_prepared",
      "awaiting_operator_submit",
      "submitted_unconfirmed",
      "readback_pending",
      "confirmed",
      "needs_review",
      "cancelled",
      "expired",
      "failed",
    ]),
    payloadHash: stringValue(item, "payloadHash"),
    auditHash: stringValue(item, "auditHash"),
    previewHash: stringValue(item, "previewHash"),
    adapterVersion: stringValue(item, "adapterVersion"),
    bridgeServicePrincipalId: nullableStringValue(item, "bridgeServicePrincipalId"),
    leaseOwnerActorId: nullableStringValue(item, "leaseOwnerActorId"),
    leaseExpiresAt: nullableStringValue(item, "leaseExpiresAt"),
    heartbeatAt: nullableStringValue(item, "heartbeatAt"),
    sessionEvidenceHash: nullableStringValue(item, "sessionEvidenceHash"),
    draftEvidenceHash: nullableStringValue(item, "draftEvidenceHash"),
    prepareOutcome: nullableEnumValue(item, "prepareOutcome", [
      "prepared",
      "session_required",
      "challenge_required",
      "adapter_drift",
    ]),
    prepareEvidenceKind: nullableEnumValue(item, "prepareEvidenceKind", ["simulation", "browser"]),
    prepareEvidenceHash: nullableStringValue(item, "prepareEvidenceHash"),
    prepareObservedAt: nullableStringValue(item, "prepareObservedAt"),
    mediaManifestHash: nullableStringValue(item, "mediaManifestHash"),
    submitEvidenceHash: nullableStringValue(item, "submitEvidenceHash"),
    submitPermitIssued: booleanValue(item, "submitPermitIssued"),
    submitPermitExpiresAt: nullableStringValue(item, "submitPermitExpiresAt"),
    submitPermitConsumedAt: nullableStringValue(item, "submitPermitConsumedAt"),
    submitPermitIssuedByActorId: nullableStringValue(item, "submitPermitIssuedByActorId"),
    submitPermitConsumedByPrincipalId: nullableStringValue(
      item,
      "submitPermitConsumedByPrincipalId",
    ),
    submitOutcome: nullableEnumValue(item, "submitOutcome", ["accepted", "uncertain", "rejected"]),
    submitEvidenceKind: nullableEnumValue(item, "submitEvidenceKind", ["simulation", "browser"]),
    submitObservedAt: nullableStringValue(item, "submitObservedAt"),
    submitCandidateExternalId: nullableStringValue(item, "submitCandidateExternalId"),
    submitCandidateExternalUrl: nullableStringValue(item, "submitCandidateExternalUrl"),
    publicationReceiptId: nullableStringValue(item, "publicationReceiptId"),
    publicationReadbackId: nullableStringValue(item, "publicationReadbackId"),
    readbackOutcome: nullableEnumValue(item, "readbackOutcome", [
      "confirmed",
      "not_found",
      "mismatch",
      "unavailable",
      "simulation_only",
    ]),
    readbackEvidenceKind: nullableEnumValue(item, "readbackEvidenceKind", [
      "simulation",
      "browser",
      "platform_readback",
    ]),
    readbackEvidenceHash: nullableStringValue(item, "readbackEvidenceHash"),
    readbackObservedAt: nullableStringValue(item, "readbackObservedAt"),
    observedPayloadHash: nullableStringValue(item, "observedPayloadHash"),
    externalDraftId: nullableStringValue(item, "externalDraftId"),
    externalId: nullableStringValue(item, "externalId"),
    externalUrl: nullableStringValue(item, "externalUrl"),
    expiresAt: stringValue(item, "expiresAt"),
    cancellationReason: nullableStringValue(item, "cancellationReason"),
    lastErrorCode: nullableStringValue(item, "lastErrorCode"),
    lastErrorMessage: nullableStringValue(item, "lastErrorMessage"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parsePublicationAssistedBridgeAction(
  value: unknown,
  expectedCommand: CtripBridgeResult["command"],
): PublicationAssistedBridgeActionResult {
  const item = recordValue(value, "publication assisted bridge action");
  const parsedBridge = ctripBridgeResultSchema.safeParse(item.bridge);
  if (!parsedBridge.success || parsedBridge.data.command !== expectedCommand) {
    throw protocolError(`invalid assisted bridge ${expectedCommand} result`);
  }
  return {
    handoff: parsePublicationAssistedHandoff(item.handoff),
    bridge: parsedBridge.data,
  };
}

function parseAuditFinding(value: unknown): AuditFinding {
  const item = recordValue(value, "audit finding");
  return {
    ruleId: stringValue(item, "ruleId"),
    ruleVersion: stringValue(item, "ruleVersion"),
    severity: stringValue(item, "severity"),
    message: stringValue(item, "message"),
    path: optionalString(item, "path"),
    evidence: stringArrayValue(item, "evidence"),
  };
}

function parseAuditArtifact(value: unknown): AuditArtifact {
  const item = recordValue(value, "audit artifact");
  if (!Array.isArray(item.findings)) throw protocolError("findings must be an array");
  return {
    id: stringValue(item, "id"),
    tenantId: stringValue(item, "tenantId"),
    variantId: stringValue(item, "variantId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    platform: stringValue(item, "platform"),
    payloadHash: stringValue(item, "payloadHash"),
    factSnapshotHash: stringValue(item, "factSnapshotHash"),
    policyHash: stringValue(item, "policyHash"),
    policyVersion: stringValue(item, "policyVersion"),
    auditHash: stringValue(item, "auditHash"),
    status: stringValue(item, "status"),
    findings: item.findings.map(parseAuditFinding),
    createdAt: stringValue(item, "createdAt"),
    expiresAt: stringValue(item, "expiresAt"),
  };
}

function parseAuditResult(value: unknown): AuditResult {
  const item = recordValue(value, "audit result");
  let publicationAuthorization: PublicationAuthorization | null = null;
  if (item.publicationAuthorization !== null) {
    const authorization = recordValue(item.publicationAuthorization, "publication authorization");
    publicationAuthorization = {
      grantId: stringValue(authorization, "grantId"),
      token: stringValue(authorization, "token"),
      expiresAt: stringValue(authorization, "expiresAt"),
    };
  }
  return {
    artifact: parseAuditArtifact(item.artifact),
    publicationAuthorization,
    wasCreated: booleanValue(item, "wasCreated"),
  };
}

function parseManualPublicationPackage(value: unknown): ManualPublicationPackage {
  const item = recordValue(value, "manual publication package");
  const schemaVersion = stringValue(item, "schemaVersion");
  const evidenceType = stringValue(item, "evidenceType");
  const executionLevel = stringValue(item, "executionLevel");
  const publicationStatus = stringValue(item, "publicationStatus");
  const requiresManualAction = booleanValue(item, "requiresManualAction");
  const confirmed = booleanValue(item, "confirmed");
  const files = recordField(item, "files");
  if (
    schemaVersion !== "geo.manual-publication-package.v1" ||
    evidenceType !== "preview" ||
    executionLevel !== "dry_run" ||
    publicationStatus !== "not_published" ||
    !requiresManualAction ||
    confirmed
  ) {
    throw protocolError("manual publication package must be a non-published dry-run preview");
  }
  if (!Object.values(files).every((content) => typeof content === "string")) {
    throw protocolError("manual publication package files must contain strings");
  }
  return {
    schemaVersion,
    evidenceType,
    platform: stringValue(item, "platform"),
    tenantId: stringValue(item, "tenantId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    variantId: stringValue(item, "variantId"),
    executionLevel,
    auditArtifactId: stringValue(item, "auditArtifactId"),
    payloadHash: stringValue(item, "payloadHash"),
    auditHash: stringValue(item, "auditHash"),
    previewHash: stringValue(item, "previewHash"),
    requiresManualAction,
    publicationStatus,
    confirmed,
    exportedAt: stringValue(item, "exportedAt"),
    files: files as Readonly<Record<string, string>>,
    packageHash: stringValue(item, "packageHash"),
  };
}

function parseVisibilitySummary(value: unknown): VisibilityProviderSummary {
  const item = recordValue(value, "visibility summary");
  const provider = stringValue(item, "provider");
  if (provider !== "doubao" && provider !== "qwen") {
    throw protocolError(`unsupported visibility provider: ${provider}`);
  }
  return {
    provider,
    productSurface: stringValue(item, "productSurface"),
    model: stringValue(item, "model"),
    searchMode: stringValue(item, "searchMode"),
    observationMethod: stringValue(item, "observationMethod"),
    evidenceType: stringValue(item, "evidenceType"),
    observations: numberValue(item, "observations"),
    brandMentionRate: numberValue(item, "brandMentionRate"),
    contactAccuracy: numberValue(item, "contactAccuracy"),
    averageAnswerPosition: numberValue(item, "averageAnswerPosition"),
    competitorMentionRate: numberValue(item, "competitorMentionRate"),
    negativeSentimentRate: numberValue(item, "negativeSentimentRate"),
    hallucinationFindings: numberValue(item, "hallucinationFindings"),
    harmfulErrors: numberValue(item, "harmfulErrors"),
  };
}

function parseVisibilityProvider(item: Record<string, unknown>): VisibilityProvider {
  const provider = stringValue(item, "provider");
  if (provider !== "doubao" && provider !== "qwen") {
    throw protocolError(`unsupported visibility provider: ${provider}`);
  }
  return provider;
}

function parseVisibilitySearchMode(item: Record<string, unknown>): VisibilityRun["searchMode"] {
  const searchMode = stringValue(item, "searchMode");
  if (searchMode !== "on" && searchMode !== "off" && searchMode !== "unknown") {
    throw protocolError(`unsupported visibility search mode: ${searchMode}`);
  }
  return searchMode;
}

function parseVisibilityObservationMethod(
  item: Record<string, unknown>,
): VisibilityObservationMethod {
  const observationMethod = stringValue(item, "observationMethod");
  if (
    !(["fixture", "manual", "official_api", "browser"] as const).includes(
      observationMethod as VisibilityObservationMethod,
    )
  ) {
    throw protocolError(`unsupported visibility observation method: ${observationMethod}`);
  }
  return observationMethod as VisibilityObservationMethod;
}

function parseVisibilityRun(value: unknown): VisibilityRun {
  const item = recordValue(value, "visibility run");
  const status = stringValue(item, "status");
  if (
    !(["queued", "running", "completed", "failed"] as const).includes(
      status as VisibilityRun["status"],
    )
  ) {
    throw protocolError(`unsupported visibility run status: ${status}`);
  }
  return {
    id: stringValue(item, "id"),
    querySetVersionId: stringValue(item, "querySetVersionId"),
    provider: parseVisibilityProvider(item),
    productSurface: stringValue(item, "productSurface"),
    model: stringValue(item, "model"),
    searchMode: parseVisibilitySearchMode(item),
    observationMethod: parseVisibilityObservationMethod(item),
    status: status as VisibilityRun["status"],
    locale: stringValue(item, "locale"),
    geo: nullableStringValue(item, "geo"),
    startedAt: nullableStringValue(item, "startedAt"),
    completedAt: nullableStringValue(item, "completedAt"),
    errorMessage: nullableStringValue(item, "errorMessage"),
    observationCount: numberValue(item, "observationCount"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseVisibilityObservation(value: unknown): VisibilityObservation {
  const item = recordValue(value, "visibility observation");
  const sentiment = stringValue(item, "sentiment");
  if (!("positive neutral negative mixed".split(" ") as string[]).includes(sentiment)) {
    throw protocolError(`unsupported visibility sentiment: ${sentiment}`);
  }
  if (!Array.isArray(item.hallucinationFindings)) {
    throw protocolError("hallucinationFindings must be an array");
  }
  const hallucinationFindings = item.hallucinationFindings.map((value) => {
    const finding = recordValue(value, "hallucination finding");
    const category = stringValue(finding, "category");
    const severity = stringValue(finding, "severity");
    if (!("contact brand qualification control other".split(" ") as string[]).includes(category)) {
      throw protocolError(`unsupported hallucination category: ${category}`);
    }
    if (!("low medium high".split(" ") as string[]).includes(severity)) {
      throw protocolError(`unsupported hallucination severity: ${severity}`);
    }
    return {
      code: stringValue(finding, "code"),
      category: category as VisibilityHallucinationFinding["category"],
      severity: severity as VisibilityHallucinationFinding["severity"],
      statement: stringValue(finding, "statement"),
      observedValue: nullableStringValue(finding, "observedValue"),
      expectedValues: stringArrayValue(finding, "expectedValues"),
    };
  });
  return {
    id: stringValue(item, "id"),
    tenantId: stringValue(item, "tenantId"),
    runId: stringValue(item, "runId"),
    provider: parseVisibilityProvider(item),
    productSurface: stringValue(item, "productSurface"),
    model: stringValue(item, "model"),
    searchMode: parseVisibilitySearchMode(item),
    observationMethod: parseVisibilityObservationMethod(item),
    prompt: stringValue(item, "prompt"),
    promptVersion: stringValue(item, "promptVersion"),
    locale: stringValue(item, "locale"),
    geo: nullableStringValue(item, "geo"),
    rawAnswer: stringValue(item, "rawAnswer"),
    citedUrls: stringArrayValue(item, "citedUrls"),
    evidenceHash: stringValue(item, "evidenceHash"),
    evidenceType: stringValue(item, "evidenceType"),
    requestStartedAt: stringValue(item, "requestStartedAt"),
    responseReceivedAt: stringValue(item, "responseReceivedAt"),
    observedAt: stringValue(item, "observedAt"),
    brandMentioned: booleanValue(item, "brandMentioned"),
    answerPosition: nullableNumberValue(item, "answerPosition"),
    contactAccuracy: numberValue(item, "contactAccuracy"),
    competitorMentions: stringArrayValue(item, "competitorMentions"),
    sentiment: sentiment as VisibilitySentiment,
    hallucinationFindings,
    harmfulError: booleanValue(item, "harmfulError"),
    extractorVersion: stringValue(item, "extractorVersion"),
    evaluatorVersion: stringValue(item, "evaluatorVersion"),
    metadata: recordField(item, "metadata"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseVisibilityMetric(value: unknown): VisibilityMetric {
  const item = recordValue(value, "visibility metric");
  return {
    name: stringValue(item, "name"),
    value: numberValue(item, "value"),
    sampleCount: numberValue(item, "sampleCount"),
    confidenceLow: nullableNumberValue(item, "confidenceLow"),
    confidenceHigh: nullableNumberValue(item, "confidenceHigh"),
    dimensions: recordField(item, "dimensions"),
    createdAt: stringValue(item, "createdAt"),
  };
}

function parseVisibilityRunDetail(value: unknown): VisibilityRunDetail {
  const item = recordValue(value, "visibility run detail");
  if (!Array.isArray(item.observations)) throw protocolError("observations must be an array");
  if (!Array.isArray(item.metrics)) throw protocolError("metrics must be an array");
  return {
    run: parseVisibilityRun(item.run),
    observations: item.observations.map(parseVisibilityObservation),
    metrics: item.metrics.map(parseVisibilityMetric),
  };
}

function parseVisibilityRunResult(value: unknown): VisibilityRunResult {
  const item = recordValue(value, "visibility run result");
  const status = stringValue(item, "status");
  const providerMode = stringValue(item, "providerMode");
  const evidenceType = stringValue(item, "evidenceType");
  if (status !== "completed")
    throw protocolError(`unsupported visibility result status: ${status}`);
  if (providerMode !== "fixture" && providerMode !== "manual") {
    throw protocolError(`unsupported visibility provider mode: ${providerMode}`);
  }
  if (evidenceType !== "fixture" && evidenceType !== "manual_import") {
    throw protocolError(`unsupported visibility evidence type: ${evidenceType}`);
  }
  return {
    visibilityRunId: stringValue(item, "visibilityRunId"),
    status,
    providerMode,
    evidenceType,
    wasCreated: booleanValue(item, "wasCreated"),
  };
}

const AUTOMATION_MODES = ["shadow", "supervised", "unattended", "paused", "stopped"] as const;

function parseAutomationControl(value: unknown): AutomationControl {
  const item = recordValue(value, "automation control");
  return {
    mode: stringEnumValue(item, "mode", AUTOMATION_MODES),
    killSwitchEnabled: booleanValue(item, "killSwitchEnabled"),
    reason: nullableStringValue(item, "reason"),
    quota: recordField(item, "quota"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseScopedAutomationControl(value: unknown): ScopedAutomationControl {
  const item = recordValue(value, "scoped automation control");
  return {
    ...parseAutomationControl(item),
    id: stringValue(item, "id"),
    scopeType: stringEnumValue(item, "scopeType", [
      "tenant",
      "platform",
      "account",
      "campaign",
      "topic",
    ] as const),
    scopeKey: stringValue(item, "scopeKey"),
  };
}

function parseAutomationCircuit(value: unknown): AutomationCircuit {
  const item = recordValue(value, "automation circuit");
  return {
    id: stringValue(item, "id"),
    scopeType: stringEnumValue(item, "scopeType", [
      "tenant",
      "platform",
      "account",
      "campaign",
      "topic",
    ] as const),
    scopeKey: stringValue(item, "scopeKey"),
    state: stringEnumValue(item, "state", ["closed", "open", "half_open"] as const),
    failureCount: numberValue(item, "failureCount"),
    openedAt: nullableStringValue(item, "openedAt"),
    retryAt: nullableStringValue(item, "retryAt"),
    reason: nullableStringValue(item, "reason"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationSnapshot(value: unknown): AutomationSnapshot {
  const body = recordValue(value, "automation response");
  if (!Array.isArray(body.circuits)) throw protocolError("circuits must be an array");
  if (body.controls !== undefined && !Array.isArray(body.controls)) {
    throw protocolError("controls must be an array");
  }
  return {
    control: parseAutomationControl(body.control),
    controls: Array.isArray(body.controls) ? body.controls.map(parseScopedAutomationControl) : [],
    circuits: body.circuits.map(parseAutomationCircuit),
  };
}

const AUTOMATION_BATCH_STATES = [
  "scheduled",
  "running",
  "completed",
  "partially_failed",
  "cancelled",
] as const;
const AUTOMATION_RUN_STATES = [
  "scheduled",
  "running",
  "retry_wait",
  "awaiting_delivery",
  "completed",
  "partially_failed",
  "blocked",
  "failed",
  "cancelled",
] as const;
const AUTOMATION_RUN_STAGES = ["planning", "draft", "targets", "delivery"] as const;
const AUTOMATION_TARGET_STATES = [
  "pending",
  "variant_ready",
  "audit_failed",
  "awaiting_delivery",
  "preview_completed",
  "confirmed",
  "blocked",
  "failed",
  "cancelled",
] as const;
const AUTOMATION_PLATFORMS = ["toutiao", "sohu", "ctrip_community"] as const;

function parseAutomationBatch(value: unknown): AutomationBatch {
  const item = recordValue(value, "automation batch");
  const executionLevel = stringEnumValue(item, "executionLevel", [
    "dry_run",
    "assisted",
    "unattended",
  ] as const);
  return {
    id: stringValue(item, "id"),
    campaignId: stringValue(item, "campaignId"),
    name: nullableStringValue(item, "name"),
    state: stringEnumValue(item, "state", AUTOMATION_BATCH_STATES),
    executionLevel,
    scheduledFor: stringValue(item, "scheduledFor"),
    runCount: numberValue(item, "runCount"),
    completedRunCount: numberValue(item, "completedRunCount"),
    failedRunCount: numberValue(item, "failedRunCount"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationRunTarget(value: unknown): AutomationRunTarget {
  const item = recordValue(value, "automation run target");
  return {
    id: stringValue(item, "id"),
    runId: stringValue(item, "runId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    platform: stringEnumValue(item, "platform", AUTOMATION_PLATFORMS),
    state: stringEnumValue(item, "state", AUTOMATION_TARGET_STATES),
    variantId: nullableStringValue(item, "variantId"),
    auditRunId: nullableStringValue(item, "auditRunId"),
    auditArtifactId: nullableStringValue(item, "auditArtifactId"),
    publicationJobId: nullableStringValue(item, "publicationJobId"),
    lastErrorCode: nullableStringValue(item, "lastErrorCode"),
    lastErrorMessage: nullableStringValue(item, "lastErrorMessage"),
    completedAt: nullableStringValue(item, "completedAt"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationRun(value: unknown): AutomationRun {
  const item = recordValue(value, "automation run");
  if (!Array.isArray(item.targets)) throw protocolError("automation run targets must be an array");
  return {
    id: stringValue(item, "id"),
    batchId: stringValue(item, "batchId"),
    campaignId: stringValue(item, "campaignId"),
    executionLevel: stringEnumValue(item, "executionLevel", [
      "dry_run",
      "assisted",
      "unattended",
    ] as const),
    brandId: stringValue(item, "brandId"),
    slotKey: stringValue(item, "slotKey"),
    topicKey: stringValue(item, "topicKey"),
    brief: stringValue(item, "brief"),
    state: stringEnumValue(item, "state", AUTOMATION_RUN_STATES),
    stage: stringEnumValue(item, "stage", AUTOMATION_RUN_STAGES),
    availableAt: stringValue(item, "availableAt"),
    attemptCount: numberValue(item, "attemptCount"),
    maxAttempts: numberValue(item, "maxAttempts"),
    leaseOwner: nullableStringValue(item, "leaseOwner"),
    leaseExpiresAt: nullableStringValue(item, "leaseExpiresAt"),
    heartbeatAt: nullableStringValue(item, "heartbeatAt"),
    checkpoint: recordField(item, "checkpoint"),
    contentItemId: nullableStringValue(item, "contentItemId"),
    contentVersionId: nullableStringValue(item, "contentVersionId"),
    lastErrorCode: nullableStringValue(item, "lastErrorCode"),
    lastErrorMessage: nullableStringValue(item, "lastErrorMessage"),
    completedAt: nullableStringValue(item, "completedAt"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
    targets: item.targets.map(parseAutomationRunTarget),
  };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

function tenantOptionsFromDetails(details: unknown): readonly TenantOption[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.tenants)) return undefined;
  try {
    return details.tenants.map(parseTenantOption);
  } catch {
    return undefined;
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof GeoApiError &&
    (error.status === 401 ||
      error.code === "AUTHENTICATION_REQUIRED" ||
      error.code === "SESSION_INVALID")
  );
}

export class HttpGeoApi implements GeoApi {
  private csrfToken: string | null = null;
  private readonly baseUrl: string;

  constructor(
    baseUrl = "",
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}, csrf = false): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (csrf) {
      const token = this.csrfToken ?? readCookie("geo_csrf");
      if (token === null) {
        throw new GeoApiError(0, "CSRF_TOKEN_MISSING", "当前会话缺少 CSRF 令牌，请重新登录");
      }
      headers.set("x-csrf-token", token);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed";
      throw new GeoApiError(0, "NETWORK_ERROR", `无法连接 GEO API：${message}`);
    }

    let payload: unknown = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text.length > 0) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          if (!response.ok) {
            throw new GeoApiError(
              response.status,
              `HTTP_${response.status}`,
              `GEO API 返回 ${response.status}，但没有结构化错误信息`,
            );
          }
          throw new GeoApiError(response.status, "INVALID_API_RESPONSE", "API 返回了非 JSON 响应");
        }
      }
    }

    if (!response.ok) {
      const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      const code = envelope === null ? `HTTP_${response.status}` : optionalString(envelope, "code");
      const message = envelope === null ? response.statusText : optionalString(envelope, "message");
      const requestId = envelope === null ? null : optionalString(envelope, "requestId");
      const details = envelope?.details;
      const parsedTenants = tenantOptionsFromDetails(details);
      throw new GeoApiError(
        response.status,
        code ?? `HTTP_${response.status}`,
        message ?? `API request failed with status ${response.status}`,
        requestId,
        isRecord(details)
          ? { ...details, ...(parsedTenants === undefined ? {} : { tenants: parsedTenants }) }
          : null,
      );
    }
    return payload;
  }

  async getSession(): Promise<SessionSnapshot> {
    return parseSession(await this.request("/api/auth/session"));
  }

  async login(input: LoginInput): Promise<SessionSnapshot> {
    const payload = await this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        ...(input.tenantSlug === undefined ? {} : { tenantSlug: input.tenantSlug }),
      }),
    });
    const body = recordValue(payload, "login response");
    this.csrfToken = stringValue(body, "csrfToken");
    return parseSession(payload);
  }

  async logout(): Promise<void> {
    await this.request("/api/auth/logout", { method: "POST" }, true);
    this.csrfToken = null;
  }

  async getTenants(): Promise<readonly TenantOption[]> {
    return itemsValue(await this.request("/api/auth/tenants"), parseTenantOption);
  }

  async switchTenant(tenantSlug: string): Promise<SessionSnapshot> {
    const payload = await this.request(
      "/api/auth/switch-tenant",
      { method: "POST", body: JSON.stringify({ tenantSlug }) },
      true,
    );
    const body = recordValue(payload, "tenant switch response");
    this.csrfToken = optionalString(body, "csrfToken") ?? readCookie("geo_csrf");
    return parseSession(payload);
  }

  async getTenant(): Promise<TenantView> {
    return parseTenant(await this.request("/api/tenant"));
  }

  async getContacts(): Promise<readonly TenantContact[]> {
    return itemsValue(await this.request("/api/contacts"), parseContact);
  }

  async createContact(input: CreateContactInput): Promise<TenantContact> {
    return parseContact(
      await this.request("/api/contacts", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async expireContact(contactId: string, input: ExpireContactInput): Promise<TenantContact> {
    return parseContact(
      await this.request(
        `/api/contacts/${encodeURIComponent(contactId)}/expire`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getChannelAccounts(): Promise<readonly ChannelAccount[]> {
    return itemsValue(await this.request("/api/channel-accounts"), parseChannelAccount);
  }

  async createChannelAccount(input: CreateChannelAccountInput): Promise<ChannelAccount> {
    return parseChannelAccount(
      await this.request(
        "/api/channel-accounts",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async updateChannelAccount(
    channelAccountId: string,
    input: UpdateChannelAccountInput,
  ): Promise<ChannelAccount> {
    return parseChannelAccount(
      await this.request(
        `/api/channel-accounts/${encodeURIComponent(channelAccountId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getBrands(): Promise<readonly Brand[]> {
    return itemsValue(await this.request("/api/brands"), parseBrand);
  }

  async getBrandAgentProfiles(): Promise<readonly BrandAgentProfile[]> {
    return itemsValue(await this.request("/api/brand-agent-profiles"), parseBrandAgentProfile);
  }

  async createBrandAgentProfile(
    brandId: string,
    input: CreateBrandAgentProfileInput,
  ): Promise<BrandAgentProfile> {
    return parseBrandAgentProfile(
      await this.request(
        `/api/brands/${encodeURIComponent(brandId)}/agent-profile`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getMembers(): Promise<readonly TenantMember[]> {
    return itemsValue(await this.request("/api/members"), parseTenantMember);
  }

  async createMember(input: CreateMemberInput): Promise<TenantMember> {
    return parseTenantMember(
      await this.request("/api/members", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async updateMember(memberId: string, input: UpdateMemberInput): Promise<TenantMember> {
    return parseTenantMember(
      await this.request(
        `/api/members/${encodeURIComponent(memberId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getPolicies(): Promise<readonly PolicyBundle[]> {
    return itemsValue(await this.request("/api/policies"), parsePolicyBundle);
  }

  async createPolicy(input: CreatePolicyInput): Promise<PolicyBundle> {
    return parsePolicyBundle(
      await this.request("/api/policies", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async transitionPolicy(
    policyId: string,
    input: PolicyTransitionInput,
  ): Promise<PolicyTransitionResult> {
    const body = recordValue(
      await this.request(
        `/api/policies/${encodeURIComponent(policyId)}/state`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "policy transition response",
    );
    const previousStatus = stringValue(body, "previousStatus");
    if (!["draft", "active", "retired"].includes(previousStatus)) {
      throw protocolError(`unsupported previous policy status: ${previousStatus}`);
    }
    return {
      policy: parsePolicyBundle(body.policy),
      previousStatus: previousStatus as PolicyBundle["status"],
      wasChanged: booleanValue(body, "wasChanged"),
    };
  }

  async getServicePrincipals(): Promise<readonly ServicePrincipal[]> {
    return itemsValue(await this.request("/api/service-principals"), parseServicePrincipal);
  }

  async createAutomationServicePrincipal(input: {
    readonly name: string;
  }): Promise<ServicePrincipal> {
    return parseServicePrincipal(
      await this.request(
        "/api/service-principals/automation-producers",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async createCtripBridgeServicePrincipal(input: {
    readonly name: string;
  }): Promise<ServicePrincipal> {
    return parseServicePrincipal(
      await this.request(
        "/api/service-principals/ctrip-bridges",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async setServicePrincipalStatus(
    principalId: string,
    input: { readonly status: "active" | "disabled"; readonly reason: string },
  ): Promise<{ readonly principal: ServicePrincipal; readonly wasChanged: boolean }> {
    const body = recordValue(
      await this.request(
        `/api/service-principals/${encodeURIComponent(principalId)}/status`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "service principal status response",
    );
    return {
      principal: parseServicePrincipal(body.principal),
      wasChanged: booleanValue(body, "wasChanged"),
    };
  }

  async getQuerySets(): Promise<readonly QuerySet[]> {
    return itemsValue(await this.request("/api/query-sets"), parseQuerySet);
  }

  async createQuerySet(input: CreateQuerySetInput): Promise<QuerySet> {
    return parseQuerySet(
      await this.request("/api/query-sets", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async getQuerySetVersions(querySetId: string): Promise<readonly QuerySetVersion[]> {
    return itemsValue(
      await this.request(`/api/query-sets/${encodeURIComponent(querySetId)}/versions`),
      parseQuerySetVersion,
    );
  }

  async createQuerySetVersion(
    querySetId: string,
    input: { readonly prompts: readonly QuerySetPrompt[]; readonly reason: string },
  ): Promise<QuerySetVersion> {
    return parseQuerySetVersion(
      await this.request(
        `/api/query-sets/${encodeURIComponent(querySetId)}/versions`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async activateQuerySetVersion(querySetId: string, versionId: string, reason: string) {
    const item = recordValue(
      await this.request(
        `/api/query-sets/${encodeURIComponent(querySetId)}/versions/${encodeURIComponent(versionId)}/activate`,
        { method: "POST", body: JSON.stringify({ reason }) },
        true,
      ),
      "query-set activation result",
    );
    return {
      querySet: parseQuerySet(item.querySet),
      previousVersion: numberValue(item, "previousVersion"),
      previousStatus: stringEnumValue(item, "previousStatus", [
        "draft",
        "active",
        "retired",
      ] as const),
      wasChanged: booleanValue(item, "wasChanged"),
    };
  }

  async transitionQuerySet(querySetId: string, targetStatus: "retired", reason: string) {
    const item = recordValue(
      await this.request(
        `/api/query-sets/${encodeURIComponent(querySetId)}/state`,
        { method: "POST", body: JSON.stringify({ targetStatus, reason }) },
        true,
      ),
      "query-set transition result",
    );
    return {
      querySet: parseQuerySet(item.querySet),
      previousStatus: stringEnumValue(item, "previousStatus", [
        "draft",
        "active",
        "retired",
      ] as const),
      wasChanged: booleanValue(item, "wasChanged"),
    };
  }

  async getArticleTemplates(): Promise<ArticleTemplateCatalogView> {
    return parseArticleTemplateCatalog(await this.request("/api/article-templates"));
  }

  async getSetupReadiness(): Promise<CustomerSetupReadiness> {
    return parseCustomerSetupReadiness(await this.request("/api/setup/readiness"));
  }

  async getCtripBridgeStatus(): Promise<CtripBridgeStatus> {
    return parseCtripBridgeStatus(await this.request("/api/ctrip-bridge/status"));
  }

  async getAgentCapability(): Promise<AgentRunCapability> {
    return parseAgentCapability(await this.request("/api/agent/capability"));
  }

  async runAgent(input: RunAgentInput): Promise<AgentRunResponse> {
    return parseAgentRunResponse(
      await this.request("/api/agent/runs", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async getEvidenceSources(): Promise<readonly EvidenceSource[]> {
    return itemsValue(await this.request("/api/evidence-sources"), parseEvidenceSource);
  }

  async createEvidenceSource(input: CreateEvidenceSourceInput): Promise<EvidenceSource> {
    return parseEvidenceSource(
      await this.request(
        "/api/evidence-sources",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getFacts(): Promise<readonly ClaimFact[]> {
    return itemsValue(await this.request("/api/facts"), parseFact);
  }

  async createFact(input: CreateFactInput): Promise<ClaimFact> {
    return parseFact(
      await this.request("/api/facts", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async getCampaigns(): Promise<readonly Campaign[]> {
    return itemsValue(await this.request("/api/campaigns"), parseCampaign);
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    return parseCampaign(
      await this.request("/api/campaigns", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async transitionCampaignState(
    campaignId: string,
    input: CampaignTransitionInput,
  ): Promise<CampaignTransitionResult> {
    return parseCampaignTransitionResult(
      await this.request(
        `/api/campaigns/${encodeURIComponent(campaignId)}/state`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getContent(): Promise<readonly ContentItem[]> {
    return itemsValue(await this.request("/api/content"), parseContent);
  }

  async createContent(input: CreateContentInput): Promise<ContentItem> {
    return parseContent(
      await this.request("/api/content", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async createContentVersion(contentId: string, payload: PublicationPayload): Promise<ContentItem> {
    return parseContent(
      await this.request(
        `/api/content/${encodeURIComponent(contentId)}/versions`,
        { method: "POST", body: JSON.stringify({ payload }) },
        true,
      ),
    );
  }

  async getContentVersion(contentVersionId: string): Promise<ContentVersion> {
    return parseContentVersion(
      await this.request(`/api/content-versions/${encodeURIComponent(contentVersionId)}`),
    );
  }

  async importMedia(contentVersionId: string, input: MediaImportInput): Promise<MediaImportResult> {
    return parseMediaImportResult(
      await this.request(
        `/api/content-versions/${encodeURIComponent(contentVersionId)}/media-imports`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async searchAndImportMedia(
    contentVersionId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<MediaSearchImportResult> {
    return parseMediaSearchImportResult(
      await this.request(
        `/api/content-versions/${encodeURIComponent(contentVersionId)}/media-search-imports`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async getContentVariants(contentId: string): Promise<readonly PublicationVariant[]> {
    return itemsValue(
      await this.request(`/api/content/${encodeURIComponent(contentId)}/variants`),
      parseVariant,
    );
  }

  async createContentVariant(
    contentId: string,
    input: CreateVariantInput,
  ): Promise<PublicationVariant> {
    return parseVariant(
      await this.request(
        `/api/content/${encodeURIComponent(contentId)}/variants`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async auditVariant(variantId: string, idempotencyKey: string): Promise<AuditResult> {
    return parseAuditResult(
      await this.request(
        `/api/variants/${encodeURIComponent(variantId)}/audits`,
        { method: "POST", body: JSON.stringify({ idempotencyKey }) },
        true,
      ),
    );
  }

  async getAudits(): Promise<readonly AuditArtifact[]> {
    return itemsValue(await this.request("/api/audits"), parseAuditArtifact);
  }

  async exportManualPublicationPackage(artifactId: string): Promise<ManualPublicationPackage> {
    return parseManualPublicationPackage(
      await this.request(
        `/api/audits/${encodeURIComponent(artifactId)}/manual-publication-package`,
        { method: "POST" },
        true,
      ),
    );
  }

  async getPublicationJobs(): Promise<readonly PublicationJob[]> {
    return itemsValue(await this.request("/api/publication-jobs"), parsePublicationJob);
  }

  async getPublicationJob(jobId: string): Promise<PublicationJob> {
    return parsePublicationJob(
      await this.request(`/api/publication-jobs/${encodeURIComponent(jobId)}`),
    );
  }

  async requestPublication(input: PublicationRequestInput): Promise<PublicationRequestResult> {
    const item = recordValue(
      await this.request(
        "/api/publication-requests",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "publication request result",
    );
    return {
      publicationJobId: stringValue(item, "publicationJobId"),
      publicationOutboxEventId: stringValue(item, "publicationOutboxEventId"),
      wasCreated: booleanValue(item, "wasCreated"),
    };
  }

  async revokePublicationGrant(grantId: string, reason: string) {
    const item = recordValue(
      await this.request(
        `/api/publication-grants/${encodeURIComponent(grantId)}/revoke`,
        { method: "POST", body: JSON.stringify({ reason }) },
        true,
      ),
      "grant revoke result",
    );
    const status = stringValue(item, "status");
    if (status !== "revoked") throw protocolError(`unsupported grant status: ${status}`);
    return {
      grantId: stringValue(item, "grantId"),
      status,
      revokedAt: stringValue(item, "revokedAt"),
      wasChanged: booleanValue(item, "wasChanged"),
    } as const;
  }

  async cancelPublicationJob(jobId: string, reason: string) {
    const item = recordValue(
      await this.request(
        `/api/publication-jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", body: JSON.stringify({ reason }) },
        true,
      ),
      "job cancellation result",
    );
    return { job: parsePublicationJob(item.job), wasChanged: booleanValue(item, "wasChanged") };
  }

  async getPublicationAttempts(jobId: string): Promise<readonly PublicationAttempt[]> {
    return itemsValue(
      await this.request(`/api/publication-jobs/${encodeURIComponent(jobId)}/attempts`),
      parsePublicationAttempt,
    );
  }

  async getPublicationReceipts(jobId: string): Promise<readonly PublicationReceipt[]> {
    return itemsValue(
      await this.request(`/api/publication-jobs/${encodeURIComponent(jobId)}/receipts`),
      parseReceipt,
    );
  }

  async getPublicationReadbacks(jobId: string): Promise<readonly PublicationReadback[]> {
    return itemsValue(
      await this.request(`/api/publication-jobs/${encodeURIComponent(jobId)}/readbacks`),
      parsePublicationReadback,
    );
  }

  async getPublicationAssistedHandoffs(): Promise<readonly PublicationAssistedHandoff[]> {
    return itemsValue(
      await this.request("/api/publication-assisted-handoffs"),
      parsePublicationAssistedHandoff,
    );
  }

  async getPublicationAssistedHandoff(handoffId: string): Promise<PublicationAssistedHandoff> {
    return parsePublicationAssistedHandoff(
      await this.request(`/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}`),
    );
  }

  async claimPublicationAssistedHandoff(
    handoffId: string,
    leaseSeconds = 120,
  ): Promise<PublicationAssistedHandoff> {
    const item = recordValue(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/claim`,
        { method: "POST", body: JSON.stringify({ leaseSeconds }) },
        true,
      ),
      "assisted handoff claim",
    );
    return parsePublicationAssistedHandoff(item.handoff);
  }

  async heartbeatPublicationAssistedHandoff(
    handoffId: string,
    leaseSeconds = 120,
  ): Promise<PublicationAssistedHandoff> {
    const item = recordValue(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/heartbeat`,
        { method: "POST", body: JSON.stringify({ leaseSeconds }) },
        true,
      ),
      "assisted handoff heartbeat",
    );
    return parsePublicationAssistedHandoff(item.handoff);
  }

  async cancelPublicationAssistedHandoff(
    handoffId: string,
    reason: string,
  ): Promise<{ readonly handoff: PublicationAssistedHandoff; readonly wasChanged: boolean }> {
    const item = recordValue(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/cancel`,
        { method: "POST", body: JSON.stringify({ reason }) },
        true,
      ),
      "assisted handoff cancellation",
    );
    return {
      handoff: parsePublicationAssistedHandoff(item.handoff),
      wasChanged: booleanValue(item, "wasChanged"),
    };
  }

  async preparePublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult> {
    return parsePublicationAssistedBridgeAction(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/prepare`,
        { method: "POST", body: JSON.stringify({}) },
        true,
      ),
      "prepare",
    );
  }

  async submitPublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult> {
    return parsePublicationAssistedBridgeAction(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/submit`,
        { method: "POST", body: JSON.stringify({}) },
        true,
      ),
      "submit",
    );
  }

  async readbackPublicationAssistedHandoff(
    handoffId: string,
  ): Promise<PublicationAssistedBridgeActionResult> {
    return parsePublicationAssistedBridgeAction(
      await this.request(
        `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/readback`,
        { method: "POST", body: JSON.stringify({}) },
        true,
      ),
      "readback",
    );
  }

  async getReceipts(): Promise<readonly PublicationReceipt[]> {
    return itemsValue(await this.request("/api/receipts"), parseReceipt);
  }

  async getReceipt(receiptId: string): Promise<PublicationReceipt> {
    return parseReceipt(await this.request(`/api/receipts/${encodeURIComponent(receiptId)}`));
  }

  async getVisibilitySummary(): Promise<readonly VisibilityProviderSummary[]> {
    return itemsValue(await this.request("/api/visibility/summary"), parseVisibilitySummary);
  }

  async getVisibilityRuns(): Promise<readonly VisibilityRun[]> {
    return itemsValue(await this.request("/api/visibility-runs"), parseVisibilityRun);
  }

  async getVisibilityRun(runId: string): Promise<VisibilityRunDetail> {
    return parseVisibilityRunDetail(
      await this.request(`/api/visibility-runs/${encodeURIComponent(runId)}`),
    );
  }

  async runFixtureVisibility(input: RunFixtureVisibilityInput): Promise<VisibilityRunResult> {
    return parseVisibilityRunResult(
      await this.request(
        "/api/visibility-runs",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async importVisibility(input: ImportVisibilityInput): Promise<VisibilityRunResult> {
    return parseVisibilityRunResult(
      await this.request(
        "/api/visibility-runs/import",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
    );
  }

  async createAutomationBatch(
    campaignId: string,
    input: CreateAutomationBatchInput,
  ): Promise<AutomationBatchCreateResult> {
    const item = recordValue(
      await this.request(
        `/api/campaigns/${encodeURIComponent(campaignId)}/automation-batches`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "automation batch create result",
    );
    return {
      batch: parseAutomationBatch(item.batch),
      wasCreated: booleanValue(item, "wasCreated"),
    };
  }

  async getAutomationBatches(): Promise<readonly AutomationBatch[]> {
    return itemsValue(await this.request("/api/automation-batches"), parseAutomationBatch);
  }

  async getAutomationRuns(): Promise<readonly AutomationRun[]> {
    return itemsValue(await this.request("/api/automation-runs"), parseAutomationRun);
  }

  async getAutomationRun(runId: string): Promise<AutomationRun> {
    return parseAutomationRun(
      await this.request(`/api/automation-runs/${encodeURIComponent(runId)}`),
    );
  }

  async cancelAutomationBatch(
    batchId: string,
    reason: string,
  ): Promise<AutomationBatchCancellationResult> {
    const item = recordValue(
      await this.request(
        `/api/automation-batches/${encodeURIComponent(batchId)}/cancel`,
        { method: "POST", body: JSON.stringify({ reason }) },
        true,
      ),
      "automation batch cancellation result",
    );
    return {
      batchId: stringValue(item, "batchId"),
      state: stringEnumValue(item, "state", AUTOMATION_BATCH_STATES),
      cancelledRuns: numberValue(item, "cancelledRuns"),
      cancelledTargets: numberValue(item, "cancelledTargets"),
      wasChanged: booleanValue(item, "wasChanged"),
    };
  }

  async getAutomation(): Promise<AutomationSnapshot> {
    return parseAutomationSnapshot(await this.request("/api/automation"));
  }

  async setAutomationControl(input: {
    readonly mode: AutomationMode;
    readonly quota: AutomationQuota;
    readonly reason: string;
  }): Promise<AutomationControl> {
    const payload = recordValue(
      await this.request(
        "/api/automation/control",
        { method: "PUT", body: JSON.stringify(input) },
        true,
      ),
      "automation control response",
    );
    return parseAutomationControl(payload.control);
  }

  async setScopedAutomationControl(
    scopeType: Exclude<AutomationScopeType, "tenant">,
    scopeKey: string,
    input: {
      readonly mode: AutomationMode;
      readonly quota: AutomationQuota;
      readonly killSwitchEnabled: boolean;
      readonly reason: string;
    },
  ): Promise<ScopedAutomationControl> {
    const payload = recordValue(
      await this.request(
        `/api/automation/controls/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeKey)}`,
        { method: "PUT", body: JSON.stringify(input) },
        true,
      ),
      "scoped automation control response",
    );
    return parseScopedAutomationControl(payload.control);
  }

  async setCircuitBreakerState(
    scopeType: AutomationScopeType,
    scopeKey: string,
    input: {
      readonly targetState: "open" | "closed";
      readonly retryAt?: string | null;
      readonly reason: string;
    },
  ): Promise<AutomationCircuit> {
    const payload = recordValue(
      await this.request(
        `/api/automation/circuits/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeKey)}/state`,
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "circuit breaker response",
    );
    return parseAutomationCircuit(payload.circuit);
  }

  async setKillSwitch(input: {
    readonly enabled: boolean;
    readonly reason: string;
  }): Promise<AutomationControl> {
    const payload = recordValue(
      await this.request(
        "/api/automation/kill-switch",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "kill switch response",
    );
    return parseAutomationControl(payload.control);
  }
}

export function createGeoApi(): GeoApi {
  return new HttpGeoApi(import.meta.env.VITE_API_BASE_URL ?? "");
}
