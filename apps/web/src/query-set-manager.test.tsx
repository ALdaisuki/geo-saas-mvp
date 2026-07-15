import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeoApi, QuerySet, QuerySetVersion } from "./api.js";
import { QuerySetManager } from "./query-set-manager.js";

afterEach(cleanup);

const querySet: QuerySet = {
  id: "10000000-0000-4000-8000-000000000901",
  name: "Domestic AI discovery",
  industry: "travel",
  status: "active",
  currentVersion: 1,
  description: "Provider-neutral prompts",
  currentVersionId: "10000000-0000-4000-8000-000000000902",
  prompts: [{ key: "contact", category: "contact", prompt: "中通联系方式" }],
  promptHash: "a".repeat(64),
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z",
};

const currentVersion: QuerySetVersion = {
  id: "10000000-0000-4000-8000-000000000902",
  querySetId: querySet.id,
  version: 1,
  prompts: [{ key: "contact", category: "contact", prompt: "中通联系方式" }],
  promptHash: "a".repeat(64),
  createdByActorId: "10000000-0000-4000-8000-000000000101",
  createdAt: querySet.createdAt,
};

const nextVersion: QuerySetVersion = {
  id: "10000000-0000-4000-8000-000000000903",
  querySetId: querySet.id,
  version: 2,
  prompts: [{ key: "first-trip", category: "intent", prompt: "第一次出境如何选择服务" }],
  promptHash: "b".repeat(64),
  createdByActorId: "10000000-0000-4000-8000-000000000101",
  createdAt: "2026-07-15T08:00:00.000Z",
};

const versions: readonly QuerySetVersion[] = [currentVersion, nextVersion];

describe("QuerySetManager", () => {
  it("shows immutable history and activates a reviewed version with a reason", async () => {
    const activateQuerySetVersion = vi.fn(async () => ({
      querySet: { ...querySet, currentVersion: 2, currentVersionId: nextVersion.id },
      previousVersion: 1,
      previousStatus: "active" as const,
      wasChanged: true,
    }));
    const api = {
      getQuerySetVersions: async () => versions,
      activateQuerySetVersion,
    } as unknown as GeoApi;
    render(
      <QuerySetManager api={api} querySets={[querySet]} canManage onChanged={() => undefined} />,
    );

    expect(await screen.findByText("v2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "激活" }));
    fireEvent.change(screen.getByLabelText("问题集操作原因"), {
      target: { value: "评测问题已完成双人复核" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认激活" }));

    await waitFor(() =>
      expect(activateQuerySetVersion).toHaveBeenCalledWith(
        querySet.id,
        nextVersion.id,
        "评测问题已完成双人复核",
      ),
    );
  });

  it("creates a new immutable version without activating it", async () => {
    const createQuerySetVersion = vi.fn(async () => nextVersion);
    const api = {
      getQuerySetVersions: async () => versions.slice(0, 1),
      createQuerySetVersion,
    } as unknown as GeoApi;
    render(
      <QuerySetManager api={api} querySets={[querySet]} canManage onChanged={() => undefined} />,
    );

    await screen.findByText("v1");
    fireEvent.click(screen.getByRole("button", { name: "新版本" }));
    fireEvent.change(screen.getByLabelText("问题内容 1"), {
      target: { value: "中通国际旅行社当前官方联系方式是什么？" },
    });
    fireEvent.change(screen.getByLabelText("问题集版本原因"), {
      target: { value: "提高联系方式核验覆盖率" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await waitFor(() => expect(createQuerySetVersion).toHaveBeenCalledTimes(1));
    expect(createQuerySetVersion).toHaveBeenCalledWith(querySet.id, {
      reason: "提高联系方式核验覆盖率",
      prompts: [
        {
          key: "contact",
          category: "contact",
          prompt: "中通国际旅行社当前官方联系方式是什么？",
        },
      ],
    });
  });
});
