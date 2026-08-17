import { createHash } from "node:crypto";

import type { ActorContext } from "@geo/contracts";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaInspectionRunnerError,
  PiVisionMediaInspectionService,
  type VisionInference,
} from "./media-inspection-runner.js";

const principal: ActorContext = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  role: "owner",
  capabilities: ["content:write"],
  requestId: "vision-test",
};

const bytes = Buffer.from("real-image-byte-probe");
const assetSha256 = createHash("sha256").update(bytes).digest("hex");
const input = {
  assetSha256,
  mimeType: "image/png" as const,
  bytesBase64: bytes.toString("base64"),
  platform: "ctrip_community" as const,
  role: "cover" as const,
};

function service(infer: VisionInference) {
  return new PiVisionMediaInspectionService({
    model: {} as Model<Api>,
    apiKey: "test-key",
    modelId: "vision-test-model",
    provider: "vision-test-provider",
    infer,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Pi vision media inspection", () => {
  it("binds a confident safe inspection to the exact image bytes", async () => {
    const contexts: Readonly<Context>[] = [];
    const infer = vi.fn<VisionInference>(async (context) => {
      contexts.push(context);
      return {
        text: JSON.stringify({
          ocrText: "",
          description: "A family walking beside a recognizable travel destination.",
          scene: {
            subject: "family_activity",
            setting: "outdoor",
            composition: "wide",
          },
          travelRelevant: true,
          contactTextDetected: false,
          safetyConcerns: [],
          uncertain: false,
        }),
        providerRequestId: "provider-request-1",
      };
    });

    await expect(service(infer).inspect(principal, input)).resolves.toMatchObject({
      assetSha256,
      status: "passed",
      evaluator: "pi-vision-inspector",
      evaluatorMode: "live",
      evaluatorVersion: "1.0.0",
      model: "vision-test-model",
      providerRequestId: "provider-request-1",
      ocrText: "",
      labels: expect.arrayContaining([
        "ocr:completed",
        "travel-relevance:passed",
        "contact-text:none",
        "vision-confidence:confident",
        "safety:passed",
        "scene-signature:family_activity:outdoor:wide",
      ]),
    });
    expect(contexts[0]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        { type: "image", data: input.bytesBase64, mimeType: "image/png" },
      ]),
    });
    const promptContent = contexts[0]?.messages[0]?.content;
    if (!Array.isArray(promptContent)) throw new Error("Inspection prompt is missing");
    const prompt = promptContent.find((block) => block.type === "text");
    expect(prompt).toMatchObject({ type: "text" });
    if (prompt?.type !== "text") throw new Error("Inspection prompt is missing");
    expect(prompt.text).toContain("Ordinary people in a public travel scene");
    expect(prompt.text).toContain("routine non-contact signage are not personal_data");
    expect(prompt.text).toContain("uncertainty could materially change contact detection");
  });

  it("fails closed for visible contact text or uncertain findings", async () => {
    const infer: VisionInference = async () => ({
      text: JSON.stringify({
        ocrText: "WeChat TEST1234",
        description: "A travel poster with a contact handle.",
        scene: {
          subject: "other_destination",
          setting: "outdoor",
          composition: "medium",
        },
        travelRelevant: true,
        contactTextDetected: true,
        safetyConcerns: ["text_heavy"],
        uncertain: true,
      }),
      providerRequestId: null,
    });

    await expect(service(infer).inspect(principal, input)).resolves.toMatchObject({
      status: "failed",
      ocrText: "WeChat TEST1234",
      labels: expect.arrayContaining([
        "contact-text:detected",
        "vision-confidence:uncertain",
        "safety-concern:text_heavy",
      ]),
    });
  });

  it("fails a keyword search candidate when vision says the article intent does not match", async () => {
    const infer: VisionInference = async () => ({
      text: JSON.stringify({
        ocrText: "",
        description: "A generic street.",
        scene: { subject: "urban_street", setting: "outdoor", composition: "wide" },
        travelRelevant: true,
        queryRelevant: false,
        relevanceScore: 12,
        contactTextDetected: false,
        safetyConcerns: [],
        uncertain: false,
      }),
      providerRequestId: null,
    });

    await expect(
      service(infer).inspect(principal, {
        ...input,
        relevanceContext: {
          query: "Kyoto Kinkakuji lake panorama",
          rationale: "The cover must establish the destination landmark.",
          articleTitle: "Kyoto family trip",
          sectionContext: "The article introduces a first-time Kyoto itinerary.",
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      labels: expect.arrayContaining(["article-relevance:failed"]),
    });
  });

  it("accepts a moderately relevant safe image even when the model marks it uncertain", async () => {
    const infer: VisionInference = async () => ({
      text: JSON.stringify({
        ocrText: "",
        description: "A public destination street matching the article section.",
        scene: { subject: "urban_street", setting: "outdoor", composition: "wide" },
        travelRelevant: true,
        queryRelevant: true,
        relevanceScore: 50,
        contactTextDetected: false,
        safetyConcerns: [],
        uncertain: true,
      }),
      providerRequestId: null,
    });

    await expect(
      service(infer).inspect(principal, {
        ...input,
        relevanceContext: {
          query: "Tokyo public street",
          rationale: "Illustrate the route section.",
          articleTitle: "Tokyo family trip",
          sectionContext: "The route passes through a public Tokyo street.",
        },
      }),
    ).resolves.toMatchObject({
      status: "passed",
      labels: expect.arrayContaining(["article-relevance:passed", "vision-confidence:uncertain"]),
    });
  });

  it("recovers from one transient provider failure without exposing provider text", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const runner = service(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("fetch failed upstream-detail=must-never-leak");
      }
      return {
        text: JSON.stringify({
          ocrText: "",
          description: "A safe destination landscape.",
          scene: { subject: "nature", setting: "outdoor", composition: "wide" },
          travelRelevant: true,
          contactTextDetected: false,
          safetyConcerns: [],
          uncertain: false,
        }),
        providerRequestId: "provider-request-after-retry",
      };
    });

    await expect(runner.inspect(principal, input)).resolves.toMatchObject({
      status: "passed",
      providerRequestId: "provider-request-after-retry",
    });
    expect(attempts).toBe(2);
    const logs = consoleError.mock.calls.map(([entry]) => JSON.parse(String(entry)) as unknown);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "pi_vision.retry_scheduled",
        failureClass: "transport",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("must-never-leak");
  });

  it("preserves sanitized provider diagnostics while bounding transient retries", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const runner = service(async () => {
      attempts += 1;
      throw Object.assign(new Error("upstream-detail=must-never-leak"), {
        failureClass: "upstream_5xx",
        providerStatus: 502,
        retryable: true,
      });
    });

    await expect(runner.inspect(principal, input)).rejects.toMatchObject({
      code: "MEDIA_INSPECTION_FAILED",
      statusCode: 502,
    });
    expect(attempts).toBe(2);
    const logs = consoleError.mock.calls.map(([entry]) => JSON.parse(String(entry)) as unknown);
    expect(logs).toEqual([
      expect.objectContaining({
        event: "pi_vision.retry_scheduled",
        failureClass: "upstream_5xx",
        providerStatus: 502,
      }),
      expect.objectContaining({
        event: "pi_vision.infer_exception",
        failureClass: "upstream_5xx",
        providerStatus: 502,
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain("must-never-leak");
  });

  it.each([
    {
      name: "an aborted request",
      error: new Error("fetch failed"),
      abort: true,
      expectedAttempts: 1,
      failureClass: "aborted",
      providerStatus: null,
    },
    {
      name: "an HTTP 400 response",
      error: new Error("HTTP status 400 network failure"),
      abort: false,
      expectedAttempts: 1,
      failureClass: "invalid_request",
      providerStatus: 400,
    },
    {
      name: "an HTTP 403 response",
      error: new Error("HTTP 403"),
      abort: false,
      expectedAttempts: 1,
      failureClass: "authentication",
      providerStatus: 403,
    },
    {
      name: "a tagged aborted failure that requests a retry",
      error: Object.assign(new Error("opaque failure"), {
        failureClass: "aborted",
        providerStatus: null,
        retryable: true,
      }),
      abort: false,
      expectedAttempts: 1,
      failureClass: "aborted",
      providerStatus: null,
    },
    {
      name: "a tagged authentication failure that requests a retry",
      error: Object.assign(new Error("opaque failure"), {
        failureClass: "authentication",
        providerStatus: 401,
        retryable: true,
      }),
      abort: false,
      expectedAttempts: 1,
      failureClass: "authentication",
      providerStatus: 401,
    },
    {
      name: "a tagged invalid request that requests a retry",
      error: Object.assign(new Error("opaque failure"), {
        failureClass: "invalid_request",
        providerStatus: 400,
        retryable: true,
      }),
      abort: false,
      expectedAttempts: 1,
      failureClass: "invalid_request",
      providerStatus: 400,
    },
    {
      name: "a tagged transport failure carrying an HTTP 401 status",
      error: Object.assign(new Error("opaque failure"), {
        failureClass: "transport",
        providerStatus: 401,
        retryable: true,
      }),
      abort: false,
      expectedAttempts: 1,
      failureClass: "authentication",
      providerStatus: 401,
    },
    {
      name: "a tagged unknown failure carrying an HTTP 400 status",
      error: Object.assign(new Error("opaque failure"), {
        failureClass: "unknown",
        providerStatus: 400,
        retryable: true,
      }),
      abort: false,
      expectedAttempts: 1,
      failureClass: "invalid_request",
      providerStatus: 400,
    },
    {
      name: "an HTTP 429 response",
      error: new Error("status code 429"),
      abort: false,
      expectedAttempts: 2,
      failureClass: "rate_limited",
      providerStatus: 429,
    },
    {
      name: "an HTTP 503 response",
      error: new Error("HTTP 503"),
      abort: false,
      expectedAttempts: 2,
      failureClass: "upstream_5xx",
      providerStatus: 503,
    },
    {
      name: "a transport failure",
      error: new Error("ECONNRESET"),
      abort: false,
      expectedAttempts: 2,
      failureClass: "transport",
      providerStatus: null,
    },
    {
      name: "a provider evidence failure",
      error: new MediaInspectionRunnerError(),
      abort: false,
      expectedAttempts: 2,
      failureClass: "provider_error",
      providerStatus: null,
    },
    {
      name: "an unclassified provider failure",
      error: new Error("opaque failure"),
      abort: false,
      expectedAttempts: 2,
      failureClass: "unknown",
      providerStatus: null,
    },
  ])(
    "applies the bounded retry policy to $name and scopes every diagnostic",
    async ({ error, abort, expectedAttempts, failureClass, providerStatus }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const infer = vi.fn<VisionInference>(async () => {
        throw error;
      });
      const controller = new AbortController();
      if (abort) controller.abort();

      await expect(
        service(infer).inspect(principal, input, controller.signal),
      ).rejects.toMatchObject({
        code: "MEDIA_INSPECTION_FAILED",
        statusCode: 502,
      });

      expect(infer).toHaveBeenCalledTimes(expectedAttempts);
      const logs = consoleError.mock.calls.map(([entry]) => JSON.parse(String(entry)) as unknown);
      expect(logs).toHaveLength(expectedAttempts);
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event:
              expectedAttempts === 1 ? "pi_vision.infer_exception" : "pi_vision.retry_scheduled",
            tenantId: principal.tenantId,
            requestId: principal.requestId,
            failureClass,
            providerStatus,
          }),
        ]),
      );
      for (const log of logs) {
        expect(log).toEqual(
          expect.objectContaining({
            tenantId: principal.tenantId,
            requestId: principal.requestId,
          }),
        );
      }
    },
  );

  it("rejects hash mismatches and malformed model evidence", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infer = vi.fn<VisionInference>(async () => ({
      text: "not-json provider-secret=must-never-leak",
      providerRequestId: null,
    }));
    const runner = service(infer);

    await expect(
      runner.inspect(principal, { ...input, assetSha256: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(MediaInspectionRunnerError);
    expect(infer).not.toHaveBeenCalled();
    await expect(runner.inspect(principal, input)).rejects.toMatchObject({
      code: "MEDIA_INSPECTION_FAILED",
      statusCode: 502,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("provider-secret");
  });

  it("does not expose provider exception text through errors or logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const runner = service(async () => {
      attempts += 1;
      const error = new Error("Authorization Bearer provider-secret password=private");
      error.name = "ProviderError-provider-secret";
      throw error;
    });

    let captured: unknown;
    try {
      await runner.inspect(principal, input);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "MEDIA_INSPECTION_FAILED", statusCode: 502 });
    expect(attempts).toBe(1);
    expect(String(captured)).not.toContain("provider-secret");
    expect(String(captured)).not.toContain("password=private");
    const logs = consoleError.mock.calls.map(([entry]) => JSON.parse(String(entry)) as unknown);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "pi_vision.infer_exception",
        failureClass: "authentication",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("provider-secret");
    expect(JSON.stringify(logs)).not.toContain("password=private");
  });
});
