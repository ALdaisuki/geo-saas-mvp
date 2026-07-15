import { visualBriefSchema, type MediaAspectRatio, type VisualBrief } from "@geo/contracts";
import { sha256Canonical } from "@geo/core";
import { deflateSync } from "node:zlib";

import {
  MediaProductionError,
  type ImageGenerationProvider,
  type ImageGenerationProviderDescriptor,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from "./types.js";

const DIMENSIONS: Readonly<Record<MediaAspectRatio, Readonly<{ width: number; height: number }>>> =
  {
    "16:9": { width: 1280, height: 720 },
    "4:3": { width: 1200, height: 900 },
    "1:1": { width: 1024, height: 1024 },
  };

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

function chunk(type: "IHDR" | "IDAT" | "IEND", data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const checksumInput = concatenate([typeBytes, data]);
  return concatenate([uint32(data.byteLength), typeBytes, data, uint32(crc32(checksumInput))]);
}

function fixtureColor(inputHash: string): readonly [number, number, number] {
  const component = (offset: number): number =>
    64 + (Number.parseInt(inputHash.slice(offset, offset + 2), 16) % 160);
  return [component(0), component(2), component(4)];
}

function encodeFixturePng(width: number, height: number, inputHash: string): Uint8Array {
  const [red, green, blue] = fixtureColor(inputHash);
  const row = new Uint8Array(width * 3 + 1);
  for (let offset = 1; offset < row.byteLength; offset += 3) {
    row[offset] = red;
    row[offset + 1] = green;
    row[offset + 2] = blue;
  }
  const pixels = new Uint8Array(row.byteLength * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    pixels.set(row, rowIndex * row.byteLength);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const compressed = Uint8Array.from(deflateSync(pixels, { level: 9 }));
  return concatenate([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason ?? new MediaProductionError("MEDIA_GENERATION_ABORTED", "Generation aborted");
}

export function fixtureImageInputHash(visualBrief: VisualBrief): string {
  return sha256Canonical({
    schemaVersion: "geo.fixture-image-request.v1",
    visualBrief,
  });
}

export class FixtureImageGenerationProvider implements ImageGenerationProvider {
  readonly descriptor: ImageGenerationProviderDescriptor = Object.freeze({
    id: "fixture",
    mode: "fixture",
    model: "fixture-png-v1",
  });

  async generate(input: ImageGenerationRequest): Promise<ImageGenerationResult> {
    throwIfAborted(input.signal);
    const visualBrief = visualBriefSchema.parse(input.visualBrief);
    const inputHash = fixtureImageInputHash(visualBrief);
    if (!SHA256_PATTERN.test(input.expectedInputHash) || input.expectedInputHash !== inputHash) {
      throw new MediaProductionError(
        "MEDIA_INPUT_HASH_MISMATCH",
        "Expected input hash does not match the complete visual brief",
        { expectedInputHash: input.expectedInputHash, inputHash },
      );
    }

    const { width, height } = DIMENSIONS[visualBrief.aspectRatio];
    const bytes = encodeFixturePng(width, height, inputHash);
    throwIfAborted(input.signal);
    return Object.freeze({
      providerId: this.descriptor.id,
      providerMode: this.descriptor.mode,
      model: this.descriptor.model,
      inputHash,
      bytes,
      mimeType: "image/png" as const,
      width,
      height,
      metadata: Object.freeze({ fixture: true, deterministic: true, networkUsed: false }),
    });
  }
}
