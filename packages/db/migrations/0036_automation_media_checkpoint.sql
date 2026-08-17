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
    $$IF run_row.stage NOT IN ('planning', 'draft') THEN
    RAISE EXCEPTION 'draft checkpoint cannot follow stage %', run_row.stage
      USING ERRCODE = '55000';
  END IF;$$,
    $$IF run_row.stage NOT IN ('planning', 'draft') OR
       (run_row.stage = 'draft' AND coalesce(p_checkpoint->>'stage', '') <> 'media') THEN
    RAISE EXCEPTION 'draft checkpoint cannot follow stage %', run_row.stage
      USING ERRCODE = '55000';
  END IF;$$
  );
  IF updated_definition = definition AND position('coalesce(p_checkpoint->>''stage'', '''') <> ''media''' IN definition) = 0 THEN
    RAISE EXCEPTION 'automation draft stage gate was not found';
  END IF;

  updated_definition := replace(
    updated_definition,
    $$IF (run_row.content_item_id IS NOT NULL AND run_row.content_item_id <> p_content_item_id) OR
      (run_row.content_version_id IS NOT NULL AND
       run_row.content_version_id <> p_content_version_id) THEN
    RAISE EXCEPTION 'draft checkpoint conflicts with previously bound content'
      USING ERRCODE = '23505';
  END IF;$$,
    $$IF (run_row.content_item_id IS NOT NULL AND run_row.content_item_id <> p_content_item_id) OR
      (run_row.content_version_id IS NOT NULL AND
       run_row.content_version_id <> p_content_version_id AND
       coalesce(p_checkpoint->>'stage', '') <> 'media') THEN
    RAISE EXCEPTION 'draft checkpoint conflicts with previously bound content'
      USING ERRCODE = '23505';
  END IF;$$
  );
  IF updated_definition = definition AND position('coalesce(p_checkpoint->>''stage'', '''') <> ''media''' IN definition) = 0 THEN
    RAISE EXCEPTION 'automation draft content binding was not found';
  END IF;
  EXECUTE updated_definition;
END
$migration$;
