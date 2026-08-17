import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectPlasticPromiseStreamableHttp,
  validatePlasticPromiseEndpoint,
} from "./plastic-promise-transport.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    readonly id?: string | number;
    readonly method?: string;
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

describe("Plastic Promise transport endpoint policy", () => {
  it("allows the fixed production Docker bridge proxy only when explicitly enabled", () => {
    const endpoint = "http://172.30.11.2:10002/mcp";
    expect(
      validatePlasticPromiseEndpoint(endpoint, ["http://172.30.11.2:10002"], false, true),
    ).toMatchObject({ href: endpoint });
    expect(() =>
      validatePlasticPromiseEndpoint(endpoint, ["http://172.30.11.2:10002"], false, false),
    ).toThrow(/HTTPS/iu);
  });

  it("does not widen the production exception to other private HTTP endpoints", () => {
    for (const endpoint of [
      "http://172.30.11.1:10002/mcp",
      "http://172.30.11.2:10003/mcp",
      "http://172.30.11.2:10002/",
      "http://10.0.0.1:10002/mcp",
    ]) {
      expect(() =>
        validatePlasticPromiseEndpoint(endpoint, [new URL(endpoint).origin], false, true),
      ).toThrow(/HTTPS/iu);
    }
  });

  it("rejects endpoint credentials, query strings, fragments, and non-allowlisted origins", () => {
    for (const endpoint of [
      "http://user:secret@127.0.0.1:9020/mcp",
      "http://127.0.0.1:9020/mcp?token=value",
      "http://127.0.0.1:9020/mcp#fragment",
    ]) {
      expect(() =>
        validatePlasticPromiseEndpoint(endpoint, ["http://127.0.0.1:9020"], false, false),
      ).toThrow(/credentials|query|fragment/iu);
    }
    expect(() =>
      validatePlasticPromiseEndpoint(
        "https://governance.example.test/mcp",
        ["https://other.example.test"],
        false,
        false,
      ),
    ).toThrow(/allowlisted/iu);
  });
});

describe("Plastic Promise transport lifecycle", () => {
  it("reconnects once when maintenance invalidates the MCP session", async () => {
    let activeSession: string | undefined;
    let sessionSequence = 0;
    let initializationCount = 0;
    let toolAttemptCount = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      const message = await readJson(request);
      if (message.method === "initialize") {
        activeSession = `session-${++sessionSequence}`;
        initializationCount += 1;
        writeJson(
          response,
          200,
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "plastic-promise-test", version: "1.0.0" },
            },
          },
          { "mcp-session-id": activeSession },
        );
        return;
      }

      const requestSession = request.headers["mcp-session-id"];
      if (requestSession !== activeSession) {
        writeJson(response, 404, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32_001, message: "Session not found" },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/call") {
        toolAttemptCount += 1;
        writeJson(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ passed: true }) }],
          },
        });
        return;
      }
      writeJson(response, 404, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_601, message: "Method not found" },
      });
    });
    const endpoint = await listen(server);
    const governance = await connectPlasticPromiseStreamableHttp({
      endpoint,
      allowedOrigins: [new URL(endpoint).origin],
    });

    try {
      await expect(governance.auditPreCheck({ action_type: "read" })).resolves.toBeDefined();
      activeSession = undefined;
      await expect(
        Promise.all([
          governance.auditPreCheck({ action_type: "read" }),
          governance.defense({ action: "evaluate_tool", tool_name: "geo_publication_request" }),
        ]),
      ).resolves.toHaveLength(2);

      expect(initializationCount).toBe(2);
      expect(toolAttemptCount).toBe(3);
    } finally {
      await governance.close();
    }
  });
});
