import { z } from "zod";

import {
  articleTemplateById,
  automationPlatformSchema,
  mediaSearchPlanSchema,
} from "@geo/contracts";

const tenantId = z.string().uuid();
const resourceId = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(200);
const articleTemplateId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/u)
  .refine((value) => articleTemplateById(value) !== null);
const authoredClaimIds = z
  .array(resourceId)
  .max(20)
  .refine((values) => new Set(values).size === values.length);
const authoredSection = z
  .object({
    text: z.string().trim().min(1).max(8_000),
    claimIds: authoredClaimIds,
  })
  .strict();
const authoredDraft = z
  .object({
    title: z.string().trim().min(1).max(2_000),
    titleClaimIds: authoredClaimIds,
    summary: z.string().trim().min(1).max(2_000),
    summaryClaimIds: authoredClaimIds,
    locationQuery: z.string().trim().min(1).max(100).optional(),
    body: z.array(authoredSection).min(1).max(50),
    mediaSearchPlan: mediaSearchPlanSchema.optional(),
  })
  .strict();
const draftProposalBase = {
  tenantId,
  brandId: resourceId,
  campaignId: resourceId,
  brief: z.string().trim().min(1).max(10_000),
  targetPlatform: automationPlatformSchema.optional(),
  articleTemplateId: articleTemplateId.optional(),
  idempotencyKey,
} as const;

export const geoDraftProposalAuthoredSchema = z
  .object({ ...draftProposalBase, authoredDraft })
  .strict();
const geoDraftProposalFixtureSchema = z
  .object({ ...draftProposalBase, fixtureMode: z.literal(true) })
  .strict();

export const geoMcpToolSchemas = {
  geo_tenant_context: z.object({ tenantId }).strict(),
  geo_template_catalog: z.object({ tenantId }).strict(),
  geo_brand_profile: z.object({ tenantId, brandId: resourceId }).strict(),
  geo_fact_lookup: z
    .object({
      tenantId,
      brandId: resourceId,
      query: z.string().trim().min(1).max(2_000),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  geo_draft_proposal: z.union([geoDraftProposalFixtureSchema, geoDraftProposalAuthoredSchema]),
  geo_variant_preview: z
    .object({
      tenantId,
      contentVersionId: resourceId,
      channelAccountId: resourceId,
      platform: automationPlatformSchema,
    })
    .strict(),
  geo_audit_request: z.object({ tenantId, variantId: resourceId, idempotencyKey }).strict(),
  geo_publication_request: z
    .object({
      tenantId,
      variantId: resourceId,
      channelAccountId: resourceId,
      platform: automationPlatformSchema.optional(),
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
  geo_media_production_request: z
    .object({
      tenantId,
      contentVersionId: resourceId,
      platform: automationPlatformSchema,
      role: z.enum(["cover", "inline"]),
      claimIds: z
        .array(resourceId)
        .max(3)
        .refine((values) => new Set(values).size === values.length),
      idempotencyKey,
    })
    .strict(),
  geo_media_job_status: z.object({ tenantId, mediaJobId: resourceId }).strict(),
  geo_media_search_import: z
    .object({
      tenantId,
      contentVersionId: resourceId,
      platform: automationPlatformSchema,
      idempotencyKey,
      maxImports: z.number().int().min(1).max(5).optional(),
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
    description:
      "Discover authenticated tenant, brand, Campaign, policy, contact, account, and capability context.",
    readOnly: true,
  },
  geo_template_catalog: {
    title: "Article template catalog",
    description: "Read the governed V1 article strategy catalog.",
    readOnly: true,
  },
  geo_brand_profile: {
    title: "Brand Agent Profile",
    description: "Read the active versioned Agent instructions for a tenant-scoped brand.",
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
  geo_media_production_request: {
    title: "Media production request",
    description: "Request governed deterministic fixture media production for a content version.",
    readOnly: false,
  },
  geo_media_job_status: {
    title: "Media job status",
    description: "Read tenant-scoped media production job status and immutable asset metadata.",
    readOnly: true,
  },
  geo_media_search_import: {
    title: "Licensed image search import",
    description:
      "Search licensed images from the immutable article plan, inspect candidates, and attach accepted images to successor content versions.",
    readOnly: false,
  },
};
