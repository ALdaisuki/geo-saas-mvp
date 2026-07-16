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

export interface PlaywrightCtripReadPage {
  url(): string;
  locator(selector: string): PlaywrightCtripReadLocator;
}

const READ_TIMEOUT_MS = 1_000;

async function firstLabel(
  locator: PlaywrightCtripReadLocator,
  readText: boolean,
  fallback: string,
): Promise<string> {
  const candidates = await Promise.all([
    locator.getAttribute("aria-label", { timeout: READ_TIMEOUT_MS }),
    locator.getAttribute("title", { timeout: READ_TIMEOUT_MS }),
    locator.getAttribute("placeholder", { timeout: READ_TIMEOUT_MS }),
    readText ? locator.textContent({ timeout: READ_TIMEOUT_MS }) : Promise.resolve(null),
  ]);
  return candidates.find((candidate) => candidate?.trim())?.trim() ?? fallback;
}

export function createPlaywrightCtripSurfaceReviewPage(
  page: PlaywrightCtripReadPage,
): CtripSurfaceReviewPage {
  return Object.freeze({
    currentUrl: () => page.url(),
    readControls: async (
      probes: Parameters<CtripSurfaceReviewPage["readControls"]>[0],
      maximum: number,
    ) => {
      const controls: CtripRawObservedControl[] = [];
      for (const probe of probes) {
        if (controls.length >= maximum) break;
        const locator = page.locator(probe.selector);
        const count = Math.min(await locator.count(), maximum - controls.length);
        for (let index = 0; index < count; index += 1) {
          const control = locator.nth(index);
          if (!(await control.isVisible({ timeout: READ_TIMEOUT_MS }))) continue;
          controls.push({
            probeId: probe.id,
            rawLabel: await firstLabel(control, probe.readText, probe.id),
          });
        }
      }
      return Object.freeze(controls);
    },
    detectChallengeSignals: async (
      probes: Parameters<CtripSurfaceReviewPage["detectChallengeSignals"]>[0],
    ) => {
      const signals: string[] = [];
      for (const probe of probes) {
        const locator = page.locator(probe.selector);
        const count = Math.min(await locator.count(), 10);
        for (let index = 0; index < count; index += 1) {
          if (await locator.nth(index).isVisible({ timeout: READ_TIMEOUT_MS })) {
            signals.push(probe.id);
            break;
          }
        }
      }
      return Object.freeze(signals);
    },
  });
}
