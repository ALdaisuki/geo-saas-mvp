import type { AuditArtifact, PublicationVariantPayload } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
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
});
