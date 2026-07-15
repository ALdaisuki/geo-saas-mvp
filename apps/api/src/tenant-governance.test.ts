import { describe, expect, it } from "vitest";

import {
  assertMemberManagementAllowed,
  assertPolicyTransitionAllowed,
  normalizeContactValue,
  TenantGovernanceInvariantError,
  validateEffectiveChannelAccount,
} from "./tenant-governance.js";

describe("tenant governance invariants", () => {
  it("normalizes contact identities without changing their displayed values", () => {
    expect(normalizeContactValue("phone", "400-113-3986")).toBe("4001133986");
    expect(normalizeContactValue("wechat", " ZTGL3411 ")).toBe("ztgl3411");
    expect(normalizeContactValue("email", " Service@Example.COM ")).toBe("service@example.com");
    expect(normalizeContactValue("website", "https://EXAMPLE.com/contact/")).toBe(
      "https://example.com/contact",
    );
  });

  it("prevents admins from creating, editing, or granting the owner role", () => {
    expect(() => assertMemberManagementAllowed("admin", null, "owner")).toThrow(
      TenantGovernanceInvariantError,
    );
    expect(() => assertMemberManagementAllowed("admin", "owner", "admin")).toThrow(
      TenantGovernanceInvariantError,
    );
    expect(() => assertMemberManagementAllowed("owner", "admin", "owner")).not.toThrow();
    expect(() => assertMemberManagementAllowed("admin", "editor", "publisher")).not.toThrow();
  });

  it("keeps policy lifecycle forward-only with idempotent replay", () => {
    expect(assertPolicyTransitionAllowed("draft", "active")).toBe(true);
    expect(assertPolicyTransitionAllowed("active", "active")).toBe(false);
    expect(assertPolicyTransitionAllowed("active", "retired")).toBe(true);
    expect(assertPolicyTransitionAllowed("retired", "retired")).toBe(false);
    expect(() => assertPolicyTransitionAllowed("retired", "active")).toThrow(
      TenantGovernanceInvariantError,
    );
  });

  it("validates the effective account after a partial metadata update", () => {
    expect(() =>
      validateEffectiveChannelAccount({
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run", "assisted"],
      }),
    ).toThrow(TenantGovernanceInvariantError);
    expect(() =>
      validateEffectiveChannelAccount({
        capability: "public_api",
        supportedExecutionLevels: ["dry_run", "unattended"],
      }),
    ).not.toThrow();
  });
});
