import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@geo/db";
import { z } from "zod";

export const RUNTIME_PROVIDER_CONFIG_KEYS = [
  "agent_drafting",
  "agent_media_inspection",
  "media_search",
] as const;
export type RuntimeProviderConfigKey = (typeof RUNTIME_PROVIDER_CONFIG_KEYS)[number];

export const runtimeProviderConfigSectionInputSchema = z.strictObject({
  configKey: z.enum(RUNTIME_PROVIDER_CONFIG_KEYS),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  baseUrl: z.string().trim().max(2048).nullable().optional(),
  api: z.enum(["openai-responses", "openai-completions"]).nullable().optional(),
  completionsMode: z.enum(["stream", "json"]).default("stream"),
  enabled: z.boolean().default(true),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  version: z.number().int().min(1).max(1_000_000),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const runtimeProviderConfigUpdateSchema = z.strictObject({
  sections: z.array(runtimeProviderConfigSectionInputSchema).min(1).max(20),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type RuntimeProviderConfigUpdate = z.infer<typeof runtimeProviderConfigUpdateSchema>;

export const runtimeProviderConfigModelCatalogSchema = z.strictObject({
  configKey: z.enum(RUNTIME_PROVIDER_CONFIG_KEYS),
  baseUrl: z.string().trim().max(2048).optional(),
  apiKey: z.string().trim().max(4096).optional(),
});
export type RuntimeProviderConfigModelCatalogInput = z.infer<
  typeof runtimeProviderConfigModelCatalogSchema
>;

export const runtimeProviderConfigSectionViewSchema = z.object({
  configKey: z.enum(RUNTIME_PROVIDER_CONFIG_KEYS),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(500),
  baseUrl: z.string().max(2048).nullable(),
  api: z.enum(["openai-responses", "openai-completions"]).nullable(),
  completionsMode: z.enum(["stream", "json"]),
  enabled: z.boolean(),
  apiKey: z.string().max(4096).nullable().optional(),
  apiKeyMasked: z.string().nullable(),
  apiKeySet: z.boolean(),
  version: z.number().int().min(1).max(1_000_000),
  updatedBy: z.string().min(1).max(200),
  updatedAt: z.string().datetime({ offset: true }),
  settings: z.record(z.string(), z.unknown()),
});

export const runtimeProviderConfigDocumentSchema = z.strictObject({
  schemaVersion: z.literal("geo.runtime-provider-config.v1"),
  sections: z.array(runtimeProviderConfigSectionViewSchema),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RuntimeProviderConfigDocument = z.infer<typeof runtimeProviderConfigDocumentSchema>;

export interface RuntimeProviderConfigurationContext {
  readonly actorId: string;
}

export interface RuntimeProviderConfigurationController {
  getDocument(options: {
    readonly includeSecrets: boolean;
  }): Promise<RuntimeProviderConfigDocument>;
  updateSections(
    context: RuntimeProviderConfigurationContext,
    input: RuntimeProviderConfigUpdate,
  ): Promise<RuntimeProviderConfigDocument>;
  listModels(input: RuntimeProviderConfigModelCatalogInput): Promise<readonly string[]>;
}

export class RuntimeProviderConfigurationConflictError extends Error {
  readonly code = "RUNTIME_PROVIDER_CONFIG_CONFLICT";

  constructor(configKey: string) {
    super(`Runtime provider configuration ${configKey} changed concurrently`);
    this.name = "RuntimeProviderConfigurationConflictError";
  }
}

interface RuntimeProviderConfigurationRow {
  readonly config_key: RuntimeProviderConfigKey;
  readonly provider: string;
  readonly model: string;
  readonly base_url: string | null;
  readonly api: "openai-responses" | "openai-completions" | null;
  readonly completions_mode: "stream" | "json";
  readonly api_key: string | null;
  readonly enabled: boolean;
  readonly settings: unknown;
  readonly version: number;
  readonly updated_by: string;
  readonly updated_at: Date;
}

function maskApiKey(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-4)}`;
}

function runtimeProviderConfigSectionView(
  row: RuntimeProviderConfigurationRow,
  includeSecrets: boolean,
): z.infer<typeof runtimeProviderConfigSectionViewSchema> {
  const apiKey = row.api_key;
  return {
    configKey: row.config_key,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    api: row.api,
    completionsMode: row.completions_mode,
    enabled: row.enabled,
    ...(includeSecrets && apiKey !== null ? { apiKey } : {}),
    apiKeyMasked: apiKey === null ? null : maskApiKey(apiKey),
    apiKeySet: apiKey !== null,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
    settings: (typeof row.settings === "object" && row.settings !== null
      ? row.settings
      : {}) as Record<string, unknown>,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeModelCatalogBaseUrl(value: string | null | undefined): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new Error("模型目录需要 baseUrl");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl 必须是合法的绝对 URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("baseUrl 不得包含内嵌凭据");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("baseUrl 不得包含查询参数或片段");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127\./u.test(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("baseUrl 必须使用 HTTPS 或指向本机回环地址");
  }
  return url.href.replace(/\/$/u, "");
}

export class PostgresRuntimeProviderConfigurationStore implements RuntimeProviderConfigurationController {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async getDocument(options: {
    readonly includeSecrets: boolean;
  }): Promise<RuntimeProviderConfigDocument> {
    return this.#database.transaction().execute(async (transaction) => {
      await sql`set local role geo_runtime`.execute(transaction);
      return this.#readDocument(transaction, options.includeSecrets);
    });
  }

  async updateSections(
    context: RuntimeProviderConfigurationContext,
    input: RuntimeProviderConfigUpdate,
  ): Promise<RuntimeProviderConfigDocument> {
    return this.#database.transaction().execute(async (transaction) => {
      await sql`set local role geo_runtime`.execute(transaction);
      for (const section of input.sections) {
        const existing = await sql<RuntimeProviderConfigurationRow>`
          select * from geo.runtime_provider_configurations
          where config_key = ${section.configKey}
          for update
        `.execute(transaction);
        const current = existing.rows[0];
        if (current === undefined) {
          if (section.version !== 1) {
            throw new RuntimeProviderConfigurationConflictError(section.configKey);
          }
          await sql`
            insert into geo.runtime_provider_configurations (
              config_key, provider, model, base_url, api, completions_mode,
              api_key, enabled, settings, version, updated_by
            ) values (
              ${section.configKey}, ${section.provider}, ${section.model},
              ${section.baseUrl ?? null}, ${section.api ?? null}, ${section.completionsMode},
              ${section.apiKey ?? null}, ${section.enabled},
              ${jsonText(section.settings ?? {})}::jsonb, 1, ${context.actorId}
            )
          `.execute(transaction);
          continue;
        }
        if (current.version !== section.version) {
          throw new RuntimeProviderConfigurationConflictError(section.configKey);
        }
        const updated = await sql<RuntimeProviderConfigurationRow>`
          update geo.runtime_provider_configurations
          set provider = ${section.provider},
              model = ${section.model},
              base_url = ${section.baseUrl === undefined ? current.base_url : section.baseUrl},
              api = ${section.api === undefined ? current.api : section.api},
              completions_mode = ${section.completionsMode},
              api_key = ${section.apiKey === undefined ? current.api_key : section.apiKey},
              enabled = ${section.enabled},
              settings = ${jsonText(section.settings ?? current.settings)}::jsonb,
              version = version + 1,
              updated_by = ${context.actorId}
          where config_key = ${section.configKey} and version = ${section.version}
          returning *
        `.execute(transaction);
        if (updated.rows[0] === undefined) {
          throw new RuntimeProviderConfigurationConflictError(section.configKey);
        }
      }
      return this.#readDocument(transaction, false);
    });
  }

  async listModels(input: RuntimeProviderConfigModelCatalogInput): Promise<readonly string[]> {
    return this.#database.transaction().execute(async (transaction) => {
      await sql`set local role geo_runtime`.execute(transaction);
      const result = await sql<RuntimeProviderConfigurationRow>`
        select * from geo.runtime_provider_configurations
        where config_key = ${input.configKey}
      `.execute(transaction);
      const current = result.rows[0];
      const baseUrl = normalizeModelCatalogBaseUrl(input.baseUrl ?? current?.base_url ?? null);
      const apiKey = input.apiKey ?? current?.api_key ?? null;
      if (apiKey === null || apiKey.trim().length === 0) {
        throw new Error("模型目录需要 API Key");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        throw new Error(`模型目录请求失败: ${message}`, { cause: error });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(`模型目录请求失败: HTTP ${response.status} ${response.statusText}`);
      }
      const payload = (await response.json()) as { data?: readonly unknown[] };
      if (!Array.isArray(payload.data)) {
        throw new Error("模型目录响应缺少 data 数组");
      }
      const models: string[] = [];
      for (const entry of payload.data) {
        if (typeof entry !== "object" || entry === null || !("id" in entry)) continue;
        const id = (entry as { readonly id?: unknown }).id;
        if (typeof id === "string" && id.length > 0 && !models.includes(id)) {
          models.push(id);
        }
      }
      if (models.length === 0) {
        throw new Error("模型目录为空");
      }
      return models;
    });
  }

  async #readDocument(
    transaction: Transaction<Database>,
    includeSecrets: boolean,
  ): Promise<RuntimeProviderConfigDocument> {
    const result = await sql<RuntimeProviderConfigurationRow>`
      select * from geo.runtime_provider_configurations
      order by config_key
    `.execute(transaction);
    const sections = result.rows.map((row) =>
      runtimeProviderConfigSectionView(row, includeSecrets),
    );
    return {
      schemaVersion: "geo.runtime-provider-config.v1",
      sections,
      updatedAt:
        sections.length === 0
          ? new Date(0).toISOString()
          : new Date(
              Math.max(...sections.map((section) => Date.parse(section.updatedAt))),
            ).toISOString(),
    };
  }
}
