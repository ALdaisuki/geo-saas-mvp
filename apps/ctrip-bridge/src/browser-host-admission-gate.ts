export const DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT = 85;
export const DEFAULT_BROWSER_HOST_ADMISSION_SAMPLE_TTL_MS = 1_000;

export interface BrowserHostAdmissionSnapshot {
  readonly canClaim: boolean;
  readonly activeSessions: number;
  readonly maxActiveSessions: number;
  readonly cpuUtilizationPercent: number;
  readonly cpuCoreCount: number;
  readonly cpuSampleAgeMs: number;
  readonly hostCpuUtilizationPercent: number;
  readonly hostLoadAverage1m: number;
  readonly hostCpuCoreCount: number;
  readonly effectiveCpuUtilizationPercent: number;
  readonly processCount?: number;
  readonly maxProcessCount?: number;
  readonly taskCount?: number;
  readonly maxTaskCount?: number;
}

export interface BrowserHostAdmissionGate {
  canClaim(): Promise<boolean>;
  snapshot?(): Promise<BrowserHostAdmissionSnapshot | null>;
}

interface BrowserHostHealth {
  readonly status: "ok";
  readonly activeSessions: number;
  readonly cpuUtilizationPercent: number;
  readonly cpuCoreCount: number;
  readonly cpuSampleAgeMs: number;
  readonly hostCpuUtilizationPercent?: number;
  readonly hostLoadAverage1m?: number;
  readonly hostCpuCoreCount?: number;
  readonly processCount?: number;
  readonly maxProcessCount?: number;
  readonly taskCount?: number;
  readonly maxTaskCount?: number;
}

function parseHealth(value: unknown): BrowserHostHealth {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("browser host health response is invalid");
  }
  const item = value as Record<string, unknown>;
  if (
    item.status !== "ok" ||
    !Number.isSafeInteger(item.activeSessions) ||
    (item.activeSessions as number) < 0 ||
    typeof item.cpuUtilizationPercent !== "number" ||
    !Number.isFinite(item.cpuUtilizationPercent) ||
    item.cpuUtilizationPercent < 0 ||
    !Number.isSafeInteger(item.cpuCoreCount) ||
    (item.cpuCoreCount as number) < 1 ||
    typeof item.cpuSampleAgeMs !== "number" ||
    !Number.isFinite(item.cpuSampleAgeMs) ||
    item.cpuSampleAgeMs < 0
  ) {
    throw new TypeError("browser host health response is invalid");
  }
  const optionalPercent = (value: unknown, label: string): number => {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`browser host ${label} is invalid`);
    }
    return value;
  };
  const optionalCoreCount = (value: unknown, label: string): number => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new TypeError(`browser host ${label} is invalid`);
    }
    return value as number;
  };
  const optionalCount = (value: unknown, label: string): number => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError(`browser host ${label} is invalid`);
    }
    return value as number;
  };
  return {
    status: "ok",
    activeSessions: item.activeSessions as number,
    cpuUtilizationPercent: item.cpuUtilizationPercent,
    cpuCoreCount: item.cpuCoreCount as number,
    cpuSampleAgeMs: item.cpuSampleAgeMs,
    hostCpuUtilizationPercent: optionalPercent(
      item.hostCpuUtilizationPercent,
      "host CPU utilization",
    ),
    hostLoadAverage1m: optionalPercent(item.hostLoadAverage1m, "host load average"),
    hostCpuCoreCount: optionalCoreCount(item.hostCpuCoreCount, "host CPU core count"),
    processCount: optionalCount(item.processCount, "process count"),
    maxProcessCount: optionalCount(item.maxProcessCount, "maximum process count"),
    taskCount: optionalCount(item.taskCount, "task count"),
    maxTaskCount: optionalCount(item.maxTaskCount, "maximum task count"),
  };
}

export class DefaultBrowserHostAdmissionGate implements BrowserHostAdmissionGate {
  readonly #healthUrl: URL;
  readonly #maxActiveSessions: number;
  readonly #cpuPausePercent: number;
  readonly #sampleTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #nextSampleAt = 0;
  #lastHealth: BrowserHostHealth | null = null;
  #pending: Promise<BrowserHostHealth> | null = null;

  constructor(options: {
    readonly httpEndpoint: string;
    readonly maxActiveSessions: number;
    readonly cpuPausePercent?: number;
    readonly sampleTtlMs?: number;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    this.#healthUrl = new URL("/health/live", options.httpEndpoint);
    this.#maxActiveSessions = options.maxActiveSessions;
    this.#cpuPausePercent = options.cpuPausePercent ?? DEFAULT_BROWSER_HOST_CPU_PAUSE_PERCENT;
    this.#sampleTtlMs = options.sampleTtlMs ?? DEFAULT_BROWSER_HOST_ADMISSION_SAMPLE_TTL_MS;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#maxActiveSessions) ||
      this.#maxActiveSessions < 1 ||
      this.#maxActiveSessions > 16
    ) {
      throw new TypeError("browser host admission session limit is invalid");
    }
    if (
      !Number.isFinite(this.#cpuPausePercent) ||
      this.#cpuPausePercent < 1 ||
      this.#cpuPausePercent > 1_000
    ) {
      throw new TypeError("browser host CPU pause percentage is invalid");
    }
    if (
      !Number.isSafeInteger(this.#sampleTtlMs) ||
      this.#sampleTtlMs < 100 ||
      this.#sampleTtlMs > 60_000
    ) {
      throw new TypeError("browser host admission sample TTL is invalid");
    }
  }

  async #refresh(): Promise<BrowserHostHealth> {
    const response = await this.#fetch(this.#healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`browser host health returned HTTP ${response.status}`);
    const health = parseHealth(await response.json());
    this.#lastHealth = health;
    this.#nextSampleAt = this.#now() + this.#sampleTtlMs;
    return health;
  }

  async #decision(): Promise<BrowserHostHealth> {
    if (this.#now() < this.#nextSampleAt && this.#lastHealth !== null) return this.#lastHealth;
    if (this.#pending !== null) return this.#pending;
    const pending = this.#refresh();
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async canClaim(): Promise<boolean> {
    const health = await this.#decision();
    const maxProcessCount = health.maxProcessCount ?? 0;
    const maxTaskCount = health.maxTaskCount ?? 0;
    return (
      health.cpuSampleAgeMs <= 5_000 &&
      (maxProcessCount === 0 || (health.processCount ?? 0) < maxProcessCount) &&
      (maxTaskCount === 0 || (health.taskCount ?? 0) < maxTaskCount) &&
      this.#effectiveCpu(health) < this.#cpuPausePercent
    );
  }

  #effectiveCpu(health: BrowserHostHealth): number {
    const cgroupCpu = health.cpuUtilizationPercent / health.cpuCoreCount;
    const hostCpu = health.hostCpuUtilizationPercent ?? 0;
    return Math.max(cgroupCpu, hostCpu);
  }

  async snapshot(): Promise<BrowserHostAdmissionSnapshot | null> {
    try {
      const health = await this.#decision();
      const effectiveCpu = this.#effectiveCpu(health);
      const maxProcessCount = health.maxProcessCount ?? 0;
      const maxTaskCount = health.maxTaskCount ?? 0;
      return Object.freeze({
        canClaim:
          health.cpuSampleAgeMs <= 5_000 &&
          (maxProcessCount === 0 || (health.processCount ?? 0) < maxProcessCount) &&
          (maxTaskCount === 0 || (health.taskCount ?? 0) < maxTaskCount) &&
          effectiveCpu < this.#cpuPausePercent,
        activeSessions: health.activeSessions,
        maxActiveSessions: this.#maxActiveSessions,
        cpuUtilizationPercent: health.cpuUtilizationPercent,
        cpuCoreCount: health.cpuCoreCount,
        cpuSampleAgeMs: health.cpuSampleAgeMs,
        hostCpuUtilizationPercent: health.hostCpuUtilizationPercent ?? 0,
        hostLoadAverage1m: health.hostLoadAverage1m ?? 0,
        hostCpuCoreCount: health.hostCpuCoreCount ?? health.cpuCoreCount,
        effectiveCpuUtilizationPercent: effectiveCpu,
        processCount: health.processCount ?? 0,
        maxProcessCount: health.maxProcessCount ?? 0,
        taskCount: health.taskCount ?? 0,
        maxTaskCount: health.maxTaskCount ?? 0,
      });
    } catch {
      return null;
    }
  }
}
