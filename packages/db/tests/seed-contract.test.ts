import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { sha256Canonical } from "@geo/core";
import { travelQuerySetPromptsV1, travelQuerySetV1 } from "@geo/visibility";

const seedSource = await readFile(new URL("../src/seed.ts", import.meta.url), "utf8");

describe("database seed contract", () => {
  it("contains exact versioned Zhongtong contact facts", () => {
    expect(seedSource).toContain("中通国际旅行社");
    expect(seedSource).toContain("4001133986");
    expect(seedSource).toContain("ZTGL3411");
    expect(seedSource).toContain("ZTGL6431");
    expect(seedSource).toContain("partner-confirmed-seed");
  });

  it("creates only dry-run capabilities for all three MVP platforms", () => {
    expect(seedSource).toContain('"toutiao"');
    expect(seedSource).toContain('"sohu"');
    expect(seedSource).toContain('"ctrip_community"');
    expect(seedSource).toContain("'manual_only'");
    expect(seedSource).toContain("ARRAY['dry_run']::text[]");
    expect(seedSource).toContain("'shadow'");
  });

  it("seeds a separate synthetic tenant and a provider-neutral travel query set", () => {
    expect(seedSource).toContain("20000000-0000-4000-8000-000000000001");
    expect(seedSource).toContain("Synthetic Isolation Travel Ltd.");
    expect(seedSource).toContain("豆包与千问独立评测");
    expect(travelQuerySetPromptsV1.some((prompt) => prompt.key === "brand-phone")).toBe(true);
    expect(travelQuerySetPromptsV1.some((prompt) => prompt.key === "brand-wechat")).toBe(true);
    expect(seedSource).toContain("const travelPrompts = travelQuerySetPromptsV1");
    expect(seedSource).toContain("豆包与千问独立评测，不使用 Google 排名作为代理指标");
  });

  it("seeds Zhongtong from the canonical travelQuerySetV1 with full control coverage", () => {
    expect(seedSource).toContain("travelQuerySetPromptsV1");
    expect(seedSource).toContain("travelQuerySetV1.version");
    expect(travelQuerySetV1.queries.some((query) => query.intent === "comparison")).toBe(true);
    expect(travelQuerySetV1.queries.some((query) => query.intent === "negative_control")).toBe(
      true,
    );
    expect(travelQuerySetV1.queries.some((query) => query.intent === "blank_control")).toBe(true);
    expect(sha256Canonical(travelQuerySetPromptsV1)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("seeds explicit brand-scoped competitor truth instead of analyzer-local names", () => {
    expect(seedSource).toContain("geo.brand_competitors");
    expect(seedSource).toContain("seed:zhongtong:competitors:v1");
  });

  it("seeds a separate active worker service principal for each fixture tenant", () => {
    expect(seedSource).toContain("fixture-publication-worker");
    expect(seedSource).toContain("SEED_IDS.zhongtong.workerPrincipal");
    expect(seedSource).toContain("SEED_IDS.synthetic.workerPrincipal");
    expect(seedSource).toContain("'worker', 'active'");
  });
});
