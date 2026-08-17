import { describe, expect, it } from "vitest";

import {
  automationDateTimeInput,
  formatAutomationDateTime,
  localAutomationDateTime,
  parseAutomationDateTime,
} from "./automation-clock.js";

describe("automation operational clock", () => {
  it("keeps scheduling and display on the server time represented in Shanghai", () => {
    const runtimeNow = Date.parse("2026-08-06T23:15:30.000Z");

    expect(localAutomationDateTime(2, runtimeNow)).toBe("2026-08-07T07:18");
    expect(automationDateTimeInput(new Date(runtimeNow))).toBe("2026-08-07T07:15");
    expect(parseAutomationDateTime("2026-08-07T07:18")).toBe(
      Date.parse("2026-08-06T23:18:00.000Z"),
    );
    expect(formatAutomationDateTime("2026-08-06T23:18:00.000Z")).toContain("08/07 07:18:00");
  });
});
