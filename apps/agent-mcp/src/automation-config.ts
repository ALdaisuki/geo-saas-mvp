import { AUTOMATION_PRODUCER_MAX_CONCURRENCY } from "./automation-producer.js";

export interface AutomationProducerConfig {
  readonly enabled: boolean;
  readonly producerId: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly deliveryPollIntervalMs: number;
}

function booleanEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}

function integerEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readAutomationProducerConfig(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): AutomationProducerConfig {
  const enabled = booleanEnvironment(environment, "AUTOMATION_PRODUCER_ENABLED", false);
  const producerId =
    environment.AUTOMATION_PRODUCER_ID?.trim() || `agent-mcp-${String(process.pid)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(producerId)) {
    throw new TypeError("AUTOMATION_PRODUCER_ID is invalid");
  }
  const concurrency = integerEnvironment(
    environment,
    "AUTOMATION_PRODUCER_CONCURRENCY",
    1,
    1,
    AUTOMATION_PRODUCER_MAX_CONCURRENCY,
  );
  const pollIntervalMs = integerEnvironment(
    environment,
    "AUTOMATION_PRODUCER_POLL_INTERVAL_MS",
    1_000,
    100,
    60_000,
  );
  const leaseDurationMs = integerEnvironment(
    environment,
    "AUTOMATION_PRODUCER_LEASE_DURATION_MS",
    60_000,
    10_000,
    3_600_000,
  );
  const heartbeatIntervalMs = integerEnvironment(
    environment,
    "AUTOMATION_PRODUCER_HEARTBEAT_INTERVAL_MS",
    20_000,
    1_000,
    3_599_999,
  );
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new TypeError(
      "AUTOMATION_PRODUCER_HEARTBEAT_INTERVAL_MS must be shorter than the lease duration",
    );
  }
  const deliveryPollIntervalMs = integerEnvironment(
    environment,
    "AUTOMATION_DELIVERY_POLL_INTERVAL_MS",
    1_000,
    10,
    60_000,
  );
  return {
    enabled,
    producerId,
    concurrency,
    pollIntervalMs,
    leaseDurationMs,
    heartbeatIntervalMs,
    deliveryPollIntervalMs,
  };
}
