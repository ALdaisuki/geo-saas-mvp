import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Canonical, sha256Text } from "./canonical.js";
import { CoreInvariantError } from "./errors.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: [3, { beta: true, alpha: null }], a: "value", n: -0 })).toBe(
      '{"a":"value","n":0,"z":[3,{"alpha":null,"beta":true}]}',
    );
  });

  it("produces stable SHA-256 values independent of insertion order", () => {
    const first = { platform: "toutiao", nested: { b: 2, a: 1 } };
    const second = { nested: { a: 1, b: 2 }, platform: "toutiao" };

    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it.each([
    ["undefined", { value: undefined }],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["bigint", { value: 1n }],
    ["class instance", new Date("2026-07-13T00:00:00.000Z")],
  ])("rejects %s instead of silently changing signed data", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CoreInvariantError);
  });

  it("rejects circular values", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_UNSUPPORTED" }),
    );
  });
});
