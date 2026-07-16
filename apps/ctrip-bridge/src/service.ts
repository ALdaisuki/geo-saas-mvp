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

  constructor(options: {
    readonly tenantId: string;
    readonly bridgePrincipalId: string;
    readonly controlPlane: CtripBridgeControlPlane;
    readonly adapter: CtripFixedAdapter;
    readonly mediaObjectStore: Pick<MediaObjectStore, "get">;
  }) {
    this.#context = {
      tenantId: options.tenantId,
      bridgePrincipalId: options.bridgePrincipalId,
    };
    this.#controlPlane = options.controlPlane;
    this.#adapter = options.adapter;
    this.#mediaObjectStore = options.mediaObjectStore;
  }

  async #load(command: CtripBridgeCommand): Promise<{
    readonly context: CtripBridgeExecutionContext;
    readonly handoff: CtripBridgeHandoffDraft;
    readonly draft: ReturnType<typeof renderCtripCommunityAssistedDraft>;
  }> {
    if (command.tenantId !== this.#context.tenantId) {
      throw new CtripBridgeServiceError(403, "CTRIP_BRIDGE_TENANT_DENIED", "Tenant denied");
    }
    const context = { ...this.#context, requestId: command.requestId };
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
      executionLevel: "assisted",
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

  async execute(input: unknown): Promise<CtripBridgeResult> {
    const command = ctripBridgeCommandSchema.parse(input);
    const loaded = await this.#load(command);
    switch (command.command) {
      case "prepare": {
        const media = await this.#loadTrustedMedia(loaded.context, loaded.handoff);
        const evidence = await this.#adapter.prepare(loaded.handoff, loaded.draft, media);
        if ("outcome" in evidence) {
          await this.#controlPlane.recordPreparationBlocker(
            loaded.context,
            loaded.handoff,
            evidence,
          );
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
            state: evidence.outcome === "adapter_drift" ? "failed" : evidence.outcome,
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
      case "submit": {
        await this.#controlPlane.consumeSubmitPermit(
          loaded.context,
          loaded.handoff.id,
          command.submitPermit,
        );
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
      }
      case "readback": {
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
