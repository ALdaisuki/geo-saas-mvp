import { publicationVariantPayloadSchema } from "@geo/contracts";
import { withTenantTransaction, type Database, type TenantTransaction } from "@geo/db";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import type {
  CtripBridgeControlPlane,
  CtripBridgeExecutionContext,
  CtripBridgeHandoffDraft,
  CtripBridgePreparedEvidence,
  CtripBridgeReadbackObservation,
  CtripBridgeSubmitObservation,
} from "./types.js";

const handoffRowSchema = z.strictObject({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  channel_account_id: z.string().uuid(),
  variant_id: z.string().uuid(),
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
  payload: publicationVariantPayloadSchema,
});

function handoffView(row: unknown): CtripBridgeHandoffDraft {
  const parsed = handoffRowSchema.parse(row);
  return {
    id: parsed.id,
    tenantId: parsed.tenant_id,
    channelAccountId: parsed.channel_account_id,
    variantId: parsed.variant_id,
    platform: parsed.platform,
    state: parsed.state,
    previewHash: parsed.preview_hash,
    payloadHash: parsed.payload_hash,
    adapterVersion: parsed.adapter_version,
    bridgePrincipalId: parsed.bridge_service_principal_id,
    externalDraftId: parsed.external_draft_id,
    submitOutcome: parsed.submit_outcome,
    submitEvidenceKind: parsed.submit_evidence_kind,
    payload: parsed.payload,
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
          ${evidence.externalDraftId},
          ${handoff.adapterVersion}
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
          ${observation.observedAt}::timestamptz
        )
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw new Error("Submit observation returned no evidence identity");
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
