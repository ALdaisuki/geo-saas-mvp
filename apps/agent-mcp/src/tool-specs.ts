import { z } from "zod";

const tenantId = z.string().uuid();
const resourceId = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(200);

export const geoMcpToolSchemas = {
  geo_tenant_context: z.object({ tenantId }).strict(),
  geo_fact_lookup: z
    .object({
      tenantId,
      brandId: resourceId,
      query: z.string().trim().min(1).max(2_000),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  geo_draft_proposal: z
    .object({
      tenantId,
      brandId: resourceId,
      campaignId: resourceId,
      brief: z.string().trim().min(1).max(10_000),
      idempotencyKey,
      fixtureMode: z.boolean().optional(),
    })
    .strict(),
  geo_variant_preview: z
    .object({
      tenantId,
      contentVersionId: resourceId,
      channelAccountId: resourceId,
      platform: z.enum(["toutiao", "sohu", "ctrip_community"]),
    })
    .strict(),
  geo_audit_request: z.object({ tenantId, variantId: resourceId, idempotencyKey }).strict(),
  geo_publication_request: z
    .object({
      tenantId,
      variantId: resourceId,
      channelAccountId: resourceId,
      executionLevel: z.enum(["dry_run", "assisted", "unattended"]),
      idempotencyKey,
    })
    .strict(),
  geo_visibility_request: z
    .object({
      tenantId,
      querySetVersionId: resourceId,
      provider: z.enum(["doubao", "qwen"]),
      sampleCount: z.number().int().min(1).max(20),
      idempotencyKey,
    })
    .strict(),
} as const;

export type GeoMcpToolName = keyof typeof geoMcpToolSchemas;

export const GEO_MCP_TOOL_NAMES = Object.freeze(Object.keys(geoMcpToolSchemas) as GeoMcpToolName[]);

export const geoMcpToolMetadata: Readonly<
  Record<
    GeoMcpToolName,
    {
      title: string;
      description: string;
      readOnly: boolean;
    }
  >
> = {
  geo_tenant_context: {
    title: "Tenant context",
    description: "Read authenticated tenant context.",
    readOnly: true,
  },
  geo_fact_lookup: {
    title: "Fact lookup",
    description: "Read tenant-scoped facts and evidence.",
    readOnly: true,
  },
  geo_draft_proposal: {
    title: "Draft proposal",
    description: "Submit a draft proposal through the authenticated internal API.",
    readOnly: false,
  },
  geo_variant_preview: {
    title: "Variant preview",
    description: "Create an immutable platform variant preview.",
    readOnly: false,
  },
  geo_audit_request: {
    title: "Audit request",
    description: "Request deterministic audit of an exact variant.",
    readOnly: false,
  },
  geo_publication_request: {
    title: "Publication request",
    description: "Request publication processing without issuing a grant.",
    readOnly: false,
  },
  geo_visibility_request: {
    title: "Visibility request",
    description: "Request a Doubao or Qwen visibility run.",
    readOnly: false,
  },
};
