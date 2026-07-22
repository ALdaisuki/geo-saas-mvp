# Ctrip Unattended Draft Automation Design

## Decision

The Ctrip Community integration automates the complete preparation path and
separates it from the final, supervised publication path. Preparation may fill
the audited title and body, upload the audited media set, save the draft, and
persist bounded evidence. Publication may run only after one explicit
confirmation in the GEO Web application. The confirmation causes the API to
claim the operator lease, issue a one-time permit, and invoke a distinct fixed
browser adapter in the same request.

The production adapter is named `browser_draft` and has the immutable version
`ctrip-community-browser-draft-v1`. Its capability contract is:

```text
prepare: true
submit: false
readback: false
```

`browser_draft` remains a standard unattended preparation program. A second
production mode, `browser_supervised`, has immutable version
`ctrip-community-browser-supervised-v1` and capabilities:

```text
prepare: true
submit: true
readback: false
```

The final platform action remains a visible human decision, but that decision is
made once in GEO Web rather than again on the Ctrip page. No timer, Worker,
Bridge poller, Pi tool, campaign mode, or retry path may create that confirmation.

## Source-Owned Surface Contract

The adapter only accepts one open, authenticated target page:

```text
https://we.ctrip.com/publish/publishPictureText
```

There must be exactly one matching page in the connected browser. Zero or more
than one matching page is `adapter_drift`; the adapter performs no mutation.

The writer owns the following fixed controls:

```text
title: [contenteditable="true"][role="textbox"].public-DraftEditor-content
body:  [contenteditable="true"][role="combobox"].public-DraftEditor-content
media: input[type="file"][accept="image/*"]
draft save: button with exact normalized text "存草稿"
```

The draft writer contains no final-publication selector. Its narrow browser port
exposes only title fill, body fill, one-file media upload, draft save, and draft
result observation. It has no generic click, locator, evaluate, script, submit,
or arbitrary-selector method.

The supervised submit writer is a separate narrow port. It owns only:

```text
prepared title/body/media readback
exact unique visible final action with normalized text "publish" (source literal is fixed)
bounded post-click observation
```

It accepts no selector, label, URL, script, click target, timeout, or page data
from a caller. Before the click it requires exactly one target page, one title
editor, one body editor, the audited media count, one final action, no challenge,
and exact normalized title/body readback. Any mismatch fails before permit
consumption where possible and never falls through to another control.

## Audited Input Contract

The bridge loads the already frozen final platform variant and its content-
addressed media from the control plane. It rejects any mismatch in tenant,
account, variant, content version, platform, adapter version, payload hash,
preview hash, media reference, byte size, or SHA-256 hash.

Before browser mutation, the Ctrip-specific audit policy requires:

```text
title: 5-20 Unicode characters after trimming
body: 60-3000 Unicode characters after Markdown-to-plain-text rendering
media: 1-20 audited images
```

Markdown is rendered deterministically to readable plain text. Links keep their
visible label and URL, headings and lists keep their textual structure, and raw
HTML or executable content is never passed to the browser. The rendered text is
the object hashed and compared during browser readback.

Location, date, topic, category template, and other optional fields remain empty
unless a later audited schema supplies explicit values. The adapter never
invents them from article prose.

## Preparation Sequence

For one claimed handoff the adapter performs this fixed sequence:

1. Connect to the configured Edge CDP endpoint.
2. Require exactly one authenticated target page and no challenge signal.
3. Require exactly one title editor, body editor, image input, and draft-save
   action matching the source-owned contract.
4. Fill title and body through the Draft.js editors and verify normalized text.
5. Upload each trusted media attachment through the fixed file input, one at a
   time, preserving audited order.
6. Wait for the expected bounded upload completion signal.
7. Save the draft once.
8. Observe a bounded draft-success result and compute session, draft, media
   manifest, and combined evidence hashes.
9. Persist `draft_prepared` and release the preparation lease.

The operation is fail-closed. Session expiry becomes `session_required`, a
challenge becomes `challenge_required`, and missing/duplicate controls, target
tabs, upload completion, or draft confirmation become `adapter_drift`. It never
falls through to another button or retries an ambiguous save automatically.

## Docker Desktop CDP Transport

The bridge may run in Docker Desktop while Edge runs on Windows. This transport
is a fixed deployment variant, not a caller-selected proxy:

```text
discovery HTTP authority: host.docker.internal:<configured port>
discovery Host header: 127.0.0.1:<configured port>
returned WebSocket authority: rewritten to host.docker.internal:<same port>
browser connection Host header: 127.0.0.1:<configured port>
```

Only loopback source endpoints and the literal Docker Desktop hostname are
accepted. Credentials, redirects, path overrides, arbitrary headers, arbitrary
hosts, and cross-port WebSockets are rejected.

## Unattended Preparation Lease

An assisted handoff currently uses a human operator lease for every state
transition. Draft automation needs a separate, strictly narrower lease on
`publication_assisted_handoffs`:

```text
draft_prepare_owner_principal_id
draft_prepare_lease_expires_at
```

The bound `ctrip_bridge` principal atomically claims this lease while the handoff
is `handoff_pending`, expired preparation leases are reclaimable, and only the
current preparation owner may record a prepared draft or preparation blocker.
The bridge principal cannot issue or consume a submit permit.

Human operator ownership remains the only authority for transitions after
`draft_prepared`. Existing submit permit, submit observation, recovery, and
readback functions retain their human lease requirements unchanged.

## Bridge Preparation Orchestration

For a configured Ctrip assisted account, the Worker validates the frozen
variant, audit, grant, channel account, and reviewed adapter mapping, then
creates or reuses the idempotent assisted handoff and acknowledges that durable
handoff. It does not block an outbox lease while a browser uploads media.

The Bridge runs one serial preparation poller per isolated browser session:

1. atomically claims the next eligible `handoff_pending` row bound to its exact
   tenant and bridge principal;
2. loads the audited payload and media only after the claim succeeds;
3. executes one preparation at a time against the single browser session;
4. persists `draft_prepared` or a durable preparation blocker and releases the
   lease;
5. applies bounded backoff after an unexpected internal failure.

The strict authenticated `prepare` endpoint remains available for operator
recovery, but it also claims the preparation lease before loading media or
touching the browser. A blocker is a durable handoff outcome, not a reason to
bypass login or challenge handling.

## GEO Web Supervised Submit

When a handoff reaches `draft_prepared`, GEO Web shows one confirmation command.
The user does not need a separate claim step. In one API request the server:

1. verifies CSRF, `publish:request`, current handoff state, audit, account,
   controls, circuit and Bridge health;
2. claims or refreshes the human operator lease for the current actor;
3. issues the one-time submit permit without returning it to the browser;
4. forwards the permit to the exact tenant-bound Bridge;
5. the Bridge consumes the permit, re-reads the prepared page, and invokes the
   fixed final action once;
6. records `accepted`, `uncertain`, or `rejected` evidence and creates required
   readback state.

Any exception after permit issuance returns `stateMayHaveChanged=true`. A
consumed permit is a permanent no-retry barrier. Missing or ambiguous post-click
evidence is `uncertain`; it is never treated as success and never retried.

## Safety Invariants

- Only the source-owned supervised writer contains the fixed final-publication
  label; the draft writer and all other modules contain none.
- `browser_draft.submit()` and `browser_draft.readback()` always reject.
- `browser_supervised.readback()` rejects until independent platform readback is
  implemented.
- The browser write port cannot express a final publication action.
- The supervised port can express exactly one source-owned final action and no
  generic browser operation.
- The Worker and Bridge poller can request only preparation.
- A bridge service principal cannot obtain human publication authority.
- A changed payload or media set requires a new audit and handoff.
- Missing, duplicate, or changed live controls stop the run as adapter drift.
- Login, QR, SMS, CAPTCHA, risk control, and device verification stay human.
- Successful draft preparation is never represented as a live publication.

## Acceptance Criteria

- `CTRIP_BRIDGE_MODE=browser_draft` starts with a reviewed source-owned adapter
  and advertises `prepare=true`, `submit=false`, `readback=false`.
- Docker Desktop CDP discovery and connection reach the dedicated Windows Edge
  session through the fixed authority/header rewrite.
- Unit tests prove title/body/media/draft-save order and strict drift handling.
- Database tests prove preparation ownership is independent from and weaker than
  human publication ownership.
- Worker tests prove handoff creation/reuse is followed by bridge preparation and
  that transport failures are bounded and observable.
- Repository audit finds no final-publication locator or executable submit path
  in the `browser_draft` adapter.
- A supervised production canary saves one audited Ctrip picture-text draft and
  leaves the real page waiting for GEO Web confirmation.
- The final canary click occurs only after the user explicitly confirms in GEO
  Web; the resulting state is `readback_pending` or `uncertain`, never falsely
  reported as confirmed publication.
