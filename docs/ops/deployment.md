# Production Deployment

## Deployment contract

`compose.yaml` is a single-host MVP topology. It builds four independently runnable targets (`api`, `worker`, `agent-mcp`, `web`) and one `db-tools` target from the root `Dockerfile`. Package installation uses `pnpm install --frozen-lockfile`; runtime packages are produced from that store by pinned, offline `pnpm deploy --prod --legacy` commands.

Image inputs are pinned to manifest-list digests:

| Image                       | Digest                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `node:24.4.0-bookworm-slim` | `sha256:1b044a60874f1b57ac8c4e708ddb3a00e55b34586ebbacce09a48796dafcc799` |
| `nginx:1.29.0-alpine`       | `sha256:d67ea0d64d518b1bb04acde3b00f722ac3e9764b3209a9b0a98924ba35e4b779` |
| `postgres:16.9-bookworm`    | `sha256:253815cf7579ffa05e1673d92e78d37273e61be0e4414e9a1449337d7925be94` |

Changing an image requires a reviewed digest update, rebuild, vulnerability scan and smoke test. The current packaging does not yet emit an SBOM or signed provenance; those remain release gates outside this MVP.

## Startup sequence

```text
Plastic Promise MCP (external HTTPS, handshake succeeds) -> api
postgres (healthy) -> db-migrate (completed) -> db-bootstrap (ACL verified)
db-bootstrap -> api / worker -> agent-mcp / web
```

`db-seed` is an explicit `fixture-seed` profile, not part of production restart. On a brand-new demonstration database only, run `docker compose --profile fixture-seed run --rm db-seed` after `db-bootstrap` succeeds. Re-running it changes fixture automation controls, including clearing the Zhongtong fixture Kill Switch; never include it in a production restart or restore procedure.

`db-bootstrap` creates or rotates three application login roles only after migrations create the `geo_runtime` and `geo_dispatcher` NOLOGIN roles:

| Login role           | Effective privilege                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geo_api`            | May `SET LOCAL ROLE geo_runtime`; tenant transactions remain under forced RLS                                                                                                              |
| `geo_worker`         | May switch to `geo_dispatcher` for outbox claims and `geo_runtime` for tenant work                                                                                                         |
| `geo_identity_login` | May inherit NOLOGIN `geo_identity`; among `geo` application functions, execute only `geo.find_login_identity(text)` and `geo.find_login_identity_by_user(uuid)`; no table SELECT/BYPASSRLS |
| `geo_admin`          | Migration/seed/bootstrap/backup only; never an application URL                                                                                                                             |

The API receives `DATABASE_IDENTITY_URL`, never the admin URL. Migration `0007_identity_reader` owns both security-definer lookup contracts: email lookup establishes a login and user-ID lookup refreshes memberships for tenant listing/switching. Bootstrap only creates/rotates their LOGIN member. Alert on every non-API connection and rotate it separately.

## Preflight

1. Generate independent random values for all `replace-*` entries. Compose assembles PostgreSQL URLs, so its database passwords must use URL-unreserved characters (`A-Z a-z 0-9 - . _ ~`). Production orchestrators should inject complete URLs/secrets instead of relying on a checked-out `.env` file.
2. Set `PLASTIC_PROMISE_MCP_URL` to a governance endpoint reachable from the API container. Non-loopback endpoints must be HTTPS. If it requires authentication, inject the complete Authorization header through `PLASTIC_PROMISE_MCP_AUTHORIZATION`; it has no default.
3. Set `APP_ORIGIN` and `MCP_ALLOWED_ORIGINS` to the exact external HTTPS origin. Set `MCP_ALLOWED_HOSTS` to the Host headers accepted at the GEO MCP edge.
4. Provision a dedicated worker actor. Run the explicit owner bootstrap only after the tenant exists; the seed actor/user is fixture data, not a production identity. Least-privilege MCP service-user provisioning remains a gap.
5. Keep `DOUBAO_ADAPTER=fixture` and `QWEN_ADAPTER=fixture`. Provider keys do not create an implementation that the code does not contain.
6. Validate and build:

```powershell
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps --all
docker compose logs db-migrate db-bootstrap
```

Both mandatory one-shot database services must exit with code `0`. Do not use `docker compose up` success alone as migration evidence. A separately requested fixture seed must also exit `0`, but it is not a production readiness requirement.

API startup is also a governance dependency check: it connects to Plastic Promise before binding port `4100`. An unreachable endpoint, TLS/authentication error or MCP handshake failure leaves the API down and Compose restarts it. Inspect API logs and confirm the external service is healthy before treating API restart loops as an application defect.

## TLS and ingress

The API sets session and CSRF cookies with `Secure` when `NODE_ENV=production`. The included Nginx container serves HTTP on port `8080` and proxies `/api/` to the API; it is designed to sit behind a TLS terminator. Bind addresses default to loopback. A production ingress must:

- terminate TLS with a valid certificate;
- forward only the web origin and the explicitly selected MCP endpoint;
- preserve the exact allowed Host/Origin values for MCP;
- apply request/body limits and rate limits at the edge;
- block direct public access to PostgreSQL, API and worker networks.

The API currently uses `trustProxy: false`. Do not infer client IP security policy from forwarded headers. Direct `http://localhost:4173` can serve static assets but cannot complete a production cookie login.

`agent-mcp` shares the API network namespace and calls `http://127.0.0.1:4100`. This is a deliberate Compose-only accommodation for the API client rule that permits cleartext HTTP only on loopback. External MCP traffic still requires TLS at the edge.

## Health semantics

| Service    | Probe                                            | What it proves                                                                                     | What it does not prove                                                                                                                            |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `pg_isready`                                     | Server accepts connections                                                                         | migrations, RLS, login-role ACLs                                                                                                                  |
| API        | `/health/live`                                   | Fastify process responds                                                                           | database or business readiness                                                                                                                    |
| API        | `/health/ready`                                  | startup Plastic Promise handshake already succeeded; runtime and identity pools can run `SELECT 1` | current Plastic Promise connection health after startup, migration version, `SET ROLE`, identity function execution, tenant query, operator login |
| Worker     | container probe performs `SELECT 1` on both URLs | both DB credentials connect                                                                        | polling progress, queue age, platform delivery                                                                                                    |
| agent-MCP  | `/health/live`                                   | HTTP MCP process responds                                                                          | API login, principal validity, tool execution; no ready endpoint exists                                                                           |
| web        | `/healthz`                                       | Nginx serves static HTTP                                                                           | API session or UI data correctness                                                                                                                |

A release smoke test must add authenticated tenant reads, a dry-run publication receipt, and a fixture/manual visibility distinction. Health endpoints are not evidence of those behaviors.

## Seed and operator readiness

`db-seed` is idempotent fixture/bootstrap data. It sets both tenants to `shadow`, creates dry-run channel accounts, and creates disabled users with non-login password values. Service containers may be healthy while every login fails. Follow [operator-provisioning.md](operator-provisioning.md) and run the explicit `operator-bootstrap` profile; never change the seed to include a shared default password.

## Optional infrastructure

Redis and MinIO are intentionally absent. `REDIS_URL` is only an optional parsed configuration field and no current code reads/writes Redis; MinIO has no configuration contract at all. Add either only with a real caller, failure-mode tests, backup ownership and a separate optional Compose profile.

## Upgrade and rollback

1. Run backup and restore rehearsal before schema changes.
2. Build immutable image tags in CI; never deploy the mutable `local` tag to production.
3. Run `db-migrate` as the admin role, then `db-bootstrap`; never migrate through an app login.
4. Start API/worker/MCP/web and execute the release smoke test.
5. Roll application images back only when migrations are backward compatible. SQL migrations have no down path; database rollback is restore-based.

Current local verification limitation: Docker/Compose was unavailable on the Windows development host. YAML parsing, Git Bash syntax, source/build commands and deploy artifact inspection can run locally, but real image startup, native container `argon2`, PostgreSQL ACLs, external Plastic Promise handshake and health behavior remain unverified until CI or a Docker host runs them.
