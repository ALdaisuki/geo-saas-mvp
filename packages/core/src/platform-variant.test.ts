import type { PublicationVariantPayload, TenantContact } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import type { FactSnapshot } from "./audit.js";
import { buildBaselineAuditPolicyDocument, compileAuditPolicy } from "./audit-policy-document.js";
import { sha256Canonical } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { CoreInvariantError } from "./errors.js";
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

function sourcePayload(): PublicationVariantPayload {
  const auditPolicy = policy();
  const candidate: PublicationVariantPayload = {
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
    summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
    bodyBlocks: [
      { type: "template", templateId: "generic.body.heading.verified" },
      { type: "template", templateId: "generic.body.guidance.verified" },
      { type: "claim", claimId: factId, presentation: "bullet" },
      { type: "template", templateId: "generic.body.heading.contact" },
      { type: "contact", contactId, presentation: "paragraph" },
      { type: "template", templateId: "generic.body.guidance.contact" },
    ],
    tagTemplateIds: ["generic.tag.verified"],
    media: [],
    claims: [
      {
        id: factId,
        text: snapshot.facts[0]?.text ?? "",
        evidenceSourceIds: [sourceId],
        validUntil: null,
      },
    ],
    contactIds: [contactId],
    tags: [],
  };
  const rendered = renderCanonicalContent({
    payload: candidate,
    policy: auditPolicy,
    factSnapshot: snapshot,
    contacts,
  });
  if (
    rendered.title === null ||
    rendered.summary === null ||
    rendered.bodyMarkdown === null ||
    rendered.tags === null
  ) {
    throw new Error("Source fixture did not render");
  }
  return {
    ...candidate,
    title: rendered.title,
    summary: rendered.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    tags: [...rendered.tags],
  };
}

describe("platform publication variant rendering", () => {
  it("renders three distinct platform payloads without changing facts or contacts", () => {
    const source = sourcePayload();
    const auditPolicy = policy();
    const variants = ["toutiao", "sohu", "ctrip_community"].map((platform) =>
      renderPlatformPublicationVariant({
        sourcePayload: source,
        platform: platform as "toutiao" | "sohu" | "ctrip_community",
        policy: auditPolicy,
        factSnapshot: snapshot,
        contacts,
      }),
    );

    expect(new Set(variants.map((variant) => sha256Canonical(variant))).size).toBe(3);
    expect(new Set(variants.map((variant) => variant.title)).size).toBe(3);
    expect(new Set(variants.map((variant) => variant.bodyMarkdown)).size).toBe(3);
    expect(new Set(variants.map((variant) => variant.tags.join("|"))).size).toBe(3);
    for (const variant of variants) {
      expect(variant.claims).toEqual(source.claims);
      expect(variant.contactIds).toEqual(source.contactIds);
      expect(variant.media).toEqual([]);
      expect(Object.isFrozen(variant)).toBe(true);
      expect(Object.isFrozen(variant.bodyBlocks)).toBe(true);
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
            ([templateId]) => templateId !== "toutiao.title.evidence-first",
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
});
