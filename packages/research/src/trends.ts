import { createHash } from "node:crypto";

export type TrendFreshnessBand = "emerging" | "rising" | "cooling" | "stale" | "expired";

export interface TrendObservationInput {
  readonly sourceKey: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly sourceRank?: number | undefined;
  readonly heatValue?: number | undefined;
  readonly observedAt: string;
  readonly sourceUpdatedAt?: string | undefined;
}

export interface TrendFreshness {
  readonly score: number;
  readonly band: TrendFreshnessBand;
  readonly ageMinutes: number;
}

export interface TrendObservation extends TrendObservationInput {
  readonly normalizedTitle: string;
  readonly fingerprint: string;
  readonly heatScore: number;
  readonly freshnessScore: number;
  readonly freshnessBand: TrendFreshnessBand;
}

export interface TrendCluster {
  readonly fingerprint: string;
  readonly title: string;
  readonly observations: readonly TrendObservation[];
  readonly heatScore: number;
  readonly freshnessScore: number;
  readonly freshnessBand: TrendFreshnessBand;
  readonly firstObservedAt: string;
  readonly latestObservedAt: string;
}

const MINUTE_MS = 60_000;
const DEFAULT_HALF_LIFE_MINUTES = 360;

function finiteNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid trend timestamp: ${value}`);
  return parsed;
}

export function normalizeTrendTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function tokenSet(value: string): ReadonlySet<string> {
  const normalized = normalizeTrendTitle(value);
  const tokens = new Set<string>();
  const chars = Array.from(normalized);
  for (const character of chars) tokens.add(character);
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.add(`${chars[index]}${chars[index + 1]}`);
  }
  return tokens;
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = tokenSet(left);
  const b = tokenSet(right);
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function trendFreshness(
  input: Pick<TrendObservationInput, "observedAt" | "sourceUpdatedAt">,
  now: Date,
  options: { readonly halfLifeMinutes?: number; readonly expiryMinutes?: number } = {},
): TrendFreshness {
  const observedAt = parseDate(input.observedAt);
  const reference =
    input.sourceUpdatedAt === undefined ? observedAt : parseDate(input.sourceUpdatedAt);
  const ageMinutes = Math.max(0, (now.getTime() - reference) / MINUTE_MS);
  const expiryMinutes = options.expiryMinutes ?? DEFAULT_HALF_LIFE_MINUTES * 6;
  if (ageMinutes >= expiryMinutes) return { score: 0, band: "expired", ageMinutes };
  const halfLife = Math.max(1, options.halfLifeMinutes ?? DEFAULT_HALF_LIFE_MINUTES);
  const score = clamp(Math.exp(-ageMinutes / halfLife), 0, 1);
  const band: TrendFreshnessBand =
    score >= 0.9 ? "emerging" : score >= 0.65 ? "rising" : score >= 0.35 ? "cooling" : "stale";
  return { score, band, ageMinutes };
}

function heatScore(input: TrendObservationInput): number {
  if (input.heatValue !== undefined && Number.isFinite(input.heatValue)) {
    const normalized = 100 * (1 - Math.exp(-input.heatValue / 10_000));
    return clamp(normalized, 0, 100);
  }
  const rank = finiteNumber(input.sourceRank, 100);
  return clamp(100 - Math.max(0, rank - 1) * 4, 1, 100);
}

export function buildTrendObservation(input: TrendObservationInput, now: Date): TrendObservation {
  const normalizedTitle = normalizeTrendTitle(input.title);
  const normalizedLength = Array.from(normalizedTitle).length;
  if (normalizedLength < 2 || normalizedLength > 300) {
    throw new TypeError("Normalized trend title must contain between 2 and 300 characters");
  }
  const freshness = trendFreshness(input, now);
  return {
    ...input,
    normalizedTitle,
    fingerprint: createHash("sha256").update(normalizedTitle).digest("hex"),
    heatScore: heatScore(input),
    freshnessScore: freshness.score,
    freshnessBand: freshness.band,
  };
}

export function clusterTrendObservations(
  observations: readonly TrendObservation[],
  similarityThreshold = 0.68,
): readonly TrendCluster[] {
  const clusters: Array<{ observations: TrendObservation[] }> = [];
  for (const observation of observations) {
    const match = clusters.find((candidate) =>
      candidate.observations.some(
        (existing) =>
          similarity(existing.normalizedTitle, observation.normalizedTitle) >= similarityThreshold,
      ),
    );
    if (match === undefined) clusters.push({ observations: [observation] });
    else match.observations.push(observation);
  }
  return clusters
    .map(({ observations: members }) => {
      const ordered = [...members].sort(
        (left, right) =>
          right.freshnessScore - left.freshnessScore || right.heatScore - left.heatScore,
      );
      const firstObservedAt = members.reduce(
        (earliest, member) =>
          parseDate(member.observedAt) < parseDate(earliest) ? member.observedAt : earliest,
        members[0]?.observedAt ?? new Date(0).toISOString(),
      );
      const latestObservedAt = members.reduce(
        (latest, member) =>
          parseDate(member.observedAt) > parseDate(latest) ? member.observedAt : latest,
        members[0]?.observedAt ?? new Date(0).toISOString(),
      );
      const representative = ordered[0] as TrendObservation;
      return {
        fingerprint: representative.fingerprint,
        title: representative.normalizedTitle,
        observations: ordered,
        heatScore: Math.max(...members.map((member) => member.heatScore)),
        freshnessScore: Math.max(...members.map((member) => member.freshnessScore)),
        freshnessBand: representative.freshnessBand,
        firstObservedAt,
        latestObservedAt,
      } satisfies TrendCluster;
    })
    .sort(
      (left, right) =>
        right.freshnessScore - left.freshnessScore || right.heatScore - left.heatScore,
    );
}
