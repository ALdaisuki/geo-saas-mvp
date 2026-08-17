import { randomUUID } from "node:crypto";

import { createDatabase } from "@geo/db";
import { ContentAddressedMediaStore } from "@geo/media";

import {
  DEFAULT_BROWSER_OPERATION_TIMEOUT_MS,
  DEFAULT_BROWSER_SESSION_CAPACITY,
  DefaultCtripAccountBrowserSessionProvider,
  MAX_BROWSER_SESSION_CAPACITY,
} from "./account-browser-session-provider.js";
import {
  DefaultCtripAccountBrowserReclaimService,
  startCtripAccountBrowserReclaimPoller,
  type CtripAccountBrowserReclaimPoller,
} from "./account-browser-lifecycle.js";
import {
  DefaultCtripAccountAnalyticsRefreshService,
  startCtripAccountAnalyticsPoller,
  type CtripAccountAnalyticsPoller,
} from "./account-analytics-sync.js";
import { DefaultPriorityPlatformAccountAnalyticsRefreshService } from "./priority-platform-account-analytics-sync.js";
import {
  DefaultCtripAccountRuntimeStatusRefreshService,
  startCtripAccountRuntimeStatusPoller,
  type CtripAccountRuntimeStatusPoller,
} from "./account-runtime-status-sync.js";
import { CtripAccountScopedAdapter } from "./account-scoped-adapter.js";
import { assertCtripBridgeModeReady } from "./authenticated-surface-review.js";
import {
  DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT,
  DefaultBrowserHostAdmissionGate,
  type BrowserHostAdmissionGate,
} from "./browser-host-admission-gate.js";
import { CTRIP_BROWSER_PREFLIGHT_ADAPTER_VERSION } from "./browser-preflight-adapter.js";
import { CTRIP_BROWSER_DRAFT_ADAPTER_VERSION } from "./browser-draft-adapter.js";
import { CTRIP_BROWSER_SUPERVISED_ADAPTER_VERSION } from "./browser-supervised-adapter.js";
import { CTRIP_BROWSER_UNATTENDED_ADAPTER_VERSION } from "./browser-unattended-adapter.js";
import {
  ctripBridgeAllowedHosts,
  parseCtripBridgeTenantConfigs,
  requireBridgeHost,
  requireCtripBrowserTenantId,
  requireBrowserPreflightTenant,
  requireCtripBridgeMode,
  resolveCtripBrowserTransport,
  type CtripBrowserTransport,
} from "./config.js";
import { createCtripBridgeHttpServer, listenCtripBridgeHttpServer } from "./http-server.js";
import { PostgresCtripBridgeControlPlane } from "./postgres-control-plane.js";
import { startCtripPreparationPoller, type CtripPreparationPoller } from "./preparation-poller.js";
import { CtripBridgeCommandService, CtripBridgeServiceError } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import { CTRIP_SIMULATOR_ADAPTER_VERSION } from "./types.js";

async function main(): Promise<void> {
  const mode = requireCtripBridgeMode(process.env.CTRIP_BRIDGE_MODE ?? "");
  assertCtripBridgeModeReady(mode);
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
  let browserConfig: {
    readonly transport: CtripBrowserTransport;
    readonly httpEndpoint: string;
    readonly runtimeTmpRoot: string;
    readonly maxConcurrentSessions: number;
    readonly operationTimeoutMs: number;
    readonly accountConcurrency: number;
    readonly cpuPausePercent: number;
  } | null = null;
  let database: ReturnType<typeof createDatabase> | null = null;
  let preparationPoller: CtripPreparationPoller | null = null;
  let analyticsPoller: CtripAccountAnalyticsPoller | null = null;
  let runtimeStatusPoller: CtripAccountRuntimeStatusPoller | null = null;
  let browserReclaimPoller: CtripAccountBrowserReclaimPoller | null = null;
  try {
    if (
      mode === "browser_preflight" ||
      mode === "browser_draft" ||
      mode === "browser_supervised" ||
      mode === "browser_unattended"
    ) {
      requireBrowserPreflightTenant(tenantConfigs);
      const transport = resolveCtripBrowserTransport(mode, process.env.CTRIP_BROWSER_TRANSPORT);
      const browserTenantId = process.env.CTRIP_BROWSER_TENANT_ID;
      if (browserTenantId !== undefined) {
        requireCtripBrowserTenantId(browserTenantId, tenantConfigs);
      } else if (transport === "linux_service") {
        throw new Error("CTRIP_BROWSER_TENANT_ID is required for the Linux browser service");
      }
      const httpEndpoint = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
      const runtimeTmpRoot = process.env.GEO_RUNTIME_TMP_ROOT;
      if (httpEndpoint === undefined || runtimeTmpRoot === undefined) {
        throw new Error(
          "CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required for browser modes",
        );
      }
      const maxConcurrentSessions = Number(
        process.env.CTRIP_BROWSER_MAX_ACTIVE_SESSIONS ?? DEFAULT_BROWSER_SESSION_CAPACITY,
      );
      if (
        !Number.isSafeInteger(maxConcurrentSessions) ||
        maxConcurrentSessions < 1 ||
        maxConcurrentSessions > MAX_BROWSER_SESSION_CAPACITY
      ) {
        throw new Error(
          `CTRIP_BROWSER_MAX_ACTIVE_SESSIONS must be from 1 through ${MAX_BROWSER_SESSION_CAPACITY}`,
        );
      }
      const operationTimeoutMs = Number(
        process.env.CTRIP_BROWSER_OPERATION_TIMEOUT_MS ?? DEFAULT_BROWSER_OPERATION_TIMEOUT_MS,
      );
      if (
        !Number.isSafeInteger(operationTimeoutMs) ||
        operationTimeoutMs < 30_000 ||
        operationTimeoutMs > 1_800_000
      ) {
        throw new Error("CTRIP_BROWSER_OPERATION_TIMEOUT_MS must be from 30000 through 1800000");
      }
      const accountConcurrency = Number(
        process.env.CTRIP_BRIDGE_ACCOUNT_CONCURRENCY_CAP ??
          process.env.CTRIP_BRIDGE_ACCOUNT_CONCURRENCY ??
          8,
      );
      if (
        !Number.isSafeInteger(accountConcurrency) ||
        accountConcurrency < 1 ||
        accountConcurrency > 8
      ) {
        throw new Error("CTRIP_BRIDGE_ACCOUNT_CONCURRENCY_CAP must be from 1 through 8");
      }
      const cpuPausePercent = Number(
        process.env.CTRIP_BROWSER_CPU_PAUSE_PERCENT ?? DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT,
      );
      if (!Number.isFinite(cpuPausePercent) || cpuPausePercent < 1 || cpuPausePercent > 1_000) {
        throw new Error("CTRIP_BROWSER_CPU_PAUSE_PERCENT must be from 1 through 1000");
      }
      browserConfig = {
        httpEndpoint,
        runtimeTmpRoot,
        transport,
        maxConcurrentSessions,
        operationTimeoutMs,
        accountConcurrency,
        cpuPausePercent,
      };
    }

    const ownedDatabase = createDatabase({
      connectionString: databaseUrl,
      applicationName: `geo-ctrip-bridge-${mode.replace("_", "-")}`,
      maxConnections: Math.max(4, (browserConfig?.accountConcurrency ?? 1) + 3),
    });
    database = ownedDatabase;
    const controlPlane = new PostgresCtripBridgeControlPlane(ownedDatabase);
    const mediaObjectStore = new ContentAddressedMediaStore(mediaObjectRoot);
    const browserAdmissionGate: BrowserHostAdmissionGate | undefined =
      browserConfig?.transport === "linux_service"
        ? new DefaultBrowserHostAdmissionGate({
            httpEndpoint: browserConfig.httpEndpoint,
            maxActiveSessions: browserConfig.maxConcurrentSessions,
            cpuPausePercent: browserConfig.cpuPausePercent,
          })
        : undefined;
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
          ? { prepare: true, submit: true, readback: true }
          : mode === "browser_unattended"
            ? { prepare: true, submit: true, readback: true }
            : { prepare: true, submit: false, readback: false },
    );
    const tenants = tenantConfigs.map((config) => {
      const simulator = mode === "simulator" ? new CtripCommunitySimulator() : null;
      const sessions =
        browserConfig === null
          ? null
          : new DefaultCtripAccountBrowserSessionProvider({
              ...browserConfig,
              loadBinding: (channelAccountId) =>
                controlPlane.loadAccountRuntimeBinding(
                  {
                    tenantId: config.tenantId,
                    bridgePrincipalId: config.bridgePrincipalId,
                    requestId: `ctrip-browser-binding:${randomUUID()}`,
                  },
                  channelAccountId,
                ),
            });
      const adapter =
        simulator ??
        (sessions === null || mode === "simulator"
          ? (() => {
              throw new Error("Ctrip account browser session provider is unavailable");
            })()
          : new CtripAccountScopedAdapter({ mode, sessions }));
      const browserReclaimService =
        sessions === null
          ? null
          : new DefaultCtripAccountBrowserReclaimService({
              tenantId: config.tenantId,
              bridgePrincipalId: config.bridgePrincipalId,
              controlPlane,
              sessions,
              onError: (error) => {
                console.error(
                  JSON.stringify({
                    event: "ctrip_account_browser_reclaim_failed",
                    errorType: error instanceof Error ? error.name : typeof error,
                    message:
                      error instanceof Error
                        ? error.message.replace(/\s+/gu, " ").slice(0, 240)
                        : null,
                  }),
                );
              },
            });
      const service = new CtripBridgeCommandService({
        tenantId: config.tenantId,
        bridgePrincipalId: config.bridgePrincipalId,
        controlPlane,
        mediaObjectStore,
        adapter,
        executionLevel: mode === "browser_unattended" ? "unattended" : "assisted",
        preparationExecutionLevel: mode === "browser_unattended" ? "all" : "assisted",
        ...(sessions === null
          ? {}
          : {
              onHandoffReclaimable: async ({ handoffId, channelAccountId }) => {
                await browserReclaimService?.reclaimAccount(
                  channelAccountId,
                  `ctrip-browser-reclaim-boundary:${handoffId}`,
                );
              },
            }),
      });
      return {
        ...config,
        simulator,
        readiness:
          sessions === null
            ? null
            : (channelAccountId: string) =>
                sessions.withSession(channelAccountId, (session) => session.readiness()),
        navigateToLogin:
          sessions === null
            ? null
            : async (channelAccountId: string) => {
                const navigation = await sessions.withSession(channelAccountId, (session) =>
                  session.navigateToLogin(channelAccountId),
                );
                return {
                  schemaVersion: "geo.ctrip-browser-login-navigation.result.v1" as const,
                  tenantId: config.tenantId,
                  channelAccountId: navigation.channelAccountId,
                  targetUrl: navigation.targetUrl,
                  currentUrl: navigation.currentUrl,
                };
              },
        service,
        analyticsService:
          sessions === null
            ? null
            : new DefaultCtripAccountAnalyticsRefreshService({
                tenantId: config.tenantId,
                bridgePrincipalId: config.bridgePrincipalId,
                controlPlane,
                sessions,
                deliveryPending: async () => (await service.activeDeliveryAccountCount()) > 0,
                onRuntimeCleanupError: (channelAccountId, error) => {
                  console.error(
                    JSON.stringify({
                      event: "ctrip_account_analytics_runtime_cleanup_failed",
                      channelAccountId,
                      errorType: error instanceof Error ? error.name : typeof error,
                      message:
                        error instanceof Error
                          ? error.message.replace(/\s+/gu, " ").slice(0, 240)
                          : null,
                    }),
                  );
                },
              }),
        priorityAnalyticsService:
          sessions === null
            ? null
            : new DefaultPriorityPlatformAccountAnalyticsRefreshService({
                tenantId: config.tenantId,
                bridgePrincipalId: config.bridgePrincipalId,
                controlPlane,
                sessions,
                ...(browserAdmissionGate === undefined
                  ? {}
                  : { admissionGate: browserAdmissionGate }),
                deliveryPending: async () => (await service.activeDeliveryAccountCount()) > 0,
                onRuntimeCleanupError: (channelAccountId, error) => {
                  console.error(
                    JSON.stringify({
                      event: "priority_platform_analytics_runtime_cleanup_failed",
                      channelAccountId,
                      errorType: error instanceof Error ? error.name : typeof error,
                      message:
                        error instanceof Error
                          ? error.message.replace(/\s+/gu, " ").slice(0, 240)
                          : null,
                    }),
                  );
                },
              }),
        runtimeStatusService:
          sessions === null
            ? null
            : new DefaultCtripAccountRuntimeStatusRefreshService({
                tenantId: config.tenantId,
                bridgePrincipalId: config.bridgePrincipalId,
                controlPlane,
                sessions,
                onError: (error) => {
                  console.error(
                    JSON.stringify({
                      event: "ctrip_account_runtime_status_refresh_failed",
                      errorType: error instanceof Error ? error.name : typeof error,
                      message:
                        error instanceof Error
                          ? error.message.replace(/\s+/gu, " ").slice(0, 240)
                          : null,
                    }),
                  );
                },
              }),
        browserReclaimService,
      };
    });
    const server = createCtripBridgeHttpServer({
      tenants,
      allowedHosts: ctripBridgeAllowedHosts(host, port),
      mode,
      adapterVersion,
      commandCapabilities,
    });
    const runtimeStatusServices = tenants.flatMap((tenant) =>
      tenant.runtimeStatusService === null ? [] : [tenant.runtimeStatusService],
    );
    if (runtimeStatusServices.length > 0) {
      runtimeStatusPoller = startCtripAccountRuntimeStatusPoller({
        services: runtimeStatusServices,
        onError: (error) => {
          console.error(
            JSON.stringify({
              event: "ctrip_account_runtime_status_poll_failed",
              errorType: error instanceof Error ? error.name : typeof error,
              message:
                error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : null,
            }),
          );
        },
      });
    }
    const browserReclaimServices = tenants.flatMap((tenant) =>
      tenant.browserReclaimService === null ? [] : [tenant.browserReclaimService],
    );
    if (browserReclaimServices.length > 0) {
      browserReclaimPoller = startCtripAccountBrowserReclaimPoller({
        services: browserReclaimServices,
        pollIntervalMs: 10_000,
        onError: (error) => {
          console.error(
            JSON.stringify({
              event: "ctrip_account_browser_reclaim_poll_failed",
              errorType: error instanceof Error ? error.name : typeof error,
              message:
                error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : null,
            }),
          );
        },
      });
    }
    if (
      mode === "browser_draft" ||
      mode === "browser_supervised" ||
      mode === "browser_unattended"
    ) {
      preparationPoller = startCtripPreparationPoller({
        services: tenants.map((tenant) => tenant.service),
        concurrency: browserConfig?.accountConcurrency ?? 1,
        ...(browserAdmissionGate === undefined ? {} : { admissionGate: browserAdmissionGate }),
        ...(browserConfig === null ? {} : { cpuPausePercent: browserConfig.cpuPausePercent }),
        onError: (error) => {
          const code = error instanceof CtripBridgeServiceError ? error.code : "UNEXPECTED";
          const message =
            error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : null;
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
      const analyticsServices = tenants.flatMap((tenant) => [
        ...(tenant.analyticsService === null ? [] : [tenant.analyticsService]),
        ...(tenant.priorityAnalyticsService === null ? [] : [tenant.priorityAnalyticsService]),
      ]);
      analyticsPoller = startCtripAccountAnalyticsPoller({
        services: analyticsServices,
        onError: (error) => {
          console.error(
            JSON.stringify({
              event: "ctrip_account_analytics_refresh_failed",
              errorType: error instanceof Error ? error.name : typeof error,
              message:
                error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : null,
            }),
          );
        },
      });
    }
    server.once("close", () => {
      void Promise.allSettled([
        preparationPoller?.stop(),
        analyticsPoller?.stop(),
        runtimeStatusPoller?.stop(),
        browserReclaimPoller?.stop(),
        ownedDatabase.destroy(),
      ]);
    });
    await listenCtripBridgeHttpServer(server, { host, port });
  } catch (error) {
    await Promise.allSettled([
      preparationPoller?.stop(),
      analyticsPoller?.stop(),
      runtimeStatusPoller?.stop(),
      browserReclaimPoller?.stop(),
      database?.destroy(),
    ]);
    throw error;
  }
}

await main();
