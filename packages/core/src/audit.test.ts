import { describe, expect, it } from "vitest";

import type {
  MediaReference,
  Platform,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";

import {
  auditPublicationVariant,
  type BrandSnapshot,
  DEFAULT_AUDIT_POLICY,
  type AuditPolicy,
  type FactSnapshot,
  type PriorPublicationVariant,
} from "./audit.js";
import {
  buildBaselineAuditPolicyDocument,
  compileAuditPolicy,
  GEO_AUDIT_POLICY_SCHEMA_VERSION,
} from "./audit-policy-document.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
import {
  ctripPublicContentHash,
  renderCtripPublicBodyFromMarkdown,
} from "./ctrip-public-content.js";
import { CoreInvariantError } from "./errors.js";
import { buildVisualBrief, mediaSnapshotHash } from "./media-production.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const variantId = "00000000-0000-4000-8000-000000000002";
const channelAccountId = "00000000-0000-4000-8000-000000000003";
const artifactId = "00000000-0000-4000-8000-000000000004";
const brandId = "00000000-0000-4000-8000-000000000010";
const phoneId = "00000000-0000-4000-8000-000000000005";
const wechatOneId = "00000000-0000-4000-8000-000000000006";
const wechatTwoId = "00000000-0000-4000-8000-000000000007";
const sourceId = "00000000-0000-4000-8000-000000000008";
const factId = "00000000-0000-4000-8000-000000000009";
const profileId = "00000000-0000-4000-8000-000000000011";

const createdAt = "2026-07-13T12:00:00.000Z";

const brandSnapshot: BrandSnapshot = {
  id: brandId,
  canonicalName: "sample-travel",
  displayName: "示例国际旅行服务",
  aliases: ["Example Travel Services", "Example Travel"],
};

const contacts: readonly TenantContact[] = [
  {
    id: phoneId,
    tenantId,
    type: "phone",
    label: "24-hour hotline",
    value: "4000000001",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatOneId,
    tenantId,
    type: "wechat",
    label: "WeChat 1",
    value: "TRAVEL_DEMO_01",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatTwoId,
    tenantId,
    type: "wechat",
    label: "WeChat 2",
    value: "TRAVEL_DEMO_02",
    isPrimary: false,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
];

const factSnapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-12T12:00:00.000Z",
  facts: [
    {
      id: factId,
      brandId,
      text: "行程安排以签约前的最终行程单为准",
      evidenceSourceIds: [sourceId],
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
  sources: [
    {
      id: sourceId,
      locator: "https://example.test/evidence/itinerary",
      contentHash: "a".repeat(64),
      observedAt: "2026-07-12T10:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const limits = {
  maxTitleCharacters: 40,
  maxSummaryCharacters: 120,
  minBodyCharacters: 120,
  maxBodyCharacters: 5_000,
  maxTags: 5,
  minHeadings: 2,
};

const policy: AuditPolicy = {
  version: "mvp-test-v1",
  artifactTtlMs: 15 * 60 * 1_000,
  maxEvidenceAgeMs: 30 * 24 * 60 * 60 * 1_000,
  minClaims: 1,
  duplicateThreshold: 0.82,
  minDuplicateCharacters: 60,
  contentTemplates: DEFAULT_AUDIT_POLICY.contentTemplates,
  media: DEFAULT_AUDIT_POLICY.media,
  platformLimits: {
    toutiao: limits,
    sohu: limits,
    baijiahao: limits,
    netease: limits,
    ctrip_community: limits,
    zhihu: limits,
  },
};

function compilePolicyDocument(version: string, minClaims: number): AuditPolicy {
  const editorialProfiles = DEFAULT_AUDIT_POLICY.editorialProfiles;
  const platformEditorialStyles = DEFAULT_AUDIT_POLICY.platformEditorialStyles;
  if (editorialProfiles === undefined || platformEditorialStyles === undefined) {
    throw new Error("Default policy must define editorial profiles and platform styles");
  }
  const document = {
    schemaVersion: GEO_AUDIT_POLICY_SCHEMA_VERSION,
    rulesVersion: version,
    industry: "travel",
    contentTemplates: {
      title: { ...policy.contentTemplates.title },
      summary: { ...policy.contentTemplates.summary },
      body: { ...policy.contentTemplates.body },
      tag: { ...policy.contentTemplates.tag },
    },
    editorialProfiles,
    platformEditorialStyles,
    audit: {
      artifactTtlMs: policy.artifactTtlMs,
      maxEvidenceAgeMs: policy.maxEvidenceAgeMs,
      minClaims,
      duplicateThreshold: policy.duplicateThreshold,
      minDuplicateCharacters: policy.minDuplicateCharacters,
      media: policy.media,
      platformLimits: {
        toutiao: { ...policy.platformLimits.toutiao },
        sohu: { ...policy.platformLimits.sohu },
        baijiahao: { ...policy.platformLimits.baijiahao },
        netease: { ...policy.platformLimits.netease },
        ctrip_community: { ...policy.platformLimits.ctrip_community },
        zhihu: { ...policy.platformLimits.zhihu },
      },
    },
  };
  return compileAuditPolicy({
    version,
    policyHash: sha256Canonical(document),
    document,
  });
}

function publicationForClaim(
  text: string,
  renderPolicy: AuditPolicy = policy,
): Readonly<{ payload: PublicationVariantPayload; factSnapshot: FactSnapshot }> {
  const originalFact = factSnapshot.facts[0];
  const originalClaim = payload().claims[0];
  if (originalFact === undefined || originalClaim === undefined) {
    throw new Error("Audit fixtures must contain one fact and claim");
  }
  const scopedFactSnapshot: FactSnapshot = {
    ...factSnapshot,
    facts: [{ ...originalFact, text }],
  };
  const canonical: PublicationVariantPayload = {
    ...payload(),
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    claims: [{ ...originalClaim, text }],
  };
  const rendered = renderCanonicalContent({
    payload: canonical,
    policy: renderPolicy,
    factSnapshot: scopedFactSnapshot,
    contacts,
  });
  if (
    rendered.title === null ||
    rendered.summary === null ||
    rendered.bodyMarkdown === null ||
    rendered.tags === null
  ) {
    throw new Error("Claim audit fixture did not render");
  }
  return {
    payload: {
      ...canonical,
      title: rendered.title,
      summary: rendered.summary,
      bodyMarkdown: rendered.bodyMarkdown,
      tags: [...rendered.tags],
    },
    factSnapshot: scopedFactSnapshot,
  };
}

function payload(overrides: Partial<PublicationVariantPayload> = {}): PublicationVariantPayload {
  const canonical: PublicationVariantPayload = {
    editorialProfile: "guide",
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
    summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
    bodyBlocks: [
      { type: "template", templateId: "generic.body.heading.verified" },
      { type: "template", templateId: "generic.body.guidance.verified" },
      { type: "claim", claimId: factId, presentation: "paragraph" },
      { type: "template", templateId: "generic.body.heading.contact" },
      { type: "contact", contactId: phoneId, presentation: "paragraph" },
      { type: "contact", contactId: wechatOneId, presentation: "paragraph" },
      { type: "contact", contactId: wechatTwoId, presentation: "paragraph" },
      { type: "template", templateId: "generic.body.guidance.contact" },
    ],
    tagTemplateIds: ["generic.tag.verified"],
    media: [],
    claims: [
      {
        id: factId,
        text: "行程安排以签约前的最终行程单为准",
        evidenceSourceIds: [sourceId],
        validUntil: "2026-08-01T00:00:00.000Z",
      },
    ],
    contactIds: [phoneId, wechatOneId, wechatTwoId],
    tags: [],
  };
  const rendered = renderCanonicalContent({
    payload: canonical,
    policy,
    factSnapshot,
    contacts,
  });
  if (
    rendered.title === null ||
    rendered.summary === null ||
    rendered.bodyMarkdown === null ||
    rendered.tags === null
  ) {
    throw new Error("Canonical audit fixture did not render");
  }
  return {
    ...canonical,
    title: rendered.title,
    summary: rendered.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    tags: [...rendered.tags],
    ...overrides,
  };
}

function mediaReference(overrides: Partial<MediaReference> = {}): MediaReference {
  const visualBrief = buildVisualBrief({
    editorialProfile: "guide",
    platform: "toutiao",
    role: "cover",
    facts: factSnapshot.facts,
  });
  const sha256 = "c".repeat(64);
  return {
    id: "00000000-0000-4000-8000-000000000011",
    sha256,
    mimeType: "image/png",
    byteLength: 512,
    width: 1280,
    height: 720,
    platform: "toutiao",
    role: "cover",
    altText: visualBrief.altText,
    caption: visualBrief.caption,
    factIds: [...visualBrief.factIds],
    visualBrief,
    visualBriefHash: sha256Canonical(visualBrief),
    rights: {
      basis: "generated_terms",
      licenseName: "Fixture generation terms",
      licenseUrl: "https://example.test/fixture-terms",
      verifiedAt: "2026-07-13T11:30:00.000Z",
    },
    provenance: {
      kind: "generated",
      jobId: "00000000-0000-4000-8000-000000000012",
      attemptId: "00000000-0000-4000-8000-000000000013",
      provider: "fixture",
      providerMode: "fixture",
      model: "fixture-png-v1",
      promptHash: sha256Text(visualBrief.prompt),
      parametersHash: "d".repeat(64),
      generatedAt: "2026-07-13T11:30:00.000Z",
    },
    inspection: {
      assetSha256: sha256,
      status: "passed",
      evaluator: "fixture-inspector",
      evaluatorMode: "fixture",
      evaluatorVersion: "1.0.0",
      responseSha256: "e".repeat(64),
      inspectedAt: "2026-07-13T11:31:00.000Z",
      ocrText: "",
      labels: ["travel-service"],
    },
    ...overrides,
  };
}

function ctripMediaReference(
  index: number,
  sceneSignature: string,
  role: "cover" | "inline" = index === 0 ? "cover" : "inline",
): MediaReference {
  const visualBrief = buildVisualBrief({
    editorialProfile: "guide",
    platform: "ctrip_community",
    role,
    facts: factSnapshot.facts,
  });
  const hashCharacter = String(index + 1);
  const sha256 = hashCharacter.repeat(64);
  const idSuffix = String(100 + index * 4).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${idSuffix}`,
    sha256,
    mimeType: "image/jpeg",
    byteLength: 1_024 + index,
    width: 1200,
    height: 900,
    platform: "ctrip_community",
    role,
    altText: visualBrief.altText,
    caption: visualBrief.caption,
    factIds: [...visualBrief.factIds],
    visualBrief,
    visualBriefHash: sha256Canonical(visualBrief),
    rights: {
      basis: "tenant_owned",
      licenseName: "Tenant original travel image",
      verifiedAt: "2026-07-13T11:30:00.000Z",
    },
    provenance: {
      kind: "tenant_owned",
      evidenceSourceId: `00000000-0000-4000-8000-${String(101 + index * 4).padStart(12, "0")}`,
      ownershipAssertion: "The tenant owns this original travel image.",
    },
    inspection: {
      assetSha256: sha256,
      status: "passed",
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live",
      evaluatorVersion: "1.0.0",
      responseSha256: hashCharacter.repeat(64),
      inspectedAt: "2026-07-13T11:31:00.000Z",
      ocrText: "",
      labels: ["travel-relevance:passed", "contact-text:none", `scene-signature:${sceneSignature}`],
    },
  };
}

function run(
  payloadOverride: PublicationVariantPayload = payload(),
  overrides: {
    brandSnapshot?: BrandSnapshot;
    contacts?: readonly TenantContact[];
    factSnapshot?: FactSnapshot;
    platform?: Platform;
    policy?: AuditPolicy;
    priorVariants?: readonly PriorPublicationVariant[];
    submittedMediaSha256?: readonly string[];
  } = {},
) {
  return auditPublicationVariant({
    artifactId,
    tenantId,
    brandSnapshot: overrides.brandSnapshot ?? brandSnapshot,
    variantId,
    channelAccountId,
    platform: overrides.platform ?? "toutiao",
    payload: payloadOverride,
    contacts: overrides.contacts ?? contacts,
    factSnapshot: overrides.factSnapshot ?? factSnapshot,
    policy: overrides.policy ?? policy,
    priorVariants: overrides.priorVariants ?? [],
    submittedMediaSha256: overrides.submittedMediaSha256 ?? [],
    createdAt,
  });
}

function ruleIds(artifact: ReturnType<typeof run>): string[] {
  return artifact.findings.map((finding) => finding.ruleId);
}

describe("publication variant audit", () => {
  it("builds a passed, deeply frozen artifact bound to all deterministic inputs", () => {
    const artifact = run();

    expect(artifact.status).toBe("passed");
    expect(artifact.findings).toEqual([]);
    expect(artifact.payloadHash).toBe(sha256Canonical(payload()));
    expect(artifact.factSnapshotHash).toBe(sha256Canonical(factSnapshot));
    expect(artifact.brandSnapshotHash).toBe(sha256Canonical(brandSnapshot));
    expect(artifact.mediaSnapshotHash).toBe(mediaSnapshotHash([]));
    expect(artifact.policyHash).toBe(sha256Canonical(policy));
    expect(artifact.expiresAt).toBe("2026-07-13T12:15:00.000Z");
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.findings)).toBe(true);
  });

  it.each([
    { count: 0, brandText: "", blocked: true },
    { count: 1, brandText: "这份清单由示例国际旅行服务根据已核验信息整理。", blocked: false },
    {
      count: 2,
      brandText: "示例国际旅行服务适合需要逐项核对的人群，具体服务仍应向示例国际旅行服务确认。",
      blocked: false,
    },
    {
      count: 3,
      brandText:
        "示例国际旅行服务可作为候选。选择示例国际旅行服务前应核对服务范围，最终以示例国际旅行服务确认的信息为准。",
      blocked: false,
    },
    {
      count: 4,
      brandText:
        "示例国际旅行服务可作为候选。选择示例国际旅行服务前应核对服务范围，示例国际旅行服务的具体安排仍需确认，最终以示例国际旅行服务确认的信息为准。",
      blocked: true,
    },
  ])(
    "requires one to three full brand-name occurrences in the Ctrip body: $count",
    ({ brandText, blocked }) => {
      const artifact = run(
        payload({
          title: "东京亲子行前核验",
          summary: "先核对材料和时间，再安排每天的游览节奏。",
          bodyMarkdown: [
            "## 行前材料",
            "逐项核对证件与预订信息。",
            "## 每日安排",
            brandText,
            "按同行人的体力留出机动时间。",
          ].join("\n\n"),
        }),
        { platform: "ctrip_community" },
      );

      expect(ruleIds(artifact).includes("platform.brand.body_count_invalid")).toBe(blocked);
    },
  );

  it("rejects a footer-only Ctrip brand mention", () => {
    const artifact = run(
      payload({
        title: "东京亲子行前核验",
        summary: "先核对材料和时间，再安排每天的游览节奏。",
        bodyMarkdown: [
          "## 先判断是否适合",
          "家庭成员的体力、假期长度与预算会共同影响路线选择，需要先把这些条件写清楚。",
          "## 再核对具体安排",
          "逐项确认交通、住宿、餐食与每日节奏，并为可能发生的变化留出调整空间。",
          "## 最后确认",
          "具体服务范围可以向示例国际旅行服务进一步确认。",
        ].join("\n\n"),
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(artifact)).toContain("platform.brand.placement_too_late");
  });

  it("requires the exact display name rather than an alias in the Ctrip body", () => {
    const artifact = run(
      payload({
        title: "东京亲子行前核验",
        summary: "先核对材料和时间，再安排每天的游览节奏。",
        bodyMarkdown:
          "## 行前材料\n\n逐项核对证件与预订信息。\n\n## 每日安排\n\n这份清单由 Example Travel 整理。",
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(artifact)).toContain("platform.brand.body_count_invalid");
  });

  it("requires zero brand occurrences in the Ctrip title", () => {
    const artifact = run(
      payload({
        title: "示例国际旅行服务东京行前核验",
        summary: "先核对材料和时间，再安排每天的游览节奏。",
        bodyMarkdown:
          "## 行前材料\n\n逐项核对证件与预订信息。\n\n## 每日安排\n\n这份清单由示例国际旅行服务根据已核验信息整理。",
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(artifact)).toContain("platform.brand.title_forbidden");
  });

  it("allows one restrained brand reference in the Ctrip summary but blocks repetition", () => {
    const allowed = run(
      payload({
        summary: "示例国际旅行服务的服务范围，建议按合同逐项确认。",
      }),
      { platform: "ctrip_community" },
    );
    expect(ruleIds(allowed)).not.toContain("platform.brand.summary_forbidden");

    const repeated = run(
      payload({
        summary: "示例国际旅行服务提供示例国际旅行服务的服务范围说明。",
      }),
      { platform: "ctrip_community" },
    );
    expect(ruleIds(repeated)).toContain("platform.brand.summary_forbidden");
  });

  it.each([
    "立即咨询示例国际旅行服务",
    "马上预订示例国际旅行服务行程",
    "加微信了解示例国际旅行服务服务",
  ])("blocks hard-promotion wording on Ctrip Community: %s", (promotion) => {
    const artifact = run(
      payload({
        title: "东京亲子行前核验",
        summary: "先核对材料和时间，再安排每天的游览节奏。",
        bodyMarkdown: `## 行前材料\n\n逐项核对证件与预订信息。\n\n## 下一步\n\n${promotion}`,
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(artifact)).toContain("platform.brand.hard_promotion");
    expect(artifact.status).toBe("failed");
  });

  it.each([
    {
      kind: "configured phone",
      contactText: "如需确认可拨打 4000000001。",
      ruleId: "platform.contact.phone_forbidden",
      legacyAllowlistRuleId: "contact.phone.unapproved",
    },
    {
      kind: "landline phone",
      contactText: "如需确认可拨打 010-12345678。",
      ruleId: "platform.contact.phone_forbidden",
    },
    {
      kind: "international-prefix mobile phone",
      contactText: "如需确认可拨打 +86 13812345678。",
      ruleId: "platform.contact.phone_forbidden",
    },
    {
      kind: "configured WeChat",
      contactText: "也可以通过微信 TRAVEL_DEMO_01 进一步确认。",
      ruleId: "platform.contact.wechat_forbidden",
      legacyAllowlistRuleId: "contact.wechat.unapproved",
    },
    {
      kind: "email",
      contactText: "请发送邮件至 service@example.com。",
      ruleId: "platform.contact.email_forbidden",
    },
    {
      kind: "external link",
      contactText: "更多信息见 https://travel.example.com/tokyo。",
      ruleId: "platform.contact.external_link_forbidden",
    },
    {
      kind: "QR code",
      contactText: "扫描二维码查看联系方式。",
      ruleId: "platform.contact.qr_code_forbidden",
    },
  ])(
    "blocks $kind in the Ctrip body even when tenant contacts are configured",
    ({ contactText, ruleId, legacyAllowlistRuleId }) => {
      const artifact = run(
        payload({
          title: "东京亲子行前核验",
          summary: "先核对材料和时间，再安排每天的游览节奏。",
          bodyMarkdown: [
            "## 行前材料",
            "逐项核对证件与预订信息。",
            "## 每日安排",
            "这份清单由示例国际旅行服务根据已核验信息整理。",
            contactText,
          ].join("\n\n"),
        }),
        { platform: "ctrip_community" },
      );

      expect(ruleIds(artifact)).toContain(ruleId);
      if (legacyAllowlistRuleId !== undefined) {
        expect(ruleIds(artifact)).not.toContain(legacyAllowlistRuleId);
      }
      expect(artifact.status).toBe("failed");
    },
  );

  it("requires the payload to bind the exact immutable Brand Agent Profile snapshot", () => {
    const document = {
      schemaVersion: "geo.brand-agent-profile.v1" as const,
      voice: "Clear and evidence first",
      audiences: ["Service buyers"],
      objectives: ["Explain verified service boundaries"],
      requiredPoints: ["State validity limits"],
      forbiddenClaims: ["Guaranteed outcome"],
      callToAction: "Confirm the current scope through an approved contact.",
      agentInstructions: "Select only strategies supported by current facts.",
    };
    const reference = {
      id: profileId,
      version: 2,
      documentHash: sha256Canonical(document),
    };
    const snapshot = { ...brandSnapshot, agentProfile: { reference, document } };

    expect(run(payload({ brandAgentProfile: reference }), { brandSnapshot: snapshot }).status).toBe(
      "passed",
    );
    expect(() =>
      run(payload({ brandAgentProfile: { ...reference, version: 3 } }), {
        brandSnapshot: snapshot,
      }),
    ).toThrowError(expect.objectContaining({ code: "AUDIT_CONTEXT_MISMATCH" }));
    expect(() => run(payload({ brandAgentProfile: reference }))).toThrowError(
      expect.objectContaining({ code: "AUDIT_CONTEXT_MISMATCH" }),
    );
  });

  it("passes exact fact-bound media and binds it into the audit artifact", () => {
    const media = mediaReference();
    const artifact = run(payload({ media: [media] }));

    expect(artifact.status).toBe("passed");
    expect(artifact.findings).toEqual([]);
    expect(artifact.mediaSnapshotHash).toBe(mediaSnapshotHash([media]));
    expect(artifact.payloadHash).toBe(sha256Canonical(payload({ media: [media] })));
  });

  it("accepts the exact allowlisted live Pi vision evaluator", () => {
    const media = mediaReference();
    const inspected = {
      ...media,
      inspection: {
        ...media.inspection,
        evaluator: "pi-vision-inspector",
        evaluatorMode: "live" as const,
        evaluatorVersion: "1.0.0",
        ocrText: "Mount Fuji",
      },
    };

    expect(run(payload({ media: [inspected] })).status).toBe("passed");
  });

  it("accepts a manual media-review handoff without treating it as a failed inspection", () => {
    const media = mediaReference();
    const inspected = {
      ...media,
      inspection: {
        ...media.inspection,
        evaluator: "manual-review-operator" as const,
        evaluatorMode: "live" as const,
        evaluatorVersion: "1.0.0",
        labels: [...media.inspection.labels, "manual-review:required"],
      },
    };

    const preManualReviewPolicy: AuditPolicy = {
      ...policy,
      media: {
        ...policy.media,
        evaluatorAllowlist: policy.media.evaluatorAllowlist.filter(
          (entry) => entry.evaluator !== "manual-review-operator",
        ),
      },
    };

    expect(run(payload({ media: [inspected] }), { policy: preManualReviewPolicy }).status).toBe(
      "passed",
    );
  });

  it("accepts the explicit no-Vision pass-through evaluator", () => {
    const media = mediaReference();
    const inspected = {
      ...media,
      inspection: {
        ...media.inspection,
        evaluator: "no-vision-pass-through" as const,
        evaluatorMode: "live" as const,
        evaluatorVersion: "1.0.0",
        labels: ["vision-audit:skipped", "vision-audit:none"],
      },
    };

    expect(run(payload({ media: [inspected] })).status).toBe("passed");
  });

  it("keeps no-Vision compatible with a pre-existing tenant policy document", () => {
    const media = mediaReference();
    const inspected = {
      ...media,
      inspection: {
        ...media.inspection,
        evaluator: "no-vision-pass-through" as const,
        evaluatorMode: "live" as const,
        evaluatorVersion: "1.0.0",
        labels: ["vision-audit:skipped", "vision-audit:none"],
      },
    };
    const legacyPolicy: AuditPolicy = {
      ...policy,
      media: {
        ...policy.media,
        evaluatorAllowlist: policy.media.evaluatorAllowlist.filter(
          (entry) => entry.evaluator !== "no-vision-pass-through",
        ),
      },
    };

    expect(run(payload({ media: [inspected] }), { policy: legacyPolicy }).status).toBe("passed");
  });

  it("blocks duplicate IDs, wrong platforms, and unknown media facts", () => {
    const valid = mediaReference();
    const duplicate = mediaReference({
      ...valid,
      sha256: "f".repeat(64),
      inspection: { ...valid.inspection, assetSha256: "f".repeat(64) },
    });
    const wrongPlatform = run(payload({ media: [{ ...valid, platform: "sohu" }] }));
    const duplicateIds = run(payload({ media: [valid, duplicate] }));
    const unknownId = "00000000-0000-4000-8000-000000000099";
    const unknownFactBrief = {
      ...valid.visualBrief,
      factIds: [unknownId],
    };
    const unknownFact = run(
      payload({
        media: [
          {
            ...valid,
            factIds: [unknownId],
            visualBrief: unknownFactBrief,
            visualBriefHash: sha256Canonical(unknownFactBrief),
          },
        ],
      }),
    );

    expect(ruleIds(wrongPlatform)).toContain("media.platform.mismatch");
    expect(ruleIds(duplicateIds)).toContain("media.id.duplicate");
    expect(ruleIds(unknownFact)).toEqual(
      expect.arrayContaining(["media.fact.unverified", "media.fact.not_in_payload"]),
    );
  });

  it("blocks visual brief, prompt, alt text, and caption tampering", () => {
    const valid = mediaReference();
    const changedBrief = { ...valid.visualBrief, prompt: `${valid.visualBrief.prompt} changed` };
    const promptTampered = run(payload({ media: [{ ...valid, visualBrief: changedBrief }] }));
    const altTampered = run(
      payload({ media: [{ ...valid, altText: `${valid.altText} changed` }] }),
    );
    const captionTampered = run(
      payload({ media: [{ ...valid, caption: `${valid.caption} changed` }] }),
    );

    expect(ruleIds(promptTampered)).toEqual(
      expect.arrayContaining([
        "media.visual_brief.invalid",
        "media.visual_brief.hash_mismatch",
        "media.provenance.prompt_hash_mismatch",
      ]),
    );
    expect(ruleIds(altTampered)).toContain("media.alt_text.mismatch");
    expect(ruleIds(captionTampered)).toContain("media.caption.mismatch");
  });

  it("blocks invalid rights, rendition dimensions, and inspection evidence", () => {
    const valid = mediaReference();
    const invalidRights = run(
      payload({
        media: [{ ...valid, rights: { ...valid.rights, basis: "tenant_owned" } }],
      }),
    );
    const badDimensions = run(payload({ media: [{ ...valid, width: 640, height: 640 }] }));
    const badMime = run(payload({ media: [{ ...valid, mimeType: "image/gif" }] }));
    const failedInspection = run(
      payload({ media: [{ ...valid, inspection: { ...valid.inspection, status: "failed" } }] }),
    );
    const contactOcr = run(
      payload({
        media: [
          {
            ...valid,
            inspection: {
              ...valid.inspection,
              ocrText: "Call 4000000001 or WeChat TRAVEL_DEMO_01",
            },
          },
        ],
      }),
    );
    const unapprovedEvaluator = run(
      payload({
        media: [
          {
            ...valid,
            inspection: { ...valid.inspection, evaluatorVersion: "unapproved-v2" },
          },
        ],
      }),
    );
    const withoutInspection: Partial<MediaReference> = { ...valid };
    delete withoutInspection.inspection;
    const missingInspection = run(
      payload({ media: [withoutInspection as unknown as MediaReference] }),
    );

    expect(ruleIds(invalidRights)).toContain("media.rights.invalid");
    expect(ruleIds(badDimensions)).toContain("media.rendition.dimensions_invalid");
    expect(ruleIds(badMime)).toContain("media.rendition.mime_unsupported");
    expect(ruleIds(failedInspection)).toContain("media.inspection.failed");
    expect(ruleIds(contactOcr)).toContain("media.inspection.contact_text");
    expect(ruleIds(unapprovedEvaluator)).toContain("media.inspection.evaluator_unapproved");
    expect(missingInspection.status).toBe("failed");
    expect(ruleIds(missingInspection)).toContain("media.inspection.missing");
  });

  it("blocks failed visual evidence while retaining semantic OCR findings", () => {
    const valid = mediaReference();
    const degraded = run(
      payload({
        media: [
          {
            ...valid,
            inspection: {
              ...valid.inspection,
              status: "failed",
              ocrText: "WeChat TRAVEL_DEMO_01",
              labels: [...valid.inspection.labels, "vision-audit:degraded"],
            },
          },
        ],
      }),
    );

    expect(degraded.status).toBe("failed");
    expect(degraded.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "media.inspection.failed", severity: "blocking" }),
        expect.objectContaining({
          ruleId: "media.inspection.contact_text",
          severity: "warning",
        }),
      ]),
    );
  });

  it("makes compiled document changes affect audit behavior and preserves legacy hashing", () => {
    const permissivePolicy = compilePolicyDocument("mvp-test-v1", 1);
    const restrictivePolicy = compilePolicyDocument("mvp-test-v2", 2);
    const permissiveArtifact = run(payload(), { policy: permissivePolicy });
    const restrictiveArtifact = run(payload(), { policy: restrictivePolicy });

    expect(permissiveArtifact.status).toBe("passed");
    expect(permissiveArtifact.policyHash).toBe(permissivePolicy.sourceHash);
    expect(restrictiveArtifact.status).toBe("failed");
    expect(ruleIds(restrictiveArtifact)).toContain("evidence.claims.insufficient");
    expect(restrictiveArtifact.policyHash).toBe(restrictivePolicy.sourceHash);
    expect(restrictiveArtifact.policyHash).not.toBe(permissiveArtifact.policyHash);
    expect(run().policyHash).toBe(sha256Canonical(policy));
  });

  it("strips legacy keyword rules and binds the audit to derived execution semantics", () => {
    const currentDocument = buildBaselineAuditPolicyDocument({
      rulesVersion: "legacy-effective-hash-v1",
      industry: "travel",
    });
    const legacyDocument = {
      ...currentDocument,
      audit: {
        ...currentDocument.audit,
        prohibitedGuarantees: ["百分百"],
        hardBlockRules: { categories: { absolute_efficacy: ["百分百"] } },
        qualificationClaimRules: { terms: ["5A级旅行社"] },
      },
    };
    const sourceHash = sha256Canonical(legacyDocument);
    const legacyPolicy = compileAuditPolicy({
      version: "legacy-effective-hash-v1",
      policyHash: sourceHash,
      document: legacyDocument,
    });

    const fixture = publicationForClaim("该服务百分百适合所有人。", legacyPolicy);
    const artifact = run(fixture.payload, {
      factSnapshot: fixture.factSnapshot,
      policy: legacyPolicy,
    });

    expect(legacyPolicy).not.toHaveProperty("prohibitedGuarantees");
    expect(legacyPolicy).not.toHaveProperty("hardBlockRules");
    expect(legacyPolicy).not.toHaveProperty("qualificationClaimRules");
    expect(legacyPolicy.sourceHash).toBe(sourceHash);
    expect(legacyPolicy.effectiveHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(legacyPolicy.effectiveHash).not.toBe(sourceHash);
    expect(artifact.policyHash).toBe(legacyPolicy.effectiveHash);
    expect(artifact.policyHash).not.toBe(legacyPolicy.sourceHash);
  });

  it.each([
    "该渠道公开出售毒品并提供交易方式。",
    "该机构使用伪造资质招揽客户。",
    "云南排名Top1，百分百保证签证成功。",
    "该机构自称政府指定服务机构。",
    "文章称竞争对手是骗子公司。",
    "示例国际旅行服务自称是5A级旅行社。",
    "客户身份证号：待补充。",
  ])("does not perform semantic keyword matching: %s", (claim) => {
    const fixture = publicationForClaim(claim);

    const artifact = run(fixture.payload, { factSnapshot: fixture.factSnapshot });

    expect(artifact.status).toBe("passed");
    expect(ruleIds(artifact).filter((ruleId) => ruleId.startsWith("content.hard_block."))).toEqual(
      [],
    );
  });

  it("blocks a structured privacy identifier found in inspected media text", () => {
    const media = mediaReference();
    const artifact = run(
      payload({
        media: [
          {
            ...media,
            inspection: {
              ...media.inspection,
              ocrText: "客户资料 11010519491231002X",
            },
          },
        ],
      }),
    );

    expect(artifact.status).toBe("failed");
    expect(ruleIds(artifact)).toContain("content.hard_block.privacy_disclosure");
  });

  it.each([
    {
      kind: "Chinese national ID",
      text: "客户资料包含 １１０１０５ １９４９１２３１ ００２Ｘ，请勿外传。",
      evidence: "identifier=chinese_national_id",
    },
    {
      kind: "passport",
      text: "客户资料包含 E-1234 5678，请勿外传。",
      evidence: "identifier=passport",
    },
    {
      kind: "bank card",
      text: "客户资料包含 ４１１１－１１１１－１１１１－１１１１，请勿外传。",
      evidence: "identifier=bank_card",
    },
  ])("blocks an unlabeled $kind in final article prose", ({ text, evidence }) => {
    const fixture = publicationForClaim(text);

    const artifact = run(fixture.payload, { factSnapshot: fixture.factSnapshot });

    expect(artifact.status).toBe("failed");
    expect(artifact.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "content.hard_block.privacy_disclosure",
        severity: "blocking",
        evidence: expect.arrayContaining([evidence]),
      }),
    );
  });

  it("does not copy a grouped national ID into any audit finding evidence", () => {
    const fixture = publicationForClaim("客户资料包含 110105 19491231 002X，请勿外传。");

    const artifact = run(fixture.payload, { factSnapshot: fixture.factSnapshot });
    const serializedFindings = JSON.stringify(artifact.findings);

    expect(artifact.status).toBe("failed");
    expect(serializedFindings).not.toContain("110105");
    expect(serializedFindings).not.toContain("19491231");
    expect(serializedFindings).not.toContain("002X");
  });

  it.each([
    {
      field: "altText",
      text: "客户资料 110105-19491231-002X",
      evidence: "identifier=chinese_national_id",
    },
    {
      field: "caption",
      text: "客户资料 E 1234-5678",
      evidence: "identifier=passport",
    },
    {
      field: "ocrText",
      text: "客户资料 4111 1111 1111 1111",
      evidence: "identifier=bank_card",
    },
  ] as const)("blocks an unlabeled sensitive identifier in media $field", (sample) => {
    const media = mediaReference();
    const visibleMedia =
      sample.field === "ocrText"
        ? {
            ...media,
            inspection: { ...media.inspection, ocrText: sample.text },
          }
        : (() => {
            const visualBrief = { ...media.visualBrief, [sample.field]: sample.text };
            return {
              ...media,
              [sample.field]: sample.text,
              visualBrief,
              visualBriefHash: sha256Canonical(visualBrief),
            };
          })();

    const artifact = run(payload({ media: [visibleMedia] }));

    expect(artifact.status).toBe("failed");
    expect(artifact.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "content.hard_block.privacy_disclosure",
        severity: "blocking",
        evidence: expect.arrayContaining([sample.evidence]),
      }),
    );
  });

  it.each([
    "2026年至2030年的服务计划仍以公开材料为准。",
    "普通订单号为2026080412345678，仅用于内部进度查询。",
    "普通订单号为E12345678，仅用于内部进度查询。",
    "普通订单号为4111-1111-1111-1111，仅用于内部进度查询。",
    "许可证材料编号为SC123456789，应从签约主体处核对。",
  ])("does not treat ordinary dates or business identifiers as private numbers: %s", (text) => {
    const fixture = publicationForClaim(text);

    const artifact = run(fixture.payload, { factSnapshot: fixture.factSnapshot });

    expect(artifact.status).toBe("passed");
    expect(ruleIds(artifact)).not.toContain("content.hard_block.privacy_disclosure");
  });

  it("rejects a cloned compiled policy whose rules no longer match its source provenance", () => {
    const compiledPolicy = compilePolicyDocument("mvp-test-v1", 1);
    const forgedPolicy: AuditPolicy = { ...compiledPolicy, minClaims: 0 };

    expect(() => run(payload(), { policy: forgedPolicy })).toThrowError(CoreInvariantError);
    expect(() => run(payload(), { policy: forgedPolicy })).toThrowError(
      expect.objectContaining({ code: "AUDIT_POLICY_SOURCE_UNTRUSTED" }),
    );
  });

  it("blocks arbitrary prose appended after a canonical contact", () => {
    const appendedProse = payload({
      bodyMarkdown: `${payload().bodyMarkdown}\n\nThe current itinerary remains the source of truth.`,
    });

    const artifact = run(appendedProse);

    expect(artifact.status).toBe("failed");
    expect(ruleIds(artifact)).toContain("body.render_mismatch");
  });

  it("blocks unapproved contact values and missing referenced contacts", () => {
    const wrong = payload({
      bodyMarkdown: payload()
        .bodyMarkdown.replace("4000000001", "4000000099")
        .replace("TRAVEL_DEMO_01", "ZTGL9999"),
    });
    const artifact = run(wrong);

    expect(artifact.status).toBe("failed");
    expect(ruleIds(artifact)).toEqual(
      expect.arrayContaining([
        "contact.phone.unapproved",
        "contact.wechat.unapproved",
        "contact.reference.missing",
      ]),
    );
  });

  it("detects an unapproved hotline even when the number has no contact label", () => {
    const phoneLine = `${contacts[0]?.label}: 4000000001`;
    const wrong = payload({
      bodyMarkdown: payload().bodyMarkdown.replace(phoneLine, "4000000099"),
    });
    const artifact = run(wrong);

    expect(ruleIds(artifact)).toEqual(
      expect.arrayContaining(["contact.phone.unapproved", "contact.reference.missing"]),
    );
  });

  it("blocks missing, stale, expired, and unknown evidence", () => {
    const originalSource = factSnapshot.sources[0];
    if (originalSource === undefined) {
      throw new Error("test fixture must include an evidence source");
    }
    const staleSnapshot: FactSnapshot = {
      ...factSnapshot,
      sources: [
        {
          ...originalSource,
          observedAt: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-07-13T11:59:59.000Z",
        },
      ],
    };
    const audited = run(
      payload({
        claims: [
          {
            id: "00000000-0000-4000-8000-000000000009",
            text: "A claim without enough support",
            evidenceSourceIds: [sourceId, "00000000-0000-4000-8000-000000000099"],
            validUntil: "2026-07-13T11:59:59.000Z",
          },
        ],
      }),
      { factSnapshot: staleSnapshot },
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining([
        "evidence.claim.expired",
        "evidence.source.expired",
        "evidence.source.stale",
        "evidence.source.unknown",
      ]),
    );
  });

  it("blocks claims that are not exactly bound to a verified fact", () => {
    const audited = run(
      payload({
        claims: [
          {
            id: factId,
            text: "A fabricated replacement claim",
            evidenceSourceIds: [sourceId],
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["evidence.claim.text_mismatch", "evidence.claim.not_in_content"]),
    );
  });

  it("blocks unknown, cross-brand, and evidence-mismatched fact bindings", () => {
    const baseClaim = payload().claims[0];
    const baseFact = factSnapshot.facts[0];
    if (baseClaim === undefined || baseFact === undefined) {
      throw new Error("Audit fixtures must contain a claim and a verified fact");
    }
    const unknown = run(
      payload({
        claims: [
          {
            ...baseClaim,
            id: "00000000-0000-4000-8000-000000000099",
          },
        ],
      }),
    );
    const mismatchedSnapshot: FactSnapshot = {
      ...factSnapshot,
      facts: [
        {
          ...baseFact,
          brandId: "00000000-0000-4000-8000-000000000077",
          evidenceSourceIds: ["00000000-0000-4000-8000-000000000078"],
        },
      ],
    };
    const mismatched = run(payload(), { factSnapshot: mismatchedSnapshot });

    expect(ruleIds(unknown)).toContain("evidence.claim.unverified");
    expect(ruleIds(mismatched)).toEqual(
      expect.arrayContaining(["evidence.claim.brand_mismatch", "evidence.claim.sources_mismatch"]),
    );
  });

  it("ignores guarantee keywords while enforcing versioned platform limits", () => {
    const audited = run(
      payload({
        title:
          "这是一个明显超过四十个字符的平台标题用于验证最终变体会被发布前审计确定性地阻止并且绝不会漏掉",
        bodyMarkdown: `${payload().bodyMarkdown}\n\n我们保证签证包过。`,
      }),
    );

    expect(ruleIds(audited)).toContain("platform.title.too_long");
    expect(ruleIds(audited)).not.toContain("content.hard_block.absolute_efficacy");
  });

  it("enforces fixed Ctrip publication limits even when a tenant policy is looser", () => {
    const audited = run(
      payload({
        title: "123456789012345678901",
        media: [],
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["platform.title.too_long", "platform.media.count_invalid"]),
    );
  });

  it("enforces the Ctrip four-to-five image plan with exactly one cover", () => {
    const four = [
      ctripMediaReference(0, "mountain_lake:outdoor:wide"),
      ctripMediaReference(1, "rail_transport:transit:wide"),
      ctripMediaReference(2, "temple_shrine:outdoor:medium"),
      ctripMediaReference(3, "urban_street:outdoor:wide"),
    ] as const;
    const three = run(payload({ media: four.slice(0, 3) }), { platform: "ctrip_community" });
    const fourAudited = run(payload({ media: [...four] }), { platform: "ctrip_community" });
    const six = run(
      payload({
        media: [
          ...four,
          ctripMediaReference(4, "food:indoor:closeup"),
          ctripMediaReference(5, "lodging:indoor:interior"),
        ],
      }),
      { platform: "ctrip_community" },
    );
    const twoCovers = run(
      payload({
        media: [
          four[0],
          ctripMediaReference(1, "rail_transport:transit:wide", "cover"),
          ...four.slice(2),
        ],
      }),
      { platform: "ctrip_community" },
    );

    expect(ruleIds(three)).toContain("platform.media.count_invalid");
    expect(ruleIds(fourAudited)).not.toContain("platform.media.count_invalid");
    expect(ruleIds(fourAudited)).not.toContain("platform.media.cover_count_invalid");
    expect(ruleIds(six)).toContain("platform.media.count_invalid");
    expect(ruleIds(twoCovers)).toContain("platform.media.cover_count_invalid");
  });

  it("blocks repeated Ctrip image bytes or missing scene evidence but allows scene reuse", () => {
    const media = [
      ctripMediaReference(0, "mountain_lake:outdoor:wide"),
      ctripMediaReference(1, "rail_transport:transit:wide"),
      ctripMediaReference(2, "temple_shrine:outdoor:medium"),
      ctripMediaReference(3, "urban_street:outdoor:wide"),
    ] as const;
    const repeatedBytes = {
      ...media[1],
      sha256: media[0].sha256,
      inspection: { ...media[1].inspection, assetSha256: media[0].sha256 },
    };
    const repeatedScene = {
      ...media[1],
      inspection: {
        ...media[1].inspection,
        labels: [
          "travel-relevance:passed",
          "contact-text:none",
          "scene-signature:mountain_lake:outdoor:wide",
        ],
      },
    };
    const missingScene = {
      ...media[1],
      inspection: {
        ...media[1].inspection,
        labels: ["travel-relevance:passed", "contact-text:none"],
      },
    };

    expect(
      ruleIds(
        run(payload({ media: [media[0], repeatedBytes, ...media.slice(2)] }), {
          platform: "ctrip_community",
        }),
      ),
    ).toContain("media.sha256.duplicate");
    expect(
      ruleIds(
        run(payload({ media: [media[0], repeatedScene, ...media.slice(2)] }), {
          platform: "ctrip_community",
        }),
      ),
    ).not.toContain("media.scene.duplicate");
    expect(
      ruleIds(
        run(payload({ media: [media[0], missingScene, ...media.slice(2)] }), {
          platform: "ctrip_community",
        }),
      ),
    ).toContain("media.scene.missing");
  });

  it("blocks weak structure and near-duplicate bodies", () => {
    const current = payload({ bodyMarkdown: payload().bodyMarkdown.replace(/^## /gm, "") });
    const priorVariants: readonly PriorPublicationVariant[] = [
      {
        variantId: "00000000-0000-4000-8000-000000000088",
        platform: "sohu",
        payloadHash: sha256Canonical({ prior: true }),
        bodyMarkdown: `${current.bodyMarkdown}。`,
      },
    ];
    const audited = run(current, { priorVariants });

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["structure.headings.insufficient", "duplicate.near"]),
    );
  });

  it("blocks media bytes that were already submitted by the tenant", () => {
    const current = payload({
      media: [
        ctripMediaReference(0, "mountain_lake:outdoor:wide"),
        ctripMediaReference(1, "rail_transport:transit:wide"),
        ctripMediaReference(2, "temple_shrine:outdoor:medium"),
        ctripMediaReference(3, "urban_street:outdoor:wide"),
      ],
    });

    expect(
      ruleIds(
        run(current, {
          platform: "ctrip_community",
          submittedMediaSha256: [current.media[0]?.sha256 ?? ""],
        }),
      ),
    ).toContain("media.sha256.previously_submitted");
  });

  it("blocks an exact normalized Ctrip public-content history binding", () => {
    const current = payload({
      bodyMarkdown: [
        "## 东京 **亲子**核验",
        "",
        "先确认 [交通入口](https://example.test/route)。",
        "",
        "- 核对开放时间",
        "- 保留替代路线",
      ].join("\n"),
    });
    const publicBody = renderCtripPublicBodyFromMarkdown(current.bodyMarkdown);
    const priorVariants: readonly PriorPublicationVariant[] = [
      {
        variantId: "00000000-0000-4000-8000-000000000089",
        platform: "ctrip_community",
        payloadHash: sha256Canonical({ importedHistoricalPublication: true }),
        publicContentHash: ctripPublicContentHash(
          `  ${current.title} `,
          publicBody.replace(/\n/gu, "  \r\n"),
        ),
        bodyMarkdown: publicBody,
      },
    ];

    expect(ruleIds(run(current, { platform: "ctrip_community", priorVariants }))).toContain(
      "duplicate.exact",
    );
  });

  it("changes the audit binding when the final platform payload changes", () => {
    const first = run();
    const changed = run(payload({ summary: `${payload().summary} 请以最新页面为准。` }));

    expect(first.payloadHash).not.toBe(changed.payloadHash);
    expect(first.auditHash).not.toBe(changed.auditHash);
  });
});
