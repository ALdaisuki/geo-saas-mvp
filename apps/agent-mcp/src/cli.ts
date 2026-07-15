import { connectPlasticPromiseStreamableHttp } from "@geo/agent/plastic-promise-transport";
import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";

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

function commaSeparated(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  const values = (raw === undefined ? fallback : raw.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = integerEnvironment("MCP_PORT", 9021);
const sessions = new GeoApiSessionRegistry({
  baseUrl: requiredEnvironment("GEO_API_BASE_URL"),
  credentials: parseMcpPrincipalCredentials(requiredEnvironment("MCP_PRINCIPALS_JSON")),
});
const api = new HttpInternalGeoApiClient({ sessions });
const governanceEndpoint = new URL(requiredEnvironment("PLASTIC_PROMISE_MCP_URL"));
const governanceAuthorization = process.env.PLASTIC_PROMISE_MCP_AUTHORIZATION?.trim();
const governance = await connectPlasticPromiseStreamableHttp({
  endpoint: governanceEndpoint.href,
  allowedOrigins: [governanceEndpoint.origin],
  ...(governanceAuthorization === undefined || governanceAuthorization.length === 0
    ? {}
    : { authorizationHeader: governanceAuthorization }),
});
const agentProvider = process.env.AGENT_PROVIDER ?? "fixture";
const agentModel = process.env.AGENT_MODEL ?? "fixture-geo-writer-v1";
let agentRunner: PiAgentRunService;
if (agentProvider === "fixture") {
  agentRunner = new FixturePiAgentRunService({ api, governance, model: agentModel });
} else {
  const knownProvider = getProviders().find((provider) => provider === agentProvider);
  if (knownProvider === undefined) throw new Error("AGENT_PROVIDER is not supported by Pi");
  const model = (getModels(knownProvider) as readonly Model<Api>[]).find(
    (candidate) => candidate.id === agentModel,
  );
  if (model === undefined) throw new Error("AGENT_MODEL is not available for AGENT_PROVIDER");
  agentRunner = new RealPiAgentRunService({
    api,
    governance,
    provider: knownProvider,
    model,
    modelId: agentModel,
    apiKey: requiredEnvironment("AGENT_API_KEY"),
  });
}
const automationConfig = readAutomationProducerConfig();
const automationProducer = new AutomationProducer(
  createGeoAutomationProducerDependencies({
    sessions,
    api,
    governance,
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
