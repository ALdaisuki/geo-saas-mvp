import type {
  AuditArtifact,
  ConnectorCapabilityReport,
  EvidenceType,
  ExecutionLevel,
  Platform,
  PublicationReceipt,
  PublicationVariantPayload,
} from "@geo/contracts";

import type { OutboundImplementationManifest } from "./outbound-source-provenance.js";

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
  state: "not_submitted" | "draft_prepared";
  submitted: false;
  externalDraftId: string | null;
  requestHash: string;
  responseHash?: string | undefined;
  evidenceHash?: string | undefined;
  requiresManualAction: boolean;
  reason: string;
}

export interface PublishInput extends SubmitDraftInput {
  receiptId: string;
  jobId: string;
  attemptId: string;
  recordedAt: string;
}

export type SubmissionOutcome = "not_submitted" | "accepted" | "rejected" | "uncertain";

export type ModerationState =
  "unknown" | "submitted" | "reviewing" | "approved" | "rejected" | "removed";

export type ReadbackState = "not_attempted" | "pending" | "matched" | "mismatched" | "not_found";

export const PLATFORM_STATUS_SUMMARY_MAX_LENGTH = 500;

declare const platformStatusSummaryBrand: unique symbol;

/** A low-cardinality platform status, never an unbounded raw response body. */
export type PlatformStatusSummary = string & {
  readonly [platformStatusSummaryBrand]: true;
};

export function createPlatformStatusSummary(value: string): PlatformStatusSummary {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > PLATFORM_STATUS_SUMMARY_MAX_LENGTH) {
    throw new TypeError(
      `Platform status summary must contain 1-${PLATFORM_STATUS_SUMMARY_MAX_LENGTH} characters`,
    );
  }
  return normalized as PlatformStatusSummary;
}

interface DeliveryObservationBase {
  submissionOutcome: SubmissionOutcome;
  moderationState: ModerationState;
  platformStatusSummary: PlatformStatusSummary;
}

/** `confirmed: true` is only representable with a matched independent public readback. */
export type DeliveryObservation =
  | (DeliveryObservationBase & {
      readbackState: Exclude<ReadbackState, "matched">;
      externalId: string | null;
      externalUrl: string | null;
      evidenceHash: string | null;
      confirmed: false;
    })
  | (DeliveryObservationBase & {
      submissionOutcome: "accepted" | "uncertain";
      readbackState: "matched";
      externalId: string;
      externalUrl: string;
      evidenceHash: string;
      confirmed: true;
    });

export type PublishResult = DeliveryObservation & {
  outcome: "preview_only" | "manual_action_required";
  receipt: PublicationReceipt;
};

export interface PollStatusInput extends ConnectorScope {
  requestHash: string;
}

export type PollStatusResult = DeliveryObservation & {
  status: "preview_only" | "manual_confirmation_required";
};

export interface ReconcileInput extends ConnectorScope {
  receipt: PublicationReceipt;
}

export type ReconcileResult = DeliveryObservation & {
  outcome: "not_published" | "manual_confirmation_required";
};

export interface CaptureEvidenceInput {
  renderedDraft: RenderedDraft;
  receipt: PublicationReceipt;
}

export interface ConnectorEvidence {
  evidenceType: "preview" | "browser_screenshot";
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

export interface GitHubSourcedPlatformConnector extends PlatformConnector {
  readonly outboundImplementation: OutboundImplementationManifest;
}

export type ConnectorEvidenceType = EvidenceType;
