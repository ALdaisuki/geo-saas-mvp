import type {
  CtripBridgeEvidenceKind,
  MediaReference,
  PublicationVariantPayload,
} from "@geo/contracts";
import type { RenderedDraft } from "@geo/connectors";

export const CTRIP_SIMULATOR_ADAPTER_VERSION = "ctrip-community-simulator-v1";

export interface CtripBridgeExecutionContext {
  readonly tenantId: string;
  readonly bridgePrincipalId: string;
  readonly requestId: string;
}

export interface CtripBridgeHandoffDraft {
  readonly id: string;
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly variantId: string;
  readonly contentVersionId: string;
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
  readonly previewHash: string;
  readonly payloadHash: string;
  readonly adapterVersion: string;
  readonly bridgePrincipalId: string;
  readonly externalDraftId: string | null;
  readonly submitOutcome: "accepted" | "uncertain" | "rejected" | null;
  readonly submitEvidenceKind: "simulation" | "browser" | null;
  readonly submitPermitConsumedAt: string | null;
  readonly payload: PublicationVariantPayload;
}

export interface CtripBridgePreparedEvidence {
  readonly externalDraftId: string;
  readonly sessionEvidenceHash: string;
  readonly draftEvidenceHash: string;
  readonly evidenceHash: string;
  readonly mediaManifestHash: string;
  readonly observedAt: string;
  readonly evidenceKind: "simulation" | "browser";
}

export interface CtripBridgeMediaAsset {
  readonly contentVersionId: string;
  readonly position: number;
  readonly bindingPlatform: "ctrip_community";
  readonly bindingRole: "cover" | "inline";
  readonly bindingAltText: string;
  readonly bindingCaption: string;
  readonly storageKey: string;
  readonly reference: MediaReference;
}

export interface CtripTrustedMediaAttachment {
  readonly position: number;
  readonly reference: MediaReference;
  readonly bytes: Uint8Array;
}

export interface CtripBridgeSubmitObservation {
  readonly outcome: "accepted" | "uncertain" | "rejected";
  readonly evidenceHash: string;
  readonly observedAt: string;
  readonly evidenceKind: "simulation" | "browser";
}

export interface CtripBridgeReadbackObservation {
  readonly outcome: "confirmed" | "not_found" | "mismatch" | "unavailable" | "simulation_only";
  readonly evidenceHash: string;
  readonly observedAt: string;
  readonly evidenceKind: CtripBridgeEvidenceKind;
  readonly observedPayloadHash: string | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
}

export interface CtripBridgeControlPlane {
  loadHandoff(
    context: CtripBridgeExecutionContext,
    handoffId: string,
  ): Promise<CtripBridgeHandoffDraft>;
  loadPreparedMediaAssets(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
  ): Promise<readonly CtripBridgeMediaAsset[]>;
  recordPrepared(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidence: CtripBridgePreparedEvidence,
  ): Promise<void>;
  consumeSubmitPermit(
    context: CtripBridgeExecutionContext,
    handoffId: string,
    submitPermit: string,
  ): Promise<void>;
  recordSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeSubmitObservation,
  ): Promise<{ readonly receiptId: string; readonly readbackId: string }>;
  recoverSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidenceKind: "simulation" | "browser",
  ): Promise<{ readonly receiptId: string; readonly readbackId: string }>;
  recordReadback(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeReadbackObservation,
  ): Promise<{
    readonly state: "readback_pending" | "confirmed" | "needs_review";
    readonly externalId: string | null;
    readonly externalUrl: string | null;
  }>;
}

export interface CtripFixedAdapter {
  readonly version: string;
  readonly evidenceKind: "simulation" | "browser";
  prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePreparedEvidence>;
  submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation>;
  readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation>;
}
