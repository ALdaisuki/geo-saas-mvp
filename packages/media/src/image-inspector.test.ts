import { describe, expect, it } from "vitest";

import { inspectImportedImage } from "./image-inspector.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

it("reads dimensions and MIME from a PNG signature", () => {
  expect(inspectImportedImage(png(1200, 900))).toEqual({
    mimeType: "image/png",
    width: 1200,
    height: 900,
  });
});

it("reads JPEG dimensions from a start-of-frame segment", () => {
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x84, 0x04,
    0xb0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  expect(inspectImportedImage(bytes)).toEqual({
    mimeType: "image/jpeg",
    width: 1200,
    height: 900,
  });
});

describe("WebP", () => {
  it("reads VP8X dimensions", () => {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46]);
    new DataView(bytes.buffer).setUint32(4, 22, true);
    bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
    new DataView(bytes.buffer).setUint32(16, 10, true);
    bytes.set([0xaf, 0x04, 0x00], 24);
    bytes.set([0x83, 0x03, 0x00], 27);
    expect(inspectImportedImage(bytes)).toEqual({
      mimeType: "image/webp",
      width: 1200,
      height: 900,
    });
  });
});

it.each([
  ["unsupported bytes", Uint8Array.from([1, 2, 3]), "MEDIA_FORMAT_UNSUPPORTED"],
  ["truncated PNG", png(1200, 900).subarray(0, 20), "MEDIA_PNG_HEADER_INVALID"],
  ["zero dimensions", png(0, 900), "MEDIA_DIMENSIONS_INVALID"],
  ["unsafe dimensions", png(16_384, 16_384), "MEDIA_DIMENSIONS_TOO_LARGE"],
])("rejects %s", (_name, bytes, code) => {
  expect(() => inspectImportedImage(bytes)).toThrow(expect.objectContaining({ code }));
});
