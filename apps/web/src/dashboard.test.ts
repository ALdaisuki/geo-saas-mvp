import { describe, expect, it, vi } from "vitest";

import { GeoApiError, type GeoApi } from "./api.js";
import { loadLiveDashboard, loadLiveOperationsResources } from "./dashboard.js";

describe("loadLiveOperationsResources", () => {
  it("loads only the four high-frequency operations resources and preserves partial errors", async () => {
    const getTrendCandidates = vi.fn(async () => []);
    const getContent = vi.fn(async () => []);
    const getPublicationJobs = vi.fn(async () => []);
    const getReceipts = vi.fn(async () => {
      throw new GeoApiError(503, "RECEIPTS_UNAVAILABLE", "Receipt store unavailable");
    });
    const getBrands = vi.fn(async () => []);
    const api = {
      getTrendCandidates,
      getContent,
      getPublicationJobs,
      getReceipts,
      getBrands,
    } as unknown as GeoApi;

    const resources = await loadLiveOperationsResources(api, [
      "trend_discovery",
      "ai_content",
      "priority_distribution",
    ]);

    expect(getTrendCandidates).toHaveBeenCalledWith({ limit: 12, lookbackMinutes: 1_440 });
    expect(getContent).toHaveBeenCalledOnce();
    expect(getPublicationJobs).toHaveBeenCalledOnce();
    expect(getReceipts).toHaveBeenCalledOnce();
    expect(getBrands).not.toHaveBeenCalled();
    expect(resources.receipts).toMatchObject({
      status: "error",
      error: { status: 503, code: "RECEIPTS_UNAVAILABLE" },
    });
    expect(resources.content.status).toBe("ready");
  });

  it("does not call high-frequency APIs for ungranted modules", async () => {
    const getTrendCandidates = vi.fn(async () => []);
    const getContent = vi.fn(async () => []);
    const getPublicationJobs = vi.fn(async () => []);
    const getReceipts = vi.fn(async () => []);
    const api = {
      getTrendCandidates,
      getContent,
      getPublicationJobs,
      getReceipts,
    } as unknown as GeoApi;

    const resources = await loadLiveOperationsResources(api, []);

    expect(getTrendCandidates).not.toHaveBeenCalled();
    expect(getContent).not.toHaveBeenCalled();
    expect(getPublicationJobs).not.toHaveBeenCalled();
    expect(getReceipts).not.toHaveBeenCalled();
    expect(resources.trendCandidates).toMatchObject({ status: "ready", data: [] });
    expect(resources.content).toMatchObject({ status: "ready", data: [] });
    expect(resources.publicationJobs).toMatchObject({ status: "ready", data: [] });
    expect(resources.receipts).toMatchObject({ status: "ready", data: [] });
  });
});

describe("loadLiveDashboard", () => {
  it("does not request capability-protected resources for a limited operator", async () => {
    const forbidden = vi.fn(async () => {
      throw new GeoApiError(403, "AUTHORIZATION_DENIED", "Missing capability");
    });
    const empty = vi.fn(async () => []);
    const nullable = vi.fn(async () => null);
    const api = {
      getTenant: nullable,
      getTenants: empty,
      getContacts: empty,
      getChannelAccounts: forbidden,
      getCtripAccountAnalytics: forbidden,
      getBrands: empty,
      getMembers: forbidden,
      getPolicies: empty,
      getQuerySets: forbidden,
      getEvidenceSources: forbidden,
      getFacts: forbidden,
      getCampaigns: forbidden,
      getContent: forbidden,
      getAudits: empty,
      getPublicationJobs: forbidden,
      getReceipts: forbidden,
      getVisibilitySummary: forbidden,
      getAutomation: forbidden,
      getCtripBridgeStatus: forbidden,
      getServicePrincipals: forbidden,
      getArticleTemplates: forbidden,
      getBrandAgentProfiles: forbidden,
      getPublicationAssistedHandoffs: forbidden,
      getTrendCandidates: forbidden,
    } as unknown as GeoApi;
    const dashboard = await loadLiveDashboard(
      api,
      [
        "tenant:read",
        "content:read",
        "content:write",
        "audit:read",
        "audit:run",
        "publish:request",
        "receipt:read",
        "automation:execute",
        "principal:manage",
      ],
      [],
    );

    expect(forbidden).not.toHaveBeenCalled();
    expect(dashboard.members.status).toBe("ready");
    expect(dashboard.querySets.status).toBe("ready");
    expect(dashboard.visibility.status).toBe("ready");
    expect(dashboard.servicePrincipals.status).toBe("ready");
    expect(dashboard.channelAccounts).toMatchObject({ status: "ready", data: [] });
    expect(dashboard.content).toMatchObject({ status: "ready", data: [] });
    expect(dashboard.automation).toMatchObject({ status: "ready", data: null });
  });
});
