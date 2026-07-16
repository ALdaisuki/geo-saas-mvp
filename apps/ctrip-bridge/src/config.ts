import { z } from "zod";

const tenantConfigSchema = z.strictObject({
  tenantId: z.string().uuid(),
  bridgePrincipalId: z.string().uuid(),
  accessToken: z.string().min(32).max(4_096),
});

export type CtripBridgeTenantConfig = z.infer<typeof tenantConfigSchema>;

export function parseCtripBridgeTenantConfigs(value: string): readonly CtripBridgeTenantConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("CTRIP_BRIDGE_TENANTS_JSON must be valid JSON");
  }
  const tenants = z.array(tenantConfigSchema).min(1).max(1_000).parse(parsed);
  const tenantIds = new Set<string>();
  const principalIds = new Set<string>();
  const tokens = new Set<string>();
  for (const tenant of tenants) {
    if (
      tenantIds.has(tenant.tenantId) ||
      principalIds.has(tenant.bridgePrincipalId) ||
      tokens.has(tenant.accessToken)
    ) {
      throw new TypeError("Ctrip bridge tenant, principal and token values must be unique");
    }
    tenantIds.add(tenant.tenantId);
    principalIds.add(tenant.bridgePrincipalId);
    tokens.add(tenant.accessToken);
  }
  return tenants;
}

export function requireSimulatorHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(normalized)) {
    throw new TypeError("Ctrip simulator bridge must bind to a loopback host");
  }
  return normalized;
}
