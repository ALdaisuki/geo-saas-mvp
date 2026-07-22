import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./postgres-control-plane.ts", import.meta.url), "utf8");

describe("Postgres Ctrip media ownership query", () => {
  it("uses the current version binding while allowing media inherited from an ancestor version", () => {
    expect(source).toContain("select binding.content_version_id");
    expect(source).toContain("binding.content_version_id = variant.content_version_id");
    expect(source).not.toContain("asset.content_version_id = variant.content_version_id");
  });

  it("maps media positions from the audited payload order rather than role-local bindings", () => {
    expect(source).toContain("(payload_media.ordinal - 1)::integer as position");
    expect(source).not.toContain("select binding.content_version_id, binding.position");
    expect(source).toContain("order by payload_media.ordinal");
  });
});
