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
        executionLevel: "unattended",
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
      "geo_fact_lookup",
      expect.objectContaining({ query: "老年人出境跟团游注意事项" }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_draft_proposal",
      expect.objectContaining({
        idempotencyKey: `automation:${ids.run}:draft:v1`,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        executionLevel: "unattended",
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

  it("searches licensed media once before the Ctrip variant and uses the final version", async () => {
    const mediaVersion = "00000000-0000-4000-8000-000000000012";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: ids.contentVersion,
          finalContentVersionId: mediaVersion,
          plannedCount: 4,
          imported: [{}, {}, {}, {}],
        };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationRequestId: ids.jobA };
      return {};
    });
    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const result = await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "京都亲子行前核验清单",
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "ctrip_community",
          },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );
    expect(invoke.mock.calls.filter(([name]) => name === "geo_media_search_import")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ contentVersionId: mediaVersion }),
    );
    expect(checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "media", contentVersionId: mediaVersion, mediaCount: 4 }),
    ]));
    expect(result.targets[0]).toEqual(expect.objectContaining({ state: "awaiting_delivery" }));
  });

  it("checkpoints every imported image and resumes from the next intent", async () => {
    const mediaVersions = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
    ];
    let firstMediaCall = 0;
    const firstInvoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name !== "geo_media_search_import") return {};
      if (firstMediaCall === 2) throw new Error("MEDIA_SEARCH_PROVIDER_FAILED");
      const initialMediaCount = firstMediaCall;
      const finalContentVersionId = mediaVersions[firstMediaCall];
      firstMediaCall += 1;
      return {
        provider: "wikimedia_commons",
        sourceContentVersionId: args.contentVersionId,
        finalContentVersionId,
        plannedCount: 4,
        initialMediaCount,
        totalMediaCount: initialMediaCount + 1,
        complete: false,
        imported: [{}],
      };
    });
    const firstCheckpoints: ScheduledAutomationCheckpoint[] = [];
    await expect(
      new ScheduledAutomationRuntime({ invoke: firstInvoke }).run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          executionLevel: "unattended",
          topic: "Tokyo family travel",
          contentItemId: ids.contentItem,
          contentVersionId: ids.contentVersion,
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform: "ctrip_community",
            },
          ],
        },
        async (checkpoint) => {
          firstCheckpoints.push(checkpoint);
        },
      ),
    ).rejects.toThrow("MEDIA_SEARCH_PROVIDER_FAILED");
    expect(firstCheckpoints.filter((checkpoint) => checkpoint.stage === "media")).toEqual([
      expect.objectContaining({ mediaCount: 1, mediaComplete: false, contentVersionId: mediaVersions[0] }),
      expect.objectContaining({ mediaCount: 2, mediaComplete: false, contentVersionId: mediaVersions[1] }),
    ]);

    let resumedMediaCall = 0;
    const resumedInvoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        const initialMediaCount = 2 + resumedMediaCall;
        const finalContentVersionId = mediaVersions[2 + resumedMediaCall];
        resumedMediaCall += 1;
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: args.contentVersionId,
          finalContentVersionId,
          plannedCount: 4,
          initialMediaCount,
          totalMediaCount: initialMediaCount + 1,
          complete: initialMediaCount + 1 === 4,
          imported: [{}],
        };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationRequestId: ids.jobA };
      return {};
    });
    const resumedCheckpoints: ScheduledAutomationCheckpoint[] = [];
    const result = await new ScheduledAutomationRuntime({ invoke: resumedInvoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: mediaVersions[1]!,
        mediaSearchCompleted: false,
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "ctrip_community",
          },
        ],
      },
      async (checkpoint) => {
        resumedCheckpoints.push(checkpoint);
      },
    );

    expect(resumedInvoke.mock.calls.filter(([name]) => name === "geo_media_search_import")).toHaveLength(2);
    expect(resumedInvoke.mock.calls.find(([name]) => name === "geo_media_search_import")?.[1]).toMatchObject({
      contentVersionId: mediaVersions[1],
      maxImports: 1,
    });
    expect(resumedCheckpoints).toContainEqual(
      expect.objectContaining({ stage: "media", mediaCount: 4, mediaComplete: true }),
    );
    expect(result.contentVersionId).toBe(mediaVersions[3]);
  });

  it("fails closed when licensed search returns fewer than four media items", async () => {
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: ids.contentVersion,
          finalContentVersionId: ids.contentVersion,
          plannedCount: 4,
          imported: [{}, {}, {}],
        };
      }
      return {};
    });
    await expect(new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "京都亲子行前核验清单",
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "ctrip_community" }],
      },
      async () => undefined,
    )).rejects.toThrow("MEDIA_SEARCH_COUNT_INVALID");
    expect(invoke.mock.calls.some(([name]) => name === "geo_variant_preview")).toBe(false);
  });

  it("does not search again when resuming from the media checkpoint", async () => {
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "failed" };
      }
      return {};
    });
    await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "京都亲子行前核验清单",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        mediaSearchCompleted: true,
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "ctrip_community" }],
      },
      async () => undefined,
    );
    expect(invoke.mock.calls.some(([name]) => name === "geo_media_search_import")).toBe(false);
  });

  it("bounds fact lookup while preserving the full brief for draft generation", async () => {
    const invoke = vi.fn(
      async (name: string, _args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "failed" };
      }
      return {};
      },
    );
    const runtime = new ScheduledAutomationRuntime({ invoke });
    const brief = `日本亲子旅行 ${"发布前治理边界 ".repeat(80)}`;

    await runtime.run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: brief,
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" }],
      },
      async () => undefined,
    );

    const factCall = invoke.mock.calls.find(([name]) => name === "geo_fact_lookup");
    const draftCall = invoke.mock.calls.find(([name]) => name === "geo_draft_proposal");
    expect([...String(factCall?.[1].query)].length).toBe(200);
    expect(draftCall?.[1]).toMatchObject({ brief });
  });

  it("delegates a new Ctrip draft to the injected Pi author before deterministic targets", async () => {
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: ids.contentVersion,
          finalContentVersionId: ids.contentVersion,
          plannedCount: 4,
          imported: [{}, {}, {}, {}],
        };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "failed" };
      }
      return {};
    });
    const author = vi.fn(async () => ({
      contentItemId: ids.contentItem,
      contentVersionId: ids.contentVersion,
    }));
    const runtime = new ScheduledAutomationRuntime({ invoke }, { author });
    const brief = "完整携程自动化 brief，必须原样交给 Pi。";

    await runtime.run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: brief,
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "ctrip_community",
          },
        ],
      },
      async () => undefined,
    );

    expect(author).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief,
        idempotencyKey: `automation:${ids.run}:draft:v1`,
      }),
      undefined,
    );
    expect(invoke.mock.calls.map(([name]) => name)).not.toEqual(
      expect.arrayContaining([
        "plastic_context_supply",
        "geo_tenant_context",
        "geo_fact_lookup",
        "geo_draft_proposal",
      ]),
    );
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
          executionLevel: "dry_run",
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
          executionLevel: "dry_run",
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
          executionLevel: "dry_run",
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
