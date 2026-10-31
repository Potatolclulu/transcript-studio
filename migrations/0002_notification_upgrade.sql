-- Supports existing local installs made before completion notification was added.
CREATE TABLE IF NOT EXISTS notifications (job_id TEXT PRIMARY KEY REFERENCES jobs(id), attempts INTEGER NOT NULL DEFAULT 0, next_run INTEGER NOT NULL DEFAULT 0, sent_at INTEGER);
CREATE TRIGGER IF NOT EXISTS transcript_notification AFTER UPDATE OF status ON jobs WHEN OLD.status!='complete' AND NEW.status='complete' AND NEW.source!='sample' BEGIN
 INSERT OR IGNORE INTO notifications(job_id,next_run) VALUES(NEW.id,NEW.updated_at);
END;
