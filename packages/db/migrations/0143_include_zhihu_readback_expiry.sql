BEGIN;

-- Zhihu uses the same ten-minute asynchronous public-readback contract as
-- the other priority browser platforms. The original expiry function omitted
-- it, leaving expired Zhihu handoffs permanently readback_pending.
DO $$
DECLARE
  function_definition text;
  old_platform_list text := $needle$job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community')$needle$;
  new_platform_list text := $replacement$job.platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'zhihu')$replacement$;
BEGIN
  SELECT pg_get_functiondef('geo.expire_priority_platform_readback_windows()'::regprocedure)
    INTO function_definition;
  IF function_definition IS NULL
     OR position(old_platform_list IN function_definition) = 0 THEN
    RAISE EXCEPTION 'priority readback expiry function drifted before 0143';
  END IF;
  function_definition := replace(function_definition, old_platform_list, new_platform_list);
  EXECUTE function_definition;
END
$$;

COMMENT ON FUNCTION geo.expire_priority_platform_readback_windows() IS
  'Expires priority browser readback windows for Toutiao, Sohu, Baijiahao, NetEase, and Zhihu';

COMMIT;
