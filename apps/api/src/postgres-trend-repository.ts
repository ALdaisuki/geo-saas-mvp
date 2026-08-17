import type { ActorContext } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";

import type {
  PersistedTrendObservation,
  TrendObservationPersistResult,
  TrendRepository,
} from "./trend-repository.js";

interface TrendObservationRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly source_key: string;
  readonly title: string;
  readonly normalized_title: string;
  readonly summary: string | null;
  readonly canonical_url: string | null;
  readonly source_rank: number | null;
  readonly heat_value: string | number | null;
  readonly observed_at: Date;
  readonly source_updated_at: Date | null;
  readonly fingerprint: string;
  readonly observation_key: string;
  readonly heat_score: string | number;
  readonly freshness_score_at_ingest: string | number;
  readonly freshness_band_at_ingest: PersistedTrendObservation["freshnessBand"];
  readonly ingested_by_actor_id: string;
  readonly created_at: Date;
  readonly first_observed_at?: Date | undefined;
}

const observationColumns = sql.raw(`
  tenant_id, id, source_key, title, normalized_title, summary, canonical_url,
  source_rank, heat_value, observed_at, source_updated_at, fingerprint,
  observation_key, heat_score, freshness_score_at_ingest,
  freshness_band_at_ingest, ingested_by_actor_id, created_at
`);

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function observationView(row: TrendObservationRow): PersistedTrendObservation {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    sourceKey: row.source_key,
    title: row.title,
    normalizedTitle: row.normalized_title,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.canonical_url === null ? {} : { canonicalUrl: row.canonical_url }),
    ...(row.source_rank === null ? {} : { sourceRank: row.source_rank }),
    ...(row.heat_value === null ? {} : { heatValue: Number(row.heat_value) }),
    observedAt: toIso(row.observed_at),
    ...(row.source_updated_at === null ? {} : { sourceUpdatedAt: toIso(row.source_updated_at) }),
    fingerprint: row.fingerprint,
    observationKey: row.observation_key,
    heatScore: Number(row.heat_score),
    freshnessScore: Number(row.freshness_score_at_ingest),
    freshnessBand: row.freshness_band_at_ingest,
    ingestedByActorId: row.ingested_by_actor_id,
    createdAt: toIso(row.created_at),
    firstObservedAt: toIso(row.first_observed_at ?? row.observed_at),
  };
}

async function tenant<T>(
  database: Kysely<Database>,
  context: Readonly<ActorContext>,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(database, context, async (transaction) => {
    await sql`set local role geo_runtime`.execute(transaction);
    return operation(transaction);
  });
}

async function recordObservationAudit(
  transaction: TenantTransaction,
  context: Readonly<ActorContext>,
  observation: PersistedTrendObservation,
): Promise<void> {
  await sql`
    insert into geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, before_hash, after_hash, details
    ) values (
      ${context.tenantId}, ${context.actorId}, 'trend_observation.ingested',
      'trend_observation', ${observation.id}, ${context.requestId}, NULL,
      ${sha256Canonical(observation)},
      ${JSON.stringify({
        sourceKey: observation.sourceKey,
        fingerprint: observation.fingerprint,
        observationKey: observation.observationKey,
        observedAt: observation.observedAt,
        freshnessBandAtIngest: observation.freshnessBand,
      })}::jsonb
    )
  `.execute(transaction);
}

export function createPostgresTrendRepository(runtimeDatabase: Kysely<Database>): TrendRepository {
  return {
    async persistObservations(context, inputs): Promise<readonly TrendObservationPersistResult[]> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const results: TrendObservationPersistResult[] = [];
        for (const input of inputs) {
          const inserted = await sql<TrendObservationRow>`
            with inserted_observation as (
              insert into geo.trend_observations (
                tenant_id, id, source_key, title, normalized_title, summary,
                canonical_url, source_rank, heat_value, observed_at, source_updated_at,
                fingerprint, observation_key, heat_score, freshness_score_at_ingest,
                freshness_band_at_ingest, ingested_by_actor_id, created_at
              ) values (
                ${context.tenantId}, ${input.id}, ${input.sourceKey}, ${input.title},
                ${input.normalizedTitle}, ${input.summary ?? null},
                ${input.canonicalUrl ?? null}, ${input.sourceRank ?? null},
                ${input.heatValue ?? null}, ${input.observedAt},
                ${input.sourceUpdatedAt ?? null}, ${input.fingerprint},
                ${input.observationKey}, ${input.heatScore}, ${input.freshnessScore},
                ${input.freshnessBand}, ${context.actorId}, ${input.createdAt}
              )
              on conflict (tenant_id, source_key, observation_key) do nothing
              returning ${observationColumns}
            )
            select ${observationColumns}, (
              select min(history.observed_at)
              from geo.trend_observations as history
              where history.tenant_id = inserted_observation.tenant_id
                and history.source_key = inserted_observation.source_key
                and history.fingerprint = inserted_observation.fingerprint
            ) as first_observed_at
            from inserted_observation
          `.execute(transaction);
          const insertedRow = inserted.rows[0];
          if (insertedRow !== undefined) {
            const observation = observationView(insertedRow);
            await recordObservationAudit(transaction, context, observation);
            results.push({ observation, wasCreated: true });
            continue;
          }

          const existing = await sql<TrendObservationRow>`
            select ${observationColumns}, (
              select min(history.observed_at)
              from geo.trend_observations as history
              where history.tenant_id = current_observation.tenant_id
                and history.source_key = current_observation.source_key
                and history.fingerprint = current_observation.fingerprint
            ) as first_observed_at
            from geo.trend_observations as current_observation
            where tenant_id = ${context.tenantId}
              and source_key = ${input.sourceKey}
              and observation_key = ${input.observationKey}
            limit 1
          `.execute(transaction);
          const existingRow = existing.rows[0];
          if (existingRow === undefined) {
            throw new Error("Trend observation idempotency replay could not be resolved");
          }
          results.push({ observation: observationView(existingRow), wasCreated: false });
        }
        return results;
      });
    },

    async listObservations(context, input): Promise<readonly PersistedTrendObservation[]> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const sourcePredicate =
          input.sourceKey === undefined
            ? sql<boolean>`true`
            : sql<boolean>`source_key = ${input.sourceKey}`;
        const result = await sql<TrendObservationRow>`
          with observation_history as (
            select ${observationColumns},
                   min(observed_at) over (
                     partition by tenant_id, source_key, fingerprint
                   ) as first_observed_at
            from geo.trend_observations
            where tenant_id = ${context.tenantId}
              and ${sourcePredicate}
          ), latest_by_source_fingerprint as (
            select distinct on (source_key, fingerprint)
                   ${observationColumns}, first_observed_at
            from observation_history
            order by source_key, fingerprint, observed_at desc, created_at desc, id
          )
          select ${observationColumns}, first_observed_at
          from latest_by_source_fingerprint
          where observed_at >= ${input.observedAfter}
          order by observed_at desc, created_at desc, id
          limit ${input.limit}
        `.execute(transaction);
        return result.rows.map(observationView);
      });
    },
  };
}
