import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "typebox";

import { AGENT_TOOL_POLICIES, type AgentToolName } from "./policy.js";
import { publicErrorMessage, redactSensitiveDetails } from "./redaction.js";
import type { GovernedAgentRuntime } from "./runtime.js";

const tenantId = Type.String({ format: "uuid", description: "Authenticated tenant ID" });
const resourceId = Type.String({ format: "uuid" });
const idempotencyKey = Type.String({ minLength: 1, maxLength: 200 });

const schemas = {
  geo_tenant_context: Type.Object({ tenantId }, { additionalProperties: false }),
  geo_fact_lookup: Type.Object(
    {
      tenantId,
      brandId: resourceId,
      query: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    { additionalProperties: false },
  ),
  geo_draft_proposal: Type.Object(
    {
      tenantId,
      brandId: resourceId,
      campaignId: resourceId,
      brief: Type.String({ minLength: 1, maxLength: 10_000 }),
      fixtureDraft: Type.Optional(
        Type.Object(
          {
            title: Type.String({ minLength: 1, maxLength: 200 }),
            summary: Type.String({ minLength: 1, maxLength: 500 }),
            bodyMarkdown: Type.String({ minLength: 1, maxLength: 100_000 }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  geo_variant_preview: Type.Object(
    {
      tenantId,
      contentVersionId: resourceId,
      channelAccountId: resourceId,
      platform: Type.Union([
        Type.Literal("toutiao"),
        Type.Literal("sohu"),
        Type.Literal("ctrip_community"),
      ]),
    },
    { additionalProperties: false },
  ),
  geo_audit_request: Type.Object(
    { tenantId, variantId: resourceId, idempotencyKey },
    { additionalProperties: false },
  ),
  geo_publication_request: Type.Object(
    {
      tenantId,
      variantId: resourceId,
      channelAccountId: resourceId,
      executionLevel: Type.Union([
        Type.Literal("dry_run"),
        Type.Literal("assisted"),
        Type.Literal("unattended"),
      ]),
      idempotencyKey,
    },
    { additionalProperties: false },
  ),
  geo_visibility_request: Type.Object(
    {
      tenantId,
      querySetVersionId: resourceId,
      provider: Type.Union([Type.Literal("doubao"), Type.Literal("qwen")]),
      sampleCount: Type.Integer({ minimum: 1, maximum: 20 }),
      idempotencyKey,
    },
    { additionalProperties: false },
  ),
  plastic_context_supply: Type.Object(
    {
      tenantId,
      taskDescription: Type.String({ minLength: 1, maxLength: 10_000 }),
      taskType: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
  plastic_audit_pre_check: Type.Object(
    {
      tenantId,
      action: Type.String({ minLength: 1, maxLength: 200 }),
      context: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  plastic_defense: Type.Object(
    {
      tenantId,
      targetToolName: Type.String({ minLength: 1, maxLength: 200 }),
      targetToolArgs: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
} as const satisfies Readonly<Record<AgentToolName, TSchema>>;

const descriptions: Readonly<Record<AgentToolName, { label: string; description: string }>> = {
  geo_tenant_context: {
    label: "Tenant context",
    description: "Read the authenticated tenant's non-secret operating context.",
  },
  geo_fact_lookup: {
    label: "Fact lookup",
    description: "Look up tenant-scoped facts and evidence for drafting.",
  },
  geo_draft_proposal: {
    label: "Draft proposal",
    description: "Submit a content draft proposal to the authenticated application API.",
  },
  geo_variant_preview: {
    label: "Variant preview",
    description: "Create an immutable platform variant preview without publishing it.",
  },
  geo_audit_request: {
    label: "Audit request",
    description: "Request deterministic audit of an exact platform variant.",
  },
  geo_publication_request: {
    label: "Publication request",
    description: "Request publication authorization and queueing; this never issues a grant.",
  },
  geo_visibility_request: {
    label: "Visibility request",
    description: "Request a tenant-scoped Doubao or Qwen visibility run.",
  },
  plastic_context_supply: {
    label: "Governance context",
    description: "Request task context from the Plastic Promise governance service.",
  },
  plastic_audit_pre_check: {
    label: "Governance pre-check",
    description: "Request a Plastic Promise pre-action policy check.",
  },
  plastic_defense: {
    label: "Governance defense",
    description: "Evaluate a proposed allowlisted tool through Plastic Promise defense.",
  },
};

export function createPiAgentTools(runtime: GovernedAgentRuntime): AgentTool[] {
  return (Object.keys(schemas) as AgentToolName[]).map((name) => {
    const metadata = descriptions[name];
    return {
      name,
      label: metadata.label,
      description: metadata.description,
      parameters: schemas[name],
      executionMode: AGENT_TOOL_POLICIES[name].sequential ? "sequential" : "parallel",
      execute: async (_toolCallId, params, signal) => {
        if (signal?.aborted) {
          throw new Error("Tool call cancelled");
        }
        try {
          const details = await runtime.invoke(name, params);
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
          };
        } catch (error) {
          throw new Error(publicErrorMessage(error), {
            // The original error may contain credentials, so it must not survive in agent history.
            // eslint-disable-next-line preserve-caught-error
            cause: redactSensitiveDetails(error),
          });
        }
      },
    } satisfies AgentTool;
  });
}

export const PI_TOOL_SCHEMAS: Readonly<Record<AgentToolName, TSchema>> = schemas;
