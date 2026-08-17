import { capabilitiesForRole } from "@geo/authz";
import { MEMBER_MODULE_IDS } from "@geo/contracts";
import type { ActorContext } from "@geo/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PasswordService } from "./app.js";
import type {
  ApiRepository,
  CreateSessionInput,
  LoginIdentity,
  ResolveSessionInput,
} from "./repository.js";
import type {
  PersistTrendObservationInput,
  PersistedTrendObservation,
  TrendObservationPersistResult,
  TrendRepository,
} from "./trend-repository.js";
import { TrendService } from "./trend-service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000101";
const now = new Date("2026-08-03T12:00:00.000Z");

class InMemoryTrendRepository implements TrendRepository {
  readonly rows: PersistedTrendObservation[] = [];

  async persistObservations(
    context: Readonly<ActorContext>,
    inputs: readonly Readonly<PersistTrendObservationInput>[],
  ): Promise<readonly TrendObservationPersistResult[]> {
    return inputs.map((input) => {
      const existing = this.rows.find(
        (row) =>
          row.tenantId === context.tenantId &&
          row.sourceKey === input.sourceKey &&
          row.observationKey === input.observationKey,
      );
      if (existing !== undefined) return { observation: existing, wasCreated: false };
      const observation = {
        ...input,
        tenantId: context.tenantId,
        ingestedByActorId: context.actorId,
        firstObservedAt: input.observedAt,
      };
      this.rows.push(observation);
      return { observation, wasCreated: true };
    });
  }

  async listObservations(
    context: Readonly<ActorContext>,
    input: { readonly observedAfter: string; readonly sourceKey?: string; readonly limit: number },
  ): Promise<readonly PersistedTrendObservation[]> {
    return this.rows
      .filter((row) => row.tenantId === context.tenantId)
      .filter((row) => Date.parse(row.observedAt) >= Date.parse(input.observedAfter))
      .filter((row) => input.sourceKey === undefined || row.sourceKey === input.sourceKey)
      .slice(0, input.limit);
  }
}

const identity: LoginIdentity = {
  userId: actorId,
  email: "operator@example.test",
  passwordHash: "correct-hash",
  displayName: "Trend Operator",
  status: "active",
  memberships: [
    {
      tenantId,
      tenantSlug: "sampleTravel",
      tenantDisplayName: "Sample travel tenant",
      tenantStatus: "active",
      role: "admin",
      capabilities: capabilitiesForRole("admin"),
      enabledModules: MEMBER_MODULE_IDS,
      membershipStatus: "active",
    },
  ],
};

function apiRepository(): ApiRepository {
  const sessions = new Map<string, CreateSessionInput>();
  return {
    isReady: async () => true,
    findLoginIdentity: async () => identity,
    findLoginIdentityByUserId: async () => identity,
    createSession: async (input: CreateSessionInput) => {
      sessions.set(input.sessionId, input);
    },
    resolveSession: async (input: ResolveSessionInput) => {
      const session = sessions.get(input.sessionId);
      if (session === undefined || session.tokenHash !== input.tokenHash) return null;
      return {
        sessionId: session.sessionId,
        userId: actorId,
        userDisplayName: identity.displayName,
        tenantId,
        tenantSlug: "sampleTravel",
        tenantDisplayName: "Sample travel tenant",
        role: "admin",
        capabilities: capabilitiesForRole("admin"),
        enabledModules: MEMBER_MODULE_IDS,
        csrfHash: session.csrfHash,
        expiresAt: session.expiresAt,
      };
    },
    revokeSession: async () => undefined,
  } as unknown as ApiRepository;
}

const passwordService: PasswordService = {
  hash: async () => "dummy-hash",
  verify: async (hash, password) => hash === "correct-hash" && password === "correct-password",
};

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

async function appFixture() {
  let sequence = 0;
  const trends = new InMemoryTrendRepository();
  const app = await buildApp({
    repository: apiRepository(),
    sessionSecret: "trend-api-test-secret-with-at-least-32-bytes",
    cookieSecure: false,
    passwordService,
    dummyPasswordHash: "dummy-hash",
    now: () => new Date(now),
    uuid: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    randomToken: () => "trend-api-csrf-token-with-sufficient-length",
    publicationGovernanceGate: {
      evaluate: async () => ({ allowed: true, reason: "test", evidence: {} }),
    },
    trendController: new TrendService({
      repository: trends,
      now: () => new Date(now),
      uuid: () => `80000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    }),
  });
  apps.push(app);
  return { app, trends };
}

function cookies(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Trend HTTP API", () => {
  it("ingests observations and exposes tenant-scoped topic candidates", async () => {
    const fixture = await appFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: identity.email,
        password: "correct-password",
        tenantSlug: "sampleTravel",
      },
    });
    const session = login.json<{ csrfToken: string }>();
    const cookie = cookies(login.headers);

    const ingest = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      headers: { cookie, "x-csrf-token": session.csrfToken },
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            sourceRank: 1,
            observedAt: "2026-08-03T11:55:00.000Z",
          },
          {
            sourceKey: "weibo",
            title: "云南旅游线路推荐！",
            sourceRank: 2,
            observedAt: "2026-08-03T11:58:00.000Z",
          },
        ],
      },
    });
    expect(ingest.statusCode).toBe(201);
    expect(ingest.json()).toMatchObject({
      createdCount: 2,
      replayedCount: 0,
      items: [{ sourceKey: "toutiao" }, { sourceKey: "weibo" }],
    });
    expect(ingest.json()).not.toHaveProperty("candidates");
    expect(fixture.trends.rows.every((row) => row.tenantId === tenantId)).toBe(true);

    const candidates = await fixture.app.inject({
      method: "GET",
      url: "/api/trends/topic-candidates?limit=10&lookbackMinutes=1440",
      headers: { cookie },
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toMatchObject({
      items: [{ normalizedTitle: "云南旅游线路推荐", sourceCount: 2 }],
      lookbackMinutes: 1_440,
    });
  });

  it("requires authentication and CSRF before accepting an observation", async () => {
    const fixture = await appFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(fixture.trends.rows).toEqual([]);

    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: identity.email, password: "correct-password", tenantSlug: "sampleTravel" },
    });
    const missingCsrf = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      headers: { cookie: cookies(login.headers) },
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(fixture.trends.rows).toEqual([]);
  });

  it("rejects unsafe canonical URLs and future source timestamps", async () => {
    const fixture = await appFixture();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: identity.email, password: "correct-password", tenantSlug: "sampleTravel" },
    });
    const session = login.json<{ csrfToken: string }>();
    const headers = {
      cookie: cookies(login.headers),
      "x-csrf-token": session.csrfToken,
    };

    const unsafeUrl = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      headers,
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            canonicalUrl: "http://127.0.0.1/private",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      },
    });
    expect(unsafeUrl.statusCode).toBe(400);
    expect(unsafeUrl.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const privateHttpsUrl = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      headers,
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            canonicalUrl: "https://127.0.0.1/private",
            observedAt: "2026-08-03T11:55:00.000Z",
          },
        ],
      },
    });
    expect(privateHttpsUrl.statusCode).toBe(422);
    expect(privateHttpsUrl.json()).toMatchObject({
      error: { code: "TREND_SOURCE_URL_NOT_ALLOWED" },
    });

    const future = await fixture.app.inject({
      method: "POST",
      url: "/api/trends/observations",
      headers,
      payload: {
        observations: [
          {
            sourceKey: "toutiao",
            title: "云南旅游线路推荐",
            observedAt: "2026-08-03T12:06:00.000Z",
          },
        ],
      },
    });
    expect(future.statusCode).toBe(422);
    expect(future.json()).toMatchObject({ error: { code: "TREND_TIMESTAMP_INVALID" } });
    expect(fixture.trends.rows).toEqual([]);
  });

  it("publishes both trend routes in the API document", async () => {
    const fixture = await appFixture();
    const response = await fixture.app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(document.paths).toHaveProperty("/api/trends/observations");
    expect(document.paths).toHaveProperty("/api/trends/topic-candidates");
  });
});
