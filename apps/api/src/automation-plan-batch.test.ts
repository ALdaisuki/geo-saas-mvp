import { describe, expect, it } from "vitest";

import type { DueCampaignAutomationPlanView } from "./automation-repository.js";
import {
  buildAutomationPlanBatchInput,
  nextCampaignAutomationRunAt,
} from "./automation-plan-batch.js";

const plan: DueCampaignAutomationPlanView = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  planId: "10000000-0000-4000-8000-000000000901",
  campaignId: "10000000-0000-4000-8000-000000001001",
  actorId: "10000000-0000-4000-8000-000000000101",
  executionLevel: "unattended",
  platforms: ["toutiao", "baijiahao", "ctrip_community"],
  slotCount: 5,
  intervalMinutes: 15,
  dailyTimes: ["09:00", "20:00"],
  timezone: "Asia/Shanghai",
  nextRunAt: "2026-08-07T00:00:00.000Z",
  campaignName: "中通暑期投放",
  campaignTopicKey: "summer-travel",
  campaignObjective: "覆盖暑期跟团游决策场景",
  campaignPromptTemplate: null,
};

describe("campaign automation plan batch builder", () => {
  it("builds a platform-round-robin batch from one plan configuration", () => {
    let counter = 0;
    const input = buildAutomationPlanBatchInput({
      plan,
      scheduledAt: "2026-08-07T00:00:00.000Z",
      uuid: () => `10000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`,
      idempotencyKey: "campaign-automation-plan:v1:manual:test",
    });

    expect(input.runs).toHaveLength(5);
    expect(input.distribution).toEqual({
      mode: "platforms_round_robin",
      platforms: ["toutiao", "baijiahao", "ctrip_community"],
    });
    expect(input.runs[0]?.targets).toHaveLength(3);
    expect(input.runs[0]?.availableAt).toBe("2026-08-07T00:00:00.000Z");
    expect(input.runs[1]?.availableAt).toBe("2026-08-07T00:15:00.000Z");
    expect(input.runs[0]?.brief).toContain(plan.campaignObjective);
  });

  it("advances to the next daily run time in the plan timezone", () => {
    const beforeNine = new Date("2026-08-07T00:30:00.000Z");
    expect(nextCampaignAutomationRunAt(plan, beforeNine)).toBe("2026-08-07T01:00:00.000Z");
  });

  it("falls back to the interval when no daily time remains", () => {
    const late = new Date("2026-08-07T14:00:00.000Z");
    expect(nextCampaignAutomationRunAt(plan, late)).toBe("2026-08-08T01:00:00.000Z");
    const noDailyTimes = { ...plan, dailyTimes: [] };
    expect(nextCampaignAutomationRunAt(noDailyTimes, late)).toBe("2026-08-07T14:15:00.000Z");
  });
});
