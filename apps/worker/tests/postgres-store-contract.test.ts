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
    const actorGateIndex = storeSource.indexOf("from geo.tenant_memberships as membership");
    const loadIndex = storeSource.indexOf("from geo.publication_jobs as job");
    expect(roleIndex).toBeGreaterThan(0);
    expect(contextIndex).toBeGreaterThan(roleIndex);
    expect(actorGateIndex).toBe(-1);
    const principalGateIndex = storeSource.indexOf("from geo.service_principals as principal");
    expect(principalGateIndex).toBeGreaterThan(contextIndex);
    expect(storeSource).toContain("join geo.tenants as tenant");
    expect(storeSource).toContain("principal.kind = 'worker'");
    expect(storeSource).toContain("principal.status = 'active'");
    expect(storeSource).toContain("tenant.status = 'active'");
    expect(storeSource).toContain('"WORKER_ACTOR_NOT_AUTHORIZED"');
    expect(storeSource).toContain("Worker service principal or tenant is not active");
    expect(loadIndex).toBeGreaterThan(contextIndex);
  });

  it("acquires atomically before connector work and finishes each execution outcome", () => {
    const acquireIndex = workerSource.indexOf("this.#jobs.acquirePublicationExecution");
    const renderIndex = workerSource.indexOf("connector.renderDraft");
    expect(acquireIndex).toBeGreaterThan(0);
    expect(renderIndex).toBeGreaterThan(acquireIndex);
    expect(storeSource).toContain("geo.acquire_publication_execution");
    expect(storeSource).toContain("geo.finish_publication_execution");
    expect(storeSource).toContain(
      'outcome === "uncertain" ? "PUBLICATION_UNCERTAIN" : (input.code ?? null)',
    );

    const completion = storeSource.slice(
      storeSource.indexOf("async complete("),
      storeSource.indexOf("async recordFailure("),
    );
    expect(completion).toContain("this.#lockJob");
    expect(storeSource).toContain("for update");
    const completionFinishIndex = completion.indexOf(
      'this.#finishPublicationExecution(transaction, input, "succeeded")',
    );
    expect(completionFinishIndex).toBeGreaterThan(0);
    expect(completionFinishIndex).toBeLessThan(completion.indexOf("this.#lockJob"));
    expect(completion).toContain('attempt.state !== "succeeded"');
    expect(completion).toContain("Cannot complete publication attempt from state");
    expect(completion).not.toContain("insert into geo.publication_attempts");
    expect(completion).toContain("insert into geo.publication_receipts");
    const receiptIndex = completion.indexOf("insert into geo.publication_receipts");
    const readbackIndex = completion.indexOf("geo.schedule_publication_readback");
    const jobUpdateIndex = completion.indexOf("update geo.publication_jobs");
    expect(jobUpdateIndex).toBeGreaterThan(receiptIndex);
    expect(readbackIndex).toBeGreaterThan(jobUpdateIndex);
    expect(completion).toContain("update geo.publication_jobs");
    expect(completion).toContain(
      'readback: { status: "not_required", required: false, reason: "dry_run_preview_only" }',
    );

    const failure = storeSource.slice(
      storeSource.indexOf("async recordFailure("),
      storeSource.indexOf("async recordReconciliationFailure("),
    );
    const failureFinishIndex = failure.indexOf(
      'this.#finishPublicationExecution(transaction, input, "failed")',
    );
    expect(failureFinishIndex).toBeGreaterThan(0);
    expect(failureFinishIndex).toBeLessThan(failure.indexOf("this.#lockJob"));
    expect(failure).toContain('job.state === "cancelled"');
    expect(failure).toContain('job.state === "permanent_failure"');
    expect(failure).toContain("and error_code = ${input.code}");

    const uncertain = storeSource.slice(
      storeSource.indexOf("async recordUncertain("),
      storeSource.indexOf("async resolveUncertain("),
    );
    const uncertainFinishIndex = uncertain.indexOf(
      'this.#finishPublicationExecution(transaction, input, "uncertain")',
    );
    expect(uncertainFinishIndex).toBeGreaterThan(0);
    expect(uncertainFinishIndex).toBeLessThan(uncertain.indexOf("this.#lockJob"));
  });

  it("appends tenant-scoped audit evidence for every worker state transition", () => {
    expect(storeSource).toContain("insert into geo.audit_log");
    expect(storeSource).toContain("input.context.actorId");
    expect(storeSource).toContain("input.context.requestId");

    const completion = storeSource.slice(
      storeSource.indexOf("async complete("),
      storeSource.indexOf("async recordFailure("),
    );
    expect(completion).toContain('action: "publication_job.preview_completed"');
    expect(completion).toContain("attemptId: input.attemptId");
    expect(completion).toContain("receiptId: input.receipt.id");
    expect(completion).toContain('readbackStatus: "not_required"');

    const failure = storeSource.slice(
      storeSource.indexOf("async recordFailure("),
      storeSource.indexOf("async recordUncertain("),
    );
    expect(failure).toContain('action: "publication_job.attempt_failed"');
    expect(failure).toContain("errorCode: input.code");
    expect(failure).not.toContain("message: input.message");

    const uncertain = storeSource.slice(
      storeSource.indexOf("async recordUncertain("),
      storeSource.indexOf("async resolveUncertain("),
    );
    expect(uncertain).toContain('action: "publication_job.uncertain_recorded"');
    expect(uncertain).toContain("responseHash: input.receipt.responseHash");
    expect(uncertain).toContain('"readback":{"status":"not_required","required":false');
    expect(uncertain).toContain('"reconciliation":{"required":true');
    expect(uncertain).not.toContain('"readback":{"required":true');

    const reconciliation = storeSource.slice(
      storeSource.indexOf("async resolveUncertain("),
      storeSource.indexOf("async #lockJob("),
    );
    expect(reconciliation).toContain('action: "publication_job.reconciled"');
    expect(reconciliation).toContain("attemptId: attempt?.id ?? null");
    expect(reconciliation).toContain("outcome: input.result.outcome");
    expect(storeSource).toContain('action: "publication_job.reconciliation_failed"');
    expect(storeSource).not.toContain("credential_ref");
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

  it("lets an expired open circuit reach the atomic half-open acquisition gate", () => {
    expect(storeSource).toContain(
      "and (circuit.retry_at is null or circuit.retry_at > clock_timestamp())",
    );
    expect(storeSource).toContain("from geo.acquire_publication_execution");
  });
});
