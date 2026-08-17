import { describe, expect, it } from "vitest";

import {
  automationProducerCapabilities,
  AuthorizationError,
  capabilitiesForRole,
  ctripBridgeCapabilities,
  requireCapability,
  requireTenantScope,
} from "./index.js";

describe("tenant authorization", () => {
  it("keeps roles on memberships and grants publishers only publication operations", () => {
    const capabilities = capabilitiesForRole("publisher");

    expect(capabilities).toContain("publish:request");
    expect(capabilities).not.toContain("tenant:manage");
    expect(capabilities).not.toContain("grant:revoke");
  });

  it("does not let an agent-style editor publish or manage automation", () => {
    const capabilities = capabilitiesForRole("editor");

    expect(() => requireCapability({ capabilities }, "publish:request")).toThrow(
      AuthorizationError,
    );
    expect(() => requireCapability({ capabilities }, "automation:manage")).toThrow(
      AuthorizationError,
    );
    expect(() => requireCapability({ capabilities }, "automation:execute")).toThrow(
      AuthorizationError,
    );
  });

  it("grants automation execution to the dedicated automation operator", () => {
    expect(capabilitiesForRole("owner")).toContain("automation:execute");
    expect(capabilitiesForRole("admin")).toContain("automation:execute");
    expect(capabilitiesForRole("automation_operator")).toContain("automation:execute");
    expect(capabilitiesForRole("publisher")).not.toContain("automation:execute");
  });

  it("limits principal management to tenant owners and admins", () => {
    expect(capabilitiesForRole("owner")).toContain("principal:manage");
    expect(capabilitiesForRole("admin")).toContain("principal:manage");
    expect(capabilitiesForRole("editor")).not.toContain("principal:manage");
    expect(capabilitiesForRole("publisher")).not.toContain("principal:manage");
  });

  it("uses a fixed least-privilege profile for unattended automation producers", () => {
    expect(capabilitiesForRole("automation_operator")).toEqual(automationProducerCapabilities);
    expect(automationProducerCapabilities).toContain("automation:execute");
    expect(automationProducerCapabilities).toContain("content:write");
    expect(automationProducerCapabilities).toContain("audit:run");
    expect(automationProducerCapabilities).toContain("publish:request");
    expect(automationProducerCapabilities).not.toContain("tenant:manage");
    expect(automationProducerCapabilities).not.toContain("member:manage");
    expect(automationProducerCapabilities).not.toContain("principal:manage");
    expect(automationProducerCapabilities).not.toContain("automation:manage");
    expect(automationProducerCapabilities).not.toContain("publish:bridge");
    expect(automationProducerCapabilities).not.toContain("publish:cancel");
  });

  it("reserves Ctrip bridge execution for the fixed integration profile", () => {
    expect(ctripBridgeCapabilities).toEqual(["tenant:read", "content:read", "publish:bridge"]);
    for (const role of [
      "owner",
      "admin",
      "editor",
      "auditor",
      "publisher",
      "automation_operator",
      "viewer",
    ] as const) {
      expect(capabilitiesForRole(role)).not.toContain("publish:bridge");
    }
    expect(automationProducerCapabilities).not.toContain("publish:bridge");
  });

  it("rejects cross-tenant resource scope before repository access", () => {
    expect(() =>
      requireTenantScope(
        { tenantId: "00000000-0000-4000-8000-000000000001" },
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toThrow("outside the authenticated tenant scope");
  });
});
