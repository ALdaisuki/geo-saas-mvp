import { describe, expect, it } from "vitest";

import type { PublicationVariantPayload, TenantContact } from "@geo/contracts";

import type { FactSnapshot } from "./audit.js";
import { buildBaselineAuditPolicyDocument, compileAuditPolicy } from "./audit-policy-document.js";
import { sha256Canonical } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";

const factId = "00000000-0000-4000-8000-000000000001";
const contactId = "00000000-0000-4000-8000-000000000002";

const facts: FactSnapshot = {
  tenantId: "00000000-0000-4000-8000-000000000003",
  capturedAt: "2026-07-14T00:00:00.000Z",
  facts: [
    {
      id: factId,
      brandId: "00000000-0000-4000-8000-000000000004",
      text: "当前服务范围以确认材料为准。",
      evidenceSourceIds: ["00000000-0000-4000-8000-000000000005"],
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: null,
    },
  ],
  sources: [],
};

const contacts: readonly TenantContact[] = [
  {
    id: contactId,
    tenantId: facts.tenantId,
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
    rulesVersion: "renderer-v1",
    industry: "general",
  });
  return compileAuditPolicy({
    version: document.rulesVersion,
    policyHash: sha256Canonical(document),
    document,
  });
}

function payload(overrides: Partial<PublicationVariantPayload> = {}): PublicationVariantPayload {
  return {
    title: "当前服务信息核验指南",
    summary: "以下内容仅使用当前有效的已验证事实、联系方式和审计策略固定模板生成。",
    bodyMarkdown: [
      "## 当前可核验信息",
      "- 当前服务范围以确认材料为准。",
      "## 联系与下一步",
      "24小时热线: 4001133986",
    ].join("\n\n"),
    titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
    summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
    bodyBlocks: [
      { type: "template", templateId: "generic.body.heading.verified" },
      { type: "claim", claimId: factId, presentation: "bullet" },
      { type: "template", templateId: "generic.body.heading.contact" },
      { type: "contact", contactId, presentation: "paragraph" },
    ],
    tagTemplateIds: ["generic.tag.verified"],
    media: [],
    claims: [],
    contactIds: [],
    tags: ["信息核验"],
    ...overrides,
  };
}

describe("canonical content renderer", () => {
  it("renders every publication text field only from policy, facts, and contacts", () => {
    const rendered = renderCanonicalContent({
      payload: payload(),
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });

    expect(rendered.issues).toEqual([]);
    expect(rendered.title).toBe(payload().title);
    expect(rendered.summary).toBe(payload().summary);
    expect(rendered.bodyMarkdown).toBe(payload().bodyMarkdown);
    expect(rendered.tags).toEqual(["信息核验"]);
    expect(rendered.claimIds).toEqual([factId]);
    expect(rendered.contactIds).toEqual([contactId]);
  });

  it("reports legacy fields, unknown references, and duplicate references without guessing", () => {
    const legacy = renderCanonicalContent({
      payload: {
        title: "Legacy",
        summary: "Legacy",
        bodyMarkdown: "Legacy",
        media: [],
        claims: [],
        contactIds: [],
        tags: [],
      },
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });
    expect(legacy.issues.map((issue) => issue.ruleId)).toContain("content.legacy_unstructured");

    const unknownId = "00000000-0000-4000-8000-000000000099";
    const invalid = renderCanonicalContent({
      payload: payload({
        bodyBlocks: [
          { type: "template", templateId: "generic.body.unknown" },
          { type: "claim", claimId: unknownId, presentation: "paragraph" },
          { type: "contact", contactId: unknownId, presentation: "paragraph" },
          { type: "claim", claimId: unknownId, presentation: "bullet" },
        ],
      }),
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });

    expect(invalid.issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining([
        "content.template.unknown",
        "content.claim.unknown",
        "content.contact.unknown",
        "content.reference.duplicate",
      ]),
    );
  });
});
