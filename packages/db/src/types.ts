import type { ColumnType, Generated } from "kysely";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type DbTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type RequiredDbTimestamp = ColumnType<Date, Date | string, Date | string>;
export type NullableDbTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type JsonColumn<T extends JsonValue = JsonValue> = ColumnType<
  T,
  T | string | undefined,
  T | string
>;
export type TextArrayColumn = ColumnType<string[], string[] | undefined, string[]>;
export type NumericColumn = ColumnType<string, string | number, string | number>;
export type NullableNumericColumn = ColumnType<
  string | null,
  string | number | null | undefined,
  string | number | null
>;

interface TenantRow {
  tenant_id: string;
  id: Generated<string>;
}

interface CreatedRow {
  created_at: DbTimestamp;
}

interface MutableRow extends CreatedRow {
  updated_at: DbTimestamp;
}

export interface UsersTable extends MutableRow {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  status: Generated<"active" | "disabled">;
}

export interface TenantsTable extends MutableRow {
  id: Generated<string>;
  slug: string;
  legal_name: string;
  display_name: string;
  industry: string;
  status: Generated<"active" | "suspended" | "closed">;
  default_locale: Generated<string>;
}

export interface TenantMembershipsTable extends TenantRow, CreatedRow {
  user_id: string;
  role: "owner" | "admin" | "editor" | "auditor" | "publisher" | "viewer";
  capabilities: JsonColumn<JsonValue[]>;
  status: Generated<"active" | "suspended">;
}

export interface ServicePrincipalsTable extends TenantRow, MutableRow {
  name: string;
  kind: "api" | "worker" | "agent" | "integration";
  profile: "custom" | "automation_producer" | "ctrip_bridge";
  capabilities: JsonColumn<JsonValue[]>;
  status: Generated<"active" | "disabled">;
  last_used_at: NullableDbTimestamp;
}

export interface ApiKeysTable extends TenantRow, CreatedRow {
  service_principal_id: string;
  key_prefix: string;
  secret_hash: string;
  expires_at: NullableDbTimestamp;
  revoked_at: NullableDbTimestamp;
}

export interface SessionsTable extends TenantRow, CreatedRow {
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  expires_at: RequiredDbTimestamp;
  last_seen_at: DbTimestamp;
  revoked_at: NullableDbTimestamp;
}

export interface BrandsTable extends TenantRow, MutableRow {
  canonical_name: string;
  display_name: string;
  aliases: JsonColumn<JsonValue[]>;
  description: string | null;
  industry: string;
  website_url: string | null;
  is_primary: Generated<boolean>;
}

export interface BrandAgentProfilesTable extends TenantRow, CreatedRow {
  brand_id: string;
  version: number;
  status: "active" | "retired";
  document: JsonColumn<JsonObject>;
  document_hash: string;
  created_by_actor_id: string;
  effective_at: RequiredDbTimestamp;
  retired_at: NullableDbTimestamp;
}

export interface BrandCompetitorsTable extends TenantRow, CreatedRow {
  brand_id: string;
  canonical_name: string;
  display_name: string;
  aliases: JsonColumn<JsonValue[]>;
  source_type: "tenant_configured" | "verified_public" | "manual_import";
  source_ref: string;
  valid_from: DbTimestamp;
  valid_until: NullableDbTimestamp;
}

export interface TenantContactsTable extends TenantRow, CreatedRow {
  type: "phone" | "wechat" | "email" | "website" | "address";
  label: string;
  value: string;
  normalized_value: string;
  is_primary: Generated<boolean>;
  valid_from: DbTimestamp;
  valid_until: NullableDbTimestamp;
  metadata: JsonColumn<JsonObject>;
}

export interface PolicyBundlesTable extends TenantRow, CreatedRow {
  version: string;
  status: "draft" | "active" | "retired";
  policy_hash: string;
  document: JsonColumn<JsonObject>;
  effective_at: RequiredDbTimestamp;
  retired_at: NullableDbTimestamp;
}

export interface AutomationControlsTable extends TenantRow, MutableRow {
  scope_type: "tenant" | "platform" | "account" | "campaign" | "topic";
  scope_key: Generated<string>;
  mode: "shadow" | "supervised" | "unattended" | "paused" | "stopped";
  quota: JsonColumn<JsonObject>;
  kill_switch_enabled: Generated<boolean>;
  reason: string | null;
}

export interface AutomationBatchesTable extends TenantRow, MutableRow {
  campaign_id: string;
  idempotency_key: string;
  request_hash: string;
  state: Generated<"scheduled" | "running" | "completed" | "partially_failed" | "cancelled">;
  execution_level: Generated<"dry_run">;
  scheduled_for: DbTimestamp;
  configuration: JsonColumn<JsonObject>;
  created_by_actor_id: string;
  started_at: NullableDbTimestamp;
  completed_at: NullableDbTimestamp;
  cancelled_at: NullableDbTimestamp;
  cancelled_by_actor_id: string | null;
  cancellation_reason: string | null;
}

export interface AutomationRunsTable extends TenantRow, MutableRow {
  batch_id: string;
  campaign_id: string;
  slot_key: string;
  topic_key: string;
  brief: JsonColumn<JsonObject>;
  idempotency_key: string;
  request_hash: string;
  state: Generated<
    | "scheduled"
    | "running"
    | "retry_wait"
    | "awaiting_delivery"
    | "completed"
    | "partially_failed"
    | "blocked"
    | "failed"
    | "cancelled"
  >;
  stage: Generated<"planning" | "draft" | "targets" | "delivery">;
  available_at: DbTimestamp;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  lease_owner: string | null;
  lease_expires_at: NullableDbTimestamp;
  heartbeat_at: NullableDbTimestamp;
  checkpoint: JsonColumn<JsonObject>;
  content_item_id: string | null;
  content_version_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  completed_at: NullableDbTimestamp;
  cancelled_at: NullableDbTimestamp;
  cancelled_by_actor_id: string | null;
  cancellation_reason: string | null;
}

export interface AutomationRunTargetsTable extends TenantRow, MutableRow {
  run_id: string;
  channel_account_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  state: Generated<
    | "pending"
    | "variant_ready"
    | "audit_failed"
    | "awaiting_delivery"
    | "preview_completed"
    | "confirmed"
    | "blocked"
    | "failed"
    | "cancelled"
  >;
  variant_id: string | null;
  audit_run_id: string | null;
  audit_artifact_id: string | null;
  publication_job_id: string | null;
  variant_idempotency_key: string;
  audit_idempotency_key: string;
  publication_idempotency_key: string;
  last_error_code: string | null;
  last_error_message: string | null;
  completed_at: NullableDbTimestamp;
  cancelled_at: NullableDbTimestamp;
}

export interface ChannelAccountsTable extends TenantRow, MutableRow {
  platform: "toutiao" | "sohu" | "ctrip_community";
  display_name: string;
  capability: "public_api" | "partner_api" | "browser_assisted" | "manual_only" | "disabled";
  supported_execution_levels: TextArrayColumn;
  credential_ref: string | null;
  capability_evidence_type:
    | "fixture"
    | "preview"
    | "manual_import"
    | "browser_screenshot"
    | "api_response"
    | "platform_readback";
  capability_evidence_refs: JsonColumn<JsonValue[]>;
  status: Generated<"active" | "disabled" | "needs_verification">;
  last_verified_at: NullableDbTimestamp;
}

export interface CampaignsTable extends TenantRow, MutableRow {
  brand_id: string;
  name: string;
  objective: string;
  industry: string;
  status: Generated<"draft" | "active" | "paused" | "completed">;
  topic_key: string;
  starts_at: NullableDbTimestamp;
  ends_at: NullableDbTimestamp;
}

export interface ClaimFactsTable extends TenantRow, MutableRow {
  brand_id: string;
  normalized_key: string;
  claim: string;
  status: Generated<"draft" | "verified" | "rejected" | "expired">;
  evidence_refs: JsonColumn<JsonValue[]>;
  valid_from: DbTimestamp;
  valid_until: NullableDbTimestamp;
}

export interface EvidenceSourcesTable extends TenantRow, CreatedRow {
  type: "url" | "document" | "manual" | "platform_readback";
  title: string;
  source_url: string | null;
  content_hash: string;
  content_text: string | null;
  captured_at: RequiredDbTimestamp;
  valid_until: NullableDbTimestamp;
  metadata: JsonColumn<JsonObject>;
}

export interface ResearchSourcePoliciesTable extends TenantRow, CreatedRow {
  source_key: string;
  version: number;
  display_name: string;
  origin: string;
  allowed_hosts: TextArrayColumn;
  user_agent: string;
  max_bytes: number;
  robots_max_bytes: number;
  timeout_ms: number;
  max_redirects: number;
  max_discovered_urls: number;
  respect_robots: Generated<true>;
  status: Generated<"active" | "retired">;
  created_by_actor_id: string;
  retired_by_actor_id: string | null;
  retirement_reason: string | null;
  retired_at: NullableDbTimestamp;
}

export interface ResearchCaptureRecordsTable extends TenantRow, CreatedRow {
  source_policy_id: string;
  operation: "page_capture" | "sitemap_discovery";
  status: "succeeded" | "failed";
  request_url_hash: string;
  evidence_source_id: string | null;
  error_code: string | null;
  result_metadata: JsonColumn<JsonObject>;
  captured_by_actor_id: string;
  started_at: RequiredDbTimestamp;
  completed_at: RequiredDbTimestamp;
}

export interface ContentItemsTable extends TenantRow, MutableRow {
  campaign_id: string;
  brand_id: string;
  title: string;
  content_type:
    "question_answer" | "guide" | "evidence" | "local_service" | "comparison" | "risk_avoidance";
  state: Generated<
    | "draft"
    | "ready_for_audit"
    | "audited"
    | "approved"
    | "queued"
    | "publishing"
    | "published"
    | "failed"
    | "blocked"
    | "withdrawn"
  >;
  topic_key: string;
}

export interface ContentVersionsTable extends TenantRow, CreatedRow {
  content_item_id: string;
  version: number;
  summary: string;
  body_markdown: string;
  payload: JsonColumn<JsonObject>;
  payload_hash: string;
  created_by_actor_id: string;
  frozen_at: NullableDbTimestamp;
}

export interface MediaGenerationJobsTable extends TenantRow, MutableRow {
  content_version_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  role: "cover" | "inline";
  fact_ids: TextArrayColumn;
  visual_brief: JsonColumn<JsonObject>;
  visual_brief_hash: string;
  request_hash: string;
  idempotency_key: string;
  provider_id: string;
  provider_mode: "fixture" | "live";
  state: Generated<"pending" | "running" | "succeeded" | "failed" | "cancelled">;
  attempt_count: Generated<number>;
  lease_owner: string | null;
  lease_expires_at: NullableDbTimestamp;
  asset_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by_actor_id: string;
  completed_at: NullableDbTimestamp;
}

export interface MediaGenerationAttemptsTable extends TenantRow, CreatedRow {
  job_id: string;
  attempt_no: number;
  status: "succeeded" | "failed" | "timed_out";
  provider_id: string;
  provider_mode: "fixture" | "live";
  model: string;
  input_hash: string;
  request_hash: string;
  response_hash: string | null;
  output_sha256: string | null;
  provider_request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: RequiredDbTimestamp;
  finished_at: NullableDbTimestamp;
}

export interface MediaAssetsTable extends TenantRow, CreatedRow {
  content_version_id: string | null;
  job_id: string | null;
  sha256: string;
  source_class: "generated" | "licensed_stock" | "tenant_owned" | "legacy";
  provenance_hash: string;
  mime_type: string;
  byte_length: NullableNumericColumn;
  width: number | null;
  height: number | null;
  platform: "toutiao" | "sohu" | "ctrip_community" | null;
  role: "cover" | "inline" | null;
  storage_key: string;
  alt_text: string;
  caption: string;
  fact_ids: TextArrayColumn;
  visual_brief: JsonColumn<JsonObject> | null;
  visual_brief_hash: string | null;
  rights: JsonColumn<JsonObject>;
  provenance: JsonColumn<JsonObject>;
  source_url: string | null;
  metadata: JsonColumn<JsonObject>;
}

export interface ContentMediaBindingsTable extends TenantRow, CreatedRow {
  content_version_id: string;
  media_asset_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  role: "cover" | "inline";
  position: number;
  alt_text: string;
  caption: string;
}

export interface MediaInspectionsTable extends TenantRow, CreatedRow {
  media_asset_id: string;
  asset_sha256: string;
  status: "passed" | "failed";
  evaluator: string;
  evaluator_mode: "fixture" | "live";
  evaluator_version: string;
  response_sha256: string;
  inspected_at: RequiredDbTimestamp;
  ocr_text: string;
  labels: JsonColumn<JsonValue[]>;
}

export interface PublicationVariantsTable extends TenantRow, CreatedRow {
  content_version_id: string;
  channel_account_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  variant_version: number;
  payload: JsonColumn<JsonObject>;
  payload_hash: string;
  state: Generated<"draft" | "frozen" | "superseded">;
  frozen_at: NullableDbTimestamp;
}

export interface AuditRunsTable extends TenantRow, CreatedRow {
  variant_id: string;
  policy_bundle_id: string;
  status: "running" | "passed" | "failed" | "errored";
  requested_by_actor_id: string;
  started_at: DbTimestamp;
  completed_at: NullableDbTimestamp;
  error_code: string | null;
  error_message: string | null;
}

export interface AuditArtifactsTable extends TenantRow {
  audit_run_id: string;
  variant_id: string;
  channel_account_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  payload_hash: string;
  fact_snapshot_hash: string;
  brand_snapshot_hash: string;
  media_snapshot_hash: string;
  policy_hash: string;
  policy_version: string;
  audit_hash: string;
  status: "passed" | "failed" | "errored";
  findings: JsonColumn<JsonValue[]>;
  created_at: DbTimestamp;
  expires_at: RequiredDbTimestamp;
}

export interface PublicationGrantsTable extends TenantRow {
  audit_artifact_id: string;
  variant_id: string;
  channel_account_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  payload_hash: string;
  audit_hash: string;
  token_hash: string;
  status: Generated<"issued" | "consumed" | "expired" | "revoked">;
  issued_at: DbTimestamp;
  expires_at: RequiredDbTimestamp;
  consumed_at: NullableDbTimestamp;
  consumed_by_actor_id: string | null;
  revoked_at: NullableDbTimestamp;
  revoked_by_actor_id: string | null;
  revocation_reason: string | null;
}

export interface AuditLogTable extends TenantRow {
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string;
  before_hash: string | null;
  after_hash: string | null;
  details: JsonColumn<JsonObject>;
  created_at: DbTimestamp;
}

export interface PublicationJobsTable extends TenantRow, MutableRow {
  grant_id: string;
  audit_artifact_id: string;
  variant_id: string;
  channel_account_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  execution_level: "dry_run" | "assisted" | "unattended";
  state:
    | "queued"
    | "dispatching"
    | "retry_wait"
    | "uncertain"
    | "reconciling"
    | "preview_completed"
    | "confirmed"
    | "needs_review"
    | "permanent_failure"
    | "cancelled";
  idempotency_key: string;
  request_hash: string;
  payload_hash: string;
  scheduled_for: RequiredDbTimestamp;
  available_at: DbTimestamp;
  lease_owner: string | null;
  lease_expires_at: NullableDbTimestamp;
  preview_completed_at: NullableDbTimestamp;
  confirmed_at: NullableDbTimestamp;
  cancelled_at: NullableDbTimestamp;
  cancelled_by_actor_id: string | null;
  cancellation_reason: string | null;
  last_error_code: string | null;
}

export interface PublicationAttemptsTable extends TenantRow {
  job_id: string;
  attempt_no: number;
  state: "started" | "succeeded" | "failed" | "uncertain" | "reconciled";
  worker_id: string | null;
  half_open_probe: Generated<boolean>;
  request_hash: string;
  response_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: DbTimestamp;
  finished_at: NullableDbTimestamp;
  governance_finished_at: NullableDbTimestamp;
  created_at: DbTimestamp;
}

export interface PublicationReceiptsTable extends TenantRow {
  job_id: string;
  attempt_id: string;
  platform: "toutiao" | "sohu" | "ctrip_community";
  execution_level: "dry_run" | "assisted" | "unattended";
  evidence_type:
    | "fixture"
    | "preview"
    | "manual_import"
    | "browser_screenshot"
    | "api_response"
    | "platform_readback";
  request_hash: string;
  response_hash: string;
  external_id: string | null;
  external_url: string | null;
  published_at: NullableDbTimestamp;
  recorded_at: DbTimestamp;
  confirmed: Generated<boolean>;
  payload: JsonColumn<JsonObject>;
}

export interface PublicationReadbacksTable extends TenantRow, MutableRow {
  job_id: string;
  receipt_id: string;
  execution_level: "dry_run" | "assisted" | "unattended";
  status: "not_required" | "pending" | "processing" | "succeeded" | "failed" | "cancelled";
  required: boolean;
  reason: string | null;
  scheduled_for: RequiredDbTimestamp;
  completed_at: NullableDbTimestamp;
  last_error: string | null;
}

export interface PublicationAssistedHandoffsTable extends TenantRow, MutableRow {
  job_id: string;
  attempt_id: string;
  channel_account_id: string;
  variant_id: string;
  platform: "ctrip_community";
  state:
    | "handoff_pending"
    | "session_required"
    | "challenge_required"
    | "draft_prepared"
    | "awaiting_operator_submit"
    | "submitted_unconfirmed"
    | "readback_pending"
    | "confirmed"
    | "needs_review"
    | "cancelled"
    | "expired"
    | "failed";
  payload_hash: string;
  audit_hash: string;
  preview_hash: string;
  adapter_version: string;
  bridge_service_principal_id: string | null;
  idempotency_key: string;
  lease_owner_actor_id: string | null;
  lease_expires_at: NullableDbTimestamp;
  heartbeat_at: NullableDbTimestamp;
  session_evidence_hash: string | null;
  draft_evidence_hash: string | null;
  submit_evidence_hash: string | null;
  submit_permit_hash: string | null;
  submit_permit_expires_at: NullableDbTimestamp;
  submit_permit_consumed_at: NullableDbTimestamp;
  submit_permit_issued_by_actor_id: string | null;
  submit_permit_consumed_by_principal_id: string | null;
  submit_outcome: "accepted" | "uncertain" | "rejected" | null;
  submit_evidence_kind: "simulation" | "browser" | null;
  submit_observed_at: NullableDbTimestamp;
  publication_receipt_id: string | null;
  publication_readback_id: string | null;
  readback_outcome:
    "confirmed" | "not_found" | "mismatch" | "unavailable" | "simulation_only" | null;
  readback_evidence_kind: "simulation" | "browser" | "platform_readback" | null;
  readback_evidence_hash: string | null;
  readback_observed_at: NullableDbTimestamp;
  observed_payload_hash: string | null;
  external_draft_id: string | null;
  external_id: string | null;
  external_url: string | null;
  expires_at: RequiredDbTimestamp;
  cancelled_at: NullableDbTimestamp;
  cancelled_by_actor_id: string | null;
  cancellation_reason: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by_actor_id: string;
}

export interface OutboxEventsTable extends TenantRow {
  aggregate_type: string;
  aggregate_id: string;
  topic: string;
  payload: JsonColumn<JsonObject>;
  request_hash: string;
  idempotency_key: string;
  available_at: DbTimestamp;
  attempts: Generated<number>;
  locked_by: string | null;
  locked_until: NullableDbTimestamp;
  last_attempt_at: NullableDbTimestamp;
  published_at: NullableDbTimestamp;
  dead_lettered_at: NullableDbTimestamp;
  last_error: string | null;
  created_at: DbTimestamp;
}

export interface InboxEventsTable extends TenantRow {
  consumer: string;
  event_id: string;
  payload_hash: string;
  processed_at: DbTimestamp;
  created_at: DbTimestamp;
}

export interface IdempotencyRecordsTable extends TenantRow {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  response_resource_type: string;
  response_resource_id: string;
  created_at: DbTimestamp;
  expires_at: RequiredDbTimestamp;
}

export interface CircuitBreakersTable extends TenantRow {
  scope_type: "tenant" | "platform" | "account" | "campaign" | "topic";
  scope_key: Generated<string>;
  state: "closed" | "open" | "half_open";
  failure_count: Generated<number>;
  opened_at: NullableDbTimestamp;
  retry_at: NullableDbTimestamp;
  probe_attempt_id: string | null;
  probe_started_at: NullableDbTimestamp;
  reason: string | null;
  updated_at: DbTimestamp;
}

export interface QuerySetsTable extends TenantRow, MutableRow {
  name: string;
  industry: string;
  status: Generated<"draft" | "active" | "retired">;
  current_version: Generated<number>;
  description: string;
}

export interface QuerySetVersionsTable extends TenantRow, CreatedRow {
  query_set_id: string;
  version: number;
  prompts: JsonColumn<JsonValue[]>;
  prompt_hash: string;
  created_by_actor_id: string;
}

export interface VisibilityRunsTable extends TenantRow, CreatedRow {
  query_set_version_id: string;
  provider: "doubao" | "qwen";
  product_surface: string;
  model: string;
  search_mode: "on" | "off" | "unknown";
  observation_method: "fixture" | "manual" | "official_api" | "browser";
  status: "queued" | "running" | "completed" | "failed";
  locale: string;
  geo: string | null;
  started_at: NullableDbTimestamp;
  completed_at: NullableDbTimestamp;
  created_by_actor_id: string;
  error_message: string | null;
  metadata: JsonColumn<JsonObject>;
}

export interface VisibilityObservationsTable extends TenantRow {
  run_id: string;
  provider: "doubao" | "qwen";
  product_surface: string;
  model: string;
  search_mode: "on" | "off" | "unknown";
  observation_method: "fixture" | "manual" | "official_api" | "browser";
  prompt: string;
  prompt_version: string;
  locale: string;
  geo: string | null;
  raw_answer: string;
  cited_urls: JsonColumn<JsonValue[]>;
  evidence_hash: string;
  evidence_type:
    | "fixture"
    | "preview"
    | "manual_import"
    | "browser_screenshot"
    | "api_response"
    | "platform_readback";
  request_started_at: RequiredDbTimestamp;
  response_received_at: RequiredDbTimestamp;
  observed_at: RequiredDbTimestamp;
  brand_mentioned: boolean;
  answer_position: number | null;
  contact_accuracy: NumericColumn;
  competitor_mentions: JsonColumn<JsonValue[]>;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  hallucination_findings: JsonColumn<JsonValue[]>;
  harmful_error: boolean;
  extractor_version: string;
  evaluator_version: string;
  metadata: JsonColumn<JsonObject>;
  created_at: DbTimestamp;
}

export interface VisibilityMetricsTable extends TenantRow {
  run_id: string;
  metric_name: string;
  value: NumericColumn;
  sample_count: number;
  confidence_low: NullableNumericColumn;
  confidence_high: NullableNumericColumn;
  dimensions: JsonColumn<JsonObject>;
  created_at: DbTimestamp;
}

export interface TenantProvisioningReceiptsTable extends CreatedRow {
  id: Generated<string>;
  idempotency_key: string;
  request_hash: string;
  tenant_id: string;
  brand_id: string;
  worker_service_principal_id: string;
  policy_bundle_id: string;
  query_set_id: string;
  query_set_version_id: string;
  brand_agent_profile_id: string;
  brand_agent_profile_hash: string;
}

export interface Database {
  users: UsersTable;
  tenants: TenantsTable;
  tenant_memberships: TenantMembershipsTable;
  service_principals: ServicePrincipalsTable;
  api_keys: ApiKeysTable;
  sessions: SessionsTable;
  brands: BrandsTable;
  brand_agent_profiles: BrandAgentProfilesTable;
  brand_competitors: BrandCompetitorsTable;
  tenant_contacts: TenantContactsTable;
  policy_bundles: PolicyBundlesTable;
  automation_controls: AutomationControlsTable;
  automation_batches: AutomationBatchesTable;
  automation_runs: AutomationRunsTable;
  automation_run_targets: AutomationRunTargetsTable;
  channel_accounts: ChannelAccountsTable;
  campaigns: CampaignsTable;
  claim_facts: ClaimFactsTable;
  evidence_sources: EvidenceSourcesTable;
  research_source_policies: ResearchSourcePoliciesTable;
  research_capture_records: ResearchCaptureRecordsTable;
  content_items: ContentItemsTable;
  content_versions: ContentVersionsTable;
  media_generation_jobs: MediaGenerationJobsTable;
  media_generation_attempts: MediaGenerationAttemptsTable;
  media_assets: MediaAssetsTable;
  content_media_bindings: ContentMediaBindingsTable;
  media_inspections: MediaInspectionsTable;
  publication_variants: PublicationVariantsTable;
  audit_runs: AuditRunsTable;
  audit_artifacts: AuditArtifactsTable;
  publication_grants: PublicationGrantsTable;
  audit_log: AuditLogTable;
  publication_jobs: PublicationJobsTable;
  publication_attempts: PublicationAttemptsTable;
  publication_receipts: PublicationReceiptsTable;
  publication_readbacks: PublicationReadbacksTable;
  publication_assisted_handoffs: PublicationAssistedHandoffsTable;
  outbox_events: OutboxEventsTable;
  inbox_events: InboxEventsTable;
  idempotency_records: IdempotencyRecordsTable;
  circuit_breakers: CircuitBreakersTable;
  query_sets: QuerySetsTable;
  query_set_versions: QuerySetVersionsTable;
  visibility_runs: VisibilityRunsTable;
  visibility_observations: VisibilityObservationsTable;
  visibility_metrics: VisibilityMetricsTable;
  tenant_provisioning_receipts: TenantProvisioningReceiptsTable;
}

export const TENANT_TABLES = [
  "tenant_memberships",
  "service_principals",
  "api_keys",
  "sessions",
  "brands",
  "brand_agent_profiles",
  "brand_competitors",
  "tenant_contacts",
  "policy_bundles",
  "automation_controls",
  "automation_batches",
  "automation_runs",
  "automation_run_targets",
  "channel_accounts",
  "campaigns",
  "claim_facts",
  "evidence_sources",
  "research_source_policies",
  "research_capture_records",
  "content_items",
  "content_versions",
  "media_generation_jobs",
  "media_generation_attempts",
  "media_assets",
  "content_media_bindings",
  "media_inspections",
  "publication_variants",
  "audit_runs",
  "audit_artifacts",
  "publication_grants",
  "audit_log",
  "publication_jobs",
  "publication_attempts",
  "publication_receipts",
  "publication_readbacks",
  "publication_assisted_handoffs",
  "outbox_events",
  "inbox_events",
  "idempotency_records",
  "circuit_breakers",
  "query_sets",
  "query_set_versions",
  "visibility_runs",
  "visibility_observations",
  "visibility_metrics",
] as const satisfies readonly (keyof Database)[];

export type TenantTableName = (typeof TENANT_TABLES)[number];
