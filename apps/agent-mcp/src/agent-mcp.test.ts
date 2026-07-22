import type { ActorContext } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import type { InternalGeoApiClient } from "./api-client.js";
import { GeoMcpToolError, invokeGeoMcpTool } from "./handlers.js";
import { GEO_MCP_TOOL_NAMES, geoMcpToolSchemas } from "./tool-specs.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const otherTenantId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const brandId = "00000000-0000-4000-8000-000000000004";
const variantId = "00000000-0000-4000-8000-000000000005";
const accountId = "00000000-0000-4000-8000-000000000006";

const principal: ActorContext = {
  actorId,
  tenantId,
  role: "owner",
  capabilities: [
    "tenant:read",
    "content:read",
    "content:write",
    "audit:run",
    "publish:request",
    "visibility:run",
  ],
  requestId: "mcp-test",
};

function mockApi(): InternalGeoApiClient {
  return {
    getTenantContext: vi.fn(async () => ({ tenantId, name: "Test tenant" })),
    getArticleTemplateCatalog: vi.fn(async () => ({
      version: "geo.article-templates.v1" as const,
      items: [],
    })),
    getBrandAgentProfile: vi.fn(async () => null),
    lookupFacts: vi.fn(async () => ({ facts: [] })),
    proposeDraft: vi.fn(async () => ({ contentVersionId: variantId })),
    previewVariant: vi.fn(async () => ({ variantId })),
    requestAudit: vi.fn(async () => ({ auditRunId: variantId })),
    requestPublication: vi.fn(async () => ({ publicationRequestId: variantId })),
    requestVisibilityRun: vi.fn(async () => ({ visibilityRunId: variantId })),
    requestMediaProduction: vi.fn(async () => ({ mediaJobId: variantId })),
    getMediaJobStatus: vi.fn(async () => ({ mediaJobId: variantId, state: "succeeded" })),
    requestMediaSearchImport: vi.fn(async () => ({ finalContentVersionId: variantId })),
    authorizeResourceScope: vi.fn(async () => true),
  };
}

describe("GEO MCP schemas", () => {
  it("publishes exactly twelve bounded application tools", () => {
    expect(GEO_MCP_TOOL_NAMES).toEqual([
      "geo_tenant_context",
      "geo_template_catalog",
      "geo_brand_profile",
      "geo_fact_lookup",
      "geo_draft_proposal",
      "geo_variant_preview",
      "geo_audit_request",
      "geo_publication_request",
      "geo_visibility_request",
      "geo_media_production_request",
      "geo_media_job_status",
      "geo_media_search_import",
    ]);
    expect(GEO_MCP_TOOL_NAMES.join(" ")).not.toMatch(
      /(?:^|_)(?:grant|connector|browser|http|file|shell)(?:_|$)/i,
    );
  });

  it("rejects malformed, extra, and arbitrary destination arguments", () => {
    expect(
      geoMcpToolSchemas.geo_fact_lookup.safeParse({ tenantId, brandId, query: "travel" }).success,
    ).toBe(true);
    expect(
      geoMcpToolSchemas.geo_draft_proposal.safeParse({
        tenantId,
        brandId,
        campaignId: variantId,
        brief: "比较旅行方案",
        targetPlatform: "ctrip_community",
        articleTemplateId: "comparison-matrix",
        idempotencyKey: "draft-1",
      }).success,
    ).toBe(true);
    expect(
      geoMcpToolSchemas.geo_draft_proposal.safeParse({
        tenantId,
        brandId,
        campaignId: variantId,
        brief: "原创出发前指南",
        articleTemplateId: "step-by-step-guide",
        idempotencyKey: "draft-authored-1",
        authoredDraft: {
          title: "出发前先核对这项材料",
          titleClaimIds: [brandId],
          summary: "按已核验资料整理检查顺序。",
          summaryClaimIds: [brandId],
          body: [{ text: "先核对材料，再联系旅行社确认。", claimIds: [brandId] }],
          mediaSearchPlan: [
            {
              query: "京都 金阁寺 Kinkakuji",
              role: "cover",
              rationale: "封面对应京都主题",
              claimIds: [brandId],
            },
            {
              query: "京都 伏见稻荷 Fushimi Inari",
              role: "inline",
              rationale: "正文景点段落",
              claimIds: [brandId],
            },
            {
              query: "京都 岚山 Arashiyama",
              role: "inline",
              rationale: "正文路线段落",
              claimIds: [brandId],
            },
            {
              query: "京都 锦市场 Nishiki Market",
              role: "inline",
              rationale: "正文餐饮段落",
              claimIds: [brandId],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      geoMcpToolSchemas.geo_draft_proposal.safeParse({
        tenantId,
        brandId,
        campaignId: variantId,
        brief: "原创出发前指南",
        idempotencyKey: "draft-authored-2",
        authoredDraft: {
          title: "无证据标题",
          titleClaimIds: [],
          summary: "无证据摘要",
          summaryClaimIds: [],
          body: [{ text: "无证据正文", claimIds: [] }],
        },
      }).success,
    ).toBe(false);
    expect(
      geoMcpToolSchemas.geo_draft_proposal.safeParse({
        tenantId,
        brandId,
        campaignId: variantId,
        brief: "比较旅行方案",
        articleTemplateId: "invented-template",
        idempotencyKey: "draft-2",
      }).success,
    ).toBe(false);
    expect(
      geoMcpToolSchemas.geo_fact_lookup.safeParse({
        tenantId,
        brandId,
        query: "travel",
        url: "https://attacker.invalid",
      }).success,
    ).toBe(false);
    expect(
      geoMcpToolSchemas.geo_media_production_request.safeParse({
        tenantId,
        contentVersionId: variantId,
        platform: "toutiao",
        role: "cover",
        claimIds: [brandId],
        idempotencyKey: "media-1",
        prompt: "arbitrary prompt",
        provider: "live",
        url: "https://attacker.invalid",
        storageKey: "attacker/key.png",
      }).success,
    ).toBe(false);
    expect(
      geoMcpToolSchemas.geo_visibility_request.safeParse({
        tenantId,
        querySetVersionId: variantId,
        provider: "doubao",
        sampleCount: 1000,
        idempotencyKey: "test",
      }).success,
    ).toBe(false);
  });
});

describe("authenticated internal API mapping", () => {
  it("reads the governed template catalog without resource IDs", async () => {
    const api = mockApi();
    await invokeGeoMcpTool({
      toolName: "geo_template_catalog",
      args: { tenantId },
      principal,
      api,
      authorizeScope: () => true,
    });

    expect(api.getArticleTemplateCatalog).toHaveBeenCalledWith(principal);
  });

  it("reads the active Brand Agent Profile through an exact brand scope", async () => {
    const api = mockApi();
    vi.mocked(api.getBrandAgentProfile).mockResolvedValue({
      id: variantId,
      brandId,
      version: 2,
      status: "active",
      document: {
        schemaVersion: "geo.brand-agent-profile.v1",
        voice: "清晰克制",
        audiences: ["首次出境游客"],
        objectives: ["核验服务边界"],
        requiredPoints: [],
        forbiddenClaims: ["保证签证通过"],
        callToAction: "联系官方热线核验。",
        agentInstructions: "只选择证据充分的策略。",
      },
      documentHash: "a".repeat(64),
      effectiveAt: "2026-07-15T12:00:00.000Z",
      retiredAt: null,
      createdAt: "2026-07-15T12:00:00.000Z",
    });

    await expect(
      invokeGeoMcpTool({
        toolName: "geo_brand_profile",
        args: { tenantId, brandId },
        principal,
        api,
        authorizeScope: () => true,
      }),
    ).resolves.toMatchObject({ configured: true, profile: { brandId, version: 2 } });
    expect(api.getBrandAgentProfile).toHaveBeenCalledWith(principal, brandId);
  });

  it("rejects tenant mismatch before scope checks or API access", async () => {
    const api = mockApi();
    let scopeChecks = 0;
    await expect(
      invokeGeoMcpTool({
        toolName: "geo_fact_lookup",
        args: { tenantId: otherTenantId, brandId, query: "travel" },
        principal,
        api,
        authorizeScope: () => {
          scopeChecks += 1;
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
    expect(scopeChecks).toBe(0);
    expect(api.lookupFacts).not.toHaveBeenCalled();
  });

  it("uses tenant from principal, strips the consistency parameter, and redacts output", async () => {
    const api = mockApi();
    vi.mocked(api.lookupFacts).mockResolvedValue({
      facts: [{ text: "safe", apiToken: "secret-value" }],
      note: "Bearer abc.def.ghi",
    });
    const result = await invokeGeoMcpTool({
      toolName: "geo_fact_lookup",
      args: { tenantId, brandId, query: "travel", limit: 3 },
      principal,
      api,
      authorizeScope: () => true,
    });

    expect(api.lookupFacts).toHaveBeenCalledWith(principal, {
      brandId,
      query: "travel",
      limit: 3,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abc.def.ghi");
  });

  it("maps publication to requestPublication only and never issues a grant", async () => {
    const api = mockApi();
    await invokeGeoMcpTool({
      toolName: "geo_publication_request",
      args: {
        tenantId,
        variantId,
        channelAccountId: accountId,
        executionLevel: "dry_run",
        idempotencyKey: "publication-1",
      },
      principal,
      api,
      authorizeScope: () => true,
    });
    expect(api.requestPublication).toHaveBeenCalledWith(principal, {
      variantId,
      channelAccountId: accountId,
      executionLevel: "dry_run",
      idempotencyKey: "publication-1",
    });
    expect(Object.keys(api).join(" ")).not.toMatch(/grant|connector|browser/i);
  });

  it("passes a catalog-bound article template into the draft proposal", async () => {
    const api = mockApi();
    await invokeGeoMcpTool({
      toolName: "geo_draft_proposal",
      args: {
        tenantId,
        brandId,
        campaignId: variantId,
        brief: "比较旅行方案",
        targetPlatform: "ctrip_community",
        articleTemplateId: "comparison-matrix",
        idempotencyKey: "draft-1",
      },
      principal,
      api,
      authorizeScope: () => true,
    });

    expect(api.proposeDraft).toHaveBeenCalledWith(principal, {
      brandId,
      campaignId: variantId,
      brief: "比较旅行方案",
      targetPlatform: "ctrip_community",
      articleTemplateId: "comparison-matrix",
      idempotencyKey: "draft-1",
    });
  });

  it("maps media production and read-only status to exactly two API methods", async () => {
    const api = mockApi();
    await invokeGeoMcpTool({
      toolName: "geo_media_production_request",
      args: {
        tenantId,
        contentVersionId: variantId,
        platform: "toutiao",
        role: "cover",
        claimIds: [brandId],
        idempotencyKey: "media-1",
      },
      principal,
      api,
      authorizeScope: () => true,
    });
    await invokeGeoMcpTool({
      toolName: "geo_media_job_status",
      args: { tenantId, mediaJobId: variantId },
      principal,
      api,
      authorizeScope: () => true,
    });
    expect(api.requestMediaProduction).toHaveBeenCalledWith(principal, {
      contentVersionId: variantId,
      platform: "toutiao",
      role: "cover",
      claimIds: [brandId],
      idempotencyKey: "media-1",
    });
    expect(api.getMediaJobStatus).toHaveBeenCalledWith(principal, { mediaJobId: variantId });
  });

  it("maps licensed image search to the tenant-scoped content version only", async () => {
    const api = mockApi();
    await invokeGeoMcpTool({
      toolName: "geo_media_search_import",
      args: {
        tenantId,
        contentVersionId: variantId,
        idempotencyKey: "media-search-1",
      },
      principal,
      api,
      authorizeScope: () => true,
    });
    expect(api.requestMediaSearchImport).toHaveBeenCalledWith(principal, {
      contentVersionId: variantId,
      idempotencyKey: "media-search-1",
    });
  });

  it("denies arbitrary tools before API access", async () => {
    const api = mockApi();
    await expect(
      invokeGeoMcpTool({
        toolName: "shell",
        args: { tenantId, command: "whoami" },
        principal,
        api,
        authorizeScope: () => true,
      }),
    ).rejects.toBeInstanceOf(GeoMcpToolError);
    for (const method of Object.values(api)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
