import { describe, expect, it, vi } from "vitest";

import {
  ScheduledAutomationRuntime,
  type ScheduledAutomationCheckpoint,
} from "./automation-runtime.js";

const ids = {
  tenant: "00000000-0000-4000-8000-000000000001",
  brand: "00000000-0000-4000-8000-000000000002",
  campaign: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
  targetA: "00000000-0000-4000-8000-000000000005",
  targetB: "00000000-0000-4000-8000-000000000006",
  accountA: "00000000-0000-4000-8000-000000000007",
  accountB: "00000000-0000-4000-8000-000000000008",
  contentVersion: "00000000-0000-4000-8000-000000000009",
  contentItem: "00000000-0000-4000-8000-00000000000f",
  variantA: "00000000-0000-4000-8000-00000000000a",
  variantB: "00000000-0000-4000-8000-00000000000b",
  auditA: "00000000-0000-4000-8000-00000000000c",
  auditB: "00000000-0000-4000-8000-00000000000d",
  artifactA: "00000000-0000-4000-8000-000000000010",
  artifactB: "00000000-0000-4000-8000-000000000011",
  jobA: "00000000-0000-4000-8000-00000000000e",
};

describe("ScheduledAutomationRuntime", () => {
  it("creates one draft and independently checkpoints every dry-run target", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_variant_preview") {
        return {
          variantId: args.channelAccountId === ids.accountA ? ids.variantA : ids.variantB,
        };
      }
      if (name === "geo_audit_request") {
        const first = args.variantId === ids.variantA;
        return {
          auditRunId: first ? ids.auditA : ids.auditB,
          auditArtifactId: first ? ids.artifactA : ids.artifactB,
          status: first ? "passed" : "failed",
          eligibleForPublicationRequest: first,
        };
      }
      if (name === "geo_publication_request") {
        return { publicationRequestId: ids.jobA };
      }
      return {};
    });
    const checkpoints: unknown[] = [];
    const runtime = new ScheduledAutomationRuntime({ invoke });

    const result = await runtime.run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        topic: "老年人出境跟团游注意事项",
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "toutiao",
          },
          {
            targetId: ids.targetB,
            channelAccountId: ids.accountB,
            platform: "sohu",
          },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(invoke.mock.calls.filter(([name]) => name === "geo_draft_proposal")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      "geo_draft_proposal",
      expect.objectContaining({
        idempotencyKey: `automation:${ids.run}:draft:v1`,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        executionLevel: "dry_run",
        idempotencyKey: `automation:${ids.run}:target:${ids.targetA}:publication:v1`,
      }),
    );
    expect(
      invoke.mock.calls.some(
        ([name, args]) =>
          name === "geo_publication_request" && args.channelAccountId === ids.accountB,
      ),
    ).toBe(false);
    expect(result.targets).toEqual([
      expect.objectContaining({ targetId: ids.targetA, state: "awaiting_delivery" }),
      expect.objectContaining({ targetId: ids.targetB, state: "audit_failed" }),
    ]);
    expect(checkpoints).toEqual([
      expect.objectContaining({
        stage: "draft",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      }),
      expect.objectContaining({ stage: "target", targetId: ids.targetA, state: "variant_ready" }),
      expect.objectContaining({
        stage: "target",
        targetId: ids.targetA,
        state: "awaiting_delivery",
      }),
      expect.objectContaining({ stage: "target", targetId: ids.targetB, state: "variant_ready" }),
      expect.objectContaining({ stage: "target", targetId: ids.targetB, state: "audit_failed" }),
    ]);
  });

  it("propagates checkpoint failures before advancing the workflow", async () => {
    const invoke = vi.fn(async (name: string) =>
      name === "geo_draft_proposal"
        ? { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion }
        : {},
    );
    const runtime = new ScheduledAutomationRuntime({ invoke });

    await expect(
      runtime.run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          topic: "老年人出境跟团游注意事项",
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform: "toutiao",
            },
          ],
        },
        async () => {
          throw new Error("checkpoint unavailable");
        },
      ),
    ).rejects.toThrow("checkpoint unavailable");
    expect(invoke.mock.calls.some(([name]) => name === "geo_variant_preview")).toBe(false);
  });

  it("does not downgrade a target checkpoint outage into a target failure", async () => {
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      return {};
    });
    const runtime = new ScheduledAutomationRuntime({ invoke });
    let checkpoints = 0;

    await expect(
      runtime.run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          topic: "老年人出境跟团游注意事项",
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform: "toutiao",
            },
          ],
        },
        async () => {
          checkpoints += 1;
          if (checkpoints === 2) throw new Error("checkpoint unavailable");
        },
      ),
    ).rejects.toThrow("checkpoint unavailable");
    expect(checkpoints).toBe(2);
    expect(invoke.mock.calls.some(([name]) => name === "geo_audit_request")).toBe(false);
  });

  it("propagates retryable target transport errors for run-level reconciliation", async () => {
    const transportError = Object.assign(new Error("transport unavailable"), {
      code: "GEO_API_TRANSPORT_FAILED",
      status: 503,
    });
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "passed",
        };
      }
      if (name === "geo_publication_request") throw transportError;
      return {};
    });
    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const runtime = new ScheduledAutomationRuntime({ invoke });

    await expect(
      runtime.run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          topic: "verified travel service",
          contentItemId: ids.contentItem,
          contentVersionId: ids.contentVersion,
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform: "toutiao",
            },
          ],
        },
        async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      ),
    ).rejects.toBe(transportError);
    expect(
      checkpoints.map((checkpoint) =>
        "state" in checkpoint ? checkpoint.state : checkpoint.stage,
      ),
    ).toEqual(["variant_ready"]);
  });
});
