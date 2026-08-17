import type { VisibilityProvider } from "@geo/contracts";

import type { AdapterEvidence, VisibilityAdapter, VisibilitySampleRequest } from "./types.js";

export interface FixtureAnswer {
  answer: string;
  citedUrls?: string[];
}

export class FixtureVisibilityAdapter implements VisibilityAdapter {
  public readonly method = "fixture" as const;

  public constructor(
    public readonly provider: VisibilityProvider,
    private readonly answers: Readonly<Record<string, FixtureAnswer>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async sample(request: VisibilitySampleRequest): Promise<AdapterEvidence> {
    if (request.provider !== this.provider) {
      throw new Error(`Adapter provider ${this.provider} cannot sample ${request.provider}`);
    }

    const fixture = this.answers[request.query.id];
    if (fixture === undefined) {
      throw new Error(`No ${this.provider} fixture for query ${request.query.id}`);
    }

    const completedAt = this.clock().toISOString();
    return Promise.resolve({
      rawAnswer: fixture.answer,
      citedUrls: fixture.citedUrls ?? [],
      requestStartedAt: completedAt,
      responseReceivedAt: completedAt,
      observedAt: completedAt,
      observationMethod: "fixture",
      evidenceType: "fixture",
    });
  }
}

export class ManualVisibilityAdapter implements VisibilityAdapter {
  public readonly method = "manual" as const;

  public constructor(
    public readonly provider: VisibilityProvider,
    private readonly importer: (request: VisibilitySampleRequest) => Promise<AdapterEvidence>,
  ) {}

  public async sample(request: VisibilitySampleRequest): Promise<AdapterEvidence> {
    if (request.provider !== this.provider) {
      throw new Error(`Adapter provider ${this.provider} cannot sample ${request.provider}`);
    }

    const evidence = await this.importer(request);
    if (evidence.observationMethod !== "manual" || evidence.evidenceType !== "manual_import") {
      throw new Error("Manual adapters must return manual/manual_import evidence");
    }

    return evidence;
  }
}
