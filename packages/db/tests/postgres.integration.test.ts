import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import {
  buildBaselineAuditPolicyDocument,
  ctripPublicContentHash,
  sha256Canonical,
  sha256Text,
} from "@geo/core";
import { travelQuerySetPromptsV1 } from "@geo/visibility";
import { Migrator, sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindHistoricalPublication,
  commissionCtripBridge,
  configureCustomerDemo,
  createDatabase,
  CtripBridgeCommissioningConflictError,
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
const actorId = SEED_IDS.sampleTravel.actor;
const tenantId = SEED_IDS.sampleTravel.tenant;
const syntheticTenantId = SEED_IDS.synthetic.tenant;
const legacyCapabilityTenantId = "21000000-0000-4000-8000-000000000001";
const legacyCapabilityMembers = {
  owner: "21000000-0000-4000-8000-000000000002",
  admin: "21000000-0000-4000-8000-000000000003",
  editor: "21000000-0000-4000-8000-000000000004",
  adminWithoutManage: "21000000-0000-4000-8000-000000000005",
  ownerWithExecute: "21000000-0000-4000-8000-000000000006",
} as const;
const legacyCtripQueryHandoff = {
  attemptId: "22000000-0000-4000-8000-000000000002",
  bridgePrincipalId: "22000000-0000-4000-8000-000000000003",
  candidateId: "1234567890123456789",
  handoffId: "22000000-0000-4000-8000-000000000001",
  jobId: "22000000-0000-4000-8000-000000000004",
  readbackId: "22000000-0000-4000-8000-000000000005",
  receiptId: "22000000-0000-4000-8000-000000000006",
  variantId: "22000000-0000-4000-8000-000000000007",
} as const;
const legacyCtripQueryUrl = `https://m.ctrip.com/webapp/you/community/detail?articleId=${legacyCtripQueryHandoff.candidateId}`;

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
  quotaJobWithoutReadback: "30000000-0000-4000-8000-000000000901",
  quotaAttemptWithoutReadback: "30000000-0000-4000-8000-000000000902",
  quotaConfirmedJob: "30000000-0000-4000-8000-000000000903",
  quotaConfirmedAttempt: "30000000-0000-4000-8000-000000000904",
  quotaConfirmedReceipt: "30000000-0000-4000-8000-000000000905",
  quotaConfirmedReadback: "30000000-0000-4000-8000-000000000906",
  quotaJobAfterReadback: "30000000-0000-4000-8000-000000000907",
  quotaAttemptAfterReadback: "30000000-0000-4000-8000-000000000908",
  isolatedErrorBudgetJob: "30000000-0000-4000-8000-000000000909",
  isolatedErrorBudgetAttempt: "30000000-0000-4000-8000-000000000910",
  configurationFailureJob: "30000000-0000-4000-8000-000000000911",
  configurationFailureAttempt: "30000000-0000-4000-8000-000000000912",
  postConfigurationFailureJob: "30000000-0000-4000-8000-000000000913",
  postConfigurationFailureAttempt: "30000000-0000-4000-8000-000000000914",
  rejectedDeliveryBudgetJob: "30000000-0000-4000-8000-000000000915",
  rejectedDeliveryBudgetAttempt: "30000000-0000-4000-8000-000000000916",
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
  automationRemediatedContentItem: "31000000-0000-4000-8000-000000000001",
  automationRemediatedContentVersion: "31000000-0000-4000-8000-000000000002",
  automationForeignCampaign: "31000000-0000-4000-8000-000000000003",
  automationForeignContentItem: "31000000-0000-4000-8000-000000000004",
  automationForeignContentVersion: "31000000-0000-4000-8000-000000000005",
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
  mediaImportedJob: "30000000-0000-4000-8000-000000000111",
  mediaImportedAttempt: "30000000-0000-4000-8000-000000000112",
  mediaImportedAsset: "30000000-0000-4000-8000-000000000113",
  mediaImportedInspection: "30000000-0000-4000-8000-000000000114",
  mediaImportedBinding: "30000000-0000-4000-8000-000000000115",
  mediaImportedSuccessorVersion: "30000000-0000-4000-8000-000000000116",
  mediaEditedVersion: "30000000-0000-4000-8000-000000000117",
  mediaInvalidEditedVersion: "30000000-0000-4000-8000-000000000118",
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
  variantSupersedeAuditRun: "30000000-0000-4000-8000-000000000200",
  variantSupersedeReplacement: "30000000-0000-4000-8000-000000000201",
  automationTerminalSyncBatch: "30000000-0000-4000-8000-000000009801",
  automationTerminalSyncRun: "30000000-0000-4000-8000-000000009802",
  automationTerminalSyncTarget: "30000000-0000-4000-8000-000000009803",
  automationBackfillBatch: "30000000-0000-4000-8000-000000009804",
  automationBackfillConfirmedRun: "30000000-0000-4000-8000-000000009805",
  automationBackfillFailedRun: "30000000-0000-4000-8000-000000009806",
  automationBackfillConfirmedTarget: "30000000-0000-4000-8000-000000009807",
  automationBackfillFailedTarget: "30000000-0000-4000-8000-000000009808",
  automationResourceWaitBatch: "30000000-0000-4000-8000-000000009809",
  automationResourceWaitRun: "30000000-0000-4000-8000-000000009810",
  automationResourceWaitTarget: "30000000-0000-4000-8000-000000009811",
};

const payloadHash = "a".repeat(64);
const factHash = "b".repeat(64);
const policyHash = "c".repeat(64);
const auditHash = "d".repeat(64);
const tokenHash = "e".repeat(64);
const requestHash = "f".repeat(64);

interface VariantRepositoryForTest {
  getCtripAccountAnalytics(context: {
    actorId: string;
    tenantId: string;
    requestId: string;
  }): Promise<{
    reportingAccountCount: number;
    totals: { publishCount: number; views: number };
    accounts: readonly {
      channelAccountId: string;
      dataStatus: "pending" | "ready";
      publishCount: number | null;
      totalViews: number | null;
    }[];
  }>;
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
  createContentVersion(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      versionId: string;
      contentItemId: string;
      summary: string;
      bodyMarkdown: string;
      payload: Readonly<Record<string, unknown>>;
      payloadHash: string;
    },
  ): Promise<{ id: string; latestVersion: number | null; latestVersionId: string | null }>;
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
  supersedeVariant(
    context: { actorId: string; tenantId: string; requestId: string },
    input: { variantId: string; reason: string; supersededAt: string },
  ): Promise<{
    id: string;
    state: "superseded";
    frozenAt: string;
    payloadHash: string;
  }>;
  loadAuditContext(
    context: { actorId: string; tenantId: string; requestId: string },
    variantId: string,
    capturedAt: string,
  ): Promise<{
    priorVariants: readonly {
      variantId: string;
      platform: "toutiao" | "sohu" | "ctrip_community";
      payloadHash: string;
      publicContentHash?: string;
      bodyMarkdown: string;
    }[];
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
      attemptId: string;
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
      role:
        "owner" | "admin" | "editor" | "auditor" | "publisher" | "automation_operator" | "viewer";
    },
  ): Promise<{
    id: string;
    role: string;
    capabilities: readonly string[];
    enabledModules: readonly string[];
    status: string;
  }>;
  updateMember(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      membershipId: string;
      role?:
        "owner" | "admin" | "editor" | "auditor" | "publisher" | "automation_operator" | "viewer";
      status?: "active" | "suspended";
      reason: string;
    },
  ): Promise<{ id: string; role: string; capabilities: readonly string[]; status: string }>;
  updateMemberModules(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      membershipId: string;
      enabledModules: readonly (
        "trend_discovery" | "ai_content" | "priority_distribution" | "agent_automation"
      )[];
      reason: string;
    },
  ): Promise<{ id: string; enabledModules: readonly string[] }>;
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
      status: "active";
      lastVerifiedAt: null;
    },
  ): Promise<{ id: string; status: string; supportedExecutionLevels: readonly string[] }>;
  listChannelAccounts(context: {
    actorId: string;
    tenantId: string;
    requestId: string;
  }): Promise<readonly { id: string }[]>;
  getPriorityPlatformAccountAnalytics(context: {
    actorId: string;
    tenantId: string;
    requestId: string;
  }): Promise<{ accounts: readonly { channelAccountId: string }[] }>;
  updateChannelAccount(
    context: { actorId: string; tenantId: string; requestId: string },
    input: {
      channelAccountId: string;
      status: "active";
      lastVerifiedAt: string;
      reason: string;
    },
  ): Promise<{ id: string; status: string; supportedExecutionLevels: readonly string[] }>;
  deleteChannelAccount(
    context: { actorId: string; tenantId: string; requestId: string },
    channelAccountId: string,
  ): Promise<void>;
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

interface TrendRepositoryContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly role: "admin";
  readonly capabilities: readonly string[];
}

interface TrendRepositoryInput {
  readonly id: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly summary?: string;
  readonly canonicalUrl?: string;
  readonly sourceRank?: number;
  readonly heatValue?: number;
  readonly observedAt: string;
  readonly sourceUpdatedAt?: string;
  readonly fingerprint: string;
  readonly observationKey: string;
  readonly heatScore: number;
  readonly freshnessScore: number;
  readonly freshnessBand: "emerging" | "rising" | "cooling" | "stale" | "expired";
  readonly createdAt: string;
}

interface TrendRepositoryForTest {
  persistObservations(
    context: TrendRepositoryContext,
    inputs: readonly TrendRepositoryInput[],
  ): Promise<
    readonly { readonly observation: Record<string, unknown>; readonly wasCreated: boolean }[]
  >;
  listObservations(
    context: TrendRepositoryContext,
    input: { readonly observedAfter: string; readonly limit: number },
  ): Promise<readonly Record<string, unknown>[]>;
}

async function loadTrendRepositoryFactory(): Promise<
  (runtimeDatabase: ReturnType<typeof createDatabase>) => TrendRepositoryForTest
> {
  const repositoryModuleUrl = new URL(
    "../../../apps/api/src/postgres-trend-repository.ts",
    import.meta.url,
  ).href;
  const repositoryModule: unknown = await import(repositoryModuleUrl);
  const factory = (repositoryModule as { createPostgresTrendRepository?: unknown })
    .createPostgresTrendRepository;
  if (typeof factory !== "function") {
    throw new Error("PostgreSQL trend repository factory is unavailable");
  }
  return factory as (runtimeDatabase: ReturnType<typeof createDatabase>) => TrendRepositoryForTest;
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

interface LegacyCtripQueryUpgradeRow {
  candidate_matches_final: boolean;
  identity_allowed: boolean;
  state: string;
  submit_candidate_external_id: string;
  submit_candidate_external_url: string;
  url_allowed: boolean;
}

let adminClient: Client | undefined;
let databaseDir: string | undefined;
let legacyCtripQueryUpgrade: LegacyCtripQueryUpgradeRow | undefined;
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
      [tenantId, ids.campaign, SEED_IDS.sampleTravel.brand],
    );
    await client.query(
      `INSERT INTO geo.content_items
         (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
       VALUES ($1, $2, $3, $4, 'Audited article', 'evidence', 'audited', 'integration')`,
      [tenantId, ids.contentItem, ids.campaign, SEED_IDS.sampleTravel.brand],
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
      [tenantId, ids.variant, ids.contentVersion, SEED_IDS.sampleTravel.toutiao, payloadHash],
    );
    await client.query(
      `INSERT INTO geo.audit_runs
         (tenant_id, id, variant_id, policy_bundle_id, status, requested_by_actor_id,
          completed_at)
       VALUES ($1, $2, $3, $4, 'passed', $5, clock_timestamp())`,
      [tenantId, ids.auditRun, ids.variant, SEED_IDS.sampleTravel.policy, actorId],
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
        SEED_IDS.sampleTravel.toutiao,
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
          SEED_IDS.sampleTravel.toutiao,
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

  const browserBaselineMigration = await baselineMigrator.migrateTo(
    "0077_generic_browser_assisted_handoffs",
  );
  if (browserBaselineMigration.error !== undefined) {
    await database.destroy();
    throw browserBaselineMigration.error;
  }

  const legacyUpgradeClient = new Client({
    user: "postgres",
    password,
    port,
    host: "127.0.0.1",
    database: databaseName,
  });
  await legacyUpgradeClient.connect();
  try {
    await legacyUpgradeClient.query("BEGIN");
    await legacyUpgradeClient.query("SET LOCAL session_replication_role = replica");
    await legacyUpgradeClient.query(
      `INSERT INTO geo.publication_assisted_handoffs (
         tenant_id, id, job_id, attempt_id, channel_account_id, variant_id,
         platform, state, payload_hash, audit_hash, preview_hash, adapter_version,
         idempotency_key, session_evidence_hash, draft_evidence_hash,
         submit_evidence_hash, submit_permit_hash, submit_permit_expires_at,
         submit_permit_consumed_at, external_id, external_url, expires_at,
         created_by_actor_id, bridge_service_principal_id, external_draft_id,
         submit_permit_issued_by_actor_id, submit_permit_consumed_by_principal_id,
         submit_outcome, submit_evidence_kind, submit_observed_at,
         publication_receipt_id, publication_readback_id,
         readback_outcome, readback_evidence_kind, readback_evidence_hash,
         readback_observed_at, observed_payload_hash,
         prepare_outcome, prepare_evidence_kind, prepare_evidence_hash,
         prepare_observed_at, media_manifest_hash,
         submit_candidate_external_id, submit_candidate_external_url,
         public_content_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         'ctrip_community', 'confirmed', $7, $8, $9, 'ctrip-browser-v1',
         'legacy-ctrip-query-upgrade', $10, $11,
         $12, $13, clock_timestamp() + interval '20 minutes',
         clock_timestamp() - interval '1 minute', $14, $15,
         clock_timestamp() + interval '30 minutes',
         $16, $17, 'legacy-ctrip-draft',
         $16, $17, 'uncertain', 'browser', clock_timestamp() - interval '1 minute',
         $18, $19, 'confirmed', 'platform_readback', $20,
         clock_timestamp(), $21, 'prepared', 'browser', $22,
         clock_timestamp() - interval '2 minutes', $23,
         $14, $15, $21
       )`,
      [
        legacyCapabilityTenantId,
        legacyCtripQueryHandoff.handoffId,
        legacyCtripQueryHandoff.jobId,
        legacyCtripQueryHandoff.attemptId,
        "22000000-0000-4000-8000-000000000008",
        legacyCtripQueryHandoff.variantId,
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
        legacyCtripQueryHandoff.candidateId,
        legacyCtripQueryUrl,
        legacyCapabilityMembers.owner,
        legacyCtripQueryHandoff.bridgePrincipalId,
        legacyCtripQueryHandoff.receiptId,
        legacyCtripQueryHandoff.readbackId,
        "8".repeat(64),
        "9".repeat(64),
        "a".repeat(64),
        "b".repeat(64),
      ],
    );
    await legacyUpgradeClient.query("COMMIT");
  } catch (error) {
    await legacyUpgradeClient.query("ROLLBACK");
    throw error;
  } finally {
    await legacyUpgradeClient.end();
  }

  const migration = await migrateToLatest(database);
  if (migration.error !== undefined) {
    await database.destroy();
    throw migration.error;
  }
  const upgradedLegacyClient = new Client({
    user: "postgres",
    password,
    port,
    host: "127.0.0.1",
    database: databaseName,
  });
  await upgradedLegacyClient.connect();
  try {
    const upgraded = await upgradedLegacyClient.query<LegacyCtripQueryUpgradeRow>(
      `SELECT state, submit_candidate_external_id, submit_candidate_external_url,
              submit_candidate_external_id = external_id AND
                submit_candidate_external_url = external_url AS candidate_matches_final,
              geo.publication_public_url_matches_platform(
                platform, submit_candidate_external_url
              ) AS url_allowed,
              geo.browser_publication_identity_allowed(
                platform, submit_candidate_external_id, submit_candidate_external_url
              ) AS identity_allowed
       FROM geo.publication_assisted_handoffs
       WHERE id = $1`,
      [legacyCtripQueryHandoff.handoffId],
    );
    legacyCtripQueryUpgrade = upgraded.rows[0];
    await upgradedLegacyClient.query("BEGIN");
    await upgradedLegacyClient.query("SET LOCAL session_replication_role = replica");
    await upgradedLegacyClient.query(
      "DELETE FROM geo.publication_assisted_handoffs WHERE id = $1",
      [legacyCtripQueryHandoff.handoffId],
    );
    await upgradedLegacyClient.query("COMMIT");
  } catch (error) {
    await upgradedLegacyClient.query("ROLLBACK");
    throw error;
  } finally {
    await upgradedLegacyClient.end();
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
  it("upgrades a canonical legacy Ctrip query handoff without changing its identity", () => {
    expect(legacyCtripQueryUpgrade).toEqual({
      candidate_matches_final: true,
      identity_allowed: true,
      state: "confirmed",
      submit_candidate_external_id: legacyCtripQueryHandoff.candidateId,
      submit_candidate_external_url: legacyCtripQueryUrl,
      url_allowed: true,
    });
  });

  it("accepts only the Ctrip canonical public URL bound to the same numeric identity", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const externalId = "341873250";
    const canonicalUrl = `https://m.ctrip.com/webapp/you/community/detail?articleId=${externalId}`;
    const policy = await adminClient.query<{
      canonical_identity: boolean;
      canonical_url: boolean;
      extra_query_rejected: boolean;
      fragment_rejected: boolean;
      internal_host_rejected: boolean;
      mismatched_identity_rejected: boolean;
      non_numeric_identity_rejected: boolean;
    }>(
      `SELECT
         geo.browser_publication_identity_allowed(
           'ctrip_community', $1, $2
         ) AS canonical_identity,
         geo.publication_public_url_matches_platform(
           'ctrip_community', $2
         ) AS canonical_url,
         NOT geo.browser_publication_identity_allowed(
           'ctrip_community', $1, $3
         ) AS mismatched_identity_rejected,
         NOT geo.browser_publication_identity_allowed(
           'ctrip_community', 'ctrip-' || $1, $2
         ) AS non_numeric_identity_rejected,
         NOT geo.publication_public_url_matches_platform(
           'ctrip_community', $2 || '&source=test'
         ) AS extra_query_rejected,
         NOT geo.publication_public_url_matches_platform(
           'ctrip_community', $2 || '#fragment'
         ) AS fragment_rejected,
         NOT geo.publication_public_url_matches_platform(
           'ctrip_community', 'https://we.ctrip.com/webapp/you/community/detail?articleId=' || $1
         ) AS internal_host_rejected`,
      [
        externalId,
        canonicalUrl,
        "https://m.ctrip.com/webapp/you/community/detail?articleId=123450006",
      ],
    );
    expect(policy.rows[0]).toEqual({
      canonical_identity: true,
      canonical_url: true,
      extra_query_rejected: true,
      fragment_rejected: true,
      internal_host_rejected: true,
      mismatched_identity_rejected: true,
      non_numeric_identity_rejected: true,
    });
  });

  it("applies every migration and seeds exact Sample travel tenant contact facts", async () => {
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
      [tenantId, SEED_IDS.sampleTravel.querySetVersion],
    );
    const competitors = await adminClient.query<{ display_name: string; source_ref: string }>(
      `SELECT display_name, source_ref
       FROM geo.brand_competitors
       WHERE tenant_id = $1 AND brand_id = $2
       ORDER BY display_name`,
      [tenantId, SEED_IDS.sampleTravel.brand],
    );
    const upgradedCapabilities = await adminClient.query<{
      capabilities: string[];
      enabled_modules: string[];
      role: string;
      user_id: string;
    }>(
      `SELECT user_id, role, capabilities, enabled_modules
       FROM geo.tenant_memberships
       WHERE tenant_id = $1
      ORDER BY user_id`,
      [legacyCapabilityTenantId],
    );
    const automationFunctions = await adminClient.query<{
      checkpoint: string;
      priorityReadbackExpiry: string;
      reconcile: string;
    }>(
      `SELECT
         pg_get_functiondef('geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure) AS checkpoint,
         pg_get_functiondef('geo.reconcile_automation_run(uuid,text,integer,integer,text,text)'::regprocedure) AS reconcile,
         pg_get_functiondef('geo.expire_priority_platform_readback_windows()'::regprocedure) AS "priorityReadbackExpiry"`,
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
      "0024_ctrip_draft_prepare_lease",
      "0025_ctrip_unattended_browser_publication",
      "0026_ctrip_prepare_execution_level",
      "0027_ctrip_publication_payload_limits",
      "0028_ctrip_prepare_diagnostics",
      "0029_ctrip_handoff_terminal_sync",
      "0030_ctrip_readback_identity_sync",
      "0031_ctrip_post_submit_readback_recovery",
      "0032_ctrip_targeted_unattended_readback_claim",
      "0033_ctrip_candidate_url_query",
      "0034_ctrip_readback_lease_exclusion",
      "0035_automation_execution_levels",
      "0036_automation_media_checkpoint",
      "0037_automation_media_checkpoint_content_binding",
      "0038_ctrip_content_bound_readback",
      "0039_ctrip_unattended_submit_permit_recovery",
      "0040_ctrip_session_reauth_circuit",
      "0041_ctrip_handoff_commit_recovery",
      "0042_ctrip_release_phase_gate",
      "0043_historical_publication_bindings",
      "0044_ctrip_bridge_commissioning",
      "0045_automation_operator_role",
      "0046_restore_ctrip_release_phase_acl",
      "0047_automation_unattended_batch_gate",
      "0048_ctrip_uncertain_readback_phase_c",
      "0049_ctrip_delayed_public_readback",
      "0050_automation_delivery_failure_semantics",
      "0051_ctrip_account_runtime_bindings",
      "0052_channel_account_runtime_cleanup",
      "0053_ctrip_authenticated_session_state",
      "0054_ctrip_readback_budget_repair",
      "0055_ctrip_reopen_readback_jobs",
      "0056_remove_ctrip_phase_c_admission",
      "0057_remove_channel_account_verification",
      "0058_automation_publication_terminal_sync",
      "0059_reopen_obsolete_ctrip_evidence_failures",
      "0060_automation_distribution_cursors",
      "0061_immediate_ctrip_account_controls",
      "0062_pending_automation_target_reassignment",
      "0063_publication_error_budget_failures_only",
      "0064_automation_template_rotation_cursors",
      "0065_ctrip_account_analytics",
      "0066_restore_ctrip_analytics_acl",
      "0067_public_readback_publication_quota",
      "0068_automation_delivery_wait_and_account_error_budget",
      "0069_publication_delivery_error_budget",
      "0070_tenant_ctrip_history_baseline",
      "0071_automation_confirmed_terminal_sync",
      "0072_ctrip_unattended_submit_recovery",
      "0073_allow_evidence_free_media",
      "0074_expand_generic_publication_platforms",
      "0075_trend_observations",
      "0076_priority_platform_browser_runtime",
      "0077_generic_browser_assisted_handoffs",
      "0078_generic_browser_submit_readback",
      "0079_tenant_member_modules",
      "0080_generic_browser_unattended",
      "0081_generic_browser_readback_claims",
      "0082_priority_platform_review_poll_window",
      "0083_priority_platform_account_analytics",
      "0084_runtime_provider_configurations",
      "0085_manual_media_reviews",
      "0086_force_calibrate_account_runtime",
      "0087_manual_readback_reopen",
      "0088_priority_platform_ten_minute_readback",
      "0089_preserve_manual_readback_reopen_window",
      "0090_expire_reopened_readback_without_evidence",
      "0091_claim_reopened_readback_by_deadline",
      "0092_restore_manual_readback_acl_grants",
      "0093_restore_force_calibrate_acl_grant",
      "0094_purge_abandoned_automation_targets",
      "0095_stabilize_manual_runtime_calibration",
      "0096_public_readback_quota_and_default_30",
      "0097_archive_channel_accounts",
      "0098_automation_target_remediation_registry",
      "0099_automation_manual_media_review_pause",
      "0100_restart_automation_target_remediation",
      "0101_campaign_automation_remediation_setting",
      "0102_persist_readback_candidates",
      "0103_publisher_status_completion",
      "0104_baijiahao_account_analytics",
      "0105_preserve_manual_calibration_probe",
      "0106_enforce_publisher_status_readback_lease",
      "0107_async_priority_platform_readback",
      "0108_cancel_automation_delivery_work",
      "0109_automation_resource_conflict_retry",
      "0110_publisher_status_readback_lease_order",
      "0111_browser_runtime_error_budget_and_prepared_conflict",
      "0112_automation_audit_manual_review_transition",
      "0113_allow_challenge_degraded_publication",
      "0114_gate_blocked_review_and_ctrip_async_readback",
      "0115_gate_blocked_review_reopen_and_sync_semantics",
      "0116_restore_missing_runtime_function_grants",
      "0117_publication_handoff_recovery_and_quota_queuing",
      "0118_error_budget_exhaustion_policy",
      "0119_automation_target_checkpoint",
      "0120_channel_account_platform_mute",
      "0121_campaign_automation_plans",
      "0122_campaign_prompt_templates",
      "0123_channel_account_archive_atomicity",
      "0124_sohu_netease_account_analytics",
      "0125_automation_media_checkpoint_content_item_rebind",
      "0126_priority_platform_analytics_publication_exclusion",
      "0127_browser_grant_cooldown_recovery",
      "0128_handoff_half_open_probe_lineage",
      "0129_classify_prepared_submit_blockers",
      "0130_publisher_rejection_remediation",
      "0131_restore_publisher_rejection_acl",
      "0132_ctrip_analytics_favorites",
      "0133_async_priority_readback_terminal_semantics",
      "0134_recover_expired_pre_submit_handoffs",
      "0135_netease_draft_retained_submit_semantics",
      "0136_restore_prepared_browser_recovery_transitions",
      "0137_account_scoped_publication_claims",
      "0138_restore_account_browser_operation_acl",
      "0139_ctrip_readback_budget_guard",
      "0140_zhihu_account_login_runtime",
    ]);
    expect(automationFunctions.rows[0]?.checkpoint).toContain("delivery_failed");
    expect(automationFunctions.rows[0]?.reconcile).toContain("delivery_failure_count");
    expect(automationFunctions.rows[0]?.reconcile).toContain("AUTOMATION_DELIVERY_FAILED");
    expect(automationFunctions.rows[0]?.priorityReadbackExpiry).toContain("publisher_rejected");
    expect(automationFunctions.rows[0]?.priorityReadbackExpiry).toContain(
      "target.state IN ('publisher_rejected', 'delivery_failed')",
    );
    expect(contacts.rows.map((row) => row.value)).toEqual([
      "4000000001",
      "TRAVEL_DEMO_01",
      "TRAVEL_DEMO_02",
    ]);
    expect(queryPack.rows[0]).toEqual({
      prompt_hash: sha256Canonical(travelQuerySetPromptsV1),
      prompts: travelQuerySetPromptsV1,
    });
    expect(competitors.rows).toEqual([
      { display_name: "示例竞品甲", source_ref: "seed:sample-travel:competitors:v1" },
      { display_name: "示例竞品乙", source_ref: "seed:sample-travel:competitors:v1" },
      { display_name: "示例竞品丙", source_ref: "seed:sample-travel:competitors:v1" },
    ]);
    expect(upgradedCapabilities.rows).toEqual([
      {
        user_id: legacyCapabilityMembers.owner,
        role: "owner",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
        enabled_modules: [],
      },
      {
        user_id: legacyCapabilityMembers.admin,
        role: "admin",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
        enabled_modules: [],
      },
      {
        user_id: legacyCapabilityMembers.editor,
        role: "editor",
        capabilities: ["automation:manage"],
        enabled_modules: [],
      },
      {
        user_id: legacyCapabilityMembers.adminWithoutManage,
        role: "admin",
        capabilities: ["tenant:read", "principal:manage"],
        enabled_modules: [],
      },
      {
        user_id: legacyCapabilityMembers.ownerWithExecute,
        role: "owner",
        capabilities: ["automation:manage", "automation:execute", "principal:manage"],
        enabled_modules: [],
      },
    ]);
  });

  it("deduplicates trend observations by source and fingerprint in the real repository", async () => {
    if (postgresPort === undefined) {
      throw new Error("PostgreSQL test port is not initialized");
    }
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const runtimeDatabase = createDatabase({
      connectionString,
      applicationName: "geo-trend-repository-integration",
    });
    try {
      const repository = await loadTrendRepositoryFactory();
      const trendRepository = repository(runtimeDatabase);
      const context: TrendRepositoryContext = {
        actorId,
        tenantId,
        requestId: "trend-repository-integration",
        role: "admin",
        capabilities: ["content:read", "content:write", "automation:execute"],
      };
      const fingerprint = "a".repeat(64);
      const makeInput = (
        id: string,
        observationKey: string,
        sourceKey: string,
        observedAt: string,
      ): TrendRepositoryInput => ({
        id,
        sourceKey,
        title: "云南旅游线路推荐",
        normalizedTitle: "云南旅游线路推荐",
        summary: "来源观测",
        observedAt,
        fingerprint,
        observationKey,
        heatScore: 80,
        freshnessScore: 0.9,
        freshnessBand: "rising",
        createdAt: observedAt,
      });
      const inputs = [
        makeInput(
          "30000000-0000-4000-8000-000000009901",
          "b".repeat(64),
          "toutiao",
          "2026-08-03T11:55:00.000Z",
        ),
        makeInput(
          "30000000-0000-4000-8000-000000009902",
          "c".repeat(64),
          "toutiao",
          "2026-08-03T11:58:00.000Z",
        ),
        makeInput(
          "30000000-0000-4000-8000-000000009903",
          "d".repeat(64),
          "weibo",
          "2026-08-03T11:57:00.000Z",
        ),
      ];
      const persisted = await trendRepository.persistObservations(context, inputs);
      const rows = await trendRepository.listObservations(context, {
        observedAfter: "2026-08-03T00:00:00.000Z",
        limit: 10,
      });

      expect(persisted).toHaveLength(3);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.sourceKey)).toEqual(["toutiao", "weibo"]);
      expect(rows[0]?.id).toBe(inputs[1]?.id);
      expect(rows[0]?.firstObservedAt).toBe("2026-08-03T11:55:00.000Z");
    } finally {
      await runtimeDatabase.destroy();
    }
  });

  it("defaults eligible browser account controls to unattended without overriding operators", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const accountId = "30000000-0000-4000-8000-000000009804";
    await adminClient.query(
      `INSERT INTO geo.channel_accounts (
         tenant_id, id, platform, display_name, capability,
         supported_execution_levels, capability_evidence_type,
         capability_evidence_refs, status
       ) VALUES (
         $1, $2, 'sohu', 'Immediate unattended Sohu account', 'browser_assisted',
         ARRAY['dry_run','assisted','unattended']::text[], 'preview',
         '[]'::jsonb, 'active'
       )`,
      [tenantId, accountId],
    );
    const generated = await adminClient.query<{ mode: string; reason: string | null }>(
      `SELECT mode, reason FROM geo.automation_controls
       WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
      [tenantId, accountId],
    );
    expect(generated.rows).toEqual([
      {
        mode: "unattended",
        reason: "Default per-account publication capacity",
      },
    ]);

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'paused', reason = 'Operator pause'
       WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
      [tenantId, accountId],
    );
    await adminClient.query(
      `UPDATE geo.channel_accounts SET daily_publish_quota = 11
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, accountId],
    );
    const preserved = await adminClient.query<{ mode: string; per_day: number }>(
      `SELECT control.mode, (control.quota ->> 'perDay')::integer AS per_day
       FROM geo.automation_controls AS control
       WHERE control.tenant_id = $1 AND control.scope_type = 'account'
         AND control.scope_key = $2`,
      [tenantId, accountId],
    );
    expect(preserved.rows).toEqual([{ mode: "paused", per_day: 11 }]);
  });

  it("leases authenticated Ctrip analytics refreshes and defers completed accounts for one hour", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const accountId = "30000000-0000-4000-8000-000000009805";
    const principalId = "30000000-0000-4000-8000-000000009806";

    await adminClient.query(
      `INSERT INTO geo.service_principals
         (tenant_id, id, name, kind, profile, capabilities, status)
       VALUES ($1, $2, 'ctrip-analytics-integration', 'integration', 'custom',
               '[]'::jsonb, 'active')`,
      [tenantId, principalId],
    );
    await adminClient.query(
      `INSERT INTO geo.channel_accounts (
         tenant_id, id, platform, display_name, capability,
         supported_execution_levels, capability_evidence_type,
         capability_evidence_refs, status
       ) VALUES (
         $1, $2, 'ctrip_community', 'Analytics integration account', 'browser_assisted',
         ARRAY['dry_run','assisted','unattended']::text[], 'browser_screenshot',
         '[]'::jsonb, 'active'
       )`,
      [tenantId, accountId],
    );
    await adminClient.query(
      `UPDATE geo.ctrip_account_runtime_bindings
       SET session_state = 'authenticated', bridge_principal_id = $3,
           last_checked_at = clock_timestamp(), last_ready_at = clock_timestamp()
       WHERE tenant_id = $1 AND channel_account_id = $2`,
      [tenantId, accountId, principalId],
    );

    const claimed = await runtimeTransaction(
      (client) =>
        client.query<{ account_id: string | null }>(
          `SELECT geo.claim_next_ctrip_account_analytics_refresh(120) AS account_id`,
        ),
      { actor: principalId },
    );
    expect(claimed.rows[0]?.account_id).toBe(accountId);

    await runtimeTransaction(
      (client) =>
        client.query(
          `WITH observed AS (
             SELECT clock_timestamp() AS observed_at
           ), inserted AS (
             INSERT INTO geo.ctrip_account_analytics_snapshots (
               tenant_id, channel_account_id, snapshot_hour, report_period,
               publish_count, featured_count, quality_count, featured_quality_rate,
               content_heat, total_views, total_viewers, total_interactions,
               total_interactors, traffic_sources, works, source_hash, observed_at
             )
             SELECT $1, $2, date_trunc('hour', observed_at), '近30天',
                    3, 1, 1, 66.67, 1280, 3200, 2600, 180, 140,
                    '{"推荐":70,"搜索":30}'::jsonb,
                    '[{"title":"家庭线路","views":3200}]'::jsonb,
                    $3, observed_at
             FROM observed
             RETURNING id
           )
           UPDATE geo.ctrip_account_analytics_sync_state
           SET next_refresh_at = clock_timestamp() + interval '1 hour',
               lease_owner = NULL, lease_expires_at = NULL,
               last_succeeded_at = clock_timestamp(),
               last_error_code = NULL, last_error_message = NULL
           WHERE tenant_id = $1 AND channel_account_id = $2
             AND lease_owner = $4
             AND EXISTS (SELECT 1 FROM inserted)`,
          [tenantId, accountId, "a".repeat(64), principalId],
        ),
      { actor: principalId },
    );

    const state = await runtimeTransaction(
      async (client) => {
        const snapshot = await client.query<{
          content_heat: string;
          report_period: string;
          total_views: string;
        }>(
          `SELECT content_heat::text, report_period, total_views::text
           FROM geo.ctrip_account_analytics_snapshots
           WHERE channel_account_id = $1`,
          [accountId],
        );
        const nextClaim = await client.query<{ account_id: string | null }>(
          `SELECT geo.claim_next_ctrip_account_analytics_refresh(120) AS account_id`,
        );
        return { nextClaim, snapshot };
      },
      { actor: principalId },
    );
    expect(state.snapshot.rows).toEqual([
      { content_heat: "1280.00", report_period: "近30天", total_views: "3200" },
    ]);
    expect(state.nextClaim.rows[0]?.account_id).toBeNull();
  });

  it("persists Sohu analytics with nullable native metrics and rejects a stale lease generation", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const accountId = "30000000-0000-4000-8000-000000009807";
    const principalId = "30000000-0000-4000-8000-000000009808";

    await adminClient.query(
      `INSERT INTO geo.service_principals
         (tenant_id, id, name, kind, profile, capabilities, status)
       VALUES ($1, $2, 'sohu-analytics-integration', 'integration', 'custom',
               '[]'::jsonb, 'active')`,
      [tenantId, principalId],
    );
    await adminClient.query(
      `INSERT INTO geo.channel_accounts (
         tenant_id, id, platform, display_name, capability,
         supported_execution_levels, capability_evidence_type,
         capability_evidence_refs, status
       ) VALUES (
         $1, $2, 'sohu', 'Sohu analytics integration account', 'browser_assisted',
         ARRAY['dry_run','assisted','unattended']::text[], 'browser_screenshot',
         '[]'::jsonb, 'active'
       )`,
      [tenantId, accountId],
    );
    await adminClient.query(
      `UPDATE geo.ctrip_account_runtime_bindings
       SET session_state = 'authenticated', bridge_principal_id = $3,
           last_checked_at = clock_timestamp(), last_ready_at = clock_timestamp()
       WHERE tenant_id = $1 AND channel_account_id = $2`,
      [tenantId, accountId, principalId],
    );

    const firstLease = await runtimeTransaction(
      async (client) => {
        const claimed = await client.query<{ account_id: string | null }>(
          `SELECT geo.claim_next_priority_platform_account_analytics_refresh(120) AS account_id`,
        );
        const lease = await client.query<{ lease_expires_at: string }>(
          `SELECT lease_expires_at::text
           FROM geo.ctrip_account_analytics_sync_state
           WHERE channel_account_id = $1`,
          [accountId],
        );
        return { claimed, lease };
      },
      { actor: principalId },
    );
    expect(firstLease.claimed.rows[0]?.account_id).toBe(accountId);
    const firstLeaseExpiresAt = firstLease.lease.rows[0]?.lease_expires_at;
    expect(firstLeaseExpiresAt).toBeTruthy();

    await adminClient.query(
      `UPDATE geo.ctrip_account_analytics_sync_state
       SET next_refresh_at = clock_timestamp() - interval '1 second',
           lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE channel_account_id = $1`,
      [accountId],
    );
    const secondLease = await runtimeTransaction(
      async (client) => {
        const claimed = await client.query<{ account_id: string | null }>(
          `SELECT geo.claim_next_priority_platform_account_analytics_refresh(120) AS account_id`,
        );
        const lease = await client.query<{ lease_expires_at: string }>(
          `SELECT lease_expires_at::text
           FROM geo.ctrip_account_analytics_sync_state
           WHERE channel_account_id = $1`,
          [accountId],
        );
        return { claimed, lease };
      },
      { actor: principalId },
    );
    expect(secondLease.claimed.rows[0]?.account_id).toBe(accountId);
    const secondLeaseExpiresAt = secondLease.lease.rows[0]?.lease_expires_at;
    expect(secondLeaseExpiresAt).toBeTruthy();
    expect(secondLeaseExpiresAt).not.toBe(firstLeaseExpiresAt);

    const staleCompletion = await runtimeTransaction(
      (client) =>
        client.query(
          `UPDATE geo.ctrip_account_analytics_sync_state
           SET lease_owner = NULL, lease_expires_at = NULL
           WHERE channel_account_id = $1 AND lease_owner = $2
             AND lease_expires_at = $3::timestamptz`,
          [accountId, principalId, firstLeaseExpiresAt],
        ),
      { actor: principalId },
    );
    expect(staleCompletion.rowCount).toBe(0);

    const completed = await runtimeTransaction(
      (client) =>
        client.query(
          `WITH authorized AS (
             SELECT sync.channel_account_id
             FROM geo.ctrip_account_analytics_sync_state AS sync
             JOIN geo.channel_accounts AS account
               ON account.tenant_id = sync.tenant_id
              AND account.id = sync.channel_account_id
              AND account.platform = 'sohu'
              AND account.status = 'active'
              AND account.archived_at IS NULL
             WHERE sync.channel_account_id = $1
               AND sync.lease_owner = $2
               AND sync.lease_expires_at = $3::timestamptz
               AND sync.lease_expires_at > clock_timestamp()
             FOR UPDATE OF sync
             FOR SHARE OF account
           ), upserted AS (
             INSERT INTO geo.ctrip_account_analytics_snapshots (
               tenant_id, channel_account_id, platform, snapshot_hour, report_period,
               publish_count, featured_count, quality_count, featured_quality_rate,
               content_heat, total_views, total_viewers, total_interactions,
               total_interactors, total_impressions, total_reads, total_likes,
               total_comments, traffic_sources, works, source_hash, observed_at
             )
             SELECT $4, authorized.channel_account_id, 'sohu', date_trunc('hour', clock_timestamp()),
                    '内容管理最近 1 条已发布作品', 1, 0, 0, 0,
                    0, 28, 0, 2, 0, NULL, 28, NULL, 2,
                    '{}'::jsonb, '[]'::jsonb, $5, clock_timestamp()
             FROM authorized
             RETURNING channel_account_id
           )
           UPDATE geo.ctrip_account_analytics_sync_state AS sync
           SET next_refresh_at = clock_timestamp() + interval '1 hour',
               lease_owner = NULL, lease_expires_at = NULL,
               last_succeeded_at = clock_timestamp(),
               last_error_code = NULL, last_error_message = NULL
           FROM upserted
           WHERE sync.channel_account_id = upserted.channel_account_id
           RETURNING sync.channel_account_id`,
          [accountId, principalId, secondLeaseExpiresAt, tenantId, "b".repeat(64)],
        ),
      { actor: principalId },
    );
    expect(completed.rows).toEqual([{ channel_account_id: accountId }]);

    const snapshot = await adminClient.query<{
      content_heat: string;
      total_impressions: string | null;
      total_interactions: string;
      total_likes: string | null;
    }>(
      `SELECT content_heat::text, total_interactions::text,
              total_impressions::text, total_likes::text
       FROM geo.ctrip_account_analytics_snapshots
       WHERE channel_account_id = $1`,
      [accountId],
    );
    expect(snapshot.rows).toEqual([
      {
        content_heat: "0.00",
        total_impressions: null,
        total_interactions: "2",
        total_likes: null,
      },
    ]);
  });

  it("excludes historical false-zero Ctrip analytics from reporting totals", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const accountId = "30000000-0000-4000-8000-000000009809";
    await adminClient.query(
      `INSERT INTO geo.channel_accounts (
         tenant_id, id, platform, display_name, capability,
         supported_execution_levels, capability_evidence_type,
         capability_evidence_refs, status
       ) VALUES (
         $1, $2, 'ctrip_community', 'False zero analytics account', 'browser_assisted',
         ARRAY['dry_run','assisted','unattended']::text[], 'browser_screenshot',
         '[]'::jsonb, 'active'
       )`,
      [tenantId, accountId],
    );
    await adminClient.query(
      `INSERT INTO geo.ctrip_account_analytics_snapshots (
         tenant_id, channel_account_id, snapshot_hour, report_period,
         publish_count, featured_count, quality_count, featured_quality_rate,
         content_heat, total_views, total_viewers, total_interactions,
         total_interactors, traffic_sources, works, source_hash, observed_at
       ) VALUES (
         $1, $2, date_trunc('hour', clock_timestamp()), '近7天',
         0, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb,
         '[{"title":"平台尚未出数的作品","publishedAt":"2026-08-01 10:00","views":0,"viewers":0,"interactions":0,"interactors":0}]'::jsonb,
         $3, clock_timestamp()
       )`,
      [tenantId, accountId, "b".repeat(64)],
    );

    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-analytics-false-zero-integration",
      maxConnections: 2,
    });
    const factory = await loadVariantRepositoryFactory();
    const repository = factory({ runtimeDatabase: database, identityDatabase: database });
    try {
      const dashboard = await repository.getCtripAccountAnalytics({
        actorId,
        tenantId,
        requestId: "analytics-false-zero-integration",
      });
      const account = dashboard.accounts.find((item) => item.channelAccountId === accountId);
      expect(account).toMatchObject({
        dataStatus: "pending",
        publishCount: null,
        totalViews: null,
      });
      const readyAccounts = dashboard.accounts.filter((item) => item.dataStatus === "ready");
      expect(dashboard.reportingAccountCount).toBe(readyAccounts.length);
      expect(dashboard.totals).toMatchObject({
        publishCount: readyAccounts.reduce((total, item) => total + (item.publishCount ?? 0), 0),
        views: readyAccounts.reduce((total, item) => total + (item.totalViews ?? 0), 0),
      });
      await repository.deleteChannelAccount(
        {
          actorId,
          tenantId,
          requestId: "analytics-archived-ctrip-integration",
        },
        accountId,
      );
      expect(
        (
          await repository.getCtripAccountAnalytics({
            actorId,
            tenantId,
            requestId: "analytics-archived-ctrip-readback",
          })
        ).accounts.some((item) => item.channelAccountId === accountId),
      ).toBe(false);
    } finally {
      await database.destroy();
    }
  });

  it("reassigns only pending unclaimed automation targets and records the change", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const campaignId = "30000000-0000-4000-8000-000000009810";
    const batchId = "30000000-0000-4000-8000-000000009811";
    const runId = "30000000-0000-4000-8000-000000009812";
    const targetId = "30000000-0000-4000-8000-000000009813";
    const firstAccountId = "30000000-0000-4000-8000-000000009814";
    const secondAccountId = "30000000-0000-4000-8000-000000009815";

    for (const [accountId, displayName] of [
      [firstAccountId, "Pending assignment account one"],
      [secondAccountId, "Pending assignment account two"],
    ] as const) {
      await adminClient.query(
        `INSERT INTO geo.channel_accounts (
           tenant_id, id, platform, display_name, capability,
           supported_execution_levels, capability_evidence_type,
           capability_evidence_refs, status
         ) VALUES (
           $1, $2, 'ctrip_community', $3, 'browser_assisted',
           ARRAY['dry_run']::text[], 'preview', '[]'::jsonb, 'active'
         )`,
        [tenantId, accountId, displayName],
      );
    }

    await adminClient.query(
      `INSERT INTO geo.campaigns
         (tenant_id, id, brand_id, name, objective, industry, status, topic_key)
       VALUES ($1, $2, $3, 'Pending assignment campaign',
               'Verify pre-claim account assignment', 'travel', 'active', 'assignment')`,
      [tenantId, campaignId, SEED_IDS.sampleTravel.brand],
    );
    await adminClient.query(
      `INSERT INTO geo.automation_batches
         (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
          execution_level, scheduled_for, configuration, created_by_actor_id)
       VALUES ($1, $2, $3, 'pending-assignment-batch', $4, 'scheduled',
               'dry_run', clock_timestamp(), '{}'::jsonb, $5)`,
      [tenantId, batchId, campaignId, "c".repeat(64), actorId],
    );
    await adminClient.query(
      `INSERT INTO geo.automation_runs
         (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
          idempotency_key, request_hash, state, stage, available_at)
       VALUES ($1, $2, $3, $4, 'assignment-slot', 'assignment',
               '{"text":"pending assignment"}'::jsonb,
               'pending-assignment-run', $5, 'scheduled', 'planning', clock_timestamp())`,
      [tenantId, runId, batchId, campaignId, "d".repeat(64)],
    );
    await adminClient.query(
      `INSERT INTO geo.automation_run_targets
         (tenant_id, id, run_id, channel_account_id, platform, state,
          variant_idempotency_key, audit_idempotency_key, publication_idempotency_key)
       VALUES ($1, $2, $3, $4, 'ctrip_community', 'pending',
               'pending-assignment-variant', 'pending-assignment-audit',
               'pending-assignment-publication')`,
      [tenantId, targetId, runId, firstAccountId],
    );

    const changed = await runtimeTransaction((client) =>
      client.query<{ channel_account_id: string; was_changed: boolean }>(
        "SELECT * FROM geo.reassign_pending_automation_target($1, $2, $3)",
        [runId, targetId, secondAccountId],
      ),
    );
    expect(changed.rows).toEqual([{ channel_account_id: secondAccountId, was_changed: true }]);
    const persisted = await adminClient.query<{ channel_account_id: string; audit_count: number }>(
      `SELECT target.channel_account_id,
              count(audit.id)::integer AS audit_count
       FROM geo.automation_run_targets AS target
       LEFT JOIN geo.audit_log AS audit
         ON audit.tenant_id = target.tenant_id
        AND audit.resource_id = target.id
        AND audit.action = 'automation_target.assignment_changed'
       WHERE target.tenant_id = $1 AND target.id = $2
       GROUP BY target.channel_account_id`,
      [tenantId, targetId],
    );
    expect(persisted.rows).toEqual([{ channel_account_id: secondAccountId, audit_count: 1 }]);

    const archivedCandidateId = "30000000-0000-4000-8000-000000009816";
    await adminClient.query(
      `INSERT INTO geo.channel_accounts (
         tenant_id, id, platform, display_name, capability,
         supported_execution_levels, capability_evidence_type,
         capability_evidence_refs, status
       ) VALUES (
         $1, $2, 'ctrip_community', 'Pending assignment archived candidate',
         'browser_assisted', ARRAY['dry_run']::text[], 'preview', '[]'::jsonb, 'active'
       )`,
      [tenantId, archivedCandidateId],
    );
    if (postgresPort === undefined) {
      throw new Error("PostgreSQL test port is not initialized");
    }
    const archiveClient = new Client({
      user: "postgres",
      password,
      port: postgresPort,
      host: "127.0.0.1",
      database: databaseName,
    });
    await archiveClient.connect();
    try {
      await archiveClient.query("BEGIN");
      await archiveClient.query(
        `UPDATE geo.channel_accounts
         SET status = 'disabled', archived_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, archivedCandidateId],
      );

      const reassignment = isolatedRuntimeTransaction(async (client) => {
        await client.query("SET application_name = 'geo-archive-reassignment-race'");
        return client.query("SELECT * FROM geo.reassign_pending_automation_target($1, $2, $3)", [
          runId,
          targetId,
          archivedCandidateId,
        ]);
      });
      const reassignmentOutcome = reassignment.then(
        () => null,
        (error: unknown) => error,
      );
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await adminClient.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE application_name = 'geo-archive-reassignment-race'
             AND query LIKE 'SELECT * FROM geo.reassign_pending_automation_target%'
           LIMIT 1`,
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          observedLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true);
      await archiveClient.query("COMMIT");
      expect(await reassignmentOutcome).toMatchObject({ code: "P0002" });
    } finally {
      await archiveClient.query("ROLLBACK").catch(() => undefined);
      await archiveClient.end();
    }

    const afterArchivedReassignment = await adminClient.query<{ channel_account_id: string }>(
      `SELECT channel_account_id
       FROM geo.automation_run_targets
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, targetId],
    );
    expect(afterArchivedReassignment.rows).toEqual([{ channel_account_id: secondAccountId }]);
    await expect(
      adminClient.query(
        `UPDATE geo.channel_accounts
         SET status = 'active'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, archivedCandidateId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.claim_automation_runs('assignment-worker', 1, 60)"),
    );
    await expect(
      runtimeTransaction((client) =>
        client.query("SELECT * FROM geo.reassign_pending_automation_target($1, $2, $3)", [
          runId,
          targetId,
          firstAccountId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("binds historical Ctrip identity offline with admin-only idempotent audit evidence", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-historical-publication-integration",
      maxConnections: 2,
    });
    const historicalEditorId = "30000000-0000-4000-8000-000000000117";
    const historicalEditorMembershipId = "30000000-0000-4000-8000-000000000118";
    const externalId = "340555001";
    const title = "历史携程内容绑定验证";
    const body =
      "这是从离线证据中恢复的历史公开正文，仅用于验证租户范围内的重复内容审计，不代表一次新的在线发布。";
    const manifest = {
      schemaVersion: "geo.historical-publication-binding.v1",
      tenantId,
      actorId,
      channelAccountId: SEED_IDS.sampleTravel.ctrip,
      platform: "ctrip_community",
      idempotencyKey: "history:ctrip:340555001:v1",
      externalId,
      externalUrl: `https://m.ctrip.com/webapp/you/community/detail?articleId=${externalId}`,
      title,
      body,
      publicContentHash: ctripPublicContentHash(title, body),
      publishedAt: "2026-07-19T02:00:00.000Z",
      observedAt: "2026-07-20T02:00:00.000Z",
      evidence: {
        sha256: "9".repeat(64),
        reference: "offline-capture:historical-publication-integration",
      },
    } as const;

    try {
      await adminClient.query(
        `INSERT INTO geo.users (id, email, password_hash, display_name)
         VALUES ($1, 'historical-editor@integration.test', 'unused-password-hash', 'History editor')`,
        [historicalEditorId],
      );
      await adminClient.query(
        `INSERT INTO geo.tenant_memberships
           (tenant_id, id, user_id, role, capabilities, status)
         VALUES ($1, $2, $3, 'editor', '[]'::jsonb, 'active')`,
        [tenantId, historicalEditorMembershipId, historicalEditorId],
      );

      const first = await bindHistoricalPublication(database, manifest);
      const replay = await bindHistoricalPublication(database, manifest);
      expect(first.wasCreated).toBe(true);
      expect(replay).toEqual({ ...first, wasCreated: false });

      const protectedHistoryTitle = "Protected historical Ctrip publication";
      const protectedHistoryBody =
        "This offline historical record is the duplicate-content baseline and must not be republished.";
      const protectedHistory = await bindHistoricalPublication(database, {
        ...manifest,
        idempotencyKey: "history:ctrip:123450005:v1",
        externalId: "123450005",
        externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450005",
        title: protectedHistoryTitle,
        body: protectedHistoryBody,
        publicContentHash: ctripPublicContentHash(protectedHistoryTitle, protectedHistoryBody),
        evidence: {
          sha256: "8".repeat(64),
          reference: "offline-capture:protected-history-123450005",
        },
      });
      expect(protectedHistory).toMatchObject({
        channelAccountId: SEED_IDS.sampleTravel.ctrip,
        externalId: "123450005",
        wasCreated: true,
      });

      const stored = await adminClient.query<{
        audit_log_id: string;
        bound_by_actor_id: string;
        external_id: string;
        normalized_body: string;
        public_content_hash: string;
        request_hash: string;
      }>(
        `SELECT audit_log_id, bound_by_actor_id, external_id, normalized_body,
                public_content_hash, request_hash
         FROM geo.historical_publications
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, first.historicalPublicationId],
      );
      expect(stored.rows[0]).toMatchObject({
        audit_log_id: first.auditLogId,
        bound_by_actor_id: actorId,
        external_id: externalId,
        normalized_body: body,
        public_content_hash: manifest.publicContentHash,
        request_hash: first.requestHash,
      });
      const audit = await adminClient.query<{
        action: string;
        after_hash: string;
        details: { publicContentHash?: string; sourceEvidenceHash?: string };
      }>(
        `SELECT action, after_hash, details
         FROM geo.audit_log WHERE tenant_id = $1 AND id = $2`,
        [tenantId, first.auditLogId],
      );
      expect(audit.rows[0]).toMatchObject({
        action: "historical_publication.bound",
        after_hash: first.requestHash,
        details: {
          publicContentHash: manifest.publicContentHash,
          sourceEvidenceHash: manifest.evidence.sha256,
        },
      });

      const auditCampaignId = "30000000-0000-4000-8000-000000000119";
      const auditContentItemId = "30000000-0000-4000-8000-000000000120";
      const auditContentVersionId = "30000000-0000-4000-8000-000000000121";
      const auditVariantId = "30000000-0000-4000-8000-000000000122";
      const auditPayload = {
        title: "Fresh audit candidate",
        summary: "Fresh candidate summary",
        bodyMarkdown:
          "## Fresh section\n\nA distinct candidate body used to prove imported history reaches duplicate audit.",
        media: [],
        claims: [],
        contactIds: [],
        tags: ["fresh"],
      };
      const auditPayloadHash = sha256Canonical(auditPayload);
      await runtimeTransaction(async (client) => {
        await client.query(
          `INSERT INTO geo.campaigns
             (tenant_id, id, brand_id, name, objective, industry, topic_key)
           VALUES ($1, $2, $3, 'Historical import audit context',
                   'Prove authoritative imported history', 'travel', 'historical-import-audit')`,
          [tenantId, auditCampaignId, SEED_IDS.sampleTravel.brand],
        );
        await client.query(
          `INSERT INTO geo.content_items
             (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
           VALUES ($1, $2, $3, $4, 'Historical import audit source', 'evidence', 'draft',
                   'historical-import-audit')`,
          [tenantId, auditContentItemId, auditCampaignId, SEED_IDS.sampleTravel.brand],
        );
        await client.query(
          `INSERT INTO geo.content_versions
             (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
              payload_hash, created_by_actor_id)
           VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7, $8)`,
          [
            tenantId,
            auditContentVersionId,
            auditContentItemId,
            auditPayload.summary,
            auditPayload.bodyMarkdown,
            JSON.stringify(auditPayload),
            auditPayloadHash,
            actorId,
          ],
        );
        await client.query(
          `INSERT INTO geo.publication_variants
             (tenant_id, id, content_version_id, channel_account_id, platform,
              variant_version, payload, payload_hash, state)
           VALUES ($1, $2, $3, $4, 'toutiao', 1, $5::jsonb, $6, 'draft')`,
          [
            tenantId,
            auditVariantId,
            auditContentVersionId,
            SEED_IDS.sampleTravel.toutiao,
            JSON.stringify(auditPayload),
            auditPayloadHash,
          ],
        );
      });
      const createRepository = await loadVariantRepositoryFactory();
      const repository = createRepository({
        runtimeDatabase: database,
        identityDatabase: database,
      });
      const auditContext = await repository.loadAuditContext(
        { tenantId, actorId, requestId: "historical-import-audit-context" },
        auditVariantId,
        new Date().toISOString(),
      );
      expect(
        auditContext?.priorVariants.find(
          (variant) => variant.variantId === first.historicalPublicationId,
        ),
      ).toMatchObject({
        platform: "ctrip_community",
        payloadHash: manifest.publicContentHash,
        publicContentHash: manifest.publicContentHash,
        bodyMarkdown: body,
      });

      await expect(
        bindHistoricalPublication(database, {
          ...manifest,
          evidence: { ...manifest.evidence, reference: "offline-capture:changed" },
        }),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        bindHistoricalPublication(database, {
          ...manifest,
          idempotencyKey: "history:ctrip:340555001:conflict",
        }),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        bindHistoricalPublication(database, {
          ...manifest,
          actorId: historicalEditorId,
          externalId: "123450003",
          externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450003",
          idempotencyKey: "history:ctrip:123450003:v1",
        }),
      ).rejects.toMatchObject({ code: "42501" });

      const tenantVisible = await runtimeTransaction((client) =>
        client.query<{ id: string }>("SELECT id FROM geo.historical_publications WHERE id = $1", [
          first.historicalPublicationId,
        ]),
      );
      expect(tenantVisible.rows).toEqual([{ id: first.historicalPublicationId }]);
      const crossTenantVisible = await runtimeTransaction(
        (client) =>
          client.query<{ id: string }>("SELECT id FROM geo.historical_publications WHERE id = $1", [
            first.historicalPublicationId,
          ]),
        { tenant: syntheticTenantId, actor: SEED_IDS.synthetic.actor },
      );
      expect(crossTenantVisible.rows).toEqual([]);
      await expect(
        runtimeTransaction((client) =>
          client.query("INSERT INTO geo.historical_publications (tenant_id) VALUES ($1)", [
            tenantId,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        adminClient.query(
          "UPDATE geo.historical_publications SET source_reference = 'tampered' WHERE id = $1",
          [first.historicalPublicationId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await database.destroy();
    }
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
      "40000000-0000-4000-8000-000000000014",
      "40000000-0000-4000-8000-000000000015",
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
          workerServicePrincipalId: "40000000-0000-4000-8000-000000000011",
          policyBundleId: "40000000-0000-4000-8000-000000000012",
          querySetId: "40000000-0000-4000-8000-000000000013",
          querySetVersionId: "40000000-0000-4000-8000-000000000014",
          brandAgentProfileId: "40000000-0000-4000-8000-000000000015",
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
        safe_accounts: "5",
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
        "50000000-0000-4000-8000-000000000007",
        "50000000-0000-4000-8000-000000000008",
        "50000000-0000-4000-8000-000000000009",
        "50000000-0000-4000-8000-000000000010",
        "50000000-0000-4000-8000-000000000011",
        "50000000-0000-4000-8000-000000000012",
        SEED_IDS.sampleTravel.brandAgentProfile,
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

  it("commissions and rotates a credential-less Ctrip bridge with durable handoff authority", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const commissioningAdminClient = adminClient;
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-ctrip-bridge-commissioning-integration",
      maxConnections: 4,
    });
    const bridgeIds = {
      extraAccount: "60000000-0000-4000-8000-000000000001",
      ownerUser: "60000000-0000-4000-8000-000000000002",
      ownerMembership: "60000000-0000-4000-8000-000000000003",
      adminUser: "60000000-0000-4000-8000-000000000004",
      adminMembership: "60000000-0000-4000-8000-000000000005",
      editorUser: "60000000-0000-4000-8000-000000000006",
      editorMembership: "60000000-0000-4000-8000-000000000007",
      inactiveUser: "60000000-0000-4000-8000-000000000008",
      inactiveMembership: "60000000-0000-4000-8000-000000000009",
      unmanagedAdminUser: "60000000-0000-4000-8000-000000000010",
      unmanagedAdminMembership: "60000000-0000-4000-8000-000000000011",
      firstPrincipal: "60000000-0000-4000-8000-000000000012",
      firstReceipt: "60000000-0000-4000-8000-000000000013",
      firstCommissioningAudit: "60000000-0000-4000-8000-000000000014",
      conflictingPrincipal: "60000000-0000-4000-8000-000000000015",
      apiKey: "60000000-0000-4000-8000-000000000016",
      campaign: "60000000-0000-4000-8000-000000000017",
      contentItem: "60000000-0000-4000-8000-000000000018",
      contentVersion: "60000000-0000-4000-8000-000000000019",
      variant: "60000000-0000-4000-8000-000000000020",
      auditRun: "60000000-0000-4000-8000-000000000021",
      auditArtifact: "60000000-0000-4000-8000-000000000022",
      grant: "60000000-0000-4000-8000-000000000023",
      firstJob: "60000000-0000-4000-8000-000000000024",
      firstAttempt: "60000000-0000-4000-8000-000000000025",
      firstHandoff: "60000000-0000-4000-8000-000000000026",
      secondPrincipal: "60000000-0000-4000-8000-000000000027",
      secondReceipt: "60000000-0000-4000-8000-000000000028",
      secondCommissioningAudit: "60000000-0000-4000-8000-000000000029",
      secondJob: "60000000-0000-4000-8000-000000000030",
      secondAttempt: "60000000-0000-4000-8000-000000000031",
      secondHandoff: "60000000-0000-4000-8000-000000000032",
    } as const;
    const tenantSlug = "ctrip-bridge-integration";
    const ownerEmail = "ctrip-bridge-owner@integration.test";
    const adminEmail = "ctrip-bridge-admin@integration.test";
    const editorEmail = "ctrip-bridge-editor@integration.test";
    const inactiveEmail = "ctrip-bridge-inactive@integration.test";
    const unmanagedAdminEmail = "ctrip-bridge-unmanaged-admin@integration.test";
    const firstInput = {
      tenantSlug,
      operatorEmail: ownerEmail,
      idempotencyKey: "ctrip-bridge-owner-commissioning-v1",
      principalName: "ctrip-bridge-production-v1",
    } as const;

    try {
      const provisioned = await provisionTenant(database, {
        idempotencyKey: "ticket-ctrip-bridge-integration-v1",
        tenantSlug,
        legalName: "Ctrip Bridge Integration Ltd.",
        displayName: "Ctrip Bridge Integration",
        industry: "travel",
        defaultLocale: "zh-CN",
        brandCanonicalName: "Ctrip Bridge Integration",
        brandDisplayName: "Ctrip Bridge Integration",
        contacts: [],
        workerName: "ctrip-bridge-integration-worker",
      });
      const commissioningTenantId = provisioned.tenantId;
      const ctripAccount = await adminClient.query<{ id: string }>(
        `SELECT id FROM geo.channel_accounts
         WHERE tenant_id = $1 AND platform = 'ctrip_community' AND status = 'active'`,
        [commissioningTenantId],
      );
      const ctripAccountId = ctripAccount.rows[0]?.id;
      if (ctripAccountId === undefined || ctripAccount.rowCount !== 1) {
        throw new Error("Provisioned commissioning tenant has no unique active Ctrip account");
      }

      for (const [userId, membershipId, email, displayName, userStatus, role, capabilities] of [
        [
          bridgeIds.ownerUser,
          bridgeIds.ownerMembership,
          ownerEmail,
          "Ctrip bridge owner",
          "active",
          "owner",
          ["principal:manage", "publish:request"],
        ],
        [
          bridgeIds.adminUser,
          bridgeIds.adminMembership,
          adminEmail,
          "Ctrip bridge admin",
          "active",
          "admin",
          ["principal:manage", "publish:request"],
        ],
        [
          bridgeIds.editorUser,
          bridgeIds.editorMembership,
          editorEmail,
          "Ctrip bridge editor",
          "active",
          "editor",
          ["principal:manage"],
        ],
        [
          bridgeIds.inactiveUser,
          bridgeIds.inactiveMembership,
          inactiveEmail,
          "Inactive Ctrip bridge admin",
          "disabled",
          "admin",
          ["principal:manage"],
        ],
        [
          bridgeIds.unmanagedAdminUser,
          bridgeIds.unmanagedAdminMembership,
          unmanagedAdminEmail,
          "Unmanaged Ctrip bridge admin",
          "active",
          "admin",
          ["tenant:read"],
        ],
      ] as const) {
        await commissioningAdminClient.query(
          `INSERT INTO geo.users (id, email, password_hash, display_name, status)
           VALUES ($1, $2, 'unused-password-hash', $3, $4)`,
          [userId, email, displayName, userStatus],
        );
        await commissioningAdminClient.query(
          `INSERT INTO geo.tenant_memberships
             (tenant_id, id, user_id, role, capabilities, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'active')`,
          [commissioningTenantId, membershipId, userId, role, JSON.stringify(capabilities)],
        );
      }

      await adminClient.query(
        `UPDATE geo.channel_accounts SET status = 'disabled'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, ctripAccountId],
      );
      await expect(
        commissionCtripBridge(database, {
          ...firstInput,
          idempotencyKey: "ctrip-bridge-zero-account-v1",
        }),
      ).rejects.toBeInstanceOf(CtripBridgeCommissioningConflictError);
      await adminClient.query(
        `UPDATE geo.channel_accounts SET status = 'active'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, ctripAccountId],
      );

      await adminClient.query(
        `INSERT INTO geo.channel_accounts
           (tenant_id, id, platform, display_name, capability, supported_execution_levels,
            credential_ref, capability_evidence_type, capability_evidence_refs, status)
         VALUES ($1, $2, 'ctrip_community', 'Ctrip commissioning ambiguity probe',
                 'manual_only', ARRAY['dry_run']::text[], NULL, 'manual_import',
                 '["test:commissioning-ambiguity"]'::jsonb, 'active')`,
        [commissioningTenantId, bridgeIds.extraAccount],
      );
      await expect(
        commissionCtripBridge(database, {
          ...firstInput,
          idempotencyKey: "ctrip-bridge-multiple-accounts-v1",
        }),
      ).rejects.toBeInstanceOf(CtripBridgeCommissioningConflictError);
      await adminClient.query(
        `UPDATE geo.channel_accounts SET status = 'disabled'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, bridgeIds.extraAccount],
      );

      for (const [operatorEmail, idempotencyKey] of [
        [editorEmail, "ctrip-bridge-editor-rejected-v1"],
        [inactiveEmail, "ctrip-bridge-inactive-rejected-v1"],
        [unmanagedAdminEmail, "ctrip-bridge-unmanaged-admin-rejected-v1"],
      ] as const) {
        await expect(
          commissionCtripBridge(database, { ...firstInput, operatorEmail, idempotencyKey }),
        ).rejects.toBeInstanceOf(CtripBridgeCommissioningConflictError);
      }

      const firstCommissioningIds = [
        bridgeIds.firstPrincipal,
        bridgeIds.firstReceipt,
        bridgeIds.firstCommissioningAudit,
      ];
      const firstIdGenerator = () => {
        const value = firstCommissioningIds.shift();
        if (value === undefined) throw new Error("First commissioning exhausted its IDs");
        return value;
      };
      const concurrent = await Promise.all([
        commissionCtripBridge(database, firstInput, { idGenerator: firstIdGenerator }),
        commissionCtripBridge(database, firstInput, { idGenerator: firstIdGenerator }),
      ]);
      expect(concurrent.map((result) => result.wasCreated).sort()).toEqual([false, true]);
      for (const result of concurrent) {
        expect(result).toMatchObject({
          tenantId: commissioningTenantId,
          ctripChannelAccountId: ctripAccountId,
          bridgeServicePrincipalId: bridgeIds.firstPrincipal,
        });
        expect(Object.keys(result).sort()).toEqual([
          "bridgeServicePrincipalId",
          "ctripChannelAccountId",
          "tenantId",
          "wasCreated",
        ]);
      }
      const replay = await commissionCtripBridge(database, firstInput);
      expect(replay).toEqual({
        tenantId: commissioningTenantId,
        ctripChannelAccountId: ctripAccountId,
        bridgeServicePrincipalId: bridgeIds.firstPrincipal,
        wasCreated: false,
      });
      await expect(
        commissionCtripBridge(database, {
          ...firstInput,
          principalName: "ctrip-bridge-drifted-request",
        }),
      ).rejects.toBeInstanceOf(CtripBridgeCommissioningConflictError);

      const persisted = await adminClient.query<{
        audit_actor_id: string;
        audit_action: string;
        audit_details: {
          credentialIssued?: boolean;
          ctripChannelAccountId?: string;
          receiptId?: string;
        };
        audit_log_id: string;
        audit_request_id: string;
        bridge_service_principal_id: string;
        capabilities: string[];
        credential_count: string;
        kind: string;
        operator_user_id: string;
        profile: string;
        receipt_id: string;
        request_hash: string;
        status: string;
      }>(
        `SELECT receipt.id AS receipt_id, receipt.request_hash, receipt.operator_user_id,
                receipt.bridge_service_principal_id, receipt.audit_log_id,
                principal.kind, principal.profile, principal.capabilities, principal.status,
                audit.actor_id AS audit_actor_id, audit.action AS audit_action,
                audit.request_id AS audit_request_id, audit.details AS audit_details,
                count(api_key.id)::text AS credential_count
         FROM geo.ctrip_bridge_commissioning_receipts AS receipt
         JOIN geo.service_principals AS principal
           ON principal.tenant_id = receipt.tenant_id
          AND principal.id = receipt.bridge_service_principal_id
         JOIN geo.audit_log AS audit
           ON audit.tenant_id = receipt.tenant_id AND audit.id = receipt.audit_log_id
         LEFT JOIN geo.api_keys AS api_key
           ON api_key.tenant_id = principal.tenant_id
          AND api_key.service_principal_id = principal.id
         WHERE receipt.tenant_id = $1 AND receipt.id = $2
         GROUP BY receipt.id, principal.id, audit.id`,
        [commissioningTenantId, bridgeIds.firstReceipt],
      );
      expect(persisted.rows[0]).toMatchObject({
        receipt_id: bridgeIds.firstReceipt,
        operator_user_id: bridgeIds.ownerUser,
        bridge_service_principal_id: bridgeIds.firstPrincipal,
        audit_log_id: bridgeIds.firstCommissioningAudit,
        kind: "integration",
        profile: "ctrip_bridge",
        capabilities: ["tenant:read", "content:read", "publish:bridge"],
        status: "active",
        audit_actor_id: bridgeIds.ownerUser,
        audit_action: "ctrip_bridge.commissioned",
        audit_request_id: firstInput.idempotencyKey,
        audit_details: {
          credentialIssued: false,
          ctripChannelAccountId: ctripAccountId,
          receiptId: bridgeIds.firstReceipt,
        },
        credential_count: "0",
      });
      expect(persisted.rows[0]?.request_hash).toHaveLength(64);

      await expect(
        commissioningAdminClient.query(
          `UPDATE geo.ctrip_bridge_commissioning_receipts
           SET principal_name = 'tampered' WHERE id = $1`,
          [bridgeIds.firstReceipt],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query("DELETE FROM geo.ctrip_bridge_commissioning_receipts WHERE id = $1", [
          bridgeIds.firstReceipt,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        adminClient.query(
          `INSERT INTO geo.service_principals
             (tenant_id, id, name, kind, profile, capabilities, status)
           VALUES ($1, $2, 'second-active-bridge', 'integration', 'ctrip_bridge',
                   '["tenant:read","content:read","publish:bridge"]'::jsonb, 'active')`,
          [commissioningTenantId, bridgeIds.conflictingPrincipal],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        adminClient.query(
          `INSERT INTO geo.api_keys
             (tenant_id, id, service_principal_id, key_prefix, secret_hash)
           VALUES ($1, $2, $3, 'commissioned-bridge-key', $4)`,
          [commissioningTenantId, bridgeIds.apiKey, bridgeIds.firstPrincipal, "1".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      const commissioningPayloadHash = "2".repeat(64);
      const commissioningAuditHash = "3".repeat(64);
      await adminClient.query("BEGIN");
      try {
        await commissioningAdminClient.query(
          `UPDATE geo.channel_accounts
           SET capability = 'browser_assisted',
               supported_execution_levels = ARRAY['dry_run', 'assisted']::text[],
               capability_evidence_type = 'browser_screenshot',
               capability_evidence_refs = '["test:commissioned-bridge"]'::jsonb,
               status = 'active', last_verified_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [commissioningTenantId, ctripAccountId],
        );
        await commissioningAdminClient.query(
          `UPDATE geo.automation_controls
           SET mode = 'supervised', kill_switch_enabled = false
           WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
          [commissioningTenantId],
        );
        await adminClient.query(
          `INSERT INTO geo.campaigns
             (tenant_id, id, brand_id, name, objective, industry, topic_key)
           VALUES ($1, $2, $3, 'Commissioned bridge handoff',
                   'Prove commissioned handoff authority', 'travel',
                   'commissioned-bridge-handoff')`,
          [commissioningTenantId, bridgeIds.campaign, provisioned.brandId],
        );
        await adminClient.query(
          `INSERT INTO geo.content_items
             (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
           VALUES ($1, $2, $3, $4, 'Commissioned bridge article', 'evidence', 'audited',
                   'commissioned-bridge-handoff')`,
          [commissioningTenantId, bridgeIds.contentItem, bridgeIds.campaign, provisioned.brandId],
        );
        await adminClient.query(
          `INSERT INTO geo.content_versions
             (tenant_id, id, content_item_id, version, summary, body_markdown,
              payload, payload_hash, created_by_actor_id, frozen_at)
           VALUES ($1, $2, $3, 1, 'Commissioned bridge summary',
                   '# Commissioned bridge article', '{}'::jsonb, $4, $5,
                   clock_timestamp())`,
          [
            commissioningTenantId,
            bridgeIds.contentVersion,
            bridgeIds.contentItem,
            commissioningPayloadHash,
            bridgeIds.ownerUser,
          ],
        );
        await adminClient.query(
          `INSERT INTO geo.publication_variants
             (tenant_id, id, content_version_id, channel_account_id, platform,
              variant_version, payload, payload_hash, state, frozen_at)
           VALUES ($1, $2, $3, $4, 'ctrip_community', 1, '{}'::jsonb, $5,
                   'frozen', clock_timestamp())`,
          [
            commissioningTenantId,
            bridgeIds.variant,
            bridgeIds.contentVersion,
            ctripAccountId,
            commissioningPayloadHash,
          ],
        );
        await adminClient.query(
          `INSERT INTO geo.audit_runs
             (tenant_id, id, variant_id, policy_bundle_id, status,
              requested_by_actor_id, completed_at)
           VALUES ($1, $2, $3, $4, 'passed', $5, clock_timestamp())`,
          [
            commissioningTenantId,
            bridgeIds.auditRun,
            bridgeIds.variant,
            provisioned.policyBundleId,
            bridgeIds.ownerUser,
          ],
        );
        await adminClient.query(
          `INSERT INTO geo.audit_artifacts
             (tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
              payload_hash, fact_snapshot_hash, policy_hash, policy_version, audit_hash,
              brand_snapshot_hash, media_snapshot_hash, status, findings, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'ctrip_community', $6, $7, $8,
                   'commissioning-v1', $9, $10, $11, 'passed', '[]'::jsonb,
                   clock_timestamp() + interval '1 hour')`,
          [
            commissioningTenantId,
            bridgeIds.auditArtifact,
            bridgeIds.auditRun,
            bridgeIds.variant,
            ctripAccountId,
            commissioningPayloadHash,
            "4".repeat(64),
            "5".repeat(64),
            commissioningAuditHash,
            "a".repeat(64),
            "b".repeat(64),
          ],
        );
        await adminClient.query(
          `INSERT INTO geo.publication_grants
             (tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
              payload_hash, audit_hash, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'ctrip_community', $6, $7, $8,
                   clock_timestamp() + interval '30 minutes')`,
          [
            commissioningTenantId,
            bridgeIds.grant,
            bridgeIds.auditArtifact,
            bridgeIds.variant,
            ctripAccountId,
            commissioningPayloadHash,
            commissioningAuditHash,
            "6".repeat(64),
          ],
        );
        await adminClient.query(
          `UPDATE geo.publication_grants
           SET status = 'consumed', consumed_at = clock_timestamp(), consumed_by_actor_id = $3
           WHERE tenant_id = $1 AND id = $2`,
          [commissioningTenantId, bridgeIds.grant, bridgeIds.ownerUser],
        );
        await adminClient.query("COMMIT");
      } catch (error) {
        await adminClient.query("ROLLBACK");
        throw error;
      }

      const insertJob = async (jobId: string, attemptId: string, suffix: string) => {
        const jobRequestHash = suffix === "first" ? "7".repeat(64) : "8".repeat(64);
        await commissioningAdminClient.query(
          `INSERT INTO geo.publication_jobs
             (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
              platform, execution_level, state, idempotency_key, request_hash, payload_hash,
              scheduled_for, lease_owner, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ctrip_community', 'assisted', 'dispatching',
                   $7, $8, $9, clock_timestamp(), 'commissioned-bridge-worker',
                   clock_timestamp() + interval '30 minutes')`,
          [
            commissioningTenantId,
            jobId,
            bridgeIds.grant,
            bridgeIds.auditArtifact,
            bridgeIds.variant,
            ctripAccountId,
            `commissioned-bridge-job-${suffix}`,
            jobRequestHash,
            commissioningPayloadHash,
          ],
        );
        await commissioningAdminClient.query(
          `INSERT INTO geo.publication_attempts
             (tenant_id, id, job_id, attempt_no, state, worker_id, request_hash)
           VALUES ($1, $2, $3, 1, 'started', 'commissioned-bridge-worker', $4)`,
          [commissioningTenantId, attemptId, jobId, jobRequestHash],
        );
      };
      const insertRawHandoff = (input: {
        accountId: string;
        attemptId: string;
        handoffId: string;
        idempotencyKey: string;
        jobId: string;
        principalId: string;
      }) =>
        commissioningAdminClient.query(
          `INSERT INTO geo.publication_assisted_handoffs
             (tenant_id, id, job_id, attempt_id, bridge_service_principal_id,
              channel_account_id, variant_id, platform, state, payload_hash, audit_hash,
              preview_hash, adapter_version, idempotency_key, expires_at,
              created_by_actor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ctrip_community', 'handoff_pending',
                   $8, $9, $10, 'commissioned-bridge-adapter-v1', $11,
                   clock_timestamp() + interval '30 minutes', $12)`,
          [
            commissioningTenantId,
            input.handoffId,
            input.jobId,
            input.attemptId,
            input.principalId,
            input.accountId,
            bridgeIds.variant,
            commissioningPayloadHash,
            commissioningAuditHash,
            "9".repeat(64),
            input.idempotencyKey,
            bridgeIds.ownerUser,
          ],
        );

      await insertJob(bridgeIds.firstJob, bridgeIds.firstAttempt, "first");
      const publicationBlockReason = async (): Promise<string | null> => {
        const result = await runtimeTransaction(
          (client) =>
            client.query<{ block_reason: string | null }>(
              "SELECT geo.publication_assisted_block_reason($1) AS block_reason",
              [bridgeIds.firstJob],
            ),
          { tenant: commissioningTenantId, actor: bridgeIds.ownerUser },
        );
        return result.rows[0]?.block_reason ?? null;
      };

      expect(await publicationBlockReason()).toBe("ctrip_protected_history_baseline_missing");

      const unrelatedHistoryTitle = "Unrelated historical Ctrip baseline probe";
      const unrelatedHistoryBody =
        "Binding another historical external ID must not unlock the protected publication gate.";
      await bindHistoricalPublication(database, {
        schemaVersion: "geo.historical-publication-binding.v1",
        tenantId: commissioningTenantId,
        actorId: bridgeIds.ownerUser,
        channelAccountId: ctripAccountId,
        platform: "ctrip_community",
        idempotencyKey: "commissioning-unrelated-history-123450004-v1",
        externalId: "123450004",
        externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450004",
        title: unrelatedHistoryTitle,
        body: unrelatedHistoryBody,
        publicContentHash: ctripPublicContentHash(unrelatedHistoryTitle, unrelatedHistoryBody),
        publishedAt: "2026-07-19T00:00:00.000Z",
        observedAt: "2026-07-22T00:00:00.000Z",
        evidence: {
          sha256: "d".repeat(64),
          reference: "offline-capture:commissioning-unrelated-history",
        },
      });
      expect(await publicationBlockReason()).toBe("ctrip_protected_history_baseline_missing");

      const protectedHistoryTitle = "Protected historical Ctrip baseline";
      const protectedHistoryBody =
        "This article is bound from offline evidence only and must never be republished.";
      await bindHistoricalPublication(database, {
        schemaVersion: "geo.historical-publication-binding.v1",
        tenantId: commissioningTenantId,
        actorId: bridgeIds.ownerUser,
        channelAccountId: ctripAccountId,
        platform: "ctrip_community",
        idempotencyKey: "commissioning-protected-history-123450005-v1",
        externalId: "123450005",
        externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450005",
        title: protectedHistoryTitle,
        body: protectedHistoryBody,
        publicContentHash: ctripPublicContentHash(protectedHistoryTitle, protectedHistoryBody),
        publishedAt: "2026-07-20T00:00:00.000Z",
        observedAt: "2026-07-22T00:00:00.000Z",
        evidence: {
          sha256: "c".repeat(64),
          reference: "offline-capture:commissioning-protected-history",
        },
      });

      await adminClient.query("BEGIN");
      let baselineState:
        | {
            bound_account: boolean;
            cross_tenant_account: boolean;
            missing_account: boolean;
            non_ctrip_account: boolean;
            sibling_account: boolean;
          }
        | undefined;
      try {
        await adminClient.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
          [commissioningTenantId, bridgeIds.ownerUser],
        );
        const baselineResult = await adminClient.query<{
          bound_account: boolean;
          cross_tenant_account: boolean;
          missing_account: boolean;
          non_ctrip_account: boolean;
          sibling_account: boolean;
        }>(
          `SELECT geo.ctrip_protected_history_baseline_bound($1) AS bound_account,
                  geo.ctrip_protected_history_baseline_bound($2) AS sibling_account,
                  geo.ctrip_protected_history_baseline_bound($3) AS cross_tenant_account,
                  geo.ctrip_protected_history_baseline_bound(
                    (SELECT account.id
                     FROM geo.channel_accounts AS account
                     WHERE account.tenant_id = $4
                       AND account.platform = 'toutiao'
                     LIMIT 1)
                  ) AS non_ctrip_account,
                  geo.ctrip_protected_history_baseline_bound($5) AS missing_account`,
          [
            ctripAccountId,
            bridgeIds.extraAccount,
            SEED_IDS.sampleTravel.ctrip,
            commissioningTenantId,
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
          ],
        );
        baselineState = baselineResult.rows[0];
      } finally {
        await adminClient.query("ROLLBACK");
      }
      expect(baselineState).toEqual({
        bound_account: true,
        sibling_account: true,
        cross_tenant_account: false,
        non_ctrip_account: false,
        missing_account: false,
      });
      await expect(
        runtimeTransaction((client) =>
          client.query("SELECT geo.ctrip_protected_history_baseline_bound($1)", [ctripAccountId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await publicationBlockReason()).toBeNull();

      const firstRawHandoff = {
        accountId: ctripAccountId,
        attemptId: bridgeIds.firstAttempt,
        handoffId: bridgeIds.firstHandoff,
        idempotencyKey: "commissioned-bridge-handoff-first",
        jobId: bridgeIds.firstJob,
        principalId: bridgeIds.firstPrincipal,
      };
      await expect(
        insertRawHandoff({ ...firstRawHandoff, accountId: bridgeIds.extraAccount }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        insertRawHandoff({
          ...firstRawHandoff,
          principalId: provisioned.workerServicePrincipalId,
        }),
      ).rejects.toMatchObject({ code: "42501" });

      await adminClient.query(
        `UPDATE geo.service_principals SET name = 'ctrip-bridge-principal-drift'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, bridgeIds.firstPrincipal],
      );
      await expect(insertRawHandoff(firstRawHandoff)).rejects.toMatchObject({ code: "42501" });
      await expect(commissionCtripBridge(database, firstInput)).rejects.toBeInstanceOf(
        CtripBridgeCommissioningConflictError,
      );
      await adminClient.query(
        `UPDATE geo.service_principals SET name = $3
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, bridgeIds.firstPrincipal, firstInput.principalName],
      );

      await adminClient.query(
        `UPDATE geo.channel_accounts SET status = 'disabled'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, ctripAccountId],
      );
      await expect(insertRawHandoff(firstRawHandoff)).rejects.toMatchObject({ code: "42501" });
      await adminClient.query(
        `UPDATE geo.channel_accounts SET status = 'active'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, ctripAccountId],
      );

      const firstHandoff = await runtimeTransaction(
        (client) =>
          client.query<{ publication_assisted_handoff_id: string; was_created: boolean }>(
            `SELECT * FROM geo.create_publication_assisted_handoff(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::geo.sha256_hex, $6, $7,
               clock_timestamp() + interval '30 minutes'
             )`,
            [
              bridgeIds.firstHandoff,
              bridgeIds.firstJob,
              bridgeIds.firstAttempt,
              bridgeIds.firstPrincipal,
              "9".repeat(64),
              "commissioned-bridge-adapter-v1",
              firstRawHandoff.idempotencyKey,
            ],
          ),
        { tenant: commissioningTenantId, actor: bridgeIds.ownerUser },
      );
      expect(firstHandoff.rows[0]).toEqual({
        publication_assisted_handoff_id: bridgeIds.firstHandoff,
        was_created: true,
      });
      const firstHandoffMapping = await adminClient.query<{
        bridge_service_principal_id: string;
        channel_account_id: string;
      }>(
        `SELECT bridge_service_principal_id, channel_account_id
         FROM geo.publication_assisted_handoffs WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, bridgeIds.firstHandoff],
      );
      expect(firstHandoffMapping.rows[0]).toEqual({
        bridge_service_principal_id: bridgeIds.firstPrincipal,
        channel_account_id: ctripAccountId,
      });

      await adminClient.query(
        `UPDATE geo.service_principals SET status = 'disabled'
         WHERE tenant_id = $1 AND id = $2`,
        [commissioningTenantId, bridgeIds.firstPrincipal],
      );
      const rotationInput = {
        tenantSlug,
        operatorEmail: adminEmail,
        idempotencyKey: "ctrip-bridge-admin-rotation-v2",
        principalName: "ctrip-bridge-production-v2",
      } as const;
      const rotationIds = [
        bridgeIds.secondPrincipal,
        bridgeIds.secondReceipt,
        bridgeIds.secondCommissioningAudit,
      ];
      const rotated = await commissionCtripBridge(database, rotationInput, {
        idGenerator: () => {
          const value = rotationIds.shift();
          if (value === undefined) throw new Error("Ctrip bridge rotation exhausted its IDs");
          return value;
        },
      });
      expect(rotated).toEqual({
        tenantId: commissioningTenantId,
        ctripChannelAccountId: ctripAccountId,
        bridgeServicePrincipalId: bridgeIds.secondPrincipal,
        wasCreated: true,
      });
      expect(await commissionCtripBridge(database, rotationInput)).toEqual({
        ...rotated,
        wasCreated: false,
      });

      const rotatedState = await adminClient.query<{
        actor_id: string;
        audit_log_id: string;
        principal_id: string;
        principal_status: string;
        receipt_id: string;
      }>(
        `SELECT receipt.id AS receipt_id,
                receipt.bridge_service_principal_id AS principal_id,
                receipt.audit_log_id, principal.status AS principal_status,
                audit.actor_id
         FROM geo.ctrip_bridge_commissioning_receipts AS receipt
         JOIN geo.service_principals AS principal
           ON principal.tenant_id = receipt.tenant_id
          AND principal.id = receipt.bridge_service_principal_id
         JOIN geo.audit_log AS audit
           ON audit.tenant_id = receipt.tenant_id AND audit.id = receipt.audit_log_id
         WHERE receipt.tenant_id = $1
         ORDER BY receipt.created_at, receipt.id`,
        [commissioningTenantId],
      );
      expect(rotatedState.rows).toEqual([
        {
          receipt_id: bridgeIds.firstReceipt,
          principal_id: bridgeIds.firstPrincipal,
          audit_log_id: bridgeIds.firstCommissioningAudit,
          principal_status: "disabled",
          actor_id: bridgeIds.ownerUser,
        },
        {
          receipt_id: bridgeIds.secondReceipt,
          principal_id: bridgeIds.secondPrincipal,
          audit_log_id: bridgeIds.secondCommissioningAudit,
          principal_status: "active",
          actor_id: bridgeIds.adminUser,
        },
      ]);

      await insertJob(bridgeIds.secondJob, bridgeIds.secondAttempt, "second");
      const secondRawHandoff = {
        accountId: ctripAccountId,
        attemptId: bridgeIds.secondAttempt,
        handoffId: bridgeIds.secondHandoff,
        idempotencyKey: "commissioned-bridge-handoff-second",
        jobId: bridgeIds.secondJob,
        principalId: bridgeIds.secondPrincipal,
      };
      await expect(
        insertRawHandoff({ ...secondRawHandoff, principalId: bridgeIds.firstPrincipal }),
      ).rejects.toMatchObject({ code: "42501" });
      const secondHandoff = await runtimeTransaction(
        (client) =>
          client.query<{ publication_assisted_handoff_id: string; was_created: boolean }>(
            `SELECT * FROM geo.create_publication_assisted_handoff(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::geo.sha256_hex, $6, $7,
               clock_timestamp() + interval '30 minutes'
             )`,
            [
              bridgeIds.secondHandoff,
              bridgeIds.secondJob,
              bridgeIds.secondAttempt,
              bridgeIds.secondPrincipal,
              "a".repeat(64),
              "commissioned-bridge-adapter-v2",
              secondRawHandoff.idempotencyKey,
            ],
          ),
        { tenant: commissioningTenantId, actor: bridgeIds.adminUser },
      );
      expect(secondHandoff.rows[0]).toEqual({
        publication_assisted_handoff_id: bridgeIds.secondHandoff,
        was_created: true,
      });
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
        [tenantId, ids.automationCampaign, SEED_IDS.sampleTravel.brand],
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
            SEED_IDS.sampleTravel.toutiao,
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
        [tenantId, ids.automationPendingTarget, ids.automationRunA, SEED_IDS.sampleTravel.sohu],
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
      [tenantId, ids.automationContentItem, ids.automationCampaign, SEED_IDS.sampleTravel.brand],
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
      `INSERT INTO geo.content_items
         (tenant_id, id, campaign_id, brand_id, title, content_type, topic_key)
       VALUES ($1, $2, $3, $4, 'Remediated automation draft', 'guide',
               'automation-topic-a-remediated')`,
      [
        tenantId,
        ids.automationRemediatedContentItem,
        ids.automationCampaign,
        SEED_IDS.sampleTravel.brand,
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.content_versions
         (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
          payload_hash, created_by_actor_id, frozen_at)
       VALUES ($1, $2, $3, 1, 'Remediated summary', '# Remediated body', '{}'::jsonb,
               $4, $5, clock_timestamp())`,
      [
        tenantId,
        ids.automationRemediatedContentVersion,
        ids.automationRemediatedContentItem,
        "d".repeat(64),
        actorId,
      ],
    );
    const mediaCheckpoint = await runtimeTransaction((client) =>
      client.query<AutomationCheckpointRow>(
        `SELECT * FROM geo.checkpoint_automation_draft(
           $1, $2, $3, $4, $5, $6::jsonb, 60
         )`,
        [
          ids.automationRunA,
          "automation-worker-a",
          1,
          ids.automationRemediatedContentItem,
          ids.automationRemediatedContentVersion,
          JSON.stringify({ stage: "media", mediaComplete: true }),
        ],
      ),
    );
    expect(mediaCheckpoint.rows[0]).toMatchObject({ accepted: true, reason: "accepted" });

    await adminClient.query(
      `INSERT INTO geo.campaigns
         (tenant_id, id, brand_id, name, objective, industry, status, topic_key)
       VALUES ($1, $2, $3, 'Foreign automation campaign',
               'Prove media checkpoint campaign isolation', 'travel', 'active',
               'automation-foreign')`,
      [tenantId, ids.automationForeignCampaign, SEED_IDS.sampleTravel.brand],
    );
    await adminClient.query(
      `INSERT INTO geo.content_items
         (tenant_id, id, campaign_id, brand_id, title, content_type, topic_key)
       VALUES ($1, $2, $3, $4, 'Foreign automation draft', 'guide',
               'automation-foreign-topic')`,
      [
        tenantId,
        ids.automationForeignContentItem,
        ids.automationForeignCampaign,
        SEED_IDS.sampleTravel.brand,
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.content_versions
         (tenant_id, id, content_item_id, version, summary, body_markdown, payload,
          payload_hash, created_by_actor_id, frozen_at)
       VALUES ($1, $2, $3, 1, 'Foreign summary', '# Foreign body', '{}'::jsonb,
               $4, $5, clock_timestamp())`,
      [
        tenantId,
        ids.automationForeignContentVersion,
        ids.automationForeignContentItem,
        "e".repeat(64),
        actorId,
      ],
    );
    await expect(
      runtimeTransaction((client) =>
        client.query(
          `SELECT * FROM geo.checkpoint_automation_draft(
             $1, $2, $3, $4, $5, $6::jsonb, 60
           )`,
          [
            ids.automationRunA,
            "automation-worker-a",
            1,
            ids.automationForeignContentItem,
            ids.automationForeignContentVersion,
            JSON.stringify({ stage: "media", mediaComplete: true }),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await adminClient.query(
      `INSERT INTO geo.publication_variants
         (tenant_id, id, content_version_id, channel_account_id, platform,
          variant_version, payload, payload_hash, state, frozen_at)
       VALUES ($1, $2, $3, $4, 'toutiao', 1, '{}'::jsonb, $5,
               'frozen', clock_timestamp())`,
      [
        tenantId,
        ids.automationVariant,
        ids.automationRemediatedContentVersion,
        SEED_IDS.sampleTravel.toutiao,
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
      [
        tenantId,
        ids.automationAuditRun,
        ids.automationVariant,
        SEED_IDS.sampleTravel.policy,
        actorId,
      ],
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
        SEED_IDS.sampleTravel.toutiao,
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
        "8".repeat(64),
        "9".repeat(64),
        "a".repeat(64),
      ],
    );

    const manualReviewCheckpoint = await runtimeTransaction(
      (client) =>
        client.query<AutomationCheckpointRow>(
          `SELECT * FROM geo.checkpoint_automation_target(
             $1, $2, $3, $4, 'awaiting_manual_review', NULL::uuid,
             $5, $6, NULL::uuid, NULL::text, NULL::text,
             $7::jsonb, 60
           )`,
          [
            ids.automationRunA,
            ids.automationTargetA,
            "automation-worker-a",
            1,
            ids.automationAuditRun,
            ids.automationAuditArtifact,
            JSON.stringify({ target: "awaiting_manual_review" }),
          ],
        ),
      { commit: false },
    );
    expect(manualReviewCheckpoint.rows[0]).toMatchObject({
      accepted: true,
      reason: "accepted",
    });

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
        [
          tenantId,
          ids.automationLeaseTarget,
          ids.automationLeaseRun,
          SEED_IDS.sampleTravel.toutiao,
        ],
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
           attempt_count = max_attempts,
           available_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationDeliveryRun],
    );
    const deliveryRecovery = await runtimeTransaction((client) =>
      client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
        "delivery-recovery-worker",
      ]),
    );
    expect(deliveryRecovery.rowCount).toBe(0);
    const waitingDelivery = await adminClient.query<{
      attempt_count: number;
      last_error_code: string | null;
      state: string;
    }>(
      `SELECT state, attempt_count, last_error_code
       FROM geo.automation_runs
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.automationDeliveryRun],
    );
    expect(waitingDelivery.rows[0]).toEqual({
      state: "awaiting_delivery",
      attempt_count: 5,
      last_error_code: null,
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
         VALUES ($1, $2, $3, 'automation-resource-wait-batch', $4,
                 clock_timestamp(), '{}'::jsonb, $5)`,
        [
          tenantId,
          ids.automationResourceWaitBatch,
          ids.automationCampaign,
          "c".repeat(64),
          actorId,
        ],
      );
      await client.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash, max_attempts, available_at)
         VALUES ($1, $2, $3, $4, 'resource-wait-slot', 'automation-resource-wait',
                 '{}'::jsonb, 'automation-resource-wait-run', $5, 1,
                 clock_timestamp())`,
        [
          tenantId,
          ids.automationResourceWaitRun,
          ids.automationResourceWaitBatch,
          ids.automationCampaign,
          "d".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key,
            publication_idempotency_key)
         VALUES ($1, $2, $3, $4, 'toutiao',
                 'automation-resource-wait-variant',
                 'automation-resource-wait-audit',
                 'automation-resource-wait-publication')`,
        [
          tenantId,
          ids.automationResourceWaitTarget,
          ids.automationResourceWaitRun,
          SEED_IDS.sampleTravel.toutiao,
        ],
      );
    });

    for (const waitCount of [1, 2]) {
      const conflictLease = await runtimeTransaction((client) =>
        client.query<AutomationClaimRow>("SELECT * FROM geo.claim_automation_runs($1, 1, 60)", [
          `resource-wait-worker-${waitCount}`,
        ]),
      );
      expect(conflictLease.rows[0]).toMatchObject({
        id: ids.automationResourceWaitRun,
        attempt_count: 1,
      });
      await runtimeTransaction((client) =>
        client.query(
          `SELECT * FROM geo.reconcile_automation_run(
             $1, $2, 1, 0, 'RESOURCE_CONFLICT', 'account writer is busy'
           )`,
          [ids.automationResourceWaitRun, `resource-wait-worker-${waitCount}`],
        ),
      );
      const waiting = await adminClient.query<{
        attempt_count: number;
        resource_wait_count: number;
        state: string;
        available_in_future: boolean;
      }>(
        `SELECT state, attempt_count, resource_wait_count,
                available_at > clock_timestamp() AS available_in_future
         FROM geo.automation_runs
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationResourceWaitRun],
      );
      expect(waiting.rows[0]).toEqual({
        state: "retry_wait",
        attempt_count: 0,
        resource_wait_count: waitCount,
        available_in_future: true,
      });
      if (waitCount === 1) {
        await adminClient.query(
          `UPDATE geo.automation_runs
           SET available_at = clock_timestamp() - interval '1 second'
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, ids.automationResourceWaitRun],
        );
      }
    }
    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.cancel_automation_batch($1, $2)", [
        ids.automationResourceWaitBatch,
        "resource wait retry verified",
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

  it("persists and leases 5,000 platform targets exactly once across concurrent workers", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }

    const capacityTargetCount = 5_000;
    const capacityCampaignId = "51000000-0000-4000-8000-000000000001";
    const capacityBatchId = "51000000-0000-4000-8000-000000000002";
    const claimLimit = 100;
    const workerClients = Array.from(
      { length: 8 },
      (_, index) =>
        new Client({
          user: "postgres",
          password,
          port: postgresPort,
          host: "127.0.0.1",
          database: databaseName,
          application_name: `automation-capacity-worker-${index + 1}`,
        }),
    );
    let capacityDataCreated = false;

    try {
      await runtimeTransaction(async (client) => {
        await client.query(
          `INSERT INTO geo.campaigns
             (tenant_id, id, brand_id, name, objective, industry, status, topic_key)
           VALUES ($1, $2, $3, 'Automation capacity campaign',
                   'Prove 5,000 durable platform targets', 'travel', 'active',
                   'automation-capacity-5000')`,
          [tenantId, capacityCampaignId, SEED_IDS.sampleTravel.brand],
        );
        await client.query(
          `INSERT INTO geo.automation_batches
             (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
              execution_level, scheduled_for, configuration, created_by_actor_id)
           VALUES ($1, $2, $3, 'automation-capacity-5000-batch', $4, 'scheduled',
                   'dry_run', clock_timestamp() - interval '1 minute',
                   '{"name":"capacity-5000"}'::jsonb, $5)`,
          [tenantId, capacityBatchId, capacityCampaignId, "5".repeat(64), actorId],
        );
        await client.query(
          `INSERT INTO geo.automation_runs
             (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
              idempotency_key, request_hash, available_at)
           SELECT $1::uuid,
                  ('51000001-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
                  $2::uuid, $3::uuid,
                  'capacity-slot-' || item,
                  'capacity-topic-' || item,
                  jsonb_build_object('text', 'capacity brief ' || item),
                  'automation-capacity-5000-run-' || item,
                  $4::geo.sha256_hex,
                  clock_timestamp() - interval '1 minute'
           FROM generate_series(1, $5::integer) AS generated(item)`,
          [tenantId, capacityBatchId, capacityCampaignId, "6".repeat(64), capacityTargetCount],
        );
        await client.query(
          `INSERT INTO geo.automation_run_targets
             (tenant_id, id, run_id, channel_account_id, platform, state,
              variant_idempotency_key, audit_idempotency_key,
              publication_idempotency_key)
           SELECT $1::uuid,
                  ('51000002-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
                  ('51000001-0000-4000-8000-' || lpad(item::text, 12, '0'))::uuid,
                  CASE (item - 1) % 5
                    WHEN 0 THEN $2::uuid
                    WHEN 1 THEN $3::uuid
                    WHEN 2 THEN $4::uuid
                    WHEN 3 THEN $5::uuid
                    ELSE $6::uuid
                  END,
                  CASE (item - 1) % 5
                    WHEN 0 THEN 'toutiao'
                    WHEN 1 THEN 'sohu'
                    WHEN 2 THEN 'baijiahao'
                    WHEN 3 THEN 'netease'
                    ELSE 'ctrip_community'
                  END,
                  'pending',
                  'automation-capacity-5000-variant-' || item,
                  'automation-capacity-5000-audit-' || item,
                  'automation-capacity-5000-publication-' || item
           FROM generate_series(1, $7::integer) AS generated(item)`,
          [
            tenantId,
            SEED_IDS.sampleTravel.toutiao,
            SEED_IDS.sampleTravel.sohu,
            SEED_IDS.sampleTravel.baijiahao,
            SEED_IDS.sampleTravel.netease,
            SEED_IDS.sampleTravel.ctrip,
            capacityTargetCount,
          ],
        );
      });
      capacityDataCreated = true;

      const persisted = await adminClient.query<{
        all_targets_pending: boolean;
        distinct_run_count: number;
        distinct_target_count: number;
        platform_count: number;
        target_count: number;
      }>(
        `SELECT count(*)::integer AS target_count,
                count(DISTINCT run.id)::integer AS distinct_run_count,
                count(DISTINCT target.id)::integer AS distinct_target_count,
                count(DISTINCT target.platform)::integer AS platform_count,
                bool_and(target.state = 'pending') AS all_targets_pending
         FROM geo.automation_runs AS run
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE run.tenant_id = $1 AND run.batch_id = $2`,
        [tenantId, capacityBatchId],
      );
      expect(persisted.rows[0]).toEqual({
        target_count: capacityTargetCount,
        distinct_run_count: capacityTargetCount,
        distinct_target_count: capacityTargetCount,
        platform_count: 5,
        all_targets_pending: true,
      });
      const persistedPlatforms = await adminClient.query<{
        platform: string;
        target_count: number;
      }>(
        `SELECT target.platform, count(*)::integer AS target_count
         FROM geo.automation_runs AS run
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE run.tenant_id = $1 AND run.batch_id = $2
         GROUP BY target.platform
         ORDER BY target.platform`,
        [tenantId, capacityBatchId],
      );
      expect(persistedPlatforms.rows).toEqual([
        { platform: "baijiahao", target_count: 1_000 },
        { platform: "ctrip_community", target_count: 1_000 },
        { platform: "netease", target_count: 1_000 },
        { platform: "sohu", target_count: 1_000 },
        { platform: "toutiao", target_count: 1_000 },
      ]);

      await Promise.all(workerClients.map((client) => client.connect()));
      const claimsByWorker = await Promise.all(
        workerClients.map(async (client, index) => {
          const workerId = `automation-capacity-worker-${index + 1}`;
          const claims: Array<{
            batch_id: string;
            run_id: string;
            target_id: string | null;
          }> = [];
          for (let claimIndex = 0; ; claimIndex += 1) {
            await client.query("BEGIN");
            try {
              await client.query("SET LOCAL ROLE geo_runtime");
              await client.query(
                "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
                [tenantId, actorId, `${workerId}-claim-${claimIndex}`],
              );
              const claimed = await client.query<{
                batch_id: string;
                run_id: string;
                target_id: string | null;
              }>(
                `WITH claimed AS (
                   SELECT * FROM geo.claim_automation_runs($1, $2, 3600)
                 )
                 SELECT claimed.batch_id, claimed.id AS run_id, target.id AS target_id
                 FROM claimed
                 LEFT JOIN geo.automation_run_targets AS target
                   ON target.tenant_id = claimed.tenant_id AND target.run_id = claimed.id
                 ORDER BY claimed.id, target.id`,
                [workerId, claimLimit],
              );
              await client.query("COMMIT");
              if (claimed.rows.length === 0) break;
              claims.push(...claimed.rows);
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          }
          return claims;
        }),
      );

      const capacityClaims = claimsByWorker
        .flat()
        .filter((claim) => claim.batch_id === capacityBatchId);
      const claimedRunIds = new Set(capacityClaims.map((claim) => claim.run_id));
      const claimedTargetIds = new Set(
        capacityClaims.flatMap((claim) => (claim.target_id === null ? [] : [claim.target_id])),
      );
      expect(capacityClaims).toHaveLength(capacityTargetCount);
      expect(claimedRunIds.size).toBe(capacityTargetCount);
      expect(claimedTargetIds.size).toBe(capacityTargetCount);
      expect(
        claimsByWorker.filter((claims) =>
          claims.some((claim) => claim.batch_id === capacityBatchId),
        ).length,
      ).toBeGreaterThan(1);

      const leased = await adminClient.query<{
        attempt_count_max: number;
        attempt_count_min: number;
        running_count: number;
        run_count: number;
        worker_count: number;
      }>(
        `SELECT count(*)::integer AS run_count,
                count(*) FILTER (WHERE state = 'running')::integer AS running_count,
                count(DISTINCT lease_owner)::integer AS worker_count,
                min(attempt_count)::integer AS attempt_count_min,
                max(attempt_count)::integer AS attempt_count_max
         FROM geo.automation_runs
         WHERE tenant_id = $1 AND batch_id = $2`,
        [tenantId, capacityBatchId],
      );
      expect(leased.rows[0]).toMatchObject({
        run_count: capacityTargetCount,
        running_count: capacityTargetCount,
        attempt_count_min: 1,
        attempt_count_max: 1,
      });
      expect(leased.rows[0]?.worker_count).toBeGreaterThan(1);
    } finally {
      await Promise.allSettled(
        workerClients.map(async (client) => {
          await client.query("ROLLBACK");
          await client.end();
        }),
      );
      if (capacityDataCreated) {
        await adminClient.query(
          `DELETE FROM geo.automation_run_targets AS target
           USING geo.automation_runs AS run
           WHERE target.tenant_id = run.tenant_id
             AND target.run_id = run.id
             AND run.tenant_id = $1
             AND run.batch_id = $2`,
          [tenantId, capacityBatchId],
        );
        await adminClient.query(
          "DELETE FROM geo.automation_runs WHERE tenant_id = $1 AND batch_id = $2",
          [tenantId, capacityBatchId],
        );
        await adminClient.query(
          "DELETE FROM geo.automation_batches WHERE tenant_id = $1 AND id = $2",
          [tenantId, capacityBatchId],
        );
        await adminClient.query("DELETE FROM geo.campaigns WHERE tenant_id = $1 AND id = $2", [
          tenantId,
          capacityCampaignId,
        ]);
      }
    }
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
      commissioning_receipts_hidden: boolean;
      dispatcher_function: boolean;
      dispatcher_has_no_tables: boolean;
      identity_function_allowlist: boolean;
      identity_has_no_tables: boolean;
      roles_hardened: boolean;
      runtime_append_only: boolean;
      runtime_canary_succeeded_function: boolean;
      runtime_function: boolean;
      runtime_member_module_functions: boolean;
      runtime_release_phase_function: boolean;
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
        not exists (
          select 1
          from unnest(ARRAY['geo_runtime', 'geo_dispatcher', 'geo_identity']) as role_name(value)
          cross join unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege_name(value)
          where has_table_privilege(
            role_name.value,
            'geo.ctrip_bridge_commissioning_receipts',
            privilege_name.value
          )
        ) as commissioning_receipts_hidden,
        has_function_privilege(
          'geo_runtime',
          'geo.consume_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamptz)',
          'EXECUTE'
        ) as runtime_function,
        has_function_privilege(
          'geo_runtime', 'geo.ctrip_phase_b_canary_succeeded(uuid)', 'EXECUTE'
        ) as runtime_canary_succeeded_function,
        has_function_privilege(
          'geo_runtime', 'geo.ctrip_release_phase(uuid)', 'EXECUTE'
        ) as runtime_release_phase_function,
        has_function_privilege(
          'geo_runtime', 'geo.reopen_publication_assisted_readback(uuid)', 'EXECUTE'
        ) as runtime_reopen_readback_function,
        has_function_privilege(
          'geo_runtime', 'geo.expire_priority_platform_readback_windows()', 'EXECUTE'
        ) as runtime_expire_readback_window_function,
        has_function_privilege(
          'geo_runtime',
          'geo.force_calibrate_channel_account_runtime(uuid,timestamptz)',
          'EXECUTE'
        ) as runtime_force_calibrate_function,
        has_function_privilege(
          'geo_runtime',
          'geo.purge_abandoned_channel_account_automation_targets(uuid)',
          'EXECUTE'
        ) as runtime_purge_abandoned_targets_function,
        has_function_privilege(
          'geo_runtime', 'geo.member_modules_valid(jsonb)', 'EXECUTE'
        ) and has_function_privilege(
          'geo_runtime', 'geo.update_tenant_member_modules(uuid,jsonb)', 'EXECUTE'
        ) as runtime_member_module_functions,
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
      commissioning_receipts_hidden: true,
      dispatcher_function: true,
      dispatcher_has_no_tables: true,
      identity_function_allowlist: true,
      identity_has_no_tables: true,
      roles_hardened: true,
      runtime_append_only: true,
      runtime_canary_succeeded_function: true,
      runtime_expire_readback_window_function: true,
      runtime_force_calibrate_function: true,
      runtime_function: true,
      runtime_member_module_functions: true,
      runtime_purge_abandoned_targets_function: true,
      runtime_reopen_readback_function: true,
      runtime_release_phase_function: true,
      runtime_readback_update: true,
      runtime_receipts_hidden: true,
      runtime_tables: true,
    });
  });

  it("keeps an operator calibration ready through a transient negative runtime probe", async () => {
    const accountId = SEED_IDS.sampleTravel.ctrip;
    const observedAt = new Date().toISOString();

    await runtimeTransaction((client) =>
      client.query(
        `SELECT geo.force_calibrate_channel_account_runtime($1::uuid, $2::timestamptz)`,
        [accountId, observedAt],
      ),
    );
    await runtimeTransaction((client) =>
      client.query(
        `UPDATE geo.ctrip_account_runtime_bindings
         SET manual_ready_until = clock_timestamp() + interval '10 minutes'
         WHERE tenant_id = $1 AND channel_account_id = $2`,
        [tenantId, accountId],
      ),
    );

    const negativeProbe = await runtimeTransaction((client) =>
      client.query<{ session_state: string; manual_ready_until: string | null }>(
        `UPDATE geo.ctrip_account_runtime_bindings
         SET session_state = 'session_required',
             last_checked_at = clock_timestamp(),
             last_error_code = 'CTRIP_SESSION_REQUIRED'
         WHERE tenant_id = $1 AND channel_account_id = $2
         RETURNING session_state, manual_ready_until`,
        [tenantId, accountId],
      ),
    );

    expect(negativeProbe.rows[0]?.session_state).toBe("ready");
    expect(negativeProbe.rows[0]?.manual_ready_until).not.toBeNull();

    const authenticatedProbe = await runtimeTransaction((client) =>
      client.query<{ session_state: string; manual_ready_until: string | null }>(
        `UPDATE geo.ctrip_account_runtime_bindings
         SET session_state = 'authenticated',
             last_checked_at = clock_timestamp(),
             last_error_code = NULL,
             last_error_message = NULL
         WHERE tenant_id = $1 AND channel_account_id = $2
         RETURNING session_state, manual_ready_until`,
        [tenantId, accountId],
      ),
    );

    expect(authenticatedProbe.rows[0]?.session_state).toBe("authenticated");
    expect(authenticatedProbe.rows[0]?.manual_ready_until).not.toBeNull();

    await runtimeTransaction((client) =>
      client.query(
        `UPDATE geo.ctrip_account_runtime_bindings
         SET manual_ready_until = NULL, session_state = 'ready'
         WHERE tenant_id = $1 AND channel_account_id = $2`,
        [tenantId, accountId],
      ),
    );
  });

  it("forces geo_runtime RLS for reads and cross-tenant writes", async () => {
    const ownContacts = await runtimeTransaction(
      async (client) =>
        client.query<{ value: string }>("SELECT value FROM geo.tenant_contacts ORDER BY value"),
      { commit: false },
    );
    expect(ownContacts.rows.map((row) => row.value)).toEqual([
      "4000000001",
      "TRAVEL_DEMO_01",
      "TRAVEL_DEMO_02",
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
          [SEED_IDS.sampleTravel.hotline],
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
          SEED_IDS.sampleTravel.hotline,
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
        SEED_IDS.sampleTravel.brand,
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
          [tenantId, ids.idempotentCampaign, SEED_IDS.sampleTravel.brand],
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
        brandId: SEED_IDS.sampleTravel.brand,
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
        [tenantId, ids.variantConcurrencyCampaign, SEED_IDS.sampleTravel.brand],
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
          SEED_IDS.sampleTravel.brand,
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
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
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
          SEED_IDS.sampleTravel.toutiao,
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

      const supersededAt = "2026-07-25T03:15:00.000Z";
      const superseded = await repository.supersedeVariant(
        { tenantId, actorId, requestId: "variant-supersede-integration" },
        {
          variantId: variants[0]?.id ?? "",
          reason: "The sibling platform draft is not selected for this release",
          supersededAt,
        },
      );
      expect(superseded).toMatchObject({
        id: variants[0]?.id,
        state: "superseded",
        frozenAt: supersededAt,
        payloadHash: variantPayloadHash,
      });
      const supersedeAudit = await adminClient.query<{
        before_hash: string;
        after_hash: string;
        details: { reason?: string; previousState?: string; targetState?: string };
      }>(
        `SELECT before_hash, after_hash, details
         FROM geo.audit_log
         WHERE tenant_id = $1 AND action = 'publication_variant.superseded'
           AND resource_id = $2`,
        [tenantId, variants[0]?.id],
      );
      expect(supersedeAudit.rows[0]).toMatchObject({
        details: {
          reason: "The sibling platform draft is not selected for this release",
          previousState: "draft",
          targetState: "superseded",
        },
      });
      expect(supersedeAudit.rows[0]?.before_hash).toHaveLength(64);
      expect(supersedeAudit.rows[0]?.after_hash).toHaveLength(64);
      expect(supersedeAudit.rows[0]?.before_hash).not.toBe(supersedeAudit.rows[0]?.after_hash);

      const replacement = await repository.createVariant(
        { tenantId, actorId, requestId: "variant-after-supersede" },
        { ...commonInput, variantId: ids.variantSupersedeReplacement },
      );
      expect(replacement).toMatchObject({
        id: ids.variantSupersedeReplacement,
        variantVersion: 2,
        payloadHash: variantPayloadHash,
      });
      await runtimeTransaction((client) =>
        client.query(
          `INSERT INTO geo.audit_runs
             (tenant_id, id, variant_id, policy_bundle_id, status,
              requested_by_actor_id, started_at)
           VALUES ($1, $2, $3, $4, 'running', $5, $6)`,
          [
            tenantId,
            ids.variantSupersedeAuditRun,
            replacement.id,
            SEED_IDS.sampleTravel.policy,
            actorId,
            supersededAt,
          ],
        ),
      );
      await expect(
        repository.supersedeVariant(
          { tenantId, actorId, requestId: "variant-supersede-blocked" },
          {
            variantId: replacement.id,
            reason: "Must not supersede a variant with downstream history",
            supersededAt: "2026-07-25T03:16:00.000Z",
          },
        ),
      ).rejects.toThrow(/audit, automation, handoff, or publication history/iu);
    } finally {
      await database.destroy();
    }
  });

  it("derives priority-platform jobs and handoffs from the audited grant lineage", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }

    const genericIds = {
      campaign: "52000000-0000-4000-8000-000000000001",
      contentItem: "52000000-0000-4000-8000-000000000002",
      contentVersion: "52000000-0000-4000-8000-000000000003",
      variant: "52000000-0000-4000-8000-000000000004",
      auditRun: "52000000-0000-4000-8000-000000000005",
      auditArtifact: "52000000-0000-4000-8000-000000000006",
      grant: "52000000-0000-4000-8000-000000000007",
      bridgePrincipal: "52000000-0000-4000-8000-000000000008",
      attempt: "52000000-0000-4000-8000-000000000009",
      handoff: "52000000-0000-4000-8000-000000000010",
      automationBatch: "52000000-0000-4000-8000-000000000011",
      automationRun: "52000000-0000-4000-8000-000000000012",
      automationTarget: "52000000-0000-4000-8000-000000000013",
    } as const;
    const genericPayloadHash = "1f".repeat(32);
    const genericFactHash = "2f".repeat(32);
    const genericPolicyHash = "3f".repeat(32);
    const genericAuditHash = "4f".repeat(32);
    const genericBrandHash = "5f".repeat(32);
    const genericMediaHash = "6f".repeat(32);
    const genericTokenHash = "7f".repeat(32);
    const genericRequestHash = "8f".repeat(32);
    const genericPreviewHash = "9f".repeat(32);
    const genericSessionEvidenceHash = "af".repeat(32);
    const genericDraftEvidenceHash = "bf".repeat(32);
    const genericPrepareEvidenceHash = "cf".repeat(32);
    const genericPublicContentHash = "df".repeat(32);
    const genericSubmitEvidenceHash = "ef".repeat(32);
    const genericReadbackEvidenceHash = "0f".repeat(32);

    await adminClient.query("BEGIN");
    try {
      await adminClient.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)",
        [tenantId, actorId, "generic-browser-handoff-integration"],
      );
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET capability = 'browser_assisted',
             supported_execution_levels = ARRAY['dry_run', 'assisted', 'unattended']::text[],
             capability_evidence_type = 'browser_screenshot',
             capability_evidence_refs = '["evidence://toutiao/login-probe"]'::jsonb,
             status = 'active',
             last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'unattended', kill_switch_enabled = false
         WHERE tenant_id = $1
           AND ((scope_type = 'tenant' AND scope_key = '*')
             OR (scope_type = 'platform' AND scope_key = 'toutiao')
             OR (scope_type = 'account' AND scope_key = $2))`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      await adminClient.query(
        `INSERT INTO geo.service_principals
           (tenant_id, id, name, kind, profile, capabilities, status)
         VALUES ($1, $2, 'generic-browser-bridge-integration', 'integration',
                 'ctrip_bridge',
                 '["tenant:read","content:read","publish:bridge"]'::jsonb,
                 'active')`,
        [tenantId, genericIds.bridgePrincipal],
      );
      await adminClient.query(
        `INSERT INTO geo.campaigns
           (tenant_id, id, brand_id, name, objective, industry, topic_key)
         VALUES ($1, $2, $3, 'Generic browser handoff',
                 'Verify server-derived priority platform lineage', 'travel',
                 'generic-browser-handoff')`,
        [tenantId, genericIds.campaign, SEED_IDS.sampleTravel.brand],
      );
      await adminClient.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Toutiao assisted article', 'evidence',
                 'audited', 'generic-browser-handoff')`,
        [tenantId, genericIds.contentItem, genericIds.campaign, SEED_IDS.sampleTravel.brand],
      );
      await adminClient.query(
        `INSERT INTO geo.content_versions
           (tenant_id, id, content_item_id, version, summary, body_markdown,
            payload, payload_hash, created_by_actor_id, frozen_at)
         VALUES ($1, $2, $3, 1, 'Toutiao assisted summary',
                 '# Toutiao assisted article', '{}'::jsonb, $4, $5,
                 clock_timestamp())`,
        [tenantId, genericIds.contentVersion, genericIds.contentItem, genericPayloadHash, actorId],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_variants
           (tenant_id, id, content_version_id, channel_account_id, platform,
            variant_version, payload, payload_hash, state, frozen_at)
         VALUES ($1, $2, $3, $4, 'toutiao', 1, '{}'::jsonb, $5,
                 'frozen', clock_timestamp())`,
        [
          tenantId,
          genericIds.variant,
          genericIds.contentVersion,
          SEED_IDS.sampleTravel.toutiao,
          genericPayloadHash,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.audit_runs
           (tenant_id, id, variant_id, policy_bundle_id, status,
            requested_by_actor_id, completed_at)
         VALUES ($1, $2, $3, $4, 'passed', $5, clock_timestamp())`,
        [tenantId, genericIds.auditRun, genericIds.variant, SEED_IDS.sampleTravel.policy, actorId],
      );
      await adminClient.query(
        `INSERT INTO geo.audit_artifacts
           (tenant_id, id, audit_run_id, variant_id, channel_account_id, platform,
            payload_hash, fact_snapshot_hash, policy_hash, policy_version, audit_hash,
            brand_snapshot_hash, media_snapshot_hash, status, findings, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8, 'travel-v1',
                 $9, $10, $11, 'passed', '[]'::jsonb,
                 clock_timestamp() + interval '20 minutes')`,
        [
          tenantId,
          genericIds.auditArtifact,
          genericIds.auditRun,
          genericIds.variant,
          SEED_IDS.sampleTravel.toutiao,
          genericPayloadHash,
          genericFactHash,
          genericPolicyHash,
          genericAuditHash,
          genericBrandHash,
          genericMediaHash,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_grants
           (tenant_id, id, audit_artifact_id, variant_id, channel_account_id, platform,
            payload_hash, audit_hash, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'toutiao', $6, $7, $8,
                 clock_timestamp() + interval '15 minutes')`,
        [
          tenantId,
          genericIds.grant,
          genericIds.auditArtifact,
          genericIds.variant,
          SEED_IDS.sampleTravel.toutiao,
          genericPayloadHash,
          genericAuditHash,
          genericTokenHash,
        ],
      );

      await adminClient.query("SAVEPOINT cooled_account_circuit_admission");
      await adminClient.query(
        `INSERT INTO geo.circuit_breakers
           (tenant_id, scope_type, scope_key, state, reason, failure_count,
            opened_at, retry_at)
         VALUES ($1, 'account', $2, 'open', NULL, 2,
                 clock_timestamp() - interval '11 minutes',
                 clock_timestamp() - interval '1 minute')
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET state = 'open',
                       reason = NULL,
                       failure_count = 2,
                       opened_at = clock_timestamp() - interval '11 minutes',
                       retry_at = clock_timestamp() - interval '1 minute',
                       probe_attempt_id = NULL,
                       probe_started_at = NULL`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_browser_assisted_publication_grant(
             $1, $2, 'generic-toutiao-null-circuit-reason', $3, 'unattended', NULL
           )`,
          [genericIds.grant, genericTokenHash, genericRequestHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT cooled_account_circuit_admission");

      await adminClient.query("SAVEPOINT nonrecoverable_account_circuit_admission");
      await adminClient.query(
        `INSERT INTO geo.circuit_breakers
           (tenant_id, scope_type, scope_key, state, reason, failure_count,
            opened_at, retry_at)
         VALUES ($1, 'account', $2, 'open', 'DELIVERY_ERROR_BUDGET_EXHAUSTED', 2,
                 clock_timestamp() - interval '11 minutes',
                 clock_timestamp() - interval '1 minute')
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET state = 'open',
                       reason = 'DELIVERY_ERROR_BUDGET_EXHAUSTED',
                       failure_count = 2,
                       opened_at = clock_timestamp() - interval '11 minutes',
                       retry_at = clock_timestamp() - interval '1 minute',
                       probe_attempt_id = NULL,
                       probe_started_at = NULL`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_browser_assisted_publication_grant(
             $1, $2, 'generic-toutiao-nonrecoverable-circuit', $3, 'unattended', NULL
           )`,
          [genericIds.grant, genericTokenHash, genericRequestHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT nonrecoverable_account_circuit_admission");

      await adminClient.query("SAVEPOINT cooled_account_circuit_admission");
      await adminClient.query(
        `INSERT INTO geo.circuit_breakers
           (tenant_id, scope_type, scope_key, state, reason, failure_count,
            opened_at, retry_at)
         VALUES ($1, 'account', $2, 'open', 'ASSISTED_CHALLENGE_REQUIRED', 2,
                 clock_timestamp() - interval '11 minutes',
                 clock_timestamp() - interval '1 minute')
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET state = 'open',
                       reason = 'ASSISTED_CHALLENGE_REQUIRED',
                       failure_count = 2,
                       opened_at = clock_timestamp() - interval '11 minutes',
                       retry_at = clock_timestamp() - interval '1 minute',
                       probe_attempt_id = NULL,
                       probe_started_at = NULL`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      const cooledCircuitAdmission = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_browser_assisted_publication_grant(
           $1, $2, 'generic-toutiao-cooled-account-circuit', $3, 'unattended', NULL
         )`,
        [genericIds.grant, genericTokenHash, genericRequestHash],
      );
      expect(cooledCircuitAdmission.rows[0]?.was_created).toBe(true);
      await adminClient.query("ROLLBACK TO SAVEPOINT cooled_account_circuit_admission");

      await adminClient.query("SAVEPOINT archived_account_job_boundary");
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET status = 'disabled', archived_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.toutiao],
      );
      await expect(
        adminClient.query(
          `INSERT INTO geo.publication_jobs (
             tenant_id, id, grant_id, audit_artifact_id, variant_id,
             channel_account_id, platform, execution_level, state,
             idempotency_key, request_hash, payload_hash, available_at, scheduled_for
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'toutiao', 'assisted', 'queued',
             'archived-account-job-must-reject', $7, $8,
             clock_timestamp(), clock_timestamp()
           )`,
          [
            tenantId,
            "30000000-0000-4000-8000-000000005019",
            genericIds.grant,
            genericIds.auditArtifact,
            genericIds.variant,
            SEED_IDS.sampleTravel.toutiao,
            genericRequestHash,
            genericPayloadHash,
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT archived_account_job_boundary");

      await adminClient.query("SAVEPOINT legacy_ctrip_admission");
      await expect(
        adminClient.query(
          `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, 'legacy-ctrip-must-reject-toutiao', $3, 'assisted', NULL
           )`,
          [genericIds.grant, genericTokenHash, genericRequestHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT legacy_ctrip_admission");

      const admitted = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_browser_assisted_publication_grant(
           $1, $2, 'generic-toutiao-unattended', $3, 'unattended', NULL
         )`,
        [genericIds.grant, genericTokenHash, genericRequestHash],
      );
      expect(admitted.rows[0]?.was_created).toBe(true);
      const genericJobId = admitted.rows[0]?.publication_job_id;
      if (genericJobId === undefined) {
        throw new Error("generic browser admission returned no publication job");
      }

      const replay = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_browser_assisted_publication_grant(
           $1, $2, 'generic-toutiao-unattended', $3, 'unattended', NULL
         )`,
        [genericIds.grant, genericTokenHash, genericRequestHash],
      );
      expect(replay.rows[0]).toMatchObject({
        publication_job_id: genericJobId,
        publication_outbox_event_id: admitted.rows[0]?.publication_outbox_event_id,
        was_created: false,
      });

      const admittedLineage = await adminClient.query<{
        event_platform: string;
        grant_platform: string;
        job_platform: string;
      }>(
        `SELECT job.platform AS job_platform,
                publication_grant.platform AS grant_platform,
                event.payload ->> 'platform' AS event_platform
         FROM geo.publication_jobs AS job
         JOIN geo.publication_grants AS publication_grant
           ON publication_grant.tenant_id = job.tenant_id
          AND publication_grant.id = job.grant_id
         JOIN geo.outbox_events AS event
           ON event.tenant_id = job.tenant_id
          AND event.aggregate_id = job.id
          AND event.topic = 'publication.requested'
         WHERE job.tenant_id = $1 AND job.id = $2`,
        [tenantId, genericJobId],
      );
      expect(admittedLineage.rows[0]).toEqual({
        job_platform: "toutiao",
        grant_platform: "toutiao",
        event_platform: "toutiao",
      });

      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET state = 'dispatching', lease_owner = 'generic-browser-worker',
             lease_expires_at = clock_timestamp() + interval '10 minutes'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericJobId],
      );
      await adminClient.query(
        `INSERT INTO geo.publication_attempts
           (tenant_id, id, job_id, attempt_no, state, worker_id, request_hash,
            half_open_probe)
         VALUES ($1, $2, $3, 1, 'started', 'generic-browser-worker', $4, true)`,
        [tenantId, genericIds.attempt, genericJobId, genericRequestHash],
      );
      await adminClient.query(
        `INSERT INTO geo.circuit_breakers
           (tenant_id, scope_type, scope_key, state, reason, failure_count,
            opened_at, retry_at, probe_attempt_id, probe_started_at)
         VALUES ($1, 'account', $2, 'half_open', 'ASSISTED_CHALLENGE_REQUIRED', 2,
                 clock_timestamp() - interval '11 minutes',
                 clock_timestamp() - interval '1 minute', $3,
                 clock_timestamp())
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET state = 'half_open',
                       reason = 'ASSISTED_CHALLENGE_REQUIRED',
                       failure_count = 2,
                       opened_at = clock_timestamp() - interval '11 minutes',
                       retry_at = clock_timestamp() - interval '1 minute',
                       probe_attempt_id = $3,
                       probe_started_at = clock_timestamp()`,
        [tenantId, SEED_IDS.sampleTravel.toutiao, genericIds.attempt],
      );

      const created = await adminClient.query<{
        publication_assisted_handoff_id: string;
        was_created: boolean;
      }>(
        `SELECT * FROM geo.create_publication_assisted_handoff(
           $1, $2, $3, $4, $5, 'toutiao-browser-v1',
           'generic-toutiao-handoff', clock_timestamp() + interval '30 minutes'
         )`,
        [
          genericIds.handoff,
          genericJobId,
          genericIds.attempt,
          genericIds.bridgePrincipal,
          genericPreviewHash,
        ],
      );
      expect(created.rows[0]).toEqual({
        publication_assisted_handoff_id: genericIds.handoff,
        was_created: true,
      });
      const createdReplay = await adminClient.query<{
        publication_assisted_handoff_id: string;
        was_created: boolean;
      }>(
        `SELECT * FROM geo.create_publication_assisted_handoff(
           $1, $2, $3, $4, $5, 'toutiao-browser-v1',
           'generic-toutiao-handoff', clock_timestamp() + interval '30 minutes'
         )`,
        [
          genericIds.handoff,
          genericJobId,
          genericIds.attempt,
          genericIds.bridgePrincipal,
          genericPreviewHash,
        ],
      );
      expect(createdReplay.rows[0]).toEqual({
        publication_assisted_handoff_id: genericIds.handoff,
        was_created: false,
      });

      const handoffPlatform = await adminClient.query<{
        handoff_platform: string;
        job_platform: string;
      }>(
        `SELECT handoff.platform AS handoff_platform, job.platform AS job_platform
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(handoffPlatform.rows[0]).toEqual({
        handoff_platform: "toutiao",
        job_platform: "toutiao",
      });

      await adminClient.query("SELECT set_config('app.actor_id', $1, true)", [
        genericIds.bridgePrincipal,
      ]);
      await adminClient.query("SELECT geo.claim_publication_assisted_draft_prepare($1, 120)", [
        genericIds.handoff,
      ]);
      const preparingAccount = await adminClient.query<{
        busy: boolean;
        busy_excluding_current: boolean;
      }>(
        `SELECT
           geo.publication_account_browser_operation_busy($1, NULL, true) AS busy,
           geo.publication_account_browser_operation_busy($1, $2, true)
             AS busy_excluding_current`,
        [SEED_IDS.sampleTravel.toutiao, genericIds.handoff],
      );
      expect(preparingAccount.rows[0]).toEqual({
        busy: true,
        busy_excluding_current: false,
      });
      await adminClient.query(
        `SELECT geo.record_publication_assisted_draft(
           $1, $2::geo.sha256_hex, $3::geo.sha256_hex,
           $4::geo.sha256_hex, $5::geo.sha256_hex,
           $6::geo.sha256_hex, 'browser', clock_timestamp(), $7, $8
         )`,
        [
          genericIds.handoff,
          genericSessionEvidenceHash,
          genericDraftEvidenceHash,
          genericPrepareEvidenceHash,
          genericMediaHash,
          genericPublicContentHash,
          "toutiao-draft-integration-001",
          "toutiao-browser-v1",
        ],
      );
      const preparedAccount = await adminClient.query<{
        blocks_prepare: boolean;
        blocks_submit: boolean;
      }>(
        `SELECT
           geo.publication_account_browser_operation_busy($1, NULL, true)
             AS blocks_prepare,
           geo.publication_account_browser_operation_busy($1, NULL, false)
             AS blocks_submit`,
        [SEED_IDS.sampleTravel.toutiao],
      );
      expect(preparedAccount.rows[0]).toEqual({
        blocks_prepare: true,
        blocks_submit: false,
      });

      const permit = await adminClient.query<{
        handoff_id: string;
        submit_permit: string;
      }>("SELECT * FROM geo.claim_next_ctrip_unattended_submit()");
      expect(permit.rows[0]?.handoff_id).toBe(genericIds.handoff);
      const permittedAccount = await adminClient.query<{ busy: boolean }>(
        `SELECT geo.publication_account_browser_operation_busy($1, NULL, false) AS busy`,
        [SEED_IDS.sampleTravel.toutiao],
      );
      expect(permittedAccount.rows[0]?.busy).toBe(true);
      const permitValue = permit.rows[0]?.submit_permit;
      if (permitValue === undefined) {
        throw new Error("generic browser submit permit was not returned");
      }

      await adminClient.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
        genericIds.handoff,
        permitValue,
      ]);
      const externalId = "1234567890123456789";
      const externalUrl = `https://www.toutiao.com/article/${externalId}/`;
      await adminClient.query(
        `SELECT * FROM geo.record_publication_assisted_submit_observation(
           $1, 'accepted', 'browser', $2::geo.sha256_hex,
           $3, $4, clock_timestamp()
         )`,
        [genericIds.handoff, genericSubmitEvidenceHash, externalId, externalUrl],
      );

      await adminClient.query("SAVEPOINT prove_publisher_status_completion");
      await expect(
        adminClient.query(
          `SELECT * FROM geo.record_publication_assisted_publisher_status_confirmation(
             $1, $2::geo.sha256_hex, $3, $4, clock_timestamp()
           )`,
          [genericIds.handoff, "d".repeat(64), externalId, externalUrl],
        ),
      ).rejects.toMatchObject({ code: "55006" });
      await adminClient.query("ROLLBACK TO SAVEPOINT prove_publisher_status_completion");

      await adminClient.query("SAVEPOINT reject_expired_publisher_status_lease");
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET readback_owner_principal_id = $3,
             readback_lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.handoff, genericIds.bridgePrincipal],
      );
      await expect(
        adminClient.query(
          `SELECT * FROM geo.record_publication_assisted_publisher_status_confirmation(
             $1, $2::geo.sha256_hex, $3, $4, clock_timestamp()
           )`,
          [genericIds.handoff, "d".repeat(64), externalId, externalUrl],
        ),
      ).rejects.toMatchObject({ code: "55006" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_expired_publisher_status_lease");

      await adminClient.query("SAVEPOINT prove_publisher_status_completion");
      const publisherStatusClaim = await adminClient.query<{ handoff_id: string | null }>(
        "SELECT geo.claim_next_ctrip_unattended_readback() AS handoff_id",
      );
      expect(publisherStatusClaim.rows[0]?.handoff_id).toBe(genericIds.handoff);
      const publisherStatus = await adminClient.query<{
        state: string;
        external_id: string;
        external_url: string;
      }>(
        `SELECT * FROM geo.record_publication_assisted_publisher_status_confirmation(
           $1, $2::geo.sha256_hex, $3, $4, clock_timestamp()
         )`,
        [genericIds.handoff, "d".repeat(64), externalId, externalUrl],
      );
      expect(publisherStatus.rows[0]).toEqual({
        state: "confirmed",
        external_id: externalId,
        external_url: externalUrl,
      });
      const publisherStatusLineage = await adminClient.query<{
        handoff_state: string;
        readback_outcome: string;
        evidence_kind: string;
        receipt_confirmed: boolean;
        readback_status: string;
        readback_reason: string;
        job_state: string;
      }>(
        `SELECT handoff.state AS handoff_state, handoff.readback_outcome,
                handoff.readback_evidence_kind AS evidence_kind,
                receipt.confirmed AS receipt_confirmed,
                readback.status AS readback_status, readback.reason AS readback_reason,
                job.state AS job_state
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_receipts AS receipt
           ON receipt.tenant_id = handoff.tenant_id
          AND receipt.id = handoff.publication_receipt_id
         JOIN geo.publication_readbacks AS readback
           ON readback.tenant_id = handoff.tenant_id
          AND readback.id = handoff.publication_readback_id
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(publisherStatusLineage.rows[0]).toEqual({
        handoff_state: "confirmed",
        readback_outcome: "publisher_confirmed",
        evidence_kind: "creator_management",
        receipt_confirmed: false,
        readback_status: "succeeded",
        readback_reason: "publisher_status_confirmed",
        job_state: "confirmed",
      });
      await adminClient.query("ROLLBACK TO SAVEPOINT prove_publisher_status_completion");

      const queuedReadbackClaim = await adminClient.query<{ handoff_id: string | null }>(
        "SELECT geo.claim_next_ctrip_unattended_readback() AS handoff_id",
      );
      expect(queuedReadbackClaim.rows[0]?.handoff_id).toBe(genericIds.handoff);
      const retryingReadback = await adminClient.query<{ state: string }>(
        `SELECT * FROM geo.record_publication_assisted_readback(
           $1, 'not_found', 'browser', $2::geo.sha256_hex,
           $3::geo.sha256_hex, NULL, NULL, clock_timestamp()
         )`,
        [genericIds.handoff, genericReadbackEvidenceHash, genericPublicContentHash],
      );
      expect(retryingReadback.rows[0]?.state).toBe("readback_pending");
      const targetedReadbackBeforeTimeout = await adminClient.query<{ claimed: boolean }>(
        "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
        [genericIds.handoff],
      );
      expect(targetedReadbackBeforeTimeout.rows[0]?.claimed).toBe(true);
      await adminClient.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash,
            execution_level, scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'generic-async-readback-batch', $4,
                 'unattended', clock_timestamp(), '{}'::jsonb, $5)`,
        [tenantId, genericIds.automationBatch, genericIds.campaign, "a1".repeat(32), actorId],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, 'generic-async-readback-slot',
                 'generic-async-readback-topic', '{}'::jsonb,
                 'generic-async-readback-run', $5)`,
        [
          tenantId,
          genericIds.automationRun,
          genericIds.automationBatch,
          genericIds.campaign,
          "a2".repeat(32),
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.ctrip_account_runtime_bindings
           (tenant_id, channel_account_id, platform, profile_key, session_state,
            bridge_principal_id, last_checked_at, last_ready_at)
         VALUES ($1, $2, 'toutiao', 'generic-toutiao-runtime-profile', 'ready',
                 $3, clock_timestamp(), clock_timestamp())
         ON CONFLICT (tenant_id, channel_account_id) DO UPDATE
         SET session_state = 'ready', bridge_principal_id = EXCLUDED.bridge_principal_id,
             last_checked_at = clock_timestamp(), last_ready_at = clock_timestamp()`,
        [tenantId, SEED_IDS.sampleTravel.toutiao, genericIds.bridgePrincipal],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key, publication_idempotency_key)
         VALUES ($1, $2, $3, $4, 'toutiao',
                 'generic-async-readback-variant', 'generic-async-readback-audit',
                 'generic-async-readback-publication')`,
        [
          tenantId,
          genericIds.automationTarget,
          genericIds.automationRun,
          SEED_IDS.sampleTravel.toutiao,
        ],
      );
      await adminClient.query(
        `UPDATE geo.automation_batches
         SET state = 'running', started_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.automationBatch],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs
         SET state = 'awaiting_delivery', stage = 'delivery', attempt_count = max_attempts,
             content_item_id = $3, content_version_id = $4
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.automationRun, genericIds.contentItem, genericIds.contentVersion],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET state = 'awaiting_delivery', variant_id = $3, audit_run_id = $4,
             audit_artifact_id = $5, publication_job_id = $6
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          genericIds.automationTarget,
          genericIds.variant,
          genericIds.auditRun,
          genericIds.auditArtifact,
          genericJobId,
        ],
      );
      await adminClient.query("SAVEPOINT publisher_rejection_requeues_awaiting_delivery");
      const requeuedPublisherRejection = await adminClient.query<{
        external_id: null;
        external_url: null;
        state: string;
      }>(
        `SELECT * FROM geo.record_publication_assisted_publisher_rejection(
           $1, $2::geo.sha256_hex, 'publisher.rejected.soft_advertorial',
           clock_timestamp()
         )`,
        [genericIds.handoff, genericReadbackEvidenceHash],
      );
      expect(requeuedPublisherRejection.rows[0]).toEqual({
        state: "needs_review",
        external_id: null,
        external_url: null,
      });
      const requeuedPublisherRejectionState = await adminClient.query<{
        batch_state: string;
        handoff_error: string;
        handoff_state: string;
        job_error: string;
        job_state: string;
        publication_job_id: string | null;
        readback_outcome: string;
        readback_reason: string;
        readback_status: string;
        remediation_attempt: string;
        run_attempt_count: number;
        run_stage: string;
        run_state: string;
        target_state: string;
      }>(
        `SELECT batch.state AS batch_state,
                run.state AS run_state, run.stage AS run_stage,
                run.attempt_count AS run_attempt_count,
                target.state AS target_state,
                target.publication_job_id,
                target.remediation ->> 'attempt' AS remediation_attempt,
                job.state AS job_state, job.last_error_code AS job_error,
                handoff.state AS handoff_state,
                handoff.readback_outcome,
                handoff.last_error_code AS handoff_error,
                readback.status AS readback_status,
                readback.reason AS readback_reason
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         JOIN geo.publication_readbacks AS readback
           ON readback.tenant_id = handoff.tenant_id
          AND readback.id = handoff.publication_readback_id
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = handoff.tenant_id AND target.id = $3
         JOIN geo.automation_runs AS run
           ON run.tenant_id = target.tenant_id AND run.id = target.run_id
         JOIN geo.automation_batches AS batch
           ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff, genericIds.automationTarget],
      );
      expect(requeuedPublisherRejectionState.rows[0]).toEqual({
        batch_state: "running",
        handoff_error: "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL",
        handoff_state: "needs_review",
        job_error: "ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL",
        job_state: "permanent_failure",
        publication_job_id: null,
        readback_outcome: "publisher_rejected",
        readback_reason: "publisher.rejected.soft_advertorial",
        readback_status: "failed",
        remediation_attempt: "1",
        run_attempt_count: 0,
        run_stage: "targets",
        run_state: "scheduled",
        target_state: "pending",
      });
      await adminClient.query(
        "ROLLBACK TO SAVEPOINT publisher_rejection_requeues_awaiting_delivery",
      );
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET submit_observed_at = clock_timestamp() - interval '11 minutes',
             readback_deadline_at = clock_timestamp() - interval '1 minute',
             readback_owner_principal_id = NULL,
             readback_lease_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.handoff],
      );
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      const expiredAutomaticReadbackClaim = await adminClient.query<{
        handoff_id: string | null;
      }>("SELECT geo.claim_next_ctrip_unattended_readback() AS handoff_id");
      expect(expiredAutomaticReadbackClaim.rows[0]?.handoff_id).toBeNull();
      const timedOutReadback = await adminClient.query<{
        handoff_state: string;
        readback_outcome: string | null;
        last_error_code: string;
        deadline_extended: boolean;
      }>(
        `SELECT handoff.state AS handoff_state, handoff.readback_outcome,
                handoff.last_error_code,
                handoff.readback_deadline_at >= clock_timestamp() + interval '23 hours'
                  AS deadline_extended
         FROM geo.publication_assisted_handoffs AS handoff
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(timedOutReadback.rows[0]).toEqual({
        handoff_state: "readback_pending",
        readback_outcome: "not_found",
        last_error_code: "ASSISTED_READBACK_DEFERRED",
        deadline_extended: true,
      });
      const deferredAutomation = await adminClient.query<{
        batch_state: string;
        run_state: string;
        target_state: string;
        run_error: string | null;
        target_error: string | null;
      }>(
        `SELECT batch.state AS batch_state, run.state AS run_state,
                target.state AS target_state, run.last_error_code AS run_error,
                target.last_error_code AS target_error
         FROM geo.automation_batches AS batch
         JOIN geo.automation_runs AS run
           ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE batch.tenant_id = $1 AND batch.id = $2`,
        [tenantId, genericIds.automationBatch],
      );
      expect(deferredAutomation.rows[0]).toEqual({
        batch_state: "completed",
        run_state: "completed",
        target_state: "submitted_pending_review",
        run_error: null,
        target_error: null,
      });

      const publisherRejectionClient = adminClient;
      const recordPublisherRejection = async (
        reasonCode: "publisher.rejected.soft_advertorial" | "publisher.rejected.other",
      ) => {
        const claimed = await publisherRejectionClient.query<{ claimed: boolean }>(
          "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
          [genericIds.handoff],
        );
        expect(claimed.rows[0]?.claimed).toBe(true);
        const recorded = await publisherRejectionClient.query<{
          external_id: null;
          external_url: null;
          state: string;
        }>(
          `SELECT * FROM geo.record_publication_assisted_publisher_rejection(
             $1, $2::geo.sha256_hex, $3, clock_timestamp()
           )`,
          [genericIds.handoff, genericReadbackEvidenceHash, reasonCode],
        );
        expect(recorded.rows[0]).toEqual({
          state: "needs_review",
          external_id: null,
          external_url: null,
        });
      };
      const readPublisherRejectionAutomationState = async () => {
        const state = await publisherRejectionClient.query<{
          batch_state: string;
          job_state: string;
          publication_job_id: string | null;
          remediation_attempt: string | null;
          run_attempt_count: number;
          run_state: string;
          target_state: string;
        }>(
          `SELECT batch.state AS batch_state,
                  run.state AS run_state,
                  run.attempt_count AS run_attempt_count,
                  target.state AS target_state,
                  target.publication_job_id,
                  target.remediation ->> 'attempt' AS remediation_attempt,
                  job.state AS job_state
           FROM geo.publication_assisted_handoffs AS handoff
           JOIN geo.publication_jobs AS job
             ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
           JOIN geo.automation_run_targets AS target
             ON target.tenant_id = handoff.tenant_id AND target.id = $3
           JOIN geo.automation_runs AS run
             ON run.tenant_id = target.tenant_id AND run.id = target.run_id
           JOIN geo.automation_batches AS batch
             ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
           WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
          [tenantId, genericIds.handoff, genericIds.automationTarget],
        );
        return state.rows[0];
      };

      await adminClient.query("SAVEPOINT publisher_rejection_remediation_disabled");
      await adminClient.query(
        `UPDATE geo.automation_batches
         SET configuration = jsonb_set(
           configuration, '{automationRemediationEnabled}', 'false'::jsonb, true
         )
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.automationBatch],
      );
      await recordPublisherRejection("publisher.rejected.soft_advertorial");
      expect(await readPublisherRejectionAutomationState()).toEqual({
        batch_state: "partially_failed",
        job_state: "permanent_failure",
        publication_job_id: genericJobId,
        remediation_attempt: null,
        run_attempt_count: 5,
        run_state: "delivery_failed",
        target_state: "publisher_rejected",
      });
      await adminClient.query("ROLLBACK TO SAVEPOINT publisher_rejection_remediation_disabled");

      await adminClient.query("SAVEPOINT publisher_rejection_second_remediation");
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET remediation = jsonb_build_object(
           'taskId', 'prior-publisher-remediation',
           'scope', 'target',
           'mode', 'automatic',
           'attempt', 1,
           'maxAttempts', 2,
           'reasonCodes', jsonb_build_array('publisher.rejected.soft_advertorial'),
           'actions', jsonb_build_array('rebuild_article')
         )
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.automationTarget],
      );
      await recordPublisherRejection("publisher.rejected.soft_advertorial");
      expect(await readPublisherRejectionAutomationState()).toEqual({
        batch_state: "running",
        job_state: "permanent_failure",
        publication_job_id: null,
        remediation_attempt: "2",
        run_attempt_count: 0,
        run_state: "scheduled",
        target_state: "pending",
      });
      await adminClient.query("ROLLBACK TO SAVEPOINT publisher_rejection_second_remediation");

      await adminClient.query("SAVEPOINT publisher_rejection_budget_exhausted");
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET remediation = jsonb_build_object(
           'taskId', 'exhausted-publisher-remediation',
           'scope', 'target',
           'mode', 'automatic',
           'attempt', 2,
           'maxAttempts', 2,
           'reasonCodes', jsonb_build_array('publisher.rejected.soft_advertorial'),
           'actions', jsonb_build_array('rebuild_article')
         )
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.automationTarget],
      );
      await recordPublisherRejection("publisher.rejected.soft_advertorial");
      expect(await readPublisherRejectionAutomationState()).toEqual({
        batch_state: "partially_failed",
        job_state: "permanent_failure",
        publication_job_id: genericJobId,
        remediation_attempt: "2",
        run_attempt_count: 5,
        run_state: "delivery_failed",
        target_state: "publisher_rejected",
      });
      const exhaustedPublisherRejectionAudit = await adminClient.query<{
        remediation_attempt: number;
        remediation_requeued: boolean;
      }>(
        `SELECT (details ->> 'remediationAttempt')::integer AS remediation_attempt,
                (details ->> 'remediationRequeued')::boolean AS remediation_requeued
         FROM geo.audit_log
         WHERE tenant_id = $1
           AND action = 'publication_assisted_handoff.publisher_rejected'
           AND resource_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, genericIds.handoff],
      );
      expect(exhaustedPublisherRejectionAudit.rows[0]).toEqual({
        remediation_attempt: 3,
        remediation_requeued: false,
      });
      await adminClient.query("ROLLBACK TO SAVEPOINT publisher_rejection_budget_exhausted");

      await adminClient.query("SAVEPOINT publisher_rejection_generic_reason");
      await recordPublisherRejection("publisher.rejected.other");
      expect(await readPublisherRejectionAutomationState()).toEqual({
        batch_state: "partially_failed",
        job_state: "permanent_failure",
        publication_job_id: genericJobId,
        remediation_attempt: null,
        run_attempt_count: 5,
        run_state: "delivery_failed",
        target_state: "publisher_rejected",
      });
      await adminClient.query("ROLLBACK TO SAVEPOINT publisher_rejection_generic_reason");

      const immediateReadbackClaim = await adminClient.query<{ claimed: boolean }>(
        "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
        [genericIds.handoff],
      );
      expect(immediateReadbackClaim.rows[0]?.claimed).toBe(true);
      await adminClient.query(
        `SELECT * FROM geo.record_publication_assisted_readback(
           $1, 'not_found', 'browser', $2::geo.sha256_hex,
           $3::geo.sha256_hex, NULL, NULL, clock_timestamp()
         )`,
        [genericIds.handoff, genericReadbackEvidenceHash, genericPublicContentHash],
      );
      const deferredState = await adminClient.query<{
        handoff_error: string | null;
        handoff_state: string;
        job_error: string | null;
        job_state: string;
      }>(
        `SELECT handoff.state AS handoff_state, handoff.last_error_code AS handoff_error,
                job.state AS job_state, job.last_error_code AS job_error
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(deferredState.rows[0]).toEqual({
        handoff_state: "readback_pending",
        handoff_error: "ASSISTED_READBACK_DEFERRED",
        job_state: "uncertain",
        job_error: "ASSISTED_READBACK_DEFERRED",
      });
      await adminClient.query("SAVEPOINT priority_readback_deadline_race");
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET submit_observed_at = clock_timestamp() - interval '11 minutes',
             readback_deadline_at = clock_timestamp() - interval '1 minute',
             readback_owner_principal_id = NULL,
             readback_lease_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.handoff],
      );
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      const deadlineRaceClaim = await adminClient.query<{ claimed: boolean }>(
        "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
        [genericIds.handoff],
      );
      expect(deadlineRaceClaim.rows[0]?.claimed).toBe(true);
      const deadlineRaceReadback = await adminClient.query<{ state: string }>(
        `SELECT * FROM geo.record_publication_assisted_readback(
           $1, 'not_found', 'browser', $2::geo.sha256_hex,
           $3::geo.sha256_hex, NULL, NULL, clock_timestamp()
         )`,
        [genericIds.handoff, genericReadbackEvidenceHash, genericPublicContentHash],
      );
      expect(deadlineRaceReadback.rows[0]?.state).toBe("readback_pending");
      const expiredPriorityReadback = await adminClient.query<{ processed: number }>(
        "SELECT geo.expire_priority_platform_readback_windows() AS processed",
      );
      expect(expiredPriorityReadback.rows[0]?.processed).toBe(1);
      await adminClient.query("ROLLBACK TO SAVEPOINT priority_readback_deadline_race");
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET submit_observed_at = clock_timestamp() - interval '25 hours',
             readback_deadline_at = clock_timestamp() - interval '1 minute',
             readback_owner_principal_id = NULL,
             readback_lease_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, genericIds.handoff],
      );
      await adminClient.query(
        "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoffs_transition_only",
      );
      const reopenedExpiredClaim = await adminClient.query<{ handoff_id: string | null }>(
        "SELECT geo.claim_next_ctrip_unattended_readback() AS handoff_id",
      );
      expect(reopenedExpiredClaim.rows[0]?.handoff_id).toBeNull();
      const reopenedExpiredState = await adminClient.query<{
        handoff_state: string;
        readback_outcome: string | null;
        last_error_code: string;
      }>(
        `SELECT handoff.state AS handoff_state, handoff.readback_outcome,
                handoff.last_error_code
         FROM geo.publication_assisted_handoffs AS handoff
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(reopenedExpiredState.rows[0]).toEqual({
        handoff_state: "needs_review",
        readback_outcome: "not_found",
        last_error_code: "ASSISTED_READBACK_UNCERTAIN",
      });
      const reopenedAgain = await adminClient.query<{ reopened: boolean }>(
        "SELECT geo.reopen_publication_assisted_readback($1) AS reopened",
        [genericIds.handoff],
      );
      expect(reopenedAgain.rows[0]?.reopened).toBe(true);

      await adminClient.query("SAVEPOINT reject_cross_platform_readback");
      await expect(
        adminClient.query(
          `SELECT * FROM geo.record_publication_assisted_readback(
             $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
             $3::geo.sha256_hex, $4,
             'https://www.sohu.com/a/1234567890123456789_1234567890',
             clock_timestamp()
           )`,
          [genericIds.handoff, genericReadbackEvidenceHash, genericPublicContentHash, externalId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_cross_platform_readback");

      const confirmed = await adminClient.query<{
        external_id: string;
        external_url: string;
        state: string;
      }>(
        `SELECT * FROM geo.record_publication_assisted_readback(
           $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
           $3::geo.sha256_hex, $4, $5, clock_timestamp()
         )`,
        [
          genericIds.handoff,
          genericReadbackEvidenceHash,
          genericPublicContentHash,
          externalId,
          externalUrl,
        ],
      );
      expect(confirmed.rows[0]).toEqual({
        state: "confirmed",
        external_id: externalId,
        external_url: externalUrl,
      });

      const confirmedLineage = await adminClient.query<{
        external_id: string;
        external_url: string;
        handoff_state: string;
        job_state: string;
        public_content_hash: string;
        readback_status: string;
        receipt_platform: string;
      }>(
        `SELECT handoff.state AS handoff_state,
                job.state AS job_state,
                readback.status AS readback_status,
                receipt.platform AS receipt_platform,
                handoff.external_id,
                handoff.external_url,
                handoff.public_content_hash
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         JOIN geo.publication_receipts AS receipt
           ON receipt.tenant_id = handoff.tenant_id
          AND receipt.id = handoff.publication_receipt_id
         JOIN geo.publication_readbacks AS readback
           ON readback.tenant_id = handoff.tenant_id
          AND readback.id = handoff.publication_readback_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, genericIds.handoff],
      );
      expect(confirmedLineage.rows[0]).toEqual({
        handoff_state: "confirmed",
        job_state: "confirmed",
        readback_status: "succeeded",
        receipt_platform: "toutiao",
        external_id: externalId,
        external_url: externalUrl,
        public_content_hash: genericPublicContentHash,
      });

      const platformDefault = await adminClient.query<{ column_default: string | null }>(
        `SELECT column_default
         FROM information_schema.columns
         WHERE table_schema = 'geo'
           AND table_name = 'publication_assisted_handoffs'
           AND column_name = 'platform'`,
      );
      expect(platformDefault.rows[0]?.column_default).toBeNull();

      const genericPrivilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_function_privilege(
           'geo_runtime',
           'geo.consume_browser_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamp with time zone)',
           'EXECUTE'
         ) AS allowed`,
      );
      expect(genericPrivilege.rows[0]?.allowed).toBe(true);

      const publisherRejectionPrivilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_function_privilege(
           'geo_runtime',
           'geo.record_publication_assisted_publisher_rejection(uuid,geo.sha256_hex,text,timestamp with time zone)',
           'EXECUTE'
         ) AS allowed`,
      );
      expect(publisherRejectionPrivilege.rows[0]?.allowed).toBe(true);
    } finally {
      await adminClient.query("ROLLBACK");
    }
  });

  it("isolates leased Ctrip handoffs without a Phase C admission gate", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const historyDatabase = createDatabase({
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`,
      applicationName: "geo-automation-terminal-sync-history",
      maxConnections: 2,
    });
    await bindHistoricalPublication(historyDatabase, {
      schemaVersion: "geo.historical-publication-binding.v1",
      tenantId,
      actorId,
      channelAccountId: SEED_IDS.sampleTravel.ctrip,
      platform: "ctrip_community",
      idempotencyKey: "history:ctrip:123450005:v1",
      externalId: "123450005",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450005",
      title: "Protected historical Ctrip publication",
      body: "This offline historical record is the duplicate-content baseline and must not be republished.",
      publicContentHash: ctripPublicContentHash(
        "Protected historical Ctrip publication",
        "This offline historical record is the duplicate-content baseline and must not be republished.",
      ),
      publishedAt: "2026-07-19T02:00:00.000Z",
      observedAt: "2026-07-20T02:00:00.000Z",
      evidence: {
        sha256: "8".repeat(64),
        reference: "offline-capture:protected-history-123450005",
      },
    });
    const assistedRequestHash = "4".repeat(64);
    const previewHash = "5".repeat(64);
    const sessionEvidenceHash = "6".repeat(64);
    const draftEvidenceHash = "7".repeat(64);
    const prepareEvidenceHash = "8".repeat(64);
    const mediaManifestHash = "9".repeat(64);
    const publicContentHash = "b".repeat(64);
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
        [tenantId, SEED_IDS.sampleTravel.ctrip],
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
        [tenantId, ids.ctripAssistedCampaign, SEED_IDS.sampleTravel.brand],
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
          SEED_IDS.sampleTravel.brand,
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
          SEED_IDS.sampleTravel.ctrip,
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
          SEED_IDS.sampleTravel.policy,
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
          SEED_IDS.sampleTravel.ctrip,
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
          SEED_IDS.sampleTravel.ctrip,
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
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query("ROLLBACK TO SAVEPOINT reject_unattended");

      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET last_verified_at = clock_timestamp() - interval '25 hours'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      await adminClient.query("SAVEPOINT allow_stale_evidence");
      const staleEvidenceAdmission = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
           $1, $2, $3, $4, 'assisted', NULL
         )`,
        [
          ids.ctripAssistedGrant,
          "0".repeat(64),
          "ctrip-stale-evidence-allowed",
          assistedRequestHash,
        ],
      );
      expect(staleEvidenceAdmission.rows[0]?.was_created).toBe(true);
      await adminClient.query("ROLLBACK TO SAVEPOINT allow_stale_evidence");
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
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
      const phaseAAdmission = await adminClient.query<GrantConsumptionRow>(
        `SELECT * FROM geo.consume_ctrip_assisted_publication_grant(
             $1, $2, $3, $4, 'assisted', NULL
           )`,
        [
          ids.ctripAssistedGrant,
          "0".repeat(64),
          "ctrip-scoped-control-rejected",
          assistedRequestHash,
        ],
      );
      expect(phaseAAdmission.rows[0]?.was_created).toBe(true);
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

    await adminClient.query("BEGIN");
    try {
      await adminClient.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
            execution_level, scheduled_for, configuration, created_by_actor_id)
         SELECT job.tenant_id, $1, item.campaign_id, 'automation-terminal-sync-batch',
                $2, 'scheduled', job.execution_level, clock_timestamp(), '{}'::jsonb, $3
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         WHERE job.tenant_id = $4 AND job.id = $5`,
        [ids.automationTerminalSyncBatch, "1".repeat(64), actorId, tenantId, ctripJobId],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash)
         SELECT job.tenant_id, $1, $2, item.campaign_id, 'terminal-sync-slot',
                'terminal-sync-topic', '{}'::jsonb, 'automation-terminal-sync-run',
                $3
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         WHERE job.tenant_id = $4 AND job.id = $5`,
        [
          ids.automationTerminalSyncRun,
          ids.automationTerminalSyncBatch,
          "2".repeat(64),
          tenantId,
          ctripJobId,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key, publication_idempotency_key)
         SELECT job.tenant_id, $1, $2, job.channel_account_id, job.platform,
                'automation-terminal-sync-variant', 'automation-terminal-sync-audit',
                'automation-terminal-sync-publication'
         FROM geo.publication_jobs AS job
         WHERE job.tenant_id = $3 AND job.id = $4`,
        [ids.automationTerminalSyncTarget, ids.automationTerminalSyncRun, tenantId, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.automation_batches
         SET state = 'running', started_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncBatch],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs AS run
         SET state = 'awaiting_delivery', stage = 'delivery', attempt_count = max_attempts,
             available_at = clock_timestamp() - interval '1 second',
             content_item_id = item.id, content_version_id = version.id
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         WHERE run.tenant_id = job.tenant_id
           AND run.tenant_id = $1 AND run.id = $2 AND job.id = $3`,
        [tenantId, ids.automationTerminalSyncRun, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets AS target
         SET state = 'awaiting_delivery',
             variant_id = job.variant_id,
             audit_run_id = artifact.audit_run_id,
             audit_artifact_id = job.audit_artifact_id,
             publication_job_id = job.id
         FROM geo.publication_jobs AS job
         JOIN geo.audit_artifacts AS artifact
           ON artifact.tenant_id = job.tenant_id AND artifact.id = job.audit_artifact_id
         WHERE target.tenant_id = job.tenant_id
           AND target.tenant_id = $1
           AND target.id = $2
           AND job.id = $3`,
        [tenantId, ids.automationTerminalSyncTarget, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET state = 'needs_review', last_error_code = 'ASSISTED_ADAPTER_DRIFT'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );

      const synchronized = await adminClient.query<{
        batch_state: string;
        run_error: string | null;
        run_state: string;
        target_error: string | null;
        target_state: string;
      }>(
        `SELECT batch.state AS batch_state, run.state AS run_state,
                run.last_error_code AS run_error, target.state AS target_state,
                target.last_error_code AS target_error
         FROM geo.automation_batches AS batch
         JOIN geo.automation_runs AS run
           ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE batch.tenant_id = $1 AND batch.id = $2`,
        [tenantId, ids.automationTerminalSyncBatch],
      );
      expect(synchronized.rows[0]).toEqual({
        batch_state: "partially_failed",
        run_state: "blocked",
        run_error: "AUTOMATION_GATE_BLOCKED",
        target_state: "blocked",
        target_error: "ASSISTED_ADAPTER_DRIFT",
      });

      await adminClient.query(
        `UPDATE geo.automation_batches
         SET state = 'running', completed_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncBatch],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs
         SET state = 'awaiting_delivery', stage = 'delivery', lease_owner = NULL,
             lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL,
             last_error_message = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncRun],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET state = 'awaiting_delivery', completed_at = NULL,
             last_error_code = NULL, last_error_message = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncTarget],
      );
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET state = 'uncertain', confirmed_at = NULL, last_error_code = 'ASSISTED_READBACK_UNAVAILABLE'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET state = 'submitted_pending_review', completed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncTarget],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs
         SET state = 'completed', completed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncRun],
      );
      await adminClient.query(
        `UPDATE geo.automation_batches
         SET state = 'completed', completed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationTerminalSyncBatch],
      );
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET state = 'confirmed', confirmed_at = clock_timestamp(), last_error_code = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );
      const confirmedSynchronized = await adminClient.query<{
        batch_state: string;
        run_error: string | null;
        run_state: string;
        target_error: string | null;
        target_state: string;
      }>(
        `SELECT batch.state AS batch_state, run.state AS run_state,
                run.last_error_code AS run_error, target.state AS target_state,
                target.last_error_code AS target_error
         FROM geo.automation_batches AS batch
         JOIN geo.automation_runs AS run
           ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE batch.tenant_id = $1 AND batch.id = $2`,
        [tenantId, ids.automationTerminalSyncBatch],
      );
      expect(confirmedSynchronized.rows[0]).toEqual({
        batch_state: "completed",
        run_state: "completed",
        run_error: null,
        target_state: "confirmed",
        target_error: null,
      });
    } finally {
      await adminClient.query("ROLLBACK");
      await historyDatabase.destroy();
    }

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
          [SEED_IDS.sampleTravel.ctrip],
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
             'browser', clock_timestamp(), $4, 'ASSISTED_ADAPTER_DRIFT',
             'prepare:media-clear-incomplete'
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
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(driftCircuit.rows[0]).toEqual({
          state: "open",
          reason: "ASSISTED_ADAPTER_DRIFT",
        });
        const driftDiagnostic = await client.query<{ last_error_message: string | null }>(
          `SELECT last_error_message FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(driftDiagnostic.rows[0]?.last_error_message).toBe("prepare:media-clear-incomplete");
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
        const sessionCircuit = await client.query<{ state: string; reason: string }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(sessionCircuit.rows[0]).toEqual({
          state: "open",
          reason: "ASSISTED_SESSION_REQUIRED",
        });
      },
      { actor: ids.ctripBridgePrincipal },
    );

    const crossTenantSessionCircuit = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
      [syntheticTenantId, SEED_IDS.sampleTravel.ctrip],
    );
    expect(crossTenantSessionCircuit.rows[0]?.count).toBe("0");
    await expect(
      runtimeTransaction(
        (client) =>
          client.query("SELECT geo.claim_publication_assisted_draft_prepare($1, 300)", [
            ids.ctripAssistedHandoff,
          ]),
        { actor: ids.ctripBridgePrincipal },
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await runtimeTransaction((client) =>
      client.query(
        `UPDATE geo.circuit_breakers
         SET state = 'open', failure_count = 1, opened_at = clock_timestamp(),
             retry_at = clock_timestamp() - interval '1 second',
             reason = 'ASSISTED_SESSION_REQUIRED',
             probe_attempt_id = NULL, probe_started_at = NULL
         WHERE scope_type = 'account' AND scope_key = $1`,
        [SEED_IDS.sampleTravel.ctrip],
      ),
    );
    await runtimeTransaction(
      async (client) => {
        const recoveryClaim = await client.query<{ handoff_id: string | null }>(
          "SELECT geo.claim_next_publication_assisted_draft_prepare(300) AS handoff_id",
        );
        expect(recoveryClaim.rows[0]?.handoff_id).toBe(ids.ctripAssistedHandoff);
        const probeState = await client.query<{ state: string; reason: string }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(probeState.rows[0]).toEqual({
          state: "half_open",
          reason: "ASSISTED_SESSION_REQUIRED",
        });
        const blockedProbeClaim = await client.query<{ handoff_id: string | null }>(
          "SELECT geo.claim_next_publication_assisted_draft_prepare(300) AS handoff_id",
        );
        expect(blockedProbeClaim.rows[0]?.handoff_id).toBeNull();
        await client.query(
          `SELECT geo.record_publication_assisted_draft(
             $1, $2::geo.sha256_hex, $3::geo.sha256_hex,
             $4::geo.sha256_hex, $5::geo.sha256_hex,
             $6::geo.sha256_hex, 'browser', clock_timestamp(), $7, $8
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            draftEvidenceHash,
            prepareEvidenceHash,
            mediaManifestHash,
            publicContentHash,
            "ctrip-draft-integration-001",
            "ctrip-community-web-v1",
          ],
        );
        const preparedEvidence = await client.query<{
          prepare_outcome: string;
          prepare_evidence_kind: string;
          prepare_evidence_hash: string;
          media_manifest_hash: string;
          public_content_hash: string;
          draft_lease_released: boolean;
          observed: boolean;
        }>(
          `SELECT prepare_outcome, prepare_evidence_kind, prepare_evidence_hash,
                  media_manifest_hash, public_content_hash,
                  draft_prepare_owner_principal_id IS NULL AS draft_lease_released,
                  prepare_observed_at IS NOT NULL AS observed
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(preparedEvidence.rows[0]).toEqual({
          prepare_outcome: "prepared",
          prepare_evidence_kind: "browser",
          prepare_evidence_hash: prepareEvidenceHash,
          media_manifest_hash: mediaManifestHash,
          public_content_hash: publicContentHash,
          draft_lease_released: true,
          observed: true,
        });
        const closedCircuit = await client.query<{ state: string; reason: string | null }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(closedCircuit.rows[0]).toEqual({
          state: "closed",
          reason: null,
        });

        await client.query("SAVEPOINT prepared_session_blocker");
        await client.query(
          `SELECT geo.record_publication_assisted_prepared_conflict(
             $1, $2::geo.sha256_hex, 'browser', clock_timestamp(), $3,
             'submit:session-required'
           )`,
          [ids.ctripAssistedHandoff, blockerEvidenceHash, "ctrip-community-web-v1"],
        );
        const sessionBlocker = await client.query<{
          last_error_code: string;
          last_error_message: string;
          prepare_outcome: string;
          state: string;
        }>(
          `SELECT state, prepare_outcome, last_error_code, last_error_message
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(sessionBlocker.rows[0]).toEqual({
          state: "session_required",
          prepare_outcome: "session_required",
          last_error_code: "ASSISTED_SESSION_REQUIRED",
          last_error_message: "submit:session-required",
        });
        await client.query("ROLLBACK TO SAVEPOINT prepared_session_blocker");

        await client.query("SAVEPOINT prepared_challenge_blocker");
        await client.query(
          `SELECT geo.record_publication_assisted_prepared_conflict(
             $1, $2::geo.sha256_hex, 'browser', clock_timestamp(), $3,
             'submit:challenge-required'
           )`,
          [ids.ctripAssistedHandoff, blockerEvidenceHash, "ctrip-community-web-v1"],
        );
        const challengeBlocker = await client.query<{
          last_error_code: string;
          prepare_outcome: string;
          state: string;
        }>(
          `SELECT state, prepare_outcome, last_error_code
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(challengeBlocker.rows[0]).toEqual({
          state: "challenge_required",
          prepare_outcome: "challenge_required",
          last_error_code: "ASSISTED_CHALLENGE_REQUIRED",
        });
        const preparedChallengeCircuit = await client.query<{
          reason: string;
          retry_is_future: boolean;
          state: string;
        }>(
          `SELECT state, reason, retry_at > statement_timestamp() AS retry_is_future
           FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(preparedChallengeCircuit.rows[0]).toEqual({
          state: "open",
          reason: "ASSISTED_CHALLENGE_REQUIRED",
          retry_is_future: true,
        });
        await client.query("ROLLBACK TO SAVEPOINT prepared_challenge_blocker");

        await client.query("SAVEPOINT prepared_payload_mismatch");
        await client.query(
          `SELECT geo.record_publication_assisted_prepared_conflict(
             $1, $2::geo.sha256_hex, 'browser', clock_timestamp(), $3,
             'submit:body-mismatch'
           )`,
          [ids.ctripAssistedHandoff, blockerEvidenceHash, "ctrip-community-web-v1"],
        );
        const payloadMismatch = await client.query<{
          last_error_code: string;
          last_error_message: string;
          state: string;
        }>(
          `SELECT state, last_error_code, last_error_message
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(payloadMismatch.rows[0]).toEqual({
          state: "failed",
          last_error_code: "ASSISTED_PREPARED_DRAFT_MISMATCH",
          last_error_message: "submit:body-mismatch",
        });
        await client.query("ROLLBACK TO SAVEPOINT prepared_payload_mismatch");
      },
      { actor: ids.ctripBridgePrincipal },
    );

    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT awaiting_submit_challenge");
        const issued = await client.query<{ submit_permit: string }>(
          "SELECT * FROM geo.issue_publication_assisted_submit_permit($1)",
          [ids.ctripAssistedHandoff],
        );
        expect(issued.rows[0]?.submit_permit).toMatch(/^[0-9a-f]{64}$/u);
        await client.query("SELECT set_config('app.actor_id', $1, true)", [
          ids.ctripBridgePrincipal,
        ]);
        await client.query(
          `SELECT geo.record_publication_assisted_prepared_conflict(
             $1, $2::geo.sha256_hex, 'browser', clock_timestamp(), $3,
             'submit:challenge-required'
           )`,
          [ids.ctripAssistedHandoff, blockerEvidenceHash, "ctrip-community-web-v1"],
        );
        const awaitingChallenge = await client.query<{
          last_error_code: string;
          permit_cleared: boolean;
          state: string;
        }>(
          `SELECT state, last_error_code,
                  submit_permit_hash IS NULL AND submit_permit_expires_at IS NULL
                    AS permit_cleared
           FROM geo.publication_assisted_handoffs WHERE id = $1`,
          [ids.ctripAssistedHandoff],
        );
        expect(awaitingChallenge.rows[0]).toEqual({
          state: "challenge_required",
          last_error_code: "ASSISTED_CHALLENGE_REQUIRED",
          permit_cleared: true,
        });
        await client.query("ROLLBACK TO SAVEPOINT awaiting_submit_challenge");
      },
      { actor: actorId },
    );

    // A bridge crash mid-probe leaves the account breaker half-open with an
    // expired draft lease. The next claim must re-arm the probe instead of
    // blocking the account queue forever.
    await runtimeTransaction((client) =>
      client.query(
        `UPDATE geo.circuit_breakers
         SET state = 'half_open', retry_at = NULL,
             reason = 'ASSISTED_SESSION_REQUIRED',
             probe_attempt_id = NULL, probe_started_at = NULL
         WHERE scope_type = 'account' AND scope_key = $1`,
        [SEED_IDS.sampleTravel.ctrip],
      ),
    );
    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoffs_transition_only",
    );
    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoff_session_required_circuit",
    );
    await adminClient.query(
      `UPDATE geo.publication_assisted_handoffs
       SET state = 'session_required',
           draft_prepare_owner_principal_id = NULL,
           draft_prepare_lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoff_session_required_circuit",
    );
    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoffs_transition_only",
    );
    await runtimeTransaction(
      async (client) => {
        const staleProbeClaim = await client.query<{ handoff_id: string | null }>(
          "SELECT geo.claim_next_publication_assisted_draft_prepare(300) AS handoff_id",
        );
        expect(staleProbeClaim.rows[0]?.handoff_id).toBe(ids.ctripAssistedHandoff);
        const rearmedProbe = await client.query<{ state: string; probe_started: boolean }>(
          `SELECT state, probe_started_at IS NOT NULL AS probe_started
           FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(rearmedProbe.rows[0]).toEqual({
          state: "half_open",
          probe_started: true,
        });
        const blockedDuringRearmedProbe = await client.query<{ handoff_id: string | null }>(
          "SELECT geo.claim_next_publication_assisted_draft_prepare(300) AS handoff_id",
        );
        expect(blockedDuringRearmedProbe.rows[0]?.handoff_id).toBeNull();
      },
      { actor: ids.ctripBridgePrincipal },
    );

    // The re-armed probe succeeds and records a fresh draft, so the handoff
    // continues through the original Phase B flow as a prepared assisted draft.
    await runtimeTransaction(
      async (client) => {
        await client.query(
          `SELECT geo.record_publication_assisted_draft(
             $1, $2::geo.sha256_hex, $3::geo.sha256_hex,
             $4::geo.sha256_hex, $5::geo.sha256_hex,
             $6::geo.sha256_hex, 'browser', clock_timestamp(), $7, $8
           )`,
          [
            ids.ctripAssistedHandoff,
            sessionEvidenceHash,
            draftEvidenceHash,
            prepareEvidenceHash,
            mediaManifestHash,
            publicContentHash,
            "ctrip-draft-integration-002",
            "ctrip-community-web-v1",
          ],
        );
        const rearmedCircuit = await client.query<{ state: string; reason: string | null }>(
          `SELECT state, reason FROM geo.circuit_breakers
           WHERE scope_type = 'account' AND scope_key = $1`,
          [SEED_IDS.sampleTravel.ctrip],
        );
        expect(rearmedCircuit.rows[0]).toEqual({
          state: "closed",
          reason: null,
        });
      },
      { actor: ids.ctripBridgePrincipal },
    );

    await adminClient.query("BEGIN");
    try {
      await adminClient.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
        [tenantId, actorId],
      );
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET supported_execution_levels = ARRAY['dry_run', 'assisted', 'unattended'],
             capability_evidence_type = 'platform_readback',
             capability_evidence_refs =
               '["adapter:ctrip-community-browser-unattended-v1"]'::jsonb,
             last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'unattended', kill_switch_enabled = false
         WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
        [tenantId],
      );
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET execution_level = 'unattended'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET lease_owner_actor_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.ctripAssistedHandoff],
      );

      const immediatePhase = await adminClient.query<{ phase: string }>(
        "SELECT geo.ctrip_release_phase($1) AS phase",
        [SEED_IDS.sampleTravel.ctrip],
      );
      expect(immediatePhase.rows[0]?.phase).toBe("C");

      await adminClient.query(
        `INSERT INTO geo.automation_controls
           (tenant_id, scope_type, scope_key, mode, kill_switch_enabled)
         VALUES ($1, 'account', $2, 'supervised', false)
         ON CONFLICT (tenant_id, scope_type, scope_key)
         DO UPDATE SET mode = 'supervised', kill_switch_enabled = false`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      const supervisedPhase = await adminClient.query<{ phase: string }>(
        "SELECT geo.ctrip_release_phase($1) AS phase",
        [SEED_IDS.sampleTravel.ctrip],
      );
      expect(supervisedPhase.rows[0]?.phase).toBe("C");

      await adminClient.query("SAVEPOINT allow_phase_c_without_canary");
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'unattended'
         WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      await adminClient.query("ROLLBACK TO SAVEPOINT allow_phase_c_without_canary");

      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET execution_level = 'assisted'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET lease_owner_actor_id = $3,
             lease_expires_at = LEAST(expires_at, clock_timestamp() + interval '5 minutes'),
             heartbeat_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.ctripAssistedHandoff, actorId],
      );
      const phaseBPermit = await adminClient.query<{ submit_permit: string }>(
        "SELECT * FROM geo.issue_publication_assisted_submit_permit($1)",
        [ids.ctripAssistedHandoff],
      );
      const phaseBPermitValue = phaseBPermit.rows[0]?.submit_permit;
      if (phaseBPermitValue === undefined) throw new Error("Phase B permit was not returned");
      await adminClient.query("SELECT set_config('app.actor_id', $1, true)", [
        ids.ctripBridgePrincipal,
      ]);
      await adminClient.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
        ids.ctripAssistedHandoff,
        phaseBPermitValue,
      ]);
      const canaryExternalId = "341873247";
      const canaryExternalUrl = `https://m.ctrip.com/webapp/you/community/detail?articleId=${canaryExternalId}`;
      await adminClient.query(
        `SELECT * FROM geo.record_publication_assisted_submit_observation(
           $1, 'accepted', 'browser', $2::geo.sha256_hex,
           $3, $4, clock_timestamp()
         )`,
        [ids.ctripAssistedHandoff, "b".repeat(64), canaryExternalId, canaryExternalUrl],
      );
      await adminClient.query(
        `SELECT * FROM geo.record_publication_assisted_readback(
           $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
           $3::geo.sha256_hex, $4, $5, clock_timestamp()
         )`,
        [
          ids.ctripAssistedHandoff,
          "c".repeat(64),
          publicContentHash,
          canaryExternalId,
          canaryExternalUrl,
        ],
      );
      await adminClient.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'unattended'
         WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      const finalPhase = await adminClient.query<{ phase: string }>(
        "SELECT geo.ctrip_release_phase($1) AS phase",
        [SEED_IDS.sampleTravel.ctrip],
      );
      expect(finalPhase.rows[0]?.phase).toBe("C");
      await adminClient.query("ROLLBACK");
    } catch (error) {
      await adminClient.query("ROLLBACK");
      throw error;
    }

    await adminClient.query(
      `INSERT INTO geo.automation_controls (
         tenant_id, scope_type, scope_key, mode, kill_switch_enabled
       ) VALUES ($1, 'account', $2, 'supervised', false)
       ON CONFLICT (tenant_id, scope_type, scope_key)
       DO UPDATE SET mode = 'supervised', kill_switch_enabled = false`,
      [tenantId, SEED_IDS.sampleTravel.ctrip],
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

    await adminClient.query("BEGIN");
    try {
      await adminClient.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
        [tenantId, ids.ctripBridgePrincipal],
      );
      await adminClient.query(
        `UPDATE geo.channel_accounts
         SET supported_execution_levels = ARRAY['dry_run', 'assisted', 'unattended'],
             capability_evidence_type = 'platform_readback',
             capability_evidence_refs =
               '["adapter:ctrip-community-browser-unattended-v1"]'::jsonb,
             last_verified_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      await adminClient.query(
        `UPDATE geo.automation_controls
         SET mode = 'unattended', kill_switch_enabled = false
         WHERE tenant_id = $1
           AND (
             (scope_type = 'tenant' AND scope_key = '*') OR
             (scope_type = 'account' AND scope_key = $2)
           )`,
        [tenantId, SEED_IDS.sampleTravel.ctrip],
      );
      await adminClient.query(
        `UPDATE geo.publication_jobs
         SET execution_level = 'unattended'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ctripJobId],
      );
      await adminClient.query(
        `UPDATE geo.publication_assisted_handoffs
         SET lease_owner_actor_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.ctripAssistedHandoff],
      );

      const unattendedClaim = await adminClient.query<{
        handoff_id: string;
        submit_permit: string;
      }>("SELECT * FROM geo.claim_next_ctrip_unattended_submit()");
      expect(unattendedClaim.rows[0]?.handoff_id).toBe(ids.ctripAssistedHandoff);
      const unattendedPermit = unattendedClaim.rows[0]?.submit_permit;
      expect(unattendedPermit).toMatch(/^[0-9a-f]{64}$/u);
      if (unattendedPermit === undefined) {
        throw new Error("Unattended submit claim returned no permit");
      }
      await adminClient.query("SELECT geo.consume_publication_assisted_submit_permit($1, $2)", [
        ids.ctripAssistedHandoff,
        unattendedPermit,
      ]);
      const firstUnattendedRecovery = await adminClient.query<{
        publication_readback_id: string;
        publication_receipt_id: string;
      }>(
        `SELECT * FROM geo.recover_publication_assisted_submit_uncertain(
           $1, 'simulation'
         )`,
        [ids.ctripAssistedHandoff],
      );
      const replayedUnattendedRecovery = await adminClient.query<{
        publication_readback_id: string;
        publication_receipt_id: string;
      }>(
        `SELECT * FROM geo.recover_publication_assisted_submit_uncertain(
           $1, 'simulation'
         )`,
        [ids.ctripAssistedHandoff],
      );
      expect(replayedUnattendedRecovery.rows).toEqual(firstUnattendedRecovery.rows);

      const unattendedRecovery = await adminClient.query<{
        attempt_state: string;
        handoff_state: string;
        job_state: string;
        readback_status: string;
        readback_execution_level: string;
        receipt_execution_level: string;
        receipt_outcome: string;
        retry_forbidden: boolean;
      }>(
        `SELECT handoff.state AS handoff_state, job.state AS job_state,
                attempt.state AS attempt_state, readback.status AS readback_status,
                readback.execution_level AS readback_execution_level,
                receipt.execution_level AS receipt_execution_level,
                receipt.payload ->> 'outcome' AS receipt_outcome,
                (SELECT (audit.details ->> 'retryForbidden')::boolean
                 FROM geo.audit_log AS audit
                 WHERE audit.tenant_id = handoff.tenant_id
                   AND audit.resource_type = 'publication_assisted_handoff'
                   AND audit.resource_id = handoff.id
                   AND audit.action =
                     'publication_assisted_handoff.submit_observation_recovered'
                 ORDER BY audit.created_at DESC
                 LIMIT 1) AS retry_forbidden
         FROM geo.publication_assisted_handoffs AS handoff
         JOIN geo.publication_jobs AS job
           ON job.tenant_id = handoff.tenant_id AND job.id = handoff.job_id
         JOIN geo.publication_attempts AS attempt
           ON attempt.tenant_id = handoff.tenant_id AND attempt.id = handoff.attempt_id
         JOIN geo.publication_receipts AS receipt
           ON receipt.tenant_id = handoff.tenant_id
          AND receipt.id = handoff.publication_receipt_id
         JOIN geo.publication_readbacks AS readback
           ON readback.tenant_id = handoff.tenant_id
          AND readback.id = handoff.publication_readback_id
         WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
        [tenantId, ids.ctripAssistedHandoff],
      );
      expect(unattendedRecovery.rows[0]).toEqual({
        handoff_state: "readback_pending",
        job_state: "uncertain",
        attempt_state: "uncertain",
        readback_status: "pending",
        readback_execution_level: "unattended",
        receipt_execution_level: "unattended",
        receipt_outcome: "uncertain",
        retry_forbidden: true,
      });
      await adminClient.query("ROLLBACK");
    } catch (error) {
      await adminClient.query("ROLLBACK");
      throw error;
    }

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
        { actor: SEED_IDS.sampleTravel.workerPrincipal },
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

    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at)
       SELECT tenant_id, $2, grant_id, audit_artifact_id, variant_id,
              channel_account_id, platform, execution_level, 'queued',
              'explicit-rejection-error-budget', request_hash, payload_hash,
              clock_timestamp(), clock_timestamp()
       FROM geo.publication_jobs
       WHERE tenant_id = $1 AND id = $3`,
      [tenantId, ids.rejectedDeliveryBudgetJob, ctripJobId],
    );

    await runtimeTransaction(
      async (client) => {
        await client.query("SAVEPOINT prove_candidate_target_binding");
        const candidateId = "341873248";
        const candidateUrl = `https://m.ctrip.com/webapp/you/community/detail?articleId=${candidateId}`;

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

        await client.query("SAVEPOINT charge_explicit_submit_rejection");
        await client.query(
          `SELECT * FROM geo.record_publication_assisted_submit_observation(
             $1, 'rejected', 'browser', $2::geo.sha256_hex,
             NULL, NULL, clock_timestamp()
           )`,
          [ids.ctripAssistedHandoff, "1".repeat(64)],
        );
        await client.query(
          `UPDATE geo.automation_controls
           SET mode = 'supervised', kill_switch_enabled = false,
               quota = '{"maxConcurrent":100,"perMinute":1000,"perDay":1000,"cooldownSeconds":0,"errorBudget":0}'::jsonb
           WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
          [tenantId],
        );
        await client.query(
          `UPDATE geo.circuit_breakers
           SET state = 'closed', failure_count = 0, opened_at = NULL, retry_at = NULL,
               reason = NULL, probe_attempt_id = NULL, probe_started_at = NULL,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1`,
          [tenantId],
        );
        const rejectedBudget = await client.query<ExecutionAcquisitionRow>(
          "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
          [
            ids.rejectedDeliveryBudgetJob,
            ids.rejectedDeliveryBudgetAttempt,
            "explicit-rejection-budget-worker",
          ],
        );
        expect(rejectedBudget.rows[0]).toEqual({
          allowed: false,
          reason: "quota_error_budget:tenant:*:review",
          half_open_probe: false,
        });

        await client.query("SAVEPOINT requeue_error_budget_policy");
        await client.query(
          `UPDATE geo.automation_controls
           SET quota = '{"maxConcurrent":100,"perMinute":1000,"perDay":1000,"cooldownSeconds":0,"errorBudget":0,"errorBudgetExhaustedPolicy":"requeue"}'::jsonb
           WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
          [tenantId],
        );
        const requeueBudget = await client.query<ExecutionAcquisitionRow>(
          "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
          [
            ids.rejectedDeliveryBudgetJob,
            ids.rejectedDeliveryBudgetAttempt,
            "explicit-rejection-budget-worker",
          ],
        );
        expect(requeueBudget.rows[0]).toEqual({
          allowed: false,
          reason: "quota_error_budget:tenant:*:requeue",
          half_open_probe: false,
        });
        await client.query("ROLLBACK TO SAVEPOINT requeue_error_budget_policy");

        await client.query("ROLLBACK TO SAVEPOINT charge_explicit_submit_rejection");

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
            [ids.ctripAssistedHandoff, "e".repeat(64), publicContentHash],
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
          [ids.ctripAssistedHandoff, "f".repeat(64), publicContentHash, candidateId, candidateUrl],
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
        { actor: SEED_IDS.sampleTravel.workerPrincipal },
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
      external_draft_id: "ctrip-draft-integration-002",
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

    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs DISABLE TRIGGER publication_assisted_handoffs_transition_only",
    );
    await adminClient.query(
      `UPDATE geo.publication_assisted_handoffs
       SET expires_at = created_at + interval '1 millisecond',
           submit_permit_expires_at = created_at + interval '1 millisecond',
           readback_owner_principal_id = NULL,
           readback_lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    await adminClient.query(
      `UPDATE geo.publication_jobs
       SET execution_level = 'unattended'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ctripJobId],
    );
    const expiredReadbackClaim = await runtimeTransaction(
      (client) =>
        client.query<{ handoff_id: string | null }>(
          "SELECT geo.claim_next_ctrip_unattended_readback() AS handoff_id",
        ),
      { actor: ids.ctripBridgePrincipal },
    );
    expect(expiredReadbackClaim.rows[0]?.handoff_id).toBe(ids.ctripAssistedHandoff);
    const expiredReadbackLease = await adminClient.query<{
      lease_after_handoff_expiry: boolean;
      post_submit_recovery: boolean;
    }>(
      `SELECT handoff.readback_lease_expires_at > handoff.expires_at AS lease_after_handoff_expiry,
              EXISTS (
                SELECT 1 FROM geo.audit_log AS audit
                WHERE audit.tenant_id = handoff.tenant_id
                  AND audit.resource_id = handoff.id
                  AND audit.action = 'publication_assisted_handoff.readback_claimed'
                  AND audit.details ->> 'postSubmitRecovery' = 'true'
              ) AS post_submit_recovery
       FROM geo.publication_assisted_handoffs AS handoff
       WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(expiredReadbackLease.rows[0]).toEqual({
      lease_after_handoff_expiry: true,
      post_submit_recovery: true,
    });
    await adminClient.query(
      `UPDATE geo.publication_assisted_handoffs
       SET readback_owner_principal_id = NULL,
           readback_lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    const targetedExpiredReadbackClaim = await runtimeTransaction(
      (client) =>
        client.query<{ claimed: boolean }>(
          "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
          [ids.ctripAssistedHandoff],
        ),
      { actor: ids.ctripBridgePrincipal },
    );
    expect(targetedExpiredReadbackClaim.rows[0]?.claimed).toBe(true);
    const overlappingTargetedReadbackClaim = await runtimeTransaction(
      (client) =>
        client.query<{ claimed: boolean }>(
          "SELECT geo.claim_ctrip_unattended_readback($1) AS claimed",
          [ids.ctripAssistedHandoff],
        ),
      { actor: ids.ctripBridgePrincipal },
    );
    expect(overlappingTargetedReadbackClaim.rows[0]?.claimed).toBe(false);
    const targetedExpiredReadbackLease = await adminClient.query<{
      current_owner: string | null;
      lease_after_handoff_expiry: boolean;
      targeted_claim: boolean;
    }>(
      `SELECT handoff.readback_owner_principal_id::text AS current_owner,
              handoff.readback_lease_expires_at > handoff.expires_at AS lease_after_handoff_expiry,
              EXISTS (
                SELECT 1 FROM geo.audit_log AS audit
                WHERE audit.tenant_id = handoff.tenant_id
                  AND audit.resource_id = handoff.id
                  AND audit.action = 'publication_assisted_handoff.readback_claimed'
                  AND audit.details ->> 'claimMode' = 'targeted'
              ) AS targeted_claim
       FROM geo.publication_assisted_handoffs AS handoff
       WHERE handoff.tenant_id = $1 AND handoff.id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    expect(targetedExpiredReadbackLease.rows[0]).toEqual({
      current_owner: ids.ctripBridgePrincipal,
      lease_after_handoff_expiry: true,
      targeted_claim: true,
    });
    await adminClient.query(
      `UPDATE geo.publication_assisted_handoffs
       SET expires_at = clock_timestamp() + interval '30 minutes',
           submit_permit_expires_at = clock_timestamp() + interval '5 minutes',
           readback_owner_principal_id = NULL,
           readback_lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripAssistedHandoff],
    );
    await adminClient.query(
      `UPDATE geo.publication_jobs
       SET execution_level = 'assisted'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ctripJobId],
    );
    await adminClient.query(
      "ALTER TABLE geo.publication_assisted_handoffs ENABLE TRIGGER publication_assisted_handoffs_transition_only",
    );

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
            [ids.ctripAssistedHandoff, readbackEvidenceHash, publicContentHash],
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
            [ids.ctripAssistedHandoff, readbackEvidenceHash, publicContentHash],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT reject_external_host");

        await client.query("SAVEPOINT prove_live_confirmation_contract");
        const liveExternalId = "341873249";
        const liveExternalUrl = `https://m.ctrip.com/webapp/you/community/detail?articleId=${liveExternalId}`;
        const live = await client.query<{
          state: string;
          external_id: string;
          external_url: string;
        }>(
          `SELECT * FROM geo.record_publication_assisted_readback(
             $1, 'confirmed', 'platform_readback', $2::geo.sha256_hex,
             $3::geo.sha256_hex, $4, $5,
             clock_timestamp()
           )`,
          [
            ids.ctripAssistedHandoff,
            readbackEvidenceHash,
            publicContentHash,
            liveExternalId,
            liveExternalUrl,
          ],
        );
        expect(live.rows[0]).toEqual({
          state: "confirmed",
          external_id: liveExternalId,
          external_url: liveExternalUrl,
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
          [ids.ctripAssistedHandoff, readbackEvidenceHash, publicContentHash],
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

    await adminClient.query(
      `UPDATE geo.service_principals SET status = 'disabled'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ids.ctripBridgePrincipal],
    );
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
        [tenantId, ids.mediaCampaign, SEED_IDS.sampleTravel.brand],
      );
      await client.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Governed media source', 'guide', 'draft',
                 'media-production')`,
        [tenantId, ids.mediaContentItem, ids.mediaCampaign, SEED_IDS.sampleTravel.brand],
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
        attemptId: ids.mediaAttempt,
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
          channelAccountId: SEED_IDS.sampleTravel.toutiao,
          payload: tamperedVariantPayload,
          payloadHash: sha256Canonical(tamperedVariantPayload),
        }),
      ).rejects.toThrow("unknown or changed media evidence");
      const mediaVariant = await repository.createVariant(context, {
        variantId: ids.mediaVariant,
        contentItemId: ids.mediaContentItem,
        contentVersionId: ids.mediaSuccessorVersion,
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
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
        attemptId: ids.mediaAttemptWithDifferentRights,
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

      const importedJobInput = {
        ...createJobInput,
        jobId: ids.mediaImportedJob,
        idempotencyKey: "media-customer-upload",
        requestHash: "b".repeat(64),
        providerId: "customer-upload",
        providerMode: "live" as const,
      };
      await repository.createMediaJob(context, importedJobInput);
      await repository.recordMediaAttempt(context, {
        attemptId: ids.mediaImportedAttempt,
        jobId: ids.mediaImportedJob,
        attemptNo: 1,
        status: "succeeded",
        providerId: "customer-upload",
        providerMode: "live",
        model: "direct-file-upload-v1",
        inputHash: assetSha256,
        requestHash: importedJobInput.requestHash,
        responseHash: "c".repeat(64),
        outputSha256: assetSha256,
        providerRequestId: null,
        errorCode: null,
        errorMessage: null,
        startedAt: "2026-07-15T04:05:10.000Z",
        finishedAt: "2026-07-15T04:05:20.000Z",
      });
      const importedReference = {
        ...firstReference,
        id: ids.mediaImportedAsset,
        rights: {
          basis: "tenant_owned",
          licenseName: "Tenant original photograph",
          verifiedAt: "2026-07-15T04:05:20.000Z",
        },
        provenance: {
          kind: "tenant_owned",
          evidenceSourceId: ids.mediaContentItem,
          ownershipAssertion: "The tenant created and owns this photograph.",
        },
        inspection: {
          assetSha256,
          status: "passed",
          evaluator: "server-image-structure-inspector",
          evaluatorMode: "live",
          evaluatorVersion: "1.0.0",
          responseSha256: "d".repeat(64),
          inspectedAt: "2026-07-15T04:05:20.000Z",
          ocrText: "",
          labels: ["byte-integrity:verified", "dimensions:verified", "ocr:not-run"],
        },
      };
      const importedSuccessorPayload = { ...sourcePayload, media: [importedReference] };
      const importedAsset = await repository.completeMediaJob(context, {
        jobId: ids.mediaImportedJob,
        attemptId: ids.mediaImportedAttempt,
        assetId: ids.mediaImportedAsset,
        inspectionId: ids.mediaImportedInspection,
        bindingId: ids.mediaImportedBinding,
        successorContentVersionId: ids.mediaImportedSuccessorVersion,
        storageKey,
        reference: importedReference,
        successorPayload: importedSuccessorPayload,
        successorPayloadHash: sha256Canonical(importedSuccessorPayload),
        completedAt: "2026-07-15T04:05:30.000Z",
      });
      expect(importedAsset).toMatchObject({
        id: ids.mediaImportedAsset,
        contentVersionId: ids.mediaImportedSuccessorVersion,
        reference: {
          provenance: { kind: "tenant_owned" },
          inspection: { evaluatorMode: "live" },
        },
      });

      const editedPayload = {
        ...importedSuccessorPayload,
        title: "Edited title retaining reviewed media",
        summary: "Edited summary retaining reviewed media",
        bodyMarkdown: "Edited body retaining the exact reviewed media reference.",
      };
      const editedVersion = await repository.createContentVersion(context, {
        versionId: ids.mediaEditedVersion,
        contentItemId: ids.mediaContentItem,
        summary: editedPayload.summary,
        bodyMarkdown: editedPayload.bodyMarkdown,
        payload: editedPayload,
        payloadHash: sha256Canonical(editedPayload),
      });
      expect(editedVersion).toMatchObject({
        latestVersionId: ids.mediaEditedVersion,
        latestVersion: 5,
      });
      const invalidEditedPayload = {
        ...editedPayload,
        media: [{ ...importedReference, id: ids.mediaInvalidEditedVersion }],
      };
      await expect(
        repository.createContentVersion(context, {
          versionId: ids.mediaInvalidEditedVersion,
          contentItemId: ids.mediaContentItem,
          summary: editedPayload.summary,
          bodyMarkdown: editedPayload.bodyMarkdown,
          payload: invalidEditedPayload,
          payloadHash: sha256Canonical(invalidEditedPayload),
        }),
      ).rejects.toThrow(/unknown or changed media evidence/iu);

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
        imported_provider_mode: string;
        imported_source_class: string;
        job_state: string;
        source_payload_hash: string;
        source_version: number;
        successor_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM geo.media_assets
             WHERE tenant_id = $1 AND sha256 = $2) AS asset_count,
           (SELECT count(*)::text FROM geo.media_inspections
             WHERE tenant_id = $1 AND media_asset_id IN ($3, $4, $8)) AS inspection_count,
           (SELECT count(*)::text FROM geo.content_media_bindings
             WHERE tenant_id = $1 AND media_asset_id IN ($3, $4, $8)) AS binding_count,
           (SELECT source_class FROM geo.media_assets
             WHERE tenant_id = $1 AND id = $8) AS imported_source_class,
           (SELECT provider_mode FROM geo.media_generation_jobs
             WHERE tenant_id = $1 AND id = $9) AS imported_provider_mode,
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
          ids.mediaImportedAsset,
          ids.mediaImportedJob,
        ],
      );
      expect(persisted.rows[0]).toEqual({
        asset_count: "3",
        inspection_count: "3",
        binding_count: "4",
        imported_source_class: "tenant_owned",
        imported_provider_mode: "live",
        job_state: "succeeded",
        source_version: 1,
        source_payload_hash: sha256Canonical(sourcePayload),
        successor_count: "4",
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
        [tenantId, ids.siblingCampaign, SEED_IDS.sampleTravel.brand],
      );
      await client.query(
        `INSERT INTO geo.content_items
           (tenant_id, id, campaign_id, brand_id, title, content_type, state, topic_key)
         VALUES ($1, $2, $3, $4, 'Sibling source', 'evidence', 'draft',
                 'sibling-audit-context')`,
        [tenantId, ids.siblingContentItem, ids.siblingCampaign, SEED_IDS.sampleTravel.brand],
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
            SEED_IDS.sampleTravel.toutiao,
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
        SEED_IDS.sampleTravel.toutiao,
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
      [ids.quotaJobWithoutReadback, "dry_run", "quota-without-readback", "f"],
      [ids.quotaJobAfterReadback, "dry_run", "quota-after-readback", "1"],
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
          SEED_IDS.sampleTravel.toutiao,
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
      reason: `quota_max_concurrent:account:${SEED_IDS.sampleTravel.toutiao}`,
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
      `UPDATE geo.automation_controls
       SET mode = 'shadow',
           quota = '{"maxConcurrent":10,"perMinute":100,"perDay":1,"cooldownSeconds":0,"errorBudget":100}'::jsonb,
           kill_switch_enabled = false
       WHERE tenant_id = $1
         AND ((scope_type = 'tenant' AND scope_key = '*')
           OR (scope_type = 'account' AND scope_key = $2))`,
      [tenantId, SEED_IDS.sampleTravel.toutiao],
    );

    const withoutReadback = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [
          ids.quotaJobWithoutReadback,
          ids.quotaAttemptWithoutReadback,
          "quota-without-readback-worker",
        ],
      ),
    );
    expect(withoutReadback.rows[0]).toEqual({
      allowed: true,
      reason: "allowed",
      half_open_probe: false,
    });
    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.finish_publication_execution($1, $2, true, NULL)", [
        ids.quotaJobWithoutReadback,
        ids.quotaAttemptWithoutReadback,
      ]),
    );

    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'toutiao', 'assisted', 'confirmed',
               'quota-confirmed-readback', $7, $8, clock_timestamp(), clock_timestamp(),
               clock_timestamp())`,
      [
        tenantId,
        ids.quotaConfirmedJob,
        ids.grant,
        ids.auditArtifact,
        ids.variant,
        SEED_IDS.sampleTravel.toutiao,
        "2".repeat(64),
        payloadHash,
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_attempts
         (tenant_id, id, job_id, attempt_no, state, request_hash, response_hash,
          finished_at, governance_finished_at)
       VALUES ($1, $2, $3, 1, 'succeeded', $4, $5,
               clock_timestamp(), clock_timestamp())`,
      [tenantId, ids.quotaConfirmedAttempt, ids.quotaConfirmedJob, "2".repeat(64), "3".repeat(64)],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_receipts
         (tenant_id, id, job_id, attempt_id, platform, execution_level, evidence_type,
          request_hash, response_hash, external_id, external_url, published_at,
          confirmed, payload)
       VALUES ($1, $2, $3, $4, 'toutiao', 'assisted', 'platform_readback', $5, $6,
               'quota-confirmed-external-id', 'https://example.invalid/quota-confirmed',
               clock_timestamp(), true, '{}'::jsonb)`,
      [
        tenantId,
        ids.quotaConfirmedReceipt,
        ids.quotaConfirmedJob,
        ids.quotaConfirmedAttempt,
        "2".repeat(64),
        "3".repeat(64),
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_readbacks
         (tenant_id, id, job_id, receipt_id, execution_level, status, required,
          reason, scheduled_for, completed_at)
       VALUES ($1, $2, $3, $4, 'assisted', 'succeeded', true,
               'public_readback_confirmed', clock_timestamp(), clock_timestamp())`,
      [tenantId, ids.quotaConfirmedReadback, ids.quotaConfirmedJob, ids.quotaConfirmedReceipt],
    );

    const afterReadback = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.quotaJobAfterReadback, ids.quotaAttemptAfterReadback, "quota-after-readback-worker"],
      ),
    );
    expect(afterReadback.rows[0]).toEqual({
      allowed: false,
      reason: `quota_per_day:account:${SEED_IDS.sampleTravel.toutiao}`,
      half_open_probe: false,
    });

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
      `UPDATE geo.automation_controls
       SET mode = 'unattended',
           quota = '{"maxConcurrent":10,"perMinute":20,"perDay":100,"cooldownSeconds":30,"errorBudget":10}'::jsonb
       WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
      [tenantId, SEED_IDS.sampleTravel.toutiao],
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
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{cooldownSeconds}', '0'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'account' AND scope_key = $2`,
      [tenantId, SEED_IDS.sampleTravel.toutiao],
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

    const circuitBeforeInconclusive = await adminClient.query<{
      failure_count: number;
      retry_at: Date | null;
    }>(
      `SELECT failure_count, retry_at
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    const probeInconclusive = await runtimeTransaction((client) =>
      client.query<ExecutionFinishRow>(
        "SELECT * FROM geo.finish_publication_execution($1, $2, 'uncertain'::text, $3)",
        [ids.probeJobB, ids.probeAttemptB, "PUBLICATION_UNCERTAIN"],
      ),
    );
    expect(probeInconclusive.rows[0]?.circuits_opened).toBe(0);
    const circuit = await adminClient.query<{
      state: string;
      probe_attempt_id: string | null;
      retry_at: Date | null;
      failure_count: number;
    }>(
      `SELECT state, failure_count, probe_attempt_id, retry_at
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    expect(circuit.rows[0]).toMatchObject({
      state: "half_open",
      probe_attempt_id: null,
      failure_count: circuitBeforeInconclusive.rows[0]?.failure_count,
      retry_at: circuitBeforeInconclusive.rows[0]?.retry_at,
    });

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
          SEED_IDS.sampleTravel.toutiao,
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
          SEED_IDS.sampleTravel.toutiao,
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
        SEED_IDS.sampleTravel.toutiao,
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
        email: "governance-automation@example.test",
        displayName: "Governance Automation Operator",
        passwordHash: "argon2-integration-placeholder",
        role: "automation_operator",
      });
      expect(member.capabilities).toEqual([
        "tenant:read",
        "content:read",
        "content:write",
        "audit:read",
        "audit:run",
        "publish:request",
        "receipt:read",
        "automation:execute",
      ]);
      expect(member.enabledModules).toEqual([]);
      const memberWithModules = await repository.updateMemberModules(context, {
        membershipId: ids.governanceMembership,
        enabledModules: ["ai_content", "priority_distribution"],
        reason: "Enable the governance integration canary",
      });
      expect(memberWithModules.enabledModules).toEqual(["ai_content", "priority_distribution"]);
      await expect(
        runtimeTransaction(
          (client) =>
            client.query("SELECT * FROM geo.update_tenant_member_modules($1, $2::jsonb)", [
              ids.governanceMembership,
              JSON.stringify(["trend_discovery"]),
            ]),
          { actor: ids.governanceUser },
        ),
      ).rejects.toMatchObject({ code: "42501" });
      for (const invalidModules of [
        ["unknown_module"],
        ["trend_discovery", "trend_discovery"],
        [null],
        [1],
      ]) {
        await expect(
          runtimeTransaction((client) =>
            client.query("SELECT * FROM geo.update_tenant_member_modules($1, $2::jsonb)", [
              ids.governanceMembership,
              JSON.stringify(invalidModules),
            ]),
          ),
        ).rejects.toMatchObject({ code: "22023" });
      }
      await adminClient.query("UPDATE geo.tenant_memberships SET role = 'admin' WHERE id = $1", [
        ids.governanceMembership,
      ]);
      await expect(
        runtimeTransaction(
          (client) =>
            client.query("SELECT * FROM geo.update_tenant_member_modules($1, $2::jsonb)", [
              SEED_IDS.sampleTravel.membership,
              JSON.stringify(["trend_discovery"]),
            ]),
          { actor: ids.governanceUser },
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await adminClient.query(
        "UPDATE geo.tenant_memberships SET role = 'automation_operator' WHERE id = $1",
        [ids.governanceMembership],
      );
      await expect(
        repository.updateMemberModules(context, {
          membershipId: SEED_IDS.synthetic.membership,
          enabledModules: ["trend_discovery"],
          reason: "Cross-tenant module update must stay hidden",
        }),
      ).rejects.toThrow("Member was not found");
      await expect(
        runtimeTransaction((client) => client.query("SELECT geo.require_publication_operator()"), {
          actor: ids.governanceUser,
        }),
      ).rejects.toMatchObject({ code: "42501" });
      const publisher = await repository.updateMember(context, {
        membershipId: ids.governanceMembership,
        role: "publisher",
        reason: "Move integration member to publication duty",
      });
      expect(publisher).toMatchObject({ role: "publisher", status: "active" });
      await expect(
        repository.updateMember(context, {
          membershipId: SEED_IDS.sampleTravel.membership,
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
        status: "active",
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
        "tenant_member.modules_changed",
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

      const abandonedBatchId = "30000000-0000-4000-8000-000000000202";
      const abandonedRunId = "30000000-0000-4000-8000-000000000203";
      const abandonedTargetId = "30000000-0000-4000-8000-000000000204";
      await adminClient.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
            execution_level, scheduled_for, configuration, created_by_actor_id)
         VALUES ($1, $2, $3, 'governance-delete-batch', $4, 'scheduled',
                 'dry_run', clock_timestamp(), '{}'::jsonb, $5)`,
        [tenantId, abandonedBatchId, ids.campaign, "a".repeat(64), actorId],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash, state, stage, available_at)
         VALUES ($1, $2, $3, $4, 'governance-delete-slot', 'governance-delete',
                 '{"text":"abandoned terminal target"}'::jsonb,
                 'governance-delete-run', $5, 'scheduled', 'planning', clock_timestamp())`,
        [tenantId, abandonedRunId, abandonedBatchId, ids.campaign, "b".repeat(64)],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform, state,
            variant_idempotency_key, audit_idempotency_key, publication_idempotency_key)
         VALUES ($1, $2, $3, $4, 'sohu', 'pending',
                 'governance-delete-variant', 'governance-delete-audit',
                 'governance-delete-publication')`,
        [tenantId, abandonedTargetId, abandonedRunId, ids.governanceAccount],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET state = 'failed', completed_at = clock_timestamp(),
             last_error_code = 'GOVERNANCE_DELETE_TEST',
             last_error_message = 'Terminal abandoned integration target'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, abandonedTargetId],
      );

      await repository.deleteChannelAccount(context, ids.governanceAccount);
      const archivedAccount = await adminClient.query<{
        status: string;
        archived_at: Date | null;
      }>("SELECT status, archived_at FROM geo.channel_accounts WHERE tenant_id = $1 AND id = $2", [
        tenantId,
        ids.governanceAccount,
      ]);
      expect(archivedAccount.rows).toEqual([
        expect.objectContaining({ status: "disabled", archived_at: expect.any(Date) }),
      ]);
      expect(
        (await repository.listChannelAccounts(context)).some(
          (account) => account.id === ids.governanceAccount,
        ),
      ).toBe(false);
      expect(
        (await repository.getPriorityPlatformAccountAnalytics(context)).accounts.some(
          (account) => account.channelAccountId === ids.governanceAccount,
        ),
      ).toBe(false);
      await expect(
        repository.updateChannelAccount(context, {
          channelAccountId: ids.governanceAccount,
          status: "active",
          lastVerifiedAt: "2026-08-11T02:00:00.000Z",
          reason: "A stale editor must not revive an archived account",
        }),
      ).rejects.toThrow("Archived channel account cannot be updated");

      const policyState = await adminClient.query<{ id: string; status: string }>(
        "SELECT id, status FROM geo.policy_bundles WHERE tenant_id = $1 AND status IN ('active', 'retired') ORDER BY id",
        [tenantId],
      );
      expect(policyState.rows.filter((row) => row.status === "active")).toEqual([
        { id: ids.governancePolicy, status: "active" },
      ]);
      expect(
        policyState.rows.some(
          (row) => row.id === SEED_IDS.sampleTravel.policy && row.status === "retired",
        ),
      ).toBe(true);
    } finally {
      await database.destroy();
    }
  });

  it("isolates a tenant default error budget to the publication account", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }

    await adminClient.query(
      `UPDATE geo.publication_attempts AS attempt
       SET started_at = attempt.started_at - interval '2 days',
           finished_at = CASE
             WHEN attempt.finished_at IS NULL THEN NULL
             ELSE attempt.finished_at - interval '2 days'
           END,
           governance_finished_at = CASE
             WHEN attempt.governance_finished_at IS NULL THEN NULL
             ELSE attempt.governance_finished_at - interval '2 days'
           END
       FROM geo.publication_jobs AS job
       WHERE job.tenant_id = attempt.tenant_id
         AND job.id = attempt.job_id
         AND job.channel_account_id = $1`,
      [SEED_IDS.sampleTravel.ctrip],
    );
    const otherAccountFailures = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM geo.publication_attempts AS attempt
       JOIN geo.publication_jobs AS job
         ON job.tenant_id = attempt.tenant_id AND job.id = attempt.job_id
       WHERE attempt.tenant_id = $1
         AND attempt.state = 'failed'
         AND attempt.error_code IS DISTINCT FROM 'PUBLICATION_GATE_BLOCKED'
         AND attempt.started_at >= clock_timestamp() - interval '1 day'
         AND job.channel_account_id <> $2`,
      [tenantId, SEED_IDS.sampleTravel.ctrip],
    );
    expect(Number(otherAccountFailures.rows[0]?.count)).toBeGreaterThan(0);

    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'unattended', kill_switch_enabled = false,
           quota = '{"maxConcurrent":100,"perMinute":1000,"perDay":1000,"cooldownSeconds":0,"errorBudget":1000}'::jsonb
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{errorBudget}', '0'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET state = 'closed', failure_count = 0, opened_at = NULL, retry_at = NULL,
           reason = NULL, probe_attempt_id = NULL, probe_started_at = NULL,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at)
       SELECT source.tenant_id, $2, source.grant_id, source.audit_artifact_id,
              source.variant_id, source.channel_account_id, source.platform,
              'assisted', 'queued', 'isolated-error-budget-job', source.request_hash,
              source.payload_hash, clock_timestamp(), clock_timestamp()
       FROM geo.publication_jobs AS source
       WHERE source.tenant_id = $1 AND source.grant_id = $3
       ORDER BY source.created_at
       LIMIT 1`,
      [tenantId, ids.isolatedErrorBudgetJob, ids.ctripAssistedGrant],
    );

    const isolatedAcquisition = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [ids.isolatedErrorBudgetJob, ids.isolatedErrorBudgetAttempt, "isolated-budget-worker"],
      ),
    );
    expect(isolatedAcquisition.rows[0]).toEqual({
      allowed: true,
      reason: "allowed",
      half_open_probe: false,
    });
    await runtimeTransaction((client) =>
      client.query("SELECT * FROM geo.finish_publication_execution($1, $2, true, NULL)", [
        ids.isolatedErrorBudgetJob,
        ids.isolatedErrorBudgetAttempt,
      ]),
    );
  });

  it("does not charge account configuration failures to the delivery error budget", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }

    const excludedErrorCodes = [
      "PUBLICATION_GATE_BLOCKED",
      "PUBLICATION_AUTHORIZATION_INVALID",
      "CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED",
      "BROWSER_ASSISTED_ACCOUNT_NOT_CONFIGURED",
      "CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED",
      "WORKER_ACTOR_NOT_CONFIGURED",
      "WORKER_ACTOR_NOT_AUTHORIZED",
      "WORKER_LEASE_EXPIRED",
      "FAILURE_PERSISTENCE_FAILED",
      "UNEXPECTED_ERROR",
      "UNSUPPORTED_OUTBOX_TOPIC",
      "INVALID_OUTBOX_PAYLOAD",
      "TENANT_SCOPE_MISMATCH",
      "PUBLICATION_JOB_NOT_FOUND",
      "COMPLETED_JOB_WITHOUT_RECEIPT",
      "UNCERTAIN_JOB_WITHOUT_RECEIPT",
      "PUBLICATION_SCOPE_MISMATCH",
      "PAYLOAD_HASH_MISMATCH",
      "CONNECTOR_NOT_FOUND",
      "ACCOUNT_CAPABILITY_BLOCKED",
      "MVP_DRY_RUN_ONLY",
      "DRY_RUN_PREFLIGHT_FAILED",
      "INVALID_DRY_RUN_RECEIPT",
      "CAPABILITY_EVIDENCE_INSUFFICIENT",
      "EXECUTION_LEVEL_UNSUPPORTED",
      "UNATTENDED_REQUIRES_VERIFIED_API",
      "EXTERNAL_WRITE_DISABLED",
      "PREVIEW_CANNOT_CONFIRM_PUBLICATION",
      "ASSISTED_SESSION_REQUIRED",
      "ASSISTED_CHALLENGE_REQUIRED",
      "ASSISTED_ADAPTER_DRIFT",
      "ASSISTED_SCOPE_MISMATCH",
      "ASSISTED_DRAFT_NOT_PREPARED",
      "ASSISTED_HANDOFF_BINDING_MISMATCH",
      "ASSISTED_HANDOFF_ID_MISMATCH",
      "ASSISTED_HANDOFF_EXPIRED",
      "ASSISTED_HANDOFF_CANCELLED",
      "ASSISTED_HANDOFF_FAILED",
      "ASSISTED_PREPARED_DRAFT_MISMATCH",
    ] as const;
    const excludedClassifications = await adminClient.query<{
      error_code: string;
      consumes_budget: boolean;
    }>(
      `SELECT error_code,
              geo.publication_attempt_consumes_error_budget('failed', error_code)
                AS consumes_budget
       FROM unnest($1::text[]) AS excluded(error_code)
       ORDER BY error_code`,
      [[...excludedErrorCodes]],
    );
    expect(excludedClassifications.rows).toEqual(
      [...excludedErrorCodes]
        .sort()
        .map((errorCode) => ({ error_code: errorCode, consumes_budget: false })),
    );
    const boundaryClassifications = await adminClient.query<{
      label: string;
      consumes_budget: boolean;
    }>(
      `SELECT label, geo.publication_attempt_consumes_error_budget(state, error_code)
                       AS consumes_budget
       FROM (VALUES
         ('null-code', 'failed', NULL::text),
         ('empty-code', 'failed', '   '),
         ('successful-content', 'succeeded', 'HARMFUL_CONTENT'),
         ('uncertain-submit', 'uncertain', 'PUBLICATION_UNCERTAIN'),
         ('explicit-rejection', 'uncertain', 'ASSISTED_SUBMIT_REJECTED'),
         ('harmful-content', 'failed', 'HARMFUL_CONTENT'),
         ('unknown-delivery-error', 'failed', 'PLATFORM_DELIVERY_FAILED')
       ) AS cases(label, state, error_code)
       ORDER BY label`,
    );
    expect(boundaryClassifications.rows).toEqual([
      { label: "empty-code", consumes_budget: false },
      { label: "explicit-rejection", consumes_budget: true },
      { label: "harmful-content", consumes_budget: true },
      { label: "null-code", consumes_budget: false },
      { label: "successful-content", consumes_budget: false },
      { label: "uncertain-submit", consumes_budget: false },
      { label: "unknown-delivery-error", consumes_budget: true },
    ]);

    await adminClient.query(
      `UPDATE geo.publication_attempts AS attempt
       SET started_at = attempt.started_at - interval '2 days',
           finished_at = CASE
             WHEN attempt.finished_at IS NULL THEN NULL
             ELSE attempt.finished_at - interval '2 days'
           END,
           governance_finished_at = CASE
             WHEN attempt.governance_finished_at IS NULL THEN NULL
             ELSE attempt.governance_finished_at - interval '2 days'
           END
       FROM geo.publication_jobs AS job
       WHERE job.tenant_id = attempt.tenant_id
         AND job.id = attempt.job_id
         AND job.channel_account_id = $1`,
      [SEED_IDS.sampleTravel.ctrip],
    );
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET mode = 'unattended', kill_switch_enabled = false,
           quota = '{"maxConcurrent":100,"perMinute":1000,"perDay":1000,"cooldownSeconds":0,"errorBudget":1000}'::jsonb
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.automation_controls
       SET quota = jsonb_set(quota, '{errorBudget}', '0'::jsonb)
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    await adminClient.query(
      `UPDATE geo.circuit_breakers
       SET state = 'closed', failure_count = 0, opened_at = NULL, retry_at = NULL,
           reason = NULL, probe_attempt_id = NULL, probe_started_at = NULL,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_jobs
         (tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
          platform, execution_level, state, idempotency_key, request_hash, payload_hash,
          scheduled_for, available_at, last_error_code)
       SELECT source.tenant_id, candidate.id, source.grant_id, source.audit_artifact_id,
              source.variant_id, source.channel_account_id, source.platform,
              'assisted', candidate.state, candidate.idempotency_key, source.request_hash,
              source.payload_hash, clock_timestamp(), clock_timestamp(), candidate.error_code
       FROM (
         SELECT source_job.*
         FROM geo.publication_jobs AS source_job
         WHERE source_job.tenant_id = $1 AND source_job.grant_id = $4
         ORDER BY source_job.created_at
         LIMIT 1
       ) AS source
       CROSS JOIN (VALUES
         ($2::uuid, 'permanent_failure', 'configuration-failure-job',
          'CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED'::text),
         ($3::uuid, 'queued', 'post-configuration-failure-job', NULL::text)
       ) AS candidate(id, state, idempotency_key, error_code)
       ORDER BY candidate.id`,
      [
        tenantId,
        ids.configurationFailureJob,
        ids.postConfigurationFailureJob,
        ids.ctripAssistedGrant,
      ],
    );
    await adminClient.query(
      `INSERT INTO geo.publication_attempts
         (tenant_id, id, job_id, attempt_no, state, request_hash, error_code,
          error_message, started_at, finished_at, governance_finished_at)
       SELECT tenant_id, $2, id, 1, 'failed', request_hash,
              'CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED',
              'No ready persisted Ctrip runtime binding',
              clock_timestamp(), clock_timestamp(), clock_timestamp()
       FROM geo.publication_jobs
       WHERE tenant_id = $1 AND id = $3`,
      [tenantId, ids.configurationFailureAttempt, ids.configurationFailureJob],
    );

    const acquisition = await runtimeTransaction((client) =>
      client.query<ExecutionAcquisitionRow>(
        "SELECT * FROM geo.acquire_publication_execution($1, $2, $3)",
        [
          ids.postConfigurationFailureJob,
          ids.postConfigurationFailureAttempt,
          "post-configuration-failure-worker",
        ],
      ),
    );
    expect(acquisition.rows[0]).toEqual({
      allowed: true,
      reason: "allowed",
      half_open_probe: false,
    });
    const finished = await runtimeTransaction((client) =>
      client.query<ExecutionFinishRow>(
        "SELECT * FROM geo.finish_publication_execution($1, $2, 'failed'::text, $3)",
        [
          ids.postConfigurationFailureJob,
          ids.postConfigurationFailureAttempt,
          "CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED",
        ],
      ),
    );
    expect(finished.rows[0]).toEqual({ circuits_opened: 0, circuits_closed: 0 });
    const openCircuits = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM geo.circuit_breakers
       WHERE tenant_id = $1 AND state <> 'closed'`,
      [tenantId],
    );
    expect(openCircuits.rows[0]?.count).toBe("0");
  });

  it("backfills confirmed jobs without resubmitting and preserves mixed batches", async () => {
    if (adminClient === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const confirmedSyncMigration = await readFile(
      new URL("../migrations/0071_automation_confirmed_terminal_sync.sql", import.meta.url),
      "utf8",
    );
    const deliveryEvidenceBefore = await adminClient.query<{
      attempts: string;
      readbacks: string;
      receipts: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM geo.publication_attempts
          WHERE tenant_id = $1 AND job_id = $2) AS attempts,
         (SELECT count(*)::text FROM geo.publication_receipts
          WHERE tenant_id = $1 AND job_id = $2) AS receipts,
         (SELECT count(*)::text FROM geo.publication_readbacks
          WHERE tenant_id = $1 AND job_id = $2) AS readbacks`,
      [tenantId, ids.quotaConfirmedJob],
    );

    try {
      await adminClient.query(
        `INSERT INTO geo.automation_batches
           (tenant_id, id, campaign_id, idempotency_key, request_hash, state,
            execution_level, scheduled_for, configuration, created_by_actor_id)
         SELECT job.tenant_id, $1, item.campaign_id, 'automation-confirmed-backfill-batch',
                $2, 'scheduled', job.execution_level, clock_timestamp(), '{}'::jsonb, $3
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         WHERE job.tenant_id = $4 AND job.id = $5`,
        [ids.automationBackfillBatch, "3".repeat(64), actorId, tenantId, ids.quotaConfirmedJob],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_runs
           (tenant_id, id, batch_id, campaign_id, slot_key, topic_key, brief,
            idempotency_key, request_hash)
         SELECT job.tenant_id, candidate.id, $1, item.campaign_id, candidate.slot_key,
                candidate.topic_key, '{}'::jsonb, candidate.idempotency_key,
                candidate.request_hash
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         CROSS JOIN (VALUES
           ($2::uuid, 'confirmed-slot', 'confirmed-topic',
            'automation-confirmed-backfill-run', $4::geo.sha256_hex),
           ($3::uuid, 'failed-slot', 'failed-topic',
            'automation-failed-backfill-run', $5::geo.sha256_hex)
         ) AS candidate(id, slot_key, topic_key, idempotency_key, request_hash)
         WHERE job.tenant_id = $6 AND job.id = $7`,
        [
          ids.automationBackfillBatch,
          ids.automationBackfillConfirmedRun,
          ids.automationBackfillFailedRun,
          "4".repeat(64),
          "5".repeat(64),
          tenantId,
          ids.quotaConfirmedJob,
        ],
      );
      await adminClient.query(
        `INSERT INTO geo.automation_run_targets
           (tenant_id, id, run_id, channel_account_id, platform,
            variant_idempotency_key, audit_idempotency_key, publication_idempotency_key)
         SELECT job.tenant_id, candidate.id, candidate.run_id,
                job.channel_account_id, job.platform, candidate.variant_key,
                candidate.audit_key, candidate.publication_key
         FROM geo.publication_jobs AS job
         CROSS JOIN (VALUES
           ($1::uuid, $2::uuid, 'automation-confirmed-backfill-variant',
            'automation-confirmed-backfill-audit', 'automation-confirmed-backfill-publication'),
           ($3::uuid, $4::uuid, 'automation-failed-backfill-variant',
            'automation-failed-backfill-audit', 'automation-failed-backfill-publication')
         ) AS candidate(id, run_id, variant_key, audit_key, publication_key)
         WHERE job.tenant_id = $5 AND job.id = $6`,
        [
          ids.automationBackfillConfirmedTarget,
          ids.automationBackfillConfirmedRun,
          ids.automationBackfillFailedTarget,
          ids.automationBackfillFailedRun,
          tenantId,
          ids.quotaConfirmedJob,
        ],
      );
      await adminClient.query(
        `UPDATE geo.automation_batches
         SET state = 'running', started_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationBackfillBatch],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs AS run
         SET state = 'awaiting_delivery', stage = 'delivery', attempt_count = max_attempts,
             content_item_id = item.id, content_version_id = version.id
         FROM geo.publication_jobs AS job
         JOIN geo.publication_variants AS variant
           ON variant.tenant_id = job.tenant_id AND variant.id = job.variant_id
         JOIN geo.content_versions AS version
           ON version.tenant_id = variant.tenant_id AND version.id = variant.content_version_id
         JOIN geo.content_items AS item
           ON item.tenant_id = version.tenant_id AND item.id = version.content_item_id
         WHERE run.tenant_id = job.tenant_id
           AND run.tenant_id = $1 AND run.id = $2 AND job.id = $3`,
        [tenantId, ids.automationBackfillConfirmedRun, ids.quotaConfirmedJob],
      );
      await adminClient.query(
        `UPDATE geo.automation_runs
         SET state = 'failed', stage = 'delivery', completed_at = clock_timestamp(),
             last_error_code = 'AUTOMATION_TEST_FAILURE',
             last_error_message = 'Preserved terminal test failure'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationBackfillFailedRun],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets AS target
         SET state = 'awaiting_delivery', variant_id = job.variant_id,
             audit_run_id = artifact.audit_run_id, audit_artifact_id = job.audit_artifact_id,
             publication_job_id = job.id
         FROM geo.publication_jobs AS job
         JOIN geo.audit_artifacts AS artifact
           ON artifact.tenant_id = job.tenant_id AND artifact.id = job.audit_artifact_id
         WHERE target.tenant_id = job.tenant_id
           AND target.tenant_id = $1 AND target.id = $2 AND job.id = $3`,
        [tenantId, ids.automationBackfillConfirmedTarget, ids.quotaConfirmedJob],
      );
      await adminClient.query(
        `UPDATE geo.automation_run_targets
         SET state = 'failed', completed_at = clock_timestamp(),
             last_error_code = 'AUTOMATION_TEST_FAILURE',
             last_error_message = 'Preserved terminal test failure'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationBackfillFailedTarget],
      );

      const stranded = await adminClient.query<{
        batch_state: string;
        run_state: string;
        target_state: string;
      }>(
        `SELECT batch.state AS batch_state, run.state AS run_state,
                target.state AS target_state
         FROM geo.automation_batches AS batch
         JOIN geo.automation_runs AS run
           ON run.tenant_id = batch.tenant_id AND run.batch_id = batch.id
         JOIN geo.automation_run_targets AS target
           ON target.tenant_id = run.tenant_id AND target.run_id = run.id
         WHERE batch.tenant_id = $1 AND batch.id = $2 AND run.id = $3`,
        [tenantId, ids.automationBackfillBatch, ids.automationBackfillConfirmedRun],
      );
      expect(stranded.rows[0]).toEqual({
        batch_state: "running",
        run_state: "awaiting_delivery",
        target_state: "awaiting_delivery",
      });

      await adminClient.query(confirmedSyncMigration);

      const repaired = await adminClient.query<{
        batch_state: string;
        confirmed_run_state: string;
        confirmed_target_state: string;
        failed_run_state: string;
      }>(
        `SELECT batch.state AS batch_state,
                confirmed_run.state AS confirmed_run_state,
                confirmed_target.state AS confirmed_target_state,
                failed_run.state AS failed_run_state
         FROM geo.automation_batches AS batch
         JOIN geo.automation_runs AS confirmed_run
           ON confirmed_run.tenant_id = batch.tenant_id
          AND confirmed_run.batch_id = batch.id AND confirmed_run.id = $3
         JOIN geo.automation_run_targets AS confirmed_target
           ON confirmed_target.tenant_id = confirmed_run.tenant_id
          AND confirmed_target.run_id = confirmed_run.id
         JOIN geo.automation_runs AS failed_run
           ON failed_run.tenant_id = batch.tenant_id
          AND failed_run.batch_id = batch.id AND failed_run.id = $4
         WHERE batch.tenant_id = $1 AND batch.id = $2`,
        [
          tenantId,
          ids.automationBackfillBatch,
          ids.automationBackfillConfirmedRun,
          ids.automationBackfillFailedRun,
        ],
      );
      expect(repaired.rows[0]).toEqual({
        batch_state: "partially_failed",
        confirmed_run_state: "completed",
        confirmed_target_state: "confirmed",
        failed_run_state: "failed",
      });

      const deliveryEvidenceAfter = await adminClient.query<{
        attempts: string;
        job_state: string;
        readbacks: string;
        receipts: string;
      }>(
        `SELECT job.state AS job_state,
           (SELECT count(*)::text FROM geo.publication_attempts
            WHERE tenant_id = job.tenant_id AND job_id = job.id) AS attempts,
           (SELECT count(*)::text FROM geo.publication_receipts
            WHERE tenant_id = job.tenant_id AND job_id = job.id) AS receipts,
           (SELECT count(*)::text FROM geo.publication_readbacks
            WHERE tenant_id = job.tenant_id AND job_id = job.id) AS readbacks
         FROM geo.publication_jobs AS job
         WHERE job.tenant_id = $1 AND job.id = $2`,
        [tenantId, ids.quotaConfirmedJob],
      );
      expect(deliveryEvidenceAfter.rows[0]).toEqual({
        ...deliveryEvidenceBefore.rows[0],
        job_state: "confirmed",
      });
    } finally {
      await adminClient.query(
        `DELETE FROM geo.automation_run_targets
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [ids.automationBackfillConfirmedTarget, ids.automationBackfillFailedTarget]],
      );
      await adminClient.query(
        `DELETE FROM geo.automation_runs
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [ids.automationBackfillConfirmedRun, ids.automationBackfillFailedRun]],
      );
      await adminClient.query(
        `DELETE FROM geo.automation_batches WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ids.automationBackfillBatch],
      );
    }
  });

  it("configures the explicit customer demo without enabling external publishing", async () => {
    if (adminClient === undefined || postgresPort === undefined) {
      throw new Error("PostgreSQL test client is not initialized");
    }
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databaseName}`;
    const database = createDatabase({
      connectionString,
      applicationName: "geo-customer-demo-integration",
      maxConnections: 1,
    });
    try {
      await configureCustomerDemo(database);
    } finally {
      await database.destroy();
    }

    const account = await adminClient.query<{
      capability: string;
      supported_execution_levels: string[];
      capability_evidence_refs: unknown;
    }>(
      `SELECT capability, supported_execution_levels, capability_evidence_refs
       FROM geo.channel_accounts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, SEED_IDS.sampleTravel.ctrip],
    );
    const principal = await adminClient.query<{ profile: string; capabilities: string[] }>(
      `SELECT profile, capabilities FROM geo.service_principals
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, SEED_IDS.sampleTravel.ctripBridgePrincipal],
    );
    const automationControl = await adminClient.query<{
      mode: string;
      kill_switch_enabled: boolean;
      reason: string;
    }>(
      `SELECT mode, kill_switch_enabled, reason FROM geo.automation_controls
       WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_key = '*'`,
      [tenantId],
    );
    const audit = await adminClient.query<{
      details: { externalPublishingEnabled?: boolean };
    }>(
      `SELECT details FROM geo.audit_log
       WHERE tenant_id = $1 AND request_id = 'customer-demo:ctrip:v1'`,
      [tenantId],
    );

    expect(account.rows[0]).toMatchObject({
      capability: "browser_assisted",
      supported_execution_levels: ["dry_run", "assisted"],
      capability_evidence_refs: ["customer-demo:ctrip-simulator-v1"],
    });
    expect(principal.rows[0]).toMatchObject({
      profile: "ctrip_bridge",
      capabilities: ["tenant:read", "content:read", "publish:bridge"],
    });
    expect(automationControl.rows[0]).toMatchObject({
      mode: "supervised",
      kill_switch_enabled: false,
    });
    expect(automationControl.rows[0]?.reason).toContain("final submit remains operator-confirmed");
    expect(audit.rows.at(-1)?.details.externalPublishingEnabled).toBe(false);
  });
});
