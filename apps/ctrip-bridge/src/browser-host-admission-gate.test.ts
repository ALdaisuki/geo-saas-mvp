import { describe, expect, it, vi } from "vitest";

import { DefaultBrowserHostAdmissionGate } from "./browser-host-admission-gate.js";

function healthResponse(
  activeSessions: number,
  cpuUtilizationPercent: number,
  processCount = 24,
  maxProcessCount = 256,
  taskCount = 240,
  maxTaskCount = 1_536,
): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      activeSessions,
      cpuUtilizationPercent,
      cpuCoreCount: 4,
      hostCpuUtilizationPercent: 15,
      hostLoadAverage1m: 0.6,
      hostCpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      processCount,
      maxProcessCount,
      taskCount,
      maxTaskCount,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("browser host admission gate", () => {
  it("admits work below both the session and CPU watermarks", async () => {
    const fetcher = vi.fn(async () => healthResponse(2, 42));
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: fetcher,
    });

    await expect(gate.canClaim()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://browser-host:10005/health/live"),
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("does not deadlock claims when all browser slots are occupied", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: vi.fn(async () => healthResponse(8, 20)),
    });

    // browser-host can reuse an existing account session or evict an idle one;
    // blocking before the account-scoped activation would starve all handoffs.
    await expect(gate.canClaim()).resolves.toBe(true);
  });

  it("still pauses claims at the CPU watermark", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: vi.fn(async () => healthResponse(2, 340)),
    });

    await expect(gate.canClaim()).resolves.toBe(false);
  });

  it("pauses when host load is saturated even if the browser cgroup is idle", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              activeSessions: 1,
              cpuUtilizationPercent: 20,
              cpuCoreCount: 4,
              hostCpuUtilizationPercent: 90,
              hostLoadAverage1m: 3.6,
              hostCpuCoreCount: 4,
              cpuSampleAgeMs: 100,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });

    await expect(gate.canClaim()).resolves.toBe(false);
  });

  it("shares one sampled health request across concurrent claimers", async () => {
    const fetcher = vi.fn(async () => healthResponse(1, 10));
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      fetch: fetcher,
      now: () => 1_000,
    });

    await expect(Promise.all([gate.canClaim(), gate.canClaim()])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("pauses when browser CPU telemetry is stale", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              activeSessions: 1,
              cpuUtilizationPercent: 10,
              cpuCoreCount: 4,
              cpuSampleAgeMs: 5_001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });

    await expect(gate.canClaim()).resolves.toBe(false);
  });

  it("exposes a structured snapshot for CPU-aware worker sizing", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 6,
      cpuPausePercent: 75,
      fetch: vi.fn(async () => healthResponse(2, 60)),
    });

    await expect(gate.snapshot()).resolves.toEqual({
      canClaim: true,
      activeSessions: 2,
      maxActiveSessions: 6,
      cpuUtilizationPercent: 60,
      cpuCoreCount: 4,
      cpuSampleAgeMs: 100,
      hostCpuUtilizationPercent: 15,
      hostLoadAverage1m: 0.6,
      hostCpuCoreCount: 4,
      effectiveCpuUtilizationPercent: 15,
      processCount: 24,
      maxProcessCount: 256,
      taskCount: 240,
      maxTaskCount: 1_536,
    });
    await expect(gate.canClaim()).resolves.toBe(true);
  });

  it("pauses claims when the browser process watermark is reached", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: vi.fn(async () => healthResponse(2, 20, 256, 256)),
    });

    await expect(gate.canClaim()).resolves.toBe(false);
    await expect(gate.snapshot()).resolves.toMatchObject({
      canClaim: false,
      processCount: 256,
      maxProcessCount: 256,
    });
  });

  it("pauses claims when the browser cgroup task watermark is reached", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 8,
      cpuPausePercent: 85,
      fetch: vi.fn(async () => healthResponse(2, 20, 24, 256, 1_536, 1_536)),
    });

    await expect(gate.canClaim()).resolves.toBe(false);
    await expect(gate.snapshot()).resolves.toMatchObject({
      canClaim: false,
      taskCount: 1_536,
      maxTaskCount: 1_536,
    });
  });

  it("returns a null snapshot when the host health probe fails", async () => {
    const gate = new DefaultBrowserHostAdmissionGate({
      httpEndpoint: "http://browser-host:10005",
      maxActiveSessions: 6,
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });

    await expect(gate.snapshot()).resolves.toBeNull();
  });
});
