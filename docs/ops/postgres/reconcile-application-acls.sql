BEGIN;

ALTER ROLE geo_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE geo_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE geo_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

REVOKE ALL ON SCHEMA geo FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA geo TO geo_runtime, geo_dispatcher, geo_identity;

ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA geo REVOKE ALL ON FUNCTIONS FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA geo FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA geo FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA geo FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA geo TO geo_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA geo FROM geo_runtime;
REVOKE UPDATE, DELETE ON geo.audit_artifacts, geo.publication_receipts,
  geo.audit_log, geo.visibility_observations FROM geo_runtime;
REVOKE UPDATE, DELETE ON geo.evidence_sources FROM geo_runtime;
REVOKE ALL ON geo.research_source_policies, geo.research_capture_records FROM geo_runtime;
GRANT SELECT, INSERT ON geo.research_source_policies, geo.research_capture_records TO geo_runtime;
GRANT UPDATE (status, retired_at, retired_by_actor_id, retirement_reason)
  ON geo.research_source_policies TO geo_runtime;
REVOKE UPDATE, DELETE ON geo.publication_grants FROM geo_runtime;
REVOKE INSERT, DELETE ON geo.publication_jobs FROM geo_runtime;
REVOKE INSERT, UPDATE, DELETE ON geo.outbox_events FROM geo_runtime;
REVOKE DELETE ON geo.publication_attempts FROM geo_runtime;
REVOKE ALL ON geo.tenant_provisioning_receipts FROM geo_runtime;
REVOKE ALL ON TABLE geo.ctrip_bridge_commissioning_receipts
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;
REVOKE DELETE ON geo.ctrip_account_runtime_bindings FROM geo_runtime;
REVOKE DELETE ON geo.ctrip_account_analytics_snapshots,
  geo.ctrip_account_analytics_sync_state FROM geo_runtime;
REVOKE UPDATE, DELETE ON geo.automation_batches, geo.automation_runs,
  geo.automation_run_targets FROM geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON geo.campaign_automation_plans FROM geo_runtime;

REVOKE ALL ON geo.media_generation_jobs, geo.media_generation_attempts,
  geo.media_assets, geo.content_media_bindings, geo.media_inspections FROM geo_runtime;
GRANT SELECT, INSERT ON geo.media_generation_jobs TO geo_runtime;
GRANT UPDATE (
  state, attempt_count, lease_owner, lease_expires_at, asset_id,
  last_error_code, last_error_message, updated_at, completed_at
) ON geo.media_generation_jobs TO geo_runtime;
GRANT SELECT, INSERT ON geo.media_generation_attempts, geo.media_assets,
  geo.content_media_bindings, geo.media_inspections TO geo_runtime;

REVOKE ALL ON TABLE geo.publication_readbacks FROM geo_runtime;
GRANT SELECT ON geo.publication_readbacks TO geo_runtime;
GRANT UPDATE (status, completed_at, last_error) ON geo.publication_readbacks TO geo_runtime;
REVOKE ALL ON TABLE geo.publication_assisted_handoffs FROM geo_runtime;
GRANT SELECT ON geo.publication_assisted_handoffs TO geo_runtime;
REVOKE ALL ON TABLE geo.historical_publications FROM geo_runtime;
GRANT SELECT ON geo.historical_publications TO geo_runtime;

GRANT EXECUTE ON FUNCTION geo.current_tenant_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.current_actor_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.require_tenant_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.require_actor_id() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_grant(uuid, geo.sha256_hex, text, geo.sha256_hex, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_ctrip_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_browser_assisted_publication_grant(
  uuid, geo.sha256_hex, text, geo.sha256_hex, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.revoke_publication_grant(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_publication_job(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.schedule_publication_readback(uuid, uuid, timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.acquire_publication_execution(uuid, uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, text, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.finish_publication_execution(uuid, uuid, boolean, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_automation_runs(text, integer, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.heartbeat_automation_run(uuid, text, integer, text, jsonb, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_draft(uuid, text, integer, uuid, uuid, jsonb, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.checkpoint_automation_target(uuid, uuid, text, integer, text,
  uuid, uuid, uuid, uuid, text, text, jsonb, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.reconcile_automation_run(uuid, text, integer, integer, text, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.reassign_pending_automation_target(uuid, uuid, uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.restart_automation_target_for_remediation(uuid, uuid, jsonb)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.resume_automation_runs_after_manual_media_review(uuid)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_automation_batch(uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.list_due_campaign_automation_plans(timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.create_tenant_member_identity(uuid, uuid, text, text, text, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.list_tenant_member_identities() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.get_tenant_member_identity(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.member_modules_valid(jsonb) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.update_tenant_member_modules(uuid, jsonb) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.research_allowed_hosts_valid(text[]) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.ctrip_publication_payload_within_limits(jsonb) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.publication_assisted_block_reason(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.create_publication_assisted_handoff(
  uuid, uuid, uuid, uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.publication_account_browser_operation_busy(uuid, uuid, boolean)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_publication_assisted_handoff(uuid, integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.heartbeat_publication_assisted_handoff(uuid, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_publication_assisted_draft_prepare(uuid, integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_publication_assisted_draft_prepare(integer, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.expire_stale_publication_assisted_handoffs(integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_draft(
  uuid, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex, geo.sha256_hex,
  geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_prepared_conflict(
  uuid, geo.sha256_hex, text, timestamptz, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_bridge_status(
  uuid, text, geo.sha256_hex, geo.sha256_hex, text, timestamptz, text, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.issue_publication_assisted_submit_permit(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.consume_publication_assisted_submit_permit(uuid, text)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_submit_observation(
  uuid, text, text, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.recover_publication_assisted_submit_uncertain(
  uuid, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_candidate_discovery(
  uuid, text, text
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_status_confirmation(
  uuid, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_publisher_rejection(
  uuid, geo.sha256_hex, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.record_publication_assisted_readback(
  uuid, text, text, geo.sha256_hex, geo.sha256_hex, text, text, timestamptz
) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.ctrip_phase_b_canary_succeeded(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.ctrip_release_phase(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_submit() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_unattended_readback() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_ctrip_unattended_readback(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.reopen_publication_assisted_readback(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.expire_priority_platform_readback_windows() TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.force_calibrate_channel_account_runtime(uuid, timestamptz) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.report_channel_account_platform_mute(uuid, uuid, text) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.purge_abandoned_channel_account_automation_targets(uuid) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_ctrip_account_analytics_refresh(integer) TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.claim_next_priority_platform_account_analytics_refresh(integer)
  TO geo_runtime;
GRANT EXECUTE ON FUNCTION geo.cancel_publication_assisted_handoff(uuid, text) TO geo_runtime;

GRANT EXECUTE ON FUNCTION geo.claim_outbox_events(text, integer, integer) TO geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.ack_outbox_event(uuid, text) TO geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.retry_outbox_event(uuid, text, integer, text, boolean) TO geo_dispatcher;

GRANT EXECUTE ON FUNCTION geo.find_login_identity(text) TO geo_identity;
GRANT EXECUTE ON FUNCTION geo.find_login_identity_by_user(uuid) TO geo_identity;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('geo_runtime', 'geo_dispatcher', 'geo_identity')
        AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls) <> 3
     OR NOT has_schema_privilege('geo_runtime', 'geo', 'USAGE')
     OR NOT has_schema_privilege('geo_dispatcher', 'geo', 'USAGE')
     OR NOT has_schema_privilege('geo_identity', 'geo', 'USAGE')
     OR NOT has_table_privilege('geo_runtime', 'geo.tenants', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.brands', 'INSERT')
     OR has_table_privilege('geo_runtime', 'geo.audit_log', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.publication_receipts', 'DELETE')
     OR NOT has_table_privilege('geo_runtime', 'geo.publication_readbacks', 'SELECT')
     OR NOT has_column_privilege('geo_runtime', 'geo.publication_readbacks', 'status', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.publication_readbacks', 'INSERT')
     OR NOT has_table_privilege(
       'geo_runtime', 'geo.publication_assisted_handoffs', 'SELECT'
     )
     OR has_table_privilege(
       'geo_runtime', 'geo.publication_assisted_handoffs', 'INSERT'
     )
     OR has_table_privilege(
       'geo_runtime', 'geo.publication_assisted_handoffs', 'UPDATE'
     )
     OR has_table_privilege(
       'geo_runtime', 'geo.publication_assisted_handoffs', 'DELETE'
     )
     OR NOT has_table_privilege('geo_runtime', 'geo.historical_publications', 'SELECT')
     OR has_table_privilege('geo_runtime', 'geo.historical_publications', 'INSERT')
     OR has_table_privilege('geo_runtime', 'geo.historical_publications', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.historical_publications', 'DELETE')
     OR has_table_privilege('geo_runtime', 'geo.tenant_provisioning_receipts', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.ctrip_account_runtime_bindings', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.ctrip_account_runtime_bindings', 'INSERT')
     OR NOT has_table_privilege('geo_runtime', 'geo.ctrip_account_runtime_bindings', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.ctrip_account_runtime_bindings', 'DELETE')
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
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('geo_runtime'), ('geo_dispatcher'), ('geo_identity')) AS role_name(name)
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privilege_name(name)
       WHERE has_table_privilege(
         role_name.name,
         'geo.ctrip_bridge_commissioning_receipts',
         privilege_name.name
       )
     )
     OR NOT has_table_privilege('geo_runtime', 'geo.automation_runs', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.automation_runs', 'INSERT')
     OR has_table_privilege('geo_runtime', 'geo.automation_runs', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.automation_run_targets', 'DELETE')
     OR NOT has_table_privilege('geo_runtime', 'geo.research_source_policies', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.research_source_policies', 'INSERT')
     OR NOT has_column_privilege(
       'geo_runtime', 'geo.research_source_policies', 'status', 'UPDATE'
     )
     OR has_column_privilege(
       'geo_runtime', 'geo.research_source_policies', 'origin', 'UPDATE'
     )
     OR has_table_privilege('geo_runtime', 'geo.research_capture_records', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.research_capture_records', 'DELETE')
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.consume_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.consume_ctrip_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.consume_browser_assisted_publication_grant(uuid,geo.sha256_hex,text,geo.sha256_hex,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'geo_runtime', 'geo.claim_outbox_events(text,integer,integer)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.claim_automation_runs(text,integer,integer)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.resume_automation_runs_after_manual_media_review(uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.create_tenant_member_identity(uuid,uuid,text,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.list_tenant_member_identities()', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.get_tenant_member_identity(uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.member_modules_valid(jsonb)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.update_tenant_member_modules(uuid,jsonb)', 'EXECUTE'
     )
     OR NOT has_table_privilege('geo_runtime', 'geo.media_assets', 'SELECT')
     OR NOT has_table_privilege('geo_runtime', 'geo.media_assets', 'INSERT')
     OR has_table_privilege('geo_runtime', 'geo.media_assets', 'UPDATE')
     OR has_table_privilege('geo_runtime', 'geo.media_inspections', 'DELETE')
     OR NOT has_column_privilege(
       'geo_runtime', 'geo.media_generation_jobs', 'state', 'UPDATE'
     )
     OR has_column_privilege(
       'geo_runtime', 'geo.media_generation_jobs', 'request_hash', 'UPDATE'
     )
     OR NOT has_function_privilege(
       'geo_runtime', 'geo.research_allowed_hosts_valid(text[])', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.create_publication_assisted_handoff(uuid,uuid,uuid,uuid,geo.sha256_hex,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.publication_account_browser_operation_busy(uuid,uuid,boolean)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'geo_runtime',
       'geo.create_publication_assisted_handoff(uuid,uuid,uuid,geo.sha256_hex,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_publication_assisted_draft_prepare(uuid,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_publication_assisted_draft_prepare(integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_publication_assisted_draft_prepare(integer,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.expire_stale_publication_assisted_handoffs(integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_draft(uuid,geo.sha256_hex,geo.sha256_hex,geo.sha256_hex,geo.sha256_hex,geo.sha256_hex,text,timestamptz,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_prepared_conflict(uuid,geo.sha256_hex,text,timestamptz,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_draft(uuid,geo.sha256_hex,geo.sha256_hex)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.ctrip_publication_payload_within_limits(jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_bridge_status(uuid,text,geo.sha256_hex,geo.sha256_hex,text,timestamptz,text,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.consume_publication_assisted_submit_permit(uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_submit_observation(uuid,text,text,geo.sha256_hex,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.recover_publication_assisted_submit_uncertain(uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_candidate_discovery(uuid,text,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_publisher_status_confirmation(uuid,geo.sha256_hex,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_publisher_rejection(uuid,geo.sha256_hex,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.record_publication_assisted_readback(uuid,text,text,geo.sha256_hex,geo.sha256_hex,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.ctrip_phase_b_canary_succeeded(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.ctrip_release_phase(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_ctrip_unattended_submit()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_ctrip_unattended_readback()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_ctrip_unattended_readback(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.reopen_publication_assisted_readback(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.expire_priority_platform_readback_windows()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.force_calibrate_channel_account_runtime(uuid,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.report_channel_account_platform_mute(uuid,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.purge_abandoned_channel_account_automation_targets(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_ctrip_account_analytics_refresh(integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.claim_next_priority_platform_account_analytics_refresh(integer)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('geo_runtime'), ('geo_dispatcher'), ('geo_identity')) AS role_name(name)
       WHERE has_function_privilege(
         role_name.name,
         'geo.bind_historical_publication(uuid,text,text,text,text,geo.sha256_hex,timestamptz,timestamptz,geo.sha256_hex,text,text,geo.sha256_hex)',
         'EXECUTE'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('geo_runtime'), ('geo_dispatcher'), ('geo_identity')) AS role_name(name)
       WHERE has_function_privilege(
         role_name.name,
         'geo.ctrip_protected_history_baseline_bound(uuid)',
         'EXECUTE'
       )
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.checkpoint_automation_target(uuid,uuid,text,integer,text,uuid,uuid,uuid,uuid,text,text,jsonb,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.reassign_pending_automation_target(uuid,uuid,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_runtime',
       'geo.restart_automation_target_for_remediation(uuid,uuid,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'geo_dispatcher', 'geo.claim_outbox_events(text,integer,integer)', 'EXECUTE'
     )
     OR has_function_privilege('geo_dispatcher', 'geo.current_tenant_id()', 'EXECUTE')
     OR NOT has_function_privilege('geo_identity', 'geo.find_login_identity(text)', 'EXECUTE')
     OR NOT has_function_privilege(
       'geo_identity', 'geo.find_login_identity_by_user(uuid)', 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'geo' AND relation.relkind IN ('r', 'p')
         AND (
           has_table_privilege('geo_dispatcher', relation.oid, 'SELECT')
           OR has_table_privilege('geo_dispatcher', relation.oid, 'INSERT')
           OR has_table_privilege('geo_dispatcher', relation.oid, 'UPDATE')
           OR has_table_privilege('geo_dispatcher', relation.oid, 'DELETE')
           OR has_table_privilege('geo_identity', relation.oid, 'SELECT')
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc AS function_row
       JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
       WHERE namespace.nspname = 'geo'
         AND function_row.oid NOT IN (
           'geo.find_login_identity(text)'::regprocedure,
           'geo.find_login_identity_by_user(uuid)'::regprocedure
         )
         AND has_function_privilege('geo_identity', function_row.oid, 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'application ACL reconciliation failed';
  END IF;
END
$verify$;

COMMIT;
