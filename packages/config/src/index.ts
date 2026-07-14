import { z } from "zod";

const booleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(9021),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  DATABASE_ADMIN_URL: z.string().url().optional(),
  DATABASE_IDENTITY_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  PLASTIC_PROMISE_MCP_URL: z.string().url().optional(),
  PLASTIC_PROMISE_MCP_AUTHORIZATION: z.string().min(1).optional(),
  EVIDENCE_STORAGE_DIR: z.string().min(1).default(".data/evidence"),
  AGENT_PROVIDER: z.string().min(1).default("fixture"),
  AGENT_MODEL: z.string().min(1).default("fixture-geo-writer-v1"),
  DOUBAO_ADAPTER: z.enum(["fixture", "manual", "api"]).default("fixture"),
  QWEN_ADAPTER: z.enum(["fixture", "manual", "api"]).default("fixture"),
  DOUBAO_API_KEY: z.string().min(1).optional(),
  DOUBAO_BASE_URL: z.string().url().optional(),
  DOUBAO_MODEL: z.string().min(1).optional(),
  QWEN_API_KEY: z.string().min(1).optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  QWEN_MODEL: z.string().min(1).optional(),
  ENABLE_BROWSER_ASSISTED: booleanStringSchema,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv {
  return serverEnvSchema.parse(input);
}

export const webEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url().default("http://127.0.0.1:4100"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
