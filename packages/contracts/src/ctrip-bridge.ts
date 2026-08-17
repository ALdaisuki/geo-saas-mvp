import { z } from "zod";

const idSchema = z.string().uuid();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const requestIdSchema = z.string().trim().min(1).max(200);

export const ctripBrowserLoginNavigationRequestSchema = z.strictObject({
  schemaVersion: z.literal("geo.ctrip-browser-login-navigation.request.v1"),
  tenantId: idSchema,
  channelAccountId: idSchema,
  requestId: requestIdSchema,
});
export type CtripBrowserLoginNavigationRequest = z.infer<
  typeof ctripBrowserLoginNavigationRequestSchema
>;

export const ctripBrowserLoginNavigationResultSchema = z.strictObject({
  schemaVersion: z.literal("geo.ctrip-browser-login-navigation.result.v1"),
  tenantId: idSchema,
  channelAccountId: idSchema,
  targetUrl: z.string().url().max(2_000),
  currentUrl: z.string().url().max(2_000),
});
export type CtripBrowserLoginNavigationResult = z.infer<
  typeof ctripBrowserLoginNavigationResultSchema
>;

const commandBase = {
  schemaVersion: z.literal("geo.ctrip-bridge.command.v1"),
  tenantId: idSchema,
  handoffId: idSchema,
  requestId: requestIdSchema,
};

export const ctripBridgeCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...commandBase, command: z.literal("prepare") }),
  z.strictObject({
    ...commandBase,
    command: z.literal("submit"),
    submitPermit: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({ ...commandBase, command: z.literal("readback") }),
]);
export type CtripBridgeCommand = z.infer<typeof ctripBridgeCommandSchema>;

export const ctripBridgeEvidenceKindSchema = z.enum([
  "simulation",
  "browser",
  "creator_management",
  "platform_readback",
]);
export type CtripBridgeEvidenceKind = z.infer<typeof ctripBridgeEvidenceKindSchema>;

const resultBase = {
  schemaVersion: z.literal("geo.ctrip-bridge.result.v1"),
  tenantId: idSchema,
  handoffId: idSchema,
  bridgePrincipalId: idSchema,
  adapterVersion: z.string().trim().min(1).max(100),
  observedAt: isoDateTimeSchema,
  evidenceHash: sha256Schema,
};

const ctripBridgePrepareResultSchema = z.strictObject({
  ...resultBase,
  command: z.literal("prepare"),
  outcome: z.enum([
    "prepared",
    "session_required",
    "challenge_required",
    "adapter_drift",
    "payload_invalid",
  ]),
  evidenceKind: z.enum(["simulation", "browser"]),
  state: z.enum(["draft_prepared", "session_required", "challenge_required", "failed"]),
});

const ctripBridgeSubmitReadbackResultSchema = z.strictObject({
  ...resultBase,
  command: z.literal("submit"),
  outcome: z.enum(["accepted", "uncertain", "rejected"]),
  evidenceKind: z.enum(["simulation", "browser"]),
  state: z.literal("readback_pending"),
  receiptId: idSchema,
  readbackId: idSchema,
});

const ctripBridgeSubmitNotAcceptedResultSchema = z.strictObject({
  ...resultBase,
  command: z.literal("submit"),
  outcome: z.literal("not_accepted"),
  evidenceKind: z.literal("browser"),
  state: z.literal("needs_review"),
  receiptId: z.null(),
  readbackId: z.null(),
});

const ctripBridgeReadbackResultSchema = z.strictObject({
  ...resultBase,
  command: z.literal("readback"),
  outcome: z.enum([
    "publisher_confirmed",
    "publisher_rejected",
    "confirmed",
    "not_found",
    "mismatch",
    "unavailable",
    "simulation_only",
  ]),
  evidenceKind: ctripBridgeEvidenceKindSchema,
  state: z.enum(["readback_pending", "confirmed", "needs_review"]),
  externalId: z.string().trim().min(1).max(500).nullable(),
  externalUrl: z.string().trim().url().max(2_000).nullable(),
  publisherReasonCode: z.string().trim().min(1).max(200).nullable().optional(),
});

export const ctripBridgeResultSchema = z.union([
  ctripBridgePrepareResultSchema,
  ctripBridgeSubmitReadbackResultSchema,
  ctripBridgeSubmitNotAcceptedResultSchema,
  ctripBridgeReadbackResultSchema,
]);
export type CtripBridgeResult = z.infer<typeof ctripBridgeResultSchema>;

export const ctripBridgeHealthSchema = z.strictObject({
  status: z.literal("ok"),
  service: z.literal("geo-ctrip-bridge"),
  mode: z.enum([
    "simulator",
    "browser_preflight",
    "browser_draft",
    "browser_supervised",
    "browser_unattended",
  ]),
  adapterVersion: z.string().trim().min(1).max(100),
  commandCapabilities: z.strictObject({
    prepare: z.boolean(),
    submit: z.boolean(),
    readback: z.boolean(),
  }),
});
export type CtripBridgeHealth = z.infer<typeof ctripBridgeHealthSchema>;
