import { describe, expect, it } from "vitest";

import {
  buildBaselineAuditPolicyDocument,
  geoAuditPolicyDocumentSchema,
  sha256Canonical,
} from "@geo/core";

import { assertPolicyBundleCompilesForActivation } from "./postgres-tenant-governance-repository.js";

function legacyFivePlatformPolicyDocument(): Readonly<Record<string, unknown>> {
  const document = structuredClone(
    buildBaselineAuditPolicyDocument({
      rulesVersion: "legacy-five-platform-v2",
      industry: "travel",
    }),
  ) as unknown as Record<string, unknown>;
  const audit = document.audit as Record<string, unknown>;
  audit.hardBlockRules = { categories: { absolute_efficacy: ["legacy-only"] } };
  return document;
}

describe("policy activation compatibility", () => {
  it("lets the hash-bound compiler expand a legacy document before activation", () => {
    const document = legacyFivePlatformPolicyDocument();
    expect(geoAuditPolicyDocumentSchema.safeParse(document).success).toBe(false);

    expect(() =>
      assertPolicyBundleCompilesForActivation({
        version: "legacy-five-platform-v2",
        policyHash: sha256Canonical(document),
        document,
      }),
    ).not.toThrow();
  });

  it("still rejects a legacy document whose stored hash does not match", () => {
    const document = legacyFivePlatformPolicyDocument();

    expect(() =>
      assertPolicyBundleCompilesForActivation({
        version: "legacy-five-platform-v2",
        policyHash: "0".repeat(64),
        document,
      }),
    ).toThrow("hash does not match");
  });
});
