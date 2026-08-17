import { createHash } from "node:crypto";

import { CTRIP_COMMUNITY_PUBLICATION_LIMITS } from "@geo/contracts";
import { mediaSceneSignature, renderCtripPublicBodyFromMarkdown, sha256Canonical } from "@geo/core";

import type {
  CtripBridgePreparationBlocker,
  CtripBridgePreparedEvidence,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
  CtripFixedAdapter,
  CtripBridgeHandoffDraft,
  CtripTrustedMediaAttachment,
} from "./types.js";
import type { RenderedDraft } from "@geo/connectors";

import { ctripLocationKeywordCoverage, matchesCtripLocationQuery } from "./ctrip-location-match.js";
import { ctripPublicContentHash } from "./public-content-binding.js";

export const CTRIP_BROWSER_DRAFT_ADAPTER_VERSION = "ctrip-community-browser-draft-v1";

export const CTRIP_DRAFT_LIMITS = CTRIP_COMMUNITY_PUBLICATION_LIMITS;

export interface CtripDraftWriterFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface CtripDraftSurfaceState {
  readonly status: "ready" | "session_required" | "challenge_required" | "adapter_drift";
  readonly targetPageCount: number;
  readonly titleEditorCount: number;
  readonly bodyEditorCount: number;
  readonly imageInputCount: number;
  readonly uploadActionCount: number;
  readonly draftActionCount: number;
  readonly publishActionCount: number;
  readonly challengeSignals: readonly string[];
}

export interface CtripDraftSaveResult {
  readonly confirmed: boolean;
  readonly signal: string;
}

export interface CtripDraftWriter {
  inspect(): Promise<CtripDraftSurfaceState>;
  ensureTargetPage?(): Promise<boolean>;
  fillTitle(value: string): Promise<string>;
  fillBody(value: string): Promise<string>;
  fillLocation?(query: string): Promise<string>;
  readLocation?(): Promise<string>;
  clearImages(): Promise<number>;
  uploadImage(file: CtripDraftWriterFile): Promise<number>;
  countImages(): Promise<number>;
  saveDraft(): Promise<CtripDraftSaveResult>;
  resumeDraft?(expectedTitle: string): Promise<CtripDraftSaveResult>;
}

function codePointLength(value: string): number {
  return [...value].length;
}

export const renderCtripDraftPlainText = renderCtripPublicBodyFromMarkdown;

function normalizeEditorText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}

function imageFileName(position: number, mimeType: string): string {
  const extension = mimeType.split("/", 2)[1]?.replace(/[^a-z0-9]/giu, "") || "bin";
  return `geo-ctrip-${String(position + 1).padStart(2, "0")}.${extension}`;
}

function sessionEvidenceHash(state: CtripDraftSurfaceState): string {
  return sha256Canonical({
    schemaVersion: "geo.ctrip-browser-draft.session.v1",
    status: state.status,
    targetPageCount: state.targetPageCount,
    titleEditorCount: state.titleEditorCount,
    bodyEditorCount: state.bodyEditorCount,
    imageInputCount: state.imageInputCount,
    uploadActionCount: state.uploadActionCount,
    draftActionCount: state.draftActionCount,
    publishActionCount: state.publishActionCount,
    challengeSignals: [...state.challengeSignals].sort(),
  });
}

function blocker(
  outcome: CtripBridgePreparationBlocker["outcome"],
  sessionHash: string,
  observedAt: string,
  diagnosticCode: string,
  details: unknown,
): CtripBridgePreparationBlocker {
  return Object.freeze({
    outcome,
    diagnosticCode,
    sessionEvidenceHash: sessionHash,
    evidenceHash: sha256Canonical({
      schemaVersion: "geo.ctrip-browser-draft.blocker.v1",
      outcome,
      sessionEvidenceHash: sessionHash,
      details,
    }),
    observedAt,
    evidenceKind: "browser" as const,
  });
}

export class CtripCommunityBrowserDraftAdapter implements CtripFixedAdapter {
  readonly version = CTRIP_BROWSER_DRAFT_ADAPTER_VERSION;
  readonly evidenceKind = "browser" as const;
  readonly commandCapabilities = Object.freeze({
    prepare: true,
    submit: false,
    readback: false,
  });
  readonly #writer: CtripDraftWriter;
  readonly #now: () => Date;

  constructor(options: { readonly writer: CtripDraftWriter; readonly now?: () => Date }) {
    this.#writer = options.writer;
    this.#now = options.now ?? (() => new Date());
  }

  async prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
    media: readonly CtripTrustedMediaAttachment[],
  ): Promise<CtripBridgePreparedEvidence | CtripBridgePreparationBlocker> {
    const observedAt = this.#now().toISOString();
    const title = draft.payload.title.trim();
    const body = renderCtripDraftPlainText(draft.payload.bodyMarkdown);
    const locationQuery = draft.payload.locationQuery?.trim() ?? "";
    const coverCount = media.filter((attachment) => attachment.reference.role === "cover").length;
    const mediaHashes = media.map((attachment) => attachment.reference.sha256);
    const sceneSignatures = media.map((attachment) =>
      mediaSceneSignature(attachment.reference.inspection.labels),
    );
    const mediaDiversityValid =
      new Set(mediaHashes).size === mediaHashes.length &&
      sceneSignatures.every((signature) => signature !== null);
    let state = await this.#writer.inspect();
    const recoverableUnhydratedSurface =
      state.targetPageCount === 1 &&
      state.titleEditorCount <= 1 &&
      state.bodyEditorCount <= 1 &&
      state.imageInputCount <= 1 &&
      state.uploadActionCount <= 1 &&
      state.draftActionCount <= 1 &&
      state.publishActionCount <= 1;
    if (
      ((state.status === "session_required" && state.targetPageCount === 0) ||
        (state.status === "adapter_drift" && recoverableUnhydratedSurface)) &&
      this.#writer.ensureTargetPage !== undefined
    ) {
      try {
        await this.#writer.ensureTargetPage();
        state = await this.#writer.inspect();
      } catch {
        // The subsequent surface check remains authoritative and records a bounded blocker.
      }
    }
    const sessionHash = sessionEvidenceHash(state);
    if (
      codePointLength(title) < CTRIP_DRAFT_LIMITS.minTitleCharacters ||
      codePointLength(title) > CTRIP_DRAFT_LIMITS.maxTitleCharacters ||
      codePointLength(body) < CTRIP_DRAFT_LIMITS.minBodyCharacters ||
      codePointLength(body) > CTRIP_DRAFT_LIMITS.maxBodyCharacters ||
      locationQuery.length === 0 ||
      media.length < CTRIP_DRAFT_LIMITS.minImages ||
      media.length > CTRIP_DRAFT_LIMITS.maxImages ||
      coverCount !== 1 ||
      !mediaDiversityValid
    ) {
      return blocker("payload_invalid", sessionHash, observedAt, "payload-limits", {
        phase: "payload-limits",
        titleCharacters: codePointLength(title),
        bodyCharacters: codePointLength(body),
        locationQueryPresent: locationQuery.length > 0,
        imageCount: media.length,
        coverCount,
        uniqueImageBytes: new Set(mediaHashes).size,
        uniqueSceneSignatures: new Set(sceneSignatures.filter((value) => value !== null)).size,
        sceneSignatureCount: sceneSignatures.filter((value) => value !== null).length,
      });
    }
    if (media.some((attachment) => !/^image\//iu.test(attachment.reference.mimeType))) {
      throw new TypeError("Ctrip draft media must use image MIME types");
    }

    if (state.status !== "ready" && state.status !== "challenge_required") {
      const outcome = state.status === "session_required" ? "session_required" : state.status;
      return blocker(outcome, sessionHash, observedAt, `surface-${outcome}`, state);
    }
    if (
      state.targetPageCount !== 1 ||
      state.titleEditorCount !== 1 ||
      state.bodyEditorCount !== 1 ||
      state.imageInputCount !== 1 ||
      state.uploadActionCount !== 1 ||
      state.draftActionCount !== 1 ||
      state.publishActionCount !== 1
    ) {
      return blocker("adapter_drift", sessionHash, observedAt, "surface-contract", state);
    }

    let remainingImages: number;
    try {
      remainingImages = await this.#writer.clearImages();
    } catch (error) {
      return blocker("adapter_drift", sessionHash, observedAt, "media-clear-error", {
        phase: "media-clear",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    if (remainingImages !== 0) {
      return blocker("adapter_drift", sessionHash, observedAt, "media-clear-incomplete", {
        phase: "media-clear",
        remainingImages,
      });
    }

    const titleReadback = normalizeEditorText(await this.#writer.fillTitle(title));
    if (titleReadback !== title) {
      return blocker("adapter_drift", sessionHash, observedAt, "title-readback", {
        phase: "title",
        titleReadback,
      });
    }
    const bodyReadback = normalizeEditorText(await this.#writer.fillBody(body));
    if (bodyReadback !== normalizeEditorText(body)) {
      return blocker("adapter_drift", sessionHash, observedAt, "body-readback", {
        phase: "body",
        bodyReadback,
      });
    }
    const locationReadback =
      this.#writer.fillLocation === undefined || this.#writer.readLocation === undefined
        ? ""
        : normalizeEditorText(await this.#writer.fillLocation(locationQuery));
    if (
      locationReadback.length > 0 &&
      !matchesCtripLocationQuery(locationReadback, locationQuery)
    ) {
      return blocker("adapter_drift", sessionHash, observedAt, "location-readback", {
        phase: "location",
        locationQuery,
        locationReadback,
        keywordCoverage: ctripLocationKeywordCoverage(locationReadback, locationQuery),
      });
    }

    const mediaManifest = media.map((attachment, position) => ({
      position,
      sha256: attachment.reference.sha256,
      byteLength: attachment.bytes.byteLength,
      mimeType: attachment.reference.mimeType,
    }));
    const mediaManifestHash = sha256Canonical(mediaManifest);
    for (const [position, attachment] of media.entries()) {
      const actualSha256 = createHash("sha256").update(attachment.bytes).digest("hex");
      if (actualSha256 !== attachment.reference.sha256) {
        throw new TypeError("Ctrip draft media bytes changed after audit");
      }
      const uploadedCount = await this.#writer.uploadImage({
        name: imageFileName(position, attachment.reference.mimeType),
        mimeType: attachment.reference.mimeType,
        bytes: attachment.bytes,
      });
      if (uploadedCount !== position + 1) {
        return blocker("adapter_drift", sessionHash, observedAt, "media-upload-count", {
          phase: "media",
          expectedCount: position + 1,
          uploadedCount,
        });
      }
    }

    const saved = await this.#writer.saveDraft();
    const resumed =
      this.#writer.resumeDraft === undefined
        ? { confirmed: true, signal: "draft-editor-state-unchanged" }
        : await this.#writer.resumeDraft(title);
    const draftEvidenceHash = sha256Canonical({
      schemaVersion: "geo.ctrip-browser-draft.content.v1",
      title,
      body,
      locationQuery,
      locationReadback,
      mediaManifestHash,
      saveSignal: saved.signal,
      resumeSignal: resumed.signal,
    });
    if (!saved.confirmed || !resumed.confirmed) {
      const diagnosticCode = saved.confirmed
        ? `draft-resume:${resumed.signal}`
        : `draft-save:${saved.signal}`;
      return blocker("adapter_drift", sessionHash, observedAt, diagnosticCode, {
        phase: saved.confirmed ? "resume" : "save",
        signal: saved.confirmed ? resumed.signal : saved.signal,
        draftEvidenceHash,
      });
    }
    const persistedLocation =
      locationReadback.length === 0 || this.#writer.readLocation === undefined
        ? ""
        : normalizeEditorText(await this.#writer.readLocation());
    if (
      locationReadback.length > 0 &&
      (persistedLocation.length === 0 ||
        !matchesCtripLocationQuery(persistedLocation, locationQuery))
    ) {
      return blocker("adapter_drift", sessionHash, observedAt, "location-persistence", {
        phase: "post-resume-location",
        expectedLocation: locationReadback,
        persistedLocation,
        keywordCoverage: ctripLocationKeywordCoverage(persistedLocation, locationQuery),
        draftEvidenceHash,
      });
    }
    let persistedMediaCount: number;
    try {
      persistedMediaCount = await this.#writer.countImages();
    } catch (error) {
      return blocker("adapter_drift", sessionHash, observedAt, "media-persistence-inspection", {
        phase: "post-resume-media",
        error: error instanceof Error ? error.name : "unknown",
        draftEvidenceHash,
      });
    }
    if (persistedMediaCount !== media.length) {
      return blocker("adapter_drift", sessionHash, observedAt, "media-persistence-count", {
        phase: "post-resume-media",
        expectedCount: media.length,
        persistedMediaCount,
        draftEvidenceHash,
      });
    }
    const persistedDraftEvidenceHash = sha256Canonical({
      schemaVersion: "geo.ctrip-browser-draft.content.v1",
      title,
      body,
      locationQuery,
      locationReadback,
      persistedLocation,
      mediaManifestHash,
      saveSignal: saved.signal,
      resumeSignal: resumed.signal,
      persistedMediaCount,
    });
    return Object.freeze({
      externalDraftId: `ctrip-draft-${handoff.id}`,
      sessionEvidenceHash: sessionHash,
      draftEvidenceHash: persistedDraftEvidenceHash,
      evidenceHash: sha256Canonical({
        schemaVersion: "geo.ctrip-browser-draft.evidence.v1",
        handoffId: handoff.id,
        sessionEvidenceHash: sessionHash,
        draftEvidenceHash: persistedDraftEvidenceHash,
        mediaManifestHash,
      }),
      mediaManifestHash,
      publicContentHash: ctripPublicContentHash(title, body),
      observedAt,
      evidenceKind: "browser" as const,
    });
  }

  submit(): Promise<CtripBridgeSubmitObservation> {
    return Promise.reject(new Error("Ctrip browser draft adapter cannot submit"));
  }

  readback(): Promise<CtripBridgeReadbackObservation> {
    return Promise.reject(new Error("Ctrip browser draft adapter cannot read back"));
  }
}
