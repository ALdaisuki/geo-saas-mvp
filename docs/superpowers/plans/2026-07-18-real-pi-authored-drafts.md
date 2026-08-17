# Real Pi Authored Drafts Implementation Plan

> **Execution note:** implement in the existing `codex/geo-saas-mvp` worktree.

## 1. Extend canonical authored blocks

- Add strict inline/body `authored` schemas with bounded text and non-empty
  supporting `claimIds`.
- Update canonical content rendering to output authored text and validate all
  referenced claims against the fact snapshot.
- Keep fixture source payloads unchanged.

## 2. Accept model-authored draft input

- Add `authoredDraft` to `DraftProposalInput`, MCP zod/typebox schemas, and
  tool dispatch.
- In `proposeDraft`, validate the model's IDs against the selected current
  facts, render contact blocks server-side, and persist authored title,
  summary, and body blocks with claim metadata.
- Reject empty authored content and unsupported claim IDs.

## 3. Make the real Pi workflow use the contract

- Add a structured `draft_to_publication` input for `RealPiAgentRunService`.
- Give Pi an explicit authoring contract: inspect tools first, write original
  Chinese prose, attach supporting fact IDs per segment, then call
  `geo_draft_proposal`.
- Return the persisted IDs and provider metadata so the UI can distinguish an
  authored draft from a fixture draft.

## 4. Tests and verification

- Add contract and renderer tests for authored blocks and unsupported claims.
- Add HTTP client and Pi runner tests proving model-authored text reaches the
  persisted payload.
- Run package tests, typechecks, and the existing customer demo verification.
