BEGIN;

ALTER TABLE geo.campaigns
  ADD COLUMN automation_remediation_enabled boolean NOT NULL DEFAULT true;

COMMIT;
