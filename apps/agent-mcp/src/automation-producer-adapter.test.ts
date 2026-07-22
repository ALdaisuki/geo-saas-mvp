import type { AutomationToolRuntime } from "@geo/agent";
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
import { createGeoAutomationProducerDependencies } from "./automation-producer-adapter.js";
import type { PiAgentRunService } from "./pi-runner.js";

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
  variant: "10000000-0000-4000-8000-000000000803",
  audit: "10000000-0000-4000-8000-000000000804",
  job: "10000000-0000-4000-8000-000000000805",
  auditRun: "10000000-0000-4000-8000-000000000806",
};
const timestamp = "2026-07-15T00:00:00.000Z";

function principal(tenantId: string, actorId: string): ActorContext {
  return {
    tenantId,
    actorId,
    role: "owner",
    capabilities: [
      "automation:execute",
      "tenant:read",
      "content:read",
      "content:write",
      "audit:run",
      "publish:request",
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
    slotKey: "slot-1",
    topicKey: "topic-1",
    brief: "verified travel service",
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
    getAutomationPublicationJob: async () => {
      const publicationTarget = state.currentRun.targets.find(
        (item) => item.publicationJobId === ids.job,
      ) ?? state.currentRun.targets[0];
      if (publicationTarget === undefined) throw new Error("Expected a publication target");
      return {
        id: ids.job,
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

  it("requires and checkpoints a real Pi-authored draft for unattended Ctrip", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const brief = "日本亲子行前核验的完整自动化 brief";
    const initial = run(
      ids.actorA,
      [target("pending", { platform: "ctrip_community" })],
      { executionLevel: "unattended", brief },
    );
    const state = harness(initial);
    state.claimByTenant.set(ids.tenantA, [lease(initial)]);
    const checkpointAutomationDraft = vi.fn(state.api.checkpointAutomationDraft);
    const api = { ...state.api, checkpointAutomationDraft } satisfies InternalGeoApiClient &
      AutomationGeoApiClient;
    const authorAutomationDraft = vi.fn(async () => ({
      providerMode: "pi_authored" as const,
      provider: "openai-compatible",
      model: "grok-4.5",
      contentItemId: ids.content,
      contentVersionId: ids.version,
    }));
    const agentRunner = {
      capability: { mode: "pi" as const, provider: "openai-compatible", model: "grok-4.5" },
      run: async () => ({}),
      authorAutomationDraft,
    } satisfies PiAgentRunService;
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
        idempotencyKey: `automation:${ids.run}:draft:v1`,
      }),
      expect.any(AbortSignal),
    );
    expect(checkpointAutomationDraft.mock.calls[0]?.[2].checkpoint).toMatchObject({
      stage: "draft",
      providerMode: "pi_authored",
      draftProviderMode: "pi_authored",
    });
    expect(state.targetCheckpoints.at(-1)?.checkpoint).toMatchObject({
      stage: "target",
      draftProviderMode: "pi_authored",
    });
  });

  it("fails closed when unattended drafting has no real Pi author", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [target("pending", { platform: "ctrip_community" })],
      { executionLevel: "unattended" },
    );
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


  it("preserves completed media across a retryable publication failure and skips media on retry", async () => {
    const actor = principal(ids.tenantA, ids.actorA);
    const initial = run(
      ids.actorA,
      [target("pending", { platform: "ctrip_community" })],
      {
        executionLevel: "unattended",
        stage: "draft",
        checkpoint: { stage: "draft", draftProviderMode: "pi_authored" },
        contentItemId: ids.content,
        contentVersionId: ids.version,
      },
    );
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
        throw Object.assign(new Error("governance temporarily unavailable"), {
          code: "GOVERNANCE_UNAVAILABLE",
          status: 503,
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
    ).rejects.toMatchObject({ code: "GOVERNANCE_UNAVAILABLE", status: 503 });

    expect(state.currentRun.targets[0]).toMatchObject({
      state: "variant_ready",
      variantId: ids.variant,
    });
    expect(state.currentRun.checkpoint).toMatchObject({
      stage: "target",
      mediaProvider: "wikimedia_commons",
      mediaComplete: true,
      mediaCount: 5,
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
        invoke: async (name) => {
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
      "audit_failed",
    ]);
  });

  it("reclaims awaiting_delivery by polling only the bound job", async () => {
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

    const result = await dependencies.executeRun(
      await claim(dependencies),
      new AbortController().signal,
    );

    expect(result.targetStates[ids.target]).toBe("preview_completed");
    expect(wait).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
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
    });
  });

  it("marks a failed delivery as failed without calling it a publication", async () => {
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
    expect(result.targetStates[ids.target]).toBe("failed");
    expect(state.targetCheckpoints.at(-1)).toMatchObject({
      state: "failed",
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
