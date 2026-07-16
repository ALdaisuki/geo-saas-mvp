import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTICLE_TEMPLATE_CATALOG_VERSION, ARTICLE_TEMPLATES } from "@geo/contracts";

import { GeoApiError, HttpGeoApi } from "./api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const loginBody = {
  actor: {
    id: "10000000-0000-4000-8000-000000000101",
    displayName: "测试运营员",
    role: "owner",
    capabilities: ["tenant:read"],
  },
  tenant: {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "zhongtong-international-travel",
    displayName: "中通国际旅行社",
  },
  csrfToken: "csrf-token-from-api",
  expiresAt: "2026-07-14T16:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpGeoApi", () => {
  it("reads and writes strictly parsed Brand Agent Profile versions", async () => {
    const brandId = "10000000-0000-4000-8000-000000000301";
    const document = {
      schemaVersion: "geo.brand-agent-profile.v1" as const,
      voice: "直接回答，证据优先",
      audiences: ["需要核验旅行服务的客户"],
      objectives: ["解释已验证事实与下一步"],
      requiredPoints: ["事实有效期"],
      forbiddenClaims: ["无证据保证"],
      callToAction: "通过官方渠道核验。",
      agentInstructions: "只使用当前租户证据。",
    };
    const profile = {
      id: "10000000-0000-4000-8000-000000000302",
      brandId,
      version: 1,
      status: "active",
      document,
      documentHash: "6".repeat(64),
      effectiveAt: "2026-07-14T08:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-14T08:00:00.000Z",
    };
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({ items: [profile] }),
      jsonResponse({ ...profile, version: 2, documentHash: "7".repeat(64) }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({
      email: "owner@example.test",
      password: "correct-password",
      tenantSlug: "zhongtong-international-travel",
    });
    await expect(api.getBrandAgentProfiles()).resolves.toEqual([profile]);
    await expect(
      api.createBrandAgentProfile(brandId, { document, reason: "收紧品牌表达边界" }),
    ).resolves.toMatchObject({ version: 2, documentHash: "7".repeat(64) });

    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/brand-agent-profiles",
      `/api/brands/${brandId}/agent-profile`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      document,
      reason: "收紧品牌表达边界",
    });
  });

  it("rejects malformed Brand Agent Profile GET and POST responses", async () => {
    const malformed = {
      id: "10000000-0000-4000-8000-000000000302",
      brandId: "10000000-0000-4000-8000-000000000301",
      version: 0,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v2",
        voice: "invalid",
        audiences: [],
        objectives: [],
        requiredPoints: [],
        forbiddenClaims: [],
        callToAction: "invalid",
        agentInstructions: "invalid",
      },
      documentHash: "not-a-hash",
      effectiveAt: "2026-07-14T08:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-14T08:00:00.000Z",
    };
    const getApi = new HttpGeoApi("", async () => jsonResponse({ items: [malformed] }));
    await expect(getApi.getBrandAgentProfiles()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });

    const responses = [jsonResponse(loginBody), jsonResponse(malformed)];
    const postApi = new HttpGeoApi("", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    await postApi.login({ email: "owner@example.test", password: "correct-password" });
    await expect(
      postApi.createBrandAgentProfile(malformed.brandId, {
        document: {
          schemaVersion: "geo.brand-agent-profile.v1",
          voice: "valid",
          audiences: ["客户"],
          objectives: ["核验"],
          requiredPoints: [],
          forbiddenClaims: [],
          callToAction: "核验。",
          agentInstructions: "使用证据。",
        },
        reason: "test parser",
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it("accepts only the versioned, unique 20-plus article template catalog", async () => {
    const requests: string[] = [];
    const api = new HttpGeoApi("", async (input) => {
      requests.push(String(input));
      return jsonResponse({
        version: ARTICLE_TEMPLATE_CATALOG_VERSION,
        items: ARTICLE_TEMPLATES,
      });
    });

    await expect(api.getArticleTemplates()).resolves.toMatchObject({
      version: ARTICLE_TEMPLATE_CATALOG_VERSION,
      items: expect.arrayContaining([expect.objectContaining({ id: "comparison-matrix" })]),
    });
    expect(requests).toEqual(["/api/article-templates"]);

    const duplicateApi = new HttpGeoApi("", async () =>
      jsonResponse({
        version: ARTICLE_TEMPLATE_CATALOG_VERSION,
        items: Array.from({ length: 20 }, () => ARTICLE_TEMPLATES[0]),
      }),
    );
    await expect(duplicateApi.getArticleTemplates()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });

    const incompatibleApi = new HttpGeoApi("", async () =>
      jsonResponse({ version: "geo.article-templates.v2", items: ARTICLE_TEMPLATES }),
    );
    await expect(incompatibleApi.getArticleTemplates()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("reads agent capability and submits a CSRF-protected governed run", async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const runInput = {
      brandId: "10000000-0000-4000-8000-000000000301",
      campaignId: "10000000-0000-4000-8000-000000000302",
      channelAccountId: "10000000-0000-4000-8000-000000000303",
      platform: "toutiao" as const,
      topic: "日本线路证据核验",
      articleTemplateId: "step-by-step-guide",
      idempotencyKey: "web-agent-run-1",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        available: true,
        mode: "fixture",
        provider: "fixture",
        model: "fixture-geo-writer-v1",
      }),
      jsonResponse({
        capability: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
        result: {
          providerMode: "fixture",
          contentItemId: "10000000-0000-4000-8000-000000000401",
          contentVersionId: "10000000-0000-4000-8000-000000000402",
          variantId: "10000000-0000-4000-8000-000000000403",
          auditRunId: "10000000-0000-4000-8000-000000000404",
          auditArtifactId: "10000000-0000-4000-8000-000000000405",
          publicationRequestId: "10000000-0000-4000-8000-000000000406",
          publicationJobId: "10000000-0000-4000-8000-000000000407",
          outboxEventId: "10000000-0000-4000-8000-000000000408",
          steps: ["geo_tenant_context", "geo_draft_proposal", "geo_audit_request"],
        },
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    await expect(api.getAgentCapability()).resolves.toMatchObject({
      available: true,
      mode: "fixture",
    });
    await expect(api.runAgent(runInput)).resolves.toMatchObject({
      result: { providerMode: "fixture", steps: expect.arrayContaining(["geo_audit_request"]) },
    });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/agent/capability",
      "/api/agent/runs",
    ]);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual(runInput);
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[2]?.init?.headers).has("authorization")).toBe(false);
  });

  it("rejects mismatched agent capability and result modes", async () => {
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        capability: { mode: "pi", provider: "openai", model: "gpt-5" },
        result: { providerMode: "fixture" },
      }),
    ];
    const api = new HttpGeoApi("", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    await api.login({ email: "owner@example.test", password: "correct-password" });
    await expect(
      api.runAgent({
        brandId: "10000000-0000-4000-8000-000000000301",
        campaignId: "10000000-0000-4000-8000-000000000302",
        channelAccountId: "10000000-0000-4000-8000-000000000303",
        platform: "toutiao",
        topic: "topic",
        articleTemplateId: "step-by-step-guide",
        idempotencyKey: "run-mode-mismatch",
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it("preserves the native fetch receiver when no test transport is injected", async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(jsonResponse(loginBody));
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await new HttpGeoApi().login({
      email: "owner@example.test",
      password: "correct-password",
      tenantSlug: "zhongtong-international-travel",
    });

    expect(session.tenant.slug).toBe("zhongtong-international-travel");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses cookie credentials and forwards the login CSRF token on writes", async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    const responses = [jsonResponse(loginBody), new Response(null, { status: 204 })];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    const session = await api.login({
      email: "owner@example.test",
      password: "correct-password",
      tenantSlug: "zhongtong-international-travel",
    });
    await api.logout();

    expect(session.tenant.displayName).toBe("中通国际旅行社");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      email: "owner@example.test",
      tenantSlug: "zhongtong-international-travel",
    });
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("preserves the tenant choices returned by TENANT_SELECTION_REQUIRED", async () => {
    const api = new HttpGeoApi("", async () =>
      jsonResponse(
        {
          error: {
            code: "TENANT_SELECTION_REQUIRED",
            message: "Select an active tenant",
            requestId: "req-tenant-list",
            details: {
              tenants: [
                { slug: "zhongtong", displayName: "中通国际旅行社" },
                { slug: "isolation", displayName: "隔离测试旅行社" },
              ],
            },
          },
        },
        409,
      ),
    );

    let failure: unknown;
    try {
      await api.login({ email: "owner@example.test", password: "correct-password" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GeoApiError);
    expect(failure).toMatchObject({
      code: "TENANT_SELECTION_REQUIRED",
      requestId: "req-tenant-list",
      details: { tenants: [{ slug: "zhongtong" }, { slug: "isolation" }] },
    });
  });

  it("parses visibility rows by full evidence dimension and excludes fixture by default URL", async () => {
    const inputs: string[] = [];
    const api = new HttpGeoApi("", async (input) => {
      inputs.push(String(input));
      return jsonResponse({
        items: [
          {
            provider: "qwen",
            productSurface: "web-search",
            model: "qwen-search-v2",
            searchMode: "on",
            observationMethod: "manual",
            evidenceType: "manual_import",
            observations: 8,
            brandMentionRate: 0.375,
            contactAccuracy: 1,
            averageAnswerPosition: 12.5,
            competitorMentionRate: 0.25,
            negativeSentimentRate: 0.125,
            hallucinationFindings: 1,
            harmfulErrors: 0,
          },
        ],
      });
    });

    const rows = await api.getVisibilitySummary();

    expect(inputs).toEqual(["/api/visibility/summary"]);
    expect(rows[0]).toMatchObject({
      provider: "qwen",
      productSurface: "web-search",
      model: "qwen-search-v2",
      observationMethod: "manual",
      evidenceType: "manual_import",
    });
  });

  it("runs and reads fixture/manual visibility evidence through tenant-scoped endpoints", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const runId = "10000000-0000-4000-8000-000000001501";
    const querySetVersionId = "10000000-0000-4000-8000-000000000902";
    const run = {
      id: runId,
      querySetVersionId,
      provider: "doubao",
      productSurface: "doubao-web-search",
      model: "manual-observed-unknown",
      searchMode: "on",
      observationMethod: "manual",
      status: "completed",
      locale: "zh-CN",
      geo: "CN",
      startedAt: "2026-07-14T08:00:00.000Z",
      completedAt: "2026-07-14T08:00:01.000Z",
      errorMessage: null,
      observationCount: 1,
      createdAt: "2026-07-14T08:00:00.000Z",
    };
    const observation = {
      id: "10000000-0000-4000-8000-000000001502",
      tenantId: loginBody.tenant.id,
      runId,
      provider: "doubao",
      productSurface: run.productSurface,
      model: run.model,
      searchMode: "on",
      observationMethod: "manual",
      prompt: "中通国际旅行社电话是多少",
      promptVersion: "1",
      locale: "zh-CN",
      geo: "CN",
      rawAnswer: "24小时热线为 4001133986。",
      citedUrls: ["https://example.test/contact"],
      evidenceHash: "f".repeat(64),
      evidenceType: "manual_import",
      requestStartedAt: "2026-07-14T07:59:59.000Z",
      responseReceivedAt: "2026-07-14T08:00:00.000Z",
      observedAt: "2026-07-14T08:00:00.000Z",
      brandMentioned: true,
      answerPosition: 1,
      contactAccuracy: 1,
      competitorMentions: ["示例旅行社"],
      sentiment: "neutral",
      hallucinationFindings: [],
      harmfulError: false,
      extractorVersion: "visibility-v1",
      evaluatorVersion: "geo-visibility-evaluator-v1",
      metadata: { importedBy: "operator" },
      createdAt: "2026-07-14T08:00:01.000Z",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({ items: [run] }),
      jsonResponse({
        run,
        observations: [observation],
        metrics: [
          {
            name: "contact_accuracy",
            value: 1,
            sampleCount: 1,
            confidenceLow: null,
            confidenceHigh: null,
            dimensions: { provider: "doubao" },
            createdAt: "2026-07-14T08:00:01.000Z",
          },
        ],
      }),
      jsonResponse(
        {
          visibilityRunId: runId,
          status: "completed",
          providerMode: "fixture",
          evidenceType: "fixture",
          wasCreated: true,
        },
        201,
      ),
      jsonResponse(
        {
          visibilityRunId: runId,
          status: "completed",
          providerMode: "manual",
          evidenceType: "manual_import",
          wasCreated: true,
        },
        201,
      ),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const runs = await api.getVisibilityRuns();
    const detail = await api.getVisibilityRun(runId);
    await api.runFixtureVisibility({
      querySetVersionId,
      provider: "doubao",
      sampleCount: 2,
      idempotencyKey: "visibility-fixture-once",
    });
    await api.importVisibility({
      querySetVersionId,
      provider: "doubao",
      productSurface: run.productSurface,
      model: run.model,
      searchMode: "on",
      locale: "zh-CN",
      geo: "CN",
      idempotencyKey: "visibility-manual-once",
      samples: [
        {
          queryKey: "brand-phone",
          rawAnswer: observation.rawAnswer,
          citedUrls: observation.citedUrls,
          requestStartedAt: observation.requestStartedAt,
          responseReceivedAt: observation.responseReceivedAt,
          observedAt: observation.observedAt,
        },
      ],
    });

    expect(runs[0]).toMatchObject({ observationMethod: "manual", observationCount: 1 });
    expect(detail.observations[0]).toMatchObject({
      rawAnswer: observation.rawAnswer,
      citedUrls: observation.citedUrls,
      competitorMentions: ["示例旅行社"],
      contactAccuracy: 1,
      requestStartedAt: observation.requestStartedAt,
      responseReceivedAt: observation.responseReceivedAt,
      sentiment: "neutral",
      evaluatorVersion: "geo-visibility-evaluator-v1",
    });
    expect(detail.metrics[0]).toMatchObject({ name: "contact_accuracy", value: 1 });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/visibility-runs",
      `/api/visibility-runs/${runId}`,
      "/api/visibility-runs",
      "/api/visibility-runs/import",
    ]);
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({
      provider: "doubao",
      sampleCount: 2,
    });
    expect(JSON.parse(String(calls[4]?.init?.body))).toMatchObject({
      provider: "doubao",
      samples: [{ queryKey: "brand-phone", citedUrls: observation.citedUrls }],
    });
    expect(new Headers(calls[3]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[4]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("reports malformed successful responses instead of treating them as empty data", async () => {
    const api = new HttpGeoApi("", async () => jsonResponse({ unexpected: [] }));

    await expect(api.getCampaigns()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("transitions a Campaign only through the governed state endpoint", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const campaignId = "10000000-0000-4000-8000-000000001001";
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        campaign: {
          id: campaignId,
          brandId: "10000000-0000-4000-8000-000000000301",
          name: "日本线路问答",
          objective: "生成经审计的旅行问答",
          industry: "travel",
          status: "active",
          topicKey: "japan-travel",
        },
        previousStatus: "draft",
        wasChanged: true,
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const result = await api.transitionCampaignState(campaignId, {
      status: "active",
      reason: "核验事实与平台账号已就绪",
    });

    expect(result).toMatchObject({
      campaign: { id: campaignId, status: "active" },
      previousStatus: "draft",
      wasChanged: true,
    });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      `/api/campaigns/${campaignId}/state`,
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      status: "active",
      reason: "核验事实与平台账号已就绪",
    });
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("sends only binding IDs when requesting a server-rendered platform variant", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const contentId = "10000000-0000-4000-8000-000000000601";
    const contentVersionId = "10000000-0000-4000-8000-000000000611";
    const channelAccountId = "10000000-0000-4000-8000-000000000701";
    const generatedPayload = {
      title: "Evidence-first service guide",
      summary: "A server-rendered platform summary.",
      bodyMarkdown: "## Verified scope\n\nOnly verified facts are included.",
      titleBlocks: [{ type: "template", templateId: "toutiao.title.evidence-first" }],
      summaryBlocks: [{ type: "template", templateId: "toutiao.summary.evidence-first" }],
      bodyBlocks: [{ type: "template", templateId: "toutiao.body.opening" }],
      tagTemplateIds: ["toutiao.tag.evidence"],
      media: [],
      claims: [],
      contactIds: [],
      tags: ["verified"],
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        id: "10000000-0000-4000-8000-000000000621",
        contentVersionId,
        channelAccountId,
        platform: "toutiao",
        variantVersion: 1,
        payload: generatedPayload,
        payloadHash: "a".repeat(64),
        state: "draft",
        frozenAt: null,
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const variant = await api.createContentVariant(contentId, {
      contentVersionId,
      channelAccountId,
    });

    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      `/api/content/${contentId}/variants`,
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      contentVersionId,
      channelAccountId,
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).not.toHaveProperty("payload");
    expect(variant.payload).toEqual(generatedPayload);
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("exports an audited manual package with CSRF without claiming publication", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const artifactId = "10000000-0000-4000-8000-000000000801";
    const responseBody = {
      schemaVersion: "geo.manual-publication-package.v1",
      evidenceType: "preview",
      platform: "toutiao",
      tenantId: loginBody.tenant.id,
      channelAccountId: "10000000-0000-4000-8000-000000000701",
      variantId: "10000000-0000-4000-8000-000000000601",
      executionLevel: "dry_run",
      auditArtifactId: artifactId,
      payloadHash: "a".repeat(64),
      auditHash: "b".repeat(64),
      previewHash: "c".repeat(64),
      requiresManualAction: true,
      publicationStatus: "not_published",
      confirmed: false,
      exportedAt: "2026-07-14T12:00:00.000Z",
      files: {
        "NOT_PUBLISHED.txt": "NOT PUBLISHED",
        "article.md": "Audited article",
        "manifest.json": "{}",
      },
      packageHash: "d".repeat(64),
    };
    const responses = [jsonResponse(loginBody), jsonResponse(responseBody)];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const result = await api.exportManualPublicationPackage(artifactId);

    expect(result).toMatchObject({
      auditArtifactId: artifactId,
      executionLevel: "dry_run",
      requiresManualAction: true,
      publicationStatus: "not_published",
      confirmed: false,
    });
    expect(calls[1]).toMatchObject({
      input: `/api/audits/${artifactId}/manual-publication-package`,
      init: { method: "POST" },
    });
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("keeps a non-JSON proxy failure as an explicit HTTP error", async () => {
    const api = new HttpGeoApi("", async () => new Response("Bad Gateway", { status: 502 }));

    await expect(api.getSession()).rejects.toMatchObject({
      status: 502,
      code: "HTTP_502",
    });
  });

  it("uses governed tenant-switch and automation endpoints with CSRF", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const automationControl = {
      mode: "shadow",
      killSwitchEnabled: false,
      reason: "initial",
      quota: { dryRunOnly: true },
      updatedAt: "2026-07-14T08:00:00.000Z",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        items: [
          {
            id: loginBody.tenant.id,
            slug: loginBody.tenant.slug,
            displayName: loginBody.tenant.displayName,
            role: "owner",
            status: "active",
          },
        ],
      }),
      jsonResponse(loginBody),
      jsonResponse({ control: automationControl, circuits: [] }),
      jsonResponse({
        control: {
          ...automationControl,
          mode: "unattended",
          quota: {
            maxConcurrent: 2,
            perMinute: 8,
            perDay: 80,
            cooldownSeconds: 15,
            errorBudget: 4,
          },
        },
      }),
      jsonResponse({
        control: {
          id: "10000000-0000-4000-8000-000000000952",
          scopeType: "platform",
          scopeKey: "toutiao",
          ...automationControl,
          mode: "paused",
        },
      }),
      jsonResponse({
        circuit: {
          id: "10000000-0000-4000-8000-000000000953",
          scopeType: "platform",
          scopeKey: "toutiao",
          state: "open",
          failureCount: 1,
          openedAt: "2026-07-14T08:01:00.000Z",
          retryAt: null,
          reason: "manual incident",
          updatedAt: "2026-07-14T08:01:00.000Z",
        },
      }),
      jsonResponse({ control: { ...automationControl, killSwitchEnabled: true } }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const tenants = await api.getTenants();
    await api.switchTenant(loginBody.tenant.slug);
    const automation = await api.getAutomation();
    const configured = await api.setAutomationControl({
      mode: "unattended",
      quota: {
        maxConcurrent: 2,
        perMinute: 8,
        perDay: 80,
        cooldownSeconds: 15,
        errorBudget: 4,
      },
      reason: "operator-approved Dry-run",
    });
    const scoped = await api.setScopedAutomationControl("platform", "toutiao", {
      mode: "paused",
      quota: {
        maxConcurrent: 1,
        perMinute: 2,
        perDay: 20,
        cooldownSeconds: 30,
        errorBudget: 2,
      },
      killSwitchEnabled: true,
      reason: "platform review",
    });
    const circuit = await api.setCircuitBreakerState("platform", "toutiao", {
      targetState: "open",
      reason: "manual incident",
    });
    const updated = await api.setKillSwitch({ enabled: true, reason: "contact anomaly" });

    expect(tenants[0]).toMatchObject({ status: "active", role: "owner" });
    expect(automation.control.killSwitchEnabled).toBe(false);
    expect(configured.mode).toBe("unattended");
    expect(scoped).toMatchObject({ scopeType: "platform", scopeKey: "toutiao", mode: "paused" });
    expect(circuit).toMatchObject({ scopeType: "platform", state: "open" });
    expect(updated.killSwitchEnabled).toBe(true);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/auth/tenants",
      "/api/auth/switch-tenant",
      "/api/automation",
      "/api/automation/control",
      "/api/automation/controls/platform/toutiao",
      "/api/automation/circuits/platform/toutiao/state",
      "/api/automation/kill-switch",
    ]);
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[4]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[5]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[6]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[7]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("manages immutable query-set versions and lifecycle with CSRF", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const querySetId = "10000000-0000-4000-8000-000000000901";
    const versionId = "10000000-0000-4000-8000-000000000902";
    const querySet = {
      id: querySetId,
      name: "Domestic AI discovery",
      industry: "travel",
      status: "draft",
      currentVersion: 1,
      description: "Provider-neutral prompts",
      currentVersionId: versionId,
      prompts: [{ key: "contact", category: "contact", prompt: "中通联系方式" }],
      promptHash: "d".repeat(64),
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
    };
    const version = {
      id: versionId,
      querySetId,
      version: 1,
      prompts: querySet.prompts,
      promptHash: querySet.promptHash,
      createdByActorId: loginBody.actor.id,
      createdAt: querySet.createdAt,
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse(querySet, 201),
      jsonResponse({ items: [version] }),
      jsonResponse({ ...version, id: `${versionId.slice(0, -1)}3`, version: 2 }, 201),
      jsonResponse({
        querySet: { ...querySet, status: "active", currentVersion: 2 },
        previousVersion: 1,
        previousStatus: "draft",
        wasChanged: true,
      }),
      jsonResponse({
        querySet: { ...querySet, status: "retired" },
        previousStatus: "active",
        wasChanged: true,
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    await api.login({ email: "owner@example.test", password: "correct-password" });
    const createdSet = await api.createQuerySet({
      name: querySet.name,
      industry: querySet.industry,
      description: querySet.description,
      prompts: querySet.prompts,
    });
    const versions = await api.getQuerySetVersions(querySetId);
    const createdVersion = await api.createQuerySetVersion(querySetId, {
      prompts: querySet.prompts,
      reason: "reviewed prompt update",
    });
    const activated = await api.activateQuerySetVersion(
      querySetId,
      createdVersion.id,
      "activate reviewed version",
    );
    const retired = await api.transitionQuerySet(querySetId, "retired", "replace old pack");

    expect(createdSet.status).toBe("draft");
    expect(versions).toHaveLength(1);
    expect(createdVersion.version).toBe(2);
    expect(activated.querySet.currentVersion).toBe(2);
    expect(retired.querySet.status).toBe("retired");
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/query-sets",
      `/api/query-sets/${querySetId}/versions`,
      `/api/query-sets/${querySetId}/versions`,
      `/api/query-sets/${querySetId}/versions/${createdVersion.id}/activate`,
      `/api/query-sets/${querySetId}/state`,
    ]);
    for (const index of [1, 3, 4, 5]) {
      expect(new Headers(calls[index]?.init?.headers).get("x-csrf-token")).toBe(
        "csrf-token-from-api",
      );
    }
  });

  it("creates, reads, and cancels tenant-scoped Dry-run automation batches", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const campaignId = "10000000-0000-4000-8000-000000001001";
    const batchId = "10000000-0000-4000-8000-000000002001";
    const runId = "10000000-0000-4000-8000-000000003001";
    const batch = {
      id: batchId,
      campaignId,
      name: "日本线路 Dry-run",
      state: "scheduled",
      executionLevel: "dry_run",
      scheduledFor: "2026-07-15T08:00:00.000Z",
      runCount: 1,
      completedRunCount: 0,
      failedRunCount: 0,
      createdAt: "2026-07-15T07:00:00.000Z",
      updatedAt: "2026-07-15T07:00:00.000Z",
    };
    const target = {
      id: "10000000-0000-4000-8000-000000004001",
      runId,
      channelAccountId: "10000000-0000-4000-8000-000000000701",
      platform: "toutiao",
      state: "preview_completed",
      variantId: "10000000-0000-4000-8000-000000005001",
      auditRunId: "10000000-0000-4000-8000-000000005002",
      auditArtifactId: "10000000-0000-4000-8000-000000005003",
      publicationJobId: "10000000-0000-4000-8000-000000005004",
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: "2026-07-15T08:01:00.000Z",
      createdAt: "2026-07-15T07:00:00.000Z",
      updatedAt: "2026-07-15T08:01:00.000Z",
    };
    const run = {
      id: runId,
      batchId,
      campaignId,
      brandId: "10000000-0000-4000-8000-000000000301",
      slotKey: "slot-001",
      topicKey: "japan-travel",
      brief: "生成并审计日本线路问答",
      state: "completed",
      stage: "delivery",
      availableAt: "2026-07-15T08:00:00.000Z",
      attemptCount: 1,
      maxAttempts: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: "2026-07-15T08:00:30.000Z",
      checkpoint: { publicationJobId: target.publicationJobId },
      contentItemId: "10000000-0000-4000-8000-000000006001",
      contentVersionId: "10000000-0000-4000-8000-000000006002",
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: "2026-07-15T08:01:00.000Z",
      createdAt: "2026-07-15T07:00:00.000Z",
      updatedAt: "2026-07-15T08:01:00.000Z",
      targets: [target],
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({ batch, wasCreated: true }, 201),
      jsonResponse({ items: [batch] }),
      jsonResponse({ items: [run] }),
      jsonResponse(run),
      jsonResponse({
        batchId,
        state: "cancelled",
        cancelledRuns: 1,
        cancelledTargets: 1,
        wasChanged: true,
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const created = await api.createAutomationBatch(campaignId, {
      idempotencyKey: "automation-web-once",
      name: batch.name,
      items: [
        {
          slotKey: run.slotKey,
          scheduledFor: run.availableAt,
          topicKey: run.topicKey,
          brief: run.brief,
          channelAccountIds: [target.channelAccountId],
        },
      ],
    });
    const batches = await api.getAutomationBatches();
    const runs = await api.getAutomationRuns();
    const detail = await api.getAutomationRun(runId);
    const cancelled = await api.cancelAutomationBatch(batchId, "运营计划调整");

    expect(created).toMatchObject({ batch: { id: batchId, executionLevel: "dry_run" } });
    expect(batches[0]).toMatchObject({ runCount: 1, state: "scheduled" });
    expect(runs[0]?.targets[0]).toMatchObject({
      platform: "toutiao",
      state: "preview_completed",
    });
    expect(detail.checkpoint).toEqual({ publicationJobId: target.publicationJobId });
    expect(cancelled).toMatchObject({ state: "cancelled", cancelledTargets: 1 });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      `/api/campaigns/${campaignId}/automation-batches`,
      "/api/automation-batches",
      "/api/automation-runs",
      `/api/automation-runs/${runId}`,
      `/api/automation-batches/${batchId}/cancel`,
    ]);
    const createBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(createBody).not.toHaveProperty("tenantId");
    expect(createBody).not.toHaveProperty("executionLevel");
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({ reason: "运营计划调整" });
    expect(new Headers(calls[5]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("rejects an automation batch response that escapes the Dry-run boundary", async () => {
    const api = new HttpGeoApi("", async () =>
      jsonResponse({
        items: [
          {
            id: "10000000-0000-4000-8000-000000002001",
            campaignId: "10000000-0000-4000-8000-000000001001",
            name: null,
            state: "scheduled",
            executionLevel: "unattended",
            scheduledFor: "2026-07-15T08:00:00.000Z",
            runCount: 1,
            completedRunCount: 0,
            failedRunCount: 0,
            createdAt: "2026-07-15T07:00:00.000Z",
            updatedAt: "2026-07-15T07:00:00.000Z",
          },
        ],
      }),
    );

    await expect(api.getAutomationBatches()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: expect.stringContaining("executionLevel"),
    });
  });

  it("carries a scheduled Dry-run through the audited publication contract", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const scheduledFor = "2026-07-15T02:30:00.000Z";
    const job = {
      id: "10000000-0000-4000-8000-000000001101",
      grantId: "10000000-0000-4000-8000-000000001001",
      auditArtifactId: "10000000-0000-4000-8000-000000001002",
      variantId: "10000000-0000-4000-8000-000000001003",
      channelAccountId: "10000000-0000-4000-8000-000000000701",
      platform: "toutiao",
      executionLevel: "dry_run",
      state: "queued",
      payloadHash: "a".repeat(64),
      scheduledFor,
      availableAt: scheduledFor,
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse(
        {
          publicationJobId: job.id,
          publicationOutboxEventId: "10000000-0000-4000-8000-000000001104",
          wasCreated: true,
        },
        202,
      ),
      jsonResponse({
        grantId: job.grantId,
        status: "revoked",
        revokedAt: "2026-07-14T08:01:00.000Z",
        wasChanged: true,
      }),
      jsonResponse({ job: { ...job, state: "cancelled" }, wasChanged: true }),
      jsonResponse(job),
      jsonResponse({
        items: [
          {
            id: "10000000-0000-4000-8000-000000001201",
            jobId: job.id,
            attemptNo: 1,
            state: "succeeded",
            requestHash: "b".repeat(64),
            responseHash: "c".repeat(64),
            errorCode: null,
            errorMessage: null,
            startedAt: "2026-07-15T02:30:01.000Z",
            finishedAt: "2026-07-15T02:30:02.000Z",
          },
        ],
      }),
      jsonResponse({ items: [] }),
      jsonResponse({
        items: [
          {
            id: "10000000-0000-4000-8000-000000001301",
            jobId: job.id,
            receiptId: "10000000-0000-4000-8000-000000001302",
            status: "not_required",
            required: false,
            reason: "dry_run_has_no_external_publication",
            scheduledFor,
            completedAt: scheduledFor,
            lastError: null,
            createdAt: scheduledFor,
            updatedAt: scheduledFor,
          },
        ],
      }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    await api.requestPublication({
      grantId: job.grantId,
      token: "publication-token-that-is-long-enough",
      idempotencyKey: "publish:toutiao:scheduled",
      executionLevel: "dry_run",
      scheduledFor,
    });
    await api.revokePublicationGrant(job.grantId, "evidence superseded before dispatch");
    await api.cancelPublicationJob(job.id, "operator cancelled pending Dry-run");
    const detail = await api.getPublicationJob(job.id);
    const attempts = await api.getPublicationAttempts(job.id);
    const receipts = await api.getPublicationReceipts(job.id);
    const readbacks = await api.getPublicationReadbacks(job.id);

    expect(detail.scheduledFor).toBe(scheduledFor);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: "succeeded" });
    expect(receipts).toEqual([]);
    expect(readbacks[0]).toMatchObject({ required: false, status: "not_required" });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/publication-requests",
      `/api/publication-grants/${job.grantId}/revoke`,
      `/api/publication-jobs/${job.id}/cancel`,
      `/api/publication-jobs/${job.id}`,
      `/api/publication-jobs/${job.id}/attempts`,
      `/api/publication-jobs/${job.id}/receipts`,
      `/api/publication-jobs/${job.id}/readbacks`,
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      executionLevel: "dry_run",
      scheduledFor,
    });
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("parses assisted handoffs and protects every operator mutation with CSRF", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const handoff = {
      id: "10000000-0000-4000-8000-000000001401",
      jobId: "10000000-0000-4000-8000-000000001402",
      attemptId: "10000000-0000-4000-8000-000000001403",
      channelAccountId: "10000000-0000-4000-8000-000000000703",
      variantId: "10000000-0000-4000-8000-000000001404",
      platform: "ctrip_community",
      state: "handoff_pending",
      payloadHash: "a".repeat(64),
      auditHash: "b".repeat(64),
      previewHash: "c".repeat(64),
      adapterVersion: "ctrip-community-web-v1",
      bridgeServicePrincipalId: "10000000-0000-4000-8000-000000001405",
      leaseOwnerActorId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      sessionEvidenceHash: null,
      draftEvidenceHash: null,
      prepareOutcome: null,
      prepareEvidenceKind: null,
      prepareEvidenceHash: null,
      prepareObservedAt: null,
      mediaManifestHash: null,
      submitEvidenceHash: null,
      submitPermitIssued: false,
      submitPermitExpiresAt: null,
      submitPermitConsumedAt: null,
      submitPermitIssuedByActorId: null,
      submitPermitConsumedByPrincipalId: null,
      submitOutcome: null,
      submitEvidenceKind: null,
      submitObservedAt: null,
      publicationReceiptId: null,
      publicationReadbackId: null,
      readbackOutcome: null,
      readbackEvidenceKind: null,
      readbackEvidenceHash: null,
      readbackObservedAt: null,
      observedPayloadHash: null,
      externalDraftId: null,
      externalId: null,
      externalUrl: null,
      expiresAt: "2026-07-15T03:00:00.000Z",
      cancellationReason: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: "2026-07-15T02:00:00.000Z",
      updatedAt: "2026-07-15T02:00:00.000Z",
    };
    const claimed = {
      ...handoff,
      leaseOwnerActorId: loginBody.actor.id,
      leaseExpiresAt: "2026-07-15T02:02:00.000Z",
      heartbeatAt: "2026-07-15T02:00:00.000Z",
    };
    const cancelled = {
      ...handoff,
      state: "cancelled",
      cancellationReason: "operator cancelled before submit",
    };
    const prepared = {
      ...claimed,
      state: "draft_prepared",
      draftEvidenceHash: "d".repeat(64),
      prepareOutcome: "prepared",
      prepareEvidenceKind: "simulation",
      prepareEvidenceHash: "f".repeat(64),
      prepareObservedAt: "2026-07-15T02:00:30.000Z",
      mediaManifestHash: "1".repeat(64),
    };
    const submitted = {
      ...prepared,
      state: "readback_pending",
      submitPermitIssued: true,
      submitPermitConsumedAt: "2026-07-15T02:01:00.000Z",
      submitOutcome: "accepted",
      submitEvidenceKind: "simulation",
      submitObservedAt: "2026-07-15T02:01:00.000Z",
      publicationReceiptId: "10000000-0000-4000-8000-000000001406",
      publicationReadbackId: "10000000-0000-4000-8000-000000001407",
    };
    const reviewed = {
      ...submitted,
      state: "needs_review",
      readbackOutcome: "simulation_only",
      readbackEvidenceKind: "simulation",
      readbackEvidenceHash: "e".repeat(64),
      readbackObservedAt: "2026-07-15T02:02:00.000Z",
      observedPayloadHash: handoff.payloadHash,
    };
    const bridgeBase = {
      schemaVersion: "geo.ctrip-bridge.result.v1",
      tenantId: loginBody.tenant.id,
      handoffId: handoff.id,
      bridgePrincipalId: handoff.bridgeServicePrincipalId,
      adapterVersion: "ctrip-community-simulator-v1",
      observedAt: "2026-07-15T02:01:00.000Z",
      evidenceHash: "9".repeat(64),
      evidenceKind: "simulation",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({ items: [handoff] }),
      jsonResponse({ handoff: claimed }),
      jsonResponse({ handoff: claimed }),
      jsonResponse({
        handoff: prepared,
        bridge: { ...bridgeBase, command: "prepare", outcome: "prepared", state: "draft_prepared" },
      }),
      jsonResponse({
        handoff: submitted,
        bridge: {
          ...bridgeBase,
          command: "submit",
          outcome: "accepted",
          state: "readback_pending",
          receiptId: submitted.publicationReceiptId,
          readbackId: submitted.publicationReadbackId,
        },
      }),
      jsonResponse({
        handoff: reviewed,
        bridge: {
          ...bridgeBase,
          command: "readback",
          outcome: "simulation_only",
          state: "needs_review",
          externalId: null,
          externalUrl: null,
        },
      }),
      jsonResponse({ handoff: cancelled, wasChanged: true }),
      jsonResponse(cancelled),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const listed = await api.getPublicationAssistedHandoffs();
    await api.claimPublicationAssistedHandoff(handoff.id, 120);
    await api.heartbeatPublicationAssistedHandoff(handoff.id, 180);
    const preparation = await api.preparePublicationAssistedHandoff(handoff.id);
    const submission = await api.submitPublicationAssistedHandoff(handoff.id);
    const readback = await api.readbackPublicationAssistedHandoff(handoff.id);
    const cancellation = await api.cancelPublicationAssistedHandoff(
      handoff.id,
      "operator cancelled before submit",
    );
    const detail = await api.getPublicationAssistedHandoff(handoff.id);

    expect(listed[0]).toMatchObject({
      platform: "ctrip_community",
      state: "handoff_pending",
      submitPermitIssued: false,
    });
    expect(cancellation).toMatchObject({
      handoff: { state: "cancelled" },
      wasChanged: true,
    });
    expect(preparation).toMatchObject({
      handoff: {
        state: "draft_prepared",
        prepareOutcome: "prepared",
        prepareEvidenceKind: "simulation",
        prepareEvidenceHash: "f".repeat(64),
        prepareObservedAt: "2026-07-15T02:00:30.000Z",
        mediaManifestHash: "1".repeat(64),
      },
      bridge: { command: "prepare", evidenceKind: "simulation" },
    });
    expect(submission).toMatchObject({
      handoff: { state: "readback_pending", submitOutcome: "accepted" },
      bridge: { command: "submit", outcome: "accepted" },
    });
    expect(readback).toMatchObject({
      handoff: { state: "needs_review", readbackOutcome: "simulation_only" },
      bridge: { command: "readback", outcome: "simulation_only" },
    });
    expect(detail.state).toBe("cancelled");
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/publication-assisted-handoffs",
      `/api/publication-assisted-handoffs/${handoff.id}/claim`,
      `/api/publication-assisted-handoffs/${handoff.id}/heartbeat`,
      `/api/publication-assisted-handoffs/${handoff.id}/prepare`,
      `/api/publication-assisted-handoffs/${handoff.id}/submit`,
      `/api/publication-assisted-handoffs/${handoff.id}/readback`,
      `/api/publication-assisted-handoffs/${handoff.id}/cancel`,
      `/api/publication-assisted-handoffs/${handoff.id}`,
    ]);
    for (const call of calls.slice(2, 8)) {
      expect(new Headers(call.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    }
  });

  it("uses CSRF-protected tenant governance routes and parses service-principal truth", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const contactId = "10000000-0000-4000-8000-000000000401";
    const memberId = "10000000-0000-4000-8000-000000000201";
    const policyId = "10000000-0000-4000-8000-000000000501";
    const accountId = "10000000-0000-4000-8000-000000000701";
    const principalId = "10000000-0000-4000-8000-000000000801";
    const contact = {
      id: contactId,
      tenantId: loginBody.tenant.id,
      type: "wechat",
      label: "微信咨询",
      value: "ZTGL6431",
      isPrimary: false,
      validFrom: "2026-07-15T00:00:00.000Z",
      validUntil: null,
    };
    const member = {
      id: memberId,
      userId: "10000000-0000-4000-8000-000000000101",
      email: "editor@example.com",
      displayName: "内容编辑",
      role: "editor",
      capabilities: ["content:write"],
      status: "active",
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const policy = {
      id: policyId,
      version: "travel-v2",
      status: "active",
      policyHash: "a".repeat(64),
      document: {},
      effectiveAt: "2026-07-15T00:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const account = {
      id: accountId,
      platform: "sohu",
      displayName: "中通搜狐号",
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      evidenceType: "manual_import",
      evidenceRefs: ["ticket:GEO-1"],
      status: "needs_verification",
      lastVerifiedAt: null,
    };
    const principal = {
      id: principalId,
      tenantId: loginBody.tenant.id,
      name: "producer-zhongtong",
      kind: "agent",
      profile: "automation_producer",
      capabilities: ["content:write", "audit:run", "automation:execute"],
      status: "active",
      credentialStatus: "not_issued",
      lastUsedAt: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    const bridgePrincipal = {
      ...principal,
      id: "10000000-0000-4000-8000-000000000802",
      name: "ctrip-bridge-zhongtong",
      kind: "integration",
      profile: "ctrip_bridge",
      capabilities: ["tenant:read", "content:read", "publish:bridge"],
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse(contact, 201),
      jsonResponse({ ...contact, validUntil: "2026-07-15T01:00:00.000Z" }),
      jsonResponse(member, 201),
      jsonResponse({ ...member, role: "publisher" }),
      jsonResponse({ ...policy, status: "draft" }, 201),
      jsonResponse({ policy, previousStatus: "draft", wasChanged: true }),
      jsonResponse(account, 201),
      jsonResponse({ ...account, status: "active" }),
      jsonResponse({ items: [principal] }),
      jsonResponse(principal, 201),
      jsonResponse(bridgePrincipal, 201),
      jsonResponse({ principal: { ...principal, status: "disabled" }, wasChanged: true }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    await api.createContact({
      type: "wechat",
      label: "微信咨询",
      value: "ZTGL6431",
      isPrimary: false,
    });
    await api.expireContact(contactId, { reason: "旧账号停止使用" });
    await api.createMember({
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      initialPassword: "replace-this-password-2026",
    });
    await api.updateMember(memberId, { role: "publisher", reason: "调整发布职责" });
    await api.createPolicy({
      version: "travel-v2",
      document: { ...policy.document, rulesVersion: "travel-v2" },
      reason: "建立下一版审计策略草案",
    });
    await api.transitionPolicy(policyId, { targetStatus: "active", reason: "审核通过" });
    await api.createChannelAccount({
      platform: "sohu",
      displayName: account.displayName,
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      credentialRef: null,
      evidenceType: "manual_import",
      evidenceRefs: account.evidenceRefs,
      status: "needs_verification",
      lastVerifiedAt: null,
    });
    await api.updateChannelAccount(accountId, {
      status: "active",
      lastVerifiedAt: "2026-07-15T01:00:00.000Z",
      reason: "能力证据完成复核",
    });
    const listedPrincipals = await api.getServicePrincipals();
    await api.createAutomationServicePrincipal({ name: principal.name });
    const createdBridge = await api.createCtripBridgeServicePrincipal({
      name: "ctrip-bridge-zhongtong",
    });
    await api.setServicePrincipalStatus(principalId, {
      status: "disabled",
      reason: "轮换机器身份",
    });

    expect(listedPrincipals[0]).toMatchObject({
      profile: "automation_producer",
      credentialStatus: "not_issued",
    });
    expect(createdBridge).toMatchObject({
      kind: "integration",
      profile: "ctrip_bridge",
      capabilities: ["tenant:read", "content:read", "publish:bridge"],
    });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/contacts",
      `/api/contacts/${contactId}/expire`,
      "/api/members",
      `/api/members/${memberId}`,
      "/api/policies",
      `/api/policies/${policyId}/state`,
      "/api/channel-accounts",
      `/api/channel-accounts/${accountId}`,
      "/api/service-principals",
      "/api/service-principals/automation-producers",
      "/api/service-principals/ctrip-bridges",
      `/api/service-principals/${principalId}/status`,
    ]);
    for (const call of calls.slice(1).filter((item) => item.init?.method !== undefined)) {
      expect(new Headers(call.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    }
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({
      version: "travel-v2",
      document: { rulesVersion: "travel-v2" },
      reason: "建立下一版审计策略草案",
    });
    expect(JSON.parse(String(calls[10]?.init?.body))).toEqual({ name: principal.name });
    expect(JSON.parse(String(calls[11]?.init?.body))).toEqual({
      name: "ctrip-bridge-zhongtong",
    });
  });
});
