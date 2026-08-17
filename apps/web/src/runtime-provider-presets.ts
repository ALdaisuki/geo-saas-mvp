import type { RuntimeProviderConfigKey } from "./api.js";

/**
 * Boot presets for the runtime provider settings panel. These are the only
 * provider URLs and model names that change often; operators can still save
 * their own templates from the settings panel, which take precedence.
 */
export interface RuntimeProviderTemplate {
  readonly id: string;
  readonly name: string;
  readonly key: RuntimeProviderConfigKey;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly api: "openai-responses" | "openai-completions" | "";
  readonly completionsMode: "stream" | "json";
  readonly thinkingLevel: string;
  readonly reviewMode: "ai" | "manual" | "none";
  readonly apiKey: string;
  readonly createdAt: string;
}

export const RUNTIME_PROVIDER_CONFIG_KEYS: readonly RuntimeProviderConfigKey[] = [
  "agent_drafting",
  "agent_media_inspection",
  "media_search",
];

export const RUNTIME_PROVIDER_BUILTIN_TEMPLATES: readonly RuntimeProviderTemplate[] = [
  {
    id: "builtin:deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    key: "agent_drafting",
    provider: "openai-compatible",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    completionsMode: "json",
    thinkingLevel: "low",
    reviewMode: "ai",
    apiKey: "",
    createdAt: "builtin",
  },
  {
    id: "builtin:deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    key: "agent_drafting",
    provider: "openai-compatible",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    completionsMode: "json",
    thinkingLevel: "low",
    reviewMode: "ai",
    apiKey: "",
    createdAt: "builtin",
  },
  {
    id: "builtin:current-gpt-drafting",
    name: "当前 GPT · 写文章",
    key: "agent_drafting",
    provider: "openai-compatible",
    model: "gpt-5.6-sol",
    baseUrl: "https://aiapi.syuan.org/v1",
    api: "openai-responses",
    completionsMode: "stream",
    thinkingLevel: "low",
    reviewMode: "ai",
    apiKey: "",
    createdAt: "builtin",
  },
  {
    id: "builtin:current-gpt-vision",
    name: "当前 GPT · 图片审查",
    key: "agent_media_inspection",
    provider: "openai-compatible",
    model: "gpt-5.6-terra",
    baseUrl: "https://ai.jianyuebak.space/v1",
    api: "openai-responses",
    completionsMode: "stream",
    thinkingLevel: "high",
    reviewMode: "ai",
    apiKey: "",
    createdAt: "builtin",
  },
];
