BEGIN;

-- 0135 rebuilt the transition trigger to add retained-draft semantics and
-- inadvertently removed the prepared browser recovery edges introduced by
-- 0129. Runtime loss or a challenge after preparation must remain visible as
-- a recoverable operator state instead of raising a second transition error.
CREATE OR REPLACE FUNCTION geo.enforce_publication_assisted_handoff_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'publication assisted handoffs cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.lease_owner_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id AND membership.user_id = NEW.lease_owner_actor_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:request"]'::jsonb
  ) THEN RAISE EXCEPTION 'handoff lease owner must be an active publication operator' USING ERRCODE = '42501'; END IF;
  IF NEW.draft_prepare_owner_principal_id IS NOT NULL AND (
    NEW.draft_prepare_owner_principal_id <> NEW.bridge_service_principal_id OR NOT EXISTS (
      SELECT 1 FROM geo.service_principals AS principal
      WHERE principal.tenant_id = NEW.tenant_id AND principal.id = NEW.draft_prepare_owner_principal_id
        AND principal.kind = 'integration' AND principal.profile = 'ctrip_bridge'
        AND principal.status = 'active' AND principal.capabilities @> '["publish:bridge"]'::jsonb
    )
  ) THEN RAISE EXCEPTION 'draft preparation lease owner must be the bound active Ctrip bridge' USING ERRCODE = '42501'; END IF;
  IF NEW.readback_owner_principal_id IS NOT NULL AND (
    NEW.readback_owner_principal_id <> NEW.bridge_service_principal_id OR NOT EXISTS (
      SELECT 1 FROM geo.service_principals AS principal
      WHERE principal.tenant_id = NEW.tenant_id AND principal.id = NEW.readback_owner_principal_id
        AND principal.kind = 'integration' AND principal.profile = 'ctrip_bridge'
        AND principal.status = 'active' AND principal.capabilities @> '["publish:bridge"]'::jsonb
    )
  ) THEN RAISE EXCEPTION 'readback lease owner must be the bound active Ctrip bridge' USING ERRCODE = '42501'; END IF;
  IF NEW.cancelled_by_actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM geo.tenant_memberships AS membership
    WHERE membership.tenant_id = NEW.tenant_id AND membership.user_id = NEW.cancelled_by_actor_id
      AND membership.status = 'active' AND membership.role IN ('owner', 'admin', 'publisher')
      AND membership.capabilities @> '["publish:cancel"]'::jsonb
  ) THEN RAISE EXCEPTION 'handoff cancellation requires an active publication operator' USING ERRCODE = '42501'; END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'draft_prepare_owner_principal_id', 'draft_prepare_lease_expires_at',
        'readback_owner_principal_id', 'readback_lease_expires_at',
        'session_evidence_hash', 'draft_evidence_hash', 'prepare_outcome',
        'prepare_evidence_kind', 'prepare_evidence_hash', 'prepare_observed_at',
        'media_manifest_hash', 'public_content_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'readback_attempt_count', 'readback_deadline_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY[
        'state', 'lease_owner_actor_id', 'lease_expires_at', 'heartbeat_at',
        'draft_prepare_owner_principal_id', 'draft_prepare_lease_expires_at',
        'readback_owner_principal_id', 'readback_lease_expires_at',
        'session_evidence_hash', 'draft_evidence_hash', 'prepare_outcome',
        'prepare_evidence_kind', 'prepare_evidence_hash', 'prepare_observed_at',
        'media_manifest_hash', 'public_content_hash', 'submit_evidence_hash',
        'submit_permit_hash', 'submit_permit_expires_at', 'submit_permit_consumed_at',
        'submit_permit_issued_by_actor_id', 'submit_permit_issued_by_principal_id',
        'submit_permit_consumed_by_principal_id', 'submit_outcome', 'submit_evidence_kind',
        'submit_observed_at', 'submit_candidate_external_id', 'submit_candidate_external_url',
        'publication_receipt_id', 'publication_readback_id', 'readback_outcome',
        'readback_evidence_kind', 'readback_evidence_hash', 'readback_observed_at',
        'readback_attempt_count', 'readback_deadline_at', 'observed_payload_hash',
        'external_draft_id', 'external_id', 'external_url', 'cancelled_at',
        'cancelled_by_actor_id', 'cancellation_reason', 'last_error_code',
        'last_error_message', 'updated_at'
      ]) THEN
    RAISE EXCEPTION 'publication assisted handoff request fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.state = OLD.state OR
    (OLD.state = 'handoff_pending' AND NEW.state IN ('session_required', 'challenge_required', 'draft_prepared', 'cancelled', 'expired', 'failed')) OR
    (OLD.state IN ('session_required', 'challenge_required') AND NEW.state IN ('handoff_pending', 'session_required', 'challenge_required', 'draft_prepared', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'draft_prepared' AND NEW.state IN ('session_required', 'challenge_required', 'awaiting_operator_submit', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'awaiting_operator_submit' AND NEW.state IN ('session_required', 'challenge_required', 'submitted_unconfirmed', 'needs_review', 'cancelled', 'expired', 'failed')) OR
    (OLD.state = 'submitted_unconfirmed' AND NEW.state IN ('readback_pending', 'needs_review', 'failed')) OR
    (OLD.state = 'readback_pending' AND NEW.state IN ('confirmed', 'needs_review', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid publication assisted handoff transition from % to %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('confirmed', 'needs_review', 'cancelled', 'expired', 'failed') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'terminal publication assisted handoffs are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_publication_assisted_handoff_transition() FROM PUBLIC;

COMMIT;
