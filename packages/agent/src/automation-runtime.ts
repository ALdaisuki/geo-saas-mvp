import {
  idSchema,
  type AutomationPlatform,
  type AutomationRunTargetState,
  type ExecutionLevel,
  type LicensedImageSearchProviderId,
} from "@geo/contracts";

export interface AutomationToolRuntime {
  invoke(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ScheduledAutomationRuntimeOptions {
  readonly mediaRetryAttempts?: number;
  readonly mediaRetryDelayMs?: number;
  readonly contentRemediationAttempts?: number;
  /** Maximum number of distinct channel accounts processed concurrently. */
  readonly targetConcurrency?: number;
  /** Bounded target-local retries for temporary resource contention. */
  readonly resourceConflictRetryAttempts?: number;
  readonly resourceConflictRetryDelayMs?: number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export const AUTOMATION_REMEDIATION_ACTIONS = [
  "change_diversity_blueprint",
  "rebuild_article",
  "restructure_article",
  "soften_promotion",
  "replace_media",
  "reformat_for_platform",
  "remove_off_platform_contact",
  "provide_verified_evidence",
  "manual_review",
] as const;

export type AutomationRemediationAction = (typeof AUTOMATION_REMEDIATION_ACTIONS)[number];

export interface AutomationRemediationPlan {
  readonly taskId: string;
  readonly scope: "target";
  readonly mode: "automatic" | "manual";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reasonCodes: readonly string[];
  readonly actions: readonly AutomationRemediationAction[];
}

export function parseAutomationRemediationPlan(value: unknown): AutomationRemediationPlan | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  const scope = record.scope === "target" ? "target" : null;
  const mode = record.mode === "manual" ? "manual" : "automatic";
  const attempt = typeof record.attempt === "number" ? record.attempt : 0;
  const maxAttempts = typeof record.maxAttempts === "number" ? record.maxAttempts : 0;
  const reasonCodes = Array.isArray(record.reasonCodes)
    ? record.reasonCodes.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  const actionSet = new Set<string>(AUTOMATION_REMEDIATION_ACTIONS);
  const actions = Array.isArray(record.actions)
    ? record.actions.filter(
        (item): item is AutomationRemediationAction =>
          typeof item === "string" && actionSet.has(item),
      )
    : [];
  if (
    taskId.length === 0 ||
    scope === null ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 0 ||
    reasonCodes.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    taskId,
    scope,
    mode,
    attempt,
    maxAttempts,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    actions: Object.freeze([...new Set(actions)]),
  });
}

export interface AutomationDraftTrace {
  readonly providerMode: "pi_authored";
  readonly provider: string;
  readonly model: string;
  readonly providerRunId: string;
  readonly providerRequestId: string | null;
}

export function parseAutomationDraftTrace(value: unknown): AutomationDraftTrace | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const providerRunId = typeof record.providerRunId === "string" ? record.providerRunId.trim() : "";
  const runId = idSchema.safeParse(providerRunId);
  const requestIdValue = record.providerRequestId;
  const providerRequestId =
    typeof requestIdValue === "string" ? requestIdValue.trim() : requestIdValue;
  if (
    record.providerMode !== "pi_authored" ||
    provider.length === 0 ||
    provider.length > 200 ||
    model.length === 0 ||
    model.length > 200 ||
    !runId.success ||
    (providerRequestId !== null &&
      (typeof providerRequestId !== "string" ||
        providerRequestId.length === 0 ||
        providerRequestId.length > 1_000))
  ) {
    return null;
  }
  return Object.freeze({
    providerMode: "pi_authored",
    provider,
    model,
    providerRunId: runId.data,
    providerRequestId,
  });
}

export interface AutomationDraftAuthor {
  author(
    input: Readonly<{
      tenantId: string;
      brandId: string;
      campaignId: string;
      targetPlatform: AutomationPlatform;
      brief: string;
      idempotencyKey: string;
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ contentItemId: string; contentVersionId: string } & AutomationDraftTrace>>;
  /** Create one alternate source draft after a deterministic duplicate audit finding. */
  authorAlternate?(
    input: Readonly<{
      tenantId: string;
      brandId: string;
      campaignId: string;
      targetPlatform: AutomationPlatform;
      brief: string;
      idempotencyKey: string;
      remediation: Readonly<AutomationRemediationPlan>;
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ contentItemId: string; contentVersionId: string } & AutomationDraftTrace>>;
}

export interface ScheduledAutomationTarget {
  readonly targetId: string;
  readonly channelAccountId: string;
  readonly platform: AutomationPlatform;
  readonly state?: AutomationRunTargetState;
  readonly variantId?: string;
  readonly auditRunId?: string;
  readonly auditArtifactId?: string;
  readonly publicationJobId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly remediation?: Readonly<AutomationRemediationPlan>;
}

export interface ScheduledAutomationRunInput {
  readonly tenantId: string;
  readonly brandId: string;
  readonly campaignId: string;
  readonly runId: string;
  readonly executionLevel: ExecutionLevel;
  readonly topic: string;
  readonly targets: readonly ScheduledAutomationTarget[];
  readonly contentItemId?: string;
  readonly contentVersionId?: string;
  readonly draftTrace?: Readonly<AutomationDraftTrace>;
  /** Legacy flag: true when the persisted content version contains the Ctrip media set. */
  readonly mediaSearchCompleted?: boolean;
  /** Platforms whose complete searched media set is already present on the persisted version. */
  readonly mediaSearchCompletedPlatforms?: readonly AutomationPlatform[];
}

export type ScheduledAutomationCheckpoint =
  | {
      readonly stage: "draft";
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly articleTemplateId?: string;
      readonly providerMode?: "pi_authored";
      readonly draftTrace?: Readonly<AutomationDraftTrace>;
    }
  | {
      readonly stage: "media";
      readonly contentItemId: string;
      readonly sourceContentVersionId: string;
      readonly contentVersionId: string;
      readonly provider: LicensedImageSearchProviderId;
      readonly platform: AutomationPlatform;
      readonly mediaCount: number;
      readonly mediaComplete: boolean;
      readonly completedPlatforms: readonly AutomationPlatform[];
      readonly providerMode?: "pi_authored";
      readonly draftTrace?: Readonly<AutomationDraftTrace>;
    }
  | {
      readonly stage: "target";
      readonly targetId: string;
      readonly state: Extract<
        AutomationRunTargetState,
        | "variant_ready"
        | "audit_failed"
        | "awaiting_manual_review"
        | "awaiting_delivery"
        | "delivery_failed"
        | "blocked"
        | "failed"
      >;
      readonly variantId?: string;
      readonly auditRunId?: string;
      readonly auditArtifactId?: string;
      readonly publicationJobId?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly remediation?: Readonly<AutomationRemediationPlan>;
      readonly draftTrace?: Readonly<AutomationDraftTrace>;
    };

export interface ScheduledAutomationTargetResult {
  readonly targetId: string;
  readonly state: Exclude<AutomationRunTargetState, "pending" | "variant_ready">;
  readonly variantId?: string;
  readonly auditRunId?: string;
  readonly auditArtifactId?: string;
  readonly publicationJobId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
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

function factLookupQuery(value: string): string {
  return [...value.trim().replaceAll(/\s+/gu, " ")].slice(0, 200).join("");
}

const BROWSER_ARTICLE_PLATFORMS = new Set<AutomationPlatform>([
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
]);

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 100);
  }
  return "AUTOMATION_TARGET_FAILED";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 500);
  }
  if (typeof error === "string" && error.trim().length > 0) return error.trim().slice(0, 500);
  return "未提供错误详情";
}

function auditFailureMessage(audit: Readonly<Record<string, unknown>>): string {
  const findings = Array.isArray(audit.findings) ? audit.findings : [];
  const rules = findings.flatMap((finding) => {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return [];
    const item = finding as Readonly<Record<string, unknown>>;
    const ruleId = typeof item.ruleId === "string" ? item.ruleId : "audit.finding";
    const path = typeof item.path === "string" ? ` @ ${item.path}` : "";
    return [`${ruleId}${path}`];
  });
  return rules.length === 0
    ? `审核状态未通过：${typeof audit.status === "string" ? audit.status : "unknown"}`
    : `审核未通过：${rules.slice(0, 8).join("、")}`;
}

function auditFindingRuleIds(audit: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(audit.findings)) return [];
  return [
    ...new Set(
      audit.findings.flatMap((finding) => {
        if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return [];
        const ruleId = (finding as Readonly<Record<string, unknown>>).ruleId;
        return typeof ruleId === "string" && ruleId.length > 0 ? [ruleId] : [];
      }),
    ),
  ];
}

/**
 * Returns only corrective actions that are safe to hand to the content producer.
 * Platform enforcement, unknown rules, and an unavailable vision evaluator are
 * terminal: a writer cannot honestly repair those conditions by changing prose.
 */
export function automationAuditRemediationPlan(
  input: Readonly<{
    runId: string;
    targetId: string;
    attempt: number;
    maxAttempts: number;
    audit: Readonly<Record<string, unknown>>;
  }>,
): Readonly<AutomationRemediationPlan> | null {
  const reasonCodes = auditFindingRuleIds(input.audit);
  if (reasonCodes.length === 0 || input.attempt < 1) return null;

  const actions = new Set<AutomationRemediationAction>();
  let mode: AutomationRemediationPlan["mode"] = "automatic";
  for (const reasonCode of reasonCodes) {
    if (reasonCode === "duplicate.exact" || reasonCode === "duplicate.near") {
      actions.add("change_diversity_blueprint");
      actions.add("rebuild_article");
      continue;
    }
    if (reasonCode.startsWith("structure.")) {
      actions.add("rebuild_article");
      actions.add("restructure_article");
      continue;
    }
    if (reasonCode.startsWith("promotion.")) {
      actions.add("rebuild_article");
      actions.add("soften_promotion");
      continue;
    }
    if (reasonCode.startsWith("platform.contact.")) {
      actions.add("rebuild_article");
      actions.add("remove_off_platform_contact");
      actions.add("soften_promotion");
      continue;
    }
    if (reasonCode.startsWith("platform.brand.")) {
      actions.add("rebuild_article");
      actions.add("reformat_for_platform");
      continue;
    }
    if (reasonCode.startsWith("title.") || reasonCode.startsWith("body.")) {
      actions.add("rebuild_article");
      actions.add("reformat_for_platform");
      continue;
    }
    if (
      reasonCode.startsWith("media.rights.") ||
      reasonCode.startsWith("media.rendition.") ||
      reasonCode.startsWith("media.scene.") ||
      reasonCode.startsWith("media.sha256.") ||
      reasonCode === "media.cover_required" ||
      reasonCode === "media.inspection.asset_mismatch"
    ) {
      actions.add("rebuild_article");
      actions.add("replace_media");
      continue;
    }
    if (reasonCode.startsWith("evidence.")) {
      actions.add("provide_verified_evidence");
      mode = "manual";
      continue;
    }
    // An unavailable or unapproved evaluator is an infrastructure condition, not a prompt defect.
    if (
      reasonCode === "media.inspection.evaluator_unapproved" ||
      reasonCode === "media.inspection.failed" ||
      reasonCode === "media.inspection.missing"
    ) {
      actions.add("manual_review");
      mode = "manual";
      continue;
    }
    actions.add("manual_review");
    mode = "manual";
  }
  if (actions.size === 0) return null;
  if (input.attempt > input.maxAttempts) mode = "manual";
  return Object.freeze({
    taskId: `${input.runId}:${input.targetId}:remediation:${input.attempt}`,
    scope: "target",
    mode,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    reasonCodes: Object.freeze(reasonCodes),
    actions: Object.freeze([...actions]),
  });
}

function manualRemediationPlan(
  plan: Readonly<AutomationRemediationPlan> | null,
): Readonly<AutomationRemediationPlan> | undefined {
  if (plan === null) return undefined;
  return Object.freeze({ ...plan, mode: "manual" as const });
}

function retryableAutomationError(error: unknown): boolean {
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

function blockedAutomationTargetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "PUBLICATION_POLICY_DENIED" || code === "PUBLICATION_GOVERNANCE_DENIED";
}

function isMediaSearchFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code.startsWith("MEDIA_SEARCH_") || code === "MEDIA_SEARCH_INTENT_UNFILLED";
}

function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runAccountScoped<T>(
  items: readonly T[],
  accountKey: (item: T) => string,
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = accountKey(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  const queues = [...groups.values()];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const queue = queues[index];
      if (queue === undefined) return;
      for (const item of queue) await operation(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), queues.length) }, () => worker()),
  );
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Automation run was aborted");
}

class AutomationCheckpointError extends Error {
  override readonly cause: unknown;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly uncertain?: boolean;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Automation checkpoint failed");
    this.name = "AutomationCheckpointError";
    this.cause = cause;
    if (typeof cause === "object" && cause !== null) {
      const candidate = cause as Readonly<Record<string, unknown>>;
      if (typeof candidate.code === "string") this.code = candidate.code;
      if (typeof candidate.retryable === "boolean") this.retryable = candidate.retryable;
      if (typeof candidate.uncertain === "boolean") this.uncertain = candidate.uncertain;
    }
  }
}

export class ScheduledAutomationRuntime {
  readonly #runtime: AutomationToolRuntime;
  readonly #draftAuthor: AutomationDraftAuthor | undefined;
  readonly #mediaRetryAttempts: number;
  readonly #mediaRetryDelayMs: number;
  readonly #contentRemediationAttempts: number;
  readonly #targetConcurrency: number;
  readonly #resourceConflictRetryAttempts: number;
  readonly #resourceConflictRetryDelayMs: number;
  readonly #wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    runtime: AutomationToolRuntime,
    draftAuthor?: AutomationDraftAuthor,
    options: ScheduledAutomationRuntimeOptions = {},
  ) {
    this.#runtime = runtime;
    this.#draftAuthor = draftAuthor;
    this.#mediaRetryAttempts = options.mediaRetryAttempts ?? 3;
    this.#mediaRetryDelayMs = options.mediaRetryDelayMs ?? 2_000;
    this.#contentRemediationAttempts = options.contentRemediationAttempts ?? 2;
    this.#targetConcurrency = options.targetConcurrency ?? 1;
    this.#resourceConflictRetryAttempts = options.resourceConflictRetryAttempts ?? 2;
    this.#resourceConflictRetryDelayMs = options.resourceConflictRetryDelayMs ?? 2_000;
    this.#wait = options.wait ?? waitForDelay;
    if (
      !Number.isSafeInteger(this.#mediaRetryAttempts) ||
      this.#mediaRetryAttempts < 1 ||
      this.#mediaRetryAttempts > 5
    ) {
      throw new TypeError("mediaRetryAttempts must be between 1 and 5");
    }
    if (
      !Number.isSafeInteger(this.#mediaRetryDelayMs) ||
      this.#mediaRetryDelayMs < 0 ||
      this.#mediaRetryDelayMs > 30_000
    ) {
      throw new TypeError("mediaRetryDelayMs must be between 0 and 30000");
    }
    if (
      !Number.isSafeInteger(this.#contentRemediationAttempts) ||
      this.#contentRemediationAttempts < 0 ||
      this.#contentRemediationAttempts > 5
    ) {
      throw new TypeError("contentRemediationAttempts must be between 0 and 5");
    }
    if (
      !Number.isSafeInteger(this.#targetConcurrency) ||
      this.#targetConcurrency < 1 ||
      this.#targetConcurrency > 16
    ) {
      throw new TypeError("targetConcurrency must be between 1 and 16");
    }
    if (
      !Number.isSafeInteger(this.#resourceConflictRetryAttempts) ||
      this.#resourceConflictRetryAttempts < 0 ||
      this.#resourceConflictRetryAttempts > 5
    ) {
      throw new TypeError("resourceConflictRetryAttempts must be between 0 and 5");
    }
    if (
      !Number.isSafeInteger(this.#resourceConflictRetryDelayMs) ||
      this.#resourceConflictRetryDelayMs < 0 ||
      this.#resourceConflictRetryDelayMs > 30_000
    ) {
      throw new TypeError("resourceConflictRetryDelayMs must be between 0 and 30000");
    }
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
    let draftTrace: AutomationDraftTrace | undefined;
    if (input.draftTrace !== undefined) {
      const parsedTrace = parseAutomationDraftTrace(input.draftTrace);
      if (parsedTrace === null)
        throw new Error("Automation resume contains an invalid draft trace");
      if (input.contentItemId === undefined || input.contentVersionId === undefined) {
        throw new Error("Automation draft trace requires persisted content IDs");
      }
      draftTrace = parsedTrace;
    }

    let contentItemId = input.contentItemId;
    let contentVersionId = input.contentVersionId;
    const completedMediaPlatforms = new Set<AutomationPlatform>(
      input.mediaSearchCompletedPlatforms ?? [],
    );
    if (input.mediaSearchCompleted === true) completedMediaPlatforms.add("ctrip_community");
    const pendingPlatforms = [
      ...new Set(
        input.targets
          .filter((target) => (target.state ?? "pending") === "pending")
          .map((target) => target.platform),
      ),
    ];
    const primaryDraftPlatform = pendingPlatforms.includes("ctrip_community")
      ? "ctrip_community"
      : pendingPlatforms[0];
    const platformDrafts = new Map<
      AutomationPlatform,
      Readonly<{
        contentItemId: string;
        contentVersionId: string;
        draftTrace: AutomationDraftTrace;
      }>
    >();
    if (contentItemId === undefined || contentVersionId === undefined) {
      if (primaryDraftPlatform === undefined) throw new Error("Automation run requires a target");
      const idempotencyKey = `automation:${input.runId}:platform:${primaryDraftPlatform}:draft:v1`;
      let draft: Readonly<Record<string, unknown>>;
      if (this.#draftAuthor !== undefined) {
        draft = record(
          await this.#draftAuthor.author(
            {
              tenantId: input.tenantId,
              brandId: input.brandId,
              campaignId: input.campaignId,
              targetPlatform: primaryDraftPlatform,
              brief: input.topic,
              idempotencyKey,
            },
            signal,
          ),
          "Pi-authored draft",
        );
        const parsedTrace = parseAutomationDraftTrace(draft);
        if (parsedTrace === null) {
          throw new Error("Automation Pi-authored draft returned invalid trace");
        }
        draftTrace = parsedTrace;
      } else {
        await invoke("plastic_context_supply", {
          tenantId: input.tenantId,
          taskDescription: `Create a governed automation draft about ${input.topic}`,
          taskType: "content_drafting",
        });
        await invoke("geo_tenant_context", { tenantId: input.tenantId });
        await invoke("geo_fact_lookup", {
          tenantId: input.tenantId,
          brandId: input.brandId,
          query: factLookupQuery(input.topic),
          limit: 10,
        });
        draft = record(
          await invoke("geo_draft_proposal", {
            tenantId: input.tenantId,
            brandId: input.brandId,
            campaignId: input.campaignId,
            brief: input.topic,
            idempotencyKey,
            fixtureMode: true,
          }),
          "draft",
        );
      }
      contentItemId = stringField(draft.contentItemId, "contentItemId");
      contentVersionId = stringField(draft.contentVersionId, "contentVersionId");
      if (draftTrace !== undefined) {
        platformDrafts.set(primaryDraftPlatform, {
          contentItemId,
          contentVersionId,
          draftTrace,
        });
      }
      const articleTemplateId =
        typeof draft.articleTemplateId === "string" && draft.articleTemplateId.length > 0
          ? draft.articleTemplateId
          : undefined;
      await persistCheckpoint({
        stage: "draft",
        contentItemId,
        contentVersionId,
        ...(articleTemplateId === undefined ? {} : { articleTemplateId }),
        ...(draftTrace === undefined ? {} : { providerMode: "pi_authored" as const, draftTrace }),
      });
    }

    if (this.#draftAuthor !== undefined) {
      for (const platform of pendingPlatforms) {
        if (platformDrafts.has(platform) || completedMediaPlatforms.has(platform)) continue;
        const platformDraft = record(
          await this.#draftAuthor.author(
            {
              tenantId: input.tenantId,
              brandId: input.brandId,
              campaignId: input.campaignId,
              targetPlatform: platform,
              brief: input.topic,
              idempotencyKey: `automation:${input.runId}:platform:${platform}:draft:v1`,
            },
            signal,
          ),
          `${platform} Pi-authored platform draft`,
        );
        const platformDraftTrace = parseAutomationDraftTrace(platformDraft);
        if (platformDraftTrace === null) {
          throw new Error(`Automation ${platform} Pi-authored draft returned invalid trace`);
        }
        platformDrafts.set(platform, {
          contentItemId: stringField(platformDraft.contentItemId, "contentItemId"),
          contentVersionId: stringField(platformDraft.contentVersionId, "contentVersionId"),
          draftTrace: platformDraftTrace,
        });
      }
    }

    let manualReviewRequired = false;
    let lastCompletedMedia:
      | {
          readonly provider: LicensedImageSearchProviderId;
          readonly mediaCount: number;
        }
      | undefined;
    const searchMedia = async (
      startingContentItemId: string,
      startingContentVersionId: string,
      idempotencySuffix: string,
      platform: AutomationPlatform,
      trackPlatformCompletion = true,
      persistProgress = true,
      checkpointDraftTrace: AutomationDraftTrace | undefined = draftTrace,
    ) => {
      const sourceContentVersionId = startingContentVersionId;
      let nextContentVersionId = startingContentVersionId;
      let mediaComplete = false;
      let mediaSteps = 0;
      while (!mediaComplete) {
        if (mediaSteps >= 5) throw new Error("MEDIA_SEARCH_PROGRESS_INVALID");
        const requestedContentVersionId = nextContentVersionId;
        const mediaArgs = {
          tenantId: input.tenantId,
          contentVersionId: requestedContentVersionId,
          platform,
          idempotencyKey: `automation:${input.runId}:${idempotencySuffix}`,
          maxImports: 1,
        };
        let mediaResult: unknown;
        for (let attempt = 1; attempt <= this.#mediaRetryAttempts; attempt += 1) {
          try {
            mediaResult = await invoke("geo_media_search_import", mediaArgs);
            break;
          } catch (error) {
            if (!retryableAutomationError(error) || attempt === this.#mediaRetryAttempts) {
              throw error;
            }
            await this.#wait(this.#mediaRetryDelayMs * 2 ** (attempt - 1), signal);
          }
        }
        const media = record(mediaResult, "media search import");
        const mediaProvider = media.provider;
        if (mediaProvider !== "wikimedia_commons" && mediaProvider !== "pexels") {
          throw new Error("MEDIA_SEARCH_PROVIDER_INVALID");
        }
        const plannedCount = media.plannedCount;
        const imported = media.imported;
        const legacyComplete =
          media.complete === undefined &&
          Array.isArray(imported) &&
          imported.length === plannedCount;
        const initialMediaCount =
          typeof media.initialMediaCount === "number" ? media.initialMediaCount : 0;
        const totalMediaCount =
          typeof media.totalMediaCount === "number"
            ? media.totalMediaCount
            : Array.isArray(imported)
              ? imported.length
              : -1;
        mediaComplete = media.complete === true || legacyComplete;
        if (
          typeof plannedCount !== "number" ||
          !Number.isInteger(plannedCount) ||
          plannedCount < 4 ||
          plannedCount > 5 ||
          typeof initialMediaCount !== "number" ||
          !Number.isInteger(initialMediaCount) ||
          initialMediaCount < 0 ||
          typeof totalMediaCount !== "number" ||
          !Number.isInteger(totalMediaCount) ||
          totalMediaCount < initialMediaCount ||
          totalMediaCount > plannedCount ||
          !Array.isArray(imported) ||
          imported.length !== totalMediaCount - initialMediaCount ||
          (!mediaComplete && imported.length !== 1) ||
          (mediaComplete && totalMediaCount !== plannedCount)
        ) {
          throw new Error("MEDIA_SEARCH_COUNT_INVALID");
        }
        if (
          stringField(media.sourceContentVersionId, "sourceContentVersionId") !==
          requestedContentVersionId
        ) {
          throw new Error("MEDIA_SEARCH_SOURCE_INVALID");
        }
        nextContentVersionId = stringField(media.finalContentVersionId, "finalContentVersionId");
        manualReviewRequired ||= media.manualReviewRequired === true;
        if (mediaComplete && trackPlatformCompletion) {
          completedMediaPlatforms.add(platform);
          lastCompletedMedia = {
            provider: mediaProvider,
            mediaCount: totalMediaCount,
          };
        }
        if (persistProgress) {
          await persistCheckpoint({
            stage: "media",
            contentItemId: startingContentItemId,
            sourceContentVersionId,
            contentVersionId: nextContentVersionId,
            provider: mediaProvider,
            platform,
            mediaCount: totalMediaCount,
            mediaComplete,
            completedPlatforms: [...completedMediaPlatforms],
            ...(checkpointDraftTrace === undefined
              ? {}
              : { providerMode: "pi_authored" as const, draftTrace: checkpointDraftTrace }),
          });
        }
        mediaSteps += 1;
      }
      return nextContentVersionId;
    };

    const searchMediaWithRemediation = async (
      startingContentItemId: string,
      startingContentVersionId: string,
      idempotencySuffix: string,
      platform: AutomationPlatform,
      target: ScheduledAutomationTarget,
      trackPlatformCompletion = true,
      persistProgress = true,
      baseDraftTrace: AutomationDraftTrace | undefined = draftTrace,
    ): Promise<{
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly draftTrace: AutomationDraftTrace | undefined;
    }> => {
      let contentItemId = startingContentItemId;
      let contentVersionId = startingContentVersionId;
      let draftTrace = baseDraftTrace;
      let attempt = 0;
      for (;;) {
        try {
          return {
            contentVersionId: await searchMedia(
              contentItemId,
              contentVersionId,
              idempotencySuffix,
              platform,
              trackPlatformCompletion,
              persistProgress,
              draftTrace,
            ),
            contentItemId,
            draftTrace,
          };
        } catch (error) {
          if (
            this.#draftAuthor?.authorAlternate === undefined ||
            attempt >= this.#contentRemediationAttempts ||
            !isMediaSearchFailure(error)
          ) {
            throw error;
          }
          const remediation: AutomationRemediationPlan = {
            taskId: `${input.runId}:${target.targetId}:media:${attempt + 1}`,
            scope: "target",
            mode: "automatic",
            attempt: attempt + 1,
            maxAttempts: this.#contentRemediationAttempts,
            reasonCodes: ["media.search_failed", errorCode(error)],
            actions: ["replace_media", "rebuild_article"],
          };
          const alternateDraft = record(
            await this.#draftAuthor.authorAlternate(
              {
                tenantId: input.tenantId,
                brandId: input.brandId,
                campaignId: input.campaignId,
                targetPlatform: platform,
                brief: input.topic,
                idempotencyKey: `automation:${input.runId}:target:${target.targetId}:media-remediation:${attempt + 1}:draft:v1`,
                remediation,
              },
              signal,
            ),
            "media remediation draft",
          );
          const alternateTrace = parseAutomationDraftTrace(alternateDraft);
          if (alternateTrace === null) {
            throw new Error("Automation media remediation draft returned invalid trace", {
              cause: error,
            });
          }
          draftTrace = alternateTrace;
          contentItemId = stringField(alternateDraft.contentItemId, "contentItemId");
          contentVersionId = stringField(alternateDraft.contentVersionId, "contentVersionId");
          attempt += 1;
        }
      }
    };

    const mediaPlatforms = [
      ...new Set(
        input.targets
          .filter((target) => (target.state ?? "pending") === "pending")
          .map((target) => target.platform)
          .filter((platform) => BROWSER_ARTICLE_PLATFORMS.has(platform)),
      ),
    ];
    const legacyVariantTargetIds = new Set(
      input.targets
        .filter(
          (target) =>
            target.state === "variant_ready" &&
            target.auditRunId === undefined &&
            target.auditArtifactId === undefined &&
            BROWSER_ARTICLE_PLATFORMS.has(target.platform) &&
            !completedMediaPlatforms.has(target.platform),
        )
        .map((target) => target.targetId),
    );
    for (const target of input.targets) {
      if (
        legacyVariantTargetIds.has(target.targetId) &&
        !mediaPlatforms.includes(target.platform)
      ) {
        mediaPlatforms.push(target.platform);
      }
    }
    const platformContentVersionIds = new Map<AutomationPlatform, string>();
    const platformAlternateTraces = new Map<AutomationPlatform, AutomationDraftTrace>();
    const representativeTargetForPlatform = (
      platform: AutomationPlatform,
    ): ScheduledAutomationTarget => {
      const target = input.targets.find((candidate) => candidate.platform === platform);
      if (target === undefined) {
        throw new Error("AUTOMATION_MEDIA_PLATFORM_TARGET_MISSING");
      }
      return target;
    };
    const mediaFallbackPlatforms = new Set<AutomationPlatform>();
    for (const platform of mediaPlatforms) {
      if (completedMediaPlatforms.has(platform)) {
        platformContentVersionIds.set(platform, contentVersionId);
        continue;
      }
      const platformDraft = platformDrafts.get(platform);
      const startingContentItemId = platformDraft?.contentItemId ?? contentItemId;
      const startingVersionId = platformDraft?.contentVersionId ?? contentVersionId;
      const persistPlatformProgress =
        platformDraft === undefined || platformDraft.contentItemId === contentItemId;
      try {
        const finalMedia = await searchMediaWithRemediation(
          startingContentItemId,
          startingVersionId,
          platform === "ctrip_community" ? "media-search:v1" : `media-search:${platform}:v1`,
          platform,
          representativeTargetForPlatform(platform),
          true,
          persistPlatformProgress,
          platformDraft?.draftTrace ?? draftTrace,
        );
        const finalVersionId = finalMedia.contentVersionId;
        if (finalMedia.draftTrace !== undefined) {
          platformAlternateTraces.set(platform, finalMedia.draftTrace);
        }
        if (persistPlatformProgress) {
          contentItemId = finalMedia.contentItemId;
          contentVersionId = finalVersionId;
        }
        platformContentVersionIds.set(platform, finalVersionId);
      } catch (error) {
        if (!isMediaSearchFailure(error)) throw error;
        // Platform media remediation exhausted. Reuse media already produced
        // for the same article by another platform so this target still ships
        // with images; otherwise hold only this platform for manual review.
        if (lastCompletedMedia !== undefined) {
          completedMediaPlatforms.add(platform);
          platformContentVersionIds.set(platform, contentVersionId);
          const mediaFallbackDraftTrace = platformDraft?.draftTrace ?? draftTrace;
          await persistCheckpoint({
            stage: "media",
            contentItemId: stringField(contentItemId, "contentItemId"),
            sourceContentVersionId: startingVersionId,
            contentVersionId,
            provider: lastCompletedMedia.provider,
            platform,
            mediaCount: lastCompletedMedia.mediaCount,
            mediaComplete: true,
            completedPlatforms: [...completedMediaPlatforms],
            ...(mediaFallbackDraftTrace === undefined
              ? {}
              : {
                  providerMode: "pi_authored" as const,
                  draftTrace: mediaFallbackDraftTrace,
                }),
          });
        } else {
          mediaFallbackPlatforms.add(platform);
        }
      }
    }

    if (manualReviewRequired) {
      const results: ScheduledAutomationTargetResult[] = [];
      for (const target of input.targets) {
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
            ...(target.errorMessage === undefined ? {} : { errorMessage: target.errorMessage }),
          });
          continue;
        }
        const result = {
          targetId: target.targetId,
          state: "awaiting_manual_review" as const,
        };
        await persistCheckpoint({ stage: "target", ...result });
        results.push(result);
      }
      return { contentItemId, contentVersionId, targets: results };
    }

    const contentVersionForPlatform = async (
      platform: AutomationPlatform,
      target: ScheduledAutomationTarget,
    ) => {
      const currentContentVersionId = stringField(contentVersionId, "contentVersionId");
      const existing = platformContentVersionIds.get(platform);
      if (existing !== undefined || !BROWSER_ARTICLE_PLATFORMS.has(platform)) {
        return existing ?? currentContentVersionId;
      }
      const suffix =
        platform === "ctrip_community" ? "media-search:v1" : `media-search:${platform}:v1`;
      const finalMedia = await searchMediaWithRemediation(
        stringField(contentItemId, "contentItemId"),
        currentContentVersionId,
        suffix,
        platform,
        target,
      );
      if (finalMedia.draftTrace !== undefined) {
        platformAlternateTraces.set(platform, finalMedia.draftTrace);
      }
      contentItemId = finalMedia.contentItemId;
      contentVersionId = finalMedia.contentVersionId;
      platformContentVersionIds.set(platform, finalMedia.contentVersionId);
      return finalMedia.contentVersionId;
    };

    const invokePublicationWithResourceRetry = async (
      args: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> => {
      for (let retry = 0; ; retry += 1) {
        try {
          return record(await invoke("geo_publication_request", args), "publication");
        } catch (error) {
          if (
            errorCode(error) !== "RESOURCE_CONFLICT" ||
            !retryableAutomationError(error) ||
            retry >= this.#resourceConflictRetryAttempts
          ) {
            throw error;
          }
          await this.#wait(this.#resourceConflictRetryDelayMs * 2 ** retry, signal);
        }
      }
    };

    const results: ScheduledAutomationTargetResult[] = [];
    const processTarget = async (target: ScheduledAutomationTarget): Promise<void> => {
      aborted(signal);
      const persistedState = legacyVariantTargetIds.has(target.targetId)
        ? "pending"
        : (target.state ?? "pending");
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
          ...(target.errorMessage === undefined ? {} : { errorMessage: target.errorMessage }),
        });
        return;
      }
      if (mediaFallbackPlatforms.has(target.platform)) {
        const result = {
          targetId: target.targetId,
          state: "awaiting_manual_review" as const,
          errorCode: "MEDIA_SEARCH_UNFILLED",
          errorMessage:
            "Media search and remediation exhausted before any article media was produced",
        };
        await persistCheckpoint({ stage: "target", ...result });
        results.push(result);
        return;
      }

      let variantId = target.variantId;
      let auditRunId: string | undefined;
      let auditArtifactId: string | undefined;
      let remediationAttempt =
        persistedState === "variant_ready" && target.remediation?.mode === "automatic"
          ? target.remediation.attempt
          : 0;
      let remediation: AutomationRemediationPlan | undefined = target.remediation;
      let targetDraftTrace = platformAlternateTraces.get(target.platform);
      try {
        if (persistedState === "pending") {
          let targetContentVersionId = await contentVersionForPlatform(target.platform, target);
          const requestedManualRemediation = target.remediation;
          remediation = requestedManualRemediation;
          if (requestedManualRemediation?.mode === "manual") {
            if (this.#draftAuthor?.authorAlternate === undefined) {
              throw new Error("AUTOMATION_MANUAL_REMEDIATION_UNAVAILABLE");
            }
            const alternateDraft = record(
              await this.#draftAuthor.authorAlternate(
                {
                  tenantId: input.tenantId,
                  brandId: input.brandId,
                  campaignId: input.campaignId,
                  targetPlatform: target.platform,
                  brief: input.topic,
                  idempotencyKey: `automation:${input.runId}:target:${target.targetId}:manual-remediation:${requestedManualRemediation.attempt}:draft:v1`,
                  remediation: requestedManualRemediation,
                },
                signal,
              ),
              "manual remediation draft",
            );
            const alternateTrace = parseAutomationDraftTrace(alternateDraft);
            if (alternateTrace === null) {
              throw new Error("Automation manual remediation draft returned invalid trace");
            }
            targetDraftTrace = alternateTrace;
            const targetContentItemId = stringField(alternateDraft.contentItemId, "contentItemId");
            targetContentVersionId = stringField(
              alternateDraft.contentVersionId,
              "contentVersionId",
            );
            if (BROWSER_ARTICLE_PLATFORMS.has(target.platform)) {
              const mediaResult = await searchMediaWithRemediation(
                targetContentItemId,
                targetContentVersionId,
                `media-search:manual-remediation:${target.targetId}:${target.platform}:${requestedManualRemediation.attempt}:v1`,
                target.platform,
                target,
                false,
                true,
                alternateTrace,
              );
              contentItemId = mediaResult.contentItemId;
              targetContentVersionId = mediaResult.contentVersionId;
              if (mediaResult.draftTrace !== undefined) {
                targetDraftTrace = mediaResult.draftTrace;
              }
            }
          }
          const preview = record(
            await invoke("geo_variant_preview", {
              tenantId: input.tenantId,
              contentVersionId: targetContentVersionId,
              channelAccountId: target.channelAccountId,
              platform: target.platform,
            }),
            "variant preview",
          );
          variantId = stringField(preview.variantId, "variantId");
        } else {
          variantId = persistedString(variantId, "variantId");
        }

        const resumedAuditIdempotencyKey =
          persistedState === "variant_ready" && remediation?.mode === "automatic"
            ? `automation:${input.runId}:target:${target.targetId}:remediation:${remediationAttempt}:audit:v1`
            : `automation:${input.runId}:target:${target.targetId}:audit:v1`;
        let audit = record(
          await invoke("geo_audit_request", {
            tenantId: input.tenantId,
            variantId,
            idempotencyKey: resumedAuditIdempotencyKey,
          }),
          "audit",
        );
        auditRunId = stringField(audit.auditRunId, "auditRunId");
        auditArtifactId = stringField(audit.auditArtifactId, "auditArtifactId");
        while (
          persistedState === "pending" &&
          audit.status !== "passed" &&
          this.#draftAuthor?.authorAlternate !== undefined &&
          remediationAttempt < this.#contentRemediationAttempts
        ) {
          const nextRemediation = automationAuditRemediationPlan({
            runId: input.runId,
            targetId: target.targetId,
            attempt: remediationAttempt + 1,
            maxAttempts: this.#contentRemediationAttempts,
            audit,
          });
          if (nextRemediation === null || nextRemediation.mode !== "automatic") break;
          remediation = nextRemediation;
          remediationAttempt += 1;
          const alternateDraft = record(
            await this.#draftAuthor.authorAlternate(
              {
                tenantId: input.tenantId,
                brandId: input.brandId,
                campaignId: input.campaignId,
                targetPlatform: target.platform,
                brief: input.topic,
                idempotencyKey: `automation:${input.runId}:target:${target.targetId}:remediation:${remediationAttempt}:draft:v1`,
                remediation,
              },
              signal,
            ),
            "Pi-authored remediation draft",
          );
          const alternateTrace = parseAutomationDraftTrace(alternateDraft);
          if (alternateTrace === null) {
            throw new Error("Automation remediation draft returned invalid trace");
          }
          targetDraftTrace = alternateTrace;
          const alternateContentItemId = stringField(alternateDraft.contentItemId, "contentItemId");
          let alternateContentVersionId = stringField(
            alternateDraft.contentVersionId,
            "contentVersionId",
          );
          if (BROWSER_ARTICLE_PLATFORMS.has(target.platform)) {
            const mediaResult = await searchMediaWithRemediation(
              alternateContentItemId,
              alternateContentVersionId,
              `media-search:remediation:${target.targetId}:${target.platform}:${remediationAttempt}:v1`,
              target.platform,
              target,
              false,
              true,
              alternateTrace,
            );
            contentItemId = mediaResult.contentItemId;
            alternateContentVersionId = mediaResult.contentVersionId;
            if (mediaResult.draftTrace !== undefined) {
              targetDraftTrace = mediaResult.draftTrace;
            }
          }
          const alternatePreview = record(
            await invoke("geo_variant_preview", {
              tenantId: input.tenantId,
              contentVersionId: alternateContentVersionId,
              channelAccountId: target.channelAccountId,
              platform: target.platform,
            }),
            "remediation variant preview",
          );
          variantId = stringField(alternatePreview.variantId, "variantId");
          audit = record(
            await invoke("geo_audit_request", {
              tenantId: input.tenantId,
              variantId,
              idempotencyKey: `automation:${input.runId}:target:${target.targetId}:remediation:${remediationAttempt}:audit:v1`,
            }),
            "remediation audit",
          );
          auditRunId = stringField(audit.auditRunId, "auditRunId");
          auditArtifactId = stringField(audit.auditArtifactId, "auditArtifactId");
        }
        if (persistedState === "pending") {
          await persistCheckpoint({
            stage: "target",
            targetId: target.targetId,
            state: "variant_ready",
            variantId,
            auditRunId,
            auditArtifactId,
            ...(remediation === undefined ? {} : { remediation }),
            ...(targetDraftTrace === undefined ? {} : { draftTrace: targetDraftTrace }),
          });
        }
        if (audit.status !== "passed") {
          const remediablePlan = automationAuditRemediationPlan({
            runId: input.runId,
            targetId: target.targetId,
            attempt: remediationAttempt + 1,
            maxAttempts: this.#contentRemediationAttempts,
            audit,
          });
          const automaticRepairAvailable =
            persistedState === "pending" &&
            this.#draftAuthor?.authorAlternate !== undefined &&
            this.#contentRemediationAttempts > 0;
          const requiresManualReview =
            remediablePlan === null ||
            remediablePlan.mode === "manual" ||
            remediationAttempt >= this.#contentRemediationAttempts ||
            !automaticRepairAvailable;
          const terminalState: "awaiting_manual_review" | "audit_failed" = requiresManualReview
            ? "awaiting_manual_review"
            : "audit_failed";
          const terminalRemediation = requiresManualReview
            ? manualRemediationPlan(remediablePlan)
            : remediablePlan;
          const result = {
            targetId: target.targetId,
            state: terminalState,
            variantId,
            auditRunId,
            auditArtifactId,
            errorCode:
              terminalState === "awaiting_manual_review"
                ? "AUTOMATION_MANUAL_REMEDIATION_REQUIRED"
                : remediationAttempt >= this.#contentRemediationAttempts
                  ? "AUTOMATION_REMEDIATION_EXHAUSTED"
                  : "AUTOMATION_AUDIT_FAILED",
            errorMessage: auditFailureMessage(audit),
            ...(terminalRemediation === undefined ? {} : { remediation: terminalRemediation }),
          };
          await persistCheckpoint({ stage: "target", ...result });
          results.push(result);
          return;
        }

        const publication = await invokePublicationWithResourceRetry({
          tenantId: input.tenantId,
          variantId,
          channelAccountId: target.channelAccountId,
          platform: target.platform,
          executionLevel: input.executionLevel,
          idempotencyKey: `automation:${input.runId}:target:${target.targetId}:publication:${remediationAttempt === 0 ? "v1" : `remediation-${remediationAttempt}`}`,
        });
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
        if (retryableAutomationError(error) && errorCode(error) !== "RESOURCE_CONFLICT") {
          throw error;
        }
        const targetState: "blocked" | "failed" | "delivery_failed" = blockedAutomationTargetError(
          error,
        )
          ? "blocked"
          : errorCode(error) === "RESOURCE_CONFLICT"
            ? "delivery_failed"
            : "failed";
        const result = {
          targetId: target.targetId,
          state: targetState,
          ...(variantId === undefined ? {} : { variantId }),
          ...(auditRunId === undefined ? {} : { auditRunId }),
          ...(auditArtifactId === undefined ? {} : { auditArtifactId }),
          errorCode: errorCode(error),
          errorMessage: errorMessage(error),
        };
        await persistCheckpoint({ stage: "target", ...result });
        results.push(result);
      }
    };

    await runAccountScoped(
      input.targets,
      (target) => target.channelAccountId,
      this.#targetConcurrency,
      processTarget,
    );
    const targetOrder = new Map(input.targets.map((target, index) => [target.targetId, index]));
    results.sort(
      (left, right) =>
        (targetOrder.get(left.targetId) ?? 0) - (targetOrder.get(right.targetId) ?? 0),
    );

    return { contentItemId, contentVersionId, targets: results };
  }
}
