import {
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
  type ConnectorCapabilityReport,
  type Platform,
  type PublicationReceipt,
} from "@geo/contracts";

import {
  assertExecutionAllowed,
  buildCapabilityReport,
  ConnectorPolicyError,
} from "./capabilities.js";
import { stableSha256 } from "./hash.js";
import type {
  CaptureEvidenceInput,
  ConnectorEvidence,
  DraftSubmission,
  PlatformConnector,
  PollStatusInput,
  PollStatusResult,
  PreflightResult,
  ProbeCapabilitiesInput,
  PublishInput,
  PublishResult,
  ReconcileInput,
  ReconcileResult,
  RenderDraftInput,
  RenderedDraft,
  SessionValidation,
  SubmitDraftInput,
  ValidateSessionInput,
} from "./types.js";

interface PlatformDefinition {
  platform: Platform;
  displayName: string;
  manualInstructions: readonly string[];
}

function renderManualText(displayName: string, input: RenderDraftInput): string {
  const tags = input.payload.tags.map((tag) => `#${tag}`).join(" ");
  return [
    `目标平台：${displayName}`,
    `标题：${input.payload.title}`,
    "",
    input.payload.summary,
    "",
    input.payload.bodyMarkdown,
    tags.length > 0 ? `\n${tags}` : "",
  ].join("\n");
}

function draftHashMaterial(draft: Omit<RenderedDraft, "previewHash">): unknown {
  return draft;
}

export class DryRunConnector implements PlatformConnector {
  readonly platform: Platform;
  readonly #definition: PlatformDefinition;

  constructor(definition: PlatformDefinition) {
    this.platform = definition.platform;
    this.#definition = definition;
  }

  async probeCapabilities(input: ProbeCapabilitiesInput): Promise<ConnectorCapabilityReport> {
    return buildCapabilityReport(this.platform, input.checkedAt);
  }

  async #assertAllowed(executionLevel: ValidateSessionInput["executionLevel"]): Promise<void> {
    const report = await this.probeCapabilities({ checkedAt: "2026-07-13T00:00:00.000Z" });
    assertExecutionAllowed(report, executionLevel);
  }

  async validateSession(input: ValidateSessionInput): Promise<SessionValidation> {
    await this.#assertAllowed(input.executionLevel);
    return {
      validForPreview: true,
      externalWriteAvailable: false,
      requiresManualAction: false,
      reason: "Dry-run preview does not require or operate a platform session.",
    };
  }

  async renderDraft(input: RenderDraftInput): Promise<RenderedDraft> {
    await this.#assertAllowed(input.executionLevel);
    const payload = publicationVariantPayloadSchema.parse(input.payload);
    const draftWithoutHash: Omit<RenderedDraft, "previewHash"> = {
      schemaVersion: "geo.connector.preview.v1",
      platform: this.platform,
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      variantId: input.variantId,
      executionLevel: input.executionLevel,
      payload,
      manualText: renderManualText(this.#definition.displayName, { ...input, payload }),
    };
    return {
      ...draftWithoutHash,
      previewHash: stableSha256(draftHashMaterial(draftWithoutHash)),
    };
  }

  #assertDraft(input: SubmitDraftInput): void {
    if (
      input.renderedDraft.platform !== this.platform ||
      input.renderedDraft.tenantId !== input.tenantId ||
      input.renderedDraft.channelAccountId !== input.channelAccountId ||
      input.renderedDraft.executionLevel !== input.executionLevel
    ) {
      throw new ConnectorPolicyError(
        "EXTERNAL_WRITE_DISABLED",
        "Rendered draft scope does not match the connector operation",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }

    const { previewHash, ...hashMaterial } = input.renderedDraft;
    if (stableSha256(draftHashMaterial(hashMaterial)) !== previewHash) {
      throw new ConnectorPolicyError(
        "EXTERNAL_WRITE_DISABLED",
        "Rendered draft changed after preview hashing",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
  }

  async preflight(input: SubmitDraftInput): Promise<PreflightResult> {
    await this.#assertAllowed(input.executionLevel);
    this.#assertDraft(input);
    return {
      ok: true,
      externalWriteAllowed: false,
      checks: [
        {
          code: "preview_integrity",
          passed: true,
          message: "Preview hash matches the exact rendered draft.",
        },
        {
          code: "external_write_disabled",
          passed: true,
          message:
            "Connector is constrained to preview/manual export and performs no network writes.",
        },
      ],
    };
  }

  async submitDraft(input: SubmitDraftInput): Promise<DraftSubmission> {
    await this.preflight(input);
    return {
      submitted: false,
      externalDraftId: null,
      requestHash: stableSha256({
        schemaVersion: "geo.connector.request.v1",
        operation: "submitDraft",
        platform: this.platform,
        tenantId: input.tenantId,
        channelAccountId: input.channelAccountId,
        executionLevel: input.executionLevel,
        idempotencyKey: input.idempotencyKey,
        previewHash: input.renderedDraft.previewHash,
      }),
      requiresManualAction: false,
      reason: "Dry-run connector intentionally did not submit a platform draft.",
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const submission = await this.submitDraft(input);
    const outcome = "preview_only";
    const responseHash = stableSha256({
      schemaVersion: "geo.connector.response.v1",
      operation: "publish",
      platform: this.platform,
      outcome,
      requestHash: submission.requestHash,
      confirmed: false,
      externalId: null,
      externalUrl: null,
    });
    const receipt: PublicationReceipt = publicationReceiptSchema.parse({
      id: input.receiptId,
      tenantId: input.tenantId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      platform: this.platform,
      executionLevel: input.executionLevel,
      evidenceType: "preview",
      requestHash: submission.requestHash,
      responseHash,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      recordedAt: input.recordedAt,
      confirmed: false,
    });
    return { outcome, receipt };
  }

  async pollStatus(input: PollStatusInput): Promise<PollStatusResult> {
    await this.#assertAllowed(input.executionLevel);
    return {
      status: "preview_only",
      confirmed: false,
      externalId: null,
      externalUrl: null,
    };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    await this.#assertAllowed(input.executionLevel);
    if (input.receipt.evidenceType !== "preview" || input.receipt.confirmed) {
      throw new ConnectorPolicyError(
        "PREVIEW_CANNOT_CONFIRM_PUBLICATION",
        "Dry-run connector can only reconcile its own unconfirmed preview receipts",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    return {
      outcome: "not_published",
      confirmed: false,
      externalId: null,
      externalUrl: null,
    };
  }

  async captureEvidence(input: CaptureEvidenceInput): Promise<ConnectorEvidence> {
    if (
      input.renderedDraft.platform !== this.platform ||
      input.receipt.platform !== this.platform
    ) {
      throw new ConnectorPolicyError(
        "PREVIEW_CANNOT_CONFIRM_PUBLICATION",
        "Evidence scope must match the connector platform",
        { platform: this.platform },
      );
    }
    const evidence = {
      schemaVersion: "geo.connector.preview-evidence.v1",
      platform: this.platform,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.receipt.requestHash,
      responseHash: input.receipt.responseHash,
      confirmed: false,
    };
    return {
      evidenceType: "preview",
      evidenceHash: stableSha256(evidence),
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.receipt.requestHash,
      responseHash: input.receipt.responseHash,
    };
  }

  get manualInstructions(): readonly string[] {
    return this.#definition.manualInstructions;
  }
}
