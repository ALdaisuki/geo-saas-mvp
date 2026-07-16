import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { PublicationGovernanceDecision, PublicationGrantConsumptionInput } from "@geo/agent";
import { capabilitiesForRole, hasCapability, requireCapability } from "@geo/authz";
import {
  automationServicePrincipalCreateRequestSchema,
  automationModeSchema,
  ARTICLE_TEMPLATE_CATALOG_VERSION,
  ARTICLE_TEMPLATES,
  brandAgentProfileDocumentSchema,
  channelAccountCreateRequestSchema,
  channelAccountUpdateRequestSchema,
  contactCreateRequestSchema,
  contactExpireRequestSchema,
  ctripBridgeServicePrincipalCreateRequestSchema,
  executionLevelSchema,
  idSchema,
  isoDateTimeSchema,
  memberCreateRequestSchema,
  memberUpdateRequestSchema,
  platformSchema,
  policyTransitionRequestSchema,
  publicationVariantPayloadSchema,
  servicePrincipalStatusRequestSchema,
  type ActorContext,
  type Capability,
  type CtripBridgeResult,
} from "@geo/contracts";
import {
  auditPublicationVariant,
  compileAuditPolicy,
  CoreInvariantError,
  geoAuditPolicyDocumentSchema,
  issuePublicationGrant,
  renderPlatformPublicationVariant,
  sha256Canonical,
  sha256Text,
  type FactSnapshot,
} from "@geo/core";
import {
  analyzeVisibilityEvidence,
  calculateVisibilityMetrics,
  FixtureVisibilityAdapter,
  ManualVisibilityAdapter,
  type VisibilityIntent,
  type VisibilityQuery,
} from "@geo/visibility";
import type { MediaObjectStore } from "@geo/media";
import { argon2id, hash as argon2Hash, verify as argon2Verify } from "argon2";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";

import {
  automationBatchCreateRequestSchema,
  automationBatchListQuerySchema,
  automationCancelCommandSchema,
  automationClaimCommandSchema,
  automationDraftCheckpointCommandSchema,
  automationHeartbeatCommandSchema,
  automationReconcileCommandSchema,
  automationRunListQuerySchema,
  automationTargetCheckpointCommandSchema,
  scopedWorkerId,
} from "./automation-contracts.js";
import { AgentRunGatewayError, type AgentRunGateway } from "./agent-run-gateway.js";
import { CtripBridgeGatewayError, type CtripBridgeGateway } from "./ctrip-bridge-gateway.js";
import {
  createManualPublicationPackageExport,
  ManualPublicationPackageExportError,
} from "./manual-publication-package.js";
import {
  DISABLED_MEDIA_PRODUCTION_CAPABILITY,
  mediaProductionRequestSchema,
  MediaProductionServiceError,
  type MediaProductionController,
} from "./media-production-service.js";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApiRepository,
  type LoginIdentity,
  type LoginMembership,
  type PersistAuditResult,
  type RequestContext,
  type ResolvedSession,
  type PublicationGovernanceAuditInput,
  type PublicationAssistedHandoffState,
  type PublicationAssistedHandoffView,
} from "./repository.js";
import { assertMemberManagementAllowed, normalizeContactValue } from "./tenant-governance.js";

const SESSION_COOKIE = "geo_session";
const CSRF_COOKIE = "geo_csrf";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const JWT_ISSUER = "geo-api";
const JWT_AUDIENCE = "geo-web";
export const GEO_API_VERSION = "2026-07-16";

interface SessionClaims {
  readonly sid: string;
  readonly sub: string;
  readonly tid: string;
}

interface AuthenticatedContext {
  readonly actor: ActorContext;
  readonly session: ResolvedSession;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: SessionClaims;
    user: SessionClaims;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    authContext: AuthenticatedContext | null;
  }
}

export interface PasswordService {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface PublicationGovernanceGate {
  evaluate(input: PublicationGrantConsumptionInput): Promise<PublicationGovernanceDecision>;
}

export interface PublicationTokenInput {
  readonly tenantId: string;
  readonly grantId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface BuildAppOptions {
  readonly repository: ApiRepository;
  readonly sessionSecret: string;
  readonly cookieSecure?: boolean;
  readonly sessionTtlSeconds?: number;
  readonly passwordService?: PasswordService;
  readonly dummyPasswordHash?: string;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly randomToken?: () => string;
  readonly publicationTokenFactory?: (input: PublicationTokenInput) => string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly allowedOrigins?: readonly string[];
  readonly publicationGovernanceGate: PublicationGovernanceGate;
  readonly agentRunGateway?: AgentRunGateway;
  readonly ctripBridgeGateway?: CtripBridgeGateway;
  readonly mediaProduction?: MediaProductionController;
  readonly mediaObjectStore?: Pick<MediaObjectStore, "get">;
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(1_024),
  tenantSlug: z.string().trim().min(2).max(63).optional(),
});

const switchTenantSchema = z.object({
  tenantSlug: z.string().trim().min(2).max(63),
});

const killSwitchSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});

const automationQuotaSchema = z
  .strictObject({
    maxConcurrent: z.number().int().min(1).max(100),
    perMinute: z.number().int().min(1).max(10_000),
    perDay: z.number().int().min(1).max(1_000_000),
    cooldownSeconds: z.number().int().min(0).max(86_400),
    errorBudget: z.number().int().min(1).max(100_000),
  })
  .superRefine((quota, context) => {
    if (quota.maxConcurrent > quota.perMinute) {
      context.addIssue({
        code: "custom",
        path: ["maxConcurrent"],
        message: "maxConcurrent cannot exceed perMinute",
      });
    }
    if (quota.perMinute > quota.perDay) {
      context.addIssue({
        code: "custom",
        path: ["perMinute"],
        message: "perMinute cannot exceed perDay",
      });
    }
  });

const automationControlSchema = z.strictObject({
  mode: automationModeSchema,
  quota: automationQuotaSchema,
  reason: z.string().trim().min(3).max(500),
});

const scopedAutomationControlSchema = automationControlSchema.extend({
  killSwitchEnabled: z.boolean(),
});

const automationScopeParamsSchema = z
  .strictObject({
    scopeType: z.enum(["tenant", "platform", "account", "campaign", "topic"]),
    scopeKey: z.string().trim().min(1).max(200),
  })
  .superRefine((scope, context) => {
    const valid =
      (scope.scopeType === "tenant" && scope.scopeKey === "*") ||
      (scope.scopeType === "platform" && platformSchema.safeParse(scope.scopeKey).success) ||
      ((scope.scopeType === "account" || scope.scopeType === "campaign") &&
        idSchema.safeParse(scope.scopeKey).success) ||
      (scope.scopeType === "topic" &&
        !Array.from(scope.scopeKey).some((character) => character.charCodeAt(0) <= 0x1f));
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["scopeKey"],
        message: "scopeKey does not match scopeType",
      });
    }
  });

const circuitStateSchema = z.strictObject({
  targetState: z.enum(["open", "closed"]),
  retryAt: isoDateTimeSchema.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
});

const brandSchema = z.object({
  canonicalName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  description: z.string().trim().min(1).max(4_000).nullable().optional(),
  industry: z.string().trim().min(1).max(100),
  websiteUrl: z.string().url().max(2_000).nullable().optional(),
  isPrimary: z.boolean().default(false),
});

const brandAgentProfileRequestSchema = z.strictObject({
  document: brandAgentProfileDocumentSchema,
  reason: z.string().trim().min(3).max(1_000),
});

const policyBundleSchema = z
  .strictObject({
    version: z.string().trim().min(1).max(100),
    document: geoAuditPolicyDocumentSchema,
    effectiveAt: isoDateTimeSchema.optional(),
    reason: z.string().trim().min(3).max(1_000),
  })
  .superRefine((value, context) => {
    if (value.version !== value.document.rulesVersion) {
      context.addIssue({
        code: "custom",
        path: ["document", "rulesVersion"],
        message: "Policy version must match document rulesVersion",
      });
    }
  });

const querySetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(4_000),
  prompts: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100),
        prompt: z.string().trim().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(200),
});

const querySetVersionSchema = z.strictObject({
  prompts: querySetSchema.shape.prompts,
  reason: z.string().trim().min(3).max(1_000),
});

const querySetStateSchema = z.strictObject({
  targetStatus: z.literal("retired"),
  reason: z.string().trim().min(3).max(1_000),
});

const querySetVersionActivationSchema = z.strictObject({
  reason: z.string().trim().min(3).max(1_000),
});

const auditListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: isoDateTimeSchema.optional(),
  status: z.enum(["passed", "failed", "errored"]).optional(),
  platform: z.enum(["toutiao", "sohu", "ctrip_community"]).optional(),
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: isoDateTimeSchema.optional(),
  action: z.string().trim().min(1).max(200).optional(),
  resourceType: z.string().trim().min(1).max(200).optional(),
});

const campaignSchema = z.object({
  brandId: idSchema,
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  industry: z.string().trim().min(1).max(100),
  topicKey: z.string().trim().min(1).max(200),
});

const campaignTransitionSchema = z.strictObject({
  status: z.enum(["active", "paused", "completed"]),
  reason: z.string().trim().min(1).max(1_000).nullable().optional(),
});

const agentRunRequestSchema = z.strictObject({
  brandId: idSchema,
  campaignId: idSchema,
  channelAccountId: idSchema,
  platform: platformSchema,
  topic: z.string().trim().min(1).max(10_000),
  articleTemplateId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/u),
  idempotencyKey: z.string().trim().min(1).max(180),
});

const evidenceSourceSchema = z
  .object({
    type: z.enum(["url", "document", "manual", "platform_readback"]),
    title: z.string().trim().min(1).max(300),
    sourceUrl: z.string().trim().url().max(2_048).nullable().optional(),
    content: z.string().min(1).max(1_000_000),
    capturedAt: isoDateTimeSchema,
    validUntil: isoDateTimeSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.validUntil !== undefined &&
      value.validUntil !== null &&
      Date.parse(value.validUntil) <= Date.parse(value.capturedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must follow capturedAt",
      });
    }
  });

const factSchema = z
  .object({
    brandId: idSchema,
    normalizedKey: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9._:-]+$/i),
    claim: z.string().trim().min(1).max(4_000),
    status: z.enum(["draft", "verified"]).default("draft"),
    evidenceSourceIds: z.array(idSchema).min(1).max(50),
    validFrom: isoDateTimeSchema.optional(),
    validUntil: isoDateTimeSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.validFrom !== undefined &&
      value.validUntil !== undefined &&
      value.validUntil !== null &&
      Date.parse(value.validUntil) <= Date.parse(value.validFrom)
    ) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "validUntil must follow validFrom",
      });
    }
  });

const factQuerySchema = z.object({
  brandId: idSchema.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const resourceScopeSchema = z.object({
  resources: z
    .array(
      z.object({
        kind: z.enum([
          "brand",
          "campaign",
          "content_version",
          "variant",
          "channel_account",
          "query_set_version",
          "media_job",
        ]),
        id: idSchema,
      }),
    )
    .min(1)
    .max(20),
});

const idempotencyKeySchema = z.string().trim().min(1).max(200);

const contentSchema = z
  .object({
    campaignId: idSchema,
    brandId: idSchema,
    title: z.string().trim().min(1).max(200),
    contentType: z.enum([
      "question_answer",
      "guide",
      "evidence",
      "local_service",
      "comparison",
      "risk_avoidance",
    ]),
    topicKey: z.string().trim().min(1).max(200),
    idempotencyKey: idempotencyKeySchema,
    payload: publicationVariantPayloadSchema,
  })
  .superRefine((content, context) => {
    const editorialProfile = content.payload.editorialProfile;
    if (content.contentType === "evidence") {
      if (editorialProfile !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["payload", "editorialProfile"],
          message: "Evidence content cannot declare a conflicting editorial profile",
        });
      }
      return;
    }
    if (editorialProfile !== content.contentType) {
      context.addIssue({
        code: "custom",
        path: ["payload", "editorialProfile"],
        message: "Editorial profile must match content type",
      });
    }
  });

const contentVersionSchema = z.object({
  payload: publicationVariantPayloadSchema,
});

const mediaProductionBodySchema = mediaProductionRequestSchema.omit({ contentVersionId: true });

const mediaAssetListQuerySchema = z.strictObject({
  contentVersionId: idSchema,
});

const variantSchema = z.strictObject({
  contentVersionId: idSchema,
  channelAccountId: idSchema,
});

const auditRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

const publicationRequestSchema = z.object({
  grantId: idSchema,
  token: z.string().min(32).max(2_000),
  idempotencyKey: idempotencyKeySchema,
  executionLevel: executionLevelSchema.default("dry_run"),
  scheduledFor: isoDateTimeSchema.optional(),
});

const publicationReplaySchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    variantId: idSchema,
    auditArtifactId: idSchema,
    channelAccountId: idSchema,
    executionLevel: executionLevelSchema,
  })
  .strict();

const publicationCommandSchema = z.object({
  reason: z.string().trim().min(5).max(1_000),
});

const publicationAssistedHandoffLeaseSchema = z.strictObject({
  leaseSeconds: z.number().int().min(30).max(300).default(120),
});

const publicationAssistedBridgeCommandSchema = z.strictObject({});

const visibilityRunSchema = z.object({
  querySetVersionId: idSchema,
  provider: z.enum(["doubao", "qwen"]),
  sampleCount: z.number().int().min(1).max(20),
  idempotencyKey: idempotencyKeySchema,
});

const visibilitySummaryQuerySchema = z.object({
  includeFixture: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const visibilityRunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  provider: z.enum(["doubao", "qwen"]).optional(),
  observationMethod: z.enum(["fixture", "manual", "official_api", "browser"]).optional(),
});

const storedVisibilityPromptsSchema = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(200),
      category: z.string().trim().min(1).max(100),
      prompt: z.string().trim().min(1).max(10_000),
      expectedFactKeys: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      isControl: z.boolean().optional(),
      packVersion: z.string().trim().min(1).max(100).optional(),
    }),
  )
  .min(1)
  .max(200);

const manualVisibilitySampleSchema = z
  .object({
    queryKey: z.string().trim().min(1).max(200),
    rawAnswer: z.string().min(1).max(200_000),
    citedUrls: z.array(z.string().url()).max(100).default([]),
    requestStartedAt: isoDateTimeSchema.optional(),
    responseReceivedAt: isoDateTimeSchema.optional(),
    observedAt: isoDateTimeSchema,
  })
  .superRefine((value, context) => {
    if (
      value.requestStartedAt !== undefined &&
      value.responseReceivedAt !== undefined &&
      Date.parse(value.responseReceivedAt) < Date.parse(value.requestStartedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseReceivedAt"],
        message: "Response timestamp cannot precede request timestamp",
      });
    }
  });

const manualVisibilityRunSchema = z.object({
  querySetVersionId: idSchema,
  provider: z.enum(["doubao", "qwen"]),
  productSurface: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  searchMode: z.enum(["on", "off", "unknown"]),
  locale: z.string().trim().min(1).max(50).default("zh-CN"),
  geo: z.string().trim().min(1).max(100).nullable().default("CN"),
  idempotencyKey: idempotencyKeySchema,
  samples: z.array(manualVisibilitySampleSchema).min(1).max(200),
});

function visibilityIntent(category: string): VisibilityIntent {
  const mapped: Readonly<Record<string, VisibilityIntent>> = {
    generic: "category",
    category: "category",
    departure: "origin",
    origin: "origin",
    audience: "audience",
    guide: "guidance",
    guidance: "guidance",
    brand: "brand",
    contact: "contact",
    comparison: "comparison",
    risk: "negative_control",
    negative_control: "negative_control",
    blank_control: "blank_control",
  };
  return mapped[category] ?? "guidance";
}

function storedVisibilityQueries(value: unknown): VisibilityQuery[] {
  return storedVisibilityPromptsSchema.parse(value).map((prompt) => ({
    id: prompt.key,
    intent: visibilityIntent(prompt.category),
    prompt: prompt.prompt,
    expectedFactKeys:
      prompt.expectedFactKeys ??
      (prompt.category === "contact"
        ? ["contacts"]
        : prompt.category === "brand"
          ? ["brand.name"]
          : []),
    isControl:
      prompt.isControl ??
      ["negative_control", "blank_control"].includes(visibilityIntent(prompt.category)),
  }));
}

function encodedEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}

function defaultPasswordService(): PasswordService {
  return {
    hash: (password) => argon2Hash(password, { type: argon2id }),
    verify: (passwordHash, password) => argon2Verify(passwordHash, password),
  };
}

function pickMembership(
  memberships: readonly LoginMembership[],
  tenantSlug: string | undefined,
): LoginMembership {
  const active = memberships.filter(
    (membership) =>
      membership.membershipStatus === "active" && membership.tenantStatus === "active",
  );
  if (tenantSlug !== undefined) {
    const selected = active.find((membership) => membership.tenantSlug === tenantSlug);
    if (selected === undefined) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email, password, or tenant");
    }
    return selected;
  }
  if (active.length === 1) {
    return active[0] as LoginMembership;
  }
  if (active.length > 1) {
    throw new ApiError(409, "TENANT_SELECTION_REQUIRED", "Select an active tenant", {
      tenants: active.map((membership) => ({
        slug: membership.tenantSlug,
        displayName: membership.tenantDisplayName,
      })),
    });
  }
  throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email, password, or tenant");
}

function effectiveCapabilities(
  role: LoginMembership["role"],
  membershipCapabilities: readonly Capability[],
): Capability[] {
  const roleMaximum = new Set(capabilitiesForRole(role));
  return membershipCapabilities.filter((capability) => roleMaximum.has(capability));
}

function parseIdParams(input: unknown, field: string): string {
  return z.object({ [field]: idSchema }).parse(input)[field] as string;
}

interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}

function operationId(method: string, url: string): string {
  const path = url
    .replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "by_$1")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `${method.toLowerCase()}_${path}`;
}

function routeTag(url: string): string {
  const segments = url.split("/").filter(Boolean);
  return segments[0] === "api" ? (segments[1] ?? "api") : (segments[0] ?? "system");
}

function openApiDocument(routes: readonly RegisteredRoute[]): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (method === "head") continue;
    const path = openApiPath(route.url);
    const key = `${method}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parameters = [...route.url.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/gu)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (route.url.startsWith("/api/") && !["get", "head"].includes(method)) {
      parameters.push({
        name: "x-csrf-token",
        in: "header",
        required: route.url !== "/api/auth/login",
        schema: { type: "string" },
      });
    }
    const publicRoute =
      route.url === "/openapi.json" ||
      route.url.startsWith("/health/") ||
      route.url === "/api/auth/login";
    const pathItem = paths[path] ?? {};
    pathItem[method] = {
      operationId: operationId(method, route.url),
      tags: [routeTag(route.url)],
      parameters,
      security: publicRoute ? [] : [{ cookieAuth: [] }],
      responses: {
        "200": { description: "Successful response" },
        default: {
          description: "Structured API error",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
          },
        },
      },
    };
    paths[path] = pathItem;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "GEO SaaS HTTP API",
      version: GEO_API_VERSION,
      description:
        "Generated from the Fastify route registry. Domain payload validation remains defined by the Zod schemas in apps/api/src/app.ts.",
    },
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
      },
      schemas: {
        ApiError: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "requestId"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    "x-geo-api-version-header": "x-geo-api-version",
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  if (Buffer.byteLength(options.sessionSecret, "utf8") < 32) {
    throw new Error("sessionSecret must contain at least 32 bytes");
  }

  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: options.logger ?? false,
    trustProxy: false,
  });
  const registeredRoutes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      registeredRoutes.push({ method, url: route.url });
    }
  });
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    const requested = request.headers["x-geo-api-version"];
    const value = Array.isArray(requested) ? requested[0] : requested;
    if (value !== undefined && value !== GEO_API_VERSION) {
      throw new ApiError(406, "API_VERSION_UNSUPPORTED", "Unsupported GEO API version", {
        requestedVersion: value,
        supportedVersions: [GEO_API_VERSION],
      });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-geo-api-version", GEO_API_VERSION);
    return payload;
  });
  const repository = options.repository;
  const mediaProduction = options.mediaProduction;
  const mediaProductionCapability =
    mediaProduction?.capability ?? DISABLED_MEDIA_PRODUCTION_CAPABILITY;
  const passwordService = options.passwordService ?? defaultPasswordService();
  const dummyPasswordHash =
    options.dummyPasswordHash ?? (await passwordService.hash("geo-invalid-login-password"));
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const publicationTokenFactory =
    options.publicationTokenFactory ??
    ((input: PublicationTokenInput) =>
      createHmac("sha256", options.sessionSecret)
        .update(
          sha256Canonical({
            purpose: "geo-publication-grant-v1",
            tenantId: input.tenantId,
            grantId: input.grantId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          }),
        )
        .digest("base64url"));
  const ttlSeconds = options.sessionTtlSeconds ?? SESSION_TTL_SECONDS;
  const secureCookie = options.cookieSecure ?? true;
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? []).map((value) => {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "") {
        throw new Error("allowedOrigins cannot contain credentials");
      }
      return url.origin;
    }),
  );

  function auditResponse(
    result: PersistAuditResult,
    actor: Readonly<ActorContext>,
    idempotencyKey: string,
    requestHash: string,
  ) {
    const mayExposeGrant =
      result.grant !== null &&
      result.grant.status === "issued" &&
      Date.parse(result.grant.expiresAt) > now().getTime() &&
      hasCapability(actor, "publish:request");
    if (!mayExposeGrant || result.grant === null) {
      return {
        auditRunId: result.auditRunId,
        artifact: result.artifact,
        publicationAuthorization: null,
        wasCreated: result.wasCreated,
      };
    }
    const token = publicationTokenFactory({
      tenantId: result.artifact.tenantId,
      grantId: result.grant.id,
      idempotencyKey,
      requestHash,
    });
    if (!encodedEqual(sha256Text(token), result.grant.tokenHash)) {
      throw new ApiError(
        500,
        "PUBLICATION_TOKEN_BINDING_INVALID",
        "Publication authorization could not be reconstructed safely",
      );
    }
    return {
      auditRunId: result.auditRunId,
      artifact: result.artifact,
      publicationAuthorization: {
        grantId: result.grant.id,
        token,
        expiresAt: result.grant.expiresAt,
      },
      wasCreated: result.wasCreated,
    };
  }

  await app.register(cookie);
  await app.register(jwt, {
    secret: options.sessionSecret,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { algorithm: "HS256", iss: JWT_ISSUER, aud: JWT_AUDIENCE },
    verify: { allowedIss: JWT_ISSUER, allowedAud: JWT_AUDIENCE },
  });
  app.decorateRequest("authContext", null);

  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    let originAllowed = origin === undefined;
    if (origin !== undefined) {
      try {
        originAllowed = allowedOrigins.has(new URL(origin).origin);
      } catch {
        originAllowed = false;
      }
    }
    if (fetchSite === "cross-site" || !originAllowed) {
      throw new ApiError(403, "ORIGIN_DENIED", "Request origin is not allowed");
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("cache-control", "no-store");
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CtripBridgeGatewayError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    if (error instanceof AgentRunGatewayError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    if (error instanceof MediaProductionServiceError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          requestId: request.id,
          details: { issues: error.issues },
        },
      });
      return;
    }
    if (error instanceof RepositoryNotFoundError) {
      void reply.status(404).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    if (error instanceof RepositoryConflictError) {
      void reply.status(409).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    if (error instanceof CoreInvariantError) {
      void reply.status(422).send({
        error: { code: error.code, message: error.message, requestId: request.id },
      });
      return;
    }
    const databaseCode = (error as { code?: unknown }).code;
    const databaseMessage = error instanceof Error ? error.message : "";
    if (
      databaseCode === "0A000" &&
      /^live publication(?: readback)? is unsupported for the current platform adapters$/.test(
        databaseMessage,
      )
    ) {
      void reply.status(422).send({
        error: {
          code: "PUBLICATION_CAPABILITY_UNSUPPORTED",
          message: "Current platform adapters support dry-run and Ctrip assisted handoffs only",
          requestId: request.id,
        },
      });
      return;
    }
    if (databaseCode === "42501") {
      void reply.status(403).send({
        error: {
          code: "PUBLICATION_POLICY_DENIED",
          message: "Publication request was denied by database policy",
          requestId: request.id,
        },
      });
      return;
    }
    if (databaseCode === "23505" || databaseCode === "40001") {
      void reply.status(409).send({
        error: {
          code: "CONCURRENT_OR_IDEMPOTENCY_CONFLICT",
          message: "Request conflicts with an existing operation",
          requestId: request.id,
        },
      });
      return;
    }
    request.log.error({ err: error }, "unhandled API error");
    void reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        requestId: request.id,
      },
    });
  });

  async function authenticate(request: FastifyRequest): Promise<AuthenticatedContext> {
    if (request.authContext !== null) {
      return request.authContext;
    }
    const rawToken = request.cookies[SESSION_COOKIE];
    if (rawToken === undefined) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
    }
    try {
      await request.jwtVerify();
    } catch {
      throw new ApiError(401, "SESSION_INVALID", "Session is invalid or expired");
    }
    const claims = request.user;
    const parsedClaims = z
      .object({ sid: idSchema, sub: idSchema, tid: idSchema })
      .safeParse(claims);
    if (!parsedClaims.success) {
      throw new ApiError(401, "SESSION_INVALID", "Session is invalid or expired");
    }
    const session = await repository.resolveSession({
      actorId: parsedClaims.data.sub,
      tenantId: parsedClaims.data.tid,
      requestId: request.id,
      sessionId: parsedClaims.data.sid,
      tokenHash: sha256Text(rawToken),
      now: now().toISOString(),
    });
    if (session === null) {
      throw new ApiError(401, "SESSION_INVALID", "Session is invalid or expired");
    }
    const actor: ActorContext = {
      actorId: session.userId,
      tenantId: session.tenantId,
      role: session.role,
      capabilities: effectiveCapabilities(session.role, session.capabilities),
      requestId: request.id,
    };
    request.authContext = { actor, session };
    return request.authContext;
  }

  function assertCsrf(request: FastifyRequest, authenticated: AuthenticatedContext): void {
    const header = request.headers["x-csrf-token"];
    const cookieValue = request.cookies[CSRF_COOKIE];
    if (
      typeof header !== "string" ||
      cookieValue === undefined ||
      !encodedEqual(header, cookieValue) ||
      !encodedEqual(sha256Text(header), authenticated.session.csrfHash)
    ) {
      throw new ApiError(403, "CSRF_VALIDATION_FAILED", "CSRF validation failed");
    }
  }

  function guard(capability?: Capability, csrf = false) {
    return async (request: FastifyRequest): Promise<void> => {
      const authenticated = await authenticate(request);
      if (capability !== undefined) {
        try {
          requireCapability(authenticated.actor, capability);
        } catch {
          throw new ApiError(403, "AUTHORIZATION_DENIED", `Missing capability: ${capability}`);
        }
      }
      if (csrf) {
        assertCsrf(request, authenticated);
      }
    };
  }

  function requestContext(request: FastifyRequest): RequestContext {
    const authenticated = request.authContext;
    if (authenticated === null) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication required");
    }
    return {
      actorId: authenticated.actor.actorId,
      tenantId: authenticated.actor.tenantId,
      requestId: request.id,
    };
  }

  function ctripBridgeGateway(): CtripBridgeGateway {
    if (options.ctripBridgeGateway === undefined) {
      throw new ApiError(
        503,
        "CTRIP_BRIDGE_DISABLED",
        "Ctrip bridge is not configured for this deployment",
      );
    }
    return options.ctripBridgeGateway;
  }

  async function requireAssistedHandoff(
    request: FastifyRequest,
    allowedStates: readonly PublicationAssistedHandoffState[],
    requireCurrentLease: boolean,
  ) {
    const context = requestContext(request);
    const handoffId = parseIdParams(request.params, "handoffId");
    const handoff = await repository.getPublicationAssistedHandoff(context, handoffId);
    if (handoff === null) {
      throw new RepositoryNotFoundError("Publication assisted handoff was not found");
    }
    if (!allowedStates.includes(handoff.state)) {
      throw new RepositoryConflictError(
        `Publication assisted handoff cannot run this bridge command in state ${handoff.state}`,
      );
    }
    if (handoff.bridgeServicePrincipalId === null) {
      throw new RepositoryConflictError("Publication assisted handoff has no bound bridge");
    }
    if (
      requireCurrentLease &&
      (handoff.leaseOwnerActorId !== context.actorId ||
        handoff.leaseExpiresAt === null ||
        Date.parse(handoff.leaseExpiresAt) < now().getTime())
    ) {
      throw new RepositoryConflictError(
        "Publication assisted handoff requires the current operator lease",
      );
    }
    return { context, handoffId, handoff };
  }

  function assertBridgeResultScope(
    tenantId: string,
    handoff: Readonly<PublicationAssistedHandoffView>,
    result: Readonly<CtripBridgeResult>,
  ): void {
    if (
      result.tenantId !== tenantId ||
      result.handoffId !== handoff.id ||
      result.bridgePrincipalId !== handoff.bridgeServicePrincipalId ||
      result.adapterVersion !== handoff.adapterVersion
    ) {
      throw new ApiError(
        502,
        "CTRIP_BRIDGE_RESPONSE_INVALID",
        "Ctrip bridge returned a response outside the bound handoff scope",
      );
    }
  }

  async function issueSession(
    request: FastifyRequest,
    reply: FastifyReply,
    identity: LoginIdentity,
    membership: LoginMembership,
  ) {
    const membershipCapabilities = effectiveCapabilities(membership.role, membership.capabilities);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1_000);
    const sessionId = uuid();
    const csrfToken = randomToken();
    const token = app.jwt.sign(
      { sid: sessionId, sub: identity.userId, tid: membership.tenantId },
      { expiresIn: ttlSeconds },
    );
    await repository.createSession({
      actorId: identity.userId,
      tenantId: membership.tenantId,
      requestId: request.id,
      sessionId,
      tokenHash: sha256Text(token),
      csrfHash: sha256Text(csrfToken),
      expiresAt: expiresAt.toISOString(),
    });
    const cookieBase = {
      path: "/",
      secure: secureCookie,
      sameSite: "strict" as const,
      maxAge: ttlSeconds,
    };
    void reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true });
    void reply.setCookie(CSRF_COOKIE, csrfToken, { ...cookieBase, httpOnly: false });
    return {
      actor: {
        id: identity.userId,
        displayName: identity.displayName,
        role: membership.role,
        capabilities: membershipCapabilities,
      },
      tenant: {
        id: membership.tenantId,
        slug: membership.tenantSlug,
        displayName: membership.tenantDisplayName,
      },
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = await repository.isReady();
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const identity = await repository.findLoginIdentity(body.email.toLowerCase());
    let passwordValid: boolean;
    try {
      passwordValid = await passwordService.verify(
        identity?.passwordHash ?? dummyPasswordHash,
        body.password,
      );
    } catch {
      passwordValid = false;
    }
    if (identity === null || identity.status !== "active" || !passwordValid) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email, password, or tenant");
    }
    const membership = pickMembership(identity.memberships, body.tenantSlug);
    return reply.status(200).send(await issueSession(request, reply, identity, membership));
  });

  app.post("/api/auth/logout", { preHandler: guard(undefined, true) }, async (request, reply) => {
    const authenticated = request.authContext as AuthenticatedContext;
    await repository.revokeSession(requestContext(request), authenticated.session.sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    void reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/api/auth/session", { preHandler: guard() }, async (request) => {
    const authenticated = request.authContext as AuthenticatedContext;
    return {
      actor: authenticated.actor,
      session: {
        id: authenticated.session.sessionId,
        expiresAt: authenticated.session.expiresAt,
      },
      tenant: {
        id: authenticated.session.tenantId,
        slug: authenticated.session.tenantSlug,
        displayName: authenticated.session.tenantDisplayName,
      },
    };
  });

  app.get("/api/auth/tenants", { preHandler: guard() }, async (request) => {
    const authenticated = request.authContext as AuthenticatedContext;
    const identity = await repository.findLoginIdentityByUserId(authenticated.actor.actorId);
    if (identity === null || identity.status !== "active") {
      throw new ApiError(401, "SESSION_INVALID", "Session is invalid or expired");
    }
    return {
      items: identity.memberships.map((membership) => ({
        id: membership.tenantId,
        slug: membership.tenantSlug,
        displayName: membership.tenantDisplayName,
        role: membership.role,
        status:
          membership.membershipStatus === "active" && membership.tenantStatus === "active"
            ? "active"
            : "unavailable",
      })),
    };
  });

  app.post(
    "/api/auth/switch-tenant",
    { preHandler: guard(undefined, true) },
    async (request, reply) => {
      const body = switchTenantSchema.parse(request.body);
      const authenticated = request.authContext as AuthenticatedContext;
      const identity = await repository.findLoginIdentityByUserId(authenticated.actor.actorId);
      if (identity === null || identity.status !== "active") {
        throw new ApiError(401, "SESSION_INVALID", "Session is invalid or expired");
      }
      const membership = pickMembership(identity.memberships, body.tenantSlug);
      await repository.revokeSession(requestContext(request), authenticated.session.sessionId);
      return reply.status(200).send(await issueSession(request, reply, identity, membership));
    },
  );

  app.get("/api/tenant", { preHandler: guard("tenant:read") }, async (request) =>
    repository.getTenant(requestContext(request)),
  );

  app.get("/api/brands", { preHandler: guard("tenant:read") }, async (request) => ({
    items: await repository.listBrands(requestContext(request)),
  }));
  app.post("/api/brands", { preHandler: guard("tenant:manage", true) }, async (request, reply) => {
    const body = brandSchema.parse(request.body);
    const brand = await repository.createBrand(requestContext(request), {
      id: uuid(),
      canonicalName: body.canonicalName,
      displayName: body.displayName,
      aliases: body.aliases,
      description: body.description ?? null,
      industry: body.industry,
      websiteUrl: body.websiteUrl ?? null,
      isPrimary: body.isPrimary,
    });
    return reply.status(201).send(brand);
  });
  app.get("/api/brand-agent-profiles", { preHandler: guard("content:read") }, async (request) => ({
    items: await repository.listBrandAgentProfiles(requestContext(request)),
  }));
  app.get(
    "/api/brands/:brandId/agent-profile",
    { preHandler: guard("content:read") },
    async (request) => {
      const brandId = parseIdParams(request.params, "brandId");
      const profile = await repository.getBrandAgentProfile(requestContext(request), brandId);
      if (profile === null) {
        throw new ApiError(
          404,
          "BRAND_AGENT_PROFILE_NOT_FOUND",
          "Brand Agent Profile was not found",
        );
      }
      return profile;
    },
  );
  app.post(
    "/api/brands/:brandId/agent-profile",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const brandId = parseIdParams(request.params, "brandId");
      const body = brandAgentProfileRequestSchema.parse(request.body);
      const profile = await repository.createBrandAgentProfile(requestContext(request), {
        id: uuid(),
        brandId,
        document: body.document,
        documentHash: sha256Canonical(body.document),
        effectiveAt: now().toISOString(),
        reason: body.reason,
      });
      return reply.status(201).send(profile);
    },
  );
  app.get("/api/members", { preHandler: guard("member:manage") }, async (request) => ({
    items: await repository.listMembers(requestContext(request)),
  }));
  app.post("/api/members", { preHandler: guard("member:manage", true) }, async (request, reply) => {
    const body = memberCreateRequestSchema.parse(request.body);
    const authenticated = request.authContext as AuthenticatedContext;
    try {
      assertMemberManagementAllowed(authenticated.actor.role, null, body.role);
    } catch {
      throw new ApiError(403, "AUTHORIZATION_DENIED", "Only an owner may create an owner");
    }
    const member = await repository.createMember(requestContext(request), {
      membershipId: uuid(),
      userId: uuid(),
      email: body.email,
      displayName: body.displayName,
      passwordHash: await passwordService.hash(body.initialPassword),
      role: body.role,
    });
    return reply.status(201).send(member);
  });
  app.patch(
    "/api/members/:memberId",
    { preHandler: guard("member:manage", true) },
    async (request, reply) => {
      const memberId = parseIdParams(request.params, "memberId");
      const body = memberUpdateRequestSchema.parse(request.body);
      const member = await repository.updateMember(requestContext(request), {
        membershipId: memberId,
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.status === undefined ? {} : { status: body.status }),
        reason: body.reason,
      });
      return reply.status(200).send(member);
    },
  );
  app.get("/api/policies", { preHandler: guard("audit:read") }, async (request) => ({
    items: await repository.listPolicyBundles(requestContext(request)),
  }));
  app.post(
    "/api/policies",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const body = policyBundleSchema.parse(request.body);
      const policy = await repository.createPolicyBundle(requestContext(request), {
        id: uuid(),
        version: body.version,
        policyHash: sha256Canonical(body.document),
        document: body.document,
        effectiveAt: body.effectiveAt ?? now().toISOString(),
        reason: body.reason,
      });
      return reply.status(201).send(policy);
    },
  );
  app.post(
    "/api/policies/:policyId/state",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const policyBundleId = parseIdParams(request.params, "policyId");
      const body = policyTransitionRequestSchema.parse(request.body);
      const result = await repository.transitionPolicyBundle(requestContext(request), {
        policyBundleId,
        targetStatus: body.targetStatus,
        reason: body.reason,
        changedAt: now().toISOString(),
      });
      return reply.status(200).send(result);
    },
  );
  app.get("/api/query-sets", { preHandler: guard("visibility:read") }, async (request) => ({
    items: await repository.listQuerySets(requestContext(request)),
  }));
  app.post(
    "/api/query-sets",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const body = querySetSchema.parse(request.body);
      const querySet = await repository.createQuerySet(requestContext(request), {
        querySetId: uuid(),
        versionId: uuid(),
        name: body.name,
        industry: body.industry,
        description: body.description,
        prompts: body.prompts,
        promptHash: sha256Canonical(body.prompts),
      });
      return reply.status(201).send(querySet);
    },
  );
  app.get(
    "/api/query-sets/:querySetId/versions",
    { preHandler: guard("visibility:read") },
    async (request) => ({
      items: await repository.listQuerySetVersions(
        requestContext(request),
        parseIdParams(request.params, "querySetId"),
      ),
    }),
  );
  app.post(
    "/api/query-sets/:querySetId/versions",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const querySetId = parseIdParams(request.params, "querySetId");
      const body = querySetVersionSchema.parse(request.body);
      const context = requestContext(request);
      const promptHash = sha256Canonical(body.prompts);
      const version = await repository.createQuerySetVersion(context, {
        querySetId,
        versionId: uuid(),
        prompts: body.prompts,
        promptHash,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          querySetId,
          promptHash,
          reason: body.reason,
        }),
      });
      return reply.status(201).send(version);
    },
  );
  app.post(
    "/api/query-sets/:querySetId/versions/:versionId/activate",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const params = z
        .strictObject({ querySetId: idSchema, versionId: idSchema })
        .parse(request.params);
      const body = querySetVersionActivationSchema.parse(request.body);
      const context = requestContext(request);
      const result = await repository.activateQuerySetVersion(context, {
        querySetId: params.querySetId,
        versionId: params.versionId,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          querySetId: params.querySetId,
          versionId: params.versionId,
          reason: body.reason,
        }),
      });
      return reply.status(200).send(result);
    },
  );
  app.post(
    "/api/query-sets/:querySetId/state",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const querySetId = parseIdParams(request.params, "querySetId");
      const body = querySetStateSchema.parse(request.body);
      const context = requestContext(request);
      const result = await repository.transitionQuerySet(context, {
        querySetId,
        targetStatus: body.targetStatus,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          querySetId,
          targetStatus: body.targetStatus,
          reason: body.reason,
        }),
      });
      return reply.status(200).send(result);
    },
  );

  app.get("/api/automation", { preHandler: guard("tenant:read") }, async (request) =>
    repository.getAutomationStatus(requestContext(request)),
  );
  app.put(
    "/api/automation/control",
    { preHandler: guard("automation:manage", true) },
    async (request, reply) => {
      const body = automationControlSchema.parse(request.body);
      const context = requestContext(request);
      const control = await repository.setTenantAutomationControl(context, {
        controlId: uuid(),
        mode: body.mode,
        quota: body.quota,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          mode: body.mode,
          quota: body.quota,
          reason: body.reason,
        }),
      });
      return reply.status(200).send({ control });
    },
  );
  app.put(
    "/api/automation/controls/:scopeType/:scopeKey",
    { preHandler: guard("automation:manage", true) },
    async (request, reply) => {
      const scope = automationScopeParamsSchema.parse(request.params);
      if (scope.scopeType === "tenant") {
        throw new ApiError(
          400,
          "AUTOMATION_SCOPE_INVALID",
          "Use /api/automation/control for the tenant scope",
        );
      }
      const body = scopedAutomationControlSchema.parse(request.body);
      const context = requestContext(request);
      const control = await repository.setScopedAutomationControl(context, {
        controlId: uuid(),
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        mode: body.mode,
        quota: body.quota,
        killSwitchEnabled: body.killSwitchEnabled,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          mode: body.mode,
          quota: body.quota,
          killSwitchEnabled: body.killSwitchEnabled,
          reason: body.reason,
        }),
      });
      return reply.status(200).send({ control });
    },
  );
  app.post(
    "/api/automation/circuits/:scopeType/:scopeKey/state",
    { preHandler: guard("automation:manage", true) },
    async (request, reply) => {
      const scope = automationScopeParamsSchema.parse(request.params);
      const body = circuitStateSchema.parse(request.body);
      const retryAt = body.targetState === "open" ? (body.retryAt ?? null) : null;
      if (retryAt !== null) {
        const retryTime = new Date(retryAt).getTime();
        const currentTime = now().getTime();
        if (retryTime <= currentTime || retryTime > currentTime + 30 * 24 * 60 * 60 * 1_000) {
          throw new ApiError(400, "CIRCUIT_RETRY_INVALID", "retryAt must be in the next 30 days");
        }
      }
      const context = requestContext(request);
      const circuit = await repository.setCircuitBreakerState(context, {
        circuitId: uuid(),
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        targetState: body.targetState,
        retryAt,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          targetState: body.targetState,
          retryAt,
          reason: body.reason,
        }),
      });
      return reply.status(200).send({ circuit });
    },
  );
  app.post(
    "/api/automation/kill-switch",
    { preHandler: guard("automation:manage", true) },
    async (request, reply) => {
      const body = killSwitchSchema.parse(request.body);
      const context = requestContext(request);
      const control = await repository.setTenantKillSwitch(context, {
        controlId: uuid(),
        enabled: body.enabled,
        reason: body.reason,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          enabled: body.enabled,
          reason: body.reason,
        }),
      });
      return reply.status(200).send({ control });
    },
  );

  app.get("/api/contacts", { preHandler: guard("tenant:read") }, async (request) => ({
    items: await repository.listContacts(requestContext(request)),
  }));
  app.post(
    "/api/contacts",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const body = contactCreateRequestSchema.parse(request.body);
      const contact = await repository.createContact(requestContext(request), {
        id: uuid(),
        type: body.type,
        label: body.label,
        value: body.value,
        normalizedValue: normalizeContactValue(body.type, body.value),
        isPrimary: body.isPrimary,
        validFrom: body.validFrom ?? now().toISOString(),
      });
      return reply.status(201).send(contact);
    },
  );
  app.post(
    "/api/contacts/:contactId/expire",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const contactId = parseIdParams(request.params, "contactId");
      const body = contactExpireRequestSchema.parse(request.body);
      const contact = await repository.expireContact(requestContext(request), {
        contactId,
        reason: body.reason,
        validUntil: body.validUntil ?? now().toISOString(),
      });
      return reply.status(200).send(contact);
    },
  );

  app.get("/api/channel-accounts", { preHandler: guard("tenant:read") }, async (request) => ({
    items: await repository.listChannelAccounts(requestContext(request)),
  }));
  app.post(
    "/api/channel-accounts",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const body = channelAccountCreateRequestSchema.parse(request.body);
      const account = await repository.createChannelAccount(requestContext(request), {
        id: uuid(),
        platform: body.platform,
        displayName: body.displayName,
        capability: body.capability,
        supportedExecutionLevels: body.supportedExecutionLevels,
        credentialRef: body.credentialRef ?? null,
        evidenceType: body.evidenceType,
        evidenceRefs: body.evidenceRefs,
        status: body.status,
        lastVerifiedAt: body.lastVerifiedAt ?? null,
      });
      return reply.status(201).send(account);
    },
  );
  app.patch(
    "/api/channel-accounts/:channelAccountId",
    { preHandler: guard("tenant:manage", true) },
    async (request, reply) => {
      const channelAccountId = parseIdParams(request.params, "channelAccountId");
      const body = channelAccountUpdateRequestSchema.parse(request.body);
      const account = await repository.updateChannelAccount(requestContext(request), {
        channelAccountId,
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        ...(body.capability === undefined ? {} : { capability: body.capability }),
        ...(body.supportedExecutionLevels === undefined
          ? {}
          : { supportedExecutionLevels: body.supportedExecutionLevels }),
        ...(body.credentialRef === undefined ? {} : { credentialRef: body.credentialRef }),
        ...(body.evidenceType === undefined ? {} : { evidenceType: body.evidenceType }),
        ...(body.evidenceRefs === undefined ? {} : { evidenceRefs: body.evidenceRefs }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: body.lastVerifiedAt }),
        reason: body.reason,
      });
      return reply.status(200).send(account);
    },
  );

  app.get(
    "/api/service-principals",
    { preHandler: guard("principal:manage") },
    async (request) => ({ items: await repository.listServicePrincipals(requestContext(request)) }),
  );
  app.post(
    "/api/service-principals/automation-producers",
    { preHandler: guard("principal:manage", true) },
    async (request, reply) => {
      const body = automationServicePrincipalCreateRequestSchema.parse(request.body);
      const principal = await repository.createAutomationServicePrincipal(requestContext(request), {
        id: uuid(),
        name: body.name,
      });
      return reply.status(201).send(principal);
    },
  );
  app.post(
    "/api/service-principals/ctrip-bridges",
    { preHandler: guard("principal:manage", true) },
    async (request, reply) => {
      const body = ctripBridgeServicePrincipalCreateRequestSchema.parse(request.body);
      const principal = await repository.createCtripBridgeServicePrincipal(
        requestContext(request),
        { id: uuid(), name: body.name },
      );
      return reply.status(201).send(principal);
    },
  );
  app.post(
    "/api/service-principals/:servicePrincipalId/status",
    { preHandler: guard("principal:manage", true) },
    async (request, reply) => {
      const servicePrincipalId = parseIdParams(request.params, "servicePrincipalId");
      const body = servicePrincipalStatusRequestSchema.parse(request.body);
      const result = await repository.setServicePrincipalStatus(requestContext(request), {
        servicePrincipalId,
        status: body.status,
        reason: body.reason,
      });
      return reply.status(200).send(result);
    },
  );

  app.get("/api/evidence-sources", { preHandler: guard("content:read") }, async (request) => ({
    items: await repository.listEvidenceSources(requestContext(request)),
  }));
  app.get("/api/article-templates", { preHandler: guard("content:read") }, async () => ({
    version: ARTICLE_TEMPLATE_CATALOG_VERSION,
    items: ARTICLE_TEMPLATES,
  }));
  app.get("/api/agent/capability", { preHandler: guard("content:read") }, async (request) => {
    const context = requestContext(request);
    return (
      (await options.agentRunGateway?.getCapability(context.tenantId)) ?? {
        available: false,
        mode: "disabled",
        provider: null,
        model: null,
        reason: "tenant_not_configured",
      }
    );
  });
  app.post("/api/agent/runs", { preHandler: guard("content:write", true) }, async (request) => {
    if (options.agentRunGateway === undefined) {
      throw new AgentRunGatewayError(
        503,
        "AGENT_TENANT_NOT_CONFIGURED",
        "Agent runner is not configured for this tenant",
      );
    }
    const context = requestContext(request);
    const body = agentRunRequestSchema.parse(request.body);
    return options.agentRunGateway.run({
      ...body,
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestId: context.requestId,
    });
  });
  app.post(
    "/api/evidence-sources",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      const body = evidenceSourceSchema.parse(request.body);
      const evidence = await repository.createEvidenceSource(requestContext(request), {
        id: uuid(),
        type: body.type,
        title: body.title,
        sourceUrl: body.sourceUrl ?? null,
        contentHash: sha256Text(body.content),
        content: body.content,
        capturedAt: body.capturedAt,
        validUntil: body.validUntil ?? null,
        metadata: body.metadata ?? {},
      });
      return reply.status(201).send(evidence);
    },
  );

  app.get("/api/facts", { preHandler: guard("content:read") }, async (request) => {
    const query = factQuerySchema.parse(request.query);
    return {
      items: await repository.listFacts(requestContext(request), {
        limit: query.limit,
        ...(query.brandId === undefined ? {} : { brandId: query.brandId }),
        ...(query.query === undefined ? {} : { query: query.query }),
      }),
    };
  });
  app.post("/api/facts", { preHandler: guard("content:write", true) }, async (request, reply) => {
    const body = factSchema.parse(request.body);
    if (body.status === "verified") {
      const actor = (request.authContext as AuthenticatedContext).actor;
      try {
        requireCapability(actor, "tenant:manage");
      } catch {
        throw new ApiError(
          403,
          "FACT_VERIFICATION_DENIED",
          "Verified facts require tenant management authority",
        );
      }
    }
    const fact = await repository.createFact(requestContext(request), {
      id: uuid(),
      brandId: body.brandId,
      normalizedKey: body.normalizedKey,
      claim: body.claim,
      status: body.status,
      evidenceSourceIds: body.evidenceSourceIds,
      validFrom: body.validFrom ?? now().toISOString(),
      validUntil: body.validUntil ?? null,
    });
    return reply.status(201).send(fact);
  });

  app.get("/api/capabilities", { preHandler: guard("tenant:read") }, async (request) => {
    const accounts = await repository.listChannelAccounts(requestContext(request));
    return {
      mediaProduction: mediaProductionCapability,
      items: accounts.map((account) => ({
        accountId: account.id,
        platform: account.platform,
        capability: account.capability,
        supportedExecutionLevels: account.supportedExecutionLevels,
        checkedAt: account.lastVerifiedAt,
        evidenceType: account.evidenceType,
        evidenceRefs: account.evidenceRefs,
        status: account.status,
      })),
    };
  });

  app.post("/api/resource-scope-check", { preHandler: guard("tenant:read") }, async (request) => {
    const body = resourceScopeSchema.parse(request.body);
    return repository.checkResourceScope(requestContext(request), body.resources);
  });

  app.get("/api/campaigns", { preHandler: guard("content:read") }, async (request) => ({
    items: await repository.listCampaigns(requestContext(request)),
  }));
  app.post(
    "/api/campaigns",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      const body = campaignSchema.parse(request.body);
      const campaign = await repository.createCampaign(requestContext(request), {
        id: uuid(),
        ...body,
      });
      return reply.status(201).send(campaign);
    },
  );
  app.post(
    "/api/campaigns/:campaignId/state",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      const campaignId = parseIdParams(request.params, "campaignId");
      const body = campaignTransitionSchema.parse(request.body);
      const context = requestContext(request);
      const result = await repository.transitionCampaign(context, {
        campaignId,
        targetStatus: body.status,
        reason: body.reason ?? null,
        auditHash: sha256Canonical({
          tenantId: context.tenantId,
          campaignId,
          targetStatus: body.status,
          reason: body.reason ?? null,
        }),
      });
      return reply.status(200).send(result);
    },
  );

  app.post(
    "/api/campaigns/:campaignId/automation-batches",
    { preHandler: guard("automation:manage", true) },
    async (request, reply) => {
      const campaignId = parseIdParams(request.params, "campaignId");
      const body = automationBatchCreateRequestSchema.parse(request.body);
      const currentTime = now().getTime();
      for (const item of body.items) {
        const scheduledAt = Date.parse(item.scheduledFor);
        if (
          scheduledAt < currentTime - 60_000 ||
          scheduledAt > currentTime + 90 * 24 * 60 * 60 * 1_000
        ) {
          throw new ApiError(
            400,
            "AUTOMATION_SCHEDULE_INVALID",
            "Automation slots must be scheduled within the next 90 days",
          );
        }
      }
      const batchId = uuid();
      const requestHash = sha256Canonical({
        campaignId,
        name: body.name ?? null,
        items: body.items,
        executionLevel: "dry_run",
      });
      const result = await repository.createAutomationBatch(requestContext(request), {
        batchId,
        campaignId,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        name: body.name ?? null,
        runs: body.items.map((item) => {
          const runId = uuid();
          return {
            runId,
            slotKey: item.slotKey,
            topicKey: item.topicKey,
            brief: item.brief,
            availableAt: item.scheduledFor,
            idempotencyKey: `automation:${runId}:run:v1`,
            requestHash: sha256Canonical({ campaignId, ...item }),
            targets: item.channelAccountIds.map((channelAccountId) => {
              const targetId = uuid();
              return {
                targetId,
                channelAccountId,
                variantIdempotencyKey: `automation:${runId}:target:${targetId}:variant:v1`,
                auditIdempotencyKey: `automation:${runId}:target:${targetId}:audit:v1`,
                publicationIdempotencyKey: `automation:${runId}:target:${targetId}:publication:v1`,
              };
            }),
          };
        }),
      });
      return reply.status(result.wasCreated ? 201 : 200).send(result);
    },
  );

  app.get("/api/automation-batches", { preHandler: guard("tenant:read") }, async (request) => {
    const query = automationBatchListQuerySchema.parse(request.query);
    const items = await repository.listAutomationBatches(requestContext(request), {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.campaignId === undefined ? {} : { campaignId: query.campaignId }),
    });
    return {
      items,
      nextBefore: items.length === query.limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  });

  app.post(
    "/api/automation-batches/:batchId/cancel",
    { preHandler: guard("automation:manage", true) },
    async (request) => {
      const batchId = parseIdParams(request.params, "batchId");
      const body = automationCancelCommandSchema.parse(request.body);
      return repository.cancelAutomationBatch(requestContext(request), batchId, body.reason);
    },
  );

  app.get("/api/automation-runs", { preHandler: guard("tenant:read") }, async (request) => {
    const query = automationRunListQuerySchema.parse(request.query);
    const items = await repository.listAutomationRuns(requestContext(request), {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.batchId === undefined ? {} : { batchId: query.batchId }),
    });
    return {
      items,
      nextBefore: items.length === query.limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  });

  app.post(
    "/api/automation-runs/claim",
    { preHandler: guard("automation:execute", true) },
    async (request) => {
      const body = automationClaimCommandSchema.parse(request.body);
      const actor = (request.authContext as AuthenticatedContext).actor;
      return {
        items: await repository.claimAutomationRuns(requestContext(request), {
          workerId: scopedWorkerId(actor.actorId, body.producerId),
          limit: body.limit,
          leaseSeconds: body.leaseSeconds,
        }),
      };
    },
  );

  app.get("/api/automation-runs/:runId", { preHandler: guard("tenant:read") }, async (request) => {
    const run = await repository.getAutomationRun(
      requestContext(request),
      parseIdParams(request.params, "runId"),
    );
    if (run === null) throw new RepositoryNotFoundError("Automation run was not found");
    return run;
  });

  app.post(
    "/api/automation-runs/:runId/heartbeat",
    { preHandler: guard("automation:execute", true) },
    async (request) => {
      const body = automationHeartbeatCommandSchema.parse(request.body);
      const actor = (request.authContext as AuthenticatedContext).actor;
      return repository.heartbeatAutomationRun(requestContext(request), {
        runId: parseIdParams(request.params, "runId"),
        workerId: scopedWorkerId(actor.actorId, body.producerId),
        attempt: body.attempt,
        stage: body.stage,
        checkpoint: body.checkpoint,
        leaseSeconds: body.leaseSeconds,
      });
    },
  );

  app.post(
    "/api/automation-runs/:runId/draft-checkpoint",
    { preHandler: guard("automation:execute", true) },
    async (request) => {
      const body = automationDraftCheckpointCommandSchema.parse(request.body);
      const actor = (request.authContext as AuthenticatedContext).actor;
      return repository.checkpointAutomationDraft(requestContext(request), {
        runId: parseIdParams(request.params, "runId"),
        workerId: scopedWorkerId(actor.actorId, body.producerId),
        attempt: body.attempt,
        contentItemId: body.contentItemId,
        contentVersionId: body.contentVersionId,
        checkpoint: body.checkpoint,
        leaseSeconds: body.leaseSeconds,
      });
    },
  );

  app.post(
    "/api/automation-runs/:runId/targets/:targetId/checkpoint",
    { preHandler: guard("automation:execute", true) },
    async (request) => {
      const body = automationTargetCheckpointCommandSchema.parse(request.body);
      const actor = (request.authContext as AuthenticatedContext).actor;
      return repository.checkpointAutomationTarget(requestContext(request), {
        runId: parseIdParams(request.params, "runId"),
        targetId: parseIdParams(request.params, "targetId"),
        workerId: scopedWorkerId(actor.actorId, body.producerId),
        attempt: body.attempt,
        state: body.state,
        variantId: body.variantId ?? null,
        auditRunId: body.auditRunId ?? null,
        auditArtifactId: body.auditArtifactId ?? null,
        publicationJobId: body.publicationJobId ?? null,
        errorCode: body.errorCode ?? null,
        errorMessage: body.errorMessage ?? null,
        checkpoint: body.checkpoint,
        leaseSeconds: body.leaseSeconds,
      });
    },
  );

  app.post(
    "/api/automation-runs/:runId/reconcile",
    { preHandler: guard("automation:execute", true) },
    async (request) => {
      const body = automationReconcileCommandSchema.parse(request.body);
      const actor = (request.authContext as AuthenticatedContext).actor;
      const retryAfterSeconds =
        body.retryAfter === undefined
          ? null
          : Math.max(0, Math.ceil((Date.parse(body.retryAfter) - now().getTime()) / 1_000));
      if (retryAfterSeconds !== null && retryAfterSeconds > 86_400) {
        throw new ApiError(
          400,
          "AUTOMATION_RETRY_INVALID",
          "Automation retry must be scheduled within 24 hours",
        );
      }
      return repository.reconcileAutomationRun(requestContext(request), {
        runId: parseIdParams(request.params, "runId"),
        workerId: scopedWorkerId(actor.actorId, body.producerId),
        attempt: body.attempt,
        retryAfterSeconds,
        errorCode: body.errorCode ?? null,
        errorMessage: body.errorMessage ?? null,
      });
    },
  );

  app.get("/api/content", { preHandler: guard("content:read") }, async (request) => ({
    items: await repository.listContent(requestContext(request)),
  }));
  app.post("/api/content", { preHandler: guard("content:write", true) }, async (request, reply) => {
    const body = contentSchema.parse(request.body);
    const contentId = uuid();
    const versionId = uuid();
    const payloadHash = sha256Canonical(body.payload);
    const requestHash = sha256Canonical({
      campaignId: body.campaignId,
      brandId: body.brandId,
      title: body.title,
      contentType: body.contentType,
      topicKey: body.topicKey,
      payloadHash,
    });
    const content = await repository.createContent(requestContext(request), {
      contentId,
      versionId,
      idempotencyKey: body.idempotencyKey,
      requestHash,
      campaignId: body.campaignId,
      brandId: body.brandId,
      title: body.title,
      contentType: body.contentType,
      topicKey: body.topicKey,
      summary: body.payload.summary,
      bodyMarkdown: body.payload.bodyMarkdown,
      payload: body.payload,
      payloadHash,
    });
    return reply.status(201).send(content);
  });

  app.post(
    "/api/content/:contentId/versions",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      const body = contentVersionSchema.parse(request.body);
      const versionId = uuid();
      const content = await repository.createContentVersion(requestContext(request), {
        versionId,
        contentItemId: parseIdParams(request.params, "contentId"),
        summary: body.payload.summary,
        bodyMarkdown: body.payload.bodyMarkdown,
        payload: body.payload,
        payloadHash: sha256Canonical(body.payload),
      });
      return reply.status(201).send({ ...content, latestVersionId: versionId });
    },
  );

  app.get(
    "/api/content-versions/:contentVersionId",
    { preHandler: guard("content:read") },
    async (request) => {
      const version = await repository.getContentVersion(
        requestContext(request),
        parseIdParams(request.params, "contentVersionId"),
      );
      if (version === null) {
        throw new RepositoryNotFoundError("Content version was not found");
      }
      return version;
    },
  );

  app.post(
    "/api/content-versions/:id/media-jobs",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      if (mediaProduction === undefined) {
        throw new MediaProductionServiceError(
          "MEDIA_PRODUCTION_DISABLED",
          503,
          "Media production is disabled",
        );
      }
      const body = mediaProductionBodySchema.parse(request.body);
      const result = await mediaProduction.request(requestContext(request), {
        contentVersionId: parseIdParams(request.params, "id"),
        ...body,
      });
      return reply.status(result.wasCreated ? 201 : 200).send(result);
    },
  );

  app.get("/api/media-jobs/:id", { preHandler: guard("content:read") }, async (request) => {
    const context = requestContext(request);
    const job = await repository.getMediaJob(context, parseIdParams(request.params, "id"));
    if (job === null) {
      throw new MediaProductionServiceError("MEDIA_JOB_NOT_FOUND", 404, "Media job was not found");
    }
    const asset =
      job.state === "succeeded" && job.assetId !== null
        ? await repository.getMediaAsset(context, job.assetId)
        : null;
    if (job.state === "succeeded" && asset === null) {
      throw new MediaProductionServiceError(
        "MEDIA_JOB_ASSET_INCONSISTENT",
        409,
        "Succeeded media job has no immutable asset",
      );
    }
    return { capability: mediaProductionCapability, job, asset };
  });

  app.get("/api/media-assets", { preHandler: guard("content:read") }, async (request) => {
    const query = mediaAssetListQuerySchema.parse(request.query);
    return {
      capability: mediaProductionCapability,
      items: await repository.listMediaAssets(requestContext(request), query.contentVersionId),
    };
  });

  app.get(
    "/api/content/:contentId/variants",
    { preHandler: guard("content:read") },
    async (request) => ({
      items: await repository.listVariants(
        requestContext(request),
        parseIdParams(request.params, "contentId"),
      ),
    }),
  );
  app.post(
    "/api/content/:contentId/variants",
    { preHandler: guard("content:write", true) },
    async (request, reply) => {
      const body = variantSchema.parse(request.body);
      const context = requestContext(request);
      const renderedAt = now().toISOString();
      const [version, accounts, contacts, policyBundles, facts] = await Promise.all([
        repository.getContentVersion(context, body.contentVersionId),
        repository.listChannelAccounts(context),
        repository.listContacts(context),
        repository.listPolicyBundles(context),
        repository.listFacts(context, { limit: 200 }),
      ]);
      const account = accounts.find((candidate) => candidate.id === body.channelAccountId);
      if (version === null || account === undefined || account.status !== "active") {
        throw new RepositoryNotFoundError("Content version or channel account was not found");
      }
      const activePolicyBundle = policyBundles.find(
        (bundle) =>
          bundle.status === "active" && Date.parse(bundle.effectiveAt) <= Date.parse(renderedAt),
      );
      if (activePolicyBundle === undefined) {
        throw new RepositoryNotFoundError("No active policy bundle was found");
      }
      const policy = compileAuditPolicy({
        version: activePolicyBundle.version,
        policyHash: activePolicyBundle.policyHash,
        document: activePolicyBundle.document,
      });
      const verifiedFacts = facts.filter((fact) => fact.status === "verified");
      const factSnapshot: FactSnapshot = {
        tenantId: context.tenantId,
        capturedAt: renderedAt,
        facts: verifiedFacts.map((fact) => ({
          id: fact.id,
          brandId: fact.brandId,
          text: fact.claim,
          evidenceSourceIds: fact.evidenceSourceIds,
          validFrom: fact.validFrom,
          validUntil: fact.validUntil,
        })),
        sources: [],
      };
      const sourcePayload = publicationVariantPayloadSchema.parse(version.payload);
      const payload = renderPlatformPublicationVariant({
        sourcePayload,
        platform: account.platform,
        policy,
        factSnapshot,
        contacts,
      });
      const variant = await repository.createVariant(context, {
        variantId: uuid(),
        contentItemId: parseIdParams(request.params, "contentId"),
        contentVersionId: body.contentVersionId,
        channelAccountId: body.channelAccountId,
        payload,
        payloadHash: sha256Canonical(payload),
      });
      return reply.status(201).send(variant);
    },
  );

  app.post(
    "/api/variants/:variantId/audits",
    { preHandler: guard("audit:run", true) },
    async (request, reply) => {
      const body = auditRequestSchema.parse(request.body);
      const variantId = parseIdParams(request.params, "variantId");
      const requestScope = requestContext(request);
      const actor = (request.authContext as AuthenticatedContext).actor;
      const requestHash = sha256Canonical({
        operation: "audit_publication_variant",
        tenantId: requestScope.tenantId,
        actorId: requestScope.actorId,
        variantId,
      });
      const existing = await repository.findAuditByIdempotency(
        requestScope,
        body.idempotencyKey,
        requestHash,
      );
      if (existing !== null) {
        return reply
          .status(200)
          .send(auditResponse(existing, actor, body.idempotencyKey, requestHash));
      }
      const createdAt = now().toISOString();
      const context = await repository.loadAuditContext(requestScope, variantId, createdAt);
      if (context === null) {
        throw new RepositoryNotFoundError("Publication variant was not found");
      }
      const payload = publicationVariantPayloadSchema.parse(context.variant.payload);
      const policy = compileAuditPolicy({
        version: context.policyBundle.version,
        policyHash: context.policyBundle.policyHash,
        document: context.policyBundle.document,
      });
      const artifact = auditPublicationVariant({
        artifactId: uuid(),
        tenantId: requestScope.tenantId,
        brandSnapshot: context.brandSnapshot,
        variantId,
        channelAccountId: context.variant.channelAccountId,
        platform: context.variant.platform,
        payload,
        contacts: context.contacts,
        factSnapshot: context.factSnapshot,
        policy,
        priorVariants: context.priorVariants,
        createdAt,
      });
      const shouldIssue = artifact.status === "passed" && hasCapability(actor, "publish:request");
      const grantId = shouldIssue ? uuid() : null;
      const publicationToken =
        grantId === null
          ? null
          : publicationTokenFactory({
              tenantId: requestScope.tenantId,
              grantId,
              idempotencyKey: body.idempotencyKey,
              requestHash,
            });
      const grant =
        publicationToken === null || grantId === null
          ? null
          : issuePublicationGrant({
              grantId,
              auditArtifact: artifact,
              token: publicationToken,
              issuedAt: createdAt,
            });
      const persisted = await repository.persistAudit(requestScope, {
        idempotencyKey: body.idempotencyKey,
        requestHash,
        auditRunId: uuid(),
        policyBundleId: context.policyBundle.id,
        artifact,
        grant,
      });
      return reply
        .status(persisted.wasCreated ? 201 : 200)
        .send(auditResponse(persisted, actor, body.idempotencyKey, requestHash));
    },
  );

  app.get("/api/audits", { preHandler: guard("audit:read") }, async (request) => {
    const query = auditListQuerySchema.parse(request.query);
    const items = await repository.listAudits(requestContext(request), {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.platform === undefined ? {} : { platform: query.platform }),
    });
    return {
      items,
      nextBefore: items.length === query.limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  });
  app.get("/api/audit-log", { preHandler: guard("audit:read") }, async (request) => {
    const query = auditLogQuerySchema.parse(request.query);
    const items = await repository.listAuditLog(requestContext(request), {
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
    });
    return {
      items,
      nextBefore: items.length === query.limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  });
  app.get("/api/audits/:artifactId", { preHandler: guard("audit:read") }, async (request) => {
    const artifact = await repository.getAudit(
      requestContext(request),
      parseIdParams(request.params, "artifactId"),
    );
    if (artifact === null) {
      throw new RepositoryNotFoundError("Audit artifact was not found");
    }
    return artifact;
  });

  app.post(
    "/api/audits/:artifactId/manual-publication-package",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      try {
        return await createManualPublicationPackageExport({
          repository,
          context: requestContext(request),
          auditArtifactId: parseIdParams(request.params, "artifactId"),
          exportedAt: now().toISOString(),
          ...(options.mediaObjectStore === undefined
            ? {}
            : { mediaObjectStore: options.mediaObjectStore }),
        });
      } catch (error) {
        if (error instanceof ManualPublicationPackageExportError) {
          throw new ApiError(error.statusCode, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/publication-requests",
    { preHandler: guard("publish:request", true) },
    async (request, reply) => {
      const body = publicationRequestSchema.parse(request.body);
      if (body.executionLevel === "unattended") {
        throw new ApiError(
          422,
          "PUBLICATION_CAPABILITY_UNSUPPORTED",
          "Current platform adapters support dry-run and Ctrip assisted handoffs only",
        );
      }
      if (body.scheduledFor !== undefined) {
        const scheduledAt = new Date(body.scheduledFor).getTime();
        const currentTime = now().getTime();
        if (scheduledAt < currentTime || scheduledAt > currentTime + 30 * 24 * 60 * 60 * 1_000) {
          throw new ApiError(
            400,
            "PUBLICATION_SCHEDULE_INVALID",
            "Scheduled publication must be within the next 30 days",
          );
        }
      }
      const tokenHash = sha256Text(body.token);
      const requestHash = sha256Canonical({
        grantId: body.grantId,
        tokenHash,
        idempotencyKey: body.idempotencyKey,
        executionLevel: body.executionLevel,
        scheduledFor: body.scheduledFor ?? null,
      });
      const context = requestContext(request);
      const actor = (request.authContext as AuthenticatedContext).actor;
      const publicationContext = await repository.getPublicationGovernanceContext(
        context,
        body.grantId,
      );
      if (publicationContext === null) {
        throw new RepositoryNotFoundError("Publication grant was not found");
      }
      if (
        body.executionLevel === "assisted" &&
        publicationContext.artifact.platform !== "ctrip_community"
      ) {
        throw new ApiError(
          422,
          "PUBLICATION_CAPABILITY_UNSUPPORTED",
          "Current platform adapters support dry-run and Ctrip assisted handoffs only",
        );
      }
      const decisionId = uuid();
      let governanceDecision: Awaited<ReturnType<PublicationGovernanceGate["evaluate"]>>;
      try {
        governanceDecision = await options.publicationGovernanceGate.evaluate({
          phase: "grant_consumption",
          tenantId: context.tenantId,
          actorId: actor.actorId,
          resourceId: body.grantId,
          executionLevel: body.executionLevel,
          requestFingerprint: requestHash,
          publicationContext,
        });
      } catch {
        const unavailable: PublicationGovernanceAuditInput = {
          decisionId,
          grantId: body.grantId,
          executionLevel: body.executionLevel,
          requestHash,
          evidenceHash: sha256Canonical({ status: "unavailable" }),
          allowed: false,
          reason: "governance_unavailable",
        };
        await repository.recordPublicationGovernanceDecision(context, unavailable);
        throw new ApiError(
          503,
          "PUBLICATION_GOVERNANCE_UNAVAILABLE",
          "Publication governance is unavailable",
        );
      }
      const governanceAudit: PublicationGovernanceAuditInput = {
        decisionId,
        grantId: body.grantId,
        executionLevel: body.executionLevel,
        requestHash,
        evidenceHash: sha256Canonical(governanceDecision.evidence),
        allowed: governanceDecision.allowed === true,
        reason: governanceDecision.reason.slice(0, 200),
      };
      await repository.recordPublicationGovernanceDecision(context, governanceAudit);
      if (!governanceAudit.allowed) {
        throw new ApiError(
          403,
          "PUBLICATION_GOVERNANCE_DENIED",
          "Publication governance denied this request",
        );
      }
      const result = await repository.consumePublicationGrant(context, {
        grantId: body.grantId,
        tokenHash,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        executionLevel: body.executionLevel,
        scheduledFor: body.scheduledFor ?? null,
      });
      return reply.status(result.wasCreated ? 202 : 200).send(result);
    },
  );

  app.post(
    "/api/publication-replays/resolve",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      const body = publicationReplaySchema.parse(request.body);
      return {
        publication: await repository.resolvePublicationReplay(requestContext(request), body),
      };
    },
  );

  app.post(
    "/api/publication-grants/:grantId/revoke",
    { preHandler: guard("grant:revoke", true) },
    async (request) => {
      const grantId = parseIdParams(request.params, "grantId");
      const body = publicationCommandSchema.parse(request.body);
      return repository.revokePublicationGrant(requestContext(request), {
        grantId,
        reason: body.reason,
        auditHash: sha256Canonical({
          action: "publication_grant.revoke",
          grantId,
          reason: body.reason,
        }),
      });
    },
  );

  app.get("/api/publication-jobs", { preHandler: guard("content:read") }, async (request) => ({
    items: await repository.listPublicationJobs(requestContext(request)),
  }));
  app.get(
    "/api/publication-jobs/:jobId",
    { preHandler: guard("content:read") },
    async (request) => {
      const job = await repository.getPublicationJob(
        requestContext(request),
        parseIdParams(request.params, "jobId"),
      );
      if (job === null) throw new RepositoryNotFoundError("Publication job was not found");
      return job;
    },
  );
  app.post(
    "/api/publication-jobs/:jobId/cancel",
    { preHandler: guard("publish:cancel", true) },
    async (request) => {
      const jobId = parseIdParams(request.params, "jobId");
      const body = publicationCommandSchema.parse(request.body);
      return repository.cancelPublicationJob(requestContext(request), {
        jobId,
        reason: body.reason,
        auditHash: sha256Canonical({
          action: "publication_job.cancel",
          jobId,
          reason: body.reason,
        }),
      });
    },
  );
  app.get(
    "/api/publication-jobs/:jobId/attempts",
    { preHandler: guard("receipt:read") },
    async (request) => ({
      items: await repository.listPublicationAttempts(
        requestContext(request),
        parseIdParams(request.params, "jobId"),
      ),
    }),
  );
  app.get(
    "/api/publication-jobs/:jobId/receipts",
    { preHandler: guard("receipt:read") },
    async (request) => ({
      items: await repository.listPublicationReceipts(
        requestContext(request),
        parseIdParams(request.params, "jobId"),
      ),
    }),
  );
  app.get(
    "/api/publication-jobs/:jobId/readbacks",
    { preHandler: guard("receipt:read") },
    async (request) => ({
      items: await repository.listPublicationReadbacks(
        requestContext(request),
        parseIdParams(request.params, "jobId"),
      ),
    }),
  );
  app.get("/api/receipts", { preHandler: guard("receipt:read") }, async (request) => ({
    items: await repository.listPublicationReceipts(requestContext(request)),
  }));
  app.get("/api/receipts/:receiptId", { preHandler: guard("receipt:read") }, async (request) => {
    const receipt = await repository.getPublicationReceipt(
      requestContext(request),
      parseIdParams(request.params, "receiptId"),
    );
    if (receipt === null) throw new RepositoryNotFoundError("Publication receipt was not found");
    return receipt;
  });
  app.get("/api/readbacks", { preHandler: guard("receipt:read") }, async (request) => ({
    items: await repository.listPublicationReadbacks(requestContext(request)),
  }));
  app.get(
    "/api/publication-assisted-handoffs",
    { preHandler: guard("content:read") },
    async (request) => ({
      items: await repository.listPublicationAssistedHandoffs(requestContext(request)),
    }),
  );
  app.get(
    "/api/publication-assisted-handoffs/:handoffId",
    { preHandler: guard("content:read") },
    async (request) => {
      const handoff = await repository.getPublicationAssistedHandoff(
        requestContext(request),
        parseIdParams(request.params, "handoffId"),
      );
      if (handoff === null) {
        throw new RepositoryNotFoundError("Publication assisted handoff was not found");
      }
      return handoff;
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/claim",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      const body = publicationAssistedHandoffLeaseSchema.parse(request.body);
      return {
        handoff: await repository.claimPublicationAssistedHandoff(requestContext(request), {
          handoffId: parseIdParams(request.params, "handoffId"),
          leaseSeconds: body.leaseSeconds,
        }),
      };
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/heartbeat",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      const body = publicationAssistedHandoffLeaseSchema.parse(request.body);
      return {
        handoff: await repository.heartbeatPublicationAssistedHandoff(requestContext(request), {
          handoffId: parseIdParams(request.params, "handoffId"),
          leaseSeconds: body.leaseSeconds,
        }),
      };
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/prepare",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      publicationAssistedBridgeCommandSchema.parse(request.body ?? {});
      const { context, handoffId, handoff } = await requireAssistedHandoff(
        request,
        ["handoff_pending", "session_required", "challenge_required"],
        true,
      );
      const bridge = await ctripBridgeGateway().execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId: context.tenantId,
        handoffId,
        requestId: context.requestId,
        command: "prepare",
      });
      assertBridgeResultScope(context.tenantId, handoff, bridge);
      const updated = await repository.getPublicationAssistedHandoff(context, handoffId);
      if (updated === null) {
        throw new RepositoryNotFoundError("Publication assisted handoff was not found");
      }
      return { handoff: updated, bridge };
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/submit",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      publicationAssistedBridgeCommandSchema.parse(request.body ?? {});
      const { context, handoffId, handoff } = await requireAssistedHandoff(
        request,
        ["draft_prepared"],
        true,
      );
      const bridgeGateway = ctripBridgeGateway();
      const permit = await repository.issuePublicationAssistedSubmitPermit(context, handoffId);
      try {
        const bridge = await bridgeGateway.execute({
          schemaVersion: "geo.ctrip-bridge.command.v1",
          tenantId: context.tenantId,
          handoffId,
          requestId: context.requestId,
          command: "submit",
          submitPermit: permit.submitPermit,
        });
        assertBridgeResultScope(context.tenantId, handoff, bridge);
        const updated = await repository.getPublicationAssistedHandoff(context, handoffId);
        if (updated === null) {
          throw new RepositoryNotFoundError("Publication assisted handoff was not found");
        }
        return { handoff: updated, bridge };
      } catch (error) {
        const details = { stateMayHaveChanged: true, handoffId } as const;
        if (error instanceof CtripBridgeGatewayError) {
          throw new ApiError(error.statusCode, error.code, error.message, details);
        }
        if (error instanceof ApiError) {
          throw new ApiError(error.statusCode, error.code, error.message, {
            ...error.details,
            ...details,
          });
        }
        throw new ApiError(
          502,
          "CTRIP_SUBMIT_OUTCOME_UNKNOWN",
          "Ctrip submit crossed the permit boundary but could not be confirmed",
          details,
        );
      }
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/readback",
    { preHandler: guard("publish:request", true) },
    async (request) => {
      publicationAssistedBridgeCommandSchema.parse(request.body ?? {});
      const { context, handoffId, handoff } = await requireAssistedHandoff(
        request,
        ["awaiting_operator_submit", "readback_pending"],
        false,
      );
      if (handoff.state === "awaiting_operator_submit" && handoff.submitPermitConsumedAt === null) {
        throw new RepositoryConflictError(
          "Publication assisted readback recovery requires a consumed submit permit",
        );
      }
      const bridge = await ctripBridgeGateway().execute({
        schemaVersion: "geo.ctrip-bridge.command.v1",
        tenantId: context.tenantId,
        handoffId,
        requestId: context.requestId,
        command: "readback",
      });
      assertBridgeResultScope(context.tenantId, handoff, bridge);
      const updated = await repository.getPublicationAssistedHandoff(context, handoffId);
      if (updated === null) {
        throw new RepositoryNotFoundError("Publication assisted handoff was not found");
      }
      return { handoff: updated, bridge };
    },
  );
  app.post(
    "/api/publication-assisted-handoffs/:handoffId/cancel",
    { preHandler: guard("publish:cancel", true) },
    async (request) => {
      const handoffId = parseIdParams(request.params, "handoffId");
      const body = publicationCommandSchema.parse(request.body);
      return repository.cancelPublicationAssistedHandoff(requestContext(request), {
        handoffId,
        reason: body.reason,
      });
    },
  );
  app.post(
    "/api/visibility-runs",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const body = visibilityRunSchema.parse(request.body);
      const context = requestContext(request);
      const requestHash = sha256Canonical(body);
      const existingRunId = await repository.findVisibilityRunByIdempotency(
        context,
        body.idempotencyKey,
        requestHash,
      );
      if (existingRunId !== null) {
        return reply.status(200).send({
          visibilityRunId: existingRunId,
          status: "completed",
          providerMode: "fixture",
          evidenceType: "fixture",
          wasCreated: false,
        });
      }
      const runContext = await repository.loadVisibilityRunContext(context, body.querySetVersionId);
      if (runContext === null) {
        throw new RepositoryNotFoundError("Visibility query-set version was not found");
      }
      const queries = storedVisibilityQueries(runContext.prompts);
      const primaryBrand = runContext.brandNames[0] ?? "当前旅行服务商";
      const contacts = runContext.expectedContacts.join("、");
      const competitorNames = runContext.competitors.map((item) => item.canonicalName).join("、");
      const answers = Object.fromEntries(
        queries.map((query) => {
          const answer =
            query.intent === "blank_control"
              ? "当前没有足够的公开证据核验该服务商或其联系方式；Fixture 不猜测未知事实。"
              : query.intent === "negative_control"
                ? `${primaryBrand}的排名、独家资质或保证必须以公开且仍有效的证据为准；当前 Fixture 不补造未核验结论。`
                : query.intent === "contact"
                  ? `${primaryBrand}当前登记的咨询方式为：${contacts}。实际使用前仍应核对合作方最新确认信息。`
                  : query.intent === "comparison" && competitorNames.length > 0
                    ? `${primaryBrand}可与${competitorNames}比较。应核验带日期的行程、费用边界、退改条件、适配人群和联系方式。`
                    : `${primaryBrand}可作为候选之一。比较时应核验带日期的行程、费用边界、退改条件、适配人群和联系方式，不把单次模型回答当成排名或因果证据。`;
          return [
            query.id,
            {
              answer,
              citedUrls: Array.from(runContext.evidenceUrls),
            },
          ] as const;
        }),
      );
      const runId = uuid();
      const productSurface = `${body.provider}-fixture`;
      const model = `${body.provider}-fixture-v1`;
      let sampleSequence = 0;
      const observedBase = now().getTime();
      const adapter = new FixtureVisibilityAdapter(body.provider, answers, () => {
        sampleSequence += 1;
        return new Date(observedBase + sampleSequence);
      });
      const observations = [];
      for (let sample = 0; sample < body.sampleCount; sample += 1) {
        for (const query of queries) {
          const sampleRequest = {
            runId,
            observationId: uuid(),
            provider: body.provider,
            productSurface,
            model,
            searchMode: "unknown" as const,
            query,
            querySetVersion: runContext.querySetVersion,
            locale: "zh-CN",
            geo: "CN",
            truth: {
              tenantId: context.tenantId,
              brandId: runContext.brandId,
              brandNames: [...runContext.brandNames],
              expectedContacts: [...runContext.expectedContacts],
              competitors: [...runContext.competitors],
            },
          };
          const evidence = await adapter.sample(sampleRequest);
          observations.push(analyzeVisibilityEvidence(sampleRequest, evidence));
        }
      }
      const metrics = calculateVisibilityMetrics(observations);
      const openCircuit = false;
      const completedAt = now().toISOString();
      await repository.persistVisibilityRun(context, {
        runId,
        querySetVersionId: body.querySetVersionId,
        provider: body.provider,
        productSurface,
        model,
        searchMode: "unknown",
        observationMethod: "fixture",
        locale: "zh-CN",
        geo: "CN",
        idempotencyKey: body.idempotencyKey,
        requestHash,
        observations,
        metrics,
        openCircuit,
        completedAt,
      });
      return reply.status(201).send({
        visibilityRunId: runId,
        status: "completed",
        provider: body.provider,
        providerMode: "fixture",
        evidenceType: "fixture",
        observationCount: observations.length,
        metrics,
        circuitOpened: openCircuit,
        wasCreated: true,
      });
    },
  );
  app.post(
    "/api/visibility-runs/import",
    { preHandler: guard("visibility:run", true) },
    async (request, reply) => {
      const body = manualVisibilityRunSchema.parse(request.body);
      const context = requestContext(request);
      const requestHash = sha256Canonical(body);
      const existingRunId = await repository.findVisibilityRunByIdempotency(
        context,
        body.idempotencyKey,
        requestHash,
      );
      if (existingRunId !== null) {
        return reply.status(200).send({
          visibilityRunId: existingRunId,
          status: "completed",
          providerMode: "manual",
          evidenceType: "manual_import",
          wasCreated: false,
        });
      }
      const runContext = await repository.loadVisibilityRunContext(context, body.querySetVersionId);
      if (runContext === null) {
        throw new RepositoryNotFoundError("Visibility query-set version was not found");
      }
      const queryById = new Map(
        storedVisibilityQueries(runContext.prompts).map((query) => [query.id, query]),
      );
      const runId = uuid();
      const observations = [];
      for (const sample of body.samples) {
        const query = queryById.get(sample.queryKey);
        if (query === undefined) {
          throw new ApiError(
            400,
            "VISIBILITY_QUERY_UNKNOWN",
            "Manual observation references an unknown query",
          );
        }
        const sampleRequest = {
          runId,
          observationId: uuid(),
          provider: body.provider,
          productSurface: body.productSurface,
          model: body.model,
          searchMode: body.searchMode,
          query,
          querySetVersion: runContext.querySetVersion,
          locale: body.locale,
          geo: body.geo,
          truth: {
            tenantId: context.tenantId,
            brandId: runContext.brandId,
            brandNames: [...runContext.brandNames],
            expectedContacts: [...runContext.expectedContacts],
            competitors: [...runContext.competitors],
          },
        };
        const adapter = new ManualVisibilityAdapter(body.provider, async () => ({
          rawAnswer: sample.rawAnswer,
          citedUrls: sample.citedUrls,
          requestStartedAt: sample.requestStartedAt ?? sample.observedAt,
          responseReceivedAt: sample.responseReceivedAt ?? sample.observedAt,
          observedAt: sample.observedAt,
          observationMethod: "manual",
          evidenceType: "manual_import",
        }));
        const evidence = await adapter.sample(sampleRequest);
        observations.push(analyzeVisibilityEvidence(sampleRequest, evidence));
      }
      const metrics = calculateVisibilityMetrics(observations);
      const openCircuit = metrics.harmfulErrorRate >= 0.05 || metrics.contactAccuracy < 0.9;
      const completedAt = now().toISOString();
      await repository.persistVisibilityRun(context, {
        runId,
        querySetVersionId: body.querySetVersionId,
        provider: body.provider,
        productSurface: body.productSurface,
        model: body.model,
        searchMode: body.searchMode,
        observationMethod: "manual",
        locale: body.locale,
        geo: body.geo,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        observations,
        metrics,
        openCircuit,
        completedAt,
      });
      return reply.status(201).send({
        visibilityRunId: runId,
        status: "completed",
        provider: body.provider,
        providerMode: "manual",
        evidenceType: "manual_import",
        observationCount: observations.length,
        metrics,
        circuitOpened: openCircuit,
        wasCreated: true,
      });
    },
  );
  app.get("/api/visibility-runs", { preHandler: guard("visibility:read") }, async (request) => {
    const query = visibilityRunListQuerySchema.parse(request.query);
    return {
      items: await repository.listVisibilityRuns(requestContext(request), {
        limit: query.limit,
        ...(query.provider === undefined ? {} : { provider: query.provider }),
        ...(query.observationMethod === undefined
          ? {}
          : { observationMethod: query.observationMethod }),
      }),
    };
  });
  app.get(
    "/api/visibility-runs/:runId",
    { preHandler: guard("visibility:read") },
    async (request) => {
      const run = await repository.getVisibilityRun(
        requestContext(request),
        parseIdParams(request.params, "runId"),
      );
      if (run === null) throw new RepositoryNotFoundError("Visibility run was not found");
      return run;
    },
  );
  app.get("/api/visibility/summary", { preHandler: guard("visibility:read") }, async (request) => {
    const query = visibilitySummaryQuerySchema.parse(request.query);
    return {
      items: await repository.getVisibilitySummary(requestContext(request), query),
      includesFixture: query.includeFixture,
    };
  });
  app.get("/openapi.json", async () => openApiDocument(registeredRoutes));

  return app;
}

export function sessionCookieNames(): { session: string; csrf: string } {
  return { session: SESSION_COOKIE, csrf: CSRF_COOKIE };
}
