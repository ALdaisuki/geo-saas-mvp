import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATES,
  type ActorContext,
} from "@geo/contracts";
import {
  buildBaselineAuditPolicyDocument,
  compileAuditPolicy,
  renderEditorialSourcePayload,
  renderPlatformPublicationVariant,
  sha256Canonical,
} from "@geo/core";
import { describe, expect, it, vi } from "vitest";

import {
  GeoApiSessionRegistry,
  HttpInternalGeoApiClient,
  parseMcpPrincipalCredentials,
  validateGeoApiBaseUrl,
} from "./http-api-client.js";

const ids = {
  tenant: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  variant: "00000000-0000-4000-8000-000000000003",
  account: "00000000-0000-4000-8000-000000000004",
  artifact: "00000000-0000-4000-8000-000000000005",
  grant: "00000000-0000-4000-8000-000000000006",
  job: "00000000-0000-4000-8000-000000000007",
  outbox: "00000000-0000-4000-8000-000000000008",
  content: "00000000-0000-4000-8000-000000000009",
  version: "00000000-0000-4000-8000-000000000010",
  brand: "00000000-0000-4000-8000-000000000011",
  campaign: "00000000-0000-4000-8000-000000000012",
  fact: "00000000-0000-4000-8000-000000000013",
  source: "00000000-0000-4000-8000-000000000014",
  contact: "00000000-0000-4000-8000-000000000015",
  policy: "00000000-0000-4000-8000-000000000016",
  auditRun: "00000000-0000-4000-8000-000000000017",
  profile: "00000000-0000-4000-8000-000000000018",
};

const accessToken = "mcp-access-token-that-is-longer-than-thirty-two-bytes";
const grantToken = "publication-grant-token-that-never-enters-model-history";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe("GEO API session and destination policy", () => {
  it("rejects insecure remote API destinations and duplicate principal secrets", () => {
    expect(() => validateGeoApiBaseUrl("http://api.example.com")).toThrow(/HTTPS/);
    expect(() =>
      parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "one",
            email: "one@example.test",
            password: "password-one",
          },
          {
            accessToken,
            clientId: "two",
            email: "two@example.test",
            password: "password-two",
          },
        ]),
      ),
    ).toThrow(/unique/);
  });

  it("supplies discoverable brands, campaigns, and policy summaries in tenant context", async () => {
    const document = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-v1",
      industry: "travel",
    });
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "owner",
              capabilities: ["tenant:read", "content:read", "audit:read"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          { headers },
        );
      }
      if (url.pathname === "/api/tenant") {
        return jsonResponse({ id: ids.tenant, slug: "tenant", displayName: "Tenant" });
      }
      if (url.pathname === "/api/contacts") return jsonResponse({ items: [] });
      if (url.pathname === "/api/channel-accounts") return jsonResponse({ items: [] });
      if (url.pathname === "/api/capabilities") return jsonResponse({ items: [] });
      if (url.pathname === "/api/brand-agent-profiles") return jsonResponse({ items: [] });
      if (url.pathname === "/api/brands") {
        return jsonResponse({
          items: [
            {
              id: ids.brand,
              displayName: "中通国际旅行社",
              industry: "travel",
              isPrimary: true,
            },
          ],
        });
      }
      if (url.pathname === "/api/campaigns") {
        return jsonResponse({
          items: [
            {
              id: ids.campaign,
              brandId: ids.brand,
              name: "日本线路问答",
              objective: "回答可核验的行程问题",
              industry: "travel",
              status: "active",
              topicKey: "japan-faq",
            },
          ],
        });
      }
      if (url.pathname === "/api/policies") {
        return jsonResponse({
          items: [
            {
              id: ids.policy,
              version: document.rulesVersion,
              status: "active",
              policyHash: sha256Canonical(document),
              document,
              effectiveAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({ error: { code: "UNEXPECTED_TEST_ROUTE" } }, { status: 500 });
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "tenant-context-client",
            email: "owner@example.test",
            password: "test-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.authenticateBearer(`Bearer ${accessToken}`, "context-1"))
      .principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    await expect(api.getTenantContext(principal)).resolves.toMatchObject({
      brands: [{ id: ids.brand, displayName: "中通国际旅行社", isPrimary: true }],
      campaigns: [{ id: ids.campaign, brandId: ids.brand, status: "active" }],
      policies: [
        {
          id: ids.policy,
          version: "travel-v1",
          status: "active",
          policyHash: sha256Canonical(document),
        },
      ],
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/brands",
        "/api/campaigns",
        "/api/policies",
        "/api/brand-agent-profiles",
      ]),
    );
  });

  it("omits protected tenant context collections when the principal lacks their capabilities", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "viewer",
              capabilities: ["tenant:read"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          { headers },
        );
      }
      if (url.pathname === "/api/tenant") {
        return jsonResponse({ id: ids.tenant, slug: "tenant", displayName: "Tenant" });
      }
      if (url.pathname === "/api/contacts") return jsonResponse({ items: [] });
      if (url.pathname === "/api/channel-accounts") return jsonResponse({ items: [] });
      if (url.pathname === "/api/capabilities") return jsonResponse({ items: [] });
      if (url.pathname === "/api/brands") return jsonResponse({ items: [] });
      return jsonResponse({ error: { code: "PROTECTED_ROUTE_REQUESTED" } }, { status: 500 });
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "tenant-context-viewer",
            email: "viewer@example.test",
            password: "test-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.authenticateBearer(`Bearer ${accessToken}`, "context-2"))
      .principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    await expect(api.getTenantContext(principal)).resolves.toMatchObject({
      brandAgentProfiles: { items: [] },
      brands: [],
      campaigns: [],
      policies: [],
    });
    expect(paths).not.toContain("/api/brand-agent-profiles");
    expect(paths).not.toContain("/api/campaigns");
    expect(paths).not.toContain("/api/policies");
  });

  it("renders draft text only from the active policy, verified facts, and contacts", async () => {
    const document = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-v1",
      industry: "travel",
    });
    let contentBody: Record<string, unknown> | null = null;
    let automationBlocked = false;
    let contentRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "owner",
              capabilities: ["tenant:read", "content:write"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          { headers },
        );
      }
      if (url.pathname === "/api/facts") {
        return jsonResponse({
          items: [
            {
              id: ids.fact,
              brandId: ids.brand,
              normalizedKey: "travel.service.boundary",
              claim: "最终服务范围以签约前确认材料为准",
              status: "verified",
              evidenceSourceIds: [ids.source],
              validFrom: "2026-01-01T00:00:00.000Z",
              validUntil: "2027-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/article-templates") {
        return jsonResponse({
          version: ARTICLE_TEMPLATE_CATALOG_VERSION,
          items: ARTICLE_TEMPLATES,
        });
      }
      if (url.pathname === `/api/brands/${ids.brand}/agent-profile`) {
        const profileDocument = {
          schemaVersion: "geo.brand-agent-profile.v1",
          voice: "克制、清晰、先回答再解释",
          audiences: ["首次出境游客"],
          objectives: ["帮助客户核验服务边界"],
          requiredPoints: ["说明信息有效期"],
          forbiddenClaims: ["保证签证通过"],
          callToAction: "通过官方热线核验当前行程。",
          agentInstructions: "优先选择有完整事实和证据支持的文章策略。",
        } as const;
        return jsonResponse({
          id: ids.profile,
          brandId: ids.brand,
          version: 2,
          status: "active",
          document: profileDocument,
          documentHash: sha256Canonical(profileDocument),
          effectiveAt: "2026-07-15T12:00:00.000Z",
          retiredAt: null,
          createdAt: "2026-07-15T12:00:00.000Z",
        });
      }
      if (url.pathname === "/api/automation") {
        return jsonResponse({
          control: {
            mode: "shadow",
            killSwitchEnabled: automationBlocked,
          },
          circuits: [],
        });
      }
      if (url.pathname === "/api/contacts") {
        return jsonResponse({
          items: [
            {
              id: ids.contact,
              tenantId: ids.tenant,
              type: "phone",
              label: "24小时热线",
              value: "4001133986",
              isPrimary: true,
              validFrom: "2026-01-01T00:00:00.000Z",
              validUntil: null,
            },
          ],
        });
      }
      if (url.pathname === "/api/policies") {
        return jsonResponse({
          items: [
            {
              id: ids.policy,
              version: document.rulesVersion,
              status: "active",
              policyHash: sha256Canonical(document),
              document,
              effectiveAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/content") {
        contentRequests += 1;
        contentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: ids.content, latestVersionId: ids.version, latestVersion: 1 });
      }
      return jsonResponse({ error: { code: "UNEXPECTED_TEST_ROUTE" } }, { status: 500 });
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "canonical-draft-client",
            email: "owner@example.test",
            password: "test-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.authenticateBearer(`Bearer ${accessToken}`, "draft-1"))
      .principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    await expect(api.getArticleTemplateCatalog(principal)).resolves.toMatchObject({
      version: ARTICLE_TEMPLATE_CATALOG_VERSION,
      items: expect.arrayContaining([expect.objectContaining({ id: "comparison-matrix" })]),
    });

    await expect(
      api.proposeDraft(principal, {
        brandId: ids.brand,
        campaignId: ids.campaign,
        brief: "travel risk and service boundary",
        articleTemplateId: "comparison-matrix",
        idempotencyKey: "draft-once",
        fixtureMode: true,
      }),
    ).resolves.toMatchObject({ providerMode: "fixture", contentVersionId: ids.version });

    const recordedBody: unknown = contentBody;
    if (
      typeof recordedBody !== "object" ||
      recordedBody === null ||
      !("payload" in recordedBody) ||
      typeof recordedBody.payload !== "object" ||
      recordedBody.payload === null
    ) {
      throw new Error("Canonical content request was not captured");
    }
    const contentRequest = recordedBody as Record<string, unknown>;
    const payload = contentRequest.payload as Record<string, unknown>;
    expect(contentRequest).toMatchObject({
      idempotencyKey: "draft-once",
      contentType: "comparison",
      topicKey: expect.stringMatching(/^agent:[a-f0-9]{32}$/u),
    });
    expect(contentRequest.topicKey).not.toBe(`agent:${ids.campaign}`);
    expect(payload).toMatchObject({
      editorialProfile: "comparison",
      articleTemplateId: "comparison-matrix",
      brandAgentProfile: {
        id: ids.profile,
        version: 2,
        documentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      titleBlocks: [{ type: "template", templateId: "editorial.comparison.title" }],
      claims: [{ id: ids.fact, text: "最终服务范围以签约前确认材料为准" }],
      contactIds: [ids.contact],
      media: [],
    });
    expect(JSON.stringify(payload.bodyBlocks)).not.toContain('"text"');
    expect(String(payload.bodyMarkdown)).toContain("4001133986");
    expect(String(payload.bodyMarkdown)).toContain("最终服务范围以签约前确认材料为准");

    await expect(
      api.proposeDraft(principal, {
        brandId: ids.brand,
        campaignId: ids.campaign,
        brief: "travel risk and service boundary",
        articleTemplateId: "invented-template",
        idempotencyKey: "invalid-template",
      }),
    ).rejects.toMatchObject({ code: "ARTICLE_TEMPLATE_UNKNOWN", status: 400 });
    expect(contentRequests).toBe(1);

    automationBlocked = true;
    await expect(
      api.proposeDraft(principal, {
        brandId: ids.brand,
        campaignId: ids.campaign,
        brief: "another travel risk draft",
        idempotencyKey: "blocked-draft",
        fixtureMode: true,
      }),
    ).rejects.toMatchObject({
      code: "AUTOMATION_GENERATION_BLOCKED",
      status: 409,
    });
    expect(contentRequests).toBe(1);
  });

  it("keeps publication grant credentials internal and consumes them once", async () => {
    const document = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-v1",
      industry: "travel",
    });
    const policy = compileAuditPolicy({
      version: document.rulesVersion,
      policyHash: sha256Canonical(document),
      document,
    });
    const factSnapshot = {
      tenantId: ids.tenant,
      capturedAt: "2026-07-14T00:00:00.000Z",
      facts: [],
      sources: [],
    };
    const sourcePayload = renderEditorialSourcePayload({
      editorialProfile: "guide",
      policy,
      factSnapshot,
      contacts: [],
    });
    const serverRenderedPayload = renderPlatformPublicationVariant({
      sourcePayload,
      platform: "toutiao",
      policy,
      factSnapshot,
      contacts: [],
    });
    let publicationBody: unknown;
    let publicationRequestCount = 0;
    let auditRequestCount = 0;
    const replayBodies: unknown[] = [];
    let variantBody: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "owner",
              capabilities: ["tenant:read", "audit:run", "publish:request"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          },
          { headers },
        );
      }
      if (url.pathname === `/api/variants/${ids.variant}/audits`) {
        auditRequestCount += 1;
        return jsonResponse({
          auditRunId: ids.auditRun,
          artifact: {
            id: ids.artifact,
            status: "passed",
            channelAccountId: ids.account,
            findings: [],
          },
          publicationAuthorization:
            auditRequestCount === 1
              ? {
                  grantId: ids.grant,
                  token: grantToken,
                  expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
                }
              : null,
        });
      }
      if (url.pathname === `/api/content-versions/${ids.version}`) {
        return jsonResponse({
          id: ids.version,
          contentItemId: ids.content,
          payload: sourcePayload,
        });
      }
      if (url.pathname === "/api/channel-accounts") {
        return jsonResponse({
          items: [
            {
              id: ids.account,
              platform: "toutiao",
              supportedExecutionLevels: ["dry_run"],
              status: "active",
            },
          ],
        });
      }
      if (url.pathname === `/api/content/${ids.content}/variants`) {
        variantBody = JSON.parse(String(init?.body));
        return jsonResponse({
          id: ids.variant,
          contentVersionId: ids.version,
          channelAccountId: ids.account,
          platform: "toutiao",
          variantVersion: 1,
          payload: serverRenderedPayload,
          payloadHash: "a".repeat(64),
          state: "draft",
          frozenAt: null,
        });
      }
      if (url.pathname === "/api/publication-requests") {
        publicationRequestCount += 1;
        publicationBody = JSON.parse(String(init?.body));
        return jsonResponse({
          publicationJobId: ids.job,
          publicationOutboxEventId: ids.outbox,
          wasCreated: true,
        });
      }
      if (url.pathname === "/api/publication-replays/resolve") {
        const body = JSON.parse(String(init?.body)) as { idempotencyKey?: string };
        replayBodies.push(body);
        return jsonResponse({
          publication:
            publicationRequestCount === 1 && body.idempotencyKey === "publish-once"
              ? {
                  publicationJobId: ids.job,
                  publicationOutboxEventId: ids.outbox,
                  wasCreated: false,
                }
              : null,
        });
      }
      return jsonResponse({ error: { code: "UNEXPECTED_TEST_ROUTE" } }, { status: 500 });
    });
    const credentials = parseMcpPrincipalCredentials(
      JSON.stringify([
        {
          accessToken,
          clientId: "test-client",
          email: "owner@example.test",
          password: "test-password",
        },
      ]),
    );
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials,
      fetchImpl,
    });
    const authenticated = await sessions.authenticateBearer(`Bearer ${accessToken}`, "request-1");
    const principal: ActorContext = authenticated.principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    const preview = await api.previewVariant(principal, {
      contentVersionId: ids.version,
      channelAccountId: ids.account,
      platform: "toutiao",
    });
    expect(preview).toMatchObject({
      id: ids.variant,
      variantId: ids.variant,
      payload: {
        titleBlocks: [{ type: "template", templateId: "toutiao.guide.title" }],
      },
    });
    expect(variantBody).toEqual({
      contentVersionId: ids.version,
      channelAccountId: ids.account,
    });
    expect(variantBody).not.toHaveProperty("payload");

    const audit = await api.requestAudit(principal, {
      variantId: ids.variant,
      idempotencyKey: "audit-once",
    });
    expect(JSON.stringify(audit)).not.toContain(grantToken);
    expect(audit).toMatchObject({ eligibleForPublicationRequest: true });
    expect(audit).toMatchObject({
      auditRunId: ids.auditRun,
      auditArtifactId: ids.artifact,
    });

    const publication = await api.requestPublication(principal, {
      variantId: ids.variant,
      channelAccountId: ids.account,
      executionLevel: "dry_run",
      idempotencyKey: "publish-once",
    });
    expect(publication).toMatchObject({ publicationJobId: ids.job, wasCreated: true });
    expect(publicationBody).toMatchObject({ grantId: ids.grant, token: grantToken });
    expect(publicationRequestCount).toBe(1);

    const replayAudit = await api.requestAudit(principal, {
      variantId: ids.variant,
      idempotencyKey: "audit-once",
    });
    expect(replayAudit).toMatchObject({
      auditArtifactId: ids.artifact,
      status: "passed",
      eligibleForPublicationRequest: false,
    });
    expect(JSON.stringify(replayAudit)).not.toContain(grantToken);

    const replay = await api.requestPublication(principal, {
      variantId: ids.variant,
      channelAccountId: ids.account,
      executionLevel: "dry_run",
      idempotencyKey: "publish-once",
    });
    expect(replay).toEqual({
      publicationRequestId: ids.job,
      publicationJobId: ids.job,
      outboxEventId: ids.outbox,
      wasCreated: false,
    });
    expect(publicationRequestCount).toBe(1);
    expect(replayBodies).toContainEqual({
      idempotencyKey: "publish-once",
      variantId: ids.variant,
      auditArtifactId: ids.artifact,
      channelAccountId: ids.account,
      executionLevel: "dry_run",
    });
    expect(JSON.stringify(replayBodies)).not.toMatch(/grant|token/iu);

    await expect(
      api.requestPublication(principal, {
        variantId: ids.variant,
        channelAccountId: ids.account,
        executionLevel: "dry_run",
        idempotencyKey: "publish-twice",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_GRANT_NOT_AVAILABLE" });
  });

  it("maps bounded media operations without exposing prompt or provider controls", async () => {
    let mediaBody: unknown;
    const scopeBodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "owner",
              capabilities: ["tenant:read", "content:read", "content:write"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
          { headers },
        );
      }
      if (url.pathname === `/api/content-versions/${ids.version}/media-jobs`) {
        mediaBody = JSON.parse(String(init?.body));
        return jsonResponse({ job: { id: ids.job, state: "succeeded" }, wasCreated: true });
      }
      if (url.pathname === `/api/media-jobs/${ids.job}`) {
        return jsonResponse({ job: { id: ids.job, state: "succeeded" } });
      }
      if (url.pathname === "/api/resource-scope-check") {
        scopeBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ allowed: true, denied: [] });
      }
      return jsonResponse({ error: { code: "UNEXPECTED_TEST_ROUTE" } }, { status: 500 });
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "media-client",
            email: "owner@example.test",
            password: "test-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.authenticateBearer(`Bearer ${accessToken}`, "media-1"))
      .principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    await expect(
      api.requestMediaProduction(principal, {
        contentVersionId: ids.version,
        platform: "toutiao",
        role: "cover",
        claimIds: [ids.fact],
        idempotencyKey: "media-1",
      }),
    ).resolves.toMatchObject({ job: { id: ids.job, state: "succeeded" } });
    await expect(api.getMediaJobStatus(principal, { mediaJobId: ids.job })).resolves.toMatchObject({
      job: { id: ids.job, state: "succeeded" },
    });
    await expect(
      api.authorizeResourceScope(principal, "geo_media_production_request", {
        contentVersionId: ids.version,
      }),
    ).resolves.toBe(true);
    await expect(
      api.authorizeResourceScope(principal, "geo_media_job_status", { mediaJobId: ids.job }),
    ).resolves.toBe(true);

    expect(mediaBody).toEqual({
      platform: "toutiao",
      role: "cover",
      claimIds: [ids.fact],
      idempotencyKey: "media-1",
    });
    expect(JSON.stringify(mediaBody)).not.toMatch(/prompt|provider|url|storage|credential/iu);
    expect(scopeBodies).toEqual([
      { resources: [{ kind: "content_version", id: ids.version }] },
      { resources: [{ kind: "media_job", id: ids.job }] },
    ]);
  });
});
