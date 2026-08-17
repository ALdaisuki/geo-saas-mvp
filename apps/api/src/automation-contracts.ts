import {
  automationBatchCreateRequestSchema,
  automationManualRemediationActionSchema,
  automationRunStageSchema,
  automationRunStateSchema,
  automationRunTargetStateSchema,
  idSchema,
  isoDateTimeSchema,
} from "@geo/contracts";
import { z } from "zod";

const producerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const attemptSchema = z.number().int().min(1).max(100);
const leaseSecondsSchema = z.number().int().min(10).max(3_600).default(60);
const checkpointSchema = z.record(z.string(), z.unknown());
const errorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9][A-Z0-9_.-]*$/u);

export { automationBatchCreateRequestSchema };

export const automationBatchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: isoDateTimeSchema.optional(),
  state: z.enum(["scheduled", "running", "completed", "partially_failed", "cancelled"]).optional(),
  campaignId: idSchema.optional(),
});

export const automationRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: isoDateTimeSchema.optional(),
  state: automationRunStateSchema.optional(),
  batchId: idSchema.optional(),
});

export const automationClaimCommandSchema = z.strictObject({
  producerId: producerIdSchema,
  limit: z.number().int().min(1).max(16).default(1),
  leaseSeconds: leaseSecondsSchema,
});

export const automationHeartbeatCommandSchema = z.strictObject({
  producerId: producerIdSchema,
  attempt: attemptSchema,
  stage: automationRunStageSchema,
  checkpoint: checkpointSchema,
  leaseSeconds: leaseSecondsSchema,
});

export const automationDraftCheckpointCommandSchema = z.strictObject({
  producerId: producerIdSchema,
  attempt: attemptSchema,
  contentItemId: idSchema,
  contentVersionId: idSchema,
  checkpoint: checkpointSchema,
  leaseSeconds: leaseSecondsSchema,
});

export const automationTargetCheckpointCommandSchema = z
  .strictObject({
    producerId: producerIdSchema,
    attempt: attemptSchema,
    state: automationRunTargetStateSchema.exclude([
      "pending",
      "submitted_pending_review",
      "publisher_rejected",
      "cancelled",
    ]),
    variantId: idSchema.optional(),
    auditRunId: idSchema.optional(),
    auditArtifactId: idSchema.optional(),
    publicationJobId: idSchema.optional(),
    errorCode: errorCodeSchema.optional(),
    errorMessage: z.string().trim().min(1).max(4_000).optional(),
    checkpoint: checkpointSchema.default({}),
    leaseSeconds: leaseSecondsSchema,
  })
  .superRefine((value, context) => {
    if (
      !["blocked", "failed", "awaiting_manual_review"].includes(value.state) &&
      value.variantId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["variantId"],
        message: "Target state requires a publication variant",
      });
    }
    if (
      [
        "audit_failed",
        "awaiting_delivery",
        "submitted_pending_review",
        "publisher_rejected",
        "preview_completed",
        "confirmed",
        "delivery_failed",
      ].includes(value.state) &&
      value.auditArtifactId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["auditArtifactId"],
        message: "Audited target state requires an audit artifact ID",
      });
    }
    if (
      [
        "awaiting_delivery",
        "submitted_pending_review",
        "publisher_rejected",
        "preview_completed",
        "confirmed",
        "delivery_failed",
      ].includes(value.state) &&
      value.publicationJobId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["publicationJobId"],
        message: "Delivery target state requires a publication job ID",
      });
    }
    if (
      ["audit_failed", "publisher_rejected", "blocked", "failed", "delivery_failed"].includes(
        value.state,
      ) &&
      value.errorCode === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Failure target state requires an error code",
      });
    }
  });

export const automationReconcileCommandSchema = z.strictObject({
  producerId: producerIdSchema,
  attempt: attemptSchema,
  retryAfter: isoDateTimeSchema.optional(),
  errorCode: errorCodeSchema.optional(),
  errorMessage: z.string().trim().min(1).max(4_000).optional(),
});

export const automationCancelCommandSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const automationTargetAssignmentCommandSchema = z.strictObject({
  channelAccountId: idSchema,
});

export const automationTargetManualRemediationCommandSchema = z.strictObject({
  actions: z
    .array(automationManualRemediationActionSchema)
    .min(1)
    .max(2)
    .refine((actions) => new Set(actions).size === actions.length, "Actions must be unique"),
});

export function scopedWorkerId(actorId: string, producerId: string): string {
  return `${actorId}:${producerId}`;
}
