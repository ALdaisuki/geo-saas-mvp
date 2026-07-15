import { loadServerEnv } from "@geo/config";
import { createDatabase } from "@geo/db";
import { ContentAddressedMediaStore, FixtureImageGenerationProvider } from "@geo/media";
import { PlasticPromisePublicationGate } from "@geo/agent";
import { connectPlasticPromiseStreamableHttp } from "@geo/agent/plastic-promise-transport";

import { buildApp } from "./app.js";
import { MediaProductionService } from "./media-production-service.js";
import { createPostgresApiRepository } from "./postgres-repository.js";

const env = loadServerEnv();
if (env.PLASTIC_PROMISE_MCP_URL === undefined) {
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
const plasticPromiseEndpoint = new URL(env.PLASTIC_PROMISE_MCP_URL);
const plasticPromise = await connectPlasticPromiseStreamableHttp({
  endpoint: plasticPromiseEndpoint.href,
  allowedOrigins: [plasticPromiseEndpoint.origin],
  ...(env.PLASTIC_PROMISE_MCP_AUTHORIZATION === undefined
    ? {}
    : { authorizationHeader: env.PLASTIC_PROMISE_MCP_AUTHORIZATION }),
});
const repository = createPostgresApiRepository({ runtimeDatabase, identityDatabase });
const mediaProduction =
  env.GEO_MEDIA_PROVIDER === "fixture"
    ? new MediaProductionService({
        repository,
        provider: new FixtureImageGenerationProvider(),
        objectStore: new ContentAddressedMediaStore(env.GEO_MEDIA_OBJECT_ROOT),
      })
    : undefined;

const app = await buildApp({
  repository,
  sessionSecret: env.SESSION_SECRET,
  cookieSecure: env.NODE_ENV === "production",
  allowedOrigins: [env.APP_ORIGIN],
  logger: true,
  publicationGovernanceGate: new PlasticPromisePublicationGate(plasticPromise),
  ...(mediaProduction === undefined ? {} : { mediaProduction }),
});

app.addHook("onClose", async () => {
  await plasticPromise.close();
  await runtimeDatabase.destroy();
  await identityDatabase.destroy();
});

await app.listen({ host: env.HOST, port: env.API_PORT });
