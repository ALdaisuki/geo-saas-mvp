# Ctrip Browser Preflight Bridge Implementation Plan

**Goal:** Connect the existing authenticated Ctrip surface reviewer to the durable
Bridge prepare command without adding any browser write capability.

**Architecture:** PostgreSQL remains the only publication state authority. The
Bridge starts in one of two explicit modes: the existing no-network simulator or a
single-tenant browser preflight process. The preflight adapter reuses the bounded
read-only CDP session, maps sanitized review evidence to a durable preparation
blocker and declares command capabilities so unsupported commands fail before
permit consumption.

**Safety boundary:** Browser preflight may enumerate already-open allowlisted pages
and run fixed read probes. It cannot navigate, click, type, upload, submit, inspect
credentials or storage, capture HTML/screenshots, consume a submit permit, perform
readback or produce publication confirmation. The compiled live-canary manifest
remains disabled.

## Task 1: Explicit mode and adapter capabilities

1. Add strict `simulator|browser_preflight` startup parsing and require exactly one
   tenant in browser preflight mode.
2. Add fixed adapter command capabilities and keep the simulator fully functional.
3. Reject unsupported commands in the command service before any one-time permit is
   consumed.
4. Cover mode parsing and the permit-preservation invariant with unit tests.

## Task 2: Reusable browser review session

1. Extract CDP connection, current-page enumeration and idempotent close behavior
   from the standalone review CLI.
2. Validate the credential-free loopback endpoint and non-system runtime temp root
   before connection.
3. Re-read current pages for every inspect call so stale page snapshots are not
   retained.
4. Reuse the session from both the standalone evidence command and Bridge mode.

## Task 3: Fail-closed browser preflight adapter and HTTP surface

1. Map `session_required`, `challenge_required` and `adapter_drift` directly to
   durable preparation blockers.
2. Map `reviewed_surface` to `adapter_drift` while live canary remains disabled.
3. Advertise the actual mode and adapter version in health output and return `404`
   for `/simulator` in browser preflight mode.
4. Close database and browser resources on startup/listen failure and disconnect
   both when the server closes.

## Task 4: Verification and handoff

1. Run formatter, lint, Bridge typecheck/tests and contracts tests.
2. Document the operating boundary in MVP status, deployment, HTTP API and threat
   model references.
3. Run `WEB_E2E_PORT=4184 pnpm verify:mvp` with `TEMP`, `TMP` and `TMPDIR` rooted at
   `D:\GEO\.runtime\tmp`.
4. Review the final diff, commit and push the current Draft PR branch.

## Remaining live gap

Real Ctrip publication still requires written account authorization, approved
source-controlled prepare/upload/submit selectors, a separately reviewed
write-capable adapter, one explicitly supervised low-quota canary, ambiguity
reconciliation and independent public URL/readback evidence.
