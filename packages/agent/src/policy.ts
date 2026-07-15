import type { ActorContext, Capability } from "@geo/contracts";
import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

export const GEO_AGENT_TOOL_NAMES = [
  "geo_tenant_context",
  "geo_fact_lookup",
  "geo_draft_proposal",
  "geo_variant_preview",
  "geo_audit_request",
  "geo_publication_request",
  "geo_visibility_request",
  "geo_media_production_request",
  "geo_media_job_status",
] as const;

export const PLASTIC_PROMISE_TOOL_NAMES = [
  "plastic_context_supply",
  "plastic_audit_pre_check",
  "plastic_defense",
] as const;

export const AGENT_TOOL_ALLOWLIST = [
  ...GEO_AGENT_TOOL_NAMES,
  ...PLASTIC_PROMISE_TOOL_NAMES,
] as const;

export type GeoAgentToolName = (typeof GEO_AGENT_TOOL_NAMES)[number];
export type PlasticPromiseAgentToolName = (typeof PLASTIC_PROMISE_TOOL_NAMES)[number];
export type AgentToolName = (typeof AGENT_TOOL_ALLOWLIST)[number];

export interface AgentToolPolicy {
  readonly requiredCapability: Capability;
  readonly stateChanging: boolean;
  readonly sequential: boolean;
}

export const AGENT_TOOL_POLICIES = {
  geo_tenant_context: {
    requiredCapability: "tenant:read",
    stateChanging: false,
    sequential: false,
  },
  geo_fact_lookup: {
    requiredCapability: "content:read",
    stateChanging: false,
    sequential: false,
  },
  geo_draft_proposal: {
    requiredCapability: "content:write",
    stateChanging: true,
    sequential: true,
  },
  geo_variant_preview: {
    requiredCapability: "content:write",
    stateChanging: true,
    sequential: true,
  },
  geo_audit_request: {
    requiredCapability: "audit:run",
    stateChanging: true,
    sequential: true,
  },
  geo_publication_request: {
    requiredCapability: "publish:request",
    stateChanging: true,
    sequential: true,
  },
  geo_visibility_request: {
    requiredCapability: "visibility:run",
    stateChanging: true,
    sequential: true,
  },
  geo_media_production_request: {
    requiredCapability: "content:write",
    stateChanging: true,
    sequential: true,
  },
  geo_media_job_status: {
    requiredCapability: "content:read",
    stateChanging: false,
    sequential: false,
  },
  plastic_context_supply: {
    requiredCapability: "tenant:read",
    stateChanging: false,
    sequential: true,
  },
  plastic_audit_pre_check: {
    requiredCapability: "audit:run",
    stateChanging: false,
    sequential: true,
  },
  plastic_defense: {
    requiredCapability: "tenant:read",
    stateChanging: false,
    sequential: true,
  },
} as const satisfies Readonly<Record<AgentToolName, AgentToolPolicy>>;

export class AgentPolicyError extends Error {
  readonly code:
    | "TOOL_NOT_ALLOWLISTED"
    | "PRINCIPAL_INVALID"
    | "TENANT_SCOPE_MISMATCH"
    | "CAPABILITY_MISSING"
    | "RESOURCE_SCOPE_DENIED";

  constructor(code: AgentPolicyError["code"], message: string) {
    super(message);
    this.name = "AgentPolicyError";
    this.code = code;
  }
}

export type ResourceScopeAuthorizer = (
  principal: Readonly<ActorContext>,
  toolName: AgentToolName,
  args: Readonly<Record<string, unknown>>,
) => boolean | Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_ALLOWLIST as readonly string[]).includes(value);
}

export function isPlasticPromiseAgentToolName(value: string): value is PlasticPromiseAgentToolName {
  return (PLASTIC_PROMISE_TOOL_NAMES as readonly string[]).includes(value);
}

function assertPrincipal(principal: Readonly<ActorContext>): void {
  if (
    principal.actorId.trim().length === 0 ||
    principal.tenantId.trim().length === 0 ||
    principal.requestId.trim().length === 0 ||
    !Array.isArray(principal.capabilities)
  ) {
    throw new AgentPolicyError("PRINCIPAL_INVALID", "Authenticated principal is incomplete");
  }
}

export async function authorizeAgentToolCall(input: {
  principal: Readonly<ActorContext>;
  toolName: string;
  args: unknown;
  authorizeResourceScope: ResourceScopeAuthorizer;
}): Promise<{ toolName: AgentToolName; args: Readonly<Record<string, unknown>> }> {
  assertPrincipal(input.principal);
  if (!isAgentToolName(input.toolName)) {
    throw new AgentPolicyError("TOOL_NOT_ALLOWLISTED", "Tool is not in the static agent allowlist");
  }
  if (!isRecord(input.args)) {
    throw new AgentPolicyError("RESOURCE_SCOPE_DENIED", "Tool arguments must be an object");
  }

  const tenantId = input.args.tenantId;
  if (tenantId !== input.principal.tenantId) {
    throw new AgentPolicyError(
      "TENANT_SCOPE_MISMATCH",
      "Tool tenant does not match the authenticated tenant",
    );
  }

  const policy = AGENT_TOOL_POLICIES[input.toolName];
  if (!input.principal.capabilities.includes(policy.requiredCapability)) {
    throw new AgentPolicyError(
      "CAPABILITY_MISSING",
      `Missing required capability: ${policy.requiredCapability}`,
    );
  }

  if (!(await input.authorizeResourceScope(input.principal, input.toolName, input.args))) {
    throw new AgentPolicyError("RESOURCE_SCOPE_DENIED", "Resource is outside the principal scope");
  }

  return { toolName: input.toolName, args: input.args };
}

export function createBeforeToolCall(
  principal: Readonly<ActorContext>,
  authorizeResourceScope: ResourceScopeAuthorizer,
): (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> {
  return async (context, signal) => {
    if (signal?.aborted) {
      return { block: true, reason: "Tool call was cancelled" };
    }
    try {
      await authorizeAgentToolCall({
        principal,
        toolName: context.toolCall.name,
        args: context.args,
        authorizeResourceScope,
      });
      return undefined;
    } catch {
      return { block: true, reason: "Tool call denied by authenticated tenant policy" };
    }
  };
}
