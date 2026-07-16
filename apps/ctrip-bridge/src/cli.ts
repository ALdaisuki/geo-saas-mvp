import { createDatabase } from "@geo/db";
import { ContentAddressedMediaStore } from "@geo/media";

import {
  CtripCommunityBrowserPreflightAdapter,
  CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION,
} from "./browser-preflight-adapter.js";
import {
  connectCtripBrowserReviewSession,
  type CtripBrowserReviewSession,
} from "./browser-review-session.js";
import {
  parseCtripBridgeTenantConfigs,
  requireBridgeHost,
  requireBrowserPreflightTenant,
  requireCtripBridgeMode,
} from "./config.js";
import { createCtripBridgeHttpServer, listenCtripBridgeHttpServer } from "./http-server.js";
import { PostgresCtripBridgeControlPlane } from "./postgres-control-plane.js";
import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import { CTRIP_SIMULATOR_ADAPTER_VERSION } from "./types.js";

async function main(): Promise<void> {
  const mode = requireCtripBridgeMode(process.env.CTRIP_BRIDGE_MODE ?? "");
  const databaseUrl = process.env.DATABASE_URL;
  const tenantJson = process.env.CTRIP_BRIDGE_TENANTS_JSON;
  const mediaObjectRoot = process.env.GEO_MEDIA_OBJECT_ROOT;
  if (databaseUrl === undefined || tenantJson === undefined || mediaObjectRoot === undefined) {
    throw new Error(
      "DATABASE_URL, CTRIP_BRIDGE_TENANTS_JSON and GEO_MEDIA_OBJECT_ROOT are required",
    );
  }
  const host = requireBridgeHost(process.env.CTRIP_BRIDGE_HOST ?? "127.0.0.1");
  const port = Number(process.env.CTRIP_BRIDGE_PORT ?? "9030");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CTRIP_BRIDGE_PORT must be a valid TCP port");
  }

  const tenantConfigs = parseCtripBridgeTenantConfigs(tenantJson);
  let browserSession: CtripBrowserReviewSession | null = null;
  let database: ReturnType<typeof createDatabase> | null = null;
  try {
    if (mode === "browser_preflight") {
      requireBrowserPreflightTenant(tenantConfigs);
      const httpEndpoint = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
      const runtimeTmpRoot = process.env.GEO_RUNTIME_TMP_ROOT;
      if (httpEndpoint === undefined || runtimeTmpRoot === undefined) {
        throw new Error(
          "CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required for browser preflight",
        );
      }
      browserSession = await connectCtripBrowserReviewSession({ httpEndpoint, runtimeTmpRoot });
    }

    const ownedDatabase = createDatabase({
      connectionString: databaseUrl,
      applicationName: `geo-ctrip-bridge-${mode.replace("_", "-")}`,
      maxConnections: 4,
    });
    database = ownedDatabase;
    const controlPlane = new PostgresCtripBridgeControlPlane(ownedDatabase);
    const mediaObjectStore = new ContentAddressedMediaStore(mediaObjectRoot);
    const adapterVersion =
      mode === "simulator"
        ? CTRIP_SIMULATOR_ADAPTER_VERSION
        : CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION;
    const tenants = tenantConfigs.map((config) => {
      const simulator = mode === "simulator" ? new CtripCommunitySimulator() : null;
      const adapter =
        simulator ??
        new CtripCommunityBrowserPreflightAdapter({
          inspect: () => {
            if (browserSession === null) {
              throw new Error("Ctrip browser review session is unavailable");
            }
            return browserSession.inspect();
          },
        });
      return {
        ...config,
        simulator,
        service: new CtripBridgeCommandService({
          tenantId: config.tenantId,
          bridgePrincipalId: config.bridgePrincipalId,
          controlPlane,
          mediaObjectStore,
          adapter,
        }),
      };
    });
    const server = createCtripBridgeHttpServer({
      tenants,
      allowedHosts: [`${host}:${port}`],
      mode,
      adapterVersion,
    });
    server.once("close", () => {
      void Promise.allSettled([ownedDatabase.destroy(), browserSession?.close()]);
    });
    await listenCtripBridgeHttpServer(server, { host, port });
  } catch (error) {
    await Promise.allSettled([database?.destroy(), browserSession?.close()]);
    throw error;
  }
}

await main();
