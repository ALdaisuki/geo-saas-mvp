import type {
  EvidenceType,
  HallucinationFinding,
  ObservationMethod,
  VisibilityObservation,
  VisibilityProvider,
} from "@geo/contracts";

export type VisibilityIntent =
  | "category"
  | "origin"
  | "audience"
  | "guidance"
  | "brand"
  | "contact"
  | "comparison"
  | "negative_control"
  | "blank_control";

export interface VisibilityQuery {
  id: string;
  intent: VisibilityIntent;
  prompt: string;
  expectedFactKeys: string[];
  isControl: boolean;
}

export interface VisibilityQuerySet {
  id: string;
  industry: string;
  locale: string;
  version: string;
  queries: VisibilityQuery[];
}

export interface BrandTruth {
  tenantId: string;
  brandId: string;
  brandNames: string[];
  expectedContacts: string[];
  competitors: CompetitorTruth[];
}

export interface CompetitorTruth {
  canonicalName: string;
  aliases: string[];
  sourceType: "tenant_configured" | "verified_public" | "manual_import";
  sourceRef: string;
}

export interface VisibilitySampleRequest {
  runId: string;
  observationId: string;
  provider: VisibilityProvider;
  productSurface: string;
  model: string;
  searchMode: "on" | "off" | "unknown";
  query: VisibilityQuery;
  querySetVersion: string;
  locale: string;
  geo: string | null;
  truth: BrandTruth;
}

export interface AdapterEvidence {
  rawAnswer: string;
  citedUrls: string[];
  requestStartedAt: string;
  responseReceivedAt: string;
  observedAt: string;
  observationMethod: ObservationMethod;
  evidenceType: EvidenceType;
}

export interface VisibilityAdapter {
  readonly provider: VisibilityProvider;
  readonly method: ObservationMethod;
  sample(request: VisibilitySampleRequest): Promise<AdapterEvidence>;
}

export interface VisibilityMetrics {
  sampleCount: number;
  brandMentionRate: number;
  brandMentionWilsonLow: number;
  brandMentionWilsonHigh: number;
  citationRate: number;
  sourceDiversity: number;
  contactAccuracy: number;
  competitorMentionRate: number;
  shareOfVoice: number;
  harmfulErrorRate: number;
  brandMentionVolatility: number;
  averageAnswerPosition: number;
  positiveSentimentRate: number;
  negativeSentimentRate: number;
  hallucinationFindingRate: number;
}

export type VisibilityHallucinationFinding = HallucinationFinding;

export type ImportedObservation = Omit<
  VisibilityObservation,
  | "brandMentioned"
  | "answerPosition"
  | "contactAccuracy"
  | "competitorMentions"
  | "sentiment"
  | "hallucinationFindings"
  | "harmfulError"
  | "evaluatorVersion"
  | "evidenceHash"
>;
