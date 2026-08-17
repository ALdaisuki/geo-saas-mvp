import { idSchema } from "@geo/contracts";

export const OPERATIONS_EVENT_RETRY_MS = 5_000;
export const OPERATIONS_HEARTBEAT_INTERVAL_MS = 15_000;

export interface OperationsEventStreamTarget {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: string): unknown;
  once(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
}

export type OperationsSnapshotListener = (emittedAt: string) => void;

export interface OperationsEventBus {
  subscribe(tenantId: string, listener: OperationsSnapshotListener): () => void;
  publishSnapshot(tenantId: string, emittedAt?: string): void;
}

export class InMemoryOperationsEventBus implements OperationsEventBus {
  readonly #listeners = new Map<string, Set<OperationsSnapshotListener>>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  subscribe(tenantId: string, listener: OperationsSnapshotListener): () => void {
    const parsedTenantId = idSchema.parse(tenantId);
    const listeners = this.#listeners.get(parsedTenantId) ?? new Set<OperationsSnapshotListener>();
    listeners.add(listener);
    this.#listeners.set(parsedTenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(parsedTenantId);
    };
  }

  publishSnapshot(tenantId: string, emittedAt = this.#now().toISOString()): void {
    const parsedTenantId = idSchema.parse(tenantId);
    const parsedEmittedAt = parseEventTimestamp(emittedAt);
    const listeners = this.#listeners.get(parsedTenantId);
    for (const listener of listeners ?? []) {
      try {
        listener(parsedEmittedAt);
      } catch {
        listeners?.delete(listener);
      }
    }
    if (listeners?.size === 0) this.#listeners.delete(parsedTenantId);
  }
}

function parseEventTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Operations event timestamp must be valid");
  }
  return timestamp.toISOString();
}

export function formatOperationsSnapshotEvent(input: {
  readonly tenantId: string;
  readonly sequence: number;
  readonly emittedAt: string;
}): string {
  const tenantId = idSchema.parse(input.tenantId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("Operations event sequence must be a positive safe integer");
  }
  return [
    `id: ${input.sequence}`,
    "event: snapshot",
    `data: ${JSON.stringify({
      type: "snapshot_required",
      tenantId,
      emittedAt: parseEventTimestamp(input.emittedAt),
    })}`,
    "",
    "",
  ].join("\n");
}

export function formatOperationsHeartbeat(emittedAt: string): string {
  return `: heartbeat ${parseEventTimestamp(emittedAt)}\n\n`;
}

export function startOperationsEventStream(input: {
  readonly response: OperationsEventStreamTarget;
  readonly tenantId: string;
  readonly eventBus: OperationsEventBus;
  readonly now?: () => Date;
  readonly heartbeatIntervalMs?: number;
}): () => void {
  const tenantId = idSchema.parse(input.tenantId);
  const now = input.now ?? (() => new Date());
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? OPERATIONS_HEARTBEAT_INTERVAL_MS;
  let sequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    unsubscribe();
    input.response.off("close", close);
    input.response.off("error", close);
  };
  const writable = () => {
    if (closed || input.response.destroyed || input.response.writableEnded) {
      close();
      return false;
    }
    return true;
  };
  const emitSnapshot = (emittedAt: string) => {
    if (!writable()) return;
    sequence += 1;
    try {
      input.response.write(formatOperationsSnapshotEvent({ tenantId, sequence, emittedAt }));
    } catch {
      close();
    }
  };
  const emitHeartbeat = () => {
    if (!writable()) return;
    try {
      input.response.write(formatOperationsHeartbeat(now().toISOString()));
    } catch {
      close();
    }
  };

  input.response.once("close", close);
  input.response.once("error", close);
  input.response.write(`retry: ${OPERATIONS_EVENT_RETRY_MS}\n\n`);
  if (!writable()) return close;

  unsubscribe = input.eventBus.subscribe(tenantId, emitSnapshot);
  emitSnapshot(now().toISOString());
  if (!closed) {
    timer = setInterval(emitHeartbeat, heartbeatIntervalMs);
    timer.unref();
  }

  return close;
}
