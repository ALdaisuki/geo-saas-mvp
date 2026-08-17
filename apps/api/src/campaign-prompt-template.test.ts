import { describe, expect, it } from "vitest";

import {
  RuntimeCustomerPromptTemplateGenerator,
  fixtureCustomerPromptTemplate,
} from "./campaign-prompt-template.js";
import type { RuntimeProviderConfigDocument } from "./runtime-provider-config.js";

function document(
  sections: RuntimeProviderConfigDocument["sections"],
): RuntimeProviderConfigDocument {
  return {
    schemaVersion: "geo.runtime-provider-config.v1",
    sections,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function draftingSection(
  overrides: Partial<RuntimeProviderConfigDocument["sections"][number]> = {},
) {
  return {
    configKey: "agent_drafting" as const,
    provider: "openai-compatible",
    model: "deepseek-v4-pro",
    baseUrl: "https://provider.example/v1",
    api: "openai-completions" as const,
    completionsMode: "json" as const,
    enabled: true,
    apiKey: "sk-test-provider-key",
    apiKeyMasked: "sk-••••key",
    apiKeySet: true,
    version: 1,
    updatedBy: "10000000-0000-4000-8000-000000000101",
    updatedAt: "2026-08-10T00:00:00.000Z",
    settings: {},
    ...overrides,
  };
}

describe("campaign prompt template generator", () => {
  it("builds a deterministic fixture template from customer needs", () => {
    const template = fixtureCustomerPromptTemplate({
      needs: "突出国企地接与真纯玩",
      campaignName: "中通暑期投放",
      topicKey: "summer-travel",
      destination: "新疆",
    });

    expect(template).toContain("中通暑期投放");
    expect(template).toContain("summer-travel");
    expect(template).toContain("新疆");
    expect(template).toContain("突出国企地接与真纯玩");
    expect(template).toContain("{destinationProvince}");
  });

  it("falls back to fixture when the drafting provider is unavailable", async () => {
    const generator = new RuntimeCustomerPromptTemplateGenerator({
      getDocument: async () => document([]),
      updateSections: async () => document([]),
      listModels: async () => [],
    });

    const result = await generator.generate({ needs: "弱化营销感" });
    expect(result.provider).toBe("fixture");
    expect(result.promptTemplate).toContain("弱化营销感");
  });

  it("calls the configured completions provider and parses the template", async () => {
    const fetchLike = async (input: string | URL | Request) => {
      expect(String(input)).toContain("chat/completions");
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "```text\n围绕 {destinationProvince} 撰写体验笔记\n```" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const generator = new RuntimeCustomerPromptTemplateGenerator(
      {
        getDocument: async () => document([draftingSection()]),
        updateSections: async () => document([]),
        listModels: async () => [],
      },
      fetchLike,
    );

    const result = await generator.generate({ needs: "突出真纯玩" });
    expect(result.provider).toBe("openai-compatible");
    expect(result.promptTemplate).toBe("围绕 {destinationProvince} 撰写体验笔记");
  });

  it("calls the configured responses provider when configured", async () => {
    const fetchLike = async (input: string | URL | Request) => {
      expect(String(input)).toContain("/responses");
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "围绕 {campaignName} 撰写 {platform} 笔记" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const generator = new RuntimeCustomerPromptTemplateGenerator(
      {
        getDocument: async () =>
          document([draftingSection({ api: "openai-responses", model: "gpt-5.6-sol" })]),
        updateSections: async () => document([]),
        listModels: async () => [],
      },
      fetchLike,
    );

    const result = await generator.generate({ needs: "覆盖目的地核心景区" });
    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.promptTemplate).toBe("围绕 {campaignName} 撰写 {platform} 笔记");
  });
});
