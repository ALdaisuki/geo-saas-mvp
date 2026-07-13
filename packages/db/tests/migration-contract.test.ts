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
  "tenant_contacts",
  "policy_bundles",
  "automation_controls",
  "channel_accounts",
  "campaigns",
  "claim_facts",
  "evidence_sources",
  "content_items",
  "content_versions",
  "media_assets",
  "publication_variants",
  "audit_runs",
  "audit_artifacts",
  "publication_grants",
  "audit_log",
  "publication_jobs",
  "publication_attempts",
  "publication_receipts",
  "outbox_events",
  "inbox_events",
  "idempotency_records",
  "circuit_breakers",
  "query_sets",
  "query_set_versions",
  "visibility_runs",
  "visibility_observations",
  "visibility_metrics",
] as const;

const tenantTables = expectedTables.filter(
  (tableName) => tableName !== "users" && tableName !== "tenants",
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
    for (const tableName of tenantTables) {
      expect(rlsPrefix, tableName).toContain(`'${tableName}'`);
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
    ]) {
      expect(migrationSql).toContain(`CREATE TRIGGER ${triggerName}`);
    }
    expect(migrationSql).toContain("EXECUTE FUNCTION geo.prevent_append_only_mutation()");
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

  it("exposes a lease-bounded dispatcher claim without table grants", () => {
    const claim = functionDefinition("claim_outbox_events");
    expect(claim).toContain("SECURITY DEFINER");
    expect(claim).toContain("SKIP LOCKED");
    expect(claim).toContain("PARTITION BY event.tenant_id");
    expect(claim).toContain("p_limit NOT BETWEEN 1 AND 100");
    expect(migrationSql).toContain("GRANT EXECUTE ON FUNCTION geo.claim_outbox_events");
  });
});
