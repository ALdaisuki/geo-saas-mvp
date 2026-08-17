---
status: draft
date: 2026-07-16
topic: ctrip-community-publishing
---

# Ctrip Community Publishing Evidence Analysis

## Question 1: What problem do the observed systems solve?

### Ctrip public surfaces

The first-party URL `https://open.ctrip.com/` redirects to
`https://u.ctrip.com/alliance/#/index`. The rendered product describes affiliate
registration, promotion material, order feedback, commission settlement and
social sharing. It does not expose or document a Ctrip Community article create,
publish, status, delete or readback API.

The public travel-guide site at `https://you.ctrip.com/` exposes published travel
notes and, while unauthenticated, still renders a link labelled "发表游记大作".
That link points to `http://you.ctrip.com/add-travel/guide.html`; its HTTPS form
currently renders Ctrip's not-found page rather than an editor. This proves that
public travel-note read surfaces exist, but it does not prove that a supported
desktop authoring surface or automation contract still exists.

### Existing GEO publication pipeline

The current GEO system solves a different but reusable problem: it binds one
tenant-scoped frozen platform variant to a deterministic audit, a short-lived
single-use grant, an immutable job and outbox event, an execution attempt, a
receipt and a readback disposition. Ambiguous outcomes reconcile before any
retry, and tenant/platform/account controls can stop execution.

## Question 2: What core pattern should be reused?

Use a supervised handoff with three separately evidenced stages:

1. `draft_prepared`: exact audited bytes were placed into an authenticated Ctrip
   authoring session. This is not a publication.
2. `submitted_unconfirmed`: a human explicitly approved the final submit action,
   but no independent public result has yet been verified. This is an uncertain
   external write and must never be retried automatically.
3. `confirmed`: an independent Ctrip public URL/readback identifies the same
   account and verifies the expected title/body/media binding.

The main worker prepares the immutable handoff. An isolated publisher bridge owns
the authenticated session. Pi Agent cannot operate the bridge. Immediately before
the final click, the bridge must obtain a one-time server permit that rechecks the
audit/grant binding, handoff lease, Kill Switch and circuit gates. CAPTCHA, mobile
verification and risk-control challenges are returned to the operator rather than
bypassed.

## Question 3: What cannot be reused or inferred?

- Affiliate APIs cannot be repurposed as community-content publishing APIs.
- A stale editor URL, DOM selector, internal request or successful login is not a
  supported platform contract.
- A screenshot can prove UI state at a time, but cannot independently prove public
  publication or exact content readback.
- Dry-run receipts cannot be upgraded in place. Assisted attempts need distinct
  evidence types and required readback.
- Existing worker completion assumes `dry_run`, `preview` evidence and
  `readback.not_required`; it cannot execute assisted delivery unchanged.
- Existing Ctrip title/body/media limits are policy inputs, not verified current UI
  limits. Authenticated session research must confirm them before external writes.

## Adopted conclusion

Build a Ctrip-specific connector contract and supervised handoff state machine
now, but keep the default registry and production execution fail-closed. Capability
may advance from `manual_only` to `browser_assisted` only after reviewed evidence
of the authenticated authoring surface, permitted automation, session/challenge
behavior and an independent public readback path. `unattended` remains ineligible
without a documented public or partner API.

## Evidence limitations

The inspection used a clean, unauthenticated Edge profile on 2026-07-16. No
credential, cookie or private endpoint was captured. An authorized Ctrip account
review and written platform permission remain required before a live canary.
