import type { Platform, PublicationReceipt, PublicationVariantPayload } from "@geo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertConfirmedLivePublication,
  buildCapabilityReport,
  ConnectorPolicyError,
  createDefaultConnectorRegistry,
  DryRunConnector,
  exportManualPackage,
  isConfirmedLivePublication,
} from "./index.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const channelAccountId = "00000000-0000-4000-8000-000000000002";
const variantId = "00000000-0000-4000-8000-000000000003";
const receiptId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const attemptId = "00000000-0000-4000-8000-000000000006";
const checkedAt = "2026-07-13T12:00:00.000Z";
const payloadHash = "a".repeat(64);
const auditHash = "b".repeat(64);

const payload: PublicationVariantPayload = {
  title: "上海出发的周末旅行建议",
  summary: "包含可核验信息和清晰适用条件的旅行建议。",
  bodyMarkdown: "出发前请再次确认开放时间、价格和交通安排。",
  media: [],
  claims: [],
  contactIds: [],
  tags: ["上海旅行", "周末出游"],
};

const platforms: readonly Platform[] = ["toutiao", "sohu", "ctrip_community"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(platforms)("%s dry-run connector", (platform) => {
  it("stays manual-only and produces stable, unconfirmed preview evidence without network writes", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access is forbidden in dry-run tests");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const connector = createDefaultConnectorRegistry().get(platform);
    const capability = await connector.probeCapabilities({ checkedAt });
    expect(capability).toMatchObject({
      platform,
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run", "assisted"],
      evidenceType: "preview",
    });

    const input = {
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "dry_run" as const,
      payload,
    };
    const firstDraft = await connector.renderDraft(input);
    const secondDraft = await connector.renderDraft(input);
    expect(firstDraft.previewHash).toBe(secondDraft.previewHash);

    const publishInput = {
      ...input,
      renderedDraft: firstDraft,
      idempotencyKey: "publication-key-1",
      receiptId,
      jobId,
      attemptId,
      recordedAt: checkedAt,
    };
    const first = await connector.publish(publishInput);
    const second = await connector.publish(publishInput);
    expect(first.receipt.requestHash).toBe(second.receipt.requestHash);
    expect(first.receipt.responseHash).toBe(second.receipt.responseHash);
    expect(first.receipt).toMatchObject({
      platform,
      executionLevel: "dry_run",
      evidenceType: "preview",
      confirmed: false,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
    });

    const status = await connector.pollStatus({
      tenantId,
      channelAccountId,
      executionLevel: "dry_run",
      requestHash: first.receipt.requestHash,
    });
    expect(status).toEqual({
      status: "preview_only",
      confirmed: false,
      externalId: null,
      externalUrl: null,
    });

    const reconciled = await connector.reconcile({
      tenantId,
      channelAccountId,
      executionLevel: "dry_run",
      receipt: first.receipt,
    });
    expect(reconciled.confirmed).toBe(false);

    const evidence = await connector.captureEvidence({
      renderedDraft: firstDraft,
      receipt: first.receipt,
    });
    expect(evidence.evidenceType).toBe("preview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects every unattended request because no verified API capability exists", async () => {
    const connector = createDefaultConnectorRegistry().get(platform);
    await expect(
      connector.renderDraft({
        tenantId,
        channelAccountId,
        variantId,
        executionLevel: "unattended",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "UNATTENDED_REQUIRES_VERIFIED_API",
      platform,
      executionLevel: "unattended",
    });
  });
});

describe("capability evidence guard", () => {
  it("does not upgrade a connector based on platform name or missing evidence", () => {
    expect(buildCapabilityReport("toutiao", checkedAt)).toMatchObject({
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run", "assisted"],
    });

    expect(() =>
      buildCapabilityReport("toutiao", checkedAt, {
        capability: "public_api",
        evidenceType: "api_response",
        evidenceRefs: [],
        checkedAt,
        articlePublishingVerified: true,
        reconciliationVerified: true,
      }),
    ).toThrowError(ConnectorPolicyError);
  });

  it("allows unattended capability only with current publish and reconciliation evidence", () => {
    expect(
      buildCapabilityReport("toutiao", checkedAt, {
        capability: "public_api",
        evidenceType: "platform_readback",
        evidenceRefs: ["evidence://verified-public-api-contract-and-readback"],
        checkedAt,
        articlePublishingVerified: true,
        reconciliationVerified: true,
      }),
    ).toMatchObject({
      capability: "public_api",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });

    expect(() =>
      buildCapabilityReport("sohu", checkedAt, {
        capability: "partner_api",
        evidenceType: "api_response",
        evidenceRefs: ["evidence://publish-only"],
        checkedAt,
        articlePublishingVerified: true,
        reconciliationVerified: false,
      }),
    ).toThrowError(/reconciliation evidence/);
  });
});

describe("manual package and receipt truthfulness", () => {
  it("exports a stable audited package without claiming publication", async () => {
    const connector = createDefaultConnectorRegistry().get("sohu");
    expect(connector).toBeInstanceOf(DryRunConnector);
    const dryRunConnector = connector as DryRunConnector;
    const renderedDraft = await connector.renderDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "assisted",
      payload,
    });
    const input = { renderedDraft, payloadHash, auditHash, exportedAt: checkedAt };
    const first = await exportManualPackage(dryRunConnector, input);
    const second = await exportManualPackage(dryRunConnector, input);

    expect(first.packageHash).toBe(second.packageHash);
    expect(first).toMatchObject({
      platform: "sohu",
      executionLevel: "assisted",
      evidenceType: "preview",
      payloadHash,
      auditHash,
    });
    expect(first.files["article.md"]).toContain(payload.title);
    expect(first.files["instructions.txt"]).toContain("最终发布");
  });

  it("never accepts preview evidence as proof of a live publication", () => {
    const forgedPreview = {
      id: receiptId,
      tenantId,
      jobId,
      attemptId,
      platform: "toutiao",
      executionLevel: "assisted",
      evidenceType: "preview",
      requestHash: payloadHash,
      responseHash: auditHash,
      externalId: "forged-id",
      externalUrl: "https://example.invalid/forged",
      publishedAt: checkedAt,
      recordedAt: checkedAt,
      confirmed: true,
    } satisfies PublicationReceipt;

    expect(isConfirmedLivePublication(forgedPreview)).toBe(false);
    expect(() => assertConfirmedLivePublication(forgedPreview)).toThrowError(
      /cannot prove a live publication/,
    );
  });
});
