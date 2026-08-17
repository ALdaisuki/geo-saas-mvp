BEGIN;

DO $migration$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_draft(uuid,text,integer,uuid,uuid,jsonb,integer)'::regprocedure
  ) INTO definition;

  updated_definition := replace(
    definition,
    $$IF (run_row.content_item_id IS NOT NULL AND run_row.content_item_id <> p_content_item_id) OR
     (run_row.content_version_id IS NOT NULL AND
      run_row.content_version_id <> p_content_version_id AND
      coalesce(p_checkpoint->>'stage', '') <> 'media') THEN$$,
    $$IF (run_row.content_item_id IS NOT NULL AND
      run_row.content_item_id <> p_content_item_id AND
      coalesce(p_checkpoint->>'stage', '') <> 'media') OR
     (run_row.content_version_id IS NOT NULL AND
      run_row.content_version_id <> p_content_version_id AND
      coalesce(p_checkpoint->>'stage', '') <> 'media') THEN$$
  );
  IF updated_definition = definition THEN
    RAISE EXCEPTION 'automation media content-item binding gate was not found';
  END IF;

  EXECUTE updated_definition;
END
$migration$;

COMMIT;
