import { createCustomerDemoGovernanceClient } from "@geo/agent";
import { connectPlasticPromiseStreamableHttp } from "@geo/agent/plastic-promise-transport";
import type { ThinkingLevel } from "@geo/agent/pi";

import { readAutomationProducerConfig } from "./automation-config.js";
import { createGeoAutomationProducerDependencies } from "./automation-producer-adapter.js";
import { AutomationProducer } from "./automation-producer.js";
import {
  HttpInternalGeoApiClient,
  GeoApiSessionRegistry,
  parseMcpPrincipalCredentials,
} from "./http-api-client.js";
import { createGeoMcpHttpServer, listenGeoMcpHttpServer } from "./http-server.js";
import { readPiServiceRuntimeConfiguration } from "./model-config.js";
import {
  HotReloadingMediaInspectionService,
  HotReloadingPiAgentRunService,
} from "./runtime-provider-config.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function durationEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 15 * 60_000) {
    throw new Error(`${name} must be between 1000 and 900000 milliseconds`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function commaSeparated(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  const values = (raw === undefined ? fallback : raw.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

function thinkingLevelEnvironment(name: string, fallback: ThinkingLevel): ThinkingLevel {
  const value = (process.env[name] ?? fallback).trim();
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    throw new Error(`${name} must be off, minimal, low, medium, high, or xhigh`);
  }
  return value as ThinkingLevel;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? String(fallback)).trim().toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = integerEnvironment("MCP_PORT", 10001);
const sessions = new GeoApiSessionRegistry({
  baseUrl: requiredEnvironment("GEO_API_BASE_URL"),
  credentials: parseMcpPrincipalCredentials(requiredEnvironment("MCP_PRINCIPALS_JSON")),
});
const api = new HttpInternalGeoApiClient({ sessions });
const governanceMode = process.env.GEO_GOVERNANCE_MODE ?? "external";
const deploymentProfile = process.env.GEO_DEPLOYMENT_PROFILE ?? "standard";
const agentProvider = process.env.AGENT_PROVIDER ?? "fixture";
const allowRealPiInDemo = booleanEnvironment("GEO_ALLOW_REAL_PI_IN_DEMO", false);
if (governanceMode !== "external" && governanceMode !== "demo_fixture") {
  throw new Error("GEO_GOVERNANCE_MODE must be external or demo_fixture");
}
if (governanceMode === "demo_fixture" && deploymentProfile !== "customer_demo") {
  throw new Error("Demo governance is restricted to the customer_demo deployment profile");
}
if (
  allowRealPiInDemo &&
  (deploymentProfile !== "customer_demo" || governanceMode !== "demo_fixture")
) {
  throw new Error("GEO_ALLOW_REAL_PI_IN_DEMO is allowed only with customer_demo and demo_fixture");
}
if (governanceMode === "demo_fixture" && agentProvider !== "fixture" && !allowRealPiInDemo) {
  throw new Error("Demo governance can only run with the fixture Pi provider");
}
const governanceAuthorization = process.env.PLASTIC_PROMISE_MCP_AUTHORIZATION?.trim();
const contextSupplyEnabled = booleanEnvironment("GEO_CONTEXT_RETRIEVAL_ENABLED", false);
const governance =
  governanceMode === "demo_fixture"
    ? createCustomerDemoGovernanceClient({ contextSupplyEnabled })
    : await (async () => {
        const governanceEndpoint = new URL(requiredEnvironment("PLASTIC_PROMISE_MCP_URL"));
        return connectPlasticPromiseStreamableHttp({
          endpoint: governanceEndpoint.href,
          allowedOrigins: [governanceEndpoint.origin],
          allowDockerHost: process.env.GEO_DEPLOYMENT_PROFILE === "customer_demo",
          allowServerDockerGateway:
            process.env.NODE_ENV === "production" &&
            process.env.GEO_DEPLOYMENT_PROFILE === "standard",
          ...(governanceAuthorization === undefined || governanceAuthorization.length === 0
            ? {}
            : { authorizationHeader: governanceAuthorization }),
          contextSupplyEnabled,
        });
      })();
const agentModel = process.env.AGENT_MODEL ?? "fixture-geo-writer-v1";
const maxPiToolCalls = positiveIntegerEnvironment("AGENT_MAX_TOOL_CALLS", 64);
const maxRepeatedPiToolCalls = positiveIntegerEnvironment("AGENT_MAX_REPEATED_TOOL_CALLS", 3, 2);
const agentThinkingLevel = thinkingLevelEnvironment("AGENT_REASONING_EFFORT", "high");
const strictToolArguments = booleanEnvironment("AGENT_STRICT_TOOL_ARGUMENTS", false);
const allowRuntimeRealProviders = governanceMode !== "demo_fixture" || allowRealPiInDemo;
const fallbackRuntime =
  agentProvider === "fixture" ? undefined : readPiServiceRuntimeConfiguration(process.env);
const agentRunner = new HotReloadingPiAgentRunService({
  source: api,
  api,
  governance,
  ...(agentProvider === "fixture" ? { fallbackFixtureModel: agentModel } : {}),
  ...(fallbackRuntime === undefined ? {} : { fallbackRuntime }),
  thinkingLevel: agentThinkingLevel,
  strictToolArguments,
  maxToolCalls: maxPiToolCalls,
  maxRepeatedToolCalls: maxRepeatedPiToolCalls,
  allowRuntimeRealProviders,
});
const mediaInspector = new HotReloadingMediaInspectionService({
  source: api,
  ...(fallbackRuntime === undefined ? {} : { fallback: fallbackRuntime.mediaInspection }),
  allowRuntimeRealProviders,
});
const automationConfig = readAutomationProducerConfig();
const automationProducer = new AutomationProducer(
  createGeoAutomationProducerDependencies({
    sessions,
    api,
    governance,
    agentRunner,
    draftTimeoutMs: automationConfig.draftTimeoutMs,
    deliveryPollIntervalMs: automationConfig.deliveryPollIntervalMs,
  }),
  {
    producerId: automationConfig.producerId,
    enabled: automationConfig.enabled,
    concurrency: automationConfig.concurrency,
    pollIntervalMs: automationConfig.pollIntervalMs,
    leaseDurationMs: automationConfig.leaseDurationMs,
    heartbeatIntervalMs: automationConfig.heartbeatIntervalMs,
  },
);
const server = createGeoMcpHttpServer({
  api,
  authenticator: sessions,
  agentRunner,
  mediaInspector,
  agentRunTimeoutMs: durationEnvironment("AGENT_RUN_TIMEOUT_MS", 120_000),
  automationProducer,
  allowedHosts: commaSeparated("MCP_ALLOWED_HOSTS", [`127.0.0.1:${port}`, `localhost:${port}`]),
  allowedOrigins: commaSeparated("MCP_ALLOWED_ORIGINS", ["http://127.0.0.1", "http://localhost"]),
});

await listenGeoMcpHttpServer(server, { host, port });
const automationLifecycle = automationProducer.start();
void automationLifecycle.catch(() => {
  console.error(JSON.stringify({ level: "error", event: "agent_mcp.automation_producer_failed" }));
  process.exitCode = 1;
});
console.info(
  JSON.stringify({
    level: "info",
    event: "agent_mcp.started",
    host,
    port,
    agent: agentRunner.capability,
    governanceMode,
    automation: automationProducer.health(),
  }),
);

server.once("close", () => {
  void automationProducer.stop({ mode: "abort" });
  void governance.close();
});

let closing = false;
async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}

async function shutdown(): Promise<void> {
  try {
    await automationProducer.stop({ mode: "abort" });
    await closeServer();
  } catch {
    console.error(JSON.stringify({ level: "error", event: "agent_mcp.stop_failed" }));
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void shutdown();
  });
}
