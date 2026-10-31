ALTER TABLE learning_records ADD COLUMN source_question_id TEXT REFERENCES learning_questions(id) ON DELETE SET NULL;
ALTER TABLE learning_questions ADD COLUMN context_scope TEXT;
ALTER TABLE learning_questions ADD COLUMN input_tokens INTEGER;
ALTER TABLE learning_questions ADD COLUMN cache_hit_tokens INTEGER;
ALTER TABLE learning_questions ADD COLUMN cache_miss_tokens INTEGER;

CREATE TABLE learning_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  record_id TEXT REFERENCES learning_records(id) ON DELETE CASCADE,
  record_revision INTEGER,
  source_question_id TEXT REFERENCES learning_questions(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX learning_drafts_owner ON learning_drafts(user_id, video_id);
