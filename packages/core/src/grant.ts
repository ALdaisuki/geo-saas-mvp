import { timingSafeEqual } from "node:crypto";

import type { AuditArtifact, Platform, PublicationGrant } from "@geo/contracts";

import { verifyAuditArtifactIntegrity } from "./audit.js";
import { sha256Text } from "./canonical.js";
import { invariant } from "./errors.js";
import { assertSha256, assertUuid, freezeDeep, parseInstant } from "./validation.js";

export interface PublicationGrantBinding {
  readonly tenantId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly payloadHash: string;
  readonly auditHash: string;
}

export interface IssuePublicationGrantInput {
  readonly grantId: string;
  readonly auditArtifact: Readonly<AuditArtifact>;
  readonly token: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

export interface ValidatePublicationGrantInput {
  readonly grant: Readonly<PublicationGrant>;
  readonly token: string;
  readonly now: string;
  readonly binding: PublicationGrantBinding;
}

export interface ConsumePublicationGrantInput {
  readonly grant: Readonly<PublicationGrant>;
  readonly token: string;
  readonly consumedAt: string;
  readonly binding: PublicationGrantBinding;
}

const MIN_TOKEN_BYTES = 32;

function tokenMatches(token: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(sha256Text(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bindingMatches(
  grant: Readonly<PublicationGrant>,
  binding: PublicationGrantBinding,
): boolean {
  return (
    grant.tenantId === binding.tenantId &&
    grant.variantId === binding.variantId &&
    grant.channelAccountId === binding.channelAccountId &&
    grant.platform === binding.platform &&
    grant.payloadHash === binding.payloadHash &&
    grant.auditHash === binding.auditHash
  );
}

export function issuePublicationGrant(
  input: IssuePublicationGrantInput,
): Readonly<PublicationGrant> {
  assertUuid(input.grantId, "grantId");
  invariant(
    verifyAuditArtifactIntegrity(input.auditArtifact),
    "AUDIT_INTEGRITY_FAILED",
    "Audit artifact integrity check failed",
  );
  invariant(
    input.auditArtifact.status === "passed",
    "AUDIT_NOT_PASSED",
    "Publication grants require a passed audit",
  );
  invariant(
    Buffer.byteLength(input.token, "utf8") >= MIN_TOKEN_BYTES,
    "GRANT_TOKEN_TOO_SHORT",
    `Publication token must contain at least ${MIN_TOKEN_BYTES} bytes`,
  );

  const issuedAt = parseInstant(input.issuedAt, "issuedAt");
  const auditCreatedAt = parseInstant(input.auditArtifact.createdAt, "auditArtifact.createdAt");
  const auditExpiresAt = parseInstant(input.auditArtifact.expiresAt, "auditArtifact.expiresAt");
  invariant(issuedAt >= auditCreatedAt, "GRANT_ISSUED_BEFORE_AUDIT", "Grant predates its audit");
  invariant(issuedAt < auditExpiresAt, "AUDIT_EXPIRED", "Audit artifact has expired");

  const expiresAtValue = input.expiresAt ?? input.auditArtifact.expiresAt;
  const expiresAt = parseInstant(expiresAtValue, "expiresAt");
  invariant(expiresAt > issuedAt, "GRANT_EXPIRY_INVALID", "Grant expiry must follow issuance");
  invariant(
    expiresAt <= auditExpiresAt,
    "GRANT_EXPIRY_INVALID",
    "Grant cannot outlive its audit artifact",
  );

  return freezeDeep({
    id: input.grantId,
    tenantId: input.auditArtifact.tenantId,
    variantId: input.auditArtifact.variantId,
    channelAccountId: input.auditArtifact.channelAccountId,
    platform: input.auditArtifact.platform,
    payloadHash: input.auditArtifact.payloadHash,
    auditHash: input.auditArtifact.auditHash,
    tokenHash: sha256Text(input.token),
    status: "issued",
    issuedAt: input.issuedAt,
    expiresAt: expiresAtValue,
    consumedAt: null,
  });
}

export function validatePublicationGrant(input: ValidatePublicationGrantInput): true {
  assertUuid(input.grant.id, "grant.id");
  assertSha256(input.grant.tokenHash, "grant.tokenHash");
  invariant(
    input.grant.status === "issued" && input.grant.consumedAt === null,
    "GRANT_NOT_ISSUED",
    "Publication grant is not available for consumption",
    { status: input.grant.status },
  );
  const now = parseInstant(input.now, "now");
  const issuedAt = parseInstant(input.grant.issuedAt, "grant.issuedAt");
  const expiresAt = parseInstant(input.grant.expiresAt, "grant.expiresAt");
  invariant(now >= issuedAt, "GRANT_NOT_YET_VALID", "Publication grant is not valid yet");
  invariant(now < expiresAt, "GRANT_EXPIRED", "Publication grant has expired");
  invariant(
    tokenMatches(input.token, input.grant.tokenHash),
    "GRANT_TOKEN_MISMATCH",
    "Publication grant token does not match",
  );
  invariant(
    bindingMatches(input.grant, input.binding),
    "GRANT_BINDING_MISMATCH",
    "Publication grant is bound to a different final variant or audit",
  );
  return true;
}

export function consumePublicationGrant(
  input: ConsumePublicationGrantInput,
): Readonly<PublicationGrant> {
  validatePublicationGrant({
    grant: input.grant,
    token: input.token,
    now: input.consumedAt,
    binding: input.binding,
  });
  return freezeDeep({
    ...input.grant,
    status: "consumed",
    consumedAt: input.consumedAt,
  });
}
