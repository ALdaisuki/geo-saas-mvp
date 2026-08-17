-- Ctrip production rollout is controlled by the existing automation modes:
--   Phase A: no account control, or an account control in shadow mode
--   Phase B: tenant + account controls in supervised mode
--   Phase C: tenant + account controls in unattended mode, after the one
--            Phase B canary has content-bound public readback evidence
-- Preparation remains available in Phase A. Every permit boundary fails closed.

CREATE TABLE geo.ctrip_phase_b_canaries (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'ctrip_community'
    CHECK (platform = 'ctrip_community'),
  handoff_id uuid NOT NULL,
  authorized_by_actor_id uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id),
  UNIQUE (tenant_id, handoff_id),
  FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES geo.publication_assisted_handoffs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, authorized_by_actor_id)
    REFERENCES geo.tenant_memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE TRIGGER ctrip_phase_b_canaries_append_only
BEFORE UPDATE OR DELETE ON geo.ctrip_phase_b_canaries
FOR EACH ROW EXECUTE FUNCTION geo.prevent_append_only_mutation();

ALTER TABLE geo.ctrip_phase_b_canaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.ctrip_phase_b_canaries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.ctrip_phase_b_canaries TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

REVOKE ALL ON TABLE geo.ctrip_phase_b_canaries
  FROM PUBLIC, geo_dispatcher, geo_identity, geo_runtime;
GRANT SELECT ON TABLE geo.ctrip_phase_b_canaries TO geo_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.ctrip_phase_b_canaries FROM geo_runtime;

CREATE OR REPLACE FUNCTION geo.ctrip_phase_b_canary_succeeded(p_channel_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
BEGIN
  PERFORM geo.require_actor_id();
  IF p_channel_account_id IS NULL THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM geo.ctrip_phase_b_canaries AS canary
    JOIN geo.publication_assisted_handoffs AS handoff
      ON handoff.tenant_id = canary.tenant_id
     AND handoff.id = canary.handoff_id
     AND handoff.channel_account_id = canary.channel_account_id
    JOIN geo.publication_jobs AS job
      ON job.tenant_id = handoff.tenant_id
     AND job.id = handoff.job_id
    WHERE canary.tenant_id = tenant_value
      AND canary.channel_account_id = p_channel_account_id
      AND job.execution_level = 'assisted'
      AND handoff.state = 'confirmed'
      AND handoff.submit_permit_issued_by_actor_id = canary.authorized_by_actor_id
      AND handoff.submit_permit_issued_by_principal_id IS NULL
      AND handoff.submit_permit_consumed_at IS NOT NULL
      AND handoff.submit_permit_consumed_by_principal_id = handoff.bridge_service_principal_id
      AND handoff.submit_outcome = 'accepted'
      AND handoff.submit_evidence_kind = 'browser'
      AND handoff.submit_evidence_hash IS NOT NULL
      AND handoff.readback_outcome = 'confirmed'
      AND handoff.readback_evidence_kind = 'platform_readback'
      AND handoff.readback_evidence_hash IS NOT NULL
      AND handoff.public_content_hash IS NOT NULL
      AND handoff.observed_payload_hash = handoff.public_content_hash
      AND handoff.external_id IS NOT NULL
      AND handoff.external_url IS NOT NULL
  );
END
$$;

CREATE OR REPLACE FUNCTION geo.ctrip_release_phase(p_channel_account_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  account geo.channel_accounts%ROWTYPE;
  tenant_control geo.automation_controls%ROWTYPE;
  account_control geo.automation_controls%ROWTYPE;
BEGIN
  PERFORM geo.require_actor_id();
  SELECT * INTO account
  FROM geo.channel_accounts AS channel_account
  WHERE channel_account.tenant_id = tenant_value
    AND channel_account.id = p_channel_account_id
    AND channel_account.platform = 'ctrip_community';
  IF account.id IS NULL THEN
    RETURN 'A';
  END IF;

  SELECT * INTO tenant_control
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value
    AND control.scope_type = 'tenant'
    AND control.scope_key = '*';

  SELECT * INTO account_control
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = tenant_value
    AND control.scope_type = 'account'
    AND control.scope_key = p_channel_account_id::text;

  IF tenant_control.id IS NULL OR account_control.id IS NULL
     OR tenant_control.kill_switch_enabled OR account_control.kill_switch_enabled
     OR tenant_control.mode IN ('paused', 'stopped')
     OR account_control.mode IN ('paused', 'stopped') THEN
    RETURN 'A';
  END IF;

  IF tenant_control.mode = 'unattended'
     AND account_control.mode = 'unattended'
     AND account.status = 'active'
     AND account.capability = 'browser_assisted'
     AND 'unattended' = ANY(account.supported_execution_levels)
     AND account.capability_evidence_type = 'platform_readback'
     AND account.last_verified_at IS NOT NULL
     AND account.last_verified_at >= statement_timestamp() - interval '24 hours'
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(account.capability_evidence_refs) AS ref(value)
       WHERE ref.value = 'adapter:ctrip-community-browser-unattended-v1'
     )
     AND geo.ctrip_phase_b_canary_succeeded(p_channel_account_id) THEN
    RETURN 'C';
  END IF;

  IF tenant_control.mode IN ('supervised', 'unattended')
     AND account_control.mode = 'supervised' THEN
    RETURN 'B';
  END IF;

  RETURN 'A';
END
$$;

CREATE OR REPLACE FUNCTION geo.enforce_ctrip_release_phase_promotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  account_id uuid;
  prior_mode text;
  tenant_control geo.automation_controls%ROWTYPE;
BEGIN
  IF NEW.scope_type <> 'account' OR NEW.mode <> 'unattended' THEN RETURN NEW; END IF;

  SELECT account.id INTO account_id
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = NEW.tenant_id
    AND account.id::text = NEW.scope_key
    AND account.platform = 'ctrip_community';
  IF account_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    prior_mode := OLD.mode;
  ELSE
    SELECT control.mode INTO prior_mode
    FROM geo.automation_controls AS control
    WHERE control.tenant_id = NEW.tenant_id
      AND control.scope_type = NEW.scope_type
      AND control.scope_key = NEW.scope_key;
  END IF;

  IF prior_mode = 'unattended' THEN
    IF NOT geo.ctrip_phase_b_canary_succeeded(account_id) THEN
      RAISE EXCEPTION 'Ctrip Phase C requires successful content-bound Phase B canary evidence'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF prior_mode IS DISTINCT FROM 'supervised' THEN
    RAISE EXCEPTION 'Ctrip Phase C promotion must start from Phase B supervised mode'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO tenant_control
  FROM geo.automation_controls AS control
  WHERE control.tenant_id = NEW.tenant_id
    AND control.scope_type = 'tenant'
    AND control.scope_key = '*';
  IF tenant_control.id IS NULL OR tenant_control.kill_switch_enabled
     OR tenant_control.mode <> 'unattended' THEN
    RAISE EXCEPTION 'Ctrip Phase C requires the tenant unattended control'
      USING ERRCODE = '42501';
  END IF;

  IF NOT geo.ctrip_phase_b_canary_succeeded(account_id) THEN
    RAISE EXCEPTION 'Ctrip Phase C requires successful content-bound Phase B canary evidence'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- Legacy account-level unattended labels are not production authorization.
UPDATE geo.automation_controls AS control
SET mode = 'shadow',
    reason = 'Reset to Ctrip Phase A by release phase gate migration'
FROM geo.channel_accounts AS account
WHERE account.tenant_id = control.tenant_id
  AND account.id::text = control.scope_key
  AND account.platform = 'ctrip_community'
  AND control.scope_type = 'account'
  AND control.mode = 'unattended';

CREATE TRIGGER automation_controls_ctrip_release_phase
BEFORE INSERT OR UPDATE OF mode ON geo.automation_controls
FOR EACH ROW EXECUTE FUNCTION geo.enforce_ctrip_release_phase_promotion();

-- Phase A must admit and prepare an assisted draft, while paused/stopped and
-- kill switches continue to block it. Phase C is additionally required for
-- every unattended job before handoff creation or preparation.
DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.publication_assisted_block_reason(uuid)'::regprocedure)
  INTO definition;
  updated_definition := replace(
    definition,
    'job.execution_level = ''assisted'' AND control.mode IN (''shadow'', ''paused'', ''stopped'')',
    'job.execution_level = ''assisted'' AND control.mode IN (''paused'', ''stopped'')'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'publication assisted Phase A control gate was not found';
  END IF;
  definition := updated_definition;
  updated_definition := replace(
    definition,
    '  SELECT item.* INTO content_item',
    '  IF job.execution_level = ''unattended'' AND geo.ctrip_release_phase(job.channel_account_id) <> ''C'' THEN
    RETURN ''ctrip_release_phase_not_c'';
  END IF;

  SELECT item.* INTO content_item'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'publication assisted Phase C insertion point was not found';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.consume_ctrip_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamp with time zone)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    'p_execution_level = ''assisted'' AND control_row.mode IN (''shadow'', ''paused'', ''stopped'')',
    'p_execution_level = ''assisted'' AND control_row.mode IN (''paused'', ''stopped'')'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip grant tenant Phase A control gate was not found';
  END IF;
  definition := updated_definition;
  updated_definition := replace(
    definition,
    'p_execution_level = ''assisted'' AND scoped_control.mode IN (''shadow'', ''paused'', ''stopped'')',
    'p_execution_level = ''assisted'' AND scoped_control.mode IN (''paused'', ''stopped'')'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip grant scoped Phase A control gate was not found';
  END IF;
  definition := updated_definition;
  updated_definition := replace(
    definition,
    '  SELECT * INTO control_row FROM geo.automation_controls AS control',
    '  IF p_execution_level = ''unattended''
     AND geo.ctrip_release_phase(grant_row.channel_account_id) <> ''C'' THEN
    RAISE EXCEPTION ''Ctrip unattended publication requires Phase C'' USING ERRCODE = ''42501'';
  END IF;

  SELECT * INTO control_row FROM geo.automation_controls AS control'
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip grant Phase C insertion point was not found';
  END IF;
  EXECUTE updated_definition;
END
$$;

CREATE OR REPLACE FUNCTION geo.issue_publication_assisted_submit_permit(p_handoff_id uuid)
RETURNS TABLE (submit_permit text, submit_permit_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_publication_operator();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  block_reason text;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;
  IF job.execution_level <> 'assisted'
     OR handoff.bridge_service_principal_id IS NULL
     OR handoff.external_draft_id IS NULL
     OR handoff.state <> 'draft_prepared' THEN
    RAISE EXCEPTION 'assisted submit permit requires a prepared assisted draft'
      USING ERRCODE = '55000';
  END IF;
  IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'B' THEN
    RAISE EXCEPTION 'Ctrip submit permit requires Phase B'
      USING ERRCODE = '42501';
  END IF;
  IF handoff.lease_owner_actor_id <> actor_value
     OR handoff.lease_expires_at < statement_timestamp() THEN
    RAISE EXCEPTION 'submit permit requires the current operator lease'
      USING ERRCODE = '55006';
  END IF;
  IF handoff.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'assisted handoff has expired' USING ERRCODE = '55000';
  END IF;
  PERFORM geo.require_ctrip_bridge_principal(handoff.bridge_service_principal_id);
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant_value::text || ':ctrip-phase-b-canary:' || handoff.channel_account_id::text,
    0
  ));
  IF EXISTS (
    SELECT 1
    FROM geo.ctrip_phase_b_canaries AS canary
    WHERE canary.tenant_id = tenant_value
      AND canary.channel_account_id = handoff.channel_account_id
  ) THEN
    RAISE EXCEPTION 'Ctrip Phase B canary is already bound for this account'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO geo.ctrip_phase_b_canaries (
    tenant_id, channel_account_id, handoff_id, authorized_by_actor_id
  ) VALUES (
    tenant_value, handoff.channel_account_id, handoff.id, actor_value
  );

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(
    handoff.expires_at,
    handoff.lease_expires_at,
    statement_timestamp() + interval '5 minutes'
  );
  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = 'awaiting_operator_submit',
      submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry,
      submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = actor_value,
      submit_permit_issued_by_principal_id = NULL,
      submit_permit_consumed_by_principal_id = NULL
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object(
      'expiresAt', permit_expiry,
      'bridgePrincipalId', handoff.bridge_service_principal_id,
      'executionLevel', 'assisted',
      'releasePhase', 'B',
      'phaseBCanary', true
    )
  );
  RETURN QUERY SELECT permit_value, permit_expiry;
END
$$;

CREATE OR REPLACE FUNCTION geo.claim_next_ctrip_unattended_submit()
RETURNS TABLE (handoff_id uuid, submit_permit text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_actor_id();
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  permit_value text;
  permit_hash geo.sha256_hex;
  permit_expiry timestamptz;
BEGIN
  PERFORM geo.require_ctrip_bridge_principal(actor_value);
  SELECT candidate.* INTO handoff
  FROM geo.publication_assisted_handoffs AS candidate
  JOIN geo.publication_jobs AS job
    ON job.tenant_id = candidate.tenant_id
   AND job.id = candidate.job_id
  WHERE candidate.tenant_id = tenant_value
    AND candidate.bridge_service_principal_id = actor_value
    AND job.execution_level = 'unattended'
    AND candidate.state = 'draft_prepared'
    AND candidate.external_draft_id IS NOT NULL
    AND candidate.expires_at > statement_timestamp()
    AND candidate.submit_permit_consumed_at IS NULL
    AND (
      candidate.submit_permit_hash IS NULL OR
      candidate.submit_permit_expires_at <= statement_timestamp()
    )
    AND geo.ctrip_release_phase(candidate.channel_account_id) = 'C'
    AND geo.publication_assisted_block_reason(candidate.job_id) IS NULL
  ORDER BY candidate.created_at, candidate.id
  FOR UPDATE OF candidate SKIP LOCKED
  LIMIT 1;
  IF handoff.id IS NULL THEN RETURN; END IF;

  permit_value := encode(public.gen_random_bytes(32), 'hex');
  permit_hash := encode(public.digest(permit_value, 'sha256'), 'hex');
  permit_expiry := LEAST(handoff.expires_at, statement_timestamp() + interval '5 minutes');
  UPDATE geo.publication_assisted_handoffs AS claimed
  SET submit_permit_hash = permit_hash,
      submit_permit_expires_at = permit_expiry,
      submit_permit_consumed_at = NULL,
      submit_permit_issued_by_actor_id = NULL,
      submit_permit_issued_by_principal_id = actor_value,
      submit_permit_consumed_by_principal_id = NULL,
      updated_at = clock_timestamp()
  WHERE claimed.tenant_id = tenant_value
    AND claimed.id = handoff.id;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_issued',
    'publication_assisted_handoff', handoff.id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), handoff.id::text),
    permit_hash,
    jsonb_build_object(
      'expiresAt', permit_expiry,
      'bridgePrincipalId', actor_value,
      'executionLevel', 'unattended',
      'operatorApprovalRequired', false,
      'stateTransitionDeferredUntilConsumption', true,
      'releasePhase', 'C'
    )
  );
  RETURN QUERY SELECT handoff.id, permit_value;
END
$$;

CREATE OR REPLACE FUNCTION geo.consume_publication_assisted_submit_permit(
  p_handoff_id uuid,
  p_submit_permit text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
  actor_value uuid := geo.require_bound_ctrip_bridge(p_handoff_id);
  handoff geo.publication_assisted_handoffs%ROWTYPE;
  job geo.publication_jobs%ROWTYPE;
  permit_hash geo.sha256_hex;
  block_reason text;
BEGIN
  IF p_submit_permit IS NULL OR p_submit_permit !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid submit permit' USING ERRCODE = '22023';
  END IF;
  permit_hash := encode(public.digest(p_submit_permit, 'sha256'), 'hex');

  SELECT * INTO handoff
  FROM geo.publication_assisted_handoffs AS assisted_handoff
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
  FOR UPDATE;
  IF handoff.id IS NULL THEN
    RAISE EXCEPTION 'assisted handoff was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO job
  FROM geo.publication_jobs AS publication_job
  WHERE publication_job.tenant_id = tenant_value
    AND publication_job.id = handoff.job_id;

  IF job.execution_level = 'unattended' THEN
    IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'C' THEN
      RAISE EXCEPTION 'unattended submit permit requires Ctrip Phase C'
        USING ERRCODE = '42501';
    END IF;
    IF handoff.state <> 'draft_prepared'
       OR handoff.bridge_service_principal_id <> actor_value
       OR handoff.submit_permit_issued_by_principal_id <> actor_value
       OR handoff.lease_owner_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'unattended submit permit requires the prepared handoff and bound bridge principal'
        USING ERRCODE = '55006';
    END IF;
  ELSIF job.execution_level = 'assisted' THEN
    IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'B'
       OR NOT EXISTS (
         SELECT 1
         FROM geo.ctrip_phase_b_canaries AS canary
         WHERE canary.tenant_id = tenant_value
           AND canary.channel_account_id = handoff.channel_account_id
           AND canary.handoff_id = handoff.id
           AND canary.authorized_by_actor_id = handoff.submit_permit_issued_by_actor_id
       ) THEN
      RAISE EXCEPTION 'assisted submit permit requires the bound Phase B canary'
        USING ERRCODE = '42501';
    END IF;
    IF handoff.state <> 'awaiting_operator_submit'
       OR handoff.lease_owner_actor_id IS NULL
       OR handoff.lease_expires_at < statement_timestamp()
       OR handoff.submit_permit_issued_by_actor_id <> handoff.lease_owner_actor_id THEN
      RAISE EXCEPTION 'submit permit requires its current issuing operator lease'
        USING ERRCODE = '55006';
    END IF;
  ELSE
    RAISE EXCEPTION 'submit permit requires an assisted or unattended browser job'
      USING ERRCODE = '55000';
  END IF;

  IF handoff.submit_permit_hash <> permit_hash
     OR handoff.submit_permit_expires_at <= statement_timestamp()
     OR handoff.submit_permit_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit is invalid, expired, or already consumed'
      USING ERRCODE = '42501';
  END IF;
  block_reason := geo.publication_assisted_block_reason(handoff.job_id);
  IF block_reason IS NOT NULL THEN
    RAISE EXCEPTION 'submit permit blocked: %', block_reason USING ERRCODE = '42501';
  END IF;

  UPDATE geo.publication_assisted_handoffs AS assisted_handoff
  SET state = CASE
        WHEN job.execution_level = 'unattended' THEN 'awaiting_operator_submit'
        ELSE assisted_handoff.state
      END,
      submit_permit_consumed_at = statement_timestamp(),
      submit_permit_consumed_by_principal_id = actor_value,
      updated_at = clock_timestamp()
  WHERE assisted_handoff.tenant_id = tenant_value
    AND assisted_handoff.id = p_handoff_id
    AND assisted_handoff.submit_permit_consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit permit was concurrently consumed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO geo.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, after_hash, details
  ) VALUES (
    tenant_value, actor_value, 'publication_assisted_handoff.submit_permit_consumed',
    'publication_assisted_handoff', p_handoff_id,
    COALESCE(NULLIF(current_setting('app.request_id', true), ''), p_handoff_id::text),
    permit_hash,
    jsonb_build_object(
      'confirmed', false,
      'externalWriteObserved', false,
      'executionLevel', job.execution_level,
      'releasePhase', CASE WHEN job.execution_level = 'unattended' THEN 'C' ELSE 'B' END,
      'stateTransitionCommitted', job.execution_level = 'unattended'
    )
  );
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.ctrip_release_phase(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.enforce_ctrip_release_phase_promotion() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.issue_publication_assisted_submit_permit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.claim_next_ctrip_unattended_submit() FROM PUBLIC;
REVOKE ALL ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.ctrip_release_phase(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.issue_publication_assisted_submit_permit(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_submit() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text)
  TO geo_runtime;
