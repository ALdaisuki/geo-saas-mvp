import { mkdir } from "node:fs/promises";

import {
  reviewCtripAuthenticatedSurface,
  type CtripSurfaceReviewEvidence,
} from "./authenticated-surface-review.js";
import {
  requireLocalCdpEndpoint,
  requireRuntimeTmpRoot,
  resolveLocalCdpWebSocketEndpoint,
} from "./config.js";
import {
  createPlaywrightCtripSurfaceReviewPage,
  type PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

export interface CtripBrowserReviewConnection {
  contexts(): readonly { pages(): readonly PlaywrightCtripReadPage[] }[];
  close(): Promise<void>;
}

export interface CtripBrowserReviewSession {
  inspect(): Promise<CtripSurfaceReviewEvidence>;
  close(): Promise<void>;
}

type ConnectOverCdp = (
  endpoint: string,
  options: { readonly timeout: number },
) => Promise<CtripBrowserReviewConnection>;

async function defaultConnectOverCdp(
  endpoint: string,
  options: { readonly timeout: number },
): Promise<CtripBrowserReviewConnection> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(endpoint, options);
}

export async function connectCtripBrowserReviewSession(options: {
  readonly httpEndpoint: string;
  readonly runtimeTmpRoot: string;
  readonly ensureDirectory?: (path: string) => Promise<unknown>;
  readonly resolveWebSocketEndpoint?: (httpEndpoint: string) => Promise<string>;
  readonly connectOverCdp?: ConnectOverCdp;
}): Promise<CtripBrowserReviewSession> {
  const httpEndpoint = requireLocalCdpEndpoint(options.httpEndpoint);
  const runtimeTmpRoot = requireRuntimeTmpRoot(options.runtimeTmpRoot);
  await (options.ensureDirectory ?? ((path) => mkdir(path, { recursive: true })))(runtimeTmpRoot);
  process.env.TMP = runtimeTmpRoot;
  process.env.TEMP = runtimeTmpRoot;
  process.env.TMPDIR = runtimeTmpRoot;

  const webSocketEndpoint = await (
    options.resolveWebSocketEndpoint ?? resolveLocalCdpWebSocketEndpoint
  )(httpEndpoint);
  const connection = await (options.connectOverCdp ?? defaultConnectOverCdp)(webSocketEndpoint, {
    timeout: 10_000,
  });
  let closed = false;
  return Object.freeze({
    inspect: () => {
      const pages = connection
        .contexts()
        .flatMap((context) => context.pages())
        .map(createPlaywrightCtripSurfaceReviewPage);
      return reviewCtripAuthenticatedSurface(pages);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await connection.close();
    },
  });
}
