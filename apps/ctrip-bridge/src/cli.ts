import { createDatabase } from "@geo/db";
import { ContentAddressedMediaStore } from "@geo/media";

import {
  CtripCommunityBrowserPreflightAdapter,
  CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION,
} from "./browser-preflight-adapter.js";
import {
  CtripCommunityBrowserDraftAdapter,
  CTRIP_BROWSER_DRAFT_ADAPTER_VERSION,
} from "./browser-draft-adapter.js";
import {
  CtripCommunityBrowserSupervisedAdapter,
  CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION,
} from "./browser-supervised-adapter.js";
import {
  CtripCommunityBrowserUnattendedAdapter,
  CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION,
} from "./browser-unattended-adapter.js";
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
import {
  startCtripPreparationPoller,
  type CtripPreparationPoller,
} from "./preparation-poller.js";
import { CtripBridgeCommandService, CtripBridgeServiceError } from "./service.js";
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
  // 9030 is the container/shared-namespace port. The host-facing mapping is 10000+ in Compose.
  const port = Number(process.env.CTRIP_BRIDGE_PORT ?? "9030");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CTRIP_BRIDGE_PORT must be a valid TCP port");
  }

  const tenantConfigs = parseCtripBridgeTenantConfigs(tenantJson);
  let browserSession: CtripBrowserReviewSession | null = null;
  let database: ReturnType<typeof createDatabase> | null = null;
  let preparationPoller: CtripPreparationPoller | null = null;
  try {
    if (
      mode === "browser_preflight" ||
      mode === "browser_draft" ||
      mode === "browser_supervised" ||
      mode === "browser_unattended"
    ) {
      requireBrowserPreflightTenant(tenantConfigs);
      const httpEndpoint = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
      const runtimeTmpRoot = process.env.GEO_RUNTIME_TMP_ROOT;
      if (httpEndpoint === undefined || runtimeTmpRoot === undefined) {
        throw new Error(
          "CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required for browser modes",
        );
      }
      browserSession = await connectCtripBrowserReviewSession({
        httpEndpoint,
        runtimeTmpRoot,
        transport:
          mode === "browser_draft" ||
          mode === "browser_supervised" ||
          mode === "browser_unattended"
            ? "docker_desktop"
            : "local",
      });
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
        : mode === "browser_supervised"
          ? CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION
          : mode === "browser_unattended"
            ? CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION
          : mode === "browser_draft"
            ? CTRIP_BROWSER_DRAFT_ADAPTER_VERSION
            : CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION;
    const commandCapabilities = Object.freeze(
      mode === "simulator"
        ? { prepare: true, submit: true, readback: true }
        : mode === "browser_supervised"
          ? { prepare: true, submit: true, readback: false }
          : mode === "browser_unattended"
            ? { prepare: true, submit: true, readback: true }
          : { prepare: true, submit: false, readback: false },
    );
    const tenants = tenantConfigs.map((config) => {
      const simulator = mode === "simulator" ? new CtripCommunitySimulator() : null;
      const adapter = simulator ??
        (mode === "browser_supervised"
          ? new CtripCommunityBrowserSupervisedAdapter({
              draftWriter: (() => {
                if (browserSession === null) {
                  throw new Error("Ctrip browser draft session is unavailable");
                }
                return browserSession.draftWriter;
              })(),
              submitWriter: (() => {
                if (browserSession === null) {
                  throw new Error("Ctrip supervised submit session is unavailable");
                }
                return browserSession.supervisedSubmitWriter;
              })(),
            })
          : mode === "browser_unattended"
            ? new CtripCommunityBrowserUnattendedAdapter({
                draftWriter: (() => {
                  if (browserSession === null) {
                    throw new Error("Ctrip unattended browser draft session is unavailable");
                  }
                  return browserSession.draftWriter;
                })(),
                submitWriter: (() => {
                  if (browserSession === null) {
                    throw new Error("Ctrip unattended submit session is unavailable");
                  }
                  return browserSession.supervisedSubmitWriter;
                })(),
                readbackWriter: (() => {
                  if (browserSession === null) {
                    throw new Error("Ctrip unattended public readback session is unavailable");
                  }
                  return browserSession.publicReadbackWriter;
                })(),
              })
            : mode === "browser_draft"
              ? new CtripCommunityBrowserDraftAdapter({
                  writer: (() => {
                    if (browserSession === null) {
                      throw new Error("Ctrip browser draft session is unavailable");
                    }
                    return browserSession.draftWriter;
                  })(),
                })
              : new CtripCommunityBrowserPreflightAdapter({
                  inspect: () => {
                    if (browserSession === null) {
                      throw new Error("Ctrip browser review session is unavailable");
                    }
                    return browserSession.inspect();
                  },
                }));
      return {
        ...config,
        simulator,
        readiness: browserSession === null ? null : browserSession.readiness,
        service: new CtripBridgeCommandService({
          tenantId: config.tenantId,
          bridgePrincipalId: config.bridgePrincipalId,
          controlPlane,
          mediaObjectStore,
          adapter,
          executionLevel: mode === "browser_unattended" ? "unattended" : "assisted",
        }),
      };
    });
    const server = createCtripBridgeHttpServer({
      tenants,
      // The API gateway calls the bridge through the shared container namespace
      // using loopback even when the bridge binds to 0.0.0.0.
      allowedHosts: [...new Set([
        `${host}:${port}`,
        `127.0.0.1:${port}`,
        `localhost:${port}`,
      ])],
      mode,
      adapterVersion,
      commandCapabilities,
    });
    if (
      mode === "browser_draft" ||
      mode === "browser_supervised" ||
      mode === "browser_unattended"
    ) {
      preparationPoller = startCtripPreparationPoller({
        services: tenants.map((tenant) => tenant.service),
        onError: (error) => {
          const code = error instanceof CtripBridgeServiceError ? error.code : "UNEXPECTED";
          const message = error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : null;
          console.error(
            JSON.stringify({
              event: "ctrip_draft_prepare_failed",
              code,
              errorType: error instanceof Error ? error.name : typeof error,
              ...(message === null ? {} : { message }),
            }),
          );
        },
      });
    }
    server.once("close", () => {
      void Promise.allSettled([
        preparationPoller?.stop(),
        ownedDatabase.destroy(),
        browserSession?.close(),
      ]);
    });
    await listenCtripBridgeHttpServer(server, { host, port });
  } catch (error) {
    await Promise.allSettled([
      preparationPoller?.stop(),
      database?.destroy(),
      browserSession?.close(),
    ]);
    throw error;
  }
}

await main();
