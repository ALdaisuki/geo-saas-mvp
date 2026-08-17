import type { Platform } from "@geo/contracts";

import { ConnectorPolicyError } from "./capabilities.js";

export const OUTBOUND_IMPLEMENTATION_OPERATIONS = [
  "session_probe",
  "draft_write",
  "media_upload",
  "final_submit",
  "moderation_readback",
  "public_readback",
] as const;

export type OutboundImplementationOperation = (typeof OUTBOUND_IMPLEMENTATION_OPERATIONS)[number];

export type OutboundImplementationStage =
  "draft_only" | "submit_and_reconcile" | "confirmed_delivery";

export interface GitHubOutboundImplementationSource {
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly sourcePaths: readonly string[];
  readonly operations: readonly OutboundImplementationOperation[];
  readonly licenseSpdx: string | null;
}

export interface OutboundImplementationManifest {
  readonly schemaVersion: "geo.outbound-implementation-sources.v1";
  readonly platform: Platform;
  readonly adapterVersion: string;
  readonly stage: OutboundImplementationStage;
  readonly reviewedAt: string;
  readonly sources: readonly GitHubOutboundImplementationSource[];
}

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^?#]+$/u;
const SOURCE_PATH_MAX_LENGTH = 500;
const OPERATION_SET = new Set<string>(OUTBOUND_IMPLEMENTATION_OPERATIONS);
const OPERATIONS_BY_STAGE: Readonly<
  Record<OutboundImplementationStage, readonly OutboundImplementationOperation[]>
> = {
  draft_only: ["session_probe", "draft_write", "media_upload"],
  submit_and_reconcile: [
    "session_probe",
    "draft_write",
    "media_upload",
    "final_submit",
    "moderation_readback",
  ],
  confirmed_delivery: OUTBOUND_IMPLEMENTATION_OPERATIONS,
};

function fail(platform: Platform, message: string): never {
  throw new ConnectorPolicyError("OUTBOUND_SOURCE_EVIDENCE_REQUIRED", message, { platform });
}

function normalizedRepositoryUrl(value: string, platform: Platform): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(platform, "Outbound implementation source must use a valid GitHub repository URL");
  }
  const pathSegments = parsed.pathname
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    pathSegments.length !== 2
  ) {
    return fail(
      platform,
      "Outbound implementation source must be an HTTPS github.com owner/repository URL",
    );
  }
  return `https://github.com/${pathSegments[0]}/${pathSegments[1]}`;
}

function assertUnique(values: readonly string[], label: string, platform: Platform): void {
  if (new Set(values).size !== values.length) {
    fail(platform, `${label} must not contain duplicates`);
  }
}

function isExactRepositorySourcePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length <= SOURCE_PATH_MAX_LENGTH &&
    SOURCE_PATH_PATTERN.test(value) &&
    value.trim() === value &&
    !value.includes(String.fromCodePoint(0)) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function assertGitHubOutboundImplementationSources(
  manifest: OutboundImplementationManifest,
  requiredOperations: readonly OutboundImplementationOperation[],
): void {
  if (manifest.schemaVersion !== "geo.outbound-implementation-sources.v1") {
    fail(manifest.platform, "Outbound implementation source manifest version is unsupported");
  }
  if (!ADAPTER_VERSION_PATTERN.test(manifest.adapterVersion)) {
    fail(manifest.platform, "Outbound adapter version must be a bounded stable identifier");
  }
  if (!Number.isFinite(Date.parse(manifest.reviewedAt))) {
    fail(manifest.platform, "Outbound implementation sources require a valid review timestamp");
  }
  if (manifest.sources.length === 0 || manifest.sources.length > 20) {
    fail(
      manifest.platform,
      "Outbound implementation sources must contain between 1 and 20 entries",
    );
  }
  assertUnique(requiredOperations, "Required outbound operations", manifest.platform);
  for (const operation of requiredOperations) {
    if (!OPERATION_SET.has(operation)) {
      fail(manifest.platform, `Unsupported outbound implementation operation: ${operation}`);
    }
  }

  const coveredOperations = new Set<OutboundImplementationOperation>();
  const immutableReferences = new Set<string>();
  for (const source of manifest.sources) {
    const repositoryUrl = normalizedRepositoryUrl(source.repositoryUrl, manifest.platform);
    if (!COMMIT_SHA_PATTERN.test(source.commitSha)) {
      fail(
        manifest.platform,
        "Outbound implementation sources must pin a full lowercase commit SHA",
      );
    }
    if (source.sourcePaths.length === 0 || source.sourcePaths.length > 100) {
      fail(manifest.platform, "Each outbound implementation source requires bounded source paths");
    }
    assertUnique(source.sourcePaths, "Outbound implementation source paths", manifest.platform);
    for (const path of source.sourcePaths) {
      if (!isExactRepositorySourcePath(path)) {
        fail(manifest.platform, `Outbound implementation source path is unsafe: ${path}`);
      }
      const reference = `${repositoryUrl}/blob/${source.commitSha}/${path}`;
      if (immutableReferences.has(reference)) {
        fail(manifest.platform, `Duplicate immutable GitHub source reference: ${reference}`);
      }
      immutableReferences.add(reference);
    }
    if (source.operations.length === 0) {
      fail(
        manifest.platform,
        "Each outbound implementation source must cover an explicit operation",
      );
    }
    assertUnique(source.operations, "Outbound implementation operations", manifest.platform);
    for (const operation of source.operations) {
      if (!OPERATION_SET.has(operation)) {
        fail(manifest.platform, `Unsupported outbound implementation operation: ${operation}`);
      }
      coveredOperations.add(operation);
    }
    if (source.licenseSpdx !== null) {
      if (
        source.licenseSpdx.length === 0 ||
        source.licenseSpdx.length > 100 ||
        source.licenseSpdx.trim() !== source.licenseSpdx
      ) {
        fail(
          manifest.platform,
          "GitHub source license metadata must be null or a bounded SPDX value",
        );
      }
    }
  }

  const missing = requiredOperations.filter((operation) => !coveredOperations.has(operation));
  if (missing.length > 0) {
    fail(
      manifest.platform,
      `GitHub implementation sources do not cover required operations: ${missing.join(", ")}`,
    );
  }
}

export function immutableGitHubSourceReferences(
  manifest: OutboundImplementationManifest,
): readonly string[] {
  assertGitHubOutboundImplementationSources(manifest, []);
  return manifest.sources.flatMap((source) => {
    const repositoryUrl = normalizedRepositoryUrl(source.repositoryUrl, manifest.platform);
    return source.sourcePaths.map((path) => `${repositoryUrl}/blob/${source.commitSha}/${path}`);
  });
}

export function assertGitHubSourcedOutboundManifest(
  manifest: OutboundImplementationManifest,
): void {
  const operations = OPERATIONS_BY_STAGE[manifest.stage];
  if (operations === undefined) {
    fail(manifest.platform, "Outbound implementation stage is unsupported");
  }
  assertGitHubOutboundImplementationSources(manifest, operations);
}
