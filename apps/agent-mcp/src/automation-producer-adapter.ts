import { randomUUID } from "node:crypto";

import {
  parseAutomationDraftTrace,
  parseAutomationRemediationPlan,
  redactSensitiveDetails,
  ScheduledAutomationRuntime,
  type AutomationDraftTrace,
  type AutomationToolRuntime,
  type PlasticPromiseGovernanceClient,
  type ScheduledAutomationCheckpoint,
} from "@geo/agent";
import {
  AUTOMATION_DIVERSITY_STRATEGIES,
  automationDiversityStrategy,
  automationKeywordSelectionForProvince,
  automationPlatformSchema,
  destinationTravelResource,
  type ActorContext,
  type AutomationPlatform,
  type AutomationRunStage,
  type LicensedImageSearchProviderId,
} from "@geo/contracts";

import type { InternalGeoApiClient } from "./api-client.js";
import {
  createGovernedAgentRuntime,
  PiAgentRunError,
  type AutomationDraftDiversityPlan,
  type PiAgentRunService,
} from "./pi-runner.js";
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

const TERMINAL_TARGET_STATES = new Set([
  "audit_failed",
  "preview_completed",
  "confirmed",
  "delivery_failed",
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
const DEFAULT_DRAFT_TIMEOUT_MS = 600_000;
const DRAFT_INPUT_SELF_HEAL_ATTEMPTS = 2;

export function automationDraftDiversityPlan(
  run: Pick<AutomationRunView, "diversityRotationIndex" | "targets">,
  rotationOffset = 0,
): Readonly<{ articleTemplateId: string; diversityPlan: AutomationDraftDiversityPlan }> {
  const platforms = [...new Set(run.targets.map((target) => target.platform))];
  if (platforms.length === 0) {
    throw new TypeError("Automation diversity planning requires a target");
  }
  const cycleLength = AUTOMATION_DIVERSITY_STRATEGIES.length;
  if (!Number.isSafeInteger(run.diversityRotationIndex) || run.diversityRotationIndex < 0) {
    throw new TypeError("Automation diversity rotation index must be a non-negative integer");
  }
  if (!Number.isSafeInteger(rotationOffset) || rotationOffset < 0) {
    throw new TypeError("Automation diversity rotation offset must be a non-negative integer");
  }
  const templateRotationIndex = run.diversityRotationIndex + rotationOffset;
  const rotationIndex = templateRotationIndex % cycleLength;
  const selected = automationDiversityStrategy(templateRotationIndex, platforms);
  const destination = destinationTravelResource(templateRotationIndex);
  const keywordSelection = automationKeywordSelectionForProvince(
    templateRotationIndex,
    destination.provinceName,
  );
  const forbiddenAdjacentPatterns = [1, 2, 3].map((distance) => {
    const index =
      templateRotationIndex >= distance
        ? templateRotationIndex - distance
        : templateRotationIndex - distance + cycleLength;
    const strategy = automationDiversityStrategy(index, platforms);
    return `${strategy.strategyId} (${strategy.articleTemplateId}; ${strategy.titleConstruction}; ${strategy.openingPattern}; ${strategy.ctaPattern}; ${strategy.mediaVisualDirection})`;
  });
  return {
    articleTemplateId: selected.articleTemplateId,
    diversityPlan: {
      strategyId: selected.strategyId,
      rotationIndex,
      editorialProfile: selected.editorialProfile,
      topicAngle: selected.topicAngle,
      readerLens: selected.readerLens,
      titleConstruction: selected.titleConstruction,
      openingPattern: selected.openingPattern,
      bodyProgression: selected.bodyProgression,
      ctaPattern: selected.ctaPattern,
      mediaVisualDirection: selected.mediaVisualDirection,
      forbiddenAdjacentPatterns,
      destination: {
        provinceKey: destination.provinceKey,
        provinceName: destination.provinceName,
      },
      keywordPoolId: keywordSelection.poolId,
      keywordCandidates: keywordSelection.keywords,
    },
  };
}

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
  readonly agentRunner?: PiAgentRunService;
  readonly draftTimeoutMs?: number;
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
  draftRotationCursor: number;
  draftTrace?: Readonly<AutomationDraftTrace>;
  draftTraceByTargetId: Map<string, Readonly<AutomationDraftTrace>>;
  knownProviderRunIds: Set<string>;
  mediaProvider?: LicensedImageSearchProviderId;
  mediaComplete?: boolean;
  mediaCount?: number;
  mediaCompletedPlatforms?: readonly AutomationPlatform[];
  mutationTail: Promise<void>;
}

class AutomationAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly diagnostic: string | null;

  constructor(
    code: string,
    options: {
      readonly retryable?: boolean;
      readonly uncertain?: boolean;
      readonly diagnostic?: string | null;
    } = {},
  ) {
    super(options.diagnostic ?? code);
    this.name = "AutomationAdapterError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.uncertain = options.uncertain ?? false;
    this.diagnostic = options.diagnostic ?? null;
  }
}

function automationErrorForPiProviderFailure(error: PiAgentRunError): AutomationAdapterError {
  if (error.diagnosticReason === "draft_input") {
    // The provider reached the draft tool, but the authored payload could not
    // satisfy the verified-fact/media contract after bounded correction. This
    // is actionable content input, not a generic Pi workflow guard.
    return new AutomationAdapterError("AUTOMATION_PI_DRAFT_INPUT_INVALID", {
      retryable: false,
      uncertain: false,
    });
  }
  if (error.diagnosticReason === "tool_guard") {
    // A model that keeps selecting the wrong/repeated tool never crossed a
    // publication boundary. Keep this distinct from an upstream provider
    // failure so operators can fix the prompt/tool contract instead of
    // rotating credentials or retrying a known-bad run.
    return new AutomationAdapterError("AUTOMATION_PI_TOOL_GUARD", {
      retryable: false,
      uncertain: false,
      diagnostic:
        error.lastToolName === null
          ? "AUTOMATION_PI_TOOL_GUARD: the model crossed a governed tool boundary without a recoverable last tool"
          : `AUTOMATION_PI_TOOL_GUARD: the model crossed a governed tool boundary after ${error.lastToolName}`,
    });
  }
  switch (error.providerFailureClass) {
    case "timeout":
      return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_TIMEOUT", {
        retryable: true,
        uncertain: true,
      });
    case "rate_limit":
      return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_RATE_LIMIT", {
        retryable: true,
      });
    case "authentication":
      return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_AUTHENTICATION", {
        retryable: false,
      });
    default:
      return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_FAILED", {
        retryable: true,
        uncertain: true,
      });
  }
}

function automationErrorForDraftException(error: unknown): AutomationAdapterError | undefined {
  if (error instanceof PiAgentRunError) return automationErrorForPiProviderFailure(error);
  if (error instanceof AutomationAdapterError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return undefined;
  if (!(error instanceof Error)) return undefined;

  const message = error.message;
  if (/\b(?:408|504|524)\b|timed?[ _-]?out|timeout/iu.test(message)) {
    return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_TIMEOUT", {
      retryable: true,
      uncertain: true,
    });
  }
  if (/network|fetch failed|econn|socket|tls|connection closed/iu.test(message)) {
    return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_NETWORK", {
      retryable: true,
      uncertain: true,
    });
  }
  return new AutomationAdapterError("AUTOMATION_PI_PROVIDER_FAILED", {
    retryable: true,
    uncertain: true,
  });
}

function runAbortableWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (callerSignal.aborted) {
    return Promise.reject(new DOMException("Automation draft aborted", "AbortError"));
  }

  const timeoutController = new AbortController();
  const operationSignal = AbortSignal.any([callerSignal, timeoutController.signal]);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operationSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        rejectPromise(
          timedOut
            ? new AutomationAdapterError("AUTOMATION_PI_DRAFT_TIMEOUT", { retryable: true })
            : new DOMException("Automation draft aborted", "AbortError"),
        ),
      );
    timeout.unref();
    operationSignal.addEventListener("abort", onAbort, { once: true });
    if (operationSignal.aborted) {
      onAbort();
      return;
    }

    try {
      void operation(operationSignal).then(
        (value) => finish(() => resolvePromise(value)),
        (error: unknown) => finish(() => rejectPromise(error)),
      );
    } catch (error) {
      finish(() => rejectPromise(error));
    }
  });
}

function leaseSeconds(milliseconds: number): number {
  return Math.min(3_600, Math.max(10, Math.ceil(milliseconds / 1_000)));
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function licensedMediaProvider(value: unknown): value is LicensedImageSearchProviderId {
  return value === "wikimedia_commons" || value === "pexels";
}

function mediaPlatforms(value: unknown): readonly AutomationPlatform[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const platforms: AutomationPlatform[] = [];
  for (const item of value) {
    const parsed = automationPlatformSchema.safeParse(item);
    if (!parsed.success) return undefined;
    if (!platforms.includes(parsed.data)) platforms.push(parsed.data);
  }
  return platforms;
}

function safeErrorCode(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && SAFE_ERROR_CODE.test(value) ? value : fallback;
}

function checkpointRecord(
  binding: LeaseBinding,
  checkpoint: Readonly<Record<string, unknown>>,
  draftTrace: Readonly<AutomationDraftTrace> | undefined = binding.draftTrace,
): Record<string, unknown> {
  const mediaProvider =
    checkpoint.stage === "media" && licensedMediaProvider(checkpoint.provider)
      ? checkpoint.provider
      : binding.mediaProvider;
  const mediaComplete =
    checkpoint.stage === "media" && typeof checkpoint.mediaComplete === "boolean"
      ? checkpoint.mediaComplete
      : binding.mediaComplete;
  const mediaCount =
    checkpoint.stage === "media" &&
    typeof checkpoint.mediaCount === "number" &&
    Number.isInteger(checkpoint.mediaCount) &&
    checkpoint.mediaCount >= 0
      ? checkpoint.mediaCount
      : binding.mediaCount;
  const mediaCompletedPlatforms =
    checkpoint.stage === "media"
      ? mediaPlatforms(checkpoint.completedPlatforms)
      : binding.mediaCompletedPlatforms;
  const checkpointWithoutDraftTrace = Object.fromEntries(
    Object.entries(checkpoint).filter(
      ([key]) => key !== "draftTrace" && key !== "draftProviderMode",
    ),
  );
  return {
    ...checkpointWithoutDraftTrace,
    ...(binding.draftRotationCursor === 0
      ? {}
      : { draftRotationCursor: binding.draftRotationCursor }),
    ...(draftTrace === undefined ? {} : { draftProviderMode: "pi_authored" as const, draftTrace }),
    ...(mediaProvider === undefined ? {} : { mediaProvider }),
    ...(mediaComplete === undefined ? {} : { mediaComplete }),
    ...(mediaCount === undefined ? {} : { mediaCount }),
    ...(mediaCompletedPlatforms === undefined ? {} : { mediaCompletedPlatforms }),
  };
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
  executionLevel: AutomationRunView["executionLevel"],
): void {
  if (
    job.id !== target.publicationJobId ||
    job.variantId !== target.variantId ||
    job.auditArtifactId !== target.auditArtifactId ||
    job.channelAccountId !== target.channelAccountId ||
    job.platform !== target.platform ||
    job.executionLevel !== executionLevel
  ) {
    throw new AutomationAdapterError("AUTOMATION_PUBLICATION_BINDING_MISMATCH");
  }
}

export class GeoAutomationProducerAdapter {
  readonly #sessions: AutomationPrincipalRegistry;
  readonly #api: InternalGeoApiClient & AutomationGeoApiClient;
  readonly #runtimeForPrincipal: (principal: Readonly<ActorContext>) => AutomationToolRuntime;
  readonly #agentRunner: PiAgentRunService | undefined;
  readonly #draftTimeoutMs: number;
  readonly #now: () => Date;
  readonly #bindingsByToken = new Map<string, LeaseBinding>();
  #principals: Promise<readonly Readonly<ActorContext>[]> | undefined;
  #principalsExpiresAt = 0;
  #nextPrincipal = 0;

  constructor(options: GeoAutomationProducerAdapterOptions) {
    this.#sessions = options.sessions;
    this.#api = options.api;
    this.#agentRunner = options.agentRunner;
    this.#draftTimeoutMs = options.draftTimeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#draftTimeoutMs) ||
      this.#draftTimeoutMs < 10 ||
      this.#draftTimeoutMs > 15 * 60_000
    ) {
      throw new TypeError("draftTimeoutMs must be between 10 and 900000");
    }
    if (options.runtimeForPrincipal !== undefined) {
      this.#runtimeForPrincipal = options.runtimeForPrincipal;
    } else {
      if (options.governance === undefined) {
        throw new TypeError("governance or runtimeForPrincipal is required");
      }
      const governance = options.governance;
      this.#runtimeForPrincipal = (principal) =>
        createGovernedAgentRuntime(principal, options.api, governance, {
          allowFixtureDrafts: this.#agentRunner?.capability.mode === "fixture",
        });
    }
    const deliveryPollIntervalMs = options.deliveryPollIntervalMs ?? 1_000;
    if (
      !Number.isSafeInteger(deliveryPollIntervalMs) ||
      deliveryPollIntervalMs < 10 ||
      deliveryPollIntervalMs > 60_000
    ) {
      throw new TypeError("deliveryPollIntervalMs must be between 10 and 60000");
    }
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
      const draftTrace = parseAutomationDraftTrace(run.checkpoint.draftTrace);
      if (Object.hasOwn(run.checkpoint, "draftTrace") && draftTrace === null) {
        throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_TRACE_INVALID");
      }
      const checkpointMediaProvider = licensedMediaProvider(run.checkpoint.mediaProvider)
        ? run.checkpoint.mediaProvider
        : run.checkpoint.stage === "media" && licensedMediaProvider(run.checkpoint.provider)
          ? run.checkpoint.provider
          : undefined;
      const checkpointMediaCompletedPlatforms =
        mediaPlatforms(run.checkpoint.mediaCompletedPlatforms) ??
        (run.checkpoint.stage === "media"
          ? mediaPlatforms(run.checkpoint.completedPlatforms)
          : undefined);
      const checkpointDraftRotationCursor =
        typeof run.checkpoint.draftRotationCursor === "number" &&
        Number.isSafeInteger(run.checkpoint.draftRotationCursor) &&
        run.checkpoint.draftRotationCursor >= 0
          ? run.checkpoint.draftRotationCursor
          : run.contentItemId === null && run.contentVersionId === null
            ? 0
            : 1;
      const draftTraceByTargetId = new Map<string, Readonly<AutomationDraftTrace>>();
      const knownProviderRunIds = new Set<string>();
      if (draftTrace !== null) knownProviderRunIds.add(draftTrace.providerRunId);
      for (const target of run.targets) {
        const targetTrace = parseAutomationDraftTrace(target.checkpoint?.draftTrace);
        if (targetTrace === null) continue;
        draftTraceByTargetId.set(target.id, targetTrace);
        knownProviderRunIds.add(targetTrace.providerRunId);
      }
      const binding: LeaseBinding = {
        principal,
        producerId: request.producerId,
        runId: run.id,
        attempt: run.attemptCount,
        leaseSeconds: leaseSeconds(request.leaseDurationMs),
        stage: run.stage,
        checkpoint: run.checkpoint,
        draftRotationCursor: checkpointDraftRotationCursor,
        draftTraceByTargetId,
        knownProviderRunIds,
        ...(draftTrace === null ? {} : { draftTrace }),
        ...(checkpointMediaProvider === undefined
          ? {}
          : { mediaProvider: checkpointMediaProvider }),
        ...(typeof run.checkpoint.mediaComplete === "boolean"
          ? { mediaComplete: run.checkpoint.mediaComplete }
          : {}),
        ...(typeof run.checkpoint.mediaCount === "number" &&
        Number.isInteger(run.checkpoint.mediaCount) &&
        run.checkpoint.mediaCount >= 0
          ? { mediaCount: run.checkpoint.mediaCount }
          : {}),
        ...(checkpointMediaCompletedPlatforms === undefined
          ? {}
          : { mediaCompletedPlatforms: checkpointMediaCompletedPlatforms }),
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
      let nextStage: AutomationRunStage;
      const checkpointRecordValue = checkpoint as Readonly<Record<string, unknown>>;
      const hasCheckpointTrace = Object.hasOwn(checkpointRecordValue, "draftTrace");
      const checkpointDraftTrace = checkpointRecordValue.draftTrace;
      const parsedCheckpointTrace = hasCheckpointTrace
        ? parseAutomationDraftTrace(checkpointDraftTrace)
        : null;
      if (hasCheckpointTrace && parsedCheckpointTrace === null) {
        throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_TRACE_INVALID");
      }
      if (
        parsedCheckpointTrace !== null &&
        !binding.knownProviderRunIds.has(parsedCheckpointTrace.providerRunId)
      ) {
        throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_TRACE_INVALID");
      }
      if (
        (checkpoint.stage === "draft" || checkpoint.stage === "media") &&
        ((checkpoint.providerMode === "pi_authored" && parsedCheckpointTrace === null) ||
          (checkpoint.providerMode !== "pi_authored" && hasCheckpointTrace))
      ) {
        throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_TRACE_INVALID");
      }
      const nextDraftTrace = parsedCheckpointTrace ?? binding.draftTrace;
      const nextCheckpoint = checkpointRecord(binding, checkpoint, nextDraftTrace);
      if (checkpoint.stage === "draft") {
        result = await this.#api.checkpointAutomationDraft(binding.principal, binding.runId, {
          producerId: binding.producerId,
          attempt: binding.attempt,
          contentItemId: checkpoint.contentItemId,
          contentVersionId: checkpoint.contentVersionId,
          checkpoint: nextCheckpoint,
          leaseSeconds: binding.leaseSeconds,
          signal,
        });
        nextStage = "draft";
      } else if (checkpoint.stage === "media") {
        result = await this.#api.checkpointAutomationDraft(binding.principal, binding.runId, {
          producerId: binding.producerId,
          attempt: binding.attempt,
          contentItemId: checkpoint.contentItemId,
          contentVersionId: checkpoint.contentVersionId,
          checkpoint: nextCheckpoint,
          leaseSeconds: binding.leaseSeconds,
          signal,
        });
        nextStage = "draft";
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
            ...(checkpoint.errorMessage === undefined
              ? {}
              : { errorMessage: checkpoint.errorMessage }),
            checkpoint: nextCheckpoint,
            leaseSeconds: binding.leaseSeconds,
            signal,
          },
        );
        nextStage = checkpoint.state === "awaiting_delivery" ? "delivery" : "targets";
      }
      assertMutationAccepted(result);
      binding.stage = nextStage;
      if (nextDraftTrace !== undefined) binding.draftTrace = nextDraftTrace;
      if (
        nextDraftTrace !== undefined &&
        checkpoint.stage === "target" &&
        checkpoint.targetId !== undefined
      ) {
        binding.draftTraceByTargetId.set(checkpoint.targetId, nextDraftTrace);
      }
      if (checkpoint.stage === "media") {
        binding.mediaProvider = checkpoint.provider;
        binding.mediaComplete = checkpoint.mediaComplete;
        binding.mediaCount = checkpoint.mediaCount;
        binding.mediaCompletedPlatforms = checkpoint.completedPlatforms;
      }
      binding.checkpoint = nextCheckpoint;
    });
  }

  async #executeRun(
    claim: Readonly<AutomationRunClaim<AutomationRunView>>,
    signal: AbortSignal,
  ): Promise<GeoAutomationRunResult> {
    const binding = this.#bindingForClaim(claim);
    let run = await this.#api.getAutomationRun(binding.principal, binding.runId, signal);
    assertRunLease(run, binding);
    if (
      run.executionLevel !== "dry_run" &&
      run.contentItemId !== null &&
      binding.draftTrace === undefined
    ) {
      throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_TRACE_INVALID");
    }
    if (run.targets.some((target) => ["pending", "variant_ready"].includes(target.state))) {
      const requiresNewDraft = run.contentItemId === null && run.contentVersionId === null;
      if (
        requiresNewDraft &&
        run.executionLevel !== "dry_run" &&
        (this.#agentRunner?.capability.mode !== "pi" ||
          this.#agentRunner.authorAutomationDraft === undefined)
      ) {
        throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_AUTHOR_UNAVAILABLE");
      }
      const agentRunner = this.#agentRunner;
      const requiresAlternateDraft =
        requiresNewDraft || run.targets.some((target) => target.remediation?.mode === "manual");
      const draftAuthor =
        requiresAlternateDraft &&
        agentRunner?.capability.mode === "pi" &&
        agentRunner.authorAutomationDraft !== undefined
          ? (() => {
              const authorAutomationDraft = agentRunner.authorAutomationDraft.bind(agentRunner);
              const nextDraftPlan = () => {
                const rotationOffset = binding.draftRotationCursor;
                binding.draftRotationCursor = rotationOffset + 1;
                return automationDraftDiversityPlan(run, rotationOffset);
              };
              const authorWithPlan = async (
                input: Parameters<NonNullable<PiAgentRunService["authorAutomationDraft"]>>[1],
                authorSignal?: AbortSignal,
              ) => {
                const authorOnce = async (
                  attemptPlan: Readonly<ReturnType<typeof automationDraftDiversityPlan>>,
                  selfHealAttempt: number,
                ) => {
                  let result;
                  try {
                    result = await runAbortableWithTimeout(
                      (operationSignal) =>
                        authorAutomationDraft(
                          binding.principal,
                          {
                            ...input,
                            ...attemptPlan,
                            ...(selfHealAttempt === 0
                              ? {}
                              : {
                                  idempotencyKey: `${input.idempotencyKey}:self-heal:${selfHealAttempt}`,
                                }),
                          },
                          operationSignal,
                        ),
                      authorSignal ?? signal,
                      this.#draftTimeoutMs,
                    );
                  } catch (error) {
                    if (error instanceof PiAgentRunError) {
                      console.error(
                        JSON.stringify({
                          level: "error",
                          event: "agent_mcp.automation_pi_draft_failed",
                          tenantId: binding.principal.tenantId,
                          runId: binding.runId,
                          attempt: binding.attempt,
                          diagnosticReason: error.diagnosticReason,
                          failureCode: error.failureCode,
                          providerFailureClass: error.providerFailureClass,
                          toolCallCount: error.toolCallCount,
                          lastToolName: error.lastToolName,
                        }),
                      );
                    } else if (error instanceof Error) {
                      console.error(
                        JSON.stringify({
                          level: "error",
                          event: "agent_mcp.automation_pi_draft_exception",
                          tenantId: binding.principal.tenantId,
                          runId: binding.runId,
                          attempt: binding.attempt,
                          errorName: error.name,
                          diagnosticMessage: String(redactSensitiveDetails(error.message)).slice(
                            0,
                            500,
                          ),
                        }),
                      );
                    }
                    const automationError = automationErrorForDraftException(error);
                    if (automationError !== undefined) throw automationError;
                    throw error;
                  }
                  if (result?.providerMode !== "pi_authored") {
                    throw new AutomationAdapterError("AUTOMATION_PI_DRAFT_NOT_AUTHORED");
                  }
                  binding.knownProviderRunIds.add(result.providerRunId);
                  return { ...result, articleTemplateId: attemptPlan.articleTemplateId };
                };

                // A validated draft that still references fact IDs without their
                // verbatim text is a content-model miss, not a provider outage.
                // Rotate to a fresh Pi session and a different diversity plan.
                let lastDraftError: unknown;
                for (let selfHeal = 0; selfHeal <= DRAFT_INPUT_SELF_HEAL_ATTEMPTS; selfHeal += 1) {
                  const attemptPlan = nextDraftPlan();
                  try {
                    return await authorOnce(attemptPlan, selfHeal);
                  } catch (error) {
                    if (
                      selfHeal < DRAFT_INPUT_SELF_HEAL_ATTEMPTS &&
                      error instanceof AutomationAdapterError &&
                      error.code === "AUTOMATION_PI_DRAFT_INPUT_INVALID"
                    ) {
                      lastDraftError = error;
                      console.warn(
                        JSON.stringify({
                          level: "warn",
                          event: "agent_mcp.automation_pi_draft_input_self_heal",
                          tenantId: binding.principal.tenantId,
                          runId: binding.runId,
                          attempt: binding.attempt,
                          retry: selfHeal + 1,
                          maxRetries: DRAFT_INPUT_SELF_HEAL_ATTEMPTS,
                          articleTemplateId: attemptPlan.articleTemplateId,
                        }),
                      );
                      continue;
                    }
                    throw error;
                  }
                }
                throw lastDraftError;
              };
              return {
                author: async (
                  input: Parameters<NonNullable<PiAgentRunService["authorAutomationDraft"]>>[1],
                  authorSignal?: AbortSignal,
                ) => authorWithPlan(input, authorSignal),
                authorAlternate: async (
                  input: Parameters<NonNullable<PiAgentRunService["authorAutomationDraft"]>>[1],
                  authorSignal?: AbortSignal,
                ) => authorWithPlan(input, authorSignal),
              };
            })()
          : undefined;
      const runtime = new ScheduledAutomationRuntime(
        this.#runtimeForPrincipal(binding.principal),
        draftAuthor,
        {
          contentRemediationAttempts: run.automationRemediationEnabled === false ? 0 : 2,
          targetConcurrency: Math.max(3, Math.min(5, run.targets.length)),
          resourceConflictRetryAttempts: 2,
          resourceConflictRetryDelayMs: 2_000,
        },
      );
      await runtime.run(
        {
          tenantId: binding.principal.tenantId,
          brandId: run.brandId,
          campaignId: run.campaignId,
          runId: run.id,
          executionLevel: run.executionLevel,
          topic: run.brief,
          ...(run.contentItemId === null ? {} : { contentItemId: run.contentItemId }),
          ...(run.contentVersionId === null ? {} : { contentVersionId: run.contentVersionId }),
          ...(binding.draftTrace === undefined ? {} : { draftTrace: binding.draftTrace }),
          mediaSearchCompleted:
            binding.mediaCompletedPlatforms === undefined &&
            ((run.checkpoint.stage === "media" &&
              licensedMediaProvider(run.checkpoint.provider) &&
              run.checkpoint.mediaComplete !== false) ||
              (licensedMediaProvider(run.checkpoint.mediaProvider) &&
                run.checkpoint.mediaComplete !== false)),
          ...(binding.mediaCompletedPlatforms === undefined
            ? {}
            : { mediaSearchCompletedPlatforms: binding.mediaCompletedPlatforms }),
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
            ...(target.lastErrorMessage === null ? {} : { errorMessage: target.lastErrorMessage }),
            ...(target.remediation === null
              ? {}
              : (() => {
                  const remediation = parseAutomationRemediationPlan(target.remediation);
                  return remediation === null ? {} : { remediation };
                })()),
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
      assertPublicationBinding(job, target, run.executionLevel);
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
      if (job.state === "confirmed") {
        await this.#checkpointDeliveryTarget(binding, target, "confirmed", undefined, signal);
        progressed = true;
        continue;
      }
      if (ACTIVE_DELIVERY_STATES.has(job.state)) continue;
      const code = safeErrorCode(
        job.lastErrorCode,
        `AUTOMATION_PUBLICATION_${job.state.toUpperCase()}`,
      );
      await this.#checkpointDeliveryTarget(binding, target, "delivery_failed", code, signal);
      progressed = true;
    }
    if (!progressed) return run;
    const updated = await this.#api.getAutomationRun(binding.principal, binding.runId, signal);
    assertRunLease(updated, binding);
    return updated;
  }

  async #checkpointDeliveryTarget(
    binding: LeaseBinding,
    target: AutomationRunTargetView,
    state: "preview_completed" | "confirmed" | "delivery_failed",
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
          checkpoint: checkpointRecord(
            binding,
            { stage: "delivery", targetId: target.id, state },
            binding.draftTraceByTargetId.get(target.id) ?? binding.draftTrace,
          ),
          leaseSeconds: binding.leaseSeconds,
          signal,
        },
      );
      assertMutationAccepted(result);
      binding.stage = "delivery";
      binding.checkpoint = checkpointRecord(
        binding,
        {
          stage: "delivery",
          targetId: target.id,
          state,
        },
        binding.draftTraceByTargetId.get(target.id) ?? binding.draftTrace,
      );
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
            ...(failure.message === undefined
              ? {}
              : { errorMessage: failure.message.slice(0, 4_000) }),
            checkpoint: checkpointRecord(
              binding,
              {
                stage: "targets",
                targetId: target.id,
                state: "failed",
              },
              binding.draftTraceByTargetId.get(target.id) ?? binding.draftTrace,
            ),
            leaseSeconds: binding.leaseSeconds,
          },
        );
        assertMutationAccepted(result);
        binding.stage = "targets";
        binding.checkpoint = checkpointRecord(binding, {
          stage: "targets",
          targetId: target.id,
          state: "failed",
        });
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
          ...(checkpoint.state === "failed" || checkpoint.state === "retry_wait"
            ? checkpoint.failure.message === undefined
              ? {}
              : { errorMessage: checkpoint.failure.message.slice(0, 4_000) }
            : {}),
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
    if (["blocked", "failed", "delivery_failed", "cancelled"].includes(run.state)) {
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
    if (claim.attempt >= run.maxAttempts) return { disposition: "confirmed_failed" };
    return { disposition: "retry_safe" };
  }
}

export function createGeoAutomationProducerDependencies(
  options: GeoAutomationProducerAdapterOptions,
): AutomationProducerDependencies<AutomationRunView, GeoAutomationRunResult> {
  return new GeoAutomationProducerAdapter(options).dependencies();
}
