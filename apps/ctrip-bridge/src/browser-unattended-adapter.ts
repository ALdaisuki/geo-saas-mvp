import type { RenderedDraft } from "@geo/connectors";
import { sha256Canonical, sha256Text } from "@geo/core";

import {
  CtripCommunityBrowserSupervisedAdapter,
} from "./browser-supervised-adapter.js";
import { renderCtripDraftPlainText, type CtripDraftWriter } from "./browser-draft-adapter.js";
import type { CtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";
import type { CtripSupervisedSubmitWriter } from "./playwright-supervised-submit-writer.js";
import type {
  CtripBridgeHandoffDraft,
  CtripBridgePrepareResult,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";

export const CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION =
  "ctrip-community-browser-unattended-v1";

export class CtripCommunityBrowserUnattendedAdapter implements CtripFixedAdapter {
  readonly version = CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: true,
    readback: true,
  });
  readonly #supervised: CtripCommunityBrowserSupervisedAdapter;
  readonly #readbackWriter: CtripPublicReadbackWriter;
  readonly #now: () => Date;

  constructor(options: {
    readonly draftWriter: CtripDraftWriter;
    readonly submitWriter: CtripSupervisedSubmitWriter;
    readonly readbackWriter: CtripPublicReadbackWriter;
    readonly now?: () => Date;
  }) {
    this.#supervised = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: options.draftWriter,
      submitWriter: options.submitWriter,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#readbackWriter = options.readbackWriter;
    this.#now = options.now ?? (() => new Date());
  }

  prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePrepareResult> {
    return this.#supervised.prepare(handoff, draft, media);
  }

  verifySubmit(handoff: CtripBridgeHandoffDraft, draft: RenderedDraft): Promise<void> {
    if (handoff.executionLevel !== "unattended" || draft.executionLevel !== "unattended") {
      return Promise.reject(new Error("Ctrip unattended adapter requires unattended scope"));
    }
    return this.#supervised.verifySubmit(handoff, draft);
  }

  submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    return this.#supervised.submit(handoff, draft);
  }

  async readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation> {
    const result = await this.#readbackWriter.readback({
      candidateExternalId: handoff.submitCandidateExternalId,
      candidateExternalUrl: handoff.submitCandidateExternalUrl,
      expectedTitle: draft.payload.title,
      expectedBody: renderCtripDraftPlainText(draft.payload.bodyMarkdown),
      submittedAt: handoff.submitObservedAt,
    });
    const observedAt = this.#now().toISOString();
    return Object.freeze({
      outcome: result.outcome,
      evidenceKind: "platform_readback" as const,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.ctrip-browser-unattended-readback.v1",
        handoffId: handoff.id,
        candidateExternalId: handoff.submitCandidateExternalId,
        candidateExternalUrl: handoff.submitCandidateExternalUrl,
        recoveredExternalId: result.externalId,
        recoveredExternalUrl: result.externalUrl,
        submitObservedAt: handoff.submitObservedAt,
        outcome: result.outcome,
        signalHash: sha256Text(result.signal),
        observedTitleHash: sha256Text(result.observedTitle),
        observedBodyHash: sha256Text(result.observedBody),
        observedAt,
      }),
      observedAt,
      observedPayloadHash: result.outcome === "confirmed" ? handoff.payloadHash : null,
      externalId: result.externalId,
      externalUrl: result.externalUrl,
    });
  }
}
