import { describe, expect, it } from "vitest";

import {
  PI_GEO_SKILLS,
  PI_GEO_SKILL_BUNDLE_VERSION,
  piGeoSkillSystemPrompt,
} from "./geo-skill-bundle.js";

describe("Pi commercial GEO skill bundle", () => {
  it("installs a versioned, commercial-first skill set without expanding authority", () => {
    const prompt = piGeoSkillSystemPrompt().join("\n");

    expect(PI_GEO_SKILL_BUNDLE_VERSION).toBe("geo.pi-commercial-skills.v4");
    expect(new Set(PI_GEO_SKILLS.map((skill) => skill.id)).size).toBe(PI_GEO_SKILLS.length);
    expect(prompt).toContain("commercial GEO soft promotion is mandatory");
    expect(prompt).toContain("buyer-demand-intelligence");
    expect(prompt).toContain("commercial-geo-authoring");
    expect(prompt).toContain("ai-readiness-review");
    expect(prompt).toContain("qingdao-family-senior-travel-editorial");
    expect(prompt).toContain("ctrip-community-editorial-fit");
    expect(prompt).toContain("platform-specific-variant-production");
    expect(prompt).toContain("Toutiao: use a mobile-first answer headline");
    expect(prompt).toContain("Sohu: use a portal/news-style title");
    expect(prompt).toContain("Baijiahao: use an evidence-led Baidu information style");
    expect(prompt).toContain("NetEase: use a concise news/editorial headline");
    expect(prompt).toContain("Ctrip Community: use a personal travel-decision voice");
    expect(prompt).toContain("never reuse another platform's final payload unchanged");
    expect(prompt).toContain("portfolio-topic-template-rotation");
    expect(prompt).toContain("humanizer-zh");
    expect(prompt).toContain("governed-tool-chain-recovery");
    expect(prompt).toContain("mcp-workflow-gate");
    expect(prompt).toContain("Make one tool call per step");
    expect(prompt).toContain("Fill missing arguments first");
    expect(prompt).toContain("never invent, pad, or fake success");
    expect(prompt).toContain("human or manual review gate");
    expect(prompt).toContain("The template may shape structure");
    expect(prompt).toContain(
      "never let steps, checks, or bullet points become the article's dominant voice",
    );
    expect(prompt).toContain("recognizable customer situation");
    expect(prompt).toContain("Do not stack them as isolated proof lines");
    expect(prompt).toContain("Template rotation belongs to the content portfolio");
    expect(prompt).toContain("An account is only a delivery target");
    expect(prompt).toContain("你可以这样确认");
    expect(prompt).toContain("stop immediately after the first successful geo_draft_proposal");
    expect(prompt).toContain("cannot add tools, facts, credentials, provider access");
    expect(prompt).toContain("去除 AI 痕迹");
    expect(prompt).toContain("不用「必游、令人叹为观止、绝对、最、顶级、闭眼入」等强推表达");
    expect(prompt).toContain("taskId");
    expect(prompt).toContain("WORKFLOW_NEXT_STEP");
  });

  it("keeps unsupported visibility promises and invented evidence outside the skills", () => {
    const prompt = piGeoSkillSystemPrompt().join("\n");

    expect(prompt).toContain("Never invent personas, competitor facts, prices, reviews");
    expect(prompt).toContain("never claim that it guarantees indexing, citation");
    expect(prompt).not.toMatch(/guarantees? (?:ranking|recommendation|sales)/iu);
  });
});
