BEGIN;

REVOKE ALL ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) TO geo_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state FROM geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_ctrip_account_analytics_refresh(integer)',
       'EXECUTE'
     )
     OR NOT has_table_privilege(
       'geo_runtime', 'geo.ctrip_account_analytics_snapshots', 'SELECT,INSERT,UPDATE'
     )
     OR has_table_privilege(
       'geo_runtime', 'geo.ctrip_account_analytics_snapshots', 'DELETE'
     )
     OR NOT has_table_privilege(
       'geo_runtime', 'geo.ctrip_account_analytics_sync_state', 'SELECT,INSERT,UPDATE'
     )
     OR has_table_privilege(
       'geo_runtime', 'geo.ctrip_account_analytics_sync_state', 'DELETE'
     ) THEN
    RAISE EXCEPTION 'Ctrip analytics ACL repair failed';
  END IF;
END
$verify$;

COMMIT;
