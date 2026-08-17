import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatOperationsSnapshotEvent,
  formatOperationsHeartbeat,
  InMemoryOperationsEventBus,
  OPERATIONS_EVENT_RETRY_MS,
  OPERATIONS_HEARTBEAT_INTERVAL_MS,
  startOperationsEventStream,
} from "./operations-event-stream.js";

class FakeStreamTarget extends EventEmitter {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

afterEach(() => vi.useRealTimers());

describe("operations event stream", () => {
  it("emits a tenant-scoped snapshot invalidation without operational payload data", () => {
    const event = formatOperationsSnapshotEvent({
      tenantId: "10000000-0000-4000-8000-000000000001",
      sequence: 7,
      emittedAt: "2026-08-03T14:00:00.000+08:00",
    });

    expect(OPERATIONS_EVENT_RETRY_MS).toBe(5_000);
    expect(event).toContain("id: 7\nevent: snapshot\n");
    expect(event).toContain('"type":"snapshot_required"');
    expect(event).toContain('"tenantId":"10000000-0000-4000-8000-000000000001"');
    expect(event).not.toContain("cookie");
    expect(event.endsWith("\n\n")).toBe(true);
  });

  it("uses comment heartbeats instead of periodic snapshot invalidations", () => {
    vi.useFakeTimers();
    const response = new FakeStreamTarget();
    const eventBus = new InMemoryOperationsEventBus();
    const close = startOperationsEventStream({
      response,
      tenantId: "10000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-08-03T06:00:00.000Z"),
      eventBus,
    });

    expect(response.chunks).toHaveLength(2);
    expect(response.chunks[0]).toBe(`retry: ${OPERATIONS_EVENT_RETRY_MS}\n\n`);
    vi.advanceTimersByTime(OPERATIONS_HEARTBEAT_INTERVAL_MS * 2);
    expect(response.chunks).toHaveLength(4);
    expect(response.chunks.slice(2)).toEqual([
      formatOperationsHeartbeat("2026-08-03T06:00:00.000Z"),
      formatOperationsHeartbeat("2026-08-03T06:00:00.000Z"),
    ]);
    expect(response.chunks.filter((chunk) => chunk.includes("event: snapshot"))).toHaveLength(1);

    eventBus.publishSnapshot("10000000-0000-4000-8000-000000000001", "2026-08-03T06:01:00.000Z");
    expect(response.chunks.at(-1)).toContain("id: 2\nevent: snapshot");

    response.emit("close");
    const chunksAfterClose = response.chunks.length;
    vi.advanceTimersByTime(OPERATIONS_HEARTBEAT_INTERVAL_MS * 2);
    eventBus.publishSnapshot("10000000-0000-4000-8000-000000000001");
    expect(response.chunks).toHaveLength(chunksAfterClose);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(() => close()).not.toThrow();
  });

  it("isolates mutation invalidations by tenant", () => {
    const eventBus = new InMemoryOperationsEventBus();
    const firstTenantEvents: string[] = [];
    const secondTenantEvents: string[] = [];
    const unsubscribe = eventBus.subscribe("10000000-0000-4000-8000-000000000001", (emittedAt) =>
      firstTenantEvents.push(emittedAt),
    );
    eventBus.subscribe("10000000-0000-4000-8000-000000000002", (emittedAt) =>
      secondTenantEvents.push(emittedAt),
    );

    eventBus.publishSnapshot("10000000-0000-4000-8000-000000000001", "2026-08-03T06:02:00.000Z");
    expect(firstTenantEvents).toEqual(["2026-08-03T06:02:00.000Z"]);
    expect(secondTenantEvents).toEqual([]);

    unsubscribe();
    eventBus.publishSnapshot("10000000-0000-4000-8000-000000000001");
    expect(firstTenantEvents).toHaveLength(1);
  });

  it("drops a failed subscriber without blocking healthy tenant subscribers", () => {
    const eventBus = new InMemoryOperationsEventBus();
    const events: string[] = [];
    eventBus.subscribe("10000000-0000-4000-8000-000000000001", () => {
      throw new Error("closed transport");
    });
    eventBus.subscribe("10000000-0000-4000-8000-000000000001", (emittedAt) =>
      events.push(emittedAt),
    );

    expect(() =>
      eventBus.publishSnapshot("10000000-0000-4000-8000-000000000001", "2026-08-03T06:03:00.000Z"),
    ).not.toThrow();
    expect(events).toEqual(["2026-08-03T06:03:00.000Z"]);
  });

  it("does not schedule snapshots for an already-ended response", () => {
    vi.useFakeTimers();
    const response = new FakeStreamTarget();
    response.writableEnded = true;

    startOperationsEventStream({
      response,
      tenantId: "10000000-0000-4000-8000-000000000001",
      eventBus: new InMemoryOperationsEventBus(),
    });
    vi.advanceTimersByTime(OPERATIONS_HEARTBEAT_INTERVAL_MS * 2);

    expect(response.chunks).toEqual([`retry: ${OPERATIONS_EVENT_RETRY_MS}\n\n`]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
