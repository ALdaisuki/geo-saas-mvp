BEGIN;

-- Deleting a channel account is blocked by ON DELETE RESTRICT references from
-- automation_run_targets even when those targets are terminal and carry no
-- audit artifact or publication job. This operator-only helper removes exactly
-- those abandoned targets and fails closed when real delivery history remains.
CREATE OR REPLACE FUNCTION geo.purge_abandoned_channel_account_automation_targets(
  p_channel_account_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  removed integer := 0;
  remaining integer := 0;
BEGIN
  DELETE FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.channel_account_id = p_channel_account_id
    AND target.audit_run_id IS NULL
    AND target.audit_artifact_id IS NULL
    AND target.publication_job_id IS NULL;
  GET DIAGNOSTICS removed = ROW_COUNT;

  SELECT count(*) INTO remaining
  FROM geo.automation_run_targets AS target
  WHERE target.tenant_id = tenant_value
    AND target.channel_account_id = p_channel_account_id;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'channel account still has automation delivery targets'
      USING ERRCODE = '23503';
  END IF;

  RETURN removed;
END
$$;

REVOKE ALL ON FUNCTION geo.purge_abandoned_channel_account_automation_targets(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.purge_abandoned_channel_account_automation_targets(uuid)
  TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.purge_abandoned_channel_account_automation_targets(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'abandoned automation target purge ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
