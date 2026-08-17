import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
const source = (name: string): Promise<string> =>
  readFile(join(repositoryRoot, "scripts", name), "utf8");

describe("production safety deadlines and restore clearance", () => {
  it("bounds the stopped-writer backup and leaves wrapper recovery armed", async () => {
    const backup = await source("backup-production.sh");
    const wrapper = await source("run-production-backup-cycle.sh");
    const backupUnit = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-backup.service.in"),
      "utf8",
    );
    const writerStop = backup.indexOf('"${compose[@]}" stop');
    const deadline = backup.indexOf(
      "stopped_writer_deadline=$((SECONDS + STOPPED_WRITER_TIMEOUT_SECONDS))",
    );

    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(writerStop);
    expect(backup).toContain("readonly STOPPED_WRITER_TIMEOUT_SECONDS=900");
    expect(backup).toContain('timeout --signal=TERM --kill-after=5s "${remaining}s"');
    expect(backup).toContain("run_backup_command tar --create");
    expect(backup).toContain("run_backup_command sha256sum");
    expect(backup).toContain('run_backup_command "$(cd --');
    expect(wrapper).toContain("readonly local_backup_process_timeout_seconds=1800");
    expect(wrapper.indexOf("trap cleanup_and_recover EXIT")).toBeLessThan(
      wrapper.indexOf('"${local_backup_process_timeout_seconds}s"'),
    );
    expect(backupUnit).toContain("TimeoutStopSec=10min");
  });

  it("bounds every Docker call after convergence invalidation", async () => {
    const launcher = await source("start-production.sh");
    const deadline = launcher.indexOf(
      "deployment_deadline=$((SECONDS + DEPLOYMENT_TIMEOUT_SECONDS))",
    );
    const invalidation = launcher.indexOf("manage_convergence invalidate");

    expect(deadline).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(invalidation);
    expect(launcher).toContain(
      'readonly DEPLOYMENT_TIMEOUT_SECONDS="${GEO_DEPLOYMENT_TIMEOUT_SECONDS:-3600}"',
    );
    expect(launcher).toContain("readonly DEPLOYMENT_COMMAND_TIMEOUT_SECONDS=1800");
    expect(launcher).toContain("run_deployment_command env -i");
    expect(launcher).toContain('timeout --signal=TERM --kill-after=5s "${command_timeout}s"');
    expect(launcher.indexOf("manage_convergence attest")).toBeLessThan(
      launcher.indexOf("remaining_deployment_seconds >/dev/null"),
    );
  });

  it("keeps a durable clearance transaction visible to every production entrypoint", async () => {
    const gate = ".geo-restore-inhibit-clearance";
    const entrypoints = [
      "backup-production.sh",
      "check-production-health.sh",
      "commission-production-db.sh",
      "hold-production-restore-inhibit.sh",
      "install-production-operations.sh",
      "manage-production-convergence.sh",
      "rollback-production-release.sh",
      "run-production-backup-cycle.sh",
      "start-production.sh",
    ];
    const sources = await Promise.all(entrypoints.map(source));
    for (const entrypoint of sources) {
      expect(entrypoint).toContain(gate);
    }

    const clear = await source("clear-production-restore-inhibit.sh");
    const publishGate = clear.lastIndexOf('publish_marker_payload "${clearance_gate}"');
    const unlinkMarker = clear.indexOf('unlink -- "${inhibit_marker}"');
    const unlinkGate = clear.indexOf('unlink -- "${clearance_gate}"');
    expect(publishGate).toBeGreaterThan(-1);
    expect(publishGate).toBeLessThan(unlinkMarker);
    expect(unlinkMarker).toBeLessThan(unlinkGate);
    expect(clear).toContain("restore_clearance_after_failure");
    expect(clear).toContain('publish_marker_payload "${inhibit_marker}"');
    expect(clear).toContain("require_fresh_external_evidence");
    expect(clear.lastIndexOf("require_fresh_external_evidence")).toBeLessThan(publishGate);
  });
});
