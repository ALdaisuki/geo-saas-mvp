import { createHash } from "node:crypto";

import { renderCtripCommunityAssistedDraft } from "@geo/connectors";
import type { MediaReference, PublicationVariantPayload } from "@geo/contracts";
import { buildVisualBrief, sha256Canonical, sha256Text } from "@geo/core";
import { describe, expect, it, vi } from "vitest";

import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import {
  CTRIP_SIMULATOR_ADAPTER_VERSION,
  type CtripBridgeControlPlane,
  type CtripBridgeHandoffDraft,
  type CtripBridgeMediaAsset,
  type CtripBridgePreparedEvidence,
} from "./types.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  handoff: "10000000-0000-4000-8000-000000000002",
  principal: "10000000-0000-4000-8000-000000000003",
  account: "10000000-0000-4000-8000-000000000004",
  variant: "10000000-0000-4000-8000-000000000005",
  contentVersion: "10000000-0000-4000-8000-000000000006",
  brand: "10000000-0000-4000-8000-000000000007",
  fact: "10000000-0000-4000-8000-000000000008",
  evidence: "10000000-0000-4000-8000-000000000009",
  asset: "10000000-0000-4000-8000-000000000010",
  mediaJob: "10000000-0000-4000-8000-000000000011",
  mediaAttempt: "10000000-0000-4000-8000-000000000012",
};
const now = "2026-07-16T12:00:00.000Z";
const mediaBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
const visualBrief = buildVisualBrief({
  editorialProfile: "guide",
  platform: "ctrip_community",
  role: "cover",
  facts: [
    {
      id: ids.fact,
      brandId: ids.brand,
      text: "The itinerary is confirmed with the traveler before booking.",
      evidenceSourceIds: [ids.evidence],
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: null,
    },
  ],
});
const mediaReference: MediaReference = {
  id: ids.asset,
  sha256: mediaSha256,
  mimeType: "image/png",
  byteLength: mediaBytes.byteLength,
  width: 1280,
  height: 720,
  platform: "ctrip_community",
  role: "cover",
  altText: visualBrief.altText,
  caption: visualBrief.caption,
  factIds: [...visualBrief.factIds],
  visualBrief,
  visualBriefHash: sha256Canonical(visualBrief),
  rights: {
    basis: "generated_terms",
    licenseName: "Fixture generation terms",
    verifiedAt: "2026-07-16T11:58:00.000Z",
  },
  provenance: {
    kind: "generated",
    jobId: ids.mediaJob,
    attemptId: ids.mediaAttempt,
    provider: "fixture",
    providerMode: "fixture",
    model: "fixture-png-v1",
    promptHash: sha256Text(visualBrief.prompt),
    parametersHash: "a".repeat(64),
    generatedAt: "2026-07-16T11:58:00.000Z",
  },
  inspection: {
    assetSha256: mediaSha256,
    status: "passed",
    evaluator: "fixture-inspector",
    evaluatorMode: "fixture",
    evaluatorVersion: "fixture-inspector-v1",
    responseSha256: "9".repeat(64),
    inspectedAt: "2026-07-16T11:59:00.000Z",
    ocrText: "",
    labels: ["fixture", "network:false"],
  },
};
const mediaPayload: PublicationVariantPayload = {
  editorialProfile: "guide",
  title: "Audited Ctrip media guide",
  summary: "A media-bearing simulator draft with verifiable inputs.",
  bodyMarkdown: "# Audited media\n\nVerify all details before booking.",
  media: [mediaReference],
  claims: [],
  contactIds: [],
  tags: ["media", "audit"],
};
const storageKey = `${ids.tenant}/${mediaSha256.slice(0, 2)}/${mediaSha256}.png`;

function bridgeHandoff(
  state: CtripBridgeHandoffDraft["state"],
  payload: PublicationVariantPayload = mediaPayload,
): CtripBridgeHandoffDraft {
  const previewHash = renderCtripCommunityAssistedDraft({
    tenantId: ids.tenant,
    channelAccountId: ids.account,
    variantId: ids.variant,
    executionLevel: "assisted",
    payload,
  }).previewHash;
  return {
    id: ids.handoff,
    tenantId: ids.tenant,
    channelAccountId: ids.account,
    variantId: ids.variant,
    contentVersionId: ids.contentVersion,
    platform: "ctrip_community",
    executionLevel: "assisted",
    state,
    previewHash,
    payloadHash: sha256Canonical(payload),
    adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
    bridgePrincipalId: ids.principal,
    externalDraftId: state === "handoff_pending" ? null : `sim-draft-${ids.handoff}`,
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

function runtime(
  options: {
    readonly state?: CtripBridgeHandoffDraft["state"];
    readonly payload?: PublicationVariantPayload;
    readonly reference?: MediaReference;
    readonly position?: number;
    readonly storedBytes?: Uint8Array;
  } = {},
) {
  const payload = options.payload ?? mediaPayload;
  const initial = bridgeHandoff(options.state ?? "handoff_pending", payload);
  const current = { value: initial };
  const assets: readonly CtripBridgeMediaAsset[] = [
    {
      contentVersionId: ids.contentVersion,
      position: options.position ?? 0,
      bindingPlatform: "ctrip_community",
      bindingRole: (options.reference ?? mediaReference).role,
      bindingAltText: (options.reference ?? mediaReference).altText,
      bindingCaption: (options.reference ?? mediaReference).caption,
      storageKey,
      reference: options.reference ?? mediaReference,
    },
  ];
  let preparedEvidence: CtripBridgePreparedEvidence | undefined;
  const controlPlane: CtripBridgeControlPlane = {
    claimDraftPreparation: vi.fn(async () => undefined),
    claimNextDraftPreparation: vi.fn(async () => null),
    loadHandoff: vi.fn(async () => current.value),
    loadPreparedMediaAssets: vi.fn(async () => assets),
    recordPrepared: vi.fn(async (_context, _handoff, evidence) => {
      preparedEvidence = evidence;
      current.value = {
        ...current.value,
        state: "draft_prepared",
        externalDraftId: evidence.externalDraftId,
      };
    }),
    recordPreparationBlocker: vi.fn(async () => undefined),
    consumeSubmitPermit: vi.fn(async () => {
      current.value = { ...current.value, state: "awaiting_operator_submit" };
    }),
    recordSubmitObservation: vi.fn(async () => {
      current.value = {
        ...current.value,
        state: "readback_pending",
        submitOutcome: "accepted",
        submitEvidenceHash: "d".repeat(64),
        submitEvidenceKind: "simulation",
        submitObservedAt: now,
        submitCandidateExternalId: null,
        submitCandidateExternalUrl: null,
      };
      return {
        receiptId: "10000000-0000-4000-8000-000000000013",
        readbackId: "10000000-0000-4000-8000-000000000014",
      };
    }),
    recoverSubmitObservation: vi.fn(async () => ({
      receiptId: "10000000-0000-4000-8000-000000000013",
      readbackId: "10000000-0000-4000-8000-000000000014",
    })),
    recordReadback: vi.fn(async () => ({
      state: "needs_review" as const,
      externalId: null,
      externalUrl: null,
    })),
  };
  const get = vi.fn(async () => Uint8Array.from(options.storedBytes ?? mediaBytes));
  const simulator = new CtripCommunitySimulator({ now: () => new Date(now) });
  const service = new CtripBridgeCommandService({
    tenantId: ids.tenant,
    bridgePrincipalId: ids.principal,
    controlPlane,
    adapter: simulator,
    mediaObjectStore: { get },
  });
  return {
    controlPlane,
    current,
    get,
    simulator,
    service,
    preparedEvidence: () => preparedEvidence,
  };
}

function command(commandName: "prepare" | "readback") {
  return {
    schemaVersion: "geo.ctrip-bridge.command.v1",
    tenantId: ids.tenant,
    handoffId: ids.handoff,
    requestId: `request-${commandName}`,
    command: commandName,
  };
}

describe("Ctrip audited media payload", () => {
  it("loads exact media bytes for prepare, binds the manifest and renders the image", async () => {
    const state = runtime();

    await expect(state.service.execute(command("prepare"))).resolves.toMatchObject({
      command: "prepare",
      outcome: "prepared",
    });

    expect(state.controlPlane.loadPreparedMediaAssets).toHaveBeenCalledOnce();
    expect(state.get).toHaveBeenCalledWith({ tenantId: ids.tenant, storageKey });
    expect(state.preparedEvidence()?.mediaManifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.simulator.renderHtml(ids.tenant)).toContain(
      `data:image/png;base64,${Buffer.from(mediaBytes).toString("base64")}`,
    );
  });

  it.each([
    ["binding order", { position: 1 }],
    ["asset metadata", { reference: { ...mediaReference, width: 1279 } }],
    [
      "inspection status",
      {
        payload: {
          ...mediaPayload,
          media: [
            {
              ...mediaReference,
              inspection: { ...mediaReference.inspection, status: "failed" as const },
            },
          ],
        },
        reference: {
          ...mediaReference,
          inspection: { ...mediaReference.inspection, status: "failed" as const },
        },
      },
    ],
    ["stored bytes", { storedBytes: Uint8Array.from([...mediaBytes.slice(0, -1), 5]) }],
  ])("rejects changed %s before adapter prepare", async (_label, options) => {
    const state = runtime(options);
    const adapterPrepare = vi.spyOn(state.simulator, "prepare");

    await expect(state.service.execute(command("prepare"))).rejects.toThrow();

    expect(adapterPrepare).not.toHaveBeenCalled();
    expect(state.controlPlane.recordPrepared).not.toHaveBeenCalled();
  });

  it("does not reload media during submit or readback reconciliation", async () => {
    const state = runtime();
    await state.service.execute(command("prepare"));
    vi.mocked(state.controlPlane.loadPreparedMediaAssets).mockClear();
    state.get.mockClear();
    vi.mocked(state.controlPlane.loadPreparedMediaAssets).mockRejectedValue(
      new Error("media unavailable"),
    );
    state.get.mockRejectedValue(new Error("media unavailable"));
    const restartedSimulator = new CtripCommunitySimulator({ now: () => new Date(now) });
    const restartedService = new CtripBridgeCommandService({
      tenantId: ids.tenant,
      bridgePrincipalId: ids.principal,
      controlPlane: state.controlPlane,
      adapter: restartedSimulator,
      mediaObjectStore: { get: state.get },
    });

    await expect(
      restartedService.execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId: ids.tenant,
        handoffId: ids.handoff,
        requestId: "request-submit",
        command: "submit",
        submitPermit: "f".repeat(64),
      }),
    ).resolves.toMatchObject({ command: "submit", outcome: "accepted" });
    expect(state.controlPlane.loadPreparedMediaAssets).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();

    await expect(restartedService.execute(command("readback"))).resolves.toMatchObject({
      command: "readback",
      outcome: "simulation_only",
    });
    expect(state.controlPlane.loadPreparedMediaAssets).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
  });
});
