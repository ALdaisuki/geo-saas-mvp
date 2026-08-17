import type {
  ActorContext,
  ArticleTemplateCatalog,
  AutomationPlatform,
  BrandAgentProfile,
  ExecutionLevel,
  MediaRole,
  VisibilityProvider,
} from "@geo/contracts";

export interface TenantFactLookupInput {
  brandId: string;
  query: string;
  limit?: number;
}

export interface AuthoredDraftSectionInput {
  readonly text: string;
  readonly claimIds: readonly string[];
}

export interface AuthoredDraftMediaSearchIntentInput {
  readonly query: string;
  readonly sectionRef?: string;
  readonly fallbackQueries?: readonly string[];
  readonly retryBudget?: number;
  readonly role: "cover" | "inline";
  readonly rationale: string;
  readonly claimIds: readonly string[];
}

export interface AuthoredDraftInput {
  readonly title: string;
  readonly titleClaimIds: readonly string[];
  readonly summary: string;
  readonly summaryClaimIds: readonly string[];
  readonly locationQuery?: string;
  readonly body: readonly AuthoredDraftSectionInput[];
  readonly mediaSearchPlan?: readonly AuthoredDraftMediaSearchIntentInput[];
}

interface DraftProposalBaseInput {
  brandId: string;
  campaignId: string;
  brief: string;
  targetPlatform?: AutomationPlatform;
  articleTemplateId?: string;
  idempotencyKey: string;
}

export type DraftProposalInput = DraftProposalBaseInput &
  (
    | {
        readonly fixtureMode: true;
        readonly authoredDraft?: never;
      }
    | {
        readonly fixtureMode?: never;
        readonly authoredDraft: AuthoredDraftInput;
      }
  );

/**
 * Server-only constraints applied to a draft proposal. These settings are not
 * part of the MCP tool schema, so an authoring model cannot weaken them.
 */
export interface DraftProposalExecutionOptions {
  readonly requireRelevantVerifiedClaims?: boolean;
}

export interface VariantPreviewInput {
  contentVersionId: string;
  channelAccountId: string;
  platform: AutomationPlatform;
}

export interface AuditRequestInput {
  variantId: string;
  idempotencyKey: string;
}

export interface PublicationRequestInput {
  variantId: string;
  channelAccountId: string;
  platform?: AutomationPlatform;
  executionLevel: ExecutionLevel;
  idempotencyKey: string;
}

export interface VisibilityRequestInput {
  querySetVersionId: string;
  provider: VisibilityProvider;
  sampleCount: number;
  idempotencyKey: string;
}

export interface MediaProductionRequestInput {
  contentVersionId: string;
  platform: AutomationPlatform;
  role: MediaRole;
  claimIds: readonly string[];
  idempotencyKey: string;
}

export interface MediaJobStatusInput {
  mediaJobId: string;
}

export interface MediaSearchImportInput {
  contentVersionId: string;
  platform: AutomationPlatform;
  idempotencyKey: string;
  maxImports?: number;
}

export interface InternalGeoApiClient {
  getTenantContext(principal: Readonly<ActorContext>): Promise<unknown>;
  getArticleTemplateCatalog(
    principal: Readonly<ActorContext>,
  ): Promise<Readonly<ArticleTemplateCatalog>>;
  getBrandAgentProfile(
    principal: Readonly<ActorContext>,
    brandId: string,
  ): Promise<Readonly<BrandAgentProfile> | null>;
  lookupFacts(
    principal: Readonly<ActorContext>,
    input: Readonly<TenantFactLookupInput>,
  ): Promise<unknown>;
  proposeDraft(
    principal: Readonly<ActorContext>,
    input: Readonly<DraftProposalInput>,
    options?: Readonly<DraftProposalExecutionOptions>,
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
  requestMediaProduction(
    principal: Readonly<ActorContext>,
    input: Readonly<MediaProductionRequestInput>,
  ): Promise<unknown>;
  getMediaJobStatus(
    principal: Readonly<ActorContext>,
    input: Readonly<MediaJobStatusInput>,
  ): Promise<unknown>;
  requestMediaSearchImport(
    principal: Readonly<ActorContext>,
    input: Readonly<MediaSearchImportInput>,
  ): Promise<unknown>;
  authorizeResourceScope(
    principal: Readonly<ActorContext>,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
}
