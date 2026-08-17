BEGIN;

ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_ctrip_unattended_scope;

ALTER TABLE geo.channel_accounts
  ADD CONSTRAINT channel_accounts_browser_unattended_scope
    CHECK (
      NOT ('unattended' = ANY(supported_execution_levels)) OR
      capability IN ('public_api', 'partner_api', 'browser_assisted')
    );

CREATE OR REPLACE FUNCTION geo.sync_channel_account_capacity_control()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  default_mode text := CASE
    WHEN NEW.capability = 'browser_assisted'
         AND NEW.status = 'active'
         AND 'unattended' = ANY(NEW.supported_execution_levels)
      THEN 'unattended'
    WHEN NEW.capability = 'browser_assisted' THEN 'supervised'
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

UPDATE geo.automation_controls AS control
SET mode = 'unattended',
    updated_at = clock_timestamp()
FROM geo.channel_accounts AS account
WHERE control.tenant_id = account.tenant_id
  AND control.scope_type = 'account'
  AND control.scope_key = account.id::text
  AND control.mode IN ('shadow', 'supervised')
  AND NOT control.kill_switch_enabled
  AND control.reason = 'Default per-account publication capacity'
  AND account.capability = 'browser_assisted'
  AND account.status = 'active'
  AND 'unattended' = ANY(account.supported_execution_levels);

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

  IF batch_execution_level = 'unattended' AND NOT EXISTS (
    SELECT 1
    FROM geo.channel_accounts AS account
    JOIN geo.automation_controls AS control
      ON control.tenant_id = account.tenant_id
     AND control.scope_type = 'account'
     AND control.scope_key = account.id::text
    JOIN geo.ctrip_account_runtime_bindings AS runtime
      ON runtime.tenant_id = account.tenant_id
     AND runtime.channel_account_id = account.id
     AND runtime.platform = account.platform
    WHERE account.tenant_id = NEW.tenant_id
      AND account.id = NEW.channel_account_id
      AND account.platform = NEW.platform
      AND account.status = 'active'
      AND account.capability = 'browser_assisted'
      AND 'unattended' = ANY(account.supported_execution_levels)
      AND control.mode = 'unattended'
      AND NOT control.kill_switch_enabled
      AND runtime.session_state IN ('authenticated', 'ready')
  ) THEN
    RAISE EXCEPTION 'unattended automation targets require a ready browser account'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.publication_assisted_block_reason(uuid)'::regprocedure)
    INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF job.execution_level = 'unattended' AND job.platform <> 'ctrip_community' THEN
    RETURN 'job_platform_unattended_not_supported';
  END IF;
$needle$,
    ''
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'generic browser block-reason unattended admission found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.consume_browser_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamp with time zone)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF p_execution_level = 'unattended' AND grant_row.platform <> 'ctrip_community' THEN
    RAISE EXCEPTION 'unattended browser admission is not enabled for this platform'
      USING ERRCODE = '42501';
  END IF;
$needle$,
    ''
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'generic browser grant unattended admission found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.reassign_pending_automation_target(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF run_row.execution_level = 'unattended'
     AND (
       account_row.platform <> 'ctrip_community'
       OR account_row.account_control_mode <> 'unattended'
       OR account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready')
     ) THEN
    RAISE EXCEPTION 'unattended automation requires an authenticated unattended Ctrip account'
      USING ERRCODE = '55000';
  END IF;
$needle$,
    $replacement$  IF run_row.execution_level = 'unattended'
     AND (
       account_row.account_control_mode <> 'unattended'
       OR account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready')
     ) THEN
    RAISE EXCEPTION 'unattended automation requires an authenticated unattended browser account'
      USING ERRCODE = '55000';
  END IF;
$replacement$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'generic automation reassignment unattended admission found no changes';
  END IF;
  EXECUTE updated_definition;
END
$$;

COMMIT;
