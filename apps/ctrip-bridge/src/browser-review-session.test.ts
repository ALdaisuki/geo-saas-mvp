import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectCtripBrowserReviewSession,
  type CtripBrowserReviewConnection,
} from "./browser-review-session.js";
import type {
  PlaywrightCtripReadLocator,
  PlaywrightCtripReadPage,
} from "./playwright-surface-reader.js";

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

function emptyLocator(): PlaywrightCtripReadLocator {
  const locator: PlaywrightCtripReadLocator = {
    count: async () => 0,
    nth: () => locator,
    first: () => locator,
    isVisible: async () => false,
    getAttribute: async () => null,
    textContent: async () => null,
  };
  return locator;
}

describe("Ctrip browser review session", () => {
  it("sets the reviewed temp root before connecting and re-reads current pages", async () => {
    const pages: PlaywrightCtripReadPage[] = [
      { url: () => "https://you.ctrip.com/community/write", locator: emptyLocator },
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
      { timeout: 10_000 },
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
