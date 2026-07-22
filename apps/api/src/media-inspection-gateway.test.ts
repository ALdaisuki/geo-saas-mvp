import { describe, expect, it, vi } from "vitest";

import { HttpMediaContentInspector } from "./media-inspection-gateway.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const token = "media-inspection-test-token-with-safe-length";
const assetSha256 = "a".repeat(64);
const request = {
  tenantId,
  assetSha256,
  mimeType: "image/png" as const,
  bytesBase64: "aW1hZ2U=",
  platform: "ctrip_community" as const,
  role: "cover" as const,
};

function response(sha256 = assetSha256): Response {
  return new Response(
    JSON.stringify({
      inspection: {
        assetSha256: sha256,
        status: "passed",
        evaluator: "pi-vision-inspector",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
        model: "vision-model",
        responseSha256: "b".repeat(64),
        providerRequestId: null,
        ocrText: "",
        labels: ["ocr:completed"],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("HTTP media content inspector", () => {
  it("selects the tenant bearer and strips tenantId from the upstream body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const inspector = new HttpMediaContentInspector({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: vi.fn(async (input, init) => {
        calls.push({ url: String(input), init });
        return response();
      }),
    });

    await expect(inspector.inspect(request)).resolves.toMatchObject({
      assetSha256,
      status: "passed",
      evaluator: "pi-vision-inspector",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:9021/media/inspections");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      assetSha256,
      mimeType: "image/png",
      bytesBase64: request.bytesBase64,
      platform: "ctrip_community",
      role: "cover",
    });
  });

  it("passes article relevance context to the tenant vision service", async () => {
    const calls: RequestInit[] = [];
    const inspector = new HttpMediaContentInspector({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: vi.fn(async (_input, init) => {
        calls.push(init ?? {});
        return response();
      }),
    });
    const relevanceContext = {
      query: "Kyoto Kinkakuji lake panorama",
      rationale: "Destination cover",
      articleTitle: "Kyoto trip",
      sectionContext: "Introduction",
    };

    await inspector.inspect({ ...request, relevanceContext });

    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ relevanceContext });
  });

  it("rejects cross-byte evidence and unconfigured tenants", async () => {
    const inspector = new HttpMediaContentInspector({
      baseUrl: "http://127.0.0.1:9021",
      credentials: [{ tenantId, accessToken: token }],
      fetchImpl: async () => response("c".repeat(64)),
    });

    await expect(inspector.inspect(request)).rejects.toMatchObject({
      code: "MEDIA_INSPECTION_RESPONSE_INVALID",
      statusCode: 502,
    });
    await expect(
      inspector.inspect({ ...request, tenantId: "20000000-0000-4000-8000-000000000001" }),
    ).rejects.toMatchObject({ code: "MEDIA_INSPECTION_TENANT_NOT_CONFIGURED" });
  });
});
