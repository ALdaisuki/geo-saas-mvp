import { describe, expect, it } from "vitest";

import {
  automationBatchCreateRequestSchema,
  automationClaimCommandSchema,
  automationDraftCheckpointCommandSchema,
  automationTargetAssignmentCommandSchema,
  automationTargetCheckpointCommandSchema,
} from "./automation-contracts.js";

const id = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("automation API commands", () => {
  it("bounds producer claims and leases", () => {
    expect(
      automationClaimCommandSchema.parse({
        producerId: "producer-1",
        limit: 2,
        leaseSeconds: 60,
      }),
    ).toEqual({ producerId: "producer-1", limit: 2, leaseSeconds: 60 });
    expect(
      automationClaimCommandSchema.safeParse({
        producerId: "producer-1",
        limit: 17,
        leaseSeconds: 60,
      }).success,
    ).toBe(false);
  });

  it("requires complete draft checkpoint bindings", () => {
    expect(
      automationDraftCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        contentItemId: id,
        contentVersionId: id,
        checkpoint: { stage: "draft" },
        leaseSeconds: 60,
      }).success,
    ).toBe(true);
    expect(
      automationDraftCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        contentVersionId: id,
        checkpoint: {},
      }).success,
    ).toBe(false);
  });

  it("accepts a bounded unique round-robin account pool", () => {
    const request = {
      idempotencyKey: "batch-round-robin-1",
      distribution: { mode: "round_robin" as const, accountPoolIds: [id, secondId] },
      items: [
        {
          slotKey: "slot-001",
          scheduledFor: "2026-07-29T12:00:00.000Z",
          topicKey: "travel",
          brief: "面向赴日游客的行前服务说明",
          channelAccountIds: [id],
        },
      ],
    };
    expect(automationBatchCreateRequestSchema.parse(request).distribution).toEqual(
      request.distribution,
    );
    expect(
      automationBatchCreateRequestSchema.safeParse({
        ...request,
        distribution: { mode: "round_robin", accountPoolIds: [id, id] },
      }).success,
    ).toBe(false);

    const accountPool = Array.from(
      { length: 200 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(
      automationBatchCreateRequestSchema.safeParse({
        ...request,
        distribution: { mode: "round_robin", accountPoolIds: accountPool },
      }).success,
    ).toBe(true);
    expect(
      automationBatchCreateRequestSchema.safeParse({
        ...request,
        distribution: {
          mode: "round_robin",
          accountPoolIds: [...accountPool, "00000000-0000-4000-8000-000000000201"],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts platform-managed distribution without caller-assigned accounts", () => {
    const request = {
      idempotencyKey: "batch-platform-round-robin-1",
      executionLevel: "unattended" as const,
      distribution: {
        mode: "platform_round_robin" as const,
        platform: "ctrip_community" as const,
      },
      items: [
        {
          slotKey: "slot-001",
          scheduledFor: "2026-07-29T12:00:00.000Z",
          topicKey: "travel",
          brief: "面向青岛出发家庭游客的行前服务说明",
        },
      ],
    };

    expect(automationBatchCreateRequestSchema.parse(request).items[0]?.channelAccountIds).toEqual(
      [],
    );
    expect(
      automationBatchCreateRequestSchema.safeParse({
        ...request,
        items: [{ ...request.items[0], channelAccountIds: [id] }],
      }).success,
    ).toBe(false);
  });

  it("accepts a unique multi-platform managed pool", () => {
    const request = {
      idempotencyKey: "batch-platforms-round-robin-1",
      executionLevel: "unattended" as const,
      distribution: {
        mode: "platforms_round_robin" as const,
        platforms: ["toutiao", "sohu", "baijiahao", "netease"] as const,
      },
      items: [
        {
          slotKey: "slot-001",
          scheduledFor: "2026-07-29T12:00:00.000Z",
          topicKey: "travel",
          brief: "同一选题生成四个平台最终变体",
        },
      ],
    };

    expect(automationBatchCreateRequestSchema.parse(request).distribution).toEqual(
      request.distribution,
    );
    expect(
      automationBatchCreateRequestSchema.safeParse({
        ...request,
        distribution: { mode: "platforms_round_robin", platforms: ["toutiao", "toutiao"] },
      }).success,
    ).toBe(false);
  });

  it("accepts all six supported platforms in one assisted batch", () => {
    const request = {
      idempotencyKey: "batch-six-platform-assisted-1",
      executionLevel: "assisted" as const,
      distribution: {
        mode: "platforms_round_robin" as const,
        platforms: ["baijiahao", "sohu", "toutiao", "netease", "ctrip_community", "zhihu"] as const,
      },
      items: [
        {
          slotKey: "slot-six-platform",
          scheduledFor: "2026-08-16T12:00:00.000Z",
          topicKey: "travel:six-platform-canary",
          brief: "六平台并发验收",
        },
      ],
    };

    expect(automationBatchCreateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts only a channel account ID when changing a pending assignment", () => {
    expect(automationTargetAssignmentCommandSchema.parse({ channelAccountId: secondId })).toEqual({
      channelAccountId: secondId,
    });
    expect(
      automationTargetAssignmentCommandSchema.safeParse({
        channelAccountId: secondId,
        force: true,
      }).success,
    ).toBe(false);
  });

  it("rejects target states without their required durable resources", () => {
    expect(
      automationTargetCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        state: "awaiting_delivery",
        variantId: id,
        auditArtifactId: id,
      }).success,
    ).toBe(false);
    expect(
      automationTargetCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        state: "awaiting_delivery",
        variantId: id,
        auditArtifactId: id,
        publicationJobId: id,
      }).success,
    ).toBe(true);
    expect(
      automationTargetCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        state: "failed",
        errorCode: "AUTOMATION_PROVIDER_REJECTED",
      }).success,
    ).toBe(true);
    expect(
      automationTargetCheckpointCommandSchema.safeParse({
        producerId: "producer-1",
        attempt: 1,
        state: "delivery_failed",
        variantId: id,
        auditArtifactId: id,
        publicationJobId: id,
        errorCode: "AUTOMATION_PUBLICATION_NEEDS_REVIEW",
      }).success,
    ).toBe(true);
  });
});
