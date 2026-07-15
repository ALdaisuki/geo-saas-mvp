import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";

import type {
  AutomationBatchCancellationResult,
  AutomationBatchListInput,
  AutomationBatchView,
  AutomationLeaseMutationResult,
  AutomationRepository,
  AutomationRunLease,
  AutomationRunListInput,
  AutomationRunTargetView,
  AutomationRunView,
  CheckpointAutomationDraftInput,
  CheckpointAutomationTargetInput,
  ClaimAutomationRunsInput,
  HeartbeatAutomationRunInput,
  ReconcileAutomationRunInput,
} from "./automation-repository.js";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type RequestContext,
} from "./repository.js";

interface AutomationBatchRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly name: string | null;
  readonly state: AutomationBatchView["state"];
  readonly execution_level: "dry_run";
  readonly scheduled_for: Date;
  readonly run_count: number;
  readonly completed_run_count: number;
  readonly failed_run_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AutomationRunRow {
  readonly id: string;
  readonly batch_id: string;
  readonly campaign_id: string;
  readonly brand_id: string;
  readonly slot_key: string;
  readonly topic_key: string;
  readonly brief: unknown;
  readonly state: AutomationRunView["state"];
  readonly stage: AutomationRunView["stage"];
  readonly available_at: Date;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly checkpoint: unknown;
  readonly content_item_id: string | null;
  readonly content_version_id: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AutomationTargetRow {
  readonly id: string;
  readonly run_id: string;
  readonly channel_account_id: string;
  readonly platform: AutomationRunTargetView["platform"];
  readonly state: AutomationRunTargetView["state"];
  readonly variant_id: string | null;
  readonly audit_run_id: string | null;
  readonly audit_artifact_id: string | null;
  readonly publication_job_id: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function throwAutomationRepositoryError(error: unknown): never {
  const state = sqlState(error);
  if (state === "P0002") throw new RepositoryNotFoundError("Automation resource was not found");
  if (["22023", "23503", "23505", "23514", "42501", "55000"].includes(state ?? "")) {
    throw new RepositoryConflictError("Automation state transition was rejected");
  }
  throw error;
}

function batchView(row: AutomationBatchRow): AutomationBatchView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    state: row.state,
    executionLevel: row.execution_level,
    scheduledFor: toIso(row.scheduled_for),
    runCount: row.run_count,
    completedRunCount: row.completed_run_count,
    failedRunCount: row.failed_run_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function targetView(row: AutomationTargetRow): AutomationRunTargetView {
  return {
    id: row.id,
    runId: row.run_id,
    channelAccountId: row.channel_account_id,
    platform: row.platform,
    state: row.state,
    variantId: row.variant_id,
    auditRunId: row.audit_run_id,
    auditArtifactId: row.audit_artifact_id,
    publicationJobId: row.publication_job_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    completedAt: nullableIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function briefText(value: unknown): string {
  const brief = objectRecord(value).text;
  if (typeof brief !== "string" || brief.length === 0) {
    throw new RepositoryConflictError("Automation run has an invalid persisted brief");
  }
  return brief;
}

function runView(
  row: AutomationRunRow,
  targets: readonly AutomationRunTargetView[],
): AutomationRunView {
  return {
    id: row.id,
    batchId: row.batch_id,
    campaignId: row.campaign_id,
    brandId: row.brand_id,
    slotKey: row.slot_key,
    topicKey: row.topic_key,
    brief: briefText(row.brief),
    state: row.state,
    stage: row.stage,
    availableAt: toIso(row.available_at),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    heartbeatAt: nullableIso(row.heartbeat_at),
    checkpoint: objectRecord(row.checkpoint),
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    completedAt: nullableIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    targets,
  };
}

async function selectBatch(
  transaction: TenantTransaction,
  batchId: string,
): Promise<AutomationBatchView | null> {
  const result = await sql<AutomationBatchRow>`
    select batch.id, batch.campaign_id, batch.configuration ->> 'name' as name,
           batch.state, batch.execution_level, batch.scheduled_for,
           count(run.id)::integer as run_count,
           count(run.id) filter (where run.state in ('completed', 'partially_failed'))::integer
             as completed_run_count,
           count(run.id) filter (where run.state in ('blocked', 'failed', 'cancelled'))::integer
             as failed_run_count,
           batch.created_at, batch.updated_at
    from geo.automation_batches as batch
    left join geo.automation_runs as run
      on run.tenant_id = batch.tenant_id and run.batch_id = batch.id
    where batch.id = ${batchId}::uuid
    group by batch.id
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : batchView(row);
}

async function selectTargets(
  transaction: TenantTransaction,
  runIds: readonly string[],
): Promise<Map<string, AutomationRunTargetView[]>> {
  const byRun = new Map<string, AutomationRunTargetView[]>();
  if (runIds.length === 0) return byRun;
  const ids = sql.join(runIds.map((runId) => sql`${runId}::uuid`));
  const result = await sql<AutomationTargetRow>`
    select id, run_id, channel_account_id, platform, state, variant_id,
           audit_run_id, audit_artifact_id, publication_job_id,
           last_error_code, last_error_message, completed_at, created_at, updated_at
    from geo.automation_run_targets
    where run_id in (${ids})
    order by run_id, created_at, id
  `.execute(transaction);
  for (const row of result.rows) {
    const items = byRun.get(row.run_id) ?? [];
    items.push(targetView(row));
    byRun.set(row.run_id, items);
  }
  return byRun;
}

async function selectRuns(
  transaction: TenantTransaction,
  input: AutomationRunListInput & { readonly runIds?: readonly string[] },
): Promise<AutomationRunView[]> {
  if (input.runIds?.length === 0) return [];
  const runIds =
    input.runIds === undefined
      ? sql`true`
      : sql`run.id in (${sql.join(input.runIds.map((runId) => sql`${runId}::uuid`))})`;
  const result = await sql<AutomationRunRow>`
    select run.id, run.batch_id, run.campaign_id, campaign.brand_id,
           run.slot_key, run.topic_key, run.brief, run.state, run.stage,
           run.available_at, run.attempt_count, run.max_attempts,
           run.lease_owner, run.lease_expires_at, run.heartbeat_at,
           run.checkpoint, run.content_item_id, run.content_version_id,
           run.last_error_code, run.last_error_message, run.completed_at,
           run.created_at, run.updated_at
    from geo.automation_runs as run
    join geo.campaigns as campaign
      on campaign.tenant_id = run.tenant_id and campaign.id = run.campaign_id
    where ${runIds}
      and (${input.batchId ?? null}::uuid is null or run.batch_id = ${input.batchId ?? null}::uuid)
      and (${input.state ?? null}::text is null or run.state = ${input.state ?? null})
      and (${input.before ?? null}::timestamptz is null or run.created_at < ${input.before ?? null}::timestamptz)
    order by run.created_at desc, run.id
    limit ${input.limit}
  `.execute(transaction);
  const targets = await selectTargets(
    transaction,
    result.rows.map((row) => row.id),
  );
  return result.rows.map((row) => runView(row, targets.get(row.id) ?? []));
}

function leaseMutation(row: {
  readonly accepted: boolean;
  readonly reason: string;
  readonly lease_expires_at: Date | null;
}): AutomationLeaseMutationResult {
  return {
    accepted: row.accepted,
    reason: row.reason,
    leaseExpiresAt: nullableIso(row.lease_expires_at),
  };
}

export function createPostgresAutomationRepository(
  runtimeDatabase: Kysely<Database>,
): AutomationRepository {
  const tenant = <T>(
    context: RequestContext,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ) => withTenantTransaction(runtimeDatabase, context, operation);

  return {
    async createAutomationBatch(context, input) {
      return tenant(context, async (transaction) => {
        const lockKey = `${context.tenantId}:automation_batch:${input.idempotencyKey}`;
        await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(
          transaction,
        );
        const existing = await sql<{ id: string; request_hash: string }>`
          select id, request_hash from geo.automation_batches
          where idempotency_key = ${input.idempotencyKey}
        `.execute(transaction);
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) {
          if (existingRow.request_hash !== input.requestHash) {
            throw new RepositoryConflictError(
              "Automation batch idempotency key conflicts with another request",
            );
          }
          const batch = await selectBatch(transaction, existingRow.id);
          if (batch === null) {
            throw new RepositoryConflictError("Automation batch replay has no persisted batch");
          }
          return { batch, wasCreated: false };
        }

        const campaign = await sql<{ id: string; status: string }>`
          select id, status from geo.campaigns where id = ${input.campaignId}::uuid
        `.execute(transaction);
        const campaignRow = campaign.rows[0];
        if (campaignRow === undefined) throw new RepositoryNotFoundError("Campaign was not found");
        if (campaignRow.status !== "active") {
          throw new RepositoryConflictError("Campaign is not active");
        }

        const accountIds = [
          ...new Set(
            input.runs.flatMap((run) => run.targets.map((target) => target.channelAccountId)),
          ),
        ];
        const accountList = sql.join(accountIds.map((accountId) => sql`${accountId}::uuid`));
        const accounts = await sql<{
          id: string;
          platform: AutomationRunTargetView["platform"];
          status: string;
          supported_execution_levels: string[];
        }>`
          select id, platform, status, supported_execution_levels
          from geo.channel_accounts where id in (${accountList})
        `.execute(transaction);
        const accountsById = new Map(accounts.rows.map((account) => [account.id, account]));
        for (const accountId of accountIds) {
          const account = accountsById.get(accountId);
          if (
            account === undefined ||
            account.status !== "active" ||
            !account.supported_execution_levels.includes("dry_run")
          ) {
            throw new RepositoryConflictError(
              "Automation target account is unavailable or does not support dry-run",
            );
          }
        }

        const scheduledFor = input.runs
          .map((run) => run.availableAt)
          .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
        if (scheduledFor === undefined) {
          throw new RepositoryConflictError("Automation batch requires at least one run");
        }
        await sql`
          insert into geo.automation_batches (
            tenant_id, id, campaign_id, idempotency_key, request_hash,
            state, execution_level, scheduled_for, configuration, created_by_actor_id
          ) values (
            ${context.tenantId}::uuid, ${input.batchId}::uuid, ${input.campaignId}::uuid,
            ${input.idempotencyKey}, ${input.requestHash}, 'scheduled', 'dry_run',
            ${scheduledFor}::timestamptz,
            ${JSON.stringify({ name: input.name })}::jsonb, ${context.actorId}::uuid
          )
        `.execute(transaction);

        for (const run of input.runs) {
          await sql`
            insert into geo.automation_runs (
              tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
              idempotency_key, request_hash, state, stage, available_at
            ) values (
              ${context.tenantId}::uuid, ${run.runId}::uuid, ${input.batchId}::uuid,
              ${input.campaignId}::uuid, ${run.slotKey}, ${run.topicKey},
              ${JSON.stringify({ text: run.brief })}::jsonb,
              ${run.idempotencyKey}, ${run.requestHash}, 'scheduled', 'planning',
              ${run.availableAt}::timestamptz
            )
          `.execute(transaction);
          for (const target of run.targets) {
            const account = accountsById.get(target.channelAccountId);
            if (account === undefined) {
              throw new RepositoryConflictError("Automation target account disappeared");
            }
            await sql`
              insert into geo.automation_run_targets (
                tenant_id, id, run_id, channel_account_id, platform, state,
                variant_idempotency_key, audit_idempotency_key, publication_idempotency_key
              ) values (
                ${context.tenantId}::uuid, ${target.targetId}::uuid, ${run.runId}::uuid,
                ${target.channelAccountId}::uuid, ${account.platform}, 'pending',
                ${target.variantIdempotencyKey}, ${target.auditIdempotencyKey},
                ${target.publicationIdempotencyKey}
              )
            `.execute(transaction);
          }
        }
        await sql`
          insert into geo.audit_log (
            tenant_id, actor_id, action, resource_type, resource_id,
            request_id, after_hash, details
          ) values (
            ${context.tenantId}::uuid, ${context.actorId}::uuid,
            'automation_batch.created', 'automation_batch', ${input.batchId}::uuid,
            ${context.requestId}, ${input.requestHash},
            ${JSON.stringify({ campaignId: input.campaignId, runCount: input.runs.length })}::jsonb
          )
        `.execute(transaction);
        const batch = await selectBatch(transaction, input.batchId);
        if (batch === null) throw new RepositoryConflictError("Automation batch was not persisted");
        return { batch, wasCreated: true };
      });
    },

    async listAutomationBatches(context, input: AutomationBatchListInput) {
      return tenant(context, async (transaction) => {
        const result = await sql<AutomationBatchRow>`
          select batch.id, batch.campaign_id, batch.configuration ->> 'name' as name,
                 batch.state, batch.execution_level, batch.scheduled_for,
                 count(run.id)::integer as run_count,
                 count(run.id) filter (where run.state in ('completed', 'partially_failed'))::integer
                   as completed_run_count,
                 count(run.id) filter (where run.state in ('blocked', 'failed', 'cancelled'))::integer
                   as failed_run_count,
                 batch.created_at, batch.updated_at
          from geo.automation_batches as batch
          left join geo.automation_runs as run
            on run.tenant_id = batch.tenant_id and run.batch_id = batch.id
          where (${input.campaignId ?? null}::uuid is null or batch.campaign_id = ${input.campaignId ?? null}::uuid)
            and (${input.state ?? null}::text is null or batch.state = ${input.state ?? null})
            and (${input.before ?? null}::timestamptz is null or batch.created_at < ${input.before ?? null}::timestamptz)
          group by batch.id
          order by batch.created_at desc, batch.id
          limit ${input.limit}
        `.execute(transaction);
        return result.rows.map(batchView);
      });
    },

    async getAutomationRun(context, runId) {
      return tenant(context, async (transaction) => {
        const runs = await selectRuns(transaction, {
          limit: 1,
          runIds: [runId],
        });
        return runs[0] ?? null;
      });
    },

    async listAutomationRuns(context, input) {
      return tenant(context, (transaction) => selectRuns(transaction, input));
    },

    async claimAutomationRuns(context, input: ClaimAutomationRunsInput) {
      return tenant(context, async (transaction) => {
        const claimed = await sql<{ id: string }>`
          select id from geo.claim_automation_runs(
            ${input.workerId}, ${input.limit}, ${input.leaseSeconds}
          )
        `.execute(transaction);
        const runs = await selectRuns(transaction, {
          limit: input.limit,
          runIds: claimed.rows.map((row) => row.id),
        });
        const evaluatedAt = new Date().toISOString();
        return runs.map((run): AutomationRunLease => ({
          ...run,
          tenantGate: { allowed: true, evaluatedAt },
        }));
      });
    },

    async heartbeatAutomationRun(context, input: HeartbeatAutomationRunInput) {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          accepted: boolean;
          reason: string;
          lease_expires_at: Date | null;
        }>`
          select * from geo.heartbeat_automation_run(
            ${input.runId}::uuid, ${input.workerId}, ${input.attempt}, ${input.stage},
            ${JSON.stringify(input.checkpoint)}::jsonb, ${input.leaseSeconds}
          )
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new RepositoryConflictError("Automation heartbeat failed");
        return leaseMutation(row);
      });
    },

    async checkpointAutomationDraft(context, input: CheckpointAutomationDraftInput) {
      return tenant(context, async (transaction) => {
        try {
          const result = await sql<{
            accepted: boolean;
            reason: string;
            lease_expires_at: Date | null;
          }>`
            select * from geo.checkpoint_automation_draft(
              ${input.runId}::uuid, ${input.workerId}, ${input.attempt},
              ${input.contentItemId}::uuid, ${input.contentVersionId}::uuid,
              ${JSON.stringify(input.checkpoint)}::jsonb, ${input.leaseSeconds}
            )
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) {
            throw new RepositoryConflictError("Automation draft checkpoint failed");
          }
          return leaseMutation(row);
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          return throwAutomationRepositoryError(error);
        }
      });
    },

    async checkpointAutomationTarget(context, input: CheckpointAutomationTargetInput) {
      return tenant(context, async (transaction) => {
        try {
          const result = await sql<{
            accepted: boolean;
            reason: string;
            lease_expires_at: Date | null;
          }>`
            select * from geo.checkpoint_automation_target(
              ${input.runId}::uuid, ${input.targetId}::uuid, ${input.workerId}, ${input.attempt},
              ${input.state}, ${input.variantId}::uuid, ${input.auditRunId}::uuid,
              ${input.auditArtifactId}::uuid, ${input.publicationJobId}::uuid,
              ${input.errorCode}, ${input.errorMessage},
              ${JSON.stringify(input.checkpoint)}::jsonb, ${input.leaseSeconds}
            )
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) {
            throw new RepositoryConflictError("Automation target checkpoint failed");
          }
          return leaseMutation(row);
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          return throwAutomationRepositoryError(error);
        }
      });
    },

    async reconcileAutomationRun(context, input: ReconcileAutomationRunInput) {
      return tenant(context, async (transaction) => {
        try {
          await sql`
            select * from geo.reconcile_automation_run(
              ${input.runId}::uuid, ${input.workerId}, ${input.attempt},
              ${input.retryAfterSeconds}, ${input.errorCode}, ${input.errorMessage}
            )
          `.execute(transaction);
          const runs = await selectRuns(transaction, { limit: 1, runIds: [input.runId] });
          const run = runs[0];
          if (run === undefined) throw new RepositoryNotFoundError("Automation run was not found");
          return run;
        } catch (error) {
          if (
            error instanceof RepositoryConflictError ||
            error instanceof RepositoryNotFoundError
          ) {
            throw error;
          }
          return throwAutomationRepositoryError(error);
        }
      });
    },

    async cancelAutomationBatch(context, batchId, reason) {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          automation_batch_id: string;
          state: AutomationBatchView["state"];
          cancelled_runs: number;
          cancelled_targets: number;
          was_changed: boolean;
        }>`
          select * from geo.cancel_automation_batch(${batchId}::uuid, ${reason})
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new RepositoryNotFoundError("Automation batch was not found");
        const cancellation: AutomationBatchCancellationResult = {
          batchId: row.automation_batch_id,
          state: row.state,
          cancelledRuns: row.cancelled_runs,
          cancelledTargets: row.cancelled_targets,
          wasChanged: row.was_changed,
        };
        return cancellation;
      });
    },
  };
}
