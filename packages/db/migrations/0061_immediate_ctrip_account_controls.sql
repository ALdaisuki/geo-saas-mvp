BEGIN;

CREATE OR REPLACE FUNCTION geo.sync_channel_account_capacity_control()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  default_mode text := CASE
    WHEN NEW.platform = 'ctrip_community'
         AND NEW.capability = 'browser_assisted'
         AND NEW.status = 'active'
         AND 'unattended' = ANY(NEW.supported_execution_levels)
      THEN 'unattended'
    WHEN NEW.platform = 'ctrip_community' AND NEW.capability = 'browser_assisted'
      THEN 'supervised'
    ELSE 'shadow'
  END;
BEGIN
  INSERT INTO geo.automation_controls (
    tenant_id, id, scope_type, scope_key, mode, quota, kill_switch_enabled, reason
  ) VALUES (
    NEW.tenant_id,
    gen_random_uuid(),
    'account',
    NEW.id::text,
    default_mode,
    jsonb_build_object(
      'maxConcurrent', NEW.max_concurrent_publications,
      'perDay', NEW.daily_publish_quota
    ),
    false,
    'Default per-account publication capacity'
  )
  ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
  SET quota = jsonb_set(
        jsonb_set(
          geo.automation_controls.quota,
          '{maxConcurrent}',
          to_jsonb(EXCLUDED.quota -> 'maxConcurrent')
        ),
        '{perDay}',
        to_jsonb(EXCLUDED.quota -> 'perDay')
      ),
      mode = CASE
        WHEN geo.automation_controls.reason = 'Default per-account publication capacity'
             AND NOT geo.automation_controls.kill_switch_enabled
          THEN EXCLUDED.mode
        ELSE geo.automation_controls.mode
      END;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS channel_accounts_sync_capacity_control
  ON geo.channel_accounts;

CREATE TRIGGER channel_accounts_sync_capacity_control
AFTER INSERT OR UPDATE OF platform, capability, supported_execution_levels, status,
  daily_publish_quota, max_concurrent_publications
ON geo.channel_accounts
FOR EACH ROW EXECUTE FUNCTION geo.sync_channel_account_capacity_control();

UPDATE geo.automation_controls AS control
SET mode = 'unattended',
    updated_at = clock_timestamp()
FROM geo.channel_accounts AS account
WHERE control.tenant_id = account.tenant_id
  AND control.scope_type = 'account'
  AND control.scope_key = account.id::text
  AND control.mode = 'supervised'
  AND NOT control.kill_switch_enabled
  AND control.reason = 'Default per-account publication capacity'
  AND account.platform = 'ctrip_community'
  AND account.capability = 'browser_assisted'
  AND account.status = 'active'
  AND 'unattended' = ANY(account.supported_execution_levels);

COMMIT;
