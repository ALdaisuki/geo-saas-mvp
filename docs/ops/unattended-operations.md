# Unattended Production Operations

This runbook installs five host-owned runtime controls on the Linux production server:

- a two-minute health check that verifies a deploy-owned convergence attestation, public DNS, and
  the local edge's trusted TLS, API readiness, and certificate lifetime;
- one local-only, globally bounded start or restart for an exited or unhealthy attested container;
- a daily consistent backup, client-side encrypted offsite transport, complete readback, strict
  bundle verification, and retention cycle; and
- an HTTPS failure webhook containing only an event code, hostname, severity, and UTC timestamp; and
- a manually started, systemd-owned incident-restore inhibit that survives the operator SSH session.

The health service shares `/srv/geo-saas/secrets/.geo-deployment.lock` with startup, rollback, and
scheduled backup. It exits successfully while planned maintenance owns the separate maintenance
lock. Incident restore additionally disables both operations timers and uses a persistent inhibit;
an interactive shell lock alone is not a safe restore boundary. The health service never repairs
an absent/drifted attestation, image mismatch, or edit to `geo.env`; those conditions alert and remain
fail-closed. Compose's
`restart: unless-stopped` handles process exits and host reboot, while the health timer covers the
important Docker gap where a running container becomes `unhealthy` but is not restarted.
Missing containers also fail closed and alert; only the complete production launcher may create
containers because it owns the build, preflight, network, migration, and convergence sequence.

`start-production.sh` atomically invalidates
`/srv/geo-saas/secrets/.geo-production-convergence.attestation` before its first image, container, or
database mutation. It starts a 60-minute global deployment deadline immediately before that
invalidation; every subsequent Docker/Compose command is limited by the remaining budget and by a
30-minute per-command cap. Only after `compose up --wait` succeeds does it recheck all production one-shot
and long-running services and atomically publish a new deploy-owned mode-`0600` proof. The proof binds
the release, `geo.env` SHA-256, canonical rendered Compose graph, immutable release-owned bind-source
manifest, Compose project, public domain, approved Caddy digest, and exact migration set. It also
binds every Docker network's full ID, name, internal policy, and canonical IPAM hash, plus every
service's Compose config hash, image reference/ID, OCI revision, container ID, network mode, and
canonical network-attachment hash. Local-only recovery re-renders and re-inspects all of that state
before it starts or restarts any attested container.
Config preflight, migration, and role bootstrap must remain exited with code zero. A local-only resume
never builds, pulls, creates, or migrates and never starts those one-shot containers.

These controls do not invoke content generation, retrieval, memory, or publication workflows.
The ordinary cycle intentionally excludes Caddy ACME/private-key state and Browser Host profiles.
Caddy recovery therefore requires empty-state certificate reissuance and external HTTPS acceptance;
browser session recovery requires a separately approved encrypted profile procedure or a fresh
manual login. A passing restic cycle proves neither of those two recovery paths.
It also does not escrow the repository credentials, restic password, runtime secrets, or an OCI
registry. Those need independently protected offline custody and a clean-host rehearsal. These
controls support unattended runtime monitoring and recovery; they are not unattended replacement-
host disaster recovery.

## Domain-independent local scope

When a production domain, HTTPS alert receiver, or approved offsite restic repository is not yet
available, install the explicitly local-scoped units instead of weakening the full operations
validator. They run the same convergence-bound recovery and stopped-writer backup code, but they do
not verify DNS or HTTPS, deliver external alerts, upload backups, apply retention, or claim public
reachability. Local backup sets accumulate under `/srv/geo-saas/backups`; inspect available disk
space until the full offsite cycle and its retention policy are commissioned.

```bash
cd /srv/geo-saas/app/current
sudo scripts/install-production-local-operations.sh
sudo systemctl start geo-saas-local-health.service
sudo systemctl status --no-pager --full geo-saas-local-health.service
sudo systemctl start geo-saas-local-backup.service
sudo systemctl status --no-pager --full geo-saas-local-backup.service
sudo systemctl enable --now geo-saas-local-backup.timer
systemctl list-timers --all 'geo-saas-local-*'
```

The installer enables only the two-minute local health timer. Enable the local backup timer only
after its first stopped-writer cycle has passed and production convergence has been reverified.
Before installing full operations, disable both local timers so duplicate recovery and backup
cycles cannot run:

```bash
sudo systemctl disable --now geo-saas-local-health.timer geo-saas-local-backup.timer
sudo scripts/install-production-operations.sh --install-dependencies
```

Local scope is an interim runtime safeguard, not completion evidence for unattended production.
Public HTTPS acceptance, a successful webhook drill, encrypted offsite readback, retention, an
isolated restore rehearsal, and independent external monitoring remain mandatory.

If root access is temporarily unavailable but the system `cron` daemon is already active and
enabled at boot, the deploy user can install the same local-only scripts as a bounded fallback:

```bash
/srv/geo-saas/app/current/scripts/manage-production-local-cron.sh install
/srv/geo-saas/app/current/scripts/manage-production-local-cron.sh verify
journalctl --quiet _UID="$(id -u)" -t geo-saas-local-health --since today
```

The managed block runs health recovery every two minutes and a local backup at 03:15 server time.
Both commands have an outer timeout and write to the system journal. The manager preserves unrelated
crontab entries, rejects drift or duplicate commands, and refuses to coexist with either local or
full systemd operations timers. Before switching to systemd, explicitly remove the verified block:

```bash
/srv/geo-saas/app/current/scripts/manage-production-local-cron.sh remove
sudo /srv/geo-saas/app/current/scripts/install-production-local-operations.sh
```

The cron fallback has no `OnFailure` webhook. It therefore does not replace the full operations
units once external alerting and offsite backup credentials are available.

## Secret configuration

Install restic and the health dependencies only after explicit approval. The operations installer
can do this on Ubuntu when passed `--install-dependencies`; without the flag it only checks them.

Create three deploy-owned, mode-`0600` files under `/srv/geo-saas/secrets`. Each uses strict
newline-terminated `KEY=value` records. The validator rejects duplicate, unknown, and process-control
keys such as `PATH`. Splitting the files matters: health and alert services never receive restic or
object-storage credentials, and the backup service never receives the webhook URL.

```dotenv
# operations-health.env
GEO_PUBLIC_IPV4=<production IPv4>
```

```dotenv
# operations-alert.env
GEO_ALERT_WEBHOOK_URL_FILE=/srv/geo-saas/secrets/operations-alert-webhook.url
```

```dotenv
# operations-backup.env
RESTIC_REPOSITORY=<s3:|b2:|azure:|gs:|sftp:|rclone:|rest:https:// remote repository>
RESTIC_PASSWORD_FILE=/srv/geo-saas/secrets/restic-password
GEO_BACKUP_KEEP_DAILY=7
GEO_BACKUP_KEEP_WEEKLY=5
GEO_BACKUP_KEEP_MONTHLY=12
GEO_LOCAL_BACKUP_RETENTION_DAYS=7
<provider-specific restic credential variables>
```

Local filesystem repositories are rejected. Provider-specific credentials remain server-only and
are never printed by the scripts.

Accepted backend credentials are `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
`AWS_SESSION_TOKEN`/region values; `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY`; `AZURE_ACCOUNT_NAME` plus
`AZURE_ACCOUNT_KEY` or `AZURE_ACCOUNT_SAS`; `GOOGLE_APPLICATION_CREDENTIALS` and optional
`GOOGLE_PROJECT_ID`; `RESTIC_REST_USERNAME`/`RESTIC_REST_PASSWORD`; or `RCLONE_CONFIG` and optional
`RCLONE_CONFIG_PASS`. Credential/config files must be absolute, deploy-owned mode-`0600` files.
The SFTP backend reads a deploy-owned SSH configuration/key through read-only home access. The
installer requires the selected backend executable (`ssh` or `rclone`) but does not install rclone
implicitly.

Generate the restic repository password from a cryptographically secure source and store only the
password in `restic-password`, owned by the deploy user with mode `0600`. Keep an offline recovery
copy separate from both the server and offsite repository. Losing this password makes the backups
unrecoverable; storing it only beside the repository defeats client-side encryption.

Put one HTTPS webhook URL in `operations-alert-webhook.url`, also deploy-owned and mode `0600`.
The receiver must accept a compact JSON object with schema `geo.operations-alert.v1`. Test receiver
retention, escalation, and paging before treating alerting as operational.

## Install and commission

Run from the immutable release on the server. Dependency installation is deliberately explicit:

```bash
cd /srv/geo-saas/app/current
sudo scripts/install-production-operations.sh --install-dependencies
```

The installer starts only the health timer. It installs the restore-inhibit unit without enabling or
starting it, and it does not initialize a repository, run a backup, or enable the backup timer.
Initialize or authenticate to the selected offsite repository, then execute and inspect the first
full backup/readback cycle:

```bash
sudo systemctl start geo-saas-backup-init.service
sudo systemctl status --no-pager --full geo-saas-backup-init.service
sudo systemctl start geo-saas-backup.service
sudo systemctl status --no-pager --full geo-saas-backup.service
sudo systemctl enable --now geo-saas-backup.timer
systemctl list-timers --all 'geo-saas-*'
```

The backup service performs these ordered gates:

1. create and verify the stopped-writer local recovery set under the shared deployment lock;
2. immediately resume only the existing attested local containers before offsite I/O;
3. upload the exact bundle and out-of-band checksum through restic's authenticated encryption;
4. restore that snapshot into a new private local directory with `--verify`;
5. run `verify-backup-bundle.sh` on the downloaded bytes with the exact release and project;
6. apply daily/weekly/monthly remote retention; and
7. remove local complete recovery sets older than the configured local retention.

Any exit before step 2 completes triggers another attested local-only resume attempt. A failure after service recovery
leaves production running but fails the unit and sends an alert. Partial local backup artifacts are
retained for investigation and never removed by automatic retention.
The low-level backup starts a 15-minute global stopped-writer deadline before the first Compose stop,
and the service wrapper adds a 30-minute process cap. Docker, dump transport, archive creation, and
bundle verification consume only the remaining stopped-writer budget. The systemd unit grants ten
minutes of stop time so its 420-second EXIT recovery cannot be cut off by the host's 90-second default.

## Persistent incident-restore inhibit

An incident restore must not depend on an interactive shell keeping `flock` descriptors open. The
verified pre-restore backup publishes `/srv/geo-saas/secrets/.geo-restore-inhibit` while it still owns
the deployment lock. The `geo-saas-restore-inhibit.service` unit then runs as the deploy user,
validates that marker, opens the backup-maintenance lock first and the deployment lock second, and
sends `READY=1`. `systemctl start` returns only after that sequence, so the unit and both locks remain
active after the SSH command exits.

The six-line marker has schema `geo.production-restore-inhibit.v1`, is deploy-owned, mode `0600`, has
one link, and binds the pre-restore backup ID plus the SHA-256 of its out-of-band checksum file.
Stopping, killing, or failing the unit never removes it. That persistent state is deliberate:
an unexpected unit exit releases kernel locks, but cannot silently represent an interrupted restore
as cleared. The health and backup timers must remain disabled until the clear helper removes the
marker after full convergence and operator-supplied external HTTPS evidence.
Clearance uses a second persistent path,
`/srv/geo-saas/secrets/.geo-restore-inhibit-clearance`, containing an exact copy of the validated
six-line marker. Every production mutation and recovery entrypoint treats either path as an active
inhibit. The helper durably publishes this gate before removing the primary marker and removes it
only after the primary deletion is durable.

Before starting an incident restore, disable both timers and wait for their services to finish. Do
not kill an in-progress stopped-writer backup; let its bounded recovery complete, then normalize both
oneshot units to `inactive`:

```bash
sudo systemctl disable --now geo-saas-health.timer geo-saas-backup.timer
while systemctl is-active --quiet geo-saas-health.service || \
  systemctl is-active --quiet geo-saas-backup.service; do
  sleep 5
done
sudo systemctl stop geo-saas-health.service geo-saas-backup.service
test "$(systemctl show -p ActiveState --value geo-saas-health.service)" = inactive
test "$(systemctl show -p ActiveState --value geo-saas-backup.service)" = inactive
pre_restore_id="$(date -u +%Y%m%dT%H%M%SZ-pre-restore)"
/srv/geo-saas/app/current/scripts/backup-production.sh \
  --backup-id "${pre_restore_id}" --prepare-restore-inhibit
sudo systemctl start geo-saas-restore-inhibit.service
systemctl is-active --quiet geo-saas-restore-inhibit.service
```

The full recovery sequence, including the pre-restore recovery set, stop/start boundary, external
verification, clearance, and timer re-enable order, is mandatory in
[backup-restore.md](backup-restore.md). Never remove `.geo-restore-inhibit` with `rm`. The only valid
clear path is shown below. After the inhibit service is stopped, the full launcher is accepted only
with its explicit `--restore-recovery` option; ordinary startup remains fail-closed while the marker
exists.

```bash
/srv/geo-saas/app/current/scripts/clear-production-restore-inhibit.sh \
  --external-https-verified-at <YYYY-MM-DDTHH:MM:SSZ> \
  --external-https-evidence-sha256 <lowercase-sha256>
```

The helper requires the inhibit unit, both timers, and both operations services to be inactive. It
holds the two locks in the same order, strictly validates the marker, and calls
`manage-production-convergence.sh verify` against the deploy-owned convergence attestation before
rechecking the one-hour external-evidence window immediately before commit. The timestamp and hash are explicit operator assertions about
evidence captured from another host; the production server does not prove its own public network
reachability. Any failure after the transaction gate is published reconstructs the primary marker
and retains the gate before releasing either lock. A retry validates both copies and can complete the
transaction; the timers remain disabled until both paths are absent.

## Verification and alert drills

Run these after installation and after every operations release:

```bash
sudo systemctl start geo-saas-health.service
sudo systemctl status --no-pager --full geo-saas-health.service
sudo systemctl start geo-saas-alert@operator-test.service
journalctl -u geo-saas-health.service -u geo-saas-backup.service --since today
```

The host health unit calls the complete HTTPS verifier with `127.0.0.1` as its connection address.
It therefore proves authoritative A/AAAA records plus local Caddy routing, certificate trust and
expiry, Web/API behavior, SNI/Host rejection, and headers. It deliberately does not claim that the
public IP's security group, firewall, route, or upstream network is reachable from the Internet.

Quarterly, restore a selected offsite snapshot onto a separate Linux host and run the complete
isolated rehearsal in [backup-restore.md](backup-restore.md). A same-host readback proves encrypted
transport and stored bytes, but it does not replace the isolated database/ACL/tenant-isolation
rehearsal.

The production server cannot alert when it has lost power, networking, DNS, or the ability to reach
the webhook. Configure an independent external uptime monitor against
`https://<production-domain>/healthz` from at least two networks. Its alert route must not depend on
this server. Until the first restic readback, webhook drill, timer inspection, isolated restore
rehearsal, and external monitor test all pass, do not claim unattended recovery.
