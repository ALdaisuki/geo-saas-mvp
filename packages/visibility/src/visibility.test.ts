import { describe, expect, it } from "vitest";

import {
  analyzeVisibilityEvidence,
  calculateVisibilityMetrics,
  FixtureVisibilityAdapter,
  ManualVisibilityAdapter,
  travelQuerySetV1,
} from "./index.js";
import type { BrandTruth, VisibilitySampleRequest } from "./types.js";

const ids = {
  tenant: "00000000-0000-4000-8000-000000000001",
  run: "00000000-0000-4000-8000-000000000002",
  observation: "00000000-0000-4000-8000-000000000003",
};

const truth: BrandTruth = {
  tenantId: ids.tenant,
  brandNames: ["中通国际旅行社"],
  expectedContacts: ["4001133986", "ZTGL3411", "ZTGL6431"],
  knownCompetitors: ["测试竞品旅行社"],
};

function request(provider: "doubao" | "qwen", queryId = "brand-phone"): VisibilitySampleRequest {
  const query = travelQuerySetV1.queries.find((candidate) => candidate.id === queryId);
  if (query === undefined) {
    throw new Error(`Missing query ${queryId}`);
  }

  return {
    runId: ids.run,
    observationId: ids.observation,
    provider,
    productSurface: `${provider}-fixture`,
    model: `${provider}-fixture-v1`,
    searchMode: "unknown",
    query,
    querySetVersion: travelQuerySetV1.version,
    locale: "zh-CN",
    geo: "CN",
    truth,
  };
}

describe("domestic AI visibility evaluation", () => {
  it("keeps Doubao fixture evidence explicitly separate from live provider evidence", async () => {
    const adapter = new FixtureVisibilityAdapter(
      "doubao",
      {
        "brand-phone": {
          answer: "中通国际旅行社24小时热线为 4001133986。",
          citedUrls: ["https://example.test/zhongtong-contact"],
        },
      },
      () => new Date("2026-07-13T12:00:00.000Z"),
    );

    const evidence = await adapter.sample(request("doubao"));
    const observation = analyzeVisibilityEvidence(request("doubao"), evidence);

    expect(observation.observationMethod).toBe("fixture");
    expect(observation.evidenceType).toBe("fixture");
    expect(observation.brandMentioned).toBe(true);
    expect(observation.contactAccuracy).toBe(1);
    expect(observation.harmfulError).toBe(false);
  });

  it("flags a fabricated Qwen contact as a harmful error", async () => {
    const adapter = new FixtureVisibilityAdapter("qwen", {
      "brand-phone": {
        answer: "中通国际旅行社联系电话可能是 4009999999。",
      },
    });
    const evidence = await adapter.sample(request("qwen"));
    const observation = analyzeVisibilityEvidence(request("qwen"), evidence);

    expect(observation.contactAccuracy).toBe(0);
    expect(observation.harmfulError).toBe(true);
  });

  it("does not classify English brand prose as WeChat IDs", () => {
    const observation = analyzeVisibilityEvidence(request("doubao"), {
      rawAnswer:
        "Zhongtong International Travel Agency is the English brand name. 中通国际旅行社热线 4001133986。微信咨询：ZTGL3411 或 ZTGL6431。",
      citedUrls: [],
      observedAt: "2026-07-13T12:00:00.000Z",
      observationMethod: "fixture",
      evidenceType: "fixture",
    });

    expect(observation.contactAccuracy).toBe(1);
    expect(observation.harmfulError).toBe(false);
  });

  it("rejects manual imports that masquerade as API or fixture evidence", async () => {
    const adapter = new ManualVisibilityAdapter("doubao", async () => ({
      rawAnswer: "manual answer",
      citedUrls: [],
      observedAt: "2026-07-13T12:00:00.000Z",
      observationMethod: "official_api",
      evidenceType: "api_response",
    }));

    await expect(adapter.sample(request("doubao"))).rejects.toThrow(
      "Manual adapters must return manual/manual_import evidence",
    );
  });

  it("calculates repeated-sample metrics instead of treating one score as truth", () => {
    const base = {
      ...analyzeVisibilityEvidence(request("doubao"), {
        rawAnswer: "中通国际旅行社热线 4001133986。",
        citedUrls: ["https://one.example/source"],
        observedAt: "2026-07-13T12:00:00.000Z",
        observationMethod: "fixture" as const,
        evidenceType: "fixture" as const,
      }),
    };
    const second = {
      ...base,
      id: "00000000-0000-4000-8000-000000000004",
      rawAnswer: "测试竞品旅行社被提及，但没有可靠联系方式。",
      citedUrls: ["https://two.example/source"],
      brandMentioned: false,
      competitorMentions: ["测试竞品旅行社"],
      contactAccuracy: 1,
    };

    const metrics = calculateVisibilityMetrics([base, second]);

    expect(metrics.sampleCount).toBe(2);
    expect(metrics.brandMentionRate).toBe(0.5);
    expect(metrics.sourceDiversity).toBe(2);
    expect(metrics.shareOfVoice).toBe(0.5);
    expect(metrics.brandMentionWilsonLow).toBeLessThan(metrics.brandMentionRate);
    expect(metrics.brandMentionWilsonHigh).toBeGreaterThan(metrics.brandMentionRate);
  });

  it("ships both brand/contact prompts and negative controls", () => {
    expect(travelQuerySetV1.queries.some((query) => query.intent === "contact")).toBe(true);
    expect(travelQuerySetV1.queries.some((query) => query.isControl)).toBe(true);
  });
});
