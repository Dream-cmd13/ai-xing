-- Incremental update to fix column naming consistency
-- Rename displayName to display_name to follow snake_case convention and avoid case-sensitivity issues in PostgREST

DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='enterprises' AND column_name='displayname') THEN
    ALTER TABLE enterprises RENAME COLUMN displayname TO display_name;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='enterprises' AND column_name='display_name') THEN
    ALTER TABLE enterprises ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Unknown Enterprise';
  END IF;
END $$;
