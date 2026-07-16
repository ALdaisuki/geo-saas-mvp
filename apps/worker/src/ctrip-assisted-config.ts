export interface CtripAssistedAccountConfig {
  readonly tenantId: string;
  readonly channelAccountId: string;
  readonly adapterVersion: string;
  readonly evidenceExpiresAt: string;
  readonly handoffTtlSeconds: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_KEYS = new Set([
  "tenantId",
  "channelAccountId",
  "adapterVersion",
  "evidenceExpiresAt",
  "handoffTtlSeconds",
]);

function recordValue(value: unknown, index: number): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Ctrip assisted account ${index} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string, index: number): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new TypeError(`Ctrip assisted account ${index}.${key} must be a non-empty string`);
  }
  return field.trim();
}

export function parseCtripAssistedAccounts(
  raw: string | undefined,
): readonly CtripAssistedAccountConfig[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("CTRIP_ASSISTED_ACCOUNTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new TypeError("CTRIP_ASSISTED_ACCOUNTS_JSON must contain at most 100 account mappings");
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const value = recordValue(entry, index);
    const unknownKey = Object.keys(value).find((key) => !ALLOWED_KEYS.has(key));
    if (unknownKey !== undefined) {
      throw new TypeError(`Ctrip assisted account ${index} contains unknown key ${unknownKey}`);
    }
    const tenantId = stringField(value, "tenantId", index);
    const channelAccountId = stringField(value, "channelAccountId", index);
    const adapterVersion = stringField(value, "adapterVersion", index);
    const evidenceExpiresAt = stringField(value, "evidenceExpiresAt", index);
    const handoffTtlSeconds = value.handoffTtlSeconds ?? 900;
    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(channelAccountId)) {
      throw new TypeError(`Ctrip assisted account ${index} must use UUID tenant/account ids`);
    }
    if (adapterVersion.length > 100) {
      throw new TypeError(`Ctrip assisted account ${index}.adapterVersion is too long`);
    }
    if (!Number.isFinite(Date.parse(evidenceExpiresAt))) {
      throw new TypeError(`Ctrip assisted account ${index}.evidenceExpiresAt is invalid`);
    }
    if (
      typeof handoffTtlSeconds !== "number" ||
      !Number.isInteger(handoffTtlSeconds) ||
      handoffTtlSeconds < 60 ||
      handoffTtlSeconds > 7_200
    ) {
      throw new TypeError(
        `Ctrip assisted account ${index}.handoffTtlSeconds must be an integer from 60 to 7200`,
      );
    }
    const scopeKey = `${tenantId}:${channelAccountId}`;
    if (seen.has(scopeKey)) {
      throw new TypeError(`Duplicate Ctrip assisted account mapping for ${scopeKey}`);
    }
    seen.add(scopeKey);
    return { tenantId, channelAccountId, adapterVersion, evidenceExpiresAt, handoffTtlSeconds };
  });
}
