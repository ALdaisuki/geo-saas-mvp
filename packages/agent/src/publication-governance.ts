import type { ExecutionLevel } from "@geo/contracts";

import type { PlasticPromiseGovernanceClient } from "./governance.js";

export interface PublicationGovernanceInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly executionLevel: ExecutionLevel;
  readonly requestFingerprint: string;
}

export interface PublicationGovernanceDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

function decisionRecord(value: unknown, toolName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Plastic Promise ${toolName} returned an invalid result`);
  }
  const envelope = value as Readonly<Record<string, unknown>>;
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
    const actionDescription = JSON.stringify({
      action: "geo_publication_request",
      tenantId: input.tenantId,
      actorId: input.actorId,
      resourceId: input.resourceId,
      executionLevel: input.executionLevel,
      requestFingerprint: input.requestFingerprint,
    });
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
        tool_name: "geo_publication_request",
      }),
      "defense",
    );
    const precheckPassed = precheck.passed === true;
    const defenseAllowed = defense.decision === "allow";
    return {
      allowed: precheckPassed && defenseAllowed,
      reason: !precheckPassed
        ? "audit_pre_check_denied"
        : !defenseAllowed
          ? "defense_denied"
          : "allowed",
      evidence: { precheck, defense },
    };
  }
}
