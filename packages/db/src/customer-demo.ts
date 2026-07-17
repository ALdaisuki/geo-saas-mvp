import { ctripBridgeCapabilities } from "@geo/authz";
import { sha256Canonical } from "@geo/core";
import { sql, type Kysely } from "kysely";

import { withTenantTransaction } from "./context.js";
import { SEED_IDS } from "./seed.js";
import type { Database } from "./types.js";

export async function configureCustomerDemo(database: Kysely<Database>): Promise<void> {
  await withTenantTransaction(
    database,
    {
      tenantId: SEED_IDS.zhongtong.tenant,
      actorId: SEED_IDS.zhongtong.actor,
      requestId: "customer-demo:ctrip:v1",
    },
    async (transaction) => {
      await sql`
        insert into geo.service_principals (
          tenant_id, id, name, kind, profile, capabilities, status
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.ctripBridgePrincipal},
          'customer-demo-ctrip-bridge', 'integration', 'ctrip_bridge',
          ${JSON.stringify(ctripBridgeCapabilities)}::jsonb, 'active'
        ) on conflict (tenant_id, id) do update set
          name = excluded.name,
          kind = excluded.kind,
          profile = excluded.profile,
          capabilities = excluded.capabilities,
          status = excluded.status,
          updated_at = clock_timestamp()
      `.execute(transaction);

      const account = await sql<{ id: string }>`
        update geo.channel_accounts set
          display_name = '中通国旅-携程社区-本地演示',
          capability = 'browser_assisted',
          supported_execution_levels = ARRAY['dry_run', 'assisted']::text[],
          capability_evidence_type = 'preview',
          capability_evidence_refs = '["customer-demo:ctrip-simulator-v1"]'::jsonb,
          status = 'active',
          last_verified_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where tenant_id = ${SEED_IDS.zhongtong.tenant}
          and id = ${SEED_IDS.zhongtong.ctrip}
        returning id
      `.execute(transaction);
      if (account.rows.length !== 1) {
        throw new Error("Seeded Ctrip account was not found for customer demo configuration");
      }

      const after = {
        deploymentProfile: "customer_demo",
        accountId: SEED_IDS.zhongtong.ctrip,
        bridgePrincipalId: SEED_IDS.zhongtong.ctripBridgePrincipal,
        executionLevels: ["dry_run", "assisted"],
        externalPublishingEnabled: false,
      };
      await sql`
        insert into geo.audit_log (
          tenant_id, actor_id, action, resource_type, resource_id,
          request_id, before_hash, after_hash, details
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.actor},
          'customer_demo.configured', 'channel_account', ${SEED_IDS.zhongtong.ctrip},
          'customer-demo:ctrip:v1', null, ${sha256Canonical(after)},
          ${JSON.stringify(after)}::jsonb
        )
      `.execute(transaction);
    },
  );
}
