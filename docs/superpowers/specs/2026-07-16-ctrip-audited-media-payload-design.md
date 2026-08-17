# Ctrip Audited Media Payload Design

## Decision

Extend the fixed Ctrip Bridge prepare path with tenant-scoped, content-addressed
media loading. The Bridge will fail closed unless every media reference in the
already audited publication payload resolves to the exact bound database asset,
passed inspection and stored bytes. This increment remains simulator-only.

## Invariants

- PostgreSQL remains the publication and media-metadata truth source.
- The payload media array defines the required attachment set and order.
- Every database asset must match tenant, content version, binding position,
  SHA-256, MIME type, byte length, dimensions, platform, role and the full
  canonical `MediaReference`.
- The latest inspection for the exact asset SHA-256 must be `passed`.
- `ContentAddressedMediaStore` must verify the tenant-scoped key and actual
  bytes; the Bridge additionally verifies audited byte length and SHA-256.
- Missing or invalid media blocks `prepare` before adapter work or durable draft
  evidence.
- `submit` and `readback` never read local media and remain available for durable
  reconciliation after a successful prepare.
- Simulator media is local preview material only and never publication evidence.

## Data Flow

```text
prepare command
  -> load and verify handoff + audited preview
  -> load ordered media rows through tenant transaction
     -> publication variant content_version_id
     -> content_media_bindings position/platform/role
     -> append-only media_assets metadata
     -> latest media_inspections for exact asset SHA
  -> canonical MediaReference equality check
  -> ContentAddressedMediaStore.get(tenant, storage_key)
  -> byte length + SHA-256 check
  -> immutable trusted attachments
  -> fixed simulator adapter prepare
     -> ordered media manifest hash in draft evidence
     -> authenticated simulator HTML with actual images
  -> record prepared evidence
```

## Contracts

`CtripBridgeHandoffDraft` gains `contentVersionId`. The control plane gains a
prepare-only media loader returning ordered asset records with binding position,
storage key and reconstructed reference. `CtripBridgeCommandService` receives a
read-only media object store and converts those records to
`CtripTrustedMediaAttachment` values containing the audited reference and a
defensive byte copy.

`CtripFixedAdapter.prepare` receives the attachments. `submit` and `readback`
retain their existing signatures so their behavior cannot accidentally acquire a
storage dependency.

## Evidence

The adapter builds `geo.ctrip-media-manifest.v1` from the payload hash and ordered
reference metadata. Its canonical hash is included in the simulator draft
material and therefore in `draftEvidenceHash` and the returned prepare evidence.
No bytes or base64 payloads are written to PostgreSQL.

## Runtime

The Bridge requires `GEO_MEDIA_OBJECT_ROOT`, creates a
`ContentAddressedMediaStore` and mounts the same `media-data` volume used by the
API. The Docker build includes `@geo/media` as a Bridge dependency.

## Non-goals

- Ctrip login, Playwright selectors, uploads, submit clicks or public readback.
- Generating images; the current API remains fixture/existing-asset capable.
- Media retries during submit or reconciliation.
- Treating the local Simulator view as proof of external publication.

## Acceptance Criteria

- A media-bearing audited payload prepares with exact stored bytes and renders
  the actual image in the authenticated Simulator.
- Reordered, cross-version, changed, failed-inspection, missing or corrupt media
  fails before adapter prepare and before `recordPrepared`.
- Prepare evidence changes with the ordered media manifest.
- A prepared handoff can still submit and read back if local media later becomes
  unavailable.
- Compose and CLI supply the shared media root without client-selectable paths.
