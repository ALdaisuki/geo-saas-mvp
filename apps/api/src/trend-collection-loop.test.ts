import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TrendSourceCollectionError,
  type CollectedTrendObservation,
  type TrendSourceCollectionResult,
} from "@geo/research";

import {
  TrendCollectionLoop,
  parseTrendCollectionTenantActors,
  type TrendCollectionSource,
} from "./trend-collection-loop.js";
import type { TrendController, TrendIngestResult } from "./trend-service.js";

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "10000000-0000-4000-8000-000000000002";
const actorA = "10000000-0000-4000-8000-000000000101";
const actorB = "10000000-0000-4000-8000-000000000102";

function observation(
  sourceKey: CollectedTrendObservation["sourceKey"],
  title: string,
): CollectedTrendObservation {
  return {
    sourceKey,
    title,
    sourceRank: 1,
    observedAt: "2026-08-04T00:00:00.000Z",
  };
}

function collector(results: readonly TrendSourceCollectionResult[]): TrendCollectionSource {
  return { collectAll: vi.fn(async () => results) };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("trend collection tenant actor configuration", () => {
  it("parses and normalizes an explicit tenant-to-service-principal map", () => {
    expect(
      parseTrendCollectionTenantActors(
        JSON.stringify({ [tenantA.toUpperCase()]: actorA.toUpperCase() }),
      ),
    ).toEqual({ [tenantA]: actorA });
  });

  it.each(["not-json", "[]", "{}", JSON.stringify({ [tenantA]: "not-a-uuid" })])(
    "rejects invalid actor configuration: %s",
    (raw) => {
      expect(() => parseTrendCollectionTenantActors(raw)).toThrow(TypeError);
    },
  );

  it("rejects case-normalized tenant conflicts", () => {
    const alphabeticTenant = "abcdef00-0000-4000-8000-000000000001";
    expect(() =>
      parseTrendCollectionTenantActors(
        JSON.stringify({
          [alphabeticTenant.toUpperCase()]: actorA,
          [alphabeticTenant]: actorB,
        }),
      ),
    ).toThrow("conflicting tenant mappings");
  });
});

describe("TrendCollectionLoop", () => {
  it("isolates source and tenant failures while reusing TrendService.ingest authority", async () => {
    const sourceResults: readonly TrendSourceCollectionResult[] = [
      {
        sourceKey: "toutiao",
        status: "fulfilled",
        observations: [observation("toutiao", "头条热点样本")],
      },
      {
        sourceKey: "weibo",
        status: "rejected",
        error: new TrendSourceCollectionError("TREND_SOURCE_TIMEOUT", "timed out"),
      },
      {
        sourceKey: "baidu",
        status: "fulfilled",
        observations: [observation("baidu", "百度热点样本")],
      },
    ];
    const ingest = vi.fn<TrendController["ingest"]>(async (actor, request) => {
      if (actor.tenantId === tenantB && request.observations[0]?.sourceKey === "toutiao") {
        throw Object.assign(new Error("tenant unavailable"), { code: "TREND_DB_UNAVAILABLE" });
      }
      return {
        items: [],
        createdCount: request.observations.length,
        replayedCount: 0,
      } satisfies TrendIngestResult;
    });
    const publishSnapshot = vi.fn();
    const timestamps = [
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:01.000Z",
      "2026-08-04T00:00:02.000Z",
      "2026-08-04T00:00:03.000Z",
      "2026-08-04T00:00:04.000Z",
    ];
    const loop = new TrendCollectionLoop({
      collector: collector(sourceResults),
      trendController: { ingest },
      tenantActors: { [tenantA]: actorA, [tenantB]: actorB },
      validateActor: async () => true,
      runId: () => "run-001",
      now: () => new Date(timestamps.shift() ?? "2026-08-04T00:00:05.000Z"),
      operationsEventBus: { publishSnapshot },
    });

    const summary = await loop.runOnce();

    expect(summary.sources).toEqual([
      { sourceKey: "toutiao", status: "fulfilled", observationCount: 1 },
      {
        sourceKey: "weibo",
        status: "rejected",
        observationCount: 0,
        errorCode: "TREND_SOURCE_TIMEOUT",
      },
      { sourceKey: "baidu", status: "fulfilled", observationCount: 1 },
    ]);
    expect(summary.ingests.filter((item) => item.status === "fulfilled")).toHaveLength(3);
    expect(summary.ingests.filter((item) => item.status === "rejected")).toEqual([
      expect.objectContaining({
        tenantId: tenantB,
        sourceKey: "toutiao",
        errorCode: "TREND_DB_UNAVAILABLE",
      }),
    ]);
    expect(ingest).toHaveBeenCalledTimes(4);
    expect(ingest).toHaveBeenCalledWith(
      {
        tenantId: tenantA,
        actorId: actorA,
        role: "automation_operator",
        capabilities: ["automation:execute"],
        requestId: "trend-collection:run-001:toutiao",
      },
      { observations: [observation("toutiao", "头条热点样本")] },
    );
    expect(publishSnapshot).toHaveBeenCalledTimes(3);
    expect(publishSnapshot).toHaveBeenCalledWith(tenantA, expect.any(String));
    expect(publishSnapshot).toHaveBeenCalledWith(tenantB, expect.any(String));
  });

  it("runs immediately, never overlaps ticks, and stops an interval wait", async () => {
    vi.useFakeTimers();
    const collectAll = vi.fn(async () => [] as const);
    const loop = new TrendCollectionLoop({
      collector: { collectAll },
      trendController: { ingest: vi.fn() },
      tenantActors: { [tenantA]: actorA },
      validateActor: async () => true,
      enabled: true,
      intervalMs: 1_000,
    });

    const lifecycle = loop.start();
    expect(loop.start()).toBe(lifecycle);
    await vi.advanceTimersByTimeAsync(0);
    expect(collectAll).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(collectAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(collectAll).toHaveBeenCalledTimes(2);

    await loop.stop();
    await lifecycle;
    expect(loop.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule work unless explicitly enabled", async () => {
    vi.useFakeTimers();
    const source = collector([]);
    const loop = new TrendCollectionLoop({
      collector: source,
      trendController: { ingest: vi.fn() },
      tenantActors: {},
      validateActor: async () => true,
    });

    await loop.start();

    expect(source.collectAll).not.toHaveBeenCalled();
    expect(loop.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates stop into an active collection cycle", async () => {
    vi.useFakeTimers();
    let collectionSignal: AbortSignal | undefined;
    const source: TrendCollectionSource = {
      collectAll: async (signal) => {
        collectionSignal = signal;
        return new Promise<readonly TrendSourceCollectionResult[]>((resolvePromise) => {
          signal?.addEventListener("abort", () => resolvePromise([]), { once: true });
        });
      },
    };
    const loop = new TrendCollectionLoop({
      collector: source,
      trendController: { ingest: vi.fn() },
      tenantActors: { [tenantA]: actorA },
      validateActor: async () => true,
      enabled: true,
      intervalMs: 1_000,
    });

    const lifecycle = loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(collectionSignal?.aborted).toBe(false);

    await loop.stop();
    await lifecycle;

    expect(collectionSignal?.aborted).toBe(true);
    expect(loop.running).toBe(false);
  });

  it("rejects an unverified tenant actor without writing trend observations", async () => {
    const ingest = vi.fn<TrendController["ingest"]>();
    const validateActor = vi.fn(async () => false);
    const loop = new TrendCollectionLoop({
      collector: collector([
        {
          sourceKey: "toutiao",
          status: "fulfilled",
          observations: [observation("toutiao", "云南暑期旅游热点")],
        },
      ]),
      trendController: { ingest },
      tenantActors: { [tenantA]: actorA },
      validateActor,
      runId: () => "run-invalid-actor",
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });

    const summary = await loop.runOnce();

    expect(validateActor).toHaveBeenCalledWith(tenantA, actorA);
    expect(ingest).not.toHaveBeenCalled();
    expect(summary.ingests).toEqual([
      {
        tenantId: tenantA,
        sourceKey: "toutiao",
        status: "rejected",
        observationCount: 1,
        errorCode: "TREND_COLLECTION_ACTOR_INVALID",
      },
    ]);
  });
});
