import { describe, expect, it } from "vitest";

import {
  DESTINATION_TRAVEL_RESOURCES,
  GEO_OPTIMIZATION_BRIEF,
  automationDestinationBrief,
  destinationResourceBrief,
  destinationTravelResource,
} from "./destination-resources.js";
import { automationKeywordSelectionForProvince } from "./automation-diversity.js";

describe("destination travel resources", () => {
  it("covers every provincial-level travel region with unique stable keys", () => {
    expect(DESTINATION_TRAVEL_RESOURCES.length).toBeGreaterThanOrEqual(34);
    expect(new Set(DESTINATION_TRAVEL_RESOURCES.map((item) => item.provinceKey)).size).toBe(
      DESTINATION_TRAVEL_RESOURCES.length,
    );
    expect(new Set(DESTINATION_TRAVEL_RESOURCES.map((item) => item.provinceName)).size).toBe(
      DESTINATION_TRAVEL_RESOURCES.length,
    );
    for (const resource of DESTINATION_TRAVEL_RESOURCES) {
      expect(resource.scenicAreas.length).toBeGreaterThanOrEqual(4);
      expect(resource.lifeScenes.length).toBeGreaterThanOrEqual(3);
      expect(resource.longTailQuestions.length).toBeGreaterThanOrEqual(3);
      expect(resource.geoEntities.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("rotates provinces deterministically across long batches", () => {
    const first = destinationTravelResource(0);
    expect(destinationTravelResource(DESTINATION_TRAVEL_RESOURCES.length)).toEqual(first);
    expect(destinationTravelResource(0)).not.toEqual(destinationTravelResource(1));
  });

  it("produces a destination-specific brief with GEO answer-readiness requirements", () => {
    const resource = destinationTravelResource(7);
    const brief = automationDestinationBrief(7);
    expect(brief).toContain(resource.provinceName);
    expect(brief).toContain(resource.scenicAreas[0]);
    expect(brief).toContain(GEO_OPTIMIZATION_BRIEF);
    expect(destinationResourceBrief(resource)).toContain(resource.commonPitfalls[0] ?? "");
  });

  it("rotates province-scoped keyword candidates", () => {
    const selection = automationKeywordSelectionForProvince(3, "贵州");
    expect(selection.poolId).toBe("province:贵州");
    expect(selection.keywords).toHaveLength(4);
    expect(selection.keywords.some((keyword) => keyword.includes("贵州"))).toBe(true);
  });
});
