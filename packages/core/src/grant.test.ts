import { describe, expect, it } from "vitest";

import type { MediaReference, PublicationVariantPayload, TenantContact } from "@geo/contracts";

import {
  auditPublicationVariant,
  DEFAULT_AUDIT_POLICY,
  type AuditPolicy,
  type FactSnapshot,
  verifyAuditArtifactIntegrity,
} from "./audit.js";
import { sha256Canonical, sha256Text } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { CoreInvariantError } from "./errors.js";
import { buildVisualBrief, mediaSnapshotHash } from "./media-production.js";
import {
  consumePublicationGrant,
  issuePublicationGrant,
  validatePublicationGrant,
} from "./grant.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const variantId = "10000000-0000-4000-8000-000000000002";
const channelAccountId = "10000000-0000-4000-8000-000000000003";
const contactId = "10000000-0000-4000-8000-000000000004";
const sourceId = "10000000-0000-4000-8000-000000000005";
const factId = "10000000-0000-4000-8000-000000000006";
const brandId = "10000000-0000-4000-8000-000000000009";
const token = "test-only-publication-token-with-at-least-32-bytes";

const contact: TenantContact = {
  id: contactId,
  tenantId,
  type: "phone",
  label: "hotline",
  value: "4001133986",
  isPrimary: true,
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: null,
};

const snapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-13T11:00:00.000Z",
  facts: [
    {
      id: factId,
      brandId,
      text: "Use the current itinerary",
      evidenceSourceIds: [sourceId],
      validFrom: "2026-07-13T09:00:00.000Z",
      validUntil: null,
    },
  ],
  sources: [
    {
      id: sourceId,
      locator: "https://example.test/source",
      contentHash: "b".repeat(64),
      observedAt: "2026-07-13T10:00:00.000Z",
      validUntil: null,
    },
  ],
};

const limit = {
  maxTitleCharacters: 100,
  maxSummaryCharacters: 200,
  minBodyCharacters: 20,
  maxBodyCharacters: 10_000,
  maxTags: 10,
  minHeadings: 1,
};

const policy: AuditPolicy = {
  version: "grant-test-v1",
  artifactTtlMs: 10 * 60 * 1_000,
  maxEvidenceAgeMs: 24 * 60 * 60 * 1_000,
  minClaims: 1,
  duplicateThreshold: 0.9,
  minDuplicateCharacters: 20,
  prohibitedGuarantees: ["包过"],
  contentTemplates: DEFAULT_AUDIT_POLICY.contentTemplates,
  media: DEFAULT_AUDIT_POLICY.media,
  platformLimits: { toutiao: limit, sohu: limit, ctrip_community: limit },
};

const publicationPayloadInput: PublicationVariantPayload = {
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
    { type: "contact", contactId, presentation: "paragraph" },
    { type: "template", templateId: "generic.body.guidance.contact" },
  ],
  tagTemplateIds: [],
  media: [],
  claims: [
    {
      id: factId,
      text: "Use the current itinerary",
      evidenceSourceIds: [sourceId],
      validUntil: null,
    },
  ],
  contactIds: [contactId],
  tags: [],
};
const renderedPublicationPayload = renderCanonicalContent({
  payload: publicationPayloadInput,
  policy,
  factSnapshot: snapshot,
  contacts: [contact],
});
if (
  renderedPublicationPayload.title === null ||
  renderedPublicationPayload.summary === null ||
  renderedPublicationPayload.bodyMarkdown === null ||
  renderedPublicationPayload.tags === null
) {
  throw new Error("Canonical grant fixture did not render");
}
const publicationPayload: PublicationVariantPayload = {
  ...publicationPayloadInput,
  title: renderedPublicationPayload.title,
  summary: renderedPublicationPayload.summary,
  bodyMarkdown: renderedPublicationPayload.bodyMarkdown,
  tags: [...renderedPublicationPayload.tags],
};

function mediaReference(): MediaReference {
  const visualBrief = buildVisualBrief({
    editorialProfile: "guide",
    platform: "toutiao",
    role: "cover",
    facts: snapshot.facts,
  });
  const sha256 = "c".repeat(64);
  return {
    id: "10000000-0000-4000-8000-000000000010",
    sha256,
    mimeType: "image/png",
    byteLength: 256,
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
      jobId: "10000000-0000-4000-8000-000000000011",
      attemptId: "10000000-0000-4000-8000-000000000012",
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
  };
}

function passedAudit(payload: PublicationVariantPayload = publicationPayload) {
  return auditPublicationVariant({
    artifactId: "10000000-0000-4000-8000-000000000007",
    tenantId,
    brandSnapshot: {
      id: brandId,
      canonicalName: "zhongtong-international-travel",
      displayName: "Zhongtong International Travel Agency",
      aliases: ["Zhongtong Travel"],
    },
    variantId,
    channelAccountId,
    platform: "toutiao",
    payload,
    contacts: [contact],
    factSnapshot: snapshot,
    policy,
    priorVariants: [],
    createdAt: "2026-07-13T12:00:00.000Z",
  });
}

function binding(audit = passedAudit()) {
  return {
    tenantId,
    variantId,
    channelAccountId,
    platform: "toutiao" as const,
    payloadHash: audit.payloadHash,
    auditHash: audit.auditHash,
  };
}

describe("one-time publication grants", () => {
  it("issues, validates, and consumes a grant exactly once", () => {
    const audit = passedAudit();
    const grant = issuePublicationGrant({
      grantId: "10000000-0000-4000-8000-000000000008",
      auditArtifact: audit,
      token,
      issuedAt: "2026-07-13T12:01:00.000Z",
    });

    expect(
      validatePublicationGrant({
        grant,
        token,
        now: "2026-07-13T12:02:00.000Z",
        binding: binding(audit),
      }),
    ).toBe(true);

    const consumed = consumePublicationGrant({
      grant,
      token,
      consumedAt: "2026-07-13T12:02:00.000Z",
      binding: binding(audit),
    });

    expect(consumed.status).toBe("consumed");
    expect(consumed.consumedAt).toBe("2026-07-13T12:02:00.000Z");
    expect(Object.isFrozen(consumed)).toBe(true);

    expect(() =>
      consumePublicationGrant({
        grant: consumed,
        token,
        consumedAt: "2026-07-13T12:03:00.000Z",
        binding: binding(audit),
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_NOT_ISSUED" }));
  });

  it("rejects token mismatch, expiry, and any changed binding", () => {
    const audit = passedAudit();
    const grant = issuePublicationGrant({
      grantId: "10000000-0000-4000-8000-000000000008",
      auditArtifact: audit,
      token,
      issuedAt: "2026-07-13T12:01:00.000Z",
    });

    expect(() =>
      validatePublicationGrant({
        grant,
        token: `${token}-wrong`,
        now: "2026-07-13T12:02:00.000Z",
        binding: binding(audit),
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_TOKEN_MISMATCH" }));

    expect(() =>
      validatePublicationGrant({
        grant,
        token,
        now: audit.expiresAt,
        binding: binding(audit),
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_EXPIRED" }));

    expect(() =>
      validatePublicationGrant({
        grant,
        token,
        now: "2026-07-13T12:02:00.000Z",
        binding: { ...binding(audit), payloadHash: "f".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_BINDING_MISMATCH" }));
  });

  it("does not issue from failed, expired, or tampered audit artifacts", () => {
    const audit = passedAudit();

    expect(() =>
      issuePublicationGrant({
        grantId: "10000000-0000-4000-8000-000000000008",
        auditArtifact: { ...audit, status: "failed" },
        token,
        issuedAt: "2026-07-13T12:01:00.000Z",
      }),
    ).toThrow(CoreInvariantError);

    expect(() =>
      issuePublicationGrant({
        grantId: "10000000-0000-4000-8000-000000000008",
        auditArtifact: audit,
        token,
        issuedAt: audit.expiresAt,
      }),
    ).toThrowError(expect.objectContaining({ code: "AUDIT_EXPIRED" }));

    expect(() =>
      issuePublicationGrant({
        grantId: "10000000-0000-4000-8000-000000000008",
        auditArtifact: { ...audit, payloadHash: "e".repeat(64) },
        token,
        issuedAt: "2026-07-13T12:01:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "AUDIT_INTEGRITY_FAILED" }));
  });

  it("cannot reuse an old audit or grant after media bytes change", () => {
    const media = mediaReference();
    const mediaPayload: PublicationVariantPayload = {
      ...publicationPayload,
      editorialProfile: "guide",
      media: [media],
    };
    const audit = passedAudit(mediaPayload);
    const grant = issuePublicationGrant({
      grantId: "10000000-0000-4000-8000-000000000013",
      auditArtifact: audit,
      token,
      issuedAt: "2026-07-13T12:01:00.000Z",
    });
    const changedSha = "f".repeat(64);
    const changedMedia = {
      ...media,
      sha256: changedSha,
      inspection: { ...media.inspection, assetSha256: changedSha },
    };
    const changedPayload = { ...mediaPayload, media: [changedMedia] };

    expect(mediaSnapshotHash([changedMedia])).not.toBe(audit.mediaSnapshotHash);
    expect(
      verifyAuditArtifactIntegrity({
        ...audit,
        mediaSnapshotHash: mediaSnapshotHash([changedMedia]),
      }),
    ).toBe(false);
    expect(() =>
      validatePublicationGrant({
        grant,
        token,
        now: "2026-07-13T12:02:00.000Z",
        binding: { ...binding(audit), payloadHash: sha256Canonical(changedPayload) },
      }),
    ).toThrowError(expect.objectContaining({ code: "GRANT_BINDING_MISMATCH" }));
  });
});
