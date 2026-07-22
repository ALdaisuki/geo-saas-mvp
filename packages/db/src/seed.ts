import { buildBaselineAuditPolicyDocument, sha256Canonical } from "@geo/core";
import { travelQuerySetPromptsV1, travelQuerySetV1 } from "@geo/visibility";
import { sql, type Kysely } from "kysely";

import { withTenantTransaction, type TenantTransaction } from "./context.js";
import { defaultBrandAgentProfileDocument } from "./brand-agent-profile.js";
import type { Database } from "./types.js";

export const SEED_IDS = {
  zhongtong: {
    tenant: "10000000-0000-4000-8000-000000000001",
    actor: "10000000-0000-4000-8000-000000000101",
    workerPrincipal: "10000000-0000-4000-8000-000000000102",
    ctripBridgePrincipal: "10000000-0000-4000-8000-000000000103",
    membership: "10000000-0000-4000-8000-000000000201",
    brand: "10000000-0000-4000-8000-000000000301",
    brandAgentProfile: "10000000-0000-4000-8000-000000000302",
    hotline: "10000000-0000-4000-8000-000000000401",
    wechat3411: "10000000-0000-4000-8000-000000000402",
    wechat6431: "10000000-0000-4000-8000-000000000403",
    policy: "10000000-0000-4000-8000-000000000501",
    automation: "10000000-0000-4000-8000-000000000601",
    toutiao: "10000000-0000-4000-8000-000000000701",
    sohu: "10000000-0000-4000-8000-000000000702",
    ctrip: "10000000-0000-4000-8000-000000000703",
    querySet: "10000000-0000-4000-8000-000000000801",
    querySetVersion: "10000000-0000-4000-8000-000000000901",
    competitorCits: "10000000-0000-4000-8000-000000001001",
    competitorCyts: "10000000-0000-4000-8000-000000001002",
    competitorCaissa: "10000000-0000-4000-8000-000000001003",
  },
  synthetic: {
    tenant: "20000000-0000-4000-8000-000000000001",
    actor: "20000000-0000-4000-8000-000000000101",
    workerPrincipal: "20000000-0000-4000-8000-000000000102",
    membership: "20000000-0000-4000-8000-000000000201",
    brand: "20000000-0000-4000-8000-000000000301",
    brandAgentProfile: "20000000-0000-4000-8000-000000000302",
    contact: "20000000-0000-4000-8000-000000000401",
    policy: "20000000-0000-4000-8000-000000000501",
    automation: "20000000-0000-4000-8000-000000000601",
  },
} as const;

const SEEDED_AT = "2026-07-13T00:00:00.000Z";

function hashJson(value: unknown): string {
  return sha256Canonical(value);
}

async function seedIdentity(
  transaction: TenantTransaction,
  input: {
    actorId: string;
    email: string;
    membershipId: string;
    tenantId: string;
    slug: string;
    legalName: string;
    displayName: string;
  },
): Promise<void> {
  await sql`
    insert into geo.users (id, email, password_hash, display_name, status)
    values (${input.actorId}, ${input.email}, 'seed-disabled', ${input.displayName + " Seed Operator"}, 'disabled')
    on conflict (id) do update set
      email = excluded.email,
      display_name = excluded.display_name,
      status = 'disabled'
  `.execute(transaction);

  await sql`
    insert into geo.tenants (id, slug, legal_name, display_name, industry, status, default_locale)
    values (${input.tenantId}, ${input.slug}, ${input.legalName}, ${input.displayName}, 'travel', 'active', 'zh-CN')
    on conflict (id) do update set
      legal_name = excluded.legal_name,
      display_name = excluded.display_name,
      industry = excluded.industry,
      status = excluded.status
  `.execute(transaction);

  await sql`
    insert into geo.tenant_memberships (tenant_id, id, user_id, role, capabilities, status)
    values (
      ${input.tenantId}, ${input.membershipId}, ${input.actorId}, 'owner',
      '["tenant:read","tenant:manage","member:manage","principal:manage","content:read","content:write","audit:read","audit:run","grant:revoke","publish:request","publish:cancel","receipt:read","visibility:read","visibility:run","automation:manage","automation:execute"]'::jsonb,
      'active'
    )
    on conflict (tenant_id, user_id) do update set
      role = excluded.role,
      capabilities = excluded.capabilities,
      status = excluded.status
  `.execute(transaction);
}

async function seedWorkerPrincipal(
  transaction: TenantTransaction,
  tenantId: string,
  principalId: string,
): Promise<void> {
  await sql`
    insert into geo.service_principals (tenant_id, id, name, kind, status)
    values (${tenantId}, ${principalId}, 'fixture-publication-worker', 'worker', 'active')
    on conflict (tenant_id, id) do update set
      name = excluded.name,
      kind = excluded.kind,
      status = excluded.status,
      updated_at = clock_timestamp()
  `.execute(transaction);
}

export async function seedDatabase(database: Kysely<Database>): Promise<void> {
  const travelPolicy = buildBaselineAuditPolicyDocument({
    rulesVersion: "travel-v1",
    industry: "travel",
  });
  const travelPolicyJson = JSON.stringify(travelPolicy);
  const travelPolicyHash = hashJson(travelPolicy);

  const travelPrompts = travelQuerySetPromptsV1;
  const travelPackVersion = travelQuerySetV1.version;
  const travelPromptsJson = JSON.stringify(travelPrompts);
  const travelPromptsHash = hashJson(travelPrompts);
  const brandAgentProfileDocument = defaultBrandAgentProfileDocument();
  const brandAgentProfileDocumentJson = JSON.stringify(brandAgentProfileDocument);
  const brandAgentProfileDocumentHash = hashJson(brandAgentProfileDocument);

  await withTenantTransaction(
    database,
    {
      tenantId: SEED_IDS.zhongtong.tenant,
      actorId: SEED_IDS.zhongtong.actor,
      requestId: "seed:zhongtong:v1",
    },
    async (transaction) => {
      await seedIdentity(transaction, {
        actorId: SEED_IDS.zhongtong.actor,
        email: "seed-zhongtong@example.invalid",
        membershipId: SEED_IDS.zhongtong.membership,
        tenantId: SEED_IDS.zhongtong.tenant,
        slug: "zhongtong-international-travel",
        legalName: "中通国际旅行社",
        displayName: "中通国际旅行社",
      });
      await seedWorkerPrincipal(
        transaction,
        SEED_IDS.zhongtong.tenant,
        SEED_IDS.zhongtong.workerPrincipal,
      );

      await sql`
        insert into geo.brands (tenant_id, id, canonical_name, display_name, aliases, description, industry, is_primary)
        values (${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.brand}, 'Zhongtong International Travel Agency', '中通国际旅行社', '["中通国旅"]'::jsonb, '首个旅行行业 GEO 租户', 'travel', true)
        on conflict (id) do update set display_name = excluded.display_name, aliases = excluded.aliases, is_primary = true
      `.execute(transaction);

      await sql`
        insert into geo.brand_agent_profiles (
          tenant_id, id, brand_id, version, status, document, document_hash,
          created_by_actor_id, effective_at
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.brandAgentProfile},
          ${SEED_IDS.zhongtong.brand}, 1, 'active', ${brandAgentProfileDocumentJson}::jsonb,
          ${brandAgentProfileDocumentHash}, ${SEED_IDS.zhongtong.actor}, ${SEEDED_AT}
        ) on conflict (id) do nothing
      `.execute(transaction);

      const competitors = [
        [
          SEED_IDS.zhongtong.competitorCits,
          "China International Travel Service",
          "中国国旅",
          ["国旅"],
        ],
        [SEED_IDS.zhongtong.competitorCyts, "China Youth Travel Service", "中青旅", ["CYTS"]],
        [SEED_IDS.zhongtong.competitorCaissa, "Caissa Tourism", "凯撒旅游", ["凯撒旅业"]],
      ] as const;
      for (const [id, canonicalName, displayName, aliases] of competitors) {
        await sql`
          insert into geo.brand_competitors (
            tenant_id, id, brand_id, canonical_name, display_name, aliases,
            source_type, source_ref, valid_from
          ) values (
            ${SEED_IDS.zhongtong.tenant}, ${id}, ${SEED_IDS.zhongtong.brand},
            ${canonicalName}, ${displayName}, ${JSON.stringify(aliases)}::jsonb,
            'tenant_configured', 'seed:zhongtong:competitors:v1', ${SEEDED_AT}
          ) on conflict (tenant_id, brand_id, canonical_name) do update set
            display_name = excluded.display_name,
            aliases = excluded.aliases,
            source_type = excluded.source_type,
            source_ref = excluded.source_ref,
            valid_until = null
        `.execute(transaction);
      }

      const contacts = [
        [SEED_IDS.zhongtong.hotline, "phone", "24小时热线", "4001133986", true],
        [SEED_IDS.zhongtong.wechat3411, "wechat", "微信咨询一", "ZTGL3411", true],
        [SEED_IDS.zhongtong.wechat6431, "wechat", "微信咨询二", "ZTGL6431", false],
      ] as const;
      for (const [id, type, label, value, isPrimary] of contacts) {
        await sql`
          insert into geo.tenant_contacts (
            tenant_id, id, type, label, value, normalized_value, is_primary, valid_from, metadata
          ) values (
            ${SEED_IDS.zhongtong.tenant}, ${id}, ${type}, ${label}, ${value}, ${value}, ${isPrimary}, ${SEEDED_AT},
            '{"source":"partner-confirmed-seed","version":1}'::jsonb
          )
          on conflict (id) do update set
            label = excluded.label, value = excluded.value,
            normalized_value = excluded.normalized_value, is_primary = excluded.is_primary
        `.execute(transaction);
      }

      await sql`
        insert into geo.policy_bundles (
          tenant_id, id, version, status, policy_hash, document, effective_at
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.policy}, 'travel-v1', 'active',
          ${travelPolicyHash}, ${travelPolicyJson}::jsonb, ${SEEDED_AT}
        ) on conflict (id) do nothing
      `.execute(transaction);

      await sql`
        insert into geo.automation_controls (
          tenant_id, id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.automation}, 'tenant', '*', 'shadow',
          '{"maxConcurrent":1,"perMinute":10,"perDay":100,"cooldownSeconds":0,"errorBudget":5}'::jsonb,
          false, 'MVP starts in shadow mode'
        ) on conflict (tenant_id, scope_type, scope_key) do update set
          mode = CASE
            WHEN geo.automation_controls.mode = 'unattended' THEN geo.automation_controls.mode
            ELSE 'shadow'
          END,
          kill_switch_enabled = false
      `.execute(transaction);

      const accounts = [
        [SEED_IDS.zhongtong.toutiao, "toutiao", "中通国旅-头条号-Dry Run"],
        [SEED_IDS.zhongtong.sohu, "sohu", "中通国旅-搜狐号-Dry Run"],
        [SEED_IDS.zhongtong.ctrip, "ctrip_community", "中通国旅-携程社区-Dry Run"],
      ] as const;
      for (const [id, platform, displayName] of accounts) {
        await sql`
          insert into geo.channel_accounts (
            tenant_id, id, platform, display_name, capability,
            supported_execution_levels, capability_evidence_type,
            capability_evidence_refs, status
          ) values (
            ${SEED_IDS.zhongtong.tenant}, ${id}, ${platform}, ${displayName}, 'manual_only',
            ARRAY['dry_run']::text[], 'preview', '["seed:dry-run-only"]'::jsonb, 'active'
          ) on conflict (id) do update set
            capability = CASE
              WHEN geo.channel_accounts.capability = 'browser_assisted'
                THEN geo.channel_accounts.capability
              ELSE 'manual_only'
            END,
            supported_execution_levels = CASE
              WHEN geo.channel_accounts.capability = 'browser_assisted'
                THEN geo.channel_accounts.supported_execution_levels
              ELSE ARRAY['dry_run']::text[]
            END,
            capability_evidence_type = CASE
              WHEN geo.channel_accounts.capability = 'browser_assisted'
                THEN geo.channel_accounts.capability_evidence_type
              ELSE 'preview'
            END,
            capability_evidence_refs = CASE
              WHEN geo.channel_accounts.capability = 'browser_assisted'
                THEN geo.channel_accounts.capability_evidence_refs
              ELSE '["seed:dry-run-only"]'::jsonb
            END,
            status = 'active'
        `.execute(transaction);
      }

      await sql`
        insert into geo.query_sets (
          tenant_id, id, name, industry, status, current_version, description
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.querySet},
          '旅行 GEO 基准问题集', 'travel', 'active', 1,
          ${`豆包与千问独立评测，不使用 Google 排名作为代理指标；travelQuerySetV1 ${travelPackVersion}`}
        ) on conflict (id) do update set status = 'active', current_version = 1
      `.execute(transaction);

      await sql`
        insert into geo.query_set_versions (
          tenant_id, id, query_set_id, version, prompts, prompt_hash, created_by_actor_id
        ) values (
          ${SEED_IDS.zhongtong.tenant}, ${SEED_IDS.zhongtong.querySetVersion},
          ${SEED_IDS.zhongtong.querySet}, 1, ${travelPromptsJson}::jsonb,
          ${travelPromptsHash}, ${SEED_IDS.zhongtong.actor}
        ) on conflict (id) do nothing
      `.execute(transaction);
    },
  );

  await withTenantTransaction(
    database,
    {
      tenantId: SEED_IDS.synthetic.tenant,
      actorId: SEED_IDS.synthetic.actor,
      requestId: "seed:synthetic:v1",
    },
    async (transaction) => {
      await seedIdentity(transaction, {
        actorId: SEED_IDS.synthetic.actor,
        email: "seed-isolation@example.invalid",
        membershipId: SEED_IDS.synthetic.membership,
        tenantId: SEED_IDS.synthetic.tenant,
        slug: "synthetic-isolation-travel",
        legalName: "Synthetic Isolation Travel Ltd.",
        displayName: "隔离测试旅行社",
      });
      await seedWorkerPrincipal(
        transaction,
        SEED_IDS.synthetic.tenant,
        SEED_IDS.synthetic.workerPrincipal,
      );

      await sql`
        insert into geo.brands (tenant_id, id, canonical_name, display_name, aliases, industry, is_primary)
        values (${SEED_IDS.synthetic.tenant}, ${SEED_IDS.synthetic.brand}, 'Synthetic Isolation Travel', '隔离测试旅行社', '[]'::jsonb, 'travel', true)
        on conflict (id) do update set is_primary = true
      `.execute(transaction);

      await sql`
        insert into geo.brand_agent_profiles (
          tenant_id, id, brand_id, version, status, document, document_hash,
          created_by_actor_id, effective_at
        ) values (
          ${SEED_IDS.synthetic.tenant}, ${SEED_IDS.synthetic.brandAgentProfile},
          ${SEED_IDS.synthetic.brand}, 1, 'active', ${brandAgentProfileDocumentJson}::jsonb,
          ${brandAgentProfileDocumentHash}, ${SEED_IDS.synthetic.actor}, ${SEEDED_AT}
        ) on conflict (id) do nothing
      `.execute(transaction);

      await sql`
        insert into geo.tenant_contacts (
          tenant_id, id, type, label, value, normalized_value, is_primary, valid_from, metadata
        ) values (
          ${SEED_IDS.synthetic.tenant}, ${SEED_IDS.synthetic.contact}, 'phone', '隔离测试电话',
          '4000000000', '4000000000', true, ${SEEDED_AT}, '{"synthetic":true}'::jsonb
        ) on conflict (id) do nothing
      `.execute(transaction);

      await sql`
        insert into geo.policy_bundles (
          tenant_id, id, version, status, policy_hash, document, effective_at
        ) values (
          ${SEED_IDS.synthetic.tenant}, ${SEED_IDS.synthetic.policy}, 'travel-v1', 'active',
          ${travelPolicyHash}, ${travelPolicyJson}::jsonb, ${SEEDED_AT}
        ) on conflict (id) do nothing
      `.execute(transaction);

      await sql`
        insert into geo.automation_controls (
          tenant_id, id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
        ) values (
          ${SEED_IDS.synthetic.tenant}, ${SEED_IDS.synthetic.automation}, 'tenant', '*', 'shadow',
          '{"maxConcurrent":1,"perMinute":10,"perDay":100,"cooldownSeconds":0,"errorBudget":5}'::jsonb,
          false, 'Synthetic isolation tenant'
        ) on conflict (tenant_id, scope_type, scope_key) do update set mode = 'shadow'
      `.execute(transaction);
    },
  );
}
