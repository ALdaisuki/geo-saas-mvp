BEGIN;

-- A platform submission that crossed the submit boundary can remain uncertain
-- while public moderation and readback are still pending. Only an explicit
-- delivery failure is allowed to consume the delivery error budget.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.acquire_publication_execution(uuid,uuid,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('attempt.state IN (''failed'', ''uncertain'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication acquire function drifted before 0063';
  END IF;
  function_definition := replace(
    function_definition,
    $needle$attempt.state IN ('failed', 'uncertain')$needle$,
    $replacement$attempt.state = 'failed'$replacement$
  );
  IF position('attempt.state IN (''failed'', ''uncertain'')' IN function_definition) <> 0 THEN
    RAISE EXCEPTION 'publication acquire function was not patched by 0063';
  END IF;
  EXECUTE function_definition;
END
$$;

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.finish_publication_execution(uuid,uuid,text,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('prior_attempt.state IN (''failed'', ''uncertain'')' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'publication finish function drifted before 0063';
  END IF;
  function_definition := replace(
    function_definition,
    $needle$prior_attempt.state IN ('failed', 'uncertain')$needle$,
    $replacement$prior_attempt.state = 'failed'$replacement$
  );
  IF position('prior_attempt.state IN (''failed'', ''uncertain'')' IN function_definition) <> 0 THEN
    RAISE EXCEPTION 'publication finish function was not patched by 0063';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMIT;
