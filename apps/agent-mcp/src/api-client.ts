import type { ActorContext, ExecutionLevel, Platform, VisibilityProvider } from "@geo/contracts";

export interface TenantFactLookupInput {
  brandId: string;
  query: string;
  limit?: number;
}

export interface DraftProposalInput {
  brandId: string;
  campaignId: string;
  brief: string;
  idempotencyKey: string;
  fixtureMode?: boolean;
}

export interface VariantPreviewInput {
  contentVersionId: string;
  channelAccountId: string;
  platform: Platform;
}

export interface AuditRequestInput {
  variantId: string;
  idempotencyKey: string;
}

export interface PublicationRequestInput {
  variantId: string;
  channelAccountId: string;
  executionLevel: ExecutionLevel;
  idempotencyKey: string;
}

export interface VisibilityRequestInput {
  querySetVersionId: string;
  provider: VisibilityProvider;
  sampleCount: number;
  idempotencyKey: string;
}

export interface InternalGeoApiClient {
  getTenantContext(principal: Readonly<ActorContext>): Promise<unknown>;
  lookupFacts(
    principal: Readonly<ActorContext>,
    input: Readonly<TenantFactLookupInput>,
  ): Promise<unknown>;
  proposeDraft(
    principal: Readonly<ActorContext>,
    input: Readonly<DraftProposalInput>,
  ): Promise<unknown>;
  previewVariant(
    principal: Readonly<ActorContext>,
    input: Readonly<VariantPreviewInput>,
  ): Promise<unknown>;
  requestAudit(
    principal: Readonly<ActorContext>,
    input: Readonly<AuditRequestInput>,
  ): Promise<unknown>;
  requestPublication(
    principal: Readonly<ActorContext>,
    input: Readonly<PublicationRequestInput>,
  ): Promise<unknown>;
  requestVisibilityRun(
    principal: Readonly<ActorContext>,
    input: Readonly<VisibilityRequestInput>,
  ): Promise<unknown>;
  authorizeResourceScope(
    principal: Readonly<ActorContext>,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
}
