import { z } from "zod";

import { DEFAULT_AUDIT_POLICY, type AuditPolicy } from "./audit.js";
import { registerCompiledAuditPolicy } from "./audit-policy-provenance.js";
import { sha256Canonical } from "./canonical.js";
import { CoreInvariantError, invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export const GEO_AUDIT_POLICY_SCHEMA_VERSION = "geo.audit-policy.v2" as const;
export const GEO_AUDIT_POLICY_EFFECTIVE_HASH_SCHEMA_VERSION =
  "geo.audit-policy-effective.v2" as const;

const nonBlankIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim() === value, "Value must not have surrounding whitespace");
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const templateIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

function fixedTemplateSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, "Template must not have surrounding whitespace")
    .refine((value) => !value.includes("\r"), "Template must use LF line endings");
}

function nonEmptyTemplateMapSchema(maxLength: number) {
  return z
    .record(templateIdSchema, fixedTemplateSchema(maxLength))
    .refine((value) => Object.keys(value).length > 0, "Template category must not be empty");
}

export const contentTemplatesSchema = z.strictObject({
  title: nonEmptyTemplateMapSchema(200),
  summary: nonEmptyTemplateMapSchema(500),
  body: nonEmptyTemplateMapSchema(20_000),
  tag: nonEmptyTemplateMapSchema(50),
});

const presentationSchema = z.enum(["paragraph", "bullet"]);
const sourceBodySlotSchema = z.enum([
  "profile_opening",
  "claims",
  "profile_details",
  "profile_action",
  "contacts",
  "profile_closing",
]);
const platformBodySlotSchema = z.enum([
  ...sourceBodySlotSchema.options,
  "platform_opening",
  "platform_scope",
  "platform_contact",
  "platform_disclosure",
]);

function completeBodyOrder<T extends z.ZodEnum>(slotSchema: T, length: number) {
  return z
    .array(slotSchema)
    .length(length)
    .refine((slots) => new Set(slots).size === length, "Body order must contain every slot once");
}

const editorialSourceProfileSchema = z.strictObject({
  titleTemplateId: templateIdSchema,
  summaryTemplateId: templateIdSchema,
  bodyTemplateIds: z.strictObject({
    opening: templateIdSchema,
    details: templateIdSchema,
    action: templateIdSchema,
    closing: templateIdSchema,
  }),
  bodyOrder: completeBodyOrder(sourceBodySlotSchema, sourceBodySlotSchema.options.length),
  claimPresentation: presentationSchema,
  contactPresentation: presentationSchema,
  tagTemplateIds: z.array(templateIdSchema).min(1).max(5),
});

const editorialPlatformProfileSchema = z.strictObject({
  titleTemplateId: templateIdSchema,
  summaryTemplateId: templateIdSchema,
  bodyOrder: completeBodyOrder(platformBodySlotSchema, platformBodySlotSchema.options.length),
  claimPresentation: presentationSchema,
  contactPresentation: presentationSchema,
});

const editorialProfilePolicySchema = z.strictObject({
  source: editorialSourceProfileSchema,
  platforms: z.strictObject({
    toutiao: editorialPlatformProfileSchema,
    sohu: editorialPlatformProfileSchema,
    baijiahao: editorialPlatformProfileSchema,
    netease: editorialPlatformProfileSchema,
    ctrip_community: editorialPlatformProfileSchema,
    zhihu: editorialPlatformProfileSchema,
  }),
});

export const editorialProfilesSchema = z.strictObject({
  guide: editorialProfilePolicySchema,
  question_answer: editorialProfilePolicySchema,
  comparison: editorialProfilePolicySchema,
  risk_avoidance: editorialProfilePolicySchema,
  local_service: editorialProfilePolicySchema,
});

const platformEditorialStyleSchema = z.strictObject({
  bodyTemplateIds: z.strictObject({
    opening: templateIdSchema,
    scope: templateIdSchema,
    contact: templateIdSchema,
    disclosure: templateIdSchema,
  }),
  tagTemplateIds: z.array(templateIdSchema).min(1).max(5),
});

export const platformEditorialStylesSchema = z.strictObject({
  toutiao: platformEditorialStyleSchema,
  sohu: platformEditorialStyleSchema,
  baijiahao: platformEditorialStyleSchema,
  netease: platformEditorialStyleSchema,
  ctrip_community: platformEditorialStyleSchema,
  zhihu: platformEditorialStyleSchema,
});

export const platformAuditLimitsSchema = z
  .strictObject({
    maxTitleCharacters: nonNegativeSafeIntegerSchema,
    maxSummaryCharacters: nonNegativeSafeIntegerSchema,
    minBodyCharacters: nonNegativeSafeIntegerSchema,
    maxBodyCharacters: nonNegativeSafeIntegerSchema,
    maxTags: nonNegativeSafeIntegerSchema,
    minHeadings: nonNegativeSafeIntegerSchema,
  })
  .refine((limits) => limits.maxBodyCharacters >= limits.minBodyCharacters, {
    message: "maxBodyCharacters must be at least minBodyCharacters",
    path: ["maxBodyCharacters"],
  });

const platformMediaRenditionPolicySchema = z
  .strictObject({
    allowedMimeTypes: z
      .array(z.string().regex(/^image\/[a-z0-9.+-]+$/u))
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length, "MIME types must be unique"),
    aspectRatios: z
      .array(z.enum(["1:1", "4:3", "16:9"]))
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, "Aspect ratios must be unique"),
    minWidth: positiveSafeIntegerSchema,
    minHeight: positiveSafeIntegerSchema,
    maxWidth: positiveSafeIntegerSchema,
    maxHeight: positiveSafeIntegerSchema,
  })
  .refine((value) => value.maxWidth >= value.minWidth && value.maxHeight >= value.minHeight, {
    message: "Maximum media dimensions must cover minimum dimensions",
  });

const mediaInspectionEvaluatorPolicySchema = z.strictObject({
  evaluator: nonBlankIdentifierSchema,
  evaluatorMode: z.enum(["fixture", "live"]),
  evaluatorVersion: nonBlankIdentifierSchema,
});

export const mediaAuditPolicySchema = z.strictObject({
  inspectionRequired: z.literal(true),
  evaluatorAllowlist: z
    .array(mediaInspectionEvaluatorPolicySchema)
    .min(1)
    .max(50)
    .refine(
      (values) =>
        new Set(
          values.map(
            (value) =>
              `${value.evaluator}\u0000${value.evaluatorMode}\u0000${value.evaluatorVersion}`,
          ),
        ).size === values.length,
      "Inspection evaluator entries must be unique",
    ),
  renditions: z.strictObject({
    toutiao: platformMediaRenditionPolicySchema,
    sohu: platformMediaRenditionPolicySchema,
    baijiahao: platformMediaRenditionPolicySchema,
    netease: platformMediaRenditionPolicySchema,
    ctrip_community: platformMediaRenditionPolicySchema,
    zhihu: platformMediaRenditionPolicySchema,
  }),
});

export const auditPolicyRulesSchema = z.strictObject({
  artifactTtlMs: positiveSafeIntegerSchema,
  maxEvidenceAgeMs: positiveSafeIntegerSchema,
  minClaims: nonNegativeSafeIntegerSchema,
  duplicateThreshold: z.number().gt(0).max(1),
  minDuplicateCharacters: nonNegativeSafeIntegerSchema,
  media: mediaAuditPolicySchema,
  platformLimits: z.strictObject({
    toutiao: platformAuditLimitsSchema,
    sohu: platformAuditLimitsSchema,
    baijiahao: platformAuditLimitsSchema,
    netease: platformAuditLimitsSchema,
    ctrip_community: platformAuditLimitsSchema,
    zhihu: platformAuditLimitsSchema,
  }),
});

export const geoAuditPolicyDocumentSchema = z.strictObject({
  schemaVersion: z.literal(GEO_AUDIT_POLICY_SCHEMA_VERSION),
  rulesVersion: nonBlankIdentifierSchema,
  industry: nonBlankIdentifierSchema,
  contentTemplates: contentTemplatesSchema,
  editorialProfiles: editorialProfilesSchema,
  platformEditorialStyles: platformEditorialStylesSchema,
  audit: auditPolicyRulesSchema,
});

const legacyEditorialProfilePolicySchema = z.strictObject({
  source: editorialSourceProfileSchema,
  platforms: z.strictObject({
    toutiao: editorialPlatformProfileSchema,
    sohu: editorialPlatformProfileSchema,
    ctrip_community: editorialPlatformProfileSchema,
  }),
});

const legacyEditorialProfilesSchema = z.strictObject({
  guide: legacyEditorialProfilePolicySchema,
  question_answer: legacyEditorialProfilePolicySchema,
  comparison: legacyEditorialProfilePolicySchema,
  risk_avoidance: legacyEditorialProfilePolicySchema,
  local_service: legacyEditorialProfilePolicySchema,
});

const legacyPlatformEditorialStylesSchema = z.strictObject({
  toutiao: platformEditorialStyleSchema,
  sohu: platformEditorialStyleSchema,
  ctrip_community: platformEditorialStyleSchema,
});

const legacyMediaAuditPolicySchema = z.strictObject({
  inspectionRequired: z.literal(true),
  evaluatorAllowlist: mediaAuditPolicySchema.shape.evaluatorAllowlist,
  renditions: z.strictObject({
    toutiao: platformMediaRenditionPolicySchema,
    sohu: platformMediaRenditionPolicySchema,
    ctrip_community: platformMediaRenditionPolicySchema,
  }),
});

const deprecatedKeywordRuleFields = {
  prohibitedGuarantees: z.unknown().optional(),
  hardBlockRules: z.unknown().optional(),
  qualificationClaimRules: z.unknown().optional(),
} as const;

const legacyAuditPolicyRulesSchema = z.strictObject({
  artifactTtlMs: positiveSafeIntegerSchema,
  maxEvidenceAgeMs: positiveSafeIntegerSchema,
  minClaims: nonNegativeSafeIntegerSchema,
  duplicateThreshold: z.number().gt(0).max(1),
  minDuplicateCharacters: nonNegativeSafeIntegerSchema,
  ...deprecatedKeywordRuleFields,
  media: legacyMediaAuditPolicySchema,
  platformLimits: z.strictObject({
    toutiao: platformAuditLimitsSchema,
    sohu: platformAuditLimitsSchema,
    ctrip_community: platformAuditLimitsSchema,
  }),
});

const legacyFivePlatformAuditPolicyRulesSchema = auditPolicyRulesSchema
  .extend({
    ...deprecatedKeywordRuleFields,
  })
  .refine(
    (audit) =>
      Object.keys(deprecatedKeywordRuleFields).some((field) =>
        Object.prototype.hasOwnProperty.call(audit, field),
      ),
    "Legacy five-platform policies must contain a deprecated keyword field",
  );

const legacyFivePlatformGeoAuditPolicyDocumentSchema = z.strictObject({
  schemaVersion: z.literal(GEO_AUDIT_POLICY_SCHEMA_VERSION),
  rulesVersion: nonBlankIdentifierSchema,
  industry: nonBlankIdentifierSchema,
  contentTemplates: contentTemplatesSchema,
  editorialProfiles: editorialProfilesSchema,
  platformEditorialStyles: platformEditorialStylesSchema,
  audit: legacyFivePlatformAuditPolicyRulesSchema,
});

const legacyGeoAuditPolicyDocumentSchema = z.strictObject({
  schemaVersion: z.literal(GEO_AUDIT_POLICY_SCHEMA_VERSION),
  rulesVersion: nonBlankIdentifierSchema,
  industry: nonBlankIdentifierSchema,
  contentTemplates: contentTemplatesSchema,
  editorialProfiles: legacyEditorialProfilesSchema,
  platformEditorialStyles: legacyPlatformEditorialStylesSchema,
  audit: legacyAuditPolicyRulesSchema,
});

export type GeoAuditPolicyDocument = z.infer<typeof geoAuditPolicyDocumentSchema>;
type LegacyGeoAuditPolicyDocument = z.infer<typeof legacyGeoAuditPolicyDocumentSchema>;
type LegacyFivePlatformGeoAuditPolicyDocument = z.infer<
  typeof legacyFivePlatformGeoAuditPolicyDocumentSchema
>;

interface ParsedAuditPolicyDocument {
  readonly document: GeoAuditPolicyDocument;
  readonly compatibilityExpanded: boolean;
}

export interface BuildBaselineAuditPolicyDocumentInput {
  readonly rulesVersion: string;
  readonly industry: string;
}

export interface CompileAuditPolicyInput {
  readonly version: string;
  readonly policyHash: string;
  readonly document: unknown;
}

const baselineInputSchema = z.strictObject({
  rulesVersion: nonBlankIdentifierSchema,
  industry: nonBlankIdentifierSchema,
});

const compileInputSchema = z.strictObject({
  version: nonBlankIdentifierSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  document: z.unknown(),
});

function invalidInput(code: string, message: string, error: z.ZodError): never {
  throw new CoreInvariantError(code, message, {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

function copyPlatformLimits() {
  return {
    toutiao: { ...DEFAULT_AUDIT_POLICY.platformLimits.toutiao },
    sohu: { ...DEFAULT_AUDIT_POLICY.platformLimits.sohu },
    baijiahao: { ...DEFAULT_AUDIT_POLICY.platformLimits.baijiahao },
    netease: { ...DEFAULT_AUDIT_POLICY.platformLimits.netease },
    ctrip_community: { ...DEFAULT_AUDIT_POLICY.platformLimits.ctrip_community },
    zhihu: { ...DEFAULT_AUDIT_POLICY.platformLimits.zhihu },
  };
}

function copyMediaPolicy() {
  return {
    inspectionRequired: DEFAULT_AUDIT_POLICY.media.inspectionRequired,
    evaluatorAllowlist: DEFAULT_AUDIT_POLICY.media.evaluatorAllowlist.map((entry) => ({
      ...entry,
    })),
    renditions: {
      toutiao: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.toutiao,
        allowedMimeTypes: [...DEFAULT_AUDIT_POLICY.media.renditions.toutiao.allowedMimeTypes],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.toutiao.aspectRatios],
      },
      sohu: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.sohu,
        allowedMimeTypes: [...DEFAULT_AUDIT_POLICY.media.renditions.sohu.allowedMimeTypes],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.sohu.aspectRatios],
      },
      baijiahao: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.baijiahao,
        allowedMimeTypes: [...DEFAULT_AUDIT_POLICY.media.renditions.baijiahao.allowedMimeTypes],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.baijiahao.aspectRatios],
      },
      netease: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.netease,
        allowedMimeTypes: [...DEFAULT_AUDIT_POLICY.media.renditions.netease.allowedMimeTypes],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.netease.aspectRatios],
      },
      zhihu: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.zhihu,
        allowedMimeTypes: [...DEFAULT_AUDIT_POLICY.media.renditions.zhihu.allowedMimeTypes],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.zhihu.aspectRatios],
      },
      ctrip_community: {
        ...DEFAULT_AUDIT_POLICY.media.renditions.ctrip_community,
        allowedMimeTypes: [
          ...DEFAULT_AUDIT_POLICY.media.renditions.ctrip_community.allowedMimeTypes,
        ],
        aspectRatios: [...DEFAULT_AUDIT_POLICY.media.renditions.ctrip_community.aspectRatios],
      },
    },
  };
}

const DEPRECATED_KEYWORD_RULE_FIELD_NAMES = new Set([
  "prohibitedGuarantees",
  "hardBlockRules",
  "qualificationClaimRules",
]);

function stripDeprecatedKeywordRuleFields(audit: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(audit).filter(([field]) => !DEPRECATED_KEYWORD_RULE_FIELD_NAMES.has(field)),
  );
}

function expandLegacyFivePlatformAuditPolicyDocument(
  document: LegacyFivePlatformGeoAuditPolicyDocument,
): unknown {
  return {
    ...document,
    audit: stripDeprecatedKeywordRuleFields(document.audit),
  };
}

function expandLegacyEditorialProfile(
  profile: LegacyGeoAuditPolicyDocument["editorialProfiles"]["guide"],
) {
  return {
    ...profile,
    platforms: {
      ...profile.platforms,
      baijiahao: {
        ...profile.platforms.sohu,
        bodyOrder: [...profile.platforms.sohu.bodyOrder],
      },
      netease: {
        ...profile.platforms.sohu,
        bodyOrder: [...profile.platforms.sohu.bodyOrder],
      },
      zhihu: {
        ...profile.platforms.sohu,
        bodyOrder: [...profile.platforms.sohu.bodyOrder],
      },
    },
  };
}

function expandLegacyAuditPolicyDocument(document: LegacyGeoAuditPolicyDocument): unknown {
  const fallbackStyle = document.platformEditorialStyles.sohu;
  const fallbackRendition = document.audit.media.renditions.sohu;
  const fallbackLimits = document.audit.platformLimits.sohu;

  // Baijiahao and NetEase are long-form surfaces, so legacy Sohu rules are the
  // closest deterministic fallback whose template references exist in old v2 documents.
  return {
    ...document,
    editorialProfiles: {
      guide: expandLegacyEditorialProfile(document.editorialProfiles.guide),
      question_answer: expandLegacyEditorialProfile(document.editorialProfiles.question_answer),
      comparison: expandLegacyEditorialProfile(document.editorialProfiles.comparison),
      risk_avoidance: expandLegacyEditorialProfile(document.editorialProfiles.risk_avoidance),
      local_service: expandLegacyEditorialProfile(document.editorialProfiles.local_service),
    },
    platformEditorialStyles: {
      ...document.platformEditorialStyles,
      baijiahao: {
        ...fallbackStyle,
        bodyTemplateIds: { ...fallbackStyle.bodyTemplateIds },
        tagTemplateIds: [...fallbackStyle.tagTemplateIds],
      },
      netease: {
        ...fallbackStyle,
        bodyTemplateIds: { ...fallbackStyle.bodyTemplateIds },
        tagTemplateIds: [...fallbackStyle.tagTemplateIds],
      },
      zhihu: {
        ...fallbackStyle,
        bodyTemplateIds: { ...fallbackStyle.bodyTemplateIds },
        tagTemplateIds: [...fallbackStyle.tagTemplateIds],
      },
    },
    audit: {
      ...stripDeprecatedKeywordRuleFields(document.audit),
      media: {
        ...document.audit.media,
        renditions: {
          ...document.audit.media.renditions,
          baijiahao: {
            ...fallbackRendition,
            allowedMimeTypes: [...fallbackRendition.allowedMimeTypes],
            aspectRatios: [...fallbackRendition.aspectRatios],
          },
          netease: {
            ...fallbackRendition,
            allowedMimeTypes: [...fallbackRendition.allowedMimeTypes],
            aspectRatios: [...fallbackRendition.aspectRatios],
          },
          zhihu: {
            ...fallbackRendition,
            allowedMimeTypes: [...fallbackRendition.allowedMimeTypes],
            aspectRatios: [...fallbackRendition.aspectRatios],
          },
        },
      },
      platformLimits: {
        ...document.audit.platformLimits,
        baijiahao: { ...fallbackLimits },
        netease: { ...fallbackLimits },
        zhihu: { ...fallbackLimits },
      },
    },
  };
}

function parseAuditPolicyDocument(document: unknown): ParsedAuditPolicyDocument {
  const currentDocument = geoAuditPolicyDocumentSchema.safeParse(document);
  if (currentDocument.success) {
    return { document: currentDocument.data, compatibilityExpanded: false };
  }

  const legacyFivePlatformDocument =
    legacyFivePlatformGeoAuditPolicyDocumentSchema.safeParse(document);
  if (legacyFivePlatformDocument.success) {
    const expandedDocument = geoAuditPolicyDocumentSchema.safeParse(
      expandLegacyFivePlatformAuditPolicyDocument(legacyFivePlatformDocument.data),
    );
    if (!expandedDocument.success) {
      return invalidInput(
        "AUDIT_POLICY_LEGACY_EXPANSION_INVALID",
        "Legacy audit policy expansion is invalid",
        expandedDocument.error,
      );
    }
    return { document: expandedDocument.data, compatibilityExpanded: true };
  }

  const legacyDocument = legacyGeoAuditPolicyDocumentSchema.safeParse(document);
  if (!legacyDocument.success) {
    return invalidInput(
      "AUDIT_POLICY_DOCUMENT_INVALID",
      "Audit policy document is invalid",
      currentDocument.error,
    );
  }

  const expandedDocument = geoAuditPolicyDocumentSchema.safeParse(
    expandLegacyAuditPolicyDocument(legacyDocument.data),
  );
  if (!expandedDocument.success) {
    return invalidInput(
      "AUDIT_POLICY_LEGACY_EXPANSION_INVALID",
      "Legacy audit policy expansion is invalid",
      expandedDocument.error,
    );
  }
  return { document: expandedDocument.data, compatibilityExpanded: true };
}

export function buildBaselineAuditPolicyDocument(
  input: BuildBaselineAuditPolicyDocumentInput,
): Readonly<GeoAuditPolicyDocument> {
  const parsedInput = baselineInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidInput(
      "AUDIT_POLICY_BASELINE_INPUT_INVALID",
      "Audit policy baseline input is invalid",
      parsedInput.error,
    );
  }

  const document = {
    schemaVersion: GEO_AUDIT_POLICY_SCHEMA_VERSION,
    rulesVersion: parsedInput.data.rulesVersion,
    industry: parsedInput.data.industry,
    contentTemplates: {
      title: { ...DEFAULT_AUDIT_POLICY.contentTemplates.title },
      summary: { ...DEFAULT_AUDIT_POLICY.contentTemplates.summary },
      body: { ...DEFAULT_AUDIT_POLICY.contentTemplates.body },
      tag: { ...DEFAULT_AUDIT_POLICY.contentTemplates.tag },
    },
    editorialProfiles: DEFAULT_AUDIT_POLICY.editorialProfiles,
    platformEditorialStyles: DEFAULT_AUDIT_POLICY.platformEditorialStyles,
    audit: {
      artifactTtlMs: DEFAULT_AUDIT_POLICY.artifactTtlMs,
      maxEvidenceAgeMs: DEFAULT_AUDIT_POLICY.maxEvidenceAgeMs,
      minClaims: DEFAULT_AUDIT_POLICY.minClaims,
      duplicateThreshold: DEFAULT_AUDIT_POLICY.duplicateThreshold,
      minDuplicateCharacters: DEFAULT_AUDIT_POLICY.minDuplicateCharacters,
      media: copyMediaPolicy(),
      platformLimits: copyPlatformLimits(),
    },
  };
  const parsedDocument = geoAuditPolicyDocumentSchema.safeParse(document);
  if (!parsedDocument.success) {
    return invalidInput(
      "AUDIT_POLICY_BASELINE_INVALID",
      "Generated audit policy baseline is invalid",
      parsedDocument.error,
    );
  }
  return freezeDeep(parsedDocument.data);
}

export function compileAuditPolicy(input: CompileAuditPolicyInput): Readonly<AuditPolicy> {
  const parsedInput = compileInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidInput(
      "AUDIT_POLICY_INPUT_INVALID",
      "Audit policy compiler input is invalid",
      parsedInput.error,
    );
  }

  const actualHash = sha256Canonical(parsedInput.data.document);
  invariant(
    actualHash === parsedInput.data.policyHash,
    "AUDIT_POLICY_HASH_MISMATCH",
    "Audit policy hash does not match the canonical document",
    { expected: parsedInput.data.policyHash, actual: actualHash },
  );

  const parsedPolicyDocument = parseAuditPolicyDocument(parsedInput.data.document);
  const parsedDocument = parsedPolicyDocument.document;
  invariant(
    parsedInput.data.version === parsedDocument.rulesVersion,
    "AUDIT_POLICY_VERSION_MISMATCH",
    "Policy bundle version must match document rulesVersion",
    {
      version: parsedInput.data.version,
      rulesVersion: parsedDocument.rulesVersion,
    },
  );

  const policySemantics: Omit<AuditPolicy, "sourceHash" | "effectiveHash"> = {
    version: parsedDocument.rulesVersion,
    artifactTtlMs: parsedDocument.audit.artifactTtlMs,
    maxEvidenceAgeMs: parsedDocument.audit.maxEvidenceAgeMs,
    minClaims: parsedDocument.audit.minClaims,
    duplicateThreshold: parsedDocument.audit.duplicateThreshold,
    minDuplicateCharacters: parsedDocument.audit.minDuplicateCharacters,
    media: {
      inspectionRequired: parsedDocument.audit.media.inspectionRequired,
      evaluatorAllowlist: parsedDocument.audit.media.evaluatorAllowlist.map((entry) => ({
        ...entry,
      })),
      renditions: {
        toutiao: { ...parsedDocument.audit.media.renditions.toutiao },
        sohu: { ...parsedDocument.audit.media.renditions.sohu },
        baijiahao: { ...parsedDocument.audit.media.renditions.baijiahao },
        netease: { ...parsedDocument.audit.media.renditions.netease },
        ctrip_community: { ...parsedDocument.audit.media.renditions.ctrip_community },
        zhihu: { ...parsedDocument.audit.media.renditions.zhihu },
      },
    },
    contentTemplates: {
      title: { ...parsedDocument.contentTemplates.title },
      summary: { ...parsedDocument.contentTemplates.summary },
      body: { ...parsedDocument.contentTemplates.body },
      tag: { ...parsedDocument.contentTemplates.tag },
    },
    editorialProfiles: parsedDocument.editorialProfiles,
    platformEditorialStyles: parsedDocument.platformEditorialStyles,
    platformLimits: {
      toutiao: { ...parsedDocument.audit.platformLimits.toutiao },
      sohu: { ...parsedDocument.audit.platformLimits.sohu },
      baijiahao: { ...parsedDocument.audit.platformLimits.baijiahao },
      netease: { ...parsedDocument.audit.platformLimits.netease },
      ctrip_community: { ...parsedDocument.audit.platformLimits.ctrip_community },
      zhihu: { ...parsedDocument.audit.platformLimits.zhihu },
    },
  };
  const effectiveHash = parsedPolicyDocument.compatibilityExpanded
    ? sha256Canonical({
        schemaVersion: GEO_AUDIT_POLICY_EFFECTIVE_HASH_SCHEMA_VERSION,
        policy: policySemantics,
      })
    : parsedInput.data.policyHash;
  const policy: AuditPolicy = freezeDeep({
    ...policySemantics,
    sourceHash: parsedInput.data.policyHash,
    effectiveHash,
  });
  registerCompiledAuditPolicy(policy, parsedInput.data.policyHash);
  return policy;
}
