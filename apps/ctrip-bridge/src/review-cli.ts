import { connectCtripBrowserReviewSession } from "./browser-review-session.js";
import {
  parseCtripBridgeTenantConfigs,
  requireCtripBrowserTenantId,
  resolveCtripBrowserTransport,
} from "./config.js";

async function main(): Promise<void> {
  const endpointValue = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
  const tmpRootValue = process.env.GEO_RUNTIME_TMP_ROOT;
  if (endpointValue === undefined || tmpRootValue === undefined) {
    throw new Error("CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required");
  }
  const transport = resolveCtripBrowserTransport(
    "browser_preflight",
    process.env.CTRIP_BROWSER_TRANSPORT,
  );
  const browserTenantId = process.env.CTRIP_BROWSER_TENANT_ID;
  if (browserTenantId !== undefined || transport === "linux_service") {
    const tenantJson = process.env.CTRIP_BRIDGE_TENANTS_JSON;
    if (browserTenantId === undefined || tenantJson === undefined) {
      throw new Error(
        "CTRIP_BROWSER_TENANT_ID and CTRIP_BRIDGE_TENANTS_JSON are required for the selected browser transport",
      );
    }
    requireCtripBrowserTenantId(browserTenantId, parseCtripBridgeTenantConfigs(tenantJson));
  }
  const session = await connectCtripBrowserReviewSession({
    httpEndpoint: endpointValue,
    runtimeTmpRoot: tmpRootValue,
    transport,
  });
  try {
    const evidence = await session.inspect();
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await session.close();
  }
}

main().catch(() => {
  process.stderr.write("Ctrip authenticated surface review failed\n");
  process.exitCode = 1;
});
