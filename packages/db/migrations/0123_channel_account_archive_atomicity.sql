BEGIN;

UPDATE geo.channel_accounts
SET status = 'disabled'
WHERE archived_at IS NOT NULL
  AND status <> 'disabled';

CREATE OR REPLACE FUNCTION geo.enforce_channel_account_archive_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL
     AND (
       NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NEW.status <> 'disabled'
     ) THEN
    RAISE EXCEPTION 'archived channel account state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.archived_at IS NOT NULL AND NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'archived channel account must remain disabled'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_channel_account_archive_monotonicity() FROM PUBLIC;

DROP TRIGGER IF EXISTS channel_accounts_archive_is_monotonic ON geo.channel_accounts;
CREATE TRIGGER channel_accounts_archive_is_monotonic
BEFORE UPDATE OF archived_at, status ON geo.channel_accounts
FOR EACH ROW
EXECUTE FUNCTION geo.enforce_channel_account_archive_monotonicity();

-- Pending-target reassignment predates account archival. Patch the currently
-- installed definition so later unattended-browser and quota changes remain
-- intact while account eligibility is serialized with archival.
DO $$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.reassign_pending_automation_target(uuid,uuid,uuid)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $old$    AND account.id = p_channel_account_id;$old$,
    $new$    AND account.id = p_channel_account_id
    AND account.archived_at IS NULL
  FOR SHARE OF account;$new$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'automation reassignment archive guard found no changes';
  END IF;
  EXECUTE updated_definition;

  SELECT pg_get_functiondef(
    'geo.publication_assisted_block_reason(uuid)'::regprocedure
  ) INTO definition;
  updated_definition := replace(
    definition,
    $old$    AND channel_account.id = job.channel_account_id;$old$,
    $new$    AND channel_account.id = job.channel_account_id
    AND channel_account.archived_at IS NULL;$new$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'assisted publication archive guard found no changes';
  END IF;
  EXECUTE updated_definition;
END
$$;

-- Every publication path converges on publication_jobs. Recheck the account at
-- that final write boundary while holding a row lock shared with other readers
-- and conflicting with account archival.
CREATE OR REPLACE FUNCTION geo.enforce_publication_job_live_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  account_row geo.channel_accounts%ROWTYPE;
BEGIN
  SELECT account.* INTO account_row
  FROM geo.channel_accounts AS account
  WHERE account.tenant_id = NEW.tenant_id
    AND account.id = NEW.channel_account_id
    AND account.archived_at IS NULL
  FOR SHARE OF account;

  IF account_row.id IS NULL
     OR account_row.status <> 'active'
     OR account_row.platform <> NEW.platform THEN
    RAISE EXCEPTION 'publication job requires an active unarchived channel account'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION geo.enforce_publication_job_live_account() FROM PUBLIC;

DROP TRIGGER IF EXISTS publication_jobs_require_live_account ON geo.publication_jobs;
CREATE TRIGGER publication_jobs_require_live_account
BEFORE INSERT ON geo.publication_jobs
FOR EACH ROW
EXECUTE FUNCTION geo.enforce_publication_job_live_account();

COMMIT;
