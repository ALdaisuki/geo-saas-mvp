import { createHash } from "node:crypto";

import type { Platform, PublicationReceipt, PublicationVariantPayload } from "@geo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertConfirmedLivePublication,
  buildCapabilityReport,
  ConnectorRegistry,
  ConnectorPolicyError,
  createDefaultConnectorRegistry,
  createPlatformStatusSummary,
  DryRunConnector,
  exportManualPackage,
  isConfirmedLivePublication,
  PLATFORM_STATUS_SUMMARY_MAX_LENGTH,
  stableSha256,
  type GitHubSourcedPlatformConnector,
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

const platforms: readonly Platform[] = [
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
];

const mediaBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
const visualBrief = {
  schemaVersion: "geo.visual-brief.v1" as const,
  editorialProfile: "guide" as const,
  platform: "sohu" as const,
  role: "cover" as const,
  aspectRatio: "16:9" as const,
  factIds: [jobId],
  prompt: "Verified travel service illustration without text",
  negativePrompt: "text, phone, QR code, watermark",
  altText: "Verified travel service illustration",
  caption: "Illustration bound to a verified service fact",
};
const mediaReference = {
  id: attemptId,
  sha256: mediaSha256,
  mimeType: "image/png" as const,
  byteLength: mediaBytes.byteLength,
  width: 1280,
  height: 720,
  platform: "sohu" as const,
  role: "cover" as const,
  altText: visualBrief.altText,
  caption: visualBrief.caption,
  factIds: visualBrief.factIds,
  visualBrief,
  visualBriefHash: stableSha256(visualBrief),
  rights: {
    basis: "generated_terms" as const,
    licenseName: "Fixture generation terms",
    verifiedAt: checkedAt,
  },
  provenance: {
    kind: "generated" as const,
    jobId,
    attemptId: receiptId,
    provider: "fixture",
    providerMode: "fixture" as const,
    model: "fixture-png-v1",
    promptHash: createHash("sha256").update(visualBrief.prompt).digest("hex"),
    parametersHash: "c".repeat(64),
    generatedAt: checkedAt,
  },
  inspection: {
    assetSha256: mediaSha256,
    status: "passed" as const,
    evaluator: "fixture-inspector",
    evaluatorMode: "fixture" as const,
    evaluatorVersion: "fixture-inspector-v1",
    responseSha256: "d".repeat(64),
    inspectedAt: checkedAt,
    ocrText: "",
    labels: ["fixture"],
  },
};
const mediaPayload: PublicationVariantPayload = { ...payload, media: [mediaReference] };
const mediaAttachment = {
  mediaAssetId: mediaReference.id,
  mimeType: mediaReference.mimeType,
  sha256: mediaReference.sha256,
  byteLength: mediaReference.byteLength,
  base64: Buffer.from(mediaBytes).toString("base64"),
};

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
      supportedExecutionLevels: ["dry_run"],
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
    expect(first).toMatchObject({
      outcome: "preview_only",
      submissionOutcome: "not_submitted",
      moderationState: "unknown",
      readbackState: "not_attempted",
      externalId: null,
      externalUrl: null,
      evidenceHash: null,
      platformStatusSummary: "dry_run_preview",
      confirmed: false,
    });
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
      submissionOutcome: "not_submitted",
      moderationState: "unknown",
      readbackState: "not_attempted",
      confirmed: false,
      externalId: null,
      externalUrl: null,
      evidenceHash: null,
      platformStatusSummary: "dry_run_preview",
    });

    const reconciled = await connector.reconcile({
      tenantId,
      channelAccountId,
      executionLevel: "dry_run",
      receipt: first.receipt,
    });
    expect(reconciled).toMatchObject({
      outcome: "not_published",
      submissionOutcome: "not_submitted",
      moderationState: "unknown",
      readbackState: "not_attempted",
      externalId: null,
      externalUrl: null,
      evidenceHash: null,
      platformStatusSummary: "dry_run_not_published",
      confirmed: false,
    });

    const evidence = await connector.captureEvidence({
      renderedDraft: firstDraft,
      receipt: first.receipt,
    });
    expect(evidence.evidenceType).toBe("preview");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["assisted", "unattended"] as const)(
    "rejects %s because manual package export is not an execution level",
    async (executionLevel) => {
      const connector = createDefaultConnectorRegistry().get(platform);
      await expect(
        connector.renderDraft({
          tenantId,
          channelAccountId,
          variantId,
          executionLevel,
          payload,
        }),
      ).rejects.toMatchObject({
        code:
          executionLevel === "unattended"
            ? "UNATTENDED_REQUIRES_VERIFIED_API"
            : "EXECUTION_LEVEL_UNSUPPORTED",
        platform,
        executionLevel,
      });
    },
  );
});

describe("delivery observation contract", () => {
  it("bounds platform status summaries before they enter connector results", () => {
    expect(createPlatformStatusSummary("  reviewing  ")).toBe("reviewing");
    expect(() => createPlatformStatusSummary(" ")).toThrow(/must contain/iu);
    expect(() =>
      createPlatformStatusSummary("x".repeat(PLATFORM_STATUS_SUMMARY_MAX_LENGTH + 1)),
    ).toThrow(/must contain/iu);
  });
});

describe("GitHub-sourced outbound connector registration", () => {
  function sourcedConnector(
    operations: readonly (
      | "session_probe"
      | "draft_write"
      | "media_upload"
      | "final_submit"
      | "moderation_readback"
      | "public_readback"
    )[],
  ): GitHubSourcedPlatformConnector {
    return Object.assign(createDefaultConnectorRegistry().get("toutiao"), {
      outboundImplementation: {
        schemaVersion: "geo.outbound-implementation-sources.v1" as const,
        platform: "toutiao" as const,
        adapterVersion: "toutiao-browser-draft-v1",
        stage: "draft_only" as const,
        reviewedAt: checkedAt,
        sources: [
          {
            repositoryUrl: "https://github.com/example/toutiao-publisher",
            commitSha: "a".repeat(40),
            sourcePaths: ["platforms/toutiao.py"],
            operations,
            licenseSpdx: null,
          },
        ],
      },
    });
  }

  it("accepts only a platform-matched, stage-complete immutable source manifest", () => {
    const sourced = sourcedConnector(["session_probe", "draft_write", "media_upload"]);
    expect(createDefaultConnectorRegistry({ primaryDistribution: [sourced] }).get("toutiao")).toBe(
      sourced,
    );

    const incomplete = sourcedConnector(["session_probe"]);
    expect(() => createDefaultConnectorRegistry({ primaryDistribution: [incomplete] })).toThrow(
      /do not cover required operations/iu,
    );

    const wrongPlatform = sourcedConnector(["session_probe", "draft_write", "media_upload"]);
    Object.assign(wrongPlatform, {
      ...wrongPlatform.outboundImplementation,
      outboundImplementation: {
        ...wrongPlatform.outboundImplementation,
        platform: "sohu",
      },
    });
    expect(() => createDefaultConnectorRegistry({ primaryDistribution: [wrongPlatform] })).toThrow(
      /platform must match/iu,
    );
  });

  it("enforces provenance in direct constructor and register paths", () => {
    const wrappedDryRun = new Proxy(createDefaultConnectorRegistry().get("toutiao"), {});

    expect(() => new ConnectorRegistry([wrappedDryRun])).toThrowError(
      expect.objectContaining({
        code: "OUTBOUND_SOURCE_EVIDENCE_REQUIRED",
        platform: "toutiao",
      }),
    );

    const registry = new ConnectorRegistry();
    expect(() => registry.register(wrappedDryRun)).toThrowError(
      expect.objectContaining({ code: "OUTBOUND_SOURCE_EVIDENCE_REQUIRED" }),
    );

    const sourced = sourcedConnector(["session_probe", "draft_write", "media_upload"]);
    expect(new ConnectorRegistry([sourced]).get("toutiao")).toBe(sourced);
    registry.register(sourced);
    expect(registry.get("toutiao")).toBe(sourced);
  });
});

describe("capability evidence guard", () => {
  it("does not upgrade a connector based on platform name or missing evidence", () => {
    expect(buildCapabilityReport("toutiao", checkedAt)).toMatchObject({
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
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

    expect(
      buildCapabilityReport("toutiao", checkedAt, {
        capability: "browser_assisted",
        evidenceType: "platform_readback",
        evidenceRefs: ["adapter:toutiao-browser-unattended-v1"],
        checkedAt,
        articlePublishingVerified: true,
        reconciliationVerified: true,
        unattendedBrowserVerified: true,
      }),
    ).toMatchObject({
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
    });

    expect(
      buildCapabilityReport("toutiao", checkedAt, {
        capability: "browser_assisted",
        evidenceType: "platform_readback",
        evidenceRefs: ["adapter:ctrip-community-browser-unattended-v1"],
        checkedAt,
        articlePublishingVerified: true,
        reconciliationVerified: true,
        unattendedBrowserVerified: true,
      }),
    ).toMatchObject({
      capability: "browser_assisted",
      supportedExecutionLevels: ["dry_run", "assisted"],
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
      executionLevel: "dry_run",
      payload,
    });
    const artifact = {
      id: receiptId,
      tenantId,
      variantId,
      channelAccountId,
      platform: "sohu" as const,
      payloadHash: stableSha256(renderedDraft.payload),
      factSnapshotHash: "c".repeat(64),
      brandSnapshotHash: "e".repeat(64),
      mediaSnapshotHash: "f".repeat(64),
      policyHash: "d".repeat(64),
      policyVersion: "travel-v1",
      auditHash,
      status: "passed" as const,
      findings: [],
      createdAt: "2026-07-13T11:00:00.000Z",
      expiresAt: "2026-07-13T13:00:00.000Z",
    };
    const input = {
      renderedDraft,
      auditArtifact: artifact,
      mediaAttachments: [],
      exportedAt: checkedAt,
    };
    const first = await exportManualPackage(dryRunConnector, input);
    const second = await exportManualPackage(dryRunConnector, input);

    expect(first.packageHash).toBe(second.packageHash);
    expect(first).toMatchObject({
      platform: "sohu",
      executionLevel: "dry_run",
      evidenceType: "preview",
      auditArtifactId: receiptId,
      payloadHash: artifact.payloadHash,
      auditHash,
      requiresManualAction: true,
      publicationStatus: "not_published",
      confirmed: false,
    });
    expect(first.files["manifest.json"]).toContain('"publicationStatus":"not_published"');
    expect(first.files["NOT_PUBLISHED.txt"]).toMatch(/manual action is required/iu);
    expect(first.files["article.md"]).toContain(payload.title);
    expect(first.files["instructions.txt"]).toContain("最终发布");
  });

  it("binds one exact-byte attachment and media manifest entry to every payload reference", async () => {
    const connector = createDefaultConnectorRegistry().get("sohu") as DryRunConnector;
    const renderedDraft = await connector.renderDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "dry_run",
      payload: mediaPayload,
    });
    const artifact = {
      id: receiptId,
      tenantId,
      variantId,
      channelAccountId,
      platform: "sohu" as const,
      payloadHash: stableSha256(renderedDraft.payload),
      factSnapshotHash: "c".repeat(64),
      brandSnapshotHash: "e".repeat(64),
      mediaSnapshotHash: "f".repeat(64),
      policyHash: "d".repeat(64),
      policyVersion: "travel-v1",
      auditHash,
      status: "passed" as const,
      findings: [],
      createdAt: "2026-07-13T11:00:00.000Z",
      expiresAt: "2026-07-13T13:00:00.000Z",
    };

    const result = await exportManualPackage(connector, {
      renderedDraft,
      auditArtifact: artifact,
      mediaAttachments: [mediaAttachment],
      exportedAt: checkedAt,
    });

    expect(result.attachments).toEqual([
      expect.objectContaining({
        fileName: expect.stringMatching(/^media\/01-cover-.*\.png$/u),
        mediaAssetId: mediaReference.id,
        sha256: mediaSha256,
        byteLength: mediaBytes.byteLength,
        base64: mediaAttachment.base64,
      }),
    ]);
    const manifest = JSON.parse(result.files["media-manifest.json"] ?? "null") as {
      payloadHash: string;
      entries: Array<Record<string, unknown>>;
    };
    expect(manifest.payloadHash).toBe(stableSha256(renderedDraft.payload));
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        mediaAssetId: mediaReference.id,
        sha256: mediaSha256,
        mimeType: "image/png",
        byteLength: mediaBytes.byteLength,
      }),
    ]);
    const bytes = Buffer.from(result.attachments[0]?.base64 ?? "", "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(mediaSha256);
  });

  it.each([
    ["missing", []],
    ["extra", [mediaAttachment, { ...mediaAttachment, mediaAssetId: receiptId }]],
    [
      "tampered",
      [
        {
          ...mediaAttachment,
          base64: Buffer.from(Uint8Array.from([...mediaBytes, 5])).toString("base64"),
        },
      ],
    ],
  ] as const)("rejects %s media attachment bytes", async (_label, mediaAttachments) => {
    const connector = createDefaultConnectorRegistry().get("sohu") as DryRunConnector;
    const renderedDraft = await connector.renderDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "dry_run",
      payload: mediaPayload,
    });
    await expect(
      exportManualPackage(connector, {
        renderedDraft,
        auditArtifact: {
          id: receiptId,
          tenantId,
          variantId,
          channelAccountId,
          platform: "sohu",
          payloadHash: stableSha256(renderedDraft.payload),
          factSnapshotHash: "c".repeat(64),
          brandSnapshotHash: "e".repeat(64),
          mediaSnapshotHash: "f".repeat(64),
          policyHash: "d".repeat(64),
          policyVersion: "travel-v1",
          auditHash,
          status: "passed",
          findings: [],
          createdAt: "2026-07-13T11:00:00.000Z",
          expiresAt: "2026-07-13T13:00:00.000Z",
        },
        mediaAttachments,
        exportedAt: checkedAt,
      }),
    ).rejects.toThrow(/attachment/iu);
  });

  it("rejects failed, expired, or scope-mismatched audit artifacts", async () => {
    const connector = createDefaultConnectorRegistry().get("toutiao") as DryRunConnector;
    const renderedDraft = await connector.renderDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "dry_run",
      payload,
    });
    const artifact = {
      id: receiptId,
      tenantId,
      variantId,
      channelAccountId,
      platform: "toutiao" as const,
      payloadHash: stableSha256(renderedDraft.payload),
      factSnapshotHash: "c".repeat(64),
      brandSnapshotHash: "e".repeat(64),
      mediaSnapshotHash: "f".repeat(64),
      policyHash: "d".repeat(64),
      policyVersion: "travel-v1",
      auditHash,
      status: "passed" as const,
      findings: [],
      createdAt: "2026-07-13T11:00:00.000Z",
      expiresAt: "2026-07-13T13:00:00.000Z",
    };

    await expect(
      exportManualPackage(connector, {
        renderedDraft,
        auditArtifact: { ...artifact, status: "failed" },
        mediaAttachments: [],
        exportedAt: checkedAt,
      }),
    ).rejects.toThrow(/passed audit/iu);
    await expect(
      exportManualPackage(connector, {
        renderedDraft,
        auditArtifact: { ...artifact, expiresAt: "2026-07-13T11:30:00.000Z" },
        mediaAttachments: [],
        exportedAt: checkedAt,
      }),
    ).rejects.toThrow(/expired/iu);
    await expect(
      exportManualPackage(connector, {
        renderedDraft,
        auditArtifact: { ...artifact, tenantId: "00000000-0000-4000-8000-000000000099" },
        mediaAttachments: [],
        exportedAt: checkedAt,
      }),
    ).rejects.toThrow(/scope/iu);
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
