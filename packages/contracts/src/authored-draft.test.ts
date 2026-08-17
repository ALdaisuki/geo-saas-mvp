import { describe, expect, it } from "vitest";

import { publicationVariantPayloadSchema } from "./index.js";

const tenant = "10000000-0000-4000-8000-000000000001";
const fact = "10000000-0000-4000-8000-000000000002";

describe("authored canonical content", () => {
  it("accepts bounded authored blocks with supporting fact IDs", () => {
    const parsed = publicationVariantPayloadSchema.safeParse({
      editorialProfile: "guide",
      title: "第一次出境旅行，先核对这三项",
      summary: "基于已核验资料整理出发前的检查顺序。",
      bodyMarkdown: "先核对有效期，再确认行程材料。",
      titleBlocks: [{ type: "authored", text: "第一次出境旅行，先核对这三项", claimIds: [fact] }],
      summaryBlocks: [
        { type: "authored", text: "基于已核验资料整理出发前的检查顺序。", claimIds: [fact] },
      ],
      bodyBlocks: [{ type: "authored", text: "先核对有效期，再确认行程材料。", claimIds: [fact] }],
      claims: [
        {
          id: fact,
          text: "有效期和行程材料需在出发前确认。",
          evidenceSourceIds: [tenant],
          validUntil: null,
        },
      ],
      contactIds: [],
      media: [],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts authored blocks without supporting fact IDs", () => {
    const parsed = publicationVariantPayloadSchema.safeParse({
      title: "没有证据的标题",
      summary: "没有证据的摘要",
      bodyMarkdown: "没有证据的正文",
      titleBlocks: [{ type: "authored", text: "没有证据的标题", claimIds: [] }],
      summaryBlocks: [{ type: "authored", text: "没有证据的摘要", claimIds: [] }],
      bodyBlocks: [{ type: "authored", text: "没有证据的正文", claimIds: [] }],
      claims: [],
      contactIds: [],
      media: [],
    });

    expect(parsed.success).toBe(true);
  });
});
