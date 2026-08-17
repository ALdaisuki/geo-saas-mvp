CREATE OR REPLACE FUNCTION geo.validate_automation_target_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
DECLARE
  batch_execution_level text;
BEGIN
  SELECT batch.execution_level INTO batch_execution_level
  FROM geo.automation_runs AS run
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  WHERE run.tenant_id = NEW.tenant_id
    AND run.id = NEW.run_id
    AND run.state = 'scheduled'
    AND run.stage = 'planning';

  IF NEW.state <> 'pending' OR NEW.variant_id IS NOT NULL OR NEW.audit_run_id IS NOT NULL OR
     NEW.audit_artifact_id IS NOT NULL OR NEW.publication_job_id IS NOT NULL OR
     NEW.last_error_code IS NOT NULL OR NEW.last_error_message IS NOT NULL OR
     NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR
     batch_execution_level IS NULL THEN
    RAISE EXCEPTION 'automation targets must start pending inside a scheduled run'
      USING ERRCODE = '23514';
  END IF;

  IF batch_execution_level = 'unattended' AND (
    NEW.platform <> 'ctrip_community' OR
    geo.ctrip_release_phase(NEW.channel_account_id) <> 'C'
  ) THEN
    RAISE EXCEPTION 'unattended automation targets require a Phase C Ctrip account'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.validate_automation_target_insert() FROM PUBLIC;
