BEGIN;

ALTER TABLE geo.ctrip_account_analytics_snapshots
  ADD COLUMN total_favorites bigint CHECK (total_favorites >= 0);

COMMIT;
