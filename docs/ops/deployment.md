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
config-preflight (production placeholders rejected) -> postgres
Plastic Promise MCP (external HTTPS, handshake succeeds) -> api / agent-mcp
postgres (healthy) -> db-migrate (completed) -> db-bootstrap (roles + ACLs verified)
db-bootstrap -> api / worker; api healthy -> agent-mcp / web
```

`db-seed` is an explicit `fixture-seed` profile, not part of production restart. On a brand-new demonstration database only, run `docker compose --profile fixture-seed run --rm db-seed` after `db-bootstrap` succeeds. Re-running it changes fixture automation controls, including clearing the Zhongtong fixture Kill Switch; never include it in a production restart or restore procedure.

`db-bootstrap` first runs the idempotent `ensure-application-roles.sql` and `reconcile-application-acls.sql`, then creates or rotates three application login roles. This is deliberately independent from Kysely migration history so a `--no-acl` restore cannot silently skip historical grants:

| Login role           | Effective privilege                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geo_api`            | May `SET LOCAL ROLE geo_runtime`; tenant transactions remain under forced RLS                                                                                                              |
| `geo_worker`         | May switch to `geo_dispatcher` for outbox claims and `geo_runtime` for tenant work                                                                                                         |
| `geo_identity_login` | May inherit NOLOGIN `geo_identity`; among `geo` application functions, execute only `geo.find_login_identity(text)` and `geo.find_login_identity_by_user(uuid)`; no table SELECT/BYPASSRLS |
| `geo_admin`          | Migration/seed/bootstrap/backup only; never an application URL                                                                                                                             |

The API receives `DATABASE_IDENTITY_URL`, never the admin URL. Migration `0007_identity_reader` owns both security-definer lookup contracts: email lookup establishes a login and user-ID lookup refreshes memberships for tenant listing/switching. Bootstrap only creates/rotates their LOGIN member. Alert on every non-API connection and rotate it separately.

## Preflight

1. Generate independent random values for all `replace-*` entries. Compose assembles PostgreSQL URLs, so its database passwords must use URL-unreserved characters (`A-Z a-z 0-9 - . _ ~`). Production orchestrators should inject complete URLs/secrets instead of relying on a checked-out `.env` file. `config-preflight` rejects any required or optional production secret that still contains the checked-in `replace-` marker; `docker compose config --quiet` alone checks interpolation/YAML, not this semantic gate.
2. Set `PLASTIC_PROMISE_MCP_URL` to a governance endpoint reachable from the API container. Non-loopback endpoints must be HTTPS. If it requires authentication, inject the complete Authorization header through `PLASTIC_PROMISE_MCP_AUTHORIZATION`; it has no default.
3. Set `APP_ORIGIN` and `MCP_ALLOWED_ORIGINS` to the exact external HTTPS origin. Set `MCP_ALLOWED_HOSTS` to the Host headers accepted at the GEO MCP edge.
4. Provision a separate least-privilege worker service principal for every tenant, then set `WORKER_TENANT_ACTORS_JSON` to a JSON object whose keys are tenant UUIDs and values are active, same-tenant service-principal UUIDs. Do not use operator or disabled seed-user IDs. The fixture values in `.env.example` are demonstration-only.
5. Keep `CTRIP_ASSISTED_ACCOUNTS_JSON=[]` by default. A Ctrip handoff mapping requires written browser-assistance authorization, a reviewed active database account with `capability=browser_assisted`, `assisted` in its supported execution levels and `last_verified_at` within 24 hours, plus an active same-tenant `ctrip_bridge` service principal. Each JSON entry is `{ tenantId, channelAccountId, bridgePrincipalId, adapterVersion, evidenceExpiresAt, handoffTtlSeconds }`; tenant/account pairs must be unique and the TTL must be 60-7200 seconds. The mapping contains no cookie, token, browser profile or login material. Enabling it lets the Worker create only an internal durable handoff bound to that bridge identity; it does not connect a browser or publish to Ctrip. Missing mappings leave assisted events retryable so configuration repair cannot be mistaken for terminal content failure.

   The optional `ctrip-simulator` profile is a separate validation surface, not a production publisher. Leave `CTRIP_BRIDGE_GATEWAY_URL`, `CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON` and `CTRIP_BRIDGE_TENANTS_JSON` unset during normal startup. For an explicitly reviewed local simulation, set the gateway URL to `http://127.0.0.1:9030`, give both JSON documents the same unique tenant token, bind the bridge document to the same active `ctrip_bridge` principal used by the handoff mapping, and start with `docker compose --profile ctrip-simulator up -d --build`. The profile mounts the API `media-data` volume read-only. Prepare fails closed unless every audited media reference resolves to the exact inspected bytes; after a draft is durably prepared, submit and readback do not reload the media volume. The simulator binds only inside the API network namespace, has no Ctrip transport, and can produce only simulation evidence ending in `needs_review`. Never treat its receipt, readback or health endpoint as platform evidence.

6. Select the agent runner deliberately. Keep `AGENT_PROVIDER=fixture` and `AGENT_MODEL=fixture-geo-writer-v1` for the deterministic default. Real Pi mode accepts a provider/model from Pi's registry with `AGENT_API_KEY` injected from a secret manager. For a reviewed custom endpoint, set `AGENT_PROVIDER=openai-compatible`, its endpoint model ID in `AGENT_MODEL`, and its OpenAI Responses base URL in `AGENT_BASE_URL`; the key is still secret-only. Custom non-loopback endpoints must use HTTPS, and URLs containing credentials, a query string, or a fragment are rejected. `AGENT_BASE_URL` is rejected for every other provider so a registry provider cannot be silently redirected. An unknown registered provider/model, incomplete custom tuple, or missing key prevents `agent-mcp` startup. Keep `AGENT_RUN_TIMEOUT_MS=120000` unless a reviewed provider SLO justifies another value between 1,000 and 900,000 ms. Real Pi changes model orchestration only and does not upgrade any publishing or visibility adapter. Set `AGENT_GATEWAY_CREDENTIALS_JSON` to a unique `{ tenantId, accessToken }` entry for every tenant allowed to use the Web runner; each token must match that tenant's dedicated entry in `MCP_PRINCIPALS_JSON`. The API receives only the tenant UUID/token mapping, not the Agent principal's email or password.
7. Set `AUTOMATION_PRODUCER_ENABLED` explicitly. The checked-in example uses `true` for the governed Dry-run MVP; use `false` during restore or incident handling. Give each automation tenant a dedicated `MCP_PRINCIPALS_JSON` login with `automation:execute`, keep `AUTOMATION_PRODUCER_ID` stable across restarts, and start at concurrency `1`. Raising concurrency never changes the server-fixed `dry_run` level or bypasses an audit/Kill Switch gate.
8. Keep `DOUBAO_ADAPTER=fixture` and `QWEN_ADAPTER=fixture`. Provider keys do not create an implementation that the code does not contain.
9. Validate and build:

```powershell
docker compose config --quiet
docker compose build --pull
docker compose run --rm config-preflight
docker compose up -d
docker compose ps --all
docker compose logs db-migrate db-bootstrap
```

The production configuration preflight and both mandatory one-shot database services must exit with code `0`. Do not use `docker compose up` success alone as secret, migration or ACL evidence. A separately requested fixture seed must also exit `0`, but it is not a production readiness requirement.

The worker has no global actor fallback. It validates that each mapped actor is active and authorized for the event tenant before tenant work begins. A missing tenant key, disabled principal, cross-tenant principal, or missing Ctrip adapter mapping leaves the outbox event retryable and does not dead-letter it, even after `WORKER_MAX_ATTEMPTS`; alert on repeated `WORKER_ACTOR_NOT_CONFIGURED`, `WORKER_ACTOR_NOT_AUTHORIZED`, or `CTRIP_ASSISTED_ACCOUNT_NOT_CONFIGURED` errors and repair the mapping, principal or evidence. This behavior prevents configuration drift from being mistaken for a terminal publication failure, but it also means an invalid mapping can accumulate queue age until an operator fixes it.

API startup is also a governance dependency check: it connects to Plastic Promise before binding port `4100`. An unreachable endpoint, TLS/authentication error or MCP handshake failure leaves the API down and Compose restarts it. Inspect API logs and confirm the external service is healthy before treating API restart loops as an application defect.

`agent-mcp` independently connects to the same governance endpoint before binding port `9021`. Its process contains the GEO MCP HTTP server, restricted agent runner, and an optional background automation Producer. The API's browser gateway discovers sanitized capability through loopback, selects the current tenant's bearer, and never returns that secret to Web code. The default `FixturePiAgentRunService` accepts the fixed `draft_to_publication` workflow; `RealPiAgentRunService` accepts a prompt only after the configured provider/model/key pass startup validation. Plastic Promise drafting context is forced into a strict project derived from the authenticated tenant. Provider failures return a sanitized `502`; the configured run deadline returns `504`, aborts Pi, and retains the per-actor lock until the underlying run settles.

When `AUTOMATION_PRODUCER_ENABLED=true`, the same process round-robins only configured principals with `automation:execute`, claims one tenant-scoped run per available slot, renews its database lease, persists every draft/target transition, and polls only the publication job bound to that target. Restart loses no durable checkpoint: an expired planning/target lease or an `awaiting_delivery` run can be reclaimed, while stable draft/audit/publication idempotency keys prevent replay from creating a second logical action. Shutdown aborts active executions and reconciles their persisted state. This is autonomous Dry-run orchestration, not external unattended publication; every target still passes deterministic audit and the API hard-rejects non-Dry-run execution.

## TLS and ingress

The API sets session and CSRF cookies with `Secure` when `NODE_ENV=production`. The included Nginx container serves HTTP on port `8080` and proxies `/api/` to the API; it is designed to sit behind a TLS terminator. Bind addresses default to loopback. A production ingress must:

- terminate TLS with a valid certificate;
- keep port `9021` private for ordinary Web use; expose `/mcp` or the lower-level `/agent/runs` only to explicitly approved non-browser clients;
- preserve the exact allowed Host/Origin values for MCP;
- apply request/body limits and rate limits at the edge;
- block direct public access to PostgreSQL, API and worker networks.

The API currently uses `trustProxy: false`. Do not infer client IP security policy from forwarded headers. Direct `http://localhost:4173` can serve static assets but cannot complete a production cookie login.

`agent-mcp` shares the API network namespace: it calls the API at `http://127.0.0.1:4100`, while the API's browser gateway calls it at `http://127.0.0.1:9021`. These are deliberate Compose-only loopback accommodations. External `/mcp` or lower-level `/agent/runs` traffic still requires TLS at the edge. Both Agent POST paths enforce bearer authentication, exact Host/Origin policy, an explicit body length, a 1 MiB body ceiling, and no transfer encoding. The Agent path also permits only one active request per tenant/actor pair; this in-process conflict check does not replace edge rate limiting.

## Health semantics

| Service    | Probe                                            | What it proves                                                                                          | What it does not prove                                                                                                                                                       |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `pg_isready`                                     | Server accepts connections                                                                              | migrations, RLS, login-role ACLs                                                                                                                                             |
| API        | `/health/live`                                   | Fastify process responds                                                                                | database or business readiness                                                                                                                                               |
| API        | `/health/ready`                                  | startup Plastic Promise handshake already succeeded; runtime and identity pools can run `SELECT 1`      | current Plastic Promise connection health after startup, migration version, `SET ROLE`, identity function execution, tenant query, operator login                            |
| Worker     | container probe performs `SELECT 1` on both URLs | both DB credentials connect                                                                             | polling progress, queue age, platform delivery                                                                                                                               |
| agent-MCP  | `/health/live`                                   | HTTP process, selected runner, Producer enable/running state, active-run count and sanitized last error | API login for every configured tenant, key validity at the model provider, current Plastic Promise health, queue age, or successful tool execution; no ready endpoint exists |
| web        | `/healthz`                                       | Nginx serves static HTTP                                                                                | API session or UI data correctness                                                                                                                                           |

A release smoke test must add authenticated tenant reads, a dry-run publication receipt, and a fixture/manual visibility distinction. Health endpoints are not evidence of those behaviors.

## Tenant and operator readiness

`db-seed` is fixture data, not a production tenant creation mechanism. It sets both fixture tenants to `shadow`, creates dry-run channel accounts, and creates disabled users with non-login password values. Service containers may be healthy while every login fails. For production, follow [operator-provisioning.md](operator-provisioning.md): run the explicit `tenant-provisioning` profile first, add its worker mapping fragment to `WORKER_TENANT_ACTORS_JSON`, then run the separate `operator-bootstrap` profile. Never change the seed to include a shared default password.

## Optional infrastructure

Redis and MinIO are intentionally absent. `REDIS_URL` is only an optional parsed configuration field and no current code reads/writes Redis; MinIO has no configuration contract at all. Add either only with a real caller, failure-mode tests, backup ownership and a separate optional Compose profile.

## Upgrade and rollback

1. Run backup and restore rehearsal before schema changes.
2. Build immutable image tags in CI; never deploy the mutable `local` tag to production.
3. Run `db-migrate` as the admin role, then `db-bootstrap`; the latter always reconciles NOLOGIN roles and object ACLs before rotating login roles. Never migrate through an app login.
4. Start API/worker/MCP/web with `AUTOMATION_PRODUCER_ENABLED=false` and execute the release smoke test; then enable the Producer and run one governed Dry-run canary before normal batch intake.
5. Roll application images back only when migrations are backward compatible. SQL migrations have no down path; database rollback is restore-based.

Current local verification limitation: Docker/Compose was unavailable on the Windows development host. The embedded PostgreSQL integration suite executes the role bootstrap before migrations and destructively removes/reconciles application ACLs afterward, but real image startup, the container login-role shell, native container `argon2`, external Plastic Promise handshake and health behavior remain unverified until CI or a Docker host runs them.
