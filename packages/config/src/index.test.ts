import { describe, expect, it } from "vitest";

import { serverEnvSchema } from "./index.js";

describe("serverEnvSchema", () => {
  it("defaults external providers to fixtures and browser automation to disabled", () => {
    const env = serverEnvSchema.parse({
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    });

    expect(env.DOUBAO_ADAPTER).toBe("fixture");
    expect(env.QWEN_ADAPTER).toBe("fixture");
    expect(env.ENABLE_BROWSER_ASSISTED).toBe(false);
  });

  it("rejects short session secrets", () => {
    expect(() =>
      serverEnvSchema.parse({
        DATABASE_URL: "postgresql://localhost/geo",
        SESSION_SECRET: "short",
        APP_ORIGIN: "http://127.0.0.1:4173",
      }),
    ).toThrow();
  });
});
