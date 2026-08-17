BEGIN;

-- A successful browser probe can move a manually calibrated runtime between
-- ready and authenticated while the operator lease is still valid. Preserve
-- that lease so the reclaim poller cannot close the session mid-handoff.
CREATE OR REPLACE FUNCTION geo.preserve_manual_runtime_calibration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.session_state IN ('disabled', 'unbound') THEN
    NEW.manual_ready_until := NULL;
  ELSIF OLD.manual_ready_until IS NOT NULL
        AND OLD.manual_ready_until > clock_timestamp()
        AND NEW.session_state IN ('session_required', 'challenge_required', 'unavailable')
        AND OLD.session_state IN ('authenticated', 'ready') THEN
    NEW.session_state := OLD.session_state;
    NEW.last_error_code := NULL;
    NEW.last_error_message := NULL;
  ELSIF OLD.manual_ready_until IS NOT NULL
        AND OLD.manual_ready_until > clock_timestamp()
        AND NEW.session_state IN ('authenticated', 'ready')
        AND OLD.session_state IN ('authenticated', 'ready') THEN
    NEW.manual_ready_until := OLD.manual_ready_until;
    NEW.last_error_code := NULL;
    NEW.last_error_message := NULL;
  ELSIF OLD.manual_ready_until IS NOT NULL
        AND OLD.manual_ready_until <= clock_timestamp()
        AND NEW.session_state IN ('session_required', 'challenge_required', 'unavailable') THEN
    NEW.manual_ready_until := NULL;
  ELSIF NEW.session_state IN ('authenticated', 'ready')
        AND NEW.session_state IS DISTINCT FROM OLD.session_state THEN
    NEW.manual_ready_until := NULL;
  END IF;

  RETURN NEW;
END
$$;

COMMIT;
