import type { ActorContext } from "@geo/contracts";
import type { ResearchPageSnapshot, ResearchPolicy } from "@geo/research";

export interface ResearchSourcePolicyView extends ResearchPolicy {
  readonly id: string;
  readonly sourceKey: string;
  readonly version: number;
  readonly displayName: string;
  readonly origin: string;
  readonly status: "active" | "retired";
  readonly createdByActorId: string;
  readonly retiredByActorId: string | null;
  readonly retirementReason: string | null;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

export interface ResearchCaptureView {
  readonly id: string;
  readonly sourcePolicyId: string;
  readonly operation: "page_capture" | "sitemap_discovery";
  readonly status: "succeeded" | "failed";
  readonly requestUrlHash: string;
  readonly evidenceSourceId: string | null;
  readonly errorCode: string | null;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
  readonly capturedByActorId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly createdAt: string;
}

export interface CreateResearchSourcePolicyInput extends ResearchPolicy {
  readonly id: string;
  readonly sourceKey: string;
  readonly displayName: string;
  readonly origin: string;
  readonly createdAt: string;
}

export interface RetireResearchSourcePolicyInput {
  readonly sourcePolicyId: string;
  readonly reason: string;
  readonly retiredAt: string;
}

interface CaptureRecordInput {
  readonly captureId: string;
  readonly sourcePolicyId: string;
  readonly requestUrlHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface PersistPageCaptureInput extends CaptureRecordInput {
  readonly evidenceSourceId: string;
  readonly snapshot: ResearchPageSnapshot;
}

export interface PersistSitemapDiscoveryInput extends CaptureRecordInput {
  readonly discoveredUrls: readonly string[];
}

export interface PersistResearchCaptureFailureInput extends CaptureRecordInput {
  readonly operation: ResearchCaptureView["operation"];
  readonly errorCode: string;
}

export interface ResearchRepository {
  listSources(context: Readonly<ActorContext>): Promise<readonly ResearchSourcePolicyView[]>;
  createSource(
    context: Readonly<ActorContext>,
    input: Readonly<CreateResearchSourcePolicyInput>,
  ): Promise<ResearchSourcePolicyView>;
  retireSource(
    context: Readonly<ActorContext>,
    input: Readonly<RetireResearchSourcePolicyInput>,
  ): Promise<{ readonly source: ResearchSourcePolicyView; readonly wasChanged: boolean }>;
  getActiveSource(
    context: Readonly<ActorContext>,
    sourcePolicyId: string,
  ): Promise<ResearchSourcePolicyView | null>;
  listCaptures(
    context: Readonly<ActorContext>,
    input: { readonly sourcePolicyId?: string; readonly limit: number },
  ): Promise<readonly ResearchCaptureView[]>;
  persistPageCapture(
    context: Readonly<ActorContext>,
    input: Readonly<PersistPageCaptureInput>,
  ): Promise<ResearchCaptureView>;
  persistSitemapDiscovery(
    context: Readonly<ActorContext>,
    input: Readonly<PersistSitemapDiscoveryInput>,
  ): Promise<ResearchCaptureView>;
  persistCaptureFailure(
    context: Readonly<ActorContext>,
    input: Readonly<PersistResearchCaptureFailureInput>,
  ): Promise<ResearchCaptureView>;
}

export class ResearchRepositoryNotFoundError extends Error {
  readonly code = "RESEARCH_SOURCE_NOT_FOUND";

  constructor(message = "Research source policy was not found") {
    super(message);
    this.name = "ResearchRepositoryNotFoundError";
  }
}

export class ResearchRepositoryConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ResearchRepositoryConflictError";
    this.code = code;
  }
}
