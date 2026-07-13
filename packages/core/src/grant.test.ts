import { describe, expect, it } from "vitest";

import type { PublicationVariantPayload, TenantContact } from "@geo/contracts";

import { auditPublicationVariant, type AuditPolicy, type FactSnapshot } from "./audit.js";
import { CoreInvariantError } from "./errors.js";
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
  sources: [
    {
      id: sourceId,
      locator: "https://example.test/source",
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
  platformLimits: { toutiao: limit, sohu: limit, ctrip_community: limit },
};

const publicationPayload: PublicationVariantPayload = {
  title: "Evidence first",
  summary: "A bounded and verifiable travel answer.",
  bodyMarkdown: "## Evidence\n\nUse the current itinerary. Hotline: 4001133986.",
  media: [],
  claims: [
    {
      id: "10000000-0000-4000-8000-000000000006",
      text: "Use the current itinerary",
      evidenceSourceIds: [sourceId],
      validUntil: null,
    },
  ],
  contactIds: [contactId],
  tags: [],
};

function passedAudit() {
  return auditPublicationVariant({
    artifactId: "10000000-0000-4000-8000-000000000007",
    tenantId,
    variantId,
    channelAccountId,
    platform: "toutiao",
    payload: publicationPayload,
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
});
