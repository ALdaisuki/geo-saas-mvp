import { isIP } from "node:net";
import { posix } from "node:path";

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

const falseBooleanStringSchema = z
  .literal("false")
  .default("false")
  .transform(() => false as const);

const deploymentProfileSchema = z.enum(["standard", "customer_demo"]).default("standard");
const governanceModeSchema = z.enum(["external", "demo_fixture"]).default("external");
const mediaSearchProviderSchema = z
  .enum(["disabled", "wikimedia_commons", "pexels"])
  .default("disabled");
const optionalUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);
const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalMediaHttpsProxyUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      );
    }, "Media HTTPS proxy must be a bare HTTP(S) proxy URL")
    .optional(),
);
const productionGovernanceUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "") ||
        (url.protocol === "http:" &&
          url.hostname === "172.30.11.2" &&
          url.port === "10002" &&
          url.pathname === "/mcp" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "")
      );
    }, "Production Plastic Promise MCP must use HTTPS or the fixed Docker bridge proxy")
    .optional(),
);
const optionalSecretSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalPexelsApiKeySchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(16).max(512).regex(/^\S+$/u).optional(),
);
const agentApiSchema = z.enum(["openai-responses", "openai-completions"]);
const ctripBrowserTenantSchema = z.strictObject({
  tenantId: z.string().uuid(),
  bridgePrincipalId: z.string().uuid(),
  accessToken: productionLongSecretSchema,
});
const ctripGatewayCredentialSchema = z.strictObject({
  tenantId: z.string().uuid(),
  accessToken: productionLongSecretSchema,
});
const normalizedAbsolutePathSchema = z
  .string()
  .min(2)
  .refine((value) => posix.isAbsolute(value) && posix.normalize(value) === value, {
    message: "Server path must be a normalized absolute path",
  })
  .refine((value) => value !== "/tmp" && !value.startsWith("/tmp/"), {
    message: "Persistent server paths must not use /tmp",
  });
const ctripLinuxCdpEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "browser-host" &&
      url.port === "10005" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Production Ctrip CDP endpoint must be http://browser-host:10005/");

const productionPublicDomainSchema = z
  .string()
  .min(4)
  .max(253)
  .refine((value) => {
    if (value !== value.toLowerCase() || value.endsWith(".") || !value.includes(".")) return false;
    if (isIP(value) !== 0 || value.includes(":") || value.includes("*")) return false;
    return value
      .split(".")
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      );
  }, "Production public domain must be one lowercase ASCII FQDN without a wildcard, port or trailing dot");

const operatorLoopbackOriginSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .refine((value) => {
      const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(value);
      return match !== null && Number(match[1]) <= 65_535;
    }, "Operator origin must be an exact http://127.0.0.1:<port> origin")
    .optional(),
);

const ctripBrowserLoginUrlValueSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    );
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  }, "Ctrip browser login URL must use HTTPS or loopback HTTP without credentials or a fragment");

const optionalCtripBrowserLoginUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  ctripBrowserLoginUrlValueSchema.optional(),
);

function parseProductionJson<T>(
  value: string,
  schema: z.ZodType<T>,
  path: string,
  context: z.RefinementCtx,
): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: `${path} must be valid JSON`, path: [path] });
    return undefined;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      message: `${path} does not match the production schema`,
      path: [path],
    });
    return undefined;
  }
  return result.data;
}

function validateGovernanceEnvironment(
  environment: {
    readonly APP_ORIGIN?: string | undefined;
    readonly AGENT_PROVIDER: string;
    readonly GEO_ALLOW_REAL_PI_IN_DEMO: boolean;
    readonly GEO_DEPLOYMENT_PROFILE: "standard" | "customer_demo";
    readonly GEO_GOVERNANCE_MODE: "external" | "demo_fixture";
    readonly GEO_MEDIA_PROVIDER: "disabled" | "fixture";
    readonly GEO_MEDIA_SEARCH_PROVIDER: "disabled" | "wikimedia_commons" | "pexels";
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
    environment.GEO_GOVERNANCE_MODE === "demo_fixture" &&
    environment.AGENT_PROVIDER !== "fixture" &&
    !environment.GEO_ALLOW_REAL_PI_IN_DEMO
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Demo governance requires the fixture Pi provider unless GEO_ALLOW_REAL_PI_IN_DEMO=true is set",
      path: ["AGENT_PROVIDER"],
    });
  }
  if (
    environment.GEO_ALLOW_REAL_PI_IN_DEMO &&
    (environment.GEO_DEPLOYMENT_PROFILE !== "customer_demo" ||
      environment.GEO_GOVERNANCE_MODE !== "demo_fixture")
  ) {
    context.addIssue({
      code: "custom",
      message:
        "GEO_ALLOW_REAL_PI_IN_DEMO is allowed only with GEO_DEPLOYMENT_PROFILE=customer_demo and GEO_GOVERNANCE_MODE=demo_fixture",
      path: ["GEO_ALLOW_REAL_PI_IN_DEMO"],
    });
  }
  if (environment.GEO_ALLOW_REAL_PI_IN_DEMO && environment.AGENT_PROVIDER === "fixture") {
    context.addIssue({
      code: "custom",
      message: "GEO_ALLOW_REAL_PI_IN_DEMO requires a real Pi provider",
      path: ["GEO_ALLOW_REAL_PI_IN_DEMO"],
    });
  }
  if (
    environment.GEO_MEDIA_PROVIDER === "fixture" &&
    environment.GEO_GOVERNANCE_MODE !== "demo_fixture"
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Fixture media production is restricted to GEO_GOVERNANCE_MODE=demo_fixture; production must use GEO_MEDIA_PROVIDER=disabled",
      path: ["GEO_MEDIA_PROVIDER"],
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

interface TrendCollectionEnvironment {
  readonly TREND_COLLECTION_ENABLED: boolean;
  readonly TREND_COLLECTION_TENANT_ACTORS_JSON?: string | undefined;
}

const trendCollectionTenantActorsSchema = z
  .record(z.string().uuid(), z.string().uuid())
  .refine((value) => Object.keys(value).length > 0, "At least one tenant mapping is required");

function validateTrendCollectionEnvironment(
  environment: TrendCollectionEnvironment,
  context: z.RefinementCtx,
): void {
  if (
    environment.TREND_COLLECTION_ENABLED &&
    environment.TREND_COLLECTION_TENANT_ACTORS_JSON === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "TREND_COLLECTION_TENANT_ACTORS_JSON is required when trend collection is enabled",
      path: ["TREND_COLLECTION_TENANT_ACTORS_JSON"],
    });
    return;
  }
  if (environment.TREND_COLLECTION_TENANT_ACTORS_JSON !== undefined) {
    parseProductionJson(
      environment.TREND_COLLECTION_TENANT_ACTORS_JSON,
      trendCollectionTenantActorsSchema,
      "TREND_COLLECTION_TENANT_ACTORS_JSON",
      context,
    );
  }
}

interface TrendAutomationEnvironment {
  readonly TREND_AUTOMATION_ENABLED: boolean;
  readonly TREND_AUTOMATION_PIPELINES_JSON?: string | undefined;
}

const trendAutomationPlatformSchema = z.enum(["toutiao", "sohu", "baijiahao", "netease"]);
const trendAutomationPipelineSchema = z.strictObject({
  actorId: z.string().uuid(),
  campaignId: z.string().uuid(),
  platforms: z
    .array(trendAutomationPlatformSchema)
    .min(1)
    .max(4)
    .refine((items) => new Set(items).size === items.length, "Platforms must be unique")
    .optional(),
  executionLevel: z.enum(["dry_run", "assisted", "unattended"]).optional(),
  maxNewBatchesPerRun: z.number().int().min(1).max(100).optional(),
  lookbackMinutes: z.number().int().min(15).max(10_080).optional(),
  minFreshnessScore: z.number().min(0).max(1).optional(),
  relevanceTerms: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(
          items.map((item) =>
            item.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, ""),
          ),
        ).size === items.length,
      "Relevance terms must be unique after normalization",
    ),
});
const trendAutomationPipelinesSchema = z
  .record(z.string().uuid(), trendAutomationPipelineSchema)
  .refine((value) => Object.keys(value).length > 0, "At least one pipeline is required");

function validateTrendAutomationEnvironment(
  environment: TrendAutomationEnvironment,
  context: z.RefinementCtx,
): void {
  if (
    environment.TREND_AUTOMATION_ENABLED &&
    environment.TREND_AUTOMATION_PIPELINES_JSON === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "TREND_AUTOMATION_PIPELINES_JSON is required when trend automation is enabled",
      path: ["TREND_AUTOMATION_PIPELINES_JSON"],
    });
    return;
  }
  if (environment.TREND_AUTOMATION_PIPELINES_JSON !== undefined) {
    parseProductionJson(
      environment.TREND_AUTOMATION_PIPELINES_JSON,
      trendAutomationPipelinesSchema,
      "TREND_AUTOMATION_PIPELINES_JSON",
      context,
    );
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
  readonly AGENT_API?: "openai-responses" | "openai-completions" | undefined;
  readonly AGENT_COMPLETIONS_MODE: "stream" | "json";
  readonly AGENT_API_KEY?: string | undefined;
  readonly AGENT_BASE_URL?: string | undefined;
}

interface ProviderTransportEnvironment {
  readonly provider: string;
  readonly api?: "openai-responses" | "openai-completions" | undefined;
  readonly completionsMode: "stream" | "json";
  readonly baseUrl?: string | undefined;
}

interface MediaInspectionEnvironment {
  readonly MEDIA_INSPECTION_PROVIDER?: string | undefined;
  readonly MEDIA_INSPECTION_MODEL?: string | undefined;
  readonly MEDIA_INSPECTION_API?: "openai-responses" | "openai-completions" | undefined;
  readonly MEDIA_INSPECTION_COMPLETIONS_MODE?: "stream" | "json" | undefined;
  readonly MEDIA_INSPECTION_API_KEY?: string | undefined;
  readonly MEDIA_INSPECTION_BASE_URL?: string | undefined;
}

interface MediaSearchEnvironment {
  readonly GEO_MEDIA_SEARCH_PROVIDER: "disabled" | "wikimedia_commons" | "pexels";
  readonly PEXELS_API_KEY?: string | undefined;
}

function validateMediaSearchEnvironment(
  environment: MediaSearchEnvironment,
  context: z.RefinementCtx,
): void {
  if (
    environment.GEO_MEDIA_SEARCH_PROVIDER === "pexels" &&
    environment.PEXELS_API_KEY === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "PEXELS_API_KEY is required for GEO_MEDIA_SEARCH_PROVIDER=pexels",
      path: ["PEXELS_API_KEY"],
    });
  }
  if (
    environment.GEO_MEDIA_SEARCH_PROVIDER !== "pexels" &&
    environment.PEXELS_API_KEY !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "PEXELS_API_KEY is allowed only with GEO_MEDIA_SEARCH_PROVIDER=pexels",
      path: ["PEXELS_API_KEY"],
    });
  }
}

function validateProviderTransportEnvironment(
  environment: ProviderTransportEnvironment,
  prefix: "AGENT" | "MEDIA_INSPECTION",
  context: z.RefinementCtx,
): void {
  const compatible = environment.provider === "openai-compatible";
  if (compatible && environment.baseUrl === undefined) {
    context.addIssue({
      code: "custom",
      message: `${prefix}_BASE_URL is required for ${prefix}_PROVIDER=openai-compatible`,
      path: [`${prefix}_BASE_URL`],
    });
  }
  if (!compatible && environment.baseUrl !== undefined) {
    context.addIssue({
      code: "custom",
      message: `${prefix}_BASE_URL is only supported by ${prefix}_PROVIDER=openai-compatible`,
      path: [`${prefix}_BASE_URL`],
    });
  }
  if (!compatible && environment.api !== undefined) {
    context.addIssue({
      code: "custom",
      message: `${prefix}_API is only supported by ${prefix}_PROVIDER=openai-compatible`,
      path: [`${prefix}_API`],
    });
  }
  if (
    environment.completionsMode === "json" &&
    (!compatible || environment.api !== "openai-completions")
  ) {
    context.addIssue({
      code: "custom",
      message: `${prefix}_COMPLETIONS_MODE=json requires openai-compatible with ${prefix}_API=openai-completions`,
      path: [`${prefix}_COMPLETIONS_MODE`],
    });
  }
}

function validateAgentEnvironment(environment: AgentEnvironment, context: z.RefinementCtx): void {
  validateProviderTransportEnvironment(
    {
      provider: environment.AGENT_PROVIDER,
      api: environment.AGENT_API,
      completionsMode: environment.AGENT_COMPLETIONS_MODE,
      baseUrl: environment.AGENT_BASE_URL,
    },
    "AGENT",
    context,
  );
  if (environment.AGENT_PROVIDER !== "fixture" && environment.AGENT_API_KEY === undefined) {
    context.addIssue({
      code: "custom",
      message: "AGENT_API_KEY is required for a real Pi provider",
      path: ["AGENT_API_KEY"],
    });
  }
}

function validateMediaInspectionEnvironment(
  environment: MediaInspectionEnvironment,
  context: z.RefinementCtx,
): void {
  const configured = environment.MEDIA_INSPECTION_PROVIDER !== undefined;
  const configuredValues = [
    environment.MEDIA_INSPECTION_MODEL,
    environment.MEDIA_INSPECTION_API,
    environment.MEDIA_INSPECTION_COMPLETIONS_MODE,
    environment.MEDIA_INSPECTION_API_KEY,
    environment.MEDIA_INSPECTION_BASE_URL,
  ];
  if (!configured && configuredValues.every((value) => value === undefined)) return;

  if (!configured) {
    context.addIssue({
      code: "custom",
      message: "MEDIA_INSPECTION_PROVIDER is required when media inspection is configured",
      path: ["MEDIA_INSPECTION_PROVIDER"],
    });
    return;
  }
  if (environment.MEDIA_INSPECTION_MODEL === undefined) {
    context.addIssue({
      code: "custom",
      message: "MEDIA_INSPECTION_MODEL is required when media inspection is configured",
      path: ["MEDIA_INSPECTION_MODEL"],
    });
  }
  if (environment.MEDIA_INSPECTION_API_KEY === undefined) {
    context.addIssue({
      code: "custom",
      message: "MEDIA_INSPECTION_API_KEY is required when media inspection is configured",
      path: ["MEDIA_INSPECTION_API_KEY"],
    });
  }

  validateProviderTransportEnvironment(
    {
      provider: environment.MEDIA_INSPECTION_PROVIDER,
      api: environment.MEDIA_INSPECTION_API,
      completionsMode: environment.MEDIA_INSPECTION_COMPLETIONS_MODE ?? "stream",
      baseUrl: environment.MEDIA_INSPECTION_BASE_URL,
    },
    "MEDIA_INSPECTION",
    context,
  );
}

const serverEnvBaseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(10004),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(10001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  DATABASE_ADMIN_URL: z.string().url().optional(),
  DATABASE_IDENTITY_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  GEO_OPERATOR_ORIGIN: operatorLoopbackOriginSchema,
  GEO_DEPLOYMENT_PROFILE: deploymentProfileSchema,
  GEO_GOVERNANCE_MODE: governanceModeSchema,
  GEO_ALLOW_REAL_PI_IN_DEMO: booleanStringSchema,
  GEO_CONTEXT_RETRIEVAL_ENABLED: booleanStringSchema,
  TREND_COLLECTION_ENABLED: booleanStringSchema,
  TREND_COLLECTION_TENANT_ACTORS_JSON: optionalNonEmptyStringSchema,
  TREND_COLLECTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
  TREND_COLLECTION_LIMIT_PER_SOURCE: z.coerce.number().int().min(1).max(20).default(20),
  TREND_AUTOMATION_ENABLED: booleanStringSchema,
  TREND_AUTOMATION_PIPELINES_JSON: optionalNonEmptyStringSchema,
  TREND_AUTOMATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
  AUTOMATION_PLAN_ENABLED: booleanStringSchema,
  AUTOMATION_PLAN_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(60_000),
  AUTOMATION_PLAN_MAX_PLANS_PER_RUN: z.coerce.number().int().min(1).max(1_000).default(100),
  PLASTIC_PROMISE_MCP_URL: optionalUrlSchema,
  PLASTIC_PROMISE_MCP_AUTHORIZATION: optionalSecretSchema,
  EVIDENCE_STORAGE_DIR: z.string().min(1).default(".data/evidence"),
  GEO_MEDIA_PROVIDER: z.enum(["disabled", "fixture"]).default("disabled"),
  GEO_MEDIA_SEARCH_PROVIDER: mediaSearchProviderSchema,
  GEO_MEDIA_HTTPS_PROXY_URL: optionalMediaHttpsProxyUrlSchema,
  PEXELS_API_KEY: optionalPexelsApiKeySchema,
  GEO_MEDIA_OBJECT_ROOT: z.string().min(1).default(".data/media"),
  AGENT_PROVIDER: z.string().min(1).default("fixture"),
  AGENT_MODEL: z.string().min(1).default("fixture-geo-writer-v1"),
  AGENT_API: z.preprocess((value) => (value === "" ? undefined : value), agentApiSchema.optional()),
  AGENT_COMPLETIONS_MODE: z.enum(["stream", "json"]).default("stream"),
  AGENT_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    agentBaseUrlSchema.optional(),
  ),
  AGENT_API_KEY: z.string().min(1).optional(),
  AGENT_STRICT_TOOL_ARGUMENTS: booleanStringSchema,
  AGENT_GATEWAY_URL: z.string().url().optional(),
  AGENT_GATEWAY_CREDENTIALS_JSON: z.string().min(1).optional(),
  AGENT_GATEWAY_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(16 * 60_000)
    .default(130_000),
  CTRIP_BRIDGE_GATEWAY_URL: z.string().url().optional(),
  CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: z.string().min(1).optional(),
  GEO_CTRIP_BROWSER_LOGIN_BASE_URL: optionalCtripBrowserLoginUrlSchema,
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
  validateMediaSearchEnvironment(environment, context);
  validateGovernanceEnvironment(environment, context);
  validateTrendCollectionEnvironment(environment, context);
  validateTrendAutomationEnvironment(environment, context);
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
  rejectPlaceholder(environment.GEO_MEDIA_HTTPS_PROXY_URL, "GEO_MEDIA_HTTPS_PROXY_URL", context);
  rejectPlaceholder(environment.PEXELS_API_KEY, "PEXELS_API_KEY", context);
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
    GEO_PUBLIC_DOMAIN: productionPublicDomainSchema,
    APP_ORIGIN: z.string().url(),
    WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(10_003),
    GEO_OPERATOR_ORIGIN: operatorLoopbackOriginSchema,
    POSTGRES_ADMIN_PASSWORD: productionSecretSchema,
    GEO_API_DB_PASSWORD: productionSecretSchema,
    GEO_WORKER_DB_PASSWORD: productionSecretSchema,
    GEO_IDENTITY_DB_PASSWORD: productionSecretSchema,
    SESSION_SECRET: productionLongSecretSchema,
    MCP_PRINCIPALS_JSON: productionSecretSchema,
    AGENT_GATEWAY_CREDENTIALS_JSON: productionSecretSchema,
    AGENT_PROVIDER: z.string().min(1).default("fixture"),
    AGENT_MODEL: z.string().min(1).default("fixture-geo-writer-v1"),
    GEO_MEDIA_PROVIDER: z.enum(["disabled", "fixture"]).default("disabled"),
    GEO_MEDIA_SEARCH_PROVIDER: mediaSearchProviderSchema,
    GEO_MEDIA_HTTPS_PROXY_URL: optionalMediaHttpsProxyUrlSchema,
    PEXELS_API_KEY: optionalPexelsApiKeySchema,
    AGENT_API: z.preprocess(
      (value) => (value === "" ? undefined : value),
      agentApiSchema.optional(),
    ),
    AGENT_COMPLETIONS_MODE: z.enum(["stream", "json"]).default("stream"),
    AGENT_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      agentBaseUrlSchema.optional(),
    ),
    AGENT_API_KEY: productionSecretSchema.optional(),
    AGENT_STRICT_TOOL_ARGUMENTS: booleanStringSchema,
    MEDIA_INSPECTION_PROVIDER: z.string().min(1).optional(),
    MEDIA_INSPECTION_MODEL: z.string().min(1).optional(),
    MEDIA_INSPECTION_API: z.preprocess(
      (value) => (value === "" ? undefined : value),
      agentApiSchema.optional(),
    ),
    MEDIA_INSPECTION_COMPLETIONS_MODE: z.enum(["stream", "json"]).optional(),
    MEDIA_INSPECTION_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      agentBaseUrlSchema.optional(),
    ),
    MEDIA_INSPECTION_API_KEY: productionSecretSchema.optional(),
    CTRIP_BRIDGE_GATEWAY_URL: z
      .literal("http://ctrip-bridge:9030")
      .default("http://ctrip-bridge:9030"),
    CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON: productionSecretSchema,
    CTRIP_BRIDGE_TENANTS_JSON: productionSecretSchema,
    CTRIP_BRIDGE_MODE: z
      .enum(["browser_draft", "browser_supervised", "browser_unattended"])
      .default("browser_draft"),
    CTRIP_BROWSER_TRANSPORT: z.literal("linux_service"),
    CTRIP_BROWSER_TENANT_ID: z.string().uuid(),
    GEO_CTRIP_BROWSER_LOGIN_BASE_URL: ctripBrowserLoginUrlValueSchema,
    CTRIP_NOVNC_HOST_PORT: z.coerce.number().int().min(1).max(65_535).default(10_007),
    CTRIP_REVIEW_CDP_ENDPOINT: ctripLinuxCdpEndpointSchema,
    GEO_RUNTIME_TMP_ROOT: normalizedAbsolutePathSchema.refine(
      (value) => value.startsWith("/var/lib/geo/runtime/"),
      "Ctrip runtime temp root must be inside /var/lib/geo/runtime",
    ),
    GEO_CTRIP_RUNTIME_ROOT: z.literal("/srv/geo-saas/data/ctrip-runtime"),
    GEO_BROWSER_PROFILE_ROOT: normalizedAbsolutePathSchema,
    GEO_BROWSER_DOWNLOAD_ROOT: normalizedAbsolutePathSchema,
    GEO_BROWSER_ARTIFACT_ROOT: normalizedAbsolutePathSchema,
    CTRIP_VNC_PASSWORD_FILE: z.literal("/srv/geo-saas/secrets/ctrip-vnc.passwd"),
    AUTOMATION_PRODUCER_ENABLED: booleanStringSchema,
    TREND_COLLECTION_ENABLED: booleanStringSchema,
    TREND_COLLECTION_TENANT_ACTORS_JSON: optionalNonEmptyStringSchema,
    TREND_COLLECTION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(600_000),
    TREND_COLLECTION_LIMIT_PER_SOURCE: z.coerce.number().int().min(1).max(20).default(20),
    TREND_AUTOMATION_ENABLED: booleanStringSchema,
    TREND_AUTOMATION_PIPELINES_JSON: optionalNonEmptyStringSchema,
    TREND_AUTOMATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(600_000),
    AUTOMATION_PLAN_ENABLED: booleanStringSchema,
    AUTOMATION_PLAN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(60_000),
    AUTOMATION_PLAN_MAX_PLANS_PER_RUN: z.coerce.number().int().min(1).max(1_000).default(100),
    GEO_BOOTSTRAP_PASSWORD: z
      .undefined({
        error:
          "Production deployment must not persist GEO_BOOTSTRAP_PASSWORD; inject it only into the one-shot operator bootstrap command",
      })
      .optional(),
    GEO_DEPLOYMENT_PROFILE: z.literal("standard").default("standard"),
    GEO_GOVERNANCE_MODE: z.literal("external").default("external"),
    GEO_ALLOW_REAL_PI_IN_DEMO: falseBooleanStringSchema,
    GEO_CONTEXT_RETRIEVAL_ENABLED: booleanStringSchema,
    PLASTIC_PROMISE_MCP_URL: productionGovernanceUrlSchema,
    PLASTIC_PROMISE_MCP_AUTHORIZATION: optionalProductionSecretSchema,
    DOUBAO_API_KEY: productionSecretSchema.optional(),
    QWEN_API_KEY: productionSecretSchema.optional(),
  })
  .superRefine((environment, context) => {
    validateAgentEnvironment(environment, context);
    validateMediaInspectionEnvironment(environment, context);
    validateMediaSearchEnvironment(environment, context);
    validateGovernanceEnvironment(environment, context);
    validateTrendCollectionEnvironment(environment, context);
    validateTrendAutomationEnvironment(environment, context);
    if (environment.APP_ORIGIN !== `https://${environment.GEO_PUBLIC_DOMAIN}`) {
      context.addIssue({
        code: "custom",
        message: "APP_ORIGIN must exactly match the production public HTTPS domain",
        path: ["APP_ORIGIN"],
      });
    }
    if (
      environment.GEO_OPERATOR_ORIGIN !== undefined &&
      environment.GEO_OPERATOR_ORIGIN !== `http://127.0.0.1:${String(environment.WEB_PORT)}`
    ) {
      context.addIssue({
        code: "custom",
        message: "GEO_OPERATOR_ORIGIN must exactly match the loopback production WEB_PORT",
        path: ["GEO_OPERATOR_ORIGIN"],
      });
    }
    const ctripLoginUrl = new URL(environment.GEO_CTRIP_BROWSER_LOGIN_BASE_URL);
    if (
      ctripLoginUrl.protocol !== "http:" ||
      ctripLoginUrl.hostname !== "127.0.0.1" ||
      ctripLoginUrl.port !== String(environment.CTRIP_NOVNC_HOST_PORT) ||
      ctripLoginUrl.pathname !== "/vnc.html"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Production Ctrip login URL must use the loopback noVNC vnc.html route and configured host port",
        path: ["GEO_CTRIP_BROWSER_LOGIN_BASE_URL"],
      });
    }
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
    if (
      environment.GEO_DEPLOYMENT_PROFILE === "standard" &&
      environment.AGENT_PROVIDER === "fixture"
    ) {
      context.addIssue({
        code: "custom",
        message: "Standard production requires a real Pi provider",
        path: ["AGENT_PROVIDER"],
      });
    }
    if (
      environment.GEO_DEPLOYMENT_PROFILE === "standard" &&
      environment.MEDIA_INSPECTION_PROVIDER === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Standard production requires an explicit MEDIA_INSPECTION_PROVIDER",
        path: ["MEDIA_INSPECTION_PROVIDER"],
      });
    }
    rejectPlaceholder(environment.GEO_MEDIA_HTTPS_PROXY_URL, "GEO_MEDIA_HTTPS_PROXY_URL", context);
    rejectPlaceholder(environment.PEXELS_API_KEY, "PEXELS_API_KEY", context);
    rejectPlaceholder(environment.MEDIA_INSPECTION_API_KEY, "MEDIA_INSPECTION_API_KEY", context);
    const bridgeTenants = parseProductionJson(
      environment.CTRIP_BRIDGE_TENANTS_JSON,
      z.array(ctripBrowserTenantSchema).length(1),
      "CTRIP_BRIDGE_TENANTS_JSON",
      context,
    );
    const gatewayCredentials = parseProductionJson(
      environment.CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON,
      z.array(ctripGatewayCredentialSchema).length(1),
      "CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON",
      context,
    );
    const bridgeTenant = bridgeTenants?.[0];
    const gatewayCredential = gatewayCredentials?.[0];
    if (
      bridgeTenant !== undefined &&
      (bridgeTenant.tenantId !== environment.CTRIP_BROWSER_TENANT_ID ||
        gatewayCredential?.tenantId !== environment.CTRIP_BROWSER_TENANT_ID)
    ) {
      context.addIssue({
        code: "custom",
        message: "Ctrip Bridge, gateway and browser tenant IDs must match",
        path: ["CTRIP_BROWSER_TENANT_ID"],
      });
    }
    if (
      bridgeTenant !== undefined &&
      gatewayCredential !== undefined &&
      bridgeTenant.accessToken !== gatewayCredential.accessToken
    ) {
      context.addIssue({
        code: "custom",
        message: "Ctrip Bridge and gateway access tokens must match",
        path: ["CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON"],
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
  VITE_API_BASE_URL: z.string().url().default("http://127.0.0.1:10004"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
