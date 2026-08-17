BEGIN;

-- Account security challenges (slider/QR verification) are a degraded signal,
-- not a publication gate. The account remains logged in and the editor stays
-- usable, so unattended/assisted automation must keep selecting and claiming
-- these accounts instead of waiting for a human verification step.

DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.validate_automation_target_insert()'::regprocedure)
    INTO definition;
  updated_definition := replace(
    definition,
    $needle$runtime.session_state IN ('authenticated', 'ready')$needle$,
    $needle$runtime.session_state IN ('authenticated', 'ready', 'challenge_required')$needle$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'validate_automation_target_insert challenge degradation found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.reassign_pending_automation_target(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $needle$account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready')$needle$,
    $needle$account_row.ctrip_runtime_session_state NOT IN ('authenticated', 'ready', 'challenge_required')$needle$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'reassign_pending_automation_target challenge degradation found no changes';
  END IF;
  EXECUTE updated_definition;
END
$$;

COMMIT;
