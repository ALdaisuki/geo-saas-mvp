import { sha256Canonical } from "@geo/core";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import {
  automationDiversityStrategy,
  automationKeywordSelectionForProvince,
  automationPlatformSchema,
  automationSlotBrief,
  automationSlotTopicKey,
  destinationTravelResource,
  type Platform,
} from "@geo/contracts";
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
  CampaignAutomationPlanView,
  CheckpointAutomationDraftInput,
  CheckpointAutomationTargetInput,
  ClaimAutomationRunsInput,
  DueCampaignAutomationPlanView,
  HeartbeatAutomationRunInput,
  ReassignAutomationTargetInput,
  ReconcileAutomationRunInput,
  RestartAutomationTargetRemediationInput,
  SaveCampaignAutomationPlanInput,
  UpdateCampaignAutomationPlanScheduleInput,
} from "./automation-repository.js";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type RequestContext,
} from "./repository.js";
import { nextCampaignAutomationRunAt } from "./automation-plan-batch.js";

interface AutomationBatchRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly name: string | null;
  readonly state: AutomationBatchView["state"];
  readonly execution_level: AutomationBatchView["executionLevel"];
  readonly automation_remediation_enabled: boolean;
  readonly scheduled_for: Date;
  readonly run_count: number;
  readonly completed_run_count: number;
  readonly failed_run_count: number;
  readonly delivery_failed_run_count: number;
  readonly cancelled_run_count: number;
  readonly terminal_run_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AutomationRunRow {
  readonly id: string;
  readonly batch_id: string;
  readonly campaign_id: string;
  readonly brand_id: string;
  readonly execution_level: AutomationRunView["executionLevel"];
  readonly automation_remediation_enabled: boolean;
  readonly slot_key: string;
  readonly topic_key: string;
  readonly brief: unknown;
  readonly diversity_rotation_index: number;
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
  readonly external_url: string | null;
  readonly remediation: unknown;
  readonly checkpoint: unknown;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CampaignAutomationPlanRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly actor_id: string;
  readonly enabled: boolean;
  readonly execution_level: CampaignAutomationPlanView["executionLevel"];
  readonly platforms: CampaignAutomationPlanView["platforms"];
  readonly slot_count: number;
  readonly interval_minutes: number;
  readonly daily_times: string[];
  readonly timezone: string;
  readonly next_run_at: Date | null;
  readonly last_run_at: Date | null;
  readonly last_error_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly run_count: number;
  readonly campaign_name: string;
  readonly campaign_topic_key: string;
  readonly campaign_objective: string;
  readonly campaign_prompt_template: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DueCampaignAutomationPlanRow {
  readonly tenant_id: string;
  readonly plan_id: string;
  readonly campaign_id: string;
  readonly actor_id: string;
  readonly execution_level: DueCampaignAutomationPlanView["executionLevel"];
  readonly platforms: DueCampaignAutomationPlanView["platforms"];
  readonly slot_count: number;
  readonly interval_minutes: number;
  readonly daily_times: string[];
  readonly timezone: string;
  readonly next_run_at: Date;
  readonly campaign_name: string;
  readonly campaign_topic_key: string;
  readonly campaign_objective: string;
  readonly campaign_prompt_template: string | null;
}

function campaignAutomationPlanView(row: CampaignAutomationPlanRow): CampaignAutomationPlanView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    actorId: row.actor_id,
    enabled: row.enabled,
    executionLevel: row.execution_level,
    platforms: [...row.platforms],
    slotCount: row.slot_count,
    intervalMinutes: row.interval_minutes,
    dailyTimes: row.daily_times.map((time) => time.slice(0, 5)),
    timezone: row.timezone,
    nextRunAt: nullableIso(row.next_run_at),
    lastRunAt: nullableIso(row.last_run_at),
    lastErrorAt: nullableIso(row.last_error_at),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    runCount: row.run_count,
    campaignName: row.campaign_name,
    campaignTopicKey: row.campaign_topic_key,
    campaignObjective: row.campaign_objective,
    campaignPromptTemplate: row.campaign_prompt_template,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function dueCampaignAutomationPlanView(
  row: DueCampaignAutomationPlanRow,
): DueCampaignAutomationPlanView {
  return {
    tenantId: row.tenant_id,
    planId: row.plan_id,
    campaignId: row.campaign_id,
    actorId: row.actor_id,
    executionLevel: row.execution_level,
    platforms: [...row.platforms],
    slotCount: row.slot_count,
    intervalMinutes: row.interval_minutes,
    dailyTimes: row.daily_times.map((time) => time.slice(0, 5)),
    timezone: row.timezone,
    nextRunAt: toIso(row.next_run_at),
    campaignName: row.campaign_name,
    campaignTopicKey: row.campaign_topic_key,
    campaignObjective: row.campaign_objective,
    campaignPromptTemplate: row.campaign_prompt_template,
  };
}

async function selectCampaignAutomationPlan(
  transaction: TenantTransaction,
  planId: string,
): Promise<CampaignAutomationPlanView | null> {
  const result = await sql<CampaignAutomationPlanRow>`
    select plan.id, plan.campaign_id, plan.actor_id, plan.enabled,
           plan.execution_level, plan.platforms, plan.slot_count,
           plan.interval_minutes, plan.daily_times, plan.timezone,
           plan.next_run_at, plan.last_run_at, plan.last_error_at,
           plan.last_error_code, plan.last_error_message, plan.run_count,
           campaign.name as campaign_name, campaign.topic_key as campaign_topic_key,
           campaign.objective as campaign_objective,
           campaign.prompt_template as campaign_prompt_template,
           plan.created_at, plan.updated_at
    from geo.campaign_automation_plans as plan
    join geo.campaigns as campaign
      on campaign.tenant_id = plan.tenant_id and campaign.id = plan.campaign_id
    where plan.id = ${planId}::uuid
  `.execute(transaction);
  const row = result.rows[0];
  return row === undefined ? null : campaignAutomationPlanView(row);
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function quotaDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
    const message = error instanceof Error ? error.message.trim().slice(0, 300) : "";
    throw new RepositoryConflictError(
      message.length === 0
        ? "Automation state transition was rejected"
        : `Automation state transition was rejected: ${message}`,
    );
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
    automationRemediationEnabled: row.automation_remediation_enabled,
    scheduledFor: toIso(row.scheduled_for),
    runCount: row.run_count,
    completedRunCount: row.completed_run_count,
    failedRunCount: row.failed_run_count,
    deliveryFailedRunCount: row.delivery_failed_run_count,
    cancelledRunCount: row.cancelled_run_count,
    terminalRunCount: row.terminal_run_count,
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
    externalUrl: row.external_url,
    remediation: row.remediation === null ? null : objectRecord(row.remediation),
    checkpoint: objectRecord(row.checkpoint),
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
    executionLevel: row.execution_level,
    automationRemediationEnabled: row.automation_remediation_enabled,
    slotKey: row.slot_key,
    topicKey: row.topic_key,
    brief: briefText(row.brief),
    diversityRotationIndex: row.diversity_rotation_index,
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
           batch.state, batch.execution_level,
           coalesce((batch.configuration ->> 'automationRemediationEnabled')::boolean, true)
             as automation_remediation_enabled,
           batch.scheduled_for,
           count(run.id)::integer as run_count,
           count(run.id) filter (where run.state in ('completed', 'partially_failed'))::integer
             as completed_run_count,
           count(run.id) filter (where run.state in ('blocked', 'failed'))::integer
             as failed_run_count,
           count(run.id) filter (where run.state = 'delivery_failed')::integer
             as delivery_failed_run_count,
           count(run.id) filter (where run.state = 'cancelled')::integer
             as cancelled_run_count,
           count(run.id) filter (where run.state in (
             'completed', 'partially_failed', 'delivery_failed', 'blocked', 'failed', 'cancelled'
           ))::integer as terminal_run_count,
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
    select target.id, target.run_id, target.channel_account_id, target.platform, target.state,
           target.variant_id, target.audit_run_id, target.audit_artifact_id,
           target.publication_job_id,
           coalesce(handoff.external_url, receipt.external_url) as external_url,
           target.remediation,
           target.checkpoint,
           target.last_error_code, target.last_error_message, target.completed_at,
           target.created_at, target.updated_at
    from geo.automation_run_targets as target
    left join lateral (
      select latest_receipt.external_url
      from geo.publication_receipts as latest_receipt
      where latest_receipt.tenant_id = target.tenant_id
        and latest_receipt.job_id = target.publication_job_id
        and latest_receipt.confirmed = true
        and latest_receipt.external_url is not null
      order by latest_receipt.recorded_at desc, latest_receipt.id desc
      limit 1
    ) as receipt on true
    left join lateral (
      select assisted_handoff.external_url
      from geo.publication_assisted_handoffs as assisted_handoff
      where assisted_handoff.tenant_id = target.tenant_id
        and assisted_handoff.job_id = target.publication_job_id
        and assisted_handoff.state = 'confirmed'
        and assisted_handoff.external_url is not null
      order by assisted_handoff.readback_observed_at desc nulls last, assisted_handoff.id desc
      limit 1
    ) as handoff on true
    where target.run_id in (${ids})
    order by target.run_id, target.created_at, target.id
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
           batch.execution_level,
           coalesce((batch.configuration ->> 'automationRemediationEnabled')::boolean, true)
             as automation_remediation_enabled,
           run.slot_key, run.topic_key, run.brief, run.diversity_rotation_index,
           run.state, run.stage,
           run.available_at, run.attempt_count, run.max_attempts,
           run.lease_owner, run.lease_expires_at, run.heartbeat_at,
           run.checkpoint, run.content_item_id, run.content_version_id,
           run.last_error_code, run.last_error_message, run.completed_at,
           run.created_at, run.updated_at
    from geo.automation_runs as run
    join geo.automation_batches as batch
      on batch.tenant_id = run.tenant_id and batch.id = run.batch_id
    join geo.campaigns as campaign
      on campaign.tenant_id = run.tenant_id and campaign.id = run.campaign_id
    where ${runIds}
      and (${input.batchId ?? null}::uuid is null or run.batch_id = ${input.batchId ?? null}::uuid)
      and (${input.state ?? null}::text is null or run.state = ${input.state ?? null})
      and (${input.before ?? null}::timestamptz is null or run.created_at < ${input.before ?? null}::timestamptz)
    order by run.available_at, run.id
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

        const campaign = await sql<{
          id: string;
          name: string;
          status: string;
          automation_remediation_enabled: boolean;
          prompt_template: string | null;
        }>`
          select id, name, status, automation_remediation_enabled, prompt_template
          from geo.campaigns
          where id = ${input.campaignId}::uuid
        `.execute(transaction);
        const campaignRow = campaign.rows[0];
        if (campaignRow === undefined) throw new RepositoryNotFoundError("Campaign was not found");
        if (campaignRow.status !== "active") {
          throw new RepositoryConflictError("Campaign is not active");
        }

        await sql`
          insert into geo.automation_template_rotation_cursors (
            tenant_id, campaign_id, next_index
          ) values (${context.tenantId}::uuid, ${input.campaignId}::uuid, 0)
          on conflict (tenant_id, campaign_id) do nothing
        `.execute(transaction);
        const rotationCursor = await sql<{ next_index: number }>`
          select next_index
          from geo.automation_template_rotation_cursors
          where campaign_id = ${input.campaignId}::uuid
          for update
        `.execute(transaction);
        const rotationStartIndex = rotationCursor.rows[0]?.next_index;
        if (rotationStartIndex === undefined) {
          throw new RepositoryConflictError("Automation template rotation cursor is invalid");
        }
        const rotationIndices = new Map(
          input.runs.map((run, offset) => [run.runId, rotationStartIndex + offset]),
        );
        await sql`
          update geo.automation_template_rotation_cursors
          set next_index = ${rotationStartIndex + input.runs.length}
          where campaign_id = ${input.campaignId}::uuid
        `.execute(transaction);

        let effectiveRuns = input.runs;
        let resolvedAccountPoolIds: readonly string[] | null = null;
        const assignRoundRobinAccounts = async (
          distributionKey: string,
          accountPoolIds: readonly string[],
        ): Promise<readonly string[]> => {
          if (accountPoolIds.length === 0) {
            throw new RepositoryConflictError(
              "Round-robin automation requires at least one eligible target account",
            );
          }
          await sql`
            insert into geo.automation_distribution_cursors (
              tenant_id, pool_key, account_pool_ids, next_offset
            ) values (
              ${context.tenantId}::uuid, ${distributionKey}, ${accountPoolIds}::uuid[], 0
            )
            on conflict (tenant_id, pool_key) do update
            set account_pool_ids = excluded.account_pool_ids,
                next_offset = case
                  when geo.automation_distribution_cursors.account_pool_ids = excluded.account_pool_ids
                    then geo.automation_distribution_cursors.next_offset
                  else geo.automation_distribution_cursors.next_offset % cardinality(excluded.account_pool_ids)
                end
          `.execute(transaction);
          const cursor = await sql<{ next_offset: number; account_pool_ids: string[] }>`
            select next_offset, account_pool_ids
            from geo.automation_distribution_cursors
            where pool_key = ${distributionKey}
            for update
          `.execute(transaction);
          const cursorRow = cursor.rows[0];
          if (
            cursorRow === undefined ||
            JSON.stringify(cursorRow.account_pool_ids) !== JSON.stringify(accountPoolIds)
          ) {
            throw new RepositoryConflictError("Automation distribution cursor is invalid");
          }
          const startOffset = cursorRow.next_offset;
          const assignments = input.runs.map(
            (_, index) => accountPoolIds[(startOffset + index) % accountPoolIds.length] ?? "",
          );
          const nextOffset = (startOffset + input.runs.length) % accountPoolIds.length;
          await sql`
            update geo.automation_distribution_cursors
            set next_offset = ${nextOffset}
            where pool_key = ${distributionKey}
          `.execute(transaction);
          return assignments;
        };

        const platformManagedPlatforms =
          input.distribution?.mode === "platform_round_robin"
            ? [input.distribution.platform]
            : input.distribution?.mode === "platforms_round_robin"
              ? [...input.distribution.platforms]
              : null;
        if (platformManagedPlatforms !== null) {
          if (
            platformManagedPlatforms.length === 0 ||
            new Set(platformManagedPlatforms).size !== platformManagedPlatforms.length
          ) {
            throw new RepositoryConflictError(
              "Platform-managed distribution requires unique target platforms",
            );
          }
          if (
            input.runs.some(
              (run) =>
                run.targets.length !== platformManagedPlatforms.length ||
                run.targets.some((target) => target.channelAccountId !== null),
            )
          ) {
            throw new RepositoryConflictError(
              "Platform-managed distribution requires one unassigned target per platform and run",
            );
          }

          const accountPoolsByPlatform = new Map<
            AutomationRunTargetView["platform"],
            readonly string[]
          >();
          const assignmentsByPlatform = new Map<
            AutomationRunTargetView["platform"],
            readonly string[]
          >();
          for (const platform of [...platformManagedPlatforms].sort()) {
            const platformPool = await sql<{ id: string; browser_session_ready: boolean }>`
              select account.id,
                     runtime.session_state in ('authenticated', 'ready', 'challenge_required') as browser_session_ready
              from geo.channel_accounts as account
              join geo.automation_controls as control
                on control.tenant_id = account.tenant_id
               and control.scope_type = 'account'
               and control.scope_key = account.id::text
              left join geo.ctrip_account_runtime_bindings as runtime
                on runtime.tenant_id = account.tenant_id
               and runtime.channel_account_id = account.id
              where account.platform = ${platform}
                and account.status = 'active'
                and account.archived_at is null
                and ${input.executionLevel} = any(account.supported_execution_levels)
                and not control.kill_switch_enabled
                and control.mode not in ('paused', 'stopped')
                and (
                  ${input.executionLevel} <> 'unattended' or
                  (
                    account.capability = 'browser_assisted' and
                    control.mode = 'unattended'
                  )
                )
              order by browser_session_ready desc, account.created_at, account.id
              for share of account
            `.execute(transaction);
            const readyAccountIds = platformPool.rows
              .filter((account) => account.browser_session_ready)
              .map((account) => account.id);
            const accountPoolIds =
              readyAccountIds.length > 0
                ? readyAccountIds
                : platformPool.rows.map((account) => account.id);
            if (accountPoolIds.length === 0) {
              throw new RepositoryConflictError(
                `No eligible channel account is available for platform ${platform}`,
              );
            }
            const distributionKey = sha256Canonical({
              mode: "platform_round_robin",
              platform,
              executionLevel: input.executionLevel,
            });
            accountPoolsByPlatform.set(platform, accountPoolIds);
            assignmentsByPlatform.set(
              platform,
              await assignRoundRobinAccounts(distributionKey, accountPoolIds),
            );
          }
          resolvedAccountPoolIds = platformManagedPlatforms.flatMap(
            (platform) => accountPoolsByPlatform.get(platform) ?? [],
          );
          effectiveRuns = input.runs.map((run, runIndex) => ({
            ...run,
            targets: run.targets.map((target, targetIndex) => {
              const platform = platformManagedPlatforms[targetIndex];
              const channelAccountId =
                platform === undefined
                  ? undefined
                  : assignmentsByPlatform.get(platform)?.[runIndex];
              if (channelAccountId === undefined) {
                throw new RepositoryConflictError(
                  "Platform-managed automation target assignment is invalid",
                );
              }
              return { ...target, channelAccountId };
            }),
          }));
        } else if (input.distribution?.mode === "round_robin") {
          const roundRobinPool = [...input.distribution.accountPoolIds].sort();
          if (input.runs.some((run) => run.targets.length !== 1)) {
            throw new RepositoryConflictError(
              "Round-robin automation requires exactly one target per run",
            );
          }
          const distributionKey = sha256Canonical({
            mode: "round_robin",
            accountPoolIds: roundRobinPool,
            executionLevel: input.executionLevel,
          });
          const assignments = await assignRoundRobinAccounts(distributionKey, roundRobinPool);
          resolvedAccountPoolIds = roundRobinPool;
          effectiveRuns = input.runs.map((run, index) => ({
            ...run,
            targets: run.targets.map((target) => ({
              ...target,
              channelAccountId: assignments[index] ?? "",
            })),
          }));
        }

        const accountIds = [
          ...new Set(
            resolvedAccountPoolIds ??
              effectiveRuns
                .flatMap((run) => run.targets.map((target) => target.channelAccountId))
                .filter((accountId): accountId is string => accountId !== null),
          ),
        ];
        if (accountIds.length === 0) {
          throw new RepositoryConflictError(
            "Automation batch requires at least one target account",
          );
        }
        const accountList = sql.join(accountIds.map((accountId) => sql`${accountId}::uuid`));
        const accounts = await sql<{
          id: string;
          platform: Platform;
          capability: string;
          status: string;
          supported_execution_levels: string[];
          daily_publish_quota: number;
          max_concurrent_publications: number;
          quota_timezone: string;
          account_control_mode: string | null;
          account_kill_switch_enabled: boolean | null;
        }>`
          select account.id, account.platform, account.capability, account.status,
                 account.supported_execution_levels,
                 account.daily_publish_quota, account.max_concurrent_publications,
                 account.quota_timezone,
                 control.mode as account_control_mode,
                 control.kill_switch_enabled as account_kill_switch_enabled
          from geo.channel_accounts as account
          left join geo.automation_controls as control
            on control.tenant_id = account.tenant_id
           and control.scope_type = 'account'
           and control.scope_key = account.id::text
          where account.id in (${accountList})
            and account.archived_at is null
          for share of account
        `.execute(transaction);
        const accountsById = new Map(
          accounts.rows.map((account) => {
            const platform = automationPlatformSchema.safeParse(account.platform);
            if (!platform.success) {
              throw new RepositoryConflictError(
                "Zhihu accounts are reference-only and cannot enter automation batches",
              );
            }
            return [account.id, { ...account, platform: platform.data }] as const;
          }),
        );
        for (const accountId of accountIds) {
          const account = accountsById.get(accountId);
          if (
            account === undefined ||
            account.status !== "active" ||
            !account.supported_execution_levels.includes(input.executionLevel) ||
            account.account_control_mode === null ||
            account.account_kill_switch_enabled === true ||
            ["paused", "stopped"].includes(account.account_control_mode)
          ) {
            throw new RepositoryConflictError(
              "Automation target account is unavailable or does not support the requested execution level",
            );
          }
          if (input.executionLevel === "unattended" && account.capability !== "browser_assisted") {
            throw new RepositoryConflictError(
              "Unattended automation requires a browser-assisted account capability",
            );
          }
          if (
            input.executionLevel === "unattended" &&
            account.account_control_mode !== "unattended"
          ) {
            throw new RepositoryConflictError(
              "Unattended automation requires an unattended account control",
            );
          }
        }
        if (input.executionLevel !== "dry_run") {
          const quotaRequests = new Map<
            string,
            {
              readonly accountId: string;
              readonly date: string;
              readonly timezone: string;
              readonly limit: number;
              count: number;
            }
          >();
          for (const run of effectiveRuns) {
            for (const target of run.targets) {
              if (target.channelAccountId === null) {
                throw new RepositoryConflictError("Automation target account was not assigned");
              }
              const account = accountsById.get(target.channelAccountId);
              if (account === undefined) {
                throw new RepositoryConflictError("Automation target account disappeared");
              }
              const date = quotaDate(run.availableAt, account.quota_timezone);
              const key = `${account.id}:${date}`;
              const existing = quotaRequests.get(key);
              if (existing === undefined) {
                quotaRequests.set(key, {
                  accountId: account.id,
                  date,
                  timezone: account.quota_timezone,
                  limit: account.daily_publish_quota,
                  count: 1,
                });
              } else {
                existing.count += 1;
              }
            }
          }

          for (const [key, requested] of [...quotaRequests.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          )) {
            const lockKey = `${context.tenantId}:channel-account-daily-quota:${key}`;
            await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(
              transaction,
            );
            const persisted = await sql<{ count: number }>`
              select count(DISTINCT readback.job_id)::integer as count
              from geo.automation_run_targets as target
              join geo.automation_runs as run
                on run.tenant_id = target.tenant_id and run.id = target.run_id
              join geo.automation_batches as batch
                on batch.tenant_id = run.tenant_id and batch.id = run.batch_id
              join geo.publication_readbacks as readback
                on readback.tenant_id = target.tenant_id
               and readback.job_id = target.publication_job_id
              where target.channel_account_id = ${requested.accountId}::uuid
                and batch.execution_level <> 'dry_run'
                and readback.required
                and readback.status = 'succeeded'
                and (readback.completed_at at time zone ${requested.timezone})::date = ${requested.date}::date
            `.execute(transaction);
            if ((persisted.rows[0]?.count ?? 0) + requested.count > requested.limit) {
              throw new RepositoryConflictError(
                `Channel account daily publication quota of ${requested.limit} would be exceeded on ${requested.date}`,
              );
            }
          }
        }

        const scheduledFor = effectiveRuns
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
            ${input.idempotencyKey}, ${input.requestHash}, 'scheduled', ${input.executionLevel},
            ${scheduledFor}::timestamptz,
            ${JSON.stringify({
              name: input.name,
              automationRemediationEnabled: campaignRow.automation_remediation_enabled,
              distribution:
                input.distribution === undefined
                  ? null
                  : {
                      ...input.distribution,
                      resolvedAccountPoolIds: resolvedAccountPoolIds ?? accountIds,
                    },
            })}::jsonb, ${context.actorId}::uuid
          )
        `.execute(transaction);

        for (const run of effectiveRuns) {
          const rotationIndex = rotationIndices.get(run.runId) ?? 0;
          const targetPlatforms = [
            ...new Set(
              run.targets.map((target) => {
                if (target.channelAccountId === null) {
                  throw new RepositoryConflictError("Automation target account was not assigned");
                }
                const account = accountsById.get(target.channelAccountId);
                if (account === undefined) {
                  throw new RepositoryConflictError("Automation target account disappeared");
                }
                return account.platform;
              }),
            ),
          ];
          const diversityStrategy = automationDiversityStrategy(rotationIndex, targetPlatforms);
          const destination = destinationTravelResource(rotationIndex);
          const keywordSelection = automationKeywordSelectionForProvince(
            rotationIndex,
            destination.provinceName,
          );
          const customerPrompt =
            campaignRow.prompt_template === null || campaignRow.prompt_template.trim().length === 0
              ? undefined
              : {
                  template: campaignRow.prompt_template,
                  campaignName: campaignRow.name,
                  topicKey: run.topicKey,
                  destinationProvince: destination.provinceName,
                  platform: targetPlatforms.join("、"),
                  slot: run.slotKey,
                };
          await sql`
            insert into geo.automation_runs (
              tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
              idempotency_key, request_hash, diversity_rotation_index,
              state, stage, available_at
            ) values (
              ${context.tenantId}::uuid, ${run.runId}::uuid, ${input.batchId}::uuid,
              ${input.campaignId}::uuid, ${run.slotKey},
              ${automationSlotTopicKey(run.topicKey, diversityStrategy)},
              ${JSON.stringify({
                text: automationSlotBrief(
                  run.brief,
                  diversityStrategy,
                  keywordSelection,
                  destination,
                  customerPrompt,
                ),
                topicAngle: diversityStrategy.topicAngle,
                diversityStrategyId: diversityStrategy.strategyId,
                destination: {
                  provinceKey: destination.provinceKey,
                  provinceName: destination.provinceName,
                },
                keywordPoolId: keywordSelection.poolId,
                keywordCandidates: keywordSelection.keywords,
              })}::jsonb,
              ${run.idempotencyKey}, ${run.requestHash},
              ${rotationIndex}, 'scheduled', 'planning',
              ${run.availableAt}::timestamptz
            )
          `.execute(transaction);
          for (const target of run.targets) {
            if (target.channelAccountId === null) {
              throw new RepositoryConflictError("Automation target account was not assigned");
            }
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
            ${JSON.stringify({
              campaignId: input.campaignId,
              executionLevel: input.executionLevel,
              automationRemediationEnabled: campaignRow.automation_remediation_enabled,
              distribution:
                input.distribution === undefined
                  ? null
                  : {
                      ...input.distribution,
                      resolvedAccountPoolIds: resolvedAccountPoolIds ?? accountIds,
                    },
              runCount: input.runs.length,
            })}::jsonb
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
                 batch.state, batch.execution_level,
                 coalesce((batch.configuration ->> 'automationRemediationEnabled')::boolean, true)
                   as automation_remediation_enabled,
                 batch.scheduled_for,
                 count(run.id)::integer as run_count,
                 count(run.id) filter (where run.state in ('completed', 'partially_failed'))::integer
                   as completed_run_count,
                 count(run.id) filter (where run.state in ('blocked', 'failed'))::integer
                   as failed_run_count,
                 count(run.id) filter (where run.state = 'delivery_failed')::integer
                   as delivery_failed_run_count,
                 count(run.id) filter (where run.state = 'cancelled')::integer
                   as cancelled_run_count,
                 count(run.id) filter (where run.state in (
                   'completed', 'partially_failed', 'delivery_failed', 'blocked', 'failed', 'cancelled'
                 ))::integer as terminal_run_count,
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

    async reassignAutomationTarget(context, input: ReassignAutomationTargetInput) {
      return tenant(context, async (transaction) => {
        try {
          await sql`
            select * from geo.reassign_pending_automation_target(
              ${input.runId}::uuid,
              ${input.targetId}::uuid,
              ${input.channelAccountId}::uuid
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

    async restartAutomationTargetRemediation(
      context,
      input: RestartAutomationTargetRemediationInput,
    ) {
      return tenant(context, async (transaction) => {
        try {
          const targetResult = await sql<{
            readonly remediation: unknown;
            readonly last_error_code: string | null;
          }>`
            select target.remediation, target.last_error_code
            from geo.automation_run_targets as target
            where target.tenant_id = ${context.tenantId}::uuid
              and target.id = ${input.targetId}::uuid
              and target.run_id = ${input.runId}::uuid
          `.execute(transaction);
          const current = targetResult.rows[0];
          if (current === undefined) {
            throw new RepositoryNotFoundError("Automation target was not found");
          }
          const currentPlan = objectRecord(current.remediation);
          const priorReasonCodes = Array.isArray(currentPlan.reasonCodes)
            ? currentPlan.reasonCodes.filter((value): value is string => typeof value === "string")
            : [];
          const priorAttempt =
            typeof currentPlan.attempt === "number" && Number.isSafeInteger(currentPlan.attempt)
              ? currentPlan.attempt
              : 0;
          const plan = {
            taskId: `${input.runId}:${input.targetId}:manual:${priorAttempt + 1}`,
            scope: "target" as const,
            mode: "manual" as const,
            attempt: priorAttempt + 1,
            maxAttempts: 2,
            reasonCodes:
              priorReasonCodes.length > 0
                ? [...new Set(priorReasonCodes)]
                : [current.last_error_code ?? "audit.manual_remediation"],
            actions: [...new Set(input.actions)],
          };
          await sql`
            select * from geo.restart_automation_target_for_remediation(
              ${input.runId}::uuid,
              ${input.targetId}::uuid,
              ${JSON.stringify(plan)}::jsonb
            )
          `.execute(transaction);
          await sql`
            insert into geo.audit_log (
              tenant_id, actor_id, action, resource_type, resource_id,
              request_id, after_hash, details
            ) values (
              ${context.tenantId}::uuid, ${context.actorId}::uuid,
              'automation_target.manual_remediation_restarted', 'automation_run_target',
              ${input.targetId}::uuid, ${context.requestId},
              ${sha256Canonical(plan)}, ${JSON.stringify(plan)}::jsonb
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

    async getCampaignAutomationPlan(context, campaignId) {
      return tenant(context, async (transaction) => {
        const result = await sql<{ id: string }>`
          select id from geo.campaign_automation_plans
          where campaign_id = ${campaignId}::uuid
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : selectCampaignAutomationPlan(transaction, row.id);
      });
    },

    async saveCampaignAutomationPlan(context, campaignId, input: SaveCampaignAutomationPlanInput) {
      return tenant(context, async (transaction) => {
        const effectiveNextRunAt = input.enabled
          ? (input.nextRunAt ??
            nextCampaignAutomationRunAt({
              intervalMinutes: input.intervalMinutes,
              dailyTimes: input.dailyTimes,
              timezone: input.timezone,
            }))
          : null;
        const result = await sql<{ id: string }>`
          insert into geo.campaign_automation_plans (
            tenant_id, campaign_id, actor_id, enabled, execution_level, platforms,
            slot_count, interval_minutes, daily_times, timezone, next_run_at
          ) values (
            ${context.tenantId}::uuid, ${campaignId}::uuid, ${input.actorId}::uuid,
            ${input.enabled}, ${input.executionLevel}, ${input.platforms}::text[],
            ${input.slotCount}, ${input.intervalMinutes}, ${input.dailyTimes}::time[],
            ${input.timezone}, ${effectiveNextRunAt}::timestamptz
          )
          on conflict (tenant_id, campaign_id) do update set
            actor_id = excluded.actor_id,
            enabled = excluded.enabled,
            execution_level = excluded.execution_level,
            platforms = excluded.platforms,
            slot_count = excluded.slot_count,
            interval_minutes = excluded.interval_minutes,
            daily_times = excluded.daily_times,
            timezone = excluded.timezone,
            next_run_at = excluded.next_run_at
          returning id
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          throw new RepositoryConflictError("Campaign automation plan was not persisted");
        }
        const plan = await selectCampaignAutomationPlan(transaction, row.id);
        if (plan === null) {
          throw new RepositoryConflictError("Campaign automation plan was not persisted");
        }
        return plan;
      });
    },

    async updateCampaignAutomationPlanSchedule(
      context,
      planId,
      input: UpdateCampaignAutomationPlanScheduleInput,
    ) {
      return tenant(context, async (transaction) => {
        const result = await sql<{ id: string }>`
          update geo.campaign_automation_plans
          set last_run_at = ${input.lastRunAt}::timestamptz,
              next_run_at = ${input.nextRunAt}::timestamptz,
              last_error_at = ${input.lastErrorAt ?? null}::timestamptz,
              last_error_code = ${input.lastErrorCode ?? null},
              last_error_message = ${input.lastErrorMessage ?? null},
              run_count = run_count + case when ${input.incrementRunCount ?? false} then 1 else 0 end
          where id = ${planId}::uuid
          returning id
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined)
          throw new RepositoryNotFoundError("Campaign automation plan was not found");
        const plan = await selectCampaignAutomationPlan(transaction, row.id);
        if (plan === null) {
          throw new RepositoryNotFoundError("Campaign automation plan was not found");
        }
        return plan;
      });
    },

    async listDueCampaignAutomationPlans(now: string) {
      const result = await sql<DueCampaignAutomationPlanRow>`
        select * from geo.list_due_campaign_automation_plans(${now}::timestamptz)
      `.execute(runtimeDatabase);
      return result.rows.map(dueCampaignAutomationPlanView);
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
