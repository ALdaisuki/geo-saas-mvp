import { ctripPublicContentHash } from "@geo/core";
import { describe, expect, it } from "vitest";

import {
  canonicalCtripPublicArticleUrl,
  historicalPublicationBindingRequestHash,
  loadHistoricalPublicationDatabaseUrl,
  normalizeHistoricalPublicationBinding,
} from "../src/historical-publication.js";

const externalId = "123450001";
const title = "  Cafe\u0301 route  ";
const body = " First\r\n\tSecond ";

function manifest() {
  return {
    schemaVersion: "geo.historical-publication-binding.v1",
    tenantId: "00000000-0000-4000-8000-000000000001",
    actorId: "00000000-0000-4000-8000-000000000002",
    channelAccountId: "00000000-0000-4000-8000-000000000003",
    platform: "ctrip_community",
    idempotencyKey: "history:ctrip:123450001:v1",
    externalId,
    externalUrl: canonicalCtripPublicArticleUrl(externalId),
    title,
    body,
    publicContentHash: ctripPublicContentHash(title, body),
    publishedAt: "2026-07-20T02:00:00.000Z",
    observedAt: "2026-07-20T03:00:00.000Z",
    evidence: {
      sha256: "a".repeat(64),
      reference: "offline-capture:ctrip-history-001",
    },
  };
}

describe("historical publication binding contract", () => {
  it("normalizes an offline manifest and creates a deterministic request hash", () => {
    const first = normalizeHistoricalPublicationBinding(
      manifest(),
      new Date("2026-07-20T04:00:00.000Z"),
    );
    const second = normalizeHistoricalPublicationBinding(
      { ...manifest(), title: "Caf\u00e9 route", body: "First Second" },
      new Date("2026-07-20T04:00:00.000Z"),
    );

    expect(first.normalizedTitle).toBe("Caf\u00e9 route");
    expect(first.normalizedBody).toBe("First Second");
    expect(historicalPublicationBindingRequestHash(first)).toBe(
      historicalPublicationBindingRequestHash(second),
    );
  });

  it("fails closed on content-hash, URL, timestamp, and schema ambiguity", () => {
    const now = new Date("2026-07-20T04:00:00.000Z");
    expect(() =>
      normalizeHistoricalPublicationBinding(
        { ...manifest(), publicContentHash: "b".repeat(64) },
        now,
      ),
    ).toThrow(/does not match/iu);
    expect(() =>
      normalizeHistoricalPublicationBinding(
        { ...manifest(), externalUrl: `${canonicalCtripPublicArticleUrl(externalId)}&from=test` },
        now,
      ),
    ).toThrow(/canonical public Ctrip URL/iu);
    expect(() =>
      normalizeHistoricalPublicationBinding(
        { ...manifest(), publishedAt: "2026-07-20T03:00:01.000Z" },
        now,
      ),
    ).toThrow(/publishedAt cannot be later/iu);
    expect(() =>
      normalizeHistoricalPublicationBinding({ ...manifest(), observedAt: "2026-07-20" }, now),
    ).toThrow(/canonical UTC/iu);
    expect(() =>
      normalizeHistoricalPublicationBinding({ ...manifest(), unexpected: true }, now),
    ).toThrow(/keys are invalid/iu);
  });

  it("requires an explicit PostgreSQL admin connection without exposing a default", () => {
    expect(() => loadHistoricalPublicationDatabaseUrl({})).toThrow(
      "DATABASE_ADMIN_URL is required",
    );
    expect(() =>
      loadHistoricalPublicationDatabaseUrl({ DATABASE_ADMIN_URL: "https://db.example.test" }),
    ).toThrow("must be a PostgreSQL URL");
    const malformedSecret = "must-not-appear-in-the-error";
    try {
      loadHistoricalPublicationDatabaseUrl({
        DATABASE_ADMIN_URL: `postgresql://admin:${malformedSecret}@[invalid/database`,
      });
      throw new Error("expected malformed database URL rejection");
    } catch (error) {
      expect(String(error)).toContain("DATABASE_ADMIN_URL must be a valid PostgreSQL URL");
      expect(String(error)).not.toContain(malformedSecret);
    }
    expect(
      loadHistoricalPublicationDatabaseUrl({
        DATABASE_ADMIN_URL: "postgresql://operator@127.0.0.1/geo",
      }),
    ).toBe("postgresql://operator@127.0.0.1/geo");
  });
});
