import { describe, expect, it } from "vitest";

import {
  ctripBridgeCommandSchema,
  ctripBridgeHealthSchema,
  ctripBridgeResultSchema,
} from "./ctrip-bridge.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000003";

describe("Ctrip bridge contracts", () => {
  it("accepts only the narrow command fields", () => {
    expect(
      ctripBridgeCommandSchema.parse({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-1",
        command: "prepare",
      }),
    ).toMatchObject({ command: "prepare", tenantId, handoffId });

    for (const forbidden of ["url", "selector", "script", "headers", "cookiePath", "principalId"]) {
      expect(
        ctripBridgeCommandSchema.safeParse({
          schemaVersion: "geo.ctrip-bridge.command.v1",
          tenantId,
          handoffId,
          requestId: "request-1",
          command: "prepare",
          [forbidden]: "client-controlled",
        }).success,
      ).toBe(false);
    }
  });

  it("requires a bounded lowercase hex permit only for submit", () => {
    expect(
      ctripBridgeCommandSchema.safeParse({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-2",
        command: "submit",
      }).success,
    ).toBe(false);
    expect(
      ctripBridgeCommandSchema.safeParse({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-2",
        command: "submit",
        submitPermit: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("keeps simulation results distinguishable from live confirmation", () => {
    const common = {
      schemaVersion: "geo.ctrip-bridge.result.v1",
      tenantId,
      handoffId,
      bridgePrincipalId,
      adapterVersion: "ctrip-community-simulator-v1",
      observedAt: "2026-07-16T12:00:00.000Z",
      evidenceHash: "b".repeat(64),
      command: "readback",
    } as const;
    expect(
      ctripBridgeResultSchema.parse({
        ...common,
        outcome: "simulation_only",
        evidenceKind: "simulation",
        state: "needs_review",
        externalId: null,
        externalUrl: null,
      }),
    ).toMatchObject({ outcome: "simulation_only", state: "needs_review" });
    expect(
      ctripBridgeResultSchema.safeParse({
        ...common,
        outcome: "confirmed",
        evidenceKind: "simulation",
        state: "confirmed",
        externalId: "fake-live-id",
        externalUrl: "https://you.ctrip.com/travels/fake.html",
        confirmed: true,
      }).success,
    ).toBe(false);
  });

  it("advertises simulator mode explicitly", () => {
    expect(
      ctripBridgeHealthSchema.parse({
        status: "ok",
        service: "geo-ctrip-bridge",
        mode: "simulator",
        adapterVersion: "ctrip-community-simulator-v1",
      }),
    ).toMatchObject({ mode: "simulator" });
  });
});
