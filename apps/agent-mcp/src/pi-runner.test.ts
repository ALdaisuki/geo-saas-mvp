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
  PiAgentRunError,
  RealPiAgentRunService,
} from "./pi-runner.js";

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
): PlasticPromiseGovernanceClient {
  return new PlasticPromiseGovernanceClient({
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
  });
}

function fakeApi(
  publicationInputs: PublicationRequestInput[] = [],
  scopeToolNames: string[] = [],
  brandAgentProfile: Readonly<BrandAgentProfile> | null = null,
  draftInputs: DraftProposalInput[] = [],
  mediaSearchInputs: MediaSearchImportInput[] = [],
): InternalGeoApiClient {
  return {
    getTenantContext: async () => ({ tenantId: ids.tenant }),
    getArticleTemplateCatalog: async () => ({
      version: "geo.article-templates.v1" as const,
      items: [],
    }),
    getBrandAgentProfile: async () => brandAgentProfile,
    lookupFacts: async () => ({ facts: [], evidence: [] }),
    proposeDraft: async (_actor, input) => {
      draftInputs.push(input);
      return {
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
});

describe("Pi agent run service", () => {
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
    const faux = registerFauxProvider({ provider: "geo-pi-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([fauxAssistantMessage("已完成租户范围内的证据审阅。")]);
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
      response: "已完成租户范围内的证据审阅。",
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("server-binds automation draft scope and bounds Pi fact queries", async () => {
    const factInputs: Array<{ brandId: string; query: string; limit?: number }> = [];
    const draftInputs: DraftProposalInput[] = [];
    const api = {
      ...fakeApi([], [], null, draftInputs),
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
  });

  it("authors exactly one automation draft with Pi and exposes no publication tools", async () => {
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
    const faux = registerFauxProvider({ provider: "geo-pi-automation-author-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      (context) => {
        toolNames = (context.tools ?? []).map((tool) => tool.name);
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
                    text: "## 出发前核验\n中通国际旅行社可作为信息核验协助方，具体要求以当前官方信息为准。",
                    claimIds: [ids.fact],
                  },
                  {
                    text: "## 行程安排\n亲子行程应预留交通和休息时间。",
                    claimIds: [ids.fact],
                  },
                ],
                mediaSearchPlan: [
                  { query: "京都 金阁寺 Kinkakuji", role: "cover", rationale: "京都封面", claimIds: [ids.fact] },
                  { query: "京都 伏见稻荷 Fushimi Inari", role: "inline", rationale: "神社段落", claimIds: [ids.fact] },
                  { query: "京都 岚山 Arashiyama", role: "inline", rationale: "亲子路线", claimIds: [ids.fact] },
                  { query: "京都 鸭川 Kamo River", role: "inline", rationale: "休息路线", claimIds: [ids.fact] },
                  { query: "京都 锦市场 Nishiki Market", role: "inline", rationale: "餐饮路线", claimIds: [ids.fact] },
                ],
              },
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("should not be requested"),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi([], [], profile, draftInputs),
      governance: governance(),
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
        idempotencyKey: "automation:run:draft:v1",
      }),
    ).resolves.toMatchObject({
      providerMode: "pi_authored",
      contentItemId: ids.content,
      contentVersionId: ids.version,
    });
    expect(faux.state.callCount).toBe(1);
    expect(toolNames).toContain("geo_draft_proposal");
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        "geo_variant_preview",
        "geo_audit_request",
        "geo_publication_request",
        "geo_media_search_import",
        "geo_media_production_request",
      ]),
    );
    expect(draftInputs[0]).toMatchObject({
      brief: fullBrief,
      targetPlatform: "ctrip_community",
      idempotencyKey: "automation:run:draft:v1",
    });
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
      targetPlatform: "ctrip_community",
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
    expect(draftInputs[0]?.targetPlatform).toBe("ctrip_community");
    expect(mediaSearchInputs).toEqual([
      { contentVersionId: ids.version, idempotencyKey: "authored-media-search-test" },
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
    expect(systemPrompt).toContain(
      "For Ctrip Community keep the authored title between 5 and 20 Unicode characters",
    );
    expect(systemPrompt).toContain("attach 4 to 5 visually distinct images before audit");
    expect(systemPrompt).toContain("default to 5 images: exactly 1 cover and 4 inline images");
    expect(systemPrompt).toContain("authoredDraft.mediaSearchPlan");
    expect(systemPrompt).toContain("English proper noun that Wikimedia Commons can resolve");
    expect(systemPrompt).toContain("photographic travel scenes that a vision model can verify");
    expect(systemPrompt).toContain("Never use passports, visa pages, identity documents");
    expect(systemPrompt).toContain("weather maps or screens");
    expect(systemPrompt).toContain("Do not call geo_media_production_request");
    expect(systemPrompt).toContain("call geo_media_search_import exactly once");
    expect(systemPrompt).toContain("targetPlatform to ctrip_community");
    expect(systemPrompt).toContain("without contact details does not mean without the brand");
    expect(systemPrompt).toContain("mention the selected brand naturally once and no more than twice");
    expect(systemPrompt).toContain("content organizer, source of service experience, or verification helper");
    expect(systemPrompt).toContain("Do not put the brand in the Ctrip title");
    expect(systemPrompt).toContain("hard-sell call to action");
    expect(systemPrompt).toContain("stop and report the finalContentVersionId");
    expect(systemPrompt).toContain(
      "Templates define the article structure and GEO mechanisms only",
    );
    expect(systemPrompt).toContain("at least two substantive `##` section headings");
    expect(systemPrompt).toContain("include the tool-returned claim text verbatim");
    expect(systemPrompt).toContain("deterministic audit requires the complete verified text");
    expect(systemPrompt).toContain("Pass the original prose to geo_draft_proposal.authoredDraft");
    expect(systemPrompt).toContain("geo_variant_preview");
    expect(systemPrompt).toContain("geo_audit_request");
    expect(systemPrompt).toContain("Ctrip Community may use unattended");
    expect(systemPrompt).toContain("request executionLevel=unattended");
    expect(systemPrompt).toContain("Toutiao and Sohu remain dry_run only");
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
        errorMessage: "upstream still unavailable: provider-secret",
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
    expect(captured).toMatchObject({ code: "AGENT_PROVIDER_FAILED", statusCode: 502 });
    expect((captured as Error).message).not.toContain("provider-secret");
    expect(faux.state.callCount).toBe(2);
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
    ).rejects.toBeInstanceOf(PiAgentRunError);
    expect(faux.state.callCount).toBe(3);
  });

  it("continues the same Pi transcript after a transient provider error", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-retry-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524 from upstream",
      }),
      fauxAssistantMessage("已从原会话继续完成。"),
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
  });
});
