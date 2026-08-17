import { ctripPublicContentHash, normalizeCtripPublicContent, sha256Canonical } from "@geo/core";
import { sql, type Kysely } from "kysely";

import { withTenantTransaction } from "./context.js";
import type { Database } from "./types.js";

export const HISTORICAL_PUBLICATION_BINDING_SCHEMA_VERSION =
  "geo.historical-publication-binding.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CTRIP_ARTICLE_ID_PATTERN = /^\d{1,20}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CTRIP_PUBLIC_ORIGIN = "https://m.ctrip.com";
const CTRIP_PUBLIC_PATH = "/webapp/you/community/detail";
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface HistoricalPublicationBindingManifest {
  readonly schemaVersion: typeof HISTORICAL_PUBLICATION_BINDING_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly actorId: string;
  readonly channelAccountId: string;
  readonly platform: "ctrip_community";
  readonly idempotencyKey: string;
  readonly externalId: string;
  readonly externalUrl: string;
  readonly title: string;
  readonly body: string;
  readonly publicContentHash: string;
  readonly publishedAt: string | null;
  readonly observedAt: string;
  readonly evidence: {
    readonly sha256: string;
    readonly reference: string;
  };
}

export interface NormalizedHistoricalPublicationBinding {
  readonly schemaVersion: typeof HISTORICAL_PUBLICATION_BINDING_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly actorId: string;
  readonly channelAccountId: string;
  readonly platform: "ctrip_community";
  readonly idempotencyKey: string;
  readonly externalId: string;
  readonly externalUrl: string;
  readonly normalizedTitle: string;
  readonly normalizedBody: string;
  readonly publicContentHash: string;
  readonly publishedAt: string | null;
  readonly observedAt: string;
  readonly sourceEvidenceHash: string;
  readonly sourceReference: string;
}

export interface HistoricalPublicationBindingResult {
  readonly historicalPublicationId: string;
  readonly auditLogId: string;
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly externalId: string;
  readonly externalUrl: string;
  readonly publicContentHash: string;
  readonly requestHash: string;
  readonly wasCreated: boolean;
}

export interface HistoricalPublicationBindingOutput extends HistoricalPublicationBindingResult {
  readonly event: "historical_publication_binding.completed";
}

function plainRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  name: string,
): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(record);
  const unexpected = actual.filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(record, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${name} keys are invalid (missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"})`,
    );
  }
}

function stringValue(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new TypeError(`${name} must be a well-formed string`);
  }
  if (value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${name} must contain 1 to ${maximumLength} characters`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function boundedPrintable(value: unknown, name: string, maximumLength: number): string {
  const result = stringValue(value, name, maximumLength).trim();
  if (result.length === 0 || containsControlCharacter(result)) {
    throw new TypeError(`${name} must contain bounded printable text`);
  }
  return result;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a canonical UTC ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

export function canonicalCtripPublicArticleUrl(externalId: string): string {
  if (!CTRIP_ARTICLE_ID_PATTERN.test(externalId)) {
    throw new TypeError("externalId must contain 1 to 20 digits");
  }
  const url = new URL(CTRIP_PUBLIC_PATH, CTRIP_PUBLIC_ORIGIN);
  url.searchParams.set("articleId", externalId);
  return url.toString();
}

function validateExternalUrl(value: unknown, externalId: string): string {
  const externalUrl = stringValue(value, "externalUrl", 2_000);
  let parsed: URL;
  try {
    parsed = new URL(externalUrl);
  } catch {
    throw new TypeError("externalUrl must be a valid URL");
  }
  const articleIds = parsed.searchParams.getAll("articleId");
  const queryKeys = [...parsed.searchParams.keys()];
  const expected = canonicalCtripPublicArticleUrl(externalId);
  if (
    parsed.origin !== CTRIP_PUBLIC_ORIGIN ||
    parsed.pathname !== CTRIP_PUBLIC_PATH ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    articleIds.length !== 1 ||
    articleIds[0] !== externalId ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== "articleId" ||
    externalUrl !== expected
  ) {
    throw new TypeError("externalUrl must be the canonical public Ctrip URL for externalId");
  }
  return expected;
}

export function normalizeHistoricalPublicationBinding(
  value: unknown,
  now: Date = new Date(),
): NormalizedHistoricalPublicationBinding {
  const record = plainRecord(value, "historical publication binding manifest");
  exactKeys(
    record,
    [
      "schemaVersion",
      "tenantId",
      "actorId",
      "channelAccountId",
      "platform",
      "idempotencyKey",
      "externalId",
      "externalUrl",
      "title",
      "body",
      "publicContentHash",
      "publishedAt",
      "observedAt",
      "evidence",
    ],
    "historical publication binding manifest",
  );
  if (record.schemaVersion !== HISTORICAL_PUBLICATION_BINDING_SCHEMA_VERSION) {
    throw new TypeError("historical publication binding schemaVersion is unsupported");
  }
  if (record.platform !== "ctrip_community") {
    throw new TypeError("historical publication binding platform must be ctrip_community");
  }
  const idempotencyKey = boundedPrintable(record.idempotencyKey, "idempotencyKey", 200);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new TypeError(
      "idempotencyKey must use 8-200 letters, digits, dots, colons, underscores or hyphens",
    );
  }
  const externalId = stringValue(record.externalId, "externalId", 20);
  if (!CTRIP_ARTICLE_ID_PATTERN.test(externalId)) {
    throw new TypeError("externalId must contain 1 to 20 digits");
  }
  const normalizedTitle = normalizeCtripPublicContent(stringValue(record.title, "title", 2_000));
  const normalizedBody = normalizeCtripPublicContent(stringValue(record.body, "body", 1_500_000));
  if (normalizedTitle.length === 0 || normalizedTitle.length > 1_000) {
    throw new TypeError("normalized title must contain 1 to 1000 characters");
  }
  if (normalizedBody.length === 0 || normalizedBody.length > 1_000_000) {
    throw new TypeError("normalized body must contain 1 to 1000000 characters");
  }
  if (containsControlCharacter(normalizedTitle) || containsControlCharacter(normalizedBody)) {
    throw new TypeError("normalized public content contains unsupported control characters");
  }
  const publicContentHash = sha256(record.publicContentHash, "publicContentHash");
  if (ctripPublicContentHash(normalizedTitle, normalizedBody) !== publicContentHash) {
    throw new TypeError("publicContentHash does not match the supplied normalized title and body");
  }
  const observedAt = isoTimestamp(record.observedAt, "observedAt");
  if (Date.parse(observedAt) > now.getTime() + FUTURE_CLOCK_SKEW_MS) {
    throw new TypeError("observedAt cannot be more than five minutes in the future");
  }
  const publishedAt =
    record.publishedAt === null ? null : isoTimestamp(record.publishedAt, "publishedAt");
  if (publishedAt !== null && Date.parse(publishedAt) > Date.parse(observedAt)) {
    throw new TypeError("publishedAt cannot be later than observedAt");
  }
  const evidence = plainRecord(record.evidence, "evidence");
  exactKeys(evidence, ["sha256", "reference"], "evidence");

  return {
    schemaVersion: HISTORICAL_PUBLICATION_BINDING_SCHEMA_VERSION,
    tenantId: uuid(record.tenantId, "tenantId"),
    actorId: uuid(record.actorId, "actorId"),
    channelAccountId: uuid(record.channelAccountId, "channelAccountId"),
    platform: "ctrip_community",
    idempotencyKey,
    externalId,
    externalUrl: validateExternalUrl(record.externalUrl, externalId),
    normalizedTitle,
    normalizedBody,
    publicContentHash,
    publishedAt,
    observedAt,
    sourceEvidenceHash: sha256(evidence.sha256, "evidence.sha256"),
    sourceReference: boundedPrintable(evidence.reference, "evidence.reference", 2_000),
  };
}

export function historicalPublicationBindingRequestHash(
  input: Readonly<NormalizedHistoricalPublicationBinding>,
): string {
  return sha256Canonical(input);
}

interface BindingRow {
  readonly historical_publication_id: string;
  readonly binding_audit_log_id: string;
  readonly was_created: boolean;
}

export async function bindHistoricalPublication(
  database: Kysely<Database>,
  manifest: unknown,
): Promise<HistoricalPublicationBindingResult> {
  const input = normalizeHistoricalPublicationBinding(manifest);
  const requestHash = historicalPublicationBindingRequestHash(input);
  const row = await withTenantTransaction(
    database,
    {
      tenantId: input.tenantId,
      actorId: input.actorId,
      requestId: input.idempotencyKey,
    },
    async (transaction) => {
      const result = await sql<BindingRow>`
        select * from geo.bind_historical_publication(
          ${input.channelAccountId}::uuid,
          ${input.externalId},
          ${input.externalUrl},
          ${input.normalizedTitle},
          ${input.normalizedBody},
          ${input.publicContentHash}::geo.sha256_hex,
          ${input.publishedAt}::timestamptz,
          ${input.observedAt}::timestamptz,
          ${input.sourceEvidenceHash}::geo.sha256_hex,
          ${input.sourceReference},
          ${input.idempotencyKey},
          ${requestHash}::geo.sha256_hex
        )
      `.execute(transaction);
      if (result.rows.length !== 1 || result.rows[0] === undefined) {
        throw new Error("Historical publication binding returned no unique receipt");
      }
      return result.rows[0];
    },
  );
  return {
    historicalPublicationId: row.historical_publication_id,
    auditLogId: row.binding_audit_log_id,
    tenantId: input.tenantId,
    channelAccountId: input.channelAccountId,
    externalId: input.externalId,
    externalUrl: input.externalUrl,
    publicContentHash: input.publicContentHash,
    requestHash,
    wasCreated: row.was_created,
  };
}

export function formatHistoricalPublicationBindingOutput(
  result: Readonly<HistoricalPublicationBindingResult>,
): HistoricalPublicationBindingOutput {
  return { event: "historical_publication_binding.completed", ...result };
}

export function loadHistoricalPublicationDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment.DATABASE_ADMIN_URL?.trim();
  if (value === undefined || value.length === 0) throw new Error("DATABASE_ADMIN_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_ADMIN_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  return value;
}
