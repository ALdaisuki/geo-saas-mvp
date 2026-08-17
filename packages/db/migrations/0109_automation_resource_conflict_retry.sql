BEGIN;

ALTER TABLE geo.automation_runs
  ADD COLUMN resource_wait_count integer NOT NULL DEFAULT 0
  CHECK (resource_wait_count BETWEEN 0 AND 10000);

-- Automation resource conflicts preserve attempt budget because they are
-- scheduler backpressure, not a failed content-production attempt. The run is
-- delayed with bounded exponential backoff and deterministic jitter while the
-- account-level single-writer invariant remains intact.
DO $reconcile$
DECLARE
  definition text;
  declaration_needle text := E'  error_message_value text;\nBEGIN';
  delay_needle text := $needle$  UPDATE geo.automation_runs AS run
  SET state = next_state,$needle$;
  update_needle text := $needle$      available_at = available_value,
      lease_owner = NULL,$needle$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.reconcile_automation_run(uuid,text,integer,integer,text,text)'::regprocedure
  ) INTO definition;
  IF definition IS NULL
     OR position(declaration_needle IN definition) = 0
     OR position(delay_needle IN definition) = 0
     OR position(update_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'automation reconciliation function drifted before resource conflict retry';
  END IF;

  definition := replace(
    definition,
    declaration_needle,
    E'  error_message_value text;\n  resource_wait_delay_seconds integer;\nBEGIN'
  );
  definition := replace(
    definition,
    delay_needle,
    $replacement$  IF next_state = 'retry_wait' AND p_error_code = 'RESOURCE_CONFLICT' THEN
    resource_wait_delay_seconds := least(
      60,
      (2 * power(2, least(run_row.resource_wait_count, 5)))::integer +
        abs(mod(hashtextextended(
          p_run_id::text || ':' || (run_row.resource_wait_count + 1)::text,
          0
        ), 5))::integer
    );
    available_value := clock_timestamp() +
      make_interval(secs => resource_wait_delay_seconds);
  END IF;

  UPDATE geo.automation_runs AS run
  SET state = next_state,$replacement$
  );
  definition := replace(
    definition,
    update_needle,
    $replacement$      available_at = available_value,
      attempt_count = CASE
        WHEN next_state = 'retry_wait' AND p_error_code = 'RESOURCE_CONFLICT'
          THEN greatest(run.attempt_count - 1, 0)
        ELSE run.attempt_count
      END,
      resource_wait_count = CASE
        WHEN next_state = 'retry_wait' AND p_error_code = 'RESOURCE_CONFLICT'
          THEN least(run.resource_wait_count + 1, 10000)
        ELSE 0
      END,
      lease_owner = NULL,$replacement$
  );
  EXECUTE definition;
END
$reconcile$;

COMMIT;
