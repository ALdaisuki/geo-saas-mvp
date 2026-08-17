BEGIN;

-- The replayable ACL reconciliation revokes every function execute right before
-- granting its allowlist. The manual readback reopen and expiry functions were
-- missing from that allowlist, so operator-triggered readback reopened failed
-- with a permission conflict after each production reconciliation. Grant both
-- explicitly here and keep them in the replayable ACL file.
GRANT EXECUTE ON FUNCTION geo.reopen_publication_assisted_readback(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.expire_priority_platform_readback_windows() TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.reopen_publication_assisted_readback(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.expire_priority_platform_readback_windows()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'manual readback reopen ACL grants were not installed';
  END IF;
END
$verify$;

COMMIT;
