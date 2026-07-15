import {
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
  type ConnectorCapability,
  type ExecutionLevel,
  type Platform,
  type PublicationReceipt,
} from "@geo/contracts";
import { setTenantContext, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely, type Transaction } from "kysely";

import { RetryableWorkerError } from "./errors.js";
import type {
  AcquirePublicationExecutionInput,
  AcquirePublicationExecutionResult,
  ClaimedOutboxEvent,
  ClaimOptions,
  CompletePublicationInput,
  CompletePublicationResult,
  DispatcherStore,
  PublicationWork,
  RecordFailureInput,
  RecordReconciliationFailureInput,
  RecordUncertainInput,
  ResolveUncertainInput,
  RetryOptions,
  TenantContext,
  TenantJobStore,
} from "./types.js";

interface ClaimRow {
  tenant_id: string;
  event_id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  locked_until: Date;
}

interface BooleanRow {
  value: boolean | null;
}

interface AcquisitionRow {
  allowed: boolean;
  reason: string | null;
  half_open_probe: boolean;
}

interface WorkRow {
  job_id: string;
  job_state: PublicationWork["job"]["state"];
  job_platform: Platform;
  execution_level: ExecutionLevel;
  idempotency_key: string;
  request_hash: string;
  job_payload_hash: string;
  job_variant_id: string;
  job_channel_account_id: string;
  variant_id: string;
  variant_state: PublicationWork["variant"]["state"];
  variant_payload: unknown;
  variant_payload_hash: string;
  variant_platform: Platform;
  variant_channel_account_id: string;
  account_id: string;
  account_platform: Platform;
  account_capability: ConnectorCapability;
  supported_execution_levels: ExecutionLevel[];
  account_status: PublicationWork["account"]["status"];
  control_mode: "shadow" | "supervised" | "unattended" | "paused" | "stopped" | null;
  kill_switch_enabled: boolean;
  circuit_open: boolean;
  receipt_id: string | null;
  receipt_attempt_id: string | null;
  receipt_platform: Platform | null;
  receipt_execution_level: ExecutionLevel | null;
  receipt_evidence_type: PublicationReceipt["evidenceType"] | null;
  receipt_request_hash: string | null;
  receipt_response_hash: string | null;
  receipt_external_id: string | null;
  receipt_external_url: string | null;
  receipt_published_at: Date | null;
  receipt_recorded_at: Date | null;
  receipt_confirmed: boolean | null;
}

interface LockedJobRow {
  state: PublicationWork["job"]["state"];
  request_hash: string;
}

interface AttemptNumberRow {
  attempt_no: number;
}

interface AttemptStateRow {
  state: "started" | "succeeded" | "failed" | "uncertain" | "reconciled";
}

interface ReconciliationAttemptRow {
  id: string;
  request_hash: string;
  response_hash: string | null;
}

interface AuditEntryInput {
  context: TenantContext;
  action: string;
  resourceId: string;
  beforeHash: string | null;
  afterHash: string | null;
  details: Readonly<Record<string, unknown>>;
}

function asIso(value: Date): string {
  return value.toISOString();
}

function mapReceipt(row: WorkRow, tenantId: string): PublicationReceipt | null {
  if (
    row.receipt_id === null ||
    row.receipt_attempt_id === null ||
    row.receipt_platform === null ||
    row.receipt_execution_level === null ||
    row.receipt_evidence_type === null ||
    row.receipt_request_hash === null ||
    row.receipt_response_hash === null ||
    row.receipt_recorded_at === null ||
    row.receipt_confirmed === null
  ) {
    return null;
  }

  return publicationReceiptSchema.parse({
    id: row.receipt_id,
    tenantId,
    jobId: row.job_id,
    attemptId: row.receipt_attempt_id,
    platform: row.receipt_platform,
    executionLevel: row.receipt_execution_level,
    evidenceType: row.receipt_evidence_type,
    requestHash: row.receipt_request_hash,
    responseHash: row.receipt_response_hash,
    externalId: row.receipt_external_id,
    externalUrl: row.receipt_external_url,
    publishedAt: row.receipt_published_at === null ? null : asIso(row.receipt_published_at),
    recordedAt: asIso(row.receipt_recorded_at),
    confirmed: row.receipt_confirmed,
  });
}

export class PostgresDispatcherStore implements DispatcherStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async #withDispatcherRole<T>(
    operation: (transaction: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return this.#database.transaction().execute(async (transaction) => {
      await sql`set local role geo_dispatcher`.execute(transaction);
      return operation(transaction);
    });
  }

  async claim(options: ClaimOptions): Promise<readonly ClaimedOutboxEvent[]> {
    return this.#withDispatcherRole(async (transaction) => {
      const result = await sql<ClaimRow>`
        select tenant_id, event_id, topic, payload, attempts, locked_until
        from geo.claim_outbox_events(
          ${options.workerId}, ${options.limit}, ${options.leaseSeconds}
        )
      `.execute(transaction);
      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        eventId: row.event_id,
        topic: row.topic,
        payload: row.payload,
        attempts: row.attempts,
        lockedUntil: row.locked_until,
      }));
    });
  }

  async acknowledge(eventId: string, workerId: string): Promise<boolean> {
    return this.#withDispatcherRole(async (transaction) => {
      const result = await sql<BooleanRow>`
        select geo.ack_outbox_event(${eventId}::uuid, ${workerId}) as value
      `.execute(transaction);
      return result.rows[0]?.value === true;
    });
  }

  async retry(options: RetryOptions): Promise<boolean> {
    return this.#withDispatcherRole(async (transaction) => {
      const result = await sql<BooleanRow>`
        select geo.retry_outbox_event(
          ${options.eventId}::uuid,
          ${options.workerId},
          ${options.delaySeconds},
          ${options.error},
          ${options.deadLetter}
        ) as value
      `.execute(transaction);
      return result.rows[0]?.value === true;
    });
  }
}

export class PostgresTenantJobStore implements TenantJobStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async #withRuntimeTenant<T>(
    context: TenantContext,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#database.transaction().execute(async (transaction) => {
      await sql`set local role geo_runtime`.execute(transaction);
      await setTenantContext(transaction, context);
      const actor = await sql<BooleanRow>`
        select exists (
          select 1
          from geo.service_principals as principal
          join geo.tenants as tenant on tenant.id = principal.tenant_id
          where principal.tenant_id = ${context.tenantId}::uuid
            and principal.id = ${context.actorId}::uuid
            and principal.kind = 'worker'
            and principal.status = 'active'
            and tenant.status = 'active'
        ) as value
      `.execute(transaction);
      if (actor.rows[0]?.value !== true) {
        throw new RetryableWorkerError(
          "WORKER_ACTOR_NOT_AUTHORIZED",
          "Worker service principal or tenant is not active",
        );
      }
      return operation(transaction);
    });
  }

  async load(context: TenantContext, jobId: string): Promise<PublicationWork | null> {
    return this.#withRuntimeTenant(context, async (transaction) => {
      const result = await sql<WorkRow>`
        select
          job.id as job_id,
          job.state as job_state,
          job.platform as job_platform,
          job.execution_level,
          job.idempotency_key,
          job.request_hash,
          job.payload_hash as job_payload_hash,
          job.variant_id as job_variant_id,
          job.channel_account_id as job_channel_account_id,
          variant.id as variant_id,
          variant.state as variant_state,
          variant.payload as variant_payload,
          variant.payload_hash as variant_payload_hash,
          variant.platform as variant_platform,
          variant.channel_account_id as variant_channel_account_id,
          account.id as account_id,
          account.platform as account_platform,
          account.capability as account_capability,
          account.supported_execution_levels,
          account.status as account_status,
          control.mode as control_mode,
          coalesce(control.kill_switch_enabled, false) as kill_switch_enabled,
          exists (
            select 1
            from geo.circuit_breakers as circuit
            where circuit.tenant_id = job.tenant_id
              and circuit.state = 'open'
              and (circuit.retry_at is null or circuit.retry_at > clock_timestamp())
              and (
                (circuit.scope_type = 'tenant' and circuit.scope_key = '*')
                or (circuit.scope_type = 'platform' and circuit.scope_key = job.platform)
                or (circuit.scope_type = 'account' and circuit.scope_key = job.channel_account_id::text)
              )
          ) as circuit_open,
          receipt.id as receipt_id,
          receipt.attempt_id as receipt_attempt_id,
          receipt.platform as receipt_platform,
          receipt.execution_level as receipt_execution_level,
          receipt.evidence_type as receipt_evidence_type,
          receipt.request_hash as receipt_request_hash,
          receipt.response_hash as receipt_response_hash,
          receipt.external_id as receipt_external_id,
          receipt.external_url as receipt_external_url,
          receipt.published_at as receipt_published_at,
          receipt.recorded_at as receipt_recorded_at,
          receipt.confirmed as receipt_confirmed
        from geo.publication_jobs as job
        join geo.publication_variants as variant
          on variant.tenant_id = job.tenant_id and variant.id = job.variant_id
        join geo.channel_accounts as account
          on account.tenant_id = job.tenant_id and account.id = job.channel_account_id
        left join geo.automation_controls as control
          on control.tenant_id = job.tenant_id
         and control.scope_type = 'tenant'
         and control.scope_key = '*'
        left join lateral (
          select candidate.*
          from geo.publication_receipts as candidate
          where candidate.tenant_id = job.tenant_id and candidate.job_id = job.id
          order by candidate.recorded_at desc, candidate.id desc
          limit 1
        ) as receipt on true
        where job.tenant_id = ${context.tenantId}::uuid
          and job.id = ${jobId}::uuid
        limit 1
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) return null;

      const gateReason = row.kill_switch_enabled
        ? "tenant kill switch is enabled"
        : row.control_mode === "paused" || row.control_mode === "stopped"
          ? `tenant automation mode is ${row.control_mode}`
          : row.circuit_open && row.execution_level !== "dry_run"
            ? "matching circuit breaker is open"
            : null;
      const receipt = mapReceipt(row, context.tenantId);

      return {
        job: {
          id: row.job_id,
          state: row.job_state,
          platform: row.job_platform,
          executionLevel: row.execution_level,
          idempotencyKey: row.idempotency_key,
          requestHash: row.request_hash,
          payloadHash: row.job_payload_hash,
          variantId: row.job_variant_id,
          channelAccountId: row.job_channel_account_id,
        },
        variant: {
          id: row.variant_id,
          state: row.variant_state,
          payload: publicationVariantPayloadSchema.parse(row.variant_payload),
          payloadHash: row.variant_payload_hash,
          platform: row.variant_platform,
          channelAccountId: row.variant_channel_account_id,
        },
        account: {
          id: row.account_id,
          platform: row.account_platform,
          capability: row.account_capability,
          supportedExecutionLevels: row.supported_execution_levels,
          status: row.account_status,
        },
        gate: { allowed: gateReason === null, reason: gateReason },
        existingReceipt: receipt,
      };
    });
  }

  async acquirePublicationExecution(
    input: AcquirePublicationExecutionInput,
  ): Promise<AcquirePublicationExecutionResult> {
    return this.#withRuntimeTenant(input.context, async (transaction) => {
      const result = await sql<AcquisitionRow>`
        select *
        from geo.acquire_publication_execution(
          ${input.jobId}::uuid,
          ${input.attemptId}::uuid,
          ${input.workerId}
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Publication execution gate returned no decision");
      return {
        allowed: row.allowed,
        reason: row.reason,
        halfOpenProbe: row.half_open_probe,
      };
    });
  }

  async complete(input: CompletePublicationInput): Promise<CompletePublicationResult> {
    return this.#withRuntimeTenant(input.context, async (transaction) => {
      await this.#finishPublicationExecution(transaction, input, "succeeded");
      const job = await this.#lockJob(transaction, input.context, input.jobId);
      if (job.state === "confirmed" || job.state === "preview_completed") {
        const existing = await this.#latestReceipt(transaction, input.context, input.jobId);
        if (existing === null) throw new Error("Completed job has no receipt");
        return { alreadyCompleted: true, receipt: existing };
      }
      if (job.state !== "dispatching") {
        throw new Error(`Cannot complete publication job from state ${job.state}`);
      }
      const attemptResult = await sql<AttemptStateRow>`
        select state
        from geo.publication_attempts
        where tenant_id = ${input.context.tenantId}::uuid
          and job_id = ${input.jobId}::uuid
          and id = ${input.attemptId}::uuid
        for update
      `.execute(transaction);
      const attempt = attemptResult.rows[0];
      if (attempt === undefined || attempt.state !== "succeeded") {
        throw new Error(
          `Cannot complete publication attempt from state ${attempt?.state ?? "missing"}`,
        );
      }

      await sql`
        update geo.publication_attempts
        set request_hash = ${input.receipt.requestHash},
            response_hash = ${input.receipt.responseHash}
        where tenant_id = ${input.context.tenantId}::uuid
          and job_id = ${input.jobId}::uuid
          and id = ${input.attemptId}::uuid
          and state = 'succeeded'
      `.execute(transaction);

      const receiptPayload = JSON.stringify({
        connectorOutcome: input.connectorOutcome,
        evidenceHash: input.evidenceHash,
        previewHash: input.previewHash,
        readback: { status: "not_required", required: false, reason: "dry_run_preview_only" },
      });
      await sql`
        insert into geo.publication_receipts (
          tenant_id, id, job_id, attempt_id, platform, execution_level,
          evidence_type, request_hash, response_hash, external_id, external_url,
          published_at, recorded_at, confirmed, payload
        ) values (
          ${input.context.tenantId}::uuid, ${input.receipt.id}::uuid, ${input.jobId}::uuid,
          ${input.attemptId}::uuid, ${input.receipt.platform}, ${input.receipt.executionLevel},
          ${input.receipt.evidenceType}, ${input.receipt.requestHash},
          ${input.receipt.responseHash}, ${input.receipt.externalId},
          ${input.receipt.externalUrl}, ${input.receipt.publishedAt},
          ${input.receipt.recordedAt}, ${input.receipt.confirmed}, ${receiptPayload}::jsonb
        )
      `.execute(transaction);

      await sql`
        update geo.publication_jobs
        set state = 'preview_completed', preview_completed_at = ${input.finishedAt},
            lease_owner = null, lease_expires_at = null, last_error_code = null
        where tenant_id = ${input.context.tenantId}::uuid and id = ${input.jobId}::uuid
      `.execute(transaction);
      await sql`
        select *
        from geo.schedule_publication_readback(
          ${input.jobId}::uuid,
          ${input.receipt.id}::uuid,
          null
        )
      `.execute(transaction);
      await this.#appendAudit(transaction, {
        context: input.context,
        action: "publication_job.preview_completed",
        resourceId: input.jobId,
        beforeHash: job.request_hash,
        afterHash: input.receipt.responseHash,
        details: {
          jobId: input.jobId,
          attemptId: input.attemptId,
          receiptId: input.receipt.id,
          platform: input.receipt.platform,
          executionLevel: input.receipt.executionLevel,
          requestHash: input.receipt.requestHash,
          responseHash: input.receipt.responseHash,
          evidenceHash: input.evidenceHash,
          previewHash: input.previewHash,
          connectorOutcome: input.connectorOutcome,
          readbackStatus: "not_required",
        },
      });
      return { alreadyCompleted: false, receipt: input.receipt };
    });
  }

  async recordFailure(input: RecordFailureInput): Promise<void> {
    await this.#withRuntimeTenant(input.context, async (transaction) => {
      const attemptResult = await sql<AttemptStateRow>`
        select state
        from geo.publication_attempts
        where tenant_id = ${input.context.tenantId}::uuid
          and job_id = ${input.jobId}::uuid
          and id = ${input.attemptId}::uuid
      `.execute(transaction);
      const attempt = attemptResult.rows[0];
      if (attempt?.state === "started") {
        await this.#finishPublicationExecution(transaction, input, "failed");
      }

      const job = await this.#lockJob(transaction, input.context, input.jobId);
      if (
        job.state === "confirmed" ||
        job.state === "preview_completed" ||
        job.state === "cancelled" ||
        job.state === "permanent_failure" ||
        job.state === "needs_review"
      ) {
        return;
      }
      if (attempt?.state === "started") {
        const persisted = await sql<{ id: string }>`
          update geo.publication_attempts
          set error_code = ${input.code}, error_message = ${input.message.slice(0, 4000)}
          where tenant_id = ${input.context.tenantId}::uuid
            and job_id = ${input.jobId}::uuid
            and id = ${input.attemptId}::uuid
            and state = 'failed'
            and error_code = ${input.code}
          returning id
        `.execute(transaction);
        if (persisted.rows[0] === undefined) return;
      } else if (attempt === undefined) {
        const attemptNo = await this.#nextAttemptNumber(transaction, input.context, input.jobId);
        await sql`
          insert into geo.publication_attempts (
            tenant_id, id, job_id, attempt_no, state, request_hash,
            error_code, error_message, started_at, finished_at
          ) values (
            ${input.context.tenantId}::uuid, ${input.attemptId}::uuid, ${input.jobId}::uuid,
            ${attemptNo}, 'failed', ${job.request_hash}, ${input.code},
            ${input.message.slice(0, 4000)}, ${input.occurredAt}, ${input.occurredAt}
          )
        `.execute(transaction);
      } else {
        return;
      }
      await sql`
        update geo.publication_jobs
        set state = ${
          input.final
            ? input.code === "PUBLICATION_AUTHORIZATION_INVALID"
              ? "needs_review"
              : "permanent_failure"
            : "retry_wait"
        },
            available_at = ${input.occurredAt}, last_error_code = ${input.code}
        where tenant_id = ${input.context.tenantId}::uuid
          and id = ${input.jobId}::uuid
          and state in ('queued', 'dispatching', 'retry_wait')
      `.execute(transaction);
      await this.#appendAudit(transaction, {
        context: input.context,
        action: "publication_job.attempt_failed",
        resourceId: input.jobId,
        beforeHash: job.request_hash,
        afterHash: null,
        details: {
          jobId: input.jobId,
          attemptId: input.attemptId,
          requestHash: job.request_hash,
          errorCode: input.code,
          final: input.final,
        },
      });
    });
  }

  async recordReconciliationFailure(input: RecordReconciliationFailureInput): Promise<void> {
    await this.#withRuntimeTenant(input.context, async (transaction) => {
      const job = await this.#lockJob(transaction, input.context, input.jobId);
      await this.#appendAudit(transaction, {
        context: input.context,
        action: "publication_job.reconciliation_failed",
        resourceId: input.jobId,
        beforeHash: job.request_hash,
        afterHash: input.responseHash,
        details: {
          jobId: input.jobId,
          attemptId: input.attemptId,
          receiptId: input.receiptId,
          requestHash: input.requestHash,
          responseHash: input.responseHash,
          errorCode: input.code,
        },
      });
    });
  }

  async recordUncertain(input: RecordUncertainInput): Promise<void> {
    await this.#withRuntimeTenant(input.context, async (transaction) => {
      const existing = await sql<{ id: string }>`
        select id from geo.publication_receipts
        where tenant_id = ${input.context.tenantId}::uuid and id = ${input.receipt.id}::uuid
      `.execute(transaction);
      if (existing.rows[0] !== undefined) return;

      await this.#finishPublicationExecution(transaction, input, "uncertain");
      const job = await this.#lockJob(transaction, input.context, input.jobId);
      await sql`
        update geo.publication_attempts
        set request_hash = ${input.receipt.requestHash},
            response_hash = ${input.receipt.responseHash},
            error_code = 'PUBLICATION_UNCERTAIN',
            error_message = ${input.message.slice(0, 4000)}
        where tenant_id = ${input.context.tenantId}::uuid
          and job_id = ${input.jobId}::uuid
          and id = ${input.attemptId}::uuid
          and state = 'uncertain'
      `.execute(transaction);
      await sql`
        insert into geo.publication_receipts (
          tenant_id, id, job_id, attempt_id, platform, execution_level,
          evidence_type, request_hash, response_hash, external_id, external_url,
          published_at, recorded_at, confirmed, payload
        ) values (
          ${input.context.tenantId}::uuid, ${input.receipt.id}::uuid, ${input.jobId}::uuid,
          ${input.attemptId}::uuid, ${input.receipt.platform}, ${input.receipt.executionLevel},
          ${input.receipt.evidenceType}, ${input.receipt.requestHash},
          ${input.receipt.responseHash}, ${input.receipt.externalId},
          ${input.receipt.externalUrl}, ${input.receipt.publishedAt},
          ${input.receipt.recordedAt}, false,
          '{"outcome":"uncertain","readback":{"status":"not_required","required":false,"reason":"dry_run_preview_only"},"reconciliation":{"required":true,"reason":"reconcile_before_retry"}}'::jsonb
        )
      `.execute(transaction);
      await sql`
        update geo.publication_jobs
        set state = 'uncertain', last_error_code = 'PUBLICATION_UNCERTAIN'
        where tenant_id = ${input.context.tenantId}::uuid and id = ${input.jobId}::uuid
      `.execute(transaction);
      await this.#appendAudit(transaction, {
        context: input.context,
        action: "publication_job.uncertain_recorded",
        resourceId: input.jobId,
        beforeHash: job.request_hash,
        afterHash: input.receipt.responseHash,
        details: {
          jobId: input.jobId,
          attemptId: input.attemptId,
          receiptId: input.receipt.id,
          requestHash: input.receipt.requestHash,
          responseHash: input.receipt.responseHash,
          errorCode: "PUBLICATION_UNCERTAIN",
        },
      });
    });
  }

  async resolveUncertain(input: ResolveUncertainInput): Promise<void> {
    await this.#withRuntimeTenant(input.context, async (transaction) => {
      const job = await this.#lockJob(transaction, input.context, input.jobId);
      const attemptResult = await sql<ReconciliationAttemptRow>`
        select id, request_hash, response_hash
        from geo.publication_attempts
        where tenant_id = ${input.context.tenantId}::uuid
          and job_id = ${input.jobId}::uuid
          and state = 'uncertain'
        order by attempt_no desc
        limit 1
      `.execute(transaction);
      const attempt = attemptResult.rows[0];
      const retryable = input.result.outcome === "not_published";
      if (retryable) {
        await sql`
          update geo.publication_attempts
          set state = 'reconciled', error_code = 'RECONCILED_NOT_PUBLISHED',
              error_message = 'Reconciliation proved that no external publication exists'
          where tenant_id = ${input.context.tenantId}::uuid
            and id = (
              select id
              from geo.publication_attempts
              where tenant_id = ${input.context.tenantId}::uuid
                and job_id = ${input.jobId}::uuid
                and state = 'uncertain'
              order by attempt_no desc
              limit 1
            )
        `.execute(transaction);
      }
      await sql`
        update geo.publication_jobs
        set state = ${retryable ? "retry_wait" : "needs_review"},
            available_at = ${input.resolvedAt},
            last_error_code = ${
              retryable ? "RECONCILED_NOT_PUBLISHED" : "UNCERTAIN_REQUIRES_MANUAL_REVIEW"
            }
        where tenant_id = ${input.context.tenantId}::uuid and id = ${input.jobId}::uuid
      `.execute(transaction);
      await this.#appendAudit(transaction, {
        context: input.context,
        action: "publication_job.reconciled",
        resourceId: input.jobId,
        beforeHash: job.request_hash,
        afterHash: attempt?.response_hash ?? null,
        details: {
          jobId: input.jobId,
          attemptId: attempt?.id ?? null,
          requestHash: attempt?.request_hash ?? job.request_hash,
          responseHash: attempt?.response_hash ?? null,
          outcome: input.result.outcome,
          confirmed: input.result.confirmed,
          errorCode: retryable ? "RECONCILED_NOT_PUBLISHED" : "UNCERTAIN_REQUIRES_MANUAL_REVIEW",
        },
      });
    });
  }

  async #appendAudit(transaction: TenantTransaction, input: AuditEntryInput): Promise<void> {
    const details = JSON.stringify(input.details);
    await sql`
      insert into geo.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id,
        request_id, before_hash, after_hash, details
      ) values (
        ${input.context.tenantId}::uuid,
        ${input.context.actorId}::uuid,
        ${input.action},
        'publication_job',
        ${input.resourceId}::uuid,
        ${input.context.requestId},
        ${input.beforeHash},
        ${input.afterHash},
        ${details}::jsonb
      )
    `.execute(transaction);
  }

  async #finishPublicationExecution(
    transaction: TenantTransaction,
    input: { context: TenantContext; jobId: string; attemptId: string; code?: string },
    outcome: "succeeded" | "failed" | "uncertain",
  ): Promise<void> {
    const errorCode = outcome === "uncertain" ? "PUBLICATION_UNCERTAIN" : (input.code ?? null);
    await sql`
      select *
      from geo.finish_publication_execution(
        ${input.jobId}::uuid,
        ${input.attemptId}::uuid,
        ${outcome}::text,
        ${errorCode}::text
      )
    `.execute(transaction);
  }

  async #lockJob(
    transaction: TenantTransaction,
    context: TenantContext,
    jobId: string,
  ): Promise<LockedJobRow> {
    const result = await sql<LockedJobRow>`
      select state, request_hash
      from geo.publication_jobs
      where tenant_id = ${context.tenantId}::uuid and id = ${jobId}::uuid
      for update
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Publication job not found in tenant context");
    return row;
  }

  async #nextAttemptNumber(
    transaction: TenantTransaction,
    context: TenantContext,
    jobId: string,
  ): Promise<number> {
    const result = await sql<AttemptNumberRow>`
      select coalesce(max(attempt_no), 0) + 1 as attempt_no
      from geo.publication_attempts
      where tenant_id = ${context.tenantId}::uuid and job_id = ${jobId}::uuid
    `.execute(transaction);
    return result.rows[0]?.attempt_no ?? 1;
  }

  async #latestReceipt(
    transaction: TenantTransaction,
    context: TenantContext,
    jobId: string,
  ): Promise<PublicationReceipt | null> {
    const result = await sql<{
      id: string;
      attempt_id: string;
      platform: Platform;
      execution_level: ExecutionLevel;
      evidence_type: PublicationReceipt["evidenceType"];
      request_hash: string;
      response_hash: string;
      external_id: string | null;
      external_url: string | null;
      published_at: Date | null;
      recorded_at: Date;
      confirmed: boolean;
    }>`
      select id, attempt_id, platform, execution_level, evidence_type,
             request_hash, response_hash, external_id, external_url,
             published_at, recorded_at, confirmed
      from geo.publication_receipts
      where tenant_id = ${context.tenantId}::uuid and job_id = ${jobId}::uuid
      order by recorded_at desc, id desc
      limit 1
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) return null;
    return publicationReceiptSchema.parse({
      id: row.id,
      tenantId: context.tenantId,
      jobId,
      attemptId: row.attempt_id,
      platform: row.platform,
      executionLevel: row.execution_level,
      evidenceType: row.evidence_type,
      requestHash: row.request_hash,
      responseHash: row.response_hash,
      externalId: row.external_id,
      externalUrl: row.external_url,
      publishedAt: row.published_at === null ? null : asIso(row.published_at),
      recordedAt: asIso(row.recorded_at),
      confirmed: row.confirmed,
    });
  }
}
