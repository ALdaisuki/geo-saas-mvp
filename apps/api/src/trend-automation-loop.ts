import { randomUUID } from "node:crypto";

import {
  PRIMARY_DISTRIBUTION_PLATFORMS,
  type ActorContext,
  type ExecutionLevel,
} from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import { z } from "zod";

import type { CreateAutomationBatchInput } from "./automation-repository.js";
import type { OperationsEventBus } from "./operations-event-stream.js";
import type { ApiRepository, ChannelAccountView, RequestContext } from "./repository.js";
import type { TrendController, TrendTopicCandidateView } from "./trend-service.js";

const primaryPlatformSchema = z.enum(PRIMARY_DISTRIBUTION_PLATFORMS);
const pipelineSchema = z.strictObject({
  actorId: z.string().uuid(),
  campaignId: z.string().uuid(),
  platforms: z
    .array(primaryPlatformSchema)
    .min(1)
    .max(PRIMARY_DISTRIBUTION_PLATFORMS.length)
    .refine((items) => new Set(items).size === items.length, "Platforms must be unique")
    .default([...PRIMARY_DISTRIBUTION_PLATFORMS]),
  executionLevel: z.enum(["dry_run", "assisted", "unattended"]).default("dry_run"),
  maxNewBatchesPerRun: z.number().int().min(1).max(100).default(20),
  lookbackMinutes: z.number().int().min(15).max(10_080).default(1_440),
  minFreshnessScore: z.number().min(0).max(1).default(0.65),
  relevanceTerms: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(100)
    .refine((items) => new Set(items.map(normalizeText)).size === items.length, {
      message: "Relevance terms must be unique after normalization",
    }),
});

const pipelinesSchema = z
  .record(z.string().uuid(), pipelineSchema)
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one trend automation pipeline is required",
  );

export interface TrendAutomationPipeline {
  readonly tenantId: string;
  readonly actorId: string;
  readonly campaignId: string;
  readonly platforms: readonly (typeof PRIMARY_DISTRIBUTION_PLATFORMS)[number][];
  readonly executionLevel: ExecutionLevel;
  readonly maxNewBatchesPerRun: number;
  readonly lookbackMinutes: number;
  readonly minFreshnessScore: number;
  readonly relevanceTerms: readonly string[];
}

export interface TrendAutomationPipelineSummary {
  readonly tenantId: string;
  readonly campaignId: string;
  readonly status: "fulfilled" | "partial" | "rejected";
  readonly candidateCount: number;
  readonly createdBatchCount: number;
  readonly replayedBatchCount: number;
  readonly failedCandidateCount: number;
  readonly errorCodes: readonly string[];
  readonly errorCode?: string | undefined;
}

export interface TrendAutomationRunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly pipelines: readonly TrendAutomationPipelineSummary[];
}

export interface TrendAutomationLoopOptions {
  readonly repository: Pick<
    ApiRepository,
    "listCampaigns" | "listChannelAccounts" | "createAutomationBatch"
  >;
  readonly trendController: Pick<TrendController, "listTopicCandidates">;
  readonly pipelines: readonly TrendAutomationPipeline[];
  readonly validateActor: (tenantId: string, actorId: string) => Promise<boolean>;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly operationsEventBus?: Pick<OperationsEventBus, "publishSnapshot">;
  readonly onRun?: (summary: TrendAutomationRunSummary) => void;
  readonly onError?: (errorCode: string) => void;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, "");
}

function safeErrorCode(error: unknown, fallback = "TREND_AUTOMATION_PIPELINE_FAILED"): string {
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

function requestContext(pipeline: TrendAutomationPipeline, requestId: string): RequestContext {
  return {
    tenantId: pipeline.tenantId,
    actorId: pipeline.actorId,
    requestId,
  };
}

function trendActor(pipeline: TrendAutomationPipeline, requestId: string): ActorContext {
  return {
    ...requestContext(pipeline, requestId),
    role: "automation_operator",
    capabilities: ["content:read", "automation:execute"],
  };
}

function relevant(candidate: TrendTopicCandidateView, pipeline: TrendAutomationPipeline): boolean {
  if (candidate.freshnessScore < pipeline.minFreshnessScore) return false;
  const material = normalizeText(
    [
      candidate.title,
      candidate.normalizedTitle,
      ...candidate.observations.flatMap((item) => [item.title, item.summary ?? ""]),
    ].join("\n"),
  );
  return pipeline.relevanceTerms.some((term) => material.includes(normalizeText(term)));
}

function accountPriority(left: ChannelAccountView, right: ChannelAccountView): number {
  const quota = (right.dailyPublishQuota ?? 0) - (left.dailyPublishQuota ?? 0);
  if (quota !== 0) return quota;
  const verified =
    Date.parse(right.lastVerifiedAt ?? "1970-01-01T00:00:00.000Z") -
    Date.parse(left.lastVerifiedAt ?? "1970-01-01T00:00:00.000Z");
  return verified || left.id.localeCompare(right.id);
}

function selectAccounts(
  accounts: readonly ChannelAccountView[],
  pipeline: TrendAutomationPipeline,
): readonly ChannelAccountView[] {
  return pipeline.platforms.map((platform) => {
    const selected = accounts
      .filter(
        (account) =>
          account.platform === platform &&
          account.status === "active" &&
          account.supportedExecutionLevels.includes(pipeline.executionLevel),
      )
      .sort(accountPriority)[0];
    if (selected === undefined) {
      const error = new Error(`No eligible ${platform} account is available`);
      Object.assign(error, { code: "TREND_AUTOMATION_ACCOUNT_UNAVAILABLE" });
      throw error;
    }
    return selected;
  });
}

function boundedText(value: string, maximumCodePoints: number): string {
  return [...value].slice(0, maximumCodePoints).join("");
}

function candidateBrief(
  candidate: TrendTopicCandidateView,
  campaign: { readonly name: string; readonly objective: string },
): string {
  const evidence = candidate.observations.map((observation, index) =>
    [
      `${String(index + 1)}. ${observation.sourceKey}: ${observation.title}`,
      ...(observation.summary === undefined ? [] : [`   摘要: ${observation.summary}`]),
      ...(observation.canonicalUrl === undefined ? [] : [`   来源: ${observation.canonicalUrl}`]),
      `   观察时间: ${observation.observedAt}`,
    ].join("\n"),
  );
  return boundedText(
    [
      `当前热点: ${candidate.title}`,
      `推广活动: ${campaign.name}`,
      `活动目标: ${campaign.objective}`,
      "创作要求: 以热点作为实用信息入口，产出自然软广。热点证据只用于说明当前话题；品牌资质、排名、功效、价格等具体断言必须绑定现有事实快照中的有效证据，缺少证据时改写为中性建议。当前 MVP 不调用 RAG 或知识库检索。",
      "热点证据:",
      ...evidence,
    ].join("\n"),
    10_000,
  );
}

function createBatchInput(input: {
  readonly pipeline: TrendAutomationPipeline;
  readonly candidate: TrendTopicCandidateView;
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly objective: string;
    readonly topicKey: string;
  };
  readonly accounts: readonly ChannelAccountView[];
  readonly availableAt: string;
  readonly uuid: () => string;
}): CreateAutomationBatchInput {
  const assignment = input.accounts.map((account) => ({
    platform: account.platform,
    channelAccountId: account.id,
  }));
  const lineageHash = sha256Canonical({
    schemaVersion: "geo.trend-automation-lineage.v1",
    tenantId: input.pipeline.tenantId,
    campaignId: input.campaign.id,
    trendFingerprint: input.candidate.fingerprint,
    firstObservedAt: input.candidate.firstObservedAt,
  });
  const requestMaterial = {
    schemaVersion: "geo.trend-automation-batch.v1",
    campaignId: input.campaign.id,
    trendFingerprint: input.candidate.fingerprint,
    observationIds: input.candidate.observationIds,
    assignment,
    executionLevel: input.pipeline.executionLevel,
  } as const;
  const batchId = input.uuid();
  const runId = input.uuid();
  const targets = input.accounts.map((account) => {
    const targetId = input.uuid();
    return {
      targetId,
      channelAccountId: account.id,
      variantIdempotencyKey: `automation:${runId}:target:${targetId}:variant:v1`,
      auditIdempotencyKey: `automation:${runId}:target:${targetId}:audit:v1`,
      publicationIdempotencyKey: `automation:${runId}:target:${targetId}:publication:v1`,
    };
  });
  return {
    batchId,
    campaignId: input.campaign.id,
    idempotencyKey: `trend-automation:v1:${lineageHash}`,
    requestHash: sha256Canonical(requestMaterial),
    name: boundedText(`热点自动分发 · ${input.candidate.title}`, 200),
    executionLevel: input.pipeline.executionLevel,
    runs: [
      {
        runId,
        slotKey: `trend:${input.candidate.fingerprint.slice(0, 24)}`,
        topicKey: boundedText(
          `${input.campaign.topicKey}:trend:${input.candidate.fingerprint.slice(0, 16)}`,
          200,
        ),
        brief: candidateBrief(input.candidate, input.campaign),
        availableAt: input.availableAt,
        idempotencyKey: `automation:${runId}:run:v1`,
        requestHash: sha256Canonical({ ...requestMaterial, run: "source-draft" }),
        targets,
      },
    ],
  };
}

export function parseTrendAutomationPipelines(raw: string): readonly TrendAutomationPipeline[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("TREND_AUTOMATION_PIPELINES_JSON must be valid JSON");
  }
  const parsed = pipelinesSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`TREND_AUTOMATION_PIPELINES_JSON is invalid: ${parsed.error.message}`);
  }
  return Object.entries(parsed.data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tenantId, pipeline]) => Object.freeze({ tenantId, ...pipeline }));
}

export class TrendAutomationLoop {
  readonly #repository: TrendAutomationLoopOptions["repository"];
  readonly #trendController: TrendAutomationLoopOptions["trendController"];
  readonly #pipelines: readonly TrendAutomationPipeline[];
  readonly #validateActor: TrendAutomationLoopOptions["validateActor"];
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #operationsEventBus: Pick<OperationsEventBus, "publishSnapshot"> | undefined;
  readonly #onRun: ((summary: TrendAutomationRunSummary) => void) | undefined;
  readonly #onError: ((errorCode: string) => void) | undefined;

  #controller: AbortController | undefined;
  #lifecycle: Promise<void> | undefined;

  constructor(options: TrendAutomationLoopOptions) {
    this.#repository = options.repository;
    this.#trendController = options.trendController;
    this.#pipelines = options.pipelines;
    this.#validateActor = options.validateActor;
    this.#enabled = options.enabled ?? false;
    this.#intervalMs = options.intervalMs ?? 600_000;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#operationsEventBus = options.operationsEventBus;
    this.#onRun = options.onRun;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new TypeError("Trend automation interval must be a positive safe integer");
    }
    if (this.#enabled && this.#pipelines.length === 0) {
      throw new TypeError("Enabled trend automation requires at least one pipeline");
    }
  }

  get running(): boolean {
    return this.#lifecycle !== undefined;
  }

  async runOnce(): Promise<TrendAutomationRunSummary> {
    const runId = this.#uuid();
    const startedAt = this.#now().toISOString();
    const pipelines: TrendAutomationPipelineSummary[] = [];
    const validatedActors = await Promise.all(
      this.#pipelines.map(async (pipeline) => {
        try {
          return await this.#validateActor(pipeline.tenantId, pipeline.actorId);
        } catch {
          return false;
        }
      }),
    );
    for (const [index, pipeline] of this.#pipelines.entries()) {
      if (validatedActors[index] !== true) {
        pipelines.push({
          tenantId: pipeline.tenantId,
          campaignId: pipeline.campaignId,
          status: "rejected",
          candidateCount: 0,
          createdBatchCount: 0,
          replayedBatchCount: 0,
          failedCandidateCount: 0,
          errorCodes: ["TREND_AUTOMATION_ACTOR_INVALID"],
          errorCode: "TREND_AUTOMATION_ACTOR_INVALID",
        });
        continue;
      }
      try {
        pipelines.push(await this.#runPipeline(runId, pipeline));
      } catch (error) {
        pipelines.push({
          tenantId: pipeline.tenantId,
          campaignId: pipeline.campaignId,
          status: "rejected",
          candidateCount: 0,
          createdBatchCount: 0,
          replayedBatchCount: 0,
          failedCandidateCount: 0,
          errorCodes: [safeErrorCode(error)],
          errorCode: safeErrorCode(error),
        });
      }
    }
    return {
      runId,
      startedAt,
      completedAt: this.#now().toISOString(),
      pipelines,
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
        this.#reportError(safeErrorCode(error, "TREND_AUTOMATION_RUN_FAILED"));
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

  async #runPipeline(
    runId: string,
    pipeline: TrendAutomationPipeline,
  ): Promise<TrendAutomationPipelineSummary> {
    const context = requestContext(pipeline, `trend-automation:${runId}:pipeline`);
    const campaigns = await this.#repository.listCampaigns(context);
    const campaign = campaigns.find(
      (item) => item.id === pipeline.campaignId && item.status === "active",
    );
    if (campaign === undefined) {
      const error = new Error("Configured trend automation campaign is not active");
      Object.assign(error, { code: "TREND_AUTOMATION_CAMPAIGN_UNAVAILABLE" });
      throw error;
    }
    const accounts = selectAccounts(await this.#repository.listChannelAccounts(context), pipeline);
    const candidates = await this.#trendController.listTopicCandidates(
      trendActor(pipeline, `trend-automation:${runId}:candidates`),
      {
        limit: Math.min(100, pipeline.maxNewBatchesPerRun * 4),
        lookbackMinutes: pipeline.lookbackMinutes,
        includeExpired: false,
      },
    );
    const selected = candidates.items.filter((item) => relevant(item, pipeline));
    let createdBatchCount = 0;
    let replayedBatchCount = 0;
    let failedCandidateCount = 0;
    const errorCodes = new Set<string>();
    for (const candidate of selected) {
      if (createdBatchCount >= pipeline.maxNewBatchesPerRun) break;
      const candidateContext = requestContext(
        pipeline,
        `trend-automation:${runId}:${candidate.fingerprint}`,
      );
      try {
        const result = await this.#repository.createAutomationBatch(
          candidateContext,
          createBatchInput({
            pipeline,
            candidate,
            campaign,
            accounts,
            availableAt: this.#now().toISOString(),
            uuid: this.#uuid,
          }),
        );
        if (result.wasCreated) {
          createdBatchCount += 1;
          try {
            this.#operationsEventBus?.publishSnapshot(pipeline.tenantId, this.#now().toISOString());
          } catch (error) {
            this.#reportError(safeErrorCode(error, "OPERATIONS_EVENT_PUBLISH_FAILED"));
          }
        } else {
          replayedBatchCount += 1;
        }
      } catch (error) {
        failedCandidateCount += 1;
        errorCodes.add(safeErrorCode(error));
      }
    }
    const completedBatchCount = createdBatchCount + replayedBatchCount;
    return {
      tenantId: pipeline.tenantId,
      campaignId: pipeline.campaignId,
      status:
        failedCandidateCount === 0
          ? "fulfilled"
          : completedBatchCount === 0
            ? "rejected"
            : "partial",
      candidateCount: selected.length,
      createdBatchCount,
      replayedBatchCount,
      failedCandidateCount,
      errorCodes: [...errorCodes].sort(),
    };
  }
}
