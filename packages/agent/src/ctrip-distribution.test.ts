import { describe, expect, it } from "vitest";

import { assignRoundRobin } from "./ctrip-distribution.js";

const items = [
  {
    slotKey: "slot-001",
    scheduledFor: "2026-07-29T04:00:00.000Z",
    topicKey: "travel",
    brief: "第一篇",
    channelAccountIds: ["legacy-a"],
  },
  {
    slotKey: "slot-002",
    scheduledFor: "2026-07-29T04:15:00.000Z",
    topicKey: "travel",
    brief: "第二篇",
    channelAccountIds: ["legacy-a"],
  },
  {
    slotKey: "slot-003",
    scheduledFor: "2026-07-29T04:30:00.000Z",
    topicKey: "travel",
    brief: "第三篇",
    channelAccountIds: ["legacy-a"],
  },
];

describe("assignRoundRobin", () => {
  it("assigns one immutable target per slot in stable order", () => {
    expect(
      assignRoundRobin({ items, accountPoolIds: ["account-a", "account-b"] }).map(
        (item) => item.channelAccountIds,
      ),
    ).toEqual([["account-a"], ["account-b"], ["account-a"]]);
  });

  it("continues from a durable offset instead of restarting each batch", () => {
    expect(
      assignRoundRobin({
        items,
        accountPoolIds: ["account-a", "account-b"],
        startOffset: 1,
      }).map((item) => item.channelAccountIds),
    ).toEqual([["account-b"], ["account-a"], ["account-b"]]);
  });

  it("rejects an empty or duplicate account pool", () => {
    expect(() => assignRoundRobin({ items, accountPoolIds: [] })).toThrow(
      "Distribution account pool cannot be empty",
    );
    expect(() => assignRoundRobin({ items, accountPoolIds: ["account-a", "account-a"] })).toThrow(
      "unique accounts",
    );
  });

  it("distributes 10,000 target lifecycles across 50 logical accounts in bounded batches", () => {
    const targetCount = 10_000;
    const batchSize = 50;
    const accountPoolIds = Array.from(
      { length: 50 },
      (_, index) => `account-${String(index + 1).padStart(2, "0")}`,
    );
    const assignments = new Map(accountPoolIds.map((accountId) => [accountId, 0]));
    const assignedSlots = new Set<string>();

    for (let offset = 0; offset < targetCount; offset += batchSize) {
      const batchItems = Array.from(
        { length: Math.min(batchSize, targetCount - offset) },
        (_, index) => ({
          slotKey: `slot-${String(offset + index + 1).padStart(5, "0")}`,
          scheduledFor: "2026-08-04T00:00:00.000Z",
          topicKey: "capacity-smoke",
          brief: "受治理的软广容量验证目标",
          channelAccountIds: [],
        }),
      );
      const assigned = assignRoundRobin({
        items: batchItems,
        accountPoolIds,
        startOffset: offset,
      });
      expect(assigned).toHaveLength(batchItems.length);
      for (const item of assigned) {
        const accountId = item.channelAccountIds[0];
        if (accountId === undefined) throw new Error("capacity target was not assigned");
        expect(item.channelAccountIds).toHaveLength(1);
        expect(assignedSlots.has(item.slotKey)).toBe(false);
        assignedSlots.add(item.slotKey);
        assignments.set(accountId, (assignments.get(accountId) ?? 0) + 1);
      }
    }

    expect(assignedSlots.size).toBe(targetCount);
    expect([...assignments.values()]).toEqual(Array.from({ length: 50 }, () => 200));
  });
});
