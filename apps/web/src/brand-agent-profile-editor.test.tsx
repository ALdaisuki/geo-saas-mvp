import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Brand, BrandAgentProfile } from "./api.js";
import { BrandAgentProfileEditor } from "./brand-agent-profile-editor.js";

afterEach(cleanup);

const brand: Brand = {
  id: "10000000-0000-4000-8000-000000000301",
  canonicalName: "example-travel",
  displayName: "示例旅行社",
  aliases: [],
  description: null,
  industry: "travel",
  websiteUrl: "https://example.test",
  isPrimary: true,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-01T08:00:00.000Z",
};

const profile: BrandAgentProfile = {
  id: "10000000-0000-4000-8000-000000000302",
  brandId: brand.id,
  version: 3,
  status: "active",
  document: {
    schemaVersion: "geo.brand-agent-profile.v1",
    voice: "清晰直接",
    audiences: ["潜在客户"],
    objectives: ["回答服务问题"],
    requiredPoints: ["当前有效信息"],
    forbiddenClaims: ["无证据保证"],
    callToAction: "联系核验",
    agentInstructions: "仅使用当前证据。",
  },
  documentHash: "a".repeat(64),
  effectiveAt: "2026-08-02T08:00:00.000Z",
  retiredAt: null,
  createdAt: "2026-08-02T08:00:00.000Z",
};

describe("BrandAgentProfileEditor", () => {
  it("groups the profile workspace without changing the audited save payload", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <BrandAgentProfileEditor
        mode="live"
        brands={[brand]}
        profiles={[profile]}
        capabilities={["tenant:manage"]}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole("group", { name: "策略基线" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "内容约束" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "输出编排" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("档案当前版本")).getByText("v3")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("品牌语气"), {
      target: { value: "直接回答，证据优先" },
    });
    fireEvent.change(screen.getByLabelText("档案版本变更原因"), {
      target: { value: "统一商业推广表达" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      brand.id,
      expect.objectContaining({
        reason: "统一商业推广表达",
        document: expect.objectContaining({ voice: "直接回答，证据优先" }),
      }),
    );
    expect(await screen.findByText("品牌写作档案新版本已保存")).toBeInTheDocument();
  });
});
