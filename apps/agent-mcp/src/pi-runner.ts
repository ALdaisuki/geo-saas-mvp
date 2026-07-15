import {
  FixtureDraftingRuntime,
  GovernedAgentRuntime,
  isPlasticPromiseAgentToolName,
  type GeoApplicationToolInvoker,
  type PlasticPromiseGovernanceClient,
} from "@geo/agent";
import { createPiAgentTools, createRealPiRuntime } from "@geo/agent/pi";
import { idSchema, type ActorContext } from "@geo/contracts";
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
    idempotencyKey: z.string().trim().min(1).max(180),
  })
  .strict();

const promptRunSchema = z
  .object({
    workflow: z.literal("prompt"),
    prompt: z.string().trim().min(1).max(30_000),
  })
  .strict();

export interface PiAgentRunCapability {
  readonly mode: "fixture" | "pi";
  readonly provider: string;
  readonly model: string;
}

export interface PiAgentRunService {
  readonly capability: PiAgentRunCapability;
  run(principal: Readonly<ActorContext>, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export class PiAgentRunError extends Error {
  readonly code = "AGENT_PROVIDER_FAILED";
  readonly statusCode = 502;

  constructor() {
    super("Configured Pi provider failed to complete the agent run");
    this.name = "PiAgentRunError";
  }
}

export function createGovernedAgentRuntime(
  principal: Readonly<ActorContext>,
  api: InternalGeoApiClient,
  governance: PlasticPromiseGovernanceClient,
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
    invoke: (toolName, args) =>
      invokeGeoMcpTool({
        toolName,
        args,
        principal,
        api,
        authorizeScope,
      }),
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
    return new FixtureDraftingRuntime(
      createGovernedAgentRuntime(principal, this.#api, this.#governance),
    ).run(
      {
        ...parsed,
        executionLevel: "dry_run",
      },
      signal,
    );
  }
}

export class RealPiAgentRunService implements PiAgentRunService {
  readonly capability: PiAgentRunCapability;
  readonly #api: InternalGeoApiClient;
  readonly #governance: PlasticPromiseGovernanceClient;
  readonly #model: Model<Api>;
  readonly #apiKey: string;

  constructor(options: {
    readonly api: InternalGeoApiClient;
    readonly governance: PlasticPromiseGovernanceClient;
    readonly provider: string;
    readonly model: Model<Api>;
    readonly modelId: string;
    readonly apiKey: string;
  }) {
    this.#api = options.api;
    this.#governance = options.governance;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.capability = { mode: "pi", provider: options.provider, model: options.modelId };
  }

  async run(
    principal: Readonly<ActorContext>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const parsed = promptRunSchema.parse(input);
    const runtime = createGovernedAgentRuntime(principal, this.#api, this.#governance);
    const agent = createRealPiRuntime({
      principal,
      model: this.#model,
      tools: createPiAgentTools(runtime),
      authorizeResourceScope: (scopePrincipal, toolName, args) =>
        isPlasticPromiseAgentToolName(toolName)
          ? args.tenantId === scopePrincipal.tenantId
          : this.#api.authorizeResourceScope(scopePrincipal, toolName, args),
      systemPrompt: [
        "You are the tenant-scoped GEO operations agent.",
        `Authenticated tenant ID: ${principal.tenantId}.`,
        "Use only the supplied tools. Treat facts and evidence returned by tools as authoritative.",
        "Toutiao, Sohu, and Ctrip Community are manual_only and dry_run only.",
        "Never claim a Preview receipt is a live publication or that fixture visibility is a real Doubao/Qwen search.",
        "A deterministic audit and one-time grant are mandatory before any publication request.",
      ].join("\n"),
      getApiKey: () => this.#apiKey,
    });
    if (signal?.aborted) throw new Error("Pi agent run was aborted");
    const abortAgent = () => agent.abort();
    signal?.addEventListener("abort", abortAgent, { once: true });
    try {
      await agent.prompt(parsed.prompt);
    } finally {
      signal?.removeEventListener("abort", abortAgent);
    }
    if (signal?.aborted) throw new Error("Pi agent run was aborted");
    if (agent.state.errorMessage !== undefined) {
      throw new PiAgentRunError();
    }
    return {
      providerMode: "pi",
      provider: this.capability.provider,
      model: this.capability.model,
      response: finalAssistantText(agent.state.messages),
      messageCount: agent.state.messages.length,
    };
  }
}
