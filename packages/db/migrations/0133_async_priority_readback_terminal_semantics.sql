BEGIN;

-- Keep asynchronous priority-platform review separate from publication failure.
-- A publisher rejection is a definitive failed delivery, while an unavailable
-- public page during the first ten minutes is still an asynchronous readback.
DO $aggregation$
DECLARE
  definition text;
  failure_needle text := $needle$'audit_failed', 'blocked', 'failed', 'delivery_failed', 'cancelled'$needle$;
  delivery_needle text := $needle$count(*) FILTER (WHERE target.state = 'delivery_failed')::integer
                   AS delivery_failure_count$needle$;
BEGIN
  SELECT pg_get_functiondef('geo.expire_priority_platform_readback_windows()'::regprocedure)
    INTO definition;
  IF definition IS NULL
     OR position(failure_needle IN definition) = 0
     OR position(delivery_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'priority readback aggregation drifted before 0133';
  END IF;

  definition := replace(
    definition,
    failure_needle,
    $replacement$'audit_failed', 'blocked', 'failed', 'publisher_rejected', 'delivery_failed', 'cancelled'$replacement$
  );
  definition := replace(
    definition,
    delivery_needle,
    $replacement$count(*) FILTER (WHERE target.state IN ('publisher_rejected', 'delivery_failed'))::integer
                   AS delivery_failure_count$replacement$
  );
  EXECUTE definition;
END
$aggregation$;

-- A priority-platform submit may be accepted while its short interactive
-- readback deadline is already elapsed. Keep not_found/unavailable pending
-- until the expiry worker extends the window to 24 hours.
DO $deadline$
DECLARE
  definition text;
  deadline_needle text := $needle$OR p_observed_at >= handoff.readback_deadline_at;$needle$;
  deadline_replacement text := $replacement$OR (
        p_observed_at >= handoff.readback_deadline_at
        AND NOT (
          handoff.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')
          AND p_outcome IN ('not_found', 'unavailable')
          AND COALESCE(handoff.submit_observed_at, handoff.submit_permit_consumed_at)
            > statement_timestamp() - interval '24 hours'
        )
      );$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'geo.record_publication_assisted_readback(uuid,text,text,geo.sha256_hex,geo.sha256_hex,text,text,timestamptz)'::regprocedure
  ) INTO definition;
  IF definition IS NULL OR position(deadline_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'priority readback deadline semantics drifted before 0133';
  END IF;
  definition := replace(definition, deadline_needle, deadline_replacement);
  EXECUTE definition;
END
$deadline$;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Defers accepted priority-platform submits to a 24-hour asynchronous readback window, counts publisher rejections as publication failures, and requests manual review only after the async window';

COMMIT;
