BEGIN;

ALTER TABLE geo.ctrip_account_runtime_bindings
  DROP CONSTRAINT ctrip_account_runtime_bindings_session_state_check;

ALTER TABLE geo.ctrip_account_runtime_bindings
  ADD CONSTRAINT ctrip_account_runtime_bindings_session_state_check
  CHECK (session_state IN (
    'unbound', 'session_required', 'authenticated', 'ready',
    'challenge_required', 'unavailable', 'disabled'
  ));

COMMIT;
