import { randomUUID } from "node:crypto";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { CtripBridgeExecutionContext } from "./types.js";

export interface CtripAccountBrowserLifecycleControlPlane {
  listBrowserReclaimAccountIds(context: CtripBridgeExecutionContext): Promise<readonly string[]>;
}

export interface CtripAccountBrowserReclaimService {
  reclaimAll(requestId: string): Promise<number>;
}

export class DefaultCtripAccountBrowserReclaimService implements CtripAccountBrowserReclaimService {
  readonly #tenantId: string;
  readonly #bridgePrincipalId: string;
  readonly #controlPlane: CtripAccountBrowserLifecycleControlPlane;
  readonly #sessions: CtripAccountBrowserSessionProvider;
  readonly #onError: (error: unknown) => void;

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: CtripAccountBrowserLifecycleControlPlane;
    readonly sessions: CtripAccountBrowserSessionProvider;
    readonly onError?: (error: unknown) => void;
  }) {
    this.#tenantId = options.tenantId;
    this.#bridgePrincipalId = options.bridgePrincipalId;
    this.#controlPlane = options.controlPlane;
    this.#sessions = options.sessions;
    this.#onError = options.onError ?? (() => undefined);
  }

  async reclaimAll(requestId: string): Promise<number> {
    const context: CtripBridgeExecutionContext = {
      tenantId: this.#tenantId,
      bridgePrincipalId: this.#bridgePrincipalId,
      requestId,
    };
    if (this.#sessions.destroySession === undefined) return 0;
    const accountIds = await this.#controlPlane.listBrowserReclaimAccountIds(context);
    const concurrency = 4;
    let index = 0;
    let reclaimed = 0;
    const workers = Array.from({ length: Math.min(concurrency, accountIds.length) }, async () => {
      while (index < accountIds.length) {
        const channelAccountId = accountIds[index];
        index += 1;
        if (channelAccountId === undefined) continue;
        try {
          const destroyed = await this.#sessions.destroySession?.(channelAccountId, {
            shouldDestroy: async () => {
              const current = await this.#controlPlane.listBrowserReclaimAccountIds(context);
              return current.includes(channelAccountId);
            },
          });
          if (destroyed === true) reclaimed += 1;
        } catch (error) {
          this.#onError(error);
        }
      }
    });
    await Promise.all(workers);
    return reclaimed;
  }

  async reclaimAccount(channelAccountId: string, requestId: string): Promise<boolean> {
    if (this.#sessions.destroySession === undefined) return false;
    const context: CtripBridgeExecutionContext = {
      tenantId: this.#tenantId,
      bridgePrincipalId: this.#bridgePrincipalId,
      requestId,
    };
    try {
      const accountIds = await this.#controlPlane.listBrowserReclaimAccountIds(context);
      if (!accountIds.includes(channelAccountId)) return false;
      const destroyed = await this.#sessions.destroySession(channelAccountId, {
        shouldDestroy: async () => {
          const current = await this.#controlPlane.listBrowserReclaimAccountIds(context);
          return current.includes(channelAccountId);
        },
      });
      return destroyed === true;
    } catch (error) {
      this.#onError(error);
      return false;
    }
  }
}

export interface CtripAccountBrowserReclaimPoller {
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

export function startCtripAccountBrowserReclaimPoller(options: {
  readonly services: readonly CtripAccountBrowserReclaimService[];
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): CtripAccountBrowserReclaimPoller {
  if (options.services.length === 0) {
    throw new TypeError("Ctrip browser reclaim poller requires at least one service");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new TypeError("Ctrip browser reclaim poller interval is invalid");
  }
  const abortController = new AbortController();
  const signal = abortController.signal;
  const done = (async () => {
    while (!signal.aborted) {
      for (const service of options.services) {
        if (signal.aborted) break;
        try {
          await service.reclaimAll(`ctrip-browser-reclaim-poll:${randomUUID()}`);
        } catch (error) {
          options.onError?.(error);
        }
      }
      await delay(pollIntervalMs, signal);
    }
  })();
  return Object.freeze({
    stop: async () => {
      abortController.abort();
      await done;
    },
  });
}
