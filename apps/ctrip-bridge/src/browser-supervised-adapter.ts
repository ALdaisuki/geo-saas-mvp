import type { RenderedDraft } from "@geo/connectors";
import { sha256Canonical, sha256Text } from "@geo/core";

import {
  CtripCommunityBrowserDraftAdapter,
  renderCtripDraftPlainText,
  type CtripDraftWriter,
} from "./browser-draft-adapter.js";
import type { CtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";
import { ctripPublicContentHash } from "./public-content-binding.js";
import type {
  CtripBridgeHandoffDraft,
  CtripBridgePrepareResult,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";
import { CtripPreparedDraftConflictError } from "./types.js";
import type {
  CtripSupervisedSubmitSurfaceState,
  CtripSupervisedSubmitWriter,
} from "./playwright-supervised-submit-writer.js";

export const CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION = "ctrip-community-browser-supervised-v1";

function normalizedText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trim();
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
    imageInputCount: state.imageInputCount,
    uploadActionCount: state.uploadActionCount,
    draftActionCount: state.draftActionCount,
    locationCount: state.locationCount,
    mediaCount: state.mediaCount,
    finalActionCount: state.finalActionCount,
    titleHash: sha256Text(state.titleText),
    bodyHash: sha256Text(state.bodyText),
    locationHash: sha256Text(state.locationText),
    challengeSignals: [...state.challengeSignals].sort(),
  };
}

function submitScopeDiagnosticCode(input: {
  readonly state: CtripSupervisedSubmitSurfaceState;
  readonly expectedTitle: string;
  readonly expectedBody: string;
  readonly expectedLocation: string;
  readonly expectedMediaCount: number;
}): string {
  const { state } = input;
  if (state.status === "session_required") return "submit:session-required";
  if (state.status === "challenge_required") return "submit:challenge-required";
  if (
    state.status !== "ready" ||
    state.targetPageCount !== 1 ||
    state.titleEditorCount !== 1 ||
    state.bodyEditorCount !== 1 ||
    state.imageInputCount !== 1 ||
    state.uploadActionCount !== 1 ||
    state.draftActionCount !== 1 ||
    state.locationCount !== 1 ||
    state.finalActionCount !== 1
  ) {
    return "submit:surface-drift";
  }
  if (state.mediaCount !== input.expectedMediaCount) return "submit:media-mismatch";
  if (normalizedText(state.titleText) !== input.expectedTitle) return "submit:title-mismatch";
  if (normalizedEditorBody(state.bodyText) !== input.expectedBody) return "submit:body-mismatch";
  if (
    input.expectedLocation.length === 0 ||
    !normalizedText(state.locationText)
      .normalize("NFKC")
      .includes(input.expectedLocation.normalize("NFKC"))
  ) {
    return "submit:location-mismatch";
  }
  return "submit:surface-drift";
}

export class CtripCommunityBrowserSupervisedAdapter implements CtripFixedAdapter {
  readonly version = CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: true,
    readback: true,
  });
  readonly #draftAdapter: CtripCommunityBrowserDraftAdapter;
  readonly #draftWriter: CtripDraftWriter;
  readonly #submitWriter: CtripSupervisedSubmitWriter;
  readonly #readbackWriter: CtripPublicReadbackWriter;
  readonly #now: () => Date;

  constructor(options: {
    readonly draftWriter: CtripDraftWriter;
    readonly submitWriter: CtripSupervisedSubmitWriter;
    readonly readbackWriter: CtripPublicReadbackWriter;
    readonly now?: () => Date;
  }) {
    this.#draftWriter = options.draftWriter;
    this.#draftAdapter = new CtripCommunityBrowserDraftAdapter(
      options.now === undefined
        ? { writer: options.draftWriter }
        : { writer: options.draftWriter, now: options.now },
    );
    this.#submitWriter = options.submitWriter;
    this.#readbackWriter = options.readbackWriter;
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
    const expectedTitle = normalizedText(draft.payload.title);
    const expectedBody = normalizedEditorBody(
      renderCtripDraftPlainText(draft.payload.bodyMarkdown),
    );
    const expectedLocation = normalizedText(draft.payload.locationQuery ?? "");
    if (this.#draftWriter.resumeDraft !== undefined) {
      const resumed = await this.#draftWriter.resumeDraft(expectedTitle);
      if (!resumed.confirmed) {
        const observedAt = this.#now().toISOString();
        throw new CtripPreparedDraftConflictError({
          evidenceHash: sha256Canonical({
            schemaVersion: "geo.ctrip-supervised.draft-resume-conflict.v1",
            expectedTitleHash: sha256Text(expectedTitle),
            resumeSignal: resumed.signal,
          }),
          observedAt,
          evidenceKind: "browser",
          diagnosticCode: `submit:draft-resume-${resumed.signal}`,
        });
      }
    }
    const state = await this.#submitWriter.inspectPrepared();
    const matches =
      state.status !== "ready" ||
      state.targetPageCount !== 1 ||
      state.titleEditorCount !== 1 ||
      state.bodyEditorCount !== 1 ||
      state.imageInputCount !== 1 ||
      state.uploadActionCount !== 1 ||
      state.draftActionCount !== 1 ||
      state.locationCount !== 1 ||
      state.mediaCount !== draft.payload.media.length ||
      state.finalActionCount !== 1 ||
      normalizedText(state.titleText) !== expectedTitle ||
      normalizedEditorBody(state.bodyText) !== expectedBody ||
      expectedLocation.length === 0 ||
      !normalizedText(state.locationText)
        .normalize("NFKC")
        .includes(expectedLocation.normalize("NFKC"));
    if (matches) {
      const observedAt = this.#now().toISOString();
      throw new CtripPreparedDraftConflictError({
        evidenceHash: sha256Canonical({
          schemaVersion: "geo.ctrip-supervised.submit-conflict.v1",
          expected: {
            titleHash: sha256Text(expectedTitle),
            bodyHash: sha256Text(expectedBody),
            locationHash: sha256Text(expectedLocation),
            mediaCount: draft.payload.media.length,
          },
          observed: preparedScope(state),
        }),
        observedAt,
        evidenceKind: "browser",
        diagnosticCode: submitScopeDiagnosticCode({
          state,
          expectedTitle,
          expectedBody,
          expectedLocation,
          expectedMediaCount: draft.payload.media.length,
        }),
      });
    }
    return state;
  }

  async verifySubmit(handoff: CtripBridgeHandoffDraft, draft: RenderedDraft): Promise<void> {
    await this.#requireSubmitScope(handoff, draft);
  }

  async submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    const submitScope = await this.#requireSubmitScope(handoff, draft);
    const result = await this.#submitWriter.submitOnce(submitScope);
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

  async readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation> {
    const expectedBody = renderCtripDraftPlainText(draft.payload.bodyMarkdown);
    const expectedPublicContentHash = ctripPublicContentHash(draft.payload.title, expectedBody);
    const result = await this.#readbackWriter.readback({
      candidateExternalId: handoff.submitCandidateExternalId,
      candidateExternalUrl: handoff.submitCandidateExternalUrl,
      expectedTitle: draft.payload.title,
      expectedBody,
      submittedAt: handoff.submitObservedAt,
    });
    const observedAt = this.#now().toISOString();
    const observedPayloadHash =
      result.outcome === "confirmed"
        ? ctripPublicContentHash(result.observedTitle, result.observedBody)
        : null;
    return Object.freeze({
      outcome: result.outcome,
      evidenceKind:
        result.outcome === "publisher_rejected"
          ? ("creator_management" as const)
          : ("platform_readback" as const),
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.ctrip-browser-supervised-readback.v1",
        handoffId: handoff.id,
        previewHash: handoff.previewHash,
        expectedPublicContentHash,
        candidateExternalId: handoff.submitCandidateExternalId,
        candidateExternalUrl: handoff.submitCandidateExternalUrl,
        recoveredExternalId: result.externalId,
        recoveredExternalUrl: result.externalUrl,
        submitObservedAt: handoff.submitObservedAt,
        outcome: result.outcome,
        publisherReasonCode: result.publisherReasonCode ?? null,
        signalHash: sha256Text(result.signal),
        observedTitleHash: sha256Text(result.observedTitle),
        observedBodyHash: sha256Text(result.observedBody),
        observedPayloadHash,
        observedAt,
      }),
      observedAt,
      observedPayloadHash,
      externalId: result.externalId,
      externalUrl: result.externalUrl,
      publisherReasonCode: result.publisherReasonCode ?? null,
    });
  }
}
