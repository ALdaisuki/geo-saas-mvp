import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

const expectedTables = [
  "users",
  "tenants",
  "tenant_memberships",
  "service_principals",
  "api_keys",
  "sessions",
  "brands",
  "brand_agent_profiles",
  "brand_competitors",
  "tenant_contacts",
  "policy_bundles",
  "automation_controls",
  "automation_distribution_cursors",
  "automation_template_rotation_cursors",
  "automation_batches",
  "automation_runs",
  "automation_run_targets",
  "channel_accounts",
  "ctrip_account_runtime_bindings",
  "ctrip_account_analytics_snapshots",
  "ctrip_account_analytics_sync_state",
  "campaigns",
  "campaign_automation_plans",
  "claim_facts",
  "evidence_sources",
  "research_source_policies",
  "research_capture_records",
  "content_items",
  "content_versions",
  "manual_media_reviews",
  "media_generation_jobs",
  "media_generation_attempts",
  "media_assets",
  "content_media_bindings",
  "media_inspections",
  "publication_variants",
  "historical_publications",
  "audit_runs",
  "audit_artifacts",
  "publication_grants",
  "audit_log",
  "publication_jobs",
  "publication_attempts",
  "publication_receipts",
  "publication_readbacks",
  "publication_assisted_handoffs",
  "ctrip_phase_b_canaries",
  "outbox_events",
  "inbox_events",
  "idempotency_records",
  "circuit_breakers",
  "query_sets",
  "query_set_versions",
  "visibility_runs",
  "visibility_observations",
  "visibility_metrics",
  "tenant_provisioning_receipts",
  "ctrip_bridge_commissioning_receipts",
] as const;

const tenantTables = expectedTables.filter(
  (tableName) =>
    tableName !== "users" &&
    tableName !== "tenants" &&
    tableName !== "tenant_provisioning_receipts" &&
    tableName !== "ctrip_bridge_commissioning_receipts",
);

let migrationSql = "";

beforeAll(async () => {
  const files = (await readdir(migrationDirectory))
    .filter((fileName) => /^\d{4}_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();
  migrationSql = (
    await Promise.all(
      files.map((fileName) => readFile(`${migrationDirectory}/${fileName}`, "utf8")),
    )
  ).join("\n");
});

function tableDefinition(tableName: string): string {
  const match = migrationSql.match(
    new RegExp(`CREATE TABLE geo\\.${tableName} \\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(match, `missing CREATE TABLE for ${tableName}`).not.toBeNull();
  return match?.[1] ?? "";
}

function functionDefinition(functionName: string): string {
  const start = migrationSql.indexOf(`CREATE OR REPLACE FUNCTION geo.${functionName}`);
  expect(start, `missing function ${functionName}`).toBeGreaterThanOrEqual(0);
  const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + 1);
  return migrationSql.slice(start, next === -1 ? undefined : next);
}

function latestFunctionDefinition(functionName: string): string {
  const marker = `CREATE OR REPLACE FUNCTION geo.${functionName}`;
  const start = migrationSql.lastIndexOf(marker);
  expect(start, `missing function ${functionName}`).toBeGreaterThanOrEqual(0);
  const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + marker.length);
  return migrationSql.slice(start, next === -1 ? undefined : next);
}

function functionOverloadDefinition(functionName: string, signatureFragment: string): string {
  const marker = `CREATE OR REPLACE FUNCTION geo.${functionName}`;
  let start = migrationSql.indexOf(marker);
  while (start !== -1) {
    const next = migrationSql.indexOf("CREATE OR REPLACE FUNCTION geo.", start + marker.length);
    const definition = migrationSql.slice(start, next === -1 ? undefined : next);
    if (definition.includes(signatureFragment)) return definition;
    start = migrationSql.indexOf(marker, start + marker.length);
  }
  expect.fail(`missing ${functionName} overload containing ${signatureFragment}`);
}

describe("PostgreSQL migration contract", () => {
  it("records a creator-confirmed retained draft as a terminal non-delivery without public readback", async () => {
    const retainedDraftSql = await readFile(
      new URL("../migrations/0135_netease_draft_retained_submit_semantics.sql", import.meta.url),
      "utf8",
    );
    const submit = latestFunctionDefinition("record_publication_assisted_submit_observation");
    const transition = latestFunctionDefinition("enforce_publication_assisted_handoff_transition");
    const terminal = latestFunctionDefinition("sync_ctrip_handoff_terminal_job");

    expect(retainedDraftSql).toContain("'not_accepted'");
    expect(retainedDraftSql).toContain("publication_assisted_handoff_delivery_evidence_complete");
    expect(retainedDraftSql).toContain("ASSISTED_SUBMIT_NOT_ACCEPTED_DRAFT_RETAINED");
    expect(submit).toContain(
      "p_outcome NOT IN ('accepted', 'uncertain', 'rejected', 'not_accepted')",
    );
    expect(submit).toContain("p_outcome = 'not_accepted'");
    expect(submit).toContain("state = 'needs_review'");
    expect(submit).toContain("RETURN QUERY SELECT NULL::uuid, NULL::uuid");
    expect(submit).not.toContain(
      "readback_value := gen_random_uuid();\n    IF p_outcome = 'not_accepted'",
    );
    expect(transition).toContain(
      "(OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('session_required', 'challenge_required', 'submitted_unconfirmed', 'needs_review', 'cancelled', 'expired', 'failed'))",
    );
    expect(terminal).toContain("NEW.submit_outcome = 'not_accepted'");
    expect(terminal).toContain("ASSISTED_SUBMIT_NOT_ACCEPTED_DRAFT_RETAINED");
    expect(terminal).toContain("WHEN retained_draft THEN 'failed'");
    expect(terminal).toContain("WHEN retained_draft THEN 'permanent_failure'");
    expect(retainedDraftSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(",
    );
  });

  it("preserves prepared browser recovery transitions after retained-draft semantics", () => {
    const transition = latestFunctionDefinition("enforce_publication_assisted_handoff_transition");

    expect(transition).toContain(
      "(OLD.state = 'draft_prepared' AND NEW.state IN ('session_required', 'challenge_required', 'awaiting_operator_submit', 'cancelled', 'expired', 'failed'))",
    );
    expect(transition).toContain(
      "(OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('session_required', 'challenge_required', 'submitted_unconfirmed', 'needs_review', 'cancelled', 'expired', 'failed'))",
    );
  });

  it("recovers expired pre-submit handoffs without treating asynchronous readback as a delivery retry", async () => {
    const recoverySql = await readFile(
      new URL("../migrations/0134_recover_expired_pre_submit_handoffs.sql", import.meta.url),
      "utf8",
    );

    expect(recoverySql).toContain(
      "CREATE OR REPLACE FUNCTION geo.expire_stale_publication_assisted_handoffs",
    );
    expect(recoverySql).toContain("'draft_prepared', 'awaiting_operator_submit'");
    expect(recoverySql).toContain("candidate.submit_permit_consumed_at IS NULL");
    expect(recoverySql).toContain("state = 'needs_review'");
    expect(recoverySql).toContain("lease_owner = NULL");
    expect(recoverySql).toContain("publication_attempt.state = 'started'");
    expect(recoverySql).toContain("ASSISTED_PRE_SUBMIT_HANDOFF_EXPIRED");
    expect(recoverySql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) TO geo_runtime",
    );
  });

  it("claims Baijiahao analytics only for authenticated account runtimes", async () => {
    const analyticsSql = await readFile(
      new URL("../migrations/0104_baijiahao_account_analytics.sql", import.meta.url),
      "utf8",
    );
    expect(analyticsSql).toContain("account.platform IN ('toutiao', 'baijiahao')");
    expect(analyticsSql).toContain("runtime.session_state IN ('authenticated', 'ready')");
    expect(analyticsSql).toContain("FOR UPDATE OF sync SKIP LOCKED");
  });

  it("extends native analytics claims to authenticated Sohu and Netease accounts", async () => {
    const analyticsSql = await readFile(
      new URL("../migrations/0124_sohu_netease_account_analytics.sql", import.meta.url),
      "utf8",
    );
    expect(analyticsSql).toContain(
      "account.platform IN ('toutiao', 'baijiahao', 'sohu', 'netease')",
    );
    expect(analyticsSql).toContain("account.archived_at IS NULL");
    expect(analyticsSql).toContain("runtime.session_state IN ('authenticated', 'ready')");
    expect(analyticsSql).toContain("FOR UPDATE OF sync SKIP LOCKED");
  });

  it("allows media remediation to rebind a run to a replacement content item", async () => {
    const migrationSql = await readFile(
      new URL(
        "../migrations/0125_automation_media_checkpoint_content_item_rebind.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migrationSql).toContain(
      `IF (run_row.content_item_id IS NOT NULL AND
      run_row.content_item_id <> p_content_item_id AND
      coalesce(p_checkpoint->>'stage', '') <> 'media') OR`,
    );
    expect(migrationSql).toContain("automation media content-item binding gate was not found");
  });

  it("archives channel accounts without deleting publication history", async () => {
    const archiveSql = await readFile(
      new URL("../migrations/0097_archive_channel_accounts.sql", import.meta.url),
      "utf8",
    );
    expect(archiveSql).toContain("ADD COLUMN IF NOT EXISTS archived_at timestamptz");
    expect(archiveSql).toContain("channel_accounts_visible_idx");
    expect(archiveSql).toContain("WHERE archived_at IS NULL");
  });

  it("persists platform mute windows and temporarily disables muted accounts", async () => {
    const muteSql = await readFile(
      new URL("../migrations/0120_channel_account_platform_mute.sql", import.meta.url),
      "utf8",
    );
    expect(muteSql).toContain("ADD COLUMN IF NOT EXISTS platform_muted_at timestamptz");
    expect(muteSql).toContain("ADD COLUMN IF NOT EXISTS platform_muted_until timestamptz");
    expect(muteSql).toContain("ADD COLUMN IF NOT EXISTS platform_mute_reason text");
    expect(muteSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.report_channel_account_platform_mute",
    );
    expect(muteSql).toContain("session_state = 'disabled'");
    expect(muteSql).toContain("last_error_code = 'ACCOUNT_PLATFORM_MUTED'");
    expect(muteSql).toContain("channel_account.platform_muted");
    expect(muteSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.report_channel_account_platform_mute(uuid, uuid, text)",
    );
    expect(muteSql).toContain("TO geo_runtime");
  });

  it("pauses image-gated automation until the reviewed final content version is confirmed", async () => {
    const manualReviewPauseSql = await readFile(
      new URL("../migrations/0099_automation_manual_media_review_pause.sql", import.meta.url),
      "utf8",
    );

    expect(manualReviewPauseSql).toContain("awaiting_manual_review");
    expect(manualReviewPauseSql).toContain("resume_automation_runs_after_manual_media_review");
    expect(manualReviewPauseSql).toContain("review.status = 'confirmed'");
    expect(manualReviewPauseSql).toContain("run.content_version_id = p_content_version_id");
  });

  it("defaults migrated tenant memberships to no gray modules", async () => {
    const membershipModules = await readFile(
      new URL("../migrations/0079_tenant_member_modules.sql", import.meta.url),
      "utf8",
    );

    expect(membershipModules).toContain(
      "ADD COLUMN enabled_modules jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(membershipModules).toContain("jsonb_typeof(enabled_modules) = 'array'");
    expect(membershipModules).toContain("trend_discovery");
    expect(membershipModules).toContain("priority_distribution");
    expect(membershipModules).toContain("agent_automation");
    expect(membershipModules).toContain("module_value = ANY(seen_modules)");
    expect(membershipModules).toContain(
      "p_modules IS NULL OR jsonb_typeof(p_modules) IS DISTINCT FROM 'array'",
    );
    expect(membershipModules).toContain(
      "jsonb_typeof(module_entry.value) IS DISTINCT FROM 'string'",
    );
    expect(membershipModules).toContain(
      "REVOKE ALL ON FUNCTION geo.member_modules_valid(jsonb) FROM PUBLIC",
    );
    expect(membershipModules).toContain("CREATE FUNCTION geo.update_tenant_member_modules");
    expect(membershipModules).toContain("SECURITY DEFINER");
    expect(membershipModules).toContain("actor_role NOT IN ('owner', 'admin')");
    expect(membershipModules).toContain("actor_role <> 'owner' AND target_role = 'owner'");
    expect(membershipModules).toContain(
      "GRANT EXECUTE ON FUNCTION geo.update_tenant_member_modules(uuid, jsonb) TO geo_runtime",
    );
  });
  it("keeps trend observations append-only and tenant isolated", async () => {
    const trendSql = await readFile(
      new URL("../migrations/0075_trend_observations.sql", import.meta.url),
      "utf8",
    );

    expect(trendSql).toContain("CREATE TABLE geo.trend_observations");
    expect(trendSql).toContain("UNIQUE (tenant_id, source_key, observation_key)");
    expect(trendSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(trendSql).toContain(
      "USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)",
    );
    expect(trendSql).toContain("FUNCTION geo.prevent_append_only_mutation()");
    expect(trendSql).toContain(
      "GRANT SELECT, INSERT ON TABLE geo.trend_observations TO geo_runtime",
    );
    expect(trendSql).toContain("REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER");
  });

  it("expands generic publication platforms while keeping publication-only tables scoped", async () => {
    const platformSql = await readFile(
      new URL("../migrations/0074_expand_generic_publication_platforms.sql", import.meta.url),
      "utf8",
    );
    const genericPlatformConstraints = [
      ["channel_accounts", "channel_accounts_platform_check"],
      ["automation_run_targets", "automation_run_targets_platform_check"],
      ["media_generation_jobs", "media_generation_jobs_platform_check"],
      ["media_assets", "media_assets_platform"],
      ["content_media_bindings", "content_media_bindings_platform_check"],
      ["publication_variants", "publication_variants_platform_check"],
      ["audit_artifacts", "audit_artifacts_platform_check"],
      ["publication_grants", "publication_grants_platform_check"],
      ["publication_jobs", "publication_jobs_platform_check"],
      ["publication_receipts", "publication_receipts_platform_check"],
    ] as const;

    for (const [tableName, constraintName] of genericPlatformConstraints) {
      expect(platformSql).toContain(`ALTER TABLE geo.${tableName}`);
      expect(platformSql).toContain(`DROP CONSTRAINT ${constraintName}`);
      expect(platformSql).toContain(`ADD CONSTRAINT ${constraintName}`);
    }

    expect(platformSql).toContain(
      "platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')",
    );

    for (const tableName of [
      "publication_assisted_handoffs",
      "historical_publications",
      "ctrip_phase_b_canaries",
      "ctrip_account_analytics_snapshots",
    ]) {
      expect(platformSql).not.toContain(`ALTER TABLE geo.${tableName}`);
      expect(tableDefinition(tableName)).toContain("CHECK (platform = 'ctrip_community')");
    }

    const runtimeSql = await readFile(
      new URL("../migrations/0076_priority_platform_browser_runtime.sql", import.meta.url),
      "utf8",
    );
    expect(runtimeSql).toContain("ALTER TABLE geo.ctrip_account_runtime_bindings");
    expect(runtimeSql).toContain(
      "platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')",
    );
    expect(runtimeSql).toContain(
      "WHERE account.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease')",
    );
    expect(runtimeSql).toContain("'ctrip-account-' || account.id::text");
  });

  it("derives browser handoff platforms from audited publication lineage", async () => {
    const handoffSql = await readFile(
      new URL("../migrations/0077_generic_browser_assisted_handoffs.sql", import.meta.url),
      "utf8",
    );
    const admission = latestFunctionDefinition("consume_browser_assisted_publication_grant");
    const blockReason = latestFunctionDefinition("publication_assisted_block_reason");
    const createHandoff = latestFunctionDefinition("create_publication_assisted_handoff");
    const claimHandoff = latestFunctionDefinition("claim_publication_assisted_handoff");
    const enforceBinding = latestFunctionDefinition("enforce_commissioned_ctrip_bridge_handoff");
    const legacyAdmission = functionDefinition("consume_ctrip_assisted_publication_grant");

    expect(handoffSql).toContain("ALTER COLUMN platform DROP DEFAULT");
    expect(handoffSql).toContain("publication_assisted_handoffs_platform_check");
    expect(handoffSql).toContain(
      "platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')",
    );

    expect(admission).not.toContain("p_platform");
    expect(admission).toContain("grant_row.platform NOT IN");
    expect(admission).toContain("account_row.platform <> grant_row.platform");
    expect(admission).toContain("artifact_row.platform <> grant_row.platform");
    expect(admission).toContain("variant_row.platform <> grant_row.platform");
    expect(admission).toContain("grant_row.channel_account_id, grant_row.platform");
    expect(admission).toContain("'platform', grant_row.platform");
    expect(admission).not.toContain("'platform', 'ctrip_community'");

    expect(blockReason).toContain("publication_grant.platform <> job.platform");
    expect(blockReason).toContain("account.platform <> job.platform");
    expect(blockReason).toContain("variant.platform <> job.platform");
    expect(blockReason).toContain("job.platform = 'ctrip_community'");
    expect(blockReason).toContain(
      "geo.ctrip_protected_history_baseline_bound(job.channel_account_id)",
    );
    expect(createHandoff).not.toContain("p_platform");
    expect(createHandoff).toContain(
      "job.channel_account_id, job.variant_id, job.platform, 'handoff_pending'",
    );
    expect(createHandoff).toContain("existing.platform <> job.platform");
    expect(claimHandoff).toContain("handoff.platform <> job.platform");
    expect(claimHandoff).toContain("geo.publication_assisted_block_reason(handoff.job_id)");

    expect(enforceBinding).toContain("account.platform = NEW.platform");
    expect(enforceBinding).toContain("binding.platform = NEW.platform");
    expect(enforceBinding).toContain(
      "binding.bridge_principal_id = NEW.bridge_service_principal_id",
    );
    expect(legacyAdmission).toContain("grant_row.platform <> 'ctrip_community'");
    expect(handoffSql).toMatch(
      /GRANT EXECUTE ON FUNCTION geo\.consume_browser_assisted_publication_grant\(\s*uuid, geo\.sha256_hex, text, geo\.sha256_hex, text, timestamptz\s*\) TO geo_runtime/u,
    );
  });

  it("binds assisted submit and readback identities to canonical platform URLs", async () => {
    const submitReadbackSql = await readFile(
      new URL("../migrations/0078_generic_browser_submit_readback.sql", import.meta.url),
      "utf8",
    );
    const urlPolicy = latestFunctionDefinition("publication_public_url_matches_platform");
    const identityPolicy = latestFunctionDefinition("browser_publication_identity_allowed");
    const submit = latestFunctionDefinition("record_publication_assisted_submit_observation");
    const readback = latestFunctionDefinition("record_publication_assisted_readback");

    expect(urlPolicy).toContain(
      "^https://m\\.ctrip\\.com/webapp/you/community/detail\\?articleId=[0-9]{1,20}$",
    );
    expect(identityPolicy).toContain("p_external_id ~ '^[0-9]{1,20}$'");
    expect(identityPolicy).toContain(
      "'https://m.ctrip.com/webapp/you/community/detail?articleId=' || p_external_id",
    );
    expect(urlPolicy).toContain("^https://www\\.toutiao\\.com/article/[0-9]{10,30}/$");
    expect(urlPolicy).toContain("^https://www\\.sohu\\.com/a/[1-9][0-9]{0,29}_[1-9][0-9]{0,29}$");
    expect(urlPolicy).toContain("^https://baijiahao\\.baidu\\.com/s\\?id=[0-9]{10,30}$");
    expect(urlPolicy).toContain("^https://www\\.163\\.com/dy/article/[A-Z0-9]{8,32}\\.html$");
    expect(submitReadbackSql).toContain(
      "DROP CONSTRAINT IF EXISTS publication_assisted_handoff_submit_candidate_external_url_check",
    );
    expect(submitReadbackSql).toContain(
      "AND geo.publication_public_url_matches_platform(\n          platform,",
    );
    expect(submit).toContain("geo.browser_publication_identity_allowed(");
    expect(submit).toContain("handoff.platform");
    expect(submit).toContain("handoff.platform, job.execution_level");
    expect(readback).toContain("geo.browser_publication_identity_allowed(");
    expect(readback).toContain("receipt.platform = handoff.platform");
    expect(readback).toContain(
      "p_observed_payload_hash IS DISTINCT FROM handoff.public_content_hash",
    );
    expect(readback).toContain("next_attempt_count >= 60");
    expect(readback).toContain("'attemptLimit', 60");
    expect(submitReadbackSql).not.toContain("'attemptLimit', 20");
    expect(submitReadbackSql).toContain(
      "REVOKE ALL ON FUNCTION geo.browser_publication_identity_allowed(text, text, text)",
    );
  });

  it("counts only independently confirmed public readbacks toward daily publication quota", async () => {
    const quotaSql = await readFile(
      new URL("../migrations/0067_public_readback_publication_quota.sql", import.meta.url),
      "utf8",
    );

    expect(quotaSql).toContain("count(DISTINCT readback.job_id)");
    expect(quotaSql).toContain("readback.required");
    expect(quotaSql).toContain("readback.status = 'succeeded'");
    expect(quotaSql).toContain("readback.completed_at >= now_value - interval '1 day'");
    expect(quotaSql).toContain("readback_job.channel_account_id::text");
    expect(quotaSql).toContain("readback_item.campaign_id::text");
    expect(quotaSql).toContain("readback_item.topic_key");
  });

  it("keeps priority-platform readback polling within a ten-minute uncertain window", async () => {
    const readbackTimeoutSql = await readFile(
      new URL("../migrations/0088_priority_platform_ten_minute_readback.sql", import.meta.url),
      "utf8",
    );

    expect(readbackTimeoutSql).toContain("interval '10 minutes'");
    expect(readbackTimeoutSql).toContain("next_attempt_count >= 10");
    expect(readbackTimeoutSql).toContain("'''attemptLimit'', 10'");
    expect(readbackTimeoutSql).toContain("ASSISTED_READBACK_UNCERTAIN");
    expect(readbackTimeoutSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.expire_priority_platform_readback_windows()",
    );
    expect(readbackTimeoutSql).toContain(
      "PERFORM geo.expire_priority_platform_readback_windows();",
    );
  });

  it("preserves a fresh manual readback reopen window despite the budget trigger", async () => {
    const reopenWindowSql = await readFile(
      new URL("../migrations/0089_preserve_manual_readback_reopen_window.sql", import.meta.url),
      "utf8",
    );

    expect(reopenWindowSql).toContain("interval '10 minutes'");
    expect(reopenWindowSql).toContain("GREATEST(");
    expect(reopenWindowSql).toContain(
      "COALESCE(NEW.readback_deadline_at, COALESCE(NEW.submit_observed_at, statement_timestamp()) + interval '10 minutes')",
    );
  });

  it("expires a reopened readback window without fabricating evidence", async () => {
    const expireReopenedSql = await readFile(
      new URL("../migrations/0090_expire_reopened_readback_without_evidence.sql", import.meta.url),
      "utf8",
    );

    expect(expireReopenedSql).toContain("target.readback_evidence_kind IS NULL");
    expect(expireReopenedSql).toContain("target.readback_evidence_hash IS NULL");
    expect(expireReopenedSql).toContain("target.readback_observed_at IS NULL");
    expect(expireReopenedSql).toContain("ASSISTED_READBACK_UNCERTAIN");
  });

  it("claims reopened readback windows by their durable deadline", async () => {
    const claimReopenedSql = await readFile(
      new URL("../migrations/0091_claim_reopened_readback_by_deadline.sql", import.meta.url),
      "utf8",
    );

    expect(claimReopenedSql).toContain("candidate.readback_deadline_at >= statement_timestamp()");
    expect(claimReopenedSql).toContain(
      "COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)",
    );
    expect(claimReopenedSql).toContain("PERFORM geo.expire_priority_platform_readback_windows();");
  });

  it("defers accepted priority-platform submits to asynchronous moderation readback", async () => {
    const asyncReadbackSql = await readFile(
      new URL("../migrations/0107_async_priority_platform_readback.sql", import.meta.url),
      "utf8",
    );

    expect(asyncReadbackSql).toContain("'submitted_pending_review'");
    expect(asyncReadbackSql).toContain("interval '24 hours'");
    expect(asyncReadbackSql).toContain("interval '30 minutes'");
    expect(asyncReadbackSql).toContain("ASSISTED_READBACK_DEFERRED");
    expect(asyncReadbackSql).toContain("publication_assisted_handoff.readback_deferred");
    expect(asyncReadbackSql).toContain(
      "target.state IN ('awaiting_delivery', 'submitted_pending_review')",
    );
    expect(asyncReadbackSql).not.toContain("SET state = 'confirmed'\n+      WHERE job");
  });

  it("keeps delivery waits alive and isolates tenant error budgets by account", async () => {
    const recoverySql = await readFile(
      new URL(
        "../migrations/0068_automation_delivery_wait_and_account_error_budget.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(recoverySql).toContain("(run.state = 'retry_wait' AND");
    expect(recoverySql).toContain(
      "automation delivery-wait exhaustion guard was not patched by 0068",
    );
    expect(recoverySql).toContain("control_row.scope_type <> 'tenant'");
    expect(recoverySql).toContain("prior_job.channel_account_id = job_row.channel_account_id");
    expect(recoverySql).toContain("target.last_error_code = 'AUTOMATION_MAX_ATTEMPTS_EXCEEDED'");
  });

  it("charges only delivery failures to publication error budgets", async () => {
    const budgetSql = await readFile(
      new URL("../migrations/0069_publication_delivery_error_budget.sql", import.meta.url),
      "utf8",
    );

    expect(budgetSql).toContain("publication_attempt_consumes_error_budget");
    expect(budgetSql).toContain("'CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED'");
    expect(budgetSql).toContain("'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED'");
    expect(budgetSql).toContain("'PUBLICATION_AUTHORIZATION_INVALID'");
    expect(budgetSql).toContain("upper(btrim(p_state)) = 'UNCERTAIN'");
    expect(budgetSql).toContain("upper(btrim(p_error_code)) = 'ASSISTED_SUBMIT_REJECTED'");
    expect(budgetSql).toContain("attempt.state, attempt.error_code");
    expect(budgetSql).toContain("prior_attempt.state, prior_attempt.error_code");
    expect(budgetSql).toContain("p_outcome, p_error_code");
    expect(budgetSql).toContain("half-open publication probe was inconclusive");
    expect(budgetSql).toContain("prior_job.channel_account_id = job_row.channel_account_id");
  });

  it("excludes generic browser runtime configuration failures from error budgets", async () => {
    const recoverySql = await readFile(
      new URL(
        "../migrations/0111_browser_runtime_error_budget_and_prepared_conflict.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(recoverySql).toContain("'BROWSER_ASSISTED_ACCOUNT_NOT_CONFIGURED'");
    expect(recoverySql).toContain("publication_attempt_consumes_error_budget");
    expect(recoverySql).toContain("record_publication_assisted_prepared_conflict");
    expect(recoverySql).toContain("handoff.submit_permit_consumed_at IS NOT NULL");
    expect(recoverySql).toContain("'ASSISTED_PREPARED_DRAFT_MISMATCH'");
    expect(recoverySql).not.toContain("INSERT INTO geo.circuit_breakers");
  });

  it("keeps submit-time browser challenges visible as operator verification states", async () => {
    const submitPreconditionSql = await readFile(
      new URL("../migrations/0129_classify_prepared_submit_blockers.sql", import.meta.url),
      "utf8",
    );

    expect(submitPreconditionSql).toContain("submit:session-required");
    expect(submitPreconditionSql).toContain("submit:challenge-required");
    expect(submitPreconditionSql).toContain("state = next_state");
    expect(submitPreconditionSql).toContain(
      "next_state IN ('session_required', 'challenge_required')",
    );
    expect(submitPreconditionSql).toContain("OLD.state = 'draft_prepared'");
    expect(submitPreconditionSql).toContain(
      "handoff.state NOT IN ('draft_prepared', 'awaiting_operator_submit')",
    );
    expect(submitPreconditionSql).toContain(
      "NEW.state IN ('session_required', 'challenge_required'",
    );
    expect(submitPreconditionSql).toContain("OLD.state = 'awaiting_operator_submit'");
    expect(submitPreconditionSql).toContain("ASSISTED_CHALLENGE_REQUIRED");
    expect(submitPreconditionSql).toContain("ASSISTED_SESSION_REQUIRED");
    expect(submitPreconditionSql).not.toContain("submit:prepared-payload-mismatch'");
  });

  it("patches error-budget denial reasons with the exhaustion policy", async () => {
    const policySql = await readFile(
      new URL("../migrations/0118_error_budget_exhaustion_policy.sql", import.meta.url),
      "utf8",
    );

    expect(policySql).toContain(
      "quota_error_budget:' || control_row.scope_type || ':' || control_row.scope_key",
    );
    expect(policySql).toContain("errorBudgetExhaustedPolicy");
    expect(policySql).toContain(
      "COALESCE(control_row.quota ->> 'errorBudgetExhaustedPolicy', 'review')",
    );
    expect(policySql).toContain("publication error-budget policy was not patched by 0118");
  });

  it("keeps hourly Ctrip analytics tenant-scoped and lease-driven", async () => {
    const analyticsSql = await readFile(
      new URL("../migrations/0065_ctrip_account_analytics.sql", import.meta.url),
      "utf8",
    );

    expect(analyticsSql).toContain("UNIQUE (tenant_id, channel_account_id, snapshot_hour)");
    expect(analyticsSql).toContain("runtime.session_state IN ('authenticated', 'ready')");
    expect(analyticsSql).toContain("FOR UPDATE OF sync SKIP LOCKED");
    expect(analyticsSql).toContain("snapshot_hour = date_trunc('hour', observed_at)");
  });

  it("restores Ctrip analytics ACLs after production reconciliation", async () => {
    const repairSql = await readFile(
      new URL("../migrations/0066_restore_ctrip_analytics_acl.sql", import.meta.url),
      "utf8",
    );

    expect(repairSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) TO geo_runtime",
    );
    expect(repairSql).toContain("REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER");
    expect(repairSql).toContain("Ctrip analytics ACL repair failed");
  });

  it("restores the publisher rejection recorder ACL with a forward migration", async () => {
    const repairSql = await readFile(
      new URL("../migrations/0131_restore_publisher_rejection_acl.sql", import.meta.url),
      "utf8",
    );

    expect(repairSql).toContain(
      "REVOKE ALL ON FUNCTION geo.record_publication_assisted_publisher_rejection(",
    );
    expect(repairSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_rejection(",
    );
    expect(repairSql).toContain("TO geo_runtime");
    expect(repairSql).toContain("has_function_privilege(");
    expect(repairSql).toContain("publisher rejection recorder ACL grant was not installed");
  });

  it("restores the account-scoped browser claim helper ACL with a forward migration", async () => {
    const repairSql = await readFile(
      new URL("../migrations/0138_restore_account_browser_operation_acl.sql", import.meta.url),
      "utf8",
    );

    expect(repairSql).toContain(
      "GRANT EXECUTE ON FUNCTION\n  geo.publication_account_browser_operation_busy(uuid, uuid, boolean)",
    );
    expect(repairSql).toContain(
      "'geo.publication_account_browser_operation_busy(uuid,uuid,boolean)'",
    );
    expect(repairSql).toContain("account browser operation ACL grant was not installed");
  });

  it("stores Ctrip favorites as a native comparable metric", async () => {
    const analyticsSql = await readFile(
      new URL("../migrations/0132_ctrip_analytics_favorites.sql", import.meta.url),
      "utf8",
    );

    expect(analyticsSql).toContain("ADD COLUMN total_favorites bigint");
    expect(analyticsSql).toContain("CHECK (total_favorites >= 0)");
  });

  it("repairs the runtime ACL for Ctrip release phase reads", async () => {
    const repairSql = await readFile(
      new URL("../migrations/0046_restore_ctrip_release_phase_acl.sql", import.meta.url),
      "utf8",
    );

    expect(repairSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) TO geo_runtime",
    );
    expect(repairSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.ctrip_release_phase(uuid) TO geo_runtime",
    );
    expect(repairSql).toContain("Ctrip release phase ACL repair failed");
  });

  it("opens only account login runtime storage for reference-only Zhihu", async () => {
    const zhihuLoginSql = await readFile(
      new URL("../migrations/0140_zhihu_account_login_runtime.sql", import.meta.url),
      "utf8",
    );

    expect(zhihuLoginSql).toContain("ALTER TABLE geo.channel_accounts");
    expect(zhihuLoginSql).toContain("ALTER TABLE geo.ctrip_account_runtime_bindings");
    expect(zhihuLoginSql).toContain("WHERE account.platform = 'zhihu'");
    expect(zhihuLoginSql).toContain("'ctrip_community', 'zhihu'");
    expect(zhihuLoginSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.create_ctrip_account_runtime_binding()",
    );
    expect(zhihuLoginSql).not.toContain("ALTER TABLE geo.publication_jobs");
    expect(zhihuLoginSql).not.toContain("ALTER TABLE geo.automation_run_targets");
  });

  it("admits Zhihu when creating an audited assisted browser handoff", async () => {
    const handoffSql = await readFile(
      new URL("../migrations/0142_allow_zhihu_assisted_handoff.sql", import.meta.url),
      "utf8",
    );

    expect(handoffSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.create_publication_assisted_handoff(",
    );
    expect(handoffSql).toContain(
      "job.platform NOT IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu')",
    );
    expect(handoffSql).toContain("attempt.state <> 'started'");
    expect(handoffSql).toContain("attempt.request_hash <> job.request_hash");
    expect(handoffSql).toContain("artifact.id IS NULL");
  });

  it("keeps automation execution levels explicit and batch-bound", async () => {
    const migrationSql = await readFile(
      new URL("../migrations/0035_automation_execution_levels.sql", import.meta.url),
      "utf8",
    );

    expect(migrationSql).toContain("'dry_run', 'assisted', 'unattended'");
    expect(migrationSql).toContain("job.execution_level = (");
    expect(migrationSql).toContain("batch.id = run_row.batch_id");
    expect(migrationSql).toContain("IF updated_definition = definition THEN");
  });

  it("allows unattended automation targets without a Phase C admission check", () => {
    const targetInsertGate = latestFunctionDefinition("validate_automation_target_insert");

    expect(targetInsertGate).toContain("batch_execution_level IS NULL");
    expect(targetInsertGate).not.toContain("geo.ctrip_release_phase(NEW.channel_account_id)");
    expect(targetInsertGate).not.toContain("require a Phase C Ctrip account");
  });

  it("keeps challenge-degraded accounts eligible for publication", async () => {
    const challengeDegradationSql = await readFile(
      new URL("../migrations/0113_allow_challenge_degraded_publication.sql", import.meta.url),
      "utf8",
    );

    expect(challengeDegradationSql).toContain(
      "runtime.session_state IN ('authenticated', 'ready', 'challenge_required')",
    );
    expect(challengeDegradationSql).toContain(
      "account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready', 'challenge_required')",
    );
  });

  it("keeps delayed Ctrip public readback bounded but long enough for moderation", async () => {
    const delayedReadbackSql = await readFile(
      new URL("../migrations/0049_ctrip_delayed_public_readback.sql", import.meta.url),
      "utf8",
    );

    expect(delayedReadbackSql).toContain("next_attempt_count >= 60");
    expect(delayedReadbackSql).toContain("'''attemptLimit'', 60");
    expect(delayedReadbackSql).toContain("interval '60 minutes'");
    expect(delayedReadbackSql).toContain("WHERE state = 'readback_pending'");
  });

  it("separates pre-gate automation failures from delivery failures and reopens safe readbacks", async () => {
    const deliveryFailureSql = await readFile(
      new URL("../migrations/0050_automation_delivery_failure_semantics.sql", import.meta.url),
      "utf8",
    );

    expect(deliveryFailureSql).toContain("'delivery_failed'");
    expect(deliveryFailureSql).toContain("job.state IN ('needs_review', 'permanent_failure')");
    expect(deliveryFailureSql).toContain("handoff.submit_outcome = 'uncertain'");
    expect(deliveryFailureSql).toContain("handoff.readback_outcome = 'unavailable'");
    expect(deliveryFailureSql).toContain(
      "DISABLE TRIGGER publication_assisted_handoffs_transition_only",
    );
    expect(deliveryFailureSql).toContain("state = 'readback_pending'");
  });

  it("synchronizes terminal publication failures into awaiting automation targets", async () => {
    const terminalSyncSql = await readFile(
      new URL("../migrations/0058_automation_publication_terminal_sync.sql", import.meta.url),
      "utf8",
    );

    expect(terminalSyncSql).toContain("sync_automation_target_from_publication_job");
    expect(terminalSyncSql).toContain("automation_runs_completion_check");
    expect(terminalSyncSql).toContain("automation_run_targets_completion_check");
    expect(terminalSyncSql).toContain("NEW.state NOT IN ('needs_review', 'permanent_failure')");
    expect(terminalSyncSql).toContain("target.state = 'awaiting_delivery'");
    expect(terminalSyncSql).toContain("state = 'delivery_failed'");
    expect(terminalSyncSql).toContain("failure_code text := COALESCE");
    expect(terminalSyncSql).toContain("last_error_code = failure_code");
    expect(terminalSyncSql).toContain("AFTER UPDATE OF state ON geo.publication_jobs");
  });

  it("synchronizes confirmed publication jobs into completed automation runs", async () => {
    const confirmedSync = latestFunctionDefinition("sync_automation_target_from_publication_job");
    const confirmedSyncMigration = await readFile(
      new URL("../migrations/0071_automation_confirmed_terminal_sync.sql", import.meta.url),
      "utf8",
    );

    expect(confirmedSync).toContain(
      "NEW.state NOT IN ('confirmed', 'needs_review', 'permanent_failure')",
    );
    expect(confirmedSync).toContain("WHEN NEW.state = 'confirmed' THEN 'confirmed'");
    expect(confirmedSync).toContain("WHEN NEW.state = 'needs_review' THEN 'blocked'");
    expect(confirmedSync).toContain("ELSE 'delivery_failed'");
    expect(confirmedSync).toContain("WHEN 'completed' THEN NULL");
    expect(confirmedSync).toContain("NEW.state = 'confirmed'");
    expect(confirmedSync).toContain(
      "target.state IN ('awaiting_delivery', 'submitted_pending_review')",
    );
    expect(confirmedSync).toContain("publisher_rejected");
    expect(confirmedSync).toContain("ASSISTED_PUBLISHER_REJECTED");
    expect(confirmedSyncMigration).toContain("RETURNING target.tenant_id, target.run_id");
    expect(confirmedSyncMigration).toContain("affected.tenant_id = run.tenant_id");
    expect(confirmedSyncMigration).toContain("run.tenant_id = terminal.tenant_id");
    expect(confirmedSyncMigration).toContain("affected.tenant_id = batch.tenant_id");
  });

  it("reopens blocked targets for manual remediation and retires their terminal jobs", async () => {
    const reopen = latestFunctionDefinition("restart_automation_target_for_remediation");

    expect(reopen).toContain("target_row.state NOT IN (");
    expect(reopen).toContain(
      "'awaiting_manual_review', 'audit_failed', 'blocked', 'publisher_rejected'",
    );
    expect(reopen).toContain("target_row.publication_job_id IS NOT NULL");
    expect(reopen).toContain("job_row.state IN ('confirmed', 'preview_completed', 'uncertain')");
    expect(reopen).toContain("SET state = 'cancelled'");
    expect(reopen).toContain("SET state = 'pending'");
    expect(reopen).toContain("SET state = 'scheduled'");
    expect(reopen).toContain("attempt_count = 0");

    const remediation = latestFunctionDefinition("record_publication_assisted_publisher_rejection");
    expect(remediation).toContain("publisher.rejected.soft_advertorial");
    expect(remediation).toContain("ASSISTED_PUBLISHER_REJECTED_SOFT_ADVERTORIAL");
    expect(remediation).toContain("publisher-remediation");
    expect(remediation).toContain("remediation_attempt <= 2");

    const terminalSync = latestFunctionDefinition("sync_ctrip_handoff_terminal_job");
    expect(terminalSync).toContain("NEW.readback_outcome = 'publisher_rejected'");
    expect(terminalSync).toContain("WHEN publisher_rejected THEN 'failed'");
    expect(terminalSync).toContain("WHEN publisher_rejected THEN 'permanent_failure'");
  });

  it("reopens only zero-write jobs rejected by the retired Ctrip evidence gate", async () => {
    const recoverySql = await readFile(
      new URL("../migrations/0059_reopen_obsolete_ctrip_evidence_failures.sql", import.meta.url),
      "utf8",
    );

    expect(recoverySql).toContain(
      "job.last_error_code = 'CTRIP_ASSISTED_ADAPTER_EVIDENCE_EXPIRED'",
    );
    expect(recoverySql).toContain("event.dead_lettered_at IS NOT NULL");
    expect(recoverySql).toContain("FROM geo.publication_assisted_handoffs AS handoff");
    expect(recoverySql).toContain("FROM geo.publication_receipts AS receipt");
    expect(recoverySql).toContain("SET state = 'retry_wait'");
    expect(recoverySql).toContain("SET state = 'awaiting_delivery'");
    expect(recoverySql).toContain("dead_lettered_at = NULL");
    expect(recoverySql).toContain("externalWriteObserved', false");
    expect(recoverySql).toContain("failedAttemptPreserved', true");
  });

  it("persists authenticated Ctrip sessions without granting editor readiness", async () => {
    const authenticatedStateSql = await readFile(
      new URL("../migrations/0053_ctrip_authenticated_session_state.sql", import.meta.url),
      "utf8",
    );

    expect(authenticatedStateSql).toContain("'authenticated'");
    expect(authenticatedStateSql).toContain(
      "DROP CONSTRAINT ctrip_account_runtime_bindings_session_state_check",
    );
    expect(authenticatedStateSql).toContain(
      "ADD CONSTRAINT ctrip_account_runtime_bindings_session_state_check",
    );
  });

  it("restores the reconciliation state for reopened unattended public readbacks", async () => {
    const reopenSql = await readFile(
      new URL("../migrations/0055_ctrip_reopen_readback_jobs.sql", import.meta.url),
      "utf8",
    );

    expect(reopenSql).toContain("SET state = 'reconciling'");
    expect(reopenSql).toContain("handoff.state = 'readback_pending'");
    expect(reopenSql).toContain("handoff.last_error_code = 'ASSISTED_READBACK_REOPENED'");
    expect(reopenSql).toContain("handoff.submit_permit_consumed_at IS NOT NULL");
    expect(reopenSql).toContain("handoff.external_id IS NULL");
    expect(reopenSql).toContain("handoff.external_url IS NULL");
    expect(reopenSql).not.toContain("submit_permit_consumed_at = NULL");
  });
  it("materializes every planned core table", () => {
    for (const tableName of expectedTables) {
      expect(migrationSql).toMatch(new RegExp(`CREATE TABLE geo\\.${tableName}\\s*\\(`, "i"));
    }
  });

  it("gives every tenant-owned table a non-null tenant key and scoped identity", () => {
    for (const tableName of tenantTables) {
      const definition = tableDefinition(tableName);
      expect(definition, tableName).toMatch(/tenant_id uuid NOT NULL/i);
      expect(definition, tableName).toMatch(/UNIQUE \(tenant_id, id\)/i);
    }
  });

  it("never uses an id-only foreign key to another tenant-owned table", () => {
    for (const referencedTable of tenantTables) {
      expect(migrationSql).not.toMatch(
        new RegExp(`REFERENCES geo\\.${referencedTable} \\(id\\)`, "i"),
      );
    }
  });

  it("enables and forces RLS for an explicit complete tenant table list", () => {
    const securitySql = functionDefinition("validate_publication_grant");
    const rlsPrefix = migrationSql.slice(0, migrationSql.indexOf(securitySql));
    expect(rlsPrefix).toContain("ENABLE ROW LEVEL SECURITY");
    expect(rlsPrefix).toContain("FORCE ROW LEVEL SECURITY");
    expect(rlsPrefix).toContain("geo.current_tenant_id()");
    expect(rlsPrefix).toContain("geo.current_actor_id() IS NOT NULL");
    for (const tableName of tenantTables.filter(
      (name) =>
        name !== "brand_competitors" &&
        name !== "brand_agent_profiles" &&
        name !== "publication_readbacks" &&
        name !== "publication_assisted_handoffs" &&
        name !== "ctrip_phase_b_canaries" &&
        name !== "automation_batches" &&
        name !== "automation_runs" &&
        name !== "automation_run_targets" &&
        name !== "research_source_policies" &&
        name !== "research_capture_records" &&
        name !== "media_generation_jobs" &&
        name !== "media_generation_attempts" &&
        name !== "content_media_bindings" &&
        name !== "media_inspections" &&
        name !== "historical_publications" &&
        name !== "ctrip_account_runtime_bindings" &&
        name !== "automation_distribution_cursors" &&
        name !== "automation_template_rotation_cursors" &&
        name !== "ctrip_account_analytics_snapshots" &&
        name !== "ctrip_account_analytics_sync_state" &&
        name !== "manual_media_reviews" &&
        name !== "campaign_automation_plans",
    )) {
      expect(rlsPrefix, tableName).toContain(`'${tableName}'`);
    }
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_readbacks ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.automation_distribution_cursors ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.automation_distribution_cursors FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "CREATE POLICY tenant_isolation ON geo.automation_distribution_cursors",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.automation_template_rotation_cursors ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.automation_template_rotation_cursors FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "CREATE POLICY tenant_isolation ON geo.automation_template_rotation_cursors",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.campaign_automation_plans ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.campaign_automation_plans FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "CREATE POLICY tenant_isolation ON geo.campaign_automation_plans",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_readbacks FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.publication_readbacks");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_assisted_handoffs ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.publication_assisted_handoffs FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "CREATE POLICY tenant_isolation ON geo.publication_assisted_handoffs",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.historical_publications ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.historical_publications FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.historical_publications");
    for (const tableName of ["automation_batches", "automation_runs", "automation_run_targets"]) {
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} ENABLE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} FORCE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`CREATE POLICY tenant_isolation ON geo.${tableName}`);
    }
  });

  it("keeps runtime and dispatcher roles non-owning and unable to bypass RLS", () => {
    expect(migrationSql).toMatch(/CREATE ROLE geo_runtime[^;]*NOLOGIN[^;]*NOBYPASSRLS/i);
    expect(migrationSql).toMatch(/CREATE ROLE geo_dispatcher[^;]*NOLOGIN[^;]*NOBYPASSRLS/i);
    expect(migrationSql).not.toMatch(/ALTER TABLE[^;]+OWNER TO geo_(runtime|dispatcher)/i);
    expect(migrationSql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM PUBLIC, geo_dispatcher",
    );
  });

  it("makes audit artifacts, receipts, logs, and observations append-only", () => {
    for (const triggerName of [
      "audit_artifacts_append_only",
      "publication_receipts_append_only",
      "audit_log_append_only",
      "visibility_observations_append_only",
      "research_capture_records_append_only",
      "ctrip_phase_b_canaries_append_only",
      "media_generation_attempts_append_only",
      "media_assets_append_only",
      "content_media_bindings_append_only",
      "media_inspections_append_only",
      "historical_publications_append_only",
    ]) {
      expect(migrationSql).toContain(`CREATE TRIGGER ${triggerName}`);
    }
    expect(migrationSql).toContain("EXECUTE FUNCTION geo.prevent_append_only_mutation()");
  });

  it("persists tenant-scoped governed media jobs and immutable media evidence", () => {
    const jobs = tableDefinition("media_generation_jobs");
    const attempts = tableDefinition("media_generation_attempts");
    const bindings = tableDefinition("content_media_bindings");
    const inspections = tableDefinition("media_inspections");

    expect(jobs).toContain("content_version_id uuid NOT NULL");
    expect(jobs).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(jobs).toContain("UNIQUE (tenant_id, id, request_hash)");
    expect(jobs).toContain("UNIQUE (tenant_id, id, request_hash, provider_id, provider_mode)");
    expect(jobs).toMatch(
      /FOREIGN KEY \(tenant_id, content_version_id\)[\s\S]*REFERENCES geo\.content_versions \(tenant_id, id\)/i,
    );
    expect(attempts).toContain("job_id uuid NOT NULL");
    expect(attempts).toContain("UNIQUE (tenant_id, job_id, attempt_no)");
    expect(attempts).toMatch(
      /FOREIGN KEY \(tenant_id, job_id\)[\s\S]*REFERENCES geo\.media_generation_jobs \(tenant_id, id\)/i,
    );
    expect(attempts).toMatch(
      /FOREIGN KEY \(tenant_id, job_id, request_hash, provider_id, provider_mode\)[\s\S]*REFERENCES geo\.media_generation_jobs[\s\S]*\(tenant_id, id, request_hash, provider_id, provider_mode\)/i,
    );
    expect(bindings).toMatch(
      /FOREIGN KEY \(tenant_id, media_asset_id\)[\s\S]*REFERENCES geo\.media_assets \(tenant_id, id\)/i,
    );
    expect(inspections).toMatch(
      /FOREIGN KEY \(tenant_id, media_asset_id, asset_sha256\)[\s\S]*REFERENCES geo\.media_assets \(tenant_id, id, sha256\)/i,
    );

    expect(migrationSql).toContain("DROP CONSTRAINT media_assets_tenant_id_sha256_key");
    expect(migrationSql).toContain("UNIQUE (tenant_id, provenance_hash)");
    expect(migrationSql).toContain("brand_snapshot_hash geo.sha256_hex");
    expect(migrationSql).toContain("media_snapshot_hash geo.sha256_hex");
    expect(migrationSql).toContain("terminal media generation jobs are immutable");

    for (const tableName of [
      "media_generation_jobs",
      "media_generation_attempts",
      "content_media_bindings",
      "media_inspections",
    ]) {
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} ENABLE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`ALTER TABLE geo.${tableName} FORCE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`CREATE POLICY tenant_isolation ON geo.${tableName}`);
    }
    expect(migrationSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE[\s\S]*media_generation_attempts[\s\S]*media_assets[\s\S]*content_media_bindings[\s\S]*media_inspections FROM geo_runtime/i,
    );
  });

  it("allows governed media without a verified fact binding", () => {
    expect(migrationSql).toContain("DROP CONSTRAINT media_generation_jobs_fact_ids_check");
    expect(migrationSql).toContain("CHECK (cardinality(fact_ids) BETWEEN 0 AND 3)");
    expect(migrationSql).toContain("DROP CONSTRAINT media_assets_governed_shape");
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT media_assets_governed_shape CHECK \([\s\S]*cardinality\(fact_ids\) BETWEEN 0 AND 3[\s\S]*visual_brief IS NOT NULL[\s\S]*visual_brief_hash IS NOT NULL/iu,
    );
  });

  it("versions tenant-scoped Brand Agent Profiles with one active document per brand", () => {
    const profiles = tableDefinition("brand_agent_profiles");
    expect(profiles).toContain("brand_id uuid NOT NULL");
    expect(profiles).toContain("version integer NOT NULL CHECK (version > 0)");
    expect(profiles).toContain("document_hash geo.sha256_hex NOT NULL");
    expect(profiles).toContain("UNIQUE (tenant_id, brand_id, version)");
    expect(profiles).toMatch(
      /FOREIGN KEY \(tenant_id, brand_id\)[\s\S]*REFERENCES geo\.brands \(tenant_id, id\)/i,
    );
    expect(migrationSql).toContain("brand_agent_profiles_one_active_per_brand");
    expect(migrationSql).toContain("brand_agent_profiles_transition_only");
    expect(migrationSql).toContain("ALTER TABLE geo.brand_agent_profiles FORCE ROW LEVEL SECURITY");
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.brand_agent_profiles");
    expect(migrationSql).toContain(
      "GRANT UPDATE (status, retired_at) ON TABLE geo.brand_agent_profiles TO geo_runtime",
    );
    expect(migrationSql).toContain("brand_agent_profile_id uuid");
    expect(migrationSql).toContain("brand_agent_profile_hash geo.sha256_hex");
    expect(migrationSql).toContain("tenant_provisioning_receipts_brand_agent_profile_fk");
  });

  it("persists governed research policies and redacted append-only capture records", () => {
    const policies = tableDefinition("research_source_policies");
    const captures = tableDefinition("research_capture_records");

    expect(policies).toContain("origin text NOT NULL");
    expect(policies).toContain("allowed_hosts text[] NOT NULL");
    expect(policies).toContain("max_bytes integer NOT NULL");
    expect(policies).toContain("timeout_ms integer NOT NULL");
    expect(policies).toContain("status IN ('active', 'retired')");
    expect(migrationSql).toContain("research_source_policies_one_active_version");
    expect(migrationSql).toContain("research_source_policies_retirement_only");

    expect(captures).toContain("request_url_hash geo.sha256_hex NOT NULL");
    expect(captures).not.toContain("requested_url");
    expect(captures).toContain("evidence_source_id uuid");
    expect(captures).toContain("result_metadata = '{}'::jsonb");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.research_capture_records FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "GRANT SELECT, INSERT ON TABLE geo.research_capture_records TO geo_runtime",
    );
  });

  it("stores tenant-scoped competitor truth and complete visibility evaluator evidence", () => {
    const competitors = tableDefinition("brand_competitors");
    expect(competitors).toContain("brand_id uuid NOT NULL");
    expect(competitors).toContain("source_type text NOT NULL");
    expect(competitors).toContain("source_ref text NOT NULL");
    expect(migrationSql).toContain("CREATE POLICY tenant_isolation ON geo.brand_competitors");

    for (const column of [
      "ALTER COLUMN request_started_at SET NOT NULL",
      "ALTER COLUMN response_received_at SET NOT NULL",
      "ALTER COLUMN sentiment SET NOT NULL",
      "ALTER COLUMN hallucination_findings SET NOT NULL",
      "ALTER COLUMN evaluator_version SET NOT NULL",
    ]) {
      expect(migrationSql).toContain(column);
    }
  });

  it("keeps tenant provisioning receipts append-only and admin-only", () => {
    const receipt = tableDefinition("tenant_provisioning_receipts");
    expect(receipt).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(receipt).toContain("request_hash geo.sha256_hex NOT NULL");
    expect(receipt).toContain("tenant_id uuid NOT NULL UNIQUE");
    expect(migrationSql).toContain("CREATE TRIGGER tenant_provisioning_receipts_append_only");
    expect(migrationSql).toContain("REVOKE ALL ON TABLE geo.tenant_provisioning_receipts");
    expect(migrationSql).not.toContain("GRANT SELECT ON geo.tenant_provisioning_receipts");
  });

  it("keeps Ctrip Bridge commissioning receipts append-only and admin-only", () => {
    const receipt = tableDefinition("ctrip_bridge_commissioning_receipts");
    expect(receipt).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(receipt).toContain("audit_log_id uuid NOT NULL UNIQUE");
    expect(receipt).toContain("bridge_service_principal_id uuid NOT NULL UNIQUE");
    expect(migrationSql).toContain(
      "CREATE TRIGGER ctrip_bridge_commissioning_receipts_append_only",
    );
    expect(migrationSql).toContain("REVOKE ALL ON TABLE geo.ctrip_bridge_commissioning_receipts");
    expect(migrationSql).not.toContain("GRANT SELECT ON geo.ctrip_bridge_commissioning_receipts");
  });

  it("binds each Ctrip account to an isolated runtime and commissioned bridge", () => {
    const runtime = tableDefinition("ctrip_account_runtime_bindings");
    const createBinding = latestFunctionDefinition("create_ctrip_account_runtime_binding");
    const enforceHandoff = latestFunctionDefinition("enforce_commissioned_ctrip_bridge_handoff");

    expect(runtime).toContain("UNIQUE (tenant_id, channel_account_id)");
    expect(runtime).toContain("UNIQUE (tenant_id, profile_key)");
    expect(runtime).toContain("bridge_principal_id uuid");
    expect(runtime).toContain("'session_required'");
    expect(runtime).toContain("'challenge_required'");
    expect(runtime).not.toContain("cookie");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.ctrip_account_runtime_bindings ENABLE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE geo.ctrip_account_runtime_bindings FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "DROP CONSTRAINT IF EXISTS ctrip_account_runtime_binding_tenant_id_channel_account_id_fkey",
    );
    expect(migrationSql).toContain(
      "REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE CASCADE",
    );
    expect(migrationSql).toContain("AFTER INSERT ON geo.channel_accounts");
    expect(createBinding).toContain("'ctrip-account-' || NEW.id::text");
    expect(createBinding).toContain("commissioned_principal_id");
    expect(enforceHandoff).toContain("geo.ctrip_account_runtime_bindings AS binding");
    expect(enforceHandoff).toContain(
      "binding.bridge_principal_id = NEW.bridge_service_principal_id",
    );
  });

  it("limits each tenant platform to 200 accounts and installs account capacity controls", () => {
    const enforceLimit = latestFunctionDefinition("enforce_channel_account_platform_limit");
    const syncCapacity = latestFunctionDefinition("sync_channel_account_capacity_control");

    expect(migrationSql).toContain("ADD COLUMN daily_publish_quota integer NOT NULL DEFAULT 10");
    expect(migrationSql).toContain(
      "ADD COLUMN max_concurrent_publications integer NOT NULL DEFAULT 1",
    );
    expect(migrationSql).toContain(
      "ADD COLUMN quota_timezone text NOT NULL DEFAULT 'Asia/Shanghai'",
    );
    expect(enforceLimit).toContain("NEW.tenant_id::text || ':' || NEW.platform");
    expect(enforceLimit).toContain("pg_advisory_xact_lock");
    expect(enforceLimit).toContain("platform_account_count >= 200");
    expect(migrationSql).toContain("BEFORE INSERT OR UPDATE OF tenant_id, platform");
    expect(syncCapacity).toContain("'maxConcurrent', NEW.max_concurrent_publications");
    expect(syncCapacity).toContain("'perDay', NEW.daily_publish_quota");
    expect(migrationSql).toContain("channel_accounts_sync_capacity_control");
  });

  it("makes newly added channel accounts active without a manual verification state", () => {
    expect(migrationSql).toContain(
      "UPDATE geo.channel_accounts\nSET status = 'active'\nWHERE status = 'needs_verification'",
    );
    expect(migrationSql).toContain("ALTER COLUMN status SET DEFAULT 'active'");
    expect(migrationSql).toContain("CHECK (status IN ('active', 'disabled'))");
  });

  it("atomically consumes a grant and writes a job, idempotency record, outbox, and audit log", () => {
    const consume = functionDefinition("consume_publication_grant");
    expect(consume).toContain("SECURITY DEFINER");
    expect(consume).toContain("FOR UPDATE");
    expect(consume).toContain("pg_advisory_xact_lock");
    expect(consume).toContain("UPDATE geo.publication_grants");
    expect(consume).toContain("INSERT INTO geo.publication_jobs");
    expect(consume).toContain("INSERT INTO geo.idempotency_records");
    expect(consume).toContain("INSERT INTO geo.outbox_events");
    expect(consume).toContain("INSERT INTO geo.audit_log");
    expect(consume).toContain("account_row.capability NOT IN ('public_api', 'partner_api')");
  });

  it("rechecks account archival under a row lock at the final publication job boundary", () => {
    const monotonicGuard = latestFunctionDefinition(
      "enforce_channel_account_archive_monotonicity",
    ).toLowerCase();
    const reassignmentStart = migrationSql.lastIndexOf(
      "'geo.reassign_pending_automation_target(uuid,uuid,uuid)'::regprocedure",
    );
    const reassignmentEnd = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION geo.enforce_publication_job_live_account",
      reassignmentStart,
    );
    const reassignmentGuard = migrationSql.slice(reassignmentStart, reassignmentEnd);
    const assistedGuardStart = reassignmentGuard.indexOf(
      "'geo.publication_assisted_block_reason(uuid)'::regprocedure",
    );
    const assistedGuard = reassignmentGuard.slice(assistedGuardStart);
    const guard = latestFunctionDefinition("enforce_publication_job_live_account");
    const normalizedGuard = guard.toLowerCase();

    expect(monotonicGuard).toContain("old.archived_at is not null");
    expect(monotonicGuard).toContain("new.status <> 'disabled'");
    expect(migrationSql).toContain("CREATE TRIGGER channel_accounts_archive_is_monotonic");
    expect(reassignmentStart).toBeGreaterThanOrEqual(0);
    expect(reassignmentGuard).toContain("account.archived_at IS NULL");
    expect(reassignmentGuard).toContain("FOR SHARE OF account");
    expect(reassignmentGuard).toContain("automation reassignment archive guard found no changes");
    expect(assistedGuardStart).toBeGreaterThanOrEqual(0);
    expect(assistedGuard).toContain("channel_account.archived_at IS NULL");
    expect(assistedGuard).toContain("assisted publication archive guard found no changes");
    expect(normalizedGuard).toContain("account.archived_at is null");
    expect(normalizedGuard).toContain("for share of account");
    expect(normalizedGuard).toContain("account_row.status <> 'active'");
    expect(migrationSql).toContain("CREATE TRIGGER publication_jobs_require_live_account");
    expect(migrationSql).toContain("BEFORE INSERT ON geo.publication_jobs");
  });

  it("schedules publication jobs and their outbox event at the same first-attempt time", () => {
    const consume = functionOverloadDefinition(
      "consume_publication_grant",
      "p_scheduled_for timestamptz",
    );
    expect(consume).toContain("p_execution_level text");
    expect(consume).toContain("available_at, scheduled_for");
    expect(consume).toContain("available_at");
    expect(consume).toContain("p_scheduled_for");
    expect(consume).toContain("INSERT INTO geo.outbox_events");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz) TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) TO geo_runtime",
    );
  });

  it("admits only current governed Ctrip assisted grants through a narrow function", () => {
    const consume = functionDefinition("consume_ctrip_assisted_publication_grant");
    expect(consume).toContain("SECURITY DEFINER");
    expect(consume).toContain("p_execution_level <> 'assisted'");
    expect(consume).toContain("grant_row.platform <> 'ctrip_community'");
    expect(consume).toContain("account_row.capability <> 'browser_assisted'");
    expect(consume).toContain("account_row.last_verified_at");
    expect(consume).toContain("interval '24 hours'");
    expect(consume).toContain("control_row.kill_switch_enabled");
    expect(consume).toContain("control_row.mode IN ('shadow', 'paused', 'stopped')");
    expect(consume).toContain("scoped_control.mode IN ('shadow', 'paused', 'stopped')");
    expect(consume).toContain("breaker.state IN ('open', 'half_open')");
    expect(consume).toContain("INSERT INTO geo.publication_jobs");
    expect(consume).toContain("INSERT INTO geo.outbox_events");
    expect(consume).toContain("publication_grant.ctrip_assisted_consumed");
    expect(migrationSql).toMatch(
      /GRANT EXECUTE ON FUNCTION geo\.consume_ctrip_assisted_publication_grant\(\s*uuid, geo\.sha256_hex, text, geo\.sha256_hex, text, timestamptz\s*\) TO geo_runtime/u,
    );
  });

  it("distinguishes missing and conflicting grant revocations under a row lock", () => {
    const revoke = latestFunctionDefinition("revoke_publication_grant");
    expect(revoke).toContain("FOR UPDATE");
    expect(revoke).toContain("ERRCODE = 'P0002'");
    expect(revoke).toContain("ERRCODE = '55000'");
  });

  it("cancels only lease-safe jobs and dead-letters their unpublished request atomically", () => {
    const cancel = latestFunctionDefinition("cancel_publication_job");
    expect(cancel).toContain("SECURITY DEFINER");
    expect(cancel).toContain("FOR UPDATE");
    expect(cancel).toContain("queued', 'retry_wait");
    expect(cancel).toContain("lease_expires_at");
    expect(cancel).toContain("event.locked_until >= statement_timestamp()");
    expect(cancel).toContain("ERRCODE = '55006'");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("UPDATE geo.outbox_events");
    expect(cancel).toContain("dead_lettered_at = clock_timestamp()");
    expect(cancel).toContain("published_at IS NULL");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.cancel_publication_job(uuid, text) TO geo_runtime",
    );
  });

  it("persists truthful dry-run disposition and rejects unsupported live readbacks", () => {
    const readbackTable = tableDefinition("publication_readbacks");
    const scheduleReadback = latestFunctionDefinition("schedule_publication_readback");
    expect(readbackTable).toContain("receipt_id uuid NOT NULL");
    expect(readbackTable).toContain("required boolean NOT NULL");
    expect(readbackTable).toContain("'not_required'");
    expect(readbackTable).toContain("'pending'");
    expect(scheduleReadback).toContain("execution_level <> 'dry_run'");
    expect(scheduleReadback).toContain("'not_required'");
    expect(scheduleReadback).toContain("'dry_run_preview_only'");
    expect(scheduleReadback).toContain("ERRCODE = '0A000'");
    expect(scheduleReadback).not.toContain("'publication.readback.requested'");
    expect(scheduleReadback).not.toContain("INSERT INTO geo.outbox_events");
    expect(migrationSql).toContain("GRANT SELECT ON geo.publication_readbacks TO geo_runtime");
    expect(migrationSql).toContain(
      "GRANT UPDATE (status, completed_at, last_error) ON geo.publication_readbacks TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "REVOKE INSERT, DELETE ON geo.publication_readbacks FROM geo_runtime",
    );
  });

  it("loads the publication job before enforcing publisher-status readback leases", () => {
    const confirmPublisherStatus = latestFunctionDefinition(
      "record_publication_assisted_publisher_status_confirmation",
    );
    const loadJob = confirmPublisherStatus.indexOf("SELECT * INTO job");
    const enforceLease = confirmPublisherStatus.indexOf("job.execution_level = 'unattended'");

    expect(loadJob).toBeGreaterThanOrEqual(0);
    expect(enforceLease).toBeGreaterThan(loadJob);
    expect(confirmPublisherStatus).toContain(
      "handoff.readback_owner_principal_id IS DISTINCT FROM actor_value",
    );
    expect(confirmPublisherStatus).toContain("handoff.readback_lease_expires_at IS NULL");
  });

  it("acquires publication execution under atomic multi-scope quotas and a single half-open probe", () => {
    const acquire = latestFunctionDefinition("acquire_publication_execution");
    expect(acquire).toContain("SECURITY DEFINER");
    expect(acquire).toContain("FOR UPDATE OF job");
    expect(acquire).toContain("geo.content_versions");
    expect(acquire).toContain("geo.content_items");
    expect(acquire).toContain("geo.publication_grants");
    expect(acquire).toContain("geo.audit_artifacts");
    expect(acquire).toContain("authorization_expired");
    expect(acquire).toContain("authorization_binding_mismatch");
    for (const scope of ["tenant", "platform", "account", "campaign", "topic"]) {
      expect(acquire).toContain(`'${scope}'`);
    }
    for (const quotaKey of [
      "maxConcurrent",
      "perMinute",
      "perDay",
      "cooldownSeconds",
      "errorBudget",
    ]) {
      expect(acquire).toContain(`'${quotaKey}'`);
    }
    expect(acquire).toContain("jsonb_object_keys");
    expect(acquire).toContain("quota_unknown");
    expect(acquire).toContain("INSERT INTO geo.publication_attempts");
    expect(acquire).toContain("state = 'dispatching'");
    expect(acquire).toContain("probe_attempt_id = p_attempt_id");
    expect(acquire).toContain("publication_execution.denied");
    expect(migrationSql).toContain("$replacement$attempt.state = 'failed'$replacement$");
    expect(migrationSql).toContain("$replacement$prior_attempt.state = 'failed'$replacement$");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.acquire_publication_execution(uuid, uuid, text) TO geo_runtime",
    );
  });

  it("finishes an acquired attempt and closes or reopens its claimed circuits", () => {
    const finish = functionOverloadDefinition("finish_publication_execution", "p_outcome text");
    expect(finish).toContain("succeeded', 'failed', 'uncertain");
    expect(finish).toContain("PERFORM circuit.id");
    expect(finish.indexOf("PERFORM circuit.id")).toBeLessThan(finish.indexOf("FOR UPDATE OF job"));
    expect(finish).toContain("UPDATE geo.publication_attempts");
    expect(finish).toContain("governance_finished_at");
    expect(finish).toContain("probe_attempt_id = p_attempt_id");
    expect(finish).toContain("state = 'closed'");
    expect(finish).toContain("state = 'open'");
    expect(finish).toContain("lease_owner = NULL");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, text, text) TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, boolean, text) TO geo_runtime",
    );
  });

  it("exposes a lease-bounded dispatcher claim without table grants", () => {
    const claim = functionDefinition("claim_outbox_events");
    expect(claim).toContain("SECURITY DEFINER");
    expect(claim).toContain("SKIP LOCKED");
    expect(claim).toContain("PARTITION BY event.tenant_id");
    expect(claim).toContain("p_limit NOT BETWEEN 1 AND 100");
    expect(migrationSql).toContain("GRANT EXECUTE ON FUNCTION geo.claim_outbox_events");
  });

  it("persists dry-run automation batches, leased runs, and target checkpoints", () => {
    const batches = tableDefinition("automation_batches");
    const runs = tableDefinition("automation_runs");
    const targets = tableDefinition("automation_run_targets");

    expect(batches).toContain(
      "'scheduled', 'running', 'completed', 'partially_failed', 'cancelled'",
    );
    expect(batches).toContain("execution_level = 'dry_run'");
    expect(batches).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(runs).toContain("slot_key text NOT NULL");
    expect(runs).toContain("UNIQUE (tenant_id, batch_id, slot_key)");
    expect(runs).toContain("'scheduled', 'running', 'retry_wait', 'awaiting_delivery'");
    expect(runs).toContain("stage IN ('planning', 'draft', 'targets', 'delivery')");
    expect(runs).toContain("attempt_count integer NOT NULL DEFAULT 0");
    expect(runs).toContain("lease_owner text");
    expect(runs).toContain("heartbeat_at timestamptz");
    expect(runs).toContain("checkpoint jsonb NOT NULL");
    expect(runs).toContain("content_item_id uuid");
    expect(runs).toContain("content_version_id uuid");
    expect(targets).toContain("channel_account_id uuid NOT NULL");
    expect(targets).toContain("variant_idempotency_key text NOT NULL");
    expect(targets).toContain("audit_idempotency_key text NOT NULL");
    expect(targets).toContain("publication_idempotency_key text NOT NULL");
    expect(targets).toContain("variant_id uuid");
    expect(targets).toContain("audit_run_id uuid");
    expect(targets).toContain("audit_artifact_id uuid");
    expect(targets).toContain("publication_job_id uuid");
  });

  it("backfills automation execution only for existing managing owners and admins", () => {
    expect(migrationSql).toContain("UPDATE geo.tenant_memberships AS membership");
    expect(migrationSql).toContain("membership.role IN ('owner', 'admin')");
    expect(migrationSql).toContain("membership.capabilities @> '[\"automation:manage\"]'::jsonb");
    expect(migrationSql).toContain(
      "NOT membership.capabilities @> '[\"automation:execute\"]'::jsonb",
    );
  });

  it("persists scoped automation principals and backfills principal management", () => {
    expect(migrationSql).toContain("ALTER TABLE geo.service_principals");
    expect(migrationSql).toContain("ADD COLUMN capabilities jsonb NOT NULL");
    expect(migrationSql).toContain("ADD COLUMN profile text NOT NULL");
    expect(migrationSql).toContain("'automation_producer'");
    expect(migrationSql).toContain("service_principals_automation_profile_scope");
    expect(migrationSql).toContain("UPDATE geo.tenant_memberships AS membership");
    expect(migrationSql).toContain("'[\"principal:manage\"]'::jsonb");
    expect(migrationSql).toContain("membership.role IN ('owner', 'admin')");
  });

  it("normalizes and constrains manual channel accounts to dry-run execution", () => {
    expect(migrationSql).toContain("UPDATE geo.channel_accounts");
    expect(migrationSql).toContain("supported_execution_levels = ARRAY['dry_run']::text[]");
    expect(migrationSql).toContain("channel_accounts_manual_execution_scope");
    expect(migrationSql).toContain("capability IN ('manual_only', 'disabled')");
    expect(migrationSql).toContain("capability <> 'browser_assisted'");
  });

  it("allows only one current primary contact per tenant and contact type", () => {
    expect(migrationSql).toContain("tenant_contacts_one_current_primary_per_type");
    expect(migrationSql).toContain("ON geo.tenant_contacts (tenant_id, type)");
    expect(migrationSql).toContain("WHERE is_primary AND valid_until IS NULL");
  });

  it("allows only one active policy bundle per tenant", () => {
    expect(migrationSql).toContain("policy_bundles_one_active_per_tenant");
    expect(migrationSql).toContain("ON geo.policy_bundles (tenant_id)");
    expect(migrationSql).toContain("WHERE status = 'active'");
  });

  it("creates tenant members through a scoped audited identity function", () => {
    const createMember = latestFunctionDefinition("create_tenant_member_identity");
    expect(createMember).toContain("SECURITY DEFINER");
    expect(createMember).toContain("geo.require_tenant_id()");
    expect(createMember).toContain("geo.require_actor_id()");
    expect(createMember).toContain("actor_role NOT IN ('owner', 'admin')");
    expect(createMember).toContain("only an owner may create another owner");
    expect(createMember).toContain("INSERT INTO geo.users");
    expect(createMember).toContain("INSERT INTO geo.tenant_memberships");
    expect(createMember).toContain("INSERT INTO geo.audit_log");
    expect(createMember).toContain("tenant_member.created");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)",
    );
  });

  it("gives automation operators the exact producer scope without Ctrip operator authority", () => {
    const createMember = latestFunctionDefinition("create_tenant_member_identity");
    const publicationOperator = latestFunctionDefinition("require_publication_operator");

    expect(migrationSql).toContain("ADD CONSTRAINT tenant_memberships_role_check");
    expect(migrationSql).toContain(
      "'owner', 'admin', 'editor', 'auditor', 'publisher', 'automation_operator', 'viewer'",
    );
    expect(migrationSql).toContain("tenant_memberships_automation_operator_scope");
    expect(migrationSql).toContain("jsonb_array_length(capabilities) = 8");
    expect(migrationSql).toContain("capabilities <@ '[");
    expect(createMember).toContain("'automation_operator'");
    expect(createMember).toContain("WHEN 'automation_operator' THEN");
    for (const capability of [
      "tenant:read",
      "content:read",
      "content:write",
      "audit:read",
      "audit:run",
      "publish:request",
      "receipt:read",
      "automation:execute",
    ]) {
      expect(createMember).toContain(`"${capability}"`);
    }
    expect(publicationOperator).toContain("membership.role IN ('owner', 'admin', 'publisher')");
    expect(publicationOperator).not.toContain("automation_operator");
  });

  it("reads tenant member identities without weakening user self-isolation", () => {
    const listMembers = latestFunctionDefinition("list_tenant_member_identities");
    const getMember = latestFunctionDefinition("get_tenant_member_identity");
    for (const definition of [listMembers, getMember]) {
      expect(definition).toContain("SECURITY DEFINER");
      expect(definition).toContain("geo.require_tenant_id()");
      expect(definition).toContain("geo.require_actor_id()");
      expect(definition).toContain("actor_role NOT IN ('owner', 'admin')");
      expect(definition).toContain("membership.tenant_id = tenant_value");
      expect(definition).toContain("users.email");
      expect(definition).not.toContain("password_hash");
    }
    expect(getMember).toContain("FOR UPDATE OF membership");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.list_tenant_member_identities() TO geo_runtime",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.get_tenant_member_identity(uuid) TO geo_runtime",
    );
  });

  it("claims automation runs with expiry recovery and fail-closed governance", () => {
    const blockReason = functionDefinition("automation_run_block_reason");
    const claim = functionDefinition("claim_automation_runs");

    expect(blockReason).toContain("control_missing:tenant:*");
    expect(blockReason).toContain("control.kill_switch_enabled");
    expect(blockReason).toContain("control.mode IN ('paused', 'stopped')");
    expect(blockReason).toContain("breaker.state IN ('open', 'half_open')");
    for (const scope of ["tenant", "campaign", "topic"]) {
      expect(blockReason).toContain(`'${scope}'`);
    }
    expect(claim).toContain("SECURITY DEFINER");
    expect(claim).toContain("FOR UPDATE OF run SKIP LOCKED");
    expect(claim).toContain("run.lease_expires_at < statement_timestamp()");
    expect(claim).toContain("run.attempt_count < run.max_attempts");
    expect(claim).toContain("batch.state IN ('scheduled', 'running')");
    expect(claim).toContain("geo.automation_run_block_reason");
    expect(claim).not.toContain("geo.outbox_events");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime",
    );
  });

  it("binds substantive automation checkpoints under the active lease and gate", () => {
    const heartbeat = functionDefinition("heartbeat_automation_run");
    const draft = functionDefinition("checkpoint_automation_draft");
    const target = functionDefinition("checkpoint_automation_target");
    const reconcile = functionDefinition("reconcile_automation_run");

    expect(heartbeat).toContain("heartbeat cannot change automation run stage");
    for (const checkpoint of [draft, target]) {
      expect(checkpoint).toContain("SECURITY DEFINER");
      expect(checkpoint).toContain("FOR UPDATE");
      expect(checkpoint).toContain("run_row.lease_owner <> p_worker_id");
      expect(checkpoint).toContain("run_row.attempt_count <> p_attempt_count");
      expect(checkpoint).toContain("run_row.lease_expires_at < statement_timestamp()");
      expect(checkpoint).toContain("geo.automation_run_block_reason");
    }
    expect(draft).toContain("item.campaign_id = run_row.campaign_id");
    expect(draft).toContain("content_item_id = p_content_item_id");
    expect(target).toContain("automation target transition");
    expect(migrationSql).toContain(
      "p_new_state IN ('audit_failed', 'awaiting_manual_review', 'awaiting_delivery', 'blocked', 'failed', 'cancelled')",
    );
    expect(target).toContain("job.execution_level = 'dry_run'");
    expect(target).toContain("artifact.status = 'passed'");
    expect(target).toContain("audit_artifact_value IS NOT NULL AND audit_run_value IS NULL");
    expect(target).toContain("SELECT artifact.audit_run_id INTO audit_run_value");
    expect(reconcile).toContain("target.state = 'awaiting_delivery'");
    expect(reconcile).toContain("target.state IN ('pending', 'variant_ready')");
    expect(reconcile).toContain("next_state := 'partially_failed'");
    expect(reconcile).toContain("next_state := 'retry_wait'");
    expect(reconcile).toContain("lease_owner = NULL");
    expect(reconcile).toContain("geo.refresh_automation_batch_state");
    expect(reconcile).not.toContain("geo.outbox_events");
    expect(migrationSql).toContain("resource conflicts preserve attempt budget");
    expect(migrationSql).toContain("p_error_code = 'RESOURCE_CONFLICT'");
    expect(migrationSql).toContain("attempt_count = CASE");
    expect(migrationSql).toContain("greatest(run.attempt_count - 1, 0)");
    expect(migrationSql).toContain("resource_wait_count = CASE");
  });

  it("cancels automation without a re-claim path and denies direct state mutation", () => {
    const cancel = latestFunctionDefinition("cancel_automation_batch");
    expect(cancel).toContain("pg_advisory_xact_lock");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("lease_owner = NULL");
    expect(cancel).toContain("geo.cancel_publication_assisted_handoff");
    expect(cancel).toContain("geo.cancel_publication_job");
    expect(cancel).toContain("draft_prepare_owner_principal_id = NULL");
    expect(cancel).toContain("readback_owner_principal_id = NULL");
    expect(cancel).not.toContain("handoff.state IN ('submitted_unconfirmed', 'readback_pending'");
    expect(cancel).toContain("automation_batch.cancelled");
    expect(cancel).toContain("INSERT INTO geo.audit_log");
    expect(cancel).toContain("event.locked_until >= statement_timestamp()");
    expect(migrationSql).toContain(
      "REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE geo.automation_batches",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.cancel_automation_batch(uuid, text) TO geo_runtime",
    );
  });

  it("persists tenant-scoped assisted handoffs with leased operators and one-time permits", () => {
    const handoffs = tableDefinition("publication_assisted_handoffs");
    const blockReason = functionDefinition("publication_assisted_block_reason");
    const create = functionDefinition("create_publication_assisted_handoff");
    const claim = functionDefinition("claim_publication_assisted_handoff");
    const heartbeat = functionDefinition("heartbeat_publication_assisted_handoff");
    const cancel = functionDefinition("cancel_publication_assisted_handoff");
    const issuePermit = functionDefinition("issue_publication_assisted_submit_permit");
    const consumePermit = functionDefinition("consume_publication_assisted_submit_permit");

    expect(handoffs).toContain("job_id uuid NOT NULL");
    expect(handoffs).toContain("attempt_id uuid NOT NULL");
    expect(handoffs).toContain("platform text NOT NULL DEFAULT 'ctrip_community'");
    expect(handoffs).toContain("payload_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("audit_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("preview_hash geo.sha256_hex NOT NULL");
    expect(handoffs).toContain("adapter_version text NOT NULL");
    expect(handoffs).toContain("lease_owner_actor_id uuid");
    expect(handoffs).toContain("lease_expires_at timestamptz");
    expect(handoffs).toContain("submit_permit_hash geo.sha256_hex");
    expect(handoffs).toContain("submit_permit_expires_at timestamptz");
    expect(handoffs).toContain("submit_permit_consumed_at timestamptz");
    expect(handoffs).toContain("'draft_prepared'");
    expect(handoffs).toContain("'submitted_unconfirmed'");
    expect(handoffs).toContain("'confirmed'");
    expect(handoffs).toContain("UNIQUE (tenant_id, job_id)");
    expect(handoffs).toContain("UNIQUE (tenant_id, attempt_id)");

    expect(blockReason).toContain("job.execution_level <> 'assisted'");
    expect(blockReason).toContain("job.platform <> 'ctrip_community'");
    expect(blockReason).toContain("artifact.status <> 'passed'");
    expect(blockReason).toContain("control.kill_switch_enabled");
    expect(blockReason).toContain("control.mode IN ('shadow', 'paused', 'stopped')");
    expect(blockReason).toContain("circuit.state IN ('open', 'half_open')");
    expect(blockReason).toContain("account.capability <> 'browser_assisted'");

    expect(create).toContain("SECURITY DEFINER");
    expect(create).toContain("geo.publication_assisted_block_reason");
    expect(create).toContain("attempt.state <> 'started'");
    expect(create).toContain("INSERT INTO geo.publication_assisted_handoffs");
    expect(create).toContain("publication_assisted_handoff.created");

    expect(claim).toContain("FOR UPDATE");
    expect(claim).toContain("lease_expires_at >= statement_timestamp()");
    expect(claim).toContain("lease_owner_actor_id = actor_value");
    expect(claim).toContain("geo.publication_assisted_block_reason");
    expect(claim).toContain("LEAST(");
    expect(claim).toContain("publication_assisted_handoff.claimed");
    expect(heartbeat).toContain("lease_owner_actor_id <> actor_value");
    expect(heartbeat).toContain("lease_expires_at < statement_timestamp()");
    expect(heartbeat).toContain("geo.publication_assisted_block_reason");
    expect(cancel).toContain("state = 'cancelled'");
    expect(cancel).toContain("submit_permit_consumed_at IS NOT NULL");
    expect(cancel).toContain("publication_assisted_handoff.cancelled");

    expect(issuePermit).toContain("state <> 'draft_prepared'");
    expect(issuePermit).toContain("geo.publication_assisted_block_reason");
    expect(issuePermit).toContain("public.gen_random_bytes(32)");
    expect(issuePermit).toContain("submit_permit_hash");
    expect(issuePermit).toContain("interval '5 minutes'");
    expect(issuePermit).toContain("handoff.lease_expires_at");
    expect(consumePermit).toContain("public.digest(p_submit_permit, 'sha256')");
    expect(consumePermit).toContain("submit_permit_consumed_at IS NOT NULL");
    expect(consumePermit).toContain("geo.publication_assisted_block_reason");
    expect(consumePermit).toContain("lease_owner_actor_id <> actor_value");

    expect(migrationSql).toContain("CREATE TRIGGER publication_assisted_handoffs_transition_only");
    expect(migrationSql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE geo\.publication_assisted_handoffs/u,
    );
  });

  it("synchronizes every terminal Ctrip handoff into its publication job and attempt", () => {
    const terminalSync = latestFunctionDefinition("sync_ctrip_handoff_terminal_job");
    expect(terminalSync).toContain("SECURITY DEFINER");
    expect(terminalSync).toContain(
      "NEW.state NOT IN ('confirmed', 'needs_review', 'failed', 'expired', 'cancelled')",
    );
    expect(terminalSync).toContain("UPDATE geo.publication_attempts AS attempt");
    expect(terminalSync).toContain("governance_finished_at = terminal_at");
    expect(terminalSync).toContain("UPDATE geo.publication_jobs AS job");
    expect(terminalSync).toContain("lease_owner = NULL");
    expect(terminalSync).toContain("'publication_assisted_handoff.job_terminal_synced'");
    expect(migrationSql).toContain("CREATE TRIGGER publication_assisted_handoff_terminal_sync");
    expect(migrationSql).toContain("Repair terminal handoffs created before this trigger existed");
  });

  it("separates Ctrip operator approval from exact bridge execution authority", () => {
    const create = functionOverloadDefinition(
      "create_publication_assisted_handoff",
      "p_bridge_service_principal_id uuid",
    );
    const bridgeStatus = latestFunctionDefinition("record_publication_assisted_bridge_status");
    const draft = latestFunctionDefinition("record_publication_assisted_draft");
    const issuePermit = latestFunctionDefinition("issue_publication_assisted_submit_permit");
    const consumePermit = latestFunctionDefinition("consume_publication_assisted_submit_permit");

    for (const column of [
      "bridge_service_principal_id",
      "external_draft_id",
      "submit_permit_issued_by_actor_id",
      "submit_permit_consumed_by_principal_id",
    ]) {
      expect(migrationSql).toContain(`ADD COLUMN ${column}`);
    }
    expect(migrationSql).toContain("'ctrip_bridge'");
    expect(migrationSql).toContain('"publish:bridge"');
    expect(create).toContain("geo.require_ctrip_bridge_principal");
    expect(create).toContain("bridge_service_principal_id");
    expect(bridgeStatus).toContain("geo.require_bound_ctrip_bridge");
    expect(bridgeStatus).toContain("'challenge_required'");
    expect(bridgeStatus).toContain("INSERT INTO geo.circuit_breakers");
    expect(draft).toContain("geo.require_bound_ctrip_bridge");
    expect(draft).toContain("p_external_draft_id");
    expect(issuePermit).toContain("geo.require_publication_operator");
    expect(issuePermit).toContain("submit_permit_issued_by_actor_id = actor_value");
    expect(consumePermit).toContain("geo.require_bound_ctrip_bridge");
    expect(consumePermit).toContain(
      "submit_permit_issued_by_actor_id <> handoff.lease_owner_actor_id",
    );
    expect(consumePermit).toContain("submit_permit_consumed_by_principal_id = actor_value");
    expect(migrationSql).toMatch(
      /REVOKE EXECUTE ON FUNCTION geo\.create_publication_assisted_handoff\(\s*uuid, uuid, uuid, geo\.sha256_hex, text, text, timestamptz\s*\) FROM geo_runtime/u,
    );
    expect(migrationSql).toContain("publication_assisted_handoff_permit_issuer_consistency");
    expect(migrationSql).toMatch(
      /publication_assisted_handoff_permit_issuer_consistency[\s\S]*?\) NOT VALID;/u,
    );
  });

  it("retains complete Ctrip prepare evidence for canary review", () => {
    const bridgeStatus = latestFunctionDefinition("record_publication_assisted_bridge_status");
    const draft = latestFunctionDefinition("record_publication_assisted_draft");
    const transition = latestFunctionDefinition("enforce_publication_assisted_handoff_transition");

    for (const column of [
      "prepare_outcome",
      "prepare_evidence_kind",
      "prepare_evidence_hash",
      "prepare_observed_at",
      "media_manifest_hash",
    ]) {
      expect(migrationSql).toContain(`ADD COLUMN ${column}`);
    }
    expect(migrationSql).toContain("publication_assisted_handoff_prepare_observation_complete");
    expect(bridgeStatus).toContain("prepare_outcome = next_prepare_outcome");
    expect(bridgeStatus).toContain("prepare_evidence_hash = p_prepare_evidence_hash");
    expect(bridgeStatus).toContain("prepare_evidence_kind = p_prepare_evidence_kind");
    expect(bridgeStatus).toContain("prepare_observed_at = p_prepare_observed_at");
    expect(bridgeStatus).toContain("last_error_message = next_error_message");
    expect(bridgeStatus).toContain("'diagnosticCode', next_error_message");
    expect(draft).toContain("prepare_outcome = 'prepared'");
    expect(draft).toContain("media_manifest_hash = p_media_manifest_hash");
    expect(draft).toContain("'mediaManifestHash', p_media_manifest_hash");
    expect(transition).toContain("'prepare_outcome'");
    expect(transition).toContain("'prepare_evidence_hash'");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(",
    );
  });

  it("keeps unattended submit claims retryable until permit consumption", () => {
    const claim = latestFunctionDefinition("claim_next_ctrip_unattended_submit");
    const consume = latestFunctionDefinition("consume_publication_assisted_submit_permit");
    const recover = latestFunctionDefinition("recover_publication_assisted_submit_uncertain");

    expect(claim).toContain("candidate.state = 'draft_prepared'");
    expect(claim).toContain("candidate.submit_permit_consumed_at IS NULL");
    expect(claim).toContain("stateTransitionDeferredUntilConsumption");
    expect(claim).not.toContain("SET state = 'awaiting_operator_submit'");
    expect(consume).toContain("handoff.state <> 'draft_prepared'");
    expect(consume).toContain(
      "WHEN job.execution_level = 'unattended' THEN 'awaiting_operator_submit'",
    );
    expect(recover).toContain("job.execution_level = 'unattended'");
    expect(recover).toContain("submit_permit_issued_by_principal_id = actor_value");
    expect(recover).toContain("job.execution_level = 'assisted'");
    expect(recover).toContain("submit_permit_issued_by_actor_id IS NOT NULL");
    expect(migrationSql).toContain("publication_assisted_handoff.unconsumed_permit_recovered");
  });

  it("keeps historical Ctrip canary records while removing Phase C admission", async () => {
    const canaries = tableDefinition("ctrip_phase_b_canaries");
    const phase = latestFunctionDefinition("ctrip_release_phase");
    const succeeded = latestFunctionDefinition("ctrip_phase_b_canary_succeeded");
    const immediateGateSql = await readFile(
      new URL("../migrations/0056_remove_ctrip_phase_c_admission.sql", import.meta.url),
      "utf8",
    );

    expect(canaries).toContain("UNIQUE (tenant_id, channel_account_id)");
    expect(canaries).toContain("UNIQUE (tenant_id, handoff_id)");
    expect(canaries).toContain("authorized_by_actor_id uuid NOT NULL");
    expect(migrationSql).toContain(
      "ALTER TABLE geo.ctrip_phase_b_canaries FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain("CREATE TRIGGER ctrip_phase_b_canaries_append_only");

    expect(phase).toContain("RETURN 'C';");
    expect(phase).not.toContain("geo.ctrip_phase_b_canary_succeeded");
    expect(succeeded).toContain("job.execution_level = 'assisted'");
    expect(succeeded).toContain("handoff.submit_outcome IN ('accepted', 'uncertain')");
    expect(succeeded).toContain("handoff.submit_evidence_kind = 'browser'");
    expect(succeeded).toContain("handoff.readback_outcome = 'confirmed'");
    expect(succeeded).toContain("handoff.readback_evidence_kind = 'platform_readback'");
    expect(succeeded).toContain("handoff.observed_payload_hash = handoff.public_content_hash");

    expect(immediateGateSql).toContain(
      "DROP TRIGGER IF EXISTS automation_controls_ctrip_release_phase",
    );
    expect(immediateGateSql).toContain("Ctrip assisted permit Phase B removal");
    expect(immediateGateSql).toContain("Ctrip unattended claim Phase C removal");
    expect(immediateGateSql).toContain("'releaseMode', 'immediate'");
  });

  it("makes system-created Ctrip account controls immediately unattended", async () => {
    const immediateControlSql = await readFile(
      new URL("../migrations/0061_immediate_ctrip_account_controls.sql", import.meta.url),
      "utf8",
    );

    expect(immediateControlSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.sync_channel_account_capacity_control()",
    );
    expect(immediateControlSql).toContain("'unattended' = ANY(NEW.supported_execution_levels)");
    expect(immediateControlSql).toContain("THEN 'unattended'");
    expect(immediateControlSql).toContain("reason = 'Default per-account publication capacity'");
    expect(immediateControlSql).toContain("control.mode = 'supervised'");
    expect(immediateControlSql).not.toContain("WHERE control.scope_type = 'account';");
  });

  it("extends ready browser unattended execution to every supported platform", async () => {
    const genericUnattendedSql = await readFile(
      new URL("../migrations/0080_generic_browser_unattended.sql", import.meta.url),
      "utf8",
    );

    expect(genericUnattendedSql).toContain("channel_accounts_browser_unattended_scope");
    expect(genericUnattendedSql).toContain(
      "capability IN ('public_api', 'partner_api', 'browser_assisted')",
    );
    expect(genericUnattendedSql).toContain("runtime.platform = account.platform");
    expect(genericUnattendedSql).toContain("runtime.session_state IN ('authenticated', 'ready')");
    expect(genericUnattendedSql).toContain(
      "generic browser block-reason unattended admission found no changes",
    );
    expect(genericUnattendedSql).toContain(
      "generic browser grant unattended admission found no changes",
    );
    expect(genericUnattendedSql).toContain(
      "generic automation reassignment unattended admission found no changes",
    );
  });

  it("lets every supported unattended browser platform claim public readback work", async () => {
    const genericReadbackClaimSql = await readFile(
      new URL("../migrations/0081_generic_browser_readback_claims.sql", import.meta.url),
      "utf8",
    );

    expect(genericReadbackClaimSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_readback()",
    );
    expect(genericReadbackClaimSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_ctrip_unattended_readback(p_handoff_id uuid)",
    );
    expect(genericReadbackClaimSql).toContain(
      "job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')",
    );
    expect(genericReadbackClaimSql).toContain("job.platform = candidate.platform");
    expect(genericReadbackClaimSql).not.toContain("job.platform = 'ctrip_community'");
  });

  it("bounds automatic priority-platform review polling without removing targeted queries", async () => {
    const reviewWindowSql = await readFile(
      new URL("../migrations/0082_priority_platform_review_poll_window.sql", import.meta.url),
      "utf8",
    );

    expect(reviewWindowSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_readback()",
    );
    expect(reviewWindowSql).toContain("statement_timestamp() - interval '10 minutes'");
    expect(reviewWindowSql).toContain("candidate.platform = 'ctrip_community'");
    expect(reviewWindowSql).not.toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_ctrip_unattended_readback(p_handoff_id uuid)",
    );
    expect(reviewWindowSql).toContain("'automaticWindowMinutes', 10");
  });

  it("persists native priority-platform account analytics through account-scoped leases", async () => {
    const analyticsSql = await readFile(
      new URL("../migrations/0083_priority_platform_account_analytics.sql", import.meta.url),
      "utf8",
    );

    expect(analyticsSql).toContain("ADD COLUMN total_impressions bigint");
    expect(analyticsSql).toContain("ADD COLUMN total_reads bigint");
    expect(analyticsSql).toContain("ADD COLUMN total_likes bigint");
    expect(analyticsSql).toContain("ADD COLUMN total_comments bigint");
    expect(analyticsSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(",
    );
    expect(analyticsSql).toContain("account.platform = 'toutiao'");
    expect(analyticsSql).toContain("runtime.platform = account.platform");
    expect(analyticsSql).toContain("runtime.session_state IN ('authenticated', 'ready')");
  });

  it("keeps analytics collection behind active publication and readback work", async () => {
    const analyticsSchedulingSql = await readFile(
      new URL(
        "../migrations/0126_priority_platform_analytics_publication_exclusion.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(analyticsSchedulingSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(",
    );
    expect(analyticsSchedulingSql).toContain(
      "FROM geo.publication_assisted_handoffs AS active_handoff",
    );
    for (const state of [
      "handoff_pending",
      "session_required",
      "challenge_required",
      "draft_prepared",
      "awaiting_operator_submit",
      "submitted_unconfirmed",
      "readback_pending",
    ]) {
      expect(analyticsSchedulingSql).toContain(`'${state}'`);
    }
    expect(analyticsSchedulingSql).toContain(
      "active_handoff.channel_account_id = sync.channel_account_id",
    );
  });

  it("persists globally managed runtime provider model and API configuration", async () => {
    const providerConfigSql = await readFile(
      new URL("../migrations/0084_runtime_provider_configurations.sql", import.meta.url),
      "utf8",
    );

    expect(providerConfigSql).toContain("CREATE TABLE geo.runtime_provider_configurations");
    expect(providerConfigSql).toContain("config_key text PRIMARY KEY");
    expect(providerConfigSql).toContain("api_key text");
    expect(providerConfigSql).toContain("version integer");
    expect(providerConfigSql).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE geo.runtime_provider_configurations TO geo_runtime",
    );
    expect(providerConfigSql).not.toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("tracks tenant-scoped manual media review decisions per content version", async () => {
    const reviewSql = await readFile(
      new URL("../migrations/0085_manual_media_reviews.sql", import.meta.url),
      "utf8",
    );

    expect(reviewSql).toContain("CREATE TABLE geo.manual_media_reviews");
    expect(reviewSql).toContain("UNIQUE (tenant_id, content_version_id)");
    expect(reviewSql).toContain("media_snapshot_hash geo.sha256_hex");
    expect(reviewSql).toContain("status <> 'confirmed' OR cardinality(actions) = 0");
    expect(reviewSql).toContain("CREATE POLICY tenant_isolation");
    expect(reviewSql).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE geo.manual_media_reviews TO geo_runtime",
    );
  });

  it("force calibrates account runtime with lease and breaker recovery", async () => {
    const forceCalibrationSql = await readFile(
      new URL("../migrations/0086_force_calibrate_account_runtime.sql", import.meta.url),
      "utf8",
    );

    expect(forceCalibrationSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.force_calibrate_channel_account_runtime(",
    );
    expect(forceCalibrationSql).toContain("SET session_state = 'ready'");
    expect(forceCalibrationSql).toContain("draft_prepare_owner_principal_id = NULL");
    expect(forceCalibrationSql).toContain("breaker.state IN ('open', 'half_open')");
    expect(forceCalibrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz)",
    );
  });

  it("keeps manual runtime calibration stable through transient negative probes", async () => {
    const calibrationStabilitySql = await readFile(
      new URL("../migrations/0095_stabilize_manual_runtime_calibration.sql", import.meta.url),
      "utf8",
    );

    expect(calibrationStabilitySql).toContain("ADD COLUMN manual_ready_until timestamptz");
    expect(calibrationStabilitySql).toContain(
      "CREATE OR REPLACE FUNCTION geo.preserve_manual_runtime_calibration()",
    );
    expect(calibrationStabilitySql).toContain(
      "NEW.session_state IN ('session_required', 'challenge_required', 'unavailable')",
    );
    expect(calibrationStabilitySql).toContain("OLD.manual_ready_until > clock_timestamp()");
  });

  it("keeps manual runtime calibration through authenticated readiness probes", async () => {
    const calibrationProbeSql = await readFile(
      new URL("../migrations/0105_preserve_manual_calibration_probe.sql", import.meta.url),
      "utf8",
    );

    expect(calibrationProbeSql).toContain("NEW.session_state IN ('authenticated', 'ready')");
    expect(calibrationProbeSql).toContain("OLD.session_state IN ('authenticated', 'ready')");
    expect(calibrationProbeSql).toContain("NEW.manual_ready_until := OLD.manual_ready_until");
  });

  it("allows only pending unclaimed automation targets to change accounts", async () => {
    const reassignmentSql = await readFile(
      new URL("../migrations/0062_pending_automation_target_reassignment.sql", import.meta.url),
      "utf8",
    );

    expect(reassignmentSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.reassign_pending_automation_target(",
    );
    expect(reassignmentSql).toContain("run_row.state <> 'scheduled'");
    expect(reassignmentSql).toContain("run_row.attempt_count <> 0");
    expect(reassignmentSql).toContain("target_row.state <> 'pending'");
    expect(reassignmentSql).toContain("target_row.publication_job_id IS NOT NULL");
    expect(reassignmentSql).toContain("account_row.platform <> target_row.platform");
    expect(reassignmentSql).toContain("automation_target.assignment_changed");
    expect(reassignmentSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid)",
    );
    expect(reassignmentSql).toContain(
      "REVOKE UPDATE ON TABLE geo.automation_run_targets FROM geo_runtime",
    );
  });

  it("binds offline historical Ctrip publications into tenant duplicate-audit history", () => {
    const history = tableDefinition("historical_publications");
    const binding = latestFunctionDefinition("bind_historical_publication");
    const protectedBaseline = latestFunctionDefinition("ctrip_protected_history_baseline_bound");

    expect(history).toContain("channel_account_id uuid NOT NULL");
    expect(history).toContain("platform text NOT NULL DEFAULT 'ctrip_community'");
    expect(history).toContain("public_content_hash geo.sha256_hex NOT NULL");
    expect(history).toContain("normalized_title text NOT NULL");
    expect(history).toContain("normalized_body text NOT NULL");
    expect(history).toContain("source_evidence_hash geo.sha256_hex NOT NULL");
    expect(history).toContain("bound_by_actor_id uuid NOT NULL");
    expect(history).toContain("audit_log_id uuid NOT NULL");
    expect(history).toContain("UNIQUE (tenant_id, idempotency_key)");
    expect(history).toContain("UNIQUE (tenant_id, platform, external_id)");
    expect(history).toContain("UNIQUE (tenant_id, platform, public_content_hash)");
    expect(history).toMatch(
      /FOREIGN KEY \(tenant_id, channel_account_id, platform\)[\s\S]*REFERENCES geo\.channel_accounts \(tenant_id, id, platform\)/i,
    );
    expect(history).toMatch(
      /FOREIGN KEY \(tenant_id, bound_by_actor_id\)[\s\S]*REFERENCES geo\.tenant_memberships \(tenant_id, user_id\)/i,
    );
    expect(binding).toContain("membership.role IN ('owner', 'admin')");
    expect(binding).toContain("membership.status = 'active'");
    expect(binding).toContain("account.tenant_id = tenant_value");
    expect(binding).toContain("account.platform = 'ctrip_community'");
    expect(binding).toContain("public.digest");
    expect(binding).toContain("public-content hash does not match normalized content");
    expect(binding).toContain("idempotency key conflicts with another binding");
    expect(binding).toContain("identity or content conflicts with an existing binding");
    expect(binding).toContain("'historical_publication.bound'");
    expect(binding).toContain("INSERT INTO geo.audit_log");
    expect(binding).toContain("INSERT INTO geo.historical_publications");
    expect(migrationSql).toContain(
      "GRANT SELECT ON TABLE geo.historical_publications TO geo_runtime",
    );
    expect(migrationSql).not.toContain(
      "GRANT INSERT ON TABLE geo.historical_publications TO geo_runtime",
    );
    expect(migrationSql).not.toContain(
      "GRANT EXECUTE ON FUNCTION geo.bind_historical_publication(",
    );
    expect(migrationSql).toContain("geo.ctrip_protected_history_baseline_bound");
    expect(migrationSql).toContain("history.external_id = '123450005'");
    expect(migrationSql).toContain(
      "https://m.ctrip.com/webapp/you/community/detail?articleId=123450005",
    );
    expect(migrationSql).toContain("ctrip_protected_history_baseline_missing");
    expect(migrationSql).toContain(
      "Ctrip protected history baseline insertion point was not found",
    );
    expect(protectedBaseline).toContain("account.tenant_id = tenant_value");
    expect(protectedBaseline).toContain("account.id = p_channel_account_id");
    expect(protectedBaseline).toContain("history.tenant_id = tenant_value");
    expect(protectedBaseline).not.toContain("history.channel_account_id = p_channel_account_id");
  });

  it("opens an account circuit for Ctrip session loss and requires a recovery lease", () => {
    const sessionCircuit = latestFunctionDefinition("open_ctrip_session_required_circuit");
    const draftLease = latestFunctionDefinition("require_ctrip_draft_prepare_lease");

    expect(sessionCircuit).toContain("NEW.tenant_id");
    expect(sessionCircuit).toContain("NEW.channel_account_id::text");
    expect(sessionCircuit).toContain("'ASSISTED_SESSION_REQUIRED'");
    expect(migrationSql).toContain(
      "CREATE TRIGGER publication_assisted_handoff_session_required_circuit",
    );
    expect(draftLease).toContain("OLD.draft_prepare_owner_principal_id IS NULL");
    expect(draftLease).toContain("OLD.draft_prepare_lease_expires_at IS NULL");
    expect(migrationSql).toContain(
      "CREATE TRIGGER publication_assisted_handoff_01_require_draft_prepare_lease",
    );
  });

  it("recovers assisted handoffs after a finite circuit cooldown", async () => {
    const sessionCircuit = latestFunctionDefinition("open_ctrip_session_required_circuit");
    const bridgeStatus = latestFunctionDefinition("record_publication_assisted_bridge_status");
    const draft = latestFunctionDefinition("record_publication_assisted_draft");
    const blockReason = latestFunctionDefinition("publication_assisted_block_reason");
    const claimNext = await readFile(
      new URL("../migrations/0137_account_scoped_publication_claims.sql", import.meta.url),
      "utf8",
    );
    const expireStale = latestFunctionDefinition("expire_stale_publication_assisted_handoffs");

    expect(sessionCircuit).toContain("statement_timestamp() + interval '10 minutes'");
    expect(bridgeStatus).toContain("statement_timestamp() + interval '10 minutes'");
    expect(draft).toContain("circuit_breakers");
    expect(draft).toContain("SET state = 'closed'");
    expect(draft).toContain("p_public_content_hash");
    expect(draft).toContain("public_content_hash = p_public_content_hash");
    expect(draft).toContain("draft_prepare_owner_principal_id = NULL");
    expect(draft).toContain("draft evidence requires the current draft preparation lease");
    expect(draft).toContain("'ASSISTED_ADAPTER_DRIFT'");
    expect(blockReason).toContain("circuit.retry_at > statement_timestamp()");
    expect(blockReason).toContain("app.allow_account_half_open_probe");
    expect(draft).toContain("set_config('app.allow_account_half_open_probe', 'true', true)");
    expect(claimNext).toContain("'session_required', 'challenge_required'");
    expect(claimNext).toContain("geo.expire_stale_publication_assisted_handoffs(100)");
    expect(claimNext).toContain("SET state = 'half_open'");
    expect(claimNext).toContain("probeArmed");
    expect(expireStale).toContain(
      "state IN ('handoff_pending', 'session_required', 'challenge_required')",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer) TO geo_runtime",
    );
    expect(migrationSql).toContain("browser grant cooldown recovery");
    expect(migrationSql).toContain("ASSISTED_CHALLENGE_REQUIRED");
    expect(migrationSql).toContain("breaker.retry_at > statement_timestamp()");
    expect(migrationSql).toContain("handoff half-open probe lineage");
    expect(migrationSql).toContain("probe_circuit.probe_attempt_id = probe_attempt.id");
    expect(migrationSql).toContain("probe_attempt.request_hash = job.request_hash");
    expect(migrationSql).toContain("probe_attempt.id = handoff.attempt_id");
    expect(migrationSql).toContain("probe_attempt.job_id = handoff.job_id");
  });

  it("claims browser delivery work at account scope while preserving cross-account parallelism", async () => {
    const accountClaimsSql = await readFile(
      new URL("../migrations/0137_account_scoped_publication_claims.sql", import.meta.url),
      "utf8",
    );

    expect(accountClaimsSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.publication_account_browser_operation_busy(",
    );
    expect(accountClaimsSql).toContain("publication_assisted_handoffs_account_claims");
    expect(accountClaimsSql).toContain(
      "active.draft_prepare_lease_expires_at > statement_timestamp()",
    );
    expect(accountClaimsSql).toContain("active.submit_permit_expires_at > statement_timestamp()");
    expect(accountClaimsSql).toContain("active.readback_lease_expires_at > statement_timestamp()");
    expect(accountClaimsSql).toContain("active.state = 'awaiting_operator_submit'");
    expect(accountClaimsSql).toContain("FOR UPDATE OF candidate, account SKIP LOCKED");
    expect(accountClaimsSql).toContain("NOT geo.publication_account_browser_operation_busy(");
    expect(accountClaimsSql).toContain("p_block_prepared => true");
    expect(accountClaimsSql).toContain("p_block_prepared => false");
  });

  it("stops Ctrip readback claims at the deadline and finite attempt budget", async () => {
    const budgetRepairSql = await readFile(
      new URL("../migrations/0139_ctrip_readback_budget_guard.sql", import.meta.url),
      "utf8",
    );

    expect(budgetRepairSql).toContain(
      "CREATE OR REPLACE FUNCTION geo.expire_ctrip_readback_budget()",
    );
    expect(budgetRepairSql).toContain("readback_attempt_count >= 100");
    expect(budgetRepairSql).toContain("ASSISTED_READBACK_ATTEMPTS_EXHAUSTED");
    expect(budgetRepairSql).toContain("candidate.readback_attempt_count < 100");
    expect(budgetRepairSql).toContain("candidate.readback_deadline_at >= statement_timestamp()");
    expect(budgetRepairSql).toContain("PERFORM geo.expire_ctrip_readback_budget()");
  });

  it("repairs only unconsumed nonterminal Ctrip handoff commit responses", () => {
    expect(migrationSql).toContain("publication_assisted_handoff.commit_response_recovered");
    expect(migrationSql).toContain(
      "handoff.state NOT IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed')",
    );
    expect(migrationSql).toContain("handoff.submit_permit_consumed_at IS NULL");
    expect(migrationSql).toContain("job.state IN ('retry_wait', 'permanent_failure')");
    expect(migrationSql).toContain("SET state = 'started'");
    expect(migrationSql).toContain("SET state = 'dispatching'");
  });

  it("enforces fixed Ctrip payload limits before publication and records terminal invalid payloads", () => {
    const bridgeStatus = latestFunctionDefinition("record_publication_assisted_bridge_status");
    const jobGate = latestFunctionDefinition("enforce_ctrip_publication_job_payload_limits");

    expect(migrationSql).toContain("publication_variants_ctrip_payload_limits");
    expect(migrationSql).toContain("char_length(trim(p_payload ->> 'title')) BETWEEN 5 AND 20");
    expect(migrationSql).toContain(
      "char_length(trim(p_payload ->> 'bodyMarkdown')) BETWEEN 60 AND 3000",
    );
    expect(migrationSql).toContain("jsonb_array_length(p_payload -> 'media') BETWEEN 1 AND 20");
    expect(migrationSql).toContain("CREATE TRIGGER publication_jobs_ctrip_payload_limits");
    expect(jobGate).toContain(
      "Ctrip publication payload is outside fixed title, body, or media limits",
    );
    expect(bridgeStatus).toContain("'CTRIP_PAYLOAD_INVALID'");
    expect(bridgeStatus).toContain("'payload_invalid'");
    expect(bridgeStatus).toContain("next_error_code = 'ASSISTED_ADAPTER_DRIFT'");
  });

  it("records Ctrip submit observations before independent readback confirmation", () => {
    const submit = latestFunctionDefinition("record_publication_assisted_submit_observation");
    const recover = latestFunctionDefinition("recover_publication_assisted_submit_uncertain");
    const readback = latestFunctionDefinition("record_publication_assisted_readback");
    const transition = latestFunctionDefinition("enforce_publication_assisted_handoff_transition");

    for (const column of [
      "submit_outcome",
      "submit_evidence_kind",
      "submit_observed_at",
      "submit_candidate_external_id",
      "submit_candidate_external_url",
      "publication_receipt_id",
      "publication_readback_id",
      "readback_outcome",
      "readback_evidence_kind",
      "readback_evidence_hash",
      "readback_observed_at",
      "observed_payload_hash",
      "public_content_hash",
    ]) {
      expect(migrationSql).toContain(`ADD COLUMN ${column}`);
    }
    expect(migrationSql).toContain("publication_assisted_handoff_simulation_not_live");
    expect(submit).toContain("geo.require_bound_ctrip_bridge");
    expect(submit).toContain("submit_permit_consumed_by_principal_id <> actor_value");
    expect(submit).toContain("state = 'submitted_unconfirmed'");
    expect(submit).toContain("submit_candidate_external_id = normalized_candidate_id");
    expect(submit).toContain("submit_candidate_external_url = normalized_candidate_url");
    expect(submit).toContain("p_evidence_kind = 'simulation'");
    expect(submit).toContain("p_outcome IN ('rejected', 'not_accepted')");
    expect(submit).toContain("p_outcome = 'not_accepted'");
    expect(submit).toContain("INSERT INTO geo.publication_receipts");
    expect(submit).toContain("confirmed, payload");
    expect(submit).toContain("INSERT INTO geo.publication_readbacks");
    expect(submit).toContain("'pending', true");
    expect(submit).toContain("'browser_publication_unconfirmed'");
    expect(submit).toContain("state = 'readback_pending'");
    expect(submit).toContain("publication_assisted_handoff.submit_observed");
    expect(recover).toContain("geo.require_bound_ctrip_bridge");
    expect(recover).toContain("FOR UPDATE");
    expect(recover).toContain("submit_permit_consumed_at IS NULL");
    expect(recover).toContain("geo.record_publication_assisted_submit_observation");
    expect(recover).toContain("'uncertain'");
    expect(recover).toContain("publication_assisted_handoff.submit_observation_recovered");
    expect(readback).toContain("geo.require_bound_ctrip_bridge");
    expect(readback).toContain("p_evidence_kind <> 'platform_readback'");
    expect(readback).toContain(
      "p_observed_payload_hash IS DISTINCT FROM handoff.public_content_hash",
    );
    expect(readback).toContain("geo.browser_publication_identity_allowed(");
    expect(migrationSql).toContain("publication_assisted_handoff_submit_candidate_complete");
    expect(migrationSql).toContain("publication_assisted_handoff_confirmed_candidate_match");
    expect(readback).toContain("p_outcome = 'simulation_only'");
    expect(readback).toContain("next_state := 'needs_review'");
    expect(readback).toContain("WHEN next_state = 'confirmed' THEN 'confirmed'");
    expect(transition).toContain("'submit_outcome'");
    expect(transition).toContain("'readback_evidence_hash'");
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.recover_publication_assisted_submit_uncertain(",
    );
    expect(migrationSql).toContain(
      "GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(",
    );
  });
});
