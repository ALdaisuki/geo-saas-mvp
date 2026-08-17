# Production Deployment

Host health recovery, encrypted offsite backup scheduling, and alert installation are documented in
[unattended-operations.md](unattended-operations.md). They are commissioned only after the first
external HTTPS acceptance succeeds.

## Authoritative path

The supported production topology is a headless Linux server. Docker image builds, Compose
validation, migrations, services, headed Chromium, and noVNC all run on that server. The development workstation is an
operator terminal only and must not install Docker Desktop, run a Docker daemon, build images, or run
Compose.

Use these runbooks for the current procedure:

- [Linux server deployment](../SERVER_DEPLOYMENT.md) defines server layout, ownership, startup,
  health checks, browser access, and rollback.
- [workstation-to-server handoff](../WORKSTATION_SERVER_HANDOFF.md) defines the SSH boundary and immutable release
  transfer.
- [Ctrip production acceptance](../CTRIP_PRODUCTION_RUNBOOK.md) defines Phase A/B/C controls.
- [Backup and restore](backup-restore.md) defines the consistent recovery set.
- [Operator provisioning](operator-provisioning.md) defines tenant and operator bootstrap.

The PowerShell launchers, `compose.customer-demo.yaml`, and the `customer-demo` profile are legacy
local demonstration paths. They are not Linux production instructions and their fixture, Windows
path, Edge, portproxy, or host-supervisor settings must not be copied into the server Secret.

## Release and Secret contract

Production uses `compose.yaml` plus `compose.production.yaml` with the `production` profile. Deploy
one reviewed immutable release under `/srv/geo-saas/app/releases/<commit>` and point
`/srv/geo-saas/app/current` at it. Do not deploy a dirty working tree as a production release.
Set both `GEO_IMAGE_TAG` and `GEO_IMAGE_REVISION` in the server env file to that exact lowercase
40-character commit. The launchers bind them to the mode-`0444` `.geo-release` marker, reject any
other value, and verify the OCI revision label before running workloads. The commit-valued tag also
prevents another release build from swapping a validated image reference. They clear inherited
variables and use only the local Docker Unix socket plus the explicit server env file.

The only supported Secret path is `/srv/geo-saas/secrets/geo.env`. It must be a regular non-symlink
file owned by the non-root deploy user with mode `0600`; its parent must have mode `0700`. Populate it
from `.env.example` on the server and replace every placeholder. Standard production requires:

- one lowercase `GEO_PUBLIC_DOMAIN`, the exact matching `APP_ORIGIN=https://<domain>`, and the
  release-approved digest-pinned `CADDY_IMAGE`;
- `GEO_DEPLOYMENT_PROFILE=standard` and `GEO_GOVERNANCE_MODE=external`;
- a real Pi provider, model, and server-side key, never the fixture runner;
- the fixed Plastic Promise endpoint `http://172.30.11.2:10002/mcp`, forwarded through the private
  Unix-socket bridge only to the host loopback service
  loopback service;
- `GEO_CONTEXT_RETRIEVAL_ENABLED=false` whenever the tenant memory backend is intentionally paused;
  this removes `plastic_context_supply` from the Pi tool set and also rejects direct retrieval before
  transport, while retaining the required MCP handshake, `audit_pre_check`, and `defense` publication
  governance calls. Pi content work then uses only GEO tenant context, templates, Brand Agent Profiles,
  and verified facts;
- exactly one matching tenant in `CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON`,
  `CTRIP_BRIDGE_TENANTS_JSON`, and `CTRIP_BROWSER_TENANT_ID`;
- `GEO_CTRIP_RUNTIME_ROOT=/srv/geo-saas/data/ctrip-runtime` so runtime state and backups cannot
  diverge;
- the documented `/srv/geo-saas` browser profile, download, and artifact roots;
- `AUTOMATION_PRODUCER_ENABLED=false` through Phase A and Phase B.

Production preflight rejects placeholders, fixture Pi, mismatched Ctrip tenant/token documents,
non-Linux browser transport, an unexpected CDP endpoint, and an alternate Ctrip runtime path.
The retrieval switch is not a governance bypass. Real Pi content workflows may run while it is
`false`, but they receive no Plastic Promise memory context. Phase A and later still require the
healthy external governance transport plus all normal audit, defense, evidence, account, and release
gates. Re-enable retrieval only after the memory backend is ready and the operator explicitly approves
tenant-scoped retrieval.

## Ctrip mode contract

`browser_draft` is the safe baseline for browser login, persistence, and reviewed-surface checks. It
has no submit capability, but it is not the adapter identity for the acceptance canary. Keep
`CTRIP_ASSISTED_ACCOUNTS_JSON=[]` while performing only these baseline checks.

Before creating the actual Phase A canary and its durable handoff, select `browser_supervised` and
configure the reviewed assisted-account mapping with
`adapterVersion=ctrip-community-browser-supervised-v1`. Phase A remains non-submitting because the
persistent database gate refuses permit issuance, permit consumption, and submit regardless of the
adapter capability. The same supervised adapter identity must remain bound to that canary for the
separately approved Phase B click and public readback.

`browser_unattended` is not a Phase A or Phase B shortcut. Select it only after the account's Phase C
proof and rollout decision are durable. Enabling `AUTOMATION_PRODUCER_ENABLED=true` is a separate
Phase C decision.

## Build and start

Run the production launcher only on Linux, as the non-root deploy user:

```bash
/srv/geo-saas/app/current/scripts/start-production.sh
```

The launcher validates the Secret and persistent directory ownership, renders Compose without
printing secrets, builds and runs `config-preflight`, builds all remaining images on Linux, then
starts the complete topology and waits for health. It never installs or builds Docker on the development workstation.
Immediately before invalidating the prior convergence attestation, it starts a 60-minute global
deployment deadline. Every later Docker/Compose invocation is bounded by the remaining time and a
30-minute per-command maximum, so a stalled daemon, registry, or image build cannot hold the
deployment lock indefinitely. `GEO_DEPLOYMENT_TIMEOUT_SECONDS` may be set to an explicitly reviewed
value from 600 through 7200 seconds for unusually slow server builds.

Full startup contacts Plastic Promise from both API and Agent MCP. If that dependency or another
production backend is intentionally unavailable, do not use the launcher merely to build images. A
server-only build without service startup may use the same validated Compose definition:

```bash
cd /srv/geo-saas/app/current
compose=(docker compose --env-file /srv/geo-saas/secrets/geo.env \
  -f compose.yaml -f compose.production.yaml --profile production)
"${compose[@]}" config --quiet
"${compose[@]}" build config-preflight
"${compose[@]}" run --rm --no-deps config-preflight
"${compose[@]}" build
```

These commands build images but do not run `docker compose up`. They still require a complete,
syntactically valid production Secret. Do not substitute a fixture governance mode or fixture Pi to
make preflight pass.

## Startup and health semantics

The production dependency order is:

```text
config-preflight -> postgres -> db-migrate -> db-bootstrap
Plastic Promise host loopback -> production proxy -> api -> agent-mcp / web
db-bootstrap -> api / worker
browser-host --browser-control--> ctrip-bridge --bridge-api--> api
web / api -> Caddy edge -> public 80/443
```

`db-seed` is never part of production startup or restore. API startup performs the Plastic Promise
handshake before binding its port; Agent MCP performs an independent handshake. Missing or invalid
governance, provider, database, tenant, browser, or Bridge configuration fails closed.

All host-facing application ports bind to loopback. The digest-pinned Caddy edge is the only public
listener and routes the same-origin Web/API surface for `GEO_PUBLIC_DOMAIN`; it never exposes MCP,
Bridge, the raw noVNC port, or Chromium CDP. Authenticated operators may reach account-scoped noVNC
through `/ctrip-vnc/accounts/<account-id>/`; Caddy authorizes the session and tenant account through
the API before forwarding on a dedicated internal network. The SSH tunnel remains available for
server operators, and Chromium CDP remains on the browser-control network.

Health probes prove process or dependency readiness only. They do not prove tenant login, current
governance health after startup, Ctrip authentication, acceptance phase, submit success, or public
readback. Complete the authenticated read-only smoke checks in the Linux server runbook before any
Phase A work.

## Recovery and rollout

Back up PostgreSQL, evidence, media, and the fixed Ctrip runtime directory as one recovery set. Never
run `db-seed` after restore. Keep the Kill Switch active, Producer disabled, and the Bridge in a
non-submitting state until restore verification is complete.

Application rollback is allowed only when migrations are backward-compatible and no permit is
consumed or submit outcome is uncertain. Database rollback is restore-based; SQL migrations have no
down path. Follow the linked server and backup runbooks instead of improvising Compose commands.
