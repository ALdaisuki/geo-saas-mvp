import { createHash, randomUUID } from "node:crypto";

import { requireCapability } from "@geo/authz";
import type { ActorContext } from "@geo/contracts";
import {
  buildTrendObservation,
  clusterTrendObservations,
  type TrendFreshnessBand,
  type TrendObservation,
} from "@geo/research";

import {
  trendObservationIngestRequestSchema,
  trendTopicCandidateListQuerySchema,
  type TrendObservationIngestRequest,
  type TrendTopicCandidateListQuery,
} from "./trend-contracts.js";
import type {
  PersistTrendObservationInput,
  PersistedTrendObservation,
  TrendRepository,
} from "./trend-repository.js";

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_OBSERVATIONS_PER_QUERY = 300;
const MIN_OBSERVATIONS_PER_QUERY = 100;

export interface TrendSourcePolicy {
  readonly sourceKey: string;
  readonly allowedHosts: readonly string[];
}

export const DEFAULT_TREND_SOURCE_POLICIES: readonly TrendSourcePolicy[] = [
  { sourceKey: "toutiao", allowedHosts: ["toutiao.com"] },
  { sourceKey: "baidu", allowedHosts: ["baidu.com"] },
  { sourceKey: "weibo", allowedHosts: ["weibo.com"] },
  { sourceKey: "zhihu", allowedHosts: ["zhihu.com"] },
  { sourceKey: "sohu-news", allowedHosts: ["sohu.com"] },
  { sourceKey: "netease-news", allowedHosts: ["163.com"] },
] as const;

export interface TrendServiceOptions {
  readonly repository: TrendRepository;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly sourcePolicies?: readonly TrendSourcePolicy[];
}

export interface TrendIngestResult {
  readonly items: readonly PersistedTrendObservation[];
  readonly createdCount: number;
  readonly replayedCount: number;
}

export interface TrendTopicCandidateView {
  readonly id: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly observationIds: readonly string[];
  readonly observationCount: number;
  readonly sourceCount: number;
  readonly sourceKeys: readonly string[];
  readonly observations: readonly TrendTopicCandidateObservationView[];
  readonly heatScore: number;
  readonly freshnessScore: number;
  readonly freshnessBand: TrendFreshnessBand;
  readonly firstObservedAt: string;
  readonly latestObservedAt: string;
}

export interface TrendTopicCandidateObservationView extends TrendObservation {
  readonly id: string;
  readonly createdAt: string;
  readonly firstObservedAt: string;
}

export interface TrendTopicCandidateListResult {
  readonly items: readonly TrendTopicCandidateView[];
  readonly generatedAt: string;
  readonly lookbackMinutes: number;
  readonly observationLimitReached: boolean;
}

export interface TrendController {
  ingest(
    actor: Readonly<ActorContext>,
    request: TrendObservationIngestRequest,
  ): Promise<TrendIngestResult>;
  listTopicCandidates(
    actor: Readonly<ActorContext>,
    query: TrendTopicCandidateListQuery,
  ): Promise<TrendTopicCandidateListResult>;
}

export class TrendServiceError extends Error {
  readonly statusCode = 422;

  constructor(
    readonly code:
      | "TREND_OBSERVATION_INVALID"
      | "TREND_SOURCE_NOT_ALLOWED"
      | "TREND_SOURCE_URL_NOT_ALLOWED"
      | "TREND_TIMESTAMP_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "TrendServiceError";
  }
}

function hostnameAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
  return allowedHosts.some((allowedHost) => {
    const allowed = allowedHost.toLocaleLowerCase("en-US").replace(/\.$/u, "");
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

function observationKey(input: {
  readonly sourceKey: string;
  readonly normalizedTitle: string;
  readonly summary?: string | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly sourceRank?: number | undefined;
  readonly heatValue?: number | undefined;
  readonly observedAt: string;
  readonly sourceUpdatedAt?: string | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.sourceKey,
        input.normalizedTitle,
        input.summary ?? null,
        input.canonicalUrl ?? null,
        input.sourceRank ?? null,
        input.heatValue ?? null,
        new Date(input.observedAt).toISOString(),
        input.sourceUpdatedAt === undefined ? null : new Date(input.sourceUpdatedAt).toISOString(),
      ]),
    )
    .digest("hex");
}

function assertTimestampBounds(
  input: { readonly observedAt: string; readonly sourceUpdatedAt?: string | undefined },
  now: Date,
): void {
  const latestAllowed = now.getTime() + MAX_FUTURE_SKEW_MS;
  if (
    Date.parse(input.observedAt) > latestAllowed ||
    (input.sourceUpdatedAt !== undefined && Date.parse(input.sourceUpdatedAt) > latestAllowed)
  ) {
    throw new TrendServiceError(
      "TREND_TIMESTAMP_INVALID",
      "Trend observation timestamp cannot be in the future",
    );
  }
}

function candidateFromCluster(
  cluster: ReturnType<typeof clusterTrendObservations>[number],
  rowsByObservationKey: ReadonlyMap<string, PersistedTrendObservation>,
): TrendTopicCandidateView {
  const representative = cluster.observations[0];
  const observations = cluster.observations.map((observation) => {
    const stored = rowsByObservationKey.get(
      observationKey({
        sourceKey: observation.sourceKey,
        normalizedTitle: observation.normalizedTitle,
        summary: observation.summary,
        canonicalUrl: observation.canonicalUrl,
        sourceRank: observation.sourceRank,
        heatValue: observation.heatValue,
        observedAt: observation.observedAt,
        sourceUpdatedAt: observation.sourceUpdatedAt,
      }),
    );
    if (stored === undefined) {
      throw new Error("Clustered trend observation is missing its persisted identity");
    }
    return {
      ...observation,
      id: stored.id,
      createdAt: stored.createdAt,
      firstObservedAt: stored.firstObservedAt,
    };
  });
  const sourceKeys = [...new Set(cluster.observations.map((item) => item.sourceKey))].sort();
  return {
    id: cluster.fingerprint,
    fingerprint: cluster.fingerprint,
    title: representative?.title ?? cluster.title,
    normalizedTitle: cluster.title,
    observationIds: observations.map((item) => item.id),
    observationCount: cluster.observations.length,
    sourceCount: sourceKeys.length,
    sourceKeys,
    observations,
    heatScore: cluster.heatScore,
    freshnessScore: cluster.freshnessScore,
    freshnessBand: cluster.freshnessBand,
    firstObservedAt: observations.reduce(
      (earliest, observation) =>
        Date.parse(observation.firstObservedAt) < Date.parse(earliest)
          ? observation.firstObservedAt
          : earliest,
      observations[0]?.firstObservedAt ?? cluster.firstObservedAt,
    ),
    latestObservedAt: cluster.latestObservedAt,
  };
}

export class TrendService implements TrendController {
  readonly #repository: TrendRepository;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #sourcePolicies: ReadonlyMap<string, TrendSourcePolicy>;

  constructor(options: TrendServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    const policies = options.sourcePolicies ?? DEFAULT_TREND_SOURCE_POLICIES;
    this.#sourcePolicies = new Map(policies.map((policy) => [policy.sourceKey, policy]));
  }

  async ingest(
    actor: Readonly<ActorContext>,
    request: TrendObservationIngestRequest,
  ): Promise<TrendIngestResult> {
    requireCapability(actor, "automation:execute");
    const parsed = trendObservationIngestRequestSchema.parse(request);
    const now = this.#now();
    const createdAt = now.toISOString();
    const inputs: PersistTrendObservationInput[] = parsed.observations.map((input) => {
      const sourcePolicy = this.#sourcePolicies.get(input.sourceKey);
      if (sourcePolicy === undefined) {
        throw new TrendServiceError(
          "TREND_SOURCE_NOT_ALLOWED",
          `Trend source is not registered: ${input.sourceKey}`,
        );
      }
      if (
        input.canonicalUrl !== undefined &&
        !hostnameAllowed(new URL(input.canonicalUrl).hostname, sourcePolicy.allowedHosts)
      ) {
        throw new TrendServiceError(
          "TREND_SOURCE_URL_NOT_ALLOWED",
          `Trend source URL host is not allowed for ${input.sourceKey}`,
        );
      }
      assertTimestampBounds(input, now);
      let observation: ReturnType<typeof buildTrendObservation>;
      try {
        observation = buildTrendObservation(input, now);
      } catch (error) {
        if (error instanceof TypeError) {
          throw new TrendServiceError("TREND_OBSERVATION_INVALID", error.message);
        }
        throw error;
      }
      return {
        ...observation,
        id: this.#uuid(),
        observationKey: observationKey(observation),
        createdAt,
      };
    });
    const results = await this.#repository.persistObservations(actor, inputs);
    const createdCount = results.filter((result) => result.wasCreated).length;
    return {
      items: results.map((result) => result.observation),
      createdCount,
      replayedCount: results.length - createdCount,
    };
  }

  async listTopicCandidates(
    actor: Readonly<ActorContext>,
    query: TrendTopicCandidateListQuery,
  ): Promise<TrendTopicCandidateListResult> {
    requireCapability(actor, "content:read");
    const parsed = trendTopicCandidateListQuerySchema.parse(query);
    const now = this.#now();
    const observationLimit = Math.min(
      MAX_OBSERVATIONS_PER_QUERY,
      Math.max(MIN_OBSERVATIONS_PER_QUERY, parsed.limit * 3),
    );
    const observedAfter = new Date(now.getTime() - parsed.lookbackMinutes * 60_000).toISOString();
    const rows = await this.#repository.listObservations(actor, {
      observedAfter,
      limit: observationLimit + 1,
      ...(parsed.sourceKey === undefined ? {} : { sourceKey: parsed.sourceKey }),
    });
    const boundedRows = rows.slice(0, observationLimit);
    const rowsByObservationKey = new Map(boundedRows.map((row) => [row.observationKey, row]));
    const clusters = clusterTrendObservations(
      boundedRows.map((row) =>
        buildTrendObservation(
          {
            sourceKey: row.sourceKey,
            title: row.title,
            summary: row.summary,
            canonicalUrl: row.canonicalUrl,
            sourceRank: row.sourceRank,
            heatValue: row.heatValue,
            observedAt: row.observedAt,
            sourceUpdatedAt: row.sourceUpdatedAt,
          },
          now,
        ),
      ),
    );
    const items = clusters
      .filter((cluster) => parsed.includeExpired || cluster.freshnessBand !== "expired")
      .slice(0, parsed.limit)
      .map((cluster) => candidateFromCluster(cluster, rowsByObservationKey));
    return {
      items,
      generatedAt: now.toISOString(),
      lookbackMinutes: parsed.lookbackMinutes,
      observationLimitReached: rows.length > observationLimit,
    };
  }
}
