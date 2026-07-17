import { PlasticPromiseGovernanceClient, type McpCallToolResult } from "./governance.js";

const PUBLICATION_TOOL_NAME = "geo_publication_request";

function result(value: Readonly<Record<string, unknown>>): McpCallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function simulatedPublication(actionDescription: unknown): boolean {
  if (typeof actionDescription !== "string") return false;
  try {
    const value = JSON.parse(actionDescription) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).action === PUBLICATION_TOOL_NAME &&
      ["dry_run", "assisted"].includes(String((value as Record<string, unknown>).executionLevel))
    );
  } catch {
    return false;
  }
}

export function createCustomerDemoGovernanceClient(): PlasticPromiseGovernanceClient {
  return new PlasticPromiseGovernanceClient({
    callTool: async (input) => {
      if (input.name === "context_supply") {
        return result({
          mode: "customer_demo",
          project_policy: "tenant_only",
          core_context: [
            "Local customer demonstration: generate only from tenant facts and keep delivery in dry-run or the local Ctrip simulator.",
          ],
          restrictions: ["no_external_publish", "no_live_provider_evidence"],
        });
      }
      if (input.name === "audit_pre_check") {
        const passed = simulatedPublication(input.arguments?.action_description);
        return result({
          passed,
          mode: "customer_demo",
          reason: passed ? "non_external_demo_allowed" : "demo_fixture_denies_unattended",
        });
      }
      if (input.name === "defense") {
        const toolName = input.arguments?.tool_name;
        const allowed = toolName === PUBLICATION_TOOL_NAME;
        return result({
          decision: allowed ? "allow" : "deny",
          tool_name: toolName,
          risk_level: "high",
          required_trust: 0.6,
          manifest: {
            name: toolName,
            side_effects: allowed ? ["external_publish"] : [],
          },
          mode: "customer_demo",
        });
      }
      return { isError: true, content: [{ type: "text", text: "Tool is not available" }] };
    },
  });
}
