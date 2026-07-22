import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectCtripBrowserReviewSession,
  type CtripBrowserReviewConnection,
} from "./browser-review-session.js";
import type {
  PlaywrightCtripReadLocator,
  PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";
import type {
  PlaywrightCtripDraftLocator,
  PlaywrightCtripDraftPage,
} from "./playwright-draft-writer.js";

const previousTemp = {
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TMPDIR: process.env.TMPDIR,
};

afterEach(() => {
  for (const [name, value] of Object.entries(previousTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function emptyLocator(): PlaywrightCtripReadLocator & PlaywrightCtripDraftLocator {
  const locator: PlaywrightCtripReadLocator & PlaywrightCtripDraftLocator = {
    count: async () => 0,
    nth: () => locator,
    first: () => locator,
    isVisible: async () => false,
    hover: async () => undefined,
    getAttribute: async () => null,
    textContent: async () => null,
    fill: async () => undefined,
    click: async () => undefined,
    setInputFiles: async () => undefined,
  };
  return locator;
}

describe("Ctrip browser review session", () => {
  it("sets the reviewed temp root before connecting and re-reads current pages", async () => {
    const pages: (PlaywrightCtripReadPage & PlaywrightCtripDraftPage)[] = [
      {
        url: () => "https://you.ctrip.com/community/write",
        locator: emptyLocator,
        evaluate: async <Result>() => ({ controls: [], challengeSignals: [] }) as Result,
        bringToFront: async () => undefined,
      },
    ];
    const close = vi.fn(async () => undefined);
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [{ pages: () => pages }],
      close,
    };
    const ensureDirectory = vi.fn(async () => undefined);
    const resolveWebSocketEndpoint = vi.fn(
      async () => "ws://127.0.0.1:9222/devtools/browser/review-session",
    );
    const connectOverCdp = vi.fn(async () => {
      expect(process.env.TEMP).toBe("D:\\GEO\\.runtime\\tmp");
      return connection;
    });

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://127.0.0.1:9222/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      ensureDirectory,
      resolveWebSocketEndpoint,
      connectOverCdp,
    });
    await expect(session.inspect()).resolves.toMatchObject({ outcome: "adapter_drift" });
    pages.splice(0, 1);
    await expect(session.inspect()).resolves.toMatchObject({ outcome: "session_required" });
    await session.close();

    expect(ensureDirectory).toHaveBeenCalledWith("D:\\GEO\\.runtime\\tmp");
    expect(resolveWebSocketEndpoint).toHaveBeenCalledWith("http://127.0.0.1:9222/");
    expect(connectOverCdp).toHaveBeenCalledWith(
      "ws://127.0.0.1:9222/devtools/browser/review-session",
      { timeout: 30_000 },
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("connects through the fixed Docker Desktop target and preserves its Host header", async () => {
    const connection: CtripBrowserReviewConnection = {
      contexts: () => [],
      close: async () => undefined,
    };
    const resolveDockerWebSocketEndpoint = vi.fn(async () => ({
      webSocketEndpoint: "ws://host.docker.internal:9333/devtools/browser/draft-session",
      headers: { Host: "127.0.0.1:9333" as const },
    }));
    const connectOverCdp = vi.fn(async () => connection);

    const session = await connectCtripBrowserReviewSession({
      httpEndpoint: "http://host.docker.internal:9333/",
      runtimeTmpRoot: "D:\\GEO\\.runtime\\tmp",
      transport: "docker_desktop",
      ensureDirectory: async () => undefined,
      resolveDockerWebSocketEndpoint,
      connectOverCdp,
    });

    expect(resolveDockerWebSocketEndpoint).toHaveBeenCalledWith(
      "http://host.docker.internal:9333/",
    );
    expect(connectOverCdp).toHaveBeenCalledWith(
      "ws://host.docker.internal:9333/devtools/browser/draft-session",
      { timeout: 30_000, headers: { Host: "127.0.0.1:9333" } },
    );
    await expect(session.draftWriter.inspect()).resolves.toMatchObject({
      status: "session_required",
    });
    await session.close();
  });
});
