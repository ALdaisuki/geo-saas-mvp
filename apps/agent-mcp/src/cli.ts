import {
  HttpInternalGeoApiClient,
  GeoApiSessionRegistry,
  parseMcpPrincipalCredentials,
} from "./http-api-client.js";
import { createGeoMcpHttpServer, listenGeoMcpHttpServer } from "./http-server.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function commaSeparated(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  const values = (raw === undefined ? fallback : raw.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = integerEnvironment("MCP_PORT", 9021);
const sessions = new GeoApiSessionRegistry({
  baseUrl: requiredEnvironment("GEO_API_BASE_URL"),
  credentials: parseMcpPrincipalCredentials(requiredEnvironment("MCP_PRINCIPALS_JSON")),
});
const api = new HttpInternalGeoApiClient({ sessions });
const server = createGeoMcpHttpServer({
  api,
  authenticator: sessions,
  allowedHosts: commaSeparated("MCP_ALLOWED_HOSTS", [`127.0.0.1:${port}`, `localhost:${port}`]),
  allowedOrigins: commaSeparated("MCP_ALLOWED_ORIGINS", ["http://127.0.0.1", "http://localhost"]),
});

await listenGeoMcpHttpServer(server, { host, port });
console.info(JSON.stringify({ level: "info", event: "agent_mcp.started", host, port }));

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error !== undefined) {
        console.error(JSON.stringify({ level: "error", event: "agent_mcp.stop_failed" }));
        process.exitCode = 1;
      }
    });
  });
}
