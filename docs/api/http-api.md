# HTTP API

Source of truth: `apps/api/src/app.ts` and its Zod schemas. This snapshot does not ship a generated OpenAPI document; the inventory below is descriptive and must not be treated as a machine-validated client contract.

## Transport and authentication

- API container port: `4100`.
- Liveness: `GET /health/live`; readiness: `GET /health/ready`.
- `POST /api/auth/login` accepts email, password and optional tenant slug.
- Successful login sets `geo_session` (HttpOnly) and `geo_csrf` cookies. Production cookies are Secure and SameSite=Strict.
- State-changing authenticated routes require `x-csrf-token` matching the CSRF cookie/session hash.
- Responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- Errors use `{ "error": { "code", "message", "requestId", "details"? } }`.
- API startup requires a successful connection to `PLASTIC_PROMISE_MCP_URL`. Non-loopback governance endpoints must use HTTPS; an optional complete Authorization header is supplied separately.

The API is tenant-scoped after login. `DATABASE_IDENTITY_URL` uses `geo_identity_login`, which has no table privileges and, among `geo` application functions, may execute only the security-definer `geo.find_login_identity(text)` and `geo.find_login_identity_by_user(uuid)` functions. The first resolves login credentials and memberships by email; the second refreshes memberships for an already authenticated user before tenant listing/switching. Normal repository calls switch to `geo_runtime` inside a transaction and set tenant/actor/request context. `DATABASE_ADMIN_URL` is never accepted as the API identity connection.

## Route inventory

| Method/path                                   | Required capability              | Purpose                                                                                          |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /api/auth/login`                        | public                           | Establish one tenant session                                                                     |
| `POST /api/auth/logout`                       | session + CSRF                   | Revoke server session and clear cookies                                                          |
| `GET /api/auth/session`                       | session                          | Return current actor/tenant context                                                              |
| `GET /api/auth/tenants`                       | session                          | List current user's memberships, marking inactive tenants/memberships unavailable                |
| `POST /api/auth/switch-tenant`                | session + CSRF                   | Accept `{ tenantSlug }`, revoke the old session and issue a new tenant-scoped session            |
| `GET /api/tenant`                             | `tenant:read`                    | Tenant summary                                                                                   |
| `GET /api/automation`                         | `tenant:read`                    | Read tenant automation control and tenant/platform/account circuit status                        |
| `POST /api/automation/kill-switch`            | `automation:manage` + CSRF       | Accept `{ enabled, reason }`, update the tenant switch and append `geo.audit_log`                |
| `GET /api/contacts`                           | `tenant:read`                    | Current tenant contacts                                                                          |
| `GET /api/channel-accounts`                   | `tenant:read`                    | Platform accounts and declared capabilities                                                      |
| `GET/POST /api/evidence-sources`              | `content:read` / `content:write` | Evidence registry                                                                                |
| `GET/POST /api/facts`                         | `content:read` / `content:write` | Tenant/brand claims bound to evidence                                                            |
| `GET /api/capabilities`                       | `tenant:read`                    | Current role capabilities and connector reports                                                  |
| `POST /api/resource-scope-check`              | session + CSRF                   | MCP-oriented tenant resource authorization                                                       |
| `GET/POST /api/campaigns`                     | `content:read` / `content:write` | Campaign collection and creation                                                                 |
| `GET/POST /api/content`                       | `content:read` / `content:write` | Content items and initial version                                                                |
| `POST /api/content/:contentId/versions`       | `content:write`                  | Create immutable content version                                                                 |
| `GET /api/content-versions/:contentVersionId` | `content:read`                   | Read one version                                                                                 |
| `GET/POST /api/content/:contentId/variants`   | `content:read` / `content:write` | List/create exact account variant                                                                |
| `POST /api/variants/:variantId/audits`        | `audit:run`                      | Require `{ idempotencyKey }`; run deterministic audit and maybe return one-time authorization    |
| `GET /api/audits/:artifactId`                 | `audit:read`                     | Read immutable audit artifact                                                                    |
| `POST /api/publication-requests`              | `publish:request`                | Require Plastic Promise `audit_pre_check` + `defense`, then atomically consume grant and enqueue |
| `GET /api/publication-jobs`                   | `content:read`                   | Tenant publication jobs                                                                          |
| `GET /api/receipts`                           | `receipt:read`                   | Immutable publication receipts                                                                   |
| `POST /api/visibility-runs`                   | `visibility:run`                 | Run fixture Doubao/Qwen samples only                                                             |
| `POST /api/visibility-runs/import`            | `visibility:run`                 | Import explicitly manual observations                                                            |
| `GET /api/visibility/summary`                 | `visibility:read`                | Stored provider/method metrics                                                                   |

All authenticated POST routes above require CSRF. Kill Switch `reason` is trimmed and must contain 3-500 characters. Its response is `{ control }`; independently confirm the stored state through `GET /api/automation`, which returns `{ control, circuits }`. Request shapes are strict enough to bound IDs, lengths, providers and execution levels, but a client should consume the code-generated schema only after an OpenAPI generation/compatibility step is implemented.

Audit idempotency is scoped to tenant, actor and variant. The first accepted request returns `201` with `wasCreated: true`; an identical replay returns `200` with the original artifact and `wasCreated: false`; reusing the key for another actor or variant returns `409`. The PostgreSQL transaction takes an advisory lock before writing the audit artifact, grant and `idempotency_records` row, so concurrent retries cannot mint multiple grants. Publication tokens are deterministically derived with a domain-separated HMAC and only their SHA-256 hashes are stored. A replay reconstructs the token and verifies the stored hash before returning it; consumed, revoked or expired grants are not exposed again. Rotating `SESSION_SECRET` therefore invalidates active sessions and prevents token reconstruction for any still-live pre-rotation audit grant; coordinate rotation with grant expiry or revocation.

## Important absences

- No operator/member provisioning endpoint; a privileged one-shot owner bootstrap CLI exists.
- No HTTP endpoint to change automation mode/quota, administer circuit breakers or set campaign/topic Kill Switch rows; the available write controls only the tenant-level boolean switch.
- No publication cancellation or grant revocation HTTP route despite capability names existing in the authorization package.
- No live Doubao/Qwen provider route; `/api/visibility-runs` is fixture by implementation.
- No Toutiao/Sohu/Ctrip public/partner API connector.
- No OpenAPI JSON endpoint, version negotiation or public API stability promise.

These are product gaps, not hidden endpoints. Administrative changes currently require controlled database procedures and audit evidence.
