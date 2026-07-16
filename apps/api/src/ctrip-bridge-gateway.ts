import { createHash } from "node:crypto";

import {
  ctripBridgeCommandSchema,
  ctripBridgeHealthSchema,
  ctripBridgeResultSchema,
  type CtripBridgeCommand,
  type CtripBridgeResult,
} from "@geo/contracts";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

const credentialListSchema = z
  .array(
    z.strictObject({
      tenantId: z.string().uuid(),
      accessToken: z.string().min(32).max(4_096),
    }),
  )
  .max(1_000);

export interface CtripBridgeCredential {
  readonly tenantId: string;
  readonly accessToken: string;
}

export interface CtripBridgeGateway {
  execute(command: CtripBridgeCommand): Promise<CtripBridgeResult>;
}

export class CtripBridgeGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CtripBridgeGatewayError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseCtripBridgeCredentials(value: string): readonly CtripBridgeCredential[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON must be valid JSON");
  }
  const credentials = credentialListSchema.parse(parsed);
  const tenantIds = new Set<string>();
  const tokenHashes = new Set<string>();
  for (const credential of credentials) {
    const tokenHash = createHash("sha256").update(credential.accessToken).digest("hex");
    if (tenantIds.has(credential.tenantId) || tokenHashes.has(tokenHash)) {
      throw new TypeError("Ctrip bridge tenant IDs and access tokens must be unique");
    }
    tenantIds.add(credential.tenantId);
    tokenHashes.add(tokenHash);
  }
  return credentials;
}

export function validateCtripBridgeUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)))
  ) {
    throw new TypeError(
      "Ctrip bridge requires HTTPS except on loopback and cannot contain credentials",
    );
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new CtripBridgeGatewayError(
      502,
      "CTRIP_BRIDGE_RESPONSE_TOO_LARGE",
      "Ctrip bridge returned an oversized response",
    );
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CtripBridgeGatewayError(
        502,
        "CTRIP_BRIDGE_RESPONSE_TOO_LARGE",
        "Ctrip bridge returned an oversized response",
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CtripBridgeGatewayError(
      502,
      "CTRIP_BRIDGE_RESPONSE_INVALID",
      "Ctrip bridge returned invalid JSON",
    );
  }
}

function upstreamError(status: number): CtripBridgeGatewayError {
  if (status === 401 || status === 403) {
    return new CtripBridgeGatewayError(
      503,
      "CTRIP_BRIDGE_AUTH_FAILED",
      "Ctrip bridge authentication is unavailable",
    );
  }
  if (status === 409) {
    return new CtripBridgeGatewayError(
      409,
      "CTRIP_BRIDGE_STATE_CONFLICT",
      "Ctrip bridge rejected the current handoff state",
    );
  }
  if (status === 422) {
    return new CtripBridgeGatewayError(
      422,
      "CTRIP_BRIDGE_COMMAND_REJECTED",
      "Ctrip bridge rejected the command",
    );
  }
  return new CtripBridgeGatewayError(
    503,
    "CTRIP_BRIDGE_UNAVAILABLE",
    "Ctrip bridge is unavailable",
  );
}

export class HttpCtripBridgeGateway implements CtripBridgeGateway {
  readonly #baseUrl: URL;
  readonly #credentials = new Map<string, CtripBridgeCredential>();
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly baseUrl: string;
    readonly credentials: readonly CtripBridgeCredential[];
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    this.#baseUrl = validateCtripBridgeUrl(options.baseUrl);
    for (const credential of credentialListSchema.parse(options.credentials)) {
      if (this.#credentials.has(credential.tenantId)) {
        throw new TypeError("Ctrip bridge tenant IDs must be unique");
      }
      this.#credentials.set(credential.tenantId, credential);
    }
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(command: CtripBridgeCommand): Promise<CtripBridgeResult> {
    const parsedCommand = ctripBridgeCommandSchema.parse(command);
    const credential = this.#credentials.get(parsedCommand.tenantId);
    if (credential === undefined) {
      throw new CtripBridgeGatewayError(
        503,
        "CTRIP_BRIDGE_TENANT_NOT_CONFIGURED",
        "Ctrip bridge is not configured for this tenant",
      );
    }

    let response: Response;
    try {
      response = await this.#fetch(new URL(`commands/${parsedCommand.command}`, this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parsedCommand),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new CtripBridgeGatewayError(
          504,
          "CTRIP_BRIDGE_TIMEOUT",
          "Ctrip bridge command timed out",
        );
      }
      throw new CtripBridgeGatewayError(
        503,
        "CTRIP_BRIDGE_UNAVAILABLE",
        "Ctrip bridge is unavailable",
      );
    }

    const payload = await readJson(response);
    if (!response.ok) throw upstreamError(response.status);
    const parsedResult = ctripBridgeResultSchema.safeParse(payload);
    if (
      !parsedResult.success ||
      parsedResult.data.command !== parsedCommand.command ||
      parsedResult.data.tenantId !== parsedCommand.tenantId ||
      parsedResult.data.handoffId !== parsedCommand.handoffId
    ) {
      throw new CtripBridgeGatewayError(
        502,
        "CTRIP_BRIDGE_RESPONSE_INVALID",
        "Ctrip bridge returned a mismatched response",
      );
    }
    return parsedResult.data;
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.#fetch(new URL("health/live", this.#baseUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(this.#timeoutMs, 5_000)),
      });
      return response.ok && ctripBridgeHealthSchema.safeParse(await readJson(response)).success;
    } catch {
      return false;
    }
  }
}
