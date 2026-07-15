import { auditArtifactSchema } from "@geo/contracts";

import { assertExecutionAllowed, buildCapabilityReport } from "./capabilities.js";
import { canonicalJson, stableSha256 } from "./hash.js";
import type { DryRunConnector } from "./dry-run-connector.js";
import type { ManualPackageInput, ManualPublicationPackage } from "./types.js";

export async function exportManualPackage(
  connector: DryRunConnector,
  input: ManualPackageInput,
): Promise<ManualPublicationPackage> {
  const report = buildCapabilityReport(connector.platform, input.exportedAt);
  assertExecutionAllowed(report, "dry_run");

  if (input.renderedDraft.platform !== connector.platform) {
    throw new TypeError("Rendered draft platform does not match the connector");
  }
  if (input.renderedDraft.executionLevel !== "dry_run") {
    throw new TypeError("Manual publication packages require a dry-run preview");
  }

  if (!Number.isFinite(Date.parse(input.exportedAt))) {
    throw new TypeError("Manual package exportedAt must be an ISO timestamp");
  }
  const artifact = auditArtifactSchema.parse(input.auditArtifact);
  if (artifact.status !== "passed") {
    throw new TypeError("Manual publication packages require a passed audit artifact");
  }
  if (Date.parse(artifact.expiresAt) <= Date.parse(input.exportedAt)) {
    throw new TypeError("Manual publication package audit artifact has expired");
  }
  if (
    artifact.tenantId !== input.renderedDraft.tenantId ||
    artifact.variantId !== input.renderedDraft.variantId ||
    artifact.channelAccountId !== input.renderedDraft.channelAccountId ||
    artifact.platform !== connector.platform
  ) {
    throw new TypeError("Audit artifact scope does not match the dry-run preview");
  }
  if (artifact.payloadHash !== stableSha256(input.renderedDraft.payload)) {
    throw new TypeError("Audit artifact payload does not match the dry-run preview");
  }

  const manifest = {
    schemaVersion: "geo.manual-publication-package.v1" as const,
    evidenceType: "preview" as const,
    platform: connector.platform,
    tenantId: input.renderedDraft.tenantId,
    channelAccountId: input.renderedDraft.channelAccountId,
    variantId: input.renderedDraft.variantId,
    executionLevel: "dry_run" as const,
    auditArtifactId: artifact.id,
    payloadHash: artifact.payloadHash,
    auditHash: artifact.auditHash,
    previewHash: input.renderedDraft.previewHash,
    requiresManualAction: true as const,
    publicationStatus: "not_published" as const,
    confirmed: false as const,
    exportedAt: input.exportedAt,
  };
  const files: Readonly<Record<string, string>> = {
    "NOT_PUBLISHED.txt": [
      "NOT PUBLISHED",
      "This artifact is an audited dry-run preview only.",
      "Manual action is required in the authorized platform account.",
      "A separate platform readback is required to prove any later publication.",
    ].join("\n"),
    "article.md": input.renderedDraft.manualText,
    "instructions.txt": connector.manualInstructions.join("\n"),
    "manifest.json": canonicalJson(manifest),
  };
  return {
    ...manifest,
    files,
    packageHash: stableSha256({ manifest, files }),
  };
}
