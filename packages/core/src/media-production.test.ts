import { describe, expect, it } from "vitest";

import type { EditorialProfile, MediaReference, Platform } from "@geo/contracts";

import type { VerifiedFact } from "./audit.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { buildVisualBrief, mediaSnapshotHash, verifyVisualBrief } from "./media-production.js";

const brandId = "00000000-0000-4000-8000-000000000010";

function fact(index: number, text: string, selectedBrandId = brandId): VerifiedFact {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    brandId: selectedBrandId,
    text,
    evidenceSourceIds: [`10000000-0000-4000-8000-${String(index).padStart(12, "0")}`],
    validFrom: "2026-07-15T00:00:00.000Z",
    validUntil: null,
  };
}

const facts = [
  fact(1, "提供经核验的出境旅游咨询服务"),
  fact(2, "服务方案以当前有效材料为准"),
] as const;

describe("visual brief production", () => {
  it("builds deterministic fact-ordered briefs with platform aspect ratios", () => {
    const expectedRatios = {
      toutiao: "16:9",
      sohu: "16:9",
      ctrip_community: "4:3",
    } as const;

    for (const platform of Object.keys(expectedRatios) as Platform[]) {
      const input = {
        editorialProfile: "guide" as const,
        platform,
        role: "cover" as const,
        facts,
      };
      const first = buildVisualBrief(input);
      const second = buildVisualBrief(input);

      expect(first).toEqual(second);
      expect(first.aspectRatio).toBe(expectedRatios[platform]);
      expect(first.factIds).toEqual(facts.map((item) => item.id));
      expect(first.prompt.indexOf(facts[0].text)).toBeLessThan(first.prompt.indexOf(facts[1].text));
    }
  });

  it("keeps contact facts bound while removing literal phone and WeChat tokens", () => {
    const contactFact = fact(3, "客服电话 400-113-3986，微信 ZTGL3411");
    const brief = buildVisualBrief({
      editorialProfile: "local_service",
      platform: "sohu",
      role: "inline",
      facts: [contactFact],
    });

    expect(brief.factIds).toEqual([contactFact.id]);
    for (const value of [brief.prompt, brief.altText, brief.caption]) {
      expect(value).not.toContain("400-113-3986");
      expect(value).not.toContain("ZTGL3411");
      expect(value).toContain("联系方式不在图片中呈现");
    }
    expect(brief.negativePrompt).toContain(
      "文字、水印、二维码、电话号码、微信号、价格、证件、夸张承诺、虚构人物背书",
    );
    expect(brief.prompt).toContain("不得虚构");
  });

  it("accepts one to three unique same-brand facts and rejects invalid inputs", () => {
    expect(() =>
      buildVisualBrief({
        editorialProfile: "guide",
        platform: "toutiao",
        role: "cover",
        facts: [],
      }),
    ).toThrow(/fact/iu);
    expect(() =>
      buildVisualBrief({
        editorialProfile: "guide",
        platform: "toutiao",
        role: "cover",
        facts: [facts[0], facts[0]],
      }),
    ).toThrow(/unique/iu);
    expect(() =>
      buildVisualBrief({
        editorialProfile: "guide",
        platform: "toutiao",
        role: "cover",
        facts: [facts[0], fact(3, "另一品牌事实", "00000000-0000-4000-8000-000000000099")],
      }),
    ).toThrow(/brand/iu);
    expect(() =>
      buildVisualBrief({
        editorialProfile: "guide",
        platform: "toutiao",
        role: "cover",
        facts: [fact(4, "   ")],
      }),
    ).toThrow(/text/iu);
  });

  it("clips by Unicode code point and deeply freezes the result", () => {
    const brief = buildVisualBrief({
      editorialProfile: "guide",
      platform: "ctrip_community",
      role: "inline",
      facts: [fact(5, `服务说明${"😀".repeat(700)}`)],
    });

    expect([...brief.altText]).toHaveLength(500);
    expect(brief.altText.isWellFormed()).toBe(true);
    expect([...brief.caption].length).toBeLessThanOrEqual(500);
    expect(brief.caption.isWellFormed()).toBe(true);
    expect(Object.isFrozen(brief)).toBe(true);
    expect(Object.isFrozen(brief.factIds)).toBe(true);
  });

  it("returns stable issue IDs for fact, metadata, and rendered-text changes", () => {
    const brief = buildVisualBrief({
      editorialProfile: "comparison",
      platform: "toutiao",
      role: "cover",
      facts,
    });

    expect(verifyVisualBrief({ brief, facts })).toEqual([]);
    expect(verifyVisualBrief({ brief, facts: [...facts].reverse() })).toContain(
      "visual_brief.fact_order_changed",
    );
    expect(
      verifyVisualBrief({
        brief: { ...brief, factIds: [facts[0].id] },
        facts,
      }),
    ).toContain("visual_brief.fact_missing");
    expect(
      verifyVisualBrief({
        brief: { ...brief, factIds: [...brief.factIds, fact(9, "未知事实").id] },
        facts,
      }),
    ).toContain("visual_brief.fact_unknown");

    const mutations = [
      [
        { ...brief, editorialProfile: "guide" as EditorialProfile },
        "visual_brief.editorial_profile_changed",
      ],
      [{ ...brief, platform: "sohu" as Platform }, "visual_brief.platform_changed"],
      [{ ...brief, role: "inline" as const }, "visual_brief.role_changed"],
      [{ ...brief, prompt: `${brief.prompt}篡改` }, "visual_brief.prompt_tampered"],
      [
        { ...brief, negativePrompt: `${brief.negativePrompt}篡改` },
        "visual_brief.negative_prompt_tampered",
      ],
      [{ ...brief, altText: `${brief.altText}篡改` }, "visual_brief.alt_text_tampered"],
      [{ ...brief, caption: `${brief.caption}篡改` }, "visual_brief.caption_tampered"],
    ] as const;

    for (const [mutated, issue] of mutations) {
      expect(verifyVisualBrief({ brief: mutated, facts })).toContain(issue);
    }
  });
});

function media(idSuffix: number, platform: Platform, role: "cover" | "inline"): MediaReference {
  const brief = buildVisualBrief({ editorialProfile: "guide", platform, role, facts: [facts[0]] });
  const assetSha256 = String(idSuffix).repeat(64).slice(0, 64);
  return {
    id: `20000000-0000-4000-8000-${String(idSuffix).padStart(12, "0")}`,
    sha256: assetSha256,
    mimeType: "image/png",
    byteLength: 128,
    width: 1600,
    height: 900,
    platform,
    role,
    altText: brief.altText,
    caption: brief.caption,
    factIds: [...brief.factIds],
    visualBrief: brief,
    visualBriefHash: sha256Canonical(brief),
    rights: {
      basis: "generated_terms",
      licenseName: "Fixture terms",
      licenseUrl: "https://example.com/terms",
      verifiedAt: "2026-07-15T12:00:00.000Z",
    },
    provenance: {
      kind: "generated",
      jobId: "30000000-0000-4000-8000-000000000001",
      attemptId: "30000000-0000-4000-8000-000000000002",
      provider: "fixture-provider",
      providerMode: "fixture",
      model: "fixture-v1",
      promptHash: sha256Text(brief.prompt),
      parametersHash: "f".repeat(64),
      generatedAt: "2026-07-15T12:00:30.000Z",
    },
    inspection: {
      assetSha256,
      status: "passed",
      evaluator: "fixture-inspector",
      evaluatorMode: "fixture",
      evaluatorVersion: "1.0.0",
      responseSha256: "e".repeat(64),
      inspectedAt: "2026-07-15T12:01:00.000Z",
      ocrText: "",
      labels: [],
    },
  };
}

describe("media snapshot hashing", () => {
  it("is order-independent under the platform-role-id stable sort", () => {
    const items = [
      media(1, "sohu", "inline"),
      media(2, "toutiao", "cover"),
      media(3, "sohu", "cover"),
    ];

    expect(mediaSnapshotHash(items)).toBe(mediaSnapshotHash([...items].reverse()));
  });

  it.each([
    ["asset bytes", (value: MediaReference) => ({ ...value, sha256: "9".repeat(64) })],
    [
      "license",
      (value: MediaReference) => ({
        ...value,
        rights: { ...value.rights, licenseName: "Changed" },
      }),
    ],
    [
      "prompt",
      (value: MediaReference) => ({
        ...value,
        visualBrief: { ...value.visualBrief, prompt: `${value.visualBrief.prompt} changed` },
      }),
    ],
    ["crop", (value: MediaReference) => ({ ...value, width: value.width + 1 })],
    [
      "inspection",
      (value: MediaReference) => ({
        ...value,
        inspection: { ...value.inspection, responseSha256: "8".repeat(64) },
      }),
    ],
  ])("changes when %s changes", (_name, mutate) => {
    const original = media(4, "ctrip_community", "cover");
    expect(mediaSnapshotHash([mutate(original)])).not.toBe(mediaSnapshotHash([original]));
  });
});
