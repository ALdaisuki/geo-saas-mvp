# Publication Kill Switch

## Effective boundary

The primary control is the tenant-scoped HTTP API:

- `POST /api/automation/kill-switch` requires an authenticated session, the effective `automation:manage` capability and a matching CSRF cookie/header. It accepts `{ "enabled": boolean, "reason": string }`, updates the tenant-level switch under RLS and appends `automation.kill_switch_changed` to `geo.audit_log` in the same transaction.
- `PUT /api/automation/control` has the same authentication requirements. It accepts the tenant mode, the exact five-key Worker quota and a reason, preserves the emergency switch, and appends `automation.control_changed` in the same transaction.
- `PUT /api/automation/controls/:scopeType/:scopeKey` manages platform/account/campaign/topic mode, the exact quota and a scoped Kill Switch after an RLS-scoped ownership check. It appends `automation.scoped_control_changed` in the same transaction.
- `POST /api/automation/circuits/:scopeType/:scopeKey/state` manually opens or closes tenant/platform/account/campaign/topic circuits. Operators cannot forge the automatic `half_open` probe state. Closing resets failure/probe counters and appends `automation.circuit_state_changed`.
- `GET /api/automation` requires `tenant:read` and independently reads the stored tenant control plus tenant/platform/account circuit breakers.

The database publication-grant function blocks new non-dry-run grant consumption while the tenant switch is enabled. The worker also re-reads the tenant switch before connector execution and blocks loaded jobs when it is enabled. The switch survives service restarts.

The tenant Kill Switch route changes only `kill_switch_enabled` and `reason`; the separate tenant control route changes only mode, quota and reason, so it cannot accidentally clear the switch. Scoped controls and circuit commands are independent audited writes and do not clear the tenant switch. Authenticated routes can revoke a known unconsumed grant and cancel an unlocked `queued`/`retry_wait` job, but neither action happens automatically when a switch is enabled. Cancellation returns `409` while an outbox lease is active and cannot interrupt a connector request already sent to a platform. The HTTP control plane still does not inventory every issued grant or reconcile an uncertain platform outcome. Use the tenant switch first, then apply scoped controls and the infrastructure/database procedures below according to the incident.

## Primary API stop

Use the external HTTPS origin so production Secure cookies work. Authenticate an owner/admin or another active member whose effective capability set contains `automation:manage`; never use the database admin credential as an API identity.

```powershell
$baseUri = 'https://geo.example.com'
$tenantSlug = 'replace-tenant-slug'
$reason = 'INC-0000: emergency publication stop'
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$loginBody = @{
  email = $env:GEO_OPERATOR_EMAIL
  password = $env:GEO_OPERATOR_PASSWORD
  tenantSlug = $tenantSlug
} | ConvertTo-Json -Compress

$login = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/auth/login" `
  -WebSession $webSession `
  -ContentType 'application/json' `
  -Body $loginBody

if ($login.actor.capabilities -notcontains 'automation:manage') {
  throw 'Operator lacks automation:manage'
}

$changed = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/automation/kill-switch" `
  -WebSession $webSession `
  -Headers @{ 'x-csrf-token' = $login.csrfToken } `
  -ContentType 'application/json' `
  -Body (@{ enabled = $true; reason = $reason } | ConvertTo-Json -Compress)

$readback = Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUri/api/automation" `
  -WebSession $webSession

if (-not $changed.control.killSwitchEnabled -or
    -not $readback.control.killSwitchEnabled -or
    $readback.control.reason -ne $reason) {
  throw 'Kill Switch API/readback verification failed'
}

$readback | ConvertTo-Json -Depth 8
```

Preserve the change response, independent readback, tenant, actor, reason, UTC timestamp and incident ticket. The API transaction writes the audit row; commercial evidence still needs the operator-side response/readback artifacts.

## Scoped grant and queue controls

After the durable switch is verified, revoke every still-unconsumed grant ID retained in the incident/audit records. There is no HTTP grant inventory endpoint, so an incomplete inventory requires the database fallback below.

```powershell
$grantId = 'REPLACE-KNOWN-GRANT-UUID'

$revoked = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUri/api/publication-grants/$grantId/revoke" `
  -WebSession $webSession `
  -Headers @{ 'x-csrf-token' = $login.csrfToken } `
  -ContentType 'application/json' `
  -Body (@{ reason = $reason } | ConvertTo-Json -Compress)

if ($revoked.status -ne 'revoked') {
  throw "Grant revoke was not confirmed: $grantId"
}
```

Then list the tenant's publication jobs and cancel each unlocked queue item. A `409` is an explicit failed cancellation, not proof that the work stopped; stop the worker/API mutation path and reconcile that job separately.

```powershell
$jobs = (Invoke-RestMethod `
  -Method Get `
  -Uri "$baseUri/api/publication-jobs" `
  -WebSession $webSession).items

foreach ($job in $jobs | Where-Object { $_.state -in @('queued', 'retry_wait') }) {
  Invoke-RestMethod `
    -Method Post `
    -Uri "$baseUri/api/publication-jobs/$($job.id)/cancel" `
    -WebSession $webSession `
    -Headers @{ 'x-csrf-token' = $login.csrfToken } `
    -ContentType 'application/json' `
    -Body (@{ reason = $reason } | ConvertTo-Json -Compress)
}
```

Preserve each revoke/cancel response and confirm job state through `GET /api/publication-jobs/:jobId`. These APIs do not make an already sent external request disappear.

For an active external-write incident, or when readback cannot be trusted, stop the mutation path after attempting the durable switch:

```powershell
docker compose stop agent-mcp worker api
```

This is a deployment-wide brake and affects every tenant on the single-host MVP. Prefer the tenant API for a contained incident, but do not trade containment for continued writes when platform state is uncertain.

## Emergency database fallback

Use this only when the API is unavailable/compromised, an issued-grant purge is required or the incident requires a stronger `stopped` mode. First stop `agent-mcp`, `worker` and `api`, then open an interactive admin `psql` session. Substitute approved values and execute one transaction:

```sql
\set tenant_id 'REPLACE-TENANT-UUID'
\set actor_id 'REPLACE-INCIDENT-ACTOR-UUID'
\set request_id 'INC-0000:kill-switch-fallback'
\set reason 'INC-0000: emergency publication stop'

begin;

with control as (
  insert into geo.automation_controls (
    tenant_id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
  ) values (
    :'tenant_id'::uuid, 'tenant', '*', 'stopped', '{}'::jsonb, true, :'reason'
  )
  on conflict (tenant_id, scope_type, scope_key) do update set
    mode = 'stopped',
    kill_switch_enabled = true,
    reason = excluded.reason,
    updated_at = clock_timestamp()
  returning id
), revoked as (
  update geo.publication_grants
  set status = 'revoked',
      revoked_at = clock_timestamp(),
      revoked_by_actor_id = :'actor_id'::uuid,
      revocation_reason = :'reason'
  where tenant_id = :'tenant_id'::uuid and status = 'issued'
  returning id
)
insert into geo.audit_log (
  tenant_id, actor_id, action, resource_type, resource_id, request_id, details
)
select
  :'tenant_id'::uuid,
  :'actor_id'::uuid,
  'automation.kill_switch_changed',
  'automation_control',
  control.id,
  :'request_id',
  jsonb_build_object(
    'enabled', true,
    'reason', :'reason',
    'controlId', control.id,
    'revokedGrantCount', count(revoked.id),
    'emergencyFallback', true
  )
from control left join revoked on true
group by control.id;

commit;
```

Verify from a new transaction/session:

```sql
select tenant_id, mode, kill_switch_enabled, reason, updated_at
from geo.automation_controls
where tenant_id = :'tenant_id'::uuid and scope_type = 'tenant' and scope_key = '*';

select status, count(*)
from geo.publication_grants
where tenant_id = :'tenant_id'::uuid
group by status;

select state, execution_level, count(*)
from geo.publication_jobs
where tenant_id = :'tenant_id'::uuid
group by state, execution_level
order by state, execution_level;

select id, actor_id, action, request_id, details, created_at
from geo.audit_log
where tenant_id = :'tenant_id'::uuid and request_id = :'request_id';
```

Attach the result counts and audit ID to the incident. After API recovery, also confirm the same tenant through `GET /api/automation`. If a live connector is added later, separately reconcile the platform account: an HTTP timeout may mean the platform accepted a write even when no receipt was recorded.

## Triage

- Leave API and agent-MCP stopped unless an edge rule can block publication mutations while preserving read-only operations.
- Treat grants issued before an API-only stop as unsafe for resume. Revoke them with an approved database transaction or prove they expired before disabling the switch.
- Classify queued, retrying, uncertain and reconciling jobs individually. Do not bulk resume them.
- Validate Zhongtong contact values against approved evidence: `4001133986`, `ZTGL3411`, `ZTGL6431`.
- Rotate platform/API/MCP credentials if compromise is possible.
- Record whether the issue affects content truth, authorization, duplicate risk, platform policy, tenant scope or provider evidence.

Current connectors do not make external writes, but the same incident process is required before any future API connector is enabled.

## Controlled resume

Resume requires two-person approval, an attached root-cause record and proof that no unsafe issued grant remains. Corrected variants must pass a new audit and receive a new one-time grant.

If the database fallback set mode to `stopped`, start the API alone and use `PUT /api/automation/control` to return the tenant to `shadow` with a separately reviewed conservative quota such as `maxConcurrent=1`, `perMinute=10`, `perDay=100`, `cooldownSeconds=0`, `errorBudget=5`. This write is audited and preserves `kill_switch_enabled=true`. Then use the Kill Switch route with a new 3-500 character reason and `enabled=false`. A separate `GET /api/automation` must show all of the following before the worker starts:

- `control.killSwitchEnabled` is `false`;
- `control.mode` is `shadow`;
- quota matches the approved conservative values; all MVP automation batches remain server-fixed `dry_run` regardless of mode;
- no relevant circuit is unexpectedly open or half-open.

Start the worker, run one dry-run canary and inspect its exact payload/audit/receipt hashes. Start agent-MCP only after the canary passes. Moving from `shadow` to `supervised` or `unattended` is a separate platform-capability decision and remains blocked for Toutiao, Sohu and Ctrip Community until onboarding evidence passes.

Never run `db-seed` as part of resume: the fixture seed clears the Zhongtong example Kill Switch without incident approval.
