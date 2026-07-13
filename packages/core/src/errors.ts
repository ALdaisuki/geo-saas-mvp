export class CoreInvariantError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CoreInvariantError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) {
    throw new CoreInvariantError(code, message, details);
  }
}
