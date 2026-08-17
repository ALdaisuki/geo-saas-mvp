import { loadServerEnv } from "@geo/config";
import { createDatabase } from "@geo/db";
import { PublicTrendCollector } from "@geo/research";
import { ContentAddressedMediaStore, FixtureImageGenerationProvider } from "@geo/media";
import { createCustomerDemoGovernanceClient, PlasticPromisePublicationGate } from "@geo/agent";
import { connectPlasticPromiseStreamableHttp } from "@geo/agent/plastic-promise-transport";

import { buildApp } from "./app.js";
import { HttpAgentRunGateway, parseAgentGatewayCredentials } from "./agent-run-gateway.js";
import { RuntimeCustomerPromptTemplateGenerator } from "./campaign-prompt-template.js";
import { HttpCtripBridgeGateway, parseCtripBridgeCredentials } from "./ctrip-bridge-gateway.js";
import { HttpMediaContentInspector } from "./media-inspection-gateway.js";
import { MediaProductionService } from "./media-production-service.js";
import { MediaImportService } from "./media-import-service.js";
import { MediaSearchImportService } from "./media-search-import-service.js";
import { InMemoryOperationsEventBus } from "./operations-event-stream.js";
import { createPostgresApiRepository } from "./postgres-repository.js";
import { createPostgresTrendRepository } from "./postgres-trend-repository.js";
import { RuntimeConfiguredMediaSearchProvider } from "./runtime-media-search-provider.js";
import { PostgresRuntimeProviderConfigurationStore } from "./runtime-provider-config.js";
import { TrendAutomationLoop, parseTrendAutomationPipelines } from "./trend-automation-loop.js";
import { TrendCollectionLoop, parseTrendCollectionTenantActors } from "./trend-collection-loop.js";
import { TrendService } from "./trend-service.js";
import { AutomationPlanScheduler } from "./automation-plan-scheduler.js";

const env = loadServerEnv();
if (env.GEO_GOVERNANCE_MODE === "external" && env.PLASTIC_PROMISE_MCP_URL === undefined) {
  throw new Error("PLASTIC_PROMISE_MCP_URL is required for publication governance");
}
if (env.DATABASE_IDENTITY_URL === undefined) {
  throw new Error("DATABASE_IDENTITY_URL is required for the least-privilege login lookup");
}
const runtimeDatabase = createDatabase({
  connectionString: env.DATABASE_URL,
  applicationName: "geo-api-runtime",
});
const identityDatabase = createDatabase({
  connectionString: env.DATABASE_IDENTITY_URL,
  applicationName: "geo-api-identity",
  maxConnections: 2,
});
const plasticPromise =
  env.GEO_GOVERNANCE_MODE === "demo_fixture"
    ? createCustomerDemoGovernanceClient()
    : await connectPlasticPromiseStreamableHttp({
        endpoint: env.PLASTIC_PROMISE_MCP_URL as string,
        allowedOrigins: [new URL(env.PLASTIC_PROMISE_MCP_URL as string).origin],
        allowDockerHost: env.GEO_DEPLOYMENT_PROFILE === "customer_demo",
        allowServerDockerGateway:
          env.NODE_ENV === "production" && env.GEO_DEPLOYMENT_PROFILE === "standard",
        ...(env.PLASTIC_PROMISE_MCP_AUTHORIZATION === undefined
          ? {}
          : { authorizationHeader: env.PLASTIC_PROMISE_MCP_AUTHORIZATION }),
      });
const repository = createPostgresApiRepository({ runtimeDatabase, identityDatabase });
const trendController = new TrendService({
  repository: createPostgresTrendRepository(runtimeDatabase),
});
const operationsEventBus = new InMemoryOperationsEventBus();
const trendCollectionTenantActors =
  env.TREND_COLLECTION_TENANT_ACTORS_JSON === undefined
    ? {}
    : parseTrendCollectionTenantActors(env.TREND_COLLECTION_TENANT_ACTORS_JSON);
const trendCollectionLoop = new TrendCollectionLoop({
  collector: new PublicTrendCollector({
    limitPerSource: env.TREND_COLLECTION_LIMIT_PER_SOURCE,
  }),
  trendController,
  tenantActors: trendCollectionTenantActors,
  validateActor: async (tenantId, actorId) => {
    const principals = await repository.listServicePrincipals({
      tenantId,
      actorId,
      requestId: `trend-collection:validate-actor:${actorId}`,
    });
    return principals.some(
      (principal) =>
        principal.tenantId === tenantId &&
        principal.id === actorId &&
        principal.profile === "automation_producer" &&
        principal.status === "active" &&
        principal.capabilities.includes("automation:execute") &&
        principal.capabilities.includes("content:read"),
    );
  },
  enabled: env.TREND_COLLECTION_ENABLED,
  intervalMs: env.TREND_COLLECTION_INTERVAL_MS,
  operationsEventBus,
  onRun: (summary) => {
    console.info(
      JSON.stringify({
        level: "info",
        event: "geo_api.trend_collection_completed",
        runId: summary.runId,
        sourceSuccesses: summary.sources.filter((item) => item.status === "fulfilled").length,
        sourceFailures: summary.sources.filter((item) => item.status === "rejected").length,
        ingestSuccesses: summary.ingests.filter((item) => item.status === "fulfilled").length,
        ingestFailures: summary.ingests.filter((item) => item.status === "rejected").length,
        completedAt: summary.completedAt,
      }),
    );
  },
  onError: (errorCode) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "geo_api.trend_collection_failed",
        errorCode,
      }),
    );
  },
});
const trendAutomationPipelines =
  env.TREND_AUTOMATION_PIPELINES_JSON === undefined
    ? []
    : parseTrendAutomationPipelines(env.TREND_AUTOMATION_PIPELINES_JSON);
const trendAutomationLoop = new TrendAutomationLoop({
  repository,
  trendController,
  pipelines: trendAutomationPipelines,
  validateActor: async (tenantId, actorId) => {
    const principals = await repository.listServicePrincipals({
      tenantId,
      actorId,
      requestId: `trend-automation:validate-actor:${actorId}`,
    });
    return principals.some(
      (principal) =>
        principal.tenantId === tenantId &&
        principal.id === actorId &&
        principal.profile === "automation_producer" &&
        principal.status === "active" &&
        principal.capabilities.includes("automation:execute") &&
        principal.capabilities.includes("content:read"),
    );
  },
  enabled: env.TREND_AUTOMATION_ENABLED,
  intervalMs: env.TREND_AUTOMATION_INTERVAL_MS,
  operationsEventBus,
  onRun: (summary) => {
    console.info(
      JSON.stringify({
        level: "info",
        event: "geo_api.trend_automation_completed",
        runId: summary.runId,
        pipelineSuccesses: summary.pipelines.filter((item) => item.status === "fulfilled").length,
        pipelinePartials: summary.pipelines.filter((item) => item.status === "partial").length,
        pipelineFailures: summary.pipelines.filter((item) => item.status === "rejected").length,
        createdBatches: summary.pipelines.reduce(
          (total, item) => total + item.createdBatchCount,
          0,
        ),
        replayedBatches: summary.pipelines.reduce(
          (total, item) => total + item.replayedBatchCount,
          0,
        ),
        failedCandidates: summary.pipelines.reduce(
          (total, item) => total + item.failedCandidateCount,
          0,
        ),
        errorCodes: [...new Set(summary.pipelines.flatMap((item) => item.errorCodes))].sort(),
        completedAt: summary.completedAt,
      }),
    );
  },
  onError: (errorCode) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "geo_api.trend_automation_failed",
        errorCode,
      }),
    );
  },
});
const automationPlanScheduler = new AutomationPlanScheduler({
  repository,
  validateActor: async (tenantId, actorId) => {
    const principals = await repository.listServicePrincipals({
      tenantId,
      actorId,
      requestId: `automation-plan:validate-actor:${actorId}`,
    });
    return principals.some(
      (principal) =>
        principal.tenantId === tenantId &&
        principal.id === actorId &&
        principal.profile === "automation_producer" &&
        principal.status === "active" &&
        principal.capabilities.includes("automation:execute") &&
        principal.capabilities.includes("content:read"),
    );
  },
  enabled: env.AUTOMATION_PLAN_ENABLED,
  intervalMs: env.AUTOMATION_PLAN_INTERVAL_MS,
  maxPlansPerRun: env.AUTOMATION_PLAN_MAX_PLANS_PER_RUN,
  operationsEventBus,
  onRun: (summary) => {
    console.info(
      JSON.stringify({
        level: "info",
        event: "geo_api.automation_plan_completed",
        runId: summary.runId,
        duePlans: summary.duePlanCount,
        createdBatches: summary.createdBatchCount,
        failedPlans: summary.failedPlanCount,
        errorCodes: summary.errorCodes,
        completedAt: summary.completedAt,
      }),
    );
  },
  onError: (errorCode) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "geo_api.automation_plan_failed",
        errorCode,
      }),
    );
  },
});
const mediaObjectStore = new ContentAddressedMediaStore(env.GEO_MEDIA_OBJECT_ROOT);
const runtimeProviderConfiguration = new PostgresRuntimeProviderConfigurationStore(runtimeDatabase);
const mediaProduction =
  env.GEO_MEDIA_PROVIDER === "fixture"
    ? new MediaProductionService({
        repository,
        provider: new FixtureImageGenerationProvider(),
        objectStore: mediaObjectStore,
      })
    : undefined;
const agentGatewayCredentials =
  env.AGENT_GATEWAY_URL === undefined || env.AGENT_GATEWAY_CREDENTIALS_JSON === undefined
    ? undefined
    : parseAgentGatewayCredentials(env.AGENT_GATEWAY_CREDENTIALS_JSON);
const agentRunGateway =
  env.AGENT_GATEWAY_URL === undefined || agentGatewayCredentials === undefined
    ? undefined
    : new HttpAgentRunGateway({
        baseUrl: env.AGENT_GATEWAY_URL,
        credentials: agentGatewayCredentials,
        runTimeoutMs: env.AGENT_GATEWAY_RUN_TIMEOUT_MS,
      });
const mediaContentInspector =
  env.AGENT_GATEWAY_URL === undefined || agentGatewayCredentials === undefined
    ? undefined
    : new HttpMediaContentInspector({
        baseUrl: env.AGENT_GATEWAY_URL,
        credentials: agentGatewayCredentials,
      });
const mediaImport = new MediaImportService({
  repository,
  objectStore: mediaObjectStore,
  ...(mediaContentInspector === undefined ? {} : { contentInspector: mediaContentInspector }),
  reportFailure: (failure) => {
    console.error(
      JSON.stringify({ level: "error", event: "geo_api.media_import_failed", ...failure }),
    );
  },
});
const pexelsApiKey = env.PEXELS_API_KEY;
const mediaSearchProvider =
  env.GEO_MEDIA_SEARCH_PROVIDER === "disabled"
    ? undefined
    : new RuntimeConfiguredMediaSearchProvider({
        store: runtimeProviderConfiguration,
        fallback: {
          provider: env.GEO_MEDIA_SEARCH_PROVIDER === "pexels" ? "pexels" : "wikimedia_commons",
          ...(pexelsApiKey === undefined ? {} : { apiKey: pexelsApiKey }),
          ...(env.GEO_MEDIA_HTTPS_PROXY_URL === undefined
            ? {}
            : { proxyUrl: env.GEO_MEDIA_HTTPS_PROXY_URL }),
        },
      });
const mediaSearchImport =
  mediaSearchProvider === undefined
    ? undefined
    : new MediaSearchImportService({
        repository,
        provider: mediaSearchProvider,
        mediaImport,
        objectStore: mediaObjectStore,
      });
const ctripBridgeGateway =
  env.CTRIP_BRIDGE_GATEWAY_URL === undefined ||
  env.CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON === undefined
    ? undefined
    : new HttpCtripBridgeGateway({
        baseUrl: env.CTRIP_BRIDGE_GATEWAY_URL,
        credentials: parseCtripBridgeCredentials(env.CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON),
      });

const app = await buildApp({
  repository,
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.NODE_ENV === "production" && env.GEO_DEPLOYMENT_PROFILE !== "customer_demo",
  allowedOrigins: [
    env.APP_ORIGIN,
    ...(env.GEO_OPERATOR_ORIGIN === undefined ? [] : [env.GEO_OPERATOR_ORIGIN]),
  ],
  logger: true,
  deploymentProfile: env.GEO_DEPLOYMENT_PROFILE,
  governanceMode: env.GEO_GOVERNANCE_MODE,
  publicationGovernanceGate: new PlasticPromisePublicationGate(plasticPromise),
  ...(agentRunGateway === undefined ? {} : { agentRunGateway }),
  ...(ctripBridgeGateway === undefined ? {} : { ctripBridgeGateway }),
  mediaObjectStore,
  ...(mediaProduction === undefined ? {} : { mediaProduction }),
  mediaImport,
  trendController,
  operationsEventBus,
  runtimeProviderConfiguration,
  promptTemplateGenerator: new RuntimeCustomerPromptTemplateGenerator(runtimeProviderConfiguration),
  ...(mediaSearchImport === undefined ? {} : { mediaSearchImport }),
});

app.addHook("onClose", async () => {
  await trendCollectionLoop.stop();
  await trendAutomationLoop.stop();
  await automationPlanScheduler.stop();
  await mediaSearchProvider?.close();
  await plasticPromise.close();
  await runtimeDatabase.destroy();
  await identityDatabase.destroy();
});

await app.listen({ host: env.HOST, port: env.API_PORT });
const trendCollectionLifecycle = trendCollectionLoop.start();
void trendCollectionLifecycle.catch(() => {
  console.error(
    JSON.stringify({ level: "error", event: "geo_api.trend_collection_lifecycle_failed" }),
  );
});
const trendAutomationLifecycle = trendAutomationLoop.start();
void trendAutomationLifecycle.catch(() => {
  console.error(
    JSON.stringify({ level: "error", event: "geo_api.trend_automation_lifecycle_failed" }),
  );
});
const automationPlanLifecycle = automationPlanScheduler.start();
void automationPlanLifecycle.catch(() => {
  console.error(
    JSON.stringify({ level: "error", event: "geo_api.automation_plan_lifecycle_failed" }),
  );
});
