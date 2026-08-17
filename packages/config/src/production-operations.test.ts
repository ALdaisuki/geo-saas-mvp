import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(fileURLToPath(new URL("../../../package.json", import.meta.url)));
const scripts = [
  "check-production-health.sh",
  "clear-production-restore-inhibit.sh",
  "hold-production-restore-inhibit.sh",
  "initialize-production-backup-repository.sh",
  "install-production-local-operations.sh",
  "install-production-operations.sh",
  "manage-production-local-cron.sh",
  "manage-production-convergence.sh",
  "open-production-browser-tunnel.sh",
  "prune-production-artifacts.sh",
  "run-production-backup-cycle.sh",
  "send-operations-alert.sh",
  "validate-production-operations-env.sh",
].map((name) => join(repositoryRoot, "scripts", name));

const source = async (name: string): Promise<string> =>
  readFile(join(repositoryRoot, "scripts", name), "utf8");
const releaseTransferScript = join(repositoryRoot, "scripts", "transfer-production-release.sh");

const runHttpsVerifierWithMockCertificate = async (certificateMode: "invalid" | "valid") => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "geo-https-verifier-test-"));
  const fixtureBin = join(fixtureRoot, "bin");
  await mkdir(fixtureBin);

  const writeExecutable = async (name: string, contents: string) => {
    const path = join(fixtureBin, name);
    await writeFile(path, contents, "utf8");
    await chmod(path, 0o700);
  };

  await Promise.all([
    writeExecutable(
      "dig",
      `#!/usr/bin/env bash
set -eu
if [[ " $* " == *" A "* ]]; then
  printf '203.0.113.10\\n'
fi
`,
    ),
    writeExecutable(
      "curl",
      `#!/usr/bin/env bash
set -eu
dump_header=
output=
request_host=
url=
while (( $# > 0 )); do
  case "$1" in
    --dump-header)
      dump_header=$2
      shift 2
      ;;
    --output)
      output=$2
      shift 2
      ;;
    --header)
      request_host=$2
      shift 2
      ;;
    http://*|https://*)
      url=$1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$request_host" == 'Host: invalid.invalid' ]]; then
  status=421
elif [[ "$url" == http://*/healthz ]]; then
  status=308
elif [[ "$url" == https://*/healthz ]]; then
  status=200
elif [[ "$url" == https://*/api/auth/session ]]; then
  status=401
elif [[ "$url" == https://*/ ]]; then
  status=200
else
  exit 2
fi

if [[ -n "$dump_header" ]]; then
  case "$status:$url" in
    308:*)
      printf 'location: https://geo.example.test/healthz\\n' >"$dump_header"
      ;;
    200:*/healthz)
      printf '%s\\n' \\
        'strict-transport-security: max-age=31536000' \\
        'x-content-type-options: nosniff' \\
        'x-frame-options: DENY' \\
        'referrer-policy: same-origin' \\
        'content-security-policy: default-src self' >"$dump_header"
      ;;
    200:*)
      printf 'content-type: text/html; charset=utf-8\\n' >"$dump_header"
      ;;
    401:*)
      printf 'content-type: application/json\\n' >"$dump_header"
      ;;
  esac
fi

if [[ -n "$output" && "$output" != /dev/null ]]; then
  if [[ "$url" == */api/auth/session ]]; then
    printf '{"code":"AUTHENTICATION_REQUIRED"}\\n' >"$output"
  else
    printf '<!doctype html><html></html>\\n' >"$output"
  fi
fi

printf '%s' "$status"
`,
    ),
    writeExecutable(
      "openssl",
      `#!/usr/bin/env bash
set -eu
operation=$1
shift
case "$operation" in
  s_client)
    if [[ "$MOCK_CERTIFICATE_MODE" == valid ]]; then
      printf 'VALID-CERTIFICATE\\n'
    else
      printf 'not a certificate\\n'
    fi
    printf 'poll error: unexpected EOF\\n' >&2
    exit 1
    ;;
  x509)
    if [[ " $* " == *" -outform PEM "* ]]; then
      certificate_file=
      while (( $# > 0 )); do
        if [[ "$1" == -in ]]; then
          certificate_file=$2
          shift 2
        else
          shift
        fi
      done
      if [[ -n "$certificate_file" ]]; then
        certificate_input=$(cat "$certificate_file")
      else
        certificate_input=$(cat)
      fi
      [[ "$certificate_input" == *VALID-CERTIFICATE* ]] || exit 1
      printf 'PARSED-CERTIFICATE\\n'
      exit 0
    fi

    certificate_file=
    while (( $# > 0 )); do
      if [[ "$1" == -in ]]; then
        certificate_file=$2
        shift 2
      else
        shift
      fi
    done
    [[ -n "$certificate_file" ]]
    grep -Fqx 'PARSED-CERTIFICATE' "$certificate_file"
    ;;
  *)
    exit 2
    ;;
esac
`,
    ),
  ]);

  try {
    return spawnSync(
      "bash",
      [
        join(repositoryRoot, "scripts/verify-production-https.sh"),
        "geo.example.test",
        "203.0.113.10",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MOCK_CERTIFICATE_MODE: certificateMode,
          PATH: `${fixtureBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
};

describe("unattended production operations", () => {
  it("ships executable, syntactically valid Linux entrypoints", async () => {
    await Promise.all(scripts.map((script) => access(script, constants.X_OK)));
    const syntax = spawnSync("bash", ["-n", ...scripts], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("ships one fail-closed Mac-to-server immutable release helper", async () => {
    await access(releaseTransferScript, constants.X_OK);
    const syntax = spawnSync("bash", ["-n", releaseTransferScript], { encoding: "utf8" });
    const transfer = await source("transfer-production-release.sh");
    const handoff = await readFile(
      join(repositoryRoot, "docs/WORKSTATION_SERVER_HANDOFF.md"),
      "utf8",
    );

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(transfer).toContain("git status --porcelain --untracked-files=all");
    expect(transfer).toContain("git archive --format=tar.gz");
    expect(transfer).toContain("--same-permissions");
    expect(transfer).toContain("scp -o ClearAllForwardings=yes");
    expect(transfer).toContain("ssh -o ClearAllForwardings=yes");
    expect(transfer).toContain('rollback-production-release.sh" --forward');
    expect(transfer).toContain('if [[ "${start_requested}" == true ]]');
    expect(transfer).toContain("/srv/geo-saas/app/current/scripts/start-production.sh");
    expect(transfer).not.toContain("docker ");
    expect(transfer).not.toContain("eval ");
    expect(handoff).toContain("scripts/transfer-production-release.sh --start geo-production-host");
  });

  it("scopes production artifact pruning to protected releases, GEO images, and bounded cache", async () => {
    const pruning = await source("prune-production-artifacts.sh");
    const handoff = await readFile(
      join(repositoryRoot, "docs/WORKSTATION_SERVER_HANDOFF.md"),
      "utf8",
    );

    expect(pruning).toContain("preview");
    expect(pruning).toContain("apply --confirm-current <full-release-sha>");
    expect(pruning).toContain('protected_releases["${CURRENT_SHA}"]=current');
    expect(pruning).toContain("release_review");
    expect(pruning).toContain("declare -A validated_releases=()");
    expect(pruning).toContain('validated_releases["${release_name}"]=true');
    expect(pruning).toContain(
      '[[ -n "${validated_releases[${release_name}]+present}" ]] || continue',
    );
    expect(pruning).toContain('protected_image_ids["${container_image}"]=container');
    expect(pruning).toContain("geo-saas-browser-host");
    expect(pruning).toContain('docker_local image rm --no-prune "${image_ref}"');
    expect(pruning).toContain("docker_local buildx prune");
    expect(pruning).toContain('--filter "until=${CACHE_MIN_AGE_HOURS}h"');
    expect(pruning).toContain('--reserved-space "${CACHE_RESERVED_SPACE}"');
    expect(pruning).toContain("verify_convergence");
    expect(pruning).not.toContain("docker system prune");
    expect(pruning).not.toContain("docker volume");
    expect(handoff).toContain("scripts/prune-production-artifacts.sh preview");
    expect(handoff).toContain("apply --confirm-current");
  });

  it("accepts a parsed certificate when LibreSSL reports a post-handshake error", async () => {
    const verification = await runHttpsVerifierWithMockCertificate("valid");

    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout).toContain(
      "Production HTTPS verification passed for https://geo.example.test",
    );
  });

  it("rejects served output that OpenSSL cannot parse as a certificate", async () => {
    const verification = await runHttpsVerifierWithMockCertificate("invalid");

    expect(verification.status).toBe(1);
    expect(verification.stderr).toContain("could not read the served TLS certificate");
    expect(verification.stdout).not.toContain("Production HTTPS verification passed");
  });

  it("opens the production browser through one isolated loopback-only SSH forward", async () => {
    const tunnel = await source("open-production-browser-tunnel.sh");
    const handoff = await readFile(
      join(repositoryRoot, "docs/WORKSTATION_SERVER_HANDOFF.md"),
      "utf8",
    );
    const runbook = await readFile(
      join(repositoryRoot, "docs/CTRIP_PRODUCTION_RUNBOOK.md"),
      "utf8",
    );

    expect(tunnel).toContain("mktemp -d /tmp/geo-browser-tunnel.XXXXXX");
    expect(tunnel).toContain("-o ClearAllForwardings=yes");
    expect(tunnel).toContain('-F /dev/null -S "${control_socket}" -O forward');
    expect(tunnel).toContain('-O cancel -L "${forward_spec}"');
    expect(tunnel).toContain("127.0.0.1:${local_port}:127.0.0.1:${remote_port}");
    expect(tunnel).not.toContain("0.0.0.0");
    expect(handoff).toContain("scripts/open-production-browser-tunnel.sh geo-production-host");
    expect(runbook).toContain("scripts/open-production-browser-tunnel.sh geo-production-host");
    expect(handoff).not.toContain("ClearAllForwardings=yes -L");
    expect(runbook).not.toContain("ClearAllForwardings=yes -L");
  });

  it("restores service before encrypted transport and proves an offsite readback", async () => {
    const backup = await source("run-production-backup-cycle.sh");
    const localBackupDeadline = backup.indexOf(
      'timeout --signal=TERM --kill-after=5s "${local_backup_process_timeout_seconds}s"',
    );
    const localBackup = backup.indexOf('"${backup_script}"', localBackupDeadline);
    const recovery = backup.indexOf('resume_attested_stack >>"${cycle_log}"', localBackup);
    const upload = backup.indexOf("restic --no-cache backup --json");
    const readback = backup.indexOf("restic --no-cache restore");
    const verifier = backup.indexOf('--bundle "${restored_bundle}"');
    const retention = backup.indexOf("restic --no-cache forget");

    expect(localBackupDeadline).toBeGreaterThan(-1);
    expect(localBackup).toBeGreaterThan(localBackupDeadline);
    expect(recovery).toBeGreaterThan(localBackup);
    expect(upload).toBeGreaterThan(recovery);
    expect(readback).toBeGreaterThan(upload);
    expect(verifier).toBeGreaterThan(readback);
    expect(retention).toBeGreaterThan(verifier);
    expect(backup).toContain("trap cleanup_and_recover EXIT");
    expect(backup).toContain("backup maintenance lock descriptor is not bound to the checked path");
    expect(backup).toContain("GEO_BACKUP_MAINTENANCE_LOCK_FD=8");
    expect(backup).toContain("flock --unlock 8");
    expect(backup).toContain("Private restic diagnostics retained at");
    expect(backup).toContain("readonly convergence_manager_timeout_seconds=420");
    expect(backup).toContain(
      'timeout --signal=TERM --kill-after=5s "${convergence_manager_timeout_seconds}s"',
    );
    expect(backup).toContain("RESTIC_PASSWORD_FILE must be an absolute path");
    expect(backup).toContain("supported non-local offsite backend");
    expect(backup).toContain('--expected-project "${compose_project}"');
    expect(backup).not.toContain("start-production.sh");
    expect(backup).toContain(
      "scheduled backup is inhibited until the persistent incident-restore marker is cleared",
    );
  });

  it("serializes health recovery and delegates only to attested local resume", async () => {
    const health = await source("check-production-health.sh");
    expect(health.indexOf("flock --nonblock 9")).toBeLessThan(
      health.indexOf('"${convergence_manager}" resume-existing'),
    );
    expect(health).toContain("GEO_DEPLOYMENT_LOCK_FD=9");
    expect(health).toContain("attested local-only container recovery or verification failed");
    expect(health).not.toContain("docker_local start");
    expect(health).not.toContain("docker_local restart");
    expect(health).not.toContain("compose up");
    expect(health).not.toContain("compose build");
    expect(health).not.toContain("compose pull");
    expect(health).toContain("backup maintenance lock descriptor is not bound to the checked path");
    expect(health).toContain(
      '"${release_root}/scripts/verify-production-https.sh" "${public_domain}" "${public_ipv4}" 127.0.0.1',
    );
    expect(health).toContain("readonly convergence_manager_timeout_seconds=420");
    expect(health).toContain(
      'timeout --signal=TERM --kill-after=5s "${convergence_manager_timeout_seconds}s"',
    );
    expect(health).toContain("readonly https_verification_timeout_seconds=150");
    expect(health).toContain(
      'timeout --signal=TERM --kill-after=5s "${https_verification_timeout_seconds}s"',
    );
    expect(health).toContain("external reachability not asserted");
    expect(health).toContain(
      "health recovery is inhibited until the persistent incident-restore marker is cleared",
    );
    const localSuccess = health.indexOf("Production local runtime health passed");
    const httpsVerification = health.indexOf(
      '"${release_root}/scripts/verify-production-https.sh" "${public_domain}" "${public_ipv4}" 127.0.0.1',
    );
    expect(health).toContain("Usage: check-production-health.sh [--local-only]");
    expect(localSuccess).toBeGreaterThan(
      health.indexOf('"${convergence_manager}" resume-existing'),
    );
    expect(localSuccess).toBeLessThan(httpsVerification);
    expect(health.slice(localSuccess, httpsVerification)).toContain("exit 0");
  });

  it("creates a verified local recovery set without claiming offsite protection", async () => {
    const backup = await source("run-production-backup-cycle.sh");
    const localSuccess = backup.indexOf("Production local backup cycle passed");
    const offsiteUpload = backup.indexOf("restic --no-cache backup --json");

    expect(backup).toContain("Usage: run-production-backup-cycle.sh [--local-only]");
    expect(localSuccess).toBeGreaterThan(backup.indexOf('resume_attested_stack >>"${cycle_log}"'));
    expect(localSuccess).toBeLessThan(offsiteUpload);
    expect(backup.slice(localSuccess, offsiteUpload)).toContain("exit 0");
    expect(backup).toContain(
      "Offsite transport, readback, and retention were not run in local-only mode.",
    );
  });

  it("invalidates, creates, verifies, and locally resumes one convergence attestation", async () => {
    const manager = await source("manage-production-convergence.sh");
    const launcher = await source("start-production.sh");
    const invalidation = launcher.indexOf("manage_convergence invalidate");
    const firstBuild = launcher.indexOf('"${compose[@]}" build config-preflight');
    const composeUp = launcher.indexOf('"${compose[@]}" up --detach --wait');
    const attestation = launcher.indexOf("manage_convergence attest");

    expect(invalidation).toBeGreaterThan(-1);
    expect(invalidation).toBeLessThan(firstBuild);
    expect(attestation).toBeGreaterThan(composeUp);
    expect(launcher).toContain(
      'readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"',
    );
    expect(manager).toContain(
      "readonly ATTESTATION_FILE=${SECRET_ROOT}/.geo-production-convergence.attestation",
    );
    expect(manager).toContain(
      "readonly RESTORE_CLEARANCE_GATE=${SECRET_ROOT}/.geo-restore-inhibit-clearance",
    );
    expect(manager).toContain("ATTESTATION_VERSION=geo.production-convergence.v1");
    expect(manager).toContain("GEO_ENV_SHA256");
    expect(manager).toContain("COMPOSE_PROJECT");
    expect(manager).toContain("PUBLIC_DOMAIN");
    expect(manager).toContain("CADDY_IMAGE");
    expect(manager).toContain("COMPOSE_GRAPH_SHA256");
    expect(manager).toContain("RELEASE_STATIC_BIND_COUNT");
    expect(manager).toContain("RELEASE_STATIC_BIND_MANIFEST_SHA256");
    expect(manager).toContain("MIGRATION_MANIFEST_SHA256");
    expect(manager).toContain("APPLIED_MIGRATIONS_SHA256");
    expect(manager).toContain("MIGRATION_SET_SHA256");
    expect(manager).toContain("config --format json | jq --compact-output --sort-keys '.'");
    expect(manager).toContain(
      'expected_networks="$(printf \'%s\\n\' "${production_networks[@]}" | sort)"',
    );
    for (const field of [
      "CONFIG_HASH",
      "IMAGE_REF",
      "IMAGE_ID",
      "OCI_REVISION",
      "CONTAINER_ID",
      "NETWORK_MODE",
      "NETWORK_ATTACHMENTS_SHA256",
      "ATTESTED_STATE",
      "ATTESTED_EXIT_CODE",
    ]) {
      expect(manager).toContain(`SERVICE_%s_${field}`);
    }
    for (const field of ["NAME", "ID", "INTERNAL", "IPAM_SHA256"]) {
      expect(manager).toContain(`NETWORK_%s_${field}`);
    }
    expect(manager).toContain(
      '"$(network_attestation_value "${network}" ID)" == "${CURRENT_NETWORK_ID[${network}]}"',
    );
    expect(manager).toContain('"$(attestation_value "${service}" NETWORK_ATTACHMENTS_SHA256)" ==');
    expect(manager).toContain('with_entries(.value = {"NetworkID": .value.NetworkID})');
    expect(manager).toContain(
      "readonly one_shot_services=(config-preflight db-migrate db-bootstrap)",
    );
    expect(manager).toContain(
      "readonly production_networks=(backend browser-control browser-egress browser-vnc bridge-api frontend governance-host)",
    );
    expect(manager).toContain("backend|bridge-api|browser-control|browser-vnc|governance-host)");
    expect(manager).toContain('$config[0].subnet == "172.30.11.0/29"');
    expect(manager).toContain('$config[0].gateway == "172.30.11.1"');
    expect(manager).toContain('$config[0].Subnet == "172.30.11.0/29"');
    expect(manager).toContain('$config[0].Gateway == "172.30.11.1"');
    expect(manager).toContain(
      "canonical governance-host IPAM drifted from the private proxy subnet",
    );
    expect(manager).toContain(
      "actual governance-host Docker IPAM drifted from the private proxy subnet",
    );
    expect(manager).toContain(
      "readonly long_running_services=(postgres plastic-promise-host-proxy plastic-promise-proxy browser-host api worker agent-mcp ctrip-bridge web edge)",
    );
    expect(manager).toContain('"${CURRENT_STATE}" == exited && "${CURRENT_EXIT_CODE}" == 0');
    expect(manager).toContain("canonical Compose graph must be refreshed before image resolution");
    expect(manager).toContain(".services[$service].image // empty");
    expect(manager).not.toContain('config --images "${service}"');
    expect(manager).toContain("canonical Compose graph must be refreshed before config hashing");
    expect(manager).toContain(".services[$service].network_mode // empty");
    expect(manager).toContain("network_mode: container:%s");
    expect(manager).toContain('"${compose[@]}" -f - config --hash "${service}"');
    expect(manager).toContain('mv -fT -- "${attestation_stage}" "${ATTESTATION_FILE}"');
    expect(manager).toContain("global ${operation_timeout_seconds}s ${action} deadline expired");
    expect(manager).toContain('docker_before_deadline start "${container_id}"');
    expect(manager).toContain('docker_before_deadline restart "${container_id}"');
    expect(manager).toContain(
      "local-only resume is inhibited until the restore marker and clearance transaction gate are absent",
    );
    expect(manager).toContain(
      'if [[ -e "${RESTORE_CLEARANCE_GATE}" || -L "${RESTORE_CLEARANCE_GATE}" ]]',
    );
    expect(manager).toContain(
      "validate_restore_inhibit_file \"${RESTORE_CLEARANCE_GATE}\" 'restore clearance transaction gate'",
    );
    expect(manager).toContain(
      'cmp --silent -- "${RESTORE_INHIBIT_MARKER}" "${RESTORE_CLEARANCE_GATE}"',
    );
    expect(manager).toContain(
      '"${restore_inhibit_present}" == true || "${restore_clearance_present}" == true',
    );
    expect(manager).toContain(
      "deployment mutation is inhibited while restore clearance transaction is active",
    );
    expect(manager.indexOf('if [[ "${restore_clearance_present}" == true ]]')).toBeLessThan(
      manager.indexOf('elif [[ "${restore_inhibit_present}" == true ]]'),
    );
    expect(manager).toContain(
      "deployment mutation under restore inhibit requires explicit restore-recovery authorization",
    );
    expect(launcher).toContain("usage: start-production.sh [--restore-recovery]");
    expect(launcher).toContain("GEO_RESTORE_RECOVERY=1");
    expect(launcher).toContain('tee -a "${START_LOG}" 9>&-');
    expect(launcher).toContain("manage_convergence invalidate");
    expect(launcher).toContain("manage_convergence attest");
    expect(manager.indexOf("readonly operation_deadline=")).toBeLessThan(
      manager.indexOf("docker_local info"),
    );
    expect(manager).toContain('timeout --signal=TERM --kill-after=5s "${command_timeout}s"');
    expect(manager.indexOf("recover_service browser-host")).toBeLessThan(
      manager.indexOf("recover_service ctrip-bridge"),
    );
    expect(manager).not.toContain('"${compose[@]}" up');
    expect(manager).not.toContain('"${compose[@]}" build');
    expect(manager).not.toContain('"${compose[@]}" pull');
    expect(manager).not.toContain('"${compose[@]}" run');
  });

  it("requires explicit dependency installation and first-backup authorization", async () => {
    const installer = await source("install-production-operations.sh");
    expect(installer).toContain("--install-dependencies");
    expect(installer).toContain(
      "apt-get install --yes restic curl jq dnsutils openssl ca-certificates",
    );
    expect(installer).toContain("systemctl enable --now geo-saas-health.timer");
    expect(installer).not.toContain(
      "systemctl enable --now geo-saas-health.timer geo-saas-backup.timer",
    );
    expect(installer).toContain("sudo systemctl start geo-saas-backup-init.service");
    expect(installer).toContain("sudo systemctl enable --now geo-saas-backup.timer");
    expect(installer).not.toContain("NOPASSWD");
    expect(installer).toContain("production geo.env/Compose configuration is invalid");
    expect(installer).toContain("systemd-analyze verify");
    expect(installer).toContain('runuser --user "${deploy_user}" -- env -i');
    expect(installer).toContain("geo-saas-restore-inhibit.service");
    expect(installer).toContain("hold-production-restore-inhibit.sh");
    expect(installer).toContain("clear-production-restore-inhibit.sh");
    expect(installer).toContain("disable the local-scope operations timer");
  });

  it("installs domain-independent local timers without weakening full operations", async () => {
    const installer = await source("install-production-local-operations.sh");
    const localHealthService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-local-health.service.in"),
      "utf8",
    );
    const localBackupService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-local-backup.service.in"),
      "utf8",
    );
    const localHealthTimer = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-local-health.timer"),
      "utf8",
    );
    const localBackupTimer = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-local-backup.timer"),
      "utf8",
    );

    expect(installer).toContain("systemctl enable --now geo-saas-local-health.timer");
    expect(installer).not.toContain(
      "systemctl enable --now geo-saas-local-health.timer geo-saas-local-backup.timer",
    );
    expect(installer).toContain("disable the full operations timer");
    expect(installer).not.toContain("--install-dependencies");
    expect(installer).not.toContain("operations-alert.env");
    expect(installer).not.toContain("operations-backup.env");
    expect(localHealthService).toContain("check-production-health.sh --local-only");
    expect(localBackupService).toContain("run-production-backup-cycle.sh --local-only");
    expect(localHealthService).not.toContain("OnFailure=");
    expect(localBackupService).not.toContain("OnFailure=");
    expect(localHealthTimer).toContain("Persistent=true");
    expect(localBackupTimer).toContain("Persistent=true");
    expect(installer).toContain("remove the managed local cron block");
  });

  it("manages one exact deploy-user cron block without overlapping systemd", async () => {
    const cron = await source("manage-production-local-cron.sh");
    const fullInstaller = await source("install-production-operations.sh");

    expect(cron).toContain("Usage: manage-production-local-cron.sh install|verify|remove");
    expect(cron).toContain("# BEGIN GEO_SAAS_LOCAL_OPERATIONS");
    expect(cron).toContain("# END GEO_SAAS_LOCAL_OPERATIONS");
    expect(cron).toContain("check-production-health.sh --local-only");
    expect(cron).toContain("run-production-backup-cycle.sh --local-only");
    expect(cron).toContain("--identifier=geo-saas-local-health");
    expect(cron).toContain("--identifier=geo-saas-local-backup");
    expect(cron).toContain("systemctl is-active --quiet cron");
    expect(cron).toContain("systemctl is-enabled --quiet cron");
    expect(cron).toContain("disable the systemd operations timer before enabling local cron");
    expect(cron).toContain("the managed local operations block drifted");
    expect(fullInstaller).toContain("remove the managed local cron block");
  });

  it("strictly allowlists operations variables and pins the service PATH", async () => {
    const validator = await source("validate-production-operations-env.sh");
    const healthService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-health.service.in"),
      "utf8",
    );
    expect(validator).toContain("forbidden or unknown key");
    expect(validator).toContain("operations secret root must be deploy-owned with mode 700");
    expect(validator).toContain("env must be owned by the deploy user");
    expect(validator).toContain(
      "loaded service environment does not match ${validation_domain} env",
    );
    expect(validator).toContain("the rclone backend requires RCLONE_CONFIG");
    expect(healthService).toContain(
      "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(healthService).toContain("EnvironmentFile=/srv/geo-saas/secrets/operations-health.env");
    expect(healthService).not.toContain("operations-backup.env");
    const alertService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-alert@.service.in"),
      "utf8",
    );
    expect(alertService).toContain("EnvironmentFile=/srv/geo-saas/secrets/operations-alert.env");
    expect(alertService).not.toContain("operations-backup.env");
    const alert = await source("send-operations-alert.sh");
    expect(alert).toContain("curl --disable --config -");
    expect(alert).toContain('printf \'url = "%s"\\n\' "${webhook_url}"');
    expect(alert).not.toContain('"${webhook_url}" >/dev/null');
  });

  it("uses persistent timers and routes failures to the alert unit", async () => {
    const healthTimer = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-health.timer"),
      "utf8",
    );
    const backupTimer = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-backup.timer"),
      "utf8",
    );
    const healthService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-health.service.in"),
      "utf8",
    );
    const backupService = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-backup.service.in"),
      "utf8",
    );
    expect(healthTimer).toContain("Persistent=true");
    expect(backupTimer).toContain("Persistent=true");
    expect(healthService).toContain("OnFailure=geo-saas-alert@%n.service");
    expect(backupService).toContain("OnFailure=geo-saas-alert@%n.service");
    expect(healthService).toContain("420s manager process cap");
    expect(healthService).toContain("150s");
    expect(healthService).toContain("TimeoutStartSec=12min");
  });

  it("keeps incident restore inhibited across SSH and binds it to a verified backup", async () => {
    const hold = await source("hold-production-restore-inhibit.sh");
    const clear = await source("clear-production-restore-inhibit.sh");
    const lowLevelBackup = await source("backup-production.sh");
    const launcher = await source("start-production.sh");
    const restoreUnit = await readFile(
      join(repositoryRoot, "deploy/systemd/geo-saas-restore-inhibit.service.in"),
      "utf8",
    );

    expect(lowLevelBackup).toContain("--prepare-restore-inhibit");
    expect(lowLevelBackup.indexOf('verify-backup-bundle.sh"')).toBeLessThan(
      lowLevelBackup.indexOf("schema=geo.production-restore-inhibit.v1"),
    );
    expect(lowLevelBackup).toContain("pre_restore_backup_id=%s");
    expect(lowLevelBackup).toContain("pre_restore_checksum_sha256=%s");
    expect(lowLevelBackup).toContain('sync -f "${deployment_lock_parent}"');
    expect(hold).toContain("validate_marker");
    expect(hold).not.toContain("create_or_validate_marker");
    expect(hold).toContain("systemd-notify --ready");
    expect(clear).toContain("pre_restore_checksum_sha256=");
    expect(launcher).toContain("--restore-recovery");
    expect(restoreUnit).toContain("Type=notify");
    expect(restoreUnit).toContain("Restart=no");
  });
});
