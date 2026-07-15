import type { AuditPolicy } from "./audit.js";
import { invariant } from "./errors.js";

const compiledPolicySources = new WeakMap<object, string>();

export function registerCompiledAuditPolicy(
  policy: Readonly<AuditPolicy>,
  sourceHash: string,
): void {
  invariant(Object.isFrozen(policy), "AUDIT_POLICY_NOT_FROZEN", "Compiled policy must be frozen");
  compiledPolicySources.set(policy, sourceHash);
}

export function assertCompiledAuditPolicySource(policy: AuditPolicy): void {
  invariant(
    compiledPolicySources.get(policy) === policy.sourceHash,
    "AUDIT_POLICY_SOURCE_UNTRUSTED",
    "Policy sourceHash is only valid on the exact compiler-produced policy object",
  );
}
