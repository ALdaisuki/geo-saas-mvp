import { randomUUID } from "node:crypto";

import type { ActorContext } from "@geo/contracts";
import type { PublicTrendSourceKey, TrendSourceCollectionResult } from "@geo/research";

import type { OperationsEventBus } from "./operations-event-stream.js";
import type { TrendController } from "./trend-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z0-9_.-]{1,100}$/u;

export interface TrendCollectionSource {
  collectAll(signal?: AbortSignal): Promise<readonly TrendSourceCollectionResult[]>;
}

export interface TrendCollectionSourceSummary {
  readonly sourceKey: PublicTrendSourceKey;
  readonly status: "fulfilled" | "rejected";
  readonly observationCount: number;
  readonly errorCode?: string | undefined;
}

export interface TrendCollectionIngestSummary {
  readonly tenantId: string;
  readonly sourceKey: PublicTrendSourceKey;
  readonly status: "fulfilled" | "rejected";
  readonly observationCount: number;
  readonly createdCount?: number | undefined;
  readonly replayedCount?: number | undefined;
  readonly errorCode?: string | undefined;
}

export interface TrendCollectionRunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sources: readonly TrendCollectionSourceSummary[];
  readonly ingests: readonly TrendCollectionIngestSummary[];
}

export interface TrendCollectionLoopOptions {
  readonly collector: TrendCollectionSource;
  readonly trendController: Pick<TrendController, "ingest">;
  readonly tenantActors: Readonly<Record<string, string>>;
  readonly validateActor: (tenantId: string, actorId: string) => Promise<boolean>;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly runId?: () => string;
  readonly operationsEventBus?: Pick<OperationsEventBus, "publishSnapshot">;
  readonly onRun?: (summary: TrendCollectionRunSummary) => void;
  readonly onError?: (errorCode: string) => void;
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return fallback;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code) ? code : fallback;
}

function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(done, milliseconds);
    timeout.unref();
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function automationActor(tenantId: string, actorId: string, requestId: string): ActorContext {
  return {
    tenantId,
    actorId,
    role: "automation_operator",
    capabilities: ["automation:execute"],
    requestId,
  };
}

export function parseTrendCollectionTenantActors(raw: string): Readonly<Record<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("TREND_COLLECTION_TENANT_ACTORS_JSON must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("TREND_COLLECTION_TENANT_ACTORS_JSON must be a tenant-to-actor object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new TypeError("TREND_COLLECTION_TENANT_ACTORS_JSON must contain at least one mapping");
  }
  const result: Record<string, string> = {};
  for (const [tenantId, actorId] of entries) {
    if (
      !UUID_PATTERN.test(tenantId) ||
      typeof actorId !== "string" ||
      !UUID_PATTERN.test(actorId)
    ) {
      throw new TypeError("TREND_COLLECTION_TENANT_ACTORS_JSON keys and values must be UUIDs");
    }
    const normalizedTenantId = tenantId.toLowerCase();
    const normalizedActorId = actorId.toLowerCase();
    const existing = result[normalizedTenantId];
    if (existing !== undefined && existing !== normalizedActorId) {
      throw new TypeError(
        "TREND_COLLECTION_TENANT_ACTORS_JSON contains conflicting tenant mappings",
      );
    }
    result[normalizedTenantId] = normalizedActorId;
  }
  return Object.freeze(result);
}

export class TrendCollectionLoop {
  readonly #collector: TrendCollectionSource;
  readonly #trendController: Pick<TrendController, "ingest">;
  readonly #tenantActors: Readonly<Record<string, string>>;
  readonly #validateActor: TrendCollectionLoopOptions["validateActor"];
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #operationsEventBus: Pick<OperationsEventBus, "publishSnapshot"> | undefined;
  readonly #onRun: ((summary: TrendCollectionRunSummary) => void) | undefined;
  readonly #onError: ((errorCode: string) => void) | undefined;

  #controller: AbortController | undefined;
  #lifecycle: Promise<void> | undefined;

  constructor(options: TrendCollectionLoopOptions) {
    this.#collector = options.collector;
    this.#trendController = options.trendController;
    this.#tenantActors = options.tenantActors;
    this.#validateActor = options.validateActor;
    this.#enabled = options.enabled ?? false;
    this.#intervalMs = options.intervalMs ?? 600_000;
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? randomUUID;
    this.#operationsEventBus = options.operationsEventBus;
    this.#onRun = options.onRun;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new TypeError("Trend collection interval must be a positive safe integer");
    }
    if (this.#enabled && Object.keys(this.#tenantActors).length === 0) {
      throw new TypeError("Enabled trend collection requires at least one tenant actor mapping");
    }
  }

  get running(): boolean {
    return this.#lifecycle !== undefined;
  }

  async runOnce(signal?: AbortSignal): Promise<TrendCollectionRunSummary> {
    const runId = this.#runId();
    const startedAt = this.#now().toISOString();
    const results = await this.#collector.collectAll(signal);
    const sources: TrendCollectionSourceSummary[] = results.map((result) =>
      result.status === "fulfilled"
        ? {
            sourceKey: result.sourceKey,
            status: "fulfilled",
            observationCount: result.observations.length,
          }
        : {
            sourceKey: result.sourceKey,
            status: "rejected",
            observationCount: 0,
            errorCode: result.error.code,
          },
    );
    const validatedActors = new Map<string, boolean>();
    for (const [tenantId, actorId] of Object.entries(this.#tenantActors)) {
      try {
        validatedActors.set(tenantId, await this.#validateActor(tenantId, actorId));
      } catch {
        validatedActors.set(tenantId, false);
      }
    }
    const ingests: TrendCollectionIngestSummary[] = [];
    for (const result of results) {
      if (result.status === "rejected" || result.observations.length === 0) continue;
      for (const [tenantId, actorId] of Object.entries(this.#tenantActors)) {
        if (validatedActors.get(tenantId) !== true) {
          ingests.push({
            tenantId,
            sourceKey: result.sourceKey,
            status: "rejected",
            observationCount: result.observations.length,
            errorCode: "TREND_COLLECTION_ACTOR_INVALID",
          });
          continue;
        }
        let ingestResult: Awaited<ReturnType<TrendController["ingest"]>>;
        try {
          ingestResult = await this.#trendController.ingest(
            automationActor(tenantId, actorId, `trend-collection:${runId}:${result.sourceKey}`),
            { observations: result.observations },
          );
        } catch (error) {
          ingests.push({
            tenantId,
            sourceKey: result.sourceKey,
            status: "rejected",
            observationCount: result.observations.length,
            errorCode: safeErrorCode(error, "TREND_INGEST_FAILED"),
          });
          continue;
        }
        ingests.push({
          tenantId,
          sourceKey: result.sourceKey,
          status: "fulfilled",
          observationCount: result.observations.length,
          createdCount: ingestResult.createdCount,
          replayedCount: ingestResult.replayedCount,
        });
        try {
          this.#operationsEventBus?.publishSnapshot(tenantId, this.#now().toISOString());
        } catch (error) {
          this.#onError?.(safeErrorCode(error, "OPERATIONS_EVENT_PUBLISH_FAILED"));
        }
      }
    }
    return {
      runId,
      startedAt,
      completedAt: this.#now().toISOString(),
      sources,
      ingests,
    };
  }

  start(): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#lifecycle !== undefined) return this.#lifecycle;
    const controller = new AbortController();
    this.#controller = controller;
    const lifecycle = this.#run(controller.signal).finally(() => {
      if (this.#lifecycle === lifecycle) {
        this.#lifecycle = undefined;
        this.#controller = undefined;
      }
    });
    this.#lifecycle = lifecycle;
    return lifecycle;
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#lifecycle;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const summary = await this.runOnce(signal);
        if (!signal.aborted) this.#onRun?.(summary);
      } catch (error) {
        this.#onError?.(safeErrorCode(error, "TREND_COLLECTION_RUN_FAILED"));
      }
      if (!signal.aborted) await waitForInterval(this.#intervalMs, signal);
    }
  }
}
