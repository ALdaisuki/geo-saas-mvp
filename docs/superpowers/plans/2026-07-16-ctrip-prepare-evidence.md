# Ctrip Prepare Evidence Persistence Plan

**Goal:** Preserve the complete Ctrip Bridge prepare observation across PostgreSQL,
the tenant API and the Publishing queue so a later canary review never depends on a
transient Bridge response.

**Architecture:** PostgreSQL remains the publication state authority. A new
forward-only migration adds a complete prepare evidence group to the existing
tenant-RLS handoff row and replaces the reduced-evidence bridge functions. The
Bridge writes the evidence group in the same transaction as the handoff transition
and audit entry. Repository and Web read models expose the stored values without
reconstructing legacy evidence.

## Invariants

1. A new prepare observation records outcome, evidence kind, top-level evidence
   hash and observed time as one complete group.
2. A prepared draft additionally records the exact ordered media-manifest hash.
3. A blocker never claims a media-manifest hash.
4. The audit row is keyed by the top-level prepare evidence hash, while session,
   draft and media hashes remain independently inspectable.
5. Old rows may retain null prepare evidence; no migration or client fabricates it.
6. The transition trigger permits only the evidence columns required by governed
   functions and keeps request fields immutable.
7. Browser preflight is labelled separately from both Simulator and Live bridge.

## Implementation

1. Add failing migration and Web truthfulness tests.
2. Add migration `0022_ctrip_prepare_evidence.sql`, complete-group constraints,
   replacement security-definer functions, audit details and least-privilege grants.
3. Pass blocker/prepared evidence from the Bridge PostgreSQL control plane.
4. Extend database, API repository and Web types/parsers with the durable fields.
5. Show the bounded prepare evidence identity in the tenant Publishing queue.
6. Update ACL reconciliation and verify the migration against real PostgreSQL.
7. Run the focused suites and full `pnpm verify:mvp` with all temporary paths rooted
   under `D:\GEO\.runtime\tmp`.

## Remaining live gap

This evidence chain supports review but does not enable Ctrip writes. A live canary
still requires written account authorization, reviewed source-controlled fixed
selectors, a write-capable adapter, one supervised low-quota submission and
independent public URL/payload readback.
