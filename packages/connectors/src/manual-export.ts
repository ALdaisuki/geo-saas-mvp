import { createHash } from "node:crypto";

import { auditArtifactSchema } from "@geo/contracts";

import { assertExecutionAllowed, buildCapabilityReport } from "./capabilities.js";
import { canonicalJson, stableSha256 } from "./hash.js";
import type { DryRunConnector } from "./dry-run-connector.js";
import type { ManualPackageInput, ManualPublicationPackage } from "./types.js";

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new TypeError("Manual package attachment base64 is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw new TypeError("Manual package attachment base64 is not canonical");
  }
  return bytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

  const media = input.renderedDraft.payload.media;
  const attachmentsById = new Map(
    input.mediaAttachments.map((attachment) => [attachment.mediaAssetId, attachment]),
  );
  if (
    attachmentsById.size !== input.mediaAttachments.length ||
    attachmentsById.size !== media.length
  ) {
    throw new TypeError("Manual package requires exactly one attachment for every media reference");
  }
  const attachments = media.map((reference, index) => {
    const attachment = attachmentsById.get(reference.id);
    if (
      attachment === undefined ||
      attachment.mimeType !== reference.mimeType ||
      attachment.sha256 !== reference.sha256 ||
      attachment.byteLength !== reference.byteLength
    ) {
      throw new TypeError("Manual package attachment metadata does not match the media reference");
    }
    const bytes = decodeCanonicalBase64(attachment.base64);
    if (bytes.byteLength !== reference.byteLength || sha256Bytes(bytes) !== reference.sha256) {
      throw new TypeError("Manual package attachment bytes do not match the media reference");
    }
    const extension = EXTENSIONS[reference.mimeType];
    if (extension === undefined) {
      throw new TypeError("Manual package media MIME type is unsupported");
    }
    return Object.freeze({
      ...attachment,
      fileName: `media/${String(index + 1).padStart(2, "0")}-${reference.role}-${reference.id}.${extension}`,
    });
  });
  const mediaManifest = {
    schemaVersion: "geo.manual-media-manifest.v1" as const,
    payloadHash: artifact.payloadHash,
    entries: media.map((reference, index) => ({
      fileName: attachments[index]?.fileName,
      mediaAssetId: reference.id,
      sha256: reference.sha256,
      mimeType: reference.mimeType,
      byteLength: reference.byteLength,
      width: reference.width,
      height: reference.height,
      platform: reference.platform,
      role: reference.role,
      altText: reference.altText,
      caption: reference.caption,
      factIds: reference.factIds,
      visualBriefHash: reference.visualBriefHash,
    })),
  };
  const mediaManifestHash = stableSha256(mediaManifest);

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
    mediaManifestHash,
    mediaCount: attachments.length,
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
    "media-manifest.json": canonicalJson(mediaManifest),
    "manifest.json": canonicalJson(manifest),
  };
  return {
    ...manifest,
    files,
    attachments,
    packageHash: stableSha256({ manifest, files, attachments }),
  };
}
