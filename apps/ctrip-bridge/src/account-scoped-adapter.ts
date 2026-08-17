import type { RenderedDraft } from "@geo/connectors";
import { browserPublicationAdapterVersion } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";

import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import {
  CtripCommunityBrowserDraftAdapter,
  CTRIP_BROWSER_DRAFT_ADAPTER_VERSION,
} from "./browser-draft-adapter.js";
import {
  CtripCommunityBrowserPreflightAdapter,
  CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION,
} from "./browser-preflight-adapter.js";
import {
  CtripCommunityBrowserSupervisedAdapter,
  CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION,
} from "./browser-supervised-adapter.js";
import {
  CtripCommunityBrowserUnattendedAdapter,
  CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION,
} from "./browser-unattended-adapter.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";
import type { CtripBridgeMode } from "./config.js";
import type {
  CtripBridgeHandoffDraft,
  CtripBridgePrepareResult,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";
import { PriorityPlatformBrowserAdapter } from "./priority-platform-browser-adapter.js";
import { isBrowserRuntimeUnavailableError } from "./browser-runtime-error.js";

type BrowserMode = Exclude<CtripBridgeMode, "simulator">;

function adapterForSession(
  mode: BrowserMode,
  session: CtripBrowserReviewSession,
  handoff: CtripBridgeHandoffDraft,
): CtripFixedAdapter {
  if (handoff.platform !== "ctrip_community") {
    if (session.platform !== handoff.platform || session.platformPublicationAdapter === null) {
      throw new Error(`${handoff.platform} sourced browser publication adapter is unavailable`);
    }
    return new PriorityPlatformBrowserAdapter({
      platform: handoff.platform,
      publication: session.platformPublicationAdapter,
      ...(session.platformMediaWriter === null ? {} : { mediaWriter: session.platformMediaWriter }),
      expectedAccountName: session.expectedAccountName,
    });
  }
  if (mode === "browser_preflight") {
    return new CtripCommunityBrowserPreflightAdapter({ inspect: session.inspect });
  }

  if (mode === "browser_draft") {
    return new CtripCommunityBrowserDraftAdapter({ writer: session.draftWriter });
  }
  const options = {
    draftWriter: session.draftWriter,
    submitWriter: session.supervisedSubmitWriter,
    readbackWriter: session.publicReadbackWriter,
  };
  return mode === "browser_supervised"
    ? new CtripCommunityBrowserSupervisedAdapter(options)
    : new CtripCommunityBrowserUnattendedAdapter(options);
}

export class CtripAccountScopedAdapter implements CtripFixedAdapter {
  readonly version: string;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities: Readonly<{
    prepare: boolean;
    submit: boolean;
    readback: boolean;
  }>;
  readonly #mode: BrowserMode;
  readonly #sessions: CtripAccountBrowserSessionProvider;

  constructor(options: {
    readonly mode: BrowserMode;
    readonly sessions: CtripAccountBrowserSessionProvider;
  }) {
    this.#mode = options.mode;
    this.#sessions = options.sessions;
    this.version =
      options.mode === "browser_preflight"
        ? CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION
        : options.mode === "browser_draft"
          ? CTRIP_BROWSER_DRAFT_ADAPTER_VERSION
          : options.mode === "browser_supervised"
            ? CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION
            : CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION;
    this.commandCapabilities = Object.freeze(
      options.mode === "browser_preflight" || options.mode === "browser_draft"
        ? { prepare: true, submit: false, readback: false }
        : { prepare: true, submit: true, readback: true },
    );
  }

  versionFor(handoff: CtripBridgeHandoffDraft): string {
    if (handoff.platform !== "ctrip_community") {
      return browserPublicationAdapterVersion(handoff.platform);
    }
    return this.version;
  }

  async prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePrepareResult> {
    const prepareOnce = async (): Promise<CtripBridgePrepareResult> => {
      try {
        return await this.#sessions.withSession(handoff.channelAccountId, (session) =>
          adapterForSession(this.#mode, session, handoff).prepare(handoff, draft, media),
        );
      } catch (error) {
        if (!isBrowserRuntimeUnavailableError(error)) throw error;
        const observedAt = new Date().toISOString();
        const errorEvidence = {
          schemaVersion: "geo.browser-runtime-unavailable.v1",
          platform: handoff.platform,
          channelAccountId: handoff.channelAccountId,
          diagnosticCode: "draft-write-runtime-unavailable",
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage:
            error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 500) : null,
          observedAt,
        };
        const sessionEvidenceHash = sha256Canonical(errorEvidence);
        return Object.freeze({
          outcome: "session_required",
          diagnosticCode: "draft-write-runtime-unavailable",
          sessionEvidenceHash,
          evidenceHash: sha256Canonical({ ...errorEvidence, sessionEvidenceHash }),
          observedAt,
          evidenceKind: "browser",
        });
      }
    };
    let result = await prepareOnce();
    const runtimeUnavailable = (candidate: CtripBridgePrepareResult) =>
      "outcome" in candidate &&
      candidate.outcome === "session_required" &&
      candidate.diagnosticCode.endsWith("-runtime-unavailable");
    const transientAdapterDrift = (candidate: CtripBridgePrepareResult) =>
      "outcome" in candidate &&
      candidate.outcome === "adapter_drift" &&
      (candidate.diagnosticCode === "prepared-payload-readback" ||
        candidate.diagnosticCode === "prepared-media-readback" ||
        candidate.diagnosticCode === "draft-write-adapter_drift" ||
        candidate.diagnosticCode === "surface-adapter_drift" ||
        candidate.diagnosticCode.startsWith("media-write-") ||
        candidate.diagnosticCode.endsWith("-readback"));
    const shouldReconnect = (candidate: CtripBridgePrepareResult) =>
      runtimeUnavailable(candidate) || transientAdapterDrift(candidate);
    const MAX_PREPARE_ATTEMPTS = 2;
    for (let attempt = 1; shouldReconnect(result) && attempt < MAX_PREPARE_ATTEMPTS; attempt += 1) {
      if (this.#sessions.destroySession === undefined) break;
      await this.#sessions.destroySession(handoff.channelAccountId).catch(() => undefined);
      result = await prepareOnce();
    }
    if (shouldReconnect(result) && this.#sessions.destroySession !== undefined) {
      await this.#sessions.destroySession(handoff.channelAccountId).catch(() => undefined);
    }
    return result;
  }

  verifySubmit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    loadMedia?: () => Promise<readonly CtripTrustedMediaAttachment[]>,
  ): Promise<void> {
    return this.#sessions.withSession(handoff.channelAccountId, async (session) => {
      const adapter = adapterForSession(this.#mode, session, handoff);
      if (adapter.verifySubmit === undefined) {
        throw new Error("Ctrip browser adapter does not support submit verification");
      }
      await adapter.verifySubmit(handoff, draft, loadMedia);
    });
  }

  submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    return this.#sessions.withSession(handoff.channelAccountId, (session) =>
      adapterForSession(this.#mode, session, handoff).submit(handoff, draft),
    );
  }

  readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation> {
    return this.#sessions.withSession(handoff.channelAccountId, (session) =>
      adapterForSession(this.#mode, session, handoff).readback(handoff, draft),
    );
  }
}
