import { randomUUID } from "node:crypto";

import { capabilitiesForRole } from "@geo/authz";
import { sql, type Kysely } from "kysely";

import type { Database } from "./types.js";

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface BootstrapOperatorEnvironment {
  readonly connectionString: string;
  readonly tenantSlug: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export interface BootstrapOperatorInput {
  readonly tenantSlug: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

export interface BootstrapOperatorResult {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipId: string;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function loadBootstrapOperatorEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BootstrapOperatorEnvironment {
  const connectionString = requiredEnvironment(environment, "DATABASE_ADMIN_URL");
  const tenantSlug = requiredEnvironment(environment, "GEO_BOOTSTRAP_TENANT_SLUG");
  const email = requiredEnvironment(environment, "GEO_BOOTSTRAP_EMAIL").toLowerCase();
  const displayName = requiredEnvironment(environment, "GEO_BOOTSTRAP_DISPLAY_NAME");
  const password = requiredEnvironment(environment, "GEO_BOOTSTRAP_PASSWORD");

  if (!TENANT_SLUG.test(tenantSlug)) throw new Error("GEO_BOOTSTRAP_TENANT_SLUG is invalid");
  if (!EMAIL.test(email) || email.length > 320) throw new Error("GEO_BOOTSTRAP_EMAIL is invalid");
  if (displayName.length > 200) throw new Error("GEO_BOOTSTRAP_DISPLAY_NAME is too long");
  if (password.length < 16 || password.length > 1_024) {
    throw new Error("GEO_BOOTSTRAP_PASSWORD must contain between 16 and 1024 characters");
  }
  const url = new URL(connectionString);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }

  return { connectionString, tenantSlug, email, displayName, password };
}

export async function bootstrapOperator(
  database: Kysely<Database>,
  input: BootstrapOperatorInput,
): Promise<BootstrapOperatorResult> {
  return database.transaction().execute(async (transaction) => {
    const tenant = await sql<{ id: string }>`
      select id
      from geo.tenants
      where slug = ${input.tenantSlug} and status = 'active'
    `.execute(transaction);
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error("Active bootstrap tenant was not found");

    const existingUser = await sql<{ id: string }>`
      select id from geo.users where lower(email) = ${input.email}
    `.execute(transaction);
    const userId = existingUser.rows[0]?.id ?? randomUUID();
    await sql`
      insert into geo.users (id, email, password_hash, display_name, status)
      values (${userId}, ${input.email}, ${input.passwordHash}, ${input.displayName}, 'active')
      on conflict (id) do update set
        email = excluded.email,
        password_hash = excluded.password_hash,
        display_name = excluded.display_name,
        status = 'active',
        updated_at = clock_timestamp()
    `.execute(transaction);

    const existingMembership = await sql<{ id: string }>`
      select id
      from geo.tenant_memberships
      where tenant_id = ${tenantId} and user_id = ${userId}
    `.execute(transaction);
    const membershipId = existingMembership.rows[0]?.id ?? randomUUID();
    const capabilities = JSON.stringify(capabilitiesForRole("owner"));
    await sql`
      insert into geo.tenant_memberships (
        tenant_id, id, user_id, role, capabilities, status
      ) values (
        ${tenantId}, ${membershipId}, ${userId}, 'owner', ${capabilities}::jsonb, 'active'
      )
      on conflict (tenant_id, user_id) do update set
        role = excluded.role,
        capabilities = excluded.capabilities,
        status = 'active'
    `.execute(transaction);

    return { tenantId, userId, membershipId };
  });
}
