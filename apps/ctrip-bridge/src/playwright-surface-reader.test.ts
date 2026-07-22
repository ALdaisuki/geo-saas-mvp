import { describe, expect, it } from "vitest";

import { CTRIP_SURFACE_REVIEW_MANIFEST } from "./authenticated-surface-review.js";
import {
  createPlaywrightCtripSurfaceReviewPage,
  type PlaywrightCtripReadLocator,
  type PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

const emptyLocator: PlaywrightCtripReadLocator = {
  count: async () => 0,
  nth: () => emptyLocator,
  first: () => emptyLocator,
  isVisible: async () => false,
  getAttribute: async () => null,
  textContent: async () => null,
};

describe("Playwright Ctrip read-only page adapter", () => {
  it("reads all fixed probes in one snapshot without editor content or input values", async () => {
    const snapshots: unknown[] = [];
    const page: PlaywrightCtripReadPage = {
      url: () => "https://we.ctrip.com/publish/publishPictureText",
      locator: () => emptyLocator,
      evaluate: async <Result, Argument>(
        _pageFunction: (argument: Argument) => Result,
        argument: Argument,
      ) => {
        snapshots.push(argument);
        return {
          controls: [
            {
              probeId: "action",
              rawLabel: "Publish",
              rawAttributes: [{ name: "data-testid", rawValue: "publish" }],
            },
            {
              probeId: "editor",
              rawLabel: "editor",
              rawAttributes: [{ name: "contenteditable", rawValue: "true" }],
            },
          ],
          challengeSignals: ["captcha_frame"],
        } as Result;
      },
    };
    const reviewPage = createPlaywrightCtripSurfaceReviewPage(page);

    const [controls, signals] = await Promise.all([
      reviewPage.readControls(
        CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
        CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
        40,
      ),
      reviewPage.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
    ]);

    expect(controls).toEqual([
      {
        probeId: "action",
        rawLabel: "Publish",
        rawAttributes: [{ name: "data-testid", rawValue: "publish" }],
      },
      {
        probeId: "editor",
        rawLabel: "editor",
        rawAttributes: [{ name: "contenteditable", rawValue: "true" }],
      },
    ]);
    expect(signals).toEqual(["captcha_frame"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      attributeNames: CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
      controlProbes: CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
      challengeProbes: CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes,
      maximum: 40,
    });
    expect(JSON.stringify(snapshots[0])).not.toContain('"value"');
  });

  it("does not use chained locator reads that can become stale during a rerender", async () => {
    let legacyReadCount = 0;
    const staleLocator: PlaywrightCtripReadLocator = {
      count: async () => {
        legacyReadCount += 1;
        throw new Error("dynamic locator became stale");
      },
      nth: () => staleLocator,
      first: () => staleLocator,
      isVisible: async () => {
        legacyReadCount += 1;
        throw new Error("dynamic locator became stale");
      },
      getAttribute: async () => {
        legacyReadCount += 1;
        throw new Error("dynamic locator became stale");
      },
      textContent: async () => {
        legacyReadCount += 1;
        throw new Error("dynamic locator became stale");
      },
    };
    const page: PlaywrightCtripReadPage = {
      url: () => "https://we.ctrip.com/publish/publishPictureText",
      locator: () => staleLocator,
      evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
    };
    const reviewPage = createPlaywrightCtripSurfaceReviewPage(page);

    await expect(
      Promise.all([
        reviewPage.readControls(
          CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
          CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
          40,
        ),
        reviewPage.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
      ]),
    ).resolves.toEqual([[], []]);
    expect(legacyReadCount).toBe(0);
  });

  it("clears a failed snapshot so a later readiness check can recover", async () => {
    let attempts = 0;
    const page: PlaywrightCtripReadPage = {
      url: () => "https://we.ctrip.com/publish/publishPictureText",
      locator: () => emptyLocator,
      evaluate: async <Result>() => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary CDP read failure");
        return { controls: [], challengeSignals: [] } as Result;
      },
    };
    const reviewPage = createPlaywrightCtripSurfaceReviewPage(page);

    await expect(
      Promise.all([
        reviewPage.readControls(
          CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
          CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
          40,
        ),
        reviewPage.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
      ]),
    ).rejects.toThrow(/temporary CDP/iu);
    await expect(
      reviewPage.readControls(
        CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
        CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
        40,
      ),
    ).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });
});
