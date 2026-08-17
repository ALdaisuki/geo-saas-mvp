BEGIN;

ALTER TABLE geo.channel_accounts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS channel_accounts_visible_idx
  ON geo.channel_accounts (tenant_id, platform, display_name)
  WHERE archived_at IS NULL;

COMMIT;
