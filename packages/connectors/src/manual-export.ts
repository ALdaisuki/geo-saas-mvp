import { sha256Schema } from "@geo/contracts";

import { assertExecutionAllowed, buildCapabilityReport } from "./capabilities.js";
import { canonicalJson, stableSha256 } from "./hash.js";
import type { DryRunConnector } from "./dry-run-connector.js";
import type { ManualPackageInput, ManualPublicationPackage } from "./types.js";

export async function exportManualPackage(
  connector: DryRunConnector,
  input: ManualPackageInput,
): Promise<ManualPublicationPackage> {
  const report = buildCapabilityReport(connector.platform, "2026-07-13T00:00:00.000Z");
  assertExecutionAllowed(report, "assisted");

  if (input.renderedDraft.platform !== connector.platform) {
    throw new TypeError("Rendered draft platform does not match the connector");
  }
  if (input.renderedDraft.executionLevel !== "assisted") {
    throw new TypeError("Manual publication packages require assisted execution");
  }

  const payloadHash = sha256Schema.parse(input.payloadHash);
  const auditHash = sha256Schema.parse(input.auditHash);
  if (!Number.isFinite(Date.parse(input.exportedAt))) {
    throw new TypeError("Manual package exportedAt must be an ISO timestamp");
  }

  const manifest = {
    schemaVersion: "geo.manual-publication-package.v1" as const,
    evidenceType: "preview" as const,
    platform: connector.platform,
    tenantId: input.renderedDraft.tenantId,
    channelAccountId: input.renderedDraft.channelAccountId,
    variantId: input.renderedDraft.variantId,
    executionLevel: "assisted" as const,
    payloadHash,
    auditHash,
    previewHash: input.renderedDraft.previewHash,
    exportedAt: input.exportedAt,
  };
  const files: Readonly<Record<string, string>> = {
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
