import { describe, expect, it } from "vitest";

import { GeoApiError, HttpGeoApi } from "./api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const loginBody = {
  actor: {
    id: "10000000-0000-4000-8000-000000000101",
    displayName: "测试运营员",
    role: "owner",
    capabilities: ["tenant:read"],
  },
  tenant: {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "zhongtong-international-travel",
    displayName: "中通国际旅行社",
  },
  csrfToken: "csrf-token-from-api",
  expiresAt: "2026-07-14T16:00:00.000Z",
};

describe("HttpGeoApi", () => {
  it("uses cookie credentials and forwards the login CSRF token on writes", async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    const responses = [jsonResponse(loginBody), new Response(null, { status: 204 })];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    const session = await api.login({
      email: "owner@example.test",
      password: "correct-password",
      tenantSlug: "zhongtong-international-travel",
    });
    await api.logout();

    expect(session.tenant.displayName).toBe("中通国际旅行社");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      email: "owner@example.test",
      tenantSlug: "zhongtong-international-travel",
    });
    expect(new Headers(calls[1]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });

  it("preserves the tenant choices returned by TENANT_SELECTION_REQUIRED", async () => {
    const api = new HttpGeoApi("", async () =>
      jsonResponse(
        {
          error: {
            code: "TENANT_SELECTION_REQUIRED",
            message: "Select an active tenant",
            requestId: "req-tenant-list",
            details: {
              tenants: [
                { slug: "zhongtong", displayName: "中通国际旅行社" },
                { slug: "isolation", displayName: "隔离测试旅行社" },
              ],
            },
          },
        },
        409,
      ),
    );

    let failure: unknown;
    try {
      await api.login({ email: "owner@example.test", password: "correct-password" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GeoApiError);
    expect(failure).toMatchObject({
      code: "TENANT_SELECTION_REQUIRED",
      requestId: "req-tenant-list",
      details: { tenants: [{ slug: "zhongtong" }, { slug: "isolation" }] },
    });
  });

  it("parses visibility rows by full evidence dimension and excludes fixture by default URL", async () => {
    const inputs: string[] = [];
    const api = new HttpGeoApi("", async (input) => {
      inputs.push(String(input));
      return jsonResponse({
        items: [
          {
            provider: "qwen",
            productSurface: "web-search",
            model: "qwen-search-v2",
            searchMode: "on",
            observationMethod: "manual",
            evidenceType: "manual_import",
            observations: 8,
            brandMentionRate: 0.375,
            contactAccuracy: 1,
            harmfulErrors: 0,
          },
        ],
      });
    });

    const rows = await api.getVisibilitySummary();

    expect(inputs).toEqual(["/api/visibility/summary"]);
    expect(rows[0]).toMatchObject({
      provider: "qwen",
      productSurface: "web-search",
      model: "qwen-search-v2",
      observationMethod: "manual",
      evidenceType: "manual_import",
    });
  });

  it("reports malformed successful responses instead of treating them as empty data", async () => {
    const api = new HttpGeoApi("", async () => jsonResponse({ unexpected: [] }));

    await expect(api.getCampaigns()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("keeps a non-JSON proxy failure as an explicit HTTP error", async () => {
    const api = new HttpGeoApi("", async () => new Response("Bad Gateway", { status: 502 }));

    await expect(api.getSession()).rejects.toMatchObject({
      status: 502,
      code: "HTTP_502",
    });
  });

  it("uses governed tenant-switch and automation endpoints with CSRF", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const automationControl = {
      mode: "shadow",
      killSwitchEnabled: false,
      reason: "initial",
      quota: { dryRunOnly: true },
      updatedAt: "2026-07-14T08:00:00.000Z",
    };
    const responses = [
      jsonResponse(loginBody),
      jsonResponse({
        items: [
          {
            id: loginBody.tenant.id,
            slug: loginBody.tenant.slug,
            displayName: loginBody.tenant.displayName,
            role: "owner",
            status: "active",
          },
        ],
      }),
      jsonResponse(loginBody),
      jsonResponse({ control: automationControl, circuits: [] }),
      jsonResponse({ control: { ...automationControl, killSwitchEnabled: true } }),
    ];
    const api = new HttpGeoApi("", async (input, init) => {
      calls.push({ input: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });

    await api.login({ email: "owner@example.test", password: "correct-password" });
    const tenants = await api.getTenants();
    await api.switchTenant(loginBody.tenant.slug);
    const automation = await api.getAutomation();
    const updated = await api.setKillSwitch({ enabled: true, reason: "contact anomaly" });

    expect(tenants[0]).toMatchObject({ status: "active", role: "owner" });
    expect(automation.control.killSwitchEnabled).toBe(false);
    expect(updated.killSwitchEnabled).toBe(true);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/auth/login",
      "/api/auth/tenants",
      "/api/auth/switch-tenant",
      "/api/automation",
      "/api/automation/kill-switch",
    ]);
    expect(new Headers(calls[2]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
    expect(new Headers(calls[4]?.init?.headers).get("x-csrf-token")).toBe("csrf-token-from-api");
  });
});
