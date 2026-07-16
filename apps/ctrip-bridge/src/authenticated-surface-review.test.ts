import { describe, expect, it } from "vitest";

import {
  CTRIP_SURFACE_REVIEW_MANIFEST,
  assertCtripLiveCanaryReady,
  canonicalCtripPageLocation,
  reviewCtripAuthenticatedSurface,
  sanitizeCtripReviewLabel,
  type CtripSurfaceReviewPage,
} from "./authenticated-surface-review.js";

const now = "2026-07-16T12:00:00.000Z";

function reviewPage(options: {
  readonly url: string;
  readonly title?: string;
  readonly controls?: readonly { readonly probeId: string; readonly rawLabel: string }[];
  readonly challengeSignals?: readonly string[];
  readonly unavailable?: boolean;
}): CtripSurfaceReviewPage {
  return {
    currentUrl: () => options.url,
    readControls: async () => {
      if (options.unavailable === true) throw new Error("page closed");
      return options.controls ?? [];
    },
    detectChallengeSignals: async () => options.challengeSignals ?? [],
  };
}

describe("Ctrip authenticated surface review", () => {
  it("allows only credential-free HTTPS Ctrip locations and drops query secrets", () => {
    expect(
      canonicalCtripPageLocation(
        "https://you.ctrip.com/community/write?access_token=secret#account",
      ),
    ).toEqual({ origin: "https://you.ctrip.com", path: "/community/write" });
    expect(canonicalCtripPageLocation("https://ctrip.com/")).toEqual({
      origin: "https://ctrip.com",
      path: "/",
    });
    expect(canonicalCtripPageLocation("http://you.ctrip.com/write")).toBeNull();
    expect(canonicalCtripPageLocation("https://ctrip.com.evil.example/write")).toBeNull();
    expect(canonicalCtripPageLocation("https://user:secret@you.ctrip.com/write")).toBeNull();
  });

  it("redacts sensitive label material and applies a hard length bound", () => {
    const sanitized = sanitizeCtripReviewLabel(
      " Publish 13800138000 person@example.com https://example.test/private " + "x".repeat(120),
    );

    expect(sanitized).toContain("[phone]");
    expect(sanitized).toContain("[email]");
    expect(sanitized).toContain("[url]");
    expect(sanitized).not.toContain("13800138000");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized?.length).toBeLessThanOrEqual(80);
  });

  it("emits stable bounded drift evidence without page-controlled probe identities", async () => {
    const pages = [
      reviewPage({ url: "https://evil.example/?token=secret" }),
      reviewPage({
        url: "https://you.ctrip.com/community/write?token=secret#private",
        title: "Draft for person@example.com",
        controls: [
          { probeId: "action", rawLabel: " Publish 13800138000 " },
          { probeId: "unknown_page_probe", rawLabel: "must not survive" },
          { probeId: "action", rawLabel: "Publish 13800138000" },
        ],
        challengeSignals: ["unknown_page_signal"],
      }),
    ];

    const first = await reviewCtripAuthenticatedSurface(pages, { now: () => new Date(now) });
    const second = await reviewCtripAuthenticatedSurface([...pages].reverse(), {
      now: () => new Date(now),
    });

    expect(first).toMatchObject({
      schemaVersion: "geo.ctrip-surface-review.v1",
      manifestVersion: CTRIP_SURFACE_REVIEW_MANIFEST.manifestVersion,
      outcome: "adapter_drift",
      observedAt: now,
      evidenceKind: "browser",
      pages: [
        {
          origin: "https://you.ctrip.com",
          path: "/community/write",
          observationStatus: "complete",
          sessionSignal: null,
          controls: [{ probeId: "action", label: "Publish [phone]" }],
          challengeSignals: [],
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(JSON.stringify(first)).not.toContain("person@example.com");
    expect(JSON.stringify(first)).not.toContain("must not survive");
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.sessionEvidenceHash).toBe(first.sessionEvidenceHash);
  });

  it("classifies missing sessions, challenges and unavailable observations", async () => {
    await expect(
      reviewCtripAuthenticatedSurface([reviewPage({ url: "https://example.com" })], {
        now: () => new Date(now),
      }),
    ).resolves.toMatchObject({ outcome: "session_required", pages: [] });

    await expect(
      reviewCtripAuthenticatedSurface([reviewPage({ url: "https://accounts.ctrip.com/login" })], {
        now: () => new Date(now),
      }),
    ).resolves.toMatchObject({
      outcome: "session_required",
      pages: [{ sessionSignal: "login_location" }],
    });

    await expect(
      reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://accounts.ctrip.com/login",
            challengeSignals: ["captcha_frame"],
          }),
        ],
        { now: () => new Date(now) },
      ),
    ).resolves.toMatchObject({ outcome: "challenge_required" });

    await expect(
      reviewCtripAuthenticatedSurface(
        [reviewPage({ url: "https://you.ctrip.com/write", unavailable: true })],
        { now: () => new Date(now) },
      ),
    ).resolves.toMatchObject({
      outcome: "adapter_drift",
      pages: [{ observationStatus: "unavailable" }],
    });
  });

  it("keeps live canary startup closed until a reviewed surface is compiled", () => {
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.liveCanaryEnabled).toBe(false);
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces).toEqual([]);
    expect(() => assertCtripLiveCanaryReady()).toThrow(/not reviewed/iu);
  });
});
