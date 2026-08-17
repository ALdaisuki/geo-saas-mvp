import { describe, expect, it } from "vitest";

import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATE_CATEGORIES,
  ARTICLE_TEMPLATE_LIBRARY_NAME,
  ARTICLE_TEMPLATES,
  articleTemplatePlatforms,
  articleTemplateSupportsPlatforms,
  articleTemplatesForPlatforms,
} from "@geo/contracts";

describe("GEO article template catalog", () => {
  it("exposes the immutable V1 catalog version", () => {
    expect(ARTICLE_TEMPLATE_CATALOG_VERSION).toBe("geo.article-templates.v1");
  });

  it("ships one complete travel-agency library with the 100 original note templates", () => {
    expect(ARTICLE_TEMPLATE_LIBRARY_NAME).toBe("旅行社内容模板库");
    expect(ARTICLE_TEMPLATES).toHaveLength(121);
    expect(new Set(ARTICLE_TEMPLATES.map((template) => template.id)).size).toBe(
      ARTICLE_TEMPLATES.length,
    );
    const travelNoteTemplates = ARTICLE_TEMPLATES.filter((template) =>
      template.id.startsWith("travel-note-"),
    );
    expect(travelNoteTemplates).toHaveLength(100);
    expect(travelNoteTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "travel-note-photo-recap-01",
          name: "照片复盘笔记 · 带父母看慢节奏",
          outline: expect.arrayContaining([expect.stringContaining("变量槽位")]),
        }),
        expect.objectContaining({
          id: "travel-note-cost-contract-10",
          name: "费用与行程核对 · 价格变化的有效期",
        }),
      ]),
    );

    for (const template of ARTICLE_TEMPLATES) {
      expect(template.name).not.toHaveLength(0);
      expect(template.scenario).not.toHaveLength(0);
      expect(template.benefit).not.toHaveLength(0);
      expect(template.geoMechanisms.length).toBeGreaterThan(0);
      expect(template.outline.length).toBeGreaterThan(0);
      expect(template.evidenceRequirements.length).toBeGreaterThan(0);
      expect(template.riskBoundaries.length).toBeGreaterThan(0);
    }
  });

  it("covers every customer category and only governed editorial profiles", () => {
    const categoryIds = ARTICLE_TEMPLATE_CATEGORIES.filter((item) => item.id !== "all").map(
      (item) => item.id,
    );
    const profiles = new Set([
      "guide",
      "question_answer",
      "comparison",
      "risk_avoidance",
      "local_service",
    ]);

    for (const category of categoryIds) {
      expect(ARTICLE_TEMPLATES.some((template) => template.category === category)).toBe(true);
    }
    for (const template of ARTICLE_TEMPLATES) {
      expect(profiles.has(template.editorialProfile)).toBe(true);
    }
  });

  it("does not promise rankings, citations or Google equivalence", () => {
    const customerCopy = JSON.stringify(ARTICLE_TEMPLATES);
    expect(customerCopy).not.toMatch(/保证.{0,8}(排名|收录|引用|流量|成交)/u);
    expect(customerCopy).not.toMatch(/(豆包|千问).{0,12}(等同|等于|跟随).{0,12}Google/iu);
  });

  it("exposes one fail-closed template compatibility set for every selected platform", () => {
    expect(articleTemplatePlatforms("travel-note-photo-recap-01")).toEqual([
      "toutiao",
      "ctrip_community",
    ]);
    expect(articleTemplatePlatforms("travel-note-cost-contract-01")).toEqual([
      "toutiao",
      "sohu",
      "baijiahao",
      "netease",
      "zhihu",
    ]);
    expect(
      articleTemplateSupportsPlatforms("travel-note-photo-recap-01", ["ctrip_community"]),
    ).toBe(true);
    expect(articleTemplateSupportsPlatforms("travel-note-photo-recap-01", ["baijiahao"])).toBe(
      false,
    );
    expect(articleTemplateSupportsPlatforms("not-a-template", ["toutiao"])).toBe(false);

    const sharedTemplates = articleTemplatesForPlatforms(["ctrip_community", "baijiahao"]);
    expect(sharedTemplates).not.toContainEqual(
      expect.objectContaining({ id: "travel-note-photo-recap-01" }),
    );
    expect(sharedTemplates).not.toContainEqual(
      expect.objectContaining({ id: "travel-note-cost-contract-01" }),
    );
    expect(sharedTemplates).toContainEqual(expect.objectContaining({ id: "comparison-matrix" }));
  });
});
