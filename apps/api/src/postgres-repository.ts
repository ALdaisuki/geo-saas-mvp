import {
  auditArtifactSchema,
  capabilitySchema,
  publicationGrantSchema,
  publicationVariantPayloadSchema,
  type Capability,
  type PublicationVariantPayload,
  type TenantContact,
} from "@geo/contracts";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApiRepository,
  type AutomationControlView,
  type AutomationStatusView,
  type AuditContextRecord,
  type CampaignView,
  type ChannelAccountView,
  type ClaimFactView,
  type ContentVersionView,
  type ContentView,
  type CreateCampaignInput,
  type CreateClaimFactInput,
  type CreateContentInput,
  type CreateContentVersionInput,
  type CreateEvidenceSourceInput,
  type CreateSessionInput,
  type CreateVariantInput,
  type EvidenceSourceView,
  type FactListInput,
  type LoginIdentity,
  type PersistAuditInput,
  type PersistAuditResult,
  type PersistVisibilityRunInput,
  type PublicationJobView,
  type PublicationReceiptView,
  type PublicationRequestInput,
  type PublicationRequestResult,
  type RequestContext,
  type ResourceScopeRef,
  type ResourceScopeResult,
  type ResolveSessionInput,
  type ResolvedSession,
  type TenantView,
  type VariantView,
  type VisibilityProviderSummary,
  type VisibilityRunContextRecord,
} from "./repository.js";

export interface PostgresApiRepositoryOptions {
  /** Runtime connection must use the geo_runtime role so FORCE RLS remains effective. */
  readonly runtimeDatabase: Kysely<Database>;
  /** Restricted privileged connection used only for pre-authentication identity discovery. */
  readonly identityDatabase: Kysely<Database>;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function capabilityArray(value: unknown): Capability[] {
  return stringArray(value).flatMap((item) => {
    const parsed = capabilitySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface LoginIdentityRow {
  readonly user_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly user_display_name: string;
  readonly user_status: "active" | "disabled";
  readonly tenant_id: string | null;
  readonly tenant_slug: string | null;
  readonly tenant_display_name: string | null;
  readonly tenant_status: "active" | "suspended" | "closed" | null;
  readonly role: LoginIdentity["memberships"][number]["role"] | null;
  readonly capabilities: unknown;
  readonly membership_status: "active" | "suspended" | null;
}

function loginIdentityFromRows(rows: readonly LoginIdentityRow[]): LoginIdentity | null {
  const first = rows[0];
  if (first === undefined) return null;
  return {
    userId: first.user_id,
    email: first.email,
    passwordHash: first.password_hash,
    displayName: first.user_display_name,
    status: first.user_status,
    memberships: rows.flatMap((row) =>
      row.tenant_id === null ||
      row.tenant_slug === null ||
      row.tenant_display_name === null ||
      row.tenant_status === null ||
      row.role === null ||
      row.membership_status === null
        ? []
        : [
            {
              tenantId: row.tenant_id,
              tenantSlug: row.tenant_slug,
              tenantDisplayName: row.tenant_display_name,
              tenantStatus: row.tenant_status,
              role: row.role,
              capabilities: capabilityArray(row.capabilities),
              membershipStatus: row.membership_status,
            },
          ],
    ),
  };
}

export function createPostgresApiRepository(options: PostgresApiRepositoryOptions): ApiRepository {
  const runtimeDatabase = options.runtimeDatabase;
  const identityDatabase = options.identityDatabase;

  async function tenant<T>(
    context: RequestContext,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(runtimeDatabase, context, async (transaction) => {
      await sql`set local role geo_runtime`.execute(transaction);
      return operation(transaction);
    });
  }

  async function readPersistedAudit(
    transaction: TenantTransaction,
    artifactId: string,
    wasCreated: boolean,
  ): Promise<PersistAuditResult | null> {
    const artifactResult = await sql<{
      id: string;
      tenant_id: string;
      variant_id: string;
      channel_account_id: string;
      platform: VariantView["platform"];
      payload_hash: string;
      fact_snapshot_hash: string;
      policy_hash: string;
      policy_version: string;
      audit_hash: string;
      status: "passed" | "failed" | "errored";
      findings: unknown;
      created_at: Date;
      expires_at: Date;
    }>`
      select id, tenant_id, variant_id, channel_account_id, platform, payload_hash,
             fact_snapshot_hash, policy_hash, policy_version, audit_hash, status,
             findings, created_at, expires_at
      from geo.audit_artifacts where id = ${artifactId}
    `.execute(transaction);
    const artifactRow = artifactResult.rows[0];
    if (artifactRow === undefined) return null;

    const grantResult = await sql<{
      id: string;
      tenant_id: string;
      variant_id: string;
      channel_account_id: string;
      platform: VariantView["platform"];
      payload_hash: string;
      audit_hash: string;
      token_hash: string;
      status: "issued" | "consumed" | "expired" | "revoked";
      issued_at: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>`
      select id, tenant_id, variant_id, channel_account_id, platform, payload_hash,
             audit_hash, token_hash, status, issued_at, expires_at, consumed_at
      from geo.publication_grants
      where audit_artifact_id = ${artifactId}
      order by issued_at, id
      limit 2
    `.execute(transaction);
    if (grantResult.rows.length > 1) {
      throw new RepositoryConflictError("Audit artifact has multiple publication grants");
    }
    const grantRow = grantResult.rows[0];
    return {
      artifact: auditArtifactSchema.parse({
        id: artifactRow.id,
        tenantId: artifactRow.tenant_id,
        variantId: artifactRow.variant_id,
        channelAccountId: artifactRow.channel_account_id,
        platform: artifactRow.platform,
        payloadHash: artifactRow.payload_hash,
        factSnapshotHash: artifactRow.fact_snapshot_hash,
        policyHash: artifactRow.policy_hash,
        policyVersion: artifactRow.policy_version,
        auditHash: artifactRow.audit_hash,
        status: artifactRow.status,
        findings: artifactRow.findings,
        createdAt: toIso(artifactRow.created_at),
        expiresAt: toIso(artifactRow.expires_at),
      }),
      grant:
        grantRow === undefined
          ? null
          : publicationGrantSchema.parse({
              id: grantRow.id,
              tenantId: grantRow.tenant_id,
              variantId: grantRow.variant_id,
              channelAccountId: grantRow.channel_account_id,
              platform: grantRow.platform,
              payloadHash: grantRow.payload_hash,
              auditHash: grantRow.audit_hash,
              tokenHash: grantRow.token_hash,
              status: grantRow.status,
              issuedAt: toIso(grantRow.issued_at),
              expiresAt: toIso(grantRow.expires_at),
              consumedAt: toNullableIso(grantRow.consumed_at),
            }),
      wasCreated,
    };
  }

  async function readContacts(transaction: TenantTransaction): Promise<TenantContact[]> {
    const result = await sql<{
      id: string;
      tenant_id: string;
      type: TenantContact["type"];
      label: string;
      value: string;
      is_primary: boolean;
      valid_from: Date;
      valid_until: Date | null;
    }>`
      select id, tenant_id, type, label, value, is_primary, valid_from, valid_until
      from geo.tenant_contacts
      order by is_primary desc, type, value
    `.execute(transaction);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      type: row.type,
      label: row.label,
      value: row.value,
      isPrimary: row.is_primary,
      validFrom: toIso(row.valid_from),
      validUntil: toNullableIso(row.valid_until),
    }));
  }

  async function resourceExists(
    transaction: TenantTransaction,
    resource: ResourceScopeRef,
  ): Promise<boolean> {
    let result: { rows: readonly { value: boolean }[] };
    switch (resource.kind) {
      case "brand":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.brands where id = ${resource.id}) as value
        `.execute(transaction);
        break;
      case "campaign":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.campaigns where id = ${resource.id}) as value
        `.execute(transaction);
        break;
      case "content_version":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.content_versions where id = ${resource.id}) as value
        `.execute(transaction);
        break;
      case "variant":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.publication_variants where id = ${resource.id}) as value
        `.execute(transaction);
        break;
      case "channel_account":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.channel_accounts where id = ${resource.id}) as value
        `.execute(transaction);
        break;
      case "query_set_version":
        result = await sql<{ value: boolean }>`
          select exists(select 1 from geo.query_set_versions where id = ${resource.id}) as value
        `.execute(transaction);
        break;
    }
    return result.rows[0]?.value === true;
  }

  return {
    async isReady(): Promise<boolean> {
      try {
        await Promise.all([
          sql`select 1`.execute(runtimeDatabase),
          sql`select 1`.execute(identityDatabase),
        ]);
        return true;
      } catch {
        return false;
      }
    },

    async findLoginIdentity(email: string): Promise<LoginIdentity | null> {
      const result = await sql<LoginIdentityRow>`
        select * from geo.find_login_identity(${email.toLowerCase()})
      `.execute(identityDatabase);
      return loginIdentityFromRows(result.rows);
    },

    async findLoginIdentityByUserId(userId: string): Promise<LoginIdentity | null> {
      const result = await sql<LoginIdentityRow>`
        select * from geo.find_login_identity_by_user(${userId})
      `.execute(identityDatabase);
      return loginIdentityFromRows(result.rows);
    },

    async createSession(input: CreateSessionInput): Promise<void> {
      await tenant(input, async (transaction) => {
        await sql`
          insert into geo.sessions (
            tenant_id, id, user_id, token_hash, csrf_hash, expires_at
          ) values (
            ${input.tenantId}, ${input.sessionId}, ${input.actorId}, ${input.tokenHash},
            ${input.csrfHash}, ${input.expiresAt}
          )
        `.execute(transaction);
      });
    },

    async resolveSession(input: ResolveSessionInput): Promise<ResolvedSession | null> {
      return tenant(input, async (transaction) => {
        const result = await sql<{
          session_id: string;
          user_id: string;
          user_display_name: string;
          tenant_id: string;
          tenant_slug: string;
          tenant_display_name: string;
          role: ResolvedSession["role"];
          capabilities: unknown;
          csrf_hash: string;
          expires_at: Date;
        }>`
          select
            sessions.id as session_id,
            sessions.user_id,
            users.display_name as user_display_name,
            sessions.tenant_id,
            tenants.slug as tenant_slug,
            tenants.display_name as tenant_display_name,
            memberships.role,
            memberships.capabilities,
            sessions.csrf_hash,
            sessions.expires_at
          from geo.sessions as sessions
          join geo.tenant_memberships as memberships
            on memberships.tenant_id = sessions.tenant_id
           and memberships.user_id = sessions.user_id
          join geo.users as users on users.id = sessions.user_id
          join geo.tenants as tenants on tenants.id = sessions.tenant_id
          where sessions.id = ${input.sessionId}
            and sessions.user_id = ${input.actorId}
            and sessions.tenant_id = ${input.tenantId}
            and sessions.token_hash = ${input.tokenHash}
            and sessions.revoked_at is null
            and sessions.expires_at > ${input.now}
            and memberships.status = 'active'
            and users.status = 'active'
            and tenants.status = 'active'
          limit 1
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }
        await sql`
          update geo.sessions set last_seen_at = clock_timestamp()
          where tenant_id = ${input.tenantId} and id = ${input.sessionId}
        `.execute(transaction);
        return {
          sessionId: row.session_id,
          userId: row.user_id,
          userDisplayName: row.user_display_name,
          tenantId: row.tenant_id,
          tenantSlug: row.tenant_slug,
          tenantDisplayName: row.tenant_display_name,
          role: row.role,
          capabilities: capabilityArray(row.capabilities),
          csrfHash: row.csrf_hash,
          expiresAt: toIso(row.expires_at),
        };
      });
    },

    async revokeSession(context: RequestContext, sessionId: string): Promise<void> {
      await tenant(context, async (transaction) => {
        await sql`
          update geo.sessions set revoked_at = clock_timestamp()
          where tenant_id = ${context.tenantId} and id = ${sessionId} and revoked_at is null
        `.execute(transaction);
      });
    },

    async getTenant(context: RequestContext): Promise<TenantView> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          slug: string;
          display_name: string;
          legal_name: string;
          industry: string;
          status: string;
          default_locale: string;
        }>`
          select id, slug, display_name, legal_name, industry, status, default_locale
          from geo.tenants where id = ${context.tenantId}
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          throw new RepositoryNotFoundError("Tenant was not found");
        }
        return {
          id: row.id,
          slug: row.slug,
          displayName: row.display_name,
          legalName: row.legal_name,
          industry: row.industry,
          status: row.status,
          defaultLocale: row.default_locale,
        };
      });
    },

    async getAutomationStatus(context: RequestContext): Promise<AutomationStatusView> {
      return tenant(context, async (transaction) => {
        const controlResult = await sql<{
          id: string;
          mode: AutomationControlView["mode"];
          kill_switch_enabled: boolean;
          reason: string | null;
          quota: unknown;
          updated_at: Date;
        }>`
          select id, mode, kill_switch_enabled, reason, quota, updated_at
          from geo.automation_controls
          where scope_type = 'tenant' and scope_key = '*'
          limit 1
        `.execute(transaction);
        const control = controlResult.rows[0];
        if (control === undefined) {
          throw new RepositoryNotFoundError("Tenant automation control was not found");
        }
        const circuitResult = await sql<{
          scope_type: AutomationStatusView["circuits"][number]["scopeType"];
          scope_key: string;
          state: AutomationStatusView["circuits"][number]["state"];
          failure_count: number;
          opened_at: Date | null;
          retry_at: Date | null;
          reason: string | null;
          updated_at: Date;
        }>`
          select scope_type, scope_key, state, failure_count,
                 opened_at, retry_at, reason, updated_at
          from geo.circuit_breakers
          order by scope_type, scope_key
        `.execute(transaction);
        return {
          control: {
            id: control.id,
            mode: control.mode,
            killSwitchEnabled: control.kill_switch_enabled,
            reason: control.reason,
            quota: objectRecord(control.quota),
            updatedAt: toIso(control.updated_at),
          },
          circuits: circuitResult.rows.map((row) => ({
            scopeType: row.scope_type,
            scopeKey: row.scope_key,
            state: row.state,
            failureCount: row.failure_count,
            openedAt: toNullableIso(row.opened_at),
            retryAt: toNullableIso(row.retry_at),
            reason: row.reason,
            updatedAt: toIso(row.updated_at),
          })),
        };
      });
    },

    async setTenantKillSwitch(context, input): Promise<AutomationControlView> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          mode: AutomationControlView["mode"];
          kill_switch_enabled: boolean;
          reason: string | null;
          quota: unknown;
          updated_at: Date;
        }>`
          insert into geo.automation_controls (
            tenant_id, id, scope_type, scope_key, mode, quota,
            kill_switch_enabled, reason
          ) values (
            ${context.tenantId}, ${input.controlId}, 'tenant', '*', 'shadow',
            '{"dailyPublications":0,"dryRunOnly":true}'::jsonb,
            ${input.enabled}, ${input.reason}
          )
          on conflict (tenant_id, scope_type, scope_key) do update set
            kill_switch_enabled = excluded.kill_switch_enabled,
            reason = excluded.reason
          returning id, mode, kill_switch_enabled, reason, quota, updated_at
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new RepositoryConflictError("Kill switch was not updated");
        const details = jsonText({
          enabled: input.enabled,
          reason: input.reason,
          controlId: row.id,
        });
        await sql`
          insert into geo.audit_log (
            tenant_id, actor_id, action, resource_type, resource_id,
            request_id, after_hash, details
          ) values (
            ${context.tenantId}, ${context.actorId}, 'automation.kill_switch_changed',
            'automation_control', ${row.id}, ${context.requestId},
            ${input.auditHash}, ${details}::jsonb
          )
        `.execute(transaction);
        return {
          id: row.id,
          mode: row.mode,
          killSwitchEnabled: row.kill_switch_enabled,
          reason: row.reason,
          quota: objectRecord(row.quota),
          updatedAt: toIso(row.updated_at),
        };
      });
    },

    async listContacts(context: RequestContext): Promise<readonly TenantContact[]> {
      return tenant(context, readContacts);
    },

    async listChannelAccounts(context: RequestContext): Promise<readonly ChannelAccountView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          platform: ChannelAccountView["platform"];
          display_name: string;
          capability: ChannelAccountView["capability"];
          supported_execution_levels: string[];
          capability_evidence_type: ChannelAccountView["evidenceType"];
          capability_evidence_refs: unknown;
          status: string;
          last_verified_at: Date | null;
        }>`
          select id, platform, display_name, capability, supported_execution_levels,
                 capability_evidence_type, capability_evidence_refs, status, last_verified_at
          from geo.channel_accounts
          order by platform, display_name
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          platform: row.platform,
          displayName: row.display_name,
          capability: row.capability,
          supportedExecutionLevels:
            row.supported_execution_levels as ChannelAccountView["supportedExecutionLevels"],
          evidenceType: row.capability_evidence_type,
          evidenceRefs: stringArray(row.capability_evidence_refs),
          status: row.status,
          lastVerifiedAt: toNullableIso(row.last_verified_at),
        }));
      });
    },

    async listEvidenceSources(context: RequestContext): Promise<readonly EvidenceSourceView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          type: EvidenceSourceView["type"];
          title: string;
          source_url: string | null;
          content_hash: string;
          captured_at: Date;
          valid_until: Date | null;
          metadata: unknown;
        }>`
          select id, type, title, source_url, content_hash, captured_at, valid_until, metadata
          from geo.evidence_sources
          order by captured_at desc, id
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          sourceUrl: row.source_url,
          contentHash: row.content_hash,
          capturedAt: toIso(row.captured_at),
          validUntil: toNullableIso(row.valid_until),
          metadata: objectRecord(row.metadata),
        }));
      });
    },

    async createEvidenceSource(
      context: RequestContext,
      input: CreateEvidenceSourceInput,
    ): Promise<EvidenceSourceView> {
      return tenant(context, async (transaction) => {
        type EvidenceRow = {
          id: string;
          type: EvidenceSourceView["type"];
          title: string;
          source_url: string | null;
          content_hash: string;
          captured_at: Date;
          valid_until: Date | null;
          metadata: unknown;
        };
        const metadata = jsonText(input.metadata);
        const inserted = await sql<EvidenceRow>`
          insert into geo.evidence_sources (
            tenant_id, id, type, title, source_url, content_hash, content_text,
            captured_at, valid_until, metadata
          ) values (
            ${context.tenantId}, ${input.id}, ${input.type}, ${input.title}, ${input.sourceUrl},
            ${input.contentHash}, ${input.content}, ${input.capturedAt}, ${input.validUntil},
            ${metadata}::jsonb
          )
          on conflict (tenant_id, content_hash) do nothing
          returning id, type, title, source_url, content_hash, captured_at, valid_until, metadata
        `.execute(transaction);
        const row =
          inserted.rows[0] ??
          (
            await sql<EvidenceRow>`
              select id, type, title, source_url, content_hash, captured_at, valid_until, metadata
              from geo.evidence_sources where content_hash = ${input.contentHash}
            `.execute(transaction)
          ).rows[0];
        if (row === undefined) {
          throw new RepositoryConflictError("Evidence source was not created");
        }
        return {
          id: row.id,
          type: row.type,
          title: row.title,
          sourceUrl: row.source_url,
          contentHash: row.content_hash,
          capturedAt: toIso(row.captured_at),
          validUntil: toNullableIso(row.valid_until),
          metadata: objectRecord(row.metadata),
        };
      });
    },

    async listFacts(
      context: RequestContext,
      input: FactListInput,
    ): Promise<readonly ClaimFactView[]> {
      return tenant(context, async (transaction) => {
        const brandPredicate =
          input.brandId === undefined
            ? sql<boolean>`true`
            : sql<boolean>`brand_id = ${input.brandId}`;
        const queryPredicate =
          input.query === undefined
            ? sql<boolean>`true`
            : sql<boolean>`(normalized_key ilike ${`%${input.query}%`} or claim ilike ${`%${input.query}%`})`;
        const result = await sql<{
          id: string;
          brand_id: string;
          normalized_key: string;
          claim: string;
          status: ClaimFactView["status"];
          evidence_refs: unknown;
          valid_from: Date;
          valid_until: Date | null;
        }>`
          select id, brand_id, normalized_key, claim, status, evidence_refs, valid_from, valid_until
          from geo.claim_facts
          where ${brandPredicate} and ${queryPredicate}
          order by updated_at desc, id
          limit ${input.limit}
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          brandId: row.brand_id,
          normalizedKey: row.normalized_key,
          claim: row.claim,
          status: row.status,
          evidenceSourceIds: stringArray(row.evidence_refs),
          validFrom: toIso(row.valid_from),
          validUntil: toNullableIso(row.valid_until),
        }));
      });
    },

    async createFact(context: RequestContext, input: CreateClaimFactInput): Promise<ClaimFactView> {
      return tenant(context, async (transaction) => {
        if (input.evidenceSourceIds.length === 0) {
          throw new RepositoryNotFoundError("At least one evidence source is required");
        }
        const evidenceIds = sql.join(input.evidenceSourceIds.map((id) => sql`${id}::uuid`));
        const evidenceCount = await sql<{ value: number }>`
          select count(*)::integer as value
          from geo.evidence_sources
          where id in (${evidenceIds})
        `.execute(transaction);
        if (evidenceCount.rows[0]?.value !== input.evidenceSourceIds.length) {
          throw new RepositoryNotFoundError("One or more evidence sources were not found");
        }
        const evidenceRefs = jsonText(input.evidenceSourceIds);
        const result = await sql<{
          id: string;
          brand_id: string;
          normalized_key: string;
          claim: string;
          status: ClaimFactView["status"];
          evidence_refs: unknown;
          valid_from: Date;
          valid_until: Date | null;
        }>`
          insert into geo.claim_facts (
            tenant_id, id, brand_id, normalized_key, claim, status,
            evidence_refs, valid_from, valid_until
          ) values (
            ${context.tenantId}, ${input.id}, ${input.brandId}, ${input.normalizedKey},
            ${input.claim}, ${input.status}, ${evidenceRefs}::jsonb,
            ${input.validFrom}, ${input.validUntil}
          )
          returning id, brand_id, normalized_key, claim, status,
                    evidence_refs, valid_from, valid_until
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          throw new RepositoryConflictError("Claim fact was not created");
        }
        return {
          id: row.id,
          brandId: row.brand_id,
          normalizedKey: row.normalized_key,
          claim: row.claim,
          status: row.status,
          evidenceSourceIds: stringArray(row.evidence_refs),
          validFrom: toIso(row.valid_from),
          validUntil: toNullableIso(row.valid_until),
        };
      });
    },

    async checkResourceScope(
      context: RequestContext,
      resources: readonly ResourceScopeRef[],
    ): Promise<ResourceScopeResult> {
      return tenant(context, async (transaction) => {
        const denied: ResourceScopeRef[] = [];
        for (const resource of resources) {
          if (!(await resourceExists(transaction, resource))) denied.push(resource);
        }
        return { allowed: denied.length === 0, denied };
      });
    },

    async listCampaigns(context: RequestContext): Promise<readonly CampaignView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          brand_id: string;
          name: string;
          objective: string;
          industry: string;
          status: string;
          topic_key: string;
        }>`
          select id, brand_id, name, objective, industry, status, topic_key
          from geo.campaigns order by created_at desc
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          brandId: row.brand_id,
          name: row.name,
          objective: row.objective,
          industry: row.industry,
          status: row.status,
          topicKey: row.topic_key,
        }));
      });
    },

    async createCampaign(
      context: RequestContext,
      input: CreateCampaignInput,
    ): Promise<CampaignView> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          brand_id: string;
          name: string;
          objective: string;
          industry: string;
          status: string;
          topic_key: string;
        }>`
          insert into geo.campaigns (
            tenant_id, id, brand_id, name, objective, industry, topic_key
          ) values (
            ${context.tenantId}, ${input.id}, ${input.brandId}, ${input.name},
            ${input.objective}, ${input.industry}, ${input.topicKey}
          )
          returning id, brand_id, name, objective, industry, status, topic_key
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          throw new RepositoryConflictError("Campaign was not created");
        }
        return {
          id: row.id,
          brandId: row.brand_id,
          name: row.name,
          objective: row.objective,
          industry: row.industry,
          status: row.status,
          topicKey: row.topic_key,
        };
      });
    },

    async listContent(context: RequestContext): Promise<readonly ContentView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          campaign_id: string;
          brand_id: string;
          title: string;
          content_type: string;
          state: string;
          topic_key: string;
          latest_version: number | null;
          latest_version_id: string | null;
        }>`
          select items.id, items.campaign_id, items.brand_id, items.title, items.content_type,
                 items.state, items.topic_key, latest.version as latest_version,
                 latest.id as latest_version_id
          from geo.content_items as items
          left join lateral (
            select versions.id, versions.version
            from geo.content_versions as versions
            where versions.content_item_id = items.id
            order by versions.version desc
            limit 1
          ) as latest on true
          order by items.created_at desc
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          brandId: row.brand_id,
          title: row.title,
          contentType: row.content_type,
          state: row.state,
          topicKey: row.topic_key,
          latestVersion: row.latest_version,
          latestVersionId: row.latest_version_id,
        }));
      });
    },

    async createContent(context: RequestContext, input: CreateContentInput): Promise<ContentView> {
      return tenant(context, async (transaction) => {
        await sql`
          insert into geo.content_items (
            tenant_id, id, campaign_id, brand_id, title, content_type, topic_key
          ) values (
            ${context.tenantId}, ${input.contentId}, ${input.campaignId}, ${input.brandId},
            ${input.title}, ${input.contentType}, ${input.topicKey}
          )
        `.execute(transaction);
        const payloadJson = jsonText(input.payload);
        await sql`
          insert into geo.content_versions (
            tenant_id, id, content_item_id, version, summary, body_markdown,
            payload, payload_hash, created_by_actor_id
          ) values (
            ${context.tenantId}, ${input.versionId}, ${input.contentId}, 1, ${input.summary},
            ${input.bodyMarkdown}, ${payloadJson}::jsonb, ${input.payloadHash}, ${context.actorId}
          )
        `.execute(transaction);
        return {
          id: input.contentId,
          campaignId: input.campaignId,
          brandId: input.brandId,
          title: input.title,
          contentType: input.contentType,
          state: "draft",
          topicKey: input.topicKey,
          latestVersion: 1,
          latestVersionId: input.versionId,
        };
      });
    },

    async createContentVersion(
      context: RequestContext,
      input: CreateContentVersionInput,
    ): Promise<ContentView> {
      return tenant(context, async (transaction) => {
        const itemResult = await sql<{
          id: string;
          campaign_id: string;
          brand_id: string;
          title: string;
          content_type: string;
          topic_key: string;
        }>`
          select id, campaign_id, brand_id, title, content_type, topic_key
          from geo.content_items
          where id = ${input.contentItemId}
          for update
        `.execute(transaction);
        const item = itemResult.rows[0];
        if (item === undefined) {
          throw new RepositoryNotFoundError("Content item was not found");
        }
        const versionResult = await sql<{ value: number }>`
          select (coalesce(max(version), 0) + 1)::integer as value
          from geo.content_versions
          where content_item_id = ${input.contentItemId}
        `.execute(transaction);
        const version = versionResult.rows[0]?.value ?? 1;
        const payloadJson = jsonText(input.payload);
        await sql`
          insert into geo.content_versions (
            tenant_id, id, content_item_id, version, summary, body_markdown,
            payload, payload_hash, created_by_actor_id
          ) values (
            ${context.tenantId}, ${input.versionId}, ${input.contentItemId}, ${version},
            ${input.summary}, ${input.bodyMarkdown}, ${payloadJson}::jsonb,
            ${input.payloadHash}, ${context.actorId}
          )
        `.execute(transaction);
        await sql`
          update geo.content_items
          set state = 'draft', updated_at = clock_timestamp()
          where id = ${input.contentItemId}
        `.execute(transaction);
        return {
          id: item.id,
          campaignId: item.campaign_id,
          brandId: item.brand_id,
          title: item.title,
          contentType: item.content_type,
          state: "draft",
          topicKey: item.topic_key,
          latestVersion: version,
          latestVersionId: input.versionId,
        };
      });
    },

    async getContentVersion(
      context: RequestContext,
      contentVersionId: string,
    ): Promise<ContentVersionView | null> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          content_item_id: string;
          version: number;
          summary: string;
          body_markdown: string;
          payload: unknown;
          payload_hash: string;
          frozen_at: Date | null;
        }>`
          select id, content_item_id, version, summary, body_markdown,
                 payload, payload_hash, frozen_at
          from geo.content_versions
          where id = ${contentVersionId}
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) return null;
        return {
          id: row.id,
          contentItemId: row.content_item_id,
          version: row.version,
          summary: row.summary,
          bodyMarkdown: row.body_markdown,
          payload: publicationVariantPayloadSchema.parse(row.payload),
          payloadHash: row.payload_hash,
          frozenAt: toNullableIso(row.frozen_at),
        };
      });
    },

    async listVariants(
      context: RequestContext,
      contentItemId: string,
    ): Promise<readonly VariantView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          content_version_id: string;
          brand_id: string;
          channel_account_id: string;
          platform: VariantView["platform"];
          variant_version: number;
          payload: unknown;
          payload_hash: string;
          state: string;
          frozen_at: Date | null;
        }>`
          select variants.id, variants.content_version_id, variants.channel_account_id,
                 variants.platform, variants.variant_version, variants.payload,
                 variants.payload_hash, variants.state, variants.frozen_at
          from geo.publication_variants as variants
          join geo.content_versions as versions on versions.id = variants.content_version_id
          where versions.content_item_id = ${contentItemId}
          order by variants.created_at desc
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          contentVersionId: row.content_version_id,
          channelAccountId: row.channel_account_id,
          platform: row.platform,
          variantVersion: row.variant_version,
          payload: row.payload,
          payloadHash: row.payload_hash,
          state: row.state,
          frozenAt: toNullableIso(row.frozen_at),
        }));
      });
    },

    async createVariant(context: RequestContext, input: CreateVariantInput): Promise<VariantView> {
      return tenant(context, async (transaction) => {
        const account = await sql<{ platform: VariantView["platform"] }>`
          select platform from geo.channel_accounts
          where id = ${input.channelAccountId} and status = 'active'
        `.execute(transaction);
        const version = await sql<{ id: string }>`
          select id from geo.content_versions
          where id = ${input.contentVersionId}
            and content_item_id = ${input.contentItemId}
        `.execute(transaction);
        const accountRow = account.rows[0];
        const versionRow = version.rows[0];
        if (accountRow === undefined || versionRow === undefined) {
          throw new RepositoryNotFoundError("Content version or channel account was not found");
        }
        const nextVersion = await sql<{ value: number }>`
          select (coalesce(max(variant_version), 0) + 1)::integer as value
          from geo.publication_variants
          where content_version_id = ${versionRow.id}
            and channel_account_id = ${input.channelAccountId}
        `.execute(transaction);
        const variantVersion = nextVersion.rows[0]?.value ?? 1;
        const payloadJson = jsonText(input.payload);
        await sql`
          insert into geo.publication_variants (
            tenant_id, id, content_version_id, channel_account_id, platform,
            variant_version, payload, payload_hash
          ) values (
            ${context.tenantId}, ${input.variantId}, ${versionRow.id}, ${input.channelAccountId},
            ${accountRow.platform}, ${variantVersion}, ${payloadJson}::jsonb, ${input.payloadHash}
          )
        `.execute(transaction);
        return {
          id: input.variantId,
          contentVersionId: versionRow.id,
          channelAccountId: input.channelAccountId,
          platform: accountRow.platform,
          variantVersion,
          payload: input.payload,
          payloadHash: input.payloadHash,
          state: "draft",
          frozenAt: null,
        };
      });
    },

    async loadAuditContext(
      context: RequestContext,
      variantId: string,
      capturedAt: string,
    ): Promise<AuditContextRecord | null> {
      return tenant(context, async (transaction) => {
        const variantResult = await sql<{
          id: string;
          content_version_id: string;
          brand_id: string;
          channel_account_id: string;
          platform: VariantView["platform"];
          variant_version: number;
          payload: unknown;
          payload_hash: string;
          state: string;
          frozen_at: Date | null;
        }>`
          select variant.id, variant.content_version_id, content.brand_id,
                 variant.channel_account_id, variant.platform, variant.variant_version,
                 variant.payload, variant.payload_hash, variant.state, variant.frozen_at
          from geo.publication_variants as variant
          join geo.content_versions as version on version.id = variant.content_version_id
          join geo.content_items as content on content.id = version.content_item_id
          where variant.id = ${variantId}
        `.execute(transaction);
        const variantRow = variantResult.rows[0];
        if (variantRow === undefined || variantRow.state === "superseded") {
          return null;
        }
        const policyResult = await sql<{ id: string; version: string }>`
          select id, version from geo.policy_bundles
          where status = 'active' and effective_at <= ${capturedAt}
          order by effective_at desc limit 1
        `.execute(transaction);
        const policy = policyResult.rows[0];
        if (policy === undefined) {
          throw new RepositoryNotFoundError("No active policy bundle was found");
        }
        const sourceResult = await sql<{
          id: string;
          source_url: string | null;
          content_hash: string;
          captured_at: Date;
          valid_until: Date | null;
        }>`
          select id, source_url, content_hash, captured_at, valid_until
          from geo.evidence_sources
          where content_text is not null
          order by captured_at desc
        `.execute(transaction);
        const factResult = await sql<{
          id: string;
          brand_id: string;
          claim: string;
          evidence_refs: unknown;
          valid_from: Date;
          valid_until: Date | null;
        }>`
          select id, brand_id, claim, evidence_refs, valid_from, valid_until
          from geo.claim_facts
          where status = 'verified'
          order by id
        `.execute(transaction);
        const priorResult = await sql<{
          id: string;
          platform: VariantView["platform"];
          payload_hash: string;
          payload: unknown;
        }>`
          select id, platform, payload_hash, payload
          from geo.publication_variants
          where id <> ${variantId}
            and platform = ${variantRow.platform}
            and state in ('frozen', 'superseded')
            and exists (
              select 1
              from geo.publication_jobs as job
              where job.tenant_id = geo.publication_variants.tenant_id
                and job.variant_id = geo.publication_variants.id
                and job.state = 'confirmed'
            )
          order by created_at desc limit 50
        `.execute(transaction);
        const priorVariants = priorResult.rows.flatMap((row) => {
          const payload = row.payload as Partial<PublicationVariantPayload>;
          return typeof payload.bodyMarkdown === "string"
            ? [
                {
                  variantId: row.id,
                  platform: row.platform,
                  payloadHash: row.payload_hash,
                  bodyMarkdown: payload.bodyMarkdown,
                },
              ]
            : [];
        });
        return {
          brandId: variantRow.brand_id,
          variant: {
            id: variantRow.id,
            contentVersionId: variantRow.content_version_id,
            channelAccountId: variantRow.channel_account_id,
            platform: variantRow.platform,
            variantVersion: variantRow.variant_version,
            payload: variantRow.payload,
            payloadHash: variantRow.payload_hash,
            state: variantRow.state,
            frozenAt: toNullableIso(variantRow.frozen_at),
          },
          contacts: await readContacts(transaction),
          factSnapshot: {
            tenantId: context.tenantId,
            capturedAt,
            facts: factResult.rows.map((row) => ({
              id: row.id,
              brandId: row.brand_id,
              text: row.claim,
              evidenceSourceIds: stringArray(row.evidence_refs),
              validFrom: toIso(row.valid_from),
              validUntil: toNullableIso(row.valid_until),
            })),
            sources: sourceResult.rows.map((row) => ({
              id: row.id,
              locator: row.source_url ?? `db:evidence_sources/${row.id}`,
              contentHash: row.content_hash,
              observedAt: toIso(row.captured_at),
              validUntil: toNullableIso(row.valid_until),
            })),
          },
          priorVariants,
          policyBundle: policy,
        };
      });
    },

    async findAuditByIdempotency(
      context: RequestContext,
      idempotencyKey: string,
      requestHash: string,
    ): Promise<PersistAuditResult | null> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          request_hash: string;
          response_resource_type: string;
          response_resource_id: string;
        }>`
          select request_hash, response_resource_type, response_resource_id
          from geo.idempotency_records
          where scope = 'audit_request'
            and idempotency_key = ${idempotencyKey}
            and expires_at > clock_timestamp()
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) return null;
        if (row.request_hash !== requestHash || row.response_resource_type !== "audit_artifact") {
          throw new RepositoryConflictError("Audit idempotency key conflicts with another request");
        }
        const persisted = await readPersistedAudit(transaction, row.response_resource_id, false);
        if (persisted === null) {
          throw new RepositoryConflictError("Audit idempotency record has no persisted artifact");
        }
        return persisted;
      });
    },

    async persistAudit(
      context: RequestContext,
      input: PersistAuditInput,
    ): Promise<PersistAuditResult> {
      return tenant(context, async (transaction) => {
        const lockKey = `${context.tenantId}:audit_request:${input.idempotencyKey}`;
        await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(
          transaction,
        );
        await sql`
          delete from geo.idempotency_records
          where scope = 'audit_request'
            and idempotency_key = ${input.idempotencyKey}
            and expires_at <= clock_timestamp()
        `.execute(transaction);
        const idempotencyResult = await sql<{
          request_hash: string;
          response_resource_type: string;
          response_resource_id: string;
        }>`
          select request_hash, response_resource_type, response_resource_id
          from geo.idempotency_records
          where scope = 'audit_request'
            and idempotency_key = ${input.idempotencyKey}
        `.execute(transaction);
        const idempotency = idempotencyResult.rows[0];
        if (idempotency !== undefined) {
          if (
            idempotency.request_hash !== input.requestHash ||
            idempotency.response_resource_type !== "audit_artifact"
          ) {
            throw new RepositoryConflictError(
              "Audit idempotency key conflicts with another request",
            );
          }
          const persisted = await readPersistedAudit(
            transaction,
            idempotency.response_resource_id,
            false,
          );
          if (persisted === null) {
            throw new RepositoryConflictError("Audit idempotency record has no persisted artifact");
          }
          return persisted;
        }

        const locked = await sql<{ state: string; payload_hash: string }>`
          select state, payload_hash from geo.publication_variants
          where id = ${input.artifact.variantId} for update
        `.execute(transaction);
        const variant = locked.rows[0];
        if (variant === undefined) {
          throw new RepositoryNotFoundError("Publication variant was not found");
        }
        if (variant.payload_hash !== input.artifact.payloadHash || variant.state === "superseded") {
          throw new RepositoryConflictError("Final publication variant changed during audit");
        }
        if (variant.state === "draft") {
          await sql`
            update geo.publication_variants
            set state = 'frozen', frozen_at = ${input.artifact.createdAt}
            where id = ${input.artifact.variantId} and state = 'draft'
          `.execute(transaction);
        }
        await sql`
          insert into geo.audit_runs (
            tenant_id, id, variant_id, policy_bundle_id, status,
            requested_by_actor_id, started_at, completed_at
          ) values (
            ${context.tenantId}, ${input.auditRunId}, ${input.artifact.variantId},
            ${input.policyBundleId}, ${input.artifact.status}, ${context.actorId},
            ${input.artifact.createdAt}, ${input.artifact.createdAt}
          )
        `.execute(transaction);
        const findingsJson = jsonText(input.artifact.findings);
        await sql`
          insert into geo.audit_artifacts (
            tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
            payload_hash, fact_snapshot_hash, policy_hash, policy_version, audit_hash,
            status, findings, created_at, expires_at
          ) values (
            ${context.tenantId}, ${input.artifact.id}, ${input.auditRunId},
            ${input.artifact.variantId}, ${input.artifact.channelAccountId},
            ${input.artifact.platform}, ${input.artifact.payloadHash},
            ${input.artifact.factSnapshotHash}, ${input.artifact.policyHash},
            ${input.artifact.policyVersion}, ${input.artifact.auditHash},
            ${input.artifact.status}, ${findingsJson}::jsonb,
            ${input.artifact.createdAt}, ${input.artifact.expiresAt}
          )
        `.execute(transaction);
        if (input.grant !== null) {
          await sql`
            insert into geo.publication_grants (
              tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
              payload_hash, audit_hash, token_hash, status, issued_at, expires_at
            ) values (
              ${context.tenantId}, ${input.grant.id}, ${input.artifact.id},
              ${input.grant.variantId}, ${input.grant.channelAccountId}, ${input.grant.platform},
              ${input.grant.payloadHash}, ${input.grant.auditHash}, ${input.grant.tokenHash},
              'issued', ${input.grant.issuedAt}, ${input.grant.expiresAt}
            )
          `.execute(transaction);
        }
        await sql`
          insert into geo.idempotency_records (
            tenant_id, scope, idempotency_key, request_hash,
            response_resource_type, response_resource_id, expires_at
          ) values (
            ${context.tenantId}, 'audit_request', ${input.idempotencyKey},
            ${input.requestHash}, 'audit_artifact', ${input.artifact.id},
            ${input.artifact.expiresAt}
          )
        `.execute(transaction);
        const details = jsonText({
          auditHash: input.artifact.auditHash,
          payloadHash: input.artifact.payloadHash,
          status: input.artifact.status,
          grantId: input.grant?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        });
        await sql`
          insert into geo.audit_log (
            tenant_id, id, actor_id, action, resource_type, resource_id,
            request_id, before_hash, after_hash, details
          ) values (
            ${context.tenantId}, gen_random_uuid(), ${context.actorId}, 'audit.completed',
            'audit_artifact', ${input.artifact.id}, ${context.requestId}, null,
            ${input.artifact.auditHash}, ${details}::jsonb
          )
        `.execute(transaction);
        return { artifact: input.artifact, grant: input.grant, wasCreated: true };
      });
    },

    async getAudit(context: RequestContext, artifactId: string) {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          tenant_id: string;
          variant_id: string;
          channel_account_id: string;
          platform: VariantView["platform"];
          payload_hash: string;
          fact_snapshot_hash: string;
          policy_hash: string;
          policy_version: string;
          audit_hash: string;
          status: "passed" | "failed" | "errored";
          findings: unknown;
          created_at: Date;
          expires_at: Date;
        }>`
          select id, tenant_id, variant_id, channel_account_id, platform, payload_hash,
                 fact_snapshot_hash, policy_hash, policy_version, audit_hash, status,
                 findings, created_at, expires_at
          from geo.audit_artifacts where id = ${artifactId}
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }
        return auditArtifactSchema.parse({
          id: row.id,
          tenantId: row.tenant_id,
          variantId: row.variant_id,
          channelAccountId: row.channel_account_id,
          platform: row.platform,
          payloadHash: row.payload_hash,
          factSnapshotHash: row.fact_snapshot_hash,
          policyHash: row.policy_hash,
          policyVersion: row.policy_version,
          auditHash: row.audit_hash,
          status: row.status,
          findings: row.findings,
          createdAt: toIso(row.created_at),
          expiresAt: toIso(row.expires_at),
        });
      });
    },

    async consumePublicationGrant(
      context: RequestContext,
      input: PublicationRequestInput,
    ): Promise<PublicationRequestResult> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          publication_job_id: string;
          publication_outbox_event_id: string;
          was_created: boolean;
        }>`
          select * from geo.consume_publication_grant(
            ${input.grantId}, ${input.tokenHash}, ${input.idempotencyKey},
            ${input.requestHash}, ${input.executionLevel}
          )
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) {
          throw new RepositoryConflictError("Publication grant was not consumed");
        }
        return {
          publicationJobId: row.publication_job_id,
          publicationOutboxEventId: row.publication_outbox_event_id,
          wasCreated: row.was_created,
        };
      });
    },

    async recordPublicationGovernanceDecision(context, input): Promise<void> {
      await tenant(context, async (transaction) => {
        const details = jsonText({
          decisionId: input.decisionId,
          executionLevel: input.executionLevel,
          allowed: input.allowed,
          reason: input.reason,
          evidenceHash: input.evidenceHash,
          requestHash: input.requestHash,
        });
        await sql`
          insert into geo.audit_log (
            tenant_id, id, actor_id, action, resource_type, resource_id,
            request_id, after_hash, details
          ) values (
            ${context.tenantId}, ${input.decisionId}, ${context.actorId},
            ${input.allowed ? "publication.governance_allowed" : "publication.governance_denied"},
            'publication_grant', ${input.grantId}, ${context.requestId},
            ${input.evidenceHash}, ${details}::jsonb
          )
        `.execute(transaction);
      });
    },

    async listPublicationJobs(context: RequestContext): Promise<readonly PublicationJobView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          variant_id: string;
          platform: PublicationJobView["platform"];
          execution_level: PublicationJobView["executionLevel"];
          state: PublicationJobView["state"];
          payload_hash: string;
          created_at: Date;
          updated_at: Date;
        }>`
          select id, variant_id, platform, execution_level, state, payload_hash,
                 created_at, updated_at
          from geo.publication_jobs order by created_at desc limit 200
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          variantId: row.variant_id,
          platform: row.platform,
          executionLevel: row.execution_level,
          state: row.state,
          payloadHash: row.payload_hash,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        }));
      });
    },

    async listPublicationReceipts(
      context: RequestContext,
    ): Promise<readonly PublicationReceiptView[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          id: string;
          job_id: string;
          platform: PublicationReceiptView["platform"];
          execution_level: PublicationReceiptView["executionLevel"];
          evidence_type: PublicationReceiptView["evidenceType"];
          external_url: string | null;
          confirmed: boolean;
          recorded_at: Date;
        }>`
          select id, job_id, platform, execution_level, evidence_type, external_url,
                 confirmed, recorded_at
          from geo.publication_receipts order by recorded_at desc limit 200
        `.execute(transaction);
        return result.rows.map((row) => ({
          id: row.id,
          jobId: row.job_id,
          platform: row.platform,
          executionLevel: row.execution_level,
          evidenceType: row.evidence_type,
          externalUrl: row.external_url,
          confirmed: row.confirmed,
          recordedAt: toIso(row.recorded_at),
        }));
      });
    },

    async findVisibilityRunByIdempotency(
      context: RequestContext,
      idempotencyKey: string,
      requestHash: string,
    ): Promise<string | null> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          request_hash: string;
          response_resource_type: string;
          response_resource_id: string;
        }>`
          select request_hash, response_resource_type, response_resource_id
          from geo.idempotency_records
          where scope = 'visibility_run'
            and idempotency_key = ${idempotencyKey}
            and expires_at > clock_timestamp()
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) return null;
        if (row.request_hash !== requestHash || row.response_resource_type !== "visibility_run") {
          throw new RepositoryConflictError(
            "Visibility idempotency key conflicts with another request",
          );
        }
        return row.response_resource_id;
      });
    },

    async loadVisibilityRunContext(
      context: RequestContext,
      querySetVersionId: string,
    ): Promise<VisibilityRunContextRecord | null> {
      return tenant(context, async (transaction) => {
        const querySetResult = await sql<{
          id: string;
          version: number;
          prompts: unknown;
        }>`
          select versions.id, versions.version, versions.prompts
          from geo.query_set_versions as versions
          join geo.query_sets as sets on sets.id = versions.query_set_id
          where versions.id = ${querySetVersionId} and sets.status = 'active'
        `.execute(transaction);
        const querySet = querySetResult.rows[0];
        if (querySet === undefined) return null;
        const brandResult = await sql<{
          canonical_name: string;
          display_name: string;
          aliases: unknown;
        }>`
          select canonical_name, display_name, aliases
          from geo.brands
          order by is_primary desc, created_at
        `.execute(transaction);
        const contactResult = await sql<{ value: string }>`
          select value from geo.tenant_contacts
          where valid_from <= clock_timestamp()
            and (valid_until is null or valid_until > clock_timestamp())
          order by is_primary desc, type, value
        `.execute(transaction);
        const evidenceResult = await sql<{ source_url: string }>`
          select source_url from geo.evidence_sources
          where source_url is not null
            and (valid_until is null or valid_until > clock_timestamp())
          order by captured_at desc limit 20
        `.execute(transaction);
        const brandNames = new Set<string>();
        for (const brand of brandResult.rows) {
          brandNames.add(brand.canonical_name);
          brandNames.add(brand.display_name);
          for (const alias of stringArray(brand.aliases)) brandNames.add(alias);
        }
        return {
          querySetVersionId: querySet.id,
          querySetVersion: querySet.version,
          prompts: querySet.prompts,
          brandNames: [...brandNames],
          expectedContacts: contactResult.rows.map((row) => row.value),
          evidenceUrls: evidenceResult.rows.map((row) => row.source_url),
        };
      });
    },

    async persistVisibilityRun(
      context: RequestContext,
      input: PersistVisibilityRunInput,
    ): Promise<void> {
      await tenant(context, async (transaction) => {
        const metadata = jsonText({
          evidenceMode: input.observationMethod,
          idempotencyKey: input.idempotencyKey,
          sampleCount: input.observations.length,
        });
        await sql`
          insert into geo.visibility_runs (
            tenant_id, id, query_set_version_id, provider, product_surface,
            model, search_mode, observation_method, status, locale, geo,
            started_at, completed_at, created_by_actor_id, metadata
          ) values (
            ${context.tenantId}, ${input.runId}, ${input.querySetVersionId},
            ${input.provider}, ${input.productSurface}, ${input.model},
            ${input.searchMode}, ${input.observationMethod}, 'completed',
            ${input.locale}, ${input.geo}, ${input.completedAt}, ${input.completedAt},
            ${context.actorId}, ${metadata}::jsonb
          )
        `.execute(transaction);
        for (const observation of input.observations) {
          if (
            observation.tenantId !== context.tenantId ||
            observation.runId !== input.runId ||
            observation.provider !== input.provider
          ) {
            throw new RepositoryConflictError("Visibility observation scope mismatch");
          }
          const citedUrls = jsonText(observation.citedUrls);
          const competitors = jsonText(observation.competitorMentions);
          await sql`
            insert into geo.visibility_observations (
              tenant_id, id, run_id, provider, product_surface, model,
              search_mode, observation_method, prompt, prompt_version,
              locale, geo, raw_answer, cited_urls, evidence_hash, evidence_type,
              observed_at, brand_mentioned, answer_position, contact_accuracy,
              competitor_mentions, harmful_error, extractor_version, metadata
            ) values (
              ${context.tenantId}, ${observation.id}, ${input.runId},
              ${observation.provider}, ${observation.productSurface}, ${observation.model},
              ${observation.searchMode}, ${observation.observationMethod},
              ${observation.prompt}, ${observation.promptVersion}, ${observation.locale},
              ${observation.geo}, ${observation.rawAnswer}, ${citedUrls}::jsonb,
              ${observation.evidenceHash}, ${observation.evidenceType},
              ${observation.observedAt}, ${observation.brandMentioned},
              ${observation.answerPosition}, ${observation.contactAccuracy},
              ${competitors}::jsonb, ${observation.harmfulError},
              'geo-visibility-v1', ${metadata}::jsonb
            )
          `.execute(transaction);
        }
        for (const [metricName, value] of Object.entries(input.metrics)) {
          const confidenceLow =
            metricName === "brandMentionRate"
              ? (input.metrics.brandMentionWilsonLow ?? null)
              : null;
          const confidenceHigh =
            metricName === "brandMentionRate"
              ? (input.metrics.brandMentionWilsonHigh ?? null)
              : null;
          await sql`
            insert into geo.visibility_metrics (
              tenant_id, run_id, metric_name, value, sample_count,
              confidence_low, confidence_high, dimensions
            ) values (
              ${context.tenantId}, ${input.runId}, ${metricName}, ${value},
              ${input.observations.length}, ${confidenceLow}, ${confidenceHigh},
              ${jsonText({ provider: input.provider, evidenceMode: input.observationMethod })}::jsonb
            )
          `.execute(transaction);
        }
        await sql`
          insert into geo.idempotency_records (
            tenant_id, scope, idempotency_key, request_hash,
            response_resource_type, response_resource_id, expires_at
          ) values (
            ${context.tenantId}, 'visibility_run', ${input.idempotencyKey},
            ${input.requestHash}, 'visibility_run', ${input.runId},
            clock_timestamp() + interval '30 days'
          )
        `.execute(transaction);
        if (input.openCircuit && input.observationMethod !== "fixture") {
          await sql`
            insert into geo.circuit_breakers (
              tenant_id, scope_type, scope_key, state, failure_count,
              opened_at, retry_at, reason
            ) values (
              ${context.tenantId}, 'tenant', '*', 'open', 1,
              ${input.completedAt}, ${input.completedAt}::timestamptz + interval '1 hour',
              'AI visibility harmful-error or contact-accuracy threshold breached'
            )
            on conflict (tenant_id, scope_type, scope_key) do update set
              state = 'open',
              failure_count = geo.circuit_breakers.failure_count + 1,
              opened_at = excluded.opened_at,
              retry_at = excluded.retry_at,
              reason = excluded.reason,
              updated_at = clock_timestamp()
          `.execute(transaction);
        }
      });
    },

    async getVisibilitySummary(
      context: RequestContext,
      options: { readonly includeFixture: boolean },
    ): Promise<readonly VisibilityProviderSummary[]> {
      return tenant(context, async (transaction) => {
        const result = await sql<{
          provider: VisibilityProviderSummary["provider"];
          product_surface: string;
          model: string;
          search_mode: VisibilityProviderSummary["searchMode"];
          observation_method: VisibilityProviderSummary["observationMethod"];
          evidence_type: VisibilityProviderSummary["evidenceType"];
          observations: number;
          brand_mention_rate: number;
          contact_accuracy: number;
          harmful_errors: number;
        }>`
          select provider, product_surface, model, search_mode, observation_method, evidence_type,
                 count(*)::integer as observations,
                 coalesce(avg(case when brand_mentioned then 1.0 else 0.0 end), 0)::float8
                   as brand_mention_rate,
                 coalesce(avg(contact_accuracy), 0)::float8 as contact_accuracy,
                 count(*) filter (where harmful_error)::integer as harmful_errors
          from geo.visibility_observations
          where (${options.includeFixture} or observation_method <> 'fixture')
          group by provider, product_surface, model, search_mode, observation_method, evidence_type
          order by provider, observation_method, product_surface, model, search_mode, evidence_type
        `.execute(transaction);
        return result.rows.map((row) => ({
          provider: row.provider,
          productSurface: row.product_surface,
          model: row.model,
          searchMode: row.search_mode,
          observationMethod: row.observation_method,
          evidenceType: row.evidence_type,
          observations: row.observations,
          brandMentionRate: row.brand_mention_rate,
          contactAccuracy: row.contact_accuracy,
          harmfulErrors: row.harmful_errors,
        }));
      });
    },
  };
}
