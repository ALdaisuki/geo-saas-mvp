import {
  mediaReferenceSchema,
  platformSchema,
  publicationVariantPayloadSchema,
} from "@geo/contracts";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import type {
  CtripBridgeControlPlane,
  CtripBridgeExecutionContext,
  CtripBridgeHandoffDraft,
  CtripBridgeMediaAsset,
  CtripBridgePreparationBlocker,
  CtripBridgePreparedEvidence,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripPreparedDraftConflictObservation,
} from "./types.js";
import type { CtripAccountAnalyticsObservation } from "./playwright-account-analytics-collector.js";
import type {
  PriorityPlatformAnalyticsLease,
  PriorityPlatformAnalyticsObservation,
} from "./priority-platform-account-analytics-sync.js";
import type { PlatformLoginId } from "./platform-login-definitions.js";

const handoffRowSchema = z.strictObject({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  channel_account_id: z.string().uuid(),
  variant_id: z.string().uuid(),
  content_version_id: z.string().uuid(),
  platform: platformSchema,
  execution_level: z.enum(["assisted", "unattended"]),
  state: z.enum([
    "handoff_pending",
    "session_required",
    "challenge_required",
    "draft_prepared",
    "awaiting_operator_submit",
    "submitted_unconfirmed",
    "readback_pending",
    "confirmed",
    "needs_review",
    "cancelled",
    "expired",
    "failed",
  ]),
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  adapter_version: z.string().trim().min(1).max(100),
  bridge_service_principal_id: z.string().uuid(),
  external_draft_id: z.string().nullable(),
  submit_outcome: z.enum(["accepted", "uncertain", "rejected", "not_accepted"]).nullable(),
  submit_evidence_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  submit_evidence_kind: z.enum(["simulation", "browser"]).nullable(),
  submit_observed_at: z.coerce.date().nullable(),
  submit_candidate_external_id: z.string().nullable(),
  submit_candidate_external_url: z.string().nullable(),
  submit_permit_consumed_at: z.coerce.date().nullable(),
  payload: publicationVariantPayloadSchema,
});

function handoffView(row: unknown): CtripBridgeHandoffDraft {
  const parsed = handoffRowSchema.parse(row);
  return {
    id: parsed.id,
    tenantId: parsed.tenant_id,
    channelAccountId: parsed.channel_account_id,
    variantId: parsed.variant_id,
    contentVersionId: parsed.content_version_id,
    platform: parsed.platform,
    executionLevel: parsed.execution_level,
    state: parsed.state,
    previewHash: parsed.preview_hash,
    payloadHash: parsed.payload_hash,
    adapterVersion: parsed.adapter_version,
    bridgePrincipalId: parsed.bridge_service_principal_id,
    externalDraftId: parsed.external_draft_id,
    submitOutcome: parsed.submit_outcome,
    submitEvidenceHash: parsed.submit_evidence_hash,
    submitEvidenceKind: parsed.submit_evidence_kind,
    submitObservedAt: parsed.submit_observed_at?.toISOString() ?? null,
    submitCandidateExternalId: parsed.submit_candidate_external_id,
    submitCandidateExternalUrl: parsed.submit_candidate_external_url,
    submitPermitConsumedAt: parsed.submit_permit_consumed_at?.toISOString() ?? null,
    payload: parsed.payload,
  };
}

const mediaAssetRowSchema = z.strictObject({
  content_version_id: z.string().uuid(),
  position: z.coerce.number().int().nonnegative(),
  binding_platform: platformSchema,
  binding_role: z.enum(["cover", "inline"]),
  binding_alt_text: z.string(),
  binding_caption: z.string(),
  storage_key: z.string().trim().min(1),
  id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mime_type: z.string(),
  byte_length: z.coerce.number().int().positive().safe(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  platform: platformSchema,
  role: z.enum(["cover", "inline"]),
  alt_text: z.string(),
  caption: z.string(),
  fact_ids: z.array(z.string().uuid()),
  visual_brief: z.unknown(),
  visual_brief_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  rights: z.unknown(),
  provenance: z.unknown(),
  inspection_asset_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inspection_status: z.enum(["passed", "failed"]),
  evaluator: z.string(),
  evaluator_mode: z.enum(["fixture", "live"]),
  evaluator_version: z.string(),
  response_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inspected_at: z.coerce.date(),
  ocr_text: z.string(),
  labels: z.unknown(),
});

function mediaAssetView(row: unknown): CtripBridgeMediaAsset {
  const parsed = mediaAssetRowSchema.parse(row);
  return {
    contentVersionId: parsed.content_version_id,
    position: parsed.position,
    bindingPlatform: parsed.binding_platform,
    bindingRole: parsed.binding_role,
    bindingAltText: parsed.binding_alt_text,
    bindingCaption: parsed.binding_caption,
    storageKey: parsed.storage_key,
    reference: mediaReferenceSchema.parse({
      id: parsed.id,
      sha256: parsed.sha256,
      mimeType: parsed.mime_type,
      byteLength: parsed.byte_length,
      width: parsed.width,
      height: parsed.height,
      platform: parsed.platform,
      role: parsed.role,
      altText: parsed.alt_text,
      caption: parsed.caption,
      factIds: parsed.fact_ids,
      visualBrief: parsed.visual_brief,
      visualBriefHash: parsed.visual_brief_hash,
      rights: parsed.rights,
      provenance: parsed.provenance,
      inspection: {
        assetSha256: parsed.inspection_asset_sha256,
        status: parsed.inspection_status,
        evaluator: parsed.evaluator,
        evaluatorMode: parsed.evaluator_mode,
        evaluatorVersion: parsed.evaluator_version,
        responseSha256: parsed.response_sha256,
        inspectedAt: parsed.inspected_at.toISOString(),
        ocrText: parsed.ocr_text,
        labels: z.array(z.string()).parse(parsed.labels),
      },
    }),
  };
}

export class PostgresCtripBridgeControlPlane implements CtripBridgeControlPlane {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  listRuntimeBindingAccountIds(context: CtripBridgeExecutionContext): Promise<readonly string[]> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string }>`
        select binding.channel_account_id
        from geo.ctrip_account_runtime_bindings as binding
        join geo.channel_accounts as account
          on account.tenant_id = binding.tenant_id
         and account.id = binding.channel_account_id
        where binding.tenant_id = ${context.tenantId}
          and binding.bridge_principal_id = ${context.bridgePrincipalId}::uuid
          and binding.session_state not in ('unbound', 'disabled')
          and account.status = 'active'
          and (
            binding.manual_ready_until > clock_timestamp()
            or exists (
              select 1
              from geo.publication_assisted_handoffs as active_handoff
              where active_handoff.tenant_id = binding.tenant_id
                and active_handoff.channel_account_id = binding.channel_account_id
                and active_handoff.state in (
                  'handoff_pending', 'session_required', 'challenge_required',
                  'draft_prepared', 'awaiting_operator_submit',
                  'submitted_unconfirmed', 'readback_pending'
                )
            )
            or exists (
              select 1
              from geo.publication_jobs as active_job
              where active_job.tenant_id = binding.tenant_id
                and active_job.channel_account_id = binding.channel_account_id
                and active_job.state in (
                  'queued', 'retry_wait', 'dispatching', 'reconciling', 'uncertain'
                )
            )
          )
        order by binding.created_at, binding.channel_account_id
      `.execute(transaction);
      return result.rows.map((row) => row.channel_account_id);
    });
  }

  listBrowserReclaimAccountIds(context: CtripBridgeExecutionContext): Promise<readonly string[]> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string }>`
        select distinct binding.channel_account_id
        from geo.ctrip_account_runtime_bindings as binding
        join geo.channel_accounts as account
          on account.tenant_id = binding.tenant_id
         and account.id = binding.channel_account_id
        where binding.tenant_id = ${context.tenantId}
          and binding.bridge_principal_id = ${context.bridgePrincipalId}::uuid
          and binding.session_state not in ('unbound', 'disabled')
          and account.status = 'active'
          and (
            binding.manual_ready_until is null
            or binding.manual_ready_until <= clock_timestamp()
          )
          and exists (
            select 1
            from geo.publication_assisted_handoffs as handoff
            where handoff.tenant_id = binding.tenant_id
              and handoff.channel_account_id = binding.channel_account_id
              and (
                (
                  handoff.state = 'readback_pending'
                  and handoff.submit_evidence_hash is not null
                )
                or
                (
                  handoff.state = 'submitted_unconfirmed'
                  and handoff.submit_evidence_hash is not null
                )
                or
                (
                  handoff.state in (
                    'confirmed', 'needs_review', 'cancelled', 'expired', 'failed'
                  )
                  and handoff.updated_at >= clock_timestamp() - interval '1 hour'
                )
                or
                (
                  handoff.state in (
                    'handoff_pending', 'session_required', 'challenge_required'
                  )
                  and handoff.updated_at < clock_timestamp() - interval '5 minutes'
                  and (
                    handoff.lease_expires_at is null
                    or handoff.lease_expires_at < clock_timestamp()
                  )
                )
              )
              and not exists (
                select 1
                from geo.publication_assisted_handoffs as newer_handoff
                where newer_handoff.tenant_id = handoff.tenant_id
                  and newer_handoff.channel_account_id = handoff.channel_account_id
                  and newer_handoff.id <> handoff.id
                  and newer_handoff.updated_at > handoff.updated_at
                  and newer_handoff.state in (
                    'handoff_pending', 'session_required', 'challenge_required',
                    'draft_prepared', 'awaiting_operator_submit',
                    'submitted_unconfirmed', 'readback_pending'
                  )
              )
          )
          and not exists (
            select 1
            from geo.publication_assisted_handoffs as active_handoff
            where active_handoff.tenant_id = binding.tenant_id
              and active_handoff.channel_account_id = binding.channel_account_id
              and (
                active_handoff.state in (
                  'draft_prepared', 'awaiting_operator_submit'
                )
                or (
                  active_handoff.state = 'submitted_unconfirmed'
                  and active_handoff.submit_evidence_hash is null
                )
                or (
                  active_handoff.state = 'readback_pending'
                  and (
                    active_handoff.submit_evidence_hash is null
                    or active_handoff.readback_lease_expires_at >= clock_timestamp()
                  )
                )
                or (
                  active_handoff.state in (
                    'handoff_pending', 'session_required', 'challenge_required'
                  )
                  and (
                    active_handoff.updated_at >= clock_timestamp() - interval '5 minutes'
                    or active_handoff.lease_expires_at >= clock_timestamp()
                  )
                )
              )
          )
          and not exists (
            select 1
            from geo.publication_jobs as active_job
            where active_job.tenant_id = binding.tenant_id
              and active_job.channel_account_id = binding.channel_account_id
              and active_job.state in (
                'queued', 'retry_wait', 'dispatching'
              )
          )
          and not exists (
            select 1
            from geo.ctrip_account_analytics_sync_state as analytics
            where analytics.tenant_id = binding.tenant_id
              and analytics.channel_account_id = binding.channel_account_id
              and analytics.lease_owner = binding.bridge_principal_id
              and analytics.lease_expires_at >= clock_timestamp()
          )
        order by binding.channel_account_id
      `.execute(transaction);
      return result.rows.map((row) => row.channel_account_id);
    });
  }

  loadAccountRuntimeBinding(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
  ): Promise<{
    readonly channelAccountId: string;
    readonly platform: PlatformLoginId;
    readonly expectedAccountName: string;
    readonly profileKey: string;
    readonly sessionState:
      | "unbound"
      | "session_required"
      | "authenticated"
      | "ready"
      | "challenge_required"
      | "unavailable"
      | "disabled";
  }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        channel_account_id: string;
        platform: PlatformLoginId;
        display_name: string;
        profile_key: string;
        session_state:
          | "unbound"
          | "session_required"
          | "authenticated"
          | "ready"
          | "challenge_required"
          | "unavailable"
          | "disabled";
      }>`
        select binding.channel_account_id, account.platform, account.display_name,
               binding.profile_key, binding.session_state
        from geo.ctrip_account_runtime_bindings as binding
        join geo.channel_accounts as account
          on account.tenant_id = binding.tenant_id
         and account.id = binding.channel_account_id
        where binding.tenant_id = ${context.tenantId}
          and binding.channel_account_id = ${channelAccountId}::uuid
          and binding.bridge_principal_id = ${context.bridgePrincipalId}::uuid
          and account.status = 'active'
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined || row.channel_account_id !== channelAccountId) {
        throw new Error("Ctrip account runtime binding does not match the bridge principal");
      }
      return Object.freeze({
        channelAccountId: row.channel_account_id,
        platform: row.platform,
        expectedAccountName: row.display_name,
        profileKey: row.profile_key,
        sessionState: row.session_state,
      });
    });
  }

  recordRuntimeStatus(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    status: "authenticated" | "ready" | "session_required" | "challenge_required" | "unavailable",
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string }>`
        with updated as (
          update geo.ctrip_account_runtime_bindings as binding
          set session_state = ${status},
              last_checked_at = clock_timestamp(),
              last_ready_at = case
                when ${status} = 'ready' then clock_timestamp()
                else binding.last_ready_at
              end,
              last_error_code = ${errorCode},
              last_error_message = ${errorMessage}
          from geo.channel_accounts as account
          where binding.tenant_id = ${context.tenantId}
            and binding.channel_account_id = ${channelAccountId}::uuid
            and binding.bridge_principal_id = ${context.bridgePrincipalId}::uuid
            and binding.session_state not in ('unbound', 'disabled')
            and account.tenant_id = binding.tenant_id
            and account.id = binding.channel_account_id
            and account.status = 'active'
          returning binding.channel_account_id
        ), healed as (
          update geo.circuit_breakers as breaker
          set state = 'closed',
              failure_count = 0,
              opened_at = null,
              retry_at = null,
              reason = null,
              probe_attempt_id = null,
              probe_started_at = null,
              updated_at = clock_timestamp()
          from updated
          where ${status} in ('ready', 'authenticated')
            and breaker.tenant_id = ${context.tenantId}
            and breaker.scope_type = 'account'
            and breaker.scope_key = updated.channel_account_id::text
            and breaker.state in ('open', 'half_open')
            and breaker.reason = 'ASSISTED_SESSION_REQUIRED'
          returning breaker.id
        )
        select channel_account_id from updated
      `.execute(transaction);
      if (result.rows[0]?.channel_account_id !== channelAccountId) {
        throw new Error("Ctrip account runtime binding does not match the bridge principal");
      }
    });
  }

  claimNextAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    leaseSeconds: number,
  ): Promise<string | null> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string | null }>`
        select geo.claim_next_ctrip_account_analytics_refresh(${leaseSeconds})
          as channel_account_id
      `.execute(transaction);
      return result.rows[0]?.channel_account_id ?? null;
    });
  }

  claimNextPriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    leaseSeconds: number,
  ): Promise<PriorityPlatformAnalyticsLease | null> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        channel_account_id: string;
        lease_expires_at: string;
      }>`
        with claimed as (
          select geo.claim_next_priority_platform_account_analytics_refresh(${leaseSeconds})
            as channel_account_id
        )
        select sync.channel_account_id, sync.lease_expires_at::text as lease_expires_at
        from claimed
        join geo.ctrip_account_analytics_sync_state as sync
          on sync.channel_account_id = claimed.channel_account_id
        where sync.lease_owner = ${context.bridgePrincipalId}::uuid
      `.execute(transaction);
      const claimed = result.rows[0];
      return claimed === undefined
        ? null
        : {
            channelAccountId: claimed.channel_account_id,
            leaseExpiresAt: claimed.lease_expires_at,
          };
    });
  }

  completeAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    observation: CtripAccountAnalyticsObservation,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const works = JSON.stringify(observation.works);
      const sources = JSON.stringify(observation.trafficSources);
      const result = await sql<{ channel_account_id: string }>`
        with authorized as (
          select sync.channel_account_id
          from geo.ctrip_account_analytics_sync_state as sync
          where sync.channel_account_id = ${channelAccountId}::uuid
            and sync.lease_owner = ${context.bridgePrincipalId}::uuid
            and sync.lease_expires_at > clock_timestamp()
          for update
        ), upserted as (
          insert into geo.ctrip_account_analytics_snapshots (
            tenant_id, channel_account_id, snapshot_hour, report_period,
            publish_count, featured_count, quality_count, featured_quality_rate,
            content_heat, total_views, total_viewers, total_interactions,
            total_interactors, total_likes, total_favorites, total_comments,
            traffic_sources, works, source_hash, observed_at
          )
          select ${context.tenantId}::uuid, authorized.channel_account_id,
                 date_trunc('hour', ${observation.observedAt}::timestamptz),
                 ${observation.reportPeriod}, ${observation.publishCount},
                 ${observation.featuredCount}, ${observation.qualityCount},
                 ${observation.featuredQualityRate}, ${observation.contentHeat},
                 ${observation.totalViews}, ${observation.totalViewers},
                 ${observation.totalInteractions}, ${observation.totalInteractors},
                 ${observation.totalLikes}, ${observation.totalFavorites},
                 ${observation.totalComments},
                 ${sources}::jsonb, ${works}::jsonb, ${observation.sourceHash},
                 ${observation.observedAt}::timestamptz
          from authorized
          on conflict (tenant_id, channel_account_id, snapshot_hour) do update
          set report_period = excluded.report_period,
              publish_count = excluded.publish_count,
              featured_count = excluded.featured_count,
              quality_count = excluded.quality_count,
              featured_quality_rate = excluded.featured_quality_rate,
              content_heat = excluded.content_heat,
              total_views = excluded.total_views,
              total_viewers = excluded.total_viewers,
              total_interactions = excluded.total_interactions,
              total_interactors = excluded.total_interactors,
              total_likes = excluded.total_likes,
              total_favorites = excluded.total_favorites,
              total_comments = excluded.total_comments,
              traffic_sources = excluded.traffic_sources,
              works = excluded.works,
              source_hash = excluded.source_hash,
              observed_at = excluded.observed_at
          returning channel_account_id
        )
        update geo.ctrip_account_analytics_sync_state as sync
        set next_refresh_at = greatest(
              ${observation.observedAt}::timestamptz + interval '1 hour',
              clock_timestamp() + interval '1 minute'
            ),
            lease_owner = null,
            lease_expires_at = null,
            last_succeeded_at = ${observation.observedAt}::timestamptz,
            last_error_code = null,
            last_error_message = null
        from upserted
        where sync.channel_account_id = upserted.channel_account_id
        returning sync.channel_account_id
      `.execute(transaction);
      if (result.rows[0]?.channel_account_id !== channelAccountId) {
        throw new Error("Ctrip analytics refresh lease is unavailable or expired");
      }
    });
  }

  completePriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    leaseExpiresAt: string,
    observation: PriorityPlatformAnalyticsObservation,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const works = JSON.stringify(observation.works);
      const compatibilityContentHeat = observation.totalImpressions ?? 0;
      const compatibilityInteractions =
        (observation.totalLikes ?? 0) + (observation.totalComments ?? 0);
      const result = await sql<{ channel_account_id: string }>`
        with authorized as (
          select sync.channel_account_id
          from geo.ctrip_account_analytics_sync_state as sync
          join geo.channel_accounts as account
            on account.tenant_id = sync.tenant_id
           and account.id = sync.channel_account_id
           and account.platform = ${observation.platform}
           and account.status = 'active'
           and account.archived_at is null
          where sync.channel_account_id = ${channelAccountId}::uuid
            and sync.lease_owner = ${context.bridgePrincipalId}::uuid
            and sync.lease_expires_at = ${leaseExpiresAt}::timestamptz
            and sync.lease_expires_at > clock_timestamp()
          for update of sync
          for share of account
        ), upserted as (
          insert into geo.ctrip_account_analytics_snapshots (
            tenant_id, channel_account_id, platform, snapshot_hour, report_period,
            publish_count, featured_count, quality_count, featured_quality_rate,
            content_heat, total_views, total_viewers, total_interactions,
            total_interactors, total_impressions, total_reads, total_likes,
            total_comments, traffic_sources, works, source_hash, observed_at
          )
          select ${context.tenantId}::uuid, authorized.channel_account_id,
                 ${observation.platform},
                 date_trunc('hour', ${observation.observedAt}::timestamptz),
                 ${observation.reportPeriod}, ${observation.publishCount}, 0, 0, 0,
                 ${compatibilityContentHeat}, ${observation.totalReads}, 0,
                 ${compatibilityInteractions}, 0,
                 ${observation.totalImpressions}, ${observation.totalReads},
                 ${observation.totalLikes}, ${observation.totalComments},
                 '{}'::jsonb, ${works}::jsonb, ${observation.sourceHash},
                 ${observation.observedAt}::timestamptz
          from authorized
          on conflict (tenant_id, channel_account_id, snapshot_hour) do update
          set platform = excluded.platform,
              report_period = excluded.report_period,
              publish_count = excluded.publish_count,
              content_heat = excluded.content_heat,
              total_views = excluded.total_views,
              total_interactions = excluded.total_interactions,
              total_impressions = excluded.total_impressions,
              total_reads = excluded.total_reads,
              total_likes = excluded.total_likes,
              total_comments = excluded.total_comments,
              works = excluded.works,
              source_hash = excluded.source_hash,
              observed_at = excluded.observed_at
          returning channel_account_id
        )
        update geo.ctrip_account_analytics_sync_state as sync
        set next_refresh_at = greatest(
              ${observation.observedAt}::timestamptz + interval '1 hour',
              clock_timestamp() + interval '1 minute'
            ),
            lease_owner = null,
            lease_expires_at = null,
            last_succeeded_at = ${observation.observedAt}::timestamptz,
            last_error_code = null,
            last_error_message = null
        from upserted
        where sync.channel_account_id = upserted.channel_account_id
        returning sync.channel_account_id
      `.execute(transaction);
      if (result.rows[0]?.channel_account_id !== channelAccountId) {
        throw new Error("Priority-platform analytics refresh lease is unavailable or expired");
      }
    });
  }

  failAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string }>`
        update geo.ctrip_account_analytics_sync_state
        set next_refresh_at = clock_timestamp() + interval '10 minutes',
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = ${errorCode},
            last_error_message = ${errorMessage}
        where channel_account_id = ${channelAccountId}::uuid
          and lease_owner = ${context.bridgePrincipalId}::uuid
        returning channel_account_id
      `.execute(transaction);
      if (result.rows[0]?.channel_account_id !== channelAccountId) {
        throw new Error("Ctrip analytics refresh lease is unavailable");
      }
    });
  }

  failPriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    leaseExpiresAt: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ channel_account_id: string }>`
        update geo.ctrip_account_analytics_sync_state
        set next_refresh_at = case
              when ${errorCode} in (
                'TOUTIAO_ANALYTICS_CHALLENGE_REQUIRED',
                'BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED',
                'SOHU_ANALYTICS_CHALLENGE_REQUIRED',
                'NETEASE_ANALYTICS_CHALLENGE_REQUIRED'
              )
                then clock_timestamp() + interval '1 hour'
              else clock_timestamp() + interval '10 minutes'
            end,
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = ${errorCode},
            last_error_message = ${errorMessage}
        where channel_account_id = ${channelAccountId}::uuid
          and lease_owner = ${context.bridgePrincipalId}::uuid
          and lease_expires_at = ${leaseExpiresAt}::timestamptz
        returning channel_account_id
      `.execute(transaction);
      if (result.rows[0]?.channel_account_id !== channelAccountId) {
        throw new Error("Ctrip analytics refresh lease is unavailable");
      }
    });
  }

  #transaction<T>(
    context: CtripBridgeExecutionContext,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.#database,
      {
        tenantId: context.tenantId,
        actorId: context.bridgePrincipalId,
        requestId: context.requestId,
      },
      operation,
    );
  }

  claimDraftPreparation(
    context: CtripBridgeExecutionContext,
    handoffId: string,
    leaseSeconds: number,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.claim_publication_assisted_draft_prepare(
          ${handoffId}::uuid, ${leaseSeconds}
        )
      `.execute(transaction);
    });
  }

  claimNextDraftPreparation(
    context: CtripBridgeExecutionContext,
    leaseSeconds: number,
    executionLevel?: "assisted" | "unattended",
  ): Promise<string | null> {
    return this.#transaction(context, async (transaction) => {
      const result =
        executionLevel === undefined
          ? await sql<{ handoff_id: string | null }>`
              select geo.claim_next_publication_assisted_draft_prepare(
                ${leaseSeconds}
              ) as handoff_id
            `.execute(transaction)
          : await sql<{ handoff_id: string | null }>`
              select geo.claim_next_publication_assisted_draft_prepare(
                ${leaseSeconds}, ${executionLevel}
              ) as handoff_id
            `.execute(transaction);
      return result.rows[0]?.handoff_id ?? null;
    });
  }

  countRunnableDeliveryAccounts(
    context: CtripBridgeExecutionContext,
    executionLevel: "assisted" | "unattended" | "all",
  ): Promise<number> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ account_count: number | string }>`
        select count(distinct candidate.channel_account_id)::int as account_count
        from geo.publication_assisted_handoffs as candidate
        join geo.publication_jobs as job
          on job.tenant_id = candidate.tenant_id and job.id = candidate.job_id
        where candidate.tenant_id = ${context.tenantId}::uuid
          and candidate.bridge_service_principal_id = ${context.bridgePrincipalId}::uuid
          and (${executionLevel} = 'all' or job.execution_level = ${executionLevel})
          and candidate.expires_at > statement_timestamp()
          and geo.publication_assisted_block_reason(candidate.job_id) is null
          and (
            (
              candidate.state = 'handoff_pending'
              and (
                candidate.draft_prepare_owner_principal_id is null
                or candidate.draft_prepare_lease_expires_at < statement_timestamp()
              )
              and not geo.publication_account_browser_operation_busy(
                candidate.channel_account_id,
                candidate.id,
                true
              )
            )
            or (
              candidate.state in ('session_required', 'challenge_required')
              and (
                candidate.draft_prepare_owner_principal_id is null
                or candidate.draft_prepare_lease_expires_at < statement_timestamp()
              )
              and not geo.publication_account_browser_operation_busy(
                candidate.channel_account_id,
                candidate.id,
                true
              )
            )
            or (
              ${executionLevel} in ('unattended', 'all')
              and candidate.state = 'draft_prepared'
              and candidate.external_draft_id is not null
              and candidate.submit_permit_consumed_at is null
              and (
                candidate.submit_permit_hash is null
                or candidate.submit_permit_expires_at <= statement_timestamp()
              )
              and not geo.publication_account_browser_operation_busy(
                candidate.channel_account_id,
                candidate.id,
                false
              )
            )
          )
      `.execute(transaction);
      const value = Number(result.rows[0]?.account_count ?? 0);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    });
  }

  countActiveDeliveryAccounts(
    context: CtripBridgeExecutionContext,
    executionLevel: "assisted" | "unattended" | "all",
  ): Promise<number> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ account_count: number | string }>`
        select count(distinct candidate.channel_account_id)::int as account_count
        from geo.publication_assisted_handoffs as candidate
        join geo.publication_jobs as job
          on job.tenant_id = candidate.tenant_id and job.id = candidate.job_id
        where candidate.tenant_id = ${context.tenantId}::uuid
          and candidate.bridge_service_principal_id = ${context.bridgePrincipalId}::uuid
          and (${executionLevel} = 'all' or job.execution_level = ${executionLevel})
          and candidate.expires_at > statement_timestamp()
          and geo.publication_assisted_block_reason(candidate.job_id) is null
          and (
            candidate.state in ('handoff_pending', 'session_required', 'challenge_required')
            or (
              ${executionLevel} in ('unattended', 'all')
              and candidate.state = 'draft_prepared'
              and candidate.external_draft_id is not null
              and candidate.submit_permit_consumed_at is null
            )
          )
      `.execute(transaction);
      const value = Number(result.rows[0]?.account_count ?? 0);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    });
  }

  claimNextUnattendedSubmit(
    context: CtripBridgeExecutionContext,
  ): Promise<{ readonly handoffId: string; readonly submitPermit: string } | null> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        handoff_id: string;
        submit_permit: string;
      }>`
        select handoff_id, submit_permit
        from geo.claim_next_ctrip_unattended_submit()
      `.execute(transaction);
      const row = result.rows[0];
      return row === undefined
        ? null
        : { handoffId: row.handoff_id, submitPermit: row.submit_permit };
    });
  }

  claimNextUnattendedReadback(context: CtripBridgeExecutionContext): Promise<string | null> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ handoff_id: string | null }>`
        select geo.claim_next_ctrip_unattended_readback() as handoff_id
      `.execute(transaction);
      return result.rows[0]?.handoff_id ?? null;
    });
  }

  claimUnattendedReadback(
    context: CtripBridgeExecutionContext,
    handoffId: string,
  ): Promise<boolean> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{ claimed: boolean }>`
        select geo.claim_ctrip_unattended_readback(${handoffId}::uuid) as claimed
      `.execute(transaction);
      return result.rows[0]?.claimed ?? false;
    });
  }

  loadHandoff(
    context: CtripBridgeExecutionContext,
    handoffId: string,
  ): Promise<CtripBridgeHandoffDraft> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<z.input<typeof handoffRowSchema>>`
        select handoff.id, handoff.tenant_id, handoff.channel_account_id,
               handoff.variant_id, handoff.platform, handoff.state,
               handoff.preview_hash, handoff.payload_hash, handoff.adapter_version,
               handoff.bridge_service_principal_id, handoff.external_draft_id,
               handoff.submit_outcome, handoff.submit_evidence_hash,
               handoff.submit_evidence_kind, handoff.submit_observed_at,
               handoff.submit_candidate_external_id,
               handoff.submit_candidate_external_url,
               handoff.submit_permit_consumed_at, job.execution_level,
               variant.content_version_id,
               variant.payload
        from geo.publication_assisted_handoffs as handoff
        join geo.publication_variants as variant
          on variant.tenant_id = handoff.tenant_id and variant.id = handoff.variant_id
        join geo.publication_jobs as job
          on job.tenant_id = handoff.tenant_id and job.id = handoff.job_id
        where handoff.id = ${handoffId}::uuid
        limit 1
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Ctrip assisted handoff was not found");
      return handoffView(row);
    });
  }

  loadPreparedMediaAssets(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
  ): Promise<readonly CtripBridgeMediaAsset[]> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<z.input<typeof mediaAssetRowSchema>>`
        select binding.content_version_id,
               (payload_media.ordinal - 1)::integer as position,
               binding.platform as binding_platform, binding.role as binding_role,
               binding.alt_text as binding_alt_text,
               binding.caption as binding_caption, asset.storage_key,
               asset.id, asset.sha256, asset.mime_type, asset.byte_length::text,
               asset.width, asset.height, asset.platform, asset.role,
               asset.alt_text, asset.caption, asset.fact_ids, asset.visual_brief,
               asset.visual_brief_hash, asset.rights, asset.provenance,
               inspection.asset_sha256 as inspection_asset_sha256,
               inspection.status as inspection_status, inspection.evaluator,
               inspection.evaluator_mode, inspection.evaluator_version,
               inspection.response_sha256, inspection.inspected_at,
               inspection.ocr_text, inspection.labels
        from geo.publication_variants as variant
        cross join lateral jsonb_array_elements(
          coalesce(variant.payload -> 'media', '[]'::jsonb)
        ) with ordinality as payload_media(reference, ordinal)
        join geo.media_assets as asset
          on asset.tenant_id = variant.tenant_id
         and asset.id = (payload_media.reference ->> 'id')::uuid
        join geo.content_media_bindings as binding
          on binding.tenant_id = variant.tenant_id
         and binding.content_version_id = variant.content_version_id
         and binding.media_asset_id = asset.id
        join lateral (
          select inspected.asset_sha256, inspected.status, inspected.evaluator,
                 inspected.evaluator_mode, inspected.evaluator_version,
                 inspected.response_sha256, inspected.inspected_at,
                 inspected.ocr_text, inspected.labels
          from geo.media_inspections as inspected
          where inspected.tenant_id = asset.tenant_id
            and inspected.media_asset_id = asset.id
            and inspected.asset_sha256 = asset.sha256
          order by inspected.inspected_at desc, inspected.id desc
          limit 1
        ) as inspection on true
        where variant.tenant_id = ${context.tenantId}::uuid
          and variant.id = ${handoff.variantId}::uuid
          and variant.content_version_id = ${handoff.contentVersionId}::uuid
          and variant.platform = ${handoff.platform}
          and asset.source_class <> 'legacy'
        order by payload_media.ordinal
      `.execute(transaction);
      return result.rows.map(mediaAssetView);
    });
  }

  recordPrepared(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidence: CtripBridgePreparedEvidence,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.record_publication_assisted_draft(
          ${handoff.id}::uuid,
          ${evidence.sessionEvidenceHash}::geo.sha256_hex,
          ${evidence.draftEvidenceHash}::geo.sha256_hex,
          ${evidence.evidenceHash}::geo.sha256_hex,
          ${evidence.mediaManifestHash}::geo.sha256_hex,
          ${evidence.publicContentHash}::geo.sha256_hex,
          ${evidence.evidenceKind},
          ${evidence.observedAt}::timestamptz,
          ${evidence.externalDraftId},
          ${handoff.adapterVersion}
        )
      `.execute(transaction);
    });
  }

  recordPreparationBlocker(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    blocker: CtripBridgePreparationBlocker,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const terminal = blocker.outcome === "adapter_drift" || blocker.outcome === "payload_invalid";
      const status = terminal ? "failed" : blocker.outcome;
      const errorCode =
        blocker.outcome === "adapter_drift"
          ? "ASSISTED_ADAPTER_DRIFT"
          : blocker.outcome === "payload_invalid"
            ? "CTRIP_PAYLOAD_INVALID"
            : null;
      await sql`
        select geo.record_publication_assisted_bridge_status(
          ${handoff.id}::uuid,
          ${status},
          ${blocker.sessionEvidenceHash}::geo.sha256_hex,
          ${blocker.evidenceHash}::geo.sha256_hex,
          ${blocker.evidenceKind},
          ${blocker.observedAt}::timestamptz,
          ${handoff.adapterVersion},
          ${errorCode},
          ${`prepare:${blocker.diagnosticCode}`}
        )
      `.execute(transaction);
    });
  }

  reportChannelAccountPlatformMute(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    reason: string,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.report_channel_account_platform_mute(
          ${handoff.id}::uuid,
          ${handoff.channelAccountId}::uuid,
          ${reason}
        )
      `.execute(transaction);
    });
  }

  recordPreparedConflict(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripPreparedDraftConflictObservation,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.record_publication_assisted_prepared_conflict(
          ${handoff.id}::uuid,
          ${observation.evidenceHash}::geo.sha256_hex,
          ${observation.evidenceKind},
          ${observation.observedAt}::timestamptz,
          ${handoff.adapterVersion},
          ${observation.diagnosticCode}
        )
      `.execute(transaction);
    });
  }

  consumeSubmitPermit(
    context: CtripBridgeExecutionContext,
    handoffId: string,
    submitPermit: string,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.consume_publication_assisted_submit_permit(
          ${handoffId}::uuid, ${submitPermit}
        )
      `.execute(transaction);
    });
  }

  recordSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeSubmitObservation,
  ): Promise<{ readonly receiptId: string | null; readonly readbackId: string | null }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        publication_receipt_id: string | null;
        publication_readback_id: string | null;
      }>`
        select * from geo.record_publication_assisted_submit_observation(
          ${handoff.id}::uuid,
          ${observation.outcome},
          ${observation.evidenceKind},
          ${observation.evidenceHash}::geo.sha256_hex,
          ${observation.candidateExternalId},
          ${observation.candidateExternalUrl},
          ${observation.observedAt}::timestamptz
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Submit observation returned no durable result");
      if ((row.publication_receipt_id === null) !== (row.publication_readback_id === null)) {
        throw new Error("Submit observation returned an incomplete durable result");
      }
      return { receiptId: row.publication_receipt_id, readbackId: row.publication_readback_id };
    });
  }

  recoverSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidenceKind: "simulation" | "browser",
  ): Promise<{ readonly receiptId: string; readonly readbackId: string }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        publication_receipt_id: string;
        publication_readback_id: string;
      }>`
        select * from geo.recover_publication_assisted_submit_uncertain(
          ${handoff.id}::uuid,
          ${evidenceKind}
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Submit recovery returned no evidence identity");
      return { receiptId: row.publication_receipt_id, readbackId: row.publication_readback_id };
    });
  }

  recordReadbackCandidate(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    candidate: { readonly externalId: string; readonly externalUrl: string },
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.record_publication_assisted_candidate_discovery(
          ${handoff.id}::uuid,
          ${candidate.externalId},
          ${candidate.externalUrl}
        )
      `.execute(transaction);
    });
  }

  recordReadback(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeReadbackObservation,
  ): Promise<{
    readonly state: "readback_pending" | "confirmed" | "needs_review";
    readonly externalId: string | null;
    readonly externalUrl: string | null;
  }> {
    return this.#transaction(context, async (transaction) => {
      if (observation.outcome === "publisher_confirmed") {
        const result = await sql<{
          state: "confirmed";
          external_id: string;
          external_url: string;
        }>`
          select * from geo.record_publication_assisted_publisher_status_confirmation(
            ${handoff.id}::uuid,
            ${observation.evidenceHash}::geo.sha256_hex,
            ${observation.externalId},
            ${observation.externalUrl},
            ${observation.observedAt}::timestamptz
          )
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("Publisher-status confirmation returned no durable state");
        return { state: row.state, externalId: row.external_id, externalUrl: row.external_url };
      }
      if (observation.outcome === "publisher_rejected") {
        const result = await sql<{
          state: "needs_review";
          external_id: null;
          external_url: null;
        }>`
          select * from geo.record_publication_assisted_publisher_rejection(
            ${handoff.id}::uuid,
            ${observation.evidenceHash}::geo.sha256_hex,
            ${observation.publisherReasonCode ?? "publisher.rejected.other"},
            ${observation.observedAt}::timestamptz
          )
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new Error("Publisher rejection returned no durable state");
        return { state: row.state, externalId: row.external_id, externalUrl: row.external_url };
      }
      const result = await sql<{
        state: "readback_pending" | "confirmed" | "needs_review";
        external_id: string | null;
        external_url: string | null;
      }>`
        select * from geo.record_publication_assisted_readback(
          ${handoff.id}::uuid,
          ${observation.outcome},
          ${observation.evidenceKind},
          ${observation.evidenceHash}::geo.sha256_hex,
          ${observation.observedPayloadHash}::geo.sha256_hex,
          ${observation.externalId},
          ${observation.externalUrl},
          ${observation.observedAt}::timestamptz
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Readback returned no durable state");
      return { state: row.state, externalId: row.external_id, externalUrl: row.external_url };
    });
  }
}
