import {
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
  type ConnectorCapabilityReport,
  type PublicationReceipt,
} from "@geo/contracts";

import {
  assertExecutionAllowed,
  buildCapabilityReport,
  ConnectorPolicyError,
  type CapabilityUpgradeEvidence,
  type ConnectorPolicyErrorCode,
} from "./capabilities.js";
import { DryRunConnector } from "./dry-run-connector.js";
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

const PLATFORM = "ctrip_community" as const;
const SESSION_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const DRY_RUN_DEFINITION = {
  platform: PLATFORM,
  displayName: "携程社区",
  manualInstructions: [
    "登录已授权的携程社区创作者界面。",
    "核对平台、账号、payloadHash 与 auditHash。",
    "人工处理登录或验证挑战，并执行最终发布。",
    "发布后通过独立 readback 导入携程公开 URL。",
  ],
} as const;

export type CtripSessionStatus =
  "ready" | "session_required" | "challenge_required" | "adapter_drift";

export interface CtripSessionProbe {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly status: CtripSessionStatus;
  readonly checkedAt: string;
  readonly adapterVersion: string;
  readonly evidenceRef: string;
}

export interface CtripPrepareDraftInput {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly executionLevel: "assisted" | "unattended";
  readonly renderedDraft: RenderedDraft;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface CtripDraftPreparation {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly previewHash: string;
  readonly requestHash: string;
  readonly status: "prepared" | Exclude<CtripSessionStatus, "ready">;
  readonly adapterVersion: string;
  readonly externalDraftId: string | null;
  readonly evidenceHash: string;
}

export interface CtripAssistedSessionPort {
  validateSession(input: ValidateSessionInput): Promise<CtripSessionProbe>;
  prepareDraft(input: CtripPrepareDraftInput): Promise<CtripDraftPreparation>;
}

export interface CtripCommunityConnectorOptions {
  readonly capabilityEvidence?: CapabilityUpgradeEvidence | undefined;
  readonly capabilityEvidenceExpiresAt?: string | undefined;
  readonly approvedAdapterVersion?: string | undefined;
  readonly sessionPort?: CtripAssistedSessionPort | undefined;
  readonly now?: (() => Date) | undefined;
}

function renderCtripText(input: RenderDraftInput): string {
  const topics = input.payload.tags.map((tag) => `#${tag}`).join(" ");
  return [
    "目标平台：携程社区",
    `标题：${input.payload.title}`,
    "",
    input.payload.summary,
    "",
    input.payload.bodyMarkdown,
    ...(topics.length === 0 ? [] : ["", topics]),
  ].join("\n");
}

function draftHashMaterial(draft: Omit<RenderedDraft, "previewHash">): unknown {
  return draft;
}

export function renderCtripCommunityAssistedDraft(input: RenderDraftInput): RenderedDraft {
  if (input.executionLevel !== "assisted" && input.executionLevel !== "unattended") {
    throw new TypeError("Ctrip browser handoff rendering requires assisted or unattended execution");
  }
  const payload = publicationVariantPayloadSchema.parse(input.payload);
  const hashMaterial: Omit<RenderedDraft, "previewHash"> = {
    schemaVersion: "geo.connector.preview.v1",
    platform: PLATFORM,
    tenantId: input.tenantId,
    channelAccountId: input.channelAccountId,
    variantId: input.variantId,
    executionLevel: input.executionLevel,
    payload,
    manualText: renderCtripText({ ...input, payload }),
  };
  return { ...hashMaterial, previewHash: stableSha256(draftHashMaterial(hashMaterial)) };
}

function statusError(status: Exclude<CtripSessionStatus, "ready">): {
  code: ConnectorPolicyErrorCode;
  message: string;
} {
  switch (status) {
    case "session_required":
      return {
        code: "ASSISTED_SESSION_REQUIRED",
        message: "Ctrip assisted publishing requires an authenticated operator session",
      };
    case "challenge_required":
      return {
        code: "ASSISTED_CHALLENGE_REQUIRED",
        message: "Ctrip requires operator handling of a login or risk-control challenge",
      };
    case "adapter_drift":
      return {
        code: "ASSISTED_ADAPTER_DRIFT",
        message: "The reviewed Ctrip authoring adapter no longer matches the platform surface",
      };
  }
}

function isSessionStatus(value: unknown): value is CtripSessionStatus {
  return (
    value === "ready" ||
    value === "session_required" ||
    value === "challenge_required" ||
    value === "adapter_drift"
  );
}

function isPreparationStatus(value: unknown): value is CtripDraftPreparation["status"] {
  return (
    value === "prepared" ||
    value === "session_required" ||
    value === "challenge_required" ||
    value === "adapter_drift"
  );
}

export class CtripCommunityConnector implements PlatformConnector {
  readonly platform = PLATFORM;
  readonly #dryRun = new DryRunConnector(DRY_RUN_DEFINITION);
  readonly #capabilityEvidence: CapabilityUpgradeEvidence | undefined;
  readonly #capabilityEvidenceExpiresAt: string | undefined;
  readonly #approvedAdapterVersion: string | undefined;
  readonly #sessionPort: CtripAssistedSessionPort | undefined;
  readonly #now: () => Date;

  constructor(options: CtripCommunityConnectorOptions = {}) {
    const assistedFields = [
      options.capabilityEvidence,
      options.capabilityEvidenceExpiresAt,
      options.approvedAdapterVersion,
      options.sessionPort,
    ];
    if (
      assistedFields.some((value) => value === undefined) &&
      assistedFields.some((value) => value !== undefined)
    ) {
      throw new TypeError(
        "Ctrip capability evidence, expiry and assisted session port must be configured together",
      );
    }
    if (
      options.capabilityEvidence !== undefined &&
      options.capabilityEvidence.capability !== "browser_assisted"
    ) {
      throw new TypeError("Ctrip supervised connector requires browser_assisted evidence");
    }
    if (
      options.approvedAdapterVersion !== undefined &&
      (options.approvedAdapterVersion.trim().length === 0 ||
        options.approvedAdapterVersion.length > 100)
    ) {
      throw new TypeError("Ctrip approved adapter version must be a non-empty reviewed value");
    }
    if (options.capabilityEvidenceExpiresAt !== undefined) {
      const expiresAt = Date.parse(options.capabilityEvidenceExpiresAt);
      const checkedAt = Date.parse(options.capabilityEvidence?.checkedAt ?? "");
      if (!Number.isFinite(expiresAt) || !Number.isFinite(checkedAt) || expiresAt <= checkedAt) {
        throw new TypeError("Ctrip capability evidence expiry must be later than its review time");
      }
    }
    this.#capabilityEvidence = options.capabilityEvidence;
    this.#capabilityEvidenceExpiresAt = options.capabilityEvidenceExpiresAt;
    this.#approvedAdapterVersion = options.approvedAdapterVersion;
    this.#sessionPort = options.sessionPort;
    this.#now = options.now ?? (() => new Date());
  }

  #assertEvidenceCurrent(): void {
    if (this.#capabilityEvidenceExpiresAt === undefined) return;
    const now = this.#now().getTime();
    const checkedAt = Date.parse(this.#capabilityEvidence?.checkedAt ?? "");
    const expiresAt = Date.parse(this.#capabilityEvidenceExpiresAt);
    if (now < checkedAt || now >= expiresAt) {
      throw new ConnectorPolicyError(
        "CAPABILITY_EVIDENCE_INSUFFICIENT",
        "Ctrip browser-assisted capability evidence is not current",
        { platform: this.platform },
      );
    }
  }

  async probeCapabilities(input: ProbeCapabilitiesInput): Promise<ConnectorCapabilityReport> {
    this.#assertEvidenceCurrent();
    return buildCapabilityReport(this.platform, input.checkedAt, this.#capabilityEvidence);
  }

  #capabilityReport(): ConnectorCapabilityReport {
    this.#assertEvidenceCurrent();
    const checkedAt = this.#capabilityEvidence?.checkedAt ?? "2026-07-16T00:00:00.000Z";
    return buildCapabilityReport(this.platform, checkedAt, this.#capabilityEvidence);
  }

  #assertAllowed(executionLevel: ValidateSessionInput["executionLevel"]): void {
    assertExecutionAllowed(this.#capabilityReport(), executionLevel);
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
        "Rendered draft scope does not match the Ctrip connector operation",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    const { previewHash, ...hashMaterial } = input.renderedDraft;
    if (stableSha256(draftHashMaterial(hashMaterial)) !== previewHash) {
      throw new ConnectorPolicyError(
        "EXTERNAL_WRITE_DISABLED",
        "Rendered Ctrip draft changed after preview hashing",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
  }

  #assertSessionScope(input: ValidateSessionInput, probe: CtripSessionProbe): void {
    const checkedAt = Date.parse(probe.checkedAt);
    const evidenceAge = this.#now().getTime() - checkedAt;
    if (
      probe.tenantId !== input.tenantId ||
      probe.channelAccountId !== input.channelAccountId ||
      !isSessionStatus(probe.status) ||
      !Number.isFinite(checkedAt) ||
      evidenceAge < 0 ||
      evidenceAge > SESSION_EVIDENCE_MAX_AGE_MS ||
      typeof probe.adapterVersion !== "string" ||
      probe.adapterVersion.trim().length === 0 ||
      probe.adapterVersion.length > 100 ||
      typeof probe.evidenceRef !== "string" ||
      probe.evidenceRef.length > 1_000 ||
      probe.evidenceRef.trim().length === 0
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_SCOPE_MISMATCH",
        "Ctrip session evidence did not match the requested tenant and account scope",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    if (probe.adapterVersion !== this.#approvedAdapterVersion) {
      throw new ConnectorPolicyError(
        "ASSISTED_ADAPTER_DRIFT",
        "Ctrip session adapter version does not match the reviewed capability evidence",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
  }

  #assistedPort(): CtripAssistedSessionPort {
    if (this.#sessionPort === undefined) {
      throw new ConnectorPolicyError(
        "EXTERNAL_WRITE_DISABLED",
        "Ctrip assisted session transport is not configured",
        { platform: this.platform, executionLevel: "assisted" },
      );
    }
    return this.#sessionPort;
  }

  async validateSession(input: ValidateSessionInput): Promise<SessionValidation> {
    if (input.executionLevel === "dry_run") return this.#dryRun.validateSession(input);
    this.#assertAllowed(input.executionLevel);
    const probe = await this.#assistedPort().validateSession(input);
    this.#assertSessionScope(input, probe);
    const ready = probe.status === "ready";
    return {
      validForPreview: ready,
      externalWriteAvailable: ready,
      requiresManualAction: true,
      reason: ready
        ? "Authenticated Ctrip session is ready for supervised draft preparation only."
        : statusError(probe.status).message,
    };
  }

  async renderDraft(input: RenderDraftInput): Promise<RenderedDraft> {
    if (input.executionLevel === "dry_run") return this.#dryRun.renderDraft(input);
    this.#assertAllowed(input.executionLevel);
    return renderCtripCommunityAssistedDraft(input);
  }

  async #sessionProbe(input: SubmitDraftInput): Promise<CtripSessionProbe> {
    const probe = await this.#assistedPort().validateSession(input);
    this.#assertSessionScope(input, probe);
    return probe;
  }

  async preflight(input: SubmitDraftInput): Promise<PreflightResult> {
    if (input.executionLevel === "dry_run") return this.#dryRun.preflight(input);
    return (await this.#assistedPreflight(input)).result;
  }

  async #assistedPreflight(
    input: SubmitDraftInput,
  ): Promise<{ result: PreflightResult; probe: CtripSessionProbe }> {
    this.#assertAllowed(input.executionLevel);
    this.#assertDraft(input);
    const probe = await this.#sessionProbe(input);
    const ready = probe.status === "ready";
    return {
      probe,
      result: {
        ok: ready,
        externalWriteAllowed: ready,
        checks: [
          {
            code: "preview_integrity",
            passed: true,
            message: "Preview hash matches the exact rendered Ctrip draft.",
          },
          {
            code: `assisted_${probe.status}`,
            passed: ready,
            message: ready
              ? "The reviewed Ctrip adapter has an authenticated supervised session."
              : statusError(probe.status).message,
          },
          {
            code: "operator_final_submit_required",
            passed: true,
            message: "Draft preparation cannot execute or confirm the final publish action.",
          },
        ],
      },
    };
  }

  async submitDraft(input: SubmitDraftInput): Promise<DraftSubmission> {
    if (input.executionLevel === "dry_run") return this.#dryRun.submitDraft(input);
    const { result: preflight, probe } = await this.#assistedPreflight(input);
    if (!preflight.ok) {
      const status = preflight.checks
        .find((check) => !check.passed && check.code.startsWith("assisted_"))
        ?.code.replace(/^assisted_/u, "") as Exclude<CtripSessionStatus, "ready"> | undefined;
      if (status !== undefined) {
        const failure = statusError(status);
        throw new ConnectorPolicyError(failure.code, failure.message, {
          platform: this.platform,
          executionLevel: input.executionLevel,
        });
      }
      throw new ConnectorPolicyError(
        "ASSISTED_DRAFT_NOT_PREPARED",
        "Ctrip assisted preflight did not permit draft preparation",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }

    const requestHash = stableSha256({
      schemaVersion: "geo.connector.request.v1",
      operation: "prepareDraft",
      platform: this.platform,
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      executionLevel: input.executionLevel,
      idempotencyKey: input.idempotencyKey,
      previewHash: input.renderedDraft.previewHash,
    });
    const preparation = await this.#assistedPort().prepareDraft({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      executionLevel: input.executionLevel,
      renderedDraft: input.renderedDraft,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (
      preparation.tenantId !== input.tenantId ||
      preparation.channelAccountId !== input.channelAccountId ||
      preparation.previewHash !== input.renderedDraft.previewHash ||
      preparation.requestHash !== requestHash ||
      !isPreparationStatus(preparation.status) ||
      typeof preparation.adapterVersion !== "string" ||
      typeof preparation.evidenceHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(preparation.evidenceHash)
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_SCOPE_MISMATCH",
        "Ctrip draft preparation evidence did not echo the exact operation scope and hashes",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    if (
      preparation.adapterVersion !== probe.adapterVersion ||
      preparation.adapterVersion !== this.#approvedAdapterVersion
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_ADAPTER_DRIFT",
        "Ctrip draft preparation used an adapter version that was not reviewed in preflight",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    if (preparation.status !== "prepared") {
      const failure = statusError(preparation.status);
      throw new ConnectorPolicyError(failure.code, failure.message, {
        platform: this.platform,
        executionLevel: input.executionLevel,
      });
    }
    if (
      typeof preparation.externalDraftId !== "string" ||
      preparation.externalDraftId.trim().length === 0 ||
      preparation.externalDraftId.length > 500 ||
      preparation.adapterVersion.length > 100 ||
      preparation.adapterVersion.trim().length === 0
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_DRAFT_NOT_PREPARED",
        "Ctrip adapter did not return a valid prepared-draft reference",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    const responseHash = stableSha256({
      schemaVersion: "geo.connector.response.v1",
      operation: "prepareDraft",
      platform: this.platform,
      status: preparation.status,
      requestHash,
      externalDraftId: preparation.externalDraftId,
      adapterVersion: preparation.adapterVersion,
      evidenceHash: preparation.evidenceHash,
      confirmed: false,
    });
    return {
      state: "draft_prepared",
      submitted: false,
      externalDraftId: preparation.externalDraftId,
      requestHash,
      responseHash,
      evidenceHash: preparation.evidenceHash,
      requiresManualAction: input.executionLevel !== "unattended",
      reason:
        input.executionLevel === "unattended"
          ? "Ctrip draft was prepared for the reviewed unattended browser controller."
          : "Ctrip draft was prepared in a supervised session; an operator must perform final submit.",
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (input.executionLevel === "dry_run") return this.#dryRun.publish(input);
    const submission = await this.submitDraft(input);
    if (
      submission.state !== "draft_prepared" ||
      submission.externalDraftId === null ||
      submission.responseHash === undefined ||
      submission.evidenceHash === undefined
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_DRAFT_NOT_PREPARED",
        "Ctrip draft preparation did not produce immutable evidence",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    const receipt: PublicationReceipt = publicationReceiptSchema.parse({
      id: input.receiptId,
      tenantId: input.tenantId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      platform: this.platform,
      executionLevel: input.executionLevel,
      evidenceType: "browser_screenshot",
      requestHash: submission.requestHash,
      responseHash: submission.responseHash,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      recordedAt: input.recordedAt,
      confirmed: false,
    });
    return { outcome: "manual_action_required", receipt };
  }

  async pollStatus(input: PollStatusInput): Promise<PollStatusResult> {
    if (input.executionLevel === "dry_run") return this.#dryRun.pollStatus(input);
    this.#assertAllowed(input.executionLevel);
    return {
      status: "manual_confirmation_required",
      confirmed: false,
      externalId: null,
      externalUrl: null,
    };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    if (input.executionLevel === "dry_run") return this.#dryRun.reconcile(input);
    this.#assertAllowed(input.executionLevel);
    if (
      input.receipt.platform !== this.platform ||
      input.receipt.executionLevel !== input.executionLevel ||
      input.receipt.evidenceType !== "browser_screenshot" ||
      input.receipt.confirmed
    ) {
      throw new ConnectorPolicyError(
        "PREVIEW_CANNOT_CONFIRM_PUBLICATION",
        "Ctrip draft evidence cannot confirm a public publication",
        { platform: this.platform, executionLevel: input.executionLevel },
      );
    }
    return {
      outcome: "manual_confirmation_required",
      confirmed: false,
      externalId: null,
      externalUrl: null,
    };
  }

  async captureEvidence(input: CaptureEvidenceInput): Promise<ConnectorEvidence> {
    if (input.renderedDraft.executionLevel === "dry_run") {
      return this.#dryRun.captureEvidence(input);
    }
    if (
      input.renderedDraft.platform !== this.platform ||
      input.receipt.platform !== this.platform ||
      input.renderedDraft.tenantId !== input.receipt.tenantId ||
      input.renderedDraft.executionLevel !== input.receipt.executionLevel ||
      input.receipt.evidenceType !== "browser_screenshot" ||
      input.receipt.confirmed
    ) {
      throw new ConnectorPolicyError(
        "ASSISTED_SCOPE_MISMATCH",
        "Ctrip browser evidence scope did not match the rendered draft and receipt",
        { platform: this.platform, executionLevel: input.renderedDraft.executionLevel },
      );
    }
    const evidence = {
      schemaVersion: "geo.connector.browser-draft-evidence.v1",
      platform: this.platform,
      tenantId: input.renderedDraft.tenantId,
      channelAccountId: input.renderedDraft.channelAccountId,
      variantId: input.renderedDraft.variantId,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.receipt.requestHash,
      responseHash: input.receipt.responseHash,
      confirmed: false,
    };
    return {
      evidenceType: "browser_screenshot",
      evidenceHash: stableSha256(evidence),
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.receipt.requestHash,
      responseHash: input.receipt.responseHash,
    };
  }
}
