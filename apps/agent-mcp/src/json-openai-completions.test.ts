import { completeSimple, Type, type Api, type Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonOpenAICompletionsModel } from "./json-openai-completions.js";

function compatibleModel(): Model<Api> {
  return {
    id: "test-json-model",
    name: "test-json-model",
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: "https://provider.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
    headers: { "User-Agent": "geo-test" },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      sendSessionAffinityHeaders: false,
    },
  };
}

function deepSeekV4ProModel(): Model<Api> {
  return {
    ...compatibleModel(),
    id: "deepseek-v4-pro",
    name: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    maxTokens: 32_000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JSON OpenAI completions adapter", () => {
  it("returns strict JSON tool arguments without using SSE", async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "completion-1",
            model: "test-json-model",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "record_fact",
                        arguments: JSON.stringify({ name: "合同", count: 1 }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(compatibleModel()),
      {
        systemPrompt: "Call the tool.",
        messages: [{ role: "user", content: "记录一条事实", timestamp: Date.now() }],
        tools: [
          {
            name: "record_fact",
            description: "Record a fact count",
            parameters: Type.Object(
              { name: Type.String(), count: Type.Integer() },
              { additionalProperties: false },
            ),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "medium",
        onPayload: (payload) => {
          const value = payload as {
            readonly tools: ReadonlyArray<{
              readonly function: Readonly<Record<string, unknown>>;
            }>;
          };
          return {
            ...(payload as object),
            tools: value.tools.map((tool) => ({
              ...tool,
              function: { ...tool.function, strict: true },
            })),
          };
        },
      },
    );

    expect(result).toMatchObject({
      responseId: "completion-1",
      stopReason: "toolUse",
      usage: { input: 20, output: 5, totalTokens: 25 },
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "record_fact",
          arguments: { name: "合同", count: 1 },
        },
      ],
    });
    expect(requestBody).toMatchObject({
      model: "test-json-model",
      stream: false,
      max_completion_tokens: 8_000,
      reasoning_effort: "medium",
      tools: [{ function: { name: "record_fact", strict: true } }],
    });
  });

  it("caps explicit JSON completion budgets at 131072 tokens", async () => {
    let requestBody: Readonly<Record<string, unknown>> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
          }),
          { status: 200 },
        );
      }),
    );

    await completeSimple(
      jsonOpenAICompletionsModel({ ...compatibleModel(), maxTokens: 140_000 }),
      { messages: [{ role: "user", content: "bounded", timestamp: Date.now() }] },
      { apiKey: "test-provider-key", maxTokens: 140_000 },
    );

    expect(requestBody).toMatchObject({ max_completion_tokens: 131_072, stream: false });
  });

  it("disables DeepSeek V4 thinking when a tool call is required", async () => {
    let requestBody: Readonly<Record<string, unknown>> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  reasoning_content: "Need the tenant context first.",
                  tool_calls: [
                    {
                      id: "call-deepseek-1",
                      type: "function",
                      function: {
                        name: "tenant_context",
                        arguments: JSON.stringify({ tenantId: "tenant-1" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "读取租户", timestamp: Date.now() }],
        tools: [
          {
            name: "tenant_context",
            description: "Read tenant context",
            parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        maxTokens: 20_000,
        onPayload: (payload) => ({ ...(payload as object), tool_choice: "required" }),
      },
    );

    expect(requestBody).toMatchObject({
      model: "deepseek-v4-pro",
      stream: false,
      max_tokens: 20_000,
      reasoning_effort: "max",
      thinking: { type: "disabled" },
      tool_choice: "required",
    });
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Need the tenant context first." },
        {
          type: "toolCall",
          id: "call-deepseek-1",
          name: "tenant_context",
          arguments: { tenantId: "tenant-1" },
        },
      ],
    });
  });

  it("preserves a named DeepSeek V4 tool choice while disabling thinking", async () => {
    let requestBody: Readonly<Record<string, unknown>> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-deepseek-named",
                      type: "function",
                      function: {
                        name: "tenant_context",
                        arguments: JSON.stringify({ tenantId: "tenant-1" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "读取租户", timestamp: Date.now() }],
        tools: [
          {
            name: "tenant_context",
            description: "Read tenant context",
            parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        onPayload: (payload) => ({
          ...(payload as object),
          tool_choice: { type: "function", function: { name: "tenant_context" } },
        }),
      },
    );

    expect(requestBody).toMatchObject({
      thinking: { type: "disabled" },
      tool_choice: { type: "function", function: { name: "tenant_context" } },
    });
  });

  it("keeps one staged DeepSeek V4 tool call when the provider repeats the named call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-deepseek-staged-1",
                        type: "function",
                        function: {
                          name: "tenant_context",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                      {
                        id: "call-deepseek-staged-2",
                        type: "function",
                        function: {
                          name: "tenant_context",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                      {
                        id: "call-deepseek-staged-3",
                        type: "function",
                        function: {
                          name: "tenant_context",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "读取租户", timestamp: Date.now() }],
        tools: [
          {
            name: "tenant_context",
            description: "Read tenant context",
            parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
          },
          {
            name: "geo_brand_profile",
            description: "Read brand profile",
            parameters: Type.Object({ brandId: Type.String() }, { additionalProperties: false }),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        onPayload: (payload) => ({
          ...(payload as object),
          tool_choice: { type: "function", function: { name: "tenant_context" } },
        }),
      },
    );

    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call-deepseek-staged-1",
        name: "tenant_context",
        arguments: { tenantId: "tenant-1" },
      },
    ]);
  });

  it("keeps the selected staged call when V4 mixes other calls into the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-deepseek-mixed-1",
                        type: "function",
                        function: {
                          name: "tenant_context",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                      {
                        id: "call-deepseek-mixed-2",
                        type: "function",
                        function: {
                          name: "geo_template_catalog",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                      {
                        id: "call-deepseek-mixed-3",
                        type: "function",
                        function: {
                          name: "geo_brand_profile",
                          arguments: JSON.stringify({ tenantId: "tenant-1", brandId: "brand-1" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "读取租户", timestamp: Date.now() }],
        tools: [
          {
            name: "tenant_context",
            description: "Read tenant context",
            parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
          },
          {
            name: "geo_template_catalog",
            description: "Read templates",
            parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
          },
          {
            name: "geo_brand_profile",
            description: "Read brand profile",
            parameters: Type.Object(
              { tenantId: Type.String(), brandId: Type.String() },
              { additionalProperties: false },
            ),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        onPayload: (payload) => ({
          ...(payload as object),
          tool_choice: { type: "function", function: { name: "tenant_context" } },
        }),
      },
    );

    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call-deepseek-mixed-1",
        name: "tenant_context",
        arguments: { tenantId: "tenant-1" },
      },
    ]);
  });

  it("drops a single wrong staged tool call from DeepSeek V4 instead of fabricating empty arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-deepseek-wrong-stage",
                        type: "function",
                        function: {
                          name: "geo_fact_lookup",
                          arguments: JSON.stringify({ tenantId: "tenant-1", query: "青岛" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "生成草稿", timestamp: Date.now() }],
        tools: [
          {
            name: "geo_draft_proposal",
            description: "Create a draft proposal",
            parameters: Type.Object(
              { tenantId: Type.String(), brief: Type.String() },
              { additionalProperties: false },
            ),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        onPayload: (payload) => ({
          ...(payload as object),
          tool_choice: { type: "function", function: { name: "geo_draft_proposal" } },
        }),
      },
    );

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [],
    });
  });

  it("drops an empty-argument staged call from DeepSeek V4", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call-deepseek-empty-stage",
                        type: "function",
                        function: {
                          name: "geo_draft_proposal",
                          arguments: "{}",
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      {
        messages: [{ role: "user", content: "生成草稿", timestamp: Date.now() }],
        tools: [
          {
            name: "geo_draft_proposal",
            description: "Create a draft proposal",
            parameters: Type.Object(
              { tenantId: Type.String(), brief: Type.String() },
              { additionalProperties: false },
            ),
          },
        ],
      },
      {
        apiKey: "test-provider-key",
        reasoning: "xhigh",
        onPayload: (payload) => ({
          ...(payload as object),
          tool_choice: { type: "function", function: { name: "geo_draft_proposal" } },
        }),
      },
    );

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [],
    });
  });

  it("keeps DeepSeek V4 thinking enabled when no tool choice is forced", async () => {
    let requestBody: Readonly<Record<string, unknown>> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
          }),
          { status: 200 },
        );
      }),
    );

    await completeSimple(
      jsonOpenAICompletionsModel(deepSeekV4ProModel()),
      { messages: [{ role: "user", content: "write", timestamp: Date.now() }] },
      { apiKey: "test-provider-key", reasoning: "xhigh" },
    );

    expect(requestBody).toMatchObject({
      reasoning_effort: "max",
      thinking: { type: "enabled" },
    });
    expect(requestBody).not.toHaveProperty("tool_choice");
  });

  it("returns DeepSeek reasoning content on the next tool continuation", async () => {
    const requestBodies: Readonly<Record<string, unknown>>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>);
        if (requestBodies.length === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    reasoning_content: "Inspect the authenticated tenant.",
                    tool_calls: [
                      {
                        id: "call-deepseek-continuation",
                        type: "function",
                        function: {
                          name: "tenant_context",
                          arguments: JSON.stringify({ tenantId: "tenant-1" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
          }),
          { status: 200 },
        );
      }),
    );
    const model = jsonOpenAICompletionsModel(deepSeekV4ProModel());
    const tools = [
      {
        name: "tenant_context",
        description: "Read tenant context",
        parameters: Type.Object({ tenantId: Type.String() }, { additionalProperties: false }),
      },
    ];
    const userMessage = { role: "user" as const, content: "读取租户", timestamp: Date.now() };
    const first = await completeSimple(
      model,
      { messages: [userMessage], tools },
      { apiKey: "test-provider-key", reasoning: "xhigh" },
    );

    await completeSimple(
      model,
      {
        messages: [
          userMessage,
          first,
          {
            role: "toolResult",
            toolCallId: "call-deepseek-continuation",
            toolName: "tenant_context",
            content: [{ type: "text", text: '{"tenantId":"tenant-1"}' }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
        tools,
      },
      { apiKey: "test-provider-key", reasoning: "xhigh" },
    );

    expect(requestBodies[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "Inspect the authenticated tenant.",
          tool_calls: expect.any(Array),
        }),
      ]),
    );
  });

  it("rejects non-object JSON tool arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    tool_calls: [
                      {
                        id: "call-1",
                        function: { name: "record_fact", arguments: "[]" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(compatibleModel()),
      { messages: [{ role: "user", content: "bad args", timestamp: Date.now() }] },
      { apiKey: "test-provider-key" },
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider tool arguments must be a JSON object",
    });
  });

  it("rejects oversized streamed JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response("x".repeat(2 * 1024 * 1024 + 1), {
            status: 200,
            headers: { "content-length": "0" },
          }),
        ),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(compatibleModel()),
      { messages: [{ role: "user", content: "large", timestamp: Date.now() }] },
      { apiKey: "test-provider-key" },
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider JSON response exceeded the size limit",
    });
  });

  it("does not include an upstream error body in the surfaced failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(new Response("sensitive upstream detail", { status: 429 })),
      ),
    );

    const result = await completeSimple(
      jsonOpenAICompletionsModel(compatibleModel()),
      { messages: [{ role: "user", content: "retry", timestamp: Date.now() }] },
      { apiKey: "test-provider-key" },
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider request failed with HTTP 429",
    });
  });

  it("rejects providers outside the reviewed compatibility boundary", () => {
    expect(() => jsonOpenAICompletionsModel({ ...compatibleModel(), provider: "openai" })).toThrow(
      "JSON completions mode requires AGENT_PROVIDER=openai-compatible",
    );
  });
});
