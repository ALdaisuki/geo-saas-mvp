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

const deprecatedKeywordRules = {
  prohibitedGuarantees: ["百分百", "包过"],
  hardBlockRules: {
    schemaVersion: "geo.audit-hard-block-rules.v1",
    matchMode: "nfkc_casefold_contains_v1",
    categories: { illegal_goods: ["测试禁售品"] },
  },
  qualificationClaimRules: {
    schemaVersion: "geo.audit-qualification-claim-rules.v1",
    matchMode: "nfkc_casefold_contains_v1",
    terms: ["5A级旅行社"],
  },
} as const;

function legacyThreePlatformDocument(document: GeoAuditPolicyDocument): unknown {
  const keepLegacyPlatforms = (platforms: object) =>
    Object.fromEntries(
      Object.entries(platforms).filter(
        ([platform]) =>
          platform !== "baijiahao" && platform !== "netease" && platform !== "zhihu",
      ),
    );
  return {
    ...document,
    editorialProfiles: Object.fromEntries(
      Object.entries(document.editorialProfiles).map(([profileKey, profile]) => [
        profileKey,
        { ...profile, platforms: keepLegacyPlatforms(profile.platforms) },
      ]),
    ),
    platformEditorialStyles: keepLegacyPlatforms(document.platformEditorialStyles),
    audit: {
      ...document.audit,
      ...deprecatedKeywordRules,
      media: {
        ...document.audit.media,
        renditions: keepLegacyPlatforms(document.audit.media.renditions),
      },
      platformLimits: keepLegacyPlatforms(document.audit.platformLimits),
    },
  };
}

function legacyFivePlatformDocument(document: GeoAuditPolicyDocument): unknown {
  return {
    ...document,
    audit: { ...document.audit, ...deprecatedKeywordRules },
  };
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
    ]);
    expect(Object.keys(document.audit.platformLimits).sort()).toEqual([
      "baijiahao",
      "ctrip_community",
      "netease",
      "sohu",
      "toutiao",
      "zhihu",
    ]);
    expect(document.audit).not.toHaveProperty("prohibitedGuarantees");
    expect(document.audit).not.toHaveProperty("hardBlockRules");
    expect(document.audit).not.toHaveProperty("qualificationClaimRules");
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.audit)).toBe(true);
    expect(Object.isFrozen(document.audit.platformLimits.toutiao)).toBe(true);
    expect(Object.isFrozen(document.audit.platformLimits.baijiahao)).toBe(true);
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
      effectiveHash: policyHash,
      artifactTtlMs: document.audit.artifactTtlMs,
      media: document.audit.media,
      platformLimits: document.audit.platformLimits,
      contentTemplates: document.contentTemplates,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.platformLimits)).toBe(true);
    expect(Object.isFrozen(policy.platformLimits.sohu)).toBe(true);
    expect(Object.isFrozen(policy.platformLimits.baijiahao)).toBe(true);
    expect(policy).not.toHaveProperty("prohibitedGuarantees");
    expect(policy).not.toHaveProperty("hardBlockRules");
    expect(policy).not.toHaveProperty("qualificationClaimRules");
    expect(Object.isFrozen(policy.media)).toBe(true);
    expect(Object.isFrozen(policy.media.evaluatorAllowlist)).toBe(true);
    expect(Object.isFrozen(policy.media.renditions.toutiao.allowedMimeTypes)).toBe(true);
    expect(Object.isFrozen(policy.media.renditions.netease.allowedMimeTypes)).toBe(true);
    expect(Object.isFrozen(policy.contentTemplates)).toBe(true);
    expect(Object.isFrozen(policy.contentTemplates.tag)).toBe(true);
  });

  it("strips deprecated keyword rules from a hash-bound five-platform document", () => {
    const legacyDocument = legacyFivePlatformDocument(baseline());
    const legacyHash = sha256Canonical(legacyDocument);

    const policy = compileAuditPolicy({
      version: "travel-rules-v1",
      policyHash: legacyHash,
      document: legacyDocument,
    });

    expect(policy.sourceHash).toBe(legacyHash);
    expect(policy.effectiveHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(policy.effectiveHash).not.toBe(legacyHash);
    expect(policy).not.toHaveProperty("prohibitedGuarantees");
    expect(policy).not.toHaveProperty("hardBlockRules");
    expect(policy).not.toHaveProperty("qualificationClaimRules");
  });

  it("ignores deprecated keyword field contents instead of compiling them into runtime policy", () => {
    const current = baseline();
    const legacyDocument = {
      ...current,
      audit: {
        ...current.audit,
        prohibitedGuarantees: "legacy-value-with-invalid-shape",
        hardBlockRules: { any: "legacy shape is ignored" },
        qualificationClaimRules: null,
      },
    };
    const policy = compileAuditPolicy({
      version: current.rulesVersion,
      policyHash: sha256Canonical(legacyDocument),
      document: legacyDocument,
    });

    expect(policy).not.toHaveProperty("prohibitedGuarantees");
    expect(policy).not.toHaveProperty("hardBlockRules");
    expect(policy).not.toHaveProperty("qualificationClaimRules");
    expect(policy.effectiveHash).not.toBe(sha256Canonical(legacyDocument));
  });

  it("compiles a hash-bound legacy v2 document and fills the added long-form platforms", () => {
    const legacyDocument = legacyThreePlatformDocument(baseline());
    const legacyHash = sha256Canonical(legacyDocument);

    const policy = compileAuditPolicy({
      version: "travel-rules-v1",
      policyHash: legacyHash,
      document: legacyDocument,
    });

    expect(policy.sourceHash).toBe(legacyHash);
    expect(policy.effectiveHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(policy.effectiveHash).not.toBe(legacyHash);
    expect(policy).not.toHaveProperty("prohibitedGuarantees");
    expect(policy).not.toHaveProperty("hardBlockRules");
    expect(policy).not.toHaveProperty("qualificationClaimRules");
    expect(policy.platformLimits.baijiahao).toEqual(policy.platformLimits.sohu);
    expect(policy.platformLimits.netease).toEqual(policy.platformLimits.sohu);
    expect(policy.media.renditions.baijiahao).toEqual(policy.media.renditions.sohu);
    expect(policy.media.renditions.netease).toEqual(policy.media.renditions.sohu);
    expect(policy.platformEditorialStyles?.baijiahao).toEqual(policy.platformEditorialStyles?.sohu);
    expect(policy.platformEditorialStyles?.netease).toEqual(policy.platformEditorialStyles?.sohu);
    expect(policy.editorialProfiles?.guide.platforms.baijiahao).toEqual(
      policy.editorialProfiles?.guide.platforms.sohu,
    );
    expect(policy.editorialProfiles?.guide.platforms.netease).toEqual(
      policy.editorialProfiles?.guide.platforms.sohu,
    );
  });

  it("strips deprecated keyword rules while expanding a three-platform document", () => {
    const legacyDocument = legacyThreePlatformDocument(baseline());
    const policy = compileDocument(legacyDocument);

    expect(policy).not.toHaveProperty("prohibitedGuarantees");
    expect(policy).not.toHaveProperty("hardBlockRules");
    expect(policy).not.toHaveProperty("qualificationClaimRules");
    expect(policy.platformLimits.baijiahao).toEqual(policy.platformLimits.sohu);
    expect(policy.platformLimits.netease).toEqual(policy.platformLimits.sohu);
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
      {
        ...document,
        audit: {
          ...document.audit,
          platformLimits: {
            ...document.audit.platformLimits,
            netease: {
              ...document.audit.platformLimits.netease,
              maxTags: -1,
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
