import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ActorContext } from "@geo/contracts";

import { createBeforeToolCall, isAgentToolName, type ResourceScopeAuthorizer } from "./policy.js";
import { redactSensitiveDetails } from "./redaction.js";

export interface RealPiRuntimeOptions {
  principal: Readonly<ActorContext>;
  model: Model<Api>;
  tools: readonly AgentTool[];
  authorizeResourceScope: ResourceScopeAuthorizer;
  systemPrompt: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export function createRealPiRuntime(options: RealPiRuntimeOptions): Agent {
  for (const tool of options.tools) {
    if (!isAgentToolName(tool.name)) {
      throw new Error(`Real Pi runtime rejected non-allowlisted tool: ${tool.name}`);
    }
  }
  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...options.tools],
    },
    toolExecution: "parallel",
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    beforeToolCall: createBeforeToolCall(options.principal, options.authorizeResourceScope),
    afterToolCall: async ({ result }) => ({
      content: result.content.map((block) =>
        block.type === "text"
          ? { ...block, text: String(redactSensitiveDetails(block.text)) }
          : block,
      ),
      details: redactSensitiveDetails(result.details),
    }),
  });
}

export { createPiAgentTools, PI_TOOL_SCHEMAS } from "./pi-tools.js";
