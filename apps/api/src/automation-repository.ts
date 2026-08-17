import type {
  AutomationBatchState,
  AutomationPlatform,
  AutomationRunStage,
  AutomationRunState,
  AutomationRunTargetState,
  AutomationDistribution,
  AutomationManualRemediationAction,
  ExecutionLevel,
} from "@geo/contracts";

import type { RequestContext } from "./repository.js";

export interface AutomationBatchView {
  readonly id: string;
  readonly campaignId: string;
  readonly name: string | null;
  readonly state: AutomationBatchState;
  readonly executionLevel: ExecutionLevel;
  /** Immutable snapshot of the originating campaign setting. */
  readonly automationRemediationEnabled?: boolean;
  readonly scheduledFor: string;
  readonly runCount: number;
  readonly completedRunCount: number;
  readonly failedRunCount: number;
  readonly deliveryFailedRunCount: number;
  readonly cancelledRunCount: number;
  readonly terminalRunCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunTargetView {
  readonly id: string;
  readonly runId: string;
  readonly channelAccountId: string;
  readonly platform: AutomationPlatform;
  readonly state: AutomationRunTargetState;
  readonly variantId: string | null;
  readonly auditRunId: string | null;
  readonly auditArtifactId: string | null;
  readonly publicationJobId: string | null;
  readonly externalUrl: string | null;
  readonly remediation: Readonly<Record<string, unknown>> | null;
  readonly checkpoint: Readonly<Record<string, unknown>>;
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
  readonly executionLevel: ExecutionLevel;
  /** Immutable batch-level remediation setting consumed by the producer. */
  readonly automationRemediationEnabled?: boolean;
  readonly slotKey: string;
  readonly topicKey: string;
  readonly brief: string;
  readonly diversityRotationIndex: number;
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
  readonly executionLevel: ExecutionLevel;
  readonly distribution?: AutomationDistribution;
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
      readonly channelAccountId: string | null;
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

export interface CampaignAutomationPlanView {
  readonly id: string;
  readonly campaignId: string;
  readonly actorId: string;
  readonly enabled: boolean;
  readonly executionLevel: "dry_run" | "unattended";
  readonly platforms: readonly AutomationPlatform[];
  readonly slotCount: number;
  readonly intervalMinutes: number;
  readonly dailyTimes: readonly string[];
  readonly timezone: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly runCount: number;
  readonly campaignName: string;
  readonly campaignTopicKey: string;
  readonly campaignObjective: string;
  readonly campaignPromptTemplate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveCampaignAutomationPlanInput {
  readonly actorId: string;
  readonly enabled: boolean;
  readonly executionLevel: "dry_run" | "unattended";
  readonly platforms: readonly AutomationPlatform[];
  readonly slotCount: number;
  readonly intervalMinutes: number;
  readonly dailyTimes: readonly string[];
  readonly timezone: string;
  readonly nextRunAt: string | null;
}

export interface DueCampaignAutomationPlanView {
  readonly tenantId: string;
  readonly planId: string;
  readonly campaignId: string;
  readonly actorId: string;
  readonly executionLevel: "dry_run" | "unattended";
  readonly platforms: readonly AutomationPlatform[];
  readonly slotCount: number;
  readonly intervalMinutes: number;
  readonly dailyTimes: readonly string[];
  readonly timezone: string;
  readonly nextRunAt: string;
  readonly campaignName: string;
  readonly campaignTopicKey: string;
  readonly campaignObjective: string;
  readonly campaignPromptTemplate: string | null;
}

export interface UpdateCampaignAutomationPlanScheduleInput {
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
  readonly lastErrorAt?: string | null;
  readonly lastErrorCode?: string | null;
  readonly lastErrorMessage?: string | null;
  readonly incrementRunCount?: boolean;
}

export interface ReassignAutomationTargetInput {
  readonly runId: string;
  readonly targetId: string;
  readonly channelAccountId: string;
}

export interface RestartAutomationTargetRemediationInput {
  readonly runId: string;
  readonly targetId: string;
  readonly actions: readonly AutomationManualRemediationAction[];
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
  reassignAutomationTarget(
    context: RequestContext,
    input: ReassignAutomationTargetInput,
  ): Promise<AutomationRunView>;
  restartAutomationTargetRemediation(
    context: RequestContext,
    input: RestartAutomationTargetRemediationInput,
  ): Promise<AutomationRunView>;
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
  getCampaignAutomationPlan(
    context: RequestContext,
    campaignId: string,
  ): Promise<CampaignAutomationPlanView | null>;
  saveCampaignAutomationPlan(
    context: RequestContext,
    campaignId: string,
    input: SaveCampaignAutomationPlanInput,
  ): Promise<CampaignAutomationPlanView>;
  updateCampaignAutomationPlanSchedule(
    context: RequestContext,
    planId: string,
    input: UpdateCampaignAutomationPlanScheduleInput,
  ): Promise<CampaignAutomationPlanView>;
  listDueCampaignAutomationPlans(now: string): Promise<readonly DueCampaignAutomationPlanView[]>;
}
