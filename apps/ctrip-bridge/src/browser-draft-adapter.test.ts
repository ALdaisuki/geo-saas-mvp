import { createHash } from "node:crypto";

import type { RenderedDraft } from "@geo/connectors";
import type { MediaReference } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import { CtripAccountScopedAdapter } from "./account-scoped-adapter.js";
import type { CtripAccountBrowserSessionProvider } from "./account-browser-session-provider.js";
import {
  CtripCommunityBrowserDraftAdapter,
  CTRIP_BROWSER_DRAFT_ADAPTER_VERSION,
  renderCtripDraftPlainText,
  type CtripDraftWriter,
} from "./browser-draft-adapter.js";
import type { CtripBrowserReviewSession } from "./browser-review-session.js";
import type { CtripBridgeHandoffDraft, CtripTrustedMediaAttachment } from "./types.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  handoff: "10000000-0000-4000-8000-000000000002",
  principal: "10000000-0000-4000-8000-000000000003",
};
const title = "上海亲子周末攻略";
const markdown = [
  "## 行前确认",
  "",
  "第一段包含 **重点信息** 和 [官方页面](https://example.com/guide)，所有价格与开放时间以出发前核验为准。",
  "",
  "- 核对证件与预订信息",
  "- 联系旅行社确认最终行程",
].join("\n");

function draft(
  overrides: {
    readonly title?: string;
    readonly bodyMarkdown?: string;
    readonly locationQuery?: string;
  } = {},
) {
  return {
    payload: {
      title: overrides.title ?? title,
      bodyMarkdown: overrides.bodyMarkdown ?? markdown,
      locationQuery: overrides.locationQuery ?? "Tokyo",
    },
  } as unknown as RenderedDraft;
}

function handoff(): CtripBridgeHandoffDraft {
  return {
    id: ids.handoff,
    tenantId: ids.tenant,
    bridgePrincipalId: ids.principal,
  } as unknown as CtripBridgeHandoffDraft;
}

function media(position: number): CtripTrustedMediaAttachment {
  const bytes = Uint8Array.from([position + 1, position + 2]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    position,
    bytes,
    reference: {
      id: `10000000-0000-4000-8000-${String(position + 10).padStart(12, "0")}`,
      sha256,
      mimeType: "image/png",
      byteLength: 2,
      role: position === 0 ? "cover" : "inline",
      inspection: {
        labels: [`scene-signature:scene_${position}:outdoor:wide`],
      },
    } as unknown as MediaReference,
  };
}

function mediaSet(count = 5): CtripTrustedMediaAttachment[] {
  return Array.from({ length: count }, (_, index) => media(index));
}

function writer(
  options: {
    readonly status?: "ready" | "session_required" | "challenge_required" | "adapter_drift";
    readonly saveConfirmed?: boolean;
    readonly saveSignal?: string;
    readonly clearRemaining?: number;
    readonly locationReadback?: string;
    readonly persistedLocation?: string;
  } = {},
) {
  const operations: string[] = [];
  let imageCount = 0;
  let selectedLocation = "";
  const value: CtripDraftWriter = {
    inspect: vi.fn(async () => ({
      status: options.status ?? "ready",
      targetPageCount: options.status === "session_required" ? 0 : 1,
      titleEditorCount: 1,
      bodyEditorCount: 1,
      imageInputCount: 1,
      uploadActionCount: 1,
      draftActionCount: 1,
      publishActionCount: 1,
      challengeSignals: [],
    })),
    fillTitle: vi.fn(async (text) => {
      operations.push(`title:${text}`);
      return text;
    }),
    fillBody: vi.fn(async (text) => {
      operations.push(`body:${text}`);
      return text;
    }),
    fillLocation: vi.fn(async (query) => {
      operations.push(`location:${query}`);
      selectedLocation = options.locationReadback ?? `${query}, Japan`;
      return selectedLocation;
    }),
    readLocation: vi.fn(async () => {
      operations.push("read-location");
      return options.persistedLocation ?? selectedLocation;
    }),
    clearImages: vi.fn(async () => {
      operations.push("clear-images");
      imageCount = 0;
      return options.clearRemaining ?? 0;
    }),
    uploadImage: vi.fn(async (file) => {
      operations.push(`image:${file.name}:${file.mimeType}`);
      imageCount += 1;
      return imageCount;
    }),
    countImages: vi.fn(async () => {
      operations.push("count-images");
      return imageCount;
    }),
    saveDraft: vi.fn(async () => {
      operations.push("save-draft");
      return {
        confirmed: options.saveConfirmed ?? true,
        signal:
          options.saveSignal ??
          (options.saveConfirmed === false ? "unavailable" : "draft-action-complete"),
      };
    }),
  };
  return { value, operations };
}

describe("Ctrip browser draft adapter", () => {
  it("renders Markdown structurally to bounded readable plain text", () => {
    const text = renderCtripDraftPlainText(markdown);
    expect(text).toContain("行前确认");
    expect(text).toContain("重点信息");
    expect(text).toContain("官方页面 (https://example.com/guide)");
    expect(text).toContain("- 核对证件与预订信息");
    expect(text).not.toMatch(/\*\*|^## |\]\(/mu);
  });

  it("fills the audited fields, uploads each image in order, and saves one draft", async () => {
    const port = writer();
    const adapter = new CtripCommunityBrowserDraftAdapter({
      writer: port.value,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      observedAt: "2026-07-17T12:00:00.000Z",
      evidenceKind: "browser",
      sessionEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      draftEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      mediaManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(adapter.version).toBe(CTRIP_BROWSER_DRAFT_ADAPTER_VERSION);
    expect(adapter.commandCapabilities).toEqual({
      prepare: true,
      submit: false,
      readback: false,
    });
    expect(port.operations[0]).toBe("clear-images");
    expect(port.operations[1]).toBe(`title:${title}`);
    expect(port.operations[2]).toContain("body:行前确认");
    expect(port.operations.slice(3)).toEqual([
      "location:Tokyo",
      "image:geo-ctrip-01.png:image/png",
      "image:geo-ctrip-02.png:image/png",
      "image:geo-ctrip-03.png:image/png",
      "image:geo-ctrip-04.png:image/png",
      "image:geo-ctrip-05.png:image/png",
      "save-draft",
      "read-location",
      "count-images",
    ]);
  });

  it("accepts different image bytes that reuse a scene signature", async () => {
    const attachments = mediaSet(4).map((attachment) => ({
      ...attachment,
      reference: {
        ...attachment.reference,
        inspection: {
          ...attachment.reference.inspection,
          labels: ["scene-signature:urban_street:outdoor:wide"],
        },
      },
    }));
    const port = writer();
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), attachments)).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(port.operations.filter((operation) => operation.startsWith("image:"))).toHaveLength(4);
  });

  it.each([
    ["session_required", "session_required"],
    ["adapter_drift", "adapter_drift"],
  ] as const)("returns durable %s evidence without mutating the page", async (status, outcome) => {
    const port = writer({ status });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });
    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome,
      diagnosticCode: `surface-${outcome}`,
      evidenceKind: "browser",
    });
    expect(port.operations).toEqual([]);
  });

  it("continues draft writing when a platform challenge is present but controls are ready", async () => {
    const port = writer({ status: "challenge_required" });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(port.operations).toContain(`title:${title}`);
    expect(
      port.operations.some(
        (operation) => operation.startsWith("body:") && operation.includes("行前确认"),
      ),
    ).toBe(true);
    expect(port.operations).toContain("save-draft");
  });

  it("waits for a single Ctrip editor page to hydrate before declaring adapter drift", async () => {
    const port = writer();
    let hydrated = false;
    const inspect = vi.fn(async () => ({
      status: hydrated ? ("ready" as const) : ("adapter_drift" as const),
      targetPageCount: 1,
      titleEditorCount: hydrated ? 1 : 0,
      bodyEditorCount: hydrated ? 1 : 0,
      imageInputCount: hydrated ? 1 : 0,
      uploadActionCount: hydrated ? 1 : 0,
      draftActionCount: hydrated ? 1 : 0,
      publishActionCount: hydrated ? 1 : 0,
      challengeSignals: [],
    }));
    const ensureTargetPage = vi.fn(async () => {
      hydrated = true;
      return true;
    });
    const adapter = new CtripCommunityBrowserDraftAdapter({
      writer: { ...port.value, inspect, ensureTargetPage },
    });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(ensureTargetPage).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("fails closed for invalid Ctrip limits or an ambiguous draft save", async () => {
    for (const input of [
      { rendered: draft({ title: "太短" }), attachments: mediaSet() },
      { rendered: draft({ bodyMarkdown: "不足六十字" }), attachments: mediaSet() },
      { rendered: draft({ locationQuery: "" }), attachments: mediaSet() },
      { rendered: draft(), attachments: [] },
      { rendered: draft(), attachments: mediaSet(6) },
    ]) {
      const port = writer();
      const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });
      await expect(
        adapter.prepare(handoff(), input.rendered, input.attachments),
      ).resolves.toMatchObject({
        outcome: "payload_invalid",
        evidenceKind: "browser",
      });
      expect(port.value.inspect).toHaveBeenCalledOnce();
      expect(port.operations).toEqual([]);
    }

    const ambiguous = writer({ saveConfirmed: false });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: ambiguous.value });
    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "draft-save:unavailable",
    });
    expect(ambiguous.operations.at(-1)).toBe("save-draft");

    const blocked = writer({ clearRemaining: 1 });
    const blockedAdapter = new CtripCommunityBrowserDraftAdapter({ writer: blocked.value });
    await expect(blockedAdapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "media-clear-incomplete",
    });
    expect(blocked.operations).toEqual(["clear-images"]);
  });

  it("reports an account-mute draft-save rejection with a stable diagnostic code", async () => {
    const port = writer({
      saveConfirmed: false,
      saveSignal: "draft-save-account-muted",
    });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "draft-save:draft-save-account-muted",
    });
  });

  it("records the exact post-save recovery signal when draft reopening fails", async () => {
    const port = writer();
    port.value.resumeDraft = vi.fn(async () => ({
      confirmed: false,
      signal: "draft-detail-mismatch",
    }));
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "draft-resume:draft-detail-mismatch",
    });
  });

  it("fails closed when uploaded media is absent after the saved draft is reopened", async () => {
    const port = writer();
    port.value.countImages = vi.fn(async () => 0);
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "media-persistence-count",
    });
  });

  it("continues without an optional POI when the location control or match is unavailable", async () => {
    const missingWriter = writer();
    delete missingWriter.value.fillLocation;
    delete missingWriter.value.readLocation;
    const missingWriterAdapter = new CtripCommunityBrowserDraftAdapter({
      writer: missingWriter.value,
    });
    await expect(
      missingWriterAdapter.prepare(handoff(), draft(), mediaSet()),
    ).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(missingWriter.operations).toContain("save-draft");

    const noMatch = writer({ locationReadback: "" });
    const noMatchAdapter = new CtripCommunityBrowserDraftAdapter({ writer: noMatch.value });
    await expect(noMatchAdapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(noMatch.operations).toContain("save-draft");
    expect(noMatch.operations).not.toContain("read-location");
  });

  it("fails closed when the selected location is absent after reopening the saved draft", async () => {
    const port = writer({ persistedLocation: "" });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "location-persistence",
    });
    expect(port.operations).toContain("read-location");
  });

  it("accepts a saved POI label normalized by Ctrip when it still contains the audited query", async () => {
    const port = writer({
      locationReadback: "Tokyo, Japan",
      persistedLocation: "Tokyo",
    });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(adapter.prepare(handoff(), draft(), mediaSet())).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
  });

  it("accepts a reordered Ctrip POI label when it covers the audited location keywords", async () => {
    const port = writer({
      locationReadback: "厦门·福建",
      persistedLocation: "厦门·福建",
    });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(
      adapter.prepare(handoff(), draft({ locationQuery: "福建 厦门" }), mediaSet()),
    ).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
  });

  it("rejects a Ctrip POI label that covers only one of multiple audited location keywords", async () => {
    const port = writer({
      locationReadback: "福建省",
      persistedLocation: "福建省",
    });
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: port.value });

    await expect(
      adapter.prepare(handoff(), draft({ locationQuery: "福建 厦门" }), mediaSet()),
    ).resolves.toMatchObject({
      outcome: "adapter_drift",
      diagnosticCode: "location-readback",
    });
  });

  it("never supports submit or publication readback", async () => {
    const adapter = new CtripCommunityBrowserDraftAdapter({ writer: writer().value });
    await expect(adapter.submit()).rejects.toThrow(/cannot submit/iu);
    await expect(adapter.readback()).rejects.toThrow(/cannot read back/iu);
  });

  it("reconnects a stale Ctrip editor surface once before failing the handoff", async () => {
    const stale = writer({ status: "adapter_drift" });
    const recovered = writer();
    const writers = [stale.value, recovered.value];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = writers.shift();
        if (next === undefined) throw new Error("unexpected Ctrip browser reconnect");
        return operation({
          platform: "ctrip_community",
          draftWriter: next,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(
      adapter.prepare(
        {
          ...handoff(),
          channelAccountId: ids.handoff,
          platform: "ctrip_community",
        },
        draft(),
        mediaSet(),
      ),
    ).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });

  it("reconnects once when Ctrip title readback drifts before finalizing the draft", async () => {
    const stale = writer();
    vi.mocked(stale.value.fillTitle).mockImplementationOnce(async () => "标题写入漂移");
    const recovered = writer();
    const writers = [stale.value, recovered.value];
    const destroySession = vi.fn(async () => true);
    const sessions: CtripAccountBrowserSessionProvider = {
      withSession: vi.fn(async (_channelAccountId, operation) => {
        const next = writers.shift();
        if (next === undefined) throw new Error("unexpected Ctrip browser reconnect");
        return operation({
          platform: "ctrip_community",
          draftWriter: next,
        } as unknown as CtripBrowserReviewSession);
      }),
      destroySession,
    };
    const adapter = new CtripAccountScopedAdapter({
      mode: "browser_unattended",
      sessions,
    });

    await expect(
      adapter.prepare(
        {
          ...handoff(),
          channelAccountId: ids.handoff,
          platform: "ctrip_community",
        },
        draft(),
        mediaSet(),
      ),
    ).resolves.toMatchObject({
      externalDraftId: `ctrip-draft-${ids.handoff}`,
      evidenceKind: "browser",
    });
    expect(sessions.withSession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledOnce();
  });
});
