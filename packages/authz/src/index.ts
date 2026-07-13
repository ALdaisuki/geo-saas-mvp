import type { ActorContext, Capability, TenantRole } from "@geo/contracts";

const allCapabilities = [
  "tenant:read",
  "tenant:manage",
  "member:manage",
  "content:read",
  "content:write",
  "audit:read",
  "audit:run",
  "grant:revoke",
  "publish:request",
  "publish:cancel",
  "receipt:read",
  "visibility:read",
  "visibility:run",
  "automation:manage",
] as const satisfies readonly Capability[];

export const roleCapabilities: Readonly<Record<TenantRole, ReadonlySet<Capability>>> = {
  owner: new Set(allCapabilities),
  admin: new Set(allCapabilities),
  editor: new Set([
    "tenant:read",
    "content:read",
    "content:write",
    "audit:read",
    "audit:run",
    "receipt:read",
    "visibility:read",
    "visibility:run",
  ]),
  auditor: new Set([
    "tenant:read",
    "content:read",
    "audit:read",
    "audit:run",
    "receipt:read",
    "visibility:read",
  ]),
  publisher: new Set([
    "tenant:read",
    "content:read",
    "audit:read",
    "publish:request",
    "publish:cancel",
    "receipt:read",
    "visibility:read",
  ]),
  viewer: new Set(["tenant:read", "content:read", "audit:read", "receipt:read", "visibility:read"]),
};

export class AuthorizationError extends Error {
  public readonly code = "AUTHORIZATION_DENIED";

  public constructor(
    message: string,
    public readonly capability?: Capability,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function capabilitiesForRole(role: TenantRole): Capability[] {
  return [...roleCapabilities[role]];
}

export function hasCapability(
  actor: Pick<ActorContext, "capabilities">,
  capability: Capability,
): boolean {
  return actor.capabilities.includes(capability);
}

export function requireCapability(
  actor: Pick<ActorContext, "capabilities">,
  capability: Capability,
): void {
  if (!hasCapability(actor, capability)) {
    throw new AuthorizationError(`Missing capability: ${capability}`, capability);
  }
}

export function requireTenantScope(
  actor: Pick<ActorContext, "tenantId">,
  resourceTenantId: string,
): void {
  if (actor.tenantId !== resourceTenantId) {
    throw new AuthorizationError("Resource is outside the authenticated tenant scope");
  }
}

export function createActorCapabilities(role: TenantRole): Capability[] {
  return capabilitiesForRole(role);
}
