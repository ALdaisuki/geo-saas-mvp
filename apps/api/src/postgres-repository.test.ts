import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositorySource = await readFile(
  new URL("./postgres-repository.ts", import.meta.url),
  "utf8",
);

describe("PostgreSQL repository contracts", () => {
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
    expect(historyBlock).not.toContain("and platform = ${variantRow.platform}");
  });

  it("serializes and deduplicates deterministic platform variant rendering", () => {
    const variantBlock = repositorySource.slice(
      repositorySource.indexOf("async createVariant"),
      repositorySource.indexOf("async loadAuditContext"),
    );

    expect(variantBlock).toContain("pg_advisory_xact_lock");
    expect(variantBlock).toContain("and payload_hash = ${input.payloadHash}");
    expect(variantBlock.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      variantBlock.indexOf("coalesce(max(variant_version)"),
    );
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
    expect(consumeBlock).toContain("geo.consume_ctrip_assisted_publication_grant");
    expect(consumeBlock).toContain("geo.consume_publication_grant");
    expect(consumeBlock.indexOf("geo.consume_ctrip_assisted_publication_grant")).toBeLessThan(
      consumeBlock.indexOf("geo.consume_publication_grant"),
    );
  });
});
