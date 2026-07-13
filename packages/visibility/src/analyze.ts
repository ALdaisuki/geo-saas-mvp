import { createHash } from "node:crypto";

import type { VisibilityObservation } from "@geo/contracts";

import type {
  AdapterEvidence,
  BrandTruth,
  VisibilityMetrics,
  VisibilitySampleRequest,
} from "./types.js";

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
  const wechatTokens =
    answer.match(/(?:微信(?:号|咨询)?[:：\s]*)?([A-Za-z][A-Za-z0-9_-]{5,19})/g) ?? [];

  return [...phoneTokens, ...wechatTokens].map(compactContact);
}

function contactAnalysis(
  answer: string,
  truth: BrandTruth,
): {
  accuracy: number;
  harmfulError: boolean;
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
    };
  }

  const correctObserved = observed.filter((contact) => expected.includes(contact)).length;
  return {
    accuracy: correctObserved / observed.length,
    harmfulError: unexpectedObserved,
  };
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
  const brandMentioned = request.truth.brandNames.some((name) =>
    containsValue(evidence.rawAnswer, name),
  );
  const competitors = request.truth.knownCompetitors.filter((name) =>
    containsValue(evidence.rawAnswer, name),
  );
  const contacts = contactAnalysis(evidence.rawAnswer, request.truth);

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
    observedAt: evidence.observedAt,
    brandMentioned,
    answerPosition: firstBrandPosition(evidence.rawAnswer, request.truth.brandNames),
    contactAccuracy: contacts.accuracy,
    competitorMentions: competitors,
    harmfulError: contacts.harmfulError,
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
    };
  }

  const brandMentions = observations.filter((observation) => observation.brandMentioned).length;
  const cited = observations.filter((observation) => observation.citedUrls.length > 0).length;
  const competitorSamples = observations.filter(
    (observation) => observation.competitorMentions.length > 0,
  ).length;
  const harmful = observations.filter((observation) => observation.harmfulError).length;
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
  };
}
