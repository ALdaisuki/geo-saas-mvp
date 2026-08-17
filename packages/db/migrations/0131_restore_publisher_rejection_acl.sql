BEGIN;

-- Migration 0130 was already recorded in production before its ACL tail was
-- amended. Restore the runtime grant with a new forward-only migration so an
-- applied migration is never relied on to replay changed SQL.
REVOKE ALL ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) TO geo_runtime;

DO $verify$
BEGIN
  IF NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_publisher_rejection(uuid,geo.sha256_hex,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'publisher rejection recorder ACL grant was not installed';
  END IF;
END
$verify$;

COMMIT;
