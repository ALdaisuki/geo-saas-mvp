CREATE TABLE geo.automation_template_rotation_cursors (
  tenant_id uuid NOT NULL REFERENCES geo.tenants (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  next_index integer NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, campaign_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES geo.campaigns (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE geo.automation_template_rotation_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo.automation_template_rotation_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON geo.automation_template_rotation_cursors TO geo_runtime
  USING (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL)
  WITH CHECK (tenant_id = geo.current_tenant_id() AND geo.current_actor_id() IS NOT NULL);

CREATE TRIGGER automation_template_rotation_cursors_updated_at
BEFORE UPDATE ON geo.automation_template_rotation_cursors
FOR EACH ROW EXECUTE FUNCTION geo.set_updated_at();

ALTER TABLE geo.automation_runs
  ADD COLUMN diversity_rotation_index integer NOT NULL DEFAULT 0
    CHECK (diversity_rotation_index >= 0);

REVOKE ALL ON TABLE geo.automation_template_rotation_cursors FROM PUBLIC, geo_dispatcher;
GRANT SELECT, INSERT, UPDATE ON TABLE geo.automation_template_rotation_cursors TO geo_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE geo.automation_template_rotation_cursors FROM geo_runtime;
