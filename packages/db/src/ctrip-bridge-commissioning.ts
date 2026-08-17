import { randomUUID } from "node:crypto";

import { ctripBridgeCapabilities } from "@geo/authz";
import { sha256Canonical } from "@geo/core";
import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "./types.js";

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

export interface CommissionCtripBridgeInput {
  readonly tenantSlug: string;
  readonly operatorEmail: string;
  readonly idempotencyKey: string;
  readonly principalName: string;
}

export interface CommissionCtripBridgeEnvironment extends CommissionCtripBridgeInput {
  readonly connectionString: string;
}

export interface CommissionCtripBridgeResult {
  readonly tenantId: string;
  readonly ctripChannelAccountId: string;
  readonly bridgeServicePrincipalId: string;
  readonly wasCreated: boolean;
}

export interface CommissionCtripBridgeOutput extends CommissionCtripBridgeResult {
  readonly event: "ctrip_bridge_commissioning.completed";
}

export interface CommissionCtripBridgeOptions {
  /** Generates the principal, receipt, and audit UUIDs, in that order. */
  readonly idGenerator?: (() => string) | undefined;
}

export class CtripBridgeCommissioningConflictError extends Error {
  readonly code = "CTRIP_BRIDGE_COMMISSIONING_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "CtripBridgeCommissioningConflictError";
  }
}

interface CommissioningReceiptRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly tenant_id: string;
  readonly operator_user_id: string;
  readonly operator_email: string;
  readonly ctrip_channel_account_id: string;
  readonly bridge_service_principal_id: string;
  readonly principal_name: string;
  readonly audit_log_id: string;
}

function conflict(message: string): never {
  throw new CtripBridgeCommissioningConflictError(message);
}

function sqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function boundedText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    containsControlCharacter(normalized)
  ) {
    throw new Error(`${name} must contain 1 to ${maximumLength} printable characters`);
  }
  return normalized;
}

function normalizeInput(input: Readonly<CommissionCtripBridgeInput>): CommissionCtripBridgeInput {
  const tenantSlug = boundedText(input.tenantSlug, "tenantSlug", 63);
  if (!TENANT_SLUG.test(tenantSlug)) throw new Error("tenantSlug is invalid");

  const operatorEmail = boundedText(input.operatorEmail, "operatorEmail", 320).toLowerCase();
  if (!EMAIL.test(operatorEmail)) throw new Error("operatorEmail is invalid");

  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 200);
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error(
      "idempotencyKey must use 8-200 letters, digits, dots, colons, underscores or hyphens",
    );
  }

  return {
    tenantSlug,
    operatorEmail,
    idempotencyKey,
    principalName: boundedText(input.principalName, "principalName", 200),
  };
}

export function loadCommissionCtripBridgeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CommissionCtripBridgeEnvironment {
  const connectionString = requiredEnvironment(environment, "DATABASE_ADMIN_URL");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_ADMIN_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }

  return {
    connectionString,
    ...normalizeInput({
      tenantSlug: requiredEnvironment(environment, "GEO_CTRIP_BRIDGE_TENANT_SLUG"),
      operatorEmail: requiredEnvironment(environment, "GEO_CTRIP_BRIDGE_OPERATOR_EMAIL"),
      idempotencyKey: requiredEnvironment(environment, "GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY"),
      principalName: requiredEnvironment(environment, "GEO_CTRIP_BRIDGE_PRINCIPAL_NAME"),
    }),
  };
}

export function ctripBridgeCommissioningRequestHash(
  input: Readonly<CommissionCtripBridgeInput>,
): string {
  return sha256Canonical({
    schemaVersion: "geo.ctrip-bridge-commissioning.v1",
    ...normalizeInput(input),
  });
}

export function formatCtripBridgeCommissioningOutput(
  result: Readonly<CommissionCtripBridgeResult>,
): CommissionCtripBridgeOutput {
  return {
    event: "ctrip_bridge_commissioning.completed",
    ...result,
  };
}

async function findReceipt(
  transaction: Transaction<Database>,
  idempotencyKey: string,
): Promise<CommissioningReceiptRow | null> {
  const result = await sql<CommissioningReceiptRow>`
    select id, idempotency_key, request_hash, tenant_id, operator_user_id, operator_email,
           ctrip_channel_account_id, bridge_service_principal_id, principal_name, audit_log_id
    from geo.ctrip_bridge_commissioning_receipts
    where idempotency_key = ${idempotencyKey}
  `.execute(transaction);
  if (result.rows.length > 1) conflict("Commissioning idempotency key has multiple receipts");
  return result.rows[0] ?? null;
}

async function resolveTenant(
  transaction: Transaction<Database>,
  tenantSlug: string,
): Promise<string> {
  const result = await sql<{ id: string }>`
    select id from geo.tenants where slug = ${tenantSlug} and status = 'active'
  `.execute(transaction);
  const tenantId = result.rows[0]?.id;
  if (tenantId === undefined) conflict("Active commissioning tenant was not found");
  return tenantId;
}

async function requireAuthorizedOperator(
  transaction: Transaction<Database>,
  tenantId: string,
  operatorEmail: string,
): Promise<string> {
  const result = await sql<{
    user_id: string;
    user_status: string;
    membership_status: string;
    role: string;
    capabilities: unknown;
  }>`
    select users.id as user_id, users.status as user_status,
           membership.status as membership_status, membership.role, membership.capabilities
    from geo.users as users
    join geo.tenant_memberships as membership on membership.user_id = users.id
    where membership.tenant_id = ${tenantId} and lower(users.email) = ${operatorEmail}
  `.execute(transaction);
  const operator = result.rows[0];
  const capabilities = Array.isArray(operator?.capabilities) ? operator.capabilities : [];
  if (
    operator === undefined ||
    operator.user_status !== "active" ||
    operator.membership_status !== "active" ||
    (operator.role !== "owner" && operator.role !== "admin") ||
    !capabilities.includes("principal:manage")
  ) {
    conflict("An active owner or admin with principal:manage is required");
  }
  return operator.user_id;
}

async function resolveCtripAccount(
  transaction: Transaction<Database>,
  tenantId: string,
  expectedAccountId?: string,
): Promise<string> {
  if (expectedAccountId !== undefined) {
    const expected = await sql<{ id: string }>`
      select id
      from geo.channel_accounts
      where tenant_id = ${tenantId}
        and id = ${expectedAccountId}
        and platform = 'ctrip_community'
        and status = 'active'
    `.execute(transaction);
    const accountId = expected.rows[0]?.id;
    if (accountId === undefined) conflict("Commissioned Ctrip channel account is not active");
    return accountId;
  }

  const previous = await sql<{ ctrip_channel_account_id: string }>`
    select receipt.ctrip_channel_account_id
    from geo.ctrip_bridge_commissioning_receipts as receipt
    join geo.channel_accounts as account
      on account.tenant_id = receipt.tenant_id
     and account.id = receipt.ctrip_channel_account_id
     and account.platform = 'ctrip_community'
     and account.status = 'active'
    where receipt.tenant_id = ${tenantId}
    order by receipt.created_at desc, receipt.id desc
    limit 1
  `.execute(transaction);
  const previousAccountId = previous.rows[0]?.ctrip_channel_account_id;
  if (previousAccountId !== undefined) return previousAccountId;

  const result = await sql<{ id: string }>`
    select id
    from geo.channel_accounts
    where tenant_id = ${tenantId} and platform = 'ctrip_community' and status = 'active'
    order by id
  `.execute(transaction);
  if (result.rows.length !== 1) {
    conflict("Commissioning requires exactly one active Ctrip channel account");
  }
  const accountId = result.rows[0]?.id;
  if (accountId === undefined) conflict("Active Ctrip channel account was not found");
  return accountId;
}

function commissionedState(receipt: Readonly<CommissioningReceiptRow>) {
  return {
    schemaVersion: "geo.ctrip-bridge-commissioning.v1",
    receiptId: receipt.id,
    auditLogId: receipt.audit_log_id,
    tenantId: receipt.tenant_id,
    operatorUserId: receipt.operator_user_id,
    operatorEmail: receipt.operator_email,
    ctripChannelAccountId: receipt.ctrip_channel_account_id,
    bridgeServicePrincipalId: receipt.bridge_service_principal_id,
    principalName: receipt.principal_name,
    kind: "integration",
    profile: "ctrip_bridge",
    capabilities: ctripBridgeCapabilities,
    status: "active",
    credentialIssued: false,
  } as const;
}

async function assertCommissionedState(
  transaction: Transaction<Database>,
  input: Readonly<CommissionCtripBridgeInput>,
  requestHash: string,
  receipt: Readonly<CommissioningReceiptRow>,
): Promise<void> {
  if (receipt.request_hash !== requestHash) {
    conflict("Commissioning idempotency key conflicts with another request");
  }

  const tenantId = await resolveTenant(transaction, input.tenantSlug);
  const operatorUserId = await requireAuthorizedOperator(
    transaction,
    tenantId,
    input.operatorEmail,
  );
  const ctripChannelAccountId = await resolveCtripAccount(
    transaction,
    tenantId,
    receipt.ctrip_channel_account_id,
  );
  if (
    receipt.tenant_id !== tenantId ||
    receipt.operator_user_id !== operatorUserId ||
    receipt.operator_email !== input.operatorEmail ||
    receipt.ctrip_channel_account_id !== ctripChannelAccountId ||
    receipt.principal_name !== input.principalName
  ) {
    conflict("Existing Ctrip bridge commissioning receipt differs from the request");
  }

  const principalResult = await sql<{
    name: string;
    kind: string;
    profile: string;
    capabilities: unknown;
    status: string;
    credential_count: string;
    active_bridge_count: string;
  }>`
    select principal.name, principal.kind, principal.profile, principal.capabilities,
           principal.status, count(api_key.id)::text as credential_count,
           (select count(*)::text from geo.service_principals as active_bridge
             where active_bridge.tenant_id = principal.tenant_id
               and active_bridge.profile = 'ctrip_bridge'
               and active_bridge.status = 'active') as active_bridge_count
    from geo.service_principals as principal
    left join geo.api_keys as api_key
      on api_key.tenant_id = principal.tenant_id
     and api_key.service_principal_id = principal.id
    where principal.tenant_id = ${tenantId}
      and principal.id = ${receipt.bridge_service_principal_id}
    group by principal.id
  `.execute(transaction);
  const principal = principalResult.rows[0];
  if (
    principal === undefined ||
    principal.name !== input.principalName ||
    principal.kind !== "integration" ||
    principal.profile !== "ctrip_bridge" ||
    principal.status !== "active" ||
    principal.credential_count !== "0" ||
    principal.active_bridge_count !== "1" ||
    sha256Canonical(principal.capabilities) !== sha256Canonical(ctripBridgeCapabilities)
  ) {
    conflict("Existing Ctrip bridge principal differs from the commissioned identity");
  }

  const expectedAfterHash = sha256Canonical(commissionedState(receipt));
  const auditResult = await sql<{ after_hash: string | null }>`
    select after_hash
    from geo.audit_log
    where tenant_id = ${tenantId}
      and id = ${receipt.audit_log_id}
      and actor_id = ${operatorUserId}
      and action = 'ctrip_bridge.commissioned'
      and resource_type = 'service_principal'
      and resource_id = ${receipt.bridge_service_principal_id}
      and request_id = ${input.idempotencyKey}
      and before_hash is null
  `.execute(transaction);
  if (auditResult.rows.length !== 1 || auditResult.rows[0]?.after_hash !== expectedAfterHash) {
    conflict("Ctrip bridge commissioning audit trail is missing or inconsistent");
  }
}

export async function commissionCtripBridge(
  database: Kysely<Database>,
  rawInput: Readonly<CommissionCtripBridgeInput>,
  options: Readonly<CommissionCtripBridgeOptions> = {},
): Promise<CommissionCtripBridgeResult> {
  const input = normalizeInput(rawInput);
  const requestHash = ctripBridgeCommissioningRequestHash(input);

  try {
    return await database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(
      ${`ctrip-bridge-commissioning:key:${input.idempotencyKey}`}, 0
    ))`.execute(transaction);

      const existingReceipt = await findReceipt(transaction, input.idempotencyKey);
      if (existingReceipt !== null) {
        await assertCommissionedState(transaction, input, requestHash, existingReceipt);
        return {
          tenantId: existingReceipt.tenant_id,
          ctripChannelAccountId: existingReceipt.ctrip_channel_account_id,
          bridgeServicePrincipalId: existingReceipt.bridge_service_principal_id,
          wasCreated: false,
        };
      }

      await sql`select pg_advisory_xact_lock(hashtextextended(
      ${`ctrip-bridge-commissioning:tenant:${input.tenantSlug}`}, 0
    ))`.execute(transaction);
      const tenantId = await resolveTenant(transaction, input.tenantSlug);
      const operatorUserId = await requireAuthorizedOperator(
        transaction,
        tenantId,
        input.operatorEmail,
      );
      const ctripChannelAccountId = await resolveCtripAccount(transaction, tenantId);

      const existingPrincipal = await sql<{ id: string }>`
      select id from geo.service_principals
      where tenant_id = ${tenantId} and profile = 'ctrip_bridge' and status = 'active'
    `.execute(transaction);
      if (existingPrincipal.rows.length > 0) {
        conflict(
          "Tenant already has an active Ctrip bridge principal; commissioning will not adopt it",
        );
      }
      const existingName = await sql<{ id: string }>`
        select id from geo.service_principals
        where tenant_id = ${tenantId} and name = ${input.principalName}
      `.execute(transaction);
      if (existingName.rows.length > 0) {
        conflict("Service principal name already exists; commissioning will not adopt it");
      }

      const nextId = options.idGenerator ?? randomUUID;
      const bridgeServicePrincipalId = nextId();
      const receiptId = nextId();
      const auditLogId = nextId();
      await sql`
      insert into geo.service_principals (
        tenant_id, id, name, kind, profile, capabilities, status
      ) values (
        ${tenantId}, ${bridgeServicePrincipalId}, ${input.principalName},
        'integration', 'ctrip_bridge', ${JSON.stringify(ctripBridgeCapabilities)}::jsonb, 'active'
      )
    `.execute(transaction);

      const receipt: CommissioningReceiptRow = {
        id: receiptId,
        idempotency_key: input.idempotencyKey,
        request_hash: requestHash,
        tenant_id: tenantId,
        operator_user_id: operatorUserId,
        operator_email: input.operatorEmail,
        ctrip_channel_account_id: ctripChannelAccountId,
        bridge_service_principal_id: bridgeServicePrincipalId,
        principal_name: input.principalName,
        audit_log_id: auditLogId,
      };

      const after = commissionedState(receipt);
      await sql`
      insert into geo.audit_log (
        tenant_id, id, actor_id, action, resource_type, resource_id,
        request_id, before_hash, after_hash, details
      ) values (
        ${tenantId}, ${auditLogId}, ${operatorUserId}, 'ctrip_bridge.commissioned',
        'service_principal', ${bridgeServicePrincipalId}, ${input.idempotencyKey}, null,
        ${sha256Canonical(after)},
        ${JSON.stringify({
          schemaVersion: "geo.ctrip-bridge-commissioning-audit.v1",
          receiptId: receipt.id,
          ctripChannelAccountId,
          profile: "ctrip_bridge",
          credentialIssued: false,
        })}::jsonb
      )
    `.execute(transaction);

      await sql`
      insert into geo.ctrip_bridge_commissioning_receipts (
        id, idempotency_key, request_hash, tenant_id, operator_user_id, operator_email,
        ctrip_channel_account_id, bridge_service_principal_id, principal_name, audit_log_id
      ) values (
        ${receiptId}, ${input.idempotencyKey}, ${requestHash}, ${tenantId}, ${operatorUserId},
        ${input.operatorEmail}, ${ctripChannelAccountId}, ${bridgeServicePrincipalId},
        ${input.principalName}, ${auditLogId}
      )
    `.execute(transaction);

      await sql`
        update geo.ctrip_account_runtime_bindings
        set bridge_principal_id = ${bridgeServicePrincipalId}
        where tenant_id = ${tenantId}
      `.execute(transaction);

      return {
        tenantId,
        ctripChannelAccountId,
        bridgeServicePrincipalId,
        wasCreated: true,
      };
    });
  } catch (error) {
    if (error instanceof CtripBridgeCommissioningConflictError) throw error;
    if (sqlState(error) === "23505") {
      conflict("Ctrip bridge commissioning conflicted with a concurrent or existing identity");
    }
    throw error;
  }
}
