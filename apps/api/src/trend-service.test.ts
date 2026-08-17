import type { ActorContext } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import type {
  PersistTrendObservationInput,
  PersistedTrendObservation,
  TrendObservationPersistResult,
  TrendRepository,
} from "./trend-repository.js";
import { TrendService } from "./trend-service.js";

const tenantOne = "10000000-0000-4000-8000-000000000001";
const tenantTwo = "20000000-0000-4000-8000-000000000001";

function actor(tenantId = tenantOne): ActorContext {
  return {
    actorId: "10000000-0000-4000-8000-000000000101",
    tenantId,
    role: "admin",
    capabilities: ["content:read", "content:write", "automation:execute"],
    requestId: `trend-${tenantId}`,
  };
}

class FakeTrendRepository implements TrendRepository {
  readonly rows = new Map<string, PersistedTrendObservation[]>();
  readonly listInputs: Array<{ readonly observedAfter: string; readonly limit: number }> = [];

  async persistObservations(
    context: Readonly<ActorContext>,
    inputs: readonly Readonly<PersistTrendObservationInput>[],
  ): Promise<readonly TrendObservationPersistResult[]> {
    const tenantRows = this.rows.get(context.tenantId) ?? [];
    const results = inputs.map((input) => {
      const existing = tenantRows.find(
        (row) => row.sourceKey === input.sourceKey && row.observationKey === input.observationKey,
      );
      if (existing !== undefined) return { observation: existing, wasCreated: false };
      const observation: PersistedTrendObservation = {
        ...input,
        tenantId: context.tenantId,
        ingestedByActorId: context.actorId,
        firstObservedAt: input.observedAt,
      };
      tenantRows.push(observation);
      return { observation, wasCreated: true };
    });
    this.rows.set(context.tenantId, tenantRows);
    return results;
  }

  async listObservations(
    context: Readonly<ActorContext>,
    input: { readonly observedAfter: string; readonly sourceKey?: string; readonly limit: number },
  ): Promise<readonly PersistedTrendObservation[]> {
    this.listInputs.push(input);
    return (this.rows.get(context.tenantId) ?? [])
      .filter((row) => Date.parse(row.observedAt) >= Date.parse(input.observedAfter))
      .filter((row) => input.sourceKey === undefined || row.sourceKey === input.sourceKey)
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
      .slice(0, input.limit);
  }
}

function service(repository = new FakeTrendRepository()) {
  let sequence = 0;
  return {
    repository,
    value: new TrendService({
      repository,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      uuid: () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    }),
  };
}

describe("TrendService", () => {
  it("persists a bounded batch idempotently and returns freshness-scored topic candidates", async () => {
    const fixture = service();
    const request = {
      observations: [
        {
          sourceKey: "toutiao",
          title: "云南旅游线路推荐",
          summary: "暑期云南线路热度上升",
          canonicalUrl: "https://www.toutiao.com/trending/1",
          sourceRank: 1,
          heatValue: 9_500,
          observedAt: "2026-08-03T11:55:00.000Z",
        },
        {
          sourceKey: "weibo",
          title: "云南旅游线路推荐！",
          sourceRank: 3,
          observedAt: "2026-08-03T11:58:00.000Z",
        },
      ],
    } as const;

    const first = await fixture.value.ingest(actor(), request);
    const replay = await fixture.value.ingest(actor(), request);

    expect(first).toMatchObject({ createdCount: 2, replayedCount: 0 });
    expect(replay).toMatchObject({ createdCount: 0, replayedCount: 2 });
    expect(fixture.repository.rows.get(tenantOne)).toHaveLength(2);

    const candidates = await fixture.value.listTopicCandidates(actor(), {
      limit: 20,
      lookbackMinutes: 1_440,
      includeExpired: false,
    });
    expect(candidates.items).toHaveLength(1);
    expect(candidates.items[0]).toMatchObject({
      title: "云南旅游线路推荐！",
      normalizedTitle: "云南旅游线路推荐",
      observationCount: 2,
      sourceCount: 2,
      sourceKeys: ["toutiao", "weibo"],
      freshnessBand: "emerging",
      observations: [
        { sourceKey: "weibo", sourceRank: 3, freshnessBand: "emerging" },
        { sourceKey: "toutiao", sourceRank: 1, freshnessBand: "emerging" },
      ],
    });
    expect(candidates.items[0]?.freshnessScore).toBeGreaterThan(0.9);
  });

  it("preserves the source's first observation when a later snapshot is selected", async () => {
    const fixture = service();
    const firstObservedAt = "2026-08-03T10:00:00.000Z";
    const latestObservedAt = "2026-08-03T11:55:00.000Z";
    const first = await fixture.value.ingest(actor(), {
      observations: [
        {
          sourceKey: "toutiao",
          title: "云南暑期旅游热度",
          observedAt: firstObservedAt,
          heatValue: 1_000,
        },
      ],
    });
    const latest = await fixture.value.ingest(actor(), {
      observations: [
        {
          sourceKey: "toutiao",
          title: "云南暑期旅游热度",
          observedAt: latestObservedAt,
          heatValue: 2_000,
        },
      ],
    });
    const firstRow = first.items[0];
    const latestRow = latest.items[0];
    if (firstRow === undefined || latestRow === undefined) throw new Error("Missing trend rows");
    fixture.repository.rows.set(tenantOne, [firstRow, { ...latestRow, firstObservedAt }]);

    const candidates = await fixture.value.listTopicCandidates(actor(), {
      limit: 20,
      lookbackMinutes: 1_440,
      includeExpired: false,
    });

    expect(candidates.items[0]).toMatchObject({
      firstObservedAt,
      latestObservedAt,
    });
  });

  it("keeps observations tenant scoped across the repository boundary", async () => {
    const fixture = service();
    await fixture.value.ingest(actor(tenantOne), {
      observations: [
        {
          sourceKey: "toutiao",
          title: "云南旅游线路推荐",
          observedAt: "2026-08-03T11:55:00.000Z",
        },
      ],
    });
    await fixture.value.ingest(actor(tenantTwo), {
      observations: [
        {
          sourceKey: "baidu",
          title: "欧洲游签证新规",
          observedAt: "2026-08-03T11:56:00.000Z",
        },
      ],
    });

    const tenantOneCandidates = await fixture.value.listTopicCandidates(actor(tenantOne), {
      limit: 20,
      lookbackMinutes: 1_440,
      includeExpired: false,
    });
    expect(tenantOneCandidates.items.map((item) => item.normalizedTitle)).toEqual([
      "云南旅游线路推荐",
    ]);
  });

  it("recalculates freshness at read time and hides expired candidates by default", async () => {
    const fixture = service();
    await fixture.value.ingest(actor(), {
      observations: [
        {
          sourceKey: "sohu-news",
          title: "旧的旅游话题",
          observedAt: "2026-07-20T11:55:00.000Z",
        },
      ],
    });

    const hidden = await fixture.value.listTopicCandidates(actor(), {
      limit: 20,
      lookbackMinutes: 43_200,
      includeExpired: false,
    });
    const visible = await fixture.value.listTopicCandidates(actor(), {
      limit: 20,
      lookbackMinutes: 43_200,
      includeExpired: true,
    });

    expect(hidden.items).toEqual([]);
    expect(visible.items[0]).toMatchObject({ freshnessBand: "expired", freshnessScore: 0 });
  });

  it("rejects future observations and callers without the required content capability", async () => {
    const fixture = service();
    await expect(
      fixture.value.ingest(actor(), {
        observations: [
          {
            sourceKey: "zhihu",
            title: "未来时间戳",
            observedAt: "2026-08-03T12:06:00.000Z",
          },
        ],
      }),
    ).rejects.toThrow("future");

    await expect(
      fixture.value.listTopicCandidates(
        { ...actor(), capabilities: ["content:write"] },
        { limit: 20, lookbackMinutes: 1_440, includeExpired: false },
      ),
    ).rejects.toThrow();
  });

  it("accepts observations only from registered collectors and matching source hosts", async () => {
    const fixture = service();

    await expect(
      fixture.value.ingest(
        { ...actor(), role: "editor", capabilities: ["content:read", "content:write"] },
        {
          observations: [
            {
              sourceKey: "toutiao",
              title: "云南旅游线路推荐",
              observedAt: "2026-08-03T11:55:00.000Z",
            },
          ],
        },
      ),
    ).rejects.toThrow();
    await expect(
      fixture.value.ingest(actor(), {
        observations: [
          {
            sourceKey: "unregistered-source",
            title: "云南旅游线路推荐",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_NOT_ALLOWED" });
    await expect(
      fixture.value.ingest(actor(), {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            canonicalUrl: "https://127.0.0.1/private",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "TREND_SOURCE_URL_NOT_ALLOWED" });
    expect(fixture.repository.rows.get(tenantOne) ?? []).toEqual([]);
  });

  it("validates the normalized Unicode title and bounds clustering input", async () => {
    const fixture = service();

    await expect(
      fixture.value.ingest(actor(), {
        observations: [
          {
            sourceKey: "toutiao",
            title: "ﷺ".repeat(21),
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "TREND_OBSERVATION_INVALID" });

    await fixture.value.listTopicCandidates(actor(), {
      limit: 100,
      lookbackMinutes: 1_440,
      includeExpired: false,
    });
    expect(fixture.repository.listInputs.at(-1)).toMatchObject({ limit: 301 });
  });
});
