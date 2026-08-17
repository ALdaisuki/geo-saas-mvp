import { createHash } from "node:crypto";

import { invariant } from "./errors.js";

function assertWellFormed(value: string, path: string): void {
  invariant(
    value.isWellFormed(),
    "CANONICAL_JSON_UNSUPPORTED",
    `Canonical JSON rejects ill-formed Unicode at ${path}`,
    { path },
  );
}

function encodeString(value: string, path: string): string {
  assertWellFormed(value, path);
  const encoded = JSON.stringify(value);
  invariant(
    encoded !== undefined,
    "CANONICAL_JSON_UNSUPPORTED",
    `Unable to encode string at ${path}`,
    { path },
  );
  return encoded;
}

function unsupported(path: string, value: unknown): never {
  const valueType = value === null ? "null" : typeof value;
  invariant(
    false,
    "CANONICAL_JSON_UNSUPPORTED",
    `Canonical JSON does not support ${valueType} at ${path}`,
    { path, valueType },
  );
}

function serialize(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return encodeString(value, path);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    invariant(
      Number.isFinite(value),
      "CANONICAL_JSON_UNSUPPORTED",
      `Canonical JSON requires a finite number at ${path}`,
      { path },
    );
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object") {
    return unsupported(path, value);
  }

  invariant(
    !ancestors.has(value),
    "CANONICAL_JSON_UNSUPPORTED",
    `Canonical JSON rejects circular data at ${path}`,
    { path },
  );
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        invariant(
          descriptor !== undefined && "value" in descriptor,
          "CANONICAL_JSON_UNSUPPORTED",
          `Canonical JSON rejects sparse or accessor arrays at ${path}[${index}]`,
          { path, index },
        );
        parts.push(serialize(descriptor.value, `${path}[${index}]`, ancestors));
      }
      const unexpectedKeys = Object.keys(value).filter((key) => !/^(0|[1-9]\d*)$/.test(key));
      invariant(
        unexpectedKeys.length === 0,
        "CANONICAL_JSON_UNSUPPORTED",
        `Canonical JSON rejects named array properties at ${path}`,
        { path, unexpectedKeys },
      );
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    invariant(
      prototype === Object.prototype || prototype === null,
      "CANONICAL_JSON_UNSUPPORTED",
      `Canonical JSON requires a plain object at ${path}`,
      { path },
    );

    const symbolKeys = Object.getOwnPropertySymbols(value);
    invariant(
      symbolKeys.length === 0,
      "CANONICAL_JSON_UNSUPPORTED",
      `Canonical JSON rejects symbol keys at ${path}`,
      { path },
    );

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const parts = keys.map((key) => {
      const descriptor = descriptors[key];
      invariant(
        descriptor !== undefined && descriptor.enumerable && "value" in descriptor,
        "CANONICAL_JSON_UNSUPPORTED",
        `Canonical JSON rejects hidden or accessor properties at ${path}.${key}`,
        { path, key },
      );
      const keyPath = `${path}.${key}`;
      return `${encodeString(key, keyPath)}:${serialize(descriptor.value, keyPath, ancestors)}`;
    });
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonicalizes the strict JSON data model using ECMAScript number encoding and UTF-16 key order. */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new WeakSet<object>());
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
