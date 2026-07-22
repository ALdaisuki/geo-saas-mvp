import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { WikimediaCommonsImageSearchProvider } from "./licensed-image-search.js";

function searchPayload() {
  return {
    query: {
      pages: {
        "8": {
          pageid: 8,
          title: "File:Unsupported.gif",
          index: 2,
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/unsupported.gif",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Unsupported.gif",
              mime: "image/gif",
              width: 800,
              height: 600,
              extmetadata: {
                LicenseShortName: { value: "All rights reserved" },
              },
            },
          ],
        },
        "7": {
          pageid: 7,
          title: "File:Kyoto lake.jpg",
          index: 1,
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/original.jpg",
              thumburl: "https://upload.wikimedia.org/thumb/kyoto-1600px.jpg",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Kyoto_lake.jpg",
              mime: "image/jpeg",
              width: 4000,
              height: 3000,
              thumbwidth: 1600,
              thumbheight: 1200,
              extmetadata: {
                CommonsMetadataExtension: { value: 1 },
                LicenseShortName: { value: "CC BY-SA 4.0" },
                LicenseUrl: { value: "http://creativecommons.org/licenses/by-sa/4.0/" },
                Artist: { value: '<a href="/wiki/User:Example">Example Author</a>' },
                Credit: { value: "Own work" },
                ImageDescription: { value: "Kinkakuji reflected in the lake" },
              },
            },
          ],
        },
      },
    },
  };
}

describe("WikimediaCommonsImageSearchProvider", () => {
  it("returns only supported licensed bitmap candidates with fixed hosts", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(searchPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new WikimediaCommonsImageSearchProvider({ fetchImpl });

    const result = await provider.search({ query: "Kyoto Kinkakuji lake", limit: 10 });

    expect(result).toEqual([
      expect.objectContaining({
        providerAssetId: "7",
        searchQuery: "Kyoto Kinkakuji lake",
        creator: "Example Author",
        licenseName: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Kyoto_lake.jpg",
        downloadUrl: "https://upload.wikimedia.org/thumb/kyoto-1600px.jpg",
      }),
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("gsrsearch=Kyoto+Kinkakuji+lake+filetype%3Abitmap");
  });

  it("retries a zero-result editorial query with its concrete English place phrase", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? { query: { pages: {} } } : searchPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new WikimediaCommonsImageSearchProvider({ fetchImpl });

    const result = await provider.search({ query: "Tokyo family travel planning", limit: 10 });

    expect(result).toEqual([
      expect.objectContaining({ providerAssetId: "7", searchQuery: "Tokyo family travel planning" }),
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "gsrsearch=Tokyo+family+travel+planning+filetype%3Abitmap",
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("gsrsearch=Tokyo+filetype%3Abitmap");
  });

  it("aggregates and de-duplicates partial results across query fallbacks", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      const payload = searchPayload();
      const licensed = payload.query.pages["7"];
      if (licensed === undefined) throw new Error("Licensed fixture is missing");
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              [String(6 + calls)]: {
                ...licensed,
                pageid: 6 + calls,
                title: `File:Tokyo ${calls}.jpg`,
                imageinfo: licensed.imageinfo.map((image) => ({
                  ...image,
                  descriptionurl: `https://commons.wikimedia.org/wiki/File:Tokyo_${calls}.jpg`,
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new WikimediaCommonsImageSearchProvider({ fetchImpl });

    const result = await provider.search({
      query: "东京站丸之内站房 Tokyo Station Marunouchi",
      limit: 3,
    });

    expect(result.map((candidate) => candidate.providerAssetId)).toEqual(["7", "8", "9"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "gsrsearch=Tokyo+Station+Marunouchi+filetype%3Abitmap",
    );
  });

  it("normalizes downloaded pixels to a deterministic Ctrip 4:3 rendition", async () => {
    const source = await sharp({
      create: { width: 1_600, height: 1_000, channels: 3, background: "#16805f" },
    })
      .png()
      .toBuffer();
    const provider = new WikimediaCommonsImageSearchProvider({
      fetchImpl: async () =>
        new Response(source, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(source.byteLength) },
        }),
    });

    const result = await provider.downloadAndNormalize({
      candidate: {
        provider: "wikimedia_commons",
        providerAssetId: "7",
        searchQuery: "Kyoto lake",
        title: "Kyoto lake",
        description: "Lake view",
        creator: "Example Author",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Kyoto_lake.jpg",
        downloadUrl: "https://upload.wikimedia.org/thumb/kyoto.png",
        licenseName: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Example Author",
        sourceWidth: 1_600,
        sourceHeight: 1_000,
        mimeType: "image/png",
      },
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1_200, height: 900 });
    expect(metadata).toMatchObject({ format: "jpeg", width: 1_200, height: 900 });
  });

  it("retries transient Wikimedia download throttling", async () => {
    const source = await sharp({
      create: { width: 1_200, height: 900, channels: 3, background: "#245f9f" },
    })
      .jpeg()
      .toBuffer();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? new Response("throttled", { status: 429, headers: { "retry-after": "0" } })
        : new Response(source, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const provider = new WikimediaCommonsImageSearchProvider({ fetchImpl });

    const result = await provider.downloadAndNormalize({
      candidate: {
        provider: "wikimedia_commons",
        providerAssetId: "7",
        searchQuery: "Tokyo Station",
        title: "Tokyo Station",
        description: "Station exterior",
        creator: "Example Author",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Tokyo_Station.jpg",
        downloadUrl: "https://upload.wikimedia.org/thumb/tokyo.jpg",
        licenseName: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Example Author",
        sourceWidth: 1_200,
        sourceHeight: 900,
        mimeType: "image/jpeg",
      },
    });

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects candidate download host drift before making a request", async () => {
    const fetchImpl = vi.fn();
    const provider = new WikimediaCommonsImageSearchProvider({ fetchImpl });
    await expect(
      provider.downloadAndNormalize({
        candidate: {
          provider: "wikimedia_commons",
          providerAssetId: "7",
          searchQuery: "Kyoto lake",
          title: "Kyoto lake",
          description: "Lake view",
          creator: "Example Author",
          sourceUrl: "https://commons.wikimedia.org/wiki/File:Kyoto_lake.jpg",
          downloadUrl: "https://example.com/image.jpg",
          licenseName: "CC BY 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          attribution: "Example Author",
          sourceWidth: 1_600,
          sourceHeight: 1_000,
          mimeType: "image/jpeg",
        },
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SEARCH_DOWNLOAD_URL_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
