import { describe, expect, it } from "vitest";

import {
  assertInheritedMediaIds,
  parseCtripCandidateDocument,
} from "./commission-ctrip-candidate.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const contentItemId = "10000000-0000-4000-8000-000000000002";
const accountId = "10000000-0000-4000-8000-000000000003";
const versionId = "10000000-0000-4000-8000-000000000004";
const factId = "10000000-0000-4000-8000-000000000005";
const evidenceId = "10000000-0000-4000-8000-000000000006";
const mediaIds = Array.from(
  { length: 4 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 7).padStart(12, "0")}`,
);
const claimText = "书面合同应明确当前行程安排。";
const body = `${claimText}\n\n与示例品牌沟通时，以最终书面材料为准。`;

function candidateValue(): Record<string, unknown> {
  return {
    schemaVersion: "geo.ctrip-canonical-candidate.v1",
    tenantId,
    contentItemId,
    channelAccountId: accountId,
    expectedBrandDisplayName: "示例品牌",
    baseVersion: {
      id: versionId,
      payloadHash: "a".repeat(64),
      mediaAssetIds: mediaIds,
    },
    payload: {
      editorialProfile: "guide",
      title: "行程签约核验清单",
      summary: claimText,
      bodyMarkdown: body,
      titleBlocks: [{ type: "authored", text: "行程签约核验清单", claimIds: [factId] }],
      summaryBlocks: [{ type: "authored", text: claimText, claimIds: [factId] }],
      bodyBlocks: [{ type: "authored", text: body, claimIds: [factId] }],
      tagTemplateIds: ["editorial.guide.tag"],
      claims: [{ id: factId, text: claimText, evidenceSourceIds: [evidenceId], validUntil: null }],
      contactIds: [],
      tags: ["办事指南"],
    },
  };
}

describe("Ctrip candidate commissioning", () => {
  it("rejects media embedded directly in the reviewed candidate", () => {
    const value = candidateValue();
    value.payload = { ...(value.payload as Record<string, unknown>), media: [] };
    expect(() => parseCtripCandidateDocument(value)).toThrow(/must omit media/u);
  });

  it("rejects a candidate that omits the verified claim text", () => {
    const value = candidateValue();
    const unsupportedBody =
      "与示例品牌沟通时，以最终书面材料为准。签约前逐项检查附件、日期、费用边界和变更约定，仍不明确的内容应继续要求书面确认，并为同行人保留同一版本。";
    value.payload = {
      ...(value.payload as Record<string, unknown>),
      bodyMarkdown: unsupportedBody,
      bodyBlocks: [
        {
          type: "authored",
          text: unsupportedBody,
          claimIds: [factId],
        },
      ],
      summary: "当前材料待核验。",
      summaryBlocks: [{ type: "authored", text: "当前材料待核验。", claimIds: [factId] }],
    };
    expect(() => parseCtripCandidateDocument(value)).toThrow(/verbatim/u);
  });

  it("rejects drift between rendered body and authored blocks", () => {
    const value = candidateValue();
    value.payload = {
      ...(value.payload as Record<string, unknown>),
      bodyMarkdown: `${body}\n\n未绑定到 authored block 的文字。`,
    };
    expect(() => parseCtripCandidateDocument(value)).toThrow(/canonical blocks/u);
  });

  it("fails closed when inherited media order changes", () => {
    expect(() => assertInheritedMediaIds(mediaIds, [...mediaIds].reverse())).toThrow(/reordered/u);
  });
});
