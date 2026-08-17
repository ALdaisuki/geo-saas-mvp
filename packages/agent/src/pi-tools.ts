import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { AGENT_TOOL_POLICIES, type AgentToolName } from "./policy.js";
import { publicErrorMessage, redactSensitiveDetails } from "./redaction.js";
import type { GovernedAgentRuntime } from "./runtime.js";

const tenantId = Type.String({ format: "uuid", description: "Authenticated tenant ID" });
const resourceId = Type.String({ format: "uuid" });
const idempotencyKey = Type.String({ minLength: 1, maxLength: 200 });
const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/u;
const SAFE_PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u;

const CORRECTABLE_TOOL_INPUT_MESSAGES = {
  CTRIP_BRAND_CONTEXT_UNAVAILABLE:
    "Correctable draft error: CTRIP_BRAND_CONTEXT_UNAVAILABLE. Reload geo_tenant_context and retry geo_draft_proposal with the exact selected brand displayName.",
  CTRIP_BRAND_PLACEMENT_TOO_LATE:
    "Correctable draft error: CTRIP_BRAND_PLACEMENT_TOO_LATE. Move the exact selected brand displayName into the first half of authoredDraft.body and before the second ## heading, then retry geo_draft_proposal.",
  CTRIP_LOCATION_REQUIRED:
    "Correctable draft error: CTRIP_LOCATION_REQUIRED. Add a non-empty authoredDraft.locationQuery containing the real destination or city described by the article, then retry geo_draft_proposal.",
} as const;

const AUTHORED_DRAFT_ARGUMENTS_INVALID_MESSAGE =
  "Correctable draft error: AUTHORED_DRAFT_ARGUMENTS_INVALID. Rebuild the complete authoredDraft object and retry geo_draft_proposal once. Use only title, titleClaimIds, summary, summaryClaimIds, optional locationQuery, body sections with text and claimIds, and for browser platforms exactly four mediaSearchPlan entries with one cover, three inline intents, query, role, rationale, and claimIds. Remove every other property and keep all IDs and enum values valid.";

const CORRECTABLE_UPSTREAM_MESSAGES = {
  AUTOMATION_DRAFT_VERIFIED_CLAIM_REQUIRED:
    "Correctable draft error: AUTOMATION_DRAFT_VERIFIED_CLAIM_REQUIRED. geo_fact_lookup returned facts relevant to the bound brief. In the latest lookup result, choose one relevant fact, copy its complete claim sentence character-for-character into one body section, attach that same fact ID only to that body section, leave titleClaimIds, summaryClaimIds, and mediaSearchPlan claimIds empty unless their text is also copied exactly, then retry geo_draft_proposal.",
  AUTOMATION_RELEVANT_FACT_REQUIRED:
    "Automation boundary: AUTOMATION_RELEVANT_FACT_REQUIRED. No verified tenant fact matches the bound brief, so do not invent a claim or submit a draft. Stop this draft and use an evidence-compatible campaign or add a verified fact before retrying.",
  AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED:
    "Correctable draft error: AUTHORED_DRAFT_MEDIA_SEARCH_PLAN_REQUIRED. Add authoredDraft.mediaSearchPlan with exactly four distinct intents: one cover and three inline images. Every intent must include a distinct query, sectionRef, fallbackQueries (up to three alternatives), retryBudget (1-3), role, rationale, and claimIds. Keep media claimIds empty unless the exact verified claim text appears in the referenced article section. Reuse only claim IDs already present in authoredDraft, then retry geo_draft_proposal with the complete authoredDraft object.",
  AUTHORED_DRAFT_FACT_TEXT_REQUIRED:
    "Correctable draft error: AUTHORED_DRAFT_FACT_TEXT_REQUIRED. Reopen the latest geo_fact_lookup result and compare every referenced ID. Remove every claim ID whose complete claim sentence is not present character-for-character in title, summary, or body; mediaSearchPlan claimIds should normally be empty. Keep at most one relevant fact ID on the body section that contains its exact claim sentence, then retry geo_draft_proposal with the complete authoredDraft object.",
} as const;

export class CorrectableToolInputError extends Error {
  readonly code: keyof typeof CORRECTABLE_TOOL_INPUT_MESSAGES;

  constructor(code: keyof typeof CORRECTABLE_TOOL_INPUT_MESSAGES) {
    super(CORRECTABLE_TOOL_INPUT_MESSAGES[code]);
    this.name = "CorrectableToolInputError";
    this.code = code;
  }
}

function propertyPath(parent: string, property: string): string {
  const segment = SAFE_PROPERTY_NAME.test(property) ? property : "[unknown-property]";
  return parent.length === 0 ? segment : `${parent}.${segment}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKnownToolArguments(name: AgentToolName, args: unknown): unknown {
  if (name !== "geo_draft_proposal" || !isRecord(args) || !Object.hasOwn(args, "locationQuery")) {
    return args;
  }
  const authoredDraftValue = args.authoredDraft;
  if (!isRecord(authoredDraftValue)) return args;

  const rootLocationQuery = args.locationQuery;
  const nestedLocationQuery = authoredDraftValue.locationQuery;
  if (nestedLocationQuery !== undefined && nestedLocationQuery !== rootLocationQuery) {
    throw new Error(
      "Conflicting tool argument properties: locationQuery, authoredDraft.locationQuery",
    );
  }

  const remainingArgs = { ...args };
  delete remainingArgs.locationQuery;
  return {
    ...remainingArgs,
    authoredDraft: {
      ...authoredDraftValue,
      locationQuery: nestedLocationQuery ?? rootLocationQuery,
    },
  };
}

function instancePath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (path, segment) =>
        /^\d+$/u.test(segment) ? `${path}[${segment}]` : propertyPath(path, segment),
      "",
    );
}

function prepareStrictArguments<T extends TSchema>(schema: T, args: unknown): Static<T> {
  const unknownPaths = Value.Errors(schema, args).flatMap((error) =>
    error.keyword === "additionalProperties"
      ? error.params.additionalProperties.map((property) =>
          propertyPath(instancePath(error.instancePath), property),
        )
      : [],
  );
  if (unknownPaths.length > 0) {
    throw new Error(`Unknown tool argument properties: ${unknownPaths.join(", ")}`);
  }
  return args as Static<T>;
}

function safeDiagnosticMetadata(error: unknown): {
  readonly errorType: string;
  readonly errorCode?: string;
  readonly statusCode?: number;
} {
  if (error === null || typeof error !== "object") {
    return { errorType: "UnknownError" };
  }
  try {
    const record = error as Readonly<Record<string, unknown>>;
    const errorType =
      error instanceof Error && SAFE_DIAGNOSTIC_TOKEN.test(error.name)
        ? error.name
        : "UnknownError";
    const errorCode =
      typeof record.code === "string" && SAFE_DIAGNOSTIC_TOKEN.test(record.code)
        ? record.code
        : undefined;
    const statusCode =
      typeof record.status === "number" &&
      Number.isInteger(record.status) &&
      record.status >= 100 &&
      record.status <= 599
        ? record.status
        : undefined;
    return {
      errorType,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  } catch {
    return { errorType: "UnknownError" };
  }
}

function upstreamErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as Readonly<Record<string, unknown>>).code;
    if (code === "AUTHORED_DRAFT_ARGUMENTS_INVALID") {
      return AUTHORED_DRAFT_ARGUMENTS_INVALID_MESSAGE;
    }
    if (typeof code === "string" && Object.hasOwn(CORRECTABLE_UPSTREAM_MESSAGES, code)) {
      return CORRECTABLE_UPSTREAM_MESSAGES[code as keyof typeof CORRECTABLE_UPSTREAM_MESSAGES];
    }
  }
  return publicErrorMessage(error);
}
const articleTemplateId = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[a-z0-9][a-z0-9-]*$",
  description: "ID returned by geo_template_catalog",
});
const authoredClaimIds = Type.Array(resourceId, {
  maxItems: 20,
  uniqueItems: true,
  description: "Optional verified fact IDs that support this authored segment",
});
const authoredSection = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 8_000 }),
    claimIds: authoredClaimIds,
  },
  { additionalProperties: false },
);
const mediaSearchIntent = Type.Object(
  {
    query: Type.String({
      minLength: 2,
      maxLength: 160,
      description: "Specific visual search query, preferably Chinese plus English proper nouns",
    }),
    role: Type.Union([Type.Literal("cover"), Type.Literal("inline")]),
    rationale: Type.String({
      minLength: 2,
      maxLength: 500,
      description: "Visible article section and visual subject this image must support",
    }),
    sectionRef: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 200,
        description: "Exact article section heading this image intent illustrates",
      }),
    ),
    fallbackQueries: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 2,
          maxLength: 160,
          description: "Alternative search phrase the licensed provider can resolve",
        }),
        { maxItems: 3 },
      ),
    ),
    retryBudget: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3,
        description: "Provider retry attempts before unfilled",
      }),
    ),
    claimIds: Type.Array(resourceId, { maxItems: 3, uniqueItems: true }),
  },
  { additionalProperties: false },
);
const authoredDraft = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 2_000 }),
    titleClaimIds: authoredClaimIds,
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    summaryClaimIds: authoredClaimIds,
    locationQuery: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100, description: "Ctrip POI search query" }),
    ),
    body: Type.Array(authoredSection, { minItems: 1, maxItems: 50 }),
    mediaSearchPlan: Type.Optional(
      Type.Array(mediaSearchIntent, {
        minItems: 4,
        maxItems: 5,
        description: "Distinct licensed-image searches with exactly one cover intent",
      }),
    ),
  },
  { additionalProperties: false },
);

const schemas = {
  geo_tenant_context: Type.Object({ tenantId }, { additionalProperties: false }),
  geo_template_catalog: Type.Object({ tenantId }, { additionalProperties: false }),
  geo_brand_profile: Type.Object(
    { tenantId, brandId: resourceId },
    { additionalProperties: false },
  ),
  geo_fact_lookup: Type.Object(
    {
      tenantId,
      brandId: resourceId,
      query: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    { additionalProperties: false },
  ),
  geo_draft_proposal: Type.Object(
    {
      tenantId,
      brandId: resourceId,
      campaignId: resourceId,
      brief: Type.String({ minLength: 1, maxLength: 10_000 }),
      targetPlatform: Type.Optional(
        Type.Union([
          Type.Literal("toutiao"),
          Type.Literal("sohu"),
          Type.Literal("baijiahao"),
          Type.Literal("netease"),
          Type.Literal("ctrip_community"),
          Type.Literal("zhihu"),
        ]),
      ),
      articleTemplateId: Type.Optional(articleTemplateId),
      idempotencyKey,
      authoredDraft,
    },
    { additionalProperties: false },
  ),
  geo_variant_preview: Type.Object(
    {
      tenantId,
      contentVersionId: resourceId,
      channelAccountId: resourceId,
      platform: Type.Union([
        Type.Literal("toutiao"),
        Type.Literal("sohu"),
        Type.Literal("baijiahao"),
        Type.Literal("netease"),
        Type.Literal("ctrip_community"),
      ]),
    },
    { additionalProperties: false },
  ),
  geo_audit_request: Type.Object(
    { tenantId, variantId: resourceId, idempotencyKey },
    { additionalProperties: false },
  ),
  geo_publication_request: Type.Object(
    {
      tenantId,
      variantId: resourceId,
      channelAccountId: resourceId,
      platform: Type.Optional(
        Type.Union([
          Type.Literal("toutiao"),
          Type.Literal("sohu"),
          Type.Literal("baijiahao"),
          Type.Literal("netease"),
          Type.Literal("ctrip_community"),
          Type.Literal("zhihu"),
        ]),
      ),
      executionLevel: Type.Union([
        Type.Literal("dry_run"),
        Type.Literal("assisted"),
        Type.Literal("unattended"),
      ]),
      idempotencyKey,
    },
    { additionalProperties: false },
  ),
  geo_visibility_request: Type.Object(
    {
      tenantId,
      querySetVersionId: resourceId,
      provider: Type.Union([Type.Literal("doubao"), Type.Literal("qwen")]),
      sampleCount: Type.Integer({ minimum: 1, maximum: 20 }),
      idempotencyKey,
    },
    { additionalProperties: false },
  ),
  geo_media_production_request: Type.Object(
    {
      tenantId,
      contentVersionId: resourceId,
      platform: Type.Union([
        Type.Literal("toutiao"),
        Type.Literal("sohu"),
        Type.Literal("baijiahao"),
        Type.Literal("netease"),
        Type.Literal("ctrip_community"),
        Type.Literal("zhihu"),
      ]),
      role: Type.Union([Type.Literal("cover"), Type.Literal("inline")]),
      claimIds: Type.Array(resourceId, { maxItems: 3, uniqueItems: true }),
      idempotencyKey,
    },
    { additionalProperties: false },
  ),
  geo_media_job_status: Type.Object(
    { tenantId, mediaJobId: resourceId },
    { additionalProperties: false },
  ),
  geo_media_search_import: Type.Object(
    {
      tenantId,
      contentVersionId: resourceId,
      platform: Type.Union([
        Type.Literal("toutiao"),
        Type.Literal("sohu"),
        Type.Literal("baijiahao"),
        Type.Literal("netease"),
        Type.Literal("ctrip_community"),
        Type.Literal("zhihu"),
      ]),
      idempotencyKey,
      maxImports: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    },
    { additionalProperties: false },
  ),
  plastic_context_supply: Type.Object(
    {
      tenantId,
      taskDescription: Type.String({ minLength: 1, maxLength: 10_000 }),
      taskType: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
  plastic_audit_pre_check: Type.Object(
    {
      tenantId,
      action: Type.String({ minLength: 1, maxLength: 200 }),
      context: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  plastic_defense: Type.Object(
    {
      tenantId,
      targetToolName: Type.String({ minLength: 1, maxLength: 200 }),
      targetToolArgs: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
} as const satisfies Readonly<Record<AgentToolName, TSchema>>;

const descriptions: Readonly<Record<AgentToolName, { label: string; description: string }>> = {
  geo_tenant_context: {
    label: "Tenant context",
    description: "Read the authenticated tenant's non-secret operating context.",
  },
  geo_template_catalog: {
    label: "Article template catalog",
    description: "Read the governed article strategies and their evidence boundaries.",
  },
  geo_brand_profile: {
    label: "Brand Agent Profile",
    description: "Read active tenant-owned brand voice, audience, and Agent instructions.",
  },
  geo_fact_lookup: {
    label: "Fact lookup",
    description: "Look up tenant-scoped facts and evidence for drafting.",
  },
  geo_draft_proposal: {
    label: "Draft proposal",
    description: "Submit a content draft proposal to the authenticated application API.",
  },
  geo_variant_preview: {
    label: "Variant preview",
    description: "Create an immutable platform variant preview without publishing it.",
  },
  geo_audit_request: {
    label: "Audit request",
    description: "Request deterministic audit of an exact platform variant.",
  },
  geo_publication_request: {
    label: "Publication request",
    description: "Request publication authorization and queueing; this never issues a grant.",
  },
  geo_visibility_request: {
    label: "Visibility request",
    description: "Request a tenant-scoped Doubao or Qwen visibility run.",
  },
  geo_media_production_request: {
    label: "Media production request",
    description: "Request governed fixture media production using scoped content and claim IDs.",
  },
  geo_media_job_status: {
    label: "Media job status",
    description: "Read tenant-scoped media production status and immutable asset metadata.",
  },
  geo_media_search_import: {
    label: "Licensed image search",
    description:
      "Run the article's immutable keyword plan and attach only licensed, inspected, relevant images.",
  },
  plastic_context_supply: {
    label: "Governance context",
    description: "Request task context from the Plastic Promise governance service.",
  },
  plastic_audit_pre_check: {
    label: "Governance pre-check",
    description: "Request a Plastic Promise pre-action policy check.",
  },
  plastic_defense: {
    label: "Governance defense",
    description: "Evaluate a proposed allowlisted tool through Plastic Promise defense.",
  },
};

export function createPiAgentTools(
  runtime: GovernedAgentRuntime,
  options: {
    readonly argumentBindings?: Partial<
      Readonly<Record<AgentToolName, Readonly<Record<string, unknown>>>>
    >;
    readonly projectResult?: (toolName: AgentToolName, result: unknown) => unknown;
    readonly contextualErrorMessage?: (
      toolName: AgentToolName,
      error: unknown,
    ) => string | undefined;
    readonly workflowGuard?: PiToolWorkflowGuard;
  } = {},
): AgentTool[] {
  return (Object.keys(schemas) as AgentToolName[]).map((name) => {
    const metadata = descriptions[name];
    const binding = options.argumentBindings?.[name];
    return {
      name,
      label: metadata.label,
      description: metadata.description,
      parameters: schemas[name],
      prepareArguments: (args) =>
        prepareStrictArguments(
          schemas[name],
          normalizeKnownToolArguments(
            name,
            binding === undefined || !isRecord(args) ? args : { ...args, ...binding },
          ),
        ),
      executionMode: AGENT_TOOL_POLICIES[name].sequential ? "sequential" : "parallel",
      execute: async (_toolCallId, params, signal) => {
        if (signal?.aborted) {
          throw new Error("Tool call cancelled");
        }
        try {
          await options.workflowGuard?.beforeToolCall(name, _toolCallId);
          const details = await runtime.invoke(name, params);
          const projected = options.projectResult?.(name, details) ?? details;
          await options.workflowGuard?.afterToolCall(name, _toolCallId, true);
          const nextToolName = options.workflowGuard?.nextToolName() ?? null;
          return {
            content: [
              { type: "text", text: JSON.stringify(projected) },
              ...(nextToolName === null
                ? []
                : [
                    {
                      type: "text" as const,
                      text: `WORKFLOW_NEXT_STEP task=${options.workflowGuard?.taskId ?? "unknown"} tool=${nextToolName}`,
                    },
                  ]),
            ],
            details,
          };
        } catch (error) {
          await options.workflowGuard?.afterToolCall(name, _toolCallId, false);
          const diagnostic = safeDiagnosticMetadata(error);
          console.error(
            JSON.stringify({
              level: "error",
              event: "pi_agent.tool_failed",
              toolName: name,
              ...diagnostic,
            }),
          );
          throw new Error(
            error instanceof CorrectableToolInputError
              ? error.message
              : (options.contextualErrorMessage?.(name, error) ?? upstreamErrorMessage(error)),
            {
              // The original error may contain credentials, so it must not survive in agent history.
              // eslint-disable-next-line preserve-caught-error
              cause: redactSensitiveDetails(error),
            },
          );
        }
      },
    } satisfies AgentTool;
  });
}

/**
 * A run-scoped gate for providers that ignore tool_choice or emit multiple
 * calls in one turn. The guard never changes MCP arguments; it only verifies
 * the task/step contract immediately before and after the call.
 */
export interface PiToolWorkflowGuard {
  readonly taskId: string;
  beforeToolCall(toolName: AgentToolName, toolCallId: string): void | Promise<void>;
  afterToolCall(
    toolName: AgentToolName,
    toolCallId: string,
    succeeded: boolean,
  ): void | Promise<void>;
  nextToolName(): AgentToolName | null;
}

export const PI_TOOL_SCHEMAS: Readonly<Record<AgentToolName, TSchema>> = schemas;
