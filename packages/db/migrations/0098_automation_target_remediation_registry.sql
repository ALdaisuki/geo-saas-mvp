-- Keep the latest bounded remediation plan with its target. A run checkpoint is
-- intentionally transient and advances as other targets are processed, so it
-- cannot be the durable source for target-level operator status.
ALTER TABLE geo.automation_run_targets
  ADD COLUMN remediation jsonb
  CHECK (remediation IS NULL OR jsonb_typeof(remediation) = 'object');

-- A remedial draft produces a distinct, freshly audited platform variant. The
-- original function only allowed a target to bind the run-wide content version,
-- which made a target-level remediation impossible to checkpoint. Keep the
-- existing delivery semantics intact and relax only a same-state variant update
-- that carries an explicit server remediation plan and has not been published.
DO $$
DECLARE
  function_definition text;
  variant_conflict_needle text := $needle$IF (target_row.variant_id IS NOT NULL AND p_variant_id IS NOT NULL AND
      target_row.variant_id <> p_variant_id) OR$needle$;
  variant_conflict_replacement text := $replacement$IF (target_row.variant_id IS NOT NULL AND p_variant_id IS NOT NULL AND
      target_row.variant_id <> p_variant_id AND NOT (
        p_new_state = 'variant_ready'
        AND target_row.state = 'variant_ready'
        AND target_row.publication_job_id IS NULL
        AND jsonb_typeof(p_checkpoint -> 'remediation') = 'object'
      )) OR$replacement$;
  run_content_binding_needle text := $needle$      AND variant.content_version_id = run_row.content_version_id
$needle$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position(variant_conflict_needle IN function_definition) = 0
     OR position(run_content_binding_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint function drifted before 0097';
  END IF;

  function_definition := replace(
    function_definition,
    variant_conflict_needle,
    variant_conflict_replacement
  );
  function_definition := replace(
    function_definition,
    run_content_binding_needle,
    ''
  );
  EXECUTE function_definition;
END
$$;

CREATE OR REPLACE FUNCTION geo.capture_automation_target_remediation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.checkpoint ->> 'stage' = 'target'
     AND jsonb_typeof(NEW.checkpoint -> 'remediation') = 'object'
     AND NEW.checkpoint ? 'targetId' THEN
    UPDATE geo.automation_run_targets AS target
    SET remediation = NEW.checkpoint -> 'remediation'
    WHERE target.tenant_id = NEW.tenant_id
      AND target.run_id = NEW.id
      AND target.id::text = NEW.checkpoint ->> 'targetId';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER automation_runs_capture_target_remediation
  AFTER INSERT OR UPDATE OF checkpoint ON geo.automation_runs
  FOR EACH ROW
  EXECUTE FUNCTION geo.capture_automation_target_remediation();

-- Preserve the most recently persisted remediation entry for runs written
-- before this migration; no broad historical inference is attempted.
UPDATE geo.automation_run_targets AS target
SET remediation = run.checkpoint -> 'remediation'
FROM geo.automation_runs AS run
WHERE run.tenant_id = target.tenant_id
  AND run.id = target.run_id
  AND run.checkpoint ->> 'stage' = 'target'
  AND run.checkpoint ->> 'targetId' = target.id::text
  AND jsonb_typeof(run.checkpoint -> 'remediation') = 'object';

REVOKE ALL ON FUNCTION geo.capture_automation_target_remediation() FROM PUBLIC;
