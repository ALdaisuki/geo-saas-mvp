import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const composeUrl = new URL("../../../compose.production-db.yaml", import.meta.url);
const launcherUrl = new URL("../../../scripts/commission-production-db.sh", import.meta.url);
const serverBootstrapUrl = new URL("../../../scripts/bootstrap-linux-server.sh", import.meta.url);
const composeSource = await readFile(composeUrl, "utf8");
const launcherSource = await readFile(launcherUrl, "utf8");
const serverBootstrapSource = await readFile(serverBootstrapUrl, "utf8");
const aclReconciliationSource = await readFile(
  new URL("../../../docs/ops/postgres/reconcile-application-acls.sql", import.meta.url),
  "utf8",
);
const deploymentRunbookSource = await readFile(
  new URL("../../../docs/SERVER_DEPLOYMENT.md", import.meta.url),
  "utf8",
);
const handoffRunbookSource = await readFile(
  new URL("../../../docs/WORKSTATION_SERVER_HANDOFF.md", import.meta.url),
  "utf8",
);
const operatorRunbookSource = await readFile(
  new URL("../../../docs/ops/operator-provisioning.md", import.meta.url),
  "utf8",
);

function topLevelServiceNames(source: string): string[] {
  const servicesStart = source.indexOf("services:\n");
  const networksStart = source.indexOf("\nnetworks:\n", servicesStart);
  const volumesStart = source.indexOf("\nvolumes:\n", servicesStart);
  const servicesEnd = Math.min(
    ...[networksStart, volumesStart].filter((index) => index > servicesStart),
  );
  expect(servicesStart).toBeGreaterThanOrEqual(0);
  expect(servicesEnd).toBeGreaterThan(servicesStart);
  return [...source.slice(servicesStart, servicesEnd).matchAll(/^ {2}([a-z0-9-]+):$/gmu)].map(
    (match) => match[1] ?? "",
  );
}

function allowedLauncherKeys(source: string): string[] {
  const allowlistStart = source.indexOf("declare -Ar ALLOWED_ENV_KEYS=(");
  const allowlistEnd = source.indexOf("\n)", allowlistStart);
  expect(allowlistStart).toBeGreaterThanOrEqual(0);
  expect(allowlistEnd).toBeGreaterThan(allowlistStart);
  return [
    ...source.slice(allowlistStart, allowlistEnd).matchAll(/^ {2}\[([A-Z][A-Z0-9_]*)\]=1$/gmu),
  ].map((match) => match[1] ?? "");
}

function launcherFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

async function exerciseBootstrapPasswordScope(action: string, passwordKeyPresence: string) {
  const guardSource = launcherFunction(launcherSource, "enforce_bootstrap_password_scope");
  const harness = `
set -eu
die() {
  printf 'Production DB commissioning refused: %s\\n' "$1" >&2
  exit 1
}
${guardSource}
docker_or_database_operation() {
  printf 'operation-touched\\n'
}
enforce_bootstrap_password_scope "$1" "$2"
docker_or_database_operation
`;
  return execFileAsync("bash", [
    "-c",
    harness,
    "commissioning-scope-test",
    action,
    passwordKeyPresence,
  ]);
}

describe("Linux production DB-only commissioning contract", () => {
  it("preserves the Ctrip analytics lease ACL during production reconciliation", () => {
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) TO geo_runtime",
    );
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)",
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.claim_next_ctrip_account_analytics_refresh\(integer\)',\s*'EXECUTE'/,
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.claim_next_priority_platform_account_analytics_refresh\(integer\)',\s*'EXECUTE'/,
    );
  });

  it("preserves the manual readback reopen ACL during production reconciliation", () => {
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.reopen_publication_assisted_readback(uuid) TO geo_runtime",
    );
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.expire_priority_platform_readback_windows() TO geo_runtime",
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.reopen_publication_assisted_readback\(uuid\)',\s*'EXECUTE'/,
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.expire_priority_platform_readback_windows\(\)',\s*'EXECUTE'/,
    );
  });

  it("preserves assisted readback candidate discovery during production reconciliation", () => {
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_candidate_discovery(",
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.record_publication_assisted_candidate_discovery\(uuid,text,text\)',\s*'EXECUTE'/,
    );
  });

  it("preserves publisher-status confirmation during production reconciliation", () => {
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_status_confirmation(",
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.record_publication_assisted_publisher_status_confirmation\(uuid,geo\.sha256_hex,text,text,timestamptz\)',\s*'EXECUTE'/,
    );
  });

  it("preserves operator account lifecycle ACLs during production reconciliation", () => {
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz) TO geo_runtime",
    );
    expect(aclReconciliationSource).toContain(
      "GRANT EXECUTE ON FUNCTION geo.purge_abandoned_channel_account_automation_targets(uuid) TO geo_runtime",
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.force_calibrate_channel_account_runtime\(uuid,timestamptz\)',\s*'EXECUTE'/,
    );
    expect(aclReconciliationSource).toMatch(
      /'geo_runtime',\s*'geo\.purge_abandoned_channel_account_automation_targets\(uuid\)',\s*'EXECUTE'/,
    );
  });

  it("contains only the database and explicit one-shot commissioning services", () => {
    expect(topLevelServiceNames(composeSource)).toEqual([
      "postgres",
      "db-migrate",
      "db-bootstrap",
      "db-provision-tenant",
      "db-bootstrap-operator",
      "db-commission-ctrip-bridge",
      "db-bind-historical-publication",
    ]);
    expect(composeSource).not.toMatch(/^\s{2}(api|worker|agent-mcp|browser-host|ctrip-bridge):/mu);
    expect(composeSource).not.toContain("db-seed");
    expect(composeSource).not.toContain("fixture");
    expect(composeSource).not.toContain("ports:");
    expect(composeSource).not.toContain("network_mode:");
    expect(composeSource).toContain("internal: true");
  });

  it("shares the production bind-backed named PostgreSQL volume", () => {
    expect(composeSource).toContain("- postgres-data:/var/lib/postgresql/data");
    expect(composeSource).toContain("volumes:\n  postgres-data:");
    expect(composeSource).toContain("name: ${COMPOSE_PROJECT_NAME:-geo-saas}-postgres-data");
    expect(composeSource).toContain("device: /srv/geo-saas/data/postgres");
    expect(composeSource).not.toContain("source: /srv/geo-saas/data/postgres");
  });

  it("models postgres, migration, and role reconciliation as a fail-closed chain", () => {
    const migrateStart = composeSource.indexOf("  db-migrate:");
    const bootstrapStart = composeSource.indexOf("  db-bootstrap:");
    const tenantStart = composeSource.indexOf("  db-provision-tenant:");
    const migrateBlock = composeSource.slice(migrateStart, bootstrapStart);
    const bootstrapBlock = composeSource.slice(bootstrapStart, tenantStart);

    expect(migrateBlock).toContain("dist/cli/migrate.js");
    expect(migrateBlock).toContain("postgres:\n        condition: service_healthy");
    expect(bootstrapBlock).toContain("/bootstrap/bootstrap-login-roles.sh");
    expect(bootstrapBlock).toContain(
      "db-migrate:\n        condition: service_completed_successfully",
    );
    expect(bootstrapBlock).toContain("reconcile-application-acls.sql");
    for (const variableName of [
      "POSTGRES_DB",
      "POSTGRES_ADMIN_USER",
      "POSTGRES_ADMIN_PASSWORD",
      "GEO_API_DB_USER",
      "GEO_API_DB_PASSWORD",
      "GEO_WORKER_DB_USER",
      "GEO_WORKER_DB_PASSWORD",
      "GEO_IDENTITY_DB_USER",
      "GEO_IDENTITY_DB_PASSWORD",
    ]) {
      expect(composeSource).toContain(`\${${variableName}:?`);
    }
  });

  it("does not require tenant or operator values while the database is initialized", () => {
    for (const variableName of [
      "GEO_PROVISION_IDEMPOTENCY_KEY",
      "GEO_PROVISION_TENANT_SLUG",
      "GEO_PROVISION_LEGAL_NAME",
      "GEO_PROVISION_DISPLAY_NAME",
      "GEO_PROVISION_INDUSTRY",
      "GEO_PROVISION_DEFAULT_LOCALE",
      "GEO_PROVISION_BRAND_CANONICAL_NAME",
      "GEO_PROVISION_BRAND_DISPLAY_NAME",
      "GEO_PROVISION_CONTACTS_JSON",
      "GEO_PROVISION_WORKER_NAME",
      "GEO_BOOTSTRAP_TENANT_SLUG",
      "GEO_BOOTSTRAP_EMAIL",
      "GEO_BOOTSTRAP_DISPLAY_NAME",
      "GEO_BOOTSTRAP_PASSWORD",
      "GEO_CTRIP_BRIDGE_TENANT_SLUG",
      "GEO_CTRIP_BRIDGE_OPERATOR_EMAIL",
      "GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY",
      "GEO_CTRIP_BRIDGE_PRINCIPAL_NAME",
    ]) {
      expect(composeSource).toContain(`\${${variableName}:-}`);
      expect(composeSource).not.toContain(`\${${variableName}:?`);
    }
    expect(composeSource).not.toContain("TENANT_ID");
    expect(composeSource).not.toContain("UUID");
  });

  it("streams historical publication evidence only from the fixed server file", () => {
    const serviceStart = composeSource.indexOf("  db-bind-historical-publication:");
    const serviceBlock = composeSource.slice(serviceStart, composeSource.indexOf("\nvolumes:\n"));
    expect(serviceStart).toBeGreaterThanOrEqual(0);
    expect(serviceBlock).toContain("dist/cli/bind-historical-publication.js");
    expect(serviceBlock).toContain("/dev/stdin");
    expect(serviceBlock).not.toContain("historical-publication.json");
    expect(serviceBlock).not.toContain("volumes:");
    expect(serviceBlock).toContain(
      "db-bootstrap-operator:\n        condition: service_completed_successfully",
    );
    expect(launcherSource).toContain(
      "readonly HISTORICAL_PUBLICATION_MANIFEST=${SECRET_ROOT}/historical-publication.json",
    );
    expect(launcherSource).toContain("historical publication manifest mode must be exactly 600");
    expect(launcherSource).toContain("historical publication manifest must not have hard links");
    expect(launcherSource).toContain(
      'compose run --rm --no-deps -T db-bind-historical-publication <"${HISTORICAL_PUBLICATION_MANIFEST}"',
    );
    expect(launcherSource).not.toContain("approved deploy uid 1000");
    expect(launcherSource).not.toContain("GEO_HISTORICAL_PUBLICATION_MANIFEST_FILE");
  });

  it("commissions the Bridge identity without an input UUID, capability, account selector, or secret", () => {
    const serviceStart = composeSource.indexOf("  db-commission-ctrip-bridge:");
    const serviceEnd = composeSource.indexOf("  db-bind-historical-publication:", serviceStart);
    const serviceBlock = composeSource.slice(serviceStart, serviceEnd);
    expect(serviceStart).toBeGreaterThanOrEqual(0);
    expect(serviceBlock).toContain("dist/cli/commission-ctrip-bridge.js");
    for (const variableName of [
      "GEO_CTRIP_BRIDGE_TENANT_SLUG",
      "GEO_CTRIP_BRIDGE_OPERATOR_EMAIL",
      "GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY",
      "GEO_CTRIP_BRIDGE_PRINCIPAL_NAME",
    ]) {
      expect(serviceBlock).toContain(`${variableName}: \${${variableName}:-}`);
    }
    expect(serviceBlock).not.toContain("TENANT_ID");
    expect(serviceBlock).not.toContain("ACCOUNT_ID");
    expect(serviceBlock).not.toContain("PRINCIPAL_ID");
    expect(serviceBlock).not.toMatch(/capabilit|secret|token/iu);
  });

  it("accepts only deployment metadata plus DB, tenant, and operator commissioning keys", () => {
    expect(allowedLauncherKeys(launcherSource)).toEqual([
      "COMPOSE_PROJECT_NAME",
      "GEO_IMAGE_PREFIX",
      "GEO_IMAGE_TAG",
      "GEO_IMAGE_REVISION",
      "NODE_IMAGE",
      "NPM_REGISTRY",
      "POSTGRES_DB",
      "POSTGRES_ADMIN_USER",
      "POSTGRES_ADMIN_PASSWORD",
      "GEO_API_DB_USER",
      "GEO_API_DB_PASSWORD",
      "GEO_WORKER_DB_USER",
      "GEO_WORKER_DB_PASSWORD",
      "GEO_IDENTITY_DB_USER",
      "GEO_IDENTITY_DB_PASSWORD",
      "GEO_PROVISION_IDEMPOTENCY_KEY",
      "GEO_PROVISION_TENANT_SLUG",
      "GEO_PROVISION_LEGAL_NAME",
      "GEO_PROVISION_DISPLAY_NAME",
      "GEO_PROVISION_INDUSTRY",
      "GEO_PROVISION_DEFAULT_LOCALE",
      "GEO_PROVISION_BRAND_CANONICAL_NAME",
      "GEO_PROVISION_BRAND_DISPLAY_NAME",
      "GEO_PROVISION_CONTACTS_JSON",
      "GEO_PROVISION_WORKER_NAME",
      "GEO_BOOTSTRAP_TENANT_SLUG",
      "GEO_BOOTSTRAP_EMAIL",
      "GEO_BOOTSTRAP_DISPLAY_NAME",
      "GEO_BOOTSTRAP_PASSWORD",
      "GEO_CTRIP_BRIDGE_TENANT_SLUG",
      "GEO_CTRIP_BRIDGE_OPERATOR_EMAIL",
      "GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY",
      "GEO_CTRIP_BRIDGE_PRINCIPAL_NAME",
    ]);
    for (const forbiddenName of [
      "SESSION_SECRET",
      "PLASTIC_PROMISE_MCP_URL",
      "AGENT_PROVIDER",
      "AGENT_API_KEY",
      "MCP_PRINCIPALS_JSON",
      "CTRIP_BROWSER_TENANT_ID",
      "CTRIP_BRIDGE_TENANTS_JSON",
      "WORKER_TENANT_ACTORS_JSON",
    ]) {
      expect(launcherSource).not.toContain(`[${forbiddenName}]=1`);
      expect(composeSource).not.toContain(forbiddenName);
    }
  });

  it("enforces a deploy-owned 0600 env file, fixed data ownership, and local Docker", () => {
    expect(launcherSource).toContain("readonly DEFAULT_ENV_FILE=${SECRET_ROOT}/commissioning.env");
    expect(launcherSource).not.toContain("/srv/geo-saas/secrets/geo.env");
    expect(launcherSource).toContain('[[ "${RESOLVED_ENV_FILE}" == "${SECRET_ROOT}/"* ]]');
    expect(launcherSource).toContain("commissioning env file mode must be exactly 600");
    expect(launcherSource).toContain("commissioning env file must not have hard links");
    expect(launcherSource).toContain('require_directory "${POSTGRES_DATA_ROOT}" 999 999 700');
    expect(launcherSource).toContain('DOCKER_HOST="${LOCAL_DOCKER_HOST}"');
    expect(launcherSource).toContain("readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock");
    expect(launcherSource).toContain("COMPOSE_DISABLE_ENV_FILE=1");
    expect(launcherSource).toContain("env -i");
    expect(launcherSource).toContain("flock --nonblock 9");
    expect(launcherSource).toContain("must not reuse a NOLOGIN database role");
    expect(launcherSource).not.toMatch(/(^|\s)(source|eval)\s/mu);
  });

  it("rejects a residual bootstrap password before any Docker or database operation", async () => {
    const guardCall = launcherSource.indexOf("enforce_bootstrap_password_scope \\");
    const firstDockerProbe = launcherSource.indexOf("command -v docker");
    expect(guardCall).toBeGreaterThanOrEqual(0);
    expect(firstDockerProbe).toBeGreaterThan(guardCall);
    expect(launcherSource).toContain('"${seen_env_keys[GEO_BOOTSTRAP_PASSWORD]+present}"');

    for (const action of [
      "database",
      "provision-tenant",
      "commission-ctrip-bridge",
      "bind-historical-publication",
    ]) {
      await expect(exerciseBootstrapPasswordScope(action, "present")).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining(
          "GEO_BOOTSTRAP_PASSWORD must be absent for every action except bootstrap-operator",
        ),
      });
    }

    await expect(
      exerciseBootstrapPasswordScope("bootstrap-operator", "present"),
    ).resolves.toMatchObject({
      stdout: "operation-touched\n",
      stderr: "",
    });
    await expect(exerciseBootstrapPasswordScope("database", "")).resolves.toMatchObject({
      stdout: "operation-touched\n",
      stderr: "",
    });
  });

  it("runs each commissioning stage explicitly and never selects full production Compose", () => {
    expect(launcherSource).toContain("compose.production-db.yaml");
    expect(launcherSource).not.toContain("compose.production.yaml");
    expect(launcherSource).not.toMatch(/-f ["']?compose\.yaml/iu);
    expect(launcherSource).toContain("compose config --services");
    const expectedServicesMatch = launcherSource.match(/readonly EXPECTED_SERVICES=\$'([^']+)'/u);
    expect(expectedServicesMatch).not.toBeNull();
    const expectedServices = (expectedServicesMatch?.[1] ?? "").split("\\n");
    expect(expectedServices.toSorted()).toEqual(topLevelServiceNames(composeSource).toSorted());
    expect(launcherSource).toContain(
      'EXPECTED_SERVICES_CANONICAL="$(LC_ALL=C sort <<<"${EXPECTED_SERVICES}")"',
    );
    expect(launcherSource).toContain(
      'ACTUAL_SERVICES_CANONICAL="$(LC_ALL=C sort <<<"${ACTUAL_SERVICES}")"',
    );
    expect(launcherSource).toContain(
      '[[ "${ACTUAL_SERVICES_CANONICAL}" == "${EXPECTED_SERVICES_CANONICAL}" ]]',
    );
    expect(launcherSource).not.toContain('[[ "${ACTUAL_SERVICES}" == "${EXPECTED_SERVICES}" ]]');

    const actionStart = launcherSource.lastIndexOf('case "${ACTION}" in');
    const actionBlock = launcherSource.slice(actionStart);
    const buildIndex = launcherSource.indexOf("compose build db-migrate");
    const postgresIndex = actionBlock.indexOf("start_postgres");
    const migrateIndex = actionBlock.indexOf("compose run --rm --no-deps db-migrate");
    const bootstrapIndex = actionBlock.indexOf("compose run --rm --no-deps db-bootstrap");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(actionStart);
    expect(postgresIndex).toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeGreaterThan(postgresIndex);
    expect(bootstrapIndex).toBeGreaterThan(migrateIndex);
    expect(actionBlock).toContain("compose run --rm --no-deps db-provision-tenant");
    expect(actionBlock).toContain("compose run --rm --no-deps db-bootstrap-operator");
    expect(actionBlock).toContain("compose run --rm --no-deps db-commission-ctrip-bridge");
    expect(actionBlock).toContain("compose run --rm --no-deps -T db-bind-historical-publication");
    expect(launcherSource).toContain("Reusing the healthy PostgreSQL container");
    expect(launcherSource).toContain("compose ps --all --quiet postgres");
    expect(launcherSource).toContain("docker_local start");
    expect(launcherSource).toContain("validate_postgres_volume false");
    expect(launcherSource).toContain("validate_postgres_volume true");
    expect(launcherSource).toContain("validate_postgres_container_mount");
    expect(launcherSource).toContain("{{.Type}}|{{.Name}}|{{.RW}}");
    expect(launcherSource).toContain('index .Options "device"');
    expect(launcherSource).toContain('"${option_device}" == "${POSTGRES_DATA_ROOT}"');
    expect(composeSource).toContain("- GEO_IMAGE_REVISION");
    expect(launcherSource).toContain(
      "GEO_IMAGE_REVISION must be the exact lowercase 40-character release commit",
    );
    expect(launcherSource).toContain('index .Config.Labels "org.opencontainers.image.revision"');
    expect(composeSource).toContain(
      "${GEO_IMAGE_PREFIX:-geo-saas}-db-tools-commissioning:${GEO_IMAGE_TAG:-local}",
    );
    expect(launcherSource).toContain(
      "built commissioning DB tools image revision does not match GEO_IMAGE_REVISION",
    );
    expect(launcherSource).toContain('expected_ref="${IMAGE_PREFIX}-${image_suffix}:${IMAGE_TAG}"');
    expect(launcherSource).toContain(
      'rendered_refs="$(compose config --images "${service_name}")"',
    );
    expect(launcherSource).toContain('[[ "${matches}" == 1 ]]');
    expect(launcherSource).toContain(
      'DB_TOOLS_IMAGE_REF="$(resolve_project_image_ref db-migrate db-tools-commissioning)"',
    );
    expect(launcherSource).not.toContain(
      'DB_TOOLS_IMAGE_REF="$(compose config --images db-migrate)"',
    );
    expect(launcherSource).toContain("readonly RELEASE_MARKER=${ROOT_DIR}/.geo-release");
    expect(launcherSource).toContain("release marker mode must be exactly 444");
    expect(launcherSource).toContain(
      "GEO_IMAGE_REVISION does not match the immutable release marker",
    );
    expect(launcherSource).toContain("GEO_IMAGE_TAG must equal the immutable release commit");
    expect(launcherSource.indexOf("release marker mode must be exactly 444")).toBeLessThan(
      launcherSource.indexOf("docker_local compose version"),
    );
  });

  it("documents the DB-first handoff without a fixture or pre-existing tenant UUID", () => {
    for (const source of [deploymentRunbookSource, handoffRunbookSource, operatorRunbookSource]) {
      expect(source).toContain("commission-production-db.sh database");
      expect(source).toContain("commission-production-db.sh provision-tenant");
      expect(source).toContain("commission-production-db.sh bootstrap-operator");
      expect(source).toContain("commission-production-db.sh commission-ctrip-bridge");
      expect(source.indexOf("commission-production-db.sh database")).toBeLessThan(
        source.indexOf("commission-production-db.sh provision-tenant"),
      );
      expect(source.indexOf("commission-production-db.sh provision-tenant")).toBeLessThan(
        source.indexOf("commission-production-db.sh bootstrap-operator"),
      );
      expect(source.indexOf("commission-production-db.sh bootstrap-operator")).toBeLessThan(
        source.indexOf("commission-production-db.sh commission-ctrip-bridge"),
      );
    }
    for (const source of [deploymentRunbookSource, handoffRunbookSource]) {
      expect(source).toContain("commission-production-db.sh bind-historical-publication");
      expect(source.indexOf("commission-production-db.sh bootstrap-operator")).toBeLessThan(
        source.indexOf("commission-production-db.sh bind-historical-publication"),
      );
    }
    expect(deploymentRunbookSource).toContain("/srv/geo-saas/secrets/commissioning.env");
    expect(deploymentRunbookSource).toContain("No tenant UUID is accepted as an input");
    expect(deploymentRunbookSource).toContain(
      "`COMPOSE_PROJECT_NAME`, `GEO_IMAGE_PREFIX`, `GEO_IMAGE_TAG`, and `GEO_IMAGE_REVISION` identical",
    );
    expect(handoffRunbookSource).toContain("This path starts PostgreSQL only");
    expect(operatorRunbookSource).toContain("tenant UUID");
    expect(serverBootstrapSource).toContain(
      "commissioning.env as %s with mode 0600 and run DB-only commissioning first",
    );
    expect(serverBootstrapSource).toContain(
      "Create the separate geo.env only after commissioning emits the real tenant and worker IDs",
    );
  });

  it("documents permission-safe immutable release extraction", () => {
    const transferStart = handoffRunbookSource.indexOf("## Transfer an immutable release");
    const transferEnd = handoffRunbookSource.indexOf(
      "## Commission the production database",
      transferStart,
    );
    expect(transferStart).toBeGreaterThanOrEqual(0);
    expect(transferEnd).toBeGreaterThan(transferStart);
    const transfer = handoffRunbookSource.slice(transferStart, transferEnd);

    expect(transfer).toContain("set -Eeuo pipefail; umask 022");
    expect(transfer).toContain("-type d -perm /022 -exec chmod go-w -- {} +");
    expect(transfer).toContain("-type f -perm /022 -exec chmod go-w -- {} +");
    expect(transfer).toContain("-xdev -perm /022 -print -quit");
    expect(transfer).toContain("if test -L /srv/geo-saas/app/current");
    expect(transfer).toContain(
      '\\"\\${release_dir}/scripts/rollback-production-release.sh\\" --forward',
    );
    expect(transfer).toContain("test ! -e /srv/geo-saas/app/current");
    expect(transfer).toContain("ln -s releases/${release} /srv/geo-saas/app/current");
    expect(transfer.indexOf("tar -xzf")).toBeLessThan(transfer.indexOf("chmod go-w"));
    expect(transfer.indexOf("chmod go-w")).toBeLessThan(
      transfer.indexOf("rollback-production-release.sh"),
    );
    expect(transfer.indexOf("rollback-production-release.sh")).toBeLessThan(
      transfer.indexOf("ln -s releases/"),
    );
  });

  it("is valid Bash", async () => {
    await expect(execFileAsync("bash", ["-n", fileURLToPath(launcherUrl)])).resolves.toMatchObject({
      stderr: "",
    });
  });
});
