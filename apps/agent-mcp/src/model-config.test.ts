import { describe, expect, it } from "vitest";

import {
  readPiServiceRuntimeConfiguration,
  resolvePiAgentModel,
  resolvePiServiceModels,
} from "./model-config.js";

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
      headers: { "User-Agent": "geo-saas-pi-agent/0.1" },
    });
  });

  it("builds an explicitly selected OpenAI Chat Completions model", () => {
    const resolved = resolvePiAgentModel({
      provider: "openai-compatible",
      modelId: "gpt-5.6-sol",
      baseUrl: "https://models.example.test/v1/",
      api: "openai-completions",
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      reasoning: true,
      headers: { "User-Agent": "geo-saas-pi-agent/0.1" },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        sendSessionAffinityHeaders: false,
      },
    });
  });

  it("resolves independent drafting and media inspection models", () => {
    const resolved = resolvePiServiceModels({
      drafting: {
        provider: "openai-compatible",
        modelId: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
      },
      mediaInspection: {
        provider: "openai-compatible",
        modelId: "gpt-5.6-terra",
        baseUrl: "https://vision.example.test/v1",
        api: "openai-responses",
      },
    });

    expect(resolved.drafting.model).toMatchObject({
      id: "deepseek-v4-flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(resolved.mediaInspection.model).toMatchObject({
      id: "gpt-5.6-terra",
      api: "openai-responses",
      baseUrl: "https://vision.example.test/v1",
    });
  });

  it("reads separate drafting and media inspection runtime credentials", () => {
    const configuration = readPiServiceRuntimeConfiguration({
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "deepseek-v4-flash",
      AGENT_API: "openai-completions",
      AGENT_BASE_URL: "https://api.deepseek.com",
      AGENT_COMPLETIONS_MODE: "json",
      AGENT_API_KEY: "draft-secret",
      MEDIA_INSPECTION_PROVIDER: "openai-compatible",
      MEDIA_INSPECTION_MODEL: "vision-model",
      MEDIA_INSPECTION_API: "openai-responses",
      MEDIA_INSPECTION_BASE_URL: "https://vision.example.test/v1",
      MEDIA_INSPECTION_COMPLETIONS_MODE: "stream",
      MEDIA_INSPECTION_API_KEY: "vision-secret",
    });

    expect(configuration).toEqual({
      drafting: {
        provider: "openai-compatible",
        modelId: "deepseek-v4-flash",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        completionsMode: "json",
        apiKey: "draft-secret",
      },
      mediaInspection: {
        provider: "openai-compatible",
        modelId: "vision-model",
        api: "openai-responses",
        baseUrl: "https://vision.example.test/v1",
        completionsMode: "stream",
        apiKey: "vision-secret",
      },
    });
  });

  it("fails closed when independent media inspection configuration is missing", () => {
    expect(() =>
      readPiServiceRuntimeConfiguration({
        AGENT_PROVIDER: "openai-compatible",
        AGENT_MODEL: "deepseek-v4-flash",
        AGENT_API: "openai-completions",
        AGENT_BASE_URL: "https://api.deepseek.com",
        AGENT_COMPLETIONS_MODE: "json",
        AGENT_API_KEY: "draft-secret",
      }),
    ).toThrow(/MEDIA_INSPECTION_PROVIDER/iu);
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
    expect(() =>
      resolvePiAgentModel({
        provider: "openai",
        modelId: "gpt-5",
        api: "openai-completions",
      }),
    ).toThrow(/only supported/iu);
  });
});
