# Implementation notes

## Delivery slices

1. Add platform identifiers and versioned platform definitions without changing
   current Ctrip semantics.
2. Add the Trend API seam: observations, freshness, clustering, and candidate
   selection, first in memory and then in the tenant-scoped repository.
3. Keep an evidence-provider port and content-lineage contracts. Reuse the
   current real Pi authoring, media, variant, and audit modules where their
   invariants match. RAG retrieval and knowledge-base integration are deferred;
   the MVP uses the existing immutable fact snapshot only.
4. Extend automation batches so one candidate can fan out to account-final
   targets across platforms while retaining cross-account parallel and
   same-account serial execution.
5. Generalize the Ctrip account-runtime pattern into a platform bridge runtime,
   then implement four fixed adapters in parallel.
6. Add approval polling, independent public readback, native analytics snapshots,
   heat scoring, and daily quota recommendations.
7. Replace the draft overview with the operations console and SSE event feed.
8. Run the four-platform unified canary only after fixed surface evidence exists
   for every adapter.

## TDD seams

Each slice starts with one behavior test at an agreed public seam. Tests use
known observations, content, platform responses, and readback pages. They do
not assert private helper calls or query tables behind an API to infer success.

Platform contract suites share scenarios but not selectors. Every platform
adapter must prove:

- expected account identity is bound to the browser session;
- title, body, media, and disclosure values are read back before submit;
- a challenge, unexpected dialog, or surface drift stops the command;
- a submit timeout returns `uncertain`, never `success`;
- approval is observed separately from submit;
- public readback matches the expected content identity;
- retry classification distinguishes pre-submit from post-submit failures.

## Browser adapter policy

Reference implementations may inform URLs, semantic labels, native upload
flows, and state transitions. Do not adopt shared profiles, cookie files,
private authenticated endpoints, browser fingerprint spoofing, React internals,
DOM state injection, removal of platform safety UI, or fixed sleeps as success
proof. Selectors live in fixed versioned manifests and are promoted only after
surface review.

## Initial capacity profile

- trend collectors: bounded per-source concurrency and ten-minute default
  schedule;
- topic and drafting workers: independent model and token budgets;
- duplicate search: tenant/brand/platform/30-day scope, top 20;
- rewrite budgets: two for duplicate control and two for machine review;
- publication: approximately 50 logical cross-account slots across Browser
  Hosts, one durable profile per account. Profiles are cold disk state; a host
  starts them on demand, defaults to 8 active browser sessions, rejects values
  above a 16-session hard cap, and closes an idle runtime after ten minutes;
- account analytics: hourly source snapshots and one daily heat/quota update;
- dashboard: SSE with five-second polling fallback.

## Deferred interfaces

Keep ports for a future evidence provider, image generation, attribution,
notifications, and short-video content format. RAG retrieval/validation is not
exercised in this MVP. A placeholder port must not be represented as an
implemented capability.
