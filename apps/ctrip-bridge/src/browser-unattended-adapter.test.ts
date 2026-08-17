import type { RenderedDraft } from "@geo/connectors";
import { describe, expect, it, vi } from "vitest";

import type { CtripDraftWriter } from "./browser-draft-adapter.js";
import { CtripCommunityBrowserUnattendedAdapter } from "./browser-unattended-adapter.js";
import type { CtripPublicReadbackWriter } from "./playwright-public-readback-writer.js";
import type { CtripSupervisedSubmitWriter } from "./playwright-supervised-submit-writer.js";
import { ctripPublicContentHash } from "./public-content-binding.js";
import type { CtripBridgeHandoffDraft } from "./types.js";

const observedAt = "2026-07-21T05:00:00.000Z";
const submittedAt = "2026-07-21T04:30:00.000Z";
const draft = {
  executionLevel: "unattended",
  payload: {
    title: "日本亲子行前准备三步",
    bodyMarkdown: "准备护照，确认交通，再安排每日节奏。",
    locationQuery: "日本",
    media: [{}],
  },
} as unknown as RenderedDraft;
const handoff = {
  id: "10000000-0000-4000-8000-000000000001",
  previewHash: "b".repeat(64),
  executionLevel: "unattended",
  payloadHash: "a".repeat(64),
  submitCandidateExternalId: null,
  submitCandidateExternalUrl: null,
  submitObservedAt: submittedAt,
} as unknown as CtripBridgeHandoffDraft;

function createAdapter(result: { readonly externalId: string; readonly externalUrl: string }) {
  const submitOnce = vi.fn();
  const readback = vi.fn(async () => ({
    outcome: "confirmed" as const,
    externalId: result.externalId,
    externalUrl: result.externalUrl,
    observedTitle: draft.payload.title,
    observedBody: draft.payload.bodyMarkdown,
    signal: "public-payload-matched",
  }));
  const adapter = new CtripCommunityBrowserUnattendedAdapter({
    draftWriter: {} as CtripDraftWriter,
    submitWriter: { inspectPrepared: vi.fn(), submitOnce } as CtripSupervisedSubmitWriter,
    readbackWriter: { readback } as CtripPublicReadbackWriter,
    now: () => new Date(observedAt),
  });
  return { adapter, readback, submitOnce };
}

describe("Ctrip browser unattended adapter", () => {
  it("passes submit time to recovery, hashes recovered identity and never re-submits during readback", async () => {
    const first = createAdapter({
      externalId: "123450001",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450001",
    });
    const second = createAdapter({
      externalId: "123450002",
      externalUrl: "https://m.ctrip.com/webapp/you/community/detail?articleId=123450002",
    });

    const firstObservation = await first.adapter.readback(handoff, draft);
    const secondObservation = await second.adapter.readback(handoff, draft);

    expect(first.readback).toHaveBeenCalledWith({
      candidateExternalId: null,
      candidateExternalUrl: null,
      expectedTitle: draft.payload.title,
      expectedBody: draft.payload.bodyMarkdown,
      submittedAt,
    });
    expect(first.submitOnce).not.toHaveBeenCalled();
    expect(second.submitOnce).not.toHaveBeenCalled();
    expect(firstObservation).toMatchObject({
      outcome: "confirmed",
      evidenceKind: "platform_readback",
      observedAt,
      observedPayloadHash: ctripPublicContentHash(draft.payload.title, draft.payload.bodyMarkdown),
      externalId: "123450001",
    });
    expect(firstObservation.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstObservation.evidenceHash).not.toBe(secondObservation.evidenceHash);
  });
});
