import { describe, expect, it } from "vitest";

import { parseWorkerTenantActors } from "../src/actor-map.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000102";

describe("worker tenant actor configuration", () => {
  it("parses an explicit tenant-to-actor UUID mapping", () => {
    expect(parseWorkerTenantActors(JSON.stringify({ [tenantId]: actorId }))).toEqual({
      [tenantId]: actorId,
    });
  });

  it("normalizes uppercase UUIDs to PostgreSQL's canonical lowercase form", () => {
    const uppercaseTenant = "ABCDEF00-0000-4000-8000-000000000001";
    const uppercaseActor = "ABCDEF00-0000-4000-8000-000000000102";
    expect(parseWorkerTenantActors(JSON.stringify({ [uppercaseTenant]: uppercaseActor }))).toEqual({
      [uppercaseTenant.toLowerCase()]: uppercaseActor.toLowerCase(),
    });
  });

  it("rejects conflicting mappings that normalize to the same tenant", () => {
    expect(() =>
      parseWorkerTenantActors(
        JSON.stringify({
          "ABCDEF00-0000-4000-8000-000000000001": uppercaseActorFor("102"),
          "abcdef00-0000-4000-8000-000000000001": uppercaseActorFor("103"),
        }),
      ),
    ).toThrow("conflicting tenant mappings");
  });

  it.each(["not-json", "[]", "{}", JSON.stringify({ [tenantId]: "not-a-uuid" })])(
    "rejects invalid configuration: %s",
    (value) => {
      expect(() => parseWorkerTenantActors(value)).toThrow(TypeError);
    },
  );
});

function uppercaseActorFor(suffix: string): string {
  return `ABCDEF00-0000-4000-8000-000000000${suffix}`;
}
