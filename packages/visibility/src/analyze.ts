import { createHash } from "node:crypto";

import type { VisibilityObservation } from "@geo/contracts";

import type {
  AdapterEvidence,
  BrandTruth,
  VisibilityMetrics,
  VisibilitySampleRequest,
} from "./types.js";

export const VISIBILITY_EVALUATOR_VERSION = "geo-visibility-evaluator-v1";

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function compactContact(value: string): string {
  return normalized(value).replace(/[\s()+-]/g, "");
}

function containsValue(answer: string, value: string): boolean {
  const normalizedAnswer = normalized(answer);
  const normalizedValue = normalized(value);
  if (normalizedValue.length === 0) {
    return false;
  }

  if (/^[\d\s()+-]+$/.test(value)) {
    return compactContact(answer).includes(compactContact(value));
  }

  return normalizedAnswer.includes(normalizedValue);
}

function extractContactLikeTokens(answer: string): string[] {
  const phoneTokens = answer.match(/(?:\+?86[-\s]?)?(?:400[-\s]?\d{3}[-\s]?\d{4}|1\d{10})/g) ?? [];
  const wechatTokens: string[] = [];
  const keywordPattern = /微信(?:号|咨询)?|wechat|wx|vx/i;
  for (const line of answer.split(/\r?\n/u)) {
    const keyword = keywordPattern.exec(line);
    if (keyword === null) continue;
    const tail = line.slice(keyword.index + keyword[0].length);
    const sentence = tail.split(/[.!?。！？;]/u, 1)[0] ?? "";
    for (const match of sentence.matchAll(/[A-Za-z][A-Za-z0-9_-]{5,19}/g)) {
      const value = match[0].toLowerCase();
      if (value !== "wechat" && value !== "weixin") wechatTokens.push(match[0]);
    }
  }

  return [...phoneTokens, ...wechatTokens].map(compactContact);
}

function contactAnalysis(
  answer: string,
  truth: BrandTruth,
): {
  accuracy: number;
  harmfulError: boolean;
  unexpectedContacts: string[];
} {
  const expected = truth.expectedContacts.map(compactContact);
  const expectedFound = expected.filter((contact) => compactContact(answer).includes(contact));
  const observed = extractContactLikeTokens(answer);
  const unexpectedObserved = observed.some(
    (contact) => !expected.includes(contact) && !contact.startsWith("http"),
  );

  if (observed.length === 0) {
    return {
      accuracy: expectedFound.length === 0 ? 1 : expectedFound.length / expected.length,
      harmfulError: false,
      unexpectedContacts: [],
    };
  }

  const correctObserved = observed.filter((contact) => expected.includes(contact)).length;
  return {
    accuracy: correctObserved / observed.length,
    harmfulError: unexpectedObserved,
    unexpectedContacts: [...new Set(observed.filter((contact) => !expected.includes(contact)))],
  };
}

function sentiment(answer: string): VisibilityObservation["sentiment"] {
  const value = normalized(answer);
  const negative = ["不推荐", "不靠谱", "投诉", "较差", "风险", "错误"].some((token) =>
    value.includes(token),
  );
  const positiveText = value.replaceAll("不推荐", "").replaceAll("不靠谱", "");
  const positive = ["推荐", "靠谱", "值得", "满意", "优质"].some((token) =>
    positiveText.includes(token),
  );
  if (positive && negative) return "mixed";
  if (positive) return "positive";
  if (negative) return "negative";
  return "neutral";
}

function firstBrandPosition(answer: string, brandNames: string[]): number | null {
  const positions = brandNames
    .map((name) => normalized(answer).indexOf(normalized(name)))
    .filter((position) => position >= 0);

  if (positions.length === 0) {
    return null;
  }

  return Math.min(...positions) + 1;
}

function evidenceHash(evidence: AdapterEvidence): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        citedUrls: [...evidence.citedUrls].sort(),
        evidenceType: evidence.evidenceType,
        observationMethod: evidence.observationMethod,
        requestStartedAt: evidence.requestStartedAt,
        responseReceivedAt: evidence.responseReceivedAt,
        observedAt: evidence.observedAt,
        rawAnswer: evidence.rawAnswer,
      }),
    )
    .digest("hex");
}

export function analyzeVisibilityEvidence(
  request: VisibilitySampleRequest,
  evidence: AdapterEvidence,
): VisibilityObservation {
  const requestStartedAt = Date.parse(evidence.requestStartedAt);
  const responseReceivedAt = Date.parse(evidence.responseReceivedAt);
  if (
    !Number.isFinite(requestStartedAt) ||
    !Number.isFinite(responseReceivedAt) ||
    responseReceivedAt < requestStartedAt
  ) {
    throw new TypeError("Visibility evidence has invalid request/response timestamps");
  }
  const brandMentioned = request.truth.brandNames.some((name) =>
    containsValue(evidence.rawAnswer, name),
  );
  const competitors = request.truth.competitors
    .filter((competitor) =>
      [competitor.canonicalName, ...competitor.aliases].some((name) =>
        containsValue(evidence.rawAnswer, name),
      ),
    )
    .map((competitor) => competitor.canonicalName);
  const contacts = contactAnalysis(evidence.rawAnswer, request.truth);
  const hallucinationFindings = contacts.unexpectedContacts.map((observedValue) => ({
    code: "unexpected_contact",
    category: "contact" as const,
    severity: "high" as const,
    statement: "回答包含未登记的联系方式",
    observedValue,
    expectedValues: [...request.truth.expectedContacts],
  }));

  return {
    id: request.observationId,
    tenantId: request.truth.tenantId,
    runId: request.runId,
    provider: request.provider,
    productSurface: request.productSurface,
    model: request.model,
    searchMode: request.searchMode,
    observationMethod: evidence.observationMethod,
    prompt: request.query.prompt,
    promptVersion: request.querySetVersion,
    locale: request.locale,
    geo: request.geo,
    rawAnswer: evidence.rawAnswer,
    citedUrls: evidence.citedUrls,
    evidenceHash: evidenceHash(evidence),
    evidenceType: evidence.evidenceType,
    requestStartedAt: evidence.requestStartedAt,
    responseReceivedAt: evidence.responseReceivedAt,
    observedAt: evidence.observedAt,
    brandMentioned,
    answerPosition: firstBrandPosition(evidence.rawAnswer, request.truth.brandNames),
    contactAccuracy: contacts.accuracy,
    competitorMentions: competitors,
    sentiment: sentiment(evidence.rawAnswer),
    hallucinationFindings,
    harmfulError: contacts.harmfulError,
    evaluatorVersion: VISIBILITY_EVALUATOR_VERSION,
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function wilsonInterval(successes: number, total: number): [number, number] {
  if (total === 0) {
    return [0, 0];
  }

  const z = 1.96;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = proportion + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total));

  return [(center - margin) / denominator, (center + margin) / denominator];
}

export function calculateVisibilityMetrics(
  observations: readonly VisibilityObservation[],
): VisibilityMetrics {
  const sampleCount = observations.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      brandMentionRate: 0,
      brandMentionWilsonLow: 0,
      brandMentionWilsonHigh: 0,
      citationRate: 0,
      sourceDiversity: 0,
      contactAccuracy: 0,
      competitorMentionRate: 0,
      shareOfVoice: 0,
      harmfulErrorRate: 0,
      brandMentionVolatility: 0,
      averageAnswerPosition: 0,
      positiveSentimentRate: 0,
      negativeSentimentRate: 0,
      hallucinationFindingRate: 0,
    };
  }

  const brandMentions = observations.filter((observation) => observation.brandMentioned).length;
  const cited = observations.filter((observation) => observation.citedUrls.length > 0).length;
  const competitorSamples = observations.filter(
    (observation) => observation.competitorMentions.length > 0,
  ).length;
  const harmful = observations.filter((observation) => observation.harmfulError).length;
  const answerPositions = observations.flatMap((observation) =>
    observation.answerPosition === null ? [] : [observation.answerPosition],
  );
  const positiveSentiments = observations.filter(
    (observation) => observation.sentiment === "positive",
  ).length;
  const negativeSentiments = observations.filter(
    (observation) => observation.sentiment === "negative",
  ).length;
  const hallucinationSamples = observations.filter(
    (observation) => observation.hallucinationFindings.length > 0,
  ).length;
  const sourceDomains = new Set(
    observations.flatMap((observation) =>
      observation.citedUrls.map((url) => new URL(url).hostname.toLocaleLowerCase("en-US")),
    ),
  );
  const contactAccuracy =
    observations.reduce((sum, observation) => sum + observation.contactAccuracy, 0) / sampleCount;
  const brandRate = brandMentions / sampleCount;
  const variance =
    observations.reduce(
      (sum, observation) => sum + (Number(observation.brandMentioned) - brandRate) ** 2,
      0,
    ) / sampleCount;
  const totalVoice = brandMentions + competitorSamples;
  const [wilsonLow, wilsonHigh] = wilsonInterval(brandMentions, sampleCount);

  return {
    sampleCount,
    brandMentionRate: round(brandRate),
    brandMentionWilsonLow: round(wilsonLow),
    brandMentionWilsonHigh: round(wilsonHigh),
    citationRate: round(cited / sampleCount),
    sourceDiversity: sourceDomains.size,
    contactAccuracy: round(contactAccuracy),
    competitorMentionRate: round(competitorSamples / sampleCount),
    shareOfVoice: round(totalVoice === 0 ? 0 : brandMentions / totalVoice),
    harmfulErrorRate: round(harmful / sampleCount),
    brandMentionVolatility: round(Math.sqrt(variance)),
    averageAnswerPosition: round(
      answerPositions.length === 0
        ? 0
        : answerPositions.reduce((sum, position) => sum + position, 0) / answerPositions.length,
    ),
    positiveSentimentRate: round(positiveSentiments / sampleCount),
    negativeSentimentRate: round(negativeSentiments / sampleCount),
    hallucinationFindingRate: round(hallucinationSamples / sampleCount),
  };
}
