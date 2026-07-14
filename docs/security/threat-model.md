# Threat Model

Status: MVP snapshot, 2026-07-14. Review whenever a live connector, provider adapter, administrative API, new industry pack or public ingress is added.

## Assets and trust boundaries

Protected assets include tenant identity and memberships, partner contact facts, evidence content, session/CSRF/MCP tokens, platform/provider credentials, immutable variants, audit artifacts, one-time publication grants, outbox jobs, receipts and visibility observations.

Primary boundaries are:

1. browser/TLS ingress -> Nginx -> API;
2. MCP bearer client -> agent-MCP static tool surface -> API session;
3. API/worker login roles -> PostgreSQL NOLOGIN roles and forced RLS;
4. worker -> connector -> external platform;
5. fixture/manual/provider evidence -> scoring and circuit decisions;
6. API -> external Plastic Promise MCP governance endpoint;
7. admin/migration/bootstrap/backup plane -> application plane.

Pi Agent v0.73.1 has no built-in MCP. The Compose topology packages the GEO MCP server and the API's narrow Plastic Promise client, but not a long-running Pi process or Plastic Promise server. Adding a Pi service creates another tool/destination/secrets boundary and requires a separate review.

## Threats, controls and residual risk

| Threat                                             | Existing control                                                                                                                          | Residual risk / required gate                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant read/write                            | tenant IDs on owned tables; transaction context; forced RLS; resource-scope checks                                                        | Real PostgreSQL isolation test is mandatory. API readiness does not exercise `SET ROLE` or RLS.                                                                                   |
| Identity discovery leaks tenant data               | `geo_identity_login` has no BYPASSRLS/table SELECT and inherits only security-definer email/user-ID identity lookup functions             | Both functions return a password hash and memberships for one identity. Isolate/monitor the login, restrict its credential to API use and review every function change.           |
| Worker acts as wrong tenant/actor                  | outbox carries tenant ID; worker sets tenant context                                                                                      | One configured `WORKER_ACTOR_ID` is reused across tenant work and is not a per-tenant service-principal mapping. Do not enable live multi-tenant delivery until fixed and tested. |
| Prompt/tool injection                              | strict seven-tool MCP allowlist, Zod schemas, capability and resource checks; deterministic audit/grant outside model                     | Any future dynamic MCP discovery or general shell/filesystem tool is out of scope and requires redesign.                                                                          |
| MCP bearer/session theft                           | constant-time token comparison, Host/Origin allowlists, HTTPS requirement except loopback, secret redaction paths                         | `MCP_PRINCIPALS_JSON` contains an API password and bearer token in environment state. Use orchestrator secrets and dedicated least privilege principals.                          |
| Governance endpoint unavailable or compromised     | API requires Plastic Promise startup handshake; publication calls use only `audit_pre_check` and `defense`; error/denial is fail closed   | API ready does not re-probe a broken post-start connection. Authorization header is an environment secret; endpoint identity/TLS and availability need monitoring.                |
| CSRF/session replay                                | signed JWT session cookie, HttpOnly, Secure, SameSite=Strict; separate CSRF cookie/header; server-side session row                        | Compose itself has no TLS. Direct HTTP login fails by design. No MFA or account lockout/rate limiter exists.                                                                      |
| Initial owner bootstrap abused                     | explicit profile, admin URL, Argon2id, no default password, bounded inputs                                                                | Command always grants owner, reactivates existing email and currently writes no audit row. Require two-person ticket evidence and use only for initial/recovery bootstrap.        |
| Grant reuse or payload mutation                    | audit binds exact tenant/platform/account/payload hash; short-lived single-use grant consumed transactionally                             | Admin DB access can bypass application invariants. Restrict admin to maintenance and audit its use.                                                                               |
| Audit retry mints duplicate grants                 | required tenant/actor/variant request hash; transaction advisory lock; one idempotency record; HMAC-derived token with hash-only storage  | `SESSION_SECRET` rotation prevents reconstruction of still-live pre-rotation tokens. Coordinate rotation with grant expiry/revocation and retain the audit trail.                 |
| Mass or wrong-platform publication                 | authenticated/CSRF-protected tenant Kill Switch API, audit log, automation mode, circuit breaker, account capability and execution checks | The API changes only the tenant flag: it does not revoke grants, cancel an in-flight connector call or enforce campaign/topic scopes. Use infrastructure stop and reconcile.      |
| Duplicate/uncertain external write                 | idempotency keys, immutable attempt/receipt records, reconciliation state                                                                 | No live connector/reconciliation implementation exists. A future API must prove platform idempotency or readback before unattended use.                                           |
| Preview/manual evidence represented as live        | typed evidence values and receipt `confirmed=false`; dry-run connector performs no network write                                          | UI/reporting must preserve labels. Screenshot/manual import alone is never publication confirmation.                                                                              |
| Fixture response represented as Doubao/Qwen search | fixture/manual adapter methods stored separately                                                                                          | No official API/browser adapter exists. Google ranking is not a proxy. Provider mode and search mode must remain visible.                                                         |
| False platform capability                          | default capability is `manual_only`; unattended requires public/partner API evidence                                                      | Toutiao/Sohu/Ctrip API evidence is currently unverified. Keys or UI labels cannot upgrade capability.                                                                             |
| Credential leakage in image/log/backup             | `.dockerignore`, redaction code, no secrets in image build, encrypted backup requirement                                                  | Compose `.env` and container inspect still expose environment secrets. Move to secret files/provider before production.                                                           |
| Dependency/image tampering                         | frozen lockfile, exact pnpm and base image digests, production-only deploy output                                                         | No SBOM, signature, provenance or vulnerability policy is shipped. CI must supply them.                                                                                           |
| Service reports healthy while unusable             | separate probes and documented semantics                                                                                                  | API ready is only two `SELECT 1`s; MCP is live only; worker probe does not prove queue progress. Add business smoke tests and telemetry.                                          |
| Seed changes operational state                     | seed is isolated in explicit `fixture-seed` profile                                                                                       | Re-running fixture seed clears the Zhongtong fixture Kill Switch. Never seed during restart/restore/resume.                                                                       |
| Backup disclosure or inconsistent restore          | custom logical dump, checksum, encrypted off-host storage, restore runbook                                                                | No PITR/WAL archive, automated retention or evidence-volume writer/backup exists.                                                                                                 |
| Denial of service                                  | request body limits and bounded worker settings                                                                                           | No Fastify rate-limit plugin, distributed limiter or queue SLO monitor. Enforce edge limits; Redis is not currently a real dependency.                                            |
| XSS/content injection                              | React escaping, CSP, no-store/API security headers                                                                                        | CSP permits Unsplash images and inline style attributes used by charts (not inline scripts). Self-host images and remove `unsafe-inline` styles before customer deployment.       |

## Release blockers for live publication

Unattended external writes remain blocked until all of the following are independently verified:

- platform capability evidence passes [platform-onboarding.md](../api/platform-onboarding.md);
- a connector contract covers publish, timeout ambiguity, status/readback, idempotency and credential revocation;
- operator provisioning, secret management, TLS, rate limiting and audit export are operational;
- worker identity is tenant-correct and Kill Switch scope tests pass on real PostgreSQL;
- backup restore and incident stop/resume are rehearsed;
- fixture/manual/API evidence is visible and cannot be coerced into another type;
- an approved low quota canary demonstrates exact hash, receipt and readback reconciliation.

## Security verification evidence

Retain Git commit/image digest, Compose rendered config with secrets redacted, migration output, role ACL queries, two-tenant denial results, TLS/cookie/CSRF results, MCP denied-tool tests, dry-run receipt, Kill Switch test, backup restore report, platform onboarding decision and reviewer identity. A passing unit test without its environment and artifact is not commercial audit evidence.
