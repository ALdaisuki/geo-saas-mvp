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
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const platformSchema = z.enum(["toutiao", "sohu", "ctrip_community"]);
export type Platform = z.infer<typeof platformSchema>;

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

export const publicationVariantPayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  bodyMarkdown: z.string().trim().min(1).max(100_000),
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

export const connectorCapabilityReportSchema = z.object({
  platform: platformSchema,
  capability: connectorCapabilitySchema,
  supportedExecutionLevels: z.array(executionLevelSchema).min(1),
  checkedAt: isoDateTimeSchema,
  evidenceType: evidenceTypeSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  reason: z.string().trim().min(1).max(2_000),
});
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

export const visibilityObservationSchema = z.object({
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
  observedAt: isoDateTimeSchema,
  brandMentioned: z.boolean(),
  answerPosition: z.number().int().positive().nullable(),
  contactAccuracy: z.number().min(0).max(1),
  competitorMentions: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  harmfulError: z.boolean(),
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
