BEGIN;

-- Error-budget exhaustion can either hold the job for manual review (default)
-- or keep requeueing so a transient overload does not kill the batch. The
-- selected policy rides on the same denial reason so the worker can choose the
-- retry/final semantics without a second lookup.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'publication acquire function is unavailable before 0118';
  END IF;

  IF position(
    'denial_reason := ''quota_error_budget:'' || control_row.scope_type || '':'' || control_row.scope_key;'
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'publication error-budget denial drifted before 0118';
  END IF;

  function_definition := replace(
    function_definition,
    $needle$      WHERE candidate.key <> ALL (ARRAY[
        'maxConcurrent', 'perMinute', 'perDay', 'cooldownSeconds', 'errorBudget'
      ]::text[])$needle$,
    $replacement$      WHERE candidate.key <> ALL (ARRAY[
        'maxConcurrent', 'perMinute', 'perDay', 'cooldownSeconds', 'errorBudget',
        'errorBudgetExhaustedPolicy'
      ]::text[])$replacement$
  );

  function_definition := replace(
    function_definition,
    $needle$      ELSIF error_budget_value IS NOT NULL AND failure_count_value > error_budget_value THEN
        denial_reason := 'quota_error_budget:' || control_row.scope_type || ':' || control_row.scope_key;
      END IF;$needle$,
    $replacement$      ELSIF error_budget_value IS NOT NULL AND failure_count_value > error_budget_value THEN
        denial_reason := 'quota_error_budget:' || control_row.scope_type || ':' || control_row.scope_key
          || ':' || COALESCE(control_row.quota ->> 'errorBudgetExhaustedPolicy', 'review');
      END IF;$replacement$
  );

  IF position(
    'errorBudgetExhaustedPolicy' IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'publication error-budget policy was not patched by 0118';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMIT;
