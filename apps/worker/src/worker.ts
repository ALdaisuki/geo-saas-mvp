import { randomUUID } from "node:crypto";

import { stableSha256, type PlatformConnector, type ReconcileResult } from "@geo/connectors";
import { publicationReceiptSchema } from "@geo/contracts";

import {
  classifyFailure,
  PermanentWorkerError,
  RetryableWorkerError,
  UncertainPublicationError,
  type WorkerError,
} from "./errors.js";
import { parsePublicationRequestedPayload } from "./event.js";
import type {
  ClaimedOutboxEvent,
  ConnectorResolver,
  DispatcherStore,
  PublicationRequestedPayload,
  PublicationWork,
  RunSummary,
  TenantContext,
  TenantJobStore,
} from "./types.js";

export interface OutboxWorkerOptions {
  dispatcher: DispatcherStore;
  jobs: TenantJobStore;
  connectors: ConnectorResolver;
  workerId: string;
  actorId: string;
  batchSize?: number;
  concurrency?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBaseSeconds?: number;
  retryMaxSeconds?: number;
  now?: () => Date;
  idGenerator?: () => string;
}

type EventOutcome = Omit<RunSummary, "claimed">;

const EMPTY_OUTCOME: EventOutcome = {
  completed: 0,
  acknowledged: 0,
  retried: 0,
  deadLettered: 0,
  reconciled: 0,
};

function addOutcome(target: RunSummary, outcome: EventOutcome): void {
  target.completed += outcome.completed;
  target.acknowledged += outcome.acknowledged;
  target.retried += outcome.retried;
  target.deadLettered += outcome.deadLettered;
  target.reconciled += outcome.reconciled;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker failure";
}

export class OutboxWorker {
  readonly #dispatcher: DispatcherStore;
  readonly #jobs: TenantJobStore;
  readonly #connectors: ConnectorResolver;
  readonly #workerId: string;
  readonly #actorId: string;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;
  readonly #retryBaseSeconds: number;
  readonly #retryMaxSeconds: number;
  readonly #now: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: OutboxWorkerOptions) {
    this.#dispatcher = options.dispatcher;
    this.#jobs = options.jobs;
    this.#connectors = options.connectors;
    this.#workerId = options.workerId;
    this.#actorId = options.actorId;
    this.#batchSize = options.batchSize ?? 25;
    this.#concurrency = options.concurrency ?? 4;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#retryBaseSeconds = options.retryBaseSeconds ?? 15;
    this.#retryMaxSeconds = options.retryMaxSeconds ?? 900;
    this.#now = options.now ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;

    if (
      this.#batchSize < 1 ||
      this.#batchSize > 100 ||
      this.#concurrency < 1 ||
      this.#concurrency > this.#batchSize ||
      this.#leaseSeconds < 5 ||
      this.#leaseSeconds > 600 ||
      this.#maxAttempts < 1
    ) {
      throw new TypeError("Invalid outbox worker limits");
    }
  }

  async runOnce(): Promise<RunSummary> {
    const events = await this.#dispatcher.claim({
      workerId: this.#workerId,
      limit: this.#batchSize,
      leaseSeconds: this.#leaseSeconds,
    });
    const summary: RunSummary = { claimed: events.length, ...EMPTY_OUTCOME };

    for (let offset = 0; offset < events.length; offset += this.#concurrency) {
      const outcomes = await Promise.all(
        events
          .slice(offset, offset + this.#concurrency)
          .map(async (event) => this.#handleEvent(event)),
      );
      for (const outcome of outcomes) addOutcome(summary, outcome);
    }

    return summary;
  }

  async #handleEvent(event: ClaimedOutboxEvent): Promise<EventOutcome> {
    let payload: PublicationRequestedPayload | undefined;
    let work: PublicationWork | undefined;
    let context: TenantContext | undefined;
    let connector: PlatformConnector | undefined;
    const attemptId = this.#idGenerator();

    try {
      if (event.topic !== "publication.requested") {
        throw new PermanentWorkerError(
          "UNSUPPORTED_OUTBOX_TOPIC",
          `Unsupported outbox topic: ${event.topic}`,
        );
      }

      payload = parsePublicationRequestedPayload(event.payload);
      if (event.tenantId !== payload.tenantId) {
        throw new PermanentWorkerError(
          "TENANT_SCOPE_MISMATCH",
          "Outbox row and payload tenant differ",
        );
      }

      context = {
        tenantId: payload.tenantId,
        actorId: this.#actorId,
        requestId: `outbox:${event.eventId}`,
      };
      work = (await this.#jobs.load(context, payload.jobId)) ?? undefined;
      if (work === undefined) {
        throw new PermanentWorkerError("PUBLICATION_JOB_NOT_FOUND", "Publication job not found");
      }

      this.#assertWorkMatchesEvent(work, payload);
      connector = this.#getConnector(payload.platform);

      if (work.job.state === "confirmed" || work.job.state === "preview_completed") {
        if (work.existingReceipt === null) {
          throw new PermanentWorkerError(
            "COMPLETED_JOB_WITHOUT_RECEIPT",
            "Completed publication workflow has no immutable receipt",
          );
        }
        const acknowledged = await this.#dispatcher.acknowledge(event.eventId, this.#workerId);
        return { ...EMPTY_OUTCOME, acknowledged: acknowledged ? 1 : 0 };
      }

      if (work.job.state === "uncertain" || work.job.state === "reconciling") {
        if (work.existingReceipt === null) {
          throw new PermanentWorkerError(
            "UNCERTAIN_JOB_WITHOUT_RECEIPT",
            "Uncertain publication requires receipt evidence before reconciliation",
          );
        }
        return this.#reconcileExisting(event, context, work, connector);
      }

      if (
        work.job.state === "needs_review" ||
        work.job.state === "permanent_failure" ||
        work.job.state === "cancelled"
      ) {
        const released = await this.#dispatcher.retry({
          eventId: event.eventId,
          workerId: this.#workerId,
          delaySeconds: 0,
          error: `TERMINAL_JOB_STATE: ${work.job.state}`,
          deadLetter: true,
        });
        return { ...EMPTY_OUTCOME, deadLettered: released ? 1 : 0 };
      }

      if (!work.gate.allowed) {
        throw new RetryableWorkerError(
          "PUBLICATION_GATE_BLOCKED",
          work.gate.reason ?? "Publication is blocked by automation control or circuit breaker",
        );
      }

      this.#assertCapability(work);
      this.#assertPayloadIntegrity(work, payload);

      const startedAt = this.#now();
      const receiptId = this.#idGenerator();
      const renderedDraft = await connector.renderDraft({
        tenantId: context.tenantId,
        channelAccountId: work.account.id,
        executionLevel: work.job.executionLevel,
        variantId: work.variant.id,
        payload: work.variant.payload,
      });
      const submitInput = {
        tenantId: context.tenantId,
        channelAccountId: work.account.id,
        executionLevel: work.job.executionLevel,
        renderedDraft,
        idempotencyKey: work.job.idempotencyKey,
      } as const;
      const preflight = await connector.preflight(submitInput);
      if (!preflight.ok || preflight.externalWriteAllowed) {
        throw new PermanentWorkerError(
          "DRY_RUN_PREFLIGHT_FAILED",
          "Dry-run preflight must pass while keeping external writes disabled",
        );
      }

      const result = await connector.publish({
        ...submitInput,
        receiptId,
        jobId: work.job.id,
        attemptId,
        recordedAt: this.#now().toISOString(),
      });
      const receipt = publicationReceiptSchema.parse(result.receipt);
      this.#assertReceiptScope(receipt, context, work, attemptId);
      const evidence = await connector.captureEvidence({ renderedDraft, receipt });
      const completion = await this.#jobs.complete({
        context,
        jobId: work.job.id,
        attemptId,
        receipt,
        connectorOutcome: result.outcome,
        evidenceHash: evidence.evidenceHash,
        previewHash: evidence.previewHash,
        startedAt,
        finishedAt: this.#now(),
      });
      const acknowledged = await this.#dispatcher.acknowledge(event.eventId, this.#workerId);
      return {
        ...EMPTY_OUTCOME,
        completed: completion.alreadyCompleted ? 0 : 1,
        acknowledged: acknowledged ? 1 : 0,
      };
    } catch (error) {
      if (
        error instanceof UncertainPublicationError &&
        payload !== undefined &&
        work !== undefined &&
        context !== undefined &&
        connector !== undefined
      ) {
        return this.#handleUncertain(event, context, work, connector, attemptId, error);
      }
      return this.#handleFailure(event, context, work, attemptId, classifyFailure(error));
    }
  }

  #getConnector(platform: PublicationRequestedPayload["platform"]): PlatformConnector {
    try {
      return this.#connectors.get(platform);
    } catch (error) {
      throw new PermanentWorkerError("CONNECTOR_NOT_FOUND", errorMessage(error));
    }
  }

  #assertWorkMatchesEvent(work: PublicationWork, payload: PublicationRequestedPayload): void {
    if (
      work.job.id !== payload.jobId ||
      work.job.variantId !== payload.variantId ||
      work.job.channelAccountId !== payload.channelAccountId ||
      work.job.platform !== payload.platform ||
      work.job.executionLevel !== payload.executionLevel ||
      work.job.payloadHash !== payload.payloadHash ||
      work.variant.id !== payload.variantId ||
      work.variant.channelAccountId !== payload.channelAccountId ||
      work.variant.platform !== payload.platform ||
      work.account.id !== payload.channelAccountId ||
      work.account.platform !== payload.platform
    ) {
      throw new PermanentWorkerError(
        "PUBLICATION_SCOPE_MISMATCH",
        "Job, frozen variant, account, and outbox payload are not identically scoped",
      );
    }
  }

  #assertCapability(work: PublicationWork): void {
    if (work.job.executionLevel !== "dry_run") {
      throw new PermanentWorkerError(
        "MVP_DRY_RUN_ONLY",
        "This worker release executes dry-run publication only",
      );
    }
    if (
      work.account.status !== "active" ||
      !work.account.supportedExecutionLevels.includes(work.job.executionLevel) ||
      work.account.capability === "disabled"
    ) {
      throw new PermanentWorkerError(
        "ACCOUNT_CAPABILITY_BLOCKED",
        "Channel account cannot execute the requested dry-run",
      );
    }
  }

  #assertPayloadIntegrity(work: PublicationWork, payload: PublicationRequestedPayload): void {
    if (
      work.variant.state !== "frozen" ||
      work.variant.payloadHash !== payload.payloadHash ||
      stableSha256(work.variant.payload) !== payload.payloadHash
    ) {
      throw new PermanentWorkerError(
        "PAYLOAD_HASH_MISMATCH",
        "Frozen variant payload does not match the audit-bound outbox hash",
      );
    }
  }

  #assertReceiptScope(
    receipt: ReturnType<typeof publicationReceiptSchema.parse>,
    context: TenantContext,
    work: PublicationWork,
    attemptId: string,
  ): void {
    if (
      receipt.tenantId !== context.tenantId ||
      receipt.jobId !== work.job.id ||
      receipt.attemptId !== attemptId ||
      receipt.platform !== work.job.platform ||
      receipt.executionLevel !== "dry_run" ||
      receipt.evidenceType !== "preview" ||
      receipt.confirmed ||
      receipt.externalId !== null ||
      receipt.externalUrl !== null ||
      receipt.publishedAt !== null
    ) {
      throw new PermanentWorkerError(
        "INVALID_DRY_RUN_RECEIPT",
        "Dry-run completion requires an unconfirmed preview receipt with no external publication",
      );
    }
  }

  async #handleUncertain(
    event: ClaimedOutboxEvent,
    context: TenantContext,
    work: PublicationWork,
    connector: PlatformConnector,
    attemptId: string,
    error: UncertainPublicationError,
  ): Promise<EventOutcome> {
    const receipt = publicationReceiptSchema.parse(error.receipt);
    this.#assertReceiptScope(receipt, context, work, attemptId);
    await this.#jobs.recordUncertain({
      context,
      jobId: work.job.id,
      attemptId,
      receipt,
      occurredAt: this.#now(),
      message: error.message,
    });

    let result: ReconcileResult;
    try {
      result = await connector.reconcile({
        tenantId: context.tenantId,
        channelAccountId: work.account.id,
        executionLevel: work.job.executionLevel,
        receipt,
      });
    } catch {
      result = {
        outcome: "manual_confirmation_required",
        confirmed: false,
        externalId: null,
        externalUrl: null,
      };
    }
    await this.#jobs.resolveUncertain({
      context,
      jobId: work.job.id,
      result,
      resolvedAt: this.#now(),
    });

    const deadLetter = result.outcome !== "not_published";
    const released = await this.#dispatcher.retry({
      eventId: event.eventId,
      workerId: this.#workerId,
      delaySeconds: deadLetter ? 0 : this.#retryDelay(event.attempts),
      error: deadLetter ? "UNCERTAIN_REQUIRES_MANUAL_REVIEW" : "RECONCILED_NOT_PUBLISHED",
      deadLetter,
    });
    return {
      ...EMPTY_OUTCOME,
      reconciled: 1,
      retried: !deadLetter && released ? 1 : 0,
      deadLettered: deadLetter && released ? 1 : 0,
    };
  }

  async #reconcileExisting(
    event: ClaimedOutboxEvent,
    context: TenantContext,
    work: PublicationWork,
    connector: PlatformConnector,
  ): Promise<EventOutcome> {
    const receipt = work.existingReceipt;
    if (receipt === null) {
      throw new PermanentWorkerError(
        "UNCERTAIN_JOB_WITHOUT_RECEIPT",
        "Uncertain job cannot reconcile without receipt evidence",
      );
    }
    let result: ReconcileResult;
    try {
      result = await connector.reconcile({
        tenantId: context.tenantId,
        channelAccountId: work.account.id,
        executionLevel: work.job.executionLevel,
        receipt,
      });
      await this.#jobs.resolveUncertain({
        context,
        jobId: work.job.id,
        result,
        resolvedAt: this.#now(),
      });
    } catch (error) {
      const final = event.attempts >= this.#maxAttempts;
      if (final) {
        await this.#jobs.resolveUncertain({
          context,
          jobId: work.job.id,
          result: {
            outcome: "manual_confirmation_required",
            confirmed: false,
            externalId: null,
            externalUrl: null,
          },
          resolvedAt: this.#now(),
        });
      }
      const released = await this.#dispatcher.retry({
        eventId: event.eventId,
        workerId: this.#workerId,
        delaySeconds: final ? 0 : this.#retryDelay(event.attempts),
        error: `RECONCILIATION_FAILED: ${errorMessage(error)}`,
        deadLetter: final,
      });
      return {
        ...EMPTY_OUTCOME,
        retried: !final && released ? 1 : 0,
        deadLettered: final && released ? 1 : 0,
      };
    }
    const deadLetter = result.outcome !== "not_published";
    const released = await this.#dispatcher.retry({
      eventId: event.eventId,
      workerId: this.#workerId,
      delaySeconds: deadLetter ? 0 : this.#retryDelay(event.attempts),
      error: deadLetter ? "UNCERTAIN_REQUIRES_MANUAL_REVIEW" : "RECONCILED_NOT_PUBLISHED",
      deadLetter,
    });
    return {
      ...EMPTY_OUTCOME,
      reconciled: 1,
      retried: !deadLetter && released ? 1 : 0,
      deadLettered: deadLetter && released ? 1 : 0,
    };
  }

  async #handleFailure(
    event: ClaimedOutboxEvent,
    context: TenantContext | undefined,
    work: PublicationWork | undefined,
    attemptId: string,
    failure: WorkerError,
  ): Promise<EventOutcome> {
    const final = failure.disposition === "dead_letter" || event.attempts >= this.#maxAttempts;
    if (context !== undefined && work !== undefined) {
      try {
        await this.#jobs.recordFailure({
          context,
          jobId: work.job.id,
          attemptId,
          code: failure.code,
          message: failure.message,
          final,
          occurredAt: this.#now(),
        });
      } catch (storeError) {
        failure = new RetryableWorkerError(
          "FAILURE_PERSISTENCE_FAILED",
          `${failure.message}; ${errorMessage(storeError)}`,
        );
      }
    }

    const released = await this.#dispatcher.retry({
      eventId: event.eventId,
      workerId: this.#workerId,
      delaySeconds: final ? 0 : this.#retryDelay(event.attempts),
      error: `${failure.code}: ${failure.message}`,
      deadLetter: final,
    });
    return {
      ...EMPTY_OUTCOME,
      retried: !final && released ? 1 : 0,
      deadLettered: final && released ? 1 : 0,
    };
  }

  #retryDelay(attempts: number): number {
    return Math.min(this.#retryMaxSeconds, this.#retryBaseSeconds * 2 ** Math.max(0, attempts - 1));
  }
}
