import { loadServerEnv } from "@geo/config";
import { createDatabase } from "@geo/db";
import {
  ContentAddressedMediaStore,
  FixtureImageGenerationProvider,
  WikimediaCommonsImageSearchProvider,
} from "@geo/media";
import { createCustomerDemoGovernanceClient, PlasticPromisePublicationGate } from "@geo/agent";
import { connectPlasticPromiseStreamableHttp } from "@geo/agent/plastic-promise-transport";

import { buildApp } from "./app.js";
import { HttpAgentRunGateway, parseAgentGatewayCredentials } from "./agent-run-gateway.js";
import { HttpCtripBridgeGateway, parseCtripBridgeCredentials } from "./ctrip-bridge-gateway.js";
import { HttpMediaContentInspector } from "./media-inspection-gateway.js";
import { MediaProductionService } from "./media-production-service.js";
import { MediaImportService } from "./media-import-service.js";
import { MediaSearchImportService } from "./media-search-import-service.js";
import { createPostgresApiRepository } from "./postgres-repository.js";

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
        ...(env.PLASTIC_PROMISE_MCP_AUTHORIZATION === undefined
          ? {}
          : { authorizationHeader: env.PLASTIC_PROMISE_MCP_AUTHORIZATION }),
      });
const repository = createPostgresApiRepository({ runtimeDatabase, identityDatabase });
const mediaObjectStore = new ContentAddressedMediaStore(env.GEO_MEDIA_OBJECT_ROOT);
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
const mediaSearchImport =
  env.GEO_MEDIA_SEARCH_PROVIDER === "wikimedia_commons"
    ? new MediaSearchImportService({
        repository,
        provider: new WikimediaCommonsImageSearchProvider(),
        mediaImport,
      })
    : undefined;
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
  allowedOrigins: [env.APP_ORIGIN],
  logger: true,
  deploymentProfile: env.GEO_DEPLOYMENT_PROFILE,
  governanceMode: env.GEO_GOVERNANCE_MODE,
  publicationGovernanceGate: new PlasticPromisePublicationGate(plasticPromise),
  ...(agentRunGateway === undefined ? {} : { agentRunGateway }),
  ...(ctripBridgeGateway === undefined ? {} : { ctripBridgeGateway }),
  mediaObjectStore,
  ...(mediaProduction === undefined ? {} : { mediaProduction }),
  mediaImport,
  ...(mediaSearchImport === undefined ? {} : { mediaSearchImport }),
});

app.addHook("onClose", async () => {
  await plasticPromise.close();
  await runtimeDatabase.destroy();
  await identityDatabase.destroy();
});

await app.listen({ host: env.HOST, port: env.API_PORT });
