import type {
  AutomationBatchState,
  AutomationRunStage,
  AutomationRunState,
  AutomationRunTargetState,
  Platform,
} from "@geo/contracts";

import type { RequestContext } from "./repository.js";

export interface AutomationBatchView {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string | null;
  readonly state: AutomationBatchState;
  readonly executionLevel: "dry_run";
  readonly scheduledFor: string;
  readonly runCount: number;
  readonly completedRunCount: number;
  readonly failedRunCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunTargetView {
  readonly id: string;
  readonly runId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly state: AutomationRunTargetState;
  readonly variantId: string | null;
  readonly auditRunId: string | null;
  readonly auditArtifactId: string | null;
  readonly publicationJobId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunView {
  readonly id: string;
  readonly batchId: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly slotKey: string;
  readonly topicKey: string;
  readonly brief: string;
  readonly state: AutomationRunState;
  readonly stage: AutomationRunStage;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targets: readonly AutomationRunTargetView[];
}

export interface AutomationRunLease extends AutomationRunView {
  readonly tenantGate: {
    readonly allowed: true;
    readonly evaluatedAt: string;
  };
}

export interface CreateAutomationBatchInput {
  readonly batchId: string;
  readonly campaignId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly name: string | null;
  readonly runs: readonly {
    readonly runId: string;
    readonly slotKey: string;
    readonly topicKey: string;
    readonly brief: string;
    readonly availableAt: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly targets: readonly {
      readonly targetId: string;
      readonly channelAccountId: string;
      readonly variantIdempotencyKey: string;
      readonly auditIdempotencyKey: string;
      readonly publicationIdempotencyKey: string;
    }[];
  }[];
}

export interface AutomationBatchListInput {
  readonly limit: number;
  readonly before?: string;
  readonly state?: AutomationBatchState;
  readonly campaignId?: string;
}

export interface AutomationRunListInput {
  readonly limit: number;
  readonly before?: string;
  readonly state?: AutomationRunState;
  readonly batchId?: string;
}

export interface ClaimAutomationRunsInput {
  readonly workerId: string;
  readonly limit: number;
  readonly leaseSeconds: number;
}

export interface HeartbeatAutomationRunInput {
  readonly runId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly stage: AutomationRunStage;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly leaseSeconds: number;
}

export interface CheckpointAutomationDraftInput {
  readonly runId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly leaseSeconds: number;
}

export interface CheckpointAutomationTargetInput {
  readonly runId: string;
  readonly targetId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly state: Exclude<AutomationRunTargetState, "pending" | "cancelled">;
  readonly variantId: string | null;
  readonly auditRunId: string | null;
  readonly auditArtifactId: string | null;
  readonly publicationJobId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly leaseSeconds: number;
}

export interface ReconcileAutomationRunInput {
  readonly runId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly retryAfterSeconds: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface AutomationLeaseMutationResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly leaseExpiresAt: string | null;
}

export interface AutomationBatchCancellationResult {
  readonly batchId: string;
  readonly state: AutomationBatchState;
  readonly cancelledRuns: number;
  readonly cancelledTargets: number;
  readonly wasChanged: boolean;
}

export interface AutomationRepository {
  createAutomationBatch(
    context: RequestContext,
    input: CreateAutomationBatchInput,
  ): Promise<{ readonly batch: AutomationBatchView; readonly wasCreated: boolean }>;
  listAutomationBatches(
    context: RequestContext,
    input: AutomationBatchListInput,
  ): Promise<readonly AutomationBatchView[]>;
  getAutomationRun(context: RequestContext, runId: string): Promise<AutomationRunView | null>;
  listAutomationRuns(
    context: RequestContext,
    input: AutomationRunListInput,
  ): Promise<readonly AutomationRunView[]>;
  claimAutomationRuns(
    context: RequestContext,
    input: ClaimAutomationRunsInput,
  ): Promise<readonly AutomationRunLease[]>;
  heartbeatAutomationRun(
    context: RequestContext,
    input: HeartbeatAutomationRunInput,
  ): Promise<AutomationLeaseMutationResult>;
  checkpointAutomationDraft(
    context: RequestContext,
    input: CheckpointAutomationDraftInput,
  ): Promise<AutomationLeaseMutationResult>;
  checkpointAutomationTarget(
    context: RequestContext,
    input: CheckpointAutomationTargetInput,
  ): Promise<AutomationLeaseMutationResult>;
  reconcileAutomationRun(
    context: RequestContext,
    input: ReconcileAutomationRunInput,
  ): Promise<AutomationRunView>;
  cancelAutomationBatch(
    context: RequestContext,
    batchId: string,
    reason: string,
  ): Promise<AutomationBatchCancellationResult>;
}
