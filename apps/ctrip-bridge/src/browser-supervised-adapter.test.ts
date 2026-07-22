import type { RenderedDraft } from "@geo/connectors";
import { describe, expect, it, vi } from "vitest";

import type { CtripDraftWriter } from "./browser-draft-adapter.js";
import {
  CtripCommunityBrowserSupervisedAdapter,
  CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION,
} from "./browser-supervised-adapter.js";
import type { CtripSupervisedSubmitWriter } from "./playwright-supervised-submit-writer.js";
import type { CtripBridgeHandoffDraft } from "./types.js";

const now = "2026-07-17T13:00:00.000Z";
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

describe("Ctrip browser supervised adapter", () => {
  it("rechecks the audited prepared scope and returns bounded browser evidence", async () => {
    const writer = submitWriter();
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: writer,
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
    expect(adapter.version).toBe(CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION);
    expect(adapter.commandCapabilities).toEqual({
      prepare: true,
      submit: true,
      readback: false,
    });
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
      });
      await expect(adapter.verifySubmit(handoff, draft)).rejects.toThrow(/audited submit scope/iu);
      expect(writer.submitOnce).not.toHaveBeenCalled();
    }
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
      });

      await expect(adapter.verifySubmit(handoff, paragraphDraft)).rejects.toThrow(
        /audited submit scope/iu,
      );
    }
  });

  it("does not implement independent publication readback", async () => {
    const adapter = new CtripCommunityBrowserSupervisedAdapter({
      draftWriter: draftWriter(),
      submitWriter: submitWriter(),
    });
    await expect(adapter.readback()).rejects.toThrow(/cannot read back/iu);
  });
});
