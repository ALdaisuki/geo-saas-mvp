import { afterEach, describe, expect, it, vi } from "vitest";

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
    const updated = await api.setKillSwitch({ enabled: true, reason: "contact anomaly" });

    expect(tenants[0]).toMatchObject({ status: "active", role: "owner" });
    expect(automation.control.killSwitchEnabled).toBe(false);
    expect(updated.killSwitchEnabled).toBe(true);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/auth/tenants",
      "/api/auth/switch-tenant",
      "/api/automation",
      "/api/automation/kill-switch",
    ]);
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[4]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
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
    const responses = [
      jsonResponse(loginBody),
      jsonResponse(contact, 201),
      jsonResponse({ ...contact, validUntil: "2026-07-15T01:00:00.000Z" }),
      jsonResponse(member, 201),
      jsonResponse({ ...member, role: "publisher" }),
      jsonResponse({ policy, previousStatus: "draft", wasChanged: true }),
      jsonResponse(account, 201),
      jsonResponse({ ...account, status: "active" }),
      jsonResponse({ items: [principal] }),
      jsonResponse(principal, 201),
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
    await api.setServicePrincipalStatus(principalId, {
      status: "disabled",
      reason: "轮换机器身份",
    });

    expect(listedPrincipals[0]).toMatchObject({
      profile: "automation_producer",
      credentialStatus: "not_issued",
    });
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/contacts",
      `/api/contacts/${contactId}/expire`,
      "/api/members",
      `/api/members/${memberId}`,
      `/api/policies/${policyId}/state`,
      "/api/channel-accounts",
      `/api/channel-accounts/${accountId}`,
      "/api/service-principals",
      "/api/service-principals/automation-producers",
      `/api/service-principals/${principalId}/status`,
    ]);
    for (const call of calls.slice(1).filter((item) => item.init?.method !== undefined)) {
      expect(new Headers(call.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    }
    expect(JSON.parse(String(calls[9]?.init?.body))).toEqual({ name: principal.name });
  });
});
