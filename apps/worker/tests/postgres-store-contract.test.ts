import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const storeSource = await readFile(new URL("../src/postgres-stores.ts", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

describe("PostgreSQL worker store contract", () => {
  it("uses only the real dispatcher functions under the dispatcher role", () => {
    expect(storeSource).toContain("set local role geo_dispatcher");
    expect(storeSource).toContain("geo.claim_outbox_events");
    expect(storeSource).toContain("geo.ack_outbox_event");
    expect(storeSource).toContain("geo.retry_outbox_event");
    expect(storeSource).not.toContain("insert into geo.outbox_events");
  });

  it("establishes the ordinary runtime role and tenant context before tenant data access", () => {
    const roleIndex = storeSource.indexOf("set local role geo_runtime");
    const contextIndex = storeSource.indexOf("setTenantContext(transaction, context)");
    const loadIndex = storeSource.indexOf("from geo.publication_jobs as job");
    expect(roleIndex).toBeGreaterThan(0);
    expect(contextIndex).toBeGreaterThan(roleIndex);
    expect(loadIndex).toBeGreaterThan(contextIndex);
  });

  it("commits attempt, immutable receipt, and completed job in one tenant transaction", () => {
    const completion = storeSource.slice(
      storeSource.indexOf("async complete("),
      storeSource.indexOf("async recordFailure("),
    );
    expect(completion).toContain("this.#lockJob");
    expect(storeSource).toContain("for update");
    expect(completion).toContain("insert into geo.publication_attempts");
    expect(completion).toContain("insert into geo.publication_receipts");
    expect(completion).toContain("update geo.publication_jobs");
    expect(completion).toContain('readback: { required: false, reason: "dry_run_preview_only" }');
  });

  it("persists uncertain evidence and reconciles before any event retry", () => {
    const uncertainIndex = workerSource.indexOf("recordUncertain");
    const reconcileIndex = workerSource.indexOf("connector.reconcile", uncertainIndex);
    const retryIndex = workerSource.indexOf("this.#dispatcher.retry", reconcileIndex);
    expect(uncertainIndex).toBeGreaterThan(0);
    expect(reconcileIndex).toBeGreaterThan(uncertainIndex);
    expect(retryIndex).toBeGreaterThan(reconcileIndex);
    expect(storeSource).toContain("state = 'reconciled'");
    expect(storeSource).toContain("RECONCILED_NOT_PUBLISHED");
  });

  it("keeps dry-run evidence collection available while an external-publication circuit is open", () => {
    expect(storeSource).toContain('row.circuit_open && row.execution_level !== "dry_run"');
  });
});
