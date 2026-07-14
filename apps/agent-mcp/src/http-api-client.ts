import { createHash, timingSafeEqual } from "node:crypto";

import {
  actorContextSchema,
  capabilitySchema,
  idSchema,
  publicationVariantPayloadSchema,
  tenantRoleSchema,
  type ActorContext,
} from "@geo/contracts";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";

import type {
  AuditRequestInput,
  DraftProposalInput,
  InternalGeoApiClient,
  PublicationRequestInput,
  TenantFactLookupInput,
  VariantPreviewInput,
  VisibilityRequestInput,
} from "./api-client.js";

const SESSION_COOKIE = "geo_session";
const CSRF_COOKIE = "geo_csrf";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const credentialSchema = z
  .object({
    accessToken: z.string().min(32).max(4_096),
    clientId: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    password: z.string().min(8).max(1_024),
    tenantSlug: z.string().trim().min(2).max(63).optional(),
  })
  .strict();

const credentialListSchema = z.array(credentialSchema).min(1).max(100);
export type McpPrincipalCredential = z.infer<typeof credentialSchema>;

const loginResponseSchema = z.object({
  actor: z.object({
    id: idSchema,
    role: tenantRoleSchema,
    capabilities: z.array(capabilitySchema),
  }),
  tenant: z.object({ id: idSchema, slug: z.string(), displayName: z.string() }),
  csrfToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

const factSchema = z.object({
  id: idSchema,
  brandId: idSchema,
  claim: z.string(),
  status: z.enum(["draft", "verified", "rejected", "expired"]),
  evidenceSourceIds: z.array(idSchema),
  validUntil: z.string().datetime({ offset: true }).nullable(),
});

const contactSchema = z.object({
  id: idSchema,
  type: z.enum(["phone", "wechat", "email", "website", "address"]),
  label: z.string(),
  value: z.string(),
});

const contentVersionSchema = z.object({
  id: idSchema,
  contentItemId: idSchema,
  payload: publicationVariantPayloadSchema,
});

const accountSchema = z.object({
  id: idSchema,
  platform: z.enum(["toutiao", "sohu", "ctrip_community"]),
  supportedExecutionLevels: z.array(z.enum(["dry_run", "assisted", "unattended"])),
  status: z.string(),
});

const publicationAuthorizationSchema = z.object({
  grantId: idSchema,
  token: z.string().min(32),
  expiresAt: z.string().datetime({ offset: true }),
});

interface ApiSession {
  readonly credentialHash: string;
  readonly cookie: string;
  readonly csrfToken: string;
  readonly principal: Readonly<ActorContext>;
  readonly expiresAtMs: number;
}

interface PendingGrant {
  readonly grantId: string;
  readonly token: string;
  readonly channelAccountId: string;
  readonly expiresAtMs: number;
}

type FetchLike = typeof fetch;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftHash = Buffer.from(sha256(left), "hex");
  const rightHash = Buffer.from(sha256(right), "hex");
  return timingSafeEqual(leftHash, rightHash);
}

function principalKey(principal: Pick<ActorContext, "tenantId" | "actorId">): string {
  return `${principal.tenantId}:${principal.actorId}`;
}

function grantKey(principal: Readonly<ActorContext>, variantId: string): string {
  return `${principalKey(principal)}:${variantId}`;
}

function cookiePair(setCookies: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const value = setCookies.find((cookie) => cookie.startsWith(prefix));
  if (value === undefined) throw new Error("GEO API did not return the required session cookies");
  return value.split(";", 1)[0] as string;
}

function setCookieValues(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] };
  const values = enhanced.getSetCookie?.();
  if (values !== undefined && values.length > 0) return values;
  const combined = headers.get("set-cookie");
  return combined === null ? [] : combined.split(/,(?=\s*[^;,]+=)/u).map((value) => value.trim());
}

export function parseMcpPrincipalCredentials(value: string): readonly McpPrincipalCredential[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("MCP_PRINCIPALS_JSON must be valid JSON");
  }
  const credentials = credentialListSchema.parse(parsed);
  const tokenHashes = new Set<string>();
  const clientIds = new Set<string>();
  for (const credential of credentials) {
    const tokenHash = sha256(credential.accessToken);
    if (tokenHashes.has(tokenHash) || clientIds.has(credential.clientId)) {
      throw new TypeError("MCP principal access tokens and client IDs must be unique");
    }
    tokenHashes.add(tokenHash);
    clientIds.add(credential.clientId);
  }
  return credentials;
}

export function validateGeoApiBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    throw new TypeError("GEO API base URL cannot contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new TypeError("GEO API requires HTTPS except on loopback");
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url;
}

export class GeoApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`GEO API request failed: ${code}`);
    this.name = "GeoApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export class GeoApiSessionRegistry {
  readonly #baseUrl: URL;
  readonly #credentials: readonly McpPrincipalCredential[];
  readonly #fetch: FetchLike;
  readonly #sessionsByCredential = new Map<string, ApiSession>();
  readonly #credentialByPrincipal = new Map<string, McpPrincipalCredential>();

  constructor(options: {
    baseUrl: string;
    credentials: readonly McpPrincipalCredential[];
    fetchImpl?: FetchLike;
  }) {
    this.#baseUrl = validateGeoApiBaseUrl(options.baseUrl);
    this.#credentials = credentialListSchema.parse(options.credentials);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get baseUrl(): URL {
    return new URL(this.#baseUrl);
  }

  async authenticateBearer(
    authorizationHeader: string | undefined,
    requestId: string,
  ): Promise<{ authInfo: AuthInfo; principal: Readonly<ActorContext> }> {
    const matched = /^Bearer\s+(.+)$/iu.exec(authorizationHeader ?? "");
    if (matched === null) throw new GeoApiRequestError("MCP_AUTHENTICATION_REQUIRED", 401);
    const token = matched[1] as string;
    const credential = this.#credentials.find((candidate) =>
      safeTokenEqual(candidate.accessToken, token),
    );
    if (credential === undefined) throw new GeoApiRequestError("MCP_TOKEN_INVALID", 401);
    const session = await this.#sessionForCredential(credential);
    const principal = actorContextSchema.parse({ ...session.principal, requestId });
    return {
      principal,
      authInfo: {
        token,
        clientId: credential.clientId,
        scopes: [...principal.capabilities],
        expiresAt: Math.floor(session.expiresAtMs / 1_000),
        extra: { principal },
      },
    };
  }

  resolvePrincipal(authInfo: Readonly<AuthInfo>, requestId: string): Readonly<ActorContext> {
    const value = authInfo.extra?.principal;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new GeoApiRequestError("MCP_PRINCIPAL_MISSING", 401);
    }
    return actorContextSchema.parse({ ...value, requestId });
  }

  async sessionForPrincipal(principal: Readonly<ActorContext>): Promise<ApiSession> {
    const credential = this.#credentialByPrincipal.get(principalKey(principal));
    if (credential === undefined)
      throw new GeoApiRequestError("MCP_PRINCIPAL_SESSION_MISSING", 401);
    const session = await this.#sessionForCredential(credential);
    if (
      session.principal.actorId !== principal.actorId ||
      session.principal.tenantId !== principal.tenantId
    ) {
      throw new GeoApiRequestError("MCP_PRINCIPAL_SESSION_MISMATCH", 403);
    }
    return session;
  }

  async #sessionForCredential(credential: McpPrincipalCredential): Promise<ApiSession> {
    const credentialHash = sha256(credential.accessToken);
    const existing = this.#sessionsByCredential.get(credentialHash);
    if (existing !== undefined && existing.expiresAtMs > Date.now() + 60_000) return existing;
    const response = await this.#fetch(new URL("api/auth/login", this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email: credential.email,
        password: credential.password,
        ...(credential.tenantSlug === undefined ? {} : { tenantSlug: credential.tenantSlug }),
      }),
      redirect: "error",
    });
    const raw = await response.text();
    if (!response.ok) throw new GeoApiRequestError("GEO_API_LOGIN_FAILED", response.status);
    const login = loginResponseSchema.parse(JSON.parse(raw));
    const cookies = setCookieValues(response.headers);
    const session: ApiSession = {
      credentialHash,
      cookie: `${cookiePair(cookies, SESSION_COOKIE)}; ${cookiePair(cookies, CSRF_COOKIE)}`,
      csrfToken: login.csrfToken,
      principal: actorContextSchema.parse({
        actorId: login.actor.id,
        tenantId: login.tenant.id,
        role: login.actor.role,
        capabilities: login.actor.capabilities,
        requestId: "agent-mcp-session",
      }),
      expiresAtMs: Date.parse(login.expiresAt),
    };
    this.#sessionsByCredential.set(credentialHash, session);
    this.#credentialByPrincipal.set(principalKey(session.principal), credential);
    return session;
  }
}

export class HttpInternalGeoApiClient implements InternalGeoApiClient {
  readonly #sessions: GeoApiSessionRegistry;
  readonly #fetch: FetchLike;
  readonly #pendingGrants = new Map<string, PendingGrant>();

  constructor(options: { sessions: GeoApiSessionRegistry; fetchImpl?: FetchLike }) {
    this.#sessions = options.sessions;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request(
    principal: Readonly<ActorContext>,
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    const session = await this.#sessions.sessionForPrincipal(principal);
    const url = new URL(path.replace(/^\//u, ""), this.#sessions.baseUrl);
    if (url.origin !== this.#sessions.baseUrl.origin) {
      throw new GeoApiRequestError("GEO_API_DESTINATION_DENIED", 403);
    }
    const method = options.method ?? "GET";
    const response = await this.#fetch(url, {
      method,
      headers: {
        accept: "application/json",
        cookie: session.cookie,
        ...(method === "POST"
          ? { "content-type": "application/json", "x-csrf-token": session.csrfToken }
          : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new GeoApiRequestError("GEO_API_RESPONSE_TOO_LARGE", 502);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
      throw new GeoApiRequestError("GEO_API_RESPONSE_TOO_LARGE", 502);
    }
    let decoded: unknown = null;
    if (raw.length > 0) {
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new GeoApiRequestError("GEO_API_RESPONSE_INVALID", 502);
      }
    }
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(decoded);
      throw new GeoApiRequestError(
        parsed.success ? parsed.data.error.code : "GEO_API_REQUEST_FAILED",
        response.status,
      );
    }
    return decoded;
  }

  async getTenantContext(principal: Readonly<ActorContext>): Promise<unknown> {
    const [tenant, contacts, accounts, capabilities] = await Promise.all([
      this.#request(principal, "/api/tenant"),
      this.#request(principal, "/api/contacts"),
      this.#request(principal, "/api/channel-accounts"),
      this.#request(principal, "/api/capabilities"),
    ]);
    return { tenant, contacts, accounts, capabilities };
  }

  async lookupFacts(
    principal: Readonly<ActorContext>,
    input: Readonly<TenantFactLookupInput>,
  ): Promise<unknown> {
    const query = new URLSearchParams({
      brandId: input.brandId,
      query: input.query,
      limit: String(input.limit ?? 10),
    });
    const [facts, evidence] = await Promise.all([
      this.#request(principal, `/api/facts?${query.toString()}`),
      this.#request(principal, "/api/evidence-sources"),
    ]);
    return { facts, evidence };
  }

  async proposeDraft(
    principal: Readonly<ActorContext>,
    input: Readonly<DraftProposalInput>,
  ): Promise<unknown> {
    const [factsResult, contactsResult] = await Promise.all([
      this.#request(
        principal,
        `/api/facts?${new URLSearchParams({ brandId: input.brandId, limit: "20" }).toString()}`,
      ),
      this.#request(principal, "/api/contacts"),
    ]);
    const facts = z.object({ items: z.array(factSchema) }).parse(factsResult).items;
    const contacts = z.object({ items: z.array(contactSchema) }).parse(contactsResult).items;
    const currentFacts = facts.filter(
      (fact) =>
        fact.status === "verified" &&
        fact.evidenceSourceIds.length > 0 &&
        (fact.validUntil === null || Date.parse(fact.validUntil) > Date.now()),
    );
    const contactLine = contacts.map((contact) => `${contact.label}：${contact.value}`).join("；");
    const suppliedBody = input.fixtureDraft?.bodyMarkdown.trim() ?? "";
    const verifiedFactBlock = currentFacts.map((fact) => `- ${fact.claim}`).join("\n");
    const bodyMarkdown = [
      "## 当前可核验信息",
      verifiedFactBlock.length > 0
        ? verifiedFactBlock
        : "以下草稿只使用当前租户已登记的事实。涉及日期、价格、库存、资质或服务范围时，必须在发布前核对对应证据及有效期。",
      ...(suppliedBody.length > 0 ? [suppliedBody] : []),
      "## 咨询与服务边界",
      `${contactLine}。最终安排以签约前提供且仍在有效期内的材料为准；不要把历史页面、推测或模型生成内容写成当前承诺。`,
      "## 发布前复核",
      "逐项确认出发日期、交通、住宿、用餐、步行强度、自由活动、费用包含项和退改条件。对价格、库存、班次、签证或资质等会变化的信息，记录核验时间和来源；证据过期、联系方式不一致或服务边界不清时，内容只能退回修正，不能进入投放队列。",
    ].join("\n\n");
    const title = (input.fixtureDraft?.title ?? input.brief).slice(0, 30);
    const summary = input.fixtureDraft?.summary ?? "基于租户当前事实和证据生成的待审计内容草稿。";
    const result = await this.#request(principal, "/api/content", {
      method: "POST",
      body: {
        campaignId: input.campaignId,
        brandId: input.brandId,
        title,
        contentType: "guide",
        topicKey: `agent:${input.campaignId}`,
        payload: {
          title,
          summary,
          bodyMarkdown,
          media: [],
          claims: currentFacts.map((fact) => ({
            id: fact.id,
            text: fact.claim,
            evidenceSourceIds: fact.evidenceSourceIds,
            validUntil: fact.validUntil,
          })),
          contactIds: contacts.map((contact) => contact.id),
          tags: ["事实核验", "服务边界"],
        },
      },
    });
    const content = z
      .object({ id: idSchema, latestVersionId: idSchema, latestVersion: z.number().int() })
      .parse(result);
    return {
      contentItemId: content.id,
      contentVersionId: content.latestVersionId,
      version: content.latestVersion,
      providerMode: input.fixtureDraft === undefined ? "agent_proposal" : "fixture",
    };
  }

  async previewVariant(
    principal: Readonly<ActorContext>,
    input: Readonly<VariantPreviewInput>,
  ): Promise<unknown> {
    const [versionResult, accountsResult] = await Promise.all([
      this.#request(
        principal,
        `/api/content-versions/${encodeURIComponent(input.contentVersionId)}`,
      ),
      this.#request(principal, "/api/channel-accounts"),
    ]);
    const version = contentVersionSchema.parse(versionResult);
    const accounts = z.object({ items: z.array(accountSchema) }).parse(accountsResult).items;
    const account = accounts.find((candidate) => candidate.id === input.channelAccountId);
    if (
      account === undefined ||
      account.platform !== input.platform ||
      account.status !== "active" ||
      !account.supportedExecutionLevels.includes("dry_run")
    ) {
      throw new GeoApiRequestError("CHANNEL_ACCOUNT_SCOPE_DENIED", 403);
    }
    return this.#request(principal, `/api/content/${version.contentItemId}/variants`, {
      method: "POST",
      body: {
        contentVersionId: version.id,
        channelAccountId: input.channelAccountId,
        payload: version.payload,
      },
    });
  }

  async requestAudit(
    principal: Readonly<ActorContext>,
    input: Readonly<AuditRequestInput>,
  ): Promise<unknown> {
    const result = await this.#request(
      principal,
      `/api/variants/${encodeURIComponent(input.variantId)}/audits`,
      { method: "POST", body: { idempotencyKey: input.idempotencyKey } },
    );
    const parsed = z
      .object({
        artifact: z.object({
          id: idSchema,
          status: z.enum(["passed", "failed"]),
          channelAccountId: idSchema,
          findings: z.array(z.unknown()),
        }),
        publicationAuthorization: publicationAuthorizationSchema.nullable(),
      })
      .parse(result);
    if (parsed.publicationAuthorization !== null) {
      this.#pendingGrants.set(grantKey(principal, input.variantId), {
        grantId: parsed.publicationAuthorization.grantId,
        token: parsed.publicationAuthorization.token,
        channelAccountId: parsed.artifact.channelAccountId,
        expiresAtMs: Date.parse(parsed.publicationAuthorization.expiresAt),
      });
    }
    return {
      auditRunId: parsed.artifact.id,
      auditArtifactId: parsed.artifact.id,
      status: parsed.artifact.status,
      findings: parsed.artifact.findings,
      eligibleForPublicationRequest: parsed.publicationAuthorization !== null,
    };
  }

  async requestPublication(
    principal: Readonly<ActorContext>,
    input: Readonly<PublicationRequestInput>,
  ): Promise<unknown> {
    const key = grantKey(principal, input.variantId);
    const grant = this.#pendingGrants.get(key);
    if (
      grant === undefined ||
      grant.channelAccountId !== input.channelAccountId ||
      grant.expiresAtMs <= Date.now()
    ) {
      throw new GeoApiRequestError("PUBLICATION_GRANT_NOT_AVAILABLE", 409);
    }
    const result = await this.#request(principal, "/api/publication-requests", {
      method: "POST",
      body: {
        grantId: grant.grantId,
        token: grant.token,
        idempotencyKey: input.idempotencyKey,
        executionLevel: input.executionLevel,
      },
    });
    const publication = z
      .object({
        publicationJobId: idSchema,
        publicationOutboxEventId: idSchema,
        wasCreated: z.boolean(),
      })
      .parse(result);
    this.#pendingGrants.delete(key);
    return {
      publicationRequestId: publication.publicationJobId,
      publicationJobId: publication.publicationJobId,
      outboxEventId: publication.publicationOutboxEventId,
      wasCreated: publication.wasCreated,
    };
  }

  async requestVisibilityRun(
    principal: Readonly<ActorContext>,
    input: Readonly<VisibilityRequestInput>,
  ): Promise<unknown> {
    return this.#request(principal, "/api/visibility-runs", {
      method: "POST",
      body: input,
    });
  }

  async authorizeResourceScope(
    principal: Readonly<ActorContext>,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const resources: Array<{ kind: string; id: string }> = [];
    const add = (kind: string, key: string) => {
      const value = args[key];
      if (typeof value === "string") resources.push({ kind, id: value });
    };
    switch (toolName) {
      case "geo_tenant_context":
        return true;
      case "geo_fact_lookup":
        add("brand", "brandId");
        break;
      case "geo_draft_proposal":
        add("brand", "brandId");
        add("campaign", "campaignId");
        break;
      case "geo_variant_preview":
        add("content_version", "contentVersionId");
        add("channel_account", "channelAccountId");
        break;
      case "geo_audit_request":
        add("variant", "variantId");
        break;
      case "geo_publication_request":
        add("variant", "variantId");
        add("channel_account", "channelAccountId");
        break;
      case "geo_visibility_request":
        add("query_set_version", "querySetVersionId");
        break;
      default:
        return false;
    }
    if (resources.length === 0) return false;
    const result = await this.#request(principal, "/api/resource-scope-check", {
      method: "POST",
      body: { resources },
    });
    return z.object({ allowed: z.boolean() }).parse(result).allowed;
  }
}
