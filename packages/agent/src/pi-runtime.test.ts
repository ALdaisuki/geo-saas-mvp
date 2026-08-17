import { describe, expect, it } from "vitest";

import { withRequiredToolChoice, withStrictToolArguments } from "./pi-runtime.js";

describe("Pi runtime required tool choice", () => {
  it("requires a tool call without mutating provider payloads that expose tools", () => {
    const payload = {
      model: "test-model",
      tools: [{ type: "function", name: "geo_draft_proposal" }],
      tool_choice: "auto",
    } as const;

    const transformed = withRequiredToolChoice(payload);

    expect(transformed).not.toBe(payload);
    expect(transformed).toMatchObject({ tool_choice: "required" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("leaves payloads without tools unchanged", () => {
    const payload = { model: "test-model" } as const;

    expect(withRequiredToolChoice(payload)).toBe(payload);
  });

  it("can require one named tool without mutating the provider payload", () => {
    const payload = {
      model: "test-model",
      tools: [
        { type: "function", function: { name: "geo_tenant_context" } },
        { type: "function", function: { name: "geo_fact_lookup" } },
      ],
      tool_choice: "auto",
    } as const;

    const transformed = withRequiredToolChoice(payload, "geo_fact_lookup");

    expect(transformed).not.toBe(payload);
    expect(transformed).toMatchObject({
      tool_choice: { type: "function", function: { name: "geo_fact_lookup" } },
      tools: [{ type: "function", function: { name: "geo_fact_lookup" } }],
    });
    expect(transformed.tools).toHaveLength(1);
    expect(payload.tools).toHaveLength(2);
    expect(payload.tool_choice).toBe("auto");
  });
});

describe("Pi runtime strict tool arguments", () => {
  it("enables strict JSON arguments for OpenAI Responses tools without mutating the payload", () => {
    const payload = {
      model: "test-model",
      tools: [
        {
          type: "function",
          name: "geo_draft_proposal",
          parameters: { type: "object", additionalProperties: false },
          strict: false,
        },
      ],
    } as const;

    const transformed = withStrictToolArguments(payload);

    expect(transformed).not.toBe(payload);
    expect(transformed.tools[0]).toMatchObject({
      type: "function",
      name: "geo_draft_proposal",
      strict: true,
    });
    expect(payload.tools[0].strict).toBe(false);
  });

  it("enables strict JSON arguments for OpenAI Chat Completions tools", () => {
    const payload = {
      tools: [
        {
          type: "function",
          function: {
            name: "geo_fact_lookup",
            parameters: { type: "object", additionalProperties: false },
            strict: false,
          },
        },
      ],
    } as const;

    expect(withStrictToolArguments(payload).tools[0]).toMatchObject({
      type: "function",
      function: { name: "geo_fact_lookup", strict: true },
    });
  });

  it("leaves non-function tools and payloads without tools unchanged", () => {
    const payload = { tools: [{ type: "web_search", strict: false }] } as const;
    const withoutTools = { model: "test-model" } as const;

    expect(withStrictToolArguments(payload).tools[0]).toEqual(payload.tools[0]);
    expect(withStrictToolArguments(withoutTools)).toBe(withoutTools);
  });
});
