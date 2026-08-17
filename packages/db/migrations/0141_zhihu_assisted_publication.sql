BEGIN;

-- Zhihu is now admitted to the generic browser-assisted publication lineage.
-- The first release is intentionally assisted-only; unattended execution stays
-- closed until a real public readback is captured and reviewed.
DO $constraints$
DECLARE
  table_name text;
  constraint_name text;
  platform_expression text :=
    'platform IN (''toutiao'', ''sohu'', ''baijiahao'', ''netease'', ''ctrip_community'', ''zhihu'')';
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'audit_artifacts',
    'automation_run_targets',
    'content_media_bindings',
    'media_generation_jobs',
    'publication_assisted_handoffs',
    'publication_grants',
    'publication_jobs',
    'publication_receipts',
    'publication_variants'
  ] LOOP
    constraint_name := CASE table_name
      WHEN 'audit_artifacts' THEN 'audit_artifacts_platform_check'
      WHEN 'automation_run_targets' THEN 'automation_run_targets_platform_check'
      WHEN 'content_media_bindings' THEN 'content_media_bindings_platform_check'
      WHEN 'media_generation_jobs' THEN 'media_generation_jobs_platform_check'
      WHEN 'publication_assisted_handoffs' THEN 'publication_assisted_handoffs_platform_check'
      WHEN 'publication_grants' THEN 'publication_grants_platform_check'
      WHEN 'publication_jobs' THEN 'publication_jobs_platform_check'
      WHEN 'publication_receipts' THEN 'publication_receipts_platform_check'
      WHEN 'publication_variants' THEN 'publication_variants_platform_check'
    END;
    EXECUTE format('ALTER TABLE geo.%I DROP CONSTRAINT IF EXISTS %I', table_name, constraint_name);
    EXECUTE format(
      'ALTER TABLE geo.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
      table_name,
      constraint_name,
      platform_expression
    );
    EXECUTE format('ALTER TABLE geo.%I VALIDATE CONSTRAINT %I', table_name, constraint_name);
  END LOOP;

  ALTER TABLE geo.media_assets
    DROP CONSTRAINT IF EXISTS media_assets_platform;
  ALTER TABLE geo.media_assets
    ADD CONSTRAINT media_assets_platform CHECK (
      platform IS NULL OR
      platform IN ('toutiao', 'sohu', 'baijiahao', 'netease', 'ctrip_community', 'zhihu')
    ) NOT VALID;
  ALTER TABLE geo.media_assets VALIDATE CONSTRAINT media_assets_platform;

  ALTER TABLE geo.campaign_automation_plans
    DROP CONSTRAINT IF EXISTS campaign_automation_plans_platforms_check;
  ALTER TABLE geo.campaign_automation_plans
    ADD CONSTRAINT campaign_automation_plans_platforms_check CHECK (
      cardinality(platforms) >= 1 AND cardinality(platforms) <= 6
    ) NOT VALID;
  ALTER TABLE geo.campaign_automation_plans
    VALIDATE CONSTRAINT campaign_automation_plans_platforms_check;
END
$constraints$;

CREATE OR REPLACE FUNCTION geo.browser_publication_identity_allowed(
  p_platform text,
  p_external_id text,
  p_external_url text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
SET search_path = pg_catalog, geo
AS $$
  SELECT CASE p_platform
    WHEN 'toutiao' THEN p_external_id ~ '^[0-9]{10,30}$' AND p_external_url = 'https://www.toutiao.com/article/' || p_external_id || '/'
    WHEN 'sohu' THEN p_external_id ~ '^[1-9][0-9]{0,29}_[1-9][0-9]{0,29}$' AND p_external_url = 'https://www.sohu.com/a/' || p_external_id
    WHEN 'baijiahao' THEN p_external_id ~ '^[0-9]{10,30}$' AND p_external_url = 'https://baijiahao.baidu.com/s?id=' || p_external_id
    WHEN 'netease' THEN p_external_id ~ '^[A-Z0-9]{8,32}$' AND p_external_url = 'https://www.163.com/dy/article/' || p_external_id || '.html'
    WHEN 'ctrip_community' THEN p_external_id ~ '^[0-9]{1,20}$' AND p_external_url = 'https://m.ctrip.com/webapp/you/community/detail?articleId=' || p_external_id
    WHEN 'zhihu' THEN p_external_id ~ '^[1-9][0-9]{5,19}$' AND p_external_url = 'https://zhuanlan.zhihu.com/p/' || p_external_id
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION geo.publication_public_url_matches_platform(
  p_platform text,
  p_url text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, geo
AS $$
  SELECT CASE p_platform
    WHEN 'ctrip_community' THEN p_url ~ '^https://m\.ctrip\.com/webapp/you/community/detail\?articleId=[0-9]{1,20}$'
    WHEN 'toutiao' THEN p_url ~ '^https://www\.toutiao\.com/article/[0-9]{10,30}/$'
    WHEN 'sohu' THEN p_url ~ '^https://www\.sohu\.com/a/[1-9][0-9]{0,29}_[1-9][0-9]{0,29}$'
    WHEN 'baijiahao' THEN p_url ~ '^https://baijiahao\.baidu\.com/s\?id=[0-9]{10,30}$'
    WHEN 'netease' THEN p_url ~ '^https://www\.163\.com/dy/article/[A-Z0-9]{8,32}\.html$'
    WHEN 'zhihu' THEN p_url ~ '^https://zhuanlan\.zhihu\.com/p/[1-9][0-9]{5,19}$'
    ELSE false
  END
$$;

-- Keep platform admission synchronized with the table constraints while
-- retaining the existing unattended restriction to the reviewed Ctrip path.
DO $functions$
DECLARE
  function_oid oid;
  definition text;
  old_list text := '''toutiao'', ''sohu'', ''baijiahao'', ''netease'', ''ctrip_community''';
  new_list text := '''toutiao'', ''sohu'', ''baijiahao'', ''netease'', ''ctrip_community'', ''zhihu''';
BEGIN
  FOR function_oid IN
    SELECT p.oid
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'geo'
      AND p.proname IN (
        'publication_assisted_block_reason',
        'consume_browser_assisted_publication_grant'
      )
  LOOP
    SELECT pg_get_functiondef(function_oid) INTO definition;
    IF position(old_list IN definition) > 0 THEN
      EXECUTE replace(definition, old_list, new_list);
    END IF;
  END LOOP;
END
$functions$;

COMMIT;
