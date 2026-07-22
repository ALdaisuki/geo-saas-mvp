# Ctrip Unattended Draft Automation Implementation Plan

**Goal:** Run article generation through audited Ctrip draft preparation, then
require exactly one human confirmation in GEO Web before the Bridge invokes the
fixed real Ctrip publication action.

**Architecture:** A source-owned `browser_draft` Playwright adapter writes the
audited title, plain-text body, and audited media before saving a draft. A
bridge-owned preparation lease and serial poller process handoffs without holding
Worker outbox leases. A separate `browser_supervised` adapter re-reads the exact
draft and may click only the fixed final action after the API consumes one GEO
Web confirmation through the existing one-time permit state machine.

## Task 1: Lock configuration and capability contracts

**Files:**

- Modify: `apps/ctrip-bridge/src/config.test.ts`
- Modify: `apps/ctrip-bridge/src/http-server.test.ts`
- Modify: `apps/ctrip-bridge/src/config.ts`
- Modify: `apps/ctrip-bridge/src/cli.ts`

1. Add failing tests for `browser_draft`, the immutable adapter version, and
   `prepare=true/submit=false/readback=false` health output.
2. Add failing tests for the fixed Docker Desktop discovery transport and reject
   arbitrary hosts, Host headers, credentials, paths, and port changes.
3. Implement the strict resolver and connect options without weakening the
   existing loopback review resolver.

## Task 2: Build the narrow browser draft writer

**Files:**

- Add: `apps/ctrip-bridge/src/browser-draft-adapter.test.ts`
- Add: `apps/ctrip-bridge/src/browser-draft-adapter.ts`
- Add: `apps/ctrip-bridge/src/playwright-draft-writer.test.ts`
- Add: `apps/ctrip-bridge/src/playwright-draft-writer.ts`
- Modify: `apps/ctrip-bridge/src/browser-review-session.ts`
- Modify: `apps/ctrip-bridge/src/cli.ts`

1. Define a narrow writer port with title, body, one-file upload, draft save, and
   bounded result observation methods only.
2. Test exactly-one target page/control requirements, Draft.js fill/readback,
   Markdown-to-plain-text conversion, limits, ordered uploads, blockers, and
   evidence hashing.
3. Implement the fixed Playwright writer and adapter.
4. Keep submit/readback methods as unconditional rejections and add a source scan
   test that the writer contains no final-publication label/locator.

## Task 3: Add the bridge-owned preparation lease

**Files:**

- Add: `packages/db/migrations/0024_ctrip_draft_prepare_lease.sql`
- Modify: `packages/db/tests/migration-contract.test.ts`
- Modify: `packages/db/tests/postgres.integration.test.ts`
- Modify: `apps/ctrip-bridge/src/types.ts`
- Modify: `apps/ctrip-bridge/src/postgres-control-plane.ts`
- Modify: `apps/ctrip-bridge/src/service.ts`
- Modify: `apps/ctrip-bridge/src/service.test.ts`

1. Add preparation owner/expiry columns and an atomic bridge-principal claim
   function for `handoff_pending` rows.
2. Change prepared/blocker recording functions to require the active preparation
   lease while preserving all human submit functions.
3. Claim the preparation lease before browser mutation and prove conflicting or
   expired ownership behavior in PostgreSQL integration tests.

## Task 4: Make Bridge prepare handoffs automatically

**Files:**

- Modify: `apps/ctrip-bridge/src/types.ts`
- Modify: `apps/ctrip-bridge/src/postgres-control-plane.ts`
- Modify: `apps/ctrip-bridge/src/service.ts`
- Add: `apps/ctrip-bridge/src/preparation-poller.test.ts`
- Add: `apps/ctrip-bridge/src/preparation-poller.ts`
- Modify: `apps/ctrip-bridge/src/cli.ts`

1. Add atomic claim-by-id and claim-next control-plane operations.
2. Claim before loading payload/media or touching the browser.
3. Run one bounded serial poller for the isolated browser session.
4. Test that the poller can express only preparation and backs off after errors.

## Task 5: Add the supervised browser submit adapter

**Files:**

- Add: `apps/ctrip-bridge/src/browser-supervised-adapter.test.ts`
- Add: `apps/ctrip-bridge/src/browser-supervised-adapter.ts`
- Add: `apps/ctrip-bridge/src/playwright-supervised-submit-writer.test.ts`
- Add: `apps/ctrip-bridge/src/playwright-supervised-submit-writer.ts`
- Modify: `apps/ctrip-bridge/src/browser-review-session.ts`
- Modify: `apps/ctrip-bridge/src/config.ts`
- Modify: `apps/ctrip-bridge/src/cli.ts`
- Modify: `packages/contracts/src/ctrip-bridge.ts`

1. Add `browser_supervised` and immutable adapter/capability contracts.
2. Before submit, re-read exact normalized title/body/media count and require one
   target page, one final action and no challenge.
3. Consume the existing permit, click once, and map bounded evidence to
   accepted/uncertain/rejected without automatic retry.
4. Keep arbitrary selector, evaluate, script and generic click APIs absent.

## Task 6: Make GEO Web confirmation one click

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`

1. Automatically claim/refresh the current operator lease inside submit.
2. Issue and forward the permit in the same API request.
3. Show one confirmation for `draft_prepared` without a separate claim action.
4. Display submitted-unconfirmed/uncertain language and never claim confirmed
   publication without readback.

## Task 7: Ship one-click deployment configuration

**Files:**

- Modify: Docker Compose and customer setup files selected by repository search
- Modify: `docs/ops/deployment.md`
- Modify: `docs/mvp-status.md`
- Modify: `客户版使用说明.md`

1. Add `browser_supervised` mode, Docker Desktop CDP endpoint, D-drive runtime
   root, and generated tenant-bound Bridge settings.
2. Keep secrets in the existing generated environment file and never print them.
3. Present the customer state as “草稿已准备，等待人工发布”, not published.

## Task 8: Verify with a real saved-draft canary

1. Run changed package unit/type tests and PostgreSQL integration tests.
2. Run the repository lint and `git diff --check`.
3. Scan production browser writer and Worker code for final-publication locators,
   submit capability, generic browser execution, or permit consumption.
4. Start the customer stack and connect to the dedicated Edge CDP session.
5. Use one already-audited article/media set, run automatic prepare once, and
   confirm Ctrip reports a saved draft while the final action remains untouched.
6. Record hashes and state only; do not expose credentials or article content in
   logs or screenshots.
7. Ask the user to confirm once in GEO Web; only that action may trigger the
   real final click. Confirm durable submitted-unconfirmed/uncertain evidence.
8. Commit and push the scoped branch to the existing private GitHub repository.
