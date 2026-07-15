import type { ActorContext } from "@geo/contracts";

import type { PlasticPromiseGovernanceClient } from "./governance.js";
import {
  AGENT_TOOL_POLICIES,
  authorizeAgentToolCall,
  type AgentToolName,
  type GeoAgentToolName,
  type ResourceScopeAuthorizer,
} from "./policy.js";
import { redactSensitiveDetails } from "./redaction.js";
import { PlasticPromisePublicationGate } from "./publication-governance.js";

export interface GeoApplicationToolInvoker {
  invoke(toolName: GeoAgentToolName, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

class SequentialExecutor {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function governanceToolCall(
  client: PlasticPromiseGovernanceClient,
  principal: Readonly<ActorContext>,
  toolName: AgentToolName,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const projectId = `project:geo-saas:tenant:${principal.tenantId}`;
  if (toolName === "plastic_context_supply") {
    return client.contextSupply({
      task_description: args.taskDescription,
      task_type: args.taskType,
      project_id: projectId,
      project_policy: "strict",
      retrieval_mode: "project",
    });
  }
  if (toolName === "plastic_audit_pre_check") {
    return client.auditPreCheck({
      action_type: "write",
      action_description: JSON.stringify({
        action: args.action,
        tenantId: principal.tenantId,
        projectId,
        context: args.context,
      }),
    });
  }
  if (toolName === "plastic_defense") {
    return client.defense({
      action: "evaluate_tool",
      tool_name: args.targetToolName,
    });
  }
  throw new Error("Not a Plastic Promise tool");
}

export class GovernedAgentRuntime {
  readonly principal: Readonly<ActorContext>;
  readonly #geo: GeoApplicationToolInvoker;
  readonly #governance: PlasticPromiseGovernanceClient;
  readonly #authorizeResourceScope: ResourceScopeAuthorizer;
  readonly #sequential = new SequentialExecutor();

  constructor(options: {
    principal: Readonly<ActorContext>;
    geo: GeoApplicationToolInvoker;
    governance: PlasticPromiseGovernanceClient;
    authorizeResourceScope: ResourceScopeAuthorizer;
  }) {
    this.principal = options.principal;
    this.#geo = options.geo;
    this.#governance = options.governance;
    this.#authorizeResourceScope = options.authorizeResourceScope;
  }

  async invoke(toolName: string, args: unknown): Promise<unknown> {
    const authorized = await authorizeAgentToolCall({
      principal: this.principal,
      toolName,
      args,
      authorizeResourceScope: this.#authorizeResourceScope,
    });
    const operation = async (): Promise<unknown> => {
      if (authorized.toolName === "geo_publication_request") {
        const decision = await new PlasticPromisePublicationGate(this.#governance).evaluate({
          phase: "pre_authorization",
          tenantId: this.principal.tenantId,
          actorId: this.principal.actorId,
          resourceId: String(authorized.args.variantId),
          executionLevel: authorized.args.executionLevel as "dry_run" | "assisted" | "unattended",
          requestFingerprint: String(authorized.args.idempotencyKey),
        });
        if (!decision.allowed) {
          throw new Error(`Publication governance denied: ${decision.reason}`);
        }
      }
      const result = authorized.toolName.startsWith("geo_")
        ? await this.#geo.invoke(authorized.toolName as GeoAgentToolName, authorized.args)
        : await governanceToolCall(
            this.#governance,
            this.principal,
            authorized.toolName,
            authorized.args,
          );
      return redactSensitiveDetails(result);
    };
    return AGENT_TOOL_POLICIES[authorized.toolName].sequential
      ? this.#sequential.run(operation)
      : operation();
  }
}
