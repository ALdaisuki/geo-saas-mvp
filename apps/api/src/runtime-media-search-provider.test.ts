import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProviderConfigurationController } from "./runtime-provider-config.js";
import { RuntimeConfiguredMediaSearchProvider } from "./runtime-media-search-provider.js";

const updatedAt = "2026-08-11T00:00:00.000Z";

function storeWithProxySetting(proxyUrl: string | null): RuntimeProviderConfigurationController {
  const document = {
    schemaVersion: "geo.runtime-provider-config.v1" as const,
    sections: [
      {
        configKey: "media_search" as const,
        provider: "wikimedia_commons",
        model: "licensed-image-search",
        baseUrl: null,
        api: null,
        completionsMode: "stream" as const,
        enabled: true,
        apiKeyMasked: null,
        apiKeySet: false,
        version: 1,
        updatedBy: "test",
        updatedAt,
        settings: { proxyUrl },
      },
    ],
    updatedAt,
  };
  return {
    getDocument: vi.fn(async () => document),
    updateSections: vi.fn(async () => document),
    listModels: vi.fn(async () => []),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RuntimeConfiguredMediaSearchProvider", () => {
  it("keeps the deployment proxy when the runtime section leaves proxyUrl unset", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ query: { pages: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new RuntimeConfiguredMediaSearchProvider({
      store: storeWithProxySetting(null),
      fallback: {
        provider: "wikimedia_commons",
        proxyUrl: "http://proxy.example.test:8080",
      },
    });

    try {
      await provider.search({ query: "Alishan Forest Railway", limit: 2 });
    } finally {
      await provider.close();
    }

    const requestInit = fetchMock.mock.calls[0]?.[1] as
      (RequestInit & { readonly dispatcher?: unknown }) | undefined;
    expect(requestInit?.dispatcher).toBeDefined();
  });
});
