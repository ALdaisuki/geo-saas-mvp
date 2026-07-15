import { z } from "zod";

import { DEFAULT_AUDIT_POLICY, type AuditPolicy } from "./audit.js";
import { registerCompiledAuditPolicy } from "./audit-policy-provenance.js";
import { sha256Canonical } from "./canonical.js";
import { CoreInvariantError, invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export const GEO_AUDIT_POLICY_SCHEMA_VERSION = "geo.audit-policy.v2" as const;

const nonBlankIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value.trim() === value, "Value must not have surrounding whitespace");
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const prohibitedGuaranteeSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, "Value must not have surrounding whitespace");
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
    ctrip_community: editorialPlatformProfileSchema,
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
  ctrip_community: platformEditorialStyleSchema,
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
    ctrip_community: platformMediaRenditionPolicySchema,
  }),
});

export const auditPolicyRulesSchema = z.strictObject({
  artifactTtlMs: positiveSafeIntegerSchema,
  maxEvidenceAgeMs: positiveSafeIntegerSchema,
  minClaims: nonNegativeSafeIntegerSchema,
  duplicateThreshold: z.number().gt(0).max(1),
  minDuplicateCharacters: nonNegativeSafeIntegerSchema,
  prohibitedGuarantees: z.array(prohibitedGuaranteeSchema).max(100),
  media: mediaAuditPolicySchema,
  platformLimits: z.strictObject({
    toutiao: platformAuditLimitsSchema,
    sohu: platformAuditLimitsSchema,
    ctrip_community: platformAuditLimitsSchema,
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

export type GeoAuditPolicyDocument = z.infer<typeof geoAuditPolicyDocumentSchema>;

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

const GENERAL_PROHIBITED_GUARANTEES = [
  "\u767e\u5206\u767e",
  "100%\u4fdd\u8bc1",
  "\u7edd\u5bf9\u4fdd\u8bc1",
  "\u96f6\u98ce\u9669",
] as const;

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
    ctrip_community: { ...DEFAULT_AUDIT_POLICY.platformLimits.ctrip_community },
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
      prohibitedGuarantees: [...GENERAL_PROHIBITED_GUARANTEES],
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

  const parsedDocument = geoAuditPolicyDocumentSchema.safeParse(parsedInput.data.document);
  if (!parsedDocument.success) {
    return invalidInput(
      "AUDIT_POLICY_DOCUMENT_INVALID",
      "Audit policy document is invalid",
      parsedDocument.error,
    );
  }
  invariant(
    parsedInput.data.version === parsedDocument.data.rulesVersion,
    "AUDIT_POLICY_VERSION_MISMATCH",
    "Policy bundle version must match document rulesVersion",
    {
      version: parsedInput.data.version,
      rulesVersion: parsedDocument.data.rulesVersion,
    },
  );

  const policy: AuditPolicy = freezeDeep({
    version: parsedDocument.data.rulesVersion,
    sourceHash: parsedInput.data.policyHash,
    artifactTtlMs: parsedDocument.data.audit.artifactTtlMs,
    maxEvidenceAgeMs: parsedDocument.data.audit.maxEvidenceAgeMs,
    minClaims: parsedDocument.data.audit.minClaims,
    duplicateThreshold: parsedDocument.data.audit.duplicateThreshold,
    minDuplicateCharacters: parsedDocument.data.audit.minDuplicateCharacters,
    prohibitedGuarantees: [...parsedDocument.data.audit.prohibitedGuarantees],
    media: {
      inspectionRequired: parsedDocument.data.audit.media.inspectionRequired,
      evaluatorAllowlist: parsedDocument.data.audit.media.evaluatorAllowlist.map((entry) => ({
        ...entry,
      })),
      renditions: {
        toutiao: { ...parsedDocument.data.audit.media.renditions.toutiao },
        sohu: { ...parsedDocument.data.audit.media.renditions.sohu },
        ctrip_community: { ...parsedDocument.data.audit.media.renditions.ctrip_community },
      },
    },
    contentTemplates: {
      title: { ...parsedDocument.data.contentTemplates.title },
      summary: { ...parsedDocument.data.contentTemplates.summary },
      body: { ...parsedDocument.data.contentTemplates.body },
      tag: { ...parsedDocument.data.contentTemplates.tag },
    },
    editorialProfiles: parsedDocument.data.editorialProfiles,
    platformEditorialStyles: parsedDocument.data.platformEditorialStyles,
    platformLimits: {
      toutiao: { ...parsedDocument.data.audit.platformLimits.toutiao },
      sohu: { ...parsedDocument.data.audit.platformLimits.sohu },
      ctrip_community: { ...parsedDocument.data.audit.platformLimits.ctrip_community },
    },
  });
  registerCompiledAuditPolicy(policy, parsedInput.data.policyHash);
  return policy;
}
