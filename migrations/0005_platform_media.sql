ALTER TABLE library ADD COLUMN platform TEXT NOT NULL DEFAULT 'youtube';
ALTER TABLE library ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
UPDATE library SET source_id=youtube_id;
ALTER TABLE library ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'embed';
ALTER TABLE library ADD COLUMN media_key TEXT;
ALTER TABLE library ADD COLUMN import_progress TEXT;
ALTER TABLE library ADD COLUMN import_attempt INTEGER NOT NULL DEFAULT 0;
