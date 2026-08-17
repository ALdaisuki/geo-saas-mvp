import { randomUUID } from "node:crypto";

import type { CtripBridgeResult } from "@geo/contracts";

import { DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT } from "./browser-host-admission-gate.js";
import type { BrowserHostAdmissionGate } from "./browser-host-admission-gate.js";

export interface CtripPreparationPollService {
  prepareNext(requestId: string): Promise<CtripBridgeResult | null>;
  submitNext?(requestId: string): Promise<CtripBridgeResult | null>;
  readbackNext?(requestId: string): Promise<CtripBridgeResult | null>;
  /** Distinct accounts with runnable variants; used to size delivery workers. */
  runnableDeliveryAccountCount?(): Promise<number>;
}

export interface CtripPreparationPoller {
  stop(): Promise<void>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export function startCtripPreparationPoller(options: {
  readonly services: readonly CtripPreparationPollService[];
  readonly pollIntervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly readbackBackoffMs?: number;
  readonly admissionBackoffMs?: number;
  /** Host-safe upper bound. The active worker count is demand-driven below this cap. */
  readonly concurrency?: number;
  readonly demandSampleMs?: number;
  readonly admissionGate?: BrowserHostAdmissionGate;
  /** CPU watermark used to scale down workers before the admission gate pauses claims. */
  readonly cpuPausePercent?: number;
  readonly onError?: (error: unknown) => void;
}): CtripPreparationPoller {
  if (options.services.length === 0) {
    throw new TypeError("Ctrip preparation poller requires at least one service");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const errorBackoffMs = options.errorBackoffMs ?? 5_000;
  // Ctrip moderation can take several minutes. Keep readback polling gentle while
  // allowing the database-backed readback budget to observe a delayed publication.
  const readbackBackoffMs = options.readbackBackoffMs ?? 60_000;
  const admissionBackoffMs = options.admissionBackoffMs ?? 5_000;
  const maxConcurrency = options.concurrency ?? 1;
  const demandSampleMs = options.demandSampleMs ?? 1_000;
  const cpuPausePercent = options.cpuPausePercent ?? DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 100 ||
    pollIntervalMs > 60_000 ||
    !Number.isSafeInteger(errorBackoffMs) ||
    errorBackoffMs < 100 ||
    errorBackoffMs > 300_000 ||
    !Number.isSafeInteger(readbackBackoffMs) ||
    readbackBackoffMs < 100 ||
    readbackBackoffMs > 300_000 ||
    !Number.isSafeInteger(admissionBackoffMs) ||
    admissionBackoffMs < 100 ||
    admissionBackoffMs > 300_000 ||
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 8 ||
    !Number.isSafeInteger(demandSampleMs) ||
    demandSampleMs < 100 ||
    demandSampleMs > 60_000 ||
    !Number.isFinite(cpuPausePercent) ||
    cpuPausePercent < 1 ||
    cpuPausePercent > 1_000
  ) {
    throw new TypeError("Ctrip preparation poller intervals are invalid");
  }
  const abortController = new AbortController();
  const signal = abortController.signal;
  const onError = options.onError ?? (() => undefined);
  const admitted = async (): Promise<boolean> => options.admissionGate?.canClaim() ?? true;
  const dynamicDemand = options.services.some(
    (service) => service.runnableDeliveryAccountCount !== undefined,
  );
  let targetConcurrency = dynamicDemand ? 1 : maxConcurrency;
  let nextDemandSampleAt = 0;
  let demandSample: Promise<number> | null = null;
  let smoothedNormalizedCpu: number | null = null;
  let lastCpuAllowance = maxConcurrency;
  const sampleDemand = async (): Promise<number> => {
    if (!dynamicDemand) return maxConcurrency;
    const now = Date.now();
    if (now < nextDemandSampleAt && demandSample === null) return targetConcurrency;
    if (demandSample !== null) return demandSample;
    demandSample = (async () => {
      try {
        const counts = await Promise.all(
          options.services.map(async (service) => {
            if (service.runnableDeliveryAccountCount === undefined) return 0;
            const value = await service.runnableDeliveryAccountCount();
            return Number.isSafeInteger(value) && value > 0 ? value : 0;
          }),
        );
        const runnableAccounts = counts.reduce((sum, value) => sum + value, 0);
        let cpuAllowance = maxConcurrency;
        if (options.admissionGate?.snapshot !== undefined) {
          const snapshot = await options.admissionGate.snapshot().catch(() => null);
          if (snapshot !== undefined && snapshot !== null && snapshot.cpuSampleAgeMs <= 5_000) {
            const coreCount =
              Number.isSafeInteger(snapshot.cpuCoreCount) && snapshot.cpuCoreCount >= 1
                ? snapshot.cpuCoreCount
                : 1;
            const normalizedCpu = snapshot.cpuUtilizationPercent / coreCount;
            const hostCpu = snapshot.hostCpuUtilizationPercent ?? 0;
            const effectiveCpu = Math.max(normalizedCpu, hostCpu);
            smoothedNormalizedCpu =
              smoothedNormalizedCpu === null
                ? effectiveCpu
                : smoothedNormalizedCpu * 0.7 + effectiveCpu * 0.3;
            const resumeAt = cpuPausePercent * 0.45;
            const reduceAt = cpuPausePercent * 0.55;
            const desired =
              effectiveCpu >= cpuPausePercent
                ? 1
                : Math.max(
                    1,
                    Math.min(
                      maxConcurrency,
                      Math.ceil(
                        Math.max(0, maxConcurrency * (1 - smoothedNormalizedCpu / cpuPausePercent)),
                      ),
                    ),
                  );
            if (desired > lastCpuAllowance && effectiveCpu > resumeAt) {
              cpuAllowance = lastCpuAllowance;
            } else if (desired < lastCpuAllowance && effectiveCpu < reduceAt) {
              cpuAllowance = lastCpuAllowance;
            } else {
              cpuAllowance = desired;
            }
            lastCpuAllowance = cpuAllowance;
          } else {
            cpuAllowance = 1;
            lastCpuAllowance = 1;
          }
        }
        // One worker remains alive to notice newly queued work; otherwise each
        // account gets one worker up to the host-safe cap. This is the demand
        // controller, while the browser-host gate remains the final admission check.
        targetConcurrency = Math.max(1, Math.min(maxConcurrency, runnableAccounts, cpuAllowance));
        return targetConcurrency;
      } catch (error) {
        onError(error);
        targetConcurrency = 1;
        lastCpuAllowance = 1;
        return targetConcurrency;
      } finally {
        nextDemandSampleAt = Date.now() + demandSampleMs;
        demandSample = null;
      }
    })();
    return demandSample;
  };
  const runDeliveryWorker = async (workerIndex: number) => {
    let cycle = 0;
    while (!signal.aborted) {
      const activeWorkers = await sampleDemand();
      if (workerIndex >= activeWorkers) {
        await delay(Math.min(demandSampleMs, 500), signal);
        continue;
      }
      let claimed = false;
      let failed = false;
      let paused = false;
      // Rotate the first service each cycle so a busy platform cannot starve
      // other platforms when all services share one poller.
      const start = (workerIndex + cycle) % options.services.length;
      for (let offset = 0; offset < options.services.length; offset += 1) {
        const service = options.services[(start + offset) % options.services.length];
        if (service === undefined) continue;
        if (signal.aborted) break;
        try {
          if (!(await admitted())) {
            paused = true;
            break;
          }
          const result = await service.prepareNext(`ctrip-prepare-poll:${randomUUID()}`);
          claimed ||= result !== null;
          if (service.submitNext !== undefined) {
            if (!(await admitted())) {
              paused = true;
              break;
            }
            const submitResult = await service.submitNext(`ctrip-submit-poll:${randomUUID()}`);
            claimed ||= submitResult !== null;
          }
        } catch (error) {
          failed = true;
          onError(error);
          break;
        }
      }
      cycle += 1;
      if (signal.aborted) break;
      if (failed) await delay(errorBackoffMs, signal);
      else if (paused) await delay(admissionBackoffMs, signal);
      else if (!claimed) await delay(pollIntervalMs, signal);
    }
  };
  const readbackServices = options.services.filter(
    (
      service,
    ): service is CtripPreparationPollService &
      Required<Pick<CtripPreparationPollService, "readbackNext">> =>
      service.readbackNext !== undefined,
  );
  const runReadbackWorker = async () => {
    while (!signal.aborted && readbackServices.length > 0) {
      let claimed = false;
      let failed = false;
      let paused = false;
      let readbackPending = false;
      for (const service of readbackServices) {
        if (signal.aborted) break;
        try {
          if (!(await admitted())) {
            paused = true;
            break;
          }
          const result = await service.readbackNext(`ctrip-readback-poll:${randomUUID()}`);
          claimed ||= result !== null;
          readbackPending ||= result?.command === "readback" && result.state === "readback_pending";
        } catch (error) {
          failed = true;
          onError(error);
          break;
        }
      }
      if (signal.aborted) break;
      if (failed) await delay(errorBackoffMs, signal);
      else if (paused) await delay(admissionBackoffMs, signal);
      else if (readbackPending) await delay(readbackBackoffMs, signal);
      else if (!claimed) await delay(pollIntervalMs, signal);
    }
  };
  const done = Promise.all([
    ...Array.from({ length: maxConcurrency }, (_, workerIndex) => runDeliveryWorker(workerIndex)),
    runReadbackWorker(),
  ]).then(() => undefined);
  return Object.freeze({
    stop: async () => {
      abortController.abort();
      await done;
    },
  });
}
