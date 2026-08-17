import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { PlasticPromiseGovernanceClient, type McpToolCaller } from "./governance.js";

export function validatePlasticPromiseEndpoint(
  endpoint: string,
  allowedOrigins: readonly string[],
  allowDockerHost: boolean,
  allowServerDockerGateway: boolean,
): URL {
  const url = new URL(endpoint);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(
      "Plastic Promise MCP URL cannot contain credentials, a query string, or a fragment",
    );
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const isCustomerDemoDockerHost = allowDockerHost && url.hostname === "host.docker.internal";
  const isServerDockerGateway =
    allowServerDockerGateway &&
    url.hostname === "172.30.11.2" &&
    url.port === "10002" &&
    url.pathname === "/mcp";
  if (
    url.protocol !== "https:" &&
    !isLoopback &&
    !isCustomerDemoDockerHost &&
    !isServerDockerGateway
  ) {
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
  allowDockerHost?: boolean;
  allowServerDockerGateway?: boolean;
  contextSupplyEnabled?: boolean;
}): Promise<PlasticPromiseGovernanceClient> {
  const endpoint = validatePlasticPromiseEndpoint(
    options.endpoint,
    options.allowedOrigins,
    options.allowDockerHost === true,
    options.allowServerDockerGateway === true,
  );
  type Connection = {
    readonly client: Client;
  };

  async function createConnection(): Promise<Connection> {
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
    return { client };
  }

  let connection = await createConnection();
  let reconnecting: Promise<Connection> | undefined;

  async function reconnect(failedConnection: Connection): Promise<Connection> {
    if (connection !== failedConnection) return connection;
    reconnecting ??= (async () => {
      const replacement = await createConnection();
      if (connection === failedConnection) {
        connection = replacement;
        await failedConnection.client.close().catch(() => undefined);
        return replacement;
      }
      await replacement.client.close().catch(() => undefined);
      return connection;
    })().finally(() => {
      reconnecting = undefined;
    });
    return reconnecting;
  }

  const caller: McpToolCaller = {
    callTool: async (input) => {
      const currentConnection = connection;
      let result;
      try {
        result = await currentConnection.client.callTool(input);
      } catch (error) {
        if (!isReconnectableTransportError(error)) throw error;
        const replacement = await reconnect(currentConnection);
        result = await replacement.client.callTool(input);
      }
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
    close: async () => {
      const pending = reconnecting;
      if (pending !== undefined) await pending.catch(() => undefined);
      await connection.client.close();
    },
  };
  return new PlasticPromiseGovernanceClient(caller, {
    ...(options.contextSupplyEnabled === undefined
      ? {}
      : { contextSupplyEnabled: options.contextSupplyEnabled }),
  });
}

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isReconnectableTransportError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return (
      error.code === 404 || error.code === 408 || (error.code !== undefined && error.code >= 500)
    );
  }
  if (error instanceof McpError) {
    return error.code === ErrorCode.ConnectionClosed && error.message.includes("Connection closed");
  }
  if (error instanceof Error && error.message === "Not connected") return true;
  if (!(error instanceof TypeError)) return false;
  const cause = (error as Error & { readonly cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_NETWORK_ERROR_CODES.has(code);
}
