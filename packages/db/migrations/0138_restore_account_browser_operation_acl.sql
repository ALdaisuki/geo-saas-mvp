BEGIN;

GRANT EXECUTE ON FUNCTION
  geo.publication_account_browser_operation_busy(uuid, uuid, boolean)
TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
    'geo_runtime',
    'geo.publication_account_browser_operation_busy(uuid,uuid,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'account browser operation ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
