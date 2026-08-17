import { PRIMARY_DISTRIBUTION_PLATFORMS } from "@geo/contracts";
import { describe, expect, it } from "vitest";

import {
  assertGitHubOutboundImplementationSources,
  immutableGitHubSourceReferences,
  type OutboundImplementationManifest,
} from "./outbound-source-provenance.js";
import {
  DEFERRED_PRIORITY_PLATFORM_OPERATIONS,
  getPriorityPlatformSourceReference,
  PRIORITY_PLATFORM_DRAFT_OPERATIONS,
  PRIORITY_PLATFORM_SOURCE_CATALOG,
} from "./priority-platform-source-catalog.js";

describe("priority platform GitHub source catalog", () => {
  it("lists one reference-only entry for every priority platform", () => {
    expect(PRIORITY_PLATFORM_SOURCE_CATALOG.map(({ platform }) => platform)).toEqual(
      PRIMARY_DISTRIBUTION_PLATFORMS,
    );
    expect(
      PRIORITY_PLATFORM_SOURCE_CATALOG.every(({ status }) => status === "reference_only"),
    ).toBe(true);
  });

  it.each(PRIMARY_DISTRIBUTION_PLATFORMS)(
    "%s pins GitHub sources for session, draft and media behavior",
    (platform) => {
      const reference = getPriorityPlatformSourceReference(platform);
      const draftManifest: OutboundImplementationManifest = {
        schemaVersion: "geo.outbound-implementation-sources.v1",
        platform,
        adapterVersion: `${platform}-reference-check`,
        stage: "draft_only",
        reviewedAt: reference.reviewedAt,
        sources: reference.sources,
      };

      expect(() =>
        assertGitHubOutboundImplementationSources(
          draftManifest,
          PRIORITY_PLATFORM_DRAFT_OPERATIONS,
        ),
      ).not.toThrow();
      expect(reference.deferredOperations).toEqual(DEFERRED_PRIORITY_PLATFORM_OPERATIONS);
      expect(reference.sources.flatMap(({ operations }) => operations)).not.toContain(
        "final_submit",
      );
      expect(immutableGitHubSourceReferences(draftManifest)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[a-f0-9]{40}\//u),
        ]),
      );
    },
  );

  it("pins Baijiahao media behavior to the reviewed iframe-drop publisher", () => {
    const reference = getPriorityPlatformSourceReference("baijiahao");

    expect(reference.sources).toContainEqual({
      repositoryUrl: "https://github.com/xiaohao80/baijiahao-auto-publisher",
      commitSha: "e6eea968bb495f2a9156998f6ef4b777f143c4b0",
      sourcePaths: ["baijiahao_publisher.py"],
      operations: ["session_probe", "draft_write", "media_upload"],
      licenseSpdx: null,
    });
    expect(reference.sources.map(({ repositoryUrl }) => repositoryUrl)).not.toContain(
      "https://github.com/xiaohe4966/baijiahao-publisher",
    );
  });
});
