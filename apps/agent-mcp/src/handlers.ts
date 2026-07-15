import type { ActorContext, Capability } from "@geo/contracts";

import type { InternalGeoApiClient } from "./api-client.js";
import { GEO_MCP_TOOL_NAMES, geoMcpToolSchemas, type GeoMcpToolName } from "./tool-specs.js";

const REQUIRED_CAPABILITY = {
  geo_tenant_context: "tenant:read",
  geo_fact_lookup: "content:read",
  geo_draft_proposal: "content:write",
  geo_variant_preview: "content:write",
  geo_audit_request: "audit:run",
  geo_publication_request: "publish:request",
  geo_visibility_request: "visibility:run",
  geo_media_production_request: "content:write",
  geo_media_job_status: "content:read",
} as const satisfies Readonly<Record<GeoMcpToolName, Capability>>;

const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|session)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 8_000).replace(BEARER, "Bearer [REDACTED]");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redact(entry, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1),
        ]),
    );
  }
  return String(value);
}

export class GeoMcpToolError extends Error {
  readonly code:
    | "TOOL_NOT_ALLOWED"
    | "INVALID_ARGUMENTS"
    | "TENANT_SCOPE_MISMATCH"
    | "CAPABILITY_MISSING"
    | "RESOURCE_SCOPE_DENIED";

  constructor(code: GeoMcpToolError["code"], message: string) {
    super(message);
    this.name = "GeoMcpToolError";
    this.code = code;
  }
}

export type InternalScopeAuthorizer = (
  principal: Readonly<ActorContext>,
  toolName: GeoMcpToolName,
  args: Readonly<Record<string, unknown>>,
) => boolean | Promise<boolean>;

function isToolName(value: string): value is GeoMcpToolName {
  return (GEO_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

function parseArgs(toolName: GeoMcpToolName, args: unknown): Record<string, unknown> {
  const parsed = geoMcpToolSchemas[toolName].safeParse(args);
  if (!parsed.success) {
    throw new GeoMcpToolError("INVALID_ARGUMENTS", "Tool arguments failed schema validation");
  }
  return parsed.data as Record<string, unknown>;
}

export async function invokeGeoMcpTool(options: {
  toolName: string;
  args: unknown;
  principal: Readonly<ActorContext>;
  api: InternalGeoApiClient;
  authorizeScope: InternalScopeAuthorizer;
}): Promise<unknown> {
  if (!isToolName(options.toolName)) {
    throw new GeoMcpToolError("TOOL_NOT_ALLOWED", "Tool is outside the static MCP allowlist");
  }
  const args = parseArgs(options.toolName, options.args);
  if (args.tenantId !== options.principal.tenantId) {
    throw new GeoMcpToolError(
      "TENANT_SCOPE_MISMATCH",
      "Tool tenant does not match the authenticated tenant",
    );
  }
  const capability = REQUIRED_CAPABILITY[options.toolName];
  if (!options.principal.capabilities.includes(capability)) {
    throw new GeoMcpToolError("CAPABILITY_MISSING", `Missing capability: ${capability}`);
  }
  if (!(await options.authorizeScope(options.principal, options.toolName, args))) {
    throw new GeoMcpToolError("RESOURCE_SCOPE_DENIED", "Resource is outside principal scope");
  }

  const input = { ...args };
  delete input.tenantId;
  let result: unknown;
  switch (options.toolName) {
    case "geo_tenant_context":
      result = await options.api.getTenantContext(options.principal);
      break;
    case "geo_fact_lookup":
      result = await options.api.lookupFacts(options.principal, {
        brandId: String(input.brandId),
        query: String(input.query),
        limit: Number(input.limit),
      });
      break;
    case "geo_draft_proposal":
      result = await options.api.proposeDraft(options.principal, {
        brandId: String(input.brandId),
        campaignId: String(input.campaignId),
        brief: String(input.brief),
        idempotencyKey: String(input.idempotencyKey),
        ...(input.fixtureMode === undefined ? {} : { fixtureMode: input.fixtureMode === true }),
      });
      break;
    case "geo_variant_preview":
      result = await options.api.previewVariant(options.principal, {
        contentVersionId: String(input.contentVersionId),
        channelAccountId: String(input.channelAccountId),
        platform: input.platform as "toutiao" | "sohu" | "ctrip_community",
      });
      break;
    case "geo_audit_request":
      result = await options.api.requestAudit(options.principal, {
        variantId: String(input.variantId),
        idempotencyKey: String(input.idempotencyKey),
      });
      break;
    case "geo_publication_request":
      result = await options.api.requestPublication(options.principal, {
        variantId: String(input.variantId),
        channelAccountId: String(input.channelAccountId),
        executionLevel: input.executionLevel as "dry_run" | "assisted" | "unattended",
        idempotencyKey: String(input.idempotencyKey),
      });
      break;
    case "geo_visibility_request":
      result = await options.api.requestVisibilityRun(options.principal, {
        querySetVersionId: String(input.querySetVersionId),
        provider: input.provider as "doubao" | "qwen",
        sampleCount: Number(input.sampleCount),
        idempotencyKey: String(input.idempotencyKey),
      });
      break;
    case "geo_media_production_request":
      result = await options.api.requestMediaProduction(options.principal, {
        contentVersionId: String(input.contentVersionId),
        platform: input.platform as "toutiao" | "sohu" | "ctrip_community",
        role: input.role as "cover" | "inline",
        claimIds: (input.claimIds as string[]).map(String),
        idempotencyKey: String(input.idempotencyKey),
      });
      break;
    case "geo_media_job_status":
      result = await options.api.getMediaJobStatus(options.principal, {
        mediaJobId: String(input.mediaJobId),
      });
      break;
  }
  return redact(result);
}

export function publicMcpError(error: unknown): string {
  return error instanceof GeoMcpToolError
    ? "Request denied or invalid for the authenticated tenant"
    : "Internal application request failed";
}
