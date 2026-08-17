import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";

import { createPiAgentTools, PI_TOOL_SCHEMAS } from "./pi-tools.js";
import type { GovernedAgentRuntime } from "./runtime.js";

function failingRuntime(error: unknown): GovernedAgentRuntime {
  return {
    invoke: async () => {
      throw error;
    },
  } as unknown as GovernedAgentRuntime;
}

function successfulRuntime(result: unknown): GovernedAgentRuntime {
  return {
    invoke: async () => result,
  } as unknown as GovernedAgentRuntime;
}

function validDraftProposalArgs(): Record<string, unknown> {
  const claimId = "00000000-0000-4000-8000-000000000004";
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    brandId: "00000000-0000-4000-8000-000000000002",
    campaignId: "00000000-0000-4000-8000-000000000003",
    brief: "private brief",
    targetPlatform: "ctrip_community",
    idempotencyKey: "private-idempotency-key",
    authoredDraft: {
      title: "青岛家庭出境游",
      titleClaimIds: [claimId],
      summary: "先看服务边界，再选择适合家庭的出境游方案。",
      summaryClaimIds: [claimId],
      locationQuery: "青岛",
      body: [{ text: "## 行前选择\n先确认服务边界。", claimIds: [claimId] }],
      mediaSearchPlan: [
        { query: "青岛 海岸", role: "cover", rationale: "封面海岸场景", claimIds: [claimId] },
        { query: "青岛 机场", role: "inline", rationale: "出发交通场景", claimIds: [claimId] },
        { query: "青岛 街区", role: "inline", rationale: "城市街区场景", claimIds: [claimId] },
        { query: "青岛 公园", role: "inline", rationale: "家庭活动场景", claimIds: [claimId] },
      ],
    },
  };
}

describe("Pi tool diagnostics", () => {
  it("projects provider-visible tool content without discarding internal details", async () => {
    const fullResult = {
      facts: [{ id: "fact-1", claim: "完整事实原文" }],
      evidence: [{ id: "source-1", privateExcerpt: "large internal material" }],
    };
    const tool = createPiAgentTools(successfulRuntime(fullResult), {
      projectResult: (_toolName, result) => ({
        facts: (result as typeof fullResult).facts,
      }),
    }).find((candidate) => candidate.name === "geo_fact_lookup");

    const result = await tool?.execute("tool-call-projection", {
      tenantId: "00000000-0000-4000-8000-000000000001",
      brandId: "00000000-0000-4000-8000-000000000002",
      query: "合同",
    });

    expect(result?.content).toEqual([
      { type: "text", text: JSON.stringify({ facts: fullResult.facts }) },
    ]);
    expect(result?.details).toBe(fullResult);
  });

  it("checks the task workflow before MCP execution and reminds the next step", async () => {
    const events: string[] = [];
    let nextTool: "geo_draft_proposal" | null = "geo_draft_proposal";
    const tool = createPiAgentTools(successfulRuntime({ facts: [] }), {
      workflowGuard: {
        taskId: "task-test-1",
        beforeToolCall: (toolName, toolCallId) => {
          events.push(`before:${toolName}:${toolCallId}`);
        },
        afterToolCall: (toolName, toolCallId, succeeded) => {
          events.push(`after:${toolName}:${toolCallId}:${succeeded}`);
        },
        nextToolName: () => nextTool,
      },
    }).find((candidate) => candidate.name === "geo_fact_lookup");

    const result = await tool?.execute("task-tool-1", {
      tenantId: "00000000-0000-4000-8000-000000000001",
      brandId: "00000000-0000-4000-8000-000000000002",
      query: "合同",
    });

    expect(events).toEqual([
      "before:geo_fact_lookup:task-tool-1",
      "after:geo_fact_lookup:task-tool-1:true",
    ]);
    expect(result?.content).toEqual([
      { type: "text", text: JSON.stringify({ facts: [] }) },
      { type: "text", text: "WORKFLOW_NEXT_STEP task=task-test-1 tool=geo_draft_proposal" },
    ]);
    nextTool = null;
  });

  it("requires authored prose and exposes no fixture switch to real Pi", () => {
    const schema = PI_TOOL_SCHEMAS.geo_draft_proposal as unknown as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(schema.required).toContain("authoredDraft");
    expect(schema.properties).not.toHaveProperty("fixtureMode");
  });

  it("reports exact unknown JSON property paths before SDK schema validation", () => {
    const tool = createPiAgentTools(failingRuntime(new Error("unused"))).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );
    if (tool?.prepareArguments === undefined) {
      throw new Error("geo_draft_proposal must preflight raw JSON arguments");
    }
    const valid = validDraftProposalArgs();
    const authoredDraft = valid.authoredDraft as Record<string, unknown>;
    const body = authoredDraft.body as Array<Record<string, unknown>>;

    expect(() =>
      tool.prepareArguments?.({
        ...valid,
        privateRootValue: "must-not-leak",
        authoredDraft: {
          ...authoredDraft,
          privateDraftValue: "must-not-leak",
          body: [{ ...body[0], heading: "must-not-leak" }],
        },
      }),
    ).toThrow(
      "Unknown tool argument properties: privateRootValue, authoredDraft.privateDraftValue, authoredDraft.body[0].heading",
    );
  });

  it("returns valid JSON arguments unchanged", () => {
    const tool = createPiAgentTools(failingRuntime(new Error("unused"))).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );
    if (tool?.prepareArguments === undefined) {
      throw new Error("geo_draft_proposal must preflight raw JSON arguments");
    }
    const valid = validDraftProposalArgs();

    expect(tool.prepareArguments(valid)).toBe(valid);
  });

  it("moves a provider-authored root locationQuery into authoredDraft", () => {
    const tool = createPiAgentTools(failingRuntime(new Error("unused"))).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );
    if (tool?.prepareArguments === undefined) {
      throw new Error("geo_draft_proposal must preflight raw JSON arguments");
    }
    const valid = validDraftProposalArgs();
    const authoredDraft = valid.authoredDraft as Record<string, unknown>;
    const draftWithoutLocation = { ...authoredDraft };
    delete draftWithoutLocation.locationQuery;

    expect(
      tool.prepareArguments({
        ...valid,
        locationQuery: "青岛",
        authoredDraft: draftWithoutLocation,
      }),
    ).toEqual({
      ...valid,
      authoredDraft: {
        ...draftWithoutLocation,
        locationQuery: "青岛",
      },
    });
  });

  it("deduplicates a matching root locationQuery and rejects conflicting values", () => {
    const tool = createPiAgentTools(failingRuntime(new Error("unused"))).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );
    if (tool?.prepareArguments === undefined) {
      throw new Error("geo_draft_proposal must preflight raw JSON arguments");
    }
    const valid = validDraftProposalArgs();

    expect(tool.prepareArguments({ ...valid, locationQuery: "青岛" })).toEqual(valid);
    expect(() => tool.prepareArguments?.({ ...valid, locationQuery: "上海" })).toThrow(
      "Conflicting tool argument properties: locationQuery, authoredDraft.locationQuery",
    );
  });

  it("accepts an authored draft with no supporting fact IDs", () => {
    const args = validDraftProposalArgs();
    const draft = args.authoredDraft as Record<string, unknown>;
    const body = draft.body as Array<Record<string, unknown>>;
    const mediaSearchPlan = draft.mediaSearchPlan as Array<Record<string, unknown>>;

    expect(
      Value.Check(PI_TOOL_SCHEMAS.geo_draft_proposal, {
        ...args,
        authoredDraft: {
          ...draft,
          titleClaimIds: [],
          summaryClaimIds: [],
          body: body.map((section) => ({ ...section, claimIds: [] })),
          mediaSearchPlan: mediaSearchPlan.map((intent) => ({ ...intent, claimIds: [] })),
        },
      }),
    ).toBe(true);
  });

  it("publishes a media production schema that allows no fact bindings", () => {
    expect(
      Value.Check(PI_TOOL_SCHEMAS.geo_media_production_request, {
        tenantId: "00000000-0000-4000-8000-000000000001",
        contentVersionId: "00000000-0000-4000-8000-000000000002",
        platform: "ctrip_community",
        role: "cover",
        claimIds: [],
        idempotencyKey: "media-without-facts",
      }),
    ).toBe(true);
  });

  it("requires the target platform for licensed media search", () => {
    const input = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      contentVersionId: "00000000-0000-4000-8000-000000000002",
      platform: "toutiao",
      idempotencyKey: "media-search-platform",
    };
    expect(Value.Check(PI_TOOL_SCHEMAS.geo_media_search_import, input)).toBe(true);
    const withoutPlatform = { ...input } as Partial<typeof input>;
    delete withoutPlatform.platform;
    expect(Value.Check(PI_TOOL_SCHEMAS.geo_media_search_import, withoutPlatform)).toBe(false);
  });

  it("returns an actionable safe correction for a missing Ctrip media plan", async () => {
    const error = Object.assign(new Error("private rejected draft"), {
      name: "GeoApiRequestError",
      code: "AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED",
      status: 422,
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createPiAgentTools(failingRuntime(error)).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );

    await expect(
      tool?.execute("tool-call-media-plan", {
        tenantId: "00000000-0000-4000-8000-000000000001",
        brandId: "00000000-0000-4000-8000-000000000002",
        campaignId: "00000000-0000-4000-8000-000000000003",
        brief: "private brief",
        idempotencyKey: "private-idempotency-key",
      }),
    ).rejects.toThrow(
      "Correctable draft error: AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED. Add authoredDraft.mediaSearchPlan with exactly four distinct intents: one cover and three inline images. Every intent must include a distinct query, sectionRef, fallbackQueries (up to three alternatives), retryBudget (1-3), role, rationale, and claimIds. Keep media claimIds empty unless the exact verified claim text appears in the referenced article section. Reuse only claim IDs already present in authoredDraft, then retry geo_draft_proposal with the complete authoredDraft object.",
    );

    errorLog.mockRestore();
  });

  it("returns an actionable safe correction for a paraphrased fact", async () => {
    const error = Object.assign(new Error("private rejected draft"), {
      name: "GeoApiRequestError",
      code: "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
      status: 422,
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = createPiAgentTools(failingRuntime(error)).find(
      (candidate) => candidate.name === "geo_draft_proposal",
    );

    await expect(
      tool?.execute("tool-call-fact-text", {
        tenantId: "00000000-0000-4000-8000-000000000001",
        brandId: "00000000-0000-4000-8000-000000000002",
        campaignId: "00000000-0000-4000-8000-000000000003",
        brief: "private brief",
        idempotencyKey: "private-idempotency-key",
      }),
    ).rejects.toThrow(
      "Correctable draft error: AUTHORED_DRAFT_FACT_TEXT_REQUIRED. Reopen the latest geo_fact_lookup result and compare every referenced ID. Remove every claim ID whose complete claim sentence is not present character-for-character in title, summary, or body; mediaSearchPlan claimIds should normally be empty. Keep at most one relevant fact ID on the body section that contains its exact claim sentence, then retry geo_draft_proposal with the complete authoredDraft object.",
    );

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
