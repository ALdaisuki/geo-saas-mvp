import { PlasticPromiseGovernanceClient, type McpToolCaller } from "@geo/agent";
import type { ActorContext } from "@geo/contracts";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import type { InternalGeoApiClient, PublicationRequestInput } from "./api-client.js";
import { FixturePiAgentRunService, PiAgentRunError, RealPiAgentRunService } from "./pi-runner.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000101",
  brand: "10000000-0000-4000-8000-000000000301",
  campaign: "10000000-0000-4000-8000-000000000501",
  account: "10000000-0000-4000-8000-000000000701",
  content: "10000000-0000-4000-8000-000000000600",
  version: "10000000-0000-4000-8000-000000000601",
  variant: "10000000-0000-4000-8000-000000000602",
  audit: "10000000-0000-4000-8000-000000000603",
  artifact: "10000000-0000-4000-8000-000000000606",
  publication: "10000000-0000-4000-8000-000000000604",
  outbox: "10000000-0000-4000-8000-000000000605",
};

const principal: ActorContext = {
  tenantId: ids.tenant,
  actorId: ids.actor,
  role: "owner",
  capabilities: ["tenant:read", "content:read", "content:write", "audit:run", "publish:request"],
  requestId: "pi-runner-test",
};

function governance(
  calls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [],
): PlasticPromiseGovernanceClient {
  return new PlasticPromiseGovernanceClient({
    callTool: async (input) => {
      calls.push(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              input.name === "audit_pre_check"
                ? { passed: true, compliance_score: 0.85 }
                : input.name === "defense"
                  ? {
                      decision: "allow",
                      tool_name: "geo_publication_request",
                      risk_level: "high",
                      required_trust: 0.6,
                      manifest: {
                        name: "geo_publication_request",
                        side_effects: ["external_publish"],
                      },
                    }
                  : { context: "fixture" },
            ),
          },
        ],
      };
    },
  });
}

function fakeApi(
  publicationInputs: PublicationRequestInput[] = [],
  scopeToolNames: string[] = [],
): InternalGeoApiClient {
  return {
    getTenantContext: async () => ({ tenantId: ids.tenant }),
    lookupFacts: async () => ({ facts: [], evidence: [] }),
    proposeDraft: async () => ({ contentItemId: ids.content, contentVersionId: ids.version }),
    previewVariant: async () => ({ variantId: ids.variant }),
    requestAudit: async () => ({
      auditRunId: ids.audit,
      auditArtifactId: ids.artifact,
      status: "passed",
      eligibleForPublicationRequest: true,
    }),
    requestPublication: async (_actor, input) => {
      publicationInputs.push(input);
      return {
        publicationRequestId: ids.publication,
        publicationJobId: ids.publication,
        outboxEventId: ids.outbox,
      };
    },
    requestVisibilityRun: async () => ({ visibilityRunId: ids.publication }),
    authorizeResourceScope: async (_principal, toolName) => {
      scopeToolNames.push(toolName);
      return toolName.startsWith("geo_");
    },
  };
}

const fauxRegistrations: Array<ReturnType<typeof registerFauxProvider>> = [];

afterEach(() => {
  for (const registration of fauxRegistrations.splice(0)) registration.unregister();
});

describe("Pi agent run service", () => {
  it("runs the credential-free fixture workflow through governed dry-run tools", async () => {
    const publications: PublicationRequestInput[] = [];
    const scopeToolNames: string[] = [];
    const governanceCalls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [];
    const service = new FixturePiAgentRunService({
      api: fakeApi(publications, scopeToolNames),
      governance: governance(governanceCalls),
      model: "fixture-geo-writer-v1",
    });

    await expect(
      service.run(principal, {
        workflow: "draft_to_publication",
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        channelAccountId: ids.account,
        platform: "toutiao",
        topic: "有证据的日本长者旅行指南",
        idempotencyKey: "pi-fixture-flow",
      }),
    ).resolves.toMatchObject({
      providerMode: "fixture",
      auditRunId: ids.audit,
      auditArtifactId: ids.artifact,
      publicationRequestId: ids.publication,
    });
    expect(publications).toHaveLength(1);
    expect(publications[0]?.executionLevel).toBe("dry_run");
    expect(scopeToolNames).not.toContain("plastic_context_supply");
    expect(scopeToolNames.every((toolName) => toolName.startsWith("geo_"))).toBe(true);
    expect(governanceCalls.find((call) => call.name === "context_supply")?.arguments).toMatchObject(
      {
        project_id: `project:geo-saas:tenant:${ids.tenant}`,
        project_policy: "strict",
        retrieval_mode: "project",
      },
    );
  });

  it("rejects a fixture run that crosses the authenticated tenant", async () => {
    const service = new FixturePiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      model: "fixture-geo-writer-v1",
    });
    await expect(
      service.run(principal, {
        workflow: "draft_to_publication",
        tenantId: "20000000-0000-4000-8000-000000000001",
        brandId: ids.brand,
        campaignId: ids.campaign,
        channelAccountId: ids.account,
        platform: "toutiao",
        topic: "cross tenant",
        idempotencyKey: "cross-tenant",
      }),
    ).rejects.toThrow("tenant does not match");
  });

  it("uses the real Pi Agent loop when a provider model is configured", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([fauxAssistantMessage("已完成租户范围内的证据审阅。")]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    await expect(
      service.run(principal, { workflow: "prompt", prompt: "检查当前证据" }),
    ).resolves.toMatchObject({
      providerMode: "pi",
      provider: "geo-pi-test",
      response: "已完成租户范围内的证据审阅。",
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("fails the run without exposing a Pi provider error as a successful empty response", async () => {
    const faux = registerFauxProvider({ provider: "geo-pi-error-test" });
    fauxRegistrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Authorization: Bearer provider-secret",
      }),
    ]);
    const service = new RealPiAgentRunService({
      api: fakeApi(),
      governance: governance(),
      provider: "geo-pi-error-test",
      model: faux.getModel() as unknown as Model<Api>,
      modelId: faux.getModel().id,
      apiKey: "test-key",
    });

    let captured: unknown;
    try {
      await service.run(principal, { workflow: "prompt", prompt: "Review evidence" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PiAgentRunError);
    expect(captured).toMatchObject({ code: "AGENT_PROVIDER_FAILED", statusCode: 502 });
    expect((captured as Error).message).not.toContain("provider-secret");
  });
});
