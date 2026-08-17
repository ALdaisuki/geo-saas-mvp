import type { PlasticPromiseGovernanceClient } from "@geo/agent";
import type { ActorContext } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import type { InternalGeoApiClient } from "./api-client.js";
import {
  HotReloadingMediaInspectionService,
  HotReloadingPiAgentRunService,
  resolveRuntimePiServices,
  type RuntimeProviderConfigDocument,
} from "./runtime-provider-config.js";

const principal: ActorContext = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000101",
  role: "owner",
  capabilities: ["tenant:read", "content:read", "automation:execute"],
  requestId: "runtime-provider-config-test",
};

function document(
  sections: RuntimeProviderConfigDocument["sections"],
): RuntimeProviderConfigDocument {
  return {
    schemaVersion: "geo.runtime-provider-config.v1",
    sections,
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("runtime provider configuration hot reload", () => {
  it("resolves enabled drafting and media inspection sections", () => {
    const resolved = resolveRuntimePiServices(
      document([
        {
          configKey: "agent_drafting",
          provider: "openai-compatible",
          model: "gpt-5",
          baseUrl: "https://api.example.test/v1",
          api: "openai-responses",
          completionsMode: "stream",
          enabled: true,
          apiKey: "sk-drafting-secret",
          apiKeyMasked: "sk-••••cret",
          apiKeySet: true,
          version: 1,
          updatedBy: principal.actorId,
          updatedAt: "2026-08-05T00:00:00.000Z",
          settings: {},
        },
        {
          configKey: "agent_media_inspection",
          provider: "fixture",
          model: "fixture-vision-v1",
          baseUrl: null,
          api: null,
          completionsMode: "json",
          enabled: true,
          apiKey: null,
          apiKeyMasked: null,
          apiKeySet: false,
          version: 1,
          updatedBy: principal.actorId,
          updatedAt: "2026-08-05T00:00:00.000Z",
          settings: {},
        },
      ]),
    );

    expect(resolved.drafting).toMatchObject({
      provider: "openai-compatible",
      modelId: "gpt-5",
      apiKey: "sk-drafting-secret",
    });
    expect(resolved.mediaInspection).toBeNull();
  });

  it("reloads the agent runner capability when the saved configuration changes", async () => {
    let current = document([
      {
        configKey: "agent_drafting",
        provider: "openai-compatible",
        model: "gpt-5",
        baseUrl: "https://api.example.test/v1",
        api: "openai-responses",
        completionsMode: "stream",
        enabled: true,
        apiKey: "sk-drafting-secret",
        apiKeyMasked: "sk-••••cret",
        apiKeySet: true,
        version: 1,
        updatedBy: principal.actorId,
        updatedAt: "2026-08-05T00:00:00.000Z",
        settings: {},
      },
    ]);
    const source = {
      getRuntimeProviderConfiguration: async () => current,
    };
    const service = new HotReloadingPiAgentRunService({
      source,
      api: {} as InternalGeoApiClient,
      governance: {} as PlasticPromiseGovernanceClient,
      fallbackFixtureModel: "fixture-geo-writer-v1",
    });

    expect(service.capability).toEqual({
      mode: "fixture",
      provider: "fixture",
      model: "fixture-geo-writer-v1",
    });

    await service.refreshConfiguration(principal);
    expect(service.capability).toEqual({
      mode: "pi",
      provider: "openai-compatible",
      model: "gpt-5",
    });

    current = document([
      {
        configKey: "agent_drafting",
        provider: "openai-compatible",
        model: "gpt-5.6",
        baseUrl: "https://api.example.test/v1",
        api: "openai-responses",
        completionsMode: "stream",
        enabled: true,
        apiKey: "sk-drafting-secret",
        apiKeyMasked: "sk-••••cret",
        apiKeySet: true,
        version: 2,
        updatedBy: principal.actorId,
        updatedAt: "2026-08-05T00:01:00.000Z",
        settings: {},
      },
    ]);
    await service.refreshConfiguration(principal);
    expect(service.capability).toEqual({
      mode: "pi",
      provider: "openai-compatible",
      model: "gpt-5.6",
    });
  });

  it("reloads the media inspection capability when a vision provider is saved", async () => {
    let current = document([]);
    const source = {
      getRuntimeProviderConfiguration: async () => current,
    };
    const service = new HotReloadingMediaInspectionService({ source });

    expect(service.capability).toEqual({
      mode: "live",
      provider: "manual-review-operator",
      model: "manual-review-queue-v1",
    });

    current = document([
      {
        configKey: "agent_media_inspection",
        provider: "openai-compatible",
        model: "gpt-5-mini",
        baseUrl: "https://api.example.test/v1",
        api: "openai-completions",
        completionsMode: "json",
        enabled: true,
        apiKey: "sk-vision-secret",
        apiKeyMasked: "sk-••••cret",
        apiKeySet: true,
        version: 1,
        updatedBy: principal.actorId,
        updatedAt: "2026-08-05T00:01:00.000Z",
        settings: {},
      },
    ]);
    await service.refreshConfiguration(principal);
    expect(service.capability).toEqual({
      mode: "live",
      provider: "openai-compatible",
      model: "gpt-5-mini",
    });
  });

  it("marks a manual-review handoff as passed while retaining the manual queue label", async () => {
    const source = { getRuntimeProviderConfiguration: async () => document([]) };
    const service = new HotReloadingMediaInspectionService({ source });

    const inspection = await service.inspect(principal, {
      assetSha256: "a".repeat(64),
      mimeType: "image/png",
      bytesBase64: "aGVsbG8=",
      platform: "toutiao",
      role: "cover",
    });

    expect(inspection).toMatchObject({
      assetSha256: "a".repeat(64),
      status: "passed",
      evaluator: "manual-review-operator",
      evaluatorMode: "live",
      evaluatorVersion: "1.0.0",
      model: "manual-review-queue-v1",
    });
    expect(inspection.labels).toContain("manual-review:required");
  });

  it("skips Vision inference and does not enter manual review when no review is selected", async () => {
    const source = {
      getRuntimeProviderConfiguration: async () =>
        document([
          {
            configKey: "agent_media_inspection",
            provider: "no-vision-pass-through",
            model: "no-vision-v1",
            baseUrl: null,
            api: null,
            completionsMode: "json",
            enabled: true,
            apiKey: null,
            apiKeyMasked: null,
            apiKeySet: false,
            version: 1,
            updatedBy: principal.actorId,
            updatedAt: "2026-08-06T00:00:00.000Z",
            settings: { reviewMode: "none" },
          },
        ]),
    };
    const service = new HotReloadingMediaInspectionService({ source });

    await service.refreshConfiguration(principal);
    expect(service.capability).toEqual({
      mode: "live",
      provider: "no-vision-pass-through",
      model: "no-vision-v1",
    });

    const inspection = await service.inspect(principal, {
      assetSha256: "a".repeat(64),
      mimeType: "image/png",
      bytesBase64: "aGVsbG8=",
      platform: "toutiao",
      role: "cover",
    });

    expect(inspection).toMatchObject({
      assetSha256: "a".repeat(64),
      status: "passed",
      evaluator: "no-vision-pass-through",
      evaluatorMode: "live",
      evaluatorVersion: "1.0.0",
      model: "no-vision-v1",
    });
    expect(inspection.labels).toContain("vision-audit:skipped");
    expect(inspection.labels).not.toContain("manual-review:required");
  });

  it("uses the current drafting/Codex configuration when no independent vision provider is saved", async () => {
    const current = document([
      {
        configKey: "agent_drafting",
        provider: "openai-compatible",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        completionsMode: "json",
        enabled: true,
        apiKey: "sk-drafting-secret",
        apiKeyMasked: "sk-••••cret",
        apiKeySet: true,
        version: 1,
        updatedBy: principal.actorId,
        updatedAt: "2026-08-05T00:01:00.000Z",
        settings: { thinkingLevel: "low" },
      },
    ]);
    const source = { getRuntimeProviderConfiguration: async () => current };
    const service = new HotReloadingMediaInspectionService({ source });

    await service.refreshConfiguration(principal);
    expect(service.capability).toEqual({
      mode: "live",
      provider: "openai-compatible",
      model: "deepseek-v4-pro",
    });
  });
});
