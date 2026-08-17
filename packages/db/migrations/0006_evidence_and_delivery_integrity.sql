ALTER TABLE geo.evidence_sources
  ADD COLUMN content_text text;

ALTER TABLE geo.evidence_sources
  ADD CONSTRAINT evidence_sources_content_hash_matches
  CHECK (
    content_text IS NULL OR
    encode(public.digest(content_text, 'sha256'), 'hex') = content_hash::text
  );

CREATE TRIGGER evidence_sources_append_only
BEFORE UPDATE OR DELETE ON geo.evidence_sources
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.campaigns
  ADD CONSTRAINT campaigns_tenant_id_id_brand_unique
  UNIQUE (tenant_id, id, brand_id);

ALTER TABLE geo.content_items
  ADD CONSTRAINT content_items_campaign_brand_fk
  FOREIGN KEY (tenant_id, campaign_id, brand_id)
  REFERENCES geo.campaigns (tenant_id, id, brand_id) ON DELETE RESTRICT;

ALTER TABLE geo.publication_jobs
  ADD COLUMN preview_completed_at timestamptz;

ALTER TABLE geo.publication_jobs
  DROP CONSTRAINT publication_jobs_state_check;

ALTER TABLE geo.publication_jobs
  DROP CONSTRAINT publication_jobs_check;

UPDATE geo.publication_jobs
SET state = 'preview_completed',
    preview_completed_at = confirmed_at,
    confirmed_at = NULL
WHERE execution_level = 'dry_run' AND state = 'confirmed';

ALTER TABLE geo.publication_jobs
  ADD CONSTRAINT publication_jobs_state_check
  CHECK (
    state IN (
      'queued', 'dispatching', 'retry_wait', 'uncertain', 'reconciling',
      'preview_completed', 'confirmed', 'needs_review', 'permanent_failure', 'cancelled'
    )
  );

ALTER TABLE geo.publication_jobs
  ADD CONSTRAINT publication_jobs_dry_run_not_confirmed
  CHECK (execution_level <> 'dry_run' OR state <> 'confirmed');

ALTER TABLE geo.publication_jobs
  ADD CONSTRAINT publication_jobs_completion_timestamps
  CHECK (
    (state = 'confirmed') = (confirmed_at IS NOT NULL) AND
    (state = 'preview_completed') = (preview_completed_at IS NOT NULL)
  );

ALTER TABLE geo.publication_receipts
  ADD CONSTRAINT publication_receipts_dry_run_is_preview
  CHECK (
    execution_level <> 'dry_run' OR (
      confirmed = false AND
      external_id IS NULL AND
      external_url IS NULL AND
      published_at IS NULL AND
      evidence_type IN ('fixture', 'preview')
    )
  );

REVOKE UPDATE, DELETE ON geo.evidence_sources FROM geo_runtime;
