import { invariant } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function assertUuid(value: string, field: string): void {
  invariant(UUID_PATTERN.test(value), "INVALID_UUID", `${field} must be a UUID`, { field, value });
}

export function assertSha256(value: string, field: string): void {
  invariant(SHA256_PATTERN.test(value), "INVALID_SHA256", `${field} must be a lowercase SHA-256`, {
    field,
  });
}

export function parseInstant(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  invariant(
    Number.isFinite(milliseconds),
    "INVALID_TIMESTAMP",
    `${field} must be an ISO timestamp`,
    {
      field,
      value,
    },
  );
  return milliseconds;
}

export function assertNonNegativeInteger(value: number, field: string): void {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    "INVALID_NON_NEGATIVE_INTEGER",
    `${field} must be a non-negative safe integer`,
    { field, value },
  );
}

export function freezeDeep<T>(value: T): T {
  const seen = new WeakSet<object>();

  function freeze(current: unknown): void {
    if (current === null || typeof current !== "object" || seen.has(current)) {
      return;
    }
    seen.add(current);
    for (const child of Object.values(current)) {
      freeze(child);
    }
    Object.freeze(current);
  }

  freeze(value);
  return value;
}
