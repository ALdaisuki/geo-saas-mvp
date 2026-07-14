import { ConnectorPolicyError } from "@geo/connectors";
import type { PublicationReceipt } from "@geo/contracts";

export type FailureDisposition = "retry" | "dead_letter";

export class WorkerError extends Error {
  readonly code: string;
  readonly disposition: FailureDisposition;

  constructor(code: string, message: string, disposition: FailureDisposition) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.disposition = disposition;
  }
}

export class RetryableWorkerError extends WorkerError {
  constructor(code: string, message: string) {
    super(code, message, "retry");
    this.name = "RetryableWorkerError";
  }
}

export class PermanentWorkerError extends WorkerError {
  constructor(code: string, message: string) {
    super(code, message, "dead_letter");
    this.name = "PermanentWorkerError";
  }
}

export class UncertainPublicationError extends Error {
  readonly receipt: PublicationReceipt;

  constructor(message: string, receipt: PublicationReceipt) {
    super(message);
    this.name = "UncertainPublicationError";
    this.receipt = receipt;
  }
}

export function classifyFailure(error: unknown): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }
  if (error instanceof ConnectorPolicyError) {
    return new PermanentWorkerError(error.code, error.message);
  }
  if (error instanceof Error) {
    return new RetryableWorkerError("UNEXPECTED_ERROR", error.message);
  }
  return new RetryableWorkerError("UNEXPECTED_ERROR", "Unknown worker failure");
}
