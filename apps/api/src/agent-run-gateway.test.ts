import { createServer } from "node:http";

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
  topic: "示例国际旅行服务日本线路证据核验",
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
  it("uses the native HTTP run transport when no fetch override is configured", async () => {
    const received: Array<{
      readonly authorization: string | undefined;
      readonly contentLength: string | undefined;
      readonly transferEncoding: string | undefined;
    }> = [];
    const server = createServer((incoming, response) => {
      if (incoming.url === "/health/live") {
        const payload = JSON.stringify({
          status: "ok",
          service: "geo-agent-mcp",
          agent: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        response.end(payload);
        return;
      }
      received.push({
        authorization: incoming.headers.authorization,
        contentLength: incoming.headers["content-length"],
        transferEncoding: incoming.headers["transfer-encoding"],
      });
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        setTimeout(() => {
          const payload = JSON.stringify({
            capability: {
              mode: "fixture",
              provider: "fixture",
              model: "fixture-geo-writer-v1",
            },
            result: { providerMode: "fixture", input },
          });
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          response.end(payload);
        }, 25);
      });
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server has no port");
    try {
      const gateway = new HttpAgentRunGateway({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: [{ tenantId, accessToken: token }],
        healthTimeoutMs: 1_000,
        runTimeoutMs: 1_000,
      });

      await expect(gateway.run(request)).resolves.toMatchObject({
        capability: { mode: "fixture" },
        result: { providerMode: "fixture" },
      });
      expect(received).toEqual([
        {
          authorization: `Bearer ${token}`,
          contentLength: expect.stringMatching(/^[1-9][0-9]*$/u),
          transferEncoding: undefined,
        },
      ]);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    }
  });

  it("applies the run deadline while the native transport waits for response headers", async () => {
    const server = createServer((incoming, response) => {
      if (incoming.url === "/health/live") {
        response.end(
          JSON.stringify({
            status: "ok",
            service: "geo-agent-mcp",
            agent: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
          }),
        );
        return;
      }
      incoming.resume();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server has no port");
    try {
      const gateway = new HttpAgentRunGateway({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: [{ tenantId, accessToken: token }],
        healthTimeoutMs: 1_000,
        runTimeoutMs: 25,
      });

      await expect(gateway.run(request)).rejects.toMatchObject({
        statusCode: 504,
        code: "AGENT_RUN_TIMEOUT",
      });
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    }
  });

  it("settles when the native transport receives a truncated response", async () => {
    const server = createServer((incoming, response) => {
      if (incoming.url === "/health/live") {
        response.end(
          JSON.stringify({
            status: "ok",
            service: "geo-agent-mcp",
            agent: { mode: "fixture", provider: "fixture", model: "fixture-geo-writer-v1" },
          }),
        );
        return;
      }
      incoming.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1024",
      });
      response.flushHeaders();
      response.write('{"capability":');
      setImmediate(() => response.destroy());
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server has no port");
    try {
      const gateway = new HttpAgentRunGateway({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentials: [{ tenantId, accessToken: token }],
        healthTimeoutMs: 1_000,
        runTimeoutMs: 1_000,
      });

      await expect(gateway.run(request)).rejects.toMatchObject({
        statusCode: 503,
        code: "AGENT_GATEWAY_UNAVAILABLE",
      });
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      );
    }
  });

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
    expect(new Headers(runCall?.init?.headers).get("x-geo-request-id")).toBe(request.requestId);
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
    await gateway.run({
      ...request,
      platform: "ctrip_community",
      idempotencyKey: "agent-run-ctrip-assisted",
    });
    const dryRunBody = runBodies[0];
    const assistedBody = runBodies[1];
    expect(dryRunBody).toMatchObject({
      workflow: "prompt",
      requiredWorkflow: "draft_to_publication",
      brandId: request.brandId,
      draftScope: {
        tenantId: request.tenantId,
        brandId: request.brandId,
        campaignId: request.campaignId,
        targetPlatform: request.platform,
        brief: request.topic,
        articleTemplateId: request.articleTemplateId,
        idempotencyKey: request.idempotencyKey,
      },
    });
    expect(String(dryRunBody?.prompt)).toContain("Article template ID: step-by-step-guide");
    expect(String(dryRunBody?.prompt)).toContain(`Authenticated tenant ID: ${request.tenantId}`);
    expect(String(dryRunBody?.prompt)).toContain(
      "Templates are structural GEO constraints, not article prose",
    );
    expect(String(dryRunBody?.prompt)).toContain("at least two substantive `##` section headings");
    expect(String(dryRunBody?.prompt)).toContain(
      "Every body[].text entry must be one distinct section",
    );
    expect(String(dryRunBody?.prompt)).toContain("geo_draft_proposal.authoredDraft");
    expect(String(dryRunBody?.prompt)).toContain(
      "Never invent, inflate, or imply unsupported ratings",
    );
    expect(String(dryRunBody?.prompt)).toContain(
      `<article_brief>\n${request.topic}\n</article_brief>`,
    );
    expect(String(dryRunBody?.prompt)).toContain("Execution level: dry_run");
    expect(String(dryRunBody?.prompt)).toContain(
      "Platform contract for Toutiao: produce a mobile-first answer variant",
    );
    expect(String(assistedBody?.prompt)).toContain("Execution level: assisted");
    expect(String(assistedBody?.prompt)).toContain(
      "Platform contract for Ctrip Community: produce a personal travel-decision variant",
    );
    expect(String(dryRunBody?.prompt)).toContain("Do not call geo_media_production_request");
    expect(String(assistedBody?.prompt)).toContain("Do not call geo_media_production_request");
    expect(String(assistedBody?.prompt)).toContain("geo_media_search_import exactly once");
    expect(assistedBody).toMatchObject({
      targetPlatform: "ctrip_community",
      draftScope: { targetPlatform: "ctrip_community" },
    });
    expect(String(assistedBody?.prompt)).toContain(
      "targetPlatform to ctrip_community so the source version excludes tenant contact blocks",
    );
    expect(String(assistedBody?.prompt)).toContain("authoredDraft.mediaSearchPlan");
    expect(String(assistedBody?.prompt)).toContain("one cover and three inline");
    expect(String(assistedBody?.prompt)).toContain("exact selected brand displayName 1 to 3 times");
    expect(String(assistedBody?.prompt)).toContain(
      "keep the selected brand out of the title and summary",
    );
    expect(String(assistedBody?.prompt)).toContain("connect the brand to the reader's scenario");
    expect(String(assistedBody?.prompt)).toContain("footer-only attribution is insufficient");
    expect(String(assistedBody?.prompt)).toContain(
      "never state or imply that the brand organized, wrote, prepared, published, verified, or endorsed",
    );
    expect(String(assistedBody?.prompt)).toContain("supplied the article's service experience");
    expect(String(assistedBody?.prompt)).toContain("Omit any unsupported operational role");
    expect(String(assistedBody?.prompt)).not.toContain(
      "as the content organizer, source of service experience, or verification helper",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "must never mention GEO, Pi, agents, prompts, tools, tool names, fact IDs, audits, providers, models, retrieval, system responses",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "Express an evidence limitation in reader-facing language",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "never write that GEO or a tool did not return information",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "zero phone numbers, WeChat terms or IDs, email addresses, websites, external links, QR codes",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "even when they match an approved tenant contact",
    );
    expect(String(assistedBody?.prompt)).toContain("low-pressure on-page next step");
    expect(String(assistedBody?.prompt)).toContain("never use a hard-sell call to action");
    expect(String(assistedBody?.prompt)).toContain(
      "geo_variant_preview using the returned finalContentVersionId",
    );
    expect(String(assistedBody?.prompt)).toContain("geo_publication_request exactly once");
    expect(String(assistedBody?.prompt)).toContain("Never request or issue a submit permit");
    expect(String(assistedBody?.prompt)).not.toContain("asset.contentVersionId");
    expect(String(dryRunBody?.prompt)).toContain("never downgrade or bypass a rejected gate");
    expect(String(assistedBody?.prompt)).toContain(
      "may create one governed assisted publication request",
    );
    expect(String(assistedBody?.prompt)).toContain(
      "final submit remains a separate one-time operator-permit step",
    );
    expect(String(assistedBody?.prompt)).toContain("reviewed Bridge adapter");
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

  it("preserves the controlled tool-guard diagnostic from the runner", async () => {
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async (input) =>
        String(input).endsWith("/health/live")
          ? health("pi")
          : jsonResponse(
              {
                error: {
                  code: "AGENT_TOOL_GUARD_FAILED",
                  message: "Agent tool workflow failed",
                  detail: token,
                },
              },
              502,
            ),
    });

    const error = await gateway.run(request).catch((value: unknown) => value);
    expect(error).toMatchObject({
      statusCode: 502,
      code: "AGENT_TOOL_GUARD_FAILED",
      message: "Agent tool workflow failed",
    });
    expect(String(error)).not.toContain(token);
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

  it("applies the run deadline while reading a stalled response body", async () => {
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      runTimeoutMs: 25,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/health/live")) return health();
        return new Response(new ReadableStream({ start: () => undefined }), {
          status: 504,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(gateway.run(request)).rejects.toMatchObject({
      statusCode: 504,
      code: "AGENT_RUN_TIMEOUT",
    });
  });

  it("cancels a stalled run when the API caller disconnects", async () => {
    const gateway = new HttpAgentRunGateway({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      runTimeoutMs: 60_000,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/health/live")) return health();
        return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
      },
    });
    const controller = new AbortController();
    const run = gateway.run(request, controller.signal);
    controller.abort();

    await expect(run).rejects.toMatchObject({
      statusCode: 499,
      code: "AGENT_RUN_CANCELLED",
    });
  });
});
