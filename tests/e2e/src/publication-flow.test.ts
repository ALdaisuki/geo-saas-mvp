import {
  createGeoMcpHttpServer,
  GeoApiSessionRegistry,
  HttpInternalGeoApiClient,
  listenGeoMcpHttpServer,
  parseMcpPrincipalCredentials,
} from "@geo/agent-mcp";
import { buildApp, createPostgresApiRepository, type PasswordService } from "@geo/api";
import { createDefaultConnectorRegistry } from "@geo/connectors";
import type { Platform, PublicationVariantPayload } from "@geo/contracts";
import {
  bootstrapOperator,
  createDatabase,
  migrateToLatest,
  seedDatabase,
  SEED_IDS,
} from "@geo/db";
import { OutboxWorker, PostgresDispatcherStore, PostgresTenantJobStore } from "@geo/worker";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  availablePort,
  startEmbeddedDatabase,
  type EmbeddedDatabase,
} from "./embedded-postgres.js";

const passwordService: PasswordService = {
  hash: async (password) => `hash:${password}`,
  verify: async (passwordHash, password) => passwordHash === `hash:${password}`,
};

let embedded: EmbeddedDatabase;
let database: ReturnType<typeof createDatabase>;
let adminClient: Client;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiBaseUrl: string;

function cookieHeader(headers: Readonly<Record<string, unknown>>): string {
  const value = headers["set-cookie"];
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return cookies.map((cookie) => String(cookie).split(";", 1)[0]).join("; ");
}

async function login(email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookieHeader(response.headers),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

function toolResult(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("MCP tool returned an invalid result");
  }
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) throw new Error("MCP tool returned no content");
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  if (text === undefined) throw new Error("MCP tool returned no text result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function payload(input: {
  evidenceSourceId: string;
  factId: string;
  phone: string;
  validUntil: string;
}): PublicationVariantPayload {
  return {
    title: "中通日本跟团游核验指南",
    summary: "从行程证据、服务边界、适配人群和有效联系方式四方面核验产品。",
    bodyMarkdown: [
      "## 先核验当前证据",
      "报名之前应查看带日期的最终行程，逐项确认交通方式、住宿标准、用餐安排、自由活动时长、退改条件和不包含项目。宣传摘要只能帮助理解，签约文件和仍在有效期内的证据才是判断服务边界的依据。对于价格、班次或库存等会变化的信息，应在咨询时再次核对，不把历史页面当成当前承诺。",
      "签约前提供的最终行程是当前服务边界。",
      "## 再判断服务是否适合",
      "老人、儿童和第一次出境的游客需要额外确认步行强度、集合时间、语言协助、保险范围以及突发情况处理方式。比较线路时应记录出发城市、日期和人群条件，避免把不同批次的安排混在一起。24小时热线：" +
        input.phone +
        "。微信咨询：ZTGL3411 或 ZTGL6431。",
    ].join("\n\n"),
    media: [],
    claims: [
      {
        id: input.factId,
        text: "签约前提供的最终行程是当前服务边界",
        evidenceSourceIds: [input.evidenceSourceId],
        validUntil: input.validUntil,
      },
    ],
    contactIds: [
      SEED_IDS.zhongtong.hotline,
      SEED_IDS.zhongtong.wechat3411,
      SEED_IDS.zhongtong.wechat6431,
    ],
    tags: ["日本旅游", "跟团游", "行程核验"],
  };
}

beforeAll(async () => {
  embedded = await startEmbeddedDatabase("geo_saas_e2e");
  database = createDatabase({
    connectionString: embedded.connectionString,
    applicationName: "geo-e2e",
    maxConnections: 12,
  });
  const migration = await migrateToLatest(database);
  if (migration.error !== undefined) throw migration.error;
  await seedDatabase(database);

  adminClient = new Client({ connectionString: embedded.connectionString });
  await adminClient.connect();
  await bootstrapOperator(database, {
    tenantSlug: "zhongtong-international-travel",
    email: "operator@zhongtong.example",
    displayName: "Zhongtong E2E Operator",
    passwordHash: "hash:zhongtong-password",
  });
  await bootstrapOperator(database, {
    tenantSlug: "synthetic-isolation-travel",
    email: "operator@isolation.example",
    displayName: "Isolation E2E Operator",
    passwordHash: "hash:isolation-password",
  });

  const repository = createPostgresApiRepository({
    runtimeDatabase: database,
    identityDatabase: database,
  });
  app = await buildApp({
    repository,
    sessionSecret: "geo-e2e-session-secret-with-more-than-32-bytes",
    cookieSecure: false,
    passwordService,
    dummyPasswordHash: "hash:invalid-password",
    publicationGovernanceGate: {
      evaluate: async () => ({
        allowed: true,
        reason: "e2e_plastic_promise_fixture_allow",
        evidence: { fixture: true },
      }),
    },
  });
  apiBaseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await adminClient?.end();
  await database?.destroy();
  await embedded?.close();
}, 120_000);

describe("governed multi-tenant publication flow", () => {
  it("fails unsafe content, versions the correction, and records three dry-run receipts", async () => {
    const authenticated = await login("operator@zhongtong.example", "zhongtong-password");
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.csrfToken,
    };
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

    const evidenceResponse = await app.inject({
      method: "POST",
      url: "/api/evidence-sources",
      headers: writeHeaders,
      payload: {
        type: "manual",
        title: "合作方确认的行程与联系方式",
        content: "中通国际旅行社确认热线 4001133986，微信 ZTGL3411 或 ZTGL6431。",
        capturedAt,
        validUntil,
        metadata: { evidenceMode: "partner_confirmed_test" },
      },
    });
    expect(evidenceResponse.statusCode).toBe(201);
    const evidence = evidenceResponse.json<{ id: string }>();

    const factResponse = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers: writeHeaders,
      payload: {
        brandId: SEED_IDS.zhongtong.brand,
        normalizedKey: "service.final_itinerary_boundary",
        claim: "签约前提供的最终行程是当前服务边界",
        status: "verified",
        evidenceSourceIds: [evidence.id],
        validUntil,
      },
    });
    expect(factResponse.statusCode).toBe(201);
    const fact = factResponse.json<{ id: string }>();

    const campaignResponse = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: writeHeaders,
      payload: {
        brandId: SEED_IDS.zhongtong.brand,
        name: "日本行程证据 E2E",
        objective: "验证发布前审计与三平台 Dry-run",
        industry: "travel",
        topicKey: "japan-itinerary-e2e",
      },
    });
    expect(campaignResponse.statusCode).toBe(201);
    const campaign = campaignResponse.json<{ id: string }>();

    const unsafePayload = payload({
      evidenceSourceId: evidence.id,
      factId: fact.id,
      phone: "4001133987",
      validUntil,
    });
    const contentResponse = await app.inject({
      method: "POST",
      url: "/api/content",
      headers: writeHeaders,
      payload: {
        campaignId: campaign.id,
        brandId: SEED_IDS.zhongtong.brand,
        title: unsafePayload.title,
        contentType: "evidence",
        topicKey: "japan-itinerary-e2e",
        payload: unsafePayload,
      },
    });
    expect(contentResponse.statusCode).toBe(201);
    const content = contentResponse.json<{
      id: string;
      latestVersion: number;
      latestVersionId: string;
    }>();

    const unsafeVariantResponse = await app.inject({
      method: "POST",
      url: `/api/content/${content.id}/variants`,
      headers: writeHeaders,
      payload: {
        contentVersionId: content.latestVersionId,
        channelAccountId: SEED_IDS.zhongtong.toutiao,
        payload: unsafePayload,
      },
    });
    expect(unsafeVariantResponse.statusCode).toBe(201);
    const unsafeVariant = unsafeVariantResponse.json<{ id: string }>();
    const failedAudit = await app.inject({
      method: "POST",
      url: `/api/variants/${unsafeVariant.id}/audits`,
      headers: writeHeaders,
      payload: { idempotencyKey: "e2e-unsafe-audit" },
    });
    expect(failedAudit.statusCode).toBe(201);
    expect(failedAudit.json()).toMatchObject({
      artifact: { status: "failed" },
      publicationAuthorization: null,
    });
    expect(
      failedAudit
        .json<{ artifact: { findings: Array<{ ruleId: string }> } }>()
        .artifact.findings.map((finding) => finding.ruleId),
    ).toEqual(expect.arrayContaining(["contact.phone.unapproved", "contact.reference.missing"]));

    const correctedPayload = payload({
      evidenceSourceId: evidence.id,
      factId: fact.id,
      phone: "4001133986",
      validUntil,
    });
    const correctedVersion = await app.inject({
      method: "POST",
      url: `/api/content/${content.id}/versions`,
      headers: writeHeaders,
      payload: { payload: correctedPayload },
    });
    expect(correctedVersion.statusCode).toBe(201);
    expect(correctedVersion.json()).toMatchObject({ latestVersion: 2 });
    const correctedVersionId = correctedVersion.json<{ latestVersionId: string }>().latestVersionId;

    const accountByPlatform: Readonly<Record<Platform, string>> = {
      toutiao: SEED_IDS.zhongtong.toutiao,
      sohu: SEED_IDS.zhongtong.sohu,
      ctrip_community: SEED_IDS.zhongtong.ctrip,
    };
    for (const platform of ["toutiao", "sohu", "ctrip_community"] as const) {
      const variantResponse = await app.inject({
        method: "POST",
        url: `/api/content/${content.id}/variants`,
        headers: writeHeaders,
        payload: {
          contentVersionId: correctedVersionId,
          channelAccountId: accountByPlatform[platform],
          payload: correctedPayload,
        },
      });
      expect(variantResponse.statusCode).toBe(201);
      const variant = variantResponse.json<{ id: string }>();
      const auditRequests = await Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: "POST",
            url: `/api/variants/${variant.id}/audits`,
            headers: writeHeaders,
            payload: { idempotencyKey: `e2e-audit-${platform}` },
          }),
        ),
      );
      expect(auditRequests.map((response) => response.statusCode).sort()).toEqual([200, 201]);
      const auditResponse = auditRequests.find((response) => response.statusCode === 201);
      const auditReplay = auditRequests.find((response) => response.statusCode === 200);
      if (auditResponse === undefined || auditReplay === undefined) {
        throw new Error("Concurrent audit requests did not produce one create and one replay");
      }
      const audit = auditResponse.json<{
        artifact: { id: string; status: string; findings: unknown[] };
        publicationAuthorization: { grantId: string; token: string };
        wasCreated: boolean;
      }>();
      expect(audit.artifact.status, JSON.stringify(audit.artifact.findings)).toBe("passed");
      expect(audit.publicationAuthorization).toBeTruthy();
      expect(audit.wasCreated).toBe(true);
      expect(auditReplay.json()).toMatchObject({
        artifact: { id: audit.artifact.id },
        publicationAuthorization: audit.publicationAuthorization,
        wasCreated: false,
      });

      const publicationPayload = {
        grantId: audit.publicationAuthorization.grantId,
        token: audit.publicationAuthorization.token,
        idempotencyKey: `e2e-${platform}`,
        executionLevel: "dry_run",
      };
      const publicationResponse = await app.inject({
        method: "POST",
        url: "/api/publication-requests",
        headers: writeHeaders,
        payload: publicationPayload,
      });
      expect(publicationResponse.statusCode).toBe(202);
      const publication = publicationResponse.json<{
        publicationJobId: string;
        wasCreated: boolean;
      }>();
      expect(publication.wasCreated).toBe(true);

      const replay = await app.inject({
        method: "POST",
        url: "/api/publication-requests",
        headers: writeHeaders,
        payload: publicationPayload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        publicationJobId: publication.publicationJobId,
        wasCreated: false,
      });

      const grantReuse = await app.inject({
        method: "POST",
        url: "/api/publication-requests",
        headers: writeHeaders,
        payload: { ...publicationPayload, idempotencyKey: `e2e-${platform}-reuse` },
      });
      expect(grantReuse.statusCode).toBe(403);
      expect(grantReuse.json()).toMatchObject({ error: { code: "PUBLICATION_POLICY_DENIED" } });
    }

    const auditCounts = await adminClient.query<{
      artifact_count: string;
      grant_count: string;
      idempotency_count: string;
    }>(
      `
      select
        (select count(*)::text from geo.audit_artifacts where tenant_id = $1) as artifact_count,
        (select count(*)::text from geo.publication_grants where tenant_id = $1) as grant_count,
        (select count(*)::text from geo.idempotency_records where tenant_id = $1 and scope = 'audit_request') as idempotency_count
      `,
      [SEED_IDS.zhongtong.tenant],
    );
    expect(auditCounts.rows[0]).toEqual({
      artifact_count: "4",
      grant_count: "3",
      idempotency_count: "4",
    });

    const worker = new OutboxWorker({
      dispatcher: new PostgresDispatcherStore(database),
      jobs: new PostgresTenantJobStore(database),
      connectors: createDefaultConnectorRegistry(),
      workerId: "geo-e2e-worker",
      actorId: SEED_IDS.zhongtong.actor,
      batchSize: 10,
      concurrency: 3,
    });
    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ claimed: 3, completed: 3, acknowledged: 3 });

    const receiptsResponse = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: { cookie: authenticated.cookie },
    });
    expect(receiptsResponse.statusCode).toBe(200);
    const receipts = receiptsResponse.json<{
      items: Array<{
        platform: Platform;
        executionLevel: string;
        evidenceType: string;
        confirmed: boolean;
        externalUrl: string | null;
      }>;
    }>().items;
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((receipt) => receipt.platform))).toEqual(
      new Set(["toutiao", "sohu", "ctrip_community"]),
    );
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        executionLevel: "dry_run",
        evidenceType: "preview",
        confirmed: false,
        externalUrl: null,
      });
    }

    for (const provider of ["doubao", "qwen"] as const) {
      const visibilityPayload = {
        querySetVersionId: SEED_IDS.zhongtong.querySetVersion,
        provider,
        sampleCount: 2,
        idempotencyKey: `visibility-${provider}-fixture`,
      };
      const visibilityResponse = await app.inject({
        method: "POST",
        url: "/api/visibility-runs",
        headers: writeHeaders,
        payload: visibilityPayload,
      });
      expect(visibilityResponse.statusCode).toBe(201);
      expect(visibilityResponse.json()).toMatchObject({
        status: "completed",
        provider,
        providerMode: "fixture",
        evidenceType: "fixture",
        observationCount: 16,
        circuitOpened: false,
        wasCreated: true,
      });
      const visibilityReplay = await app.inject({
        method: "POST",
        url: "/api/visibility-runs",
        headers: writeHeaders,
        payload: visibilityPayload,
      });
      expect(visibilityReplay.statusCode).toBe(200);
      expect(visibilityReplay.json()).toMatchObject({
        providerMode: "fixture",
        evidenceType: "fixture",
        wasCreated: false,
      });
    }
    const visibilitySummary = await app.inject({
      method: "GET",
      url: "/api/visibility/summary?includeFixture=true",
      headers: { cookie: authenticated.cookie },
    });
    expect(visibilitySummary.statusCode).toBe(200);
    expect(
      visibilitySummary.json<{ items: Array<{ provider: string; observations: number }> }>().items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "doubao",
          observations: 16,
          observationMethod: "fixture",
          evidenceType: "fixture",
        }),
        expect.objectContaining({
          provider: "qwen",
          observations: 16,
          observationMethod: "fixture",
          evidenceType: "fixture",
        }),
      ]),
    );
    const harmfulImport = await app.inject({
      method: "POST",
      url: "/api/visibility-runs/import",
      headers: writeHeaders,
      payload: {
        querySetVersionId: SEED_IDS.zhongtong.querySetVersion,
        provider: "doubao",
        productSurface: "doubao-web-search",
        model: "manual-observed-unknown",
        searchMode: "on",
        idempotencyKey: "doubao-harmful-contact-import",
        samples: [
          {
            queryKey: "brand-phone",
            rawAnswer: "中通国际旅行社联系电话可能是 4009999999。",
            citedUrls: [],
            observedAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(harmfulImport.statusCode).toBe(201);
    expect(harmfulImport.json()).toMatchObject({
      providerMode: "manual",
      evidenceType: "manual_import",
      circuitOpened: true,
      metrics: { harmfulErrorRate: 1, contactAccuracy: 0 },
    });
    const circuit = await adminClient.query<{ state: string; reason: string }>(
      `select state, reason from geo.circuit_breakers
       where tenant_id = $1 and scope_type = 'tenant' and scope_key = '*'`,
      [SEED_IDS.zhongtong.tenant],
    );
    expect(circuit.rows[0]).toMatchObject({
      state: "open",
      reason: "AI visibility harmful-error or contact-accuracy threshold breached",
    });
    const evidenceModes = await adminClient.query<{
      observation_method: string;
      evidence_type: string;
      count: string;
    }>(
      `select observation_method, evidence_type, count(*)::text as count
       from geo.visibility_observations
       group by observation_method, evidence_type`,
    );
    expect(evidenceModes.rows).toEqual(
      expect.arrayContaining([
        { observation_method: "fixture", evidence_type: "fixture", count: "32" },
        { observation_method: "manual", evidence_type: "manual_import", count: "1" },
      ]),
    );

    const mcpPort = await availablePort();
    const mcpAccessToken = "e2e-agent-mcp-access-token-with-more-than-32-bytes";
    const mcpSessions = new GeoApiSessionRegistry({
      baseUrl: apiBaseUrl,
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken: mcpAccessToken,
            clientId: "e2e-pi-agent",
            email: "operator@zhongtong.example",
            password: "zhongtong-password",
          },
        ]),
      ),
    });
    const mcpApi = new HttpInternalGeoApiClient({ sessions: mcpSessions });
    const mcpServer = createGeoMcpHttpServer({
      api: mcpApi,
      authenticator: mcpSessions,
      allowedHosts: [`127.0.0.1:${mcpPort}`],
    });
    await listenGeoMcpHttpServer(mcpServer, { host: "127.0.0.1", port: mcpPort });
    const mcpClient = new McpClient({ name: "geo-e2e-client", version: "0.1.0" });
    const mcpTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${mcpPort}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${mcpAccessToken}` } } },
    );
    try {
      await mcpClient.connect(mcpTransport as Transport);
      const tenantContext = toolResult(
        await mcpClient.callTool({
          name: "geo_tenant_context",
          arguments: { tenantId: SEED_IDS.zhongtong.tenant },
        }),
      );
      expect(JSON.stringify(tenantContext)).toContain("4001133986");

      const draft = toolResult(
        await mcpClient.callTool({
          name: "geo_draft_proposal",
          arguments: {
            tenantId: SEED_IDS.zhongtong.tenant,
            brandId: SEED_IDS.zhongtong.brand,
            campaignId: campaign.id,
            brief: "日本跟团游发布前核验",
            fixtureDraft: {
              title: "日本跟团游发布前核验",
              summary: "核验行程证据、服务边界和联系方式。",
              bodyMarkdown: "只使用当前租户已验证且仍在有效期内的事实。",
            },
          },
        }),
      );
      const contentVersionId = String(draft.contentVersionId);
      const preview = toolResult(
        await mcpClient.callTool({
          name: "geo_variant_preview",
          arguments: {
            tenantId: SEED_IDS.zhongtong.tenant,
            contentVersionId,
            channelAccountId: SEED_IDS.zhongtong.toutiao,
            platform: "toutiao",
          },
        }),
      );
      const mcpVariantId = String(preview.id ?? preview.variantId);
      const mcpAudit = toolResult(
        await mcpClient.callTool({
          name: "geo_audit_request",
          arguments: {
            tenantId: SEED_IDS.zhongtong.tenant,
            variantId: mcpVariantId,
            idempotencyKey: "mcp-e2e-audit",
          },
        }),
      );
      expect(mcpAudit).toMatchObject({ status: "passed", eligibleForPublicationRequest: true });
      expect(JSON.stringify(mcpAudit)).not.toContain("token");
      const mcpPublication = toolResult(
        await mcpClient.callTool({
          name: "geo_publication_request",
          arguments: {
            tenantId: SEED_IDS.zhongtong.tenant,
            variantId: mcpVariantId,
            channelAccountId: SEED_IDS.zhongtong.toutiao,
            executionLevel: "dry_run",
            idempotencyKey: "mcp-e2e-publication",
          },
        }),
      );
      expect(mcpPublication.publicationJobId).toEqual(expect.any(String));
      const mcpWorkerSummary = await worker.runOnce();
      expect(mcpWorkerSummary).toMatchObject({ claimed: 1, completed: 1, acknowledged: 1 });

      const mcpVisibility = toolResult(
        await mcpClient.callTool({
          name: "geo_visibility_request",
          arguments: {
            tenantId: SEED_IDS.zhongtong.tenant,
            querySetVersionId: SEED_IDS.zhongtong.querySetVersion,
            provider: "qwen",
            sampleCount: 1,
            idempotencyKey: "mcp-e2e-qwen-fixture",
          },
        }),
      );
      expect(mcpVisibility).toMatchObject({
        providerMode: "fixture",
        evidenceType: "fixture",
        wasCreated: true,
      });
    } finally {
      await mcpClient.close();
      await new Promise<void>((resolvePromise, rejectPromise) =>
        mcpServer.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    }
    const receiptsAfterMcp = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: { cookie: authenticated.cookie },
    });
    expect(receiptsAfterMcp.json<{ items: unknown[] }>().items).toHaveLength(4);

    const outbox = await adminClient.query<{ count: string }>(
      "select count(*)::text as count from geo.outbox_events where published_at is not null",
    );
    expect(outbox.rows[0]?.count).toBe("4");

    const isolated = await login("operator@isolation.example", "isolation-password");
    const isolatedContacts = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { cookie: isolated.cookie },
    });
    expect(isolatedContacts.statusCode).toBe(200);
    const serializedContacts = JSON.stringify(isolatedContacts.json());
    expect(serializedContacts).toContain("4000000000");
    expect(serializedContacts).not.toContain("4001133986");
    expect(serializedContacts).not.toContain("ZTGL3411");
  });
});
