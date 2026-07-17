import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import { buildBaselineAuditPolicyDocument, sha256Canonical, sha256Text } from "@geo/core";
import { travelQuerySetPromptsV1 } from "@geo/visibility";
import { Migrator, sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  defaultMigrationDirectory,
  migrateToLatest,
  provisionTenant,
  seedDatabase,
  SEED_IDS,
  SqlFileMigrationProvider,
  TenantProvisioningConflictError,
  type ProvisionTenantInput,
} from "../src/index.js";

const databaseName = "geo_saas_test";
const password = "geo-test-postgres-password";
const aclReconciliationFile = fileURLToPath(
  new URL("../../../docs/ops/postgres/reconcile-application-acls.sql", import.meta.url),
);
const applicationRolesFile = fileURLToPath(
  new URL("../../../docs/ops/postgres/ensure-application-roles.sql", import.meta.url),
);
const actorId = SEED_IDS.zhongtong.actor;
const tenantId = SEED_IDS.zhongtong.tenant;
const syntheticTenantId = SEED_IDS.synthetic.tenant;
const legacyCapabilityTenantId = "21000000-0000-4000-8000-000000000001";
const legacyCapabilityMembers = {
  owner: "21000000-0000-4000-8000-000000000002",
  admin: "21000000-0000-4000-8000-000000000003",
  editor: "21000000-0000-4000-8000-000000000004",
  adminWithoutManage: "21000000-0000-4000-8000-000000000005",
  ownerWithExecute: "21000000-0000-4000-8000-000000000006",
} as const;

const ids = {
  campaign: "30000000-0000-4000-8000-000000000001",
  contentItem: "30000000-0000-4000-8000-000000000002",
  contentVersion: "30000000-0000-4000-8000-000000000003",
  variant: "30000000-0000-4000-8000-000000000004",
  auditRun: "30000000-0000-4000-8000-000000000005",
  auditArtifact: "30000000-0000-4000-8000-000000000006",
  grant: "30000000-0000-4000-8000-000000000007",
  revokeGrant: "30000000-0000-4000-8000-000000000008",
  cancelGrant: "30000000-0000-4000-8000-000000000009",
  leasedGrant: "30000000-0000-4000-8000-000000000010",
  previewAttempt: "30000000-0000-4000-8000-000000000011",
  previewReceipt: "30000000-0000-4000-8000-000000000012",
  liveJob: "30000000-0000-4000-8000-000000000013",
  liveAttempt: "30000000-0000-4000-8000-000000000014",
  liveReceipt: "30000000-0000-4000-8000-000000000015",
  quotaJobA: "30000000-0000-4000-8000-000000000016",
  quotaJobB: "30000000-0000-4000-8000-000000000017",
  quotaAttemptA: "30000000-0000-4000-8000-000000000018",
  quotaAttemptB: "30000000-0000-4000-8000-000000000019",
  probeJobA: "30000000-0000-4000-8000-000000000020",
  probeJobB: "30000000-0000-4000-8000-000000000021",
  probeAttemptA: "30000000-0000-4000-8000-000000000022",
  probeAttemptB: "30000000-0000-4000-8000-000000000023",
  cancelledAttempt: "30000000-0000-4000-8000-000000000024",
  harmfulJob: "30000000-0000-4000-8000-000000000025",
  harmfulAttempt: "30000000-0000-4000-8000-000000000026",
  displacedProbeJob: "30000000-0000-4000-8000-000000000027",
  displacedProbeAttempt: "30000000-0000-4000-8000-000000000028",
  concurrentProbeJob: "30000000-0000-4000-8000-000000000029",
  concurrentProbeAttempt: "30000000-0000-4000-8000-000000000030",
  concurrentCandidateJob: "30000000-0000-4000-8000-000000000031",
  concurrentCandidateAttempt: "30000000-0000-4000-8000-000000000032",
  expiredAuthorizationJob: "30000000-0000-4000-8000-000000000033",
  expiredAuthorizationAttempt: "30000000-0000-4000-8000-000000000034",
  variantConcurrencyCampaign: "30000000-0000-4000-8000-000000000035",
  variantConcurrencyContentItem: "30000000-0000-4000-8000-000000000036",
  variantConcurrencyContentVersion: "30000000-0000-4000-8000-000000000037",
  variantConcurrencyFirst: "30000000-0000-4000-8000-000000000038",
  variantConcurrencySecond: "30000000-0000-4000-8000-000000000039",
  siblingCampaign: "30000000-0000-4000-8000-000000000040",
  siblingContentItem: "30000000-0000-4000-8000-000000000041",
  siblingContentVersion: "30000000-0000-4000-8000-000000000042",
  siblingEarlierVariant: "30000000-0000-4000-8000-000000000043",
  siblingCurrentVariant: "30000000-0000-4000-8000-000000000044",
  siblingLaterVariant: "30000000-0000-4000-8000-000000000045",
  idempotentContentItemFirst: "30000000-0000-4000-8000-000000000046",
  idempotentContentVersionFirst: "30000000-0000-4000-8000-000000000047",
  idempotentContentItemSecond: "30000000-0000-4000-8000-000000000048",
  idempotentContentVersionSecond: "30000000-0000-4000-8000-000000000049",
  idempotentCampaign: "30000000-0000-4000-8000-000000000050",
  automationCampaign: "30000000-0000-4000-8000-000000000051",
  automationBatch: "30000000-0000-4000-8000-000000000052",
  automationRunA: "30000000-0000-4000-8000-000000000053",
  automationRunB: "30000000-0000-4000-8000-000000000054",
  automationTargetA: "30000000-0000-4000-8000-000000000055",
  automationTargetB: "30000000-0000-4000-8000-000000000056",
  automationContentItem: "30000000-0000-4000-8000-000000000057",
  automationContentVersion: "30000000-0000-4000-8000-000000000058",
  automationVariant: "30000000-0000-4000-8000-000000000059",
  automationLeaseBatch: "30000000-0000-4000-8000-000000000060",
  automationLeaseRun: "30000000-0000-4000-8000-000000000061",
  automationCircuitBatch: "30000000-0000-4000-8000-000000000062",
  automationCircuitRun: "30000000-0000-4000-8000-000000000063",
  automationDeliveryBatch: "30000000-0000-4000-8000-000000000064",
  automationDeliveryRun: "30000000-0000-4000-8000-000000000065",
  automationPendingTarget: "30000000-0000-4000-8000-000000000066",
  automationLeaseTarget: "30000000-0000-4000-8000-000000000067",
  automationAuditRun: "30000000-0000-4000-8000-000000000068",
  automationAuditArtifact: "30000000-0000-4000-8000-000000000069",
  campaignLifecycle: "30000000-0000-4000-8000-000000000070",
  campaignLifecycleIsolation: "30000000-0000-4000-8000-000000000071",
  governanceContact: "30000000-0000-4000-8000-000000000072",
  governanceUser: "30000000-0000-4000-8000-000000000073",
  governanceMembership: "30000000-0000-4000-8000-000000000074",
  governancePolicy: "30000000-0000-4000-8000-000000000075",
  governanceAccount: "30000000-0000-4000-8000-000000000076",
  governancePrincipal: "30000000-0000-4000-8000-000000000077",
  mediaCampaign: "30000000-0000-4000-8000-000000000078",
  mediaContentItem: "30000000-0000-4000-8000-000000000079",
  mediaSourceVersion: "30000000-0000-4000-8000-000000000080",
  mediaJob: "30000000-0000-4000-8000-000000000081",
  mediaAttempt: "30000000-0000-4000-8000-000000000082",
  mediaAsset: "30000000-0000-4000-8000-000000000083",
  mediaInspection: "30000000-0000-4000-8000-000000000084",
  mediaBinding: "30000000-0000-4000-8000-000000000085",
  mediaSuccessorVersion: "30000000-0000-4000-8000-000000000086",
  mediaJobWithDifferentRights: "30000000-0000-4000-8000-000000000087",
  mediaAttemptWithDifferentRights: "30000000-0000-4000-8000-000000000088",
  mediaAssetWithDifferentRights: "30000000-0000-4000-8000-000000000089",
  mediaInspectionWithDifferentRights: "30000000-0000-4000-8000-000000000090",
  mediaBindingWithDifferentRights: "30000000-0000-4000-8000-000000000091",
  mediaSuccessorVersionWithDifferentRights: "30000000-0000-4000-8000-000000000092",
  mediaFailedJob: "30000000-0000-4000-8000-000000000093",
  mediaReplayJob: "30000000-0000-4000-8000-000000000094",
  mediaVariant: "30000000-0000-4000-8000-000000000095",
  mediaTamperedVariant: "30000000-0000-4000-8000-000000000096",
  ctripAssistedVariant: "30000000-0000-4000-8000-000000000097",
  ctripAssistedAuditRun: "30000000-0000-4000-8000-000000000098",
  ctripAssistedAuditArtifact: "30000000-0000-4000-8000-000000000099",
  ctripAssistedGrant: "30000000-0000-4000-8000-000000000100",
  ctripAssistedJob: "30000000-0000-4000-8000-000000000101",
  ctripAssistedAttempt: "30000000-0000-4000-8000-000000000102",
  ctripAssistedHandoff: "30000000-0000-4000-8000-000000000103",
  ctripAssistedCampaign: "30000000-0000-4000-8000-000000000104",
  ctripAssistedContentItem: "30000000-0000-4000-8000-000000000105",
  ctripAssistedContentVersion: "30000000-0000-4000-8000-000000000106",
  ctripAssistedOtherActor: "30000000-0000-4000-8000-000000000107",
  ctripBridgePrincipal: "30000000-0000-4000-8000-000000000108",
  ctripDisabledBridgePrincipal: "30000000-0000-4000-8000-000000000109",
  ctripCrossTenantBridgePrincipal: "30000000-0000-4000-8000-000000000110",
};

const payloadHash = "a".repeat(64);
const factHash = "b".repeat(64);
const policyHash = "c".repeat(64);
const auditHash = "d".repeat(64);
const tokenHash = "e".repeat(64);
const requestHash = "f".repeat(64);

interface VariantRepositoryForTest {
  transitionCampaign(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      campaignId: string;
      targetStatus: "active" | "paused" | "completed";
      reason: string | null;
      auditHash: string;
    },
  ): Promise<{
    campaign: { id: string; status: "draft" | "active" | "paused" | "completed" };
    previousStatus: "draft" | "active" | "paused" | "completed";
    wasChanged: boolean;
  }>;
  createContent(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      contentId: string;
      versionId: string;
      idempotencyKey: string;
      requestHash: string;
      campaignId: string;
      brandId: string;
      title: string;
      contentType: "guide";
      topicKey: string;
      summary: string;
      bodyMarkdown: string;
      payload: Readonly<Record<string, unknown>>;
      payloadHash: string;
    },
  ): Promise<{ id: string; latestVersionId: string | null }>;
  createVariant(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      variantId: string;
      contentItemId: string;
      contentVersionId: string;
      channelAccountId: string;
      payload: Readonly<Record<string, unknown>>;
      payloadHash: string;
    },
  ): Promise<{ id: string; variantVersion: number; payloadHash: string }>;
  loadAuditContext(
    context: { actorId: string; tenantId: string; requestId: string },
    variantId: string,
    capturedAt: string,
  ): Promise<{
    priorVariants: readonly { variantId: string; bodyMarkdown: string }[];
  } | null>;
  createMediaJob(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      jobId: string;
      contentVersionId: string;
      platform: "toutiao" | "sohu" | "ctrip_community";
      role: "cover" | "inline";
      factIds: readonly string[];
      visualBrief: Readonly<Record<string, unknown>>;
      visualBriefHash: string;
      requestHash: string;
      idempotencyKey: string;
      providerId: string;
      providerMode: "fixture" | "live";
    },
  ): Promise<{
    id: string;
    state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
    requestHash: string;
    attemptCount: number;
    assetId: string | null;
    lastErrorCode: string | null;
  }>;
  getMediaJob(
    context: { actorId: string; tenantId: string; requestId: string },
    jobId: string,
  ): ReturnType<VariantRepositoryForTest["createMediaJob"]> | Promise<null>;
  recordMediaAttempt(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      attemptId: string;
      jobId: string;
      attemptNo: number;
      status: "succeeded" | "failed" | "timed_out";
      providerId: string;
      providerMode: "fixture" | "live";
      model: string;
      inputHash: string;
      requestHash: string;
      responseHash: string | null;
      outputSha256: string | null;
      providerRequestId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: string;
      finishedAt: string;
    },
  ): Promise<void>;
  completeMediaJob(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      jobId: string;
      assetId: string;
      inspectionId: string;
      bindingId: string;
      successorContentVersionId: string;
      storageKey: string;
      reference: Readonly<Record<string, unknown>>;
      successorPayload: Readonly<Record<string, unknown>>;
      successorPayloadHash: string;
      completedAt: string;
    },
  ): Promise<{
    id: string;
    contentVersionId: string;
    storageKey: string;
    reference: Readonly<Record<string, unknown>>;
  }>;
  failMediaJob(
    context: { actorId: string; tenantId: string; requestId: string },
    input: { jobId: string; errorCode: string; errorMessage: string; completedAt: string },
  ): ReturnType<VariantRepositoryForTest["createMediaJob"]>;
  listMediaAssets(
    context: { actorId: string; tenantId: string; requestId: string },
    contentVersionId: string,
  ): Promise<readonly Awaited<ReturnType<VariantRepositoryForTest["completeMediaJob"]>>[]>;
  getMediaAsset(
    context: { actorId: string; tenantId: string; requestId: string },
    assetId: string,
  ): ReturnType<VariantRepositoryForTest["completeMediaJob"]> | Promise<null>;
  createContact(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      id: string;
      type: "phone" | "wechat" | "email" | "website" | "address";
      label: string;
      value: string;
      normalizedValue: string;
      isPrimary: boolean;
      validFrom: string;
    },
  ): Promise<{ id: string; tenantId: string; value: string; validUntil: string | null }>;
  expireContact(
    context: { actorId: string; tenantId: string; requestId: string },
    input: { contactId: string; reason: string; validUntil: string },
  ): Promise<{ id: string; validUntil: string | null }>;
  createMember(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      membershipId: string;
      userId: string;
      email: string;
      displayName: string;
      passwordHash: string;
      role: "owner" | "admin" | "editor" | "auditor" | "publisher" | "viewer";
    },
  ): Promise<{ id: string; role: string; capabilities: readonly string[]; status: string }>;
  updateMember(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      membershipId: string;
      role?: "owner" | "admin" | "editor" | "auditor" | "publisher" | "viewer";
      status?: "active" | "suspended";
      reason: string;
    },
  ): Promise<{ id: string; role: string; capabilities: readonly string[]; status: string }>;
  createPolicyBundle(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      id: string;
      version: string;
      policyHash: string;
      document: Readonly<Record<string, unknown>>;
      effectiveAt: string;
      reason: string;
    },
  ): Promise<{ id: string; status: "draft"; policyHash: string }>;
  transitionPolicyBundle(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      policyBundleId: string;
      targetStatus: "active" | "retired";
      reason: string;
      changedAt: string;
    },
  ): Promise<{ policy: { id: string; status: string }; wasChanged: boolean }>;
  createChannelAccount(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      id: string;
      platform: "toutiao" | "sohu" | "ctrip_community";
      displayName: string;
      capability: "manual_only";
      supportedExecutionLevels: readonly ["dry_run"];
      credentialRef: null;
      evidenceType: "manual_import";
      evidenceRefs: readonly string[];
      status: "needs_verification";
      lastVerifiedAt: null;
    },
  ): Promise<{ id: string; status: string; supportedExecutionLevels: readonly string[] }>;
  updateChannelAccount(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      channelAccountId: string;
      status: "active";
      lastVerifiedAt: string;
      reason: string;
    },
  ): Promise<{ id: string; status: string; supportedExecutionLevels: readonly string[] }>;
  listServicePrincipals(context: {
    actorId: string;
    tenantId: string;
    requestId: string;
  }): Promise<readonly { id: string; credentialStatus: string; capabilities: readonly string[] }[]>;
  createAutomationServicePrincipal(
    context: { actorId: string; tenantId: string; requestId: string },
    input: { id: string; name: string },
  ): Promise<{
    id: string;
    profile: string;
    credentialStatus: string;
    capabilities: readonly string[];
  }>;
  setServicePrincipalStatus(
    context: { actorId: string; tenantId: string; requestId: string },
    input: { servicePrincipalId: string; status: "active" | "disabled"; reason: string },
  ): Promise<{ principal: { id: string; status: string }; wasChanged: boolean }>;
}

type VariantRepositoryFactory = (options: {
  runtimeDatabase: ReturnType<typeof createDatabase>;
  identityDatabase: ReturnType<typeof createDatabase>;
}) => VariantRepositoryForTest;

async function loadVariantRepositoryFactory(): Promise<VariantRepositoryFactory> {
  const repositoryModuleUrl = new URL(
    "../../../apps/api/src/postgres-repository.ts",
    import.meta.url,
  ).href;
  const repositoryModule: unknown = await import(repositoryModuleUrl);
  const factory = (repositoryModule as { createPostgresApiRepository?: unknown })
    .createPostgresApiRepository;
  if (typeof factory !== "function") {
    throw new Error("PostgreSQL API repository factory is unavailable");
  }
  return factory as VariantRepositoryFactory;
}

interface GrantConsumptionRow {
  publication_job_id: string;
  publication_outbox_event_id: string;
  was_created: boolean;
}

interface JobCancellationRow {
  publication_job_id: string;
  state: string;
  was_changed: boolean;
}

interface ReadbackScheduleRow {
  publication_readback_id: string;
  publication_outbox_event_id: string | null;
  state: string;
  required: boolean;
  was_created: boolean;
}

interface ExecutionAcquisitionRow {
  allowed: boolean;
  reason: string;
  half_open_probe: boolean;
}

interface ExecutionFinishRow {
  circuits_opened: number;
  circuits_closed: number;
}

interface AutomationClaimRow {
  attempt_count: number;
  batch_id: string;
  id: string;
  lease_expires_at: Date;
  lease_owner: string;
  stage: string;
  state: string;
}

interface AutomationCheckpointRow {
  accepted: boolean;
  lease_expires_at: Date | null;
  reason: string;
}

interface AutomationReconcileRow {
  automation_run_id: string;
  available_at: Date | null;
  batch_state: string;
  run_state: string;
}

let adminClient: Client | undefined;
let databaseDir: string | undefined;
let pgControlPath: string | undefined;
let postgresStarted = false;
let postgresPort: number | undefined;

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

async function isolatedRuntimeTransaction<T>(
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  if (postgresPort === undefined) {
    throw new Error("PostgreSQL test port is not initialized");
  }
  const client = new Client({
    user: "postgres",
    password,
    port: postgresPort,
    host: "127.0.0.1",
    database: databaseName,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE geo_runtime");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
      [tenantId, actorId, "concurrent-integration-test"],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function waitForBlockedQuery(fragment: string, applicationName?: string): Promise<void> {
  if (adminClient === undefined) {
    throw new Error("PostgreSQL test client is not initialized");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND (query LIKE $1 OR application_name = $2)`,
      [`%${fragment}%`, applicationName ?? ""],
    );
    if (blocked.rows[0]?.count !== "0") return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const activity = await adminClient.query<{
    pid: number;
    query: string;
    state: string;
    wait_event: string | null;
    wait_event_type: string | null;
  }>(
    `SELECT pid, state, wait_event_type, wait_event, query
     FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND datname = current_database()`,
  );
  throw new Error(
    `Timed out waiting for blocked PostgreSQL query: ${fragment}; activity=${JSON.stringify(activity.rows)}`,
  );
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
          brand_snapshot_hash, media_snapshot_hash,
          status, findings, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8, 'travel-v1', $9, $10, $11,
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
        "b".repeat(64),
        "c".repeat(64),
      ],
    );
    for (const [grantId, grantTokenHash] of [
      [ids.grant, tokenHash],
      [ids.revokeGrant, "1".repeat(64)],
      [ids.cancelGrant, "2".repeat(64)],
      [ids.leasedGrant, "3".repeat(64)],
    ] as const) {
      await client.query(
        `INSERT INTO geo.publication_grants
           (tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
            payload_hash, audit_hash, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8,
                 clock_timestamp() + interval '5 minutes')`,
        [
          tenantId,
          grantId,
          ids.auditArtifact,
          ids.variant,
          SEED_IDS.zhongtong.toutiao,
          payloadHash,
          auditHash,
          grantTokenHash,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  const port = await availablePort();
  postgresPort = port;
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

  const preRestoreClient = new Client({
    user: "postgres",
    password,
    port,
    host: "127.0.0.1",
    database: databaseName,
  });
  await preRestoreClient.connect();
  try {
    const applicationRolesSql = await readFile(applicationRolesFile, "utf8");
    await preRestoreClient.query(applicationRolesSql);
    await preRestoreClient.query(applicationRolesSql);
  } finally {
    await preRestoreClient.end();
  }

  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`;
  const database = createDatabase({ connectionString, applicationName: "geo-db-integration" });
  await sql`create schema if not exists geo`.execute(database);
  const baselineMigrator = new Migrator({
    db: database,
    migrationTableSchema: "geo",
    provider: new SqlFileMigrationProvider(defaultMigrationDirectory),
  });
  const baselineMigration = await baselineMigrator.migrateTo("0009_tenant_provisioning");
  if (baselineMigration.error !== undefined) {
    await database.destroy();
    throw baselineMigration.error;
  }

  await sql`
    insert into geo.tenants
      (id, slug, legal_name, display_name, industry)
    values (
      ${legacyCapabilityTenantId}, 'legacy-capability-upgrade',
      'Legacy Capability Upgrade Ltd.', 'Legacy Capability Upgrade', 'testing'
    )
  `.execute(database);
  for (const [name, userId, role, capabilities] of [
    ["owner", legacyCapabilityMembers.owner, "owner", ["automation:manage"]],
    ["admin", legacyCapabilityMembers.admin, "admin", ["automation:manage"]],
    ["editor", legacyCapabilityMembers.editor, "editor", ["automation:manage"]],
    ["admin-no-manage", legacyCapabilityMembers.adminWithoutManage, "admin", ["tenant:read"]],
    [
      "owner-with-execute",
      legacyCapabilityMembers.ownerWithExecute,
      "owner",
      ["automation:manage", "automation:execute"],
    ],
  ] as const) {
    await sql`
      insert into geo.users (id, email, password_hash, display_name)
      values (${userId}, ${`${name}@legacy-upgrade.test`}, 'legacy-password-hash', ${name})
    `.execute(database);
    await sql`
      insert into geo.tenant_memberships
        (tenant_id, id, user_id, role, capabilities)
      values (
        ${legacyCapabilityTenantId}, ${userId}, ${userId}, ${role},
        ${JSON.stringify(capabilities)}::jsonb
      )
    `.execute(database);
  }

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
    const queryPack = await adminClient.query<{ prompt_hash: string; prompts: unknown }>(
      `SELECT prompt_hash, prompts
       FROM geo.query_set_versions
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, SEED_IDS.zhongtong.querySetVersion],
    );
    const competitors = await adminClient.query<{ display_name: string; source_ref: string }>(
      `SELECT display_name, source_ref
       FROM geo.brand_competitors
       WHERE tenant_id = $1 AND brand_id = $2
       ORDER BY display_name`,
      [tenantId, SEED_IDS.zhongtong.brand],
    );
    const upgradedCapabilities = await adminClient.query<{
      capabilities: string[];
      role: string;
      user_id: string;
    }>(
      `SELECT user_id, role, capabilities
       FROM geo.tenant_memberships
       WHERE tenant_id = $1
       ORDER BY user_id`,
      [legacyCapabilityTenantId],
    );

    expect(migrations.rows.map((row) => row.name)).toEqual([
      "0001_foundation",
      "0002_identity_and_tenant",
      "0003_content_and_governance",
      "0004_delivery_and_visibility",
      "0005_security_and_publication",
      "0006_evidence_and_delivery_integrity",
      "0007_identity_reader",
      "0008_delivery_controls",
      "0009_tenant_provisioning",
      "0010_unattended_automation_runs",
      "0011_visibility_evaluation_contract",
      "0012_tenant_governance_management",
      "0013_research_capture_governance",
      "0014_media_production_governance",
      "0015_tenant_member_identity_reader",
      "0016_brand_agent_profiles",
      "0017_ctrip_assisted_handoffs",
      "0018_ctrip_assisted_admission",
      "0019_ctrip_bridge_authority",
      "0020_ctrip_submit_observations",
      "0021_ctrip_submit_recovery",
      "0022_ctrip_prepare_evidence",
      "0023_ctrip_submit_candidate_target",
    ]);
    expect(contacts.rows.map((row) => row.value)).toEqual(["4001133986", "ZTGL3411", "ZTGL6431"]);
    expect(queryPack.rows[0]).toEqual({
      prompt_hash: sha256Canonical(travelQuerySetPromptsV1),
      prompts: travelQuerySetPromptsV1,
    });
    expect(competitors.rows).toEqual([
      { display_name: "中国国旅", source_ref: "seed:zhongtong:competitors:v1" },
      { display_name: "中青旅", source_ref: "seed:zhongtong:competitors:v1" },
      { display_name: "凯撒旅游", source_ref: "seed:zhongtong:competitors:v1" },
    ]);
    expect(upgradedCapabilities.rows).toEqual([
      {
        user_id: legacyCapabilityMembers.owner,
        role: "owner",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
      },
      {
        user_id: legacyCapabilityMembers.admin,
        role: "admin",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
      },
      {
        user_id: legacyCapabilityMembers.editor,
        role: "editor",
        capabilities: ["automation:manage"],
      },
      {
        user_id: legacyCapabilityMembers.adminWithoutManage,
        role: "admin",
        capabilities: ["tenant:read", "principal:manage"],
      },
      {
        user_id: legacyCapabilityMembers.ownerWithExecute,
        role: "owner",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
      },
    ]);
  });

  it("provisions a production tenant atomically and replays only an exact idempotent request", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-tenant-provisioning-integration",
      maxConnections: 4,
    });
    const input: ProvisionTenantInput = {
      idempotencyKey: "ticket-production-tenant-001",
      tenantSlug: "production-professional-services",
      legalName: "Production Professional Services Co., Ltd.",
      displayName: "Production Services",
      industry: "professional-services",
      defaultLocale: "zh-CN",
      brandCanonicalName: "Production Services",
      brandDisplayName: "Production Services",
      contacts: [
        {
          type: "phone",
          label: "Service hotline",
          value: "4001234567",
          normalizedValue: "4001234567",
          isPrimary: true,
        },
        {
          type: "wechat",
          label: "WeChat consultation",
          value: "ProductionWX",
          normalizedValue: "productionwx",
          isPrimary: true,
        },
      ],
      workerName: "production-publication-worker",
    };
    const provisionedIds: string[] = [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
      "40000000-0000-4000-8000-000000000003",
      "40000000-0000-4000-8000-000000000004",
      "40000000-0000-4000-8000-000000000005",
      "40000000-0000-4000-8000-000000000006",
      "40000000-0000-4000-8000-000000000007",
      "40000000-0000-4000-8000-000000000008",
      "40000000-0000-4000-8000-000000000009",
      "40000000-0000-4000-8000-000000000010",
      "40000000-0000-4000-8000-000000000011",
      "40000000-0000-4000-8000-000000000012",
      "40000000-0000-4000-8000-000000000013",
    ];
    const concurrentIds = [...provisionedIds];
    const idGenerator = () => {
      const value = provisionedIds.shift();
      if (value === undefined) throw new Error("Provisioning test exhausted its IDs");
      return value;
    };
    const concurrentIdGenerator = () => {
      const value = concurrentIds.shift();
      if (value === undefined) throw new Error("Concurrent provisioning test exhausted its IDs");
      return value;
    };

    try {
      const results = await Promise.all([
        provisionTenant(database, input, { idGenerator }),
        provisionTenant(database, input, { idGenerator: concurrentIdGenerator }),
      ]);
      expect(results.map((result) => result.wasCreated).sort()).toEqual([false, true]);
      for (const result of results) {
        expect(result).toMatchObject({
          tenantId: "40000000-0000-4000-8000-000000000001",
          brandId: "40000000-0000-4000-8000-000000000002",
          workerServicePrincipalId: "40000000-0000-4000-8000-000000000009",
          policyBundleId: "40000000-0000-4000-8000-000000000010",
          querySetId: "40000000-0000-4000-8000-000000000011",
          querySetVersionId: "40000000-0000-4000-8000-000000000012",
          brandAgentProfileId: "40000000-0000-4000-8000-000000000013",
          brandAgentProfileHash: "626950dce6dd7d84574044e8d78497ea90de0cb8a543044200e111493d93777c",
        });
      }

      const tenantId = results[0]?.tenantId;
      const brandId = results[0]?.brandId;
      const workerId = results[0]?.workerServicePrincipalId;
      const brandAgentProfileId = results[0]?.brandAgentProfileId;
      const brandAgentProfileHash = results[0]?.brandAgentProfileHash;
      if (
        tenantId === undefined ||
        brandId === undefined ||
        workerId === undefined ||
        brandAgentProfileId === undefined ||
        brandAgentProfileHash === undefined
      ) {
        throw new Error("Provisioning result is incomplete");
      }
      const persisted = await adminClient.query<{
        tenants: string;
        primary_brands: string;
        contacts: string;
        safe_accounts: string;
        credential_refs: string;
        worker_principals: string;
        safe_controls: string;
        active_policies: string;
        active_query_sets: string;
        query_set_versions: string;
        active_brand_agent_profiles: string;
        receipt_profile_links: string;
        receipts: string;
      }>(
        `select
           (select count(*)::text from geo.tenants where slug = $1) as tenants,
           (select count(*)::text from geo.brands where tenant_id = $2 and is_primary) as primary_brands,
           (select count(*)::text from geo.tenant_contacts where tenant_id = $2) as contacts,
           (select count(*)::text from geo.channel_accounts
             where tenant_id = $2 and capability = 'manual_only'
               and supported_execution_levels = ARRAY['dry_run']::text[]
               and status = 'active') as safe_accounts,
           (select count(*)::text from geo.channel_accounts
             where tenant_id = $2 and credential_ref is not null) as credential_refs,
           (select count(*)::text from geo.service_principals
             where tenant_id = $2 and kind = 'worker' and status = 'active') as worker_principals,
           (select count(*)::text from geo.automation_controls
             where tenant_id = $2 and scope_type = 'tenant' and scope_key = '*'
               and mode = 'shadow' and not kill_switch_enabled
               and quota = '{"maxConcurrent":1,"perMinute":10,"perDay":100,"cooldownSeconds":0,"errorBudget":5}'::jsonb) as safe_controls,
           (select count(*)::text from geo.policy_bundles
             where tenant_id = $2 and status = 'active'
               and document ->> 'schemaVersion' = 'geo.audit-policy.v2') as active_policies,
           (select count(*)::text from geo.query_sets
             where tenant_id = $2 and status = 'active' and industry = $4) as active_query_sets,
           (select count(*)::text from geo.query_set_versions as version
             join geo.query_sets as query_set
               on query_set.tenant_id = version.tenant_id and query_set.id = version.query_set_id
             where version.tenant_id = $2 and query_set.status = 'active'
               and version.version = query_set.current_version) as query_set_versions,
           (select count(*)::text from geo.brand_agent_profiles
             where tenant_id = $2 and brand_id = $5 and id = $6
               and version = 1 and status = 'active' and document_hash = $7) as active_brand_agent_profiles,
           (select count(*)::text from geo.tenant_provisioning_receipts
             where tenant_id = $2 and idempotency_key = $3
               and brand_agent_profile_id = $6
               and brand_agent_profile_hash = $7) as receipt_profile_links,
           (select count(*)::text from geo.tenant_provisioning_receipts
             where tenant_id = $2 and idempotency_key = $3) as receipts`,
        [
          input.tenantSlug,
          tenantId,
          input.idempotencyKey,
          input.industry,
          brandId,
          brandAgentProfileId,
          brandAgentProfileHash,
        ],
      );
      expect(persisted.rows[0]).toEqual({
        tenants: "1",
        primary_brands: "1",
        contacts: "2",
        safe_accounts: "3",
        credential_refs: "0",
        worker_principals: "1",
        safe_controls: "1",
        active_policies: "1",
        active_query_sets: "1",
        query_set_versions: "1",
        active_brand_agent_profiles: "1",
        receipt_profile_links: "1",
        receipts: "1",
      });

      await expect(
        provisionTenant(database, { ...input, legalName: "Changed Legal Name" }),
      ).rejects.toBeInstanceOf(TenantProvisioningConflictError);
      await expect(
        provisionTenant(database, {
          ...input,
          idempotencyKey: "ticket-production-tenant-002",
        }),
      ).rejects.toThrow("Tenant slug already exists");
      await expect(
        provisionTenant(database, {
          ...input,
          tenantSlug: "different-production-services",
        }),
      ).rejects.toThrow("idempotency key conflicts");

      await expect(
        runtimeTransaction(
          (client) => client.query("select * from geo.tenant_provisioning_receipts"),
          { tenant: tenantId, actor: workerId },
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        adminClient.query(
          "update geo.tenant_provisioning_receipts set request_hash = repeat('0', 64) where idempotency_key = $1",
          [input.idempotencyKey],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      const rollbackInput: ProvisionTenantInput = {
        ...input,
        idempotencyKey: "ticket-production-rollback-001",
        tenantSlug: "production-rollback-probe",
        legalName: "Production Rollback Probe",
        displayName: "Rollback Probe",
        brandCanonicalName: "Rollback Probe",
        brandDisplayName: "Rollback Probe",
        contacts: [],
        workerName: "rollback-probe-worker",
      };
      const rollbackIds: string[] = [
        "50000000-0000-4000-8000-000000000001",
        "50000000-0000-4000-8000-000000000002",
        "50000000-0000-4000-8000-000000000003",
        "50000000-0000-4000-8000-000000000004",
        "50000000-0000-4000-8000-000000000005",
        "50000000-0000-4000-8000-000000000006",
        SEED_IDS.zhongtong.workerPrincipal,
        "50000000-0000-4000-8000-000000000008",
        "50000000-0000-4000-8000-000000000009",
        "50000000-0000-4000-8000-000000000010",
        "50000000-0000-4000-8000-000000000011",
      ];
      await expect(
        provisionTenant(database, rollbackInput, {
          idGenerator: () => {
            const value = rollbackIds.shift();
            if (value === undefined) throw new Error("Rollback test exhausted its IDs");
            return value;
          },
        }),
      ).rejects.toMatchObject({ code: "23505" });
      const rollbackState = await adminClient.query<{
        tenants: string;
        profiles: string;
        receipts: string;
      }>(
        `select
           (select count(*)::text from geo.tenants where slug = $1) as tenants,
           (select count(*)::text from geo.brand_agent_profiles
             where tenant_id in (select id from geo.tenants where slug = $1)) as profiles,
           (select count(*)::text from geo.tenant_provisioning_receipts
             where idempotency_key = $2) as receipts`,
        [rollbackInput.tenantSlug, rollbackInput.idempotencyKey],
      );
      expect(rollbackState.rows[0]).toEqual({ tenants: "0", profiles: "0", receipts: "0" });
    } finally {
      await database.destroy();
    }
  });

  it("claims, checkpoints, governs, reconciles, recovers, and cancels automation atomically", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }

    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, status, topic_key)
         VALUES ($1, $2, $3, 'Automation integration campaign',
                 'Prove durable dry-run automation', 'travel', 'active', 'automation')`,
        [tenantId, ids.automationCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
            execution_level, scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'automation-batch-main', $4, 'scheduled', 'dry_run',
                 clock_timestamp(), '{"name":"integration"}'::jsonb, $5)`,
        [tenantId, ids.automationBatch, ids.automationCampaign, "1".repeat(64), actorId],
      );
      for (const [runId, slotKey, topicKey] of [
        [ids.automationRunA, "slot-a", "automation-topic-a"],
        [ids.automationRunB, "slot-b", "automation-topic-b"],
      ] as const) {
        await client.query(
          `INSERT INTO geo.automation_runs
             (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
              idempotency_key, request_hash, available_at)
           VALUES ($1, $2, $3, $4, $5, $6, '{"kind":"guide"}'::jsonb,
                   $7, $8, clock_timestamp())`,
          [
            tenantId,
            runId,
            ids.automationBatch,
            ids.automationCampaign,
            slotKey,
            topicKey,
            `automation-run-${slotKey}`,
            runId === ids.automationRunA ? "2".repeat(64) : "3".repeat(64),
          ],
        );
      }
      for (const [targetId, runId, suffix] of [
        [ids.automationTargetA, ids.automationRunA, "a"],
        [ids.automationTargetB, ids.automationRunB, "b"],
      ] as const) {
        await client.query(
          `INSERT INTO geo.automation_run_targets
             (tenant_id, id, run_id, channel_account_id, platform,
              variant_idempotency_key, audit_idempotency_key,
              publication_idempotency_key)
           VALUES ($1, $2, $3, $4, 'toutiao', $5, $6, $7)`,
          [
            tenantId,
            targetId,
            runId,
            SEED_IDS.zhongtong.toutiao,
            `automation-variant-${suffix}`,
            `automation-audit-${suffix}`,
            `automation-publication-${suffix}`,
          ],
        );
      }
      await client.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key,
            publication_idempotency_key)
         VALUES ($1, $2, $3, $4, 'sohu',
                 'automation-variant-pending', 'automation-audit-pending',
                 'automation-publication-pending')`,
        [tenantId, ids.automationPendingTarget, ids.automationRunA, SEED_IDS.zhongtong.sohu],
      );
    });

    await expect(
      runtimeTransaction((client) =>
        client.query("UPDATE geo.automation_runs SET stage = 'delivery' WHERE id = $1", [
          ids.automationRunA,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const claimClientA = new Client({
      user: "postgres",
      password,
      port: postgresPort,
      host: "127.0.0.1",
      database: databaseName,
      application_name: "automation-claim-a",
    });
    const claimClientB = new Client({
      user: "postgres",
      password,
      port: postgresPort,
      host: "127.0.0.1",
      database: databaseName,
      application_name: "automation-claim-b",
    });
    await Promise.all([claimClientA.connect(), claimClientB.connect()]);
    try {
      for (const [client, requestId] of [
        [claimClientA, "automation-claim-a"],
        [claimClientB, "automation-claim-b"],
      ] as const) {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE geo_runtime");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
          [tenantId, actorId, requestId],
        );
      }
      const firstClaim = await claimClientA.query<AutomationClaimRow>(
        "SELECT * FROM geo.claim_automation_runs($1, 1, 60)",
        ["automation-worker-a"],
      );
      const secondClaimPromise = claimClientB.query<AutomationClaimRow>(
        "SELECT * FROM geo.claim_automation_runs($1, 1, 60)",
        ["automation-worker-b"],
      );
      await waitForBlockedQuery("claim_automation_runs", "automation-claim-b");
      await claimClientA.query("COMMIT");
      const secondClaim = await secondClaimPromise;
      expect(firstClaim.rows[0]).toMatchObject({
        id: ids.automationRunA,
        attempt_count: 1,
        lease_owner: "automation-worker-a",
        state: "running",
      });
      expect(secondClaim.rows[0]).toMatchObject({
        id: ids.automationRunB,
        attempt_count: 1,
        lease_owner: "automation-worker-b",
        state: "running",
      });
      await claimClientB.query("COMMIT");
    } finally {
      await Promise.allSettled([claimClientA.query("ROLLBACK"), claimClientB.query("ROLLBACK")]);
      await Promise.all([claimClientA.end(), claimClientB.end()]);
    }

    await adminClient.query(
      `INSERT INTO geo.content_items
         (tenant_id, id, campaign_id, brand_id, title, content_type, topic_key)
       VALUES ($1, $2, $3, $4, 'Automation draft', 'guide', 'automation-topic-a')`,
      [tenantId, ids.automationContentItem, ids.automationCampaign, SEED_IDS.zhongtong.brand],
    );
    await adminClient.query(
      `INSERT INTO geo.content_versions
         (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
          payload_hash, created_by_actor_id, frozen_at)
       VALUES ($1, $2, $3, 1, 'Automation summary', '# Automation body', '{}'::jsonb,
               $4, $5, clock_timestamp())`,
      [tenantId, ids.automationContentVersion, ids.automationContentItem, "4".repeat(64), actorId],
    );

    const draftCheckpoint = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.checkpoint_automation_draft(
           $1, $2, $3, $4, $5, $6::jsonb, 60
         )`,
        [
          ids.automationRunA,
          "automation-worker-a",
          1,
          ids.automationContentItem,
          ids.automationContentVersion,
          JSON.stringify({ draft: "persisted" }),
        ],
      ),
    );
    expect(draftCheckpoint.rows[0]).toMatchObject({ accepted: true, reason: "accepted" });

    await adminClient.query(
      `INSERT INTO geo.publication_variants
         (tenant_id, id, content_version_id, channel_account_id, platform,
          variant_version, payload, payload_hash, state, frozen_at)
       VALUES ($1, $2, $3, $4, 'toutiao', 1, '{}'::jsonb, $5,
               'frozen', clock_timestamp())`,
      [
        tenantId,
        ids.automationVariant,
        ids.automationContentVersion,
        SEED_IDS.zhongtong.toutiao,
        "5".repeat(64),
      ],
    );

    const variantCheckpoint = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.checkpoint_automation_target(
           $1, $2, $3, $4, 'variant_ready', $5,
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           $6::jsonb, 60
         )`,
        [
          ids.automationRunA,
          ids.automationTargetA,
          "automation-worker-a",
          1,
          ids.automationVariant,
          JSON.stringify({ target: "variant_ready" }),
        ],
      ),
    );
    expect(variantCheckpoint.rows[0]).toMatchObject({ accepted: true, reason: "accepted" });

    await adminClient.query(
      `INSERT INTO geo.audit_runs
         (tenant_id, id, variant_id, policy_bundle_id, status,
          requested_by_actor_id, completed_at)
       VALUES ($1, $2, $3, $4, 'failed', $5, clock_timestamp())`,
      [tenantId, ids.automationAuditRun, ids.automationVariant, SEED_IDS.zhongtong.policy, actorId],
    );
    await adminClient.query(
      `INSERT INTO geo.audit_artifacts
         (tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
          payload_hash, fact_snapshot_hash, policy_hash, policy_version,
          audit_hash, brand_snapshot_hash, media_snapshot_hash,
          status, findings, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8, 'automation-v1',
               $9, $10, $11, 'failed', '[]'::jsonb, clock_timestamp() + interval '10 minutes')`,
      [
        tenantId,
        ids.automationAuditArtifact,
        ids.automationAuditRun,
        ids.automationVariant,
        SEED_IDS.zhongtong.toutiao,
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
        "8".repeat(64),
        "9".repeat(64),
        "a".repeat(64),
      ],
    );

    const failedCheckpoint = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.checkpoint_automation_target(
           $1, $2, $3, $4, 'audit_failed', NULL::uuid,
           NULL::uuid, $5, NULL::uuid, 'FIXTURE_FAILURE', 'fixture failed',
           $6::jsonb, 60
         )`,
        [
          ids.automationRunA,
          ids.automationTargetA,
          "automation-worker-a",
          1,
          ids.automationAuditArtifact,
          JSON.stringify({ target: "failed" }),
        ],
      ),
    );
    expect(failedCheckpoint.rows[0]).toMatchObject({ accepted: true, reason: "accepted" });
    const inferredAuditRun = await adminClient.query<{
      audit_artifact_id: string;
      audit_run_id: string;
      state: string;
    }>(
      `SELECT state, audit_run_id, audit_artifact_id
       FROM geo.automation_run_targets
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationTargetA],
    );
    expect(inferredAuditRun.rows[0]).toEqual({
      state: "audit_failed",
      audit_run_id: ids.automationAuditRun,
      audit_artifact_id: ids.automationAuditArtifact,
    });

    const reconciled = await runtimeTransaction((client) =>
      client.query<AutomationReconcileRow>(
        `SELECT * FROM geo.reconcile_automation_run(
           $1, $2, $3, NULL::integer, 'TARGET_FAILED', 'all targets failed'
         )`,
        [ids.automationRunA, "automation-worker-a", 1],
      ),
    );
    expect(reconciled.rows[0]).toMatchObject({
      automation_run_id: ids.automationRunA,
      run_state: "failed",
      batch_state: "running",
    });
    const permanentFailureTarget = await adminClient.query<{
      last_error_code: string;
      state: string;
      variant_id: string | null;
    }>(
      `SELECT state, variant_id, last_error_code
       FROM geo.automation_run_targets
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationPendingTarget],
    );
    expect(permanentFailureTarget.rows[0]).toEqual({
      state: "failed",
      variant_id: null,
      last_error_code: "TARGET_FAILED",
    });

    await adminClient.query(
      `INSERT INTO geo.automation_controls
         (tenant_id, scope_type, scope_key, mode, kill_switch_enabled, reason)
       VALUES ($1, 'topic', 'automation-topic-b', 'paused', false, 'integration gate')`,
      [tenantId],
    );
    const blockedHeartbeat = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.heartbeat_automation_run(
           $1, $2, $3, 'planning', '{}'::jsonb, 60
         )`,
        [ids.automationRunB, "automation-worker-b", 1],
      ),
    );
    expect(blockedHeartbeat.rows[0]).toEqual({
      accepted: false,
      reason: "control_paused:topic:automation-topic-b",
      lease_expires_at: null,
    });
    const governedState = await adminClient.query<{
      batch_state: string;
      run_state: string;
      target_state: string;
      variant_id: string | null;
    }>(
      `SELECT batch.state AS batch_state, run.state AS run_state,
              target.state AS target_state, target.variant_id
       FROM geo.automation_batches AS batch
       JOIN geo.automation_runs AS run
         ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
       JOIN geo.automation_run_targets AS target
         ON target.tenant_id = run.tenant_id AND target.run_id = run.id
       WHERE batch.tenant_id = $1 AND batch.id = $2 AND run.id = $3 AND target.id = $4`,
      [tenantId, ids.automationBatch, ids.automationRunB, ids.automationTargetB],
    );
    expect(governedState.rows[0]).toEqual({
      batch_state: "partially_failed",
      run_state: "blocked",
      target_state: "blocked",
      variant_id: null,
    });
    await adminClient.query(
      `DELETE FROM geo.automation_controls
       WHERE tenant_id = $1 AND scope_type = 'topic' AND scope_key = 'automation-topic-b'`,
      [tenantId],
    );

    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash,
            scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'automation-lease-batch', $4,
                 clock_timestamp(), '{}'::jsonb, $5)`,
        [tenantId, ids.automationLeaseBatch, ids.automationCampaign, "6".repeat(64), actorId],
      );
      await client.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash, max_attempts, available_at)
         VALUES ($1, $2, $3, $4, 'lease-slot', 'automation-lease', '{}'::jsonb,
                 'automation-lease-run', $5, 2, clock_timestamp())`,
        [
          tenantId,
          ids.automationLeaseRun,
          ids.automationLeaseBatch,
          ids.automationCampaign,
          "7".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key,
            publication_idempotency_key)
         VALUES ($1, $2, $3, $4, 'toutiao',
                 'automation-lease-variant', 'automation-lease-audit',
                 'automation-lease-publication')`,
        [tenantId, ids.automationLeaseTarget, ids.automationLeaseRun, SEED_IDS.zhongtong.toutiao],
      );
    });
    const firstLease = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 10)", [
        "lease-worker-a",
      ]),
    );
    expect(firstLease.rows[0]).toMatchObject({
      id: ids.automationLeaseRun,
      attempt_count: 1,
    });
    await adminClient.query(
      `UPDATE geo.automation_runs
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationLeaseRun],
    );
    const recoveredLease = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 10)", [
        "lease-worker-b",
      ]),
    );
    expect(recoveredLease.rows[0]).toMatchObject({
      id: ids.automationLeaseRun,
      attempt_count: 2,
      lease_owner: "lease-worker-b",
    });
    const staleHeartbeat = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.heartbeat_automation_run(
           $1, 'lease-worker-a', 1, 'planning', '{}'::jsonb, 60
         )`,
        [ids.automationLeaseRun],
      ),
    );
    expect(staleHeartbeat.rows[0]).toMatchObject({ accepted: false, reason: "lease_mismatch" });

    const cancelled = await runtimeTransaction((client) =>
      client.query<{
        automation_batch_id: string;
        cancelled_runs: number;
        cancelled_targets: number;
        state: string;
        was_changed: boolean;
      }>("SELECT * FROM geo.cancel_automation_batch($1, $2)", [
        ids.automationLeaseBatch,
        "operator stopped integration batch",
      ]),
    );
    expect(cancelled.rows[0]).toEqual({
      automation_batch_id: ids.automationLeaseBatch,
      state: "cancelled",
      cancelled_runs: 1,
      cancelled_targets: 1,
      was_changed: true,
    });
    const cancelledPendingTarget = await adminClient.query<{
      state: string;
      variant_id: string | null;
    }>(
      `SELECT state, variant_id FROM geo.automation_run_targets
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationLeaseTarget],
    );
    expect(cancelledPendingTarget.rows[0]).toEqual({ state: "cancelled", variant_id: null });
    const claimAfterCancel = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 10, 60)", [
        "post-cancel-worker",
      ]),
    );
    expect(claimAfterCancel.rowCount).toBe(0);
    const cancellationAudit = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM geo.audit_log
       WHERE tenant_id = $1 AND action = 'automation_batch.cancelled' AND resource_id = $2`,
      [tenantId, ids.automationLeaseBatch],
    );
    expect(cancellationAudit.rows[0]?.count).toBe("1");

    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash,
            scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'automation-delivery-batch', $4,
                 clock_timestamp(), '{}'::jsonb, $5)`,
        [tenantId, ids.automationDeliveryBatch, ids.automationCampaign, "a".repeat(64), actorId],
      );
      await client.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash, available_at)
         VALUES ($1, $2, $3, $4, 'delivery-slot', 'automation-delivery', '{}'::jsonb,
                 'automation-delivery-run', $5, clock_timestamp())`,
        [
          tenantId,
          ids.automationDeliveryRun,
          ids.automationDeliveryBatch,
          ids.automationCampaign,
          "b".repeat(64),
        ],
      );
    });
    await adminClient.query(
      `UPDATE geo.automation_batches
       SET state = 'running', started_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationDeliveryBatch],
    );
    await adminClient.query(
      `UPDATE geo.automation_runs
       SET state = 'awaiting_delivery', stage = 'delivery',
           available_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationDeliveryRun],
    );
    const deliveryRecovery = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
        "delivery-recovery-worker",
      ]),
    );
    expect(deliveryRecovery.rows[0]).toMatchObject({
      id: ids.automationDeliveryRun,
      attempt_count: 1,
      state: "running",
      stage: "delivery",
    });
    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.cancel_automation_batch($1, $2)", [
        ids.automationDeliveryBatch,
        "delivery recovery verified",
      ]),
    );

    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash,
            scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'automation-circuit-batch', $4,
                 clock_timestamp(), '{}'::jsonb, $5)`,
        [tenantId, ids.automationCircuitBatch, ids.automationCampaign, "8".repeat(64), actorId],
      );
      await client.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash, max_attempts, available_at)
         VALUES ($1, $2, $3, $4, 'circuit-slot', 'automation-circuit', '{}'::jsonb,
                 'automation-circuit-run', $5, 1, clock_timestamp())`,
        [
          tenantId,
          ids.automationCircuitRun,
          ids.automationCircuitBatch,
          ids.automationCampaign,
          "9".repeat(64),
        ],
      );
    });
    await adminClient.query(
      `INSERT INTO geo.circuit_breakers
         (tenant_id, scope_type, scope_key, state, opened_at, reason)
       VALUES ($1, 'topic', 'automation-circuit', 'open', clock_timestamp(), 'integration')`,
      [tenantId],
    );
    for (const state of ["open", "half_open"] as const) {
      if (state === "half_open") {
        await adminClient.query(
          `UPDATE geo.circuit_breakers SET state = 'half_open'
           WHERE tenant_id = $1 AND scope_type = 'topic' AND scope_key = 'automation-circuit'`,
          [tenantId],
        );
      }
      const circuitBlocked = await runtimeTransaction((client) =>
        client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
          `circuit-${state}`,
        ]),
      );
      expect(circuitBlocked.rowCount).toBe(0);
    }
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET state = 'closed', reason = NULL, opened_at = NULL
       WHERE tenant_id = $1 AND scope_type = 'topic' AND scope_key = 'automation-circuit'`,
      [tenantId],
    );
    const circuitRecovered = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
        "circuit-recovered",
      ]),
    );
    expect(circuitRecovered.rows[0]).toMatchObject({
      id: ids.automationCircuitRun,
      attempt_count: 1,
    });
    await adminClient.query(
      `UPDATE geo.automation_runs
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationCircuitRun],
    );
    const exhaustedClaim = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
        "circuit-exhausted",
      ]),
    );
    expect(exhaustedClaim.rowCount).toBe(0);
    const exhaustedState = await adminClient.query<{ batch_state: string; run_state: string }>(
      `SELECT batch.state AS batch_state, run.state AS run_state
       FROM geo.automation_batches AS batch
       JOIN geo.automation_runs AS run
         ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
       WHERE batch.tenant_id = $1 AND batch.id = $2 AND run.id = $3`,
      [tenantId, ids.automationCircuitBatch, ids.automationCircuitRun],
    );
    expect(exhaustedState.rows[0]).toEqual({
      batch_state: "partially_failed",
      run_state: "failed",
    });
  });

  it("reconciles application roles and ACLs after a no-ACL restore", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await adminClient.query(`
      REVOKE ALL ON SCHEMA geo FROM geo_runtime, geo_dispatcher, geo_identity;
      REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM geo_runtime, geo_dispatcher, geo_identity;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA geo FROM geo_runtime, geo_dispatcher, geo_identity;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA geo FROM geo_runtime, geo_dispatcher, geo_identity;
      ALTER ROLE geo_runtime LOGIN INHERIT BYPASSRLS;
      ALTER ROLE geo_dispatcher LOGIN INHERIT BYPASSRLS;
      ALTER ROLE geo_identity LOGIN INHERIT BYPASSRLS;
    `);

    const reconciliationSql = await readFile(aclReconciliationFile, "utf8");
    await adminClient.query(reconciliationSql);
    await adminClient.query(reconciliationSql);

    const result = await adminClient.query<{
      dispatcher_function: boolean;
      dispatcher_has_no_tables: boolean;
      identity_function_allowlist: boolean;
      identity_has_no_tables: boolean;
      roles_hardened: boolean;
      runtime_append_only: boolean;
      runtime_function: boolean;
      runtime_readback_update: boolean;
      runtime_receipts_hidden: boolean;
      runtime_tables: boolean;
    }>(`
      select
        (select bool_and(not rolcanlogin and not rolsuper and not rolcreatedb
                         and not rolcreaterole and not rolbypassrls)
         from pg_roles where rolname in ('geo_runtime', 'geo_dispatcher', 'geo_identity'))
          as roles_hardened,
        has_table_privilege('geo_runtime', 'geo.tenants', 'SELECT')
          and has_table_privilege('geo_runtime', 'geo.brands', 'INSERT') as runtime_tables,
        not has_table_privilege('geo_runtime', 'geo.audit_log', 'UPDATE')
          and not has_table_privilege('geo_runtime', 'geo.publication_receipts', 'DELETE')
          as runtime_append_only,
        has_table_privilege('geo_runtime', 'geo.publication_readbacks', 'SELECT')
          and has_column_privilege('geo_runtime', 'geo.publication_readbacks', 'status', 'UPDATE')
          and not has_table_privilege('geo_runtime', 'geo.publication_readbacks', 'INSERT')
          as runtime_readback_update,
        not has_table_privilege(
          'geo_runtime', 'geo.tenant_provisioning_receipts', 'SELECT'
        ) as runtime_receipts_hidden,
        has_function_privilege(
          'geo_runtime',
          'geo.consume_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamptz)',
          'EXECUTE'
        ) as runtime_function,
        has_function_privilege(
          'geo_dispatcher', 'geo.claim_outbox_events(text,integer,integer)', 'EXECUTE'
        ) as dispatcher_function,
        not exists (
          select 1 from pg_class as relation
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'geo' and relation.relkind in ('r', 'p')
            and (has_table_privilege('geo_dispatcher', relation.oid, 'SELECT')
              or has_table_privilege('geo_dispatcher', relation.oid, 'INSERT')
              or has_table_privilege('geo_dispatcher', relation.oid, 'UPDATE')
              or has_table_privilege('geo_dispatcher', relation.oid, 'DELETE'))
        ) as dispatcher_has_no_tables,
        not exists (
          select 1 from pg_class as relation
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'geo' and relation.relkind in ('r', 'p')
            and has_table_privilege('geo_identity', relation.oid, 'SELECT')
        ) as identity_has_no_tables,
        not exists (
          select 1 from pg_proc as function_row
          join pg_namespace as namespace on namespace.oid = function_row.pronamespace
          where namespace.nspname = 'geo'
            and function_row.oid not in (
              'geo.find_login_identity(text)'::regprocedure,
              'geo.find_login_identity_by_user(uuid)'::regprocedure
            )
            and has_function_privilege('geo_identity', function_row.oid, 'EXECUTE')
        ) as identity_function_allowlist
    `);

    expect(result.rows[0]).toEqual({
      dispatcher_function: true,
      dispatcher_has_no_tables: true,
      identity_function_allowlist: true,
      identity_has_no_tables: true,
      roles_hardened: true,
      runtime_append_only: true,
      runtime_function: true,
      runtime_readback_update: true,
      runtime_receipts_hidden: true,
      runtime_tables: true,
    });
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

    const ownUpdate = await runtimeTransaction(
      async (client) =>
        client.query<{ label: string }>(
          "UPDATE geo.tenant_contacts SET label = 'RLS own update' WHERE id = $1 RETURNING label",
          [SEED_IDS.zhongtong.hotline],
        ),
      { commit: false },
    );
    expect(ownUpdate.rows[0]?.label).toBe("RLS own update");

    const hiddenUpdate = await runtimeTransaction(
      async (client) =>
        client.query(
          "UPDATE geo.tenant_contacts SET label = 'must stay hidden' WHERE tenant_id = $1",
          [syntheticTenantId],
        ),
      { commit: false },
    );
    expect(hiddenUpdate.rowCount).toBe(0);

    await expect(
      runtimeTransaction(async (client) =>
        client.query("UPDATE geo.tenant_contacts SET tenant_id = $1 WHERE id = $2", [
          syntheticTenantId,
          SEED_IDS.zhongtong.hotline,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

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

  it("transitions campaigns atomically while RLS hides another tenant campaign", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await adminClient.query(
      `INSERT INTO geo.campaigns
         (tenant_id, id, brand_id, name, objective, industry, topic_key)
       VALUES
         ($1, $2, $3, 'Lifecycle integration', 'Verify state machine', 'travel', 'lifecycle'),
         ($4, $5, $6, 'Isolation lifecycle', 'Must remain hidden', 'travel', 'isolation')`,
      [
        tenantId,
        ids.campaignLifecycle,
        SEED_IDS.zhongtong.brand,
        syntheticTenantId,
        ids.campaignLifecycleIsolation,
        SEED_IDS.synthetic.brand,
      ],
    );

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const runtimeDatabase = createDatabase({
      connectionString,
      applicationName: "geo-campaign-lifecycle-integration",
      maxConnections: 4,
    });
    const factory = await loadVariantRepositoryFactory();
    const repository = factory({ runtimeDatabase, identityDatabase: runtimeDatabase });
    const context = { actorId, tenantId, requestId: "campaign-lifecycle-integration" };
    try {
      const activated = await repository.transitionCampaign(context, {
        campaignId: ids.campaignLifecycle,
        targetStatus: "active",
        reason: "Ready for automation",
        auditHash: "a".repeat(64),
      });
      const paused = await repository.transitionCampaign(context, {
        campaignId: ids.campaignLifecycle,
        targetStatus: "paused",
        reason: "Operator pause",
        auditHash: "b".repeat(64),
      });
      const resumed = await repository.transitionCampaign(context, {
        campaignId: ids.campaignLifecycle,
        targetStatus: "active",
        reason: "Operator resume",
        auditHash: "c".repeat(64),
      });
      const completed = await repository.transitionCampaign(context, {
        campaignId: ids.campaignLifecycle,
        targetStatus: "completed",
        reason: "Objective reached",
        auditHash: "d".repeat(64),
      });

      expect(activated).toMatchObject({ previousStatus: "draft", wasChanged: true });
      expect(paused.campaign.status).toBe("paused");
      expect(resumed.campaign.status).toBe("active");
      expect(completed.campaign.status).toBe("completed");
      await expect(
        repository.transitionCampaign(context, {
          campaignId: ids.campaignLifecycle,
          targetStatus: "active",
          reason: "Completed is terminal",
          auditHash: "e".repeat(64),
        }),
      ).rejects.toThrow("Campaign cannot transition from completed to active");
      await expect(
        repository.transitionCampaign(context, {
          campaignId: ids.campaignLifecycleIsolation,
          targetStatus: "active",
          reason: "Cross tenant attempt",
          auditHash: "f".repeat(64),
        }),
      ).rejects.toThrow("Campaign was not found");

      const persisted = await adminClient.query<{
        audit_count: string;
        own_status: string;
        other_status: string;
      }>(
        `SELECT
           (SELECT status FROM geo.campaigns WHERE tenant_id = $1 AND id = $2) AS own_status,
           (SELECT status FROM geo.campaigns WHERE tenant_id = $3 AND id = $4) AS other_status,
           (SELECT count(*)::text FROM geo.audit_log
             WHERE tenant_id = $1 AND resource_type = 'campaign' AND resource_id = $2) AS audit_count`,
        [tenantId, ids.campaignLifecycle, syntheticTenantId, ids.campaignLifecycleIsolation],
      );
      expect(persisted.rows[0]).toEqual({
        own_status: "completed",
        other_status: "draft",
        audit_count: "4",
      });
    } finally {
      await runtimeDatabase.destroy();
    }
  });

  it("serializes concurrent initial-content creation by idempotency key", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-content-idempotency-integration",
      maxConnections: 4,
    });
    try {
      await runtimeTransaction(async (client) => {
        await client.query(
          `insert into geo.campaigns
             (tenant_id, id, brand_id, name, objective, industry, topic_key)
           values ($1, $2, $3, 'Content idempotency', 'Prove draft replay safety',
                   'travel', 'content-idempotency')`,
          [tenantId, ids.idempotentCampaign, SEED_IDS.zhongtong.brand],
        );
      });
      const createRepository = await loadVariantRepositoryFactory();
      const repository = createRepository({
        runtimeDatabase: database,
        identityDatabase: database,
      });
      const canonicalPayload = {
        title: "Idempotent governed draft",
        summary: "One request must create one initial version",
        bodyMarkdown: "## Verified\n\nOnly the first transaction may create this draft.",
        media: [],
        claims: [],
        contactIds: [],
        tags: ["verified"],
      };
      const commonInput = {
        idempotencyKey: "content-create-concurrent",
        requestHash: "7".repeat(64),
        campaignId: ids.idempotentCampaign,
        brandId: SEED_IDS.zhongtong.brand,
        title: "Idempotent governed draft",
        contentType: "guide" as const,
        topicKey: "idempotent-governed-draft",
        summary: "One request must create one initial version",
        bodyMarkdown: "## Verified\n\nOnly the first transaction may create this draft.",
        payload: canonicalPayload,
        payloadHash: "6".repeat(64),
      };
      const created = await Promise.all([
        repository.createContent(
          { tenantId, actorId, requestId: "content-idempotency-a" },
          {
            ...commonInput,
            contentId: ids.idempotentContentItemFirst,
            versionId: ids.idempotentContentVersionFirst,
          },
        ),
        repository.createContent(
          { tenantId, actorId, requestId: "content-idempotency-b" },
          {
            ...commonInput,
            contentId: ids.idempotentContentItemSecond,
            versionId: ids.idempotentContentVersionSecond,
          },
        ),
      ]);

      expect(created[0]).toEqual(created[1]);
      expect([ids.idempotentContentItemFirst, ids.idempotentContentItemSecond]).toContain(
        created[0]?.id,
      );
      expect([ids.idempotentContentVersionFirst, ids.idempotentContentVersionSecond]).toContain(
        created[0]?.latestVersionId,
      );
      await expect(
        repository.createContent(
          { tenantId, actorId, requestId: "content-idempotency-conflict" },
          {
            ...commonInput,
            contentId: ids.idempotentContentItemSecond,
            versionId: ids.idempotentContentVersionSecond,
            requestHash: "5".repeat(64),
          },
        ),
      ).rejects.toThrow(/idempotency key conflicts/u);

      const persisted = await adminClient.query<{ items: string; versions: string }>(
        `select
           (select count(*)::text from geo.content_items
            where tenant_id = $1 and id in ($2, $3)) as items,
           (select count(*)::text from geo.content_versions
            where tenant_id = $1 and id in ($4, $5)) as versions`,
        [
          tenantId,
          ids.idempotentContentItemFirst,
          ids.idempotentContentItemSecond,
          ids.idempotentContentVersionFirst,
          ids.idempotentContentVersionSecond,
        ],
      );
      expect(persisted.rows[0]).toEqual({ items: "1", versions: "1" });
    } finally {
      await database.destroy();
    }
  });

  it("serializes concurrent deterministic variant creation and reuses one row", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, topic_key)
         VALUES ($1, $2, $3, 'Variant concurrency', 'Prove variant idempotency',
                 'travel', 'variant-concurrency')`,
        [tenantId, ids.variantConcurrencyCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Concurrent variant source', 'evidence', 'draft',
                 'variant-concurrency')`,
        [
          tenantId,
          ids.variantConcurrencyContentItem,
          ids.variantConcurrencyCampaign,
          SEED_IDS.zhongtong.brand,
        ],
      );
      await client.query(
        `INSERT INTO geo.content_versions
           (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
            payload_hash, created_by_actor_id)
         VALUES ($1, $2, $3, 1, 'Concurrent variant summary',
                 '## Concurrent variant source', '{}'::jsonb, $4, $5)`,
        [
          tenantId,
          ids.variantConcurrencyContentVersion,
          ids.variantConcurrencyContentItem,
          "8".repeat(64),
          actorId,
        ],
      );
    });

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-variant-idempotency-integration",
      maxConnections: 4,
    });
    try {
      const createRepository = await loadVariantRepositoryFactory();
      const repository = createRepository({
        runtimeDatabase: database,
        identityDatabase: database,
      });
      const payload = {
        title: "Concurrent verified variant",
        summary: "Deterministic repository concurrency contract",
        bodyMarkdown: "## Verified\n\nThe same rendered payload must produce one stored variant.",
        media: [],
        claims: [],
        contactIds: [],
        tags: ["verified"],
      };
      const variantPayloadHash = sha256Canonical(payload);
      const commonInput = {
        contentItemId: ids.variantConcurrencyContentItem,
        contentVersionId: ids.variantConcurrencyContentVersion,
        channelAccountId: SEED_IDS.zhongtong.toutiao,
        payload,
        payloadHash: variantPayloadHash,
      };
      const variants = await Promise.all([
        repository.createVariant(
          { tenantId, actorId, requestId: "variant-concurrency-a" },
          { ...commonInput, variantId: ids.variantConcurrencyFirst },
        ),
        repository.createVariant(
          { tenantId, actorId, requestId: "variant-concurrency-b" },
          { ...commonInput, variantId: ids.variantConcurrencySecond },
        ),
      ]);

      expect(variants[0]?.id).toBe(variants[1]?.id);
      expect(variants.map((variant) => variant.variantVersion)).toEqual([1, 1]);
      expect(variants.map((variant) => variant.payloadHash)).toEqual([
        variantPayloadHash,
        variantPayloadHash,
      ]);

      const persisted = await adminClient.query<{
        id: string;
        variant_version: number;
        payload_hash: string;
      }>(
        `SELECT id, variant_version, payload_hash
         FROM geo.publication_variants
         WHERE tenant_id = $1 AND content_version_id = $2
           AND channel_account_id = $3 AND payload_hash = $4`,
        [
          tenantId,
          ids.variantConcurrencyContentVersion,
          SEED_IDS.zhongtong.toutiao,
          variantPayloadHash,
        ],
      );
      expect(persisted.rows).toEqual([
        {
          id: variants[0]?.id,
          variant_version: 1,
          payload_hash: variantPayloadHash,
        },
      ]);
    } finally {
      await database.destroy();
    }
  });

  it("isolates leased Ctrip handoffs and consumes one permit only after fresh governance", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const assistedRequestHash = "4".repeat(64);
    const previewHash = "5".repeat(64);
    const sessionEvidenceHash = "6".repeat(64);
    const draftEvidenceHash = "7".repeat(64);
    const prepareEvidenceHash = "8".repeat(64);
    const mediaManifestHash = "9".repeat(64);
    const blockerEvidenceHash = "a".repeat(64);
    const ctripAuditHash = "3".repeat(64);
    let ctripAssistedJobId: string | undefined;

    await adminClient.query("BEGIN");
    try {
      await adminClient.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
        [tenantId, actorId],
      );
      await adminClient.query(
        `INSERT INTO geo.service_principals
           (tenant_id, id, name, kind, profile, capabilities, status)
         VALUES
           ($1, $2, 'ctrip-bridge-integration', 'integration', 'ctrip_bridge',
            '["tenant:read","content:read","publish:bridge"]'::jsonb, 'active'),
           ($1, $3, 'ctrip-bridge-disabled', 'integration', 'ctrip_bridge',
            '["tenant:read","content:read","publish:bridge"]'::jsonb, 'disabled'),
           ($4, $5, 'ctrip-bridge-cross-tenant', 'integration', 'ctrip_bridge',
            '["tenant:read","content:read","publish:bridge"]'::jsonb, 'active')`,
        [
          tenantId,
          ids.ctripBridgePrincipal,
          ids.ctripDisabledBridgePrincipal,
          syntheticTenantId,
          ids.ctripCrossTenantBridgePrincipal,
        ],
      );
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET capability = 'browser_assisted',
             supported_execution_levels = ARRAY['dry_run', 'assisted']::text[],
             capability_evidence_type = 'browser_screenshot',
             capability_evidence_refs = '["evidence://ctrip/authorized-review"]'::jsonb,
             status = 'active',
             last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.zhongtong.ctrip],
      );
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'supervised', kill_switch_enabled = false
         WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
        [tenantId],
      );
      await adminClient.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, topic_key)
         VALUES ($1, $2, $3, 'Ctrip assisted handoff',
                 'Verify supervised handoff governance', 'travel',
                 'ctrip-assisted-handoff')`,
        [tenantId, ids.ctripAssistedCampaign, SEED_IDS.zhongtong.brand],
      );
      await adminClient.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Ctrip assisted article', 'evidence',
                 'audited', 'ctrip-assisted-handoff')`,
        [
          tenantId,
          ids.ctripAssistedContentItem,
          ids.ctripAssistedCampaign,
          SEED_IDS.zhongtong.brand,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.content_versions
           (tenant_id, id, content_item_id, version, summary, body_markdown,
            payload, payload_hash, created_by_actor_id, frozen_at)
         VALUES ($1, $2, $3, 1, 'Ctrip assisted summary',
                 '# Ctrip assisted article', '{}'::jsonb, $4, $5,
                 clock_timestamp())`,
        [
          tenantId,
          ids.ctripAssistedContentVersion,
          ids.ctripAssistedContentItem,
          payloadHash,
          actorId,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_variants
           (tenant_id, id, content_version_id, channel_account_id, platform,
            variant_version, payload, payload_hash, state, frozen_at)
         VALUES ($1, $2, $3, $4, 'ctrip_community', 1, '{}'::jsonb, $5,
                 'frozen', clock_timestamp())`,
        [
          tenantId,
          ids.ctripAssistedVariant,
          ids.ctripAssistedContentVersion,
          SEED_IDS.zhongtong.ctrip,
          payloadHash,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.audit_runs
           (tenant_id, id, variant_id, policy_bundle_id, status,
            requested_by_actor_id, completed_at)
         VALUES ($1, $2, $3, $4, 'passed', $5, clock_timestamp())`,
        [
          tenantId,
          ids.ctripAssistedAuditRun,
          ids.ctripAssistedVariant,
          SEED_IDS.zhongtong.policy,
          actorId,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.audit_artifacts
           (tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
            payload_hash, fact_snapshot_hash, policy_hash, policy_version, audit_hash,
            brand_snapshot_hash, media_snapshot_hash, status, findings, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ctrip_community', $6, $7, $8, 'travel-v1',
                 $9, $10, $11, 'passed', '[]'::jsonb,
                 clock_timestamp() + interval '20 minutes')`,
        [
          tenantId,
          ids.ctripAssistedAuditArtifact,
          ids.ctripAssistedAuditRun,
          ids.ctripAssistedVariant,
          SEED_IDS.zhongtong.ctrip,
          payloadHash,
          factHash,
          policyHash,
          ctripAuditHash,
          "8".repeat(64),
          "9".repeat(64),
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_grants
           (tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
            payload_hash, audit_hash, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ctrip_community', $6, $7, $8,
                 clock_timestamp() + interval '15 minutes')`,
        [
          tenantId,
          ids.ctripAssistedGrant,
          ids.ctripAssistedAuditArtifact,
          ids.ctripAssistedVariant,
          SEED_IDS.zhongtong.ctrip,
          payloadHash,
          ctripAuditHash,
          "0".repeat(64),
        ],
      );
      await adminClient.query("SAVEPOINT reject_unattended");
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, $3, $4, 'unattended', NULL
           )`,
          [
            ids.ctripAssistedGrant,
            "0".repeat(64),
            "ctrip-unattended-rejected",
            assistedRequestHash,
          ],
        ),
      ).rejects.toMatchObject({ code: "0A000" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_unattended");

      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET last_verified_at = clock_timestamp() - interval '25 hours'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.zhongtong.ctrip],
      );
      await adminClient.query("SAVEPOINT reject_stale_evidence");
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, $3, $4, 'assisted', NULL
           )`,
          [
            ids.ctripAssistedGrant,
            "0".repeat(64),
            "ctrip-stale-evidence-rejected",
            assistedRequestHash,
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_stale_evidence");
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.zhongtong.ctrip],
      );

      await adminClient.query("SAVEPOINT reject_scoped_control");
      await adminClient.query(
        `INSERT INTO geo.automation_controls
           (tenant_id, scope_type, scope_key, mode, kill_switch_enabled)
         VALUES ($1, 'platform', 'ctrip_community', 'shadow', false)
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET mode = 'shadow', kill_switch_enabled = false`,
        [tenantId],
      );
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, $3, $4, 'assisted', NULL
           )`,
          [
            ids.ctripAssistedGrant,
            "0".repeat(64),
            "ctrip-scoped-control-rejected",
            assistedRequestHash,
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_scoped_control");

      await adminClient.query("SAVEPOINT reject_half_open_circuit");
      await adminClient.query(
        `INSERT INTO geo.circuit_breakers
           (tenant_id, scope_type, scope_key, state, reason)
         VALUES ($1, 'platform', 'ctrip_community', 'half_open', 'admission test')
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET state = 'half_open', opened_at = NULL,
                       reason = 'admission test'`,
        [tenantId],
      );
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, $3, $4, 'assisted', NULL
           )`,
          [ids.ctripAssistedGrant, "0".repeat(64), "ctrip-half-open-rejected", assistedRequestHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_half_open_circuit");

      const admitted = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
           $1, $2, $3, $4, 'assisted', NULL
         )`,
        [ids.ctripAssistedGrant, "0".repeat(64), "ctrip-assisted-integration", assistedRequestHash],
      );
      expect(admitted.rows[0]?.was_created).toBe(true);
      ctripAssistedJobId = admitted.rows[0]?.publication_job_id;
      if (ctripAssistedJobId === undefined) {
        throw new Error("Ctrip assisted admission returned no job");
      }
      const replay = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
           $1, $2, $3, $4, 'assisted', NULL
         )`,
        [ids.ctripAssistedGrant, "0".repeat(64), "ctrip-assisted-integration", assistedRequestHash],
      );
      expect(replay.rows[0]).toMatchObject({
        publication_job_id: ctripAssistedJobId,
        publication_outbox_event_id: admitted.rows[0]?.publication_outbox_event_id,
        was_created: false,
      });
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET state = 'dispatching', lease_owner = 'ctrip-integration-worker',
             lease_expires_at = clock_timestamp() + interval '10 minutes'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripAssistedJobId],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_attempts
           (tenant_id, id, job_id, attempt_no, state, worker_id, request_hash)
         VALUES ($1, $2, $3, 1, 'started', 'ctrip-integration-worker', $4)`,
        [tenantId, ids.ctripAssistedAttempt, ctripAssistedJobId, assistedRequestHash],
      );
      await adminClient.query("COMMIT");
    } catch (error) {
      await adminClient.query("ROLLBACK");
      throw error;
    }
    const ctripJobId = ctripAssistedJobId;
    if (ctripJobId === undefined) throw new Error("Ctrip assisted job was not committed");

    const functionPrivilege = await adminClient.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(
         'geo_runtime',
         'geo.create_publication_assisted_handoff(uuid,uuid,uuid,uuid,geo.sha256_hex,text,text,timestamptz)',
         'EXECUTE'
       ) AS allowed`,
    );
    expect(functionPrivilege.rows[0]?.allowed).toBe(true);
    const legacyFunctionPrivilege = await adminClient.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(
         'geo_runtime',
         'geo.create_publication_assisted_handoff(uuid,uuid,uuid,geo.sha256_hex,text,text,timestamptz)',
         'EXECUTE'
       ) AS allowed`,
    );
    expect(legacyFunctionPrivilege.rows[0]?.allowed).toBe(false);

    const created = await runtimeTransaction((client) =>
      client.query<{ publication_assisted_handoff_id: string; was_created: boolean }>(
        `SELECT * FROM geo.create_publication_assisted_handoff(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::geo.sha256_hex, $6, $7,
           clock_timestamp() + interval '30 minutes'
         )`,
        [
          ids.ctripAssistedHandoff,
          ctripJobId,
          ids.ctripAssistedAttempt,
          ids.ctripBridgePrincipal,
          previewHash,
          "ctrip-community-web-v1",
          "ctrip-handoff-integration",
        ],
      ),
    );
    expect(created.rows[0]).toEqual({
      publication_assisted_handoff_id: ids.ctripAssistedHandoff,
      was_created: true,
    });

    const hidden = await runtimeTransaction(
      (client) =>
        client.query("SELECT id FROM geo.publication_assisted_handoffs WHERE id = $1", [
          ids.ctripAssistedHandoff,
        ]),
      { tenant: syntheticTenantId, actor: SEED_IDS.synthetic.actor },
    );
    expect(hidden.rowCount).toBe(0);
    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.claim_publication_assisted_handoff($1, 120)", [
            ids.ctripAssistedHandoff,
          ]),
        { tenant: syntheticTenantId, actor: SEED_IDS.synthetic.actor },
      ),
    ).rejects.toMatchObject({ code: "P0002" });

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET kill_switch_enabled = true
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT geo.claim_publication_assisted_handoff($1, 300)", [
          ids.ctripAssistedHandoff,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET kill_switch_enabled = false
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );

    await runtimeTransaction(async (client) => {
      await client.query("SELECT geo.claim_publication_assisted_handoff($1, 300)", [
        ids.ctripAssistedHandoff,
      ]);
      await client.query("SELECT geo.heartbeat_publication_assisted_handoff($1, 180)", [
        ids.ctripAssistedHandoff,
      ]);
    });

    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT challenge_report");
        await client.query(
          `SELECT geo.record_publication_assisted_bridge_status(
             $1, 'challenge_required', $2::geo.sha256_hex,
             $3::geo.sha256_hex, 'browser', clock_timestamp(), $4, NULL
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            blockerEvidenceHash,
            "ctrip-community-web-v1",
          ],
        );
        const challengeCircuit = await client.query<{ state: string; reason: string }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.zhongtong.ctrip],
        );
        expect(challengeCircuit.rows[0]).toEqual({
          state: "open",
          reason: "ASSISTED_CHALLENGE_REQUIRED",
        });
        await client.query("ROLLBACK TO SAVEPOINT challenge_report");

        await client.query("SAVEPOINT drift_report");
        await client.query(
          `SELECT geo.record_publication_assisted_bridge_status(
             $1, 'failed', $2::geo.sha256_hex, $3::geo.sha256_hex,
             'browser', clock_timestamp(), $4, 'ASSISTED_ADAPTER_DRIFT'
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            blockerEvidenceHash,
            "ctrip-community-web-v1",
          ],
        );
        const driftCircuit = await client.query<{ state: string; reason: string }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.zhongtong.ctrip],
        );
        expect(driftCircuit.rows[0]).toEqual({
          state: "open",
          reason: "ASSISTED_ADAPTER_DRIFT",
        });
        await client.query("ROLLBACK TO SAVEPOINT drift_report");

        await client.query(
          `SELECT geo.record_publication_assisted_bridge_status(
             $1, 'session_required', $2::geo.sha256_hex,
             $3::geo.sha256_hex, 'browser', clock_timestamp(), $4, NULL
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            blockerEvidenceHash,
            "ctrip-community-web-v1",
          ],
        );
        const blockedEvidence = await client.query<{
          prepare_outcome: string;
          prepare_evidence_kind: string;
          prepare_evidence_hash: string;
          observed: boolean;
          media_manifest_hash: string | null;
        }>(
          `SELECT prepare_outcome, prepare_evidence_kind, prepare_evidence_hash,
                  prepare_observed_at IS NOT NULL AS observed, media_manifest_hash
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(blockedEvidence.rows[0]).toEqual({
          prepare_outcome: "session_required",
          prepare_evidence_kind: "browser",
          prepare_evidence_hash: blockerEvidenceHash,
          observed: true,
          media_manifest_hash: null,
        });
        await client.query(
          `SELECT geo.record_publication_assisted_draft(
             $1, $2::geo.sha256_hex, $3::geo.sha256_hex,
             $4::geo.sha256_hex, $5::geo.sha256_hex,
             'browser', clock_timestamp(), $6, $7
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            draftEvidenceHash,
            prepareEvidenceHash,
            mediaManifestHash,
            "ctrip-draft-integration-001",
            "ctrip-community-web-v1",
          ],
        );
        const preparedEvidence = await client.query<{
          prepare_outcome: string;
          prepare_evidence_kind: string;
          prepare_evidence_hash: string;
          media_manifest_hash: string;
          observed: boolean;
        }>(
          `SELECT prepare_outcome, prepare_evidence_kind, prepare_evidence_hash,
                  media_manifest_hash, prepare_observed_at IS NOT NULL AS observed
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(preparedEvidence.rows[0]).toEqual({
          prepare_outcome: "prepared",
          prepare_evidence_kind: "browser",
          prepare_evidence_hash: prepareEvidenceHash,
          media_manifest_hash: mediaManifestHash,
          observed: true,
        });
      },
      { actor: ids.ctripBridgePrincipal },
    );

    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT * FROM geo.issue_publication_assisted_submit_permit($1)", [
            ids.ctripAssistedHandoff,
          ]),
        { actor: ids.ctripBridgePrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const boundedLease = await adminClient.query<{ bounded: boolean }>(
      `SELECT lease_expires_at <= expires_at AS bounded
       FROM geo.publication_assisted_handoffs
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(boundedLease.rows[0]?.bounded).toBe(true);

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET kill_switch_enabled = true
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.issue_publication_assisted_submit_permit($1)", [
          ids.ctripAssistedHandoff,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET kill_switch_enabled = false
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );

    const issued = await runtimeTransaction((client) =>
      client.query<{ submit_permit: string; submit_permit_expires_at: Date }>(
        "SELECT * FROM geo.issue_publication_assisted_submit_permit($1)",
        [ids.ctripAssistedHandoff],
      ),
    );
    const permit = issued.rows[0]?.submit_permit;
    expect(permit).toMatch(/^[0-9a-f]{64}$/u);
    if (permit === undefined) throw new Error("Submit permit was not returned");

    await expect(
      runtimeTransaction(
        (client) =>
          client.query(
            `SELECT * FROM geo.recover_publication_assisted_submit_uncertain(
               $1, 'simulation'
             )`,
            [ids.ctripAssistedHandoff],
          ),
        { actor: ids.ctripBridgePrincipal },
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
            ids.ctripAssistedHandoff,
            permit,
          ]),
        { actor: ids.ctripAssistedOtherActor },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
          ids.ctripAssistedHandoff,
          permit,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
            ids.ctripAssistedHandoff,
            permit,
          ]),
        { actor: SEED_IDS.zhongtong.workerPrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
            ids.ctripAssistedHandoff,
            permit,
          ]),
        {
          tenant: syntheticTenantId,
          actor: ids.ctripCrossTenantBridgePrincipal,
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await adminClient.query(
      `UPDATE geo.service_principals SET status = 'disabled'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripBridgePrincipal],
    );
    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
            ids.ctripAssistedHandoff,
            permit,
          ]),
        { actor: ids.ctripBridgePrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await adminClient.query(
      `UPDATE geo.service_principals SET status = 'active'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripBridgePrincipal],
    );

    const consumed = await runtimeTransaction(
      (client) =>
        client.query<{ value: boolean }>(
          "SELECT geo.consume_publication_assisted_submit_permit($1, $2) AS value",
          [ids.ctripAssistedHandoff, permit],
        ),
      { actor: ids.ctripBridgePrincipal },
    );
    expect(consumed.rows[0]?.value).toBe(true);
    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
            ids.ctripAssistedHandoff,
            permit,
          ]),
        { actor: ids.ctripBridgePrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT geo.cancel_publication_assisted_handoff($1, $2)", [
          ids.ctripAssistedHandoff,
          "cannot cancel after permit consumption",
        ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT recover_consumed_submit");
        const recovered = await client.query<{
          publication_receipt_id: string;
          publication_readback_id: string;
        }>(
          `SELECT * FROM geo.recover_publication_assisted_submit_uncertain(
             $1, 'simulation'
           )`,
          [ids.ctripAssistedHandoff],
        );
        const replay = await client.query<{
          publication_receipt_id: string;
          publication_readback_id: string;
        }>(
          `SELECT * FROM geo.recover_publication_assisted_submit_uncertain(
             $1, 'simulation'
           )`,
          [ids.ctripAssistedHandoff],
        );
        expect(replay.rows[0]).toEqual(recovered.rows[0]);

        const recoveryEvidence = await client.query<{
          state: string;
          submit_outcome: string;
          submit_evidence_kind: string;
          confirmed: boolean;
          receipt_outcome: string;
          readback_status: string;
          readback_required: boolean;
          recovery_events: string;
        }>(
          `SELECT handoff.state, handoff.submit_outcome, handoff.submit_evidence_kind,
                  receipt.confirmed, receipt.payload ->> 'outcome' AS receipt_outcome,
                  readback.status AS readback_status,
                  readback.required AS readback_required,
                  (SELECT count(*)::text FROM geo.audit_log AS audit
                   WHERE audit.tenant_id = handoff.tenant_id
                     AND audit.resource_id = handoff.id
                     AND audit.action =
                       'publication_assisted_handoff.submit_observation_recovered')
                    AS recovery_events
           FROM geo.publication_assisted_handoffs AS handoff
           JOIN geo.publication_receipts AS receipt
             ON receipt.tenant_id = handoff.tenant_id
            AND receipt.id = handoff.publication_receipt_id
           JOIN geo.publication_readbacks AS readback
             ON readback.tenant_id = handoff.tenant_id
            AND readback.id = handoff.publication_readback_id
           WHERE handoff.id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(recoveryEvidence.rows[0]).toEqual({
          state: "readback_pending",
          submit_outcome: "uncertain",
          submit_evidence_kind: "simulation",
          confirmed: false,
          receipt_outcome: "uncertain",
          readback_status: "pending",
          readback_required: true,
          recovery_events: "1",
        });

        await client.query("SAVEPOINT reject_recovery_overwrite");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_submit_observation(
               $1, 'accepted', 'simulation', $2::geo.sha256_hex,
               NULL, NULL, clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, "c".repeat(64)],
          ),
        ).rejects.toMatchObject({ code: "23505" });
        await client.query("ROLLBACK TO SAVEPOINT reject_recovery_overwrite");
        const stillRecovered = await client.query<{ submit_outcome: string }>(
          `SELECT submit_outcome FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(stillRecovered.rows[0]?.submit_outcome).toBe("uncertain");
        await client.query("ROLLBACK TO SAVEPOINT recover_consumed_submit");
      },
      { actor: ids.ctripBridgePrincipal },
    );

    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT prove_candidate_target_binding");
        const candidateId = "ctrip-candidate-integration-001";
        const candidateUrl = "https://you.ctrip.com/travels/candidate-integration-001.html";

        await client.query("SAVEPOINT reject_simulated_candidate");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_submit_observation(
               $1, 'accepted', 'simulation', $2::geo.sha256_hex,
               $3, $4, clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, "c".repeat(64), candidateId, candidateUrl],
          ),
        ).rejects.toMatchObject({ code: "22023" });
        await client.query("ROLLBACK TO SAVEPOINT reject_simulated_candidate");

        await client.query("SAVEPOINT reject_rejected_candidate");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_submit_observation(
               $1, 'rejected', 'browser', $2::geo.sha256_hex,
               $3, $4, clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, "c".repeat(64), candidateId, candidateUrl],
          ),
        ).rejects.toMatchObject({ code: "22023" });
        await client.query("ROLLBACK TO SAVEPOINT reject_rejected_candidate");

        await client.query(
          `SELECT * FROM geo.record_publication_assisted_submit_observation(
             $1, 'accepted', 'browser', $2::geo.sha256_hex,
             $3, $4, clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, "d".repeat(64), candidateId, candidateUrl],
        );
        const candidate = await client.query<{
          submit_candidate_external_id: string;
          submit_candidate_external_url: string;
        }>(
          `SELECT submit_candidate_external_id, submit_candidate_external_url
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(candidate.rows[0]).toEqual({
          submit_candidate_external_id: candidateId,
          submit_candidate_external_url: candidateUrl,
        });

        await client.query("SAVEPOINT reject_candidate_mismatch");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_readback(
               $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
               $3::geo.sha256_hex, 'different-id',
               'https://you.ctrip.com/travels/different.html', clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, "e".repeat(64), payloadHash],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT reject_candidate_mismatch");

        const confirmed = await client.query<{
          state: string;
          external_id: string;
          external_url: string;
        }>(
          `SELECT * FROM geo.record_publication_assisted_readback(
             $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
             $3::geo.sha256_hex, $4, $5, clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, "f".repeat(64), payloadHash, candidateId, candidateUrl],
        );
        expect(confirmed.rows[0]).toEqual({
          state: "confirmed",
          external_id: candidateId,
          external_url: candidateUrl,
        });
        await client.query("ROLLBACK TO SAVEPOINT prove_candidate_target_binding");
      },
      { actor: ids.ctripBridgePrincipal },
    );

    const submitEvidenceHash = "a".repeat(64);
    await expect(
      runtimeTransaction(
        (client) =>
          client.query(
            `SELECT * FROM geo.record_publication_assisted_submit_observation(
               $1, 'accepted', 'simulation', $2::geo.sha256_hex,
               NULL, NULL, clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, submitEvidenceHash],
          ),
        { actor: SEED_IDS.zhongtong.workerPrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const submitted = await runtimeTransaction(
      (client) =>
        client.query<{
          publication_receipt_id: string;
          publication_readback_id: string;
        }>(
          `SELECT * FROM geo.record_publication_assisted_submit_observation(
             $1, 'accepted', 'simulation', $2::geo.sha256_hex,
             NULL, NULL, clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, submitEvidenceHash],
        ),
      { actor: ids.ctripBridgePrincipal },
    );
    const receiptId = submitted.rows[0]?.publication_receipt_id;
    const readbackId = submitted.rows[0]?.publication_readback_id;
    expect(receiptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(readbackId).toMatch(/^[0-9a-f-]{36}$/u);
    if (receiptId === undefined || readbackId === undefined) {
      throw new Error("Assisted submit observation did not create delivery evidence");
    }

    const persisted = await adminClient.query<{
      state: string;
      submit_permit_hash: string;
      submit_permit_consumed_at: Date | null;
      bridge_service_principal_id: string;
      external_draft_id: string;
      submit_permit_issued_by_actor_id: string;
      submit_permit_consumed_by_principal_id: string;
      submit_outcome: string;
      submit_evidence_kind: string;
      publication_receipt_id: string;
      publication_readback_id: string;
      external_id: string | null;
      external_url: string | null;
    }>(
      `SELECT state, submit_permit_hash, submit_permit_consumed_at,
              bridge_service_principal_id, external_draft_id,
              submit_permit_issued_by_actor_id,
              submit_permit_consumed_by_principal_id,
              submit_outcome, submit_evidence_kind,
              publication_receipt_id, publication_readback_id,
              external_id, external_url
       FROM geo.publication_assisted_handoffs
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(persisted.rows[0]).toMatchObject({
      state: "readback_pending",
      submit_permit_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      submit_permit_consumed_at: expect.any(Date),
      bridge_service_principal_id: ids.ctripBridgePrincipal,
      external_draft_id: "ctrip-draft-integration-001",
      submit_permit_issued_by_actor_id: actorId,
      submit_permit_consumed_by_principal_id: ids.ctripBridgePrincipal,
      submit_outcome: "accepted",
      submit_evidence_kind: "simulation",
      publication_receipt_id: receiptId,
      publication_readback_id: readbackId,
      external_id: null,
      external_url: null,
    });
    expect(persisted.rows[0]?.submit_permit_hash).not.toBe(permit);
    const leakedPermit = await adminClient.query<{ leaked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM geo.audit_log
         WHERE tenant_id = $1
           AND resource_id = $2
           AND (details::text LIKE '%' || $3 || '%' OR action LIKE '%' || $3 || '%')
       ) AS leaked`,
      [tenantId, ids.ctripAssistedHandoff, permit],
    );
    expect(leakedPermit.rows[0]?.leaked).toBe(false);

    const deliveryEvidence = await adminClient.query<{
      confirmed: boolean;
      evidence_type: string;
      receipt_payload: Record<string, unknown>;
      readback_status: string;
      required: boolean;
      attempt_state: string;
      job_state: string;
    }>(
      `SELECT receipt.confirmed, receipt.evidence_type,
              receipt.payload AS receipt_payload,
              readback.status AS readback_status, readback.required,
              attempt.state AS attempt_state, job.state AS job_state
       FROM geo.publication_assisted_handoffs AS handoff
       JOIN geo.publication_receipts AS receipt
         ON receipt.tenant_id = handoff.tenant_id
        AND receipt.id = handoff.publication_receipt_id
       JOIN geo.publication_readbacks AS readback
         ON readback.tenant_id = handoff.tenant_id
        AND readback.id = handoff.publication_readback_id
       JOIN geo.publication_attempts AS attempt
         ON attempt.tenant_id = handoff.tenant_id AND attempt.id = handoff.attempt_id
       JOIN geo.publication_jobs AS job
         ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
       WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(deliveryEvidence.rows[0]).toMatchObject({
      confirmed: false,
      evidence_type: "fixture",
      receipt_payload: {
        outcome: "accepted",
        evidenceKind: "simulation",
        confirmed: false,
        simulation: true,
        readback: { required: true, status: "pending" },
      },
      readback_status: "pending",
      required: true,
      attempt_state: "uncertain",
      job_state: "uncertain",
    });

    const readbackEvidenceHash = "b".repeat(64);
    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT reject_simulator_confirmation");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_readback(
               $1, 'confirmed', 'simulation', $2::geo.sha256_hex,
               $3::geo.sha256_hex, 'fake-live-id',
               'https://you.ctrip.com/travels/fake.html', clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, readbackEvidenceHash, payloadHash],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT reject_simulator_confirmation");

        await client.query("SAVEPOINT reject_external_host");
        await expect(
          client.query(
            `SELECT * FROM geo.record_publication_assisted_readback(
               $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
               $3::geo.sha256_hex, 'live-id',
               'https://attacker.example/travels/live.html', clock_timestamp()
             )`,
            [ids.ctripAssistedHandoff, readbackEvidenceHash, payloadHash],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT reject_external_host");

        await client.query("SAVEPOINT prove_live_confirmation_contract");
        const live = await client.query<{
          state: string;
          external_id: string;
          external_url: string;
        }>(
          `SELECT * FROM geo.record_publication_assisted_readback(
             $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
             $3::geo.sha256_hex, 'ctrip-live-contract-id',
             'https://you.ctrip.com/travels/contract.html', clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, readbackEvidenceHash, payloadHash],
        );
        expect(live.rows[0]).toEqual({
          state: "confirmed",
          external_id: "ctrip-live-contract-id",
          external_url: "https://you.ctrip.com/travels/contract.html",
        });
        await client.query("ROLLBACK TO SAVEPOINT prove_live_confirmation_contract");

        const simulated = await client.query<{
          state: string;
          external_id: string | null;
          external_url: string | null;
        }>(
          `SELECT * FROM geo.record_publication_assisted_readback(
             $1, 'simulation_only', 'simulation', $2::geo.sha256_hex,
             $3::geo.sha256_hex, NULL, NULL, clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, readbackEvidenceHash, payloadHash],
        );
        expect(simulated.rows[0]).toEqual({
          state: "needs_review",
          external_id: null,
          external_url: null,
        });
      },
      { actor: ids.ctripBridgePrincipal },
    );

    const finalEvidence = await adminClient.query<{
      handoff_state: string;
      readback_outcome: string;
      readback_evidence_kind: string;
      external_id: string | null;
      external_url: string | null;
      readback_status: string;
      readback_error: string;
      job_state: string;
    }>(
      `SELECT handoff.state AS handoff_state, handoff.readback_outcome,
              handoff.readback_evidence_kind, handoff.external_id, handoff.external_url,
              readback.status AS readback_status, readback.last_error AS readback_error,
              job.state AS job_state
       FROM geo.publication_assisted_handoffs AS handoff
       JOIN geo.publication_readbacks AS readback
         ON readback.tenant_id = handoff.tenant_id
        AND readback.id = handoff.publication_readback_id
       JOIN geo.publication_jobs AS job
         ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
       WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(finalEvidence.rows[0]).toEqual({
      handoff_state: "needs_review",
      readback_outcome: "simulation_only",
      readback_evidence_kind: "simulation",
      external_id: null,
      external_url: null,
      readback_status: "failed",
      readback_error: "SIMULATION_ONLY",
      job_state: "needs_review",
    });

    const auditOrder = await adminClient.query<{ action: string }>(
      `SELECT action FROM geo.audit_log
       WHERE tenant_id = $1 AND resource_id = $2
         AND action IN (
           'publication_assisted_handoff.submit_permit_consumed',
           'publication_assisted_handoff.submit_observed'
         )
       ORDER BY created_at, id`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(auditOrder.rows.map((row) => row.action)).toEqual([
      "publication_assisted_handoff.submit_permit_consumed",
      "publication_assisted_handoff.submit_observed",
    ]);
  });

  it("persists tenant-scoped media production as immutable successor content", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const sourcePayload = {
      editorialProfile: "guide",
      title: "Governed media source",
      summary: "Verified source content before media production",
      bodyMarkdown: "## Verified source\n\nThe source version remains immutable.",
      media: [],
      claims: [],
      contactIds: [],
      tags: ["verified"],
    };
    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, topic_key)
         VALUES ($1, $2, $3, 'Media production', 'Verify immutable media production',
                 'travel', 'media-production')`,
        [tenantId, ids.mediaCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Governed media source', 'guide', 'draft',
                 'media-production')`,
        [tenantId, ids.mediaContentItem, ids.mediaCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.content_versions
           (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
            payload_hash, created_by_actor_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7, $8)`,
        [
          tenantId,
          ids.mediaSourceVersion,
          ids.mediaContentItem,
          sourcePayload.summary,
          sourcePayload.bodyMarkdown,
          JSON.stringify(sourcePayload),
          sha256Canonical(sourcePayload),
          actorId,
        ],
      );
    });

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-media-production-integration",
      maxConnections: 4,
    });
    const factory = await loadVariantRepositoryFactory();
    const repository = factory({ runtimeDatabase: database, identityDatabase: database });
    const context = { actorId, tenantId, requestId: "media-production-integration" };
    const factId = ids.mediaContentItem;
    const visualBrief = {
      schemaVersion: "geo.visual-brief.v1",
      editorialProfile: "guide",
      platform: "toutiao",
      role: "cover",
      aspectRatio: "16:9",
      factIds: [factId],
      prompt: "Verified travel service office scene without text or contact details.",
      negativePrompt: "text, watermark, QR code, phone number, contact handle, price, credential",
      altText: "Verified travel service office scene",
      caption: "The image represents only the verified service fact.",
    } as const;
    const visualBriefHash = sha256Canonical(visualBrief);
    const assetSha256 = "8".repeat(64);
    const storageKey = `${tenantId}/${assetSha256.slice(0, 2)}/${assetSha256}.png`;
    const generatedAt = "2026-07-15T04:01:00.000Z";
    const completedAt = "2026-07-15T04:02:00.000Z";
    const reference = (
      jobId: string,
      attemptId: string,
      assetId: string,
      rightsName: string,
      inspectionResponseHash: string,
    ): Readonly<Record<string, unknown>> => ({
      id: assetId,
      sha256: assetSha256,
      mimeType: "image/png",
      byteLength: 128,
      width: 1280,
      height: 720,
      platform: "toutiao",
      role: "cover",
      altText: visualBrief.altText,
      caption: visualBrief.caption,
      factIds: [...visualBrief.factIds],
      visualBrief,
      visualBriefHash,
      rights: {
        basis: "generated_terms",
        licenseName: rightsName,
        licenseUrl: "https://example.test/fixture-terms",
        verifiedAt: "2026-07-15T04:00:00.000Z",
      },
      provenance: {
        kind: "generated",
        jobId,
        attemptId,
        provider: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        promptHash: sha256Text(visualBrief.prompt),
        parametersHash: "7".repeat(64),
        generatedAt,
      },
      inspection: {
        assetSha256,
        status: "passed",
        evaluator: "fixture-inspector",
        evaluatorMode: "fixture",
        evaluatorVersion: "fixture-inspector-v1",
        responseSha256: inspectionResponseHash,
        inspectedAt: completedAt,
        ocrText: "",
        labels: ["fixture", "travel-office"],
      },
    });
    const createJobInput = {
      jobId: ids.mediaJob,
      contentVersionId: ids.mediaSourceVersion,
      platform: "toutiao" as const,
      role: "cover" as const,
      factIds: [factId],
      visualBrief,
      visualBriefHash,
      requestHash: "1".repeat(64),
      idempotencyKey: "media-fixture-production",
      providerId: "fixture",
      providerMode: "fixture" as const,
    };

    try {
      const created = await repository.createMediaJob(context, createJobInput);
      const replayed = await repository.createMediaJob(
        { ...context, requestId: "media-production-replay" },
        { ...createJobInput, jobId: ids.mediaReplayJob },
      );
      expect(created).toMatchObject({ id: ids.mediaJob, state: "pending", attemptCount: 0 });
      expect(replayed.id).toBe(ids.mediaJob);
      await expect(
        repository.createMediaJob(
          { ...context, requestId: "media-production-conflict" },
          { ...createJobInput, requestHash: "2".repeat(64) },
        ),
      ).rejects.toThrow(/idempotency key conflicts/u);
      expect(
        await repository.getMediaJob(
          {
            actorId: SEED_IDS.synthetic.actor,
            tenantId: syntheticTenantId,
            requestId: "media-production-cross-tenant",
          },
          ids.mediaJob,
        ),
      ).toBeNull();

      await expect(
        repository.recordMediaAttempt(context, {
          attemptId: ids.mediaReplayJob,
          jobId: ids.mediaJob,
          attemptNo: 1,
          status: "succeeded",
          providerId: "fixture",
          providerMode: "fixture",
          model: "fixture-png-v1",
          inputHash: visualBriefHash,
          requestHash: "2".repeat(64),
          responseHash: "3".repeat(64),
          outputSha256: assetSha256,
          providerRequestId: null,
          errorCode: null,
          errorMessage: null,
          startedAt: "2026-07-15T04:00:00.000Z",
          finishedAt: generatedAt,
        }),
      ).rejects.toThrow("Media attempt does not match its generation job");

      await repository.recordMediaAttempt(context, {
        attemptId: ids.mediaAttempt,
        jobId: ids.mediaJob,
        attemptNo: 1,
        status: "succeeded",
        providerId: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        inputHash: visualBriefHash,
        requestHash: "1".repeat(64),
        responseHash: "3".repeat(64),
        outputSha256: assetSha256,
        providerRequestId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: "2026-07-15T04:00:00.000Z",
        finishedAt: generatedAt,
      });
      expect(await repository.getMediaJob(context, ids.mediaJob)).toMatchObject({
        state: "running",
        attemptCount: 1,
      });

      const firstReference = reference(
        ids.mediaJob,
        ids.mediaAttempt,
        ids.mediaAsset,
        "Fixture generation terms v1",
        "4".repeat(64),
      );
      const firstSuccessorPayload = { ...sourcePayload, media: [firstReference] };
      const firstAsset = await repository.completeMediaJob(context, {
        jobId: ids.mediaJob,
        assetId: ids.mediaAsset,
        inspectionId: ids.mediaInspection,
        bindingId: ids.mediaBinding,
        successorContentVersionId: ids.mediaSuccessorVersion,
        storageKey,
        reference: firstReference,
        successorPayload: firstSuccessorPayload,
        successorPayloadHash: sha256Canonical(firstSuccessorPayload),
        completedAt,
      });
      expect(firstAsset).toMatchObject({
        id: ids.mediaAsset,
        contentVersionId: ids.mediaSuccessorVersion,
        storageKey,
      });
      expect(await repository.getMediaJob(context, ids.mediaJob)).toMatchObject({
        state: "succeeded",
        assetId: ids.mediaAsset,
      });
      expect(await repository.getMediaAsset(context, ids.mediaAsset)).toEqual(firstAsset);
      expect(await repository.listMediaAssets(context, ids.mediaSuccessorVersion)).toEqual([
        firstAsset,
      ]);
      expect(
        await repository.getMediaAsset(
          {
            actorId: SEED_IDS.synthetic.actor,
            tenantId: syntheticTenantId,
            requestId: "media-asset-cross-tenant",
          },
          ids.mediaAsset,
        ),
      ).toBeNull();

      const tamperedReference = {
        ...firstReference,
        rights: {
          ...(firstReference.rights as Readonly<Record<string, unknown>>),
          licenseName: "Tampered fixture terms",
        },
      };
      const tamperedVariantPayload = { ...sourcePayload, media: [tamperedReference] };
      await expect(
        repository.createVariant(context, {
          variantId: ids.mediaTamperedVariant,
          contentItemId: ids.mediaContentItem,
          contentVersionId: ids.mediaSuccessorVersion,
          channelAccountId: SEED_IDS.zhongtong.toutiao,
          payload: tamperedVariantPayload,
          payloadHash: sha256Canonical(tamperedVariantPayload),
        }),
      ).rejects.toThrow("unknown or changed media evidence");
      const mediaVariant = await repository.createVariant(context, {
        variantId: ids.mediaVariant,
        contentItemId: ids.mediaContentItem,
        contentVersionId: ids.mediaSuccessorVersion,
        channelAccountId: SEED_IDS.zhongtong.toutiao,
        payload: firstSuccessorPayload,
        payloadHash: sha256Canonical(firstSuccessorPayload),
      });
      expect(mediaVariant.id).toBe(ids.mediaVariant);
      expect(
        await repository.loadAuditContext(context, ids.mediaVariant, completedAt),
      ).not.toBeNull();

      const secondJobInput = {
        ...createJobInput,
        jobId: ids.mediaJobWithDifferentRights,
        idempotencyKey: "media-fixture-different-rights",
        requestHash: "5".repeat(64),
      };
      await repository.createMediaJob(context, secondJobInput);
      await repository.recordMediaAttempt(context, {
        attemptId: ids.mediaAttemptWithDifferentRights,
        jobId: ids.mediaJobWithDifferentRights,
        attemptNo: 1,
        status: "succeeded",
        providerId: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        inputHash: visualBriefHash,
        requestHash: "5".repeat(64),
        responseHash: "6".repeat(64),
        outputSha256: assetSha256,
        providerRequestId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: "2026-07-15T04:03:00.000Z",
        finishedAt: "2026-07-15T04:04:00.000Z",
      });
      const secondReference = reference(
        ids.mediaJobWithDifferentRights,
        ids.mediaAttemptWithDifferentRights,
        ids.mediaAssetWithDifferentRights,
        "Fixture generation terms v2",
        "9".repeat(64),
      );
      const secondSuccessorPayload = { ...sourcePayload, media: [secondReference] };
      await repository.completeMediaJob(context, {
        jobId: ids.mediaJobWithDifferentRights,
        assetId: ids.mediaAssetWithDifferentRights,
        inspectionId: ids.mediaInspectionWithDifferentRights,
        bindingId: ids.mediaBindingWithDifferentRights,
        successorContentVersionId: ids.mediaSuccessorVersionWithDifferentRights,
        storageKey,
        reference: secondReference,
        successorPayload: secondSuccessorPayload,
        successorPayloadHash: sha256Canonical(secondSuccessorPayload),
        completedAt: "2026-07-15T04:05:00.000Z",
      });

      const failed = await repository.createMediaJob(context, {
        ...createJobInput,
        jobId: ids.mediaFailedJob,
        idempotencyKey: "media-fixture-failed",
        requestHash: "a".repeat(64),
      });
      expect(failed.state).toBe("pending");
      expect(
        await repository.failMediaJob(context, {
          jobId: ids.mediaFailedJob,
          errorCode: "FIXTURE_ABORTED",
          errorMessage: "Fixture generation was deliberately aborted",
          completedAt: "2026-07-15T04:06:00.000Z",
        }),
      ).toMatchObject({ state: "failed", lastErrorCode: "FIXTURE_ABORTED" });

      const persisted = await adminClient.query<{
        asset_count: string;
        binding_count: string;
        inspection_count: string;
        job_state: string;
        source_payload_hash: string;
        source_version: number;
        successor_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM geo.media_assets
             WHERE tenant_id = $1 AND sha256 = $2) AS asset_count,
           (SELECT count(*)::text FROM geo.media_inspections
             WHERE tenant_id = $1 AND media_asset_id IN ($3, $4)) AS inspection_count,
           (SELECT count(*)::text FROM geo.content_media_bindings
             WHERE tenant_id = $1 AND media_asset_id IN ($3, $4)) AS binding_count,
           (SELECT state FROM geo.media_generation_jobs
             WHERE tenant_id = $1 AND id = $5) AS job_state,
           (SELECT version FROM geo.content_versions
             WHERE tenant_id = $1 AND id = $6) AS source_version,
           (SELECT payload_hash FROM geo.content_versions
             WHERE tenant_id = $1 AND id = $6) AS source_payload_hash,
           (SELECT count(*)::text FROM geo.content_versions
             WHERE tenant_id = $1 AND content_item_id = $7 AND version > 1) AS successor_count`,
        [
          tenantId,
          assetSha256,
          ids.mediaAsset,
          ids.mediaAssetWithDifferentRights,
          ids.mediaJob,
          ids.mediaSourceVersion,
          ids.mediaContentItem,
        ],
      );
      expect(persisted.rows[0]).toEqual({
        asset_count: "2",
        inspection_count: "2",
        binding_count: "2",
        job_state: "succeeded",
        source_version: 1,
        source_payload_hash: sha256Canonical(sourcePayload),
        successor_count: "2",
      });

      await expect(
        adminClient.query(
          "UPDATE geo.media_generation_attempts SET error_message = 'tampered' WHERE id = $1",
          [ids.mediaAttempt],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query("UPDATE geo.media_assets SET caption = 'tampered' WHERE id = $1", [
          ids.mediaAsset,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query("UPDATE geo.media_inspections SET labels = '[]'::jsonb WHERE id = $1", [
          ids.mediaInspection,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query(
          "UPDATE geo.content_media_bindings SET caption = 'tampered' WHERE id = $1",
          [ids.mediaBinding],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query(
          "UPDATE geo.media_generation_jobs SET completed_at = completed_at + interval '1 second' WHERE id = $1",
          [ids.mediaJob],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await database.destroy();
    }
  });

  it("includes only earlier same-version siblings in the first-batch audit context", async () => {
    if (postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const siblingPayload = (label: string) => ({
      title: `${label} title`,
      summary: `${label} summary`,
      bodyMarkdown: `## ${label}\n\nShared first-batch body for deterministic near-duplicate checks.`,
      media: [],
      claims: [],
      contactIds: [],
      tags: [label],
    });
    await runtimeTransaction(async (client) => {
      await client.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, topic_key)
         VALUES ($1, $2, $3, 'Sibling audit context', 'Prevent first-batch bypass',
                 'travel', 'sibling-audit-context')`,
        [tenantId, ids.siblingCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Sibling source', 'evidence', 'draft',
                 'sibling-audit-context')`,
        [tenantId, ids.siblingContentItem, ids.siblingCampaign, SEED_IDS.zhongtong.brand],
      );
      await client.query(
        `INSERT INTO geo.content_versions
           (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
            payload_hash, created_by_actor_id)
         VALUES ($1, $2, $3, 1, 'Sibling source summary', '## Sibling source',
                 $4::jsonb, $5, $6)`,
        [
          tenantId,
          ids.siblingContentVersion,
          ids.siblingContentItem,
          JSON.stringify(siblingPayload("source")),
          "4".repeat(64),
          actorId,
        ],
      );
      for (const [id, variantVersion, label, state, createdOffset] of [
        [ids.siblingEarlierVariant, 1, "earlier", "draft", "-2 seconds"],
        [ids.siblingCurrentVariant, 2, "current", "draft", "-1 second"],
        [ids.siblingLaterVariant, 3, "later", "frozen", "0 seconds"],
      ] as const) {
        await client.query(
          `INSERT INTO geo.publication_variants
             (tenant_id, id, content_version_id, channel_account_id, platform,
              variant_version, payload, payload_hash, state, frozen_at, created_at)
           VALUES ($1, $2, $3, $4, 'toutiao', $5, $6::jsonb, $7, $8,
                   CASE WHEN $8 = 'frozen' THEN clock_timestamp() ELSE NULL END,
                   clock_timestamp() + $9::interval)`,
          [
            tenantId,
            id,
            ids.siblingContentVersion,
            SEED_IDS.zhongtong.toutiao,
            variantVersion,
            JSON.stringify(siblingPayload(label)),
            String(variantVersion).repeat(64),
            state,
            createdOffset,
          ],
        );
      }
    });

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-sibling-audit-context-integration",
      maxConnections: 2,
    });
    try {
      const createRepository = await loadVariantRepositoryFactory();
      const repository = createRepository({
        runtimeDatabase: database,
        identityDatabase: database,
      });
      const context = await repository.loadAuditContext(
        { tenantId, actorId, requestId: "sibling-audit-context" },
        ids.siblingCurrentVariant,
        new Date().toISOString(),
      );
      const priorIds = context?.priorVariants.map((variant) => variant.variantId) ?? [];
      expect(priorIds).toContain(ids.siblingEarlierVariant);
      expect(priorIds).not.toContain(ids.siblingCurrentVariant);
      expect(priorIds).not.toContain(ids.siblingLaterVariant);
    } finally {
      await database.destroy();
    }
  });

  it("atomically consumes one grant, replays the same request, and rejects reuse", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await insertAuditedVariantAndGrant(adminClient);
    const scheduledFor = new Date(Date.now() + 60_000);

    const first = await runtimeTransaction((client) =>
      client.query<GrantConsumptionRow>(
        "SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run', $5)",
        [ids.grant, tokenHash, "publish-once", requestHash, scheduledFor],
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

    const earlyClaim = await adminClient.query<{ event_id: string }>(
      "SELECT event_id FROM geo.claim_outbox_events('schedule-probe', 100, 60)",
    );
    expect(earlyClaim.rows.some((row) => row.event_id === outboxEventId)).toBe(false);

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
      job_scheduled_for: Date;
      job_available_at: Date;
      outbox_available_at: Date;
    }>(
      `SELECT grant_row.status AS grant_status,
              (SELECT count(*)::text FROM geo.publication_jobs WHERE grant_id = $1) AS jobs,
              (SELECT count(*)::text FROM geo.outbox_events WHERE aggregate_id = $2) AS events,
              (SELECT scheduled_for FROM geo.publication_jobs WHERE id = $2) AS job_scheduled_for,
              (SELECT available_at FROM geo.publication_jobs WHERE id = $2) AS job_available_at,
              (SELECT available_at FROM geo.outbox_events WHERE id = $3) AS outbox_available_at
       FROM geo.publication_grants AS grant_row
       WHERE grant_row.id = $1`,
      [ids.grant, jobId, outboxEventId],
    );
    expect(persisted.rows[0]).toMatchObject({ grant_status: "consumed", jobs: "1", events: "1" });
    expect(persisted.rows[0]?.job_scheduled_for.toISOString()).toBe(scheduledFor.toISOString());
    expect(persisted.rows[0]?.job_available_at.toISOString()).toBe(scheduledFor.toISOString());
    expect(persisted.rows[0]?.outbox_available_at.toISOString()).toBe(scheduledFor.toISOString());
  });

  it("revokes a grant once and distinguishes missing or conflicting grants", async () => {
    const revoked = await runtimeTransaction((client) =>
      client.query<{ revoked: boolean }>("SELECT geo.revoke_publication_grant($1, $2) AS revoked", [
        ids.revokeGrant,
        "operator requested revocation",
      ]),
    );
    expect(revoked.rows[0]?.revoked).toBe(true);

    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT geo.revoke_publication_grant($1, $2)", [
          ids.revokeGrant,
          "duplicate revocation",
        ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT geo.revoke_publication_grant($1, $2)", [
          "30000000-0000-4000-8000-000000000099",
          "missing grant",
        ]),
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("cancels queue-safe jobs, rejects an active lease, and dead-letters request events", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const queued = await runtimeTransaction((client) =>
      client.query<GrantConsumptionRow>(
        "SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run')",
        [ids.cancelGrant, "2".repeat(64), "cancel-queued", "6".repeat(64)],
      ),
    );
    const queuedJobId = queued.rows[0]?.publication_job_id;
    const queuedOutboxId = queued.rows[0]?.publication_outbox_event_id;
    const cancelled = await runtimeTransaction((client) =>
      client.query<JobCancellationRow>("SELECT * FROM geo.cancel_publication_job($1, $2)", [
        queuedJobId,
        "campaign stopped",
      ]),
    );
    expect(cancelled.rows[0]).toEqual({
      publication_job_id: queuedJobId,
      state: "cancelled",
      was_changed: true,
    });

    const cancelledAgain = await runtimeTransaction((client) =>
      client.query<JobCancellationRow>("SELECT * FROM geo.cancel_publication_job($1, $2)", [
        queuedJobId,
        "repeat request",
      ]),
    );
    expect(cancelledAgain.rows[0]).toEqual({
      publication_job_id: queuedJobId,
      state: "cancelled",
      was_changed: false,
    });

    const cancelledOutbox = await adminClient.query<{
      dead_lettered_at: Date | null;
      locked_by: string | null;
      locked_until: Date | null;
      published_at: Date | null;
    }>(
      "SELECT dead_lettered_at, locked_by, locked_until, published_at FROM geo.outbox_events WHERE id = $1",
      [queuedOutboxId],
    );
    expect(cancelledOutbox.rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
    expect(cancelledOutbox.rows[0]).toMatchObject({
      locked_by: null,
      locked_until: null,
      published_at: null,
    });

    const leased = await runtimeTransaction((client) =>
      client.query<GrantConsumptionRow>(
        "SELECT * FROM geo.consume_publication_grant($1, $2, $3, $4, 'dry_run')",
        [ids.leasedGrant, "3".repeat(64), "cancel-leased", "7".repeat(64)],
      ),
    );
    const leasedJobId = leased.rows[0]?.publication_job_id;
    const leasedOutboxId = leased.rows[0]?.publication_outbox_event_id;
    const claimed = await adminClient.query<{ event_id: string }>(
      "SELECT event_id FROM geo.claim_outbox_events('cancel-real-lease', 100, 60)",
    );
    expect(claimed.rows.some((row) => row.event_id === leasedOutboxId)).toBe(true);
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.cancel_publication_job($1, $2)", [
          leasedJobId,
          "must not steal dispatcher lease",
        ]),
      ),
    ).rejects.toMatchObject({ code: "55006" });
    const released = await adminClient.query<{ released: boolean }>(
      `SELECT geo.retry_outbox_event(
         $1, 'cancel-real-lease', 0, 'lease test complete', false
       ) AS released`,
      [leasedOutboxId],
    );
    expect(released.rows[0]?.released).toBe(true);

    await adminClient.query(
      `UPDATE geo.publication_jobs
       SET state = 'dispatching', lease_owner = 'worker-active',
           lease_expires_at = clock_timestamp() + interval '1 minute'
       WHERE id = $1`,
      [leasedJobId],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_attempts (
         tenant_id, id, job_id, attempt_no, state, request_hash, worker_id, started_at
       ) VALUES ($1, $2, $3, 1, 'started', $4, 'worker-active', clock_timestamp())`,
      [tenantId, ids.cancelledAttempt, leasedJobId, "7".repeat(64)],
    );

    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.cancel_publication_job($1, $2)", [
          leasedJobId,
          "must not steal lease",
        ]),
      ),
    ).rejects.toMatchObject({ code: "55006" });

    await adminClient.query(
      "UPDATE geo.publication_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [leasedJobId],
    );
    const expiredLease = await runtimeTransaction((client) =>
      client.query<JobCancellationRow>("SELECT * FROM geo.cancel_publication_job($1, $2)", [
        leasedJobId,
        "lease expired",
      ]),
    );
    expect(expiredLease.rows[0]).toMatchObject({ state: "cancelled", was_changed: true });
    const cancelledAttempt = await adminClient.query<{
      error_code: string | null;
      governance_finished_at: Date | null;
      state: string;
    }>(
      `SELECT state, error_code, governance_finished_at
       FROM geo.publication_attempts WHERE id = $1`,
      [ids.cancelledAttempt],
    );
    expect(cancelledAttempt.rows[0]).toMatchObject({
      state: "failed",
      error_code: "CANCELLED_BY_OPERATOR",
    });
    expect(cancelledAttempt.rows[0]?.governance_finished_at).toBeInstanceOf(Date);
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.finish_publication_execution($1, $2, 'failed', $3)", [
          leasedJobId,
          ids.cancelledAttempt,
          "LATE_WORKER_FAILURE",
        ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    const stillCancelled = await adminClient.query<{ last_error_code: string; state: string }>(
      "SELECT state, last_error_code FROM geo.publication_jobs WHERE id = $1",
      [leasedJobId],
    );
    expect(stillCancelled.rows[0]).toEqual({
      state: "cancelled",
      last_error_code: "cancelled_by_operator",
    });
  });

  it("records dry-run readback as not required and rejects unsupported live readback", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const previewJob = await adminClient.query<{ id: string }>(
      "SELECT id FROM geo.publication_jobs WHERE grant_id = $1",
      [ids.grant],
    );
    const previewJobId = previewJob.rows[0]?.id;
    await adminClient.query(
      `INSERT INTO geo.publication_attempts
         (tenant_id, id, job_id, attempt_no, state, request_hash, response_hash, finished_at)
       VALUES ($1, $2, $3, 1, 'succeeded', $4, $5, clock_timestamp())`,
      [tenantId, ids.previewAttempt, previewJobId, requestHash, "8".repeat(64)],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_receipts
         (tenant_id, id, job_id, attempt_id, platform, execution_level, evidence_type,
          request_hash, response_hash, confirmed, payload)
       VALUES ($1, $2, $3, $4, 'toutiao', 'dry_run', 'preview', $5, $6, false,
               '{"mode":"dry_run"}'::jsonb)`,
      [tenantId, ids.previewReceipt, previewJobId, ids.previewAttempt, requestHash, "8".repeat(64)],
    );
    await adminClient.query(
      `UPDATE geo.publication_jobs
       SET state = 'preview_completed', preview_completed_at = clock_timestamp()
       WHERE id = $1`,
      [previewJobId],
    );

    const previewReadback = await runtimeTransaction((client) =>
      client.query<ReadbackScheduleRow>(
        "SELECT * FROM geo.schedule_publication_readback($1, $2, NULL)",
        [previewJobId, ids.previewReceipt],
      ),
    );
    expect(previewReadback.rows[0]).toMatchObject({
      publication_outbox_event_id: null,
      state: "not_required",
      required: false,
      was_created: true,
    });
    const previewReadbackId = previewReadback.rows[0]?.publication_readback_id;
    const previewReplay = await runtimeTransaction((client) =>
      client.query<ReadbackScheduleRow>(
        "SELECT * FROM geo.schedule_publication_readback($1, $2, NULL)",
        [previewJobId, ids.previewReceipt],
      ),
    );
    expect(previewReplay.rows[0]).toMatchObject({
      publication_readback_id: previewReadbackId,
      publication_outbox_event_id: null,
      state: "not_required",
      required: false,
      was_created: false,
    });
    const previewPersisted = await adminClient.query<{ reason: string; events: string }>(
      `SELECT readback.reason,
              (SELECT count(*)::text FROM geo.outbox_events
               WHERE aggregate_type = 'publication_readback'
                 AND aggregate_id = readback.id) AS events
       FROM geo.publication_readbacks AS readback WHERE readback.id = $1`,
      [previewReadbackId],
    );
    expect(previewPersisted.rows[0]).toEqual({ reason: "dry_run_preview_only", events: "0" });

    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', 'assisted', 'confirmed',
               'future-live-readback', $7, $8, clock_timestamp(), clock_timestamp(),
               clock_timestamp())`,
      [
        tenantId,
        ids.liveJob,
        ids.grant,
        ids.auditArtifact,
        ids.variant,
        SEED_IDS.zhongtong.toutiao,
        "9".repeat(64),
        payloadHash,
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_attempts
         (tenant_id, id, job_id, attempt_no, state, request_hash, response_hash, finished_at)
       VALUES ($1, $2, $3, 1, 'succeeded', $4, $5, clock_timestamp())`,
      [tenantId, ids.liveAttempt, ids.liveJob, "9".repeat(64), "a".repeat(64)],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_receipts
         (tenant_id, id, job_id, attempt_id, platform, execution_level, evidence_type,
          request_hash, response_hash, external_id, external_url, published_at,
          confirmed, payload)
       VALUES ($1, $2, $3, $4, 'toutiao', 'assisted', 'manual_import', $5, $6,
               'future-live-id', 'https://example.invalid/future-live', clock_timestamp(),
               true, '{}'::jsonb)`,
      [tenantId, ids.liveReceipt, ids.liveJob, ids.liveAttempt, "9".repeat(64), "a".repeat(64)],
    );
    await expect(
      runtimeTransaction((client) =>
        client.query<ReadbackScheduleRow>(
          "SELECT * FROM geo.schedule_publication_readback($1, $2, $3)",
          [ids.liveJob, ids.liveReceipt, new Date(Date.now() + 60_000)],
        ),
      ),
    ).rejects.toMatchObject({ code: "0A000" });
    const unsupportedArtifacts = await adminClient.query<{ events: string; readbacks: string }>(
      `SELECT
         (SELECT count(*)::text FROM geo.publication_readbacks WHERE job_id = $1) AS readbacks,
         (SELECT count(*)::text FROM geo.outbox_events
          WHERE aggregate_type = 'publication_readback'
            AND payload ->> 'jobId' = $1::text) AS events`,
      [ids.liveJob],
    );
    expect(unsupportedArtifacts.rows[0]).toEqual({ readbacks: "0", events: "0" });
  });

  it("atomically enforces quota concurrency and allows only one half-open circuit probe", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    for (const [jobId, executionLevel, idempotencyKey, hashCharacter] of [
      [ids.quotaJobA, "dry_run", "quota-job-a", "b"],
      [ids.quotaJobB, "dry_run", "quota-job-b", "c"],
      [ids.probeJobA, "assisted", "probe-job-a", "d"],
      [ids.probeJobB, "assisted", "probe-job-b", "e"],
    ] as const) {
      await adminClient.query(
        `INSERT INTO geo.publication_jobs
           (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
            platform, execution_level, state, idempotency_key, request_hash, payload_hash,
            scheduled_for, available_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', $7, 'queued', $8, $9, $10,
                 clock_timestamp(), clock_timestamp())`,
        [
          tenantId,
          jobId,
          ids.grant,
          ids.auditArtifact,
          ids.variant,
          SEED_IDS.zhongtong.toutiao,
          executionLevel,
          idempotencyKey,
          hashCharacter.repeat(64),
          payloadHash,
        ],
      );
    }
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'shadow',
           quota = '{"maxConcurrent":1,"perMinute":10,"perDay":100,"cooldownSeconds":0,"errorBudget":10}'::jsonb,
           kill_switch_enabled = false
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );

    const quotaCandidates = [
      { jobId: ids.quotaJobA, attemptId: ids.quotaAttemptA, workerId: "quota-worker-a" },
      { jobId: ids.quotaJobB, attemptId: ids.quotaAttemptB, workerId: "quota-worker-b" },
    ] as const;
    const quotaResults = await Promise.all(
      quotaCandidates.map(async (candidate) => ({
        ...candidate,
        result: (
          await isolatedRuntimeTransaction((client) =>
            client.query<ExecutionAcquisitionRow>(
              "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
              [candidate.jobId, candidate.attemptId, candidate.workerId],
            ),
          )
        ).rows[0],
      })),
    );
    const quotaAllowed = quotaResults.find((candidate) => candidate.result?.allowed === true);
    const quotaBlocked = quotaResults.find((candidate) => candidate.result?.allowed === false);
    expect(quotaResults.map((candidate) => candidate.result?.allowed).sort()).toEqual([
      false,
      true,
    ]);
    expect(quotaAllowed?.result).toEqual({
      allowed: true,
      reason: "allowed",
      half_open_probe: false,
    });
    expect(quotaBlocked?.result).toMatchObject({
      allowed: false,
      reason: "quota_max_concurrent:tenant:*",
      half_open_probe: false,
    });
    const deniedAttempt = await adminClient.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM geo.publication_attempts WHERE id = $1",
      [quotaBlocked?.attemptId],
    );
    expect(deniedAttempt.rows[0]?.count).toBe("0");

    const quotaFinished = await runtimeTransaction((client) =>
      client.query<ExecutionFinishRow>(
        "SELECT * FROM geo.finish_publication_execution($1, $2, 'succeeded'::text, NULL)",
        [quotaAllowed?.jobId, quotaAllowed?.attemptId],
      ),
    );
    expect(quotaFinished.rows[0]).toEqual({ circuits_opened: 0, circuits_closed: 0 });
    const quotaAfterRelease = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [quotaBlocked?.jobId, quotaBlocked?.attemptId, quotaBlocked?.workerId],
      ),
    );
    expect(quotaAfterRelease.rows[0]).toMatchObject({ allowed: true, half_open_probe: false });
    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.finish_publication_execution($1, $2, true, NULL)", [
        quotaBlocked?.jobId,
        quotaBlocked?.attemptId,
      ]),
    );

    await adminClient.query(
      `UPDATE geo.publication_attempts
       SET started_at = started_at - interval '1 minute',
           finished_at = finished_at - interval '1 minute',
           governance_finished_at = governance_finished_at - interval '1 minute'
       WHERE tenant_id = $1 AND state <> 'started'`,
      [tenantId],
    );

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'unattended',
           quota = '{"maxConcurrent":10,"perMinute":20,"perDay":100,"cooldownSeconds":30,"errorBudget":10}'::jsonb
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `INSERT INTO geo.circuit_breakers (
         tenant_id, scope_type, scope_key, state, failure_count,
         opened_at, retry_at, reason
       ) VALUES ($1, 'tenant', '*', 'open', 1,
                 clock_timestamp() - interval '1 hour',
                 clock_timestamp() - interval '1 second', 'cooldown elapsed')
       ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE SET
         state = 'open', failure_count = 1,
         opened_at = clock_timestamp() - interval '1 hour',
         retry_at = clock_timestamp() - interval '1 second',
         reason = 'cooldown elapsed', probe_attempt_id = NULL, probe_started_at = NULL`,
      [tenantId],
    );

    const probe = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.probeJobA, ids.probeAttemptA, "probe-worker-a"],
      ),
    );
    expect(probe.rows[0]).toEqual({
      allowed: true,
      reason: "half_open_probe",
      half_open_probe: true,
    });
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{cooldownSeconds}', '0'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    const secondProbe = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.probeJobB, ids.probeAttemptB, "probe-worker-b"],
      ),
    );
    expect(secondProbe.rows[0]).toMatchObject({
      allowed: false,
      reason: "circuit_half_open_probe_active:tenant:*",
      half_open_probe: false,
    });

    await adminClient.query(
      `UPDATE geo.publication_jobs
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.probeJobA],
    );
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET probe_started_at = clock_timestamp() - interval '11 minutes'
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    const recoveredProbe = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.probeJobB, ids.probeAttemptB, "probe-worker-b"],
      ),
    );
    expect(recoveredProbe.rows[0]).toEqual({
      allowed: true,
      reason: "half_open_probe",
      half_open_probe: true,
    });
    const expiredProbe = await adminClient.query<{
      error_code: string | null;
      governance_finished_at: Date | null;
      state: string;
    }>(
      `SELECT state, error_code, governance_finished_at
       FROM geo.publication_attempts WHERE id = $1`,
      [ids.probeAttemptA],
    );
    expect(expiredProbe.rows[0]).toMatchObject({
      state: "failed",
      error_code: "WORKER_LEASE_EXPIRED",
    });
    expect(expiredProbe.rows[0]?.governance_finished_at).toBeInstanceOf(Date);
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.finish_publication_execution($1, $2, 'succeeded', NULL)", [
          ids.probeJobA,
          ids.probeAttemptA,
        ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{cooldownSeconds}', '30'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );

    const probeFailed = await runtimeTransaction((client) =>
      client.query<ExecutionFinishRow>(
        "SELECT * FROM geo.finish_publication_execution($1, $2, 'uncertain'::text, $3)",
        [ids.probeJobB, ids.probeAttemptB, "PUBLICATION_UNCERTAIN"],
      ),
    );
    expect(probeFailed.rows[0]?.circuits_opened).toBe(1);
    const circuit = await adminClient.query<{
      state: string;
      probe_attempt_id: string | null;
      retry_at: Date | null;
    }>(
      `SELECT state, probe_attempt_id, retry_at
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    expect(circuit.rows[0]).toMatchObject({ state: "open", probe_attempt_id: null });
    expect(circuit.rows[0]?.retry_at?.getTime()).toBeGreaterThan(Date.now());

    const finishedAttempt = await adminClient.query<{
      state: string;
      worker_id: string;
      half_open_probe: boolean;
      governance_finished_at: Date | null;
    }>(
      `SELECT state, worker_id, half_open_probe, governance_finished_at
       FROM geo.publication_attempts WHERE id = $1`,
      [ids.probeAttemptB],
    );
    expect(finishedAttempt.rows[0]).toMatchObject({
      state: "uncertain",
      worker_id: "probe-worker-b",
      half_open_probe: true,
    });
    expect(finishedAttempt.rows[0]?.governance_finished_at).toBeInstanceOf(Date);

    for (const [jobId, attemptId, workerId, halfOpenProbe] of [
      [ids.harmfulJob, ids.harmfulAttempt, "harmful-worker", false],
      [ids.displacedProbeJob, ids.displacedProbeAttempt, "displaced-probe-worker", true],
    ] as const) {
      await adminClient.query(
        `INSERT INTO geo.publication_jobs
           (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
            platform, execution_level, state, idempotency_key, request_hash, payload_hash,
            scheduled_for, available_at, lease_owner, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', 'assisted', 'dispatching', $7,
                 $8, $9, clock_timestamp(), clock_timestamp(), $10,
                 clock_timestamp() + interval '10 minutes')`,
        [
          tenantId,
          jobId,
          ids.grant,
          ids.auditArtifact,
          ids.variant,
          SEED_IDS.zhongtong.toutiao,
          `harmful-half-open-${jobId}`,
          jobId.endsWith("25") ? "1".repeat(64) : "2".repeat(64),
          payloadHash,
          workerId,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_attempts
           (tenant_id, id, job_id, attempt_no, state, request_hash, started_at,
            worker_id, half_open_probe)
         VALUES ($1, $2, $3, 1, 'started', $4, clock_timestamp(), $5, $6)`,
        [tenantId, attemptId, jobId, requestHash, workerId, halfOpenProbe],
      );
    }
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{errorBudget}', '0'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET state = 'half_open', probe_attempt_id = $2,
           probe_started_at = clock_timestamp(), retry_at = NULL,
           reason = 'active displaced probe'
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId, ids.displacedProbeAttempt],
    );

    const harmfulFailure = await runtimeTransaction((client) =>
      client.query<ExecutionFinishRow>(
        "SELECT * FROM geo.finish_publication_execution($1, $2, 'failed'::text, $3)",
        [ids.harmfulJob, ids.harmfulAttempt, "HARMFUL_CONTENT"],
      ),
    );
    expect(harmfulFailure.rows[0]?.circuits_opened).toBe(1);
    const reopenedCircuit = await adminClient.query<{
      probe_attempt_id: string | null;
      probe_started_at: Date | null;
      reason: string;
      state: string;
    }>(
      `SELECT state, reason, probe_attempt_id, probe_started_at
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    expect(reopenedCircuit.rows[0]).toMatchObject({
      state: "open",
      probe_attempt_id: null,
      probe_started_at: null,
    });
    expect(reopenedCircuit.rows[0]?.reason).toContain("HARMFUL_CONTENT");

    for (const [jobId, state, workerId] of [
      [ids.concurrentProbeJob, "dispatching", "concurrent-probe-worker"],
      [ids.concurrentCandidateJob, "queued", null],
    ] as const) {
      await adminClient.query(
        `INSERT INTO geo.publication_jobs
           (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
            platform, execution_level, state, idempotency_key, request_hash, payload_hash,
            scheduled_for, available_at, lease_owner, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', 'assisted', $7, $8, $9, $10,
                 clock_timestamp(), clock_timestamp(), $11,
                 CASE WHEN $11::text IS NULL THEN NULL
                      ELSE clock_timestamp() - interval '1 second' END)`,
        [
          tenantId,
          jobId,
          ids.grant,
          ids.auditArtifact,
          ids.variant,
          SEED_IDS.zhongtong.toutiao,
          state,
          `concurrent-lock-order-${jobId}`,
          jobId.endsWith("29") ? "3".repeat(64) : "4".repeat(64),
          payloadHash,
          workerId,
        ],
      );
    }
    await adminClient.query(
      `INSERT INTO geo.publication_attempts
         (tenant_id, id, job_id, attempt_no, state, request_hash, started_at,
          worker_id, half_open_probe)
       VALUES ($1, $2, $3, 1, 'started', $4,
               clock_timestamp() - interval '11 minutes', $5, true)`,
      [
        tenantId,
        ids.concurrentProbeAttempt,
        ids.concurrentProbeJob,
        "3".repeat(64),
        "concurrent-probe-worker",
      ],
    );
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'unattended',
           quota = '{"maxConcurrent":10,"perMinute":50,"perDay":500,"cooldownSeconds":0,"errorBudget":10}'::jsonb
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET state = 'half_open', probe_attempt_id = $2,
           probe_started_at = clock_timestamp() - interval '11 minutes',
           retry_at = NULL, reason = 'concurrent stale probe'
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId, ids.concurrentProbeAttempt],
    );

    if (postgresPort === undefined) {
      throw new Error("PostgreSQL test port is not initialized");
    }
    const finisherClient = new Client({
      user: "postgres",
      password,
      port: postgresPort,
      host: "127.0.0.1",
      database: databaseName,
      application_name: "lock-order-finisher",
    });
    const recoveryClient = new Client({
      user: "postgres",
      password,
      port: postgresPort,
      host: "127.0.0.1",
      database: databaseName,
      application_name: "lock-order-recovery",
    });
    await Promise.all([finisherClient.connect(), recoveryClient.connect()]);
    for (const [client, requestId] of [
      [finisherClient, "lock-order-finisher"],
      [recoveryClient, "lock-order-recovery"],
    ] as const) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE geo_runtime");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
        [tenantId, actorId, requestId],
      );
    }
    let blockerOpen = false;
    let lateFinish: Promise<unknown> | undefined;
    let concurrentRecovery: Promise<unknown> | undefined;
    try {
      await adminClient.query("BEGIN");
      blockerOpen = true;
      await adminClient.query(
        `SELECT id FROM geo.publication_attempts
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [tenantId, ids.concurrentProbeAttempt],
      );
      lateFinish = finisherClient
        .query<ExecutionFinishRow>(
          "SELECT * FROM geo.finish_publication_execution($1, $2, 'succeeded'::text, NULL)",
          [ids.concurrentProbeJob, ids.concurrentProbeAttempt],
        )
        .then(
          async (result) => {
            await finisherClient.query("COMMIT");
            return result;
          },
          async (error: unknown) => {
            await finisherClient.query("ROLLBACK");
            throw error;
          },
        );
      await Promise.race([
        waitForBlockedQuery("finish_publication_execution", "lock-order-finisher"),
        lateFinish.then(
          () => Promise.reject(new Error("Late finish completed before the attempt lock released")),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      concurrentRecovery = recoveryClient
        .query<ExecutionAcquisitionRow>(
          "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
          [
            ids.concurrentCandidateJob,
            ids.concurrentCandidateAttempt,
            "concurrent-candidate-worker",
          ],
        )
        .then(
          async (result) => {
            await recoveryClient.query("COMMIT");
            return result;
          },
          async (error: unknown) => {
            await recoveryClient.query("ROLLBACK");
            throw error;
          },
        );
      await Promise.race([
        waitForBlockedQuery("acquire_publication_execution", "lock-order-recovery"),
        concurrentRecovery.then(
          () => Promise.reject(new Error("Probe recovery completed while the circuit was locked")),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      await adminClient.query("COMMIT");
      blockerOpen = false;

      const [finished, recovered] = await Promise.all([lateFinish, concurrentRecovery]);
      expect((finished as { rows: ExecutionFinishRow[] }).rows[0]).toEqual({
        circuits_opened: 0,
        circuits_closed: 1,
      });
      expect((recovered as { rows: ExecutionAcquisitionRow[] }).rows[0]).toEqual({
        allowed: true,
        reason: "allowed",
        half_open_probe: false,
      });
    } finally {
      if (blockerOpen) await adminClient.query("ROLLBACK");
      await Promise.allSettled(
        [lateFinish, concurrentRecovery].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      await Promise.allSettled([
        finisherClient.query("ROLLBACK"),
        recoveryClient.query("ROLLBACK"),
      ]);
      await Promise.all([finisherClient.end(), recoveryClient.end()]);
    }
  });

  it("denies execution after the consumed publication authorization expires", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    await adminClient.query(
      `UPDATE geo.publication_grants
       SET issued_at = clock_timestamp() - interval '2 seconds',
           expires_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2 AND status = 'consumed'`,
      [tenantId, ids.grant],
    );
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'shadow',
           quota = '{"maxConcurrent":10,"perMinute":50,"perDay":500,"cooldownSeconds":0,"errorBudget":10}'::jsonb,
           kill_switch_enabled = false
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', 'dry_run', 'queued',
               'expired-authorization', $7, $8, clock_timestamp(), clock_timestamp())`,
      [
        tenantId,
        ids.expiredAuthorizationJob,
        ids.grant,
        ids.auditArtifact,
        ids.variant,
        SEED_IDS.zhongtong.toutiao,
        "7".repeat(64),
        payloadHash,
      ],
    );

    const denied = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.expiredAuthorizationJob, ids.expiredAuthorizationAttempt, "expired-auth-worker"],
      ),
    );
    expect(denied.rows[0]).toEqual({
      allowed: false,
      reason: "authorization_expired",
      half_open_probe: false,
    });
    const attempts = await adminClient.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM geo.publication_attempts WHERE id = $1",
      [ids.expiredAuthorizationAttempt],
    );
    expect(attempts.rows[0]?.count).toBe("0");
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

  it("persists tenant governance lifecycles with RLS, least privilege, and audit logs", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const policyDocument = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-governance-v2",
      industry: "travel",
    });
    const governancePolicyHash = sha256Canonical(policyDocument);

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-tenant-governance-integration",
      maxConnections: 4,
    });
    const factory = await loadVariantRepositoryFactory();
    const repository = factory({ runtimeDatabase: database, identityDatabase: database });
    const context = { actorId, tenantId, requestId: "tenant-governance-integration" };
    try {
      const createdPolicy = await repository.createPolicyBundle(context, {
        id: ids.governancePolicy,
        version: "travel-governance-v2",
        policyHash: governancePolicyHash,
        document: policyDocument,
        effectiveAt: "2026-07-15T00:00:00.000Z",
        reason: "Create a reviewed integration policy draft",
      });
      expect(createdPolicy).toMatchObject({
        id: ids.governancePolicy,
        status: "draft",
        policyHash: governancePolicyHash,
      });

      const createdContact = await repository.createContact(context, {
        id: ids.governanceContact,
        type: "wechat",
        label: "治理集成微信",
        value: "ZTGL8888",
        normalizedValue: "ztgl8888",
        isPrimary: false,
        validFrom: "2026-07-15T00:00:00.000Z",
      });
      expect(createdContact).toMatchObject({ tenantId, value: "ZTGL8888", validUntil: null });
      await expect(
        repository.expireContact(context, {
          contactId: SEED_IDS.synthetic.contact,
          reason: "cross tenant must stay hidden",
          validUntil: "2026-07-15T01:00:00.000Z",
        }),
      ).rejects.toThrow("Contact was not found");
      const expiredContact = await repository.expireContact(context, {
        contactId: ids.governanceContact,
        reason: "integration lifecycle complete",
        validUntil: "2026-07-15T01:00:00.000Z",
      });
      expect(expiredContact.validUntil).toBe("2026-07-15T01:00:00.000Z");

      const member = await repository.createMember(context, {
        membershipId: ids.governanceMembership,
        userId: ids.governanceUser,
        email: "governance-editor@example.test",
        displayName: "Governance Editor",
        passwordHash: "argon2-integration-placeholder",
        role: "editor",
      });
      expect(member.capabilities).toContain("content:write");
      expect(member.capabilities).not.toContain("member:manage");
      const publisher = await repository.updateMember(context, {
        membershipId: ids.governanceMembership,
        role: "publisher",
        reason: "Move integration member to publication duty",
      });
      expect(publisher).toMatchObject({ role: "publisher", status: "active" });
      await expect(
        repository.updateMember(context, {
          membershipId: SEED_IDS.zhongtong.membership,
          role: "admin",
          reason: "Must retain one active owner",
        }),
      ).rejects.toThrow("last active owner");

      const transitionedPolicy = await repository.transitionPolicyBundle(context, {
        policyBundleId: ids.governancePolicy,
        targetStatus: "active",
        reason: "Validated policy activation integration",
        changedAt: "2026-07-15T02:00:00.000Z",
      });
      expect(transitionedPolicy).toMatchObject({
        policy: { id: ids.governancePolicy, status: "active" },
        wasChanged: true,
      });

      const channelAccount = await repository.createChannelAccount(context, {
        id: ids.governanceAccount,
        platform: "sohu",
        displayName: "治理集成搜狐号",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        credentialRef: null,
        evidenceType: "manual_import",
        evidenceRefs: ["ticket:governance-integration"],
        status: "needs_verification",
        lastVerifiedAt: null,
      });
      expect(channelAccount.supportedExecutionLevels).toEqual(["dry_run"]);
      const activeAccount = await repository.updateChannelAccount(context, {
        channelAccountId: ids.governanceAccount,
        status: "active",
        lastVerifiedAt: "2026-07-15T03:00:00.000Z",
        reason: "Manual account evidence reviewed",
      });
      expect(activeAccount).toMatchObject({ status: "active" });

      const principal = await repository.createAutomationServicePrincipal(context, {
        id: ids.governancePrincipal,
        name: "governance-automation-producer",
      });
      expect(principal).toMatchObject({
        profile: "automation_producer",
        credentialStatus: "not_issued",
      });
      expect(principal.capabilities).toContain("automation:execute");
      expect(principal.capabilities).not.toContain("tenant:manage");
      expect(principal.capabilities).not.toContain("principal:manage");
      const listed = await repository.listServicePrincipals(context);
      expect(listed.some((item) => item.id === ids.governancePrincipal)).toBe(true);
      const disabled = await repository.setServicePrincipalStatus(context, {
        servicePrincipalId: ids.governancePrincipal,
        status: "disabled",
        reason: "Integration identity rotation",
      });
      expect(disabled).toMatchObject({
        principal: { id: ids.governancePrincipal, status: "disabled" },
        wasChanged: true,
      });

      const persisted = await adminClient.query<{
        action: string;
        before_hash: string | null;
        after_hash: string;
      }>(
        `SELECT action, before_hash, after_hash
         FROM geo.audit_log
         WHERE tenant_id = $1 AND request_id = 'tenant-governance-integration'
         ORDER BY created_at, id`,
        [tenantId],
      );
      expect(persisted.rows.map((row) => row.action)).toEqual([
        "policy_bundle.created",
        "tenant_contact.created",
        "tenant_contact.expired",
        "tenant_member.created",
        "tenant_member.changed",
        "policy_bundle.active",
        "channel_account.created",
        "channel_account.changed",
        "service_principal.created",
        "service_principal.status_changed",
      ]);
      expect(persisted.rows.every((row) => row.after_hash.length === 64)).toBe(true);
      expect(
        persisted.rows
          .filter((row) => row.action.endsWith(".created"))
          .every((row) => row.before_hash === null),
      ).toBe(true);

      const policyState = await adminClient.query<{ id: string; status: string }>(
        "SELECT id, status FROM geo.policy_bundles WHERE tenant_id = $1 AND status IN ('active', 'retired') ORDER BY id",
        [tenantId],
      );
      expect(policyState.rows.filter((row) => row.status === "active")).toEqual([
        { id: ids.governancePolicy, status: "active" },
      ]);
      expect(
        policyState.rows.some(
          (row) => row.id === SEED_IDS.zhongtong.policy && row.status === "retired",
        ),
      ).toBe(true);
    } finally {
      await database.destroy();
    }
  });
});
