import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { normalizeAutomationQueueMetrics, nullableFiniteNumber } from "./postgres-repository.js";

const repositorySource = await readFile(
  new URL("./postgres-repository.ts", import.meta.url),
  "utf8",
);

describe("PostgreSQL repository contracts", () => {
  it("normalizes malformed queue metrics to finite API numbers", () => {
    expect(normalizeAutomationQueueMetrics({ depth: "3", limit: "4" })).toEqual({
      queueDepth: 3,
      queueLimit: 4,
      queueSaturation: 0.75,
    });
    expect(
      normalizeAutomationQueueMetrics({ depth: Number.NaN, limit: Number.POSITIVE_INFINITY }),
    ).toEqual({
      queueDepth: 0,
      queueLimit: 1,
      queueSaturation: 0,
    });
    expect(normalizeAutomationQueueMetrics({ depth: -4, limit: 0 })).toEqual({
      queueDepth: 0,
      queueLimit: 1,
      queueSaturation: 0,
    });
  });

  it("converts invalid analytics numbers to null instead of leaking NaN", () => {
    expect(nullableFiniteNumber("12.5")).toBe(12.5);
    expect(nullableFiniteNumber("NaN")).toBeNull();
    expect(nullableFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(nullableFiniteNumber(null)).toBeNull();
  });

  it("qualifies channel account columns after joining account runtime bindings", () => {
    const accountBlock = repositorySource.slice(
      repositorySource.indexOf("async listChannelAccounts"),
      repositorySource.indexOf("async listEvidenceSources"),
    );

    expect(accountBlock).toContain("select account.id, account.platform, account.display_name");
    expect(accountBlock).toContain("account.capability_evidence_type");
    expect(accountBlock).toContain("runtime.id as ctrip_runtime_id");
    expect(accountBlock).not.toContain("select id, platform, display_name");
    expect(accountBlock).toContain("where account.archived_at is null");
  });

  it("aggregates only the latest tenant-scoped Ctrip analytics snapshot per account", () => {
    const analyticsBlock = repositorySource.slice(
      repositorySource.indexOf("async getCtripAccountAnalytics"),
      repositorySource.indexOf("async getPriorityPlatformAccountAnalytics"),
    );

    expect(analyticsBlock).toContain("geo.ctrip_account_analytics_sync_state");
    expect(analyticsBlock).toContain("left join lateral");
    expect(analyticsBlock).toContain("order by snapshot.observed_at desc");
    expect(analyticsBlock).toContain("latest.content_heat desc nulls last");
    expect(analyticsBlock).toContain("latest.total_likes");
    expect(analyticsBlock).toContain("latest.total_favorites");
    expect(analyticsBlock).toContain("latest.total_comments");
    expect(analyticsBlock).toContain("account.archived_at is null");
    expect(analyticsBlock).toContain("reportingAccountCount");
  });

  it("aggregates latest native priority-platform counters and work rows", () => {
    const analyticsBlock = repositorySource.slice(
      repositorySource.indexOf("async getPriorityPlatformAccountAnalytics"),
      repositorySource.indexOf("async listEvidenceSources"),
    );

    expect(analyticsBlock).toContain("latest.total_impressions");
    expect(analyticsBlock).toContain("latest.total_reads");
    expect(analyticsBlock).toContain("latest.total_likes");
    expect(analyticsBlock).toContain("latest.total_comments");
    expect(analyticsBlock).toContain("snapshot.platform = account.platform");
    expect(analyticsBlock).toContain("order by snapshot.observed_at desc");
    expect(analyticsBlock).toContain("account.archived_at is null");
    expect(analyticsBlock).toContain("reportingAccountCount");
  });

  it("serializes immutable query-set versions and audits explicit activation", () => {
    const versionBlock = repositorySource.slice(
      repositorySource.indexOf("async createQuerySetVersion"),
      repositorySource.indexOf("async transitionQuerySet"),
    );

    expect(versionBlock).toContain("for update");
    expect(versionBlock).toContain('querySet.status === "retired"');
    expect(versionBlock).toContain("coalesce(max(version), 0)::integer + 1");
    expect(versionBlock).toContain("query_set.version_created");
    expect(versionBlock).toContain("query_set.version_activated");
    expect(versionBlock).toContain("insert into geo.audit_log");
    expect(versionBlock).toContain("${context.tenantId}");
    expect(versionBlock).toContain("${context.actorId}");
  });

  it("updates tenant automation mode and quota without clearing the emergency switch", () => {
    const controlBlock = repositorySource.slice(
      repositorySource.indexOf("async setTenantAutomationControl"),
      repositorySource.indexOf("async setScopedAutomationControl"),
    );

    expect(controlBlock).toContain("on conflict (tenant_id, scope_type, scope_key)");
    expect(controlBlock).toContain("mode = excluded.mode");
    expect(controlBlock).toContain("quota = excluded.quota");
    expect(controlBlock).not.toContain("kill_switch_enabled = excluded.kill_switch_enabled");
    expect(controlBlock).toContain("insert into geo.audit_log");
    expect(controlBlock).toContain("automation.control_changed");
    expect(controlBlock).toContain("${context.tenantId}");
    expect(controlBlock).toContain("${context.actorId}");
  });

  it("exposes only active publication leases as automation queue depth", () => {
    const statusBlock = repositorySource.slice(
      repositorySource.indexOf("async getAutomationStatus"),
      repositorySource.indexOf("async setTenantAutomationControl"),
    );

    expect(statusBlock).toContain("count(*) filter");
    expect(statusBlock).toContain("job.state = 'dispatching'");
    expect(statusBlock).toContain("job.lease_expires_at > clock_timestamp()");
    expect(statusBlock).not.toContain("'reconciling', 'uncertain'");
    expect(statusBlock).toContain("normalizeAutomationQueueMetrics(queueRow)");
    expect(repositorySource).toContain("Number.isFinite(parsed) ? parsed : fallback");
    expect(repositorySource).toContain("queueSaturation: Number.isFinite(saturation) ? saturation : 0");
  });

  it("locks, validates, and audits campaign lifecycle transitions inside tenant scope", () => {
    const campaignBlock = repositorySource.slice(
      repositorySource.indexOf("async transitionCampaign"),
      repositorySource.indexOf("async listContent"),
    );

    expect(campaignBlock).toContain("for update");
    expect(campaignBlock).toContain('current.status === "draft"');
    expect(campaignBlock).toContain('current.status === "paused"');
    expect(campaignBlock).toContain('current.status === "active"');
    expect(campaignBlock).toContain("Campaign cannot transition");
    expect(campaignBlock).toContain("and status = ${current.status}");
    expect(campaignBlock).toContain("insert into geo.audit_log");
    expect(campaignBlock).toContain("campaign.status_changed");
    expect(campaignBlock).toContain("${context.tenantId}");
    expect(campaignBlock).toContain("${context.actorId}");
  });

  it("orders content assets by their latest activity instead of initial creation", () => {
    const contentBlock = repositorySource.slice(
      repositorySource.indexOf("async listContent"),
      repositorySource.indexOf("async createContent"),
    );

    expect(contentBlock).toContain("latest.payload ->> 'title'");
    expect(contentBlock).toContain(
      "greatest(items.updated_at, latest.created_at) as latest_activity_at",
    );
    expect(contentBlock).toContain("order by greatest(items.updated_at, latest.created_at) desc");
    expect(contentBlock).not.toContain("order by items.created_at desc");
  });

  it("clears a half-open probe when harmful visibility reopens the circuit", () => {
    const visibilityBlock = repositorySource.slice(
      repositorySource.indexOf("if (input.openCircuit"),
      repositorySource.indexOf("async getVisibilitySummary"),
    );

    expect(visibilityBlock).toContain("state = 'open'");
    expect(visibilityBlock).toContain("probe_attempt_id = null");
    expect(visibilityBlock).toContain("probe_started_at = null");
  });

  it("uses earlier siblings and completed cross-platform history for duplicate auditing", () => {
    const historyBlock = repositorySource.slice(
      repositorySource.indexOf("const priorResult"),
      repositorySource.indexOf("const priorVariants"),
    );

    expect(historyBlock).toContain("prior_variant.tenant_id = ${context.tenantId}");
    expect(historyBlock).toContain("prior_variant.id <> ${variantId}");
    expect(historyBlock).toContain(
      "prior_variant.content_version_id = ${variantRow.content_version_id}",
    );
    expect(historyBlock).toContain("prior_variant.state in ('draft', 'frozen')");
    expect(historyBlock).toContain("prior_variant.created_at < ${variantRow.created_at}");
    expect(historyBlock).toContain("prior_variant.created_at = ${variantRow.created_at}");
    expect(historyBlock).toContain("prior_variant.id < ${variantRow.id}");
    expect(historyBlock).toContain("job.state in ('preview_completed', 'confirmed')");
    expect(historyBlock).toContain("from geo.historical_publications as history");
    expect(historyBlock).toContain("history.tenant_id = ${context.tenantId}");
    expect(historyBlock).toContain("ctripPublicContentHashFromMarkdown");
    expect(historyBlock).toContain("history.public_content_hash = ${candidatePublicContentHash}");
    expect(historyBlock).not.toContain("and platform = ${variantRow.platform}");
  });

  it("lists only tenant-scoped media that crossed the real submission boundary", () => {
    const historyBlock = repositorySource.slice(
      repositorySource.indexOf("async function readSubmittedMediaHistory"),
      repositorySource.indexOf("async function resourceExists"),
    );

    expect(historyBlock).toContain("variant.tenant_id = ${tenantId}");
    expect(historyBlock).toContain("variant.id <> ${excludedVariantId}::uuid");
    expect(historyBlock).toContain("jsonb_array_elements");
    expect(historyBlock).toContain("job.execution_level <> 'dry_run'");
    expect(historyBlock).toContain("job.state = 'confirmed'");
    expect(historyBlock).toContain("handoff.submit_observed_at is not null");
    expect(historyBlock).toContain("handoff.submit_evidence_kind = 'browser'");
    expect(historyBlock).toContain("media.value->>'sha256'");
    expect(historyBlock).toContain("media.value->'provenance'->>'sourceUrl'");
    expect(historyBlock).not.toContain("variant.state in ('draft', 'frozen')");
    const auditBlock = repositorySource.slice(
      repositorySource.indexOf("async loadAuditContext"),
      repositorySource.indexOf("async findAuditByIdempotency"),
    );
    expect(auditBlock).toContain("readSubmittedMediaHistory");
    expect(auditBlock).toContain("context.tenantId,");
    expect(auditBlock).toContain("variantId,");
    expect(auditBlock).toContain("submittedMediaSha256");
  });

  it("lists only the latest content version in the pending manual media review queue", () => {
    const reviewBlock = repositorySource.slice(
      repositorySource.indexOf("async listPendingManualMediaReviews"),
      repositorySource.indexOf("async listRecentManualMediaReviews"),
    );

    expect(reviewBlock).toContain("from geo.content_versions as newer");
    expect(reviewBlock).toContain("newer.tenant_id = version.tenant_id");
    expect(reviewBlock).toContain("newer.content_item_id = version.content_item_id");
    expect(reviewBlock).toContain("newer.version > version.version");
  });

  it("serializes and deduplicates deterministic platform variant rendering", () => {
    const variantBlock = repositorySource.slice(
      repositorySource.indexOf("async createVariant"),
      repositorySource.indexOf("async supersedeVariant"),
    );

    expect(variantBlock).toContain("pg_advisory_xact_lock");
    expect(variantBlock).toContain("archived_at is null");
    expect(variantBlock).toContain("for share");
    expect(variantBlock).toContain("and payload_hash = ${input.payloadHash}");
    expect(variantBlock).toContain("and state <> 'superseded'");
    expect(variantBlock.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      variantBlock.indexOf("coalesce(max(variant_version)"),
    );
  });

  it("locks and audits draft supersession only when no downstream history exists", () => {
    const variantBlock = repositorySource.slice(
      repositorySource.indexOf("async supersedeVariant"),
      repositorySource.indexOf("async createMediaJob"),
    );

    expect(variantBlock).toContain("for update");
    expect(variantBlock).toContain('current.state !== "draft"');
    expect(variantBlock).toContain("from geo.audit_runs");
    expect(variantBlock).toContain("from geo.publication_grants");
    expect(variantBlock).toContain("from geo.publication_jobs");
    expect(variantBlock).toContain("from geo.publication_assisted_handoffs");
    expect(variantBlock).toContain("from geo.automation_run_targets");
    expect(variantBlock).toContain("set state = 'superseded'");
    expect(variantBlock).toContain("publication_variant.superseded");
    expect(variantBlock).toContain("before_hash, after_hash");
    expect(variantBlock).toContain("reason: input.reason");
  });

  it("loads the exact immutable Brand Agent Profile referenced by the audit payload", () => {
    const auditBlock = repositorySource.slice(
      repositorySource.indexOf("async loadAuditContext"),
      repositorySource.indexOf("async findAuditByIdempotency"),
    );

    expect(auditBlock).toContain("from geo.brand_agent_profiles");
    expect(auditBlock).toContain("profile.tenant_id = ${context.tenantId}");
    expect(auditBlock).toContain("profile.id = ${profileReference.id}");
    expect(auditBlock).toContain("profile.version = ${profileReference.version}");
    expect(auditBlock).toContain("profileRow.brand_id !== variantRow.brand_id");
    expect(auditBlock).toContain("profileRow.document_hash !== profileReference.documentHash");
    expect(auditBlock).toContain("sha256Canonical(profileDocument)");
    expect(auditBlock).toContain("agentProfile:");
  });

  it("loads and records manual package exports inside the audited tenant data flow", () => {
    const sourceStart = repositorySource.indexOf("async loadManualPublicationPackageSource");
    const recordStart = repositorySource.indexOf("async recordManualPublicationPackageExport");

    expect(sourceStart).toBeGreaterThan(-1);
    expect(recordStart).toBeGreaterThan(sourceStart);
    const sourceBlock = repositorySource.slice(sourceStart, recordStart);
    const recordBlock = repositorySource.slice(
      recordStart,
      repositorySource.indexOf("async listAudits"),
    );
    expect(sourceBlock).toContain("from geo.audit_artifacts as artifact");
    expect(sourceBlock).toContain("join geo.publication_variants as variant");
    expect(sourceBlock).toContain("join geo.channel_accounts as account");
    expect(sourceBlock).toContain("artifact.tenant_id = ${context.tenantId}");
    expect(recordBlock).toContain("insert into geo.audit_log");
    expect(recordBlock).toContain("manual_publication_package.exported");
    expect(recordBlock).toContain('publicationStatus: "not_published"');
  });

  it("routes only assisted grant consumption through the narrow Ctrip admission function", () => {
    const consumeBlock = repositorySource.slice(
      repositorySource.indexOf("async consumePublicationGrant"),
      repositorySource.indexOf("async resolvePublicationReplay"),
    );

    expect(consumeBlock).toContain('input.executionLevel === "assisted"');
    expect(consumeBlock).toContain("geo.consume_browser_assisted_publication_grant");
    expect(consumeBlock).toContain("geo.consume_publication_grant");
    expect(consumeBlock.indexOf("geo.consume_browser_assisted_publication_grant")).toBeLessThan(
      consumeBlock.indexOf("geo.consume_publication_grant"),
    );
  });
});
