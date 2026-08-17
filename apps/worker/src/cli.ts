import { hostname } from "node:os";

import { createDefaultConnectorRegistry } from "@geo/connectors";
import { createDatabase } from "@geo/db";

import { parseWorkerTenantActors } from "./actor-map.js";
import { parseCtripAssistedAccounts } from "./ctrip-assisted-config.js";
import { PostgresDispatcherStore, PostgresTenantJobStore } from "./postgres-stores.js";
import { OutboxWorker } from "./worker.js";

function requiredEnvironment(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const sharedDatabaseUrl = process.env.DATABASE_URL;
const dispatcherDatabase = createDatabase({
  connectionString: requiredEnvironment("DISPATCHER_DATABASE_URL", sharedDatabaseUrl),
  applicationName: "geo-outbox-dispatcher",
  maxConnections: integerEnvironment("DISPATCHER_DB_POOL_SIZE", 2),
});
const runtimeDatabase = createDatabase({
  connectionString: requiredEnvironment("RUNTIME_DATABASE_URL", sharedDatabaseUrl),
  applicationName: "geo-publication-worker",
  maxConnections: integerEnvironment("RUNTIME_DB_POOL_SIZE", 5),
});

const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const worker = new OutboxWorker({
  dispatcher: new PostgresDispatcherStore(dispatcherDatabase),
  jobs: new PostgresTenantJobStore(runtimeDatabase),
  connectors: createDefaultConnectorRegistry(),
  workerId,
  actorIdsByTenant: parseWorkerTenantActors(requiredEnvironment("WORKER_TENANT_ACTORS_JSON")),
  ctripAssistedAccounts: parseCtripAssistedAccounts(process.env.CTRIP_ASSISTED_ACCOUNTS_JSON),
  batchSize: integerEnvironment("WORKER_BATCH_SIZE", 25),
  concurrency: integerEnvironment("WORKER_CONCURRENCY", 4),
  leaseSeconds: integerEnvironment("WORKER_LEASE_SECONDS", 60),
  maxAttempts: integerEnvironment("WORKER_MAX_ATTEMPTS", 5),
});
const pollIntervalMs = integerEnvironment("WORKER_POLL_INTERVAL_MS", 1_000);
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  while (!stopping) {
    try {
      const summary = await worker.runOnce();
      if (summary.claimed > 0) {
        console.info(JSON.stringify({ level: "info", event: "worker.tick", workerId, ...summary }));
      }
      if (summary.claimed === 0) await delay(pollIntervalMs);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "worker.tick_failed",
          workerId,
          message: error instanceof Error ? error.message : "Unknown worker error",
        }),
      );
      await delay(pollIntervalMs);
    }
  }
} finally {
  await Promise.all([dispatcherDatabase.destroy(), runtimeDatabase.destroy()]);
}
