BEGIN;

-- Priority-platform public readback polls for at most ten minutes after the
-- one-shot submit. A temporary not_found keeps the handoff pending so the
-- automatic poller can retry; only an exhausted window becomes needs_review.
CREATE OR REPLACE FUNCTION geo.apply_ctrip_readback_budget()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state = 'readback_pending' AND OLD.state IS DISTINCT FROM 'readback_pending' THEN
    NEW.readback_attempt_count := 0;
    NEW.readback_deadline_at := COALESCE(NEW.submit_observed_at, statement_timestamp()) + interval '10 minutes';
  END IF;
  RETURN NEW;
END
$$;

UPDATE geo.publication_assisted_handoffs AS handoff
SET readback_deadline_at = COALESCE(handoff.submit_observed_at, handoff.updated_at) + interval '10 minutes'
FROM geo.publication_jobs AS job
WHERE job.tenant_id = handoff.tenant_id
  AND job.id = handoff.job_id
  AND handoff.state = 'readback_pending'
  AND job.platform = handoff.platform
  AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease');

CREATE OR REPLACE FUNCTION geo.expire_priority_platform_readback_windows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  expired_handoff geo.publication_assisted_handoffs%ROWTYPE;
  expired_readback geo.publication_readbacks%ROWTYPE;
  expired_job geo.publication_jobs%ROWTYPE;
  expired_count integer := 0;
BEGIN
  FOR expired_handoff IN
    SELECT candidate.*
    FROM geo.publication_assisted_handoffs AS candidate
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = candidate.tenant_id AND job.id = candidate.job_id
    WHERE candidate.tenant_id = tenant_value
      AND candidate.state = 'readback_pending'
      AND candidate.readback_deadline_at <= statement_timestamp()
      AND candidate.external_id IS NULL
      AND candidate.external_url IS NULL
      AND job.platform = candidate.platform
      AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease')
    FOR UPDATE OF candidate SKIP LOCKED
  LOOP
    SELECT * INTO expired_readback
    FROM geo.publication_readbacks AS readback
    WHERE readback.tenant_id = tenant_value
      AND readback.id = expired_handoff.publication_readback_id;

    SELECT * INTO expired_job
    FROM geo.publication_jobs AS publication_job
    WHERE publication_job.tenant_id = tenant_value
      AND publication_job.id = expired_handoff.job_id;

    UPDATE geo.publication_assisted_handoffs AS target
    SET state = 'needs_review',
        readback_outcome = COALESCE(target.readback_outcome, 'not_found'),
        readback_owner_principal_id = NULL,
        readback_lease_expires_at = NULL,
        last_error_code = 'ASSISTED_READBACK_UNCERTAIN',
        last_error_message = '10 分钟公开回读超时，结果不明确，请人工确认'
    WHERE target.tenant_id = tenant_value
      AND target.id = expired_handoff.id;

    IF expired_readback.id IS NOT NULL THEN
      UPDATE geo.publication_readbacks AS target_readback
      SET status = 'failed',
          completed_at = clock_timestamp(),
          last_error = 'ASSISTED_READBACK_UNCERTAIN'
      WHERE target_readback.tenant_id = tenant_value
        AND target_readback.id = expired_handoff.publication_readback_id;
    END IF;

    IF expired_job.id IS NOT NULL THEN
      UPDATE geo.publication_jobs AS target_job
      SET state = 'needs_review',
          confirmed_at = NULL,
          last_error_code = 'ASSISTED_READBACK_UNCERTAIN'
      WHERE target_job.tenant_id = tenant_value
        AND target_job.id = expired_handoff.job_id;
    END IF;

    INSERT INTO geo.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, after_hash, details
    ) VALUES (
      tenant_value, geo.require_actor_id(), 'publication_assisted_handoff.needs_review',
      'publication_assisted_handoff', expired_handoff.id,
      COALESCE(NULLIF(current_setting('app.request_id', true), ''), expired_handoff.id::text),
      expired_handoff.preview_hash,
      jsonb_build_object(
        'reason', 'ten_minute_readback_timeout',
        'readbackDeadlineAt', expired_handoff.readback_deadline_at,
        'attemptCount', expired_handoff.readback_attempt_count,
        'uncertain', true
      )
    );

    expired_count := expired_count + 1;
  END LOOP;

  RETURN expired_count;
END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.claim_next_ctrip_unattended_readback()'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL
     OR position('PERFORM geo.require_ctrip_bridge_principal(actor_value);' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback claim function drifted before 0088';
  END IF;
  IF position('PERFORM geo.expire_priority_platform_readback_windows();' IN function_definition) = 0 THEN
    function_definition := replace(
      function_definition,
      'BEGIN' || E'\n' || '  PERFORM geo.require_ctrip_bridge_principal(actor_value);',
      'BEGIN' || E'\n' ||
        '  PERFORM geo.expire_priority_platform_readback_windows();' || E'\n' ||
        '  PERFORM geo.require_ctrip_bridge_principal(actor_value);'
    );
  END IF;
  IF position('PERFORM geo.expire_priority_platform_readback_windows();' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback expiry hook was not installed';
  END IF;
  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
  retry_block text := $needle$
    next_state := 'needs_review';
    readback_status := 'failed';
    readback_error := CASE p_outcome
      WHEN 'simulation_only' THEN 'SIMULATION_ONLY'
      WHEN 'mismatch' THEN 'ASSISTED_READBACK_MISMATCH'
      ELSE 'ASSISTED_READBACK_NOT_FOUND'
    END;$needle$;
  retry_replacement text := $replacement$
    IF p_outcome IN ('simulation_only', 'mismatch') THEN
      next_state := 'needs_review';
      readback_status := 'failed';
      readback_error := CASE p_outcome
        WHEN 'simulation_only' THEN 'SIMULATION_ONLY'
        ELSE 'ASSISTED_READBACK_MISMATCH'
      END;
    ELSE
      exhausted := next_attempt_count >= 10
        OR p_observed_at >= handoff.readback_deadline_at;
      IF exhausted THEN
        next_state := 'needs_review';
        readback_status := 'failed';
        readback_error := 'ASSISTED_READBACK_UNCERTAIN';
      ELSE
        next_state := 'readback_pending';
        readback_status := 'pending';
        readback_error := 'ASSISTED_READBACK_NOT_FOUND';
      END IF;
    END IF;$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.record_publication_assisted_readback(uuid,text,text,geo.sha256_hex,geo.sha256_hex,text,text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('next_attempt_count >= 60' IN function_definition) = 0
     OR position(retry_block IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback recorder drifted before 0088';
  END IF;
  function_definition := replace(function_definition, 'next_attempt_count >= 60', 'next_attempt_count >= 10');
  function_definition := replace(function_definition, '''attemptLimit'', 60', '''attemptLimit'', 10');
  function_definition := replace(function_definition, retry_block, retry_replacement);
  function_definition := replace(
    function_definition,
    'Public readback budget was exhausted; operator review is required',
    '10 分钟公开回读超时，结果不明确，请人工确认'
  );
  function_definition := replace(
    function_definition,
    'Public publication was not found within the readback window',
    '公开文章暂未出现，系统将在 10 分钟内继续查询'
  );
  IF position('ASSISTED_READBACK_UNCERTAIN' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback uncertain marker was not installed';
  END IF;
  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.reopen_publication_assisted_readback(uuid)'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL
     OR position('interval ''60 minutes''' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'manual readback reopen function drifted before 0088';
  END IF;
  function_definition := replace(
    function_definition,
    'interval ''60 minutes''',
    'interval ''10 minutes'''
  );
  EXECUTE function_definition;
END
$$;

GRANT EXECUTE ON FUNCTION geo.expire_priority_platform_readback_windows() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.reopen_publication_assisted_readback(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Marks priority-platform readback windows that exceeded their ten-minute limit as uncertain needs-review handoffs';

COMMIT;
