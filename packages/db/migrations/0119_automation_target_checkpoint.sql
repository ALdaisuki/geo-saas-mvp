BEGIN;

-- The automation run target view exposes the per-target checkpoint, but the
-- schema never persisted it. Keep the latest target checkpoint alongside the
-- run checkpoint so operator dashboards and resume flows can read the exact
-- state that produced the target transition.
ALTER TABLE geo.automation_run_targets
  ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(checkpoint) = 'object');

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL OR position(
    'publication_job_id = publication_job_value,'
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint function drifted before 0119';
  END IF;

  function_definition := replace(
    function_definition,
    $needle$      publication_job_id = publication_job_value,$needle$,
    $replacement$      publication_job_id = publication_job_value,
      checkpoint = p_checkpoint,$replacement$
  );

  IF position(
    'checkpoint = p_checkpoint' IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint was not patched by 0119';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMIT;
