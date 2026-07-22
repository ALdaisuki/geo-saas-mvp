import type { RenderedDraft } from "@geo/connectors";
import { sha256Canonical, sha256Text } from "@geo/core";

import {
  CtripCommunityBrowserDraftAdapter,
  renderCtripDraftPlainText,
  type CtripDraftWriter,
} from "./browser-draft-adapter.js";
import type {
  CtripBridgeHandoffDraft,
  CtripBridgePrepareResult,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";
import type {
  CtripSupervisedSubmitSurfaceState,
  CtripSupervisedSubmitWriter,
} from "./playwright-supervised-submit-writer.js";

export const CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION =
  "ctrip-community-browser-supervised-v1";

function normalizedText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim();
}

function normalizedEditorBody(value: string): string {
  return normalizedText(value).replace(/\n/gu, "");
}

function preparedScope(state: CtripSupervisedSubmitSurfaceState): unknown {
  return {
    status: state.status,
    targetPageCount: state.targetPageCount,
    titleEditorCount: state.titleEditorCount,
    bodyEditorCount: state.bodyEditorCount,
    locationCount: state.locationCount,
    mediaCount: state.mediaCount,
    finalActionCount: state.finalActionCount,
    titleHash: sha256Text(state.titleText),
    bodyHash: sha256Text(state.bodyText),
    locationHash: sha256Text(state.locationText),
    challengeSignals: [...state.challengeSignals].sort(),
  };
}

export class CtripCommunityBrowserSupervisedAdapter implements CtripFixedAdapter {
  readonly version = CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: true,
    readback: false,
  });
  readonly #draftAdapter: CtripCommunityBrowserDraftAdapter;
  readonly #submitWriter: CtripSupervisedSubmitWriter;
  readonly #now: () => Date;

  constructor(options: {
    readonly draftWriter: CtripDraftWriter;
    readonly submitWriter: CtripSupervisedSubmitWriter;
    readonly now?: () => Date;
  }) {
    this.#draftAdapter = new CtripCommunityBrowserDraftAdapter(
      options.now === undefined
        ? { writer: options.draftWriter }
        : { writer: options.draftWriter, now: options.now },
    );
    this.#submitWriter = options.submitWriter;
    this.#now = options.now ?? (() => new Date());
  }

  prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePrepareResult> {
    return this.#draftAdapter.prepare(handoff, draft, media);
  }

  async #requireSubmitScope(
    _handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripSupervisedSubmitSurfaceState> {
    const state = await this.#submitWriter.inspectPrepared();
    const expectedTitle = normalizedText(draft.payload.title);
    const expectedBody = normalizedEditorBody(
      renderCtripDraftPlainText(draft.payload.bodyMarkdown),
    );
    const expectedLocation = normalizedText(draft.payload.locationQuery ?? "");
    if (
      state.status !== "ready" ||
      state.targetPageCount !== 1 ||
      state.titleEditorCount !== 1 ||
      state.bodyEditorCount !== 1 ||
      state.locationCount !== 1 ||
      state.mediaCount !== draft.payload.media.length ||
      state.finalActionCount !== 1 ||
      state.challengeSignals.length > 0 ||
      normalizedText(state.titleText) !== expectedTitle ||
      normalizedEditorBody(state.bodyText) !== expectedBody ||
      expectedLocation.length === 0 ||
      !normalizedText(state.locationText)
        .normalize("NFKC")
        .includes(expectedLocation.normalize("NFKC"))
    ) {
      throw new Error("Ctrip prepared draft no longer matches the audited submit scope");
    }
    return state;
  }

  async verifySubmit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<void> {
    await this.#requireSubmitScope(handoff, draft);
  }

  async submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    const submitScope = await this.#requireSubmitScope(handoff, draft);
    const result = await this.#submitWriter.submitOnce();
    const observedAt = this.#now().toISOString();
    return Object.freeze({
      outcome: result.outcome,
      observedAt,
      evidenceKind: "browser" as const,
      candidateExternalId: result.candidateExternalId,
      candidateExternalUrl: result.candidateExternalUrl,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.ctrip-browser-supervised-submit.v1",
        handoffId: handoff.id,
        previewHash: handoff.previewHash,
        preparedScope: preparedScope(submitScope),
        outcome: result.outcome,
        signalHash: sha256Text(result.signal),
        candidateExternalId: result.candidateExternalId,
        candidateExternalUrl: result.candidateExternalUrl,
        observedAt,
      }),
    });
  }

  readback(): Promise<CtripBridgeReadbackObservation> {
    return Promise.reject(new Error("Ctrip supervised browser adapter cannot read back"));
  }
}
