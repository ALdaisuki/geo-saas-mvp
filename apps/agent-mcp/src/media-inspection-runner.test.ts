import { createHash } from "node:crypto";

import type { ActorContext } from "@geo/contracts";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

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
    infer,
  });
}

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

  it("rejects hash mismatches and malformed model evidence", async () => {
    const infer = vi.fn<VisionInference>(async () => ({
      text: "not-json",
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
  });
});
