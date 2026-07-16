# Ctrip Assisted Handoff Increment 2 Plan

## Scope

Add the durable multi-tenant control plane that sits between an audited Ctrip
publication job and a future authenticated publisher bridge. This increment does
not enable assisted publication requests, expose browser credentials, operate a
browser or execute a final submit.

## State and evidence contract

- Persist one tenant-scoped handoff per publication job and attempt.
- Keep request identity immutable: job, attempt, account, variant, payload hash,
  audit hash, preview hash, adapter version and idempotency key.
- Model `handoff_pending`, `session_required`, `challenge_required`,
  `draft_prepared`, `awaiting_operator_submit`, `submitted_unconfirmed`,
  `readback_pending`, `confirmed`, `needs_review`, `cancelled`,
  `expired` and `failed` explicitly.
- Store evidence hashes and redacted references only. Never store cookies,
  authorization headers, QR/SMS values or raw screenshots.
- Store only a submit-permit hash. The raw random permit is returned once and
  becomes invalid after one successful consume or five minutes.

## Tasks

1. Add migration `0017_ctrip_assisted_handoffs.sql`:
   - table constraints, tenant RLS, immutable request fields and terminal states;
   - current governance block-reason helper covering tenant/platform/account
     controls, Kill Switches, circuits, account capability and live audit binding;
   - create, claim, heartbeat, cancel, issue-permit and consume-permit functions;
   - append-only audit events for every material transition;
   - narrow table privileges and function grants.
2. Add the handoff row to the typed database catalog and migration contract
   checks.
3. Add API repository views and PostgreSQL implementations for list/get,
   operator claim, heartbeat and cancel. Raw permit operations remain bridge-side
   and are not exposed by the browser API in this increment.
4. Add protected HTTP routes using existing `publish:request`,
   `publish:cancel`, CSRF and tenant context boundaries.
5. Add API contract tests and PostgreSQL integration tests for:
   - tenant isolation and cross-tenant invisibility;
   - lease ownership, expiry and heartbeat;
   - terminal cancellation;
   - permit denial under Kill Switch and open circuit;
   - single-use permit consumption and no state promotion to confirmed.
6. Update API and MVP status documentation.

## Verification

```powershell
pnpm --filter @geo/db test
pnpm --filter @geo/db test:integration
pnpm --filter @geo/api test
pnpm --filter @geo/api typecheck
pnpm verify:mvp
git diff --check
```

All temporary PostgreSQL and Playwright data must use
`D:\GEO\.runtime\tmp`.

## Exit criteria

- A durable handoff can be created only for a current, audited, Ctrip assisted
  attempt with a reviewed adapter version.
- Operators can inspect, claim, heartbeat and cancel only their tenant's
  handoffs.
- A submit permit is one-time, short-lived and denied if governance changes
  after draft preparation.
- No API or worker path can perform a Ctrip network write.
- No handoff state or screenshot can claim public confirmation.
