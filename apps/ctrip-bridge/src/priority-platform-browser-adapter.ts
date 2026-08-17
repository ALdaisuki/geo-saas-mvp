import { createHash } from "node:crypto";

import type { RenderedDraft } from "@geo/connectors";
import type { Platform } from "@geo/contracts";
import {
  ctripPublicContentHash,
  renderCtripPublicBodyFromMarkdown,
  sha256Canonical,
  sha256Text,
} from "@geo/core";

import type {
  PlatformPreparedSurfaceState,
  PlaywrightPlatformPublicationAdapter,
} from "./playwright-platform-publication.js";
import {
  matchesExpectedPayloadText,
  PlatformDraftWriteError,
} from "./playwright-platform-publication.js";
import type {
  PriorityPlatformMediaSurfaceState,
  PriorityPlatformMediaWriter,
} from "./playwright-priority-platform-media-writer.js";
import { PriorityPlatformMediaWriteError } from "./playwright-priority-platform-media-writer.js";
import type {
  CtripBridgeHandoffDraft,
  CtripBridgePreparationBlocker,
  CtripBridgePreparedEvidence,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";
import { CtripPreparedDraftConflictError } from "./types.js";
import { isBrowserRuntimeUnavailableError } from "./browser-runtime-error.js";

export type PriorityPublicationPlatform = Exclude<Platform, "ctrip_community">;

const PREPARED_CONFLICT_EVIDENCE_SCHEMA_VERSION =
  "geo.priority-platform-browser.prepared-conflict.v2";

function normalizedText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function preparedStateEvidence(state: PlatformPreparedSurfaceState): unknown {
  return {
    status: state.status,
    platform: state.platform,
    adapterVersion: state.adapterVersion,
    targetPageCount: state.targetPageCount,
    titleEditorCount: state.titleEditorCount,
    bodyEditorCount: state.bodyEditorCount,
    primaryActionCount: state.primaryActionCount,
    expectedMediaCount: state.expectedMediaCount,
    titleHash: sha256Text(state.titleText),
    bodyHash: sha256Text(state.bodyText),
    challengeSignals: [...state.challengeSignals].sort(),
  };
}

function mediaStateEvidence(state: PriorityPlatformMediaSurfaceState): unknown {
  return {
    status: state.status,
    platform: state.platform,
    coverImageCount: state.coverImageCount,
    inlineImageCount: state.inlineImageCount,
    challengeSignals: [...state.challengeSignals].sort(),
  };
}

function mediaManifest(
  draft: RenderedDraft,
  media: readonly CtripTrustedMediaAttachment[],
): readonly unknown[] {
  if (draft.payload.media.length !== media.length) {
    throw new TypeError("Priority platform media set does not match the audited draft");
  }
  return media.map((attachment, position) => {
    const expected = draft.payload.media[position];
    const bytesSha256 = createHash("sha256").update(attachment.bytes).digest("hex");
    if (
      expected === undefined ||
      attachment.position !== position ||
      sha256Canonical(attachment.reference) !== sha256Canonical(expected) ||
      attachment.reference.byteLength !== attachment.bytes.byteLength ||
      attachment.reference.sha256 !== bytesSha256
    ) {
      throw new TypeError("Priority platform media bytes or reference changed after audit");
    }
    return {
      position,
      role: attachment.reference.role,
      referenceHash: sha256Canonical(attachment.reference),
      referenceSha256: attachment.reference.sha256,
      bytesSha256,
      byteLength: attachment.bytes.byteLength,
      mimeType: attachment.reference.mimeType,
    };
  });
}

function mediaStateMatches(
  state: PriorityPlatformMediaSurfaceState,
  platform: PriorityPublicationPlatform,
  expectedMedia: RenderedDraft["payload"]["media"],
): boolean {
  const expectedCoverCount = expectedMedia.filter(({ role }) => role === "cover").length;
  const expectedInlineCount = expectedMedia.filter(({ role }) => role === "inline").length;
  return (
    state.status === "ready" &&
    state.platform === platform &&
    state.coverImageCount === expectedCoverCount &&
    state.inlineImageCount === expectedInlineCount
  );
}

function preparedSurfaceDiagnosticCode(
  state: PlatformPreparedSurfaceState,
  platform: PriorityPublicationPlatform,
  adapterVersion: string,
  expectedTitle: string,
  expectedBody: string,
  expectedMediaCount: number,
): string {
  if (state.status === "session_required") return "submit:session-required";
  if (state.status === "challenge_required") return "submit:challenge-required";
  if (state.status !== "ready") return `submit:status-${state.status.replaceAll("_", "-")}`;
  if (state.platform !== platform) return "submit:platform-mismatch";
  if (state.adapterVersion !== adapterVersion) return "submit:adapter-version-mismatch";
  if (state.targetPageCount !== 1) return "submit:target-page-count";
  if (state.titleEditorCount !== 1) return "submit:title-editor-count";
  if (state.bodyEditorCount !== 1) return "submit:body-editor-count";
  if (state.primaryActionCount !== 1) return "submit:primary-action-count";
  if (state.expectedMediaCount !== expectedMediaCount) return "submit:media-mismatch";
  if (!matchesExpectedPayloadText(state.titleText, expectedTitle, "title")) {
    return "submit:title-mismatch";
  }
  if (!matchesExpectedPayloadText(state.bodyText, expectedBody, "body")) {
    return "submit:body-mismatch";
  }
  return "submit:surface-drift";
}

function preparedSurfaceMatchesExpected(
  state: PlatformPreparedSurfaceState,
  platform: PriorityPublicationPlatform,
  adapterVersion: string,
  expectedTitle: string,
  expectedBody: string,
  expectedMediaCount: number,
): boolean {
  return (
    state.status === "ready" &&
    state.platform === platform &&
    state.adapterVersion === adapterVersion &&
    state.targetPageCount === 1 &&
    state.titleEditorCount === 1 &&
    state.bodyEditorCount === 1 &&
    state.primaryActionCount === 1 &&
    state.expectedMediaCount === expectedMediaCount &&
    matchesExpectedPayloadText(state.titleText, expectedTitle, "title") &&
    matchesExpectedPayloadText(state.bodyText, expectedBody, "body")
  );
}

function preparedConflict(
  platform: PriorityPublicationPlatform,
  adapterVersion: string,
  observedAt: string,
  expected: unknown,
  observed: unknown,
  diagnosticCode: string,
): CtripPreparedDraftConflictError {
  return new CtripPreparedDraftConflictError({
    evidenceHash: sha256Canonical({
      schemaVersion: PREPARED_CONFLICT_EVIDENCE_SCHEMA_VERSION,
      platform,
      adapterVersion,
      expected,
      observed,
    }),
    observedAt,
    evidenceKind: "browser",
    diagnosticCode,
  });
}

function preparationBlocker(
  outcome: CtripBridgePreparationBlocker["outcome"],
  platform: PriorityPublicationPlatform,
  adapterVersion: string,
  observedAt: string,
  diagnosticCode: string,
  details: unknown,
): CtripBridgePreparationBlocker {
  const sessionEvidenceHash = sha256Canonical({
    schemaVersion: "geo.priority-platform-browser.session.v1",
    platform,
    adapterVersion,
    details,
  });
  return Object.freeze({
    outcome,
    diagnosticCode,
    sessionEvidenceHash,
    evidenceHash: sha256Canonical({
      schemaVersion: "geo.priority-platform-browser.prepare-blocker.v1",
      platform,
      adapterVersion,
      outcome,
      diagnosticCode,
      sessionEvidenceHash,
    }),
    observedAt,
    evidenceKind: "browser" as const,
  });
}

export class PriorityPlatformBrowserAdapter implements CtripFixedAdapter {
  readonly version: string;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: true,
    readback: true,
  });
  readonly #platform: PriorityPublicationPlatform;
  readonly #publication: PlaywrightPlatformPublicationAdapter;
  readonly #mediaWriter: PriorityPlatformMediaWriter | null;
  readonly #expectedAccountName: string;
  readonly #now: () => Date;

  constructor(options: {
    readonly platform: PriorityPublicationPlatform;
    readonly publication: PlaywrightPlatformPublicationAdapter;
    readonly mediaWriter?: PriorityPlatformMediaWriter;
    readonly expectedAccountName: string;
    readonly now?: () => Date;
  }) {
    if (options.publication.definition.platform !== options.platform) {
      throw new TypeError("Priority publication adapter platform does not match its definition");
    }
    if (options.mediaWriter !== undefined && options.mediaWriter.platform !== options.platform) {
      throw new TypeError("Priority media writer platform does not match its publication adapter");
    }
    const expectedAccountName = normalizedText(options.expectedAccountName);
    if (expectedAccountName.length === 0) {
      throw new TypeError("Priority publication adapter requires the exact account display name");
    }
    this.#platform = options.platform;
    this.#publication = options.publication;
    this.#mediaWriter = options.mediaWriter ?? null;
    this.#expectedAccountName = expectedAccountName;
    this.#now = options.now ?? (() => new Date());
    this.version = options.publication.definition.adapterVersion;
  }

  versionFor(handoff: CtripBridgeHandoffDraft): string {
    if (handoff.platform !== this.#platform) {
      throw new TypeError("Priority publication handoff platform does not match its adapter");
    }
    return this.version;
  }

  async prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePreparedEvidence | CtripBridgePreparationBlocker> {
    const observedAt = this.#now().toISOString();
    if (
      handoff.platform !== this.#platform ||
      draft.platform !== this.#platform ||
      handoff.adapterVersion !== this.version
    ) {
      return preparationBlocker(
        "adapter_drift",
        this.#platform,
        this.version,
        observedAt,
        "platform-or-version-scope",
        {
          handoffPlatform: handoff.platform,
          draftPlatform: draft.platform,
          handoffAdapterVersion: handoff.adapterVersion,
        },
      );
    }
    if ((this.#platform === "sohu" || this.#platform === "netease") && media.length === 0) {
      return preparationBlocker(
        "payload_invalid",
        this.#platform,
        this.version,
        observedAt,
        "audited-image-required",
        { mediaCount: media.length },
      );
    }
    const mediaWriter = media.length > 0 ? this.#mediaWriter : null;
    if (media.length > 0 && mediaWriter === null) {
      return preparationBlocker(
        "payload_invalid",
        this.#platform,
        this.version,
        observedAt,
        "sourced-media-writer-required",
        { mediaCount: media.length },
      );
    }

    let manifest: readonly unknown[];
    try {
      manifest = mediaManifest(draft, media);
    } catch (error) {
      return preparationBlocker(
        "payload_invalid",
        this.#platform,
        this.version,
        observedAt,
        "audited-media-mismatch",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }

    const title = draft.payload.title.trim();
    const body = renderCtripPublicBodyFromMarkdown(draft.payload.bodyMarkdown);
    let state: PlatformPreparedSurfaceState;
    try {
      state = await this.#publication.writeDraft({ title, body, mediaCount: media.length });
    } catch (error) {
      const inspected = await this.#publication
        .inspectPrepared({ mediaCount: media.length })
        .catch(() => null);
      const runtimeUnavailable = isBrowserRuntimeUnavailableError(error);
      const challengeRequired =
        inspected?.status === "challenge_required" ||
        (error instanceof Error &&
          /requires an interactive security challenge/iu.test(error.message));
      const outcome =
        runtimeUnavailable || inspected?.status === "session_required"
          ? "session_required"
          : challengeRequired
            ? "challenge_required"
            : "adapter_drift";
      const draftWriteStage =
        error instanceof PlatformDraftWriteError && error.platform === this.#platform
          ? error.stage
          : null;
      const diagnosticError =
        error instanceof PlatformDraftWriteError && error.originalError !== undefined
          ? error.originalError
          : error;
      return preparationBlocker(
        outcome,
        this.#platform,
        this.version,
        observedAt,
        runtimeUnavailable
          ? "draft-write-runtime-unavailable"
          : challengeRequired
            ? "draft-write-challenge-required"
            : draftWriteStage === null
              ? `draft-write-${outcome}`
              : `draft-write-${draftWriteStage}`,
        {
          inspected: inspected === null ? null : preparedStateEvidence(inspected),
          errorType: diagnosticError instanceof Error ? diagnosticError.name : "unknown",
          errorMessage:
            diagnosticError instanceof Error
              ? diagnosticError.message.slice(0, 500)
              : String(diagnosticError).slice(0, 500),
          draftWriteStage,
        },
      );
    }
    if (
      state.status !== "ready" ||
      !matchesExpectedPayloadText(state.titleText, title, "title") ||
      !matchesExpectedPayloadText(state.bodyText, body, "body")
    ) {
      return preparationBlocker(
        state.status === "session_required"
          ? "session_required"
          : state.status === "challenge_required"
            ? "challenge_required"
            : "adapter_drift",
        this.#platform,
        this.version,
        observedAt,
        "prepared-payload-readback",
        preparedStateEvidence(state),
      );
    }

    let mediaState: PriorityPlatformMediaSurfaceState | null = null;
    if (mediaWriter !== null) {
      try {
        mediaState = await mediaWriter.write(media);
      } catch (error) {
        const inspected = await mediaWriter.inspect(draft.payload.media).catch(() => null);
        const runtimeUnavailable =
          error instanceof PriorityPlatformMediaWriteError
            ? error.runtimeUnavailable
            : isBrowserRuntimeUnavailableError(error);
        const challengeRequired = inspected?.status === "challenge_required";
        const mediaWriteStage =
          error instanceof PriorityPlatformMediaWriteError && error.platform === this.#platform
            ? error.stage
            : null;
        return preparationBlocker(
          runtimeUnavailable
            ? "session_required"
            : challengeRequired
              ? "challenge_required"
              : "adapter_drift",
          this.#platform,
          this.version,
          observedAt,
          runtimeUnavailable
            ? "media-write-runtime-unavailable"
            : challengeRequired
              ? "media-write-challenge-required"
              : mediaWriteStage === null
                ? "media-write-adapter-drift"
                : `media-write-${mediaWriteStage}`,
          {
            errorType: error instanceof Error ? error.name : "unknown",
            errorMessage:
              error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            runtimeUnavailable,
            mediaWriteStage,
            inspected: inspected === null ? null : mediaStateEvidence(inspected),
          },
        );
      }
      if (!mediaStateMatches(mediaState, this.#platform, draft.payload.media)) {
        return preparationBlocker(
          mediaState.status === "session_required"
            ? "session_required"
            : mediaState.status === "challenge_required"
              ? "challenge_required"
              : "adapter_drift",
          this.#platform,
          this.version,
          observedAt,
          "prepared-media-readback",
          mediaStateEvidence(mediaState),
        );
      }

      const postMediaState = await this.#publication.inspectPrepared({
        mediaCount: draft.payload.media.length,
      });
      if (
        !preparedSurfaceMatchesExpected(
          postMediaState,
          this.#platform,
          this.version,
          title,
          body,
          draft.payload.media.length,
        )
      ) {
        const submitDiagnostic = preparedSurfaceDiagnosticCode(
          postMediaState,
          this.#platform,
          this.version,
          title,
          body,
          draft.payload.media.length,
        );
        return preparationBlocker(
          postMediaState.status === "session_required"
            ? "session_required"
            : postMediaState.status === "challenge_required"
              ? "challenge_required"
              : "adapter_drift",
          this.#platform,
          this.version,
          observedAt,
          submitDiagnostic.replace(/^submit:/u, "post-media:"),
          preparedStateEvidence(postMediaState),
        );
      }
      state = postMediaState;
    }

    const sessionEvidenceHash = sha256Canonical({
      schemaVersion: "geo.priority-platform-browser.session.v1",
      platform: this.#platform,
      adapterVersion: this.version,
      state: preparedStateEvidence(state),
      mediaState: mediaState === null ? null : mediaStateEvidence(mediaState),
    });
    const mediaManifestHash = sha256Canonical(manifest);
    const draftEvidenceHash = sha256Canonical({
      schemaVersion: "geo.priority-platform-browser.draft.v1",
      platform: this.#platform,
      adapterVersion: this.version,
      title,
      body,
      mediaManifestHash,
    });
    return Object.freeze({
      externalDraftId: `${this.#platform}-editor-${handoff.id}`,
      sessionEvidenceHash,
      draftEvidenceHash,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.priority-platform-browser.prepare.v1",
        handoffId: handoff.id,
        sessionEvidenceHash,
        draftEvidenceHash,
        mediaManifestHash,
      }),
      mediaManifestHash,
      publicContentHash: ctripPublicContentHash(title, body),
      observedAt,
      evidenceKind: "browser" as const,
    });
  }

  async #requirePrepared(draft: RenderedDraft): Promise<PlatformPreparedSurfaceState> {
    if (
      (this.#platform === "sohu" || this.#platform === "netease") &&
      draft.payload.media.length === 0
    ) {
      throw new CtripPreparedDraftConflictError({
        evidenceHash: sha256Canonical({
          schemaVersion: PREPARED_CONFLICT_EVIDENCE_SCHEMA_VERSION,
          platform: this.#platform,
          adapterVersion: this.version,
          expectedMediaCount: 1,
          observedMediaCount: 0,
        }),
        observedAt: this.#now().toISOString(),
        evidenceKind: "browser",
        diagnosticCode: "submit:audited-image-required",
      });
    }
    const state = await this.#publication.inspectPrepared({
      mediaCount: draft.payload.media.length,
    });
    const expectedTitle = normalizedText(draft.payload.title);
    const expectedBody = normalizedText(
      renderCtripPublicBodyFromMarkdown(draft.payload.bodyMarkdown),
    );
    if (
      !preparedSurfaceMatchesExpected(
        state,
        this.#platform,
        this.version,
        expectedTitle,
        expectedBody,
        draft.payload.media.length,
      )
    ) {
      throw preparedConflict(
        this.#platform,
        this.version,
        this.#now().toISOString(),
        {
          expectedTitleHash: sha256Text(expectedTitle),
          expectedBodyHash: sha256Text(expectedBody),
          expectedMediaCount: draft.payload.media.length,
        },
        preparedStateEvidence(state),
        preparedSurfaceDiagnosticCode(
          state,
          this.#platform,
          this.version,
          expectedTitle,
          expectedBody,
          draft.payload.media.length,
        ),
      );
    }
    return state;
  }

  async #verifyPreparedMedia(draft: RenderedDraft): Promise<void> {
    await this.#requirePrepared(draft);
    if (draft.payload.media.length > 0) {
      if (this.#mediaWriter === null) {
        throw new Error(`${this.#platform} sourced media writer is unavailable`);
      }
      const mediaState = await this.#mediaWriter.inspect(draft.payload.media);
      if (!mediaStateMatches(mediaState, this.#platform, draft.payload.media)) {
        const diagnosticCode =
          mediaState.status === "session_required"
            ? "submit:session-required"
            : mediaState.status === "challenge_required"
              ? "submit:challenge-required"
              : "submit:media-mismatch";
        throw preparedConflict(
          this.#platform,
          this.version,
          this.#now().toISOString(),
          { expectedMediaCount: draft.payload.media.length },
          mediaStateEvidence(mediaState),
          diagnosticCode,
        );
      }
    }
  }

  async #repairBaijiahaoPreparedState(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
    originalConflict: CtripPreparedDraftConflictError,
  ): Promise<void> {
    const expectedTitle = normalizedText(draft.payload.title);
    const current = await this.#publication.inspectPrepared({
      mediaCount: draft.payload.media.length,
    });
    if (current.status === "session_required" || current.status === "challenge_required") {
      throw preparedConflict(
        this.#platform,
        this.version,
        this.#now().toISOString(),
        { expectedTitleHash: sha256Text(expectedTitle) },
        preparedStateEvidence(current),
        current.status === "session_required"
          ? "submit:session-required"
          : "submit:challenge-required",
      );
    }
    if (
      normalizedText(current.titleText).length > 0 &&
      !matchesExpectedPayloadText(current.titleText, expectedTitle, "title")
    ) {
      throw originalConflict;
    }

    const repaired = await this.prepare(handoff, draft, media);
    if ("outcome" in repaired) {
      if (repaired.outcome === "session_required" || repaired.outcome === "challenge_required") {
        throw preparedConflict(
          this.#platform,
          this.version,
          this.#now().toISOString(),
          { expectedTitleHash: sha256Text(expectedTitle) },
          {
            outcome: repaired.outcome,
            diagnosticCode: repaired.diagnosticCode,
            evidenceHash: repaired.evidenceHash,
          },
          repaired.outcome === "session_required"
            ? "submit:session-required"
            : "submit:challenge-required",
        );
      }
      throw originalConflict;
    }
  }

  async verifySubmit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    loadMedia?: () => Promise<readonly CtripTrustedMediaAttachment[]>,
  ): Promise<void> {
    this.versionFor(handoff);
    try {
      await this.#verifyPreparedMedia(draft);
      return;
    } catch (error) {
      if (
        !(error instanceof CtripPreparedDraftConflictError) ||
        this.#platform !== "baijiahao" ||
        loadMedia === undefined ||
        ![
          "submit:status-adapter-drift",
          "submit:body-editor-count",
          "submit:body-mismatch",
          "submit:media-mismatch",
        ].includes(error.observation.diagnosticCode)
      ) {
        throw error;
      }
      const media = await loadMedia();
      if (media.length !== draft.payload.media.length) throw error;
      await this.#repairBaijiahaoPreparedState(handoff, draft, media, error);
      await this.#verifyPreparedMedia(draft);
    }
  }

  async submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    this.versionFor(handoff);
    const prepared = await this.#requirePrepared(draft);
    const result = await this.#publication.submitOnce(prepared);
    const observedAt = this.#now().toISOString();
    return Object.freeze({
      outcome: result.outcome,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.priority-platform-browser.submit.v1",
        platform: this.#platform,
        handoffId: handoff.id,
        previewHash: handoff.previewHash,
        prepared: preparedStateEvidence(prepared),
        outcome: result.outcome,
        signalHash: sha256Text(result.signal),
        candidateExternalId: result.candidateExternalId,
        candidateExternalUrl: result.candidateExternalUrl,
        observedAt,
      }),
      observedAt,
      evidenceKind: "browser" as const,
      candidateExternalId: result.candidateExternalId,
      candidateExternalUrl: result.candidateExternalUrl,
    });
  }

  async readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation> {
    this.versionFor(handoff);
    const expectedBody = renderCtripPublicBodyFromMarkdown(draft.payload.bodyMarkdown);
    const result = await this.#publication.readback({
      candidateExternalId: handoff.submitCandidateExternalId,
      candidateExternalUrl: handoff.submitCandidateExternalUrl,
      expectedAccountName: this.#expectedAccountName,
      expectedTitle: draft.payload.title,
      expectedBody,
      submittedAt: handoff.submitObservedAt,
    });
    const observedAt = this.#now().toISOString();
    const observedPayloadHash =
      result.outcome === "confirmed"
        ? ctripPublicContentHash(draft.payload.title, expectedBody)
        : null;
    return Object.freeze({
      outcome: result.outcome,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.priority-platform-browser.readback.v1",
        platform: this.#platform,
        handoffId: handoff.id,
        previewHash: handoff.previewHash,
        expectedAccountNameHash: sha256Text(this.#expectedAccountName),
        expectedPayloadHash: ctripPublicContentHash(draft.payload.title, expectedBody),
        candidateExternalId: handoff.submitCandidateExternalId,
        candidateExternalUrl: handoff.submitCandidateExternalUrl,
        recoveredExternalId: result.externalId,
        recoveredExternalUrl: result.externalUrl,
        recoveredCandidateExternalId: result.candidateExternalId ?? null,
        recoveredCandidateExternalUrl: result.candidateExternalUrl ?? null,
        outcome: result.outcome,
        publisherReasonCode: result.publisherReasonCode ?? null,
        signalHash: sha256Text(result.signal),
        observedAccountNameHash: sha256Text(result.observedAccountName),
        observedTitleHash: sha256Text(result.observedTitle),
        observedBodyHash: sha256Text(result.observedBody),
        observedAt,
      }),
      observedAt,
      evidenceKind:
        result.outcome === "publisher_confirmed" || result.outcome === "publisher_rejected"
          ? ("creator_management" as const)
          : ("platform_readback" as const),
      observedPayloadHash,
      externalId: result.externalId,
      externalUrl: result.externalUrl,
      recoveredCandidateExternalId: result.candidateExternalId ?? null,
      recoveredCandidateExternalUrl: result.candidateExternalUrl ?? null,
      publisherReasonCode: result.publisherReasonCode ?? null,
    });
  }
}
