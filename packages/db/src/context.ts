import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TenantTransactionContext {
  tenantId: string;
  actorId: string;
  requestId?: string;
}

export type TenantTransaction = Transaction<Database>;

function assertUuid(name: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

export async function setTenantContext(
  transaction: TenantTransaction,
  context: TenantTransactionContext,
): Promise<void> {
  assertUuid("tenantId", context.tenantId);
  assertUuid("actorId", context.actorId);

  await sql`
    select
      set_config('app.tenant_id', ${context.tenantId}, true),
      set_config('app.actor_id', ${context.actorId}, true),
      set_config('app.request_id', ${context.requestId ?? ""}, true)
  `.execute(transaction);
}

export async function withTenantTransaction<T>(
  database: Kysely<Database>,
  context: TenantTransactionContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction: TenantTransaction) => {
    await setTenantContext(transaction, context);
    return operation(transaction);
  });
}
