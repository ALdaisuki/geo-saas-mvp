import { randomUUID } from "node:crypto";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { CtripOperationalReadiness } from "./authenticated-surface-review.js";
import type { CtripBridgeExecutionContext } from "./types.js";

type RuntimeStatus = CtripOperationalReadiness["status"];
type PersistedRuntimeStatus = RuntimeStatus | "authenticated";

export interface CtripRuntimeStatusControlPlane {
  listRuntimeBindingAccountIds(context: CtripBridgeExecutionContext): Promise<readonly string[]>;
  recordRuntimeStatus(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    status: PersistedRuntimeStatus,
    errorCode?: string | null,
    errorMessage?: string | null,
  ): Promise<void>;
}

export interface CtripAccountRuntimeStatusRefreshService {
  refreshAll(requestId: string): Promise<number>;
}

const STATUS_ERRORS: Readonly<
  Record<Exclude<RuntimeStatus, "ready">, { readonly code: string; readonly message: string }>
> = Object.freeze({
  session_required: {
    code: "CTRIP_SESSION_REQUIRED",
    message: "Ctrip account session requires login",
  },
  challenge_required: {
    code: "CTRIP_CHALLENGE_REQUIRED",
    message: "Ctrip account session requires an interactive challenge",
  },
  unavailable: {
    code: "CTRIP_ADAPTER_DRIFT",
    message: "Ctrip authenticated publishing surface is unavailable",
  },
});

function boundedErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/gu, " ").slice(0, 500)
    : "Unknown runtime status check error";
}

export class DefaultCtripAccountRuntimeStatusRefreshService implements CtripAccountRuntimeStatusRefreshService {
  readonly #tenantId: string;
  readonly #bridgePrincipalId: string;
  readonly #controlPlane: CtripRuntimeStatusControlPlane;
  readonly #sessions: CtripAccountBrowserSessionProvider;
  readonly #onError: (error: unknown) => void;

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: CtripRuntimeStatusControlPlane;
    readonly sessions: CtripAccountBrowserSessionProvider;
    readonly onError?: (error: unknown) => void;
  }) {
    this.#tenantId = options.tenantId;
    this.#bridgePrincipalId = options.bridgePrincipalId;
    this.#controlPlane = options.controlPlane;
    this.#sessions = options.sessions;
    this.#onError = options.onError ?? (() => undefined);
  }

  async refreshAll(requestId: string): Promise<number> {
    const context = {
      tenantId: this.#tenantId,
      bridgePrincipalId: this.#bridgePrincipalId,
      requestId,
    };
    const accountIds = await this.#controlPlane.listRuntimeBindingAccountIds(context);
    let refreshed = 0;
    for (const channelAccountId of accountIds) {
      let observation: CtripOperationalReadiness;
      try {
        // The control-plane query intentionally includes accounts with active
        // publication handoffs. Closing the CDP connection is sufficient for
        // this probe; destroying the account runtime here races the later
        // submit/readback steps. Settled runtimes are reclaimed separately by
        // DefaultCtripAccountBrowserReclaimService.
        observation = await this.#sessions.withSession(channelAccountId, (session) =>
          session.readiness(),
        );
      } catch (error) {
        try {
          await this.#controlPlane.recordRuntimeStatus(
            context,
            channelAccountId,
            "unavailable",
            "CTRIP_RUNTIME_STATUS_CHECK_FAILED",
            boundedErrorMessage(error),
          );
        } catch (recordError) {
          this.#onError(recordError);
        }
        this.#onError(error);
        continue;
      }

      try {
        const persistedStatus =
          observation.status === "unavailable" && observation.authenticated
            ? "authenticated"
            : observation.status;
        const statusError =
          persistedStatus === "ready" || persistedStatus === "authenticated"
            ? null
            : STATUS_ERRORS[persistedStatus];
        await this.#controlPlane.recordRuntimeStatus(
          context,
          channelAccountId,
          persistedStatus,
          statusError?.code ?? null,
          statusError?.message ?? null,
        );
        refreshed += 1;
      } catch (error) {
        this.#onError(error);
      }
    }
    return refreshed;
  }
}

export interface CtripAccountRuntimeStatusPoller {
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

export function startCtripAccountRuntimeStatusPoller(options: {
  readonly services: readonly CtripAccountRuntimeStatusRefreshService[];
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): CtripAccountRuntimeStatusPoller {
  if (options.services.length === 0) {
    throw new TypeError("Ctrip runtime status poller requires at least one service");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 300_000) {
    throw new TypeError("Ctrip runtime status poller interval is invalid");
  }
  const abortController = new AbortController();
  const signal = abortController.signal;
  const done = (async () => {
    while (!signal.aborted) {
      for (const service of options.services) {
        if (signal.aborted) break;
        try {
          await service.refreshAll(`ctrip-runtime-status-poll:${randomUUID()}`);
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
