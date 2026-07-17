import { describe, expect, it, vi } from "vitest";

import {
  CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION,
  CtripCommunityBrowserPreflightAdapter,
} from "./browser-preflight-adapter.js";
import type { CtripSurfaceReviewEvidence } from "./authenticated-surface-review.js";

const now = "2026-07-16T12:00:00.000Z";

function evidence(outcome: CtripSurfaceReviewEvidence["outcome"]): CtripSurfaceReviewEvidence {
  return {
    schemaVersion: "geo.ctrip-surface-review.v2",
    manifestVersion: "ctrip-community-surface-review-v2",
    outcome,
    observedAt: now,
    evidenceKind: "browser",
    sessionEvidenceHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    pages: [],
  };
}

describe("CtripCommunityBrowserPreflightAdapter", () => {
  it.each([
    ["session_required", "session_required"],
    ["challenge_required", "challenge_required"],
    ["adapter_drift", "adapter_drift"],
    ["reviewed_surface", "adapter_drift"],
  ] as const)("maps %s review evidence to a closed prepare outcome", async (review, outcome) => {
    const inspect = vi.fn(async () => evidence(review));
    const adapter = new CtripCommunityBrowserPreflightAdapter({ inspect });

    await expect(adapter.prepare()).resolves.toEqual({
      outcome,
      sessionEvidenceHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      observedAt: now,
      evidenceKind: "browser",
    });
    expect(adapter.version).toBe(CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION);
    expect(adapter.commandCapabilities).toEqual({
      prepare: true,
      submit: false,
      readback: false,
    });
  });
});
