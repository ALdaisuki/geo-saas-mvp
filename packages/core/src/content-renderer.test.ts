import { describe, expect, it } from "vitest";

import type { PublicationVariantPayload, TenantContact } from "@geo/contracts";

import type { FactSnapshot } from "./audit.js";
import { buildBaselineAuditPolicyDocument, compileAuditPolicy } from "./audit-policy-document.js";
import { sha256Canonical } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";

const factId = "00000000-0000-4000-8000-000000000001";
const contactId = "00000000-0000-4000-8000-000000000002";

const verifiedFact: FactSnapshot["facts"][number] = {
  id: factId,
  brandId: "00000000-0000-4000-8000-000000000004",
  text: "当前服务范围以确认材料为准。",
  evidenceSourceIds: ["00000000-0000-4000-8000-000000000005"],
  validFrom: "2026-07-01T00:00:00.000Z",
  validUntil: null,
};

const facts: FactSnapshot = {
  tenantId: "00000000-0000-4000-8000-000000000003",
  capturedAt: "2026-07-14T00:00:00.000Z",
  facts: [verifiedFact],
  sources: [],
};

const contacts: readonly TenantContact[] = [
  {
    id: contactId,
    tenantId: facts.tenantId,
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
      "24小时热线: 4000000001",
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

  it("renders Pi-authored text while retaining supporting fact provenance", () => {
    const authoredPayload = payload({
      title: "第一次出境前先核对什么",
      summary: "按已核验资料整理一份出发前检查顺序。",
      bodyMarkdown: "先核对有效期，再确认行程材料。\n\n24小时热线: 4000000001",
      titleBlocks: [{ type: "authored", text: "第一次出境前先核对什么", claimIds: [factId] }],
      summaryBlocks: [
        { type: "authored", text: "按已核验资料整理一份出发前检查顺序。", claimIds: [factId] },
      ],
      bodyBlocks: [
        { type: "authored", text: "先核对有效期，再确认行程材料。", claimIds: [factId] },
        { type: "contact", contactId, presentation: "paragraph" },
      ],
      claims: [
        {
          id: factId,
          text: verifiedFact.text,
          evidenceSourceIds: [...verifiedFact.evidenceSourceIds],
          validUntil: null,
        },
      ],
      contactIds: [contactId],
    });

    const rendered = renderCanonicalContent({
      payload: authoredPayload,
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });

    expect(rendered.issues).toEqual([]);
    expect(rendered.title).toBe("第一次出境前先核对什么");
    expect(rendered.bodyMarkdown).toBe(authoredPayload.bodyMarkdown);
    expect(rendered.claimIds).toEqual([factId]);
  });

  it("renders a contact-backed claim once while retaining both provenance references", () => {
    const contactFact: FactSnapshot["facts"][number] = {
      ...verifiedFact,
      text: "示例国际旅行服务提供 24 小时咨询热线 4000000001。",
    };
    const contactFactSnapshot: FactSnapshot = {
      ...facts,
      facts: [contactFact],
    };
    const rendered = renderCanonicalContent({
      payload: payload({
        bodyMarkdown: contactFact.text,
        bodyBlocks: [
          {
            type: "claim",
            claimId: factId,
            presentation: "paragraph",
            contactIds: [contactId],
          },
        ],
        claims: [
          {
            id: factId,
            text: contactFact.text,
            evidenceSourceIds: [...contactFact.evidenceSourceIds],
            validUntil: null,
          },
        ],
        contactIds: [contactId],
      }),
      policy: policy(),
      factSnapshot: contactFactSnapshot,
      contacts,
    });

    expect(rendered.issues).toEqual([]);
    expect(rendered.bodyMarkdown).toBe("示例国际旅行服务提供 24 小时咨询热线 4000000001。");
    expect(rendered.claimIds).toEqual([factId]);
    expect(rendered.contactIds).toEqual([contactId]);
  });

  it("rejects a contact binding when the verified claim does not contain its value", () => {
    const rendered = renderCanonicalContent({
      payload: payload({
        bodyBlocks: [
          {
            type: "claim",
            claimId: factId,
            presentation: "paragraph",
            contactIds: [contactId],
          },
        ],
      }),
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });

    expect(rendered.issues.map((issue) => issue.ruleId)).toContain(
      "content.claim.contact_mismatch",
    );
  });

  it("blocks authored text that points outside the fact snapshot", () => {
    const rendered = renderCanonicalContent({
      payload: payload({
        titleBlocks: [
          {
            type: "authored",
            text: "没有证据",
            claimIds: ["00000000-0000-4000-8000-000000000099"],
          },
        ],
      }),
      policy: policy(),
      factSnapshot: facts,
      contacts,
    });

    expect(rendered.issues.map((issue) => issue.ruleId)).toContain(
      "content.authored.claim.unknown",
    );
  });
});
