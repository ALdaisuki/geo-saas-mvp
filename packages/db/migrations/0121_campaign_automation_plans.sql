BEGIN;

-- A campaign automation plan is the persisted, per-promotion default for
-- unattended delivery. Operators configure platforms, batch size, cadence and
-- daily run times once; the scheduler creates round-robin batches from it.
CREATE TABLE geo.campaign_automation_plans (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  execution_level text NOT NULL DEFAULT 'unattended'
    CHECK (execution_level IN ('dry_run', 'unattended')),
  platforms text[] NOT NULL DEFAULT ARRAY['toutiao', 'sohu', 'baijiahao', 'netease']
    CHECK (cardinality(platforms) BETWEEN 1 AND 5),
  slot_count integer NOT NULL DEFAULT 30
    CHECK (slot_count BETWEEN 1 AND 50),
  interval_minutes integer NOT NULL DEFAULT 15
    CHECK (interval_minutes BETWEEN 1 AND 1440),
  daily_times time[] NOT NULL DEFAULT ARRAY['09:00', '14:00', '20:00']::time[]
    CHECK (cardinality(daily_times) BETWEEN 1 AND 8),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (length(timezone) BETWEEN 1 AND 64),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_error_message text,
  run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, campaign_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES geo.campaigns (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX campaign_automation_plans_due_idx
  ON geo.campaign_automation_plans (enabled, next_run_at)
  WHERE enabled;

ALTER TABLE geo.campaign_automation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.campaign_automation_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.campaign_automation_plans TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TRIGGER campaign_automation_plans_updated_at
BEFORE UPDATE ON geo.campaign_automation_plans
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

-- The scheduler needs a tenant-agnostic view of due plans. The function is
-- SECURITY DEFINER and only exposes the immutable settings needed to create a
-- batch; every batch write still happens inside the tenant's own RLS context.
CREATE OR REPLACE FUNCTION geo.list_due_campaign_automation_plans(p_now timestamptz)
RETURNS TABLE (
  tenant_id uuid,
  plan_id uuid,
  campaign_id uuid,
  actor_id uuid,
  execution_level text,
  platforms text[],
  slot_count integer,
  interval_minutes integer,
  daily_times time[],
  timezone text,
  next_run_at timestamptz,
  campaign_name text,
  campaign_topic_key text,
  campaign_objective text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT plan.tenant_id, plan.id, plan.campaign_id, plan.actor_id,
         plan.execution_level, plan.platforms, plan.slot_count,
         plan.interval_minutes, plan.daily_times, plan.timezone,
         plan.next_run_at, campaign.name, campaign.topic_key, campaign.objective
  FROM geo.campaign_automation_plans AS plan
  JOIN geo.campaigns AS campaign
    ON campaign.tenant_id = plan.tenant_id AND campaign.id = plan.campaign_id
  WHERE plan.enabled
    AND campaign.status = 'active'
    AND plan.next_run_at IS NOT NULL
    AND plan.next_run_at <= p_now
  ORDER BY plan.next_run_at, plan.tenant_id, plan.id
$$;

REVOKE ALL ON TABLE geo.campaign_automation_plans FROM PUBLIC, geo_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.campaign_automation_plans TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.campaign_automation_plans FROM geo_runtime;

REVOKE ALL ON FUNCTION geo.list_due_campaign_automation_plans(timestamptz)
  FROM PUBLIC, geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.list_due_campaign_automation_plans(timestamptz)
  TO geo_runtime;

COMMIT;
