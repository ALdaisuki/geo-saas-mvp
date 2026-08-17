---
status: draft
date: 2026-07-16
topic: ctrip-submit-observation-readback
---

# Ctrip Submit Observation And Readback Patterns

## Problem

The existing Ctrip handoff can bind an audited draft to a tenant, account,
operator and isolated bridge, then consume a one-time submit permit. Permit
consumption proves authorization, but it does not prove what happened after the
bridge attempted the external write. A browser or network failure can leave the
result unknown even when Ctrip accepted the submission.

The next increment therefore needs to preserve three different facts:

1. the operator authorized one exact submit attempt;
2. the bridge observed a definite or uncertain browser outcome;
3. an independent public readback later confirmed or rejected the expected
   account/content binding.

Collapsing these facts would create either duplicate posts or false publication
claims.

## Patterns To Reuse

### Unknown-result barrier

AWS's guidance on retry-safe APIs uses caller-provided idempotency identifiers to
recognize repeated intent, but also distinguishes retries from a new operation.
For a third-party browser surface, there is no supported Ctrip idempotency key, so
the local key can deduplicate our own command only. It cannot make the remote
submit safe to repeat.

After the submit control is activated, every bridge outcome must therefore enter
`submitted_unconfirmed`, including a timeout, lost response or ambiguous page
transition. No path from that state may return to submit. Reconciliation is
read-only.

Permit consumption itself is also part of that boundary. If the bridge stops
before it can persist an observation, the consumed permit must be recovered as a
durable `uncertain` observation before readback. Recovery must never invoke the
external submit action again.

Source: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/

### Observation before interpretation

Persist a normalized submit observation rather than a Boolean `published` flag.
The observation binds the handoff, permit consumption, adapter version, exact
preview hash, timestamp and an evidence hash. Its outcome is one of:

- `accepted`: the reviewed surface showed an expected post-submit acknowledgement;
- `uncertain`: the bridge crossed the submit boundary but could not classify the result;
- `rejected`: the reviewed surface definitively rejected the command before acceptance.

`accepted` is still unconfirmed. `uncertain` opens a reconciliation path without
retry. `rejected` is eligible only for operator review; it is not automatically
resubmitted because UI rejection evidence can itself be stale or incomplete.

### Fixed adapter and semantic locators

Playwright recommends resilient user-facing or explicit test-id locators and
auto-waiting assertions. The bridge should compile those locators into one
reviewed adapter version. Tenant data may select only a known adapter version; it
must never supply a URL, selector, script, header, cookie path or executable
fragment.

Source: https://playwright.dev/docs/locators

The local simulator uses the same typed adapter contract and state transitions as
the future authorized adapter. It is explicitly identified as simulation evidence
and cannot create a real external URL, real Ctrip identifier or confirmed receipt.

### Independent readback as the confirmation boundary

The existing publication pipeline already separates receipts from scheduled
readbacks. Reuse that separation for assisted Ctrip delivery:

```text
submit observation
  -> immutable, unconfirmed browser receipt
  -> required readback
  -> confirmed only when public evidence matches tenant/account/content scope
```

A screenshot, editor draft identifier or post-submit acknowledgement can support
the unconfirmed receipt but cannot set `confirmed=true`. The public readback must
provide a public HTTPS URL, external identifier, observed content hash and
evidence hash. A mismatch ends in `needs_review`; absence remains pending until a
bounded deadline, then also ends in `needs_review`.

### Transactional state and evidence write

The handoff state transition, immutable receipt insertion, readback scheduling
and audit event must commit in one database transaction. This reuses the
repository's existing transactional-outbox and append-only receipt patterns. It
prevents a visible `submitted_unconfirmed` handoff without a receipt or a receipt
without required reconciliation work.

## Patterns Not To Reuse

- A local idempotency key cannot be presented as Ctrip-side duplicate protection.
- A successful click, navigation or screenshot cannot be presented as public
  publication.
- Generic browser automation configuration cannot cross the bridge boundary.
- Pi Agent output, article text or tenant settings cannot alter adapter code.
- An `uncertain` submit cannot be retried automatically, even after permit expiry.
- Simulator evidence cannot be promoted into live evidence or a confirmed receipt.

## Adopted Boundary

Increment 3B-B will implement the typed bridge contract, deterministic local
simulator, submit-observation persistence, required readback state and operator
visibility. Default production configuration will have no Ctrip destination and
no external network-write path. A future live adapter requires written account
authorization, reviewed authenticated-surface evidence and a separately approved
canary plan.
