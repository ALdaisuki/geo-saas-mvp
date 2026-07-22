import type {
  ActorContext,
  AutomationRunStage,
  AutomationRunState,
  AutomationRunTargetState,
  ExecutionLevel,
  Platform,
  PublicationJobState,
} from "@geo/contracts";

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
  readonly executionLevel: ExecutionLevel;
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

export interface AutomationLeaseMutationResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly leaseExpiresAt: string | null;
}

export interface AutomationPublicationJobView {
  readonly id: string;
  readonly auditArtifactId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly executionLevel: "dry_run" | "assisted" | "unattended";
  readonly state: PublicationJobState;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

export interface AutomationGeoApiClient {
  claimAutomationRuns(
    principal: Readonly<ActorContext>,
    input: {
      readonly producerId: string;
      readonly limit: number;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly AutomationRunLease[]>;
  getAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    signal?: AbortSignal,
  ): Promise<AutomationRunView>;
  heartbeatAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly stage: AutomationRunStage;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult>;
  checkpointAutomationDraft(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult>;
  checkpointAutomationTarget(
    principal: Readonly<ActorContext>,
    runId: string,
    targetId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly state: Exclude<AutomationRunTargetState, "pending" | "cancelled">;
      readonly variantId?: string;
      readonly auditRunId?: string;
      readonly auditArtifactId?: string;
      readonly publicationJobId?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly checkpoint: Readonly<Record<string, unknown>>;
      readonly leaseSeconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationLeaseMutationResult>;
  reconcileAutomationRun(
    principal: Readonly<ActorContext>,
    runId: string,
    input: {
      readonly producerId: string;
      readonly attempt: number;
      readonly retryAfter?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<AutomationRunView>;
  getAutomationPublicationJob(
    principal: Readonly<ActorContext>,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<AutomationPublicationJobView>;
}
