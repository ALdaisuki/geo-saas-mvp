import {
  GovernanceToolError,
  ScheduledAutomationRuntime,
  type AutomationToolRuntime,
  type ScheduledAutomationTarget,
} from "@geo/agent";
import type { ActorContext } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import type { InternalGeoApiClient } from "./api-client.js";
import type {
  AutomationGeoApiClient,
  AutomationPublicationJobView,
  AutomationRunLease,
  AutomationRunTargetView,
  AutomationRunView,
} from "./automation-api.js";
import {
  automationDraftDiversityPlan,
  createGeoAutomationProducerDependencies,
} from "./automation-producer-adapter.js";
import { PiAgentRunError, type PiAgentRunService } from "./pi-runner.js";

const ids = {
  tenantA: "10000000-0000-4000-8000-000000000001",
  tenantB: "20000000-0000-4000-8000-000000000001",
  actorA: "10000000-0000-4000-8000-000000000101",
  actorB: "20000000-0000-4000-8000-000000000101",
  batch: "10000000-0000-4000-8000-000000000201",
  run: "10000000-0000-4000-8000-000000000301",
  campaign: "10000000-0000-4000-8000-000000000401",
  brand: "10000000-0000-4000-8000-000000000501",
  target: "10000000-0000-4000-8000-000000000601",
  targetDone: "10000000-0000-4000-8000-000000000602",
  account: "10000000-0000-4000-8000-000000000701",
  content: "10000000-0000-4000-8000-000000000801",
  version: "10000000-0000-4000-8000-000000000802",
  alternateVersion: "10000000-0000-4000-8000-000000000812",
  variant: "10000000-0000-4000-8000-000000000803",
  alternateVariant: "10000000-0000-4000-8000-000000000813",
  audit: "10000000-0000-4000-8000-000000000804",
  alternateAudit: "10000000-0000-4000-8000-000000000814",
  job: "10000000-0000-4000-8000-000000000805",
  auditRun: "10000000-0000-4000-8000-000000000806",
  alternateArtifact: "10000000-0000-4000-8000-000000000815",
  alternateProviderRun: "10000000-0000-4000-8000-000000000816",
  alternateJob: "10000000-0000-4000-8000-000000000817",
};
const timestamp = "2026-07-15T00:00:00.000Z";
const draftTrace = {
  providerMode: "pi_authored" as const,
  provider: "openai-compatible",
  model: "gpt-5.6-sol",
  providerRunId: "10000000-0000-4000-8000-000000000090",
  providerRequestId: "provider-request-automation-1",
};

function principal(tenantId: string, actorId: string): ActorContext {
  return {
    tenantId,
    actorId,
    role: "automation_operator",
    capabilities: [
      "tenant:read",
      "content:read",
      "content:write",
      "audit:read",
      "audit:run",
      "publish:request",
      "receipt:read",
      "automation:execute",
    ],
    requestId: "automation-adapter-test",
  };
}

function target(
  state: AutomationRunTargetView["state"] = "pending",
  overrides: Partial<AutomationRunTargetView> = {},
): AutomationRunTargetView {
  return {
    id: ids.target,
    runId: ids.run,
    channelAccountId: ids.account,
    platform: "toutiao",
    state,
    variantId: null,
    auditRunId: null,
    auditArtifactId: null,
    publicationJobId: null,
    remediation: null,
    checkpoint: {},
    lastErrorCode: null,
    lastErrorMessage: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function run(
  actorId: string,
  targets: readonly AutomationRunTargetView[],
  overrides: Partial<AutomationRunView> = {},
): AutomationRunView {
  return {
    id: ids.run,
    batchId: ids.batch,
    campaignId: ids.campaign,
    brandId: ids.brand,
    executionLevel: "dry_run",
    automationRemediationEnabled: true,
    slotKey: "slot-1",
    topicKey: "topic-1",
    brief: "verified travel service",
    diversityRotationIndex: 0,
    state: "running",
    stage: "planning",
    availableAt: timestamp,
    attemptCount: 1,
    maxAttempts: 5,
    leaseOwner: `${actorId}:producer-1`,
    leaseExpiresAt: "2026-07-15T00:01:00.000Z",
    heartbeatAt: timestamp,
    checkpoint: {},
    contentItemId: null,
    contentVersionId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    targets,
    ...overrides,
  };
}

interface Harness {
  readonly api: InternalGeoApiClient & AutomationGeoApiClient;
  currentRun: AutomationRunView;
  readonly targetCheckpoints: Array<Record<string, unknown>>;
  readonly reconciliations: Array<Record<string, unknown>>;
  readonly publicationStates: AutomationPublicationJobView["state"][];
  readonly claimByTenant: Map<string, AutomationRunLease[]>;
}

function harness(initialRun: AutomationRunView): Harness {
  const state = {
    currentRun: initialRun,
    targetCheckpoints: [] as Array<Record<string, unknown>>,
    reconciliations: [] as Array<Record<string, unknown>>,
    publicationStates: ["preview_completed"] as AutomationPublicationJobView["state"][],
    claimByTenant: new Map<string, AutomationRunLease[]>(),
  };
  const mutation = { accepted: true, reason: "accepted", leaseExpiresAt: timestamp } as const;
  const api = {
    getTenantContext: async () => ({}),
    getArticleTemplateCatalog: async () => ({
      version: "geo.article-templates.v1" as const,
      items: [],
    }),
    getBrandAgentProfile: async () => null,
    lookupFacts: async () => ({}),
    proposeDraft: async () => ({}),
    previewVariant: async () => ({}),
    requestAudit: async () => ({}),
    requestPublication: async () => ({}),
    requestVisibilityRun: async () => ({}),
    requestMediaProduction: async () => ({}),
    getMediaJobStatus: async () => ({}),
    requestMediaSearchImport: async () => ({}),
    authorizeResourceScope: async () => true,
    claimAutomationRuns: async (actor: Readonly<ActorContext>) =>
      state.claimByTenant.get(actor.tenantId)?.splice(0, 1) ?? [],
    getAutomationRun: async () => state.currentRun,
    heartbeatAutomationRun: async () => mutation,
    checkpointAutomationDraft: async (
      _actor: Readonly<ActorContext>,
      _runId: string,
      input: {
        readonly contentItemId: string;
        readonly contentVersionId: string;
        readonly checkpoint: Readonly<Record<string, unknown>>;
      },
    ) => {
      state.currentRun = {
        ...state.currentRun,
        stage: "draft",
        checkpoint: input.checkpoint,
        contentItemId: input.contentItemId,
        contentVersionId: input.contentVersionId,
      };
      return mutation;
    },
    checkpointAutomationTarget: async (
      _actor: Readonly<ActorContext>,
      _runId: string,
      targetId: string,
      input: Record<string, unknown>,
    ) => {
      state.targetCheckpoints.push({ targetId, ...input });
      state.currentRun = {
        ...state.currentRun,
        stage: input.state === "awaiting_delivery" ? "delivery" : "targets",
        checkpoint: input.checkpoint as Readonly<Record<string, unknown>>,
        targets: state.currentRun.targets.map((item) =>
          item.id === targetId
            ? {
                ...item,
                state: input.state as AutomationRunTargetView["state"],
                variantId: (input.variantId as string | undefined) ?? item.variantId,
                auditRunId: (input.auditRunId as string | undefined) ?? item.auditRunId,
                auditArtifactId:
                  (input.auditArtifactId as string | undefined) ?? item.auditArtifactId,
                publicationJobId:
                  (input.publicationJobId as string | undefined) ?? item.publicationJobId,
                lastErrorCode: (input.errorCode as string | undefined) ?? null,
                lastErrorMessage: (input.errorMessage as string | undefined) ?? null,
              }
            : item,
        ),
      };
      return mutation;
    },
    reconcileAutomationRun: async (
      _actor: Readonly<ActorContext>,
      _runId: string,
      input: Record<string, unknown>,
    ) => {
      state.reconciliations.push(input);
      return state.currentRun;
    },
    getAutomationPublicationJob: async (_actor: Readonly<ActorContext>, jobId: string) => {
      const publicationTarget =
        state.currentRun.targets.find((item) => item.publicationJobId === jobId) ??
        state.currentRun.targets[0];
      if (publicationTarget === undefined) throw new Error("Expected a publication target");
      return {
        id: jobId,
        auditArtifactId: publicationTarget.auditArtifactId ?? ids.audit,
        variantId: publicationTarget.variantId ?? ids.variant,
        channelAccountId: publicationTarget.channelAccountId,
        platform: publicationTarget.platform,
        executionLevel: state.currentRun.executionLevel,
        state: state.publicationStates.shift() ?? "preview_completed",
        lastErrorCode: null,
        updatedAt: timestamp,
      };
    },
  } satisfies InternalGeoApiClient & AutomationGeoApiClient;
  return Object.assign(state, { api });
}

function lease(value: AutomationRunView): AutomationRunLease {
  return { ...value, tenantGate: { allowed: true, evaluatedAt: timestamp } };
}

async function claim(dependencies: ReturnType<typeof createGeoAutomationProducerDependencies>) {
  const result = await dependencies.claimRun({
    producerId: "producer-1",
    leaseDurationMs: 60_000,
    signal: new AbortController().signal,
  });
  if (result === null) throw new Error("Expected an automation claim");
  return result;
}

describe("GEO automation producer adapter", () => {
  it("rotates ten prompt strategies from the persisted content-stream index", () => {
    const plans = Array.from({ length: 10 }, (_, index) =>
      automationDraftDiversityPlan(
        run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
          diversityRotationIndex: index,
        }),
      ),
    );

    expect(new Set(plans.map((plan) => plan.articleTemplateId)).size).toBe(10);
    expect(new Set(plans.map((plan) => plan.diversityPlan.strategyId)).size).toBe(10);
    expect(new Set(plans.map((plan) => plan.diversityPlan.editorialProfile))).toEqual(
      new Set(["guide", "question_answer", "comparison", "risk_avoidance", "local_service"]),
    );
    expect(plans[0]?.diversityPlan.forbiddenAdjacentPatterns).toHaveLength(3);
    expect(new Set(plans.slice(0, 4).map((plan) => plan.diversityPlan.keywordPoolId))).toHaveLength(
      4,
    );
    expect(plans.every((plan) => plan.diversityPlan.keywordCandidates.length === 4)).toBe(true);
    expect(
      automationDraftDiversityPlan(
        run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
          diversityRotationIndex: 0,
        }),
      ),
    ).toEqual(plans[0]);
  });

  it("continues template rotation across batches without depending on the publishing account", () => {
    const first = automationDraftDiversityPlan(
      run(ids.actorA, [target("pending", { channelAccountId: ids.account })], {
        batchId: ids.batch,
        diversityRotationIndex: 9,
      }),
    );
    const second = automationDraftDiversityPlan(
      run(ids.actorA, [target("pending", { channelAccountId: ids.target })], {
        batchId: "20000000-0000-4000-8000-000000000099",
        diversityRotationIndex: 10,
      }),
    );

    expect(first.diversityPlan.rotationIndex).toBe(9);
    expect(second.diversityPlan.rotationIndex).toBe(0);
    expect(second.diversityPlan.strategyId).not.toBe(first.diversityPlan.strategyId);
  });

  it("round-robins eligible tenant principals and binds the claimed actor lease", async () => {
    const actorA = principal(ids.tenantA, ids.actorA);
    const actorB = principal(ids.tenantB, ids.actorB);
    const secondTenantRun = run(ids.actorB, [target()]);
    const state = harness(secondTenantRun);
    state.claimByTenant.set(ids.tenantB, [lease(secondTenantRun)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actorA, actorB] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    const claimed = await claim(dependencies);
    expect(claimed.tenantId).toBe(ids.tenantB);
    expect(claimed.attempt).toBe(1);
    await expect(
      dependencies.executeRun({ ...claimed, tenantId: ids.tenantA }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTOMATION_LEASE_IDENTITY_MISMATCH" });
  });

  it("isolates a revoked or broken principal while another tenant can still claim", async () => {
    const actorA = principal(ids.tenantA, ids.actorA);
    const actorB = principal(ids.tenantB, ids.actorB);
    const secondTenantRun = run(ids.actorB, [target()]);
    const state = harness(secondTenantRun);
    const api = {
      ...state.api,
      claimAutomationRuns: async (actor: Readonly<ActorContext>) => {
        if (actor.tenantId === ids.tenantA) {
          throw new Error("403 revoked password=must-never-leak");
        }
        return [lease(secondTenantRun)];
      },
    } satisfies InternalGeoApiClient & AutomationGeoApiClient;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actorA, actorB] },
      api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(claim(dependencies)).resolves.toMatchObject({ tenantId: ids.tenantB });
  });

  it("returns a classified, secret-free error when every tenant claim fails", async () => {
    const actors = [principal(ids.tenantA, ids.actorA), principal(ids.tenantB, ids.actorB)];
    const state = harness(run(ids.actorA, [target()]));
    const api = {
      ...state.api,
      claimAutomationRuns: async () => {
        throw new Error("Bearer tenant-secret password=tenant-password");
      },
    } satisfies InternalGeoApiClient & AutomationGeoApiClient;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => actors },
      api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    let captured: unknown;
    try {
      await claim(dependencies);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      code: "AUTOMATION_PRINCIPAL_CLAIM_FAILED",
      retryable: true,
    });
    expect(String(captured)).not.toContain("tenant-secret");
    expect(String(captured)).not.toContain("tenant-password");
  });

  it("retries principal discovery after a transient startup failure", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()]);
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const automationPrincipals = vi
      .fn<() => Promise<readonly Readonly<ActorContext>[]>>()
      .mockRejectedValueOnce(new Error("temporary login failure"))
      .mockResolvedValue([actor]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(claim(dependencies)).rejects.toThrow("temporary login failure");
    await expect(claim(dependencies)).resolves.toMatchObject({ tenantId: ids.tenantA });
    expect(automationPrincipals).toHaveBeenCalledTimes(2);
  });

  it("resumes variant_ready, preserves stable keys, and records only a preview completion", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const active = target("variant_ready", { variantId: ids.variant });
    const alreadyDone = target("preview_completed", {
      id: ids.targetDone,
      variantId: ids.variant,
      auditRunId: ids.auditRun,
      auditArtifactId: ids.audit,
      publicationJobId: ids.job,
    });
    const initial = run(ids.actorA, [active, alreadyDone], {
      stage: "targets",
      contentItemId: ids.content,
      contentVersionId: ids.version,
      checkpoint: {
        stage: "target",
        targetId: ids.target,
        state: "variant_ready",
        variantId: ids.variant,
        mediaProvider: "wikimedia_commons",
        mediaComplete: true,
        mediaCount: 4,
        mediaCompletedPlatforms: ["toutiao"],
      },
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const invocations: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
    const runtime: AutomationToolRuntime = {
      invoke: async (name, args) => {
        invocations.push({ name, args });
        if (name === "geo_audit_request") {
          return { auditRunId: ids.auditRun, auditArtifactId: ids.audit, status: "passed" };
        }
        if (name === "geo_publication_request") return { publicationJobId: ids.job };
        return {};
      },
    };
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => runtime,
      wait: async () => undefined,
    });
    const claimed = await claim(dependencies);

    const result = await dependencies.executeRun(claimed, new AbortController().signal);

    expect(result.targetStates[ids.target]).toBe("preview_completed");
    expect(invocations.map((call) => call.name)).not.toContain("geo_draft_proposal");
    expect(invocations.map((call) => call.name)).not.toContain("geo_variant_preview");
    expect(invocations.filter((call) => call.name === "geo_publication_request")).toHaveLength(1);
    expect(invocations.find((call) => call.name === "geo_audit_request")?.args).toMatchObject({
      idempotencyKey: `automation:${ids.run}:target:${ids.target}:audit:v1`,
    });
    expect(invocations.find((call) => call.name === "geo_publication_request")?.args).toMatchObject(
      {
        executionLevel: "dry_run",
        idempotencyKey: `automation:${ids.run}:target:${ids.target}:publication:v1`,
      },
    );
    expect(
      state.targetCheckpoints.filter((checkpoint) => checkpoint.state === "preview_completed"),
    ).toHaveLength(1);
  });

  it("forwards an audit failure message to the target checkpoint API", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("variant_ready", { variantId: ids.variant })], {
      stage: "targets",
      contentItemId: ids.content,
      contentVersionId: ids.version,
      checkpoint: {
        stage: "target",
        targetId: ids.target,
        state: "variant_ready",
        variantId: ids.variant,
        mediaProvider: "wikimedia_commons",
        mediaComplete: true,
        mediaCount: 4,
        mediaCompletedPlatforms: ["toutiao"],
      },
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({
        invoke: async (name) => {
          if (name === "geo_audit_request") {
            return {
              auditRunId: ids.auditRun,
              auditArtifactId: ids.audit,
              status: "failed",
              findings: [{ ruleId: "media.cover_required", path: "media" }],
            };
          }
          return {};
        },
      }),
    });

    await dependencies.executeRun(await claim(dependencies), new AbortController().signal);

    expect(state.targetCheckpoints.at(-1)).toMatchObject({
      targetId: ids.target,
      state: "awaiting_manual_review",
      errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
      errorMessage: "审核未通过：media.cover_required @ media",
    });
    expect(state.currentRun.targets[0]).toMatchObject({
      lastErrorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
      lastErrorMessage: "审核未通过：media.cover_required @ media",
    });
  });

  it("passes a persisted target error message into the resumed runtime input", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const persistedMessage = "公开回读未确认：平台页面仍在审核";
    const initial = run(
      ids.actorA,
      [
        target("variant_ready", {
          variantId: ids.variant,
          lastErrorCode: "PUBLIC_READBACK_UNCERTAIN",
          lastErrorMessage: persistedMessage,
        }),
      ],
      {
        stage: "targets",
        contentItemId: ids.content,
        contentVersionId: ids.version,
      },
    );
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let resumedTargets: readonly ScheduledAutomationTarget[] | undefined;
    const runSpy = vi
      .spyOn(ScheduledAutomationRuntime.prototype, "run")
      .mockImplementation(async (input) => {
        resumedTargets = input.targets;
        return {
          contentItemId: ids.content,
          contentVersionId: ids.version,
          targets: [],
        };
      });
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    try {
      await dependencies.executeRun(await claim(dependencies), new AbortController().signal);
    } finally {
      runSpy.mockRestore();
    }

    expect(resumedTargets).toEqual([
      expect.objectContaining({
        targetId: ids.target,
        state: "variant_ready",
        variantId: ids.variant,
        errorCode: "PUBLIC_READBACK_UNCERTAIN",
        errorMessage: persistedMessage,
      }),
    ]);
  });

  it("requires and checkpoints a real Pi-authored draft for unattended Ctrip", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const brief = "日本亲子行前核验的完整自动化 brief";
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
      brief,
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const checkpointAutomationDraft = vi.fn(state.api.checkpointAutomationDraft);
    const api = { ...state.api, checkpointAutomationDraft } satisfies InternalGeoApiClient &
      AutomationGeoApiClient;
    const authorAutomationDraft = vi.fn<NonNullable<PiAgentRunService["authorAutomationDraft"]>>(
      async () => ({
        ...draftTrace,
        contentItemId: ids.content,
        contentVersionId: ids.version,
      }),
    );
    const agentRunner = {
      capability: { mode: "pi" as const, provider: "openai-compatible", model: "gpt-5.6-sol" },
      run: async () => ({}),
      draftCalls: 0,
      async authorAutomationDraft(
        ...args: Parameters<NonNullable<PiAgentRunService["authorAutomationDraft"]>>
      ) {
        this.draftCalls += 1;
        return authorAutomationDraft(...args);
      },
    } satisfies PiAgentRunService & { draftCalls: number };
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api,
      agentRunner,
      runtimeForPrincipal: () => ({
        invoke: async (name) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: ids.version,
              finalContentVersionId: ids.version,
              plannedCount: 4,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") return { variantId: ids.variant };
          if (name === "geo_audit_request") {
            return { auditRunId: ids.auditRun, auditArtifactId: ids.audit, status: "failed" };
          }
          return {};
        },
      }),
    });

    await dependencies.executeRun(await claim(dependencies), new AbortController().signal);

    expect(authorAutomationDraft).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        tenantId: ids.tenantA,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief,
        articleTemplateId: expect.any(String),
        diversityPlan: expect.objectContaining({
          strategyId: expect.any(String),
          readerLens: expect.any(String),
          openingPattern: expect.any(String),
          bodyProgression: expect.any(String),
          ctaPattern: expect.any(String),
          forbiddenAdjacentPatterns: expect.any(Array),
          keywordPoolId: expect.any(String),
          keywordCandidates: expect.any(Array),
        }),
        idempotencyKey: `automation:${ids.run}:platform:ctrip_community:draft:v1`,
      }),
      expect.any(AbortSignal),
    );
    expect(agentRunner.draftCalls).toBe(1);
    expect(checkpointAutomationDraft.mock.calls[0]?.[2].checkpoint).toMatchObject({
      stage: "draft",
      providerMode: "pi_authored",
      draftProviderMode: "pi_authored",
      draftTrace,
    });
    expect(state.targetCheckpoints.at(-1)?.checkpoint).toMatchObject({
      stage: "target",
      draftProviderMode: "pi_authored",
      draftTrace,
    });
  });

  it("keeps delivery draft lineage isolated per target", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [
        target("pending", { platform: "toutiao" }),
        target("pending", {
          id: ids.targetDone,
          channelAccountId: ids.account,
          platform: "sohu",
        }),
      ],
      { executionLevel: "unattended" },
    );
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const authorAutomationDraft = vi.fn<NonNullable<PiAgentRunService["authorAutomationDraft"]>>(
      async (_principal, input) => ({
        ...draftTrace,
        providerRunId:
          input.targetPlatform === "sohu" ? ids.alternateProviderRun : draftTrace.providerRunId,
        contentItemId: ids.content,
        contentVersionId: ids.version,
      }),
    );
    const agentRunner = {
      capability: { mode: "pi" as const, provider: "openai-compatible", model: "gpt-5.6-sol" },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({
        invoke: async (name, args) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: args.contentVersionId,
              finalContentVersionId: args.contentVersionId,
              plannedCount: 4,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") {
            return { variantId: args.platform === "sohu" ? ids.alternateVariant : ids.variant };
          }
          if (name === "geo_audit_request") {
            return { auditRunId: ids.auditRun, auditArtifactId: ids.audit, status: "passed" };
          }
          if (name === "geo_publication_request") {
            return {
              publicationRequestId:
                args.variantId === ids.alternateVariant ? ids.alternateJob : ids.job,
            };
          }
          return {};
        },
      }),
    });

    await dependencies.executeRun(await claim(dependencies), new AbortController().signal);

    expect(authorAutomationDraft).toHaveBeenCalledTimes(2);
    const deliveryCheckpoints = state.targetCheckpoints.filter(
      (entry) => entry.state === "awaiting_delivery",
    );
    expect(deliveryCheckpoints).toHaveLength(2);
    const traceByTarget = Object.fromEntries(
      deliveryCheckpoints.map((entry) => [
        entry.targetId,
        (entry.checkpoint as Readonly<Record<string, unknown>>).draftTrace,
      ]),
    );
    expect(traceByTarget).toEqual({
      [ids.target]: expect.objectContaining({ providerRunId: draftTrace.providerRunId }),
      [ids.targetDone]: expect.objectContaining({ providerRunId: ids.alternateProviderRun }),
    });
  });

  it("rejects a well-formed draft trace not produced by this lease", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "toutiao" })], {
      executionLevel: "dry_run",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const foreignTrace = {
      ...draftTrace,
      providerRunId: "20000000-0000-4000-8000-000000000099",
    };
    const runSpy = vi
      .spyOn(ScheduledAutomationRuntime.prototype, "run")
      .mockImplementation(async (_input, checkpoint) => {
        await checkpoint({
          stage: "draft",
          contentItemId: ids.content,
          contentVersionId: ids.version,
          providerMode: "pi_authored",
          draftTrace: foreignTrace,
        });
        return { contentItemId: ids.content, contentVersionId: ids.version, targets: [] };
      });
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    try {
      await expect(
        dependencies.executeRun(await claim(dependencies), new AbortController().signal),
      ).rejects.toMatchObject({ code: "AUTOMATION_PI_DRAFT_TRACE_INVALID" });
    } finally {
      runSpy.mockRestore();
    }
  });

  it("ends a stalled Pi draft when the automation execution is aborted", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let authorSignal: AbortSignal | undefined;
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn((_principal, _input, signal) => {
        authorSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });
    const controller = new AbortController();
    let outcome: unknown;
    void dependencies
      .executeRun(await claim(dependencies), controller.signal)
      .catch((error: unknown) => {
        outcome = error;
      });

    await vi.waitFor(() => expect(authorSignal).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(outcome).toBeDefined());

    expect(authorSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({ name: "AbortError" });
  });

  it("times out a stalled Pi draft and marks the attempt retryable", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let authorSignal: AbortSignal | undefined;
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn((_principal, _input, signal) => {
        authorSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      draftTimeoutMs: 10,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTOMATION_PI_DRAFT_TIMEOUT", retryable: true });
    expect(authorSignal?.aborted).toBe(true);
  });

  it("surfaces a provider timeout as a stable automation error", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn(async () => {
        throw new PiAgentRunError({ providerFailureClass: "timeout" });
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "AUTOMATION_PI_PROVIDER_TIMEOUT",
      retryable: true,
      uncertain: true,
    });
  });

  it("does not misclassify a Pi tool guard as a provider failure", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn(async () => {
        throw new PiAgentRunError({
          diagnosticReason: "tool_guard",
          toolCallCount: 4,
          lastToolName: "geo_fact_lookup",
        });
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "AUTOMATION_PI_TOOL_GUARD",
      retryable: false,
      uncertain: false,
    });
  });

  it("surfaces repeated authored-draft validation as a draft input failure", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const authorAutomationDraft = vi.fn(async () => {
      throw new PiAgentRunError({
        diagnosticReason: "draft_input",
        failureCode: "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
        toolCallCount: 11,
        lastToolName: "geo_draft_proposal",
      });
    });
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "AUTOMATION_PI_DRAFT_INPUT_INVALID",
      retryable: false,
      uncertain: false,
    });
    expect(authorAutomationDraft).toHaveBeenCalledTimes(3);
  });

  it("self-heals a draft input failure with a fresh session and rotated template", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()], { brief: "日本服务选择" });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let draftCount = 0;
    const authorAutomationDraft = vi.fn(async (_principal, input) => {
      void _principal;
      draftCount += 1;
      if (draftCount === 1) {
        throw new PiAgentRunError({
          diagnosticReason: "draft_input",
          failureCode: "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
          toolCallCount: 11,
          lastToolName: "geo_draft_proposal",
        });
      }
      return {
        ...draftTrace,
        providerRunId: ids.alternateProviderRun,
        contentItemId: ids.content,
        contentVersionId: ids.version,
        articleTemplateId: input.articleTemplateId,
      };
    });
    const agentRunner = {
      capability: { mode: "pi" as const, provider: "openai-compatible", model: "gpt-5.6-sol" },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({
        invoke: async (name, args) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: args.contentVersionId,
              finalContentVersionId: args.contentVersionId,
              plannedCount: 4,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") {
            return { variantId: ids.variant };
          }
          if (name === "geo_audit_request") {
            return {
              auditRunId: ids.auditRun,
              auditArtifactId: ids.audit,
              status: "passed",
              findings: [],
            };
          }
          if (name === "geo_publication_request") return { publicationRequestId: ids.job };
          return {};
        },
      }),
    });

    await dependencies.executeRun(await claim(dependencies), new AbortController().signal);

    expect(authorAutomationDraft).toHaveBeenCalledTimes(2);
    expect(authorAutomationDraft.mock.calls[1]?.[1]).toMatchObject({
      articleTemplateId: automationDraftDiversityPlan(initial, 1).articleTemplateId,
    });
    expect(state.currentRun.checkpoint).toMatchObject({
      draftTrace: { providerRunId: ids.alternateProviderRun },
    });
  });

  it("keeps the alternate author available for manual remediation of an existing draft", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [
        target("pending", {
          remediation: {
            taskId: `${ids.run}:${ids.target}:manual-remediation`,
            scope: "target",
            mode: "manual",
            attempt: 2,
            maxAttempts: 2,
            reasonCodes: ["duplicate.near"],
            actions: ["rebuild_article", "replace_media"],
          },
        }),
      ],
      {
        executionLevel: "unattended",
        contentItemId: ids.content,
        contentVersionId: ids.version,
        checkpoint: { draftTrace },
      },
    );
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const authorAutomationDraft = vi.fn(async () => ({
      ...draftTrace,
      providerRunId: ids.alternateProviderRun,
      contentItemId: ids.content,
      contentVersionId: ids.alternateVersion,
    }));
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({
        invoke: async (name, args) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: args.contentVersionId,
              finalContentVersionId: ids.alternateVersion,
              plannedCount: 4,
              initialMediaCount: 0,
              totalMediaCount: 4,
              complete: true,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") return { variantId: ids.alternateVariant };
          if (name === "geo_audit_request") {
            return {
              auditRunId: ids.alternateAudit,
              auditArtifactId: ids.alternateArtifact,
              status: "passed",
              findings: [],
            };
          }
          if (name === "geo_publication_request") return { publicationRequestId: ids.alternateJob };
          return {};
        },
      }),
    });

    const result = await dependencies.executeRun(
      await claim(dependencies),
      new AbortController().signal,
    );

    expect(authorAutomationDraft).toHaveBeenCalled();
    expect(result.targetStates[ids.target]).toBe("preview_completed");
    expect(state.targetCheckpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: ids.target,
          state: "preview_completed",
          publicationJobId: ids.alternateJob,
        }),
      ]),
    );
  });

  it("terminates the final attempt with the provider root cause", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
      attemptCount: 5,
      maxAttempts: 5,
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn(async () => {
        throw new PiAgentRunError({ providerFailureClass: "timeout" });
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });
    const claimed = await claim(dependencies);
    const failure = { kind: "uncertain" as const, code: "AUTOMATION_PI_PROVIDER_TIMEOUT" };

    await expect(
      dependencies.executeRun(claimed, new AbortController().signal),
    ).rejects.toMatchObject({ code: failure.code });
    await expect(
      dependencies.reconcile({
        producerId: "producer-1",
        run: claimed,
        failure,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ disposition: "confirmed_failed" });
  });

  it("surfaces an unstructured draft transport failure as a provider network error", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "AUTOMATION_PI_PROVIDER_NETWORK",
      retryable: true,
      uncertain: true,
    });
  });

  it("allows the alternate Pi trace when a duplicate audit triggers one template retry", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()], { brief: "日本服务选择" });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let draftCount = 0;
    let auditCount = 0;
    const authorAutomationDraft = vi.fn(async (_principal: unknown, _input: unknown) => {
      void _principal;
      void _input;
      draftCount += 1;
      if (draftCount === 2) {
        throw new PiAgentRunError({
          diagnosticReason: "draft_input",
          failureCode: "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
          toolCallCount: 11,
          lastToolName: "geo_draft_proposal",
        });
      }
      return {
        ...(draftCount === 1
          ? draftTrace
          : { ...draftTrace, providerRunId: ids.alternateProviderRun }),
        contentItemId: ids.content,
        contentVersionId: draftCount === 1 ? ids.version : ids.alternateVersion,
        articleTemplateId: draftCount === 1 ? "direct-answer-brief" : "comparison-matrix",
      };
    });
    const agentRunner = {
      capability: { mode: "pi" as const, provider: "openai-compatible", model: "gpt-5.6-sol" },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      agentRunner,
      runtimeForPrincipal: () => ({
        invoke: async (name, args) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: args.contentVersionId,
              finalContentVersionId: args.contentVersionId,
              plannedCount: 4,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") {
            return { variantId: draftCount === 1 ? ids.variant : ids.alternateVariant };
          }
          if (name === "geo_audit_request") {
            auditCount += 1;
            return auditCount === 1
              ? {
                  auditRunId: ids.auditRun,
                  auditArtifactId: ids.audit,
                  status: "failed",
                  findings: [{ ruleId: "duplicate.near" }],
                }
              : {
                  auditRunId: ids.alternateAudit,
                  auditArtifactId: ids.alternateArtifact,
                  status: "passed",
                  findings: [],
                };
          }
          if (name === "geo_publication_request") return { publicationRequestId: ids.job };
          return {};
        },
      }),
    });

    await dependencies.executeRun(await claim(dependencies), new AbortController().signal);

    expect(authorAutomationDraft).toHaveBeenCalledTimes(3);
    expect(authorAutomationDraft.mock.calls[1]?.[1]).toMatchObject({
      articleTemplateId: automationDraftDiversityPlan(initial, 1).articleTemplateId,
      idempotencyKey: `automation:${ids.run}:target:${ids.target}:remediation:1:draft:v1`,
    });
    expect(authorAutomationDraft.mock.calls[2]?.[1]).toMatchObject({
      articleTemplateId: automationDraftDiversityPlan(initial, 2).articleTemplateId,
    });
    expect(state.targetCheckpoints.at(-1)?.checkpoint).toMatchObject({
      stage: "delivery",
      draftTrace: { providerRunId: ids.alternateProviderRun },
    });
  });

  it("fails closed when unattended drafting has no real Pi author", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTOMATION_PI_DRAFT_AUTHOR_UNAVAILABLE" });
  });

  it("rejects unattended resume records that contain only the legacy Pi marker", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
      stage: "draft",
      checkpoint: { stage: "draft", draftProviderMode: "pi_authored" },
      contentItemId: ids.content,
      contentVersionId: ids.version,
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(
      dependencies.executeRun(await claim(dependencies), new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTOMATION_PI_DRAFT_TRACE_INVALID" });
  });

  it("rejects a malformed persisted Pi trace while claiming the lease", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()], {
      checkpoint: {
        stage: "draft",
        draftTrace: { ...draftTrace, providerRunId: "not-a-uuid" },
      },
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    await expect(claim(dependencies)).rejects.toMatchObject({
      code: "AUTOMATION_PI_DRAFT_TRACE_INVALID",
    });
  });

  it("does not publish an unaccepted draft trace through a later heartbeat", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const heartbeatInputs: Array<Record<string, unknown>> = [];
    const api = {
      ...state.api,
      checkpointAutomationDraft: async () => ({
        accepted: false,
        reason: "lease_lost",
        leaseExpiresAt: null,
      }),
      heartbeatAutomationRun: async (
        _actor: Readonly<ActorContext>,
        _runId: string,
        input: Record<string, unknown>,
      ) => {
        heartbeatInputs.push(input);
        return { accepted: true, reason: "accepted", leaseExpiresAt: timestamp };
      },
    } satisfies InternalGeoApiClient & AutomationGeoApiClient;
    const agentRunner = {
      capability: { mode: "pi" as const, provider: draftTrace.provider, model: draftTrace.model },
      run: async () => ({}),
      authorAutomationDraft: async () => ({
        ...draftTrace,
        contentItemId: ids.content,
        contentVersionId: ids.version,
      }),
    } satisfies PiAgentRunService;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api,
      agentRunner,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });
    const claimed = await claim(dependencies);

    await expect(
      dependencies.executeRun(claimed, new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTOMATION_LEASE_REJECTED" });
    await expect(
      dependencies.heartbeat({
        producerId: "producer-1",
        runId: claimed.runId,
        leaseToken: claimed.leaseToken,
        leaseDurationMs: 60_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ leaseValid: true });
    expect(heartbeatInputs).toEqual([
      expect.objectContaining({ stage: "planning", checkpoint: {} }),
    ]);
  });

  it("preserves completed media across a retryable publication failure and skips media on retry", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target("pending", { platform: "ctrip_community" })], {
      executionLevel: "unattended",
      stage: "draft",
      checkpoint: { stage: "draft", draftProviderMode: "pi_authored", draftTrace },
      contentItemId: ids.content,
      contentVersionId: ids.version,
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const firstAttemptInvoke = vi.fn<AutomationToolRuntime["invoke"]>(async (name) => {
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: ids.version,
          finalContentVersionId: ids.version,
          plannedCount: 5,
          imported: [{}, {}, {}, {}, {}],
        };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variant };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditRun, auditArtifactId: ids.audit, status: "passed" };
      }
      if (name === "geo_publication_request") {
        throw new GovernanceToolError("audit_pre_check", new Error("service updating"), {
          retryable: true,
        });
      }
      return {};
    });
    const firstAttempt = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: firstAttemptInvoke }),
    });

    await expect(
      firstAttempt.executeRun(await claim(firstAttempt), new AbortController().signal),
    ).rejects.toMatchObject({ code: "GOVERNANCE_TOOL_FAILED", retryable: true });

    expect(state.currentRun.targets[0]).toMatchObject({
      state: "variant_ready",
      variantId: ids.variant,
    });
    expect(state.currentRun.checkpoint).toMatchObject({
      stage: "target",
      mediaProvider: "wikimedia_commons",
      mediaComplete: true,
      mediaCount: 5,
      mediaCompletedPlatforms: ["ctrip_community"],
    });

    const retryRun = {
      ...state.currentRun,
      attemptCount: 2,
      leaseOwner: `${ids.actorA}:producer-1`,
    } satisfies AutomationRunView;
    state.currentRun = retryRun;
    state.claimByTenant.set(ids.tenantA, [lease(retryRun)]);
    state.publicationStates.splice(0, state.publicationStates.length, "confirmed");
    const retryInvoke = vi.fn<AutomationToolRuntime["invoke"]>(async (name) => {
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditRun, auditArtifactId: ids.audit, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationJobId: ids.job };
      return {};
    });
    const retryAttempt = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: retryInvoke }),
      wait: async () => undefined,
    });

    const result = await retryAttempt.executeRun(
      await claim(retryAttempt),
      new AbortController().signal,
    );

    expect(result.targetStates[ids.target]).toBe("confirmed");
    expect(retryInvoke).not.toHaveBeenCalledWith("geo_media_search_import", expect.anything());
    expect(retryInvoke).not.toHaveBeenCalledWith("geo_variant_preview", expect.anything());
    expect(retryInvoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        executionLevel: "unattended",
        idempotencyKey: `automation:${ids.run}:target:${ids.target}:publication:v1`,
      }),
    );
    expect(state.targetCheckpoints.at(-1)?.checkpoint).toMatchObject({
      draftTrace,
      mediaProvider: "wikimedia_commons",
      mediaComplete: true,
      mediaCount: 5,
    });
  });
  it("serializes a target checkpoint before a concurrent heartbeat reads the new stage", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()], {
      stage: "draft",
      contentItemId: ids.content,
      contentVersionId: ids.version,
    });
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    let releaseCheckpoint: (() => void) | undefined;
    let markCheckpointEntered: (() => void) | undefined;
    const checkpointEntered = new Promise<void>((resolvePromise) => {
      markCheckpointEntered = resolvePromise;
    });
    const checkpointGate = new Promise<void>((resolvePromise) => {
      releaseCheckpoint = resolvePromise;
    });
    const heartbeatStages: string[] = [];
    let firstCheckpoint = true;
    const api = {
      ...state.api,
      checkpointAutomationTarget: async (
        ...args: Parameters<AutomationGeoApiClient["checkpointAutomationTarget"]>
      ) => {
        if (firstCheckpoint) {
          firstCheckpoint = false;
          markCheckpointEntered?.();
          await checkpointGate;
        }
        return state.api.checkpointAutomationTarget(...args);
      },
      heartbeatAutomationRun: async (
        ...args: Parameters<AutomationGeoApiClient["heartbeatAutomationRun"]>
      ) => {
        heartbeatStages.push(args[2].stage);
        return state.api.heartbeatAutomationRun(...args);
      },
    } satisfies InternalGeoApiClient & AutomationGeoApiClient;
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api,
      runtimeForPrincipal: () => ({
        invoke: async (name, args) => {
          if (name === "geo_media_search_import") {
            return {
              provider: "wikimedia_commons",
              sourceContentVersionId: args.contentVersionId,
              finalContentVersionId: args.contentVersionId,
              plannedCount: 4,
              imported: [{}, {}, {}, {}],
            };
          }
          if (name === "geo_variant_preview") return { variantId: ids.variant };
          if (name === "geo_audit_request") {
            return {
              auditRunId: ids.auditRun,
              auditArtifactId: ids.audit,
              status: "failed",
            };
          }
          return {};
        },
      }),
    });
    const claimed = await claim(dependencies);
    const execution = dependencies.executeRun(claimed, new AbortController().signal);
    await checkpointEntered;
    const heartbeat = dependencies.heartbeat({
      producerId: "producer-1",
      runId: claimed.runId,
      leaseToken: claimed.leaseToken,
      leaseDurationMs: 60_000,
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    expect(heartbeatStages).toEqual([]);

    releaseCheckpoint?.();
    await Promise.all([execution, heartbeat]);

    expect(heartbeatStages).toEqual(["targets"]);
    expect(state.targetCheckpoints.map((checkpoint) => checkpoint.state)).toEqual([
      "variant_ready",
      "awaiting_manual_review",
    ]);
  });

  it("observes awaiting delivery once, releases the slot, and resumes on a later claim", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [
        target("awaiting_delivery", {
          variantId: ids.variant,
          auditRunId: ids.auditRun,
          auditArtifactId: ids.audit,
          publicationJobId: ids.job,
        }),
      ],
      {
        stage: "delivery",
        contentItemId: ids.content,
        contentVersionId: ids.version,
      },
    );
    const state = harness(initial);
    state.publicationStates.splice(
      0,
      state.publicationStates.length,
      "queued",
      "preview_completed",
    );
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const invoke = vi.fn<AutomationToolRuntime["invoke"]>(async () => ({}));
    const wait = vi.fn(async () => undefined);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke }),
      wait,
    });

    const firstClaim = await claim(dependencies);
    const firstResult = await dependencies.executeRun(firstClaim, new AbortController().signal);

    expect(firstResult.targetStates[ids.target]).toBe("awaiting_delivery");
    expect(wait).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await dependencies.checkpoint({
      producerId: "producer-1",
      runId: firstClaim.runId,
      leaseToken: firstClaim.leaseToken,
      state: "succeeded",
      result: firstResult,
    });

    const reclaimed = {
      ...state.currentRun,
      attemptCount: 2,
      leaseOwner: `${ids.actorA}:producer-1`,
    } satisfies AutomationRunView;
    state.currentRun = reclaimed;
    state.claimByTenant.set(ids.tenantA, [lease(reclaimed)]);

    const secondResult = await dependencies.executeRun(
      await claim(dependencies),
      new AbortController().signal,
    );

    expect(secondResult.targetStates[ids.target]).toBe("preview_completed");
    expect(wait).not.toHaveBeenCalled();
  });

  it("accepts a confirmed unattended Ctrip readback with the bound execution level", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [
        target("awaiting_delivery", {
          platform: "ctrip_community",
          variantId: ids.variant,
          auditRunId: ids.auditRun,
          auditArtifactId: ids.audit,
          publicationJobId: ids.job,
        }),
      ],
      {
        executionLevel: "unattended",
        stage: "delivery",
        checkpoint: {
          stage: "target",
          draftProviderMode: "pi_authored",
          draftTrace: { ...draftTrace, providerRequestId: null },
        },
        contentItemId: ids.content,
        contentVersionId: ids.version,
      },
    );
    const state = harness(initial);
    state.publicationStates.splice(0, state.publicationStates.length, "confirmed");
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    const result = await dependencies.executeRun(
      await claim(dependencies),
      new AbortController().signal,
    );

    expect(result.targetStates[ids.target]).toBe("confirmed");
    expect(state.targetCheckpoints.at(-1)).toMatchObject({
      state: "confirmed",
      publicationJobId: ids.job,
      checkpoint: {
        draftTrace: { ...draftTrace, providerRequestId: null },
      },
    });
  });

  it("marks a failed delivery separately from a pre-gate run failure", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [
        target("awaiting_delivery", {
          variantId: ids.variant,
          auditRunId: ids.auditRun,
          auditArtifactId: ids.audit,
          publicationJobId: ids.job,
        }),
      ],
      { contentItemId: ids.content, contentVersionId: ids.version, stage: "delivery" },
    );
    const state = harness(initial);
    state.publicationStates.splice(0, state.publicationStates.length, "permanent_failure");
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({ invoke: async () => ({}) }),
    });

    const result = await dependencies.executeRun(
      await claim(dependencies),
      new AbortController().signal,
    );
    expect(result.targetStates[ids.target]).toBe("delivery_failed");
    expect(state.targetCheckpoints.at(-1)).toMatchObject({
      state: "delivery_failed",
      errorCode: "AUTOMATION_PUBLICATION_PERMANENT_FAILURE",
    });
  });

  it("fails unfinished targets before reconciling a permanent pre-variant error", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(ids.actorA, [target()]);
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const failure = { code: "NO_RELEVANT_VERIFIED_FACTS", retryable: false };
    const dependencies = createGeoAutomationProducerDependencies({
      sessions: { automationPrincipals: async () => [actor] },
      api: state.api,
      runtimeForPrincipal: () => ({
        invoke: async (name) => {
          if (name === "geo_draft_proposal") throw failure;
          return {};
        },
      }),
    });
    const claimed = await claim(dependencies);
    await expect(dependencies.executeRun(claimed, new AbortController().signal)).rejects.toBe(
      failure,
    );

    await dependencies.checkpoint({
      producerId: "producer-1",
      runId: claimed.runId,
      leaseToken: claimed.leaseToken,
      state: "failed",
      failure: { kind: "permanent", code: failure.code },
    });

    expect(state.targetCheckpoints.at(-1)).toMatchObject({
      state: "failed",
      errorCode: failure.code,
    });
    expect(state.reconciliations.at(-1)).toMatchObject({ errorCode: failure.code });
  });
});
