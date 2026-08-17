-- A missing Ctrip session is an account-scoped outage. Keep the queue closed
-- until an operator has restored the session and explicitly closed the circuit.

CREATE OR REPLACE FUNCTION geo.open_ctrip_session_required_circuit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  INSERT INTO geo.circuit_breakers (
    tenant_id, scope_type, scope_key, state, failure_count,
    opened_at, retry_at, reason
  ) VALUES (
    NEW.tenant_id, 'account', NEW.channel_account_id::text, 'open', 1,
    statement_timestamp(), NULL, 'ASSISTED_SESSION_REQUIRED'
  )
  ON CONFLICT (tenant_id, scope_type, scope_key) DO UPDATE
  SET state = 'open',
      failure_count = geo.circuit_breakers.failure_count + 1,
      opened_at = statement_timestamp(),
      retry_at = NULL,
      reason = 'ASSISTED_SESSION_REQUIRED',
      probe_attempt_id = NULL,
      probe_started_at = NULL,
      updated_at = clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER publication_assisted_handoff_session_required_circuit
AFTER UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW
WHEN (NEW.state = 'session_required')
EXECUTE FUNCTION geo.open_ctrip_session_required_circuit();

-- Defense in depth for the SECURITY DEFINER draft recorder: SQL null semantics
-- must never allow draft preparation without a live bridge lease.
CREATE OR REPLACE FUNCTION geo.require_ctrip_draft_prepare_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF NEW.state = 'draft_prepared' AND OLD.state <> 'draft_prepared' AND (
       OLD.draft_prepare_owner_principal_id IS NULL OR
       OLD.draft_prepare_lease_expires_at IS NULL OR
       OLD.draft_prepare_lease_expires_at < statement_timestamp()
     ) THEN
    RAISE EXCEPTION 'draft preparation requires the current bridge lease'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER publication_assisted_handoff_01_require_draft_prepare_lease
BEFORE UPDATE OF state ON geo.publication_assisted_handoffs
FOR EACH ROW
EXECUTE FUNCTION geo.require_ctrip_draft_prepare_lease();

REVOKE ALL ON FUNCTION geo.open_ctrip_session_required_circuit() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.require_ctrip_draft_prepare_lease() FROM PUBLIC;
