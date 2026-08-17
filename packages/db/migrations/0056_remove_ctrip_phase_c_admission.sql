BEGIN;

-- Retire the Phase C onboarding/canary admission gate. Account creation and
-- assisted/unattended scheduling now become immediately available after the
-- account is active and declares the requested capability. Runtime session
-- checks, tenant/account controls, quotas, circuit breakers, audit/grant
-- validity, and public readback remain enforced at their existing boundaries.

ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_ctrip_unattended_scope;

ALTER TABLE geo.channel_accounts
  ADD CONSTRAINT channel_accounts_ctrip_unattended_scope
    CHECK (
      NOT ('unattended' = ANY(supported_execution_levels)) OR (
        platform = 'ctrip_community' AND capability = 'browser_assisted'
      )
    );

DROP TRIGGER IF EXISTS automation_controls_ctrip_release_phase
  ON geo.automation_controls;

-- Keep the legacy function for compatibility with older workers, but make it
-- a capability/control snapshot rather than a Phase A/B/C approval decision.
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
BEGIN
  PERFORM geo.require_actor_id();
  SELECT * INTO account
  FROM geo.channel_accounts AS channel_account
  WHERE channel_account.tenant_id = tenant_value
    AND channel_account.id = p_channel_account_id
    AND channel_account.platform = 'ctrip_community';

  IF account.id IS NULL
     OR account.status <> 'active'
     OR account.capability <> 'browser_assisted'
     OR NOT ('unattended' = ANY(account.supported_execution_levels)) THEN
    RETURN 'A';
  END IF;
  RETURN 'C';
END
$$;

-- Remove Phase C/evidence substitutions introduced by the historical
-- migrations while preserving the rest of each function's safety checks.
DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef('geo.publication_assisted_block_reason(uuid)'::regprocedure)
    INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF job.execution_level = 'unattended' AND geo.ctrip_release_phase(job.channel_account_id) <> 'C' THEN
    RETURN 'ctrip_release_phase_not_c';
  END IF;

$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$     OR account.last_verified_at IS NULL
     OR account.last_verified_at < statement_timestamp() - interval '24 hours' THEN$needle$,
    $needle$     THEN$needle$
  );
  updated_definition := replace(
    updated_definition,
    $needle$  IF job.execution_level = 'unattended' AND (
       account.capability_evidence_type <> 'platform_readback' OR
       NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(account.capability_evidence_refs) AS ref(value)
         WHERE ref.value = unattended_marker
       )
     ) THEN
    RETURN 'account_unattended_adapter_evidence_not_current';
  END IF;

$needle$,
    ''
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip block-reason Phase C removal found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.consume_ctrip_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamp with time zone)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF p_execution_level = 'unattended'
     AND geo.ctrip_release_phase(grant_row.channel_account_id) <> 'C' THEN
    RAISE EXCEPTION 'Ctrip unattended publication requires Phase C' USING ERRCODE = '42501';
  END IF;

$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$     OR account_row.last_verified_at IS NULL
     OR account_row.last_verified_at < statement_timestamp() - interval '24 hours' THEN$needle$,
    $needle$     THEN$needle$
  );
  updated_definition := replace(
    updated_definition,
    $needle$  IF p_execution_level = 'unattended' AND (
       account_row.capability_evidence_type <> 'platform_readback' OR
       NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(account_row.capability_evidence_refs) AS ref(value)
         WHERE ref.value = unattended_marker
       )
     ) THEN
    RAISE EXCEPTION 'Ctrip unattended adapter evidence is not current' USING ERRCODE = '42501';
  END IF;

$needle$,
    ''
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip grant Phase C removal found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef('geo.issue_publication_assisted_submit_permit(uuid)'::regprocedure)
    INTO definition;
  updated_definition := replace(
    definition,
    $needle$  IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'B' THEN
    RAISE EXCEPTION 'Ctrip submit permit requires Phase B'
      USING ERRCODE = '42501';
  END IF;
$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$  PERFORM pg_advisory_xact_lock(hashtextextended(
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

$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$      'releasePhase', 'B',
      'phaseBCanary', true$needle$,
    $needle$      'releaseMode', 'immediate'$needle$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip assisted permit Phase B removal found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef('geo.claim_next_ctrip_unattended_submit()'::regprocedure)
    INTO definition;
  updated_definition := replace(
    definition,
    $needle$    AND geo.ctrip_release_phase(candidate.channel_account_id) = 'C'
$needle$,
    ''
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip unattended claim Phase C removal found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.consume_publication_assisted_submit_permit(uuid,text)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $needle$    IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'C' THEN
      RAISE EXCEPTION 'unattended submit permit requires Ctrip Phase C'
        USING ERRCODE = '42501';
    END IF;
$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$    IF geo.ctrip_release_phase(handoff.channel_account_id) <> 'B'
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
$needle$,
    ''
  );
  updated_definition := replace(
    updated_definition,
    $needle$      'releasePhase', CASE WHEN job.execution_level = 'unattended' THEN 'C' ELSE 'B' END,
      'stateTransitionCommitted', job.execution_level = 'unattended'$needle$,
    $needle$      'releaseMode', 'immediate',
      'stateTransitionCommitted', job.execution_level = 'unattended'$needle$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'Ctrip permit consumption Phase removal found no changes';
  END IF;
  EXECUTE updated_definition;
END
$$;

CREATE OR REPLACE FUNCTION geo.validate_automation_target_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, geo
AS $$
DECLARE
  batch_execution_level text;
BEGIN
  SELECT batch.execution_level INTO batch_execution_level
  FROM geo.automation_runs AS run
  JOIN geo.automation_batches AS batch
    ON batch.tenant_id = run.tenant_id
   AND batch.id = run.batch_id
  WHERE run.tenant_id = NEW.tenant_id
    AND run.id = NEW.run_id
    AND run.state = 'scheduled'
    AND run.stage = 'planning';

  IF NEW.state <> 'pending' OR NEW.variant_id IS NOT NULL OR NEW.audit_run_id IS NOT NULL OR
     NEW.audit_artifact_id IS NOT NULL OR NEW.publication_job_id IS NOT NULL OR
     NEW.last_error_code IS NOT NULL OR NEW.last_error_message IS NOT NULL OR
     NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR
     batch_execution_level IS NULL THEN
    RAISE EXCEPTION 'automation targets must start pending inside a scheduled run'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

COMMIT;
