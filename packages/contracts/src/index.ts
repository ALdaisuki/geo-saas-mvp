import { z } from "zod";

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

export const servicePrincipalProfileSchema = z.enum(["custom", "automation_producer"]);
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

export const servicePrincipalStatusRequestSchema = z.strictObject({
  status: servicePrincipalStatusSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ServicePrincipalStatusRequest = z.infer<typeof servicePrincipalStatusRequestSchema>;

export const mediaReferenceSchema = z.object({
  id: idSchema,
  sha256: sha256Schema,
  mimeType: z.string().trim().min(1).max(100),
  altText: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().optional(),
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

export const publicationVariantPayloadSchema = z.object({
  editorialProfile: editorialProfileSchema.optional(),
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
