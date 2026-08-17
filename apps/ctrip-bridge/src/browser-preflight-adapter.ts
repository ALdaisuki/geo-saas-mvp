import type { CtripSurfaceReviewEvidence } from "./authenticated-surface-review.js";
import type {
  CtripBridgePreparationBlocker,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
} from "./types.js";

export const CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION = "ctrip-community-browser-preflight-v1";

export class CtripCommunityBrowserPreflightAdapter implements CtripFixedAdapter {
  readonly version = CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: false,
    readback: false,
  });
  readonly #inspect: () => Promise<CtripSurfaceReviewEvidence>;

  constructor(options: { readonly inspect: () => Promise<CtripSurfaceReviewEvidence> }) {
    this.#inspect = options.inspect;
  }

  async prepare(): Promise<CtripBridgePreparationBlocker> {
    const evidence = await this.#inspect();
    return Object.freeze({
      outcome: evidence.outcome === "reviewed_surface" ? "adapter_drift" : evidence.outcome,
      diagnosticCode: `preflight:${evidence.outcome}`,
      sessionEvidenceHash: evidence.sessionEvidenceHash,
      evidenceHash: evidence.evidenceHash,
      observedAt: evidence.observedAt,
      evidenceKind: "browser" as const,
    });
  }

  submit(): Promise<CtripBridgeSubmitObservation> {
    return Promise.reject(new Error("Ctrip browser preflight adapter cannot submit"));
  }

  readback(): Promise<CtripBridgeReadbackObservation> {
    return Promise.reject(new Error("Ctrip browser preflight adapter cannot read back"));
  }
}
