import { describe, expect, it } from "vitest";

import { isBrowserRuntimeUnavailableError } from "./browser-runtime-error.js";

describe("browser runtime error classification", () => {
  it.each([
    "Ctrip account CDP operation did not respond within 600000ms",
    "Ctrip account CDP connect retry timed out after 35000ms",
    "page.waitForTimeout: Target page, context or browser has been closed",
    "browserType.connectOverCDP: websocket disconnected",
    "connect ECONNRESET 10.0.0.4:9222",
    "frame was detached while resolving editor",
    "Ctrip browser runtime unavailable: browser host admission is paused",
  ])("classifies %s as runtime-unavailable", (message) => {
    expect(isBrowserRuntimeUnavailableError(new Error(message))).toBe(true);
  });

  it.each([
    "baijiahao editor controls are not unique",
    "sohu editor requires an interactive security challenge",
    "prepared payload readback does not match the audited article",
  ])("keeps %s as an adapter or challenge error", (message) => {
    expect(isBrowserRuntimeUnavailableError(new Error(message))).toBe(false);
  });
});
