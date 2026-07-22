import {
  Agent,
  type AgentTool,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
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
  thinkingLevel?: ThinkingLevel;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
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
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
    toolExecution: "parallel",
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    beforeToolCall: createBeforeToolCall(options.principal, options.authorizeResourceScope),
    afterToolCall: async (context, signal) => {
      const override = await options.afterToolCall?.(context, signal);
      return {
        ...override,
        content: (override?.content ?? context.result.content).map((block) =>
          block.type === "text"
            ? { ...block, text: String(redactSensitiveDetails(block.text)) }
            : block,
        ),
        details: redactSensitiveDetails(override?.details ?? context.result.details),
      };
    },
  });
}

export { createPiAgentTools, PI_TOOL_SCHEMAS } from "./pi-tools.js";
export type { ThinkingLevel } from "@mariozechner/pi-agent-core";
