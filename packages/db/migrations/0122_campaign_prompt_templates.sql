BEGIN;

ALTER TABLE geo.campaigns
  ADD COLUMN prompt_template text
  CHECK (prompt_template IS NULL OR length(prompt_template) BETWEEN 1 AND 20000);

-- The scheduler needs the customer prompt template so every plan-slot brief can
-- carry the same customer-authored generation guidance as manual batches.
DROP FUNCTION IF EXISTS geo.list_due_campaign_automation_plans(timestamptz);

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
  campaign_objective text,
  campaign_prompt_template text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
  SELECT plan.tenant_id, plan.id, plan.campaign_id, plan.actor_id,
         plan.execution_level, plan.platforms, plan.slot_count,
         plan.interval_minutes, plan.daily_times, plan.timezone,
         plan.next_run_at, campaign.name, campaign.topic_key, campaign.objective,
         campaign.prompt_template
  FROM geo.campaign_automation_plans AS plan
  JOIN geo.campaigns AS campaign
    ON campaign.tenant_id = plan.tenant_id AND campaign.id = plan.campaign_id
  WHERE plan.enabled
    AND campaign.status = 'active'
    AND plan.next_run_at IS NOT NULL
    AND plan.next_run_at <= p_now
  ORDER BY plan.next_run_at, plan.tenant_id, plan.id
$$;

REVOKE ALL ON FUNCTION geo.list_due_campaign_automation_plans(timestamptz)
  FROM PUBLIC, geo_dispatcher;
GRANT EXECUTE ON FUNCTION geo.list_due_campaign_automation_plans(timestamptz)
  TO geo_runtime;

COMMIT;
