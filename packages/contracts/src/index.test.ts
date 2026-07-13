import { describe, expect, it } from "vitest";

import {
  connectorCapabilityReportSchema,
  publicationReceiptSchema,
  publicationVariantPayloadSchema,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

describe("publication contracts", () => {
  it("keeps dry-run evidence visibly separate from a confirmed live publication", () => {
    const receipt = publicationReceiptSchema.parse({
      id,
      tenantId: id,
      jobId: id,
      attemptId: id,
      platform: "toutiao",
      executionLevel: "dry_run",
      evidenceType: "preview",
      requestHash: hash,
      responseHash: hash,
      externalId: null,
      externalUrl: null,
      publishedAt: null,
      recordedAt: "2026-07-13T12:00:00.000Z",
      confirmed: false,
    });

    expect(receipt.confirmed).toBe(false);
    expect(receipt.externalUrl).toBeNull();
  });

  it("requires a reason and evidence type for connector capability reports", () => {
    expect(() =>
      connectorCapabilityReportSchema.parse({
        platform: "sohu",
        capability: "manual_only",
        supportedExecutionLevels: ["dry_run", "assisted"],
        checkedAt: "2026-07-13T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects empty publication variants", () => {
    expect(() =>
      publicationVariantPayloadSchema.parse({
        title: "",
        summary: "",
        bodyMarkdown: "",
      }),
    ).toThrow();
  });
});
