BEGIN;

-- A manual reopen grants a fresh ten-minute readback window, but the automatic
-- claim still filtered by the original submit timestamp, so reopened handoffs
-- were never polled. The durable readback_deadline_at is the authoritative
-- window for both automatic transitions and operator reopen, so claim while it
-- is still in the future.
DO $$
DECLARE
  function_definition text;
  submit_window text := $needle$
    AND (
      candidate.platform = 'ctrip_community'
      OR COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)
        >= statement_timestamp() - interval '10 minutes'
    )$needle$;
  deadline_window text := $replacement$
    AND (
      candidate.platform = 'ctrip_community'
      OR candidate.readback_deadline_at >= statement_timestamp()
    )$replacement$;
BEGIN
  SELECT pg_get_functiondef('geo.claim_next_ctrip_unattended_readback()'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL
     OR position('PERFORM geo.expire_priority_platform_readback_windows();' IN function_definition) = 0
     OR position(submit_window IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback claim drifted before 0091';
  END IF;
  function_definition := replace(function_definition, submit_window, deadline_window);
  IF position('candidate.readback_deadline_at >= statement_timestamp()' IN function_definition) = 0
     OR position('COALESCE(candidate.submit_observed_at, candidate.submit_permit_consumed_at)' IN function_definition) <> 0 THEN
    RAISE EXCEPTION 'reopened readback deadline claim guard was not installed';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMENT ON FUNCTION geo.claim_next_ctrip_unattended_readback() IS
  'Claims automatic browser readback while the durable readback deadline is in the future, including manual reopen windows';

COMMIT;
