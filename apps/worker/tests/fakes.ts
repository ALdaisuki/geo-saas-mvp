import type {
  AcquirePublicationExecutionInput,
  AcquirePublicationExecutionResult,
  CompletePublicationInput,
  CompletePublicationResult,
  ClaimedOutboxEvent,
  ClaimOptions,
  CreateAssistedHandoffInput,
  CreateAssistedHandoffResult,
  DispatcherStore,
  PublicationWork,
  RecordFailureInput,
  RecordReconciliationFailureInput,
  RecordUncertainInput,
  ResolveUncertainInput,
  RetryOptions,
  TenantContext,
  TenantJobStore,
} from "../src/types.js";

export class FakeDispatcherStore implements DispatcherStore {
  readonly events: ClaimedOutboxEvent[];
  readonly acknowledged: string[] = [];
  readonly retries: RetryOptions[] = [];
  readonly #claimed = new Set<string>();

  constructor(events: readonly ClaimedOutboxEvent[]) {
    this.events = [...events];
  }

  async claim(options: ClaimOptions): Promise<readonly ClaimedOutboxEvent[]> {
    const result: ClaimedOutboxEvent[] = [];
    for (const event of this.events) {
      if (result.length >= options.limit) break;
      if (!this.#claimed.has(event.eventId)) {
        this.#claimed.add(event.eventId);
        result.push(event);
      }
    }
    return result;
  }

  async acknowledge(eventId: string): Promise<boolean> {
    this.acknowledged.push(eventId);
    return true;
  }

  async retry(options: RetryOptions): Promise<boolean> {
    this.retries.push(options);
    return true;
  }
}

export class FakeTenantJobStore implements TenantJobStore {
  readonly works = new Map<string, PublicationWork>();
  readonly acquisitions: AcquirePublicationExecutionInput[] = [];
  acquisitionResult: AcquirePublicationExecutionResult = {
    allowed: true,
    reason: null,
    halfOpenProbe: false,
  };
  readonly completions: CompletePublicationInput[] = [];
  readonly assistedHandoffs: CreateAssistedHandoffInput[] = [];
  assistedHandoffResponseError: Error | null = null;
  readonly failures: RecordFailureInput[] = [];
  failureError: Error | null = null;
  readonly reconciliationFailures: RecordReconciliationFailureInput[] = [];
  readonly uncertainties: RecordUncertainInput[] = [];
  readonly resolutions: ResolveUncertainInput[] = [];

  async load(_context: TenantContext, jobId: string): Promise<PublicationWork | null> {
    return this.works.get(jobId) ?? null;
  }

  async acquirePublicationExecution(
    input: AcquirePublicationExecutionInput,
  ): Promise<AcquirePublicationExecutionResult> {
    this.acquisitions.push(input);
    if (this.acquisitionResult.allowed) {
      const work = this.works.get(input.jobId);
      if (work !== undefined) work.job.state = "dispatching";
    }
    return this.acquisitionResult;
  }

  async complete(input: CompletePublicationInput): Promise<CompletePublicationResult> {
    const work = this.works.get(input.jobId);
    if (work?.existingReceipt !== null && work?.existingReceipt !== undefined) {
      return { alreadyCompleted: true, receipt: work.existingReceipt };
    }
    this.completions.push(input);
    if (work !== undefined) {
      work.job.state = "preview_completed";
      work.existingReceipt = input.receipt;
    }
    return { alreadyCompleted: false, receipt: input.receipt };
  }

  async createAssistedHandoff(
    input: CreateAssistedHandoffInput,
  ): Promise<CreateAssistedHandoffResult> {
    this.assistedHandoffs.push(input);
    const work = this.works.get(input.jobId);
    if (work !== undefined) {
      work.assistedHandoff = {
        id: input.handoffId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        bridgePrincipalId: input.bridgePrincipalId,
        channelAccountId: work.account.id,
        variantId: work.variant.id,
        platform: "ctrip_community",
        payloadHash: work.job.payloadHash,
        auditHash: work.authorization.auditHash,
        previewHash: input.previewHash,
        adapterVersion: input.adapterVersion,
        expiresAt: input.expiresAt.toISOString(),
      };
    }
    if (this.assistedHandoffResponseError !== null) {
      throw this.assistedHandoffResponseError;
    }
    return { handoffId: input.handoffId, wasCreated: true };
  }

  async recordFailure(input: RecordFailureInput): Promise<void> {
    if (this.failureError !== null) throw this.failureError;
    const work = this.works.get(input.jobId);
    if (work?.assistedHandoff?.attemptId === input.attemptId) return;
    this.failures.push(input);
    if (work !== undefined) {
      work.job.state = input.final
        ? input.code === "PUBLICATION_AUTHORIZATION_INVALID" || input.reviewAfter === true
          ? "needs_review"
          : "permanent_failure"
        : "retry_wait";
    }
  }

  async recordReconciliationFailure(input: RecordReconciliationFailureInput): Promise<void> {
    this.reconciliationFailures.push(input);
  }

  async recordUncertain(input: RecordUncertainInput): Promise<void> {
    this.uncertainties.push(input);
    const work = this.works.get(input.jobId);
    if (work !== undefined) work.job.state = "uncertain";
  }

  async resolveUncertain(input: ResolveUncertainInput): Promise<void> {
    this.resolutions.push(input);
    const work = this.works.get(input.jobId);
    if (work !== undefined) {
      work.job.state = input.result.outcome === "not_published" ? "retry_wait" : "needs_review";
    }
  }
}
