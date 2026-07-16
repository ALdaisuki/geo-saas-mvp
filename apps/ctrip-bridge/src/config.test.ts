import { describe, expect, it } from "vitest";

import { parseCtripBridgeTenantConfigs, requireSimulatorHost } from "./config.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const bridgePrincipalId = "10000000-0000-4000-8000-000000000002";
const accessToken = "ctrip-bridge-config-token-with-safe-length";

describe("Ctrip bridge startup configuration", () => {
  it("accepts only exact server-owned tenant bindings", () => {
    expect(
      parseCtripBridgeTenantConfigs(JSON.stringify([{ tenantId, bridgePrincipalId, accessToken }])),
    ).toEqual([{ tenantId, bridgePrincipalId, accessToken }]);
    expect(() =>
      parseCtripBridgeTenantConfigs(
        JSON.stringify([{ tenantId, bridgePrincipalId, accessToken, selector: "#publish" }]),
      ),
    ).toThrow();
  });

  it("rejects duplicate identity or credential material", () => {
    expect(() =>
      parseCtripBridgeTenantConfigs(
        JSON.stringify([
          { tenantId, bridgePrincipalId, accessToken },
          {
            tenantId,
            bridgePrincipalId: "20000000-0000-4000-8000-000000000002",
            accessToken: `${accessToken}-other`,
          },
        ]),
      ),
    ).toThrow(/unique/iu);
  });

  it("binds simulator mode to loopback only", () => {
    expect(requireSimulatorHost("127.0.0.1")).toBe("127.0.0.1");
    expect(() => requireSimulatorHost("0.0.0.0")).toThrow(/loopback/iu);
  });
});
