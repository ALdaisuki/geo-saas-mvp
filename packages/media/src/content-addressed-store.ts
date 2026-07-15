import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  MediaProductionError,
  type MediaObjectStore,
  type MediaObjectStorePutInput,
  type MediaObjectStoreResult,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STORAGE_KEY_PATTERN = /^([0-9a-f-]{36})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpg|webp)$/u;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeTenantId(tenantId: string): string {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new MediaProductionError("MEDIA_TENANT_ID_INVALID", "Tenant ID must be a UUID", {
      tenantId,
    });
  }
  return tenantId.toLowerCase();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export class ContentAddressedMediaStore implements MediaObjectStore {
  readonly #root: string;

  constructor(root: string) {
    if (root.trim().length === 0) {
      throw new MediaProductionError("MEDIA_STORAGE_ROOT_INVALID", "Storage root cannot be empty");
    }
    this.#root = resolve(root);
  }

  #absolutePath(storageKey: string): string {
    const absolutePath = resolve(this.#root, ...storageKey.split("/"));
    if (!absolutePath.startsWith(`${this.#root}${sep}`)) {
      throw new MediaProductionError(
        "MEDIA_STORAGE_KEY_INVALID",
        "Storage key escapes the configured root",
        { storageKey },
      );
    }
    return absolutePath;
  }

  async put(input: MediaObjectStorePutInput): Promise<MediaObjectStoreResult> {
    const tenantId = normalizeTenantId(input.tenantId);
    const extension = EXTENSIONS[input.mimeType];
    if (extension === undefined) {
      throw new MediaProductionError("MEDIA_MIME_UNSUPPORTED", "Media MIME type is unsupported", {
        mimeType: input.mimeType,
      });
    }
    if (!SHA256_PATTERN.test(input.sha256)) {
      throw new MediaProductionError("MEDIA_SHA_INVALID", "Media SHA-256 must be lowercase hex");
    }
    if (input.bytes.byteLength === 0) {
      throw new MediaProductionError("MEDIA_BYTES_EMPTY", "Media bytes cannot be empty");
    }
    const actualSha256 = sha256(input.bytes);
    if (actualSha256 !== input.sha256) {
      throw new MediaProductionError(
        "MEDIA_SHA_MISMATCH",
        "Media bytes do not match the expected SHA-256",
        { expectedSha256: input.sha256, actualSha256 },
      );
    }

    const storageKey = `${tenantId}/${input.sha256.slice(0, 2)}/${input.sha256}.${extension}`;
    const absolutePath = this.#absolutePath(storageKey);
    await mkdir(dirname(absolutePath), { recursive: true });

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(absolutePath, "wx", 0o600);
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        await rm(absolutePath, { force: true }).catch(() => undefined);
      } else if (errorCode(error) === "EEXIST") {
        const existing = await readFile(absolutePath);
        if (!equalBytes(existing, input.bytes)) {
          throw new MediaProductionError(
            "MEDIA_STORAGE_COLLISION",
            "Existing content-addressed object has different bytes",
            { storageKey },
          );
        }
        return Object.freeze({ storageKey, byteLength: input.bytes.byteLength });
      }
      throw error;
    }

    return Object.freeze({ storageKey, byteLength: input.bytes.byteLength });
  }

  async get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<Uint8Array> {
    const tenantId = normalizeTenantId(input.tenantId);
    const match = STORAGE_KEY_PATTERN.exec(input.storageKey);
    if (match === null) {
      throw new MediaProductionError(
        "MEDIA_STORAGE_KEY_INVALID",
        "Storage key is not a canonical media object key",
        { storageKey: input.storageKey },
      );
    }
    const [, keyTenantId, prefix, expectedSha256] = match;
    if (keyTenantId !== tenantId) {
      throw new MediaProductionError(
        "MEDIA_STORAGE_TENANT_MISMATCH",
        "Storage key belongs to a different tenant",
        { tenantId, keyTenantId },
      );
    }
    if (prefix !== expectedSha256?.slice(0, 2)) {
      throw new MediaProductionError(
        "MEDIA_STORAGE_KEY_INVALID",
        "Storage key prefix does not match its SHA-256",
        { storageKey: input.storageKey },
      );
    }

    const absolutePath = this.#absolutePath(input.storageKey);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new MediaProductionError("MEDIA_STORAGE_NOT_FOUND", "Media object was not found", {
          storageKey: input.storageKey,
        });
      }
      throw error;
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== expectedSha256) {
      throw new MediaProductionError(
        "MEDIA_STORAGE_CORRUPT",
        "Stored media bytes do not match the content-addressed key",
        { storageKey: input.storageKey, expectedSha256, actualSha256 },
      );
    }
    return Uint8Array.from(bytes);
  }
}
