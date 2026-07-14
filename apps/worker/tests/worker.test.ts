import {
  createDefaultConnectorRegistry,
  stableSha256,
  type PlatformConnector,
  type PublishInput,
  type PublishResult,
  type ReconcileInput,
  type ReconcileResult,
} from "@geo/connectors";
import type { Platform, PublicationVariantPayload } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import { UncertainPublicationError } from "../src/errors.js";
import { OutboxWorker } from "../src/worker.js";
import type { ClaimedOutboxEvent, ConnectorResolver, PublicationWork } from "../src/types.js";
import { FakeDispatcherStore, FakeTenantJobStore } from "./fakes.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000101";
const variantId = "10000000-0000-4000-8000-000000001001";
const accountId = "10000000-0000-4000-8000-000000001002";

const payload: PublicationVariantPayload = {
  title: "日本跟团游选择指南",
  summary: "基于可核验服务信息整理的选择要点。",
  bodyMarkdown: "## 先核验服务主体\n\n确认联系方式、行程与合同信息。",
  media: [],
  claims: [],
  contactIds: [],
  tags: ["日本旅游", "跟团游"],
};

function makeWork(
  platform: Platform,
  jobId = `10000000-0000-4000-8000-000000002001`,
): PublicationWork {
  const payloadHash = stableSha256(payload);
  return {
    job: {
      id: jobId,
      state: "queued",
      platform,
      executionLevel: "dry_run",
      idempotencyKey: `job:${jobId}`,
      requestHash: "a".repeat(64),
      payloadHash,
      variantId,
      channelAccountId: accountId,
    },
    variant: {
      id: variantId,
      state: "frozen",
      payload,
      payloadHash,
      platform,
      channelAccountId: accountId,
    },
    account: {
      id: accountId,
      platform,
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      status: "active",
    },
    gate: { allowed: true, reason: null },
    existingReceipt: null,
  };
}

function makeEvent(work: PublicationWork, attempts = 1): ClaimedOutboxEvent {
  return {
    tenantId,
    eventId: `10000000-0000-4000-8000-000000003001`,
    topic: "publication.requested",
    payload: {
      tenantId,
      jobId: work.job.id,
      variantId: work.variant.id,
      channelAccountId: work.account.id,
      platform: work.job.platform,
      executionLevel: work.job.executionLevel,
      payloadHash: work.job.payloadHash,
    },
    attempts,
    lockedUntil: new Date("2026-07-14T00:01:00.000Z"),
  };
}

function idGenerator(): () => string {
  let value = 10;
  return () => `30000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function setup(
  work: PublicationWork,
  resolver: ConnectorResolver = createDefaultConnectorRegistry(),
) {
  const event = makeEvent(work);
  const dispatcher = new FakeDispatcherStore([event]);
  const jobs = new FakeTenantJobStore();
  jobs.works.set(work.job.id, work);
  const worker = new OutboxWorker({
    dispatcher,
    jobs,
    connectors: resolver,
    workerId: "test-worker",
    actorId,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    idGenerator: idGenerator(),
  });
  return { dispatcher, event, jobs, worker };
}

describe.each(["toutiao", "sohu", "ctrip_community"] as const)(
  "%s dry-run publication",
  (platform) => {
    it("stores an immutable preview receipt and completes the workflow without readback", async () => {
      const work = makeWork(platform);
      const { dispatcher, jobs, worker } = setup(work);

      const summary = await worker.runOnce();

      expect(summary).toMatchObject({ claimed: 1, completed: 1, acknowledged: 1 });
      expect(dispatcher.retries).toHaveLength(0);
      expect(jobs.completions).toHaveLength(1);
      expect(jobs.completions[0]?.receipt).toMatchObject({
        platform,
        executionLevel: "dry_run",
        evidenceType: "preview",
        confirmed: false,
        externalId: null,
        externalUrl: null,
      });
      expect(jobs.completions[0]?.connectorOutcome).toBe("preview_only");
    });
  },
);

it("relies on atomic claim so concurrent workers publish a shared event once", async () => {
  const work = makeWork("toutiao");
  const dispatcher = new FakeDispatcherStore([makeEvent(work)]);
  const jobs = new FakeTenantJobStore();
  jobs.works.set(work.job.id, work);
  const connector = createDefaultConnectorRegistry().get("toutiao");
  let publishCalls = 0;
  const resolver: ConnectorResolver = {
    get: () =>
      new Proxy(connector, {
        get(target, property, receiver) {
          if (property === "publish") {
            return async (input: PublishInput) => {
              publishCalls += 1;
              return target.publish(input);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  };
  const options = {
    dispatcher,
    jobs,
    connectors: resolver,
    workerId: "worker-a",
    actorId,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    idGenerator: idGenerator(),
  };

  await Promise.all([
    new OutboxWorker(options).runOnce(),
    new OutboxWorker({ ...options, workerId: "worker-b" }).runOnce(),
  ]);

  expect(publishCalls).toBe(1);
  expect(jobs.completions).toHaveLength(1);
});

it("acknowledges a redelivered job with an existing receipt without publishing again", async () => {
  const work = makeWork("sohu");
  work.job.state = "preview_completed";
  work.existingReceipt = {
    id: "30000000-0000-4000-8000-000000000001",
    tenantId,
    jobId: work.job.id,
    attemptId: "30000000-0000-4000-8000-000000000002",
    platform: "sohu",
    executionLevel: "dry_run",
    evidenceType: "preview",
    requestHash: "b".repeat(64),
    responseHash: "c".repeat(64),
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    recordedAt: "2026-07-14T00:00:00.000Z",
    confirmed: false,
  };
  const connector = createDefaultConnectorRegistry().get("sohu");
  let publishCalls = 0;
  const resolver: ConnectorResolver = {
    get: () =>
      ({
        ...connector,
        platform: connector.platform,
        publish: async (input: PublishInput) => {
          publishCalls += 1;
          return connector.publish(input);
        },
      }) as PlatformConnector,
  };
  const { dispatcher, worker } = setup(work, resolver);

  const summary = await worker.runOnce();

  expect(publishCalls).toBe(0);
  expect(summary.acknowledged).toBe(1);
  expect(dispatcher.acknowledged).toHaveLength(1);
});

it("dead-letters payload hash mutation before invoking a connector", async () => {
  const work = makeWork("toutiao");
  work.variant.payloadHash = "f".repeat(64);
  const { dispatcher, jobs, worker } = setup(work);

  const summary = await worker.runOnce();

  expect(summary.deadLettered).toBe(1);
  expect(dispatcher.retries[0]).toMatchObject({ deadLetter: true });
  expect(jobs.failures[0]).toMatchObject({ code: "PAYLOAD_HASH_MISMATCH", final: true });
  expect(jobs.completions).toHaveLength(0);
});

it("retries transient connector failures and dead-letters at the attempt limit", async () => {
  const connector = createDefaultConnectorRegistry().get("toutiao");
  const resolver: ConnectorResolver = {
    get: () =>
      ({
        ...connector,
        platform: connector.platform,
        publish: async () => {
          throw new Error("temporary connector failure");
        },
      }) as PlatformConnector,
  };
  const retrySetup = setup(makeWork("toutiao"), resolver);
  await retrySetup.worker.runOnce();
  expect(retrySetup.dispatcher.retries[0]).toMatchObject({ deadLetter: false });
  expect(retrySetup.jobs.failures[0]).toMatchObject({ final: false });

  const finalWork = makeWork("toutiao", "10000000-0000-4000-8000-000000002099");
  const finalEvent = makeEvent(finalWork, 5);
  const finalDispatcher = new FakeDispatcherStore([finalEvent]);
  const finalJobs = new FakeTenantJobStore();
  finalJobs.works.set(finalWork.job.id, finalWork);
  const finalWorker = new OutboxWorker({
    dispatcher: finalDispatcher,
    jobs: finalJobs,
    connectors: resolver,
    workerId: "test-worker",
    actorId,
    maxAttempts: 5,
    idGenerator: idGenerator(),
  });
  await finalWorker.runOnce();
  expect(finalDispatcher.retries[0]).toMatchObject({ deadLetter: true });
  expect(finalJobs.failures[0]).toMatchObject({ final: true });
});

it("does not publish while a kill switch or circuit gate is closed", async () => {
  const work = makeWork("ctrip_community");
  work.gate = { allowed: false, reason: "tenant kill switch is enabled" };
  const { dispatcher, jobs, worker } = setup(work);

  await worker.runOnce();

  expect(jobs.completions).toHaveLength(0);
  expect(jobs.failures[0]).toMatchObject({ code: "PUBLICATION_GATE_BLOCKED", final: false });
  expect(dispatcher.retries[0]).toMatchObject({ deadLetter: false });
});

it("persists UNCERTAIN, reconciles, and retries only after not_published evidence", async () => {
  const base = createDefaultConnectorRegistry().get("toutiao");
  let publishCalls = 0;
  let reconcileCalls = 0;
  const uncertainConnector = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "publish") {
        return async (input: PublishInput): Promise<PublishResult> => {
          publishCalls += 1;
          const result = await target.publish(input);
          throw new UncertainPublicationError("response lost after request", result.receipt);
        };
      }
      if (property === "reconcile") {
        return async (input: ReconcileInput): Promise<ReconcileResult> => {
          reconcileCalls += 1;
          return target.reconcile(input);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { dispatcher, jobs, worker } = setup(makeWork("toutiao"), {
    get: () => uncertainConnector,
  });

  const summary = await worker.runOnce();

  expect(publishCalls).toBe(1);
  expect(reconcileCalls).toBe(1);
  expect(jobs.uncertainties).toHaveLength(1);
  expect(jobs.resolutions[0]?.result.outcome).toBe("not_published");
  expect(dispatcher.retries[0]).toMatchObject({ deadLetter: false });
  expect(summary.reconciled).toBe(1);
});

it("retries reconciliation without publishing when an uncertain job is redelivered", async () => {
  const work = makeWork("toutiao");
  work.job.state = "uncertain";
  work.existingReceipt = {
    id: "30000000-0000-4000-8000-000000000031",
    tenantId,
    jobId: work.job.id,
    attemptId: "30000000-0000-4000-8000-000000000032",
    platform: "toutiao",
    executionLevel: "dry_run",
    evidenceType: "preview",
    requestHash: "d".repeat(64),
    responseHash: "e".repeat(64),
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    recordedAt: "2026-07-14T00:00:00.000Z",
    confirmed: false,
  };
  const base = createDefaultConnectorRegistry().get("toutiao");
  let publishCalls = 0;
  let reconcileCalls = 0;
  const connector = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "publish") {
        return async (input: PublishInput) => {
          publishCalls += 1;
          return target.publish(input);
        };
      }
      if (property === "reconcile") {
        return async () => {
          reconcileCalls += 1;
          throw new Error("readback temporarily unavailable");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { dispatcher, jobs, worker } = setup(work, { get: () => connector });

  const summary = await worker.runOnce();

  expect(publishCalls).toBe(0);
  expect(reconcileCalls).toBe(1);
  expect(work.job.state).toBe("uncertain");
  expect(jobs.failures).toHaveLength(0);
  expect(dispatcher.retries[0]).toMatchObject({ deadLetter: false });
  expect(summary.retried).toBe(1);
});
