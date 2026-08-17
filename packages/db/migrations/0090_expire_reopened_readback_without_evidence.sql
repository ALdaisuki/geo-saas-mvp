BEGIN;

-- A manual reopen intentionally clears the observed readback evidence so a
-- fresh public query can be recorded. When that window expires without a new
-- observation, the expiry update must not fabricate an outcome that violates
-- the readback observation completeness check. Keep the evidence triple null
-- in that case and let ASSISTED_READBACK_UNCERTAIN carry the meaning.
DO $$
DECLARE
  function_definition text;
  expired_outcome text := $needle$
        readback_outcome = COALESCE(target.readback_outcome, 'not_found'),$needle$;
  expired_outcome_replacement text := $replacement$
        readback_outcome = CASE
          WHEN target.readback_evidence_kind IS NULL
           AND target.readback_evidence_hash IS NULL
           AND target.readback_observed_at IS NULL
          THEN NULL
          ELSE COALESCE(target.readback_outcome, 'not_found')
        END,$replacement$;
BEGIN
  SELECT pg_get_functiondef('geo.expire_priority_platform_readback_windows()'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL
     OR position('ASSISTED_READBACK_UNCERTAIN' IN function_definition) = 0
     OR position(expired_outcome IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback expiry drifted before 0090';
  END IF;
  function_definition := replace(function_definition, expired_outcome, expired_outcome_replacement);
  IF position('target.readback_evidence_kind IS NULL' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'reopened readback expiry evidence guard was not installed';
  END IF;
  EXECUTE function_definition;
END
$$;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Marks priority-platform readback windows that exceeded their ten-minute limit as uncertain needs-review handoffs';

COMMIT;
