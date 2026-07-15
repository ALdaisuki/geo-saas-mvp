import type { ActorContext } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";

import {
  ResearchRepositoryConflictError,
  ResearchRepositoryNotFoundError,
  type PersistPageCaptureInput,
  type PersistResearchCaptureFailureInput,
  type PersistSitemapDiscoveryInput,
  type ResearchCaptureView,
  type ResearchRepository,
  type ResearchSourcePolicyView,
  type RetireResearchSourcePolicyInput,
} from "./research-repository.js";

interface SourceRow {
  readonly id: string;
  readonly source_key: string;
  readonly version: number;
  readonly display_name: string;
  readonly origin: string;
  readonly allowed_hosts: string[];
  readonly user_agent: string;
  readonly max_bytes: number;
  readonly robots_max_bytes: number;
  readonly timeout_ms: number;
  readonly max_redirects: number;
  readonly max_discovered_urls: number;
  readonly respect_robots: boolean;
  readonly status: ResearchSourcePolicyView["status"];
  readonly created_by_actor_id: string;
  readonly retired_by_actor_id: string | null;
  readonly retirement_reason: string | null;
  readonly created_at: Date;
  readonly retired_at: Date | null;
}

interface CaptureRow {
  readonly id: string;
  readonly source_policy_id: string;
  readonly operation: ResearchCaptureView["operation"];
  readonly status: ResearchCaptureView["status"];
  readonly request_url_hash: string;
  readonly evidence_source_id: string | null;
  readonly error_code: string | null;
  readonly result_metadata: unknown;
  readonly captured_by_actor_id: string;
  readonly started_at: Date;
  readonly completed_at: Date;
  readonly created_at: Date;
}

const sourceColumns = sql.raw(`
  id, source_key, version, display_name, origin, allowed_hosts, user_agent,
  max_bytes, robots_max_bytes, timeout_ms, max_redirects, max_discovered_urls,
  respect_robots, status, created_by_actor_id, retired_by_actor_id,
  retirement_reason, created_at, retired_at
`);

const captureColumns = sql.raw(`
  id, source_policy_id, operation, status, request_url_hash, evidence_source_id,
  error_code, result_metadata, captured_by_actor_id, started_at, completed_at, created_at
`);

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function sourceView(row: SourceRow): ResearchSourcePolicyView {
  return {
    id: row.id,
    sourceKey: row.source_key,
    version: row.version,
    displayName: row.display_name,
    origin: row.origin,
    allowedHosts: row.allowed_hosts,
    userAgent: row.user_agent,
    maxBytes: row.max_bytes,
    robotsMaxBytes: row.robots_max_bytes,
    timeoutMs: row.timeout_ms,
    maxRedirects: row.max_redirects,
    maxDiscoveredUrls: row.max_discovered_urls,
    respectRobots: row.respect_robots,
    status: row.status,
    createdByActorId: row.created_by_actor_id,
    retiredByActorId: row.retired_by_actor_id,
    retirementReason: row.retirement_reason,
    createdAt: toIso(row.created_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

function captureView(row: CaptureRow): ResearchCaptureView {
  return {
    id: row.id,
    sourcePolicyId: row.source_policy_id,
    operation: row.operation,
    status: row.status,
    requestUrlHash: row.request_url_hash,
    evidenceSourceId: row.evidence_source_id,
    errorCode: row.error_code,
    resultMetadata: objectRecord(row.result_metadata),
    capturedByActorId: row.captured_by_actor_id,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
  };
}

function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
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

async function insertAudit(
  transaction: TenantTransaction,
  context: Readonly<ActorContext>,
  input: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly before: unknown | null;
    readonly after: unknown;
    readonly details: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await sql`
    insert into geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, before_hash, after_hash, details
    ) values (
      ${context.tenantId}, ${context.actorId}, ${input.action}, ${input.resourceType},
      ${input.resourceId}, ${context.requestId},
      ${input.before === null ? null : sha256Canonical(input.before)},
      ${sha256Canonical(input.after)}, ${JSON.stringify(input.details)}::jsonb
    )
  `.execute(transaction);
}

async function requireActiveSource(
  transaction: TenantTransaction,
  sourcePolicyId: string,
): Promise<void> {
  const result = await sql<{ status: ResearchSourcePolicyView["status"] }>`
    select status from geo.research_source_policies
    where id = ${sourcePolicyId}::uuid
    for share
  `.execute(transaction);
  if (result.rows[0]?.status !== "active") {
    throw new ResearchRepositoryConflictError(
      "RESEARCH_POLICY_INACTIVE",
      "Research source policy is no longer active",
    );
  }
}

function evidenceMetadata(
  sourcePolicyId: string,
  sourceVersion: number,
  input: PersistPageCaptureInput,
): Readonly<Record<string, unknown>> {
  const snapshot = input.snapshot;
  return {
    researchCapture: {
      captureId: input.captureId,
      sourcePolicyId,
      sourcePolicyVersion: sourceVersion,
      requestedUrl: snapshot.requestedUrl,
      finalUrl: snapshot.finalUrl,
      redirectChain: snapshot.redirectChain,
      status: snapshot.status,
      contentType: snapshot.contentType,
      title: snapshot.title,
      language: snapshot.language,
      canonicalUrl: snapshot.canonicalUrl,
      metaRobots: snapshot.metaRobots,
      indexability: snapshot.indexability,
      visibleText: snapshot.visibleText,
      structuredData: snapshot.structuredData,
      discoveredUrls: snapshot.discoveredUrls,
      responseMetadata: snapshot.responseMetadata,
      robots: snapshot.robots,
    },
  };
}

export function createPostgresResearchRepository(
  runtimeDatabase: Kysely<Database>,
): ResearchRepository {
  return {
    async listSources(context): Promise<readonly ResearchSourcePolicyView[]> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const result = await sql<SourceRow>`
          select ${sourceColumns}
          from geo.research_source_policies
          order by source_key, version desc
        `.execute(transaction);
        return result.rows.map(sourceView);
      });
    },

    async createSource(context, input): Promise<ResearchSourcePolicyView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        try {
          const existing = await sql<SourceRow>`
            select ${sourceColumns}
            from geo.research_source_policies
            where source_key = ${input.sourceKey}
            order by version desc
            for update
          `.execute(transaction);
          const latest = existing.rows[0];
          const version = (latest?.version ?? 0) + 1;
          const active = existing.rows.find((row) => row.status === "active");
          if (active !== undefined) {
            const retired = await sql<SourceRow>`
              update geo.research_source_policies
              set status = 'retired', retired_at = ${input.createdAt},
                  retired_by_actor_id = ${context.actorId},
                  retirement_reason = ${`Superseded by source policy version ${version}`}
              where id = ${active.id}::uuid
              returning ${sourceColumns}
            `.execute(transaction);
            const retiredRow = retired.rows[0];
            if (retiredRow === undefined) {
              throw new ResearchRepositoryConflictError(
                "RESEARCH_POLICY_CONFLICT",
                "Existing source policy could not be retired",
              );
            }
            await insertAudit(transaction, context, {
              action: "research_source_policy.superseded",
              resourceType: "research_source_policy",
              resourceId: active.id,
              before: sourceView(active),
              after: sourceView(retiredRow),
              details: { replacementPolicyId: input.id, replacementVersion: version },
            });
          }

          const inserted = await sql<SourceRow>`
            insert into geo.research_source_policies (
              tenant_id, id, source_key, version, display_name, origin, allowed_hosts,
              user_agent, max_bytes, robots_max_bytes, timeout_ms, max_redirects,
              max_discovered_urls, respect_robots, status, created_by_actor_id, created_at
            ) values (
              ${context.tenantId}, ${input.id}, ${input.sourceKey}, ${version},
              ${input.displayName}, ${input.origin}, ${input.allowedHosts}::text[],
              ${input.userAgent}, ${input.maxBytes}, ${input.robotsMaxBytes}, ${input.timeoutMs},
              ${input.maxRedirects}, ${input.maxDiscoveredUrls}, ${input.respectRobots},
              'active', ${context.actorId}, ${input.createdAt}
            )
            returning ${sourceColumns}
          `.execute(transaction);
          const row = inserted.rows[0];
          if (row === undefined) {
            throw new ResearchRepositoryConflictError(
              "RESEARCH_POLICY_CONFLICT",
              "Research source policy was not created",
            );
          }
          const source = sourceView(row);
          await insertAudit(transaction, context, {
            action: "research_source_policy.created",
            resourceType: "research_source_policy",
            resourceId: source.id,
            before: null,
            after: source,
            details: {
              sourceKey: source.sourceKey,
              version: source.version,
              origin: source.origin,
              allowedHosts: source.allowedHosts,
            },
          });
          return source;
        } catch (error) {
          if (error instanceof ResearchRepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new ResearchRepositoryConflictError(
              "RESEARCH_POLICY_CONFLICT",
              "Research source policy conflicts with a concurrent version",
            );
          }
          throw error;
        }
      });
    },

    async retireSource(context, input: RetireResearchSourcePolicyInput) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const current = await sql<SourceRow>`
          select ${sourceColumns}
          from geo.research_source_policies
          where id = ${input.sourcePolicyId}::uuid
          for update
        `.execute(transaction);
        const row = current.rows[0];
        if (row === undefined) throw new ResearchRepositoryNotFoundError();
        const before = sourceView(row);
        if (row.status === "retired") return { source: before, wasChanged: false };
        const updated = await sql<SourceRow>`
          update geo.research_source_policies
          set status = 'retired', retired_at = ${input.retiredAt},
              retired_by_actor_id = ${context.actorId}, retirement_reason = ${input.reason}
          where id = ${input.sourcePolicyId}::uuid
          returning ${sourceColumns}
        `.execute(transaction);
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new ResearchRepositoryConflictError(
            "RESEARCH_POLICY_CONFLICT",
            "Research source policy was concurrently changed",
          );
        }
        const source = sourceView(updatedRow);
        await insertAudit(transaction, context, {
          action: "research_source_policy.retired",
          resourceType: "research_source_policy",
          resourceId: source.id,
          before,
          after: source,
          details: { reason: input.reason, sourceKey: source.sourceKey, version: source.version },
        });
        return { source, wasChanged: true };
      });
    },

    async getActiveSource(context, sourcePolicyId) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const result = await sql<SourceRow>`
          select ${sourceColumns}
          from geo.research_source_policies
          where id = ${sourcePolicyId}::uuid and status = 'active'
          limit 1
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : sourceView(row);
      });
    },

    async listCaptures(context, input) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const sourcePredicate =
          input.sourcePolicyId === undefined
            ? sql<boolean>`true`
            : sql<boolean>`source_policy_id = ${input.sourcePolicyId}::uuid`;
        const result = await sql<CaptureRow>`
          select ${captureColumns}
          from geo.research_capture_records
          where ${sourcePredicate}
          order by created_at desc, id
          limit ${input.limit}
        `.execute(transaction);
        return result.rows.map(captureView);
      });
    },

    async persistPageCapture(context, input): Promise<ResearchCaptureView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        await requireActiveSource(transaction, input.sourcePolicyId);
        const policy = await sql<{ version: number }>`
          select version from geo.research_source_policies
          where id = ${input.sourcePolicyId}::uuid
        `.execute(transaction);
        const sourceVersion = policy.rows[0]?.version;
        if (sourceVersion === undefined) throw new ResearchRepositoryNotFoundError();
        const existing = await sql<{ id: string; type: string; content_text: string | null }>`
          select id, type, content_text from geo.evidence_sources
          where content_hash = ${input.snapshot.contentHash}
          for share
        `.execute(transaction);
        const existingEvidence = existing.rows[0];
        let evidenceSourceId: string;
        let evidenceReused = false;
        if (existingEvidence === undefined) {
          const metadata = evidenceMetadata(input.sourcePolicyId, sourceVersion, input);
          const inserted = await sql<{ id: string }>`
            insert into geo.evidence_sources (
              tenant_id, id, type, title, source_url, content_hash, content_text,
              captured_at, valid_until, metadata
            ) values (
              ${context.tenantId}, ${input.evidenceSourceId}, 'url',
              ${input.snapshot.title ?? new URL(input.snapshot.finalUrl).hostname},
              ${input.snapshot.finalUrl}, ${input.snapshot.contentHash}, ${input.snapshot.rawHtml},
              ${input.snapshot.fetchedAt}, NULL, ${JSON.stringify(metadata)}::jsonb
            )
            returning id
          `.execute(transaction);
          const insertedId = inserted.rows[0]?.id;
          if (insertedId === undefined) {
            throw new ResearchRepositoryConflictError(
              "RESEARCH_EVIDENCE_CONFLICT",
              "Research evidence was not persisted",
            );
          }
          evidenceSourceId = insertedId;
        } else if (
          existingEvidence.type === "url" &&
          existingEvidence.content_text === input.snapshot.rawHtml
        ) {
          evidenceSourceId = existingEvidence.id;
          evidenceReused = true;
        } else {
          throw new ResearchRepositoryConflictError(
            "RESEARCH_EVIDENCE_CONFLICT",
            "Existing evidence hash belongs to incompatible immutable evidence",
          );
        }

        const metadata = {
          contentHash: input.snapshot.contentHash,
          finalUrl: input.snapshot.finalUrl,
          discoveredUrlCount: input.snapshot.discoveredUrls.length,
          evidenceReused,
        };
        const inserted = await sql<CaptureRow>`
          insert into geo.research_capture_records (
            tenant_id, id, source_policy_id, operation, status, request_url_hash,
            evidence_source_id, error_code, result_metadata, captured_by_actor_id,
            started_at, completed_at
          ) values (
            ${context.tenantId}, ${input.captureId}, ${input.sourcePolicyId},
            'page_capture', 'succeeded', ${input.requestUrlHash}, ${evidenceSourceId},
            NULL, ${JSON.stringify(metadata)}::jsonb, ${context.actorId},
            ${input.startedAt}, ${input.completedAt}
          )
          returning ${captureColumns}
        `.execute(transaction);
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new ResearchRepositoryConflictError(
            "RESEARCH_CAPTURE_CONFLICT",
            "Research capture was not persisted",
          );
        }
        const capture = captureView(row);
        await insertAudit(transaction, context, {
          action: "research_capture.succeeded",
          resourceType: "research_capture",
          resourceId: capture.id,
          before: null,
          after: capture,
          details: {
            operation: capture.operation,
            sourcePolicyId: capture.sourcePolicyId,
            evidenceSourceId,
            contentHash: input.snapshot.contentHash,
          },
        });
        return capture;
      });
    },

    async persistSitemapDiscovery(context, input: PersistSitemapDiscoveryInput) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        await requireActiveSource(transaction, input.sourcePolicyId);
        const metadata = { discoveredUrls: input.discoveredUrls };
        const inserted = await sql<CaptureRow>`
          insert into geo.research_capture_records (
            tenant_id, id, source_policy_id, operation, status, request_url_hash,
            evidence_source_id, error_code, result_metadata, captured_by_actor_id,
            started_at, completed_at
          ) values (
            ${context.tenantId}, ${input.captureId}, ${input.sourcePolicyId},
            'sitemap_discovery', 'succeeded', ${input.requestUrlHash}, NULL, NULL,
            ${JSON.stringify(metadata)}::jsonb, ${context.actorId},
            ${input.startedAt}, ${input.completedAt}
          )
          returning ${captureColumns}
        `.execute(transaction);
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new ResearchRepositoryConflictError(
            "RESEARCH_CAPTURE_CONFLICT",
            "Sitemap discovery was not persisted",
          );
        }
        const capture = captureView(row);
        await insertAudit(transaction, context, {
          action: "research_sitemap.succeeded",
          resourceType: "research_capture",
          resourceId: capture.id,
          before: null,
          after: capture,
          details: {
            operation: capture.operation,
            sourcePolicyId: capture.sourcePolicyId,
            discoveredUrlCount: input.discoveredUrls.length,
          },
        });
        return capture;
      });
    },

    async persistCaptureFailure(context, input: PersistResearchCaptureFailureInput) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const source = await sql<{ id: string }>`
          select id from geo.research_source_policies
          where id = ${input.sourcePolicyId}::uuid
          limit 1
        `.execute(transaction);
        if (source.rows[0] === undefined) throw new ResearchRepositoryNotFoundError();
        const inserted = await sql<CaptureRow>`
          insert into geo.research_capture_records (
            tenant_id, id, source_policy_id, operation, status, request_url_hash,
            evidence_source_id, error_code, result_metadata, captured_by_actor_id,
            started_at, completed_at
          ) values (
            ${context.tenantId}, ${input.captureId}, ${input.sourcePolicyId},
            ${input.operation}, 'failed', ${input.requestUrlHash}, NULL,
            ${input.errorCode}, '{}'::jsonb, ${context.actorId},
            ${input.startedAt}, ${input.completedAt}
          )
          returning ${captureColumns}
        `.execute(transaction);
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new ResearchRepositoryConflictError(
            "RESEARCH_CAPTURE_CONFLICT",
            "Research failure was not persisted",
          );
        }
        const capture = captureView(row);
        await insertAudit(transaction, context, {
          action: "research_capture.failed",
          resourceType: "research_capture",
          resourceId: capture.id,
          before: null,
          after: capture,
          details: {
            operation: capture.operation,
            sourcePolicyId: capture.sourcePolicyId,
            errorCode: capture.errorCode,
          },
        });
        return capture;
      });
    },
  };
}
