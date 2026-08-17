import {
  channelAccountCreateRequestSchema,
  type ConnectorCapability,
  type ContactType,
  type EvidenceType,
  type ExecutionLevel,
  type Platform,
  type TenantRole,
} from "@geo/contracts";

export class TenantGovernanceInvariantError extends Error {
  readonly code = "TENANT_GOVERNANCE_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "TenantGovernanceInvariantError";
  }
}

export function resolveCtripRuntimeEvidence(input: {
  readonly currentEvidenceType: EvidenceType;
  readonly currentEvidenceRefs: readonly string[];
  readonly runtimeReady: boolean;
}): { readonly evidenceType: EvidenceType; readonly evidenceRefs: readonly string[] } {
  if (!input.runtimeReady || input.currentEvidenceType === "platform_readback") {
    return {
      evidenceType: input.currentEvidenceType,
      evidenceRefs: [...input.currentEvidenceRefs],
    };
  }
  return {
    evidenceType: "browser_screenshot",
    evidenceRefs: ["browser-runtime-readiness"],
  };
}

export function normalizeContactValue(type: ContactType, rawValue: string): string {
  const value = rawValue.trim().normalize("NFKC");
  let normalized: string;
  if (type === "phone") {
    normalized = value.replace(/[\s()-]/gu, "");
  } else if (type === "email" || type === "wechat") {
    normalized = value.toLocaleLowerCase("en-US");
  } else if (type === "website") {
    try {
      const url = new URL(value);
      url.hostname = url.hostname.toLocaleLowerCase("en-US");
      normalized = url.toString().replace(/\/$/u, "");
    } catch {
      normalized = value.toLocaleLowerCase("en-US");
    }
  } else {
    normalized = value;
  }
  if (normalized.length === 0) {
    throw new TenantGovernanceInvariantError("Contact value is empty after normalization");
  }
  return normalized;
}

export function assertMemberManagementAllowed(
  actorRole: TenantRole,
  currentRole: TenantRole | null,
  nextRole: TenantRole,
): void {
  if (actorRole !== "owner" && (currentRole === "owner" || nextRole === "owner")) {
    throw new TenantGovernanceInvariantError("Only an owner may create or modify an owner");
  }
}

export function assertPolicyTransitionAllowed(
  currentStatus: "draft" | "active" | "retired",
  targetStatus: "active" | "retired",
): boolean {
  if (currentStatus === targetStatus) return false;
  if (
    (currentStatus === "draft" && targetStatus === "active") ||
    (currentStatus === "active" && targetStatus === "retired")
  ) {
    return true;
  }
  throw new TenantGovernanceInvariantError(
    `Policy cannot transition from ${currentStatus} to ${targetStatus}`,
  );
}

export function validateEffectiveChannelAccount(input: {
  readonly platform: Platform;
  readonly capability: ConnectorCapability;
  readonly supportedExecutionLevels: readonly ExecutionLevel[];
}): void {
  const parsed = channelAccountCreateRequestSchema.safeParse({
    platform: input.platform,
    displayName: "validation-only",
    capability: input.capability,
    supportedExecutionLevels: input.supportedExecutionLevels,
    evidenceType: "manual_import",
    evidenceRefs: [],
    status: "active",
  });
  if (!parsed.success) {
    throw new TenantGovernanceInvariantError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
}
