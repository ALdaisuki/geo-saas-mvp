import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

const expectedTables = [
  "users",
  "tenants",
  "tenant_memberships",
  "service_principals",
  "api_keys",
  "sessions",
  "brands",
  "brand_agent_profiles",
  "brand_competitors",
  "tenant_contacts",
  "policy_bundles",
  "automation_controls",
  "automation_batches",
  "automation_runs",
  "automation_run_targets",
  "channel_accounts",
  "campaigns",
  "claim_facts",
  "evidence_sources",
  "research_source_policies",
  "research_capture_records",
  "content_items",
  "content_versions",
  "media_generation_jobs",
  "media_generation_attempts",
  "media_assets",
  "content_media_bindings",
  "media_inspections",
  "publication_variants",
  "audit_runs",
  "audit_artifacts",
  "publication_grants",
  "audit_log",
  "publication_jobs",
  "publication_attempts",
  "publication_receipts",
  "publication_readbacks",
  "publication_assisted_handoffs",
  "outbox_events",
  "inbox_events",
  "idempotency_records",
  "circuit_breakers",
  "query_sets",
  "query_set_versions",
  "visibility_runs",
  "visibility_observations",
  "visibility_metrics",
  "tenant_provisioning_receipts",
] as const;

const tenantTables = expectedTables.filter(
  (tableName) =>
    tableName !== "users" &&
    tableName !== "tenants" &&
    tableName !== "tenant_provisioning_receipts",
);

let migrationSql = "";

beforeAll(async () => {
  const files = (await readdir(migrationDirectory))
    .filter((fileName) => /^\d{4}_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();
  migrationSql = (
    await Promise.all(
      files.map((fileName) => readFile(`${migrationDirectory}/${fileName}`, "utf8")),
    )
  ).join("\n");
});

function tableDefinition(tableName: string): string {
  const match = migrationSql.match(
    new RegExp(`CREATE TABLE geo\\.${tableName} \\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(match, `missing CREATE TABLE for ${tableName}`).not.toBeNull();
  return match?.[1] ?? "";
}

function functionDefinition(functionName: string): string {
  const start = migrationSql.indexOf(`CREATE OR REPLACE FUNCTION geo.${functionName}`);
  expect(start, `missing function ${functionName}`).toBeGreaterThanOrEqual(0);
  const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + 1);
  return migrationSql.slice(start, next === -1 ? undefined : next);
}

function latestFunctionDefinition(functionName: string): string {
  const marker = `CREATE OR REPLACE FUNCTION geo.${functionName}`;
  const start = migrationSql.lastIndexOf(marker);
  expect(start, `missing function ${functionName}`).toBeGreaterThanOrEqual(0);
  const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + marker.length);
  return migrationSql.slice(start, next === -1 ? undefined : next);
}

function functionOverloadDefinition(functionName: string, signatureFragment: string): string {
  const marker = `CREATE OR REPLACE FUNCTION geo.${functionName}`;
  let start = migrationSql.indexOf(marker);
  while (start !== -1) {
    const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + marker.length);
    const definition = migrationSql.slice(start, next === -1 ? undefined : next);
    if (definition.includes(signatureFragment)) return definition;
    start = migrationSql.indexOf(marker, start + marker.length);
  }
  expect.fail(`missing ${functionName} overload containing ${signatureFragment}`);
}

describe("PostgreSQL migration contract", () => {
  it("materializes every planned core table", () => {
    for (const tableName of expectedTables) {
      expect(migrationSql).toMatch(new RegExp(`CREATE TABLE geo\\.${tableName}\\s*\\(`, "i"));
    }
  });

  it("gives every tenant-owned table a non-null tenant key and scoped identity", () => {
    for (const tableName of tenantTables) {
      const definition = tableDefinition(tableName);
      expect(definition, tableName).toMatch(/tenant_id uuid NOT NULL/i);
      expect(definition, tableName).toMatch(/UNIQUE \(tenant_id, id\)/i);
    }
  });

  it("never uses an id-only foreign key to another tenant-owned table", () => {
    for (const referencedTable of tenantTables) {
      expect(migrationSql).not.toMatch(
        new RegExp(`REFERENCES geo\\.${referencedTable} \\(id\\)`, "i"),
      );
    }
  });

  it("enables and forces RLS for an explicit complete tenant table list", () => {
    const securitySql = functionDefinition("validate_publication_grant");
    const rlsPrefix = migrationSql.slice(0, migrationSql.indexOf(securitySql));
    expect(rlsPrefix).toContain("ENABLE ROW LEVEL SECURITY");
    expect(rlsPrefix).toContain("FORCE ROW LEVEL SECURITY");
    expect(rlsPrefix).toContain("geo.current_tenant_id()");
    expect(rlsPrefix).toContain("geo.current_actor_id() IS NOT NULL");
    for (const tableName of tenantTables.filter(
      (name) =>
        name !== "brand_competitors" &&
        name !== "brand_agent_profiles" &&
        name !== "publication_readbacks" &&
        name !== "publication_assisted_handoffs" &&
        name !== "automation_batches" &&
        name !== "automation_runs" &&
        name !== "automation_run_targets" &&
        name !== "research_source_policies" &&
        name !== "research_capture_records" &&
        name !== "media_generation_jobs" &&
        name !== "media_generation_attempts" &&
        name !== "content_media_bindings" &&
        name !== "media_inspections",
    )) {
      expect(rlsPrefix, tableName).toContain(`'${tableName}'`);
    }
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_readbacks ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_readbacks FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.publication_readbacks");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_assisted_handoffs ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_assisted_handoffs FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "CREATE POLICY tenant_isolation ON geo.publication_assisted_handoffs",
    );
    for (const tableName of ["automation_batches", "automation_runs", "automation_run_targets"]) {
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} ENABLE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} FORCE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`CREATE POLICY tenant_isolation ON geo.${tableName}`);
    }
  });

  it("keeps runtime and dispatcher roles non-owning and unable to bypass RLS", () => {
    expect(migrationSql).toMatch(/CREATE ROLE geo_runtime[^;]*NOLOGIN[^;]*NOBYPASSRLS/i);
    expect(migrationSql).toMatch(/CREATE ROLE geo_dispatcher[^;]*NOLOGIN[^;]*NOBYPASSRLS/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE[^;]+OWNER TO geo_(runtime|dispatcher)/i);
    expect(migrationSql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM PUBLIC, geo_dispatcher",
    );
  });

  it("makes audit artifacts, receipts, logs, and observations append-only", () => {
    for (const triggerName of [
      "audit_artifacts_append_only",
      "publication_receipts_append_only",
      "audit_log_append_only",
      "visibility_observations_append_only",
      "research_capture_records_append_only",
      "media_generation_attempts_append_only",
      "media_assets_append_only",
      "content_media_bindings_append_only",
      "media_inspections_append_only",
    ]) {
      expect(migrationSql).toContain(`CREATE TRIGGER ${triggerName}`);
    }
    expect(migrationSql).toContain("EXECUTE FUNCTION geo.prevent_append_only_mutation()");
  });

  it("persists tenant-scoped governed media jobs and immutable media evidence", () => {
    const jobs = tableDefinition("media_generation_jobs");
    const attempts = tableDefinition("media_generation_attempts");
    const bindings = tableDefinition("content_media_bindings");
    const inspections = tableDefinition("media_inspections");

    expect(jobs).toContain("content_version_id uuid NOT NULL");
    expect(jobs).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(jobs).toContain("UNIQUE (tenant_id, id, request_hash)");
    expect(jobs).toContain("UNIQUE (tenant_id, id, request_hash, provider_id, provider_mode)");
    expect(jobs).toMatch(
      /FOREIGN KEY \(tenant_id, content_version_id\)[\s\S]*REFERENCES geo\.content_versions \(tenant_id, id\)/i,
    );
    expect(attempts).toContain("job_id uuid NOT NULL");
    expect(attempts).toContain("UNIQUE (tenant_id, job_id, attempt_no)");
    expect(attempts).toMatch(
      /FOREIGN KEY \(tenant_id, job_id\)[\s\S]*REFERENCES geo\.media_generation_jobs \(tenant_id, id\)/i,
    );
    expect(attempts).toMatch(
      /FOREIGN KEY \(tenant_id, job_id, request_hash, provider_id, provider_mode\)[\s\S]*REFERENCES geo\.media_generation_jobs[\s\S]*\(tenant_id, id, request_hash, provider_id, provider_mode\)/i,
    );
    expect(bindings).toMatch(
      /FOREIGN KEY \(tenant_id, media_asset_id\)[\s\S]*REFERENCES geo\.media_assets \(tenant_id, id\)/i,
    );
    expect(inspections).toMatch(
      /FOREIGN KEY \(tenant_id, media_asset_id, asset_sha256\)[\s\S]*REFERENCES geo\.media_assets \(tenant_id, id, sha256\)/i,
    );

    expect(migrationSql).toContain("DROP CONSTRAINT media_assets_tenant_id_sha256_key");
    expect(migrationSql).toContain("UNIQUE (tenant_id, provenance_hash)");
    expect(migrationSql).toContain("brand_snapshot_hash geo.sha256_hex");
    expect(migrationSql).toContain("media_snapshot_hash geo.sha256_hex");
    expect(migrationSql).toContain("terminal media generation jobs are immutable");

    for (const tableName of [
      "media_generation_jobs",
      "media_generation_attempts",
      "content_media_bindings",
      "media_inspections",
    ]) {
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} ENABLE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} FORCE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`CREATE POLICY tenant_isolation ON geo.${tableName}`);
    }
    expect(migrationSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE[\s\S]*media_generation_attempts[\s\S]*media_assets[\s\S]*content_media_bindings[\s\S]*media_inspections FROM geo_runtime/i,
    );
  });

  it("versions tenant-scoped Brand Agent Profiles with one active document per brand", () => {
    const profiles = tableDefinition("brand_agent_profiles");
    expect(profiles).toContain("brand_id uuid NOT NULL");
    expect(profiles).toContain("version integer NOT NULL CHECK (version > 0)");
    expect(profiles).toContain("document_hash geo.sha256_hex NOT NULL");
    expect(profiles).toContain("UNIQUE (tenant_id, brand_id, version)");
    expect(profiles).toMatch(
      /FOREIGN KEY \(tenant_id, brand_id\)[\s\S]*REFERENCES geo\.brands \(tenant_id, id\)/i,
    );
    expect(migrationSql).toContain("brand_agent_profiles_one_active_per_brand");
    expect(migrationSql).toContain("brand_agent_profiles_transition_only");
    expect(migrationSql).toContain("ALTER TABLE geo.brand_agent_profiles FORCE ROW LEVEL SECURITY");
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.brand_agent_profiles");
    expect(migrationSql).toContain(
      "GRANT UPDATE (status, retired_at) ON TABLE geo.brand_agent_profiles TO geo_runtime",
    );
    expect(migrationSql).toContain("brand_agent_profile_id uuid");
    expect(migrationSql).toContain("brand_agent_profile_hash geo.sha256_hex");
    expect(migrationSql).toContain("tenant_provisioning_receipts_brand_agent_profile_fk");
  });

  it("persists governed research policies and redacted append-only capture records", () => {
    const policies = tableDefinition("research_source_policies");
    const captures = tableDefinition("research_capture_records");

    expect(policies).toContain("origin text NOT NULL");
    expect(policies).toContain("allowed_hosts text[] NOT NULL");
    expect(policies).toContain("max_bytes integer NOT NULL");
    expect(policies).toContain("timeout_ms integer NOT NULL");
    expect(policies).toContain("status IN ('active', 'retired')");
    expect(migrationSql).toContain("research_source_policies_one_active_version");
    expect(migrationSql).toContain("research_source_policies_retirement_only");

    expect(captures).toContain("request_url_hash geo.sha256_hex NOT NULL");
    expect(captures).not.toContain("requested_url");
    expect(captures).toContain("evidence_source_id uuid");
    expect(captures).toContain("result_metadata = '{}'::jsonb");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.research_capture_records FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "GRANT SELECT, INSERT ON TABLE geo.research_capture_records TO geo_runtime",
    );
  });

  it("stores tenant-scoped competitor truth and complete visibility evaluator evidence", () => {
    const competitors = tableDefinition("brand_competitors");
    expect(competitors).toContain("brand_id uuid NOT NULL");
    expect(competitors).toContain("source_type text NOT NULL");
    expect(competitors).toContain("source_ref text NOT NULL");
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.brand_competitors");

    for (const column of [
      "ALTER COLUMN request_started_at SET NOT NULL",
      "ALTER COLUMN response_received_at SET NOT NULL",
      "ALTER COLUMN sentiment SET NOT NULL",
      "ALTER COLUMN hallucination_findings SET NOT NULL",
      "ALTER COLUMN evaluator_version SET NOT NULL",
    ]) {
      expect(migrationSql).toContain(column);
    }
  });

  it("keeps tenant provisioning receipts append-only and admin-only", () => {
    const receipt = tableDefinition("tenant_provisioning_receipts");
    expect(receipt).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(receipt).toContain("request_hash geo.sha256_hex NOT NULL");
    expect(receipt).toContain("tenant_id uuid NOT NULL UNIQUE");
    expect(migrationSql).toContain("CREATE TRIGGER tenant_provisioning_receipts_append_only");
    expect(migrationSql).toContain("REVOKE ALL ON TABLE geo.tenant_provisioning_receipts");
    expect(migrationSql).not.toContain("GRANT SELECT ON geo.tenant_provisioning_receipts");
  });

  it("atomically consumes a grant and writes a job, idempotency record, outbox, and audit log", () => {
    const consume = functionDefinition("consume_publication_grant");
    expect(consume).toContain("SECURITY DEFINER");
    expect(consume).toContain("FOR UPDATE");
    expect(consume).toContain("pg_advisory_xact_lock");
    expect(consume).toContain("UPDATE geo.publication_grants");
    expect(consume).toContain("INSERT INTO geo.publication_jobs");
    expect(consume).toContain("INSERT INTO geo.idempotency_records");
    expect(consume).toContain("INSERT INTO geo.outbox_events");
    expect(consume).toContain("INSERT INTO geo.audit_log");
    expect(consume).toContain("account_row.capability NOT IN ('public_api', 'partner_api')");
  });

  it("schedules publication jobs and their outbox event at the same first-attempt time", () => {
    const consume = functionOverloadDefinition(
      "consume_publication_grant",
      "p_scheduled_for timestamptz",
    );
    expect(consume).toContain("p_execution_level text");
    expect(consume).toContain("available_at, scheduled_for");
    expect(consume).toContain("available_at");
    expect(consume).toContain("p_scheduled_for");
    expect(consume).toContain("INSERT INTO geo.outbox_events");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz) TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) TO geo_runtime",
    );
  });

  it("distinguishes missing and conflicting grant revocations under a row lock", () => {
    const revoke = latestFunctionDefinition("revoke_publication_grant");
    expect(revoke).toContain("FOR UPDATE");
    expect(revoke).toContain("ERRCODE = 'P0002'");
    expect(revoke).toContain("ERRCODE = '55000'");
  });

  it("cancels only lease-safe jobs and dead-letters their unpublished request atomically", () => {
    const cancel = latestFunctionDefinition("cancel_publication_job");
    expect(cancel).toContain("SECURITY DEFINER");
    expect(cancel).toContain("FOR UPDATE");
    expect(cancel).toContain("queued', 'retry_wait");
    expect(cancel).toContain("lease_expires_at");
    expect(cancel).toContain("event.locked_until >= statement_timestamp()");
    expect(cancel).toContain("ERRCODE = '55006'");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("UPDATE geo.outbox_events");
    expect(cancel).toContain("dead_lettered_at = clock_timestamp()");
    expect(cancel).toContain("published_at IS NULL");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.cancel_publication_job(uuid, text) TO geo_runtime",
    );
  });

  it("persists truthful dry-run disposition and rejects unsupported live readbacks", () => {
    const readbackTable = tableDefinition("publication_readbacks");
    const scheduleReadback = latestFunctionDefinition("schedule_publication_readback");
    expect(readbackTable).toContain("receipt_id uuid NOT NULL");
    expect(readbackTable).toContain("required boolean NOT NULL");
    expect(readbackTable).toContain("'not_required'");
    expect(readbackTable).toContain("'pending'");
    expect(scheduleReadback).toContain("execution_level <> 'dry_run'");
    expect(scheduleReadback).toContain("'not_required'");
    expect(scheduleReadback).toContain("'dry_run_preview_only'");
    expect(scheduleReadback).toContain("ERRCODE = '0A000'");
    expect(scheduleReadback).not.toContain("'publication.readback.requested'");
    expect(scheduleReadback).not.toContain("INSERT INTO geo.outbox_events");
    expect(migrationSql).toContain("GRANT SELECT ON geo.publication_readbacks TO geo_runtime");
    expect(migrationSql).toContain(
      "GRANT UPDATE (status, completed_at, last_error) ON geo.publication_readbacks TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "REVOKE INSERT, DELETE ON geo.publication_readbacks FROM geo_runtime",
    );
  });

  it("acquires publication execution under atomic multi-scope quotas and a single half-open probe", () => {
    const acquire = latestFunctionDefinition("acquire_publication_execution");
    expect(acquire).toContain("SECURITY DEFINER");
    expect(acquire).toContain("FOR UPDATE OF job");
    expect(acquire).toContain("geo.content_versions");
    expect(acquire).toContain("geo.content_items");
    expect(acquire).toContain("geo.publication_grants");
    expect(acquire).toContain("geo.audit_artifacts");
    expect(acquire).toContain("authorization_expired");
    expect(acquire).toContain("authorization_binding_mismatch");
    for (const scope of ["tenant", "platform", "account", "campaign", "topic"]) {
      expect(acquire).toContain(`'${scope}'`);
    }
    for (const quotaKey of [
      "maxConcurrent",
      "perMinute",
      "perDay",
      "cooldownSeconds",
      "errorBudget",
    ]) {
      expect(acquire).toContain(`'${quotaKey}'`);
    }
    expect(acquire).toContain("jsonb_object_keys");
    expect(acquire).toContain("quota_unknown");
    expect(acquire).toContain("INSERT INTO geo.publication_attempts");
    expect(acquire).toContain("state = 'dispatching'");
    expect(acquire).toContain("probe_attempt_id = p_attempt_id");
    expect(acquire).toContain("publication_execution.denied");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.acquire_publication_execution(uuid, uuid, text) TO geo_runtime",
    );
  });

  it("finishes an acquired attempt and closes or reopens its claimed circuits", () => {
    const finish = functionOverloadDefinition("finish_publication_execution", "p_outcome text");
    expect(finish).toContain("succeeded', 'failed', 'uncertain");
    expect(finish).toContain("PERFORM circuit.id");
    expect(finish.indexOf("PERFORM circuit.id")).toBeLessThan(finish.indexOf("FOR UPDATE OF job"));
    expect(finish).toContain("UPDATE geo.publication_attempts");
    expect(finish).toContain("governance_finished_at");
    expect(finish).toContain("probe_attempt_id = p_attempt_id");
    expect(finish).toContain("state = 'closed'");
    expect(finish).toContain("state = 'open'");
    expect(finish).toContain("lease_owner = NULL");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, text, text) TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, boolean, text) TO geo_runtime",
    );
  });

  it("exposes a lease-bounded dispatcher claim without table grants", () => {
    const claim = functionDefinition("claim_outbox_events");
    expect(claim).toContain("SECURITY DEFINER");
    expect(claim).toContain("SKIP LOCKED");
    expect(claim).toContain("PARTITION BY event.tenant_id");
    expect(claim).toContain("p_limit NOT BETWEEN 1 AND 100");
    expect(migrationSql).toContain("GRANT EXECUTE ON FUNCTION geo.claim_outbox_events");
  });

  it("persists dry-run automation batches, leased runs, and target checkpoints", () => {
    const batches = tableDefinition("automation_batches");
    const runs = tableDefinition("automation_runs");
    const targets = tableDefinition("automation_run_targets");

    expect(batches).toContain(
      "'scheduled', 'running', 'completed', 'partially_failed', 'cancelled'",
    );
    expect(batches).toContain("execution_level = 'dry_run'");
    expect(batches).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(runs).toContain("slot_key text NOT NULL");
    expect(runs).toContain("UNIQUE (tenant_id, batch_id, slot_key)");
    expect(runs).toContain("'scheduled', 'running', 'retry_wait', 'awaiting_delivery'");
    expect(runs).toContain("stage IN ('planning', 'draft', 'targets', 'delivery')");
    expect(runs).toContain("attempt_count integer NOT NULL DEFAULT 0");
    expect(runs).toContain("lease_owner text");
    expect(runs).toContain("heartbeat_at timestamptz");
    expect(runs).toContain("checkpoint jsonb NOT NULL");
    expect(runs).toContain("content_item_id uuid");
    expect(runs).toContain("content_version_id uuid");
    expect(targets).toContain("channel_account_id uuid NOT NULL");
    expect(targets).toContain("variant_idempotency_key text NOT NULL");
    expect(targets).toContain("audit_idempotency_key text NOT NULL");
    expect(targets).toContain("publication_idempotency_key text NOT NULL");
    expect(targets).toContain("variant_id uuid");
    expect(targets).toContain("audit_run_id uuid");
    expect(targets).toContain("audit_artifact_id uuid");
    expect(targets).toContain("publication_job_id uuid");
  });

  it("backfills automation execution only for existing managing owners and admins", () => {
    expect(migrationSql).toContain("UPDATE geo.tenant_memberships AS membership");
    expect(migrationSql).toContain("membership.role IN ('owner', 'admin')");
    expect(migrationSql).toContain("membership.capabilities @> '[\"automation:manage\"]'::jsonb");
    expect(migrationSql).toContain(
      "NOT membership.capabilities @> '[\"automation:execute\"]'::jsonb",
    );
  });

  it("persists scoped automation principals and backfills principal management", () => {
    expect(migrationSql).toContain("ALTER TABLE geo.service_principals");
    expect(migrationSql).toContain("ADD COLUMN capabilities jsonb NOT NULL");
    expect(migrationSql).toContain("ADD COLUMN profile text NOT NULL");
    expect(migrationSql).toContain("'automation_producer'");
    expect(migrationSql).toContain("service_principals_automation_profile_scope");
    expect(migrationSql).toContain("UPDATE geo.tenant_memberships AS membership");
    expect(migrationSql).toContain("'[\"principal:manage\"]'::jsonb");
    expect(migrationSql).toContain("membership.role IN ('owner', 'admin')");
  });

  it("normalizes and constrains manual channel accounts to dry-run execution", () => {
    expect(migrationSql).toContain("UPDATE geo.channel_accounts");
    expect(migrationSql).toContain("supported_execution_levels = ARRAY['dry_run']::text[]");
    expect(migrationSql).toContain("channel_accounts_manual_execution_scope");
    expect(migrationSql).toContain("capability IN ('manual_only', 'disabled')");
    expect(migrationSql).toContain("capability <> 'browser_assisted'");
  });

  it("allows only one current primary contact per tenant and contact type", () => {
    expect(migrationSql).toContain("tenant_contacts_one_current_primary_per_type");
    expect(migrationSql).toContain("ON geo.tenant_contacts (tenant_id, type)");
    expect(migrationSql).toContain("WHERE is_primary AND valid_until IS NULL");
  });

  it("allows only one active policy bundle per tenant", () => {
    expect(migrationSql).toContain("policy_bundles_one_active_per_tenant");
    expect(migrationSql).toContain("ON geo.policy_bundles (tenant_id)");
    expect(migrationSql).toContain("WHERE status = 'active'");
  });

  it("creates tenant members through a scoped audited identity function", () => {
    const createMember = latestFunctionDefinition("create_tenant_member_identity");
    expect(createMember).toContain("SECURITY DEFINER");
    expect(createMember).toContain("geo.require_tenant_id()");
    expect(createMember).toContain("geo.require_actor_id()");
    expect(createMember).toContain("actor_role NOT IN ('owner', 'admin')");
    expect(createMember).toContain("only an owner may create another owner");
    expect(createMember).toContain("INSERT INTO geo.users");
    expect(createMember).toContain("INSERT INTO geo.tenant_memberships");
    expect(createMember).toContain("INSERT INTO geo.audit_log");
    expect(createMember).toContain("tenant_member.created");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)",
    );
  });

  it("reads tenant member identities without weakening user self-isolation", () => {
    const listMembers = latestFunctionDefinition("list_tenant_member_identities");
    const getMember = latestFunctionDefinition("get_tenant_member_identity");
    for (const definition of [listMembers, getMember]) {
      expect(definition).toContain("SECURITY DEFINER");
      expect(definition).toContain("geo.require_tenant_id()");
      expect(definition).toContain("geo.require_actor_id()");
      expect(definition).toContain("actor_role NOT IN ('owner', 'admin')");
      expect(definition).toContain("membership.tenant_id = tenant_value");
      expect(definition).toContain("users.email");
      expect(definition).not.toContain("password_hash");
    }
    expect(getMember).toContain("FOR UPDATE OF membership");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.list_tenant_member_identities() TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.get_tenant_member_identity(uuid) TO geo_runtime",
    );
  });

  it("claims automation runs with expiry recovery and fail-closed governance", () => {
    const blockReason = functionDefinition("automation_run_block_reason");
    const claim = functionDefinition("claim_automation_runs");

    expect(blockReason).toContain("control_missing:tenant:*");
    expect(blockReason).toContain("control.kill_switch_enabled");
    expect(blockReason).toContain("control.mode IN ('paused', 'stopped')");
    expect(blockReason).toContain("breaker.state IN ('open', 'half_open')");
    for (const scope of ["tenant", "campaign", "topic"]) {
      expect(blockReason).toContain(`'${scope}'`);
    }
    expect(claim).toContain("SECURITY DEFINER");
    expect(claim).toContain("FOR UPDATE OF run SKIP LOCKED");
    expect(claim).toContain("run.lease_expires_at < statement_timestamp()");
    expect(claim).toContain("run.attempt_count < run.max_attempts");
    expect(claim).toContain("batch.state IN ('scheduled', 'running')");
    expect(claim).toContain("geo.automation_run_block_reason");
    expect(claim).not.toContain("geo.outbox_events");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime",
    );
  });

  it("binds substantive automation checkpoints under the active lease and gate", () => {
    const heartbeat = functionDefinition("heartbeat_automation_run");
    const draft = functionDefinition("checkpoint_automation_draft");
    const target = functionDefinition("checkpoint_automation_target");
    const reconcile = functionDefinition("reconcile_automation_run");

    expect(heartbeat).toContain("heartbeat cannot change automation run stage");
    for (const checkpoint of [draft, target]) {
      expect(checkpoint).toContain("SECURITY DEFINER");
      expect(checkpoint).toContain("FOR UPDATE");
      expect(checkpoint).toContain("run_row.lease_owner <> p_worker_id");
      expect(checkpoint).toContain("run_row.attempt_count <> p_attempt_count");
      expect(checkpoint).toContain("run_row.lease_expires_at < statement_timestamp()");
      expect(checkpoint).toContain("geo.automation_run_block_reason");
    }
    expect(draft).toContain("item.campaign_id = run_row.campaign_id");
    expect(draft).toContain("content_item_id = p_content_item_id");
    expect(target).toContain("automation target transition");
    expect(target).toContain("job.execution_level = 'dry_run'");
    expect(target).toContain("artifact.status = 'passed'");
    expect(target).toContain("audit_artifact_value IS NOT NULL AND audit_run_value IS NULL");
    expect(target).toContain("SELECT artifact.audit_run_id INTO audit_run_value");
    expect(reconcile).toContain("target.state = 'awaiting_delivery'");
    expect(reconcile).toContain("target.state IN ('pending', 'variant_ready')");
    expect(reconcile).toContain("next_state := 'partially_failed'");
    expect(reconcile).toContain("next_state := 'retry_wait'");
    expect(reconcile).toContain("lease_owner = NULL");
    expect(reconcile).toContain("geo.refresh_automation_batch_state");
    expect(reconcile).not.toContain("geo.outbox_events");
  });

  it("cancels automation without a re-claim path and denies direct state mutation", () => {
    const cancel = functionDefinition("cancel_automation_batch");
    expect(cancel).toContain("pg_advisory_xact_lock");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("lease_owner = NULL");
    expect(cancel).toContain("automation_batch.cancelled");
    expect(cancel).toContain("INSERT INTO geo.audit_log");
    expect(cancel).not.toContain("geo.outbox_events");
    expect(migrationSql).toContain(
      "REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE geo.automation_batches",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.cancel_automation_batch(uuid, text) TO geo_runtime",
    );
  });

  it("persists tenant-scoped assisted handoffs with leased operators and one-time permits", () => {
    const handoffs = tableDefinition("publication_assisted_handoffs");
    const blockReason = functionDefinition("publication_assisted_block_reason");
    const create = functionDefinition("create_publication_assisted_handoff");
    const claim = functionDefinition("claim_publication_assisted_handoff");
    const heartbeat = functionDefinition("heartbeat_publication_assisted_handoff");
    const cancel = functionDefinition("cancel_publication_assisted_handoff");
    const issuePermit = functionDefinition("issue_publication_assisted_submit_permit");
    const consumePermit = functionDefinition("consume_publication_assisted_submit_permit");

    expect(handoffs).toContain("job_id uuid NOT NULL");
    expect(handoffs).toContain("attempt_id uuid NOT NULL");
    expect(handoffs).toContain("platform text NOT NULL DEFAULT 'ctrip_community'");
    expect(handoffs).toContain("payload_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("audit_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("preview_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("adapter_version text NOT NULL");
    expect(handoffs).toContain("lease_owner_actor_id uuid");
    expect(handoffs).toContain("lease_expires_at timestamptz");
    expect(handoffs).toContain("submit_permit_hash geo.sha256_hex");
    expect(handoffs).toContain("submit_permit_expires_at timestamptz");
    expect(handoffs).toContain("submit_permit_consumed_at timestamptz");
    expect(handoffs).toContain("'draft_prepared'");
    expect(handoffs).toContain("'submitted_unconfirmed'");
    expect(handoffs).toContain("'confirmed'");
    expect(handoffs).toContain("UNIQUE (tenant_id, job_id)");
    expect(handoffs).toContain("UNIQUE (tenant_id, attempt_id)");

    expect(blockReason).toContain("job.execution_level <> 'assisted'");
    expect(blockReason).toContain("job.platform <> 'ctrip_community'");
    expect(blockReason).toContain("artifact.status <> 'passed'");
    expect(blockReason).toContain("control.kill_switch_enabled");
    expect(blockReason).toContain("control.mode IN ('shadow', 'paused', 'stopped')");
    expect(blockReason).toContain("circuit.state IN ('open', 'half_open')");
    expect(blockReason).toContain("account.capability <> 'browser_assisted'");

    expect(create).toContain("SECURITY DEFINER");
    expect(create).toContain("geo.publication_assisted_block_reason");
    expect(create).toContain("attempt.state <> 'started'");
    expect(create).toContain("INSERT INTO geo.publication_assisted_handoffs");
    expect(create).toContain("publication_assisted_handoff.created");

    expect(claim).toContain("FOR UPDATE");
    expect(claim).toContain("lease_expires_at >= statement_timestamp()");
    expect(claim).toContain("lease_owner_actor_id = actor_value");
    expect(claim).toContain("geo.publication_assisted_block_reason");
    expect(claim).toContain("LEAST(");
    expect(claim).toContain("publication_assisted_handoff.claimed");
    expect(heartbeat).toContain("lease_owner_actor_id <> actor_value");
    expect(heartbeat).toContain("lease_expires_at < statement_timestamp()");
    expect(heartbeat).toContain("geo.publication_assisted_block_reason");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("submit_permit_consumed_at IS NOT NULL");
    expect(cancel).toContain("publication_assisted_handoff.cancelled");

    expect(issuePermit).toContain("state <> 'draft_prepared'");
    expect(issuePermit).toContain("geo.publication_assisted_block_reason");
    expect(issuePermit).toContain("public.gen_random_bytes(32)");
    expect(issuePermit).toContain("submit_permit_hash");
    expect(issuePermit).toContain("interval '5 minutes'");
    expect(issuePermit).toContain("handoff.lease_expires_at");
    expect(consumePermit).toContain("public.digest(p_submit_permit, 'sha256')");
    expect(consumePermit).toContain("submit_permit_consumed_at IS NOT NULL");
    expect(consumePermit).toContain("geo.publication_assisted_block_reason");
    expect(consumePermit).toContain("lease_owner_actor_id <> actor_value");

    expect(migrationSql).toContain("CREATE TRIGGER publication_assisted_handoffs_transition_only");
    expect(migrationSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE geo\.publication_assisted_handoffs/u,
    );
  });
});
