-- Ctrip moderation can lag behind the browser submit observation. Keep the
-- submit operation one-shot, but allow a bounded public readback window long
-- enough for delayed moderation to produce a searchable article.

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.apply_ctrip_readback_budget()'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL OR position('interval ''30 minutes''' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Ctrip readback budget trigger function drifted before 0049';
  END IF;
  function_definition := replace(
    function_definition,
    'interval ''30 minutes''',
    'interval ''60 minutes'''
  );
  EXECUTE function_definition;
END
$$;

UPDATE geo.publication_assisted_handoffs
SET readback_deadline_at = GREATEST(
  readback_deadline_at,
  COALESCE(submit_observed_at, updated_at) + interval '60 minutes'
)
WHERE state = 'readback_pending';

DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.record_publication_assisted_readback(uuid,text,text,geo.sha256_hex,geo.sha256_hex,text,text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
     OR position('next_attempt_count >= 20' IN function_definition) = 0
     OR position('''attemptLimit'', 20' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Ctrip readback recorder drifted before 0049';
  END IF;
  function_definition := replace(function_definition, 'next_attempt_count >= 20', 'next_attempt_count >= 60');
  function_definition := replace(function_definition, '''attemptLimit'', 20', '''attemptLimit'', 60');
  EXECUTE function_definition;
END
$$;

COMMENT ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) IS 'Records one-shot Ctrip publication observations with a 60-attempt, 60-minute bounded public readback budget';
