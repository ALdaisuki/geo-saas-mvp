# PostgreSQL Backup and Restore

## Scope and ownership

PostgreSQL is the truth source for tenants, facts, policy bundles, variants, grants, jobs, receipts, audit logs and visibility evidence. The `evidence-data` volume is reserved for file evidence, although current API code does not yet persist to it; back it up independently once a writer is implemented.

Define and test an RPO/RTO per customer contract. This runbook provides logical backups only. It does not configure WAL archiving or point-in-time recovery.

## Create a logical backup

Use the admin role inside the PostgreSQL container, write the binary custom-format dump in the container, then copy it without passing binary data through Windows PowerShell redirection.

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose exec -T postgres sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-acl --file=/tmp/geo-saas.dump'
docker compose cp postgres:/tmp/geo-saas.dump ".\backups\geo-saas-$stamp.dump"
docker compose exec -T postgres rm -f /tmp/geo-saas.dump
Get-FileHash ".\backups\geo-saas-$stamp.dump" -Algorithm SHA256 | Format-List
```

Validation is mandatory:

```powershell
docker compose cp ".\backups\geo-saas-$stamp.dump" postgres:/tmp/verify.dump
docker compose exec -T postgres pg_restore --list /tmp/verify.dump
docker compose exec -T postgres rm -f /tmp/verify.dump
```

Store the dump, checksum, image tag, Git commit, migration list, timestamp and operator ticket in encrypted off-host storage. A backup containing customer content, contact data, password hashes or tokens is confidential. Do not commit it or attach it to an unencrypted issue.

The dump excludes role definitions and ACLs. `db-migrate` and `db-bootstrap` are the reproducible source for NOLOGIN roles, login roles and grants; database passwords stay in the secret manager.

## Restore rehearsal

Rehearse on an isolated host/network with different secrets. A restore has not succeeded until tenant isolation, audit/grant invariants and fixture/manual evidence labels are checked.

1. Record the incident/change ticket and activate the Kill Switch if restoring a live environment.
2. Stop all application writers and readers:

```powershell
docker compose stop agent-mcp worker api web
```

3. Take and preserve a pre-restore dump. Copy the approved restore artifact into PostgreSQL:

```powershell
docker compose cp .\backups\approved.dump postgres:/tmp/restore.dump
docker compose exec -T postgres sh -lc 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --clean --if-exists --no-owner --no-acl --exit-on-error /tmp/restore.dump'
docker compose exec -T postgres rm -f /tmp/restore.dump
```

When invoking `pg_restore` outside the container shell, ensure the admin password is supplied by the existing container environment or an interactive prompt; never add it to the command line.

4. Reconcile schema and recreate/rotate least-privilege login roles:

```powershell
docker compose run --rm --no-deps db-migrate
docker compose run --rm --no-deps db-bootstrap
```

Do **not** run `db-seed` after a restore. The fixture seed can rewrite example automation controls and is not production recovery data.

5. Inspect before restart:

- the Kysely migration table contains every shipped migration;
- `geo_api` can `SET LOCAL ROLE geo_runtime` but cannot become `geo_dispatcher`;
- `geo_worker` can switch to both required NOLOGIN roles;
- `geo_identity_login` has no table SELECT and, among `geo` application functions, can execute only `geo.find_login_identity(text)` and `geo.find_login_identity_by_user(uuid)` through NOLOGIN `geo_identity`;
- the tenant Kill Switch remains enabled until incident approval;
- issued grants and queued/retry/uncertain jobs match the recovery decision;
- append-only receipts and audit log counts match the backup evidence.

6. Start the API first, execute an authenticated read and cross-tenant denial test, then start worker/MCP/web in that order. Do not resume unattended work automatically.

## Volume snapshots

A raw `postgres-data` volume copy while PostgreSQL is running is not a valid backup. Filesystem snapshots require PostgreSQL-consistent snapshot tooling and a tested restore path. The `evidence-data` volume must be versioned together with database evidence references once file persistence is implemented.
