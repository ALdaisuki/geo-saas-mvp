# Development Workstation to Linux Host Handoff

## Hard boundary

The development workstation is an operator terminal only. Do not install Docker Desktop, run a Docker daemon,
build an image, or run `docker compose` on the development workstation. Every image build and container action
must happen after connecting to the Linux host through the `geo-production-host` SSH alias.

Use the repository's lockfile for workstation-side source checks (`corepack enable`, then
`pnpm install --frozen-lockfile`). Unit tests, lint, typecheck, and non-container builds may run on
the development workstation. Keep work on the approved feature branch, do not deploy a dirty tree, do not rewrite shared
history, and do not push directly to the protected production branch. The server receives one
reviewed immutable commit, never an arbitrary working-directory snapshot.

Never put an SSH, sudo, database, model-provider, Ctrip, or Plastic Promise credential in a
command, repository file, chat, archive, or shell history. Enter interactive passwords only at
the terminal prompt. If a password has been disclosed, rotate it with:

```bash
ssh -t -o ClearAllForwardings=yes geo-production-host passwd
```

## Confirm the remote boundary

These are remote, read-only checks. Their `docker` commands execute on `geo-production-host`, not the development workstation.

```bash
ssh -o ClearAllForwardings=yes geo-production-host 'uname -s; uname -m; docker --version; docker compose version'
```

Expected results are Linux, the approved CPU architecture, Docker Engine, and Compose v2. Do
not continue if the SSH alias resolves to an unexpected host.

## Bootstrap once

The bootstrap loads the release-pinned Browser Host AppArmor policy as well as creating directories,
so a copied standalone script is deliberately rejected. On an already bootstrapped server, first use
the immutable release transfer below and run the script from `current`.

On a brand-new server `/srv/geo-saas/app` does not exist yet. Build a clean Git archive on the development workstation,
upload it to a new deploy-owned staging directory under the remote user's home, and run the complete
staged release through interactive sudo:

```bash
test -z "$(git status --porcelain)"
bootstrap_release="$(git rev-parse --verify HEAD)"
bootstrap_archive="$(mktemp -t "geo-saas-bootstrap-${bootstrap_release}.XXXXXX.tar.gz")"
git archive --format=tar.gz --output="${bootstrap_archive}" "${bootstrap_release}"
ssh -o ClearAllForwardings=yes geo-production-host \
  'set -Eeuo pipefail; umask 077; test ! -e "$HOME/geo-saas-bootstrap"; install -d -m 0700 "$HOME/geo-saas-bootstrap"'
scp -o ClearAllForwardings=yes "${bootstrap_archive}" geo-production-host:geo-saas-bootstrap/release.tar.gz
ssh -o ClearAllForwardings=yes geo-production-host \
  'set -Eeuo pipefail; tar -xzf "$HOME/geo-saas-bootstrap/release.tar.gz" -C "$HOME/geo-saas-bootstrap"'
ssh -t -o ClearAllForwardings=yes geo-production-host \
  'sudo "$HOME/geo-saas-bootstrap/scripts/bootstrap-linux-server.sh"'
rm -f -- "${bootstrap_archive}"
```

After that succeeds, use the immutable release transfer below, verify `current`, and remove only the
reviewed bootstrap staging directory. Do not reuse it as a release or build context. On either path,
run bootstrap without inventing a tenant UUID. The initial run creates only server-wide directories
and policy. After DB-only commissioning creates the real tenant, rerun it with that emitted UUID to
create the tenant-owned browser leaves.

```bash
ssh -t -o ClearAllForwardings=yes geo-production-host \
  'sudo /srv/geo-saas/app/current/scripts/bootstrap-linux-server.sh'
```

Reconnect after bootstrap so the deploy user's Docker group membership is active. Membership in
the Docker group is root-equivalent access and must be limited to approved deploy operators.
On an already bootstrapped server, install or refresh only the release-matched Browser Host policy
with `sudo /srv/geo-saas/app/current/scripts/install-browser-host-apparmor.sh`. Never disable the
Chromium sandbox, the Ubuntu user-namespace restriction, AppArmor, or Docker seccomp as a workaround.
The checked-in Playwright-derived seccomp policy stays default-deny and permits only the namespace
and unprivileged `chroot` syscalls needed by Chromium; do not replace it with `seccomp=unconfined`.

## Transfer an immutable release

Deploy only a reviewed, clean commit. Untracked or modified local files are deliberately excluded.
The repository helper performs the archive, upload, permission normalization, immutable release
activation, and optional production start without transferring secrets:

```bash
scripts/transfer-production-release.sh geo-production-host
# Add --start only when this reviewed release should be built and started immediately.
scripts/transfer-production-release.sh --start geo-production-host
```

The helper refuses a dirty worktree and an existing release directory. The expanded commands below
remain the auditable manual recovery path.

```bash
test -z "$(git status --porcelain)"
release="$(git rev-parse --verify HEAD)"
archive="$(mktemp -t "geo-saas-${release}.XXXXXX.tar.gz")"
git archive --format=tar.gz --output="${archive}" "${release}"
scp -o ClearAllForwardings=yes "${archive}" "geo-production-host:/srv/geo-saas/app/geo-saas-${release}.tar.gz"
ssh -o ClearAllForwardings=yes geo-production-host "set -Eeuo pipefail; umask 022; \
  release_dir=/srv/geo-saas/app/releases/${release}; \
  test ! -e \"\${release_dir}\"; \
  install -d -m 0750 \"\${release_dir}\"; \
  tar -xzf /srv/geo-saas/app/geo-saas-${release}.tar.gz -C \"\${release_dir}\"; \
  find \"\${release_dir}\" -xdev -type d -perm /022 -exec chmod go-w -- {} +; \
  find \"\${release_dir}\" -xdev -type f -perm /022 -exec chmod go-w -- {} +; \
  test -z \"\$(find \"\${release_dir}\" -xdev -perm /022 -print -quit)\"; \
  printf '%s\\n' '${release}' >\"\${release_dir}/.geo-release\"; \
  chmod 0444 \"\${release_dir}/.geo-release\"; \
  if test -L /srv/geo-saas/app/current; then \
    \"\${release_dir}/scripts/rollback-production-release.sh\" --forward '${release}'; \
  else \
    test ! -e /srv/geo-saas/app/current; \
    ln -s releases/${release} /srv/geo-saas/app/current; \
  fi"
rm -f -- "${archive}"
```

The release archive contains source, not images. The Linux server builds every image later. The
explicit permission pass is required because archive extraction can otherwise inherit a permissive
server umask and leave Compose files, migrations, launchers, or security policies group-writable;
the rollback validator rejects such a release. Keep the previous release directory until database
compatibility and rollback requirements are closed.

Activation stages a unique symlink beside current and replaces current with a same-filesystem rename.
This avoids exposing a missing or partly changed current path while commands or service managers
resolve the active release.

On an established server, `--forward` reads `geo.kysely_migration` from the single running Postgres
container whose Compose project and service labels match production. The database ledger must be an
exact ordered prefix of the current release. Every applied migration in that prefix must remain
byte-for-byte identical; same-named files after the applied prefix may be repaired because the
database proves they have never run, and the target may append later ordered migrations. Missing or
multiple matching Postgres containers, an unreadable or malformed ledger, a non-prefix ledger, or a
changed applied migration all fail closed before any pointer or env change. It uses the same
deployment lock, durable journal, staged env files, and atomic pointer replacement as rollback. Run
the target release's helper, as shown above, so this compatibility check is available before
`current` changes. The helper does not migrate, build, or start services; run the target launcher
separately.

## Prune old production artifacts

Run pruning only from the active release on `geo-production-host`. Preview is mandatory and does not change
the host:

```bash
ssh -o ClearAllForwardings=yes geo-production-host \
  '/srv/geo-saas/app/current/scripts/prune-production-artifacts.sh preview'
```

The default policy keeps the active release, the five newest additional release trees, every
release mounted by any container, and every release younger than seven days. Project image cleanup
is narrower: it considers only the seven `geo-saas-*:<40-character-release-sha>` repositories,
keeps the current and two newest rollback revisions, and protects image IDs referenced by running
or stopped containers. BuildKit removes only cache records unused for 24 hours while reserving
8 GB, capping retained cache at 12 GB, and targeting at least 20 GB free disk space. Volumes,
containers, networks, database data, Pi sandbox images, proxy images, and non-GEO repositories are
never pruning targets.

Apply exactly the reviewed preview by confirming the current release. The script holds the backup
maintenance and deployment locks and verifies production convergence before and after mutation:

```bash
current="$(ssh -o ClearAllForwardings=yes geo-production-host \
  'basename "$(readlink -f /srv/geo-saas/app/current)"')"
ssh -o ClearAllForwardings=yes geo-production-host \
  "/srv/geo-saas/app/current/scripts/prune-production-artifacts.sh apply --confirm-current ${current}"
```

The retention values can be temporarily increased through `GEO_RELEASE_KEEP_RECENT`,
`GEO_RELEASE_MIN_AGE_DAYS`, `GEO_IMAGE_KEEP_RECENT`, `GEO_CACHE_MIN_AGE_HOURS`,
`GEO_CACHE_RESERVED_SPACE`, `GEO_CACHE_MAX_USED_SPACE`, and `GEO_CACHE_MIN_FREE_SPACE`. Lowering a
retention value requires a separately reviewed preview.

## Commission the production database

Before creating the complete runtime `geo.env`, create the server-only mode-`0600`
`/srv/geo-saas/secrets/commissioning.env`. Start with both `GEO_IMAGE_TAG` and
`GEO_IMAGE_REVISION` set to the exact 40-character release commit, independently generated database
credentials, and only optional
image/build metadata; do not copy `.env.example`, add a tenant UUID, or add Plastic Promise, Pi,
Ctrip, session, MCP, API, worker mapping, or browser values.

Run the five actions separately over SSH:

```bash
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/commission-production-db.sh database'
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/commission-production-db.sh provision-tenant'
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/commission-production-db.sh bootstrap-operator'
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/commission-production-db.sh commission-ctrip-bridge'
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/commission-production-db.sh bind-historical-publication'
```

Before each later command, edit the same server file only for that action: add the reviewed tenant
fields before provisioning, the owner fields before bootstrap, and the four Bridge identity fields
before Bridge commissioning. Remove `GEO_BOOTSTRAP_PASSWORD` immediately after bootstrap. Before
the final action, create the fixed mode-`0600`
`/srv/geo-saas/secrets/historical-publication.json` from reviewed offline evidence. Never place any
of those values or manifest content in the SSH command. Preserve the tenant JSON result, then create
its browser leaves using only its emitted `tenantId`:

```bash
ssh -t -o ClearAllForwardings=yes geo-production-host \
  'sudo GEO_BOOTSTRAP_CTRIP_TENANT_ID=<emitted-tenant-id> /srv/geo-saas/app/current/scripts/bootstrap-linux-server.sh'
```

This path starts PostgreSQL only. It does not start or contact API, worker, Agent MCP, Plastic
Promise, Pi, Ctrip Bridge, or Browser Host. Full details and the exact variable sets are in
[SERVER_DEPLOYMENT.md](SERVER_DEPLOYMENT.md#database-only-commissioning).

## Create server-only configuration

Do not transfer a populated env file from the development workstation. Only after commissioning emits the real tenant
and worker IDs, create the separate runtime file on `geo-production-host` from the release template, replace
every placeholder using the approved secret source, and preserve mode `0600`:

```bash
ssh -t -o ClearAllForwardings=yes geo-production-host
umask 077
cp /srv/geo-saas/app/current/.env.example /srv/geo-saas/secrets/geo.env
chmod 0600 /srv/geo-saas/secrets/geo.env
${EDITOR:-vi} /srv/geo-saas/secrets/geo.env
```

The initial values must include:

- the release-approved `CADDY_IMAGE`, one lowercase `GEO_PUBLIC_DOMAIN`, and the exact matching
  `APP_ORIGIN=https://<domain>` after its DNS A record points only to the production server
- `CTRIP_BRIDGE_MODE=browser_draft`
- `AUTOMATION_PRODUCER_ENABLED=false`
- `GEO_CTRIP_RUNTIME_ROOT=/srv/geo-saas/data/ctrip-runtime`
- create `/srv/geo-saas/secrets/ctrip-vnc.passwd` with the interactive helper before startup
- the same approved tenant UUID in the browser, gateway, and Bridge documents
- a real server-side Pi provider and model, never `fixture`
- `PLASTIC_PROMISE_HOST_PORT=9020` (or its approved host-loopback port) and the fixed GEO-side URL
  `http://172.30.11.2:10002/mcp`

Do not start when Plastic Promise, provider credentials, tenant principals, or acceptance evidence
are missing. Startup intentionally fails closed.

## Build and start on Linux

The launcher rejects macOS and root execution, validates the Secret owner/mode and persistent
directory ownership, verifies the host AppArmor policy byte-for-byte against the release, tests the
loaded policy with an isolated container, builds `config-preflight` first, runs it, builds the
remaining images, and waits for health:

```bash
ssh -o ClearAllForwardings=yes geo-production-host '/srv/geo-saas/app/current/scripts/start-production.sh'
```

The launcher validates both Browser Host policies with an isolated, read-only, networkless
container before Compose startup. The deployment log is written under `/srv/geo-saas/logs`. Do not
treat a successful image build as acceptance for a live Ctrip submission; production starts in
draft-only Phase A.

## Open the headed browser safely

The server binds raw noVNC only on its loopback address. From the development workstation, create an SSH tunnel:

```bash
scripts/open-production-browser-tunnel.sh geo-production-host
```

Then open `http://127.0.0.1:10007/vnc.html?autoconnect=1&resize=scale` locally. Close the tunnel
after login or review. Public tenant operators use the console's authenticated, account-scoped
same-origin HTTPS route instead; this does not expose the raw host port. Never expose port `10007`
on a public interface and never forward the CDP
port; the CDP endpoint belongs only to the Docker `browser-control` network. The helper uses an
isolated SSH control connection so config-defined forwards are cleared without also clearing the
required noVNC forward. Do not replace it with `ClearAllForwardings=yes` and `-L` in one SSH command:
OpenSSH discards the command-line forward in that combination.

Continue with [CTRIP_PRODUCTION_RUNBOOK.md](CTRIP_PRODUCTION_RUNBOOK.md). Phase A does not authorize
a submit. Phase B requires a separately recorded approval for one new canary, and Phase C requires
matching public readback from that same canary.
