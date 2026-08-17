export const AUTOMATION_PRODUCER_MAX_CONCURRENCY = 16;

export type AutomationFailureKind = "retryable" | "permanent" | "uncertain" | "aborted";

export type AutomationProducerOperation =
  "claim" | "heartbeat" | "execute" | "checkpoint" | "reconcile";

export interface AutomationFailure {
  readonly kind: AutomationFailureKind;
  readonly code: string;
  readonly message?: string;
}

export interface AutomationTenantGate {
  readonly allowed: boolean;
  readonly evaluatedAt: string;
}

/**
 * The API owns eligibility, tenancy and lease persistence. The producer treats the
 * payload as opaque and will only execute claims carrying an affirmative tenant gate.
 */
export interface AutomationRunClaim<TPayload = unknown> {
  readonly runId: string;
  readonly tenantId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly tenantGate: AutomationTenantGate;
  readonly payload: TPayload;
}

export interface AutomationClaimRequest {
  readonly producerId: string;
  readonly leaseDurationMs: number;
  readonly signal: AbortSignal;
}

export interface AutomationHeartbeatRequest {
  readonly producerId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly signal: AbortSignal;
}

export interface AutomationHeartbeatResult {
  readonly leaseValid: true;
}

interface AutomationCheckpointBase {
  readonly producerId: string;
  readonly runId: string;
  readonly leaseToken: string;
}

export type AutomationCheckpoint<TResult = unknown> =
  | (AutomationCheckpointBase & {
      readonly state: "succeeded";
      readonly result: TResult;
    })
  | (AutomationCheckpointBase & {
      readonly state: "retry_wait";
      readonly failure: AutomationFailure;
      readonly retryAfterMs: number;
      readonly requiresReconciliation: boolean;
    })
  | (AutomationCheckpointBase & {
      readonly state: "failed";
      readonly failure: AutomationFailure;
    })
  | (AutomationCheckpointBase & {
      readonly state: "released";
      readonly reason: "producer_stopped" | "tenant_gate_not_allowed" | "duplicate_claim";
    });

export interface AutomationReconcileRequest<TPayload = unknown> {
  readonly producerId: string;
  readonly run: Readonly<AutomationRunClaim<TPayload>>;
  readonly failure: AutomationFailure;
  readonly signal: AbortSignal;
}

export type AutomationReconciliation<TResult = unknown> =
  | { readonly disposition: "confirmed_succeeded"; readonly result: TResult }
  | { readonly disposition: "confirmed_failed" }
  | { readonly disposition: "retry_safe" }
  | { readonly disposition: "unresolved" };

export interface AutomationProducerDependencies<TPayload = unknown, TResult = unknown> {
  claimRun(request: AutomationClaimRequest): Promise<AutomationRunClaim<TPayload> | null>;
  heartbeat(request: AutomationHeartbeatRequest): Promise<AutomationHeartbeatResult>;
  executeRun(run: Readonly<AutomationRunClaim<TPayload>>, signal: AbortSignal): Promise<TResult>;
  checkpoint(checkpoint: AutomationCheckpoint<TResult>): Promise<void>;
  reconcile(
    request: AutomationReconcileRequest<TPayload>,
  ): Promise<AutomationReconciliation<TResult>>;
}

export interface AutomationFailureContext {
  readonly operation: AutomationProducerOperation;
}

export type AutomationFailureClassifier = (
  error: unknown,
  context: AutomationFailureContext,
) => AutomationFailure;

export interface AutomationProducerOptions {
  readonly producerId: string;
  /** Polling is fail-closed and disabled unless explicitly enabled. */
  readonly enabled?: boolean;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly classifyFailure?: AutomationFailureClassifier;
  readonly now?: () => Date;
}

export interface AutomationProducerLastError extends AutomationFailure {
  readonly operation: AutomationProducerOperation;
  readonly at: string;
}

export interface AutomationProducerHealth {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly lastTick: string | null;
  readonly activeRuns: number;
  readonly lastError: AutomationProducerLastError | null;
}

export interface AutomationProducerStopOptions {
  /** Drain preserves active executions; abort signals them and reconciles their outcome. */
  readonly mode?: "drain" | "abort";
}

interface ActiveRun {
  readonly controller: AbortController;
  promise: Promise<void>;
  shutdownAborted: boolean;
}

interface ErrorLike {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly retryable?: unknown;
  readonly uncertain?: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function errorLike(error: unknown): ErrorLike | undefined {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : undefined;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const code = errorLike(error)?.code;
  return typeof code === "string" && SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function errorStatus(error: unknown): number | undefined {
  const candidate = errorLike(error);
  const value = candidate?.statusCode ?? candidate?.status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return errorLike(error)?.name === "AbortError";
}

export function classifyAutomationFailure(
  error: unknown,
  context: AutomationFailureContext,
): AutomationFailure {
  const candidate = errorLike(error);
  const fallbackCode = `AUTOMATION_${context.operation.toUpperCase()}_FAILED`;
  const code = safeErrorCode(error, fallbackCode);

  const controlledFailure =
    candidate !== undefined &&
    (candidate.retryable === true || candidate.retryable === false || candidate.uncertain === true);
  const message =
    controlledFailure && error instanceof Error ? error.message.slice(0, 4_000) : undefined;
  const withMessage = (failure: Omit<AutomationFailure, "message">): AutomationFailure =>
    message === undefined || message === "" ? failure : { ...failure, message };

  if (isAbortError(error)) return withMessage({ kind: "aborted", code });
  if (candidate?.uncertain === true) return withMessage({ kind: "uncertain", code });
  if (candidate?.retryable === false) return withMessage({ kind: "permanent", code });
  if (candidate?.retryable === true) return withMessage({ kind: "retryable", code });

  const status = errorStatus(error);
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  ) {
    return withMessage({ kind: "permanent", code });
  }

  // An execution or lost heartbeat may have crossed an external side-effect boundary.
  if (context.operation === "execute" || context.operation === "heartbeat") {
    return withMessage({ kind: "uncertain", code });
  }
  return withMessage({ kind: "retryable", code });
}

export function automationBackoffMs(
  attempt: number,
  baseMs = DEFAULT_BACKOFF_BASE_MS,
  maxMs = DEFAULT_BACKOFF_MAX_MS,
): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const exponent = Math.min(30, safeAttempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function requiredPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolvePromise(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function hasLeaseIdentity(value: unknown): value is AutomationRunClaim<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Partial<AutomationRunClaim<unknown>>;
  return (
    typeof claim.runId === "string" &&
    claim.runId.length > 0 &&
    typeof claim.tenantId === "string" &&
    claim.tenantId.length > 0 &&
    typeof claim.leaseToken === "string" &&
    claim.leaseToken.length > 0 &&
    typeof claim.attempt === "number" &&
    Number.isSafeInteger(claim.attempt) &&
    claim.attempt > 0
  );
}

function hasAllowedTenantGate<TPayload>(
  claim: AutomationRunClaim<TPayload>,
): claim is AutomationRunClaim<TPayload> & {
  readonly tenantGate: { readonly allowed: true; readonly evaluatedAt: string };
} {
  return (
    typeof claim.tenantGate === "object" &&
    claim.tenantGate !== null &&
    claim.tenantGate.allowed === true &&
    typeof claim.tenantGate.evaluatedAt === "string" &&
    claim.tenantGate.evaluatedAt.length > 0
  );
}

export class AutomationProducer<TPayload = unknown, TResult = unknown> {
  readonly #dependencies: AutomationProducerDependencies<TPayload, TResult>;
  readonly #producerId: string;
  readonly #enabled: boolean;
  readonly #concurrency: number;
  readonly #pollIntervalMs: number;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #classifyFailure: AutomationFailureClassifier;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveRun>();

  #running = false;
  #lastTick: string | null = null;
  #lastError: AutomationProducerLastError | null = null;
  #pollFailureCount = 0;
  #acquisitionController: AbortController | undefined;
  #lifecycle: Promise<void> | undefined;

  constructor(
    dependencies: AutomationProducerDependencies<TPayload, TResult>,
    options: AutomationProducerOptions,
  ) {
    if (options.producerId.trim().length === 0 || options.producerId.length > 128) {
      throw new TypeError("producerId must contain between 1 and 128 characters");
    }
    this.#dependencies = dependencies;
    this.#producerId = options.producerId;
    this.#enabled = options.enabled ?? false;
    this.#concurrency = requiredPositiveInteger(options.concurrency ?? 1, "concurrency");
    if (this.#concurrency > AUTOMATION_PRODUCER_MAX_CONCURRENCY) {
      throw new TypeError(
        `concurrency cannot exceed ${String(AUTOMATION_PRODUCER_MAX_CONCURRENCY)}`,
      );
    }
    this.#pollIntervalMs = requiredPositiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#leaseDurationMs = requiredPositiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#heartbeatIntervalMs = requiredPositiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    if (this.#heartbeatIntervalMs >= this.#leaseDurationMs) {
      throw new TypeError("heartbeatIntervalMs must be shorter than leaseDurationMs");
    }
    this.#backoffBaseMs = requiredPositiveInteger(
      options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      "backoffBaseMs",
    );
    this.#backoffMaxMs = requiredPositiveInteger(
      options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      "backoffMaxMs",
    );
    if (this.#backoffBaseMs > this.#backoffMaxMs) {
      throw new TypeError("backoffBaseMs cannot exceed backoffMaxMs");
    }
    this.#classifyFailure = options.classifyFailure ?? classifyAutomationFailure;
    this.#now = options.now ?? (() => new Date());
  }

  health(): AutomationProducerHealth {
    return {
      enabled: this.#enabled,
      running: this.#running,
      lastTick: this.#lastTick,
      activeRuns: this.#active.size,
      lastError: this.#lastError === null ? null : { ...this.#lastError },
    };
  }

  start(signal?: AbortSignal): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#lifecycle !== undefined) return this.#lifecycle;

    const controller = new AbortController();
    this.#acquisitionController = controller;
    this.#running = true;

    const abortFromSignal = () => this.#requestStop("abort");
    if (signal?.aborted === true) abortFromSignal();
    else signal?.addEventListener("abort", abortFromSignal, { once: true });

    const lifecycle = this.#runLoop(controller.signal).finally(() => {
      signal?.removeEventListener("abort", abortFromSignal);
      this.#running = false;
      this.#acquisitionController = undefined;
      this.#lifecycle = undefined;
    });
    this.#lifecycle = lifecycle;
    return lifecycle;
  }

  async stop(options: AutomationProducerStopOptions = {}): Promise<void> {
    const lifecycle = this.#lifecycle;
    if (lifecycle === undefined) return;
    this.#requestStop(options.mode ?? "drain");
    await lifecycle;
  }

  #requestStop(mode: "drain" | "abort"): void {
    this.#acquisitionController?.abort();
    if (mode !== "abort") return;
    for (const active of this.#active.values()) {
      active.shutdownAborted = true;
      active.controller.abort();
    }
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.#tick(signal);
      if (signal.aborted) break;
      const delayMs =
        this.#pollFailureCount === 0
          ? this.#pollIntervalMs
          : automationBackoffMs(this.#pollFailureCount, this.#backoffBaseMs, this.#backoffMaxMs);
      await waitForDelay(delayMs, signal);
    }
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
  }

  async #tick(signal: AbortSignal): Promise<void> {
    this.#lastTick = this.#now().toISOString();
    const availableSlots = Math.max(0, this.#concurrency - this.#active.size);

    for (let slot = 0; slot < availableSlots && !signal.aborted; slot += 1) {
      let claim: AutomationRunClaim<TPayload> | null;
      try {
        claim = await this.#dependencies.claimRun({
          producerId: this.#producerId,
          leaseDurationMs: this.#leaseDurationMs,
          signal,
        });
        this.#pollFailureCount = 0;
      } catch (error) {
        if (signal.aborted && isAbortError(error)) return;
        this.#pollFailureCount += 1;
        this.#recordError(error, "claim");
        return;
      }

      if (claim === null) return;
      if (!hasLeaseIdentity(claim)) {
        this.#recordFailure({ kind: "permanent", code: "AUTOMATION_CLAIM_INVALID" }, "claim");
        return;
      }
      if (signal.aborted) {
        await this.#safeCheckpoint({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          state: "released",
          reason: "producer_stopped",
        });
        return;
      }
      if (!hasAllowedTenantGate(claim)) {
        this.#recordFailure(
          { kind: "permanent", code: "AUTOMATION_TENANT_GATE_NOT_ALLOWED" },
          "claim",
        );
        await this.#safeCheckpoint({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          state: "released",
          reason: "tenant_gate_not_allowed",
        });
        continue;
      }
      if (this.#active.has(claim.runId)) {
        this.#recordFailure(
          { kind: "permanent", code: "AUTOMATION_DUPLICATE_ACTIVE_CLAIM" },
          "claim",
        );
        await this.#safeCheckpoint({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          state: "released",
          reason: "duplicate_claim",
        });
        continue;
      }
      this.#startRun(claim);
    }
  }

  #startRun(claim: AutomationRunClaim<TPayload>): void {
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      shutdownAborted: false,
      promise: Promise.resolve(),
    };
    const promise = this.#processRun(claim, active)
      .catch((error: unknown) => this.#recordError(error, "execute"))
      .finally(() => this.#active.delete(claim.runId));
    active.promise = promise;
    this.#active.set(claim.runId, active);
  }

  async #processRun(claim: AutomationRunClaim<TPayload>, active: ActiveRun): Promise<void> {
    const heartbeatController = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeatTask = this.#heartbeatLoop(
      claim,
      active.controller,
      heartbeatController.signal,
      (error) => {
        heartbeatFailure = error;
      },
    );

    let result: TResult | undefined;
    let executionError: unknown;
    let succeeded = false;
    try {
      result = await this.#dependencies.executeRun(claim, active.controller.signal);
      succeeded = true;
    } catch (error) {
      executionError = error;
    } finally {
      heartbeatController.abort();
      await heartbeatTask;
    }

    if (heartbeatFailure !== undefined) {
      const classified = this.#classify(heartbeatFailure, "heartbeat");
      const failure: AutomationFailure = { ...classified, kind: "uncertain" };
      this.#recordFailure(failure, "heartbeat");
      await this.#reconcileFailure(claim, failure);
      return;
    }

    if (succeeded) {
      await this.#safeCheckpoint({
        producerId: this.#producerId,
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        state: "succeeded",
        result: result as TResult,
      });
      return;
    }

    let failure = this.#classify(executionError, "execute");
    if (active.shutdownAborted) {
      failure = { ...failure, kind: "aborted" };
    }
    this.#recordFailure(failure, "execute");
    if (failure.kind === "uncertain" || failure.kind === "aborted") {
      await this.#reconcileFailure(claim, failure);
      return;
    }
    await this.#checkpointClassifiedFailure(claim, failure, false);
  }

  async #heartbeatLoop(
    claim: AutomationRunClaim<TPayload>,
    executionController: AbortController,
    stopSignal: AbortSignal,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    const heartbeatSignal = AbortSignal.any([executionController.signal, stopSignal]);
    while (await waitForDelay(this.#heartbeatIntervalMs, stopSignal)) {
      try {
        const result = await this.#dependencies.heartbeat({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          leaseDurationMs: this.#leaseDurationMs,
          signal: heartbeatSignal,
        });
        if (result.leaseValid !== true) {
          onFailure({ code: "AUTOMATION_LEASE_INVALID", uncertain: true });
          executionController.abort();
          return;
        }
      } catch (error) {
        if (stopSignal.aborted) return;
        onFailure(error);
        executionController.abort();
        return;
      }
    }
  }

  async #reconcileFailure(
    claim: AutomationRunClaim<TPayload>,
    failure: AutomationFailure,
  ): Promise<void> {
    const signal = new AbortController().signal;
    let reconciliation: AutomationReconciliation<TResult>;
    try {
      reconciliation = await this.#dependencies.reconcile({
        producerId: this.#producerId,
        run: claim,
        failure,
        signal,
      });
    } catch (error) {
      this.#recordError(error, "reconcile");
      await this.#checkpointClassifiedFailure(claim, failure, true);
      return;
    }

    switch (reconciliation.disposition) {
      case "confirmed_succeeded":
        await this.#safeCheckpoint({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          state: "succeeded",
          result: reconciliation.result,
        });
        return;
      case "confirmed_failed":
        await this.#safeCheckpoint({
          producerId: this.#producerId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          state: "failed",
          failure,
        });
        return;
      case "retry_safe":
        await this.#checkpointClassifiedFailure(claim, failure, false);
        return;
      case "unresolved":
        await this.#checkpointClassifiedFailure(claim, failure, true);
    }
  }

  async #checkpointClassifiedFailure(
    claim: AutomationRunClaim<TPayload>,
    failure: AutomationFailure,
    requiresReconciliation: boolean,
  ): Promise<void> {
    if (failure.kind === "permanent") {
      await this.#safeCheckpoint({
        producerId: this.#producerId,
        runId: claim.runId,
        leaseToken: claim.leaseToken,
        state: "failed",
        failure,
      });
      return;
    }
    await this.#safeCheckpoint({
      producerId: this.#producerId,
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      state: "retry_wait",
      failure,
      retryAfterMs: automationBackoffMs(claim.attempt, this.#backoffBaseMs, this.#backoffMaxMs),
      requiresReconciliation,
    });
  }

  async #safeCheckpoint(checkpoint: AutomationCheckpoint<TResult>): Promise<void> {
    try {
      await this.#dependencies.checkpoint(checkpoint);
    } catch (error) {
      this.#recordError(error, "checkpoint");
    }
  }

  #classify(error: unknown, operation: AutomationProducerOperation): AutomationFailure {
    try {
      const failure = this.#classifyFailure(error, { operation });
      if (
        !["retryable", "permanent", "uncertain", "aborted"].includes(failure.kind) ||
        !SAFE_CODE_PATTERN.test(failure.code)
      ) {
        return classifyAutomationFailure(error, { operation });
      }
      return failure;
    } catch {
      return classifyAutomationFailure(error, { operation });
    }
  }

  #recordError(error: unknown, operation: AutomationProducerOperation): void {
    this.#recordFailure(this.#classify(error, operation), operation);
  }

  #recordFailure(failure: AutomationFailure, operation: AutomationProducerOperation): void {
    this.#lastError = {
      operation,
      kind: failure.kind,
      code: failure.code,
      at: this.#now().toISOString(),
    };
  }
}
