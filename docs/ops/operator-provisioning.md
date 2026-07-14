# Operator Provisioning

## Security default

`db:seed` deliberately writes disabled fixture users with `password_hash='seed-disabled'`. Seed completion is not login readiness and no shared default password exists.

The repository provides one explicit bootstrap command for the initial tenant owner:

```text
pnpm db:bootstrap:operator
```

It requires exactly these environment values:

| Variable                     | Contract                                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| `DATABASE_ADMIN_URL`         | PostgreSQL admin URL; the read-only identity URL is insufficient |
| `GEO_BOOTSTRAP_TENANT_SLUG`  | Existing active tenant slug                                      |
| `GEO_BOOTSTRAP_EMAIL`        | Valid email, normalized to lowercase                             |
| `GEO_BOOTSTRAP_DISPLAY_NAME` | Non-empty display name, at most 200 characters                   |
| `GEO_BOOTSTRAP_PASSWORD`     | 16-1024 characters, supplied from a secret manager               |

The CLI hashes the password with Argon2id (`memoryCost=19456`, `timeCost=2`, `parallelism=1`), creates or updates the global user, and creates or updates an active `owner` membership with the owner's full capability set. It prints tenant/user/membership IDs but not the password/hash.

## Compose procedure

`db-bootstrap-operator` is an explicit `operator-bootstrap` profile. `DATABASE_ADMIN_URL` is assembled from the database admin secret. The four `GEO_BOOTSTRAP_*` values are pass-through variables; `GEO_BOOTSTRAP_PASSWORD` has intentionally no Compose or `.env.example` default.

1. Complete migrations/login-role bootstrap and create the target tenant. The optional fixture tenant exists only after the explicit `fixture-seed` command.
2. Set slug, email and display name from the approved ticket. Inject the password into the process environment from the secret manager without putting its value on the command line.
3. Run:

```powershell
docker compose --profile operator-bootstrap run --rm db-bootstrap-operator
```

4. Remove the password environment value immediately. Capture the JSON IDs, command exit code, image digest, operator and reviewer in the provisioning ticket.
5. Test login only through the external HTTPS origin. Verify Secure/HttpOnly/SameSite cookies, CSRF denial on a missing token, an allowed tenant read and a cross-tenant denial.

For direct development use, export all five variables and run `pnpm db:bootstrap:operator`. The applications do not load `.env` automatically.

## High-privilege and idempotency warning

This command always provisions `owner`; it is not a general member-management CLI. Re-running it for an existing email changes that user's password/display name, reactivates the user and grants/refreshes an owner membership in the selected tenant. Use it only for controlled initial bootstrap or explicit recovery with two-person approval.

The current implementation does not append a `geo.audit_log` row itself. Until that is added, the provisioning ticket, database connection audit and emitted IDs are mandatory compensating evidence. Normal editor/auditor/publisher/viewer provisioning and least-privilege service-principal creation remain product gaps.

`MCP_PRINCIPALS_JSON` contains both a bearer token and an API login. Do not silently reuse an owner as a permanent machine principal. Commissioning may use the initial owner only under explicit approval; production MCP needs a dedicated least-privilege user once member provisioning supports it.

## Disable and rotate

For compromise or offboarding:

1. Set the user and memberships to `disabled`/`suspended` in one audited admin transaction.
2. Revoke all active `geo.sessions` rows for that user.
3. Remove/rotate the MCP bearer token and API password; restart `agent-mcp` so in-memory sessions and pending grants are discarded.
4. Review publication grants, jobs, receipts, governance decisions and audit logs for the exposure window.
5. Do not delete identity rows; retain referential and commercial audit history.
