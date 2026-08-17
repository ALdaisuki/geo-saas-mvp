import type { AuditArtifact, ExecutionLevel } from "@geo/contracts";

import type { PlasticPromiseGovernanceClient } from "./governance.js";
import { redactSensitiveDetails } from "./redaction.js";

interface PublicationGovernanceInputBase {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly executionLevel: ExecutionLevel;
  readonly platform?: string;
  readonly requestFingerprint: string;
}

export type PublicationGovernancePhase = PublicationGovernanceInput["phase"];

export interface PublicationGovernanceEvidenceSummary {
  readonly auditPreCheck: {
    readonly passed: boolean;
  };
  readonly defense: {
    readonly decision: string | null;
    readonly trustScore: number | null;
    readonly toolName: string | null;
    readonly riskLevel: string | null;
    readonly requiredTrust: number | null;
    readonly manifestName: string | null;
    readonly sideEffects: readonly string[];
  };
  readonly defenseSemanticsValid: boolean;
}

export interface PublicationPlatformContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly variantId?: string;
  readonly channelAccountId?: string;
  readonly platform?: string;
  readonly executionLevel: ExecutionLevel;
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

export interface PublicationPreAuthorizationInput extends PublicationGovernanceInputBase {
  readonly phase: "pre_authorization";
}

export interface PublicationGrantConsumptionInput extends PublicationGovernanceInputBase {
  readonly phase: "grant_consumption";
  readonly publicationContext: PublicationGovernanceContext;
}

export type PublicationGovernanceInput =
  PublicationPreAuthorizationInput | PublicationGrantConsumptionInput;

export interface PublicationGovernanceDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): readonly string[] {
  return Object.freeze(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
}

function summarizePublicationEvidence(
  evidence: Readonly<Record<string, unknown>>,
): PublicationGovernanceEvidenceSummary {
  const precheck = isRecord(evidence.precheck) ? evidence.precheck : {};
  const defense = isRecord(evidence.defense) ? evidence.defense : {};
  const manifest = isRecord(defense.manifest) ? defense.manifest : {};

  return Object.freeze({
    auditPreCheck: Object.freeze({ passed: precheck.passed === true }),
    defense: Object.freeze({
      decision: stringValue(defense.decision),
      trustScore: finiteNumber(defense.trust_score),
      toolName: stringValue(defense.tool_name),
      riskLevel: stringValue(defense.risk_level),
      requiredTrust: finiteNumber(defense.required_trust),
      manifestName: stringValue(manifest.name),
      sideEffects: stringList(manifest.side_effects),
    }),
    defenseSemanticsValid: hasPublicationDefenseSemantics(defense),
  });
}

export class PublicationGovernanceDeniedError extends Error {
  readonly code = "PUBLICATION_POLICY_DENIED";
  readonly status = 403;
  readonly retryable = false;
  readonly reason: string;
  readonly phase: PublicationGovernancePhase;
  readonly evidenceSummary: PublicationGovernanceEvidenceSummary;
  readonly platformContext: Readonly<PublicationPlatformContext>;

  constructor(options: {
    readonly decision: PublicationGovernanceDecision;
    readonly phase: PublicationGovernancePhase;
    readonly platformContext: PublicationPlatformContext;
  }) {
    super(`Publication governance denied: ${options.decision.reason}`);
    this.name = "PublicationGovernanceDeniedError";
    this.reason = options.decision.reason;
    this.phase = options.phase;
    this.evidenceSummary = summarizePublicationEvidence(options.decision.evidence);
    this.platformContext = Object.freeze({ ...options.platformContext });
  }
}

const PUBLICATION_TOOL_NAME = "geo_publication_request";
const MINIMUM_PUBLICATION_TRUST = 0;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPublicationDefenseSemantics(defense: Readonly<Record<string, unknown>>): boolean {
  const manifest = defense.manifest;
  if (!isRecord(manifest)) return false;

  return (
    defense.tool_name === PUBLICATION_TOOL_NAME &&
    (defense.risk_level === "high" || defense.risk_level === "critical") &&
    typeof defense.required_trust === "number" &&
    Number.isFinite(defense.required_trust) &&
    defense.required_trust > MINIMUM_PUBLICATION_TRUST &&
    manifest.name === PUBLICATION_TOOL_NAME &&
    Array.isArray(manifest.side_effects) &&
    manifest.side_effects.includes("external_publish")
  );
}

function hasPositivePublicationTrust(defense: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof defense.trust_score === "number" &&
    Number.isFinite(defense.trust_score) &&
    defense.trust_score > 0
  );
}

function decisionRecord(value: unknown, toolName: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`Plastic Promise ${toolName} returned an invalid result`);
  }
  const envelope = value;
  if (
    typeof envelope.structuredContent === "object" &&
    envelope.structuredContent !== null &&
    !Array.isArray(envelope.structuredContent)
  ) {
    return envelope.structuredContent as Readonly<Record<string, unknown>>;
  }
  if (!Array.isArray(envelope.content)) {
    throw new Error(`Plastic Promise ${toolName} returned no decision content`);
  }
  for (const entry of envelope.content) {
    if (typeof entry !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(entry);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      // A non-JSON text block is not authoritative decision evidence.
    }
  }
  throw new Error(`Plastic Promise ${toolName} returned no structured decision`);
}

export class PlasticPromisePublicationGate {
  readonly #governance: PlasticPromiseGovernanceClient;

  constructor(governance: PlasticPromiseGovernanceClient) {
    this.#governance = governance;
  }

  async evaluate(input: PublicationGovernanceInput): Promise<PublicationGovernanceDecision> {
    const publicationContext =
      input.phase === "grant_consumption"
        ? {
            grant: {
              id: input.publicationContext.grant.id,
              status: input.publicationContext.grant.status,
              issuedAt: input.publicationContext.grant.issuedAt,
              expiresAt: input.publicationContext.grant.expiresAt,
            },
            auditArtifact: {
              id: input.publicationContext.artifact.id,
              tenantId: input.publicationContext.artifact.tenantId,
              variantId: input.publicationContext.artifact.variantId,
              channelAccountId: input.publicationContext.artifact.channelAccountId,
              platform: input.publicationContext.artifact.platform,
              payloadHash: input.publicationContext.artifact.payloadHash,
              factSnapshotHash: input.publicationContext.artifact.factSnapshotHash,
              policyHash: input.publicationContext.artifact.policyHash,
              policyVersion: input.publicationContext.artifact.policyVersion,
              auditHash: input.publicationContext.artifact.auditHash,
              status: input.publicationContext.artifact.status,
              findings: input.publicationContext.artifact.findings,
              createdAt: input.publicationContext.artifact.createdAt,
              expiresAt: input.publicationContext.artifact.expiresAt,
            },
          }
        : {
            availability: "deferred_to_api_grant_consumption",
          };
    const actionDescription = JSON.stringify(
      redactSensitiveDetails({
        schema: "geo.publication-governance.v1",
        phase: input.phase,
        action: PUBLICATION_TOOL_NAME,
        tenantId: input.tenantId,
        actorId: input.actorId,
        resourceId: input.resourceId,
        executionLevel: input.executionLevel,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        requestFingerprint: input.requestFingerprint,
        publicationContext,
      }),
    );
    const precheck = decisionRecord(
      await this.#governance.auditPreCheck({
        action_type: "write",
        action_description: actionDescription,
      }),
      "audit_pre_check",
    );
    const defense = decisionRecord(
      await this.#governance.defense({
        action: "evaluate_tool",
        tool_name: PUBLICATION_TOOL_NAME,
      }),
      "defense",
    );
    const precheckPassed = precheck.passed === true;
    // Plastic Promise currently returns `ask` when its evolving trust score is below the
    // manifest requirement. GEO temporarily treats that response as authorized only when
    // the reported score is positive and every publication-specific manifest check passes.
    // An explicit `deny` remains terminal.
    const defenseAllowed =
      defense.decision === "allow" ||
      (defense.decision === "ask" && hasPositivePublicationTrust(defense));
    const defenseSemanticsValid = hasPublicationDefenseSemantics(defense);
    return {
      allowed: precheckPassed && defenseAllowed && defenseSemanticsValid,
      reason: !precheckPassed
        ? "audit_pre_check_denied"
        : !defenseAllowed
          ? "defense_denied"
          : !defenseSemanticsValid
            ? "defense_semantics_invalid"
            : "allowed",
      evidence: { precheck, defense },
    };
  }
}
