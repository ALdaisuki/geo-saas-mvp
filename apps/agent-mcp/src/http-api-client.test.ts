import type { ActorContext } from "@geo/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  GeoApiSessionRegistry,
  HttpInternalGeoApiClient,
  parseMcpPrincipalCredentials,
  validateGeoApiBaseUrl,
} from "./http-api-client.js";

const ids = {
  tenant: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  variant: "00000000-0000-4000-8000-000000000003",
  account: "00000000-0000-4000-8000-000000000004",
  artifact: "00000000-0000-4000-8000-000000000005",
  grant: "00000000-0000-4000-8000-000000000006",
  job: "00000000-0000-4000-8000-000000000007",
  outbox: "00000000-0000-4000-8000-000000000008",
};

const accessToken = "mcp-access-token-that-is-longer-than-thirty-two-bytes";
const grantToken = "publication-grant-token-that-never-enters-model-history";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe("GEO API session and destination policy", () => {
  it("rejects insecure remote API destinations and duplicate principal secrets", () => {
    expect(() => validateGeoApiBaseUrl("http://api.example.com")).toThrow(/HTTPS/);
    expect(() =>
      parseMcpPrincipalCredentials(
        JSON.stringify([
          {
            accessToken,
            clientId: "one",
            email: "one@example.test",
            password: "password-one",
          },
          {
            accessToken,
            clientId: "two",
            email: "two@example.test",
            password: "password-two",
          },
        ]),
      ),
    ).toThrow(/unique/);
  });

  it("keeps publication grant credentials internal and consumes them once", async () => {
    let publicationBody: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/login") {
        const headers = new Headers();
        headers.append("set-cookie", "geo_session=session-value; Path=/; HttpOnly");
        headers.append("set-cookie", "geo_csrf=csrf-value; Path=/");
        return jsonResponse(
          {
            actor: {
              id: ids.actor,
              role: "owner",
              capabilities: ["tenant:read", "audit:run", "publish:request"],
            },
            tenant: { id: ids.tenant, slug: "tenant", displayName: "Tenant" },
            csrfToken: "csrf-value",
            expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          },
          { headers },
        );
      }
      if (url.pathname === `/api/variants/${ids.variant}/audits`) {
        return jsonResponse({
          artifact: {
            id: ids.artifact,
            status: "passed",
            channelAccountId: ids.account,
            findings: [],
          },
          publicationAuthorization: {
            grantId: ids.grant,
            token: grantToken,
            expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          },
        });
      }
      if (url.pathname === "/api/publication-requests") {
        publicationBody = JSON.parse(String(init?.body));
        return jsonResponse({
          publicationJobId: ids.job,
          publicationOutboxEventId: ids.outbox,
          wasCreated: true,
        });
      }
      return jsonResponse({ error: { code: "UNEXPECTED_TEST_ROUTE" } }, { status: 500 });
    });
    const credentials = parseMcpPrincipalCredentials(
      JSON.stringify([
        {
          accessToken,
          clientId: "test-client",
          email: "owner@example.test",
          password: "test-password",
        },
      ]),
    );
    const sessions = new GeoApiSessionRegistry({
      baseUrl: "http://127.0.0.1:4100",
      credentials,
      fetchImpl,
    });
    const authenticated = await sessions.authenticateBearer(`Bearer ${accessToken}`, "request-1");
    const principal: ActorContext = authenticated.principal;
    const api = new HttpInternalGeoApiClient({ sessions, fetchImpl });

    const audit = await api.requestAudit(principal, {
      variantId: ids.variant,
      idempotencyKey: "audit-once",
    });
    expect(JSON.stringify(audit)).not.toContain(grantToken);
    expect(audit).toMatchObject({ eligibleForPublicationRequest: true });

    const publication = await api.requestPublication(principal, {
      variantId: ids.variant,
      channelAccountId: ids.account,
      executionLevel: "dry_run",
      idempotencyKey: "publish-once",
    });
    expect(publication).toMatchObject({ publicationJobId: ids.job, wasCreated: true });
    expect(publicationBody).toMatchObject({ grantId: ids.grant, token: grantToken });
    await expect(
      api.requestPublication(principal, {
        variantId: ids.variant,
        channelAccountId: ids.account,
        executionLevel: "dry_run",
        idempotencyKey: "publish-twice",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_GRANT_NOT_AVAILABLE" });
  });
});
