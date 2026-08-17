import { describe, expect, it } from "vitest";

import {
  assertGitHubOutboundImplementationSources,
  immutableGitHubSourceReferences,
  type OutboundImplementationManifest,
} from "./outbound-source-provenance.js";
import type { ConnectorPolicyError } from "./capabilities.js";

const publisherSource = {
  repositoryUrl: "https://github.com/example/mature-publisher.git",
  commitSha: "a".repeat(40),
  sourcePaths: ["src/toutiao/session.py", "src/toutiao/editor.py"],
  operations: ["session_probe", "draft_write", "media_upload", "final_submit"],
  licenseSpdx: null,
} as const;

const readbackSource = {
  repositoryUrl: "https://github.com/example/readback",
  commitSha: "b".repeat(40),
  sourcePaths: ["platforms/toutiao/readback.ts"],
  operations: ["moderation_readback", "public_readback"],
  licenseSpdx: "MIT",
} as const;

const manifest: OutboundImplementationManifest = {
  schemaVersion: "geo.outbound-implementation-sources.v1",
  platform: "toutiao",
  adapterVersion: "toutiao-browser-v1",
  stage: "confirmed_delivery",
  reviewedAt: "2026-08-03T00:00:00.000Z",
  sources: [publisherSource, readbackSource],
};

describe("GitHub outbound implementation provenance", () => {
  it("accepts full operation coverage and returns immutable blob references", () => {
    expect(() =>
      assertGitHubOutboundImplementationSources(manifest, [
        "session_probe",
        "draft_write",
        "media_upload",
        "final_submit",
        "moderation_readback",
        "public_readback",
      ]),
    ).not.toThrow();

    expect(immutableGitHubSourceReferences(manifest)).toEqual([
      `https://github.com/example/mature-publisher/blob/${"a".repeat(40)}/src/toutiao/session.py`,
      `https://github.com/example/mature-publisher/blob/${"a".repeat(40)}/src/toutiao/editor.py`,
      `https://github.com/example/readback/blob/${"b".repeat(40)}/platforms/toutiao/readback.ts`,
    ]);
  });

  it.each([
    {
      name: "non-GitHub host",
      value: {
        ...manifest,
        sources: [{ ...publisherSource, repositoryUrl: "https://gitlab.com/example/repo" }],
      },
    },
    {
      name: "moving branch",
      value: {
        ...manifest,
        sources: [{ ...publisherSource, commitSha: "main" }],
      },
    },
    {
      name: "unsafe path",
      value: {
        ...manifest,
        sources: [{ ...publisherSource, sourcePaths: ["../publisher.ts"] }],
      },
    },
    {
      name: "directory rather than exact source path",
      value: {
        ...manifest,
        sources: [{ ...publisherSource, sourcePaths: ["src/toutiao/"] }],
      },
    },
    {
      name: "non-canonical source path",
      value: {
        ...manifest,
        sources: [{ ...publisherSource, sourcePaths: ["src//toutiao/editor.py"] }],
      },
    },
  ])("rejects $name source evidence", ({ value }) => {
    expect(() => assertGitHubOutboundImplementationSources(value, ["session_probe"])).toThrowError(
      expect.objectContaining<Partial<ConnectorPolicyError>>({
        code: "OUTBOUND_SOURCE_EVIDENCE_REQUIRED",
        platform: "toutiao",
      }),
    );
  });

  it("fails closed when a required outward operation has no source", () => {
    expect(() =>
      assertGitHubOutboundImplementationSources(manifest, [
        "session_probe",
        "draft_write",
        "public_readback",
        "final_submit",
      ]),
    ).not.toThrow();

    const withoutPublicReadback: OutboundImplementationManifest = {
      ...manifest,
      sources: [publisherSource],
    };
    expect(() =>
      assertGitHubOutboundImplementationSources(withoutPublicReadback, ["public_readback"]),
    ).toThrow(/do not cover required operations: public_readback/iu);
  });
});
