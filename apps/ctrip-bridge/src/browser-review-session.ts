import { mkdir } from "node:fs/promises";

import {
  ctripOperationalReadiness,
  reviewCtripAuthenticatedSurface,
  type CtripOperationalReadiness,
  type CtripSurfaceReviewEvidence,
} from "./authenticated-surface-review.js";
import {
  requireDockerDesktopCdpEndpoint,
  requireLocalCdpEndpoint,
  requireRuntimeTmpRoot,
  resolveDockerDesktopCdpWebSocketEndpoint,
  resolveLocalCdpWebSocketEndpoint,
  type DockerDesktopCdpConnectionTarget,
} from "./config.js";
import type { CtripDraftWriter } from "./browser-draft-adapter.js";
import {
  createPlaywrightCtripDraftWriter,
  type PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";
import {
  createPlaywrightCtripSupervisedSubmitWriter,
  type CtripSupervisedSubmitWriter,
} from "./playwright-supervised-submit-writer.js";
import {
  createPlaywrightCtripPublicReadbackWriter,
  type CtripPublicReadbackWriter,
} from "./playwright-public-readback-writer.js";
import {
  createPlaywrightCtripSurfaceReviewPage,
  type PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

export interface CtripBrowserReviewConnection {
  contexts(): readonly {
    pages(): readonly (PlaywrightCtripReadPage & PlaywrightCtripDraftPage)[];
    newPage?(): Promise<PlaywrightCtripReadPage & PlaywrightCtripDraftPage>;
  }[];
  close(): Promise<void>;
}

export interface CtripBrowserReviewSession {
  inspect(): Promise<CtripSurfaceReviewEvidence>;
  readiness(): Promise<CtripOperationalReadiness>;
  readonly draftWriter: CtripDraftWriter;
  readonly supervisedSubmitWriter: CtripSupervisedSubmitWriter;
  readonly publicReadbackWriter: CtripPublicReadbackWriter;
  close(): Promise<void>;
}

type ConnectOverCdp = (
  endpoint: string,
  options: { readonly timeout: number; readonly headers?: Readonly<Record<string, string>> },
) => Promise<CtripBrowserReviewConnection>;

const CDP_CONNECT_TIMEOUT_MS = 30_000;

async function defaultConnectOverCdp(
  endpoint: string,
  options: { readonly timeout: number; readonly headers?: Readonly<Record<string, string>> },
): Promise<CtripBrowserReviewConnection> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(endpoint, options);
}

export async function connectCtripBrowserReviewSession(options: {
  readonly httpEndpoint: string;
  readonly runtimeTmpRoot: string;
  readonly transport?: "local" | "docker_desktop";
  readonly ensureDirectory?: (path: string) => Promise<unknown>;
  readonly resolveWebSocketEndpoint?: (httpEndpoint: string) => Promise<string>;
  readonly resolveDockerWebSocketEndpoint?: (
    httpEndpoint: string,
  ) => Promise<DockerDesktopCdpConnectionTarget>;
  readonly connectOverCdp?: ConnectOverCdp;
}): Promise<CtripBrowserReviewSession> {
  const transport = options.transport ?? "local";
  const httpEndpoint =
    transport === "local"
      ? requireLocalCdpEndpoint(options.httpEndpoint)
      : requireDockerDesktopCdpEndpoint(options.httpEndpoint);
  const runtimeTmpRoot = requireRuntimeTmpRoot(options.runtimeTmpRoot);
  await (options.ensureDirectory ?? ((path) => mkdir(path, { recursive: true })))(runtimeTmpRoot);
  process.env.TMP = runtimeTmpRoot;
  process.env.TEMP = runtimeTmpRoot;
  process.env.TMPDIR = runtimeTmpRoot;

  const target =
    transport === "local"
      ? {
          webSocketEndpoint: await (
            options.resolveWebSocketEndpoint ?? resolveLocalCdpWebSocketEndpoint
          )(httpEndpoint),
        }
      : await (options.resolveDockerWebSocketEndpoint ?? resolveDockerDesktopCdpWebSocketEndpoint)(
          httpEndpoint,
        );
  const connection = await (options.connectOverCdp ?? defaultConnectOverCdp)(
    target.webSocketEndpoint,
    "headers" in target
      ? { timeout: CDP_CONNECT_TIMEOUT_MS, headers: target.headers }
      : { timeout: CDP_CONNECT_TIMEOUT_MS },
  );
  let closed = false;
  const pages = () => connection.contexts().flatMap((context) => context.pages());
  const openPage = async (url: string): Promise<PlaywrightCtripDraftPage> => {
    const contexts = connection.contexts();
    if (contexts.length !== 1 || contexts[0]?.newPage === undefined) {
      throw new Error("Ctrip browser context is not unique or cannot open a recovery page");
    }
    const page = await contexts[0].newPage();
    if (page.goto === undefined) throw new Error("Ctrip recovery page cannot navigate");
    await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("domcontentloaded", { timeout: 30_000 });
    return page;
  };
  const inspect = () =>
    reviewCtripAuthenticatedSurface(pages().map(createPlaywrightCtripSurfaceReviewPage));
  return Object.freeze({
    inspect,
    readiness: async () => ctripOperationalReadiness(await inspect()),
    draftWriter: createPlaywrightCtripDraftWriter({ pages, openPage }),
    supervisedSubmitWriter: createPlaywrightCtripSupervisedSubmitWriter({ pages }),
    publicReadbackWriter: createPlaywrightCtripPublicReadbackWriter({ pages, openPage }),
    close: async () => {
      if (closed) return;
      closed = true;
      await connection.close();
    },
  });
}
