import { randomUUID } from "node:crypto";

import type { CtripBridgeResult } from "@geo/contracts";

export interface CtripPreparationPollService {
  prepareNext(requestId: string): Promise<CtripBridgeResult | null>;
  submitNext?(requestId: string): Promise<CtripBridgeResult | null>;
  readbackNext?(requestId: string): Promise<CtripBridgeResult | null>;
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
  readonly onError?: (error: unknown) => void;
}): CtripPreparationPoller {
  if (options.services.length === 0) {
    throw new TypeError("Ctrip preparation poller requires at least one service");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const errorBackoffMs = options.errorBackoffMs ?? 5_000;
  const readbackBackoffMs = options.readbackBackoffMs ?? 30_000;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 100 ||
    pollIntervalMs > 60_000 ||
    !Number.isSafeInteger(errorBackoffMs) ||
    errorBackoffMs < 100 ||
    errorBackoffMs > 300_000 ||
    !Number.isSafeInteger(readbackBackoffMs) ||
    readbackBackoffMs < 100 ||
    readbackBackoffMs > 300_000
  ) {
    throw new TypeError("Ctrip preparation poller intervals are invalid");
  }
  const abortController = new AbortController();
  const signal = abortController.signal;
  const onError = options.onError ?? (() => undefined);
  const done = (async () => {
    while (!signal.aborted) {
      let claimed = false;
      let failed = false;
      let readbackPending = false;
      for (const service of options.services) {
        if (signal.aborted) break;
        try {
          const result = await service.prepareNext(`ctrip-prepare-poll:${randomUUID()}`);
          claimed ||= result !== null;
          if (service.submitNext !== undefined) {
            const submitResult = await service.submitNext(`ctrip-submit-poll:${randomUUID()}`);
            claimed ||= submitResult !== null;
          }
          if (service.readbackNext !== undefined) {
            const readbackResult = await service.readbackNext(`ctrip-readback-poll:${randomUUID()}`);
            claimed ||= readbackResult !== null;
            readbackPending ||=
              readbackResult?.command === "readback" && readbackResult.state === "readback_pending";
          }
        } catch (error) {
          failed = true;
          onError(error);
          break;
        }
      }
      if (signal.aborted) break;
      if (failed) await delay(errorBackoffMs, signal);
      else if (readbackPending) await delay(readbackBackoffMs, signal);
      else if (!claimed) await delay(pollIntervalMs, signal);
    }
  })();
  return Object.freeze({
    stop: async () => {
      abortController.abort();
      await done;
    },
  });
}
