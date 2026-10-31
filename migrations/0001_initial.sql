PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, demo INTEGER NOT NULL DEFAULT 0,
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0),
 blocked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE login_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE budgets (day TEXT PRIMARY KEY, committed_cents INTEGER NOT NULL DEFAULT 0);
CREATE TABLE budget_entries (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, cents INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER budget_entry AFTER INSERT ON budget_entries BEGIN
 INSERT INTO budgets(day,committed_cents) VALUES(NEW.day,NEW.cents)
 ON CONFLICT(day) DO UPDATE SET committed_cents=committed_cents+NEW.cents;
END;
CREATE TABLE uploads (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL, object_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 duration REAL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE quotes (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL, input_key TEXT NOT NULL,
 input_url TEXT NOT NULL, upload_id TEXT REFERENCES uploads(id), title TEXT NOT NULL, duration REAL NOT NULL,
 minutes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX quotes_lookup ON quotes(user_id,input_key,expires_at);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
 source TEXT NOT NULL, input_key TEXT NOT NULL, input_url TEXT NOT NULL, upload_id TEXT REFERENCES uploads(id),
 title TEXT NOT NULL, duration REAL NOT NULL, minutes INTEGER NOT NULL CHECK(minutes>0),
 status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'ready',
 active INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
 provider_id TEXT, next_run INTEGER NOT NULL DEFAULT 0, budget_reserved INTEGER NOT NULL DEFAULT 0,
 cancel_requested INTEGER NOT NULL DEFAULT 0, settlement TEXT NOT NULL DEFAULT 'reserved',
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs(user_id,input_key) WHERE status NOT IN ('failed','cancelled','deleted');
CREATE INDEX jobs_schedule ON jobs(status,next_run);
CREATE INDEX jobs_user ON jobs(user_id,created_at);
CREATE TABLE ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), job_id TEXT, order_id TEXT,
 kind TEXT NOT NULL, available_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL DEFAULT 0,
 note TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger BEGIN
 UPDATE users SET balance=balance+NEW.available_delta,reserved=reserved+NEW.reserved_delta WHERE id=NEW.user_id;
END;
CREATE TABLE outbox (job_id TEXT PRIMARY KEY REFERENCES jobs(id), due_at INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER job_reserve AFTER INSERT ON jobs BEGIN
 INSERT INTO ledger VALUES('reserve:'||NEW.id,NEW.user_id,NEW.id,NULL,'reserve',-NEW.minutes,NEW.minutes,'Minutes held until delivery',NEW.created_at);
 INSERT INTO outbox(job_id,due_at) VALUES(NEW.id,NEW.created_at);
END;
CREATE TRIGGER job_settle AFTER UPDATE OF status ON jobs
 WHEN OLD.settlement='reserved' AND NEW.status IN ('complete','failed','cancelled','deleted','review_refunded')
 BEGIN
 INSERT INTO ledger VALUES('settle:'||NEW.id,NEW.user_id,NEW.id,NULL,
 CASE WHEN NEW.status='complete' THEN 'consume' ELSE 'release' END,
 CASE WHEN NEW.status='complete' THEN 0 ELSE NEW.minutes END,-NEW.minutes,
 CASE WHEN NEW.status='complete' THEN 'Transcript delivered' ELSE 'Reserved minutes returned' END,NEW.updated_at);
 UPDATE jobs SET settlement=CASE WHEN NEW.status='complete' THEN 'consumed' ELSE 'released' END WHERE id=NEW.id;
END;
CREATE TABLE attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), mode TEXT NOT NULL,
 state TEXT NOT NULL, provider_id TEXT, billable_credits REAL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(job_id,mode)
);
CREATE TABLE orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), package TEXT NOT NULL,
 product_id TEXT NOT NULL, cents INTEGER NOT NULL, minutes INTEGER NOT NULL,
 mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', checkout_id TEXT UNIQUE,
 provider_order_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE payment_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, order_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE notifications (job_id TEXT PRIMARY KEY REFERENCES jobs(id), attempts INTEGER NOT NULL DEFAULT 0, next_run INTEGER NOT NULL DEFAULT 0, sent_at INTEGER);
CREATE TRIGGER transcript_notification AFTER UPDATE OF status ON jobs WHEN OLD.status!='complete' AND NEW.status='complete' AND NEW.source!='sample' BEGIN
 INSERT OR IGNORE INTO notifications(job_id,next_run) VALUES(NEW.id,NEW.updated_at);
END;
CREATE TRIGGER order_paid AFTER UPDATE OF status ON orders WHEN OLD.status='pending' AND NEW.status='paid' BEGIN
 INSERT INTO ledger VALUES('purchase:'||NEW.id,NEW.user_id,NULL,NEW.id,'purchase',NEW.minutes,0,'Minute pack purchased',NEW.updated_at);
END;
CREATE TRIGGER order_reversal AFTER UPDATE OF status ON orders
 WHEN OLD.status='paid' AND NEW.status IN ('refunded','disputed') BEGIN
 INSERT INTO ledger SELECT 'reversal:'||NEW.id,NEW.user_id,NULL,NEW.id,'reversal',-MIN(balance,NEW.minutes),0,'Unused minutes revoked after payment reversal',NEW.updated_at FROM users WHERE id=NEW.user_id;
 UPDATE users SET blocked=1 WHERE id=NEW.user_id;
END;
