import { describe, expect, it } from "vitest";

import {
  buildBaselineAuditPolicyDocument,
  compileAuditPolicy,
  GEO_AUDIT_POLICY_SCHEMA_VERSION,
  geoAuditPolicyDocumentSchema,
  type GeoAuditPolicyDocument,
} from "./audit-policy-document.js";
import { sha256Canonical } from "./canonical.js";
import { CoreInvariantError } from "./errors.js";

function baseline(): GeoAuditPolicyDocument {
  return buildBaselineAuditPolicyDocument({
    rulesVersion: "travel-rules-v1",
    industry: "travel",
  });
}

function compileDocument(document: unknown, version = "travel-rules-v1") {
  return compileAuditPolicy({
    version,
    policyHash: sha256Canonical(document),
    document,
  });
}

describe("GEO audit policy documents", () => {
  it("builds a deeply frozen, schema-valid baseline with exactly the supported platforms", () => {
    const document = baseline();

    expect(document.schemaVersion).toBe(GEO_AUDIT_POLICY_SCHEMA_VERSION);
    expect(geoAuditPolicyDocumentSchema.parse(document)).toEqual(document);
    expect(Object.keys(document.contentTemplates).sort()).toEqual([
      "body",
      "summary",
      "tag",
      "title",
    ]);
    for (const templates of Object.values(document.contentTemplates)) {
      expect(Object.keys(templates).length).toBeGreaterThan(0);
    }
    expect(document.contentTemplates.title["generic.title.verified-service"]).toBe(
      "当前服务信息核验指南",
    );
    expect(Object.keys(document.audit).sort()).toEqual([
      "artifactTtlMs",
      "duplicateThreshold",
      "maxEvidenceAgeMs",
      "media",
      "minClaims",
      "minDuplicateCharacters",
      "platformLimits",
      "prohibitedGuarantees",
    ]);
    expect(Object.keys(document.audit.platformLimits).sort()).toEqual([
      "ctrip_community",
      "sohu",
      "toutiao",
    ]);
    expect(document.audit.prohibitedGuarantees).toEqual([
      "\u767e\u5206\u767e",
      "100%\u4fdd\u8bc1",
      "\u7edd\u5bf9\u4fdd\u8bc1",
      "\u96f6\u98ce\u9669",
    ]);
    expect(document.audit.prohibitedGuarantees).not.toContain("\u4fdd\u8bc1\u7b7e\u8bc1");
    expect(document.audit.prohibitedGuarantees).not.toContain("\u5305\u8fc7");
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.audit)).toBe(true);
    expect(Object.isFrozen(document.audit.platformLimits.toutiao)).toBe(true);
    expect(Object.isFrozen(document.audit.prohibitedGuarantees)).toBe(true);
    expect(Object.isFrozen(document.contentTemplates)).toBe(true);
    expect(Object.isFrozen(document.contentTemplates.body)).toBe(true);
  });

  it("compiles a canonical-hash-bound document into a deeply frozen AuditPolicy", () => {
    const document = baseline();
    const policyHash = sha256Canonical(document);

    const policy = compileAuditPolicy({
      version: document.rulesVersion,
      policyHash,
      document,
    });

    expect(policy).toMatchObject({
      version: "travel-rules-v1",
      sourceHash: policyHash,
      artifactTtlMs: document.audit.artifactTtlMs,
      media: document.audit.media,
      platformLimits: document.audit.platformLimits,
      contentTemplates: document.contentTemplates,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.platformLimits)).toBe(true);
    expect(Object.isFrozen(policy.platformLimits.sohu)).toBe(true);
    expect(Object.isFrozen(policy.prohibitedGuarantees)).toBe(true);
    expect(Object.isFrozen(policy.media)).toBe(true);
    expect(Object.isFrozen(policy.media.evaluatorAllowlist)).toBe(true);
    expect(Object.isFrozen(policy.media.renditions.toutiao.allowedMimeTypes)).toBe(true);
    expect(Object.isFrozen(policy.contentTemplates)).toBe(true);
    expect(Object.isFrozen(policy.contentTemplates.tag)).toBe(true);
  });

  it("fails closed when the supplied hash does not bind the exact document", () => {
    const document = baseline();

    expect(() =>
      compileAuditPolicy({
        version: document.rulesVersion,
        policyHash: "0".repeat(64),
        document,
      }),
    ).toThrowError(CoreInvariantError);
    expect(() =>
      compileAuditPolicy({
        version: document.rulesVersion,
        policyHash: "0".repeat(64),
        document,
      }),
    ).toThrowError(expect.objectContaining({ code: "AUDIT_POLICY_HASH_MISMATCH" }));
  });

  it("fails closed on unknown fields at every object layer", () => {
    const document = baseline();
    const extraPlatformLimitField = {
      ...document,
      audit: {
        ...document.audit,
        platformLimits: {
          ...document.audit.platformLimits,
          toutiao: {
            ...document.audit.platformLimits.toutiao,
            unknownLimit: 1,
          },
        },
      },
    };
    const candidates: unknown[] = [
      { ...document, unknownRoot: true },
      { ...document, audit: { ...document.audit, unknownAudit: true } },
      {
        ...document,
        audit: {
          ...document.audit,
          media: { ...document.audit.media, unknownMediaRule: true },
        },
      },
      {
        ...document,
        audit: {
          ...document.audit,
          platformLimits: { ...document.audit.platformLimits, unknownPlatform: {} },
        },
      },
      extraPlatformLimitField,
      { ...document, contentTemplates: { ...document.contentTemplates, link: {} } },
    ];

    for (const candidate of candidates) {
      expect(() => compileDocument(candidate)).toThrowError(CoreInvariantError);
      expect(() => compileDocument(candidate)).toThrowError(
        expect.objectContaining({ code: "AUDIT_POLICY_DOCUMENT_INVALID" }),
      );
    }
  });

  it("rejects empty template categories, invalid IDs, blank values, and padded values", () => {
    const document = baseline();
    const candidates: unknown[] = [
      {
        ...document,
        contentTemplates: { ...document.contentTemplates, title: {} },
      },
      {
        ...document,
        contentTemplates: {
          ...document.contentTemplates,
          summary: { "Not A Template ID": "固定摘要" },
        },
      },
      {
        ...document,
        contentTemplates: {
          ...document.contentTemplates,
          body: { "generic.body.blank": "" },
        },
      },
      {
        ...document,
        contentTemplates: {
          ...document.contentTemplates,
          tag: { "generic.tag.padded": " 前后有空格 " },
        },
      },
    ];

    for (const candidate of candidates) {
      expect(() => compileDocument(candidate)).toThrowError(
        expect.objectContaining({ code: "AUDIT_POLICY_DOCUMENT_INVALID" }),
      );
    }
  });

  it("fails closed on unknown schema versions, incomplete platforms, and invalid limits", () => {
    const document = baseline();
    const incompletePlatformLimits = {
      toutiao: document.audit.platformLimits.toutiao,
      ctrip_community: document.audit.platformLimits.ctrip_community,
    };
    const candidates: unknown[] = [
      { ...document, schemaVersion: "geo.audit-policy.v3" },
      {
        ...document,
        audit: { ...document.audit, platformLimits: incompletePlatformLimits },
      },
      { ...document, audit: { ...document.audit, duplicateThreshold: 0 } },
      {
        ...document,
        audit: {
          ...document.audit,
          media: { ...document.audit.media, evaluatorAllowlist: [] },
        },
      },
      {
        ...document,
        audit: {
          ...document.audit,
          platformLimits: {
            ...document.audit.platformLimits,
            sohu: {
              ...document.audit.platformLimits.sohu,
              minBodyCharacters: 501,
              maxBodyCharacters: 500,
            },
          },
        },
      },
    ];

    for (const candidate of candidates) {
      expect(() => compileDocument(candidate)).toThrowError(
        expect.objectContaining({ code: "AUDIT_POLICY_DOCUMENT_INVALID" }),
      );
    }
  });

  it("fails closed when bundle version and document rules version diverge", () => {
    const document = baseline();

    expect(() => compileDocument(document, "travel-bundle-v2")).toThrowError(
      expect.objectContaining({ code: "AUDIT_POLICY_VERSION_MISMATCH" }),
    );
  });

  it("rejects unknown compiler input fields instead of silently stripping them", () => {
    const document = baseline();
    const input = {
      version: document.rulesVersion,
      policyHash: sha256Canonical(document),
      document,
      bypassAudit: true,
    };

    expect(() => compileAuditPolicy(input)).toThrowError(
      expect.objectContaining({ code: "AUDIT_POLICY_INPUT_INVALID" }),
    );
  });
});
