import {
  createAssistantMessageEventStream,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";

export const JSON_OPENAI_COMPLETIONS_API = "geo-openai-json-completions";
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_COMPLETION_TOKENS = 131_072;
const PROVIDER_SOURCE_ID = "geo-agent-mcp-json-openai-completions";

const completionCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: false,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: false,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
} as const satisfies Parameters<typeof convertMessages>[2];

function isOfficialDeepSeekV4Model(model: Model<typeof JSON_OPENAI_COMPLETIONS_API>): boolean {
  let hostname: string;
  try {
    hostname = new URL(model.baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "api.deepseek.com" && /^deepseek-v4-(?:flash|pro)$/u.test(model.id);
}

function conversionCompatibility(model: Model<typeof JSON_OPENAI_COMPLETIONS_API>) {
  if (!isOfficialDeepSeekV4Model(model)) return completionCompat;
  return {
    ...completionCompat,
    maxTokensField: "max_tokens" as const,
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek" as const,
  } satisfies Parameters<typeof convertMessages>[2];
}

function contextForOpenAIConversion(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  context: Context,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) =>
      message.role === "assistant" &&
      message.api === model.api &&
      message.provider === model.provider &&
      message.model === model.id
        ? { ...message, api: "openai-completions" as const }
        : message,
    ),
  };
}

type JsonCompletionOptions = StreamOptions & {
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function responseUsage(value: unknown): AssistantMessage["usage"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyUsage();
  const usage = value as Readonly<Record<string, unknown>>;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return {
    input: prompt,
    output: completion,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: prompt + completion,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function namedFunctionToolChoiceName(value: unknown): string | undefined {
  const choice = record(value);
  const functionChoice = record(choice?.function);
  if (
    choice?.type === "function" &&
    typeof functionChoice?.name === "string" &&
    functionChoice.name.length > 0
  ) {
    return functionChoice.name;
  }
  return undefined;
}

function isNamedFunctionToolChoice(value: unknown): boolean {
  return namedFunctionToolChoiceName(value) !== undefined;
}

function normalizeProviderPayload(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const thinking = record(payload.thinking);
  if (
    !isOfficialDeepSeekV4Model(model) ||
    thinking?.type !== "enabled" ||
    payload.tool_choice === undefined
  ) {
    return payload;
  }
  if (payload.tool_choice === "required" || isNamedFunctionToolChoice(payload.tool_choice)) {
    return { ...payload, thinking: { type: "disabled" } };
  }
  const supportedPayload = { ...payload };
  delete supportedPayload.tool_choice;
  return supportedPayload;
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Provider returned invalid JSON tool calls");
  return value.map((entry) => {
    const call = record(entry);
    const fn = record(call?.function);
    if (
      typeof call?.id !== "string" ||
      call.id.length === 0 ||
      typeof fn?.name !== "string" ||
      fn.name.length === 0 ||
      typeof fn.arguments !== "string"
    ) {
      throw new Error("Provider returned an invalid JSON tool call");
    }
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      throw new Error("Provider returned invalid JSON tool arguments");
    }
    if (record(args) === null) throw new Error("Provider tool arguments must be a JSON object");
    return { type: "toolCall", id: call.id, name: fn.name, arguments: args } as ToolCall;
  });
}

function normalizeDeepSeekStagedToolCalls(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  context: Context,
  toolCalls: readonly ToolCall[],
  requestedToolName?: string,
): readonly ToolCall[] {
  if (!isOfficialDeepSeekV4Model(model)) {
    return toolCalls;
  }
  const stagedToolName =
    requestedToolName ?? (context.tools?.length === 1 ? context.tools[0]?.name : undefined);
  if (
    typeof stagedToolName !== "string" ||
    !context.tools?.some((tool) => tool.name === stagedToolName)
  ) {
    return toolCalls;
  }
  const stagedToolCalls = toolCalls.filter(
    (toolCall) => toolCall.name === stagedToolName && Object.keys(toolCall.arguments).length > 0,
  );
  if (stagedToolCalls.length === 0) {
    // DeepSeek V4 can ignore a named tool choice and return a call for another
    // tool, sometimes one that is not even present in the payload. Fabricating
    // an empty call to the staged tool only produced an opaque validation
    // error that V4 repeated indefinitely, so drop the turn's calls instead
    // and let the runner's corrective continuation re-drive the stage.
    return [];
  }
  if (toolCalls.length <= 1) return stagedToolCalls;
  // V4 Flash can repeat a staged call or add other calls in one response even
  // when the request exposes one named tool. The staged runtime executes one
  // tool at a time; keep only the first allowed call and let the next turn
  // request the next stage so no unexpected call can run in parallel.
  return stagedToolCalls.slice(0, 1);
}

function stopReason(
  value: unknown,
  hasToolCalls: boolean,
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
  if (hasToolCalls) return "toolUse";
  if (value === "tool_calls" || value === "function_call") return "stop";
  if (value === "stop" || value === "end" || value === null || value === undefined) return "stop";
  if (value === "length") return "length";
  throw new Error("Provider returned an unsupported JSON finish reason");
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("Provider JSON response exceeded the size limit");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Provider JSON response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function completionPayload(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  context: Context,
  options?: JsonCompletionOptions,
): Readonly<Record<string, unknown>> {
  const conversionModel = { ...model, api: "openai-completions" as const };
  const officialDeepSeekV4 = isOfficialDeepSeekV4Model(model);
  const maxTokens = Math.min(
    options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : MAX_JSON_COMPLETION_TOKENS),
    MAX_JSON_COMPLETION_TOKENS,
  );
  return {
    model: model.id,
    messages: convertMessages(
      conversionModel,
      contextForOpenAIConversion(model, context),
      conversionCompatibility(model),
    ),
    stream: false,
    ...(officialDeepSeekV4 ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.reasoningEffort === undefined
      ? {}
      : {
          reasoning_effort:
            officialDeepSeekV4 && options.reasoningEffort === "xhigh"
              ? "max"
              : options.reasoningEffort,
          ...(officialDeepSeekV4 ? { thinking: { type: "enabled" } } : {}),
        }),
    ...(context.tools === undefined || context.tools.length === 0
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            },
          })),
        }),
  };
}

function streamJsonOpenAICompletions(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  context: Context,
  options?: JsonCompletionOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      if (options?.apiKey === undefined || options.apiKey.length === 0) {
        throw new Error("OpenAI-compatible API key is required");
      }
      const originalPayload = completionPayload(model, context, options);
      const projected = await options.onPayload?.(originalPayload, model);
      const projectedRecord = record(projected ?? originalPayload);
      if (projectedRecord === null)
        throw new Error("Provider payload projection must be an object");
      const payload: Readonly<Record<string, unknown>> = {
        ...normalizeProviderPayload(model, projectedRecord),
        stream: false,
      };
      const endpoint = new URL("chat/completions", `${model.baseUrl.replace(/\/$/u, "")}/`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...model.headers,
          ...options.headers,
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await options.onResponse?.(
        { status: response.status, headers: responseHeaders(response.headers) },
        model,
      );
      const raw = await boundedResponseText(response);
      if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new Error("Provider returned invalid JSON response");
      }
      const envelope = record(decoded);
      const choice = Array.isArray(envelope?.choices) ? record(envelope.choices[0]) : null;
      const message = record(choice?.message);
      if (envelope === null || choice === null || message === null) {
        throw new Error("Provider returned an incomplete JSON response");
      }
      const toolCalls = normalizeDeepSeekStagedToolCalls(
        model,
        context,
        parseToolCalls(message.tool_calls),
        namedFunctionToolChoiceName(payload.tool_choice),
      );
      const text = typeof message.content === "string" ? message.content : "";
      const reasoning =
        typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      if (typeof envelope.id === "string") output.responseId = envelope.id;
      if (typeof envelope.model === "string") output.responseModel = envelope.model;
      output.usage = responseUsage(envelope.usage);
      const completedReason = stopReason(choice.finish_reason, toolCalls.length > 0);
      output.stopReason = completedReason;
      stream.push({ type: "start", partial: output });
      if (reasoning.length > 0) {
        const index = output.content.length;
        output.content.push({
          type: "thinking",
          thinking: reasoning,
          thinkingSignature: "reasoning_content",
        });
        stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: reasoning,
          partial: output,
        });
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: reasoning,
          partial: output,
        });
      }
      if (text.length > 0) {
        const index = output.content.length;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: index, partial: output });
        stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
      }
      for (const toolCall of toolCalls) {
        const index = output.content.length;
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: JSON.stringify(toolCall.arguments),
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
      }
      stream.push({ type: "done", reason: completedReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : "Provider request failed";
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function streamSimpleJsonOpenAICompletions(
  model: Model<typeof JSON_OPENAI_COMPLETIONS_API>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamJsonOpenAICompletions(model, context, {
    ...options,
    ...(options?.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
  });
}

let registered = false;

export function jsonOpenAICompletionsModel(model: Model<Api>): Model<Api> {
  if (model.provider !== "openai-compatible") {
    throw new Error("JSON completions mode requires AGENT_PROVIDER=openai-compatible");
  }
  if (model.api !== "openai-completions") {
    throw new Error("JSON completions mode requires AGENT_API=openai-completions");
  }
  if (!registered) {
    registerApiProvider(
      {
        api: JSON_OPENAI_COMPLETIONS_API,
        stream: streamJsonOpenAICompletions,
        streamSimple: streamSimpleJsonOpenAICompletions,
      },
      PROVIDER_SOURCE_ID,
    );
    registered = true;
  }
  return {
    ...model,
    api: JSON_OPENAI_COMPLETIONS_API,
    maxTokens: Math.min(
      model.maxTokens > 0 ? model.maxTokens : MAX_JSON_COMPLETION_TOKENS,
      MAX_JSON_COMPLETION_TOKENS,
    ),
  } as Model<Api>;
}
