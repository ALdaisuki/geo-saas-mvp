export interface TenantOption {
  readonly id?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly role?: string;
  readonly status?: "active" | "unavailable";
}

export interface SessionActor {
  readonly id: string;
  readonly displayName: string | null;
  readonly role: string;
  readonly capabilities: readonly string[];
}

export interface SessionTenant {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
}

export interface SessionSnapshot {
  readonly actor: SessionActor;
  readonly tenant: SessionTenant;
  readonly expiresAt: string;
}

export interface TenantView {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly industry: string;
  readonly status: string;
  readonly defaultLocale: string;
}

export interface TenantContact {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly label: string;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface ChannelAccount {
  readonly id: string;
  readonly platform: string;
  readonly displayName: string;
  readonly capability: string;
  readonly supportedExecutionLevels: readonly string[];
  readonly evidenceType: string;
  readonly evidenceRefs: readonly string[];
  readonly status: string;
  readonly lastVerifiedAt: string | null;
}

export interface Campaign {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly status: string;
  readonly topicKey: string;
}

export interface CreateCampaignInput {
  readonly brandId: string;
  readonly name: string;
  readonly objective: string;
  readonly industry: string;
  readonly topicKey: string;
}

export interface ContentItem {
  readonly id: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly title: string;
  readonly contentType: string;
  readonly state: string;
  readonly topicKey: string;
  readonly latestVersion: number | null;
  readonly latestVersionId: string | null;
}

export interface PublicationVariant {
  readonly id: string;
  readonly contentVersionId: string;
  readonly channelAccountId: string;
  readonly platform: string;
  readonly variantVersion: number;
  readonly state: string;
  readonly frozenAt: string | null;
}

export interface PublicationJob {
  readonly id: string;
  readonly variantId: string;
  readonly platform: string;
  readonly executionLevel: string;
  readonly state: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationReceipt {
  readonly id: string;
  readonly jobId: string;
  readonly platform: string;
  readonly executionLevel: string;
  readonly evidenceType: string;
  readonly externalUrl: string | null;
  readonly confirmed: boolean;
  readonly recordedAt: string;
}

export interface VisibilityProviderSummary {
  readonly provider: "doubao" | "qwen";
  readonly productSurface: string;
  readonly model: string;
  readonly searchMode: string;
  readonly observationMethod: string;
  readonly evidenceType: string;
  readonly observations: number;
  readonly brandMentionRate: number;
  readonly contactAccuracy: number;
  readonly harmfulErrors: number;
}

export interface AutomationControl {
  readonly mode: string;
  readonly killSwitchEnabled: boolean;
  readonly reason: string | null;
  readonly quota: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface AutomationCircuit {
  readonly scopeType: string;
  readonly scopeKey: string;
  readonly state: string;
  readonly failureCount: number;
  readonly openedAt: string | null;
  readonly retryAt: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface AutomationSnapshot {
  readonly control: AutomationControl;
  readonly circuits: readonly AutomationCircuit[];
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly tenantSlug?: string;
}

export interface ApiErrorDetails {
  readonly tenants?: readonly TenantOption[];
  readonly [key: string]: unknown;
}

export class GeoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details: ApiErrorDetails | null = null,
  ) {
    super(message);
    this.name = "GeoApiError";
  }
}

export interface GeoApi {
  getSession(): Promise<SessionSnapshot>;
  login(input: LoginInput): Promise<SessionSnapshot>;
  logout(): Promise<void>;
  getTenants(): Promise<readonly TenantOption[]>;
  switchTenant(tenantSlug: string): Promise<SessionSnapshot>;
  getTenant(): Promise<TenantView>;
  getContacts(): Promise<readonly TenantContact[]>;
  getChannelAccounts(): Promise<readonly ChannelAccount[]>;
  getCampaigns(): Promise<readonly Campaign[]>;
  createCampaign(input: CreateCampaignInput): Promise<Campaign>;
  getContent(): Promise<readonly ContentItem[]>;
  getContentVariants(contentId: string): Promise<readonly PublicationVariant[]>;
  getPublicationJobs(): Promise<readonly PublicationJob[]>;
  getReceipts(): Promise<readonly PublicationReceipt[]>;
  getVisibilitySummary(): Promise<readonly VisibilityProviderSummary[]>;
  getAutomation(): Promise<AutomationSnapshot>;
  setKillSwitch(input: {
    readonly enabled: boolean;
    readonly reason: string;
  }): Promise<AutomationControl>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  return value;
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw protocolError(`${key} must be a string`);
  return value;
}

function nullableStringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw protocolError(`${key} must be a string or null`);
  return value;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> {
  return recordValue(record[key], key);
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(`${key} must be a finite number`);
  }
  return value;
}

function nullableNumberValue(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(`${key} must be a finite number or null`);
  }
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw protocolError(`${key} must be a boolean`);
  return value;
}

function stringArrayValue(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw protocolError(`${key} must be a string array`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function protocolError(message: string): GeoApiError {
  return new GeoApiError(0, "INVALID_API_RESPONSE", `API response mismatch: ${message}`);
}

function itemsValue<T>(payload: unknown, parser: (item: unknown) => T): readonly T[] {
  const body = recordValue(payload, "response");
  const items = body.items;
  if (!Array.isArray(items)) throw protocolError("items must be an array");
  return items.map(parser);
}

function parseTenantOption(value: unknown): TenantOption {
  const item = recordValue(value, "tenant option");
  const status = optionalString(item, "status");
  if (status !== null && status !== "active" && status !== "unavailable") {
    throw protocolError(`unsupported tenant membership status: ${status}`);
  }
  return {
    slug: stringValue(item, "slug"),
    displayName: stringValue(item, "displayName"),
    ...(optionalString(item, "id") === null ? {} : { id: optionalString(item, "id") as string }),
    ...(optionalString(item, "role") === null
      ? {}
      : { role: optionalString(item, "role") as string }),
    ...(status === null ? {} : { status }),
  };
}

function parseSession(value: unknown): SessionSnapshot {
  const body = recordValue(value, "session response");
  const actor = recordValue(body.actor, "actor");
  const tenant = recordValue(body.tenant, "tenant");
  const session = isRecord(body.session) ? body.session : body;
  const actorId = optionalString(actor, "id") ?? optionalString(actor, "actorId");
  if (actorId === null) throw protocolError("actor id is missing");
  return {
    actor: {
      id: actorId,
      displayName: optionalString(actor, "displayName"),
      role: stringValue(actor, "role"),
      capabilities: stringArrayValue(actor, "capabilities"),
    },
    tenant: {
      id: stringValue(tenant, "id"),
      slug: stringValue(tenant, "slug"),
      displayName: stringValue(tenant, "displayName"),
    },
    expiresAt: stringValue(session, "expiresAt"),
  };
}

function parseTenant(value: unknown): TenantView {
  const item = recordValue(value, "tenant");
  return {
    id: stringValue(item, "id"),
    slug: stringValue(item, "slug"),
    displayName: stringValue(item, "displayName"),
    legalName: stringValue(item, "legalName"),
    industry: stringValue(item, "industry"),
    status: stringValue(item, "status"),
    defaultLocale: stringValue(item, "defaultLocale"),
  };
}

function parseContact(value: unknown): TenantContact {
  const item = recordValue(value, "contact");
  return {
    id: stringValue(item, "id"),
    tenantId: stringValue(item, "tenantId"),
    type: stringValue(item, "type"),
    label: stringValue(item, "label"),
    value: stringValue(item, "value"),
    isPrimary: booleanValue(item, "isPrimary"),
    validFrom: stringValue(item, "validFrom"),
    validUntil: nullableStringValue(item, "validUntil"),
  };
}

function parseChannelAccount(value: unknown): ChannelAccount {
  const item = recordValue(value, "channel account");
  return {
    id: stringValue(item, "id"),
    platform: stringValue(item, "platform"),
    displayName: stringValue(item, "displayName"),
    capability: stringValue(item, "capability"),
    supportedExecutionLevels: stringArrayValue(item, "supportedExecutionLevels"),
    evidenceType: stringValue(item, "evidenceType"),
    evidenceRefs: stringArrayValue(item, "evidenceRefs"),
    status: stringValue(item, "status"),
    lastVerifiedAt: nullableStringValue(item, "lastVerifiedAt"),
  };
}

function parseCampaign(value: unknown): Campaign {
  const item = recordValue(value, "campaign");
  return {
    id: stringValue(item, "id"),
    brandId: stringValue(item, "brandId"),
    name: stringValue(item, "name"),
    objective: stringValue(item, "objective"),
    industry: stringValue(item, "industry"),
    status: stringValue(item, "status"),
    topicKey: stringValue(item, "topicKey"),
  };
}

function parseContent(value: unknown): ContentItem {
  const item = recordValue(value, "content item");
  return {
    id: stringValue(item, "id"),
    campaignId: stringValue(item, "campaignId"),
    brandId: stringValue(item, "brandId"),
    title: stringValue(item, "title"),
    contentType: stringValue(item, "contentType"),
    state: stringValue(item, "state"),
    topicKey: stringValue(item, "topicKey"),
    latestVersion: nullableNumberValue(item, "latestVersion"),
    latestVersionId: nullableStringValue(item, "latestVersionId"),
  };
}

function parseVariant(value: unknown): PublicationVariant {
  const item = recordValue(value, "publication variant");
  return {
    id: stringValue(item, "id"),
    contentVersionId: stringValue(item, "contentVersionId"),
    channelAccountId: stringValue(item, "channelAccountId"),
    platform: stringValue(item, "platform"),
    variantVersion: numberValue(item, "variantVersion"),
    state: stringValue(item, "state"),
    frozenAt: nullableStringValue(item, "frozenAt"),
  };
}

function parsePublicationJob(value: unknown): PublicationJob {
  const item = recordValue(value, "publication job");
  return {
    id: stringValue(item, "id"),
    variantId: stringValue(item, "variantId"),
    platform: stringValue(item, "platform"),
    executionLevel: stringValue(item, "executionLevel"),
    state: stringValue(item, "state"),
    payloadHash: stringValue(item, "payloadHash"),
    createdAt: stringValue(item, "createdAt"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseReceipt(value: unknown): PublicationReceipt {
  const item = recordValue(value, "publication receipt");
  return {
    id: stringValue(item, "id"),
    jobId: stringValue(item, "jobId"),
    platform: stringValue(item, "platform"),
    executionLevel: stringValue(item, "executionLevel"),
    evidenceType: stringValue(item, "evidenceType"),
    externalUrl: nullableStringValue(item, "externalUrl"),
    confirmed: booleanValue(item, "confirmed"),
    recordedAt: stringValue(item, "recordedAt"),
  };
}

function parseVisibilitySummary(value: unknown): VisibilityProviderSummary {
  const item = recordValue(value, "visibility summary");
  const provider = stringValue(item, "provider");
  if (provider !== "doubao" && provider !== "qwen") {
    throw protocolError(`unsupported visibility provider: ${provider}`);
  }
  return {
    provider,
    productSurface: stringValue(item, "productSurface"),
    model: stringValue(item, "model"),
    searchMode: stringValue(item, "searchMode"),
    observationMethod: stringValue(item, "observationMethod"),
    evidenceType: stringValue(item, "evidenceType"),
    observations: numberValue(item, "observations"),
    brandMentionRate: numberValue(item, "brandMentionRate"),
    contactAccuracy: numberValue(item, "contactAccuracy"),
    harmfulErrors: numberValue(item, "harmfulErrors"),
  };
}

function parseAutomationControl(value: unknown): AutomationControl {
  const item = recordValue(value, "automation control");
  return {
    mode: stringValue(item, "mode"),
    killSwitchEnabled: booleanValue(item, "killSwitchEnabled"),
    reason: nullableStringValue(item, "reason"),
    quota: recordField(item, "quota"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationCircuit(value: unknown): AutomationCircuit {
  const item = recordValue(value, "automation circuit");
  return {
    scopeType: stringValue(item, "scopeType"),
    scopeKey: stringValue(item, "scopeKey"),
    state: stringValue(item, "state"),
    failureCount: numberValue(item, "failureCount"),
    openedAt: nullableStringValue(item, "openedAt"),
    retryAt: nullableStringValue(item, "retryAt"),
    reason: nullableStringValue(item, "reason"),
    updatedAt: stringValue(item, "updatedAt"),
  };
}

function parseAutomationSnapshot(value: unknown): AutomationSnapshot {
  const body = recordValue(value, "automation response");
  if (!Array.isArray(body.circuits)) throw protocolError("circuits must be an array");
  return {
    control: parseAutomationControl(body.control),
    circuits: body.circuits.map(parseAutomationCircuit),
  };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

function tenantOptionsFromDetails(details: unknown): readonly TenantOption[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.tenants)) return undefined;
  try {
    return details.tenants.map(parseTenantOption);
  } catch {
    return undefined;
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof GeoApiError &&
    (error.status === 401 ||
      error.code === "AUTHENTICATION_REQUIRED" ||
      error.code === "SESSION_INVALID")
  );
}

export class HttpGeoApi implements GeoApi {
  private csrfToken: string | null = null;
  private readonly baseUrl: string;

  constructor(
    baseUrl = "",
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}, csrf = false): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (csrf) {
      const token = this.csrfToken ?? readCookie("geo_csrf");
      if (token === null) {
        throw new GeoApiError(0, "CSRF_TOKEN_MISSING", "当前会话缺少 CSRF 令牌，请重新登录");
      }
      headers.set("x-csrf-token", token);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: "include",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed";
      throw new GeoApiError(0, "NETWORK_ERROR", `无法连接 GEO API：${message}`);
    }

    let payload: unknown = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text.length > 0) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          if (!response.ok) {
            throw new GeoApiError(
              response.status,
              `HTTP_${response.status}`,
              `GEO API 返回 ${response.status}，但没有结构化错误信息`,
            );
          }
          throw new GeoApiError(response.status, "INVALID_API_RESPONSE", "API 返回了非 JSON 响应");
        }
      }
    }

    if (!response.ok) {
      const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      const code = envelope === null ? `HTTP_${response.status}` : optionalString(envelope, "code");
      const message = envelope === null ? response.statusText : optionalString(envelope, "message");
      const requestId = envelope === null ? null : optionalString(envelope, "requestId");
      const details = envelope?.details;
      const parsedTenants = tenantOptionsFromDetails(details);
      throw new GeoApiError(
        response.status,
        code ?? `HTTP_${response.status}`,
        message ?? `API request failed with status ${response.status}`,
        requestId,
        isRecord(details)
          ? { ...details, ...(parsedTenants === undefined ? {} : { tenants: parsedTenants }) }
          : null,
      );
    }
    return payload;
  }

  async getSession(): Promise<SessionSnapshot> {
    return parseSession(await this.request("/api/auth/session"));
  }

  async login(input: LoginInput): Promise<SessionSnapshot> {
    const payload = await this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        ...(input.tenantSlug === undefined ? {} : { tenantSlug: input.tenantSlug }),
      }),
    });
    const body = recordValue(payload, "login response");
    this.csrfToken = stringValue(body, "csrfToken");
    return parseSession(payload);
  }

  async logout(): Promise<void> {
    await this.request("/api/auth/logout", { method: "POST" }, true);
    this.csrfToken = null;
  }

  async getTenants(): Promise<readonly TenantOption[]> {
    return itemsValue(await this.request("/api/auth/tenants"), parseTenantOption);
  }

  async switchTenant(tenantSlug: string): Promise<SessionSnapshot> {
    const payload = await this.request(
      "/api/auth/switch-tenant",
      { method: "POST", body: JSON.stringify({ tenantSlug }) },
      true,
    );
    const body = recordValue(payload, "tenant switch response");
    this.csrfToken = optionalString(body, "csrfToken") ?? readCookie("geo_csrf");
    return parseSession(payload);
  }

  async getTenant(): Promise<TenantView> {
    return parseTenant(await this.request("/api/tenant"));
  }

  async getContacts(): Promise<readonly TenantContact[]> {
    return itemsValue(await this.request("/api/contacts"), parseContact);
  }

  async getChannelAccounts(): Promise<readonly ChannelAccount[]> {
    return itemsValue(await this.request("/api/channel-accounts"), parseChannelAccount);
  }

  async getCampaigns(): Promise<readonly Campaign[]> {
    return itemsValue(await this.request("/api/campaigns"), parseCampaign);
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    return parseCampaign(
      await this.request("/api/campaigns", { method: "POST", body: JSON.stringify(input) }, true),
    );
  }

  async getContent(): Promise<readonly ContentItem[]> {
    return itemsValue(await this.request("/api/content"), parseContent);
  }

  async getContentVariants(contentId: string): Promise<readonly PublicationVariant[]> {
    return itemsValue(
      await this.request(`/api/content/${encodeURIComponent(contentId)}/variants`),
      parseVariant,
    );
  }

  async getPublicationJobs(): Promise<readonly PublicationJob[]> {
    return itemsValue(await this.request("/api/publication-jobs"), parsePublicationJob);
  }

  async getReceipts(): Promise<readonly PublicationReceipt[]> {
    return itemsValue(await this.request("/api/receipts"), parseReceipt);
  }

  async getVisibilitySummary(): Promise<readonly VisibilityProviderSummary[]> {
    return itemsValue(await this.request("/api/visibility/summary"), parseVisibilitySummary);
  }

  async getAutomation(): Promise<AutomationSnapshot> {
    return parseAutomationSnapshot(await this.request("/api/automation"));
  }

  async setKillSwitch(input: {
    readonly enabled: boolean;
    readonly reason: string;
  }): Promise<AutomationControl> {
    const payload = recordValue(
      await this.request(
        "/api/automation/kill-switch",
        { method: "POST", body: JSON.stringify(input) },
        true,
      ),
      "kill switch response",
    );
    return parseAutomationControl(payload.control);
  }
}

export function createGeoApi(): GeoApi {
  return new HttpGeoApi(import.meta.env.VITE_API_BASE_URL ?? "");
}
