import type { MediaProviderMode, MediaRole, Platform } from "@geo/contracts";
import { z } from "zod";

import {
  type AgentGatewayCredential,
  AgentRunGatewayError,
  validateAgentGatewayUrl,
} from "./agent-run-gateway.js";

const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

const inspectionSchema = z.strictObject({
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["passed", "failed"]),
  evaluator: z.string().trim().min(1).max(200),
  evaluatorMode: z.literal("live"),
  evaluatorVersion: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  providerRequestId: z.string().trim().min(1).max(1_000).nullable(),
  ocrText: z.string().max(10_000),
  labels: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .refine((values) => new Set(values).size === values.length, "Labels must be unique"),
});

const responseSchema = z.strictObject({ inspection: inspectionSchema });

export interface MediaContentInspectionRequest {
  readonly tenantId: string;
  readonly assetSha256: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly bytesBase64: string;
  readonly platform: Platform;
  readonly role: MediaRole;
  readonly relevanceContext?: Readonly<{
    readonly query: string;
    readonly rationale: string;
    readonly articleTitle: string;
    readonly sectionContext: string;
  }>;
}

export interface MediaContentInspectionResult {
  readonly assetSha256: string;
  readonly status: "passed" | "failed";
  readonly evaluator: string;
  readonly evaluatorMode: MediaProviderMode;
  readonly evaluatorVersion: string;
  readonly model: string;
  readonly responseSha256: string;
  readonly providerRequestId: string | null;
  readonly ocrText: string;
  readonly labels: readonly string[];
}

export interface MediaContentInspector {
  inspect(
    input: Readonly<MediaContentInspectionRequest>,
    signal?: AbortSignal,
  ): Promise<Readonly<MediaContentInspectionResult>>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AgentRunGatewayError(
      502,
      "MEDIA_INSPECTION_RESPONSE_TOO_LARGE",
      "Media inspector returned an oversized response",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new AgentRunGatewayError(
      502,
      "MEDIA_INSPECTION_RESPONSE_TOO_LARGE",
      "Media inspector returned an oversized response",
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AgentRunGatewayError(
      502,
      "MEDIA_INSPECTION_RESPONSE_INVALID",
      "Media inspector returned an invalid response",
    );
  }
}

function mapUpstreamStatus(status: number): AgentRunGatewayError {
  if (status === 409) {
    return new AgentRunGatewayError(
      409,
      "MEDIA_INSPECTION_ACTIVE",
      "A media inspection is already active",
    );
  }
  if (status === 502) {
    return new AgentRunGatewayError(
      502,
      "MEDIA_INSPECTION_PROVIDER_FAILED",
      "Vision provider failed",
    );
  }
  if (status === 504) {
    return new AgentRunGatewayError(504, "MEDIA_INSPECTION_TIMEOUT", "Media inspection timed out");
  }
  if (status === 401 || status === 403) {
    return new AgentRunGatewayError(
      503,
      "MEDIA_INSPECTION_AUTH_FAILED",
      "Media inspector authentication is unavailable",
    );
  }
  return new AgentRunGatewayError(
    503,
    "MEDIA_INSPECTION_UNAVAILABLE",
    "Media inspector is unavailable",
  );
}

export class HttpMediaContentInspector implements MediaContentInspector {
  readonly #baseUrl: URL;
  readonly #credentials = new Map<string, AgentGatewayCredential>();
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly baseUrl: string;
    readonly credentials: readonly AgentGatewayCredential[];
    readonly fetchImpl?: FetchLike;
    readonly timeoutMs?: number;
  }) {
    this.#baseUrl = validateAgentGatewayUrl(options.baseUrl);
    for (const credential of options.credentials) {
      if (this.#credentials.has(credential.tenantId)) {
        throw new TypeError("Media inspector tenant IDs must be unique");
      }
      this.#credentials.set(credential.tenantId, credential);
    }
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async inspect(
    input: Readonly<MediaContentInspectionRequest>,
    callerSignal?: AbortSignal,
  ): Promise<Readonly<MediaContentInspectionResult>> {
    const credential = this.#credentials.get(input.tenantId);
    if (credential === undefined) {
      throw new AgentRunGatewayError(
        503,
        "MEDIA_INSPECTION_TENANT_NOT_CONFIGURED",
        "Media inspector is not configured for this tenant",
      );
    }
    let response: Response;
    try {
      const upstreamInput = {
        assetSha256: input.assetSha256,
        mimeType: input.mimeType,
        bytesBase64: input.bytesBase64,
        platform: input.platform,
        role: input.role,
        ...(input.relevanceContext === undefined
          ? {}
          : { relevanceContext: input.relevanceContext }),
      };
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      response = await this.#fetch(new URL("media/inspections", this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(upstreamInput),
        signal:
          callerSignal === undefined
            ? timeoutSignal
            : AbortSignal.any([timeoutSignal, callerSignal]),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new AgentRunGatewayError(
          504,
          "MEDIA_INSPECTION_TIMEOUT",
          "Media inspection timed out",
        );
      }
      throw new AgentRunGatewayError(
        503,
        "MEDIA_INSPECTION_UNAVAILABLE",
        "Media inspector is unavailable",
      );
    }
    const payload = await readResponse(response);
    if (!response.ok) throw mapUpstreamStatus(response.status);
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.inspection.assetSha256 !== input.assetSha256) {
      throw new AgentRunGatewayError(
        502,
        "MEDIA_INSPECTION_RESPONSE_INVALID",
        "Media inspector returned evidence for different or invalid bytes",
      );
    }
    return parsed.data.inspection;
  }
}
