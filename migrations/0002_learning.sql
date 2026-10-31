CREATE TABLE library (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 youtube_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
 author TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
 caption_status TEXT NOT NULL DEFAULT 'queued',
 selected_track TEXT, tracks_json TEXT NOT NULL DEFAULT '[]',
 tags_json TEXT NOT NULL DEFAULT '[]', learning_status TEXT NOT NULL DEFAULT 'new',
 playback_position REAL NOT NULL DEFAULT 0, reading_cue INTEGER NOT NULL DEFAULT 0,
 error TEXT, import_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(user_id,youtube_id)
);
CREATE INDEX library_user ON library(user_id,updated_at);
CREATE TABLE caption_tracks (
 video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
 track_id TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL,
 translated INTEGER NOT NULL DEFAULT 0, completeness TEXT NOT NULL,
 object_key TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(video_id,track_id)
);
CREATE TABLE learning_records (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('highlight','note')),
 body TEXT NOT NULL DEFAULT '', anchor_json TEXT,
 revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX records_video ON learning_records(video_id,created_at);
CREATE TABLE learning_questions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL, question TEXT NOT NULL, anchor_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', answer TEXT,
 supplement TEXT, context_json TEXT NOT NULL DEFAULT '[]', citations_json TEXT NOT NULL DEFAULT '[]',
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX questions_one_active ON learning_questions(user_id) WHERE status IN ('queued','running');
CREATE INDEX questions_video ON learning_questions(video_id,created_at);
CREATE TABLE learning_search (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, video_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, body TEXT NOT NULL, start REAL, cue INTEGER, record_id TEXT
);
CREATE INDEX learning_search_owner ON learning_search(user_id,video_id);
CREATE TABLE learning_outbox (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, due_at INTEGER NOT NULL
);
CREATE TABLE learning_ai_spend (
 request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, cents INTEGER NOT NULL
);
CREATE INDEX learning_ai_day ON learning_ai_spend(day,user_id);
