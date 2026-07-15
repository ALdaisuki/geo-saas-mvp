# Tenant and Operator Provisioning

## Security default

`db:seed` deliberately writes disabled fixture users with `password_hash='seed-disabled'`. Seed completion is not login readiness and no shared default password exists.

Production commissioning is deliberately split into two admin-only commands:

```text
pnpm db:provision:tenant
pnpm db:bootstrap:operator
```

The first command creates the tenant baseline. The second binds an owner to that already-created tenant. Neither API nor an existing tenant owner can create another tenant.

## Step 1: provision the tenant baseline

`db:provision:tenant` requires these explicit values:

| Variable                             | Contract                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| `DATABASE_ADMIN_URL`                 | PostgreSQL admin URL; never pass it to API, worker or MCP     |
| `GEO_PROVISION_IDEMPOTENCY_KEY`      | Approved ticket/request key; 8-200 safe identifier characters |
| `GEO_PROVISION_TENANT_SLUG`          | New immutable tenant identity slug                            |
| `GEO_PROVISION_LEGAL_NAME`           | Legal customer name                                           |
| `GEO_PROVISION_DISPLAY_NAME`         | Tenant display name                                           |
| `GEO_PROVISION_INDUSTRY`             | Industry key; no travel-specific value is implied             |
| `GEO_PROVISION_DEFAULT_LOCALE`       | Locale such as `zh-CN`                                        |
| `GEO_PROVISION_BRAND_CANONICAL_NAME` | Canonical name for the initial primary brand                  |
| `GEO_PROVISION_BRAND_DISPLAY_NAME`   | Display name for the initial primary brand                    |
| `GEO_PROVISION_CONTACTS_JSON`        | JSON array with 0-100 explicit contacts; use `[]` for none    |
| `GEO_PROVISION_WORKER_NAME`          | Name of the new active same-tenant `worker` service principal |

Each contact must contain exactly `type`, `label`, `value`, `normalizedValue` and boolean `isPrimary`. The caller supplies `normalizedValue`; the provisioning tool does not guess industry or regional normalization rules.

```json
[
  {
    "type": "phone",
    "label": "Service hotline",
    "value": "4001234567",
    "normalizedValue": "4001234567",
    "isPrimary": true
  }
]
```

In one transaction the command creates an active industry-neutral tenant, one primary brand, the contacts, a tenant `shadow` control with conservative database-enforced quotas, three active `manual_only` accounts supporting only `dry_run`, one active worker service principal, one active `baseline-v1` policy bundle, one active provider-neutral Doubao/Qwen baseline query set with version 1, and one active `geo.brand-agent-profile.v1` version for the primary brand. It creates no platform credential, operator, live connector capability, live provider call, or cross-tenant resource. The baseline pack and Profile are immutable and industry-neutral; later policy/query/Profile changes remain separate tenant-governed workflows.

The append-only admin receipt binds the idempotency key to the canonical request hash and all result IDs, including `policyBundleId`, `querySetId`, `querySetVersionId`, `brandAgentProfileId`, and `brandAgentProfileHash`. Exact same-key replays verify the complete tenant, brand, contacts, accounts, worker, automation control, policy document/hash, query prompts/hash, and exact Profile document/hash before returning the original IDs with `wasCreated=false`. A changed request with the same key, a different key for an existing slug, or drift in any provisioned baseline is rejected; this command never updates or adopts an existing tenant.

Run the explicit Compose profile after migrations and role bootstrap succeed:

```powershell
docker compose --profile tenant-provisioning run --rm db-provision-tenant
```

The single JSON result contains the fixed `event` discriminator, `tenantId`, `brandId`, `workerServicePrincipalId`, `policyBundleId`, `querySetId`, `querySetVersionId`, `brandAgentProfileId`, `brandAgentProfileHash`, `wasCreated`, and a `workerTenantActorsJsonFragment`. It contains no database URL, credential or secret. Merge the fragment into the deployment's complete `WORKER_TENANT_ACTORS_JSON` object before starting the worker; do not replace mappings for existing tenants.

For direct development, export `DATABASE_ADMIN_URL` plus all ten `GEO_PROVISION_*` variables and run `pnpm db:provision:tenant`. The applications do not load `.env` automatically.

## Step 2: bind the initial owner

After Step 1 succeeds, configure the existing owner bootstrap command:

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

1. Confirm the tenant-provisioning result from Step 1 and set `GEO_BOOTSTRAP_TENANT_SLUG` to that exact existing active slug.
2. Set email and display name from the approved ticket. Inject the password into the process environment from the secret manager without putting its value on the command line.
3. Run the owner-only profile:

```powershell
docker compose --profile operator-bootstrap run --rm db-bootstrap-operator
```

4. Remove the password environment value immediately. Capture both commands' JSON IDs, exit codes, image digest, admin operator and reviewer in the provisioning ticket.
5. Test login only through the external HTTPS origin. Verify Secure/HttpOnly/SameSite cookies, CSRF denial on a missing token, an allowed tenant read and a cross-tenant denial.
6. Verify the worker starts with the complete merged `WORKER_TENANT_ACTORS_JSON` and can perform only a dry-run canary for this tenant.

For direct development use, export all five variables and run `pnpm db:bootstrap:operator`. The applications do not load `.env` automatically.

## High-privilege and idempotency warning

The tenant command and owner command both use the admin URL and require two-person approval. The tenant command is create-or-exact-replay only. It cannot edit, suspend, close or repair a tenant; use a separately reviewed administrative procedure for those operations.

The owner command always provisions `owner`; it is not a general member-management CLI. Re-running it for an existing email changes that user's password/display name, reactivates the user and grants/refreshes an owner membership in the selected tenant. Use it only for controlled initial bootstrap or explicit recovery with two-person approval.

Tenant creation writes an immutable `geo.tenant_provisioning_receipts` row that runtime and dispatcher roles cannot read. Owner bootstrap does not append a `geo.audit_log` row itself, so the provisioning ticket, database connection audit and emitted IDs remain mandatory evidence. Normal editor/auditor/publisher/viewer provisioning remains a product gap.

`MCP_PRINCIPALS_JSON` contains both a bearer token and an API login. Do not silently reuse an owner as a permanent machine principal. Commissioning may use the initial owner only under explicit approval; production MCP needs a dedicated least-privilege user once member provisioning supports it.

## Disable and rotate

For compromise or offboarding:

1. Set the user and memberships to `disabled`/`suspended` in one audited admin transaction.
2. Revoke all active `geo.sessions` rows for that user.
3. Remove/rotate the MCP bearer token and API password; restart `agent-mcp` so in-memory sessions and pending grants are discarded.
4. Review publication grants, jobs, receipts, governance decisions and audit logs for the exposure window.
5. Do not delete identity rows; retain referential and commercial audit history.
