import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { PlasticPromiseGovernanceClient, type McpToolCaller } from "./governance.js";

function validatedEndpoint(endpoint: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(endpoint);
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Plastic Promise MCP URL cannot contain credentials or a fragment");
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Plastic Promise MCP requires HTTPS except on loopback");
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error("Plastic Promise MCP origin is not allowlisted");
  }
  return url;
}

export async function connectPlasticPromiseStreamableHttp(options: {
  endpoint: string;
  allowedOrigins: readonly string[];
  authorizationHeader?: string;
}): Promise<PlasticPromiseGovernanceClient> {
  const endpoint = validatedEndpoint(options.endpoint, options.allowedOrigins);
  const client = new Client({ name: "geo-pi-agent", version: "0.1.0" }, { capabilities: {} });
  const headers = new Headers();
  if (options.authorizationHeader !== undefined) {
    headers.set("authorization", options.authorizationHeader);
  }
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
  });
  // SDK 1.29.0 declares the class getter as `string | undefined` while its
  // Transport interface uses an exact-optional property. Runtime APIs are identical.
  await client.connect(transport as Transport);
  const caller: McpToolCaller = {
    callTool: async (input) => {
      const result = await client.callTool(input);
      const raw = result as Record<string, unknown>;
      if (!Array.isArray(raw.content)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Unexpected task-based MCP result" }],
        };
      }
      const content = raw.content.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const block = entry as Record<string, unknown>;
        if (typeof block.type !== "string") return [];
        return [
          {
            type: block.type,
            ...(typeof block.text === "string" ? { text: block.text } : {}),
          },
        ];
      });
      return {
        content,
        structuredContent: raw.structuredContent,
        isError: typeof raw.isError === "boolean" ? raw.isError : undefined,
      };
    },
    close: async () => client.close(),
  };
  return new PlasticPromiseGovernanceClient(caller);
}
