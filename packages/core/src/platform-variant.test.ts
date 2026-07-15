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
import { EDITORIAL_PROFILES, renderEditorialSourcePayload } from "./editorial-profile.js";
import { CoreInvariantError } from "./errors.js";
import { buildVisualBrief } from "./media-production.js";
import { renderPlatformPublicationVariant } from "./platform-variant.js";

const tenantId = "30000000-0000-4000-8000-000000000001";
const brandId = "30000000-0000-4000-8000-000000000002";
const factId = "30000000-0000-4000-8000-000000000003";
const sourceId = "30000000-0000-4000-8000-000000000004";
const contactId = "30000000-0000-4000-8000-000000000005";

const snapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-14T00:00:00.000Z",
  facts: [
    {
      id: factId,
      brandId,
      text: "最终服务范围以签约前确认且仍在有效期内的材料为准",
      evidenceSourceIds: [sourceId],
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: null,
    },
  ],
  sources: [],
};

const contacts: readonly TenantContact[] = [
  {
    id: contactId,
    tenantId,
    type: "phone",
    label: "24小时热线",
    value: "4001133986",
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
  it("renders fifteen distinct profile/platform payloads without changing facts or contacts", () => {
    const auditPolicy = policy();
    const platforms: readonly Platform[] = ["toutiao", "sohu", "ctrip_community"];
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

    expect(variants).toHaveLength(15);
    expect(new Set(variants.map((variant) => sha256Canonical(variant))).size).toBe(15);
    expect(new Set(variants.map((variant) => variant.title)).size).toBe(15);
    expect(new Set(variants.map((variant) => variant.summary)).size).toBe(15);
    expect(new Set(variants.map((variant) => sha256Canonical(variant.bodyBlocks))).size).toBe(15);
    expect(new Set(variants.map((variant) => variant.tags.join("|"))).size).toBe(15);
    expect(DEFAULT_AUDIT_POLICY.duplicateThreshold).toBe(0.86);

    for (const { source, variant } of matrix) {
      expect(variant.claims).toEqual(source.claims);
      expect(variant.contactIds).toEqual(source.contactIds);
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
        mediaReference("ctrip_community", 5),
      ],
    };

    for (const platform of ["toutiao", "sohu", "ctrip_community"] as const) {
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
