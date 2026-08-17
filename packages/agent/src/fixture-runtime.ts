import type { ExecutionLevel, Platform } from "@geo/contracts";

import type { GovernedAgentRuntime } from "./runtime.js";

export interface FixtureDraftFlowInput {
  tenantId: string;
  brandId: string;
  campaignId: string;
  channelAccountId: string;
  platform: Platform;
  topic: string;
  articleTemplateId?: string;
  idempotencyKey: string;
  executionLevel: Extract<ExecutionLevel, "dry_run" | "assisted">;
}

export interface FixtureDraftFlowResult {
  providerMode: "fixture";
  contentItemId: string;
  contentVersionId: string;
  variantId: string;
  auditRunId: string;
  auditArtifactId: string;
  publicationRequestId: string;
  publicationJobId: string;
  outboxEventId: string;
  steps: readonly string[];
}

function requireRecord(value: unknown, step: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Fixture ${step} returned an invalid result`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Fixture result is missing ${field}`);
  }
  return value;
}

export class FixtureDraftingRuntime {
  readonly providerMode = "fixture" as const;
  readonly #runtime: GovernedAgentRuntime;

  constructor(runtime: GovernedAgentRuntime) {
    this.#runtime = runtime;
  }

  async run(input: FixtureDraftFlowInput, signal?: AbortSignal): Promise<FixtureDraftFlowResult> {
    const steps: string[] = [];
    const invoke = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (signal?.aborted) throw new Error("Fixture agent run was aborted");
      const result = await this.#runtime.invoke(name, args);
      if (signal?.aborted) throw new Error("Fixture agent run was aborted");
      steps.push(name);
      return result;
    };

    await invoke("plastic_context_supply", {
      tenantId: input.tenantId,
      taskDescription: `Create a governed draft about ${input.topic}`,
      taskType: "content_drafting",
    });
    await invoke("geo_tenant_context", { tenantId: input.tenantId });
    await invoke("geo_template_catalog", { tenantId: input.tenantId });
    await invoke("geo_brand_profile", {
      tenantId: input.tenantId,
      brandId: input.brandId,
    });
    await invoke("geo_fact_lookup", {
      tenantId: input.tenantId,
      brandId: input.brandId,
      query: input.topic,
      limit: 10,
    });

    const draft = requireRecord(
      await invoke("geo_draft_proposal", {
        tenantId: input.tenantId,
        brandId: input.brandId,
        campaignId: input.campaignId,
        brief: input.topic,
        ...(input.articleTemplateId === undefined
          ? {}
          : { articleTemplateId: input.articleTemplateId }),
        idempotencyKey: `${input.idempotencyKey}:draft`,
        fixtureMode: true,
      }),
      "draft",
    );
    const contentItemId = requireString(draft.contentItemId, "contentItemId");
    const contentVersionId = requireString(draft.contentVersionId, "contentVersionId");

    const preview = requireRecord(
      await invoke("geo_variant_preview", {
        tenantId: input.tenantId,
        contentVersionId,
        channelAccountId: input.channelAccountId,
        platform: input.platform,
      }),
      "preview",
    );
    const variantId = requireString(preview.variantId, "variantId");

    const audit = requireRecord(
      await invoke("geo_audit_request", {
        tenantId: input.tenantId,
        variantId,
        idempotencyKey: `${input.idempotencyKey}:audit`,
      }),
      "audit",
    );
    const auditRunId = requireString(audit.auditRunId, "auditRunId");
    const auditArtifactId = requireString(audit.auditArtifactId, "auditArtifactId");
    if (audit.status !== "passed") {
      throw new Error("Fixture audit did not pass");
    }

    const publication = requireRecord(
      await invoke("geo_publication_request", {
        tenantId: input.tenantId,
        variantId,
        channelAccountId: input.channelAccountId,
        platform: input.platform,
        executionLevel: input.executionLevel,
        idempotencyKey: `${input.idempotencyKey}:publication`,
      }),
      "publication",
    );
    const publicationRequestId = requireString(
      publication.publicationRequestId,
      "publicationRequestId",
    );

    return {
      providerMode: "fixture",
      contentItemId,
      contentVersionId,
      variantId,
      auditRunId,
      auditArtifactId,
      publicationRequestId,
      publicationJobId: requireString(
        publication.publicationJobId ?? publicationRequestId,
        "publicationJobId",
      ),
      outboxEventId: requireString(publication.outboxEventId, "outboxEventId"),
      steps,
    };
  }
}
