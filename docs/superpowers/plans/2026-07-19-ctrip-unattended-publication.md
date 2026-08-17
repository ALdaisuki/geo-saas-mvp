# Ctrip Unattended Publication Plan

## 1. Contracts and browser adapter

- Add `browser_unattended` bridge mode and health contract.
- Reuse the fixed draft writer and supervised submit scope checks.
- Add a public readback writer that accepts only a previously observed Ctrip candidate URL, detects challenge/adapter drift, and returns platform-readback evidence with the audited payload hash only after DOM content matches.
- Keep browser modes credential-free at the CDP boundary and source-compile all target origins/selectors.

## 2. Database admission and control plane

- Add migration `0025` to admit only the reviewed Ctrip browser adapter marker for `unattended` channel accounts.
- Extend Ctrip admission and block-reason functions to support `unattended`, requiring tenant/scoped control mode `unattended`, current account evidence, reviewed adapter marker, live audit, quota and circuit gates.
- Make handoff receipts/readbacks use the job execution level rather than hardcoded `assisted`.
- Add bridge-only atomic claim functions for an unattended submit permit and pending readback. Permit issuance remains one-time and is never recreated after consumption.

## 3. Worker/API wiring

- Allow `unattended` only for Ctrip Community and route it through the audited Ctrip admission function.
- Treat both Ctrip `assisted` and `unattended` jobs as handoffs in the worker; retain dry-run behavior for every other platform.
- Include execution level in the bridge handoff load so the exact audited scope is rendered and verified.

## 4. Bridge controller

- Start a controller loop in `browser_unattended` that drains prepare, submit and readback queues.
- Submit flow: claim prepared handoff and issue permit atomically, revalidate the draft, consume permit, click once, persist observation.
- Readback flow: claim `readback_pending`, load the public candidate URL, persist confirmed or review evidence.
- On timeout after permit consumption, recover the durable uncertain observation and perform readback only; never click again.

## 5. Verification and live run

- Add unit/contract tests for capability gates, permit idempotency, execution-level persistence, adapter drift, challenge blocking, uncertain recovery and public readback mismatch.
- Build images, run migrations, start the D-drive customer profile on `10000+` ports, and run a new real-Pi Ctrip publication job.
- Verify Ctrip public URL, receipt/readback, audit actions, kill-switch behavior and absence of duplicate submit attempts.
