# Linux Backup and Restore

## Scope

PostgreSQL is the truth source for tenants, facts, policy, variants, grants, jobs, receipts, acceptance
gates, audit logs, and visibility evidence. `/srv/geo-saas/data/evidence` and
`/srv/geo-saas/data/media` contain file bytes referenced by database rows, while
`/srv/geo-saas/data/ctrip-runtime` contains durable Bridge recovery state. They form one recovery set:
never restore the database without the matching application-files archive or mix artifacts from
different backup IDs.

This runbook provides a stopped-writer logical backup. It does not provide WAL archiving or point-in-
time recovery. Define and rehearse RPO/RTO separately. Browser profiles contain live session secrets
and are outside the normal recovery set; protect them with a separately approved encrypted procedure
when session recovery is required.

`/srv/geo-saas/data/caddy-data` and `/srv/geo-saas/data/caddy-config` are also secret state. They may
contain the ACME account, certificate private keys, issued certificates, and Caddy autosave data. The
ordinary backup deliberately excludes both roots and the version-2 manifest records
`caddy_state_policy=excluded-reissue`. This deployment's recovery policy is to obtain a new
certificate from empty Caddy state and prove it from outside the server. Never add either root to
`application-files.tar.gz`, copy it to unencrypted off-host storage, or interpret a passing database
rehearsal as proof that HTTPS has recovered. A future decision to preserve this state requires a
separately reviewed encrypted recovery set and offline key-custody/rehearsal procedure.

All Docker commands below run on the Linux server. Do not run them on the development workstation.

## Preconditions

Run every command as the non-root deploy user on the Linux server from the immutable release. The
backup and rehearsal scripts fix Docker to the local daemon, render the checked-in Compose files,
and never read shell-exported database passwords. The production env file remains server-only.
The three ordinary application-data roots and every archived entry must be readable and owned by
the deploy UID, with mode `0700` on each root. Archive creation therefore runs directly as deploy
and needs no sudo or passwordless root command.

```bash
set -Eeuo pipefail
umask 077
cd /srv/geo-saas/app/current
test -f .geo-release
```

Activate the tenant Kill Switch and hold Phase A/B/C transitions before the maintenance window. A
consumed Ctrip permit or uncertain submit must be reconciled before backup; stopping a container does
not make that state retryable.

## Create one consistent recovery set

Run the production backup entrypoint. It stops every application writer, verifies that each writer is
stopped, keeps PostgreSQL running, creates a custom-format no-owner/no-ACL dump, archives the three
application-file roots, and records the rendered image inventory. Before stopping anything, it applies
the launcher's strict newline, `KEY=value`, and unique-key grammar to the production env file. It also
requires both Caddy state roots to be owned by the fixed container UID `1000` with mode `0700`, but
never reads or archives their contents:

```bash
/srv/geo-saas/app/current/scripts/backup-production.sh
```

The script leaves writers stopped and prints two paths:

- `/srv/geo-saas/backups/<backup-id>/` is the private bundle. It contains exactly
  `postgres.dump`, `application-files.tar.gz`, `manifest.txt`, and `images.json`.
- `/srv/geo-saas/backups/<backup-id>.sha256` is the checksum set outside the bundle. The manifest
  records the Compose project resolved from the deployment rather than assuming a project name, and
  records the mandatory Caddy exclusion/reissuance policy.

The entrypoint runs the read-only verifier before reporting success. The verifier requires the
checksum file to be outside the bundle, rejects missing or extra artifacts, strictly parses every
manifest/checksum field, checks release and Compose-project identity, rejects unsafe tar paths,
links, and special files, then runs `pg_restore --list` in the digest-pinned PostgreSQL image with no
network and a read-only dump mount. It first binds every source pathname to an open descriptor and
copies the bytes into a deploy-owned mode-`0700` private snapshot; checksums, tar inspection, and
`pg_restore` consume only that snapshot. A standalone verification removes its temporary snapshot on
exit. The verifier container is ephemeral and receives no secret or database network access.
Once writer shutdown begins, every Docker, dump, archive, and verifier command consumes a shared
15-minute deadline. A timeout is a failed recovery-set attempt; the scheduled wrapper immediately
runs its bounded attested resume before reporting failure.

Copy the complete bundle to encrypted, access-controlled off-host storage. Transfer the `.sha256`
file through a separate authenticated channel or store it under a separate integrity control; its
location next to the server staging bundle is not the off-host integrity boundary. Record retention,
operator, ticket, RPO/RTO, and storage-object checksum outside the bundle. A dump contains customer
content, password hashes, contacts, and governance evidence; never commit or attach it to an
unencrypted issue.

Resume the unchanged deployment only after the off-host copy and checksum have been confirmed:

```bash
/srv/geo-saas/app/current/scripts/start-production.sh
```

For the scheduled encrypted offsite cycle, use the systemd workflow in
[unattended-operations.md](unattended-operations.md). It restores application availability before
transport, downloads and strictly verifies the stored snapshot, and alerts on any incomplete gate.
Do not schedule this low-level stopped-writer entrypoint directly.

## Isolated restore rehearsal

Rehearse the approved bundle on an isolated Linux Docker host before any incident restore. Do not
point this command at the production Docker host while the production project is running:

```bash
/srv/geo-saas/app/current/scripts/rehearse-production-restore.sh \
  --bundle /srv/geo-saas/backups/<approved-backup-id> \
  --checksum-file /srv/geo-saas/backups/<approved-backup-id>.sha256
```

The rehearsal applies the same strict env grammar and derives the expected release, Compose project,
database name, and role names from the immutable release and its env file. It then:

1. runs the strict bundle verifier into a retained private snapshot before creating database state;
2. refuses any pre-existing rehearsal container, network, or PostgreSQL volume;
3. explicitly creates a no-options local named volume, verifies its Compose labels, creates the
   PostgreSQL container without starting it, and rejects any state or mount other than the exact fresh
   volume;
4. starts only that inspected PostgreSQL container and waits for its health check;
5. extracts the matching application-files archive from the same verified snapshot into a new
   retained staging root and checks its exact three-root shape;
6. restores the snapshotted dump into that fresh database, runs `db-migrate`, then runs `db-bootstrap`;
7. compares the exact restored migration inventory to every shipped migration;
8. verifies NOLOGIN/runtime/login role boundaries, ACLs, forced RLS, and two-way cross-tenant read and
   update denial inside a rolled-back transaction;
9. records that Caddy state remains excluded and reissuance is still required; and
10. stops PostgreSQL, writes a non-secret report, and retains the isolated files, containers, and volume
    for reviewer inspection.

The script never loads `compose.production.yaml`, starts an application service, runs `db-seed`, or
deletes rehearsal Docker resources. Stopped rehearsal containers and the rehearsal volume are
retained. Cleanup requires the normal report-and-approval process.

For a manual incident restore, do not validate one pathname and then reopen the original bundle
pathname later. Repeat `verify-backup-bundle.sh` with a new private `--snapshot-root`, record its
`Verified private snapshot` path, and use that retained snapshot for both the dump and application
archive commands below. Remove the private snapshot only after the restore or its investigation is
closed.

## Incident restore

Proceed only after a passing isolated rehearsal and reviewer sign-off. Obtain incident/change
approval, activate the Kill Switch, set the automation controls to a non-submitting state, select
`browser_draft`, keep Producer disabled, and preserve a pre-restore recovery set. Do not delete or
rewrite an append-only Phase B canary to imitate Phase A.

First disable both unattended timers and wait until the health and backup services are exactly
`inactive`. A timer may already have triggered its service; do not start the inhibit while either
service is still activating, running, deactivating, or failed. Let an in-progress backup complete its
bounded recovery, then use `systemctl stop` only to normalize a completed failed oneshot if needed:

```bash
sudo systemctl disable --now geo-saas-health.timer geo-saas-backup.timer
while systemctl is-active --quiet geo-saas-health.service || \
  systemctl is-active --quiet geo-saas-backup.service; do
  sleep 5
done
sudo systemctl stop geo-saas-health.service geo-saas-backup.service
test "$(systemctl show -p ActiveState --value geo-saas-health.service)" = inactive
test "$(systemctl show -p ActiveState --value geo-saas-backup.service)" = inactive
```

With the timers disabled, create the pre-restore recovery set. This low-level entrypoint leaves the
writers stopped and, only after bundle verification succeeds, atomically publishes the persistent
restore marker while it still owns the deployment lock. Inspect and retain both printed paths; do
not invoke the ordinary launcher between this backup and the inhibit:

```bash
pre_restore_id="$(date -u +%Y%m%dT%H%M%SZ-pre-restore)"
/srv/geo-saas/app/current/scripts/backup-production.sh \
  --backup-id "${pre_restore_id}" \
  --prepare-restore-inhibit
```

Immediately transfer lock ownership to the systemd inhibit. The already-published marker prevents
ordinary startup, health recovery, commissioning, rollback, and scheduled/low-level backup during
the short handoff. `Type=notify` makes `systemctl start` wait until the deploy-user process validates
that marker, holds the maintenance lock and then the deployment lock, and has reported ready. The
unit remains active across SSH disconnects. Its marker remains after any stop or abnormal exit:

```bash
sudo systemctl start geo-saas-restore-inhibit.service
systemctl is-active --quiet geo-saas-restore-inhibit.service
test "$(stat -c '%U:%a:%h' /srv/geo-saas/secrets/.geo-restore-inhibit)" = \
  "$(id -un):600:1"
test "$(wc -l </srv/geo-saas/secrets/.geo-restore-inhibit)" = 6
grep -Eq '^pre_restore_backup_id=[0-9]{8}T[0-9]{6}Z-pre-restore$' \
  /srv/geo-saas/secrets/.geo-restore-inhibit
```

Do not proceed if the service did not become active. Never delete the marker manually. If the SSH
connection drops, reconnect and prove the unit is still active before continuing.

1. Put the approved bundle and separately authenticated checksum under `/srv/geo-saas/backups`. The
   isolated rehearsal must already have passed before entering the inhibit; do not rerun its
   lock-taking entrypoint while the inhibit owns the deployment lock. Bind the source paths into a
   new verifier-owned private
   snapshot and use only that snapshot for the incident. Recreate the production Compose command
   only after both checks pass:

```bash
cd /srv/geo-saas/app/current
compose=(docker compose --env-file /srv/geo-saas/secrets/geo.env \
  -f compose.yaml -f compose.production.yaml --profile production)
source_bundle=/srv/geo-saas/backups/<approved-backup-id>
source_checksum=/srv/geo-saas/backups/<approved-backup-id>.sha256
release_revision="$(tr -d '\n' <.geo-release)"
compose_project="$("${compose[@]}" config --environment | \
  awk -F= '$1 == "COMPOSE_PROJECT_NAME" { value=$2; count += 1 } END { if (count == 1) print value }')"
test -n "${compose_project}"
snapshot_root="$(mktemp -d /srv/geo-saas/backups/.incident-snapshot.XXXXXX)"
/srv/geo-saas/app/current/scripts/verify-backup-bundle.sh \
  --bundle "${source_bundle}" \
  --checksum-file "${source_checksum}" \
  --expected-release "${release_revision}" \
  --expected-project "${compose_project}" \
  --compose-file /srv/geo-saas/app/current/compose.yaml \
  --snapshot-root "${snapshot_root}"
restore_bundle="${snapshot_root}/$(basename -- "${source_bundle}")"
restore_checksum="${snapshot_root}/$(basename -- "${source_checksum}")"
test -d "${restore_bundle}" && test -f "${restore_checksum}"
```

Do not continue after any verifier, rehearsal, identity, archive, dump, migration, ACL, or isolation
failure.

Never reset `restore_bundle` to the original source path after this point. Retain the private
snapshot through investigation and sign-off.

2. Confirm all application writers/readers remain stopped after the pre-restore recovery set. Stop
   any residual application service before touching the database or files:

```bash
"${compose[@]}" stop edge ctrip-bridge agent-mcp worker api web browser-host
```

3. Ensure the fixed NOLOGIN roles exist before restore, then restore the logical archive with
   stop-on-error behavior:

```bash
"${compose[@]}" --profile restore-tools run --rm db-restore-roles
"${compose[@]}" cp "${restore_bundle}/postgres.dump" postgres:/tmp/restore.dump
"${compose[@]}" exec -T postgres sh -lc \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore \
    --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --clean --if-exists --no-owner --no-acl --exit-on-error /tmp/restore.dump'
"${compose[@]}" exec -T postgres rm -f /tmp/restore.dump
```

4. Extract application files into a staging directory, validate the top-level shape, then quarantine
   the current set and install the matching set. Do not delete the quarantine during the rehearsal:

```bash
restore_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp -d /srv/geo-saas/data/.restore.XXXXXX)"
quarantine="/srv/geo-saas/data/quarantine-${restore_stamp}"
sudo tar --extract --gzip --numeric-owner --acls --xattrs \
  --file="${restore_bundle}/application-files.tar.gz" --directory="${stage}"
test -d "${stage}/evidence" && test -d "${stage}/media" && test -d "${stage}/ctrip-runtime"
test "$(find "${stage}" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | paste -sd, -)" = \
  'ctrip-runtime,evidence,media'
sudo install -d -o root -g root -m 0700 "${quarantine}"
sudo mv /srv/geo-saas/data/evidence /srv/geo-saas/data/media \
  /srv/geo-saas/data/ctrip-runtime "${quarantine}/"
sudo mv "${stage}/evidence" "${stage}/media" "${stage}/ctrip-runtime" /srv/geo-saas/data/
rmdir "${stage}"
sudo chown -R 1000:1000 /srv/geo-saas/data/evidence /srv/geo-saas/data/media \
  /srv/geo-saas/data/ctrip-runtime
sudo chmod 0700 /srv/geo-saas/data/evidence /srv/geo-saas/data/media \
  /srv/geo-saas/data/ctrip-runtime
```

5. Reuse Caddy state only when restoring application data on the same uncompromised host and the
   existing state is explicitly trusted. For replacement-host recovery, lost/corrupt state, or any
   incident that may have exposed the private key, preserve the old roots in a root-only quarantine
   and recreate both roots empty. The edge must already be stopped by step 2:

```bash
caddy_restore_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
caddy_quarantine="/srv/geo-saas/data/caddy-quarantine-${caddy_restore_stamp}"
test ! -e "${caddy_quarantine}" && test ! -L "${caddy_quarantine}"
for caddy_root in caddy-data caddy-config; do
  test -d "/srv/geo-saas/data/${caddy_root}"
  test ! -L "/srv/geo-saas/data/${caddy_root}"
done
sudo install -d -o root -g root -m 0700 "${caddy_quarantine}"
for caddy_root in caddy-data caddy-config; do
  sudo mv -- "/srv/geo-saas/data/${caddy_root}" "${caddy_quarantine}/${caddy_root}"
  sudo install -d -o 1000 -g 1000 -m 0700 "/srv/geo-saas/data/${caddy_root}"
  test "$(stat -c '%u:%g:%a' "/srv/geo-saas/data/${caddy_root}")" = '1000:1000:700'
  test -z "$(find "/srv/geo-saas/data/${caddy_root}" -mindepth 1 -print -quit)"
done
```

Keep the quarantine out of the ordinary backup and retain it only under incident approval; it
still contains private keys. Confirm authoritative DNS points only to the restored server, TCP
80/443 can reach it, and the CA is available before starting. Empty-state reissuance can extend RTO
or fail under CA account/domain rate limits. Do not repeatedly clear Caddy state to retry issuance.

6. Reconcile the schema and all independent role/ACL definitions. Never run `db-seed` after restore:

```bash
"${compose[@]}" run --rm --no-deps db-migrate
"${compose[@]}" run --rm --no-deps db-bootstrap
```

The restored migration table may make migration a no-op. `db-bootstrap` must still recreate/rotate
least-privilege login roles and replay the standalone ACL reconciliation.

7. Before restart, verify:

- every shipped migration is present;
- API, worker, identity, and Bridge role boundaries pass, including a cross-tenant denial test;
- append-only receipt/audit counts match the recovery evidence;
- every restored media/evidence reference resolves to the expected hash and bytes;
- the Kill Switch remains active, Producer remains disabled, and acceptance is non-submitting;
- queued, leased, retry, uncertain, consumed-permit, and readback states match the incident decision;
- Plastic Promise and real Pi configuration are present but no external action has been resumed;
- the Caddy state decision is recorded; when reissuing, both Caddy roots are empty, owned by UID/GID
  `1000:1000`, and mode `0700`.

8. Stop the lock-holding unit but retain its persistent marker, then start through the complete
   production launcher. Keep both timers disabled throughout this window:

On the server:

```bash
sudo systemctl stop geo-saas-restore-inhibit.service
test "$(systemctl show -p ActiveState --value geo-saas-restore-inhibit.service)" = inactive
test -f /srv/geo-saas/secrets/.geo-restore-inhibit
/srv/geo-saas/app/current/scripts/start-production.sh --restore-recovery
```

9. From the operator workstation, prove certificate issuance and both application routes through the public
   route. Capture the successful verifier output as incident evidence and record its UTC completion
   time and SHA-256. Run this within one hour of the clear helper:

```bash
set -o pipefail
external_https_evidence="evidence/restore-external-https-$(date -u +%Y%m%dT%H%M%SZ).log"
/path/to/release/scripts/verify-production-https.sh \
  <production-domain> <production-ipv4> | tee "${external_https_evidence}"
external_https_verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
external_https_evidence_sha256="$(shasum -a 256 "${external_https_evidence}" | awk '{print $1}')"
printf 'verified_at=%s sha256=%s\n' \
  "${external_https_verified_at}" "${external_https_evidence_sha256}"
```

An internal Caddy health check, a listening port, or a locally generated certificate does not close
the recovery gate. The external verifier must see trusted HTTPS for the production hostname. If
issuance or that verification fails, keep the Kill Switch active and do not represent the service as
production-reachable.

10. Back on the server, pass the exact external timestamp and evidence hash to the only supported
    marker-clear path. The helper does not repeat or independently prove external reachability. It
    safely acquires maintenance then deployment, requires the inhibit unit and both timers/services
    to remain inactive, verifies the current convergence attestation, and rechecks that the external
    evidence is still no more than one hour old immediately before committing clearance:

```bash
/srv/geo-saas/app/current/scripts/clear-production-restore-inhibit.sh \
  --external-https-verified-at <YYYY-MM-DDTHH:MM:SSZ> \
  --external-https-evidence-sha256 <lowercase-sha256>
test ! -e /srv/geo-saas/secrets/.geo-restore-inhibit
test ! -e /srv/geo-saas/secrets/.geo-restore-inhibit-clearance
```

The helper first publishes and syncs an exact six-line marker copy at
`.geo-restore-inhibit-clearance`. Every production entrypoint treats that transaction gate as an
active inhibit. Any later failure restores the primary marker and gate before releasing the locks;
rerunning the helper validates both copies and resumes the transaction. Investigate, rerun the
complete production launcher and external verifier as necessary, then retry. Never substitute `rm`
or `unlink` for either path.

11. Only after the clear helper succeeds, re-enable both timers and verify their next runs:

```bash
sudo systemctl enable --now geo-saas-health.timer geo-saas-backup.timer
systemctl list-timers --all geo-saas-health.timer geo-saas-backup.timer
```

Do not resume Phase B/C or unattended work automatically. Record the restore bundle ID, checksum
result, release/image versions, migration/ACL results, tenant-isolation result, content-hash sample,
Caddy state decision, external HTTPS result, operator, reviewer, and decision. Retain the quarantine
until formal sign-off.

## Snapshot warning

A raw copy of `/srv/geo-saas/data/postgres` while PostgreSQL is running is not a valid backup.
Filesystem snapshots require PostgreSQL-consistent snapshot tooling and a tested recovery path. A
database-only dump is also incomplete once evidence or media rows reference host bytes.
