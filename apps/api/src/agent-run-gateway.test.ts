import { describe, expect, it, vi } from "vitest";

import {
  AgentRunGatewayError,
  HttpAgentRunGateway,
  parseAgentGatewayCredentials,
  validateAgentGatewayUrl,
} from "./agent-run-gateway.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const token = "agent-gateway-test-token-with-more-than-32-bytes";
const request = {
  tenantId,
  actorId: "10000000-0000-4000-8000-000000000002",
  requestId: "request-1",
  brandId: "10000000-0000-4000-8000-000000000003",
  campaignId: "10000000-0000-4000-8000-000000000004",
  channelAccountId: "10000000-0000-4000-8000-000000000005",
  platform: "toutiao" as const,
  topic: "中通国际旅行社日本线路证据核验",
  articleTemplateId: "step-by-step-guide",
  idempotencyKey: "agent-run-1",
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function health(mode: "fixture" | "pi" = "fixture"): Response {
  return jsonResponse({
    status: "ok",
    service: "geo-agent-mcp",
    agent: {
      mode,
      provider: mode === "fixture" ? "fixture" : "openai",
      model: mode === "fixture" ? "fixture-geo-writer-v1" : "gpt-5",
    },
  });
}

describe("HttpAgentRunGateway", () => {
  it("rejects unsafe destinations and duplicate tenant credentials", () => {
    expect(() => validateAgentGatewayUrl("http://agent.example.test:9021")).toThrow(/HTTPS/iu);
    expect(() =>
      parseAgentGatewayCredentials(
        JSON.stringify([
          { tenantId, accessToken: token },
          { tenantId, accessToken: `${token}-other` },
        ]),
      ),
    ).toThrow(/unique/iu);
  });

  it("reports an unconfigured tenant without contacting the runner", async () => {
    const fetchImpl = vi.fn();
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [],
      fetchImpl,
    });

    await expect(gateway.getCapability(tenantId)).resolves.toEqual({
      available: false,
      mode: "disabled",
      provider: null,
      model: null,
      reason: "tenant_not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("selects only the current tenant bearer and forwards the selected template in fixture mode", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/health/live")) return health();
      return jsonResponse({
        capability: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
        result: {
          providerMode: "fixture",
          contentItemId: "10000000-0000-4000-8000-000000000006",
        },
      });
    });
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [
        { tenantId, accessToken: token },
        {
          tenantId: "20000000-0000-4000-8000-000000000001",
          accessToken: "other-tenant-agent-token-with-more-than-32-bytes",
        },
      ],
      fetchImpl,
    });

    await expect(gateway.run(request)).resolves.toMatchObject({
      capability: { mode: "fixture" },
      result: { providerMode: "fixture" },
    });
    const runCall = calls[1];
    expect(new Headers(runCall?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(runCall?.init?.body))).toMatchObject({
      workflow: "draft_to_publication",
      tenantId,
      articleTemplateId: "step-by-step-guide",
      topic: request.topic,
    });
  });

  it("builds a bounded governed prompt for a real Pi runner", async () => {
    const runBodies: Readonly<Record<string, unknown>>[] = [];
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/health/live")) return health("pi");
        runBodies.push(JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>);
        return jsonResponse({
          capability: { mode: "pi", provider: "openai", model: "gpt-5" },
          result: { providerMode: "pi", response: "completed", messageCount: 8 },
        });
      },
    });

    await gateway.run(request);
    const runBody = runBodies[0];
    expect(runBody).toMatchObject({ workflow: "prompt", brandId: request.brandId });
    expect(String(runBody?.prompt)).toContain("Article template ID: step-by-step-guide");
    expect(String(runBody?.prompt)).toContain(
      `<article_brief>\n${request.topic}\n</article_brief>`,
    );
    expect(String(runBody?.prompt)).toContain("dry_run only");
  });

  it("sanitizes upstream authentication errors and rejects oversized responses", async () => {
    const authGateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async (input) =>
        String(input).endsWith("/health/live")
          ? health()
          : jsonResponse({ error: { message: `leaked ${token}` } }, 401),
    });
    const authError = await authGateway.run(request).catch((error: unknown) => error);
    expect(authError).toBeInstanceOf(AgentRunGatewayError);
    expect(authError).toMatchObject({ statusCode: 503, code: "AGENT_GATEWAY_AUTH_FAILED" });
    expect(String(authError)).not.toContain(token);

    const sizeGateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async (input) =>
        String(input).endsWith("/health/live")
          ? health()
          : jsonResponse({}, 200, { "content-length": String(3 * 1024 * 1024) }),
    });
    await expect(sizeGateway.run(request)).rejects.toMatchObject({
      code: "AGENT_GATEWAY_RESPONSE_TOO_LARGE",
    });
  });

  it("reports its own run deadline as a timeout", async () => {
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async (input) => {
        if (String(input).endsWith("/health/live")) return health();
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    });

    await expect(gateway.run(request)).rejects.toMatchObject({
      statusCode: 504,
      code: "AGENT_RUN_TIMEOUT",
    });
  });
});
