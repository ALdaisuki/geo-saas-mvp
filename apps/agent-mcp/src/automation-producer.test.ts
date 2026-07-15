import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATION_PRODUCER_MAX_CONCURRENCY,
  AutomationProducer,
  type AutomationProducerDependencies,
  type AutomationRunClaim,
} from "./automation-producer.js";

interface TestPayload {
  readonly prompt: string;
}

interface TestResult {
  readonly publicationJobId: string;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function runClaim(
  runId: string,
  options: { readonly attempt?: number; readonly allowed?: boolean } = {},
): AutomationRunClaim<TestPayload> {
  return {
    runId,
    tenantId: `tenant-${runId}`,
    leaseToken: `lease-secret-${runId}`,
    attempt: options.attempt ?? 1,
    tenantGate: {
      allowed: options.allowed ?? true,
      evaluatedAt: "2026-07-15T00:00:00.000Z",
    },
    payload: { prompt: `prompt-secret-${runId}` },
  };
}

function dependencies(
  overrides: Partial<AutomationProducerDependencies<TestPayload, TestResult>> = {},
) {
  const defaults: AutomationProducerDependencies<TestPayload, TestResult> = {
    claimRun: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ leaseValid: true as const })),
    executeRun: vi.fn(async (run) => ({ publicationJobId: `job-${run.runId}` })),
    checkpoint: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ disposition: "unresolved" as const })),
  };
  return { ...defaults, ...overrides };
}

function enabledProducer(
  deps: AutomationProducerDependencies<TestPayload, TestResult>,
  overrides: Partial<
    ConstructorParameters<typeof AutomationProducer<TestPayload, TestResult>>[1]
  > = {},
) {
  return new AutomationProducer(deps, {
    producerId: "producer-test-1",
    enabled: true,
    pollIntervalMs: 100,
    leaseDurationMs: 5_000,
    heartbeatIntervalMs: 1_000,
    backoffBaseMs: 100,
    backoffMaxMs: 2_000,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("AutomationProducer", () => {
  it("keeps polling disabled by default", async () => {
    const deps = dependencies();
    const producer = new AutomationProducer(deps, { producerId: "disabled-producer" });

    await producer.start();

    expect(deps.claimRun).not.toHaveBeenCalled();
    expect(producer.health()).toEqual({
      enabled: false,
      running: false,
      lastTick: null,
      activeRuns: 0,
      lastError: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("executes only an API claim with an affirmative tenant gate and heartbeats its lease", async () => {
    const execution = deferred<TestResult>();
    const claim = runClaim("allowed");
    const deps = dependencies({
      claimRun: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      executeRun: vi.fn(() => execution.promise),
    });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.executeRun).toHaveBeenCalledWith(claim, expect.any(AbortSignal));
    expect(producer.health()).toMatchObject({ running: true, activeRuns: 1 });
    expect(JSON.stringify(producer.health())).not.toContain("prompt-secret");
    expect(JSON.stringify(producer.health())).not.toContain("lease-secret");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        producerId: "producer-test-1",
        runId: "allowed",
        leaseToken: "lease-secret-allowed",
        leaseDurationMs: 5_000,
        signal: expect.any(AbortSignal),
      }),
    );

    execution.resolve({ publicationJobId: "job-allowed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.checkpoint).toHaveBeenCalledWith({
      producerId: "producer-test-1",
      runId: "allowed",
      leaseToken: "lease-secret-allowed",
      state: "succeeded",
      result: { publicationJobId: "job-allowed" },
    });

    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a denied tenant claim without executing its payload", async () => {
    const claim = runClaim("denied", { allowed: false });
    const deps = dependencies({
      claimRun: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.checkpoint).toHaveBeenCalledWith({
      producerId: "producer-test-1",
      runId: "denied",
      leaseToken: "lease-secret-denied",
      state: "released",
      reason: "tenant_gate_not_allowed",
    });
    expect(producer.health().lastError).toMatchObject({
      operation: "claim",
      kind: "permanent",
      code: "AUTOMATION_TENANT_GATE_NOT_ALLOWED",
    });
    expect(JSON.stringify(producer.health())).not.toContain("prompt-secret-denied");

    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never exceeds fixed concurrency and waits for a later tick before claiming more", async () => {
    const first = deferred<TestResult>();
    const second = deferred<TestResult>();
    const third = deferred<TestResult>();
    const claims = [runClaim("one"), runClaim("two"), runClaim("three")];
    const executions = new Map([
      ["one", first],
      ["two", second],
      ["three", third],
    ]);
    const deps = dependencies({
      claimRun: vi
        .fn()
        .mockResolvedValueOnce(claims[0])
        .mockResolvedValueOnce(claims[1])
        .mockResolvedValueOnce(claims[2])
        .mockResolvedValue(null),
      executeRun: vi.fn((run) => {
        const execution = executions.get(run.runId);
        if (execution === undefined) throw new Error("Unexpected test run");
        return execution.promise;
      }),
    });
    const producer = enabledProducer(deps, { concurrency: 2 });
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.claimRun).toHaveBeenCalledTimes(2);
    expect(deps.executeRun).toHaveBeenCalledTimes(2);
    expect(producer.health().activeRuns).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(deps.claimRun).toHaveBeenCalledTimes(2);

    first.resolve({ publicationJobId: "job-one" });
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.claimRun).toHaveBeenCalledTimes(3);
    expect(deps.executeRun).toHaveBeenCalledTimes(3);
    expect(producer.health().activeRuns).toBe(2);

    second.resolve({ publicationJobId: "job-two" });
    third.resolve({ publicationJobId: "job-three" });
    await vi.advanceTimersByTimeAsync(0);
    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains active work while stopping acquisition immediately", async () => {
    const execution = deferred<TestResult>();
    let executionSignal: AbortSignal | undefined;
    const deps = dependencies({
      claimRun: vi.fn().mockResolvedValueOnce(runClaim("drain")).mockResolvedValue(null),
      executeRun: vi.fn((_run, signal) => {
        executionSignal = signal;
        return execution.promise;
      }),
    });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = producer.stop({ mode: "drain" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.claimRun).toHaveBeenCalledTimes(1);
    expect(executionSignal?.aborted).toBe(false);

    execution.resolve({ publicationJobId: "job-drain" });
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    await lifecycle;
    expect(producer.health()).toMatchObject({ running: false, activeRuns: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a claim that arrives after stop began and never executes it", async () => {
    const pendingClaim = deferred<AutomationRunClaim<TestPayload> | null>();
    const deps = dependencies({
      claimRun: vi.fn(() => pendingClaim.promise),
    });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = producer.stop();
    pendingClaim.resolve(runClaim("late-claim"));
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    await lifecycle;

    expect(deps.claimRun).toHaveBeenCalledTimes(1);
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.checkpoint).toHaveBeenCalledWith({
      producerId: "producer-test-1",
      runId: "late-claim",
      leaseToken: "lease-secret-late-claim",
      state: "released",
      reason: "producer_stopped",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and reconciles active work when the external stop signal fires", async () => {
    const deps = dependencies({
      claimRun: vi.fn().mockResolvedValueOnce(runClaim("abort")).mockResolvedValue(null),
      executeRun: vi.fn(
        (_run, signal) =>
          new Promise<TestResult>((_resolvePromise, rejectPromise) => {
            signal.addEventListener(
              "abort",
              () => rejectPromise(new DOMException("stopped secret", "AbortError")),
              { once: true },
            );
          }),
      ),
      reconcile: vi.fn(async () => ({ disposition: "retry_safe" as const })),
    });
    const producer = enabledProducer(deps);
    const controller = new AbortController();
    const lifecycle = producer.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await lifecycle;

    expect(deps.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        producerId: "producer-test-1",
        run: expect.objectContaining({ runId: "abort" }),
        failure: expect.objectContaining({ kind: "aborted" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(deps.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "abort",
        state: "retry_wait",
        requiresReconciliation: false,
      }),
    );
    expect(JSON.stringify(producer.health())).not.toContain("stopped secret");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a lost heartbeat uncertain and requires reconciliation before retry", async () => {
    const deps = dependencies({
      claimRun: vi.fn().mockResolvedValueOnce(runClaim("heartbeat")).mockResolvedValue(null),
      heartbeat: vi.fn(async () => {
        throw { code: "LEASE_NETWORK_ERROR", retryable: true };
      }),
      executeRun: vi.fn(
        (_run, signal) =>
          new Promise<TestResult>((_resolvePromise, rejectPromise) => {
            signal.addEventListener(
              "abort",
              () => rejectPromise(new DOMException("lease lost", "AbortError")),
              { once: true },
            );
          }),
      ),
      reconcile: vi.fn(async () => ({ disposition: "unresolved" as const })),
    });
    const producer = enabledProducer(deps, { heartbeatIntervalMs: 100 });
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(deps.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { kind: "uncertain", code: "LEASE_NETWORK_ERROR" },
      }),
    );
    expect(deps.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "heartbeat",
        state: "retry_wait",
        failure: { kind: "uncertain", code: "LEASE_NETWORK_ERROR" },
        requiresReconciliation: true,
      }),
    );

    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies retryable execution failures and applies attempt-based exponential backoff", async () => {
    const deps = dependencies({
      claimRun: vi
        .fn()
        .mockResolvedValueOnce(runClaim("retry", { attempt: 3 }))
        .mockResolvedValue(null),
      executeRun: vi.fn(async () => {
        throw { code: "PLATFORM_RATE_LIMIT", retryable: true };
      }),
    });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.checkpoint).toHaveBeenCalledWith({
      producerId: "producer-test-1",
      runId: "retry",
      leaseToken: "lease-secret-retry",
      state: "retry_wait",
      failure: { kind: "retryable", code: "PLATFORM_RATE_LIMIT" },
      retryAfterMs: 400,
      requiresReconciliation: false,
    });

    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated claim failures exponentially without exposing error messages", async () => {
    const claimRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("credential-secret-one"))
      .mockRejectedValueOnce(new Error("credential-secret-two"))
      .mockResolvedValue(null);
    const deps = dependencies({ claimRun });
    const producer = enabledProducer(deps);
    const lifecycle = producer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(claimRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimRun).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(claimRun).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimRun).toHaveBeenCalledTimes(3);
    expect(producer.health().lastError).toMatchObject({
      operation: "claim",
      kind: "retryable",
      code: "AUTOMATION_CLAIM_FAILED",
    });
    expect(JSON.stringify(producer.health())).not.toContain("credential-secret");

    await producer.stop();
    await lifecycle;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsafe concurrency and heartbeat configuration", () => {
    const deps = dependencies();
    expect(
      () =>
        new AutomationProducer(deps, {
          producerId: "too-wide",
          concurrency: AUTOMATION_PRODUCER_MAX_CONCURRENCY + 1,
        }),
    ).toThrow(/concurrency cannot exceed/);
    expect(
      () =>
        new AutomationProducer(deps, {
          producerId: "bad-heartbeat",
          leaseDurationMs: 1_000,
          heartbeatIntervalMs: 1_000,
        }),
    ).toThrow(/heartbeatIntervalMs must be shorter/);
  });
});
