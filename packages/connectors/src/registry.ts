import type { Platform } from "@geo/contracts";

import { DryRunConnector } from "./dry-run-connector.js";
import type { PlatformConnector } from "./types.js";

const definitions = [
  {
    platform: "toutiao",
    displayName: "头条号",
    manualInstructions: [
      "登录已授权的头条号创作平台。",
      "逐项核对 manifest.json 中的平台、账号、payloadHash 与 auditHash。",
      "粘贴 article.md，人工处理登录或验证挑战，并在平台界面执行最终发布。",
      "发布后通过独立 readback 流程导入平台 URL；本预览包本身不是发布回执。",
    ],
  },
  {
    platform: "sohu",
    displayName: "搜狐号",
    manualInstructions: [
      "登录已授权的搜狐号创作平台。",
      "逐项核对 manifest.json 中的平台、账号、payloadHash 与 auditHash。",
      "粘贴 article.md，人工处理登录或验证挑战，并在平台界面执行最终发布。",
      "发布后通过独立 readback 流程导入平台 URL；本预览包本身不是发布回执。",
    ],
  },
  {
    platform: "ctrip_community",
    displayName: "携程社区",
    manualInstructions: [
      "登录已授权的携程社区创作者界面。",
      "逐项核对 manifest.json 中的平台、账号、payloadHash 与 auditHash。",
      "粘贴 article.md，人工处理登录或验证挑战，并在平台界面执行最终发布。",
      "发布后通过独立 readback 流程导入平台 URL；本预览包本身不是发布回执。",
    ],
  },
] as const;

export class ConnectorRegistry {
  readonly #connectors = new Map<Platform, PlatformConnector>();

  constructor(connectors: readonly PlatformConnector[] = []) {
    for (const connector of connectors) {
      this.register(connector);
    }
  }

  register(connector: PlatformConnector): void {
    if (this.#connectors.has(connector.platform)) {
      throw new Error(`Connector already registered for ${connector.platform}`);
    }
    this.#connectors.set(connector.platform, connector);
  }

  get(platform: Platform): PlatformConnector {
    const connector = this.#connectors.get(platform);
    if (connector === undefined) {
      throw new Error(`No connector registered for ${platform}`);
    }
    return connector;
  }

  list(): readonly PlatformConnector[] {
    return [...this.#connectors.values()];
  }
}

export interface DefaultConnectorRegistryOptions {
  readonly ctripCommunity?: PlatformConnector | undefined;
}

export function createDefaultConnectorRegistry(
  options: DefaultConnectorRegistryOptions = {},
): ConnectorRegistry {
  if (
    options.ctripCommunity !== undefined &&
    options.ctripCommunity.platform !== "ctrip_community"
  ) {
    throw new TypeError("Ctrip registry override must target ctrip_community");
  }
  return new ConnectorRegistry(
    definitions.map((definition) =>
      definition.platform === "ctrip_community" && options.ctripCommunity !== undefined
        ? options.ctripCommunity
        : new DryRunConnector(definition),
    ),
  );
}
