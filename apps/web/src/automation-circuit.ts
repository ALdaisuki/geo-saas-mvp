import type { AutomationCircuit } from "./api.js";

const RECOVERABLE_ACCOUNT_CIRCUIT_REASONS = new Set([
  "ASSISTED_SESSION_REQUIRED",
  "ASSISTED_CHALLENGE_REQUIRED",
  "ASSISTED_ADAPTER_DRIFT",
]);

export function circuitBlocksAccount(
  circuit: AutomationCircuit | undefined,
  now = Date.now(),
): boolean {
  if (circuit === undefined || circuit.state === "closed") return false;
  if (circuit.state === "half_open") return true;
  if (!RECOVERABLE_ACCOUNT_CIRCUIT_REASONS.has(circuit.reason ?? "")) return true;
  if (circuit.retryAt === null) return true;
  const retryAt = Date.parse(circuit.retryAt);
  return Number.isNaN(retryAt) || retryAt > now;
}

export function circuitRecoveryProbeReady(
  circuit: AutomationCircuit | undefined,
  now = Date.now(),
): boolean {
  return circuit !== undefined && circuit.state === "open" && !circuitBlocksAccount(circuit, now);
}
