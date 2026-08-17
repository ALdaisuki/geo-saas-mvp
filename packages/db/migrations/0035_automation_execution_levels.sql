ALTER TABLE geo.automation_batches
  DROP CONSTRAINT automation_batches_execution_level_check;

ALTER TABLE geo.automation_batches
  ADD CONSTRAINT automation_batches_execution_level_check
  CHECK (execution_level IN ('dry_run', 'assisted', 'unattended'));

CREATE OR REPLACE FUNCTION geo.validate_automation_batch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state <> 'scheduled' OR
     NEW.execution_level NOT IN ('dry_run', 'assisted', 'unattended') OR
     NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
     NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by_actor_id IS NOT NULL OR
     NEW.cancellation_reason IS NOT NULL THEN
    RAISE EXCEPTION 'automation batches must be inserted as unsullied scheduled runs'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.validate_automation_run_insert()'::regprocedure)
  INTO definition;
  updated_definition := replace(
    definition,
    'AND batch.execution_level = ''dry_run''',
    'AND batch.execution_level IN (''dry_run'', ''assisted'', ''unattended'')'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'validate_automation_run_insert execution-level gate was not found';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef('geo.claim_automation_runs(text,integer,integer)'::regprocedure)
  INTO definition;
  updated_definition := replace(
    definition,
    'AND batch.execution_level = ''dry_run''',
    'AND batch.execution_level IN (''dry_run'', ''assisted'', ''unattended'')'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'claim_automation_runs execution-level gate was not found';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    'AND job.execution_level = ''dry_run''',
    'AND job.execution_level = (' ||
    'SELECT batch.execution_level FROM geo.automation_batches AS batch ' ||
    'WHERE batch.tenant_id = tenant_value AND batch.id = run_row.batch_id)'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'checkpoint_automation_target execution-level binding was not found';
  END IF;
  EXECUTE updated_definition;
END
$$;

REVOKE ALL ON FUNCTION geo.validate_automation_batch_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.validate_automation_run_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.claim_automation_runs(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.checkpoint_automation_target(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, uuid, text, text, jsonb, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_target(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, uuid, text, text, jsonb, integer
) TO geo_runtime;
