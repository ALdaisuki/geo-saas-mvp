DO $migration$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'geo.checkpoint_automation_draft(uuid,text,integer,uuid,uuid,jsonb,integer)'::regprocedure
  ) INTO definition;

  updated_definition := regexp_replace(
    definition,
    E'IF \\(run_row\\.content_item_id IS NOT NULL AND run_row\\.content_item_id <> p_content_item_id\\) OR\\s*\\(run_row\\.content_version_id IS NOT NULL AND\\s*run_row\\.content_version_id <> p_content_version_id\\) THEN',
    $$IF (run_row.content_item_id IS NOT NULL AND run_row.content_item_id <> p_content_item_id) OR
     (run_row.content_version_id IS NOT NULL AND
      run_row.content_version_id <> p_content_version_id AND
      coalesce(p_checkpoint->>'stage', '') <> 'media') THEN$$
  );
  IF updated_definition = definition AND
     position('coalesce(p_checkpoint->>''stage'', '''') <> ''media''' IN definition) = 0 THEN
    RAISE EXCEPTION 'automation media content-binding gate was not found';
  END IF;

  EXECUTE updated_definition;
END
$migration$;
