BEGIN;

-- Production schema drifted from these grants even though the original
-- migrations were recorded as applied. Restore the runtime execute grants
-- for functions the API and Ctrip bridge call directly.
REVOKE ALL ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;

REVOKE ALL ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid)
  TO geo_runtime;

REVOKE ALL ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb)
  TO geo_runtime;

COMMIT;
