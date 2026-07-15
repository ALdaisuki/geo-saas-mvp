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
  readonly profile: "custom" | "automation_producer";
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
  | { readonly type: "contact"; readonly contactId: string };

export type CanonicalBodyBlock =
  | { readonly type: "template"; readonly templateId: string }
  | {
      readonly type: "claim";
      readonly claimId: string;
      readonly presentation: "paragraph" | "bullet";
    }
  | {
      readonly type: "contact";
      readonly contactId: string;
      readonly presentation: "paragraph" | "bullet";
    };

export interface PublicationPayload {
  readonly title: string;
  readonly summary: string;
  readonly bodyMarkdown: string;
  readonly titleBlocks?: readonly CanonicalInlineBlock[];
  readonly summaryBlocks?: readonly CanonicalInlineBlock[];
  readonly bodyBlocks?: readonly CanonicalBodyBlock[];
  readonly tagTemplateIds?: readonly string[];
  readonly canonicalUrl?: string;
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
  readonly executionLevel: "dry_run";
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

export interface AutomationControl {
  readonly mode: string;
  readonly killSwitchEnabled: boolean;
  readonly reason: string | null;
  readonly quota: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface AutomationCircuit {
  readonly scopeType: string;
  readonly scopeKey: string;
  readonly state: string;
  readonly failureCount: number;
  readonly openedAt: string | null;
  readonly retryAt: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface AutomationSnapshot {
  readonly control: AutomationControl;
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
  readonly items: readonly CreateAutomationBatchItemInput[];
}

export interface AutomationBatch {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string | null;
  readonly state: AutomationBatchState;
  readonly executionLevel: "dry_run";
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
  getMembers(): Promise<readonly TenantMember[]>;
  createMember(input: CreateMemberInput): Promise<TenantMember>;
  updateMember(memberId: string, input: UpdateMemberInput): Promise<TenantMember>;
  getPolicies(): Promise<readonly PolicyBundle[]>;
  transitionPolicy(
    policyId: string,
    input: PolicyTransitionInput,
  ): Promise<PolicyTransitionResult>;
  getServicePrincipals(): Promise<readonly ServicePrincipal[]>;
  createAutomationServicePrincipal(input: { readonly name: string }): Promise<ServicePrincipal>;
  setServicePrincipalStatus(
    principalId: string,
    input: { readonly status: "active" | "disabled"; readonly reason: string },
  ): Promise<{ readonly principal: ServicePrincipal; readonly wasChanged: boolean }>;
  getQuerySets(): Promise<readonly QuerySet[]>;
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
  if (profile !== "custom" && profile !== "automation_producer") {
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
  throw protocolError(`unsupported canonical inline block type: ${type}`);
}

function parseCanonicalBodyBlock(value: unknown): CanonicalBodyBlock {
  const item = recordValue(value, "canonical body block");
  const type = stringValue(item, "type");
  if (type === "template") return { type, templateId: stringValue(item, "templateId") };
  const presentation = stringValue(item, "presentation");
  if (presentation !== "paragraph" && presentation !== "bullet") {
    throw protocolError(`unsupported canonical block presentation: ${presentation}`);
  }
  if (type === "claim") return { type, claimId: stringValue(item, "claimId"), presentation };
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
  const titleBlocks = item.titleBlocks;
  const summaryBlocks = item.summaryBlocks;
  const bodyBlocks = item.bodyBlocks;
  const tagTemplateIds = item.tagTemplateIds;
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
  return {
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

function parseAutomationControl(value: unknown): AutomationControl {
  const item = recordValue(value, "automation control");
  return {
    mode: stringValue(item, "mode"),
    killSwitchEnabled: booleanValue(item, "killSwitchEnabled"),
    reason: nullableStringValue(item, "reason"),
    quota: recordField(item, "quota"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationCircuit(value: unknown): AutomationCircuit {
  const item = recordValue(value, "automation circuit");
  return {
    scopeType: stringValue(item, "scopeType"),
    scopeKey: stringValue(item, "scopeKey"),
    state: stringValue(item, "state"),
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
  return {
    control: parseAutomationControl(body.control),
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
  const executionLevel = stringValue(item, "executionLevel");
  if (executionLevel !== "dry_run") {
    throw protocolError(`unsupported automation batch executionLevel: ${executionLevel}`);
  }
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
      await this.request(
        "/api/contacts",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
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
