import { describe, expect, it, vi } from "vitest";

import { startCtripPreparationPoller } from "./preparation-poller.js";

describe("Ctrip preparation poller", () => {
  it("serially drains claimed preparations and stops without another mutation", async () => {
    const active: number[] = [];
    let calls = 0;
    const prepareNext = vi.fn(async (_requestId: string) => {
      void _requestId;
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
    expect(
      prepareNext.mock.calls.every(([requestId]) => requestId.startsWith("ctrip-prepare-poll:")),
    ).toBe(true);
  });

  it("backs off after an error and never exposes a submit operation", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const prepareNext = vi.fn(async (_requestId: string) => {
      void _requestId;
      throw new Error("database unavailable");
    });
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext }],
      pollIntervalMs: 100,
      errorBackoffMs: 100,
      onError,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(99);
      expect(onError).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(Object.keys({ prepareNext })).toEqual(["prepareNext"]);
    } finally {
      await poller.stop();
      vi.useRealTimers();
    }
  });
  it("backs off when public readback remains pending instead of refreshing in a hot loop", async () => {
    const prepareNext = vi.fn(async (_requestId: string) => {
      void _requestId;
      return null;
    });
    const readbackNext = vi.fn(async (_requestId: string) => {
      void _requestId;
      return { command: "readback", state: "readback_pending" } as never;
    });
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

  it("runs delivery for different accounts through two concurrent claim workers", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext }],
      concurrency: 2,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(2));
      expect(maximumActive).toBe(2);
    } finally {
      release();
      await poller.stop();
    }
  });

  it("sizes workers from runnable account demand instead of a fixed quota", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    const runnableDeliveryAccountCount = vi.fn(async () => 3);
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount }],
      concurrency: 8,
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(3));
      expect(maximumActive).toBe(3);
      expect(runnableDeliveryAccountCount).toHaveBeenCalled();
    } finally {
      release();
      await poller.stop();
    }
  });

  it("scales worker concurrency down from CPU headroom before the pause watermark", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    const snapshot = vi.fn(async () => ({
      canClaim: true,
      activeSessions: 1,
      maxActiveSessions: 6,
      cpuUtilizationPercent: 280,
      cpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      hostCpuUtilizationPercent: 0,
      hostLoadAverage1m: 0,
      hostCpuCoreCount: 4,
      effectiveCpuUtilizationPercent: 70,
    }));
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 3 }],
      concurrency: 4,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => true), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(1));
      expect(snapshot).toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(prepareNext).toHaveBeenCalledTimes(1);
      expect(maximumActive).toBe(1);
    } finally {
      release();
      await poller.stop();
    }
  });

  it("keeps delivery workers paused while CPU telemetry is at the watermark", async () => {
    vi.useFakeTimers();
    const prepareNext = vi.fn(async () => null);
    const snapshot = vi.fn(async () => ({
      canClaim: false,
      activeSessions: 1,
      maxActiveSessions: 6,
      cpuUtilizationPercent: 80,
      cpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      hostCpuUtilizationPercent: 0,
      hostLoadAverage1m: 0,
      hostCpuCoreCount: 4,
      effectiveCpuUtilizationPercent: 20,
    }));
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 2 }],
      concurrency: 2,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => false), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshot).toHaveBeenCalled();
      expect(prepareNext).not.toHaveBeenCalled();
    } finally {
      await poller.stop();
      vi.useRealTimers();
    }
  });

  it("waits at the admission gate before claiming database work", async () => {
    vi.useFakeTimers();
    const canClaim = vi.fn(async () => false);
    const prepareNext = vi.fn(async () => null);
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext }],
      admissionGate: { canClaim },
      admissionBackoffMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(canClaim).toHaveBeenCalledOnce();
      expect(prepareNext).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(canClaim).toHaveBeenCalledTimes(2);
      expect(prepareNext).not.toHaveBeenCalled();
    } finally {
      await poller.stop();
      vi.useRealTimers();
    }
  });

  it("uses the full concurrency cap when normalized CPU headroom is idle", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    const snapshot = vi.fn(async () => ({
      canClaim: true,
      activeSessions: 0,
      maxActiveSessions: 6,
      cpuUtilizationPercent: 0,
      cpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      hostCpuUtilizationPercent: 0,
      hostLoadAverage1m: 0,
      hostCpuCoreCount: 4,
      effectiveCpuUtilizationPercent: 0,
    }));
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 4 }],
      concurrency: 4,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => true), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(4));
      expect(maximumActive).toBe(4);
    } finally {
      release();
      await poller.stop();
    }
  });

  it("scales normalized CPU headroom across multiple cores", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    const snapshot = vi.fn(async () => ({
      canClaim: true,
      activeSessions: 0,
      maxActiveSessions: 6,
      cpuUtilizationPercent: 200,
      cpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      hostCpuUtilizationPercent: 0,
      hostLoadAverage1m: 0,
      hostCpuCoreCount: 4,
      effectiveCpuUtilizationPercent: 50,
    }));
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 4 }],
      concurrency: 4,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => true), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(2));
      expect(maximumActive).toBe(2);
    } finally {
      release();
      await poller.stop();
    }
  });

  it("restores three workers after a high-CPU interval clears on a six-core browser host", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareNext = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return null;
    });
    let samples = 0;
    const snapshot = vi.fn(async () => {
      samples += 1;
      const hostCpuUtilizationPercent = samples === 1 ? 70 : 31.25;
      return {
        canClaim: true,
        activeSessions: 0,
        maxActiveSessions: 6,
        cpuUtilizationPercent: hostCpuUtilizationPercent * 6,
        cpuCoreCount: 6,
        cpuSampleAgeMs: 100,
        hostCpuUtilizationPercent,
        hostLoadAverage1m: 2.5,
        hostCpuCoreCount: 8,
        effectiveCpuUtilizationPercent: hostCpuUtilizationPercent,
      };
    });
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 4 }],
      concurrency: 4,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => true), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(3), { timeout: 2_000 });
      expect(maximumActive).toBe(3);
    } finally {
      release();
      await poller.stop();
    }
  });

  it("drops to one worker when browser host health is unavailable", async () => {
    const prepareNext = vi.fn(async () => null);
    const snapshot = vi.fn(async () => null);
    const poller = startCtripPreparationPoller({
      services: [{ prepareNext, runnableDeliveryAccountCount: async () => 3 }],
      concurrency: 4,
      cpuPausePercent: 75,
      admissionGate: { canClaim: vi.fn(async () => true), snapshot },
      demandSampleMs: 100,
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    try {
      await vi.waitFor(() => expect(prepareNext).toHaveBeenCalledTimes(1));
      expect(snapshot).toHaveBeenCalled();
    } finally {
      await poller.stop();
    }
  });
});
