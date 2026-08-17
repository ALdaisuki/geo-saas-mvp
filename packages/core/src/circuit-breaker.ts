import type { CircuitState } from "@geo/contracts";

import { invariant } from "./errors.js";
import { assertNonNegativeInteger, freezeDeep, parseInstant } from "./validation.js";

export interface CircuitBreakerPolicy {
  readonly cooldownMs: number;
  readonly minAttemptsForUncertainRate: number;
  readonly uncertainRateThreshold: number;
  readonly maxConsecutiveFailures: number;
  readonly maxBlockingAuditFailures: number;
  readonly maxContactAccuracyFailures: number;
  readonly maxHarmfulVisibilityErrors: number;
}

export interface CircuitSignals {
  readonly publicationAttempts: number;
  readonly uncertainOutcomes: number;
  readonly consecutiveFailures: number;
  readonly blockingAuditFailures: number;
  readonly contactAccuracyFailures: number;
  readonly harmfulVisibilityErrors: number;
}

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly openedAt: string | null;
  readonly probeInFlight: boolean;
}

export type ProbeOutcome = "none" | "success" | "failure" | "uncertain";
export type CircuitDecisionAction = "allow" | "block" | "probe";

export interface CircuitBreakerDecision {
  readonly state: CircuitState;
  readonly decision: CircuitDecisionAction;
  readonly reasons: readonly string[];
  readonly openedAt: string | null;
  readonly openUntil: string | null;
}

export interface EvaluateCircuitBreakerInput {
  readonly current: CircuitSnapshot;
  readonly signals: CircuitSignals;
  readonly policy: CircuitBreakerPolicy;
  readonly now: string;
  readonly probeOutcome: ProbeOutcome;
}

function validatePolicy(policy: CircuitBreakerPolicy): void {
  const integerThresholds: ReadonlyArray<readonly [string, number]> = [
    ["cooldownMs", policy.cooldownMs],
    ["minAttemptsForUncertainRate", policy.minAttemptsForUncertainRate],
    ["maxConsecutiveFailures", policy.maxConsecutiveFailures],
    ["maxBlockingAuditFailures", policy.maxBlockingAuditFailures],
    ["maxContactAccuracyFailures", policy.maxContactAccuracyFailures],
    ["maxHarmfulVisibilityErrors", policy.maxHarmfulVisibilityErrors],
  ];
  for (const [field, value] of integerThresholds) {
    invariant(
      Number.isSafeInteger(value) && value > 0,
      "CIRCUIT_POLICY_INVALID",
      `${field} must be a positive safe integer`,
      { field, value },
    );
  }
  invariant(
    policy.uncertainRateThreshold > 0 && policy.uncertainRateThreshold <= 1,
    "CIRCUIT_POLICY_INVALID",
    "uncertainRateThreshold must be in (0, 1]",
  );
}

function validateSignals(signals: CircuitSignals): void {
  for (const [field, value] of Object.entries(signals)) {
    assertNonNegativeInteger(value, `signals.${field}`);
  }
  invariant(
    signals.uncertainOutcomes <= signals.publicationAttempts,
    "CIRCUIT_SIGNALS_INVALID",
    "uncertainOutcomes cannot exceed publicationAttempts",
  );
}

function triggerReasons(signals: CircuitSignals, policy: CircuitBreakerPolicy): string[] {
  const reasons: string[] = [];
  if (signals.consecutiveFailures >= policy.maxConsecutiveFailures) {
    reasons.push("consecutive_publication_failures");
  }
  if (signals.blockingAuditFailures >= policy.maxBlockingAuditFailures) {
    reasons.push("blocking_audit_failures");
  }
  if (signals.contactAccuracyFailures >= policy.maxContactAccuracyFailures) {
    reasons.push("contact_accuracy_failures");
  }
  if (signals.harmfulVisibilityErrors >= policy.maxHarmfulVisibilityErrors) {
    reasons.push("harmful_visibility_errors");
  }
  if (
    signals.publicationAttempts >= policy.minAttemptsForUncertainRate &&
    signals.uncertainOutcomes / signals.publicationAttempts >= policy.uncertainRateThreshold
  ) {
    reasons.push("uncertain_outcome_rate");
  }
  return reasons;
}

function openedDecision(
  now: string,
  nowMs: number,
  policy: CircuitBreakerPolicy,
  reasons: readonly string[],
): Readonly<CircuitBreakerDecision> {
  return freezeDeep({
    state: "open",
    decision: "block",
    reasons: [...reasons],
    openedAt: now,
    openUntil: new Date(nowMs + policy.cooldownMs).toISOString(),
  });
}

export function evaluateCircuitBreaker(
  input: EvaluateCircuitBreakerInput,
): Readonly<CircuitBreakerDecision> {
  validatePolicy(input.policy);
  validateSignals(input.signals);
  const nowMs = parseInstant(input.now, "now");
  const reasons = triggerReasons(input.signals, input.policy);

  if (input.current.state === "closed") {
    invariant(
      input.current.openedAt === null,
      "CIRCUIT_SNAPSHOT_INVALID",
      "A closed circuit cannot have openedAt",
    );
    invariant(
      input.probeOutcome === "none",
      "CIRCUIT_PROBE_INVALID",
      "Closed circuits cannot receive probe outcomes",
    );
    if (reasons.length > 0) {
      return openedDecision(input.now, nowMs, input.policy, reasons);
    }
    return freezeDeep({
      state: "closed",
      decision: "allow",
      reasons: [],
      openedAt: null,
      openUntil: null,
    });
  }

  invariant(
    input.current.openedAt !== null,
    "CIRCUIT_SNAPSHOT_INVALID",
    `${input.current.state} circuit requires openedAt`,
  );
  const openedAtMs = parseInstant(input.current.openedAt, "current.openedAt");

  if (input.current.state === "open") {
    invariant(
      input.probeOutcome === "none",
      "CIRCUIT_PROBE_INVALID",
      "Open circuits cannot receive probe outcomes",
    );
    const openUntil = openedAtMs + input.policy.cooldownMs;
    if (nowMs < openUntil) {
      return freezeDeep({
        state: "open",
        decision: "block",
        reasons: ["cooldown_active"],
        openedAt: input.current.openedAt,
        openUntil: new Date(openUntil).toISOString(),
      });
    }
    return freezeDeep({
      state: "half_open",
      decision: "probe",
      reasons: ["cooldown_elapsed"],
      openedAt: input.current.openedAt,
      openUntil: null,
    });
  }

  if (input.probeOutcome === "success") {
    if (reasons.length > 0) {
      return openedDecision(input.now, nowMs, input.policy, [
        ...reasons,
        "probe_success_but_signals_unsafe",
      ]);
    }
    return freezeDeep({
      state: "closed",
      decision: "allow",
      reasons: ["probe_success"],
      openedAt: null,
      openUntil: null,
    });
  }
  if (input.probeOutcome === "failure" || input.probeOutcome === "uncertain") {
    return openedDecision(input.now, nowMs, input.policy, [`probe_${input.probeOutcome}`]);
  }
  if (input.current.probeInFlight) {
    return freezeDeep({
      state: "half_open",
      decision: "block",
      reasons: ["probe_in_flight"],
      openedAt: input.current.openedAt,
      openUntil: null,
    });
  }
  return freezeDeep({
    state: "half_open",
    decision: "probe",
    reasons: ["probe_required"],
    openedAt: input.current.openedAt,
    openUntil: null,
  });
}
