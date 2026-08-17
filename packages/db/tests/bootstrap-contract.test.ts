import { describe, expect, it } from "vitest";

import { loadBootstrapOperatorEnvironment } from "../src/bootstrap.js";

const validEnvironment = {
  DATABASE_ADMIN_URL: "postgresql://postgres:secret@127.0.0.1:5432/geo_saas",
  GEO_BOOTSTRAP_TENANT_SLUG: "sample-travel",
  GEO_BOOTSTRAP_EMAIL: "Owner@Example.com",
  GEO_BOOTSTRAP_DISPLAY_NAME: "Initial operator",
  GEO_BOOTSTRAP_PASSWORD: "a-long-random-password-value",
};

describe("operator bootstrap environment", () => {
  it("requires explicit admin connection and operator credentials", () => {
    expect(() => loadBootstrapOperatorEnvironment({})).toThrow("DATABASE_ADMIN_URL is required");
  });

  it("normalizes email and accepts a strong explicit password", () => {
    expect(loadBootstrapOperatorEnvironment(validEnvironment)).toMatchObject({
      tenantSlug: "sample-travel",
      email: "owner@example.com",
      displayName: "Initial operator",
      password: "a-long-random-password-value",
    });
  });

  it("rejects weak passwords and invalid tenant slugs", () => {
    expect(() =>
      loadBootstrapOperatorEnvironment({
        ...validEnvironment,
        GEO_BOOTSTRAP_PASSWORD: "too-short",
      }),
    ).toThrow("between 16 and 1024");
    expect(() =>
      loadBootstrapOperatorEnvironment({
        ...validEnvironment,
        GEO_BOOTSTRAP_TENANT_SLUG: "Bad Slug",
      }),
    ).toThrow("GEO_BOOTSTRAP_TENANT_SLUG is invalid");
  });
});
