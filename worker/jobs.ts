import { SAMPLE } from '../shared/sample';
import { AppError, now, uid, row, rows, run, realEnabled, usesDoubao, localAsrEnabled, type Env, type JobRow } from './env';
import { commitBudget, mediaToken } from './security';
import { parseTranscript, parseDoubaoTranscript, ProviderError, Supadata, Doubao, type ProviderResult, type ProviderMode } from './provider';
import { DOUBAO_SAMPLE_URL } from '../shared/doubao-sample';

export async function createJob(e: Env, userId: string, quoteId: string): Promise<string> {
  const quote = await row<any>(e, 'SELECT * FROM quotes WHERE id=? AND user_id=? AND expires_at>?', quoteId, userId, now());
  if (!quote) throw new AppError(410, 'This estimate expired. Check your source again.');
  const existing = await row<{id:string}>(e, "SELECT id FROM jobs WHERE user_id=? AND input_key=? AND status NOT IN ('failed','cancelled','deleted')", userId, quote.input_key);
  if (existing) return existing.id;
  const id = uid(), time = now();
  try {
    const result = await run(e, `INSERT INTO jobs(id,user_id,quote_id,source,input_key,input_url,upload_id,title,duration,minutes,created_at,updated_at,expires_at)
      SELECT ?,user_id,id,source,input_key,input_url,upload_id,title,duration,minutes,?,?,? FROM quotes
      WHERE id=? AND user_id=? AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=? AND blocked=0)
      AND (SELECT COUNT(*) FROM jobs WHERE user_id=? AND status IN ('queued','running','review'))<10`,
    id, time, time, time + 30 * 86400, quoteId, userId, time, userId, userId);
    if (!result.meta.changes) throw new AppError(409, 'The estimate expired, your account needs review, or your queue is full.');
  } catch (error) {
    const duplicate = await row<{id:string}>(e, "SELECT id FROM jobs WHERE user_id=? AND input_key=? AND status NOT IN ('failed','cancelled','deleted')", userId, quote.input_key);
    if (duplicate) return duplicate.id;
    if (error instanceof AppError) throw error;
    if (String(error).includes('CHECK constraint')) throw new AppError(402, 'You need more available minutes for this transcript.');
    throw error;
  }
  await enqueue(e, id);
  return id;
}
export async function enqueue(e: Env, jobId: string, delaySeconds = 0) {
  try { await e.TASKS.send({ jobId }, { delaySeconds }); } catch { /* Durable outbox + scheduled sweep recover delivery. */ }
}
export async function claim(e: Env, id: string): Promise<boolean> {
  const cap = Math.max(1, Math.min(10, Number(e.MAX_ACTIVE_JOBS) || 2));
  const result = await run(e, `UPDATE jobs SET active=1,status='running',updated_at=?
    WHERE id=? AND status='queued' AND active=0 AND cancel_requested=0
    AND (SELECT COUNT(*) FROM jobs WHERE active=1)<?
    AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=jobs.user_id AND other.active=1)`,
  now(), id, cap);
  return result.meta.changes > 0;
}
async function finish(e: Env, job: JobRow, status: string, error: string | null = null) {
  await run(e, `UPDATE jobs SET status=CASE WHEN ?='complete' AND cancel_requested=1 THEN 'cancelled' ELSE ? END,error=?,active=0,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?`,
    status, status, error, now(), job.id, job.lease_token);
  await run(e, 'DELETE FROM outbox WHERE job_id=?', job.id);
}
async function review(e: Env, job: JobRow, message: string) {
  await run(e, `UPDATE jobs SET status='review',error=?,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?`,
    message, now(), job.id, job.lease_token);
}
async function later(e: Env, job: JobRow, seconds = 20) {
  await run(e, 'UPDATE jobs SET next_run=?,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?', now() + seconds, now(), job.id, job.lease_token);
  await enqueue(e, job.id, seconds);
}
async function inputUrl(e: Env, job: JobRow) {
  if (!job.upload_id) return job.input_url;
  if (usesDoubao(e) && !e.PUBLIC_ORIGIN.startsWith('https://'))
    throw new AppError(503, 'The speech service cannot download localhost files. Configure a private temporary media URL before uploading.');
  const upload = await row<any>(e, "SELECT * FROM uploads WHERE id=? AND state='ready' AND expires_at>?", job.upload_id, now() + 60);
  if (!upload) throw new AppError(410, 'Your uploaded file expired. Please upload it again.');
  const expiry = Math.min(now() + 6 * 3600, upload.expires_at);
  return `${e.PUBLIC_ORIGIN}/api/media/${upload.id}/${encodeURIComponent(upload.name)}?expires=${expiry}&token=${await mediaToken(e, upload.id, expiry)}`;
}
async function saveResult(e: Env, job: JobRow, data: Record<string, unknown>, mode: ProviderMode) {
  // Persist raw provider response first. Retrying a failed save must never resubmit transcription.
  await e.MEDIA.put(`results/${job.id}/raw.json`, JSON.stringify({ data, mode }), { httpMetadata: { contentType: 'application/json' } });
  const transcript = mode === 'doubao' ? parseDoubaoTranscript(data, job.title, job.duration) : parseTranscript(data, job.title, mode, job.duration);
  await e.MEDIA.put(`results/${job.id}/transcript.json`, JSON.stringify(transcript), { httpMetadata: { contentType: 'application/json' } });
  const current = await row<JobRow>(e, 'SELECT * FROM jobs WHERE id=?', job.id);
  if (current?.cancel_requested || current?.status === 'deleted') {
    await e.MEDIA.delete([`results/${job.id}/raw.json`, `results/${job.id}/transcript.json`]);
    await finish(e, job, 'cancelled');
  } else {
    await finish(e, job, 'complete');
  }
}
async function handleResult(e: Env, job: JobRow, mode: ProviderMode, result: ProviderResult) {
  if (result.kind === 'pending') {
    await e.DB.batch([
      e.DB.prepare("UPDATE attempts SET state='waiting',provider_id=?,billable_credits=?,updated_at=? WHERE job_id=? AND mode=?").bind(result.id, result.credits, now(), job.id, mode),
      e.DB.prepare("UPDATE jobs SET provider_id=?,phase='waiting',updated_at=? WHERE id=? AND lease_token=?").bind(result.id, now(), job.id, job.lease_token),
    ]);
    await later(e, job);
  } else if (result.kind === 'waiting') await later(e, job);
  else {
    // If this fails, the raw result can be recovered by its deterministic key.
    await saveResult(e, job, result.data, mode);
    await run(e, "UPDATE attempts SET state='complete',billable_credits=COALESCE(?,billable_credits),updated_at=? WHERE job_id=? AND mode=?", result.credits, now(), job.id, mode);
  }
}
async function processDoubao(e: Env, job: JobRow) {
  const provider = new Doubao(e.DOUBAO_API_KEY || '', e.DOUBAO_RESOURCE_ID || 'volc.seedasr.auc');
  let attempt = await row<{ id: string; state: string }>(e, "SELECT id,state FROM attempts WHERE job_id=? AND mode='doubao'", job.id);
  if (attempt && attempt.state !== 'retryable') {
    // The UUID is durable before submit. A timeout or crash can only cause a query, never another paid submit.
    try { await handleResult(e, job, 'doubao', await provider.poll(attempt.id)); }
    catch (error) {
      if (error instanceof ProviderError && error.code === 20000003) await finish(e, job, 'failed', error.message);
      else if (error instanceof ProviderError && error.code === 45000092 && now() - job.created_at > 180)
        await finish(e, job, 'failed', 'The speech service confirmed that the task was not found. Your minutes were returned. No duplicate request was sent.');
      else if (error instanceof ProviderError && error.kind === 'invalid') throw error;
      else if (now() - job.created_at > 6 * 3600) await review(e, job, 'The speech service status is still uncertain. No second transcription was submitted.');
      else await later(e, job, 20);
    }
    return;
  }
  if (job.cancel_requested) { await finish(e, job, 'cancelled'); return; }
  const fixture = job.source === 'doubao-test';
  if (fixture ? !localAsrEnabled(e) || job.input_url !== DOUBAO_SAMPLE_URL : !realEnabled(e)) {
    await finish(e, job, 'failed', 'New transcriptions are temporarily paused. Your minutes were returned.'); return;
  }
  if (now() - job.created_at > 6 * 3600) { await finish(e, job, 'failed', 'The queue waiting limit was reached. Your minutes were returned.'); return; }
  const url = await inputUrl(e, job);
  if (!job.budget_reserved) {
    // An operator-configured conservative commitment, not an assertion about the supplier's actual tariff.
    const unit = Number(e.DOUBAO_BUDGET_CENTS_PER_MINUTE);
    const cost = job.minutes * (Number.isFinite(unit) && unit > 0 ? Math.ceil(unit) : 2);
    if (!await commitBudget(e, `job:${job.id}`, cost, 'doubao')) { await finish(e, job, 'failed', 'The daily processing limit was reached. Your minutes were returned.'); return; }
    await run(e, 'UPDATE jobs SET budget_reserved=1 WHERE id=?', job.id);
  }
  if (!attempt) {
    const id = uid();
    await e.DB.batch([
      e.DB.prepare("INSERT INTO attempts(id,job_id,mode,state,provider_id,created_at,updated_at) VALUES(?,?,'doubao','submitting',?,?,?)").bind(id, job.id, id, now(), now()),
      e.DB.prepare("UPDATE jobs SET provider_id=?,phase='submitting' WHERE id=? AND lease_token=?").bind(id, job.id, job.lease_token),
    ]);
    attempt = { id, state: 'submitting' };
  } else {
    await run(e, "UPDATE attempts SET state='submitting',updated_at=? WHERE id=?", now(), attempt.id);
  }
  try { await handleResult(e, job, 'doubao', await provider.submit(url, attempt.id)); }
  catch (error) {
    if (error instanceof ProviderError && error.kind === 'retryable') {
      // A documented rejection for concurrency confirms this submission was not accepted.
      await run(e, "UPDATE attempts SET state='retryable',updated_at=? WHERE id=?", now(), attempt.id);
      await later(e, job, 30);
    } else if (error instanceof ProviderError && ['rejected', 'invalid'].includes(error.kind)) {
      await run(e, "UPDATE attempts SET state='failed',updated_at=? WHERE id=?", now(), attempt.id);
      await finish(e, job, 'failed', error.message);
    } else {
      await later(e, job, 10);
    }
  }
}
export async function processJob(e: Env, id: string) {
  let job = await row<JobRow>(e, 'SELECT * FROM jobs WHERE id=?', id);
  if (!job || !['queued', 'running'].includes(job.status) || job.next_run > now()) return;
  if (job.status === 'queued' && !await claim(e, id)) return;
  const lease = uid();
  const locked = await run(e, "UPDATE jobs SET lease_until=?,lease_token=? WHERE id=? AND status='running' AND lease_until<?", now() + 180, lease, id, now());
  if (!locked.meta.changes) return;
  job = (await row<JobRow>(e, 'SELECT * FROM jobs WHERE id=?', id))!;
  try {
    const raw = await e.MEDIA.get(`results/${id}/raw.json`);
    if (raw) {
      const saved = await raw.json<{data: Record<string,unknown>;mode:ProviderMode}>();
      await saveResult(e, job, saved.data, saved.mode);
      return;
    }
    if (job.source === 'sample') {
      await e.MEDIA.put(`results/${id}/transcript.json`, JSON.stringify(SAMPLE), { httpMetadata: { contentType: 'application/json' } });
      await finish(e, job, job.cancel_requested ? 'cancelled' : 'complete');
      return;
    }
    const doubaoAttempt = await row(e, "SELECT id FROM attempts WHERE job_id=? AND mode='doubao'", id);
    if (job.source === 'doubao-test' || doubaoAttempt || usesDoubao(e) && !job.provider_id) {
      await processDoubao(e, job);
      return;
    }
    const provider = new Supadata(e.SUPADATA_API_KEY || '');
    const attempt = await row<any>(e, 'SELECT * FROM attempts WHERE job_id=? ORDER BY created_at DESC,mode ASC LIMIT 1', id);
    if (attempt?.state === 'submitting') {
      await review(e, job, 'The provider may still be processing this request. We are checking before making another request.');
      return;
    }
    if (job.provider_id) {
      try { await handleResult(e, job, attempt.mode, await provider.poll(job.provider_id)); }
      catch (error) {
        if (error instanceof ProviderError && error.code === 422) await finish(e, job, 'failed', error.message);
        else if (now() - job.created_at > 6 * 3600 || error instanceof ProviderError && error.code === 404) await review(e, job, 'We could not retrieve the provider result. Your request needs a status check.');
        else await later(e, job, 30);
      }
      return;
    }
    if (job.cancel_requested) { await finish(e, job, 'cancelled'); return; }
    if (!realEnabled(e)) { await finish(e, job, 'failed', 'New transcriptions are temporarily paused. Your minutes were returned.'); return; }
    if (now() - job.created_at > 6 * 3600) { await finish(e, job, 'failed', 'The queue waiting limit was reached. Your minutes were returned.'); return; }
    const mode: 'native' | 'generate' = job.source === 'youtube' && job.phase === 'ready' ? 'native' : 'generate';
    const url = await inputUrl(e, job);
    if (!job.budget_reserved) {
      const cost = Math.ceil((job.minutes * 2 + (job.source === 'youtube' ? 1 : 0)) * Math.max(1, Number(e.SUPADATA_CREDIT_CENTS) || 1) * 1.2);
      if (!await commitBudget(e, `job:${id}`, cost, 'transcription')) { await finish(e, job, 'failed', 'The daily processing limit was reached. Your minutes were returned.'); return; }
      await run(e, 'UPDATE jobs SET budget_reserved=1 WHERE id=?', id);
    }
    const inserted = await run(e, "INSERT OR IGNORE INTO attempts(id,job_id,mode,state,created_at,updated_at) VALUES(?,?,?,'submitting',?,?)", uid(), id, mode, now(), now());
    if (!inserted.meta.changes) { await review(e, job, 'This request requires a provider status check before it can continue.'); return; }
    try {
      await handleResult(e, job, mode, await provider.submit(url, mode));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'unavailable' && mode === 'native') {
        await e.DB.batch([
          e.DB.prepare("UPDATE attempts SET state='unavailable',billable_credits=1,updated_at=? WHERE job_id=? AND mode='native'").bind(now(), id),
          e.DB.prepare("UPDATE jobs SET phase='generate' WHERE id=? AND lease_token=?").bind(id, lease),
        ]);
        await later(e, job, 1);
      } else if (error instanceof ProviderError && ['rejected', 'invalid'].includes(error.kind)) {
        await run(e, "UPDATE attempts SET state='failed',updated_at=? WHERE job_id=? AND mode=?", now(), id, mode);
        await finish(e, job, 'failed', error.message);
      } else {
        // A successful response whose R2 save failed is also uncertain; never issue another paid request.
        const saved = await e.MEDIA.head(`results/${id}/raw.json`).catch(() => null);
        if (saved) await later(e, job, 10);
        else await review(e, job, 'We could not confirm delivery. We are checking the provider status; no second request has been sent.');
      }
    }
  } catch (error) {
    if (error instanceof AppError || error instanceof ProviderError && error.kind === 'invalid') await finish(e, job, 'failed', error.message);
    else await later(e, job, 30);
  }
}
export async function sweep(e: Env) {
  const time = now();
  if (e.RESEND_API_KEY && e.EMAIL_FROM) {
    const notifications = await rows<{job_id:string; email:string; attempts:number}>(e, `SELECT n.job_id,n.attempts,u.email FROM notifications n
      JOIN jobs j ON j.id=n.job_id JOIN users u ON u.id=j.user_id
      WHERE n.sent_at IS NULL AND n.next_run<=? AND n.attempts<6 AND j.status='complete' AND j.expires_at>? LIMIT 10`, time, time);
    for (const n of notifications) {
      const acquired = await run(e, 'UPDATE notifications SET next_run=?,attempts=attempts+1 WHERE job_id=? AND sent_at IS NULL AND next_run<=?', time + 300, n.job_id, time);
      if (!acquired.meta.changes) continue;
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `completed-${n.job_id}` },
          body: JSON.stringify({ from: e.EMAIL_FROM, to: [n.email], subject: 'Your transcript is ready', text: `Your transcript is ready in your private workspace:\n\n${e.PUBLIC_ORIGIN}/app/${n.job_id}\n\nTranscripts are kept for 30 days. Download an export to keep this one longer.` }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) await run(e, 'UPDATE notifications SET sent_at=? WHERE job_id=?', now(), n.job_id);
      } catch { /* Scheduled retry, independent of result delivery and billing. */ }
    }
  }
  await run(e, `UPDATE jobs SET status='review_refunded',updated_at=? WHERE status='review' AND created_at<?`, time, time - 86400);
  // Unconfirmed submissions keep their global slot even after the customer is refunded.
  const due = await rows<{id:string}>(e, `SELECT j.id FROM jobs j JOIN outbox o ON o.job_id=j.id
    WHERE j.status IN ('queued','running') AND j.next_run<=? AND j.lease_until<? ORDER BY j.created_at LIMIT 40`, time, time);
  for (const job of due) await enqueue(e, job.id);
  const expired = await rows<{id:string}>(e, "SELECT id FROM jobs WHERE expires_at<? AND active=0 AND status!='deleted' LIMIT 40", time);
  for (const job of expired) await run(e, "UPDATE jobs SET status='deleted',updated_at=? WHERE id=? AND active=0", time, job.id);
  const deleted = await rows<{id:string}>(e, "SELECT id FROM jobs WHERE status='deleted' AND phase!='purged' LIMIT 40");
  for (const job of deleted) {
    await e.MEDIA.delete([`results/${job.id}/raw.json`, `results/${job.id}/transcript.json`]);
    await run(e, "UPDATE jobs SET phase='purged',title='Deleted transcript',input_url='',input_key='deleted:'||id WHERE id=?", job.id);
  }
  const uploads = await rows<any>(e, "SELECT * FROM uploads WHERE expires_at<? AND state!='deleted' LIMIT 40", time);
  for (const u of uploads) {
    await e.MEDIA.delete([`uploads/${u.id}/incoming`, `uploads/${u.id}/original`]);
    await run(e, "UPDATE uploads SET state='deleted',name='Deleted file' WHERE id=?", u.id);
  }
  await e.DB.batch([
    e.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(time),
    e.DB.prepare('DELETE FROM login_tokens WHERE expires_at<?').bind(time),
    e.DB.prepare("DELETE FROM quotes WHERE expires_at<? AND id NOT IN (SELECT quote_id FROM jobs)").bind(time - 86400),
    e.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(time),
  ]);
}
