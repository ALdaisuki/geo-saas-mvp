import { randomUUID } from "node:crypto";

import {
  ScheduledAutomationRuntime,
  type AutomationToolRuntime,
  type PlasticPromiseGovernanceClient,
  type ScheduledAutomationCheckpoint,
} from "@geo/agent";
import type { ActorContext, AutomationRunStage } from "@geo/contracts";

import type { InternalGeoApiClient } from "./api-client.js";
import type {
  AutomationGeoApiClient,
  AutomationPublicationJobView,
  AutomationRunLease,
  AutomationRunTargetView,
  AutomationRunView,
} from "./automation-api.js";
import type {
  AutomationCheckpoint,
  AutomationFailure,
  AutomationProducerDependencies,
  AutomationReconciliation,
  AutomationRunClaim,
} from "./automation-producer.js";
import { createGovernedAgentRuntime } from "./pi-runner.js";

const TERMINAL_TARGET_STATES = new Set([
  "audit_failed",
  "preview_completed",
  "confirmed",
  "blocked",
  "failed",
  "cancelled",
]);
const ACTIVE_DELIVERY_STATES = new Set([
  "queued",
  "dispatching",
  "retry_wait",
  "uncertain",
  "reconciling",
]);
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_.-]{0,99}$/u;
const PRINCIPAL_DISCOVERY_TTL_MS = 60_000;

export interface AutomationPrincipalRegistry {
  automationPrincipals(): Promise<readonly Readonly<ActorContext>[]>;
}

export interface GeoAutomationRunResult {
  readonly runId: string;
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
  readonly targetStates: Readonly<Record<string, string>>;
}

export interface GeoAutomationProducerAdapterOptions {
  readonly sessions: AutomationPrincipalRegistry;
  readonly api: InternalGeoApiClient & AutomationGeoApiClient;
  readonly governance?: PlasticPromiseGovernanceClient;
  readonly runtimeForPrincipal?: (principal: Readonly<ActorContext>) => AutomationToolRuntime;
  readonly deliveryPollIntervalMs?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
}

interface LeaseBinding {
  readonly principal: Readonly<ActorContext>;
  readonly producerId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly leaseSeconds: number;
  stage: AutomationRunStage;
  checkpoint: Readonly<Record<string, unknown>>;
  mutationTail: Promise<void>;
}

class AutomationAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;

  constructor(
    code: string,
    options: { readonly retryable?: boolean; readonly uncertain?: boolean } = {},
  ) {
    super(code);
    this.name = "AutomationAdapterError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.uncertain = options.uncertain ?? false;
  }
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function leaseSeconds(milliseconds: number): number {
  return Math.min(3_600, Math.max(10, Math.ceil(milliseconds / 1_000)));
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function safeErrorCode(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && SAFE_ERROR_CODE.test(value) ? value : fallback;
}

function targetCheckpointRecord(
  checkpoint: ScheduledAutomationCheckpoint,
): Record<string, unknown> {
  return { ...checkpoint };
}

function summarizeRun(run: AutomationRunView): GeoAutomationRunResult {
  return {
    runId: run.id,
    contentItemId: run.contentItemId,
    contentVersionId: run.contentVersionId,
    targetStates: Object.fromEntries(run.targets.map((target) => [target.id, target.state])),
  };
}

function assertMutationAccepted(result: { readonly accepted: boolean }): void {
  if (!result.accepted) {
    throw new AutomationAdapterError("AUTOMATION_LEASE_REJECTED", { uncertain: true });
  }
}

function assertRunLease(run: AutomationRunView, binding: LeaseBinding): void {
  if (
    run.id !== binding.runId ||
    run.attemptCount !== binding.attempt ||
    run.leaseOwner !== `${binding.principal.actorId}:${binding.producerId}` ||
    run.state !== "running"
  ) {
    throw new AutomationAdapterError("AUTOMATION_LEASE_IDENTITY_MISMATCH", {
      uncertain: true,
    });
  }
}

function assertPublicationBinding(
  job: AutomationPublicationJobView,
  target: AutomationRunTargetView,
): void {
  if (
    job.id !== target.publicationJobId ||
    job.variantId !== target.variantId ||
    job.auditArtifactId !== target.auditArtifactId ||
    job.channelAccountId !== target.channelAccountId ||
    job.platform !== target.platform ||
    job.executionLevel !== "dry_run"
  ) {
    throw new AutomationAdapterError("AUTOMATION_PUBLICATION_BINDING_MISMATCH");
  }
}

export class GeoAutomationProducerAdapter {
  readonly #sessions: AutomationPrincipalRegistry;
  readonly #api: InternalGeoApiClient & AutomationGeoApiClient;
  readonly #runtimeForPrincipal: (principal: Readonly<ActorContext>) => AutomationToolRuntime;
  readonly #deliveryPollIntervalMs: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => Date;
  readonly #bindingsByToken = new Map<string, LeaseBinding>();
  #principals: Promise<readonly Readonly<ActorContext>[]> | undefined;
  #principalsExpiresAt = 0;
  #nextPrincipal = 0;

  constructor(options: GeoAutomationProducerAdapterOptions) {
    this.#sessions = options.sessions;
    this.#api = options.api;
    if (options.runtimeForPrincipal !== undefined) {
      this.#runtimeForPrincipal = options.runtimeForPrincipal;
    } else {
      if (options.governance === undefined) {
        throw new TypeError("governance or runtimeForPrincipal is required");
      }
      const governance = options.governance;
      this.#runtimeForPrincipal = (principal) =>
        createGovernedAgentRuntime(principal, options.api, governance);
    }
    this.#deliveryPollIntervalMs = options.deliveryPollIntervalMs ?? 1_000;
    if (
      !Number.isSafeInteger(this.#deliveryPollIntervalMs) ||
      this.#deliveryPollIntervalMs < 10 ||
      this.#deliveryPollIntervalMs > 60_000
    ) {
      throw new TypeError("deliveryPollIntervalMs must be between 10 and 60000");
    }
    this.#wait = options.wait ?? waitForDelay;
    this.#now = options.now ?? (() => new Date());
  }

  dependencies(): AutomationProducerDependencies<AutomationRunView, GeoAutomationRunResult> {
    return {
      claimRun: (request) => this.#claimRun(request),
      heartbeat: (request) => this.#heartbeat(request),
      executeRun: (run, signal) => this.#executeRun(run, signal),
      checkpoint: (checkpoint) => this.#checkpoint(checkpoint),
      reconcile: (request) => this.#reconcile(request.run, request.failure, request.signal),
    };
  }

  async #configuredPrincipals(): Promise<readonly Readonly<ActorContext>[]> {
    if (this.#principals === undefined || this.#now().getTime() >= this.#principalsExpiresAt) {
      const discovery = this.#sessions.automationPrincipals().then((principals) => {
        const eligible = principals.filter((principal) =>
          principal.capabilities.includes("automation:execute"),
        );
        if (eligible.length === 0) {
          throw new AutomationAdapterError("AUTOMATION_PRINCIPAL_UNAVAILABLE", {
            retryable: true,
          });
        }
        this.#principalsExpiresAt = this.#now().getTime() + PRINCIPAL_DISCOVERY_TTL_MS;
        return eligible;
      });
      this.#principals = discovery;
    }
    const discovery = this.#principals;
    try {
      return await discovery;
    } catch (error) {
      if (this.#principals === discovery) {
        this.#principals = undefined;
        this.#principalsExpiresAt = 0;
      }
      throw error;
    }
  }

  async #claimRun(request: {
    readonly producerId: string;
    readonly leaseDurationMs: number;
    readonly signal: AbortSignal;
  }): Promise<AutomationRunClaim<AutomationRunView> | null> {
    const principals = await this.#configuredPrincipals();
    const start = this.#nextPrincipal % principals.length;
    let successfulRequests = 0;
    let failedRequests = 0;
    for (let offset = 0; offset < principals.length; offset += 1) {
      const index = (start + offset) % principals.length;
      const principal = principals[index];
      if (principal === undefined) continue;
      this.#nextPrincipal = (index + 1) % principals.length;
      let claims: readonly AutomationRunLease[];
      try {
        claims = await this.#api.claimAutomationRuns(principal, {
          producerId: request.producerId,
          limit: 1,
          leaseSeconds: leaseSeconds(request.leaseDurationMs),
          signal: request.signal,
        });
        successfulRequests += 1;
      } catch {
        if (request.signal.aborted) {
          throw new DOMException("Automation claim aborted", "AbortError");
        }
        failedRequests += 1;
        continue;
      }
      const run = claims[0];
      if (run === undefined) continue;
      const binding: LeaseBinding = {
        principal,
        producerId: request.producerId,
        runId: run.id,
        attempt: run.attemptCount,
        leaseSeconds: leaseSeconds(request.leaseDurationMs),
        stage: run.stage,
        checkpoint: run.checkpoint,
        mutationTail: Promise.resolve(),
      };
      assertRunLease(run, binding);
      if (
        [...this.#bindingsByToken.values()].some(
          (candidate) =>
            candidate.runId === run.id && candidate.principal.tenantId === principal.tenantId,
        )
      ) {
        throw new AutomationAdapterError("AUTOMATION_DUPLICATE_LEASE_BINDING", {
          uncertain: true,
        });
      }
      const token = randomUUID();
      this.#bindingsByToken.set(token, binding);
      return {
        runId: run.id,
        tenantId: principal.tenantId,
        leaseToken: token,
        attempt: run.attemptCount,
        tenantGate: run.tenantGate,
        payload: run,
      };
    }
    if (successfulRequests === 0 && failedRequests > 0) {
      throw new AutomationAdapterError("AUTOMATION_PRINCIPAL_CLAIM_FAILED", {
        retryable: true,
      });
    }
    return null;
  }

  #bindingFor(identity: {
    readonly producerId: string;
    readonly runId: string;
    readonly leaseToken: string;
    readonly attempt?: number;
    readonly tenantId?: string;
  }): LeaseBinding {
    const binding = this.#bindingsByToken.get(identity.leaseToken);
    if (
      binding === undefined ||
      binding.producerId !== identity.producerId ||
      binding.runId !== identity.runId ||
      (identity.attempt !== undefined && binding.attempt !== identity.attempt) ||
      (identity.tenantId !== undefined && binding.principal.tenantId !== identity.tenantId)
    ) {
      throw new AutomationAdapterError("AUTOMATION_LEASE_IDENTITY_MISMATCH", {
        uncertain: true,
      });
    }
    return binding;
  }

  #bindingForClaim(claim: Readonly<AutomationRunClaim<AutomationRunView>>): LeaseBinding {
    const binding = this.#bindingsByToken.get(claim.leaseToken);
    if (
      binding === undefined ||
      binding.runId !== claim.runId ||
      binding.attempt !== claim.attempt ||
      binding.principal.tenantId !== claim.tenantId
    ) {
      throw new AutomationAdapterError("AUTOMATION_LEASE_IDENTITY_MISMATCH", {
        uncertain: true,
      });
    }
    return binding;
  }

  async #serializeLeaseMutation<T>(binding: LeaseBinding, operation: () => Promise<T>): Promise<T> {
    const previous = binding.mutationTail;
    let release: (() => void) | undefined;
    binding.mutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #heartbeat(request: {
    readonly producerId: string;
    readonly runId: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly leaseValid: true }> {
    const binding = this.#bindingFor(request);
    await this.#serializeLeaseMutation(binding, async () => {
      const result = await this.#api.heartbeatAutomationRun(binding.principal, binding.runId, {
        producerId: binding.producerId,
        attempt: binding.attempt,
        stage: binding.stage,
        checkpoint: binding.checkpoint,
        leaseSeconds: leaseSeconds(request.leaseDurationMs),
        signal: request.signal,
      });
      assertMutationAccepted(result);
    });
    return { leaseValid: true };
  }

  async #persistScheduledCheckpoint(
    binding: LeaseBinding,
    checkpoint: ScheduledAutomationCheckpoint,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#serializeLeaseMutation(binding, async () => {
      let result: { readonly accepted: boolean };
      if (checkpoint.stage === "draft") {
        result = await this.#api.checkpointAutomationDraft(binding.principal, binding.runId, {
          producerId: binding.producerId,
          attempt: binding.attempt,
          contentItemId: checkpoint.contentItemId,
          contentVersionId: checkpoint.contentVersionId,
          checkpoint: targetCheckpointRecord(checkpoint),
          leaseSeconds: binding.leaseSeconds,
          signal,
        });
        binding.stage = "draft";
      } else {
        result = await this.#api.checkpointAutomationTarget(
          binding.principal,
          binding.runId,
          checkpoint.targetId,
          {
            producerId: binding.producerId,
            attempt: binding.attempt,
            state: checkpoint.state,
            ...(checkpoint.variantId === undefined ? {} : { variantId: checkpoint.variantId }),
            ...(checkpoint.auditRunId === undefined ? {} : { auditRunId: checkpoint.auditRunId }),
            ...(checkpoint.auditArtifactId === undefined
              ? {}
              : { auditArtifactId: checkpoint.auditArtifactId }),
            ...(checkpoint.publicationJobId === undefined
              ? {}
              : { publicationJobId: checkpoint.publicationJobId }),
            ...(checkpoint.errorCode === undefined ? {} : { errorCode: checkpoint.errorCode }),
            checkpoint: targetCheckpointRecord(checkpoint),
            leaseSeconds: binding.leaseSeconds,
            signal,
          },
        );
        binding.stage = checkpoint.state === "awaiting_delivery" ? "delivery" : "targets";
      }
      assertMutationAccepted(result);
      binding.checkpoint = targetCheckpointRecord(checkpoint);
    });
  }

  async #executeRun(
    claim: Readonly<AutomationRunClaim<AutomationRunView>>,
    signal: AbortSignal,
  ): Promise<GeoAutomationRunResult> {
    const binding = this.#bindingForClaim(claim);
    let run = await this.#api.getAutomationRun(binding.principal, binding.runId, signal);
    assertRunLease(run, binding);
    if (run.targets.some((target) => ["pending", "variant_ready"].includes(target.state))) {
      const runtime = new ScheduledAutomationRuntime(this.#runtimeForPrincipal(binding.principal));
      await runtime.run(
        {
          tenantId: binding.principal.tenantId,
          brandId: run.brandId,
          campaignId: run.campaignId,
          runId: run.id,
          topic: run.brief,
          ...(run.contentItemId === null ? {} : { contentItemId: run.contentItemId }),
          ...(run.contentVersionId === null ? {} : { contentVersionId: run.contentVersionId }),
          targets: run.targets.map((target) => ({
            targetId: target.id,
            channelAccountId: target.channelAccountId,
            platform: target.platform,
            state: target.state,
            ...(target.variantId === null ? {} : { variantId: target.variantId }),
            ...(target.auditRunId === null ? {} : { auditRunId: target.auditRunId }),
            ...(target.auditArtifactId === null ? {} : { auditArtifactId: target.auditArtifactId }),
            ...(target.publicationJobId === null
              ? {}
              : { publicationJobId: target.publicationJobId }),
            ...(target.lastErrorCode === null ? {} : { errorCode: target.lastErrorCode }),
          })),
        },
        (checkpoint) => this.#persistScheduledCheckpoint(binding, checkpoint, signal),
        signal,
      );
    }

    run = await this.#drainDelivery(binding, signal);
    return summarizeRun(run);
  }

  async #drainDelivery(binding: LeaseBinding, signal: AbortSignal): Promise<AutomationRunView> {
    while (true) {
      const run = await this.#api.getAutomationRun(binding.principal, binding.runId, signal);
      assertRunLease(run, binding);
      const awaiting = run.targets.filter((target) => target.state === "awaiting_delivery");
      if (awaiting.length === 0) return run;

      let progressed = false;
      for (const target of awaiting) {
        if (target.publicationJobId === null) {
          throw new AutomationAdapterError("AUTOMATION_PUBLICATION_JOB_MISSING");
        }
        const job = await this.#api.getAutomationPublicationJob(
          binding.principal,
          target.publicationJobId,
          signal,
        );
        assertPublicationBinding(job, target);
        if (job.state === "preview_completed") {
          await this.#checkpointDeliveryTarget(
            binding,
            target,
            "preview_completed",
            undefined,
            signal,
          );
          progressed = true;
          continue;
        }
        if (ACTIVE_DELIVERY_STATES.has(job.state)) continue;
        const code =
          job.state === "confirmed"
            ? "AUTOMATION_DRY_RUN_STATE_INVALID"
            : safeErrorCode(job.lastErrorCode, `AUTOMATION_PUBLICATION_${job.state.toUpperCase()}`);
        await this.#checkpointDeliveryTarget(binding, target, "failed", code, signal);
        progressed = true;
      }
      if (!progressed) await this.#wait(this.#deliveryPollIntervalMs, signal);
    }
  }

  async #checkpointDeliveryTarget(
    binding: LeaseBinding,
    target: AutomationRunTargetView,
    state: "preview_completed" | "failed",
    errorCode: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const variantId = optional(target.variantId);
    const auditRunId = optional(target.auditRunId);
    const auditArtifactId = optional(target.auditArtifactId);
    const publicationJobId = optional(target.publicationJobId);
    await this.#serializeLeaseMutation(binding, async () => {
      const result = await this.#api.checkpointAutomationTarget(
        binding.principal,
        binding.runId,
        target.id,
        {
          producerId: binding.producerId,
          attempt: binding.attempt,
          state,
          ...(variantId === undefined ? {} : { variantId }),
          ...(auditRunId === undefined ? {} : { auditRunId }),
          ...(auditArtifactId === undefined ? {} : { auditArtifactId }),
          ...(publicationJobId === undefined ? {} : { publicationJobId }),
          ...(errorCode === undefined ? {} : { errorCode }),
          checkpoint: { stage: "delivery", targetId: target.id, state },
          leaseSeconds: binding.leaseSeconds,
          signal,
        },
      );
      assertMutationAccepted(result);
      binding.stage = "delivery";
      binding.checkpoint = { stage: "delivery", targetId: target.id, state };
    });
  }

  async #failUnfinishedTargets(binding: LeaseBinding, failure: AutomationFailure): Promise<void> {
    const run = await this.#api.getAutomationRun(binding.principal, binding.runId);
    assertRunLease(run, binding);
    for (const target of run.targets) {
      if (!["pending", "variant_ready"].includes(target.state)) continue;
      await this.#serializeLeaseMutation(binding, async () => {
        const result = await this.#api.checkpointAutomationTarget(
          binding.principal,
          binding.runId,
          target.id,
          {
            producerId: binding.producerId,
            attempt: binding.attempt,
            state: "failed",
            ...(target.variantId === null ? {} : { variantId: target.variantId }),
            errorCode: safeErrorCode(failure.code, "AUTOMATION_EXECUTION_FAILED"),
            checkpoint: { stage: "targets", targetId: target.id, state: "failed" },
            leaseSeconds: binding.leaseSeconds,
          },
        );
        assertMutationAccepted(result);
        binding.stage = "targets";
        binding.checkpoint = { stage: "targets", targetId: target.id, state: "failed" };
      });
    }
  }

  async #checkpoint(checkpoint: AutomationCheckpoint<GeoAutomationRunResult>): Promise<void> {
    const binding = this.#bindingFor(checkpoint);
    try {
      if (checkpoint.state === "failed") {
        await this.#failUnfinishedTargets(binding, checkpoint.failure);
      }
      const retryAfter =
        checkpoint.state === "retry_wait"
          ? new Date(this.#now().getTime() + checkpoint.retryAfterMs).toISOString()
          : checkpoint.state === "released"
            ? this.#now().toISOString()
            : undefined;
      const errorCode =
        checkpoint.state === "failed" || checkpoint.state === "retry_wait"
          ? checkpoint.failure.code
          : checkpoint.state === "released"
            ? `AUTOMATION_${checkpoint.reason.toUpperCase()}`
            : undefined;
      await this.#serializeLeaseMutation(binding, () =>
        this.#api.reconcileAutomationRun(binding.principal, binding.runId, {
          producerId: binding.producerId,
          attempt: binding.attempt,
          ...(retryAfter === undefined ? {} : { retryAfter }),
          ...(errorCode === undefined ? {} : { errorCode }),
        }),
      );
    } finally {
      this.#bindingsByToken.delete(checkpoint.leaseToken);
    }
  }

  async #reconcile(
    claim: Readonly<AutomationRunClaim<AutomationRunView>>,
    _failure: AutomationFailure,
    signal: AbortSignal,
  ): Promise<AutomationReconciliation<GeoAutomationRunResult>> {
    const binding = this.#bindingForClaim(claim);
    const run = await this.#api.getAutomationRun(binding.principal, binding.runId, signal);
    if (run.state === "completed" || run.state === "partially_failed") {
      return { disposition: "confirmed_succeeded", result: summarizeRun(run) };
    }
    if (["blocked", "failed", "cancelled"].includes(run.state)) {
      return { disposition: "confirmed_failed" };
    }
    if (run.state !== "running") return { disposition: "unresolved" };
    assertRunLease(run, binding);
    if (run.targets.some((target) => target.state === "awaiting_delivery")) {
      return { disposition: "unresolved" };
    }
    if (run.targets.every((target) => TERMINAL_TARGET_STATES.has(target.state))) {
      return { disposition: "confirmed_succeeded", result: summarizeRun(run) };
    }
    return { disposition: "retry_safe" };
  }
}

export function createGeoAutomationProducerDependencies(
  options: GeoAutomationProducerAdapterOptions,
): AutomationProducerDependencies<AutomationRunView, GeoAutomationRunResult> {
  return new GeoAutomationProducerAdapter(options).dependencies();
}
