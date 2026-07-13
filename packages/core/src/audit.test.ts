import { describe, expect, it } from "vitest";

import type { Platform, PublicationVariantPayload, TenantContact } from "@geo/contracts";

import {
  auditPublicationVariant,
  type AuditPolicy,
  type FactSnapshot,
  type PriorPublicationVariant,
} from "./audit.js";
import { sha256Canonical } from "./canonical.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const variantId = "00000000-0000-4000-8000-000000000002";
const channelAccountId = "00000000-0000-4000-8000-000000000003";
const artifactId = "00000000-0000-4000-8000-000000000004";
const phoneId = "00000000-0000-4000-8000-000000000005";
const wechatOneId = "00000000-0000-4000-8000-000000000006";
const wechatTwoId = "00000000-0000-4000-8000-000000000007";
const sourceId = "00000000-0000-4000-8000-000000000008";

const createdAt = "2026-07-13T12:00:00.000Z";

const contacts: readonly TenantContact[] = [
  {
    id: phoneId,
    tenantId,
    type: "phone",
    label: "24-hour hotline",
    value: "4001133986",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatOneId,
    tenantId,
    type: "wechat",
    label: "WeChat 1",
    value: "ZTGL3411",
    isPrimary: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
  {
    id: wechatTwoId,
    tenantId,
    type: "wechat",
    label: "WeChat 2",
    value: "ZTGL6431",
    isPrimary: false,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
  },
];

const factSnapshot: FactSnapshot = {
  tenantId,
  capturedAt: "2026-07-12T12:00:00.000Z",
  sources: [
    {
      id: sourceId,
      locator: "https://example.test/evidence/itinerary",
      observedAt: "2026-07-12T10:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const limits = {
  maxTitleCharacters: 40,
  maxSummaryCharacters: 120,
  minBodyCharacters: 120,
  maxBodyCharacters: 5_000,
  maxTags: 5,
  minHeadings: 2,
};

const policy: AuditPolicy = {
  version: "mvp-test-v1",
  artifactTtlMs: 15 * 60 * 1_000,
  maxEvidenceAgeMs: 30 * 24 * 60 * 60 * 1_000,
  minClaims: 1,
  duplicateThreshold: 0.82,
  minDuplicateCharacters: 60,
  prohibitedGuarantees: ["百分百", "保证签证", "包过"],
  platformLimits: {
    toutiao: limits,
    sohu: limits,
    ctrip_community: limits,
  },
};

function payload(overrides: Partial<PublicationVariantPayload> = {}): PublicationVariantPayload {
  return {
    title: "日本跟团游怎么选：先核验证据和服务边界",
    summary: "用行程证据、费用边界和适配人群来比较方案，并提供可核验的咨询方式。",
    bodyMarkdown: [
      "## 先看可核验的行程信息",
      "出发日期、交通安排和住宿标准应以签约前提供的最终行程单为准。本文把来源和有效期一起记录，方便读者复核，不用模糊宣传替代事实。",
      "## 再判断服务是否适合",
      "老人或第一次出境的游客，应重点确认步行强度、自由活动时长和退改条件。24小时热线：4001133986。微信咨询：ZTGL3411 或 ZTGL6431。",
    ].join("\n\n"),
    media: [],
    claims: [
      {
        id: "00000000-0000-4000-8000-000000000009",
        text: "行程安排以签约前的最终行程单为准",
        evidenceSourceIds: [sourceId],
        validUntil: "2026-08-01T00:00:00.000Z",
      },
    ],
    contactIds: [phoneId, wechatOneId, wechatTwoId],
    tags: ["日本旅游", "跟团游"],
    ...overrides,
  };
}

function run(
  payloadOverride: PublicationVariantPayload = payload(),
  overrides: {
    contacts?: readonly TenantContact[];
    factSnapshot?: FactSnapshot;
    platform?: Platform;
    priorVariants?: readonly PriorPublicationVariant[];
  } = {},
) {
  return auditPublicationVariant({
    artifactId,
    tenantId,
    variantId,
    channelAccountId,
    platform: overrides.platform ?? "toutiao",
    payload: payloadOverride,
    contacts: overrides.contacts ?? contacts,
    factSnapshot: overrides.factSnapshot ?? factSnapshot,
    policy,
    priorVariants: overrides.priorVariants ?? [],
    createdAt,
  });
}

function ruleIds(artifact: ReturnType<typeof run>): string[] {
  return artifact.findings.map((finding) => finding.ruleId);
}

describe("publication variant audit", () => {
  it("builds a passed, deeply frozen artifact bound to all deterministic inputs", () => {
    const artifact = run();

    expect(artifact.status).toBe("passed");
    expect(artifact.findings).toEqual([]);
    expect(artifact.payloadHash).toBe(sha256Canonical(payload()));
    expect(artifact.factSnapshotHash).toBe(sha256Canonical(factSnapshot));
    expect(artifact.policyHash).toBe(sha256Canonical(policy));
    expect(artifact.expiresAt).toBe("2026-07-13T12:15:00.000Z");
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.findings)).toBe(true);
  });

  it("blocks unapproved contact values and missing referenced contacts", () => {
    const wrong = payload({
      bodyMarkdown: payload()
        .bodyMarkdown.replace("4001133986", "4001133987")
        .replace("ZTGL3411", "ZTGL9999"),
    });
    const artifact = run(wrong);

    expect(artifact.status).toBe("failed");
    expect(ruleIds(artifact)).toEqual(
      expect.arrayContaining([
        "contact.phone.unapproved",
        "contact.wechat.unapproved",
        "contact.reference.missing",
      ]),
    );
  });

  it("detects an unapproved hotline even when the number has no contact label", () => {
    const wrong = payload({
      bodyMarkdown: payload().bodyMarkdown.replace("24小时热线：4001133986", "4001133987"),
    });
    const artifact = run(wrong);

    expect(ruleIds(artifact)).toEqual(
      expect.arrayContaining(["contact.phone.unapproved", "contact.reference.missing"]),
    );
  });

  it("blocks missing, stale, expired, and unknown evidence", () => {
    const originalSource = factSnapshot.sources[0];
    if (originalSource === undefined) {
      throw new Error("test fixture must include an evidence source");
    }
    const staleSnapshot: FactSnapshot = {
      ...factSnapshot,
      sources: [
        {
          ...originalSource,
          observedAt: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-07-13T11:59:59.000Z",
        },
      ],
    };
    const audited = run(
      payload({
        claims: [
          {
            id: "00000000-0000-4000-8000-000000000009",
            text: "A claim without enough support",
            evidenceSourceIds: [sourceId, "00000000-0000-4000-8000-000000000099"],
            validUntil: "2026-07-13T11:59:59.000Z",
          },
        ],
      }),
      { factSnapshot: staleSnapshot },
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining([
        "evidence.claim.expired",
        "evidence.source.expired",
        "evidence.source.stale",
        "evidence.source.unknown",
      ]),
    );
  });

  it("blocks prohibited guarantees and versioned platform-limit violations", () => {
    const audited = run(
      payload({
        title:
          "这是一个明显超过四十个字符的平台标题用于验证最终变体会被发布前审计确定性地阻止并且绝不会漏掉",
        bodyMarkdown: `${payload().bodyMarkdown}\n\n我们保证签证包过。`,
      }),
    );

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["claims.prohibited_guarantee", "platform.title.too_long"]),
    );
  });

  it("blocks weak structure and near-duplicate bodies", () => {
    const current = payload({ bodyMarkdown: payload().bodyMarkdown.replace(/^## /gm, "") });
    const priorVariants: readonly PriorPublicationVariant[] = [
      {
        variantId: "00000000-0000-4000-8000-000000000088",
        platform: "sohu",
        payloadHash: sha256Canonical({ prior: true }),
        bodyMarkdown: `${current.bodyMarkdown}。`,
      },
    ];
    const audited = run(current, { priorVariants });

    expect(ruleIds(audited)).toEqual(
      expect.arrayContaining(["structure.headings.insufficient", "duplicate.near"]),
    );
  });

  it("changes the audit binding when the final platform payload changes", () => {
    const first = run();
    const changed = run(payload({ summary: `${payload().summary} 请以最新页面为准。` }));

    expect(first.payloadHash).not.toBe(changed.payloadHash);
    expect(first.auditHash).not.toBe(changed.auditHash);
  });
});
