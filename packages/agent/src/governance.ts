import { redactSensitiveDetails } from "./redaction.js";

export const PLASTIC_PROMISE_MCP_ALLOWLIST = [
  "context_supply",
  "audit_pre_check",
  "defense",
] as const;

export type PlasticPromiseMcpToolName = (typeof PLASTIC_PROMISE_MCP_ALLOWLIST)[number];

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string | undefined;
}

export interface McpCallToolResult {
  readonly content?: readonly McpContentBlock[] | undefined;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

export interface McpToolCaller {
  callTool(input: {
    name: string;
    arguments?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<McpCallToolResult>;
  close?(): Promise<void>;
}

export class GovernanceToolError extends Error {
  readonly code = "GOVERNANCE_TOOL_FAILED";
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    toolName: PlasticPromiseMcpToolName,
    details: unknown,
    options: { readonly retryable?: boolean } = {},
  ) {
    super(`Plastic Promise ${toolName} failed`);
    this.name = "GovernanceToolError";
    this.details = redactSensitiveDetails(details);
    this.retryable = options.retryable ?? false;
  }
}

function isMcpToolName(value: string): value is PlasticPromiseMcpToolName {
  return (PLASTIC_PROMISE_MCP_ALLOWLIST as readonly string[]).includes(value);
}

function resultForAgent(result: McpCallToolResult): unknown {
  return redactSensitiveDetails({
    structuredContent: result.structuredContent,
    content: result.content
      ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text),
  });
}

export class PlasticPromiseGovernanceClient {
  readonly #client: McpToolCaller;
  readonly #contextSupplyEnabled: boolean;

  constructor(client: McpToolCaller, options: { readonly contextSupplyEnabled?: boolean } = {}) {
    this.#client = client;
    this.#contextSupplyEnabled = options.contextSupplyEnabled ?? true;
  }

  get contextSupplyEnabled(): boolean {
    return this.#contextSupplyEnabled;
  }

  async call(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!isMcpToolName(toolName)) {
      throw new GovernanceToolError("defense", {
        reason: "MCP tool is outside the static allowlist",
      });
    }
    if (toolName === "context_supply" && !this.#contextSupplyEnabled) {
      throw new GovernanceToolError("context_supply", {
        reason: "context_retrieval_disabled",
      });
    }
    let result: McpCallToolResult;
    try {
      result = await this.#client.callTool({ name: toolName, arguments: args });
    } catch (error) {
      throw new GovernanceToolError(toolName, error, { retryable: true });
    }
    if (result.isError === true) {
      throw new GovernanceToolError(toolName, result, { retryable: true });
    }
    return resultForAgent(result);
  }

  contextSupply(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.call("context_supply", args);
  }

  auditPreCheck(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.call("audit_pre_check", args);
  }

  defense(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.call("defense", args);
  }

  async close(): Promise<void> {
    await this.#client.close?.();
  }
}
