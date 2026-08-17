import { describe, expect, it } from "vitest";

import {
  analyzeVisibilityEvidence,
  calculateVisibilityMetrics,
  FixtureVisibilityAdapter,
  ManualVisibilityAdapter,
  travelQuerySetPromptsV1,
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
  brandId: "00000000-0000-4000-8000-000000000004",
  brandNames: ["示例国际旅行服务"],
  expectedContacts: ["4000000001", "TRAVEL_DEMO_01", "TRAVEL_DEMO_02"],
  competitors: [
    {
      canonicalName: "测试竞品旅行社",
      aliases: ["测试竞品"],
      sourceType: "tenant_configured",
      sourceRef: "test:competitor:v1",
    },
  ],
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
          answer: "示例国际旅行服务24小时热线为 4000000001。",
          citedUrls: ["https://example.test/sample-contact"],
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
    expect(observation.requestStartedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(observation.responseReceivedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(observation.sentiment).toBe("neutral");
    expect(observation.hallucinationFindings).toEqual([]);
    expect(observation.evaluatorVersion).toBe("geo-visibility-evaluator-v1");
  });

  it("flags a fabricated Qwen contact as a harmful error", async () => {
    const adapter = new FixtureVisibilityAdapter("qwen", {
      "brand-phone": {
        answer: "示例国际旅行服务联系电话可能是 4009999999。",
      },
    });
    const evidence = await adapter.sample(request("qwen"));
    const observation = analyzeVisibilityEvidence(request("qwen"), evidence);

    expect(observation.contactAccuracy).toBe(0);
    expect(observation.harmfulError).toBe(true);
    expect(observation.hallucinationFindings).toEqual([
      expect.objectContaining({
        code: "unexpected_contact",
        category: "contact",
        severity: "high",
        observedValue: "4009999999",
      }),
    ]);
  });

  it("binds evidence hashes to provider and query provenance", () => {
    const evidence = {
      rawAnswer: "示例国际旅行服务24小时热线为 4000000001。",
      citedUrls: ["https://example.test/sample-contact"],
      requestStartedAt: "2026-07-13T12:00:00.000Z",
      responseReceivedAt: "2026-07-13T12:00:01.000Z",
      observedAt: "2026-07-13T12:00:01.000Z",
      observationMethod: "fixture" as const,
      evidenceType: "fixture" as const,
    };

    const doubao = analyzeVisibilityEvidence(request("doubao"), evidence);
    const qwen = analyzeVisibilityEvidence(request("qwen"), evidence);
    const anotherQuery = analyzeVisibilityEvidence(request("doubao", "brand-reputation"), evidence);

    expect(qwen.evidenceHash).not.toBe(doubao.evidenceHash);
    expect(anotherQuery.evidenceHash).not.toBe(doubao.evidenceHash);
    expect(analyzeVisibilityEvidence(request("doubao"), evidence).evidenceHash).toBe(
      doubao.evidenceHash,
    );
  });

  it("does not misclassify a negated recommendation as positive sentiment", () => {
    const observation = analyzeVisibilityEvidence(request("qwen", "brand-reputation"), {
      rawAnswer: "没有足够证据时不推荐该服务，也不能据此判断其不靠谱。",
      citedUrls: [],
      requestStartedAt: "2026-07-13T12:00:00.000Z",
      responseReceivedAt: "2026-07-13T12:00:01.000Z",
      observedAt: "2026-07-13T12:00:01.000Z",
      observationMethod: "manual",
      evidenceType: "manual_import",
    });

    expect(observation.sentiment).toBe("negative");
  });

  it("does not classify English brand prose as WeChat IDs", () => {
    const observation = analyzeVisibilityEvidence(request("doubao"), {
      rawAnswer:
        "Example Travel Services is the English brand name. 示例国际旅行服务热线 4000000001。微信咨询：TRAVEL_DEMO_01 或 TRAVEL_DEMO_02。",
      citedUrls: [],
      requestStartedAt: "2026-07-13T11:59:59.000Z",
      responseReceivedAt: "2026-07-13T12:00:00.000Z",
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
      requestStartedAt: "2026-07-13T11:59:59.000Z",
      responseReceivedAt: "2026-07-13T12:00:00.000Z",
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
        rawAnswer: "示例国际旅行服务热线 4000000001。",
        citedUrls: ["https://one.example/source"],
        requestStartedAt: "2026-07-13T11:59:59.000Z",
        responseReceivedAt: "2026-07-13T12:00:00.000Z",
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
      answerPosition: null,
      sentiment: "negative" as const,
      hallucinationFindings: [
        {
          code: "unsupported_claim",
          category: "brand" as const,
          severity: "medium" as const,
          statement: "没有可靠联系方式",
          observedValue: null,
          expectedValues: [],
        },
      ],
    };

    const metrics = calculateVisibilityMetrics([base, second]);

    expect(metrics.sampleCount).toBe(2);
    expect(metrics.brandMentionRate).toBe(0.5);
    expect(metrics.sourceDiversity).toBe(2);
    expect(metrics.shareOfVoice).toBe(0.5);
    expect(metrics.averageAnswerPosition).toBe(base.answerPosition);
    expect(metrics.negativeSentimentRate).toBe(0.5);
    expect(metrics.hallucinationFindingRate).toBe(0.5);
    expect(metrics.brandMentionWilsonLow).toBeLessThan(metrics.brandMentionRate);
    expect(metrics.brandMentionWilsonHigh).toBeGreaterThan(metrics.brandMentionRate);
  });

  it("ships one canonical versioned travel pack with comparison, negative and blank controls", () => {
    expect(travelQuerySetV1.version).toBe("1.0.0");
    expect(travelQuerySetV1.queries.some((query) => query.intent === "contact")).toBe(true);
    expect(travelQuerySetV1.queries.some((query) => query.intent === "comparison")).toBe(true);
    expect(travelQuerySetV1.queries.some((query) => query.intent === "negative_control")).toBe(
      true,
    );
    expect(travelQuerySetV1.queries.some((query) => query.intent === "blank_control")).toBe(true);
    expect(travelQuerySetPromptsV1).toHaveLength(travelQuerySetV1.queries.length);
    expect(travelQuerySetPromptsV1.every((prompt) => prompt.packVersion === "1.0.0")).toBe(true);
    expect(new Set(travelQuerySetPromptsV1.map((prompt) => prompt.key)).size).toBe(
      travelQuerySetPromptsV1.length,
    );
  });

  it("uses tenant-scoped competitor truth and canonicalizes alias mentions", () => {
    const observation = analyzeVisibilityEvidence(request("qwen", "brand-comparison"), {
      rawAnswer: "示例国际旅行服务和测试竞品都值得比较，推荐先核验退改规则。",
      citedUrls: [],
      requestStartedAt: "2026-07-13T12:00:00.000Z",
      responseReceivedAt: "2026-07-13T12:00:01.000Z",
      observedAt: "2026-07-13T12:00:01.000Z",
      observationMethod: "manual",
      evidenceType: "manual_import",
    });

    expect(observation.competitorMentions).toEqual(["测试竞品旅行社"]);
    expect(observation.sentiment).toBe("positive");
  });
});
