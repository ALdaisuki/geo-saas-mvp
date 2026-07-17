import { describe, expect, it } from "vitest";

import { createCustomerDemoGovernanceClient } from "./customer-demo-governance.js";
import { PlasticPromisePublicationGate } from "./publication-governance.js";

describe("customer demo governance", () => {
  it("allows non-external previews and simulations but denies unattended publication", async () => {
    const gate = new PlasticPromisePublicationGate(createCustomerDemoGovernanceClient());
    const base = {
      phase: "pre_authorization" as const,
      tenantId: "10000000-0000-4000-8000-000000000001",
      actorId: "10000000-0000-4000-8000-000000000101",
      resourceId: "10000000-0000-4000-8000-000000000703",
      requestFingerprint: "customer-demo",
    };

    await expect(gate.evaluate({ ...base, executionLevel: "dry_run" })).resolves.toMatchObject({
      allowed: true,
      reason: "allowed",
    });
    await expect(gate.evaluate({ ...base, executionLevel: "assisted" })).resolves.toMatchObject({
      allowed: true,
      reason: "allowed",
    });
    await expect(gate.evaluate({ ...base, executionLevel: "unattended" })).resolves.toMatchObject({
      allowed: false,
      reason: "audit_pre_check_denied",
    });
  });

  it("returns a visibly labelled tenant-only context", async () => {
    await expect(
      createCustomerDemoGovernanceClient().contextSupply({ task_description: "draft" }),
    ).resolves.toMatchObject({
      structuredContent: {
        mode: "customer_demo",
        project_policy: "tenant_only",
      },
    });
  });
});
