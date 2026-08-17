import {
  Agent,
  type AgentTool,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
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
  requireToolChoice?: boolean;
  requiredToolName?: () => string | undefined;
  strictToolArguments?: boolean;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function withStrictToolArguments<T>(payload: T): T {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;

  const tools = payload.tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function") return tool;

    if (isRecord(tool.function)) {
      return { ...tool, function: { ...tool.function, strict: true } };
    }
    return { ...tool, strict: true };
  });
  return { ...payload, tools } as T;
}

export function withRequiredToolChoice<T>(payload: T, toolName?: string): T {
  if (!isRecord(payload) || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  const namedTool =
    typeof toolName === "string" && toolName.length > 0
      ? payload.tools.filter((tool) => {
          if (!isRecord(tool) || tool.type !== "function") return false;
          const functionDefinition = isRecord(tool.function) ? tool.function : tool;
          return functionDefinition.name === toolName;
        })
      : [];
  return {
    ...payload,
    ...(namedTool.length > 0 ? { tools: namedTool } : {}),
    tool_choice:
      typeof toolName === "string" && toolName.length > 0
        ? { type: "function", function: { name: toolName } }
        : "required",
  } as T;
}

export function createRealPiRuntime(options: RealPiRuntimeOptions): Agent {
  for (const tool of options.tools) {
    if (!isAgentToolName(tool.name)) {
      throw new Error(`Real Pi runtime rejected non-allowlisted tool: ${tool.name}`);
    }
  }
  const onPayload: SimpleStreamOptions["onPayload"] = async (payload, model) => {
    const strictPayload =
      options.strictToolArguments === true ? withStrictToolArguments(payload) : payload;
    const requiredToolName = options.requiredToolName?.();
    const effectivePayload =
      options.requireToolChoice === true &&
      (options.requiredToolName === undefined || requiredToolName !== undefined)
        ? withRequiredToolChoice(strictPayload, requiredToolName)
        : strictPayload;
    return (await options.onPayload?.(effectivePayload, model)) ?? effectivePayload;
  };

  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...options.tools],
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    },
    toolExecution: "parallel",
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    ...(options.requireToolChoice === true ||
    options.requiredToolName !== undefined ||
    options.strictToolArguments === true ||
    options.onPayload !== undefined
      ? { onPayload }
      : {}),
    ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
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

export {
  CorrectableToolInputError,
  createPiAgentTools,
  PI_TOOL_SCHEMAS,
  type PiToolWorkflowGuard,
} from "./pi-tools.js";
export type { ThinkingLevel } from "@mariozechner/pi-agent-core";
