import { mkdir } from "node:fs/promises";

import { reviewCtripAuthenticatedSurface } from "./authenticated-surface-review.js";
import {
  requireLocalCdpEndpoint,
  requireRuntimeTmpRoot,
  resolveLocalCdpWebSocketEndpoint,
} from "./config.js";
import { createPlaywrightCtripSurfaceReviewPage } from "./playwright-surface-reader.js";

async function main(): Promise<void> {
  const endpointValue = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
  const tmpRootValue = process.env.GEO_RUNTIME_TMP_ROOT;
  if (endpointValue === undefined || tmpRootValue === undefined) {
    throw new Error("CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required");
  }
  const endpoint = requireLocalCdpEndpoint(endpointValue);
  const tmpRoot = requireRuntimeTmpRoot(tmpRootValue);
  await mkdir(tmpRoot, { recursive: true });
  process.env.TMP = tmpRoot;
  process.env.TEMP = tmpRoot;
  process.env.TMPDIR = tmpRoot;

  const webSocketEndpoint = await resolveLocalCdpWebSocketEndpoint(endpoint);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(webSocketEndpoint, { timeout: 10_000 });
  try {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .map(createPlaywrightCtripSurfaceReviewPage);
    const evidence = await reviewCtripAuthenticatedSurface(pages);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    // For a CDP attachment Playwright maps close to transport disconnect and cleanup.
    await browser.close();
  }
}

main().catch(() => {
  process.stderr.write("Ctrip authenticated surface review failed\n");
  process.exitCode = 1;
});
