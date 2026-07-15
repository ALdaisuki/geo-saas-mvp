import { z } from "zod";

const PLACEHOLDER_MARKER = "replace-";

function containsCheckedInPlaceholder(value: string): boolean {
  return value.toLowerCase().includes(PLACEHOLDER_MARKER);
}

function decodedUrlPassword(value: string): string {
  const password = new URL(value).password;
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

function rejectPlaceholder(
  value: string | undefined,
  path: string,
  context: z.RefinementCtx,
): void {
  if (value !== undefined && containsCheckedInPlaceholder(value)) {
    context.addIssue({
      code: "custom",
      message: `${path} contains a checked-in placeholder`,
      path: [path],
    });
  }
}

const productionSecretSchema = z
  .string()
  .min(1)
  .refine((value) => !containsCheckedInPlaceholder(value), {
    message: "Production secret contains a checked-in placeholder",
  });

const productionLongSecretSchema = z
  .string()
  .min(32)
  .refine((value) => !containsCheckedInPlaceholder(value), {
    message: "Production secret contains a checked-in placeholder",
  });

const booleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const serverEnvBaseSchema = z.object({
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
  AGENT_API_KEY: z.string().min(1).optional(),
  DOUBAO_ADAPTER: z.literal("fixture").default("fixture"),
  QWEN_ADAPTER: z.literal("fixture").default("fixture"),
  DOUBAO_API_KEY: z.string().min(1).optional(),
  DOUBAO_BASE_URL: z.string().url().optional(),
  DOUBAO_MODEL: z.string().min(1).optional(),
  QWEN_API_KEY: z.string().min(1).optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  QWEN_MODEL: z.string().min(1).optional(),
  ENABLE_BROWSER_ASSISTED: booleanStringSchema,
});

export const serverEnvSchema = serverEnvBaseSchema.superRefine((environment, context) => {
  if (environment.NODE_ENV !== "production") return;

  rejectPlaceholder(decodedUrlPassword(environment.DATABASE_URL), "DATABASE_URL", context);
  if (environment.DATABASE_ADMIN_URL !== undefined) {
    rejectPlaceholder(
      decodedUrlPassword(environment.DATABASE_ADMIN_URL),
      "DATABASE_ADMIN_URL",
      context,
    );
  }
  if (environment.DATABASE_IDENTITY_URL !== undefined) {
    rejectPlaceholder(
      decodedUrlPassword(environment.DATABASE_IDENTITY_URL),
      "DATABASE_IDENTITY_URL",
      context,
    );
  }
  rejectPlaceholder(environment.SESSION_SECRET, "SESSION_SECRET", context);
  rejectPlaceholder(environment.AGENT_API_KEY, "AGENT_API_KEY", context);
  rejectPlaceholder(
    environment.PLASTIC_PROMISE_MCP_AUTHORIZATION,
    "PLASTIC_PROMISE_MCP_AUTHORIZATION",
    context,
  );
  rejectPlaceholder(environment.DOUBAO_API_KEY, "DOUBAO_API_KEY", context);
  rejectPlaceholder(environment.QWEN_API_KEY, "QWEN_API_KEY", context);
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function loadServerEnv(input: NodeJS.ProcessEnv = process.env): ServerEnv {
  return serverEnvSchema.parse(input);
}

export const productionDeploymentEnvSchema = z.object({
  NODE_ENV: z.literal("production").default("production"),
  POSTGRES_ADMIN_PASSWORD: productionSecretSchema,
  GEO_API_DB_PASSWORD: productionSecretSchema,
  GEO_WORKER_DB_PASSWORD: productionSecretSchema,
  GEO_IDENTITY_DB_PASSWORD: productionSecretSchema,
  SESSION_SECRET: productionLongSecretSchema,
  MCP_PRINCIPALS_JSON: productionSecretSchema,
  AGENT_API_KEY: productionSecretSchema.optional(),
  GEO_BOOTSTRAP_PASSWORD: productionSecretSchema.optional(),
  PLASTIC_PROMISE_MCP_AUTHORIZATION: productionSecretSchema.optional(),
  DOUBAO_API_KEY: productionSecretSchema.optional(),
  QWEN_API_KEY: productionSecretSchema.optional(),
});

export type ProductionDeploymentEnv = z.infer<typeof productionDeploymentEnvSchema>;

export function loadProductionDeploymentEnv(
  input: NodeJS.ProcessEnv = process.env,
): ProductionDeploymentEnv {
  return productionDeploymentEnvSchema.parse(input);
}

export const webEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url().default("http://127.0.0.1:4100"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
