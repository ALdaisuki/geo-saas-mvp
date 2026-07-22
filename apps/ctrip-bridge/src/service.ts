import { createHash } from "node:crypto";

import { renderCtripCommunityAssistedDraft } from "@geo/connectors";
import {
  ctripBridgeCommandSchema,
  ctripBridgeResultSchema,
  type CtripBridgeCommand,
  type CtripBridgeResult,
} from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import type { MediaObjectStore } from "@geo/media";

import type {
  CtripBridgeControlPlane,
  CtripBridgeExecutionContext,
  CtripBridgeHandoffDraft,
  CtripFixedAdapter,
  CtripTrustedMediaAttachment,
} from "./types.js";

const DRAFT_PREPARATION_LEASE_SECONDS = 600;
type PrepareCommand = Extract<CtripBridgeCommand, { readonly command: "prepare" }>;

export class CtripBridgeServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CtripBridgeServiceError";
  }
}

export class CtripBridgeCommandService {
  readonly #context: Omit<CtripBridgeExecutionContext, "requestId">;
  readonly #controlPlane: CtripBridgeControlPlane;
  readonly #adapter: CtripFixedAdapter;
  readonly #mediaObjectStore: Pick<MediaObjectStore, "get">;
  readonly #executionLevel: "assisted" | "unattended";

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: CtripBridgeControlPlane;
    readonly adapter: CtripFixedAdapter;
    readonly mediaObjectStore: Pick<MediaObjectStore, "get">;
    readonly executionLevel?: "assisted" | "unattended";
  }) {
    this.#context = {
      tenantId: options.tenantId,
      bridgePrincipalId: options.bridgePrincipalId,
    };
    this.#controlPlane = options.controlPlane;
    this.#adapter = options.adapter;
    this.#mediaObjectStore = options.mediaObjectStore;
    this.#executionLevel = options.executionLevel ?? "assisted";
  }

  #executionContext(command: CtripBridgeCommand): CtripBridgeExecutionContext {
    if (command.tenantId !== this.#context.tenantId) {
      throw new CtripBridgeServiceError(403, "CTRIP_BRIDGE_TENANT_DENIED", "Tenant denied");
    }
    return { ...this.#context, requestId: command.requestId };
  }

  async #load(command: CtripBridgeCommand): Promise<{
    readonly context: CtripBridgeExecutionContext;
    readonly handoff: CtripBridgeHandoffDraft;
    readonly draft: ReturnType<typeof renderCtripCommunityAssistedDraft>;
  }> {
    const context = this.#executionContext(command);
    const handoff = await this.#controlPlane.loadHandoff(context, command.handoffId);
    if (
      handoff.id !== command.handoffId ||
      handoff.tenantId !== context.tenantId ||
      handoff.bridgePrincipalId !== context.bridgePrincipalId ||
      handoff.platform !== "ctrip_community"
    ) {
      throw new CtripBridgeServiceError(
        403,
        "CTRIP_BRIDGE_SCOPE_MISMATCH",
        "Handoff scope mismatch",
      );
    }
    if (handoff.adapterVersion !== this.#adapter.version) {
      throw new CtripBridgeServiceError(
        409,
        "CTRIP_BRIDGE_ADAPTER_DRIFT",
        "Reviewed adapter version does not match",
      );
    }
    const draft = renderCtripCommunityAssistedDraft({
      tenantId: handoff.tenantId,
      channelAccountId: handoff.channelAccountId,
      variantId: handoff.variantId,
      executionLevel: handoff.executionLevel,
      payload: handoff.payload,
    });
    if (draft.previewHash !== handoff.previewHash) {
      throw new CtripBridgeServiceError(
        409,
        "CTRIP_BRIDGE_PREVIEW_MISMATCH",
        "Rendered draft no longer matches the audited preview",
      );
    }
    return { context, handoff, draft };
  }

  async #loadTrustedMedia(
    context: CtripBridgeExecutionContext,
    handoff: CtripBridgeHandoffDraft,
  ): Promise<readonly CtripTrustedMediaAttachment[]> {
    const expected = handoff.payload.media;
    const assets = await this.#controlPlane.loadPreparedMediaAssets(context, handoff);
    if (assets.length !== expected.length) {
      throw new CtripBridgeServiceError(
        409,
        "CTRIP_MEDIA_PAYLOAD_INVALID",
        "Audited media asset set is incomplete",
      );
    }

    const attachments: CtripTrustedMediaAttachment[] = [];
    for (const [position, reference] of expected.entries()) {
      const asset = assets[position];
      if (
        asset === undefined ||
        asset.contentVersionId !== handoff.contentVersionId ||
        asset.position !== position ||
        asset.bindingPlatform !== "ctrip_community" ||
        asset.bindingRole !== reference.role ||
        asset.bindingAltText !== reference.altText ||
        asset.bindingCaption !== reference.caption ||
        reference.platform !== handoff.platform ||
        asset.reference.inspection.status !== "passed" ||
        sha256Canonical(asset.reference) !== sha256Canonical(reference)
      ) {
        throw new CtripBridgeServiceError(
          409,
          "CTRIP_MEDIA_PAYLOAD_INVALID",
          "Audited media metadata or binding no longer matches",
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await this.#mediaObjectStore.get({
          tenantId: context.tenantId,
          storageKey: asset.storageKey,
        });
      } catch {
        throw new CtripBridgeServiceError(
          409,
          "CTRIP_MEDIA_PAYLOAD_INVALID",
          "Audited media bytes are unavailable or invalid",
        );
      }
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== reference.byteLength || actualSha256 !== reference.sha256) {
        throw new CtripBridgeServiceError(
          409,
          "CTRIP_MEDIA_PAYLOAD_INVALID",
          "Audited media bytes no longer match",
        );
      }
      attachments.push(
        Object.freeze({
          position,
          reference,
          bytes: Uint8Array.from(bytes),
        }),
      );
    }
    return Object.freeze(attachments);
  }

  async #prepare(command: PrepareCommand, alreadyClaimed: boolean): Promise<CtripBridgeResult> {
    const context = this.#executionContext(command);
    if (!alreadyClaimed) {
      await this.#controlPlane.claimDraftPreparation(
        context,
        command.handoffId,
        DRAFT_PREPARATION_LEASE_SECONDS,
      );
    }
    const loaded = await this.#load(command);
    const media = await this.#loadTrustedMedia(loaded.context, loaded.handoff);
    const evidence = await this.#adapter.prepare(loaded.handoff, loaded.draft, media);
    if ("outcome" in evidence) {
      await this.#controlPlane.recordPreparationBlocker(loaded.context, loaded.handoff, evidence);
      return ctripBridgeResultSchema.parse({
        schemaVersion: "geo.ctrip-bridge.result.v1",
        tenantId: loaded.context.tenantId,
        handoffId: loaded.handoff.id,
        bridgePrincipalId: loaded.context.bridgePrincipalId,
        adapterVersion: this.#adapter.version,
        observedAt: evidence.observedAt,
        evidenceHash: evidence.evidenceHash,
        evidenceKind: evidence.evidenceKind,
        command: "prepare",
        outcome: evidence.outcome,
        state:
          evidence.outcome === "adapter_drift" || evidence.outcome === "payload_invalid"
            ? "failed"
            : evidence.outcome,
      });
    }
    await this.#controlPlane.recordPrepared(loaded.context, loaded.handoff, evidence);
    return ctripBridgeResultSchema.parse({
      schemaVersion: "geo.ctrip-bridge.result.v1",
      tenantId: loaded.context.tenantId,
      handoffId: loaded.handoff.id,
      bridgePrincipalId: loaded.context.bridgePrincipalId,
      adapterVersion: this.#adapter.version,
      observedAt: evidence.observedAt,
      evidenceHash: evidence.evidenceHash,
      evidenceKind: evidence.evidenceKind,
      command: "prepare",
      outcome: "prepared",
      state: "draft_prepared",
    });
  }

  async prepareNext(requestId: string): Promise<CtripBridgeResult | null> {
    if (!this.#adapter.commandCapabilities.prepare) return null;
    const context: CtripBridgeExecutionContext = { ...this.#context, requestId };
    const handoffId = await this.#controlPlane.claimNextDraftPreparation(
      context,
      DRAFT_PREPARATION_LEASE_SECONDS,
      this.#executionLevel,
    );
    if (handoffId === null) return null;
    return this.#prepare(
      {
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId: context.tenantId,
        handoffId,
        requestId,
        command: "prepare",
      },
      true,
    );
  }

  async submitNext(requestId: string): Promise<CtripBridgeResult | null> {
    if (
      !this.#adapter.commandCapabilities.submit ||
      this.#controlPlane.claimNextUnattendedSubmit === undefined
    ) {
      return null;
    }
    const context: CtripBridgeExecutionContext = { ...this.#context, requestId };
    const claimed = await this.#controlPlane.claimNextUnattendedSubmit(context);
    if (claimed === null) return null;
    return this.execute({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId: context.tenantId,
      handoffId: claimed.handoffId,
      requestId,
      command: "submit",
      submitPermit: claimed.submitPermit,
    });
  }

  async readbackNext(requestId: string): Promise<CtripBridgeResult | null> {
    if (
      !this.#adapter.commandCapabilities.readback ||
      this.#controlPlane.claimNextUnattendedReadback === undefined
    ) {
      return null;
    }
    const context: CtripBridgeExecutionContext = { ...this.#context, requestId };
    const handoffId = await this.#controlPlane.claimNextUnattendedReadback(context);
    if (handoffId === null) return null;
    return this.#executeCommand({
      schemaVersion: "geo.ctrip-bridge.command.v1",
      tenantId: context.tenantId,
      handoffId,
      requestId,
      command: "readback",
    }, true);
  }

  async execute(input: unknown): Promise<CtripBridgeResult> {
    const command = ctripBridgeCommandSchema.parse(input);
    return this.#executeCommand(command, false);
  }

  async #executeCommand(
    command: CtripBridgeCommand,
    readbackLeaseClaimed: boolean,
  ): Promise<CtripBridgeResult> {
    if (!this.#adapter.commandCapabilities[command.command]) {
      throw new CtripBridgeServiceError(
        409,
        "CTRIP_BRIDGE_COMMAND_UNSUPPORTED",
        "Bridge adapter does not support this command",
      );
    }
    switch (command.command) {
      case "prepare":
        return this.#prepare(command, false);
      case "submit": {
        const loaded = await this.#load(command);
        if (!["draft_prepared", "awaiting_operator_submit"].includes(loaded.handoff.state)) {
          throw new CtripBridgeServiceError(
            409,
            "CTRIP_SUBMIT_NOT_READY",
            "Ctrip handoff is not ready for a one-time submit",
          );
        }
        await this.#adapter.verifySubmit?.(loaded.handoff, loaded.draft);
        await this.#controlPlane.consumeSubmitPermit(
          loaded.context,
          loaded.handoff.id,
          command.submitPermit,
        );
        try {
          const observation = await this.#adapter.submit(loaded.handoff, loaded.draft);
          const recorded = await this.#controlPlane.recordSubmitObservation(
            loaded.context,
            loaded.handoff,
            observation,
          );
          return ctripBridgeResultSchema.parse({
            schemaVersion: "geo.ctrip-bridge.result.v1",
            tenantId: loaded.context.tenantId,
            handoffId: loaded.handoff.id,
            bridgePrincipalId: loaded.context.bridgePrincipalId,
            adapterVersion: this.#adapter.version,
            observedAt: observation.observedAt,
            evidenceHash: observation.evidenceHash,
            evidenceKind: observation.evidenceKind,
            command: "submit",
            outcome: observation.outcome,
            state: "readback_pending",
            receiptId: recorded.receiptId,
            readbackId: recorded.readbackId,
          });
        } catch (error) {
          let recovered: { readonly receiptId: string; readonly readbackId: string };
          try {
            recovered = await this.#controlPlane.recoverSubmitObservation(
              loaded.context,
              loaded.handoff,
              this.#adapter.evidenceKind,
            );
          } catch {
            throw error;
          }
          const durable = await this.#controlPlane.loadHandoff(loaded.context, loaded.handoff.id);
          if (
            durable.submitOutcome === null ||
            durable.submitEvidenceHash === null ||
            durable.submitEvidenceKind === null ||
            durable.submitObservedAt === null
          ) {
            throw error;
          }
          return ctripBridgeResultSchema.parse({
            schemaVersion: "geo.ctrip-bridge.result.v1",
            tenantId: loaded.context.tenantId,
            handoffId: loaded.handoff.id,
            bridgePrincipalId: loaded.context.bridgePrincipalId,
            adapterVersion: this.#adapter.version,
            observedAt: durable.submitObservedAt,
            evidenceHash: durable.submitEvidenceHash,
            evidenceKind: durable.submitEvidenceKind,
            command: "submit",
            outcome: durable.submitOutcome,
            state: "readback_pending",
            receiptId: recovered.receiptId,
            readbackId: recovered.readbackId,
          });
        }
      }
      case "readback": {
        const loaded = await this.#load(command);
        let readbackTarget = loaded;
        if (readbackTarget.handoff.state === "awaiting_operator_submit") {
          if (readbackTarget.handoff.submitPermitConsumedAt === null) {
            throw new CtripBridgeServiceError(
              409,
              "CTRIP_SUBMIT_NOT_CONSUMED",
              "Readback recovery requires a consumed submit permit",
            );
          }
          await this.#controlPlane.recoverSubmitObservation(
            readbackTarget.context,
            readbackTarget.handoff,
            this.#adapter.evidenceKind,
          );
          readbackTarget = await this.#load(command);
        }
        if (readbackTarget.handoff.state !== "readback_pending") {
          throw new CtripBridgeServiceError(
            409,
            "CTRIP_READBACK_NOT_READY",
            "Ctrip handoff is not ready for readback",
          );
        }
        if (readbackTarget.handoff.executionLevel === "unattended" && !readbackLeaseClaimed) {
          if (this.#controlPlane.claimUnattendedReadback === undefined) {
            throw new CtripBridgeServiceError(
              503,
              "CTRIP_READBACK_LEASE_UNAVAILABLE",
              "Bridge control plane cannot claim the unattended readback lease",
            );
          }
          const claimed = await this.#controlPlane.claimUnattendedReadback(
            readbackTarget.context,
            readbackTarget.handoff.id,
          );
          if (!claimed) {
            throw new CtripBridgeServiceError(
              409,
              "CTRIP_READBACK_LEASE_UNAVAILABLE",
              "Ctrip readback is currently owned by another bridge worker",
            );
          }
          readbackTarget = await this.#load(command);
          if (readbackTarget.handoff.state !== "readback_pending") {
            throw new CtripBridgeServiceError(
              409,
              "CTRIP_READBACK_NOT_READY",
              "Ctrip handoff changed before readback could begin",
            );
          }
        }
        const observation = await this.#adapter.readback(
          readbackTarget.handoff,
          readbackTarget.draft,
        );
        const recorded = await this.#controlPlane.recordReadback(
          readbackTarget.context,
          readbackTarget.handoff,
          observation,
        );
        return ctripBridgeResultSchema.parse({
          schemaVersion: "geo.ctrip-bridge.result.v1",
          tenantId: readbackTarget.context.tenantId,
          handoffId: readbackTarget.handoff.id,
          bridgePrincipalId: readbackTarget.context.bridgePrincipalId,
          adapterVersion: this.#adapter.version,
          observedAt: observation.observedAt,
          evidenceHash: observation.evidenceHash,
          evidenceKind: observation.evidenceKind,
          command: "readback",
          outcome: observation.outcome,
          state: recorded.state,
          externalId: recorded.externalId,
          externalUrl: recorded.externalUrl,
        });
      }
    }
  }
}
