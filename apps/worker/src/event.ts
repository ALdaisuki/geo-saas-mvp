import type { ExecutionLevel, Platform } from "@geo/contracts";

import { PermanentWorkerError } from "./errors.js";
import type { PublicationRequestedPayload } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set<Platform>([
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
  "zhihu",
]);
const EXECUTION_LEVELS = new Set<ExecutionLevel>(["dry_run", "assisted", "unattended"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new PermanentWorkerError("INVALID_OUTBOX_PAYLOAD", `${field} must be a UUID`);
  }
  return value;
}

export function parsePublicationRequestedPayload(value: unknown): PublicationRequestedPayload {
  if (!isRecord(value)) {
    throw new PermanentWorkerError(
      "INVALID_OUTBOX_PAYLOAD",
      "publication.requested payload must be an object",
    );
  }

  const platform = value.platform;
  const executionLevel = value.executionLevel;
  const payloadHash = value.payloadHash;
  if (typeof platform !== "string" || !PLATFORMS.has(platform as Platform)) {
    throw new PermanentWorkerError("INVALID_OUTBOX_PAYLOAD", "platform is invalid");
  }
  if (
    typeof executionLevel !== "string" ||
    !EXECUTION_LEVELS.has(executionLevel as ExecutionLevel)
  ) {
    throw new PermanentWorkerError("INVALID_OUTBOX_PAYLOAD", "executionLevel is invalid");
  }
  if (typeof payloadHash !== "string" || !SHA256_PATTERN.test(payloadHash)) {
    throw new PermanentWorkerError("INVALID_OUTBOX_PAYLOAD", "payloadHash must be SHA-256");
  }

  return {
    tenantId: requireUuid(value.tenantId, "tenantId"),
    jobId: requireUuid(value.jobId, "jobId"),
    variantId: requireUuid(value.variantId, "variantId"),
    channelAccountId: requireUuid(value.channelAccountId, "channelAccountId"),
    platform: platform as Platform,
    executionLevel: executionLevel as ExecutionLevel,
    payloadHash,
  };
}
