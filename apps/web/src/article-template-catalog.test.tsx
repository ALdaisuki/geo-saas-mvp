import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTICLE_TEMPLATE_CATALOG_VERSION, ARTICLE_TEMPLATES } from "@geo/contracts";

import { ArticleTemplateCatalog } from "./article-template-catalog.js";

afterEach(cleanup);

describe("ArticleTemplateCatalog", () => {
  it("filters templates and reports the selected governed strategy", () => {
    const onSelect = vi.fn();
    render(
      <ArticleTemplateCatalog
        templates={ARTICLE_TEMPLATES}
        catalogVersion={ARTICLE_TEMPLATE_CATALOG_VERSION}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText(/\d+ 套旅行社内容结构/u)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "旅行社内容模板库" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "避坑核验" }));
    expect(screen.getByRole("option", { name: /风险核对清单/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /方案对比矩阵/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /证据解读稿/ }));
    expect(screen.getByRole("heading", { level: 3, name: "证据解读稿" })).toBeInTheDocument();
    expect(screen.getAllByText("风险核验").length).toBeGreaterThan(0);
    expect(screen.queryByText("risk avoidance")).not.toBeInTheDocument();
    expect(screen.getByText("发布前证据")).toBeInTheDocument();
    expect(screen.getByText("风险边界")).toBeInTheDocument();
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "evidence-explainer", editorialProfile: "risk_avoidance" }),
    );
  });

  it("searches by customer benefit and applies the selected template", () => {
    const onSelect = vi.fn();
    render(
      <ArticleTemplateCatalog
        templates={ARTICLE_TEMPLATES}
        catalogVersion={ARTICLE_TEMPLATE_CATALOG_VERSION}
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文章模板" }), {
      target: { value: "错误预期" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /适合人群说明/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空模板搜索" }));
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文章模板" }), {
      target: { value: "错误预期" },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用此模板" }));
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "audience-fit-guide" }),
    );
  });
});
