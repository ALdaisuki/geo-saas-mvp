import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ctripBridgeCommissioningRequestHash,
  formatCtripBridgeCommissioningOutput,
  loadCommissionCtripBridgeEnvironment,
} from "../src/ctrip-bridge-commissioning.js";

const validEnvironment = {
  DATABASE_ADMIN_URL: "postgresql://postgres:secret@127.0.0.1:5432/geo_saas",
  GEO_CTRIP_BRIDGE_TENANT_SLUG: "example-travel",
  GEO_CTRIP_BRIDGE_OPERATOR_EMAIL: "Owner@Example.com",
  GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY: "ticket-ctrip-bridge-001",
  GEO_CTRIP_BRIDGE_PRINCIPAL_NAME: "example-ctrip-bridge",
};

const implementationSource = await readFile(
  new URL("../src/ctrip-bridge-commissioning.ts", import.meta.url),
  "utf8",
);
const migrationSource = await readFile(
  new URL("../migrations/0044_ctrip_bridge_commissioning.sql", import.meta.url),
  "utf8",
);

describe("Ctrip bridge commissioning contract", () => {
  it("requires only explicit admin and identity inputs", () => {
    expect(() => loadCommissionCtripBridgeEnvironment({})).toThrow(
      "DATABASE_ADMIN_URL is required",
    );
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        GEO_CTRIP_BRIDGE_OPERATOR_EMAIL: undefined,
      }),
    ).toThrow("GEO_CTRIP_BRIDGE_OPERATOR_EMAIL is required");

    expect(loadCommissionCtripBridgeEnvironment(validEnvironment)).toMatchObject({
      tenantSlug: "example-travel",
      operatorEmail: "owner@example.com",
      idempotencyKey: "ticket-ctrip-bridge-001",
      principalName: "example-ctrip-bridge",
    });
  });

  it("rejects malformed URLs, slugs, emails, keys, and principal names", () => {
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        DATABASE_ADMIN_URL: "https://database.example.com",
      }),
    ).toThrow("must be a PostgreSQL URL");
    const malformedSecret = "must-not-appear-in-the-error";
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        DATABASE_ADMIN_URL: `postgresql://admin:${malformedSecret}@[invalid/database`,
      }),
    ).toThrow("DATABASE_ADMIN_URL must be a valid PostgreSQL URL");
    try {
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        DATABASE_ADMIN_URL: `postgresql://admin:${malformedSecret}@[invalid/database`,
      });
    } catch (error) {
      expect(String(error)).not.toContain(malformedSecret);
    }
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        GEO_CTRIP_BRIDGE_TENANT_SLUG: "Bad Slug",
      }),
    ).toThrow("tenantSlug is invalid");
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        GEO_CTRIP_BRIDGE_OPERATOR_EMAIL: "not-an-email",
      }),
    ).toThrow("operatorEmail is invalid");
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY: "bad key",
      }),
    ).toThrow("idempotencyKey must use");
    expect(() =>
      loadCommissionCtripBridgeEnvironment({
        ...validEnvironment,
        GEO_CTRIP_BRIDGE_PRINCIPAL_NAME: "unsafe\nname",
      }),
    ).toThrow("printable characters");
  });

  it("normalizes equivalent operator identity before hashing", () => {
    const base = {
      tenantSlug: "example-travel",
      operatorEmail: "owner@example.com",
      idempotencyKey: "ticket-ctrip-bridge-001",
      principalName: "example-ctrip-bridge",
    };
    expect(
      ctripBridgeCommissioningRequestHash({
        ...base,
        operatorEmail: " Owner@Example.com ",
      }),
    ).toBe(ctripBridgeCommissioningRequestHash(base));
  });

  it("outputs identifiers and replay state without a credential", () => {
    const output = formatCtripBridgeCommissioningOutput({
      tenantId: "10000000-0000-4000-8000-000000000001",
      ctripChannelAccountId: "10000000-0000-4000-8000-000000000002",
      bridgeServicePrincipalId: "10000000-0000-4000-8000-000000000003",
      wasCreated: true,
    });
    expect(output).toEqual({
      event: "ctrip_bridge_commissioning.completed",
      tenantId: "10000000-0000-4000-8000-000000000001",
      ctripChannelAccountId: "10000000-0000-4000-8000-000000000002",
      bridgeServicePrincipalId: "10000000-0000-4000-8000-000000000003",
      wasCreated: true,
    });
    expect(Object.keys(output)).not.toContain("secret");
    expect(Object.keys(output)).not.toContain("credential");
    expect(Object.keys(output)).not.toContain("accessToken");
  });

  it("fixes authority, credential-less creation, idempotency, receipt, and audit controls", () => {
    expect(implementationSource).toContain('operator.role !== "owner"');
    expect(implementationSource).toContain('operator.role !== "admin"');
    expect(implementationSource).toContain('capabilities.includes("principal:manage")');
    expect(implementationSource).toContain("ctripBridgeCapabilities");
    expect(implementationSource).toContain("profile = 'ctrip_bridge'");
    expect(implementationSource).toContain("count(api_key.id)::text as credential_count");
    expect(implementationSource).toContain("pg_advisory_xact_lock");
    expect(implementationSource).toContain("ctrip_bridge.commissioned");

    expect(migrationSource).toContain("CREATE TABLE geo.ctrip_bridge_commissioning_receipts");
    expect(migrationSource).toContain("ctrip_bridge_commissioning_receipts_validate");
    expect(migrationSource).toContain("ctrip_bridge_commissioning_receipts_append_only");
    expect(migrationSource).toContain("geo.prevent_append_only_mutation()");
    expect(migrationSource).toContain("audit_log_id uuid NOT NULL UNIQUE");
    expect(migrationSource).toContain("service_principals_one_active_ctrip_bridge_per_tenant");
    expect(migrationSource).toContain("publication_assisted_handoffs_commissioned_bridge");
    expect(migrationSource).toContain("api_keys_prevent_commissioned_ctrip_bridge");
    expect(migrationSource).toContain(
      "REVOKE ALL ON TABLE geo.ctrip_bridge_commissioning_receipts",
    );
    expect(migrationSource).not.toContain(
      "GRANT SELECT ON geo.ctrip_bridge_commissioning_receipts",
    );
  });
});
