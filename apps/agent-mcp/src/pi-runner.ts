import { createHash, randomUUID } from "node:crypto";

import {
  FixtureDraftingRuntime,
  GovernedAgentRuntime,
  isPlasticPromiseAgentToolName,
  piGeoSkillSystemPrompt,
  type AutomationRemediationPlan,
  type GeoApplicationToolInvoker,
  type PlasticPromiseGovernanceClient,
} from "@geo/agent";
import {
  CorrectableToolInputError,
  createPiAgentTools,
  createRealPiRuntime,
  type PiToolWorkflowGuard,
} from "@geo/agent/pi";
import type { ThinkingLevel } from "@geo/agent/pi";
import {
  idSchema,
  automationPlatformSchema,
  PRIMARY_DISTRIBUTION_PLATFORMS,
  type ActorContext,
  type AutomationPlatform,
  type GovernedEditorialProfile,
  type Platform,
} from "@geo/contracts";
import type { Api, Model } from "@mariozechner/pi-ai";
import { z } from "zod";

import type { InternalGeoApiClient } from "./api-client.js";
import { invokeGeoMcpTool } from "./handlers.js";

const fixtureRunSchema = z
  .object({
    workflow: z.literal("draft_to_publication"),
    tenantId: idSchema,
    brandId: idSchema,
    campaignId: idSchema,
    channelAccountId: idSchema,
    platform: automationPlatformSchema,
    topic: z.string().trim().min(1).max(10_000),
    articleTemplateId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/u)
      .optional(),
    idempotencyKey: z.string().trim().min(1).max(180),
  })
  .strict();

const boundDraftScopeSchema = z
  .object({
    tenantId: idSchema,
    brandId: idSchema,
    campaignId: idSchema,
    targetPlatform: automationPlatformSchema,
    brief: z.string().trim().min(1).max(10_000),
    articleTemplateId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/u)
      .optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

const promptRunSchema = z
  .object({
    workflow: z.literal("prompt"),
    requiredWorkflow: z.literal("draft_to_publication").optional(),
    brandId: idSchema.optional(),
    targetPlatform: automationPlatformSchema.optional(),
    draftScope: boundDraftScopeSchema.optional(),
    prompt: z.string().trim().min(1).max(30_000),
  })
  .strict();

const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000] as const;
const DEFAULT_MAX_PI_TOOL_CALLS = 64;
const DEFAULT_MAX_REPEATED_PI_TOOL_CALLS = 3;
const DRAFT_INPUT_FAILURE_CODES = [
  "AUTHORED_DRAFT_ARGUMENTS_INVALID",
  "AUTHORED_DRAFT_FACT_TEXT_REQUIRED",
  "AUTOMATION_DRAFT_VERIFIED_CLAIM_REQUIRED",
  "AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED",
  // A remediation draft can collide with the prior content version. Treat
  // that as a correctable draft failure so the bounded continuation can use
  // a fresh remediation idempotency key instead of looping into the tool guard.
  "RESOURCE_CONFLICT",
  "AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_INVALID",
  "CTRIP_LOCATION_REQUIRED",
] as const;

const MAX_DRAFT_CORRECTIVE_CONTINUATIONS = 3;
type DraftInputFailureCode = (typeof DRAFT_INPUT_FAILURE_CODES)[number];
// Code-level lock for the pure content production agent: the automation
// drafting run may only expose read-only tenant context plus the single draft
// proposal tool. Editing, media, variant, audit, publication, and governance
// tools are never injected into this stage.
const DRAFT_REQUIRED_TOOL_NAMES = [
  "geo_tenant_context",
  "geo_template_catalog",
  "geo_brand_profile",
  "geo_fact_lookup",
  "geo_draft_proposal",
] as const;

const BROWSER_ARTICLE_PLATFORMS = new Set<Platform>([
  ...PRIMARY_DISTRIBUTION_PLATFORMS,
  "ctrip_community",
  "zhihu",
]);

function automationRemediationSystemPrompt(
  remediation: Readonly<AutomationRemediationPlan> | undefined,
): readonly string[] {
  if (remediation === undefined) return [];
  const publisherSoftAdvertorial = remediation.reasonCodes.includes(
    "publisher.rejected.soft_advertorial",
  );
  return [
    "This is a bounded remediation draft, not a light paraphrase.",
    `Task ${remediation.taskId}; target-only remediation attempt ${remediation.attempt}/${remediation.maxAttempts}.`,
    `Audit reasons: ${remediation.reasonCodes.join(", ")}.`,
    `Required corrective actions: ${remediation.actions.join(", ")}.`,
    "Create a fresh article structure and wording that directly performs every listed action. Do not reuse the failed title, opening, section order, examples, or call-to-action phrasing. Keep verified facts only and do not attempt to bypass platform, manual-review, account, or policy controls.",
    ...(publisherSoftAdvertorial
      ? [
          "The publisher explicitly rejected the previous article as advertising-style sponsored copy. The goal is to materially reduce its promotional character, never to disguise advertising or game the platform classifier.",
          "Write a new title, opening trigger, section progression, examples, conclusion, and media plan. Do not preserve the rejected draft's sales narrative under synonyms.",
          "Keep only campaign-required and verified brand references, spread them naturally, and remove repeated praise, ranking slogans, qualification stacks, consecutive brand mentions, hard calls to action, and guarantee-like language.",
          "Turn service claims into concrete traveler decision information: first-person reader context without fabricated experience, destination-specific logistics, practical tradeoffs, two or three neutral drawbacks, and facts the reader can independently evaluate.",
          "Treat ranking, state-owned background, filing, qualification, and 5A-related wording as factual claims. Include them only when supported by the bound verified facts, attribute them precisely, and never use subjective phrasing to imply an unsupported credential.",
          "Make the article useful even if every brand mention were removed: each section must add a real scenario, decision criterion, local detail, cost or time tradeoff, or avoidable mistake.",
        ]
      : []),
  ];
}

export function nextMissingDraftToolName(
  successfulToolNames: ReadonlySet<string>,
): string | undefined {
  return DRAFT_REQUIRED_TOOL_NAMES.find((toolName) => !successfulToolNames.has(toolName));
}

function isDraftRequiredToolName(toolName: string): boolean {
  return (DRAFT_REQUIRED_TOOL_NAMES as readonly string[]).includes(toolName);
}

function canonicalToolArgumentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolArgumentValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalToolArgumentValue(item)]),
  );
}

function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(canonicalToolArgumentValue(args))}`;
}

function safeToolArgumentKeys(args: unknown): readonly string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  return Object.keys(args as Readonly<Record<string, unknown>>)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(key))
    .sort()
    .slice(0, 20);
}

function preExecutionErrorCategory(
  knownTool: boolean,
  result: unknown,
): "argument_rejection" | "missing_tool" | "policy_rejection" {
  if (!knownTool) return "missing_tool";
  if (typeof result !== "object" || result === null) return "argument_rejection";
  const content = (result as Readonly<Record<string, unknown>>).content;
  if (!Array.isArray(content)) return "argument_rejection";
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Readonly<Record<string, unknown>>).type === "text" &&
      (block as Readonly<Record<string, unknown>>).text ===
        "Tool call denied by authenticated tenant policy",
  )
    ? "policy_rejection"
    : "argument_rejection";
}

function draftInputFailureCode(result: unknown): DraftInputFailureCode | null {
  if (typeof result !== "object" || result === null) return null;
  const content = (result as Readonly<Record<string, unknown>>).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
      const value = block as Readonly<Record<string, unknown>>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
  return DRAFT_INPUT_FAILURE_CODES.find((code) => text.includes(code)) ?? null;
}

function boundedFactQuery(value: string): string {
  return [...value.trim().replaceAll(/\s+/gu, " ")].slice(0, 200).join("");
}

function abortedRunError(): Error {
  return new Error("Pi agent run was aborted");
}

function assertRunActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedRunError();
}

function continuationTranscript<T>(messages: readonly T[]): T[] | null {
  const failedMessage = messages.at(-1);
  const precedingMessage = messages.at(-2);
  if (
    typeof failedMessage !== "object" ||
    failedMessage === null ||
    Array.isArray(failedMessage) ||
    typeof precedingMessage !== "object" ||
    precedingMessage === null ||
    Array.isArray(precedingMessage)
  ) {
    return null;
  }
  const failure = failedMessage as Readonly<Record<string, unknown>>;
  const preceding = precedingMessage as Readonly<Record<string, unknown>>;
  if (
    failure.role !== "assistant" ||
    failure.stopReason !== "error" ||
    (preceding.role !== "user" && preceding.role !== "toolResult")
  ) {
    return null;
  }
  return messages.slice(0, -1);
}

function waitForProviderRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  assertRunActive(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedRunError());
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export interface PiAgentRunCapability {
  readonly mode: "fixture" | "pi";
  readonly provider: string;
  readonly model: string;
}

export interface PiAgentRunService {
  readonly capability: PiAgentRunCapability;
  run(principal: Readonly<ActorContext>, input: unknown, signal?: AbortSignal): Promise<unknown>;
  authorAutomationDraft?(
    principal: Readonly<ActorContext>,
    input: Readonly<AutomationDraftAuthorInput>,
    signal?: AbortSignal,
  ): Promise<AutomationDraftAuthorResult>;
}

export interface AutomationDraftAuthorInput {
  readonly tenantId: string;
  readonly brandId: string;
  readonly campaignId: string;
  readonly targetPlatform: AutomationPlatform;
  readonly brief: string;
  readonly articleTemplateId?: string;
  readonly diversityPlan?: Readonly<AutomationDraftDiversityPlan>;
  readonly remediation?: Readonly<AutomationRemediationPlan>;
  readonly idempotencyKey: string;
}

export interface AutomationDraftDiversityPlan {
  readonly strategyId: string;
  readonly rotationIndex: number;
  readonly editorialProfile: GovernedEditorialProfile;
  readonly topicAngle: string;
  readonly readerLens: string;
  readonly titleConstruction: string;
  readonly openingPattern: string;
  readonly bodyProgression: string;
  readonly ctaPattern: string;
  readonly mediaVisualDirection: string;
  readonly forbiddenAdjacentPatterns: readonly string[];
  readonly destination?: {
    readonly provinceKey: string;
    readonly provinceName: string;
  };
  readonly keywordPoolId: string;
  readonly keywordCandidates: readonly string[];
}

export interface AutomationDraftAuthorResult {
  readonly providerMode: "pi_authored";
  readonly provider: string;
  readonly model: string;
  readonly providerRunId: string;
  readonly providerRequestId: string | null;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly articleTemplateId?: string;
}

export type PiProviderFailureClass =
  | "authentication"
  | "context_limit"
  | "invalid_request"
  | "network"
  | "response_protocol"
  | "rate_limit"
  | "timeout"
  | "tool_protocol"
  | "upstream"
  | "unknown";

function providerFailureClass(message: string | undefined): PiProviderFailureClass {
  const value = message ?? "";
  if (/\b(?:429|quota)\b|rate[ _-]?limit|usage[ _-]?limit/iu.test(value)) return "rate_limit";
  if (/\b(?:408|504|524)\b|timed?[ _-]?out|timeout/iu.test(value)) return "timeout";
  if (/\b(?:500|502|503)\b|upstream|server error/iu.test(value)) return "upstream";
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|(?:invalid|incorrect|missing|required) api[ _-]?key|authentication failed/iu.test(
      value,
    )
  ) {
    return "authentication";
  }
  if (/function[ _-]?call|tool[ _-]?(?:call|result)|call_id|previous_response/iu.test(value)) {
    return "tool_protocol";
  }
  if (/context.{0,20}(?:length|limit|window)|too many tokens|maximum context/iu.test(value)) {
    return "context_limit";
  }
  if (/\b400\b|bad request|invalid request|unsupported parameter/iu.test(value)) {
    return "invalid_request";
  }
  if (
    /network|fetch failed|econn|socket|tls|\bterminated\b|premature(?:ly)? closed|connection closed|other side closed/iu.test(
      value,
    )
  ) {
    return "network";
  }
  if (
    /unexpected end|unterminated|invalid (?:json|response)|parse|stream|sse|event source/iu.test(
      value,
    )
  ) {
    return "response_protocol";
  }
  return "unknown";
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function recordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = recordValue(entry);
        return record === null ? [] : [record];
      })
    : [];
}

function tenantBrandDisplayName(context: unknown, brandId: string): string | null {
  const tenantContext = recordValue(context);
  const selectedBrand = recordArray(tenantContext?.brands).find((brand) => brand.id === brandId);
  return typeof selectedBrand?.displayName === "string" &&
    selectedBrand.displayName.trim().length > 0
    ? selectedBrand.displayName
    : null;
}

function assertCtripBrandPlacement(
  args: Readonly<Record<string, unknown>>,
  displayName: string,
): void {
  const authoredDraft = recordValue(args.authoredDraft);
  const body = recordArray(authoredDraft?.body)
    .flatMap((section) => (typeof section.text === "string" ? [section.text] : []))
    .join("\n\n")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
  const normalizedDisplayName = displayName.normalize("NFKC").toLocaleLowerCase("zh-CN");
  if (body.length === 0 || normalizedDisplayName.length === 0) return;

  const firstBrandIndex = body.indexOf(normalizedDisplayName);
  if (firstBrandIndex < 0) return;
  const secondHeadingIndex = [...body.matchAll(/^##\s+\S+/gmu)][1]?.index;
  if (
    firstBrandIndex > Math.floor(body.length / 2) ||
    (secondHeadingIndex !== undefined && firstBrandIndex >= secondHeadingIndex)
  ) {
    throw new CorrectableToolInputError("CTRIP_BRAND_PLACEMENT_TOO_LATE");
  }
}

function assertCtripLocationQuery(args: Readonly<Record<string, unknown>>): void {
  const authoredDraft = recordValue(args.authoredDraft);
  const locationQuery = authoredDraft?.locationQuery;
  if (typeof locationQuery !== "string" || locationQuery.trim().length === 0) {
    throw new CorrectableToolInputError("CTRIP_LOCATION_REQUIRED");
  }
}

function pick(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    keys.flatMap((key) => (Object.hasOwn(value, key) ? [[key, value[key]]] : [])),
  );
}

function projectTenantContext(
  result: unknown,
  scope: Readonly<{ brandId?: string; campaignId?: string }>,
): unknown {
  const context = recordValue(result);
  if (context === null) return result;
  const profiles = recordValue(context.brandAgentProfiles);
  const profileItems = recordArray(profiles?.items)
    .filter((profile) => scope.brandId === undefined || profile.brandId === scope.brandId)
    .map((profile) => pick(profile, ["id", "brandId", "version", "status", "documentHash"]));
  const policies = recordArray(context.policies).map((policy) => {
    const audit = recordValue(policy.audit);
    return {
      ...pick(policy, ["id", "version", "status", "policyHash", "industry"]),
      ...(audit === null
        ? {}
        : {
            audit: pick(audit, ["minClaims", "platformLimits"]),
          }),
    };
  });
  return {
    tenant: context.tenant,
    brands: recordArray(context.brands).filter(
      (brand) => scope.brandId === undefined || brand.id === scope.brandId,
    ),
    campaigns: recordArray(context.campaigns).filter(
      (campaign) => scope.campaignId === undefined || campaign.id === scope.campaignId,
    ),
    accounts: context.accounts,
    capabilities: context.capabilities,
    brandAgentProfiles: { items: profileItems },
    policies,
  };
}

function projectTemplateCatalog(result: unknown, selectedTemplateId?: string): unknown {
  const catalog = recordValue(result);
  if (catalog === null) return result;
  const items = recordArray(catalog.items);
  if (selectedTemplateId !== undefined) {
    return {
      version: catalog.version,
      selectedTemplateId,
      totalAvailable: items.length,
      items: items.filter((template) => template.id === selectedTemplateId),
    };
  }
  return {
    version: catalog.version,
    totalAvailable: items.length,
    items: items.map((template) =>
      pick(template, ["id", "name", "category", "editorialProfile", "scenario", "benefit"]),
    ),
  };
}

function projectBrandProfile(result: unknown): unknown {
  const profileResult = recordValue(result);
  if (profileResult === null) return result;
  const profile = recordValue(profileResult.profile);
  return {
    brandId: profileResult.brandId,
    configured: profileResult.configured,
    profile:
      profile === null
        ? null
        : pick(profile, ["id", "brandId", "version", "status", "documentHash", "effectiveAt"]),
    guidance: "The active profile document is already installed in the immutable system context.",
  };
}

function verifiedFactItems(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  const lookup = recordValue(result);
  if (lookup === null) return [];
  const factsResult = recordValue(lookup.facts);
  return recordArray(factsResult?.items).filter((fact) => fact.status === "verified");
}

type VerifiedFactCitationHint = Readonly<{ id: string; claim: string }>;

function verifiedFactCitationHints(result: unknown): readonly VerifiedFactCitationHint[] {
  return verifiedFactItems(result)
    .flatMap((fact) => {
      const id = fact.id;
      const claim = fact.claim;
      return typeof id === "string" && typeof claim === "string" && claim.trim().length > 0
        ? [{ id, claim }]
        : [];
    })
    .sort((left, right) => left.claim.length - right.claim.length)
    .slice(0, 3);
}

function contextualDraftErrorMessage(
  toolName: string,
  error: unknown,
  factHints: readonly VerifiedFactCitationHint[],
): string | undefined {
  const code = recordValue(error)?.code;
  if (
    toolName !== "geo_draft_proposal" ||
    code !== "AUTHORED_DRAFT_FACT_TEXT_REQUIRED" ||
    factHints.length === 0
  ) {
    return undefined;
  }
  const pairs = factHints
    .map((fact, index) => `${index + 1}. ID=${fact.id}\nCLAIM=${JSON.stringify(fact.claim)}`)
    .join("\n");
  return [
    "Correctable draft error: AUTHORED_DRAFT_FACT_TEXT_REQUIRED.",
    "Discard every claimIds choice from the rejected call. Set titleClaimIds, summaryClaimIds, and every mediaSearchPlan claimIds array to [].",
    "Choose exactly one allowed pair below. Copy its CLAIM value character-for-character into one body section, without shortening, paraphrasing, translating, or changing punctuation. Set only that same body section claimIds to [ID]; every other body claimIds must be [].",
    "Before retrying, verify the complete CLAIM is a literal substring of the combined title, summary, and body text. If it is not, do not call the tool yet.",
    pairs,
    "Retry geo_draft_proposal once with the complete authoredDraft object.",
  ].join("\n");
}

function controlledBriefFactQuery(brief: string, initialQuery: string): string | undefined {
  const candidates = ["出境", "合同", "旅游", "行程", "费用", "安全", "服务"] as const;
  return candidates.find((candidate) => brief.includes(candidate) && candidate !== initialQuery);
}

function projectFactLookup(result: unknown): unknown {
  const lookup = recordValue(result);
  if (lookup === null) return result;
  const facts = verifiedFactItems(result).map((fact) =>
    pick(fact, [
      "id",
      "brandId",
      "normalizedKey",
      "claim",
      "status",
      "evidenceSourceIds",
      "validFrom",
      "validUntil",
    ]),
  );
  return {
    facts: { items: facts },
    evidence: {
      sourceIds: [
        ...new Set(
          facts.flatMap((fact) =>
            Array.isArray(fact.evidenceSourceIds)
              ? fact.evidenceSourceIds.filter((id): id is string => typeof id === "string")
              : [],
          ),
        ),
      ],
      guidance: "Draft only from the verified fact IDs and complete claim strings above.",
    },
  };
}

export function projectPiToolResult(
  toolName: string,
  result: unknown,
  scope: Readonly<{
    brandId?: string;
    campaignId?: string;
    articleTemplateId?: string;
  }> = {},
): unknown {
  switch (toolName) {
    case "geo_tenant_context":
      return projectTenantContext(result, scope);
    case "geo_template_catalog":
      return projectTemplateCatalog(result, scope.articleTemplateId);
    case "geo_brand_profile":
      return projectBrandProfile(result);
    case "geo_fact_lookup":
      return projectFactLookup(result);
    default:
      return result;
  }
}

function providerFailureFingerprint(message: string | undefined): Readonly<{
  length: number;
  sha256Prefix: string;
}> {
  const value = message ?? "";
  return {
    length: value.length,
    sha256Prefix: createHash("sha256").update(value).digest("hex").slice(0, 16),
  };
}

function providerPayloadMetrics(payload: unknown): Readonly<{
  bytes: number;
  messageCount: number;
  toolCount: number;
}> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { bytes: -1, messageCount: 0, toolCount: 0 };
  }
  if (serialized === undefined) return { bytes: 0, messageCount: 0, toolCount: 0 };
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>)
      : null;
  return {
    bytes: Buffer.byteLength(serialized),
    messageCount: Array.isArray(record?.messages) ? record.messages.length : 0,
    toolCount: Array.isArray(record?.tools) ? record.tools.length : 0,
  };
}

export function automationDiversitySystemPrompt(
  plan: Readonly<AutomationDraftDiversityPlan> | undefined,
): readonly string[] {
  if (plan === undefined) return [];
  return [
    "<automation_diversity_plan>",
    "This server-selected plan is mandatory for this automation slot. It is a generation constraint, not article copy, and the selected article template is bound separately by the server.",
    `Strategy ID: ${plan.strategyId}. Rotation index: ${plan.rotationIndex}. Editorial profile: ${plan.editorialProfile}.`,
    `Mandatory topic angle: ${plan.topicAngle}`,
    `Reader lens: ${plan.readerLens}`,
    ...(plan.destination === undefined
      ? []
      : [
          `Bound destination resource: ${plan.destination.provinceName} (${plan.destination.provinceKey}). Write a destination-specific note: use the province's real scenic areas, transport, season, life scenes and local details, and never copy a generic multi-province itinerary.`,
        ]),
    `Title construction: ${plan.titleConstruction}`,
    `Opening pattern: ${plan.openingPattern}`,
    `Body progression: ${plan.bodyProgression}`,
    `CTA pattern: ${plan.ctaPattern}`,
    `Media visual direction: ${plan.mediaVisualDirection}`,
    `Keyword pool: ${plan.keywordPoolId}. Rotated candidates: ${plan.keywordCandidates.join(" | ")}`,
    `Forbidden adjacent-slot patterns: ${plan.forbiddenAdjacentPatterns.join(" | ")}`,
    "Treat keyword candidates as optional discoverability phrases, never as verified facts. Work two to four into the prose only when they fit the bound brief naturally. During final self-review, delete any candidate that is unsupported, repetitive, misleading, or harms readability; an omitted candidate is not a validation failure.",
    "Ranking, credential, rating, best, Top1, top-ten, 5A, no-trick, and similar language requires an explicit matching verified fact. Never preserve or soften such a candidate merely to hit the keyword pool.",
    "Do not reuse a forbidden pattern as the dominant buyer angle, title formula, opening device, heading order, CTA, image subject set, or image composition. Do not fall back to a generic guide, checklist, or the wording of a prior article.",
    "The title must express a concrete traveler decision and this plan's title construction. Do not produce near-duplicate titles by swapping only generic words such as 核验、边界、怎么核验、注意事项 or 指南.",
    "All four media queries must follow the selected visual direction and form a different subject set from the forbidden adjacent patterns. Do not reuse the same four landmarks or the same cover/inline sequence across adjacent articles.",
    "Before geo_draft_proposal, silently verify that the title construction, first two sentences, section sequence, evidence placement, and final next step all express this plan. For Ctrip, also verify that the selected brand's first body occurrence is in the first substantive paragraph after the opening buyer answer and before the second `##` heading. Rewrite any generic, repeated, or late-brand element before submitting.",
    "Keep facts exact and the commercial GEO rules intact while varying persuasion and composition. Diversity never authorizes invented facts, unsupported personas, or governance bypasses.",
    "</automation_diversity_plan>",
  ];
}

export class PiAgentRunError extends Error {
  readonly code = "AGENT_PROVIDER_FAILED";
  readonly statusCode = 502;
  readonly diagnosticReason: "provider_error" | "tool_guard" | "draft_input";
  readonly failureCode: DraftInputFailureCode | null;
  readonly providerFailureClass: PiProviderFailureClass | null;
  readonly toolCallCount: number;
  readonly lastToolName: string | null;

  constructor(options?: {
    readonly diagnosticReason?: "provider_error" | "tool_guard" | "draft_input";
    readonly failureCode?: DraftInputFailureCode | null;
    readonly providerFailureClass?: PiProviderFailureClass | null;
    readonly toolCallCount?: number;
    readonly lastToolName?: string | null;
  }) {
    super("Configured Pi provider failed to complete the agent run");
    this.name = "PiAgentRunError";
    this.diagnosticReason = options?.diagnosticReason ?? "provider_error";
    this.failureCode = options?.failureCode ?? null;
    this.providerFailureClass = options?.providerFailureClass ?? null;
    this.toolCallCount = options?.toolCallCount ?? 0;
    this.lastToolName = options?.lastToolName ?? null;
  }
}

export function createGovernedAgentRuntime(
  principal: Readonly<ActorContext>,
  api: InternalGeoApiClient,
  governance: PlasticPromiseGovernanceClient,
  options: {
    readonly draftTargetPlatform?: AutomationPlatform;
    readonly boundAutomationDraft?: Readonly<AutomationDraftAuthorInput>;
    readonly onDraftProposal?: (result: unknown) => void;
    readonly allowFixtureDrafts?: boolean;
  } = {},
): GovernedAgentRuntime {
  let tenantContextSnapshot: unknown;
  let boundAutomationFactLookupObserved = false;
  const authorizeScope = (
    scopePrincipal: Readonly<ActorContext>,
    toolName: Parameters<GeoApplicationToolInvoker["invoke"]>[0] | string,
    args: Readonly<Record<string, unknown>>,
  ) =>
    isPlasticPromiseAgentToolName(toolName)
      ? args.tenantId === scopePrincipal.tenantId
      : api.authorizeResourceScope(scopePrincipal, toolName, args);
  const geo: GeoApplicationToolInvoker = {
    invoke: async (toolName, args) => {
      const effectiveArgs =
        toolName === "geo_draft_proposal" && options.boundAutomationDraft !== undefined
          ? {
              ...args,
              tenantId: options.boundAutomationDraft.tenantId,
              brandId: options.boundAutomationDraft.brandId,
              campaignId: options.boundAutomationDraft.campaignId,
              brief: options.boundAutomationDraft.brief,
              idempotencyKey: options.boundAutomationDraft.idempotencyKey,
              targetPlatform: options.boundAutomationDraft.targetPlatform,
              ...(options.boundAutomationDraft.articleTemplateId === undefined
                ? {}
                : { articleTemplateId: options.boundAutomationDraft.articleTemplateId }),
            }
          : options.boundAutomationDraft !== undefined && toolName === "geo_fact_lookup"
            ? {
                ...args,
                tenantId: options.boundAutomationDraft.tenantId,
                brandId: options.boundAutomationDraft.brandId,
                query: boundedFactQuery(String(args.query ?? options.boundAutomationDraft.brief)),
                limit: 10,
              }
            : options.boundAutomationDraft !== undefined &&
                (toolName === "geo_tenant_context" || toolName === "geo_template_catalog")
              ? { ...args, tenantId: options.boundAutomationDraft.tenantId }
              : options.boundAutomationDraft !== undefined && toolName === "geo_brand_profile"
                ? {
                    ...args,
                    tenantId: options.boundAutomationDraft.tenantId,
                    brandId: options.boundAutomationDraft.brandId,
                  }
                : toolName === "geo_draft_proposal" && options.draftTargetPlatform !== undefined
                  ? { ...args, targetPlatform: options.draftTargetPlatform }
                  : args;
      if (
        toolName === "geo_draft_proposal" &&
        Object.hasOwn(effectiveArgs, "fixtureMode") &&
        (effectiveArgs.fixtureMode !== true || options.allowFixtureDrafts !== true)
      ) {
        throw new PiAgentRunError({
          diagnosticReason: "tool_guard",
          lastToolName: "geo_draft_proposal",
        });
      }
      if (
        toolName === "geo_draft_proposal" &&
        options.boundAutomationDraft?.targetPlatform === "ctrip_community"
      ) {
        assertCtripLocationQuery(effectiveArgs);
        tenantContextSnapshot ??= await api.getTenantContext(principal);
        const displayName = tenantBrandDisplayName(
          tenantContextSnapshot,
          options.boundAutomationDraft.brandId,
        );
        if (displayName === null) {
          throw new CorrectableToolInputError("CTRIP_BRAND_CONTEXT_UNAVAILABLE");
        }
        assertCtripBrandPlacement(effectiveArgs, displayName);
      }
      const isFirstBoundAutomationFactLookup =
        toolName === "geo_fact_lookup" &&
        options.boundAutomationDraft !== undefined &&
        !boundAutomationFactLookupObserved;
      const result = await invokeGeoMcpTool({
        toolName,
        args: effectiveArgs,
        principal,
        api,
        authorizeScope,
        ...(options.boundAutomationDraft === undefined
          ? {}
          : {
              draftProposalOptions: {
                requireRelevantVerifiedClaims: true,
              },
            }),
      });
      if (isFirstBoundAutomationFactLookup) {
        boundAutomationFactLookupObserved = true;
        if (verifiedFactItems(result).length === 0) {
          const initialQuery = String(effectiveArgs.query ?? "");
          const fallbackQuery = controlledBriefFactQuery(
            options.boundAutomationDraft.brief,
            initialQuery,
          );
          if (fallbackQuery !== undefined) {
            return invokeGeoMcpTool({
              toolName,
              args: { ...effectiveArgs, query: fallbackQuery },
              principal,
              api,
              authorizeScope,
            });
          }
        }
      }
      if (toolName === "geo_tenant_context") tenantContextSnapshot = result;
      if (toolName === "geo_draft_proposal") options.onDraftProposal?.(result);
      return result;
    },
  };
  return new GovernedAgentRuntime({
    principal,
    geo,
    governance,
    authorizeResourceScope: authorizeScope,
  });
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Readonly<Record<string, unknown>>;
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    return record.content
      .flatMap((block) => {
        if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
        const content = block as Readonly<Record<string, unknown>>;
        return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
      })
      .join("");
  }
  return "";
}

function providerRequestId(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Readonly<Record<string, unknown>>;
    if (record.role !== "assistant") continue;
    return typeof record.responseId === "string" &&
      record.responseId.trim().length > 0 &&
      record.responseId.length <= 1_000
      ? record.responseId
      : null;
  }
  return null;
}

export class FixturePiAgentRunService implements PiAgentRunService {
  readonly capability: PiAgentRunCapability;
  readonly #api: InternalGeoApiClient;
  readonly #governance: PlasticPromiseGovernanceClient;

  constructor(options: {
    readonly api: InternalGeoApiClient;
    readonly governance: PlasticPromiseGovernanceClient;
    readonly model: string;
  }) {
    this.#api = options.api;
    this.#governance = options.governance;
    this.capability = { mode: "fixture", provider: "fixture", model: options.model };
  }

  async run(
    principal: Readonly<ActorContext>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const parsed = fixtureRunSchema.parse(input);
    if (parsed.tenantId !== principal.tenantId) {
      throw new Error("Agent run tenant does not match the authenticated principal");
    }
    const { articleTemplateId, ...flowInput } = parsed;
    return new FixtureDraftingRuntime(
      createGovernedAgentRuntime(principal, this.#api, this.#governance, {
        allowFixtureDrafts: true,
      }),
    ).run(
      {
        ...flowInput,
        ...(articleTemplateId === undefined ? {} : { articleTemplateId }),
        executionLevel: parsed.platform === "ctrip_community" ? "assisted" : "dry_run",
      },
      signal,
    );
  }

  async authorAutomationDraft(): Promise<AutomationDraftAuthorResult> {
    throw new PiAgentRunError({ diagnosticReason: "provider_error" });
  }
}

export class RealPiAgentRunService implements PiAgentRunService {
  readonly capability: PiAgentRunCapability;
  readonly #api: InternalGeoApiClient;
  readonly #governance: PlasticPromiseGovernanceClient;
  readonly #model: Model<Api>;
  readonly #apiKey: string;
  readonly #thinkingLevel: ThinkingLevel | undefined;
  readonly #strictToolArguments: boolean;
  readonly #providerRetryDelaysMs: readonly number[];
  readonly #maxToolCalls: number;
  readonly #maxRepeatedToolCalls: number;

  constructor(options: {
    readonly api: InternalGeoApiClient;
    readonly governance: PlasticPromiseGovernanceClient;
    readonly provider: string;
    readonly model: Model<Api>;
    readonly modelId: string;
    readonly apiKey: string;
    readonly thinkingLevel?: ThinkingLevel;
    readonly strictToolArguments?: boolean;
    readonly providerRetryDelaysMs?: readonly number[];
    readonly maxToolCalls?: number;
    readonly maxRepeatedToolCalls?: number;
  }) {
    this.#api = options.api;
    this.#governance = options.governance;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#thinkingLevel = options.thinkingLevel;
    this.#strictToolArguments = options.strictToolArguments ?? false;
    this.#providerRetryDelaysMs = options.providerRetryDelaysMs ?? DEFAULT_PROVIDER_RETRY_DELAYS_MS;
    this.#maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_PI_TOOL_CALLS;
    this.#maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_PI_TOOL_CALLS;
    if (!Number.isSafeInteger(this.#maxToolCalls) || this.#maxToolCalls < 1) {
      throw new TypeError("maxToolCalls must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxRepeatedToolCalls) || this.#maxRepeatedToolCalls < 2) {
      throw new TypeError("maxRepeatedToolCalls must be at least 2");
    }
    this.capability = { mode: "pi", provider: options.provider, model: options.modelId };
  }

  async run(
    principal: Readonly<ActorContext>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const parsed = promptRunSchema.parse(input);
    if (parsed.draftScope !== undefined && parsed.draftScope.tenantId !== principal.tenantId) {
      throw new PiAgentRunError({ diagnosticReason: "tool_guard" });
    }
    const boundDraft =
      parsed.draftScope === undefined
        ? undefined
        : ({
            tenantId: parsed.draftScope.tenantId,
            brandId: parsed.draftScope.brandId,
            campaignId: parsed.draftScope.campaignId,
            targetPlatform: parsed.draftScope.targetPlatform,
            brief: parsed.draftScope.brief,
            idempotencyKey: parsed.draftScope.idempotencyKey,
            ...(parsed.draftScope.articleTemplateId === undefined
              ? {}
              : { articleTemplateId: parsed.draftScope.articleTemplateId }),
          } satisfies AutomationDraftAuthorInput);
    return this.#runPrompt(principal, parsed, signal, {
      ...(boundDraft === undefined ? {} : { boundAutomationDraft: boundDraft }),
      ...(parsed.requiredWorkflow === undefined
        ? {}
        : { requiredWorkflow: parsed.requiredWorkflow }),
    });
  }

  async authorAutomationDraft(
    principal: Readonly<ActorContext>,
    input: Readonly<AutomationDraftAuthorInput>,
    signal?: AbortSignal,
  ): Promise<AutomationDraftAuthorResult> {
    if (input.tenantId !== principal.tenantId) {
      throw new Error("Automation draft tenant does not match the authenticated principal");
    }
    let draftResult: unknown;
    const runResult = await this.#runPrompt(
      principal,
      {
        workflow: "prompt",
        brandId: input.brandId,
        targetPlatform: input.targetPlatform,
        prompt: [
          "Create exactly one original Chinese article draft for the governed automation run.",
          "Use only the available read/governance tools, then call geo_draft_proposal and stop after its first successful result. If the tool returns a correctable draft error, revise only the rejected content and retry before stopping.",
          "The server binds tenant, brand, campaign, target platform, full brief, and idempotency key; do not substitute them.",
          "Follow the server-selected automation diversity plan in the system prompt; do not replace its bound template, reader angle, composition, or CTA with a generic default.",
          ...(input.remediation === undefined
            ? []
            : [
                `This is remediation attempt ${input.remediation.attempt}/${input.remediation.maxAttempts}; apply every server-selected corrective action instead of paraphrasing the rejected draft.`,
              ]),
          `Full brief: ${input.brief}`,
        ].join("\n"),
      },
      signal,
      {
        boundAutomationDraft: input,
        onDraftProposal: (result) => {
          draftResult = result;
        },
        draftOnly: true,
      },
    );
    if (typeof draftResult !== "object" || draftResult === null || Array.isArray(draftResult)) {
      throw new PiAgentRunError({ diagnosticReason: "tool_guard" });
    }
    const result = draftResult as Readonly<Record<string, unknown>>;
    const contentItemId = idSchema.safeParse(result.contentItemId);
    const contentVersionId = idSchema.safeParse(result.contentVersionId);
    const trace =
      typeof runResult === "object" && runResult !== null && !Array.isArray(runResult)
        ? (runResult as Readonly<Record<string, unknown>>)
        : null;
    const providerRunId = idSchema.safeParse(trace?.providerRunId);
    const providerRequestId = trace?.providerRequestId;
    if (
      result.providerMode !== "authored" ||
      !contentItemId.success ||
      !contentVersionId.success ||
      trace?.providerMode !== "pi" ||
      !providerRunId.success ||
      (providerRequestId !== null &&
        (typeof providerRequestId !== "string" || providerRequestId.length === 0))
    ) {
      throw new PiAgentRunError({
        diagnosticReason: "tool_guard",
        lastToolName: "geo_draft_proposal",
      });
    }
    return {
      providerMode: "pi_authored",
      provider: this.capability.provider,
      model: this.capability.model,
      providerRunId: providerRunId.data,
      providerRequestId,
      contentItemId: contentItemId.data,
      contentVersionId: contentVersionId.data,
    };
  }

  async #runPrompt(
    principal: Readonly<ActorContext>,
    parsed: z.infer<typeof promptRunSchema>,
    signal?: AbortSignal,
    options: {
      readonly boundAutomationDraft?: Readonly<AutomationDraftAuthorInput>;
      readonly onDraftProposal?: (result: unknown) => void;
      readonly draftOnly?: boolean;
      readonly requiredWorkflow?: "draft_to_publication";
    } = {},
  ): Promise<unknown> {
    const taskId = randomUUID();
    const providerRunId = randomUUID();
    const brandAgentProfile =
      parsed.brandId === undefined
        ? null
        : await this.#api.getBrandAgentProfile(principal, parsed.brandId);
    if (
      parsed.brandId !== undefined &&
      (brandAgentProfile === null ||
        brandAgentProfile.brandId !== parsed.brandId ||
        brandAgentProfile.status !== "active")
    ) {
      throw new Error("Active Brand Agent Profile was not found for the selected brand");
    }
    const runtime = createGovernedAgentRuntime(principal, this.#api, this.#governance, {
      ...(parsed.targetPlatform === undefined
        ? {}
        : { draftTargetPlatform: parsed.targetPlatform }),
      ...(options.boundAutomationDraft === undefined
        ? {}
        : { boundAutomationDraft: options.boundAutomationDraft }),
      ...(options.onDraftProposal === undefined
        ? {}
        : { onDraftProposal: options.onDraftProposal }),
    });
    let toolCallCount = 0;
    let guardTriggered = false;
    let lastToolName: string | null = null;
    let lastDraftInputFailureCode: DraftInputFailureCode | null = null;
    let providerRequestSequence = 0;
    const toolCallCounts = new Map<string, number>();
    const toolAttempts = new Map<
      string,
      {
        readonly argumentKeys: readonly string[];
        readonly guardBoundary: boolean;
        readonly knownTool: boolean;
        prepared: boolean;
      }
    >();
    const successfulToolNames = new Set<string>();
    const failedToolNames = new Set<string>();
    let auditStatus: "passed" | "failed" | null = null;
    const boundDraft = options.boundAutomationDraft;
    const workflowOrder =
      options.draftOnly === true
        ? [...DRAFT_REQUIRED_TOOL_NAMES]
        : options.requiredWorkflow === "draft_to_publication"
          ? [
              ...DRAFT_REQUIRED_TOOL_NAMES,
              ...(boundDraft !== undefined &&
              BROWSER_ARTICLE_PLATFORMS.has(boundDraft.targetPlatform)
                ? ["geo_media_search_import" as const]
                : []),
              "geo_variant_preview" as const,
              "geo_audit_request" as const,
              "geo_publication_request" as const,
            ]
          : null;
    let workflowStep = 0;
    let workflowTail: Promise<void> = Promise.resolve();
    const workflowReleases = new Map<string, () => void>();
    const directDraftCallIds = new Set<string>();
    const workflowGuard: PiToolWorkflowGuard | undefined =
      workflowOrder === null
        ? undefined
        : {
            taskId,
            beforeToolCall: async (toolName, toolCallId) => {
              const previous = workflowTail;
              let release!: () => void;
              workflowTail = new Promise<void>((resolve) => {
                release = resolve;
              });
              await previous;
              const expected = workflowOrder[workflowStep];
              const allowBoundDirectDraftFallback =
                options.draftOnly === true &&
                workflowStep === 0 &&
                successfulToolNames.size === 0 &&
                toolName === "geo_draft_proposal";
              if (
                !allowBoundDirectDraftFallback &&
                (expected === undefined || toolName !== expected)
              ) {
                release();
                throw new Error(
                  `WORKFLOW_PRECONDITION_FAILED task=${taskId} expected=${expected ?? "complete"} received=${toolName}`,
                );
              }
              if (allowBoundDirectDraftFallback) directDraftCallIds.add(toolCallId);
              workflowReleases.set(toolCallId, release);
              console.info(
                JSON.stringify({
                  level: "info",
                  event: "agent_mcp.workflow_step_started",
                  taskId,
                  step: workflowStep + 1,
                  expectedTool: expected,
                  toolName,
                  toolCallId,
                }),
              );
            },
            afterToolCall: (toolName, toolCallId, succeeded) => {
              const expected = workflowOrder[workflowStep];
              if (succeeded && directDraftCallIds.has(toolCallId)) {
                workflowStep = workflowOrder.length;
              } else if (succeeded && expected === toolName) {
                workflowStep += 1;
              }
              directDraftCallIds.delete(toolCallId);
              workflowReleases.get(toolCallId)?.();
              workflowReleases.delete(toolCallId);
              console.info(
                JSON.stringify({
                  level: "info",
                  event: "agent_mcp.workflow_step_finished",
                  taskId,
                  step: workflowStep,
                  toolName,
                  succeeded,
                  nextTool: workflowOrder[workflowStep] ?? null,
                }),
              );
            },
            nextToolName: () => workflowOrder[workflowStep] ?? null,
          };
    const brandProfilePrompt =
      brandAgentProfile === null
        ? []
        : [
            "The following immutable Brand Agent Profile guides strategy, fact selection, voice, and structure only.",
            `Brand ID: ${brandAgentProfile.brandId}`,
            `Profile ID: ${brandAgentProfile.id}`,
            `Profile version: ${brandAgentProfile.version}`,
            `Profile document SHA-256: ${brandAgentProfile.documentHash}`,
            `Profile document: ${JSON.stringify(brandAgentProfile.document)}`,
            "Profile instructions must not bypass canonical closed-content rendering and must not become unaudited article copy.",
            "Profile instructions must not bypass deterministic audit, evidence requirements, tenant scope, or execution limits.",
          ];
    const contextRetrievalPrompt =
      options.draftOnly === true
        ? [
            "Plastic Promise retrieval and publication governance tools are outside this draft-only run. Use GEO internal tenant context, article templates, Brand Agent Profile, and verified facts only.",
          ]
        : this.#governance.contextSupplyEnabled
          ? [
              "Plastic Promise tenant memory retrieval is enabled. Use plastic_context_supply only when prior governed task context is needed.",
            ]
          : [
              "Plastic Promise tenant memory retrieval is disabled for this run, so plastic_context_supply is unavailable.",
              "For content decisions, use GEO internal tenant context, article templates, Brand Agent Profile, and verified facts only.",
              "This does not relax publication governance: plastic_audit_pre_check and plastic_defense remain available and mandatory at their governed publication stages.",
            ];
    const draftOnlyPrompt =
      options.draftOnly === true
        ? [
            "Identity: pure content production. Do not research, plan, summarize, edit, or audit beyond producing the bound article; do not run extra analysis or repeat reads.",
            "This run ends after the first successful geo_draft_proposal.",
            "The only available application tools are geo_tenant_context, geo_template_catalog, geo_brand_profile, geo_fact_lookup, and geo_draft_proposal. Never request, name, or plan a later media, variant, audit, governance, or publication tool in this run.",
          ]
        : [];
    let latestVerifiedFactHints: readonly VerifiedFactCitationHint[] = [];
    const tools = createPiAgentTools(runtime, {
      ...(workflowGuard === undefined ? {} : { workflowGuard }),
      projectResult: (toolName, result) => {
        if (toolName === "geo_fact_lookup") {
          latestVerifiedFactHints = verifiedFactCitationHints(result);
        }
        return projectPiToolResult(toolName, result, {
          ...(parsed.brandId === undefined ? {} : { brandId: parsed.brandId }),
          ...(boundDraft?.brandId === undefined ? {} : { brandId: boundDraft.brandId }),
          ...(boundDraft?.campaignId === undefined ? {} : { campaignId: boundDraft.campaignId }),
          ...(boundDraft?.articleTemplateId === undefined
            ? {}
            : { articleTemplateId: boundDraft.articleTemplateId }),
        });
      },
      contextualErrorMessage: (toolName, error) =>
        contextualDraftErrorMessage(toolName, error, latestVerifiedFactHints),
      ...(boundDraft === undefined
        ? {}
        : {
            argumentBindings: {
              geo_tenant_context: { tenantId: boundDraft.tenantId },
              geo_template_catalog: { tenantId: boundDraft.tenantId },
              geo_brand_profile: {
                tenantId: boundDraft.tenantId,
                brandId: boundDraft.brandId,
              },
              geo_fact_lookup: {
                tenantId: boundDraft.tenantId,
                brandId: boundDraft.brandId,
              },
              geo_draft_proposal: {
                tenantId: boundDraft.tenantId,
                brandId: boundDraft.brandId,
                campaignId: boundDraft.campaignId,
                brief: boundDraft.brief,
                targetPlatform: boundDraft.targetPlatform,
                idempotencyKey: boundDraft.idempotencyKey,
                ...(boundDraft.articleTemplateId === undefined
                  ? {}
                  : { articleTemplateId: boundDraft.articleTemplateId }),
              },
            },
          }),
    }).filter(
      (tool) =>
        (this.#governance.contextSupplyEnabled || tool.name !== "plastic_context_supply") &&
        (options.draftOnly !== true || isDraftRequiredToolName(tool.name)),
    );
    if (options.draftOnly === true && tools.some((tool) => !isDraftRequiredToolName(tool.name))) {
      throw new Error("Pure production draft agent must not receive editing or governance tools");
    }
    const requiredDraftToolName = () =>
      options.draftOnly === true ? nextMissingDraftToolName(successfulToolNames) : undefined;
    const agent = createRealPiRuntime({
      principal,
      model: this.#model,
      tools,
      ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
      requireToolChoice: options.draftOnly === true,
      ...(options.draftOnly === true ? { requiredToolName: requiredDraftToolName } : {}),
      strictToolArguments: this.#strictToolArguments,
      onPayload: (payload) => {
        providerRequestSequence += 1;
        console.info(
          JSON.stringify({
            level: "info",
            event: "agent_mcp.provider_request",
            taskId,
            providerRunId,
            sequence: providerRequestSequence,
            ...providerPayloadMetrics(payload),
          }),
        );
      },
      onResponse: (response) => {
        console.info(
          JSON.stringify({
            level: "info",
            event: "agent_mcp.provider_response",
            taskId,
            providerRunId,
            sequence: providerRequestSequence,
            status: response.status,
          }),
        );
      },
      authorizeResourceScope: (scopePrincipal, toolName, args) =>
        isPlasticPromiseAgentToolName(toolName)
          ? args.tenantId === scopePrincipal.tenantId
          : this.#api.authorizeResourceScope(scopePrincipal, toolName, args),
      systemPrompt: [
        ...(options.draftOnly === true
          ? [
              "Identity: pure content production machine. Turn the bound brief into one governed article draft and stop after geo_draft_proposal succeeds. You are not a researcher, editor, auditor, publisher, planner, or general assistant.",
            ]
          : options.requiredWorkflow === "draft_to_publication"
            ? [
                "Identity: governed GEO workflow executor. Complete the server-supplied draft-to-publication stages in order. You may call only the supplied MCP tools and must stop at any audit, governance, account, or platform boundary.",
              ]
            : [
                "Identity: tenant-scoped GEO content and operations agent. Follow the caller's requested workflow exactly and never invent a later stage or external side effect.",
              ]),
        `Task ID: ${taskId}. Use this task ID when reasoning about the current workflow; never mix results, IDs, or tool state from another task.`,
        `Authenticated tenant ID: ${principal.tenantId}.`,
        ...piGeoSkillSystemPrompt({
          workflow:
            options.draftOnly === true
              ? "draft-only"
              : options.requiredWorkflow === "draft_to_publication"
                ? "draft-to-publication"
                : "general",
        }),
        ...automationDiversitySystemPrompt(boundDraft?.diversityPlan),
        ...automationRemediationSystemPrompt(boundDraft?.remediation),
        "Use only the supplied tools. Treat facts and evidence returned by tools as authoritative.",
        "Tool-call discipline: make exactly one MCP tool call per step. Before every call, verify the previous required step succeeded and that the next tool is the one named by WORKFLOW_NEXT_STEP. Never call tools merely to fill turns, and never start two dependent calls concurrently.",
        "After every successful MCP result, read the WORKFLOW_NEXT_STEP reminder and call only that tool next. If there is no next tool, stop and return the completed stage; do not continue exploring.",
        "If a precondition says expectedTool=complete, the workflow is finished. Do not call another MCP tool.",
        "Before any call, confirm every required argument is present and comes from the authenticated tenant, the bound brief, or an earlier tool result. Fill missing arguments first; never guess IDs.",
        "If a tool call fails, do not invent, pad, or fake a result. Return the original error, fix only missing or rejected arguments, and retry the same step; do not repeat successful reads or skip ahead.",
        "If a human or manual review gate is active, stop there; never use an AI or audit tool to bypass the gate.",
        "Start every operational workflow with geo_tenant_context using the authenticated tenant ID; select only IDs returned by tenant-scoped tools.",
        "For content work, inspect geo_template_catalog and geo_brand_profile, then call geo_fact_lookup before geo_draft_proposal.",
        "geo_fact_lookup uses exact substring matching, not semantic search. The query must be one literal phrase of at most 12 Unicode characters copied from the brief or a verified claim. It must not contain spaces, `+`, a list, or an explanation. For a Japan brief, use `日本`; for a Beijing brief, use `北京`; for a service-boundary lookup, use `行程` or `合同`. Never send the full topic. It is never a space-joined keyword list. If the first lookup is empty, retry with one different short literal phrase before stopping.",
        "Templates define the article structure and GEO mechanisms only; never copy template prose as the article body, and never let a template weaken the mandatory commercial GEO objective installed by the Pi skill bundle.",
        "Treat platform limits from geo_template_catalog as hard constraints. For Ctrip Community keep the authored title between 5 and 20 Unicode characters, body between 60 and 3000 characters, and attach exactly 4 images before audit; place any required verbatim fact sentence in the summary or body when it would make the title too long.",
        "For every browser-published platform use exactly 1 cover and 3 inline images. Exact duplicate image bytes remain invalid, but different images may share a subject, setting, or composition.",
        "For every browser-published platform (Ctrip Community, Toutiao, Sohu, Baijiahao, Netease), include exactly 4 entries in authoredDraft.mediaSearchPlan: exactly 1 cover and 3 inline intents. Every query must be distinct, name a concrete visible subject from a real article section, and preferably combine Chinese destination wording with an English proper noun that Wikimedia Commons can resolve.",
        "Build each mediaSearchPlan entry by reading the exact `##` section it illustrates. Set sectionRef to that heading text, write query as one precise searchable phrase naming a visible landmark, transit, street, landscape, or interior, and add 2-3 shorter fallbackQueries (for example the English proper noun alone, a simplified Chinese phrase, or a narrower landmark name) the licensed search can actually resolve. Set retryBudget to 2 for provider-backed platforms so transient 429/5xx failures are retried before the intent is reported unfilled.",
        "Media search queries must describe photographic travel scenes that a vision model can verify from pixels: recognizable destination landmarks or exteriors, transit vehicles or station platforms, streets or neighborhoods, landscapes or parks, and other visible places directly discussed by the article. Never use passports, visa pages, identity documents, insurance forms, weather maps or screens, web pages, text posters, safety signs, directional signs, or other document-like subjects as the primary image intent.",
        "Each mediaSearchPlan rationale must identify the article section and visual evidence it supports. Any non-empty claimIds must already be cited by the authored prose; do not search for ratings, outcomes, facilities, seasons, or scenes that the article and verified facts do not support.",
        "Write the authored body as Markdown with at least two substantive `##` section headings; keep sections scannable and never flatten the article into one paragraph.",
        ...(options.draftOnly === true
          ? []
          : [
              "Do not call geo_media_production_request. No production image provider is approved. Images must come from the separate public-source or tenant-owned media-import flow with source attribution and bounded live inspection.",
              "For every browser-published platform, call geo_media_search_import exactly once after geo_draft_proposal using the returned clean contentVersionId, the same targetPlatform passed to geo_draft_proposal, and a new idempotency key. The tool searches licensed images, retries rejected candidates, and returns a finalContentVersionId with inspected media.",
              "After geo_media_search_import, use the returned finalContentVersionId for any explicitly requested geo_variant_preview, geo_audit_request, and geo_publication_request steps in the caller's governed workflow. If the caller does not explicitly request those later steps, stop and report the finalContentVersionId. A returned image with vision-audit:degraded evidence may continue; stop only when the media import is incomplete, fewer than four distinct images are present, or the version is fixture/media-free. Never rewrite degraded evidence as passed.",
            ]),
        "Write original Chinese title, summary, and body prose yourself. Supporting verified fact IDs in authoredDraft.titleClaimIds, authoredDraft.summaryClaimIds, body[].claimIds, and mediaSearchPlan[].claimIds are optional. Use only exact IDs returned by geo_fact_lookup. Before adding any fact ID, copy that tool's claim sentence verbatim into the title, summary, or body; if you cannot reproduce the exact sentence, leave that claimIds array empty. Never paraphrase a cited fact.",
        'geo_draft_proposal.authoredDraft accepts only this JSON shape: {"title":string,"titleClaimIds":string[],"summary":string,"summaryClaimIds":string[],"locationQuery"?:string,"body":[{"text":string,"claimIds":string[]}],"mediaSearchPlan"?:[{"query":string,"sectionRef":string,"fallbackQueries":string[],"retryBudget":number,"role":"cover"|"inline","rationale":string,"claimIds":string[]}]}. Put Markdown headings inside body[].text; do not add heading, sections, markdown, images, platform, metadata, or other wrapper properties. body must contain at least two substantive sections, each starting with a "## " heading line followed by paragraphs and optional "### " subheadings; never flatten the finished article into one long unbroken text. The final content version keeps this structure in bodyBlocks and bodyMarkdown.',
        "Never invent, inflate, or imply unsupported ratings, scores, rankings, complaint records, credentials, years of experience, customer counts, guarantees, or outcomes. If a brief asks for them and no matching verified fact is returned, omit the claim and state the limitation rather than making it sound plausible.",
        "Consumer-facing title, summary, and body must never mention GEO, Pi, agents, prompts, tools, tool names, fact IDs, audits, providers, models, retrieval, system responses, or other internal implementation details. Express an evidence limitation in reader-facing language such as '现有资料未说明' or omit it; never write that GEO or a tool did not return information.",
        "For Ctrip Community briefs, include authoredDraft.locationQuery with a real destination or city that the platform POI search can resolve; never invent a venue identifier.",
        "For every public-platform draft, set geo_draft_proposal.targetPlatform to the bound target platform. The server will create a source version with no tenant contact blocks. The authored title, summary, body, and image intents must contain zero phone numbers, WeChat terms or IDs, email addresses, websites, external links, QR codes, social handles, or other off-platform contact routes, even when they match an approved tenant contact.",
        "For Ctrip Community, keep the selected brand out of the title and summary when possible, but make the article commercially useful: the title must remain brand-free and the summary may contain at most one restrained brand reference. Express the buyer intent and service value without repeated branding. Put the exact selected brand displayName 1 to 3 times in the authored body. The first occurrence must be in the first substantive paragraph after the opening buyer answer and must appear before the second `##` heading; never defer the first brand mention to a later comparison, recommendation, or closing section. At least one occurrence must connect the brand to the reader's scenario or an evidence-backed service value; a footer-only attribution is insufficient.",
        "Without an explicit matching verified fact, never state or imply that the brand organized, wrote, prepared, published, verified, or endorsed the article or checklist; supplied the article's service experience; made the recommendations; or guarantees an outcome. Omit any unsupported operational role instead of making the brand sound like the content source.",
        "Lead with a buyer answer and evidence-backed service value, not generic education, a risk-only checklist, or empty promotion. Use a low-pressure on-page next step, but never use a hard-sell call to action such as contact now, book now, add WeChat, call a phone number, scan a QR code, limited-time offer, limited availability, or any off-platform contact route.",
        "The finished article must read as natural editorial soft promotion, not an SOP, compliance report, service manual, or audit transcript. Unless the brief inherently requires a sequence, do not organize the body around numbered steps, pre-departure checks, materials to prepare, warnings, or repeated 'first/second/finally' transitions. Build a coherent decision narrative around a plausible reader situation, concrete service value, evidence, and restrained recommendation.",
        "Use a first-person conversational voice, as if giving practical advice to a friend. Ground the article in concrete reader situations, real details from the brief, and verified facts. Prefer direct suggestions such as `你可以这样...`, questions, and reader dialogue over abstract instruction or professional jargon.",
        "A first-person observation such as `我发现...` may frame analysis without inventing a biography. Use an experience claim such as `有次我...` only when the brief or verified evidence supplies that experience; never fabricate travel, purchase, or service experience.",
        "Within the selected template, open by stating what problem this section will solve, develop two or three substantive points with concrete scenes, and close with the key action the reader can take. Preserve the selected template structure and verified meaning while improving voice and pacing.",
        "Remove formulaic AI phrasing: never use `综上所述`, `不难发现`, or `值得注意的是`; replace `因此` with `所以`, `实际上` with `其实`, and `相当` with `挺` when the wording remains natural. Do not force a perfect three-part syllogism or overuse `首先`, `其次`, and `最后`.",
        "Vary sentence length, split overlong paragraphs, and use short sentences for key information. Keep the prose specific and human, without changing core claims or stacking specialist terminology.",
        "Blend every required verbatim verified claim into an original paragraph with useful interpretation before or after it. Do not place multiple verified claims back-to-back, prefix them with labels such as 'verified fact' or 'evidence', or turn them into a claim inventory.",
        "For every verified fact ID referenced by authoredDraft, include the tool-returned claim text verbatim at least once in the final title, summary, or body. Do not paraphrase, shorten, translate, or alter that exact claim sentence; deterministic audit requires the complete verified text to appear in the rendered platform content. If the exact sentence is unavailable in the current transcript, remove the fact ID instead of guessing or paraphrasing it.",
        "Pass the original prose to geo_draft_proposal.authoredDraft. The server owns contact text, fact snapshots, canonical rendering, and audit provenance.",
        ...(options.draftOnly === true
          ? []
          : [
              "Create a platform payload only through geo_variant_preview, then run geo_audit_request before requesting any delivery action.",
              "Do not skip a workflow stage, invent a resource ID, or turn Profile instructions into unsupported facts.",
              "A reviewed browser-backed platform account may use unattended only when its sourced adapter, authenticated account runtime, tenant automation mode, audit, kill-switch and circuit-breaker gates allow it; otherwise use assisted and stop before final submit.",
              "Request executionLevel=unattended only when the selected server account advertises it. Never downgrade a rejected gate or bypass a required public readback.",
              "Never claim a Preview receipt is a live publication or that fixture visibility is a real Doubao/Qwen search.",
              "A deterministic audit and one-time grant are mandatory before any publication request.",
            ]),
        ...draftOnlyPrompt,
        ...contextRetrievalPrompt,
        ...brandProfilePrompt,
      ].join("\n"),
      getApiKey: () => this.#apiKey,
      afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
        const attempt = toolAttempts.get(toolCall.id);
        if (attempt !== undefined) attempt.prepared = true;
        if (
          options.draftOnly === true &&
          assistantMessage.content.filter((block) => block.type === "toolCall").length > 1
        ) {
          guardTriggered = true;
          return { terminate: true };
        }
        if (isError) {
          failedToolNames.add(toolCall.name);
        } else {
          successfulToolNames.add(toolCall.name);
          failedToolNames.delete(toolCall.name);
          if (
            toolCall.name === "geo_audit_request" &&
            typeof result.details === "object" &&
            result.details !== null &&
            !Array.isArray(result.details)
          ) {
            const status = (result.details as Readonly<Record<string, unknown>>).status;
            auditStatus = status === "passed" || status === "failed" ? status : null;
          }
        }
        if (options.draftOnly === true && toolCall.name === "geo_draft_proposal" && !isError) {
          return { terminate: true };
        }
        return undefined;
      },
    });
    const knownToolNames = new Set(tools.map((tool) => tool.name));
    const unsubscribeToolEvents = agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        if (guardTriggered) {
          agent.abort();
          throw new Error("Pi agent tool call guard reached");
        }
        toolCallCount += 1;
        lastToolName = event.toolName;
        const callKey = toolCallKey(event.toolName, event.args);
        const repeatedCount = (toolCallCounts.get(callKey) ?? 0) + 1;
        toolCallCounts.set(callKey, repeatedCount);
        const guardBoundary =
          toolCallCount >= this.#maxToolCalls || repeatedCount >= this.#maxRepeatedToolCalls;
        toolAttempts.set(event.toolCallId, {
          argumentKeys: safeToolArgumentKeys(event.args),
          guardBoundary,
          knownTool: knownToolNames.has(event.toolName),
          prepared: false,
        });
        if (guardBoundary) guardTriggered = true;
        return;
      }
      if (event.type === "tool_execution_end") {
        const attempt = toolAttempts.get(event.toolCallId);
        toolAttempts.delete(event.toolCallId);
        if (event.isError && attempt?.prepared === false) {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "agent_mcp.tool_rejected",
              taskId,
              providerRunId,
              toolName: event.toolName,
              argumentKeys: attempt.argumentKeys,
              errorCategory: preExecutionErrorCategory(attempt.knownTool, event.result),
              toolCallCount,
            }),
          );
        }
        if (event.toolName === "geo_draft_proposal" && event.isError) {
          lastDraftInputFailureCode =
            attempt?.prepared === false &&
            preExecutionErrorCategory(attempt.knownTool, event.result) === "argument_rejection"
              ? "AUTHORED_DRAFT_ARGUMENTS_INVALID"
              : draftInputFailureCode(event.result);
        }
        if (attempt?.guardBoundary === true) {
          agent.abort();
          throw new Error("Pi agent tool call guard reached");
        }
      }
    });
    assertRunActive(signal);
    const abortAgent = () => agent.abort();
    signal?.addEventListener("abort", abortAgent, { once: true });
    let completedResult:
      | {
          readonly providerMode: "pi";
          readonly provider: string;
          readonly model: string;
          readonly providerRunId: string;
          readonly providerRequestId: string | null;
          readonly response: string;
          readonly messageCount: number;
        }
      | undefined;
    try {
      const assertToolGuardInactive = () => {
        if (guardTriggered) {
          throw new PiAgentRunError({
            diagnosticReason: lastDraftInputFailureCode === null ? "tool_guard" : "draft_input",
            toolCallCount,
            lastToolName,
            ...(lastDraftInputFailureCode === null
              ? {}
              : { failureCode: lastDraftInputFailureCode }),
          });
        }
      };
      const continueAfterProviderFailures = async () => {
        let retryIndex = 0;
        while (agent.state.errorMessage !== undefined) {
          assertRunActive(signal);
          const retryDelayMs = this.#providerRetryDelaysMs[retryIndex];
          const messages = continuationTranscript(agent.state.messages);
          if (retryDelayMs === undefined || messages === null) {
            const failureClass = providerFailureClass(agent.state.errorMessage);
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "agent_mcp.provider_failure",
                taskId,
                providerRunId,
                sequence: providerRequestSequence,
                failureClass,
                ...providerFailureFingerprint(agent.state.errorMessage),
              }),
            );
            throw new PiAgentRunError({
              providerFailureClass: failureClass,
              toolCallCount,
              lastToolName,
            });
          }
          agent.state.messages = messages;
          retryIndex += 1;
          await waitForProviderRetry(retryDelayMs, signal);
          assertRunActive(signal);
          await agent.continue();
          assertToolGuardInactive();
        }
      };

      await agent.prompt(parsed.prompt);
      assertToolGuardInactive();
      await continueAfterProviderFailures();

      if (options.draftOnly === true && !successfulToolNames.has("geo_draft_proposal")) {
        for (
          let correctionAttempt = 0;
          correctionAttempt < MAX_DRAFT_CORRECTIVE_CONTINUATIONS;
          correctionAttempt += 1
        ) {
          assertRunActive(signal);
          await agent.prompt(
            [
              "Your previous response ended before the required automation draft tool call.",
              "Continue in this same transcript and complete the governed draft now; do not return more planning or prose outside a tool call.",
              "The transcript must contain successful geo_tenant_context, geo_template_catalog, geo_brand_profile, and geo_fact_lookup calls using tenant-scoped IDs; call any that are still missing.",
              "geo_tenant_context, geo_template_catalog, geo_brand_profile, and geo_fact_lookup are read-only context tools; do not call one again after it has already succeeded, and never call a tool that is not in the supplied tools list.",
              "The next and final call must be geo_draft_proposal with the bound brief and a complete authoredDraft object (title, titleClaimIds, summary, summaryClaimIds, body sections, and for browser platforms exactly four distinct mediaSearchPlan intents with one cover and three inline entries). Do not emit empty `{}` arguments; every required field must be present.",
              "Apply every correctable draft error already present in the transcript, then call geo_draft_proposal. If the retry reveals a different correctable draft error, fix that error in the next bounded continuation.",
              `This is corrective continuation ${correctionAttempt + 1} of ${MAX_DRAFT_CORRECTIVE_CONTINUATIONS}; never bypass a failed tool or any evidence, scope, or content gate.`,
            ].join("\n"),
          );
          assertToolGuardInactive();
          await continueAfterProviderFailures();
          if (successfulToolNames.has("geo_draft_proposal")) break;
          if (lastDraftInputFailureCode === null) break;
        }
        if (!successfulToolNames.has("geo_draft_proposal")) {
          throw new PiAgentRunError({
            diagnosticReason: lastDraftInputFailureCode === null ? "tool_guard" : "draft_input",
            toolCallCount,
            lastToolName,
            ...(lastDraftInputFailureCode === null
              ? {}
              : { failureCode: lastDraftInputFailureCode }),
          });
        }
      }

      if (options.requiredWorkflow === "draft_to_publication") {
        const requiredToolNames = [
          ...DRAFT_REQUIRED_TOOL_NAMES,
          ...(boundDraft !== undefined && BROWSER_ARTICLE_PLATFORMS.has(boundDraft.targetPlatform)
            ? ["geo_media_search_import"]
            : []),
          "geo_variant_preview",
          "geo_audit_request",
          "geo_publication_request",
        ] as const;
        const terminalMutationFailures = new Set([
          "geo_media_search_import",
          "geo_variant_preview",
          "geo_audit_request",
          "geo_publication_request",
        ]);
        const boundaryReached = () =>
          auditStatus === "failed" ||
          [...failedToolNames].some((toolName) => terminalMutationFailures.has(toolName));
        const missingRequiredTools = () =>
          requiredToolNames.filter((toolName) => !successfulToolNames.has(toolName));

        for (
          let correctionCount = 0;
          missingRequiredTools().length > 0 && !boundaryReached();
          correctionCount += 1
        ) {
          if (correctionCount >= requiredToolNames.length) {
            throw new PiAgentRunError({
              diagnosticReason: "tool_guard",
              toolCallCount,
              lastToolName,
            });
          }
          const missing = missingRequiredTools();
          assertRunActive(signal);
          await agent.prompt(
            [
              "Your previous response ended before the required governed workflow completed.",
              `Successful required stages: ${
                requiredToolNames
                  .filter((toolName) => successfulToolNames.has(toolName))
                  .join(", ") || "none"
              }.`,
              `Next missing required stage: ${missing[0]}.`,
              `Complete the remaining stages in this exact order: ${missing.join("; ")}.`,
              "Continue from the existing transcript and reuse every tool-returned resource ID. Do not repeat a successful mutation tool or return planning text instead of the next tool call.",
              "If media import is incomplete, the deterministic audit has blocking findings, or another governed mutation is rejected, stop at that boundary and report it. A visual audit failure recorded as vision-audit:degraded is an explicit warning and must not stop the workflow; never rewrite degraded evidence as passed.",
              "A normal completion response is allowed only after geo_publication_request succeeds or a governed boundary has been reported.",
            ].join("\n"),
          );
          assertToolGuardInactive();
          await continueAfterProviderFailures();
        }

        if (missingRequiredTools().length > 0 && !boundaryReached()) {
          throw new PiAgentRunError({
            diagnosticReason: "tool_guard",
            toolCallCount,
            lastToolName,
          });
        }
      }
      assertRunActive(signal);
      completedResult = {
        providerMode: "pi",
        provider: this.capability.provider,
        model: this.capability.model,
        providerRunId,
        providerRequestId: providerRequestId(agent.state.messages),
        response: finalAssistantText(agent.state.messages),
        messageCount: agent.state.messages.length,
      };
    } finally {
      signal?.removeEventListener("abort", abortAgent);
      unsubscribeToolEvents();
      for (const release of workflowReleases.values()) release();
      workflowReleases.clear();
      agent.abort();
      await agent.waitForIdle();
      agent.reset();
      toolAttempts.clear();
      toolCallCounts.clear();
      successfulToolNames.clear();
      failedToolNames.clear();
      directDraftCallIds.clear();
      console.info(
        JSON.stringify({
          level: "info",
          event: "agent_mcp.session_destroyed",
          taskId,
          providerRunId,
          outcome:
            completedResult !== undefined
              ? "completed"
              : signal?.aborted === true
                ? "cancelled"
                : "failed",
          remainingMessageCount: agent.state.messages.length,
          remainingPendingToolCallCount: agent.state.pendingToolCalls.size,
          hasQueuedMessages: agent.hasQueuedMessages(),
        }),
      );
    }
    if (completedResult === undefined) {
      throw new PiAgentRunError({
        diagnosticReason: "tool_guard",
        toolCallCount,
        lastToolName,
      });
    }
    return completedResult;
  }
}
