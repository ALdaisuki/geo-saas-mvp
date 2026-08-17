import type { PRIMARY_DISTRIBUTION_PLATFORMS } from "@geo/contracts";

import type {
  GitHubOutboundImplementationSource,
  OutboundImplementationOperation,
} from "./outbound-source-provenance.js";

export type PriorityDistributionPlatform = (typeof PRIMARY_DISTRIBUTION_PLATFORMS)[number];

export const PRIORITY_PLATFORM_DRAFT_OPERATIONS = [
  "session_probe",
  "draft_write",
  "media_upload",
] as const satisfies readonly OutboundImplementationOperation[];

export const DEFERRED_PRIORITY_PLATFORM_OPERATIONS = [
  "final_submit",
  "moderation_readback",
  "public_readback",
] as const satisfies readonly OutboundImplementationOperation[];

/**
 * A source reference is research input for an adapter, not an enabled connector manifest.
 * Promotion still requires an implemented connector and an authenticated platform check.
 */
export interface PriorityPlatformSourceReference {
  readonly schemaVersion: "geo.priority-platform-source-reference.v1";
  readonly platform: PriorityDistributionPlatform;
  readonly status: "reference_only";
  readonly reviewedAt: string;
  readonly sources: readonly GitHubOutboundImplementationSource[];
  readonly deferredOperations: typeof DEFERRED_PRIORITY_PLATFORM_OPERATIONS;
  readonly blockers: readonly string[];
}

export const PRIORITY_PLATFORM_SOURCE_CATALOG = [
  {
    schemaVersion: "geo.priority-platform-source-reference.v1",
    platform: "toutiao",
    status: "reference_only",
    reviewedAt: "2026-08-03T00:00:00.000Z",
    sources: [
      {
        repositoryUrl: "https://github.com/guanyang/super-publisher",
        commitSha: "ee7466c6a83f1c9af520410849f40bb2c92ba08a",
        sourcePaths: [
          "skills/toutiao-publisher/scripts/auth_manager.py",
          "skills/toutiao-publisher/scripts/publisher.py",
        ],
        operations: ["session_probe", "draft_write", "media_upload"],
        licenseSpdx: "MIT",
      },
    ],
    deferredOperations: DEFERRED_PRIORITY_PLATFORM_OPERATIONS,
    blockers: [
      "Authenticated canary evidence has not yet bound the account, payload hash and remote article identity.",
      "Creator-center status is not an independent public readback.",
    ],
  },
  {
    schemaVersion: "geo.priority-platform-source-reference.v1",
    platform: "sohu",
    status: "reference_only",
    reviewedAt: "2026-08-03T00:00:00.000Z",
    sources: [
      {
        repositoryUrl: "https://github.com/doocs/cose",
        commitSha: "e70fa9e92a71cd2f10e0c883981f324a332162d4",
        sourcePaths: ["packages/detection/src/platforms/sohu.js"],
        operations: ["session_probe"],
        licenseSpdx: "Apache-2.0",
      },
      {
        repositoryUrl: "https://github.com/leaperone/MultiPost-Extension",
        commitSha: "4d9714a1f9132eadc7071b3977e9b4acf76d7c28",
        sourcePaths: ["src/sync/article/sohu.ts"],
        operations: ["draft_write", "media_upload"],
        licenseSpdx: "Apache-2.0",
      },
    ],
    deferredOperations: DEFERRED_PRIORITY_PLATFORM_OPERATIONS,
    blockers: [
      "The draft flow is experimental and still needs an authenticated surface check.",
      "No reviewed moderation reader or account-bound public readback is available.",
    ],
  },
  {
    schemaVersion: "geo.priority-platform-source-reference.v1",
    platform: "baijiahao",
    status: "reference_only",
    reviewedAt: "2026-08-03T00:00:00.000Z",
    sources: [
      {
        repositoryUrl: "https://github.com/xiaohao80/baijiahao-auto-publisher",
        commitSha: "e6eea968bb495f2a9156998f6ef4b777f143c4b0",
        sourcePaths: ["baijiahao_publisher.py"],
        operations: ["session_probe", "draft_write", "media_upload"],
        licenseSpdx: null,
      },
    ],
    deferredOperations: DEFERRED_PRIORITY_PLATFORM_OPERATIONS,
    blockers: [
      "The reference treats an in-review state as success and that result logic cannot be reused.",
      "Moderation and public identity still lack an independent account-bound match.",
    ],
  },
  {
    schemaVersion: "geo.priority-platform-source-reference.v1",
    platform: "netease",
    status: "reference_only",
    reviewedAt: "2026-08-03T00:00:00.000Z",
    sources: [
      {
        repositoryUrl: "https://github.com/doocs/cose",
        commitSha: "e70fa9e92a71cd2f10e0c883981f324a332162d4",
        sourcePaths: ["packages/detection/src/platforms/wangyihao.js"],
        operations: ["session_probe"],
        licenseSpdx: "Apache-2.0",
      },
      {
        repositoryUrl: "https://github.com/RyanYipeng/SyncCaster",
        commitSha: "ddad3c27e3f6a18537a72bc81a7b7bf9075e6efe",
        sourcePaths: ["packages/adapters/src/wangyihao.ts"],
        operations: ["draft_write", "media_upload"],
        licenseSpdx: "MIT",
      },
    ],
    deferredOperations: DEFERRED_PRIORITY_PLATFORM_OPERATIONS,
    blockers: [
      "The reference intentionally stops before final publication.",
      "No reviewed moderation reader or remote ID and URL reconciliation is available.",
    ],
  },
] as const satisfies readonly PriorityPlatformSourceReference[];

export function getPriorityPlatformSourceReference(
  platform: PriorityDistributionPlatform,
): PriorityPlatformSourceReference {
  const reference = PRIORITY_PLATFORM_SOURCE_CATALOG.find(
    (candidate) => candidate.platform === platform,
  );
  if (reference === undefined) {
    throw new TypeError(`No priority-platform source reference for ${platform}`);
  }
  return reference;
}
