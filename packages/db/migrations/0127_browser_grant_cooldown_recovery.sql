BEGIN;

-- browser grant cooldown recovery: grant consumption must admit only a cooled,
-- recoverable account circuit so the execution boundary can arm its controlled
-- half-open probe. Active cooldowns and all other circuit scopes stay blocked.
DO $$
DECLARE
  function_definition text;
  circuit_state_needle text :=
    $needle$      AND breaker.state IN ('open', 'half_open')$needle$;
  circuit_state_replacement text :=
    $replacement$      AND breaker.state IN ('open', 'half_open')
      AND (
        breaker.scope_type <> 'account'
        OR breaker.scope_key <> grant_row.channel_account_id::text
        OR breaker.state <> 'open'
        OR breaker.reason IS NULL
        OR breaker.reason NOT IN (
          'ASSISTED_SESSION_REQUIRED',
          'ASSISTED_CHALLENGE_REQUIRED',
          'ASSISTED_ADAPTER_DRIFT'
        )
        OR breaker.retry_at IS NULL
        OR breaker.retry_at > statement_timestamp()
      )$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.consume_browser_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamp with time zone)'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL
     OR position(circuit_state_needle IN function_definition) = 0 THEN
    RAISE EXCEPTION 'browser grant circuit policy drifted before 0127';
  END IF;

  function_definition := replace(
    function_definition,
    circuit_state_needle,
    circuit_state_replacement
  );

  IF position('ASSISTED_CHALLENGE_REQUIRED' IN function_definition) = 0
     OR position('breaker.retry_at > statement_timestamp()' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'browser grant cooldown recovery was not patched by 0127';
  END IF;

  EXECUTE function_definition;
END
$$;

COMMIT;
