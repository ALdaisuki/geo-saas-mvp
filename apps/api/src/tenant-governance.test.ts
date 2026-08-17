import { describe, expect, it } from "vitest";

import {
  assertMemberManagementAllowed,
  assertPolicyTransitionAllowed,
  normalizeContactValue,
  resolveCtripRuntimeEvidence,
  TenantGovernanceInvariantError,
  validateEffectiveChannelAccount,
} from "./tenant-governance.js";

describe("tenant governance invariants", () => {
  it("normalizes contact identities without changing their displayed values", () => {
    expect(normalizeContactValue("phone", "400-000-0001")).toBe("4000000001");
    expect(normalizeContactValue("wechat", " TRAVEL_DEMO_01 ")).toBe("travel_demo_01");
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
        platform: "toutiao",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run", "assisted"],
      }),
    ).toThrow(TenantGovernanceInvariantError);
    expect(() =>
      validateEffectiveChannelAccount({
        platform: "toutiao",
        capability: "public_api",
        supportedExecutionLevels: ["dry_run", "unattended"],
      }),
    ).not.toThrow();
  });

  it("allows browser-assisted unattended execution on every supported platform", () => {
    expect(() =>
      validateEffectiveChannelAccount({
        platform: "ctrip_community",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
      }),
    ).not.toThrow();
    expect(() =>
      validateEffectiveChannelAccount({
        platform: "toutiao",
        capability: "browser_assisted",
        supportedExecutionLevels: ["dry_run", "assisted", "unattended"],
      }),
    ).not.toThrow();
  });

  it("preserves stronger Ctrip evidence when the browser editor becomes ready", () => {
    expect(
      resolveCtripRuntimeEvidence({
        currentEvidenceType: "platform_readback",
        currentEvidenceRefs: [
          "platform-canary-readback",
          "adapter:ctrip-community-browser-unattended-v1",
        ],
        runtimeReady: true,
      }),
    ).toEqual({
      evidenceType: "platform_readback",
      evidenceRefs: ["platform-canary-readback", "adapter:ctrip-community-browser-unattended-v1"],
    });

    expect(
      resolveCtripRuntimeEvidence({
        currentEvidenceType: "manual_import",
        currentEvidenceRefs: ["operator-confirmed-login"],
        runtimeReady: true,
      }),
    ).toEqual({
      evidenceType: "browser_screenshot",
      evidenceRefs: ["browser-runtime-readiness"],
    });
  });
});
