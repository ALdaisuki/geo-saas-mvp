import { MediaProductionError } from "./types.js";

export const MAX_IMPORTED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORTED_IMAGE_DIMENSION = 16_384;
export const MAX_IMPORTED_IMAGE_PIXELS = 100_000_000;

export interface InspectedImage {
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

function fail(code: string, message: string): never {
  throw new MediaProductionError(code, message);
}

function assertSize(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) fail("MEDIA_BYTES_EMPTY", "Image bytes cannot be empty");
  if (bytes.byteLength > MAX_IMPORTED_IMAGE_BYTES) {
    fail("MEDIA_BYTES_TOO_LARGE", "Image exceeds the 10 MiB import limit");
  }
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPng(bytes: Uint8Array): InspectedImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes.byteLength < 33 || readUint32Be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    fail("MEDIA_PNG_HEADER_INVALID", "PNG IHDR is missing or truncated");
  }
  const width = readUint32Be(bytes, 16);
  const height = readUint32Be(bytes, 20);
  return { mimeType: "image/png", width, height };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes: Uint8Array): InspectedImage | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) {
      fail("MEDIA_JPEG_HEADER_INVALID", "JPEG segment header is truncated");
    }
    const segmentLength = readUint16Be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      fail("MEDIA_JPEG_HEADER_INVALID", "JPEG segment length is invalid");
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) fail("MEDIA_JPEG_HEADER_INVALID", "JPEG SOF is truncated");
      return {
        mimeType: "image/jpeg",
        height: readUint16Be(bytes, offset + 3),
        width: readUint16Be(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  fail("MEDIA_JPEG_DIMENSIONS_MISSING", "JPEG has no supported start-of-frame segment");
}

function inspectWebp(bytes: Uint8Array): InspectedImage | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  if (bytes.byteLength < 30 || readUint32Le(bytes, 4) + 8 !== bytes.byteLength) {
    fail("MEDIA_WEBP_HEADER_INVALID", "WebP RIFF length is invalid");
  }
  const chunk = ascii(bytes, 12, 4);
  const chunkLength = readUint32Le(bytes, 16);
  if (20 + chunkLength > bytes.byteLength) {
    fail("MEDIA_WEBP_HEADER_INVALID", "WebP image chunk is truncated");
  }
  if (chunk === "VP8X") {
    if (chunkLength < 10) fail("MEDIA_WEBP_HEADER_INVALID", "WebP VP8X header is truncated");
    return {
      mimeType: "image/webp",
      width: readUint24Le(bytes, 24) + 1,
      height: readUint24Le(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 ") {
    if (chunkLength < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      fail("MEDIA_WEBP_HEADER_INVALID", "WebP VP8 frame header is invalid");
    }
    return {
      mimeType: "image/webp",
      width: readUint16Le(bytes, 26) & 0x3fff,
      height: readUint16Le(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (chunkLength < 5 || bytes[20] !== 0x2f) {
      fail("MEDIA_WEBP_HEADER_INVALID", "WebP VP8L frame header is invalid");
    }
    const bits = readUint32Le(bytes, 21);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  fail("MEDIA_WEBP_CHUNK_UNSUPPORTED", "WebP has no supported primary image chunk");
}

function assertDimensions(result: InspectedImage): InspectedImage {
  if (result.width <= 0 || result.height <= 0) {
    fail("MEDIA_DIMENSIONS_INVALID", "Image dimensions must be positive");
  }
  if (
    result.width > MAX_IMPORTED_IMAGE_DIMENSION ||
    result.height > MAX_IMPORTED_IMAGE_DIMENSION ||
    result.width * result.height > MAX_IMPORTED_IMAGE_PIXELS
  ) {
    fail("MEDIA_DIMENSIONS_TOO_LARGE", "Image dimensions exceed the import safety limit");
  }
  return Object.freeze(result);
}

export function inspectImportedImage(bytes: Uint8Array): Readonly<InspectedImage> {
  assertSize(bytes);
  const result = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (result === null) {
    fail("MEDIA_FORMAT_UNSUPPORTED", "Only PNG, JPEG, and WebP images are accepted");
  }
  return assertDimensions(result);
}
