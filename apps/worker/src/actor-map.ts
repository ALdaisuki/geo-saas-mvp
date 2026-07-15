const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkerTenantActors(raw: string): Readonly<Record<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("WORKER_TENANT_ACTORS_JSON must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("WORKER_TENANT_ACTORS_JSON must be a tenant-to-actor object");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new TypeError("WORKER_TENANT_ACTORS_JSON must contain at least one tenant mapping");
  }
  const result: Record<string, string> = {};
  for (const [tenantId, actorId] of entries) {
    if (
      !UUID_PATTERN.test(tenantId) ||
      typeof actorId !== "string" ||
      !UUID_PATTERN.test(actorId)
    ) {
      throw new TypeError("WORKER_TENANT_ACTORS_JSON keys and values must be UUIDs");
    }
    const normalizedTenantId = tenantId.toLowerCase();
    const normalizedActorId = actorId.toLowerCase();
    if (
      result[normalizedTenantId] !== undefined &&
      result[normalizedTenantId] !== normalizedActorId
    ) {
      throw new TypeError("WORKER_TENANT_ACTORS_JSON contains conflicting tenant mappings");
    }
    result[normalizedTenantId] = normalizedActorId;
  }
  return Object.freeze(result);
}
