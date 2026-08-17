import { createHash } from "node:crypto";

import { renderBrowserAssistedDraft } from "@geo/connectors";
import { ctripPublicContentHash } from "@geo/core";
import type { MediaReference } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import { BAIJIAHAO_PUBLICATION_DEFINITION } from "./playwright-baijiahao-publication.js";
import { SOHU_PUBLICATION_DEFINITION } from "./playwright-sohu-publication.js";
import {
  PriorityPlatformMediaWriteError,
  type PriorityPlatformMediaWriter,
} from "./playwright-priority-platform-media-writer.js";
import { TOUTIAO_PUBLICATION_DEFINITION } from "./playwright-toutiao-publication.js";
import { PriorityPlatformBrowserAdapter } from "./priority-platform-browser-adapter.js";
import { CtripAccountScopedAdapter } from "./account-scoped-adapter.js";
import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";
import type {
  PlatformPreparedSurfaceState,
  PlaywrightPlatformPublicationAdapter,
} from "./playwright-platform-publication.js";
import {
  CtripPreparedDraftConflictError,
  type CtripBridgeHandoffDraft,
  type CtripTrustedMediaAttachment,
} from "./types.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const channelAccountId = "10000000-0000-4000-8000-000000000003";
const variantId = "10000000-0000-4000-8000-000000000004";
const contentVersionId = "10000000-0000-4000-8000-000000000005";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000006";
const now = "2026-08-04T04:00:00.000Z";
const body = "出发前核对官方开放时间。\n\n再根据预算选择适合自己的服务。";
const payload = {
  title: "云南暑期旅行怎么安排",
  summary: "从行程、预算和服务三个维度整理选择思路。",
  bodyMarkdown: body,
  tags: ["云南旅行"],
  media: [],
  claims: [],
  contactIds: [],
};
const draft = renderBrowserAssistedDraft({
  platform: "toutiao",
  tenantId,
  channelAccountId,
  variantId,
  executionLevel: "assisted",
  payload,
});

function preparedState(expectedMediaCount = 0): PlatformPreparedSurfaceState {
  return {
    status: "ready",
    platform: "toutiao",
    adapterVersion: TOUTIAO_PUBLICATION_DEFINITION.adapterVersion,
    targetPageCount: 1,
    titleEditorCount: 1,
    bodyEditorCount: 1,
    primaryActionCount: 1,
    expectedMediaCount,
    titleText: payload.title,
    bodyText: body,
    challengeSignals: [],
  };
}

function publication(): PlaywrightPlatformPublicationAdapter {
  return {
    definition: TOUTIAO_PUBLICATION_DEFINITION,
    writeDraft: vi.fn(async (input) => preparedState(input.mediaCount ?? 0)),
    inspectPrepared: vi.fn(async (input) => preparedState(input?.mediaCount ?? 0)),
    submitOnce: vi.fn(async () => ({
      outcome: "accepted" as const,
      signal: "已提交审核",
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: "https://www.toutiao.com/article/1234567890123456789/",
    })),
    readback: vi.fn(async () => ({
      outcome: "confirmed" as const,
      candidateExternalId: "1234567890123456789",
      candidateExternalUrl: "https://www.toutiao.com/article/1234567890123456789/",
      externalId: "1234567890123456789",
      externalUrl: "https://www.toutiao.com/article/1234567890123456789/",
      observedAccountName: "云南旅行运营号",
      observedTitle: payload.title,
      observedBody: body,
      signal: "independent-public-payload-matched",
    })),
  };
}

function handoff(): CtripBridgeHandoffDraft {
  return {
    id: handoffId,
    tenantId,
    channelAccountId,
    variantId,
    contentVersionId,
    platform: "toutiao",
    executionLevel: "assisted",
    state: "handoff_pending",
    previewHash: draft.previewHash,
    payloadHash: "a".repeat(64),
    adapterVersion: TOUTIAO_PUBLICATION_DEFINITION.adapterVersion,
    bridgePrincipalId,
    externalDraftId: null,
    submitOutcome: null,
    submitEvidenceHash: null,
    submitEvidenceKind: null,
    submitObservedAt: null,
    submitCandidateExternalId: "1234567890123456789",
    submitCandidateExternalUrl: "https://www.toutiao.com/article/1234567890123456789/",
    submitPermitConsumedAt: null,
    payload,
  };
}

function coverMedia(): {
  readonly draftWithMedia: typeof draft;
  readonly attachment: CtripTrustedMediaAttachment;
} {
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const reference = {
    id: "10000000-0000-4000-8000-000000000007",
    platform: "toutiao",
    role: "cover",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mimeType: "image/png",
    altText: "云南旅行封面",
    caption: "云南旅行封面",
  } as unknown as MediaReference;
  return {
    draftWithMedia: {
      ...draft,
      payload: { ...draft.payload, media: [reference] },
    },
    attachment: { position: 0, reference, bytes },
  };
}

function baijiahaoCoverMedia(): {
  readonly baijiahaoHandoff: CtripBridgeHandoffDraft;
  readonly baijiahaoDraft: typeof draft;
  readonly attachment: CtripTrustedMediaAttachment;
} {
  const { draftWithMedia, attachment } = coverMedia();
  const baijiahaoAttachment = {
    ...attachment,
    reference: { ...attachment.reference, platform: "baijiahao" } as MediaReference,
  };
  return {
    baijiahaoHandoff: {
      ...handoff(),
      platform: "baijiahao",
      adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
    },
    baijiahaoDraft: {
      ...draftWithMedia,
      platform: "baijiahao",
      payload: { ...draftWithMedia.payload, media: [baijiahaoAttachment.reference] },
    },
    attachment: baijiahaoAttachment,
  };
}

function mediaWriter(): PriorityPlatformMediaWriter {
  return {
    platform: "toutiao",
    write: vi.fn(async () => ({
      status: "ready" as const,
      platform: "toutiao" as const,
      coverImageCount: 1,
      inlineImageCount: 0,
      challengeSignals: [],
    })),
    inspect: vi.fn(async () => ({
      status: "ready" as const,
      platform: "toutiao" as const,
      coverImageCount: 1,
      inlineImageCount: 0,
      challengeSignals: [],
    })),
  };
}

function baijiahaoMediaWriter(
  write: PriorityPlatformMediaWriter["write"] = vi.fn(async () => ({
    status: "ready" as const,
    platform: "baijiahao" as const,
    coverImageCount: 1,
    inlineImageCount: 0,
    challengeSignals: [],
  })),
): PriorityPlatformMediaWriter {
  return {
    platform: "baijiahao",
    write,
    inspect: vi.fn(async () => ({
      status: "ready" as const,
      platform: "baijiahao" as const,
      coverImageCount: 1,
      inlineImageCount: 0,
      challengeSignals: [],
    })),
  };
}

describe("priority platform fixed browser adapter", () => {
  it("binds one sourced cover and rechecks its DOM preview before submit", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      mediaManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(adapter.verifySubmit(handoff(), draftWithMedia)).resolves.toBeUndefined();

    expect(writer.write).toHaveBeenCalledWith([attachment]);
    expect(writer.inspect).toHaveBeenCalledWith([attachment.reference]);
  });

  it("fails preparation when media interaction rebuilds the editor and drops audited body text", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    vi.mocked(sourced.inspectPrepared).mockResolvedValue({
      ...preparedState(1),
      bodyText: "",
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "post-media:body-mismatch",
    });
  });

  it("fails closed when loaded media bytes no longer match the audited SHA", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.prepare(handoff(), draftWithMedia, [
        { ...attachment, bytes: Uint8Array.from([137, 80, 78, 70]) },
      ]),
    ).resolves.toMatchObject({
      outcome: "payload_invalid",
      diagnosticCode: "audited-media-mismatch",
    });
    expect(sourced.writeDraft).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("changes the media manifest hash when audited reference metadata changes", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    const changedReference = {
      ...attachment.reference,
      altText: "云南旅行路线封面",
    } as MediaReference;
    const changedDraft = {
      ...draftWithMedia,
      payload: { ...draftWithMedia.payload, media: [changedReference] },
    };
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    const original = await adapter.prepare(handoff(), draftWithMedia, [attachment]);
    const changed = await adapter.prepare(handoff(), changedDraft, [
      { ...attachment, reference: changedReference },
    ]);
    if (!("mediaManifestHash" in original) || !("mediaManifestHash" in changed)) {
      throw new Error("Expected both audited media preparations to succeed");
    }
    expect(changed.mediaManifestHash).not.toBe(original.mediaManifestHash);
  });

  it("rejects submit verification when the prepared media DOM count drifts", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });
    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      mediaManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    vi.mocked(writer.inspect).mockResolvedValue({
      status: "adapter_drift",
      platform: "toutiao",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: [],
    });

    await expect(adapter.verifySubmit(handoff(), draftWithMedia)).rejects.toMatchObject({
      observation: { diagnosticCode: "submit:media-mismatch" },
    });
  });

  it("repairs a Baijiahao draft when the body iframe rebuilds before submit", async () => {
    const sourced = {
      ...publication(),
      definition: BAIJIAHAO_PUBLICATION_DEFINITION,
    } as PlaywrightPlatformPublicationAdapter;
    const writer = baijiahaoMediaWriter();
    const { baijiahaoHandoff, baijiahaoDraft, attachment } = baijiahaoCoverMedia();
    const baijiahaoReady = {
      ...preparedState(1),
      platform: "baijiahao" as const,
      adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
    };
    vi.mocked(sourced.writeDraft).mockResolvedValue(baijiahaoReady);
    vi.mocked(sourced.inspectPrepared)
      .mockResolvedValueOnce({
        ...baijiahaoReady,
        status: "adapter_drift",
        bodyEditorCount: 0,
        bodyText: "",
      })
      .mockResolvedValueOnce({ ...baijiahaoReady, bodyText: "" })
      .mockResolvedValueOnce(baijiahaoReady)
      .mockResolvedValueOnce(baijiahaoReady);
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "baijiahao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "百家号运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.verifySubmit(baijiahaoHandoff, baijiahaoDraft, async () => [attachment]),
    ).resolves.toBeUndefined();

    expect(sourced.writeDraft).toHaveBeenCalledOnce();
    expect(sourced.writeDraft).toHaveBeenCalledWith({
      title: payload.title,
      body,
      mediaCount: 1,
    });
    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledWith([attachment]);
    expect(sourced.inspectPrepared).toHaveBeenCalledTimes(4);
  });

  it("does not repair a Baijiahao editor that contains another task title", async () => {
    const sourced = {
      ...publication(),
      definition: BAIJIAHAO_PUBLICATION_DEFINITION,
    } as PlaywrightPlatformPublicationAdapter;
    const writer = baijiahaoMediaWriter();
    const { baijiahaoHandoff, baijiahaoDraft, attachment } = baijiahaoCoverMedia();
    const baijiahaoReady = {
      ...preparedState(1),
      platform: "baijiahao" as const,
      adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
    };
    vi.mocked(sourced.inspectPrepared)
      .mockResolvedValueOnce({
        ...baijiahaoReady,
        status: "adapter_drift",
        bodyEditorCount: 0,
        bodyText: "",
      })
      .mockResolvedValueOnce({
        ...baijiahaoReady,
        titleText: "另一个任务标题",
        bodyText: "另一个任务正文",
      });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "baijiahao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "百家号运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.verifySubmit(baijiahaoHandoff, baijiahaoDraft, async () => [attachment]),
    ).rejects.toMatchObject({
      observation: { diagnosticCode: "submit:status-adapter-drift" },
    });
    expect(sourced.writeDraft).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("returns bounded evidence when the prepared draft belongs to another payload", async () => {
    const sourced = publication();
    vi.mocked(sourced.inspectPrepared).mockResolvedValue({
      ...preparedState(),
      titleText: "另一个已准备标题",
      bodyText: "另一个已准备正文",
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    const captured = await adapter.verifySubmit(handoff(), draft).catch((error: unknown) => error);

    expect(captured).toBeInstanceOf(CtripPreparedDraftConflictError);
    expect(captured).toMatchObject({
      observation: {
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        observedAt: now,
        evidenceKind: "browser",
        diagnosticCode: "submit:title-mismatch",
      },
    });
  });

  it.each([
    {
      name: "a missing runtime",
      state: { status: "session_required" as const },
      diagnosticCode: "submit:session-required",
    },
    {
      name: "a visible security challenge",
      state: { status: "challenge_required" as const },
      diagnosticCode: "submit:challenge-required",
    },
    {
      name: "a changed editor surface",
      state: { status: "adapter_drift" as const, targetPageCount: 2 },
      diagnosticCode: "submit:status-adapter-drift",
    },
    {
      name: "a changed title",
      state: { titleText: "新的标题" },
      diagnosticCode: "submit:title-mismatch",
    },
    {
      name: "a changed body",
      state: { bodyText: "新的正文" },
      diagnosticCode: "submit:body-mismatch",
    },
    {
      name: "a changed media count",
      state: { expectedMediaCount: 1 },
      diagnosticCode: "submit:media-mismatch",
    },
  ])("classifies $name before submit", async ({ state, diagnosticCode }) => {
    const sourced = publication();
    vi.mocked(sourced.inspectPrepared).mockResolvedValue({
      ...preparedState(),
      ...state,
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    const captured = await adapter.verifySubmit(handoff(), draft).catch((error: unknown) => error);

    expect(captured).toBeInstanceOf(CtripPreparedDraftConflictError);
    expect(captured).toMatchObject({ observation: { diagnosticCode } });
  });

  it("binds sourced draft, one-time submit and independent account-aware readback", async () => {
    const sourced = publication();
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      externalDraftId: `toutiao-editor-${handoffId}`,
      observedAt: now,
      evidenceKind: "browser",
    });
    await expect(adapter.verifySubmit(handoff(), draft)).resolves.toBeUndefined();
    await expect(adapter.submit(handoff(), draft)).resolves.toMatchObject({
      outcome: "accepted",
      candidateExternalId: "1234567890123456789",
      evidenceKind: "browser",
    });
    await expect(adapter.readback(handoff(), draft)).resolves.toMatchObject({
      outcome: "confirmed",
      externalId: "1234567890123456789",
      recoveredCandidateExternalId: "1234567890123456789",
      recoveredCandidateExternalUrl: "https://www.toutiao.com/article/1234567890123456789/",
      evidenceKind: "platform_readback",
    });

    expect(sourced.writeDraft).toHaveBeenCalledWith({
      title: payload.title,
      body,
      mediaCount: 0,
    });
    expect(sourced.submitOnce).toHaveBeenCalledTimes(1);
    expect(sourced.readback).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountName: "云南旅行运营号" }),
    );
  });

  it("accepts sanitized keyword coverage in both prepare and submit readback gates", async () => {
    const noisyState = {
      ...preparedState(),
      titleText: `<span>${payload.title}</span>&nbsp;\u200b`,
      bodyText: `<p>${body}</p><div data-editor-widget="true">编辑搜图</div>`,
    };
    const sourced = publication();
    vi.mocked(sourced.writeDraft).mockResolvedValue(noisyState);
    vi.mocked(sourced.inspectPrepared).mockResolvedValue(noisyState);
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      externalDraftId: `toutiao-editor-${handoffId}`,
      evidenceKind: "browser",
    });
    await expect(adapter.verifySubmit(handoff(), draft)).resolves.toBeUndefined();
  });

  it("binds a confirmed platform-normalized readback to the audited expected content hash", async () => {
    const sourced = publication();
    vi.mocked(sourced.readback).mockResolvedValue({
      outcome: "confirmed",
      candidateExternalId: "DEMO000000000005",
      candidateExternalUrl: "https://www.163.com/dy/article/DEMO000000000005.html",
      externalId: "DEMO000000000005",
      externalUrl: "https://www.163.com/dy/article/DEMO000000000005.html",
      observedAccountName: "人间饭香",
      observedTitle: payload.title,
      observedBody: body.replace(/\s+/gu, ""),
      signal: "independent-public-payload-matched",
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "人间饭香",
      now: () => new Date(now),
    });

    await expect(adapter.readback(handoff(), draft)).resolves.toMatchObject({
      outcome: "confirmed",
      observedPayloadHash: ctripPublicContentHash(payload.title, body),
    });
  });

  it("propagates a creator-management publisher rejection with its reason code", async () => {
    const sourced = publication();
    vi.mocked(sourced.readback).mockResolvedValue({
      outcome: "publisher_rejected",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      externalId: null,
      externalUrl: null,
      observedAccountName: "云南旅行运营号",
      observedTitle: payload.title,
      observedBody: "",
      signal: "creator-management-rejected-soft-advertorial",
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.readback(handoff(), draft)).resolves.toMatchObject({
      outcome: "publisher_rejected",
      evidenceKind: "creator_management",
      publisherReasonCode: "publisher.rejected.soft_advertorial",
      externalId: null,
      externalUrl: null,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("fails closed when audited media has no GitHub-sourced platform writer", async () => {
    const sourced = publication();
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.prepare(handoff(), draft, [{} as CtripTrustedMediaAttachment]),
    ).resolves.toMatchObject({
      outcome: "payload_invalid",
      diagnosticCode: "sourced-media-writer-required",
    });
    expect(sourced.writeDraft).not.toHaveBeenCalled();
  });

  it("requires at least one audited image for Sohu publication", async () => {
    const sohuDraft = renderBrowserAssistedDraft({
      platform: "sohu",
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "assisted",
      payload,
    });
    const sourced = {
      ...publication(),
      definition: SOHU_PUBLICATION_DEFINITION,
    } as PlaywrightPlatformPublicationAdapter;
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "sohu",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.prepare(
        {
          ...handoff(),
          platform: "sohu",
          adapterVersion: SOHU_PUBLICATION_DEFINITION.adapterVersion,
          previewHash: sohuDraft.previewHash,
        },
        sohuDraft,
        [],
      ),
    ).resolves.toMatchObject({
      outcome: "payload_invalid",
      diagnosticCode: "audited-image-required",
    });
    expect(sourced.writeDraft).not.toHaveBeenCalled();
  });

  it("refuses an already-prepared zero-image Sohu handoff at the final submit boundary", async () => {
    const sohuDraft = renderBrowserAssistedDraft({
      platform: "sohu",
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "assisted",
      payload,
    });
    const sourced = {
      ...publication(),
      definition: SOHU_PUBLICATION_DEFINITION,
      inspectPrepared: vi.fn(async () => ({
        ...preparedState(),
        platform: "sohu" as const,
        adapterVersion: SOHU_PUBLICATION_DEFINITION.adapterVersion,
      })),
    } as PlaywrightPlatformPublicationAdapter;
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "sohu",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(
      adapter.verifySubmit(
        {
          ...handoff(),
          platform: "sohu",
          adapterVersion: SOHU_PUBLICATION_DEFINITION.adapterVersion,
          previewHash: sohuDraft.previewHash,
        },
        sohuDraft,
      ),
    ).rejects.toMatchObject({
      observation: { diagnosticCode: "submit:audited-image-required" },
    });
    expect(sourced.submitOnce).not.toHaveBeenCalled();
  });

  it("refuses final submit while a visible security challenge remains", async () => {
    const sourced = publication();
    vi.mocked(sourced.inspectPrepared).mockResolvedValue({
      ...preparedState(),
      status: "challenge_required",
      challengeSignals: ["iframe[src*='captcha']"],
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.verifySubmit(handoff(), draft)).rejects.toBeInstanceOf(
      CtripPreparedDraftConflictError,
    );
    expect(sourced.submitOnce).not.toHaveBeenCalled();
  });

  it("reports a closed browser runtime as session required instead of adapter drift", async () => {
    const sourced = publication();
    vi.mocked(sourced.writeDraft).mockRejectedValue(
      new Error("browserContext.newPage: Target page, context or browser has been closed"),
    );
    vi.mocked(sourced.inspectPrepared).mockRejectedValue(
      new Error("browserContext.pages: Target page, context or browser has been closed"),
    );
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      outcome: "session_required",
      diagnosticCode: "draft-write-runtime-unavailable",
    });
  });

  it("reports the session-provider CDP timeout as session required instead of adapter drift", async () => {
    const sourced = publication();
    vi.mocked(sourced.writeDraft).mockRejectedValue(
      new Error("Ctrip account CDP operation did not respond within 600000ms"),
    );
    vi.mocked(sourced.inspectPrepared).mockRejectedValue(
      new Error("Ctrip account CDP operation did not respond within 600000ms"),
    );
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      outcome: "session_required",
      diagnosticCode: "draft-write-runtime-unavailable",
    });
  });

  it("reports a closed media-writer runtime as session required instead of adapter drift", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    vi.mocked(writer.write).mockRejectedValue(
      new Error("page.waitForTimeout: Target page, context or browser has been closed"),
    );
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      outcome: "session_required",
      diagnosticCode: "media-write-runtime-unavailable",
    });
  });

  it("persists the exact safe media-writer stage instead of collapsing every failure", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    vi.mocked(writer.write).mockRejectedValue(
      new PriorityPlatformMediaWriteError("toutiao", "cover-trigger-click"),
    );
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "media-write-cover-trigger-click",
    });
  });

  it("reclassifies a media action failure when a challenge appeared during the write", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    vi.mocked(writer.write).mockRejectedValue(
      new PriorityPlatformMediaWriteError("toutiao", "cover-trigger-click"),
    );
    vi.mocked(writer.inspect).mockResolvedValue({
      status: "challenge_required",
      platform: "toutiao",
      coverImageCount: 0,
      inlineImageCount: 0,
      challengeSignals: ["frame:security-challenge"],
    });
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      mediaWriter: writer,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      outcome: "challenge_required",
      diagnosticCode: "media-write-challenge-required",
    });
  });

  it("classifies an editor challenge from the write error even when inspection fails", async () => {
    const sourced = publication();
    vi.mocked(sourced.writeDraft).mockRejectedValue(
      new Error("sohu editor requires an interactive security challenge"),
    );
    vi.mocked(sourced.inspectPrepared).mockRejectedValue(new Error("frame was detached"));
    const adapter = new PriorityPlatformBrowserAdapter({
      platform: "toutiao",
      publication: sourced,
      expectedAccountName: "云南旅行运营号",
      now: () => new Date(now),
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      outcome: "challenge_required",
      diagnosticCode: "draft-write-challenge-required",
    });
  });

  it("destroys a closed account runtime so the next preparation reconnects", async () => {
    const sourced = publication();
    vi.mocked(sourced.writeDraft).mockRejectedValue(
      new Error("browserContext.newPage: Target page, context or browser has been closed"),
    );
    vi.mocked(sourced.inspectPrepared).mockRejectedValue(
      new Error("browserContext.pages: Target page, context or browser has been closed"),
    );
    const session = {
      platform: "toutiao",
      expectedAccountName: "云南旅行运营号",
      platformPublicationAdapter: sourced,
      platformMediaWriter: null,
    } as unknown as CtripBrowserReviewSession;
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation) => operation(session),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      outcome: "session_required",
      diagnosticCode: "draft-write-runtime-unavailable",
    });
    expect(destroySession).toHaveBeenCalledWith(channelAccountId);
  });

  it("retries one prepare and returns runtime-unavailable when Browser Host admission stays paused", async () => {
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async () => {
        throw new Error("Ctrip browser runtime unavailable: browser host admission is paused");
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      outcome: "session_required",
      diagnosticCode: "draft-write-runtime-unavailable",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledTimes(2);
  });

  it("reconnects once and completes a Baijiahao draft after the runtime closes", async () => {
    const closedPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      definition: BAIJIAHAO_PUBLICATION_DEFINITION,
      writeDraft: vi.fn(async () =>
        Promise.reject(
          new Error("browserContext.newPage: Target page, context or browser has been closed"),
        ),
      ),
      inspectPrepared: vi.fn(async () =>
        Promise.reject(
          new Error("browserContext.pages: Target page, context or browser has been closed"),
        ),
      ),
    };
    const recoveredPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      definition: BAIJIAHAO_PUBLICATION_DEFINITION,
      writeDraft: vi.fn(async (input) => ({
        ...preparedState(input.mediaCount ?? 0),
        platform: "baijiahao" as const,
        adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
      })),
      inspectPrepared: vi.fn(async (input) => ({
        ...preparedState(input?.mediaCount ?? 0),
        platform: "baijiahao" as const,
        adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
      })),
    };
    const sessionsByAttempt = [closedPublication, recoveredPublication];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = sessionsByAttempt.shift();
        if (next === undefined) throw new Error("unexpected browser reconnect");
        return operation({
          platform: "baijiahao",
          expectedAccountName: "百家号运营号",
          platformPublicationAdapter: next,
          platformMediaWriter: null,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });
    const baijiahaoHandoff = {
      ...handoff(),
      platform: "baijiahao" as const,
      adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
    };
    const baijiahaoDraft = { ...draft, platform: "baijiahao" as const };

    await expect(adapter.prepare(baijiahaoHandoff, baijiahaoDraft, [])).resolves.toMatchObject({
      externalDraftId: `baijiahao-editor-${handoffId}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("reconnects once and completes a Toutiao draft after the runtime closes", async () => {
    const closedPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      writeDraft: vi.fn(async () =>
        Promise.reject(
          new Error("browserContext.newPage: Target page, context or browser has been closed"),
        ),
      ),
      inspectPrepared: vi.fn(async () =>
        Promise.reject(
          new Error("browserContext.pages: Target page, context or browser has been closed"),
        ),
      ),
    };
    const recoveredPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      writeDraft: vi.fn(async (input) => preparedState(input.mediaCount ?? 0)),
      inspectPrepared: vi.fn(async (input) => preparedState(input?.mediaCount ?? 0)),
    };
    const sessionsByAttempt = [closedPublication, recoveredPublication];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = sessionsByAttempt.shift();
        if (next === undefined) throw new Error("unexpected browser reconnect");
        return operation({
          platform: "toutiao",
          expectedAccountName: "头条运营号",
          platformPublicationAdapter: next,
          platformMediaWriter: null,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      externalDraftId: `toutiao-editor-${handoffId}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("reconnects once after a transient Toutiao prepared-payload readback drift", async () => {
    const driftedPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      writeDraft: vi.fn(async (input) => ({
        ...preparedState(input.mediaCount ?? 0),
        bodyText: "编辑器尚未完成正文回填",
      })),
    };
    const recoveredPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      writeDraft: vi.fn(async (input) => preparedState(input.mediaCount ?? 0)),
    };
    const sessionsByAttempt = [driftedPublication, recoveredPublication];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = sessionsByAttempt.shift();
        if (next === undefined) throw new Error("unexpected browser reconnect");
        return operation({
          platform: "toutiao",
          expectedAccountName: "头条运营号",
          platformPublicationAdapter: next,
          platformMediaWriter: null,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(adapter.prepare(handoff(), draft, [])).resolves.toMatchObject({
      externalDraftId: `toutiao-editor-${handoffId}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("reconnects once when the Baijiahao media writer loses its browser runtime", async () => {
    const { draftWithMedia, attachment } = coverMedia();
    const baijiahaoAttachment = {
      ...attachment,
      reference: { ...attachment.reference, platform: "baijiahao" } as MediaReference,
    };
    const baijiahaoDraft = {
      ...draftWithMedia,
      platform: "baijiahao" as const,
      payload: { ...draftWithMedia.payload, media: [baijiahaoAttachment.reference] },
    };
    const baijiahaoHandoff = {
      ...handoff(),
      platform: "baijiahao" as const,
      adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
    };
    const closedPublication: PlaywrightPlatformPublicationAdapter = {
      ...publication(),
      definition: BAIJIAHAO_PUBLICATION_DEFINITION,
      writeDraft: vi.fn(async (input) => ({
        ...preparedState(input.mediaCount ?? 0),
        platform: "baijiahao" as const,
        adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
      })),
    };
    const recoveredPublication: PlaywrightPlatformPublicationAdapter = {
      ...closedPublication,
      inspectPrepared: vi.fn(async (input) => ({
        ...preparedState(input?.mediaCount ?? 0),
        platform: "baijiahao" as const,
        adapterVersion: BAIJIAHAO_PUBLICATION_DEFINITION.adapterVersion,
      })),
    };
    const sessionsByAttempt = [
      {
        publication: closedPublication,
        mediaWriter: baijiahaoMediaWriter(async () =>
          Promise.reject(
            new Error("page.waitForTimeout: Target page, context or browser has been closed"),
          ),
        ),
      },
      { publication: recoveredPublication, mediaWriter: baijiahaoMediaWriter() },
    ];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = sessionsByAttempt.shift();
        if (next === undefined) throw new Error("unexpected browser reconnect");
        return operation({
          platform: "baijiahao",
          expectedAccountName: "百家号运营号",
          platformPublicationAdapter: next.publication,
          platformMediaWriter: next.mediaWriter,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(
      adapter.prepare(baijiahaoHandoff, baijiahaoDraft, [baijiahaoAttachment]),
    ).resolves.toMatchObject({
      externalDraftId: `baijiahao-editor-${handoffId}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("passes the account session media writer into priority-platform preparation", async () => {
    const sourced = publication();
    const writer = mediaWriter();
    const { draftWithMedia, attachment } = coverMedia();
    const session = {
      platform: "toutiao",
      expectedAccountName: "云南旅行运营号",
      platformPublicationAdapter: sourced,
      platformMediaWriter: writer,
    } as unknown as CtripBrowserReviewSession;
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: async (_channelAccountId, operation) => operation(session),
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_supervised",
      sessions,
    });

    await expect(adapter.prepare(handoff(), draftWithMedia, [attachment])).resolves.toMatchObject({
      mediaManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(writer.write).toHaveBeenCalledWith([attachment]);
  });
});
