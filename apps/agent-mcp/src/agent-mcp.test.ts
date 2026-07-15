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
    lookupFacts: vi.fn(async () => ({ facts: [] })),
    proposeDraft: vi.fn(async () => ({ contentVersionId: variantId })),
    previewVariant: vi.fn(async () => ({ variantId })),
    requestAudit: vi.fn(async () => ({ auditRunId: variantId })),
    requestPublication: vi.fn(async () => ({ publicationRequestId: variantId })),
    requestVisibilityRun: vi.fn(async () => ({ visibilityRunId: variantId })),
    requestMediaProduction: vi.fn(async () => ({ mediaJobId: variantId })),
    getMediaJobStatus: vi.fn(async () => ({ mediaJobId: variantId, state: "succeeded" })),
    authorizeResourceScope: vi.fn(async () => true),
  };
}

describe("GEO MCP schemas", () => {
  it("publishes exactly nine bounded application tools", () => {
    expect(GEO_MCP_TOOL_NAMES).toEqual([
      "geo_tenant_context",
      "geo_fact_lookup",
      "geo_draft_proposal",
      "geo_variant_preview",
      "geo_audit_request",
      "geo_publication_request",
      "geo_visibility_request",
      "geo_media_production_request",
      "geo_media_job_status",
    ]);
    expect(GEO_MCP_TOOL_NAMES.join(" ")).not.toMatch(/grant|connector|browser|http|file|shell/i);
  });

  it("rejects malformed, extra, and arbitrary destination arguments", () => {
    expect(
      geoMcpToolSchemas.geo_fact_lookup.safeParse({ tenantId, brandId, query: "travel" }).success,
    ).toBe(true);
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
