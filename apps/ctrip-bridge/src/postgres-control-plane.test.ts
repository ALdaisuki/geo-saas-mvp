import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./postgres-control-plane.ts", import.meta.url), "utf8");

describe("Postgres Ctrip media ownership query", () => {
  it("refreshes browser runtime status only for accounts with live work or an operator window", () => {
    const runtimeBlock = source.slice(
      source.indexOf("listRuntimeBindingAccountIds"),
      source.indexOf("listBrowserReclaimAccountIds"),
    );
    expect(runtimeBlock).toContain("binding.manual_ready_until > clock_timestamp()");
    expect(runtimeBlock).toContain("from geo.publication_assisted_handoffs as active_handoff");
    expect(runtimeBlock).toContain("from geo.publication_jobs as active_job");
    for (const state of [
      "handoff_pending",
      "session_required",
      "challenge_required",
      "draft_prepared",
      "awaiting_operator_submit",
      "submitted_unconfirmed",
      "readback_pending",
    ]) {
      expect(runtimeBlock).toContain(`'${state}'`);
    }
    for (const state of ["queued", "retry_wait", "dispatching", "reconciling", "uncertain"]) {
      expect(runtimeBlock).toContain(`'${state}'`);
    }
  });

  it("closes only session-required account circuits after authenticated readiness", () => {
    const runtimeStatusBlock = source.slice(
      source.indexOf("recordRuntimeStatus"),
      source.indexOf("claimNextAnalyticsRefresh"),
    );
    expect(runtimeStatusBlock).toContain("status} in ('ready', 'authenticated')");
    expect(runtimeStatusBlock).toContain("breaker.reason = 'ASSISTED_SESSION_REQUIRED'");
    expect(runtimeStatusBlock).not.toContain("ASSISTED_ADAPTER_DRIFT', 'ASSISTED_SESSION_REQUIRED");
  });

  it("pauses analytics only for browser delivery work, not asynchronous readback", () => {
    const activeDeliveryBlock = source.slice(
      source.indexOf("countActiveDeliveryAccounts"),
      source.indexOf("claimNextUnattendedSubmit"),
    );
    expect(activeDeliveryBlock).toContain(
      "candidate.state in ('handoff_pending', 'session_required', 'challenge_required')",
    );
    expect(activeDeliveryBlock).toContain("candidate.state = 'draft_prepared'");
    expect(activeDeliveryBlock).toContain("candidate.submit_permit_consumed_at is null");
    expect(activeDeliveryBlock).not.toContain("submitted_unconfirmed");
    expect(activeDeliveryBlock).not.toContain("readback_pending");
  });

  it("counts only accounts that can be claimed without colliding with active browser work", () => {
    const runnableBlock = source.slice(
      source.indexOf("countRunnableDeliveryAccounts"),
      source.indexOf("countActiveDeliveryAccounts"),
    );
    expect(runnableBlock).toContain("geo.publication_account_browser_operation_busy(");
    expect(runnableBlock).toContain("candidate.channel_account_id");
    expect(runnableBlock).toContain("candidate.id");
    expect(runnableBlock).toContain("true");
    expect(runnableBlock).toContain("false");
  });

  it("uses the current version binding while allowing media inherited from an ancestor version", () => {
    expect(source).toContain("select binding.content_version_id");
    expect(source).toContain("binding.content_version_id = variant.content_version_id");
    expect(source).not.toContain("asset.content_version_id = variant.content_version_id");
  });

  it("maps media positions from the audited payload order rather than role-local bindings", () => {
    expect(source).toContain("(payload_media.ordinal - 1)::integer as position");
    expect(source).not.toContain("select binding.content_version_id, binding.position");
    expect(source).toContain("order by payload_media.ordinal");
  });

  it("reclaims recent terminal and long-blocked handoff accounts for browser teardown", () => {
    const reclaimBlock = source.slice(
      source.indexOf("listBrowserReclaimAccountIds"),
      source.indexOf("loadAccountRuntimeBinding"),
    );
    expect(reclaimBlock).toContain("'confirmed', 'needs_review', 'cancelled', 'expired', 'failed'");
    expect(reclaimBlock).toContain("handoff.updated_at >= clock_timestamp() - interval '1 hour'");
    expect(reclaimBlock).toContain("handoff.updated_at < clock_timestamp() - interval '5 minutes'");
    expect(reclaimBlock).toContain("binding.manual_ready_until is null");
    expect(reclaimBlock).toContain("binding.manual_ready_until <= clock_timestamp()");
    expect(reclaimBlock).toContain("handoff.lease_expires_at is null");
    expect(reclaimBlock).toContain("handoff.lease_expires_at < clock_timestamp()");
    expect(reclaimBlock).toContain("newer_handoff.updated_at > handoff.updated_at");
    expect(reclaimBlock).toContain("'handoff_pending', 'session_required', 'challenge_required',");
    expect(reclaimBlock).toContain("'draft_prepared', 'awaiting_operator_submit',");
    expect(reclaimBlock).toContain("from geo.publication_assisted_handoffs as active_handoff");
    expect(reclaimBlock).toContain("from geo.publication_jobs as active_job");
    expect(reclaimBlock).toContain("from geo.ctrip_account_analytics_sync_state as analytics");
    expect(reclaimBlock).toContain("analytics.lease_owner = binding.bridge_principal_id");
    expect(reclaimBlock).toContain("analytics.lease_expires_at >= clock_timestamp()");
    expect(reclaimBlock).toContain("active_job.state in (");
    for (const state of ["queued", "retry_wait", "dispatching"]) {
      expect(reclaimBlock).toContain(`'${state}'`);
    }
    expect(reclaimBlock).not.toContain("'dispatching', 'reconciling', 'uncertain'");
  });

  it("keeps submitted pending-readback accounts while an operator inspection window is active", () => {
    const reclaimBlock = source.slice(
      source.indexOf("listBrowserReclaimAccountIds"),
      source.indexOf("loadAccountRuntimeBinding"),
    );

    expect(reclaimBlock).toContain("handoff.state = 'readback_pending'");
    expect(reclaimBlock).toContain("handoff.submit_evidence_hash is not null");
    expect(reclaimBlock).toContain("handoff.state = 'submitted_unconfirmed'");
    expect(reclaimBlock.indexOf("binding.manual_ready_until is null")).toBeLessThan(
      reclaimBlock.indexOf("handoff.state = 'readback_pending'"),
    );
    expect(reclaimBlock).not.toContain("handoff.publication_receipt_id is not null");
    expect(reclaimBlock).toContain("active_handoff.readback_lease_expires_at >= clock_timestamp()");
  });

  it("records publisher rejection through the dedicated creator-management function", () => {
    const recordReadbackBlock = source.slice(
      source.indexOf("recordReadback("),
      source.indexOf("recordCancellation("),
    );
    expect(recordReadbackBlock).toContain('observation.outcome === "publisher_rejected"');
    expect(recordReadbackBlock).toContain("geo.record_publication_assisted_publisher_rejection");
    expect(recordReadbackBlock).toContain(
      'observation.publisherReasonCode ?? "publisher.rejected.other"',
    );
  });

  it("persists native Ctrip likes, favorites, and comments separately", () => {
    const analyticsBlock = source.slice(
      source.indexOf("completeAnalyticsRefresh("),
      source.indexOf("completePriorityPlatformAnalyticsRefresh("),
    );

    expect(analyticsBlock).toContain("total_likes");
    expect(analyticsBlock).toContain("total_favorites");
    expect(analyticsBlock).toContain("total_comments");
    expect(analyticsBlock).toContain("observation.totalLikes");
    expect(analyticsBlock).toContain("observation.totalFavorites");
    expect(analyticsBlock).toContain("observation.totalComments");
  });
});
