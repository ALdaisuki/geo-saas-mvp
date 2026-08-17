BEGIN;

-- A target is checkpointed as variant_ready before the deterministic audit
-- result is interpreted. When that result requires operator review, the same
-- target must be able to pause without being misclassified as a resource
-- conflict and retried forever.
DO $checkpoint$
DECLARE
  definition text;
  transition_needle text := $needle$    (target_row.state = 'variant_ready' AND
     p_new_state IN ('audit_failed', 'awaiting_delivery', 'blocked', 'failed', 'cancelled')) OR$needle$;
  transition_replacement text := $replacement$    (target_row.state = 'variant_ready' AND
     p_new_state IN ('audit_failed', 'awaiting_manual_review', 'awaiting_delivery', 'blocked', 'failed', 'cancelled')) OR$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)'::regprocedure
  ) INTO definition;
  IF definition IS NULL OR position(transition_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'automation target checkpoint function drifted before audit manual review transition';
  END IF;

  definition := replace(definition, transition_needle, transition_replacement);
  EXECUTE definition;
END
$checkpoint$;

COMMENT ON FUNCTION geo.checkpoint_automation_target(
  uuid, uuid, text, integer, text, uuid, uuid, uuid, uuid, text, text, jsonb, integer
) IS
  'Checkpoints automation targets under the active lease, including pausing an audited variant for manual review';

COMMIT;
