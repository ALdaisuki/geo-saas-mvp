import { createDatabase } from "@geo/db";
import { ContentAddressedMediaStore } from "@geo/media";

import { parseCtripBridgeTenantConfigs, requireSimulatorHost } from "./config.js";
import { createCtripBridgeHttpServer, listenCtripBridgeHttpServer } from "./http-server.js";
import { PostgresCtripBridgeControlPlane } from "./postgres-control-plane.js";
import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";

if (process.env.CTRIP_BRIDGE_MODE !== "simulator") {
  throw new Error("CTRIP_BRIDGE_MODE must be explicitly set to simulator");
}
const databaseUrl = process.env.DATABASE_URL;
const tenantJson = process.env.CTRIP_BRIDGE_TENANTS_JSON;
const mediaObjectRoot = process.env.GEO_MEDIA_OBJECT_ROOT;
if (databaseUrl === undefined || tenantJson === undefined || mediaObjectRoot === undefined) {
  throw new Error("DATABASE_URL, CTRIP_BRIDGE_TENANTS_JSON and GEO_MEDIA_OBJECT_ROOT are required");
}
const host = requireSimulatorHost(process.env.CTRIP_BRIDGE_HOST ?? "127.0.0.1");
const port = Number(process.env.CTRIP_BRIDGE_PORT ?? "9030");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CTRIP_BRIDGE_PORT must be a valid TCP port");
}

const database = createDatabase({
  connectionString: databaseUrl,
  applicationName: "geo-ctrip-bridge-simulator",
  maxConnections: 4,
});
const controlPlane = new PostgresCtripBridgeControlPlane(database);
const mediaObjectStore = new ContentAddressedMediaStore(mediaObjectRoot);
const tenants = parseCtripBridgeTenantConfigs(tenantJson).map((config) => {
  const simulator = new CtripCommunitySimulator();
  return {
    ...config,
    simulator,
    service: new CtripBridgeCommandService({
      tenantId: config.tenantId,
      bridgePrincipalId: config.bridgePrincipalId,
      controlPlane,
      mediaObjectStore,
      adapter: simulator,
    }),
  };
});
const server = createCtripBridgeHttpServer({
  tenants,
  allowedHosts: [`${host}:${port}`],
});
server.once("close", () => {
  void database.destroy();
});
await listenCtripBridgeHttpServer(server, { host, port });
