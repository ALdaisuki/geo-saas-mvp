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
import { compileAuditPolicy, GEO_AUDIT_POLICY_SCHEMA_VERSION } from "./audit-policy-document.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
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
  canonicalName: "zhongtong-international-travel",
  displayName: "Zhongtong International Travel Agency",
  aliases: ["Zhongtong Travel"],
};

const contacts: readonly TenantContact[] = [
  {
    id: phoneId,
    tenantId,
    type: "phone",
    label: "24-hour hotline",
    value: "4001133986",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatOneId,
    tenantId,
    type: "wechat",
    label: "WeChat 1",
    value: "ZTGL3411",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatTwoId,
    tenantId,
    type: "wechat",
    label: "WeChat 2",
    value: "ZTGL6431",
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
  prohibitedGuarantees: ["百分百", "保证签证", "包过"],
  contentTemplates: DEFAULT_AUDIT_POLICY.contentTemplates,
  media: DEFAULT_AUDIT_POLICY.media,
  platformLimits: {
    toutiao: limits,
    sohu: limits,
    ctrip_community: limits,
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
      prohibitedGuarantees: [...policy.prohibitedGuarantees],
      media: policy.media,
      platformLimits: {
        toutiao: { ...policy.platformLimits.toutiao },
        sohu: { ...policy.platformLimits.sohu },
        ctrip_community: { ...policy.platformLimits.ctrip_community },
      },
    },
  };
  return compileAuditPolicy({
    version,
    policyHash: sha256Canonical(document),
    document,
  });
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

function run(
  payloadOverride: PublicationVariantPayload = payload(),
  overrides: {
    brandSnapshot?: BrandSnapshot;
    contacts?: readonly TenantContact[];
    factSnapshot?: FactSnapshot;
    platform?: Platform;
    policy?: AuditPolicy;
    priorVariants?: readonly PriorPublicationVariant[];
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
            inspection: { ...valid.inspection, ocrText: "Call 4001133986 or WeChat ZTGL3411" },
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
    expect(ruleIds(missingInspection)).toContain("media.inspection.missing");
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
        .bodyMarkdown.replace("4001133986", "4001133987")
        .replace("ZTGL3411", "ZTGL9999"),
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
    const phoneLine = `${contacts[0]?.label}: 4001133986`;
    const wrong = payload({
      bodyMarkdown: payload().bodyMarkdown.replace(phoneLine, "4001133987"),
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

  it("blocks prohibited guarantees and versioned platform-limit violations", () => {
    const audited = run(
      payload({
        title:
          "这是一个明显超过四十个字符的平台标题用于验证最终变体会被发布前审计确定性地阻止并且绝不会漏掉",
        bodyMarkdown: `${payload().bodyMarkdown}\n\n我们保证签证包过。`,
      }),
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["claims.prohibited_guarantee", "platform.title.too_long"]),
    );
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

  it("changes the audit binding when the final platform payload changes", () => {
    const first = run();
    const changed = run(payload({ summary: `${payload().summary} 请以最新页面为准。` }));

    expect(first.payloadHash).not.toBe(changed.payloadHash);
    expect(first.auditHash).not.toBe(changed.auditHash);
  });
});
