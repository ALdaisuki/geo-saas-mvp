import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  capabilitiesForRole,
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
