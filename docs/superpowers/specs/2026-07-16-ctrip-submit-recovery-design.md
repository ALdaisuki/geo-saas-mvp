# Ctrip Consumed Submit Recovery Design

## Problem

The Ctrip bridge consumes a one-time permit before crossing the external submit
boundary. If the bridge process stops after permit consumption but before a
submit observation is persisted, the handoff remains in
`awaiting_operator_submit`. Reissuing submit could create a duplicate post, while
the existing readback route rejects the state and cannot reconcile it.

## Invariants

- A consumed submit permit is a permanent no-retry barrier.
- Recovery records `uncertain`; it never calls the adapter submit method.
- PostgreSQL remains the only durable publication state machine.
- Recovery, receipt creation and required-readback creation are one transaction.
- Only the bridge principal already bound to the handoff may recover it.
- Existing submit evidence wins. Recovery is idempotent and cannot overwrite it.
- Simulator evidence remains simulation-only and can never confirm publication.

## Design

Migration `0021` adds
`geo.recover_publication_assisted_submit_uncertain(handoff_id, evidence_kind)`.
The function locks the handoff, verifies the bound bridge principal and consumed
permit, and derives a deterministic recovery evidence hash from the handoff,
permit-consumption timestamp, adapter version and evidence kind. It delegates the
atomic receipt/readback write to the existing submit-observation function with an
`uncertain` outcome and appends a dedicated recovery audit event.

If durable submit evidence already exists, the function returns its receipt and
readback identifiers without mutation. If no permit was consumed, it rejects the
call. Concurrent normal observation and recovery serialize on the same handoff
row, so the first durable observation wins and the other path cannot overwrite
it.

The bridge loads `submitPermitConsumedAt`. On a readback command for a consumed
`awaiting_operator_submit` handoff, it invokes recovery, reloads the handoff, and
then performs the read-only adapter readback. The adapter exposes a fixed
`evidenceKind`; tenant or command input cannot choose it.

The API accepts readback for `readback_pending` or a consumed
`awaiting_operator_submit` handoff. The latter remains rejected when the permit
was not consumed. The Publishing view exposes the readback action and explicitly
states that retry is forbidden while reconciliation is pending.

## Verification

- SQL contract and ACL tests cover the function boundary and grant.
- PostgreSQL integration tests cover rejection, recovery, replay and concurrent
  evidence preservation.
- Bridge tests prove recovery happens before readback and submit is not called.
- API and Web tests prove only a consumed handoff enters recovery readback.
- Full MVP verification proves the simulator cannot produce real confirmation.
