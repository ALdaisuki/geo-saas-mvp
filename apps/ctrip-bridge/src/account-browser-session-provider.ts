import { idSchema } from "@geo/contracts";

import {
  connectCtripBrowserReviewSession,
  type CtripBrowserReviewSession,
} from "./browser-review-session.js";
import {
  requestBoundedCdpDiscoveryViaHttp,
  requestBoundedCdpStopViaHttp,
  requireLinuxServiceCdpEndpoint,
  type CtripBrowserTransport,
} from "./config.js";
import type { PlatformLoginId } from "./platform-login-definitions.js";
import { isBrowserRuntimeUnavailableError } from "./browser-runtime-error.js";

export const DEFAULT_BROWSER_SESSION_CAPACITY = 8;
export const MAX_BROWSER_SESSION_CAPACITY = 16;
export const DEFAULT_BROWSER_CONNECT_TIMEOUT_MS = 35_000;
export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;
export const DEFAULT_BROWSER_OPERATION_TIMEOUT_MS = 600_000;
const BROWSER_STOP_RETRY_DELAYS_MS = [50, 150, 300] as const;

export class CtripAccountBrowserUnresponsiveError extends Error {
  readonly code = "CTRIP_CDP_UNRESPONSIVE" as const;

  constructor(timeoutMs: number) {
    super(`Ctrip account CDP operation did not respond within ${timeoutMs}ms`);
    this.name = "CtripAccountBrowserUnresponsiveError";
  }
}

export interface CtripAccountBrowserBinding {
  readonly channelAccountId: string;
  readonly platform: PlatformLoginId;
  readonly expectedAccountName: string;
  readonly profileKey: string;
  readonly sessionState:
    | "unbound"
    | "session_required"
    | "authenticated"
    | "ready"
    | "challenge_required"
    | "unavailable"
    | "disabled";
}

export interface CtripAccountBrowserSessionProvider {
  withSession<Result>(
    channelAccountId: string,
    operation: (session: CtripBrowserReviewSession) => Promise<Result>,
    options?: CtripAccountBrowserSessionUseOptions,
  ): Promise<Result>;
  destroySession?(
    channelAccountId: string,
    options?: { shouldDestroy?: () => Promise<boolean> },
  ): Promise<boolean>;
}

export interface CtripAccountBrowserSessionUseOptions {
  readonly destroyAfterOperation?: boolean;
  readonly onDestroyError?: (error: unknown) => void;
}

export class DefaultCtripAccountBrowserSessionProvider implements CtripAccountBrowserSessionProvider {
  readonly #httpEndpoint: string;
  readonly #runtimeTmpRoot: string;
  readonly #transport: CtripBrowserTransport;
  readonly #loadBinding: (channelAccountId: string) => Promise<CtripAccountBrowserBinding>;
  readonly #connectSession: typeof connectCtripBrowserReviewSession;
  readonly #stopSession: typeof requestBoundedCdpStopViaHttp;
  readonly #discoverSession: typeof requestBoundedCdpDiscoveryViaHttp;
  readonly #maxConcurrentSessions: number;
  readonly #connectTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #capacityWaiters: Array<() => void> = [];
  #activeSessions = 0;

  constructor(options: {
    readonly httpEndpoint: string;
    readonly runtimeTmpRoot: string;
    readonly transport: CtripBrowserTransport;
    readonly loadBinding: (channelAccountId: string) => Promise<CtripAccountBrowserBinding>;
    readonly connectSession?: typeof connectCtripBrowserReviewSession;
    readonly stopSession?: typeof requestBoundedCdpStopViaHttp;
    readonly discoverSession?: typeof requestBoundedCdpDiscoveryViaHttp;
    readonly connectTimeoutMs?: number;
    readonly operationTimeoutMs?: number;
    readonly maxConcurrentSessions?: number;
  }) {
    this.#httpEndpoint = options.httpEndpoint;
    this.#runtimeTmpRoot = options.runtimeTmpRoot;
    this.#transport = options.transport;
    this.#loadBinding = options.loadBinding;
    this.#connectSession = options.connectSession ?? connectCtripBrowserReviewSession;
    this.#stopSession = options.stopSession ?? requestBoundedCdpStopViaHttp;
    this.#discoverSession = options.discoverSession ?? requestBoundedCdpDiscoveryViaHttp;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_BROWSER_CONNECT_TIMEOUT_MS;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_BROWSER_OPERATION_TIMEOUT_MS;
    this.#maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_BROWSER_SESSION_CAPACITY;
    if (
      !Number.isSafeInteger(this.#connectTimeoutMs) ||
      this.#connectTimeoutMs < 5_000 ||
      this.#connectTimeoutMs > 300_000
    ) {
      throw new TypeError("Ctrip browser connect timeout must be from 5s through 300s");
    }
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs < 30_000 ||
      this.#operationTimeoutMs > 1_800_000
    ) {
      throw new TypeError("Ctrip browser operation timeout must be from 30s through 30min");
    }
    if (
      !Number.isSafeInteger(this.#maxConcurrentSessions) ||
      this.#maxConcurrentSessions < 1 ||
      this.#maxConcurrentSessions > MAX_BROWSER_SESSION_CAPACITY
    ) {
      throw new TypeError(
        `Ctrip browser session capacity must be from 1 through ${MAX_BROWSER_SESSION_CAPACITY}`,
      );
    }
  }

  async #acquireCapacity(): Promise<void> {
    if (this.#activeSessions >= this.#maxConcurrentSessions) {
      await new Promise<void>((resolve) => this.#capacityWaiters.push(resolve));
    }
    this.#activeSessions += 1;
  }

  #releaseCapacity(): void {
    this.#activeSessions -= 1;
    this.#capacityWaiters.shift()?.();
  }

  #withTimeout<Result>(
    promise: Promise<Result>,
    timeoutMs: number,
    label: string,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  #connectOptions(
    accountId: string,
    binding: CtripAccountBrowserBinding,
  ): Parameters<typeof connectCtripBrowserReviewSession>[0] {
    return {
      httpEndpoint: this.#httpEndpoint,
      runtimeTmpRoot: this.#runtimeTmpRoot,
      transport: this.#transport,
      platform: binding.platform,
      expectedAccountName: binding.expectedAccountName,
      ...(this.#transport === "linux_service"
        ? { channelAccountId: accountId, profileKey: binding.profileKey }
        : {}),
    };
  }

  async #connectOnce(
    accountId: string,
    binding: CtripAccountBrowserBinding,
    label: string,
  ): Promise<CtripBrowserReviewSession> {
    const attempt = this.#connectSession(this.#connectOptions(accountId, binding));
    try {
      return await this.#withTimeout(attempt, this.#connectTimeoutMs, label);
    } catch (error) {
      void attempt
        .catch(() => undefined)
        .then((session) => {
          if (session !== undefined) void this.#closeSession(session);
        });
      throw error;
    }
  }

  async #connectWithRecovery(
    accountId: string,
    binding: CtripAccountBrowserBinding,
  ): Promise<CtripBrowserReviewSession> {
    if (this.#transport !== "linux_service") {
      return this.#connectSession(this.#connectOptions(accountId, binding));
    }
    try {
      return await this.#connectOnce(accountId, binding, "Ctrip account CDP connect");
    } catch (error) {
      if (!(error instanceof Error) || !isCdpRecoverableError(error)) throw error;
      await this.#destroySessionNow(accountId);
      return this.#connectOnce(accountId, binding, "Ctrip account CDP connect retry");
    }
  }

  async #closeSession(session: CtripBrowserReviewSession): Promise<boolean> {
    const closeAttempt = Promise.resolve().then(() => session.close());
    try {
      await this.#withTimeout(
        closeAttempt,
        DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
        "Ctrip account browser close",
      );
      return true;
    } catch {
      // Do not send browser-host /stop while CDP may still be connected: that
      // endpoint rejects active sessions and leaves the runtime behind. Leave
      // lifecycle recovery to the account-scoped browser host once the CDP
      // connection is actually observable as closed; a detached callback here
      // could race a later task for the same account.
      return false;
    }
  }

  async #destroySessionNow(accountId: string): Promise<void> {
    if (this.#transport !== "linux_service") return;

    const endpoint = new URL(requireLinuxServiceCdpEndpoint(this.#httpEndpoint));
    const stopUrl = new URL(`/accounts/${accountId}/stop`, endpoint);
    const hostHeader = `127.0.0.1:${endpoint.port}`;
    let response = await this.#stopSession(stopUrl, hostHeader);
    for (const delayMs of BROWSER_STOP_RETRY_DELAYS_MS) {
      if (response.statusCode !== 409) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      response = await this.#stopSession(stopUrl, hostHeader);
    }
    if (response.statusCode === 404) {
      const discovery = await this.#discoverSession(
        new URL(`/accounts/${accountId}/json/version`, endpoint),
        hostHeader,
      );
      if (discovery.statusCode === 404) return;
    }
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      !response.contentType?.includes("application/json")
    ) {
      throw new TypeError("Ctrip account browser stop was rejected");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      throw new TypeError("Ctrip account browser stop response is invalid");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("status" in parsed) ||
      parsed.status !== "ok"
    ) {
      throw new TypeError("Ctrip account browser stop response is invalid");
    }
    const discovery = await this.#discoverSession(
      new URL(`/accounts/${accountId}/json/version`, endpoint),
      hostHeader,
    );
    if (discovery.statusCode >= 200 && discovery.statusCode < 300) {
      throw new TypeError("Ctrip account browser session is still active after stop");
    }
  }

  async destroySession(
    channelAccountId: string,
    options?: { shouldDestroy?: () => Promise<boolean> },
  ): Promise<boolean> {
    const accountId = idSchema.parse(channelAccountId);
    const previous = this.#tails.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#tails.set(accountId, tail);
    await previous.catch(() => undefined);
    try {
      if (options?.shouldDestroy !== undefined && !(await options.shouldDestroy())) {
        return false;
      }
      await this.#destroySessionNow(accountId);
      return true;
    } finally {
      release();
      if (this.#tails.get(accountId) === tail) this.#tails.delete(accountId);
    }
  }

  async withSession<Result>(
    channelAccountId: string,
    operation: (session: CtripBrowserReviewSession) => Promise<Result>,
    options?: CtripAccountBrowserSessionUseOptions,
  ): Promise<Result> {
    const accountId = idSchema.parse(channelAccountId);
    const previous = this.#tails.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#tails.set(accountId, tail);
    await previous.catch(() => undefined);
    await this.#acquireCapacity();

    let session: CtripBrowserReviewSession | null = null;
    let destroyAfterClose = false;
    try {
      const binding = await this.#loadBinding(accountId);
      if (
        binding.channelAccountId !== accountId ||
        binding.sessionState === "disabled" ||
        binding.sessionState === "unbound"
      ) {
        throw new Error("Ctrip account browser runtime is unavailable");
      }
      session = await this.#connectWithRecovery(accountId, binding);
      try {
        return await this.#withTimeout(
          operation(session),
          this.#operationTimeoutMs,
          "Ctrip account CDP operation",
        );
      } catch (error) {
        if (
          error instanceof CtripAccountBrowserUnresponsiveError ||
          isBrowserRuntimeUnavailableError(error)
        ) {
          // The browser-host stop route intentionally rejects connected
          // sessions. Defer process teardown until the CDP connection has
          // closed, otherwise a runtime error is followed by a guaranteed 409
          // and the account is left running.
          destroyAfterClose = true;
          if (error instanceof CtripAccountBrowserUnresponsiveError) throw error;
          if (
            error instanceof Error &&
            /Ctrip account CDP operation timed out after/iu.test(`${error.name}: ${error.message}`)
          ) {
            throw new CtripAccountBrowserUnresponsiveError(this.#operationTimeoutMs);
          }
        }
        throw error;
      }
    } finally {
      const cdpClosed = session === null || (await this.#closeSession(session));
      const shouldDestroy = destroyAfterClose || options?.destroyAfterOperation === true;
      if (shouldDestroy && cdpClosed) {
        try {
          await this.#destroySessionNow(accountId);
        } catch (error) {
          try {
            options?.onDestroyError?.(error);
          } catch {
            // Cleanup observability must not replace the browser operation result.
          }
        }
      } else if (options?.destroyAfterOperation === true && !cdpClosed) {
        try {
          options.onDestroyError?.(
            new Error("Ctrip account browser close could not be confirmed before runtime cleanup"),
          );
        } catch {
          // Cleanup observability must not replace the browser operation result.
        }
      }
      this.#releaseCapacity();
      release();
      if (this.#tails.get(accountId) === tail) this.#tails.delete(accountId);
    }
  }
}

function isCdpRecoverableError(error: Error): boolean {
  const message = `${error.name}: ${error.message}`;
  return /timeout|timed out|ECONNREFUSED|ECONNRESET|CDP|websocket|connect/iu.test(message);
}
