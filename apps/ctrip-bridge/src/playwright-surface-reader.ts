import type {
  CtripRawObservedControl,
  CtripSurfaceReviewPage,
} from "./authenticated-surface-review.js";

export interface PlaywrightCtripReadLocator {
  count(): Promise<number>;
  nth(index: number): PlaywrightCtripReadLocator;
  first(): PlaywrightCtripReadLocator;
  isVisible(options?: { readonly timeout?: number }): Promise<boolean>;
  getAttribute(name: string, options?: { readonly timeout?: number }): Promise<string | null>;
  textContent(options?: { readonly timeout?: number }): Promise<string | null>;
}

interface PlaywrightCtripSnapshotElement {
  readonly textContent: string | null;
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: PlaywrightCtripSnapshotElement): {
        readonly display: string;
        readonly visibility: string;
        readonly opacity: string;
      };
    } | null;
    querySelectorAll(selector: string): readonly PlaywrightCtripSnapshotElement[];
  };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
}

interface CtripPageSnapshot {
  readonly controls: readonly CtripRawObservedControl[];
  readonly challengeSignals: readonly string[];
}

interface CtripPageSnapshotOptions {
  readonly controlProbes: readonly {
    readonly id: string;
    readonly selector: string;
    readonly readText: boolean;
    readonly visibility: "visible" | "attached";
  }[];
  readonly challengeProbes: readonly { readonly id: string; readonly selector: string }[];
  readonly attributeNames: readonly string[];
  readonly maximum: number;
}

export interface PlaywrightCtripReadPage {
  url(): string;
  locator(selector: string): PlaywrightCtripReadLocator;
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result,
    argument: Argument,
  ): Promise<Result>;
}

function snapshotCtripPage(options: CtripPageSnapshotOptions): CtripPageSnapshot {
  const document = (
    globalThis as unknown as {
      readonly document?: PlaywrightCtripSnapshotElement["ownerDocument"];
    }
  ).document;
  if (document === undefined) throw new Error("Ctrip page document is unavailable");
  const isVisible = (element: PlaywrightCtripSnapshotElement): boolean => {
    const style = document.defaultView?.getComputedStyle(element);
    if (style === undefined) return false;
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const controls: CtripRawObservedControl[] = [];
  for (const probe of options.controlProbes) {
    if (controls.length >= options.maximum) break;
    const remaining = options.maximum - controls.length;
    const elements = [...document.querySelectorAll(probe.selector)]
      .slice(0, remaining)
      .filter((element) => probe.visibility === "attached" || isVisible(element));
    for (const element of elements) {
      const rawAttributes = options.attributeNames.flatMap((name) => {
        const rawValue = element.getAttribute(name);
        return rawValue === null || rawValue.trim().length === 0 ? [] : [{ name, rawValue }];
      });
      const candidates = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        probe.readText ? element.textContent : null,
      ];
      controls.push({
        probeId: probe.id,
        rawLabel: candidates.find((candidate) => candidate?.trim())?.trim() ?? probe.id,
        rawAttributes,
      });
    }
  }
  const challengeSignals = options.challengeProbes.flatMap((probe) =>
    [...document.querySelectorAll(probe.selector)].slice(0, 10).some(isVisible) ? [probe.id] : [],
  );
  return { controls, challengeSignals };
}

export function createPlaywrightCtripSurfaceReviewPage(
  page: PlaywrightCtripReadPage,
): CtripSurfaceReviewPage {
  let pendingSnapshot: {
    readonly options: {
      controlProbes: CtripPageSnapshotOptions["controlProbes"];
      challengeProbes: CtripPageSnapshotOptions["challengeProbes"];
      attributeNames: CtripPageSnapshotOptions["attributeNames"];
      maximum: number;
    };
    readonly promise: Promise<CtripPageSnapshot>;
  } | null = null;
  const snapshot = (options: CtripPageSnapshotOptions): Promise<CtripPageSnapshot> => {
    if (pendingSnapshot !== null) {
      pendingSnapshot.options.controlProbes = Object.freeze([
        ...pendingSnapshot.options.controlProbes,
        ...options.controlProbes,
      ]);
      pendingSnapshot.options.challengeProbes = Object.freeze([
        ...pendingSnapshot.options.challengeProbes,
        ...options.challengeProbes,
      ]);
      if (options.attributeNames.length > 0) {
        pendingSnapshot.options.attributeNames = options.attributeNames;
      }
      pendingSnapshot.options.maximum = Math.max(pendingSnapshot.options.maximum, options.maximum);
      return pendingSnapshot.promise;
    }
    const combinedOptions = {
      controlProbes: options.controlProbes,
      challengeProbes: options.challengeProbes,
      attributeNames: options.attributeNames,
      maximum: options.maximum,
    };
    const current = Promise.resolve().then(() => page.evaluate(snapshotCtripPage, combinedOptions));
    const batch = { options: combinedOptions, promise: current };
    pendingSnapshot = batch;
    const clearBatch = (): void => {
      if (pendingSnapshot === batch) pendingSnapshot = null;
    };
    void current.then(clearBatch, clearBatch);
    return current;
  };

  return Object.freeze({
    currentUrl: () => page.url(),
    readControls: async (
      probes: Parameters<CtripSurfaceReviewPage["readControls"]>[0],
      attributeNames: Parameters<CtripSurfaceReviewPage["readControls"]>[1],
      maximum: number,
    ) => {
      const result = await snapshot({
        controlProbes: probes,
        challengeProbes: [],
        attributeNames,
        maximum,
      });
      return Object.freeze(result.controls);
    },
    detectChallengeSignals: async (
      probes: Parameters<CtripSurfaceReviewPage["detectChallengeSignals"]>[0],
    ) => {
      const result = await snapshot({
        controlProbes: [],
        challengeProbes: probes,
        attributeNames: [],
        maximum: 0,
      });
      return Object.freeze(result.challengeSignals);
    },
  });
}
