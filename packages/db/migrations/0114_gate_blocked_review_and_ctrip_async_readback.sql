BEGIN;

-- 1) Ctrip moderation can outlive the interactive window just like other
-- priority platforms. Give ctrip_community the same 24-hour asynchronous
-- readback deadline instead of converting "submitted but review pending"
-- into a delivery failure.
DO $readback$
DECLARE
  definition text;
  platform_needle text := $needle$      AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease')$needle$;
  platform_replacement text := $replacement$      AND job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')$replacement$;
BEGIN
  SELECT pg_get_functiondef('geo.expire_priority_platform_readback_windows()'::regprocedure)
    INTO definition;
  IF definition IS NULL OR position(platform_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'priority platform readback window drifted before 0114';
  END IF;
  definition := replace(definition, platform_needle, platform_replacement);
  EXECUTE definition;
END
$readback$;

-- 2) A publication job in needs_review is an operator decision point, not a
-- delivery failure. Sync such targets to blocked and propagate a blocked run
-- so the frontend asks for manual attention instead of reporting a failed
-- delivery.
DO $sync$
DECLARE
  definition text;
  state_needle text := $needle$    SET state = CASE WHEN NEW.state = 'confirmed' THEN 'confirmed' ELSE 'delivery_failed' END,$needle$;
  state_replacement text := $replacement$    SET state = CASE WHEN NEW.state = 'confirmed' THEN 'confirmed' ELSE 'blocked' END,$replacement$;
  count_needle text := $needle$           count(*) FILTER (WHERE target.state = 'delivery_failed')::integer AS delivery_failure_count$needle$;
  count_replacement text := $replacement$           count(*) FILTER (WHERE target.state = 'blocked')::integer AS blocked_count,
           count(*) FILTER (WHERE target.state = 'delivery_failed')::integer AS delivery_failure_count$replacement$;
  next_state_needle text := $needle$           WHEN counts.delivery_failure_count = counts.failure_count AND counts.failure_count > 0 THEN 'delivery_failed'$needle$;
  next_state_replacement text := $replacement$           WHEN counts.blocked_count = counts.failure_count AND counts.failure_count > 0 THEN 'blocked'
           WHEN counts.delivery_failure_count = counts.failure_count AND counts.failure_count > 0 THEN 'delivery_failed'$replacement$;
  error_code_needle text := $needle$          WHEN 'delivery_failed' THEN 'AUTOMATION_DELIVERY_FAILED'$needle$;
  error_code_replacement text := $replacement$          WHEN 'delivery_failed' THEN 'AUTOMATION_DELIVERY_FAILED'
          WHEN 'blocked' THEN 'AUTOMATION_GATE_BLOCKED'$replacement$;
  error_message_needle text := $needle$          WHEN 'delivery_failed' THEN left(failure_code, 4000)$needle$;
  error_message_replacement text := $replacement$          WHEN 'delivery_failed' THEN left(failure_code, 4000)
          WHEN 'blocked' THEN left(failure_code, 4000)$replacement$;
BEGIN
  SELECT pg_get_functiondef('geo.sync_automation_target_from_publication_job()'::regprocedure)
    INTO definition;
  IF definition IS NULL
     OR position(state_needle IN definition) = 0
     OR position(count_needle IN definition) = 0
     OR position(next_state_needle IN definition) = 0
     OR position(error_code_needle IN definition) = 0
     OR position(error_message_needle IN definition) = 0 THEN
    RAISE EXCEPTION 'automation publication terminal sync drifted before 0114';
  END IF;
  definition := replace(definition, state_needle, state_replacement);
  definition := replace(definition, count_needle, count_replacement);
  definition := replace(definition, next_state_needle, next_state_replacement);
  definition := replace(definition, error_code_needle, error_code_replacement);
  definition := replace(definition, error_message_needle, error_message_replacement);
  IF position('AS blocked_count' IN definition) = 0
     OR position('WHEN ''blocked'' THEN ''AUTOMATION_GATE_BLOCKED''' IN definition) = 0 THEN
    RAISE EXCEPTION 'automation publication terminal sync survived 0114 without blocked semantics';
  END IF;
  EXECUTE definition;
END
$sync$;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Defers accepted priority-platform and Ctrip submits to a 24-hour asynchronous readback window after ten minutes, then requests manual review without resubmitting';

COMMENT ON FUNCTION geo.sync_automation_target_from_publication_job() IS
  'Synchronizes confirmed jobs to confirmed targets and needs_review/permanent_failure jobs to blocked targets for operator attention';

COMMIT;
