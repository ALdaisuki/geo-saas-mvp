import type { PublicationVariantPayload } from "@geo/contracts";
import { MANUAL_MEDIA_REVIEW_LABEL, sha256Canonical } from "@geo/core";

export const MANUAL_MEDIA_REWORK_ACTIONS = [
  "regenerate_media",
  "replace_media",
  "revise_article",
] as const;
export type ManualMediaReworkAction = (typeof MANUAL_MEDIA_REWORK_ACTIONS)[number];

export function mediaRequiresManualReview(payload: PublicationVariantPayload): boolean {
  return payload.media.some(
    (reference) => reference.inspection?.labels?.includes(MANUAL_MEDIA_REVIEW_LABEL) ?? false,
  );
}

export function manualMediaReviewSnapshotHash(payload: PublicationVariantPayload): string {
  return sha256Canonical({
    schemaVersion: "geo.manual-media-review-snapshot.v1",
    media: payload.media.map((reference) => ({
      sha256: reference.sha256,
      platform: reference.platform,
      role: reference.role,
      inspectionStatus: reference.inspection.status,
      inspectionLabels: [...reference.inspection.labels].sort(),
    })),
  });
}
