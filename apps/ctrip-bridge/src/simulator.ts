import { sha256Canonical } from "@geo/core";
import type { RenderedDraft } from "@geo/connectors";

import {
  CTRIP_SIMULATOR_ADAPTER_VERSION,
  type CtripBridgeHandoffDraft,
  type CtripBridgePreparedEvidence,
  type CtripBridgeReadbackObservation,
  type CtripBridgeSubmitObservation,
  type CtripFixedAdapter,
} from "./types.js";

interface SimulatorDraft {
  readonly handoff: CtripBridgeHandoffDraft;
  readonly draft: RenderedDraft;
  readonly externalDraftId: string;
  readonly preparedAt: string;
  submittedAt: string | null;
  submitOutcome: CtripBridgeSubmitObservation["outcome"] | null;
}

export class CtripCommunitySimulator implements CtripFixedAdapter {
  readonly version = CTRIP_SIMULATOR_ADAPTER_VERSION;
  readonly #drafts = new Map<string, SimulatorDraft>();
  readonly #now: () => Date;
  readonly #nextSubmitOutcome: () => CtripBridgeSubmitObservation["outcome"];

  constructor(
    options: {
      readonly now?: () => Date;
      readonly nextSubmitOutcome?: () => CtripBridgeSubmitObservation["outcome"];
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#nextSubmitOutcome = options.nextSubmitOutcome ?? (() => "accepted");
  }

  async prepare(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgePreparedEvidence> {
    const preparedAt = this.#now().toISOString();
    const externalDraftId = `sim-draft-${handoff.id}`;
    const material = {
      kind: "ctrip_simulator_draft",
      adapterVersion: this.version,
      tenantId: handoff.tenantId,
      handoffId: handoff.id,
      previewHash: draft.previewHash,
      externalDraftId,
      preparedAt,
    };
    const evidenceHash = sha256Canonical(material);
    const existing = this.#drafts.get(handoff.id);
    if (existing !== undefined && existing.draft.previewHash !== draft.previewHash) {
      throw new Error("Simulator handoff was already prepared with another preview");
    }
    if (existing === undefined) {
      this.#drafts.set(handoff.id, {
        handoff,
        draft,
        externalDraftId,
        preparedAt,
        submittedAt: null,
        submitOutcome: null,
      });
    }
    return {
      externalDraftId,
      sessionEvidenceHash: sha256Canonical({ ...material, evidence: "session" }),
      draftEvidenceHash: sha256Canonical({ ...material, evidence: "draft" }),
      evidenceHash,
      observedAt: preparedAt,
      evidenceKind: "simulation",
    };
  }

  async submit(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeSubmitObservation> {
    const prepared = this.#drafts.get(handoff.id);
    if (prepared === undefined) {
      if (
        handoff.externalDraftId === null ||
        !["awaiting_operator_submit", "submitted_unconfirmed", "readback_pending"].includes(
          handoff.state,
        )
      ) {
        throw new Error("Simulator draft is not prepared");
      }
      this.#drafts.set(handoff.id, {
        handoff,
        draft,
        externalDraftId: handoff.externalDraftId,
        preparedAt: this.#now().toISOString(),
        submittedAt: null,
        submitOutcome: null,
      });
    }
    const durable = this.#drafts.get(handoff.id);
    if (durable === undefined || durable.draft.previewHash !== draft.previewHash) {
      throw new Error("Simulator draft does not match the durable preview");
    }
    if (durable.submittedAt !== null) {
      throw new Error("Simulator submit is one-shot and was already invoked");
    }
    const observedAt = this.#now().toISOString();
    const outcome = this.#nextSubmitOutcome();
    durable.submittedAt = observedAt;
    durable.submitOutcome = outcome;
    return {
      outcome,
      observedAt,
      evidenceKind: "simulation",
      evidenceHash: sha256Canonical({
        kind: "ctrip_simulator_submit",
        adapterVersion: this.version,
        tenantId: handoff.tenantId,
        handoffId: handoff.id,
        previewHash: draft.previewHash,
        outcome,
        observedAt,
      }),
    };
  }

  async readback(
    handoff: CtripBridgeHandoffDraft,
    draft: RenderedDraft,
  ): Promise<CtripBridgeReadbackObservation> {
    const prepared = this.#drafts.get(handoff.id);
    const observedAt = this.#now().toISOString();
    const submitted =
      (prepared?.submittedAt !== null && prepared?.submittedAt !== undefined) ||
      (handoff.state === "readback_pending" && handoff.submitOutcome !== null);
    const outcome = submitted ? "simulation_only" : "not_found";
    return {
      outcome,
      observedAt,
      evidenceKind: "simulation",
      observedPayloadHash: submitted ? handoff.payloadHash : null,
      externalId: null,
      externalUrl: null,
      evidenceHash: sha256Canonical({
        kind: "ctrip_simulator_readback",
        adapterVersion: this.version,
        tenantId: handoff.tenantId,
        handoffId: handoff.id,
        previewHash: draft.previewHash,
        outcome,
        observedAt,
      }),
    };
  }

  renderHtml(tenantId: string): string {
    const rows = [...this.#drafts.values()]
      .filter((item) => item.handoff.tenantId === tenantId)
      .map(
        (item) => `<article data-handoff-id="${escapeHtml(item.handoff.id)}">
  <h2>${escapeHtml(item.draft.payload.title)}</h2>
  <p>${escapeHtml(item.draft.payload.summary)}</p>
  <pre>${escapeHtml(item.draft.payload.bodyMarkdown)}</pre>
  <output data-state>${item.submittedAt === null ? "draft_prepared" : "submitted_simulation"}</output>
</article>`,
      )
      .join("\n");
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ctrip Community Simulator</title></head>
<body><main><h1>Ctrip Community Simulator</h1>${rows}</main></body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
