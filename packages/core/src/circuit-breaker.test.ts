import { describe, expect, it } from "vitest";

import {
  evaluateCircuitBreaker,
  type CircuitBreakerPolicy,
  type CircuitSignals,
} from "./circuit-breaker.js";

const now = "2026-07-13T12:00:00.000Z";

const policy: CircuitBreakerPolicy = {
  cooldownMs: 10 * 60 * 1_000,
  minAttemptsForUncertainRate: 4,
  uncertainRateThreshold: 0.25,
  maxConsecutiveFailures: 3,
  maxBlockingAuditFailures: 2,
  maxContactAccuracyFailures: 1,
  maxHarmfulVisibilityErrors: 1,
};

const healthy: CircuitSignals = {
  publicationAttempts: 10,
  uncertainOutcomes: 0,
  consecutiveFailures: 0,
  blockingAuditFailures: 0,
  contactAccuracyFailures: 0,
  harmfulVisibilityErrors: 0,
};

describe("circuit breaker decisions", () => {
  it("allows healthy traffic while closed", () => {
    expect(
      evaluateCircuitBreaker({
        current: { state: "closed", openedAt: null, probeInFlight: false },
        signals: healthy,
        policy,
        now,
        probeOutcome: "none",
      }),
    ).toEqual({
      state: "closed",
      decision: "allow",
      reasons: [],
      openedAt: null,
      openUntil: null,
    });
  });

  it.each([
    ["bad contact", { contactAccuracyFailures: 1 }, "contact_accuracy_failures"],
    ["harmful visibility", { harmfulVisibilityErrors: 1 }, "harmful_visibility_errors"],
    ["audit failures", { blockingAuditFailures: 2 }, "blocking_audit_failures"],
    ["uncertain rate", { publicationAttempts: 4, uncertainOutcomes: 1 }, "uncertain_outcome_rate"],
  ] as const)("opens on %s", (_label, signalPatch, reason) => {
    const decision = evaluateCircuitBreaker({
      current: { state: "closed", openedAt: null, probeInFlight: false },
      signals: { ...healthy, ...signalPatch },
      policy,
      now,
      probeOutcome: "none",
    });

    expect(decision).toMatchObject({ state: "open", decision: "block" });
    expect(decision.reasons).toContain(reason);
    expect(decision.openUntil).toBe("2026-07-13T12:10:00.000Z");
  });

  it("allows only a probe after cooldown and closes only after probe success", () => {
    const afterCooldown = evaluateCircuitBreaker({
      current: {
        state: "open",
        openedAt: "2026-07-13T11:49:00.000Z",
        probeInFlight: false,
      },
      signals: healthy,
      policy,
      now,
      probeOutcome: "none",
    });
    expect(afterCooldown).toMatchObject({ state: "half_open", decision: "probe" });

    const closed = evaluateCircuitBreaker({
      current: { state: "half_open", openedAt: "2026-07-13T11:49:00.000Z", probeInFlight: true },
      signals: healthy,
      policy,
      now,
      probeOutcome: "success",
    });
    expect(closed).toMatchObject({ state: "closed", decision: "allow", openedAt: null });
  });

  it.each(["failure", "uncertain"] as const)("reopens after a %s probe", (probeOutcome) => {
    const decision = evaluateCircuitBreaker({
      current: { state: "half_open", openedAt: "2026-07-13T11:49:00.000Z", probeInFlight: true },
      signals: healthy,
      policy,
      now,
      probeOutcome,
    });

    expect(decision).toMatchObject({ state: "open", decision: "block", openedAt: now });
    expect(decision.reasons).toContain(`probe_${probeOutcome}`);
  });
});
