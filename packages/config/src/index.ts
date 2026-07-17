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
const optionalProductionSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  productionSecretSchema.optional(),
);

const booleanStringSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const deploymentProfileSchema = z.enum(["standard", "customer_demo"]).default("standard");
const governanceModeSchema = z.enum(["external", "demo_fixture"]).default("external");
const optionalUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);
const optionalSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

function validateGovernanceEnvironment(
  environment: {
    readonly APP_ORIGIN?: string | undefined;
    readonly AGENT_PROVIDER: string;
    readonly GEO_DEPLOYMENT_PROFILE: "standard" | "customer_demo";
    readonly GEO_GOVERNANCE_MODE: "external" | "demo_fixture";
    readonly PLASTIC_PROMISE_MCP_URL?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    environment.GEO_GOVERNANCE_MODE === "demo_fixture" &&
    environment.GEO_DEPLOYMENT_PROFILE !== "customer_demo"
  ) {
    context.addIssue({
      code: "custom",
      message: "Demo governance is restricted to GEO_DEPLOYMENT_PROFILE=customer_demo",
      path: ["GEO_GOVERNANCE_MODE"],
    });
  }
  if (
    environment.GEO_DEPLOYMENT_PROFILE === "customer_demo" &&
    environment.GEO_GOVERNANCE_MODE !== "demo_fixture"
  ) {
    context.addIssue({
      code: "custom",
      message: "The customer demo profile requires demo_fixture governance",
      path: ["GEO_DEPLOYMENT_PROFILE"],
    });
  }
  if (
    environment.GEO_GOVERNANCE_MODE === "demo_fixture" &&
    environment.AGENT_PROVIDER !== "fixture"
  ) {
    context.addIssue({
      code: "custom",
      message: "Demo governance can only run with the fixture Pi provider",
      path: ["AGENT_PROVIDER"],
    });
  }
  if (
    environment.GEO_DEPLOYMENT_PROFILE === "customer_demo" &&
    environment.APP_ORIGIN !== undefined
  ) {
    const origin = new URL(environment.APP_ORIGIN);
    if (!(["127.0.0.1", "localhost", "::1"] as readonly string[]).includes(origin.hostname)) {
      context.addIssue({
        code: "custom",
        message: "The customer demo origin must be loopback-only",
        path: ["APP_ORIGIN"],
      });
    }
  }
}

const agentBaseUrlSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  }, "Agent base URL must use HTTPS unless it targets a loopback host")
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "Agent base URL must not contain embedded credentials")
  .refine((value) => {
    const url = new URL(value);
    return url.search.length === 0 && url.hash.length === 0;
  }, "Agent base URL must not contain a query string or fragment");

interface AgentEnvironment {
  readonly AGENT_PROVIDER: string;
  readonly AGENT_API_KEY?: string | undefined;
  readonly AGENT_BASE_URL?: string | undefined;
}

function validateAgentEnvironment(environment: AgentEnvironment, context: z.RefinementCtx): void {
  const compatible = environment.AGENT_PROVIDER === "openai-compatible";
  if (compatible && environment.AGENT_BASE_URL === undefined) {
    context.addIssue({
      code: "custom",
      message: "AGENT_BASE_URL is required for AGENT_PROVIDER=openai-compatible",
      path: ["AGENT_BASE_URL"],
    });
  }
  if (!compatible && environment.AGENT_BASE_URL !== undefined) {
    context.addIssue({
      code: "custom",
      message: "AGENT_BASE_URL is only supported by AGENT_PROVIDER=openai-compatible",
      path: ["AGENT_BASE_URL"],
    });
  }
  if (environment.AGENT_PROVIDER !== "fixture" && environment.AGENT_API_KEY === undefined) {
    context.addIssue({
      code: "custom",
      message: "AGENT_API_KEY is required for a real Pi provider",
      path: ["AGENT_API_KEY"],
    });
  }
}

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
  GEO_DEPLOYMENT_PROFILE: deploymentProfileSchema,
  GEO_GOVERNANCE_MODE: governanceModeSchema,
  PLASTIC_PROMISE_MCP_URL: optionalUrlSchema,
  PLASTIC_PROMISE_MCP_AUTHORIZATION: optionalSecretSchema,
  EVIDENCE_STORAGE_DIR: z.string().min(1).default(".data/evidence"),
  GEO_MEDIA_PROVIDER: z.enum(["disabled", "fixture"]).default("disabled"),
  GEO_MEDIA_OBJECT_ROOT: z.string().min(1).default(".data/media"),
  AGENT_PROVIDER: z.string().min(1).default("fixture"),
  AGENT_MODEL: z.string().min(1).default("fixture-geo-writer-v1"),
  AGENT_BASE_URL: agentBaseUrlSchema.optional(),
  AGENT_API_KEY: z.string().min(1).optional(),
  AGENT_GATEWAY_URL: z.string().url().optional(),
  AGENT_GATEWAY_CREDENTIALS_JSON: z.string().min(1).optional(),
  CTRIP_BRIDGE_GATEWAY_URL: z.string().url().optional(),
  CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: z.string().min(1).optional(),
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
  validateAgentEnvironment(environment, context);
  validateGovernanceEnvironment(environment, context);
  if (
    (environment.AGENT_GATEWAY_URL === undefined) !==
    (environment.AGENT_GATEWAY_CREDENTIALS_JSON === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "AGENT_GATEWAY_URL and AGENT_GATEWAY_CREDENTIALS_JSON must be configured together",
      path: ["AGENT_GATEWAY_URL"],
    });
  }
  if (
    (environment.CTRIP_BRIDGE_GATEWAY_URL === undefined) !==
    (environment.CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "CTRIP_BRIDGE_GATEWAY_URL and CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON must be configured together",
      path: ["CTRIP_BRIDGE_GATEWAY_URL"],
    });
  }
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
    environment.AGENT_GATEWAY_CREDENTIALS_JSON,
    "AGENT_GATEWAY_CREDENTIALS_JSON",
    context,
  );
  rejectPlaceholder(
    environment.CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON,
    "CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON",
    context,
  );
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

export const productionDeploymentEnvSchema = z
  .object({
    NODE_ENV: z.literal("production").default("production"),
    POSTGRES_ADMIN_PASSWORD: productionSecretSchema,
    GEO_API_DB_PASSWORD: productionSecretSchema,
    GEO_WORKER_DB_PASSWORD: productionSecretSchema,
    GEO_IDENTITY_DB_PASSWORD: productionSecretSchema,
    SESSION_SECRET: productionLongSecretSchema,
    MCP_PRINCIPALS_JSON: productionSecretSchema,
    AGENT_GATEWAY_CREDENTIALS_JSON: productionSecretSchema,
    AGENT_PROVIDER: z.string().min(1).default("fixture"),
    AGENT_MODEL: z.string().min(1).default("fixture-geo-writer-v1"),
    AGENT_BASE_URL: agentBaseUrlSchema.optional(),
    AGENT_API_KEY: productionSecretSchema.optional(),
    GEO_BOOTSTRAP_PASSWORD: productionSecretSchema.optional(),
    GEO_DEPLOYMENT_PROFILE: deploymentProfileSchema,
    GEO_GOVERNANCE_MODE: governanceModeSchema,
    PLASTIC_PROMISE_MCP_URL: optionalUrlSchema,
    PLASTIC_PROMISE_MCP_AUTHORIZATION: optionalProductionSecretSchema,
    DOUBAO_API_KEY: productionSecretSchema.optional(),
    QWEN_API_KEY: productionSecretSchema.optional(),
  })
  .superRefine((environment, context) => {
    validateAgentEnvironment(environment, context);
    validateGovernanceEnvironment(environment, context);
    if (
      environment.GEO_GOVERNANCE_MODE === "external" &&
      environment.PLASTIC_PROMISE_MCP_URL === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "PLASTIC_PROMISE_MCP_URL is required for external governance",
        path: ["PLASTIC_PROMISE_MCP_URL"],
      });
    }
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
