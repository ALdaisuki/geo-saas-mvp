import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { BrowserHostAdmissionGate } from "./browser-host-admission-gate.js";
import type { BaijiahaoAccountAnalyticsObservation } from "./playwright-baijiahao-account-analytics-collector.js";
import type { NeteaseAccountAnalyticsObservation } from "./playwright-netease-account-analytics-collector.js";
import type { SohuAccountAnalyticsObservation } from "./playwright-sohu-account-analytics-collector.js";
import type { ToutiaoAccountAnalyticsObservation } from "./playwright-toutiao-account-analytics-collector.js";
import type { CtripBridgeExecutionContext } from "./types.js";

export type PriorityPlatformAnalyticsObservation =
  | ToutiaoAccountAnalyticsObservation
  | BaijiahaoAccountAnalyticsObservation
  | SohuAccountAnalyticsObservation
  | NeteaseAccountAnalyticsObservation;

export interface PriorityPlatformAnalyticsLease {
  readonly channelAccountId: string;
  readonly leaseExpiresAt: string;
}

export interface PriorityPlatformAnalyticsControlPlane {
  claimNextPriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    leaseSeconds: number,
  ): Promise<PriorityPlatformAnalyticsLease | null>;
  completePriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    leaseExpiresAt: string,
    observation: PriorityPlatformAnalyticsObservation,
  ): Promise<void>;
  failPriorityPlatformAnalyticsRefresh(
    context: CtripBridgeExecutionContext,
    channelAccountId: string,
    leaseExpiresAt: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
}

export const DEFAULT_PRIORITY_PLATFORM_ANALYTICS_OPERATION_TIMEOUT_MS = 90_000;

function withAnalyticsOperationTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `PRIORITY_PLATFORM_ANALYTICS_TIMEOUT: browser analytics operation timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export class DefaultPriorityPlatformAccountAnalyticsRefreshService {
  readonly #tenantId: string;
  readonly #bridgePrincipalId: string;
  readonly #controlPlane: PriorityPlatformAnalyticsControlPlane;
  readonly #sessions: CtripAccountBrowserSessionProvider;
  readonly #admissionGate: BrowserHostAdmissionGate | undefined;
  readonly #leaseSeconds: number;
  readonly #operationTimeoutMs: number;
  readonly #deliveryPending: (() => Promise<boolean>) | undefined;
  readonly #onRuntimeCleanupError: ((channelAccountId: string, error: unknown) => void) | undefined;

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: PriorityPlatformAnalyticsControlPlane;
    readonly sessions: CtripAccountBrowserSessionProvider;
    readonly admissionGate?: BrowserHostAdmissionGate;
    readonly leaseSeconds?: number;
    readonly operationTimeoutMs?: number;
    readonly deliveryPending?: () => Promise<boolean>;
    readonly onRuntimeCleanupError?: (channelAccountId: string, error: unknown) => void;
  }) {
    const operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_PRIORITY_PLATFORM_ANALYTICS_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1) {
      throw new Error("priority-platform analytics operation timeout must be a positive integer");
    }
    this.#tenantId = options.tenantId;
    this.#bridgePrincipalId = options.bridgePrincipalId;
    this.#controlPlane = options.controlPlane;
    this.#sessions = options.sessions;
    this.#admissionGate = options.admissionGate;
    this.#leaseSeconds = options.leaseSeconds ?? 600;
    this.#operationTimeoutMs = operationTimeoutMs;
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
    if (this.#admissionGate !== undefined && !(await this.#admissionGate.canClaim())) {
      return false;
    }
    const lease = await this.#controlPlane.claimNextPriorityPlatformAnalyticsRefresh(
      context,
      this.#leaseSeconds,
    );
    if (lease === null) return false;
    const { channelAccountId, leaseExpiresAt } = lease;
    try {
      const observation = await this.#sessions.withSession(
        channelAccountId,
        async (session) => {
          return withAnalyticsOperationTimeout(
            (async () => {
              const readiness = await session.readiness();
              if (!readiness.authenticated) {
                if (readiness.status === "challenge_required") {
                  const prefix = session.platform.toUpperCase();
                  throw new Error(
                    `${prefix}_ANALYTICS_CHALLENGE_REQUIRED: 人工完成账号安全验证后可重新采集`,
                  );
                }
                throw new Error(
                  "PRIORITY_PLATFORM_ANALYTICS_ACCOUNT_IDENTITY_MISMATCH: browser session does not expose the authenticated account identity",
                );
              }
              if (session.platform === "toutiao" && session.toutiaoAnalyticsCollector !== null) {
                return session.toutiaoAnalyticsCollector.collect();
              }
              if (
                session.platform === "baijiahao" &&
                session.baijiahaoAnalyticsCollector !== null
              ) {
                return session.baijiahaoAnalyticsCollector.collect();
              }
              if (session.platform === "sohu" && session.sohuAnalyticsCollector !== null) {
                return session.sohuAnalyticsCollector.collect();
              }
              if (session.platform === "netease" && session.neteaseAnalyticsCollector !== null) {
                return session.neteaseAnalyticsCollector.collect();
              }
              throw new Error(
                "PRIORITY_PLATFORM_ANALYTICS_UNSUPPORTED: account collector is unavailable",
              );
            })(),
            this.#operationTimeoutMs,
          );
        },
        {
          destroyAfterOperation: true,
          onDestroyError: (error) => this.#onRuntimeCleanupError?.(channelAccountId, error),
        },
      );
      await this.#controlPlane.completePriorityPlatformAnalyticsRefresh(
        context,
        channelAccountId,
        leaseExpiresAt,
        observation,
      );
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(/\s+/gu, " ").slice(0, 500)
          : "Unknown error";
      const errorCode = message.startsWith("TOUTIAO_ANALYTICS_DATA_PENDING")
        ? "TOUTIAO_ANALYTICS_DATA_PENDING"
        : message.startsWith("TOUTIAO_ANALYTICS_CHALLENGE_REQUIRED")
          ? "TOUTIAO_ANALYTICS_CHALLENGE_REQUIRED"
          : message.startsWith("TOUTIAO_ANALYTICS_ADAPTER_DRIFT")
            ? "TOUTIAO_ANALYTICS_ADAPTER_DRIFT"
            : message.startsWith("BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED")
              ? "BAIJIAHAO_ANALYTICS_CHALLENGE_REQUIRED"
              : message.startsWith("BAIJIAHAO_ANALYTICS_DATA_PENDING")
                ? "BAIJIAHAO_ANALYTICS_DATA_PENDING"
                : message.startsWith("BAIJIAHAO_ANALYTICS_ADAPTER_DRIFT")
                  ? "BAIJIAHAO_ANALYTICS_ADAPTER_DRIFT"
                  : message.startsWith("SOHU_ANALYTICS_CHALLENGE_REQUIRED")
                    ? "SOHU_ANALYTICS_CHALLENGE_REQUIRED"
                    : message.startsWith("SOHU_ANALYTICS_DATA_PENDING")
                      ? "SOHU_ANALYTICS_DATA_PENDING"
                      : message.startsWith("SOHU_ANALYTICS_ADAPTER_DRIFT")
                        ? "SOHU_ANALYTICS_ADAPTER_DRIFT"
                        : message.startsWith("NETEASE_ANALYTICS_CHALLENGE_REQUIRED")
                          ? "NETEASE_ANALYTICS_CHALLENGE_REQUIRED"
                          : message.startsWith("NETEASE_ANALYTICS_DATA_PENDING")
                            ? "NETEASE_ANALYTICS_DATA_PENDING"
                            : message.startsWith("NETEASE_ANALYTICS_ADAPTER_DRIFT")
                              ? "NETEASE_ANALYTICS_ADAPTER_DRIFT"
                              : message.startsWith("PRIORITY_PLATFORM_ANALYTICS_TIMEOUT")
                                ? "PRIORITY_PLATFORM_ANALYTICS_TIMEOUT"
                                : message.startsWith(
                                      "PRIORITY_PLATFORM_ANALYTICS_ACCOUNT_IDENTITY_MISMATCH",
                                    )
                                  ? "PRIORITY_PLATFORM_ANALYTICS_ACCOUNT_IDENTITY_MISMATCH"
                                  : message.startsWith("PRIORITY_PLATFORM_ANALYTICS_UNSUPPORTED")
                                    ? "PRIORITY_PLATFORM_ANALYTICS_UNSUPPORTED"
                                    : "PRIORITY_PLATFORM_ANALYTICS_REFRESH_FAILED";
      await this.#controlPlane.failPriorityPlatformAnalyticsRefresh(
        context,
        channelAccountId,
        leaseExpiresAt,
        errorCode,
        message,
      );
      throw error;
    }
  }
}
