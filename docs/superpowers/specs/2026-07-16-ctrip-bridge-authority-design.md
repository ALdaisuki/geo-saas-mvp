# Ctrip Bridge Authority Separation Design

## Decision

Increment 3B-A separates human approval from isolated bridge execution before any
authenticated Ctrip adapter is connected. It adds no browser implementation and
performs no Ctrip network request.

## Scope

- Add a `publish:bridge` capability and a constrained `ctrip_bridge` integration
  service-principal profile. Human roles never receive this capability.
- Bind every newly created assisted handoff to one exact tenant bridge principal.
- Require an active publisher/owner/admin membership for operator claim,
  heartbeat, permit issuance and cancellation.
- Require the bound active bridge principal for session/challenge evidence, draft
  evidence and submit-permit consumption.
- Persist the permit issuer and consumer identities without persisting raw permit
  material.
- Open the account circuit when the bridge reports a challenge or adapter drift.
- Expose operator-only service-principal creation and submit-permit issuance
  through the existing session/CSRF API.

## Non-goals

- Browser login, QR/SMS/CAPTCHA handling or risk-control bypass.
- Ctrip draft or final-submit network actions.
- Arbitrary bridge URL, selector, script, header or filesystem input.
- Submit observation, receipt creation, public readback or `confirmed` state.
- `unattended` execution for a browser-assisted account.

## Identity Model

| Actor              | Durable identity                                               | Allowed actions                                                  |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Human operator     | active tenant membership with `publish:request`                | claim, heartbeat, cancel, issue submit permit                    |
| Publication Worker | active tenant worker service principal                         | create the handoff bound to a reviewed bridge principal          |
| Ctrip bridge       | active `integration + ctrip_bridge + publish:bridge` principal | record session/challenge/draft evidence, consume operator permit |
| Pi Agent           | agent principal without `publish:bridge`                       | none of the bridge or permit operations                          |

The PostgreSQL login role remains shared infrastructure. Every security-definer
function validates `app.actor_id` against the correct tenant actor table and exact
profile before changing state.

## Schema Changes

Migration `0019_ctrip_bridge_authority.sql` adds nullable columns for backward
readability while requiring them in all new operational functions:

```text
bridge_service_principal_id
external_draft_id
submit_permit_issued_by_actor_id
submit_permit_consumed_by_principal_id
```

Pre-0019 handoffs remain visible and cancellable but cannot prepare a draft or
consume a submit permit. New handoffs use an overload of
`create_publication_assisted_handoff` that validates and stores the bridge
principal. Execute permission on the legacy unbound creation and draft functions
is revoked from `geo_runtime`.

## Function Ownership

### Operator-only

- `claim_publication_assisted_handoff`
- `heartbeat_publication_assisted_handoff`
- `issue_publication_assisted_submit_permit`
- `cancel_publication_assisted_handoff`

### Bridge-only

- `record_publication_assisted_bridge_status`
- bound overload of `record_publication_assisted_draft`
- `consume_publication_assisted_submit_permit`

Each bridge function requires a live operator lease owned by the permit issuer or
current operator as appropriate. Bridge evidence is hash-only and must echo the
handoff adapter version and immutable preview scope.

## State Behavior

```text
handoff_pending
  -> session_required       bridge reports no authenticated session
  -> challenge_required     bridge reports platform challenge; account circuit opens
  -> failed                 bridge reports reviewed adapter drift; account circuit opens
  -> draft_prepared         bridge records session + draft evidence and external draft reference

draft_prepared
  -> awaiting_operator_submit   human operator issues one-time permit
```

Permit consumption records no submit claim and does not advance the state. The
next increment must add an explicit bridge submit observation before
`submitted_unconfirmed` can be reached.

## API Contract

- `POST /api/service-principals/ctrip-bridges` creates a credential-less bridge
  identity; credential distribution stays an operations concern.
- `POST /api/publication-assisted-handoffs/:handoffId/submit` requires
  `publish:request`, CSRF and the current operator lease. The API issues the raw
  permit internally and forwards it once to the bound bridge; browsers never
  receive it, and list/get responses and logs never include it.

## Acceptance Criteria

- A human, Worker, Pi principal or bridge from another tenant cannot consume the
  permit.
- The bridge cannot issue its own permit, and the operator cannot consume it.
- A disabled or mismatched bridge principal fails before state mutation.
- Session/challenge/draft evidence is tenant/account/handoff/adapter bound.
- Challenge and adapter drift open the exact account circuit.
- Raw cookies, authorization values, QR/SMS values, screenshots and permit tokens
  are absent from persisted rows and audit details.
- Default deployment still has no Ctrip network-write path.
