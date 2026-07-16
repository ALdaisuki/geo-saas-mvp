# Ctrip Worker Handoff Increment 3A Plan

## Scope

Connect an audited Ctrip `assisted` publication request to the durable handoff
control plane. The Worker may render the frozen Ctrip preview and create a handoff;
it may not hold a browser session, prepare an external draft, request a submit
permit or contact Ctrip.

## Admission contract

- Keep `unattended` rejected for every browser-assisted account.
- Admit `assisted` only when the grant is bound to `ctrip_community` and the active
  account is `browser_assisted`, declares `assisted`, has current reviewed evidence
  and is allowed by tenant/scoped controls and circuits.
- Preserve the existing grant/audit/token/idempotency transaction and Plastic
  Promise governance call before job/outbox creation.
- Keep all Toutiao, Sohu and non-Ctrip live requests unsupported.

## Worker contract

- Configure reviewed adapter versions per exact tenant/account tuple. A missing,
  duplicate, stale or mismatched mapping is fail-closed and never selects another
  tenant's adapter.
- Acquire the publication attempt before creating a handoff.
- Render the exact frozen Ctrip preview through the shared connector renderer; do
  not call session, preflight, submit, publish, status or evidence methods.
- Bound handoff expiry by the grant, audit artifact, configured TTL and the database
  two-hour ceiling.
- Persist with `geo.create_publication_assisted_handoff`, then acknowledge the
  outbox event. Never acknowledge first.
- On redelivery after a crash, validate and reuse the existing job-bound handoff
  instead of acquiring a new attempt.
- Report `handedOff` separately from `completed`; handoff creation is not a receipt
  and cannot move the job to `preview_completed` or `confirmed`.

## Tasks

1. Add migration `0018_ctrip_assisted_admission.sql` with a narrow Ctrip-assisted
   grant-consumption function and least-privilege ACL reconciliation.
2. Update API admission and tests so Ctrip-assisted reaches governance and the new
   database function, while all other live execution remains rejected.
3. Export the connector's deterministic Ctrip renderer for Worker handoff use.
4. Add tenant/account-scoped Worker adapter configuration and parser tests.
5. Extend the Worker store contract with authorization expiry, existing-handoff
   readback and idempotent handoff creation.
6. Add Worker unit and PostgreSQL integration tests for create-before-ack, replay,
   missing configuration, tenant/account mismatch and no connector network calls.
7. Update API, deployment, MVP and Ctrip design documentation.

## Verification

```powershell
pnpm --filter @geo/connectors test
pnpm --filter @geo/worker test
pnpm --filter @geo/db test
pnpm --filter @geo/db test:integration
pnpm --filter @geo/api test
pnpm verify:mvp
git diff --check
```

All temporary PostgreSQL and browser data must remain under
`D:\GEO\.runtime\tmp`.

## Exit criteria

- A valid Ctrip assisted request can create exactly one durable handoff.
- Worker crash/redelivery cannot create a second attempt-bound handoff.
- No default deployment or missing mapping can perform or claim an external write.
- No handoff produces a publication receipt or confirmation.
- The remaining 3B boundary is explicit: authenticated bridge, challenge handling,
  draft preparation, one-time submit consumption and independent public readback.
