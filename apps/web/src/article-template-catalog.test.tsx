import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArticleTemplateCatalog } from "./article-template-catalog.js";

afterEach(cleanup);

describe("ArticleTemplateCatalog", () => {
  it("filters templates and reports the selected governed strategy", () => {
    const onSelect = vi.fn();
    render(<ArticleTemplateCatalog onSelect={onSelect} />);

    expect(screen.getByText(/\d+ 套可审计结构/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "证据与风险" }));
    expect(screen.getByRole("option", { name: /风险核对清单/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /方案对比矩阵/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /证据解读稿/ }));
    expect(screen.getByRole("heading", { level: 3, name: "证据解读稿" })).toBeInTheDocument();
    expect(screen.getByText("发布前证据")).toBeInTheDocument();
    expect(screen.getByText("风险边界")).toBeInTheDocument();
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "evidence-explainer", editorialProfile: "risk_avoidance" }),
    );
  });

  it("searches by customer benefit and applies the selected template", () => {
    const onSelect = vi.fn();
    render(<ArticleTemplateCatalog onSelect={onSelect} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文章模板" }), {
      target: { value: "错误预期" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /适合人群说明/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用此模板" }));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "audience-fit-guide" }),
    );
  });
});
