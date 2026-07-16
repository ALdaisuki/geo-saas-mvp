import { z } from "zod";

export * from "./article-templates.js";

export const idSchema = z.string().uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const tenantRoleSchema = z.enum([
  "owner",
  "admin",
  "editor",
  "auditor",
  "publisher",
  "viewer",
]);
export type TenantRole = z.infer<typeof tenantRoleSchema>;

export const capabilitySchema = z.enum([
  "tenant:read",
  "tenant:manage",
  "member:manage",
  "principal:manage",
  "content:read",
  "content:write",
  "audit:read",
  "audit:run",
  "grant:revoke",
  "publish:request",
  "publish:bridge",
  "publish:cancel",
  "receipt:read",
  "visibility:read",
  "visibility:run",
  "automation:manage",
  "automation:execute",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const platformSchema = z.enum(["toutiao", "sohu", "ctrip_community"]);
export type Platform = z.infer<typeof platformSchema>;

export const editorialProfileSchema = z.enum([
  "guide",
  "question_answer",
  "comparison",
  "risk_avoidance",
  "local_service",
]);
export type EditorialProfile = z.infer<typeof editorialProfileSchema>;

const brandAgentProfileListSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(50)
  .refine((values) => new Set(values).size === values.length, "Values must be unique");

export const brandAgentProfileDocumentSchema = z.strictObject({
  schemaVersion: z.literal("geo.brand-agent-profile.v1"),
  voice: z.string().trim().min(1).max(1_000),
  audiences: brandAgentProfileListSchema.min(1),
  objectives: brandAgentProfileListSchema.min(1),
  requiredPoints: brandAgentProfileListSchema,
  forbiddenClaims: brandAgentProfileListSchema,
  callToAction: z.string().trim().min(1).max(1_000),
  agentInstructions: z.string().trim().min(1).max(10_000),
});
export type BrandAgentProfileDocument = z.infer<typeof brandAgentProfileDocumentSchema>;

export const brandAgentProfileReferenceSchema = z.strictObject({
  id: idSchema,
  version: z.number().int().positive().safe(),
  documentHash: sha256Schema,
});
export type BrandAgentProfileReference = z.infer<typeof brandAgentProfileReferenceSchema>;

export const brandAgentProfileSchema = z.strictObject({
  ...brandAgentProfileReferenceSchema.shape,
  brandId: idSchema,
  status: z.enum(["active", "retired"]),
  document: brandAgentProfileDocumentSchema,
  effectiveAt: isoDateTimeSchema,
  retiredAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type BrandAgentProfile = z.infer<typeof brandAgentProfileSchema>;

export const connectorCapabilitySchema = z.enum([
  "public_api",
  "partner_api",
  "browser_assisted",
  "manual_only",
  "disabled",
]);
export type ConnectorCapability = z.infer<typeof connectorCapabilitySchema>;

export const executionLevelSchema = z.enum(["dry_run", "assisted", "unattended"]);
export type ExecutionLevel = z.infer<typeof executionLevelSchema>;

export const evidenceTypeSchema = z.enum([
  "fixture",
  "preview",
  "manual_import",
  "browser_screenshot",
  "api_response",
  "platform_readback",
]);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export const automationModeSchema = z.enum([
  "shadow",
  "supervised",
  "unattended",
  "paused",
  "stopped",
]);
export type AutomationMode = z.infer<typeof automationModeSchema>;

export const automationBatchStateSchema = z.enum([
  "scheduled",
  "running",
  "completed",
  "partially_failed",
  "cancelled",
]);
export type AutomationBatchState = z.infer<typeof automationBatchStateSchema>;

export const automationRunStateSchema = z.enum([
  "scheduled",
  "running",
  "retry_wait",
  "awaiting_delivery",
  "completed",
  "partially_failed",
  "blocked",
  "failed",
  "cancelled",
]);
export type AutomationRunState = z.infer<typeof automationRunStateSchema>;

export const automationRunStageSchema = z.enum(["planning", "draft", "targets", "delivery"]);
export type AutomationRunStage = z.infer<typeof automationRunStageSchema>;

export const automationRunTargetStateSchema = z.enum([
  "pending",
  "variant_ready",
  "audit_failed",
  "awaiting_delivery",
  "preview_completed",
  "confirmed",
  "blocked",
  "failed",
  "cancelled",
]);
export type AutomationRunTargetState = z.infer<typeof automationRunTargetStateSchema>;

const automationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const automationBatchItemSchema = z.strictObject({
  slotKey: automationKeySchema,
  scheduledFor: isoDateTimeSchema,
  topicKey: automationKeySchema,
  brief: z.string().trim().min(3).max(10_000),
  channelAccountIds: z
    .array(idSchema)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length, "Channel accounts must be unique"),
});
export type AutomationBatchItem = z.infer<typeof automationBatchItemSchema>;

export const automationBatchCreateRequestSchema = z
  .strictObject({
    idempotencyKey: automationKeySchema,
    name: z.string().trim().min(1).max(200).optional(),
    items: z.array(automationBatchItemSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    const slotKeys = new Set<string>();
    value.items.forEach((item, index) => {
      if (slotKeys.has(item.slotKey)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "slotKey"],
          message: "Slot keys must be unique within a batch",
        });
      }
      slotKeys.add(item.slotKey);
    });
  });
export type AutomationBatchCreateRequest = z.infer<typeof automationBatchCreateRequestSchema>;

export const contentStateSchema = z.enum([
  "draft",
  "ready_for_audit",
  "audited",
  "approved",
  "queued",
  "publishing",
  "published",
  "failed",
  "blocked",
  "withdrawn",
]);
export type ContentState = z.infer<typeof contentStateSchema>;

export const auditStatusSchema = z.enum(["running", "passed", "failed", "errored"]);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

export const auditSeveritySchema = z.enum(["info", "warning", "blocking"]);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

export const grantStatusSchema = z.enum(["issued", "consumed", "expired", "revoked"]);
export type GrantStatus = z.infer<typeof grantStatusSchema>;

export const publicationJobStateSchema = z.enum([
  "queued",
  "dispatching",
  "retry_wait",
  "uncertain",
  "reconciling",
  "preview_completed",
  "confirmed",
  "needs_review",
  "permanent_failure",
  "cancelled",
]);
export type PublicationJobState = z.infer<typeof publicationJobStateSchema>;

export const circuitStateSchema = z.enum(["closed", "open", "half_open"]);
export type CircuitState = z.infer<typeof circuitStateSchema>;

export const contactTypeSchema = z.enum(["phone", "wechat", "email", "website", "address"]);
export type ContactType = z.infer<typeof contactTypeSchema>;

export const tenantContactSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  type: contactTypeSchema,
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(500),
  isPrimary: z.boolean().default(false),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable().default(null),
});
export type TenantContact = z.infer<typeof tenantContactSchema>;

export const contactCreateRequestSchema = z.strictObject({
  type: contactTypeSchema,
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(500),
  isPrimary: z.boolean().default(false),
  validFrom: isoDateTimeSchema.optional(),
});
export type ContactCreateRequest = z.infer<typeof contactCreateRequestSchema>;

export const contactExpireRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
  validUntil: isoDateTimeSchema.optional(),
});
export type ContactExpireRequest = z.infer<typeof contactExpireRequestSchema>;

export const memberCreateRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().min(1).max(200),
  role: tenantRoleSchema,
  initialPassword: z.string().min(12).max(1_024),
});
export type MemberCreateRequest = z.infer<typeof memberCreateRequestSchema>;

export const memberStatusSchema = z.enum(["active", "suspended"]);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const memberUpdateRequestSchema = z
  .strictObject({
    role: tenantRoleSchema.optional(),
    status: memberStatusSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "A member role or status change is required",
  });
export type MemberUpdateRequest = z.infer<typeof memberUpdateRequestSchema>;

export const policyTransitionRequestSchema = z.strictObject({
  targetStatus: z.enum(["active", "retired"]),
  reason: z.string().trim().min(3).max(500),
});
export type PolicyTransitionRequest = z.infer<typeof policyTransitionRequestSchema>;

export const channelAccountStatusSchema = z.enum(["active", "disabled", "needs_verification"]);
export type ChannelAccountStatus = z.infer<typeof channelAccountStatusSchema>;

function validateExecutionLevels(
  value: { capability: ConnectorCapability; supportedExecutionLevels: readonly ExecutionLevel[] },
  context: z.RefinementCtx,
): void {
  if (value.capability === "manual_only" || value.capability === "disabled") {
    if (
      value.supportedExecutionLevels.length !== 1 ||
      value.supportedExecutionLevels[0] !== "dry_run"
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportedExecutionLevels"],
        message: `${value.capability} accounts support dry_run only`,
      });
    }
  }
  if (
    value.capability === "browser_assisted" &&
    value.supportedExecutionLevels.includes("unattended")
  ) {
    context.addIssue({
      code: "custom",
      path: ["supportedExecutionLevels"],
      message: "browser_assisted accounts cannot execute unattended",
    });
  }
}

export const channelAccountCreateRequestSchema = z
  .strictObject({
    platform: platformSchema,
    displayName: z.string().trim().min(1).max(200),
    capability: connectorCapabilitySchema,
    supportedExecutionLevels: z
      .array(executionLevelSchema)
      .min(1)
      .max(3)
      .refine(
        (values) => new Set(values).size === values.length,
        "Execution levels must be unique",
      ),
    credentialRef: z.string().trim().min(1).max(1_000).nullable().optional(),
    evidenceType: evidenceTypeSchema,
    evidenceRefs: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
    status: channelAccountStatusSchema.default("needs_verification"),
    lastVerifiedAt: isoDateTimeSchema.nullable().optional(),
  })
  .superRefine(validateExecutionLevels);
export type ChannelAccountCreateRequest = z.infer<typeof channelAccountCreateRequestSchema>;

export const channelAccountUpdateRequestSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(200).optional(),
    capability: connectorCapabilitySchema.optional(),
    supportedExecutionLevels: z
      .array(executionLevelSchema)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, "Execution levels must be unique")
      .optional(),
    credentialRef: z.string().trim().min(1).max(1_000).nullable().optional(),
    evidenceType: evidenceTypeSchema.optional(),
    evidenceRefs: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
    status: channelAccountStatusSchema.optional(),
    lastVerifiedAt: isoDateTimeSchema.nullable().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.capability !== undefined ||
      value.supportedExecutionLevels !== undefined ||
      value.credentialRef !== undefined ||
      value.evidenceType !== undefined ||
      value.evidenceRefs !== undefined ||
      value.status !== undefined ||
      value.lastVerifiedAt !== undefined,
    { message: "A channel account change is required" },
  );
export type ChannelAccountUpdateRequest = z.infer<typeof channelAccountUpdateRequestSchema>;

export const servicePrincipalProfileSchema = z.enum([
  "custom",
  "automation_producer",
  "ctrip_bridge",
]);
export type ServicePrincipalProfile = z.infer<typeof servicePrincipalProfileSchema>;

export const servicePrincipalStatusSchema = z.enum(["active", "disabled"]);
export type ServicePrincipalStatus = z.infer<typeof servicePrincipalStatusSchema>;

export const servicePrincipalSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["api", "worker", "agent", "integration"]),
  profile: servicePrincipalProfileSchema,
  capabilities: z.array(capabilitySchema),
  status: servicePrincipalStatusSchema,
  credentialStatus: z.enum(["not_issued", "active", "expired", "revoked"]),
  lastUsedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;

export const automationServicePrincipalCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});
export type AutomationServicePrincipalCreateRequest = z.infer<
  typeof automationServicePrincipalCreateRequestSchema
>;

export const ctripBridgeServicePrincipalCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});
export type CtripBridgeServicePrincipalCreateRequest = z.infer<
  typeof ctripBridgeServicePrincipalCreateRequestSchema
>;

export const servicePrincipalStatusRequestSchema = z.strictObject({
  status: servicePrincipalStatusSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ServicePrincipalStatusRequest = z.infer<typeof servicePrincipalStatusRequestSchema>;

export const mediaRoleSchema = z.enum(["cover", "inline"]);
export type MediaRole = z.infer<typeof mediaRoleSchema>;

export const mediaAspectRatioSchema = z.enum(["1:1", "4:3", "16:9"]);
export type MediaAspectRatio = z.infer<typeof mediaAspectRatioSchema>;

export const mediaProviderModeSchema = z.enum(["fixture", "live"]);
export type MediaProviderMode = z.infer<typeof mediaProviderModeSchema>;

export const mediaInspectionStatusSchema = z.enum(["passed", "failed"]);
export type MediaInspectionStatus = z.infer<typeof mediaInspectionStatusSchema>;

const httpsUrlSchema = z
  .string()
  .url()
  .regex(/^https:\/\//iu, "URL must use HTTPS");

function boundedUnicodeText(maxCodePoints: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.isWellFormed(), { message: "Text must be well-formed Unicode" })
    .refine((value) => [...value].length <= maxCodePoints, {
      message: `Text must contain at most ${maxCodePoints} Unicode code points`,
    });
}

const orderedFactIdsSchema = z
  .array(idSchema)
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length, "Fact IDs must be unique");

export const visualBriefSchema = z.strictObject({
  schemaVersion: z.literal("geo.visual-brief.v1"),
  editorialProfile: editorialProfileSchema,
  platform: platformSchema,
  role: mediaRoleSchema,
  aspectRatio: mediaAspectRatioSchema,
  factIds: orderedFactIdsSchema,
  prompt: boundedUnicodeText(10_000),
  negativePrompt: boundedUnicodeText(2_000),
  altText: boundedUnicodeText(500),
  caption: boundedUnicodeText(500),
});
export type VisualBrief = z.infer<typeof visualBriefSchema>;

export const mediaRightsBasisSchema = z.enum([
  "generated_terms",
  "commercial_license",
  "editorial_license",
  "tenant_owned",
]);
export type MediaRightsBasis = z.infer<typeof mediaRightsBasisSchema>;

export const mediaRightsSnapshotSchema = z.strictObject({
  basis: mediaRightsBasisSchema,
  licenseName: z.string().trim().min(1).max(500),
  licenseUrl: httpsUrlSchema.optional(),
  attribution: z.string().trim().min(1).max(2_000).optional(),
  verifiedAt: isoDateTimeSchema,
});
export type MediaRightsSnapshot = z.infer<typeof mediaRightsSnapshotSchema>;

export const generatedMediaProvenanceSchema = z.strictObject({
  kind: z.literal("generated"),
  jobId: idSchema,
  attemptId: idSchema,
  provider: z.string().trim().min(1).max(200),
  providerMode: mediaProviderModeSchema,
  model: z.string().trim().min(1).max(200),
  promptHash: sha256Schema,
  parametersHash: sha256Schema,
  generatedAt: isoDateTimeSchema,
});
export type GeneratedMediaProvenance = z.infer<typeof generatedMediaProvenanceSchema>;

export const licensedStockMediaProvenanceSchema = z.strictObject({
  kind: z.literal("licensed_stock"),
  evidenceSourceId: idSchema,
  sourceUrl: httpsUrlSchema,
});
export type LicensedStockMediaProvenance = z.infer<typeof licensedStockMediaProvenanceSchema>;

export const tenantOwnedMediaProvenanceSchema = z.strictObject({
  kind: z.literal("tenant_owned"),
  evidenceSourceId: idSchema,
  ownershipAssertion: z.string().trim().min(1).max(2_000),
});
export type TenantOwnedMediaProvenance = z.infer<typeof tenantOwnedMediaProvenanceSchema>;

export const mediaProvenanceSchema = z.discriminatedUnion("kind", [
  generatedMediaProvenanceSchema,
  licensedStockMediaProvenanceSchema,
  tenantOwnedMediaProvenanceSchema,
]);
export type MediaProvenance = z.infer<typeof mediaProvenanceSchema>;

export const mediaInspectionReferenceSchema = z.strictObject({
  assetSha256: sha256Schema,
  status: mediaInspectionStatusSchema,
  evaluator: z.string().trim().min(1).max(200),
  evaluatorMode: mediaProviderModeSchema,
  evaluatorVersion: z.string().trim().min(1).max(200),
  responseSha256: sha256Schema,
  inspectedAt: isoDateTimeSchema,
  ocrText: z.string().max(10_000),
  labels: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .refine((values) => new Set(values).size === values.length, "Labels must be unique"),
});
export type MediaInspectionReference = z.infer<typeof mediaInspectionReferenceSchema>;

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalStrictJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStrictJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStrictJson(record[key])}`)
    .join(",")}}`;
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function sha256Text(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = BigInt(bytes.length) * 8n;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    bytes.push(Number((bitLength >> shift) & 0xffn));
  }

  const state: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        ((bytes[wordOffset] ?? 0) << 24) |
        ((bytes[wordOffset + 1] ?? 0) << 16) |
        ((bytes[wordOffset + 2] ?? 0) << 8) |
        (bytes[wordOffset + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15] ?? 0;
      const prior2 = words[index - 2] ?? 0;
      const smallSigma0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const smallSigma1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] =
        (smallSigma1 + (words[index - 7] ?? 0) + smallSigma0 + (words[index - 16] ?? 0)) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + bigSigma1 + choose + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export const mediaReferenceSchema = z
  .strictObject({
    id: idSchema,
    sha256: sha256Schema,
    mimeType: z
      .string()
      .trim()
      .regex(/^image\/[a-z0-9.+-]+$/iu)
      .max(100),
    byteLength: z.number().int().positive().safe(),
    width: z.number().int().positive().safe(),
    height: z.number().int().positive().safe(),
    platform: platformSchema,
    role: mediaRoleSchema,
    altText: boundedUnicodeText(500),
    caption: boundedUnicodeText(500),
    factIds: orderedFactIdsSchema,
    visualBrief: visualBriefSchema,
    visualBriefHash: sha256Schema,
    rights: mediaRightsSnapshotSchema,
    provenance: mediaProvenanceSchema,
    inspection: mediaInspectionReferenceSchema,
  })
  .superRefine((value, context) => {
    const duplicateBindings: Array<[string, unknown, unknown]> = [
      ["platform", value.platform, value.visualBrief.platform],
      ["role", value.role, value.visualBrief.role],
      ["altText", value.altText, value.visualBrief.altText],
      ["caption", value.caption, value.visualBrief.caption],
    ];
    for (const [field, actual, expected] of duplicateBindings) {
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must match the visual brief`,
        });
      }
    }
    if (!sameOrderedValues(value.factIds, value.visualBrief.factIds)) {
      context.addIssue({
        code: "custom",
        path: ["factIds"],
        message: "Fact IDs must match the visual brief in exact order",
      });
    }
    if (value.inspection.assetSha256 !== value.sha256) {
      context.addIssue({
        code: "custom",
        path: ["inspection", "assetSha256"],
        message: "Inspection must reference the exact asset SHA-256",
      });
    }
    if (value.visualBriefHash !== sha256Text(canonicalStrictJson(value.visualBrief))) {
      context.addIssue({
        code: "custom",
        path: ["visualBriefHash"],
        message: "Visual brief hash must match the complete canonical visual brief",
      });
    }
    if (
      value.provenance.kind === "generated" &&
      value.provenance.promptHash !== sha256Text(value.visualBrief.prompt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "promptHash"],
        message: "Generated prompt hash must match the visual brief prompt",
      });
    }
    const rightsMatch =
      (value.provenance.kind === "generated" && value.rights.basis === "generated_terms") ||
      (value.provenance.kind === "licensed_stock" &&
        (value.rights.basis === "commercial_license" ||
          value.rights.basis === "editorial_license")) ||
      (value.provenance.kind === "tenant_owned" && value.rights.basis === "tenant_owned");
    if (!rightsMatch) {
      context.addIssue({
        code: "custom",
        path: ["rights", "basis"],
        message: "Rights basis must match media provenance",
      });
    }
  });
export type MediaReference = z.infer<typeof mediaReferenceSchema>;

export const contentClaimSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(2_000),
  evidenceSourceIds: z.array(idSchema).max(20).default([]),
  validUntil: isoDateTimeSchema.nullable().default(null),
});
export type ContentClaim = z.infer<typeof contentClaimSchema>;

export const contentTemplateIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

export const canonicalTemplateBlockSchema = z.strictObject({
  type: z.literal("template"),
  templateId: contentTemplateIdSchema,
});

export const canonicalInlineClaimBlockSchema = z.strictObject({
  type: z.literal("claim"),
  claimId: idSchema,
});

export const canonicalInlineContactBlockSchema = z.strictObject({
  type: z.literal("contact"),
  contactId: idSchema,
});

export const canonicalInlineBlockSchema = z.discriminatedUnion("type", [
  canonicalTemplateBlockSchema,
  canonicalInlineClaimBlockSchema,
  canonicalInlineContactBlockSchema,
]);
export type CanonicalInlineBlock = z.infer<typeof canonicalInlineBlockSchema>;

export const canonicalBodyClaimBlockSchema = z.strictObject({
  type: z.literal("claim"),
  claimId: idSchema,
  presentation: z.enum(["paragraph", "bullet"]),
});

export const canonicalBodyContactBlockSchema = z.strictObject({
  type: z.literal("contact"),
  contactId: idSchema,
  presentation: z.enum(["paragraph", "bullet"]),
});

export const canonicalBodyBlockSchema = z.discriminatedUnion("type", [
  canonicalTemplateBlockSchema,
  canonicalBodyClaimBlockSchema,
  canonicalBodyContactBlockSchema,
]);
export type CanonicalBodyBlock = z.infer<typeof canonicalBodyBlockSchema>;

export const publicationVariantPayloadSchema = z
  .object({
    editorialProfile: editorialProfileSchema.optional(),
    articleTemplateId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/u)
      .optional(),
    brandAgentProfile: brandAgentProfileReferenceSchema.optional(),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    bodyMarkdown: z.string().trim().min(1).max(100_000),
    titleBlocks: z.array(canonicalInlineBlockSchema).min(1).max(50).optional(),
    summaryBlocks: z.array(canonicalInlineBlockSchema).min(1).max(100).optional(),
    bodyBlocks: z.array(canonicalBodyBlockSchema).min(1).max(500).optional(),
    tagTemplateIds: z.array(contentTemplateIdSchema).max(20).optional(),
    canonicalUrl: z.string().url().optional(),
    media: z.array(mediaReferenceSchema).max(30).default([]),
    claims: z.array(contentClaimSchema).max(100).default([]),
    contactIds: z.array(idSchema).max(20).default([]),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  })
  .superRefine((value, context) => {
    const mediaIds = new Set<string>();
    value.media.forEach((media, index) => {
      if (mediaIds.has(media.id)) {
        context.addIssue({
          code: "custom",
          path: ["media", index, "id"],
          message: "Media IDs must be unique within a publication payload",
        });
      }
      mediaIds.add(media.id);
    });
  });
export type PublicationVariantPayload = z.infer<typeof publicationVariantPayloadSchema>;

export const auditFindingSchema = z.object({
  ruleId: z.string().trim().min(1).max(100),
  ruleVersion: z.string().trim().min(1).max(50),
  severity: auditSeveritySchema,
  message: z.string().trim().min(1).max(2_000),
  path: z.string().trim().min(1).max(500).optional(),
  evidence: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
});
export type AuditFinding = z.infer<typeof auditFindingSchema>;

export const auditArtifactSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  variantId: idSchema,
  channelAccountId: idSchema,
  platform: platformSchema,
  payloadHash: sha256Schema,
  factSnapshotHash: sha256Schema,
  brandSnapshotHash: sha256Schema,
  mediaSnapshotHash: sha256Schema,
  policyHash: sha256Schema,
  policyVersion: z.string().trim().min(1).max(100),
  auditHash: sha256Schema,
  status: auditStatusSchema,
  findings: z.array(auditFindingSchema),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});
export type AuditArtifact = z.infer<typeof auditArtifactSchema>;

export const publicationGrantSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  variantId: idSchema,
  channelAccountId: idSchema,
  platform: platformSchema,
  payloadHash: sha256Schema,
  auditHash: sha256Schema,
  tokenHash: sha256Schema,
  status: grantStatusSchema,
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  consumedAt: isoDateTimeSchema.nullable().default(null),
});
export type PublicationGrant = z.infer<typeof publicationGrantSchema>;

export const connectorCapabilityReportSchema = z
  .object({
    platform: platformSchema,
    capability: connectorCapabilitySchema,
    supportedExecutionLevels: z.array(executionLevelSchema).min(1),
    checkedAt: isoDateTimeSchema,
    evidenceType: evidenceTypeSchema,
    evidenceRefs: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .superRefine(validateExecutionLevels);
export type ConnectorCapabilityReport = z.infer<typeof connectorCapabilityReportSchema>;

export const publicationReceiptSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  jobId: idSchema,
  attemptId: idSchema,
  platform: platformSchema,
  executionLevel: executionLevelSchema,
  evidenceType: evidenceTypeSchema,
  requestHash: sha256Schema,
  responseHash: sha256Schema,
  externalId: z.string().trim().min(1).max(500).nullable(),
  externalUrl: z.string().url().nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  recordedAt: isoDateTimeSchema,
  confirmed: z.boolean(),
});
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export const visibilityProviderSchema = z.enum(["doubao", "qwen"]);
export type VisibilityProvider = z.infer<typeof visibilityProviderSchema>;

export const observationMethodSchema = z.enum(["fixture", "manual", "official_api", "browser"]);
export type ObservationMethod = z.infer<typeof observationMethodSchema>;

export const visibilitySentimentSchema = z.enum(["positive", "neutral", "negative", "mixed"]);
export type VisibilitySentiment = z.infer<typeof visibilitySentimentSchema>;

export const hallucinationFindingSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,99}$/),
  category: z.enum(["contact", "brand", "qualification", "control", "other"]),
  severity: z.enum(["low", "medium", "high"]),
  statement: z.string().trim().min(1).max(2_000),
  observedValue: z.string().trim().min(1).max(2_000).nullable(),
  expectedValues: z.array(z.string().trim().min(1).max(2_000)).max(100),
});
export type HallucinationFinding = z.infer<typeof hallucinationFindingSchema>;

export const visibilityObservationSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    runId: idSchema,
    provider: visibilityProviderSchema,
    productSurface: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
    searchMode: z.enum(["on", "off", "unknown"]),
    observationMethod: observationMethodSchema,
    prompt: z.string().trim().min(1).max(10_000),
    promptVersion: z.string().trim().min(1).max(100),
    locale: z.string().trim().min(1).max(50),
    geo: z.string().trim().min(1).max(100).nullable(),
    rawAnswer: z.string().min(1).max(200_000),
    citedUrls: z.array(z.string().url()).max(100).default([]),
    evidenceHash: sha256Schema,
    evidenceType: evidenceTypeSchema,
    requestStartedAt: isoDateTimeSchema,
    responseReceivedAt: isoDateTimeSchema,
    observedAt: isoDateTimeSchema,
    brandMentioned: z.boolean(),
    answerPosition: z.number().int().positive().nullable(),
    contactAccuracy: z.number().min(0).max(1),
    competitorMentions: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    sentiment: visibilitySentimentSchema,
    hallucinationFindings: z.array(hallucinationFindingSchema).max(100).default([]),
    harmfulError: z.boolean(),
    evaluatorVersion: z.string().trim().min(1).max(100),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.responseReceivedAt) < Date.parse(value.requestStartedAt)) {
      context.addIssue({
        code: "custom",
        path: ["responseReceivedAt"],
        message: "Response timestamp cannot precede request timestamp",
      });
    }
    const hasHighSeverityFinding = value.hallucinationFindings.some(
      (finding) => finding.severity === "high",
    );
    if (value.harmfulError !== hasHighSeverityFinding) {
      context.addIssue({
        code: "custom",
        path: ["harmfulError"],
        message: "Harmful errors must correspond to a high-severity hallucination finding",
      });
    }
  });
export type VisibilityObservation = z.infer<typeof visibilityObservationSchema>;

export const actorContextSchema = z.object({
  actorId: idSchema,
  tenantId: idSchema,
  role: tenantRoleSchema,
  capabilities: z.array(capabilitySchema),
  requestId: z.string().trim().min(1).max(200),
});
export type ActorContext = z.infer<typeof actorContextSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2_000),
    requestId: z.string().trim().min(1).max(200),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
