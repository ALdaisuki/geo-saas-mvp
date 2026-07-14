import {
  GeoApiError,
  type AutomationSnapshot,
  type Campaign,
  type ChannelAccount,
  type ContentItem,
  type GeoApi,
  type PublicationJob,
  type PublicationReceipt,
  type TenantContact,
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
  readonly campaigns: ApiResource<readonly Campaign[]>;
  readonly content: ApiResource<readonly ContentItem[]>;
  readonly publicationJobs: ApiResource<readonly PublicationJob[]>;
  readonly receipts: ApiResource<readonly PublicationReceipt[]>;
  readonly visibility: ApiResource<readonly VisibilityProviderSummary[]>;
  readonly automation: ApiResource<AutomationSnapshot | null>;
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
    campaigns: loading("GET /api/campaigns", []),
    content: loading("GET /api/content", []),
    publicationJobs: loading("GET /api/publication-jobs", []),
    receipts: loading("GET /api/receipts", []),
    visibility: loading("GET /api/visibility/summary", []),
    automation: loading("GET /api/automation", null),
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
    api.getCampaigns(),
    api.getContent(),
    api.getPublicationJobs(),
    api.getReceipts(),
    api.getVisibilitySummary(),
    api.getAutomation(),
  ] as const);

  return {
    tenant: settled("GET /api/tenant", results[0], null),
    tenants: settled("GET /api/auth/tenants", results[1], []),
    contacts: settled("GET /api/contacts", results[2], []),
    channelAccounts: settled("GET /api/channel-accounts", results[3], []),
    campaigns: settled("GET /api/campaigns", results[4], []),
    content: settled("GET /api/content", results[5], []),
    publicationJobs: settled("GET /api/publication-jobs", results[6], []),
    receipts: settled("GET /api/receipts", results[7], []),
    visibility: settled("GET /api/visibility/summary", results[8], []),
    automation: settled("GET /api/automation", results[9], null),
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
