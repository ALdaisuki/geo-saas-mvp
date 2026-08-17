BEGIN;

-- Keep the reassignment guard aligned with batch creation: only a required
-- publication with a successful public readback consumes daily capacity.
DO $$
DECLARE
  function_definition text;
  old_quota_block text;
  new_quota_block text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.reassign_pending_automation_target(uuid,uuid,uuid)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'automation reassignment function is unavailable before 0096';
  END IF;
  old_quota_block := $old$
    SELECT count(*)::integer
    INTO existing_count
    FROM geo.automation_run_targets AS target
    JOIN geo.automation_runs AS run
      ON run.tenant_id = target.tenant_id AND run.id = target.run_id
    JOIN geo.automation_batches AS batch
      ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
    WHERE target.tenant_id = tenant_value
      AND target.channel_account_id = p_channel_account_id
      AND target.id <> p_target_id
      AND target.state <> 'cancelled'
      AND run.state <> 'cancelled'
      AND batch.state <> 'cancelled'
      AND batch.execution_level <> 'dry_run'
      AND (run.available_at AT TIME ZONE account_row.quota_timezone)::date = quota_date;
$old$;
  new_quota_block := $new$
    SELECT count(DISTINCT readback.job_id)::integer
    INTO existing_count
    FROM geo.automation_run_targets AS target
    JOIN geo.automation_runs AS run
      ON run.tenant_id = target.tenant_id AND run.id = target.run_id
    JOIN geo.automation_batches AS batch
      ON batch.tenant_id = run.tenant_id AND batch.id = run.batch_id
    JOIN geo.publication_readbacks AS readback
      ON readback.tenant_id = target.tenant_id AND readback.job_id = target.publication_job_id
    WHERE target.tenant_id = tenant_value
      AND target.channel_account_id = p_channel_account_id
      AND target.id <> p_target_id
      AND batch.execution_level <> 'dry_run'
      AND readback.required
      AND readback.status = 'succeeded'
      AND (readback.completed_at AT TIME ZONE account_row.quota_timezone)::date = quota_date;
$new$;
  IF position('count(DISTINCT readback.job_id)' IN function_definition) = 0 THEN
    IF position(old_quota_block IN function_definition) = 0 THEN
      RAISE EXCEPTION 'automation reassignment quota counter drifted before 0096';
    END IF;
    function_definition := replace(function_definition, old_quota_block, new_quota_block);
    EXECUTE function_definition;
  END IF;
END
$$;

ALTER TABLE geo.channel_accounts
  ALTER COLUMN daily_publish_quota SET DEFAULT 30;

-- Accounts still carrying the original default inherit the new default. Any
-- account with a deliberate custom quota remains untouched.
UPDATE geo.channel_accounts
SET daily_publish_quota = 30
WHERE daily_publish_quota = 10;

COMMIT;
