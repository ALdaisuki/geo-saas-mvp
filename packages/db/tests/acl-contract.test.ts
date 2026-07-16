import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const aclFile = `${repositoryRoot}docs/ops/postgres/reconcile-application-acls.sql`;
const rolesFile = `${repositoryRoot}docs/ops/postgres/ensure-application-roles.sql`;
const bootstrapFile = `${repositoryRoot}docs/ops/postgres/bootstrap-login-roles.sh`;
const composeFile = `${repositoryRoot}compose.yaml`;

let aclSql = "";
let rolesSql = "";
let bootstrapScript = "";
let composeYaml = "";

beforeAll(async () => {
  [aclSql, rolesSql, bootstrapScript, composeYaml] = await Promise.all([
    readFile(aclFile, "utf8"),
    readFile(rolesFile, "utf8"),
    readFile(bootstrapFile, "utf8"),
    readFile(composeFile, "utf8"),
  ]);
});

describe("replayable application ACL contract", () => {
  it("recreates and hardens every NOLOGIN application role", () => {
    for (const role of ["geo_runtime", "geo_dispatcher", "geo_identity"]) {
      expect(rolesSql).toContain(`CREATE ROLE ${role} NOLOGIN`);
      expect(rolesSql).toContain(
        `ALTER ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
    }
  });

  it("replays the table and function allowlists with restrictive exceptions", () => {
    expect(aclSql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity",
    );
    expect(aclSql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA geo TO geo_runtime",
    );
    expect(aclSql).toContain(
      "REVOKE UPDATE, DELETE ON geo.audit_artifacts, geo.publication_receipts",
    );
    expect(aclSql).toContain(
      "GRANT UPDATE (status, completed_at, last_error) ON geo.publication_readbacks TO geo_runtime",
    );
    expect(aclSql).toContain(
      "REVOKE ALL ON TABLE geo.publication_assisted_handoffs FROM geo_runtime",
    );
    expect(aclSql).toContain("GRANT SELECT ON geo.publication_assisted_handoffs TO geo_runtime");
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_outbox_events(text, integer, integer) TO geo_dispatcher",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.find_login_identity(text) TO geo_identity",
    );
    expect(aclSql).toContain("REVOKE ALL ON geo.tenant_provisioning_receipts FROM geo_runtime");
    expect(aclSql).toContain(
      "REVOKE UPDATE, DELETE ON geo.automation_batches, geo.automation_runs",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_target(uuid, uuid, text, integer, text",
    );
    expect(aclSql).toContain(
      "GRANT UPDATE (status, retired_at, retired_by_actor_id, retirement_reason)",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.research_allowed_hosts_valid(text[]) TO geo_runtime",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.list_tenant_member_identities() TO geo_runtime",
    );
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.get_tenant_member_identity(uuid) TO geo_runtime",
    );
    expect(aclSql).toContain("GRANT EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(");
    expect(aclSql).toContain("uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz");
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(",
    );
    expect(aclSql).toContain("uuid, geo.sha256_hex, geo.sha256_hex, text, text");
    expect(aclSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text)",
    );
    expect(aclSql).toContain(
      "REVOKE ALL ON geo.media_generation_jobs, geo.media_generation_attempts",
    );
    expect(aclSql).toContain(
      "GRANT SELECT, INSERT ON geo.media_generation_attempts, geo.media_assets",
    );
    expect(aclSql).toContain("application ACL reconciliation failed");
  });

  it("is executed by db-bootstrap and mounted read-only by Compose", () => {
    expect(bootstrapScript).toContain("ACL_RECONCILIATION_FILE");
    expect(bootstrapScript).toContain("APPLICATION_ROLES_FILE");
    expect(bootstrapScript).toContain('--file="${APPLICATION_ROLES_FILE}"');
    expect(bootstrapScript).toContain('--file="${ACL_RECONCILIATION_FILE}"');
    expect(composeYaml).toContain("db-restore-roles:");
    expect(composeYaml).toContain(
      "./docs/ops/postgres/ensure-application-roles.sql:/bootstrap/ensure-application-roles.sql:ro",
    );
    expect(composeYaml).toContain(
      "./docs/ops/postgres/reconcile-application-acls.sql:/bootstrap/reconcile-application-acls.sql:ro",
    );
  });
});
