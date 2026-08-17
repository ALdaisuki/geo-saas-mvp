BEGIN;

-- Keep the generic publication lineage aligned with the P0 article platforms.
-- Ctrip-only runtime, handoff, analytics, canary, and history tables remain
-- constrained to ctrip_community by their original migrations.
ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT channel_accounts_platform_check,
  ADD CONSTRAINT channel_accounts_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_platform_check,
  ADD CONSTRAINT automation_run_targets_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.media_generation_jobs
  DROP CONSTRAINT media_generation_jobs_platform_check,
  ADD CONSTRAINT media_generation_jobs_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.media_assets
  DROP CONSTRAINT media_assets_platform,
  ADD CONSTRAINT media_assets_platform
    CHECK (
      platform IS NULL OR
      platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')
    );

ALTER TABLE geo.content_media_bindings
  DROP CONSTRAINT content_media_bindings_platform_check,
  ADD CONSTRAINT content_media_bindings_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.publication_variants
  DROP CONSTRAINT publication_variants_platform_check,
  ADD CONSTRAINT publication_variants_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.audit_artifacts
  DROP CONSTRAINT audit_artifacts_platform_check,
  ADD CONSTRAINT audit_artifacts_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.publication_grants
  DROP CONSTRAINT publication_grants_platform_check,
  ADD CONSTRAINT publication_grants_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.publication_jobs
  DROP CONSTRAINT publication_jobs_platform_check,
  ADD CONSTRAINT publication_jobs_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

ALTER TABLE geo.publication_receipts
  DROP CONSTRAINT publication_receipts_platform_check,
  ADD CONSTRAINT publication_receipts_platform_check
    CHECK (platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community'));

COMMIT;
