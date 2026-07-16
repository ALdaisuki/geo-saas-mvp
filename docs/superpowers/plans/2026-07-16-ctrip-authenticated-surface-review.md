# Ctrip Authenticated Surface Review Implementation Plan

**Goal:** Persist every live prepare preflight outcome and provide a read-only,
auditable review harness for an already-authenticated Ctrip browser surface while
keeping all real external writes disabled.

**Architecture:** PostgreSQL remains the publication state authority. The fixed
adapter returns a discriminated prepare result; the Bridge records either the
prepared draft or the blocking status before returning it. A separate
`playwright-core` review command attaches only to an explicitly configured local
CDP endpoint, observes already-open allowlisted Ctrip pages, emits bounded and
sanitized canonical evidence, and never navigates or mutates a page. A compiled
manifest with no reviewed execution surface keeps `live-canary` closed.

**Safety boundary:** No login automation, CAPTCHA/QR/SMS bypass, navigation,
click, type, upload, submit, cookie/storage/header collection, screenshot or full
HTML capture. Tenant/client input cannot supply URLs, selectors, scripts, headers
or file paths.

## Task 1: Typed prepare blockers and persistence

**Files:**

- Modify: `apps/ctrip-bridge/src/types.ts`
- Modify: `apps/ctrip-bridge/src/service.ts`
- Modify: `apps/ctrip-bridge/src/postgres-control-plane.ts`
- Test: `apps/ctrip-bridge/src/service.test.ts`

1. Add failing service tests for `session_required`, `challenge_required` and
   `adapter_drift` prepare results.
2. Define `CtripBridgePrepareResult` as the prepared evidence or a typed blocker
   carrying observed time, evidence kind, evidence hash and session evidence hash.
3. Add `recordPreparationBlocker` to `CtripBridgeControlPlane`.
4. Map `adapter_drift` to PostgreSQL status `failed` with
   `ASSISTED_ADAPTER_DRIFT`; preserve the other outcomes directly.
5. Return the existing strict contract result only after the durable operation
   succeeds.
6. Run `pnpm --filter @geo/ctrip-bridge test` and typecheck.

## Task 2: Fixed review manifest and pure evidence model

**Files:**

- Create: `apps/ctrip-bridge/src/authenticated-surface-review.ts`
- Create: `apps/ctrip-bridge/src/authenticated-surface-review.test.ts`
- Modify: `apps/ctrip-bridge/src/index.ts`

1. Test exact Ctrip hostname matching, rejection of query/fragment evidence,
   sensitive-label redaction, deterministic ordering/hashing, bounded evidence,
   challenge classification and drift classification.
2. Compile the allowlist and observation selectors into source. The initial
   `reviewedSurfaces` list is empty and execution is disabled.
3. Define a minimal page observation port so pure tests cannot perform browser
   actions.
4. Build canonical `geo.ctrip-surface-review.v1` evidence from origin/path,
   sanitized labels and boolean challenge signals only.
5. Make `assertCtripLiveCanaryReady` reject until a reviewed surface and execution
   controls are compiled.

## Task 3: Local Playwright CDP review command

**Files:**

- Create: `apps/ctrip-bridge/src/review-cli.ts`
- Modify: `apps/ctrip-bridge/src/config.ts`
- Modify: `apps/ctrip-bridge/src/config.test.ts`
- Modify: `apps/ctrip-bridge/package.json`
- Modify: `pnpm-lock.yaml`

1. Test and implement strict local-only CDP endpoint parsing. Reject credentials,
   paths other than `/`, query, fragment and non-loopback hostnames.
2. Add `playwright-core` as a direct runtime dependency.
3. Attach to the existing headed Chromium session, enumerate existing pages and
   adapt only read methods to the review port. Do not navigate or call any input
   method.
4. Print only the sanitized evidence JSON. Secrets remain environment-only.
5. Document the command as a supervised discovery tool, not live publishing.

## Task 4: Verification and handoff

**Files:**

- Modify: `docs/mvp-status.md`
- Modify: `docs/ops/deployment.md`

1. Document the new durable blocker path and exact remaining live gap.
2. Run package tests, typecheck, lint and build.
3. Run `WEB_E2E_PORT=4184 pnpm verify:mvp` with all temporary output rooted under
   `D:\GEO\.runtime\tmp`.
4. Check `git diff --check`, review the final diff, commit and push the existing
   `codex/geo-saas-mvp` branch.
