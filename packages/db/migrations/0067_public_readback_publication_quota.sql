BEGIN;

-- Daily publication capacity represents articles independently confirmed by
-- public readback. Dispatch retries and failed or uncertain attempts remain
-- relevant to rate limits and error budgets, but do not consume perDay.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'publication acquire function is unavailable before 0067';
  END IF;

  IF position('count(DISTINCT readback.job_id)' IN function_definition) = 0 THEN
    IF position(
      'count(*) FILTER (WHERE attempt.started_at >= now_value - interval ''1 day'')'
      IN function_definition
    ) = 0 THEN
      RAISE EXCEPTION 'publication daily quota counter drifted before 0067';
    END IF;
    function_definition := replace(
      function_definition,
      $needle$count(*) FILTER (WHERE attempt.started_at >= now_value - interval '1 day')$needle$,
      $replacement$(
          SELECT count(DISTINCT readback.job_id)
          FROM geo.publication_readbacks AS readback
          JOIN geo.publication_jobs AS readback_job
            ON readback_job.tenant_id = readback.tenant_id
           AND readback_job.id = readback.job_id
          JOIN geo.publication_variants AS readback_variant
            ON readback_variant.tenant_id = readback_job.tenant_id
           AND readback_variant.id = readback_job.variant_id
          JOIN geo.content_versions AS readback_version
            ON readback_version.tenant_id = readback_variant.tenant_id
           AND readback_version.id = readback_variant.content_version_id
          JOIN geo.content_items AS readback_item
            ON readback_item.tenant_id = readback_version.tenant_id
           AND readback_item.id = readback_version.content_item_id
          WHERE readback.tenant_id = tenant_value
            AND readback.required
            AND readback.status = 'succeeded'
            AND readback.completed_at >= now_value - interval '1 day'
            AND (
              control_row.scope_type = 'tenant'
              OR (control_row.scope_type = 'platform'
                  AND readback_job.platform = control_row.scope_key)
              OR (control_row.scope_type = 'account'
                  AND readback_job.channel_account_id::text = control_row.scope_key)
              OR (control_row.scope_type = 'campaign'
                  AND readback_item.campaign_id::text = control_row.scope_key)
              OR (control_row.scope_type = 'topic'
                  AND readback_item.topic_key = control_row.scope_key)
            )
        )$replacement$
    );
  END IF;

  IF position('count(DISTINCT readback.job_id)' IN function_definition) = 0
     OR position('readback.status = ''succeeded''' IN function_definition) = 0
     OR position('readback.required' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication daily quota counter was not patched by 0067';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMIT;
