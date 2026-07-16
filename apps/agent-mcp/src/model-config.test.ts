import { describe, expect, it } from "vitest";

import { resolvePiAgentModel } from "./model-config.js";

describe("Pi agent model configuration", () => {
  it("resolves models from Pi's registered providers", () => {
    const resolved = resolvePiAgentModel({ provider: "openai", modelId: "gpt-5" });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toMatchObject({
      id: "gpt-5",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("builds an explicit OpenAI Responses model for a compatible endpoint", () => {
    const resolved = resolvePiAgentModel({
      provider: "openai-compatible",
      modelId: "gpt-5.6-sol",
      baseUrl: "https://models.example.test/v1/",
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-responses",
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      reasoning: true,
    });
  });

  it("permits plaintext HTTP only for loopback development endpoints", () => {
    expect(
      resolvePiAgentModel({
        provider: "openai-compatible",
        modelId: "local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
      }).model.baseUrl,
    ).toBe("http://127.0.0.1:11434/v1");
    expect(() =>
      resolvePiAgentModel({
        provider: "openai-compatible",
        modelId: "remote-model",
        baseUrl: "http://models.example.test/v1",
      }),
    ).toThrow(/HTTPS/iu);
  });

  it("rejects ambiguous or credential-bearing custom endpoint configuration", () => {
    expect(() => resolvePiAgentModel({ provider: "openai-compatible", modelId: "custom" })).toThrow(
      /AGENT_BASE_URL is required/iu,
    );
    expect(() =>
      resolvePiAgentModel({
        provider: "openai-compatible",
        modelId: "custom",
        baseUrl: "https://user:secret@models.example.test/v1",
      }),
    ).toThrow(/credentials/iu);
    expect(() =>
      resolvePiAgentModel({
        provider: "openai-compatible",
        modelId: "custom",
        baseUrl: "https://models.example.test/v1?tenant=one#fragment",
      }),
    ).toThrow(/query string or fragment/iu);
    expect(() =>
      resolvePiAgentModel({
        provider: "openai",
        modelId: "gpt-5",
        baseUrl: "https://models.example.test/v1",
      }),
    ).toThrow(/only supported/iu);
  });

  it("rejects unknown registered providers and models", () => {
    expect(() =>
      resolvePiAgentModel({
        provider: "openai-compatible",
        modelId: " ",
        baseUrl: "https://models.example.test/v1",
      }),
    ).toThrow(/AGENT_MODEL/iu);
    expect(() => resolvePiAgentModel({ provider: "unknown", modelId: "gpt-5" })).toThrow(
      /not supported/iu,
    );
    expect(() => resolvePiAgentModel({ provider: "openai", modelId: "unknown" })).toThrow(
      /not available/iu,
    );
  });
});
