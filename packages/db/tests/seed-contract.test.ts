import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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

  it("seeds a separate synthetic tenant and a Doubao/Qwen travel query set", () => {
    expect(seedSource).toContain("20000000-0000-4000-8000-000000000001");
    expect(seedSource).toContain("Synthetic Isolation Travel Ltd.");
    expect(seedSource).toContain("豆包与千问独立评测");
    expect(seedSource).toContain("中通国际旅行社电话");
    expect(seedSource).toContain("中通国际旅行社微信");
    expect(seedSource).toContain('providers: ["doubao", "qwen"]');
  });
});
