---
project: geo-saas-mvp
date: 2026-07-18
status: accepted-for-implementation
tags: [pi-agent, authored-drafts, geo, provenance, audit]
---

# Real Pi Authored Drafts

## Problem

The real Pi runtime currently orchestrates the drafting tools, but
`geo_draft_proposal` has no model-authored content input. The API therefore
renders the deterministic editorial source template even when the provider is
real. This creates a false impression that Pi wrote the article.

## Design

Real Pi drafting accepts a structured authored draft:

- title and summary are model-written strings with their own supporting fact IDs;
- body is an ordered list of model-written paragraphs, each with supporting
  verified fact IDs;
- contacts are never supplied as free text and are appended by the server from
  the current tenant contact snapshot;
- the selected article template remains metadata and a prompt contract
  (scenario, outline, GEO mechanisms, evidence requirements, and risk
  boundaries), not a source of prose;
- the server rejects unknown, stale, or out-of-snapshot fact IDs and stores the
  authored text plus provenance in the canonical content payload.

The canonical payload gains `authored` blocks. Each block carries its text and
the claim IDs that justify it. The renderer resolves claims and contacts from
the immutable snapshots, while audit remains the authority for prohibited
claims, contact accuracy, freshness, platform limits, and GEO quality. A
missing supporting fact ID is a blocking finding for an authored block.

Fixture mode keeps the existing deterministic source renderer so it remains a
test double and is explicitly reported as `fixture`.

## Runtime flow

```text
Pi reads tenant context/template/profile/facts
  -> Pi writes structured title/summary/body with fact IDs
  -> geo_draft_proposal validates authored draft and snapshots facts/contacts
  -> canonical content version is persisted
  -> platform variant -> deterministic audit -> assisted handoff
```

## Boundaries

- No provider key or endpoint is hard-coded. Real mode is enabled only through
  the existing model configuration.
- A model response without a successful `geo_draft_proposal` is not a draft.
- The model cannot select contacts, publication grants, or a publish action.
- Ctrip remains draft-prepared/assisted; this change does not click Publish.
- Images remain a separate governed media capability and are not represented as
  model-written article prose.

## Acceptance criteria

- A real-provider test proves the model calls `geo_draft_proposal` with
  authored content and that the persisted payload contains authored blocks.
- The fixture test proves it still uses the deterministic template path.
- Unknown fact IDs and authored blocks without support are rejected.
- Existing canonical source and platform variant tests remain green.
- Configuration and capability output distinguish `fixture` from `pi`.
