import {
  GeoApiError,
  type ArticleTemplateCatalogView,
  type AutomationSnapshot,
  type AuditArtifact,
  type Brand,
  type BrandAgentProfile,
  type Campaign,
  type ChannelAccount,
  type CtripBridgeStatus,
  type CtripPlatformAnalyticsDashboard,
  type PriorityPlatformAnalyticsDashboard,
  type ClaimFact,
  type ContentItem,
  type EvidenceSource,
  type GeoApi,
  type PublicationJob,
  type PublicationAssistedHandoff,
  type PublicationReceipt,
  type PolicyBundle,
  type QuerySet,
  type ServicePrincipal,
  type TenantContact,
  type TenantMember,
  type TenantOption,
  type TenantView,
  type TrendTopicCandidate,
  type VisibilityProviderSummary,
} from "./api.js";

export interface ResourceError {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly status: number;
}

export interface ApiResource<T> {
  readonly endpoint: string;
  readonly data: T;
  readonly error: ResourceError | null;
  readonly status: "loading" | "ready" | "error";
}

export interface LiveDashboard {
  readonly tenant: ApiResource<TenantView | null>;
  readonly tenants: ApiResource<readonly TenantOption[]>;
  readonly contacts: ApiResource<readonly TenantContact[]>;
  readonly channelAccounts: ApiResource<readonly ChannelAccount[]>;
  readonly ctripAccountAnalytics: ApiResource<CtripPlatformAnalyticsDashboard | null>;
  readonly priorityPlatformAnalytics: ApiResource<PriorityPlatformAnalyticsDashboard | null>;
  readonly brands: ApiResource<readonly Brand[]>;
  readonly brandAgentProfiles: ApiResource<readonly BrandAgentProfile[]>;
  readonly members: ApiResource<readonly TenantMember[]>;
  readonly policies: ApiResource<readonly PolicyBundle[]>;
  readonly querySets: ApiResource<readonly QuerySet[]>;
  readonly articleTemplates: ApiResource<ArticleTemplateCatalogView | null>;
  readonly trendCandidates: ApiResource<readonly TrendTopicCandidate[]>;
  readonly evidenceSources: ApiResource<readonly EvidenceSource[]>;
  readonly facts: ApiResource<readonly ClaimFact[]>;
  readonly campaigns: ApiResource<readonly Campaign[]>;
  readonly content: ApiResource<readonly ContentItem[]>;
  readonly audits: ApiResource<readonly AuditArtifact[]>;
  readonly publicationJobs: ApiResource<readonly PublicationJob[]>;
  readonly publicationAssistedHandoffs: ApiResource<readonly PublicationAssistedHandoff[]>;
  readonly receipts: ApiResource<readonly PublicationReceipt[]>;
  readonly visibility: ApiResource<readonly VisibilityProviderSummary[]>;
  readonly automation: ApiResource<AutomationSnapshot | null>;
  readonly ctripBridge: ApiResource<CtripBridgeStatus | null>;
  readonly servicePrincipals: ApiResource<readonly ServicePrincipal[]>;
  readonly loadedAt: string | null;
}

export interface LiveOperationsResources {
  readonly trendCandidates: ApiResource<readonly TrendTopicCandidate[]>;
  readonly content: ApiResource<readonly ContentItem[]>;
  readonly publicationJobs: ApiResource<readonly PublicationJob[]>;
  readonly receipts: ApiResource<readonly PublicationReceipt[]>;
  readonly loadedAt: string;
}

function loading<T>(endpoint: string, data: T): ApiResource<T> {
  return { endpoint, data, error: null, status: "loading" };
}

export function createLoadingDashboard(): LiveDashboard {
  return {
    tenant: loading("GET /api/tenant", null),
    tenants: loading("GET /api/auth/tenants", []),
    contacts: loading("GET /api/contacts", []),
    channelAccounts: loading("GET /api/channel-accounts", []),
    ctripAccountAnalytics: loading("GET /api/channel-accounts/ctrip-analytics", null),
    priorityPlatformAnalytics: loading(
      "GET /api/channel-accounts/priority-platform-analytics",
      null,
    ),
    brands: loading("GET /api/brands", []),
    brandAgentProfiles: loading("GET /api/brand-agent-profiles", []),
    members: loading("GET /api/members", []),
    policies: loading("GET /api/policies", []),
    querySets: loading("GET /api/query-sets", []),
    articleTemplates: loading("GET /api/article-templates", null),
    trendCandidates: loading("GET /api/trends/topic-candidates", []),
    evidenceSources: loading("GET /api/evidence-sources", []),
    facts: loading("GET /api/facts", []),
    campaigns: loading("GET /api/campaigns", []),
    content: loading("GET /api/content", []),
    audits: loading("GET /api/audits", []),
    publicationJobs: loading("GET /api/publication-jobs", []),
    publicationAssistedHandoffs: loading("GET /api/publication-assisted-handoffs", []),
    receipts: loading("GET /api/receipts", []),
    visibility: loading("GET /api/visibility/summary", []),
    automation: loading("GET /api/automation", null),
    ctripBridge: loading("GET /api/ctrip-bridge/status", null),
    servicePrincipals: loading("GET /api/service-principals", []),
    loadedAt: null,
  };
}

function failure(error: unknown): ResourceError {
  if (error instanceof GeoApiError) {
    return {
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      status: error.status,
    };
  }
  return {
    code: "UNEXPECTED_CLIENT_ERROR",
    message: error instanceof Error ? error.message : "未知客户端错误",
    requestId: null,
    status: 0,
  };
}

function settled<T>(endpoint: string, result: PromiseSettledResult<T>, empty: T): ApiResource<T> {
  return result.status === "fulfilled"
    ? { endpoint, data: result.value, error: null, status: "ready" }
    : { endpoint, data: empty, error: failure(result.reason), status: "error" };
}

export async function loadChannelAccountsResource(
  api: GeoApi,
): Promise<ApiResource<readonly ChannelAccount[]>> {
  try {
    return {
      endpoint: "GET /api/channel-accounts",
      data: await api.getChannelAccounts(),
      error: null,
      status: "ready",
    };
  } catch (error) {
    return {
      endpoint: "GET /api/channel-accounts",
      data: [],
      error: failure(error),
      status: "error",
    };
  }
}

export async function loadCtripAccountAnalyticsResource(
  api: GeoApi,
): Promise<ApiResource<CtripPlatformAnalyticsDashboard | null>> {
  const endpoint = "GET /api/channel-accounts/ctrip-analytics";
  try {
    return {
      endpoint,
      data: (await api.getCtripAccountAnalytics?.()) ?? null,
      error: null,
      status: "ready",
    };
  } catch (error) {
    return { endpoint, data: null, error: failure(error), status: "error" };
  }
}

export async function loadPriorityPlatformAnalyticsResource(
  api: GeoApi,
): Promise<ApiResource<PriorityPlatformAnalyticsDashboard | null>> {
  const endpoint = "GET /api/channel-accounts/priority-platform-analytics";
  try {
    return {
      endpoint,
      data: (await api.getPriorityPlatformAccountAnalytics?.()) ?? null,
      error: null,
      status: "ready",
    };
  } catch (error) {
    return { endpoint, data: null, error: failure(error), status: "error" };
  }
}

export async function loadContentResource(
  api: GeoApi,
): Promise<ApiResource<readonly ContentItem[]>> {
  try {
    return {
      endpoint: "GET /api/content",
      data: await api.getContent(),
      error: null,
      status: "ready",
    };
  } catch (error) {
    return {
      endpoint: "GET /api/content",
      data: [],
      error: failure(error),
      status: "error",
    };
  }
}

export async function loadLiveOperationsResources(
  api: GeoApi,
  enabledModules: readonly string[],
): Promise<LiveOperationsResources> {
  const enabled = (module: string) => enabledModules.includes(module);
  const results = await Promise.allSettled([
    enabled("trend_discovery")
      ? (api.getTrendCandidates?.({ limit: 12, lookbackMinutes: 1_440 }) ?? Promise.resolve([]))
      : Promise.resolve([]),
    enabled("ai_content") ? api.getContent() : Promise.resolve([]),
    enabled("priority_distribution") ? api.getPublicationJobs() : Promise.resolve([]),
    enabled("priority_distribution") ? api.getReceipts() : Promise.resolve([]),
  ] as const);
  return {
    trendCandidates: settled("GET /api/trends/topic-candidates", results[0], []),
    content: settled("GET /api/content", results[1], []),
    publicationJobs: settled("GET /api/publication-jobs", results[2], []),
    receipts: settled("GET /api/receipts", results[3], []),
    loadedAt: new Date().toISOString(),
  };
}

export async function loadLiveDashboard(
  api: GeoApi,
  capabilities: readonly string[],
  enabledModules: readonly string[],
): Promise<LiveDashboard> {
  const can = (capability: string) => capabilities.includes(capability);
  const enabled = (module: string) => enabledModules.includes(module);
  const results = await Promise.allSettled([
    api.getTenant(),
    api.getTenants(),
    api.getContacts(),
    enabled("priority_distribution") ? api.getChannelAccounts() : Promise.resolve([]),
    enabled("priority_distribution")
      ? (api.getCtripAccountAnalytics?.() ?? Promise.resolve(null))
      : Promise.resolve(null),
    api.getBrands(),
    can("member:manage") ? api.getMembers() : Promise.resolve([]),
    api.getPolicies(),
    can("visibility:read") ? api.getQuerySets() : Promise.resolve([]),
    enabled("ai_content") ? api.getEvidenceSources() : Promise.resolve([]),
    enabled("ai_content") ? api.getFacts() : Promise.resolve([]),
    enabled("ai_content") ? api.getCampaigns() : Promise.resolve([]),
    enabled("ai_content") ? api.getContent() : Promise.resolve([]),
    api.getAudits(),
    enabled("priority_distribution") ? api.getPublicationJobs() : Promise.resolve([]),
    enabled("priority_distribution") ? api.getReceipts() : Promise.resolve([]),
    can("visibility:read") ? api.getVisibilitySummary() : Promise.resolve([]),
    enabled("agent_automation") ? api.getAutomation() : Promise.resolve(null),
    enabled("priority_distribution") ? api.getCtripBridgeStatus() : Promise.resolve(null),
    can("principal:manage") && (enabled("priority_distribution") || enabled("agent_automation"))
      ? api.getServicePrincipals()
      : Promise.resolve([]),
    enabled("ai_content") ? api.getArticleTemplates() : Promise.resolve(null),
    enabled("ai_content") ? api.getBrandAgentProfiles() : Promise.resolve([]),
    enabled("priority_distribution") ? api.getPublicationAssistedHandoffs() : Promise.resolve([]),
    enabled("trend_discovery")
      ? (api.getTrendCandidates?.({ limit: 12, lookbackMinutes: 1_440 }) ?? Promise.resolve([]))
      : Promise.resolve([]),
    enabled("priority_distribution")
      ? (api.getPriorityPlatformAccountAnalytics?.() ?? Promise.resolve(null))
      : Promise.resolve(null),
  ] as const);

  return {
    tenant: settled("GET /api/tenant", results[0], null),
    tenants: settled("GET /api/auth/tenants", results[1], []),
    contacts: settled("GET /api/contacts", results[2], []),
    channelAccounts: settled("GET /api/channel-accounts", results[3], []),
    ctripAccountAnalytics: settled("GET /api/channel-accounts/ctrip-analytics", results[4], null),
    brands: settled("GET /api/brands", results[5], []),
    members: settled("GET /api/members", results[6], []),
    policies: settled("GET /api/policies", results[7], []),
    querySets: settled("GET /api/query-sets", results[8], []),
    evidenceSources: settled("GET /api/evidence-sources", results[9], []),
    facts: settled("GET /api/facts", results[10], []),
    campaigns: settled("GET /api/campaigns", results[11], []),
    content: settled("GET /api/content", results[12], []),
    audits: settled("GET /api/audits", results[13], []),
    publicationJobs: settled("GET /api/publication-jobs", results[14], []),
    receipts: settled("GET /api/receipts", results[15], []),
    visibility: settled("GET /api/visibility/summary", results[16], []),
    automation: settled("GET /api/automation", results[17], null),
    ctripBridge: settled("GET /api/ctrip-bridge/status", results[18], null),
    servicePrincipals: settled("GET /api/service-principals", results[19], []),
    articleTemplates: settled("GET /api/article-templates", results[20], null),
    brandAgentProfiles: settled("GET /api/brand-agent-profiles", results[21], []),
    publicationAssistedHandoffs: settled("GET /api/publication-assisted-handoffs", results[22], []),
    trendCandidates: settled("GET /api/trends/topic-candidates", results[23], []),
    priorityPlatformAnalytics: settled(
      "GET /api/channel-accounts/priority-platform-analytics",
      results[24],
      null,
    ),
    loadedAt: new Date().toISOString(),
  };
}

export function dashboardHasAuthenticationError(dashboard: LiveDashboard): boolean {
  return Object.values(dashboard).some(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      (value as ApiResource<unknown>).error?.status === 401,
  );
}

export function resourceErrorText(error: ResourceError): string {
  const request = error.requestId === null ? "" : ` · request ${error.requestId}`;
  return `${error.code}: ${error.message}${request}`;
}
