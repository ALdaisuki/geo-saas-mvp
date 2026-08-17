BEGIN;

-- A manual calibration is an operator observation, not a one-shot UI hint.
-- Keep it authoritative for a short window while the browser bridge catches up
-- so the next negative probe cannot immediately reintroduce the false alarm.
ALTER TABLE geo.ctrip_account_runtime_bindings
  ADD COLUMN manual_ready_until timestamptz;

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

REVOKE ALL ON FUNCTION geo.preserve_manual_runtime_calibration() FROM PUBLIC;

CREATE TRIGGER ctrip_account_runtime_bindings_preserve_manual_calibration
BEFORE UPDATE OF session_state, last_checked_at, last_ready_at,
  last_error_code, last_error_message, manual_ready_until
ON geo.ctrip_account_runtime_bindings
FOR EACH ROW EXECUTE FUNCTION geo.preserve_manual_runtime_calibration();

COMMIT;
