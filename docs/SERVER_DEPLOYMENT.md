# Linux Production Deployment

## Supported topology

Production runs on a headless Linux server. Docker image builds, Compose validation, migrations,
services, headed Chromium, and noVNC all run there. macOS is not a Docker host for this deployment.

The application data plane is multi-tenant. The live Ctrip browser boundary is intentionally
single-tenant per running Bridge/browser instance: production preflight requires exactly one tenant
in `CTRIP_BRIDGE_TENANTS_JSON`, and its ID must match the gateway credential and
`CTRIP_BROWSER_TENANT_ID`. Each tenant gets a distinct profile, download, and artifact directory.
Never reuse or copy a browser profile across tenants.

## Server layout and ownership

Run `scripts/bootstrap-linux-server.sh` as the non-root deploy user through sudo. The pinned images
use these numeric identities:

| Host path                          |           Owner |   Mode | Purpose                                             |
| ---------------------------------- | --------------: | -----: | --------------------------------------------------- |
| `/srv/geo-saas/app`                |     deploy user | `0750` | immutable release directories and `current` symlink |
| `/srv/geo-saas/secrets`            |     deploy user | `0700` | server-only commissioning and production env files  |
| `/srv/geo-saas/backups`            |     deploy user | `0750` | encrypted/off-host staging for backup bundles       |
| `/srv/geo-saas/logs`               |     deploy user | `0750` | deployment and explicitly exported incident logs    |
| `/srv/geo-saas/data/postgres`      |   UID/GID `999` | `0700` | PostgreSQL bind-backed named volume                 |
| `/srv/geo-saas/data/evidence`      |  UID/GID `1000` | `0700` | API evidence bind-backed named volume               |
| `/srv/geo-saas/data/media`         |  UID/GID `1000` | `0700` | API media bind-backed named volume                  |
| `/srv/geo-saas/data/ctrip-runtime` |  UID/GID `1000` | `0700` | durable Bridge recovery state                       |
| browser profile tenant parents     |     deploy user | `0700` | lets the non-root launcher verify the profile leaf  |
| browser tenant leaves              | UID/GID `10001` | `0700` | Chromium profile, downloads, and artifacts          |

The production Compose overlay binds `postgres-data`, `evidence-data`, and `media-data` to the three
fixed `/srv/geo-saas/data` paths. Docker-managed anonymous storage is not the production source of
truth. Backups go only under `/srv/geo-saas/backups`; deployment and exported diagnostic logs go
under `/srv/geo-saas/logs`.

Bootstrap or repair the approved tenant leaves with:

```bash
sudo GEO_BOOTSTRAP_CTRIP_TENANT_ID=<tenant-uuid> \
  /srv/geo-saas/app/current/scripts/bootstrap-linux-server.sh
```

The bootstrap never asks for or stores a password. Sudo prompts interactively.
It installs `/etc/apparmor.d/geo-saas-browser-host` from the current release and loads it in enforce
mode. This policy retains Docker's default restrictions and grants only the user namespace creation
needed by Chromium's own sandbox on Ubuntu. The Browser Host also uses Playwright 1.61.1's pinned
`deploy/seccomp/geo-saas-browser-host.json`: it remains default-deny and adds only the
`clone`/`setns`/`unshare` calls plus the unprivileged `chroot` call required for that sandbox. The
post-userns `clone` rule allows only `CLONE_NEWPID` among restricted namespace flags. The policy
returns `ENOSYS` for `clone3` without allowing that syscall, forcing Chromium to use the
argument-filtered `clone` fallback. Browser health also requires a bounded `Page.getFrameTree` CDP
round trip, so a live browser process without a working renderer cannot pass readiness. A bounded
set of restored tabs is valid for a persistent profile; after an unclean exit, the launcher lets
Chromium restore those tabs without appending another publish URL. The Bridge still fails closed if
more than one actual publish target exists, preserving manual review for an ambiguous draft.
The release requires AppArmor ABI 5,
which the target server validates before installation. Do not substitute `apparmor=unconfined`,
`seccomp=unconfined`, `--no-sandbox`, `SYS_ADMIN`, privileged mode, or a disabled host
user-namespace restriction.

For an existing bootstrapped server, refresh only this policy after activating a reviewed release:

```bash
sudo /srv/geo-saas/app/current/scripts/install-browser-host-apparmor.sh
```

## Database-only commissioning

The first database and tenant must exist before a complete `geo.env` can be assembled. Do not solve
that dependency by inserting an example tenant UUID or fixture secret. The independent
`compose.production-db.yaml` topology contains only PostgreSQL, migration/role tools, tenant and
operator commissioning, credential-less Bridge identity commissioning, and the offline historical
publication binder. It has no API, worker, Agent MCP, Plastic Promise proxy, Pi provider, running
Ctrip Bridge, or Browser Host service and exposes no host port.

As the non-root deploy user, create `/srv/geo-saas/secrets/commissioning.env` directly on the server:

```bash
umask 077
commission_file=/srv/geo-saas/secrets/commissioning.env
if [[ -e "${commission_file}" ]]; then
  printf 'Refusing to replace existing %s\n' "${commission_file}" >&2
else
  install -m 0600 /dev/null "${commission_file}"
  "${EDITOR:-vi}" "${commission_file}"
fi
```

The file uses strict `KEY=value` lines with no leading whitespace. Initially put the exact
40-character release commit in both `GEO_IMAGE_TAG` and `GEO_IMAGE_REVISION`, plus only these
database keys in it:
`POSTGRES_DB`, `POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD`,
`GEO_API_DB_USER`, `GEO_API_DB_PASSWORD`, `GEO_WORKER_DB_USER`, `GEO_WORKER_DB_PASSWORD`,
`GEO_IDENTITY_DB_USER`, and `GEO_IDENTITY_DB_PASSWORD`. All four passwords must be independently
generated, unquoted, URL-safe 32-256 character values. Optional release/build metadata is limited to
`COMPOSE_PROJECT_NAME`, `GEO_IMAGE_PREFIX`, digest-pinned `NODE_IMAGE`, and an HTTPS `NPM_REGISTRY`.
The launcher rejects a missing, non-lowercase, or non-commit tag/revision before running any
container. Do not copy `.env.example` or `geo.env` into this file. The launcher rejects every
unrelated key, duplicate key, symlink, hard link, wrong owner, or mode other than `0600`.

Run the database chain from the active immutable release:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh database
```

For a restored database, audit `geo.service_principals` before applying migration `0044`: each tenant
must have at most one active `ctrip_bridge` profile. The migration deliberately fails instead of
choosing among multiple active identities. Disable the superseded identity only under a separately
approved, audited recovery procedure; never delete or silently adopt it.

This builds only the release-matched `db-tools` target on Linux and names it
`<GEO_IMAGE_PREFIX>-db-tools-commissioning:<release>`, separately from the production stack's
attested `db-tools` image. A later commissioning action therefore cannot retarget the image identity
bound to `config-preflight`, `db-migrate`, or the governance proxy services. It starts PostgreSQL
with the same bind-backed `postgres-data` named volume used by the full production topology, applies
migrations, and reconciles login roles and ACLs. It leaves PostgreSQL running but starts no application service.
Every later action rebuilds that release's DB tools before it runs. If this Compose project already
has one healthy PostgreSQL container, the launcher reuses it by container ID and never asks Compose
to reconcile or recreate it. Before creating, starting, or reusing PostgreSQL, it inspects the named
volume driver/options and the container mount and requires the exact bind-backed
`/srv/geo-saas/data/postgres` path. A same-named ordinary Docker volume, mismatched mount, ambiguous
container, or unhealthy container fails closed and is never recreated.

After a two-person review of the real tenant request, add the ten `GEO_PROVISION_*` values listed in
[Tenant and Operator Provisioning](ops/operator-provisioning.md) to the same file, then run:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh provision-tenant
```

No tenant UUID is accepted as an input. The transaction creates the UUID and emits it in a
credential-free JSON receipt. Preserve that exact result in the approved provisioning ticket. Use
its `tenantId` only after success to create the tenant-owned browser leaves:

```bash
sudo GEO_BOOTSTRAP_CTRIP_TENANT_ID=<emitted-tenant-id> \
  /srv/geo-saas/app/current/scripts/bootstrap-linux-server.sh
```

Finally add the four `GEO_BOOTSTRAP_*` values, with the exact provisioned tenant slug and an
independently generated owner password, then run the separate owner action:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh bootstrap-operator
```

Remove `GEO_BOOTSTRAP_PASSWORD` from the file immediately after recording the successful IDs. Keep
the commissioning env server-only for controlled replay/recovery; never pass its values through
shell exports, command arguments, chat, or the development workstation. The launcher fixes Docker to the server's local
Unix socket and sanitizes its inherited environment so shell variables cannot override this file.

Add `GEO_CTRIP_BRIDGE_TENANT_SLUG`, `GEO_CTRIP_BRIDGE_OPERATOR_EMAIL`,
`GEO_CTRIP_BRIDGE_IDEMPOTENCY_KEY`, and `GEO_CTRIP_BRIDGE_PRINCIPAL_NAME`, using the exact active
tenant and owner/admin identity. Then create the credential-less, fixed-capability Bridge principal:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh commission-ctrip-bridge
```

The command derives the tenant and sole active Ctrip account from PostgreSQL, generates the
principal UUID internally, and emits only the tenant, account, and principal IDs plus replay state.
It accepts no UUID, account selector, capability, token, or secret. Preserve the append-only receipt
and audit evidence. A later rotation requires disabling the old principal and a new approved name
and idempotency key; existing principals are never adopted or reactivated.

Before Phase A, recover and review the pre-existing Ctrip publication evidence as specified in
[Bind pre-existing publication history offline](CTRIP_PRODUCTION_RUNBOOK.md#bind-pre-existing-publication-history-offline).
Write the manifest only to the deploy-owned, regular, non-symlink, single-link mode-`0600` file
`/srv/geo-saas/secrets/historical-publication.json`. After owner bootstrap succeeds, bind it with:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh bind-historical-publication
```

The host path is fixed in the release. The launcher validates the mode-`0600` file and streams it to
the one-shot container over stdin; it is never bind-mounted, copied into an image, or placed in an
argument or environment variable. Operational messages go to stderr so the successful action's
stdout remains the exact credential-free JSON receipt. Preserve that receipt and keep Phase A
blocked unless the binding succeeds.

## Production Secret

The default env path is `/srv/geo-saas/secrets/geo.env`. It must be a regular, non-symlink
file owned by the deploy user with mode exactly `0600`; its parent must be owned by that user with
mode `0700`. The launcher refuses any other location, owner, or mode.

Populate it from `.env.example` on the server. At minimum, replace all placeholder secrets, set a
real Pi provider/model/key, configure the one Ctrip tenant, and configure the external Plastic
Promise MCP URL. Do not store a production Secret in Git, a release archive, a Docker image, a
support ticket, or a backup manifest.

When public DNS is intentionally deferred, set `GEO_OPERATOR_ORIGIN` to the exact
`http://127.0.0.1:${WEB_PORT}` origin used by the development workstation SSH Web tunnel. The production validator
rejects every non-loopback host, omitted port, path, wildcard, and port mismatch. This second origin
only makes the loopback-bound operator console usable; it does not replace public HTTPS acceptance
or expose the Web/API listeners beyond server loopback.

If the server network cannot connect directly to Wikimedia, set the optional
`GEO_MEDIA_HTTPS_PROXY_URL` to a company-approved bare HTTP(S) proxy URL. The API attaches that
proxy only to the fixed Wikimedia Commons search and download client; Pi, Plastic Promise, Ctrip,
database, and other application requests keep their existing direct transports. Proxy credentials
remain in `geo.env` and must not be printed in logs or copied into tickets.

Alternatively set `GEO_MEDIA_SEARCH_PROVIDER=pexels` and inject an official `PEXELS_API_KEY` into
the server Secret. Search requests then go only to `api.pexels.com`, image bytes only to
`images.pexels.com`, and the immutable media record retains the Pexels photo page, photographer,
license URL, source dimensions, normalized bytes and live Pi inspection. The API key is never sent
to the image CDN or exposed to the Web application. Do not rely on anonymously cached API responses;
an uncached Pexels search must authenticate successfully before production use.

Create `geo.env` only after database commissioning has emitted the real tenant and worker principal
IDs. Copy the exact database settings from the server-owned commissioning file, then add the
runtime-only values from approved secret sources. `commissioning.env` is not a reduced production
runtime config, and `geo.env` must never be passed to `commission-production-db.sh`. Keep
`COMPOSE_PROJECT_NAME`, `GEO_IMAGE_PREFIX`, `GEO_IMAGE_TAG`, and `GEO_IMAGE_REVISION` identical in
both files so the full launcher adopts the commissioned PostgreSQL container and bind path instead
of creating a second Compose project. Every one of the seven project images carries that revision
in `org.opencontainers.image.revision`. The production image tag must equal the same full commit so
another release cannot replace a validated tag between inspection and use. Both launchers require it
to match the deploy-owned,
mode-`0444` `.geo-release` marker written during immutable release transfer; any three-way mismatch
fails before a container runs. Docker commands also run with a cleared inherited environment and
the fixed local Unix socket, so shell variables cannot override the server env file or redirect a
production build to another daemon.

Create the Browser Host's separate x11vnc password interactively on the server after bootstrap:

```bash
/srv/geo-saas/app/current/scripts/create-browser-vnc-password.sh
```

The helper writes `/srv/geo-saas/secrets/ctrip-vnc.passwd` with mode `0604`; its parent remains
`0700`, and the value never enters the env file, a command argument, or an image. Production
startup refuses a missing, symlinked, wrongly owned, or differently permissioned file.

`NODE_IMAGE`, `NGINX_IMAGE`, `PLAYWRIGHT_IMAGE`, and `NPM_REGISTRY` are build-only inputs. Compose
passes them only to the Dockerfiles; they are not runtime service environment variables. The example
uses the digest-pinned ECR/MCR sources and npm mirror verified from the current Linux server because
its Docker Hub and npm.org routes are unreliable. Keep image digests pinned and retain the frozen
pnpm lockfile when changing a registry endpoint.

`CADDY_IMAGE` is a runtime infrastructure image, not a project build. Keep it pinned to the reviewed
multi-architecture digest in `.env.example`. The production launcher pulls that exact reference and
refuses a tag or a different registry. Set `GEO_PUBLIC_DOMAIN` to one lowercase ASCII FQDN and set
`APP_ORIGIN` to exactly `https://<that-domain>`; IP literals, wildcards, ports, paths and alternate
origins fail preflight. Caddy is the only public listener on TCP 80/443 and UDP 443. All application,
MCP, Bridge and noVNC host mappings remain loopback-only. Caddy can forward only the authenticated,
account-scoped `/ctrip-vnc/accounts/<account-id>/` HTTPS route over the private `browser-vnc`
network; it does not publish the noVNC host port.

Caddy's `/data` and `/config` mounts contain secret ACME and certificate state. The ordinary
production bundle intentionally excludes their host roots, and its strict manifest requires the
`excluded-reissue` recovery policy. Do not make a raw unencrypted copy. Replacement-host recovery
starts Caddy from verified empty state and is not complete until the external HTTPS verifier passes;
this accepts possible CA availability/rate-limit impact on RTO. Follow
[ops/backup-restore.md](ops/backup-restore.md) for quarantine, reissuance, and verification.

The safe initial state is:

```dotenv
CTRIP_BRIDGE_MODE=browser_draft
AUTOMATION_PRODUCER_ENABLED=false
CTRIP_BROWSER_TRANSPORT=linux_service
CTRIP_REVIEW_CDP_ENDPOINT=http://browser-host:10005
CTRIP_NOVNC_HOST_PORT=10007
GEO_CTRIP_BROWSER_LOGIN_BASE_URL=http://127.0.0.1:10007/vnc.html?autoconnect=true&resize=scale
GEO_CTRIP_RUNTIME_ROOT=/srv/geo-saas/data/ctrip-runtime
GEO_BROWSER_PROFILE_ROOT=/srv/geo-saas/browser-profiles
GEO_BROWSER_DOWNLOAD_ROOT=/srv/geo-saas/browser-downloads
GEO_BROWSER_ARTIFACT_ROOT=/srv/geo-saas/browser-artifacts
```

`browser_draft` can prepare the reviewed editor surface but advertises no submit capability.
Changing an env value is not Phase B/C approval and must not bypass the persistent acceptance gate.

## Governance dependency

Plastic Promise MCP is a mandatory external production dependency. Both API and Agent MCP perform a
startup handshake. An absent URL, bad TLS/authentication, failed handshake, malformed decision, or
runtime denial must keep the affected path closed. Do not replace it with `demo_fixture`, a local
stub, or an allow-by-default fallback.

On this Linux topology Plastic Promise remains a separately owned host service listening only on
`127.0.0.1:${PLASTIC_PROMISE_HOST_PORT:-9020}`. The production-only
`plastic-promise-host-proxy` uses host networking but exposes no TCP listener; it forwards the host
loopback service to a mode-`0600` Unix socket under `/srv/geo-saas/data/governance-proxy`. The
`plastic-promise-proxy` network stage mounts that socket read-only and is the only service assigned
`172.30.11.2:10002` on the internal GEO governance network. Neither stage exposes a host port,
terminates authentication, or changes Plastic Promise. API and Agent MCP use exactly
`http://172.30.11.2:10002/mcp`; the application handshake still validates the MCP service and fails
closed. Do not generalize this narrow endpoint into permission for other private-network HTTP URLs.

The Pi provider is also server-side. Production provenance must identify the real provider, model,
provider run, and terminal assistant request. Provider text and upstream errors must not be copied
into operator logs.

## Start sequence

Run as the non-root deploy user from the approved release:

```bash
/srv/geo-saas/app/current/scripts/start-production.sh
```

The launcher performs this fixed sequence:

1. Enforce Linux, non-root execution, Secret owner/mode, and persistent directory ownership.
2. Verify the installed Browser Host AppArmor policy matches the release exactly.
3. Render the merged Compose configuration without printing it.
4. Build `config-preflight`, prove the AppArmor profile is loaded with a networkless container, and
   run the fail-closed production validator.
5. Build the remaining images on Linux.
6. Pull the digest-pinned Caddy edge image, create the fixed internal backend network, verify the
   host-loopback Plastic Promise proxy, then run `docker compose up --detach --wait` and fail if
   health does not converge.
7. Write the bounded deployment output to `/srv/geo-saas/logs/start-<UTC>.log`.

The startup chain runs migrations and role/ACL reconciliation. It does not run `db-seed`, enable a
fixture provider, or grant Ctrip acceptance.

## Verify locally on the server

```bash
cd /srv/geo-saas/app/current
compose=(docker compose --env-file /srv/geo-saas/secrets/geo.env \
  -f compose.yaml -f compose.production.yaml --profile production)
"${compose[@]}" ps --all
curl --fail --silent --show-error http://127.0.0.1:10004/health/ready
curl --fail --silent --show-error http://127.0.0.1:10001/health/live
curl --fail --silent --show-error http://127.0.0.1:10006/health/live
curl --fail --silent --show-error http://127.0.0.1:10003/healthz
```

All application host ports remain bound to `127.0.0.1`; the production Caddy edge is the only
listener on public ports 80/443 and obtains the certificate for `GEO_PUBLIC_DOMAIN`. A healthy Bridge
in `browser_draft` proves only that draft preparation is available.
It does not prove Ctrip login, governance approval, a submit, or public readback.
The API and Agent MCP do not join `browser-control`; only Ctrip Bridge can reach Browser Host CDP.
API reaches Bridge at the fixed `http://ctrip-bridge:9030` address on the separate internal
`bridge-api` network, protected by the tenant bearer contract.

After DNS points only to the production IPv4 and the cloud security group allows TCP 80/443 (plus
UDP 443 when HTTP/3 is desired), run the external verifier from the operator workstation:

```bash
/path/to/release/scripts/verify-production-https.sh geo.example.com 203.0.113.10
```

It verifies exact A/AAAA state, the canonical HTTP redirect, rejection of an unknown Host, trusted
TLS for the requested hostname, readiness, security headers, and at least seven days of certificate
validity. Internal container health is not a substitute for this external check.

Export logs for an approved incident window without exposing the env file:

```bash
umask 077
"${compose[@]}" logs --no-color --since 30m \
  >"/srv/geo-saas/logs/incident-$(date -u +%Y%m%dT%H%M%SZ).log"
```

Review the export for tokens, cookies, provider text, and customer data before sending it anywhere.

## noVNC and tenant profiles

noVNC binds only to server loopback port `10007`. Server operators can reach it through SSH
forwarding from the development workstation. Authenticated tenant operators can use the public console's account-scoped
same-origin route; Caddy calls the API to verify the session, `tenant:manage` capability, active
account ownership, and runtime binding before forwarding over `browser-vnc`. Enter the password
created by the helper when noVNC requests it. Never publish port `10007` directly and never expose
Chromium CDP outside the internal Docker network.

The browser profile marker binds a directory to its tenant UUID. A mismatch, symlink, missing mount,
or unwritable mount fails browser startup. To operate another tenant, create that tenant's numeric
UID-owned leaves and deploy a separately reviewed single-tenant Bridge/browser instance. Do not
place multiple tenant credentials in one production browser instance.

## Stop and recover

Use the tenant Kill Switch and acceptance gate before stopping submission-capable components. For a
maintenance stop:

```bash
"${compose[@]}" stop edge ctrip-bridge agent-mcp worker api web browser-host plastic-promise-proxy plastic-promise-host-proxy
```

A consumed submit permit or ambiguous post-click state is not retryable. Preserve the database,
runtime state, profile, artifacts, and logs, then follow the recovery decision in the Ctrip runbook.
For data recovery, use [ops/backup-restore.md](ops/backup-restore.md); never run `db-seed` after a
restore.

For an application-only rollback, first confirm that no permit is consumed or uncertain and obtain a
reviewer-approved backward-compatibility decision for the live database, migration ledger, queued
jobs, receipts, and runtime state. Identical migration filenames and bytes are a required safety
condition, but they do not replace that application/data compatibility approval. Activate the Kill
Switch, set draft mode and Producer off, then select the full 40-character commit of a retained
reviewed release. Run the rollback helper from the currently active release as the non-root deploy
user:

```bash
target_release=<approved-previous-40-character-commit>
/srv/geo-saas/app/current/scripts/rollback-production-release.sh "${target_release}"
```

The helper uses the fixed local Docker socket only for a pre-mutation daemon check and holds an
exclusive server lock shared with the launcher and database commissioning. It validates the current
and target immutable release trees, markers, owners, modes, and migration files, plus exactly one
canonical `GEO_IMAGE_TAG` and `GEO_IMAGE_REVISION` in both `geo.env` and (when present)
`commissioning.env`. It refuses an application-only rollback unless the migration filename set and
every migration byte are identical between the two releases. A migration mismatch requires the
consistent restore procedure below.

Only after every check passes does the helper write a durable two-release journal, atomically rewrite
the release values in both env files, and replace the `current` symlink. A caught filesystem failure
attempts to restore the recorded source pointers; an interruption that cannot run cleanup leaves the
journal for forward recovery. The launcher and commissioning helper refuse to run while that journal
or its stage remains, so an unresolved transaction fails closed. The helper deliberately does not
build images, start containers, or call the target launcher. After it succeeds, start the selected
release as a separate, observable step:

```bash
/srv/geo-saas/app/current/scripts/start-production.sh
```

Launcher failure does not silently switch the release pointers back. Preserve its deployment log and
container state for diagnosis, then make a separate reviewed rollback or restore decision.

Do not use an application rollback to reverse data migrations. Use the consistent restore runbook
when schema/data recovery is required, and preserve the failed release and logs for diagnosis.
