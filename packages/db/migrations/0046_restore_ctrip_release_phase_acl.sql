REVOKE ALL ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid)
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
REVOKE ALL ON FUNCTION geo.ctrip_release_phase(uuid)
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;

GRANT EXECUTE ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.ctrip_release_phase(uuid) TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime', 'geo.ctrip_phase_b_canary_succeeded(uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.ctrip_release_phase(uuid)', 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('geo_dispatcher'), ('geo_identity')) AS role_name(name)
       CROSS JOIN (
         VALUES
           ('geo.ctrip_phase_b_canary_succeeded(uuid)'),
           ('geo.ctrip_release_phase(uuid)')
       ) AS function_name(name)
       WHERE has_function_privilege(role_name.name, function_name.name, 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'Ctrip release phase ACL repair failed';
  END IF;
END
$verify$;
