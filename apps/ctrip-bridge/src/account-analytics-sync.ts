import { randomUUID } from "node:crypto";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { CtripAccountAnalyticsObservation } from "./playwright-account-analytics-collector.js";
import type { CtripBridgeExecutionContext } from "./types.js";

export interface CtripAnalyticsControlPlane {
  claimNextAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    leaseSeconds: number,
  ): Promise<string | null>;
  completeAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    observation: CtripAccountAnalyticsObservation,
  ): Promise<void>;
  failAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
}

export interface CtripAccountAnalyticsRefreshService {
  refreshNext(requestId: string): Promise<boolean>;
}

export class DefaultCtripAccountAnalyticsRefreshService implements CtripAccountAnalyticsRefreshService {
  readonly #tenantId: string;
  readonly #bridgePrincipalId: string;
  readonly #controlPlane: CtripAnalyticsControlPlane;
  readonly #sessions: CtripAccountBrowserSessionProvider;
  readonly #leaseSeconds: number;
  readonly #deliveryPending: (() => Promise<boolean>) | undefined;
  readonly #onRuntimeCleanupError: ((channelAccountId: string, error: unknown) => void) | undefined;

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: CtripAnalyticsControlPlane;
    readonly sessions: CtripAccountBrowserSessionProvider;
    readonly leaseSeconds?: number;
    readonly deliveryPending?: () => Promise<boolean>;
    readonly onRuntimeCleanupError?: (channelAccountId: string, error: unknown) => void;
  }) {
    this.#tenantId = options.tenantId;
    this.#bridgePrincipalId = options.bridgePrincipalId;
    this.#controlPlane = options.controlPlane;
    this.#sessions = options.sessions;
    this.#leaseSeconds = options.leaseSeconds ?? 600;
    this.#deliveryPending = options.deliveryPending;
    this.#onRuntimeCleanupError = options.onRuntimeCleanupError;
  }

  async refreshNext(requestId: string): Promise<boolean> {
    const context = {
      tenantId: this.#tenantId,
      bridgePrincipalId: this.#bridgePrincipalId,
      requestId,
    };
    if (this.#deliveryPending !== undefined && (await this.#deliveryPending())) return false;
    const channelAccountId = await this.#controlPlane.claimNextAnalyticsRefresh(
      context,
      this.#leaseSeconds,
    );
    if (channelAccountId === null) return false;
    try {
      const observation = await this.#sessions.withSession(
        channelAccountId,
        (session) => session.analyticsCollector.collect(),
        {
          destroyAfterOperation: true,
          onDestroyError: (error) => this.#onRuntimeCleanupError?.(channelAccountId, error),
        },
      );
      await this.#controlPlane.completeAnalyticsRefresh(context, channelAccountId, observation);
      return true;
    } catch (error) {
      const errorCode =
        error instanceof Error && error.message.startsWith("CTRIP_ANALYTICS_DATA_PENDING")
          ? "CTRIP_ANALYTICS_DATA_PENDING"
          : error instanceof Error && error.message.startsWith("CTRIP_ANALYTICS_ADAPTER_DRIFT")
            ? "CTRIP_ANALYTICS_ADAPTER_DRIFT"
            : "CTRIP_ANALYTICS_REFRESH_FAILED";
      const errorMessage =
        error instanceof Error
          ? error.message.replace(/\s+/gu, " ").slice(0, 500)
          : "Unknown error";
      await this.#controlPlane.failAnalyticsRefresh(
        context,
        channelAccountId,
        errorCode,
        errorMessage,
      );
      throw error;
    }
  }
}

export interface CtripAccountAnalyticsPoller {
  stop(): Promise<void>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
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

export function startCtripAccountAnalyticsPoller(options: {
  readonly services: readonly CtripAccountAnalyticsRefreshService[];
  readonly idleIntervalMs?: number;
  readonly activeIntervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly onError?: (error: unknown) => void;
}): CtripAccountAnalyticsPoller {
  if (options.services.length === 0) {
    throw new TypeError("Ctrip analytics poller requires at least one service");
  }
  const idleIntervalMs = options.idleIntervalMs ?? 30_000;
  const activeIntervalMs = options.activeIntervalMs ?? 1_000;
  const errorBackoffMs = options.errorBackoffMs ?? 10_000;
  for (const interval of [idleIntervalMs, activeIntervalMs, errorBackoffMs]) {
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 300_000) {
      throw new TypeError("Ctrip analytics poller intervals are invalid");
    }
  }
  const abortController = new AbortController();
  const signal = abortController.signal;
  const done = (async () => {
    while (!signal.aborted) {
      let refreshed = false;
      let failed = false;
      for (const service of options.services) {
        if (signal.aborted) break;
        try {
          refreshed ||= await service.refreshNext(`ctrip-analytics-poll:${randomUUID()}`);
        } catch (error) {
          failed = true;
          options.onError?.(error);
        }
      }
      await delay(failed ? errorBackoffMs : refreshed ? activeIntervalMs : idleIntervalMs, signal);
    }
  })();
  return Object.freeze({
    stop: async () => {
      abortController.abort();
      await done;
    },
  });
}
