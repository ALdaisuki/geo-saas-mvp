import type {
  EditorialProfile,
  MediaReference,
  Platform,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_AUDIT_POLICY, type FactSnapshot } from "./audit.js";
import { buildBaselineAuditPolicyDocument, compileAuditPolicy } from "./audit-policy-document.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { EDITORIAL_PROFILES, renderEditorialSourcePayload } from "./editorial-profile.js";
import { CoreInvariantError } from "./errors.js";
import { buildVisualBrief } from "./media-production.js";
import {
  assertPlatformPublicationVariantBoundaries,
  renderPlatformPublicationVariant,
} from "./platform-variant.js";

const tenantId = "30000000-0000-4000-8000-000000000001";
const brandId = "30000000-0000-4000-8000-000000000002";
const factId = "30000000-0000-4000-8000-000000000003";
const sourceId = "30000000-0000-4000-8000-000000000004";
const contactId = "30000000-0000-4000-8000-000000000005";

const verifiedFact: FactSnapshot["facts"][number] = {
  id: factId,
  brandId,
  text: "最终服务范围以签约前确认且仍在有效期内的材料为准",
  evidenceSourceIds: [sourceId],
  validFrom: "2026-07-01T00:00:00.000Z",
  validUntil: null,
};

const snapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-14T00:00:00.000Z",
  facts: [verifiedFact],
  sources: [],
};

const contacts: readonly TenantContact[] = [
  {
    id: contactId,
    tenantId,
    type: "phone",
    label: "24小时热线",
    value: "4000000001",
    isPrimary: true,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: null,
  },
];

function policy() {
  const document = buildBaselineAuditPolicyDocument({
    rulesVersion: "platform-profile-v1",
    industry: "general",
  });
  return compileAuditPolicy({
    version: document.rulesVersion,
    policyHash: sha256Canonical(document),
    document,
  });
}

function sourcePayload(profile: EditorialProfile = "guide"): PublicationVariantPayload {
  return renderEditorialSourcePayload({
    editorialProfile: profile,
    policy: policy(),
    factSnapshot: snapshot,
    contacts,
  });
}

function mediaReference(platform: Platform, suffix: number, role: "cover" | "inline" = "cover") {
  const visualBrief = buildVisualBrief({
    editorialProfile: "guide",
    platform,
    role,
    facts: snapshot.facts,
  });
  const sha256 = suffix.toString(16).repeat(64).slice(0, 64);
  return {
    id: `30000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    sha256,
    mimeType: "image/png",
    byteLength: 256,
    width: platform === "ctrip_community" ? 1200 : 1280,
    height: platform === "ctrip_community" ? 900 : 720,
    platform,
    role,
    altText: visualBrief.altText,
    caption: visualBrief.caption,
    factIds: [...visualBrief.factIds],
    visualBrief,
    visualBriefHash: sha256Canonical(visualBrief),
    rights: {
      basis: "generated_terms",
      licenseName: "Fixture generation terms",
      licenseUrl: "https://example.test/fixture-terms",
      verifiedAt: "2026-07-14T00:00:00.000Z",
    },
    provenance: {
      kind: "generated",
      jobId: `31000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      attemptId: `32000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      provider: "fixture",
      providerMode: "fixture",
      model: "fixture-png-v1",
      promptHash: sha256Text(visualBrief.prompt),
      parametersHash: "d".repeat(64),
      generatedAt: "2026-07-14T00:00:00.000Z",
    },
    inspection: {
      assetSha256: sha256,
      status: "passed",
      evaluator: "fixture-inspector",
      evaluatorMode: "fixture",
      evaluatorVersion: "1.0.0",
      responseSha256: "e".repeat(64),
      inspectedAt: "2026-07-14T00:01:00.000Z",
      ocrText: "",
      labels: ["travel-service"],
    },
  } satisfies MediaReference;
}

describe("platform publication variant rendering", () => {
  it("blocks Ctrip variants before persistence when inspected media is missing", () => {
    expect(() =>
      assertPlatformPublicationVariantBoundaries("ctrip_community", {
        ...sourcePayload(),
        locationQuery: "京都",
        title: "京都亲子行前核验清单",
        bodyMarkdown: "这是一段用于验证携程固定正文边界的内容。".repeat(8),
        media: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "CTRIP_MEDIA_GATE_BLOCKED" }));
  });

  it("blocks Ctrip variants before persistence when the platform location is missing", () => {
    expect(() =>
      assertPlatformPublicationVariantBoundaries("ctrip_community", {
        ...sourcePayload(),
        title: "京都亲子行前核验清单",
        bodyMarkdown: "这是一段用于验证携程固定正文边界的内容。".repeat(8),
        media: [
          mediaReference("ctrip_community", 11),
          mediaReference("ctrip_community", 12, "inline"),
          mediaReference("ctrip_community", 13, "inline"),
          mediaReference("ctrip_community", 14, "inline"),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "CTRIP_LOCATION_REQUIRED" }));
  });

  it("accepts a bounded Ctrip payload with four inspected images and one cover", () => {
    expect(() =>
      assertPlatformPublicationVariantBoundaries("ctrip_community", {
        ...sourcePayload(),
        locationQuery: "京都",
        title: "京都亲子行前核验清单",
        bodyMarkdown: "这是一段用于验证携程固定正文边界的内容。".repeat(8),
        media: [
          mediaReference("ctrip_community", 11),
          mediaReference("ctrip_community", 12, "inline"),
          mediaReference("ctrip_community", 13, "inline"),
          mediaReference("ctrip_community", 14, "inline"),
        ],
      }),
    ).not.toThrow();
  });

  it("compacts authored Ctrip title and body before applying fixed payload limits", () => {
    const source = sourcePayload();
    const authoredDraft = {
      ...source,
      claims: [],
      contactIds: [],
      title: "placeholder",
      summary: "placeholder",
      bodyMarkdown: "placeholder",
      titleBlocks: [
        {
          type: "authored" as const,
          text: "给父母安排出境旅行前需要核对的真实成本与服务边界",
          claimIds: [],
        },
      ],
      summaryBlocks: [
        { type: "authored" as const, text: "先按家庭节奏核对行程，再确认服务边界。", claimIds: [] },
      ],
      bodyBlocks: [
        {
          type: "authored" as const,
          text: `## 行程节奏\n\n${"这是一段用于验证携程平台正文压缩的内容。".repeat(220)}`,
          claimIds: [],
        },
      ],
      media: [
        mediaReference("ctrip_community", 21),
        mediaReference("ctrip_community", 22, "inline"),
        mediaReference("ctrip_community", 23, "inline"),
        mediaReference("ctrip_community", 24, "inline"),
      ],
    };
    const rendered = renderCanonicalContent({
      payload: authoredDraft,
      policy: policy(),
      factSnapshot: snapshot,
      contacts: [],
    });
    if (
      rendered.title === null ||
      rendered.summary === null ||
      rendered.bodyMarkdown === null ||
      rendered.tags === null
    ) {
      throw new Error("Expected long authored Ctrip fixture to render canonically");
    }
    const authored = {
      ...authoredDraft,
      locationQuery: "京都",
      title: rendered.title,
      summary: rendered.summary,
      bodyMarkdown: rendered.bodyMarkdown,
      tags: [...rendered.tags],
    };
    const variant = renderPlatformPublicationVariant({
      sourcePayload: authored,
      platform: "ctrip_community",
      policy: policy(),
      factSnapshot: snapshot,
      contacts: [],
    });

    expect([...variant.title].length).toBeGreaterThanOrEqual(5);
    expect([...variant.title].length).toBeLessThanOrEqual(20);
    expect([...variant.bodyMarkdown].length).toBeLessThanOrEqual(3_000);
    expect(() =>
      assertPlatformPublicationVariantBoundaries("ctrip_community", variant),
    ).not.toThrow();
  });

  it("binds the selected article template to the canonical source payload", () => {
    const source = renderEditorialSourcePayload({
      editorialProfile: "comparison",
      articleTemplateId: "comparison-matrix",
      brandAgentProfile: {
        id: "00000000-0000-4000-8000-000000000099",
        version: 2,
        documentHash: "f".repeat(64),
      },
      policy: policy(),
      factSnapshot: snapshot,
      contacts,
    });

    expect(source.articleTemplateId).toBe("comparison-matrix");
    expect(source.brandAgentProfile).toEqual({
      id: "00000000-0000-4000-8000-000000000099",
      version: 2,
      documentHash: "f".repeat(64),
    });
    expect(Object.isFrozen(source)).toBe(true);
  });

  it("carries the selected article template into every platform variant", () => {
    const source = {
      ...sourcePayload(),
      articleTemplateId: "step-by-step-guide",
      brandAgentProfile: {
        id: "00000000-0000-4000-8000-000000000099",
        version: 2,
        documentHash: "f".repeat(64),
      },
    };
    const variant = renderPlatformPublicationVariant({
      sourcePayload: source,
      platform: "toutiao",
      policy: policy(),
      factSnapshot: snapshot,
      contacts,
    });

    expect(variant.articleTemplateId).toBe("step-by-step-guide");
    expect(variant.brandAgentProfile).toEqual(source.brandAgentProfile);
  });

  it("preserves Pi-authored prose without carrying fixture platform body templates", () => {
    const base = sourcePayload();
    const authoredCandidate: PublicationVariantPayload = {
      ...base,
      title: "出发前先核对这项材料",
      summary: "按已核验资料整理的出发前检查顺序。",
      bodyMarkdown: "先核对材料，再联系旅行社确认。\n\n24小时热线: 4000000001",
      titleBlocks: [{ type: "authored", text: "出发前先核对这项材料", claimIds: [factId] }],
      summaryBlocks: [
        { type: "authored", text: "按已核验资料整理的出发前检查顺序。", claimIds: [factId] },
      ],
      bodyBlocks: [
        { type: "authored", text: "先核对材料，再联系旅行社确认。", claimIds: [factId] },
        { type: "contact", contactId, presentation: "paragraph" },
      ],
    };
    const rendered = renderCanonicalContent({
      payload: authoredCandidate,
      policy: policy(),
      factSnapshot: snapshot,
      contacts,
    });
    if (
      rendered.title === null ||
      rendered.summary === null ||
      rendered.bodyMarkdown === null ||
      rendered.tags === null
    ) {
      throw new Error("Expected the authored candidate to render complete canonical content");
    }
    const source: PublicationVariantPayload = {
      ...authoredCandidate,
      title: rendered.title,
      summary: rendered.summary,
      bodyMarkdown: rendered.bodyMarkdown,
      tags: [...rendered.tags],
    };

    const variant = renderPlatformPublicationVariant({
      sourcePayload: source,
      platform: "ctrip_community",
      policy: policy(),
      factSnapshot: snapshot,
      contacts,
    });

    expect(variant.title).toBe(source.title);
    expect(variant.bodyMarkdown).toContain("先核对材料，再联系旅行社确认。");
    expect(variant.bodyMarkdown).not.toContain("4000000001");
    expect(variant.bodyBlocks?.some((block) => block.type === "authored")).toBe(true);
    expect(variant.bodyBlocks?.some((block) => block.type === "contact")).toBe(false);
    expect(variant.contactIds).toEqual([]);
  });

  it("renders contact facts as exact claims without duplicating contact rows", () => {
    const contactFact: FactSnapshot["facts"][number] = {
      ...verifiedFact,
      text: "示例国际旅行服务提供 24 小时咨询热线 4000000001。",
    };
    const contactSnapshot: FactSnapshot = {
      ...snapshot,
      facts: [contactFact],
    };
    const base = renderEditorialSourcePayload({
      editorialProfile: "local_service",
      policy: policy(),
      factSnapshot: contactSnapshot,
      contacts,
    });
    const authoredCandidate: PublicationVariantPayload = {
      ...base,
      title: "日本亲子游首次咨询准备单",
      summary: "先整理家庭条件，再集中确认仍未知的旅行安排。",
      bodyMarkdown: "先整理人数、日期、预算和节奏偏好。\n\n24小时热线: 4000000001",
      titleBlocks: [{ type: "authored", text: "日本亲子游首次咨询准备单", claimIds: [factId] }],
      summaryBlocks: [
        {
          type: "authored",
          text: "先整理家庭条件，再集中确认仍未知的旅行安排。",
          claimIds: [factId],
        },
      ],
      bodyBlocks: [
        { type: "authored", text: "先整理人数、日期、预算和节奏偏好。", claimIds: [factId] },
        { type: "contact", contactId, presentation: "paragraph" },
      ],
    };
    const renderedSource = renderCanonicalContent({
      payload: authoredCandidate,
      policy: policy(),
      factSnapshot: contactSnapshot,
      contacts,
    });
    if (
      renderedSource.title === null ||
      renderedSource.summary === null ||
      renderedSource.bodyMarkdown === null ||
      renderedSource.tags === null
    ) {
      throw new Error("Expected the authored candidate to render complete canonical content");
    }
    const source: PublicationVariantPayload = {
      ...authoredCandidate,
      title: renderedSource.title,
      summary: renderedSource.summary,
      bodyMarkdown: renderedSource.bodyMarkdown,
      tags: [...renderedSource.tags],
    };

    const variant = renderPlatformPublicationVariant({
      sourcePayload: source,
      platform: "ctrip_community",
      policy: policy(),
      factSnapshot: contactSnapshot,
      contacts,
    });

    expect(variant.bodyBlocks?.some((block) => block.type === "authored")).toBe(true);
    expect(variant.bodyBlocks?.some((block) => block.type === "contact")).toBe(false);
    expect(variant.contactIds).toEqual([]);
    expect(variant.bodyMarkdown).not.toContain("4000000001");
  });

  it("renders twenty-five distinct profile/platform payloads without changing facts or contacts", () => {
    const auditPolicy = policy();
    const platforms: readonly Platform[] = [
      "toutiao",
      "sohu",
      "baijiahao",
      "netease",
      "ctrip_community",
    ];
    const matrix = EDITORIAL_PROFILES.flatMap((profile) => {
      const source = sourcePayload(profile);
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.titleBlocks)).toBe(true);
      expect(Object.isFrozen(source.summaryBlocks)).toBe(true);
      expect(Object.isFrozen(source.bodyBlocks)).toBe(true);
      expect(Object.isFrozen(source.claims)).toBe(true);
      expect(Object.isFrozen(source.claims[0])).toBe(true);
      expect(Object.isFrozen(source.contactIds)).toBe(true);
      expect(Object.isFrozen(source.tags)).toBe(true);

      return platforms.map((platform) => ({
        source,
        platform,
        variant: renderPlatformPublicationVariant({
          sourcePayload: source,
          platform,
          policy: auditPolicy,
          factSnapshot: snapshot,
          contacts,
        }),
      }));
    });
    const variants = matrix.map(({ variant }) => variant);

    expect(variants).toHaveLength(25);
    expect(new Set(variants.map((variant) => sha256Canonical(variant))).size).toBe(25);
    expect(new Set(variants.map((variant) => variant.title)).size).toBe(25);
    expect(new Set(variants.map((variant) => variant.summary)).size).toBe(25);
    expect(new Set(variants.map((variant) => sha256Canonical(variant.bodyBlocks))).size).toBe(25);
    expect(new Set(variants.map((variant) => variant.tags.join("|"))).size).toBe(25);
    expect(DEFAULT_AUDIT_POLICY.duplicateThreshold).toBe(0.86);

    for (const { source, platform, variant } of matrix) {
      if (platform === "ctrip_community") {
        expect(variant.contactIds).toEqual([]);
      } else {
        expect(variant.claims).toEqual(source.claims);
        expect(variant.contactIds).toEqual(source.contactIds);
      }
      expect(variant.media).toEqual([]);
      expect(Object.isFrozen(variant)).toBe(true);
      expect(Object.isFrozen(variant.titleBlocks)).toBe(true);
      expect(Object.isFrozen(variant.summaryBlocks)).toBe(true);
      expect(Object.isFrozen(variant.bodyBlocks)).toBe(true);
      expect(Object.isFrozen(variant.claims)).toBe(true);
      expect(Object.isFrozen(variant.claims[0])).toBe(true);
      expect(Object.isFrozen(variant.contactIds)).toBe(true);
      expect(Object.isFrozen(variant.tags)).toBe(true);
    }
  });

  it("fails closed for legacy, tampered, or policy-incomplete sources", () => {
    const source = sourcePayload();
    const auditPolicy = policy();
    const legacy: PublicationVariantPayload = {
      title: "legacy",
      summary: "legacy",
      bodyMarkdown: "legacy",
      media: [],
      claims: source.claims,
      contactIds: source.contactIds,
      tags: [],
    };

    expect(() =>
      renderPlatformPublicationVariant({
        sourcePayload: legacy,
        platform: "toutiao",
        policy: auditPolicy,
        factSnapshot: snapshot,
        contacts,
      }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_VARIANT_SOURCE_INVALID" }));
    expect(() =>
      renderPlatformPublicationVariant({
        sourcePayload: { ...source, bodyMarkdown: `${source.bodyMarkdown}\n\n未声明事实` },
        platform: "toutiao",
        policy: auditPolicy,
        factSnapshot: snapshot,
        contacts,
      }),
    ).toThrowError(CoreInvariantError);

    const document = buildBaselineAuditPolicyDocument({
      rulesVersion: "missing-profile-v1",
      industry: "general",
    });
    const incompleteDocument = {
      ...document,
      contentTemplates: {
        ...document.contentTemplates,
        title: Object.fromEntries(
          Object.entries(document.contentTemplates.title).filter(
            ([templateId]) => templateId !== "toutiao.guide.title",
          ),
        ),
      },
    };
    const incompletePolicy = compileAuditPolicy({
      version: incompleteDocument.rulesVersion,
      policyHash: sha256Canonical(incompleteDocument),
      document: incompleteDocument,
    });
    expect(() =>
      renderPlatformPublicationVariant({
        sourcePayload: source,
        platform: "toutiao",
        policy: incompletePolicy,
        factSnapshot: snapshot,
        contacts,
      }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_VARIANT_PROFILE_INVALID" }));
  });

  it("selects only exact-platform media and preserves multiple inline placements", () => {
    const source = {
      ...sourcePayload(),
      media: [
        mediaReference("toutiao", 1),
        mediaReference("toutiao", 2, "inline"),
        mediaReference("toutiao", 3, "inline"),
        mediaReference("sohu", 4),
        mediaReference("baijiahao", 5),
        mediaReference("netease", 6),
        mediaReference("ctrip_community", 7),
      ],
    };

    for (const platform of [
      "toutiao",
      "sohu",
      "baijiahao",
      "netease",
      "ctrip_community",
    ] as const) {
      const variant = renderPlatformPublicationVariant({
        sourcePayload: source,
        platform,
        policy: policy(),
        factSnapshot: snapshot,
        contacts,
      });
      expect(variant.media).toEqual(source.media.filter((item) => item.platform === platform));
      expect(variant.media.every((item) => item.platform === platform)).toBe(true);
      expect(Object.isFrozen(variant.media)).toBe(true);
      expect(variant.media.every((item) => Object.isFrozen(item))).toBe(true);
    }
  });

  it("rejects a media reference tampered after canonical source production", () => {
    const reference = mediaReference("toutiao", 6);
    const source = {
      ...sourcePayload(),
      media: [{ ...reference, altText: `${reference.altText} tampered` }],
    };

    expect(() =>
      renderPlatformPublicationVariant({
        sourcePayload: source,
        platform: "toutiao",
        policy: policy(),
        factSnapshot: snapshot,
        contacts,
      }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_VARIANT_SOURCE_INVALID" }));
  });
});
