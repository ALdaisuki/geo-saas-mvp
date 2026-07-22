import { isIP } from "node:net";

import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export const OPENAI_RESPONSES_API = "openai-responses";
export const OPENAI_COMPLETIONS_API = "openai-completions";

export interface PiAgentModelConfig {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly api?: string;
}

export interface ResolvedPiAgentModel {
  readonly provider: string;
  readonly model: Model<Api>;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return normalized === "::1";
}

function parseCompatibleBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("AGENT_BASE_URL is required for AGENT_PROVIDER=openai-compatible");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AGENT_BASE_URL must be a valid absolute URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("AGENT_BASE_URL must not contain embedded credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("AGENT_BASE_URL must not contain a query string or fragment");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error("AGENT_BASE_URL must use HTTPS unless it targets a loopback host");
  }

  return url.href.replace(/\/$/u, "");
}

export function resolvePiAgentModel(config: PiAgentModelConfig): ResolvedPiAgentModel {
  if (config.modelId.trim().length === 0) throw new Error("AGENT_MODEL must not be empty");
  if (config.provider === OPENAI_COMPATIBLE_PROVIDER) {
    const baseUrl = parseCompatibleBaseUrl(config.baseUrl);
    const api = config.api ?? OPENAI_RESPONSES_API;
    if (api !== OPENAI_RESPONSES_API && api !== OPENAI_COMPLETIONS_API) {
      throw new Error("AGENT_API must be openai-responses or openai-completions");
    }
    const template = (getModels("openai") as readonly Model<Api>[]).find(
      (candidate) => candidate.id === "gpt-5",
    );
    if (template === undefined)
      throw new Error("Pi's OpenAI Responses model template is unavailable");
    const model =
      api === OPENAI_COMPLETIONS_API
        ? ({
            ...template,
            id: config.modelId,
            name: config.modelId,
            api,
            provider: config.provider,
            baseUrl,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsStrictMode: false,
              sendSessionAffinityHeaders: false,
            },
          } as Model<Api>)
        : ({
            ...template,
            id: config.modelId,
            name: config.modelId,
            provider: config.provider,
            baseUrl,
          } as Model<Api>);
    return {
      provider: config.provider,
      model,
    };
  }

  if (config.api !== undefined && config.api.trim().length > 0) {
    throw new Error("AGENT_API is only supported by AGENT_PROVIDER=openai-compatible");
  }
  if (config.baseUrl !== undefined && config.baseUrl.trim().length > 0) {
    throw new Error("AGENT_BASE_URL is only supported by AGENT_PROVIDER=openai-compatible");
  }
  const knownProvider = getProviders().find((provider) => provider === config.provider);
  if (knownProvider === undefined) throw new Error("AGENT_PROVIDER is not supported by Pi");
  const model = (getModels(knownProvider) as readonly Model<Api>[]).find(
    (candidate) => candidate.id === config.modelId,
  );
  if (model === undefined) throw new Error("AGENT_MODEL is not available for AGENT_PROVIDER");
  return { provider: knownProvider, model };
}
