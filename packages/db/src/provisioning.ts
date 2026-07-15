import { randomUUID } from "node:crypto";

import { buildBaselineAuditPolicyDocument, sha256Canonical } from "@geo/core";
import { sql, type Kysely, type Transaction } from "kysely";

import type { Database, JsonObject, JsonValue } from "./types.js";

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const CONTACT_TYPES = ["phone", "wechat", "email", "website", "address"] as const;
const CONTACT_TYPE_SET = new Set<string>(CONTACT_TYPES);
const MAX_CONTACTS = 100;

const AUTOMATION_QUOTA = {
  maxConcurrent: 1,
  perMinute: 10,
  perDay: 100,
  cooldownSeconds: 0,
  errorBudget: 5,
} as const satisfies JsonObject;
const AUTOMATION_REASON = "Tenant provisioning starts in shadow/dry-run mode";
const CAPABILITY_EVIDENCE_REFS = ["tenant-provisioning:manual-only-dry-run"] as const;
const CONTACT_METADATA = { source: "tenant-provisioning", version: 1 } as const;

const CHANNEL_ACCOUNTS = [
  { platform: "toutiao", label: "Toutiao" },
  { platform: "sohu", label: "Sohu" },
  { platform: "ctrip_community", label: "Ctrip Community" },
] as const;

export type ProvisionContactType = (typeof CONTACT_TYPES)[number];

export interface ProvisionContactInput {
  readonly type: ProvisionContactType;
  readonly label: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly isPrimary: boolean;
}

export interface ProvisionTenantInput {
  readonly idempotencyKey: string;
  readonly tenantSlug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly industry: string;
  readonly defaultLocale: string;
  readonly brandCanonicalName: string;
  readonly brandDisplayName: string;
  readonly contacts: readonly ProvisionContactInput[];
  readonly workerName: string;
}

export interface ProvisionTenantEnvironment extends ProvisionTenantInput {
  readonly connectionString: string;
}

export interface ProvisionTenantResult {
  readonly tenantId: string;
  readonly brandId: string;
  readonly workerServicePrincipalId: string;
  readonly policyBundleId: string;
  readonly querySetId: string;
  readonly querySetVersionId: string;
  readonly wasCreated: boolean;
}

export interface ProvisionTenantOutput extends ProvisionTenantResult {
  readonly event: "tenant_provisioning.completed";
  readonly workerTenantActorsJsonFragment: Readonly<Record<string, string>>;
}

export class TenantProvisioningConflictError extends Error {
  readonly code = "TENANT_PROVISIONING_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "TenantProvisioningConflictError";
  }
}

interface ProvisioningReceiptRow {
  idempotency_key: string;
  request_hash: string;
  tenant_id: string;
  tenant_slug: string;
  brand_id: string;
  worker_service_principal_id: string;
  policy_bundle_id: string;
  query_set_id: string;
  query_set_version_id: string;
}

export interface ProvisionTenantOptions {
  readonly idGenerator?: (() => string) | undefined;
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

function plainRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function contactSortKey(contact: Readonly<ProvisionContactInput>): string {
  return [
    contact.type,
    contact.normalizedValue,
    contact.label,
    contact.value,
    String(contact.isPrimary),
  ].join("\u0000");
}

function normalizedContacts(value: unknown): readonly ProvisionContactInput[] {
  if (!Array.isArray(value)) throw new Error("GEO_PROVISION_CONTACTS_JSON must be an array");
  if (value.length > MAX_CONTACTS) {
    throw new Error(
      `GEO_PROVISION_CONTACTS_JSON cannot contain more than ${MAX_CONTACTS} contacts`,
    );
  }
  const contacts = value.map((entry, index) => {
    const name = `GEO_PROVISION_CONTACTS_JSON[${index}]`;
    const record = plainRecord(entry, name);
    const allowedKeys = new Set(["type", "label", "value", "normalizedValue", "isPrimary"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) throw new Error(`${name}.${key} is not supported`);
    }
    if (typeof record.type !== "string" || !CONTACT_TYPE_SET.has(record.type)) {
      throw new Error(`${name}.type is invalid`);
    }
    if (typeof record.isPrimary !== "boolean") {
      throw new Error(`${name}.isPrimary must be a boolean`);
    }
    return {
      type: record.type as ProvisionContactType,
      label: boundedText(record.label, `${name}.label`, 200),
      value: boundedText(record.value, `${name}.value`, 2_000),
      normalizedValue: boundedText(record.normalizedValue, `${name}.normalizedValue`, 2_000),
      isPrimary: record.isPrimary,
    };
  });
  contacts.sort((left, right) => contactSortKey(left).localeCompare(contactSortKey(right), "en"));
  const identities = new Set<string>();
  for (const contact of contacts) {
    const identity = `${contact.type}\u0000${contact.normalizedValue}`;
    if (identities.has(identity)) {
      throw new Error(
        "GEO_PROVISION_CONTACTS_JSON contains duplicate type/normalizedValue contacts",
      );
    }
    identities.add(identity);
  }
  return contacts;
}

function parseContactsEnvironment(raw: string): readonly ProvisionContactInput[] {
  if (raw.length > 200_000) throw new Error("GEO_PROVISION_CONTACTS_JSON is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("GEO_PROVISION_CONTACTS_JSON must be valid JSON");
  }
  return normalizedContacts(value);
}

function normalizeProvisionTenantInput(
  input: Readonly<ProvisionTenantInput>,
): ProvisionTenantInput {
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 200);
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error(
      "idempotencyKey must use 8-200 letters, digits, dots, colons, underscores or hyphens",
    );
  }
  const tenantSlug = boundedText(input.tenantSlug, "tenantSlug", 63);
  if (!TENANT_SLUG.test(tenantSlug)) throw new Error("tenantSlug is invalid");
  const defaultLocale = boundedText(input.defaultLocale, "defaultLocale", 50);
  if (!LOCALE.test(defaultLocale)) throw new Error("defaultLocale is invalid");
  const contacts = normalizedContacts(input.contacts);
  return {
    idempotencyKey,
    tenantSlug,
    legalName: boundedText(input.legalName, "legalName", 200),
    displayName: boundedText(input.displayName, "displayName", 200),
    industry: boundedText(input.industry, "industry", 100),
    defaultLocale,
    brandCanonicalName: boundedText(input.brandCanonicalName, "brandCanonicalName", 200),
    brandDisplayName: boundedText(input.brandDisplayName, "brandDisplayName", 150),
    contacts,
    workerName: boundedText(input.workerName, "workerName", 200),
  };
}

export function loadProvisionTenantEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ProvisionTenantEnvironment {
  const connectionString = requiredEnvironment(environment, "DATABASE_ADMIN_URL");
  const url = new URL(connectionString);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  const input = normalizeProvisionTenantInput({
    idempotencyKey: requiredEnvironment(environment, "GEO_PROVISION_IDEMPOTENCY_KEY"),
    tenantSlug: requiredEnvironment(environment, "GEO_PROVISION_TENANT_SLUG"),
    legalName: requiredEnvironment(environment, "GEO_PROVISION_LEGAL_NAME"),
    displayName: requiredEnvironment(environment, "GEO_PROVISION_DISPLAY_NAME"),
    industry: requiredEnvironment(environment, "GEO_PROVISION_INDUSTRY"),
    defaultLocale: requiredEnvironment(environment, "GEO_PROVISION_DEFAULT_LOCALE"),
    brandCanonicalName: requiredEnvironment(environment, "GEO_PROVISION_BRAND_CANONICAL_NAME"),
    brandDisplayName: requiredEnvironment(environment, "GEO_PROVISION_BRAND_DISPLAY_NAME"),
    contacts: parseContactsEnvironment(
      requiredEnvironment(environment, "GEO_PROVISION_CONTACTS_JSON"),
    ),
    workerName: requiredEnvironment(environment, "GEO_PROVISION_WORKER_NAME"),
  });
  return { connectionString, ...input };
}

function requestHash(input: Readonly<ProvisionTenantInput>): string {
  return sha256Canonical({
    schema: "geo.tenant-provisioning.v1",
    ...input,
  });
}

function accountDisplayName(brandDisplayName: string, label: string): string {
  return `${brandDisplayName} / ${label} / Dry Run`;
}

const BASELINE_PACK_VERSION = "baseline-v1";

function baselinePolicyDocument(input: Readonly<ProvisionTenantInput>): JsonObject {
  return buildBaselineAuditPolicyDocument({
    rulesVersion: BASELINE_PACK_VERSION,
    industry: input.industry,
  }) as JsonObject;
}

function baselineQueryPrompts(input: Readonly<ProvisionTenantInput>): readonly JsonValue[] {
  const brand = input.brandDisplayName;
  const industry = input.industry;
  return [
    {
      key: "category-discovery",
      category: "generic",
      prompt: `${industry} 服务应该如何比较？`,
    },
    {
      key: "brand-overview",
      category: "brand",
      prompt: `${brand} 的服务特点和适用人群是什么？`,
    },
    {
      key: "brand-contact",
      category: "contact",
      prompt: `${brand} 的官方联系方式是什么？`,
    },
    {
      key: "brand-evidence",
      category: "evidence",
      prompt: `${brand} 有哪些可核验的服务信息和来源？`,
    },
    {
      key: "provider-comparison",
      category: "comparison",
      prompt: `选择 ${industry} 服务商时应该比较哪些公开证据？`,
    },
    {
      key: "hallucination-control",
      category: "risk",
      prompt: `${brand} 有哪些官方保证、资质或实时优惠？请只列可核验信息。`,
    },
  ];
}

function conflict(message: string): never {
  throw new TenantProvisioningConflictError(message);
}

async function findReceipt(
  transaction: Transaction<Database>,
  idempotencyKey: string,
): Promise<ProvisioningReceiptRow | null> {
  const result = await sql<ProvisioningReceiptRow>`
    select receipt.idempotency_key, receipt.request_hash, receipt.tenant_id,
           tenant.slug as tenant_slug, receipt.brand_id,
           receipt.worker_service_principal_id, receipt.policy_bundle_id,
           receipt.query_set_id, receipt.query_set_version_id
    from geo.tenant_provisioning_receipts as receipt
    join geo.tenants as tenant on tenant.id = receipt.tenant_id
    where receipt.idempotency_key = ${idempotencyKey}
  `.execute(transaction);
  if (result.rows.length > 1) conflict("Provisioning idempotency key has multiple receipts");
  return result.rows[0] ?? null;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

async function assertProvisionedState(
  transaction: Transaction<Database>,
  input: Readonly<ProvisionTenantInput>,
  receipt: Readonly<ProvisioningReceiptRow>,
): Promise<void> {
  const tenantResult = await sql<{
    slug: string;
    legal_name: string;
    display_name: string;
    industry: string;
    status: string;
    default_locale: string;
  }>`
    select slug, legal_name, display_name, industry, status, default_locale
    from geo.tenants where id = ${receipt.tenant_id}
  `.execute(transaction);
  const tenant = tenantResult.rows[0];
  if (
    tenant === undefined ||
    tenant.slug !== input.tenantSlug ||
    tenant.legal_name !== input.legalName ||
    tenant.display_name !== input.displayName ||
    tenant.industry !== input.industry ||
    tenant.status !== "active" ||
    tenant.default_locale !== input.defaultLocale
  ) {
    conflict("Existing provisioned tenant state differs from the original request");
  }

  const brandResult = await sql<{
    canonical_name: string;
    display_name: string;
    aliases: unknown;
    description: string | null;
    industry: string;
    website_url: string | null;
    is_primary: boolean;
  }>`
    select canonical_name, display_name, aliases, description, industry, website_url, is_primary
    from geo.brands
    where tenant_id = ${receipt.tenant_id} and id = ${receipt.brand_id}
  `.execute(transaction);
  const brand = brandResult.rows[0];
  if (
    brand === undefined ||
    brand.canonical_name !== input.brandCanonicalName ||
    brand.display_name !== input.brandDisplayName ||
    !sameCanonical(brand.aliases, []) ||
    brand.description !== null ||
    brand.industry !== input.industry ||
    brand.website_url !== null ||
    !brand.is_primary
  ) {
    conflict("Existing provisioned primary brand differs from the original request");
  }

  const contactsResult = await sql<{
    type: ProvisionContactType;
    label: string;
    value: string;
    normalized_value: string;
    is_primary: boolean;
    valid_until: Date | null;
    metadata: unknown;
  }>`
    select type, label, value, normalized_value, is_primary, valid_until, metadata
    from geo.tenant_contacts where tenant_id = ${receipt.tenant_id}
  `.execute(transaction);
  const contacts = contactsResult.rows
    .map((row) => ({
      type: row.type,
      label: row.label,
      value: row.value,
      normalizedValue: row.normalized_value,
      isPrimary: row.is_primary,
      validUntil: row.valid_until?.toISOString() ?? null,
      metadata: row.metadata,
    }))
    .sort((left, right) => contactSortKey(left).localeCompare(contactSortKey(right), "en"));
  const expectedContacts = input.contacts.map((contact) => ({
    ...contact,
    validUntil: null,
    metadata: CONTACT_METADATA,
  }));
  if (!sameCanonical(contacts, expectedContacts)) {
    conflict("Existing provisioned contacts differ from the original request");
  }

  const controlResult = await sql<{
    mode: string;
    quota: unknown;
    kill_switch_enabled: boolean;
    reason: string | null;
  }>`
    select mode, quota, kill_switch_enabled, reason
    from geo.automation_controls
    where tenant_id = ${receipt.tenant_id} and scope_type = 'tenant' and scope_key = '*'
  `.execute(transaction);
  const control = controlResult.rows[0];
  if (
    control === undefined ||
    control.mode !== "shadow" ||
    !sameCanonical(control.quota, AUTOMATION_QUOTA) ||
    control.kill_switch_enabled ||
    control.reason !== AUTOMATION_REASON
  ) {
    conflict("Existing provisioned automation control differs from the safe baseline");
  }

  const accountsResult = await sql<{
    platform: (typeof CHANNEL_ACCOUNTS)[number]["platform"];
    display_name: string;
    capability: string;
    supported_execution_levels: string[];
    credential_ref: string | null;
    capability_evidence_type: string;
    capability_evidence_refs: unknown;
    status: string;
    last_verified_at: Date | null;
  }>`
    select platform, display_name, capability, supported_execution_levels,
           credential_ref, capability_evidence_type, capability_evidence_refs,
           status, last_verified_at
    from geo.channel_accounts where tenant_id = ${receipt.tenant_id}
    order by platform
  `.execute(transaction);
  const accounts = accountsResult.rows.map((row) => ({
    platform: row.platform,
    displayName: row.display_name,
    capability: row.capability,
    supportedExecutionLevels: row.supported_execution_levels,
    credentialRef: row.credential_ref,
    capabilityEvidenceType: row.capability_evidence_type,
    capabilityEvidenceRefs: row.capability_evidence_refs,
    status: row.status,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
  }));
  const expectedAccounts = CHANNEL_ACCOUNTS.map((account) => ({
    platform: account.platform,
    displayName: accountDisplayName(input.brandDisplayName, account.label),
    capability: "manual_only",
    supportedExecutionLevels: ["dry_run"],
    credentialRef: null,
    capabilityEvidenceType: "preview",
    capabilityEvidenceRefs: CAPABILITY_EVIDENCE_REFS,
    status: "active",
    lastVerifiedAt: null,
  })).sort((left, right) => left.platform.localeCompare(right.platform, "en"));
  if (!sameCanonical(accounts, expectedAccounts)) {
    conflict("Existing provisioned channel accounts differ from the safe dry-run baseline");
  }

  const expectedPolicyDocument = baselinePolicyDocument(input);
  const policyResult = await sql<{
    version: string;
    status: string;
    policy_hash: string;
    document: unknown;
  }>`
    select version, status, policy_hash, document
    from geo.policy_bundles
    where tenant_id = ${receipt.tenant_id} and id = ${receipt.policy_bundle_id}
  `.execute(transaction);
  const policy = policyResult.rows[0];
  if (
    policy === undefined ||
    policy.version !== BASELINE_PACK_VERSION ||
    policy.status !== "active" ||
    policy.policy_hash !== sha256Canonical(expectedPolicyDocument) ||
    !sameCanonical(policy.document, expectedPolicyDocument)
  ) {
    conflict("Existing provisioned audit policy differs from the active baseline pack");
  }

  const expectedPrompts = baselineQueryPrompts(input);
  const queryResult = await sql<{
    name: string;
    industry: string;
    status: string;
    current_version: number;
    description: string;
    version_id: string;
    prompts: unknown;
    prompt_hash: string;
    created_by_actor_id: string;
  }>`
    select query_set.name, query_set.industry, query_set.status,
           query_set.current_version, query_set.description,
           version.id as version_id, version.prompts, version.prompt_hash,
           version.created_by_actor_id
    from geo.query_sets as query_set
    join geo.query_set_versions as version
      on version.tenant_id = query_set.tenant_id
     and version.query_set_id = query_set.id
     and version.version = query_set.current_version
    where query_set.tenant_id = ${receipt.tenant_id}
      and query_set.id = ${receipt.query_set_id}
  `.execute(transaction);
  const query = queryResult.rows[0];
  if (
    query === undefined ||
    query.name !== `${input.brandDisplayName} GEO 基准问题集` ||
    query.industry !== input.industry ||
    query.status !== "active" ||
    query.current_version !== 1 ||
    query.description !== "豆包与千问独立评测；不使用 Google 排名作为代理指标" ||
    query.version_id !== receipt.query_set_version_id ||
    query.prompt_hash !== sha256Canonical(expectedPrompts) ||
    query.created_by_actor_id !== receipt.worker_service_principal_id ||
    !sameCanonical(query.prompts, expectedPrompts)
  ) {
    conflict("Existing provisioned visibility query set differs from the active baseline pack");
  }

  const principalResult = await sql<{ name: string; kind: string; status: string }>`
    select name, kind, status from geo.service_principals
    where tenant_id = ${receipt.tenant_id} and id = ${receipt.worker_service_principal_id}
  `.execute(transaction);
  const principal = principalResult.rows[0];
  if (
    principal === undefined ||
    principal.name !== input.workerName ||
    principal.kind !== "worker" ||
    principal.status !== "active"
  ) {
    conflict("Existing provisioned worker service principal differs from the original request");
  }
}

async function createProvisionedTenant(
  transaction: Transaction<Database>,
  input: Readonly<ProvisionTenantInput>,
  hash: string,
  idGenerator: () => string,
): Promise<ProvisionTenantResult> {
  const tenantId = idGenerator();
  const brandId = idGenerator();
  const contactIds = input.contacts.map(() => idGenerator());
  const automationControlId = idGenerator();
  const channelAccountIds = CHANNEL_ACCOUNTS.map(() => idGenerator());
  const workerServicePrincipalId = idGenerator();
  const policyBundleId = idGenerator();
  const querySetId = idGenerator();
  const querySetVersionId = idGenerator();

  await sql`
    insert into geo.tenants (
      id, slug, legal_name, display_name, industry, status, default_locale
    ) values (
      ${tenantId}, ${input.tenantSlug}, ${input.legalName}, ${input.displayName},
      ${input.industry}, 'active', ${input.defaultLocale}
    )
  `.execute(transaction);

  await sql`
    insert into geo.brands (
      tenant_id, id, canonical_name, display_name, aliases, description,
      industry, website_url, is_primary
    ) values (
      ${tenantId}, ${brandId}, ${input.brandCanonicalName}, ${input.brandDisplayName},
      '[]'::jsonb, null, ${input.industry}, null, true
    )
  `.execute(transaction);

  for (const [index, contact] of input.contacts.entries()) {
    const contactId = contactIds[index];
    if (contactId === undefined) throw new Error("Contact ID allocation failed");
    await sql`
      insert into geo.tenant_contacts (
        tenant_id, id, type, label, value, normalized_value, is_primary,
        valid_from, valid_until, metadata
      ) values (
        ${tenantId}, ${contactId}, ${contact.type}, ${contact.label}, ${contact.value},
        ${contact.normalizedValue}, ${contact.isPrimary}, clock_timestamp(), null,
        ${JSON.stringify(CONTACT_METADATA)}::jsonb
      )
    `.execute(transaction);
  }

  await sql`
    insert into geo.automation_controls (
      tenant_id, id, scope_type, scope_key, mode, quota,
      kill_switch_enabled, reason
    ) values (
      ${tenantId}, ${automationControlId}, 'tenant', '*', 'shadow',
      ${JSON.stringify(AUTOMATION_QUOTA)}::jsonb, false, ${AUTOMATION_REASON}
    )
  `.execute(transaction);

  for (const [index, account] of CHANNEL_ACCOUNTS.entries()) {
    const channelAccountId = channelAccountIds[index];
    if (channelAccountId === undefined) throw new Error("Channel account ID allocation failed");
    await sql`
      insert into geo.channel_accounts (
        tenant_id, id, platform, display_name, capability,
        supported_execution_levels, credential_ref, capability_evidence_type,
        capability_evidence_refs, status, last_verified_at
      ) values (
        ${tenantId}, ${channelAccountId}, ${account.platform},
        ${accountDisplayName(input.brandDisplayName, account.label)}, 'manual_only',
        ARRAY['dry_run']::text[], null, 'preview',
        ${JSON.stringify(CAPABILITY_EVIDENCE_REFS)}::jsonb, 'active', null
      )
    `.execute(transaction);
  }

  await sql`
    insert into geo.service_principals (tenant_id, id, name, kind, status)
    values (${tenantId}, ${workerServicePrincipalId}, ${input.workerName}, 'worker', 'active')
  `.execute(transaction);

  const policyDocument = baselinePolicyDocument(input);
  await sql`
    insert into geo.policy_bundles (
      tenant_id, id, version, status, policy_hash, document, effective_at
    ) values (
      ${tenantId}, ${policyBundleId}, ${BASELINE_PACK_VERSION}, 'active',
      ${sha256Canonical(policyDocument)}, ${JSON.stringify(policyDocument)}::jsonb,
      clock_timestamp()
    )
  `.execute(transaction);

  const prompts = baselineQueryPrompts(input);
  await sql`
    insert into geo.query_sets (
      tenant_id, id, name, industry, status, current_version, description
    ) values (
      ${tenantId}, ${querySetId}, ${`${input.brandDisplayName} GEO 基准问题集`},
      ${input.industry}, 'active', 1,
      '豆包与千问独立评测；不使用 Google 排名作为代理指标'
    )
  `.execute(transaction);
  await sql`
    insert into geo.query_set_versions (
      tenant_id, id, query_set_id, version, prompts, prompt_hash, created_by_actor_id
    ) values (
      ${tenantId}, ${querySetVersionId}, ${querySetId}, 1,
      ${JSON.stringify(prompts)}::jsonb, ${sha256Canonical(prompts)},
      ${workerServicePrincipalId}
    )
  `.execute(transaction);

  await sql`
    insert into geo.tenant_provisioning_receipts (
      idempotency_key, request_hash, tenant_id, brand_id, worker_service_principal_id,
      policy_bundle_id, query_set_id, query_set_version_id
    ) values (
      ${input.idempotencyKey}, ${hash}, ${tenantId}, ${brandId}, ${workerServicePrincipalId},
      ${policyBundleId}, ${querySetId}, ${querySetVersionId}
    )
  `.execute(transaction);

  return {
    tenantId,
    brandId,
    workerServicePrincipalId,
    policyBundleId,
    querySetId,
    querySetVersionId,
    wasCreated: true,
  };
}

export async function provisionTenant(
  database: Kysely<Database>,
  rawInput: Readonly<ProvisionTenantInput>,
  options: ProvisionTenantOptions = {},
): Promise<ProvisionTenantResult> {
  const input = normalizeProvisionTenantInput(rawInput);
  const hash = requestHash(input);
  const idGenerator = options.idGenerator ?? randomUUID;
  return database.transaction().execute(async (transaction) => {
    const idempotencyLock = `tenant-provisioning:key:${input.idempotencyKey}`;
    const slugLock = `tenant-provisioning:slug:${input.tenantSlug}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyLock}, 0))`.execute(
      transaction,
    );
    await sql`select pg_advisory_xact_lock(hashtextextended(${slugLock}, 0))`.execute(transaction);

    const receipt = await findReceipt(transaction, input.idempotencyKey);
    if (receipt !== null) {
      if (receipt.request_hash !== hash || receipt.tenant_slug !== input.tenantSlug) {
        conflict("Provisioning idempotency key conflicts with another request");
      }
      await assertProvisionedState(transaction, input, receipt);
      return {
        tenantId: receipt.tenant_id,
        brandId: receipt.brand_id,
        workerServicePrincipalId: receipt.worker_service_principal_id,
        policyBundleId: receipt.policy_bundle_id,
        querySetId: receipt.query_set_id,
        querySetVersionId: receipt.query_set_version_id,
        wasCreated: false,
      };
    }

    const tenant = await sql<{ id: string }>`
      select id from geo.tenants where slug = ${input.tenantSlug}
    `.execute(transaction);
    if (tenant.rows[0] !== undefined) {
      conflict(
        "Tenant slug already exists without this idempotency receipt; provisioning will not adopt or modify it",
      );
    }

    return createProvisionedTenant(transaction, input, hash, idGenerator);
  });
}

export function formatTenantProvisioningOutput(
  result: Readonly<ProvisionTenantResult>,
): ProvisionTenantOutput {
  return {
    event: "tenant_provisioning.completed",
    ...result,
    workerTenantActorsJsonFragment: {
      [result.tenantId]: result.workerServicePrincipalId,
    },
  };
}

export function tenantProvisioningRequestHash(input: Readonly<ProvisionTenantInput>): string {
  return requestHash(normalizeProvisionTenantInput(input));
}
