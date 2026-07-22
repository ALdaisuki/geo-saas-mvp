import { createServer as createNetServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCtripBridgeHttpServer, listenCtripBridgeHttpServer } from "./http-server.js";
import { CtripBridgeCommandService } from "./service.js";
import { CtripCommunitySimulator } from "./simulator.js";
import {
  CTRIP_SIMULATOR_ADAPTER_VERSION,
  type CtripBridgeControlPlane,
  type CtripBridgeHandoffDraft,
} from "./types.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000002";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000003";
const channelAccountId = "10000000-0000-4000-8000-000000000004";
const variantId = "10000000-0000-4000-8000-000000000005";
const contentVersionId = "10000000-0000-4000-8000-000000000008";
const accessToken = "ctrip-bridge-http-test-token-with-safe-length";

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

function runtime() {
  const payload = {
    title: "携程社区仿真文章",
    summary: "这是一条严格隔离的仿真草稿。",
    bodyMarkdown: "# 仿真正文\n\n不连接真实携程。",
    media: [],
    claims: [],
    contactIds: [],
    tags: ["仿真"],
  };
  const handoff: CtripBridgeHandoffDraft = {
    id: handoffId,
    tenantId,
    channelAccountId,
    variantId,
    contentVersionId,
    platform: "ctrip_community",
    executionLevel: "assisted",
    state: "handoff_pending",
    previewHash: "",
    payloadHash: "a".repeat(64),
    adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
    bridgePrincipalId,
    externalDraftId: null,
    submitOutcome: null,
    submitEvidenceHash: null,
    submitEvidenceKind: null,
    submitObservedAt: null,
    submitCandidateExternalId: null,
    submitCandidateExternalUrl: null,
    submitPermitConsumedAt: null,
    payload,
  };
  const simulator = new CtripCommunitySimulator({
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
  const current = { value: handoff };
  const port: CtripBridgeControlPlane = {
    claimDraftPreparation: vi.fn(async () => undefined),
    claimNextDraftPreparation: vi.fn(async () => null),
    loadHandoff: vi.fn(async () => current.value),
    loadPreparedMediaAssets: vi.fn(async () => []),
    recordPrepared: vi.fn(async () => {
      current.value = { ...current.value, state: "draft_prepared" };
    }),
    recordPreparationBlocker: vi.fn(async () => undefined),
    consumeSubmitPermit: vi.fn(async () => undefined),
    recordSubmitObservation: vi.fn(async () => ({
      receiptId: "10000000-0000-4000-8000-000000000006",
      readbackId: "10000000-0000-4000-8000-000000000007",
    })),
    recoverSubmitObservation: vi.fn(async () => ({
      receiptId: "10000000-0000-4000-8000-000000000006",
      readbackId: "10000000-0000-4000-8000-000000000007",
    })),
    recordReadback: vi.fn(async () => ({
      state: "needs_review" as const,
      externalId: null,
      externalUrl: null,
    })),
  };
  return { handoff, current, port, simulator };
}

async function startedServer() {
  const state = runtime();
  const connectors = await import("@geo/connectors");
  state.current.value = {
    ...state.current.value,
    previewHash: connectors.renderCtripCommunityAssistedDraft({
      tenantId,
      channelAccountId,
      variantId,
      executionLevel: "assisted",
      payload: state.current.value.payload,
    }).previewHash,
  };
  const service = new CtripBridgeCommandService({
    tenantId,
    bridgePrincipalId,
    controlPlane: state.port,
    mediaObjectStore: { get: vi.fn(async () => new Uint8Array()) },
    adapter: state.simulator,
  });
  const port = await availablePort();
  const server = createCtripBridgeHttpServer({
    tenants: [{
      tenantId,
      bridgePrincipalId,
      accessToken,
      service,
      simulator: state.simulator,
      readiness: null,
    }],
    allowedHosts: [`127.0.0.1:${port}`],
    mode: "simulator",
    adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
    commandCapabilities: state.simulator.commandCapabilities,
  });
  await listenCtripBridgeHttpServer(server, { host: "127.0.0.1", port });
  closeCallbacks.push(
    () =>
      new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
      ),
  );
  return { origin: `http://127.0.0.1:${port}`, state };
}

function prepareCommand() {
  return {
    schemaVersion: "geo.ctrip-bridge.command.v1",
    tenantId,
    handoffId,
    requestId: "request-prepare",
    command: "prepare",
  };
}

describe("Ctrip bridge HTTP server", () => {
  it("exposes only non-sensitive simulator health", async () => {
    const { origin } = await startedServer();
    const response = await fetch(`${origin}/health/live`);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "geo-ctrip-bridge",
      mode: "simulator",
      adapterVersion: CTRIP_SIMULATOR_ADAPTER_VERSION,
      commandCapabilities: { prepare: true, submit: true, readback: true },
    });
  });

  it("advertises browser preflight without exposing a simulator surface", async () => {
    const state = runtime();
    const service = new CtripBridgeCommandService({
      tenantId,
      bridgePrincipalId,
      controlPlane: state.port,
      mediaObjectStore: { get: vi.fn(async () => new Uint8Array()) },
      adapter: state.simulator,
    });
    const port = await availablePort();
    const server = createCtripBridgeHttpServer({
      tenants: [{
        tenantId,
        bridgePrincipalId,
        accessToken,
        service,
        simulator: null,
        readiness: async () => ({
          schemaVersion: "geo.ctrip-operational-readiness.v1",
          status: "session_required",
          observedAt: "2026-07-16T12:00:00.000Z",
          manifestVersion: "ctrip-community-surface-review-v2",
          sessionEvidenceHash: "a".repeat(64),
          evidenceHash: "b".repeat(64),
        }),
      }],
      allowedHosts: [`127.0.0.1:${port}`],
      mode: "browser_preflight",
      adapterVersion: "ctrip-community-browser-preflight-v1",
      commandCapabilities: { prepare: true, submit: false, readback: false },
    });
    await listenCtripBridgeHttpServer(server, { host: "127.0.0.1", port });
    closeCallbacks.push(
      () =>
        new Promise<void>((resolvePromise, rejectPromise) =>
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
        ),
    );
    const origin = `http://127.0.0.1:${port}`;

    await expect(
      fetch(`${origin}/health/live`).then((response) => response.json()),
    ).resolves.toEqual({
      status: "ok",
      service: "geo-ctrip-bridge",
      mode: "browser_preflight",
      adapterVersion: "ctrip-community-browser-preflight-v1",
      commandCapabilities: { prepare: true, submit: false, readback: false },
    });
    const simulator = await fetch(`${origin}/simulator`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(simulator.status).toBe(404);
    const unauthenticatedReady = await fetch(`${origin}/health/ready`);
    expect(unauthenticatedReady.status).toBe(401);
    const ready = await fetch(`${origin}/health/ready`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      schemaVersion: "geo.ctrip-operational-readiness.v1",
      status: "session_required",
      mode: "browser_preflight",
    });
    for (const command of ["submit", "readback"] as const) {
      const response = await fetch(`${origin}/commands/${command}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...prepareCommand(),
          command,
          ...(command === "submit" ? { submitPermit: "a".repeat(64) } : {}),
        }),
      });
      expect(response.status).toBe(404);
    }
  });

  it("requires the tenant bearer and exact command route", async () => {
    const { origin } = await startedServer();
    const unauthenticated = await fetch(`${origin}/commands/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepareCommand()),
    });
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${origin}/commands/prepare`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(prepareCommand()),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      command: "prepare",
      evidenceKind: "simulation",
      state: "draft_prepared",
    });
  });

  it("renders only the authenticated tenant simulator draft", async () => {
    const { origin } = await startedServer();
    await fetch(`${origin}/commands/prepare`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(prepareCommand()),
    });
    const response = await fetch(`${origin}/simulator`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const html = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("携程社区仿真文章");
    expect(html).toContain("不连接真实携程");
    expect(html).toContain(handoffId);
  });

  it("rejects client-selected browser fields and cross-tenant commands", async () => {
    const { origin } = await startedServer();
    for (const body of [
      { ...prepareCommand(), selector: "#publish" },
      { ...prepareCommand(), tenantId: bridgePrincipalId },
    ]) {
      const response = await fetch(`${origin}/commands/prepare`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect([400, 403]).toContain(response.status);
    }
  });
});
