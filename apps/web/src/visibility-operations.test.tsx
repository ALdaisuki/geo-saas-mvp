import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeoApi, QuerySet, VisibilityRun, VisibilityRunDetail } from "./api.js";
import { VisibilityOperations } from "./visibility-operations.js";

afterEach(cleanup);

const querySets: readonly QuerySet[] = [
  {
    id: "10000000-0000-4000-8000-000000000901",
    name: "旅行 GEO 基准问题集",
    industry: "travel",
    status: "active",
    currentVersion: 1,
    description: "豆包与千问独立评测",
    currentVersionId: "10000000-0000-4000-8000-000000000902",
    prompts: [
      { key: "brand-phone", category: "contact", prompt: "示例国际旅行服务电话是多少" },
      { key: "generic-japan", category: "generic", prompt: "日本跟团游哪家靠谱" },
    ],
    promptHash: "a".repeat(64),
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
  },
];

function visibilityRun(
  id: string,
  provider: "doubao" | "qwen",
  observationMethod: "fixture" | "manual",
): VisibilityRun {
  return {
    id,
    querySetVersionId: querySets[0]?.currentVersionId ?? "",
    provider,
    productSurface:
      observationMethod === "fixture" ? `${provider}-fixture` : `${provider}-web-search`,
    model: observationMethod === "fixture" ? `${provider}-fixture-v1` : "manual-observed-unknown",
    searchMode: observationMethod === "fixture" ? "unknown" : "on",
    observationMethod,
    status: "completed",
    locale: "zh-CN",
    geo: "CN",
    startedAt: "2026-07-14T08:00:00.000Z",
    completedAt: "2026-07-14T08:00:01.000Z",
    errorMessage: null,
    observationCount: 1,
    createdAt: "2026-07-14T08:00:00.000Z",
  };
}

function visibilityDetail(run: VisibilityRun, rawAnswer: string): VisibilityRunDetail {
  return {
    run,
    observations: [
      {
        id: `${run.id.slice(0, -1)}2`,
        tenantId: "10000000-0000-4000-8000-000000000001",
        runId: run.id,
        provider: run.provider,
        productSurface: run.productSurface,
        model: run.model,
        searchMode: run.searchMode,
        observationMethod: run.observationMethod,
        prompt: "示例国际旅行服务电话是多少",
        promptVersion: "1",
        locale: "zh-CN",
        geo: "CN",
        rawAnswer,
        citedUrls: ["https://example.test/contact"],
        evidenceHash: "f".repeat(64),
        evidenceType: run.observationMethod === "fixture" ? "fixture" : "manual_import",
        requestStartedAt: "2026-07-14T07:59:59.000Z",
        responseReceivedAt: "2026-07-14T08:00:00.000Z",
        observedAt: "2026-07-14T08:00:00.000Z",
        brandMentioned: true,
        answerPosition: 1,
        contactAccuracy: 1,
        competitorMentions: ["示例旅行社"],
        sentiment: "neutral",
        hallucinationFindings: [],
        harmfulError: false,
        extractorVersion: "visibility-v1",
        evaluatorVersion: "geo-visibility-evaluator-v1",
        metadata: {},
        createdAt: "2026-07-14T08:00:01.000Z",
      },
    ],
    metrics: [
      {
        name: "contact_accuracy",
        value: 1,
        sampleCount: 1,
        confidenceLow: null,
        confidenceHigh: null,
        dimensions: { provider: run.provider },
        createdAt: "2026-07-14T08:00:01.000Z",
      },
    ],
  };
}

function visibilityApi(overrides: Partial<GeoApi>): GeoApi {
  return overrides as GeoApi;
}

describe("VisibilityOperations", () => {
  it("runs a clearly marked fixture and reads the persisted detail back", async () => {
    const run = visibilityRun("10000000-0000-4000-8000-000000001501", "qwen", "fixture");
    let runs: readonly VisibilityRun[] = [];
    const runFixtureVisibility = vi.fn<GeoApi["runFixtureVisibility"]>(async (input) => {
      void input;
      runs = [run];
      return {
        visibilityRunId: run.id,
        status: "completed" as const,
        providerMode: "fixture" as const,
        evidenceType: "fixture" as const,
        wasCreated: true,
      };
    });
    const onChanged = vi.fn();
    const api = visibilityApi({
      getVisibilityRuns: async () => runs,
      getVisibilityRun: async () => visibilityDetail(run, "Fixture 固定回答"),
      runFixtureVisibility,
    });
    render(
      <VisibilityOperations
        api={api}
        tenantId="tenant-a"
        querySets={querySets}
        capabilities={["visibility:run"]}
        onChanged={onChanged}
      />,
    );

    await screen.findByText("当前租户尚无可见性运行");
    fireEvent.change(screen.getByLabelText("固定样本目标系统"), { target: { value: "qwen" } });
    fireEvent.change(screen.getByLabelText("固定样本重复采样次数"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "运行固定样本评测" }));

    await waitFor(() => expect(runFixtureVisibility).toHaveBeenCalledTimes(1));
    expect(runFixtureVisibility.mock.calls[0]?.[0]).toMatchObject({
      querySetVersionId: querySets[0]?.currentVersionId,
      provider: "qwen",
      sampleCount: 3,
    });
    expect(await screen.findByText("Fixture 固定回答")).toBeInTheDocument();
    expect(screen.getByText(/未调用外部模型/)).toBeInTheDocument();
    expect(screen.getAllByText("固定样本").length).toBeGreaterThan(0);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("imports multiple manual observations with explicit manual evidence metadata", async () => {
    const run = visibilityRun("10000000-0000-4000-8000-000000001601", "doubao", "manual");
    let runs: readonly VisibilityRun[] = [];
    const importVisibility = vi.fn<GeoApi["importVisibility"]>(async (input) => {
      void input;
      runs = [run];
      return {
        visibilityRunId: run.id,
        status: "completed" as const,
        providerMode: "manual" as const,
        evidenceType: "manual_import" as const,
        wasCreated: true,
      };
    });
    const api = visibilityApi({
      getVisibilityRuns: async () => runs,
      getVisibilityRun: async () => visibilityDetail(run, "人工观察回读"),
      importVisibility,
    });
    render(
      <VisibilityOperations
        api={api}
        tenantId="tenant-a"
        querySets={querySets}
        capabilities={["visibility:run"]}
      />,
    );

    await screen.findByText("当前租户尚无可见性运行");
    fireEvent.click(screen.getByRole("button", { name: "人工导入" }));
    fireEvent.click(screen.getByRole("button", { name: "添加观察" }));
    const answers = screen.getAllByLabelText(/观察 \d+ 原始回答/);
    const citations = screen.getAllByLabelText(/观察 \d+ 引用 URL/);
    fireEvent.change(answers[0] as HTMLElement, { target: { value: "第一条人工回答" } });
    fireEvent.change(answers[1] as HTMLElement, { target: { value: "第二条人工回答" } });
    fireEvent.change(citations[0] as HTMLElement, {
      target: { value: "https://example.test/one" },
    });
    fireEvent.change(citations[1] as HTMLElement, {
      target: { value: "https://example.test/two\nhttps://example.test/three" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入人工观察" }));

    await waitFor(() => expect(importVisibility).toHaveBeenCalledTimes(1));
    expect(importVisibility.mock.calls[0]?.[0]).toMatchObject({
      provider: "doubao",
      productSurface: "doubao-web-search",
      searchMode: "on",
      samples: [
        { rawAnswer: "第一条人工回答", citedUrls: ["https://example.test/one"] },
        {
          rawAnswer: "第二条人工回答",
          citedUrls: ["https://example.test/two", "https://example.test/three"],
        },
      ],
    });
    expect(await screen.findByText("人工观察回读")).toBeInTheDocument();
    expect(screen.getAllByText(/人工导入/).length).toBeGreaterThan(0);
    expect(screen.getByText("示例旅行社")).toBeInTheDocument();
    expect(screen.getByText("https://example.test/contact")).toHaveAttribute(
      "href",
      "https://example.test/contact",
    );
  });

  it("drops an in-flight previous-tenant result before rendering the new tenant", async () => {
    const tenantARun = visibilityRun("10000000-0000-4000-8000-000000001701", "doubao", "manual");
    const tenantBRun = visibilityRun("20000000-0000-4000-8000-000000001701", "qwen", "manual");
    let resolveTenantA: (value: readonly VisibilityRun[]) => void = () => undefined;
    const tenantAPromise = new Promise<readonly VisibilityRun[]>((resolve) => {
      resolveTenantA = resolve;
    });
    const getVisibilityRuns = vi
      .fn<GeoApi["getVisibilityRuns"]>()
      .mockImplementationOnce(async () => tenantAPromise)
      .mockResolvedValueOnce([tenantBRun]);
    const api = visibilityApi({
      getVisibilityRuns,
      getVisibilityRun: async (runId) =>
        runId === tenantBRun.id
          ? visibilityDetail(tenantBRun, "tenant-b-answer")
          : visibilityDetail(tenantARun, "tenant-a-secret"),
    });
    const view = render(
      <VisibilityOperations
        api={api}
        tenantId="tenant-a"
        querySets={querySets}
        capabilities={["visibility:run"]}
      />,
    );

    view.rerender(
      <VisibilityOperations
        api={api}
        tenantId="tenant-b"
        querySets={querySets}
        capabilities={["visibility:run"]}
      />,
    );
    expect(await screen.findByText("tenant-b-answer")).toBeInTheDocument();
    await act(async () => resolveTenantA([tenantARun]));

    await waitFor(() => expect(screen.queryByText("tenant-a-secret")).not.toBeInTheDocument());
    expect(screen.queryByText(tenantARun.productSurface)).not.toBeInTheDocument();
    expect(screen.getAllByText(tenantBRun.productSurface).length).toBeGreaterThan(0);
  });

  it("prioritizes failed runs and filters the stable run index", async () => {
    const completed = visibilityRun("10000000-0000-4000-8000-000000001801", "doubao", "fixture");
    const failed: VisibilityRun = {
      ...visibilityRun("10000000-0000-4000-8000-000000001802", "qwen", "manual"),
      status: "failed",
      productSurface: "qwen-browser-failed",
      errorMessage: "浏览器观察超时",
      completedAt: null,
      observationCount: 0,
    };
    const queued: VisibilityRun = {
      ...visibilityRun("10000000-0000-4000-8000-000000001803", "doubao", "manual"),
      status: "queued",
      productSurface: "doubao-browser-queued",
      completedAt: null,
      observationCount: 0,
    };
    const api = visibilityApi({
      getVisibilityRuns: async () => [completed, queued, failed],
      getVisibilityRun: async (runId) => {
        const run = [completed, queued, failed].find((item) => item.id === runId);
        if (run === undefined) throw new Error("run not found");
        return visibilityDetail(run, `${run.productSurface}-answer`);
      },
    });
    render(
      <VisibilityOperations
        api={api}
        tenantId="tenant-a"
        querySets={querySets}
        capabilities={["visibility:run"]}
      />,
    );

    expect(await screen.findByText("浏览器观察超时")).toBeInTheDocument();
    const runList = screen.getByLabelText("可见性运行列表");
    const rows = within(runList).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("qwen-browser-failed");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索可见性运行" }), {
      target: { value: "queued" },
    });
    expect(within(runList).getAllByRole("button")).toHaveLength(1);
    expect(within(runList).getByRole("button")).toHaveTextContent("doubao-browser-queued");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索可见性运行" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    expect(within(runList).getAllByRole("button")).toHaveLength(1);
    expect(within(runList).getByRole("button")).toHaveTextContent(completed.productSurface);
  });
});
