import { PRIMARY_DISTRIBUTION_PLATFORMS, type Platform } from "@geo/contracts";

import { ConnectorPolicyError } from "./capabilities.js";
import { DryRunConnector, isDryRunOnlyConnector } from "./dry-run-connector.js";
import { assertGitHubSourcedOutboundManifest } from "./outbound-source-provenance.js";
import type { GitHubSourcedPlatformConnector, PlatformConnector } from "./types.js";

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
    platform: "baijiahao",
    displayName: "百家号",
    manualInstructions: [
      "登录已授权的百家号创作平台。",
      "逐项核对 manifest.json 中的平台、账号、payloadHash 与 auditHash。",
      "粘贴 article.md，人工处理登录或验证挑战，并在平台界面执行最终发布。",
      "发布后通过独立 readback 流程导入平台 URL；本预览包本身不是发布回执。",
    ],
  },
  {
    platform: "netease",
    displayName: "网易号",
    manualInstructions: [
      "登录已授权的网易号创作平台。",
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
  {
    platform: "zhihu",
    displayName: "知乎专栏",
    manualInstructions: [
      "登录已授权的知乎专栏创作界面。",
      "逐项核对 manifest.json 中的平台、账号、payloadHash 与 auditHash。",
      "核对封面、正文图片和正文后，在知乎编辑器中执行最终发布。",
      "发布后通过独立 readback 流程导入知乎专栏公开 URL；本预览包本身不是发布回执。",
    ],
  },
] as const;

function assertOutboundSourceProvenance(
  connector: PlatformConnector,
): asserts connector is DryRunConnector | GitHubSourcedPlatformConnector {
  const manifest = (connector as { readonly outboundImplementation?: unknown })
    .outboundImplementation;
  if (isDryRunOnlyConnector(connector) && manifest === undefined) return;
  if (manifest === undefined || manifest === null || typeof manifest !== "object") {
    throw new ConnectorPolicyError(
      "OUTBOUND_SOURCE_EVIDENCE_REQUIRED",
      `${connector.platform} connector requires pinned GitHub outbound implementation sources`,
      { platform: connector.platform },
    );
  }
  const outboundImplementation =
    manifest as GitHubSourcedPlatformConnector["outboundImplementation"];
  if (outboundImplementation.platform !== connector.platform) {
    throw new ConnectorPolicyError(
      "OUTBOUND_SOURCE_EVIDENCE_REQUIRED",
      "GitHub source manifest platform must match its connector",
      { platform: connector.platform },
    );
  }
  assertGitHubSourcedOutboundManifest(outboundImplementation);
}

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
    assertOutboundSourceProvenance(connector);
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
  readonly primaryDistribution?: readonly GitHubSourcedPlatformConnector[] | undefined;
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
  const primaryOverrides = new Map<Platform, GitHubSourcedPlatformConnector>();
  for (const connector of options.primaryDistribution ?? []) {
    if (!PRIMARY_DISTRIBUTION_PLATFORMS.some((platform) => platform === connector.platform)) {
      throw new TypeError("GitHub-sourced primary connector must target a distribution platform");
    }
    if (primaryOverrides.has(connector.platform)) {
      throw new TypeError(`Primary connector override is duplicated for ${connector.platform}`);
    }
    primaryOverrides.set(connector.platform, connector);
  }
  return new ConnectorRegistry(
    definitions.map(
      (definition) =>
        primaryOverrides.get(definition.platform) ??
        (definition.platform === "ctrip_community" && options.ctripCommunity !== undefined
          ? options.ctripCommunity
          : new DryRunConnector(definition)),
    ),
  );
}
