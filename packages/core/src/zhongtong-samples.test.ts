import type { EditorialProfile, MediaReference, Platform, TenantContact } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import type { FactSnapshot } from "./audit.js";
import { buildBaselineAuditPolicyDocument, compileAuditPolicy } from "./audit-policy-document.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { EDITORIAL_PROFILES, renderEditorialSourcePayload } from "./editorial-profile.js";
import { buildVisualBrief } from "./media-production.js";
import { renderPlatformPublicationVariant } from "./platform-variant.js";

const tenantId = "40000000-0000-4000-8000-000000000001";
const brandId = "40000000-0000-4000-8000-000000000002";
const sourceId = "40000000-0000-4000-8000-000000000003";
const factId = "40000000-0000-4000-8000-000000000004";
const platforms: readonly Platform[] = ["toutiao", "sohu", "ctrip_community"];
const approvedPhones = new Set(["4001133986"]);
const approvedWechatIds = new Set(["ZTGL3411", "ZTGL6431"]);

const contacts: readonly TenantContact[] = [
  {
    id: "40000000-0000-4000-8000-000000000011",
    tenantId,
    type: "phone",
    label: "24小时热线",
    value: "4001133986",
    isPrimary: true,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: "40000000-0000-4000-8000-000000000012",
    tenantId,
    type: "wechat",
    label: "微信咨询一",
    value: "ZTGL3411",
    isPrimary: true,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: "40000000-0000-4000-8000-000000000013",
    tenantId,
    type: "wechat",
    label: "微信咨询二",
    value: "ZTGL6431",
    isPrimary: false,
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: null,
  },
];

const snapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-15T00:00:00.000Z",
  facts: [
    {
      id: factId,
      brandId,
      text: "中通国际旅行社的最终服务范围以签约前确认且仍在有效期内的行程材料为准。",
      evidenceSourceIds: [sourceId],
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-12-31T23:59:59.000Z",
    },
  ],
  sources: [],
};

function policy() {
  const document = buildBaselineAuditPolicyDocument({
    rulesVersion: "zhongtong-travel-samples-v1",
    industry: "travel",
  });
  return compileAuditPolicy({
    version: document.rulesVersion,
    policyHash: sha256Canonical(document),
    document,
  });
}

function mediaReference(
  editorialProfile: EditorialProfile,
  platform: Platform,
  suffix: number,
): MediaReference {
  const visualBrief = buildVisualBrief({
    editorialProfile,
    platform,
    role: "cover",
    facts: snapshot.facts,
  });
  const sha256 = suffix.toString(16).repeat(64).slice(0, 64);
  return {
    id: `41000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    sha256,
    mimeType: "image/png",
    byteLength: 1_024,
    width: platform === "ctrip_community" ? 1_200 : 1_280,
    height: platform === "ctrip_community" ? 900 : 720,
    platform,
    role: "cover",
    altText: visualBrief.altText,
    caption: visualBrief.caption,
    factIds: [...visualBrief.factIds],
    visualBrief,
    visualBriefHash: sha256Canonical(visualBrief),
    rights: {
      basis: "generated_terms",
      licenseName: "Deterministic fixture generation terms",
      verifiedAt: "2026-07-15T00:01:00.000Z",
    },
    provenance: {
      kind: "generated",
      jobId: `42000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      attemptId: `43000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      provider: "fixture",
      providerMode: "fixture",
      model: "fixture-png-v1",
      promptHash: sha256Text(visualBrief.prompt),
      parametersHash: "a".repeat(64),
      generatedAt: "2026-07-15T00:01:00.000Z",
    },
    inspection: {
      assetSha256: sha256,
      status: "passed",
      evaluator: "fixture-inspector",
      evaluatorMode: "fixture",
      evaluatorVersion: "1.0.0",
      responseSha256: "b".repeat(64),
      inspectedAt: "2026-07-15T00:02:00.000Z",
      ocrText: "",
      labels: ["fixture", "travel-service", "network:false"],
    },
  };
}

function phoneCandidates(bodyMarkdown: string): string[] {
  return (bodyMarkdown.match(/\b(?:400[-\s]?\d{3}[-\s]?\d{4}|1[3-9]\d{9})\b/gu) ?? []).map(
    (value) => value.replaceAll(/[-\s]/gu, ""),
  );
}

function wechatCandidates(bodyMarkdown: string): string[] {
  return [
    ...bodyMarkdown.matchAll(
      /(?:微信|WeChat)[^:\n：]{0,12}[:：]\s*([A-Za-z][A-Za-z0-9_-]{5,19})/giu,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

describe("Zhongtong governed article samples", () => {
  it("renders five editorial profiles for all three MVP platforms without contact drift", () => {
    const auditPolicy = policy();
    const samples = EDITORIAL_PROFILES.flatMap((editorialProfile, profileIndex) => {
      const source = renderEditorialSourcePayload({
        editorialProfile,
        policy: auditPolicy,
        factSnapshot: snapshot,
        contacts,
      });
      const sourceWithMedia = {
        ...source,
        media: platforms.map((platform, platformIndex) =>
          mediaReference(editorialProfile, platform, profileIndex * 10 + platformIndex + 1),
        ),
      };
      return platforms.map((platform) =>
        renderPlatformPublicationVariant({
          sourcePayload: sourceWithMedia,
          platform,
          policy: auditPolicy,
          factSnapshot: snapshot,
          contacts,
        }),
      );
    });

    expect(samples).toHaveLength(15);
    expect(new Set(samples.map((sample) => sha256Canonical(sample))).size).toBe(15);
    expect(new Set(samples.map((sample) => sample.title)).size).toBe(15);

    for (const sample of samples) {
      expect(sample.bodyMarkdown).toContain(snapshot.facts[0]?.text);
      expect(new Set(phoneCandidates(sample.bodyMarkdown))).toEqual(approvedPhones);
      expect(new Set(wechatCandidates(sample.bodyMarkdown))).toEqual(approvedWechatIds);
      expect(sample.contactIds).toEqual(contacts.map((contact) => contact.id));
      expect(sample.media).toHaveLength(1);
      for (const media of sample.media) {
        expect(media.provenance.kind).toBe("generated");
        expect(media.inspection.ocrText).toBe("");
        const visibleImageText = [
          media.visualBrief.prompt,
          media.visualBrief.altText,
          media.visualBrief.caption,
          media.inspection.ocrText,
        ].join("\n");
        for (const forbidden of [...approvedPhones, ...approvedWechatIds]) {
          expect(visibleImageText).not.toContain(forbidden);
        }
      }
    }
  });
});
