CREATE TABLE reading_tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
 track_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('chapters','translation')),
 status TEXT NOT NULL DEFAULT 'queued', source TEXT, completed INTEGER NOT NULL DEFAULT 0,
 total INTEGER NOT NULL DEFAULT 0, preferred_cue INTEGER NOT NULL DEFAULT 0,
 platform_tried INTEGER NOT NULL DEFAULT 0, ai_requested INTEGER NOT NULL DEFAULT 0,
 data_json TEXT NOT NULL DEFAULT '{}', error TEXT, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(video_id,track_id,kind)
);
CREATE INDEX reading_pending ON reading_tasks(status,lease_until);
CREATE UNIQUE INDEX reading_one_running ON reading_tasks(user_id) WHERE status='running';
