# Ctrip Browser Unattended Publication

## Goal

Allow a reviewed Ctrip browser adapter to complete the publication workflow without an operator click while preserving tenant isolation, audit gates, one-time submit permits, challenge blocking, and independent public readback.

## Boundaries

- The browser session is an operator-authenticated Edge session connected through a credential-free loopback CDP endpoint. The bridge never reads cookies, storage, headers, or tokens.
- The adapter may click only the fixed Ctrip publish action after the durable draft scope is re-read and matches the audited payload.
- A visible challenge, duplicate target page, selector drift, content mismatch, missing candidate URL, or uncertain post-click result fails closed.
- A submit permit is issued and consumed exactly once by the bound bridge principal for an `unattended` Ctrip job. It is never regenerated after the click boundary.
- Confirmation requires an independently loaded public Ctrip URL whose title/body evidence matches the audited payload. Browser submit acknowledgement alone is never confirmation.

## Flow

```text
Pi draft -> deterministic GEO audit -> publication grant
  -> unattended Ctrip job -> bridge handoff
  -> browser prepare and persisted evidence
  -> bridge-only one-time permit -> one submit click
  -> public Ctrip readback -> confirmed | needs_review
```

The existing assisted handoff state machine remains the durable source of truth. The new mode extends its execution-level checks and adds bridge-owned claim functions for submit and readback queues. Assisted mode remains operator-controlled.

## Recovery

- Before submit: permit expiry or bridge failure leaves the handoff retryable without a consumed permit.
- After permit consumption: no automatic submit retry is allowed. The bridge may only recover the durable uncertain observation and perform readback.
- Readback unavailable remains `readback_pending`; mismatch, not-found, challenge, or adapter drift becomes `needs_review` and opens the account circuit where applicable.

## Evidence

Every phase records tenant-scoped audit evidence: governance decision, grant consumption, handoff creation, prepared DOM scope, permit issue/consumption, submit observation, readback observation, and final receipt. Public confirmation stores only hashes and the validated Ctrip URL/ID.
