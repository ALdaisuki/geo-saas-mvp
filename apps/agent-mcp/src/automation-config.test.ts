import { describe, expect, it } from "vitest";

import { readAutomationProducerConfig } from "./automation-config.js";

describe("automation producer configuration", () => {
  it("is fail-closed and disabled by default", () => {
    expect(readAutomationProducerConfig({})).toMatchObject({
      enabled: false,
      concurrency: 1,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      draftTimeoutMs: 600_000,
    });
  });

  it("requires an explicit enable and validates lease timing", () => {
    expect(
      readAutomationProducerConfig({
        AUTOMATION_PRODUCER_ENABLED: "true",
        AUTOMATION_PRODUCER_ID: "producer-cn-1",
        AUTOMATION_PRODUCER_CONCURRENCY: "3",
        AUTOMATION_PRODUCER_LEASE_DURATION_MS: "120000",
        AUTOMATION_PRODUCER_HEARTBEAT_INTERVAL_MS: "30000",
        AUTOMATION_DRAFT_TIMEOUT_MS: "420000",
      }),
    ).toMatchObject({
      enabled: true,
      producerId: "producer-cn-1",
      concurrency: 3,
      draftTimeoutMs: 420_000,
    });
    expect(() =>
      readAutomationProducerConfig({
        AUTOMATION_PRODUCER_LEASE_DURATION_MS: "10000",
        AUTOMATION_PRODUCER_HEARTBEAT_INTERVAL_MS: "10000",
      }),
    ).toThrow(/shorter/);
    expect(() => readAutomationProducerConfig({ AUTOMATION_DRAFT_TIMEOUT_MS: "999" })).toThrow(
      /between 1000 and 900000/,
    );
  });

  it("rejects ambiguous switches and invalid producer IDs", () => {
    expect(() => readAutomationProducerConfig({ AUTOMATION_PRODUCER_ENABLED: "yes" })).toThrow(
      /true, false/,
    );
    expect(() =>
      readAutomationProducerConfig({ AUTOMATION_PRODUCER_ID: "bad producer id" }),
    ).toThrow(/invalid/);
  });
});
