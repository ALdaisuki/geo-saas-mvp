import { createHash } from "node:crypto";

import type { AuditArtifact, MediaReference, PublicationVariantPayload } from "@geo/contracts";
import { buildVisualBrief, sha256Canonical, sha256Text } from "@geo/core";
import { describe, expect, it } from "vitest";

import {
  createManualPublicationPackageExport,
  ManualPublicationPackageExportError,
  type ManualPublicationPackageRepository,
  type ManualPublicationPackageSource,
} from "./manual-publication-package.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  otherTenant: "20000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000101",
  variant: "10000000-0000-4000-8000-000000000603",
  account: "10000000-0000-4000-8000-000000000701",
  artifact: "10000000-0000-4000-8000-000000000801",
  brand: "10000000-0000-4000-8000-000000000901",
  fact: "10000000-0000-4000-8000-000000000902",
  evidence: "10000000-0000-4000-8000-000000000903",
  asset: "10000000-0000-4000-8000-000000000904",
  mediaJob: "10000000-0000-4000-8000-000000000905",
  mediaAttempt: "10000000-0000-4000-8000-000000000906",
};
const exportedAt = "2026-07-14T01:00:00.000Z";
const context = { tenantId: ids.tenant, actorId: ids.actor, requestId: "request:test" };
const payload: PublicationVariantPayload = {
  title: "Audited Shanghai weekend guide",
  summary: "A verifiable guide with clear service boundaries.",
  bodyMarkdown: "Verify the itinerary and current availability before booking.",
  media: [],
  claims: [],
  contactIds: [],
  tags: ["Shanghai", "weekend"],
};
const artifact: AuditArtifact = {
  id: ids.artifact,
  tenantId: ids.tenant,
  variantId: ids.variant,
  channelAccountId: ids.account,
  platform: "toutiao",
  payloadHash: sha256Canonical(payload),
  factSnapshotHash: "b".repeat(64),
  brandSnapshotHash: "e".repeat(64),
  mediaSnapshotHash: "f".repeat(64),
  policyHash: "c".repeat(64),
  policyVersion: "travel-v1",
  auditHash: "d".repeat(64),
  status: "passed",
  findings: [],
  createdAt: "2026-07-14T00:00:00.000Z",
  expiresAt: "2026-07-14T02:00:00.000Z",
};

const mediaBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
const visualBrief = buildVisualBrief({
  editorialProfile: "guide",
  platform: "toutiao",
  role: "cover",
  facts: [
    {
      id: ids.fact,
      brandId: ids.brand,
      text: "The final itinerary is confirmed before booking.",
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
  platform: "toutiao",
  role: "cover",
  altText: visualBrief.altText,
  caption: visualBrief.caption,
  factIds: [...visualBrief.factIds],
  visualBrief,
  visualBriefHash: sha256Canonical(visualBrief),
  rights: {
    basis: "generated_terms",
    licenseName: "Fixture generation terms",
    verifiedAt: "2026-07-14T00:30:00.000Z",
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
    generatedAt: "2026-07-14T00:30:00.000Z",
  },
  inspection: {
    assetSha256: mediaSha256,
    status: "passed",
    evaluator: "fixture-inspector",
    evaluatorMode: "fixture",
    evaluatorVersion: "fixture-inspector-v1",
    responseSha256: "9".repeat(64),
    inspectedAt: "2026-07-14T00:31:00.000Z",
    ocrText: "",
    labels: ["fixture", "network:false"],
  },
};
const payloadWithMedia: PublicationVariantPayload = {
  ...payload,
  editorialProfile: "guide",
  media: [mediaReference],
};
const storageKey = `${ids.tenant}/${mediaSha256.slice(0, 2)}/${mediaSha256}.png`;

function sourceWithMedia(
  overrides: Partial<ManualPublicationPackageSource> = {},
): ManualPublicationPackageSource {
  return source({
    artifact: { ...artifact, payloadHash: sha256Canonical(payloadWithMedia) },
    payload: payloadWithMedia,
    mediaAssets: [{ storageKey, reference: mediaReference }],
    ...overrides,
  });
}

function source(
  overrides: Partial<ManualPublicationPackageSource> = {},
): ManualPublicationPackageSource {
  return {
    artifact,
    payload,
    account: {
      id: ids.account,
      platform: "toutiao",
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      status: "active",
    },
    mediaAssets: [],
    ...overrides,
  };
}

function repository(value: ManualPublicationPackageSource | null = source()) {
  const records: Parameters<
    ManualPublicationPackageRepository["recordManualPublicationPackageExport"]
  >[1][] = [];
  const contexts: Parameters<
    ManualPublicationPackageRepository["loadManualPublicationPackageSource"]
  >[0][] = [];
  const result: ManualPublicationPackageRepository = {
    loadManualPublicationPackageSource: async (requestContext) => {
      contexts.push(requestContext);
      return value;
    },
    recordManualPublicationPackageExport: async (_requestContext, input) => {
      records.push(input);
    },
  };
  return { result, records, contexts };
}

describe("manual publication package export", () => {
  it("exports an audited dry-run preview and records an explicitly non-published artifact", async () => {
    const fake = repository();

    const result = await createManualPublicationPackageExport({
      repository: fake.result,
      context,
      auditArtifactId: ids.artifact,
      exportedAt,
    });

    expect(result).toMatchObject({
      tenantId: ids.tenant,
      auditArtifactId: ids.artifact,
      variantId: ids.variant,
      channelAccountId: ids.account,
      platform: "toutiao",
      executionLevel: "dry_run",
      evidenceType: "preview",
      requiresManualAction: true,
      publicationStatus: "not_published",
      confirmed: false,
    });
    expect(result.files["manifest.json"]).toContain('"publicationStatus":"not_published"');
    expect(result.files["NOT_PUBLISHED.txt"]).toContain("NOT PUBLISHED");
    expect(fake.contexts).toEqual([context]);
    expect(fake.records).toEqual([
      {
        auditArtifactId: ids.artifact,
        variantId: ids.variant,
        channelAccountId: ids.account,
        packageHash: result.packageHash,
        previewHash: result.previewHash,
        exportedAt,
      },
    ]);
  });

  it("fails closed for missing or cross-tenant sources without recording an export", async () => {
    for (const value of [null, source({ artifact: { ...artifact, tenantId: ids.otherTenant } })]) {
      const fake = repository(value);
      await expect(
        createManualPublicationPackageExport({
          repository: fake.result,
          context,
          auditArtifactId: ids.artifact,
          exportedAt,
        }),
      ).rejects.toMatchObject({ code: "MANUAL_PACKAGE_SOURCE_NOT_FOUND", statusCode: 404 });
      expect(fake.records).toEqual([]);
    }
  });

  it.each([
    [
      "failed audit",
      source({ artifact: { ...artifact, status: "failed" } }),
      "MANUAL_PACKAGE_AUDIT_NOT_PASSED",
    ],
    [
      "expired audit",
      source({ artifact: { ...artifact, expiresAt: exportedAt } }),
      "MANUAL_PACKAGE_AUDIT_EXPIRED",
    ],
    [
      "misconfigured manual account",
      source({
        account: {
          id: ids.account,
          platform: "toutiao",
          capability: "manual_only",
          supportedExecutionLevels: ["dry_run", "assisted"],
          status: "active",
        },
      }),
      "MANUAL_PACKAGE_ACCOUNT_UNSUPPORTED",
    ],
  ] as const)("rejects %s before emitting an artifact", async (_label, value, code) => {
    const fake = repository(value);
    await expect(
      createManualPublicationPackageExport({
        repository: fake.result,
        context,
        auditArtifactId: ids.artifact,
        exportedAt,
      }),
    ).rejects.toEqual(expect.objectContaining({ code, statusCode: 422 }));
    expect(fake.records).toEqual([]);
  });

  it("exports only a payload whose hash and scope are bound by the audit", async () => {
    const fake = repository(source({ payload: { ...payload, title: "Changed after audit" } }));
    await expect(
      createManualPublicationPackageExport({
        repository: fake.result,
        context,
        auditArtifactId: ids.artifact,
        exportedAt,
      }),
    ).rejects.toBeInstanceOf(ManualPublicationPackageExportError);
    expect(fake.records).toEqual([]);
  });

  it("exports the exact audited media bytes with a hash-bound manifest", async () => {
    const fake = repository(sourceWithMedia());
    const reads: Array<{ tenantId: string; storageKey: string }> = [];

    const result = await createManualPublicationPackageExport({
      repository: fake.result,
      context,
      auditArtifactId: ids.artifact,
      exportedAt,
      mediaObjectStore: {
        get: async (input) => {
          reads.push(input);
          return mediaBytes;
        },
      },
    });

    expect(reads).toEqual([{ tenantId: ids.tenant, storageKey }]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        mediaAssetId: ids.asset,
        mimeType: "image/png",
        sha256: mediaSha256,
        byteLength: mediaBytes.byteLength,
        base64: Buffer.from(mediaBytes).toString("base64"),
        fileName: expect.stringMatching(/^media\/01-cover-.+\.png$/u),
      }),
    ]);
    const exportedBytes = Buffer.from(result.attachments[0]?.base64 ?? "", "base64");
    expect(createHash("sha256").update(exportedBytes).digest("hex")).toBe(mediaSha256);
    expect(JSON.parse(result.files["media-manifest.json"] ?? "{}")).toMatchObject({
      payloadHash: sha256Canonical(payloadWithMedia),
      entries: [
        {
          mediaAssetId: ids.asset,
          sha256: mediaSha256,
          byteLength: mediaBytes.byteLength,
          platform: "toutiao",
          role: "cover",
          factIds: [ids.fact],
          visualBriefHash: sha256Canonical(visualBrief),
        },
      ],
    });
  });

  it.each([
    ["missing asset", sourceWithMedia({ mediaAssets: [] }), undefined],
    ["missing object store", sourceWithMedia(), undefined],
    [
      "tampered object bytes",
      sourceWithMedia(),
      { get: async () => Uint8Array.from([...mediaBytes, 5]) },
    ],
  ] as const)("fails closed for %s", async (label, value, mediaObjectStore) => {
    const fake = repository(value);
    await expect(
      createManualPublicationPackageExport({
        repository: fake.result,
        context,
        auditArtifactId: ids.artifact,
        exportedAt,
        ...(label === "missing asset"
          ? { mediaObjectStore: { get: async () => mediaBytes } }
          : mediaObjectStore === undefined
            ? {}
            : { mediaObjectStore }),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_PACKAGE_SOURCE_INVALID", statusCode: 422 });
    expect(fake.records).toEqual([]);
  });
});
