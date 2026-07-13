import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, migrateToLatest, seedDatabase, SEED_IDS } from "../src/index.js";

const databaseName = "geo_saas_test";
const password = "geo-test-postgres-password";
const actorId = SEED_IDS.zhongtong.actor;
const tenantId = SEED_IDS.zhongtong.tenant;
const syntheticTenantId = SEED_IDS.synthetic.tenant;

const ids = {
  campaign: "30000000-0000-4000-8000-000000000001",
  contentItem: "30000000-0000-4000-8000-000000000002",
  contentVersion: "30000000-0000-4000-8000-000000000003",
  variant: "30000000-0000-4000-8000-000000000004",
  auditRun: "30000000-0000-4000-8000-000000000005",
  auditArtifact: "30000000-0000-4000-8000-000000000006",
  grant: "30000000-0000-4000-8000-000000000007",
};

const payloadHash = "a".repeat(64);
const factHash = "b".repeat(64);
const policyHash = "c".repeat(64);
const auditHash = "d".repeat(64);
const tokenHash = "e".repeat(64);
const requestHash = "f".repeat(64);

interface GrantConsumptionRow {
  publication_job_id: string;
  publication_outbox_event_id: string;
  was_created: boolean;
}

let adminClient: Client | undefined;
let databaseDir: string | undefined;
let pgControlPath: string | undefined;
let postgresStarted = false;

async function executeFile(file: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const process = spawn(file, arguments_, {
      stdio: "ignore",
      windowsHide: true,
    });
    process.once("error", rejectPromise);
    process.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${file} ${arguments_.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function resolvePgControl(): Promise<string> {
  const platformPackage =
    process.platform === "win32" && process.arch === "x64"
      ? "@embedded-postgres/windows-x64"
      : process.platform === "linux" && process.arch === "x64"
        ? "@embedded-postgres/linux-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "@embedded-postgres/linux-arm64"
          : process.platform === "darwin" && process.arch === "x64"
            ? "@embedded-postgres/darwin-x64"
            : process.platform === "darwin" && process.arch === "arm64"
              ? "@embedded-postgres/darwin-arm64"
              : undefined;
  if (platformPackage === undefined) {
    throw new Error(`Unsupported embedded PostgreSQL platform ${process.platform}/${process.arch}`);
  }

  const requireFromEmbeddedPostgres = createRequire(import.meta.resolve("embedded-postgres"));
  const platformModulePath = requireFromEmbeddedPostgres.resolve(platformPackage);
  const moduleValue: unknown = await import(pathToFileURL(platformModulePath).href);
  if (moduleValue === null || typeof moduleValue !== "object") {
    throw new Error(`Invalid PostgreSQL binary package: ${platformPackage}`);
  }
  const pgControl = (moduleValue as { pg_ctl?: unknown }).pg_ctl;
  if (typeof pgControl !== "string") {
    throw new Error(`PostgreSQL binary package ${platformPackage} does not export pg_ctl`);
  }
  return pgControl;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a PostgreSQL test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function runtimeTransaction<T>(
  operation: (client: Client) => Promise<T>,
  options: { commit?: boolean; tenant?: string; actor?: string } = {},
): Promise<T> {
  if (adminClient === undefined) {
    throw new Error("PostgreSQL test client is not initialized");
  }

  await adminClient.query("BEGIN");
  try {
    await adminClient.query("SET LOCAL ROLE geo_runtime");
    await adminClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
      [options.tenant ?? tenantId, options.actor ?? actorId, "integration-test"],
    );
    const result = await operation(adminClient);
    await adminClient.query(options.commit === false ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await adminClient.query("ROLLBACK");
    throw error;
  }
}

async function insertAuditedVariantAndGrant(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
      [tenantId, actorId],
    );
    await client.query(
      `INSERT INTO geo.campaigns
         (tenant_id, id, brand_id, name, objective, industry, topic_key)
       VALUES ($1, $2, $3, 'Integration campaign', 'Prove grant atomicity', 'travel', 'integration')`,
      [tenantId, ids.campaign, SEED_IDS.zhongtong.brand],
    );
    await client.query(
      `INSERT INTO geo.content_items
         (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
       VALUES ($1, $2, $3, $4, 'Audited article', 'evidence', 'audited', 'integration')`,
      [tenantId, ids.contentItem, ids.campaign, SEED_IDS.zhongtong.brand],
    );
    await client.query(
      `INSERT INTO geo.content_versions
         (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
          payload_hash, created_by_actor_id, frozen_at)
       VALUES ($1, $2, $3, 1, 'Verified summary', '# Verified article', '{}'::jsonb,
               $4, $5, clock_timestamp())`,
      [tenantId, ids.contentVersion, ids.contentItem, payloadHash, actorId],
    );
    await client.query(
      `INSERT INTO geo.publication_variants
         (tenant_id, id, content_version_id, channel_account_id, platform,
          variant_version, payload, payload_hash, state, frozen_at)
       VALUES ($1, $2, $3, $4, 'toutiao', 1, '{}'::jsonb, $5, 'frozen', clock_timestamp())`,
      [tenantId, ids.variant, ids.contentVersion, SEED_IDS.zhongtong.toutiao, payloadHash],
    );
    await client.query(
      `INSERT INTO geo.audit_runs
         (tenant_id, id, variant_id, policy_bundle_id, status, requested_by_actor_id,
          completed_at)
       VALUES ($1, $2, $3, $4, 'passed', $5, clock_timestamp())`,
      [tenantId, ids.auditRun, ids.variant, SEED_IDS.zhongtong.policy, actorId],
    );
    await client.query(
      `INSERT INTO geo.audit_artifacts
         (tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
          payload_hash, fact_snapshot_hash, policy_hash, policy_version, audit_hash,
          status, findings, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8, 'travel-v1', $9,
               'passed', '[]'::jsonb, clock_timestamp() + interval '10 minutes')`,
      [
        tenantId,
        ids.auditArtifact,
        ids.auditRun,
        ids.variant,
        SEED_IDS.zhongtong.toutiao,
        payloadHash,
        factHash,
        policyHash,
        auditHash,
      ],
    );
    await client.query(
      `INSERT INTO geo.publication_grants
         (tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
          payload_hash, audit_hash, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8,
               clock_timestamp() + interval '5 minutes')`,
      [
        tenantId,
        ids.grant,
        ids.auditArtifact,
        ids.variant,
        SEED_IDS.zhongtong.toutiao,
        payloadHash,
        auditHash,
        tokenHash,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  const port = await availablePort();
  databaseDir = await mkdtemp(join(tmpdir(), "geo-saas-postgres-"));
  const initializer = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password,
    authMethod: "scram-sha-256",
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-F"],
    createPostgresUser: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await initializer.initialise();
  pgControlPath = await resolvePgControl();
  await executeFile(pgControlPath, [
    "-D",
    databaseDir,
    "-l",
    join(databaseDir, "postgres.log"),
    "-o",
    `-p ${port} -F`,
    "-w",
    "start",
  ]);
  postgresStarted = true;

  const bootstrapClient = new Client({
    user: "postgres",
    password,
    port,
    host: "127.0.0.1",
    database: "postgres",
  });
  await bootstrapClient.connect();
  try {
    await bootstrapClient.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await bootstrapClient.end();
  }

  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`;
  const database = createDatabase({ connectionString, applicationName: "geo-db-integration" });
  const migration = await migrateToLatest(database);
  if (migration.error !== undefined) {
    await database.destroy();
    throw migration.error;
  }
  await seedDatabase(database);
  await database.destroy();

  adminClient = new Client({
    user: "postgres",
    password,
    port,
    host: "127.0.0.1",
    database: databaseName,
  });
  await adminClient.connect();
}, 120_000);

afterAll(async () => {
  if (adminClient !== undefined) {
    await adminClient.end();
  }
  if (postgresStarted && pgControlPath !== undefined && databaseDir !== undefined) {
    await executeFile(pgControlPath, ["-D", databaseDir, "-m", "fast", "-w", "stop"]);
    postgresStarted = false;
  }
  if (databaseDir !== undefined) {
    const tempRoot = `${resolve(tmpdir())}${sep}`;
    const resolvedDatabaseDir = resolve(databaseDir);
    if (!resolvedDatabaseDir.startsWith(`${tempRoot}geo-saas-postgres-`)) {
      throw new Error(`Refusing to remove unexpected PostgreSQL path: ${resolvedDatabaseDir}`);
    }
    await rm(resolvedDatabaseDir, { recursive: true, force: true });
  }
}, 120_000);

describe("real PostgreSQL tenant and publication invariants", () => {
  it("applies every migration and seeds exact Zhongtong contact facts", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const migrations = await adminClient.query<{ name: string }>(
      "SELECT name FROM geo.kysely_migration ORDER BY name",
    );
    const contacts = await adminClient.query<{ value: string }>(
      "SELECT value FROM geo.tenant_contacts WHERE tenant_id = $1 ORDER BY value",
      [tenantId],
    );

    expect(migrations.rows.map((row) => row.name)).toEqual([
      "0001_foundation",
      "0002_identity_and_tenant",
      "0003_content_and_governance",
      "0004_delivery_and_visibility",
      "0005_security_and_publication",
    ]);
    expect(contacts.rows.map((row) => row.value)).toEqual(["4001133986", "ZTGL3411", "ZTGL6431"]);
  });

  it("forces geo_runtime RLS for reads and cross-tenant writes", async () => {
    const ownContacts = await runtimeTransaction(
      async (client) =>
        client.query<{ value: string }>("SELECT value FROM geo.tenant_contacts ORDER BY value"),
      { commit: false },
    );
    expect(ownContacts.rows.map((row) => row.value)).toEqual([
      "4001133986",
      "ZTGL3411",
      "ZTGL6431",
    ]);

    const hidden = await runtimeTransaction(
      async (client) =>
        client.query("SELECT id FROM geo.tenant_contacts WHERE tenant_id = $1", [
          syntheticTenantId,
        ]),
      { commit: false },
    );
    expect(hidden.rowCount).toBe(0);

    await expect(
      runtimeTransaction(async (client) =>
        client.query(
          `INSERT INTO geo.tenant_contacts
             (tenant_id, id, type, label, value, normalized_value, valid_from)
           VALUES ($1, gen_random_uuid(), 'phone', 'cross tenant', '4001111111',
                   '4001111111', clock_timestamp())`,
          [syntheticTenantId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("atomically consumes one grant, replays the same request, and rejects reuse", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await insertAuditedVariantAndGrant(adminClient);

    const first = await runtimeTransaction((client) =>
      client.query<GrantConsumptionRow>(
        "SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run')",
        [ids.grant, tokenHash, "publish-once", requestHash],
      ),
    );
    expect(first.rows[0]?.was_created).toBe(true);
    const jobId = first.rows[0]?.publication_job_id;
    const outboxEventId = first.rows[0]?.publication_outbox_event_id;

    const replay = await runtimeTransaction((client) =>
      client.query<GrantConsumptionRow>(
        "SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run')",
        [ids.grant, tokenHash, "publish-once", requestHash],
      ),
    );
    expect(replay.rows[0]).toEqual({
      publication_job_id: jobId,
      publication_outbox_event_id: outboxEventId,
      was_created: false,
    });

    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run')", [
          ids.grant,
          tokenHash,
          "publish-conflict",
          "1".repeat(64),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const persisted = await adminClient.query<{
      grant_status: string;
      jobs: string;
      events: string;
    }>(
      `SELECT grant_row.status AS grant_status,
              (SELECT count(*)::text FROM geo.publication_jobs WHERE grant_id = $1) AS jobs,
              (SELECT count(*)::text FROM geo.outbox_events WHERE aggregate_id = $2) AS events
       FROM geo.publication_grants AS grant_row
       WHERE grant_row.id = $1`,
      [ids.grant, jobId],
    );
    expect(persisted.rows[0]).toEqual({ grant_status: "consumed", jobs: "1", events: "1" });
  });

  it("enforces append-only audit artifacts even for the migration owner", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await expect(
      adminClient.query("UPDATE geo.audit_artifacts SET findings = '[]'::jsonb WHERE id = $1", [
        ids.auditArtifact,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
