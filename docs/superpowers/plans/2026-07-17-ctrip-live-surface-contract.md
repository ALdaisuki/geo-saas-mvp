# Ctrip Live Surface Contract Implementation Plan

**Goal:** Make authenticated Ctrip discovery evidence specific enough for a
reviewed future adapter without adding any browser mutation or live publication
capability.

**Architecture:** The source-owned manifest gains an exact discovery surface and
a fixed structural-attribute allowlist. The existing Playwright read port reads
only those attributes for visible controls. The pure evidence builder discards
control observations from unrelated Ctrip tabs, canonicalizes the remaining
fingerprints, and emits schema v2 evidence. Reviewed execution surfaces remain
empty and live canary remains disabled.

## Task 1: Lock the evidence contract with failing tests

**Files:**

- Modify: `apps/ctrip-bridge/src/authenticated-surface-review.test.ts`
- Modify: `apps/ctrip-bridge/src/playwright-surface-reader.test.ts`
- Modify: `apps/ctrip-bridge/src/browser-preflight-adapter.test.ts`

1. Add a target discovery page and an unrelated authenticated Ctrip page. Assert
   only the target page contributes controls.
2. Add duplicate, unknown, sensitive, and unordered structural attributes. Assert
   only allowlisted sanitized attributes survive in canonical order.
3. Assert the Playwright port requests exactly the fixed attribute names and
   never requests input `value`, article body text for editors, or arbitrary DOM.
4. Update the strict schema expectation to v2 and run the tests to capture the
   intended failure.

## Task 2: Implement the source-owned discovery contract

**Files:**

- Modify: `apps/ctrip-bridge/src/authenticated-surface-review.ts`
- Modify: `apps/ctrip-bridge/src/playwright-surface-reader.ts`

1. Add the exact picture-text discovery surface to the manifest while leaving
   `reviewedSurfaces=[]` and `liveCanaryEnabled=false`.
2. Add the fixed structural-attribute allowlist and pass it through the narrow
   read-only page port.
3. Sanitize, bound, deduplicate, and sort attributes in the pure evidence builder.
4. Empty controls on non-discovery Ctrip pages while retaining their bounded
   session/challenge classification.
5. Emit `geo.ctrip-surface-review.v2` and include attributes in deterministic
   evidence hashing.

## Task 3: Verify in tests and against the supervised real session

1. Run `pnpm --filter @geo/ctrip-bridge test`.
2. Run `pnpm --filter @geo/ctrip-bridge typecheck`.
3. Run the real read-only command with the existing local CDP endpoint and D-drive
   temp root. Confirm only `/publish/publishPictureText` contributes controls, the
   result remains `adapter_drift`, and challenge signals remain absent.
4. Run lint for the changed package/files and `git diff --check`.
5. Review the diff for any browser action API, dynamic selector, arbitrary
   attribute enumeration, credential, or canary enablement.

## Task 4: Update status, commit, and push

**Files:**

- Modify: `docs/mvp-status.md`

1. Record that the first authenticated surface exists and now has bounded v2
   structural evidence, while the live adapter remains closed.
2. Commit the scoped change on `codex/geo-saas-mvp`.
3. Push the existing private development branch.
