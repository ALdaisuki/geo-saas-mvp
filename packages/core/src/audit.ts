import type {
  AuditArtifact,
  AuditFinding,
  AuditStatus,
  Platform,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";

import { sha256Canonical } from "./canonical.js";
import { invariant } from "./errors.js";
import { assertSha256, assertUuid, freezeDeep, parseInstant } from "./validation.js";

export interface EvidenceSource {
  readonly id: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly observedAt: string;
  readonly validUntil: string | null;
}

export interface VerifiedFact {
  readonly id: string;
  readonly brandId: string;
  readonly text: string;
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface FactSnapshot {
  readonly tenantId: string;
  readonly capturedAt: string;
  readonly facts: readonly VerifiedFact[];
  readonly sources: readonly EvidenceSource[];
}

export interface PlatformAuditLimits {
  readonly maxTitleCharacters: number;
  readonly maxSummaryCharacters: number;
  readonly minBodyCharacters: number;
  readonly maxBodyCharacters: number;
  readonly maxTags: number;
  readonly minHeadings: number;
}

export interface AuditPolicy {
  readonly version: string;
  readonly artifactTtlMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly minClaims: number;
  readonly duplicateThreshold: number;
  readonly minDuplicateCharacters: number;
  readonly prohibitedGuarantees: readonly string[];
  readonly platformLimits: Readonly<Record<Platform, PlatformAuditLimits>>;
}

export interface PriorPublicationVariant {
  readonly variantId: string;
  readonly platform: Platform;
  readonly payloadHash: string;
  readonly bodyMarkdown: string;
}

export interface EvaluatePublicationVariantInput {
  readonly tenantId: string;
  readonly brandId: string;
  readonly variantId: string;
  readonly platform: Platform;
  readonly payload: PublicationVariantPayload;
  readonly contacts: readonly TenantContact[];
  readonly factSnapshot: FactSnapshot;
  readonly policy: AuditPolicy;
  readonly priorVariants?: readonly PriorPublicationVariant[];
  readonly createdAt: string;
}

export interface AuditEvaluation {
  readonly payloadHash: string;
  readonly factSnapshotHash: string;
  readonly policyHash: string;
  readonly status: AuditStatus;
  readonly findings: readonly AuditFinding[];
}

export interface BuildAuditArtifactInput {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly policyVersion: string;
  readonly evaluation: AuditEvaluation;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AuditPublicationVariantInput extends EvaluatePublicationVariantInput {
  readonly artifactId: string;
  readonly channelAccountId: string;
}

const PLATFORMS: readonly Platform[] = ["toutiao", "sohu", "ctrip_community"];
const PHONE_PATTERN = /(?<!\d)(?:400[-\s]?\d{3}[-\s]?\d{4}|1[3-9]\d{9})(?!\d)/g;
const WECHAT_KEYWORD_PATTERN = /微信(?:咨询|号)?|wechat|wx|vx/i;
const WECHAT_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_-]{5,19}/g;
const RESERVED_WECHAT_TOKENS = new Set(["wechat", "weixin"]);

export const DEFAULT_AUDIT_POLICY: AuditPolicy = freezeDeep({
  version: "mvp-internal-v1",
  artifactTtlMs: 15 * 60 * 1_000,
  maxEvidenceAgeMs: 180 * 24 * 60 * 60 * 1_000,
  minClaims: 1,
  duplicateThreshold: 0.86,
  minDuplicateCharacters: 120,
  prohibitedGuarantees: ["百分百", "100%保证", "保证签证", "包过", "绝对保证", "零风险"],
  platformLimits: {
    toutiao: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    sohu: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    ctrip_community: {
      maxTitleCharacters: 40,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 20_000,
      maxTags: 10,
      minHeadings: 2,
    },
  },
});

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

function extractPhoneCandidates(content: string): string[] {
  const values = new Set<string>();
  for (const match of content.matchAll(PHONE_PATTERN)) {
    values.add(normalizePhone(match[0]));
  }
  return [...values].sort();
}

function extractWechatCandidates(content: string): string[] {
  const values = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const keyword = WECHAT_KEYWORD_PATTERN.exec(line);
    if (keyword === null) {
      continue;
    }
    const tail = line.slice(keyword.index + keyword[0].length);
    const sentence = tail.split(/[.!?。！？;]/u, 1)[0] ?? "";
    for (const match of sentence.matchAll(WECHAT_TOKEN_PATTERN)) {
      if (!RESERVED_WECHAT_TOKENS.has(match[0].toLowerCase())) {
        values.add(match[0]);
      }
    }
  }
  return [...values].sort();
}

function normalizedDuplicateText(value: string): string {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function normalizedClaimText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function ngrams(value: string, size = 3): Set<string> {
  const points = [...value];
  const result = new Set<string>();
  if (points.length < size) {
    if (points.length > 0) {
      result.add(points.join(""));
    }
    return result;
  }
  for (let index = 0; index <= points.length - size; index += 1) {
    result.add(points.slice(index, index + size).join(""));
  }
  return result;
}

export function duplicateSimilarity(first: string, second: string): number {
  const firstGrams = ngrams(normalizedDuplicateText(first));
  const secondGrams = ngrams(normalizedDuplicateText(second));
  if (firstGrams.size === 0 && secondGrams.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const gram of firstGrams) {
    if (secondGrams.has(gram)) {
      intersection += 1;
    }
  }
  return intersection / (firstGrams.size + secondGrams.size - intersection);
}

function validatePolicy(policy: AuditPolicy, platform: Platform): PlatformAuditLimits {
  invariant(policy.version.trim().length > 0, "AUDIT_POLICY_INVALID", "Policy version is required");
  invariant(
    Number.isSafeInteger(policy.artifactTtlMs) && policy.artifactTtlMs > 0,
    "AUDIT_POLICY_INVALID",
    "artifactTtlMs must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.maxEvidenceAgeMs) && policy.maxEvidenceAgeMs > 0,
    "AUDIT_POLICY_INVALID",
    "maxEvidenceAgeMs must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.minClaims) && policy.minClaims >= 0,
    "AUDIT_POLICY_INVALID",
    "minClaims must be a non-negative safe integer",
  );
  invariant(
    policy.duplicateThreshold > 0 && policy.duplicateThreshold <= 1,
    "AUDIT_POLICY_INVALID",
    "duplicateThreshold must be in (0, 1]",
  );
  invariant(
    Number.isSafeInteger(policy.minDuplicateCharacters) && policy.minDuplicateCharacters >= 0,
    "AUDIT_POLICY_INVALID",
    "minDuplicateCharacters must be a non-negative safe integer",
  );
  invariant(PLATFORMS.includes(platform), "AUDIT_PLATFORM_INVALID", "Unsupported platform", {
    platform,
  });
  const limits = policy.platformLimits[platform];
  invariant(limits !== undefined, "AUDIT_POLICY_INVALID", "Platform limits are required", {
    platform,
  });
  for (const [field, value] of Object.entries(limits)) {
    invariant(
      Number.isSafeInteger(value) && value >= 0,
      "AUDIT_POLICY_INVALID",
      `${field} must be a non-negative safe integer`,
      { platform, field, value },
    );
  }
  invariant(
    limits.maxBodyCharacters >= limits.minBodyCharacters,
    "AUDIT_POLICY_INVALID",
    "maxBodyCharacters must be at least minBodyCharacters",
  );
  return limits;
}

function validatePayload(payload: PublicationVariantPayload): void {
  invariant(typeof payload.title === "string", "AUDIT_PAYLOAD_INVALID", "title must be a string");
  invariant(
    typeof payload.summary === "string",
    "AUDIT_PAYLOAD_INVALID",
    "summary must be a string",
  );
  invariant(
    typeof payload.bodyMarkdown === "string",
    "AUDIT_PAYLOAD_INVALID",
    "bodyMarkdown must be a string",
  );
  invariant(Array.isArray(payload.media), "AUDIT_PAYLOAD_INVALID", "media must be an array");
  invariant(Array.isArray(payload.claims), "AUDIT_PAYLOAD_INVALID", "claims must be an array");
  invariant(
    Array.isArray(payload.contactIds),
    "AUDIT_PAYLOAD_INVALID",
    "contactIds must be an array",
  );
  invariant(Array.isArray(payload.tags), "AUDIT_PAYLOAD_INVALID", "tags must be an array");
}

function makeFinding(
  policy: AuditPolicy,
  ruleId: string,
  message: string,
  path: string,
  evidence: readonly string[] = [],
  severity: AuditFinding["severity"] = "blocking",
): AuditFinding {
  return {
    ruleId,
    ruleVersion: policy.version,
    severity,
    message,
    path,
    evidence: [...evidence],
  };
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.sort((left, right) => {
    const leftKey = `${left.ruleId}\u0000${left.path ?? ""}\u0000${left.message}\u0000${left.evidence.join("\u0000")}`;
    const rightKey = `${right.ruleId}\u0000${right.path ?? ""}\u0000${right.message}\u0000${right.evidence.join("\u0000")}`;
    return leftKey.localeCompare(rightKey, "en");
  });
}

export function evaluatePublicationVariant(
  input: EvaluatePublicationVariantInput,
): Readonly<AuditEvaluation> {
  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.brandId, "brandId");
  assertUuid(input.variantId, "variantId");
  validatePayload(input.payload);
  const limits = validatePolicy(input.policy, input.platform);
  const now = parseInstant(input.createdAt, "createdAt");
  const findings: AuditFinding[] = [];

  invariant(
    input.factSnapshot.tenantId === input.tenantId,
    "AUDIT_CONTEXT_MISMATCH",
    "Fact snapshot belongs to another tenant",
  );
  const capturedAt = parseInstant(input.factSnapshot.capturedAt, "factSnapshot.capturedAt");
  if (capturedAt > now) {
    findings.push(
      makeFinding(
        input.policy,
        "evidence.snapshot.future",
        "Fact snapshot was captured after the audit time",
        "factSnapshot.capturedAt",
      ),
    );
  }

  const contactById = new Map<string, TenantContact>();
  for (const contact of input.contacts) {
    invariant(
      contact.tenantId === input.tenantId,
      "AUDIT_CONTEXT_MISMATCH",
      "Contact belongs to another tenant",
      { contactId: contact.id },
    );
    invariant(!contactById.has(contact.id), "AUDIT_CONTEXT_DUPLICATE", "Duplicate contact ID", {
      contactId: contact.id,
    });
    contactById.set(contact.id, contact);
  }

  const activeContacts = input.contacts.filter((contact) => {
    const validFrom = parseInstant(contact.validFrom, `contacts.${contact.id}.validFrom`);
    const validUntil =
      contact.validUntil === null
        ? Number.POSITIVE_INFINITY
        : parseInstant(contact.validUntil, `contacts.${contact.id}.validUntil`);
    return validFrom <= now && now < validUntil;
  });
  const activeContactIds = new Set(activeContacts.map((contact) => contact.id));
  const content = `${input.payload.title}\n${input.payload.summary}\n${input.payload.bodyMarkdown}`;
  const phoneCandidates = extractPhoneCandidates(content);
  const wechatCandidates = extractWechatCandidates(content);
  const approvedPhones = new Set(
    activeContacts
      .filter((contact) => contact.type === "phone")
      .map((contact) => normalizePhone(contact.value)),
  );
  const approvedWechat = new Set(
    activeContacts.filter((contact) => contact.type === "wechat").map((contact) => contact.value),
  );

  for (const contactId of input.payload.contactIds) {
    const contact = contactById.get(contactId);
    if (contact === undefined) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.unknown",
          "Referenced contact does not exist in the tenant snapshot",
          "payload.contactIds",
          [contactId],
        ),
      );
      continue;
    }
    if (!activeContactIds.has(contactId)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.inactive",
          "Referenced contact is not active at audit time",
          "payload.contactIds",
          [contactId],
        ),
      );
      continue;
    }
    const present =
      contact.type === "phone"
        ? phoneCandidates.includes(normalizePhone(contact.value))
        : contact.type === "wechat"
          ? wechatCandidates.includes(contact.value)
          : content.includes(contact.value);
    if (!present) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.missing",
          "Referenced contact value is absent from the final platform variant",
          "payload.contactIds",
          [contactId, contact.type],
        ),
      );
    }
  }
  for (const candidate of phoneCandidates) {
    if (!approvedPhones.has(candidate)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.phone.unapproved",
          "Final platform variant contains an unapproved phone number",
          "payload.bodyMarkdown",
          [candidate],
        ),
      );
    }
  }
  for (const candidate of wechatCandidates) {
    if (!approvedWechat.has(candidate)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.wechat.unapproved",
          "Final platform variant contains an unapproved WeChat ID",
          "payload.bodyMarkdown",
          [candidate],
        ),
      );
    }
  }

  const sourceById = new Map<string, EvidenceSource>();
  for (const source of input.factSnapshot.sources) {
    invariant(
      !sourceById.has(source.id),
      "AUDIT_CONTEXT_DUPLICATE",
      "Duplicate evidence source ID",
      {
        sourceId: source.id,
      },
    );
    invariant(
      source.locator.trim().length > 0,
      "AUDIT_CONTEXT_INVALID",
      "Evidence locator is required",
      {
        sourceId: source.id,
      },
    );
    assertSha256(source.contentHash, `factSnapshot.sources.${source.id}.contentHash`);
    sourceById.set(source.id, source);
  }
  const factById = new Map<string, VerifiedFact>();
  for (const fact of input.factSnapshot.facts) {
    assertUuid(fact.id, "factSnapshot.facts.id");
    assertUuid(fact.brandId, `factSnapshot.facts.${fact.id}.brandId`);
    invariant(!factById.has(fact.id), "AUDIT_CONTEXT_DUPLICATE", "Duplicate fact ID", {
      factId: fact.id,
    });
    invariant(
      fact.text.trim().length > 0,
      "AUDIT_CONTEXT_INVALID",
      "Verified fact text is required",
      { factId: fact.id },
    );
    factById.set(fact.id, fact);
  }
  if (input.payload.claims.length < input.policy.minClaims) {
    findings.push(
      makeFinding(
        input.policy,
        "evidence.claims.insufficient",
        "Final platform variant does not contain enough explicit claims",
        "payload.claims",
        [`required=${input.policy.minClaims}`, `actual=${input.payload.claims.length}`],
      ),
    );
  }
  for (const [claimIndex, claim] of input.payload.claims.entries()) {
    const claimPath = `payload.claims[${claimIndex}]`;
    const verifiedFact = factById.get(claim.id);
    if (verifiedFact === undefined) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.unverified",
          "Claim is not bound to a verified tenant fact",
          `${claimPath}.id`,
          [claim.id],
        ),
      );
    } else {
      if (verifiedFact.brandId !== input.brandId) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.brand_mismatch",
            "Verified fact belongs to a different brand",
            `${claimPath}.id`,
            [claim.id, verifiedFact.brandId, input.brandId],
          ),
        );
      }
      if (claim.text !== verifiedFact.text) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.text_mismatch",
            "Claim text differs from the verified fact",
            `${claimPath}.text`,
            [claim.id],
          ),
        );
      }
      if (!sameStringSet(claim.evidenceSourceIds, verifiedFact.evidenceSourceIds)) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.sources_mismatch",
            "Claim evidence differs from the verified fact",
            `${claimPath}.evidenceSourceIds`,
            [claim.id],
          ),
        );
      }
      const factValidFrom = parseInstant(
        verifiedFact.validFrom,
        `factSnapshot.facts.${claim.id}.validFrom`,
      );
      const factValidUntil =
        verifiedFact.validUntil === null
          ? null
          : parseInstant(verifiedFact.validUntil, `factSnapshot.facts.${claim.id}.validUntil`);
      const claimValidUntil =
        claim.validUntil === null
          ? null
          : parseInstant(claim.validUntil, `${claimPath}.validUntil`);
      if (factValidFrom > now || (factValidUntil !== null && factValidUntil <= now)) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.fact_inactive",
            "Verified fact is not active at audit time",
            `${claimPath}.id`,
            [claim.id],
          ),
        );
      }
      if (claimValidUntil !== factValidUntil) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.validity_mismatch",
            "Claim validity differs from the verified fact",
            `${claimPath}.validUntil`,
            [claim.id],
          ),
        );
      }
    }
    if (!normalizedClaimText(content).includes(normalizedClaimText(claim.text))) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.not_in_content",
          "Verified claim text is absent from the final platform variant",
          `${claimPath}.text`,
          [claim.id],
        ),
      );
    }
    if (
      claim.validUntil !== null &&
      parseInstant(claim.validUntil, `${claimPath}.validUntil`) <= now
    ) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.expired",
          "Claim expired before the audit completed",
          `${claimPath}.validUntil`,
          [claim.id],
        ),
      );
    }
    if (claim.evidenceSourceIds.length === 0) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.source.missing",
          "Claim has no evidence source",
          `${claimPath}.evidenceSourceIds`,
          [claim.id],
        ),
      );
    }
    for (const sourceId of new Set(claim.evidenceSourceIds)) {
      const source = sourceById.get(sourceId);
      if (source === undefined) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.unknown",
            "Claim references an unknown evidence source",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
        continue;
      }
      const observedAt = parseInstant(
        source.observedAt,
        `factSnapshot.sources.${sourceId}.observedAt`,
      );
      if (observedAt > now) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.future",
            "Evidence was observed after the audit time",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
      if (now - observedAt > input.policy.maxEvidenceAgeMs) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.stale",
            "Evidence exceeds the policy freshness window",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
      if (
        source.validUntil !== null &&
        parseInstant(source.validUntil, `factSnapshot.sources.${sourceId}.validUntil`) <= now
      ) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.expired",
            "Evidence expired before the audit completed",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
    }
  }

  for (const phrase of input.policy.prohibitedGuarantees) {
    invariant(phrase.length > 0, "AUDIT_POLICY_INVALID", "Prohibited phrases cannot be empty");
    if (content.toLocaleLowerCase("en").includes(phrase.toLocaleLowerCase("en"))) {
      findings.push(
        makeFinding(
          input.policy,
          "claims.prohibited_guarantee",
          "Final platform variant contains a prohibited guarantee",
          "payload",
          [phrase],
        ),
      );
    }
  }

  const titleLength = codePointLength(input.payload.title);
  const summaryLength = codePointLength(input.payload.summary);
  const bodyLength = codePointLength(input.payload.bodyMarkdown);
  if (titleLength > limits.maxTitleCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.title.too_long",
        "Title exceeds the versioned platform policy",
        "payload.title",
        [`limit=${limits.maxTitleCharacters}`, `actual=${titleLength}`],
      ),
    );
  }
  if (summaryLength > limits.maxSummaryCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.summary.too_long",
        "Summary exceeds the versioned platform policy",
        "payload.summary",
        [`limit=${limits.maxSummaryCharacters}`, `actual=${summaryLength}`],
      ),
    );
  }
  if (bodyLength < limits.minBodyCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "structure.body.too_short",
        "Body is shorter than the versioned quality floor",
        "payload.bodyMarkdown",
        [`limit=${limits.minBodyCharacters}`, `actual=${bodyLength}`],
      ),
    );
  }
  if (bodyLength > limits.maxBodyCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.body.too_long",
        "Body exceeds the versioned platform policy",
        "payload.bodyMarkdown",
        [`limit=${limits.maxBodyCharacters}`, `actual=${bodyLength}`],
      ),
    );
  }
  if (input.payload.tags.length > limits.maxTags) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.tags.too_many",
        "Tag count exceeds the versioned platform policy",
        "payload.tags",
        [`limit=${limits.maxTags}`, `actual=${input.payload.tags.length}`],
      ),
    );
  }
  const headingCount = [...input.payload.bodyMarkdown.matchAll(/^#{2,3}\s+\S+/gm)].length;
  if (headingCount < limits.minHeadings) {
    findings.push(
      makeFinding(
        input.policy,
        "structure.headings.insufficient",
        "Body does not contain enough scannable sections",
        "payload.bodyMarkdown",
        [`required=${limits.minHeadings}`, `actual=${headingCount}`],
      ),
    );
  }

  const payloadHash = sha256Canonical(input.payload);
  const normalizedBodyLength = codePointLength(normalizedDuplicateText(input.payload.bodyMarkdown));
  let closestDuplicate: { prior: PriorPublicationVariant; similarity: number } | undefined;
  for (const prior of input.priorVariants ?? []) {
    if (prior.variantId === input.variantId) {
      continue;
    }
    assertSha256(prior.payloadHash, `priorVariants.${prior.variantId}.payloadHash`);
    if (prior.payloadHash === payloadHash) {
      findings.push(
        makeFinding(
          input.policy,
          "duplicate.exact",
          "Final platform variant exactly duplicates an earlier payload",
          "payload",
          [prior.variantId, prior.platform],
        ),
      );
      closestDuplicate = undefined;
      break;
    }
    if (
      normalizedBodyLength < input.policy.minDuplicateCharacters ||
      codePointLength(normalizedDuplicateText(prior.bodyMarkdown)) <
        input.policy.minDuplicateCharacters
    ) {
      continue;
    }
    const similarity = duplicateSimilarity(input.payload.bodyMarkdown, prior.bodyMarkdown);
    if (closestDuplicate === undefined || similarity > closestDuplicate.similarity) {
      closestDuplicate = { prior, similarity };
    }
  }
  if (
    closestDuplicate !== undefined &&
    closestDuplicate.similarity >= input.policy.duplicateThreshold
  ) {
    findings.push(
      makeFinding(
        input.policy,
        "duplicate.near",
        "Final platform variant is too similar to an earlier publication",
        "payload.bodyMarkdown",
        [
          closestDuplicate.prior.variantId,
          closestDuplicate.prior.platform,
          `similarity=${closestDuplicate.similarity.toFixed(4)}`,
        ],
      ),
    );
  }

  sortFindings(findings);
  const status: AuditStatus = findings.some((finding) => finding.severity === "blocking")
    ? "failed"
    : "passed";
  return freezeDeep({
    payloadHash,
    factSnapshotHash: sha256Canonical(input.factSnapshot),
    policyHash: sha256Canonical(input.policy),
    status,
    findings,
  });
}

function unsignedAuditArtifact(artifact: Omit<AuditArtifact, "auditHash">): unknown {
  return {
    schema: "geo.audit-artifact.v1",
    id: artifact.id,
    tenantId: artifact.tenantId,
    variantId: artifact.variantId,
    channelAccountId: artifact.channelAccountId,
    platform: artifact.platform,
    payloadHash: artifact.payloadHash,
    factSnapshotHash: artifact.factSnapshotHash,
    policyHash: artifact.policyHash,
    policyVersion: artifact.policyVersion,
    status: artifact.status,
    findings: artifact.findings,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
  };
}

export function computeAuditHash(artifact: Omit<AuditArtifact, "auditHash">): string {
  return sha256Canonical(unsignedAuditArtifact(artifact));
}

export function verifyAuditArtifactIntegrity(artifact: Readonly<AuditArtifact>): boolean {
  try {
    assertSha256(artifact.auditHash, "auditHash");
    const expectedStatus: AuditStatus = artifact.findings.some(
      (finding) => finding.severity === "blocking",
    )
      ? "failed"
      : "passed";
    return artifact.status === expectedStatus && computeAuditHash(artifact) === artifact.auditHash;
  } catch {
    return false;
  }
}

export function buildAuditArtifact(input: BuildAuditArtifactInput): Readonly<AuditArtifact> {
  assertUuid(input.artifactId, "artifactId");
  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.variantId, "variantId");
  assertUuid(input.channelAccountId, "channelAccountId");
  const createdAt = parseInstant(input.createdAt, "createdAt");
  const expiresAt = parseInstant(input.expiresAt, "expiresAt");
  invariant(expiresAt > createdAt, "AUDIT_EXPIRY_INVALID", "Audit expiry must follow creation");
  invariant(
    input.evaluation.status ===
      (input.evaluation.findings.some((finding) => finding.severity === "blocking")
        ? "failed"
        : "passed"),
    "AUDIT_STATUS_INVALID",
    "Audit status does not match its findings",
  );

  const unsigned: Omit<AuditArtifact, "auditHash"> = {
    id: input.artifactId,
    tenantId: input.tenantId,
    variantId: input.variantId,
    channelAccountId: input.channelAccountId,
    platform: input.platform,
    payloadHash: input.evaluation.payloadHash,
    factSnapshotHash: input.evaluation.factSnapshotHash,
    policyHash: input.evaluation.policyHash,
    policyVersion: input.policyVersion,
    status: input.evaluation.status,
    findings: input.evaluation.findings.map((finding) => ({
      ...finding,
      evidence: [...finding.evidence],
    })),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return freezeDeep({ ...unsigned, auditHash: computeAuditHash(unsigned) });
}

export function auditPublicationVariant(
  input: AuditPublicationVariantInput,
): Readonly<AuditArtifact> {
  const evaluation = evaluatePublicationVariant(input);
  const createdAt = parseInstant(input.createdAt, "createdAt");
  return buildAuditArtifact({
    artifactId: input.artifactId,
    tenantId: input.tenantId,
    variantId: input.variantId,
    channelAccountId: input.channelAccountId,
    platform: input.platform,
    policyVersion: input.policy.version,
    evaluation,
    createdAt: input.createdAt,
    expiresAt: new Date(createdAt + input.policy.artifactTtlMs).toISOString(),
  });
}
