import {
  MediaProductionError,
  PexelsImageSearchProvider,
  WikimediaCommonsImageSearchProvider,
  type LicensedImageCandidate,
  type LicensedImageSearchProvider,
  type LicensedImageSearchProviderId,
  type NormalizedLicensedImage,
} from "@geo/media";

import type { RuntimeProviderConfigurationController } from "./runtime-provider-config.js";

const MEDIA_SEARCH_CONFIG_KEY = "media_search" as const;

interface MediaSearchProviderSettings {
  readonly provider: LicensedImageSearchProviderId;
  readonly apiKey?: string;
  readonly proxyUrl?: string;
}

export class RuntimeConfiguredMediaSearchProvider implements LicensedImageSearchProvider {
  readonly #store: RuntimeProviderConfigurationController;
  readonly #fallback: MediaSearchProviderSettings;
  #current: LicensedImageSearchProvider;
  #currentKey: string | null = null;

  constructor(options: {
    readonly store: RuntimeProviderConfigurationController;
    readonly fallback: MediaSearchProviderSettings;
  }) {
    this.#store = options.store;
    this.#fallback = options.fallback;
    this.#current = this.#buildProvider(this.#fallback);
  }

  get provider(): LicensedImageSearchProviderId {
    return this.#current.provider;
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly LicensedImageCandidate[]> {
    return (await this.#resolve()).search(input);
  }

  async downloadAndNormalize(input: {
    readonly candidate: LicensedImageCandidate;
    readonly aspectRatio?: Parameters<
      LicensedImageSearchProvider["downloadAndNormalize"]
    >[0]["aspectRatio"];
    readonly signal?: AbortSignal;
  }): Promise<NormalizedLicensedImage> {
    return (await this.#resolve()).downloadAndNormalize({
      candidate: input.candidate,
      ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async close(): Promise<void> {
    await closeProvider(this.#current);
  }

  async #resolve(): Promise<LicensedImageSearchProvider> {
    let document;
    try {
      document = await this.#store.getDocument({ includeSecrets: true });
    } catch {
      return this.#current;
    }
    const section = document.sections.find(
      (candidate) => candidate.configKey === MEDIA_SEARCH_CONFIG_KEY,
    );
    if (section === undefined || !section.enabled) return this.#current;
    const provider = section.provider;
    if (provider !== "wikimedia_commons" && provider !== "pexels") return this.#current;
    const apiKey = section.apiKey ?? null;
    if (provider === "pexels" && (apiKey === null || apiKey.length < 16)) {
      return this.#current;
    }
    const settings = section.settings as Readonly<Record<string, unknown>>;
    const configuredProxyUrl =
      typeof settings.proxyUrl === "string" && settings.proxyUrl.trim().length > 0
        ? settings.proxyUrl
        : undefined;
    const proxyUrl = configuredProxyUrl ?? this.#fallback.proxyUrl;
    const key = JSON.stringify({ provider, apiKey, proxyUrl });
    if (key === this.#currentKey) return this.#current;
    const next =
      provider === "pexels" && apiKey !== null
        ? new PexelsImageSearchProvider({ apiKey })
        : new WikimediaCommonsImageSearchProvider(proxyUrl === undefined ? {} : { proxyUrl });
    await closeProvider(this.#current);
    this.#current = next;
    this.#currentKey = key;
    return next;
  }

  #buildProvider(settings: MediaSearchProviderSettings): LicensedImageSearchProvider {
    if (settings.provider === "pexels") {
      if (settings.apiKey === undefined || settings.apiKey.length < 16) {
        throw new MediaProductionError(
          "MEDIA_SEARCH_PROVIDER_INVALID",
          "Pexels media search requires an API key",
        );
      }
      return new PexelsImageSearchProvider({ apiKey: settings.apiKey });
    }
    return new WikimediaCommonsImageSearchProvider(
      settings.proxyUrl === undefined ? {} : { proxyUrl: settings.proxyUrl },
    );
  }
}

async function closeProvider(provider: LicensedImageSearchProvider): Promise<void> {
  const candidate = provider as LicensedImageSearchProvider & {
    close?: () => Promise<void> | void;
  };
  await candidate.close?.();
}
