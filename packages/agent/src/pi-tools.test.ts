import { describe, expect, it, vi } from "vitest";

import { createPiAgentTools } from "./pi-tools.js";
import type { GovernedAgentRuntime } from "./runtime.js";

function failingRuntime(error: unknown): GovernedAgentRuntime {
  return {
    invoke: async () => {
      throw error;
    },
  } as unknown as GovernedAgentRuntime;
}

describe("Pi tool diagnostics", () => {
  it("logs only safe public metadata when a tool fails", async () => {
    const error = Object.assign(
      new Error("Authorization: Bearer provider-secret; rejected article prose"),
      {
        name: "GeoApiRequestError",
        code: "AUTHORED_DRAFT_FACT_UNSUPPORTED",
        status: 422,
        response: { article: "private article prose", apiKey: "private-key" },
      },
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createPiAgentTools(failingRuntime(error)).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );
    expect(tool).toBeDefined();

    await expect(
      tool?.execute("tool-call-1", {
        tenantId: "00000000-0000-4000-8000-000000000001",
        brandId: "00000000-0000-4000-8000-000000000002",
        campaignId: "00000000-0000-4000-8000-000000000003",
        brief: "private brief",
        idempotencyKey: "private-idempotency-key",
      }),
    ).rejects.toThrow("Upstream operation failed");

    expect(errorLog).toHaveBeenCalledTimes(1);
    const serialized = String(errorLog.mock.calls[0]?.[0]);
    expect(JSON.parse(serialized)).toEqual({
      level: "error",
      event: "pi_agent.tool_failed",
      toolName: "geo_draft_proposal",
      errorType: "GeoApiRequestError",
      errorCode: "AUTHORED_DRAFT_FACT_UNSUPPORTED",
      statusCode: 422,
    });
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("private article prose");
    expect(serialized).not.toContain("private brief");
    expect(serialized).not.toContain("private-idempotency-key");
    errorLog.mockRestore();
  });

  it("omits attacker-controlled diagnostic fields", async () => {
    const error = Object.assign(new Error("private failure"), {
      name: "Bad Type with spaces",
      code: "INVALID CODE private prose",
      status: "422 private prose",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createPiAgentTools(failingRuntime(error)).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );

    await expect(
      tool?.execute("tool-call-2", {
        tenantId: "00000000-0000-4000-8000-000000000001",
        brandId: "00000000-0000-4000-8000-000000000002",
        campaignId: "00000000-0000-4000-8000-000000000003",
        brief: "private brief",
        idempotencyKey: "private-idempotency-key",
      }),
    ).rejects.toThrow("Upstream operation failed");

    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toEqual({
      level: "error",
      event: "pi_agent.tool_failed",
      toolName: "geo_draft_proposal",
      errorType: "UnknownError",
    });
    errorLog.mockRestore();
  });
});
