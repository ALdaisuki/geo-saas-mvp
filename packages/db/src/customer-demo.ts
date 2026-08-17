import { ctripBridgeCapabilities } from "@geo/authz";
import { sha256Canonical } from "@geo/core";
import { sql, type Kysely } from "kysely";

import { withTenantTransaction } from "./context.js";
import { SEED_IDS } from "./seed.js";
import type { Database } from "./types.js";

export async function configureCustomerDemo(database: Kysely<Database>): Promise<void> {
  const adapterVersion =
    process.env.CTRIP_CUSTOMER_ADAPTER_VERSION ?? "ctrip-community-simulator-v1";
  const unattended = adapterVersion === "ctrip-community-browser-unattended-v1";
  const executionLevels = unattended
    ? ["dry_run", "assisted", "unattended"]
    : ["dry_run", "assisted"];
  const evidenceType = unattended ? "platform_readback" : "preview";
  const evidenceRefs = unattended
    ? ["adapter:ctrip-community-browser-unattended-v1", "customer-demo:ctrip-browser-unattended-v1"]
    : ["customer-demo:ctrip-simulator-v1"];
  await withTenantTransaction(
    database,
    {
      tenantId: SEED_IDS.sampleTravel.tenant,
      actorId: SEED_IDS.sampleTravel.actor,
      requestId: "customer-demo:ctrip:v1",
    },
    async (transaction) => {
      await sql`
        insert into geo.service_principals (
          tenant_id, id, name, kind, profile, capabilities, status
        ) values (
          ${SEED_IDS.sampleTravel.tenant}, ${SEED_IDS.sampleTravel.ctripBridgePrincipal},
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
          display_name = '示例旅服-携程社区-本地演示',
          capability = 'browser_assisted',
          supported_execution_levels = ${executionLevels}::text[],
          capability_evidence_type = ${evidenceType},
          capability_evidence_refs = ${JSON.stringify(evidenceRefs)}::jsonb,
          status = 'active',
          last_verified_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where tenant_id = ${SEED_IDS.sampleTravel.tenant}
          and id = ${SEED_IDS.sampleTravel.ctrip}
          and archived_at is null
        returning id
      `.execute(transaction);
      if (account.rows.length !== 1) {
        throw new Error("Seeded Ctrip account was not found for customer demo configuration");
      }

      const automationControl = await sql<{ id: string }>`
        update geo.automation_controls set
          mode = ${unattended ? "unattended" : "supervised"},
          kill_switch_enabled = false,
          reason = ${
            unattended
              ? "Customer demo enables reviewed Ctrip unattended browser publication with one-time submit and public readback gates"
              : "Customer demo permits governed assisted handoffs; final submit remains operator-confirmed"
          },
          updated_at = clock_timestamp()
        where tenant_id = ${SEED_IDS.sampleTravel.tenant}
          and scope_type = 'tenant'
          and scope_key = '*'
        returning id
      `.execute(transaction);
      if (automationControl.rows.length !== 1) {
        throw new Error(
          "Seeded tenant automation control was not found for customer demo configuration",
        );
      }

      const after = {
        deploymentProfile: "customer_demo",
        accountId: SEED_IDS.sampleTravel.ctrip,
        bridgePrincipalId: SEED_IDS.sampleTravel.ctripBridgePrincipal,
        executionLevels,
        automationMode: unattended ? "unattended" : "supervised",
        externalPublishingEnabled: unattended,
        adapterVersion,
      };
      await sql`
        insert into geo.audit_log (
          tenant_id, actor_id, action, resource_type, resource_id,
          request_id, before_hash, after_hash, details
        ) values (
          ${SEED_IDS.sampleTravel.tenant}, ${SEED_IDS.sampleTravel.actor},
          'customer_demo.configured', 'channel_account', ${SEED_IDS.sampleTravel.ctrip},
          'customer-demo:ctrip:v1', null, ${sha256Canonical(after)},
          ${JSON.stringify(after)}::jsonb
        )
      `.execute(transaction);
    },
  );
}
