import { publicationReceiptSchema, type PublicationReceipt } from "@geo/contracts";

import { ConnectorPolicyError } from "./capabilities.js";

export function isConfirmedLivePublication(receipt: PublicationReceipt): boolean {
  const parsed = publicationReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    return false;
  }
  const value = parsed.data;
  return (
    value.confirmed &&
    value.executionLevel !== "dry_run" &&
    (value.evidenceType === "api_response" || value.evidenceType === "platform_readback") &&
    value.externalId !== null &&
    value.externalUrl !== null &&
    value.publishedAt !== null
  );
}

export function assertConfirmedLivePublication(receipt: PublicationReceipt): void {
  if (!isConfirmedLivePublication(receipt)) {
    throw new ConnectorPolicyError(
      "PREVIEW_CANNOT_CONFIRM_PUBLICATION",
      "A preview, fixture, screenshot, manual import, or incomplete receipt cannot prove a live publication",
      { platform: receipt.platform, executionLevel: receipt.executionLevel },
    );
  }
}
