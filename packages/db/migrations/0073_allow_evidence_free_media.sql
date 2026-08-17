BEGIN;

-- Licensed or tenant-owned scene media can be governed by rights evidence,
-- relevance inspection, and immutable provenance without claiming that the
-- image proves a brand fact. Existing fact-bound media remains limited to
-- three exact verified claims.
ALTER TABLE geo.media_generation_jobs
  DROP CONSTRAINT media_generation_jobs_fact_ids_check,
  ADD CONSTRAINT media_generation_jobs_fact_ids_count
    CHECK (cardinality(fact_ids) BETWEEN 0 AND 3);

ALTER TABLE geo.media_assets
  DROP CONSTRAINT media_assets_governed_shape,
  ADD CONSTRAINT media_assets_governed_shape CHECK (
    source_class = 'legacy' OR (
      job_id IS NOT NULL AND content_version_id IS NOT NULL AND
      byte_length > 0 AND width > 0 AND height > 0 AND
      platform IS NOT NULL AND role IS NOT NULL AND
      cardinality(fact_ids) BETWEEN 0 AND 3 AND
      visual_brief IS NOT NULL AND visual_brief_hash IS NOT NULL
    )
  );

COMMIT;
