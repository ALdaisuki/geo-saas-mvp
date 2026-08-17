import { renderCtripCommunityAssistedDraft } from "@geo/connectors";
import { describe, expect, it, vi } from "vitest";

import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import {
  CTRIP_SIMULATOR_ADAPTER_VERSION,
  CtripPreparedDraftConflictError,
  type CtripBridgeControlPlane,
  type CtripBridgeHandoffDraft,
  type CtripFixedAdapter,
} from "./types.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000003";
const channelAccountId = "10000000-0000-4000-8000-000000000004";
const variantId = "10000000-0000-4000-8000-000000000005";
const contentVersionId = "10000000-0000-4000-8000-000000000008";
const now = "2026-07-16T12:00:00.000Z";
const payload = {
  title: "北京出发日本旅行证据指南",
  summary: "核对签证、航班和服务边界。",
  bodyMarkdown: "# 行前核验\n\n以官方信息为准。",
  tags: ["日本旅行", "示例国际旅行服务"],
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
    contentVersionId,
    platform: "ctrip_community",
    executionLevel: "assisted",
    state,
    previewHash,
    payloadHash: "a".repeat(64),
    adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
    bridgePrincipalId,
    externalDraftId: state === "handoff_pending" ? null : `sim-draft-${handoffId}`,
    submitOutcome: state === "readback_pending" ? "accepted" : null,
    submitEvidenceHash: state === "readback_pending" ? "d".repeat(64) : null,
    submitEvidenceKind: state === "readback_pending" ? "simulation" : null,
    submitObservedAt: state === "readback_pending" ? now : null,
    submitCandidateExternalId: null,
    submitCandidateExternalUrl: null,
    submitPermitConsumedAt: null,
    payload,
  };
}

function controlPlane(current: {
  value: CtripBridgeHandoffDraft;
}): CtripBridgeControlPlane & Required<Pick<CtripBridgeControlPlane, "claimUnattendedReadback">> {
  return {
    claimDraftPreparation: vi.fn(async () => undefined),
    claimNextDraftPreparation: vi.fn(async () => null),
    claimUnattendedReadback: vi.fn(async () => true),
    recordRuntimeStatus: vi.fn(async () => undefined),
    loadHandoff: vi.fn(async () => current.value),
    loadPreparedMediaAssets: vi.fn(async () => []),
    recordPrepared: vi.fn(async () => {
      current.value = handoff("draft_prepared");
    }),
    recordPreparationBlocker: vi.fn(async () => undefined),
    recordPreparedConflict: vi.fn(async () => undefined),
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
    recoverSubmitObservation: vi.fn(async (_context, _handoff, evidenceKind) => {
      current.value = {
        ...handoff("readback_pending"),
        submitOutcome: "uncertain",
        submitEvidenceHash: "e".repeat(64),
        submitEvidenceKind: evidenceKind,
        submitObservedAt: now,
        submitPermitConsumedAt: now,
      };
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

function emptyMediaObjectStore() {
  return { get: vi.fn(async () => new Uint8Array()) };
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
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });

    await expect(service.execute(command("prepare"))).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
      state: "draft_prepared",
      evidenceKind: "simulation",
    });
    expect(port.recordPrepared).toHaveBeenCalledOnce();
    expect(port.recordRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      channelAccountId,
      "ready",
    );
    expect(port.claimDraftPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      handoffId,
      600,
    );
    expect(vi.mocked(port.claimDraftPreparation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.loadHandoff).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("claims the next preparation before loading any browser payload", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    vi.mocked(port.claimNextDraftPreparation).mockResolvedValue(handoffId);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });

    await expect(service.prepareNext("request-poller")).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
    });
    expect(port.claimDraftPreparation).not.toHaveBeenCalled();
    expect(vi.mocked(port.claimNextDraftPreparation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.loadHandoff).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("lets the unattended bridge prepare assisted handoffs without enabling assisted submit", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    vi.mocked(port.claimNextDraftPreparation).mockResolvedValue(handoffId);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
      executionLevel: "unattended",
      preparationExecutionLevel: "all",
    });

    await expect(service.prepareNext("request-unattended-preparation")).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
    });
    expect(port.claimNextDraftPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      600,
      undefined,
    );
    await expect(service.submitNext("request-unattended-submit")).resolves.toBeNull();
  });

  it("never lets an assisted poller claim unattended submit or readback work", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    port.claimNextUnattendedSubmit = vi.fn(async () => ({
      handoffId,
      submitPermit: "f".repeat(64),
    }));
    port.claimNextUnattendedReadback = vi.fn(async () => handoffId);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });

    await expect(service.submitNext("request-assisted-submit-poller")).resolves.toBeNull();
    await expect(service.readbackNext("request-assisted-readback-poller")).resolves.toBeNull();
    expect(port.claimNextUnattendedSubmit).not.toHaveBeenCalled();
    expect(port.claimNextUnattendedReadback).not.toHaveBeenCalled();
  });

  it.each([
    ["session_required", "session_required"],
    ["challenge_required", "challenge_required"],
    ["adapter_drift", "failed"],
    ["payload_invalid", "failed"],
  ] as const)(
    "persists a %s preflight blocker before returning it",
    async (outcome, expectedState) => {
      const current = { value: handoff("handoff_pending") };
      const basePort = controlPlane(current);
      const recordPreparationBlocker = vi.fn(async () => undefined);
      const port = { ...basePort, recordPreparationBlocker };
      const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
      const adapter = {
        version: CTRIP_SIMULATOR_ADAPTER_VERSION,
        evidenceKind: "browser",
        commandCapabilities: { prepare: true, submit: true, readback: true },
        prepare: vi.fn(async () => ({
          outcome,
          diagnosticCode: `test:${outcome}`,
          sessionEvidenceHash: "b".repeat(64),
          evidenceHash: "c".repeat(64),
          observedAt: now,
          evidenceKind: "browser",
        })),
        submit: simulator.submit.bind(simulator),
        readback: simulator.readback.bind(simulator),
      } as unknown as CtripFixedAdapter;
      const service = new CtripBridgeCommandService({
        tenantId,
        bridgePrincipalId,
        controlPlane: port,
        mediaObjectStore: emptyMediaObjectStore(),
        adapter,
      });

      await expect(service.execute(command("prepare"))).resolves.toMatchObject({
        command: "prepare",
        outcome,
        state: expectedState,
        evidenceKind: "browser",
      });
      expect(recordPreparationBlocker).toHaveBeenCalledOnce();
      expect(port.recordRuntimeStatus).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, bridgePrincipalId }),
        channelAccountId,
        outcome === "session_required"
          ? "session_required"
          : outcome === "challenge_required"
            ? "challenge_required"
            : "unavailable",
        `CTRIP_${outcome.toUpperCase()}`,
        expect.any(String),
      );
      expect(basePort.recordPrepared).not.toHaveBeenCalled();
    },
  );

  it("reports a Ctrip account mute before persisting the preparation blocker", async () => {
    const current = { value: handoff("handoff_pending") };
    const basePort = controlPlane(current);
    const reportChannelAccountPlatformMute = vi.fn(async () => undefined);
    const recordPreparationBlocker = vi.fn(async () => undefined);
    const port = {
      ...basePort,
      reportChannelAccountPlatformMute,
      recordPreparationBlocker,
    };
    const adapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: true },
      prepare: vi.fn(async () => ({
        outcome: "adapter_drift",
        diagnosticCode: "draft-save:draft-save-account-muted",
        sessionEvidenceHash: "b".repeat(64),
        evidenceHash: "c".repeat(64),
        observedAt: now,
        evidenceKind: "browser",
      })),
    } as unknown as CtripFixedAdapter;
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
    });

    await expect(service.execute(command("prepare"))).resolves.toMatchObject({
      command: "prepare",
      outcome: "adapter_drift",
      state: "failed",
    });
    expect(reportChannelAccountPlatformMute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      expect.objectContaining({ id: handoffId, channelAccountId }),
      "draft-save-account-muted",
    );
    expect(recordPreparationBlocker).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported submit before consuming its one-time permit", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const submit = vi.fn(simulator.submit.bind(simulator));
    const adapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: false, readback: false },
      prepare: simulator.prepare.bind(simulator),
      submit,
      readback: simulator.readback.bind(simulator),
    } as unknown as CtripFixedAdapter;
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
    });

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-unsupported-submit",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "CTRIP_BRIDGE_COMMAND_UNSUPPORTED",
      statusCode: 409,
    });
    expect(port.consumeSubmitPermit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
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
      mediaObjectStore: emptyMediaObjectStore(),
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

  it("records a creator-confirmed retained draft without creating public readback work", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const onHandoffReclaimable = vi.fn(async () => undefined);
    vi.mocked(port.consumeSubmitPermit).mockImplementation(async () => {
      current.value = handoff("awaiting_operator_submit");
    });
    vi.mocked(port.recordSubmitObservation).mockImplementation(async () => {
      current.value = {
        ...handoff("needs_review"),
        submitOutcome: "not_accepted",
        submitEvidenceHash: "e".repeat(64),
        submitEvidenceKind: "browser",
        submitObservedAt: now,
        submitPermitConsumedAt: now,
      };
      return { receiptId: null, readbackId: null };
    });
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const adapter: CtripFixedAdapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: false },
      prepare: simulator.prepare.bind(simulator),
      submit: async () => ({
        outcome: "not_accepted",
        observedAt: now,
        evidenceKind: "browser",
        evidenceHash: "f".repeat(64),
        candidateExternalId: null,
        candidateExternalUrl: null,
      }),
      readback: simulator.readback.bind(simulator),
    };
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
      onHandoffReclaimable,
    });

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-submit-retained-draft",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).resolves.toMatchObject({
      command: "submit",
      outcome: "not_accepted",
      state: "needs_review",
      receiptId: null,
      readbackId: null,
    });
    expect(port.recoverSubmitObservation).not.toHaveBeenCalled();
    expect(onHandoffReclaimable).toHaveBeenCalledWith({
      handoffId,
      channelAccountId,
      state: "needs_review",
    });
  });

  it("verifies the prepared browser scope before consuming the one-time permit", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const submit = vi.fn(simulator.submit.bind(simulator));
    const adapter: CtripFixedAdapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: false },
      prepare: simulator.prepare.bind(simulator),
      verifySubmit: vi.fn(async () => {
        throw new Error("prepared scope mismatch");
      }),
      submit,
      readback: simulator.readback.bind(simulator),
    };
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
    });

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-submit-precondition",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).rejects.toThrow(/scope mismatch/iu);
    expect(port.consumeSubmitPermit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails an unconsumed prepared handoff when the browser surface belongs to another payload", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const observation = {
      evidenceHash: "b".repeat(64),
      observedAt: now,
      evidenceKind: "browser" as const,
      diagnosticCode: "submit:prepared-payload-mismatch",
    };
    const submit = vi.fn(simulator.submit.bind(simulator));
    const adapter: CtripFixedAdapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: false },
      prepare: simulator.prepare.bind(simulator),
      verifySubmit: vi.fn(async () => {
        throw new CtripPreparedDraftConflictError(observation);
      }),
      submit,
      readback: simulator.readback.bind(simulator),
    };
    const onHandoffReclaimable = vi.fn(async () => undefined);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
      onHandoffReclaimable,
    });

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-submit-prepared-conflict",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "CTRIP_PREPARED_DRAFT_MISMATCH",
      statusCode: 409,
      message: "Prepared submit precondition failed: submit:prepared-payload-mismatch",
    });
    expect(port.recordPreparedConflict).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      current.value,
      observation,
    );
    expect(port.consumeSubmitPermit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(onHandoffReclaimable).toHaveBeenCalledWith({
      handoffId,
      channelAccountId,
      state: "failed",
    });
  });

  it.each([
    {
      diagnosticCode: "submit:session-required",
      serviceCode: "CTRIP_SESSION_REQUIRED",
    },
    {
      diagnosticCode: "submit:challenge-required",
      serviceCode: "CTRIP_CHALLENGE_REQUIRED",
    },
  ])(
    "keeps $diagnosticCode recoverable before consuming the submit permit",
    async ({ diagnosticCode, serviceCode }) => {
      const current = { value: handoff("draft_prepared") };
      const port = controlPlane(current);
      const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
      const observation = {
        evidenceHash: "b".repeat(64),
        observedAt: now,
        evidenceKind: "browser" as const,
        diagnosticCode,
      };
      const submit = vi.fn(simulator.submit.bind(simulator));
      const onHandoffReclaimable = vi.fn(async () => undefined);
      const service = new CtripBridgeCommandService({
        tenantId,
        bridgePrincipalId,
        controlPlane: port,
        mediaObjectStore: emptyMediaObjectStore(),
        adapter: {
          version: CTRIP_SIMULATOR_ADAPTER_VERSION,
          evidenceKind: "browser",
          commandCapabilities: { prepare: true, submit: true, readback: false },
          prepare: simulator.prepare.bind(simulator),
          verifySubmit: vi.fn(async () => {
            throw new CtripPreparedDraftConflictError(observation);
          }),
          submit,
          readback: simulator.readback.bind(simulator),
        },
        onHandoffReclaimable,
      });

      await expect(
        service.execute({
          schemaVersion: "geo.ctrip-bridge.command.v1",
          tenantId,
          handoffId,
          requestId: `request-${diagnosticCode}`,
          command: "submit",
          submitPermit: "f".repeat(64),
        }),
      ).rejects.toMatchObject({ code: serviceCode, statusCode: 409 });
      expect(port.recordPreparedConflict).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, bridgePrincipalId }),
        current.value,
        observation,
      );
      expect(port.consumeSubmitPermit).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(onHandoffReclaimable).not.toHaveBeenCalled();
    },
  );

  it("durably recovers an exception after permit consumption as uncertain", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const adapter: CtripFixedAdapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: false },
      prepare: simulator.prepare.bind(simulator),
      verifySubmit: vi.fn(async () => undefined),
      submit: vi.fn(async () => {
        throw new Error("post-click observation failed");
      }),
      readback: simulator.readback.bind(simulator),
    };
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
    });

    await expect(
      service.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId,
        handoffId,
        requestId: "request-submit-recovery",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).resolves.toMatchObject({
      command: "submit",
      outcome: "uncertain",
      state: "readback_pending",
      evidenceKind: "browser",
    });
    expect(port.consumeSubmitPermit).toHaveBeenCalledOnce();
    expect(port.recoverSubmitObservation).toHaveBeenCalledOnce();
    expect(port.recordSubmitObservation).not.toHaveBeenCalled();
  });

  it("persists a browser-observed candidate target before independent readback", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const adapter: CtripFixedAdapter = {
      version: CTRIP_SIMULATOR_ADAPTER_VERSION,
      evidenceKind: "browser",
      commandCapabilities: { prepare: true, submit: true, readback: true },
      prepare: simulator.prepare.bind(simulator),
      submit: async () => ({
        outcome: "accepted",
        evidenceHash: "8".repeat(64),
        observedAt: now,
        evidenceKind: "browser",
        candidateExternalId: "ctrip-candidate-001",
        candidateExternalUrl: "https://you.ctrip.com/travels/candidate-001.html",
      }),
      readback: simulator.readback.bind(simulator),
    };
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter,
    });

    await service.execute({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId,
      handoffId,
      requestId: "request-candidate-submit",
      command: "submit",
      submitPermit: "f".repeat(64),
    });

    expect(port.recordSubmitObservation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        candidateExternalId: "ctrip-candidate-001",
        candidateExternalUrl: "https://you.ctrip.com/travels/candidate-001.html",
      }),
    );
  });

  it("notifies the lifecycle hook after an accepted submit observation is durable", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    const onHandoffReclaimable = vi.fn(async () => undefined);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
      onHandoffReclaimable,
    });

    await service.execute({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId,
      handoffId,
      requestId: "request-submit-lifecycle-accepted",
      command: "submit",
      submitPermit: "f".repeat(64),
    });

    expect(onHandoffReclaimable).toHaveBeenCalledWith({
      handoffId,
      channelAccountId,
      state: "readback_pending",
    });
  });

  it("notifies the lifecycle hook after an uncertain submit recovery is durable", async () => {
    const current = { value: handoff("draft_prepared") };
    const port = controlPlane(current);
    vi.mocked(port.recoverSubmitObservation).mockImplementation(async () => {
      current.value = {
        ...handoff("readback_pending"),
        submitOutcome: "uncertain",
        submitEvidenceHash: "d".repeat(64),
        submitEvidenceKind: "browser",
        submitObservedAt: now,
      };
      return {
        receiptId: "10000000-0000-4000-8000-000000000006",
        readbackId: "10000000-0000-4000-8000-000000000007",
      };
    });
    const onHandoffReclaimable = vi.fn(async () => undefined);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: {
        version: CTRIP_SIMULATOR_ADAPTER_VERSION,
        evidenceKind: "browser",
        commandCapabilities: { prepare: true, submit: true, readback: false },
        prepare: simulator.prepare.bind(simulator),
        submit: vi.fn(async () => {
          throw new Error("post-click observation failed");
        }),
        readback: simulator.readback.bind(simulator),
      },
      onHandoffReclaimable,
    });

    await service.execute({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId,
      handoffId,
      requestId: "request-submit-lifecycle-uncertain",
      command: "submit",
      submitPermit: "f".repeat(64),
    });

    expect(onHandoffReclaimable).toHaveBeenCalledWith({
      handoffId,
      channelAccountId,
      state: "readback_pending",
    });
  });

  it("keeps an uncertain simulator submit non-retryable", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
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
      /not ready|one-time/iu,
    );
  });

  it("never promotes simulator readback to confirmed", async () => {
    const current = { value: handoff("handoff_pending") };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
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
    expect(port.claimUnattendedReadback).not.toHaveBeenCalled();
  });

  it("notifies the reclaimable handoff hook so the browser session can be destroyed", async () => {
    const current = { value: handoff("readback_pending") };
    const port = controlPlane(current);
    const onHandoffReclaimable = vi.fn(async () => undefined);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
      onHandoffReclaimable,
    });

    await service.execute(command("readback"));

    expect(onHandoffReclaimable).toHaveBeenCalledWith({
      handoffId,
      channelAccountId,
      state: "needs_review",
    });
  });

  it("atomically claims a targeted unattended readback before observing the public page", async () => {
    const unattendedPreviewHash = renderCtripCommunityAssistedDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "unattended",
      payload,
    }).previewHash;
    const current = {
      value: {
        ...handoff("readback_pending"),
        executionLevel: "unattended" as const,
        previewHash: unattendedPreviewHash,
        submitPermitConsumedAt: now,
      },
    };
    const port = controlPlane(current);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
    });

    await expect(service.execute(command("readback"))).resolves.toMatchObject({
      command: "readback",
      outcome: "simulation_only",
    });
    expect(port.claimUnattendedReadback).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, bridgePrincipalId }),
      handoffId,
    );
    expect(vi.mocked(port.claimUnattendedReadback).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.recordReadback).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("reuses the queue-owned unattended readback lease without a second targeted claim", async () => {
    const unattendedPreviewHash = renderCtripCommunityAssistedDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "unattended",
      payload,
    }).previewHash;
    const current = {
      value: {
        ...handoff("readback_pending"),
        executionLevel: "unattended" as const,
        previewHash: unattendedPreviewHash,
        submitPermitConsumedAt: now,
      },
    };
    const port = controlPlane(current);
    port.claimNextUnattendedReadback = vi.fn(async () => handoffId);
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: new CtripCommunitySimulator({ now: () => new Date(now) }),
      executionLevel: "unattended",
    });

    await expect(service.readbackNext("request-readback-poller")).resolves.toMatchObject({
      command: "readback",
      outcome: "simulation_only",
    });
    expect(port.claimNextUnattendedReadback).toHaveBeenCalledOnce();
    expect(port.claimUnattendedReadback).not.toHaveBeenCalled();
  });

  it("recovers a consumed but unobserved submit before readback without submitting again", async () => {
    const current = {
      value: {
        ...handoff("awaiting_operator_submit"),
        submitPermitConsumedAt: now,
      },
    };
    const port = controlPlane(current);
    const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const submit = vi.spyOn(simulator, "submit");
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: port,
      mediaObjectStore: emptyMediaObjectStore(),
      adapter: simulator,
    });

    await expect(service.execute(command("readback"))).resolves.toMatchObject({
      command: "readback",
      outcome: "simulation_only",
      state: "needs_review",
    });
    expect(port.recoverSubmitObservation).toHaveBeenCalledOnce();
    expect(port.loadHandoff).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
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
        mediaObjectStore: emptyMediaObjectStore(),
        adapter: new CtripCommunitySimulator(),
      });
      await expect(service.execute(command("prepare"))).rejects.toThrow();
    }
  });
});
