import { createHash } from "node:crypto";

import type { PlasticPromiseGovernanceClient } from "@geo/agent";
import type { ThinkingLevel } from "@geo/agent/pi";
import { DEGRADED_MEDIA_INSPECTION_LABEL, MANUAL_MEDIA_REVIEW_LABEL } from "@geo/core";
import type { ActorContext } from "@geo/contracts";
import { z } from "zod";

import type { InternalGeoApiClient } from "./api-client.js";
import { jsonOpenAICompletionsModel } from "./json-openai-completions.js";
import {
  mediaInspectionInputSchema,
  PiVisionMediaInspectionService,
  type MediaInspectionService,
} from "./media-inspection-runner.js";
import {
  resolvePiServiceModels,
  type PiAgentModelConfig,
  type PiRuntimeModelConfiguration,
  type PiServiceRuntimeConfiguration,
} from "./model-config.js";
import {
  FixturePiAgentRunService,
  RealPiAgentRunService,
  type AutomationDraftAuthorResult,
  type PiAgentRunCapability,
  type PiAgentRunService,
} from "./pi-runner.js";
import type { MediaInspectionResult } from "./media-inspection-runner.js";

export const runtimeProviderConfigSectionSchema = z.object({
  configKey: z.enum(["agent_drafting", "agent_media_inspection", "media_search"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().nullable(),
  api: z.enum(["openai-responses", "openai-completions"]).nullable(),
  completionsMode: z.enum(["stream", "json"]),
  enabled: z.boolean(),
  apiKey: z.string().nullable().optional(),
  apiKeyMasked: z.string().nullable(),
  apiKeySet: z.boolean(),
  version: z.number().int(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  settings: z.record(z.string(), z.unknown()),
});

export const runtimeProviderConfigDocumentSchema = z.strictObject({
  schemaVersion: z.literal("geo.runtime-provider-config.v1"),
  sections: z.array(runtimeProviderConfigSectionSchema),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RuntimeProviderConfigDocument = z.infer<typeof runtimeProviderConfigDocumentSchema>;

export interface RuntimeProviderConfigurationSource {
  getRuntimeProviderConfiguration(
    principal: Readonly<ActorContext>,
  ): Promise<RuntimeProviderConfigDocument>;
}

export interface ResolvedRuntimePiServices {
  readonly drafting: PiRuntimeModelConfiguration | "fixture" | null;
  readonly mediaInspection: PiRuntimeModelConfiguration | null;
}

export function resolveRuntimePiServices(
  document: RuntimeProviderConfigDocument,
): ResolvedRuntimePiServices {
  const drafting = document.sections.find((section) => section.configKey === "agent_drafting");
  const mediaInspection = document.sections.find(
    (section) => section.configKey === "agent_media_inspection",
  );
  const resolvedDrafting = runtimeModel(drafting);
  const resolvedMediaInspection = runtimeModel(mediaInspection);
  const inheritedMediaInspection =
    mediaInspection === undefined ? resolvedDrafting : resolvedMediaInspection;
  return {
    drafting: resolvedDrafting,
    mediaInspection: inheritedMediaInspection === "fixture" ? null : inheritedMediaInspection,
  };
}

function runtimeModel(
  section: z.infer<typeof runtimeProviderConfigSectionSchema> | undefined,
): PiRuntimeModelConfiguration | "fixture" | null {
  if (section === undefined || !section.enabled) return null;
  if (section.provider === "fixture") return "fixture";
  const apiKey = section.apiKey ?? null;
  if (apiKey === null || apiKey.length === 0) return null;
  const config: PiRuntimeModelConfiguration = {
    provider: section.provider,
    modelId: section.model,
    apiKey,
    completionsMode: section.completionsMode,
    ...(section.api === null ? {} : { api: section.api }),
    ...(section.baseUrl === null ? {} : { baseUrl: section.baseUrl }),
  };
  return config;
}

const RUNTIME_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const MANUAL_MEDIA_REVIEW_EVALUATOR = "manual-review-operator";
const MANUAL_MEDIA_REVIEW_EVALUATOR_VERSION = "1.0.0";
const MANUAL_MEDIA_REVIEW_MODEL = "manual-review-queue-v1";
const NO_VISION_EVALUATOR = "no-vision-pass-through";
const NO_VISION_EVALUATOR_VERSION = "1.0.0";
const NO_VISION_MODEL = "no-vision-v1";
const MANUAL_MEDIA_REVIEW_LABELS = Object.freeze([
  DEGRADED_MEDIA_INSPECTION_LABEL,
  "vision-audit:manual",
  MANUAL_MEDIA_REVIEW_LABEL,
  "ocr:unavailable",
  "travel-relevance:unverified",
  "contact-text:unverified",
  "vision-confidence:unavailable",
  "safety:unverified",
  "scene-signature:unverified:unknown:unknown",
]);

function manualMediaReviewResponseHash(assetSha256: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "geo.manual-media-review.v1",
        assetSha256,
        evaluator: MANUAL_MEDIA_REVIEW_EVALUATOR,
        reviewedBy: "manual-operator",
      }),
    )
    .digest("hex");
}

function noVisionResponseHash(assetSha256: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "geo.no-vision-pass-through.v1",
        assetSha256,
        evaluator: NO_VISION_EVALUATOR,
        reviewMode: "none",
      }),
    )
    .digest("hex");
}

function runtimeThinkingLevel(
  document: RuntimeProviderConfigDocument | null,
  fallback: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const section = document?.sections.find((candidate) => candidate.configKey === "agent_drafting");
  const value = section?.settings?.thinkingLevel;
  if (typeof value === "string" && RUNTIME_THINKING_LEVELS.has(value)) {
    return value as ThinkingLevel;
  }
  return fallback;
}

class UnavailablePiAgentRunService implements PiAgentRunService {
  readonly capability: PiAgentRunCapability = {
    mode: "fixture",
    provider: "unconfigured",
    model: "unconfigured",
  };

  async run(): Promise<never> {
    throw new Error("Agent provider is not configured");
  }

  async authorAutomationDraft(): Promise<never> {
    throw new Error("Agent provider is not configured");
  }
}

class UnavailableMediaInspectionService implements MediaInspectionService {
  readonly capability: MediaInspectionService["capability"] = {
    mode: "live",
    provider: "unconfigured",
    model: "unconfigured",
  };

  async inspect(): Promise<never> {
    throw new Error("Media inspection provider is not configured");
  }
}

class ManualMediaInspectionService implements MediaInspectionService {
  readonly capability: MediaInspectionService["capability"] = {
    mode: "live",
    provider: MANUAL_MEDIA_REVIEW_EVALUATOR,
    model: MANUAL_MEDIA_REVIEW_MODEL,
  };

  async inspect(
    _principal: Readonly<ActorContext>,
    input: unknown,
  ): Promise<Readonly<MediaInspectionResult>> {
    const parsed = mediaInspectionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Media inspection input is invalid");
    }
    return {
      assetSha256: parsed.data.assetSha256,
      // This is a verified handoff to the manual queue, not a failed vision inference.
      // The API separately withholds the publication grant until an operator confirms
      // the exact media snapshot.
      status: "passed",
      evaluator: MANUAL_MEDIA_REVIEW_EVALUATOR,
      evaluatorMode: "live",
      evaluatorVersion: MANUAL_MEDIA_REVIEW_EVALUATOR_VERSION,
      model: MANUAL_MEDIA_REVIEW_MODEL,
      responseSha256: manualMediaReviewResponseHash(parsed.data.assetSha256),
      providerRequestId: null,
      ocrText: "",
      labels: MANUAL_MEDIA_REVIEW_LABELS,
    };
  }
}

class NoVisionMediaInspectionService implements MediaInspectionService {
  readonly capability: MediaInspectionService["capability"] = {
    mode: "live",
    provider: NO_VISION_EVALUATOR,
    model: NO_VISION_MODEL,
  };

  async inspect(
    _principal: Readonly<ActorContext>,
    input: unknown,
  ): Promise<Readonly<MediaInspectionResult>> {
    const parsed = mediaInspectionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Media inspection input is invalid");
    }
    return {
      assetSha256: parsed.data.assetSha256,
      // This mode deliberately skips model inference. It still emits an explicit,
      // signed inspection record so media integrity and publication audit checks
      // continue to have a traceable evidence snapshot.
      status: "passed",
      evaluator: NO_VISION_EVALUATOR,
      evaluatorMode: "live",
      evaluatorVersion: NO_VISION_EVALUATOR_VERSION,
      model: NO_VISION_MODEL,
      responseSha256: noVisionResponseHash(parsed.data.assetSha256),
      providerRequestId: null,
      ocrText: "",
      labels: [
        "vision-audit:skipped",
        "vision-audit:none",
        "ocr:unavailable",
        "travel-relevance:unverified",
        "contact-text:unverified",
        "vision-confidence:unavailable",
        "safety:unverified",
        "scene-signature:unverified:unknown:unknown",
      ],
    };
  }
}

export class HotReloadingPiAgentRunService implements PiAgentRunService {
  readonly #source: RuntimeProviderConfigurationSource;
  readonly #api: InternalGeoApiClient;
  readonly #governance: PlasticPromiseGovernanceClient;
  readonly #fallbackFixtureModel: string | null;
  readonly #fallbackRuntime: PiServiceRuntimeConfiguration | null;
  readonly #thinkingLevel: ThinkingLevel | undefined;
  readonly #strictToolArguments: boolean;
  readonly #maxToolCalls: number;
  readonly #maxRepeatedToolCalls: number;
  readonly #allowRuntimeRealProviders: boolean;
  #current: PiAgentRunService;
  #documentKey: string | null = null;

  constructor(options: {
    readonly source: RuntimeProviderConfigurationSource;
    readonly api: InternalGeoApiClient;
    readonly governance: PlasticPromiseGovernanceClient;
    readonly fallbackFixtureModel?: string;
    readonly fallbackRuntime?: PiServiceRuntimeConfiguration;
    readonly thinkingLevel?: ThinkingLevel;
    readonly strictToolArguments?: boolean;
    readonly maxToolCalls?: number;
    readonly maxRepeatedToolCalls?: number;
    readonly allowRuntimeRealProviders?: boolean;
  }) {
    this.#source = options.source;
    this.#api = options.api;
    this.#governance = options.governance;
    this.#fallbackFixtureModel = options.fallbackFixtureModel ?? null;
    this.#fallbackRuntime = options.fallbackRuntime ?? null;
    this.#thinkingLevel = options.thinkingLevel;
    this.#strictToolArguments = options.strictToolArguments ?? false;
    this.#maxToolCalls = options.maxToolCalls ?? 64;
    this.#maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? 3;
    this.#allowRuntimeRealProviders = options.allowRuntimeRealProviders ?? true;
    this.#current = this.#buildRunner(null);
  }

  get capability(): PiAgentRunCapability {
    return this.#current.capability;
  }

  async refreshConfiguration(principal: Readonly<ActorContext>): Promise<void> {
    await this.#refresh(principal);
  }

  async run(
    principal: Readonly<ActorContext>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.#refresh(principal);
    return this.#current.run(principal, input, signal);
  }

  async authorAutomationDraft(
    principal: Readonly<ActorContext>,
    input: Parameters<NonNullable<PiAgentRunService["authorAutomationDraft"]>>[1],
    signal?: AbortSignal,
  ): Promise<AutomationDraftAuthorResult> {
    await this.#refresh(principal);
    if (this.#current.authorAutomationDraft === undefined) {
      throw new Error("Agent provider does not support automation drafts");
    }
    return this.#current.authorAutomationDraft(principal, input, signal);
  }

  async #refresh(principal: Readonly<ActorContext>): Promise<void> {
    let document: RuntimeProviderConfigDocument;
    try {
      document = await this.#source.getRuntimeProviderConfiguration(principal);
    } catch (error) {
      if (this.#current instanceof UnavailablePiAgentRunService) throw error;
      console.error(
        JSON.stringify({
          level: "warn",
          event: "agent_mcp.runtime_provider_config_refresh_failed",
          tenantId: principal.tenantId,
          requestId: principal.requestId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      return;
    }
    const documentKey = JSON.stringify(
      document.sections.map((section) => ({
        configKey: section.configKey,
        provider: section.provider,
        model: section.model,
        baseUrl: section.baseUrl,
        api: section.api,
        completionsMode: section.completionsMode,
        enabled: section.enabled,
        apiKey: section.apiKey ?? null,
        settings: section.settings,
        version: section.version,
      })),
    );
    if (documentKey === this.#documentKey) return;
    this.#current = this.#buildRunner(document);
    this.#documentKey = documentKey;
  }

  #buildRunner(document: RuntimeProviderConfigDocument | null): PiAgentRunService {
    const runtime: ResolvedRuntimePiServices =
      document === null
        ? {
            drafting: this.#fallbackFixtureModel === null ? null : "fixture",
            mediaInspection: null,
          }
        : resolveRuntimePiServices(document);
    const drafting = runtime.drafting;
    if (drafting === null) {
      const fallback = this.#fallbackRuntime?.drafting;
      if (fallback !== undefined && typeof fallback !== "string") {
        return this.#buildRealRunner(fallback);
      }
      if (this.#fallbackFixtureModel !== null) {
        return new FixturePiAgentRunService({
          api: this.#api,
          governance: this.#governance,
          model: this.#fallbackFixtureModel,
        });
      }
      return new UnavailablePiAgentRunService();
    }
    if (drafting === "fixture") {
      return new FixturePiAgentRunService({
        api: this.#api,
        governance: this.#governance,
        model:
          document?.sections.find((section) => section.configKey === "agent_drafting")?.model ??
          "fixture-geo-writer-v1",
      });
    }
    if (!this.#allowRuntimeRealProviders) {
      return this.#buildRunner(null);
    }
    return this.#buildRealRunner(drafting, runtimeThinkingLevel(document, this.#thinkingLevel));
  }

  #buildRealRunner(
    config: PiRuntimeModelConfiguration,
    thinkingLevel: ThinkingLevel | undefined = this.#thinkingLevel,
  ): PiAgentRunService {
    const resolvedModels = resolvePiServiceModels({
      drafting: config,
      mediaInspection: config,
    });
    const effectiveModel =
      config.completionsMode === "json"
        ? jsonOpenAICompletionsModel(resolvedModels.drafting.model)
        : resolvedModels.drafting.model;
    return new RealPiAgentRunService({
      api: this.#api,
      governance: this.#governance,
      provider: resolvedModels.drafting.provider,
      model: effectiveModel,
      modelId: config.modelId,
      apiKey: config.apiKey,
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      strictToolArguments: this.#strictToolArguments,
      maxToolCalls: this.#maxToolCalls,
      maxRepeatedToolCalls: this.#maxRepeatedToolCalls,
    });
  }
}

export class HotReloadingMediaInspectionService implements MediaInspectionService {
  readonly #source: RuntimeProviderConfigurationSource;
  readonly #fallback: PiRuntimeModelConfiguration | null;
  readonly #allowRuntimeRealProviders: boolean;
  #current: MediaInspectionService;
  #documentKey: string | null = null;

  constructor(options: {
    readonly source: RuntimeProviderConfigurationSource;
    readonly fallback?: PiRuntimeModelConfiguration;
    readonly allowRuntimeRealProviders?: boolean;
  }) {
    this.#source = options.source;
    this.#fallback = options.fallback ?? null;
    this.#allowRuntimeRealProviders = options.allowRuntimeRealProviders ?? true;
    this.#current =
      this.#fallback === null || !this.#allowRuntimeRealProviders
        ? new ManualMediaInspectionService()
        : this.#buildInspector(this.#fallback);
  }

  get capability(): MediaInspectionService["capability"] {
    return this.#current.capability;
  }

  async refreshConfiguration(principal: Readonly<ActorContext>): Promise<void> {
    await this.#refresh(principal);
  }

  async inspect(
    principal: Readonly<ActorContext>,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<MediaInspectionResult>> {
    await this.#refresh(principal);
    return this.#current.inspect(principal, input, signal);
  }

  async #refresh(principal: Readonly<ActorContext>): Promise<void> {
    let document: RuntimeProviderConfigDocument;
    try {
      document = await this.#source.getRuntimeProviderConfiguration(principal);
    } catch (error) {
      if (this.#current instanceof UnavailableMediaInspectionService) throw error;
      console.error(
        JSON.stringify({
          level: "warn",
          event: "agent_mcp.media_inspection_config_refresh_failed",
          tenantId: principal.tenantId,
          requestId: principal.requestId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      return;
    }
    const documentKey = JSON.stringify(
      document.sections.map((section) => ({
        configKey: section.configKey,
        provider: section.provider,
        model: section.model,
        baseUrl: section.baseUrl,
        api: section.api,
        completionsMode: section.completionsMode,
        enabled: section.enabled,
        apiKey: section.apiKey ?? null,
        version: section.version,
      })),
    );
    if (documentKey === this.#documentKey) return;
    const section = document.sections.find(
      (candidate) => candidate.configKey === "agent_media_inspection",
    );
    if (section?.settings?.reviewMode === "none") {
      this.#current = new NoVisionMediaInspectionService();
      this.#documentKey = documentKey;
      return;
    }
    const manualReviewRequested =
      section !== undefined && (!section.enabled || section.settings?.reviewMode === "manual");
    if (manualReviewRequested) {
      this.#current = new ManualMediaInspectionService();
      this.#documentKey = documentKey;
      return;
    }
    const runtime = resolveRuntimePiServices(document).mediaInspection;
    if (runtime === null) {
      this.#current =
        section === undefined && this.#fallback !== null && this.#allowRuntimeRealProviders
          ? this.#buildInspector(this.#fallback)
          : new ManualMediaInspectionService();
      this.#documentKey = documentKey;
      return;
    }
    this.#current = this.#allowRuntimeRealProviders
      ? this.#buildInspector(runtime)
      : this.#fallback === null
        ? new ManualMediaInspectionService()
        : this.#buildInspector(this.#fallback);
    this.#documentKey = documentKey;
  }

  #buildInspector(config: PiRuntimeModelConfiguration): MediaInspectionService {
    const resolvedModels = resolvePiServiceModels({
      drafting: config,
      mediaInspection: config,
    });
    const effectiveModel =
      config.completionsMode === "json"
        ? jsonOpenAICompletionsModel(resolvedModels.mediaInspection.model)
        : resolvedModels.mediaInspection.model;
    return new PiVisionMediaInspectionService({
      model: effectiveModel,
      modelId: config.modelId,
      provider: resolvedModels.mediaInspection.provider,
      apiKey: config.apiKey,
    });
  }
}

export function runtimeModelConfig(
  config: PiAgentModelConfig & {
    readonly apiKey: string;
    readonly completionsMode?: "stream" | "json";
  },
): PiRuntimeModelConfiguration {
  return {
    ...config,
    completionsMode: config.completionsMode ?? "stream",
  };
}
