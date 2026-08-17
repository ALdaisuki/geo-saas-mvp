import type {
  ConnectorCapability,
  ConnectorCapabilityReport,
  EvidenceType,
  ExecutionLevel,
  Platform,
} from "@geo/contracts";

export type ConnectorPolicyErrorCode =
  | "CAPABILITY_EVIDENCE_INSUFFICIENT"
  | "EXECUTION_LEVEL_UNSUPPORTED"
  | "UNATTENDED_REQUIRES_VERIFIED_API"
  | "EXTERNAL_WRITE_DISABLED"
  | "PREVIEW_CANNOT_CONFIRM_PUBLICATION"
  | "ASSISTED_SESSION_REQUIRED"
  | "ASSISTED_CHALLENGE_REQUIRED"
  | "ASSISTED_ADAPTER_DRIFT"
  | "ASSISTED_SCOPE_MISMATCH"
  | "ASSISTED_DRAFT_NOT_PREPARED"
  | "OUTBOUND_SOURCE_EVIDENCE_REQUIRED";

export class ConnectorPolicyError extends Error {
  readonly code: ConnectorPolicyErrorCode;
  readonly platform: Platform | undefined;
  readonly executionLevel: ExecutionLevel | undefined;

  constructor(
    code: ConnectorPolicyErrorCode,
    message: string,
    options: { platform?: Platform; executionLevel?: ExecutionLevel } = {},
  ) {
    super(message);
    this.name = "ConnectorPolicyError";
    this.code = code;
    this.platform = options.platform;
    this.executionLevel = options.executionLevel;
  }
}

export interface CapabilityUpgradeEvidence {
  capability: "public_api" | "partner_api" | "browser_assisted";
  evidenceType: EvidenceType;
  evidenceRefs: readonly string[];
  checkedAt: string;
  articlePublishingVerified: boolean;
  reconciliationVerified: boolean;
  unattendedBrowserVerified?: boolean;
}

function hasReviewedUnattendedAdapterEvidence(
  platform: Platform,
  evidenceRefs: readonly string[],
): boolean {
  const platformMarker = `adapter:${platform}-browser-unattended-`;
  return evidenceRefs.some((reference) => reference.startsWith(platformMarker));
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ConnectorPolicyError(
      "CAPABILITY_EVIDENCE_INSUFFICIENT",
      "Capability evidence must include a valid checkedAt timestamp",
    );
  }
}

export function buildCapabilityReport(
  platform: Platform,
  checkedAt: string,
  evidence?: CapabilityUpgradeEvidence,
): ConnectorCapabilityReport {
  assertTimestamp(checkedAt);

  if (evidence === undefined) {
    return {
      platform,
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      checkedAt,
      evidenceType: "preview",
      evidenceRefs: [],
      reason:
        "No verified public or partner article-publishing API is configured; publication execution is dry-run only. Manual package export is a separate non-publication action.",
    };
  }

  assertTimestamp(evidence.checkedAt);
  if (evidence.checkedAt !== checkedAt || evidence.evidenceRefs.length === 0) {
    throw new ConnectorPolicyError(
      "CAPABILITY_EVIDENCE_INSUFFICIENT",
      "Capability upgrades require non-empty evidence references from the current probe",
      { platform },
    );
  }

  if (!evidence.articlePublishingVerified) {
    throw new ConnectorPolicyError(
      "CAPABILITY_EVIDENCE_INSUFFICIENT",
      "Evidence does not verify an article-publishing operation",
      { platform },
    );
  }

  if (evidence.capability === "browser_assisted") {
    if (
      !(["browser_screenshot", "platform_readback"] as readonly EvidenceType[]).includes(
        evidence.evidenceType,
      )
    ) {
      throw new ConnectorPolicyError(
        "CAPABILITY_EVIDENCE_INSUFFICIENT",
        "Browser-assisted capability requires authenticated browser or platform readback evidence",
        { platform },
      );
    }
    const unattendedVerified =
      evidence.unattendedBrowserVerified === true &&
      evidence.reconciliationVerified &&
      evidence.evidenceType === "platform_readback" &&
      hasReviewedUnattendedAdapterEvidence(platform, evidence.evidenceRefs);
    return {
      platform,
      capability: evidence.capability,
      supportedExecutionLevels: unattendedVerified
        ? ["dry_run", "assisted", "unattended"]
        : ["dry_run", "assisted"],
      checkedAt,
      evidenceType: evidence.evidenceType,
      evidenceRefs: [...evidence.evidenceRefs],
      reason: unattendedVerified
        ? "A reviewed fixed browser adapter, one-time submit control and public readback were verified for unattended execution."
        : "Authenticated browser-assisted publishing was verified; unattended execution remains forbidden.",
    };
  }

  if (
    !evidence.reconciliationVerified ||
    !(["api_response", "platform_readback"] as readonly EvidenceType[]).includes(
      evidence.evidenceType,
    )
  ) {
    throw new ConnectorPolicyError(
      "CAPABILITY_EVIDENCE_INSUFFICIENT",
      "API capability requires verified publishing and reconciliation evidence",
      { platform },
    );
  }

  return {
    platform,
    capability: evidence.capability,
    supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    checkedAt,
    evidenceType: evidence.evidenceType,
    evidenceRefs: [...evidence.evidenceRefs],
    reason: `Verified ${evidence.capability === "public_api" ? "public" : "partner"} API publishing and reconciliation contract.`,
  };
}

export function executionLevelsForCapability(
  capability: ConnectorCapability,
): readonly ExecutionLevel[] {
  if (capability === "public_api" || capability === "partner_api") {
    return ["dry_run", "assisted", "unattended"];
  }
  if (capability === "browser_assisted") {
    return ["dry_run", "assisted"];
  }
  return ["dry_run"];
}

export function assertExecutionAllowed(
  report: ConnectorCapabilityReport,
  executionLevel: ExecutionLevel,
): void {
  if (executionLevel === "unattended" && !report.supportedExecutionLevels.includes("unattended")) {
    throw new ConnectorPolicyError(
      "UNATTENDED_REQUIRES_VERIFIED_API",
      `${report.platform} unattended publishing requires a verified API or reviewed fixed browser adapter with public readback`,
      { platform: report.platform, executionLevel },
    );
  }

  if (!report.supportedExecutionLevels.includes(executionLevel)) {
    throw new ConnectorPolicyError(
      "EXECUTION_LEVEL_UNSUPPORTED",
      `${report.platform} does not support execution level ${executionLevel}`,
      { platform: report.platform, executionLevel },
    );
  }
}
