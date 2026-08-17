BEGIN;

-- The readback budget trigger runs before the manual reopen update and would
-- otherwise shrink a freshly granted operator window back to submit + 10
-- minutes, which is already expired for an older handoff. Keep the larger of
-- the two windows so a manual reopen always grants a real ten-minute polling
-- window while automatic transitions keep their submit-relative deadline.
CREATE OR REPLACE FUNCTION geo.apply_ctrip_readback_budget()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state = 'readback_pending' AND OLD.state IS DISTINCT FROM 'readback_pending' THEN
    NEW.readback_attempt_count := 0;
    NEW.readback_deadline_at := GREATEST(
      COALESCE(NEW.readback_deadline_at, COALESCE(NEW.submit_observed_at, statement_timestamp()) + interval '10 minutes'),
      COALESCE(NEW.submit_observed_at, statement_timestamp()) + interval '10 minutes'
    );
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION geo.apply_ctrip_readback_budget() IS
  'Keeps priority-platform readback polling within ten minutes of submit while preserving fresh manual reopen windows';

COMMIT;
