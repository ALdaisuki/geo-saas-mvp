import type { AutomationRunTargetState, Platform } from "@geo/contracts";

export interface AutomationToolRuntime {
  invoke(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ScheduledAutomationTarget {
  readonly targetId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly state?: AutomationRunTargetState;
  readonly variantId?: string;
  readonly auditRunId?: string;
  readonly auditArtifactId?: string;
  readonly publicationJobId?: string;
  readonly errorCode?: string;
}

export interface ScheduledAutomationRunInput {
  readonly tenantId: string;
  readonly brandId: string;
  readonly campaignId: string;
  readonly runId: string;
  readonly topic: string;
  readonly targets: readonly ScheduledAutomationTarget[];
  readonly contentItemId?: string;
  readonly contentVersionId?: string;
}

export type ScheduledAutomationCheckpoint =
  | {
      readonly stage: "draft";
      readonly contentItemId: string;
      readonly contentVersionId: string;
    }
  | {
      readonly stage: "target";
      readonly targetId: string;
      readonly state: Extract<
        AutomationRunTargetState,
        "variant_ready" | "audit_failed" | "awaiting_delivery" | "failed"
      >;
      readonly variantId?: string;
      readonly auditRunId?: string;
      readonly auditArtifactId?: string;
      readonly publicationJobId?: string;
      readonly errorCode?: string;
    };

export interface ScheduledAutomationTargetResult {
  readonly targetId: string;
  readonly state: Exclude<AutomationRunTargetState, "pending" | "variant_ready">;
  readonly variantId?: string;
  readonly auditRunId?: string;
  readonly auditArtifactId?: string;
  readonly publicationJobId?: string;
  readonly errorCode?: string;
}

export interface ScheduledAutomationRunResult {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly targets: readonly ScheduledAutomationTargetResult[];
}

function record(value: unknown, step: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Automation ${step} returned an invalid result`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Automation result is missing ${field}`);
  }
  return value;
}

function persistedString(value: string | undefined, field: string): string {
  return stringField(value, field);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 100);
  }
  return "AUTOMATION_TARGET_FAILED";
}

function retryableTargetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly retryable?: unknown;
    readonly uncertain?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  if (
    candidate.name === "AbortError" ||
    candidate.retryable === true ||
    candidate.uncertain === true
  ) {
    return true;
  }
  const status = candidate.statusCode ?? candidate.status;
  return typeof status === "number" && (status >= 500 || [408, 409, 425, 429].includes(status));
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Automation run was aborted");
}

class AutomationCheckpointError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Automation checkpoint failed");
    this.name = "AutomationCheckpointError";
    this.cause = cause;
  }
}

export class ScheduledAutomationRuntime {
  readonly #runtime: AutomationToolRuntime;

  constructor(runtime: AutomationToolRuntime) {
    this.#runtime = runtime;
  }

  async run(
    input: ScheduledAutomationRunInput,
    checkpoint: (checkpoint: ScheduledAutomationCheckpoint) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ScheduledAutomationRunResult> {
    const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      aborted(signal);
      const result = await this.#runtime.invoke(name, args);
      aborted(signal);
      return result;
    };
    const persistCheckpoint = async (value: ScheduledAutomationCheckpoint): Promise<void> => {
      try {
        await checkpoint(value);
      } catch (error) {
        throw new AutomationCheckpointError(error);
      }
    };

    if ((input.contentItemId === undefined) !== (input.contentVersionId === undefined)) {
      throw new Error("Automation resume requires both contentItemId and contentVersionId");
    }

    await invoke("plastic_context_supply", {
      tenantId: input.tenantId,
      taskDescription: `Create a governed automation draft about ${input.topic}`,
      taskType: "content_drafting",
    });
    await invoke("geo_tenant_context", { tenantId: input.tenantId });
    await invoke("geo_fact_lookup", {
      tenantId: input.tenantId,
      brandId: input.brandId,
      query: input.topic,
      limit: 10,
    });
    let contentItemId = input.contentItemId;
    let contentVersionId = input.contentVersionId;
    if (contentItemId === undefined || contentVersionId === undefined) {
      const draft = record(
        await invoke("geo_draft_proposal", {
          tenantId: input.tenantId,
          brandId: input.brandId,
          campaignId: input.campaignId,
          brief: input.topic,
          idempotencyKey: `automation:${input.runId}:draft:v1`,
        }),
        "draft",
      );
      contentItemId = stringField(draft.contentItemId, "contentItemId");
      contentVersionId = stringField(draft.contentVersionId, "contentVersionId");
      await persistCheckpoint({ stage: "draft", contentItemId, contentVersionId });
    }

    const results: ScheduledAutomationTargetResult[] = [];
    for (const target of input.targets) {
      aborted(signal);
      const persistedState = target.state ?? "pending";
      if (!["pending", "variant_ready"].includes(persistedState)) {
        results.push({
          targetId: target.targetId,
          state: persistedState as Exclude<AutomationRunTargetState, "pending" | "variant_ready">,
          ...(target.variantId === undefined ? {} : { variantId: target.variantId }),
          ...(target.auditRunId === undefined ? {} : { auditRunId: target.auditRunId }),
          ...(target.auditArtifactId === undefined
            ? {}
            : { auditArtifactId: target.auditArtifactId }),
          ...(target.publicationJobId === undefined
            ? {}
            : { publicationJobId: target.publicationJobId }),
          ...(target.errorCode === undefined ? {} : { errorCode: target.errorCode }),
        });
        continue;
      }

      let variantId = target.variantId;
      let auditRunId: string | undefined;
      let auditArtifactId: string | undefined;
      try {
        if (persistedState === "pending") {
          const preview = record(
            await invoke("geo_variant_preview", {
              tenantId: input.tenantId,
              contentVersionId,
              channelAccountId: target.channelAccountId,
              platform: target.platform,
            }),
            "variant preview",
          );
          variantId = stringField(preview.variantId, "variantId");
          await persistCheckpoint({
            stage: "target",
            targetId: target.targetId,
            state: "variant_ready",
            variantId,
          });
        } else {
          variantId = persistedString(variantId, "variantId");
        }

        const audit = record(
          await invoke("geo_audit_request", {
            tenantId: input.tenantId,
            variantId,
            idempotencyKey: `automation:${input.runId}:target:${target.targetId}:audit:v1`,
          }),
          "audit",
        );
        auditRunId = stringField(audit.auditRunId, "auditRunId");
        auditArtifactId = stringField(audit.auditArtifactId, "auditArtifactId");
        if (audit.status !== "passed") {
          const result = {
            targetId: target.targetId,
            state: "audit_failed" as const,
            variantId,
            auditRunId,
            auditArtifactId,
            errorCode: "AUTOMATION_AUDIT_FAILED",
          };
          await persistCheckpoint({ stage: "target", ...result });
          results.push(result);
          continue;
        }

        const publication = record(
          await invoke("geo_publication_request", {
            tenantId: input.tenantId,
            variantId,
            channelAccountId: target.channelAccountId,
            executionLevel: "dry_run",
            idempotencyKey: `automation:${input.runId}:target:${target.targetId}:publication:v1`,
          }),
          "publication",
        );
        const publicationJobId = stringField(
          publication.publicationJobId ?? publication.publicationRequestId,
          "publicationJobId",
        );
        const result = {
          targetId: target.targetId,
          state: "awaiting_delivery" as const,
          variantId,
          auditRunId,
          auditArtifactId,
          publicationJobId,
        };
        await persistCheckpoint({ stage: "target", ...result });
        results.push(result);
      } catch (error) {
        if (error instanceof AutomationCheckpointError) throw error.cause;
        aborted(signal);
        if (retryableTargetError(error)) throw error;
        const result = {
          targetId: target.targetId,
          state: "failed" as const,
          ...(variantId === undefined ? {} : { variantId }),
          ...(auditRunId === undefined ? {} : { auditRunId }),
          ...(auditArtifactId === undefined ? {} : { auditArtifactId }),
          errorCode: errorCode(error),
        };
        await persistCheckpoint({ stage: "target", ...result });
        results.push(result);
      }
    }

    return { contentItemId, contentVersionId, targets: results };
  }
}
