import type { ActorContext } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import { FixtureDraftingRuntime } from "./fixture-runtime.js";
import {
  GovernanceToolError,
  PlasticPromiseGovernanceClient,
  type McpToolCaller,
} from "./governance.js";
import { AGENT_TOOL_ALLOWLIST, AGENT_TOOL_POLICIES, authorizeAgentToolCall } from "./policy.js";
import { redactSensitiveDetails } from "./redaction.js";
import { GovernedAgentRuntime, type GeoApplicationToolInvoker } from "./runtime.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const brandId = "00000000-0000-4000-8000-000000000003";
const campaignId = "00000000-0000-4000-8000-000000000004";
const accountId = "00000000-0000-4000-8000-000000000005";
const contentItemId = "00000000-0000-4000-8000-000000000010";
const contentVersionId = "00000000-0000-4000-8000-000000000006";
const variantId = "00000000-0000-4000-8000-000000000007";
const auditRunId = "00000000-0000-4000-8000-000000000008";
const auditArtifactId = "00000000-0000-4000-8000-000000000012";
const publicationRequestId = "00000000-0000-4000-8000-000000000009";
const outboxEventId = "00000000-0000-4000-8000-000000000011";

const principal: ActorContext = {
  actorId,
  tenantId,
  role: "owner",
  capabilities: [
    "tenant:read",
    "content:read",
    "content:write",
    "audit:run",
    "publish:request",
    "visibility:run",
  ],
  requestId: "agent-test",
};

describe("static agent policy", () => {
  it("does not expose grants, connectors, browsers, arbitrary HTTP, files, or shell", () => {
    const names = AGENT_TOOL_ALLOWLIST.join(" ");
    expect(names).not.toMatch(/grant|connector|browser|fetch|http|file|shell|bash/i);
    expect(AGENT_TOOL_ALLOWLIST).toContain("geo_publication_request");
  });

  it("checks principal tenant, capability, and resource scope before a tool call", async () => {
    let scopeChecks = 0;
    await expect(
      authorizeAgentToolCall({
        principal,
        toolName: "geo_fact_lookup",
        args: { tenantId, brandId, query: "travel" },
        authorizeResourceScope: () => {
          scopeChecks += 1;
          return true;
        },
      }),
    ).resolves.toMatchObject({ toolName: "geo_fact_lookup" });
    expect(scopeChecks).toBe(1);

    await expect(
      authorizeAgentToolCall({
        principal,
        toolName: "geo_fact_lookup",
        args: { tenantId: "00000000-0000-4000-8000-000000000099", brandId },
        authorizeResourceScope: () => true,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });

    await expect(
      authorizeAgentToolCall({
        principal,
        toolName: "browser_publish",
        args: { tenantId },
        authorizeResourceScope: () => true,
      }),
    ).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWLISTED" });
  });

  it("marks every state-changing and governance tool sequential", () => {
    for (const policy of Object.values(AGENT_TOOL_POLICIES)) {
      if (policy.stateChanging) {
        expect(policy.sequential).toBe(true);
      }
    }
    expect(AGENT_TOOL_POLICIES.plastic_context_supply.sequential).toBe(true);
    expect(AGENT_TOOL_POLICIES.plastic_audit_pre_check.sequential).toBe(true);
    expect(AGENT_TOOL_POLICIES.plastic_defense.sequential).toBe(true);
  });
});

describe("Plastic Promise bridge", () => {
  it("turns MCP isError into a failure and redacts secret details", async () => {
    const caller: McpToolCaller = {
      callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: "Bearer live-secret token=abc123" }],
        structuredContent: { authorization: "Bearer live-secret", safe: "visible" },
      }),
    };
    const client = new PlasticPromiseGovernanceClient(caller);

    let captured: unknown;
    try {
      await client.contextSupply({ task_description: "test" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(GovernanceToolError);
    expect(JSON.stringify((captured as GovernanceToolError).details)).not.toContain("live-secret");
    expect(JSON.stringify((captured as GovernanceToolError).details)).not.toContain("abc123");
  });

  it("denies an arbitrary MCP tool without calling the transport", async () => {
    let calls = 0;
    const client = new PlasticPromiseGovernanceClient({
      callTool: async () => {
        calls += 1;
        return {};
      },
    });
    await expect(client.call("memory_store", {})).rejects.toBeInstanceOf(GovernanceToolError);
    expect(calls).toBe(0);
  });

  it("redacts transport exceptions before exposing a governance failure", async () => {
    const client = new PlasticPromiseGovernanceClient({
      callTool: async () => {
        throw new Error("request failed Authorization: Bearer transport-secret");
      },
    });
    let captured: unknown;
    try {
      await client.defense({ action: "get" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(GovernanceToolError);
    expect(JSON.stringify((captured as GovernanceToolError).details)).not.toContain(
      "transport-secret",
    );
  });

  it("redacts nested keys and secret-like string values", () => {
    const redacted = redactSensitiveDetails({
      token: "raw-token",
      nested: { cookie: "raw-cookie", note: "Authorization: Bearer abc.def" },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("raw-cookie");
    expect(serialized).not.toContain("abc.def");
  });
});

describe("fixture drafting runtime", () => {
  it("runs the governed draft-to-publication-request flow without privileged tools", async () => {
    const called: string[] = [];
    const calledArgs = new Map<string, Readonly<Record<string, unknown>>>();
    const geo: GeoApplicationToolInvoker = {
      invoke: async (name, args) => {
        called.push(name);
        calledArgs.set(name, args);
        if (name === "geo_draft_proposal") return { contentItemId, contentVersionId };
        if (name === "geo_variant_preview") return { variantId };
        if (name === "geo_audit_request") {
          return {
            auditRunId,
            auditArtifactId,
            status: "passed",
            eligibleForPublicationRequest: false,
          };
        }
        if (name === "geo_publication_request") {
          return {
            publicationRequestId,
            publicationJobId: publicationRequestId,
            outboxEventId,
          };
        }
        return { ok: true };
      },
    };
    const governanceCalls: string[] = [];
    const governance = new PlasticPromiseGovernanceClient({
      callTool: async ({ name }) => {
        governanceCalls.push(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                name === "audit_pre_check"
                  ? { passed: true }
                  : name === "defense"
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
    const runtime = new GovernedAgentRuntime({
      principal,
      geo,
      governance,
      authorizeResourceScope: () => true,
    });

    const result = await new FixtureDraftingRuntime(runtime).run({
      tenantId,
      brandId,
      campaignId,
      channelAccountId: accountId,
      platform: "toutiao",
      topic: "Shanghai weekend travel",
      idempotencyKey: "fixture-flow-1",
      executionLevel: "dry_run",
    });

    expect(result).toMatchObject({
      providerMode: "fixture",
      contentItemId,
      contentVersionId,
      variantId,
      auditRunId,
      auditArtifactId,
      publicationRequestId,
      publicationJobId: publicationRequestId,
      outboxEventId,
    });
    expect(governanceCalls).toEqual(["context_supply", "audit_pre_check", "defense"]);
    expect(called).toEqual([
      "geo_tenant_context",
      "geo_fact_lookup",
      "geo_draft_proposal",
      "geo_variant_preview",
      "geo_audit_request",
      "geo_publication_request",
    ]);
    expect(calledArgs.get("geo_draft_proposal")).toMatchObject({
      brief: "Shanghai weekend travel",
      idempotencyKey: "fixture-flow-1:draft",
    });
    expect([...governanceCalls, ...called].join(" ")).not.toMatch(/grant|connector|browser/);
  });

  it("automatically fails closed before a direct publication tool call", async () => {
    let geoCalls = 0;
    const governance = new PlasticPromiseGovernanceClient({
      callTool: async ({ name }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              name === "audit_pre_check" ? { passed: true } : { decision: "deny" },
            ),
          },
        ],
      }),
    });
    const runtime = new GovernedAgentRuntime({
      principal,
      geo: {
        invoke: async () => {
          geoCalls += 1;
          return { ok: true };
        },
      },
      governance,
      authorizeResourceScope: () => true,
    });

    await expect(
      runtime.invoke("geo_publication_request", {
        tenantId,
        variantId,
        channelAccountId: accountId,
        executionLevel: "dry_run",
        idempotencyKey: "direct-publication",
      }),
    ).rejects.toThrow("Publication governance denied");
    expect(geoCalls).toBe(0);
  });

  it("serializes concurrent state-changing calls", async () => {
    let active = 0;
    let maximumActive = 0;
    const geo: GeoApplicationToolInvoker = {
      invoke: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true };
      },
    };
    const runtime = new GovernedAgentRuntime({
      principal,
      geo,
      governance: new PlasticPromiseGovernanceClient({ callTool: async () => ({}) }),
      authorizeResourceScope: () => true,
    });
    const args = {
      tenantId,
      brandId,
      campaignId,
      brief: "test",
      idempotencyKey: "concurrent-draft",
    };
    await Promise.all([
      runtime.invoke("geo_draft_proposal", args),
      runtime.invoke("geo_draft_proposal", args),
    ]);
    expect(maximumActive).toBe(1);
  });
});
