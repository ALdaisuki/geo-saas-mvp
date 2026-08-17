import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositorySource = await readFile(
  new URL("./postgres-automation-repository.ts", import.meta.url),
  "utf8",
);

describe("PostgreSQL automation repository contracts", () => {
  it("preserves the database rejection reason when a state transition conflicts", () => {
    expect(repositorySource).toContain(
      "error instanceof Error ? error.message.trim().slice(0, 300)",
    );
    expect(repositorySource).toContain("Automation state transition was rejected: ${message}");
  });

  it("counts cancelled and all terminal runs in both batch read paths", () => {
    const selectBatchBlock = repositorySource.slice(
      repositorySource.indexOf("async function selectBatch"),
      repositorySource.indexOf("async function selectTargets"),
    );
    const listBatchBlock = repositorySource.slice(
      repositorySource.indexOf("async listAutomationBatches"),
      repositorySource.indexOf("async getAutomationRun"),
    );

    for (const block of [selectBatchBlock, listBatchBlock]) {
      expect(block).toContain("count(run.id) filter (where run.state = 'cancelled')");
      expect(block).toContain("as cancelled_run_count");
      expect(block).toContain(
        "'completed', 'partially_failed', 'delivery_failed', 'blocked', 'failed', 'cancelled'",
      );
      expect(block).toContain("as terminal_run_count");
    }
  });

  it("serializes and enforces per-account daily publication capacity", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("channel-account-daily-quota");
    expect(createBlock).toContain("pg_advisory_xact_lock");
    expect(createBlock).toContain("account.daily_publish_quota");
    expect(createBlock).toContain("account.quota_timezone");
    expect(createBlock).toContain("readback.status = 'succeeded'");
    expect(createBlock).toContain("readback.required");
    expect(createBlock).not.toContain(
      "target.state in ('pending', 'variant_ready', 'awaiting_delivery')",
    );
    expect(createBlock).not.toContain(
      "run.state in ('scheduled', 'running', 'retry_wait', 'awaiting_delivery')",
    );
    expect(createBlock).not.toContain("target.state <> 'cancelled'");
    expect(createBlock).toContain("batch.execution_level <> 'dry_run'");
    expect(createBlock).toContain("daily publication quota");
  });

  it("does not make browser verification a prerequisite for content production", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("browser_session_ready");
    expect(createBlock).toContain("order by browser_session_ready desc");
    expect(createBlock).toContain("readyAccountIds.length > 0");
    expect(createBlock).not.toContain(
      "Unattended automation requires each account browser session to be authenticated",
    );
    expect(createBlock).not.toContain(
      "and not exists (\n                  select 1\n                  from geo.circuit_breakers",
    );
  });

  it("advances a tenant-scoped round-robin cursor in the batch transaction", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("automation_distribution_cursors");
    expect(createBlock).toContain("for update");
    expect(createBlock).toContain("effectiveRuns");
    expect(createBlock).toContain("next_offset");
  });

  it("assigns and advances campaign template rotation independently from account distribution", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("automation_template_rotation_cursors");
    expect(createBlock).toContain("rotationStartIndex");
    expect(createBlock).toContain("where campaign_id");
    expect(createBlock).toContain("for update");
    expect(createBlock).toContain("diversity_rotation_index");
    expect(createBlock.indexOf("rotationStartIndex")).toBeLessThan(
      createBlock.indexOf("platformManagedPlatforms"),
    );
    expect(createBlock).toContain("automationDiversityStrategy");
    expect(createBlock).toContain("automationKeywordSelectionForProvince");
    expect(createBlock).toContain("destinationTravelResource");
    expect(createBlock).toContain("automationSlotBrief");
    expect(createBlock).toContain("topicAngle");
    expect(createBlock).toContain("keywordPoolId");
    expect(createBlock).toContain("keywordCandidates");
  });

  it("resolves platform-managed pools from production-capable accounts and prefers ready ones", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );
    const platformPoolBlock = createBlock.slice(
      createBlock.indexOf("const platformPool = await sql"),
      createBlock.indexOf("const readyAccountIds"),
    );
    const finalAccountValidationBlock = createBlock.slice(
      createBlock.indexOf("const accounts = await sql"),
      createBlock.indexOf("const accountsById"),
    );

    expect(createBlock).toContain("platform_round_robin");
    expect(createBlock).toContain("platforms_round_robin");
    expect(createBlock).toContain("No eligible channel account is available");
    expect(createBlock).toContain("control.mode = 'unattended'");
    expect(createBlock).toContain(
      "runtime.session_state in ('authenticated', 'ready', 'challenge_required') as browser_session_ready",
    );
    expect(createBlock).toContain("account.capability = 'browser_assisted'");
    for (const accountQuery of [platformPoolBlock, finalAccountValidationBlock]) {
      expect(accountQuery).toContain("account.archived_at is null");
      expect(accountQuery).toContain("for share of account");
    }
    expect(createBlock).toContain("resolvedAccountPoolIds");
  });

  it("assigns every selected platform through an independent locked cursor", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("accountPoolsByPlatform");
    expect(createBlock).toContain("assignmentsByPlatform");
    expect(createBlock).toContain("for (const platform of [...platformManagedPlatforms].sort())");
    expect(createBlock).toContain('mode: "platform_round_robin"');
    expect(createBlock).toContain(
      "await assignRoundRobinAccounts(distributionKey, accountPoolIds)",
    );
    expect(createBlock).toContain("assignmentsByPlatform.get(platform)?.[runIndex]");
  });

  it("fails closed when platform-managed targets are preassigned or structurally incomplete", () => {
    const createBlock = repositorySource.slice(
      repositorySource.indexOf("async createAutomationBatch"),
      repositorySource.indexOf("async listAutomationBatches"),
    );

    expect(createBlock).toContain("run.targets.length !== platformManagedPlatforms.length");
    expect(createBlock).toContain("target.channelAccountId !== null");
    expect(createBlock).toContain(
      "Platform-managed distribution requires one unassigned target per platform and run",
    );
    expect(createBlock).toContain(
      "Round-robin automation requires at least one eligible target account",
    );
  });

  it("exposes pending target reassignment through a security-definer database function", () => {
    const reassignmentBlock = repositorySource.slice(
      repositorySource.indexOf("async reassignAutomationTarget"),
      repositorySource.indexOf("async claimAutomationRuns"),
    );

    expect(reassignmentBlock).toContain("reassign_pending_automation_target");
    expect(reassignmentBlock).toContain("selectRuns");
  });
});
