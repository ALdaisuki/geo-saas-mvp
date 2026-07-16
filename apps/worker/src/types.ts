import type { PlatformConnector, ReconcileResult } from "@geo/connectors";
import type {
  ConnectorCapability,
  ExecutionLevel,
  Platform,
  PublicationReceipt,
  PublicationVariantPayload,
} from "@geo/contracts";

export interface PublicationRequestedPayload {
  tenantId: string;
  jobId: string;
  variantId: string;
  channelAccountId: string;
  platform: Platform;
  executionLevel: ExecutionLevel;
  payloadHash: string;
}

export interface ClaimedOutboxEvent {
  tenantId: string;
  eventId: string;
  topic: string;
  payload: unknown;
  attempts: number;
  lockedUntil: Date;
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}

export interface RetryOptions {
  eventId: string;
  workerId: string;
  delaySeconds: number;
  error: string;
  deadLetter: boolean;
}

export interface DispatcherStore {
  claim(options: ClaimOptions): Promise<readonly ClaimedOutboxEvent[]>;
  acknowledge(eventId: string, workerId: string): Promise<boolean>;
  retry(options: RetryOptions): Promise<boolean>;
}

export interface TenantContext {
  tenantId: string;
  actorId: string;
  requestId: string;
}

export interface PublicationWork {
  job: {
    id: string;
    state:
      | "queued"
      | "dispatching"
      | "retry_wait"
      | "uncertain"
      | "reconciling"
      | "preview_completed"
      | "confirmed"
      | "needs_review"
      | "permanent_failure"
      | "cancelled";
    platform: Platform;
    executionLevel: ExecutionLevel;
    idempotencyKey: string;
    requestHash: string;
    payloadHash: string;
    variantId: string;
    channelAccountId: string;
  };
  variant: {
    id: string;
    state: "draft" | "frozen" | "superseded";
    payload: PublicationVariantPayload;
    payloadHash: string;
    platform: Platform;
    channelAccountId: string;
  };
  account: {
    id: string;
    platform: Platform;
    capability: ConnectorCapability;
    supportedExecutionLevels: readonly ExecutionLevel[];
    status: "active" | "disabled" | "needs_verification";
  };
  authorization: {
    auditHash: string;
    grantExpiresAt: string;
    artifactExpiresAt: string;
  };
  assistedHandoff: {
    id: string;
    jobId: string;
    attemptId: string;
    bridgePrincipalId: string;
    channelAccountId: string;
    variantId: string;
    platform: "ctrip_community";
    payloadHash: string;
    auditHash: string;
    previewHash: string;
    adapterVersion: string;
    expiresAt: string;
  } | null;
  gate: {
    allowed: boolean;
    reason: string | null;
  };
  existingReceipt: PublicationReceipt | null;
}

export interface AcquirePublicationExecutionInput {
  context: TenantContext;
  jobId: string;
  attemptId: string;
  workerId: string;
}

export interface AcquirePublicationExecutionResult {
  allowed: boolean;
  reason: string | null;
  halfOpenProbe: boolean;
}

export interface CompletePublicationInput {
  context: TenantContext;
  jobId: string;
  attemptId: string;
  receipt: PublicationReceipt;
  connectorOutcome: "preview_only" | "manual_action_required";
  evidenceHash: string;
  previewHash: string;
  startedAt: Date;
  finishedAt: Date;
}

export interface CompletePublicationResult {
  alreadyCompleted: boolean;
  receipt: PublicationReceipt;
}

export interface CreateAssistedHandoffInput {
  context: TenantContext;
  handoffId: string;
  jobId: string;
  attemptId: string;
  bridgePrincipalId: string;
  previewHash: string;
  adapterVersion: string;
  idempotencyKey: string;
  expiresAt: Date;
}

export interface CreateAssistedHandoffResult {
  handoffId: string;
  wasCreated: boolean;
}

export interface RecordFailureInput {
  context: TenantContext;
  jobId: string;
  attemptId: string;
  code: string;
  message: string;
  final: boolean;
  occurredAt: Date;
}

export interface RecordUncertainInput {
  context: TenantContext;
  jobId: string;
  attemptId: string;
  receipt: PublicationReceipt;
  occurredAt: Date;
  message: string;
}

export interface RecordReconciliationFailureInput {
  context: TenantContext;
  jobId: string;
  attemptId: string;
  receiptId: string;
  requestHash: string;
  responseHash: string;
  code: "RECONCILIATION_FAILED";
  occurredAt: Date;
}

export interface ResolveUncertainInput {
  context: TenantContext;
  jobId: string;
  result: ReconcileResult;
  resolvedAt: Date;
}

export interface TenantJobStore {
  load(context: TenantContext, jobId: string): Promise<PublicationWork | null>;
  acquirePublicationExecution(
    input: AcquirePublicationExecutionInput,
  ): Promise<AcquirePublicationExecutionResult>;
  createAssistedHandoff(input: CreateAssistedHandoffInput): Promise<CreateAssistedHandoffResult>;
  complete(input: CompletePublicationInput): Promise<CompletePublicationResult>;
  recordFailure(input: RecordFailureInput): Promise<void>;
  recordReconciliationFailure(input: RecordReconciliationFailureInput): Promise<void>;
  recordUncertain(input: RecordUncertainInput): Promise<void>;
  resolveUncertain(input: ResolveUncertainInput): Promise<void>;
}

export interface ConnectorResolver {
  get(platform: Platform): PlatformConnector;
}

export interface RunSummary {
  claimed: number;
  handedOff: number;
  completed: number;
  acknowledged: number;
  retried: number;
  deadLettered: number;
  reconciled: number;
}
