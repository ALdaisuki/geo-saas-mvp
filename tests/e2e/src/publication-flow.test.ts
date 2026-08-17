import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlasticPromiseGovernanceClient } from "@geo/agent";
import {
  AutomationProducer,
  createGovernedAgentRuntime,
  createGeoAutomationProducerDependencies,
  createGeoMcpHttpServer,
  FixturePiAgentRunService,
  GeoApiSessionRegistry,
  HttpInternalGeoApiClient,
  listenGeoMcpHttpServer,
  parseMcpPrincipalCredentials,
} from "@geo/agent-mcp";
import {
  buildApp,
  createPostgresApiRepository,
  AgentRunGatewayError,
  HttpAgentRunGateway,
  MediaImportService,
  MediaProductionService,
  MediaSearchImportService,
  type AgentRunGateway,
  type MediaAssetView,
  type MediaContentInspector,
  type PasswordService,
} from "@geo/api";
import { createDefaultConnectorRegistry, type ManualPublicationPackage } from "@geo/connectors";
import {
  MEMBER_MODULE_IDS,
  type Platform,
  type PublicationVariantPayload,
  type TenantContact,
} from "@geo/contracts";
import {
  buildBaselineAuditPolicyDocument,
  buildVisualBrief,
  compileAuditPolicy,
  renderEditorialSourcePayload,
  renderCanonicalContent,
  sha256Canonical,
} from "@geo/core";
import {
  bootstrapOperator,
  createDatabase,
  migrateToLatest,
  seedDatabase,
  SEED_IDS,
} from "@geo/db";
import {
  ContentAddressedMediaStore,
  fixtureImageInputHash,
  FixtureImageGenerationProvider,
  type LicensedImageSearchProvider,
  WikimediaCommonsImageSearchProvider,
} from "@geo/media";
import { travelQuerySetPromptsV1 } from "@geo/visibility";
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
const FINAL_ITINERARY_CLAIM = "示例国际旅行服务确认，签约前提供的最终行程是当前服务边界";

let embedded: EmbeddedDatabase;
let database: ReturnType<typeof createDatabase>;
let adminClient: Client;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiBaseUrl: string;
let mediaObjectRoot: string;
let mediaObjectStore: ContentAddressedMediaStore;
let agentRunGatewayDelegate: AgentRunGateway | undefined;

const delegatedAgentRunGateway: AgentRunGateway = {
  getCapability: async (tenantId) =>
    agentRunGatewayDelegate?.getCapability(tenantId) ?? {
      available: false,
      mode: "unavailable",
      provider: null,
      model: null,
      reason: "service_unavailable",
    },
  run: async (input) => {
    if (agentRunGatewayDelegate === undefined) {
      throw new AgentRunGatewayError(
        503,
        "AGENT_GATEWAY_UNAVAILABLE",
        "Agent runner is unavailable",
      );
    }
    return agentRunGatewayDelegate.run(input);
  },
};

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
  try {
    return JSON.parse(text.text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`MCP tool returned non-JSON text: ${text.text}`, { cause: error });
  }
}

function canonicalPayload(input: {
  capturedAt: string;
  evidenceSourceId: string;
  factId: string;
  validUntil: string;
  tampered?: boolean;
}): PublicationVariantPayload {
  const document = buildBaselineAuditPolicyDocument({
    rulesVersion: "travel-v1",
    industry: "travel",
  });
  const policy = compileAuditPolicy({
    version: document.rulesVersion,
    policyHash: sha256Canonical(document),
    document,
  });
  const contacts: readonly TenantContact[] = [
    {
      id: SEED_IDS.sampleTravel.hotline,
      tenantId: SEED_IDS.sampleTravel.tenant,
      type: "phone",
      label: "24小时热线",
      value: "4000000001",
      isPrimary: true,
      validFrom: "2026-07-13T00:00:00.000Z",
      validUntil: null,
    },
    {
      id: SEED_IDS.sampleTravel.wechatPrimary,
      tenantId: SEED_IDS.sampleTravel.tenant,
      type: "wechat",
      label: "微信咨询一",
      value: "TRAVEL_DEMO_01",
      isPrimary: true,
      validFrom: "2026-07-13T00:00:00.000Z",
      validUntil: null,
    },
    {
      id: SEED_IDS.sampleTravel.wechatSecondary,
      tenantId: SEED_IDS.sampleTravel.tenant,
      type: "wechat",
      label: "微信咨询二",
      value: "TRAVEL_DEMO_02",
      isPrimary: false,
      validFrom: "2026-07-13T00:00:00.000Z",
      validUntil: null,
    },
  ];
  const source: PublicationVariantPayload = {
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
    summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
    bodyBlocks: [
      { type: "template", templateId: "generic.body.heading.verified" },
      { type: "template", templateId: "generic.body.guidance.verified" },
      { type: "claim", claimId: input.factId, presentation: "bullet" },
      { type: "template", templateId: "generic.body.heading.contact" },
      ...contacts.map(
        (contact) =>
          ({ type: "contact", contactId: contact.id, presentation: "paragraph" }) as const,
      ),
      { type: "template", templateId: "generic.body.guidance.contact" },
    ],
    tagTemplateIds: ["generic.tag.verified"],
    media: [],
    claims: [
      {
        id: input.factId,
        text: FINAL_ITINERARY_CLAIM,
        evidenceSourceIds: [input.evidenceSourceId],
        validUntil: input.validUntil,
      },
    ],
    contactIds: contacts.map((contact) => contact.id),
    tags: [],
  };
  const rendered = renderCanonicalContent({
    payload: source,
    policy,
    factSnapshot: {
      tenantId: SEED_IDS.sampleTravel.tenant,
      capturedAt: input.capturedAt,
      facts: [
        {
          id: input.factId,
          brandId: SEED_IDS.sampleTravel.brand,
          text: FINAL_ITINERARY_CLAIM,
          evidenceSourceIds: [input.evidenceSourceId],
          validFrom: input.capturedAt,
          validUntil: input.validUntil,
        },
      ],
      sources: [],
    },
    contacts,
  });
  if (
    rendered.issues.length > 0 ||
    rendered.title === null ||
    rendered.summary === null ||
    rendered.bodyMarkdown === null ||
    rendered.tags === null
  ) {
    throw new Error(`E2E canonical source failed to render: ${JSON.stringify(rendered.issues)}`);
  }
  return {
    ...source,
    title: rendered.title,
    summary: rendered.summary,
    bodyMarkdown: input.tampered
      ? `${rendered.bodyMarkdown}\n\n未经策略模板授权的热线：4000000099`
      : rendered.bodyMarkdown,
    tags: [...rendered.tags],
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
    tenantSlug: "sample-travel",
    email: "operator@sample-travel.example",
    displayName: "Sample travel tenant E2E Operator",
    passwordHash: "hash:sample-password",
  });
  await bootstrapOperator(database, {
    tenantSlug: "synthetic-isolation-travel",
    email: "operator@isolation.example",
    displayName: "Isolation E2E Operator",
    passwordHash: "hash:isolation-password",
  });
  const moduleGrant = await adminClient.query(
    `UPDATE geo.tenant_memberships AS membership
     SET enabled_modules = $1::jsonb
     FROM geo.users AS actor
     WHERE actor.id = membership.user_id
       AND actor.email = ANY($2::text[])
     RETURNING membership.id`,
    [
      JSON.stringify(MEMBER_MODULE_IDS),
      ["operator@sample-travel.example", "operator@isolation.example"],
    ],
  );
  if (moduleGrant.rowCount !== 2) {
    throw new Error(
      `E2E module grants updated ${moduleGrant.rowCount ?? 0} operators instead of 2`,
    );
  }

  const repository = createPostgresApiRepository({
    runtimeDatabase: database,
    identityDatabase: database,
  });
  mediaObjectRoot = await mkdtemp(join(tmpdir(), "geo-e2e-media-"));
  mediaObjectStore = new ContentAddressedMediaStore(mediaObjectRoot);
  const mediaProduction = new MediaProductionService({
    repository,
    provider: new FixtureImageGenerationProvider(),
    objectStore: mediaObjectStore,
  });
  const mediaContentInspector: MediaContentInspector = {
    inspect: async (input) => {
      const sceneSignature = `scene-signature:e2e_${input.assetSha256.slice(0, 16)}:synthetic:wide`;
      const labels = [
        "ocr:completed",
        "travel-relevance:passed",
        "contact-text:none",
        "vision-confidence:confident",
        "safety:passed",
        sceneSignature,
      ];
      return {
        assetSha256: input.assetSha256,
        status: "passed",
        evaluator: "pi-vision-inspector",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
        model: "e2e-vision-fixture-v1",
        responseSha256: sha256Canonical({
          schemaVersion: "geo.e2e-media-inspection.v1",
          assetSha256: input.assetSha256,
          labels,
        }),
        providerRequestId: `e2e-${input.assetSha256.slice(0, 16)}`,
        ocrText: "",
        labels,
      };
    },
  };
  const mediaImport = new MediaImportService({
    repository,
    objectStore: mediaObjectStore,
    contentInspector: mediaContentInspector,
  });
  const licensedFixtureProvider = new FixtureImageGenerationProvider();
  const licensedFixtureSources = await Promise.all(
    (["cover", "inline", "inline", "inline"] as const).map(async (role, index) => {
      const visualBrief = buildVisualBrief({
        editorialProfile: "guide",
        platform: "toutiao",
        role,
        facts: [],
      });
      const fixtureBrief = {
        ...visualBrief,
        prompt: `${visualBrief.prompt}; licensed search E2E scene ${index + 1}`,
      };
      return licensedFixtureProvider.generate({
        visualBrief: fixtureBrief,
        expectedInputHash: fixtureImageInputHash(fixtureBrief),
      });
    }),
  );
  const licensedImageNormalizer = new WikimediaCommonsImageSearchProvider({
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const fixtureIndex = Number(/geo-e2e-licensed-(\d+)\.png$/u.exec(url.pathname)?.[1]) - 1;
      const source = licensedFixtureSources[fixtureIndex];
      if (source === undefined)
        return new Response("Licensed media fixture is missing", { status: 404 });
      return new Response(Uint8Array.from(source.bytes), {
        status: 200,
        headers: {
          "content-type": source.mimeType,
          "content-length": String(source.bytes.byteLength),
        },
      });
    },
  });
  const licensedSearchProvider: LicensedImageSearchProvider = {
    provider: "wikimedia_commons",
    search: async ({ query, limit }) =>
      licensedFixtureSources.slice(0, limit).map((source, index) => ({
        provider: "wikimedia_commons",
        providerAssetId: String(index + 1),
        searchQuery: query,
        title: `GEO E2E licensed travel ${index + 1}`,
        description: query,
        creator: "GEO E2E fixture",
        sourceUrl: `https://commons.wikimedia.org/wiki/File:GEO_E2E_licensed_travel_${index + 1}.png`,
        downloadUrl: `https://upload.wikimedia.org/geo-e2e-licensed-${index + 1}.png`,
        licenseName: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "GEO E2E fixture",
        sourceWidth: source.width,
        sourceHeight: source.height,
        mimeType: source.mimeType,
      })),
    downloadAndNormalize: (input) => licensedImageNormalizer.downloadAndNormalize(input),
  };
  const mediaSearchImport = new MediaSearchImportService({
    repository,
    provider: licensedSearchProvider,
    mediaImport,
    objectStore: mediaObjectStore,
  });
  app = await buildApp({
    repository,
    sessionSecret: "geo-e2e-session-secret-with-more-than-32-bytes",
    cookieSecure: false,
    logger: { level: "error" },
    passwordService,
    dummyPasswordHash: "hash:invalid-password",
    publicationGovernanceGate: {
      evaluate: async () => ({
        allowed: true,
        reason: "e2e_plastic_promise_fixture_allow",
        evidence: { fixture: true },
      }),
    },
    agentRunGateway: delegatedAgentRunGateway,
    mediaProduction,
    mediaImport,
    mediaSearchImport,
    mediaObjectStore,
  });
  apiBaseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await adminClient?.end();
  await database?.destroy();
  await embedded?.close();
  if (mediaObjectRoot !== undefined) {
    await rm(mediaObjectRoot, { recursive: true, force: true });
  }
}, 120_000);

describe("governed multi-tenant publication flow", () => {
  it("governs API, MCP, and agent-runner dry-run publication across isolated tenants", async () => {
    const authenticated = await login("operator@sample-travel.example", "sample-password");
    const writeHeaders = {
      cookie: authenticated.cookie,
      "x-csrf-token": authenticated.csrfToken,
    };
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

    const automationControlResponse = await app.inject({
      method: "PUT",
      url: "/api/automation/control",
      headers: writeHeaders,
      payload: {
        mode: "unattended",
        quota: {
          maxConcurrent: 2,
          perMinute: 8,
          perDay: 80,
          cooldownSeconds: 15,
          errorBudget: 4,
        },
        reason: "E2E verifies unattended Dry-run control",
      },
    });
    expect(automationControlResponse.statusCode).toBe(200);
    expect(automationControlResponse.json()).toMatchObject({
      control: {
        mode: "unattended",
        killSwitchEnabled: false,
        quota: { maxConcurrent: 2, perMinute: 8, perDay: 80 },
      },
    });
    const automationReadback = await app.inject({
      method: "GET",
      url: "/api/automation",
      headers: { cookie: authenticated.cookie },
    });
    expect(automationReadback.json()).toMatchObject({
      control: {
        mode: "unattended",
        quota: { cooldownSeconds: 15, errorBudget: 4 },
      },
    });
    const automationAudit = await app.inject({
      method: "GET",
      url: "/api/audit-log?action=automation.control_changed",
      headers: { cookie: authenticated.cookie },
    });
    expect(automationAudit.json<{ items: readonly { action: string }[] }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "automation.control_changed" })]),
    );
    const restoreShadow = await app.inject({
      method: "PUT",
      url: "/api/automation/control",
      headers: writeHeaders,
      payload: {
        mode: "shadow",
        quota: {
          maxConcurrent: 1,
          perMinute: 10,
          perDay: 100,
          cooldownSeconds: 0,
          errorBudget: 5,
        },
        reason: "Restore conservative E2E baseline",
      },
    });
    expect(restoreShadow.statusCode).toBe(200);
    const platformControl = await app.inject({
      method: "PUT",
      url: "/api/automation/controls/platform/toutiao",
      headers: writeHeaders,
      payload: {
        mode: "unattended",
        quota: {
          maxConcurrent: 100,
          perMinute: 10_000,
          perDay: 1_000_000,
          cooldownSeconds: 0,
          errorBudget: 100_000,
        },
        killSwitchEnabled: false,
        reason: "E2E platform scope Dry-run baseline",
      },
    });
    expect(platformControl.statusCode).toBe(200);
    const openPlatformCircuit = await app.inject({
      method: "POST",
      url: "/api/automation/circuits/platform/toutiao/state",
      headers: writeHeaders,
      payload: { targetState: "open", reason: "E2E manual circuit test" },
    });
    expect(openPlatformCircuit.json()).toMatchObject({
      circuit: { scopeType: "platform", scopeKey: "toutiao", state: "open" },
    });
    const closePlatformCircuit = await app.inject({
      method: "POST",
      url: "/api/automation/circuits/platform/toutiao/state",
      headers: writeHeaders,
      payload: { targetState: "closed", reason: "E2E manual circuit reset" },
    });
    expect(closePlatformCircuit.json()).toMatchObject({
      circuit: { state: "closed", failureCount: 0, openedAt: null },
    });

    const evidenceResponse = await app.inject({
      method: "POST",
      url: "/api/evidence-sources",
      headers: writeHeaders,
      payload: {
        type: "manual",
        title: "合作方确认的行程与联系方式",
        content: "示例国际旅行服务确认热线 4000000001，微信 TRAVEL_DEMO_01 或 TRAVEL_DEMO_02。",
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
        brandId: SEED_IDS.sampleTravel.brand,
        normalizedKey: "service.final_itinerary_boundary",
        claim: FINAL_ITINERARY_CLAIM,
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
        brandId: SEED_IDS.sampleTravel.brand,
        name: "日本行程证据 E2E",
        objective: "验证发布前审计与三平台 Dry-run",
        industry: "travel",
        topicKey: "japan-itinerary-e2e",
      },
    });
    expect(campaignResponse.statusCode).toBe(201);
    const campaign = campaignResponse.json<{ id: string }>();
    const campaignActivationResponse = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaign.id}/state`,
      headers: writeHeaders,
      payload: { status: "active", reason: "E2E automation batch is ready" },
    });
    expect(campaignActivationResponse.statusCode).toBe(200);
    expect(campaignActivationResponse.json()).toMatchObject({
      campaign: { id: campaign.id, status: "active" },
      previousStatus: "draft",
      wasChanged: true,
    });

    const isolationSession = await login("operator@isolation.example", "isolation-password");
    const crossTenantPause = await app.inject({
      method: "POST",
      url: `/api/campaigns/${campaign.id}/state`,
      headers: {
        cookie: isolationSession.cookie,
        "x-csrf-token": isolationSession.csrfToken,
      },
      payload: { status: "paused", reason: "Must not cross tenant scope" },
    });
    expect(crossTenantPause.statusCode).toBe(404);

    const unsafePayload = canonicalPayload({
      capturedAt,
      evidenceSourceId: evidence.id,
      factId: fact.id,
      validUntil,
      tampered: true,
    });
    const contentResponse = await app.inject({
      method: "POST",
      url: "/api/content",
      headers: writeHeaders,
      payload: {
        campaignId: campaign.id,
        brandId: SEED_IDS.sampleTravel.brand,
        title: unsafePayload.title,
        contentType: "evidence",
        topicKey: "japan-itinerary-e2e",
        idempotencyKey: "e2e-content-japan-itinerary-v1",
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
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
      },
    });
    expect(unsafeVariantResponse.statusCode).toBe(422);
    expect(unsafeVariantResponse.json()).toMatchObject({
      error: { code: "PLATFORM_VARIANT_SOURCE_INVALID" },
    });
    const injectedVariantResponse = await app.inject({
      method: "POST",
      url: `/api/content/${content.id}/variants`,
      headers: writeHeaders,
      payload: {
        contentVersionId: content.latestVersionId,
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
        payload: unsafePayload,
      },
    });
    expect(injectedVariantResponse.statusCode).toBe(400);

    const legacyUnsafeVariant = await adminClient.query<{ id: string }>(
      `insert into geo.publication_variants (
         tenant_id, content_version_id, channel_account_id, platform,
         variant_version, payload, payload_hash
       ) values ($1, $2, $3, 'toutiao', 1, $4::jsonb, $5)
       returning id`,
      [
        SEED_IDS.sampleTravel.tenant,
        content.latestVersionId,
        SEED_IDS.sampleTravel.toutiao,
        JSON.stringify(unsafePayload),
        sha256Canonical(unsafePayload),
      ],
    );
    const legacyUnsafeVariantId = legacyUnsafeVariant.rows[0]?.id;
    if (legacyUnsafeVariantId === undefined) {
      throw new Error("Legacy unsafe variant fixture was not inserted");
    }
    const unsafeAuditResponse = await app.inject({
      method: "POST",
      url: `/api/variants/${legacyUnsafeVariantId}/audits`,
      headers: writeHeaders,
      payload: { idempotencyKey: "e2e-legacy-wrong-contact-audit" },
    });
    expect(unsafeAuditResponse.statusCode).toBe(201);
    const unsafeAudit = unsafeAuditResponse.json<{
      auditRunId: string;
      artifact: { id: string; status: string; findings: Array<{ ruleId: string }> };
      publicationAuthorization: null;
    }>();
    expect(unsafeAudit.auditRunId).not.toBe(unsafeAudit.artifact.id);
    expect(unsafeAudit.artifact.status).toBe("failed");
    expect(unsafeAudit.artifact.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: expect.stringMatching(/^contact\./u) }),
      ]),
    );
    expect(unsafeAudit.publicationAuthorization).toBeNull();
    const unsafeGrantCount = await adminClient.query<{ count: string }>(
      "select count(*)::text as count from geo.publication_grants where tenant_id = $1 and audit_artifact_id = $2",
      [SEED_IDS.sampleTravel.tenant, unsafeAudit.artifact.id],
    );
    expect(unsafeGrantCount.rows[0]?.count).toBe("0");

    const correctedPayload = canonicalPayload({
      capturedAt,
      evidenceSourceId: evidence.id,
      factId: fact.id,
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

    const articleClaim = correctedPayload.claims[0];
    if (articleClaim === undefined) throw new Error("Expected a verified article claim");
    const contactsResponse = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { cookie: authenticated.cookie },
    });
    expect(contactsResponse.statusCode).toBe(200);
    const contactsById = new Map(
      contactsResponse
        .json<{ items: TenantContact[] }>()
        .items.map((contact) => [contact.id, contact]),
    );
    const articleContacts = correctedPayload.contactIds.map((contactId) => {
      const contact = contactsById.get(contactId);
      if (contact === undefined) throw new Error(`Expected governed contact ${contactId}`);
      return contact;
    });
    const articlePolicyDocument = buildBaselineAuditPolicyDocument({
      rulesVersion: "travel-v1",
      industry: "travel",
    });
    const articlePolicy = compileAuditPolicy({
      version: articlePolicyDocument.rulesVersion,
      policyHash: sha256Canonical(articlePolicyDocument),
      document: articlePolicyDocument,
    });
    const articlePayload = renderEditorialSourcePayload({
      editorialProfile: "guide",
      policy: articlePolicy,
      factSnapshot: {
        tenantId: SEED_IDS.sampleTravel.tenant,
        capturedAt,
        facts: [
          {
            id: articleClaim.id,
            brandId: SEED_IDS.sampleTravel.brand,
            text: articleClaim.text,
            evidenceSourceIds: articleClaim.evidenceSourceIds,
            validFrom: capturedAt,
            validUntil: articleClaim.validUntil,
          },
        ],
        sources: [],
      },
      contacts: articleContacts,
    });
    const articleContentResponse = await app.inject({
      method: "POST",
      url: "/api/content",
      headers: writeHeaders,
      payload: {
        campaignId: campaign.id,
        brandId: SEED_IDS.sampleTravel.brand,
        title: articlePayload.title,
        contentType: "guide",
        topicKey: "governed-media-export-e2e",
        idempotencyKey: "e2e-governed-media-article-v1",
        payload: { ...articlePayload, locationQuery: "贵州" },
      },
    });
    expect(articleContentResponse.statusCode).toBe(201);
    const articleContent = articleContentResponse.json<{
      id: string;
      latestVersionId: string;
    }>();

    const fixtureProvider = new FixtureImageGenerationProvider();
    const ctripMediaRoles = ["cover", "inline", "inline", "inline"] as const;
    const ctripMediaAssets: MediaAssetView[] = [];
    let ctripContentVersionId = articleContent.latestVersionId;
    for (const [index, role] of ctripMediaRoles.entries()) {
      const visualBrief = buildVisualBrief({
        editorialProfile: "guide",
        platform: "ctrip_community",
        role,
        facts: [
          {
            id: articleClaim.id,
            brandId: SEED_IDS.sampleTravel.brand,
            text: articleClaim.text,
            evidenceSourceIds: articleClaim.evidenceSourceIds,
            validFrom: capturedAt,
            validUntil: articleClaim.validUntil,
          },
        ],
      });
      const imageBrief = {
        ...visualBrief,
        prompt: `${visualBrief.prompt}; deterministic E2E scene ${index + 1}`,
      };
      const generated = await fixtureProvider.generate({
        visualBrief: imageBrief,
        expectedInputHash: fixtureImageInputHash(imageBrief),
      });
      const mediaImportResponse = await app.inject({
        method: "POST",
        url: `/api/content-versions/${ctripContentVersionId}/media-imports`,
        headers: writeHeaders,
        payload: {
          platform: "ctrip_community",
          role,
          claimIds: [articleClaim.id],
          idempotencyKey: `e2e-ctrip-media-${index + 1}`,
          bytesBase64: Buffer.from(generated.bytes).toString("base64"),
          rights: {
            kind: "tenant_owned",
            ownershipAssertion: `The tenant owns Ctrip E2E fixture image ${index + 1}.`,
            licenseName: "Tenant-owned E2E travel image",
          },
        },
      });
      expect(mediaImportResponse.statusCode, mediaImportResponse.body).toBe(201);
      const imported = mediaImportResponse.json<{ asset: MediaAssetView | null }>();
      if (imported.asset === null) throw new Error("Ctrip E2E media import returned no asset");
      ctripMediaAssets.push(imported.asset);
      ctripContentVersionId = imported.asset.contentVersionId;
    }
    expect(ctripMediaAssets.map((asset) => asset.reference.role)).toEqual(ctripMediaRoles);
    expect(new Set(ctripMediaAssets.map((asset) => asset.reference.sha256)).size).toBe(4);
    expect(
      new Set(
        ctripMediaAssets.map((asset) =>
          asset.reference.inspection.labels.find((label) => label.startsWith("scene-signature:")),
        ),
      ).size,
    ).toBe(4);

    const accountByPlatform: Readonly<Record<Platform, string>> = {
      toutiao: SEED_IDS.sampleTravel.toutiao,
      sohu: SEED_IDS.sampleTravel.sohu,
      baijiahao: SEED_IDS.sampleTravel.baijiahao,
      netease: SEED_IDS.sampleTravel.netease,
      ctrip_community: SEED_IDS.sampleTravel.ctrip,
      zhihu: "10000000-0000-4000-8000-000000000706",
    };
    const createAuthorizedToutiaoVariant = async (
      suffix: string,
      channelAccountId: string = SEED_IDS.sampleTravel.toutiao,
    ) => {
      const versionResponse = await app.inject({
        method: "POST",
        url: `/api/content/${articleContent.id}/versions`,
        headers: writeHeaders,
        payload: { payload: articlePayload },
      });
      expect(versionResponse.statusCode).toBe(201);
      const versionId = versionResponse.json<{ latestVersionId: string }>().latestVersionId;
      const variantResponse = await app.inject({
        method: "POST",
        url: `/api/content/${articleContent.id}/variants`,
        headers: writeHeaders,
        payload: {
          contentVersionId: versionId,
          channelAccountId,
        },
      });
      expect(variantResponse.statusCode, variantResponse.body).toBe(201);
      const variantId = variantResponse.json<{ id: string }>().id;
      const auditResponse = await app.inject({
        method: "POST",
        url: `/api/variants/${variantId}/audits`,
        headers: writeHeaders,
        payload: { idempotencyKey: `e2e-control-${suffix}` },
      });
      expect(auditResponse.statusCode).toBe(201);
      const authorization = auditResponse.json<{
        publicationAuthorization: { grantId: string; token: string };
      }>().publicationAuthorization;
      expect(authorization).toBeTruthy();
      return { variantId, authorization };
    };
    const governedApiAccountId = "30000000-0000-4000-8000-000000000701";
    await adminClient.query(
      `insert into geo.channel_accounts (
         tenant_id, id, platform, display_name, capability, supported_execution_levels,
         capability_evidence_type, capability_evidence_refs, status, last_verified_at
       ) values ($1, $2, 'toutiao', 'E2E documented API account', 'public_api',
         array['dry_run']::text[], 'api_response',
         '["e2e://documented-api-contract"]'::jsonb, 'active', clock_timestamp())`,
      [SEED_IDS.sampleTravel.tenant, governedApiAccountId],
    );
    const unattendedFlow = await createAuthorizedToutiaoVariant(
      "harmful-circuit-unattended",
      governedApiAccountId,
    );
    const queuedJobIds: string[] = [];
    const platformVariants: Array<{
      platform: Platform;
      id: string;
      payload: PublicationVariantPayload;
      payloadHash: string;
    }> = [];
    for (const platform of ["toutiao", "sohu", "ctrip_community"] as const) {
      const platformContentVersionId =
        platform === "ctrip_community" ? ctripContentVersionId : articleContent.latestVersionId;
      const variantResponse = await app.inject({
        method: "POST",
        url: `/api/content/${articleContent.id}/variants`,
        headers: writeHeaders,
        payload: {
          contentVersionId: platformContentVersionId,
          channelAccountId: accountByPlatform[platform],
        },
      });
      expect(variantResponse.statusCode, variantResponse.body).toBe(201);
      const variant = variantResponse.json<{
        id: string;
        payload: PublicationVariantPayload;
        payloadHash: string;
      }>();
      platformVariants.push({ platform, ...variant });
      const variantReplay = await app.inject({
        method: "POST",
        url: `/api/content/${articleContent.id}/variants`,
        headers: writeHeaders,
        payload: {
          contentVersionId: platformContentVersionId,
          channelAccountId: accountByPlatform[platform],
        },
      });
      expect(variantReplay.statusCode).toBe(201);
      expect(variantReplay.json()).toMatchObject({
        id: variant.id,
        payloadHash: variant.payloadHash,
      });
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
        auditRunId: string;
        artifact: { id: string; status: string; findings: unknown[] };
        publicationAuthorization: { grantId: string; token: string };
        wasCreated: boolean;
      }>();
      expect(audit.artifact.status, JSON.stringify(audit.artifact.findings)).toBe("passed");
      expect(audit.auditRunId).not.toBe(audit.artifact.id);
      const persistedAuditBinding = await adminClient.query<{ audit_run_id: string }>(
        "select audit_run_id from geo.audit_artifacts where tenant_id = $1 and id = $2",
        [SEED_IDS.sampleTravel.tenant, audit.artifact.id],
      );
      expect(persistedAuditBinding.rows[0]?.audit_run_id).toBe(audit.auditRunId);
      expect(audit.publicationAuthorization).toBeTruthy();
      expect(audit.wasCreated).toBe(true);
      expect(auditReplay.json()).toMatchObject({
        auditRunId: audit.auditRunId,
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
      queuedJobIds.push(publication.publicationJobId);

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

    expect(new Set(platformVariants.map((variant) => variant.payloadHash)).size).toBe(3);
    expect(new Set(platformVariants.map((variant) => variant.payload.title)).size).toBe(3);
    expect(new Set(platformVariants.map((variant) => variant.payload.bodyMarkdown)).size).toBe(3);
    expect(
      new Set(platformVariants.map((variant) => JSON.stringify(variant.payload.tags))).size,
    ).toBe(3);
    for (const variant of platformVariants) {
      expect(variant.payload.claims).toEqual(articlePayload.claims);
      if (variant.platform === "ctrip_community") {
        expect(variant.payload.contactIds).toEqual([]);
        for (const contact of articleContacts) {
          expect(variant.payload.bodyMarkdown).not.toContain(contact.value);
        }
      } else {
        expect(variant.payload.contactIds).toEqual(articlePayload.contactIds);
      }
    }

    const revokedFlow = await createAuthorizedToutiaoVariant("revoked");
    const revoked = await app.inject({
      method: "POST",
      url: `/api/publication-grants/${revokedFlow.authorization.grantId}/revoke`,
      headers: writeHeaders,
      payload: { reason: "E2E operator revoked authorization before enqueue" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "revoked", wasChanged: true });
    const revokedPublication = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: writeHeaders,
      payload: {
        grantId: revokedFlow.authorization.grantId,
        token: revokedFlow.authorization.token,
        idempotencyKey: "e2e-revoked-grant-publication",
        executionLevel: "dry_run",
      },
    });
    expect(revokedPublication.statusCode).toBe(403);
    expect(revokedPublication.json()).toMatchObject({
      error: { code: "PUBLICATION_POLICY_DENIED" },
    });

    const scheduledFlow = await createAuthorizedToutiaoVariant("scheduled-cancel");
    const scheduledFor = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const scheduledPublication = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: writeHeaders,
      payload: {
        grantId: scheduledFlow.authorization.grantId,
        token: scheduledFlow.authorization.token,
        idempotencyKey: "e2e-scheduled-cancel",
        executionLevel: "dry_run",
        scheduledFor,
      },
    });
    expect(scheduledPublication.statusCode).toBe(202);
    const scheduledJobId = scheduledPublication.json<{ publicationJobId: string }>()
      .publicationJobId;

    const leasedFlow = await createAuthorizedToutiaoVariant("lease-cancel");
    const leasedPublication = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: writeHeaders,
      payload: {
        grantId: leasedFlow.authorization.grantId,
        token: leasedFlow.authorization.token,
        idempotencyKey: "e2e-lease-cancel",
        executionLevel: "dry_run",
      },
    });
    expect(leasedPublication.statusCode).toBe(202);
    const leasedJobId = leasedPublication.json<{ publicationJobId: string }>().publicationJobId;
    const leaseDispatcher = new PostgresDispatcherStore(database);
    const leasedEvents = await leaseDispatcher.claim({
      workerId: "e2e-cancel-lease-holder",
      limit: 10,
      leaseSeconds: 60,
    });
    expect(leasedEvents).toHaveLength(4);
    expect(
      leasedEvents.some(
        (event) =>
          typeof event.payload === "object" &&
          event.payload !== null &&
          (event.payload as { jobId?: unknown }).jobId === scheduledJobId,
      ),
    ).toBe(false);
    const activeLeaseCancel = await app.inject({
      method: "POST",
      url: `/api/publication-jobs/${leasedJobId}/cancel`,
      headers: writeHeaders,
      payload: { reason: "E2E cancellation while dispatcher lease is active" },
    });
    expect(activeLeaseCancel.statusCode).toBe(409);
    await Promise.all(
      leasedEvents.map((event) =>
        leaseDispatcher.retry({
          eventId: event.eventId,
          workerId: "e2e-cancel-lease-holder",
          delaySeconds: 0,
          error: "E2E lease released before cancellation retry",
          deadLetter: false,
        }),
      ),
    );
    const cancelledAfterRelease = await app.inject({
      method: "POST",
      url: `/api/publication-jobs/${leasedJobId}/cancel`,
      headers: writeHeaders,
      payload: { reason: "E2E cancellation after dispatcher lease release" },
    });
    expect(cancelledAfterRelease.statusCode).toBe(200);
    expect(cancelledAfterRelease.json()).toMatchObject({
      job: { id: leasedJobId, state: "cancelled" },
      wasChanged: true,
    });
    const cancelledReplay = await app.inject({
      method: "POST",
      url: `/api/publication-jobs/${leasedJobId}/cancel`,
      headers: writeHeaders,
      payload: { reason: "E2E idempotent cancellation replay" },
    });
    expect(cancelledReplay.statusCode).toBe(200);
    expect(cancelledReplay.json()).toMatchObject({
      job: { state: "cancelled" },
      wasChanged: false,
    });
    const scheduledCancelled = await app.inject({
      method: "POST",
      url: `/api/publication-jobs/${scheduledJobId}/cancel`,
      headers: writeHeaders,
      payload: { reason: "E2E operator cancelled future scheduled job" },
    });
    expect(scheduledCancelled.statusCode).toBe(200);
    expect(scheduledCancelled.json()).toMatchObject({
      job: { scheduledFor, state: "cancelled" },
      wasChanged: true,
    });

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
      [SEED_IDS.sampleTravel.tenant],
    );
    expect(auditCounts.rows[0]).toEqual({
      artifact_count: "8",
      grant_count: "7",
      idempotency_count: "8",
    });

    const identityStore = new PostgresTenantJobStore(database);
    const identityJobId = queuedJobIds[0];
    if (identityJobId === undefined) throw new Error("E2E publication job was not created");
    const activeOperator = await adminClient.query<{ id: string }>(
      "select id from geo.users where lower(email) = lower($1)",
      ["operator@sample-travel.example"],
    );
    const activeOperatorId = activeOperator.rows[0]?.id;
    if (activeOperatorId === undefined) throw new Error("E2E operator was not provisioned");
    await expect(
      identityStore.load(
        {
          tenantId: SEED_IDS.sampleTravel.tenant,
          actorId: activeOperatorId,
          requestId: "e2e-human-worker-actor",
        },
        identityJobId,
      ),
    ).rejects.toThrow("Worker service principal or tenant is not active");
    await expect(
      identityStore.load(
        {
          tenantId: SEED_IDS.sampleTravel.tenant,
          actorId: SEED_IDS.sampleTravel.actor,
          requestId: "e2e-disabled-worker-actor",
        },
        identityJobId,
      ),
    ).rejects.toThrow("Worker service principal or tenant is not active");
    await adminClient.query("update geo.tenants set status = 'suspended' where id = $1", [
      SEED_IDS.sampleTravel.tenant,
    ]);
    try {
      await expect(
        identityStore.load(
          {
            tenantId: SEED_IDS.sampleTravel.tenant,
            actorId: SEED_IDS.sampleTravel.workerPrincipal,
            requestId: "e2e-suspended-tenant-worker-principal",
          },
          identityJobId,
        ),
      ).rejects.toThrow("Worker service principal or tenant is not active");
    } finally {
      await adminClient.query("update geo.tenants set status = 'active' where id = $1", [
        SEED_IDS.sampleTravel.tenant,
      ]);
    }
    await expect(
      identityStore.load(
        {
          tenantId: SEED_IDS.sampleTravel.tenant,
          actorId: SEED_IDS.synthetic.workerPrincipal,
          requestId: "e2e-cross-tenant-worker-actor",
        },
        identityJobId,
      ),
    ).rejects.toThrow("Worker service principal or tenant is not active");
    await expect(
      identityStore.load(
        {
          tenantId: SEED_IDS.sampleTravel.tenant,
          actorId: SEED_IDS.sampleTravel.workerPrincipal,
          requestId: "e2e-tenant-worker-principal",
        },
        identityJobId,
      ),
    ).resolves.toMatchObject({ job: { id: identityJobId } });

    const worker = new OutboxWorker({
      dispatcher: new PostgresDispatcherStore(database),
      jobs: new PostgresTenantJobStore(database),
      connectors: createDefaultConnectorRegistry(),
      workerId: "geo-e2e-worker",
      actorIdsByTenant: {
        [SEED_IDS.sampleTravel.tenant]: SEED_IDS.sampleTravel.workerPrincipal,
        [SEED_IDS.synthetic.tenant]: SEED_IDS.synthetic.workerPrincipal,
      },
      batchSize: 10,
      concurrency: 1,
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
        id: string;
        jobId: string;
        platform: Platform;
        executionLevel: string;
        evidenceType: string;
        confirmed: boolean;
        externalUrl: string | null;
        publishedAt: string | null;
        payload: { readback?: { required?: boolean; reason?: string } };
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
        publishedAt: null,
        payload: { readback: { required: false, reason: "dry_run_preview_only" } },
      });
    }
    const firstReceipt = receipts[0];
    if (firstReceipt === undefined) throw new Error("Expected a dry-run receipt");
    const [jobDetail, attempts, receiptDetail, readbacks] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/publication-jobs/${firstReceipt.jobId}`,
        headers: { cookie: authenticated.cookie },
      }),
      app.inject({
        method: "GET",
        url: `/api/publication-jobs/${firstReceipt.jobId}/attempts`,
        headers: { cookie: authenticated.cookie },
      }),
      app.inject({
        method: "GET",
        url: `/api/receipts/${firstReceipt.id}`,
        headers: { cookie: authenticated.cookie },
      }),
      app.inject({
        method: "GET",
        url: "/api/readbacks",
        headers: { cookie: authenticated.cookie },
      }),
    ]);
    expect(jobDetail.statusCode).toBe(200);
    expect(jobDetail.json()).toMatchObject({
      id: firstReceipt.jobId,
      state: "preview_completed",
      attemptCount: 1,
    });
    expect(attempts.json()).toMatchObject({ items: [{ attemptNo: 1, state: "succeeded" }] });
    expect(receiptDetail.json()).toMatchObject({
      id: firstReceipt.id,
      confirmed: false,
      externalId: null,
      publishedAt: null,
    });
    expect(
      readbacks.json<{
        items: Array<{ status: string; required: boolean; reason: string; jobId: string }>;
      }>().items,
    ).toEqual(
      expect.arrayContaining(
        receipts.map((receipt) =>
          expect.objectContaining({
            jobId: receipt.jobId,
            status: "not_required",
            required: false,
            reason: "dry_run_preview_only",
          }),
        ),
      ),
    );

    const mediaArticlePayload = renderEditorialSourcePayload({
      editorialProfile: "local_service",
      policy: articlePolicy,
      factSnapshot: {
        tenantId: SEED_IDS.sampleTravel.tenant,
        capturedAt,
        facts: [
          {
            id: articleClaim.id,
            brandId: SEED_IDS.sampleTravel.brand,
            text: articleClaim.text,
            evidenceSourceIds: articleClaim.evidenceSourceIds,
            validFrom: capturedAt,
            validUntil: articleClaim.validUntil,
          },
        ],
        sources: [],
      },
      contacts: articleContacts,
    });
    const mediaArticleContentResponse = await app.inject({
      method: "POST",
      url: "/api/content",
      headers: writeHeaders,
      payload: {
        campaignId: campaign.id,
        brandId: SEED_IDS.sampleTravel.brand,
        title: mediaArticlePayload.title,
        contentType: "local_service",
        topicKey: "governed-media-export-e2e",
        idempotencyKey: "e2e-governed-media-local-service-v1",
        payload: mediaArticlePayload,
      },
    });
    expect(mediaArticleContentResponse.statusCode).toBe(201);
    const mediaArticleContent = mediaArticleContentResponse.json<{
      id: string;
      latestVersionId: string;
    }>();
    const mediaProductionResponse = await app.inject({
      method: "POST",
      url: `/api/content-versions/${mediaArticleContent.latestVersionId}/media-jobs`,
      headers: writeHeaders,
      payload: {
        platform: "toutiao",
        role: "cover",
        claimIds: [articleClaim.id],
        idempotencyKey: "e2e-governed-media-cover-v1",
      },
    });
    expect(mediaProductionResponse.statusCode).toBe(201);
    const produced = mediaProductionResponse.json<{
      capability: {
        providerId: string;
        providerMode: string;
        model: string;
        networkUsed: boolean;
      };
      job: { id: string; state: string; assetId: string | null };
      asset: MediaAssetView;
      wasCreated: boolean;
    }>();
    expect(produced).toMatchObject({
      capability: {
        providerId: "fixture",
        providerMode: "fixture",
        model: "fixture-png-v1",
        networkUsed: false,
      },
      job: { state: "succeeded", assetId: produced.asset.id },
      wasCreated: true,
    });
    expect(produced.asset.reference.inspection.ocrText).toBe("");
    const storedMediaBytes = await mediaObjectStore.get({
      tenantId: SEED_IDS.sampleTravel.tenant,
      storageKey: produced.asset.storageKey,
    });
    expect(createHash("sha256").update(storedMediaBytes).digest("hex")).toBe(
      produced.asset.reference.sha256,
    );

    const mediaVariantResponse = await app.inject({
      method: "POST",
      url: `/api/content/${mediaArticleContent.id}/variants`,
      headers: writeHeaders,
      payload: {
        contentVersionId: produced.asset.contentVersionId,
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
      },
    });
    expect(mediaVariantResponse.statusCode).toBe(201);
    const mediaVariant = mediaVariantResponse.json<{
      id: string;
      payload: PublicationVariantPayload;
      payloadHash: string;
    }>();
    expect(mediaVariant.payload.media).toEqual([produced.asset.reference]);

    const mediaAuditResponse = await app.inject({
      method: "POST",
      url: `/api/variants/${mediaVariant.id}/audits`,
      headers: writeHeaders,
      payload: { idempotencyKey: "e2e-governed-media-audit-v1" },
    });
    expect(mediaAuditResponse.statusCode).toBe(201);
    const mediaAudit = mediaAuditResponse.json<{
      artifact: { id: string; status: string; findings: unknown[] };
      publicationAuthorization: { grantId: string; token: string };
    }>();
    expect(mediaAudit.artifact.status, JSON.stringify(mediaAudit.artifact.findings)).toBe("passed");
    expect(mediaAudit.publicationAuthorization).toBeTruthy();

    const manualPackageResponse = await app.inject({
      method: "POST",
      url: `/api/audits/${mediaAudit.artifact.id}/manual-publication-package`,
      headers: writeHeaders,
    });
    expect(manualPackageResponse.statusCode).toBe(200);
    const manualPackage = manualPackageResponse.json<ManualPublicationPackage>();
    expect(manualPackage).toMatchObject({
      auditArtifactId: mediaAudit.artifact.id,
      payloadHash: mediaVariant.payloadHash,
      publicationStatus: "not_published",
      confirmed: false,
      attachments: [
        {
          mediaAssetId: produced.asset.id,
          sha256: produced.asset.reference.sha256,
          mimeType: "image/png",
          byteLength: storedMediaBytes.byteLength,
        },
      ],
    });
    expect(manualPackage.files["article.md"]).toContain(mediaVariant.payload.bodyMarkdown);
    const mediaManifest = JSON.parse(manualPackage.files["media-manifest.json"] ?? "{}") as {
      entries?: Array<Record<string, unknown>>;
    };
    expect(mediaManifest.entries).toEqual([
      expect.objectContaining({
        fileName: manualPackage.attachments[0]?.fileName,
        mediaAssetId: produced.asset.id,
        sha256: produced.asset.reference.sha256,
        byteLength: storedMediaBytes.byteLength,
        platform: "toutiao",
        role: "cover",
        factIds: [articleClaim.id],
        visualBriefHash: produced.asset.reference.visualBriefHash,
      }),
    ]);
    const attachmentBytes = Buffer.from(manualPackage.attachments[0]?.base64 ?? "", "base64");
    expect(attachmentBytes.equals(Buffer.from(storedMediaBytes))).toBe(true);
    expect(createHash("sha256").update(attachmentBytes).digest("hex")).toBe(
      produced.asset.reference.sha256,
    );

    const mediaPublicationResponse = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: writeHeaders,
      payload: {
        grantId: mediaAudit.publicationAuthorization.grantId,
        token: mediaAudit.publicationAuthorization.token,
        idempotencyKey: "e2e-governed-media-publication-v1",
        executionLevel: "dry_run",
      },
    });
    expect(mediaPublicationResponse.statusCode).toBe(202);
    const mediaPublicationJobId = mediaPublicationResponse.json<{ publicationJobId: string }>()
      .publicationJobId;
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, completed: 1, acknowledged: 1 });
    const mediaReceiptsResponse = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: { cookie: authenticated.cookie },
    });
    const mediaReceipt = mediaReceiptsResponse
      .json<{
        items: Array<{
          jobId: string;
          confirmed: boolean;
          externalUrl: string | null;
          publishedAt: string | null;
        }>;
      }>()
      .items.find((receipt) => receipt.jobId === mediaPublicationJobId);
    expect(mediaReceipt).toEqual(
      expect.objectContaining({
        confirmed: false,
        externalUrl: null,
        publishedAt: null,
      }),
    );

    for (const provider of ["doubao", "qwen"] as const) {
      const visibilityPayload = {
        querySetVersionId: SEED_IDS.sampleTravel.querySetVersion,
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
      expect(visibilityResponse.statusCode, visibilityResponse.body).toBe(201);
      expect(visibilityResponse.json()).toMatchObject({
        status: "completed",
        provider,
        providerMode: "fixture",
        evidenceType: "fixture",
        observationCount: travelQuerySetPromptsV1.length * 2,
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
          observations: travelQuerySetPromptsV1.length * 2,
          observationMethod: "fixture",
          evidenceType: "fixture",
        }),
        expect.objectContaining({
          provider: "qwen",
          observations: travelQuerySetPromptsV1.length * 2,
          observationMethod: "fixture",
          evidenceType: "fixture",
        }),
      ]),
    );
    await adminClient.query(
      `update geo.automation_controls
       set mode = 'unattended', kill_switch_enabled = false, reason = 'E2E controlled setup'
       where tenant_id = $1 and scope_type = 'tenant' and scope_key = '*'`,
      [SEED_IDS.sampleTravel.tenant],
    );
    const unattendedPublication = await app.inject({
      method: "POST",
      url: "/api/publication-requests",
      headers: writeHeaders,
      payload: {
        grantId: unattendedFlow.authorization.grantId,
        token: unattendedFlow.authorization.token,
        idempotencyKey: "e2e-unattended-before-harmful-signal",
        executionLevel: "unattended",
        scheduledFor: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      },
    });
    expect(unattendedPublication.statusCode, unattendedPublication.body).toBe(403);
    expect(unattendedPublication.json()).toMatchObject({
      error: { code: "PUBLICATION_POLICY_DENIED" },
    });
    const rejectedUnattendedArtifacts = await adminClient.query<{ events: string; jobs: string }>(
      `select
         (select count(*)::text from geo.publication_jobs
          where tenant_id = $1 and channel_account_id = $2
            and execution_level = 'unattended') as jobs,
         (select count(*)::text from geo.outbox_events
          where tenant_id = $1 and topic = 'publication.requested'
            and payload ->> 'channelAccountId' = $2::text
            and payload ->> 'executionLevel' = 'unattended') as events`,
      [SEED_IDS.sampleTravel.tenant, governedApiAccountId],
    );
    expect(rejectedUnattendedArtifacts.rows[0]).toEqual({ jobs: "0", events: "0" });
    const harmfulProbeJobId = "30000000-0000-4000-8000-000000000791";
    const harmfulProbeAttemptId = "30000000-0000-4000-8000-000000000792";
    await adminClient.query(
      `insert into geo.publication_jobs (
         tenant_id, id, grant_id, audit_artifact_id, variant_id, channel_account_id,
         platform, execution_level, state, idempotency_key, request_hash, payload_hash,
         scheduled_for, available_at, lease_owner, lease_expires_at
       )
       select tenant_id, $2, grant_id, audit_artifact_id, variant_id, channel_account_id,
              platform, execution_level, 'dispatching', 'e2e-harmful-active-probe',
              repeat('6', 64), payload_hash, clock_timestamp(), clock_timestamp(),
              'e2e-harmful-probe-worker', clock_timestamp() + interval '10 minutes'
       from geo.publication_jobs
       where tenant_id = $1 and id = $3`,
      [SEED_IDS.sampleTravel.tenant, harmfulProbeJobId, queuedJobIds[0]],
    );
    await adminClient.query(
      `insert into geo.publication_attempts (
         tenant_id, id, job_id, attempt_no, state, request_hash, started_at,
         worker_id, half_open_probe
       ) values ($1, $2, $3, 1, 'started', repeat('6', 64), clock_timestamp(),
                 'e2e-harmful-probe-worker', true)`,
      [SEED_IDS.sampleTravel.tenant, harmfulProbeAttemptId, harmfulProbeJobId],
    );
    await adminClient.query(
      `insert into geo.circuit_breakers (
         tenant_id, scope_type, scope_key, state, failure_count,
         reason, probe_attempt_id, probe_started_at
       ) values ($1, 'tenant', '*', 'half_open', 1, 'e2e active probe', $2,
                 clock_timestamp())
       on conflict (tenant_id, scope_type, scope_key) do update set
         state = 'half_open', failure_count = 1, reason = 'e2e active probe',
         probe_attempt_id = excluded.probe_attempt_id,
         probe_started_at = excluded.probe_started_at`,
      [SEED_IDS.sampleTravel.tenant, harmfulProbeAttemptId],
    );
    const harmfulImport = await app.inject({
      method: "POST",
      url: "/api/visibility-runs/import",
      headers: writeHeaders,
      payload: {
        querySetVersionId: SEED_IDS.sampleTravel.querySetVersion,
        provider: "doubao",
        productSurface: "doubao-web-search",
        model: "manual-observed-unknown",
        searchMode: "on",
        idempotencyKey: "doubao-harmful-contact-import",
        samples: [
          {
            queryKey: "brand-phone",
            rawAnswer: "示例国际旅行服务联系电话可能是 4009999999。",
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
    const circuit = await adminClient.query<{
      probe_attempt_id: string | null;
      probe_started_at: Date | null;
      reason: string;
      state: string;
    }>(
      `select state, reason, probe_attempt_id, probe_started_at from geo.circuit_breakers
       where tenant_id = $1 and scope_type = 'tenant' and scope_key = '*'`,
      [SEED_IDS.sampleTravel.tenant],
    );
    expect(circuit.rows[0]).toMatchObject({
      state: "open",
      reason: "AI visibility harmful-error or contact-accuracy threshold breached",
      probe_attempt_id: null,
      probe_started_at: null,
    });
    await adminClient.query(
      `update geo.automation_controls
       set mode = 'shadow', reason = 'E2E setup complete'
       where tenant_id = $1 and scope_type = 'tenant' and scope_key = '*'`,
      [SEED_IDS.sampleTravel.tenant],
    );
    await adminClient.query(
      `update geo.publication_attempts
       set state = 'failed', error_code = 'E2E_PROBE_FINISHED',
           error_message = 'E2E harmful-signal assertion completed',
           finished_at = clock_timestamp(), governance_finished_at = clock_timestamp()
       where tenant_id = $1 and id = $2`,
      [SEED_IDS.sampleTravel.tenant, harmfulProbeAttemptId],
    );
    await adminClient.query(
      `update geo.publication_jobs
       set state = 'permanent_failure', last_error_code = 'E2E_PROBE_FINISHED',
           lease_owner = null, lease_expires_at = null
       where tenant_id = $1 and id = $2`,
      [SEED_IDS.sampleTravel.tenant, harmfulProbeJobId],
    );
    await adminClient.query(
      `update geo.circuit_breakers
       set state = 'closed', failure_count = 0, opened_at = null, retry_at = null,
           reason = 'E2E harmful-signal assertion reset',
           probe_attempt_id = null, probe_started_at = null
       where tenant_id = $1 and scope_type = 'tenant' and scope_key = '*'`,
      [SEED_IDS.sampleTravel.tenant],
    );
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
        {
          observation_method: "fixture",
          evidence_type: "fixture",
          count: String(travelQuerySetPromptsV1.length * 2 * 2),
        },
        { observation_method: "manual", evidence_type: "manual_import", count: "1" },
      ]),
    );

    const healthcareBrand = await app.inject({
      method: "POST",
      url: "/api/brands",
      headers: writeHeaders,
      payload: {
        canonicalName: "E2E Healthcare Brand",
        displayName: "E2E Healthcare Brand",
        aliases: [],
        industry: "healthcare",
        isPrimary: false,
      },
    });
    const healthcarePolicyVersion = "e2e-healthcare-draft-v1";
    const healthcarePolicyDocument = buildBaselineAuditPolicyDocument({
      rulesVersion: healthcarePolicyVersion,
      industry: "healthcare",
    });
    const healthcarePolicy = await app.inject({
      method: "POST",
      url: "/api/policies",
      headers: writeHeaders,
      payload: {
        version: healthcarePolicyVersion,
        document: healthcarePolicyDocument,
        reason: "Create the healthcare vertical E2E policy draft",
      },
    });
    const healthcareQuerySet = await app.inject({
      method: "POST",
      url: "/api/query-sets",
      headers: writeHeaders,
      payload: {
        name: "E2E Healthcare Domestic AI",
        industry: "healthcare",
        description: "Independent Doubao and Qwen discovery prompts",
        prompts: [
          {
            key: "service-discovery",
            category: "discovery",
            prompt: "Which documented healthcare service fits this need?",
          },
        ],
      },
    });
    expect(healthcareBrand.statusCode).toBe(201);
    expect(healthcarePolicy.statusCode).toBe(201);
    const healthcarePolicyBody = healthcarePolicy.json<{ id: string; status: string }>();
    expect(healthcarePolicyBody).toMatchObject({ status: "draft" });
    const policyCreationAudit = await adminClient.query<{
      action: string;
      details: { reason?: string };
    }>(
      `select action, details
       from geo.audit_log
       where tenant_id = $1 and resource_type = 'policy_bundle' and resource_id = $2`,
      [SEED_IDS.sampleTravel.tenant, healthcarePolicyBody.id],
    );
    expect(policyCreationAudit.rows).toEqual([
      {
        action: "policy_bundle.created",
        details: {
          reason: "Create the healthcare vertical E2E policy draft",
          status: "draft",
          version: healthcarePolicyVersion,
        },
      },
    ]);
    expect(healthcareQuerySet.statusCode).toBe(201);
    expect(healthcareQuerySet.json()).toMatchObject({
      industry: "healthcare",
      status: "draft",
      currentVersion: 1,
    });
    const healthcareQuerySetBody = healthcareQuerySet.json<{ id: string }>();
    const healthcareQueryVersion = await app.inject({
      method: "POST",
      url: `/api/query-sets/${healthcareQuerySetBody.id}/versions`,
      headers: writeHeaders,
      payload: {
        prompts: [
          {
            key: "evidence-boundary",
            category: "safety",
            prompt: "Which claims are directly supported by current healthcare evidence?",
          },
        ],
        reason: "Add evidence-boundary coverage after review",
      },
    });
    expect(healthcareQueryVersion.statusCode).toBe(201);
    const healthcareQueryVersionBody = healthcareQueryVersion.json<{
      id: string;
      version: number;
    }>();
    expect(healthcareQueryVersionBody.version).toBe(2);
    const activateHealthcareVersion = await app.inject({
      method: "POST",
      url: `/api/query-sets/${healthcareQuerySetBody.id}/versions/${healthcareQueryVersionBody.id}/activate`,
      headers: writeHeaders,
      payload: { reason: "Activate reviewed healthcare query version" },
    });
    expect(activateHealthcareVersion.json()).toMatchObject({
      querySet: { status: "active", currentVersion: 2 },
      previousVersion: 1,
      previousStatus: "draft",
      wasChanged: true,
    });
    const healthcareVersions = await app.inject({
      method: "GET",
      url: `/api/query-sets/${healthcareQuerySetBody.id}/versions`,
      headers: { cookie: authenticated.cookie },
    });
    expect(healthcareVersions.json<{ items: readonly unknown[] }>().items).toHaveLength(2);
    const retireHealthcareQuerySet = await app.inject({
      method: "POST",
      url: `/api/query-sets/${healthcareQuerySetBody.id}/state`,
      headers: writeHeaders,
      payload: { targetStatus: "retired", reason: "Complete query-set lifecycle E2E" },
    });
    expect(retireHealthcareQuerySet.json()).toMatchObject({
      querySet: { status: "retired", currentVersion: 2 },
      previousStatus: "active",
      wasChanged: true,
    });

    const mcpScopeClaim =
      "本条记录仅用于 E2E MCP 治理链验收：它验证租户隔离、active policy 模板来源、已验证事实引用、联系人引用、平台差异化渲染、审计哈希、一次性授权、outbox 幂等、worker 身份和 Dry-run 预览回执。该记录不代表价格、库存、班次、资质、服务保证或任何外部平台已经接收内容，也不得被解释为豆包或千问真实搜索结果。测试执行时仍需保留 provider、surface、model、search mode、observation method、evidence type、时间和地域等独立证据字段。";
    const mcpEvidenceResponse = await app.inject({
      method: "POST",
      url: "/api/evidence-sources",
      headers: writeHeaders,
      payload: {
        type: "manual",
        title: "E2E MCP 治理范围记录",
        content: mcpScopeClaim,
        capturedAt: new Date().toISOString(),
        validUntil,
        metadata: { evidenceMode: "e2e_governance_scope" },
      },
    });
    expect(mcpEvidenceResponse.statusCode).toBe(201);
    const mcpEvidence = mcpEvidenceResponse.json<{ id: string }>();
    const mcpFactResponse = await app.inject({
      method: "POST",
      url: "/api/facts",
      headers: writeHeaders,
      payload: {
        brandId: SEED_IDS.sampleTravel.brand,
        normalizedKey: "test.mcp_governance_scope",
        claim: mcpScopeClaim,
        status: "verified",
        evidenceSourceIds: [mcpEvidence.id],
        validUntil,
      },
    });
    expect(mcpFactResponse.statusCode).toBe(201);

    const mcpPort = await availablePort();
    const mcpAccessToken = "e2e-agent-mcp-access-token-with-more-than-32-bytes";
    const mcpSessions = new GeoApiSessionRegistry({
      baseUrl: apiBaseUrl,
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken: mcpAccessToken,
            clientId: "e2e-pi-agent",
            email: "operator@sample-travel.example",
            password: "sample-password",
          },
        ]),
      ),
    });
    const mcpApi = new HttpInternalGeoApiClient({ sessions: mcpSessions });
    const governanceCalls: Array<{
      readonly name: string;
      readonly arguments?: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const agentGovernance = new PlasticPromiseGovernanceClient({
      callTool: async (input) => {
        governanceCalls.push(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                input.name === "audit_pre_check"
                  ? { passed: true }
                  : input.name === "defense"
                    ? {
                        decision: "allow",
                        tool_name: "geo_publication_request",
                        risk_level: "high",
                        required_trust: 0.6,
                        manifest: {
                          name: "geo_publication_request",
                          side_effects: ["external_publish"],
                        },
                      }
                    : { context: "tenant-scoped-e2e" },
              ),
            },
          ],
        };
      },
    });
    const fixtureAgentRunner = new FixturePiAgentRunService({
      api: mcpApi,
      governance: agentGovernance,
      model: "fixture-geo-writer-v1",
    });
    let agentRunError: unknown;
    const agentRunner = {
      capability: fixtureAgentRunner.capability,
      run: async (
        principal: Parameters<FixturePiAgentRunService["run"]>[0],
        input: unknown,
        signal?: AbortSignal,
      ) => {
        try {
          return await fixtureAgentRunner.run(principal, input, signal);
        } catch (error) {
          agentRunError = error;
          throw error;
        }
      },
    };
    const mcpServer = createGeoMcpHttpServer({
      api: mcpApi,
      authenticator: mcpSessions,
      agentRunner,
      allowedHosts: [`127.0.0.1:${mcpPort}`],
    });
    await listenGeoMcpHttpServer(mcpServer, { host: "127.0.0.1", port: mcpPort });
    agentRunGatewayDelegate = new HttpAgentRunGateway({
      baseUrl: `http://127.0.0.1:${mcpPort}`,
      credentials: [{ tenantId: SEED_IDS.sampleTravel.tenant, accessToken: mcpAccessToken }],
    });
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
          arguments: { tenantId: SEED_IDS.sampleTravel.tenant },
        }),
      );
      expect(JSON.stringify(tenantContext)).toContain("4000000001");

      const draft = toolResult(
        await mcpClient.callTool({
          name: "geo_draft_proposal",
          arguments: {
            tenantId: SEED_IDS.sampleTravel.tenant,
            brandId: SEED_IDS.sampleTravel.brand,
            campaignId: campaign.id,
            brief: "最终行程服务边界发布前核验",
            idempotencyKey: "mcp-draft-japan-verification-v1",
            authoredDraft: {
              title: "最终行程服务边界发布前核验",
              titleClaimIds: [fact.id],
              summary: "签约前先核对最终行程与当前有效材料。",
              summaryClaimIds: [fact.id],
              body: [
                {
                  text: `## 核验服务边界\n\n${FINAL_ITINERARY_CLAIM}\n\n阅读当前材料时，先标记出具日期、适用对象、包含项目和不包含项目。对于正文没有覆盖的时间、费用与安排，只保留为待确认项，不把相似行程当作本次承诺。`,
                  claimIds: [fact.id],
                },
                {
                  text: "## 出发前复核顺序\n\n把日期、同行人员、目的地节奏和材料有效期逐项列出，再对照最终书面行程检查变化。若材料版本或适用条件发生变化，应重新取得当前确认；旧截图、历史页面与聊天摘要都不能替代本次书面材料。完成核对后，仍要保留所依据材料的日期，便于在出发前识别后续更新。",
                  claimIds: [fact.id],
                },
              ],
            },
          },
        }),
      );
      const contentVersionId = String(draft.contentVersionId);
      const preview = toolResult(
        await mcpClient.callTool({
          name: "geo_variant_preview",
          arguments: {
            tenantId: SEED_IDS.sampleTravel.tenant,
            contentVersionId,
            channelAccountId: SEED_IDS.sampleTravel.toutiao,
            platform: "toutiao",
          },
        }),
      );
      const mcpVariantId = String(preview.id ?? preview.variantId);
      const mcpAudit = toolResult(
        await mcpClient.callTool({
          name: "geo_audit_request",
          arguments: {
            tenantId: SEED_IDS.sampleTravel.tenant,
            variantId: mcpVariantId,
            idempotencyKey: "mcp-e2e-audit",
          },
        }),
      );
      expect(mcpAudit, JSON.stringify(mcpAudit)).toMatchObject({
        status: "passed",
        eligibleForPublicationRequest: true,
      });
      expect(JSON.stringify(mcpAudit)).not.toContain("token");
      const mcpPublication = toolResult(
        await mcpClient.callTool({
          name: "geo_publication_request",
          arguments: {
            tenantId: SEED_IDS.sampleTravel.tenant,
            variantId: mcpVariantId,
            channelAccountId: SEED_IDS.sampleTravel.toutiao,
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
            tenantId: SEED_IDS.sampleTravel.tenant,
            querySetVersionId: SEED_IDS.sampleTravel.querySetVersion,
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

      const agentScopeClaim =
        "本条记录仅用于 E2E Pi runner 验收：runner 只能调用静态 allowlist 中的租户上下文、事实查询、canonical 草稿、平台预览、确定性审计和一次性 Dry-run 请求工具。它不得自行签发 grant、修改 active policy、注入平台最终正文、越过 tenant scope、伪造平台回读、宣称外部发布，或把 fixture 可见性样本描述为豆包和千问的真实搜索。每次执行必须保留 Plastic Promise 项目隔离参数、工具步骤、请求标识、内容哈希、审计哈希、授权状态和未确认 preview receipt，便于独立复核。";
      const agentEvidenceResponse = await app.inject({
        method: "POST",
        url: "/api/evidence-sources",
        headers: writeHeaders,
        payload: {
          type: "manual",
          title: "E2E Pi runner 治理范围记录",
          content: agentScopeClaim,
          capturedAt: new Date().toISOString(),
          validUntil,
          metadata: { evidenceMode: "e2e_agent_runner_scope" },
        },
      });
      expect(agentEvidenceResponse.statusCode).toBe(201);
      const agentEvidence = agentEvidenceResponse.json<{ id: string }>();
      const agentFactResponse = await app.inject({
        method: "POST",
        url: "/api/facts",
        headers: writeHeaders,
        payload: {
          brandId: SEED_IDS.sampleTravel.brand,
          normalizedKey: "test.pi_runner_governance_scope",
          claim: agentScopeClaim,
          status: "verified",
          evidenceSourceIds: [agentEvidence.id],
          validUntil,
        },
      });
      expect(agentFactResponse.statusCode).toBe(201);

      const browserAgentRunBody = {
        brandId: SEED_IDS.sampleTravel.brand,
        campaignId: campaign.id,
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
        platform: "toutiao",
        topic: "pi runner governance scope",
        articleTemplateId: "step-by-step-guide",
        idempotencyKey: "agent-run-e2e",
      } as const;
      const browserCapability = await app.inject({
        method: "GET",
        url: "/api/agent/capability",
        headers: { cookie: authenticated.cookie },
      });
      expect(browserCapability.json()).toMatchObject({
        available: true,
        mode: "fixture",
        provider: "fixture",
        model: "fixture-geo-writer-v1",
      });
      const runAgent = async () => {
        const response = await app.inject({
          method: "POST",
          headers: {
            cookie: authenticated.cookie,
            "x-csrf-token": authenticated.csrfToken,
          },
          url: "/api/agent/runs",
          payload: browserAgentRunBody,
        });
        return {
          status: response.statusCode,
          json: async () => response.json<unknown>(),
        };
      };
      const agentResponse = await runAgent();
      expect(
        agentResponse.status,
        agentRunError instanceof Error ? agentRunError.message : "agent run returned an error",
      ).toBe(200);
      const agentResult = (await agentResponse.json()) as {
        capability: { mode: string };
        result: {
          providerMode: string;
          contentItemId: string;
          contentVersionId: string;
          variantId: string;
          auditRunId: string;
          auditArtifactId: string;
          publicationRequestId: string;
          publicationJobId: string;
          outboxEventId: string;
          steps: string[];
        };
      };
      expect(agentResult).toMatchObject({
        capability: { mode: "fixture" },
        result: {
          providerMode: "fixture",
          contentItemId: expect.any(String),
          contentVersionId: expect.any(String),
          variantId: expect.any(String),
          auditRunId: expect.any(String),
          auditArtifactId: expect.any(String),
          publicationRequestId: expect.any(String),
          publicationJobId: expect.any(String),
          outboxEventId: expect.any(String),
          steps: [
            "plastic_context_supply",
            "geo_tenant_context",
            "geo_template_catalog",
            "geo_brand_profile",
            "geo_fact_lookup",
            "geo_draft_proposal",
            "geo_variant_preview",
            "geo_audit_request",
            "geo_publication_request",
          ],
        },
      });
      expect(agentResult.result.publicationRequestId).toBe(agentResult.result.publicationJobId);
      const checkpointCounts = async () =>
        adminClient.query<{
          content_items: string;
          content_versions: string;
          variants: string;
          audits: string;
          grants: string;
          jobs: string;
          outbox: string;
        }>(
          `select
             (select count(*)::text from geo.content_items where tenant_id = $1) as content_items,
             (select count(*)::text from geo.content_versions where tenant_id = $1) as content_versions,
             (select count(*)::text from geo.publication_variants where tenant_id = $1) as variants,
             (select count(*)::text from geo.audit_artifacts where tenant_id = $1) as audits,
             (select count(*)::text from geo.publication_grants where tenant_id = $1) as grants,
             (select count(*)::text from geo.publication_jobs where tenant_id = $1) as jobs,
             (select count(*)::text from geo.outbox_events where tenant_id = $1) as outbox`,
          [SEED_IDS.sampleTravel.tenant],
        );
      const countsBeforeReplay = (await checkpointCounts()).rows[0];
      const conflictingReplay = await app.inject({
        method: "POST",
        url: "/api/publication-replays/resolve",
        headers: writeHeaders,
        payload: {
          idempotencyKey: "agent-run-e2e:publication",
          variantId: agentResult.result.variantId,
          auditArtifactId: SEED_IDS.sampleTravel.querySetVersion,
          channelAccountId: SEED_IDS.sampleTravel.toutiao,
          executionLevel: "dry_run",
        },
      });
      expect(conflictingReplay.statusCode).toBe(409);
      const replayResponse = await runAgent();
      expect(replayResponse.status).toBe(200);
      const replayResult = (await replayResponse.json()) as typeof agentResult;
      expect(replayResult.result).toMatchObject({
        contentItemId: agentResult.result.contentItemId,
        contentVersionId: agentResult.result.contentVersionId,
        variantId: agentResult.result.variantId,
        auditRunId: agentResult.result.auditRunId,
        auditArtifactId: agentResult.result.auditArtifactId,
        publicationRequestId: agentResult.result.publicationRequestId,
        publicationJobId: agentResult.result.publicationJobId,
        outboxEventId: agentResult.result.outboxEventId,
      });
      expect(JSON.stringify(replayResult)).not.toMatch(/publicationAuthorization|grantId|token/iu);
      expect((await checkpointCounts()).rows[0]).toEqual(countsBeforeReplay);
      expect(
        governanceCalls.find((call) => call.name === "context_supply")?.arguments,
      ).toMatchObject({
        project_id: `project:geo-saas:tenant:${SEED_IDS.sampleTravel.tenant}`,
        project_policy: "strict",
        retrieval_mode: "project",
      });

      const automationClaims = [
        "自动化批次专属验证事实一：E2E Producer 只能在确定性审计通过后生成 Dry-run 预演回执。",
        "自动化批次专属验证事实二：每次领取都绑定当前租户、操作者、运行编号和尝试次数。",
        "自动化批次专属验证事实三：心跳会重新检查 Campaign 状态、急停开关和熔断状态。",
        "自动化批次专属验证事实四：草稿与每个平台目标分别保存断点，进程重启后按租约恢复。",
        "自动化批次专属验证事实五：发布作业只接受审计产物绑定的最终平台变体。",
        "自动化批次专属验证事实六：审计运行编号与审计产物编号是两个独立且可追溯的标识。",
        "自动化批次专属验证事实七：preview_completed 只表示 Dry-run 预演完成，不表示平台实发。",
        "自动化批次专属验证事实八：头条号、搜狐号和携程社区在本验收中保持 manual_only。",
      ] as const;
      const automationFactIds: string[] = [];
      const automationEvidenceResponse = await app.inject({
        method: "POST",
        url: "/api/evidence-sources",
        headers: writeHeaders,
        payload: {
          type: "manual",
          title: "自动化 Producer E2E 范围",
          content: automationClaims.join("\n"),
          capturedAt: new Date().toISOString(),
          validUntil,
          metadata: { evidenceMode: "e2e_automation_producer" },
        },
      });
      expect(automationEvidenceResponse.statusCode).toBe(201);
      const automationEvidence = automationEvidenceResponse.json<{ id: string }>();
      for (const [index, claim] of automationClaims.entries()) {
        const automationFactResponse = await app.inject({
          method: "POST",
          url: "/api/facts",
          headers: writeHeaders,
          payload: {
            brandId: SEED_IDS.sampleTravel.brand,
            normalizedKey: `test.automation_producer_scope.${String(index + 1)}`,
            claim,
            status: "verified",
            evidenceSourceIds: [automationEvidence.id],
            validUntil,
          },
        });
        expect(automationFactResponse.statusCode).toBe(201);
        automationFactIds.push(automationFactResponse.json<{ id: string }>().id);
      }
      let fixtureDraftClaims: readonly string[] = automationClaims;
      let fixtureDraftFactIds: readonly string[] = automationFactIds;
      const automationAccountIds = [
        SEED_IDS.sampleTravel.toutiao,
        ...Array.from(
          { length: 9 },
          (_, index) => `30000000-0000-4000-8000-${String(1001 + index).padStart(12, "0")}`,
        ),
      ];
      for (const [index, accountId] of automationAccountIds.slice(1).entries()) {
        await adminClient.query(
          `insert into geo.channel_accounts (
             tenant_id, id, platform, display_name, capability, supported_execution_levels,
             capability_evidence_type, capability_evidence_refs, status, last_verified_at
           ) values ($1, $2, 'toutiao', $3, 'public_api',
             array['dry_run']::text[], 'api_response', $4::jsonb, 'active', clock_timestamp())`,
          [
            SEED_IDS.sampleTravel.tenant,
            accountId,
            `E2E automation parallel account ${index + 2}`,
            JSON.stringify([`e2e://automation-parallel-account/${index + 2}`]),
          ],
        );
      }
      const batchControlResponse = await app.inject({
        method: "PUT",
        url: "/api/automation/control",
        headers: writeHeaders,
        payload: {
          mode: "unattended",
          quota: {
            maxConcurrent: 10,
            perMinute: 100,
            perDay: 100,
            cooldownSeconds: 0,
            errorBudget: 20,
          },
          reason: "E2E ten-slot parallel dry-run batch",
        },
      });
      expect(batchControlResponse.statusCode).toBe(200);

      const automationBatchResponse = await app.inject({
        method: "POST",
        url: `/api/campaigns/${campaign.id}/automation-batches`,
        headers: writeHeaders,
        payload: {
          idempotencyKey: "e2e-agent-automation-batch-v1",
          name: "E2E governed Dry-run batch",
          items: Array.from({ length: 10 }, (_, index) => ({
            slotKey: `agent-run-slot-${String(index + 1).padStart(2, "0")}`,
            scheduledFor: new Date().toISOString(),
            topicKey: `e2e:agent-governance:${String(index + 1)}`,
            brief: `自动化批次专属验证事实，第 ${String(index + 1)} 篇`,
            channelAccountIds: [automationAccountIds[index] ?? SEED_IDS.sampleTravel.toutiao],
          })),
        },
      });
      expect(automationBatchResponse.statusCode).toBe(201);
      const automationBatch = automationBatchResponse.json<{
        batch: { id: string; executionLevel: string; state: string };
      }>().batch;
      expect(automationBatch).toMatchObject({ executionLevel: "dry_run", state: "scheduled" });

      const automationMcpApi = new Proxy(mcpApi, {
        get(target, property) {
          if (property === "proposeDraft") {
            return async (...args: Parameters<typeof mcpApi.proposeDraft>) => {
              const [principal, input] = args;
              if (input.fixtureMode !== true) return target.proposeDraft(principal, input);
              const fixtureBrief = input.brief.normalize("NFKC").replace(/\s+/gu, " ").trim();
              const slotNumber = Number(fixtureBrief.match(/第 (\d+) 篇/u)?.[1] ?? "1");
              const fixtureScenarioNotes = [
                "先做服务边界清单，再按合同原文逐项核对，避免把口头承诺当成已确认事项。",
                "先比较直飞与转机的时间成本，再把预算、休息和老人接受度放在同一张表里。",
                "先看集合和返程衔接，再核对不同城区出发的交通耗时与临时调整空间。",
                "先区分资质、合同和行程证据，再决定哪些结论可以写进公开内容。",
                "先量化步行量、车程和休息点，再按照每天节奏判断路线是否适合同行长辈。",
                "先列签证、行李、住宿和用餐四个问题，再逐项标记已知、未知和待确认。",
                "先记录长辈的腿脚、用药与睡眠需求，再检查行程是否存在无法替代的强制安排。",
                "先建立航班变化、材料补交和临时身体状况的应对顺序，再记录谁负责回访。",
                "先把景点数量和真实成本分开，再用预算、体力和体验三个维度做取舍。",
                "先比较节假日、换季天气、人流和价格，再决定哪些变化需要提前留出缓冲。",
              ] as const;
              const fixtureScenarioNote =
                fixtureScenarioNotes[(slotNumber - 1) % fixtureScenarioNotes.length] ??
                fixtureScenarioNotes[0];
              return target.proposeDraft(principal, {
                brandId: input.brandId,
                campaignId: input.campaignId,
                brief: input.brief,
                targetPlatform: "toutiao",
                idempotencyKey: input.idempotencyKey,
                authoredDraft: {
                  title: "带老人报名出境团：签约前核对服务与自费边界",
                  titleClaimIds: [],
                  summary: `本篇围绕“${fixtureBrief.slice(0, 64)}”展开，完成合同、行程、服务衔接和发布留痕复核。`,
                  summaryClaimIds: [],
                  body: [
                    {
                      text: `## 先锁定本篇决策场景\n\n${fixtureBrief}\n\n本篇专属判断路径：${fixtureScenarioNote}\n\n${fixtureDraftClaims.slice(0, 2).join("\n\n")}\n\n围绕当前场景，把服务主体、同行人员、出发条件和本次行程版本写进核对表，避免把历史材料或其他线路的说明混入当前合同。`,
                      claimIds: fixtureDraftFactIds.slice(0, 2),
                    },
                    {
                      text: `## 把选择拆成可核对项目\n\n针对“${fixtureBrief}”，分别记录已包含服务、未包含服务、时间衔接和需要人工确认的条件。\n\n本篇专属判断路径：${fixtureScenarioNote}\n\n${fixtureDraftClaims.slice(2, 4).join("\n\n")}\n\n无法从当前材料确认的收费或保障安排，只保留为待确认事项，不写成已经承诺。`,
                      claimIds: fixtureDraftFactIds.slice(2, 4),
                    },
                    {
                      text: `## 用当前场景复核内容证据\n\n本篇的判断主线始终是“${fixtureBrief}”，每个结论都要能回到当前版本的事实与材料。\n\n本篇专属判断路径：${fixtureScenarioNote}\n\n${fixtureDraftClaims.slice(4, 6).join("\n\n")}\n\n审计对象、平台变体和目标账号必须保持一致，任何正文或图片变化都应重新形成可追溯版本。`,
                      claimIds: fixtureDraftFactIds.slice(4, 6),
                    },
                    {
                      text: `## 最后记录本篇处理结果\n\n对“${fixtureBrief}”形成的标题、正文、图片和账号目标分别留痕。\n\n本篇专属判断路径：${fixtureScenarioNote}\n\n${fixtureDraftClaims.slice(6, 8).join("\n\n")}\n\nDry-run 结果只用于验证流程，不代表平台已经公开接收内容；运营人员仍应依据最终回读判断发布结果。`,
                      claimIds: fixtureDraftFactIds.slice(6, 8),
                    },
                  ],
                  mediaSearchPlan: [
                    {
                      query: "青岛家庭出境游签约资料 family travel documents",
                      role: "cover",
                      rationale: "支持先确认自动化验证边界章节的签约资料主题。",
                      claimIds: [],
                    },
                    {
                      query: "旅行合同服务范围 travel contract checklist",
                      role: "inline",
                      rationale: "支持再核对运行与恢复规则章节的合同核对主题。",
                      claimIds: [],
                    },
                    {
                      query: "旅行平台内容审计 content audit review",
                      role: "inline",
                      rationale: "支持发布前检查审计绑定章节的审计复核主题。",
                      claimIds: [],
                    },
                    {
                      query: "文章发布状态监控 publishing status monitor",
                      role: "inline",
                      rationale: "支持最后区分预演与实发章节的状态回读主题。",
                      claimIds: [],
                    },
                  ],
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof mcpApi;

      const automationProducer = new AutomationProducer(
        createGeoAutomationProducerDependencies({
          sessions: mcpSessions,
          api: automationMcpApi,
          governance: agentGovernance,
          agentRunner: fixtureAgentRunner,
          deliveryPollIntervalMs: 10,
        }),
        {
          enabled: true,
          producerId: "e2e-producer",
          concurrency: 4,
          pollIntervalMs: 1_000,
          leaseDurationMs: 10_000,
          heartbeatIntervalMs: 100,
          backoffBaseMs: 10,
          backoffMaxMs: 100,
        },
      );
      const automationLifecycle = automationProducer.start();
      type CompletedAutomationRun = {
        batchId: string;
        id: string;
        state: string;
        attemptCount: number;
        contentItemId: string | null;
        contentVersionId: string | null;
        targets: Array<{
          state: string;
          variantId: string | null;
          auditRunId: string | null;
          auditArtifactId: string | null;
          publicationJobId: string | null;
        }>;
      };
      let completedAutomationRuns: CompletedAutomationRun[] = [];
      let latestAutomationRuns: CompletedAutomationRun[] = [];
      try {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await worker.runOnce();
          const automationRuns = await app.inject({
            method: "GET",
            url: "/api/automation-runs",
            headers: { cookie: authenticated.cookie },
          });
          latestAutomationRuns = automationRuns.json<{
            items: CompletedAutomationRun[];
          }>().items;
          completedAutomationRuns = latestAutomationRuns.filter(
            (run) => run.batchId === automationBatch.id && run.state === "completed",
          );
          if (completedAutomationRuns.length === 10) break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        }
      } finally {
        await automationProducer.stop({ mode: "abort" });
        await automationLifecycle;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      const latestAutomationArtifactId = latestAutomationRuns[0]?.targets[0]?.auditArtifactId;
      const latestAutomationAudit =
        latestAutomationArtifactId === null || latestAutomationArtifactId === undefined
          ? null
          : await app.inject({
              method: "GET",
              url: `/api/audits/${latestAutomationArtifactId}`,
              headers: { cookie: authenticated.cookie },
            });
      expect(
        completedAutomationRuns,
        `Producer did not complete all ten runs: ${JSON.stringify({
          runs: latestAutomationRuns,
          audit: latestAutomationAudit?.json(),
        })}`,
      ).toHaveLength(10);
      expect(automationProducer.health()).toMatchObject({
        enabled: true,
        running: false,
        activeRuns: 0,
        lastError: null,
      });
      for (const run of completedAutomationRuns) {
        expect(run).toMatchObject({
          state: "completed",
          attemptCount: expect.any(Number),
          contentItemId: expect.any(String),
          contentVersionId: expect.any(String),
          targets: [
            {
              state: "preview_completed",
              variantId: expect.any(String),
              auditRunId: expect.any(String),
              auditArtifactId: expect.any(String),
              publicationJobId: expect.any(String),
            },
          ],
        });
        expect(run.attemptCount).toBeGreaterThanOrEqual(1);
        expect(run.targets[0]?.auditRunId).not.toBe(run.targets[0]?.auditArtifactId);
      }
      const automationBatches = await app.inject({
        method: "GET",
        url: "/api/automation-batches",
        headers: { cookie: authenticated.cookie },
      });
      expect(
        automationBatches
          .json<{ items: Array<{ id: string; state: string }> }>()
          .items.find((item) => item.id === automationBatch.id),
      ).toMatchObject({ state: "completed" });

      type ProducerRunView = {
        id: string;
        batchId: string;
        state: string;
        stage: string;
        availableAt: string;
        attemptCount: number;
        leaseExpiresAt: string | null;
        contentItemId: string | null;
        contentVersionId: string | null;
        targets: Array<{
          state: string;
          variantId: string | null;
          auditRunId: string | null;
          auditArtifactId: string | null;
          publicationJobId: string | null;
        }>;
      };
      const readBatchRun = async (batchId: string): Promise<ProducerRunView> => {
        const response = await app.inject({
          method: "GET",
          url: `/api/automation-runs?batchId=${batchId}`,
          headers: { cookie: authenticated.cookie },
        });
        expect(response.statusCode).toBe(200);
        const run = response.json<{ items: ProducerRunView[] }>().items[0];
        if (run === undefined) throw new Error(`Automation batch ${batchId} has no run`);
        return run;
      };
      const waitForSignal = async (signal: Promise<void>, label: string): Promise<void> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            signal,
            new Promise<never>((_resolvePromise, rejectPromise) => {
              timeout = setTimeout(
                () => rejectPromise(new Error(`Timed out waiting for ${label}`)),
                5_000,
              );
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      };
      const createAutomationBatch = async (input: {
        idempotencyKey: string;
        slotKey: string;
        topicKey: string;
        brief: string;
      }): Promise<string> => {
        const response = await app.inject({
          method: "POST",
          url: `/api/campaigns/${campaign.id}/automation-batches`,
          headers: writeHeaders,
          payload: {
            idempotencyKey: input.idempotencyKey,
            name: input.slotKey,
            items: [
              {
                slotKey: input.slotKey,
                scheduledFor: new Date().toISOString(),
                topicKey: input.topicKey,
                brief: input.brief,
                channelAccountIds: [SEED_IDS.sampleTravel.toutiao],
              },
            ],
          },
        });
        expect(response.statusCode).toBe(201);
        return response.json<{ batch: { id: string } }>().batch.id;
      };

      const restartClaims = [
        "restartproof fact one: a durable draft checkpoint binds the content item and version.",
        "restartproof fact two: an expired producer lease can be claimed only as a new attempt.",
        "restartproof fact three: resumed execution reuses the stored content identifiers.",
        "restartproof fact four: target idempotency keys remain stable across producer restarts.",
        "restartproof fact five: publication authorization still requires a passing audit.",
        "restartproof fact six: dry-run delivery creates preview evidence and never claims a live post.",
        "restartproof fact seven: the recovered run remains bound to its original tenant.",
        "restartproof fact eight: the second producer completes without duplicating the draft.",
      ] as const;
      const restartEvidenceResponse = await app.inject({
        method: "POST",
        url: "/api/evidence-sources",
        headers: writeHeaders,
        payload: {
          type: "manual",
          title: "Producer restart recovery evidence",
          content: restartClaims.join("\n"),
          capturedAt: new Date().toISOString(),
          validUntil,
          metadata: { evidenceMode: "e2e_restart_recovery" },
        },
      });
      expect(restartEvidenceResponse.statusCode).toBe(201);
      const restartEvidence = restartEvidenceResponse.json<{ id: string }>();
      const restartFactIds: string[] = [];
      for (const [index, claim] of restartClaims.entries()) {
        const response = await app.inject({
          method: "POST",
          url: "/api/facts",
          headers: writeHeaders,
          payload: {
            brandId: SEED_IDS.sampleTravel.brand,
            normalizedKey: `test.restartproof.${String(index + 1)}`,
            claim,
            status: "verified",
            evidenceSourceIds: [restartEvidence.id],
            validUntil,
          },
        });
        expect(response.statusCode).toBe(201);
        restartFactIds.push(response.json<{ id: string }>().id);
      }
      fixtureDraftClaims = restartClaims;
      fixtureDraftFactIds = restartFactIds;

      const restartBatchId = await createAutomationBatch({
        idempotencyKey: "e2e-producer-restart-batch-v1",
        slotKey: "producer-restart-recovery",
        topicKey: "e2e:producer-restartproof",
        brief: "restartproof producer crash recovery",
      });
      let enteredPreviewResolve: () => void = () => undefined;
      let releasePreviewResolve: () => void = () => undefined;
      const enteredPreview = new Promise<void>((resolvePromise) => {
        enteredPreviewResolve = resolvePromise;
      });
      const releasePreview = new Promise<void>((resolvePromise) => {
        releasePreviewResolve = resolvePromise;
      });
      const crashAdapter = createGeoAutomationProducerDependencies({
        sessions: mcpSessions,
        api: automationMcpApi,
        runtimeForPrincipal: (principal) => {
          const runtime = createGovernedAgentRuntime(principal, automationMcpApi, agentGovernance, {
            allowFixtureDrafts: true,
          });
          return {
            invoke: async (name, argumentsValue) => {
              if (name === "geo_variant_preview") {
                enteredPreviewResolve();
                await releasePreview;
                return {};
              }
              return runtime.invoke(name, argumentsValue);
            },
          };
        },
        deliveryPollIntervalMs: 10,
      });
      const crashedProducer = new AutomationProducer(
        {
          ...crashAdapter,
          // A crashed process cannot reconcile or write its final run checkpoint.
          reconcile: async () => ({ disposition: "unresolved" as const }),
          checkpoint: async () => undefined,
        },
        {
          enabled: true,
          producerId: "e2e-crashed-producer",
          concurrency: 1,
          pollIntervalMs: 1_000,
          leaseDurationMs: 10_000,
          heartbeatIntervalMs: 5_000,
          backoffBaseMs: 10,
          backoffMaxMs: 100,
        },
      );
      const crashedLifecycle = crashedProducer.start();
      await waitForSignal(enteredPreview, "the first producer draft checkpoint");
      const leasedRestartRun = await readBatchRun(restartBatchId);
      expect(leasedRestartRun).toMatchObject({
        state: "running",
        stage: "draft",
        attemptCount: 1,
        contentItemId: expect.any(String),
        contentVersionId: expect.any(String),
        targets: [{ state: "pending", variantId: null, publicationJobId: null }],
      });
      const crashedLeaseExpiresAt = leasedRestartRun.leaseExpiresAt;
      if (crashedLeaseExpiresAt === null) {
        throw new Error("The crashed Producer run has no lease expiry");
      }
      const crashedStop = crashedProducer.stop({ mode: "abort" });
      releasePreviewResolve();
      await crashedStop;
      await crashedLifecycle;
      const orphanedRestartRun = await readBatchRun(restartBatchId);
      expect(orphanedRestartRun).toMatchObject({ state: "running", attemptCount: 1 });
      await new Promise((resolvePromise) =>
        setTimeout(
          resolvePromise,
          Math.max(0, Date.parse(crashedLeaseExpiresAt) - Date.now() + 250),
        ),
      );

      const recoveryProducer = new AutomationProducer(
        createGeoAutomationProducerDependencies({
          sessions: mcpSessions,
          api: automationMcpApi,
          governance: agentGovernance,
          agentRunner: fixtureAgentRunner,
          deliveryPollIntervalMs: 10,
        }),
        {
          enabled: true,
          producerId: "e2e-recovery-producer",
          concurrency: 1,
          pollIntervalMs: 100,
          leaseDurationMs: 10_000,
          heartbeatIntervalMs: 100,
          backoffBaseMs: 10,
          backoffMaxMs: 100,
        },
      );
      const recoveryLifecycle = recoveryProducer.start();
      let recoveredRun: ProducerRunView | undefined;
      let latestRecoveredRun: ProducerRunView | undefined;
      try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await worker.runOnce();
          const current = await readBatchRun(restartBatchId);
          latestRecoveredRun = current;
          if (current.state === "completed") {
            recoveredRun = current;
            break;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        }
      } finally {
        await recoveryProducer.stop({ mode: "abort" });
        await recoveryLifecycle;
      }
      const recoveredAuditArtifactId = latestRecoveredRun?.targets[0]?.auditArtifactId;
      const recoveredAudit =
        recoveredAuditArtifactId === null || recoveredAuditArtifactId === undefined
          ? null
          : await app.inject({
              method: "GET",
              url: `/api/audits/${recoveredAuditArtifactId}`,
              headers: { cookie: authenticated.cookie },
            });
      expect(
        recoveredRun,
        JSON.stringify({ run: latestRecoveredRun, audit: recoveredAudit?.json() }),
      ).toMatchObject({
        state: "completed",
        attemptCount: 3,
        contentItemId: leasedRestartRun.contentItemId,
        contentVersionId: leasedRestartRun.contentVersionId,
        targets: [
          {
            state: "preview_completed",
            variantId: expect.any(String),
            auditRunId: expect.any(String),
            auditArtifactId: expect.any(String),
            publicationJobId: expect.any(String),
          },
        ],
      });
      const recoveredDraftCount = await adminClient.query<{ items: string; versions: string }>(
        `select
           (select count(*)::text from geo.content_items where tenant_id = $1 and id = $2) as items,
           (select count(*)::text from geo.content_versions where tenant_id = $1 and id = $3) as versions`,
        [
          SEED_IDS.sampleTravel.tenant,
          leasedRestartRun.contentItemId,
          leasedRestartRun.contentVersionId,
        ],
      );
      expect(recoveredDraftCount.rows[0]).toEqual({ items: "1", versions: "1" });

      const effectsBeforeKill = await adminClient.query<{
        content_items: string;
        grants: string;
        jobs: string;
      }>(
        `select
           (select count(*)::text from geo.content_items where tenant_id = $1) as content_items,
           (select count(*)::text from geo.publication_grants where tenant_id = $1) as grants,
           (select count(*)::text from geo.publication_jobs where tenant_id = $1) as jobs`,
        [SEED_IDS.sampleTravel.tenant],
      );
      const killBatchId = await createAutomationBatch({
        idempotencyKey: "e2e-producer-kill-switch-batch-v1",
        slotKey: "producer-kill-switch-generation",
        topicKey: "e2e:producer-kill-switch",
        brief: "restartproof kill switch during generation",
      });
      let enteredDraftResolve: () => void = () => undefined;
      let releaseDraftResolve: () => void = () => undefined;
      const enteredDraft = new Promise<void>((resolvePromise) => {
        enteredDraftResolve = resolvePromise;
      });
      const releaseDraft = new Promise<void>((resolvePromise) => {
        releaseDraftResolve = resolvePromise;
      });
      const killProducer = new AutomationProducer(
        createGeoAutomationProducerDependencies({
          sessions: mcpSessions,
          api: mcpApi,
          runtimeForPrincipal: (principal) => {
            const runtime = createGovernedAgentRuntime(principal, mcpApi, agentGovernance, {
              allowFixtureDrafts: true,
            });
            return {
              invoke: async (name, argumentsValue) => {
                if (name === "geo_draft_proposal") {
                  enteredDraftResolve();
                  await releaseDraft;
                  return {};
                }
                return runtime.invoke(name, argumentsValue);
              },
            };
          },
          deliveryPollIntervalMs: 10,
        }),
        {
          enabled: true,
          producerId: "e2e-kill-switch-producer",
          concurrency: 1,
          pollIntervalMs: 100,
          leaseDurationMs: 10_000,
          heartbeatIntervalMs: 100,
          backoffBaseMs: 10,
          backoffMaxMs: 100,
        },
      );
      const killLifecycle = killProducer.start();
      await waitForSignal(enteredDraft, "generation to enter the draft tool");
      const killSwitchResponse = await app.inject({
        method: "POST",
        url: "/api/automation/kill-switch",
        headers: writeHeaders,
        payload: { enabled: true, reason: "E2E kill switch during draft generation" },
      });
      expect(killSwitchResponse.statusCode).toBe(200);
      let blockedRun: ProducerRunView | undefined;
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline) {
        const current = await readBatchRun(killBatchId);
        if (current.state === "blocked") {
          blockedRun = current;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      const killStop = killProducer.stop({ mode: "abort" });
      releaseDraftResolve();
      await killStop;
      await killLifecycle;
      expect(blockedRun).toMatchObject({
        state: "blocked",
        contentItemId: null,
        contentVersionId: null,
        targets: [
          {
            state: "blocked",
            variantId: null,
            auditRunId: null,
            auditArtifactId: null,
            publicationJobId: null,
          },
        ],
      });
      const effectsAfterKill = await adminClient.query<{
        content_items: string;
        grants: string;
        jobs: string;
      }>(
        `select
           (select count(*)::text from geo.content_items where tenant_id = $1) as content_items,
           (select count(*)::text from geo.publication_grants where tenant_id = $1) as grants,
           (select count(*)::text from geo.publication_jobs where tenant_id = $1) as jobs`,
        [SEED_IDS.sampleTravel.tenant],
      );
      expect(effectsAfterKill.rows[0]).toEqual(effectsBeforeKill.rows[0]);
      const resetKillSwitch = await app.inject({
        method: "POST",
        url: "/api/automation/kill-switch",
        headers: writeHeaders,
        payload: { enabled: false, reason: "E2E kill switch verification completed" },
      });
      expect(resetKillSwitch.statusCode).toBe(200);
    } finally {
      agentRunGatewayDelegate = undefined;
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
    expect(receiptsAfterMcp.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(10);

    const outbox = await adminClient.query<{ count: string }>(
      "select count(*)::text as count from geo.outbox_events where published_at is not null",
    );
    expect(Number(outbox.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(10);

    const isolated = await login("operator@isolation.example", "isolation-password");
    const isolatedReplay = await app.inject({
      method: "POST",
      url: "/api/publication-replays/resolve",
      headers: {
        cookie: isolated.cookie,
        "x-csrf-token": isolated.csrfToken,
      },
      payload: {
        idempotencyKey: "agent-run-e2e:publication",
        variantId: SEED_IDS.sampleTravel.querySetVersion,
        auditArtifactId: SEED_IDS.sampleTravel.querySetVersion,
        channelAccountId: SEED_IDS.sampleTravel.toutiao,
        executionLevel: "dry_run",
      },
    });
    expect(isolatedReplay.statusCode).toBe(200);
    expect(isolatedReplay.json()).toEqual({ publication: null });
    const isolatedContacts = await app.inject({
      method: "GET",
      url: "/api/contacts",
      headers: { cookie: isolated.cookie },
    });
    expect(isolatedContacts.statusCode).toBe(200);
    const serializedContacts = JSON.stringify(isolatedContacts.json());
    expect(serializedContacts).toContain("4000000000");
    expect(serializedContacts).not.toContain("4000000001");
    expect(serializedContacts).not.toContain("TRAVEL_DEMO_01");
    const isolatedBrands = await app.inject({
      method: "GET",
      url: "/api/brands",
      headers: { cookie: isolated.cookie },
    });
    const isolatedQuerySets = await app.inject({
      method: "GET",
      url: "/api/query-sets",
      headers: { cookie: isolated.cookie },
    });
    expect(JSON.stringify(isolatedBrands.json())).not.toContain("E2E Healthcare Brand");
    expect(JSON.stringify(isolatedQuerySets.json())).not.toContain("E2E Healthcare Domestic AI");
  });
});
