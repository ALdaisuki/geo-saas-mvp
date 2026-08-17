-- A manual media decision is a content-version gate, not an audit failure or
-- delivery retry. Keep the run visible as active while making it ineligible
-- for another worker lease until an operator confirms that exact version.
BEGIN;

ALTER TABLE geo.automation_runs
  DROP CONSTRAINT automation_runs_state_check;

ALTER TABLE geo.automation_runs
  ADD CONSTRAINT automation_runs_state_check
  CHECK (state IN (
    'scheduled', 'running', 'retry_wait', 'awaiting_manual_review',
    'awaiting_delivery', 'completed', 'partially_failed', 'delivery_failed',
    'blocked', 'failed', 'cancelled'
  ));

ALTER TABLE geo.automation_run_targets
  DROP CONSTRAINT automation_run_targets_state_check;

ALTER TABLE geo.automation_run_targets
  ADD CONSTRAINT automation_run_targets_state_check
  CHECK (state IN (
    'pending', 'variant_ready', 'audit_failed', 'awaiting_manual_review',
    'awaiting_delivery', 'preview_completed', 'confirmed', 'delivery_failed',
    'blocked', 'failed', 'cancelled'
  ));

DO $checkpoint$
DECLARE
  definition text;
  updated_definition text;
  valid_states text := $needle$       'pending', 'variant_ready', 'audit_failed', 'awaiting_delivery',
       'preview_completed', 'confirmed', 'delivery_failed', 'blocked', 'failed', 'cancelled'$needle$;
  pending_transition text := $needle$    (target_row.state = 'pending' AND
     p_new_state IN ('variant_ready', 'blocked', 'failed', 'cancelled')) OR$needle$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO definition;
  IF definition IS NULL OR position(valid_states IN definition) = 0
     OR position(pending_transition IN definition) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint function drifted before manual review pause';
  END IF;

  updated_definition := replace(
    definition,
    valid_states,
    $replacement$       'pending', 'variant_ready', 'audit_failed', 'awaiting_manual_review',
       'awaiting_delivery', 'preview_completed', 'confirmed', 'delivery_failed', 'blocked', 'failed', 'cancelled'$replacement$
  );
  updated_definition := replace(
    updated_definition,
    pending_transition,
    $replacement$    (target_row.state = 'pending' AND
     p_new_state IN ('variant_ready', 'awaiting_manual_review', 'blocked', 'failed', 'cancelled')) OR$replacement$
  );
  EXECUTE updated_definition;
END
$checkpoint$;

DO $reconcile$
DECLARE
  definition text;
  updated_definition text;
  declaration_needle text := E'  awaiting_count integer;\n  success_count integer;';
  count_needle text := $needle$         count(*) FILTER (WHERE target.state = 'awaiting_delivery')::integer,
         count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer,$needle$;
  into_needle text := $needle$  INTO target_count, unfinished_count, awaiting_count, success_count, failure_count, delivery_failure_count$needle$;
  branch_needle text := $needle$  IF awaiting_count > 0 THEN$needle$;
  error_needle text := $needle$    WHEN next_state = 'awaiting_delivery' THEN NULL$needle$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.reconcile_automation_run(uuid,text,integer,integer,text,text)'::regprocedure
  ) INTO definition;
  IF definition IS NULL
     OR position(declaration_needle IN definition) = 0
     OR position(count_needle IN definition) = 0
     OR position(into_needle IN definition) = 0
     OR position(branch_needle IN definition) = 0
     OR position(error_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'automation reconciliation function drifted before manual review pause';
  END IF;

  updated_definition := replace(
    definition,
    declaration_needle,
    E'  awaiting_count integer;\n  manual_review_count integer;\n  success_count integer;'
  );
  updated_definition := replace(
    updated_definition,
    count_needle,
    $replacement$         count(*) FILTER (WHERE target.state = 'awaiting_delivery')::integer,
         count(*) FILTER (WHERE target.state = 'awaiting_manual_review')::integer,
         count(*) FILTER (WHERE target.state IN ('preview_completed', 'confirmed'))::integer,$replacement$
  );
  updated_definition := replace(
    updated_definition,
    into_needle,
    $replacement$  INTO target_count, unfinished_count, awaiting_count, manual_review_count, success_count, failure_count, delivery_failure_count$replacement$
  );
  updated_definition := replace(
    updated_definition,
    branch_needle,
    $replacement$  IF manual_review_count > 0 THEN
    next_state := 'awaiting_manual_review';
    available_value := run_row.available_at;
    completed_value := NULL;
  ELSIF awaiting_count > 0 THEN$replacement$
  );
  updated_definition := replace(
    updated_definition,
    error_needle,
    $replacement$    WHEN next_state IN ('awaiting_manual_review', 'awaiting_delivery') THEN NULL$replacement$
  );
  EXECUTE updated_definition;
END
$reconcile$;

DO $batch$
DECLARE
  definition text;
  updated_definition text;
  active_states text := $needle$'scheduled', 'running', 'retry_wait', 'awaiting_delivery'$needle$;
BEGIN
  SELECT pg_get_functiondef('geo.refresh_automation_batch_state(uuid)'::regprocedure)
  INTO definition;
  IF definition IS NULL OR position(active_states IN definition) = 0 THEN
    RAISE EXCEPTION 'automation batch refresh function drifted before manual review pause';
  END IF;
  updated_definition := replace(
    definition,
    active_states,
    $replacement$'scheduled', 'running', 'retry_wait', 'awaiting_manual_review', 'awaiting_delivery'$replacement$
  );
  EXECUTE updated_definition;
END
$batch$;

CREATE OR REPLACE FUNCTION geo.resume_automation_runs_after_manual_media_review(
  p_content_version_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  resumed_count integer := 0;
  affected_batch_ids uuid[];
  affected_batch_id uuid;
BEGIN
  PERFORM geo.require_actor_id();
  IF NOT EXISTS (
    SELECT 1
    FROM geo.manual_media_reviews AS review
    WHERE review.tenant_id = tenant_value
      AND review.content_version_id = p_content_version_id
      AND review.status = 'confirmed'
  ) THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('automation:' || tenant_value::text, 0));

  WITH resumed_targets AS (
    UPDATE geo.automation_run_targets AS target
    SET state = 'pending',
        completed_at = NULL,
        last_error_code = NULL,
        last_error_message = NULL
    FROM geo.automation_runs AS run
    WHERE target.tenant_id = tenant_value
      AND target.tenant_id = run.tenant_id
      AND target.run_id = run.id
      AND run.content_version_id = p_content_version_id
      AND run.state = 'awaiting_manual_review'
      AND target.state = 'awaiting_manual_review'
    RETURNING target.run_id
  ), resumed_runs AS (
    UPDATE geo.automation_runs AS run
    SET state = 'scheduled',
        stage = 'targets',
        available_at = clock_timestamp(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        completed_at = NULL,
        last_error_code = NULL,
        last_error_message = NULL
    WHERE run.tenant_id = tenant_value
      AND run.content_version_id = p_content_version_id
      AND run.state = 'awaiting_manual_review'
      AND EXISTS (
        SELECT 1
        FROM resumed_targets AS target
        WHERE target.run_id = run.id
      )
    RETURNING run.batch_id
  )
  SELECT count(*)::integer, array_agg(DISTINCT batch_id)
  INTO resumed_count, affected_batch_ids
  FROM resumed_runs;

  IF affected_batch_ids IS NOT NULL THEN
    FOREACH affected_batch_id IN ARRAY affected_batch_ids LOOP
      PERFORM geo.refresh_automation_batch_state(affected_batch_id);
    END LOOP;
  END IF;

  RETURN resumed_count;
END
$$;

REVOKE ALL ON FUNCTION geo.resume_automation_runs_after_manual_media_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.resume_automation_runs_after_manual_media_review(uuid) TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.resume_automation_runs_after_manual_media_review(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'manual media review resume ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
