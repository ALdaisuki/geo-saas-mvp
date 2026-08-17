import type { RenderedDraft } from "@geo/connectors";
import { describe, expect, it, vi } from "vitest";

import type { CtripDraftWriter } from "./browser-draft-adapter.js";
import {
  CtripCommunityBrowserSupervisedAdapter,
  CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION,
} from "./browser-supervised-adapter.js";
import type { CtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";
import type { CtripSupervisedSubmitWriter } from "./playwright-supervised-submit-writer.js";
import { ctripPublicContentHash } from "./public-content-binding.js";
import type { CtripBridgeHandoffDraft } from "./types.js";
import { CtripPreparedDraftConflictError } from "./types.js";

const now = "2026-07-17T13:00:00.000Z";
const submittedAt = "2026-07-17T12:59:00.000Z";
const title = "Shanghai family guide";
const locationQuery = "Shanghai";
const body =
  "A verified Ctrip article body with enough detail for one supervised publication operation.";
const draft = {
  payload: { title, bodyMarkdown: body, locationQuery, media: [{}] },
} as unknown as RenderedDraft;
const handoff = {
  id: "10000000-0000-4000-8000-000000000001",
  previewHash: "a".repeat(64),
  submitCandidateExternalId: null,
  submitCandidateExternalUrl: null,
  submitObservedAt: submittedAt,
} as unknown as CtripBridgeHandoffDraft;

function draftWriter(): CtripDraftWriter {
  return {
    inspect: vi.fn(),
    fillTitle: vi.fn(),
    fillBody: vi.fn(),
    fillLocation: vi.fn(),
    readLocation: vi.fn(),
    clearImages: vi.fn(),
    uploadImage: vi.fn(),
    countImages: vi.fn(async () => 1),
    saveDraft: vi.fn(),
  };
}

function resumableDraftWriter(result: { readonly confirmed: boolean; readonly signal: string }) {
  return {
    ...draftWriter(),
    resumeDraft: vi.fn(async () => result),
  } satisfies CtripDraftWriter;
}

function submitWriter(
  overrides: {
    readonly title?: string;
    readonly body?: string;
    readonly location?: string;
    readonly locationCount?: number;
    readonly mediaCount?: number;
  } = {},
) {
  const value: CtripSupervisedSubmitWriter = {
    inspectPrepared: vi.fn(async () => ({
      status: "ready" as const,
      targetPageCount: 1,
      titleEditorCount: 1,
      bodyEditorCount: 1,
      imageInputCount: 1,
      uploadActionCount: 1,
      draftActionCount: 1,
      locationCount: overrides.locationCount ?? 1,
      mediaCount: overrides.mediaCount ?? 1,
      finalActionCount: 1,
      titleText: overrides.title ?? title,
      bodyText: overrides.body ?? body,
      locationText: overrides.location ?? `${locationQuery}, China`,
      challengeSignals: [],
    })),
    submitOnce: vi.fn(async () => ({
      outcome: "accepted" as const,
      signal: "publication-accepted",
      candidateExternalId: null,
      candidateExternalUrl: null,
    })),
  };
  return value;
}

function publicReadbackWriter(
  result: {
    readonly outcome?: "confirmed" | "not_found" | "mismatch" | "unavailable";
    readonly externalId?: string | null;
    readonly externalUrl?: string | null;
    readonly observedTitle?: string;
    readonly observedBody?: string;
  } = {},
) {
  const readback = vi.fn(async () => ({
    outcome: result.outcome ?? ("confirmed" as const),
    externalId: result.externalId ?? "123450001",
    externalUrl:
      result.externalUrl ?? "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
    observedTitle: result.observedTitle ?? title,
    observedBody: result.observedBody ?? body,
    signal: "public-payload-matched",
  }));
  return { writer: { readback } as CtripPublicReadbackWriter, readback };
}

describe("Ctrip browser supervised adapter", () => {
  it("rechecks the audited prepared scope and returns bounded browser evidence", async () => {
    const writer = submitWriter();
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: writer,
      readbackWriter: publicReadbackWriter().writer,
      now: () => new Date(now),
    });

    await expect(adapter.verifySubmit(handoff, draft)).resolves.toBeUndefined();
    await expect(adapter.submit(handoff, draft)).resolves.toMatchObject({
      outcome: "accepted",
      evidenceKind: "browser",
      observedAt: now,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(writer.inspectPrepared).toHaveBeenCalledTimes(2);
    expect(writer.submitOnce).toHaveBeenCalledOnce();
    expect(writer.submitOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        titleText: title,
        bodyText: body,
        locationText: `${locationQuery}, China`,
        mediaCount: 1,
      }),
    );
    expect(adapter.version).toBe(CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION);
    expect(adapter.commandCapabilities).toEqual({
      prepare: true,
      submit: true,
      readback: true,
    });
  });

  it("resumes the durable Ctrip draft before inspecting the submit scope", async () => {
    const writer = resumableDraftWriter({ confirmed: true, signal: "draft-editor-reopened" });
    const submit = submitWriter();
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: writer,
      submitWriter: submit,
      readbackWriter: publicReadbackWriter().writer,
      now: () => new Date(now),
    });

    await expect(adapter.verifySubmit(handoff, draft)).resolves.toBeUndefined();
    expect(writer.resumeDraft).toHaveBeenCalledWith(title);
    expect(submit.inspectPrepared).toHaveBeenCalledAfter(writer.resumeDraft);
  });

  it("fails closed when the persisted Ctrip draft cannot be resumed uniquely", async () => {
    const writer = resumableDraftWriter({
      confirmed: false,
      signal: "draft-management-row-not-unique",
    });
    const submit = submitWriter();
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: writer,
      submitWriter: submit,
      readbackWriter: publicReadbackWriter().writer,
      now: () => new Date(now),
    });

    const captured = await adapter.verifySubmit(handoff, draft).catch((error: unknown) => error);
    expect(captured).toMatchObject({
      observation: { diagnosticCode: "submit:draft-resume-draft-management-row-not-unique" },
    });
    expect(submit.inspectPrepared).not.toHaveBeenCalled();
  });

  it("rejects changed content or media before the fixed final action", async () => {
    for (const writer of [
      submitWriter({ title: "changed title" }),
      submitWriter({ body: `${body}!` }),
      submitWriter({ location: "Beijing, China" }),
      submitWriter({ locationCount: 0 }),
      submitWriter({ mediaCount: 0 }),
    ]) {
      const adapter = new CtripCommunityBrowserSupervisedAdapter({
        draftWriter: draftWriter(),
        submitWriter: writer,
        readbackWriter: publicReadbackWriter().writer,
      });
      await expect(adapter.verifySubmit(handoff, draft)).rejects.toBeInstanceOf(
        CtripPreparedDraftConflictError,
      );
      expect(writer.submitOnce).not.toHaveBeenCalled();
    }
  });

  it.each([
    [submitWriter({ title: "changed title" }), "submit:title-mismatch"],
    [submitWriter({ body: `${body}!` }), "submit:body-mismatch"],
    [submitWriter({ location: "Beijing, China" }), "submit:location-mismatch"],
    [submitWriter({ locationCount: 0 }), "submit:surface-drift"],
    [submitWriter({ mediaCount: 0 }), "submit:media-mismatch"],
  ])("reports the exact audited submit-scope mismatch", async (writer, diagnosticCode) => {
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: writer,
      readbackWriter: publicReadbackWriter().writer,
      now: () => new Date(now),
    });

    const captured = await adapter.verifySubmit(handoff, draft).catch((error: unknown) => error);
    expect(captured).toBeInstanceOf(CtripPreparedDraftConflictError);
    expect(captured).toMatchObject({ observation: { diagnosticCode, observedAt: now } });
  });

  it("accepts a DraftJS readback that only omits audited paragraph line breaks", async () => {
    const paragraphBody = "First audited paragraph.\n\nSecond audited paragraph.";
    const paragraphDraft = {
      payload: {
        title,
        bodyMarkdown: paragraphBody,
        locationQuery,
        media: [{}],
      },
    } as unknown as RenderedDraft;
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: submitWriter({
        body: "First audited paragraph.Second audited paragraph.",
      }),
      readbackWriter: publicReadbackWriter().writer,
    });

    await expect(adapter.verifySubmit(handoff, paragraphDraft)).resolves.toBeUndefined();
  });

  it("rejects punctuation or body text changes after paragraph normalization", async () => {
    const paragraphBody = "First audited paragraph.\n\nSecond audited paragraph.";
    const paragraphDraft = {
      payload: {
        title,
        bodyMarkdown: paragraphBody,
        locationQuery,
        media: [{}],
      },
    } as unknown as RenderedDraft;

    for (const changedBody of [
      "First audited paragraph!Second audited paragraph.",
      "First audited paragraph.Second changed paragraph.",
    ]) {
      const adapter = new CtripCommunityBrowserSupervisedAdapter({
        draftWriter: draftWriter(),
        submitWriter: submitWriter({ body: changedBody }),
        readbackWriter: publicReadbackWriter().writer,
      });

      await expect(adapter.verifySubmit(handoff, paragraphDraft)).rejects.toBeInstanceOf(
        CtripPreparedDraftConflictError,
      );
    }
  });

  it("performs explicit content-bound public readback without submitting again", async () => {
    const submit = submitWriter();
    const publicWriter = publicReadbackWriter();
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: submit,
      readbackWriter: publicWriter.writer,
      now: () => new Date(now),
    });

    await expect(adapter.readback(handoff, draft)).resolves.toMatchObject({
      outcome: "confirmed",
      evidenceKind: "platform_readback",
      observedAt: now,
      observedPayloadHash: ctripPublicContentHash(title, body),
      externalId: "123450001",
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(publicWriter.readback).toHaveBeenCalledWith({
      candidateExternalId: null,
      candidateExternalUrl: null,
      expectedTitle: title,
      expectedBody: body,
      submittedAt,
    });
    expect(submit.submitOnce).not.toHaveBeenCalled();
  });

  it("never records an observed payload hash for a mismatched public page", async () => {
    const publicWriter = publicReadbackWriter({
      outcome: "mismatch",
      observedBody: `${body} changed`,
    });
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: submitWriter(),
      readbackWriter: publicWriter.writer,
      now: () => new Date(now),
    });

    await expect(adapter.readback(handoff, draft)).resolves.toMatchObject({
      outcome: "mismatch",
      evidenceKind: "platform_readback",
      observedPayloadHash: null,
    });
  });
});
