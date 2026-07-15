import { describe, expect, it } from "vitest";

import {
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATE_CATEGORIES,
  ARTICLE_TEMPLATES,
} from "@geo/contracts";

describe("GEO article template catalog", () => {
  it("exposes the immutable V1 catalog version", () => {
    expect(ARTICLE_TEMPLATE_CATALOG_VERSION).toBe("geo.article-templates.v1");
  });

  it("ships at least 20 complete and uniquely identified templates", () => {
    expect(ARTICLE_TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ARTICLE_TEMPLATES.map((template) => template.id)).size).toBe(
      ARTICLE_TEMPLATES.length,
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
});
