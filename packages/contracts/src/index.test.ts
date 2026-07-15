import { describe, expect, it } from "vitest";

import {
  automationBatchCreateRequestSchema,
  automationServicePrincipalCreateRequestSchema,
  automationRunStateSchema,
  automationRunTargetStateSchema,
  canonicalBodyBlockSchema,
  canonicalInlineBlockSchema,
  channelAccountCreateRequestSchema,
  channelAccountUpdateRequestSchema,
  contactCreateRequestSchema,
  contactExpireRequestSchema,
  connectorCapabilityReportSchema,
  editorialProfileSchema,
  memberCreateRequestSchema,
  memberUpdateRequestSchema,
  policyTransitionRequestSchema,
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
  servicePrincipalStatusRequestSchema,
  visibilityObservationSchema,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

describe("publication contracts", () => {
  it("keeps dry-run evidence visibly separate from a confirmed live publication", () => {
    const receipt = publicationReceiptSchema.parse({
      id,
      tenantId: id,
      jobId: id,
      attemptId: id,
      platform: "toutiao",
      executionLevel: "dry_run",
      evidenceType: "preview",
      requestHash: hash,
      responseHash: hash,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      recordedAt: "2026-07-13T12:00:00.000Z",
      confirmed: false,
    });

    expect(receipt.confirmed).toBe(false);
    expect(receipt.externalUrl).toBeNull();
  });

  it("requires a reason and evidence type for connector capability reports", () => {
    expect(() =>
      connectorCapabilityReportSchema.parse({
        platform: "sohu",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run", "assisted"],
        checkedAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("keeps manual package export separate from connector execution levels", () => {
    const base = {
      platform: "sohu",
      capability: "manual_only",
      checkedAt: "2026-07-13T12:00:00.000Z",
      evidenceType: "preview",
      evidenceRefs: [],
      reason: "No verified external publishing API is configured.",
    } as const;

    expect(
      connectorCapabilityReportSchema.parse({
        ...base,
        supportedExecutionLevels: ["dry_run"],
      }).supportedExecutionLevels,
    ).toEqual(["dry_run"]);
    expect(() =>
      connectorCapabilityReportSchema.parse({
        ...base,
        supportedExecutionLevels: ["dry_run", "assisted"],
      }),
    ).toThrow(/dry_run only/iu);
  });

  it("rejects empty publication variants", () => {
    expect(() =>
      publicationVariantPayloadSchema.parse({
        title: "",
        summary: "",
        bodyMarkdown: "",
      }),
    ).toThrow();
  });

  it("parses canonical content references without accepting free text blocks", () => {
    const payload = publicationVariantPayloadSchema.parse({
      editorialProfile: "guide",
      title: "当前服务信息",
      summary: "以下内容来自当前有效的事实与联系方式。",
      bodyMarkdown: "## 当前可核验信息\n\n当前服务以已核验材料为准。",
      media: [],
      claims: [],
      contactIds: [],
      tags: ["服务核验"],
      titleBlocks: [{ type: "template", templateId: "generic.title.current-service" }],
      summaryBlocks: [{ type: "template", templateId: "generic.summary.verified" }],
      bodyBlocks: [
        { type: "template", templateId: "generic.body.heading.verified" },
        { type: "claim", claimId: id, presentation: "paragraph" },
        { type: "contact", contactId: id, presentation: "bullet" },
      ],
      tagTemplateIds: ["generic.tag.verified"],
    });

    expect(payload.bodyBlocks).toHaveLength(3);
    expect(payload.editorialProfile).toBe("guide");
    expect(payload.titleBlocks).toEqual([
      { type: "template", templateId: "generic.title.current-service" },
    ]);
  });

  it("models only the five governed editorial profiles", () => {
    expect(editorialProfileSchema.options).toEqual([
      "guide",
      "question_answer",
      "comparison",
      "risk_avoidance",
      "local_service",
    ]);
    expect(
      publicationVariantPayloadSchema.safeParse({
        editorialProfile: "model_freeform",
        title: "Title",
        summary: "Summary",
        bodyMarkdown: "Body",
      }).success,
    ).toBe(false);
  });

  it("keeps legacy publication payloads readable for migration", () => {
    const payload = publicationVariantPayloadSchema.parse({
      title: "Legacy title",
      summary: "Legacy summary",
      bodyMarkdown: "Legacy body",
    });

    expect(payload.titleBlocks).toBeUndefined();
    expect(payload.summaryBlocks).toBeUndefined();
    expect(payload.bodyBlocks).toBeUndefined();
    expect(payload.tagTemplateIds).toBeUndefined();
  });

  it("rejects arbitrary text, raw markdown, and unknown fields in canonical blocks", () => {
    const invalidBlocks: unknown[] = [
      { type: "template", templateId: "generic.body.safe", text: "1元无限库存" },
      { type: "claim", claimId: id, presentation: "paragraph", text: "1元无限库存" },
      { type: "contact", contactId: id, presentation: "paragraph", rawMarkdown: "任意正文" },
      { type: "text", text: "任意正文" },
    ];

    for (const block of invalidBlocks) {
      expect(canonicalBodyBlockSchema.safeParse(block).success).toBe(false);
      expect(canonicalInlineBlockSchema.safeParse(block).success).toBe(false);
    }
  });
});

describe("visibility evidence contracts", () => {
  it("requires ordered request/response timestamps and structured evaluator output", () => {
    const observation = visibilityObservationSchema.parse({
      id,
      tenantId: id,
      runId: id,
      provider: "doubao",
      productSurface: "doubao-web-search",
      model: "manual-observed-unknown",
      searchMode: "unknown",
      observationMethod: "manual",
      prompt: "中通国际旅行社联系方式是什么？",
      promptVersion: "1.0.0",
      locale: "zh-CN",
      geo: "CN",
      rawAnswer: "热线 4009999999。",
      citedUrls: [],
      evidenceHash: hash,
      evidenceType: "manual_import",
      requestStartedAt: "2026-07-13T11:59:59.000Z",
      responseReceivedAt: "2026-07-13T12:00:00.000Z",
      observedAt: "2026-07-13T12:00:00.000Z",
      brandMentioned: false,
      answerPosition: null,
      contactAccuracy: 0,
      competitorMentions: [],
      sentiment: "negative",
      hallucinationFindings: [
        {
          code: "unexpected_contact",
          category: "contact",
          severity: "high",
          statement: "回答包含未登记联系方式",
          observedValue: "4009999999",
          expectedValues: ["4001133986"],
        },
      ],
      harmfulError: true,
      evaluatorVersion: "geo-visibility-evaluator-v1",
    });

    expect(observation.hallucinationFindings[0]?.observedValue).toBe("4009999999");
    expect(
      visibilityObservationSchema.safeParse({
        ...observation,
        requestStartedAt: "2026-07-13T12:00:01.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("automation contracts", () => {
  it("accepts a bounded dry-run batch without a client-controlled execution level", () => {
    const batch = automationBatchCreateRequestSchema.parse({
      idempotencyKey: "campaign:summer:batch:1",
      name: "七月第一批",
      items: [
        {
          slotKey: "slot-001",
          scheduledFor: "2026-07-15T12:00:00.000Z",
          topicKey: "travel:senior-friendly",
          brief: "适合老年人的出境跟团游注意事项",
          channelAccountIds: [id],
        },
      ],
    });

    expect(batch.items).toHaveLength(1);
    expect(batch).not.toHaveProperty("executionLevel");
  });

  it("rejects oversized batches, duplicate targets, and client-selected execution levels", () => {
    const item = {
      slotKey: "slot-001",
      scheduledFor: "2026-07-15T12:00:00.000Z",
      topicKey: "travel:senior-friendly",
      brief: "适合老年人的出境跟团游注意事项",
      channelAccountIds: [id, id],
    };

    expect(
      automationBatchCreateRequestSchema.safeParse({
        idempotencyKey: "campaign:summer:batch:1",
        items: [item],
      }).success,
    ).toBe(false);
    expect(
      automationBatchCreateRequestSchema.safeParse({
        idempotencyKey: "campaign:summer:batch:1",
        items: [
          { ...item, channelAccountIds: [id] },
          { ...item, channelAccountIds: [id] },
        ],
      }).success,
    ).toBe(false);
    expect(
      automationBatchCreateRequestSchema.safeParse({
        idempotencyKey: "campaign:summer:batch:1",
        executionLevel: "unattended",
        items: [{ ...item, channelAccountIds: [id] }],
      }).success,
    ).toBe(false);
    expect(
      automationBatchCreateRequestSchema.safeParse({
        idempotencyKey: "campaign:summer:batch:1",
        items: Array.from({ length: 51 }, (_, index) => ({
          ...item,
          slotKey: `slot-${index}`,
          channelAccountIds: [id],
        })),
      }).success,
    ).toBe(false);
  });

  it("keeps run and target states explicit for durable recovery", () => {
    expect(automationRunStateSchema.parse("retry_wait")).toBe("retry_wait");
    expect(automationRunTargetStateSchema.parse("preview_completed")).toBe("preview_completed");
    expect(automationRunStateSchema.safeParse("processing").success).toBe(false);
  });
});

describe("tenant governance contracts", () => {
  it("accepts append-only contact creation and explicit expiry commands", () => {
    expect(
      contactCreateRequestSchema.parse({
        type: "wechat",
        label: "微信咨询",
        value: "ZTGL3411",
        isPrimary: true,
      }),
    ).toMatchObject({ type: "wechat", isPrimary: true });
    expect(
      contactExpireRequestSchema.parse({
        reason: "旧客服号停止使用",
        validUntil: "2026-07-15T12:00:00.000Z",
      }),
    ).toMatchObject({ reason: "旧客服号停止使用" });
    expect(contactExpireRequestSchema.safeParse({}).success).toBe(false);
  });

  it("requires controlled member creation and a reason for role or status changes", () => {
    expect(
      memberCreateRequestSchema.parse({
        email: "editor@example.com",
        displayName: "内容编辑",
        role: "editor",
        initialPassword: "replace-this-password-2026",
      }),
    ).toMatchObject({ role: "editor" });
    expect(
      memberUpdateRequestSchema.safeParse({ role: "publisher", reason: "调整发布职责" }).success,
    ).toBe(true);
    expect(memberUpdateRequestSchema.safeParse({ reason: "没有实际变更" }).success).toBe(false);
  });

  it("allows only explicit policy lifecycle transitions", () => {
    expect(
      policyTransitionRequestSchema.parse({ targetStatus: "active", reason: "审核通过" }),
    ).toEqual({ targetStatus: "active", reason: "审核通过" });
    expect(
      policyTransitionRequestSchema.safeParse({ targetStatus: "draft", reason: "回退" }).success,
    ).toBe(false);
  });

  it("keeps channel-account capability evidence explicit and rejects empty updates", () => {
    expect(
      channelAccountCreateRequestSchema.parse({
        platform: "toutiao",
        displayName: "中通头条号",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run"],
        evidenceType: "manual_import",
        evidenceRefs: ["ticket:GEO-42"],
        status: "needs_verification",
      }),
    ).toMatchObject({ platform: "toutiao", supportedExecutionLevels: ["dry_run"] });
    expect(
      channelAccountUpdateRequestSchema.safeParse({
        status: "active",
        lastVerifiedAt: "2026-07-15T12:00:00.000Z",
        reason: "人工核验完成",
      }).success,
    ).toBe(true);
    expect(channelAccountUpdateRequestSchema.safeParse({ reason: "没有实际变更" }).success).toBe(
      false,
    );
  });

  it("provisions automation principals without accepting client-selected capabilities", () => {
    expect(
      automationServicePrincipalCreateRequestSchema.parse({ name: "producer-zhongtong" }),
    ).toEqual({ name: "producer-zhongtong" });
    expect(
      automationServicePrincipalCreateRequestSchema.safeParse({
        name: "producer-zhongtong",
        capabilities: ["tenant:manage"],
      }).success,
    ).toBe(false);
    expect(
      servicePrincipalStatusRequestSchema.parse({
        status: "disabled",
        reason: "轮换自动化身份",
      }),
    ).toMatchObject({ status: "disabled" });
  });
});
