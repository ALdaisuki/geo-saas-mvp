import type { PublicationVariantPayload } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CtripCommunityConnector,
  createDefaultConnectorRegistry,
  DryRunConnector,
  renderCtripCommunityAssistedDraft,
  stableSha256,
  type CtripAssistedSessionPort,
} from "./index.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const otherTenantId = "00000000-0000-4000-8000-000000000099";
const channelAccountId = "00000000-0000-4000-8000-000000000002";
const variantId = "00000000-0000-4000-8000-000000000003";
const receiptId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const attemptId = "00000000-0000-4000-8000-000000000006";
const checkedAt = "2026-07-16T05:00:00.000Z";
const evidenceExpiresAt = "2026-07-17T05:00:00.000Z";
const evidenceHash = "a".repeat(64);

const payload: PublicationVariantPayload = {
  title: "上海出发的周末旅行建议",
  summary: "包含可核验信息和清晰适用条件的旅行建议。",
  bodyMarkdown: "## 行前说明\n\n出发前请再次确认开放时间、价格和交通安排。",
  media: [],
  claims: [],
  contactIds: [],
  tags: ["上海旅行", "周末出游"],
};

const capabilityEvidence = {
  capability: "browser_assisted" as const,
  evidenceType: "browser_screenshot" as const,
  evidenceRefs: ["evidence://ctrip/authorized-session-review"],
  checkedAt,
  articlePublishingVerified: true,
  reconciliationVerified: false,
};

function readyPort(): CtripAssistedSessionPort {
  return {
    validateSession: vi.fn(async (input) => ({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      status: "ready" as const,
      checkedAt,
      adapterVersion: "ctrip-community-web-v1",
      evidenceRef: "evidence://ctrip/session-ready",
    })),
    prepareDraft: vi.fn(async (input) => ({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.requestHash,
      status: "prepared" as const,
      adapterVersion: "ctrip-community-web-v1",
      externalDraftId: "ctrip-draft-123",
      evidenceHash,
    })),
  };
}

function assistedConnector(sessionPort: CtripAssistedSessionPort = readyPort()) {
  return new CtripCommunityConnector({
    capabilityEvidence,
    capabilityEvidenceExpiresAt: evidenceExpiresAt,
    approvedAdapterVersion: "ctrip-community-web-v1",
    sessionPort,
    now: () => new Date("2026-07-16T05:00:30.000Z"),
  });
}

async function renderedAssistedDraft(connector = assistedConnector()) {
  return connector.renderDraft({
    tenantId,
    channelAccountId,
    variantId,
    executionLevel: "assisted",
    payload,
  });
}

describe("Ctrip Community connector registration", () => {
  it("keeps the default registry dry-run and accepts only an explicit Ctrip override", () => {
    expect(createDefaultConnectorRegistry().get("ctrip_community")).toBeInstanceOf(DryRunConnector);

    const connector = assistedConnector();
    expect(
      createDefaultConnectorRegistry({ ctripCommunity: connector }).get("ctrip_community"),
    ).toBe(connector);
  });

  it("rejects incomplete assisted configuration", () => {
    expect(
      () => new CtripCommunityConnector({ capabilityEvidence, sessionPort: undefined }),
    ).toThrow(/configured together/iu);
    expect(() => new CtripCommunityConnector({ sessionPort: readyPort() })).toThrow(
      /configured together/iu,
    );
    expect(
      () => new CtripCommunityConnector({ capabilityEvidence, sessionPort: readyPort() }),
    ).toThrow(/configured together/iu);
  });

  it("rejects expired browser-assisted capability evidence", async () => {
    const connector = new CtripCommunityConnector({
      capabilityEvidence,
      capabilityEvidenceExpiresAt: evidenceExpiresAt,
      approvedAdapterVersion: "ctrip-community-web-v1",
      sessionPort: readyPort(),
      now: () => new Date("2026-07-17T05:00:00.000Z"),
    });

    await expect(connector.probeCapabilities({ checkedAt })).rejects.toMatchObject({
      code: "CAPABILITY_EVIDENCE_INSUFFICIENT",
    });
  });

  it("rejects capability evidence whose review time is still in the future", async () => {
    const connector = new CtripCommunityConnector({
      capabilityEvidence,
      capabilityEvidenceExpiresAt: evidenceExpiresAt,
      approvedAdapterVersion: "ctrip-community-web-v1",
      sessionPort: readyPort(),
      now: () => new Date("2026-07-16T04:59:59.000Z"),
    });

    await expect(connector.probeCapabilities({ checkedAt })).rejects.toMatchObject({
      code: "CAPABILITY_EVIDENCE_INSUFFICIENT",
    });
  });
});

describe("Ctrip Community supervised draft preparation", () => {
  it("uses the same deterministic renderer for Worker handoff and connector preparation", async () => {
    const renderedByConnector = await renderedAssistedDraft();
    const renderedForHandoff = renderCtripCommunityAssistedDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "assisted",
      payload,
    });

    expect(renderedForHandoff).toEqual(renderedByConnector);
  });

  it("prepares one exact audited draft but never claims a public publication", async () => {
    const sessionPort = readyPort();
    const connector = assistedConnector(sessionPort);
    expect(await connector.probeCapabilities({ checkedAt })).toMatchObject({
      platform: "ctrip_community",
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted"],
      evidenceType: "browser_screenshot",
    });

    const renderedDraft = await renderedAssistedDraft(connector);
    expect(renderedDraft).toMatchObject({
      platform: "ctrip_community",
      executionLevel: "assisted",
      payload,
    });
    expect(renderedDraft.manualText).toContain(payload.title);
    expect(renderedDraft.manualText).toContain("#上海旅行");

    const submitInput = {
      tenantId,
      channelAccountId,
      executionLevel: "assisted" as const,
      renderedDraft,
      idempotencyKey: "ctrip-assisted-1",
    };
    await expect(connector.preflight(submitInput)).resolves.toMatchObject({
      ok: true,
      externalWriteAllowed: true,
    });
    const result = await connector.publish({
      ...submitInput,
      receiptId,
      jobId,
      attemptId,
      recordedAt: checkedAt,
    });

    expect(result.outcome).toBe("manual_action_required");
    expect(result.receipt).toMatchObject({
      tenantId,
      jobId,
      attemptId,
      platform: "ctrip_community",
      executionLevel: "assisted",
      evidenceType: "browser_screenshot",
      confirmed: false,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
    });
    expect(sessionPort.prepareDraft).toHaveBeenCalledTimes(1);
    expect(result.receipt.requestHash).toBe(
      stableSha256({
        schemaVersion: "geo.connector.request.v1",
        operation: "prepareDraft",
        platform: "ctrip_community",
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        idempotencyKey: submitInput.idempotencyKey,
        previewHash: renderedDraft.previewHash,
      }),
    );

    await expect(
      connector.captureEvidence({ renderedDraft, receipt: result.receipt }),
    ).resolves.toMatchObject({
      evidenceType: "browser_screenshot",
      previewHash: renderedDraft.previewHash,
      requestHash: result.receipt.requestHash,
      responseHash: result.receipt.responseHash,
    });
  });

  it("reports draft preparation without claiming platform submission", async () => {
    const connector = assistedConnector();
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft,
        idempotencyKey: "draft-state",
      }),
    ).resolves.toMatchObject({
      state: "draft_prepared",
      submitted: false,
      externalDraftId: "ctrip-draft-123",
    });
  });

  it.each([
    ["session_required", "ASSISTED_SESSION_REQUIRED"],
    ["challenge_required", "ASSISTED_CHALLENGE_REQUIRED"],
    ["adapter_drift", "ASSISTED_ADAPTER_DRIFT"],
  ] as const)("fails closed when the session reports %s", async (status, code) => {
    const sessionPort = readyPort();
    vi.mocked(sessionPort.validateSession).mockResolvedValue({
      tenantId,
      channelAccountId,
      status,
      checkedAt,
      adapterVersion: "ctrip-community-web-v1",
      evidenceRef: `evidence://ctrip/${status}`,
    });
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);
    const input = {
      tenantId,
      channelAccountId,
      executionLevel: "assisted" as const,
      renderedDraft,
      idempotencyKey: `ctrip-${status}`,
    };

    await expect(connector.preflight(input)).resolves.toMatchObject({
      ok: false,
      externalWriteAllowed: false,
    });
    await expect(connector.submitDraft(input)).rejects.toMatchObject({ code });
    expect(sessionPort.prepareDraft).not.toHaveBeenCalled();
  });

  it("rejects a bridge response from another tenant before recording evidence", async () => {
    const sessionPort = readyPort();
    vi.mocked(sessionPort.prepareDraft).mockImplementation(async (input) => ({
      tenantId: otherTenantId,
      channelAccountId: input.channelAccountId,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.requestHash,
      status: "prepared",
      adapterVersion: "ctrip-community-web-v1",
      externalDraftId: "wrong-tenant-draft",
      evidenceHash,
    }));
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft,
        idempotencyKey: "wrong-scope",
      }),
    ).rejects.toMatchObject({ code: "ASSISTED_SCOPE_MISMATCH" });
  });

  it("rejects stale session evidence before preparing a draft", async () => {
    const sessionPort = readyPort();
    vi.mocked(sessionPort.validateSession).mockImplementation(async (input) => ({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      status: "ready",
      checkedAt: "2026-07-16T04:00:00.000Z",
      adapterVersion: "ctrip-community-web-v1",
      evidenceRef: "evidence://ctrip/stale-session",
    }));
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft,
        idempotencyKey: "stale-session",
      }),
    ).rejects.toMatchObject({ code: "ASSISTED_SCOPE_MISMATCH" });
    expect(sessionPort.prepareDraft).not.toHaveBeenCalled();
  });

  it("rejects a bridge adapter version that differs from the reviewed preflight", async () => {
    const sessionPort = readyPort();
    vi.mocked(sessionPort.prepareDraft).mockImplementation(async (input) => ({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.requestHash,
      status: "prepared",
      adapterVersion: "ctrip-community-web-v2-unreviewed",
      externalDraftId: "drifted-adapter-draft",
      evidenceHash,
    }));
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft,
        idempotencyKey: "adapter-drift",
      }),
    ).rejects.toMatchObject({ code: "ASSISTED_ADAPTER_DRIFT" });
  });

  it("rejects a malformed prepared-draft reference as a policy error", async () => {
    const sessionPort = readyPort();
    vi.mocked(sessionPort.prepareDraft).mockImplementation(async (input) => ({
      tenantId: input.tenantId,
      channelAccountId: input.channelAccountId,
      previewHash: input.renderedDraft.previewHash,
      requestHash: input.requestHash,
      status: "prepared",
      adapterVersion: "ctrip-community-web-v1",
      externalDraftId: null,
      evidenceHash,
    }));
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft,
        idempotencyKey: "malformed-draft-reference",
      }),
    ).rejects.toMatchObject({ code: "ASSISTED_DRAFT_NOT_PREPARED" });
  });

  it("rejects rendered content mutation before invoking the session bridge", async () => {
    const sessionPort = readyPort();
    const connector = assistedConnector(sessionPort);
    const renderedDraft = await renderedAssistedDraft(connector);

    await expect(
      connector.submitDraft({
        tenantId,
        channelAccountId,
        executionLevel: "assisted",
        renderedDraft: { ...renderedDraft, manualText: `${renderedDraft.manualText}\nchanged` },
        idempotencyKey: "tampered",
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_WRITE_DISABLED" });
    expect(sessionPort.validateSession).not.toHaveBeenCalled();
    expect(sessionPort.prepareDraft).not.toHaveBeenCalled();
  });

  it("never allows unattended execution through the browser-assisted connector", async () => {
    const connector = assistedConnector();
    await expect(
      connector.renderDraft({
        tenantId,
        channelAccountId,
        variantId,
        executionLevel: "unattended",
        payload,
      }),
    ).rejects.toMatchObject({ code: "UNATTENDED_REQUIRES_VERIFIED_API" });
  });
});
