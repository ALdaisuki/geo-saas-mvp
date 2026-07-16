import { describe, expect, it } from "vitest";

import { CTRIP_SURFACE_REVIEW_MANIFEST } from "./authenticated-surface-review.js";
import {
  createPlaywrightCtripSurfaceReviewPage,
  type PlaywrightCtripReadLocator,
  type PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

interface FakeElement {
  readonly visible: boolean;
  readonly attributes?: Readonly<Record<string, string | null>>;
  readonly text?: string | null;
}

class FakeLocator implements PlaywrightCtripReadLocator {
  readonly #elements: readonly FakeElement[];
  readonly #index: number | null;

  constructor(elements: readonly FakeElement[], index: number | null = null) {
    this.#elements = elements;
    this.#index = index;
  }

  count(): Promise<number> {
    return Promise.resolve(this.#elements.length);
  }

  nth(index: number): PlaywrightCtripReadLocator {
    return new FakeLocator(this.#elements, index);
  }

  first(): PlaywrightCtripReadLocator {
    return this.nth(0);
  }

  isVisible(): Promise<boolean> {
    return Promise.resolve(this.#element()?.visible ?? false);
  }

  getAttribute(name: string): Promise<string | null> {
    return Promise.resolve(this.#element()?.attributes?.[name] ?? null);
  }

  textContent(): Promise<string | null> {
    return Promise.resolve(this.#element()?.text ?? null);
  }

  #element(): FakeElement | undefined {
    return this.#index === null ? this.#elements[0] : this.#elements[this.#index];
  }
}

describe("Playwright Ctrip read-only page adapter", () => {
  it("reads fixed probes without reading editor content or input values", async () => {
    const selectors: string[] = [];
    const page: PlaywrightCtripReadPage = {
      url: () => "https://you.ctrip.com/write?secret=value",
      locator: (selector) => {
        selectors.push(selector);
        if (selector.includes("textarea")) {
          return new FakeLocator([{ visible: true, text: "PRIVATE ARTICLE BODY" }]);
        }
        if (selector.includes("iframe")) {
          return new FakeLocator([{ visible: true }]);
        }
        if (selector.includes("button")) {
          return new FakeLocator([{ visible: true, text: "Publish" }]);
        }
        return new FakeLocator([]);
      },
    };
    const reviewPage = createPlaywrightCtripSurfaceReviewPage(page);

    await expect(
      reviewPage.readControls(CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes, 40),
    ).resolves.toEqual([
      { probeId: "action", rawLabel: "Publish" },
      { probeId: "editor", rawLabel: "editor" },
    ]);
    await expect(
      reviewPage.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
    ).resolves.toContain("captcha_frame");
    expect(selectors).toEqual([
      ...CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes.map((probe) => probe.selector),
      ...CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes.map((probe) => probe.selector),
    ]);
  });
});
