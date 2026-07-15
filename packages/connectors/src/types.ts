import type {
  AuditArtifact,
  ConnectorCapabilityReport,
  EvidenceType,
  ExecutionLevel,
  Platform,
  PublicationReceipt,
  PublicationVariantPayload,
} from "@geo/contracts";

export interface ProbeCapabilitiesInput {
  checkedAt: string;
}

export interface ConnectorScope {
  tenantId: string;
  channelAccountId: string;
  executionLevel: ExecutionLevel;
}

export type ValidateSessionInput = ConnectorScope;

export interface SessionValidation {
  validForPreview: boolean;
  externalWriteAvailable: boolean;
  requiresManualAction: boolean;
  reason: string;
}

export interface RenderDraftInput extends ConnectorScope {
  variantId: string;
  payload: PublicationVariantPayload;
}

export interface RenderedDraft {
  schemaVersion: "geo.connector.preview.v1";
  platform: Platform;
  tenantId: string;
  channelAccountId: string;
  variantId: string;
  executionLevel: ExecutionLevel;
  payload: PublicationVariantPayload;
  manualText: string;
  previewHash: string;
}

export interface PreflightResult {
  ok: boolean;
  externalWriteAllowed: boolean;
  checks: readonly {
    code: string;
    passed: boolean;
    message: string;
  }[];
}

export interface SubmitDraftInput extends ConnectorScope {
  renderedDraft: RenderedDraft;
  idempotencyKey: string;
}

export interface DraftSubmission {
  submitted: false;
  externalDraftId: null;
  requestHash: string;
  requiresManualAction: boolean;
  reason: string;
}

export interface PublishInput extends SubmitDraftInput {
  receiptId: string;
  jobId: string;
  attemptId: string;
  recordedAt: string;
}

export interface PublishResult {
  outcome: "preview_only" | "manual_action_required";
  receipt: PublicationReceipt;
}

export interface PollStatusInput extends ConnectorScope {
  requestHash: string;
}

export interface PollStatusResult {
  status: "preview_only" | "manual_confirmation_required";
  confirmed: false;
  externalId: null;
  externalUrl: null;
}

export interface ReconcileInput extends ConnectorScope {
  receipt: PublicationReceipt;
}

export interface ReconcileResult {
  outcome: "not_published" | "manual_confirmation_required";
  confirmed: false;
  externalId: null;
  externalUrl: null;
}

export interface CaptureEvidenceInput {
  renderedDraft: RenderedDraft;
  receipt: PublicationReceipt;
}

export interface ConnectorEvidence {
  evidenceType: "preview";
  evidenceHash: string;
  previewHash: string;
  requestHash: string;
  responseHash: string;
}

export interface ManualPackageInput {
  renderedDraft: RenderedDraft;
  auditArtifact: Readonly<AuditArtifact>;
  mediaAttachments: readonly ManualPackageMediaAttachmentInput[];
  exportedAt: string;
}

export interface ManualPackageMediaAttachmentInput {
  mediaAssetId: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  base64: string;
}

export interface ManualPackageMediaAttachment extends ManualPackageMediaAttachmentInput {
  fileName: string;
}

export interface ManualPublicationPackage {
  schemaVersion: "geo.manual-publication-package.v1";
  evidenceType: "preview";
  platform: Platform;
  tenantId: string;
  channelAccountId: string;
  variantId: string;
  executionLevel: "dry_run";
  auditArtifactId: string;
  payloadHash: string;
  auditHash: string;
  previewHash: string;
  mediaManifestHash: string;
  mediaCount: number;
  requiresManualAction: true;
  publicationStatus: "not_published";
  confirmed: false;
  exportedAt: string;
  files: Readonly<Record<string, string>>;
  attachments: readonly ManualPackageMediaAttachment[];
  packageHash: string;
}

export interface PlatformConnector {
  readonly platform: Platform;
  probeCapabilities(input: ProbeCapabilitiesInput): Promise<ConnectorCapabilityReport>;
  validateSession(input: ValidateSessionInput): Promise<SessionValidation>;
  renderDraft(input: RenderDraftInput): Promise<RenderedDraft>;
  preflight(input: SubmitDraftInput): Promise<PreflightResult>;
  submitDraft(input: SubmitDraftInput): Promise<DraftSubmission>;
  publish(input: PublishInput): Promise<PublishResult>;
  pollStatus(input: PollStatusInput): Promise<PollStatusResult>;
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
  captureEvidence(input: CaptureEvidenceInput): Promise<ConnectorEvidence>;
}

export type ConnectorEvidenceType = EvidenceType;
