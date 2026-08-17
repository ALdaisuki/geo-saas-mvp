import { describe, expect, it, vi } from "vitest";

import {
  automationAuditRemediationPlan,
  ScheduledAutomationRuntime,
  type AutomationDraftAuthor,
  type AutomationDraftTrace,
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
  contentVersionB: "00000000-0000-4000-8000-000000000019",
  contentVersionC: "00000000-0000-4000-8000-000000000029",
  contentItem: "00000000-0000-4000-8000-00000000000f",
  variantA: "00000000-0000-4000-8000-00000000000a",
  variantB: "00000000-0000-4000-8000-00000000000b",
  auditA: "00000000-0000-4000-8000-00000000000c",
  auditB: "00000000-0000-4000-8000-00000000000d",
  artifactA: "00000000-0000-4000-8000-000000000010",
  artifactB: "00000000-0000-4000-8000-000000000011",
  jobA: "00000000-0000-4000-8000-00000000000e",
};
const draftTrace = {
  providerMode: "pi_authored" as const,
  provider: "openai-compatible",
  model: "gpt-5.6-sol",
  providerRunId: "00000000-0000-4000-8000-000000000012",
  providerRequestId: "provider-request-automation-1",
};

function completedMedia(args: Readonly<Record<string, unknown>>) {
  return {
    provider: "wikimedia_commons",
    sourceContentVersionId: args.contentVersionId,
    finalContentVersionId: args.contentVersionId,
    plannedCount: 4,
    imported: [{}, {}, {}, {}],
  };
}

describe("ScheduledAutomationRuntime", () => {
  it("routes platform enforcement findings to manual remediation", () => {
    expect(
      automationAuditRemediationPlan({
        runId: ids.run,
        targetId: ids.targetA,
        attempt: 1,
        maxAttempts: 2,
        audit: {
          status: "failed",
          findings: [{ ruleId: "platform.risk_control" }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        mode: "manual",
        actions: ["manual_review"],
        reasonCodes: ["platform.risk_control"],
      }),
    );
  });

  it("routes Ctrip brand count findings to automatic article rebuild", () => {
    expect(
      automationAuditRemediationPlan({
        runId: ids.run,
        targetId: ids.targetA,
        attempt: 1,
        maxAttempts: 2,
        audit: {
          status: "failed",
          findings: [{ ruleId: "platform.brand.body_count_invalid" }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        mode: "automatic",
        actions: expect.arrayContaining(["rebuild_article", "reformat_for_platform"]),
        reasonCodes: ["platform.brand.body_count_invalid"],
      }),
    );
  });

  it("creates one draft and independently checkpoints every dry-run target", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") return completedMedia(args);
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
          findings: first
            ? []
            : [{ ruleId: "promotion.absolute_claim", path: "bodyBlocks[2].text" }],
        };
      }
      if (name === "geo_publication_request") {
        return { publicationRequestId: ids.jobA };
      }
      return {};
    });
    const checkpoints: ScheduledAutomationCheckpoint[] = [];
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
        idempotencyKey: `automation:${ids.run}:platform:toutiao:draft:v1`,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        platform: "toutiao",
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
      expect.objectContaining({
        targetId: ids.targetB,
        state: "awaiting_manual_review",
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
        errorMessage: "审核未通过：promotion.absolute_claim @ bodyBlocks[2].text",
        remediation: expect.objectContaining({ mode: "manual" }),
      }),
    ]);
    expect(checkpoints.filter((checkpoint) => checkpoint.stage !== "media")).toEqual([
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
      expect.objectContaining({
        stage: "target",
        targetId: ids.targetB,
        state: "awaiting_manual_review",
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
        errorMessage: "审核未通过：promotion.absolute_claim @ bodyBlocks[2].text",
      }),
    ]);
  });

  it("runs distinct accounts in parallel and isolates a resource conflict to one target", async () => {
    const publicationStarted: string[] = [];
    let releaseConflictedTarget!: () => void;
    const conflictedTargetReleased = new Promise<void>((resolve) => {
      releaseConflictedTarget = resolve;
    });
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") {
        return { variantId: args.channelAccountId === ids.accountA ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        const first = args.variantId === ids.variantA;
        return {
          auditRunId: first ? ids.auditA : ids.auditB,
          auditArtifactId: first ? ids.artifactA : ids.artifactB,
          status: "passed",
        };
      }
      if (name === "geo_publication_request") {
        const accountId = String(args.channelAccountId);
        publicationStarted.push(accountId);
        if (accountId === ids.accountA) {
          await conflictedTargetReleased;
          throw Object.assign(new Error("account writer is busy"), {
            code: "RESOURCE_CONFLICT",
            retryable: true,
          });
        }
        return { publicationRequestId: ids.jobA };
      }
      return {};
    });

    const runtime = new ScheduledAutomationRuntime({ invoke }, undefined, {
      targetConcurrency: 2,
      resourceConflictRetryAttempts: 0,
      wait: async () => undefined,
    });
    const runPromise = runtime.run(
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
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" },
          { targetId: ids.targetB, channelAccountId: ids.accountB, platform: "sohu" },
        ],
      },
      async () => undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(publicationStarted).toEqual(expect.arrayContaining([ids.accountA, ids.accountB]));
    releaseConflictedTarget();
    const result = await runPromise;
    expect(result.targets).toEqual([
      expect.objectContaining({
        targetId: ids.targetA,
        state: "delivery_failed",
        errorCode: "RESOURCE_CONFLICT",
      }),
      expect.objectContaining({
        targetId: ids.targetB,
        state: "awaiting_delivery",
      }),
    ]);
  });

  it("authors each platform variant in a fresh Pi session", async () => {
    const authoredVersions: ReadonlyMap<string, string> = new Map([
      ["baijiahao", ids.contentVersion],
      ["toutiao", ids.contentVersionB],
      ["ctrip_community", ids.contentVersionC],
    ] as const);
    let providerRunIndex = 0;
    const author = vi.fn<AutomationDraftAuthor["author"]>(async (input) => {
      providerRunIndex += 1;
      return {
        ...draftTrace,
        providerRunId: `00000000-0000-4000-8000-${providerRunIndex.toString().padStart(12, "0")}`,
        providerRequestId: `provider-request-${input.targetPlatform}`,
        contentItemId: ids.contentItem,
        contentVersionId: authoredVersions.get(input.targetPlatform) ?? ids.contentVersion,
      };
    });
    const previews: Array<Readonly<Record<string, unknown>>> = [];
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") {
        previews.push(args);
        return {
          variantId:
            args.platform === "baijiahao"
              ? ids.variantA
              : args.platform === "toutiao"
                ? ids.variantB
                : ids.jobA,
        };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "passed",
        };
      }
      if (name === "geo_publication_request") return { publicationJobId: ids.jobA };
      return {};
    });

    await new ScheduledAutomationRuntime({ invoke }, { author }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南跟团旅行体验",
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "baijiahao",
          },
          {
            targetId: ids.targetB,
            channelAccountId: ids.accountB,
            platform: "toutiao",
          },
          {
            targetId: ids.jobA,
            channelAccountId: ids.contentItem,
            platform: "ctrip_community",
          },
        ],
      },
      async () => undefined,
    );

    expect(author).toHaveBeenCalledTimes(3);
    expect(author.mock.calls.map(([input]) => input.targetPlatform)).toEqual([
      "ctrip_community",
      "baijiahao",
      "toutiao",
    ]);
    expect(author.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      `automation:${ids.run}:platform:ctrip_community:draft:v1`,
      `automation:${ids.run}:platform:baijiahao:draft:v1`,
      `automation:${ids.run}:platform:toutiao:draft:v1`,
    ]);
    expect(previews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "baijiahao",
          contentVersionId: ids.contentVersion,
        }),
        expect.objectContaining({
          platform: "toutiao",
          contentVersionId: ids.contentVersionB,
        }),
        expect.objectContaining({
          platform: "ctrip_community",
          contentVersionId: ids.contentVersionC,
        }),
      ]),
    );
  });

  it("stores a bounded original message for a non-retryable target failure", async () => {
    const rawMessage = `  publication adapter rejected the target: ${"x".repeat(600)}  `;
    const targetError = Object.assign(new Error(rawMessage), {
      code: "PUBLICATION_ADAPTER_REJECTED",
    });
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") throw targetError;
      return {};
    });
    const checkpoints: ScheduledAutomationCheckpoint[] = [];

    const result = await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "verified travel service",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        mediaSearchCompletedPlatforms: ["toutiao"],
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
    );
    const expectedMessage = rawMessage.trim().slice(0, 500);

    expect(result.targets).toEqual([
      expect.objectContaining({
        targetId: ids.targetA,
        state: "failed",
        errorCode: "PUBLICATION_ADAPTER_REJECTED",
        errorMessage: expectedMessage,
      }),
    ]);
    expect(expectedMessage).toHaveLength(500);
    expect(checkpoints.at(-1)).toEqual(
      expect.objectContaining({
        stage: "target",
        targetId: ids.targetA,
        state: "failed",
        errorCode: "PUBLICATION_ADAPTER_REJECTED",
        errorMessage: expectedMessage,
      }),
    );
  });

  it("searches licensed media once before the Ctrip variant and uses the final version", async () => {
    const mediaVersion = "00000000-0000-4000-8000-000000000012";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      void args;
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
    expect(invoke.mock.calls.filter(([name]) => name === "geo_media_search_import")).toHaveLength(
      1,
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ contentVersionId: mediaVersion }),
    );
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "media", contentVersionId: mediaVersion, mediaCount: 4 }),
      ]),
    );
    expect(result.targets[0]).toEqual(expect.objectContaining({ state: "awaiting_delivery" }));
  });

  it("pauses every pending target after image import when the final version needs manual review", async () => {
    const mediaVersion = "00000000-0000-4000-8000-000000000098";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") {
        return {
          ...completedMedia(args),
          finalContentVersionId: mediaVersion,
          manualReviewRequired: true,
        };
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationJobId: ids.jobA };
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
        topic: "带长者出行的行前准备",
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "toutiao",
          },
          {
            targetId: ids.targetB,
            channelAccountId: ids.accountB,
            platform: "ctrip_community",
          },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(result.contentVersionId).toBe(mediaVersion);
    expect(result.targets).toEqual([
      { targetId: ids.targetA, state: "awaiting_manual_review" },
      { targetId: ids.targetB, state: "awaiting_manual_review" },
    ]);
    expect(
      checkpoints.filter(
        (checkpoint) =>
          checkpoint.stage === "target" && checkpoint.state === "awaiting_manual_review",
      ),
    ).toHaveLength(2);
    expect(invoke.mock.calls.some(([name]) => name === "geo_variant_preview")).toBe(false);
    expect(invoke.mock.calls.some(([name]) => name === "geo_audit_request")).toBe(false);
    expect(invoke.mock.calls.some(([name]) => name === "geo_publication_request")).toBe(false);
  });

  it.each(["toutiao", "sohu", "baijiahao", "netease"] as const)(
    "searches licensed media before the %s browser article variant",
    async (platform) => {
      const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
        if (name === "geo_media_search_import") {
          return {
            provider: "wikimedia_commons",
            sourceContentVersionId: args.contentVersionId,
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

      await new ScheduledAutomationRuntime({ invoke }).run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          executionLevel: "dry_run",
          topic: "Tokyo family travel",
          contentItemId: ids.contentItem,
          contentVersionId: ids.contentVersion,
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform,
            },
          ],
        },
        async () => undefined,
      );

      expect(invoke.mock.calls.filter(([name]) => name === "geo_media_search_import")).toHaveLength(
        1,
      );
      expect(invoke).toHaveBeenCalledWith(
        "geo_media_search_import",
        expect.objectContaining({ platform }),
      );
      const callNames = invoke.mock.calls.map(([name]) => name);
      expect(callNames.indexOf("geo_media_search_import")).toBeLessThan(
        callNames.indexOf("geo_variant_preview"),
      );
    },
  );

  it("searches media independently for each distinct platform in a mixed target run", async () => {
    const toutiaoMediaVersion = "00000000-0000-4000-8000-000000000051";
    const sohuMediaVersion = "00000000-0000-4000-8000-000000000052";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: args.contentVersionId,
          finalContentVersionId:
            args.platform === "toutiao" ? toutiaoMediaVersion : sohuMediaVersion,
          plannedCount: 4,
          imported: [{}, {}, {}, {}],
        };
      }
      if (name === "geo_variant_preview") {
        return { variantId: args.platform === "toutiao" ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        const first = args.variantId === ids.variantA;
        return {
          auditRunId: first ? ids.auditA : ids.auditB,
          auditArtifactId: first ? ids.artifactA : ids.artifactB,
          status: "failed",
        };
      }
      return {};
    });

    await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
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
      async () => undefined,
    );

    expect(
      invoke.mock.calls
        .filter(([name]) => name === "geo_media_search_import")
        .map(([, args]) => args.platform),
    ).toEqual(["toutiao", "sohu"]);
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ platform: "toutiao", contentVersionId: toutiaoMediaVersion }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ platform: "sohu", contentVersionId: sohuMediaVersion }),
    );
  });

  it("reuses already completed media when a later platform media search fails", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        if (args.platform === "sohu") {
          throw { code: "MEDIA_SEARCH_INTENT_UNFILLED" };
        }
        return completedMedia(args);
      }
      if (name === "geo_variant_preview") {
        return { variantId: args.platform === "toutiao" ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "passed",
        };
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
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" },
          { targetId: ids.targetB, channelAccountId: ids.accountB, platform: "sohu" },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(result.targets).toEqual([
      expect.objectContaining({ targetId: ids.targetA, state: "awaiting_delivery" }),
      expect.objectContaining({ targetId: ids.targetB, state: "awaiting_delivery" }),
    ]);
    expect(
      invoke.mock.calls
        .filter(([name]) => name === "geo_media_search_import")
        .map(([, args]) => args.platform),
    ).toEqual(["toutiao", "sohu"]);
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "media",
          platform: "sohu",
          mediaComplete: true,
          provider: "wikimedia_commons",
          mediaCount: 4,
          completedPlatforms: ["toutiao", "sohu"],
        }),
      ]),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({ channelAccountId: ids.accountB }),
    );
  });

  it("holds only media-unfilled platforms for review without blocking other targets", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        if (args.platform === "sohu") return completedMedia(args);
        throw { code: "MEDIA_SEARCH_INTENT_UNFILLED" };
      }
      if (name === "geo_variant_preview") {
        return { variantId: args.platform === "toutiao" ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "passed",
        };
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
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" },
          { targetId: ids.targetB, channelAccountId: ids.accountB, platform: "sohu" },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        targetId: ids.targetA,
        state: "awaiting_manual_review",
        errorCode: "MEDIA_SEARCH_UNFILLED",
        errorMessage:
          "Media search and remediation exhausted before any article media was produced",
      }),
      expect.objectContaining({ targetId: ids.targetB, state: "awaiting_delivery" }),
    ]);
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "target",
          targetId: ids.targetA,
          state: "awaiting_manual_review",
          errorCode: "MEDIA_SEARCH_UNFILLED",
        }),
      ]),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({ channelAccountId: ids.accountB }),
    );
  });

  it("resumes only the unfinished platform in a mixed target run", async () => {
    const sohuMediaVersion = "00000000-0000-4000-8000-000000000053";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        return {
          ...completedMedia(args),
          finalContentVersionId: sohuMediaVersion,
        };
      }
      if (name === "geo_variant_preview") {
        return { variantId: args.platform === "toutiao" ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
        };
      }
      return {};
    });

    await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        mediaSearchCompletedPlatforms: ["toutiao"],
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" },
          { targetId: ids.targetB, channelAccountId: ids.accountB, platform: "sohu" },
        ],
      },
      async () => undefined,
    );

    expect(
      invoke.mock.calls
        .filter(([name]) => name === "geo_media_search_import")
        .map(([, args]) => args.platform),
    ).toEqual(["sohu"]);
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ platform: "toutiao", contentVersionId: ids.contentVersion }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ platform: "sohu", contentVersionId: sohuMediaVersion }),
    );
  });

  it("treats legacy mediaSearchCompleted as Ctrip-only in a mixed-platform resume", async () => {
    const toutiaoMediaVersion = "00000000-0000-4000-8000-000000000054";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        return {
          ...completedMedia(args),
          finalContentVersionId: toutiaoMediaVersion,
        };
      }
      if (name === "geo_variant_preview") {
        return { variantId: args.platform === "ctrip_community" ? ids.variantA : ids.variantB };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
        };
      }
      return {};
    });

    await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        mediaSearchCompleted: true,
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "ctrip_community",
          },
          {
            targetId: ids.targetB,
            channelAccountId: ids.accountB,
            platform: "toutiao",
          },
        ],
      },
      async () => undefined,
    );

    expect(
      invoke.mock.calls
        .filter(([name]) => name === "geo_media_search_import")
        .map(([, args]) => args.platform),
    ).toEqual(["toutiao"]);
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({
        platform: "ctrip_community",
        contentVersionId: ids.contentVersion,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({ platform: "toutiao", contentVersionId: toutiaoMediaVersion }),
    );
  });

  it("does not audit a legacy non-Ctrip variant_ready target without completed media", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") return { variantId: ids.variantB };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationJobId: ids.jobA };
      return {};
    });

    const result = await new ScheduledAutomationRuntime({ invoke }).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "toutiao",
            state: "variant_ready",
            variantId: ids.variantA,
          },
        ],
      },
      async () => undefined,
    );

    expect(
      invoke.mock.calls.find(
        ([name, args]) => name === "geo_audit_request" && args.variantId === ids.variantA,
      ),
    ).toBeUndefined();
    expect(
      invoke.mock.calls.find(
        ([name, args]) => name === "geo_publication_request" && args.variantId === ids.variantA,
      ),
    ).toBeUndefined();
    const rebuilt =
      invoke.mock.calls.some(([name]) => name === "geo_media_search_import") &&
      invoke.mock.calls.some(([name]) => name === "geo_variant_preview");
    const targetResult = result.targets[0];
    const explicitlyBlocked =
      targetResult?.state === "failed" &&
      typeof targetResult.errorCode === "string" &&
      targetResult.errorCode.length > 0;
    expect(rebuilt || explicitlyBlocked).toBe(true);
  });

  it("uses the alternate media lineage only for the target being remediated", async () => {
    const initialMediaVersion = "00000000-0000-4000-8000-000000000055";
    const alternateContentVersion = "00000000-0000-4000-8000-000000000056";
    const alternateMediaVersion = "00000000-0000-4000-8000-000000000057";
    const alternateVariant = "00000000-0000-4000-8000-000000000058";
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        return {
          ...completedMedia(args),
          finalContentVersionId:
            args.contentVersionId === alternateContentVersion
              ? alternateMediaVersion
              : initialMediaVersion,
        };
      }
      if (name === "geo_variant_preview") {
        if (args.channelAccountId === ids.accountB) return { variantId: ids.variantB };
        return {
          variantId:
            args.contentVersionId === alternateMediaVersion ? alternateVariant : ids.variantA,
        };
      }
      if (name === "geo_audit_request" && args.variantId === ids.variantA) {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
          findings: [{ ruleId: "duplicate.near" }],
        };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditB,
          auditArtifactId: ids.artifactB,
          status: "failed",
          findings: [],
        };
      }
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: alternateContentVersion,
      })),
    };

    await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "dry_run",
        topic: "Tokyo family travel",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" },
          { targetId: ids.targetB, channelAccountId: ids.accountB, platform: "toutiao" },
        ],
      },
      async () => undefined,
    );

    expect(invoke).toHaveBeenCalledWith(
      "geo_media_search_import",
      expect.objectContaining({
        platform: "toutiao",
        contentVersionId: alternateContentVersion,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({
        channelAccountId: ids.accountA,
        contentVersionId: alternateMediaVersion,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_variant_preview",
      expect.objectContaining({
        channelAccountId: ids.accountB,
        contentVersionId: initialMediaVersion,
      }),
    );
  });

  it("rewrites once with an alternate draft when deterministic duplicate audit blocks", async () => {
    const alternateContentVersion = "00000000-0000-4000-8000-000000000013";
    const alternateVariant = "00000000-0000-4000-8000-000000000014";
    const alternateAudit = "00000000-0000-4000-8000-000000000015";
    const alternateArtifact = "00000000-0000-4000-8000-000000000016";
    const alternateJob = "00000000-0000-4000-8000-000000000017";
    const alternateRun = "00000000-0000-4000-8000-00000000001a";
    let draftAttempt = 0;
    let auditAttempt = 0;
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: args.contentVersionId,
          finalContentVersionId: args.contentVersionId,
          plannedCount: 4,
          imported: [{}, {}, {}, {}],
        };
      }
      if (name === "geo_variant_preview") {
        return { variantId: draftAttempt === 0 ? ids.variantA : alternateVariant };
      }
      if (name === "geo_audit_request") {
        auditAttempt += 1;
        return auditAttempt === 1
          ? {
              auditRunId: ids.auditA,
              auditArtifactId: ids.artifactA,
              status: "failed",
              findings: [{ ruleId: "duplicate.near" }],
            }
          : {
              auditRunId: alternateAudit,
              auditArtifactId: alternateArtifact,
              status: "passed",
              findings: [],
            };
      }
      if (name === "geo_publication_request") return { publicationRequestId: alternateJob };
      return {};
    });
    const author = {
      author: vi.fn(async () => {
        draftAttempt = 0;
        return {
          ...draftTrace,
          contentItemId: ids.contentItem,
          contentVersionId: ids.contentVersion,
        };
      }),
      authorAlternate: vi.fn(async () => {
        draftAttempt = 1;
        return {
          ...draftTrace,
          providerRunId: alternateRun,
          contentItemId: ids.contentItem,
          contentVersionId: alternateContentVersion,
        };
      }),
    };
    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
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

    expect(author.authorAlternate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `automation:${ids.run}:target:${ids.targetA}:remediation:1:draft:v1`,
        remediation: expect.objectContaining({
          attempt: 1,
          maxAttempts: 2,
          reasonCodes: ["duplicate.near"],
          actions: ["change_diversity_blueprint", "rebuild_article"],
        }),
      }),
      undefined,
    );
    expect(invoke.mock.calls.filter(([name]) => name === "geo_audit_request")).toHaveLength(2);
    expect(invoke.mock.calls.filter(([name]) => name === "geo_publication_request")).toHaveLength(
      1,
    );
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        variantId: alternateVariant,
        idempotencyKey: `automation:${ids.run}:target:${ids.targetA}:publication:remediation-1`,
      }),
    );
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "media", contentVersionId: alternateContentVersion }),
        expect.objectContaining({
          stage: "target",
          targetId: ids.targetA,
          state: "variant_ready",
          remediation: expect.objectContaining({
            taskId: `${ids.run}:${ids.targetA}:remediation:1`,
          }),
        }),
      ]),
    );
    expect(
      checkpoints.filter(
        (checkpoint) => checkpoint.stage === "target" && checkpoint.state === "variant_ready",
      ),
    ).toEqual([
      expect.objectContaining({
        targetId: ids.targetA,
        variantId: alternateVariant,
        draftTrace: expect.objectContaining({ providerRunId: alternateRun }),
        remediation: expect.objectContaining({
          taskId: `${ids.run}:${ids.targetA}:remediation:1`,
        }),
      }),
    ]);
    expect(result.targets[0]).toEqual(
      expect.objectContaining({ state: "awaiting_delivery", variantId: alternateVariant }),
    );
  });

  it("uses the two-version remediation budget before publishing a target", async () => {
    const alternateVersions = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ];
    const alternateVariants = [
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
    ];
    const alternateRun = "00000000-0000-4000-8000-00000000001b";
    let alternateAttempt = 0;
    let auditAttempt = 0;
    const remediationAttempts: number[] = [];
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") {
        return {
          variantId:
            args.contentVersionId === alternateVersions[0]
              ? alternateVariants[0]
              : args.contentVersionId === alternateVersions[1]
                ? alternateVariants[1]
                : ids.variantA,
        };
      }
      if (name === "geo_audit_request") {
        auditAttempt += 1;
        return auditAttempt < 3
          ? {
              auditRunId: auditAttempt === 1 ? ids.auditA : ids.auditB,
              auditArtifactId: auditAttempt === 1 ? ids.artifactA : ids.artifactB,
              status: "failed",
              findings: [{ ruleId: "duplicate.near" }],
            }
          : {
              auditRunId: "00000000-0000-4000-8000-000000000025",
              auditArtifactId: "00000000-0000-4000-8000-000000000026",
              status: "passed",
              findings: [],
            };
      }
      if (name === "geo_publication_request") {
        return { publicationRequestId: "00000000-0000-4000-8000-000000000027" };
      }
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn(
        async (input: Parameters<NonNullable<AutomationDraftAuthor["authorAlternate"]>>[0]) => {
          const contentVersionId = alternateVersions[alternateAttempt];
          alternateAttempt += 1;
          if (contentVersionId === undefined) throw new Error("unexpected alternate draft attempt");
          remediationAttempts.push(input.remediation.attempt);
          return {
            ...draftTrace,
            providerRunId: alternateRun,
            contentItemId: ids.contentItem,
            contentVersionId,
          };
        },
      ),
    };

    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南家庭旅行选择清单",
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" }],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(author.authorAlternate).toHaveBeenCalledTimes(2);
    expect(remediationAttempts).toEqual([1, 2]);
    expect(invoke).toHaveBeenCalledWith(
      "geo_publication_request",
      expect.objectContaining({
        variantId: alternateVariants[1],
        idempotencyKey: `automation:${ids.run}:target:${ids.targetA}:publication:remediation-2`,
      }),
    );
    expect(result.targets[0]).toEqual(
      expect.objectContaining({ state: "awaiting_delivery", variantId: alternateVariants[1] }),
    );
    expect(
      checkpoints.filter(
        (checkpoint) => checkpoint.stage === "target" && checkpoint.state === "variant_ready",
      ),
    ).toEqual([
      expect.objectContaining({
        targetId: ids.targetA,
        variantId: alternateVariants[1],
        draftTrace: expect.objectContaining({ providerRunId: alternateRun }),
        remediation: expect.objectContaining({
          taskId: `${ids.run}:${ids.targetA}:remediation:2`,
        }),
      }),
    ]);
  });

  it("does not replace an immutable variant when a resumed variant_ready audit fails", async () => {
    const invoke = vi.fn(async (name: string) => {
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
          findings: [{ ruleId: "duplicate.near" }],
        };
      }
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: "00000000-0000-4000-8000-000000000028",
      })),
    };
    const checkpoints: ScheduledAutomationCheckpoint[] = [];

    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南家庭旅行选择清单",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          {
            targetId: ids.targetA,
            channelAccountId: ids.accountA,
            platform: "ctrip_community",
            state: "variant_ready",
            variantId: ids.variantA,
            auditRunId: ids.auditB,
            auditArtifactId: ids.artifactB,
          },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(author.authorAlternate).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([name]) => name === "geo_variant_preview")).toHaveLength(0);
    expect(invoke.mock.calls.filter(([name]) => name === "geo_publication_request")).toHaveLength(
      0,
    );
    expect(
      checkpoints.filter(
        (checkpoint) => checkpoint.stage === "target" && checkpoint.state === "variant_ready",
      ),
    ).toHaveLength(0);
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        state: "awaiting_manual_review",
        variantId: ids.variantA,
        auditRunId: ids.auditA,
        auditArtifactId: ids.artifactA,
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
      }),
    );
  });

  it("routes a failed visual inspection to manual review without rewriting content", async () => {
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
          findings: [{ ruleId: "media.inspection.failed" }],
        };
      }
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: "00000000-0000-4000-8000-000000000028",
      })),
    };

    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南家庭旅行选择清单",
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" }],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(author.authorAlternate).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([name]) => name === "geo_publication_request")).toHaveLength(
      0,
    );
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        state: "awaiting_manual_review",
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
        auditRunId: ids.auditA,
        auditArtifactId: ids.artifactA,
      }),
    );
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        stage: "target",
        targetId: ids.targetA,
        state: "awaiting_manual_review",
        auditRunId: ids.auditA,
        auditArtifactId: ids.artifactA,
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
        errorMessage: "审核未通过：media.inspection.failed",
      }),
    );
  });

  it("routes exhausted corrective attempts to manual remediation", async () => {
    const alternateVersions = [
      "00000000-0000-4000-8000-000000000030",
      "00000000-0000-4000-8000-000000000031",
    ] as const;
    const previewVariants = [
      ids.variantA,
      "00000000-0000-4000-8000-000000000032",
      "00000000-0000-4000-8000-000000000033",
    ] as const;
    let previewAttempt = 0;
    let alternateAttempt = 0;
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") {
        const variantId = previewVariants[previewAttempt];
        previewAttempt += 1;
        if (variantId === undefined) throw new Error("unexpected preview attempt");
        return { variantId };
      }
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "failed",
          findings: [{ ruleId: "duplicate.near" }],
        };
      }
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn(async () => {
        const contentVersionId = alternateVersions[alternateAttempt];
        alternateAttempt += 1;
        if (contentVersionId === undefined) throw new Error("unexpected alternate draft attempt");
        return { ...draftTrace, contentItemId: ids.contentItem, contentVersionId };
      }),
    };

    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南家庭旅行选择清单",
        targets: [{ targetId: ids.targetA, channelAccountId: ids.accountA, platform: "toutiao" }],
      },
      async () => undefined,
    );

    expect(author.authorAlternate).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.filter(([name]) => name === "geo_publication_request")).toHaveLength(
      0,
    );
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        state: "awaiting_manual_review",
        errorCode: "AUTOMATION_MANUAL_REMEDIATION_REQUIRED",
        remediation: expect.objectContaining({
          mode: "manual",
          attempt: 3,
          maxAttempts: 2,
        }),
      }),
    );
  });

  it("checkpoints every imported image and resumes from the next intent", async () => {
    const mediaVersions = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
    ] as const;
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
      expect.objectContaining({
        mediaCount: 1,
        mediaComplete: false,
        contentVersionId: mediaVersions[0],
      }),
      expect.objectContaining({
        mediaCount: 2,
        mediaComplete: false,
        contentVersionId: mediaVersions[1],
      }),
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
        contentVersionId: mediaVersions[1],
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

    expect(
      resumedInvoke.mock.calls.filter(([name]) => name === "geo_media_search_import"),
    ).toHaveLength(2);
    expect(
      resumedInvoke.mock.calls.find(([name]) => name === "geo_media_search_import")?.[1],
    ).toMatchObject({
      contentVersionId: mediaVersions[1],
      maxImports: 1,
    });
    expect(resumedCheckpoints).toContainEqual(
      expect.objectContaining({ stage: "media", mediaCount: 4, mediaComplete: true }),
    );
    expect(result.contentVersionId).toBe(mediaVersions[3]);
  });

  it("retries transient media transport failures inside one run attempt", async () => {
    const mediaVersions = [
      "00000000-0000-4000-8000-000000000031",
      "00000000-0000-4000-8000-000000000032",
      "00000000-0000-4000-8000-000000000033",
      "00000000-0000-4000-8000-000000000034",
    ] as const;
    let mediaCalls = 0;
    let importedCount = 0;
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        mediaCalls += 1;
        if (mediaCalls <= 2) {
          throw Object.assign(new Error("temporary media route outage"), {
            code: "GEO_API_TRANSPORT_FAILED",
            status: 503,
          });
        }
        const initialMediaCount = importedCount;
        const finalContentVersionId = mediaVersions[importedCount];
        importedCount += 1;
        return {
          provider: "wikimedia_commons",
          sourceContentVersionId: args.contentVersionId,
          finalContentVersionId,
          plannedCount: 4,
          initialMediaCount,
          totalMediaCount: importedCount,
          complete: importedCount === 4,
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
    const wait = vi.fn(async () => undefined);
    const checkpoints: ScheduledAutomationCheckpoint[] = [];
    const runtime = new ScheduledAutomationRuntime({ invoke }, undefined, { wait });

    await expect(
      runtime.run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          executionLevel: "dry_run",
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
          checkpoints.push(checkpoint);
        },
      ),
    ).resolves.toMatchObject({ contentVersionId: mediaVersions[3] });
    expect(mediaCalls).toBe(6);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(checkpoints.filter((checkpoint) => checkpoint.stage === "media")).toHaveLength(4);
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
    await expect(
      new ScheduledAutomationRuntime({ invoke }).run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          executionLevel: "unattended",
          topic: "京都亲子行前核验清单",
          targets: [
            { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "ctrip_community" },
          ],
        },
        async () => undefined,
      ),
    ).rejects.toThrow("MEDIA_SEARCH_COUNT_INVALID");
    expect(invoke.mock.calls.some(([name]) => name === "geo_variant_preview")).toBe(false);
  });

  it("rebuilds the article when licensed media search fails and then publishes the alternate", async () => {
    const alternateContentItem = "00000000-0000-4000-8000-000000000030";
    const alternateVersion = "00000000-0000-4000-8000-000000000040";
    let mediaSearchCalls = 0;
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_media_search_import") {
        mediaSearchCalls += 1;
        if (mediaSearchCalls === 1) {
          throw Object.assign(new Error("licensed search provider failed"), {
            code: "MEDIA_SEARCH_PROVIDER_FAILED",
          });
        }
        return completedMedia(args);
      }
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "passed" };
      }
      if (name === "geo_publication_request") return { publicationRequestId: ids.jobA };
      return {};
    });
    const author = {
      author: vi.fn(async () => ({
        ...draftTrace,
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
      })),
      authorAlternate: vi.fn<
        (
          input: Parameters<NonNullable<AutomationDraftAuthor["authorAlternate"]>>[0],
        ) => Promise<{ contentItemId: string; contentVersionId: string } & AutomationDraftTrace>
      >(async () => ({
        ...draftTrace,
        contentItemId: alternateContentItem,
        contentVersionId: alternateVersion,
      })),
    };
    const checkpoints: ScheduledAutomationCheckpoint[] = [];

    const result = await new ScheduledAutomationRuntime({ invoke }, author).run(
      {
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        runId: ids.run,
        executionLevel: "unattended",
        topic: "云南家庭旅行选择清单",
        contentItemId: ids.contentItem,
        contentVersionId: ids.contentVersion,
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "ctrip_community" },
        ],
      },
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(author.authorAlternate).toHaveBeenCalledTimes(1);
    expect(author.authorAlternate.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: `automation:${ids.run}:target:${ids.targetA}:media-remediation:1:draft:v1`,
      remediation: {
        taskId: `${ids.run}:${ids.targetA}:media:1`,
        mode: "automatic",
        attempt: 1,
        maxAttempts: 2,
        reasonCodes: ["media.search_failed", "MEDIA_SEARCH_PROVIDER_FAILED"],
        actions: ["replace_media", "rebuild_article"],
      },
    });
    const mediaSearchCallsAfterRemediation = invoke.mock.calls.filter(
      ([name]) => name === "geo_media_search_import",
    );
    expect(mediaSearchCallsAfterRemediation).toHaveLength(2);
    expect(mediaSearchCallsAfterRemediation[1]?.[1]).toMatchObject({
      contentVersionId: alternateVersion,
      idempotencyKey: `automation:${ids.run}:media-search:v1`,
    });
    expect(checkpoints.filter((checkpoint) => checkpoint.stage === "media")).toEqual([
      expect.objectContaining({
        contentItemId: alternateContentItem,
        contentVersionId: alternateVersion,
      }),
    ]);
    expect(result.contentItemId).toBe(alternateContentItem);
    expect(result.contentVersionId).toBe(alternateVersion);
    expect(result.targets[0]).toEqual(
      expect.objectContaining({
        state: "awaiting_delivery",
        publicationJobId: ids.jobA,
      }),
    );
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
        targets: [
          { targetId: ids.targetA, channelAccountId: ids.accountA, platform: "ctrip_community" },
        ],
      },
      async () => undefined,
    );
    expect(invoke.mock.calls.some(([name]) => name === "geo_media_search_import")).toBe(false);
  });

  it("bounds fact lookup while preserving the full brief for draft generation", async () => {
    const invoke = vi.fn(async (name: string, _args: Readonly<Record<string, unknown>>) => {
      void _args;
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") return completedMedia(_args);
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return { auditRunId: ids.auditA, auditArtifactId: ids.artifactA, status: "failed" };
      }
      return {};
    });
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
      ...draftTrace,
      contentItemId: ids.contentItem,
      contentVersionId: ids.contentVersion,
    }));
    const runtime = new ScheduledAutomationRuntime({ invoke }, { author });
    const brief = "完整携程自动化 brief，必须原样交给 Pi。";
    const checkpoints: ScheduledAutomationCheckpoint[] = [];

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
      async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    );

    expect(author).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: ids.tenant,
        brandId: ids.brand,
        campaignId: ids.campaign,
        targetPlatform: "ctrip_community",
        brief,
        idempotencyKey: `automation:${ids.run}:platform:ctrip_community:draft:v1`,
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
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "draft", draftTrace }),
        expect.objectContaining({ stage: "media", draftTrace }),
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
    const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
      if (name === "geo_draft_proposal") {
        return { contentItemId: ids.contentItem, contentVersionId: ids.contentVersion };
      }
      if (name === "geo_media_search_import") return completedMedia(args);
      if (name === "geo_variant_preview") return { variantId: ids.variantA };
      if (name === "geo_audit_request") {
        return {
          auditRunId: ids.auditA,
          auditArtifactId: ids.artifactA,
          status: "passed",
        };
      }
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
          if (checkpoints === 3) throw new Error("checkpoint unavailable");
        },
      ),
    ).rejects.toThrow("checkpoint unavailable");
    expect(checkpoints).toBe(3);
    expect(invoke.mock.calls.some(([name]) => name === "geo_audit_request")).toBe(true);
    expect(invoke.mock.calls.some(([name]) => name === "geo_publication_request")).toBe(false);
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
          mediaSearchCompletedPlatforms: ["toutiao"],
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

  it.each([
    ["PUBLICATION_POLICY_DENIED", "sohu"],
    ["PUBLICATION_GOVERNANCE_DENIED", "netease"],
  ] as const)(
    "blocks only the %s platform target and continues unrelated publications",
    async (denialCode, deniedPlatform) => {
      const denied = Object.assign(new Error("account publication circuit is open"), {
        code: denialCode,
        status: 403,
        retryable: false,
      });
      const invoke = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
        if (name === "geo_variant_preview") {
          return {
            variantId: args.channelAccountId === ids.accountA ? ids.variantA : ids.variantB,
          };
        }
        if (name === "geo_audit_request") {
          return {
            auditRunId: ids.auditA,
            auditArtifactId: ids.artifactA,
            status: "passed",
          };
        }
        if (name === "geo_publication_request") {
          if (args.channelAccountId === ids.accountA) throw denied;
          return { publicationJobId: ids.jobA };
        }
        return {};
      });
      const checkpoints: ScheduledAutomationCheckpoint[] = [];
      const runtime = new ScheduledAutomationRuntime({ invoke });

      const result = await runtime.run(
        {
          tenantId: ids.tenant,
          brandId: ids.brand,
          campaignId: ids.campaign,
          runId: ids.run,
          executionLevel: "dry_run",
          topic: "verified travel service",
          contentItemId: ids.contentItem,
          contentVersionId: ids.contentVersion,
          mediaSearchCompletedPlatforms: [deniedPlatform, "toutiao"],
          targets: [
            {
              targetId: ids.targetA,
              channelAccountId: ids.accountA,
              platform: deniedPlatform,
            },
            {
              targetId: ids.targetB,
              channelAccountId: ids.accountB,
              platform: "toutiao",
            },
          ],
        },
        async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      );

      expect(result.targets).toEqual([
        expect.objectContaining({
          targetId: ids.targetA,
          state: "blocked",
          errorCode: denialCode,
        }),
        expect.objectContaining({
          targetId: ids.targetB,
          state: "awaiting_delivery",
          publicationJobId: ids.jobA,
        }),
      ]);
      expect(checkpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetId: ids.targetA,
            state: "blocked",
            errorCode: denialCode,
          }),
          expect.objectContaining({
            targetId: ids.targetB,
            state: "awaiting_delivery",
            publicationJobId: ids.jobA,
          }),
        ]),
      );
      expect(invoke.mock.calls.filter(([name]) => name === "geo_publication_request")).toHaveLength(
        2,
      );
      expect(invoke).toHaveBeenCalledWith(
        "geo_publication_request",
        expect.objectContaining({
          channelAccountId: ids.accountA,
          platform: deniedPlatform,
        }),
      );
      expect(invoke).toHaveBeenCalledWith(
        "geo_publication_request",
        expect.objectContaining({
          channelAccountId: ids.accountB,
          platform: "toutiao",
        }),
      );
    },
  );
});
