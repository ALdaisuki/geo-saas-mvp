# Ctrip Audited Media Payload Plan

1. Add failing Bridge tests for exact ordered media loading, byte verification,
   failed inspection rejection, Simulator image rendering and prepare-only
   storage access.
2. Extend Bridge contracts with content-version identity, ordered database media
   assets and immutable trusted attachments.
3. Rebuild complete media references in the PostgreSQL control plane from
   `media_assets`, `content_media_bindings` and latest exact-SHA inspections.
4. Verify canonical references and actual bytes in the command service, then pass
   attachments only to adapter `prepare`.
5. Bind an ordered media manifest hash into Simulator draft evidence and display
   the real image bytes in the authenticated local Simulator view.
6. Require `GEO_MEDIA_OBJECT_ROOT`, add `@geo/media` to the Bridge build and mount
   the shared `media-data` volume in the simulator profile.
7. Run focused Bridge tests, type checking and full `pnpm verify:mvp` with all
   temporary paths rooted outside C drive.
8. Commit and push the verified branch to the existing private Draft PR.
