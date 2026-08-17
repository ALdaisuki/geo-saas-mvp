---
status: draft
---

# Audited Media Payload Pattern

## Problem Solved

An audited publication payload contains media references, but those references do
not prove that the bridge can still access the same bytes at prepare time. A
publisher must reject missing, cross-tenant, changed, uninspected or reordered
assets before an external draft is created.

## Reusable Pattern

The existing manual publication package provides the local exemplar:

1. Rebuild each complete `MediaReference` from append-only `media_assets` and the
   latest matching `media_inspections` row.
2. Match the rebuilt reference to the audited payload by canonical hash, not by
   asset ID alone.
3. Read bytes through `ContentAddressedMediaStore`, which enforces tenant-scoped
   canonical keys and verifies the key SHA-256.
4. Independently check byte length and SHA-256 against the audited reference.
5. Preserve payload order in a media manifest and bind its canonical hash into
   the publication evidence.

This closes both metadata substitution and storage corruption paths. The content
version binding additionally proves that an otherwise valid tenant asset belongs
to the article being prepared.

## Bridge Adaptation

The Ctrip bridge should load media only for `prepare`. It receives database media
rows from its tenant-scoped control plane, validates exact order and content
version bindings, reads the bytes from the shared content-addressed volume and
passes immutable trusted attachments to the fixed adapter. The simulator may
render those attachments as data URLs inside its authenticated local view.

`submit` and `readback` must not reload media. At that point the prepared draft,
preview hash, media-bound evidence and PostgreSQL handoff are the durable inputs;
requiring local bytes again would turn storage loss into a duplicate-submit or
failed-reconciliation hazard.

## Not Directly Reusable

- The manual package base64 export format is for offline transfer. The Bridge
  should pass byte arrays in process and must not persist duplicate base64 data.
- A manual package is `dry_run`; its manifest cannot authorize assisted submit.
- The storage-key hash check alone is insufficient. Database metadata, content
  binding, platform, role, inspection status and payload order must also match.
- Simulator HTML is not platform evidence and can never confirm publication.
