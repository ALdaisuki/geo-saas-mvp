import { describe, expect, it, vi } from "vitest";

import { startCtripPreparationPoller } from "./preparation-poller.js";

describe("Ctrip preparation poller", () => {
  it("serially drains claimed preparations and stops without another mutation", async () => {
    const active: number[] = [];
    let calls = 0;
    const prepareNext = vi.fn(async (_requestId: string) => {
      active.push(1);
      expect(active).toHaveLength(1);
      calls += 1;
      active.pop();
      return calls <= 2 ? ({ command: "prepare" } as never) : null;
    });
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext }],
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(3));
    await poller.stop();
    expect(prepareNext).toHaveBeenCalledTimes(3);
    expect(prepareNext.mock.calls.every(([requestId]) => requestId.startsWith("ctrip-prepare-poll:"))).toBe(true);
  });

  it("backs off after an error and never exposes a submit operation", async () => {
    const onError = vi.fn();
    const prepareNext = vi.fn(async (_requestId: string) => {
      throw new Error("database unavailable");
    });
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext }],
      pollIntervalMs: 100,
      errorBackoffMs: 100,
      onError,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await poller.stop();
    expect(Object.keys({ prepareNext })).toEqual(["prepareNext"]);
  });
  it("backs off when public readback remains pending instead of refreshing in a hot loop", async () => {
    const prepareNext = vi.fn(async (_requestId: string) => null);
    const readbackNext = vi.fn(async (_requestId: string) =>
      ({ command: "readback", state: "readback_pending" }) as never,
    );
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, readbackNext }],
      pollIntervalMs: 100,
      errorBackoffMs: 100,
      readbackBackoffMs: 250,
    });

    await vi.waitFor(() => expect(readbackNext).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readbackNext).toHaveBeenCalledOnce();
    await poller.stop();
  });
});
