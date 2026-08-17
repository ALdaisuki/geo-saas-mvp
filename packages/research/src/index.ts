export { ResearchCollector } from "./collector.js";
export { parseResearchHtml } from "./html.js";
export { NodeHttpsResearchTransport } from "./node-transport.js";
export {
  buildTrendObservation,
  clusterTrendObservations,
  normalizeTrendTitle,
  trendFreshness,
  type TrendCluster,
  type TrendFreshness,
  type TrendFreshnessBand,
  type TrendObservation,
  type TrendObservationInput,
} from "./trends.js";
export {
  NodeTrendSourceHttpTransport,
  PUBLIC_TREND_SOURCES,
  PUBLIC_TREND_SOURCE_KEYS,
  PublicTrendCollector,
  TrendSourceCollectionError,
  parseBaiduTrendPayload,
  parseNeteaseTrendPayload,
  parsePublicTrendPayload,
  parseSohuTrendPayload,
  parseToutiaoTrendPayload,
  parseWeiboTrendPayload,
  parseZhihuTrendPayload,
  type CollectedTrendObservation,
  type PublicTrendCollectorOptions,
  type PublicTrendSourceDefinition,
  type PublicTrendSourceKey,
  type TrendSourceCollectionErrorCode,
  type TrendSourceCollectionResult,
  type TrendSourceHttpRequest,
  type TrendSourceHttpResponse,
  type TrendSourceHttpTransport,
} from "./trend-sources.js";
export {
  assertPublicAddresses,
  normalizeResearchUrl,
  validateResearchPolicy,
} from "./url-policy.js";
export {
  ResearchCollectionError,
  type ResearchErrorCode,
  type ResearchHttpRequest,
  type ResearchHttpResponse,
  type ResearchPageSnapshot,
  type ResearchPolicy,
  type ResearchRobotsEvidence,
  type ResearchTransport,
} from "./types.js";
