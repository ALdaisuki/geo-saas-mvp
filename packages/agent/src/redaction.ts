const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|session)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT = /\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const MAX_STRING_LENGTH = 8_000;
const MAX_DEPTH = 8;

function redactString(value: string): string {
  return value
    .slice(0, MAX_STRING_LENGTH)
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`);
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redact(entry, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

export function redactSensitiveDetails(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AgentPolicyError") {
    return "Operation denied by tenant policy";
  }
  return "Upstream operation failed";
}
