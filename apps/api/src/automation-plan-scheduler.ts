import { randomUUID } from "node:crypto";

import type { ApiRepository, RequestContext } from "./repository.js";
import type { DueCampaignAutomationPlanView } from "./automation-repository.js";
import {
  buildAutomationPlanBatchInput,
  nextCampaignAutomationRunAt,
} from "./automation-plan-batch.js";
import type { OperationsEventBus } from "./operations-event-stream.js";

export interface AutomationPlanRunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly duePlanCount: number;
  readonly createdBatchCount: number;
  readonly failedPlanCount: number;
  readonly errorCodes: readonly string[];
}

export interface AutomationPlanSchedulerOptions {
  readonly repository: Pick<
    ApiRepository,
    | "listDueCampaignAutomationPlans"
    | "updateCampaignAutomationPlanSchedule"
    | "createAutomationBatch"
  >;
  readonly validateActor?: (tenantId: string, actorId: string) => Promise<boolean>;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly maxPlansPerRun?: number;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly operationsEventBus?: Pick<OperationsEventBus, "publishSnapshot">;
  readonly onRun?: (summary: AutomationPlanRunSummary) => void;
  readonly onError?: (errorCode: string) => void;
}

function safeErrorCode(error: unknown, fallback = "AUTOMATION_PLAN_RUN_FAILED"): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_.-]{1,100}$/u.test(code)) return code;
  }
  return fallback;
}

function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(done, milliseconds);
    timeout.unref();
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function planContext(plan: DueCampaignAutomationPlanView, requestId: string): RequestContext {
  return {
    tenantId: plan.tenantId,
    actorId: plan.actorId,
    requestId,
  };
}

export class AutomationPlanScheduler {
  readonly #repository: AutomationPlanSchedulerOptions["repository"];
  readonly #validateActor: NonNullable<AutomationPlanSchedulerOptions["validateActor"]>;
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #maxPlansPerRun: number;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #operationsEventBus: Pick<OperationsEventBus, "publishSnapshot"> | undefined;
  readonly #onRun: ((summary: AutomationPlanRunSummary) => void) | undefined;
  readonly #onError: ((errorCode: string) => void) | undefined;

  #controller: AbortController | undefined;
  #lifecycle: Promise<void> | undefined;

  constructor(options: AutomationPlanSchedulerOptions) {
    this.#repository = options.repository;
    this.#validateActor = options.validateActor ?? (async () => true);
    this.#enabled = options.enabled ?? false;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#maxPlansPerRun = options.maxPlansPerRun ?? 100;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#operationsEventBus = options.operationsEventBus;
    this.#onRun = options.onRun;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new TypeError("Automation plan scheduler interval must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxPlansPerRun) || this.#maxPlansPerRun < 1) {
      throw new TypeError("Automation plan due limit must be a positive safe integer");
    }
  }

  get running(): boolean {
    return this.#lifecycle !== undefined;
  }

  async runOnce(): Promise<AutomationPlanRunSummary> {
    const runId = this.#uuid();
    const startedAt = this.#now().toISOString();
    const duePlans = (await this.#repository.listDueCampaignAutomationPlans(startedAt)).slice(
      0,
      this.#maxPlansPerRun,
    );
    let createdBatchCount = 0;
    let failedPlanCount = 0;
    const errorCodes = new Set<string>();
    for (const plan of duePlans) {
      try {
        const actorValid = await this.#validateActor(plan.tenantId, plan.actorId);
        if (!actorValid)
          throw Object.assign(new Error("Plan actor is not eligible"), {
            code: "AUTOMATION_PLAN_ACTOR_INVALID",
          });
        const requestId = `automation-plan:${runId}:${plan.planId}`;
        const context = planContext(plan, requestId);
        const scheduledAt = this.#now().toISOString();
        const result = await this.#repository.createAutomationBatch(
          context,
          buildAutomationPlanBatchInput({
            plan,
            scheduledAt,
            uuid: this.#uuid,
          }),
        );
        if (result.wasCreated) {
          createdBatchCount += 1;
          try {
            this.#operationsEventBus?.publishSnapshot(plan.tenantId, scheduledAt);
          } catch (error) {
            this.#reportError(safeErrorCode(error, "OPERATIONS_EVENT_PUBLISH_FAILED"));
          }
        }
        const nextRunAt = nextCampaignAutomationRunAt(plan, this.#now());
        await this.#repository.updateCampaignAutomationPlanSchedule(context, plan.planId, {
          lastRunAt: scheduledAt,
          nextRunAt,
          lastErrorAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          incrementRunCount: true,
        });
      } catch (error) {
        failedPlanCount += 1;
        const code = safeErrorCode(error);
        errorCodes.add(code);
        try {
          const context = planContext(plan, `automation-plan:${runId}:${plan.planId}:error`);
          const retryAt = new Date(
            this.#now().getTime() + plan.intervalMinutes * 60_000,
          ).toISOString();
          await this.#repository.updateCampaignAutomationPlanSchedule(context, plan.planId, {
            lastRunAt: null,
            nextRunAt: retryAt,
            lastErrorAt: this.#now().toISOString(),
            lastErrorCode: code,
            lastErrorMessage:
              error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          });
        } catch (reportError) {
          this.#reportError(safeErrorCode(reportError, "AUTOMATION_PLAN_ERROR_PERSIST_FAILED"));
        }
      }
    }
    return {
      runId,
      startedAt,
      completedAt: this.#now().toISOString(),
      duePlanCount: duePlans.length,
      createdBatchCount,
      failedPlanCount,
      errorCodes: [...errorCodes].sort(),
    };
  }

  start(): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#lifecycle !== undefined) return this.#lifecycle;
    const controller = new AbortController();
    this.#controller = controller;
    const lifecycle = this.#run(controller.signal).finally(() => {
      if (this.#lifecycle === lifecycle) {
        this.#lifecycle = undefined;
        this.#controller = undefined;
      }
    });
    this.#lifecycle = lifecycle;
    return lifecycle;
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#lifecycle;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const summary = await this.runOnce();
        if (!signal.aborted) this.#onRun?.(summary);
      } catch (error) {
        this.#reportError(safeErrorCode(error));
      }
      if (!signal.aborted) await waitForInterval(this.#intervalMs, signal);
    }
  }

  #reportError(errorCode: string): void {
    try {
      this.#onError?.(errorCode);
    } catch {
      // Error reporting must not terminate the background lifecycle.
    }
  }
}
