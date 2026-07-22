import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { productionDeploymentEnvSchema, serverEnvSchema } from "./index.js";

const composeSource = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
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
    expect(env.AGENT_GATEWAY_RUN_TIMEOUT_MS).toBe(130_000);
    expect(env.API_PORT).toBe(10004);
    expect(env.MCP_PORT).toBe(10001);
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

describe("productionDeploymentEnvSchema", () => {
  const validProductionEnvironment = {
    POSTGRES_ADMIN_PASSWORD: "admin-production-secret",
    GEO_API_DB_PASSWORD: "api-production-secret",
    GEO_WORKER_DB_PASSWORD: "worker-production-secret",
    GEO_IDENTITY_DB_PASSWORD: "identity-production-secret",
    SESSION_SECRET: "a-real-production-session-secret-value",
    PLASTIC_PROMISE_MCP_URL: "https://plastic-promise.example.test/mcp",
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
  };

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
    expect(productionDeploymentEnvSchema.parse(validProductionEnvironment)).toMatchObject(
      validProductionEnvironment,
    );
  });

  it("rejects fixture media in external production deployments", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_MEDIA_PROVIDER: "fixture",
      }),
    ).toThrow(/GEO_MEDIA_PROVIDER=disabled/iu);
  });

  it("accepts real Pi and external governance for the loopback customer profile", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_DEPLOYMENT_PROFILE: "customer_demo",
        GEO_GOVERNANCE_MODE: "external",
        AGENT_PROVIDER: "openai-compatible",
        AGENT_MODEL: "geo-writer",
        AGENT_BASE_URL: "https://model.example.test/v1",
        AGENT_API: "openai-completions",
        AGENT_API_KEY: "a-real-agent-provider-key",
        APP_ORIGIN: "http://127.0.0.1:4173",
      }),
    ).toMatchObject({
      GEO_DEPLOYMENT_PROFILE: "customer_demo",
      GEO_GOVERNANCE_MODE: "external",
      AGENT_PROVIDER: "openai-compatible",
      AGENT_API: "openai-completions",
    });
  });

  it("accepts the loopback customer demo without an external governance URL", () => {
    expect(
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_DEPLOYMENT_PROFILE: "customer_demo",
        GEO_GOVERNANCE_MODE: "demo_fixture",
        PLASTIC_PROMISE_MCP_URL: "",
        PLASTIC_PROMISE_MCP_AUTHORIZATION: "",
      }),
    ).toMatchObject({
      GEO_DEPLOYMENT_PROFILE: "customer_demo",
      GEO_GOVERNANCE_MODE: "demo_fixture",
    });
  });

  it("rejects demo governance outside the customer demo profile", () => {
    expect(() =>
      productionDeploymentEnvSchema.parse({
        ...validProductionEnvironment,
        GEO_GOVERNANCE_MODE: "demo_fixture",
      }),
    ).toThrow(/customer_demo/iu);
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
    expect(customerLauncherSource).toContain('PLASTIC_PROMISE_SOURCE_ROOT=$configuredMcpSourceRoot');
    expect(ctripConnectorSource).toContain('PlasticPromiseSourceRoot');
    expect(customerLauncherSource).toContain('[string]$PlasticPromiseSourceRoot = ""');
    expect(customerLauncherSource).toContain('PLASTIC_PROMISE_SOURCE_ROOT=$configuredMcpSourceRoot');
    expect(ctripConnectorSource).toContain('PlasticPromiseSourceRoot');
    expect(ctripConnectorSource).toContain('CtripMode = "browser_unattended"');
    expect(ctripConnectorSource).toContain("& $launcher @arguments");
    expect(ctripConnectorSource).toContain('& $supervisor -Action Install');
    expect(ctripConnectorSource).not.toContain('"-CtripMode", "browser_unattended"');
    expect(customerLauncherSource).toContain('[int]$CtripBrowserDebugPort = 10015');
    expect(customerLauncherSource).toContain('connectport=$CtripBrowserDebugPort');
    expect(customerLauncherSource).toContain('Set-NetFirewallAddressFilter -RemoteAddress');
    expect(ctripSupervisorSource).toContain('[ValidateSet("Install", "Run", "RunOnce", "Status", "Uninstall")]');
    expect(ctripSupervisorSource).toContain('[IO.FileShare]::None');
    expect(ctripSupervisorSource).toContain('ctrip-host-supervisor.lock');
    expect(ctripSupervisorSource).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(ctripSupervisorSource).toContain('/health/ready');
    expect(ctripSupervisorSource).toContain('$request.Host = "127.0.0.1:9030"');
    expect(ctripSupervisorSource).toContain('Unexpected Ctrip bridge readiness status');
    expect(ctripSupervisorSource).toContain('[Net.HttpWebRequest]::Create');
    expect(ctripSupervisorSource).not.toContain('Add-Type -AssemblyName System.Net.Http');
    expect(ctripSupervisorSource).toContain('RunOnce recovery failed');
    expect(ctripSupervisorSource).toContain('function Write-RecoveryPhase');
    expect(ctripSupervisorSource).toContain('"checking_governance"');
    expect(ctripSupervisorSource).toContain('Edge debug ports must be different');
    expect(ctripSupervisorSource).toContain('Ctrip Edge profile must not use drive C:');
    expect(ctripSupervisorSource).toContain('[int]$GovernanceProxyPort = 10002');
    expect(ctripSupervisorSource).toContain('[int]$GovernanceLocalPort = 10012');
    expect(ctripSupervisorSource).toContain('Plastic Promise source root must not use drive C:');
    expect(ctripSupervisorSource).toContain('Governance proxy and local ports must be different');
    expect(ctripSupervisorSource).toContain('Wait-ContainerHealthy "geo-saas-customer-demo-api-1"');
    expect(ctripSupervisorSource).toContain('$stackNeedsRecovery = @(');
    expect(ctripSupervisorSource).toContain('| Where-Object { -not (Test-ContainerHealthy $_) }');
    expect(ctripSupervisorSource).toContain('function Test-TcpPort');
    expect(ctripSupervisorSource).toContain('function Invoke-JsonProbe');
    expect(ctripSupervisorSource).toContain('& curl.exe -sS --max-time');
    expect(ctripSupervisorSource).toContain('function Test-ApiReady');
    expect(ctripSupervisorSource).toContain('if (Test-ApiReady) { return }');
    expect(ctripSupervisorSource).toContain('(Test-TcpPort "127.0.0.1" $GovernanceProxyPort)');
    expect(ctripSupervisorSource).toContain('Plastic Promise MCP did not become healthy');
    expect(ctripSupervisorSource).toContain('$env:PLASTIC_RUNTIME_MODE = "rust-full"');
    expect(ctripSupervisorSource).toContain('Refusing to stop an unverified process');
    expect(ctripSupervisorSource).toContain('Ollama embedding model is unavailable');
    expect(ctripSupervisorSource).toContain('$env:OLLAMA_HOST = "127.0.0.1:11434"');
    expect(ctripSupervisorSource).toContain('$env:OLLAMA_MODELS = $resolvedModelsRoot');
    expect(demoComposeSource).toContain('condition: service_healthy');
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
    expect(preflightBlock).toContain("- AGENT_PROVIDER=${AGENT_PROVIDER:-fixture}");
    expect(preflightBlock).toContain("- AGENT_MODEL=${AGENT_MODEL:-fixture-geo-writer-v1}");
    expect(agentMcpBlock).toContain("AGENT_API_KEY: ${AGENT_API_KEY:-}");
    expect(agentMcpBlock).toContain("AGENT_BASE_URL: ${AGENT_BASE_URL:-}");
    expect(agentMcpBlock).toContain("AGENT_API: ${AGENT_API:-}");
    expect(agentMcpBlock).toContain("AGENT_RUN_TIMEOUT_MS: ${AGENT_RUN_TIMEOUT_MS:-120000}");
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
    expect(composeSource).toContain("media-data:/var/lib/geo/media");
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
      }),
    ).toMatchObject({
      AGENT_PROVIDER: "openai-compatible",
      AGENT_MODEL: "custom-model",
      AGENT_BASE_URL: "https://models.example.test/v1",
      AGENT_API: "openai-completions",
    });
  });
});
