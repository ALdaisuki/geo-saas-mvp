import { PlasticPromiseGovernanceClient, type McpToolCaller } from "@geo/agent";
import type { ActorContext, BrandAgentProfile } from "@geo/contracts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DraftProposalInput,
  InternalGeoApiClient,
  MediaSearchImportInput,
  PublicationRequestInput,
} from "./api-client.js";
import {
  createGovernedAgentRuntime,
  FixturePiAgentRunService,
  nextMissingDraftToolName,
  PiAgentRunError,
  projectPiToolResult,
  RealPiAgentRunService,
} from "./pi-runner.js";
import { jsonOpenAICompletionsModel } from "./json-openai-completions.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000101",
  brand: "10000000-0000-4000-8000-000000000301",
  campaign: "10000000-0000-4000-8000-000000000501",
  account: "10000000-0000-4000-8000-000000000701",
  content: "10000000-0000-4000-8000-000000000600",
  version: "10000000-0000-4000-8000-000000000601",
  mediaVersion: "10000000-0000-4000-8000-000000000608",
  fact: "10000000-0000-4000-8000-000000000609",
  variant: "10000000-0000-4000-8000-000000000602",
  audit: "10000000-0000-4000-8000-000000000603",
  artifact: "10000000-0000-4000-8000-000000000606",
  publication: "10000000-0000-4000-8000-000000000604",
  outbox: "10000000-0000-4000-8000-000000000605",
  profile: "10000000-0000-4000-8000-000000000607",
};

const principal: ActorContext = {
  tenantId: ids.tenant,
  actorId: ids.actor,
  role: "owner",
  capabilities: ["tenant:read", "content:read", "content:write", "audit:run", "publish:request"],
  requestId: "pi-runner-test",
};

function governance(
  calls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [],
  contextSupplyEnabled = true,
): PlasticPromiseGovernanceClient {
  return new PlasticPromiseGovernanceClient(
    {
      callTool: async (input) => {
        calls.push(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                input.name === "audit_pre_check"
                  ? { passed: true, compliance_score: 0.85 }
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
                    : { context: "fixture" },
              ),
            },
          ],
        };
      },
    },
    { contextSupplyEnabled },
  );
}

function fakeApi(
  publicationInputs: PublicationRequestInput[] = [],
  scopeToolNames: string[] = [],
  brandAgentProfile: Readonly<BrandAgentProfile> | null = null,
  draftInputs: DraftProposalInput[] = [],
  mediaSearchInputs: MediaSearchImportInput[] = [],
): InternalGeoApiClient {
  return {
    getTenantContext: async () => ({
      tenant: { id: ids.tenant },
      brands: [
        {
          id: ids.brand,
          displayName: "示例国际旅行服务",
          industry: "travel",
          isPrimary: true,
        },
      ],
    }),
    getArticleTemplateCatalog: async () => ({
      version: "geo.article-templates.v1" as const,
      items: [],
    }),
    getBrandAgentProfile: async () => brandAgentProfile,
    lookupFacts: async () => ({ facts: [], evidence: [] }),
    proposeDraft: async (_actor, input) => {
      draftInputs.push(input);
      return {
        providerMode: input.fixtureMode === true ? "fixture" : "authored",
        contentItemId: ids.content,
        contentVersionId: ids.version,
        claimIds: [ids.fact],
      };
    },
    previewVariant: async () => ({ variantId: ids.variant }),
    requestAudit: async () => ({
      auditRunId: ids.audit,
      auditArtifactId: ids.artifact,
      status: "passed",
      eligibleForPublicationRequest: true,
    }),
    requestPublication: async (_actor, input) => {
      publicationInputs.push(input);
      return {
        publicationRequestId: ids.publication,
        publicationJobId: ids.publication,
        outboxEventId: ids.outbox,
      };
    },
    requestVisibilityRun: async () => ({ visibilityRunId: ids.publication }),
    requestMediaProduction: async () => ({
      mediaJobId: ids.publication,
      asset: { contentVersionId: ids.mediaVersion },
    }),
    getMediaJobStatus: async () => ({ mediaJobId: ids.publication, state: "succeeded" }),
    requestMediaSearchImport: async (_actor, input) => {
      mediaSearchInputs.push(input);
      return { finalContentVersionId: ids.mediaVersion };
    },
    authorizeResourceScope: async (_principal, toolName) => {
      scopeToolNames.push(toolName);
      return toolName.startsWith("geo_");
    },
  };
}

const fauxRegistrations: Array<ReturnType<typeof registerFauxProvider>> = [];

afterEach(() => {
  for (const registration of fauxRegistrations.splice(0)) registration.unregister();
  vi.unstubAllGlobals();
});

describe("Pi agent run service", () => {
  it("advances the draft tool sequence after a successful fact lookup", () => {
    const successful = new Set([
      "geo_tenant_context",
      "geo_template_catalog",
      "geo_brand_profile",
      "geo_fact_lookup",
    ]);

    expect(nextMissingDraftToolName(successful)).toBe("geo_draft_proposal");

    successful.add("geo_draft_proposal");
    expect(nextMissingDraftToolName(successful)).toBeUndefined();
  });

  it("creates and destroys a distinct Pi session for every run", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const faux = registerFauxProvider({ provider: "geo-pi-session-lifecycle-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("第一次运行完成"),
      fauxAssistantMessage("第二次运行完成"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-session-lifecycle-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "第一次独立运行" }),
    ).resolves.toMatchObject({ response: "第一次运行完成" });
    await expect(
      service.run(principal, { workflow: "prompt", prompt: "第二次独立运行" }),
    ).resolves.toMatchObject({ response: "第二次运行完成" });

    const destroyed = infoLog.mock.calls
      .map(([entry]) => {
        try {
          return JSON.parse(String(entry)) as Readonly<Record<string, unknown>>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Readonly<Record<string, unknown>> =>
          entry?.event === "agent_mcp.session_destroyed",
      );
    expect(destroyed).toHaveLength(2);
    expect(new Set(destroyed.map((entry) => entry.taskId)).size).toBe(2);
    expect(new Set(destroyed.map((entry) => entry.providerRunId)).size).toBe(2);
    expect(destroyed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "completed",
          remainingMessageCount: 0,
          remainingPendingToolCallCount: 0,
          hasQueuedMessages: false,
        }),
        expect.objectContaining({
          outcome: "completed",
          remainingMessageCount: 0,
          remainingPendingToolCallCount: 0,
          hasQueuedMessages: false,
        }),
      ]),
    );
    infoLog.mockRestore();
  });

  it("advances named provider tool choices across a real draft run", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const draftInputs: DraftProposalInput[] = [];
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["亲子游客"],
        objectives: ["提供行程建议"],
        requiredPoints: ["说明信息时效性"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const authoredDraft = {
      title: "京都亲子出发",
      titleClaimIds: [ids.fact],
      summary: "出发前先把行程节奏和当前信息核对清楚。",
      summaryClaimIds: [ids.fact],
      locationQuery: "京都",
      body: [
        {
          text: "## 先解决什么\n我会先把亲子行程的节奏说清楚，方便你在出发前判断每天安排是否合适。示例国际旅行服务可以协助你把关键条件逐项核对。",
          claimIds: [ids.fact],
        },
        {
          text: "## 怎么安排\n把交通、休息和景点距离放在一起比较，留出调整空间，临近出发再按最新信息复核一次。",
          claimIds: [ids.fact],
        },
      ],
      mediaSearchPlan: [
        {
          query: "京都 金阁寺 Kinkakuji",
          role: "cover",
          rationale: "封面展示京都目的地场景",
          claimIds: [ids.fact],
        },
        {
          query: "京都 伏见稻荷 Fushimi Inari",
          role: "inline",
          rationale: "对应景点段落",
          claimIds: [ids.fact],
        },
        {
          query: "京都 岚山 Arashiyama",
          role: "inline",
          rationale: "对应路线段落",
          claimIds: [ids.fact],
        },
        {
          query: "京都 鸭川 Kamo River",
          role: "inline",
          rationale: "对应休息安排段落",
          claimIds: [ids.fact],
        },
      ],
    };
    const steps = [
      { name: "geo_tenant_context", args: { tenantId: ids.tenant } },
      { name: "geo_template_catalog", args: { tenantId: ids.tenant } },
      { name: "geo_brand_profile", args: { tenantId: ids.tenant, brandId: ids.brand } },
      {
        name: "geo_fact_lookup",
        args: { tenantId: ids.tenant, brandId: ids.brand, query: "京都", limit: 10 },
      },
      {
        name: "geo_draft_proposal",
        args: {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          brief: "京都亲子行程",
          targetPlatform: "ctrip_community",
          idempotencyKey: "model-draft-run",
          authoredDraft,
        },
      },
    ] as const;
    const requestBodies: Readonly<Record<string, unknown>>[] = [];
    let responseIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>);
        const step = steps[responseIndex];
        if (step === undefined) throw new Error("provider received an unexpected extra request");
        responseIndex += 1;
        return new Response(
          JSON.stringify({
            id: `provider-draft-${responseIndex}`,
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-draft-${responseIndex}`,
                      type: "function",
                      function: { name: step.name, arguments: JSON.stringify(step.args) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile, draftInputs),
      governance: governance(),
      provider: "openai-compatible",
      model: jsonOpenAICompletionsModel({
        id: "test-draft-model",
        name: "test-draft-model",
        api: "openai-completions",
        provider: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_000,
        headers: {},
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsStrictMode: false,
          sendSessionAffinityHeaders: false,
        },
      }),
      modelId: "test-draft-model",
      apiKey: "test-provider-key",
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "京都亲子行程",
        idempotencyKey: "model-draft-run",
      }),
    ).resolves.toMatchObject({ contentItemId: ids.content, contentVersionId: ids.version });

    expect(requestBodies).toHaveLength(5);
    expect(requestBodies.map((body) => body.tool_choice)).toEqual(
      steps.map((step) => ({ type: "function", function: { name: step.name } })),
    );
    expect(requestBodies.at(-1)?.tool_choice).toMatchObject({
      type: "function",
      function: { name: "geo_draft_proposal" },
    });
    expect(draftInputs).toHaveLength(1);
    expect(
      infoLog.mock.calls.some(
        ([entry]) =>
          String(entry).includes('"event":"agent_mcp.session_destroyed","taskId":') &&
          String(entry).includes('"outcome":"completed"') &&
          String(entry).includes('"remainingMessageCount":0') &&
          String(entry).includes('"remainingPendingToolCallCount":0') &&
          String(entry).includes('"hasQueuedMessages":false'),
      ),
    ).toBe(true);
    infoLog.mockRestore();
  });

  it("fails closed when a draft turn contains multiple tool calls", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const faux = registerFauxProvider({ provider: "geo-pi-draft-multi-tool-guard-test" });
    fauxRegistrations.push(faux);
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["亲子游客"],
        objectives: ["提供行程建议"],
        requiredPoints: ["说明信息时效性"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }),
          fauxToolCall("geo_template_catalog", { tenantId: ids.tenant }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile),
      governance: governance(),
      provider: "geo-pi-draft-multi-tool-guard-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "京都亲子行程",
        idempotencyKey: "automation:multi-tool-guard",
      }),
    ).rejects.toMatchObject({ diagnosticReason: "tool_guard", toolCallCount: 2 });
    expect(faux.state.callCount).toBe(1);
    expect(
      infoLog.mock.calls.some(
        ([entry]) =>
          String(entry).includes('"event":"agent_mcp.session_destroyed"') &&
          String(entry).includes('"outcome":"failed"') &&
          String(entry).includes('"remainingMessageCount":0') &&
          String(entry).includes('"remainingPendingToolCallCount":0') &&
          String(entry).includes('"hasQueuedMessages":false'),
      ),
    ).toBe(true);
    infoLog.mockRestore();
  });

  it("compacts Pi discovery results while preserving verified claims and selected constraints", () => {
    const selectedTemplate = {
      id: "step-by-step-guide",
      name: "分步办理指南",
      category: "service",
      editorialProfile: "guide",
      scenario: "分步核验",
      benefit: "减少遗漏",
      outline: ["准备", "签约", "出发"],
      evidenceRequirements: ["只使用已核验事实"],
      riskBoundaries: ["不虚构报价"],
    };
    const catalog = projectPiToolResult(
      "geo_template_catalog",
      {
        version: "geo.article-templates.v1",
        items: [selectedTemplate, { ...selectedTemplate, id: "other-template" }],
      },
      { articleTemplateId: selectedTemplate.id },
    );
    expect(catalog).toEqual({
      version: "geo.article-templates.v1",
      selectedTemplateId: selectedTemplate.id,
      totalAvailable: 2,
      items: [selectedTemplate],
    });

    const verifiedClaim = "出境跟团游的包价旅游合同应采用书面形式。";
    const facts = projectPiToolResult("geo_fact_lookup", {
      facts: {
        items: [
          {
            id: ids.fact,
            brandId: ids.brand,
            normalizedKey: "outbound.contract",
            claim: verifiedClaim,
            status: "verified",
            evidenceSourceIds: [ids.content],
            validFrom: "2026-01-01T00:00:00.000Z",
            validUntil: null,
          },
          { id: ids.version, claim: "未经核验", status: "draft" },
        ],
      },
      evidence: { items: [{ id: ids.content, fullText: "large source body" }] },
    });
    expect(facts).toMatchObject({
      facts: { items: [{ id: ids.fact, claim: verifiedClaim, status: "verified" }] },
      evidence: { sourceIds: [ids.content] },
    });
    expect(JSON.stringify(facts)).not.toContain("large source body");
    expect(JSON.stringify(facts)).not.toContain("未经核验");
  });

  it("runs the credential-free fixture workflow through governed dry-run tools", async () => {
    const publications: PublicationRequestInput[] = [];
    const scopeToolNames: string[] = [];
    const governanceCalls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [];
    const service = new FixturePiAgentRunService({
      api: fakeApi(publications, scopeToolNames),
      governance: governance(governanceCalls),
      model: "fixture-geo-writer-v1",
    });

    await expect(
      service.run(principal, {
        workflow: "draft_to_publication",
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        channelAccountId: ids.account,
        platform: "toutiao",
        topic: "有证据的日本长者旅行指南",
        idempotencyKey: "pi-fixture-flow",
      }),
    ).resolves.toMatchObject({
      providerMode: "fixture",
      auditRunId: ids.audit,
      auditArtifactId: ids.artifact,
      publicationRequestId: ids.publication,
    });
    expect(publications).toHaveLength(1);
    expect(publications[0]?.executionLevel).toBe("dry_run");
    expect(scopeToolNames).not.toContain("plastic_context_supply");
    expect(scopeToolNames.every((toolName) => toolName.startsWith("geo_"))).toBe(true);
    expect(governanceCalls.find((call) => call.name === "context_supply")?.arguments).toMatchObject(
      {
        project_id: `project:geo-saas:tenant:${ids.tenant}`,
        project_policy: "strict",
        retrieval_mode: "project",
      },
    );
  });

  it("uses assisted execution only for the Ctrip fixture workflow", async () => {
    const publications: PublicationRequestInput[] = [];
    const service = new FixturePiAgentRunService({
      api: fakeApi(publications, []),
      governance: governance(),
      model: "fixture-geo-writer-v1",
    });

    await service.run(principal, {
      workflow: "draft_to_publication",
      tenantId: ids.tenant,
      brandId: ids.brand,
      campaignId: ids.campaign,
      channelAccountId: ids.account,
      platform: "ctrip_community",
      topic: "Ctrip supervised draft canary",
      idempotencyKey: "pi-fixture-ctrip-assisted",
    });

    expect(publications).toHaveLength(1);
    expect(publications[0]?.executionLevel).toBe("assisted");
  });

  it("rejects a fixture run that crosses the authenticated tenant", async () => {
    const service = new FixturePiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      model: "fixture-geo-writer-v1",
    });
    await expect(
      service.run(principal, {
        workflow: "draft_to_publication",
        tenantId: "20000000-0000-4000-8000-000000000001",
        brandId: ids.brand,
        campaignId: ids.campaign,
        channelAccountId: ids.account,
        platform: "toutiao",
        topic: "cross tenant",
        idempotencyKey: "cross-tenant",
      }),
    ).rejects.toThrow("tenant does not match");
  });

  it("uses the real Pi Agent loop when a provider model is configured", async () => {
    let toolNames: readonly string[] = [];
    const faux = registerFauxProvider({ provider: "geo-pi-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      (context) => {
        toolNames = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("已完成租户范围内的证据审阅。", {
          responseId: "provider-request-1",
        });
      },
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "检查当前证据" }),
    ).resolves.toMatchObject({
      providerMode: "pi",
      provider: "geo-pi-test",
      providerRunId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      providerRequestId: "provider-request-1",
      response: "已完成租户范围内的证据审阅。",
    });
    expect(faux.state.callCount).toBe(1);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "plastic_context_supply",
        "plastic_audit_pre_check",
        "plastic_defense",
      ]),
    );
  });

  it("does not reuse an earlier assistant response ID for the terminal response", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-terminal-trace-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
        responseId: "provider-request-earlier",
      }),
      fauxAssistantMessage("terminal response without id"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-terminal-trace-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "读取上下文后返回结果" }),
    ).resolves.toMatchObject({
      providerMode: "pi",
      providerRequestId: null,
      response: "terminal response without id",
    });
  });

  it("server-binds automation draft scope and bounds Pi fact queries", async () => {
    const factInputs: Array<{ brandId: string; query: string; limit?: number }> = [];
    const draftInputs: DraftProposalInput[] = [];
    const draftOptions: Array<unknown> = [];
    const api = {
      ...fakeApi([], [], null, draftInputs),
      proposeDraft: async (_principal, input, options) => {
        draftInputs.push(input);
        draftOptions.push(options);
        return {
          providerMode: input.fixtureMode === true ? "fixture" : "authored",
          contentItemId: ids.content,
          contentVersionId: ids.version,
          claimIds: [ids.fact],
        };
      },
      lookupFacts: async (
        _principal: Readonly<ActorContext>,
        input: { brandId: string; query: string; limit?: number },
      ) => {
        factInputs.push(input);
        return { facts: [] };
      },
    } satisfies InternalGeoApiClient;
    const brief = `日本亲子旅行 ${"发布前核验边界 ".repeat(80)}`;
    const runtime = createGovernedAgentRuntime(principal, api, governance(), {
      boundAutomationDraft: {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief,
        idempotencyKey: "automation:run:draft:v1",
      },
    });

    await runtime.invoke("geo_fact_lookup", {
      tenantId: ids.tenant,
      brandId: ids.brand,
      query: brief,
      limit: 20,
    });
    await runtime.invoke("geo_draft_proposal", {
      tenantId: ids.tenant,
      brandId: ids.brand,
      campaignId: ids.campaign,
      brief: "model attempted replacement",
      targetPlatform: "sohu",
      idempotencyKey: "model-attempted-key",
      authoredDraft: {
        title: "出发前核验",
        titleClaimIds: [ids.fact],
        summary: "先核对事实。",
        summaryClaimIds: [ids.fact],
        locationQuery: "日本",
        body: [{ text: "## 核验\n按事实执行。", claimIds: [ids.fact] }],
      },
    });

    expect([...String(factInputs[0]?.query)].length).toBe(200);
    expect(factInputs[0]).toMatchObject({ brandId: ids.brand, limit: 10 });
    expect(draftInputs[0]).toMatchObject({
      brandId: ids.brand,
      campaignId: ids.campaign,
      brief: brief.trim(),
      targetPlatform: "ctrip_community",
      idempotencyKey: "automation:run:draft:v1",
    });
    expect(draftOptions).toEqual([{ requireRelevantVerifiedClaims: true }]);
  });

  it("retries an empty automation fact lookup with a controlled brief term", async () => {
    const factQueries: string[] = [];
    const fallbackResult = {
      facts: {
        items: [
          {
            id: ids.fact,
            brandId: ids.brand,
            normalizedKey: "outbound.contract.written_scope",
            claim: "出境跟团游合同应采用书面形式。",
            status: "verified",
            evidenceSourceIds: [],
            validFrom: "2026-07-01T00:00:00.000Z",
            validUntil: null,
          },
        ],
      },
      evidence: { items: [] },
    };
    const api = {
      ...fakeApi(),
      lookupFacts: async (
        _principal: Readonly<ActorContext>,
        input: { brandId: string; query: string; limit?: number },
      ) => {
        factQueries.push(input.query);
        return input.query === "出境"
          ? fallbackResult
          : { facts: { items: [] }, evidence: { items: [] } };
      },
    } satisfies InternalGeoApiClient;
    const runtime = createGovernedAgentRuntime(principal, api, governance(), {
      boundAutomationDraft: {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "为青岛家庭创作出境跟团游服务边界文章。",
        idempotencyKey: "automation:run:fallback-facts:v1",
      },
    });

    await expect(
      runtime.invoke("geo_fact_lookup", {
        tenantId: ids.tenant,
        brandId: ids.brand,
        query: "青岛",
        limit: 10,
      }),
    ).resolves.toEqual(fallbackResult);
    expect(factQueries).toEqual(["青岛", "出境"]);
  });

  it("does not retry an automation fact lookup that already returned verified facts", async () => {
    const factQueries: string[] = [];
    const verifiedResult = {
      facts: {
        items: [
          {
            id: ids.fact,
            status: "verified",
          },
        ],
      },
    };
    const api = {
      ...fakeApi(),
      lookupFacts: async (
        _principal: Readonly<ActorContext>,
        input: { brandId: string; query: string; limit?: number },
      ) => {
        factQueries.push(input.query);
        return verifiedResult;
      },
    } satisfies InternalGeoApiClient;
    const runtime = createGovernedAgentRuntime(principal, api, governance(), {
      boundAutomationDraft: {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "为青岛家庭创作出境跟团游服务边界文章。",
        idempotencyKey: "automation:run:verified-facts:v1",
      },
    });

    await expect(
      runtime.invoke("geo_fact_lookup", {
        tenantId: ids.tenant,
        brandId: ids.brand,
        query: "青岛",
        limit: 10,
      }),
    ).resolves.toEqual(verifiedResult);
    expect(factQueries).toEqual(["青岛"]);
  });

  it("stops after one controlled automation fact fallback when both lookups are empty", async () => {
    const factQueries: string[] = [];
    const emptyResult = { facts: { items: [] }, evidence: { items: [] } };
    const api = {
      ...fakeApi(),
      lookupFacts: async (
        _principal: Readonly<ActorContext>,
        input: { brandId: string; query: string; limit?: number },
      ) => {
        factQueries.push(input.query);
        return emptyResult;
      },
    } satisfies InternalGeoApiClient;
    const runtime = createGovernedAgentRuntime(principal, api, governance(), {
      boundAutomationDraft: {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "为青岛家庭创作出境跟团游服务边界文章。",
        idempotencyKey: "automation:run:empty-facts:v1",
      },
    });

    await expect(
      runtime.invoke("geo_fact_lookup", {
        tenantId: ids.tenant,
        brandId: ids.brand,
        query: "青岛",
        limit: 10,
      }),
    ).resolves.toEqual(emptyResult);
    expect(factQueries).toEqual(["青岛", "出境"]);
  });

  it("rejects a Ctrip automation draft without a location before persistence", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const runtime = createGovernedAgentRuntime(
      principal,
      fakeApi([], [], null, draftInputs),
      governance(),
      {
        boundAutomationDraft: {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          targetPlatform: "ctrip_community",
          brief: "为云南家庭写一篇跟团旅行体验文章。",
          idempotencyKey: "automation:run:ctrip-location-required:v1",
        },
      },
    );

    await expect(
      runtime.invoke("geo_draft_proposal", {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        brief: "model attempted replacement",
        targetPlatform: "sohu",
        idempotencyKey: "model-attempted-location-key",
        authoredDraft: {
          title: "带父母去云南怎么选行程",
          titleClaimIds: [],
          summary: "先看行程节奏，再核对服务边界。",
          summaryClaimIds: [],
          body: [
            {
              text: "## 先看节奏\n示例国际旅行服务可作为行程比较时的一个参考，重点还是核对每天车程和休息时间。",
              claimIds: [],
            },
            {
              text: "## 再看细节\n把住宿、用餐和景区接驳逐项问清楚。",
              claimIds: [],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CTRIP_LOCATION_REQUIRED" });
    expect(draftInputs).toHaveLength(0);
  });

  it("rejects fixture draft arguments unless the runtime explicitly enables fixtures", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const runtime = createGovernedAgentRuntime(
      principal,
      fakeApi([], [], null, draftInputs),
      governance(),
    );

    await expect(
      runtime.invoke("geo_draft_proposal", {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        brief: "fixture bypass",
        idempotencyKey: "fixture-bypass",
        fixtureMode: true,
      }),
    ).rejects.toMatchObject({ diagnosticReason: "tool_guard" });
    expect(draftInputs).toHaveLength(0);
  });

  it("corrects a premature Pi response once and authors exactly one automation draft", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["出境游客"],
        objectives: ["提供行前核验建议"],
        requiredPoints: ["说明信息时效性"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    let toolNames: readonly string[] = [];
    let correctionTranscript = "";
    let systemPrompt = "";
    const faux = registerFauxProvider({ provider: "geo-pi-automation-author-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("我会先规划文章结构，再整理草稿。"),
      (context) => {
        toolNames = (context.tools ?? []).map((tool) => tool.name);
        correctionTranscript = JSON.stringify(context.messages);
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage(
          [
            fauxToolCall("geo_draft_proposal", {
              tenantId: ids.tenant,
              brandId: ids.brand,
              campaignId: ids.campaign,
              brief: "model replacement brief",
              targetPlatform: "sohu",
              idempotencyKey: "model-replacement-key",
              authoredDraft: {
                title: "京都亲子行前核验清单",
                titleClaimIds: [ids.fact],
                summary: "按已核验信息准备行程，并在出发前复核。",
                summaryClaimIds: [ids.fact],
                locationQuery: "京都",
                body: [
                  {
                    text: "## 出发前核验\n示例国际旅行服务可作为信息核验协助方，具体要求以当前官方信息为准。",
                    claimIds: [ids.fact],
                  },
                  {
                    text: "## 行程安排\n亲子行程应预留交通和休息时间。",
                    claimIds: [ids.fact],
                  },
                ],
                mediaSearchPlan: [
                  {
                    query: "京都 金阁寺 Kinkakuji",
                    role: "cover",
                    rationale: "京都封面",
                    claimIds: [ids.fact],
                  },
                  {
                    query: "京都 伏见稻荷 Fushimi Inari",
                    role: "inline",
                    rationale: "神社段落",
                    claimIds: [ids.fact],
                  },
                  {
                    query: "京都 岚山 Arashiyama",
                    role: "inline",
                    rationale: "亲子路线",
                    claimIds: [ids.fact],
                  },
                  {
                    query: "京都 鸭川 Kamo River",
                    role: "inline",
                    rationale: "休息路线",
                    claimIds: [ids.fact],
                  },
                  {
                    query: "京都 锦市场 Nishiki Market",
                    role: "inline",
                    rationale: "餐饮路线",
                    claimIds: [ids.fact],
                  },
                ],
              },
            }),
          ],
          { stopReason: "toolUse", responseId: "provider-request-automation-1" },
        );
      },
      fauxAssistantMessage("should not be requested"),
    ]);
    const governanceCalls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [];
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile, draftInputs),
      governance: governance(governanceCalls, false),
      provider: "geo-pi-automation-author-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });
    const fullBrief = "写一篇京都亲子旅行行前核验软文，正文不得包含联系方式。";

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: fullBrief,
        articleTemplateId: "audience-fit-guide",
        diversityPlan: {
          strategyId: "audience-fit-decision",
          rotationIndex: 6,
          editorialProfile: "comparison",
          topicAngle: "带老人出境时怎样判断行程节奏是否合适",
          readerLens: "A family decision-maker comparing pace and constraints.",
          titleConstruction: "Name the family profile and one decisive pace condition.",
          openingPattern: "Open by naming who is likely to benefit.",
          bodyProgression: "traveler profile -> fit signal -> service value -> non-fit condition",
          ctaPattern: "Ask the reader to test the fit against their strictest condition.",
          mediaVisualDirection: "Intergenerational group, low-strain transit, and paced scenes.",
          forbiddenAdjacentPatterns: [
            "question-cluster-objection",
            "destination-value-narrative",
            "evidence-led-trust",
          ],
          keywordPoolId: "yunnan-selection-guide",
          keywordCandidates: ["去云南旅游怎么选旅行社", "云南旅游报团选哪家"],
        },
        remediation: {
          taskId: "automation-run:target-toutiao:remediation:1",
          scope: "target",
          mode: "automatic",
          attempt: 1,
          maxAttempts: 2,
          reasonCodes: [
            "duplicate.near",
            "promotion.hard_sell",
            "publisher.rejected.soft_advertorial",
          ],
          actions: ["change_diversity_blueprint", "rebuild_article", "soften_promotion"],
        },
        idempotencyKey: "automation:run:draft:v1",
      }),
    ).resolves.toMatchObject({
      providerMode: "pi_authored",
      providerRunId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      providerRequestId: "provider-request-automation-1",
      contentItemId: ids.content,
      contentVersionId: ids.version,
    });
    expect(faux.state.callCount).toBe(2);
    expect(correctionTranscript).toContain("我会先规划文章结构，再整理草稿。");
    expect(correctionTranscript).toContain("Your previous response ended before");
    expect(correctionTranscript).toContain("do not call one again after it has already succeeded");
    expect(correctionTranscript).toContain(
      "never call a tool that is not in the supplied tools list",
    );
    expect(correctionTranscript).toContain("Do not emit empty `{}` arguments");
    expect(correctionTranscript).toContain("geo_tenant_context");
    expect(correctionTranscript).toContain("geo_template_catalog");
    expect(correctionTranscript).toContain("geo_brand_profile");
    expect(correctionTranscript).toContain("geo_fact_lookup");
    expect(systemPrompt).toContain("<automation_diversity_plan>");
    expect(systemPrompt).toContain("This is a bounded remediation draft, not a light paraphrase.");
    expect(systemPrompt).toContain("Task automation-run:target-toutiao:remediation:1");
    expect(systemPrompt).toContain(
      "Audit reasons: duplicate.near, promotion.hard_sell, publisher.rejected.soft_advertorial.",
    );
    expect(systemPrompt).toContain(
      "Required corrective actions: change_diversity_blueprint, rebuild_article, soften_promotion.",
    );
    expect(systemPrompt).toContain("Do not reuse the failed title, opening, section order");
    expect(systemPrompt).toContain(
      "do not attempt to bypass platform, manual-review, account, or policy controls",
    );
    expect(systemPrompt).toContain(
      "The publisher explicitly rejected the previous article as advertising-style sponsored copy.",
    );
    expect(systemPrompt).toContain("never to disguise advertising or game the platform classifier");
    expect(systemPrompt).toContain("remove repeated praise, ranking slogans, qualification stacks");
    expect(systemPrompt).toContain("two or three neutral drawbacks");
    expect(systemPrompt).toContain(
      "Treat ranking, state-owned background, filing, qualification, and 5A-related wording as factual claims.",
    );
    expect(systemPrompt).toContain("Strategy ID: audience-fit-decision");
    expect(systemPrompt).toContain("Reader lens: A family decision-maker");
    expect(systemPrompt).toContain("Keyword pool: yunnan-selection-guide");
    expect(systemPrompt).toContain("去云南旅游怎么选旅行社");
    expect(systemPrompt).toContain("delete any candidate that is unsupported");
    expect(systemPrompt).toContain("an omitted candidate is not a validation failure");
    expect(systemPrompt).toContain("Forbidden adjacent-slot patterns");
    expect(systemPrompt).toContain("title formula, opening device, heading order, CTA");
    expect(systemPrompt).toContain(
      "selected brand's first body occurrence is in the first substantive paragraph",
    );
    expect(systemPrompt).toContain("before the second `##` heading");
    expect(toolNames).toContain("geo_draft_proposal");
    expect(toolNames).toEqual([
      "geo_tenant_context",
      "geo_template_catalog",
      "geo_brand_profile",
      "geo_fact_lookup",
      "geo_draft_proposal",
    ]);
    expect(toolNames).not.toContain("plastic_context_supply");
    expect(systemPrompt).toContain("pure content production machine");
    expect(systemPrompt).toContain("You are not a researcher, editor, auditor, publisher, planner");
    expect(systemPrompt).toContain("Identity: pure content production");
    expect(systemPrompt).toContain("This run ends after the first successful geo_draft_proposal");
    expect(systemPrompt).not.toContain("geo_media_search_import");
    expect(systemPrompt).not.toContain("geo_variant_preview");
    expect(systemPrompt).not.toContain("geo_audit_request");
    expect(systemPrompt).not.toContain("geo_publication_request");
    expect(systemPrompt).not.toContain("plastic_audit_pre_check");
    expect(systemPrompt).not.toContain("plastic_defense");
    expect(governanceCalls).toHaveLength(0);
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        "geo_variant_preview",
        "geo_audit_request",
        "geo_publication_request",
        "geo_media_search_import",
        "geo_media_production_request",
        "geo_media_job_status",
        "geo_visibility_request",
        "plastic_context_supply",
        "plastic_audit_pre_check",
        "plastic_defense",
      ]),
    );
    expect(draftInputs[0]).toMatchObject({
      brief: fullBrief,
      targetPlatform: "ctrip_community",
      articleTemplateId: "audience-fit-guide",
      idempotencyKey: "automation:run:draft:v1",
    });
  });

  it("fails the automation draft fast when the corrective continuation still does not call geo_draft_proposal", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-automation-correction-fail-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("我会先规划文章结构，再整理草稿。"),
      fauxAssistantMessage("我无法在当前阶段完成草稿。"),
      fauxAssistantMessage("should not be requested"),
    ]);
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["出境游客"],
        objectives: ["提供行前核验建议"],
        requiredPoints: ["说明信息时效性"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile),
      governance: governance(),
      provider: "geo-pi-automation-correction-fail-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "写一篇青岛家庭出境跟团成本软文",
        idempotencyKey: "automation:run:draft:correction-fail",
      }),
    ).rejects.toMatchObject({
      diagnosticReason: "tool_guard",
      lastToolName: null,
    });
    expect(faux.state.callCount).toBe(2);
  });

  it("classifies repeated malformed automation draft arguments as draft input", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-automation-argument-rejection-test" });
    fauxRegistrations.push(faux);
    const malformedDraftArguments = {
      authoredDraft: {
        title: "青岛家庭出境准备",
        titleClaimIds: [],
        summary: "先把合同和出发节奏核对清楚。",
        summaryClaimIds: [],
        locationQuery: "青岛",
        body: [
          { text: "## 先核对合同\n把费用范围和调整条件写清楚。", claimIds: [] },
          { text: "## 再安排节奏\n给交通和休息留出时间。", claimIds: [] },
        ],
        unexpectedDraftProperty: "must be rejected before tool execution",
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("geo_template_catalog", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("geo_brand_profile", { tenantId: ids.tenant, brandId: ids.brand }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          tenantId: ids.tenant,
          brandId: ids.brand,
          query: "青岛",
          limit: 10,
        }),
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("geo_draft_proposal", malformedDraftArguments), {
          stopReason: "toolUse",
        }),
      ),
    ]);
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["出境游客"],
        objectives: ["提供行前核验建议"],
        requiredPoints: ["说明信息时效性"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile),
      governance: governance(),
      provider: "geo-pi-automation-argument-rejection-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      maxToolCalls: 20,
      maxRepeatedToolCalls: 3,
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "为青岛家庭写一篇出境跟团行前准备文章。",
        idempotencyKey: "automation:run:draft:argument-rejection",
      }),
    ).rejects.toMatchObject({
      diagnosticReason: "draft_input",
      failureCode: "AUTHORED_DRAFT_ARGUMENTS_INVALID",
      toolCallCount: 7,
      lastToolName: "geo_draft_proposal",
    });
    expect(faux.state.callCount).toBe(7);
  });

  it("corrects a missing Ctrip location and late brand before persisting once", async () => {
    const draftInputs: DraftProposalInput[] = [];
    let locationCorrectionTranscript = "";
    let brandCorrectionTranscript = "";
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["出境游客"],
        objectives: ["提供签约建议"],
        requiredPoints: ["说明合同与费用边界"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const mediaSearchPlan = [
      {
        query: "青岛 五四广场 May Fourth Square",
        role: "cover" as const,
        rationale: "开篇城市选择场景",
        claimIds: [ids.fact],
      },
      {
        query: "青岛 栈桥 Zhanqiao Pier",
        role: "inline" as const,
        rationale: "行程选择段落",
        claimIds: [ids.fact],
      },
      {
        query: "青岛站 Qingdao Railway Station",
        role: "inline" as const,
        rationale: "交通安排段落",
        claimIds: [ids.fact],
      },
      {
        query: "青岛 八大关 Badaguan",
        role: "inline" as const,
        rationale: "服务比较段落",
        claimIds: [ids.fact],
      },
    ];
    const commonDraft = {
      title: "青岛出境游签约备忘",
      titleClaimIds: [ids.fact],
      summary: "先把合同与费用边界问清楚，再判断服务是否适合自己。",
      summaryClaimIds: [ids.fact],
      mediaSearchPlan,
    };
    const faux = registerFauxProvider({ provider: "geo-pi-brand-placement-correction-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("geo_draft_proposal", {
          authoredDraft: {
            ...commonDraft,
            body: [
              {
                text: "## 先判断需求\n先核对书面合同、费用范围和行程变化条件，再比较不同服务方案。",
                claimIds: [ids.fact],
              },
              {
                text: "## 再确认服务\n把同行人数和节奏偏好说明清楚后，可将示例国际旅行服务作为本地咨询备选。",
                claimIds: [ids.fact],
              },
            ],
          },
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        locationCorrectionTranscript = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            authoredDraft: {
              ...commonDraft,
              locationQuery: "青岛",
              body: [
                {
                  text: "## 先判断需求\n先核对书面合同、费用范围和行程变化条件，再比较不同服务方案。",
                  claimIds: [ids.fact],
                },
                {
                  text: "## 再确认服务\n把同行人数和节奏偏好说明清楚后，可将示例国际旅行服务作为本地咨询备选。",
                  claimIds: [ids.fact],
                },
              ],
            },
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        brandCorrectionTranscript = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            authoredDraft: {
              ...commonDraft,
              locationQuery: "青岛",
              body: [
                {
                  text: "## 先判断需求\n示例国际旅行服务可作为本地咨询备选，先核对书面合同、费用范围和行程变化条件，再判断服务是否适合自己。",
                  claimIds: [ids.fact],
                },
                {
                  text: "## 再确认服务\n把同行人数和节奏偏好说明清楚，再比较不同服务方案。",
                  claimIds: [ids.fact],
                },
              ],
            },
          }),
          { stopReason: "toolUse", responseId: "provider-request-brand-corrected" },
        );
      },
      fauxAssistantMessage("should not be requested"),
    ]);
    const api = {
      ...fakeApi([], [], profile, draftInputs),
      getTenantContext: async () => ({
        tenant: { id: ids.tenant },
        brands: [
          {
            id: ids.brand,
            displayName: "示例国际旅行服务",
            industry: "travel",
            isPrimary: true,
          },
        ],
      }),
    } satisfies InternalGeoApiClient;
    const service = new RealPiAgentRunService({
      api,
      governance: governance([], false),
      provider: "geo-pi-brand-placement-correction-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "品牌在首个实质段落自然出现，写一篇青岛出境游签约软文。",
        articleTemplateId: "local-service-page",
        diversityPlan: {
          strategyId: "local-service-decision",
          rotationIndex: 7,
          editorialProfile: "comparison",
          topicAngle: "青岛家庭签约前怎样判断服务是否匹配",
          readerLens: "A traveler comparing service fit before signing.",
          titleConstruction: "Name the traveler and signing decision.",
          openingPattern: "Open with the signing decision.",
          bodyProgression: "decision -> service value -> fit boundary",
          ctaPattern: "Invite a low-pressure fit check.",
          mediaVisualDirection: "Departure access, consultation exterior, and destination arrival.",
          forbiddenAdjacentPatterns: ["generic-checklist"],
          keywordPoolId: "yunnan-selection-guide",
          keywordCandidates: ["去云南旅游怎么选旅行社", "云南旅游报团选哪家"],
        },
        idempotencyKey: "automation:run:brand-placement:v1",
      }),
    ).resolves.toMatchObject({
      providerMode: "pi_authored",
      providerRequestId: "provider-request-brand-corrected",
      contentVersionId: ids.version,
    });
    expect(locationCorrectionTranscript).toContain("CTRIP_LOCATION_REQUIRED");
    expect(locationCorrectionTranscript).toContain("authoredDraft.locationQuery");
    expect(brandCorrectionTranscript).toContain("CTRIP_BRAND_PLACEMENT_TOO_LATE");
    expect(brandCorrectionTranscript).toContain("before the second ## heading");
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]).toEqual(
      expect.objectContaining({
        authoredDraft: expect.objectContaining({
          body: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining("示例国际旅行服务") }),
          ]),
        }),
      }),
    );
    expect(faux.state.callCount).toBe(3);
  });

  it("returns exact verified fact text after a rejected automation draft", async () => {
    const verifiedClaim = "出境跟团游的包价旅游合同应采用书面形式。";
    const draftInputs: DraftProposalInput[] = [];
    const correctionTranscripts: string[] = [];
    let proposalAttempts = 0;
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 1,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、实用",
        audiences: ["出境游客"],
        objectives: ["提供签约核验建议"],
        requiredPoints: ["说明合同与费用边界"],
        forbiddenClaims: ["保证结果"],
        callToAction: "无硬性行动号召",
        agentInstructions: "品牌自然出现一次",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    const api = {
      ...fakeApi([], [], profile),
      lookupFacts: async () => ({
        facts: {
          items: [
            {
              id: ids.fact,
              brandId: ids.brand,
              status: "verified",
              claim: verifiedClaim,
              evidenceSourceIds: [],
            },
          ],
        },
        evidence: { items: [] },
      }),
      proposeDraft: async (_principal, input) => {
        proposalAttempts += 1;
        if (proposalAttempts === 1) {
          throw Object.assign(new Error("rejected draft details must stay private"), {
            code: "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
            status: 422,
          });
        }
        if (proposalAttempts === 2) {
          throw Object.assign(new Error("media plan is required"), {
            code: "AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED",
            status: 422,
          });
        }
        draftInputs.push(input);
        return {
          providerMode: "authored" as const,
          contentItemId: ids.content,
          contentVersionId: ids.version,
          claimIds: [ids.fact],
        };
      },
    } satisfies InternalGeoApiClient;
    const commonDraft = {
      title: "青岛家庭出境签约核验",
      titleClaimIds: [] as string[],
      summary: "先确认书面约定，再比较行程与费用边界。",
      summaryClaimIds: [] as string[],
      locationQuery: "青岛",
      mediaSearchPlan: [
        {
          query: "青岛 栈桥 Qingdao Zhanqiao Pier",
          role: "cover" as const,
          rationale: "对应青岛出发场景",
          claimIds: [] as string[],
        },
        ...[
          "青岛 胶东国际机场 Qingdao Jiaodong Airport",
          "青岛 火车站 Qingdao Railway Station",
          "青岛 八大关 Qingdao Badaguan",
        ].map((query) => ({
          query,
          role: "inline" as const,
          rationale: "对应正文中的城市与交通场景",
          claimIds: [] as string[],
        })),
      ],
    };
    const faux = registerFauxProvider({ provider: "geo-pi-fact-text-correction-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("geo_template_catalog", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("geo_brand_profile", { tenantId: ids.tenant, brandId: ids.brand }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          tenantId: ids.tenant,
          brandId: ids.brand,
          query: "合同",
          limit: 10,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_draft_proposal", {
          authoredDraft: {
            ...commonDraft,
            body: [
              {
                text: "## 先核验合同\n示例国际旅行服务可协助梳理签约问题。",
                claimIds: [ids.fact],
              },
              { text: "## 再比较行程\n逐项确认费用和节奏。", claimIds: [] },
            ],
          },
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        correctionTranscripts.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            authoredDraft: {
              ...commonDraft,
              body: [
                {
                  text: `## 先核验合同\n示例国际旅行服务可协助梳理签约问题。${verifiedClaim}`,
                  claimIds: [ids.fact],
                },
                { text: "## 再比较行程\n逐项确认费用和节奏。", claimIds: [] },
              ],
            },
          }),
          { stopReason: "toolUse", responseId: "provider-request-media-corrected" },
        );
      },
      (context) => {
        correctionTranscripts.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            authoredDraft: {
              ...commonDraft,
              body: [
                {
                  text: `## 先核验合同\n示例国际旅行服务可协助梳理签约问题。${verifiedClaim}`,
                  claimIds: [ids.fact],
                },
                { text: "## 再比较行程\n逐项确认费用和节奏。", claimIds: [] },
              ],
            },
          }),
          { stopReason: "toolUse", responseId: "provider-request-fact-and-media-corrected" },
        );
      },
      fauxAssistantMessage("should not be requested"),
    ]);
    const service = new RealPiAgentRunService({
      api,
      governance: governance([], false),
      provider: "geo-pi-fact-text-correction-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.authorAutomationDraft(principal, {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "为青岛家庭写一篇出境跟团签约核验文章。",
        idempotencyKey: "automation:run:fact-text-correction:v1",
      }),
    ).resolves.toMatchObject({
      providerMode: "pi_authored",
      providerRequestId: "provider-request-fact-and-media-corrected",
      contentVersionId: ids.version,
    });

    expect(correctionTranscripts[0]).toContain("AUTHORED_DRAFT_FACT_TEXT_REQUIRED");
    expect(correctionTranscripts[0]).toContain(`ID=${ids.fact}`);
    expect(correctionTranscripts[0]).toContain(String.raw`CLAIM=\"${verifiedClaim}\"`);
    expect(correctionTranscripts[0]).toContain("titleClaimIds");
    expect(correctionTranscripts[0]).toContain("summaryClaimIds");
    expect(correctionTranscripts[0]).toContain("mediaSearchPlan");
    expect(correctionTranscripts[0]).toContain("Choose exactly one allowed pair");
    expect(correctionTranscripts[0]).not.toContain("rejected draft details must stay private");
    expect(correctionTranscripts[1]).toContain("AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED");
    expect(correctionTranscripts[1]).toContain("sectionRef");
    expect(correctionTranscripts[1]).toContain("retryBudget");
    expect(proposalAttempts).toBe(3);
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]?.authoredDraft).toMatchObject({
      titleClaimIds: [],
      summaryClaimIds: [],
      body: [
        { text: expect.stringContaining(verifiedClaim), claimIds: [ids.fact] },
        { claimIds: [] },
      ],
      mediaSearchPlan: expect.arrayContaining([expect.objectContaining({ claimIds: [] })]),
    });
    expect(faux.state.callCount).toBe(7);
  });

  it("passes original model-authored prose and supporting fact IDs to geo_draft_proposal", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const mediaSearchInputs: MediaSearchImportInput[] = [];
    const scopeToolNames: string[] = [];
    const faux = registerFauxProvider({ provider: "geo-pi-authored-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("geo_draft_proposal", {
            tenantId: ids.tenant,
            brandId: ids.brand,
            campaignId: ids.campaign,
            brief: "出发前材料核对",
            targetPlatform: "sohu",
            articleTemplateId: "step-by-step-guide",
            idempotencyKey: "authored-draft-test",
            authoredDraft: {
              title: "出发前先核对这项材料",
              titleClaimIds: [ids.fact],
              summary: "按已核验资料整理一份检查顺序。",
              summaryClaimIds: [ids.fact],
              body: [{ text: "先核对材料，再联系旅行社确认。", claimIds: [ids.fact] }],
              mediaSearchPlan: [
                {
                  query: "京都 金阁寺 Kinkakuji",
                  role: "cover",
                  rationale: "封面对应京都主题",
                  claimIds: [ids.fact],
                },
                {
                  query: "京都 伏见稻荷 Fushimi Inari",
                  role: "inline",
                  rationale: "正文景点段落",
                  claimIds: [ids.fact],
                },
                {
                  query: "京都 岚山 Arashiyama",
                  role: "inline",
                  rationale: "正文路线段落",
                  claimIds: [ids.fact],
                },
                {
                  query: "京都 锦市场 Nishiki Market",
                  role: "inline",
                  rationale: "正文餐饮段落",
                  claimIds: [ids.fact],
                },
                {
                  query: "京都 鸭川 Kamo River",
                  role: "inline",
                  rationale: "正文漫步段落",
                  claimIds: [ids.fact],
                },
              ],
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("geo_media_search_import", {
            tenantId: ids.tenant,
            contentVersionId: ids.version,
            platform: "sohu",
            idempotencyKey: "authored-media-search-test",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("已提交原创草稿并绑定事实证据。")),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi([], scopeToolNames, null, draftInputs, mediaSearchInputs),
      governance: governance(),
      provider: "geo-pi-authored-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await service.run(principal, {
      workflow: "prompt",
      targetPlatform: "sohu",
      prompt: "写一篇原创文章",
    });

    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]?.authoredDraft).toMatchObject({
      title: "出发前先核对这项材料",
      body: [{ text: "先核对材料，再联系旅行社确认。", claimIds: [ids.fact] }],
      mediaSearchPlan: expect.arrayContaining([
        expect.objectContaining({ query: "京都 金阁寺 Kinkakuji", role: "cover" }),
      ]),
    });
    expect(draftInputs[0]?.targetPlatform).toBe("sohu");
    expect(mediaSearchInputs).toEqual([
      {
        contentVersionId: ids.version,
        platform: "sohu",
        idempotencyKey: "authored-media-search-test",
      },
    ]);
  });

  it("returns exact unknown draft property paths to Pi so a corrected JSON call can succeed", async () => {
    const draftInputs: DraftProposalInput[] = [];
    let validationResult = "";
    const validAuthoredDraft = {
      title: "出发前先核对服务边界",
      titleClaimIds: [ids.fact],
      summary: "按已核验资料选择家庭出境游服务。",
      summaryClaimIds: [ids.fact],
      body: [{ text: "## 服务边界\n先确认合同与费用范围。", claimIds: [ids.fact] }],
    };
    const faux = registerFauxProvider({ provider: "geo-pi-json-correction-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("geo_draft_proposal", {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          brief: "家庭出境游服务边界",
          idempotencyKey: "invalid-json-shape",
          authoredDraft: {
            ...validAuthoredDraft,
            body: [
              {
                ...validAuthoredDraft.body[0],
                heading: "private-heading-value-must-not-be-echoed",
              },
            ],
          },
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        validationResult = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            tenantId: ids.tenant,
            brandId: ids.brand,
            campaignId: ids.campaign,
            brief: "家庭出境游服务边界",
            idempotencyKey: "corrected-json-shape",
            authoredDraft: validAuthoredDraft,
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("草稿参数已修正。"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], null, draftInputs),
      governance: governance(),
      provider: "geo-pi-json-correction-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await service.run(principal, { workflow: "prompt", prompt: "写一篇服务边界文章" });

    expect(validationResult).toContain(
      "Unknown tool argument properties: authoredDraft.body[0].heading",
    );
    expect(validationResult).not.toContain("private-heading-value-must-not-be-echoed");
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]?.idempotencyKey).toBe("corrected-json-shape");
  });

  it("binds formal UI draft scope before tenant policy checks model tool arguments", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const scopeInputs: Array<Readonly<Record<string, unknown>>> = [];
    const api = {
      ...fakeApi([], [], null, draftInputs),
      authorizeResourceScope: async (
        _principal: Readonly<ActorContext>,
        _toolName: string,
        args: Readonly<Record<string, unknown>>,
      ) => {
        scopeInputs.push(args);
        return (
          args.tenantId === ids.tenant &&
          (args.brandId === undefined || args.brandId === ids.brand) &&
          (args.campaignId === undefined || args.campaignId === ids.campaign)
        );
      },
    } satisfies InternalGeoApiClient;
    const faux = registerFauxProvider({ provider: "geo-pi-formal-scope-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("geo_draft_proposal", {
          tenantId: ids.tenant,
          brandId: "20000000-0000-4000-8000-000000000301",
          campaignId: "20000000-0000-4000-8000-000000000501",
          brief: "model attempted replacement",
          targetPlatform: "sohu",
          articleTemplateId: "invented-template",
          idempotencyKey: "model-attempted-key",
          authoredDraft: {
            title: "青岛家庭出境游选择",
            titleClaimIds: [ids.fact],
            summary: "先确认合同和费用边界。",
            summaryClaimIds: [ids.fact],
            locationQuery: "青岛",
            body: [{ text: "## 服务边界\n先核对书面约定。", claimIds: [ids.fact] }],
          },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("正式范围内草稿已创建。"),
    ]);
    const service = new RealPiAgentRunService({
      api,
      governance: governance(),
      provider: "geo-pi-formal-scope-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await service.run(principal, {
      workflow: "prompt",
      targetPlatform: "ctrip_community",
      prompt: "创建正式租户文章",
      draftScope: {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief: "正式网关绑定的完整文章目标",
        articleTemplateId: "step-by-step-guide",
        idempotencyKey: "formal-ui-draft-scope",
      },
    });

    expect(scopeInputs.at(-1)).toMatchObject({
      tenantId: ids.tenant,
      brandId: ids.brand,
      campaignId: ids.campaign,
    });
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]).toMatchObject({
      brandId: ids.brand,
      campaignId: ids.campaign,
      brief: "正式网关绑定的完整文章目标",
      targetPlatform: "ctrip_community",
      articleTemplateId: "step-by-step-guide",
      idempotencyKey: "formal-ui-draft-scope",
    });
  });

  it("continues a formal workflow when Pi stops after fact lookup", async () => {
    const draftInputs: DraftProposalInput[] = [];
    const mediaSearchInputs: MediaSearchImportInput[] = [];
    const publicationInputs: PublicationRequestInput[] = [];
    let correctionTranscript = "";
    const authoredDraft = {
      title: "青岛家庭出境怎么选",
      titleClaimIds: [ids.fact],
      summary: "从书面合同和费用边界判断服务价值。",
      summaryClaimIds: [ids.fact],
      locationQuery: "青岛",
      body: [
        {
          text: "## 一家人的出境决定\n示例国际旅行服务被自然放进家庭咨询与比较场景。",
          claimIds: [ids.fact],
        },
        {
          text: "## 合同与费用边界\n按已核验事实理解书面合同与费用范围。",
          claimIds: [ids.fact],
        },
      ],
      mediaSearchPlan: [
        {
          query: "青岛 栈桥 Qingdao Zhanqiao Pier",
          role: "cover" as const,
          rationale: "对应青岛家庭出发场景",
          claimIds: [ids.fact],
        },
        ...[
          "青岛 胶东国际机场 Qingdao Jiaodong Airport",
          "青岛 火车站 Qingdao Railway Station",
          "青岛 八大关 Qingdao Badaguan",
          "青岛 五四广场 Qingdao May Fourth Square",
        ].map((query) => ({
          query,
          role: "inline" as const,
          rationale: "对应正文中的真实城市与交通场景",
          claimIds: [ids.fact],
        })),
      ],
    };
    const faux = registerFauxProvider({ provider: "geo-pi-required-workflow-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }),
          fauxToolCall("geo_template_catalog", { tenantId: ids.tenant }),
          fauxToolCall("geo_brand_profile", { tenantId: ids.tenant, brandId: ids.brand }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          tenantId: ids.tenant,
          brandId: ids.brand,
          query: "合同",
          limit: 10,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("事实已检索，工作流到此结束。"),
      (context) => {
        correctionTranscript = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall("geo_draft_proposal", {
            tenantId: ids.tenant,
            brandId: ids.brand,
            campaignId: ids.campaign,
            brief: "model replacement",
            targetPlatform: "sohu",
            idempotencyKey: "model-replacement",
            authoredDraft,
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall("geo_media_search_import", {
          tenantId: ids.tenant,
          contentVersionId: ids.version,
          platform: "ctrip_community",
          idempotencyKey: "formal-media-search",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_variant_preview", {
          tenantId: ids.tenant,
          contentVersionId: ids.mediaVersion,
          channelAccountId: ids.account,
          platform: "ctrip_community",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_audit_request", {
          tenantId: ids.tenant,
          variantId: ids.variant,
          idempotencyKey: "formal-audit",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_publication_request", {
          tenantId: ids.tenant,
          variantId: ids.variant,
          channelAccountId: ids.account,
          executionLevel: "assisted",
          idempotencyKey: "formal-publication",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("正式工作流已停在携程准发布请求。"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(publicationInputs, [], null, draftInputs, mediaSearchInputs),
      governance: governance(),
      provider: "geo-pi-required-workflow-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.run(principal, {
        workflow: "prompt",
        requiredWorkflow: "draft_to_publication",
        targetPlatform: "ctrip_community",
        prompt: `完成携程工作流，账号 ${ids.account}`,
        draftScope: {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          targetPlatform: "ctrip_community",
          brief: "正式租户真实文章",
          articleTemplateId: "local-service-page",
          idempotencyKey: "formal-required-workflow",
        },
      }),
    ).resolves.toMatchObject({
      providerMode: "pi",
      response: "正式工作流已停在携程准发布请求。",
    });

    expect(correctionTranscript).toContain("事实已检索，工作流到此结束。");
    expect(correctionTranscript).toContain("Next missing required stage: geo_draft_proposal");
    expect(draftInputs).toHaveLength(1);
    expect(draftInputs[0]).toMatchObject({
      targetPlatform: "ctrip_community",
      articleTemplateId: "local-service-page",
      idempotencyKey: "formal-required-workflow",
    });
    expect(mediaSearchInputs).toEqual([
      {
        contentVersionId: ids.version,
        platform: "ctrip_community",
        idempotencyKey: "formal-media-search",
      },
    ]);
    expect(publicationInputs).toEqual([
      expect.objectContaining({
        channelAccountId: ids.account,
        executionLevel: "assisted",
      }),
    ]);
  });

  it("injects the selected immutable Brand Agent Profile into the real Pi system prompt", async () => {
    const profile: BrandAgentProfile = {
      id: ids.profile,
      brandId: ids.brand,
      version: 3,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "克制、清晰，先给结论再解释",
        audiences: ["首次出境游客"],
        objectives: ["帮助客户核验服务边界"],
        requiredPoints: ["说明信息有效期"],
        forbiddenClaims: ["保证签证通过"],
        callToAction: "通过官方热线核验当前行程。",
        agentInstructions: "优先选择证据完整的文章策略。",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    };
    let systemPrompt = "";
    const faux = registerFauxProvider({ provider: "geo-pi-profile-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("已按品牌约定选择文章策略。");
      },
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile),
      governance: governance(),
      provider: "geo-pi-profile-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await service.run(principal, {
      workflow: "prompt",
      brandId: ids.brand,
      prompt: "为品牌规划下一篇文章",
    });

    expect(systemPrompt).toContain(`Brand ID: ${ids.brand}`);
    expect(systemPrompt).toContain(`Profile ID: ${ids.profile}`);
    expect(systemPrompt).toContain("Profile version: 3");
    expect(systemPrompt).toContain(`Profile document SHA-256: ${"a".repeat(64)}`);
    expect(systemPrompt).toContain('"voice":"克制、清晰，先给结论再解释"');
    expect(systemPrompt).toContain("must not bypass canonical closed-content rendering");
    expect(systemPrompt).toContain("must not bypass deterministic audit");
    expect(systemPrompt).toContain("Start every operational workflow with geo_tenant_context");
    expect(systemPrompt).toContain("geo_template_catalog");
    expect(systemPrompt).toContain("geo_fact_lookup");
    expect(systemPrompt).toContain("exact substring matching, not semantic search");
    expect(systemPrompt).toContain("never a space-joined keyword list");
    expect(systemPrompt).toContain("one literal phrase of at most 12 Unicode characters");
    expect(systemPrompt).toContain("For a Japan brief, use `日本`");
    expect(systemPrompt).toContain("must not contain spaces, `+`, a list, or an explanation");
    expect(systemPrompt).toContain("geo_draft_proposal");
    expect(systemPrompt).toContain("Supporting verified fact IDs");
    expect(systemPrompt).toContain(
      "if you cannot reproduce the exact sentence, leave that claimIds array empty",
    );
    expect(systemPrompt).toContain(
      "For Ctrip Community keep the authored title between 5 and 20 Unicode characters",
    );
    expect(systemPrompt).toContain("attach exactly 4 images before audit");
    expect(systemPrompt).toContain("exactly 1 cover and 3 inline images");
    expect(systemPrompt).toContain("authoredDraft.mediaSearchPlan");
    expect(systemPrompt).toContain("English proper noun that Wikimedia Commons can resolve");
    expect(systemPrompt).toContain("photographic travel scenes that a vision model can verify");
    expect(systemPrompt).toContain("Never use passports, visa pages, identity documents");
    expect(systemPrompt).toContain("weather maps or screens");
    expect(systemPrompt).toContain("Do not call geo_media_production_request");
    expect(systemPrompt).toContain("call geo_media_search_import exactly once");
    expect(systemPrompt).toContain(
      "For every public-platform draft, set geo_draft_proposal.targetPlatform",
    );
    expect(systemPrompt).toContain("Installed Pi GEO skill bundle: geo.pi-commercial-skills.v4");
    expect(systemPrompt).toContain('<pi_skill id="humanizer-zh" version="1.0.0">');
    expect(systemPrompt).toContain("去除 AI 痕迹");
    expect(systemPrompt).toContain("commercial GEO soft promotion is mandatory");
    expect(systemPrompt).toContain('<pi_skill id="buyer-demand-intelligence" version="1.0.0">');
    expect(systemPrompt).toContain("Tool-call discipline: make exactly one MCP tool call per step");
    expect(systemPrompt).toContain("WORKFLOW_NEXT_STEP");
    expect(systemPrompt).toContain("Task ID:");
    expect(systemPrompt).toContain("parallelize only independent read calls");
    expect(systemPrompt).toContain("Never call tools merely to fill turns");
    expect(systemPrompt).toContain("Fill missing arguments first; never guess IDs");
    expect(systemPrompt).toContain("do not invent, pad, or fake a result");
    expect(systemPrompt).toContain("never use an AI or audit tool to bypass the gate");
    expect(systemPrompt).toContain("call geo_fact_lookup before geo_draft_proposal");
    expect(systemPrompt).toContain("exact selected brand displayName 1 to 3 times");
    expect(systemPrompt).toContain("keep the selected brand out of the title and summary");
    expect(systemPrompt).toContain(
      "first occurrence must be in the first substantive paragraph after the opening buyer answer",
    );
    expect(systemPrompt).toContain("never defer the first brand mention");
    expect(systemPrompt).toContain("connect the brand to the reader's scenario");
    expect(systemPrompt).toContain("footer-only attribution is insufficient");
    expect(systemPrompt).toContain(
      "never state or imply that the brand organized, wrote, prepared, published, verified, or endorsed",
    );
    expect(systemPrompt).toContain("supplied the article's service experience");
    expect(systemPrompt).toContain("Omit any unsupported operational role");
    expect(systemPrompt).not.toContain(
      "as the content organizer, source of service experience, or verification helper",
    );
    expect(systemPrompt).toContain(
      "must never mention GEO, Pi, agents, prompts, tools, tool names, fact IDs, audits, providers, models, retrieval, system responses",
    );
    expect(systemPrompt).toContain("Express an evidence limitation in reader-facing language");
    expect(systemPrompt).toContain("never write that GEO or a tool did not return information");
    expect(systemPrompt).toContain(
      "zero phone numbers, WeChat terms or IDs, email addresses, websites, external links, QR codes",
    );
    expect(systemPrompt).toContain("even when they match an approved tenant contact");
    expect(systemPrompt).toContain("low-pressure next step");
    expect(systemPrompt).toContain("hard-sell call to action");
    expect(systemPrompt).toContain("natural editorial soft promotion, not an SOP");
    expect(systemPrompt).toContain("do not organize the body around numbered steps");
    expect(systemPrompt).toContain("first-person conversational voice");
    expect(systemPrompt).toContain("what problem this section will solve");
    expect(systemPrompt).toContain("two or three substantive points");
    expect(systemPrompt).toContain("你可以这样");
    expect(systemPrompt).toContain("综上所述");
    expect(systemPrompt).toContain("replace `因此` with `所以`");
    expect(systemPrompt).toContain(
      "only when the brief or verified evidence supplies that experience",
    );
    expect(systemPrompt).toContain("Preserve the selected template structure and verified meaning");
    expect(systemPrompt).toContain("Do not place multiple verified claims back-to-back");
    expect(systemPrompt).toContain("use the returned finalContentVersionId");
    expect(systemPrompt).toContain("If the caller does not explicitly request those later steps");
    expect(systemPrompt).toContain(
      "Templates define the article structure and GEO mechanisms only",
    );
    expect(systemPrompt).toContain("at least two substantive `##` section headings");
    expect(systemPrompt).toContain("include the tool-returned claim text verbatim");
    expect(systemPrompt).toContain("deterministic audit requires the complete verified text");
    expect(systemPrompt).toContain("Pass the original prose to geo_draft_proposal.authoredDraft");
    expect(systemPrompt).toContain("authoredDraft accepts only this JSON shape");
    expect(systemPrompt).toContain("at least two substantive sections");
    expect(systemPrompt).toContain("Put Markdown headings inside body[].text");
    expect(systemPrompt).toContain("geo_variant_preview");
    expect(systemPrompt).toContain("geo_audit_request");
    expect(systemPrompt).toContain("A reviewed browser-backed platform account may use unattended");
    expect(systemPrompt).toContain("Request executionLevel=unattended");
    expect(systemPrompt).not.toContain("Toutiao and Sohu remain dry_run only");
  });

  it("fails the run without exposing a Pi provider error as a successful empty response", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-error-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Authorization: Bearer provider-secret",
      }),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "502 Upstream access forbidden: provider-secret",
      }),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-error-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      providerRetryDelaysMs: [0],
    });

    let captured: unknown;
    try {
      await service.run(principal, { workflow: "prompt", prompt: "Review evidence" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PiAgentRunError);
    expect(captured).toMatchObject({
      code: "AGENT_PROVIDER_FAILED",
      statusCode: 502,
      diagnosticReason: "provider_error",
      providerFailureClass: "upstream",
    });
    expect((captured as Error).message).not.toContain("provider-secret");
    expect(faux.state.callCount).toBe(2);
  });

  it("classifies a terminated provider stream as a network failure", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-terminated-stream-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-terminated-stream-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      providerRetryDelaysMs: [],
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "生成正文" }),
    ).rejects.toMatchObject({ providerFailureClass: "network" });
  });

  it("classifies a provider transport exception before Pi creates an error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "openai-compatible",
      model: jsonOpenAICompletionsModel({
        id: "transport-exception-model",
        name: "transport-exception-model",
        api: "openai-completions",
        provider: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      }),
      modelId: "transport-exception-model",
      apiKey: "test-key",
      providerRetryDelaysMs: [],
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "生成正文" }),
    ).rejects.toMatchObject({
      code: "AGENT_PROVIDER_FAILED",
      providerFailureClass: "network",
    });
  });

  it("fails fast when the provider repeats the same tool call", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-repeat-guard-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-repeat-guard-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      maxRepeatedToolCalls: 3,
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "读取租户上下文" }),
    ).rejects.toMatchObject({
      diagnosticReason: "tool_guard",
      providerFailureClass: null,
      toolCallCount: 3,
      lastToolName: "geo_tenant_context",
    });
    expect(faux.state.callCount).toBe(3);
  });

  it("executes the budget-th valid tool call before terminating the run", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-valid-tool-budget-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
    ]);
    const scopeToolNames: string[] = [];
    const service = new RealPiAgentRunService({
      api: fakeApi([], scopeToolNames),
      governance: governance(),
      provider: "geo-pi-valid-tool-budget-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      maxToolCalls: 1,
      maxRepeatedToolCalls: 10,
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "读取租户上下文" }),
    ).rejects.toMatchObject({
      diagnosticReason: "tool_guard",
      toolCallCount: 1,
      lastToolName: "geo_tenant_context",
    });
    expect(scopeToolNames).toContain("geo_tenant_context");
    expect(faux.state.callCount).toBe(1);
  });

  it("normalizes argument key order for the repeated tool guard", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-normalized-repeat-guard-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          tenantId: ids.tenant,
          brandId: ids.brand,
          query: "青岛",
          limit: 2,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          query: "青岛",
          limit: 2,
          brandId: ids.brand,
          tenantId: ids.tenant,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("geo_fact_lookup", {
          limit: 2,
          tenantId: ids.tenant,
          query: "青岛",
          brandId: ids.brand,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("错误地越过重复调用预算后结束。"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-normalized-repeat-guard-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      maxToolCalls: 10,
      maxRepeatedToolCalls: 3,
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "查询青岛事实" }),
    ).rejects.toMatchObject({
      diagnosticReason: "tool_guard",
      toolCallCount: 3,
      lastToolName: "geo_fact_lookup",
    });
    expect(faux.state.callCount).toBe(3);
  });

  it("counts rejected tool arguments toward the run tool budget", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-invalid-tool-budget-test" });
    fauxRegistrations.push(faux);
    const rejectedValue = "must-not-appear-in-diagnostics";
    faux.setResponses([
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage(
          fauxToolCall("geo_tenant_context", {
            tenantId: ids.tenant,
            unexpectedField: rejectedValue,
          }),
          { stopReason: "toolUse" },
        ),
      ),
      fauxAssistantMessage("错误地越过工具预算后结束。"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-invalid-tool-budget-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      maxToolCalls: 3,
      maxRepeatedToolCalls: 10,
    });
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        service.run(principal, { workflow: "prompt", prompt: "读取租户上下文" }),
      ).rejects.toMatchObject({
        diagnosticReason: "tool_guard",
        providerFailureClass: null,
        toolCallCount: 3,
        lastToolName: "geo_tenant_context",
      });
      expect(faux.state.callCount).toBe(3);
      const diagnostics = warningLog.mock.calls.flat().join("\n");
      expect(diagnostics).toContain('"errorCategory":"argument_rejection"');
      expect(diagnostics).toContain('"argumentKeys":["tenantId","unexpectedField"]');
      expect(diagnostics).not.toContain(rejectedValue);
    } finally {
      warningLog.mockRestore();
    }
  });

  it("continues the same Pi transcript after a transient provider error", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-retry-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524 from upstream",
      }),
      fauxAssistantMessage("已从原会话继续完成。", {
        responseId: "provider-request-retry-success",
      }),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-retry-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      providerRetryDelaysMs: [0],
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "继续当前工作流" }),
    ).resolves.toMatchObject({
      providerMode: "pi",
      providerRunId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      providerRequestId: "provider-request-retry-success",
      response: "已从原会话继续完成。",
      messageCount: 2,
    });
    expect(faux.state.callCount).toBe(2);
  });

  it("preserves completed tool results when continuing after a provider error", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-tool-retry-test" });
    fauxRegistrations.push(faux);
    let continuationLastRole: string | undefined;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("geo_tenant_context", { tenantId: ids.tenant }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524 after tool result",
      }),
      (context) => {
        continuationLastRole = context.messages.at(-1)?.role;
        return fauxAssistantMessage("已复用租户上下文继续完成。");
      },
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-tool-retry-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      providerRetryDelaysMs: [0],
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "读取租户上下文后继续" }),
    ).resolves.toMatchObject({ response: "已复用租户上下文继续完成。" });
    expect(continuationLastRole).toBe("toolResult");
    expect(faux.state.callCount).toBe(3);
  });

  it("stops provider continuation retries immediately when the caller aborts", async () => {
    const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const faux = registerFauxProvider({ provider: "geo-pi-abort-retry-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524 before abort",
      }),
      fauxAssistantMessage("不应调用到这个响应"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-abort-retry-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
      providerRetryDelaysMs: [60_000],
    });
    const controller = new AbortController();

    const run = service.run(
      principal,
      { workflow: "prompt", prompt: "在重试等待期间中止" },
      controller.signal,
    );
    const rejected = expect(run).rejects.toThrow("Pi agent run was aborted");
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    controller.abort();

    await rejected;
    expect(faux.state.callCount).toBe(1);
    expect(
      infoLog.mock.calls.some(
        ([entry]) =>
          String(entry).includes('"event":"agent_mcp.session_destroyed"') &&
          String(entry).includes('"outcome":"cancelled"') &&
          String(entry).includes('"remainingMessageCount":0') &&
          String(entry).includes('"remainingPendingToolCallCount":0') &&
          String(entry).includes('"hasQueuedMessages":false'),
      ),
    ).toBe(true);
    infoLog.mockRestore();
  });
});
