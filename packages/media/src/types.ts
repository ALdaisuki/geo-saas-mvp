import type { MediaProviderMode, VisualBrief } from "@geo/contracts";

export class MediaProductionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MediaProductionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ImageGenerationProviderDescriptor {
  readonly id: string;
  readonly mode: MediaProviderMode;
  readonly model: string;
}

export interface ImageGenerationRequest {
  readonly visualBrief: VisualBrief;
  readonly expectedInputHash: string;
  readonly signal?: AbortSignal;
}

export interface ImageGenerationResult {
  readonly providerId: string;
  readonly providerMode: MediaProviderMode;
  readonly model: string;
  readonly inputHash: string;
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly metadata: Readonly<{
    fixture: boolean;
    deterministic: boolean;
    networkUsed: boolean;
  }>;
}

export interface ImageGenerationProvider {
  readonly descriptor: ImageGenerationProviderDescriptor;
  generate(input: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

export interface MediaObjectStorePutInput {
  readonly tenantId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface MediaObjectStoreResult {
  readonly storageKey: string;
  readonly byteLength: number;
}

export interface MediaObjectStore {
  put(input: MediaObjectStorePutInput): Promise<MediaObjectStoreResult>;
  get(input: { readonly tenantId: string; readonly storageKey: string }): Promise<Uint8Array>;
}
