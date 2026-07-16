import {
  automationProducerCapabilities,
  capabilitiesForRole,
  ctripBridgeCapabilities,
} from "@geo/authz";
import {
  capabilitySchema,
  tenantContactSchema,
  type Capability,
  type TenantContact,
} from "@geo/contracts";
import { compileAuditPolicy, geoAuditPolicyDocumentSchema, sha256Canonical } from "@geo/core";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";

import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApiRepository,
  type ChannelAccountView,
  type PolicyBundleView,
  type RequestContext,
  type ServicePrincipalView,
  type TenantMemberView,
} from "./repository.js";
import {
  assertMemberManagementAllowed,
  assertPolicyTransitionAllowed,
  TenantGovernanceInvariantError,
  validateEffectiveChannelAccount,
} from "./tenant-governance.js";

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

function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

async function tenant<T>(
  database: Kysely<Database>,
  context: RequestContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(database, context, async (transaction) => {
    await sql`set local role geo_runtime`.execute(transaction);
    return operation(transaction);
  });
}

interface MemberRow {
  readonly id: string;
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: TenantMemberView["role"];
  readonly capabilities: unknown;
  readonly status: TenantMemberView["status"];
  readonly created_at: Date;
}

function memberView(row: MemberRow): TenantMemberView {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    capabilities: capabilityArray(row.capabilities),
    status: row.status,
    createdAt: toIso(row.created_at),
  };
}

interface PolicyRow {
  readonly id: string;
  readonly version: string;
  readonly status: PolicyBundleView["status"];
  readonly policy_hash: string;
  readonly document: unknown;
  readonly effective_at: Date;
  readonly retired_at: Date | null;
  readonly created_at: Date;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function policyView(row: PolicyRow): PolicyBundleView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    policyHash: row.policy_hash,
    document: objectRecord(row.document),
    effectiveAt: toIso(row.effective_at),
    retiredAt: toNullableIso(row.retired_at),
    createdAt: toIso(row.created_at),
  };
}

interface AccountRow {
  readonly id: string;
  readonly platform: ChannelAccountView["platform"];
  readonly display_name: string;
  readonly capability: ChannelAccountView["capability"];
  readonly supported_execution_levels: string[];
  readonly credential_ref: string | null;
  readonly capability_evidence_type: ChannelAccountView["evidenceType"];
  readonly capability_evidence_refs: unknown;
  readonly status: string;
  readonly last_verified_at: Date | null;
}

function accountView(row: AccountRow): ChannelAccountView {
  return {
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
  };
}

function assertAccountEvidence(input: {
  readonly capability: ChannelAccountView["capability"];
  readonly supportedExecutionLevels: ChannelAccountView["supportedExecutionLevels"];
  readonly credentialRef: string | null;
  readonly evidenceType: ChannelAccountView["evidenceType"];
  readonly evidenceRefs: readonly string[];
  readonly status: string;
  readonly lastVerifiedAt: string | null;
}): void {
  validateEffectiveChannelAccount(input);
  if (
    input.status === "active" &&
    (input.lastVerifiedAt === null || input.evidenceRefs.length === 0)
  ) {
    throw new RepositoryConflictError(
      "An active channel account requires capability evidence and a verification timestamp",
    );
  }
  if (
    input.supportedExecutionLevels.includes("unattended") &&
    (input.credentialRef === null ||
      !["api_response", "platform_readback"].includes(input.evidenceType))
  ) {
    throw new RepositoryConflictError(
      "Unattended execution requires a credential reference and API or readback evidence",
    );
  }
}

interface ServicePrincipalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly kind: ServicePrincipalView["kind"];
  readonly profile: ServicePrincipalView["profile"];
  readonly capabilities: unknown;
  readonly status: ServicePrincipalView["status"];
  readonly credential_status: ServicePrincipalView["credentialStatus"];
  readonly last_used_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function servicePrincipalView(row: ServicePrincipalRow): ServicePrincipalView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    profile: row.profile,
    capabilities: capabilityArray(row.capabilities),
    status: row.status,
    credentialStatus: row.credential_status,
    lastUsedAt: toNullableIso(row.last_used_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const servicePrincipalSelect = sql.raw(`
  principal.id, principal.tenant_id, principal.name, principal.kind,
  principal.profile, principal.capabilities, principal.status,
  case
    when exists (
      select 1 from geo.api_keys as api_key
      where api_key.tenant_id = principal.tenant_id
        and api_key.service_principal_id = principal.id
        and api_key.revoked_at is null
        and (api_key.expires_at is null or api_key.expires_at > clock_timestamp())
    ) then 'active'
    when exists (
      select 1 from geo.api_keys as api_key
      where api_key.tenant_id = principal.tenant_id
        and api_key.service_principal_id = principal.id
        and api_key.revoked_at is not null
    ) then 'revoked'
    when exists (
      select 1 from geo.api_keys as api_key
      where api_key.tenant_id = principal.tenant_id
        and api_key.service_principal_id = principal.id
    ) then 'expired'
    else 'not_issued'
  end as credential_status,
  principal.last_used_at, principal.created_at, principal.updated_at
`);

async function insertAudit(
  transaction: TenantTransaction,
  context: RequestContext,
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
      ${sha256Canonical(input.after)}, ${jsonText(input.details)}::jsonb
    )
  `.execute(transaction);
}

export function createPostgresTenantGovernanceRepository(runtimeDatabase: Kysely<Database>) {
  return {
    async createContact(
      context: RequestContext,
      input: Parameters<ApiRepository["createContact"]>[1],
    ): Promise<TenantContact> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        try {
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
            insert into geo.tenant_contacts (
              tenant_id, id, type, label, value, normalized_value,
              is_primary, valid_from, metadata
            ) values (
              ${context.tenantId}, ${input.id}, ${input.type}, ${input.label},
              ${input.value}, ${input.normalizedValue}, ${input.isPrimary}, ${input.validFrom},
              ${jsonText({ source: "tenant-management-api", requestId: context.requestId })}::jsonb
            )
            returning id, tenant_id, type, label, value, is_primary, valid_from, valid_until
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) throw new RepositoryConflictError("Contact was not created");
          const contact = tenantContactSchema.parse({
            id: row.id,
            tenantId: row.tenant_id,
            type: row.type,
            label: row.label,
            value: row.value,
            isPrimary: row.is_primary,
            validFrom: toIso(row.valid_from),
            validUntil: toNullableIso(row.valid_until),
          });
          await insertAudit(transaction, context, {
            action: "tenant_contact.created",
            resourceType: "tenant_contact",
            resourceId: contact.id,
            before: null,
            after: contact,
            details: { type: contact.type, label: contact.label, isPrimary: contact.isPrimary },
          });
          return contact;
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError(
              input.isPrimary
                ? "A current primary contact already exists for this type"
                : "The contact already exists",
            );
          }
          throw error;
        }
      });
    },

    async expireContact(
      context: RequestContext,
      input: Parameters<ApiRepository["expireContact"]>[1],
    ): Promise<TenantContact> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const currentResult = await sql<{
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
          from geo.tenant_contacts where id = ${input.contactId} for update
        `.execute(transaction);
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined) throw new RepositoryNotFoundError("Contact was not found");
        const before = tenantContactSchema.parse({
          id: currentRow.id,
          tenantId: currentRow.tenant_id,
          type: currentRow.type,
          label: currentRow.label,
          value: currentRow.value,
          isPrimary: currentRow.is_primary,
          validFrom: toIso(currentRow.valid_from),
          validUntil: toNullableIso(currentRow.valid_until),
        });
        if (before.validUntil !== null) return before;
        if (Date.parse(input.validUntil) <= Date.parse(before.validFrom)) {
          throw new RepositoryConflictError("Contact expiry must be after its validity start");
        }
        const result = await sql<typeof currentRow>`
          update geo.tenant_contacts set valid_until = ${input.validUntil}
          where id = ${input.contactId} and valid_until is null
          returning id, tenant_id, type, label, value, is_primary, valid_from, valid_until
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined)
          throw new RepositoryConflictError("Contact was concurrently changed");
        const contact = tenantContactSchema.parse({
          id: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          label: row.label,
          value: row.value,
          isPrimary: row.is_primary,
          validFrom: toIso(row.valid_from),
          validUntil: toNullableIso(row.valid_until),
        });
        await insertAudit(transaction, context, {
          action: "tenant_contact.expired",
          resourceType: "tenant_contact",
          resourceId: contact.id,
          before,
          after: contact,
          details: { reason: input.reason, validUntil: contact.validUntil },
        });
        return contact;
      });
    },

    async createMember(
      context: RequestContext,
      input: Parameters<ApiRepository["createMember"]>[1],
    ): Promise<TenantMemberView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const actorResult = await sql<{ role: TenantMemberView["role"] }>`
          select role from geo.tenant_memberships
          where user_id = ${context.actorId} and status = 'active' limit 1
        `.execute(transaction);
        const actorRole = actorResult.rows[0]?.role;
        if (actorRole === undefined)
          throw new RepositoryConflictError("Managing member is inactive");
        try {
          assertMemberManagementAllowed(actorRole, null, input.role);
        } catch (error) {
          if (error instanceof TenantGovernanceInvariantError) {
            throw new RepositoryConflictError(error.message);
          }
          throw error;
        }

        try {
          const result = await sql<MemberRow>`
            select membership_id as id, member_user_id as user_id,
                   member_email as email, member_display_name as display_name,
                   member_role as role, member_capabilities as capabilities,
                   member_status as status, member_created_at as created_at
            from geo.create_tenant_member_identity(
              ${input.membershipId}, ${input.userId}, ${input.email}, ${input.displayName},
              ${input.passwordHash}, ${input.role}
            )
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) throw new RepositoryConflictError("Member was not created");
          return memberView(row);
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError("User is already a member of this tenant");
          }
          if (["22023", "42501", "55000"].includes(sqlState(error) ?? "")) {
            throw new RepositoryConflictError(
              error instanceof Error ? error.message : "Member identity could not be created",
            );
          }
          throw error;
        }
      });
    },

    async updateMember(
      context: RequestContext,
      input: Parameters<ApiRepository["updateMember"]>[1],
    ): Promise<TenantMemberView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const actorResult = await sql<{ role: TenantMemberView["role"] }>`
          select role from geo.tenant_memberships
          where user_id = ${context.actorId} and status = 'active' limit 1
        `.execute(transaction);
        const actorRole = actorResult.rows[0]?.role;
        if (actorRole === undefined)
          throw new RepositoryConflictError("Managing member is inactive");
        const currentResult = await sql<MemberRow>`
          select membership_id as id, member_user_id as user_id,
                 member_email as email, member_display_name as display_name,
                 member_role as role, member_capabilities as capabilities,
                 member_status as status, member_created_at as created_at
          from geo.get_tenant_member_identity(${input.membershipId})
        `.execute(transaction);
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined) throw new RepositoryNotFoundError("Member was not found");
        const before = memberView(currentRow);
        const nextRole = input.role ?? before.role;
        const nextStatus = input.status ?? before.status;
        try {
          assertMemberManagementAllowed(actorRole, before.role, nextRole);
        } catch (error) {
          if (error instanceof TenantGovernanceInvariantError) {
            throw new RepositoryConflictError(error.message);
          }
          throw error;
        }
        if (before.role === nextRole && before.status === nextStatus) return before;

        if (
          before.role === "owner" &&
          before.status === "active" &&
          (nextRole !== "owner" || nextStatus !== "active")
        ) {
          const owners = await sql<{ id: string }>`
            select id from geo.tenant_memberships
            where role = 'owner' and status = 'active'
            order by id for update
          `.execute(transaction);
          if (owners.rows.length <= 1) {
            throw new RepositoryConflictError(
              "The last active owner cannot be demoted or suspended",
            );
          }
        }

        const updated = await sql<{ id: string }>`
          update geo.tenant_memberships
          set role = ${nextRole}, capabilities = ${jsonText(capabilitiesForRole(nextRole))}::jsonb,
              status = ${nextStatus}
          where id = ${input.membershipId}
          returning id
        `.execute(transaction);
        if (updated.rows[0] === undefined) {
          throw new RepositoryConflictError("Member was concurrently changed");
        }
        const result = await sql<MemberRow>`
          select membership_id as id, member_user_id as user_id,
                 member_email as email, member_display_name as display_name,
                 member_role as role, member_capabilities as capabilities,
                 member_status as status, member_created_at as created_at
          from geo.get_tenant_member_identity(${input.membershipId})
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new RepositoryConflictError("Member update was not readable");
        const member = memberView(row);
        await insertAudit(transaction, context, {
          action: "tenant_member.changed",
          resourceType: "tenant_membership",
          resourceId: member.id,
          before,
          after: member,
          details: {
            reason: input.reason,
            previousRole: before.role,
            role: member.role,
            previousStatus: before.status,
            status: member.status,
          },
        });
        return member;
      });
    },

    async transitionPolicyBundle(
      context: RequestContext,
      input: Parameters<ApiRepository["transitionPolicyBundle"]>[1],
    ) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const currentResult = await sql<PolicyRow>`
          select id, version, status, policy_hash, document, effective_at, retired_at, created_at
          from geo.policy_bundles where id = ${input.policyBundleId} for update
        `.execute(transaction);
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined)
          throw new RepositoryNotFoundError("Policy bundle was not found");
        const before = policyView(currentRow);
        let shouldChange: boolean;
        try {
          shouldChange = assertPolicyTransitionAllowed(before.status, input.targetStatus);
        } catch (error) {
          if (error instanceof TenantGovernanceInvariantError) {
            throw new RepositoryConflictError(error.message);
          }
          throw error;
        }
        if (!shouldChange)
          return { policy: before, previousStatus: before.status, wasChanged: false };

        let replacedPolicyIds: string[] = [];
        if (input.targetStatus === "active") {
          try {
            const document = geoAuditPolicyDocumentSchema.parse(before.document);
            if (
              document.rulesVersion !== before.version ||
              sha256Canonical(document) !== before.policyHash
            ) {
              throw new TenantGovernanceInvariantError(
                "Policy version or canonical hash does not match its document",
              );
            }
            compileAuditPolicy({
              version: before.version,
              policyHash: before.policyHash,
              document,
            });
          } catch (error) {
            throw new RepositoryConflictError(
              error instanceof Error
                ? `Policy cannot be activated: ${error.message}`
                : "Policy is invalid",
            );
          }
          const retired = await sql<{ id: string }>`
            update geo.policy_bundles
            set status = 'retired', retired_at = ${input.changedAt}
            where status = 'active' and id <> ${input.policyBundleId}
            returning id
          `.execute(transaction);
          replacedPolicyIds = retired.rows.map((row) => row.id);
        }
        const result = await sql<PolicyRow>`
          update geo.policy_bundles
          set status = ${input.targetStatus},
              effective_at = case
                when ${input.targetStatus}::text = 'active'
                then ${input.changedAt}::timestamptz
                else effective_at
              end,
              retired_at = case
                when ${input.targetStatus}::text = 'retired'
                then ${input.changedAt}::timestamptz
                else null::timestamptz
              end
          where id = ${input.policyBundleId}
          returning id, version, status, policy_hash, document, effective_at, retired_at, created_at
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined)
          throw new RepositoryConflictError("Policy bundle was concurrently changed");
        const policy = policyView(row);
        await insertAudit(transaction, context, {
          action: `policy_bundle.${input.targetStatus}`,
          resourceType: "policy_bundle",
          resourceId: policy.id,
          before,
          after: policy,
          details: {
            reason: input.reason,
            previousStatus: before.status,
            status: policy.status,
            replacedPolicyIds,
          },
        });
        return { policy, previousStatus: before.status, wasChanged: true };
      });
    },

    async createChannelAccount(
      context: RequestContext,
      input: Parameters<ApiRepository["createChannelAccount"]>[1],
    ): Promise<ChannelAccountView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        assertAccountEvidence(input);
        try {
          const result = await sql<AccountRow>`
            insert into geo.channel_accounts (
              tenant_id, id, platform, display_name, capability,
              supported_execution_levels, credential_ref, capability_evidence_type,
              capability_evidence_refs, status, last_verified_at
            ) values (
              ${context.tenantId}, ${input.id}, ${input.platform}, ${input.displayName},
              ${input.capability}, ${input.supportedExecutionLevels}::text[], ${input.credentialRef},
              ${input.evidenceType}, ${jsonText(input.evidenceRefs)}::jsonb,
              ${input.status}, ${input.lastVerifiedAt}
            )
            returning id, platform, display_name, capability, supported_execution_levels,
                      credential_ref, capability_evidence_type, capability_evidence_refs,
                      status, last_verified_at
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined)
            throw new RepositoryConflictError("Channel account was not created");
          const account = accountView(row);
          await insertAudit(transaction, context, {
            action: "channel_account.created",
            resourceType: "channel_account",
            resourceId: account.id,
            before: null,
            after: account,
            details: {
              platform: account.platform,
              capability: account.capability,
              status: account.status,
              hasCredentialRef: row.credential_ref !== null,
            },
          });
          return account;
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError("Channel account already exists");
          }
          throw error;
        }
      });
    },

    async updateChannelAccount(
      context: RequestContext,
      input: Parameters<ApiRepository["updateChannelAccount"]>[1],
    ): Promise<ChannelAccountView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const currentResult = await sql<AccountRow>`
          select id, platform, display_name, capability, supported_execution_levels,
                 credential_ref, capability_evidence_type, capability_evidence_refs,
                 status, last_verified_at
          from geo.channel_accounts where id = ${input.channelAccountId} for update
        `.execute(transaction);
        const current = currentResult.rows[0];
        if (current === undefined)
          throw new RepositoryNotFoundError("Channel account was not found");
        const before = accountView(current);
        const effective = {
          displayName: input.displayName ?? current.display_name,
          capability: input.capability ?? current.capability,
          supportedExecutionLevels:
            input.supportedExecutionLevels ??
            (current.supported_execution_levels as ChannelAccountView["supportedExecutionLevels"]),
          credentialRef:
            input.credentialRef === undefined ? current.credential_ref : input.credentialRef,
          evidenceType: input.evidenceType ?? current.capability_evidence_type,
          evidenceRefs: input.evidenceRefs ?? stringArray(current.capability_evidence_refs),
          status: input.status ?? current.status,
          lastVerifiedAt:
            input.lastVerifiedAt === undefined
              ? toNullableIso(current.last_verified_at)
              : input.lastVerifiedAt,
        };
        assertAccountEvidence(effective);
        try {
          const result = await sql<AccountRow>`
            update geo.channel_accounts
            set display_name = ${effective.displayName}, capability = ${effective.capability},
                supported_execution_levels = ${effective.supportedExecutionLevels}::text[],
                credential_ref = ${effective.credentialRef},
                capability_evidence_type = ${effective.evidenceType},
                capability_evidence_refs = ${jsonText(effective.evidenceRefs)}::jsonb,
                status = ${effective.status}, last_verified_at = ${effective.lastVerifiedAt}
            where id = ${input.channelAccountId}
            returning id, platform, display_name, capability, supported_execution_levels,
                      credential_ref, capability_evidence_type, capability_evidence_refs,
                      status, last_verified_at
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined)
            throw new RepositoryConflictError("Channel account was concurrently changed");
          const account = accountView(row);
          await insertAudit(transaction, context, {
            action: "channel_account.changed",
            resourceType: "channel_account",
            resourceId: account.id,
            before,
            after: account,
            details: {
              reason: input.reason,
              capability: account.capability,
              status: account.status,
              hasCredentialRef: row.credential_ref !== null,
            },
          });
          return account;
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError("Channel account name already exists");
          }
          throw error;
        }
      });
    },

    async listServicePrincipals(context: RequestContext): Promise<readonly ServicePrincipalView[]> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const result = await sql<ServicePrincipalRow>`
          select ${servicePrincipalSelect}
          from geo.service_principals as principal
          order by principal.created_at, principal.id
        `.execute(transaction);
        return result.rows.map(servicePrincipalView);
      });
    },

    async createAutomationServicePrincipal(
      context: RequestContext,
      input: Parameters<ApiRepository["createAutomationServicePrincipal"]>[1],
    ): Promise<ServicePrincipalView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        try {
          const result = await sql<ServicePrincipalRow>`
            insert into geo.service_principals (
              tenant_id, id, name, kind, profile, capabilities, status
            ) values (
              ${context.tenantId}, ${input.id}, ${input.name}, 'agent', 'automation_producer',
              ${jsonText(automationProducerCapabilities)}::jsonb, 'active'
            )
            returning id, tenant_id, name, kind, profile, capabilities, status,
                      'not_issued'::text as credential_status,
                      last_used_at, created_at, updated_at
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) {
            throw new RepositoryConflictError("Automation service principal was not created");
          }
          const principal = servicePrincipalView(row);
          await insertAudit(transaction, context, {
            action: "service_principal.created",
            resourceType: "service_principal",
            resourceId: principal.id,
            before: null,
            after: principal,
            details: {
              profile: principal.profile,
              capabilities: principal.capabilities,
              credentialIssued: false,
            },
          });
          return principal;
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError("Service principal name already exists");
          }
          throw error;
        }
      });
    },

    async createCtripBridgeServicePrincipal(
      context: RequestContext,
      input: Parameters<ApiRepository["createCtripBridgeServicePrincipal"]>[1],
    ): Promise<ServicePrincipalView> {
      return tenant(runtimeDatabase, context, async (transaction) => {
        try {
          const result = await sql<ServicePrincipalRow>`
            insert into geo.service_principals (
              tenant_id, id, name, kind, profile, capabilities, status
            ) values (
              ${context.tenantId}, ${input.id}, ${input.name}, 'integration', 'ctrip_bridge',
              ${jsonText(ctripBridgeCapabilities)}::jsonb, 'active'
            )
            returning id, tenant_id, name, kind, profile, capabilities, status,
                      'not_issued'::text as credential_status,
                      last_used_at, created_at, updated_at
          `.execute(transaction);
          const row = result.rows[0];
          if (row === undefined) {
            throw new RepositoryConflictError("Ctrip bridge service principal was not created");
          }
          const principal = servicePrincipalView(row);
          await insertAudit(transaction, context, {
            action: "service_principal.created",
            resourceType: "service_principal",
            resourceId: principal.id,
            before: null,
            after: principal,
            details: {
              profile: principal.profile,
              capabilities: principal.capabilities,
              credentialIssued: false,
            },
          });
          return principal;
        } catch (error) {
          if (error instanceof RepositoryConflictError) throw error;
          if (sqlState(error) === "23505") {
            throw new RepositoryConflictError("Service principal name already exists");
          }
          throw error;
        }
      });
    },

    async setServicePrincipalStatus(
      context: RequestContext,
      input: Parameters<ApiRepository["setServicePrincipalStatus"]>[1],
    ) {
      return tenant(runtimeDatabase, context, async (transaction) => {
        const currentResult = await sql<ServicePrincipalRow>`
          select ${servicePrincipalSelect}
          from geo.service_principals as principal
          where principal.id = ${input.servicePrincipalId}
          for update of principal
        `.execute(transaction);
        const row = currentResult.rows[0];
        if (row === undefined) throw new RepositoryNotFoundError("Service principal was not found");
        const before = servicePrincipalView(row);
        if (before.status === input.status) return { principal: before, wasChanged: false };

        await sql`
          update geo.service_principals set status = ${input.status}
          where id = ${input.servicePrincipalId}
        `.execute(transaction);
        if (input.status === "disabled") {
          await sql`
            update geo.api_keys set revoked_at = clock_timestamp()
            where service_principal_id = ${input.servicePrincipalId} and revoked_at is null
          `.execute(transaction);
        }
        const updatedResult = await sql<ServicePrincipalRow>`
          select ${servicePrincipalSelect}
          from geo.service_principals as principal
          where principal.id = ${input.servicePrincipalId}
        `.execute(transaction);
        const updated = updatedResult.rows[0];
        if (updated === undefined) {
          throw new RepositoryConflictError("Service principal was concurrently changed");
        }
        const principal = servicePrincipalView(updated);
        await insertAudit(transaction, context, {
          action: "service_principal.status_changed",
          resourceType: "service_principal",
          resourceId: principal.id,
          before,
          after: principal,
          details: {
            reason: input.reason,
            previousStatus: before.status,
            status: principal.status,
          },
        });
        return { principal, wasChanged: true };
      });
    },
  };
}
