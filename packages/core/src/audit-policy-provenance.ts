import type { AuditPolicy } from "./audit.js";
import { invariant } from "./errors.js";

const compiledPolicySources = new WeakMap<
  object,
  Readonly<{ sourceHash: string; effectiveHash: string | undefined }>
>();

export function registerCompiledAuditPolicy(
  policy: Readonly<AuditPolicy>,
  sourceHash: string,
): void {
  invariant(Object.isFrozen(policy), "AUDIT_POLICY_NOT_FROZEN", "Compiled policy must be frozen");
  compiledPolicySources.set(policy, { sourceHash, effectiveHash: policy.effectiveHash });
}

export function assertCompiledAuditPolicySource(policy: AuditPolicy): void {
  invariant(
    compiledPolicySources.get(policy)?.sourceHash === policy.sourceHash &&
      compiledPolicySources.get(policy)?.effectiveHash === policy.effectiveHash,
    "AUDIT_POLICY_SOURCE_UNTRUSTED",
    "Policy sourceHash is only valid on the exact compiler-produced policy object",
  );
}
