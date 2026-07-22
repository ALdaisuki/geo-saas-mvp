import { describe, expect, it, vi } from "vitest";

import {
  GeoApiSessionRegistry,
  HttpInternalGeoApiClient,
  parseMcpPrincipalCredentials,
} from "./http-api-client.js";

const ids = {
  tenant: "30000000-0000-4000-8000-000000000001",
  actor: "30000000-0000-4000-8000-000000000101",
  batch: "30000000-0000-4000-8000-000000000201",
  run: "30000000-0000-4000-8000-000000000301",
  campaign: "30000000-0000-4000-8000-000000000401",
  brand: "30000000-0000-4000-8000-000000000501",
  target: "30000000-0000-4000-8000-000000000601",
  account: "30000000-0000-4000-8000-000000000701",
  content: "30000000-0000-4000-8000-000000000801",
  version: "30000000-0000-4000-8000-000000000802",
  variant: "30000000-0000-4000-8000-000000000803",
  audit: "30000000-0000-4000-8000-000000000804",
  job: "30000000-0000-4000-8000-000000000805",
};
const timestamp = "2026-07-15T00:00:00.000Z";
const token = "automation-http-client-token-000000000000000001";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function loginResponse(capabilities: readonly string[]) {
  const headers = new Headers();
  headers.append("set-cookie", "geo_session=automation-session; Path=/; HttpOnly");
  headers.append("set-cookie", "geo_csrf=automation-csrf; Path=/");
  return json(
    {
      actor: { id: ids.actor, role: "owner", capabilities },
      tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
      csrfToken: "automation-csrf",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    { headers },
  );
}

function automationRun() {
  return {
    id: ids.run,
    batchId: ids.batch,
    campaignId: ids.campaign,
    brandId: ids.brand,
    executionLevel: "unattended",
    slotKey: "slot-1",
    topicKey: "topic-1",
    brief: "verified travel service",
    state: "running",
    stage: "planning",
    availableAt: timestamp,
    attemptCount: 1,
    maxAttempts: 5,
    leaseOwner: `${ids.actor}:producer-1`,
    leaseExpiresAt: "2026-07-15T00:01:00.000Z",
    heartbeatAt: timestamp,
    checkpoint: {},
    contentItemId: null,
    contentVersionId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    targets: [
      {
        id: ids.target,
        runId: ids.run,
        channelAccountId: ids.account,
        platform: "toutiao",
        state: "pending",
        variantId: null,
        auditRunId: null,
        auditArtifactId: null,
        publicationJobId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  } as const;
}

describe("automation HTTP API client", () => {
  it("uses the authenticated tenant session for every lease and checkpoint route", async () => {
    const requests: Array<{ path: string; method: string; body: unknown; headers: Headers }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        return loginResponse([
          "automation:execute",
          "tenant:read",
          "content:read",
          "content:write",
          "audit:run",
          "publish:request",
        ]);
      }
      const method = init?.method ?? "GET";
      requests.push({
        path: url.pathname,
        method,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      });
      if (url.pathname === "/api/automation-runs/claim") {
        return json({
          items: [
            {
              ...automationRun(),
              tenantGate: { allowed: true, evaluatedAt: timestamp },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/heartbeat") || url.pathname.endsWith("/draft-checkpoint")) {
        return json({ accepted: true, reason: "accepted", leaseExpiresAt: timestamp });
      }
      if (url.pathname.endsWith("/checkpoint")) {
        return json({ accepted: true, reason: "accepted", leaseExpiresAt: timestamp });
      }
      if (
        url.pathname.endsWith("/reconcile") ||
        url.pathname === `/api/automation-runs/${ids.run}`
      ) {
        return json(automationRun());
      }
      if (url.pathname === `/api/publication-jobs/${ids.job}`) {
        return json({
          id: ids.job,
          auditArtifactId: ids.audit,
          variantId: ids.variant,
          channelAccountId: ids.account,
          platform: "toutiao",
          executionLevel: "dry_run",
          state: "preview_completed",
          lastErrorCode: null,
          updatedAt: timestamp,
        });
      }
      return json({ error: { code: "UNEXPECTED_ROUTE" } }, { status: 500 });
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken: token,
            clientId: "automation-client",
            email: "automation@example.test",
            password: "automation-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.automationPrincipals())[0];
    if (principal === undefined) throw new Error("Expected an automation principal");
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    await api.claimAutomationRuns(principal, {
      producerId: "producer-1",
      limit: 1,
      leaseSeconds: 60,
    });
    await api.getAutomationRun(principal, ids.run);
    await api.heartbeatAutomationRun(principal, ids.run, {
      producerId: "producer-1",
      attempt: 1,
      stage: "planning",
      checkpoint: {},
      leaseSeconds: 60,
    });
    await api.checkpointAutomationDraft(principal, ids.run, {
      producerId: "producer-1",
      attempt: 1,
      contentItemId: ids.content,
      contentVersionId: ids.version,
      checkpoint: { stage: "draft" },
      leaseSeconds: 60,
    });
    await api.checkpointAutomationTarget(principal, ids.run, ids.target, {
      producerId: "producer-1",
      attempt: 1,
      state: "failed",
      errorCode: "TEST_FAILURE",
      checkpoint: { stage: "targets" },
      leaseSeconds: 60,
    });
    await api.reconcileAutomationRun(principal, ids.run, {
      producerId: "producer-1",
      attempt: 1,
      retryAfter: "2026-07-15T00:00:10.000Z",
      errorCode: "TEST_RETRY",
    });
    await api.getAutomationPublicationJob(principal, ids.job);

    expect(requests.map((request) => request.path)).toEqual([
      "/api/automation-runs/claim",
      `/api/automation-runs/${ids.run}`,
      `/api/automation-runs/${ids.run}/heartbeat`,
      `/api/automation-runs/${ids.run}/draft-checkpoint`,
      `/api/automation-runs/${ids.run}/targets/${ids.target}/checkpoint`,
      `/api/automation-runs/${ids.run}/reconcile`,
      `/api/publication-jobs/${ids.job}`,
    ]);
    expect(requests[0]?.body).toEqual({ producerId: "producer-1", limit: 1, leaseSeconds: 60 });
    for (const request of requests.filter((entry) => entry.method === "POST")) {
      expect(request.headers.get("cookie")).toContain("geo_session=automation-session");
      expect(request.headers.get("x-csrf-token")).toBe("automation-csrf");
    }
  });

  it("isolates failed login credentials and selects only automation-capable principals", async () => {
    const badToken = "automation-bad-client-token-00000000000000001";
    const viewerToken = "automation-viewer-token-0000000000000000001";
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { email: string };
      if (body.email === "bad@example.test") {
        return json({ error: { code: "LOGIN_FAILED" } }, { status: 401 });
      }
      return loginResponse(
        body.email === "viewer@example.test" ? ["tenant:read"] : ["automation:execute"],
      );
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken: badToken,
            clientId: "bad-client",
            email: "bad@example.test",
            password: "bad-password",
          },
          {
            accessToken: viewerToken,
            clientId: "viewer-client",
            email: "viewer@example.test",
            password: "viewer-password",
          },
          {
            accessToken: token,
            clientId: "automation-client",
            email: "automation@example.test",
            password: "automation-password",
          },
        ]),
      ),
      fetchImpl,
    });

    const principals = await sessions.automationPrincipals();
    expect(principals).toHaveLength(1);
    expect(principals[0]?.capabilities).toEqual(["automation:execute"]);
    expect(JSON.stringify(principals)).not.toContain("password");
    expect(JSON.stringify(principals)).not.toContain(token);
  });

  it("normalizes transport failures without exposing the underlying secret", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        return loginResponse(["automation:execute"]);
      }
      throw new Error("upstream password=must-never-leak");
    });
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials: parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken: token,
            clientId: "automation-client",
            email: "automation@example.test",
            password: "automation-password",
          },
        ]),
      ),
      fetchImpl,
    });
    const principal = (await sessions.automationPrincipals())[0];
    if (principal === undefined) throw new Error("Expected an automation principal");
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    let captured: unknown;
    try {
      await api.claimAutomationRuns(principal, {
        producerId: "producer-1",
        limit: 1,
        leaseSeconds: 60,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "GEO_API_TRANSPORT_FAILED", status: 503 });
    expect(String(captured)).not.toContain("must-never-leak");
  });
});
