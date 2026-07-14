import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ActorContext } from "@geo/contracts";

import type { InternalGeoApiClient } from "./api-client.js";
import { invokeGeoMcpTool, publicMcpError, type InternalScopeAuthorizer } from "./handlers.js";
import { GEO_MCP_TOOL_NAMES, geoMcpToolMetadata, geoMcpToolSchemas } from "./tool-specs.js";

export type PrincipalResolver = (
  authInfo: Readonly<AuthInfo>,
  requestId: string,
) => Promise<Readonly<ActorContext>>;

type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function createGeoAgentMcpServer(options: {
  api: InternalGeoApiClient;
  resolvePrincipal: PrincipalResolver;
  authorizeScope: InternalScopeAuthorizer;
}): McpServer {
  const server = new McpServer({ name: "geo-agent-mcp", version: "0.1.0" });

  for (const name of GEO_MCP_TOOL_NAMES) {
    const metadata = geoMcpToolMetadata[name];
    server.registerTool(
      name,
      {
        title: metadata.title,
        description: metadata.description,
        inputSchema: geoMcpToolSchemas[name],
        annotations: {
          readOnlyHint: metadata.readOnly,
          destructiveHint: false,
          idempotentHint: metadata.readOnly,
          openWorldHint: false,
        },
      },
      async (args: unknown, extra: McpRequestExtra) => {
        try {
          if (extra.authInfo === undefined) {
            throw new Error("Authenticated MCP session required");
          }
          const principal = await options.resolvePrincipal(extra.authInfo, String(extra.requestId));
          const result = await invokeGeoMcpTool({
            toolName: name,
            args,
            principal,
            api: options.api,
            authorizeScope: options.authorizeScope,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: publicMcpError(error) }],
          };
        }
      },
    );
  }

  return server;
}
