import { describe, expect, it } from "vitest";

import { parseCtripAssistedAccounts } from "../src/ctrip-assisted-config.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000401";

describe("Ctrip assisted account configuration", () => {
  it("parses an exact tenant/account adapter mapping without credentials", () => {
    expect(
      parseCtripAssistedAccounts(
        JSON.stringify([
          {
            tenantId,
            channelAccountId: accountId,
            adapterVersion: "ctrip-community-web-v1",
            evidenceExpiresAt: "2026-07-17T00:00:00.000Z",
          },
        ]),
      ),
    ).toEqual([
      {
        tenantId,
        channelAccountId: accountId,
        adapterVersion: "ctrip-community-web-v1",
        evidenceExpiresAt: "2026-07-17T00:00:00.000Z",
        handoffTtlSeconds: 900,
      },
    ]);
  });

  it.each([
    [
      "duplicate",
      [
        { tenantId, channelAccountId: accountId },
        { tenantId, channelAccountId: accountId },
      ],
    ],
    ["unknown key", [{ tenantId, channelAccountId: accountId, credential: "must-not-exist" }]],
    ["bad expiry", [{ tenantId, channelAccountId: accountId, evidenceExpiresAt: "tomorrow" }]],
    ["oversized ttl", [{ tenantId, channelAccountId: accountId, handoffTtlSeconds: 7201 }]],
  ])("rejects %s mappings", (_label, partials) => {
    const entries = partials.map((partial) => ({
      adapterVersion: "ctrip-community-web-v1",
      evidenceExpiresAt: "2026-07-17T00:00:00.000Z",
      ...partial,
    }));
    expect(() => parseCtripAssistedAccounts(JSON.stringify(entries))).toThrow(TypeError);
  });
});
