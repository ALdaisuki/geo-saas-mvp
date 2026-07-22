import {
  FixtureDraftingRuntime,
  GovernedAgentRuntime,
  isPlasticPromiseAgentToolName,
  type GeoApplicationToolInvoker,
  type PlasticPromiseGovernanceClient,
} from "@geo/agent";
import { createPiAgentTools, createRealPiRuntime } from "@geo/agent/pi";
import type { ThinkingLevel } from "@geo/agent/pi";
import { idSchema, type ActorContext, type Platform } from "@geo/contracts";
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
    platform: z.enum(["toutiao", "sohu", "ctrip_community"]),
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

const promptRunSchema = z
  .object({
    workflow: z.literal("prompt"),
    brandId: idSchema.optional(),
    targetPlatform: z.enum(["toutiao", "sohu", "ctrip_community"]).optional(),
    prompt: z.string().trim().min(1).max(30_000),
  })
  .strict();

const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000] as const;
const DEFAULT_MAX_PI_TOOL_CALLS = 64;
const DEFAULT_MAX_REPEATED_PI_TOOL_CALLS = 3;

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
  readonly targetPlatform: Platform;
  readonly brief: string;
  readonly idempotencyKey: string;
}

export interface AutomationDraftAuthorResult {
  readonly providerMode: "pi_authored";
  readonly provider: string;
  readonly model: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
}

export class PiAgentRunError extends Error {
  readonly code = "AGENT_PROVIDER_FAILED";
  readonly statusCode = 502;
  readonly diagnosticReason: "provider_error" | "tool_guard";
  readonly toolCallCount: number;
  readonly lastToolName: string | null;

  constructor(options?: {
    readonly diagnosticReason?: "provider_error" | "tool_guard";
    readonly toolCallCount?: number;
    readonly lastToolName?: string | null;
  }) {
    super("Configured Pi provider failed to complete the agent run");
    this.name = "PiAgentRunError";
    this.diagnosticReason = options?.diagnosticReason ?? "provider_error";
    this.toolCallCount = options?.toolCallCount ?? 0;
    this.lastToolName = options?.lastToolName ?? null;
  }
}

export function createGovernedAgentRuntime(
  principal: Readonly<ActorContext>,
  api: InternalGeoApiClient,
  governance: PlasticPromiseGovernanceClient,
  options: {
    readonly draftTargetPlatform?: Platform;
    readonly boundAutomationDraft?: Readonly<AutomationDraftAuthorInput>;
    readonly onDraftProposal?: (result: unknown) => void;
  } = {},
): GovernedAgentRuntime {
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
      const result = await invokeGeoMcpTool({
        toolName,
        args: effectiveArgs,
        principal,
        api,
        authorizeScope,
      });
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
      createGovernedAgentRuntime(principal, this.#api, this.#governance),
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
    readonly providerRetryDelaysMs?: readonly number[];
    readonly maxToolCalls?: number;
    readonly maxRepeatedToolCalls?: number;
  }) {
    this.#api = options.api;
    this.#governance = options.governance;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#thinkingLevel = options.thinkingLevel;
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
    return this.#runPrompt(principal, parsed, signal);
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
    await this.#runPrompt(
      principal,
      {
        workflow: "prompt",
        brandId: input.brandId,
        targetPlatform: input.targetPlatform,
        prompt: [
          "Create exactly one original Chinese article draft for the governed automation run.",
          "Use only the available read/governance tools, then call geo_draft_proposal exactly once and stop.",
          "The server binds tenant, brand, campaign, target platform, full brief, and idempotency key; do not substitute them.",
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
    if (!contentItemId.success || !contentVersionId.success) {
      throw new PiAgentRunError({ diagnosticReason: "tool_guard", lastToolName: "geo_draft_proposal" });
    }
    return {
      providerMode: "pi_authored",
      provider: this.capability.provider,
      model: this.capability.model,
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
    } = {},
  ): Promise<unknown> {
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
    const toolCallCounts = new Map<string, number>();
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
    const tools = createPiAgentTools(runtime).filter(
      (tool) =>
        options.draftOnly !== true ||
        [
          "plastic_context_supply",
          "plastic_audit_pre_check",
          "plastic_defense",
          "geo_tenant_context",
          "geo_template_catalog",
          "geo_brand_profile",
          "geo_fact_lookup",
          "geo_draft_proposal",
        ].includes(tool.name),
    );
    const agent = createRealPiRuntime({
      principal,
      model: this.#model,
      tools,
      ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
      authorizeResourceScope: (scopePrincipal, toolName, args) =>
        isPlasticPromiseAgentToolName(toolName)
          ? args.tenantId === scopePrincipal.tenantId
          : this.#api.authorizeResourceScope(scopePrincipal, toolName, args),
      systemPrompt: [
        "You are the tenant-scoped GEO operations agent.",
        `Authenticated tenant ID: ${principal.tenantId}.`,
        "Use only the supplied tools. Treat facts and evidence returned by tools as authoritative.",
        "Start every operational workflow with geo_tenant_context using the authenticated tenant ID; select only IDs returned by tenant-scoped tools.",
        "For content work, inspect geo_template_catalog and geo_brand_profile, then call geo_fact_lookup before geo_draft_proposal.",
        "geo_fact_lookup uses exact substring matching, not semantic search. The query must be one literal phrase of at most 12 Unicode characters copied from the brief or a verified claim. It must not contain spaces, `+`, a list, or an explanation. For a Japan brief, use `日本`; for a Beijing brief, use `北京`; for a contact lookup, use `热线` or `微信`. Never send the full topic. It is never a space-joined keyword list. If the first lookup is empty, retry with one different short literal phrase before stopping.",
        "Templates define the article structure and GEO mechanisms only; never copy template prose as the article body.",
        "Treat platform limits from geo_template_catalog as hard constraints. For Ctrip Community keep the authored title between 5 and 20 Unicode characters, body between 60 and 3000 characters, and attach 4 to 5 visually distinct images before audit; place any required verbatim fact sentence in the summary or body when it would make the title too long.",
        "For Ctrip Community default to 5 images: exactly 1 cover and 4 inline images. Each image must have a different primary subject, setting, or composition signature; resized, recropped, or re-encoded copies do not count as different images.",
        "For Ctrip Community, include exactly 5 entries in authoredDraft.mediaSearchPlan: exactly 1 cover and 4 inline intents. Every query must be distinct, name a concrete visible subject from a real article section, and preferably combine Chinese destination wording with an English proper noun that Wikimedia Commons can resolve.",
        "Media search queries must describe photographic travel scenes that a vision model can verify from pixels: recognizable destination landmarks or exteriors, transit vehicles or station platforms, streets or neighborhoods, landscapes or parks, and other visible places directly discussed by the article. Never use passports, visa pages, identity documents, insurance forms, weather maps or screens, web pages, text posters, safety signs, directional signs, or other document-like subjects as the primary image intent.",
        "Each mediaSearchPlan rationale must identify the article section and visual evidence it supports. Use only claim IDs already cited by the authored prose; do not search for ratings, outcomes, facilities, seasons, or scenes that the article and verified facts do not support.",
        "Write the authored body as Markdown with at least two substantive `##` section headings; keep sections scannable and never flatten the article into one paragraph.",
        "Do not call geo_media_production_request. No production image provider is approved. Images must come from the separate tenant-owned or licensed media-import flow with rights evidence and live inspection.",
        "For Ctrip Community, call geo_media_search_import exactly once after geo_draft_proposal using the returned clean contentVersionId and a new idempotency key. The tool searches licensed images, retries rejected candidates, and returns a finalContentVersionId with inspected media.",
        "After geo_media_search_import, stop and report the finalContentVersionId. If licensed search is disabled or fewer than four distinct images pass inspection, stop at that boundary; never create a variant, audit, or publication request from a fixture, partially filled, or media-free version.",
        "Write original Chinese title, summary, and body prose yourself. Every authored title, summary, and body section must include its own supporting verified fact IDs in authoredDraft.titleClaimIds, authoredDraft.summaryClaimIds, or body[].claimIds.",
        "Never invent, inflate, or imply unsupported ratings, scores, rankings, complaint records, credentials, years of experience, customer counts, guarantees, or outcomes. If a brief asks for them and no matching verified fact is returned, omit the claim and state the limitation rather than making it sound plausible.",
        "For Ctrip Community briefs, include authoredDraft.locationQuery with a real destination or city that the platform POI search can resolve; never invent a venue identifier.",
        "For a Ctrip Community draft, set geo_draft_proposal.targetPlatform to ctrip_community. The server will create a source version with no tenant contacts; never place a phone number, WeChat ID, email, website, or other contact detail in authored prose or image intents.",
        "For Ctrip Community, without contact details does not mean without the brand. After reading geo_brand_profile, mention the selected brand naturally once and no more than twice in the authored body, as the content organizer, source of service experience, or verification helper. Lead with useful travel guidance, not promotion.",
        "Do not put the brand in the Ctrip title, repeat it in every section, or use a hard-sell call to action such as contact now, book now, add WeChat, call a phone number, scan a QR code, limited-time offer, or limited availability.",
        "For every verified fact ID referenced by authoredDraft, include the tool-returned claim text verbatim at least once in the final title, summary, or body. Do not paraphrase, shorten, translate, or alter that exact claim sentence; deterministic audit requires the complete verified text to appear in the rendered platform content.",
        "Pass the original prose to geo_draft_proposal.authoredDraft. The server owns contact text, fact snapshots, canonical rendering, and audit provenance.",
        "Create a platform payload only through geo_variant_preview, then run geo_audit_request before requesting any delivery action.",
        "Do not skip a workflow stage, invent a resource ID, or turn Profile instructions into unsupported facts.",
        "Toutiao and Sohu remain dry_run only.",
        "Ctrip Community may use unattended only when the reviewed adapter, current platform-readback capability evidence, tenant automation mode, audit, kill-switch and circuit-breaker gates allow it; otherwise use assisted and stop before final submit.",
        "For the current reviewed Ctrip unattended adapter, request executionLevel=unattended when the server account advertises it. Never downgrade a rejected gate or bypass a required readback.",
        "Never claim a Preview receipt is a live publication or that fixture visibility is a real Doubao/Qwen search.",
        "A deterministic audit and one-time grant are mandatory before any publication request.",
        ...brandProfilePrompt,
      ].join("\n"),
      getApiKey: () => this.#apiKey,
      afterToolCall: async ({ toolCall, args }) => {
        toolCallCount += 1;
        lastToolName = toolCall.name;
        const callKey = `${toolCall.name}:${JSON.stringify(args)}`;
        const repeatedCount = (toolCallCounts.get(callKey) ?? 0) + 1;
        toolCallCounts.set(callKey, repeatedCount);
        if (toolCallCount >= this.#maxToolCalls || repeatedCount >= this.#maxRepeatedToolCalls) {
          guardTriggered = true;
          return { terminate: true };
        }
        if (options.draftOnly === true && toolCall.name === "geo_draft_proposal") {
          return { terminate: true };
        }
        return undefined;
      },
    });
    assertRunActive(signal);
    const abortAgent = () => agent.abort();
    signal?.addEventListener("abort", abortAgent, { once: true });
    try {
      await agent.prompt(parsed.prompt);
      if (guardTriggered) {
        throw new PiAgentRunError({
          diagnosticReason: "tool_guard",
          toolCallCount,
          lastToolName,
        });
      }
      let retryIndex = 0;
      while (agent.state.errorMessage !== undefined) {
        assertRunActive(signal);
        const retryDelayMs = this.#providerRetryDelaysMs[retryIndex];
        const messages = continuationTranscript(agent.state.messages);
        if (retryDelayMs === undefined || messages === null) {
          throw new PiAgentRunError({ toolCallCount, lastToolName });
        }
        agent.state.messages = messages;
        retryIndex += 1;
        await waitForProviderRetry(retryDelayMs, signal);
        assertRunActive(signal);
        await agent.continue();
      }
    } finally {
      signal?.removeEventListener("abort", abortAgent);
    }
    assertRunActive(signal);
    return {
      providerMode: "pi",
      provider: this.capability.provider,
      model: this.capability.model,
      response: finalAssistantText(agent.state.messages),
      messageCount: agent.state.messages.length,
    };
  }
}
