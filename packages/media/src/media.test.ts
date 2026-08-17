import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import type { VisualBrief } from "@geo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContentAddressedMediaStore,
  FixtureImageGenerationProvider,
  MediaProductionError,
  fixtureImageInputHash,
} from "./index.js";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";
const factId = "00000000-0000-4000-8000-000000000003";

function brief(aspectRatio: VisualBrief["aspectRatio"] = "16:9"): VisualBrief {
  return {
    schemaVersion: "geo.visual-brief.v1",
    editorialProfile: "guide",
    platform: "toutiao",
    role: "cover",
    aspectRatio,
    factIds: [factId],
    prompt: "Verified travel service office scene without text.",
    negativePrompt: "text, watermark, QR code, phone number, contact handle, price, credential",
    altText: "Verified travel service office scene",
    caption: "The image represents only the verified service fact.",
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pngIdat(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 8;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return combined;
}

describe("fixture image generation", () => {
  it.each([
    ["16:9", 1280, 720],
    ["4:3", 1200, 900],
    ["1:1", 1024, 1024],
  ] as const)("creates a deterministic valid %s PNG", async (aspectRatio, width, height) => {
    const provider = new FixtureImageGenerationProvider();
    const visualBrief = brief(aspectRatio);
    const expectedInputHash = fixtureImageInputHash(visualBrief);

    const first = await provider.generate({ visualBrief, expectedInputHash });
    const second = await provider.generate({ visualBrief, expectedInputHash });

    expect(provider.descriptor).toEqual({
      id: "fixture",
      mode: "fixture",
      model: "fixture-png-v1",
    });
    expect(first).toMatchObject({
      providerId: "fixture",
      providerMode: "fixture",
      model: "fixture-png-v1",
      inputHash: expectedInputHash,
      mimeType: "image/png",
      width,
      height,
      metadata: { fixture: true, deterministic: true, networkUsed: false },
    });
    expect(first.bytes).toEqual(second.bytes);
    expect(pngDimensions(first.bytes)).toEqual({ width, height });
    expect(inflateSync(pngIdat(first.bytes))).toHaveLength((width * 3 + 1) * height);
  });

  it("rejects a caller hash that does not bind the complete visual brief", async () => {
    const provider = new FixtureImageGenerationProvider();

    await expect(
      provider.generate({ visualBrief: brief(), expectedInputHash: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "MEDIA_INPUT_HASH_MISMATCH" });
  });

  it("changes both the input hash and fixture bytes when a bound brief field changes", async () => {
    const provider = new FixtureImageGenerationProvider();
    const original = brief();
    const changed = { ...original, caption: `${original.caption} Changed.` };
    const originalHash = fixtureImageInputHash(original);
    const changedHash = fixtureImageInputHash(changed);

    const originalResult = await provider.generate({
      visualBrief: original,
      expectedInputHash: originalHash,
    });
    const changedResult = await provider.generate({
      visualBrief: changed,
      expectedInputHash: changedHash,
    });

    expect(changedHash).not.toBe(originalHash);
    expect(changedResult.bytes).not.toEqual(originalResult.bytes);
  });

  it("propagates an abort reason without creating fixture bytes", async () => {
    const provider = new FixtureImageGenerationProvider();
    const timeout = new Error("provider timeout");
    const visualBrief = brief();

    await expect(
      provider.generate({
        visualBrief,
        expectedInputHash: fixtureImageInputHash(visualBrief),
        signal: AbortSignal.abort(timeout),
      }),
    ).rejects.toBe(timeout);
  });
});

describe("content-addressed media storage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "geo-media-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores exact bytes under a tenant-scoped hash key and replays idempotently", async () => {
    const store = new ContentAddressedMediaStore(root);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const hash = sha256(bytes);

    const first = await store.put({
      tenantId: tenantA,
      sha256: hash,
      mimeType: "image/png",
      bytes,
    });
    const replay = await store.put({
      tenantId: tenantA,
      sha256: hash,
      mimeType: "image/png",
      bytes,
    });

    expect(first).toEqual({
      storageKey: `${tenantA}/${hash.slice(0, 2)}/${hash}.png`,
      byteLength: 4,
    });
    expect(replay).toEqual(first);
    expect(await store.get({ tenantId: tenantA, storageKey: first.storageKey })).toEqual(bytes);
  });

  it("rejects invalid MIME types and a mismatched expected hash", async () => {
    const store = new ContentAddressedMediaStore(root);
    const bytes = Uint8Array.from([1, 2, 3]);

    await expect(
      store.put({ tenantId: tenantA, sha256: sha256(bytes), mimeType: "image/svg+xml", bytes }),
    ).rejects.toMatchObject({ code: "MEDIA_MIME_UNSUPPORTED" });
    await expect(
      store.put({ tenantId: tenantA, sha256: "b".repeat(64), mimeType: "image/png", bytes }),
    ).rejects.toMatchObject({ code: "MEDIA_SHA_MISMATCH" });
  });

  it("rejects traversal-shaped keys and cross-tenant reads", async () => {
    const store = new ContentAddressedMediaStore(root);
    const bytes = Uint8Array.from([8, 9]);
    const hash = sha256(bytes);
    const stored = await store.put({
      tenantId: tenantA,
      sha256: hash,
      mimeType: "image/png",
      bytes,
    });

    await expect(
      store.get({ tenantId: tenantA, storageKey: `../${stored.storageKey}` }),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_KEY_INVALID" });
    await expect(
      store.get({ tenantId: tenantB, storageKey: stored.storageKey }),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_TENANT_MISMATCH" });
  });

  it("never overwrites an existing key and detects corrupted reads", async () => {
    const store = new ContentAddressedMediaStore(root);
    const bytes = Uint8Array.from([11, 12, 13]);
    const hash = sha256(bytes);
    const stored = await store.put({
      tenantId: tenantA,
      sha256: hash,
      mimeType: "image/png",
      bytes,
    });
    const absolutePath = join(root, ...stored.storageKey.split("/"));
    const corrupted = Uint8Array.from([99, 98, 97]);
    await writeFile(absolutePath, corrupted);

    await expect(
      store.put({ tenantId: tenantA, sha256: hash, mimeType: "image/png", bytes }),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_COLLISION" });
    expect(await readFile(absolutePath)).toEqual(Buffer.from(corrupted));
    await expect(
      store.get({ tenantId: tenantA, storageKey: stored.storageKey }),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_CORRUPT" });
  });

  it("exposes stable typed errors", () => {
    const error = new MediaProductionError("MEDIA_TEST", "test", { field: "value" });
    expect(error).toMatchObject({ name: "MediaProductionError", code: "MEDIA_TEST" });
    expect(error.details).toEqual({ field: "value" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
