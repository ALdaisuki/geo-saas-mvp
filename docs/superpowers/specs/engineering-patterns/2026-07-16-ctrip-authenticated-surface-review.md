---
status: draft
---

# Ctrip Authenticated Surface Review Pattern

## Problem Solved

Ctrip Community does not expose a documented publishing API that this project can
rely on. Unauthenticated automated requests to the public community and legacy
editor surfaces were answered with HTTP 432 during the 2026-07-16 investigation,
and the legacy desktop editor URL does not prove which authoring surface an
authenticated account currently receives. Shipping guessed URLs or selectors
would turn ordinary login expiry, risk challenges and page changes into unsafe
or misleading automation.

## Reusable Pattern

Playwright supports attaching to an existing Chromium browser through CDP. The
useful boundary is narrower than general browser automation:

1. A human starts and authenticates a dedicated headed browser profile outside
   the Bridge. The Bridge never automates login, QR, SMS, CAPTCHA or device checks.
2. A review process attaches to the explicitly configured local CDP endpoint and
   inspects an already-open page without navigating, clicking, typing or uploading.
3. The process accepts only HTTPS pages whose canonical hostname is `ctrip.com`
   or a subdomain of it. Redirect targets, tenant input and page content cannot
   supply another URL, selector, script, header or local file path.
4. Evidence contains only canonical origin/path, sanitized visible control labels,
   challenge signals and a deterministic hash. Cookies, storage state, headers,
   tokens and full page content are never collected or logged.
5. A versioned source-owned surface manifest is compiled with the adapter. Live
   startup remains closed until the observed evidence has been reviewed and the
   manifest names the exact accepted surface and controls.

This separates discovery from execution. Review evidence can prove what an
authorized account saw, but it cannot authorize a write and it cannot by itself
make the live adapter production-ready.

## Bridge Adaptation

The adapter `prepare` contract should return a typed union. A valid fixed surface
returns `prepared`; missing authentication returns `session_required`; a risk
control returns `challenge_required`; an unrecognized reviewed surface returns
`adapter_drift`. Every non-prepared result is persisted through PostgreSQL before
the caller receives it, with the canonical evidence hash bound to the handoff.

`live-canary` must remain unavailable until a source-controlled, reviewed surface
manifest exists. The first enabled run is supervised and limited to one tenant,
one account and one audited handoff. Public readback, not the authoring DOM, is the
only path that can later confirm publication.

## Not Directly Reusable

- Playwright `connectOverCDP` is lower fidelity than its native protocol and is
  Chromium-only. It is appropriate for read-only inspection, not evidence that a
  write workflow is reliable.
- DOM labels are discovery evidence, not executable selectors. They can contain
  account or article data and therefore require strict normalization, redaction
  and length/count bounds.
- HTTP 432 is an observed denial signal, not a documented Ctrip API contract. The
  implementation must classify the actual authenticated page rather than keying
  behavior only on that status code.
- The old `you.ctrip.com/add-travel/guide.html` address must not be embedded as a
  current authoring URL until an authorized review proves it.

## References

- Playwright `BrowserType.connectOverCDP`: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Ctrip Community public surface: https://you.ctrip.com/
