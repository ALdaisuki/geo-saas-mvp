BEGIN;

-- Same reconciliation blind spot as the manual readback reopen functions: the
-- replayable ACL file revokes every function execute right before granting its
-- allowlist, and force calibration was missing from that list. Operators
-- clicking "人工强制校准" got a silent permission failure instead of a runtime
-- calibration.
GRANT EXECUTE ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz)
  TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.force_calibrate_channel_account_runtime(uuid,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'force calibrate ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
