BEGIN;

UPDATE geo.channel_accounts
SET status = 'active'
WHERE status = 'needs_verification';

ALTER TABLE geo.channel_accounts
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE geo.channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_status_check;

ALTER TABLE geo.channel_accounts
  ADD CONSTRAINT channel_accounts_status_check
    CHECK (status IN ('active', 'disabled'));

COMMIT;
