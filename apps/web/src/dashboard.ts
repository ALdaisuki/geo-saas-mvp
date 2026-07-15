import {
  GeoApiError,
  type AutomationSnapshot,
  type AuditArtifact,
  type Brand,
  type Campaign,
  type ChannelAccount,
  type ClaimFact,
  type ContentItem,
  type EvidenceSource,
  type GeoApi,
  type PublicationJob,
  type PublicationReceipt,
  type PolicyBundle,
  type QuerySet,
  type ServicePrincipal,
  type TenantContact,
  type TenantMember,
  type TenantOption,
  type TenantView,
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
  readonly brands: ApiResource<readonly Brand[]>;
  readonly members: ApiResource<readonly TenantMember[]>;
  readonly policies: ApiResource<readonly PolicyBundle[]>;
  readonly querySets: ApiResource<readonly QuerySet[]>;
  readonly evidenceSources: ApiResource<readonly EvidenceSource[]>;
  readonly facts: ApiResource<readonly ClaimFact[]>;
  readonly campaigns: ApiResource<readonly Campaign[]>;
  readonly content: ApiResource<readonly ContentItem[]>;
  readonly audits: ApiResource<readonly AuditArtifact[]>;
  readonly publicationJobs: ApiResource<readonly PublicationJob[]>;
  readonly receipts: ApiResource<readonly PublicationReceipt[]>;
  readonly visibility: ApiResource<readonly VisibilityProviderSummary[]>;
  readonly automation: ApiResource<AutomationSnapshot | null>;
  readonly servicePrincipals: ApiResource<readonly ServicePrincipal[]>;
  readonly loadedAt: string | null;
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
    brands: loading("GET /api/brands", []),
    members: loading("GET /api/members", []),
    policies: loading("GET /api/policies", []),
    querySets: loading("GET /api/query-sets", []),
    evidenceSources: loading("GET /api/evidence-sources", []),
    facts: loading("GET /api/facts", []),
    campaigns: loading("GET /api/campaigns", []),
    content: loading("GET /api/content", []),
    audits: loading("GET /api/audits", []),
    publicationJobs: loading("GET /api/publication-jobs", []),
    receipts: loading("GET /api/receipts", []),
    visibility: loading("GET /api/visibility/summary", []),
    automation: loading("GET /api/automation", null),
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

export async function loadLiveDashboard(api: GeoApi): Promise<LiveDashboard> {
  const results = await Promise.allSettled([
    api.getTenant(),
    api.getTenants(),
    api.getContacts(),
    api.getChannelAccounts(),
    api.getBrands(),
    api.getMembers(),
    api.getPolicies(),
    api.getQuerySets(),
    api.getEvidenceSources(),
    api.getFacts(),
    api.getCampaigns(),
    api.getContent(),
    api.getAudits(),
    api.getPublicationJobs(),
    api.getReceipts(),
    api.getVisibilitySummary(),
    api.getAutomation(),
    api.getServicePrincipals(),
  ] as const);

  return {
    tenant: settled("GET /api/tenant", results[0], null),
    tenants: settled("GET /api/auth/tenants", results[1], []),
    contacts: settled("GET /api/contacts", results[2], []),
    channelAccounts: settled("GET /api/channel-accounts", results[3], []),
    brands: settled("GET /api/brands", results[4], []),
    members: settled("GET /api/members", results[5], []),
    policies: settled("GET /api/policies", results[6], []),
    querySets: settled("GET /api/query-sets", results[7], []),
    evidenceSources: settled("GET /api/evidence-sources", results[8], []),
    facts: settled("GET /api/facts", results[9], []),
    campaigns: settled("GET /api/campaigns", results[10], []),
    content: settled("GET /api/content", results[11], []),
    audits: settled("GET /api/audits", results[12], []),
    publicationJobs: settled("GET /api/publication-jobs", results[13], []),
    receipts: settled("GET /api/receipts", results[14], []),
    visibility: settled("GET /api/visibility/summary", results[15], []),
    automation: settled("GET /api/automation", results[16], null),
    servicePrincipals: settled("GET /api/service-principals", results[17], []),
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
