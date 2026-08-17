import type { ActorContext } from "@geo/contracts";
import type { TrendObservation } from "@geo/research";

export interface PersistTrendObservationInput extends TrendObservation {
  readonly id: string;
  readonly observationKey: string;
  readonly createdAt: string;
}

export interface PersistedTrendObservation extends PersistTrendObservationInput {
  readonly tenantId: string;
  readonly ingestedByActorId: string;
  readonly firstObservedAt: string;
}

export interface TrendObservationPersistResult {
  readonly observation: PersistedTrendObservation;
  readonly wasCreated: boolean;
}

export interface TrendObservationListInput {
  readonly observedAfter: string;
  readonly sourceKey?: string;
  readonly limit: number;
}

export interface TrendRepository {
  persistObservations(
    context: Readonly<ActorContext>,
    inputs: readonly Readonly<PersistTrendObservationInput>[],
  ): Promise<readonly TrendObservationPersistResult[]>;
  listObservations(
    context: Readonly<ActorContext>,
    input: Readonly<TrendObservationListInput>,
  ): Promise<readonly PersistedTrendObservation[]>;
}
