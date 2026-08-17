import { describe, expect, it } from "vitest";

import { editorialProfileForBrief } from "./editorial-profile.js";

describe("editorial profile classification", () => {
  const cases = [
    ["日本签证材料办理指南", "guide"],
    ["签证材料怎么准备？", "question_answer"],
    ["跟团游与自由行对比", "comparison"],
    ["低价团避坑与风险提醒", "risk_avoidance"],
    ["上海旅行社电话微信咨询", "local_service"],
  ] as const;

  it.each(cases)("classifies %s as %s", (brief, expected) => {
    expect(editorialProfileForBrief(brief)).toBe(expected);
  });

  it("prioritizes risk over contact and question rules", () => {
    expect(editorialProfileForBrief("投诉风险如何联系热线")).toBe("risk_avoidance");
  });
});
