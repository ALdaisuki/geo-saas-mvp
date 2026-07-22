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
import {
  PiVisionMediaInspectionService,
  type MediaInspectionService,
} from "./media-inspection-runner.js";
import { resolvePiAgentModel } from "./model-config.js";
import {
  FixturePiAgentRunService,
  RealPiAgentRunService,
  type PiAgentRunService,
} from "./pi-runner.js";

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

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = integerEnvironment("MCP_PORT", 10001);
const sessions = new GeoApiSessionRegistry({
  baseUrl: requiredEnvironment("GEO_API_BASE_URL"),
  credentials: parseMcpPrincipalCredentials(requiredEnvironment("MCP_PRINCIPALS_JSON")),
});
const api = new HttpInternalGeoApiClient({ sessions });
const governanceMode = process.env.GEO_GOVERNANCE_MODE ?? "external";
if (governanceMode !== "external" && governanceMode !== "demo_fixture") {
  throw new Error("GEO_GOVERNANCE_MODE must be external or demo_fixture");
}
if (governanceMode === "demo_fixture" && process.env.GEO_DEPLOYMENT_PROFILE !== "customer_demo") {
  throw new Error("Demo governance is restricted to the customer_demo deployment profile");
}
if (governanceMode === "demo_fixture" && (process.env.AGENT_PROVIDER ?? "fixture") !== "fixture") {
  throw new Error("Demo governance can only run with the fixture Pi provider");
}
const governanceAuthorization = process.env.PLASTIC_PROMISE_MCP_AUTHORIZATION?.trim();
const governance =
  governanceMode === "demo_fixture"
    ? createCustomerDemoGovernanceClient()
    : await (async () => {
        const governanceEndpoint = new URL(requiredEnvironment("PLASTIC_PROMISE_MCP_URL"));
        return connectPlasticPromiseStreamableHttp({
          endpoint: governanceEndpoint.href,
          allowedOrigins: [governanceEndpoint.origin],
          allowDockerHost: process.env.GEO_DEPLOYMENT_PROFILE === "customer_demo",
          ...(governanceAuthorization === undefined || governanceAuthorization.length === 0
            ? {}
            : { authorizationHeader: governanceAuthorization }),
        });
      })();
const agentProvider = process.env.AGENT_PROVIDER ?? "fixture";
const agentModel = process.env.AGENT_MODEL ?? "fixture-geo-writer-v1";
const configuredAgentApi = process.env.AGENT_API?.trim();
const maxPiToolCalls = positiveIntegerEnvironment("AGENT_MAX_TOOL_CALLS", 64);
const maxRepeatedPiToolCalls = positiveIntegerEnvironment("AGENT_MAX_REPEATED_TOOL_CALLS", 3, 2);
const agentThinkingLevel = thinkingLevelEnvironment("AGENT_REASONING_EFFORT", "off");
let agentRunner: PiAgentRunService;
let mediaInspector: MediaInspectionService | undefined;
if (agentProvider === "fixture") {
  agentRunner = new FixturePiAgentRunService({ api, governance, model: agentModel });
} else {
  const resolvedModel = resolvePiAgentModel({
    provider: agentProvider,
    modelId: agentModel,
    ...(process.env.AGENT_BASE_URL === undefined ? {} : { baseUrl: process.env.AGENT_BASE_URL }),
    ...(configuredAgentApi === undefined || configuredAgentApi.length === 0
      ? {}
      : { api: configuredAgentApi }),
  });
  const apiKey = requiredEnvironment("AGENT_API_KEY");
  agentRunner = new RealPiAgentRunService({
    api,
    governance,
    provider: resolvedModel.provider,
    model: resolvedModel.model,
    modelId: agentModel,
    apiKey,
    thinkingLevel: agentThinkingLevel,
    maxToolCalls: maxPiToolCalls,
    maxRepeatedToolCalls: maxRepeatedPiToolCalls,
  });
  mediaInspector = new PiVisionMediaInspectionService({
    model: resolvedModel.model,
    modelId: agentModel,
    apiKey,
  });
}
const automationConfig = readAutomationProducerConfig();
const automationProducer = new AutomationProducer(
  createGeoAutomationProducerDependencies({
    sessions,
    api,
    governance,
    agentRunner,
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
  ...(mediaInspector === undefined ? {} : { mediaInspector }),
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
