import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositorySource = await readFile(
  new URL("./postgres-tenant-governance-repository.ts", import.meta.url),
  "utf8",
);

describe("PostgreSQL tenant governance repository contracts", () => {
  it("serializes runtime refresh with account archival", () => {
    const refreshBlock = repositorySource.slice(
      repositorySource.indexOf("async refreshCtripAccountRuntime"),
      repositorySource.indexOf("async forceCalibrateCtripAccountRuntime"),
    );

    expect(refreshBlock).toContain("for update");
    expect(refreshBlock).toContain("current.archived_at !== null");
  });

  it("reserves a manual browser window before login runtimes can be reclaimed", () => {
    const reservationBlock = repositorySource.slice(
      repositorySource.indexOf("async reserveCtripAccountBrowser"),
      repositorySource.indexOf("async deleteChannelAccount"),
    );

    expect(reservationBlock).toContain("set manual_ready_until = greatest(");
    expect(reservationBlock).toContain("clock_timestamp() + make_interval(mins =>");
    expect(reservationBlock).toContain("account.status = 'active'");
    expect(reservationBlock).toContain("binding.session_state not in ('unbound', 'disabled')");
  });
});
