import { capabilitiesForRole } from "@geo/authz";
import type {
  AuditArtifact,
  PublicationVariantPayload,
  TenantContact,
  TenantRole,
} from "@geo/contracts";
import { sha256Canonical, sha256Text } from "@geo/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PasswordService, type PublicationGovernanceGate } from "./app.js";
import {
  RepositoryConflictError,
  type ApiRepository,
  type AuditContextRecord,
  type CreateSessionInput,
  type LoginIdentity,
  type PersistAuditInput,
  type PublicationGovernanceAuditInput,
  type PublicationRequestInput,
  type RequestContext,
  type ResolveSessionInput,
  type ResolvedSession,
} from "./repository.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "20000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000101",
  phone: "10000000-0000-4000-8000-000000000401",
  wechatOne: "10000000-0000-4000-8000-000000000402",
  wechatTwo: "10000000-0000-4000-8000-000000000403",
  source: "10000000-0000-4000-8000-000000000501",
  content: "10000000-0000-4000-8000-000000000601",
  version: "10000000-0000-4000-8000-000000000602",
  variant: "10000000-0000-4000-8000-000000000603",
  account: "10000000-0000-4000-8000-000000000701",
  policy: "10000000-0000-4000-8000-000000000801",
  brand: "10000000-0000-4000-8000-000000000901",
};

const fixedNow = new Date("2026-07-14T01:00:00.000Z");
const tokenValue = "test-token-value-that-is-longer-than-thirty-two-bytes";

const contacts: readonly TenantContact[] = [
  {
    id: ids.phone,
    tenantId: ids.tenant,
    type: "phone",
    label: "24-hour hotline",
    value: "4001133986",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: ids.wechatOne,
    tenantId: ids.tenant,
    type: "wechat",
    label: "WeChat one",
    value: "ZTGL3411",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: ids.wechatTwo,
    tenantId: ids.tenant,
    type: "wechat",
    label: "WeChat two",
    value: "ZTGL6431",
    isPrimary: false,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
];

const articlePayload: PublicationVariantPayload = {
  title: "Japan group tour checks",
  summary: "Verify the itinerary, service boundary, and current contact details before booking.",
  bodyMarkdown: [
    "## Verify current evidence",
    "The final itinerary should identify transport, accommodation, walking intensity, free time, and cancellation terms. Readers should compare the dated source with the signed itinerary instead of relying on an unsupported promotional promise. This paragraph deliberately contains enough concrete guidance for the minimum quality floor.",
    "The signed itinerary is the final service boundary.",
    "## Check whether the service fits",
    "Older travelers and first-time international travelers should confirm pace and assistance before signing. Hotline: 4001133986. WeChat: ZTGL3411 and ZTGL6431. The current evidence remains the source of truth.",
  ].join("\n\n"),
  media: [],
  claims: [
    {
      id: "10000000-0000-4000-8000-000000000502",
      text: "The signed itinerary is the final service boundary",
      evidenceSourceIds: [ids.source],
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
  contactIds: [ids.phone, ids.wechatOne, ids.wechatTwo],
  tags: ["Japan travel", "group tour"],
};

function identity(role: TenantRole): LoginIdentity {
  return {
    userId: ids.actor,
    email: "owner@example.test",
    passwordHash: "correct-hash",
    displayName: "Test Owner",
    status: "active",
    memberships: [
      {
        tenantId: ids.tenant,
        tenantSlug: "zhongtong",
        tenantDisplayName: "Zhongtong International Travel",
        tenantStatus: "active",
        role,
        capabilities: capabilitiesForRole(role),
        membershipStatus: "active",
      },
    ],
  };
}

class FakeRepository implements ApiRepository {
  readonly sessions = new Map<string, CreateSessionInput>();
  readonly persistedAudits: PersistAuditInput[] = [];
  readonly auditIdempotency = new Map<
    string,
    { readonly requestHash: string; readonly input: PersistAuditInput }
  >();
  readonly publicationRequests: PublicationRequestInput[] = [];
  readonly governanceDecisions: PublicationGovernanceAuditInput[] = [];
  readonly evidenceSourceInputs: Parameters<ApiRepository["createEvidenceSource"]>[1][] = [];
  readonly factInputs: Parameters<ApiRepository["createFact"]>[1][] = [];
  readonly contentVersionInputs: Parameters<ApiRepository["createContentVersion"]>[1][] = [];
  readonly visibilityRuns: Parameters<ApiRepository["persistVisibilityRun"]>[1][] = [];
  automationControl = {
    id: "10000000-0000-4000-8000-000000000951",
    mode: "shadow" as const,
    killSwitchEnabled: false,
    reason: null as string | null,
    quota: { dailyPublications: 0, dryRunOnly: true },
    updatedAt: fixedNow.toISOString(),
  };
  lastContext: RequestContext | null = null;
  loginIdentity: LoginIdentity | null;
  auditPayload: PublicationVariantPayload = articlePayload;

  constructor(role: TenantRole = "owner") {
    this.loginIdentity = identity(role);
  }

  async isReady() {
    return true;
  }

  async findLoginIdentity() {
    return this.loginIdentity;
  }

  async findLoginIdentityByUserId() {
    return this.loginIdentity;
  }

  async createSession(input: CreateSessionInput) {
    this.sessions.set(input.sessionId, input);
  }

  async resolveSession(input: ResolveSessionInput): Promise<ResolvedSession | null> {
    this.lastContext = input;
    const stored = this.sessions.get(input.sessionId);
    if (
      stored === undefined ||
      stored.actorId !== input.actorId ||
      stored.tenantId !== input.tenantId ||
      stored.tokenHash !== input.tokenHash
    ) {
      return null;
    }
    return {
      sessionId: stored.sessionId,
      userId: stored.actorId,
      userDisplayName: "Test Owner",
      tenantId: stored.tenantId,
      tenantSlug: "zhongtong",
      tenantDisplayName: "Zhongtong International Travel",
      role: this.loginIdentity?.memberships[0]?.role ?? "viewer",
      capabilities: this.loginIdentity?.memberships[0]?.capabilities ?? [],
      csrfHash: stored.csrfHash,
      expiresAt: stored.expiresAt,
    };
  }

  async revokeSession(_context: RequestContext, sessionId: string) {
    this.sessions.delete(sessionId);
  }

  async getTenant(context: RequestContext) {
    this.lastContext = context;
    return {
      id: context.tenantId,
      slug: "zhongtong",
      displayName: "Zhongtong International Travel",
      legalName: "Zhongtong International Travel",
      industry: "travel",
      status: "active",
      defaultLocale: "zh-CN",
    };
  }

  async getAutomationStatus() {
    return { control: this.automationControl, circuits: [] };
  }

  async setTenantKillSwitch(
    _context: RequestContext,
    input: Parameters<ApiRepository["setTenantKillSwitch"]>[1],
  ) {
    this.automationControl = {
      ...this.automationControl,
      killSwitchEnabled: input.enabled,
      reason: input.reason,
    };
    return this.automationControl;
  }

  async listContacts(context: RequestContext) {
    this.lastContext = context;
    return contacts;
  }

  async listChannelAccounts(context: RequestContext) {
    this.lastContext = context;
    return [
      {
        id: ids.account,
        platform: "toutiao" as const,
        displayName: "Toutiao dry run",
        capability: "manual_only" as const,
        supportedExecutionLevels: ["dry_run" as const],
        evidenceType: "preview" as const,
        evidenceRefs: ["fixture:dry-run-only"],
        status: "active",
        lastVerifiedAt: null,
      },
    ];
  }

  async listEvidenceSources() {
    return [];
  }

  async createEvidenceSource(
    _context: RequestContext,
    input: Parameters<ApiRepository["createEvidenceSource"]>[1],
  ) {
    this.evidenceSourceInputs.push(input);
    return {
      id: input.id,
      type: input.type,
      title: input.title,
      sourceUrl: input.sourceUrl,
      contentHash: input.contentHash,
      capturedAt: input.capturedAt,
      validUntil: input.validUntil,
      metadata: input.metadata,
    };
  }

  async listFacts() {
    return [];
  }

  async createFact(_context: RequestContext, input: Parameters<ApiRepository["createFact"]>[1]) {
    this.factInputs.push(input);
    return input;
  }

  async checkResourceScope(
    _context: RequestContext,
    resources: Parameters<ApiRepository["checkResourceScope"]>[1],
  ) {
    return { allowed: true, denied: resources.slice(0, 0) };
  }

  async listCampaigns() {
    return [];
  }

  async createCampaign(
    _context: RequestContext,
    input: Parameters<ApiRepository["createCampaign"]>[1],
  ) {
    return { ...input, status: "draft" };
  }

  async listContent() {
    return [];
  }

  async createContent(
    _context: RequestContext,
    input: Parameters<ApiRepository["createContent"]>[1],
  ) {
    return {
      id: input.contentId,
      campaignId: input.campaignId,
      brandId: input.brandId,
      title: input.title,
      contentType: input.contentType,
      state: "draft",
      topicKey: input.topicKey,
      latestVersion: 1,
      latestVersionId: input.versionId,
    };
  }

  async createContentVersion(
    _context: RequestContext,
    input: Parameters<ApiRepository["createContentVersion"]>[1],
  ) {
    this.contentVersionInputs.push(input);
    return {
      id: input.contentItemId,
      campaignId: ids.content,
      brandId: ids.brand,
      title: "Versioned content",
      contentType: "evidence",
      state: "draft",
      topicKey: "versioned",
      latestVersion: 2,
      latestVersionId: input.versionId,
    };
  }

  async getContentVersion(_context: RequestContext, contentVersionId: string) {
    return {
      id: contentVersionId,
      contentItemId: ids.content,
      version: 1,
      summary: articlePayload.summary,
      bodyMarkdown: articlePayload.bodyMarkdown,
      payload: articlePayload,
      payloadHash: sha256Canonical(articlePayload),
      frozenAt: null,
    };
  }

  async listVariants() {
    return [];
  }

  async createVariant(
    _context: RequestContext,
    input: Parameters<ApiRepository["createVariant"]>[1],
  ) {
    return {
      id: input.variantId,
      contentVersionId: input.contentVersionId,
      channelAccountId: input.channelAccountId,
      platform: "toutiao" as const,
      variantVersion: 1,
      payload: input.payload,
      payloadHash: input.payloadHash,
      state: "draft",
      frozenAt: null,
    };
  }

  async loadAuditContext(): Promise<AuditContextRecord> {
    const claim = articlePayload.claims[0];
    if (claim === undefined) throw new Error("Audit fixture must contain one claim");
    return {
      brandId: ids.brand,
      variant: {
        id: ids.variant,
        contentVersionId: ids.version,
        channelAccountId: ids.account,
        platform: "toutiao",
        variantVersion: 1,
        payload: this.auditPayload,
        payloadHash: "a".repeat(64),
        state: "draft",
        frozenAt: null,
      },
      contacts,
      factSnapshot: {
        tenantId: ids.tenant,
        capturedAt: fixedNow.toISOString(),
        facts: [
          {
            id: claim.id,
            brandId: ids.brand,
            text: claim.text,
            evidenceSourceIds: [ids.source],
            validFrom: "2026-07-13T00:00:00.000Z",
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
        sources: [
          {
            id: ids.source,
            locator: "https://example.test/current-itinerary",
            contentHash: "c".repeat(64),
            observedAt: "2026-07-13T01:00:00.000Z",
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
      priorVariants: [],
      policyBundle: { id: ids.policy, version: "travel-v1" },
    };
  }

  async findAuditByIdempotency(
    context: RequestContext,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const existing = this.auditIdempotency.get(`${context.tenantId}:${idempotencyKey}`);
    if (existing === undefined) return null;
    if (existing.requestHash !== requestHash) {
      throw new RepositoryConflictError("Audit idempotency key conflicts with another request");
    }
    return {
      artifact: existing.input.artifact,
      grant: existing.input.grant,
      wasCreated: false,
    };
  }

  async persistAudit(context: RequestContext, input: PersistAuditInput) {
    const key = `${context.tenantId}:${input.idempotencyKey}`;
    const existing = this.auditIdempotency.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash) {
        throw new RepositoryConflictError("Audit idempotency key conflicts with another request");
      }
      return {
        artifact: existing.input.artifact,
        grant: existing.input.grant,
        wasCreated: false,
      };
    }
    this.persistedAudits.push(input);
    this.auditIdempotency.set(key, { requestHash: input.requestHash, input });
    return { artifact: input.artifact, grant: input.grant, wasCreated: true };
  }

  async getAudit(
    _context: RequestContext,
    artifactId: string,
  ): Promise<Readonly<AuditArtifact> | null> {
    return this.persistedAudits.find((entry) => entry.artifact.id === artifactId)?.artifact ?? null;
  }

  async consumePublicationGrant(_context: RequestContext, input: PublicationRequestInput) {
    this.publicationRequests.push(input);
    return {
      publicationJobId: "10000000-0000-4000-8000-000000000991",
      publicationOutboxEventId: "10000000-0000-4000-8000-000000000992",
      wasCreated: true,
    };
  }

  async recordPublicationGovernanceDecision(
    _context: RequestContext,
    input: PublicationGovernanceAuditInput,
  ) {
    this.governanceDecisions.push(input);
  }

  async listPublicationJobs() {
    return [];
  }

  async listPublicationReceipts() {
    return [];
  }

  async findVisibilityRunByIdempotency() {
    return null;
  }

  async loadVisibilityRunContext() {
    return {
      querySetVersionId: ids.version,
      querySetVersion: 1,
      prompts: [{ key: "brand-contact", category: "contact", prompt: "中通联系方式" }],
      brandNames: ["中通国际旅行社"],
      expectedContacts: ["4001133986", "ZTGL3411", "ZTGL6431"],
      evidenceUrls: [],
    };
  }

  async persistVisibilityRun(
    _context: RequestContext,
    input: Parameters<ApiRepository["persistVisibilityRun"]>[1],
  ) {
    this.visibilityRuns.push(input);
  }

  async getVisibilitySummary() {
    return [];
  }
}

const passwordService: PasswordService = {
  hash: async () => "dummy-hash",
  verify: async (passwordHash, password) =>
    passwordHash === "correct-hash" && password === "correct-password",
};

let sequence = 1;
function nextUuid(): string {
  const suffix = String(sequence).padStart(12, "0");
  sequence += 1;
  return `90000000-0000-4000-8000-${suffix}`;
}

function cookieHeader(headers: Record<string, unknown>): string {
  const value = headers["set-cookie"];
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, tenantSlug?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "owner@example.test",
      password: "correct-password",
      ...(tenantSlug === undefined ? {} : { tenantSlug }),
    },
  });
  return {
    response,
    body: response.json<{ csrfToken: string }>(),
    cookie: cookieHeader(response.headers),
  };
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

async function testApp(
  repository: ApiRepository,
  governanceGate: PublicationGovernanceGate = {
    evaluate: async () => ({ allowed: true, reason: "test_allow", evidence: { test: true } }),
  },
) {
  const app = await buildApp({
    repository,
    sessionSecret: "test-session-secret-with-at-least-32-bytes",
    cookieSecure: true,
    passwordService,
    dummyPasswordHash: "dummy-hash",
    now: () => new Date(fixedNow),
    uuid: nextUuid,
    randomToken: () => tokenValue,
    publicationTokenFactory: () => tokenValue,
    allowedOrigins: ["https://console.example.test"],
    publicationGovernanceGate: governanceGate,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  sequence = 1;
});

describe("Fastify API security and vertical publication flow", () => {
  it("rejects untrusted browser origins before authentication", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const untrusted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      payload: { email: "owner@example.test", password: "correct-password" },
    });
    const trusted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://console.example.test", "sec-fetch-site": "same-origin" },
      payload: { email: "owner@example.test", password: "correct-password" },
    });

    expect(untrusted.statusCode).toBe(403);
    expect(untrusted.json()).toMatchObject({ error: { code: "ORIGIN_DENIED" } });
    expect(trusted.statusCode).toBe(200);
  });

  it("uses a secure JWT cookie and derives tenant scope from the membership session", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app, "zhongtong");

    expect(authenticated.response.statusCode).toBe(200);
    const setCookie = authenticated.response.headers["set-cookie"];
    expect(JSON.stringify(setCookie)).toContain("HttpOnly");
    expect(JSON.stringify(setCookie)).toContain("Secure");
    expect(JSON.stringify(setCookie)).toContain("SameSite=Strict");

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: authenticated.cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.body).not.toContain("csrfHash");
    expect(sessionResponse.body).not.toContain("tokenHash");

    const contactsResponse = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: {
        cookie: authenticated.cookie,
        "x-tenant-id": ids.otherTenant,
      },
    });

    expect(contactsResponse.statusCode).toBe(200);
    expect(repository.lastContext?.tenantId).toBe(ids.tenant);
    expect(
      contactsResponse
        .json<{ items: TenantContact[] }>()
        .items.map((item: TenantContact) => item.value),
    ).toEqual(["4001133986", "ZTGL3411", "ZTGL6431"]);
  });

  it("switches tenant by revoking and reissuing a tenant-bound session", async () => {
    const repository = new FakeRepository();
    const currentIdentity = repository.loginIdentity;
    if (currentIdentity === null) throw new Error("test identity is required");
    repository.loginIdentity = {
      ...currentIdentity,
      memberships: [
        ...currentIdentity.memberships,
        {
          tenantId: ids.otherTenant,
          tenantSlug: "isolation",
          tenantDisplayName: "Isolation Tenant",
          tenantStatus: "active",
          role: "viewer",
          capabilities: capabilitiesForRole("viewer"),
          membershipStatus: "active",
        },
      ],
    };
    const app = await testApp(repository);
    const authenticated = await login(app, "zhongtong");
    const tenants = await app.inject({
      method: "GET",
      url: "/api/auth/tenants",
      headers: { cookie: authenticated.cookie },
    });
    const switched = await app.inject({
      method: "POST",
      url: "/api/auth/switch-tenant",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { tenantSlug: "isolation" },
    });

    expect(tenants.json<{ items: unknown[] }>().items).toHaveLength(2);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      tenant: { id: ids.otherTenant, slug: "isolation" },
      actor: { role: "viewer" },
    });
    expect([...repository.sessions.values()]).toHaveLength(1);
    expect([...repository.sessions.values()][0]?.tenantId).toBe(ids.otherTenant);
  });

  it("returns a generic login failure and does not create a session", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.test", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
    expect(repository.sessions.size).toBe(0);
  });

  it("requires both role capability and CSRF for writes", async () => {
    const repository = new FakeRepository("viewer");
    const app = await testApp(repository);
    const authenticated = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        brandId: ids.brand,
        name: "Campaign",
        objective: "Objective",
        industry: "travel",
        topicKey: "topic",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });
  });

  it("persists and confirms the tenant kill switch through the protected API", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const before = await app.inject({
      method: "GET",
      url: "/api/automation",
      headers: { cookie: authenticated.cookie },
    });
    const changed = await app.inject({
      method: "POST",
      url: "/api/automation/kill-switch",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { enabled: true, reason: "Operator emergency pause" },
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/automation",
      headers: { cookie: authenticated.cookie },
    });

    expect(before.json()).toMatchObject({ control: { killSwitchEnabled: false } });
    expect(changed.json()).toMatchObject({ control: { killSwitchEnabled: true } });
    expect(after.json()).toMatchObject({
      control: {
        mode: "shadow",
        killSwitchEnabled: true,
        reason: "Operator emergency pause",
      },
      circuits: [],
    });
  });

  it("requires tenant management authority to mark a fact verified", async () => {
    const repository = new FakeRepository("editor");
    const app = await testApp(repository);
    const authenticated = await login(app);
    const headers = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };
    const baseFact = {
      brandId: ids.brand,
      normalizedKey: "service.boundary",
      claim: "The signed itinerary is the final service boundary",
      evidenceSourceIds: [ids.source],
    };

    const verified = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers,
      payload: { ...baseFact, status: "verified" },
    });
    const draft = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers,
      payload: baseFact,
    });

    expect(verified.statusCode).toBe(403);
    expect(verified.json()).toMatchObject({ error: { code: "FACT_VERIFICATION_DENIED" } });
    expect(draft.statusCode).toBe(201);
    expect(repository.factInputs[0]?.status).toBe("draft");
  });

  it("persists an immutable passing audit and service-issued one-time grant", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      artifact: AuditArtifact;
      publicationAuthorization: { grantId: string; token: string; expiresAt: string } | null;
      wasCreated: boolean;
    }>();
    expect(body.artifact.status).toBe("passed");
    expect(body.publicationAuthorization?.token).toBe(tokenValue);
    expect(body.wasCreated).toBe(true);
    expect(repository.persistedAudits).toHaveLength(1);
    expect(repository.persistedAudits[0]?.grant?.status).toBe("issued");
    expect(Object.isFrozen(repository.persistedAudits[0]?.artifact)).toBe(true);

    const replay = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      artifact: { id: body.artifact.id },
      publicationAuthorization: body.publicationAuthorization,
      wasCreated: false,
    });
    expect(repository.persistedAudits).toHaveLength(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/variants/10000000-0000-4000-8000-000000000604/audits",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-passing" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "RESOURCE_CONFLICT" } });

    const forbiddenGrantEndpoint = await app.inject({
      method: "POST",
      url: "/api/grants",
      headers: { cookie: authenticated.cookie },
    });
    expect(forbiddenGrantEndpoint.statusCode).toBe(404);
  });

  it("persists a failed audit without issuing a publication authorization", async () => {
    const repository = new FakeRepository();
    repository.auditPayload = {
      ...articlePayload,
      bodyMarkdown: `${articlePayload.bodyMarkdown}\n\nThis offer is 100%保证 and uses hotline 4001133987.`,
    };
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-failing" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      artifact: { status: "failed" },
      publicationAuthorization: null,
    });
    expect(repository.persistedAudits[0]?.grant).toBeNull();
  });

  it("passes only a token hash to the repository grant-consumption boundary", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const auditResponse = await app.inject({
      method: "POST",
      url: `/api/variants/${ids.variant}/audits`,
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: { idempotencyKey: "audit-for-publication" },
    });
    const authorization = auditResponse.json<{
      publicationAuthorization: { grantId: string; token: string };
    }>().publicationAuthorization;

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: { cookie: authenticated.cookie },
      payload: {
        grantId: authorization.grantId,
        token: authorization.token,
        idempotencyKey: "publish-once",
        executionLevel: "dry_run",
      },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: authorization.grantId,
        token: authorization.token,
        idempotencyKey: "publish-once",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(repository.publicationRequests).toHaveLength(1);
    expect(repository.publicationRequests[0]).toMatchObject({
      grantId: authorization.grantId,
      tokenHash: sha256Text(authorization.token),
      idempotencyKey: "publish-once",
      executionLevel: "dry_run",
    });
    expect(repository.publicationRequests[0]).not.toHaveProperty("token");
    expect(repository.governanceDecisions[0]).toMatchObject({
      allowed: true,
      grantId: authorization.grantId,
      executionLevel: "dry_run",
    });
  });

  it("fails closed when publication governance denies a direct request", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository, {
      evaluate: async () => ({
        allowed: false,
        reason: "policy_denied",
        evidence: { passed: false },
      }),
    });
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        grantId: "90000000-0000-4000-8000-000000000501",
        token: tokenValue,
        idempotencyKey: "governance-denied",
        executionLevel: "dry_run",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "PUBLICATION_GOVERNANCE_DENIED" } });
    expect(repository.publicationRequests).toHaveLength(0);
    expect(repository.governanceDecisions[0]).toMatchObject({
      allowed: false,
      reason: "policy_denied",
    });
  });

  it("hashes evidence, binds facts to it, and appends corrected content versions", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.body.csrfToken,
    };

    const evidenceResponse = await app.inject({
      method: "POST",
      url: "/api/evidence-sources",
      headers: writeHeaders,
      payload: {
        type: "manual",
        title: "Partner-confirmed hotline",
        content: "中通国际旅行社 24小时热线：4001133986",
        capturedAt: "2026-07-13T01:00:00.000Z",
        validUntil: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(evidenceResponse.statusCode).toBe(201);
    const evidence = evidenceResponse.json<{ id: string; contentHash: string }>();
    expect(evidence.contentHash).toBe(sha256Text("中通国际旅行社 24小时热线：4001133986"));
    expect(repository.evidenceSourceInputs[0]?.content).toContain("4001133986");
    expect(evidenceResponse.json()).not.toHaveProperty("content");

    const factResponse = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers: writeHeaders,
      payload: {
        brandId: ids.brand,
        normalizedKey: "contact.hotline",
        claim: "24小时热线为 4001133986",
        evidenceSourceIds: [evidence.id],
      },
    });
    expect(factResponse.statusCode).toBe(201);
    expect(repository.factInputs[0]?.evidenceSourceIds).toEqual([evidence.id]);

    const versionResponse = await app.inject({
      method: "POST",
      url: `/api/content/${ids.content}/versions`,
      headers: writeHeaders,
      payload: { payload: articlePayload },
    });
    expect(versionResponse.statusCode).toBe(201);
    expect(repository.contentVersionInputs[0]).toMatchObject({
      contentItemId: ids.content,
      payloadHash: sha256Canonical(articlePayload),
    });
  });

  it("reports connector capability as dry-run evidence instead of claiming live API support", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { cookie: authenticated.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          platform: "toutiao",
          capability: "manual_only",
          supportedExecutionLevels: ["dry_run"],
          evidenceType: "preview",
        },
      ],
    });
  });

  it("persists repeated Doubao/Qwen samples as explicitly fixture evidence", async () => {
    const repository = new FakeRepository();
    const app = await testApp(repository);
    const authenticated = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/visibility-runs",
      headers: {
        cookie: authenticated.cookie,
        "x-csrf-token": authenticated.body.csrfToken,
      },
      payload: {
        querySetVersionId: ids.version,
        provider: "qwen",
        sampleCount: 2,
        idempotencyKey: "qwen-fixture-two-samples",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "completed",
      provider: "qwen",
      providerMode: "fixture",
      evidenceType: "fixture",
      observationCount: 2,
      circuitOpened: false,
      wasCreated: true,
    });
    expect(repository.visibilityRuns).toHaveLength(1);
    expect(repository.visibilityRuns[0]?.observations).toHaveLength(2);
    expect(
      repository.visibilityRuns[0]?.observations.every((item) => item.evidenceType === "fixture"),
    ).toBe(true);
  });
});
