import { describe, expect, it } from "vitest";

import { parseCtripAssistedAccounts } from "../src/ctrip-assisted-config.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000401";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000402";

describe("Ctrip assisted account configuration", () => {
  it("parses an exact tenant/account adapter mapping without credentials", () => {
    expect(
      parseCtripAssistedAccounts(
        JSON.stringify([
          {
            tenantId,
            channelAccountId: accountId,
            bridgePrincipalId,
            adapterVersion: "ctrip-community-web-v1",
          },
        ]),
      ),
    ).toEqual([
      {
        tenantId,
        channelAccountId: accountId,
        bridgePrincipalId,
        adapterVersion: "ctrip-community-web-v1",
        handoffTtlSeconds: 900,
      },
    ]);
  });

  it.each([
    [
      "duplicate",
      [
        { tenantId, channelAccountId: accountId, bridgePrincipalId },
        { tenantId, channelAccountId: accountId, bridgePrincipalId },
      ],
    ],
    [
      "unknown key",
      [{ tenantId, channelAccountId: accountId, bridgePrincipalId, credential: "must-not-exist" }],
    ],
    [
      "bad bridge principal",
      [{ tenantId, channelAccountId: accountId, bridgePrincipalId: "not-a-uuid" }],
    ],
    [
      "bad expiry",
      [{ tenantId, channelAccountId: accountId, bridgePrincipalId, evidenceExpiresAt: "tomorrow" }],
    ],
    [
      "oversized ttl",
      [{ tenantId, channelAccountId: accountId, bridgePrincipalId, handoffTtlSeconds: 7201 }],
    ],
  ])("rejects %s mappings", (_label, partials) => {
    const entries = partials.map((partial) => ({
      adapterVersion: "ctrip-community-web-v1",
      evidenceExpiresAt: "2026-07-17T00:00:00.000Z",
      ...partial,
    }));
    expect(() => parseCtripAssistedAccounts(JSON.stringify(entries))).toThrow(TypeError);
  });
});
