import { describe, expect, it } from "vitest";

import {
  auditArtifactSchema,
  automationBatchCreateRequestSchema,
  automationServicePrincipalCreateRequestSchema,
  automationRunStateSchema,
  automationRunTargetStateSchema,
  brandAgentProfileDocumentSchema,
  brandAgentProfileReferenceSchema,
  brandAgentProfileSchema,
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
  mediaReferenceSchema,
  policyTransitionRequestSchema,
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
  servicePrincipalStatusRequestSchema,
  visibilityObservationSchema,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

const visualBrief = {
  schemaVersion: "geo.visual-brief.v1",
  editorialProfile: "guide",
  platform: "toutiao",
  role: "cover",
  aspectRatio: "16:9",
  factIds: [id],
  prompt: "仅依据已核验服务事实生成写实封面。",
  negativePrompt: "文字、水印、二维码、电话号码、微信号、价格、证件、夸张承诺、虚构人物背书",
  altText: "已核验服务信息封面",
  caption: "画面仅表达已核验服务信息。",
} as const;

function mediaReference(provenance: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    sha256: hash,
    mimeType: "image/png",
    byteLength: 128,
    width: 1600,
    height: 900,
    platform: "toutiao",
    role: "cover",
    altText: visualBrief.altText,
    caption: visualBrief.caption,
    factIds: [...visualBrief.factIds],
    visualBrief,
    visualBriefHash: "ebbb54c1ad740f7442e5eec7465fb4cda7ce7ce7d0f6734a250eaf7332fac351",
    rights: {
      basis: "generated_terms",
      licenseName: "Fixture image generation terms",
      licenseUrl: "https://example.com/terms",
      verifiedAt: "2026-07-15T12:00:00.000Z",
    },
    provenance,
    inspection: {
      assetSha256: hash,
      status: "passed",
      evaluator: "fixture-inspector",
      evaluatorMode: "fixture",
      evaluatorVersion: "1.0.0",
      responseSha256: "c".repeat(64),
      inspectedAt: "2026-07-15T12:01:00.000Z",
      ocrText: "",
      labels: ["travel", "office"],
    },
  };
}

describe("publication contracts", () => {
  it("requires explicit brand and media snapshot hashes on audit artifacts", () => {
    const artifact = {
      id,
      tenantId: id,
      variantId: id,
      channelAccountId: id,
      platform: "toutiao",
      payloadHash: hash,
      factSnapshotHash: hash,
      brandSnapshotHash: hash,
      mediaSnapshotHash: hash,
      policyHash: hash,
      policyVersion: "audit-v2",
      auditHash: hash,
      status: "passed",
      findings: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      expiresAt: "2026-07-15T12:15:00.000Z",
    } as const;

    expect(auditArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(
      auditArtifactSchema.safeParse({ ...artifact, mediaSnapshotHash: undefined }).success,
    ).toBe(false);
    expect(
      auditArtifactSchema.safeParse({ ...artifact, brandSnapshotHash: undefined }).success,
    ).toBe(false);
  });

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
      articleTemplateId: "step-by-step-guide",
      brandAgentProfile: { id, version: 3, documentHash: hash },
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
    expect(payload.articleTemplateId).toBe("step-by-step-guide");
    expect(payload.brandAgentProfile).toEqual({ id, version: 3, documentHash: hash });
    expect(payload.titleBlocks).toEqual([
      { type: "template", templateId: "generic.title.current-service" },
    ]);
  });

  it("keeps brand agent instructions structured, bounded, and separately attributable", () => {
    const document = brandAgentProfileDocumentSchema.parse({
      schemaVersion: "geo.brand-agent-profile.v1",
      voice: "克制、清晰、先回答再解释",
      audiences: ["首次出境游客", "银发游客家庭"],
      objectives: ["帮助客户核验服务边界"],
      requiredPoints: ["说明信息有效期"],
      forbiddenClaims: ["保证签证通过"],
      callToAction: "建议客户通过官方热线核验当前行程。",
      agentInstructions: "优先选择可被事实和证据完整支持的文章策略。",
    });
    const reference = brandAgentProfileReferenceSchema.parse({
      id,
      version: 3,
      documentHash: hash,
    });

    expect(document.schemaVersion).toBe("geo.brand-agent-profile.v1");
    expect(reference.version).toBe(3);
    expect(
      brandAgentProfileSchema.parse({
        ...reference,
        brandId: id,
        status: "active",
        document,
        effectiveAt: "2026-07-15T12:00:00.000Z",
        retiredAt: null,
        createdAt: "2026-07-15T12:00:00.000Z",
      }).brandId,
    ).toBe(id);
    expect(
      brandAgentProfileDocumentSchema.safeParse({
        ...document,
        audiences: ["银发游客", "银发游客"],
      }).success,
    ).toBe(false);
    expect(
      brandAgentProfileReferenceSchema.safeParse({ ...reference, documentHash: "not-a-hash" })
        .success,
    ).toBe(false);
  });

  it("rejects article template identifiers that cannot be safely attributed", () => {
    const result = publicationVariantPayloadSchema.safeParse({
      editorialProfile: "guide",
      articleTemplateId: "../../../other-tenant",
      title: "Title",
      summary: "Summary",
      bodyMarkdown: "Body",
    });

    expect(result.success).toBe(false);
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

describe("strict media contracts", () => {
  const generated = {
    kind: "generated",
    jobId: id,
    attemptId: "00000000-0000-4000-8000-000000000002",
    provider: "fixture-image-provider",
    providerMode: "fixture",
    model: "fixture-v1",
    promptHash: "85393464534779ec721ef24661c50fac75629b3b12fda445b54ddbafcb847091",
    parametersHash: "d".repeat(64),
    generatedAt: "2026-07-15T12:00:30.000Z",
  } as const;

  it("accepts generated, licensed-stock, and tenant-owned provenance", () => {
    expect(mediaReferenceSchema.parse(mediaReference(generated)).provenance.kind).toBe("generated");

    const licensed = mediaReferenceSchema.parse({
      ...mediaReference({
        kind: "licensed_stock",
        evidenceSourceId: id,
        sourceUrl: "https://stock.example.com/assets/42",
      }),
      rights: {
        basis: "commercial_license",
        licenseName: "Commercial stock license",
        licenseUrl: "https://stock.example.com/license",
        attribution: "Example Stock",
        verifiedAt: "2026-07-15T12:00:00.000Z",
      },
    });
    expect(licensed.provenance.kind).toBe("licensed_stock");

    const tenantOwned = mediaReferenceSchema.parse({
      ...mediaReference({
        kind: "tenant_owned",
        evidenceSourceId: id,
        ownershipAssertion: "The tenant created and owns this photograph.",
      }),
      rights: {
        basis: "tenant_owned",
        licenseName: "Tenant ownership assertion",
        verifiedAt: "2026-07-15T12:00:00.000Z",
      },
    });
    expect(tenantOwned.provenance.kind).toBe("tenant_owned");
  });

  it("preserves legacy empty media arrays", () => {
    expect(
      publicationVariantPayloadSchema.parse({
        title: "Legacy title",
        summary: "Legacy summary",
        bodyMarkdown: "Legacy body",
        media: [],
      }).media,
    ).toEqual([]);
  });

  it("rejects unknown keys and duplicate ordered fact IDs", () => {
    expect(
      mediaReferenceSchema.safeParse({ ...mediaReference(generated), unknown: true }).success,
    ).toBe(false);
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference(generated),
        rights: {
          ...(mediaReference(generated).rights as Record<string, unknown>),
          unknown: true,
        },
      }).success,
    ).toBe(false);
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference(generated),
        factIds: [id, id],
        visualBrief: { ...visualBrief, factIds: [id, id] },
      }).success,
    ).toBe(false);
  });

  it("rejects non-HTTPS rights and stock source URLs", () => {
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference(generated),
        rights: {
          ...(mediaReference(generated).rights as Record<string, unknown>),
          licenseUrl: "http://example.com/terms",
        },
      }).success,
    ).toBe(false);
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference({
          kind: "licensed_stock",
          evidenceSourceId: id,
          sourceUrl: "http://stock.example.com/assets/42",
        }),
        rights: {
          basis: "editorial_license",
          licenseName: "Editorial stock license",
          verifiedAt: "2026-07-15T12:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["byteLength", 0],
    ["width", 0],
    ["height", -1],
  ])("rejects non-positive %s", (field, value) => {
    expect(
      mediaReferenceSchema.safeParse({ ...mediaReference(generated), [field]: value }).success,
    ).toBe(false);
  });

  it("rejects visual brief, prompt provenance, and inspection asset hash mismatches", () => {
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference(generated),
        visualBriefHash: hash,
      }).success,
    ).toBe(false);
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference({ ...generated, promptHash: hash }),
      }).success,
    ).toBe(false);
    expect(
      mediaReferenceSchema.safeParse({
        ...mediaReference(generated),
        inspection: {
          ...(mediaReference(generated).inspection as Record<string, unknown>),
          assetSha256: "e".repeat(64),
        },
      }).success,
    ).toBe(false);
  });

  it("allows repeated platform-role bindings but rejects duplicate media IDs in either order", () => {
    const first = mediaReferenceSchema.parse(mediaReference(generated));
    const duplicateBinding = {
      ...first,
      id: "00000000-0000-4000-8000-000000000003",
      sha256: "f".repeat(64),
      inspection: { ...first.inspection, assetSha256: "f".repeat(64) },
    };
    const duplicateId = {
      ...first,
      role: "inline" as const,
      visualBrief: { ...first.visualBrief, role: "inline" as const },
      visualBriefHash: "fb77eb3426199a157a7b3564f3eaf55a536721322a0947341fc87cec23e7d40a",
    };
    const payload = (media: unknown[]) => ({
      title: "Media title",
      summary: "Media summary",
      bodyMarkdown: "Media body",
      media,
    });

    for (const values of [
      [first, duplicateBinding],
      [duplicateBinding, first],
    ]) {
      expect(publicationVariantPayloadSchema.safeParse(payload(values)).success).toBe(true);
    }
    for (const values of [
      [first, duplicateId],
      [duplicateId, first],
    ]) {
      expect(publicationVariantPayloadSchema.safeParse(payload(values)).success).toBe(false);
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
