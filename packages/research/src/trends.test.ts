import { describe, expect, it } from "vitest";

import {
  buildTrendObservation,
  clusterTrendObservations,
  normalizeTrendTitle,
  trendFreshness,
  type TrendObservationInput,
} from "./trends.js";

const now = new Date("2026-08-03T12:00:00.000Z");

function observation(overrides: Partial<TrendObservationInput> = {}): TrendObservationInput {
  return {
    sourceKey: "toutiao",
    title: "云南旅游线路推荐",
    sourceRank: 1,
    heatValue: 9_500,
    observedAt: "2026-08-03T11:55:00.000Z",
    ...overrides,
  };
}

describe("trend intelligence", () => {
  it("normalizes punctuation and whitespace without changing Chinese meaning", () => {
    expect(normalizeTrendTitle("  云南旅游：线路推荐！ ")).toBe("云南旅游线路推荐");
  });

  it("decays freshness from the source update time and marks old evidence expired", () => {
    expect(trendFreshness({ observedAt: "2026-08-03T11:55:00.000Z" }, now)).toMatchObject({
      score: expect.any(Number),
      band: "emerging",
    });
    expect(trendFreshness({ observedAt: "2026-07-20T11:55:00.000Z" }, now)).toMatchObject({
      band: "expired",
      score: 0,
    });
    expect(
      trendFreshness(
        {
          observedAt: "2026-08-03T11:55:00.000Z",
          sourceUpdatedAt: "2026-07-20T11:55:00.000Z",
        },
        now,
      ),
    ).toMatchObject({
      band: "expired",
      score: 0,
      ageMinutes: 20_165,
    });
  });

  it("normalizes source heat monotonically across the 100/101 boundary", () => {
    const scoreAt100 = buildTrendObservation(observation({ heatValue: 100 }), now).heatScore;
    const scoreAt101 = buildTrendObservation(observation({ heatValue: 101 }), now).heatScore;

    expect(scoreAt101).toBeGreaterThan(scoreAt100);
    expect(scoreAt101 - scoreAt100).toBeLessThan(0.02);
  });

  it("builds a bounded, inspectable observation", () => {
    const result = buildTrendObservation(observation(), now);
    expect(result).toMatchObject({
      sourceKey: "toutiao",
      title: "云南旅游线路推荐",
      normalizedTitle: "云南旅游线路推荐",
      freshnessBand: "emerging",
      heatScore: expect.any(Number),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.heatScore).toBeGreaterThan(0);
    expect(result.heatScore).toBeLessThanOrEqual(100);
  });

  it("clusters duplicate observations and keeps the freshest representative first", () => {
    const observations = [
      buildTrendObservation(observation({ sourceKey: "toutiao" }), now),
      buildTrendObservation(
        observation({
          sourceKey: "weibo",
          title: "云南旅游线路推荐！",
          observedAt: "2026-08-03T11:58:00.000Z",
          sourceRank: 3,
        }),
        now,
      ),
      buildTrendObservation(
        observation({ sourceKey: "zhihu", title: "北京出发欧洲游旅行社推荐" }),
        now,
      ),
    ];

    const clusters = clusterTrendObservations(observations);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.observations).toHaveLength(2);
    expect(clusters[0]?.title).toBe("云南旅游线路推荐");
    expect(clusters[1]?.title).toBe("北京出发欧洲游旅行社推荐");
  });
});
