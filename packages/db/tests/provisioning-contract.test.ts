import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  formatTenantProvisioningOutput,
  loadProvisionTenantEnvironment,
  tenantProvisioningRequestHash,
  type ProvisionTenantInput,
} from "../src/provisioning.js";

const validEnvironment = {
  DATABASE_ADMIN_URL: "postgresql://postgres:secret@127.0.0.1:5432/geo_saas",
  GEO_PROVISION_IDEMPOTENCY_KEY: "ticket-geo-tenant-001",
  GEO_PROVISION_TENANT_SLUG: "example-general-services",
  GEO_PROVISION_LEGAL_NAME: "Example General Services Co., Ltd.",
  GEO_PROVISION_DISPLAY_NAME: "Example Services",
  GEO_PROVISION_INDUSTRY: "professional-services",
  GEO_PROVISION_DEFAULT_LOCALE: "zh-CN",
  GEO_PROVISION_BRAND_CANONICAL_NAME: "Example Services",
  GEO_PROVISION_BRAND_DISPLAY_NAME: "Example Services",
  GEO_PROVISION_CONTACTS_JSON: "[]",
  GEO_PROVISION_WORKER_NAME: "example-publication-worker",
};

const composeSource = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
const rootPackageSource = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
const dbPackageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
const operatorRunbookSource = await readFile(
  new URL("../../../docs/ops/operator-provisioning.md", import.meta.url),
  "utf8",
);

function input(contacts: ProvisionTenantInput["contacts"] = []): ProvisionTenantInput {
  return {
    idempotencyKey: "ticket-geo-tenant-001",
    tenantSlug: "example-general-services",
    legalName: "Example General Services Co., Ltd.",
    displayName: "Example Services",
    industry: "professional-services",
    defaultLocale: "zh-CN",
    brandCanonicalName: "Example Services",
    brandDisplayName: "Example Services",
    contacts,
    workerName: "example-publication-worker",
  };
}

describe("tenant provisioning environment contract", () => {
  it("requires an explicit admin URL and every commissioning value", () => {
    expect(() => loadProvisionTenantEnvironment({})).toThrow("DATABASE_ADMIN_URL is required");
    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        GEO_PROVISION_CONTACTS_JSON: undefined,
      }),
    ).toThrow("GEO_PROVISION_CONTACTS_JSON is required");
  });

  it("accepts an explicit empty contact list and keeps the model industry-neutral", () => {
    expect(loadProvisionTenantEnvironment(validEnvironment)).toMatchObject({
      idempotencyKey: "ticket-geo-tenant-001",
      tenantSlug: "example-general-services",
      industry: "professional-services",
      defaultLocale: "zh-CN",
      contacts: [],
      workerName: "example-publication-worker",
    });
  });

  it("parses, validates, and canonically orders structured contacts", () => {
    const parsed = loadProvisionTenantEnvironment({
      ...validEnvironment,
      GEO_PROVISION_CONTACTS_JSON: JSON.stringify([
        {
          type: "wechat",
          label: "WeChat",
          value: "ExampleWX",
          normalizedValue: "examplewx",
          isPrimary: false,
        },
        {
          type: "phone",
          label: "Hotline",
          value: "4001234567",
          normalizedValue: "4001234567",
          isPrimary: true,
        },
      ]),
    });
    expect(parsed.contacts.map((contact) => contact.type)).toEqual(["phone", "wechat"]);

    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        GEO_PROVISION_CONTACTS_JSON: JSON.stringify([
          {
            type: "phone",
            label: "One",
            value: "4001234567",
            normalizedValue: "4001234567",
            isPrimary: true,
          },
          {
            type: "phone",
            label: "Duplicate",
            value: "400-123-4567",
            normalizedValue: "4001234567",
            isPrimary: false,
          },
        ]),
      }),
    ).toThrow("duplicate type/normalizedValue");
  });

  it("rejects malformed JSON, unsupported fields, unsafe keys, and non-PostgreSQL URLs", () => {
    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        GEO_PROVISION_CONTACTS_JSON: "not-json",
      }),
    ).toThrow("must be valid JSON");
    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        GEO_PROVISION_CONTACTS_JSON: JSON.stringify([
          {
            type: "phone",
            label: "Hotline",
            value: "4001234567",
            normalizedValue: "4001234567",
            isPrimary: true,
            secret: "must-not-be-accepted",
          },
        ]),
      }),
    ).toThrow("secret is not supported");
    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        GEO_PROVISION_IDEMPOTENCY_KEY: "bad key",
      }),
    ).toThrow("idempotencyKey must use");
    expect(() =>
      loadProvisionTenantEnvironment({
        ...validEnvironment,
        DATABASE_ADMIN_URL: "https://database.example.com",
      }),
    ).toThrow("must be a PostgreSQL URL");
  });

  it("hashes semantically identical contact order to the same request", () => {
    const phone = {
      type: "phone" as const,
      label: "Hotline",
      value: "4001234567",
      normalizedValue: "4001234567",
      isPrimary: true,
    };
    const wechat = {
      type: "wechat" as const,
      label: "WeChat",
      value: "ExampleWX",
      normalizedValue: "examplewx",
      isPrimary: false,
    };
    expect(tenantProvisioningRequestHash(input([phone, wechat]))).toBe(
      tenantProvisioningRequestHash(input([wechat, phone])),
    );
  });

  it("emits only result identifiers and the worker mapping fragment", () => {
    const output = formatTenantProvisioningOutput({
      tenantId: "10000000-0000-4000-8000-000000000001",
      brandId: "10000000-0000-4000-8000-000000000002",
      workerServicePrincipalId: "10000000-0000-4000-8000-000000000003",
      policyBundleId: "10000000-0000-4000-8000-000000000004",
      querySetId: "10000000-0000-4000-8000-000000000005",
      querySetVersionId: "10000000-0000-4000-8000-000000000006",
      wasCreated: true,
    });
    expect(output).toEqual({
      event: "tenant_provisioning.completed",
      tenantId: "10000000-0000-4000-8000-000000000001",
      brandId: "10000000-0000-4000-8000-000000000002",
      workerServicePrincipalId: "10000000-0000-4000-8000-000000000003",
      policyBundleId: "10000000-0000-4000-8000-000000000004",
      querySetId: "10000000-0000-4000-8000-000000000005",
      querySetVersionId: "10000000-0000-4000-8000-000000000006",
      wasCreated: true,
      workerTenantActorsJsonFragment: {
        "10000000-0000-4000-8000-000000000001": "10000000-0000-4000-8000-000000000003",
      },
    });
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("exposes only an explicit one-shot Compose profile and documents the two-step flow", () => {
    expect(rootPackageSource).toContain('"db:provision:tenant"');
    expect(dbPackageSource).toContain('"provision:tenant"');
    expect(composeSource).toContain("db-provision-tenant:");
    expect(composeSource).toContain("- tenant-provisioning");
    expect(composeSource).toContain("dist/cli/provision-tenant.js");
    for (const name of Object.keys(validEnvironment).filter((name) => name.startsWith("GEO_"))) {
      expect(composeSource).toContain(`- ${name}`);
    }
    expect(operatorRunbookSource).toContain(
      "docker compose --profile tenant-provisioning run --rm db-provision-tenant",
    );
    expect(operatorRunbookSource).toContain(
      "docker compose --profile operator-bootstrap run --rm db-bootstrap-operator",
    );
    expect(operatorRunbookSource.indexOf("db:provision:tenant")).toBeLessThan(
      operatorRunbookSource.indexOf("db:bootstrap:operator"),
    );
  });
});
