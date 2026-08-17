import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { productionDeploymentEnvSchema, serverEnvSchema } from "./index.js";

const composeSource = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
const apiServerSource = await readFile(
  new URL("../../../apps/api/src/server.ts", import.meta.url),
  "utf8",
);
const productionComposeSource = await readFile(
  new URL("../../../compose.production.yaml", import.meta.url),
  "utf8",
);
const dockerfileSource = await readFile(new URL("../../../Dockerfile", import.meta.url), "utf8");
const browserDockerfileSource = await readFile(
  new URL("../../../Dockerfile.browser-host", import.meta.url),
  "utf8",
);
const browserAppArmorSource = await readFile(
  new URL("../../../deploy/apparmor/geo-saas-browser-host", import.meta.url),
  "utf8",
);
const browserSeccompSource = await readFile(
  new URL("../../../deploy/seccomp/geo-saas-browser-host.json", import.meta.url),
  "utf8",
);
const browserAppArmorInstallerSource = await readFile(
  new URL("../../../scripts/install-browser-host-apparmor.sh", import.meta.url),
  "utf8",
);
const mediaProxyInstallerSource = await readFile(
  new URL("../../../scripts/install-geo-media-proxy.sh", import.meta.url),
  "utf8",
);
const browserHostEntrypointSource = await readFile(
  new URL("../../../scripts/browser-host-entrypoint.sh", import.meta.url),
  "utf8",
);
const browserHostAccountManagerSource = await readFile(
  new URL("../../../scripts/browser-host-account-manager.mjs", import.meta.url),
  "utf8",
);
const browserHostHealthSource = await readFile(
  new URL("../../../scripts/browser-host-health.sh", import.meta.url),
  "utf8",
);
const productionLauncherSource = await readFile(
  new URL("../../../scripts/start-production.sh", import.meta.url),
  "utf8",
);
const piSandboxLauncherSource = await readFile(
  new URL("../../../scripts/start-pi-automation-sandbox.sh", import.meta.url),
  "utf8",
);
const deepseekConfiguratorSource = await readFile(
  new URL("../../../scripts/configure-production-deepseek.sh", import.meta.url),
  "utf8",
);
const productionHttpsVerifierSource = await readFile(
  new URL("../../../scripts/verify-production-https.sh", import.meta.url),
  "utf8",
);
const productionCaddySource = await readFile(
  new URL("../../../deploy/caddy/Caddyfile", import.meta.url),
  "utf8",
);
const webNginxSource = await readFile(
  new URL("../../../docs/ops/nginx/default.conf", import.meta.url),
  "utf8",
);
const demoComposeSource = await readFile(
  new URL("../../../compose.customer-demo.yaml", import.meta.url),
  "utf8",
);
const customerLauncherSource = await readFile(
  new URL("../../../scripts/start-customer-demo.ps1", import.meta.url),
  "utf8",
);
const ctripConnectorSource = await readFile(
  new URL("../../../scripts/connect-ctrip.ps1", import.meta.url),
  "utf8",
);
const ctripSupervisorSource = await readFile(
  new URL("../../../scripts/ctrip-host-supervisor.ps1", import.meta.url),
  "utf8",
);

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
    expect(env.GEO_MEDIA_PROVIDER).toBe("disabled");
    expect(env.GEO_MEDIA_SEARCH_PROVIDER).toBe("disabled");
    expect(env.GEO_MEDIA_OBJECT_ROOT).toBe(".data/media");
    expect(env.AGENT_PROVIDER).toBe("fixture");
    expect(env.AGENT_BASE_URL).toBeUndefined();
    expect(env.AGENT_API).toBeUndefined();
    expect(env.AGENT_STRICT_TOOL_ARGUMENTS).toBe(false);
    expect(env.AGENT_GATEWAY_RUN_TIMEOUT_MS).toBe(130_000);
    expect(env.TREND_COLLECTION_ENABLED).toBe(false);
    expect(env.TREND_COLLECTION_TENANT_ACTORS_JSON).toBeUndefined();
    expect(env.TREND_COLLECTION_INTERVAL_MS).toBe(600_000);
    expect(env.TREND_COLLECTION_LIMIT_PER_SOURCE).toBe(20);
    expect(env.TREND_AUTOMATION_ENABLED).toBe(false);
    expect(env.TREND_AUTOMATION_PIPELINES_JSON).toBeUndefined();
    expect(env.TREND_AUTOMATION_INTERVAL_MS).toBe(600_000);
    expect(env.API_PORT).toBe(10004);
    expect(env.MCP_PORT).toBe(10001);
  });

  it("requires a bounded tenant actor mapping when trend collection is enabled", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      TREND_COLLECTION_ENABLED: "true",
    };
    const tenantId = "10000000-0000-4000-8000-000000000001";
    const actorId = "10000000-0000-4000-8000-000000000101";

    expect(() => serverEnvSchema.parse(base)).toThrow(
      /TREND_COLLECTION_TENANT_ACTORS_JSON is required/iu,
    );
    expect(
      serverEnvSchema.parse({
        ...base,
        TREND_COLLECTION_TENANT_ACTORS_JSON: JSON.stringify({ [tenantId]: actorId }),
        TREND_COLLECTION_INTERVAL_MS: "120000",
        TREND_COLLECTION_LIMIT_PER_SOURCE: "12",
      }),
    ).toMatchObject({
      TREND_COLLECTION_ENABLED: true,
      TREND_COLLECTION_INTERVAL_MS: 120_000,
      TREND_COLLECTION_LIMIT_PER_SOURCE: 12,
    });
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        TREND_COLLECTION_TENANT_ACTORS_JSON: "not-json",
      }),
    ).toThrow(/must be valid JSON/iu);
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        TREND_COLLECTION_TENANT_ACTORS_JSON: JSON.stringify({ [tenantId]: actorId }),
        TREND_COLLECTION_INTERVAL_MS: "59999",
      }),
    ).toThrow();
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        TREND_COLLECTION_TENANT_ACTORS_JSON: JSON.stringify({ [tenantId]: actorId }),
        TREND_COLLECTION_LIMIT_PER_SOURCE: "21",
      }),
    ).toThrow();
  });

  it("requires bounded tenant pipelines when trend automation is enabled", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      TREND_AUTOMATION_ENABLED: "true",
    };
    const tenantId = "10000000-0000-4000-8000-000000000001";
    const pipelines = JSON.stringify({
      [tenantId]: {
        actorId: "10000000-0000-4000-8000-000000000101",
        campaignId: "10000000-0000-4000-8000-000000000201",
        platforms: ["toutiao", "sohu", "baijiahao", "netease"],
        executionLevel: "dry_run",
        maxNewBatchesPerRun: 20,
        lookbackMinutes: 1_440,
        minFreshnessScore: 0.65,
        relevanceTerms: ["云南", "旅游"],
      },
    });

    expect(() => serverEnvSchema.parse(base)).toThrow(
      /TREND_AUTOMATION_PIPELINES_JSON is required/iu,
    );
    expect(
      serverEnvSchema.parse({
        ...base,
        TREND_AUTOMATION_PIPELINES_JSON: pipelines,
        TREND_AUTOMATION_INTERVAL_MS: "120000",
      }),
    ).toMatchObject({
      TREND_AUTOMATION_ENABLED: true,
      TREND_AUTOMATION_PIPELINES_JSON: pipelines,
      TREND_AUTOMATION_INTERVAL_MS: 120_000,
    });
    for (const TREND_AUTOMATION_PIPELINES_JSON of ["not-json", "{}", "[]"]) {
      expect(() => serverEnvSchema.parse({ ...base, TREND_AUTOMATION_PIPELINES_JSON })).toThrow();
    }
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        TREND_AUTOMATION_PIPELINES_JSON: pipelines,
        TREND_AUTOMATION_INTERVAL_MS: "59999",
      }),
    ).toThrow();
  });

  it("accepts a gateway deadline long enough for a 15 minute real Pi run", () => {
    const env = serverEnvSchema.parse({
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      AGENT_GATEWAY_RUN_TIMEOUT_MS: "910000",
    });

    expect(env.AGENT_GATEWAY_RUN_TIMEOUT_MS).toBe(910_000);
    expect(() =>
      serverEnvSchema.parse({
        DATABASE_URL: "postgresql://localhost/geo",
        SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
        APP_ORIGIN: "http://127.0.0.1:4173",
        AGENT_GATEWAY_RUN_TIMEOUT_MS: "960001",
      }),
    ).toThrow();
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

  it("accepts only an exact IPv4 loopback operator origin", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "https://geo.example.test",
    };

    expect(
      serverEnvSchema.parse({
        ...base,
        GEO_OPERATOR_ORIGIN: "http://127.0.0.1:10003",
      }).GEO_OPERATOR_ORIGIN,
    ).toBe("http://127.0.0.1:10003");

    for (const GEO_OPERATOR_ORIGIN of [
      "https://127.0.0.1:10003",
      "http://localhost:10003",
      "http://0.0.0.0:10003",
      "http://127.0.0.1:10003/console",
      "http://127.0.0.1",
      "http://127.0.0.1:65536",
    ]) {
      expect(() => serverEnvSchema.parse({ ...base, GEO_OPERATOR_ORIGIN })).toThrow(
        /operator origin/iu,
      );
    }
  });

  it("rejects visibility adapter modes that have no implementation", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    };
    expect(() => serverEnvSchema.parse({ ...base, DOUBAO_ADAPTER: "api" })).toThrow();
    expect(() => serverEnvSchema.parse({ ...base, QWEN_ADAPTER: "manual" })).toThrow();
    expect(() => serverEnvSchema.parse({ ...base, GEO_MEDIA_PROVIDER: "live" })).toThrow();
  });

  it("keeps fixture media production inside the demo-only boundary", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      GEO_MEDIA_PROVIDER: "fixture" as const,
    };

    expect(() => serverEnvSchema.parse(base)).toThrow(/demo_fixture/iu);
    expect(
      serverEnvSchema.parse({
        ...base,
        GEO_DEPLOYMENT_PROFILE: "customer_demo",
        GEO_GOVERNANCE_MODE: "demo_fixture",
      }).GEO_MEDIA_PROVIDER,
    ).toBe("fixture");
  });

  it("requires an explicit loopback-only opt-in before demo governance can use a real Pi", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:10103",
      GEO_DEPLOYMENT_PROFILE: "customer_demo" as const,
      GEO_GOVERNANCE_MODE: "demo_fixture" as const,
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "sandbox-model",
      AGENT_API: "openai-responses" as const,
      AGENT_BASE_URL: "https://sandbox.example.test/v1",
      AGENT_API_KEY: "sandbox-test-key",
    };

    expect(() => serverEnvSchema.parse(base)).toThrow(/GEO_ALLOW_REAL_PI_IN_DEMO/iu);
    expect(
      serverEnvSchema.parse({ ...base, GEO_ALLOW_REAL_PI_IN_DEMO: "true" }).AGENT_PROVIDER,
    ).toBe("openai-compatible");
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        GEO_DEPLOYMENT_PROFILE: "standard",
        GEO_ALLOW_REAL_PI_IN_DEMO: "true",
      }),
    ).toThrow(/GEO_ALLOW_REAL_PI_IN_DEMO/iu);
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        AGENT_PROVIDER: "fixture",
        AGENT_MODEL: "fixture-geo-writer-v1",
        AGENT_API: undefined,
        AGENT_BASE_URL: undefined,
        AGENT_API_KEY: undefined,
        GEO_ALLOW_REAL_PI_IN_DEMO: "true",
      }),
    ).toThrow(/requires a real Pi provider/iu);
  });

  it("accepts only a bare HTTP(S) proxy for the fixed media client", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    };
    expect(
      serverEnvSchema.parse({
        ...base,
        GEO_MEDIA_HTTPS_PROXY_URL: "http://proxy-user:proxy-password@proxy.example.test:8080",
      }).GEO_MEDIA_HTTPS_PROXY_URL,
    ).toBe("http://proxy-user:proxy-password@proxy.example.test:8080");

    for (const GEO_MEDIA_HTTPS_PROXY_URL of [
      "socks5://proxy.example.test:1080",
      "http://proxy.example.test:8080/tunnel",
      "https://proxy.example.test:8443/?region=cn",
      "https://proxy.example.test:8443/#media",
    ]) {
      expect(() => serverEnvSchema.parse({ ...base, GEO_MEDIA_HTTPS_PROXY_URL })).toThrow(
        /media HTTPS proxy/iu,
      );
    }
  });

  it("requires a dedicated secret for the Pexels licensed-search provider", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    };
    expect(
      serverEnvSchema.parse({
        ...base,
        GEO_MEDIA_SEARCH_PROVIDER: "pexels",
        PEXELS_API_KEY: "a-real-pexels-key-with-at-least-16-characters",
      }),
    ).toMatchObject({
      GEO_MEDIA_SEARCH_PROVIDER: "pexels",
      PEXELS_API_KEY: "a-real-pexels-key-with-at-least-16-characters",
    });
    expect(() => serverEnvSchema.parse({ ...base, GEO_MEDIA_SEARCH_PROVIDER: "pexels" })).toThrow(
      /PEXELS_API_KEY/iu,
    );
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        GEO_MEDIA_SEARCH_PROVIDER: "wikimedia_commons",
        PEXELS_API_KEY: "an-unused-pexels-key-with-at-least-16-characters",
      }),
    ).toThrow(/only with GEO_MEDIA_SEARCH_PROVIDER=pexels/iu);
  });

  it("treats empty optional Pi endpoint settings as absent", () => {
    const env = serverEnvSchema.parse({
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      AGENT_API: "",
      AGENT_BASE_URL: "",
    });

    expect(env.AGENT_API).toBeUndefined();
    expect(env.AGENT_BASE_URL).toBeUndefined();
  });

  it("requires the agent gateway URL and tenant credentials together", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    };
    expect(() =>
      serverEnvSchema.parse({ ...base, AGENT_GATEWAY_URL: "http://127.0.0.1:9021" }),
    ).toThrow(/configured together/iu);
    expect(() => serverEnvSchema.parse({ ...base, AGENT_GATEWAY_CREDENTIALS_JSON: "[]" })).toThrow(
      /configured together/iu,
    );
  });

  it("requires the Ctrip bridge URL and tenant credentials together", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
    };
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        CTRIP_BRIDGE_GATEWAY_URL: "http://127.0.0.1:9030",
      }),
    ).toThrow(/configured together/iu);
    expect(() =>
      serverEnvSchema.parse({ ...base, CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: "[]" }),
    ).toThrow(/configured together/iu);
    expect(
      serverEnvSchema.parse({
        ...base,
        CTRIP_BRIDGE_GATEWAY_URL: "http://127.0.0.1:9030",
        CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: "[]",
      }),
    ).toMatchObject({ CTRIP_BRIDGE_GATEWAY_URL: "http://127.0.0.1:9030" });
  });

  it("requires an API key and base URL for an OpenAI-compatible Pi provider", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "custom-model",
    };
    expect(() => serverEnvSchema.parse(base)).toThrow(/AGENT_BASE_URL/iu);
    expect(() =>
      serverEnvSchema.parse({ ...base, AGENT_BASE_URL: "https://models.example.test/v1" }),
    ).toThrow(/AGENT_API_KEY/iu);
    expect(
      serverEnvSchema.parse({
        ...base,
        AGENT_BASE_URL: "https://models.example.test/v1",
        AGENT_API: "openai-completions",
        AGENT_API_KEY: "test-key",
      }),
    ).toMatchObject({
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "custom-model",
      AGENT_API: "openai-completions",
    });
  });

  it("allows JSON completions only for the reviewed OpenAI-compatible API", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "custom-model",
      AGENT_BASE_URL: "https://models.example.test/v1",
      AGENT_API_KEY: "test-key",
      AGENT_COMPLETIONS_MODE: "json",
    };

    expect(() => serverEnvSchema.parse(base)).toThrow(/AGENT_API=openai-completions/iu);
    expect(serverEnvSchema.parse({ ...base, AGENT_API: "openai-completions" })).toMatchObject({
      AGENT_COMPLETIONS_MODE: "json",
    });
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        AGENT_PROVIDER: "openai",
        AGENT_API: "openai-completions",
        AGENT_BASE_URL: undefined,
      }),
    ).toThrow(/AGENT_COMPLETIONS_MODE=json/iu);
  });

  it("rejects unsafe or misplaced custom agent base URLs", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/geo",
      SESSION_SECRET: "a-secure-test-secret-that-is-long-enough",
      APP_ORIGIN: "http://127.0.0.1:4173",
      AGENT_API_KEY: "test-key",
    };
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        AGENT_PROVIDER: "openai-compatible",
        AGENT_BASE_URL: "http://models.example.test/v1",
      }),
    ).toThrow(/HTTPS/iu);
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "gpt-5",
        AGENT_BASE_URL: "https://models.example.test/v1",
      }),
    ).toThrow(/only supported/iu);
    expect(() =>
      serverEnvSchema.parse({
        ...base,
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "gpt-5",
        AGENT_API: "openai-completions",
      }),
    ).toThrow(/AGENT_API is only supported/iu);
  });

  it("rejects checked-in placeholder secrets in production server configuration", () => {
    expect(() =>
      serverEnvSchema.parse({
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://geo_api:replace-api-with-random-url-safe-value@postgres:5432/geo_saas",
        DATABASE_IDENTITY_URL:
          "postgresql://geo_identity_login:identity-production-secret@postgres:5432/geo_saas",
        SESSION_SECRET: "a-real-production-session-secret-value",
        APP_ORIGIN: "https://geo.example.test",
      }),
    ).toThrow(/placeholder/iu);

    expect(() =>
      serverEnvSchema.parse({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://geo_api:api-production-secret@postgres:5432/geo_saas",
        DATABASE_IDENTITY_URL:
          "postgresql://geo_identity_login:identity-production-secret@postgres:5432/geo_saas",
        SESSION_SECRET: "replace-session-secret-with-at-least-32-random-bytes",
        APP_ORIGIN: "https://geo.example.test",
      }),
    ).toThrow(/placeholder/iu);
  });
});

describe("GEO media proxy installer", () => {
  it("pins the reviewed Clash Verge core and exposes no host port", () => {
    expect(mediaProxyInstallerSource).toContain(
      "EXPECTED_CORE_SHA256=40e90c059a32cea321b2dbe4524051d65e377e665d9b88af5c99087a23a6d509",
    );
    expect(mediaProxyInstallerSource).toContain("Mihomo Meta v1.19.29 linux amd64");
    expect(mediaProxyInstallerSource).toContain("name: geo-saas_frontend");
    expect(mediaProxyInstallerSource).not.toMatch(/^\s+ports:/gmu);
  });

  it("keeps the subscription hidden and limits proxy routing to Wikimedia", () => {
    expect(mediaProxyInstallerSource).toContain("read -r -s subscription_url");
    expect(mediaProxyInstallerSource).toContain("read -r -s subscription_verify");
    expect(mediaProxyInstallerSource).toContain(
      "url: http://subscription-fetcher:7800/subscription",
    );
    expect(mediaProxyInstallerSource).toContain("proxy: DIRECT");
    expect(mediaProxyInstallerSource).toContain("source: ./subscription-url");
    expect(mediaProxyInstallerSource).toContain("DOMAIN-SUFFIX,wikimedia.org,MEDIA");
    expect(mediaProxyInstallerSource).toContain("MATCH,REJECT");
    expect(mediaProxyInstallerSource).toContain("no-new-privileges:true");
    expect(mediaProxyInstallerSource).toContain("geo.env has not been modified");
  });

  it("isolates subscription refresh and supports rollback of a partial install", () => {
    expect(mediaProxyInstallerSource).toContain("1:--repair-existing) mode=repair");
    expect(mediaProxyInstallerSource).toContain("subscription-control:");
    expect(mediaProxyInstallerSource).toContain("internal: true");
    expect(mediaProxyInstallerSource).toContain("subscription-egress:");
    expect(mediaProxyInstallerSource).toContain("rollback_installation");
    expect(mediaProxyInstallerSource).toContain("GEO media proxy changes were rolled back");
  });

  it("excludes every Secret and runtime file from the proxy image build context", () => {
    expect(mediaProxyInstallerSource).toContain("cat >\"${dockerignore_stage}\" <<'EOF'");
    expect(mediaProxyInstallerSource).toContain("!Dockerfile\n!bin/\n!bin/mihomo");
    expect(mediaProxyInstallerSource).not.toContain("COPY subscription-url");
    expect(mediaProxyInstallerSource).not.toContain("COPY config.yaml");
  });
});

describe("productionDeploymentEnvSchema", () => {
  const validProductionEnvironment = {
    GEO_PUBLIC_DOMAIN: "geo.example.test",
    APP_ORIGIN: "https://geo.example.test",
    POSTGRES_ADMIN_PASSWORD: "admin-production-secret",
    GEO_API_DB_PASSWORD: "api-production-secret",
    GEO_WORKER_DB_PASSWORD: "worker-production-secret",
    GEO_IDENTITY_DB_PASSWORD: "identity-production-secret",
    SESSION_SECRET: "a-real-production-session-secret-value",
    AGENT_PROVIDER: "openai",
    AGENT_MODEL: "approved-production-model",
    AGENT_API_KEY: "a-real-agent-provider-key",
    MEDIA_INSPECTION_PROVIDER: "openai",
    MEDIA_INSPECTION_MODEL: "approved-vision-model",
    MEDIA_INSPECTION_COMPLETIONS_MODE: "stream",
    MEDIA_INSPECTION_API_KEY: "a-real-vision-provider-key",
    PLASTIC_PROMISE_MCP_URL: "https://plastic-promise.example.test/mcp",
    GEO_CONTEXT_RETRIEVAL_ENABLED: "false",
    MCP_PRINCIPALS_JSON: JSON.stringify([
      {
        accessToken: "a-real-mcp-access-token-with-32-characters",
        clientId: "geo-operator",
        email: "operator@customer.test",
        password: "a-real-operator-password",
        tenantSlug: "customer-tenant",
      },
    ]),
    AGENT_GATEWAY_CREDENTIALS_JSON: JSON.stringify([
      {
        tenantId: "10000000-0000-4000-8000-000000000001",
        accessToken: "a-real-mcp-access-token-with-32-characters",
      },
    ]),
    CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: JSON.stringify([
      {
        tenantId: "10000000-0000-4000-8000-000000000001",
        accessToken: "a-real-ctrip-access-token-with-32-characters",
      },
    ]),
    CTRIP_BRIDGE_TENANTS_JSON: JSON.stringify([
      {
        tenantId: "10000000-0000-4000-8000-000000000001",
        bridgePrincipalId: "10000000-0000-4000-8000-000000000102",
        accessToken: "a-real-ctrip-access-token-with-32-characters",
      },
    ]),
    CTRIP_BROWSER_TRANSPORT: "linux_service",
    CTRIP_BROWSER_TENANT_ID: "10000000-0000-4000-8000-000000000001",
    GEO_CTRIP_BROWSER_LOGIN_BASE_URL:
      "http://127.0.0.1:10007/vnc.html?autoconnect=true&resize=scale",
    CTRIP_NOVNC_HOST_PORT: 10007,
    CTRIP_REVIEW_CDP_ENDPOINT: "http://browser-host:10005",
    GEO_RUNTIME_TMP_ROOT: "/var/lib/geo/runtime/tmp",
    GEO_CTRIP_RUNTIME_ROOT: "/srv/geo-saas/data/ctrip-runtime",
    GEO_BROWSER_PROFILE_ROOT: "/srv/geo-saas/browser-profiles",
    GEO_BROWSER_DOWNLOAD_ROOT: "/srv/geo-saas/browser-downloads",
    GEO_BROWSER_ARTIFACT_ROOT: "/srv/geo-saas/browser-artifacts",
    CTRIP_VNC_PASSWORD_FILE: "/srv/geo-saas/secrets/ctrip-vnc.passwd",
  };

  it("requires an explicit media inspection provider in standard production", () => {
    const withoutMediaInspection = Object.fromEntries(
      Object.entries(validProductionEnvironment).filter(
        ([name]) => !name.startsWith("MEDIA_INSPECTION_"),
      ),
    );
    expect(() => productionDeploymentEnvSchema.parse(withoutMediaInspection)).toThrow(
      /MEDIA_INSPECTION_PROVIDER/iu,
    );
  });

  it("rejects the checked-in deployment placeholders before startup", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        POSTGRES_ADMIN_PASSWORD: "replace-admin-with-random-url-safe-value",
        GEO_API_DB_PASSWORD: "replace-api-with-random-url-safe-value",
        GEO_WORKER_DB_PASSWORD: "replace-worker-with-random-url-safe-value",
        GEO_IDENTITY_DB_PASSWORD: "replace-identity-with-random-url-safe-value",
        SESSION_SECRET: "replace-session-secret-with-at-least-32-random-bytes",
        MCP_PRINCIPALS_JSON:
          '[{"accessToken":"replace-with-at-least-32-random-characters","password":"replace-after-provisioning"}]',
        AGENT_GATEWAY_CREDENTIALS_JSON:
          '[{"tenantId":"10000000-0000-4000-8000-000000000001","accessToken":"replace-with-matching-token"}]',
        AGENT_API_KEY: "replace-agent-api-key",
      }),
    ).toThrow(/placeholder/iu);
  });

  it("accepts independently supplied production secrets", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_ALLOW_REAL_PI_IN_DEMO: "false",
      }),
    ).toMatchObject({
      ...validProductionEnvironment,
      GEO_ALLOW_REAL_PI_IN_DEMO: false,
      GEO_CONTEXT_RETRIEVAL_ENABLED: false,
      AUTOMATION_PRODUCER_ENABLED: false,
      TREND_AUTOMATION_ENABLED: false,
      TREND_AUTOMATION_INTERVAL_MS: 600_000,
      CTRIP_BRIDGE_MODE: "browser_draft",
    });
  });

  it("applies the same fail-closed trend automation gate during production preflight", () => {
    const tenantId = "10000000-0000-4000-8000-000000000001";
    const pipelines = JSON.stringify({
      [tenantId]: {
        actorId: "10000000-0000-4000-8000-000000000101",
        campaignId: "10000000-0000-4000-8000-000000000201",
        relevanceTerms: ["云南旅游"],
      },
    });

    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        TREND_AUTOMATION_ENABLED: "true",
      }),
    ).toThrow(/TREND_AUTOMATION_PIPELINES_JSON is required/iu);
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        TREND_AUTOMATION_ENABLED: "true",
        TREND_AUTOMATION_PIPELINES_JSON: pipelines,
      }),
    ).toMatchObject({
      TREND_AUTOMATION_ENABLED: true,
      TREND_AUTOMATION_PIPELINES_JSON: pipelines,
    });
  });

  it("requires one exact bare HTTPS origin for the production public domain", () => {
    for (const invalid of [
      { GEO_PUBLIC_DOMAIN: "127.0.0.1", APP_ORIGIN: "https://127.0.0.1" },
      { GEO_PUBLIC_DOMAIN: "*.example.test", APP_ORIGIN: "https://example.test" },
      { GEO_PUBLIC_DOMAIN: "Geo.example.test", APP_ORIGIN: "https://Geo.example.test" },
      { GEO_PUBLIC_DOMAIN: "geo.example.test", APP_ORIGIN: "http://geo.example.test" },
      { GEO_PUBLIC_DOMAIN: "geo.example.test", APP_ORIGIN: "https://geo.example.test/console" },
      { GEO_PUBLIC_DOMAIN: "geo.example.test", APP_ORIGIN: "https://other.example.test" },
    ]) {
      expect(() =>
        productionDeploymentEnvSchema.parse({ ...validProductionEnvironment, ...invalid }),
      ).toThrow();
    }
  });

  it("binds the optional SSH operator origin to the loopback Web port", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        WEB_PORT: "10003",
        GEO_OPERATOR_ORIGIN: "http://127.0.0.1:10003",
      }),
    ).toMatchObject({
      WEB_PORT: 10_003,
      GEO_OPERATOR_ORIGIN: "http://127.0.0.1:10003",
    });

    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        WEB_PORT: "10003",
        GEO_OPERATOR_ORIGIN: "http://127.0.0.1:10004",
      }),
    ).toThrow(/must exactly match the loopback production WEB_PORT/iu);
  });

  it("rejects a placeholder media proxy from production configuration", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_HTTPS_PROXY_URL:
          "http://proxy-user:replace-proxy-password@proxy.example.test:8080",
      }),
    ).toThrow(/GEO_MEDIA_HTTPS_PROXY_URL contains a checked-in placeholder/iu);
  });

  it("requires a non-placeholder Pexels key in production", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_SEARCH_PROVIDER: "pexels",
        PEXELS_API_KEY: "a-real-pexels-key-with-at-least-16-characters",
      }),
    ).toMatchObject({ GEO_MEDIA_SEARCH_PROVIDER: "pexels" });
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_SEARCH_PROVIDER: "pexels",
      }),
    ).toThrow(/PEXELS_API_KEY/iu);
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_SEARCH_PROVIDER: "pexels",
        PEXELS_API_KEY: "replace-pexels-api-key",
      }),
    ).toThrow(/placeholder/iu);
  });

  it("rejects a persisted operator bootstrap password from production configuration", () => {
    const preflightBlock = composeSource.slice(
      composeSource.indexOf("  config-preflight:"),
      composeSource.indexOf("  postgres:"),
    );

    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_BOOTSTRAP_PASSWORD: "a-one-shot-bootstrap-secret",
      }),
    ).toThrow(/must not persist GEO_BOOTSTRAP_PASSWORD/iu);
    expect(preflightBlock).toContain("- GEO_BOOTSTRAP_PASSWORD");
    expect(preflightBlock).toContain("GEO_CONTEXT_RETRIEVAL_ENABLED");
  });

  it("allows only the fixed HTTP Docker bridge proxy for production governance", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        PLASTIC_PROMISE_MCP_URL: "http://172.30.11.2:10002/mcp",
      }).PLASTIC_PROMISE_MCP_URL,
    ).toBe("http://172.30.11.2:10002/mcp");
    for (const endpoint of [
      "http://172.30.11.1:10002/mcp",
      "http://172.30.11.2:10003/mcp",
      "http://172.30.11.2:10002/",
      "http://172.30.11.2:10002/mcp?token=value",
      "http://10.0.0.1:10002/mcp",
      "https://user:password@plastic-promise.example.test/mcp",
      "https://plastic-promise.example.test/mcp?token=value",
      "https://plastic-promise.example.test/mcp#fragment",
    ]) {
      expect(() =>
        productionDeploymentEnvSchema.parse({
          ...validProductionEnvironment,
          PLASTIC_PROMISE_MCP_URL: endpoint,
        }),
      ).toThrow(/HTTPS|Docker bridge/iu);
    }
  });

  it("requires one matching tenant across the production Ctrip browser boundary", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        CTRIP_BROWSER_TENANT_ID: "20000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/tenant IDs must match/iu);
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        CTRIP_BROWSER_TRANSPORT: "docker_desktop",
      }),
    ).toThrow();
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        CTRIP_REVIEW_CDP_ENDPOINT: "http://127.0.0.1:10005",
      }),
    ).toThrow(/browser-host/iu);
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_BROWSER_PROFILE_ROOT: "/tmp/browser-profiles",
      }),
    ).toThrow(/\/tmp/iu);
  });

  it("requires the fixed backed-up Ctrip runtime root", () => {
    for (const runtimeRoot of [
      "/var/lib/geo/runtime/ctrip-bridge",
      "/srv/geo-saas/data/ctrip-runtime-other",
      "/srv/geo-saas/data/tenant/ctrip-runtime",
    ]) {
      expect(() =>
        productionDeploymentEnvSchema.parse({
          ...validProductionEnvironment,
          GEO_CTRIP_RUNTIME_ROOT: runtimeRoot,
        }),
      ).toThrow(/\/srv\/geo-saas\/data\/ctrip-runtime/iu);
    }
  });

  it("rejects fixture media in external production deployments", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_PROVIDER: "fixture",
      }),
    ).toThrow(/GEO_MEDIA_PROVIDER=disabled/iu);
  });

  it("hard-locks the production deployment profile and governance mode", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_DEPLOYMENT_PROFILE: "customer_demo",
        GEO_GOVERNANCE_MODE: "external",
      }),
    ).toThrow();
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_GOVERNANCE_MODE: "demo_fixture",
      }),
    ).toThrow();
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_ALLOW_REAL_PI_IN_DEMO: "true",
      }),
    ).toThrow();
  });

  it("requires the fixed internal production Ctrip Bridge route", () => {
    expect(
      productionDeploymentEnvSchema.parse(validProductionEnvironment).CTRIP_BRIDGE_GATEWAY_URL,
    ).toBe("http://ctrip-bridge:9030");
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        CTRIP_BRIDGE_GATEWAY_URL: "http://127.0.0.1:9030",
      }),
    ).toThrow();
  });

  it("keeps the one-click customer profile explicit, data-drive scoped, and non-live", () => {
    expect(customerLauncherSource).toContain("GEO_DEPLOYMENT_PROFILE=customer_demo");
    expect(customerLauncherSource).toContain('$governanceMode = if ($AgentMode -eq "real")');
    expect(customerLauncherSource).toContain('ValidateSet("fixture", "real")');
    expect(customerLauncherSource).toContain("AGENT_API_KEY");
    expect(customerLauncherSource).toContain("RandomNumberGenerator");
    expect(customerLauncherSource).toContain("Join-Path $repoDrive");
    expect(customerLauncherSource).toContain('Resolve-HostPort $existing "MCP_PORT" 10001');
    expect(customerLauncherSource).toContain('Resolve-HostPort $existing "WEB_PORT" 10003');
    expect(customerLauncherSource).toContain('Resolve-HostPort $existing "API_HOST_PORT" 10004');
    expect(customerLauncherSource).toContain("-ge 10001");
    expect(customerLauncherSource).toContain(
      '[string]$CdpEndpoint = "http://host.docker.internal:10005"',
    );
    expect(customerLauncherSource).toContain("It cannot publish externally");
    expect(customerLauncherSource).not.toContain("F:\\Agent\\Memory system");
    expect(customerLauncherSource).toContain('[string]$PlasticPromiseSourceRoot = ""');
    expect(customerLauncherSource).toContain(
      "PLASTIC_PROMISE_SOURCE_ROOT=$configuredMcpSourceRoot",
    );
    expect(ctripConnectorSource).toContain("PlasticPromiseSourceRoot");
    expect(customerLauncherSource).toContain('[string]$PlasticPromiseSourceRoot = ""');
    expect(customerLauncherSource).toContain(
      "PLASTIC_PROMISE_SOURCE_ROOT=$configuredMcpSourceRoot",
    );
    expect(ctripConnectorSource).toContain("PlasticPromiseSourceRoot");
    expect(ctripConnectorSource).toContain('CtripMode = "browser_unattended"');
    expect(ctripConnectorSource).toContain("& $launcher @arguments");
    expect(ctripConnectorSource).toContain("& $supervisor -Action Install");
    expect(ctripConnectorSource).not.toContain('"-CtripMode", "browser_unattended"');
    expect(customerLauncherSource).toContain("[int]$CtripBrowserDebugPort = 10015");
    expect(customerLauncherSource).toContain("connectport=$CtripBrowserDebugPort");
    expect(customerLauncherSource).toContain("Set-NetFirewallAddressFilter -RemoteAddress");
    expect(ctripSupervisorSource).toContain(
      '[ValidateSet("Install", "Run", "RunOnce", "Status", "Uninstall")]',
    );
    expect(ctripSupervisorSource).toContain("[IO.FileShare]::None");
    expect(ctripSupervisorSource).toContain("ctrip-host-supervisor.lock");
    expect(ctripSupervisorSource).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(ctripSupervisorSource).toContain("/health/ready");
    expect(ctripSupervisorSource).toContain('$request.Host = "127.0.0.1:9030"');
    expect(ctripSupervisorSource).toContain("Unexpected Ctrip bridge readiness status");
    expect(ctripSupervisorSource).toContain("[Net.HttpWebRequest]::Create");
    expect(ctripSupervisorSource).not.toContain("Add-Type -AssemblyName System.Net.Http");
    expect(ctripSupervisorSource).toContain("RunOnce recovery failed");
    expect(ctripSupervisorSource).toContain("function Write-RecoveryPhase");
    expect(ctripSupervisorSource).toContain('"checking_governance"');
    expect(ctripSupervisorSource).toContain("Edge debug ports must be different");
    expect(ctripSupervisorSource).toContain("Ctrip Edge profile must not use drive C:");
    expect(ctripSupervisorSource).toContain("[int]$GovernanceProxyPort = 10002");
    expect(ctripSupervisorSource).toContain("[int]$GovernanceLocalPort = 10012");
    expect(ctripSupervisorSource).toContain("Plastic Promise source root must not use drive C:");
    expect(ctripSupervisorSource).toContain("Governance proxy and local ports must be different");
    expect(ctripSupervisorSource).toContain('Wait-ContainerHealthy "geo-saas-customer-demo-api-1"');
    expect(ctripSupervisorSource).toContain("$stackNeedsRecovery = @(");
    expect(ctripSupervisorSource).toContain("| Where-Object { -not (Test-ContainerHealthy $_) }");
    expect(ctripSupervisorSource).toContain("function Test-TcpPort");
    expect(ctripSupervisorSource).toContain("function Invoke-JsonProbe");
    expect(ctripSupervisorSource).toContain("& curl.exe -sS --max-time");
    expect(ctripSupervisorSource).toContain("function Test-ApiReady");
    expect(ctripSupervisorSource).toContain("if (Test-ApiReady) { return }");
    expect(ctripSupervisorSource).toContain('(Test-TcpPort "127.0.0.1" $GovernanceProxyPort)');
    expect(ctripSupervisorSource).toContain("Plastic Promise MCP did not become healthy");
    expect(ctripSupervisorSource).toContain('$env:PLASTIC_RUNTIME_MODE = "rust-full"');
    expect(ctripSupervisorSource).toContain("Refusing to stop an unverified process");
    expect(ctripSupervisorSource).toContain("Ollama embedding model is unavailable");
    expect(ctripSupervisorSource).toContain('$env:OLLAMA_HOST = "127.0.0.1:11434"');
    expect(ctripSupervisorSource).toContain("$env:OLLAMA_MODELS = $resolvedModelsRoot");
    expect(demoComposeSource).toContain("condition: service_healthy");
    expect(demoComposeSource).toContain("db-configure-customer-demo");
    expect(composeSource).toContain("profiles:\n      - customer-demo");
    expect(composeSource).toContain("${API_HOST_PORT:-10004}:4100");
    expect(composeSource).toContain("${MCP_PORT:-10001}:9021");
    expect(composeSource).toContain("${WEB_PORT:-10003}:8080");
  });

  it("passes the optional Pi provider key through production preflight", () => {
    const preflightBlock = composeSource.slice(
      composeSource.indexOf("  config-preflight:"),
      composeSource.indexOf("  postgres:"),
    );
    const agentMcpBlock = composeSource.slice(
      composeSource.indexOf("  agent-mcp:"),
      composeSource.indexOf("  web:"),
    );
    const apiBlock = composeSource.slice(
      composeSource.indexOf("  api:"),
      composeSource.indexOf("  worker:"),
    );

    expect(preflightBlock).toContain("- AGENT_API_KEY");
    expect(preflightBlock).toContain("- AGENT_BASE_URL");
    expect(preflightBlock).toContain("- AGENT_API");
    expect(preflightBlock).toContain("- AGENT_COMPLETIONS_MODE=${AGENT_COMPLETIONS_MODE:-stream}");
    expect(preflightBlock).toContain("- AGENT_STRICT_TOOL_ARGUMENTS=");
    expect(preflightBlock).toContain("- AGENT_PROVIDER=${AGENT_PROVIDER:-fixture}");
    expect(preflightBlock).toContain("- AGENT_MODEL=${AGENT_MODEL:-fixture-geo-writer-v1}");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_PROVIDER");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_MODEL");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_API");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_COMPLETIONS_MODE");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_BASE_URL");
    expect(preflightBlock).toContain("- MEDIA_INSPECTION_API_KEY");
    expect(agentMcpBlock).toContain("AGENT_API_KEY:\n");
    expect(agentMcpBlock).toContain("AGENT_BASE_URL:\n");
    expect(agentMcpBlock).toContain("AGENT_API:\n");
    expect(agentMcpBlock).toContain("AGENT_COMPLETIONS_MODE: ${AGENT_COMPLETIONS_MODE:-stream}");
    expect(agentMcpBlock).toContain("AGENT_STRICT_TOOL_ARGUMENTS:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_PROVIDER:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_MODEL:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_API:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_COMPLETIONS_MODE:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_BASE_URL:");
    expect(agentMcpBlock).toContain("MEDIA_INSPECTION_API_KEY:");
    expect(agentMcpBlock).toContain("AGENT_RUN_TIMEOUT_MS: ${AGENT_RUN_TIMEOUT_MS:-120000}");
    expect(agentMcpBlock).toContain(
      "AUTOMATION_DRAFT_TIMEOUT_MS: ${AUTOMATION_DRAFT_TIMEOUT_MS:-600000}",
    );
    expect(preflightBlock).toContain("- AGENT_GATEWAY_CREDENTIALS_JSON=");
    expect(apiBlock).toContain("- AGENT_GATEWAY_URL=http://127.0.0.1:9021");
    expect(apiBlock).toContain(
      "- AGENT_GATEWAY_RUN_TIMEOUT_MS=${AGENT_GATEWAY_RUN_TIMEOUT_MS:-130000}",
    );
    expect(apiBlock).toContain("- AGENT_GATEWAY_CREDENTIALS_JSON=");
    expect(customerLauncherSource).toContain(
      '"AGENT_GATEWAY_RUN_TIMEOUT_MS=$agentGatewayRunTimeoutMs"',
    );
    expect(agentMcpBlock).toContain(
      "AUTOMATION_PRODUCER_ENABLED: ${AUTOMATION_PRODUCER_ENABLED:?set true or false explicitly}",
    );
    expect(agentMcpBlock).toContain(
      "AUTOMATION_PRODUCER_ID: ${AUTOMATION_PRODUCER_ID:-geo-automation-primary}",
    );
    expect(agentMcpBlock).toContain(
      "AUTOMATION_PRODUCER_CONCURRENCY: ${AUTOMATION_PRODUCER_CONCURRENCY:-1}",
    );
    expect(composeSource).toContain("GEO_MEDIA_PROVIDER=${GEO_MEDIA_PROVIDER:-disabled}");
    expect(composeSource).toContain("GEO_MEDIA_OBJECT_ROOT=/var/lib/geo/media");
    expect(composeSource).toContain("source: media-data");
    expect(composeSource).toContain("target: /var/lib/geo/media");
    expect(composeSource).toContain("nocopy: true");
  });

  it("allows long-running deadlines only on Agent and licensed-media routes", () => {
    const mediaImportStart = webNginxSource.indexOf(
      'location ~ "^/api/content-versions/[0-9a-f-]{36}/media-search-imports$"',
    );
    const agentRunLocation = webNginxSource.slice(
      webNginxSource.indexOf("location = /api/agent/runs"),
      mediaImportStart,
    );
    const mediaImportLocation = webNginxSource.slice(
      mediaImportStart,
      webNginxSource.indexOf("location /api/"),
    );
    const generalApiLocation = webNginxSource.slice(
      webNginxSource.indexOf("location /api/"),
      webNginxSource.indexOf("location /assets/"),
    );

    expect(agentRunLocation).toContain("proxy_read_timeout 920s;");
    expect(agentRunLocation).toContain("proxy_pass http://api:4100;");
    expect(mediaImportStart).toBeGreaterThan(-1);
    expect(mediaImportLocation).toContain("proxy_read_timeout 920s;");
    expect(mediaImportLocation).toContain("proxy_pass http://api:4100;");
    expect(generalApiLocation).not.toContain("proxy_read_timeout");
  });

  it("allows the operator console to frame only the loopback noVNC handoff", () => {
    const contentSecurityPolicy = webNginxSource
      .split("\n")
      .find((line) => line.includes("add_header Content-Security-Policy"));
    const frameSourceDirective = contentSecurityPolicy?.match(/frame-src ([^;]+);/)?.[1];

    expect(frameSourceDirective).toBe("'self'");
  });

  it("initializes Pi sandbox storage without network or broad container privileges", () => {
    expect(piSandboxLauncherSource).toContain("optional_env_value AGENT_STRICT_TOOL_ARGUMENTS");
    expect(piSandboxLauncherSource).toContain("write_env_line AGENT_STRICT_TOOL_ARGUMENTS");
    expect(piSandboxLauncherSource).toContain("create --no-build --no-deps api");
    expect(piSandboxLauncherSource).toContain('"${PROJECT_NAME}_evidence-data"');
    expect(piSandboxLauncherSource).toContain('"${PROJECT_NAME}_media-data"');
    expect(piSandboxLauncherSource).toContain("--network none");
    expect(piSandboxLauncherSource).toContain("--read-only");
    expect(piSandboxLauncherSource).toContain("--cap-drop ALL");
    expect(piSandboxLauncherSource).toContain("--cap-add CHOWN");
    expect(piSandboxLauncherSource).toContain("--security-opt no-new-privileges=true");
    expect(piSandboxLauncherSource).toContain("--user 0:0");
    expect(piSandboxLauncherSource).toContain("chown -R 1000:1000 /storage");
    expect(piSandboxLauncherSource).not.toContain("--privileged");
  });

  it("keeps production ports loopback-only and isolates browser control from API and Pi", () => {
    const apiBlock = composeSource.slice(
      composeSource.indexOf("  api:"),
      composeSource.indexOf("  worker:"),
    );
    const bridgeBlock = composeSource.slice(
      composeSource.indexOf("  ctrip-bridge:"),
      composeSource.indexOf("  browser-host:"),
    );
    const browserBlock = composeSource.slice(
      composeSource.indexOf("  browser-host:"),
      composeSource.indexOf("  web:"),
    );

    expect(composeSource).not.toContain("BIND_ADDRESS");
    expect(composeSource).not.toContain("host.docker.internal:host-gateway");
    expect(apiBlock).toContain("127.0.0.1:${API_HOST_PORT:-10004}:4100");
    expect(apiBlock).toContain("127.0.0.1:${MCP_PORT:-10001}:9021");
    expect(apiBlock).toContain("source: evidence-data");
    expect(apiBlock).toContain("source: media-data");
    expect(apiBlock.match(/nocopy: true/gu)).toHaveLength(2);
    expect(apiBlock).not.toContain("browser-control");
    expect(bridgeBlock).toContain("127.0.0.1:${CTRIP_BRIDGE_HOST_PORT:-10006}:9030");
    expect(bridgeBlock).toContain("- bridge-api");
    expect(bridgeBlock).toContain("- browser-control");
    expect(bridgeBlock).toContain("source: media-data");
    expect(bridgeBlock).toContain("read_only: true");
    expect(bridgeBlock).toContain("nocopy: true");
    expect(bridgeBlock).not.toContain("network_mode: service:api");
    expect(browserBlock).toContain("127.0.0.1:${CTRIP_NOVNC_HOST_PORT:-10007}:10007");
    expect(browserBlock).not.toMatch(/10005:10005/u);
    expect(browserBlock).toContain("- browser-vnc");
    expect(composeSource).toContain("browser-vnc:\n    internal: true");
    expect(productionComposeSource).toContain("GEO_DEPLOYMENT_PROFILE: standard");
    expect(productionComposeSource).toContain("GEO_GOVERNANCE_MODE: external");
    expect(productionComposeSource).toContain("CTRIP_BRIDGE_GATEWAY_URL: http://ctrip-bridge:9030");
    expect(productionComposeSource).toContain("- governance-host");
    expect(productionComposeSource).toContain("subnet: 172.30.11.0/29");
    expect(productionComposeSource).toContain("plastic-promise-host-proxy:");
    expect(productionComposeSource).toContain("ipv4_address: 172.30.11.2");
    expect(productionComposeSource).toContain('fetch("http://127.0.0.1:10002/mcp"');
    expect(productionComposeSource).toContain("source: /srv/geo-saas/data/governance-proxy");
    expect(productionComposeSource).toContain("response.status !== 400");
    expect(productionComposeSource).not.toContain("${BIND_ADDRESS");
  });

  it("bridges host-loopback governance through a private Unix socket", () => {
    const hostProxyStart = productionComposeSource.indexOf("  plastic-promise-host-proxy:");
    const networkProxyStart = productionComposeSource.indexOf("  plastic-promise-proxy:");
    const apiStart = productionComposeSource.indexOf("  api:", networkProxyStart);
    const hostProxyBlock = productionComposeSource.slice(hostProxyStart, networkProxyStart);
    const networkProxyBlock = productionComposeSource.slice(networkProxyStart, apiStart);
    const governanceNetworkBlock = productionComposeSource.slice(
      productionComposeSource.indexOf(
        "  governance-host:",
        productionComposeSource.indexOf("networks:"),
      ),
    );

    expect(hostProxyBlock).toContain("network_mode: host");
    expect(hostProxyBlock).toContain('const targetHost = "127.0.0.1"');
    expect(hostProxyBlock).toContain(
      "server.listen(socketPath, () => chmodSync(socketPath, 0o600))",
    );
    expect(hostProxyBlock).not.toContain('server.listen(10002, "0.0.0.0")');
    expect(networkProxyBlock).not.toContain("network_mode: host");
    expect(networkProxyBlock).toContain("createConnection({ path: socketPath })");
    expect(networkProxyBlock).toContain('server.listen(10002, "0.0.0.0")');
    expect(networkProxyBlock).toContain("read_only: true");
    expect(networkProxyBlock).toContain("ipv4_address: 172.30.11.2");
    expect(governanceNetworkBlock).toContain("internal: true");
    expect(productionLauncherSource).toContain(
      "require_directory /srv/geo-saas/data/governance-proxy 1000 700",
    );
  });

  it("exposes only the digest-pinned HTTPS edge and rejects non-canonical hosts", () => {
    const preflightBlock = productionComposeSource.slice(
      productionComposeSource.indexOf("  config-preflight:"),
      productionComposeSource.indexOf("  plastic-promise-proxy:"),
    );
    const edgeStart = productionComposeSource.indexOf("  edge:");
    const edgeBlock = productionComposeSource.slice(
      edgeStart,
      productionComposeSource.indexOf("\nvolumes:", edgeStart),
    );

    expect(preflightBlock).toContain("GEO_PUBLIC_DOMAIN:");
    expect(preflightBlock).toContain("APP_ORIGIN:");
    expect(preflightBlock).toContain("WEB_PORT: ${WEB_PORT:-10003}");
    expect(preflightBlock).toContain("GEO_OPERATOR_ORIGIN: ${GEO_OPERATOR_ORIGIN:-}");
    expect(preflightBlock).toContain("GEO_MEDIA_HTTPS_PROXY_URL: ${GEO_MEDIA_HTTPS_PROXY_URL:-}");
    expect(composeSource).toContain("GEO_OPERATOR_ORIGIN=${GEO_OPERATOR_ORIGIN:-}");
    expect(composeSource).toContain("GEO_MEDIA_HTTPS_PROXY_URL=${GEO_MEDIA_HTTPS_PROXY_URL:-}");
    expect(apiServerSource).toContain("env.GEO_OPERATOR_ORIGIN === undefined");
    expect(apiServerSource).toContain("[env.GEO_OPERATOR_ORIGIN]");
    expect(edgeBlock).toContain("image: ${CADDY_IMAGE:?");
    expect(edgeBlock).toContain('user: "1000:1000"');
    expect(edgeBlock).toContain("read_only: true");
    expect(edgeBlock).toContain("- ALL");
    expect(edgeBlock).toContain("- NET_BIND_SERVICE");
    expect(edgeBlock).toContain("- no-new-privileges:true");
    expect(edgeBlock).toContain("0.0.0.0:80:80/tcp");
    expect(edgeBlock).toContain("0.0.0.0:443:443/tcp");
    expect(edgeBlock).toContain("0.0.0.0:443:443/udp");
    expect(edgeBlock).not.toContain("9021");
    expect(edgeBlock).not.toContain("9030");
    expect(edgeBlock).not.toContain("0.0.0.0:10007");
    expect(edgeBlock).toContain("- browser-vnc");
    expect(edgeBlock).toContain("CMD-SHELL");
    expect(edgeBlock).toContain("http://127.0.0.1:2018/healthz");
    expect(edgeBlock).toContain("http://api:4100/health/ready");
    expect(edgeBlock).toContain("http://web:8080/healthz");
    expect(productionCaddySource).toContain("http://127.0.0.1:2018");
    expect(productionCaddySource).toContain("strict_sni_host on");
    expect(productionCaddySource).toContain("respond 421");
    expect(productionCaddySource).toContain("Strict-Transport-Security");
    expect(productionCaddySource).toContain("reverse_proxy api:4100");
    expect(productionCaddySource).toContain("reverse_proxy web:8080");
    expect(productionCaddySource).toContain("forward_auth api:4100");
    expect(productionCaddySource).toContain("/api/internal/ctrip-vnc-authorization");
    expect(productionCaddySource).toContain(
      "header_up X-Geo-Ctrip-Account-Id {re.ctripVncRoute.1}",
    );
    expect(productionCaddySource).toContain("header_up X-Geo-Ctrip-Route {re.ctripVncRoute.2}");
    expect(productionCaddySource).toContain("reverse_proxy browser-host:10007");
    expect(productionCaddySource).toContain('X-Frame-Options "SAMEORIGIN"');
    expect(productionCaddySource).toMatch(
      /@nonCtripVncFramePolicy not path \/ctrip-vnc\/\*\s+header @nonCtripVncFramePolicy \{[\s\S]*?X-Frame-Options "DENY"[\s\S]*?frame-ancestors 'none'[\s\S]*?\}/u,
    );
    expect(productionLauncherSource).toContain('"${compose[@]}" pull --policy missing edge');
    expect(productionLauncherSource).toContain("resolve_edge_image_ref()");
    expect(productionLauncherSource).toContain(
      "production edge image does not resolve exactly once to CADDY_IMAGE",
    );
    expect(productionLauncherSource).toContain(
      "CADDY_IMAGE must equal the release-approved digest-pinned public ECR image",
    );
    expect(productionLauncherSource).toContain(
      "readonly APPROVED_CADDY_IMAGE=public.ecr.aws/docker/library/caddy@sha256:",
    );
    expect(productionLauncherSource).toContain(
      '"${EDGE_IMAGE_REF}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile',
    );
    expect(productionLauncherSource).toContain(
      "--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges:true",
    );
    expect(productionLauncherSource).toContain(
      "Internal production stack started and passed Compose health checks.",
    );
    expect(productionLauncherSource).toContain("External HTTPS acceptance is not complete");
    expect(productionHttpsVerifierSource).toContain("DNS A must resolve only");
    expect(productionHttpsVerifierSource).toContain("unexpected AAAA record");
    expect(productionHttpsVerifierSource).toContain("tr -d '\\r' <\"${http_headers}\"");
    expect(productionHttpsVerifierSource).toContain(
      'grep -Fxiq "location: https://${public_domain}/healthz"',
    );
    expect(productionHttpsVerifierSource).toContain("HTTPS SNI/Host mismatch returned");
    expect(productionHttpsVerifierSource).toContain("https://${public_domain}/api/auth/session");
    expect(productionHttpsVerifierSource).toContain("AUTHENTICATION_REQUIRED");
    expect(productionHttpsVerifierSource).toContain(
      "HTTPS web root did not return an HTML document",
    );
    expect(productionHttpsVerifierSource).toContain("-checkend 604800");
    expect(productionHttpsVerifierSource).toContain("CONNECT_IPV4");
    expect(productionHttpsVerifierSource).toContain(
      '--resolve "${public_domain}:443:${connect_ipv4}"',
    );
    expect(productionHttpsVerifierSource).toContain(
      'openssl s_client -connect "${connect_ipv4}:443"',
    );
  });

  it("keeps Chromium sandboxed under a release-matched enforcing AppArmor profile", () => {
    expect(browserAppArmorSource).toContain("abi <abi/5.0>");
    expect(browserAppArmorSource).toContain("network unix,");
    expect(browserAppArmorSource).toContain("deny network alg,");
    expect(browserAppArmorSource).toContain("userns,");
    expect(browserAppArmorSource).not.toContain("flags=(unconfined)");
    const browserSeccompPolicy = JSON.parse(browserSeccompSource) as {
      defaultAction?: string;
      syscalls?: {
        action?: string;
        errnoRet?: number;
        names?: string[];
        args?: {
          index?: number;
          value?: number;
          valueTwo?: number;
          op?: string;
        }[];
      }[];
    };
    expect(browserSeccompPolicy.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(browserSeccompPolicy.syscalls).toContainEqual(
      expect.objectContaining({
        action: "SCMP_ACT_ALLOW",
        names: expect.arrayContaining(["clone", "setns", "unshare"]),
      }),
    );
    expect(browserSeccompPolicy.syscalls).toContainEqual(
      expect.objectContaining({
        action: "SCMP_ACT_ALLOW",
        includes: {},
        names: ["chroot"],
      }),
    );
    expect(browserSeccompPolicy.syscalls).toContainEqual(
      expect.objectContaining({
        action: "SCMP_ACT_ERRNO",
        errnoRet: 38,
        includes: {},
        names: ["clone3"],
      }),
    );
    expect(browserSeccompPolicy.syscalls).toContainEqual(
      expect.objectContaining({
        action: "SCMP_ACT_ALLOW",
        includes: {},
        names: ["clone"],
        args: [
          expect.objectContaining({
            index: 0,
            value: 2114060288,
            valueTwo: 536870912,
            op: "SCMP_CMP_MASKED_EQ",
          }),
        ],
      }),
    );
    const namespaceRules = browserSeccompPolicy.syscalls?.filter(
      (rule) =>
        ["clone", "setns", "unshare"].some((name) => rule.names?.includes(name)) &&
        rule.args?.some(
          (argument) =>
            argument.value === 268435456 &&
            argument.valueTwo === 268435456 &&
            argument.op === "SCMP_CMP_MASKED_EQ",
        ),
    );
    expect(namespaceRules).toHaveLength(3);
    expect(namespaceRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          names: ["clone"],
          args: [
            expect.objectContaining({
              index: 0,
              value: 268435456,
              valueTwo: 268435456,
              op: "SCMP_CMP_MASKED_EQ",
            }),
          ],
        }),
        expect.objectContaining({
          names: ["setns"],
          args: [
            expect.objectContaining({
              index: 1,
              value: 268435456,
              valueTwo: 268435456,
              op: "SCMP_CMP_MASKED_EQ",
            }),
          ],
        }),
        expect.objectContaining({
          names: ["unshare"],
          args: [
            expect.objectContaining({
              index: 0,
              value: 268435456,
              valueTwo: 268435456,
              op: "SCMP_CMP_MASKED_EQ",
            }),
          ],
        }),
      ]),
    );
    expect(browserAppArmorInstallerSource).toContain("apparmor_parser -Q -K --warn=all");
    expect(browserAppArmorInstallerSource).toContain('apparmor_parser -Kr "${temporary_path}"');
    expect(browserAppArmorInstallerSource).toContain('mv -fT -- "${temporary_path}"');
    expect(browserAppArmorInstallerSource).toContain("(enforce)");
    expect(browserHostEntrypointSource).toContain("browser-host-account-manager.mjs");
    expect(browserHostAccountManagerSource).toContain(
      'const passwordFile = "/run/secrets/ctrip-vnc.passwd"',
    );
    expect(browserHostAccountManagerSource).toContain('"-rfbauth"');
    expect(browserHostAccountManagerSource).not.toContain("-nopw");
    expect(browserHostAccountManagerSource).toContain('"--remote-debugging-address=127.0.0.1"');
    expect(browserHostAccountManagerSource).toContain("`--remote-debugging-port=${cdpPort}`");
    expect(browserHostAccountManagerSource).toContain('join(directory, ".geo-account-id")');
    expect(browserHostAccountManagerSource).toContain(
      'for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"])',
    );
    expect(browserHostAccountManagerSource).toContain(
      'throw new TypeError("browser profile contains an unsafe singleton entry")',
    );
    expect(browserHostAccountManagerSource).toContain(
      'const upstream = createConnection({ host: "127.0.0.1", port })',
    );
    expect(browserHostAccountManagerSource).toContain('cdpServer.listen(CDP_HOST_PORT, "0.0.0.0"');
    expect(browserHostHealthSource).toContain("http://127.0.0.1:10005/health/live");
    expect(browserHostHealthSource).toContain("http://127.0.0.1:10007/vnc.html");
    expect(browserHostAccountManagerSource).toContain("`--user-data-dir=${profileDirectory}`");
    expect(browserHostAccountManagerSource).toContain(
      "const chromiumArgs = chromiumLaunchArguments({",
    );
    expect(browserHostAccountManagerSource).toContain(
      'const CGROUP_PIDS_CURRENT_PATH = "/sys/fs/cgroup/pids.current"',
    );
    expect(browserHostAccountManagerSource).toContain("taskCount: admission.taskCount");
    expect(browserHostAccountManagerSource).toContain("maxTaskCount: admission.maxTaskCount");
    expect(browserHostAccountManagerSource).toContain(
      "taskInventoryHealthy: admission.taskInventoryHealthy",
    );
    expect(browserHostAccountManagerSource).toContain("enforceStartAdmission: true");
    expect(browserHostAccountManagerSource).toContain("BROWSER_HOST_ADMISSION_PAUSED");
    expect(browserHostAccountManagerSource).toContain("START_URL");
    expect(browserHostAccountManagerSource).not.toContain("--restore-last-session");
    expect(composeSource).toContain("seccomp=./deploy/seccomp/geo-saas-browser-host.json");
    expect(composeSource).toContain("target: /run/secrets/ctrip-vnc.passwd");
    expect(productionComposeSource).toContain("CTRIP_VNC_PASSWORD_FILE");
    expect(productionComposeSource).toContain("CTRIP_BROWSER_TASK_LIMIT");
    expect(productionComposeSource).toContain("apparmor=geo-saas-browser-host");
    expect(productionLauncherSource).toContain("cmp --silent");
    expect(productionLauncherSource).toContain("--network none");
    expect(productionLauncherSource).toContain("--cap-drop ALL");
    expect(productionLauncherSource).toContain("apparmor=${BROWSER_APPARMOR_PROFILE}");
    expect(productionLauncherSource).toContain("seccomp=${BROWSER_SECCOMP_SOURCE}");
  });

  it("uses host networking only for the bounded Browser Host image build", () => {
    const browserBlock = composeSource.slice(
      composeSource.indexOf("  browser-host:"),
      composeSource.indexOf("  web:"),
    );
    const buildBlock = browserBlock.slice(
      browserBlock.indexOf("    build:"),
      browserBlock.indexOf("    profiles:"),
    );

    expect(buildBlock).toContain("network: host");
    expect(browserBlock).not.toContain("network_mode: host");
    expect(browserBlock).toContain("- browser-control");
    expect(browserBlock).toContain("- browser-egress");
    const dependencyInstall = browserDockerfileSource.indexOf("RUN timeout --signal=TERM");
    const revisionLabel = browserDockerfileSource.indexOf(
      'LABEL org.opencontainers.image.revision="${GEO_IMAGE_REVISION}"',
    );
    expect(browserDockerfileSource).toContain("timeout --signal=TERM --kill-after=15s 1200s");
    expect(browserDockerfileSource).toContain("Acquire::Retries=3");
    expect(browserDockerfileSource).toContain("Acquire::http::Timeout=30");
    expect(browserDockerfileSource).toContain("Acquire::https::Timeout=30");
    expect(dependencyInstall).toBeGreaterThan(-1);
    expect(revisionLabel).toBeGreaterThan(dependencyInstall);
  });

  it("checks tenant Browser Host leaves before the first production image build", () => {
    const tenantDirectoryCheck = productionLauncherSource.slice(
      productionLauncherSource.indexOf("require_tenant_directory()"),
      productionLauncherSource.indexOf("compose_environment_value()"),
    );
    const profileCheck = productionLauncherSource.indexOf(
      'require_tenant_directory "${BROWSER_PROFILE_ROOT}/${BROWSER_TENANT_ID}/ctrip"',
    );
    const downloadCheck = productionLauncherSource.indexOf(
      'require_tenant_directory "${BROWSER_DOWNLOAD_ROOT}/${BROWSER_TENANT_ID}"',
    );
    const artifactCheck = productionLauncherSource.indexOf(
      'require_tenant_directory "${BROWSER_ARTIFACT_ROOT}/${BROWSER_TENANT_ID}"',
    );
    const firstBuild = productionLauncherSource.indexOf('"${compose[@]}" build config-preflight');

    expect(tenantDirectoryCheck).toContain('[[ -d "${path}" && ! -L "${path}" ]]');
    expect(tenantDirectoryCheck).toContain("stat -c '%u'");
    expect(tenantDirectoryCheck).toContain("stat -c '%g'");
    expect(tenantDirectoryCheck).toContain("stat -c '%a'");
    expect(tenantDirectoryCheck).toContain('[[ "${actual_uid}" == 10001 ]]');
    expect(tenantDirectoryCheck).toContain('[[ "${actual_gid}" == 10001 ]]');
    expect(tenantDirectoryCheck).toContain('[[ "${actual_mode}" == 700 ]]');
    expect(profileCheck).toBeGreaterThan(-1);
    expect(downloadCheck).toBeGreaterThan(profileCheck);
    expect(artifactCheck).toBeGreaterThan(downloadCheck);
    expect(firstBuild).toBeGreaterThan(artifactCheck);
  });

  it("stamps every project image with the exact release revision before startup", () => {
    expect(dockerfileSource).toContain("ARG GEO_IMAGE_REVISION=local");
    expect(dockerfileSource.match(/LABEL org\.opencontainers\.image\.revision=/gu)).toHaveLength(2);
    expect(browserDockerfileSource).toContain("ARG GEO_IMAGE_REVISION=local");
    expect(browserDockerfileSource).toContain(
      'LABEL org.opencontainers.image.revision="${GEO_IMAGE_REVISION}"',
    );
    expect(composeSource.match(/^\s+- GEO_IMAGE_REVISION$/gmu)).toHaveLength(3);
    expect(productionLauncherSource).toContain(
      "for image_service in config-preflight api worker agent-mcp ctrip-bridge browser-host web",
    );
    expect(productionLauncherSource).toContain(
      '"${compose[@]}" build api worker agent-mcp ctrip-bridge browser-host web',
    );
    expect(productionLauncherSource).not.toContain('\n"${compose[@]}" build\n');
    expect(productionLauncherSource).toContain('[[ "${IMAGE_PREFIX}" =~ ^[a-z0-9]');
    expect(productionLauncherSource).toContain(
      'expected_ref="${IMAGE_PREFIX}-${image_suffix}:${IMAGE_TAG}"',
    );
    expect(productionLauncherSource).toContain(
      'rendered_refs="$("${compose[@]}" config --images "${service_name}")"',
    );
    expect(productionLauncherSource).toContain('[[ "${matches}" == 1 ]]');
    expect(productionLauncherSource).toContain(
      'image_ref="$(resolve_project_image_ref "${image_service}" "${image_suffix}")"',
    );
    expect(productionLauncherSource).not.toContain(
      'image_ref="$("${compose[@]}" config --images "${image_service}")"',
    );
    expect(productionLauncherSource).toContain(
      'index .Config.Labels "org.opencontainers.image.revision"',
    );
    expect(productionLauncherSource).toContain(
      "GEO_IMAGE_REVISION must be the exact lowercase 40-character release commit",
    );
    expect(
      productionLauncherSource.indexOf(
        "built config-preflight image revision does not match GEO_IMAGE_REVISION",
      ),
    ).toBeLessThan(productionLauncherSource.indexOf("docker_local run --rm --network none"));
    expect(productionLauncherSource).toContain(
      "readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock",
    );
    expect(productionLauncherSource).toContain('DOCKER_HOST="${LOCAL_DOCKER_HOST}"');
    expect(productionLauncherSource).toContain("COMPOSE_DISABLE_ENV_FILE=1");
    expect(productionLauncherSource).toContain("env -i");
    expect(productionLauncherSource).toContain("docker_local compose");
    expect(productionLauncherSource).toContain(
      'readonly RELEASE_MARKER="${ROOT_DIR}/.geo-release"',
    );
    expect(productionLauncherSource).toContain("release marker mode must be exactly 444");
    expect(productionLauncherSource).toContain(
      "GEO_IMAGE_REVISION does not match the immutable release marker",
    );
    expect(productionLauncherSource).toContain(
      "GEO_IMAGE_TAG must equal the immutable release commit",
    );
    expect(
      productionLauncherSource.indexOf("release marker mode must be exactly 444"),
    ).toBeLessThan(productionLauncherSource.indexOf("docker_local compose version"));
  });

  it("accepts a complete OpenAI-compatible production provider configuration", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        AGENT_PROVIDER: "openai-compatible",
        AGENT_MODEL: "custom-model",
        AGENT_BASE_URL: "https://models.example.test/v1",
        AGENT_API: "openai-completions",
        AGENT_API_KEY: "real-provider-secret",
        AGENT_STRICT_TOOL_ARGUMENTS: "true",
      }),
    ).toMatchObject({
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "custom-model",
      AGENT_BASE_URL: "https://models.example.test/v1",
      AGENT_API: "openai-completions",
      AGENT_STRICT_TOOL_ARGUMENTS: true,
    });
  });

  it("keeps the production media inspection model independent from the drafting model", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        AGENT_PROVIDER: "openai-compatible",
        AGENT_MODEL: "deepseek-v4-pro",
        AGENT_BASE_URL: "https://api.deepseek.com",
        AGENT_API: "openai-completions",
        AGENT_COMPLETIONS_MODE: "json",
        AGENT_API_KEY: "draft-provider-secret",
        MEDIA_INSPECTION_PROVIDER: "openai-compatible",
        MEDIA_INSPECTION_MODEL: "vision-model",
        MEDIA_INSPECTION_BASE_URL: "https://vision.example.test/v1",
        MEDIA_INSPECTION_API: "openai-responses",
        MEDIA_INSPECTION_COMPLETIONS_MODE: "stream",
        MEDIA_INSPECTION_API_KEY: "vision-provider-secret",
      }),
    ).toMatchObject({
      AGENT_MODEL: "deepseek-v4-pro",
      MEDIA_INSPECTION_PROVIDER: "openai-compatible",
      MEDIA_INSPECTION_MODEL: "vision-model",
      MEDIA_INSPECTION_BASE_URL: "https://vision.example.test/v1",
      MEDIA_INSPECTION_API: "openai-responses",
      MEDIA_INSPECTION_COMPLETIONS_MODE: "stream",
      MEDIA_INSPECTION_API_KEY: "vision-provider-secret",
    });
  });

  it("preserves the existing vision configuration when switching drafting to V4 Pro", () => {
    expect(deepseekConfiguratorSource).toContain("preserve_legacy_media_inspection_configuration");
    expect(
      deepseekConfiguratorSource.indexOf("preserve_legacy_media_inspection_configuration"),
    ).toBeLessThan(deepseekConfiguratorSource.indexOf("AGENT_PROVIDER=openai-compatible"));
    expect(deepseekConfiguratorSource).toContain("deepseek-v4-pro");
    expect(deepseekConfiguratorSource).not.toContain("deepseek-v4-flash");
  });
});
