import { createHash, timingSafeEqual } from "node:crypto";

import {
  actorContextSchema,
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  articleTemplateById,
  automationRunStageSchema,
  automationRunStateSchema,
  automationRunTargetStateSchema,
  capabilitySchema,
  executionLevelSchema,
  idSchema,
  isoDateTimeSchema,
  platformSchema,
  publicationJobStateSchema,
  publicationVariantPayloadSchema,
  tenantRoleSchema,
  type ActorContext,
  type ArticleTemplateCatalog,
  type AutomationRunStage,
  type AutomationRunTargetState,
  type TenantContact,
} from "@geo/contracts";
import {
  compileAuditPolicy,
  editorialProfileForBrief,
  geoAuditPolicyDocumentSchema,
  renderEditorialSourcePayload,
  type FactSnapshot,
} from "@geo/core";
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
  MediaJobStatusInput,
  MediaProductionRequestInput,
} from "./api-client.js";
import type {
  AutomationGeoApiClient,
  AutomationLeaseMutationResult,
  AutomationPublicationJobView,
  AutomationRunLease,
  AutomationRunView,
} from "./automation-api.js";

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
  normalizedKey: z.string().min(1),
  claim: z.string(),
  status: z.enum(["draft", "verified", "rejected", "expired"]),
  evidenceSourceIds: z.array(idSchema),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).nullable(),
});

const contactSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  type: z.enum(["phone", "wechat", "email", "website", "address"]),
  label: z.string(),
  value: z.string(),
  isPrimary: z.boolean(),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).nullable(),
});

const policyBundleSchema = z.object({
  id: idSchema,
  version: z.string().min(1),
  status: z.enum(["draft", "active", "retired"]),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  document: geoAuditPolicyDocumentSchema,
  effectiveAt: z.string().datetime({ offset: true }),
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

const automationStatusSchema = z.object({
  control: z.object({
    mode: z.enum(["shadow", "supervised", "unattended", "paused", "stopped"]),
    killSwitchEnabled: z.boolean(),
  }),
  circuits: z.array(
    z.object({
      scopeType: z.enum(["tenant", "platform", "account", "campaign", "topic"]),
      scopeKey: z.string(),
      state: z.enum(["closed", "open", "half_open"]),
    }),
  ),
});

const automationTargetViewSchema = z.object({
  id: idSchema,
  runId: idSchema,
  channelAccountId: idSchema,
  platform: platformSchema,
  state: automationRunTargetStateSchema,
  variantId: idSchema.nullable(),
  auditRunId: idSchema.nullable(),
  auditArtifactId: idSchema.nullable(),
  publicationJobId: idSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const automationRunViewSchema = z.object({
  id: idSchema,
  batchId: idSchema,
  campaignId: idSchema,
  brandId: idSchema,
  slotKey: z.string().min(1),
  topicKey: z.string().min(1),
  brief: z.string().min(1),
  state: automationRunStateSchema,
  stage: automationRunStageSchema,
  availableAt: isoDateTimeSchema,
  attemptCount: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: isoDateTimeSchema.nullable(),
  heartbeatAt: isoDateTimeSchema.nullable(),
  checkpoint: z.record(z.string(), z.unknown()),
  contentItemId: idSchema.nullable(),
  contentVersionId: idSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  targets: z.array(automationTargetViewSchema),
});

const automationRunLeaseSchema = automationRunViewSchema.extend({
  tenantGate: z.object({ allowed: z.literal(true), evaluatedAt: isoDateTimeSchema }),
});

const automationLeaseMutationSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().min(1),
  leaseExpiresAt: isoDateTimeSchema.nullable(),
});

const automationPublicationJobSchema = z.object({
  id: idSchema,
  auditArtifactId: idSchema,
  variantId: idSchema,
  channelAccountId: idSchema,
  platform: platformSchema,
  executionLevel: executionLevelSchema,
  state: publicationJobStateSchema,
  lastErrorCode: z.string().nullable(),
  updatedAt: isoDateTimeSchema,
});

const articleTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    name: z.string().min(1),
    category: z.enum(["answer", "decision", "service", "trust", "freshness"]),
    editorialProfile: z.enum([
      "guide",
      "question_answer",
      "comparison",
      "risk_avoidance",
      "local_service",
    ]),
    scenario: z.string().min(1),
    travelExample: z.string().min(1),
    benefit: z.string().min(1),
    geoMechanisms: z.array(z.string().min(1)).min(1),
    outline: z.array(z.string().min(1)).min(1),
    evidenceRequirements: z.array(z.string().min(1)).min(1),
    riskBoundaries: z.array(z.string().min(1)).min(1),
  })
  .strict();

const articleTemplateCatalogSchema = z
  .object({
    version: z.literal(ARTICLE_TEMPLATE_CATALOG_VERSION),
    items: z.array(articleTemplateSchema).min(20),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    catalog.items.forEach((template, index) => {
      if (ids.has(template.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Article template IDs must be unique",
        });
      }
      ids.add(template.id);
    });
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

interface AuditCheckpoint {
  readonly auditArtifactId: string;
  readonly channelAccountId: string;
  readonly status: "passed" | "failed";
}

type FetchLike = typeof fetch;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function briefTerms(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const terms = new Set(normalized.match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? []);
  for (const term of [...terms]) {
    if (!/^\p{Script=Han}+$/u.test(term)) continue;
    const characters = [...term];
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return terms;
}

function factRelevance(brief: ReadonlySet<string>, fact: z.infer<typeof factSchema>): number {
  const factTerms = briefTerms(`${fact.normalizedKey} ${fact.claim}`);
  let matches = 0;
  for (const term of brief) {
    if (term.length > 1 && factTerms.has(term)) matches += 1;
  }
  return matches;
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

  async automationPrincipals(): Promise<readonly Readonly<ActorContext>[]> {
    const principals: Readonly<ActorContext>[] = [];
    let failedSessions = 0;
    for (const credential of this.#credentials) {
      let session: ApiSession;
      try {
        session = await this.#sessionForCredential(credential);
      } catch {
        failedSessions += 1;
        continue;
      }
      if (!session.principal.capabilities.includes("automation:execute")) continue;
      principals.push(
        actorContextSchema.parse({
          ...session.principal,
          requestId: "agent-mcp-automation-principal",
        }),
      );
    }
    if (principals.length === 0 && failedSessions === this.#credentials.length) {
      throw new GeoApiRequestError("MCP_AUTOMATION_PRINCIPAL_DISCOVERY_FAILED", 503);
    }
    return principals;
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

export class HttpInternalGeoApiClient implements InternalGeoApiClient, AutomationGeoApiClient {
  readonly #sessions: GeoApiSessionRegistry;
  readonly #fetch: FetchLike;
  readonly #pendingGrants = new Map<string, PendingGrant>();
  readonly #auditCheckpoints = new Map<string, AuditCheckpoint>();

  constructor(options: { sessions: GeoApiSessionRegistry; fetchImpl?: FetchLike }) {
    this.#sessions = options.sessions;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request(
    principal: Readonly<ActorContext>,
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const session = await this.#sessions.sessionForPrincipal(principal);
    const url = new URL(path.replace(/^\//u, ""), this.#sessions.baseUrl);
    if (url.origin !== this.#sessions.baseUrl.origin) {
      throw new GeoApiRequestError("GEO_API_DESTINATION_DENIED", 403);
    }
    const method = options.method ?? "GET";
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          cookie: session.cookie,
          ...(method === "POST"
            ? { "content-type": "application/json", "x-csrf-token": session.csrfToken }
            : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        redirect: "error",
      });
    } catch (error) {
      if (
        options.signal?.aborted === true ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError")
      ) {
        throw error;
      }
      throw new GeoApiRequestError("GEO_API_TRANSPORT_FAILED", 503);
    }
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

  async getArticleTemplateCatalog(
    principal: Readonly<ActorContext>,
  ): Promise<Readonly<ArticleTemplateCatalog>> {
    return articleTemplateCatalogSchema.parse(
      await this.#request(principal, "/api/article-templates"),
    );
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
    const template =
      input.articleTemplateId === undefined ? null : articleTemplateById(input.articleTemplateId);
    if (input.articleTemplateId !== undefined && template === null) {
      throw new GeoApiRequestError("ARTICLE_TEMPLATE_UNKNOWN", 400);
    }
    const [factsResult, contactsResult, policiesResult, automationResult] = await Promise.all([
      this.#request(
        principal,
        `/api/facts?${new URLSearchParams({ brandId: input.brandId, limit: "20" }).toString()}`,
      ),
      this.#request(principal, "/api/contacts"),
      this.#request(principal, "/api/policies"),
      this.#request(principal, "/api/automation"),
    ]);
    const facts = z.object({ items: z.array(factSchema) }).parse(factsResult).items;
    const contacts = z.object({ items: z.array(contactSchema) }).parse(contactsResult).items;
    const policyBundles = z
      .object({ items: z.array(policyBundleSchema) })
      .parse(policiesResult).items;
    const automation = automationStatusSchema.parse(automationResult);
    const topicKey = `agent:${sha256(input.brief.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")).slice(0, 32)}`;
    const generationCircuitOpen = automation.circuits.some(
      (circuit) =>
        circuit.state !== "closed" &&
        ((circuit.scopeType === "tenant" && circuit.scopeKey === "*") ||
          (circuit.scopeType === "campaign" && circuit.scopeKey === input.campaignId) ||
          (circuit.scopeType === "topic" && circuit.scopeKey === topicKey)),
    );
    if (
      automation.control.killSwitchEnabled ||
      automation.control.mode === "paused" ||
      automation.control.mode === "stopped" ||
      generationCircuitOpen
    ) {
      throw new GeoApiRequestError("AUTOMATION_GENERATION_BLOCKED", 409);
    }
    const now = Date.now();
    const activePolicyBundle = policyBundles.find(
      (bundle) => bundle.status === "active" && Date.parse(bundle.effectiveAt) <= now,
    );
    if (activePolicyBundle === undefined) {
      throw new GeoApiRequestError("ACTIVE_AUDIT_POLICY_NOT_FOUND", 422);
    }
    const policy = compileAuditPolicy({
      version: activePolicyBundle.version,
      policyHash: activePolicyBundle.policyHash,
      document: activePolicyBundle.document,
    });
    const currentFacts = facts.filter(
      (fact) =>
        fact.status === "verified" &&
        fact.evidenceSourceIds.length > 0 &&
        Date.parse(fact.validFrom) <= now &&
        (fact.validUntil === null || Date.parse(fact.validUntil) > now),
    );
    const currentContacts = contacts.filter(
      (contact) =>
        Date.parse(contact.validFrom) <= now &&
        (contact.validUntil === null || Date.parse(contact.validUntil) > now),
    );
    const terms = briefTerms(input.brief);
    const selectedFacts = currentFacts
      .map((fact, index) => ({ fact, index, relevance: factRelevance(terms, fact) }))
      .filter((candidate) => candidate.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
      .slice(0, 8)
      .map((candidate) => candidate.fact);
    if (selectedFacts.length === 0) {
      throw new GeoApiRequestError("NO_RELEVANT_VERIFIED_FACTS", 422);
    }
    const factSnapshot: FactSnapshot = {
      tenantId: principal.tenantId,
      capturedAt: new Date(now).toISOString(),
      facts: selectedFacts.map((fact) => ({
        id: fact.id,
        brandId: fact.brandId,
        text: fact.claim,
        evidenceSourceIds: fact.evidenceSourceIds,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
      })),
      sources: [],
    };
    const editorialProfile = template?.editorialProfile ?? editorialProfileForBrief(input.brief);
    const payload = renderEditorialSourcePayload({
      editorialProfile,
      ...(template === null ? {} : { articleTemplateId: template.id }),
      policy,
      factSnapshot,
      contacts: currentContacts as readonly TenantContact[],
    });
    const result = await this.#request(principal, "/api/content", {
      method: "POST",
      body: {
        campaignId: input.campaignId,
        brandId: input.brandId,
        title: payload.title,
        contentType: editorialProfile,
        topicKey,
        idempotencyKey: input.idempotencyKey,
        payload,
      },
    });
    const content = z
      .object({ id: idSchema, latestVersionId: idSchema, latestVersion: z.number().int() })
      .parse(result);
    return {
      contentItemId: content.id,
      contentVersionId: content.latestVersionId,
      version: content.latestVersion,
      providerMode: input.fixtureMode === true ? "fixture" : "agent_proposal",
      ...(template === null ? {} : { articleTemplateId: template.id }),
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
    const result = await this.#request(
      principal,
      `/api/content/${version.contentItemId}/variants`,
      {
        method: "POST",
        body: {
          contentVersionId: version.id,
          channelAccountId: input.channelAccountId,
        },
      },
    );
    const variantId = z.object({ id: idSchema }).parse(result).id;
    return { ...(result as Readonly<Record<string, unknown>>), variantId };
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
        auditRunId: idSchema,
        artifact: z.object({
          id: idSchema,
          status: z.enum(["passed", "failed"]),
          channelAccountId: idSchema,
          findings: z.array(z.unknown()),
        }),
        publicationAuthorization: publicationAuthorizationSchema.nullable(),
      })
      .parse(result);
    const key = grantKey(principal, input.variantId);
    this.#pendingGrants.delete(key);
    this.#auditCheckpoints.set(key, {
      auditArtifactId: parsed.artifact.id,
      channelAccountId: parsed.artifact.channelAccountId,
      status: parsed.artifact.status,
    });
    if (parsed.publicationAuthorization !== null) {
      this.#pendingGrants.set(key, {
        grantId: parsed.publicationAuthorization.grantId,
        token: parsed.publicationAuthorization.token,
        channelAccountId: parsed.artifact.channelAccountId,
        expiresAtMs: Date.parse(parsed.publicationAuthorization.expiresAt),
      });
    }
    return {
      auditRunId: parsed.auditRunId,
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
    const checkpoint = this.#auditCheckpoints.get(key);
    if (checkpoint?.status === "passed" && checkpoint.channelAccountId === input.channelAccountId) {
      const replayResult = await this.#request(principal, "/api/publication-replays/resolve", {
        method: "POST",
        body: {
          idempotencyKey: input.idempotencyKey,
          variantId: input.variantId,
          auditArtifactId: checkpoint.auditArtifactId,
          channelAccountId: input.channelAccountId,
          executionLevel: input.executionLevel,
        },
      });
      const replay = z
        .object({
          publication: z
            .object({
              publicationJobId: idSchema,
              publicationOutboxEventId: idSchema,
              wasCreated: z.literal(false),
            })
            .nullable(),
        })
        .parse(replayResult).publication;
      if (replay !== null) {
        this.#pendingGrants.delete(key);
        return {
          publicationRequestId: replay.publicationJobId,
          publicationJobId: replay.publicationJobId,
          outboxEventId: replay.publicationOutboxEventId,
          wasCreated: false,
        };
      }
    }
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

  async requestMediaProduction(
    principal: Readonly<ActorContext>,
    input: Readonly<MediaProductionRequestInput>,
  ): Promise<unknown> {
    return this.#request(
      principal,
      `/api/content-versions/${encodeURIComponent(input.contentVersionId)}/media-jobs`,
      {
        method: "POST",
        body: {
          platform: input.platform,
          role: input.role,
          claimIds: input.claimIds,
          idempotencyKey: input.idempotencyKey,
        },
      },
    );
  }

  async getMediaJobStatus(
    principal: Readonly<ActorContext>,
    input: Readonly<MediaJobStatusInput>,
  ): Promise<unknown> {
    return this.#request(principal, `/api/media-jobs/${encodeURIComponent(input.mediaJobId)}`, {});
  }

  async claimAutomationRuns(
    principal: Readonly<ActorContext>,
    input: {
      readonly producerId: string;
      readonly limit: number;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly AutomationRunLease[]> {
    const result = await this.#request(principal, "/api/automation-runs/claim", {
      method: "POST",
      body: {
        producerId: input.producerId,
        limit: input.limit,
        leaseSeconds: input.leaseSeconds,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return z.object({ items: z.array(automationRunLeaseSchema) }).parse(result)
      .items as readonly AutomationRunLease[];
  }

  async getAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    signal?: AbortSignal,
  ): Promise<AutomationRunView> {
    return automationRunViewSchema.parse(
      await this.#request(principal, `/api/automation-runs/${encodeURIComponent(runId)}`, {
        ...(signal === undefined ? {} : { signal }),
      }),
    ) as AutomationRunView;
  }

  async heartbeatAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly stage: AutomationRunStage;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult> {
    return automationLeaseMutationSchema.parse(
      await this.#request(
        principal,
        `/api/automation-runs/${encodeURIComponent(runId)}/heartbeat`,
        {
          method: "POST",
          body: {
            producerId: input.producerId,
            attempt: input.attempt,
            stage: input.stage,
            checkpoint: input.checkpoint,
            leaseSeconds: input.leaseSeconds,
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      ),
    );
  }

  async checkpointAutomationDraft(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult> {
    return automationLeaseMutationSchema.parse(
      await this.#request(
        principal,
        `/api/automation-runs/${encodeURIComponent(runId)}/draft-checkpoint`,
        {
          method: "POST",
          body: {
            producerId: input.producerId,
            attempt: input.attempt,
            contentItemId: input.contentItemId,
            contentVersionId: input.contentVersionId,
            checkpoint: input.checkpoint,
            leaseSeconds: input.leaseSeconds,
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      ),
    );
  }

  async checkpointAutomationTarget(
    principal: Readonly<ActorContext>,
    runId: string,
    targetId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly state: Exclude<AutomationRunTargetState, "pending" | "cancelled">;
      readonly variantId?: string;
      readonly auditRunId?: string;
      readonly auditArtifactId?: string;
      readonly publicationJobId?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult> {
    return automationLeaseMutationSchema.parse(
      await this.#request(
        principal,
        `/api/automation-runs/${encodeURIComponent(runId)}/targets/${encodeURIComponent(targetId)}/checkpoint`,
        {
          method: "POST",
          body: {
            producerId: input.producerId,
            attempt: input.attempt,
            state: input.state,
            ...(input.variantId === undefined ? {} : { variantId: input.variantId }),
            ...(input.auditRunId === undefined ? {} : { auditRunId: input.auditRunId }),
            ...(input.auditArtifactId === undefined
              ? {}
              : { auditArtifactId: input.auditArtifactId }),
            ...(input.publicationJobId === undefined
              ? {}
              : { publicationJobId: input.publicationJobId }),
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
            checkpoint: input.checkpoint,
            leaseSeconds: input.leaseSeconds,
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      ),
    );
  }

  async reconcileAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly retryAfter?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationRunView> {
    return automationRunViewSchema.parse(
      await this.#request(
        principal,
        `/api/automation-runs/${encodeURIComponent(runId)}/reconcile`,
        {
          method: "POST",
          body: {
            producerId: input.producerId,
            attempt: input.attempt,
            ...(input.retryAfter === undefined ? {} : { retryAfter: input.retryAfter }),
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      ),
    ) as AutomationRunView;
  }

  async getAutomationPublicationJob(
    principal: Readonly<ActorContext>,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<AutomationPublicationJobView> {
    return automationPublicationJobSchema.parse(
      await this.#request(principal, `/api/publication-jobs/${encodeURIComponent(jobId)}`, {
        ...(signal === undefined ? {} : { signal }),
      }),
    ) as AutomationPublicationJobView;
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
      case "geo_template_catalog":
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
      case "geo_media_production_request":
        add("content_version", "contentVersionId");
        break;
      case "geo_media_job_status":
        add("media_job", "mediaJobId");
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
