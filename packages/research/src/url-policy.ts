import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

import { ResearchCollectionError, type ResearchPolicy } from "./types.js";

export function validateResearchPolicy(policy: ResearchPolicy): void {
  if (
    policy.allowedHosts.length < 1 ||
    policy.allowedHosts.length > 50 ||
    policy.userAgent.length < 8 ||
    policy.userAgent.length > 256 ||
    /[\r\n]/u.test(policy.userAgent) ||
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 1_024 ||
    policy.maxBytes > 5_000_000 ||
    !Number.isSafeInteger(policy.robotsMaxBytes) ||
    policy.robotsMaxBytes < 1_024 ||
    policy.robotsMaxBytes > 1_000_000 ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 500 ||
    policy.timeoutMs > 30_000 ||
    !Number.isSafeInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > 5 ||
    !Number.isSafeInteger(policy.maxDiscoveredUrls) ||
    policy.maxDiscoveredUrls < 1 ||
    policy.maxDiscoveredUrls > 1_000
  ) {
    throw new ResearchCollectionError(
      "RESEARCH_POLICY_INVALID",
      "Research policy is outside the supported safety bounds",
    );
  }
}

function normalizedAllowedHosts(policy: ResearchPolicy): ReadonlySet<string> {
  if (policy.allowedHosts.length === 0) {
    throw new ResearchCollectionError(
      "RESEARCH_HOST_NOT_ALLOWED",
      "Research requires at least one explicit host",
    );
  }
  return new Set(
    policy.allowedHosts.map((host) => {
      const normalized = host.trim().toLocaleLowerCase("en-US").replace(/\.$/u, "");
      if (normalized.length === 0 || normalized.includes("*")) {
        throw new ResearchCollectionError(
          "RESEARCH_HOST_NOT_ALLOWED",
          "Research hosts must be explicit",
        );
      }
      return normalized;
    }),
  );
}

export function normalizeResearchUrl(value: string, policy: ResearchPolicy): URL {
  validateResearchPolicy(policy);
  if (value.length > 2_048) {
    throw new ResearchCollectionError("RESEARCH_URL_TOO_LONG", "Research URL is too long");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResearchCollectionError("RESEARCH_URL_INVALID", "Research URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new ResearchCollectionError(
      "RESEARCH_HTTPS_REQUIRED",
      "Research only permits HTTPS URLs",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ResearchCollectionError(
      "RESEARCH_URL_CREDENTIALS_FORBIDDEN",
      "Research URLs cannot contain credentials",
    );
  }
  if (url.port !== "" && url.port !== "443") {
    throw new ResearchCollectionError(
      "RESEARCH_PORT_FORBIDDEN",
      "Research only permits the standard HTTPS port",
    );
  }
  const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
  if (isIP(hostname) !== 0) {
    throw new ResearchCollectionError(
      "RESEARCH_IP_HOST_FORBIDDEN",
      "Research URLs must use an allowlisted DNS hostname",
    );
  }
  if (!normalizedAllowedHosts(policy).has(hostname)) {
    throw new ResearchCollectionError(
      "RESEARCH_HOST_NOT_ALLOWED",
      "Research URL host is not allowlisted",
    );
  }
  url.hostname = hostname;
  url.hash = "";
  if (url.port === "443") url.port = "";
  return url;
}

export function assertPublicAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) {
    throw new ResearchCollectionError("RESEARCH_DNS_FAILED", "Research host has no addresses");
  }
  for (const address of addresses) {
    try {
      if (ipaddr.process(address).range() !== "unicast") {
        throw new ResearchCollectionError(
          "RESEARCH_ADDRESS_FORBIDDEN",
          "Research host resolved to a non-public address",
        );
      }
    } catch (error) {
      if (error instanceof ResearchCollectionError) throw error;
      throw new ResearchCollectionError(
        "RESEARCH_ADDRESS_FORBIDDEN",
        "Research host resolved to an invalid address",
      );
    }
  }
}
