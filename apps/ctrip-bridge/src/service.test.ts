import { renderCtripCommunityAssistedDraft } from "@geo/connectors";
import { describe, expect, it, vi } from "vitest";

import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import {
  CTRIP_SIMULATOR_ADAPTER_VERSION,
  type CtripBridgeControlPlane,
  type CtripBridgeHandoffDraft,
} from "./types.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000003";
const channelAccountId = "10000000-0000-4000-8000-000000000004";
const variantId = "10000000-0000-4000-8000-000000000005";
const now = "2026-07-16T12:00:00.000Z";
const payload = {
  title: "北京出发日本旅行证据指南",
  summary: "核对签证、航班和服务边界。",
  bodyMarkdown: "# 行前核验\n\n以官方信息为准。",
  tags: ["日本旅行", "中通国际旅行社"],
  media: [],
  claims: [],
  contactIds: [],
};
const previewHash = renderCtripCommunityAssistedDraft({
  tenantId,
  channelAccountId,
  variantId,
  executionLevel: "assisted",
  payload,
}).previewHash;

function handoff(state: CtripBridgeHandoffDraft["state"]): CtripBridgeHandoffDraft {
  return {
    id: handoffId,
    tenantId,
    channelAccountId,
    variantId,
    platform: "ctrip_community",
    state,
    previewHash,
    payloadHash: "a".repeat(64),
    adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
    bridgePrincipalId,
    payload,
  };
}

function controlPlane(current: { value: CtripBridgeHandoffDraft }): CtripBridgeControlPlane {
  return {
    loadHandoff: vi.fn(async () => current.value),
    recordPrepared: vi.fn(async () => {
      current.value = handoff("draft_prepared");
    }),
    consumeSubmitPermit: vi.fn(async () => {
      current.value = handoff("awaiting_operator_submit");
    }),
    recordSubmitObservation: vi.fn(async () => {
      current.value = handoff("readback_pending");
      return {
        receiptId: "10000000-0000-4000-8000-000000000006",
        readbackId: "10000000-0000-4000-8000-000000000007",
      };
    }),
    recordReadback: vi.fn(async () => ({
      state: "needs_review" as const,
      externalId: null,
      externalUrl: null,
    })),
  };
}

function command(commandName: "prepare" | "readback") {
  return {
    schemaVersion: "geo.ctrip-bridge.command.v1",
    tenantId,
    handoffId,
    requestId: `request-${commandName}`,
    command: commandName,
  };
}

describe("CtripBridgeCommandService", () => {
  it("prepares the exact rendered draft without accepting browser configuration", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });

    await expect(service.execute(command("prepare"))).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
      state: "draft_prepared",
      evidenceKind: "simulation",
    });
    expect(port.recordPrepared).toHaveBeenCalledOnce();
  });

  it("consumes the one-time permit before invoking submit and records required readback", async () => {
    const current = { value: handoff("handoff_pending") };
    const order: string[] = [];
    const port = controlPlane(current);
    vi.mocked(port.consumeSubmitPermit).mockImplementation(async () => {
      order.push("permit");
      current.value = handoff("awaiting_operator_submit");
    });
    vi.mocked(port.recordSubmitObservation).mockImplementation(async () => {
      order.push("observation");
      current.value = handoff("readback_pending");
      return {
        receiptId: "10000000-0000-4000-8000-000000000006",
        readbackId: "10000000-0000-4000-8000-000000000007",
      };
    });
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const originalSubmit = simulator.submit.bind(simulator);
    simulator.submit = async (...args) => {
      order.push("submit");
      return originalSubmit(...args);
    };
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      adapter: simulator,
    });
    await service.execute(command("prepare"));
    current.value = handoff("draft_prepared");

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-submit",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).resolves.toMatchObject({
      outcome: "accepted",
      state: "readback_pending",
      receiptId: "10000000-0000-4000-8000-000000000006",
    });
    expect(order).toEqual(["permit", "submit", "observation"]);
  });

  it("keeps an uncertain simulator submit non-retryable", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      adapter: new CtripCommunitySimulator({
        now: () => new Date(now),
        nextSubmitOutcome: () => "uncertain",
      }),
    });
    await service.execute(command("prepare"));
    current.value = handoff("draft_prepared");
    const submit = {
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId,
      handoffId,
      requestId: "request-submit",
      command: "submit",
      submitPermit: "f".repeat(64),
    };

    await expect(service.execute(submit)).resolves.toMatchObject({ outcome: "uncertain" });
    await expect(service.execute({ ...submit, requestId: "request-retry" })).rejects.toThrow(
      /one-shot/iu,
    );
  });

  it("never promotes simulator readback to confirmed", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });
    await service.execute(command("prepare"));
    current.value = handoff("draft_prepared");
    await service.execute({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId,
      handoffId,
      requestId: "request-submit",
      command: "submit",
      submitPermit: "f".repeat(64),
    });
    current.value = handoff("readback_pending");

    await expect(service.execute(command("readback"))).resolves.toMatchObject({
      outcome: "simulation_only",
      state: "needs_review",
      externalId: null,
      externalUrl: null,
    });
  });

  it("rejects a tenant, principal, preview or adapter mismatch before adapter work", async () => {
    const mismatches: CtripBridgeHandoffDraft[] = [
      { ...handoff("handoff_pending"), tenantId: bridgePrincipalId },
      { ...handoff("handoff_pending"), bridgePrincipalId: tenantId },
      { ...handoff("handoff_pending"), previewHash: "0".repeat(64) },
      { ...handoff("handoff_pending"), adapterVersion: "client-selected-v2" },
    ];
    for (const value of mismatches) {
      const service = new CtripBridgeCommandService({
        tenantId,
        bridgePrincipalId,
        controlPlane: controlPlane({ value }),
        adapter: new CtripCommunitySimulator(),
      });
      await expect(service.execute(command("prepare"))).rejects.toThrow();
    }
  });
});
