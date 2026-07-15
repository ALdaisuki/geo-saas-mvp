import { describe, expect, it } from "vitest";

import {
  automationClaimCommandSchema,
  automationDraftCheckpointCommandSchema,
  automationTargetCheckpointCommandSchema,
} from "./automation-contracts.js";

const id = "00000000-0000-4000-8000-000000000001";

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
  });
});
