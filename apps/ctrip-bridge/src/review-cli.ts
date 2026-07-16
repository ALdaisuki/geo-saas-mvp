import { connectCtripBrowserReviewSession } from "./browser-review-session.js";

async function main(): Promise<void> {
  const endpointValue = process.env.CTRIP_REVIEW_CDP_ENDPOINT;
  const tmpRootValue = process.env.GEO_RUNTIME_TMP_ROOT;
  if (endpointValue === undefined || tmpRootValue === undefined) {
    throw new Error("CTRIP_REVIEW_CDP_ENDPOINT and GEO_RUNTIME_TMP_ROOT are required");
  }
  const session = await connectCtripBrowserReviewSession({
    httpEndpoint: endpointValue,
    runtimeTmpRoot: tmpRootValue,
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
