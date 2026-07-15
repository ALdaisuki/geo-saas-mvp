import { createHash } from "node:crypto";

import {
  createDefaultConnectorRegistry,
  DryRunConnector,
  exportManualPackage,
  type ManualPackageMediaAttachmentInput,
  type ManualPublicationPackage,
} from "@geo/connectors";
import {
  publicationVariantPayloadSchema,
  type AuditArtifact,
  type ConnectorCapability,
  type ExecutionLevel,
  type Platform,
  type PublicationVariantPayload,
  type MediaReference,
} from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import type { MediaObjectStore } from "@geo/media";

export interface ManualPublicationPackageRequestContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
}

export interface ManualPublicationPackageSource {
  readonly artifact: Readonly<AuditArtifact>;
  readonly payload: PublicationVariantPayload;
  readonly account: {
    readonly id: string;
    readonly platform: Platform;
    readonly capability: ConnectorCapability;
    readonly supportedExecutionLevels: readonly ExecutionLevel[];
    readonly status: string;
  };
  readonly mediaAssets: readonly {
    readonly storageKey: string;
    readonly reference: MediaReference;
  }[];
}

export interface RecordManualPublicationPackageExportInput {
  readonly auditArtifactId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly packageHash: string;
  readonly previewHash: string;
  readonly exportedAt: string;
}

export interface ManualPublicationPackageRepository {
  loadManualPublicationPackageSource(
    context: ManualPublicationPackageRequestContext,
    auditArtifactId: string,
  ): Promise<ManualPublicationPackageSource | null>;
  recordManualPublicationPackageExport(
    context: ManualPublicationPackageRequestContext,
    input: RecordManualPublicationPackageExportInput,
  ): Promise<void>;
}

export type ManualPublicationPackageExportErrorCode =
  | "MANUAL_PACKAGE_SOURCE_NOT_FOUND"
  | "MANUAL_PACKAGE_AUDIT_NOT_PASSED"
  | "MANUAL_PACKAGE_AUDIT_EXPIRED"
  | "MANUAL_PACKAGE_ACCOUNT_UNSUPPORTED"
  | "MANUAL_PACKAGE_SOURCE_INVALID";

export class ManualPublicationPackageExportError extends Error {
  constructor(
    readonly statusCode: 404 | 422,
    readonly code: ManualPublicationPackageExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManualPublicationPackageExportError";
  }
}

export interface CreateManualPublicationPackageExportInput {
  readonly repository: ManualPublicationPackageRepository;
  readonly context: ManualPublicationPackageRequestContext;
  readonly auditArtifactId: string;
  readonly exportedAt: string;
  readonly mediaObjectStore?: Pick<MediaObjectStore, "get">;
}

function invalidSource(message: string): never {
  throw new ManualPublicationPackageExportError(422, "MANUAL_PACKAGE_SOURCE_INVALID", message);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createManualPublicationPackageExport(
  input: CreateManualPublicationPackageExportInput,
): Promise<ManualPublicationPackage> {
  const exportedAt = Date.parse(input.exportedAt);
  if (!Number.isFinite(exportedAt)) {
    return invalidSource("Manual package export timestamp is invalid");
  }

  const source = await input.repository.loadManualPublicationPackageSource(
    input.context,
    input.auditArtifactId,
  );
  if (
    source === null ||
    source.artifact.id !== input.auditArtifactId ||
    source.artifact.tenantId !== input.context.tenantId
  ) {
    throw new ManualPublicationPackageExportError(
      404,
      "MANUAL_PACKAGE_SOURCE_NOT_FOUND",
      "Audit artifact was not found in the active tenant",
    );
  }
  if (source.artifact.status !== "passed") {
    throw new ManualPublicationPackageExportError(
      422,
      "MANUAL_PACKAGE_AUDIT_NOT_PASSED",
      "Manual package export requires a passed audit artifact",
    );
  }
  if (Date.parse(source.artifact.expiresAt) <= exportedAt) {
    throw new ManualPublicationPackageExportError(
      422,
      "MANUAL_PACKAGE_AUDIT_EXPIRED",
      "The passed audit artifact has expired",
    );
  }

  const payload = publicationVariantPayloadSchema.parse(source.payload);
  if (sha256Canonical(payload) !== source.artifact.payloadHash) {
    return invalidSource("Publication variant payload no longer matches the passed audit");
  }
  if (
    source.account.id !== source.artifact.channelAccountId ||
    source.account.platform !== source.artifact.platform
  ) {
    return invalidSource("Channel account scope does not match the passed audit");
  }

  const assetsById = new Map(source.mediaAssets.map((asset) => [asset.reference.id, asset]));
  if (assetsById.size !== source.mediaAssets.length || assetsById.size !== payload.media.length) {
    return invalidSource("Manual package source does not contain exactly the audited media assets");
  }
  if (payload.media.length > 0 && input.mediaObjectStore === undefined) {
    return invalidSource("Manual package media object storage is unavailable");
  }
  const mediaAttachments: ManualPackageMediaAttachmentInput[] = [];
  for (const reference of payload.media) {
    const asset = assetsById.get(reference.id);
    if (
      asset === undefined ||
      sha256Canonical(asset.reference) !== sha256Canonical(reference) ||
      input.mediaObjectStore === undefined
    ) {
      return invalidSource("Manual package media asset does not match the audited payload");
    }
    let bytes: Uint8Array;
    try {
      bytes = await input.mediaObjectStore.get({
        tenantId: input.context.tenantId,
        storageKey: asset.storageKey,
      });
    } catch {
      return invalidSource("Manual package media bytes could not be loaded or verified");
    }
    if (bytes.byteLength !== reference.byteLength || sha256Bytes(bytes) !== reference.sha256) {
      return invalidSource("Manual package media bytes could not be loaded or verified");
    }
    mediaAttachments.push({
      mediaAssetId: reference.id,
      mimeType: reference.mimeType,
      sha256: reference.sha256,
      byteLength: reference.byteLength,
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  if (
    source.account.status !== "active" ||
    source.account.capability !== "manual_only" ||
    source.account.supportedExecutionLevels.length !== 1 ||
    source.account.supportedExecutionLevels[0] !== "dry_run"
  ) {
    throw new ManualPublicationPackageExportError(
      422,
      "MANUAL_PACKAGE_ACCOUNT_UNSUPPORTED",
      "Manual package export requires an active manual_only account with dry_run as its only execution level",
    );
  }

  const connector = createDefaultConnectorRegistry().get(source.artifact.platform);
  if (!(connector instanceof DryRunConnector)) {
    return invalidSource("Platform connector cannot produce a governed dry-run preview");
  }
  const report = await connector.probeCapabilities({ checkedAt: input.exportedAt });
  if (
    report.capability !== "manual_only" ||
    report.supportedExecutionLevels.length !== 1 ||
    report.supportedExecutionLevels[0] !== "dry_run"
  ) {
    return invalidSource("Platform connector capability does not match manual-only dry-run policy");
  }

  const renderedDraft = await connector.renderDraft({
    tenantId: input.context.tenantId,
    channelAccountId: source.account.id,
    variantId: source.artifact.variantId,
    executionLevel: "dry_run",
    payload,
  });
  const result = await exportManualPackage(connector, {
    renderedDraft,
    auditArtifact: source.artifact,
    mediaAttachments,
    exportedAt: input.exportedAt,
  });
  await input.repository.recordManualPublicationPackageExport(input.context, {
    auditArtifactId: source.artifact.id,
    variantId: source.artifact.variantId,
    channelAccountId: source.account.id,
    packageHash: result.packageHash,
    previewHash: result.previewHash,
    exportedAt: input.exportedAt,
  });
  return result;
}
