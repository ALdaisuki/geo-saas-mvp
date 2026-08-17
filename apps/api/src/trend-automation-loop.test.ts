import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateAutomationBatchInput } from "./automation-repository.js";
import type { ApiRepository, RequestContext } from "./repository.js";
import { TrendAutomationLoop, parseTrendAutomationPipelines } from "./trend-automation-loop.js";
import type { TrendController, TrendTopicCandidateView } from "./trend-service.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  campaign: "10000000-0000-4000-8000-000000000003",
  brand: "10000000-0000-4000-8000-000000000004",
  toutiao: "10000000-0000-4000-8000-000000000101",
  sohu: "10000000-0000-4000-8000-000000000102",
  baijiahao: "10000000-0000-4000-8000-000000000103",
  netease: "10000000-0000-4000-8000-000000000104",
} as const;

const candidate: TrendTopicCandidateView = {
  id: "a".repeat(64),
  fingerprint: "a".repeat(64),
  title: "暑期云南旅游避坑与行程准备",
  normalizedTitle: "暑期云南旅游避坑与行程准备",
  observationIds: ["10000000-0000-4000-8000-000000000201"],
  observationCount: 1,
  sourceCount: 1,
  sourceKeys: ["toutiao"],
  observations: [
    {
      id: "10000000-0000-4000-8000-000000000201",
      sourceKey: "toutiao",
      title: "暑期云南旅游避坑与行程准备",
      summary: "围绕暑期云南出行安全、线路选择和报团注意事项。",
      canonicalUrl: "https://www.toutiao.com/trending/123",
      sourceRank: 1,
      heatValue: 98,
      observedAt: "2026-08-03T00:00:00.000Z",
      sourceUpdatedAt: "2026-08-03T00:00:00.000Z",
      normalizedTitle: "暑期云南旅游避坑与行程准备",
      fingerprint: "a".repeat(64),
      heatScore: 98,
      freshnessScore: 1,
      freshnessBand: "emerging",
      createdAt: "2026-08-03T00:00:01.000Z",
      firstObservedAt: "2026-08-03T00:00:00.000Z",
    },
  ],
  heatScore: 98,
  freshnessScore: 1,
  freshnessBand: "emerging",
  firstObservedAt: "2026-08-03T00:00:00.000Z",
  latestObservedAt: "2026-08-03T00:00:00.000Z",
};

function pipelineJson(): string {
  return JSON.stringify({
    [ids.tenant]: {
      actorId: ids.actor,
      campaignId: ids.campaign,
      platforms: ["toutiao", "sohu", "baijiahao", "netease"],
      executionLevel: "dry_run",
      maxNewBatchesPerRun: 20,
      lookbackMinutes: 1_440,
      minFreshnessScore: 0.65,
      relevanceTerms: ["云南", "旅游", "旅行社"],
    },
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("trend automation pipeline configuration", () => {
  it("parses a tenant-scoped four-platform pipeline", () => {
    expect(parseTrendAutomationPipelines(pipelineJson())).toEqual([
      {
        tenantId: ids.tenant,
        actorId: ids.actor,
        campaignId: ids.campaign,
        platforms: ["toutiao", "sohu", "baijiahao", "netease"],
        executionLevel: "dry_run",
        maxNewBatchesPerRun: 20,
        lookbackMinutes: 1_440,
        minFreshnessScore: 0.65,
        relevanceTerms: ["云南", "旅游", "旅行社"],
      },
    ]);
  });
});

describe("TrendAutomationLoop", () => {
  it("turns one relevant fresh trend into one account-bound four-platform batch", async () => {
    const createInputs: Array<{
      readonly context: RequestContext;
      readonly input: CreateAutomationBatchInput;
    }> = [];
    let createCallCount = 0;
    const repository: Pick<
      ApiRepository,
      "listCampaigns" | "listChannelAccounts" | "createAutomationBatch"
    > = {
      listCampaigns: vi.fn(async () => [
        {
          id: ids.campaign,
          brandId: ids.brand,
          name: "云南暑期软广",
          objective: "以实用云南旅行攻略自然带出旅行社服务",
          industry: "travel",
          status: "active" as const,
          topicKey: "yunnan-travel",
          automationRemediationEnabled: true,
          promptTemplate: null,
        },
      ]),
      listChannelAccounts: vi.fn(async () =>
        [
          [ids.toutiao, "toutiao"],
          [ids.sohu, "sohu"],
          [ids.baijiahao, "baijiahao"],
          [ids.netease, "netease"],
        ].map(([id, platform]) => ({
          id: id as string,
          platform: platform as "toutiao" | "sohu" | "baijiahao" | "netease",
          displayName: `${platform} account`,
          capability: "manual_only" as const,
          supportedExecutionLevels: ["dry_run" as const],
          evidenceType: "preview" as const,
          evidenceRefs: ["test"],
          status: "active",
          lastVerifiedAt: null,
          dailyPublishQuota: 100,
        })),
      ),
      createAutomationBatch: vi.fn(async (context, input) => {
        createInputs.push({ context, input });
        return {
          wasCreated: createCallCount++ === 0,
          batch: {
            id: input.batchId,
            campaignId: input.campaignId,
            name: input.name,
            state: "scheduled" as const,
            executionLevel: input.executionLevel,
            scheduledFor: input.runs[0]?.availableAt ?? "2026-08-03T00:01:00.000Z",
            runCount: input.runs.length,
            completedRunCount: 0,
            failedRunCount: 0,
            deliveryFailedRunCount: 0,
            cancelledRunCount: 0,
            terminalRunCount: 0,
            createdAt: "2026-08-03T00:01:00.000Z",
            updatedAt: "2026-08-03T00:01:00.000Z",
          },
        };
      }),
    };
    const trendController: Pick<TrendController, "listTopicCandidates"> = {
      listTopicCandidates: vi.fn(async () => ({
        items: [candidate],
        generatedAt: "2026-08-03T00:01:00.000Z",
        lookbackMinutes: 1_440,
        observationLimitReached: false,
      })),
    };
    const uuids = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004",
      "20000000-0000-4000-8000-000000000005",
      "20000000-0000-4000-8000-000000000006",
    ];
    const validateActor = vi.fn(async () => true);
    const publishSnapshot = vi.fn();
    const loop = new TrendAutomationLoop({
      repository,
      trendController,
      pipelines: parseTrendAutomationPipelines(pipelineJson()),
      validateActor,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
      uuid: () => uuids.shift() ?? "20000000-0000-4000-8000-000000000099",
      operationsEventBus: { publishSnapshot },
    });

    const result = await loop.runOnce();

    expect(result.pipelines).toEqual([
      expect.objectContaining({
        tenantId: ids.tenant,
        status: "fulfilled",
        candidateCount: 1,
        createdBatchCount: 1,
        replayedBatchCount: 0,
      }),
    ]);
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]?.context).toEqual({
      tenantId: ids.tenant,
      actorId: ids.actor,
      requestId: `trend-automation:${result.runId}:${candidate.fingerprint}`,
    });
    expect(createInputs[0]?.input).toMatchObject({
      campaignId: ids.campaign,
      executionLevel: "dry_run",
      runs: [
        {
          topicKey: `yunnan-travel:trend:${candidate.fingerprint.slice(0, 16)}`,
          targets: [
            { channelAccountId: ids.toutiao },
            { channelAccountId: ids.sohu },
            { channelAccountId: ids.baijiahao },
            { channelAccountId: ids.netease },
          ],
        },
      ],
    });
    expect(createInputs[0]?.input.runs[0]?.brief).toContain(candidate.title);
    expect(createInputs[0]?.input.runs[0]?.brief).toContain("https://www.toutiao.com/trending/123");
    expect(validateActor).toHaveBeenCalledWith(ids.tenant, ids.actor);
    expect(publishSnapshot).toHaveBeenCalledOnce();
    expect(publishSnapshot).toHaveBeenCalledWith(ids.tenant, "2026-08-03T00:01:00.000Z");

    const replay = await loop.runOnce();

    expect(replay.pipelines).toEqual([
      expect.objectContaining({ createdBatchCount: 0, replayedBatchCount: 1 }),
    ]);
    expect(publishSnapshot).toHaveBeenCalledOnce();
  });

  it("isolates one failed candidate and continues creating later batches", async () => {
    const secondCandidate: TrendTopicCandidateView = {
      ...candidate,
      id: "b".repeat(64),
      fingerprint: "b".repeat(64),
      title: "云南暑期跟团游行前清单",
      normalizedTitle: "云南暑期跟团游行前清单",
      observationIds: ["10000000-0000-4000-8000-000000000202"],
      observations: candidate.observations.map((observation) => ({
        ...observation,
        id: "10000000-0000-4000-8000-000000000202",
        title: "云南暑期跟团游行前清单",
        normalizedTitle: "云南暑期跟团游行前清单",
        fingerprint: "b".repeat(64),
      })),
    };
    const repository: Pick<
      ApiRepository,
      "listCampaigns" | "listChannelAccounts" | "createAutomationBatch"
    > = {
      listCampaigns: vi.fn(async () => [
        {
          id: ids.campaign,
          brandId: ids.brand,
          name: "云南暑期软广",
          objective: "以实用云南旅行攻略自然带出旅行社服务",
          industry: "travel",
          status: "active" as const,
          topicKey: "yunnan-travel",
          automationRemediationEnabled: true,
          promptTemplate: null,
        },
      ]),
      listChannelAccounts: vi.fn(async () =>
        [
          [ids.toutiao, "toutiao"],
          [ids.sohu, "sohu"],
          [ids.baijiahao, "baijiahao"],
          [ids.netease, "netease"],
        ].map(([id, platform]) => ({
          id: id as string,
          platform: platform as "toutiao" | "sohu" | "baijiahao" | "netease",
          displayName: `${platform} account`,
          capability: "manual_only" as const,
          supportedExecutionLevels: ["dry_run" as const],
          evidenceType: "preview" as const,
          evidenceRefs: ["test"],
          status: "active",
          lastVerifiedAt: null,
        })),
      ),
      createAutomationBatch: vi.fn(async (_context, input) => {
        if (input.runs[0]?.topicKey.includes("aaaaaaaaaaaaaaaa")) {
          throw Object.assign(new Error("candidate conflict"), {
            code: "AUTOMATION_IDEMPOTENCY_CONFLICT",
          });
        }
        return {
          wasCreated: true,
          batch: {
            id: input.batchId,
            campaignId: input.campaignId,
            name: input.name,
            state: "scheduled" as const,
            executionLevel: input.executionLevel,
            scheduledFor: input.runs[0]?.availableAt ?? "2026-08-03T00:01:00.000Z",
            runCount: 1,
            completedRunCount: 0,
            failedRunCount: 0,
            deliveryFailedRunCount: 0,
            cancelledRunCount: 0,
            terminalRunCount: 0,
            createdAt: "2026-08-03T00:01:00.000Z",
            updatedAt: "2026-08-03T00:01:00.000Z",
          },
        };
      }),
    };
    const loop = new TrendAutomationLoop({
      repository,
      trendController: {
        listTopicCandidates: vi.fn(async () => ({
          items: [candidate, secondCandidate],
          generatedAt: "2026-08-03T00:01:00.000Z",
          lookbackMinutes: 1_440,
          observationLimitReached: false,
        })),
      },
      pipelines: parseTrendAutomationPipelines(pipelineJson()),
      validateActor: async () => true,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
    });

    const result = await loop.runOnce();

    expect(result.pipelines).toEqual([
      expect.objectContaining({
        status: "partial",
        candidateCount: 2,
        createdBatchCount: 1,
        replayedBatchCount: 0,
        failedCandidateCount: 1,
        errorCodes: ["AUTOMATION_IDEMPOTENCY_CONFLICT"],
      }),
    ]);
    expect(repository.createAutomationBatch).toHaveBeenCalledTimes(2);
  });

  it("rejects an unverified actor before reading tenant resources or creating a batch", async () => {
    const repository: Pick<
      ApiRepository,
      "listCampaigns" | "listChannelAccounts" | "createAutomationBatch"
    > = {
      listCampaigns: vi.fn(),
      listChannelAccounts: vi.fn(),
      createAutomationBatch: vi.fn(),
    };
    const listTopicCandidates = vi.fn();
    const validateActor = vi.fn(async () => false);
    const loop = new TrendAutomationLoop({
      repository,
      trendController: { listTopicCandidates },
      pipelines: parseTrendAutomationPipelines(pipelineJson()),
      validateActor,
      now: () => new Date("2026-08-03T00:01:00.000Z"),
      uuid: () => "20000000-0000-4000-8000-000000000001",
    });

    const result = await loop.runOnce();

    expect(validateActor).toHaveBeenCalledWith(ids.tenant, ids.actor);
    expect(repository.listCampaigns).not.toHaveBeenCalled();
    expect(repository.listChannelAccounts).not.toHaveBeenCalled();
    expect(listTopicCandidates).not.toHaveBeenCalled();
    expect(repository.createAutomationBatch).not.toHaveBeenCalled();
    expect(result.pipelines).toEqual([
      {
        tenantId: ids.tenant,
        campaignId: ids.campaign,
        status: "rejected",
        candidateCount: 0,
        createdBatchCount: 0,
        replayedBatchCount: 0,
        failedCandidateCount: 0,
        errorCodes: ["TREND_AUTOMATION_ACTOR_INVALID"],
        errorCode: "TREND_AUTOMATION_ACTOR_INVALID",
      },
    ]);
  });

  it("runs immediately without overlapping ticks and stops the interval wait", async () => {
    vi.useFakeTimers();
    const validateActor = vi.fn(async () => false);
    const onRun = vi.fn();
    const loop = new TrendAutomationLoop({
      repository: {
        listCampaigns: vi.fn(),
        listChannelAccounts: vi.fn(),
        createAutomationBatch: vi.fn(),
      },
      trendController: { listTopicCandidates: vi.fn() },
      pipelines: parseTrendAutomationPipelines(pipelineJson()),
      validateActor,
      enabled: true,
      intervalMs: 1_000,
      onRun,
    });

    const lifecycle = loop.start();
    expect(loop.start()).toBe(lifecycle);
    await vi.advanceTimersByTimeAsync(0);
    expect(validateActor).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(validateActor).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(validateActor).toHaveBeenCalledTimes(2);

    await loop.stop();
    await lifecycle;
    expect(loop.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the background lifecycle alive when run reporting fails", async () => {
    vi.useFakeTimers();
    const validateActor = vi.fn(async () => false);
    const onRun = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("reporting failed"), {
          code: "TREND_AUTOMATION_REPORTING_FAILED",
        });
      })
      .mockImplementation(() => undefined);
    const onError = vi.fn().mockImplementationOnce(() => {
      throw new Error("error sink failed");
    });
    const loop = new TrendAutomationLoop({
      repository: {
        listCampaigns: vi.fn(),
        listChannelAccounts: vi.fn(),
        createAutomationBatch: vi.fn(),
      },
      trendController: { listTopicCandidates: vi.fn() },
      pipelines: parseTrendAutomationPipelines(pipelineJson()),
      validateActor,
      enabled: true,
      intervalMs: 1_000,
      onRun,
      onError,
    });

    const lifecycle = loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith("TREND_AUTOMATION_REPORTING_FAILED");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(loop.running).toBe(true);

    await loop.stop();
    await lifecycle;
  });

  it("does not start unless explicitly enabled and rejects enabled empty configuration", async () => {
    vi.useFakeTimers();
    const validateActor = vi.fn(async () => true);
    const options = {
      repository: {
        listCampaigns: vi.fn(),
        listChannelAccounts: vi.fn(),
        createAutomationBatch: vi.fn(),
      },
      trendController: { listTopicCandidates: vi.fn() },
      pipelines: [],
      validateActor,
    } as const;
    const loop = new TrendAutomationLoop(options);

    await loop.start();

    expect(validateActor).not.toHaveBeenCalled();
    expect(loop.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => new TrendAutomationLoop({ ...options, enabled: true })).toThrow(
      "Enabled trend automation requires at least one pipeline",
    );
  });
});
