import { mediaReferenceSchema, publicationVariantPayloadSchema } from "@geo/contracts";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import type {
  CtripBridgeControlPlane,
  CtripBridgeExecutionContext,
  CtripBridgeHandoffDraft,
  CtripBridgeMediaAsset,
  CtripBridgePreparationBlocker,
  CtripBridgePreparedEvidence,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
} from "./types.js";

const handoffRowSchema = z.strictObject({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  channel_account_id: z.string().uuid(),
  variant_id: z.string().uuid(),
  content_version_id: z.string().uuid(),
  platform: z.literal("ctrip_community"),
  state: z.enum([
    "handoff_pending",
    "session_required",
    "challenge_required",
    "draft_prepared",
    "awaiting_operator_submit",
    "submitted_unconfirmed",
    "readback_pending",
    "confirmed",
    "needs_review",
    "cancelled",
    "expired",
    "failed",
  ]),
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  adapter_version: z.string().trim().min(1).max(100),
  bridge_service_principal_id: z.string().uuid(),
  external_draft_id: z.string().nullable(),
  submit_outcome: z.enum(["accepted", "uncertain", "rejected"]).nullable(),
  submit_evidence_kind: z.enum(["simulation", "browser"]).nullable(),
  submit_candidate_external_id: z.string().nullable(),
  submit_candidate_external_url: z.string().nullable(),
  submit_permit_consumed_at: z.coerce.date().nullable(),
  payload: publicationVariantPayloadSchema,
});

function handoffView(row: unknown): CtripBridgeHandoffDraft {
  const parsed = handoffRowSchema.parse(row);
  return {
    id: parsed.id,
    tenantId: parsed.tenant_id,
    channelAccountId: parsed.channel_account_id,
    variantId: parsed.variant_id,
    contentVersionId: parsed.content_version_id,
    platform: parsed.platform,
    state: parsed.state,
    previewHash: parsed.preview_hash,
    payloadHash: parsed.payload_hash,
    adapterVersion: parsed.adapter_version,
    bridgePrincipalId: parsed.bridge_service_principal_id,
    externalDraftId: parsed.external_draft_id,
    submitOutcome: parsed.submit_outcome,
    submitEvidenceKind: parsed.submit_evidence_kind,
    submitCandidateExternalId: parsed.submit_candidate_external_id,
    submitCandidateExternalUrl: parsed.submit_candidate_external_url,
    submitPermitConsumedAt: parsed.submit_permit_consumed_at?.toISOString() ?? null,
    payload: parsed.payload,
  };
}

const mediaAssetRowSchema = z.strictObject({
  content_version_id: z.string().uuid(),
  position: z.coerce.number().int().nonnegative(),
  binding_platform: z.literal("ctrip_community"),
  binding_role: z.enum(["cover", "inline"]),
  binding_alt_text: z.string(),
  binding_caption: z.string(),
  storage_key: z.string().trim().min(1),
  id: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mime_type: z.string(),
  byte_length: z.coerce.number().int().positive().safe(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  platform: z.literal("ctrip_community"),
  role: z.enum(["cover", "inline"]),
  alt_text: z.string(),
  caption: z.string(),
  fact_ids: z.array(z.string().uuid()),
  visual_brief: z.unknown(),
  visual_brief_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  rights: z.unknown(),
  provenance: z.unknown(),
  inspection_asset_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inspection_status: z.enum(["passed", "failed"]),
  evaluator: z.string(),
  evaluator_mode: z.enum(["fixture", "live"]),
  evaluator_version: z.string(),
  response_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inspected_at: z.coerce.date(),
  ocr_text: z.string(),
  labels: z.unknown(),
});

function mediaAssetView(row: unknown): CtripBridgeMediaAsset {
  const parsed = mediaAssetRowSchema.parse(row);
  return {
    contentVersionId: parsed.content_version_id,
    position: parsed.position,
    bindingPlatform: parsed.binding_platform,
    bindingRole: parsed.binding_role,
    bindingAltText: parsed.binding_alt_text,
    bindingCaption: parsed.binding_caption,
    storageKey: parsed.storage_key,
    reference: mediaReferenceSchema.parse({
      id: parsed.id,
      sha256: parsed.sha256,
      mimeType: parsed.mime_type,
      byteLength: parsed.byte_length,
      width: parsed.width,
      height: parsed.height,
      platform: parsed.platform,
      role: parsed.role,
      altText: parsed.alt_text,
      caption: parsed.caption,
      factIds: parsed.fact_ids,
      visualBrief: parsed.visual_brief,
      visualBriefHash: parsed.visual_brief_hash,
      rights: parsed.rights,
      provenance: parsed.provenance,
      inspection: {
        assetSha256: parsed.inspection_asset_sha256,
        status: parsed.inspection_status,
        evaluator: parsed.evaluator,
        evaluatorMode: parsed.evaluator_mode,
        evaluatorVersion: parsed.evaluator_version,
        responseSha256: parsed.response_sha256,
        inspectedAt: parsed.inspected_at.toISOString(),
        ocrText: parsed.ocr_text,
        labels: z.array(z.string()).parse(parsed.labels),
      },
    }),
  };
}

export class PostgresCtripBridgeControlPlane implements CtripBridgeControlPlane {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  #transaction<T>(
    context: CtripBridgeExecutionContext,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.#database,
      {
        tenantId: context.tenantId,
        actorId: context.bridgePrincipalId,
        requestId: context.requestId,
      },
      operation,
    );
  }

  loadHandoff(
    context: CtripBridgeExecutionContext,
    handoffId: string,
  ): Promise<CtripBridgeHandoffDraft> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<z.input<typeof handoffRowSchema>>`
        select handoff.id, handoff.tenant_id, handoff.channel_account_id,
               handoff.variant_id, handoff.platform, handoff.state,
               handoff.preview_hash, handoff.payload_hash, handoff.adapter_version,
               handoff.bridge_service_principal_id, handoff.external_draft_id,
               handoff.submit_outcome, handoff.submit_evidence_kind,
               handoff.submit_candidate_external_id,
               handoff.submit_candidate_external_url,
               handoff.submit_permit_consumed_at, variant.content_version_id,
               variant.payload
        from geo.publication_assisted_handoffs as handoff
        join geo.publication_variants as variant
          on variant.tenant_id = handoff.tenant_id and variant.id = handoff.variant_id
        where handoff.id = ${handoffId}::uuid
        limit 1
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Ctrip assisted handoff was not found");
      return handoffView(row);
    });
  }

  loadPreparedMediaAssets(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
  ): Promise<readonly CtripBridgeMediaAsset[]> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<z.input<typeof mediaAssetRowSchema>>`
        select variant.content_version_id, binding.position,
               binding.platform as binding_platform, binding.role as binding_role,
               binding.alt_text as binding_alt_text,
               binding.caption as binding_caption, asset.storage_key,
               asset.id, asset.sha256, asset.mime_type, asset.byte_length::text,
               asset.width, asset.height, asset.platform, asset.role,
               asset.alt_text, asset.caption, asset.fact_ids, asset.visual_brief,
               asset.visual_brief_hash, asset.rights, asset.provenance,
               inspection.asset_sha256 as inspection_asset_sha256,
               inspection.status as inspection_status, inspection.evaluator,
               inspection.evaluator_mode, inspection.evaluator_version,
               inspection.response_sha256, inspection.inspected_at,
               inspection.ocr_text, inspection.labels
        from geo.publication_variants as variant
        cross join lateral jsonb_array_elements(
          coalesce(variant.payload -> 'media', '[]'::jsonb)
        ) with ordinality as payload_media(reference, ordinal)
        join geo.media_assets as asset
          on asset.tenant_id = variant.tenant_id
         and asset.id = (payload_media.reference ->> 'id')::uuid
         and asset.content_version_id = variant.content_version_id
        join geo.content_media_bindings as binding
          on binding.tenant_id = variant.tenant_id
         and binding.content_version_id = variant.content_version_id
         and binding.media_asset_id = asset.id
        join lateral (
          select inspected.asset_sha256, inspected.status, inspected.evaluator,
                 inspected.evaluator_mode, inspected.evaluator_version,
                 inspected.response_sha256, inspected.inspected_at,
                 inspected.ocr_text, inspected.labels
          from geo.media_inspections as inspected
          where inspected.tenant_id = asset.tenant_id
            and inspected.media_asset_id = asset.id
            and inspected.asset_sha256 = asset.sha256
          order by inspected.inspected_at desc, inspected.id desc
          limit 1
        ) as inspection on true
        where variant.tenant_id = ${context.tenantId}::uuid
          and variant.id = ${handoff.variantId}::uuid
          and variant.content_version_id = ${handoff.contentVersionId}::uuid
          and variant.platform = 'ctrip_community'
          and asset.source_class <> 'legacy'
        order by payload_media.ordinal
      `.execute(transaction);
      return result.rows.map(mediaAssetView);
    });
  }

  recordPrepared(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidence: CtripBridgePreparedEvidence,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.record_publication_assisted_draft(
          ${handoff.id}::uuid,
          ${evidence.sessionEvidenceHash}::geo.sha256_hex,
          ${evidence.draftEvidenceHash}::geo.sha256_hex,
          ${evidence.evidenceHash}::geo.sha256_hex,
          ${evidence.mediaManifestHash}::geo.sha256_hex,
          ${evidence.evidenceKind},
          ${evidence.observedAt}::timestamptz,
          ${evidence.externalDraftId},
          ${handoff.adapterVersion}
        )
      `.execute(transaction);
    });
  }

  recordPreparationBlocker(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    blocker: CtripBridgePreparationBlocker,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      const status = blocker.outcome === "adapter_drift" ? "failed" : blocker.outcome;
      const errorCode = blocker.outcome === "adapter_drift" ? "ASSISTED_ADAPTER_DRIFT" : null;
      await sql`
        select geo.record_publication_assisted_bridge_status(
          ${handoff.id}::uuid,
          ${status},
          ${blocker.sessionEvidenceHash}::geo.sha256_hex,
          ${blocker.evidenceHash}::geo.sha256_hex,
          ${blocker.evidenceKind},
          ${blocker.observedAt}::timestamptz,
          ${handoff.adapterVersion},
          ${errorCode}
        )
      `.execute(transaction);
    });
  }

  consumeSubmitPermit(
    context: CtripBridgeExecutionContext,
    handoffId: string,
    submitPermit: string,
  ): Promise<void> {
    return this.#transaction(context, async (transaction) => {
      await sql`
        select geo.consume_publication_assisted_submit_permit(
          ${handoffId}::uuid, ${submitPermit}
        )
      `.execute(transaction);
    });
  }

  recordSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeSubmitObservation,
  ): Promise<{ readonly receiptId: string; readonly readbackId: string }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        publication_receipt_id: string;
        publication_readback_id: string;
      }>`
        select * from geo.record_publication_assisted_submit_observation(
          ${handoff.id}::uuid,
          ${observation.outcome},
          ${observation.evidenceKind},
          ${observation.evidenceHash}::geo.sha256_hex,
          ${observation.candidateExternalId},
          ${observation.candidateExternalUrl},
          ${observation.observedAt}::timestamptz
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Submit observation returned no evidence identity");
      return { receiptId: row.publication_receipt_id, readbackId: row.publication_readback_id };
    });
  }

  recoverSubmitObservation(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    evidenceKind: "simulation" | "browser",
  ): Promise<{ readonly receiptId: string; readonly readbackId: string }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        publication_receipt_id: string;
        publication_readback_id: string;
      }>`
        select * from geo.recover_publication_assisted_submit_uncertain(
          ${handoff.id}::uuid,
          ${evidenceKind}
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Submit recovery returned no evidence identity");
      return { receiptId: row.publication_receipt_id, readbackId: row.publication_readback_id };
    });
  }

  recordReadback(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
    observation: CtripBridgeReadbackObservation,
  ): Promise<{
    readonly state: "readback_pending" | "confirmed" | "needs_review";
    readonly externalId: string | null;
    readonly externalUrl: string | null;
  }> {
    return this.#transaction(context, async (transaction) => {
      const result = await sql<{
        state: "readback_pending" | "confirmed" | "needs_review";
        external_id: string | null;
        external_url: string | null;
      }>`
        select * from geo.record_publication_assisted_readback(
          ${handoff.id}::uuid,
          ${observation.outcome},
          ${observation.evidenceKind},
          ${observation.evidenceHash}::geo.sha256_hex,
          ${observation.observedPayloadHash}::geo.sha256_hex,
          ${observation.externalId},
          ${observation.externalUrl},
          ${observation.observedAt}::timestamptz
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Readback returned no durable state");
      return { state: row.state, externalId: row.external_id, externalUrl: row.external_url };
    });
  }
}
