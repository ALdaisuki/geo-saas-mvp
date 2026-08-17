BEGIN;

-- Historical duplicate protection is tenant-wide even though each imported
-- publication retains the account that originally published it. A sibling
-- Ctrip account must not require a fabricated copy of the protected article
-- before it can use the shared tenant publication history.
CREATE OR REPLACE FUNCTION geo.ctrip_protected_history_baseline_bound(
  p_channel_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, geo
AS $$
DECLARE
  tenant_value uuid := geo.require_tenant_id();
BEGIN
  PERFORM geo.require_actor_id();
  IF p_channel_account_id IS NULL THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM geo.channel_accounts AS account
    WHERE account.tenant_id = tenant_value
      AND account.id = p_channel_account_id
      AND account.platform = 'ctrip_community'
  ) AND EXISTS (
    SELECT 1
    FROM geo.historical_publications AS history
    WHERE history.tenant_id = tenant_value
      AND history.platform = 'ctrip_community'
      AND history.external_id = '123450005'
      AND history.external_url =
        'https://m.ctrip.com/webapp/you/community/detail?articleId=123450005'
  );
END
$$;

REVOKE ALL ON FUNCTION geo.ctrip_protected_history_baseline_bound(uuid)
  FROM PUBLIC, geo_runtime, geo_dispatcher, geo_identity;

COMMENT ON FUNCTION geo.ctrip_protected_history_baseline_bound(uuid) IS
  'Reports whether a tenant Ctrip account can use the tenant-wide protected publication history baseline.';

COMMIT;
